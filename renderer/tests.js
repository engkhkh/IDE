// Nova IDE - Test Explorer: discover tests in .NET test projects, run/debug them, show results; CodeLens in the editor
'use strict';

const TX = {
  projects: [],          // test project paths
  tests: [],             // scanned test methods: { key, project, fqn, className, namespace, method, file, line, skip, data }
  results: new Map(),    // fqn -> [result] (several for theories / test cases)
  running: new Set(),    // fqns being run
  runId: null, queue: [], lastRun: null, debugging: false,
  filter: 'all', query: '', selected: null,
  expanded: new Set(load('testExpanded', [])),
  lensEmitter: null, totalMs: 0, runStarted: 0, buildFailed: false
};
const ICON = { passed: '✔', failed: '✖', skipped: '⊘', notrun: '○', running: '◌' };

// ---------------- discovery ----------------
const testProjects = () => (window.SOL && SOL.model ? SOL.model.items.filter((i) => i.type === 'project' && i.info && i.info.kind === 'test').map((p) => p.path) : []);
const projectOfFile = (file) => TX.projects.slice().sort((a, b) => b.length - a.length).find((p) => normPathKey(file).startsWith(normPathKey(dirName(p)) + '\\'));

async function discover() {
  TX.projects = testProjects();
  if (!TX.projects.length) { TX.tests = []; render(); return; }
  const byProject = await api.tests.scan(TX.projects);
  TX.tests = [];
  for (const [project, list] of Object.entries(byProject)) for (const t of list) TX.tests.push({ ...t, project, key: `${project}|${t.fqn}` });
  // first time: expand projects and classes so tests are visible
  for (const t of TX.tests) if (!TX.expanded.has(`seen:${t.project}`)) { TX.expanded.add(`p:${t.project}`); TX.expanded.add(`n:${t.project}|${t.namespace}`); TX.expanded.add(`c:${t.project}|${t.className}`); }
  for (const p of TX.projects) TX.expanded.add(`seen:${p}`);
  render();
  refreshLenses();
}
let discoverTimer = null;
const scheduleDiscover = () => { clearTimeout(discoverTimer); discoverTimer = setTimeout(discover, 500); };

// ---------------- status helpers ----------------
function statusOfFqn(fqn) {
  if (TX.running.has(fqn)) return 'running';
  const rs = TX.results.get(fqn);
  if (!rs || !rs.length) return 'notrun';
  if (rs.some((r) => r.outcome === 'failed')) return 'failed';
  if (rs.every((r) => r.outcome === 'skipped')) return 'skipped';
  return 'passed';
}
function aggregate(statuses) {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.length && statuses.every((s) => s === 'passed' || s === 'skipped') && statuses.includes('passed')) return 'passed';
  if (statuses.length && statuses.every((s) => s === 'skipped')) return 'skipped';
  return 'notrun';
}
const durationOf = (fqn) => (TX.results.get(fqn) || []).reduce((a, r) => a + (r.duration || 0), 0);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// all tests to show: scanned ones plus any that only appeared in results (e.g. generated tests)
function allTests() {
  const list = TX.tests.slice();
  const known = new Set(list.map((t) => t.fqn));
  for (const [fqn, rs] of TX.results) {
    if (known.has(fqn) || !rs.length) continue;
    const r = rs[0];
    const project = TX.projects.find((p) => r.source && normPathKey(r.source).includes(normPathKey(baseName(p).replace(/\.\w+$/, '')))) || TX.projects[0] || 'Tests';
    const ns = r.className.includes('.') ? r.className.slice(0, r.className.lastIndexOf('.')) : '';
    list.push({ key: `${project}|${fqn}`, project, fqn, className: r.className, namespace: ns, method: r.method.replace(/\(.*$/, ''), file: null, line: null });
    known.add(fqn);
  }
  return list;
}

// ---------------- tree ----------------
function buildTree() {
  const tests = allTests();
  const projects = new Map();
  for (const t of tests) {
    if (!projects.has(t.project)) projects.set(t.project, new Map());
    const nss = projects.get(t.project);
    const ns = t.namespace || '(global)';
    if (!nss.has(ns)) nss.set(ns, new Map());
    const classes = nss.get(ns);
    const cls = t.className.slice(t.namespace ? t.namespace.length + 1 : 0) || t.className;
    if (!classes.has(cls)) classes.set(cls, []);
    classes.get(cls).push(t);
  }
  return projects;
}

function matchesFilter(t) {
  const st = statusOfFqn(t.fqn);
  if (TX.filter !== 'all' && !(TX.filter === st || (TX.filter === 'notrun' && st === 'running'))) return false;
  if (TX.query && !t.fqn.toLowerCase().includes(TX.query.toLowerCase())) return false;
  return true;
}

function row(host, { key, depth, icon, status, label, dur, expandable, node, title }) {
  const r = document.createElement('div');
  r.className = `tx-row${TX.selected && TX.selected.key === key ? ' selected' : ''}`;
  r.style.paddingLeft = `${6 + depth * 14}px`;
  r.dataset.key = key;
  const open = expandable && TX.expanded.has(key);
  r.innerHTML = `<span class="chev">${expandable ? (open ? '▾' : '▸') : ''}</span><span class="tx-st tx-${status}">${ICON[status]}</span><span class="tx-ico">${icon || ''}</span><span class="label"></span><span class="tx-dur"></span>`;
  r.querySelector('.label').textContent = label;
  r.querySelector('.tx-dur').textContent = dur ? fmtMs(dur) : '';
  if (title) r.title = title;
  r.onclick = (e) => {
    TX.selected = node;
    if (expandable && (e.target.classList.contains('chev') || e.detail === 2 || node.kind !== 'test')) {
      if (TX.expanded.has(key)) TX.expanded.delete(key); else TX.expanded.add(key);
      store('testExpanded', [...TX.expanded].slice(-500));
    }
    render();
  };
  r.ondblclick = () => { if (node.test && node.test.file) openFile(node.test.file, node.test.line); };
  r.oncontextmenu = (e) => {
    e.preventDefault();
    TX.selected = node; render();
    const items = [{ label: 'Run', run: () => runNodes([node]) }, { label: 'Debug', run: () => runNodes([node], { debug: true }) }, { label: 'Analyze Code Coverage', run: () => runNodes([node], { coverage: true }) }];
    if (node.test && node.test.file) items.push('-', { label: 'Go To Test', run: () => openFile(node.test.file, node.test.line) });
    popup(e.clientX, e.clientY, items);
  };
  host.appendChild(r);
  return open;
}

function render() {
  const host = $('#txTree');
  if (!host) return;
  host.innerHTML = '';
  const tree = buildTree();
  if (!tree.size) {
    host.appendChild(h('div', { class: 'git-empty' }, window.SOL && SOL.model ? 'No test projects found. Create one with File > New > Project (xUnit, NUnit or MSTest Test Project).' : 'Open a solution with a test project to see its tests.'));
  }
  for (const [project, nss] of tree) {
    const projTests = [...nss.values()].flatMap((c) => [...c.values()].flat());
    const visible = projTests.filter(matchesFilter);
    if (!visible.length && (TX.filter !== 'all' || TX.query)) continue;
    const pKey = `p:${project}`;
    const pOpen = row(host, { key: pKey, depth: 0, icon: '🧪', status: aggregate(projTests.map((t) => statusOfFqn(t.fqn))), label: `${baseName(project).replace(/\.\w+$/, '')} (${projTests.length})`, dur: projTests.reduce((a, t) => a + durationOf(t.fqn), 0), expandable: true, node: { kind: 'project', key: pKey, project, tests: projTests }, title: project });
    if (!pOpen) continue;
    for (const [ns, classes] of [...nss].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nsTests = [...classes.values()].flat();
      if (!nsTests.some(matchesFilter)) continue;
      const nKey = `n:${project}|${ns}`;
      const nOpen = row(host, { key: nKey, depth: 1, icon: '{ }', status: aggregate(nsTests.map((t) => statusOfFqn(t.fqn))), label: ns, dur: nsTests.reduce((a, t) => a + durationOf(t.fqn), 0), expandable: true, node: { kind: 'namespace', key: nKey, project, namespace: ns === '(global)' ? '' : ns, tests: nsTests } });
      if (!nOpen) continue;
      for (const [cls, tests] of [...classes].sort((a, b) => a[0].localeCompare(b[0]))) {
        const shown = tests.filter(matchesFilter);
        if (!shown.length) continue;
        const cKey = `c:${project}|${tests[0].className}`;
        const cOpen = row(host, { key: cKey, depth: 2, icon: '🟪', status: aggregate(tests.map((t) => statusOfFqn(t.fqn))), label: cls, dur: tests.reduce((a, t) => a + durationOf(t.fqn), 0), expandable: true, node: { kind: 'class', key: cKey, project, className: tests[0].className, tests } });
        if (!cOpen) continue;
        for (const t of shown.sort((a, b) => (a.line || 0) - (b.line || 0) || a.method.localeCompare(b.method))) {
          const rs = TX.results.get(t.fqn) || [];
          const multi = rs.length > 1 || (t.data && rs.length > 0);
          const tKey = `t:${t.key}`;
          const tOpen = row(host, { key: tKey, depth: 3, icon: '', status: statusOfFqn(t.fqn), label: t.method, dur: durationOf(t.fqn), expandable: multi, node: { kind: 'test', key: tKey, project, test: t, tests: [t] }, title: t.fqn });
          if (tOpen && multi) {
            for (const r of rs) {
              const rKey = `r:${t.key}|${r.name}`;
              row(host, { key: rKey, depth: 4, status: TX.running.has(t.fqn) ? 'running' : r.outcome, label: r.name.slice(r.name.lastIndexOf('.', r.name.indexOf('(') >= 0 ? r.name.indexOf('(') : r.name.length) + 1), dur: r.duration, expandable: false, node: { kind: 'row', key: rKey, project, test: t, tests: [t], result: r } });
            }
          }
        }
      }
    }
  }
  renderSummary();
  renderDetails();
}

function renderSummary() {
  const tests = allTests();
  const count = (st) => tests.filter((t) => statusOfFqn(t.fqn) === st).length;
  const total = tests.length;
  const p = count('passed'), f = count('failed'), s = count('skipped'), n = count('notrun'), r = count('running');
  const sum = $('#txSummary');
  sum.innerHTML = '';
  sum.append(
    h('span', { title: 'Tests' }, `🧪 ${total}`),
    h('span', { class: 'tx-passed', title: 'Passed' }, `${ICON.passed} ${p}`),
    h('span', { class: 'tx-failed', title: 'Failed' }, `${ICON.failed} ${f}`),
    h('span', { class: 'tx-skipped', title: 'Skipped' }, `${ICON.skipped} ${s}`),
    h('span', { class: 'tx-notrun', title: 'Not run' }, `${ICON.notrun} ${n + r}`),
    TX.totalMs ? h('span', { class: 'dlg-desc' }, fmtMs(TX.totalMs)) : null);
  const bar = $('#txBar');
  const done = p + f + s;
  bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  bar.className = f ? 'failed' : p ? 'passed' : '';
  bar.parentElement.classList.toggle('running', !!TX.runId);
  const badge = $('#testCount');
  badge.textContent = f;
  badge.classList.toggle('hidden', !f);
  for (const id of ['#txRunAll', '#txRun', '#txRunFailed', '#txDebug', '#txCover']) $(id).disabled = !!TX.runId || !total;
  $('#txRunFailed').disabled = !!TX.runId || !f;
  $('#txCancel').disabled = !TX.runId;
}

function renderDetails() {
  const host = $('#txDetails');
  host.innerHTML = '';
  const node = TX.selected;
  if (!node) { host.appendChild(h('div', { class: 'git-empty' }, 'Select a test to see its result.')); return; }
  const t = node.test;
  if (!t) {
    const st = (node.tests || []).map((x) => statusOfFqn(x.fqn));
    host.append(h('div', { class: 'tx-dtitle' }, node.kind === 'project' ? baseName(node.project) : node.namespace || node.className || ''),
      h('div', { class: 'dlg-desc' }, `${node.tests.length} tests · ${st.filter((x) => x === 'passed').length} passed · ${st.filter((x) => x === 'failed').length} failed · ${st.filter((x) => x === 'skipped').length} skipped`));
    return;
  }
  const rs = node.result ? [node.result] : (TX.results.get(t.fqn) || []);
  const status = node.result ? node.result.outcome : statusOfFqn(t.fqn);
  host.append(h('div', { class: 'tx-dtitle' }, h('span', { class: `tx-st tx-${status}` }, ICON[status]), ` ${node.result ? node.result.name.slice(node.result.name.lastIndexOf('.', node.result.name.indexOf('(') >= 0 ? node.result.name.indexOf('(') : node.result.name.length) + 1) : t.method}`));
  const meta = h('div', { class: 'dlg-desc' }, `${{ passed: 'Passed', failed: 'Failed', skipped: 'Skipped', notrun: 'Not run', running: 'Running...' }[status]}${rs.length ? ` · ${fmtMs(rs.reduce((a, r) => a + r.duration, 0))}` : ''}`);
  host.appendChild(meta);
  if (t.file) {
    const a = h('a', { href: '#', class: 'tx-link' }, `${baseName(t.file)}, line ${t.line}`);
    a.onclick = (e) => { e.preventDefault(); openFile(t.file, t.line); };
    host.appendChild(h('div', { class: 'tx-src' }, 'Source: ', a));
  }
  if (t.skip && !rs.length) host.appendChild(h('div', { class: 'tx-sec' }, h('b', {}, 'Skip reason'), h('pre', {}, t.skip)));
  for (const r of rs) {
    if (rs.length > 1) host.appendChild(h('div', { class: 'tx-sub' }, h('span', { class: `tx-st tx-${r.outcome}` }, ICON[r.outcome]), ` ${r.name.slice(r.name.indexOf('('))}  ${fmtMs(r.duration)}`));
    if (r.message) host.appendChild(h('div', { class: 'tx-sec' }, h('b', {}, 'Message'), h('pre', { class: r.outcome === 'failed' ? 'tx-err' : '' }, r.message)));
    if (r.stack) host.appendChild(h('div', { class: 'tx-sec' }, h('b', {}, 'Stack Trace'), stackView(r.stack)));
    if (r.stdout) host.appendChild(h('div', { class: 'tx-sec' }, h('b', {}, 'Standard Output'), h('pre', {}, r.stdout)));
  }
}

// stack trace lines like "at X.Y() in C:\src\Tests.cs:line 24" become links
function stackView(stack) {
  const pre = h('pre', { class: 'tx-stack' });
  for (const line of stack.split(/\r?\n/)) {
    const m = /^(.*\bin\s+)(.+?):line (\d+)\s*$/.exec(line);
    if (m) {
      const a = h('a', { href: '#', class: 'tx-link' }, `${m[2]}:line ${m[3]}`);
      a.onclick = (e) => { e.preventDefault(); openFile(m[2], +m[3]); };
      pre.append(m[1], a, '\n');
    } else pre.append(`${line}\n`);
  }
  return pre;
}

// ---------------- running ----------------
const esc = (s) => s.replace(/[\\()&|=!~]/g, (c) => `\\${c}`);
function filtersFor(node) {
  switch (node.kind) {
    case 'project': return [];
    case 'namespace': return node.namespace ? [`FullyQualifiedName~${esc(node.namespace)}.`] : node.tests.map((t) => `FullyQualifiedName=${esc(t.fqn)}`);
    case 'class': return [`FullyQualifiedName~${esc(node.className)}.`];
    default: return [`FullyQualifiedName=${esc(node.test.fqn)}`];
  }
}

// Run (or debug) tree nodes; one "dotnet test" per project
async function runNodes(nodes, { debug = false, coverage = false } = {}) {
  if (TX.runId) { status('Tests are already running'); return; }
  if (debug && window.DBG && DBG.root) { status('Stop debugging first (Shift+F5)'); return; }
  const byProject = new Map();
  for (const n of nodes) {
    if (!byProject.has(n.project)) byProject.set(n.project, { project: n.project, filters: [], all: false, tests: [] });
    const g = byProject.get(n.project);
    const f = filtersFor(n);
    if (!f.length) g.all = true; else g.filters.push(...f);
    g.tests.push(...n.tests);
  }
  TX.queue = [...byProject.values()].map((g) => ({ ...g, filters: g.all ? [] : [...new Set(g.filters)], debug, coverage: coverage && !debug }));
  if (!TX.queue.length) return;
  TX.lastRun = { nodes, debug, coverage };
  TX.cov = coverage ? { records: [], missing: [] } : null;
  TX.cancelled = false;
  TX.totalMs = 0;
  TX.runStarted = Date.now();
  await saveAll();
  showSide('tests');
  log(`\n------ ${debug ? 'Debugging' : coverage ? 'Analyzing code coverage for' : 'Running'} tests: ${new Date().toLocaleTimeString()} ------\n`, 'info');
  nextInQueue();
}

async function nextInQueue() {
  const job = TX.queue.shift();
  if (!job) { TX.runId = null; TX.totalMs = Date.now() - TX.runStarted; finishRun(); return; }
  for (const t of job.tests) TX.running.add(t.fqn);
  render();
  status(`${job.debug ? 'Debugging' : job.coverage ? 'Analyzing code coverage for' : 'Running'} tests in ${baseName(job.project).replace(/\.\w+$/, '')}...`);
  TX.currentJob = job;
  TX.early = [];   // messages that arrive before we know the run id
  TX.starting = true;
  const r = await api.tests.run({ target: job.project, filters: job.filters, debug: job.debug, coverage: job.coverage, root: state.root, cwd: dirName(job.project) });
  TX.runId = r.id;
  TX.starting = false;
  renderSummary();
  for (const [ch, msg] of TX.early.splice(0)) if (msg.id === r.id) handlers[ch](msg);
}

const handlers = {};
const early = (ch, fn) => { handlers[ch] = fn; api.on(ch, (msg) => { if (TX.starting && msg.id !== TX.runId) TX.early.push([ch, msg]); else fn(msg); }); };
early('tests:output', ({ id, text }) => { if (id === TX.runId) log(text); });
early('tests:debugReady', async ({ id, pid }) => {
  if (id !== TX.runId) return;
  status(`Attaching the debugger to the test host (process ${pid})...`);
  const ok = await window.debugAttach({ pid, name: 'Tests', cwd: TX.currentJob ? dirName(TX.currentJob.project) : state.root });
  if (!ok) { api.tests.cancel(id); log('Could not attach the debugger; the test run was cancelled.\n', 'stderr'); }
});
early('tests:done', ({ id, code, results, cancelled, coverage }) => {
  if (id !== TX.runId) return;
  const job = TX.currentJob;
  // results replace earlier ones for the tests that ran
  const ran = new Map();
  for (const r of results) { if (!ran.has(r.fqn)) ran.set(r.fqn, []); ran.get(r.fqn).push(r); }
  for (const [fqn, rs] of ran) TX.results.set(fqn, rs);
  for (const t of job.tests) TX.running.delete(t.fqn);
  if (!results.length && !cancelled && code !== 0) {
    TX.buildFailed = true;
    log('No test results: the build probably failed (see the errors above).\n', 'stderr');
    showPanel('output');
  }
  if (cancelled) { log('Test run cancelled.\n', 'info'); TX.cancelled = true; }
  if (TX.cov && coverage && !cancelled && results.length) {
    if (coverage.records.length) TX.cov.records.push(...coverage.records); else TX.cov.missing.push(job.project);
  }
  TX.runId = null;
  if (cancelled) { TX.queue = []; for (const t of allTests()) TX.running.delete(t.fqn); }
  nextInQueue();
});

function finishRun() {
  render();
  refreshLenses();
  const tests = allTests();
  const f = tests.filter((t) => statusOfFqn(t.fqn) === 'failed').length;
  const p = tests.filter((t) => statusOfFqn(t.fqn) === 'passed').length;
  status(TX.buildFailed ? 'Test run failed: build errors' : `Test run finished: ${p} passed, ${f} failed (${fmtMs(TX.totalMs)})`);
  TX.buildFailed = false;
  if (TX.cov && !TX.cancelled && window.finishCoverageRun) { const cov = TX.cov; TX.cov = null; finishCoverageRun(cov); }
  // select the first failure, like Visual Studio
  if (f && (!TX.selected || statusOfFqn(TX.selected.test ? TX.selected.test.fqn : '') !== 'failed')) {
    const first = tests.find((t) => statusOfFqn(t.fqn) === 'failed');
    TX.selected = { kind: 'test', key: `t:${first.key}`, project: first.project, test: first, tests: [first] };
    TX.expanded.add(`p:${first.project}`); TX.expanded.add(`n:${first.project}|${first.namespace || '(global)'}`); TX.expanded.add(`c:${first.project}|${first.className}`);
    render();
  }
}

const allNodes = () => [...buildTree().keys()].map((project) => ({ kind: 'project', key: `p:${project}`, project, tests: allTests().filter((t) => t.project === project) }));

// "in context": the test at the cursor, else the tests in this file, else everything
async function contextNodes() {
  const tab = state.active;
  if (tab && /\.cs$/i.test(tab.path)) {
    const project = projectOfFile(tab.path);
    if (project) {
      const inFile = await api.tests.scanText(tab.model.getValue(), tab.path);
      if (inFile.length) {
        const line = editor.getPosition().lineNumber;
        const before = inFile.filter((t) => t.line <= line + 1).pop();
        const after = inFile.find((t) => t.line > line + 1);
        // inside a test method if the cursor is between this test and the next (or the class end)
        if (before && (after || line <= tab.model.getLineCount())) {
          const t = { ...before, project, key: `${project}|${before.fqn}` };
          return [{ kind: 'test', key: `t:${t.key}`, project, test: t, tests: [t] }];
        }
        const classes = [...new Set(inFile.map((t) => t.className))];
        return classes.map((c) => ({ kind: 'class', key: `c:${project}|${c}`, project, className: c, tests: inFile.filter((t) => t.className === c).map((t) => ({ ...t, project })) }));
      }
    }
  }
  return allNodes();
}

// ---------------- CodeLens above test methods ----------------
function refreshLenses() { if (TX.lensEmitter) TX.lensEmitter.fire(); }
bus.on('ready', () => {
  TX.lensEmitter = new monacoRef.Emitter();
  monacoRef.languages.registerCodeLensProvider('csharp', {
    onDidChange: TX.lensEmitter.event,
    async provideCodeLenses(model) {
      const file = model.uri.fsPath;
      const project = projectOfFile(file);
      if (!project) return { lenses: [], dispose() {} };
      const tests = await api.tests.scanText(model.getValue(), file);
      const lenses = [];
      for (const t of tests) {
        const st = statusOfFqn(t.fqn);
        const range = { startLineNumber: t.line, startColumn: 1, endLineNumber: t.line, endColumn: 1 };
        const label = { passed: `${ICON.passed} Passed`, failed: `${ICON.failed} Failed`, skipped: `${ICON.skipped} Skipped`, running: `${ICON.running} Running`, notrun: `${ICON.notrun} Not run` }[st];
        const dur = durationOf(t.fqn);
        lenses.push({ range, command: { id: 'nova.test.show', title: `${label}${dur && st !== 'running' ? ` (${fmtMs(dur)})` : ''}`, arguments: [project, t.fqn] } });
        lenses.push({ range, command: { id: 'nova.test.run', title: 'Run', arguments: [project, t.fqn] } });
        lenses.push({ range, command: { id: 'nova.test.debug', title: 'Debug', arguments: [project, t.fqn] } });
      }
      return { lenses, dispose() {} };
    },
    resolveCodeLens: (_m, lens) => lens
  });
  const nodeFor = (project, fqn) => { const t = allTests().find((x) => x.fqn === fqn && x.project === project) || { fqn, project, method: fqn.split('.').pop(), className: fqn.slice(0, fqn.lastIndexOf('.')), key: `${project}|${fqn}` }; return { kind: 'test', key: `t:${t.key}`, project, test: t, tests: [t] }; };
  monacoRef.editor.registerCommand('nova.test.run', (_a, project, fqn) => runNodes([nodeFor(project, fqn)]));
  monacoRef.editor.registerCommand('nova.test.debug', (_a, project, fqn) => runNodes([nodeFor(project, fqn)], { debug: true }));
  monacoRef.editor.registerCommand('nova.test.show', (_a, project, fqn) => { TX.selected = nodeFor(project, fqn); showSide('tests'); render(); });
});

// drag the divider between the tree and the details pane
dragSplitter($('.tx-split'), (e) => {
  const panel = $('#side-tests').getBoundingClientRect();
  $('#txDetails').style.height = `${Math.max(60, Math.min(panel.bottom - e.clientY, panel.height - 140))}px`;
});

// ---------------- toolbar + commands ----------------
$('#txRunAll').onclick = () => commands.testRunAll();
$('#txRun').onclick = () => (TX.selected ? runNodes([TX.selected]) : commands.testRunAll());
$('#txRunFailed').onclick = () => commands.testRunFailed();
$('#txDebug').onclick = () => (TX.selected ? runNodes([TX.selected], { debug: true }) : status('Select a test to debug'));
$('#txCancel').onclick = () => commands.testCancel();
$('#txCover').onclick = () => commands.coverageSelected();
$('#txRefresh').onclick = () => discover();
$('#txFilter').onchange = (e) => { TX.filter = e.target.value; render(); };
$('#txSearch').oninput = (e) => { TX.query = e.target.value.trim(); render(); };

Object.assign(commands, {
  showTestExplorer: () => { showSide('tests'); discover(); },
  testRunAll: () => runNodes(allNodes()),
  testRunFailed: () => {
    const failed = allTests().filter((t) => statusOfFqn(t.fqn) === 'failed');
    if (!failed.length) return status('No failed tests');
    runNodes(failed.map((t) => ({ kind: 'test', key: `t:${t.key}`, project: t.project, test: t, tests: [t] })));
  },
  testRunContext: async () => runNodes(await contextNodes()),
  testDebugContext: async () => runNodes(await contextNodes(), { debug: true }),
  testRepeat: () => (TX.lastRun ? runNodes(TX.lastRun.nodes, { debug: TX.lastRun.debug, coverage: TX.lastRun.coverage }) : status('No previous test run')),
  testCancel: () => { if (TX.runId) api.tests.cancel(TX.runId); TX.queue = []; }
});

// ---------------- refresh triggers ----------------
bus.on('folder', () => { TX.results.clear(); TX.selected = null; TX.tests = []; render(); });
bus.on('solution', () => discover());
bus.on('saved', (tab) => { if (/\.cs$/i.test(tab.path) && projectOfFile(tab.path)) scheduleDiscover(); });
api.on('fs:changed', ({ paths }) => { if (paths.some((p) => /\.(cs|csproj)$/i.test(p))) scheduleDiscover(); });

window.TX = TX;
window.runNodes = runNodes;
window.discoverTests = discover;
