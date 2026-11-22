// Nova IDE - app shell: open from Explorer / command line, About, updates, error log, welcome page
'use strict';

// Open whatever was passed: a solution, a project, a folder or a file
async function openPathSmart(p) {
  const st = await api.ws.stat(p);
  if (!st.exists) { status(`Not found: ${p}`); return; }
  if (st.isDir) return openFolder(p);
  const dir = dirName(p);
  if (/\.slnx?$/i.test(p)) {
    if (!state.root || !samePath(state.root, dir)) await openFolder(dir);
    if (!SOL.model || !SOL.model.path || !samePath(SOL.model.path, p)) { await loadSolution(p); renderTree(); }
    return;
  }
  if (/\.(cs|fs|vb)proj$/i.test(p)) {
    if (!state.root || !samePath(state.root, dir)) await openFolder(dir);
    return;
  }
  return openFile(p);
}
window.openPathSmart = openPathSmart;
api.on('app:openPath', (p) => openPathSmart(p).catch((e) => log(`Could not open ${p}: ${e.message}\n`, 'stderr')));

// ---------------- errors -> log file ----------------
window.addEventListener('error', (e) => api.app.logError(`${e.message} at ${e.filename}:${e.lineno}\n${e.error && e.error.stack ? e.error.stack : ''}`));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && (r.name === 'Canceled' || r.message === 'Canceled')) return;
  api.app.logError(`unhandled rejection: ${r && r.stack ? r.stack : r}`);
});

// ---------------- About ----------------
async function aboutDialog() {
  const i = await api.app.info();
  const row = (k, v) => h('tr', {}, h('td', {}, k), h('td', {}, v));
  const logs = h('a', { href: '#' }, 'Open logs folder');
  logs.onclick = (e) => { e.preventDefault(); api.app.openLogs(); };
  const body = h('div', { class: 'about' },
    h('img', { src: 'assets/icon.png', class: 'about-icon', alt: '' }),
    h('div', {},
      h('div', { class: 'about-name' }, 'Nova IDE'),
      h('div', { class: 'dlg-desc' }, `Version ${i.version}${i.packaged ? '' : ' (development)'}`),
      h('p', {}, 'A Visual Studio style IDE for .NET, Node.js and Python, built on Electron and the Monaco editor.'),
      h('table', { class: 'about-table' }, row('Electron', i.electron), row('Chromium', i.chrome), row('Node.js', i.node), row('Platform', i.platform), row('Settings and logs', i.userData)),
      h('p', {}, logs)));
  makeDialog({ title: 'About Nova IDE', body, buttons: ['spacer', { label: 'Check for Updates', onClick: (close) => { close(); commands.checkUpdates(); } }, { label: 'OK', primary: true, onClick: (close) => close() }] });
}

// ---------------- updates ----------------
let updateNotified = false;
function updateBadge(st) {
  const el = $('#stUpdate');
  const map = { available: `⬆ Update ${st.version} available`, downloading: `⬇ Downloading update ${st.percent}%`, ready: `⟳ Restart to update to ${st.version}` };
  const text = map[st.phase];
  el.classList.toggle('hidden', !text);
  if (text) el.textContent = text;
}
api.on('update:status', (st) => {
  updateBadge(st);
  if (st.phase === 'ready') promptInstall(st.version);
});
$('#stUpdate').onclick = async () => {
  const st = await api.update.state();
  if (st.phase === 'available') promptDownload(st.version);
  else if (st.phase === 'ready') promptInstall(st.version);
};
async function promptDownload(version) {
  const i = await api.app.info();
  makeDialog({
    title: 'Update available', body: h('div', {}, h('p', {}, `Nova IDE ${version} is available. You have ${i.version}.`), h('p', { class: 'dlg-desc' }, 'The update downloads in the background; you can keep working.')),
    buttons: ['spacer', { label: 'Download', primary: true, onClick: async (close) => { close(); status('Downloading update...'); const r = await api.update.download(); if (!r.ok) { log(`Update download failed: ${r.error}\n`, 'stderr'); status('Update download failed'); } } }, { label: 'Later', onClick: (close) => close() }]
  });
}
function promptInstall(version) {
  if (updateNotified) return;
  updateNotified = true;
  makeDialog({
    title: 'Update ready', body: h('p', {}, `Nova IDE ${version} has been downloaded. Restart now to install it? (You'll be asked to save changes first.)`),
    buttons: ['spacer', { label: 'Restart and Update', primary: true, onClick: (close) => { close(); api.update.install(); } }, { label: 'On Next Start', onClick: (close) => { close(); status('The update will be installed when you close Nova IDE.'); } }]
  });
}
async function checkUpdates() {
  status('Checking for updates...');
  const r = await api.update.check();
  if (!r.configured) {
    status('Updates are not set up');
    makeDialog({
      title: 'Check for Updates',
      body: h('div', {},
        h('p', {}, 'Nova IDE doesn\'t know where its updates are published yet.'),
        h('p', { class: 'dlg-desc' }, 'When you publish new versions (the dist folder from "npm run dist": the installer, its .blockmap and latest.yml), add one of these to settings.json (Tools > Options > Edit JSON):'),
        h('pre', { class: 'about-code' }, '"updateUrl": "https://your-server/nova-ide/"\n   or\n"updateGithub": "your-name/nova-ide"')),
      buttons: ['spacer', { label: 'Open settings.json', onClick: async (close) => { close(); await api.settings.set(state.settings); openFile(await api.settings.path()); } }, { label: 'OK', primary: true, onClick: (close) => close() }]
    });
    return r;
  }
  if (r.error) { status('Could not check for updates'); log(`Update check failed: ${r.error}\n`, 'stderr'); showPanel('output'); return r; }
  if (r.available) { status(`Update ${r.version} available`); promptDownload(r.version); }
  else { status(`Nova IDE ${r.current} is up to date`); }
  return r;
}

// ---------------- welcome page ----------------
function renderWelcome() {
  const w = $('#welcome');
  w.innerHTML = '';
  const action = (icon, title, sub, fn) => { const b = h('button', { class: 'welcome-action' }, h('span', { class: 'wa-icon' }, icon), h('span', {}, h('b', {}, title), h('span', { class: 'dlg-desc' }, sub))); b.onclick = fn; return b; };
  const recentList = h('div', { class: 'welcome-recent' });
  for (const p of load('recent', []).slice(0, 8)) {
    const r = h('div', { class: 'welcome-recent-item', title: `${p}\nCtrl+click or right-click: open in a new window` }, h('b', {}, baseName(p)), h('span', { class: 'dlg-desc' }, p));
    r.oncontextmenu = (e) => { e.preventDefault(); popup(e.clientX, e.clientY, [{ label: 'Open', run: () => openPathSmart(p) }, { label: 'Open in New Window', run: () => api.app.newWindow(p) }]); };
    r.onclick = (e) => (e.ctrlKey ? api.app.newWindow(p) : openFolder(p));
    recentList.appendChild(r);
  }
  if (!recentList.children.length) recentList.appendChild(h('div', { class: 'dlg-desc' }, 'Nothing opened yet.'));
  w.append(
    h('div', { class: 'welcome-head' }, h('img', { src: 'assets/icon.png', alt: '' }), h('div', {}, h('h1', {}, 'Nova IDE'), h('div', { class: 'dlg-desc', id: 'welcomeVersion' }, ''))),
    h('div', { class: 'welcome-cols' },
      h('div', {}, h('h3', {}, 'Open recent'), recentList),
      h('div', {}, h('h3', {}, 'Get started'),
        action('🆕', 'Create a new project', 'Choose a template to get started', () => commands.newProject()),
        action('🧱', 'Open a project or solution', 'Open a .sln, .slnx or .csproj', () => commands.openSolution()),
        action('📂', 'Open a local folder', 'Navigate and edit code in any folder', () => commands.openFolder()),
        action('📄', 'Open a file', 'Edit a single file', () => commands.openFile()))));
  api.app.info().then((i) => { const v = $('#welcomeVersion'); if (v) v.textContent = `Version ${i.version}`; });
}
bus.on('ready', renderWelcome);
bus.on('folder', renderWelcome); // keep "Open recent" current

Object.assign(commands, {
  about: aboutDialog,
  checkUpdates,
  openLogs: () => api.app.openLogs()
});

// ---------------- windows (Phase 11) ----------------
// windows are made by the main process; the keyboard shortcuts and the palette reach it from here
Object.assign(commands, {
  newWindow: () => api.app.command('newWindow'),
  openFolderNewWindow: () => api.app.command('openFolderNewWindow'),
  closeWindow: () => api.app.command('closeWindow')
});
