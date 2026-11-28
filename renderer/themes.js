// Nova IDE - more color themes: High Contrast (dark / light) and VS Code color themes from Open VSX
// (Tools > Color Themes...): search, install, apply. A VS Code theme colors the editor (token colors) and Nova's
// own windows (background, side bars, borders, accent) from its workbench colors.
'use strict';

const TH = { list: [], applied: null };
const TH_VARS = ['--bg', '--bg2', '--bg3', '--border', '--fg', '--fg-dim', '--accent', '--hover', '--select'];
// TextMate scopes -> the token names of Monaco's built-in tokenizers (rules match by prefix)
const TH_SCOPES = [
  [/^comment/, 'comment'], [/^string/, 'string'], [/^constant\.numeric/, 'number'], [/^constant\.language/, 'keyword'],
  [/^keyword\.operator/, 'operator'], [/^keyword|^storage/, 'keyword'], [/^entity\.name\.(type|class)|^support\.(type|class)|^entity\.other\.inherited-class/, 'type'],
  [/^entity\.name\.function|^support\.function|^meta\.function-call/, 'function'], [/^variable\.parameter/, 'variable.parameter'], [/^variable|^support\.variable/, 'variable'],
  [/^entity\.name\.tag/, 'tag'], [/^entity\.other\.attribute-name/, 'attribute.name'], [/^punctuation\.definition\.tag/, 'delimiter'],
  [/^markup\.heading/, 'keyword'], [/^constant\.character\.escape/, 'string.escape'], [/^string\.regexp/, 'regexp'], [/^invalid/, 'invalid']
];
const thHex = (c) => (typeof c === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) ? c : null);
// a VS Code theme -> Monaco theme data
function thToMonaco(t) {
  const rules = [];
  const seen = new Set();
  for (const tc of t.theme.tokenColors || []) {
    const s = tc.settings || {};
    const fg = thHex(s.foreground);
    if (!fg && !s.fontStyle) continue;
    const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope || '').split(',');
    for (const raw of scopes.map((x) => x.trim()).filter(Boolean)) {
      if (/\s/.test(raw)) continue; // descendant selectors ("meta.x string") don't map
      const hit = TH_SCOPES.find(([re]) => re.test(raw));
      for (const token of [raw, hit && hit[1]].filter(Boolean)) {
        const rule = { token };
        if (fg) rule.foreground = fg.slice(1);
        if (s.fontStyle) rule.fontStyle = s.fontStyle;
        // the first (most general) mapping wins for the Monaco name; exact scopes are always added
        if (token === raw || !seen.has(token)) { rules.push(rule); seen.add(token); }
      }
    }
  }
  const colors = {};
  for (const [k, v] of Object.entries(t.theme.colors || {})) if (/^editor|^editorLineNumber|^editorCursor|^editorWhitespace|^editorIndentGuide|^editorGutter|^minimap|^scrollbar/.test(k) && thHex(v)) colors[k] = v;
  if (!colors['editor.background'] && thHex((t.theme.colors || {})['editor.background'])) colors['editor.background'] = t.theme.colors['editor.background'];
  return { base: t.dark ? 'vs-dark' : 'vs', inherit: true, rules, colors };
}
// workbench colors -> Nova's CSS variables
function thVars(t) {
  const c = t.theme.colors || {};
  const pick = (...keys) => { for (const k of keys) if (thHex(c[k])) return c[k].slice(0, 7); return null; };
  return {
    '--bg': pick('editor.background'), '--bg2': pick('sideBar.background', 'panel.background', 'editorGroupHeader.tabsBackground'),
    '--bg3': pick('titleBar.activeBackground', 'activityBar.background', 'tab.inactiveBackground'), '--border': pick('panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder'),
    '--fg': pick('foreground', 'editor.foreground', 'sideBar.foreground'), '--fg-dim': pick('descriptionForeground', 'tab.inactiveForeground', 'editorLineNumber.foreground'),
    '--accent': pick('focusBorder', 'button.background', 'activityBarBadge.background', 'statusBar.background'), '--hover': pick('list.hoverBackground', 'toolbar.hoverBackground'),
    '--select': pick('list.activeSelectionBackground', 'editor.selectionBackground')
  };
}
function thApply(s) {
  const theme = s.theme || 'dark';
  const rootStyle = document.body.style;
  for (const v of TH_VARS) rootStyle.removeProperty(v);
  document.body.classList.remove('theme-hc');
  TH.applied = null;
  if (theme === 'hc-dark' || theme === 'hc-light') {
    document.body.className = `theme-${theme === 'hc-light' ? 'light' : 'dark'} theme-hc`;
    if (monacoRef) monacoRef.editor.setTheme(theme === 'hc-light' ? 'hc-light' : 'hc-black');
    TH.applied = theme;
    return;
  }
  if (!theme.startsWith('vsx:')) return;
  const t = TH.list.find((x) => `vsx:${x.id}` === theme);
  if (!t || !monacoRef) return;
  const name = `vsx-${TH.list.indexOf(t)}`;
  try { monacoRef.editor.defineTheme(name, thToMonaco(t)); monacoRef.editor.setTheme(name); } catch (e) { status(`Theme ${t.label}: ${e.message}`); return; }
  document.body.className = `theme-${t.dark ? 'dark' : 'light'}`;
  for (const [k, v] of Object.entries(thVars(t))) if (v) rootStyle.setProperty(k, v);
  TH.applied = theme;
}
const thApplySettings = applySettings;
applySettings = function (s) { thApplySettings(s); thApply(s); }; // eslint-disable-line no-func-assign

// the Color theme option lists the installed themes too
async function thLoad() {
  TH.list = await api.themes.list();
  const f = SETTINGS_SCHEMA.find((x) => x.key === 'theme');
  f.options = [['dark', 'Dark'], ['light', 'Light'], ['hc-dark', 'High Contrast Dark'], ['hc-light', 'High Contrast Light'], ...TH.list.map((t) => [`vsx:${t.id}`, `${t.label} (${t.extensionName})`])];
  if (state.settings.theme) thApply(state.settings);
}

// ---------------- Color Themes dialog ----------------
async function thShow() {
  $('#thDlg').classList.remove('hidden');
  thRenderInstalled();
  setTimeout(() => focusIfIdle($('#thQuery')), 30);
  if (!$('#thResults').children.length) thSearch('');
}
function thRenderInstalled() {
  const host = $('#thInstalled');
  host.innerHTML = '';
  const builtIn = [['dark', 'Dark'], ['light', 'Light'], ['hc-dark', 'High Contrast Dark'], ['hc-light', 'High Contrast Light']];
  for (const [id, label] of [...builtIn, ...TH.list.map((t) => [`vsx:${t.id}`, t.label, t])]) {
    const row = document.createElement('div');
    row.className = `th-row${state.settings.theme === id ? ' active' : ''}`;
    row.innerHTML = '<span class="th-name"></span><span class="dlg-desc"></span><span class="tb-spacer"></span><button class="th-apply">Apply</button>';
    row.querySelector('.th-name').textContent = label;
    const t = TH.list.find((x) => `vsx:${x.id}` === id);
    row.querySelector('.dlg-desc').textContent = t ? `  ${t.extensionName} · ${t.dark ? 'dark' : 'light'}` : '  built in';
    row.querySelector('.th-apply').onclick = () => updateSetting({ theme: id }).then(thRenderInstalled);
    if (t) { const rm = document.createElement('button'); rm.textContent = 'Remove'; rm.onclick = async () => { await api.themes.remove(t.extension); if (state.settings.theme.startsWith(`vsx:${t.extension}/`)) await updateSetting({ theme: 'dark' }); await thLoad(); thRenderInstalled(); }; row.appendChild(rm); }
    host.appendChild(row);
  }
}
async function thSearch(q) {
  const host = $('#thResults');
  host.innerHTML = '<div class="dlg-desc">Searching Open VSX...</div>';
  const r = await api.themes.search(q);
  host.innerHTML = '';
  if (r.error) { host.innerHTML = `<div class="dbx-err"></div>`; host.firstChild.textContent = r.error; return r; }
  for (const e of r) {
    const row = document.createElement('div');
    row.className = 'th-row';
    row.innerHTML = '<span class="th-name"></span><span class="dlg-desc th-desc"></span><span class="tb-spacer"></span><button class="th-install primary">Install</button>';
    row.querySelector('.th-name').textContent = e.displayName;
    row.querySelector('.th-desc').textContent = `  ${e.namespace} · ${e.downloads.toLocaleString()} downloads · ${e.description.slice(0, 90)}`;
    row.querySelector('.th-install').onclick = () => thInstall(e, row);
    host.appendChild(row);
  }
  if (!r.length) host.innerHTML = '<div class="dlg-desc">No themes found</div>';
  return r;
}
async function thInstall(e, row) {
  const b = row && row.querySelector('.th-install');
  if (b) { b.disabled = true; b.textContent = 'Installing...'; }
  const r = await api.themes.install(e.namespace, e.name);
  if (r.error) { status(r.error); if (b) { b.disabled = false; b.textContent = 'Install'; } return r; }
  await thLoad();
  if (r[0]) await updateSetting({ theme: `vsx:${r[0].id}` });
  thRenderInstalled();
  if (b) b.textContent = 'Installed';
  status(`Installed ${e.displayName}: ${r.map((t) => t.label).join(', ')}`);
  return r;
}

commands.colorThemes = () => thShow();
bus.on('ready', () => {
  $('#thQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') thSearch(e.target.value); });
  $('#thSearchBtn').onclick = () => thSearch($('#thQuery').value);
  $('#thClose').onclick = () => $('#thDlg').classList.add('hidden');
  thLoad();
});
