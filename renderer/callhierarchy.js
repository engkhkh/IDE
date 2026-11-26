// Nova IDE - from the language servers: View Call Hierarchy (Ctrl+K, Ctrl+T, like Visual Studio: "Calls To" and
// "Calls From" a method, each expandable) and inline hints (parameter names and inferred types; Alt+F1 toggles).
'use strict';

const CH = { registered: new Set(), hintsChanged: null, root: null };
const CH_KINDS = ['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
const CH_ICONS = { Method: '🟪', Function: '🟪', Constructor: '🟪', Class: '🟧', Property: '🔧', Field: '🔹', Variable: '🔹' };

// ---------------- inline hints ----------------
function chHintLabel(label) {
  if (typeof label === 'string') return label;
  return label.map((p) => ({ label: p.value, tooltip: typeof p.tooltip === 'string' ? p.tooltip : p.tooltip && p.tooltip.value }));
}
function chRegister(lang) {
  if (CH.registered.has(lang)) return;
  CH.registered.add(lang);
  if (!CH.hintsChanged) CH.hintsChanged = new monacoRef.Emitter();
  monacoRef.languages.registerInlayHintsProvider(lang, {
    onDidChangeInlayHints: CH.hintsChanged.event,
    async provideInlayHints(model, range) {
      const none = { hints: [], dispose() {} };
      if (!state.settings.inlayHints) return none;
      const s = capable(model, 'inlayHintProvider');
      if (!s) return none;
      const res = await request(s.key, 'textDocument/inlayHint', { textDocument: docId(model), range: toLspRange(range) });
      if (!Array.isArray(res)) return none;
      CH.lastHints = res.length;
      return {
        hints: res.map((h) => ({
          label: chHintLabel(h.label),
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          kind: h.kind, paddingLeft: !!h.paddingLeft, paddingRight: !!h.paddingRight,
          tooltip: typeof h.tooltip === 'string' ? h.tooltip : h.tooltip && h.tooltip.value
        })),
        dispose() {}
      };
    }
  });
}
const chRegisterProviders = registerProviders;
registerProviders = function (lang, server) { chRegisterProviders(lang, server); chRegister(lang); }; // eslint-disable-line no-func-assign
let chHintsSetting;
bus.on('settings', (s) => { if (CH.hintsChanged && chHintsSetting !== !!s.inlayHints) CH.hintsChanged.fire(); chHintsSetting = !!s.inlayHints; });

// ---------------- call hierarchy ----------------
async function chShow() {
  const model = editor && editor.getModel();
  if (!model || !state.active) return status('Open a file first');
  const s = capable(model, 'callHierarchyProvider');
  if (!s) return status(serverOf(model) ? `${serverOf(model).name} has no call hierarchy` : 'Call hierarchy needs IntelliSense (a language server) for this file');
  const items = await request(s.key, 'textDocument/prepareCallHierarchy', { textDocument: docId(model), position: toPos(editor.getPosition()) });
  if (!items || !items.length) return status('Place the cursor on a method or function to view its call hierarchy');
  CH.root = { key: s.key, item: items[0] };
  chRender();
  showPanel('callhierarchy');
  return items[0];
}
// incoming: who calls it (the call sites are in the caller); outgoing: what it calls (the sites are in the item itself)
async function chChildren(key, item, dir) {
  const res = await request(key, dir === 'in' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item });
  return (res || []).map((c) => {
    const target = dir === 'in' ? c.from : c.to;
    const site = (c.fromRanges && c.fromRanges[0]) || target.selectionRange;
    const siteFile = dir === 'in' ? target.uri : item.uri;
    return { item: target, sites: (c.fromRanges || []).length, path: uriPath(siteFile), line: site.start.line + 1, col: site.start.character + 1 };
  });
}
function chNode(host, depth, label, opts) {
  const row = document.createElement('div');
  row.className = 'ch-row';
  row.style.paddingLeft = `${6 + depth * 16}px`;
  row.innerHTML = '<span class="ch-twist"></span><span class="ch-icon"></span><span class="ch-label"></span><span class="ch-detail"></span>';
  row.children[0].textContent = opts.expandable ? '▸' : '';
  row.children[1].textContent = opts.icon || '';
  row.children[2].textContent = label;
  row.children[3].textContent = opts.detail || '';
  host.appendChild(row);
  const kids = document.createElement('div');
  host.appendChild(kids);
  let open = false;
  const toggle = async () => {
    if (!opts.expandable) return;
    open = !open;
    row.children[0].textContent = open ? '▾' : '▸';
    kids.innerHTML = '';
    if (open) await opts.expand(kids, depth + 1);
  };
  row.children[0].onclick = (e) => { e.stopPropagation(); toggle(); };
  row.ondblclick = () => toggle();
  row.onclick = () => { if (opts.go) opts.go(); };
  row.chToggle = toggle;
  return row;
}
function chItemNode(host, depth, key, item, call) {
  const kind = CH_KINDS[item.kind] || '';
  const where = `${baseName(uriPath(item.uri))}(${item.selectionRange.start.line + 1})`;
  return chNode(host, depth, item.name, {
    icon: CH_ICONS[kind] || '◇',
    detail: `${item.detail ? `${item.detail} · ` : ''}${call && call.sites > 1 ? `${call.sites} calls · ` : ''}${where}`,
    expandable: true,
    go: () => (call ? openFile(call.path, call.line, call.col) : openFile(uriPath(item.uri), item.selectionRange.start.line + 1, item.selectionRange.start.character + 1)),
    expand: (kids, d) => chGroups(kids, d, key, item)
  });
}
async function chGroups(host, depth, key, item) {
  for (const dir of ['in', 'out']) {
    chNode(host, depth, `${dir === 'in' ? 'Calls To' : 'Calls From'} '${item.name}'`, {
      icon: dir === 'in' ? '⤶' : '⤷', expandable: true,
      expand: async (kids, d) => {
        const calls = await chChildren(key, item, dir);
        if (!calls.length) { chNode(kids, d, dir === 'in' ? '(no callers)' : '(no calls)', {}); return; }
        for (const c of calls) chItemNode(kids, d, key, c.item, c);
      }
    });
  }
}
async function chRender() {
  const host = $('#chTree');
  host.innerHTML = '';
  if (!CH.root) { host.innerHTML = '<div class="ch-empty">Right-click a method and choose View Call Hierarchy (Ctrl+K, Ctrl+T).</div>'; return; }
  const root = chItemNode(host, 0, CH.root.key, CH.root.item, null);
  await root.chToggle();
  // open "Calls To" right away, like Visual Studio
  const first = host.querySelectorAll('.ch-row')[1];
  if (first && first.chToggle) await first.chToggle();
}

Object.assign(commands, {
  callHierarchy: () => chShow(),
  toggleInlayHints: () => updateSetting({ inlayHints: !state.settings.inlayHints }).then((s) => status(`Inline hints ${s.inlayHints ? 'on' : 'off'}`))
});
bus.on('ready', () => {
  const { KeyMod, KeyCode } = monacoRef;
  editor.addCommand(KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyT), () => commands.callHierarchy());
  editor.addCommand(KeyMod.Alt | KeyCode.F1, () => commands.toggleInlayHints());
  editor.addAction({ id: 'nova.callHierarchy', label: 'View Call Hierarchy', contextMenuGroupId: 'navigation', contextMenuOrder: 1.6, run: () => commands.callHierarchy() });
  $('#chRefresh').onclick = () => chRender();
  chRender();
});
