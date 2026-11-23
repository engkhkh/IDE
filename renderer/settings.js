// Nova IDE - settings: apply to the UI/editor + Tools > Options dialog
'use strict';

const SETTINGS_SCHEMA = [
  { group: 'Environment' },
  { key: 'theme', label: 'Color theme', type: 'select', options: [['dark', 'Dark'], ['light', 'Light']] },
  { group: 'Text Editor' },
  { key: 'fontFamily', label: 'Font family', type: 'text' },
  { key: 'fontSize', label: 'Font size', type: 'number', min: 8, max: 40 },
  { key: 'tabSize', label: 'Tab size', type: 'number', min: 1, max: 8 },
  { key: 'insertSpaces', label: 'Insert spaces instead of tabs', type: 'bool' },
  { key: 'wordWrap', label: 'Word wrap', type: 'select', options: [['off', 'Off'], ['on', 'On'], ['bounded', 'Bounded']] },
  { key: 'lineNumbers', label: 'Line numbers', type: 'select', options: [['on', 'On'], ['relative', 'Relative'], ['off', 'Off']] },
  { key: 'minimap', label: 'Show minimap', type: 'bool' },
  { key: 'renderWhitespace', label: 'Render whitespace', type: 'select', options: [['none', 'None'], ['selection', 'Selection'], ['all', 'All']] },
  { key: 'formatOnSave', label: 'Format document on save', type: 'bool' },
  { group: 'IntelliSense' },
  { key: 'intellisense', label: 'Enable IntelliSense (language servers)', type: 'bool' },
  { key: 'showIntelliSenseErrors', label: 'Show IntelliSense errors in the Error List', type: 'bool' },
  { group: 'Files' },
  { key: 'autoSave', label: 'Auto save', type: 'select', options: [['off', 'Off'], ['afterDelay', 'After delay'], ['onFocusChange', 'When editor loses focus']] },
  { key: 'autoSaveDelay', label: 'Auto save delay (ms)', type: 'number', min: 200, max: 60000 },
  { key: 'explorerAutoRefresh', label: 'Refresh Solution Explorer when files change on disk', type: 'bool' },
  { key: 'reloadChangedFiles', label: 'Reload open files changed outside the IDE (if unmodified)', type: 'bool' },
  { group: 'Debugging' },
  { key: 'diagShowOnDebug', label: 'Show Diagnostic Tools when debugging starts', type: 'bool' },
  { key: 'hotReloadBrowser', label: 'Open the browser for web apps (launchSettings.json launchBrowser)', type: 'bool' },
  { key: 'breakOnAsyncUserUnhandled', label: '.NET: break on exceptions an async method passes to its Task (Visual Studio does not)', type: 'bool' },
  { group: 'Git' },
  { key: 'gitInlineBlame', label: 'Show who last changed the current line (inline blame)', type: 'bool' },
  { group: 'Terminal' },
  { key: 'terminalShell', label: 'Shell (empty = PowerShell)', type: 'text', placeholder: 'e.g. cmd.exe, pwsh.exe, C:\\Program Files\\Git\\bin\\bash.exe' },
  { key: 'terminalFontSize', label: 'Terminal font size', type: 'number', min: 8, max: 32 }
];

function editorOptionsFrom(s) {
  return {
    fontSize: s.fontSize, fontFamily: s.fontFamily, wordWrap: s.wordWrap,
    lineNumbers: s.lineNumbers, minimap: { enabled: !!s.minimap }, renderWhitespace: s.renderWhitespace
  };
}

function applySettings(s) {
  state.settings = s;
  state.theme = s.theme;
  state.fontSize = s.fontSize;
  document.body.className = `theme-${s.theme === 'light' ? 'light' : 'dark'}`;
  if (monacoRef) monacoRef.editor.setTheme(s.theme === 'light' ? 'vs' : 'vs-dark');
  if (editor) editor.updateOptions(editorOptionsFrom(s));
  for (const t of state.tabs) t.model.updateOptions({ tabSize: s.tabSize, insertSpaces: s.insertSpaces });
  setupAutoSave(s);
  bus.emit('settings', s);
}

async function updateSetting(patch) {
  const next = await api.settings.set({ ...state.settings, ...patch });
  applySettings(next);
  return next;
}
api.on('settings:changed', (s) => applySettings(s));

// New tabs pick up tab size / spaces
bus.on('tabOpened', (tab) => tab.model.updateOptions({ tabSize: state.settings.tabSize, insertSpaces: state.settings.insertSpaces }));

// ---------- Auto save ----------
let autoSaveTimer = null;
let autoSaveSub = null;
let blurSub = null;
function setupAutoSave(s) {
  if (autoSaveSub) { autoSaveSub.dispose(); autoSaveSub = null; }
  if (blurSub) { blurSub.dispose(); blurSub = null; }
  if (!editor) return;
  if (s.autoSave === 'afterDelay') {
    autoSaveSub = editor.onDidChangeModelContent(() => {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => { if (state.active && isDirty(state.active)) saveTab(state.active); }, s.autoSaveDelay || 1000);
    });
  } else if (s.autoSave === 'onFocusChange') {
    blurSub = editor.onDidBlurEditorWidget(() => { if (state.active && isDirty(state.active)) saveTab(state.active); });
  }
}

// ---------- Options dialog ----------
async function openSettingsDialog() {
  const dlg = $('#settingsDlg');
  const form = $('#settingsForm');
  const current = { ...state.settings };
  form.innerHTML = '';
  for (const f of SETTINGS_SCHEMA) {
    if (f.group) { const h = document.createElement('div'); h.className = 'settings-group'; h.textContent = f.group; form.appendChild(h); continue; }
    const row = document.createElement('label');
    row.className = 'settings-row';
    const lab = document.createElement('span');
    lab.textContent = f.label;
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); }
      input.value = current[f.key];
    } else if (f.type === 'bool') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!current[f.key];
    } else {
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : 'text';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.placeholder) input.placeholder = f.placeholder;
      input.value = current[f.key] ?? '';
      input.spellcheck = false;
    }
    input.dataset.key = f.key;
    input.dataset.type = f.type;
    row.append(lab, input);
    form.appendChild(row);
  }
  dlg.classList.remove('hidden');

  const close = () => dlg.classList.add('hidden');
  $('#settingsClose').onclick = close;
  $('#settingsCancel').onclick = close;
  $('#settingsOk').onclick = async () => {
    const patch = {};
    form.querySelectorAll('[data-key]').forEach((el) => {
      const t = el.dataset.type;
      let v = t === 'bool' ? el.checked : el.value;
      if (t === 'number') { v = Number(v); const f = SETTINGS_SCHEMA.find((x) => x.key === el.dataset.key); if (!Number.isFinite(v)) v = current[el.dataset.key]; v = Math.min(f.max ?? v, Math.max(f.min ?? v, v)); }
      patch[el.dataset.key] = v;
    });
    await updateSetting(patch);
    close();
    status('Options saved');
  };
  $('#settingsReset').onclick = async () => { await api.settings.set(await api.settings.defaults()); close(); };
  $('#settingsJson').onclick = async () => {
    close();
    await api.settings.set(state.settings); // make sure the file exists
    openFile(await api.settings.path());
  };
}

// Saving settings.json from the editor applies it immediately
bus.on('saved', async (tab) => {
  if (tab.path !== await api.settings.path()) return;
  try { await api.settings.set(JSON.parse(tab.model.getValue())); status('Settings applied'); }
  catch (e) { log(`settings.json: ${e.message}\n`, 'stderr'); showPanel('output'); }
});

commands.settings = openSettingsDialog;
