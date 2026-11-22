// Nova IDE - Command Palette (Ctrl+Shift+P) and Go to File (Ctrl+P)
// In the box:  ">" = commands,  ":" = go to line,  anything else = files
'use strict';

const COMMAND_LIST = [
  ['openFolder', 'File: Open Folder...', 'Ctrl+Shift+O'],
  ['openFile', 'File: Open File...', 'Ctrl+O'],
  ['newFile', 'File: New File', 'Ctrl+N'],
  ['save', 'File: Save', 'Ctrl+S'],
  ['saveAll', 'File: Save All', 'Ctrl+Shift+S'],
  ['closeTab', 'File: Close Tab', 'Ctrl+F4'],
  ['closeAllTabs', 'File: Close All Tabs', ''],
  ['find', 'Edit: Find', 'Ctrl+F'],
  ['replace', 'Edit: Replace', 'Ctrl+H'],
  ['findInFiles', 'Edit: Find in Files', 'Ctrl+Shift+F'],
  ['gotoLine', 'Edit: Go to Line...', 'Ctrl+G'],
  ['format', 'Edit: Format Document', 'Ctrl+K, Ctrl+D'],
  ['comment', 'Edit: Toggle Comment', 'Ctrl+/'],
  ['toggleExplorer', 'View: Toggle Solution Explorer', 'Ctrl+Alt+L'],
  ['showOutput', 'View: Output', 'Ctrl+Alt+O'],
  ['showErrors', 'View: Error List', 'Ctrl+\\'],
  ['showTerminal', 'View: Terminal', 'Ctrl+`'],
  ['showGit', 'View: Git Changes', 'Ctrl+Alt+G'],
  ['toggleTheme', 'View: Toggle Light/Dark Theme', ''],
  ['zoomIn', 'View: Zoom In', 'Ctrl+='],
  ['zoomOut', 'View: Zoom Out', 'Ctrl+-'],
  ['build', 'Build: Build Solution', 'Ctrl+Shift+B'],
  ['rebuild', 'Build: Rebuild Solution', ''],
  ['clean', 'Build: Clean Solution', ''],
  ['debugStart', 'Debug: Start Debugging / Continue', 'F5'],
  ['runNoDebug', 'Debug: Start Without Debugging', 'Ctrl+F5'],
  ['stop', 'Debug: Stop Debugging', 'Shift+F5'],
  ['debugRestart', 'Debug: Restart', 'Ctrl+Shift+F5'],
  ['debugPause', 'Debug: Break All', 'Ctrl+Alt+Break'],
  ['debugStepOver', 'Debug: Step Over', 'F10'],
  ['debugStepInto', 'Debug: Step Into', 'F11'],
  ['debugStepOut', 'Debug: Step Out', 'Shift+F11'],
  ['debugRunToCursor', 'Debug: Run to Cursor', 'Ctrl+F10'],
  ['toggleBreakpoint', 'Debug: Toggle Breakpoint', 'F9'],
  ['conditionalBreakpoint', 'Debug: Add Conditional Breakpoint...', ''],
  ['deleteAllBreakpoints', 'Debug: Delete All Breakpoints', 'Ctrl+Shift+F9'],
  ['addWatchFromEditor', 'Debug: Add Watch', ''],
  ['showLocals', 'Debug: Locals Window', 'Ctrl+Alt+V'],
  ['showWatch', 'Debug: Watch Window', 'Ctrl+Alt+W'],
  ['showCallStack', 'Debug: Call Stack Window', 'Ctrl+Alt+C'],
  ['showBreakpoints', 'Debug: Breakpoints Window', 'Ctrl+Alt+B'],
  ['showImmediate', 'Debug: Immediate Window', 'Ctrl+Alt+I'],
  ['debugInstallers', 'Debug: Install / Update Debuggers', ''],
  ['newTerminal', 'Terminal: New Terminal', 'Ctrl+Shift+`'],
  ['killTerminal', 'Terminal: Kill Active Terminal', ''],
  ['gitRefresh', 'Git: Refresh', ''],
  ['gitCommitPrompt', 'Git: Commit All...', ''],
  ['gitPull', 'Git: Pull', ''],
  ['gitPush', 'Git: Push', ''],
  ['gitFetch', 'Git: Fetch', ''],
  ['gitBranch', 'Git: Switch / Create Branch...', ''],
  ['gitInit', 'Git: Create Repository', ''],
  ['gotoSymbolWorkspace', 'Go to All (symbol in folder)...', 'Ctrl+T'],
  ['gotoSymbolFile', 'Go to Member (symbol in file)...', 'Alt+\\'],
  ['gotoDefinition', 'IntelliSense: Go to Definition', 'F12'],
  ['peekDefinition', 'IntelliSense: Peek Definition', 'Alt+F12'],
  ['gotoImplementation', 'IntelliSense: Go to Implementation', 'Ctrl+F12'],
  ['findReferences', 'IntelliSense: Find All References', 'Shift+F12'],
  ['renameSymbol', 'IntelliSense: Rename...', 'Ctrl+R, Ctrl+R'],
  ['quickActions', 'IntelliSense: Quick Actions and Refactorings...', 'Ctrl+.'],
  ['triggerSuggest', 'IntelliSense: List Members', 'Ctrl+Space'],
  ['parameterInfo', 'IntelliSense: Parameter Info', 'Ctrl+Shift+Space'],
  ['quickInfo', 'IntelliSense: Quick Info', ''],
  ['organizeImports', 'IntelliSense: Organize Imports / Usings', ''],
  ['lspRestart', 'IntelliSense: Restart Language Servers', ''],
  ['lspShowLog', 'IntelliSense: Show Language Server Log', ''],
  ['lspInstallCsharp', 'IntelliSense: Install C# Language Server', ''],
  ['commentLines', 'Edit: Comment Selection', 'Ctrl+K, Ctrl+C'],
  ['uncommentLines', 'Edit: Uncomment Selection', 'Ctrl+K, Ctrl+U'],
  ['showShortcuts', 'Help: Keyboard Shortcuts', ''],
  ['newProject', 'File: New Project...', 'Ctrl+Shift+N'],
  ['openSolution', 'File: Open Project/Solution...', ''],
  ['addNewProject', 'Solution: Add New Project...', ''],
  ['addExistingProject', 'Solution: Add Existing Project...', ''],
  ['toggleSolutionView', 'Solution Explorer: Switch Solution / Folder View', ''],
  ['addClass', 'Project: Add Class...', 'Shift+Alt+C'],
  ['addNewItem', 'Project: Add New Item...', 'Ctrl+Shift+A'],
  ['addProjectReference', 'Project: Add Project Reference...', ''],
  ['manageNuget', 'Project: Manage NuGet Packages...', ''],
  ['setStartupFromSelection', 'Project: Set as Startup Project', ''],
  ['editProjectFile', 'Project: Edit Project File', ''],
  ['showTestExplorer', 'Test: Test Explorer', 'Ctrl+E, T'],
  ['testRunAll', 'Test: Run All Tests', 'Ctrl+R, A'],
  ['testRunContext', 'Test: Run Tests (in context)', 'Ctrl+R, T'],
  ['testDebugContext', 'Test: Debug Tests (in context)', 'Ctrl+R, Ctrl+T'],
  ['testRunFailed', 'Test: Run Failed Tests', 'Ctrl+R, F'],
  ['testRepeat', 'Test: Repeat Last Run', 'Ctrl+R, L'],
  ['newWindow', 'File: New Window', 'Ctrl+Alt+Shift+N'],
  ['openFolderNewWindow', 'File: Open Folder in New Window...', ''],
  ['closeWindow', 'File: Close Window', ''],
  ['pullRequests', 'Git: View Pull Requests', ''],
  ['newPullRequest', 'Git: New Pull Request...', ''],
  ['showDiagnostics', 'Debug: Show Diagnostic Tools', 'Ctrl+Alt+F2'],
  ['performanceProfiler', 'Debug: Performance Profiler (CPU + memory without the debugger)', 'Alt+F2'],
  ['hotReloadStart', 'Debug: Start With Hot Reload (.NET)', 'Alt+Shift+F5'],
  ['hotReloadApply', 'Debug: Apply Code Changes (Hot Reload)', 'Alt+F10'],
  ['diagSnapshot', 'Debug: Take Memory Snapshot', ''],
  ['workItems', 'Git: View Work Items (Issues / Azure Boards)', ''],
  ['newWorkItem', 'Git: New Work Item...', ''],
  ['gitAccounts', 'Git: Accounts (GitHub / Azure DevOps sign-in)', ''],
  ['gitMergeBranch', 'Git: Merge Branch into Current...', ''],
  ['gitResolveConflicts', 'Git: Resolve Conflicts (Merge Editor)', ''],
  ['gitContinueOperation', 'Git: Continue Merge / Rebase', ''],
  ['gitAbortOperation', 'Git: Abort Merge / Rebase', ''],
  ['gitStash', 'Git: Stash All', ''],
  ['gitStashKeepStaged', 'Git: Stash All and Keep Staged', ''],
  ['gitStashUntracked', 'Git: Stash All (Include Untracked)', ''],
  ['gitRepository', 'Git: Git Repository (history graph)', 'Ctrl+0, Ctrl+R'],
  ['gitBranchHistory', 'Git: View Branch History', ''],
  ['gitFileHistory', 'Git: View File History', ''],
  ['gitBlame', 'Git: Blame (Annotate)', ''],
  ['gitToggleInlineBlame', 'Git: Show/Hide Inline Blame', ''],
  ['coverageAll', 'Test: Analyze Code Coverage for All Tests', ''],
  ['coverageSelected', 'Test: Analyze Code Coverage for Selected Tests', ''],
  ['showCoverageResults', 'Test: Code Coverage Results', ''],
  ['coverageToggleColoring', 'Test: Show/Hide Code Coverage Coloring', ''],
  ['coverageImport', 'Test: Import Coverage Results...', ''],
  ['coverageClear', 'Test: Clear Coverage Results', ''],
  ['testCancel', 'Test: Cancel Test Run', ''],
  ['extensions', 'Tools: Extensions...', 'Ctrl+Shift+X'],
  ['reloadWindow', 'Developer: Reload Window', ''],
  ['checkUpdates', 'Help: Check for Updates...', ''],
  ['openLogs', 'Help: Open Logs Folder', ''],
  ['about', 'Help: About Nova IDE', ''],
  ['settings', 'Tools: Options...', 'Ctrl+,'],
  ['refreshExplorer', 'Solution Explorer: Refresh', ''],
  ['collapseAll', 'Solution Explorer: Collapse All', '']
];

// Fuzzy match: all query chars in order. Returns score (higher = better) or -1.
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase().replace(/\\/g, '/'), t = text.toLowerCase().replace(/\\/g, '/');
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (t.length - q.length) * 0.1;
  let ti = 0, score = 0, prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    score += idx === prev + 1 ? 5 : 1;            // consecutive bonus
    if (idx === 0 || /[\\/._\s-]/.test(t[idx - 1])) score += 3; // word start bonus
    prev = idx; ti = idx + 1;
  }
  return score - t.length * 0.01;
}

const palette = { mode: 'files', items: [], sel: 0, files: null, filesRoot: null, recentCmds: [], symToken: 0, symTimer: null };
try { palette.recentCmds = JSON.parse(localStorage.getItem('recentCmds') || '[]'); } catch {}

async function loadFileIndex(force) {
  if (!state.root) { palette.files = []; return; }
  if (!force && palette.files && palette.filesRoot === state.root) return;
  palette.files = await api.ws.listFiles(state.root);
  palette.filesRoot = state.root;
}
bus.on('folder', () => { palette.files = null; });
api.on('fs:changed', () => { palette.files = null; }); // rebuild lazily next time

function openPalette(prefix = '') {
  const box = $('#palette');
  const input = $('#paletteInput');
  box.classList.remove('hidden');
  input.value = prefix;
  input.focus();
  refreshPalette();
  if (!prefix) loadFileIndex().then(refreshPalette);
}

function closePalette(refocus = true) {
  $('#palette').classList.add('hidden');
  if (refocus && editor && state.active) editor.focus();
}

async function refreshPalette() {
  const raw = $('#paletteInput').value;
  const hint = $('#paletteHint');
  let items = [];

  if (raw.startsWith('>')) {
    palette.mode = 'commands';
    const q = raw.slice(1).trim();
    items = COMMAND_LIST.filter(([id]) => commands[id])
      .map(([id, label, key]) => {
        const recent = palette.recentCmds.indexOf(id);
        const s = q ? fuzzyScore(q, label) : (recent >= 0 ? 100 - recent : 0);
        return { id, label, detail: key, score: s, recent: recent >= 0 && !q };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    hint.textContent = 'Type to filter commands · Enter to run · Esc to close';
  } else if (raw.startsWith('#') || raw.startsWith('@')) {
    // '#' = symbols in the whole folder (Go to All), '@' = symbols in the current file (Go to Member)
    palette.mode = 'symbols';
    const ws = raw.startsWith('#');
    const q = raw.slice(1).trim();
    const token = ++palette.symToken;
    hint.textContent = ws ? 'Symbols in folder · type a name (language server required)' : 'Symbols in this file';
    if (ws && !q) items = [{ id: 'none', label: 'Type a symbol name...' }];
    else {
      renderPaletteItems([{ id: 'none', label: 'Searching...' }]);
      clearTimeout(palette.symTimer);
      await new Promise((r) => { palette.symTimer = setTimeout(r, ws ? 200 : 0); });
      if (token !== palette.symToken) return;
      let syms = ws ? await window.lspWorkspaceSymbols(q) : await window.lspDocumentSymbols(state.active && state.active.model);
      if (token !== palette.symToken) return;
      if (!syms) items = [{ id: 'none', label: state.active ? 'No language server for this file' : 'Open a file first' }];
      else {
        if (q) syms = syms.map((s) => ({ ...s, score: fuzzyScore(q, s.name) })).filter((s) => s.score >= 0).sort((a, b) => b.score - a.score);
        items = syms.slice(0, 100).map((s) => ({
          id: 'symbol', label: `${window.symbolIcon(s.kind)} ${s.name}`,
          detail: ws ? `${s.container ? `${s.container} · ` : ''}${s.path.slice(state.root ? state.root.length + 1 : 0)}` : s.container,
          path: s.path || (state.active && state.active.path), line: s.line, col: s.col
        }));
        if (!items.length) items = [{ id: 'none', label: 'No matching symbols' }];
      }
    }
  } else if (raw.startsWith(':')) {
    palette.mode = 'line';
    const n = parseInt(raw.slice(1), 10);
    const max = state.active ? state.active.model.getLineCount() : 0;
    items = state.active
      ? [{ id: 'line', label: Number.isFinite(n) ? `Go to line ${Math.min(Math.max(1, n), max)}` : `Type a line number between 1 and ${max}`, line: n }]
      : [{ id: 'none', label: 'Open a file first' }];
    hint.textContent = '';
  } else {
    palette.mode = 'files';
    const q = raw.trim();
    if (!state.root) items = [{ id: 'none', label: 'Open a folder to search files (Ctrl+Shift+O)' }];
    else if (!palette.files) items = [{ id: 'none', label: 'Indexing files...' }];
    else {
      const rootLen = state.root.length + 1;
      const open = new Set(state.tabs.map((t) => t.path));
      const scored = [];
      for (const f of palette.files) {
        const rel = f.slice(rootLen);
        const name = baseName(f);
        let s;
        if (!q) s = open.has(f) ? 10 : 0;
        else {
          const sn = fuzzyScore(q, name);
          const sp = fuzzyScore(q, rel);
          s = Math.max(sn >= 0 ? sn + 50 : -1, sp);
        }
        if (s >= 0) scored.push({ id: 'file', path: f, label: name, detail: /[\\/]/.test(rel) ? dirName(rel) : '.', score: s });
      }
      scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
      items = scored.slice(0, 60);
      if (!items.length) items = [{ id: 'none', label: 'No matching files' }];
    }
    hint.textContent = `${palette.files ? palette.files.length : 0} files · ">" commands · "#" symbols · "@" in file · ":" line`;
  }

  renderPaletteItems(items);
}

function renderPaletteItems(items) {
  const list = $('#paletteList');
  palette.items = items;
  palette.sel = 0;
  list.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'pal-item' + (i === 0 ? ' sel' : '');
    row.innerHTML = `<span class="pal-label"></span><span class="pal-detail"></span>`;
    row.querySelector('.pal-label').textContent = (it.id === 'file' ? `${ICONS[ext(it.path)] || '📄'} ` : '') + it.label + (it.recent ? '  · recently used' : '');
    row.querySelector('.pal-detail').textContent = it.detail || '';
    row.onmousedown = (e) => { e.preventDefault(); palette.sel = i; acceptPalette(); };
    list.appendChild(row);
  });
}

function movePalette(delta) {
  const rows = $('#paletteList').children;
  if (!rows.length) return;
  rows[palette.sel] && rows[palette.sel].classList.remove('sel');
  palette.sel = (palette.sel + delta + rows.length) % rows.length;
  rows[palette.sel].classList.add('sel');
  rows[palette.sel].scrollIntoView({ block: 'nearest' });
}

function acceptPalette() {
  const it = palette.items[palette.sel];
  if (!it || it.id === 'none') return;
  if (palette.mode === 'commands') {
    closePalette(false);
    palette.recentCmds = [it.id, ...palette.recentCmds.filter((c) => c !== it.id)].slice(0, 8);
    try { localStorage.setItem('recentCmds', JSON.stringify(palette.recentCmds)); } catch {}
    commands[it.id]();
  } else if (palette.mode === 'symbols') {
    closePalette(false);
    openFile(it.path, it.line, it.col);
  } else if (palette.mode === 'line') {
    if (!Number.isFinite(it.line)) return;
    closePalette();
    const ln = Math.min(Math.max(1, it.line), state.active.model.getLineCount());
    editor.revealLineInCenter(ln); editor.setPosition({ lineNumber: ln, column: 1 });
  } else {
    closePalette(false);
    openFile(it.path);
  }
}

$('#paletteInput').addEventListener('input', refreshPalette);
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
  else if (e.key === 'PageDown') { e.preventDefault(); movePalette(10); }
  else if (e.key === 'PageUp') { e.preventDefault(); movePalette(-10); }
  else if (e.key === 'Enter') { e.preventDefault(); acceptPalette(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('#paletteInput').addEventListener('blur', () => setTimeout(() => closePalette(false), 100));
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

commands.palette = () => openPalette('>');
commands.gotoSymbolWorkspace = () => openPalette('#');
commands.gotoSymbolFile = () => openPalette('@');
commands.quickOpen = () => openPalette('');
commands.closeAllTabs = async () => { for (const t of [...state.tabs]) await closeTab(t); };
