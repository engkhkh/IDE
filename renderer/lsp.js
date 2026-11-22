// Nova IDE - IntelliSense: connects Monaco to language servers (LSP) running in the main process
'use strict';

const LSP = {
  servers: new Map(),     // key -> { key, serverId, name, capabilities, languages }
  byLang: new Map(),      // Monaco language id -> server key (for the current folder)
  docs: new Map(),        // model uri -> { key, sub }
  diags: new Map(),       // document uri -> { key, items: LSP Diagnostic[] }
  status: new Map(),      // serverId -> { name, state, message, progress, install }
  failed: new Map(),      // "lang|root" -> result of a failed/missing ensure (not retried until restart/install)
  ensuring: new Map(),
  registered: new Set(),  // Monaco languages that already have providers
  progress: new Map(),    // progress token -> title
  restarts: new Map(),    // serverId -> [timestamps]
  log: []
};

// File extension -> LSP languageId (Monaco uses one id for .ts/.tsx, servers need to know JSX)
const LSP_LANG_BY_EXT = { ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', pyi: 'python', cs: 'csharp', csx: 'csharp', dart: 'dart', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', go: 'go', rs: 'rust' };
const lspLanguageId = (model) => LSP_LANG_BY_EXT[ext(model.uri.fsPath)] || model.getLanguageId();

const CI_KINDS = [null, 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];

// ---------------- conversions ----------------
const toPos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toLspRange = (r) => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
const toRange = (r) => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
const uriPath = (u) => monacoRef.Uri.parse(u).fsPath;
const docId = (model) => ({ uri: model.uri.toString() });

function toMarkdown(c) {
  if (c == null) return undefined;
  if (typeof c === 'string') return { value: c };
  if (c.kind === 'markdown') return { value: c.value, supportHtml: false };
  if (c.kind === 'plaintext') return { value: c.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, '\\$&') };
  if (c.language) return { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` };
  return { value: String(c.value ?? '') };
}
const toMarkdownList = (c) => (Array.isArray(c) ? c.map(toMarkdown) : [toMarkdown(c)]).filter((m) => m && m.value);

const SEVERITY = () => [null, monacoRef.MarkerSeverity.Error, monacoRef.MarkerSeverity.Warning, monacoRef.MarkerSeverity.Info, monacoRef.MarkerSeverity.Hint];
function toMarker(d) {
  const m = {
    severity: SEVERITY()[d.severity || 1], message: d.message, source: d.source,
    ...toRange(d.range),
    tags: (d.tags || []).filter((t) => t === 1 || t === 2),
    relatedInformation: (d.relatedInformation || []).map((ri) => ({ resource: monacoRef.Uri.parse(ri.location.uri), message: ri.message, ...toRange(ri.location.range) }))
  };
  if (d.code != null) m.code = d.codeDescription && d.codeDescription.href ? { value: String(d.code), target: monacoRef.Uri.parse(d.codeDescription.href) } : String(d.code);
  // zero-width ranges are invisible: widen to one character
  if (m.startLineNumber === m.endLineNumber && m.startColumn === m.endColumn) m.endColumn++;
  return m;
}

function normalizeLocations(res) {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map((l) => (l.targetUri
    ? { uri: l.targetUri, range: l.targetSelectionRange || l.targetRange, full: l.targetRange, origin: l.originSelectionRange }
    : { uri: l.uri, range: l.range })).filter((l) => l.uri && l.range);
}

// Peek / reference previews need a model for every file involved
async function ensureModels(uris) {
  await Promise.all([...new Set(uris)].map(async (u) => {
    const uri = monacoRef.Uri.parse(u);
    if (monacoRef.editor.getModel(uri)) return;
    try {
      const text = await api.readFile(uri.fsPath);
      if (!monacoRef.editor.getModel(uri)) monacoRef.editor.createModel(text, langFor(uri.fsPath), uri);
    } catch {}
  }));
}

// ---------------- requests ----------------
function lspLog(text) {
  LSP.log.push(`[${new Date().toLocaleTimeString()}] ${text.replace(/\s+$/, '')}`);
  if (LSP.log.length > 3000) LSP.log.splice(0, LSP.log.length - 3000);
}
async function request(key, method, params) {
  if (!key) return null;
  const r = await api.lsp.request(key, method, params);
  if (r.error) {
    if (!/cancel|timed out|content modified/i.test(r.error) && r.code !== -32800 && r.code !== -32801) lspLog(`${method} failed: ${r.error}`);
    return null;
  }
  return r.result;
}
const serverOf = (model) => { const k = model && LSP.byLang.get(model.getLanguageId()); return k ? LSP.servers.get(k) : null; };
const isSynced = (model) => LSP.docs.has(model.uri.toString());
function capable(model, cap) {
  const s = serverOf(model);
  if (!s || !isSynced(model)) return null;
  const c = s.capabilities[cap];
  return c ? s : null;
}

// ---------------- server lifecycle ----------------
async function ensureServer(lang, root = state.root) {
  if (!root || !monacoRef) return null;
  const existing = LSP.byLang.get(lang);
  if (existing && LSP.servers.has(existing)) return existing;
  const ck = `${lang}|${root}`;
  if (LSP.failed.has(ck)) return null;
  if (LSP.ensuring.has(ck)) return LSP.ensuring.get(ck);
  const p = (async () => {
    const res = await api.lsp.ensure(lang, root, monacoRef.Uri.file(root).toString());
    if (state.root && root !== state.root) return null; // folder changed meanwhile
    if (res.state === 'ready') {
      const s = { key: res.key, serverId: res.serverId, name: res.name, capabilities: res.capabilities || {}, languages: res.languages };
      LSP.servers.set(s.key, s);
      for (const l of s.languages) { LSP.byLang.set(l, s.key); registerProviders(l, s); }
        LSP.status.set(s.serverId, { name: s.name, state: 'ready', message: '' });
      updateLspStatus();
      return s.key;
    }
    if (res.state === 'none' || res.state === 'disabled') { LSP.failed.set(ck, res); return null; }
    LSP.failed.set(ck, res);
    LSP.status.set(res.serverId, { name: res.name, state: res.state, message: res.message, install: res.install });
    if (res.state === 'missing') log(`IntelliSense: ${res.message}${res.install ? ' Use Tools > IntelliSense: Install C# Language Server, or click the status bar.' : ''}\n`, 'info');
    else log(`IntelliSense: ${res.name} failed to start: ${res.message}\n`, 'stderr');
    updateLspStatus();
    return null;
  })();
  LSP.ensuring.set(ck, p);
  try { return await p; } finally { LSP.ensuring.delete(ck); }
}

function syncKind(caps) { const s = caps.textDocumentSync; return typeof s === 'number' ? s : (s && s.change) || 0; }
function saveOptions(caps) { const s = caps.textDocumentSync; return s && typeof s === 'object' && s.save ? (typeof s.save === 'object' ? s.save : {}) : null; }

async function openDoc(tab) {
  const model = tab.model;
  if (model.isDisposed() || isSynced(model)) return;
  const key = await ensureServer(model.getLanguageId(), state.root || dirName(tab.path));
  if (!key || model.isDisposed() || isSynced(model) || !state.tabs.includes(tab)) return;
  const s = LSP.servers.get(key);
  const uri = model.uri.toString();
  api.lsp.notify(key, 'textDocument/didOpen', { textDocument: { uri, languageId: lspLanguageId(model), version: model.getVersionId(), text: model.getValue() } });
  const kind = syncKind(s.capabilities);
  const sub = model.onDidChangeContent((e) => {
    if (!LSP.servers.has(key)) return;
    const contentChanges = kind === 2
      ? e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
      : [{ text: model.getValue() }];
    if (kind) api.lsp.notify(key, 'textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges });
  });
  LSP.docs.set(uri, { key, sub });
  applyDiagnostics(uri);
}

function closeDoc(tab) {
  const uri = tab.model.uri.toString();
  const d = LSP.docs.get(uri);
  if (!d) return;
  d.sub.dispose();
  LSP.docs.delete(uri);
  if (LSP.servers.has(d.key)) api.lsp.notify(d.key, 'textDocument/didClose', { textDocument: { uri } });
  LSP.diags.delete(uri);
  scheduleErrorList();
}

bus.on('tabOpened', (tab) => openDoc(tab));
bus.on('tabClosing', (tab) => closeDoc(tab));
bus.on('saved', (tab) => {
  const uri = tab.model.uri.toString();
  const d = LSP.docs.get(uri);
  const s = d && LSP.servers.get(d.key);
  if (!s) return;
  const so = saveOptions(s.capabilities);
  if (so) api.lsp.notify(d.key, 'textDocument/didSave', { textDocument: { uri }, text: so.includeText ? tab.model.getValue() : undefined });
});

// Forget everything about servers (they are stopped by the caller) and re-open documents
async function resetLsp({ stop = true } = {}) {
  for (const d of LSP.docs.values()) d.sub.dispose();
  LSP.docs.clear();
  for (const uri of LSP.diags.keys()) { const m = monacoRef && monacoRef.editor.getModel(monacoRef.Uri.parse(uri)); if (m) monacoRef.editor.setModelMarkers(m, 'lsp', []); }
  LSP.diags.clear();
  LSP.servers.clear(); LSP.byLang.clear(); LSP.failed.clear(); LSP.status.clear(); LSP.progress.clear();
  if (stop) await api.lsp.stopAll(null);
  scheduleErrorList();
  updateLspStatus();
  for (const t of [...state.tabs]) openDoc(t);
}
bus.on('folder', async (root) => {
  if (LSP.root === root) return;
  LSP.root = root;
  // servers are per folder: stop the old ones, then attach open files to the new folder's servers
  for (const d of LSP.docs.values()) d.sub.dispose();
  LSP.docs.clear();
  await api.lsp.stopAll(root);
  await resetLsp({ stop: false });
});
bus.on('settings', (s) => {
  if (s.intellisense === false && LSP.servers.size) resetLsp();
  else if (s.intellisense !== false && [...LSP.failed.values()].some((r) => r.state === 'disabled')) resetLsp({ stop: false });
  scheduleErrorList();
});

api.on('lsp:state', ({ key, serverId, name, state: st, message }) => {
  const prev = LSP.status.get(serverId) || {};
  LSP.status.set(serverId, { ...prev, name, state: st, message });
  lspLog(`${name}: ${st}${message ? ` - ${message}` : ''}`);
  if (st === 'crashed' || st === 'stopped') {
    const was = LSP.servers.get(key);
    LSP.servers.delete(key);
    for (const [l, k] of [...LSP.byLang]) if (k === key) LSP.byLang.delete(l);
    for (const [uri, d] of [...LSP.docs]) if (d.key === key) { d.sub.dispose(); LSP.docs.delete(uri); }
    for (const [uri, d] of [...LSP.diags]) if (d.key === key) { LSP.diags.delete(uri); applyDiagnostics(uri); }
    scheduleErrorList();
    if (st === 'crashed' && was) {
      log(`IntelliSense: ${name} stopped unexpectedly. ${message}\n`, 'stderr');
      const times = (LSP.restarts.get(serverId) || []).filter((t) => Date.now() - t < 300000);
      if (times.length < 3) {
        times.push(Date.now()); LSP.restarts.set(serverId, times);
        setTimeout(() => { for (const t of state.tabs) openDoc(t); }, 1500);
      } else log(`IntelliSense: ${name} keeps crashing; use Tools > IntelliSense: Restart Language Servers.\n`, 'stderr');
    }
  }
  updateLspStatus();
});

// ---------------- notifications + server requests ----------------
api.on('lsp:notification', ({ key, method, params }) => {
  if (method === 'textDocument/publishDiagnostics') {
    LSP.diags.set(params.uri, { key, items: params.diagnostics || [] });
    applyDiagnostics(params.uri);
    scheduleErrorList();
  } else if (method === 'window/showMessage') {
    const lvl = params.type; // 1 error, 2 warning, 3 info, 4 log
    lspLog(params.message);
    if (lvl <= 2) { log(`IntelliSense: ${params.message}\n`, lvl === 1 ? 'stderr' : null); status(params.message.split('\n')[0].slice(0, 120)); }
  } else if (method === 'window/logMessage') {
    lspLog(params.message);
  } else if (method === '$/progress') {
    const s = LSP.servers.get(key);
    const v = params.value || {};
    if (v.kind === 'begin') LSP.progress.set(params.token, { serverId: s && s.serverId, title: v.title, message: v.message, pct: v.percentage });
    else if (v.kind === 'report') { const p = LSP.progress.get(params.token); if (p) Object.assign(p, { message: v.message ?? p.message, pct: v.percentage ?? p.pct }); }
    else if (v.kind === 'end') LSP.progress.delete(params.token);
    updateLspStatus();
  }
});
api.on('lsp:log', ({ text }) => lspLog(text));

api.on('lsp:serverRequest', async ({ fid, method, params }) => {
  try {
    if (method === 'workspace/applyEdit') {
      await applyWorkspaceEdit(params.edit, params.label);
      api.lsp.reply(fid, { applied: true });
    } else if (method === 'window/showDocument') {
      const p = uriPath(params.uri);
      if (params.external) api.reveal(p); else await openFile(p, params.selection && params.selection.start.line + 1, params.selection && params.selection.start.character + 1);
      api.lsp.reply(fid, { success: true });
    } else api.lsp.reply(fid, null);
  } catch (e) {
    lspLog(`${method}: ${e.message}`);
    api.lsp.reply(fid, method === 'workspace/applyEdit' ? { applied: false, failureReason: e.message } : null);
  }
});

// ---------------- diagnostics -> squiggles + Error List ----------------
function applyDiagnostics(uri) {
  if (!monacoRef) return;
  const model = monacoRef.editor.getModel(monacoRef.Uri.parse(uri));
  if (!model) return;
  const d = LSP.diags.get(uri);
  monacoRef.editor.setModelMarkers(model, 'lsp', d ? d.items.map(toMarker) : []);
}
bus.on('tabOpened', (tab) => applyDiagnostics(tab.model.uri.toString()));

let errTimer = null;
function scheduleErrorList() { clearTimeout(errTimer); errTimer = setTimeout(() => renderErrors(true), 250); }
intellisenseProblems = () => {
  const out = [];
  for (const [uri, d] of LSP.diags) {
    const file = uriPath(uri);
    for (const x of d.items) {
      if (x.severity === 4) continue; // hints are shown in the editor only
      out.push({ file, line: x.range.start.line + 1, col: x.range.start.character + 1, sev: x.severity === 2 ? 'warning' : x.severity === 3 ? 'info' : 'error', code: x.code != null ? String(x.code) : '', msg: x.message, source: 'IntelliSense' });
    }
  }
  return out;
};

// ---------------- edits ----------------
async function applyWorkspaceEdit(we, label) {
  if (!we) return;
  const textOps = [];
  if (we.documentChanges) {
    for (const ch of we.documentChanges) {
      if (ch.kind === 'create') {
        const p = uriPath(ch.uri);
        const st = await api.ws.stat(p);
        if (!st.exists || (ch.options && ch.options.overwrite)) await api.writeFile(p, '');
      } else if (ch.kind === 'rename') {
        const from = uriPath(ch.oldUri), to = uriPath(ch.newUri);
        const t = findTab(from); if (t) await closeTab(t);
        await api.rename(from, to);
      } else if (ch.kind === 'delete') {
        const p = uriPath(ch.uri);
        const t = findTab(p); if (t) await closeTab(t);
        await api.trash(p);
      } else if (ch.textDocument) textOps.push([ch.textDocument.uri, ch.edits]);
    }
  } else if (we.changes) {
    for (const [u, edits] of Object.entries(we.changes)) textOps.push([u, edits]);
  }
  let files = 0;
  for (const [u, edits] of textOps) {
    const tab = await loadTab(uriPath(u));
    if (!tab || !edits || !edits.length) continue;
    tab.model.pushStackElement();
    tab.model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText != null ? e.newText : (e.snippet && e.snippet.value) || '', forceMoveMarkers: true })), () => null);
    tab.model.pushStackElement();
    files++;
  }
  renderTabs();
  if (files > 1) status(`${label || 'Changes'} applied to ${files} files. Save All (Ctrl+Shift+S) to keep them.`);
}

async function executeServerCommand(key, cmd) {
  if (!cmd) return;
  await request(key, 'workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments });
}

async function applyCodeAction(key, action) {
  if (typeof action.command === 'string') return executeServerCommand(key, action); // plain Command
  const s = LSP.servers.get(key);
  if (!action.edit && s && s.capabilities.codeActionProvider && s.capabilities.codeActionProvider.resolveProvider) {
    action = (await request(key, 'codeAction/resolve', action)) || action;
  }
  if (action.edit) await applyWorkspaceEdit(action.edit, action.title);
  if (action.command) await executeServerCommand(key, action.command);
}

function toMonacoCommand(cmd, key) {
  if (!cmd) return undefined;
  if (/^editor\.action\./.test(cmd.command)) return { id: cmd.command, title: cmd.title || '', arguments: cmd.arguments };
  return { id: 'nova.lsp.executeCommand', title: cmd.title || '', arguments: [key, cmd] };
}

// ---------------- providers ----------------
function registerProviders(lang, server) {
  if (LSP.registered.has(lang)) return;
  LSP.registered.add(lang);
  const L = monacoRef.languages;
  const caps = server.capabilities;

  L.registerCompletionItemProvider(lang, {
    triggerCharacters: (caps.completionProvider && caps.completionProvider.triggerCharacters) || [],
    async provideCompletionItems(model, position, context) {
      const s = capable(model, 'completionProvider');
      if (!s) return null;
      const res = await request(s.key, 'textDocument/completion', {
        textDocument: docId(model), position: toPos(position),
        context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter }
      });
      if (!res || model.isDisposed()) return null;
      const items = Array.isArray(res) ? res : res.items || [];
      const defaults = (!Array.isArray(res) && res.itemDefaults) || {};
      const word = model.getWordUntilPosition(position);
      const full = model.getWordAtPosition(position);
      const insert = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: position.column };
      const defRange = { insert, replace: { ...insert, endColumn: full ? full.endColumn : position.column } };
      const K = L.CompletionItemKind;
      return {
        incomplete: !Array.isArray(res) && !!res.isIncomplete,
        suggestions: items.map((it) => {
          const te = it.textEdit;
          const er = defaults.editRange;
          let range = defRange;
          if (te) range = te.insert ? { insert: toRange(te.insert), replace: toRange(te.replace) } : toRange(te.range);
          else if (er) range = er.insert ? { insert: toRange(er.insert), replace: toRange(er.replace) } : toRange(er);
          const fmt = it.insertTextFormat || defaults.insertTextFormat;
          return {
            label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
            kind: K[CI_KINDS[it.kind]] ?? K.Property,
            detail: it.detail,
            documentation: toMarkdown(it.documentation),
            insertText: te ? te.newText : (it.insertText ?? it.textEditText ?? it.label),
            insertTextRules: fmt === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : 0,
            range,
            filterText: it.filterText,
            sortText: it.sortText,
            preselect: it.preselect,
            commitCharacters: it.commitCharacters || defaults.commitCharacters,
            tags: it.deprecated || (it.tags || []).includes(1) ? [L.CompletionItemTag.Deprecated] : [],
            additionalTextEdits: (it.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
            command: toMonacoCommand(it.command, s.key),
            _lsp: it, _key: s.key
          };
        })
      };
    },
    async resolveCompletionItem(item) {
      const s = LSP.servers.get(item._key);
      if (!s || !(s.capabilities.completionProvider && s.capabilities.completionProvider.resolveProvider)) return item;
      const r = await request(item._key, 'completionItem/resolve', item._lsp);
      if (!r) return item;
      if (r.documentation) item.documentation = toMarkdown(r.documentation);
      if (r.detail) item.detail = r.detail;
      if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map((e) => ({ range: toRange(e.range), text: e.newText }));
      if (r.command) item.command = toMonacoCommand(r.command, item._key);
      return item;
    }
  });

  L.registerHoverProvider(lang, {
    async provideHover(model, position) {
      const s = capable(model, 'hoverProvider');
      if (!s) return null;
      const r = await request(s.key, 'textDocument/hover', { textDocument: docId(model), position: toPos(position) });
      if (!r || !r.contents) return null;
      const contents = toMarkdownList(r.contents);
      return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
    }
  });

  const sh = caps.signatureHelpProvider || {};
  L.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: sh.triggerCharacters || ['(', ','],
    signatureHelpRetriggerCharacters: sh.retriggerCharacters || [],
    async provideSignatureHelp(model, position, _token, context) {
      const s = capable(model, 'signatureHelpProvider');
      if (!s) return null;
      const r = await request(s.key, 'textDocument/signatureHelp', {
        textDocument: docId(model), position: toPos(position),
        context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger }
      });
      if (!r || !r.signatures || !r.signatures.length) return null;
      return {
        value: {
          signatures: r.signatures.map((sig) => ({
            label: sig.label, documentation: toMarkdown(sig.documentation),
            parameters: (sig.parameters || []).map((p) => ({ label: p.label, documentation: toMarkdown(p.documentation) })),
            activeParameter: sig.activeParameter
          })),
          activeSignature: r.activeSignature || 0,
          activeParameter: r.activeParameter || 0
        },
        dispose() {}
      };
    }
  });

  // Definition-like requests share one implementation
  const locProvider = (cap, method) => async (model, position) => {
    const s = capable(model, cap);
    if (!s) return null;
    const res = normalizeLocations(await request(s.key, method, { textDocument: docId(model), position: toPos(position) }));
    await ensureModels(res.map((l) => l.uri));
    return res.map((l) => ({ uri: monacoRef.Uri.parse(l.uri), range: toRange(l.range), targetSelectionRange: toRange(l.range), originSelectionRange: l.origin ? toRange(l.origin) : undefined }));
  };
  L.registerDefinitionProvider(lang, { provideDefinition: locProvider('definitionProvider', 'textDocument/definition') });
  L.registerTypeDefinitionProvider(lang, { provideTypeDefinition: locProvider('typeDefinitionProvider', 'textDocument/typeDefinition') });
  L.registerImplementationProvider(lang, { provideImplementation: locProvider('implementationProvider', 'textDocument/implementation') });

  L.registerReferenceProvider(lang, {
    async provideReferences(model, position, context) {
      const s = capable(model, 'referencesProvider');
      if (!s) return null;
      const res = normalizeLocations(await request(s.key, 'textDocument/references', { textDocument: docId(model), position: toPos(position), context: { includeDeclaration: context.includeDeclaration !== false } }));
      await ensureModels(res.map((l) => l.uri));
      return res.map((l) => ({ uri: monacoRef.Uri.parse(l.uri), range: toRange(l.range) }));
    }
  });

  L.registerDocumentHighlightProvider(lang, {
    async provideDocumentHighlights(model, position) {
      const s = capable(model, 'documentHighlightProvider');
      if (!s) return null;
      const res = await request(s.key, 'textDocument/documentHighlight', { textDocument: docId(model), position: toPos(position) });
      return (res || []).map((h) => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 }));
    }
  });

  L.registerDocumentSymbolProvider(lang, {
    displayName: server.name,
    async provideDocumentSymbols(model) {
      const s = capable(model, 'documentSymbolProvider');
      if (!s) return null;
      return convertSymbols(await request(s.key, 'textDocument/documentSymbol', { textDocument: docId(model) }));
    }
  });

  const fmtOptions = (model) => { const o = model.getOptions(); return { tabSize: o.tabSize, insertSpaces: o.insertSpaces, trimTrailingWhitespace: true, insertFinalNewline: false }; };
  L.registerDocumentFormattingEditProvider(lang, {
    displayName: server.name,
    async provideDocumentFormattingEdits(model) {
      const s = capable(model, 'documentFormattingProvider');
      if (!s) return null;
      const res = await request(s.key, 'textDocument/formatting', { textDocument: docId(model), options: fmtOptions(model) });
      return (res || []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    }
  });
  L.registerDocumentRangeFormattingEditProvider(lang, {
    displayName: server.name,
    async provideDocumentRangeFormattingEdits(model, range) {
      const s = capable(model, 'documentRangeFormattingProvider');
      if (!s) return null;
      const res = await request(s.key, 'textDocument/rangeFormatting', { textDocument: docId(model), range: toLspRange(range), options: fmtOptions(model) });
      return (res || []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    }
  });

  L.registerRenameProvider(lang, {
    async resolveRenameLocation(model, position) {
      const s = capable(model, 'renameProvider');
      const word = model.getWordAtPosition(position);
      const fallback = word ? { range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }, text: word.word } : null;
      if (!s) return { rejectReason: 'IntelliSense is not available for this file.', range: null, text: '' };
      if (!(typeof s.capabilities.renameProvider === 'object' && s.capabilities.renameProvider.prepareProvider)) return fallback || { rejectReason: 'Nothing to rename here.', range: null, text: '' };
      const r = await request(s.key, 'textDocument/prepareRename', { textDocument: docId(model), position: toPos(position) });
      if (!r) return { rejectReason: 'You cannot rename this element.', range: null, text: '' };
      if (r.defaultBehavior) return fallback;
      if (r.range) return { range: toRange(r.range), text: r.placeholder || model.getValueInRange(toRange(r.range)) };
      return { range: toRange(r), text: model.getValueInRange(toRange(r)) };
    },
    async provideRenameEdits(model, position, newName) {
      const s = capable(model, 'renameProvider');
      if (!s) return null;
      const we = await request(s.key, 'textDocument/rename', { textDocument: docId(model), position: toPos(position), newName });
      if (!we) return { edits: [], rejectReason: 'Rename is not possible here.' };
      return workspaceEditToMonaco(we);
    }
  });

  const ca = caps.codeActionProvider;
  L.registerCodeActionProvider(lang, {
    async provideCodeActions(model, range, context) {
      const s = capable(model, 'codeActionProvider');
      if (!s) return { actions: [], dispose() {} };
      const uri = model.uri.toString();
      const diags = ((LSP.diags.get(uri) || {}).items || []).filter((d) => {
        const r = toRange(d.range);
        return !(r.endLineNumber < range.startLineNumber || r.startLineNumber > range.endLineNumber);
      });
      const res = await request(s.key, 'textDocument/codeAction', {
        textDocument: docId(model), range: toLspRange(range),
        context: { diagnostics: diags, only: context.only ? [context.only] : undefined, triggerKind: context.trigger === 2 ? 2 : 1 }
      });
      const actions = (res || []).map((a) => ({
        title: a.title,
        kind: typeof a.command === 'string' ? undefined : a.kind,
        isPreferred: a.isPreferred,
        disabled: a.disabled ? a.disabled.reason : undefined,
        diagnostics: (a.diagnostics || []).map(toMarker),
        command: { id: 'nova.lsp.applyCodeAction', title: a.title, arguments: [s.key, a] }
      }));
      return { actions, dispose() {} };
    }
  }, { providedCodeActionKinds: (ca && typeof ca === 'object' && ca.codeActionKinds) || undefined });
}

async function workspaceEditToMonaco(we) {
  // resource operations are applied directly; text edits go through Monaco so rename is one undo step per file
  const ops = [];
  if (we.documentChanges) {
    const resourceOps = we.documentChanges.filter((c) => c.kind);
    if (resourceOps.length) await applyWorkspaceEdit({ documentChanges: resourceOps });
    for (const c of we.documentChanges) if (c.textDocument) ops.push([c.textDocument.uri, c.edits]);
  } else if (we.changes) for (const [u, e] of Object.entries(we.changes)) ops.push([u, e]);
  const edits = [];
  for (const [u, list] of ops) {
    const tab = await loadTab(uriPath(u)); // a model must exist for every changed file
    if (!tab) continue;
    for (const e of list) edits.push({ resource: tab.model.uri, textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
  }
  const files = new Set(ops.map((o) => o[0])).size;
  if (files > 1) setTimeout(() => status(`Renamed in ${files} files. Save All (Ctrl+Shift+S) to keep the changes.`), 50);
  return { edits };
}

function convertSymbols(res) {
  if (!res) return [];
  const SK = (k) => Math.max(0, (k || 13) - 1);
  return res.map(function conv(sym) {
    if (sym.location) { // SymbolInformation
      const r = toRange(sym.location.range);
      return { name: sym.name, detail: '', kind: SK(sym.kind), tags: [], containerName: sym.containerName, range: r, selectionRange: r, children: [] };
    }
    return { name: sym.name, detail: sym.detail || '', kind: SK(sym.kind), tags: sym.tags || [], range: toRange(sym.range), selectionRange: toRange(sym.selectionRange || sym.range), children: (sym.children || []).map(conv) };
  });
}

// Monaco's own TypeScript/JavaScript worker would duplicate every result once the real server runs.
// It reads this configuration only once (when the first TS/JS file opens), so this runs at startup.
function disableBuiltinTypeScript() {
  const ts = monacoRef.languages.typescript;
  if (!ts || disableBuiltinTypeScript.done) return;
  disableBuiltinTypeScript.done = true;
  const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false };
  ts.typescriptDefaults.setModeConfiguration(off);
  ts.javascriptDefaults.setModeConfiguration(off);
  for (const m of monacoRef.editor.getModels()) { monacoRef.editor.setModelMarkers(m, 'typescript', []); monacoRef.editor.setModelMarkers(m, 'javascript', []); }
}

// ---------------- symbols for the palette (Ctrl+T "Go to All", Alt+\ "Go to Member") ----------------
window.lspWorkspaceSymbols = async (query) => {
  const out = [];
  await Promise.all([...LSP.servers.values()].filter((s) => s.capabilities.workspaceSymbolProvider).map(async (s) => {
    const res = await request(s.key, 'workspace/symbol', { query });
    for (const sym of res || []) {
      const loc = sym.location || {};
      if (!loc.uri) continue;
      out.push({ name: sym.name, kind: sym.kind, container: sym.containerName || '', path: uriPath(loc.uri), line: loc.range ? loc.range.start.line + 1 : 1, col: loc.range ? loc.range.start.character + 1 : 1 });
    }
  }));
  return out;
};
window.lspDocumentSymbols = async (model) => {
  const s = model && capable(model, 'documentSymbolProvider');
  if (!s) return null;
  const flat = [];
  (function walk(list, container) {
    for (const sym of list) { flat.push({ name: sym.name, kind: sym.kind + 1, container, line: sym.selectionRange.startLineNumber, col: sym.selectionRange.startColumn }); walk(sym.children || [], sym.name); }
  })(convertSymbols(await request(s.key, 'textDocument/documentSymbol', { textDocument: docId(model) })), '');
  return flat;
};
const SYMBOL_ICONS = { 5: '🟧', 6: 'ƒ', 7: '▫', 8: '◆', 9: '⚙', 10: '🟨', 11: '🔷', 12: 'ƒ', 13: '𝑥', 14: 'π', 23: '🟪', 26: 'T' };
window.symbolIcon = (k) => SYMBOL_ICONS[k] || '•';

// ---------------- status bar ----------------
function updateLspStatus() {
  const el = $('#stLsp');
  const model = state.active && state.active.model;
  if (!model) { el.classList.add('hidden'); return; }
  const lang = model.getLanguageId();
  const key = LSP.byLang.get(lang);
  const s = key && LSP.servers.get(key);
  let st = null;
  if (s) st = LSP.status.get(s.serverId);
  else {
    const f = [...LSP.failed.entries()].find(([ck, v]) => ck.startsWith(`${lang}|`) && v.serverId);
    if (f) st = LSP.status.get(f[1].serverId);
  }
  if (!st) { el.classList.add('hidden'); return; }
  const prog = [...LSP.progress.values()].find((p) => !s || p.serverId === s.serverId);
  const icon = { ready: '✓', starting: '⟳', missing: '✕', error: '✕', crashed: '✕', disabled: '–', stopped: '–' }[st.state] || '•';
  el.textContent = prog ? `⟳ ${st.name}: ${prog.title || ''}${prog.message ? ` ${prog.message}` : ''}${prog.pct != null ? ` ${prog.pct}%` : ''}` : `${icon} ${st.name}${st.state === 'ready' ? '' : ` (${st.state === 'missing' ? 'not installed' : st.state})`}`;
  el.title = st.message || 'IntelliSense';
  el.classList.remove('hidden');
}
bus.on('ready', () => editor.onDidChangeModel(() => updateLspStatus()));

$('#stLsp').onclick = async () => {
  const model = state.active && state.active.model;
  const lang = model && model.getLanguageId();
  const f = [...LSP.failed.entries()].find(([ck, v]) => ck.startsWith(`${lang}|`) && v.serverId);
  const failed = f && f[1];
  if (failed && failed.state === 'missing' && failed.install) {
    if (confirm(`${failed.message}\n\nRun "${failed.install.command}" now?`)) installServer(failed.serverId);
    return;
  }
  commands.lspShowLog();
};

async function installServer(serverId) {
  showPanel('output');
  const cmd = serverId === 'csharp' ? 'dotnet tool install --global csharp-ls' : '';
  log(`\n> ${cmd}\n`, 'info');
  status('Installing language server...');
  const r = await api.lsp.install(serverId);
  log(`${r.output}\n`, r.ok ? null : 'stderr');
  if (r.ok) { log('Language server installed. Starting IntelliSense...\n', 'info'); await resetLsp({ stop: false }); }
  else status('Language server install failed (see Output)');
}

// ---------------- commands ----------------
bus.on('ready', () => {
  if (state.settings.intellisense !== false) disableBuiltinTypeScript();
  monacoRef.editor.registerCommand('nova.lsp.executeCommand', (_accessor, key, cmd) => executeServerCommand(key, cmd));
  monacoRef.editor.registerCommand('nova.lsp.applyCodeAction', (_accessor, key, action) => applyCodeAction(key, action));
  // Go to Definition into another file: open it as a tab
  monacoRef.editor.registerEditorOpener({
    openCodeEditor(_source, resource, sel) {
      const line = sel ? (sel.startLineNumber || sel.lineNumber) : undefined;
      const col = sel ? (sel.startColumn || sel.column) : undefined;
      openFile(resource.fsPath, line, col);
      return true;
    }
  });
});

Object.assign(commands, {
  lspRestart: async () => { status('Restarting language servers...'); LSP.restarts.clear(); await resetLsp(); status('Language servers restarted'); },
  lspShowLog: () => {
    const lines = [...LSP.status.entries()].map(([id, s]) => `  ${s.name || id}: ${s.state}${s.message ? ` - ${s.message}` : ''}`);
    log(`\nIntelliSense status\n${lines.join('\n') || '  (no language servers started yet: open a code file)'}\n--- recent server log ---\n${LSP.log.slice(-60).join('\n')}\n`, 'info');
    showPanel('output');
  },
  lspInstallCsharp: () => installServer('csharp'),
  organizeImports: async () => {
    const model = state.active && state.active.model;
    const s = model && capable(model, 'codeActionProvider');
    if (!s) return status('No language server for this file');
    const full = model.getFullModelRange();
    const res = await request(s.key, 'textDocument/codeAction', { textDocument: docId(model), range: toLspRange(full), context: { diagnostics: [], only: ['source.organizeImports'] } });
    const action = (res || []).find((a) => typeof a.command !== 'string' ? (a.kind || '').startsWith('source.organizeImports') : true);
    if (!action) return status('Nothing to organize');
    await applyCodeAction(s.key, action);
    status('Imports organized');
  }
});
