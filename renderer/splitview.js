// Nova IDE - a second document group beside the main editor (Window > New Vertical Document Group, like
// Visual Studio; Ctrl+Alt+\ ). Both groups edit the same documents: typing in one shows in the other.
// The group has its own tabs; Save / Close work on the group you are typing in.
'use strict';

const SV = { editor: null, tabs: [], active: null, focused: false };

function svOpen(tab = state.active) {
  if (!tab) return status('Open a file first');
  const host = $('#editorHost');
  // one thing beside the editor at a time: the group replaces a Markdown preview / HTTP response
  if (SP.owner) spClose();
  if (!SV.editor) {
    SV.editor = monacoRef.editor.create($('#sv-editor'), {
      theme: state.settings.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout: true, fontSize: state.fontSize,
      fontFamily: 'Cascadia Mono, Consolas, monospace', minimap: { enabled: false }, glyphMargin: true,
      bracketPairColorization: { enabled: true }, renderWhitespace: 'selection', model: null
    });
    SV.editor.onDidFocusEditorText(() => { SV.focused = true; svRenderTabs(); });
    SV.editor.onDidBlurEditorText(() => { SV.focused = false; svRenderTabs(); });
    SV.editor.onDidChangeCursorPosition((e) => { if (SV.focused) $('#stPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  }
  host.classList.add('with-split');
  $('#svPane').classList.remove('hidden');
  if (!SV.tabs.includes(tab)) SV.tabs.push(tab);
  svShow(tab);
  return tab;
}
function svShow(tab) {
  const vs = SV.active && SV.editor.saveViewState();
  if (SV.active && vs) SV.active.svView = vs;
  SV.active = tab;
  SV.editor.setModel(tab ? tab.model : null);
  if (tab && tab.svView) SV.editor.restoreViewState(tab.svView);
  else if (tab && tab === state.active) SV.editor.setPosition(editor.getPosition()), SV.editor.revealLineInCenter(editor.getPosition().lineNumber);
  svRenderTabs();
  if (tab) SV.editor.focus();
}
function svClose() {
  if (SV.editor) SV.editor.setModel(null);
  SV.tabs = []; SV.active = null; SV.focused = false;
  $('#svPane').classList.add('hidden');
  $('#editorHost').classList.remove('with-split');
  editor && editor.focus();
}
function svCloseTab(tab) {
  const i = SV.tabs.indexOf(tab);
  if (i < 0) return;
  SV.tabs.splice(i, 1);
  if (!SV.tabs.length) { svClose(); return; }
  if (SV.active === tab) svShow(SV.tabs[Math.min(i, SV.tabs.length - 1)]);
  else svRenderTabs();
}
function svRenderTabs() {
  const host = $('#sv-tabs');
  host.innerHTML = '';
  $('#svPane').classList.toggle('focused', SV.focused);
  for (const t of SV.tabs) {
    const el = document.createElement('div');
    el.className = `tab${t === SV.active ? ' active' : ''}${isDirty(t) ? ' dirty' : ''}`;
    el.title = t.path;
    el.innerHTML = '<span class="name"></span><span class="close">✕</span>';
    el.querySelector('.name').textContent = baseName(t.path);
    el.onclick = () => svShow(t);
    el.querySelector('.close').onclick = (e) => { e.stopPropagation(); svCloseTab(t); };
    host.appendChild(el);
  }
}
const svFocusedTab = () => (SV.focused && SV.active ? SV.active : null);

// Save / Close act on the group you are in
const svSaveTab = saveTab;
saveTab = async function (tab) { return svSaveTab(tab || svFocusedTab() || state.active); };
const svCloseTabMain = closeTab;
closeTab = async function (tab) {
  const t = svFocusedTab();
  if (!tab && t) { svCloseTab(t); return; }
  return svCloseTabMain(tab || state.active);
};
bus.on('tabClosing', (tab) => { if (SV.tabs.includes(tab)) { if (SV.active === tab) SV.editor.setModel(null); svCloseTab(tab); } });
bus.on('saved', () => svRenderTabs());
bus.on('settings', (s) => { if (SV.editor) SV.editor.updateOptions({ fontSize: state.fontSize }); });
bus.on('tabOpened', (tab) => tab.model.onDidChangeContent(() => { if (SV.tabs.includes(tab)) svRenderTabs(); }));

Object.assign(commands, {
  splitEditor: () => svOpen(),
  closeSplit: () => svClose(),
  focusOtherGroup: () => { if (!SV.active) return; if (SV.focused) editor.focus(); else SV.editor.focus(); }
});
bus.on('ready', () => {
  $('#svClose').onclick = () => svClose();
  editor.addAction({ id: 'nova.splitRight', label: 'Split Editor Right', contextMenuGroupId: 'z_split', run: () => svOpen() });
});
