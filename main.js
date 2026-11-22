// Nova IDE - main process
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const log = require('./main/log');

app.setAppUserModelId('com.novaide.app');
log.init(app);
process.on('uncaughtException', (e) => log.error('uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

// One Nova IDE process with any number of windows: starting Nova IDE again (e.g. "Open with Nova IDE")
// hands the path to the running process, which opens it in a new window (or the window that has it open)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// A path given on the command line: "NovaIDE.exe C:\src\Shop\Shop.sln" (used by Open with / Explorer menu)
// (skips switches, and in a development run "electron ." the app's own folder)
function pathFromArgs(argv, cwd = process.cwd()) {
  const appDir = path.resolve(app.getAppPath()).toLowerCase();
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd, a);
    if (p.toLowerCase() === appDir || p.toLowerCase() === path.resolve(process.execPath).toLowerCase()) continue;
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}
const startPath = pathFromArgs(process.argv);

// ---------------- windows ----------------
// Every request from a window runs "inside" that window (AsyncLocalStorage), so replies and the events
// of what it started (terminal output, builds, tests, debugger, language servers) go back to that window only.
const callerCtx = new AsyncLocalStorage();
const ipc = {
  handle: (ch, fn) => ipcMain.handle(ch, (e, ...a) => callerCtx.run(e.sender, () => fn(e, ...a))),
  on: (ch, fn) => ipcMain.on(ch, (e, ...a) => callerCtx.run(e.sender, () => fn(e, ...a))),
  removeHandler: (ch) => ipcMain.removeHandler(ch)
};
const windows = new Map(); // webContents id -> { win, id, ready, pendingOpen, restore, restoreTabs, folder }
let lastFocused = null;
let quitting = false;
let sessionFolders = null;
const ownerId = () => { const wc = callerCtx.getStore(); return wc ? wc.id : 0; };
const recOf = (e) => windows.get(e.sender.id);
const winOf = (e) => BrowserWindow.fromWebContents(e.sender) || undefined;
const liveWindows = () => [...windows.values()].filter((r) => !r.win.isDestroyed());
function focusedRec() {
  const f = BrowserWindow.getFocusedWindow();
  return (f && windows.get(f.webContents.id)) || (lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : liveWindows()[0]);
}
function showWin(w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
const samePath = (a, b) => !!a && !!b && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (dir, p) => !!dir && !!p && (samePath(dir, p) || (process.platform === 'win32' ? p.toLowerCase() : p).startsWith((process.platform === 'win32' ? dir.toLowerCase() : dir) + path.sep));

function sendTo(rec, channel, payload) { if (rec && !rec.win.isDestroyed()) rec.win.webContents.send(channel, payload); }
// a path from outside (command line, second start, Open Folder in New Window)
function openPath(p, { newWindow = false } = {}) {
  if (!p) { createWindow(); return; }
  log.info(`open ${p}`);
  const dir = (() => { try { return fsSync.statSync(p).isDirectory() ? p : path.dirname(p); } catch { return p; } })();
  // already open in a window: bring that one up (a file inside its folder opens there)
  const has = liveWindows().find((r) => r.folder && inside(r.folder, p)) || liveWindows().find((r) => r.folder && samePath(r.folder, dir));
  if (has) {
    showWin(has.win);
    if (!samePath(has.folder, p)) { if (has.ready) sendTo(has, 'app:openPath', p); else has.pendingOpen = p; }
    return;
  }
  // an empty window can take it
  const empty = !newWindow && liveWindows().find((r) => !r.folder && r.ready && !r.pendingOpen);
  if (empty) { showWin(empty.win); sendTo(empty, 'app:openPath', p); return; }
  createWindow({ open: p });
}
app.on('second-instance', (_e, argv, cwd) => openPath(pathFromArgs(argv, cwd)));
ipc.on('app:rendererReady', (e) => {
  const r = recOf(e);
  if (!r) return;
  r.ready = true;
  if (r.pendingOpen && r.consumedLaunch) { sendTo(r, 'app:openPath', r.pendingOpen); r.pendingOpen = null; }
});
// the path this window was opened with; taken once by the window on startup
ipc.handle('app:launchPath', (e) => { const r = recOf(e); if (!r) return null; const p = r.pendingOpen; r.pendingOpen = null; r.consumedLaunch = true; return p; });
// restore: the last folder + tabs (first window of a session); restoreTabs: tabs of the folder it opens
ipc.handle('app:windowInfo', (e) => { const r = recOf(e); return r ? { restore: r.restore, restoreTabs: r.restoreTabs, id: r.id, count: liveWindows().length } : { restore: false }; });
// the renderer tells which folder it has open (Window menu, "already open" checks, session)
ipc.on('app:folder', (e, folder) => { const r = recOf(e); if (r) { r.folder = folder || null; buildMenu(); } });
// is this folder open in another window? then bring that one to the front
ipc.handle('app:folderOpenElsewhere', (e, folder) => {
  const other = liveWindows().find((r) => r.id !== e.sender.id && samePath(r.folder, folder));
  if (!other) return false;
  showWin(other.win);
  return true;
});
ipc.handle('app:newWindow', (_e, p) => { if (p) openPath(p, { newWindow: true }); else createWindow(); return true; });
ipc.on('log:renderer', (_e, level, msg) => log[level === 'error' ? 'error' : 'warn'](`[renderer] ${msg}`));
ipc.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: `${process.platform} ${process.arch}`, packaged: app.isPackaged, logs: log.dir(), userData: app.getPath('userData') }));
ipc.handle('app:openLogs', () => shell.openPath(log.dir()));
const appIcon = () => { const f = path.join(__dirname, 'renderer', 'assets', 'icon.png'); return fsSync.existsSync(f) ? nativeImage.createFromPath(f) : undefined; };

const procs = new Map(); // id -> { child, owner }
let nextProcId = 1;

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'build', 'dist', '.dart_tool', '.vs', '.idea', '__pycache__']);
const TEXT_EXT = /\.(cs|csproj|sln|xaml|razor|cshtml|js|mjs|cjs|jsx|ts|tsx|json|html?|css|scss|less|md|txt|xml|config|py|java|kt|dart|c|h|cpp|hpp|go|rs|php|rb|sql|sh|ps1|bat|ya?ml|swift|vb|fs|gradle|props|targets|ini|env)$/i;

// to the window whose request is running; with no request (startup, timers of main) to every window
function send(channel, payload) {
  const wc = callerCtx.getStore();
  if (wc) { if (!wc.isDestroyed()) wc.send(channel, payload); return; }
  broadcast(channel, payload);
}
function broadcast(channel, payload) { for (const r of liveWindows()) r.win.webContents.send(channel, payload); }

// Menu items. `key` is shown in the menu but NOT registered as a native accelerator:
// the renderer runs every shortcut itself (renderer/keymap.js) so a key can never fire twice.
// `editor: true` = the code editor already handles this key when it has focus.
const MENU = [
  ['&File', [
    { label: 'New', submenu: [
      { label: 'Project...', key: 'Ctrl+Shift+N', cmd: 'newProject' },
      { label: 'File...', key: 'Ctrl+N', cmd: 'newFile' }
    ] },
    { label: 'Open Project/Solution...', cmd: 'openSolution' },
    { label: 'Open Folder...', key: 'Ctrl+Shift+O', cmd: 'openFolder' },
    { label: 'Open File...', key: 'Ctrl+O', cmd: 'openFile' },
    '-',
    { label: 'New Window', key: 'Ctrl+Alt+Shift+N', cmd: 'newWindow' },
    { label: 'Open Folder in New Window...', cmd: 'openFolderNewWindow' },
    { label: 'Close Window', cmd: 'closeWindow' },
    '-',
    { label: 'Save', key: 'Ctrl+S', cmd: 'save' },
    { label: 'Save All', key: 'Ctrl+Shift+S', cmd: 'saveAll' },
    { label: 'Close Tab', key: 'Ctrl+F4', cmd: 'closeTab' },
    '-',
    { label: 'Exit', role: 'quit' }
  ]],
  ['&Edit', [
    { label: 'Undo', key: 'Ctrl+Z', cmd: 'undo', editor: true },
    { label: 'Redo', key: 'Ctrl+Y', cmd: 'redo', editor: true },
    '-',
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    '-',
    { label: 'Find', key: 'Ctrl+F', cmd: 'find', editor: true },
    { label: 'Replace', key: 'Ctrl+H', cmd: 'replace', editor: true },
    { label: 'Find in Files', key: 'Ctrl+Shift+F', cmd: 'findInFiles' },
    '-',
    { label: 'Go To', submenu: [
      { label: 'Go to All (symbols)...', key: 'Ctrl+T', cmd: 'gotoSymbolWorkspace' },
      { label: 'Go to File...', key: 'Ctrl+P', cmd: 'quickOpen' },
      { label: 'Go to Member (symbol in file)...', key: 'Alt+\\', cmd: 'gotoSymbolFile' },
      { label: 'Go to Line...', key: 'Ctrl+G', cmd: 'gotoLine', editor: true }
    ] },
    { label: 'IntelliSense', submenu: [
      { label: 'List Members', key: 'Ctrl+Space', cmd: 'triggerSuggest', editor: true },
      { label: 'Parameter Info', key: 'Ctrl+Shift+Space', cmd: 'parameterInfo', editor: true },
      { label: 'Quick Info', cmd: 'quickInfo' },
      { label: 'Quick Actions and Refactorings...', key: 'Ctrl+.', cmd: 'quickActions', editor: true },
      { label: 'Rename...  (Ctrl+R, Ctrl+R)', key: 'F2', cmd: 'renameSymbol', editor: true },
      { label: 'Organize Imports / Usings', cmd: 'organizeImports' }
    ] },
    { label: 'Advanced', submenu: [
      { label: 'Format Document  (Ctrl+K, Ctrl+D)', key: 'Shift+Alt+F', cmd: 'format', editor: true },
      { label: 'Comment Selection  (Ctrl+K, Ctrl+C)', cmd: 'commentLines' },
      { label: 'Uncomment Selection  (Ctrl+K, Ctrl+U)', cmd: 'uncommentLines' },
      { label: 'Toggle Line Comment', key: 'Ctrl+/', cmd: 'comment', editor: true }
    ] },
    '-',
    { label: 'Go to Definition', key: 'F12', cmd: 'gotoDefinition', editor: true },
    { label: 'Peek Definition', key: 'Alt+F12', cmd: 'peekDefinition', editor: true },
    { label: 'Go to Implementation', key: 'Ctrl+F12', cmd: 'gotoImplementation', editor: true },
    { label: 'Find All References', key: 'Shift+F12', cmd: 'findReferences', editor: true }
  ]],
  ['&View', [
    { label: 'Solution Explorer', key: 'Ctrl+Alt+L', cmd: 'toggleExplorer' },
    { label: 'Output', key: 'Ctrl+Alt+O', cmd: 'showOutput' },
    { label: 'Error List', key: 'Ctrl+\\', cmd: 'showErrors' },
    { label: 'Terminal', key: 'Ctrl+`', cmd: 'showTerminal' },
    { label: 'Git Changes', key: 'Ctrl+Alt+G', cmd: 'showGit' },
    '-',
    { label: 'Command Palette...', key: 'Ctrl+Shift+P', cmd: 'palette' },
    '-',
    { label: 'Toggle Light/Dark Theme', cmd: 'toggleTheme' },
    { label: 'Zoom In', key: 'Ctrl+=', cmd: 'zoomIn' },
    { label: 'Zoom Out', key: 'Ctrl+-', cmd: 'zoomOut' },
    '-',
    { label: 'Developer Tools', key: 'Ctrl+Shift+I', cmd: 'devTools' }
  ]],
  ['&Project', [
    { label: 'Add Class...', key: 'Shift+Alt+C', cmd: 'addClass' },
    { label: 'Add New Item...', key: 'Ctrl+Shift+A', cmd: 'addNewItem' },
    { label: 'Add New Project to Solution...', cmd: 'addNewProject' },
    { label: 'Add Existing Project to Solution...', cmd: 'addExistingProject' },
    { label: 'Add Project Reference...', cmd: 'addProjectReference' },
    '-',
    { label: 'Manage NuGet Packages...', cmd: 'manageNuget' },
    { label: 'Set as Startup Project', cmd: 'setStartupFromSelection' },
    { label: 'Edit Project File', cmd: 'editProjectFile' },
    '-',
    { label: 'Switch Solution Explorer View (Solution / Folder)', cmd: 'toggleSolutionView' }
  ]],
  ['&Build', [
    { label: 'Build Solution', key: 'Ctrl+Shift+B', cmd: 'build' },
    { label: 'Rebuild Solution', cmd: 'rebuild' },
    { label: 'Clean Solution', cmd: 'clean' }
  ]],
  ['&Debug', [
    { label: 'Start Debugging', key: 'F5', cmd: 'debugStart' },
    { label: 'Start Without Debugging', key: 'Ctrl+F5', cmd: 'runNoDebug' },
    { label: 'Stop Debugging', key: 'Shift+F5', cmd: 'stop' },
    { label: 'Restart', key: 'Ctrl+Shift+F5', cmd: 'debugRestart' },
    { label: 'Break All', key: 'Ctrl+Alt+Pause', cmd: 'debugPause' },
    '-',
    { label: 'Step Over', key: 'F10', cmd: 'debugStepOver' },
    { label: 'Step Into', key: 'F11', cmd: 'debugStepInto' },
    { label: 'Step Out', key: 'Shift+F11', cmd: 'debugStepOut' },
    { label: 'Run to Cursor', key: 'Ctrl+F10', cmd: 'debugRunToCursor' },
    '-',
    { label: 'Toggle Breakpoint', key: 'F9', cmd: 'toggleBreakpoint' },
    { label: 'Add Conditional Breakpoint...', cmd: 'conditionalBreakpoint' },
    { label: 'Delete All Breakpoints', key: 'Ctrl+Shift+F9', cmd: 'deleteAllBreakpoints' },
    '-',
    { label: 'Windows', submenu: [
      { label: 'Locals', key: 'Ctrl+Alt+V', cmd: 'showLocals' },
      { label: 'Watch', key: 'Ctrl+Alt+W', cmd: 'showWatch' },
      { label: 'Call Stack', key: 'Ctrl+Alt+C', cmd: 'showCallStack' },
      { label: 'Breakpoints', key: 'Ctrl+Alt+B', cmd: 'showBreakpoints' },
      { label: 'Immediate', key: 'Ctrl+Alt+I', cmd: 'showImmediate' },
      { label: 'Show Diagnostic Tools', key: 'Ctrl+Alt+F2', cmd: 'showDiagnostics' }
    ] },
    { label: 'Performance Profiler...', key: 'Alt+F2', cmd: 'performanceProfiler' },
      { label: 'Open Last Performance Report', cmd: 'profilerReport' },
    '-',
    { label: 'Install / Update Debuggers...', cmd: 'debugInstallers' }
  ]],
  ['&Test', [
    { label: 'Run All Tests', chord: 'Ctrl+R, A', cmd: 'testRunAll' },
    { label: 'Run Tests (in context)', chord: 'Ctrl+R, T', cmd: 'testRunContext' },
    { label: 'Debug Tests (in context)', chord: 'Ctrl+R, Ctrl+T', cmd: 'testDebugContext' },
    { label: 'Run Failed Tests', chord: 'Ctrl+R, F', cmd: 'testRunFailed' },
    { label: 'Repeat Last Run', chord: 'Ctrl+R, L', cmd: 'testRepeat' },
    { label: 'Cancel Test Run', cmd: 'testCancel' },
    '-',
    { label: 'Analyze Code Coverage for All Tests', cmd: 'coverageAll' },
    { label: 'Analyze Code Coverage for Selected Tests', cmd: 'coverageSelected' },
    { label: 'Code Coverage Results', cmd: 'showCoverageResults' },
    { label: 'Show Code Coverage Coloring', cmd: 'coverageToggleColoring' },
    { label: 'Import Coverage Results...', cmd: 'coverageImport' },
    { label: 'Clear Coverage Results', cmd: 'coverageClear' },
    '-',
    { label: 'Test Explorer', chord: 'Ctrl+E, T', cmd: 'showTestExplorer' }
  ]],
  ['&Git', [
    { label: 'Commit or Stash...', cmd: 'showGit' },
    { label: 'Pull', cmd: 'gitPull' },
    { label: 'Push', cmd: 'gitPush' },
    { label: 'Switch Branch...', cmd: 'gitBranch' },
    '-',
    { label: 'Git Repository', chord: 'Ctrl+0, Ctrl+R', cmd: 'gitRepository' },
    { label: 'View Branch History', cmd: 'gitBranchHistory' },
    { label: 'View File History', cmd: 'gitFileHistory' },
    { label: 'Blame (Annotate)', cmd: 'gitBlame' },
    { label: 'Show Inline Blame', cmd: 'gitToggleInlineBlame' },
    '-',
    { label: 'View Pull Requests', cmd: 'pullRequests' },
    { label: 'New Pull Request...', cmd: 'newPullRequest' },
    { label: 'View Work Items', cmd: 'workItems' },
    { label: 'New Work Item...', cmd: 'newWorkItem' },
    { label: 'Accounts...', cmd: 'gitAccounts' },
    '-',
    { label: 'Merge Branch into Current...', cmd: 'gitMergeBranch' },
    { label: 'Resolve Conflicts', cmd: 'gitResolveConflicts' },
    { label: 'Continue Merge / Rebase', cmd: 'gitContinueOperation' },
    { label: 'Abort Merge / Rebase', cmd: 'gitAbortOperation' },
    '-',
    { label: 'Stash All', cmd: 'gitStash' },
    { label: 'Stash All and Keep Staged', cmd: 'gitStashKeepStaged' },
    { label: 'Stash All (Include Untracked)', cmd: 'gitStashUntracked' },
    '-',
    { label: 'Create Git Repository', cmd: 'gitInit' }
  ]],
  ['&Tools', [
    { label: 'New Terminal', key: 'Ctrl+Shift+`', cmd: 'newTerminal' },
    '-',
    { label: 'IntelliSense: Restart Language Servers', cmd: 'lspRestart' },
    { label: 'IntelliSense: Show Language Server Log', cmd: 'lspShowLog' },
    { label: 'IntelliSense: Install C# Language Server', cmd: 'lspInstallCsharp' },
    '-',
    { label: 'Extensions...', key: 'Ctrl+Shift+X', cmd: 'extensions' },
    { label: 'Options...', key: 'Ctrl+,', cmd: 'settings' }
  ]],
  ['&Window', [
    { label: 'New Window', cmd: 'newWindow' },
    { windows: true }
  ]],
  ['&Help', [
    { label: 'Keyboard Shortcuts', cmd: 'showShortcuts' },
    { label: 'Check for Updates...', cmd: 'checkUpdates' },
    { label: 'Open Logs Folder', cmd: 'openLogs' },
    '-',
    { label: 'About Nova IDE', cmd: 'about' }
  ]]
];

function flattenKeymap(items, out = []) {
  for (const it of items) {
    if (it === '-' || !it || it.windows) continue;
    if (it.submenu) flattenKeymap(it.submenu, out);
    else if (it.key && it.cmd) out.push({ key: it.key, cmd: it.cmd, editor: !!it.editor, label: it.label });
    else if (it.chord && it.cmd) out.push({ chord: it.chord, cmd: it.cmd, label: it.label });
  }
  return out;
}
const KEYMAP = flattenKeymap(MENU.flatMap(([, items]) => items));

// commands the main process runs itself (windows); everything else goes to the window the menu belongs to
const MAIN_COMMANDS = {
  newWindow: () => createWindow(),
  openFolderNewWindow: async (rec) => {
    const r = await dialog.showOpenDialog(rec ? rec.win : undefined, { title: 'Open Folder in New Window', properties: ['openDirectory'] });
    if (!r.canceled) openPath(r.filePaths[0], { newWindow: true });
  },
  closeWindow: (rec) => { if (rec) rec.win.close(); }
};
function runCommand(cmd, rec) {
  if (MAIN_COMMANDS[cmd]) return MAIN_COMMANDS[cmd](rec);
  if (rec) sendTo(rec, 'menu', cmd);
}
ipc.on('app:command', (e, cmd) => runCommand(cmd, recOf(e)));
const windowTitle = (r) => { const t = r.win.getTitle(); return t && t !== 'Nova IDE' ? t.replace(/ - Nova IDE$/, '') : (r.folder ? path.basename(r.folder) : 'Nova IDE (empty)'); };

let menuTimer = null;
function buildMenu() {
  // window titles change often: rebuild at most every 100 ms
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenuNow, 100);
}
function buildMenuNow() {
  const focused = focusedRec();
  const toItem = (it) => {
    if (it === '-') return { type: 'separator' };
    if (it.role) return it;
    if (it.windows) {
      const list = liveWindows();
      return list.length ? [{ type: 'separator' }, ...list.map((r, i) => ({ label: `&${i + 1} ${windowTitle(r)}`, type: 'radio', checked: r === focused, click: () => showWin(r.win) }))] : [];
    }
    if (it.submenu) return { label: it.label, submenu: it.submenu.flatMap(toItem) };
    // Electron can't show two-key chords as accelerators, so they go into the label
    return { label: it.chord ? `${it.label}\t${it.chord}` : it.label, accelerator: it.key, registerAccelerator: false,
      click: (_mi, bw) => runCommand(it.cmd, (bw && windows.get(bw.webContents.id)) || focusedRec()) };
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(MENU.map(([label, items]) => ({ label, submenu: items.flatMap(toItem) }))));
}
ipc.handle('menu:keymap', () => KEYMAP);
ipc.on('app:devtools', (e) => e.sender.toggleDevTools());

function createWindow({ open = null, restore = false, restoreTabs = false } = {}) {
  // new windows open a little down and to the right of the current one
  const prev = focusedRec();
  const pos = prev && !prev.win.isDestroyed() && !prev.win.isMaximized() ? (() => { const [x, y] = prev.win.getPosition(); return { x: x + 30, y: y + 30 }; })() : {};
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, ...pos,
    backgroundColor: '#1e1e1e', title: 'Nova IDE', icon: appIcon(),
    // backgroundThrottling off: a window behind another one keeps running its builds, tests and refreshes
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const rec = { win, id: win.webContents.id, ready: false, pendingOpen: open, restore, restoreTabs, folder: null };
  windows.set(rec.id, rec);
  lastFocused = rec;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('render-process-gone', async (_e, d) => {
    log.error(`window crashed: ${d.reason} (exit code ${d.exitCode})`);
    if (d.reason === 'clean-exit') return;
    const r = await dialog.showMessageBox({ type: 'error', title: 'Nova IDE', message: 'Nova IDE stopped working.', detail: `Reason: ${d.reason}. Details are in the log file:\n${log.file()}`, buttons: ['Reload', 'Close'] });
    if (r.response === 0 && !win.isDestroyed()) { rec.ready = false; rec.pendingOpen = rec.folder; rec.consumedLaunch = false; win.reload(); } else if (!win.isDestroyed()) { win.__forceClose = true; win.close(); }
  });
  // a reload (Reload Window, after installing an extension) brings back this window's folder and tabs
  win.webContents.on('did-start-loading', () => {
    rec.ready = false;
    if (rec.folder) { rec.pendingOpen = rec.folder; rec.consumedLaunch = false; rec.restoreTabs = true; }
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.on('focus', () => { lastFocused = rec; buildMenu(); });
  win.on('page-title-updated', () => buildMenu());
  win.on('close', (e) => {
    // Ask the window whether there are unsaved changes
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose');
  });
  win.on('closed', () => {
    windows.delete(rec.id);
    if (lastFocused === rec) lastFocused = null;
    // the last window closed by hand is what opens next time
    if (!quitting && !windows.size) sessionFolders = rec.folder ? [rec.folder] : [];
    // stop what this window started
    for (const s of services) { try { s.windowClosed && s.windowClosed(rec.id); } catch (err) { log.error('windowClosed', err); } }
    for (const [id, p] of [...procs]) if (p.owner === rec.id) killProc(id);
    // quitting with several windows: each one closes after its own "save changes?" question
    if (quitting && windows.size) app.quit();
    buildMenu();
  });
  buildMenu();
  return rec;
}
app.on('before-quit', () => {
  if (!quitting) sessionFolders = liveWindows().map((r) => r.folder).filter(Boolean);
  quitting = true;
});
const sessionFile = () => path.join(app.getPath('userData'), 'windows.json');
function saveSession() { try { fsSync.writeFileSync(sessionFile(), JSON.stringify({ folders: sessionFolders || [] }, null, 2)); } catch (e) { log.error('session save', e); } }
function loadSession() { try { return JSON.parse(fsSync.readFileSync(sessionFile(), 'utf8')).folders.filter((f) => fsSync.existsSync(f)); } catch { return null; } }

// ---------- File system ----------
ipc.handle('dialog:openFolder', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipc.handle('dialog:openFile', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipc.handle('dialog:openFiltered', async (e, title, filters) => {
  const r = await dialog.showOpenDialog(winOf(e), { title, properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
ipc.handle('dialog:saveAs', async (e, defaultPath) => {
  const r = await dialog.showSaveDialog(winOf(e), { defaultPath });
  return r.canceled ? null : r.filePath;
});
ipc.handle('fs:readDir', async (_e, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((d) => d.name !== '.git')
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
});
ipc.handle('fs:readFile', (_e, p) => fs.readFile(p, 'utf8'));
ipc.handle('fs:writeFile', (_e, p, content) => fs.writeFile(p, content, 'utf8'));
ipc.handle('fs:createFile', async (_e, p) => { await fs.writeFile(p, '', { flag: 'wx' }); return p; });
ipc.handle('fs:createDir', async (_e, p) => { await fs.mkdir(p, { recursive: true }); return p; });
ipc.handle('fs:rename', (_e, from, to) => fs.rename(from, to));
ipc.handle('fs:trash', (_e, p) => shell.trashItem(p));
ipc.handle('fs:reveal', (_e, p) => shell.showItemInFolder(p));

// ---------- Project detection ----------
async function findFiles(root, re, depth = 3, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await findFiles(full, re, depth - 1, out); }
    else if (re.test(e.name)) out.push(full);
  }
  return out;
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

ipc.handle('project:detect', async (_e, root) => {
  const slns = await findFiles(root, /\.sln$/i, 1);
  const projs = await findFiles(root, /\.(csproj|fsproj|vbproj)$/i, 3);
  if (slns.length || projs.length) {
    let startup = projs[0] || null;
    for (const p of projs) {
      try { if (/<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(await fs.readFile(p, 'utf8'))) { startup = p; break; } } catch {}
    }
    return { type: 'dotnet', label: '.NET', solution: slns[0] || null, projects: projs, startup };
  }
  if (await exists(path.join(root, 'pubspec.yaml'))) return { type: 'flutter', label: 'Flutter' };
  if (await exists(path.join(root, 'package.json'))) {
    let scripts = {};
    try { scripts = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch {}
    return { type: 'node', label: 'Node.js', scripts };
  }
  if ((await findFiles(root, /\.py$/i, 1)).length) return { type: 'python', label: 'Python' };
  return { type: 'folder', label: 'Folder' };
});

// ---------- Find in files ----------
ipc.handle('search:inFiles', async (_e, root, query, opts = {}) => {
  const results = [];
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  async function walk(dir) {
    if (results.length >= 1000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full); continue; }
      if (!TEXT_EXT.test(e.name)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > 1024 * 1024) continue;
        const lines = (await fs.readFile(full, 'utf8')).split(/\r?\n/);
        lines.forEach((line, i) => {
          const hay = opts.caseSensitive ? line : line.toLowerCase();
          const col = hay.indexOf(needle);
          if (col >= 0 && results.length < 1000) results.push({ file: full, line: i + 1, col: col + 1, text: line.trim().slice(0, 200) });
        });
      } catch {}
    }
  }
  await walk(root);
  return results;
});

// ---------- Processes (build / run) ----------
ipc.handle('proc:run', (_e, { command, cwd, env: extraEnv }) => {
  const id = nextProcId++;
  // own process group off Windows, so Stop ends the program and not just the shell around it
  const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', ...(extraEnv || {}) } });
  procs.set(id, { child, owner: ownerId() });
  child.stdout.on('data', (d) => send('proc:data', { id, data: d.toString(), stream: 'stdout' }));
  child.stderr.on('data', (d) => send('proc:data', { id, data: d.toString(), stream: 'stderr' }));
  child.on('error', (err) => send('proc:data', { id, data: `\n${err.message}\n`, stream: 'stderr' }));
  child.on('close', (code) => { procs.delete(id); send('proc:exit', { id, code }); });
  return id;
});
function killProc(id) {
  const p = procs.get(id);
  if (!p) return false;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F']);
  else { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { p.child.kill('SIGTERM'); } }
  return true;
}
ipc.handle('proc:kill', (_e, id) => killProc(id));

ipc.on('app:confirmClose', (e) => { const w = winOf(e); if (w) { w.__forceClose = true; w.close(); } });

// ---------- Phase 2 services ----------
const services = [
  require('./main/settings'),
  require('./main/terminal'),
  require('./main/git'),
  require('./main/workspace'),
  require('./main/lsp'),
  require('./main/dap'),
  require('./main/solution'),
  require('./main/updater'),
  require('./main/extensions'),
  require('./main/tests'),
  require('./main/coverage'),
  require('./main/githistory'),
  require('./main/gitmerge'),
  require('./main/pullrequests'),
  require('./main/workitems'),
  require('./main/diagnostics'), require('./main/profiler')
];
for (const s of services) s.register({ ipcMain: ipc, send, broadcast, ownerId, app, SKIP_DIRS, procPid: (id) => { const p = procs.get(id); return p ? p.child.pid : null; } });

app.whenReady().then(() => {
  if (!gotLock) return;
  buildMenu();
  // opened with a path: one window for it. Otherwise the windows of the last session (the first one also
  // gets the old "last folder + tabs" restore when there is no session file yet)
  if (startPath) { createWindow({ open: startPath }); return; }
  const folders = loadSession();
  if (!folders) { createWindow({ restore: true }); return; }
  if (!folders.length) { createWindow(); return; }
  folders.forEach((f) => createWindow({ open: f, restoreTabs: true }));
});
// app.quit() skips window-all-closed, so the session is written when the app really ends
app.on('will-quit', () => saveSession());
app.on('window-all-closed', () => {
  for (const id of [...procs.keys()]) { try { killProc(id); } catch {} }
  for (const s of services) { try { s.dispose && s.dispose(); } catch {} }
  app.quit();
});
