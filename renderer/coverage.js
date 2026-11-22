// Nova IDE - code coverage: "Code Coverage Results" window, line coloring in the editor, status bar
'use strict';

const COV = {
  data: null,            // { totals, tree, files: [{file, lines: [[n, hits, bc, bt]]}], info }
  byFile: new Map(),     // normPathKey(file) -> lines
  coloring: load('coverageColoring', true),
  stale: false,
  expanded: new Set(),
  selected: null,
  decos: new Map()       // model uri -> decoration ids
};

const pct = (c, t) => (t ? (c / t) * 100 : null);
const fmtPct = (c, t) => { const p = pct(c, t); if (p == null) return '—'; const r = Math.floor(p * 10 + 1e-9) / 10; return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}%`; };
const covLevel = (c, t) => { const p = pct(c, t); return p == null ? 'none' : p >= 80 ? 'good' : p >= 50 ? 'ok' : 'bad'; };

function setCoverage(data) {
  COV.data = data;
  COV.stale = false;
  COV.byFile = new Map((data ? data.files : []).map((f) => [normPathKey(f.file), f.lines]));
  COV.selected = null;
  if (data) {
    COV.expanded = new Set();
    // open modules and namespaces so classes show
    for (const m of data.tree) { COV.expanded.add(`m:${m.name}`); for (const n of m.children) if (n.kind === 'namespace') COV.expanded.add(`n:${m.name}|${n.name}`); }
  }
  renderCoverage();
  applyCoverageAll();
  renderCovStatus();
}

// ---------------- editor coloring ----------------
function linesForModel(model) {
  if (!COV.data || model.uri.scheme !== 'file') return null;
  return COV.byFile.get(normPathKey(model.uri.fsPath)) || null;
}

function applyCoverage(model) {
  if (!model || model.isDisposed()) return;
  const key = model.uri.toString();
  const lines = COV.coloring ? linesForModel(model) : null;
  const decos = [];
  if (lines) {
    const max = model.getLineCount();
    const lane = monacoRef.editor.OverviewRulerLane.Left;
    for (const [n, hits, bc, bt] of lines) {
      if (n < 1 || n > max) continue;
      const kind = hits === 0 ? 'uncovered' : bt && bc < bt ? 'partial' : 'covered';
      const hover = kind === 'partial' ? `Partially covered: ${bc} of ${bt} branches taken` : kind === 'uncovered' ? 'Not covered by any test' : `Covered (run ${hits} time${hits === 1 ? '' : 's'})${bt ? `, all ${bt} branches taken` : ''}`;
      decos.push({
        range: new monacoRef.Range(n, 1, n, 1),
        options: {
          isWholeLine: true,
          className: `cov-line cov-${kind}`,
          linesDecorationsClassName: `cov-bar cov-bar-${kind}`,
          linesDecorationsTooltip: hover,
          overviewRuler: { color: { covered: '#4f8cc9aa', partial: '#dbab09cc', uncovered: '#e5534bcc' }[kind], position: lane },
          stickiness: monacoRef.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      });
    }
  }
  COV.decos.set(key, model.deltaDecorations(COV.decos.get(key) || [], decos));
}
function applyCoverageAll() { if (typeof monacoRef !== 'undefined' && monacoRef) for (const m of monacoRef.editor.getModels()) applyCoverage(m); }

// ---------------- results window ----------------
function covRow(host, { key, depth, node, expandable, icon }) {
  const tr = document.createElement('tr');
  tr.className = `cov-row${COV.selected === key ? ' selected' : ''}`;
  tr.dataset.key = key;
  const open = expandable && COV.expanded.has(key);
  const notCovered = node.total - node.covered;
  const lvl = covLevel(node.covered, node.total);
  tr.innerHTML = `<td class="cov-name"><span class="chev">${expandable ? (open ? '▾' : '▸') : ''}</span><span class="cov-ico">${icon}</span><span class="label"></span></td>`
    + `<td class="num">${node.covered}</td><td class="num">${notCovered}</td>`
    + `<td class="num"><span class="cov-pct cov-${lvl}">${fmtPct(node.covered, node.total)}</span><span class="cov-meter"><i class="cov-${lvl}" style="width:${node.total ? (node.covered / node.total) * 100 : 0}%"></i></span></td>`
    + `<td class="num">${node.bt ? `${fmtPct(node.bc, node.bt)} <span class="dlg-desc">(${node.bc}/${node.bt})</span>` : '—'}</td>`;
  tr.firstChild.style.paddingLeft = `${4 + depth * 16}px`;
  tr.querySelector('.label').textContent = node.name;
  if (node.file) tr.title = `${node.full || node.name}\n${node.file}${node.line ? `:${node.line}` : ''}`;
  const toggle = () => { if (COV.expanded.has(key)) COV.expanded.delete(key); else COV.expanded.add(key); };
  tr.onclick = (e) => {
    COV.selected = key;
    if (expandable && e.target.classList.contains('chev')) toggle();
    renderCoverage();
  };
  tr.ondblclick = (e) => {
    if (e.target.classList.contains('chev')) return;
    if (node.file) openFile(node.file, node.line || 1);
    else if (expandable) { toggle(); renderCoverage(); }
  };
  host.appendChild(tr);
  return open;
}

function renderCoverage() {
  const body = $('#covBody');
  if (!body) return;
  body.innerHTML = '';
  const sum = $('#covSummary');
  const d = COV.data;
  $('#covColor').classList.toggle('on', COV.coloring);
  $('#covColor').title = COV.coloring ? 'Hide Code Coverage Coloring' : 'Show Code Coverage Coloring';
  $('#covClear').disabled = !d;
  if (!d) {
    sum.textContent = 'No coverage results yet. Use Test > Analyze Code Coverage for All Tests, or import a Cobertura / LCOV file.';
    return;
  }
  const t = d.totals;
  const src = d.info.source ? `Imported ${baseName(d.info.source)}` : `${new Date(d.info.created).toLocaleTimeString()}`;
  sum.innerHTML = '';
  sum.append(...[
    h('b', { class: `cov-${covLevel(t.covered, t.total)}` }, `${fmtPct(t.covered, t.total)} lines`),
    ` (${t.covered} of ${t.total})`,
    t.bt ? h('span', {}, ` · ${fmtPct(t.bc, t.bt)} branches (${t.bc} of ${t.bt})`) : null,
    h('span', { class: 'dlg-desc' }, ` · ${src}`),
    COV.stale ? h('span', { class: 'cov-stale', title: 'Files changed after this coverage was collected. Run the analysis again to update it.' }, ' · out of date') : null].filter(Boolean));
  const walk = (nodes, depth, parentKey) => {
    for (const n of nodes) {
      const key = `${n.kind[0]}:${parentKey ? `${parentKey}|` : ''}${n.name}`;
      const kids = n.children || [];
      const icon = { module: '📦', namespace: '{ }', class: '🟪', file: '📄', method: '◆' }[n.kind] || '';
      if (covRow(body, { key, depth, node: n, expandable: kids.length > 0, icon }) && kids.length) walk(kids, depth + 1, parentKey ? `${parentKey}|${n.name}` : n.name);
    }
  };
  walk(d.tree, 0, '');
}

function renderCovStatus() {
  const el = $('#stCov');
  const d = COV.data;
  el.classList.toggle('hidden', !d);
  if (!d) return;
  el.textContent = `Coverage ${fmtPct(d.totals.covered, d.totals.total)}`;
  el.className = `clickable cov-st-${covLevel(d.totals.covered, d.totals.total)}`;
}

// ---------------- running + importing ----------------
async function importCoverage(file) {
  if (!file) file = await api.openFilteredDialog('Import Coverage Results', [{ name: 'Coverage files (Cobertura XML, LCOV)', extensions: ['xml', 'info', 'lcov'] }, { name: 'All files', extensions: ['*'] }]);
  if (!file) return null;
  const r = await api.coverage.load(file, state.root);
  if (r.error) { status('Could not import coverage'); alert(r.error); return null; }
  setCoverage(r);
  showPanel('coverage');
  status(`Coverage imported: ${fmtPct(r.totals.covered, r.totals.total)} of lines covered`);
  return r;
}

// called by the Test Explorer when a coverage run ends
async function finishCoverageRun({ records, missing }) {
  if (records.length) {
    setCoverage(await api.coverage.summarize([records], {}));
    showPanel('coverage');
    if (missing.length) log(`No coverage was collected for: ${missing.map((p) => baseName(p)).join(', ')}\n`, 'stderr');
    return;
  }
  if (!missing.length) return;
  // nothing collected: the project needs a coverage collector
  const body = h('div', {},
    h('p', {}, 'No coverage data was collected. Test projects need a coverage collector; the usual one is the free coverlet.collector package.'),
    h('p', { class: 'dlg-desc' }, `Add coverlet.collector to ${missing.map((p) => baseName(p)).join(', ')} and run the analysis again?`));
  const dlg = makeDialog({
    title: 'Code Coverage',
    body,
    buttons: ['spacer',
      { label: 'Add coverlet.collector', primary: true, id: 'covAddCollector', onClick: async (close, btn) => {
        btn.disabled = true; btn.textContent = 'Adding...';
        for (const p of missing) {
          log(`\n------ Adding coverlet.collector to ${baseName(p)} ------\n`, 'info');
          const r = await api.nuget.install(p, 'coverlet.collector', '');
          log(`${(r.stdout || '') + (r.stderr || '')}\n`, r.ok ? null : 'stderr');
          if (!r.ok) { close(); status('Could not add coverlet.collector (see Output)'); showPanel('output'); return; }
        }
        close();
        if (window.refreshProject) for (const p of missing) await refreshProject(p).catch(() => {});
        commands.coverageAll();
      } },
      { label: 'Cancel', onClick: (close) => close() }]
  });
  return dlg;
}

// ---------------- wiring ----------------
$('#covColor').onclick = () => commands.coverageToggleColoring();
$('#covImport').onclick = () => importCoverage();
$('#covClear').onclick = () => commands.coverageClear();
$('#covRun').onclick = () => commands.coverageAll();
$('#stCov').onclick = () => commands.showCoverageResults();

Object.assign(commands, {
  coverageAll: () => {
    const projects = [...new Set(allTests().map((t) => t.project))];
    if (!projects.length) { status('No tests found. Open a solution with a test project first.'); return; }
    runNodes(projects.map((project) => ({ kind: 'project', key: `p:${project}`, project, tests: allTests().filter((t) => t.project === project) })), { coverage: true });
  },
  coverageSelected: () => (TX.selected ? runNodes([TX.selected], { coverage: true }) : commands.coverageAll()),
  coverageImport: () => importCoverage(),
  coverageClear: () => { setCoverage(null); status('Coverage results cleared'); },
  coverageToggleColoring: () => { COV.coloring = !COV.coloring; store('coverageColoring', COV.coloring); applyCoverageAll(); renderCoverage(); status(COV.coloring ? 'Code coverage coloring on' : 'Code coverage coloring off'); },
  showCoverageResults: () => { showPanel('coverage'); renderCoverage(); }
});

bus.on('tabOpened', (tab) => { if (tab.model) applyCoverage(tab.model); });
bus.on('saved', (tab) => { if (COV.data && !COV.stale && COV.byFile.has(normPathKey(tab.path))) { COV.stale = true; renderCoverage(); } });
bus.on('folder', () => setCoverage(null));
bus.on('ready', () => renderCoverage());

window.COV = COV;
window.setCoverage = setCoverage;
window.importCoverage = importCoverage;
window.finishCoverageRun = finishCoverageRun;
