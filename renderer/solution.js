// Nova IDE - solutions: Solution Explorer (solution view), startup project, Add Class / New Item, Reference Manager
'use strict';

const SOL = {
  model: null,          // { path, name, format, items: [folder | project(info)], configurations }
  view: load('slnView', 'solution'),
  startup: null,
  selectedProject: null,
  reloadTimer: null
};
const KIND_ICON = { console: '🖥️', library: '📚', web: '🌐', wpf: '🪟', winforms: '🪟', maui: '📱', worker: '⚙️', test: '🧪', missing: '⚠️' };
const projects = () => (SOL.model ? SOL.model.items.filter((i) => i.type === 'project') : []);
const projectByPath = (p) => projects().find((x) => samePath(x.path, p));
const runnable = () => projects().filter((p) => p.info && p.info.runnable);

// ---------------- small dialog helper (used by New Project, NuGet, Add New Item, Reference Manager) ----------------
function makeDialog({ title, cls = '', body, buttons = [] }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal dlg';
  wrap.innerHTML = `<div class="modal-box dlg-box ${cls}"><div class="dlg-head"><b></b><span class="tb-spacer"></span><button class="dlg-x" title="Close (Esc)">✕</button></div><div class="dlg-body"></div><div class="modal-actions dlg-actions"></div></div>`;
  wrap.querySelector('.dlg-head b').textContent = title;
  wrap.querySelector('.dlg-body').appendChild(body);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.querySelector('.dlg-x').onclick = close;
  const actions = wrap.querySelector('.dlg-actions');
  for (const b of buttons) {
    if (b === 'spacer') { const sp = document.createElement('span'); sp.className = 'tb-spacer'; actions.appendChild(sp); continue; }
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    if (b.id) btn.id = b.id;
    btn.onclick = () => b.onClick(close, btn);
    actions.appendChild(btn);
  }
  document.body.appendChild(wrap);
  return { el: wrap, close };
}
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};

// runs a dotnet step and writes it to the Output window; returns true on success
async function dotnetStep(cmd, cwd) {
  log(`> ${cmd}\n`, 'info');
  const r = await api.sln.dotnet(cmd, cwd);
  const out = `${r.stdout}${r.stderr}`.trim();
  if (out) log(`${out}\n`, r.ok ? null : 'stderr');
  return r.ok;
}

// ---------------- loading ----------------
async function loadSolution(preferred) {
  SOL.model = null;
  if (!state.root) return;
  let slnPath = preferred || (state.project && state.project.solution);
  if (!slnPath) slnPath = (await api.sln.find(state.root))[0];
  if (slnPath) {
    const m = await api.sln.load(slnPath);
    if (m.error) { log(`Could not load ${slnPath}: ${m.error}\n`, 'stderr'); return; }
    SOL.model = m;
  } else if (state.project && state.project.type === 'dotnet' && (state.project.projects || []).length) {
    // project files without a solution: show them like Visual Studio does when you open a .csproj
    const items = [];
    for (const p of state.project.projects) items.push({ type: 'project', name: baseName(p).replace(/\.\w+$/, ''), id: p, parent: null, path: p, lang: 'csharp', info: await api.sln.projectInfo(p) });
    SOL.model = { path: null, name: baseName(state.root), format: 'folder', items, configurations: ['Debug', 'Release'] };
  }
  if (!SOL.model) return;
  state.project = { ...(state.project || {}), type: 'dotnet', label: '.NET', solution: SOL.model.path };
  const saved = load(`startup:${SOL.model.path || state.root}`, null);
  const pick = (saved && projectByPath(saved)) || (state.project.startup && projectByPath(state.project.startup)) || runnable()[0] || projects()[0];
  setStartup(pick ? pick.path : null, false);
  renderConfigs();
  $('#projectBadge').textContent = `${SOL.model.format === 'folder' ? 'Projects' : 'Solution'} · ${SOL.model.name}`;
  bus.emit('solution', SOL.model);
}

function renderConfigs() {
  const sel = $('#config');
  const cur = sel.value;
  const list = (SOL.model && SOL.model.configurations) || ['Debug', 'Release'];
  sel.innerHTML = '';
  for (const c of list) { const o = document.createElement('option'); o.textContent = c; sel.appendChild(o); }
  sel.value = list.includes(cur) ? cur : list[0];
}

async function reloadSolution() {
  const keep = SOL.model && SOL.model.path;
  await loadSolution(keep || undefined);
  renderTree();
  renderStartupSelect();
}
function scheduleReload() { clearTimeout(SOL.reloadTimer); SOL.reloadTimer = setTimeout(reloadSolution, 400); }

// ---------------- startup project ----------------
function setStartup(projPath, persist = true) {
  SOL.startup = projPath;
  if (state.project) state.project.startup = projPath;
  if (persist && SOL.model) store(`startup:${SOL.model.path || state.root}`, projPath);
  renderStartupSelect();
  if (persist) { renderTree(); status(projPath ? `Startup project: ${baseName(projPath).replace(/\.\w+$/, '')}` : 'No startup project'); }
}
function renderStartupSelect() {
  const sel = $('#startupSelect');
  const list = runnable();
  sel.classList.toggle('hidden', !SOL.model || !list.length);
  sel.innerHTML = '';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.path; o.textContent = p.name;
    if (SOL.startup && samePath(p.path, SOL.startup)) o.selected = true;
    sel.appendChild(o);
  }
  if (!DBG.root) $('#runLabel').textContent = window.startLabel();
}
$('#startupSelect').onchange = (e) => setStartup(e.target.value);
// the Start button shows the startup project's name, like Visual Studio ("▶ HelloDebug")
window.startLabel = () => (SOL.model && SOL.startup && projectByPath(SOL.startup) ? projectByPath(SOL.startup).name : 'Start');

// ---------------- Solution Explorer (solution view) ----------------
const folderRenderTree = renderTree;
let solBuild = 0;
renderTree = async function () { // eslint-disable-line no-func-assign
  updateViewButton();
  if (!SOL.model || SOL.view !== 'solution' || $('#treeFilter').value) { treeEntryFilter = null; return folderRenderTree(); }
  return renderSolutionTree();
};

const HIDDEN_IN_PROJECT = /^(bin|obj|\.vs|\.vscode|\.idea|node_modules|TestResults)$|\.(csproj|fsproj|vbproj|user|suo)$/i;

function solRow({ icon, label, depth, key, expandable, bold, dim, title, path, onClick, onContext, badge }) {
  const open = expandable && state.expanded.has(key);
  const row = document.createElement('div');
  row.className = `tree-row sol-row${bold ? ' startup' : ''}${dim ? ' dim' : ''}${key && SOL.selectedKey === key ? ' selected' : ''}`;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (path) row.dataset.path = path;
  row.dataset.key = key || '';
  row.innerHTML = `<span class="chev">${expandable ? (open ? '▾' : '▸') : ''}</span><span>${icon}</span><span class="label"></span><span class="git-badge"></span>`;
  row.querySelector('.label').textContent = label;
  if (badge) { const b = document.createElement('span'); b.className = 'sol-badge'; b.textContent = badge; row.querySelector('.label').after(b); }
  if (title) row.title = title;
  const kids = document.createElement('div');
  row.onclick = async () => {
    $$('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    SOL.selectedKey = key;
    if (expandable) {
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      saveExpanded();
      renderTree();
    }
    if (onClick) onClick();
  };
  if (onContext) row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); };
  return { row, kids, open };
}

async function renderSolutionTree() {
  const build = ++solBuild;
  const m = SOL.model;
  const frag = document.createElement('div');
  treeEntryFilter = (e) => !HIDDEN_IN_PROJECT.test(e.name);
  const total = projects().length;
  const loaded = projects().filter((p) => p.info && !p.info.error).length;
  const slnKey = `sln:${m.path || state.root}`;
  // first time this solution is shown: expand it and the startup project, like Visual Studio
  if (!state.expanded.has(`${slnKey}:seen`)) {
    state.expanded.add(`${slnKey}:seen`);
    state.expanded.add(slnKey);
    if (SOL.startup) state.expanded.add(`proj:${SOL.startup}`);
    for (const f of m.items.filter((i) => i.type === 'folder')) state.expanded.add(`sf:${m.path}:${f.id}`);
    saveExpanded();
  }
  const root = solRow({
    icon: '🧱', label: m.format === 'folder' ? `Projects in '${m.name}'` : `Solution '${m.name}' (${loaded} of ${total} project${total === 1 ? '' : 's'})`,
    depth: 0, key: slnKey, expandable: true, path: m.path ? dirName(m.path) : state.root, title: m.path || state.root,
    onContext: (x, y) => solutionMenu(x, y)
  });
  frag.append(root.row, root.kids);
  if (root.open) await renderChildren(root.kids, null, 1);
  if (build !== solBuild) return;
  const host = $('#tree');
  const scroll = host.scrollTop;
  host.replaceChildren(...frag.childNodes);
  host.scrollTop = scroll;
  bus.emit('treeRendered');
}

async function renderChildren(container, parentId, depth) {
  const items = SOL.model.items.filter((i) => (i.parent || null) === parentId);
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  for (const it of items) {
    if (it.type === 'folder') {
      const key = `sf:${SOL.model.path}:${it.id}`;
      const r = solRow({ icon: '🗂️', label: it.name, depth, key, expandable: true, onContext: (x, y) => solutionMenu(x, y) });
      container.append(r.row, r.kids);
      if (r.open) await renderChildren(r.kids, it.id, depth + 1);
    } else await renderProject(container, it, depth);
  }
}

async function renderProject(container, p, depth) {
  const info = p.info || {};
  const key = `proj:${p.path}`;
  const isStartup = SOL.startup && samePath(SOL.startup, p.path);
  const r = solRow({
    icon: KIND_ICON[info.kind] || '🟪', label: info.error ? `${p.name} (unavailable)` : p.name, depth, key, expandable: !info.error,
    bold: isStartup, dim: !!info.error, path: dirName(p.path),
    title: `${p.path}${info.frameworks && info.frameworks.length ? `\n${info.frameworks.join(', ')}` : ''}${info.error ? `\n${info.error}` : ''}`,
    onClick: () => { SOL.selectedProject = p.path; },
    onContext: (x, y) => { SOL.selectedProject = p.path; projectMenu(x, y, p); }
  });
  container.append(r.row, r.kids);
  if (!r.open) return;
  // Dependencies
  const deps = solRow({ icon: '🔗', label: 'Dependencies', depth: depth + 1, key: `deps:${p.path}`, expandable: true, onContext: (x, y) => depsMenu(x, y, p) });
  r.kids.append(deps.row, deps.kids);
  if (deps.open) {
    const groups = [
      ['Frameworks', '🎯', (info.frameworks || []).map((f) => ({ label: `${frameworkName(f)}`, title: f }))],
      ['Packages', '📦', (info.packages || []).map((pk) => ({ label: `${pk.id}${pk.version ? ` (${pk.version})` : ''}`, onContext: (x, y) => packageMenu(x, y, p, pk) }))],
      ['Projects', '🔗', (info.references || []).map((ref) => ({ label: baseName(ref).replace(/\.\w+$/, ''), title: ref, onClick: () => revealProject(ref) }))]
    ];
    for (const [name, icon, list] of groups) {
      if (!list.length) continue;
      const g = solRow({ icon, label: name, depth: depth + 2, key: `deps:${p.path}:${name}`, expandable: true, onContext: name === 'Packages' ? (x, y) => depsMenu(x, y, p) : undefined });
      deps.kids.append(g.row, g.kids);
      if (g.open) for (const it of list) { const x = solRow({ icon: name === 'Packages' ? '📦' : name === 'Projects' ? '🟪' : '🎯', label: it.label, depth: depth + 3, title: it.title, onClick: it.onClick, onContext: it.onContext }); g.kids.append(x.row); }
    }
  }
  // the project's files (same rows as Folder view)
  const node = { entry: { path: dirName(p.path), isDir: true }, kids: r.kids };
  const holder = document.createElement('div');
  await expand({ ...node, kids: holder }, depth);
  r.kids.append(...holder.childNodes);
}
const frameworkName = (f) => (/^net\d+\.\d+$/.test(f) ? `Microsoft.NETCore.App (${f})` : /^net\d+\.\d+-windows/.test(f) ? `Microsoft.WindowsDesktop.App (${f})` : f);

function revealProject(p) {
  state.expanded.add(`proj:${p}`);
  SOL.selectedKey = `proj:${p}`;
  renderTree();
}

function updateViewButton() {
  const b = $('#btnSlnView');
  b.classList.toggle('hidden', !SOL.model);
  b.title = SOL.view === 'solution' ? 'Switch to Folder View' : 'Switch to Solution View';
  b.textContent = SOL.view === 'solution' ? '📁' : '🧱';
}
$('#btnSlnView').onclick = () => commands.toggleSolutionView();

// ---------------- context menus ----------------
function popup(x, y, items) {
  const menu = $('#ctxMenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(h('hr')); continue; }
    const d = h('div', { class: it.disabled ? 'disabled' : '' }, it.label);
    if (!it.disabled) d.onclick = () => { menu.classList.add('hidden'); it.run(); };
    menu.appendChild(d);
  }
  menu.style.left = `${Math.min(x, innerWidth - 240)}px`;
  menu.style.top = `${Math.min(y, innerHeight - items.length * 26 - 10)}px`;
  menu.classList.remove('hidden');
}
const cfg = () => $('#config').value || 'Debug';
const q = (p) => `"${p}"`;

function solutionMenu(x, y) {
  const target = SOL.model.path || null;
  popup(x, y, [
    { label: 'Build Solution', run: () => commands.build() },
    { label: 'Rebuild Solution', run: () => commands.rebuild() },
    { label: 'Clean Solution', run: () => commands.clean() },
    '-',
    { label: 'Add New Project...', run: () => commands.addNewProject() },
    { label: 'Add Existing Project...', run: () => commands.addExistingProject(), disabled: !target },
    '-',
    { label: 'Open in Terminal', run: () => window.openTerminalAt(state.root) },
    { label: 'Open Folder in File Explorer', run: () => api.reveal(target || state.root) },
    { label: 'Switch to Folder View', run: () => commands.toggleSolutionView() }
  ]);
}

function projectMenu(x, y, p) {
  const isStartup = SOL.startup && samePath(SOL.startup, p.path);
  popup(x, y, [
    { label: 'Build', run: () => exec('build', `dotnet build ${q(p.path)} -c ${cfg()}`) },
    { label: 'Rebuild', run: () => exec('rebuild', `dotnet build ${q(p.path)} -c ${cfg()} --no-incremental`) },
    { label: 'Clean', run: () => exec('clean', `dotnet clean ${q(p.path)} -c ${cfg()}`) },
    '-',
    { label: 'Add Class...', run: () => addItem(dirName(p.path), 'class') },
    { label: 'Add New Item...', run: () => addNewItemDialog(dirName(p.path)) },
    { label: 'Add New Folder', run: async () => { const n = await ask('New folder name', 'NewFolder'); if (n) { await api.createDir(dirName(p.path) + sep() + n); renderTree(); } } },
    { label: 'Add Project Reference...', run: () => referenceManager(p) },
    { label: 'Manage NuGet Packages...', run: () => commands.manageNuget(p.path) },
    '-',
    { label: isStartup ? '✓ Startup Project' : 'Set as Startup Project', run: () => setStartup(p.path), disabled: isStartup },
    { label: 'Configure Startup Projects...', run: () => commands.configureStartupProjects() },
    { label: 'Debug: Start New Instance', run: () => { setStartup(p.path); commands.debugStart(); }, disabled: !(p.info && p.info.runnable) },
    '-',
    { label: 'Edit Project File', run: () => openFile(p.path) },
    { label: 'Open in Terminal', run: () => window.openTerminalAt(dirName(p.path)) },
    { label: 'Open Folder in File Explorer', run: () => api.reveal(p.path) },
    { label: 'Remove from Solution', disabled: !SOL.model.path, run: async () => {
      if (!confirm(`Remove "${p.name}" from the solution? The files stay on disk.`)) return;
      showPanel('output');
      if (await dotnetStep(`dotnet sln ${q(SOL.model.path)} remove ${q(p.path)}`, dirName(SOL.model.path))) reloadSolution();
    } }
  ]);
}

function depsMenu(x, y, p) {
  popup(x, y, [
    { label: 'Manage NuGet Packages...', run: () => commands.manageNuget(p.path) },
    { label: 'Add Project Reference...', run: () => referenceManager(p) }
  ]);
}
function packageMenu(x, y, p, pk) {
  popup(x, y, [
    { label: 'Update...', run: () => commands.manageNuget(p.path, { tab: 'installed', select: pk.id }) },
    { label: 'Remove', run: async () => {
      showPanel('output');
      if (await dotnetStep(`dotnet remove ${q(p.path)} package ${pk.id}`, dirName(p.path))) await refreshProject(p.path);
    } }
  ]);
}

// file/folder rows inside a project get "Add Class..." / "Add New Item..."
contextMenuExtras = (node, dir) => {
  if (!SOL.model || SOL.view !== 'solution' || !owningProject(dir)) return [];
  return [['Add Class...', () => addItem(dir, 'class')], ['Add New Item...', () => addNewItemDialog(dir)]];
};

function owningProject(dir) {
  let best = null;
  for (const p of projects()) {
    const pd = normPathKey(dirName(p.path));
    const d = normPathKey(dir);
    if ((d === pd || d.startsWith(pd + '\\')) && (!best || pd.length > normPathKey(dirName(best.path)).length)) best = p;
  }
  return best;
}

async function refreshProject(projPath) {
  const p = projectByPath(projPath);
  if (p) p.info = await api.sln.projectInfo(projPath);
  renderTree();
  renderStartupSelect();
}

// ---------------- Add Class / Add New Item ----------------
const ITEM_TEMPLATES = [
  { id: 'class', name: 'Class', desc: 'An empty class definition', file: 'Class1.cs', body: (ns, n) => `namespace ${ns};\n\npublic class ${n}\n{\n}\n` },
  { id: 'interface', name: 'Interface', desc: 'An empty interface definition', file: 'IInterface1.cs', body: (ns, n) => `namespace ${ns};\n\npublic interface ${n}\n{\n}\n` },
  { id: 'record', name: 'Record', desc: 'An immutable record type', file: 'Record1.cs', body: (ns, n) => `namespace ${ns};\n\npublic record ${n}();\n` },
  { id: 'enum', name: 'Enum', desc: 'An enumeration', file: 'Enum1.cs', body: (ns, n) => `namespace ${ns};\n\npublic enum ${n}\n{\n}\n` },
  { id: 'struct', name: 'Struct', desc: 'A value type', file: 'Struct1.cs', body: (ns, n) => `namespace ${ns};\n\npublic struct ${n}\n{\n}\n` },
  { id: 'code', name: 'Code File', desc: 'An empty C# file', file: 'CodeFile1.cs', body: () => '' },
  { id: 'json', name: 'JSON File', desc: 'A JSON file (e.g. appsettings)', file: 'data.json', body: () => '{\n}\n' },
  { id: 'xml', name: 'XML File', desc: 'An XML file', file: 'XMLFile1.xml', body: () => '<?xml version="1.0" encoding="utf-8"?>\n' },
  { id: 'text', name: 'Text File', desc: 'An empty text file', file: 'TextFile1.txt', body: () => '' },
  { id: 'html', name: 'HTML Page', desc: 'An HTML page', file: 'HTMLPage1.html', body: () => '<!DOCTYPE html>\n<html>\n<head>\n    <meta charset="utf-8" />\n    <title></title>\n</head>\n<body>\n\n</body>\n</html>\n' }
];

function namespaceFor(dir) {
  const p = owningProject(dir);
  if (!p) return 'MyNamespace';
  const base = (p.info && p.info.rootNamespace) || p.name;
  const rel = dir.slice(dirName(p.path).length).split(/[\\/]/).filter(Boolean).map((s) => s.replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1'));
  return [base, ...rel].join('.');
}

async function createItem(dir, tpl, fileName) {
  let name = fileName.trim();
  if (!name) return;
  const extOf = tpl.file.slice(tpl.file.lastIndexOf('.'));
  if (!name.includes('.')) name += extOf;
  const typeName = name.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_');
  const file = dir + sep() + name;
  if (await api.exists(file)) { status(`${name} already exists`); return; }
  await api.writeFile(file, tpl.body(namespaceFor(dir), typeName));
  await renderTree();
  await openFile(file, tpl.id === 'class' || tpl.id === 'interface' || tpl.id === 'struct' ? 5 : 1, 1);
  status(`Added ${name}`);
}

async function addItem(dir, kind) {
  const tpl = ITEM_TEMPLATES.find((t) => t.id === kind);
  const n = await ask(`Add ${tpl.name} (namespace ${namespaceFor(dir)})`, tpl.file);
  if (n) await createItem(dir, tpl, n);
}

function addNewItemDialog(dir) {
  let sel = ITEM_TEMPLATES[0];
  const nameInput = h('input', { class: 'dlg-input', value: sel.file, spellcheck: false });
  const desc = h('div', { class: 'dlg-desc' }, sel.desc);
  const list = h('div', { class: 'dlg-list' });
  for (const t of ITEM_TEMPLATES) {
    const row = h('div', { class: `dlg-item${t === sel ? ' sel' : ''}` }, h('b', {}, t.name), h('span', {}, t.desc));
    row.onclick = () => { sel = t; list.querySelectorAll('.dlg-item').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); nameInput.value = t.file; desc.textContent = t.desc; nameInput.focus(); nameInput.select(); };
    row.ondblclick = () => { create(); };
    list.appendChild(row);
  }
  const body = h('div', { class: 'dlg-grid' }, list, h('div', { class: 'dlg-side' }, h('label', {}, 'Name:'), nameInput, desc, h('div', { class: 'dlg-desc' }, `Folder: ${dir}`), h('div', { class: 'dlg-desc' }, `Namespace: ${namespaceFor(dir)}`)));
  const dlg = makeDialog({ title: 'Add New Item', cls: 'dlg-wide', body, buttons: ['spacer', { label: 'Add', primary: true, onClick: () => create() }, { label: 'Cancel', onClick: (close) => close() }] });
  async function create() { const n = nameInput.value; dlg.close(); await createItem(dir, sel, n); }
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') create(); };
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);
}

// ---------------- Reference Manager ----------------
function referenceManager(p) {
  const others = projects().filter((x) => !samePath(x.path, p.path));
  if (!others.length) { status('There are no other projects in the solution to reference'); return; }
  const refs = (p.info && p.info.references) || [];
  const boxes = [];
  const list = h('div', { class: 'dlg-list refs' });
  for (const o of others) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = refs.some((r) => samePath(r, o.path));
    boxes.push([o, cb, cb.checked]);
    list.appendChild(h('label', { class: 'dlg-item' }, cb, h('span', {}, `${KIND_ICON[(o.info || {}).kind] || '🟪'} ${o.name}`), h('span', { class: 'dlg-desc' }, (o.info && o.info.frameworks || []).join(', '))));
  }
  makeDialog({
    title: `Reference Manager - ${p.name}`, body: h('div', {}, h('div', { class: 'dlg-desc' }, 'Projects'), list),
    buttons: ['spacer', { label: 'OK', primary: true, onClick: async (close) => {
      close();
      showPanel('output');
      for (const [o, cb, was] of boxes) {
        if (cb.checked === was) continue;
        await dotnetStep(`dotnet ${cb.checked ? 'add' : 'remove'} ${q(p.path)} reference ${q(o.path)}`, dirName(p.path));
      }
      await refreshProject(p.path);
    } }, { label: 'Cancel', onClick: (close) => close() }]
  });
}

// ---------------- commands ----------------
const selectedOrStartupProject = () => projectByPath(SOL.selectedProject || '') || projectByPath(SOL.startup || '') || projects()[0];
Object.assign(commands, {
  toggleSolutionView: () => { SOL.view = SOL.view === 'solution' ? 'folder' : 'solution'; store('slnView', SOL.view); renderTree(); },
  setStartupFromSelection: () => { const p = projectByPath(SOL.selectedProject || ''); if (p) setStartup(p.path); else status('Select a project in Solution Explorer first'); },
  editProjectFile: () => { const p = selectedOrStartupProject(); if (p) openFile(p.path); },
  addProjectReference: () => { const p = selectedOrStartupProject(); if (p) referenceManager(p); else status('Open a solution first'); },
  addClass: () => {
    const dir = currentItemDir();
    if (!dir) return status('Open a .NET project first');
    addItem(dir, 'class');
  },
  addNewItem: () => { const dir = currentItemDir(); if (!dir) return status('Open a folder first'); addNewItemDialog(dir); },
  openSolution: async () => {
    const f = await api.openFilteredDialog('Open Project/Solution', [{ name: 'Solutions and projects', extensions: ['sln', 'slnx', 'csproj', 'fsproj', 'vbproj'] }]);
    if (!f) return;
    const dir = dirName(f);
    await openFolder(dir);
    if (/\.slnx?$/i.test(f)) { await loadSolution(f); renderTree(); renderStartupSelect(); }
  },
  addExistingProject: async () => {
    if (!SOL.model || !SOL.model.path) return status('Open a solution first');
    const f = await api.openFilteredDialog('Add Existing Project', [{ name: 'Projects', extensions: ['csproj', 'fsproj', 'vbproj'] }]);
    if (!f) return;
    showPanel('output');
    if (await dotnetStep(`dotnet sln ${q(SOL.model.path)} add ${q(f)}`, dirName(SOL.model.path))) reloadSolution();
  }
});
// the folder for Add Class: selected folder in the tree, else the active file's folder, else the startup project
function currentItemDir() {
  if (state.selectedPath) {
    const isDir = $(`#tree .tree-row.selected .chev`) && $(`#tree .tree-row.selected .chev`).textContent;
    return isDir ? state.selectedPath : dirName(state.selectedPath);
  }
  if (state.active) return dirName(state.active.path);
  const p = selectedOrStartupProject();
  return p ? dirName(p.path) : state.root;
}

// ---------------- events ----------------
bus.on('folder', async () => { await loadSolution(); renderTree(); renderStartupSelect(); });
api.on('fs:changed', ({ paths }) => { if (SOL.model && paths.some((p) => /\.(slnx?|csproj|fsproj|vbproj|props)$/i.test(p))) scheduleReload(); });

window.SOL = SOL;
window.makeDialog = makeDialog;
window.h = h;
window.dotnetStep = dotnetStep;
window.loadSolution = loadSolution;
window.reloadSolution = reloadSolution;
window.setStartup = setStartup;
window.refreshProject = refreshProject;
