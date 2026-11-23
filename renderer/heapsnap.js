// Nova IDE - .NET heap snapshot view: live objects by type, compared with another snapshot
'use strict';

const HS = { s: null, index: 0, base: -1, sort: { key: 'inclusive', dir: -1 }, search: '', mine: false, open: false, selected: null, lowerTab: 'paths', paths: null, refs: null, expanded: new Set(), refKids: new Map() };
const hsFramework = (name) => /^(System|Microsoft|Internal|Interop)\./.test(name) || /^(Free|\[type )/.test(name);
const hsKB = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

function hsShow(session, index, sortKey) {
  HS.s = session; HS.index = index;
  // compare with the previous snapshot that has a heap
  HS.base = -1;
  for (let i = index - 1; i >= 0; i--) if (session.snapshots[i].heap) { HS.base = i; break; }
  if (sortKey) HS.sort = { key: sortKey, dir: -1 };
  if (typeof GH !== 'undefined' && GH.open && typeof hideHistory === 'function') hideHistory();
  if (typeof PR !== 'undefined' && PR.open && typeof hidePullRequests === 'function') hidePullRequests();
  if (typeof WI !== 'undefined' && WI.open && typeof hideWorkItems === 'function') hideWorkItems();
  if (typeof PF !== 'undefined' && PF.open) pfHideReport();
  HS.open = true;
  HS.selected = null; HS.paths = null; HS.refs = null;
  $('#hsView').classList.remove('hidden');
  hsRender();
  hsRenderLower();
  $('#hsView').focus();
}
function hsHide() { HS.open = false; $('#hsView').classList.add('hidden'); }

function hsRows() {
  const sn = HS.s.snapshots[HS.index];
  const base = HS.base >= 0 ? HS.s.snapshots[HS.base].heap : null;
  const prev = new Map(base ? base.types.map((t) => [t.name, t]) : []);
  const rows = sn.heap.types.map((t) => {
    const p = prev.get(t.name);
    return { name: t.name, count: t.count, bytes: t.bytes, inclusive: t.inclusive, dCount: base ? t.count - (p ? p.count : 0) : null, dBytes: base ? t.bytes - (p ? p.bytes : 0) : null, dIncl: base && t.inclusive != null ? t.inclusive - (p && p.inclusive != null ? p.inclusive : 0) : null, isNew: base && !p };
  });
  // types that are gone
  if (base) { const now = new Set(sn.heap.types.map((t) => t.name)); for (const p of base.types) if (!now.has(p.name)) rows.push({ name: p.name, count: 0, bytes: 0, inclusive: 0, dCount: -p.count, dBytes: -p.bytes, dIncl: p.inclusive != null ? -p.inclusive : null, gone: true }); }
  return rows;
}

function hsRender() {
  const s = HS.s;
  if (!s) return;
  const sn = s.snapshots[HS.index];
  const sel = $('#hsBase');
  sel.innerHTML = '';
  sel.appendChild(h('option', { value: '-1' }, '(none)'));
  s.snapshots.forEach((x, i) => { if (i !== HS.index && x.heap) sel.appendChild(h('option', { value: String(i) }, `Snapshot #${i + 1} (${dgFmtTime(x.t)})`)); });
  sel.value = String(HS.base);
  $('#hsMine').checked = HS.mine;
  $('#hsTitle').textContent = `Snapshot #${HS.index + 1} (${s.name})`;
  const base = HS.base >= 0 ? s.snapshots[HS.base].heap : null;
  const info = $('#hsInfo');
  info.innerHTML = '';
  const d = (a, b, fmt) => { const v = a - b; return h('span', { class: v > 0 ? 'dg-up' : v < 0 ? 'dg-down' : 'dlg-desc' }, ` (${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))})`); };
  info.append(h('span', {}, `${dgFmtTime(sn.t)} · ${sn.heap.objects.toLocaleString()} objects`), base ? d(sn.heap.objects, base.objects, (v) => v.toLocaleString()) : '',
    h('span', {}, ` · ${hsKB(sn.heap.bytes)} managed heap`), base ? d(sn.heap.bytes, base.bytes, hsKB) : '',
    h('span', { class: 'dlg-desc' }, `  Live objects after a full GC. Size: the objects themselves; Inclusive Size: plus what only they keep alive${base ? `; diff against snapshot #${HS.base + 1}` : ''}.`));
  let rows = hsRows().filter((r) => (!HS.search || r.name.toLowerCase().includes(HS.search.toLowerCase())) && (!HS.mine || !hsFramework(r.name)));
  const { key, dir } = HS.sort;
  rows.sort((a, b) => (key === 'name' ? -dir * a.name.localeCompare(b.name) : dir * ((a[key] || 0) - (b[key] || 0))));
  const t = h('table', { class: 'pf-table', id: 'hsTable' });
  const hasIncl = sn.heap.types.some((t) => t.inclusive != null);
  if (!hasIncl && /^(inclusive|dIncl)$/.test(HS.sort.key)) HS.sort = { key: 'bytes', dir: -1 };
  const cols = [['name', 'Object Type'], ['count', 'Count', 'num'], ...(base ? [['dCount', 'Count Diff', 'num']] : []), ['bytes', 'Size', 'num'], ...(base ? [['dBytes', 'Size Diff', 'num']] : []),
    ...(hasIncl ? [['inclusive', 'Inclusive Size', 'num'], ...(base ? [['dIncl', 'Inclusive Diff', 'num']] : [])] : [])];
  t.appendChild(h('tr', {}, ...cols.map(([k, label, cls]) => {
    const th = h('th', { class: `${cls || ''}${HS.sort.key === k ? ' sorted' : ''}` }, label, HS.sort.key === k ? (HS.sort.dir < 0 ? ' ▼' : ' ▲') : '');
    th.onclick = () => { HS.sort = { key: k, dir: HS.sort.key === k ? -HS.sort.dir : -1 }; hsRender(); };
    return th;
  })));
  const diff = (v, fmt) => h('td', { class: `num ${!v ? 'dlg-desc' : v > 0 ? 'dg-up' : 'dg-down'}` }, v == null ? '' : v === 0 ? '0' : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`);
  for (const r of rows.slice(0, 1000)) {
    const tr = h('tr', { 'data-type': r.name, class: r.gone ? 'hs-gone' : '' },
      h('td', { class: 'pf-name', title: r.name }, h('span', { class: hsFramework(r.name) ? 'pf-fw' : '' }, r.name), r.isNew ? h('span', { class: 'hs-new' }, ' new') : ''),
      h('td', { class: 'num' }, r.count.toLocaleString()), ...(base ? [diff(r.dCount, (v) => v.toLocaleString())] : []),
      h('td', { class: 'num' }, hsKB(r.bytes)), ...(base ? [diff(r.dBytes, hsKB)] : []),
      ...(hasIncl ? [h('td', { class: 'num' }, r.inclusive != null ? hsKB(r.inclusive) : ''), ...(base ? [diff(r.dIncl, hsKB)] : [])] : []));
    if (r.name === HS.selected) tr.classList.add('selected');
    tr.onclick = (e) => {
      $$('#hsTable tr.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      if (HS.selected !== r.name && !r.gone) hsSelect(r.name);
      if (e.detail === 2) hsGoTo(r.name);
    };
    t.appendChild(tr);
  }
  const body = $('#hsBody');
  body.innerHTML = '';
  body.appendChild(t);
  if (!rows.length) body.appendChild(h('div', { class: 'dg-empty' }, 'No types match.'));
}

// ---------------- lower pane: Paths to Root / Referenced Types of the selected type ----------------
async function hsSelect(name) {
  HS.selected = name; HS.paths = null; HS.refs = null; HS.expanded = new Set(); HS.refKids = new Map();
  hsRenderLower();
  const sn = HS.s.snapshots[HS.index];
  if (!sn.heap.key) return;
  const [paths, refs] = await Promise.all([api.prof.heapPaths({ key: sn.heap.key, type: name }), api.prof.heapRefs({ key: sn.heap.key, type: name })]);
  if (HS.selected !== name) return;
  HS.paths = paths; HS.refs = refs;
  // open the busiest path down to its root
  if (paths) { let n = paths, k = 'p'; HS.expanded.add(k); for (let d = 0; d < 12 && n.children.length; d++) { n = n.children[0]; k = `${k}/${n.name}`; HS.expanded.add(k); } }
  hsRenderLower();
}
function hsRenderLower() {
  $$('#hsLowerTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === HS.lowerTab));
  const body = $('#hsLowerBody');
  body.innerHTML = '';
  const sn = HS.s && HS.s.snapshots[HS.index];
  $('#hsLowerTitle').textContent = HS.selected ? `  ${HS.selected}` : '';
  if (!HS.selected) { body.appendChild(h('div', { class: 'dg-empty' }, 'Select a type to see what keeps its objects alive (Paths to Root) and what they reference.')); return; }
  if (!sn || !sn.heap.key) { body.appendChild(h('div', { class: 'dg-empty' }, sn && sn.heap.analysisError ? `Not available: ${sn.heap.analysisError}` : 'Not available for this snapshot.')); return; }
  if (HS.lowerTab === 'paths') {
    if (!HS.paths) { body.appendChild(h('div', { class: 'dg-empty' }, 'Loading...')); return; }
    const t = h('table', { class: 'pf-table', id: 'hsPaths' }, h('tr', {}, h('th', {}, 'Object Type'), h('th', { class: 'num' }, 'Reference Count')));
    const add = (node, key, depth) => {
      const open = HS.expanded.has(key);
      const chev = h('span', { class: 'chev' }, node.children.length ? (open ? '▾' : '▸') : '');
      const cell = h('td', { class: 'pf-name', style: `padding-left:${4 + depth * 16}px` }, chev, h('span', { class: node.root ? 'hs-root' : depth === 0 ? 'pf-hotrow' : '' }, node.name));
      const tr = h('tr', { 'data-path': key }, cell, h('td', { class: 'num' }, node.count.toLocaleString()));
      chev.onclick = (e) => { e.stopPropagation(); if (open) HS.expanded.delete(key); else HS.expanded.add(key); hsRenderLower(); };
      tr.onclick = (e) => { if (e.detail === 2 && !node.root) hsGoTo(node.name); };
      t.appendChild(tr);
      if (open) for (const c of node.children) add(c, `${key}/${c.name}`, depth + 1);
    };
    add(HS.paths, 'p', 0);
    body.append(h('div', { class: 'dlg-desc hs-hint' }, 'Each level is the type that references the one above it, on the shortest path from a GC root; [brackets] are the roots.'), t);
  } else {
    if (!HS.refs) { body.appendChild(h('div', { class: 'dg-empty' }, 'Loading...')); return; }
    const t = h('table', { class: 'pf-table', id: 'hsRefs' }, h('tr', {}, h('th', {}, 'Object Type'), h('th', { class: 'num' }, 'References'), h('th', { class: 'num' }, 'Size')));
    const add = (node, key, depth) => {
      for (const c of node.children) {
        const k = `${key}/${c.name}`;
        const open = HS.expanded.has(k);
        const kids = HS.refKids.get(k);
        const chev = h('span', { class: 'chev' }, kids && !kids.children.length ? '' : open ? '▾' : '▸');
        const tr = h('tr', { 'data-ref': k }, h('td', { class: 'pf-name', style: `padding-left:${4 + depth * 16}px` }, chev, c.name), h('td', { class: 'num' }, c.refs.toLocaleString()), h('td', { class: 'num' }, hsKB(c.bytes)));
        chev.onclick = async (e) => {
          e.stopPropagation();
          if (open) { HS.expanded.delete(k); hsRenderLower(); return; }
          HS.expanded.add(k);
          if (!HS.refKids.has(k)) HS.refKids.set(k, await api.prof.heapRefs({ key: sn.heap.key, type: c.name }) || { children: [] });
          hsRenderLower();
        };
        tr.onclick = (e) => { if (e.detail === 2) hsGoTo(c.name); };
        t.appendChild(tr);
        if (open && kids) add(kids, k, depth + 1);
      }
    };
    add(HS.refs, 'r', 0);
    body.append(h('div', { class: 'dlg-desc hs-hint' }, `What the ${HS.refs.instances.toLocaleString()} ${HS.selected} objects reference.`), t);
    if (!HS.refs.children.length) body.appendChild(h('div', { class: 'dg-empty' }, 'They reference no other objects.'));
  }
}
$$('#hsLowerTabs button').forEach((b) => b.addEventListener('click', () => { HS.lowerTab = b.dataset.tab; hsRenderLower(); }));

async function hsGoTo(name) {
  const loc = await api.prof.findType({ root: state.root, name });
  if (!loc) { status(`Can't find where ${name} is declared in this folder`); return; }
  hsHide();
  await openFile(loc.file, loc.line);
}

$('#hsBase').addEventListener('change', () => { HS.base = +$('#hsBase').value; hsRender(); });
$('#hsSearch').addEventListener('input', () => { HS.search = $('#hsSearch').value; hsRender(); });
$('#hsMine').addEventListener('change', () => { HS.mine = $('#hsMine').checked; hsRender(); });
$('#hsClose').onclick = hsHide;
$('#hsView').addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') hsHide(); });
bus.on('folder', () => hsHide());
for (const name of ['showHistory', 'showPullRequests', 'showWorkItems', 'pfShowReport']) {
  const orig = window[name];
  if (typeof orig === 'function') window[name] = function (...a) { if (HS.open) hsHide(); return orig.apply(this, a); };
}
Object.assign(commands, {
  diagHeapView: () => { const s = DG.s; if (!s) return; const i = s.snapshots.map((x, k) => (x.heap ? k : -1)).filter((k) => k >= 0).pop(); if (i != null && i >= 0) hsShow(s, i); else status('No heap snapshot yet: take one in Diagnostic Tools (.NET programs)'); }
});
window.HS = HS;
