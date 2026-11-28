// Nova IDE - Vim mode (Options > Text Editor > Vim mode, or Edit > Advanced > Toggle Vim Mode): normal, insert,
// visual and command-line modes in every editor (monaco-vim); :w saves, :q closes the tab, :wq both.
'use strict';

const VIM = { lib: null, modes: new Map() };
async function vimLib() {
  if (VIM.lib) return VIM.lib;
  // the UMD build, run without the AMD loader so it uses the global monaco
  const url = new URL('../node_modules/monaco-vim/dist/monaco-vim.umd.js', location.href);
  let p = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  const src = await api.readFile(p);
  const holder = { monaco: monacoRef };
  new Function('define', 'exports', 'module', 'globalThis', 'self', `${src}\n//# sourceURL=monaco-vim.umd.js`).call(holder, undefined, undefined, undefined, holder, holder);
  VIM.lib = holder.MonacoVim;
  const Vim = VIM.lib.VimMode.Vim;
  Vim.defineEx('write', 'w', () => saveTab());
  Vim.defineEx('quit', 'q', () => closeTab());
  Vim.defineEx('wq', 'wq', async () => { await saveTab(); closeTab(); });
  return VIM.lib;
}
async function vimAttach(ed, bar) {
  if (VIM.modes.has(ed)) return;
  VIM.modes.set(ed, null); // claimed: a second call while the library loads does nothing
  const lib = await vimLib();
  if (!VIM.modes.has(ed)) return; // turned off meanwhile
  VIM.modes.set(ed, lib.initVimMode(ed, bar));
}
function vimDetach(ed) { const m = VIM.modes.get(ed); VIM.modes.delete(ed); if (m) m.dispose(); }
async function vimApply() {
  const on = !!state.settings.vimMode;
  $('#stVim').classList.toggle('hidden', !on);
  if (on) { await vimAttach(editor, $('#stVim')); if (SV.editor) await vimAttach(SV.editor, $('#stVim')); }
  else { vimDetach(editor); if (SV.editor) vimDetach(SV.editor); $('#stVim').textContent = ''; }
}
commands.toggleVimMode = () => updateSetting({ vimMode: !state.settings.vimMode });
bus.on('settings', () => { if (window.monaco && editor) vimApply().catch((e) => status(`Vim mode: ${e.message}`)); });
bus.on('ready', () => { if (state.settings.vimMode) vimApply().catch((e) => status(`Vim mode: ${e.message}`)); });
