// Phase 18: dominators / retained sizes, inclusive size per type, paths to root, referenced types
const test = require('node:test');
const assert = require('node:assert');
const hg = require('../main/heapgraph');

// a small heap: addresses 1..; type ids are strings, names in typeNames
function heap() {
  const objs = [
    // addr, size, type, refs
    [1, 100, 'L', [2]], //             List (static Cache.list) -> array
    [2, 40, 'A', [3, 4, 5]], //        array -> three items
    [3, 10, 'I', [6]], [4, 10, 'I', [6]], [5, 10, 'I', [7]], // items; 3 and 4 share string 6
    [6, 5, 'S', []], [7, 5, 'S', []],
    [8, 30, 'N', [9]], //              Node (stack) -> Node -> Node (same type chain)
    [9, 30, 'N', [10]], [10, 30, 'N', []],
    [11, 50, 'W', [12]], //            only a weak handle points here: not a root
    [12, 7, 'S', []],
    [13, 3, 'S', [3]] //               stack -> string 13 -> item 3 (so item 3 has two parents)
  ];
  return {
    addr: objs.map((o) => o[0]), size: objs.map((o) => o[1]), type: objs.map((o) => o[2]),
    edgeCount: objs.map((o) => o[3].length), edges: objs.flatMap((o) => o[3]),
    roots: [{ addr: 8, kind: 0, flags: 0 }, { addr: 11, kind: 2, flags: 2 }, { addr: 13, kind: 0, flags: 0 }],
    statics: [{ addr: 1, type: 'C', name: 'list' }],
    typeNames: new Map([['L', 'List'], ['A', 'Item[]'], ['I', 'Item'], ['S', 'String'], ['N', 'Node'], ['W', 'Weak'], ['C', 'App.Cache']])
  };
}

test('retained sizes through dominators', () => {
  const g = hg.build(heap());
  const d = hg.dominators(g);
  const idx = (addr) => heap().addr.indexOf(addr);
  // the list keeps the array, items 4 and 5, string 7; item 3 is also reachable from string 13; string 6 from items 3 and 4
  assert.strictEqual(d.retained[idx(1)], 100 + 40 + 10 + 10 + 5);
  assert.strictEqual(d.retained[idx(8)], 90);
  assert.strictEqual(d.retained[idx(3)], 10);
  // everything is retained by the virtual root
  assert.strictEqual(d.retained[g.n], heap().size.reduce((a, b) => a + b, 0));
  assert.strictEqual(g.unknownRoots, 1); // the weakly held object is attached to the virtual root
});

test('inclusive size per type does not count nested instances twice', () => {
  const g = hg.build(heap());
  const t = Object.fromEntries(hg.typeTable(g, hg.dominators(g)).map((x) => [x.name, x]));
  assert.deepStrictEqual([t.Node.count, t.Node.bytes, t.Node.inclusive], [3, 90, 90]);
  assert.strictEqual(t.List.inclusive, 165);
  assert.strictEqual(t.Item.count, 3);
  assert.strictEqual(t.String.count, 4);
});

test('paths to root: shortest, merged by type, static fields named, weak handles ignored', () => {
  const g = hg.build(heap());
  const sp = hg.shortestPaths(g);
  const p = hg.pathsToRoot(g, sp, 'Item');
  assert.strictEqual(p.count, 3);
  const flat = (n, d = 0) => [`${'.'.repeat(d)}${n.name}:${n.count}`, ...n.children.flatMap((c) => flat(c, d + 1))];
  // item 3 is closer to the stack (stack -> string 13 -> item 3) than to the static list
  assert.deepStrictEqual(flat(p), ['Item:3', '.Item[]:2', '..List:2', '...[Static variable list]:2', '.String:1', '..[Stack]:1']);
  const w = hg.pathsToRoot(g, sp, 'Weak');
  assert.deepStrictEqual(flat(w), ['Weak:1', '.[not reachable from a known root]:1']);
  const n = hg.pathsToRoot(g, sp, 'Node');
  assert.ok(flat(n).includes('.[Stack]:1') && flat(n).includes('.Node:2'), flat(n).join(' '));
  assert.strictEqual(hg.pathsToRoot(g, sp, 'Nope'), null);
});

test('referenced types', () => {
  const g = hg.build(heap());
  const r = hg.referencedTypes(g, 'Item');
  assert.strictEqual(r.instances, 3);
  assert.deepStrictEqual(r.children.map((c) => [c.name, c.refs, c.bytes]), [['String', 3, 15]]);
  assert.deepStrictEqual(hg.referencedTypes(g, 'Item[]').children.map((c) => [c.name, c.refs]), [['Item', 3]]);
});

test('analyze: a bigger random heap stays consistent', () => {
  const n = 20000, objs = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 1; i <= n; i++) { const refs = []; const k = Math.floor(rnd() * 3); for (let j = 0; j < k; j++) refs.push(1 + Math.floor(rnd() * n)); objs.push([i, 8 + Math.floor(rnd() * 100), `T${i % 7}`, refs]); }
  const graph = { addr: objs.map((o) => o[0]), size: objs.map((o) => o[1]), type: objs.map((o) => o[2]), edgeCount: objs.map((o) => o[3].length), edges: objs.flatMap((o) => o[3]),
    roots: [1, 2, 3, 500, 9000].map((a) => ({ addr: a, kind: 0, flags: 0 })), statics: [], typeNames: new Map() };
  const a = hg.analyze(graph);
  const total = graph.size.reduce((x, y) => x + y, 0);
  assert.strictEqual(a._dom.retained[n], total);
  for (const t of a.types) assert.ok(t.inclusive >= t.bytes - 1e-9 && t.inclusive <= total, t.name);
  assert.ok(a.ms < 5000);
});
