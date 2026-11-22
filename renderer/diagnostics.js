// Nova IDE - Diagnostic Tools: events, process memory and CPU of the program while debugging,
// and the Performance Profiler (the same, without the debugger)
'use strict';

const DG = { s: null, tab: 'summary', hoverT: null, selected: null };
const DG_MAX_EVENTS = 2000;
const dgMB = (b) => b / (1024 * 1024);
const dgFmtMB = (b) => `${dgMB(b) >= 100 ? dgMB(b).toFixed(0) : dgMB(b).toFixed(1)} MB`;
function dgFmtTime(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
const dgNow = () => (DG.s ? (DG.s.ended || Date.now()) - DG.s.start : 0);

// ---------------- sessions ----------------
async function dgStart({ kind, name, dapId = null, pid = null, procId = null, extra = {} }) {
  if (DG.s && !DG.s.ended) await dgStop();
  const s = { kind, name, start: Date.now(), samples: [], events: [], breaks: [], snapshots: [], ended: null, id: null, cpus: 1, exitCode: null, error: null, ...extra };
  DG.s = s;
  DG.hoverT = null; DG.selected = null;
  DG.tab = 'summary';
  const r = await api.diag.start(pid ? { pid } : procId != null ? { procId } : { dapId });
  if (DG.s !== s) return;
  if (r.error) { s.error = r.error; s.ended = Date.now(); }
  else { s.id = r.id; s.cpus = r.cpus || 1; }
  dgEvent('process', kind === 'profile' ? `Started ${name} (without debugging)` : `Debugging started: ${name}`);
  $('#diagDot').classList.toggle('hidden', !!s.ended);
  dgRender();
}
async function dgStop() {
  const s = DG.s;
  if (!s || s.ended) return;
  s.ended = Date.now();
  const open = s.breaks[s.breaks.length - 1];
  if (open && open[1] == null) open[1] = s.ended - s.start;
  if (s.id) await api.diag.stop(s.id);
  $('#diagDot').classList.add('hidden');
  dgRender();
}
function dgEvent(kind, text, extra = {}) {
  const s = DG.s;
  if (!s || s.ended) return null;
  // many output lines: keep the first ones, count the rest
  if (kind === 'output' && s.events.filter((e) => e.kind === 'output').length >= DG_MAX_EVENTS) { s.droppedOutput = (s.droppedOutput || 0) + 1; return null; }
  const e = { t: dgNow(), kind, text, ...extra };
  s.events.push(e);
  return e;
}

api.on('diag:sample', (m) => {
  const s = DG.s;
  if (!s || m.id !== s.id || s.ended) return;
  if (m.error) return;
  s.samples.push(m);
  if (m.names && m.names.length) s.names = m.names;
  dgRenderCharts();
  if (DG.tab !== 'events') dgRenderBody();
});

// ---------------- debugger hooks ----------------
bus.on('debugStarted', ({ session, name, pid, type }) => {
  if (state.settings.diagShowOnDebug !== false) showSide('diag');
  dgStart({ kind: 'debug', name, dapId: session.id, pid: pid || null, extra: { dotnet: type === 'coreclr' } });
});
bus.on('debugEvent', (ev) => {
  const s = DG.s;
  if (!s || s.kind !== 'debug' || s.ended) return;
  const t = dgNow();
  if (ev.kind === 'break') {
    const open = s.breaks[s.breaks.length - 1];
    if (!open || open[1] != null) s.breaks.push([t, null]);
    const label = ev.reason === 'exception' ? `Exception: ${ev.exception || ev.description}` : ev.reason === 'breakpoint' ? 'Breakpoint hit' : ev.reason === 'step' ? 'Step' : ev.reason === 'entry' ? 'Stopped at entry' : `Break (${ev.reason})`;
    dgEvent(ev.reason === 'exception' ? 'exception' : 'break', label, { file: ev.file, line: ev.line, frame: ev.frame });
  } else if (ev.kind === 'run') {
    const open = s.breaks[s.breaks.length - 1];
    if (open && open[1] == null) open[1] = t;
  } else if (ev.kind === 'output') {
    dgEvent('output', ev.text.replace(/\s+$/, '').split('\n')[0].slice(0, 200), { category: ev.category });
  } else if (ev.kind === 'process') {
    if (s.id) api.diag.setPid(s.id, ev.pid);
    dgEvent('process', `Process started: ${ev.name ? `${String(ev.name).split(/[\\/]/).pop()} ` : ''}(${ev.pid})`);
  } else if (ev.kind === 'exited') {
    s.exitCode = ev.exitCode;
    dgEvent('process', `The program exited with code ${ev.exitCode}`);
  }
  dgRender();
});
bus.on('debugEnded', () => {
  const s = DG.s;
  if (!s || s.kind !== 'debug' || s.ended) return;
  if (s.exitCode == null) dgEvent('process', 'Debugging ended');
  dgStop();
});

// ---------------- Performance Profiler: run without the debugger and record ----------------
// opts: { command, env, name } from the profiler options (renderer/profiler.js); resolves with the session
async function dgProfile(opts = {}) {
  if (DBG.root || DBG.starting) { status('Stop debugging first (Shift+F5)'); return null; }
  if (state.runId) { status('A process is already running. Stop it first (Shift+F5).'); return null; }
  showSide('diag');
  const done = exec('run', opts.command, opts.env);
  // exec sets state.runId once the process is started
  for (let i = 0; i < 100 && !state.runId; i++) await new Promise((r) => setTimeout(r, 50));
  const procId = state.runId;
  if (!procId) { status('Nothing to profile: open a project with a startup project'); return null; }
  const name = opts.name || ((typeof SOL !== 'undefined' && SOL.model && SOL.startup) ? baseName(SOL.startup).replace(/\.\w+proj$/, '') : state.active ? baseName(state.active.path) : baseName(state.root || 'program'));
  await dgStart({ kind: 'profile', name, procId, extra: { dotnet: opts.lang === 'dotnet', profId: opts.profId || null } });
  const s = DG.s;
  const code = await done;
  if (DG.s === s) { s.exitCode = code; dgEvent('process', `The program exited with code ${code}`); await dgStop(); status(`Performance report ready: ${dgFmtTime(s.ended - s.start)}`); }
  return s;
}

// ---------------- numbers ----------------
function dgRunningSamples(s) {
  // samples outside break periods (CPU while the program was really running)
  return s.samples.filter((x) => !s.breaks.some(([a, b]) => x.t >= a && x.t <= (b == null ? Infinity : b)));
}
function dgStats(s) {
  const run = dgRunningSamples(s).slice(1);
  const cpuVals = run.map((x) => x.cpu);
  const mems = s.samples.map((x) => x.mem).filter((x) => x > 0);
  const last = s.samples[s.samples.length - 1];
  const peakCpu = s.samples.reduce((a, x) => (x.cpu > (a ? a.cpu : -1) ? x : a), null);
  const peakMem = s.samples.reduce((a, x) => (x.mem > (a ? a.mem : -1) ? x : a), null);
  return {
    duration: dgNow(),
    memNow: last ? last.mem : 0, memPeak: peakMem ? peakMem.mem : 0, memPeakAt: peakMem ? peakMem.t : 0, memMin: mems.length ? Math.min(...mems) : 0,
    cpuAvg: cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : 0, cpuPeak: peakCpu ? peakCpu.cpu : 0, cpuPeakAt: peakCpu ? peakCpu.t : 0, cpuNow: last ? last.cpu : 0,
    breaks: s.events.filter((e) => e.kind === 'break').length, exceptions: s.events.filter((e) => e.kind === 'exception').length, outputs: s.events.filter((e) => e.kind === 'output').length + (s.droppedOutput || 0)
  };
}

// ---------------- charts ----------------
function dgCanvas(id) {
  const c = $(id);
  const w = c.clientWidth || c.parentElement.clientWidth || 300;
  const h = +c.getAttribute('height');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = `${h}px`; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function dgSpan() { return Math.max(10000, dgNow()); } // at least 10 s across
function dgColors() {
  const cs = getComputedStyle(document.body);
  return { fg: cs.getPropertyValue('--fg-dim').trim() || '#888', grid: 'rgba(128,128,128,.18)', brk: 'rgba(148, 112, 219, .22)', mem: '#3794ff', cpu: '#73c991', hover: 'rgba(255,255,255,.55)' };
}
function dgShadeBreaks(g, w, h, X, col) {
  const s = DG.s;
  g.fillStyle = col.brk;
  for (const [a, b] of s.breaks) { const x0 = X(a), x1 = X(b == null ? dgNow() : b); g.fillRect(x0, 0, Math.max(2, x1 - x0), h); }
}
function dgLine(id, key, maxY, color, fmtNow) {
  const { g, w, h } = dgCanvas(id);
  const s = DG.s;
  const col = dgColors();
  const span = dgSpan();
  const X = (t) => (t / span) * (w - 2) + 1;
  const Y = (v) => h - 2 - (v / maxY) * (h - 6);
  // grid
  g.strokeStyle = col.grid; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = Math.round((h * i) / 4) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  if (!s) return;
  dgShadeBreaks(g, w, h, X, col);
  const pts = s.samples.map((x) => [X(x.t), Y(key === 'mem' ? dgMB(x.mem) : x.cpu)]);
  if (pts.length) {
    g.beginPath();
    g.moveTo(pts[0][0], h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(pts[pts.length - 1][0], h);
    g.closePath();
    g.fillStyle = `${color}33`; g.fill();
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = color; g.lineWidth = 1.5; g.stroke();
  }
  // memory snapshots
  if (key === 'mem') {
    g.fillStyle = '#e2c08d';
    for (const sn of s.snapshots) { const x = X(sn.t); g.beginPath(); g.moveTo(x, 1); g.lineTo(x - 4, 8); g.lineTo(x + 4, 8); g.closePath(); g.fill(); }
  }
  // scale
  g.fillStyle = col.fg; g.font = '10px sans-serif'; g.textAlign = 'right';
  g.fillText(key === 'mem' ? `${Math.round(maxY)}` : '100', w - 3, 10);
  // hover line
  if (DG.hoverT != null) { const x = X(DG.hoverT); g.strokeStyle = col.hover; g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
  return { X };
}
function dgNiceMax(mb) { const steps = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]; return steps.find((x) => x >= mb * 1.15) || mb * 1.2; }

function dgRenderCharts() {
  const s = DG.s;
  const st = s ? dgStats(s) : null;
  dgLine('#dgMem', 'mem', dgNiceMax(st ? dgMB(st.memPeak) : 0), dgColors().mem);
  dgLine('#dgCpu', 'cpu', 100, dgColors().cpu);
  // events lane
  const { g, w, h } = dgCanvas('#dgEvents');
  const col = dgColors();
  const span = dgSpan();
  const X = (t) => (t / span) * (w - 2) + 1;
  if (s) {
    dgShadeBreaks(g, w, h, X, col);
    for (const e of s.events) {
      const x = X(e.t);
      if (e.kind === 'output') { g.fillStyle = e.category === 'stderr' ? 'rgba(241,76,76,.7)' : 'rgba(150,150,150,.6)'; g.fillRect(Math.round(x), h - 7, 1, 6); continue; }
      const c = { break: '#3794ff', exception: '#f14c4c', process: '#73c991' }[e.kind] || '#999';
      const r = e === DG.selected ? 6 : 4.5;
      g.fillStyle = c; g.beginPath(); g.moveTo(x, h / 2 - r); g.lineTo(x + r, h / 2); g.lineTo(x, h / 2 + r); g.lineTo(x - r, h / 2); g.closePath(); g.fill();
    }
    if (DG.hoverT != null) { const x = X(DG.hoverT); g.strokeStyle = col.hover; g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
  }
  // axis + header numbers
  $('#dgAxis').innerHTML = s ? [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="left:${f * 100}%">${dgFmtTime(span * f).replace(/\.\d$/, '')}</span>`).join('') : '';
  $('#dgMemNow').textContent = st && s.samples.length ? dgFmtMB(st.memNow) : '';
  $('#dgCpuNow').textContent = st && s.samples.length ? `${st.cpuNow.toFixed(0)}%` : '';
  $('#dgTitle').textContent = !s ? 'Diagnostic Tools' : `${s.kind === 'profile' ? 'Profiling' : 'Diagnostics session'}: ${dgFmtTime(dgNow()).replace(/\.\d$/, '')}${s.ended ? ' (ended)' : ''}`;
  $('#dgStop').classList.toggle('hidden', !s || s.ended || s.kind !== 'profile');
  $('#dgSnapshot').disabled = !dgCanSnapshot(s);
}

// hover: one vertical line through all three charts + a tooltip
function dgHover(e) {
  const s = DG.s;
  if (!s || !s.samples.length) return;
  const c = e.currentTarget;
  const r = c.getBoundingClientRect();
  const t = ((e.clientX - r.left - 1) / (r.width - 2)) * dgSpan();
  DG.hoverT = Math.max(0, Math.min(t, dgNow()));
  const near = s.samples.reduce((a, x) => (Math.abs(x.t - DG.hoverT) < Math.abs(a.t - DG.hoverT) ? x : a), s.samples[0]);
  const ev = s.events.filter((x) => x.kind !== 'output').reduce((a, x) => (Math.abs(x.t - DG.hoverT) < (a ? Math.abs(a.t - DG.hoverT) : Infinity) ? x : a), null);
  const pxPerMs = (r.width - 2) / dgSpan();
  const inBreak = s.breaks.some(([a, b]) => DG.hoverT >= a && DG.hoverT <= (b == null ? dgNow() : b));
  const tip = $('#dgTip');
  tip.innerHTML = '';
  tip.append(h('div', {}, h('b', {}, dgFmtTime(near.t)), inBreak ? ' · paused in the debugger' : ''), h('div', {}, `Memory: ${dgFmtMB(near.mem)}`), h('div', {}, `CPU: ${near.cpu.toFixed(1)}%`));
  if (ev && Math.abs(ev.t - DG.hoverT) * pxPerMs < 6) tip.append(h('div', { class: 'dg-tip-ev' }, ev.text));
  tip.classList.remove('hidden');
  const host = $('#dgCharts').getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - host.left + 10, host.width - 170)}px`;
  tip.style.top = `${e.clientY - host.top + 12}px`;
  dgRenderCharts();
}
function dgLeave() { DG.hoverT = null; $('#dgTip').classList.add('hidden'); dgRenderCharts(); }
for (const id of ['#dgEvents', '#dgMem', '#dgCpu']) { $(id).addEventListener('mousemove', dgHover); $(id).addEventListener('mouseleave', dgLeave); }
// clicking a diamond in the events lane selects that event
$('#dgEvents').addEventListener('click', (e) => {
  const s = DG.s;
  if (!s) return;
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left - 1) / (r.width - 2)) * dgSpan();
  const ev = s.events.filter((x) => x.kind !== 'output').reduce((a, x) => (Math.abs(x.t - t) < (a ? Math.abs(a.t - t) : Infinity) ? x : a), null);
  if (ev && Math.abs(ev.t - t) * ((r.width - 2) / dgSpan()) < 8) { DG.selected = ev; DG.tab = 'events'; dgRender(); }
});

// ---------------- tabs ----------------
function dgRenderBody() {
  const body = $('#dgBody');
  const s = DG.s;
  $$('#dgTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === DG.tab));
  body.innerHTML = '';
  if (!s) {
    body.append(h('div', { class: 'dg-empty' },
      h('p', {}, 'Start debugging (F5) to see the events, memory and CPU of your program here.'),
      h('p', {}, 'Or use Debug › Performance Profiler (Alt+F2) to measure it without the debugger.')));
    return;
  }
  if (s.error) body.appendChild(h('div', { class: 'dg-error' }, `Could not collect CPU and memory: ${s.error}`));
  const st = dgStats(s);
  if (DG.tab === 'summary') {
    const link = (label, tab) => { const a = h('a', { href: '#' }, label); a.onclick = (e) => { e.preventDefault(); DG.tab = tab; dgRenderBody(); }; return a; };
    body.append(
      h('div', { class: 'dg-sec' }, h('div', { class: 'dg-sec-title' }, s.kind === 'profile' ? `Performance report: ${s.name}` : `Debugging: ${s.name}`),
        h('div', {}, `Duration ${dgFmtTime(st.duration)}${s.ended ? '' : ' (recording)'}${s.exitCode != null ? ` · exit code ${s.exitCode}` : ''}`),
        s.names && s.names.length ? h('div', { class: 'dlg-desc' }, `Processes: ${s.names.join(', ')}`) : null),
      h('div', { class: 'dg-sec' }, h('div', { class: 'dg-sec-title' }, 'Events'),
        h('div', {}, link(`Show Events (${s.events.length})`, 'events')),
        h('div', { class: 'dlg-desc' }, `${st.breaks} break${st.breaks === 1 ? '' : 's'} · ${st.exceptions} exception${st.exceptions === 1 ? '' : 's'} · ${st.outputs} output line${st.outputs === 1 ? '' : 's'}`)),
      h('div', { class: 'dg-sec' }, h('div', { class: 'dg-sec-title' }, 'Memory Usage'),
        h('div', { class: 'dg-kv' }, h('span', {}, 'Now'), h('b', { id: 'dgMemValue' }, dgFmtMB(st.memNow)), h('span', {}, 'Peak'), h('b', { id: 'dgMemPeak' }, `${dgFmtMB(st.memPeak)}`), h('span', { class: 'dlg-desc' }, `at ${dgFmtTime(st.memPeakAt)}`)),
        (() => { const b = h('button', { id: 'dgSnapBtn' }, '📷 Take Snapshot'); b.disabled = !dgCanSnapshot(s); b.onclick = () => dgSnapshot(); return b; })(),
        s.snapshots.length ? h('span', { class: 'dlg-desc' }, '  ', link(`${s.snapshots.length} snapshot${s.snapshots.length === 1 ? '' : 's'}`, 'memory')) : null),
      h('div', { class: 'dg-sec' }, h('div', { class: 'dg-sec-title' }, 'CPU Usage'),
        h('div', { class: 'dg-kv' }, h('span', {}, 'Average'), h('b', { id: 'dgCpuAvg' }, `${st.cpuAvg.toFixed(1)}%`), h('span', {}, 'Peak'), h('b', { id: 'dgCpuPeak' }, `${st.cpuPeak.toFixed(1)}%`), h('span', { class: 'dlg-desc' }, `at ${dgFmtTime(st.cpuPeakAt)}`)),
        h('div', { class: 'dlg-desc' }, `% of all ${s.cpus} processors, while running (paused time left out)`)));
  } else if (DG.tab === 'events') {
    const list = s.events.slice().reverse();
    if (!list.length) body.appendChild(h('div', { class: 'dg-empty' }, 'No events yet.'));
    const table = h('div', { class: 'dg-events' });
    for (const e of list.slice(0, 1000)) {
      const ico = { break: '◆', exception: '⛔', process: '●', output: '›' }[e.kind] || '•';
      const row = h('div', { class: `dg-ev ev-${e.kind}${e === DG.selected ? ' selected' : ''}`, title: e.file ? `${e.file}:${e.line}` : e.text },
        h('span', { class: 'dg-ev-t' }, dgFmtTime(e.t)), h('span', { class: 'dg-ev-i' }, ico), h('span', { class: 'dg-ev-x' }, e.text),
        e.file ? h('span', { class: 'dlg-desc dg-ev-loc' }, `${baseName(e.file)}:${e.line}${e.frame ? ` · ${e.frame}` : ''}`) : null);
      row.onclick = () => { DG.selected = e; dgRenderCharts(); dgRenderBody(); if (e.file) openFile(e.file, e.line); };
      table.appendChild(row);
    }
    if (s.droppedOutput) table.appendChild(h('div', { class: 'dlg-desc' }, `+${s.droppedOutput} more output lines not listed`));
    body.appendChild(table);
  } else if (DG.tab === 'memory') {
    const b = h('button', { id: 'dgSnapBtn2' }, '📷 Take Snapshot');
    b.disabled = !dgCanSnapshot(s);
    b.onclick = () => dgSnapshot();
    body.append(h('div', { class: 'dg-row' }, b, h('span', { class: 'dlg-desc' }, s.dotnet ? '  Process memory and the .NET heap (live objects by type).' : '  Process memory at a moment; compare snapshots to see growth.')));
    const heapCols = s.dotnet || s.snapshots.some((x) => x.heap || x.heapPending);
    const diffCell = (v, fmt) => h('td', { class: !v ? 'dlg-desc' : v > 0 ? 'dg-up' : 'dg-down' }, v == null ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}${v > 0 ? ' ▲' : v < 0 ? ' ▼' : ''}`);
    const t = h('table', { class: 'dg-table', id: 'dgSnapTable' }, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Time'), h('th', {}, 'Memory'), h('th', {}, 'Diff'), ...(heapCols ? [h('th', {}, 'Objects (Diff)'), h('th', {}, 'Heap Size (Diff)')] : [])));
    s.snapshots.forEach((sn, i) => {
      const prev = s.snapshots[i - 1];
      const diff = prev ? sn.mem - prev.mem : null;
      const cells = [h('td', {}, String(i + 1)), h('td', {}, dgFmtTime(sn.t)), h('td', {}, dgFmtMB(sn.mem)), diffCell(diff, dgFmtMB)];
      if (heapCols) {
        if (sn.heapPending) cells.push(h('td', { colspan: '2', class: 'dlg-desc' }, 'Collecting heap...'));
        else if (sn.heap) {
          // compare with the previous snapshot that has a heap
          let pi = i - 1;
          while (pi >= 0 && !s.snapshots[pi].heap) pi--;
          const ph = pi >= 0 ? s.snapshots[pi].heap : null;
          const objs = h('a', { href: '#', class: 'dg-heap-link', title: 'View the objects of this snapshot' }, sn.heap.objects.toLocaleString());
          objs.onclick = (e) => { e.preventDefault(); hsShow(s, i, 'count'); };
          const size = h('a', { href: '#', class: 'dg-heap-link', title: 'View the objects of this snapshot' }, dgFmtKB(sn.heap.bytes));
          size.onclick = (e) => { e.preventDefault(); hsShow(s, i, 'bytes'); };
          const od = ph ? sn.heap.objects - ph.objects : null, bd = ph ? sn.heap.bytes - ph.bytes : null;
          cells.push(h('td', {}, objs, od == null ? '' : h('span', { class: od > 0 ? 'dg-up' : od < 0 ? 'dg-down' : 'dlg-desc' }, ` (${od > 0 ? '+' : od < 0 ? '−' : ''}${Math.abs(od).toLocaleString()})`)),
            h('td', {}, size, bd == null ? '' : h('span', { class: bd > 0 ? 'dg-up' : bd < 0 ? 'dg-down' : 'dlg-desc' }, ` (${bd > 0 ? '+' : bd < 0 ? '−' : ''}${dgFmtKB(Math.abs(bd))})`)));
        } else cells.push(h('td', { colspan: '2', class: 'dlg-desc', title: sn.heapError || '' }, sn.heapError ? `No heap: ${sn.heapError}` : ''));
      }
      t.appendChild(h('tr', { 'data-snap': String(i + 1) }, ...cells));
    });
    body.appendChild(t);
    if (!s.snapshots.length) body.appendChild(h('div', { class: 'dg-empty' }, 'No snapshots yet.'));
    else if (heapCols) body.appendChild(h('div', { class: 'dlg-desc' }, 'Click the objects or the heap size to see the types.'));
  } else {
    body.append(h('div', { class: 'dg-kv' }, h('span', {}, 'Average'), h('b', {}, `${st.cpuAvg.toFixed(1)}%`), h('span', {}, 'Peak'), h('b', {}, `${st.cpuPeak.toFixed(1)}%`)),
      h('div', { class: 'dlg-desc' }, `% of all ${s.cpus} processors. Paused time is shaded in the charts and left out of the average.`),
      h('div', { class: 'dg-sec-title' }, 'Busiest moments'));
    const top = dgRunningSamples(s).slice(1).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    const t = h('table', { class: 'dg-table', id: 'dgCpuTable' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'CPU'), h('th', {}, 'Memory')));
    for (const x of top) {
      const tr = h('tr', { class: 'link' }, h('td', {}, dgFmtTime(x.t)), h('td', {}, `${x.cpu.toFixed(1)}%`), h('td', {}, dgFmtMB(x.mem)));
      tr.onmouseenter = () => { DG.hoverT = x.t; dgRenderCharts(); };
      tr.onmouseleave = () => { DG.hoverT = null; dgRenderCharts(); };
      t.appendChild(tr);
    }
    body.appendChild(t);
  }
}
function dgRender() { dgRenderCharts(); dgRenderBody(); }

const dgFmtKB = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
function dgCanSnapshot(s) { return !!s && !s.ended && s.samples.length > 0 && !s.snapshots.some((x) => x.heapPending); }
async function dgSnapshot() {
  const s = DG.s;
  if (!dgCanSnapshot(s)) return;
  const last = s.samples[s.samples.length - 1];
  const sn = { t: dgNow(), mem: last.mem };
  s.snapshots.push(sn);
  const n = s.snapshots.length;
  dgEvent('process', `Snapshot ${n}: ${dgFmtMB(last.mem)}`);
  status(`Snapshot ${n}: ${dgFmtMB(last.mem)}`);
  if (s.dotnet) {
    if (s.kind === 'debug' && DBG.stopped) sn.heapError = 'paused in the debugger (continue, then take a snapshot)';
    else {
      sn.heapPending = true;
      dgRender();
      const r = await api.prof.heapSnapshot({ profId: s.profId, diagId: s.id });
      sn.heapPending = false;
      if (r.error) sn.heapError = r.error;
      else {
        sn.heap = r;
        status(`Snapshot ${n}: ${r.objects.toLocaleString()} objects, ${dgFmtKB(r.bytes)} heap`);
      }
    }
  }
  dgRender();
  return sn;
}

// ---------------- wiring ----------------
$$('#dgTabs button').forEach((b) => b.addEventListener('click', () => { DG.tab = b.dataset.tab; dgRenderBody(); }));
$('#dgSnapshot').onclick = () => dgSnapshot();
$('#dgStop').onclick = () => { if (DG.s && DG.s.kind === 'profile') stop(); };
$('#dgProfile').onclick = () => dgProfile();
// redraw on resize and while recording (the time axis moves)
new ResizeObserver(() => dgRenderCharts()).observe($('#dgCharts'));
setInterval(() => { if (DG.s && !DG.s.ended && $('#side-diag').classList.contains('active')) dgRenderCharts(); }, 1000);

Object.assign(commands, {
  showDiagnostics: () => { showSide('diag'); dgRender(); },
  performanceProfiler: () => dgProfile(),
  diagSnapshot: () => dgSnapshot()
});
bus.on('ready', () => dgRender());
bus.on('folder', () => { if (DG.s && DG.s.ended) { DG.s = null; dgRender(); } });

window.DG = DG;
window.dgStats = dgStats;
