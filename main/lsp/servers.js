// Nova IDE - language server registry
// Bundled servers (no install needed): TypeScript/JavaScript, Python.
// External servers (used automatically when installed): C# (csharp-ls), Dart/Flutter, C/C++ (clangd), Go (gopls), Rust (rust-analyzer).
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const isWin = process.platform === 'win32';
const home = os.homedir();
const env = (k) => process.env[k] || '';

// In the installed app, packages live in app.asar; servers must run from the unpacked copy
// (see "asarUnpack" in package.json), because a separate Node process can't use the archive reliably.
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

// Run a bundled Node-based server with Electron's own Node runtime (no separate Node install required)
function bundled(pkg, relBin) {
  try {
    const dir = unpacked(path.dirname(require.resolve(`${pkg}/package.json`)));
    const file = path.join(dir, relBin);
    if (!fs.existsSync(file)) return null;
    return { command: process.execPath, args: [file, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  } catch { return null; }
}

// Find an executable on PATH or in well-known install folders
function findExecutable(name, extraDirs = []) {
  const exts = isWin ? (env('PATHEXT') || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...env('PATH').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of isWin ? ['', ...exts] : ['']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try { if (fs.statSync(file).isFile() && (isWin ? ext !== '' || /\.(exe|cmd|bat|com)$/i.test(name) : true)) return file; } catch {}
    }
  }
  return null;
}

// .bat/.cmd files must go through the shell on Windows
function external(file, args) {
  if (!file) return null;
  if (isWin && /\.(bat|cmd)$/i.test(file)) return { command: `"${file}"`, args, shell: true };
  return { command: file, args };
}

const SERVERS = [
  {
    id: 'typescript',
    name: 'TypeScript/JavaScript',
    languages: ['typescript', 'javascript'],
    bundled: true,
    resolve: () => bundled('typescript-language-server', 'lib/cli.mjs'),
    initializationOptions: () => {
      let tsserverPath;
      try { tsserverPath = unpacked(require.resolve('typescript/lib/tsserver.js')); } catch {}
      return { hostInfo: 'nova-ide', tsserver: tsserverPath ? { path: tsserverPath } : undefined, preferences: {
        includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true,
        // inline hints (shown only while the "Inline hints" option is on)
        includeInlayParameterNameHints: 'literals', includeInlayParameterNameHintsWhenArgumentMatchesName: false,
        includeInlayFunctionParameterTypeHints: true, includeInlayVariableTypeHints: true, includeInlayVariableTypeHintsWhenTypeMatchesName: false,
        includeInlayPropertyDeclarationTypeHints: true, includeInlayFunctionLikeReturnTypeHints: true, includeInlayEnumMemberValueHints: true
      } };
    }
  },
  {
    id: 'python',
    name: 'Python (Pyright)',
    languages: ['python'],
    bundled: true,
    resolve: () => bundled('pyright', 'langserver.index.js'),
    settings: { python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } } }
  },
  {
    id: 'csharp',
    name: 'C# (csharp-ls)',
    languages: ['csharp'],
    resolve: () => {
      const f = findExecutable('csharp-ls', [path.join(home, '.dotnet', 'tools')]);
      return f ? external(f, []) : null;
    },
    missing: 'C# IntelliSense needs the csharp-ls language server.',
    install: { label: 'Install C# language server', command: 'dotnet tool install --global csharp-ls', check: 'dotnet --version', checkHint: 'Install the .NET SDK first: https://dotnet.microsoft.com/download' },
    settings: { csharp: {} }
  },
  {
    id: 'dart',
    name: 'Dart/Flutter',
    languages: ['dart'],
    resolve: () => {
      const f = findExecutable('dart', [
        'C:\\flutter\\bin', 'C:\\src\\flutter\\bin', path.join(home, 'flutter', 'bin'),
        path.join(home, 'fvm', 'default', 'bin'), path.join(env('LOCALAPPDATA'), 'flutter', 'bin'), 'C:\\tools\\dart-sdk\\bin'
      ]);
      return f ? external(f, ['language-server', '--protocol=lsp', '--client-id=nova-ide', '--client-version=0.3']) : null;
    },
    missing: 'Dart/Flutter IntelliSense needs the Dart or Flutter SDK on PATH.',
    initializationOptions: () => ({ onlyAnalyzeProjectsWithOpenFiles: true, closingLabels: false, outline: false, flutterOutline: false })
  },
  {
    id: 'clangd',
    name: 'C/C++ (clangd)',
    languages: ['c', 'cpp'],
    resolve: () => external(findExecutable('clangd', ['C:\\Program Files\\LLVM\\bin']), ['--background-index']),
    missing: 'C/C++ IntelliSense needs clangd (install LLVM).'
  },
  {
    id: 'go',
    name: 'Go (gopls)',
    languages: ['go'],
    resolve: () => external(findExecutable('gopls', [path.join(home, 'go', 'bin')]), []),
    missing: 'Go IntelliSense needs gopls: go install golang.org/x/tools/gopls@latest'
  },
  {
    id: 'rust',
    name: 'Rust (rust-analyzer)',
    languages: ['rust'],
    resolve: () => external(findExecutable('rust-analyzer', [path.join(home, '.cargo', 'bin')]), []),
    missing: 'Rust IntelliSense needs rust-analyzer: rustup component add rust-analyzer'
  }
];

/**
 * Pick the server for a Monaco language id, applying user overrides from settings.lspServers:
 *   "lspServers": { "csharp": { "command": "C:\\tools\\csharp-ls.exe", "args": [] }, "python": false }
 */
function serverFor(languageId, overrides = {}) {
  const def = SERVERS.find((s) => s.languages.includes(languageId));
  if (!def) return null;
  const o = overrides[def.id];
  if (o === false) return { def, disabled: true };
  if (o && o.command) return { def, spec: external(o.command, o.args || []) };
  return { def, spec: def.resolve() };
}

module.exports = { SERVERS, serverFor, findExecutable, unpacked };
