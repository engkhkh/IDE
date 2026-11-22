// Nova IDE - Performance Profiler: options dialog (Alt+F2), performance report (CPU usage by function,
// call tree, callers/callees, hot path, allocations) and hot lines in the editor
'use strict';

const PF = {
  opts: { cpu: true, alloc: false },
  active: null, // { id } while a profiled program runs
  report: null, // the last report
  model: null, // computed from the report for the current Just My Code setting
  tab: 'cpu', view: 'functions', search: '', jmc: true, hints: false,
  sort: { key: 'self', dir: -1 }, allocSort: { key: 'bytes', dir: -1 },
  expanded: new Set(), hot: new Set(), current: null, selected: null, open: false
};
try { Object.assign(PF.opts, JSON.parse(localStorage.getItem('nova.profilerOpts') || '{}')); } catch { /* */ }

const pfMs = (v) => `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ms`;
const pfPct = (v, total) => (total ? `${((v / total) * 100).toFixed(1)}%` : '');
function pfBytes(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`; }

// ---------------- what will be profiled ----------------
function pfTarget() {
  const p = state.project;
  const file = state.active && state.active.path;
  if (p && p.type === 'dotnet' && p.startup) return { lang: 'dotnet', name: baseName(p.startup).replace(/\.\w+proj$/, ''), project: p.startup, label: `.NET project ${baseName(p.startup)}` };
  if (p && p.type === 'node') return { lang: 'node', name: (p.name || baseName(state.root || '')), label: `Node.js project (${commandFor('run') || 'npm start'})` };
  if (file && /\.(js|mjs|cjs)$/i.test(file)) return { lang: 'node', name: baseName(file), label: `Node.js: ${baseName(file)}` };
  if (file && /\.py$/i.test(file)) return { lang: 'python', name: baseName(file), label: `Python: ${baseName(file)}` };
  const cmd = commandFor('run');
  return { lang: null, name: baseName(file || state.root || 'program'), label: cmd ? `${cmd} (CPU usage by function is available for .NET, Node.js and Python)` : null };
}

// ---------------- options dialog ----------------
function pfShowDialog() {
  if (DBG.root || DBG.starting) { status('Stop debugging first (Shift+F5)'); return; }
  if (state.runId) { status('A process is already running. Stop it first (Shift+F5).'); return; }
  const t = pfTarget();
  if (!t.label) { status('Nothing to profile: open a project or a runnable file'); return; }
  $('#pfTarget').textContent = `Target: ${t.label}`;
  $('#pfCpu').checked = PF.opts.cpu;
  $('#pfAlloc').checked = PF.opts.alloc && t.lang !== 'python';
  $('#pfCpu').disabled = !t.lang;
  $('#pfAlloc').disabled = !t.lang || t.lang === 'python';
  $('#pfAllocDesc').textContent = t.lang === 'python' ? 'Not available for Python programs.' : t.lang === 'dotnet' ? 'What allocates memory, by .NET object type and the method that allocated it (sampled about every 100 KB).' : t.lang === 'node' ? 'What allocates memory, by function (sampled about every 32 KB).' : 'Available for .NET and Node.js programs.';
  $('#pfDlg').classList.remove('hidden');
  $('#pfStart').focus();
}
function pfHideDialog() { $('#pfDlg').classList.add('hidden'); }
$('#pfDlgClose').onclick = pfHideDialog;
$('#pfCancel').onclick = pfHideDialog;
$('#pfDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') pfHideDialog(); if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') $('#pfStart').click(); });
$('#pfStart').onclick = () => {
  const t = pfTarget();
  PF.opts = { cpu: $('#pfCpu').checked, alloc: $('#pfAlloc').checked };
  try { localStorage.setItem('nova.profilerOpts', JSON.stringify(PF.opts)); } catch { /* */ }
  pfHideDialog();
  pfStart({ ...PF.opts, target: t });
};

async function pfStart({ cpu, alloc, target }) {
  const t = target || pfTarget();
  let prep = null;
  if ((cpu || alloc) && t.lang) {
    if (t.lang === 'dotnet') {
      status('Building before profiling...');
      const code = await exec('build');
      if (code !== 0) { status('Build failed: fix the errors and profile again'); return null; }
    }
    prep = await api.prof.prepare({ lang: t.lang, cpu, alloc, project: t.project, config: $('#config').value, root: state.root });
    if (prep.error) { log(`${prep.error}\n`, 'stderr'); showPanel('output'); status(prep.error); return null; }
  }
  PF.active = prep ? { id: prep.id } : null;
  const s = await dgProfile({ command: prep ? prep.command : undefined, env: prep ? prep.env : undefined, name: t.name, lang: t.lang, profId: prep ? prep.id : null });
  PF.active = null;
  if (!prep) return s;
  status('Analyzing the profile...');
  const report = await api.prof.finish(prep.id);
  report.name = t.name; report.root = state.root; report.at = Date.now();
  PF.report = report;
  if (s) s.report = report;
  pfCompute();
  PF.current = null; PF.selected = null; PF.expanded = new Set(PF.hot); PF.search = ''; $('#pfSearch').value = '';
  PF.tab = report.cpu ? 'cpu' : 'alloc';
  PF.view = 'functions';
  if (typeof dgRender === 'function') dgRender();
  if (report.cpu || report.alloc) { pfShowReport(); status(`Performance report: ${t.name}`); } else status(report.notes.join(' ') || 'No profile data');
  pfApplyHintsAll();
  return s;
}

// Stop: let .NET finish its trace (method names) before the program is killed
const pfOrigStop = commands.stop;
commands.stop = async () => { if (PF.active) { status('Ending the trace...'); await api.prof.beforeStop(PF.active.id); } return pfOrigStop(); };
$('#dgStop').onclick = () => { if (DG.s && DG.s.kind === 'profile') commands.stop(); };
$('#dgProfile').onclick = () => pfShowDialog();

// ---------------- model: functions, call tree, edges ----------------
function pfCompute() {
  const cpu = PF.report && PF.report.cpu;
  PF.model = null;
  PF.hot = new Set();
  if (!cpu) return;
  const fns = cpu.functions.map((f) => ({ ...f, self: cpu.stacks ? 0 : f.self || 0, total: cpu.stacks ? 0 : f.total || 0 }));
  if (!cpu.stacks) {
    // flat profile (Python): functions + call edges
    let edges = cpu.edges || [];
    let list = fns.map((f, i) => i);
    if (PF.jmc) list = list.filter((i) => !fns[i].framework);
    const total = fns.reduce((a, f) => a + f.self, 0);
    PF.model = { fns, edges, tree: null, total, list };
    return;
  }
  let EXT = -1;
  if (PF.jmc) { EXT = fns.length; fns.push({ name: '[External Code]', module: '', framework: true, ext: true, self: 0, total: 0 }); }
  const root = { f: -1, t: 0, s: 0, c: new Map() };
  const edges = new Map();
  for (const st of cpu.stacks) {
    let frames = st.frames;
    if (PF.jmc) {
      frames = [];
      for (const f of st.frames) { const g = fns[f].framework ? EXT : f; if (!(g === EXT && frames[frames.length - 1] === EXT)) frames.push(g); }
    }
    const w = st.w;
    root.t += w;
    let node = root;
    for (const f of frames) {
      let c = node.c.get(f);
      if (!c) { c = { f, t: 0, s: 0, c: new Map() }; node.c.set(f, c); }
      c.t += w;
      node = c;
    }
    node.s += w;
    for (const f of new Set(frames)) fns[f].total += w;
    if (frames.length) fns[frames[frames.length - 1]].self += w;
    const seen = new Set();
    for (let i = 0; i + 1 < frames.length; i++) { const k = `${frames[i]},${frames[i + 1]}`; if (!seen.has(k)) { seen.add(k); edges.set(k, (edges.get(k) || 0) + w); } }
  }
  const edgeList = [...edges].map(([k, w]) => { const [a, b] = k.split(',').map(Number); return [a, b, w]; });
  // hot path: keep following the child that holds most of the time
  let node = root, key = '';
  while (node.c.size) {
    const best = [...node.c.values()].sort((a, b) => b.t - a.t)[0];
    if (best.t < node.t * 0.5 || best.t < root.t * 0.05) break;
    key = key ? `${key}/${best.f}` : String(best.f);
    PF.hot.add(key);
    node = best;
  }
  const list = fns.map((f, i) => i).filter((i) => fns[i].total > 0 && (!PF.jmc || !fns[i].framework || fns[i].ext));
  PF.model = { fns, edges: edgeList, tree: root, total: root.t, list };
}

// ---------------- report view ----------------
function pfShowReport() {
  if (!PF.report) { status('No performance report yet: Debug > Performance Profiler (Alt+F2)'); return; }
  if (typeof hideHistory === 'function' && typeof GH !== 'undefined' && GH.open) hideHistory();
  if (typeof hidePullRequests === 'function' && typeof PR !== 'undefined' && PR.open) hidePullRequests();
  if (typeof hideWorkItems === 'function' && typeof WI !== 'undefined' && WI.open) hideWorkItems();
  PF.open = true;
  $('#pfView').classList.remove('hidden');
  pfRender();
  $('#pfView').focus();
}
function pfHideReport() { PF.open = false; $('#pfView').classList.add('hidden'); }
for (const name of ['showHistory', 'showPullRequests', 'showWorkItems']) {
  const orig = window[name];
  if (typeof orig === 'function') window[name] = function (...a) { if (PF.open) pfHideReport(); return orig.apply(this, a); };
}

function pfRender() {
  const r = PF.report;
  if (!r) return;
  $$('#pfTabs button').forEach((b) => { b.classList.toggle('active', b.dataset.tab === PF.tab); b.disabled = b.dataset.tab === 'cpu' ? !r.cpu : !r.alloc; });
  $$('#pfViews button').forEach((b) => { b.classList.toggle('active', b.dataset.view === PF.view); b.disabled = b.dataset.view === 'tree' && !(r.cpu && r.cpu.stacks); });
  $('#pfViews').classList.toggle('hidden', PF.tab !== 'cpu');
  $('#pfJmc').checked = PF.jmc;
  $('#pfHints').classList.toggle('active', PF.hints);
  $('#pfHints').disabled = !pfHasHints();
  $('#pfSearch').placeholder = PF.tab === 'cpu' ? 'Search functions' : r.alloc && r.alloc.by === 'type' ? 'Search types' : 'Search functions';
  $('#pfTitle').textContent = `Performance Report: ${r.name}`;
  const info = $('#pfInfo');
  info.innerHTML = '';
  const m = PF.model;
  const parts = [`${({ dotnet: '.NET', node: 'Node.js', python: 'Python' })[r.lang] || r.lang}`, `ran ${(r.durationMs / 1000).toFixed(1)} s`];
  if (m) parts.push(`CPU ${pfMs(m.total)}`);
  if (r.alloc) parts.push(`allocated ${pfBytes(r.alloc.rows.reduce((a, x) => a + x.bytes, 0))}`);
  info.append(h('span', {}, parts.join(' · ')), h('span', { class: 'dlg-desc' }, `  ${PF.tab === 'cpu' ? (r.cpu ? r.cpu.source : '') : (r.alloc ? r.alloc.source : '')}`));
  for (const n of r.notes || []) info.append(h('div', { class: 'pf-note' }, n));
  const body = $('#pfBody');
  body.innerHTML = '';
  if (PF.tab === 'cpu' && m) {
    if (PF.view === 'functions') pfRenderFunctions(body);
    else if (PF.view === 'tree' && m.tree) pfRenderTree(body);
    else pfRenderCallers(body);
  } else if (PF.tab === 'alloc' && r.alloc) pfRenderAlloc(body);
}

function pfHeader(cols, sort, onSort) {
  return h('tr', {}, ...cols.map(([key, label, cls]) => {
    const th = h('th', { class: `${cls || ''}${sort && sort.key === key ? ' sorted' : ''}` }, label, sort && sort.key === key ? (sort.dir < 0 ? ' ▼' : ' ▲') : '');
    if (onSort && key) th.onclick = () => onSort(key);
    return th;
  }));
}
function pfBar(v, total) { return h('span', { class: 'pf-bar' }, h('i', { style: `width:${total ? Math.min(100, (v / total) * 100) : 0}%` })); }
function pfFnCell(f, extra) {
  return h('td', { class: 'pf-name', title: f.file ? `${f.file}:${f.line}` : f.name }, extra || '', h('span', { class: f.ext || f.special ? 'pf-ext' : f.framework ? 'pf-fw' : '' }, f.name));
}
function pfMatch(f) { return !PF.search || f.name.toLowerCase().includes(PF.search.toLowerCase()); }

function pfRenderFunctions(body) {
  const m = PF.model;
  const rows = m.list.filter((i) => pfMatch(m.fns[i]));
  const k = PF.sort.key, d = PF.sort.dir;
  rows.sort((a, b) => { const A = m.fns[a], B = m.fns[b]; return k === 'name' ? -d * A.name.localeCompare(B.name) : d * ((A[k] || 0) - (B[k] || 0)); });
  const t = h('table', { class: 'pf-table', id: 'pfFunctions' });
  const hasCalls = m.fns.some((f) => f.calls != null);
  t.appendChild(pfHeader([['name', 'Function Name'], ['total', 'Total CPU', 'num'], ['self', 'Self CPU', 'num'], ...(hasCalls ? [['calls', 'Calls', 'num']] : []), [null, 'Module']], PF.sort, (key) => { PF.sort = { key, dir: PF.sort.key === key ? -PF.sort.dir : -1 }; pfRender(); }));
  for (const i of rows.slice(0, 500)) {
    const f = m.fns[i];
    const tr = h('tr', { class: PF.selected === i ? 'selected' : '', 'data-fn': String(i) },
      pfFnCell(f),
      h('td', { class: 'num' }, pfMs(f.total), h('span', { class: 'pf-pct' }, pfPct(f.total, m.total)), pfBar(f.total, m.total)),
      h('td', { class: 'num' }, pfMs(f.self), h('span', { class: 'pf-pct' }, pfPct(f.self, m.total))),
      ...(hasCalls ? [h('td', { class: 'num' }, f.calls != null ? f.calls.toLocaleString() : '')] : []),
      h('td', { class: 'dlg-desc' }, f.module || ''));
    pfRowEvents(tr, i);
    t.appendChild(tr);
  }
  body.appendChild(t);
  if (!rows.length) body.appendChild(h('div', { class: 'dg-empty' }, PF.search ? 'No function matches.' : 'No samples in your code.'));
}
function pfRowEvents(tr, i) {
  tr.onclick = (e) => { PF.selected = i; $$('#pfBody tr.selected').forEach((x) => x.classList.remove('selected')); tr.classList.add('selected'); if (e.detail === 2) pfGoTo(PF.model.fns[i]); };
  tr.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    PF.selected = i;
    const f = PF.model.fns[i];
    popup(e.clientX, e.clientY, [
      { label: 'Go to Source', disabled: !(f.file || f.method), run: () => pfGoTo(f) },
      { label: 'View in Caller/Callee', run: () => { PF.current = i; PF.view = 'callers'; pfRender(); } },
      { label: 'Copy Name', run: () => navigator.clipboard.writeText(f.name) }
    ]);
  };
}

function pfRenderTree(body) {
  const m = PF.model;
  const t = h('table', { class: 'pf-table', id: 'pfTree' });
  t.appendChild(pfHeader([[null, 'Function Name'], [null, 'Total CPU', 'num'], [null, 'Self CPU', 'num'], [null, 'Module']]));
  const add = (node, key, depth) => {
    const kids = [...node.c.values()].sort((a, b) => b.t - a.t);
    for (const c of kids) {
      const k = key ? `${key}/${c.f}` : String(c.f);
      const f = m.fns[c.f];
      const open = PF.expanded.has(k);
      const chev = h('span', { class: 'chev' }, c.c.size ? (open ? '▾' : '▸') : '');
      const cell = pfFnCell(f, h('span', {}, chev, PF.hot.has(k) ? h('span', { class: 'pf-hot', title: 'Hot path' }, '🔥') : ''));
      cell.style.paddingLeft = `${4 + depth * 14}px`;
      const tr = h('tr', { class: `${PF.hot.has(k) ? 'pf-hotrow' : ''}`, 'data-key': k }, cell,
        h('td', { class: 'num' }, pfMs(c.t), h('span', { class: 'pf-pct' }, pfPct(c.t, m.total)), pfBar(c.t, m.total)),
        h('td', { class: 'num' }, pfMs(c.s), h('span', { class: 'pf-pct' }, pfPct(c.s, m.total))),
        h('td', { class: 'dlg-desc' }, f.module || ''));
      pfRowEvents(tr, c.f);
      chev.onclick = (e) => { e.stopPropagation(); if (open) PF.expanded.delete(k); else PF.expanded.add(k); pfRender(); };
      t.appendChild(tr);
      if (open) add(c, k, depth + 1);
    }
  };
  add(m.tree, '', 0);
  body.append(h('div', { class: 'pf-tools-row' },
    (() => { const b = h('button', {}, '🔥 Expand Hot Path'); b.onclick = () => { PF.expanded = new Set([...PF.expanded, ...PF.hot]); pfRender(); }; return b; })(),
    (() => { const b = h('button', {}, 'Collapse All'); b.onclick = () => { PF.expanded.clear(); pfRender(); }; return b; })()), t);
}

function pfRenderCallers(body) {
  const m = PF.model;
  if (PF.current == null || !m.fns[PF.current]) {
    // start with the function that uses most time itself (in your code)
    const mine = m.list.filter((i) => !m.fns[i].framework);
    PF.current = (PF.selected != null ? PF.selected : null) ?? (mine.length ? mine : m.list).slice().sort((a, b) => m.fns[b].self - m.fns[a].self)[0];
  }
  const cur = PF.current;
  const f = m.fns[cur];
  if (!f) return;
  const sum = (pairs) => { const mp = new Map(); for (const [i, w] of pairs) mp.set(i, (mp.get(i) || 0) + w); return [...mp].sort((a, b) => b[1] - a[1]); };
  const callers = sum(m.edges.filter((e) => e[1] === cur && e[0] !== cur).map((e) => [e[0], e[2]]));
  const callees = sum(m.edges.filter((e) => e[0] === cur && e[1] !== cur).map((e) => [e[1], e[2]]));
  const section = (title, rows, id) => {
    const t = h('table', { class: 'pf-table', id });
    t.appendChild(pfHeader([[null, title], [null, 'Total CPU', 'num'], [null, 'Module']]));
    for (const [i, w] of rows) {
      const tr = h('tr', { class: 'link' }, pfFnCell(m.fns[i]), h('td', { class: 'num' }, pfMs(w), h('span', { class: 'pf-pct' }, pfPct(w, m.total)), pfBar(w, m.total)), h('td', { class: 'dlg-desc' }, m.fns[i].module || ''));
      tr.onclick = (e) => { if (e.detail === 2) { pfGoTo(m.fns[i]); return; } PF.current = i; PF.selected = i; pfRender(); };
      t.appendChild(tr);
    }
    if (!rows.length) t.appendChild(h('tr', {}, h('td', { class: 'dlg-desc', colspan: '3' }, 'None')));
    return t;
  };
  const curBox = h('div', { class: 'pf-current', id: 'pfCurrent' },
    h('div', { class: 'pf-current-name' }, f.name),
    h('div', {}, `Total ${pfMs(f.total)} (${pfPct(f.total, m.total)}) · Self ${pfMs(f.self)} (${pfPct(f.self, m.total)})${f.calls != null ? ` · ${f.calls.toLocaleString()} calls` : ''}`),
    (() => { const b = h('button', {}, 'Go to Source'); b.disabled = !(f.file || f.method); b.onclick = () => pfGoTo(f); return b; })());
  body.append(section('Calling functions', callers, 'pfCallers'), curBox, section('Called functions', callees, 'pfCallees'));
}

function pfRenderAlloc(body) {
  const a = PF.report.alloc;
  const byType = a.by === 'type';
  const total = a.rows.reduce((s, x) => s + x.bytes, 0);
  let rows = a.rows.filter((x) => pfMatch(x) && (!PF.jmc || byType || !x.framework));
  const k = PF.allocSort.key, d = PF.allocSort.dir;
  rows = rows.slice().sort((x, y) => (k === 'name' ? -d * x.name.localeCompare(y.name) : d * ((x[k] || 0) - (y[k] || 0))));
  const t = h('table', { class: 'pf-table', id: 'pfAlloc' });
  const cols = byType ? [['name', 'Type'], ['bytes', 'Allocated', 'num'], ['count', 'Objects (est.)', 'num'], ['ticks', 'Samples', 'num']] : [['name', 'Function'], ['bytes', 'Allocated', 'num'], ['samples', 'Samples', 'num'], [null, 'Module']];
  t.appendChild(pfHeader(cols, PF.allocSort, (key) => { PF.allocSort = { key, dir: PF.allocSort.key === key ? -PF.allocSort.dir : -1 }; pfRender(); }));
  for (const x of rows.slice(0, 500)) {
    const key = `a:${x.name}`;
    const open = PF.expanded.has(key);
    const chev = h('span', { class: 'chev' }, byType && x.by && x.by.length ? (open ? '▾' : '▸') : '');
    const tr = h('tr', { 'data-name': x.name }, h('td', { class: 'pf-name', title: x.file ? `${x.file}:${x.line}` : x.name }, chev, h('span', { class: x.framework ? 'pf-fw' : '' }, x.name)),
      h('td', { class: 'num' }, pfBytes(x.bytes), h('span', { class: 'pf-pct' }, pfPct(x.bytes, total)), pfBar(x.bytes, total)),
      ...(byType ? [h('td', { class: 'num' }, x.count != null ? x.count.toLocaleString() : ''), h('td', { class: 'num' }, String(x.ticks))] : [h('td', { class: 'num' }, String(x.samples || '')), h('td', { class: 'dlg-desc' }, x.module || '')]));
    chev.onclick = (e) => { e.stopPropagation(); if (open) PF.expanded.delete(key); else PF.expanded.add(key); pfRender(); };
    tr.onclick = (e) => { if (e.detail === 2) { if (byType) { if (open) PF.expanded.delete(key); else PF.expanded.add(key); pfRender(); } else pfGoTo(x); } };
    t.appendChild(tr);
    if (open) {
      for (const b of x.by) {
        const r2 = h('tr', { class: 'pf-sub' }, h('td', { class: 'pf-name', style: 'padding-left:26px' }, h('span', { class: b.ns ? '' : 'pf-ext' }, `allocated by ${b.name}`)),
          h('td', { class: 'num' }, pfBytes(b.bytes), h('span', { class: 'pf-pct' }, pfPct(b.bytes, x.bytes))), h('td', {}, ''), h('td', { class: 'num' }, String(b.ticks)));
        r2.onclick = (e) => { if (e.detail === 2 && b.method) pfGoTo(b); };
        t.appendChild(r2);
      }
    }
  }
  body.appendChild(t);
  if (!rows.length) body.appendChild(h('div', { class: 'dg-empty' }, 'No allocations recorded.'));
}

// Go to a function's source: file/line when known (Node, Python), else find the .NET method by name
async function pfGoTo(f) {
  let loc = f.file ? { file: f.file, line: f.line } : null;
  if (!loc && f.method) loc = await api.prof.findMethod({ root: (PF.report && PF.report.root) || state.root, ns: f.ns, method: f.method });
  if (!loc) { status(`Source not found for ${f.name}`); return; }
  pfHideReport();
  await openFile(loc.file, loc.line);
}

// ---------------- hot lines in the editor ----------------
const PF_DECOS = new Map();
function pfLinesFor(path) {
  const cpu = PF.report && PF.report.cpu;
  if (!cpu || !PF.model) return null;
  const key = normPathKey(path);
  const out = new Map();
  if (cpu.lines) {
    for (const [file, ls] of Object.entries(cpu.lines)) if (normPathKey(file) === key) for (const [l, ms] of Object.entries(ls)) out.set(+l, { ms, kind: 'line' });
  }
  // function totals on their first line (all languages with file info)
  for (const f of PF.model.fns) if (f.file && normPathKey(f.file) === key && f.total > 0) { const e = out.get(f.line); out.set(f.line, { ms: e ? e.ms : 0, fn: f.total, kind: e ? 'both' : 'fn' }); }
  return out.size ? out : null;
}
function pfHasHints() { return !!(PF.report && PF.report.cpu && PF.model && (PF.report.cpu.lines && Object.keys(PF.report.cpu.lines).length || PF.model.fns.some((f) => f.file))); }
function pfApplyHints(model) {
  if (!model || model.isDisposed() || model.uri.scheme !== 'file') return;
  const key = model.uri.toString();
  const decos = [];
  const lines = PF.hints ? pfLinesFor(model.uri.fsPath) : null;
  if (lines) {
    const total = PF.model.total || 1;
    const max = model.getLineCount();
    for (const [n, e] of lines) {
      if (n < 1 || n > max) continue;
      const pct = ((e.ms || 0) / total) * 100;
      if (e.kind === 'line' && pct < 0.5) continue;
      const lvl = pct >= 10 ? 3 : pct >= 3 ? 2 : 1;
      const text = e.kind === 'fn' ? `  ⏱ ${pfMs(e.fn)} total (${pfPct(e.fn, total)})` : e.kind === 'both' ? `  ⏱ ${pfMs(e.ms)} (${pct.toFixed(1)}%) · function ${pfMs(e.fn)}` : `  ⏱ ${pfMs(e.ms)} (${pct.toFixed(1)}%)`;
      if (e.kind !== 'fn') decos.push({ range: new monacoRef.Range(n, 1, n, 1), options: { isWholeLine: true, className: `pf-heat pf-heat-${lvl}`, overviewRuler: { color: ['', '#e2c08d66', '#e2c08daa', '#f14c4cdd'][lvl], position: monacoRef.editor.OverviewRulerLane.Right } } });
      // the text goes after the end of the line (an empty range needs showIfCollapsed)
      const endCol = model.getLineMaxColumn(n);
      decos.push({ range: new monacoRef.Range(n, endCol, n, endCol), options: { showIfCollapsed: true, after: { content: text, inlineClassName: 'pf-hint' }, stickiness: monacoRef.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
    }
  }
  PF_DECOS.set(key, model.deltaDecorations(PF_DECOS.get(key) || [], decos));
}
function pfApplyHintsAll() { if (typeof monacoRef !== 'undefined' && monacoRef) for (const m of monacoRef.editor.getModels()) pfApplyHints(m); }
bus.on('ready', () => { if (typeof monacoRef !== 'undefined' && monacoRef) monacoRef.editor.onDidCreateModel((m) => setTimeout(() => pfApplyHints(m), 0)); });

// ---------------- Diagnostic Tools summary: top functions ----------------
const pfOrigRenderBody = dgRenderBody;
dgRenderBody = function () { // eslint-disable-line no-func-assign
  pfOrigRenderBody();
  const s = DG.s;
  if (!s || DG.tab !== 'summary' || !s.report) return;
  const r = s.report;
  const body = $('#dgBody');
  const sec = h('div', { class: 'dg-sec', id: 'dgProfileSummary' }, h('div', { class: 'dg-sec-title' }, 'Profile'));
  if (r === PF.report && PF.model) {
    const m = PF.model;
    const top = m.list.filter((i) => !m.fns[i].ext && !m.fns[i].special).sort((a, b) => m.fns[b].self - m.fns[a].self).slice(0, 5);
    if (top.length) sec.appendChild(h('div', { class: 'dlg-desc' }, 'Top functions (self CPU)'));
    for (const i of top) {
      const a = h('a', { href: '#', class: 'pf-top' }, `${m.fns[i].name}`);
      a.onclick = (e) => { e.preventDefault(); PF.tab = 'cpu'; PF.view = 'callers'; PF.current = i; pfShowReport(); };
      sec.appendChild(h('div', { class: 'pf-top-row' }, a, h('span', { class: 'dlg-desc' }, ` ${pfMs(m.fns[i].self)} (${pfPct(m.fns[i].self, m.total)})`)));
    }
  }
  if (r.alloc && r.alloc.rows.length) {
    sec.appendChild(h('div', { class: 'dlg-desc' }, `Most allocated ${r.alloc.by === 'type' ? 'types' : 'by'}`));
    for (const x of r.alloc.rows.slice(0, 3)) sec.appendChild(h('div', { class: 'pf-top-row' }, x.name, h('span', { class: 'dlg-desc' }, ` ${pfBytes(x.bytes)}`)));
  }
  for (const n of r.notes || []) sec.appendChild(h('div', { class: 'pf-note' }, n));
  const b = h('button', { id: 'dgReportBtn' }, 'Open Details');
  b.disabled = !(r.cpu || r.alloc);
  b.onclick = () => { PF.report = r; pfCompute(); pfShowReport(); };
  sec.appendChild(b);
  body.appendChild(sec);
};

// ---------------- wiring ----------------
$$('#pfTabs button').forEach((b) => b.addEventListener('click', () => { PF.tab = b.dataset.tab; pfRender(); }));
$$('#pfViews button').forEach((b) => b.addEventListener('click', () => { PF.view = b.dataset.view; pfRender(); }));
$('#pfSearch').addEventListener('input', () => { PF.search = $('#pfSearch').value; pfRender(); });
$('#pfJmc').addEventListener('change', () => { PF.jmc = $('#pfJmc').checked; const keep = PF.current != null && PF.model ? PF.model.fns[PF.current] : null; pfCompute(); PF.expanded = new Set(PF.hot); PF.current = keep ? PF.model.fns.findIndex((f) => f.name === keep.name) : null; if (PF.current < 0) PF.current = null; PF.selected = null; pfRender(); pfApplyHintsAll(); });
$('#pfHints').onclick = () => { PF.hints = !PF.hints; pfApplyHintsAll(); pfRender(); status(PF.hints ? 'Hot lines shown in the editor' : 'Hot lines hidden'); };
$('#pfClose').onclick = pfHideReport;
$('#pfView').addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.tagName !== 'INPUT') pfHideReport(); });
bus.on('folder', () => { pfHideReport(); });

Object.assign(commands, {
  performanceProfiler: () => pfShowDialog(),
  profilerReport: () => pfShowReport(),
  profilerHotLines: () => { PF.hints = !PF.hints; pfApplyHintsAll(); if (PF.open) pfRender(); }
});

window.PF = PF;
window.pfStart = pfStart;
