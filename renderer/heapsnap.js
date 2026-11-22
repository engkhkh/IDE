// Nova IDE - .NET heap snapshot view: live objects by type, compared with another snapshot
'use strict';

const HS = { s: null, index: 0, base: -1, sort: { key: 'bytes', dir: -1 }, search: '', mine: false, open: false };
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
  $('#hsView').classList.remove('hidden');
  hsRender();
  $('#hsView').focus();
}
function hsHide() { HS.open = false; $('#hsView').classList.add('hidden'); }

function hsRows() {
  const sn = HS.s.snapshots[HS.index];
  const base = HS.base >= 0 ? HS.s.snapshots[HS.base].heap : null;
  const prev = new Map(base ? base.types.map((t) => [t.name, t]) : []);
  const rows = sn.heap.types.map((t) => {
    const p = prev.get(t.name);
    return { name: t.name, count: t.count, bytes: t.bytes, dCount: base ? t.count - (p ? p.count : 0) : null, dBytes: base ? t.bytes - (p ? p.bytes : 0) : null, isNew: base && !p };
  });
  // types that are gone
  if (base) { const now = new Set(sn.heap.types.map((t) => t.name)); for (const p of base.types) if (!now.has(p.name)) rows.push({ name: p.name, count: 0, bytes: 0, dCount: -p.count, dBytes: -p.bytes, gone: true }); }
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
    h('span', { class: 'dlg-desc' }, `  Live objects after a full GC (sizes are the objects themselves, not what they reference)${base ? `; diff against snapshot #${HS.base + 1}` : ''}.`));
  let rows = hsRows().filter((r) => (!HS.search || r.name.toLowerCase().includes(HS.search.toLowerCase())) && (!HS.mine || !hsFramework(r.name)));
  const { key, dir } = HS.sort;
  rows.sort((a, b) => (key === 'name' ? -dir * a.name.localeCompare(b.name) : dir * ((a[key] || 0) - (b[key] || 0))));
  const t = h('table', { class: 'pf-table', id: 'hsTable' });
  const cols = [['name', 'Object Type'], ['count', 'Count', 'num'], ...(base ? [['dCount', 'Count Diff', 'num']] : []), ['bytes', 'Size', 'num'], ...(base ? [['dBytes', 'Size Diff', 'num']] : [])];
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
      h('td', { class: 'num' }, hsKB(r.bytes)), ...(base ? [diff(r.dBytes, hsKB)] : []));
    tr.onclick = (e) => {
      $$('#hsTable tr.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      if (e.detail === 2) hsGoTo(r.name);
    };
    t.appendChild(tr);
  }
  const body = $('#hsBody');
  body.innerHTML = '';
  body.appendChild(t);
  if (!rows.length) body.appendChild(h('div', { class: 'dg-empty' }, 'No types match.'));
}

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
