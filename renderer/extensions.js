// Nova IDE - extensions: loader, the `nova` API given to extensions, and the Extensions window (Ctrl+Shift+X)
// An extension is a folder in <userData>/extensions with package.json + a script that calls:
//   nova.register({ activate(ctx) { ... }, deactivate() { ... } })
// See EXTENSIONS.md for the full API.
'use strict';

const EXT = { loaded: new Map(), errors: new Map(), statusItems: [], list: [] };

function extensionContext(meta) {
  const own = (fn) => (...a) => { try { return fn(...a); } catch (e) { reportExtError(meta, e); } };
  const subs = [];
  return {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    subscriptions: subs,
    commands: {
      register(id, label, fn, opts = {}) {
        commands[id] = own(fn);
        if (!COMMAND_LIST.some((c) => c[0] === id)) COMMAND_LIST.push([id, `${label}`, opts.key || '']);
        if (opts.key) keymap.push({ key: opts.key, cmd: id, editor: false, label, ...parseAccelerator(opts.key) });
        return { dispose() { delete commands[id]; } };
      },
      execute: (id, ...args) => (commands[id] ? commands[id](...args) : undefined)
    },
    statusBar: {
      add({ text = '', tooltip = '', onClick } = {}) {
        const el = document.createElement('span');
        el.className = `ext-status${onClick ? ' clickable' : ''}`;
        el.textContent = text; el.title = tooltip;
        if (onClick) el.onclick = own(onClick);
        $('#stUpdate').before(el);
        EXT.statusItems.push(el);
        return {
          set text(v) { el.textContent = v; }, get text() { return el.textContent; },
          set tooltip(v) { el.title = v; },
          show() { el.classList.remove('hidden'); }, hide() { el.classList.add('hidden'); },
          dispose() { el.remove(); }
        };
      }
    },
    editor: {
      get monaco() { return monacoRef; },
      get instance() { return editor; },
      activeFile: () => (state.active ? state.active.path : null),
      language: () => (state.active ? state.active.model.getLanguageId() : null),
      getText: () => (state.active ? state.active.model.getValue() : ''),
      getSelectedText: () => (editor && editor.getModel() ? editor.getModel().getValueInRange(editor.getSelection()) : ''),
      replaceSelection(text) { if (editor && editor.getModel()) editor.executeEdits(meta.id, [{ range: editor.getSelection(), text, forceMoveMarkers: true }]); },
      insertText(text) { if (editor && editor.getModel()) { const p = editor.getPosition(); editor.executeEdits(meta.id, [{ range: new monacoRef.Range(p.lineNumber, p.column, p.lineNumber, p.column), text, forceMoveMarkers: true }]); } },
      onDidChangeText(fn) { const d = editor.onDidChangeModelContent(own(fn)); subs.push(d); return d; },
      onDidChangeSelection(fn) { const d = editor.onDidChangeCursorSelection(own(fn)); subs.push(d); return d; },
      onDidChangeActiveFile(fn) { const d = editor.onDidChangeModel(own(() => fn(state.active ? state.active.path : null))); subs.push(d); return d; },
      onDidSave(fn) { bus.on('saved', own((tab) => fn(tab.path))); }
    },
    languages: {
      // snippets: [{ prefix, body: string | string[], description }] using $1, ${2:name}, $0 placeholders
      registerSnippets(language, snippets) {
        const L = monacoRef.languages;
        const d = L.registerCompletionItemProvider(language, {
          provideCompletionItems(model, position) {
            const w = model.getWordUntilPosition(position);
            const range = { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn };
            return { suggestions: snippets.map((sn) => ({ label: sn.prefix, kind: L.CompletionItemKind.Snippet, detail: sn.description || `${meta.name} snippet`, documentation: { value: `\`\`\`\n${[].concat(sn.body).join('\n')}\n\`\`\`` }, insertText: [].concat(sn.body).join('\n'), insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: `~${sn.prefix}` })) };
          }
        });
        subs.push(d);
        return d;
      }
    },
    themes: {
      define(name, data) { monacoRef.editor.defineTheme(name, { base: 'vs-dark', inherit: true, rules: [], colors: {}, ...data }); },
      apply(name) { monacoRef.editor.setTheme(name); }
    },
    ui: {
      showMessage(text) { status(String(text)); },
      log(text) { log(`[${meta.name}] ${text}\n`); },
      showOutput() { showPanel('output'); },
      ask: (prompt, value) => ask(prompt, value)
    },
    terminal: {
      async run(command, { cwd } = {}) {
        const t = await newTerminal(cwd || state.root || undefined);
        if (t) setTimeout(() => api.term.write(t.id, `${command}\r`), 400);
        return t ? t.id : null;
      }
    },
    workspace: {
      root: () => state.root,
      openFile: (p, line) => openFile(p, line),
      readFile: (p) => api.readFile(p),
      writeFile: (p, text) => api.writeFile(p, text),
      onDidOpenFolder(fn) { bus.on('folder', own(fn)); }
    },
    settings: { get: (key) => state.settings[key] }
  };
}

function reportExtError(meta, e) {
  const msg = e && e.message ? e.message : String(e);
  EXT.errors.set(meta.id, msg);
  log(`Extension "${meta.name}" failed: ${msg}\n`, 'stderr');
  api.app.logError(`extension ${meta.id}: ${e && e.stack ? e.stack : msg}`);
}

// called by extension scripts while they load
window.nova = {
  apiVersion: 1,
  register(def) {
    const script = document.currentScript;
    const id = script && script.dataset.ext;
    const meta = EXT.list.find((x) => x.id === id) || { id: id || 'unknown', name: id || 'unknown' };
    try {
      const ctx = extensionContext(meta);
      const r = def.activate ? def.activate(ctx) : null;
      EXT.loaded.set(meta.id, { def, ctx });
      if (r && r.catch) r.catch((e) => reportExtError(meta, e));
    } catch (e) { reportExtError(meta, e); }
  }
};

async function loadExtensions() {
  EXT.list = await api.ext.list();
  for (const meta of EXT.list.filter((x) => x.enabled && !x.error && x.hasMain)) {
    await new Promise((resolve) => {
      const s = document.createElement('script');
      s.dataset.ext = meta.id;
      s.src = `${meta.mainUrl}?v=${meta.version}`;
      s.onload = resolve;
      s.onerror = () => { reportExtError(meta, new Error(`could not load ${meta.main}`)); resolve(); };
      document.body.appendChild(s);
    });
  }
  const n = EXT.loaded.size;
  if (n) log(`${n} extension${n === 1 ? '' : 's'} loaded: ${[...EXT.loaded.keys()].join(', ')}\n`, 'info');
}
bus.on('started', () => loadExtensions());

// ---------------- Extensions window ----------------
async function reloadWindow() {
  const dirty = state.tabs.filter(isDirty);
  if (dirty.length && confirm(`Save changes to ${dirty.length} file(s) before reloading?`)) await saveAll();
  if (state.root) { store('lastFolder', state.root); saveExpanded(); store(`tabs:${state.root}`, state.tabs.map((t) => t.path)); }
  store('openTabs', state.tabs.map((t) => t.path));
  location.reload();
}

async function extensionsDialog() {
  let tab = 'installed';
  let changed = false;
  const tabs = h('div', { class: 'ng-tabs' });
  const list = h('div', { class: 'ext-list' });
  const banner = h('div', { class: 'ext-banner hidden' }, 'Changes take effect after the window reloads. ', (() => { const b = h('button', { class: 'primary' }, 'Reload Window'); b.onclick = reloadWindow; return b; })());
  const body = h('div', { class: 'ext' }, tabs, banner, list,
    h('div', { class: 'dlg-desc ext-help' }, 'An extension is a folder with a package.json and a script that calls nova.register(...). See EXTENSIONS.md in the Nova IDE source.'));
  const markChanged = () => { changed = true; banner.classList.remove('hidden'); };

  async function render() {
    tabs.innerHTML = '';
    for (const [id, label] of [['installed', 'Installed'], ['samples', 'Samples']]) {
      const b = h('button', { class: tab === id ? 'active' : '' }, label);
      b.onclick = () => { tab = id; render(); };
      tabs.appendChild(b);
    }
    list.innerHTML = '';
    const items = tab === 'installed' ? await api.ext.list() : await api.ext.samples();
    if (!items.length) list.appendChild(h('div', { class: 'dlg-desc ng-msg' }, tab === 'installed' ? 'No extensions installed. Try the Samples tab, or Install from Folder.' : 'No sample extensions found.'));
    for (const x of items) {
      const err = x.error || EXT.errors.get(x.id);
      const running = EXT.loaded.has(x.id);
      const actions = h('div', { class: 'ext-actions' });
      if (tab === 'installed' && !x.error) {
        const tgl = h('label', { class: 'np-check' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = x.enabled; c.onchange = async () => { await api.ext.setEnabled(x.id, c.checked); markChanged(); }; return c; })(), ' Enabled');
        actions.appendChild(tgl);
      }
      if (tab === 'installed') {
        const un = h('button', {}, 'Uninstall');
        un.onclick = async () => { if (!confirm(`Uninstall ${x.name}?`)) return; await api.ext.uninstall(x.id); markChanged(); render(); };
        actions.appendChild(un);
      } else {
        const ins = h('button', { class: x.installed ? '' : 'primary' }, x.installed ? 'Reinstall' : 'Install');
        ins.onclick = async () => { const r = await api.ext.installSample(x.id); if (!r.ok) status(r.error); else { markChanged(); status(`${x.name} installed`); render(); } };
        actions.appendChild(ins);
      }
      list.appendChild(h('div', { class: 'ext-item' },
        h('div', { class: 'ng-icon' }, (x.name || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'ng-text' },
          h('div', {}, h('b', {}, x.name), h('span', { class: 'dlg-desc' }, `  ${x.version || ''}${x.author ? ` · ${x.author}` : ''}`),
            tab === 'installed' && running ? h('span', { class: 'ext-running' }, 'running') : null),
          h('div', { class: 'dlg-desc' }, x.description || ''),
          err ? h('div', { class: 'np-err ext-err' }, err) : null),
        actions));
    }
  }
  makeDialog({
    title: 'Extensions', cls: 'dlg-wide', body,
    buttons: [
      { label: 'Open Extensions Folder', onClick: () => api.ext.openFolder() },
      { label: 'Install from Folder...', onClick: async () => { const d = await api.openFolderDialog(); if (!d) return; const r = await api.ext.installFolder(d); if (!r.ok) status(r.error); else { markChanged(); tab = 'installed'; render(); } } },
      'spacer',
      { label: 'Close', onClick: (close) => { close(); if (changed) status('Reload the window (Tools > Extensions > Reload Window) to apply extension changes'); } }
    ]
  });
  render();
}

Object.assign(commands, { extensions: extensionsDialog, reloadWindow });
window.EXT = EXT;
