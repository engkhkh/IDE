// Nova IDE - renderer (UI logic)
'use strict';
const api = window.ide;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  root: null, project: null, tabs: [], active: null,
  runId: null, runKind: null, errors: [], fontSize: 14, theme: 'dark',
  expanded: new Set(), selectedPath: null, settings: {}
};

// Tiny event bus so feature modules (terminal.js, git.js, ...) can plug in.
// Events: 'ready', 'folder' (root), 'saved' (tab), 'tabs'
const bus = {
  handlers: {},
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
  async emit(ev, ...args) { for (const fn of this.handlers[ev] || []) { try { await fn(...args); } catch (e) { console.error(`[bus:${ev}]`, e); } } }
};
let editor = null;
let monacoRef = null;

const LANGS = { js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
  json:'json', html:'html', htm:'html', css:'css', scss:'scss', less:'less', md:'markdown', cs:'csharp', csx:'csharp',
  csproj:'xml', fsproj:'xml', vbproj:'xml', props:'xml', targets:'xml', xml:'xml', xaml:'xml', config:'xml', resx:'xml',
  py:'python', java:'java', kt:'kotlin', dart:'dart', c:'c', h:'cpp', cpp:'cpp', hpp:'cpp', go:'go', rs:'rust',
  php:'php', rb:'ruby', sql:'sql', sh:'shell', ps1:'powershell', bat:'bat', cmd:'bat', yml:'yaml', yaml:'yaml',
  swift:'swift', vb:'vb', fs:'fsharp', razor:'razor', cshtml:'razor', ini:'ini' };
const ICONS = { cs:'🟪', csproj:'🧩', sln:'🧱', js:'🟨', ts:'🟦', json:'🔧', html:'🌐', css:'🎨', md:'📝', py:'🐍',
  dart:'🎯', xml:'📄', xaml:'🪟', png:'🖼️', jpg:'🖼️', svg:'🖼️' };

const sep = () => (state.root && state.root.includes('\\') ? '\\' : '/');
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
const ext = (p) => (baseName(p).includes('.') ? baseName(p).split('.').pop().toLowerCase() : '');
const langFor = (p) => LANGS[ext(p)] || 'plaintext';
const quote = (p) => `"${p}"`;

// Monaco cancels in-flight popups (hover, parameter hints) when you jump to another file; that is expected, not an error
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && (r.name === 'Canceled' || r.message === 'Canceled')) e.preventDefault();
});

function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function status(msg) { $('#stMsg').textContent = msg; }

// ---------------- Monaco ----------------
function bootMonaco() {
  return new Promise((resolve) => {
    const base = new URL('../node_modules/monaco-editor/min/', location.href).href;
    window.MonacoEnvironment = {
      getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`)}`
    };
    require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      monacoRef = window.monaco;
      editor = monacoRef.editor.create($('#editor'), {
        theme: 'vs-dark', automaticLayout: true, fontSize: state.fontSize,
        fontFamily: 'Cascadia Mono, Consolas, monospace', minimap: { enabled: true },
        renderWhitespace: 'selection', bracketPairColorization: { enabled: true }, tabSize: 4,
        smoothScrolling: true, mouseWheelZoom: true, glyphMargin: true
      });
      editor.onDidChangeCursorPosition((e) => { $('#stPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
      resolve();
    });
  });
}

// ---------------- Tabs / editing ----------------
// Windows paths are case-insensitive and may use either slash
const normPathKey = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const samePath = (a, b) => normPathKey(a) === normPathKey(b);
const findTab = (path) => state.tabs.find((t) => samePath(t.path, path));

// Load a file into a tab without necessarily showing it (used by rename / quick fixes across files)
const loadingTabs = new Map();
async function loadTab(path) {
  const existing = findTab(path);
  if (existing) return existing;
  const k = normPathKey(path);
  if (loadingTabs.has(k)) return loadingTabs.get(k);
  const p = (async () => {
    let content;
    try { content = await api.readFile(path); } catch (e) { log(`Cannot open ${path}: ${e.message}\n`, 'stderr'); return null; }
    const uri = monacoRef.Uri.file(path);
    // a model may already exist (e.g. created to preview a definition in another file)
    let model = monacoRef.editor.getModel(uri);
    if (model) { if (model.getValue() !== content) model.setValue(content); }
    else model = monacoRef.editor.createModel(content, langFor(path), uri);
    const tab = { path, model, saved: model.getAlternativeVersionId(), viewState: null, diskVersion: content };
    model.onDidChangeContent(() => renderTabs());
    state.tabs.push(tab);
    applyMarkers(tab);
    bus.emit('tabOpened', tab);
    renderTabs();
    return tab;
  })();
  loadingTabs.set(k, p);
  try { return await p; } finally { loadingTabs.delete(k); }
}

async function openFile(path, line, col) {
  const tab = await loadTab(path);
  if (!tab) return;
  activate(tab);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: col || 1 });
    editor.focus();
  }
}
const isDirty = (t) => t.model.getAlternativeVersionId() !== t.saved;

function activate(tab) {
  if (state.active && state.active !== tab) state.active.viewState = editor.saveViewState();
  state.active = tab;
  $('#welcome').style.display = tab ? 'none' : '';
  $('#editor').style.visibility = tab ? 'visible' : 'hidden';
  if (tab) {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.focus();
    $('#stLang').textContent = tab.model.getLanguageId();
  } else {
    editor.setModel(null); $('#stLang').textContent = ''; $('#stPos').textContent = '';
  }
  updateTitle();
  renderTabs();
}

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === state.active ? ' active' : '') + (isDirty(t) ? ' dirty' : '');
    el.title = t.path;
    el.innerHTML = `<span class="name"></span><span class="close">✕</span>`;
    el.querySelector('.name').textContent = baseName(t.path);
    el.onclick = () => activate(t);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    el.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeTab(t); };
    host.appendChild(el);
  }
}

async function closeTab(tab = state.active) {
  if (!tab) return;
  if (isDirty(tab)) {
    const r = confirm(`Save changes to ${baseName(tab.path)}?\n\nOK = Save, Cancel = Discard`);
    if (r) await saveTab(tab);
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  await bus.emit('tabClosing', tab);
  tab.model.dispose();
  if (state.active === tab) { state.active = null; activate(state.tabs[Math.min(i, state.tabs.length - 1)] || null); }
  else renderTabs();
}

async function saveTab(tab = state.active) {
  if (!tab) return;
  if (state.settings.formatOnSave && tab === state.active) {
    const fmt = editor.getAction('editor.action.formatDocument');
    if (fmt && fmt.isSupported()) { try { await fmt.run(); } catch {} }
  }
  await api.writeFile(tab.path, tab.model.getValue());
  tab.saved = tab.model.getAlternativeVersionId();
  tab.diskVersion = tab.model.getValue();
  renderTabs();
  status(`Saved ${baseName(tab.path)}`);
  bus.emit('saved', tab);
}
async function saveAll() { for (const t of state.tabs) if (isDirty(t)) await saveTab(t); status('All files saved'); }

// ---------------- Solution Explorer ----------------
// "Calculator.cs - Shop - Nova IDE": the folder tells windows apart (Window menu, taskbar)
function updateTitle() {
  const parts = [state.active ? baseName(state.active.path) : null, state.root ? baseName(state.root) : null, 'Nova IDE'].filter(Boolean);
  document.title = parts.join(' - ');
}
async function openFolder(path) {
  if (!path) return;
  // already open in another window? Bring that one up instead (like Visual Studio)
  if (!samePath(path, state.root || '') && await api.app.folderOpenElsewhere(path)) { status(`${baseName(path)} is open in another window`); return false; }
  if (path !== state.root) state.expanded = new Set(load(`expanded:${path}`, []));
  state.root = path;
  const recents = [path, ...load('recent', []).filter((p) => p !== path)].slice(0, 8);
  store('recent', recents);
  state.project = await api.detectProject(path);
  $('#projectBadge').textContent = `${state.project.label} · ${baseName(path)}`;
  await renderTree();
  api.ws.watch(path);
  status(`Opened ${path}`);
  api.app.setFolder(path);
  updateTitle();
  bus.emit('folder', path);
}

// Rebuilds the tree off-screen and swaps it in, keeping expanded folders, selection and scroll.
let treeBuild = 0;
async function renderTree() {
  const host = $('#tree');
  if (!state.root) { host.innerHTML = ''; return; }
  const build = ++treeBuild;
  const frag = document.createElement('div');
  state.expanded.add(state.root);
  const rootNode = makeRow({ name: baseName(state.root), path: state.root, isDir: true }, 0);
  frag.appendChild(rootNode.row);
  frag.appendChild(rootNode.kids);
  await expand(rootNode, 0);
  if (build !== treeBuild) return; // a newer refresh started meanwhile
  const scroll = host.scrollTop;
  host.replaceChildren(...frag.childNodes);
  host.scrollTop = scroll;
}

function saveExpanded() { if (state.root) store(`expanded:${state.root}`, [...state.expanded]); }

function makeRow(entry, depth) {
  const open = entry.isDir && state.expanded.has(entry.path);
  const row = document.createElement('div');
  row.className = 'tree-row' + (entry.path === state.selectedPath ? ' selected' : '');
  row.dataset.path = entry.path;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.innerHTML = `<span class="chev">${entry.isDir ? (open ? '▾' : '▸') : ''}</span><span>${entry.isDir ? '📁' : (ICONS[ext(entry.path)] || '📄')}</span><span class="label"></span><span class="git-badge"></span>`;
  row.querySelector('.label').textContent = entry.name;
  const kids = document.createElement('div');
  const node = { entry, row, kids, depth, open };
  row.onclick = async () => {
    $$('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    state.selectedPath = entry.path;
    if (entry.isDir) {
      node.open = !node.open;
      if (node.open) state.expanded.add(entry.path); else state.expanded.delete(entry.path);
      saveExpanded();
      row.querySelector('.chev').textContent = node.open ? '▾' : '▸';
      if (node.open) await expand(node, depth); else kids.innerHTML = '';
    } else openFile(entry.path);
  };
  row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, node); };
  return node;
}

// solution.js sets this in Solution view to hide bin/obj and project files
let treeEntryFilter = null;
async function expand(node, depth) {
  let entries = [];
  try { entries = await api.readDir(node.entry.path); } catch (e) { log(`${e.message}\n`, 'stderr'); }
  if (treeEntryFilter) entries = entries.filter(treeEntryFilter);
  const frag = document.createDocumentFragment();
  const openKids = [];
  for (const en of entries) {
    const child = makeRow(en, depth + 1);
    frag.appendChild(child.row);
    frag.appendChild(child.kids);
    if (child.open) openKids.push(child);
  }
  node.kids.replaceChildren(frag);
  await Promise.all(openKids.map((c) => expand(c, depth + 1)));
  bus.emit('treeRendered', node);
}

// solution.js adds "Add Class..." etc. for folders inside projects
let contextMenuExtras = null;
function showContextMenu(x, y, node) {
  const menu = $('#ctxMenu');
  const dir = node.entry.isDir ? node.entry.path : dirName(node.entry.path);
  const items = [
    ['New File...', async () => { const n = await ask('New file name'); if (n) { const p = dir + sep() + n; await api.createFile(p); await renderTree(); openFile(p); } }],
    ['New Folder...', async () => { const n = await ask('New folder name'); if (n) { await api.createDir(dir + sep() + n); await renderTree(); } }],
    ['Rename...', async () => {
      const n = await ask('Rename to', node.entry.name);
      if (n && n !== node.entry.name) {
        const t = state.tabs.find((t) => t.path === node.entry.path); if (t) await closeTab(t);
        await api.rename(node.entry.path, dirName(node.entry.path) + sep() + n);
        await renderTree();
      }
    }],
    ['Delete', async () => {
      if (confirm(`Move "${node.entry.name}" to the Recycle Bin?`)) {
        const t = state.tabs.find((t) => t.path === node.entry.path); if (t) await closeTab(t);
        await api.trash(node.entry.path); await renderTree();
      }
    }],
    ['Open in File Explorer', () => api.reveal(node.entry.path)],
    ['Open in Terminal', () => window.openTerminalAt && window.openTerminalAt(dir)],
    ['Copy Full Path', () => navigator.clipboard.writeText(node.entry.path)],
    ...(contextMenuExtras ? contextMenuExtras(node, dir) : [])
  ];
  menu.innerHTML = '';
  for (const [label, fn] of items) {
    const d = document.createElement('div');
    d.textContent = label;
    d.onclick = () => { menu.classList.add('hidden'); fn(); };
    menu.appendChild(d);
  }
  menu.style.left = `${Math.min(x, innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 200)}px`;
  menu.classList.remove('hidden');
}
document.addEventListener('click', () => $('#ctxMenu').classList.add('hidden'));

// ---------------- Modal input (prompt() is not available in Electron) ----------------
function ask(title, value = '') {
  return new Promise((resolve) => {
    const m = $('#modal'), input = $('#modalInput');
    $('#modalTitle').textContent = title;
    input.value = value;
    m.classList.remove('hidden');
    input.focus(); input.select();
    const done = (v) => { m.classList.add('hidden'); input.onkeydown = null; resolve(v); };
    $('#modalOk').onclick = () => done(input.value.trim());
    $('#modalCancel').onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); };
  });
}

// ---------------- Output / Errors / Find ----------------
// Delayed autofocus in a dialog: focus the element unless the user already went to another field of the
// same dialog (the editor behind it doesn't count: Monaco's input is a textarea too)
function focusIfIdle(el) {
  const a = document.activeElement;
  const box = el.closest ? el.closest('.modal, .dlg') : null;
  if (a && a !== el && box && box.contains(a) && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) && !a.disabled) return;
  el.focus();
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function log(text, cls) {
  text = String(text).replace(ANSI_RE, '');
  const out = $('#panel-output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  out.appendChild(span);
  while (out.childNodes.length > 5000) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
  parseErrors(text);
}
function showPanel(name) {
  $$('#bottomTabs button[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

const ERR_PATTERNS = [
  // MSBuild / C#: C:\x\Program.cs(10,5): error CS1002: ; expected [C:\x\app.csproj]
  // (dotnet watch prefixes its lines with "dotnet watch <emoji> ")
  /^\s*(?:dotnet watch \S+\s+)?(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\):\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.+?)(?:\s+\[[^\]]+\])?\s*$/i,
  // gcc / tsc / dart style: file:line:col: error: msg
  /^\s*(.+?):(\d+):(\d+):?\s*-?\s*(error|warning)\s*([A-Z]*\d*)\s*:?\s*(.+)$/i
];
function parseErrors(text) {
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    for (const re of ERR_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const [, file, ln, col, sev, code, msg] = m;
      const key = `${file}|${ln}|${col}|${code}|${msg}`;
      if (!state.errors.some((e) => e.key === key)) {
        state.errors.push({ key, file: file.trim(), line: +ln, col: +col, sev: sev.toLowerCase(), code, msg });
        changed = true;
      }
      break;
    }
  }
  if (changed) renderErrors();
}
// IntelliSense problems are supplied by lsp.js through this hook
let intellisenseProblems = () => [];
const SEV_ICON = { error: '⛔', warning: '⚠️', info: 'ℹ️' };
function renderErrors(skipMarkers) {
  const tb = $('#panel-errors tbody');
  const scope = $('#errScope') ? $('#errScope').value : 'all';
  const show = { error: $('#errShowErr').checked, warning: $('#errShowWarn').checked, info: $('#errShowInfo').checked };
  const build = scope === 'intellisense' ? [] : state.errors.map((e) => ({ ...e, source: 'Build' }));
  const isense = scope === 'build' || state.settings.showIntelliSenseErrors === false ? [] : intellisenseProblems();
  const all = [...build, ...isense];
  const visible = all.filter((e) => show[e.sev] !== false);
  tb.innerHTML = '';
  for (const e of visible.slice(0, 2000)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="sev-${e.sev}">${SEV_ICON[e.sev] || '•'}</td><td></td><td></td><td></td><td>${e.line}</td><td class="err-src"></td>`;
    tr.children[1].textContent = e.code || '';
    tr.children[2].textContent = e.msg;
    tr.children[3].textContent = baseName(e.file);
    tr.children[5].textContent = e.source;
    tr.title = e.file;
    tr.onclick = () => openFile(resolvePath(e.file), e.line, e.col);
    tb.appendChild(tr);
  }
  const count = (sev) => all.filter((e) => e.sev === sev).length;
  $('#errCount').textContent = count('error');
  $('#errNumErr').textContent = count('error');
  $('#errNumWarn').textContent = count('warning');
  $('#errNumInfo').textContent = count('info');
  if (!skipMarkers) state.tabs.forEach(applyMarkers);
}
['#errScope', '#errShowErr', '#errShowWarn', '#errShowInfo'].forEach((s) => $(s).addEventListener('change', () => renderErrors(true)));
function resolvePath(p) { return /^([a-z]:|[\\/])/i.test(p) || !state.root ? p : state.root + sep() + p; }
function applyMarkers(tab) {
  if (!monacoRef) return;
  const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
  const markers = state.errors.filter((e) => norm(resolvePath(e.file)) === norm(tab.path)).map((e) => ({
    severity: e.sev === 'error' ? monacoRef.MarkerSeverity.Error : monacoRef.MarkerSeverity.Warning,
    message: `${e.code ? e.code + ': ' : ''}${e.msg}`, startLineNumber: e.line, startColumn: e.col,
    endLineNumber: e.line, endColumn: e.col + 1
  }));
  monacoRef.editor.setModelMarkers(tab.model, 'build', markers);
}

async function findInFiles() {
  if (!state.root) return status('Open a folder first');
  const sel = editor && editor.getModel() ? editor.getModel().getValueInRange(editor.getSelection()) : '';
  const q = await ask('Find in Files', sel);
  if (!q) return;
  status(`Searching for "${q}"...`);
  const results = await api.searchInFiles(state.root, q);
  const host = $('#panel-find');
  host.innerHTML = `<div>${results.length} result(s) for "<b></b>"</div>`;
  host.querySelector('b').textContent = q;
  for (const r of results) {
    const d = document.createElement('div');
    d.className = 'find-row';
    d.innerHTML = `<span class="loc"></span>  <span></span>`;
    d.children[0].textContent = `${r.file.replace(state.root, '.')}(${r.line})`;
    d.children[1].textContent = r.text;
    d.onclick = () => openFile(r.file, r.line, r.col);
    host.appendChild(d);
  }
  showPanel('find');
  status(`Found ${results.length} result(s)`);
}

// ---------------- Build / Run ----------------
function commandFor(kind) {
  const p = state.project;
  const cfg = $('#config').value;
  const file = state.active && state.active.path;
  if (p && p.type === 'dotnet') {
    const target = p.solution || p.startup;
    if (kind === 'build') return `dotnet build ${quote(target)} -c ${cfg}`;
    if (kind === 'rebuild') return `dotnet build ${quote(target)} -c ${cfg} --no-incremental`;
    if (kind === 'clean') return `dotnet clean ${quote(target)} -c ${cfg}`;
    if (kind === 'run') { const lp = typeof lpChosenName === 'function' ? lpChosenName(p.startup) : null; return `dotnet run --project ${quote(p.startup)} -c ${cfg}${lp ? ` --launch-profile ${quote(lp)}` : ''}`; }
  }
  if (p && p.type === 'node') {
    if (kind === 'build') return p.scripts.build ? 'npm run build' : null;
    if (kind === 'clean') return p.scripts.clean ? 'npm run clean' : null;
    if (kind === 'run') return p.scripts.start ? 'npm start' : p.scripts.dev ? 'npm run dev' : file ? `node ${quote(file)}` : null;
  }
  if (p && p.type === 'flutter') {
    if (kind === 'build') return 'flutter build windows';
    if (kind === 'clean') return 'flutter clean';
    if (kind === 'run') return 'flutter run -d windows';
  }
  if (kind === 'run' && file) {
    const runners = { py: 'python', js: 'node', mjs: 'node', ps1: 'powershell -ExecutionPolicy Bypass -File', bat: 'cmd /c', cmd: 'cmd /c', dart: 'dart run' };
    const r = runners[ext(file)];
    if (r) return `${r} ${quote(file)}`;
    if (ext(file) === 'cs') return `dotnet run ${quote(file)}`; // .NET 10 file-based apps
  }
  return null;
}

// Runs build/rebuild/clean/run. Resolves with the exit code when the process ends (null if it could not start).
let execDone = null;
async function exec(kind, commandOverride, env) {
  if (state.runId) { status('A process is already running. Stop it first (Shift+F5).'); return null; }
  const command = commandOverride || commandFor(kind);
  if (!command) { log(`Nothing to ${kind}: open a project folder or a runnable file.\n`, 'info'); showPanel('output'); return null; }
  await saveAll();
  if (kind !== 'run') { state.errors = []; renderErrors(); }
  showPanel('output');
  log(`\n------ ${kind[0].toUpperCase() + kind.slice(1)} started: ${new Date().toLocaleTimeString()} ------\n> ${command}\n`, 'info');
  const cwd = state.root || (state.active && dirName(state.active.path));
  state.runKind = kind;
  const done = new Promise((resolve) => { execDone = resolve; });
  state.runId = await api.run(env ? { command, cwd, env } : { command, cwd });
  setRunning(true);
  return done;
}
function setRunning(on) {
  $('#btnStop').disabled = !on;
  $('#btnRun').disabled = on;
  $('#status').classList.toggle('running', on);
  status(on ? `${state.runKind === 'run' ? 'Running' : 'Building'}...` : 'Ready');
}
api.on('proc:data', ({ id, data, stream }) => { if (id === state.runId) log(data, stream === 'stderr' ? 'stderr' : null); });
api.on('proc:exit', ({ id, code }) => {
  if (id !== state.runId) return;
  const errs = state.errors.filter((e) => e.sev === 'error').length;
  log(`====== ${state.runKind} finished with exit code ${code}${errs ? `, ${errs} error(s)` : ''} ======\n`, code ? 'stderr' : 'info');
  if (errs && state.runKind !== 'run') showPanel('errors');
  const kind = state.runKind;
  state.runId = null;
  setRunning(false);
  status(code ? `${kind} failed` : `${kind} succeeded`);
  if (execDone) { const r = execDone; execDone = null; r(code); }
});
async function stop() { if (state.runId) { await api.kill(state.runId); log('\nProcess stopped by user.\n', 'info'); } }

// ---------------- Commands ----------------
const commands = {
  openFolder: async () => openFolder(await api.openFolderDialog()),
  openFile: async () => { const p = await api.openFileDialog(); if (p) openFile(p); },
  newFile: async () => {
    const dir = state.root || (state.active && dirName(state.active.path));
    if (!dir) { const p = await api.saveAsDialog('Untitled.txt'); if (p) { await api.writeFile(p, ''); openFile(p); } return; }
    const n = await ask('New file name', 'Class1.cs');
    if (n) { const p = dir + sep() + n; await api.createFile(p); await renderTree(); openFile(p); }
  },
  save: () => saveTab(), saveAll, closeTab: () => closeTab(),
  undo: () => editor && editor.trigger('menu', 'undo'),
  redo: () => editor && editor.trigger('menu', 'redo'),
  find: () => editor && editor.trigger('menu', 'actions.find'),
  replace: () => editor && editor.trigger('menu', 'editor.action.startFindReplaceAction'),
  gotoLine: () => editor && editor.trigger('menu', 'editor.action.gotoLine'),
  format: () => editor && editor.trigger('menu', 'editor.action.formatDocument'),
  comment: () => editor && editor.trigger('menu', 'editor.action.commentLine'),
  findInFiles,
  toggleExplorer: () => { $('#explorer').classList.toggle('hidden'); $('#vSplit').classList.toggle('hidden'); },
  showOutput: () => showPanel('output'), showErrors: () => showPanel('errors'),
  // theme + zoom are persisted through settings (see settings.js: updateSetting)
  toggleTheme: () => updateSetting({ theme: state.settings.theme === 'light' ? 'dark' : 'light' }),
  zoomIn: () => updateSetting({ fontSize: (state.settings.fontSize || 14) + 1 }),
  zoomOut: () => updateSetting({ fontSize: Math.max(8, (state.settings.fontSize || 14) - 1) }),
  build: () => exec('build'), rebuild: () => exec('rebuild'), clean: () => exec('clean'),
  run: () => exec('run'), stop
};
api.on('menu', (c) => commands[c] && commands[c]());
$$('[data-cmd]').forEach((b) => b.addEventListener('click', () => commands[b.dataset.cmd]()));
$$('#bottomTabs button[data-panel]').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));
$('#btnClearOutput').onclick = () => { $('#panel-output').innerHTML = ''; };
$('#btnRefresh').onclick = () => renderTree();

api.on('app:beforeClose', async () => {
  const dirty = state.tabs.filter(isDirty);
  if (dirty.length && confirm(`Save changes to ${dirty.length} file(s) before closing?\n\nOK = Save, Cancel = Discard`)) await saveAll();
  if (state.root) { store('lastFolder', state.root); saveExpanded(); store(`tabs:${state.root}`, state.tabs.map((t) => t.path)); }
  store('openTabs', state.tabs.map((t) => t.path));
  api.confirmClose();
});

// ---------------- Splitters ----------------
function dragSplitter(el, onMove) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
dragSplitter($('#vSplit'), (e) => { $('#explorer').style.width = `${Math.max(160, innerWidth - e.clientX)}px`; });
dragSplitter($('#hSplit'), (e) => { $('#bottom').style.height = `${Math.max(60, innerHeight - e.clientY - 22)}px`; });

// ---------------- Startup ----------------
(async function init() {
  try { state.settings = await api.settings.get(); } catch { state.settings = {}; }
  await bootMonaco();
  applySettings(state.settings); // settings.js
  await bus.emit('ready');
  const recent = $('#recent'); // the classic welcome list (app.js replaces the welcome page)
  if (recent) for (const p of load('recent', [])) {
    const d = document.createElement('div');
    d.textContent = p;
    d.onclick = () => openFolder(p);
    recent.appendChild(d);
  }
  // opened with a path ("Open with Nova IDE", NovaIDE.exe <path>)? Then open that instead of the last session
  const launchPath = await api.app.launchPath();
  const win = await api.app.windowInfo();
  if (launchPath) {
    try { await openPathSmart(launchPath); } catch (e) { log(`Could not open ${launchPath}: ${e.message}\n`, 'stderr'); }
    // a window of the last session: its tabs come back too
    if (win.restoreTabs && state.root) for (const p of load(`tabs:${state.root}`, [])) { try { await openFile(p); } catch {} }
  } else if (win.restore) {
    const last = load('lastFolder', null);
    if (last) { try { await openFolder(last); } catch {} }
    for (const p of load('openTabs', [])) { try { await openFile(p); } catch {} }
  }
  log('Nova IDE ready. Ctrl+Shift+P: commands · Ctrl+P: go to file · Ctrl+`: terminal · F5: debug · Ctrl+Shift+B: build\n', 'info');
  await bus.emit('started');
  api.app.ready();
})();
