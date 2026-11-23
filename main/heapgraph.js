// Nova IDE - .NET heap graph analysis (from a GC heap dump):
//   inclusive (retained) size per type through the dominator tree, paths to root, referenced types
'use strict';

const ROOT_KIND = ['Stack', 'Finalizer queue', 'Handle', 'Older generation', 'Sized ref handle', 'Overflow', 'Dependent handle', 'Finalization queue', 'Steal', 'Background GC'];
const FLAG = { PINNED: 1, WEAK: 2, INTERIOR: 4, REFCOUNTED: 8 };

// graph: { addr[], size[], type[] (type ids), edgeCount[], edges[] (target addresses), roots[{addr,kind,flags}], statics[{addr,type,name}], typeNames }
function build(graph) {
  const n = graph.addr.length;
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(graph.addr[i], i);
  // types
  const typeIdx = new Map();
  const typeNames = [];
  const type = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const id = graph.type[i];
    let t = typeIdx.get(id);
    if (t == null) { t = typeNames.length; typeIdx.set(id, t); typeNames.push((graph.typeNames && graph.typeNames.get(id)) || `[type ${id}]`); }
    type[i] = t;
  }
  const size = Float64Array.from(graph.size);
  // references (CSR), only to objects in the dump
  const start = new Int32Array(n + 1);
  const to = [];
  let e = 0;
  for (let i = 0; i < n; i++) {
    start[i] = to.length;
    const c = graph.edgeCount[i];
    for (let k = 0; k < c && e < graph.edges.length; k++, e++) {
      const j = index.get(graph.edges[e]);
      if (j != null && j !== i) to.push(j);
    }
  }
  start[n] = to.length;
  const edges = Int32Array.from(to);
  // roots: named static fields first (so paths prefer them), then strong handles, stack, finalizer...
  const rootList = [];
  // (the event names the field and the type of the object it holds, not the class that declares it)
  for (const s of graph.statics || []) {
    const j = index.get(s.addr);
    if (j == null) continue;
    rootList.push({ node: j, label: `Static variable ${s.name}` });
  }
  for (const r of graph.roots || []) {
    if (r.flags & FLAG.WEAK) continue; // weak handles don't keep objects alive
    const j = index.get(r.addr);
    if (j == null) continue;
    let label = ROOT_KIND[r.kind] || `Root ${r.kind}`;
    if (r.kind === 2) label = r.flags & FLAG.PINNED ? 'Pinned handle' : r.flags & FLAG.REFCOUNTED ? 'Ref-counted handle (COM)' : 'Strong handle';
    rootList.push({ node: j, label });
  }
  return { n, size, type, typeNames, start, edges, roots: rootList };
}

// BFS from the roots: shortest path parent of every object (parent -1 = a root itself; -2 = not reached)
function shortestPaths(g) {
  const parent = new Int32Array(g.n).fill(-2);
  const rootOf = new Int32Array(g.n).fill(-1);
  const queue = new Int32Array(g.n);
  let qh = 0, qt = 0;
  g.roots.forEach((r, ri) => { if (parent[r.node] === -2) { parent[r.node] = -1; rootOf[r.node] = ri; queue[qt++] = r.node; } });
  while (qh < qt) {
    const v = queue[qh++];
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.edges[k];
      if (parent[w] === -2) { parent[w] = v; queue[qt++] = w; }
    }
  }
  return { parent, rootOf, reached: qt };
}

// Dominators (Cooper, Harvey, Kennedy: "A Simple, Fast Dominance Algorithm") with a virtual root R = n
// whose successors are the roots and any object not reachable from them.
function dominators(g) {
  const n = g.n, R = n;
  const succ = (v, fn) => {
    if (v === R) { for (const x of g.rootNodes) fn(x); return; }
    for (let k = g.start[v]; k < g.start[v + 1]; k++) fn(g.edges[k]);
  };
  // roots + unreachable objects hang off R
  const seen = new Uint8Array(n);
  const rootNodes = [];
  for (const r of g.roots) if (!seen[r.node]) { seen[r.node] = 1; rootNodes.push(r.node); }
  g.rootNodes = rootNodes;
  // postorder by iterative DFS
  const order = new Int32Array(n + 1);
  const po = new Int32Array(n + 1).fill(-1);
  const visited = new Uint8Array(n + 1);
  let cnt = 0;
  const dfs = (s) => {
    const stack = [s], it = [0];
    visited[s] = 1;
    while (stack.length) {
      const v = stack[stack.length - 1];
      const list = [];
      if (v === R) list.push(...g.rootNodes);
      let i = it[it.length - 1];
      let pushed = false;
      if (v === R) {
        while (i < list.length) { const w = list[i++]; if (!visited[w]) { it[it.length - 1] = i; visited[w] = 1; stack.push(w); it.push(0); pushed = true; break; } }
      } else {
        const a = g.start[v], b = g.start[v + 1];
        while (a + i < b) { const w = g.edges[a + i]; i++; if (!visited[w]) { it[it.length - 1] = i; visited[w] = 1; stack.push(w); it.push(0); pushed = true; break; } }
      }
      if (!pushed) { stack.pop(); it.pop(); po[v] = cnt; order[cnt++] = v; }
    }
  };
  dfs(R);
  // objects nothing we know of points to (roots of a kind we don't see): attach to R as well
  const extra = [];
  let anyUnvisited = false;
  for (let v = 0; v < n; v++) if (!visited[v]) { anyUnvisited = true; break; }
  if (anyUnvisited) {
    // number the missing part after the existing ones but keep R last; each unreached object that is
    // still unvisited when we get to it becomes a root (what it references is traced from it)
    cnt--; po[R] = -1; visited[R] = 0;
    for (let v = 0; v < n; v++) if (!visited[v]) {
      extra.push(v);
      const stack = [v], it = [0];
      visited[v] = 1;
      while (stack.length) {
        const x = stack[stack.length - 1];
        let i = it[it.length - 1], pushed = false;
        const a = g.start[x], b = g.start[x + 1];
        while (a + i < b) { const w = g.edges[a + i]; i++; if (!visited[w]) { it[it.length - 1] = i; visited[w] = 1; stack.push(w); it.push(0); pushed = true; break; } }
        if (!pushed) { stack.pop(); it.pop(); po[x] = cnt; order[cnt++] = x; }
      }
    }
    g.rootNodes.push(...extra);
    g.unknownRoots = extra.length;
    visited[R] = 1; po[R] = cnt; order[cnt++] = R;
  }
  // predecessors (CSR)
  const pc = new Int32Array(n + 2);
  for (let v = 0; v < n; v++) for (let k = g.start[v]; k < g.start[v + 1]; k++) pc[g.edges[k] + 1]++;
  for (const x of g.rootNodes) pc[x + 1]++;
  for (let i = 1; i < n + 2; i++) pc[i] += pc[i - 1];
  const preds = new Int32Array(pc[n + 1]);
  const fill = pc.slice();
  for (let v = 0; v < n; v++) for (let k = g.start[v]; k < g.start[v + 1]; k++) preds[fill[g.edges[k]]++] = v;
  for (const x of g.rootNodes) preds[fill[x]++] = R;
  // iterate in reverse postorder
  const idom = new Int32Array(n + 1).fill(-1);
  idom[R] = R;
  const intersect = (a, b) => { while (a !== b) { while (po[a] < po[b]) a = idom[a]; while (po[b] < po[a]) b = idom[b]; } return a; };
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = cnt - 2; i >= 0; i--) {
      const v = order[i];
      let nd = -1;
      for (let k = pc[v]; k < pc[v + 1]; k++) {
        const p = preds[k];
        if (idom[p] === -1) continue;
        nd = nd === -1 ? p : intersect(p, nd);
      }
      if (nd !== -1 && idom[v] !== nd) { idom[v] = nd; changed = true; }
    }
  }
  // retained size: children before parents (postorder)
  const retained = Float64Array.from({ length: n + 1 }, (_, i) => (i < n ? g.size[i] : 0));
  for (let i = 0; i < cnt - 1; i++) { const v = order[i]; const d = idom[v]; if (d >= 0 && d !== v) retained[d] += retained[v]; }
  return { idom, retained, order, count: cnt };
}

// Per type: count, size, inclusive size (retained by its instances, not counting instances held by other
// instances of the same type twice)
function typeTable(g, dom) {
  const T = g.typeNames.length, n = g.n, R = n;
  const count = new Float64Array(T), size = new Float64Array(T), incl = new Float64Array(T);
  for (let v = 0; v < n; v++) { count[g.type[v]]++; size[g.type[v]] += g.size[v]; }
  // dominator tree children
  const cc = new Int32Array(n + 2);
  for (let v = 0; v < n; v++) { const d = dom.idom[v]; if (d >= 0 && d !== v) cc[d + 1]++; }
  for (let i = 1; i < n + 2; i++) cc[i] += cc[i - 1];
  const kids = new Int32Array(cc[n + 1]);
  const fill = cc.slice();
  for (let v = 0; v < n; v++) { const d = dom.idom[v]; if (d >= 0 && d !== v) kids[fill[d]++] = v; }
  const depth = new Int32Array(T);
  const stack = [R], it = [cc[R]];
  while (stack.length) {
    const v = stack[stack.length - 1];
    const k = it[it.length - 1];
    if (k < cc[v + 1]) {
      it[it.length - 1] = k + 1;
      const w = kids[k];
      const t = g.type[w];
      if (depth[t] === 0) incl[t] += dom.retained[w];
      depth[t]++;
      stack.push(w); it.push(cc[w]);
    } else {
      stack.pop(); it.pop();
      if (v !== R) depth[g.type[v]]--;
    }
  }
  const out = [];
  for (let t = 0; t < T; t++) if (count[t]) out.push({ name: g.typeNames[t], count: count[t], bytes: size[t], inclusive: incl[t] });
  return out;
}

// Paths to root of the instances of a type, merged by type: a tree from the type outwards to the roots
function pathsToRoot(g, sp, typeName, { maxDepth = 40, maxKids = 25 } = {}) {
  const t = g.typeNames.indexOf(typeName);
  if (t < 0) return null;
  const top = { name: typeName, count: 0, kids: new Map() };
  for (let v = 0; v < g.n; v++) {
    if (g.type[v] !== t) continue;
    top.count++;
    if (sp.parent[v] === -2) { add(top, '[not reachable from a known root]', true); continue; }
    let node = top, x = v, d = 0;
    // walk up the shortest-path tree; stop at the root
    while (sp.parent[x] >= 0 && d < maxDepth) {
      x = sp.parent[x];
      node = add(node, g.typeNames[g.type[x]], false);
      d++;
    }
    if (sp.parent[x] === -1) add(node, `[${g.roots[sp.rootOf[x]].label}]`, true);
  }
  function add(node, name, root) {
    let k = node.kids.get(name);
    if (!k) { k = { name, count: 0, root, kids: new Map() }; node.kids.set(name, k); }
    k.count++;
    return k;
  }
  const plain = (node) => ({ name: node.name, count: node.count, root: !!node.root, children: [...node.kids.values()].sort((a, b) => b.count - a.count).slice(0, maxKids).map(plain) });
  return plain(top);
}

// Types the instances of a type reference: one level (the UI asks again to go deeper)
function referencedTypes(g, typeName) {
  const t = g.typeNames.indexOf(typeName);
  if (t < 0) return null;
  const agg = new Map();
  let from = 0;
  for (let v = 0; v < g.n; v++) {
    if (g.type[v] !== t) continue;
    from++;
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.edges[k];
      const name = g.typeNames[g.type[w]];
      const e = agg.get(name) || { name, refs: 0, bytes: 0 };
      e.refs++; e.bytes += g.size[w];
      agg.set(name, e);
    }
  }
  return { name: typeName, instances: from, children: [...agg.values()].sort((a, b) => b.refs - a.refs).slice(0, 50) };
}

// Everything for one snapshot; keeps what paths / references need
function analyze(graph) {
  const t0 = Date.now();
  const g = build(graph);
  const dom = dominators(g);
  const types = typeTable(g, dom);
  const sp = shortestPaths(g);
  return {
    types, roots: g.roots.length, unknownRoots: g.unknownRoots || 0, ms: Date.now() - t0,
    paths: (name) => pathsToRoot(g, sp, name),
    refs: (name) => referencedTypes(g, name),
    _g: g, _dom: dom
  };
}

module.exports = { analyze, build, dominators, typeTable, shortestPaths, pathsToRoot, referencedTypes, ROOT_KIND };
