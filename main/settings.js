// Nova IDE - user settings stored as JSON in the app's userData folder
const path = require('path');
const fs = require('fs/promises');

const DEFAULTS = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'Cascadia Mono, Consolas, monospace',
  tabSize: 4,
  insertSpaces: true,
  wordWrap: 'off',
  minimap: true,
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  autoSave: 'off',          // off | afterDelay | onFocusChange
  autoSaveDelay: 1000,
  formatOnSave: false,
  editorConfig: true,       // follow .editorconfig files (indent, line endings, trailing whitespace, final newline)
  aiProvider: 'anthropic',  // AI Chat: anthropic | openai (OpenAI-compatible) | ollama
  aiModel: '',              // empty: the provider's default
  aiBaseUrl: '',            // empty: the provider's default address
  dockerPath: 'docker',     // Containers window: the docker CLI (or podman)
  syncGistId: '',           // Settings Sync: the secret gist that holds the settings
  syncGithubHost: 'github.com',
  spellCheck: true,         // spelling in comments, strings and text files
  inlayHints: false,        // inline parameter name / type hints from the language server (VS: off until Alt+F1)
  taskListTokens: 'TODO, HACK, UNDONE, FIXME', // comment tokens listed in the Task List
  terminalShell: '',        // empty = auto (PowerShell on Windows)
  terminalFontSize: 13,
  explorerAutoRefresh: true,
  reloadChangedFiles: true,
  intellisense: true,       // language servers on/off
  lspServers: {},           // per-server overrides, e.g. { "csharp": { "command": "C:\\tools\\csharp-ls.exe", "args": [] }, "python": false }
  showIntelliSenseErrors: true, // list IntelliSense errors in the Error List (like VS "Build + IntelliSense")
  pythonPath: '',           // python.exe used for running/debugging Python (empty = auto-detect)
  debuggers: {},            // custom debugger paths, e.g. { "netcoredbg": "C:\\tools\\netcoredbg\\netcoredbg.exe" }
  breakOnUncaughtExceptions: true,
  diagShowOnDebug: true,    // open Diagnostic Tools when debugging starts (like Visual Studio)
  breakOnAsyncUserUnhandled: false, // .NET: break when an exception leaves an async method into its Task (VS doesn't)
  hotReloadBrowser: true,   // Hot Reload of a web app opens the browser (dotnet watch launchBrowser)
  nugetSource: 'https://api.nuget.org/v3/index.json', // package source used by Manage NuGet Packages (v3 feed)
  nugetPrerelease: false,
  updateUrl: '',            // where updates are published: a folder URL with latest.yml (electron-builder "generic")
  updateGithub: '',         // or "owner/repo" for GitHub Releases
  checkUpdatesOnStartup: true,
  gitInlineBlame: true,
  githubApiUrl: '',         // empty = api.github.com (or https://<host>/api/v3 for GitHub Enterprise)
  azureDevOpsUrl: '',       // empty = https://dev.azure.com (set it for Azure DevOps Server)     // show author + commit of the cursor line at the end of the line
  disabledExtensions: []
};

let file;
let cache = null;

async function read() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(await fs.readFile(file, 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
  return cache;
}

async function write(next) {
  cache = { ...DEFAULTS, ...next };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

module.exports = {
  DEFAULTS,
  read,
  write,
  register({ ipcMain, send, broadcast, app }) {
    file = path.join(app.getPath('userData'), 'settings.json');
    ipcMain.handle('settings:get', () => read());
    ipcMain.handle('settings:defaults', () => ({ ...DEFAULTS }));
    ipcMain.handle('settings:set', async (_e, next) => {
      const s = await write(next);
      (broadcast || send)('settings:changed', s); // every window
      return s;
    });
    ipcMain.handle('settings:path', () => file);
  }
};
