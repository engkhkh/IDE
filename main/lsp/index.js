// Nova IDE - language server manager (main process)
// One server process per (server type, workspace folder). The renderer talks to servers through IPC.
'use strict';
const path = require('path');
const { exec } = require('child_process');
const { LspConnection } = require('./connection');
const { serverFor, SERVERS } = require('./servers');
const settings = require('../settings');

const servers = new Map();      // key -> server record
const forwarded = new Map();    // forwarded server->client request id -> { key, id }
let nextForward = 1;
let send = () => {};
let ownerId = () => 0; // the window making the current request

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    executeCommand: {}
  },
  textDocument: {
    synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true, commitCharactersSupport: true, deprecatedSupport: true, preselectSupport: true,
        insertReplaceSupport: true, labelDetailsSupport: true, tagSupport: { valueSet: [1] },
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) }
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    codeAction: {
      isPreferredSupport: true, dataSupport: true, disabledSupport: true,
      resolveSupport: { properties: ['edit'] },
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } }
    },
    formatting: {}, rangeFormatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true }
  },
  window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } }
};

function state(rec, st, message) {
  rec.state = st;
  send('lsp:state', { key: rec.key, serverId: rec.def.id, name: rec.def.name, root: rec.root, state: st, message: message || '' });
}

// Look up "a.b.c" in the server's settings object (for workspace/configuration)
function configValue(def, section) {
  const all = { ...(def.settings || {}) };
  if (!section) return all;
  return section.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), all) ?? null;
}

async function handleServerRequest(rec, msg) {
  const { conn, def } = rec;
  switch (msg.method) {
    case 'workspace/configuration':
      return conn.respond(msg.id, (msg.params.items || []).map((it) => configValue(def, it.section)));
    case 'workspace/workspaceFolders':
      return conn.respond(msg.id, [{ uri: rec.rootUri, name: path.basename(rec.root) }]);
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return conn.respond(msg.id, null);
    case 'window/showMessageRequest':
      send('lsp:notification', { key: rec.key, method: 'window/showMessage', params: msg.params });
      return conn.respond(msg.id, null);
    case 'window/showDocument':
    case 'workspace/applyEdit': {
      // the renderer owns the editor models, so it applies edits and answers
      const fid = nextForward++;
      forwarded.set(fid, { key: rec.key, id: msg.id });
      send('lsp:serverRequest', { key: rec.key, fid, method: msg.method, params: msg.params });
      return;
    }
    default:
      return conn.respond(msg.id, null, { code: -32601, message: `Unhandled method ${msg.method}` });
  }
}

async function start(def, spec, root, rootUri, owner) {
  const key = `${owner}|${def.id}|${root}`;
  const rec = { key, def, root, rootUri, owner, state: 'starting', capabilities: null };
  servers.set(key, rec);
  state(rec, 'starting');

  const conn = new LspConnection({ ...spec, cwd: root });
  rec.conn = conn;
  conn.on('request', (msg) => handleServerRequest(rec, msg));
  conn.on('notification', (msg) => send('lsp:notification', { key, method: msg.method, params: msg.params }));
  conn.on('stderr', (text) => send('lsp:log', { key, text }));
  conn.on('close', ({ error, code, stderr }) => {
    if (servers.get(key) === rec) servers.delete(key);
    if (rec.stopping) return state(rec, 'stopped');
    state(rec, 'crashed', error || `exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
  });

  rec.ready = (async () => {
    try { conn.start(); } catch (e) { throw new Error(`could not start ${spec.command}: ${e.message}`); }
    const result = await conn.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Nova IDE', version: '0.3.0' },
      locale: 'en',
      rootPath: root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: def.initializationOptions ? def.initializationOptions(root) : undefined
    }, 120000);
    rec.capabilities = result.capabilities || {};
    rec.serverInfo = result.serverInfo || null;
    conn.notify('initialized', {});
    if (def.settings) conn.notify('workspace/didChangeConfiguration', { settings: def.settings });
    state(rec, 'ready', rec.serverInfo ? `${rec.serverInfo.name || ''} ${rec.serverInfo.version || ''}`.trim() : '');
    return rec;
  })();
  try { return await rec.ready; }
  catch (e) {
    state(rec, 'error', e.message);
    conn.kill();
    servers.delete(key);
    throw e;
  }
}

async function ensure(languageId, root, rootUri) {
  const s = await settings.read();
  if (s.intellisense === false) return { state: 'disabled' };
  const found = serverFor(languageId, s.lspServers || {});
  if (!found) return { state: 'none' };
  const { def, spec, disabled } = found;
  const base = { serverId: def.id, name: def.name };
  if (disabled) return { ...base, state: 'disabled' };
  if (!spec) return { ...base, state: 'missing', message: def.missing || `${def.name} language server not found`, install: def.install ? { label: def.install.label, command: def.install.command } : null };

  // every window has its own servers (two windows may even have the same folder open)
  const owner = ownerId();
  const key = `${owner}|${def.id}|${root}`;
  let rec = servers.get(key);
  try {
    if (!rec) rec = await start(def, spec, root, rootUri, owner);
    else await rec.ready;
  } catch (e) {
    return { ...base, state: 'error', message: e.message };
  }
  return { ...base, key, state: 'ready', capabilities: rec.capabilities, languages: def.languages };
}

async function stop(rec) {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  servers.delete(rec.key);
  try { await rec.conn.request('shutdown', null, 2000); rec.conn.notify('exit'); } catch {}
  setTimeout(() => rec.conn.kill(), 1000);
}

// stop the servers of one window (opening another folder there) - other windows keep theirs
function stopAll(exceptRoot, owner = ownerId()) {
  return Promise.all([...servers.values()].filter((r) => r.owner === owner && r.root !== exceptRoot).map(stop));
}

function runInstall(serverId) {
  const def = SERVERS.find((s) => s.id === serverId);
  if (!def || !def.install) return Promise.resolve({ ok: false, output: 'Nothing to install' });
  const run = (cmd) => new Promise((resolve) => exec(cmd, { windowsHide: true, timeout: 300000 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout || ''}${stderr || ''}${err && !stderr ? err.message : ''}` })));
  return (async () => {
    if (def.install.check) {
      const c = await run(def.install.check);
      if (!c.ok) return { ok: false, output: `${def.install.checkHint}\n${c.output}` };
    }
    const r = await run(def.install.command);
    // a global tool may be "already installed": treat as success
    if (!r.ok && /already installed/i.test(r.output)) r.ok = true;
    if (r.ok && process.platform === 'win32') {
      // make the new tool visible to this running app without a restart
      const tools = path.join(require('os').homedir(), '.dotnet', 'tools');
      if (!process.env.PATH.toLowerCase().includes(tools.toLowerCase())) process.env.PATH += path.delimiter + tools;
    }
    return r;
  })();
}

module.exports = {
  register({ ipcMain, send: s, ownerId: o }) {
    send = s;
    if (o) ownerId = o;
    ipcMain.handle('lsp:ensure', (_e, languageId, root, rootUri) => ensure(languageId, root, rootUri));
    ipcMain.handle('lsp:request', async (_e, key, method, params) => {
      const rec = servers.get(key);
      if (!rec || rec.state !== 'ready') return { error: 'server not running' };
      try { return { result: await rec.conn.request(method, params, method === 'textDocument/completion' ? 15000 : 60000) }; }
      catch (e) { return { error: e.message, code: e.code }; }
    });
    ipcMain.on('lsp:notify', (_e, key, method, params) => { const rec = servers.get(key); if (rec) rec.conn.notify(method, params); });
    ipcMain.on('lsp:cancel', (_e, key, method) => { const rec = servers.get(key); if (rec) rec.conn.cancel(method); });
    ipcMain.on('lsp:reply', (_e, fid, result) => {
      const f = forwarded.get(fid);
      if (!f) return;
      forwarded.delete(fid);
      const rec = servers.get(f.key);
      if (rec) rec.conn.respond(f.id, result);
    });
    ipcMain.handle('lsp:stopAll', (_e, exceptRoot) => stopAll(exceptRoot));
    ipcMain.handle('lsp:restart', async () => { await stopAll(null); return true; });
    ipcMain.handle('lsp:install', (_e, serverId) => runInstall(serverId));
    ipcMain.handle('lsp:list', () => SERVERS.map((d) => ({ id: d.id, name: d.name, languages: d.languages, bundled: !!d.bundled, available: !!d.resolve() })));
    ipcMain.handle('lsp:running', () => [...servers.values()].filter((r) => r.owner === ownerId()).map((r) => ({ key: r.key, serverId: r.def.id, name: r.def.name, root: r.root, state: r.state })));
  },
  windowClosed: (id) => stopAll(undefined, id),
  dispose() { for (const rec of servers.values()) { try { rec.conn.kill(); } catch {} } servers.clear(); }
};
