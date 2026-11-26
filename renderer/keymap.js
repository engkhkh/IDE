// Nova IDE - one keyboard dispatcher for all shortcuts.
// Menu items only *display* their shortcut (registerAccelerator: false in main.js); this file runs them,
// so a key is handled exactly once. Keys marked `editor` are left to the code editor when it has focus.
'use strict';

const KEY_CODES = { '`': 'Backquote', '\\': 'Backslash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', '.': 'Period', Space: 'Space' };

function parseAccelerator(acc) {
  const parts = acc.split('+');
  // "Ctrl++" style is not used; a trailing empty part would mean '+'
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  let code;
  if (/^[A-Z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  else if (/^F\d{1,2}$/i.test(key)) code = key.toUpperCase();
  else code = KEY_CODES[key] || key;
  return { ctrl: mods.has('ctrl') || mods.has('cmdorctrl'), shift: mods.has('shift'), alt: mods.has('alt'), code };
}

let keymap = [];
// Two-key chords like Visual Studio's "Ctrl+R, A". Menu items with a chord come from main.js; Rename is built in.
let chords = [];
const parseChord = (c) => { const [a, b] = c.split(',').map((x) => x.trim()); return { first: parseAccelerator(a), second: parseAccelerator(b), firstLabel: a }; };
api.keymap().then((list) => {
  keymap = list.filter((k) => k.key).map((k) => ({ ...k, ...parseAccelerator(k.key) }));
  chords = [...list.filter((k) => k.chord), { chord: 'Ctrl+R, Ctrl+R', cmd: 'renameSymbol', label: 'Rename' }].map((k) => ({ ...k, ...parseChord(k.chord) }));
});
const keyMatches = (k, e) => k.code === e.code && k.ctrl === e.ctrlKey && k.shift === e.shiftKey && k.alt === e.altKey && !e.metaKey;
let pendingChord = null;
let chordTimer = null;

function focusContext() {
  const a = document.activeElement;
  if (!a) return 'none';
  if (a.closest('.monaco-editor')) return 'editor';
  if (a.closest('.xterm')) return 'terminal';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return 'input';
  return 'none';
}

// the editor's own Ctrl+K chords (Ctrl+K, Ctrl+D format, Ctrl+K, Ctrl+K bookmark, ...): the second key belongs to
// the editor too, even when it is a shortcut of its own (Ctrl+N, Ctrl+P, Ctrl+W, Ctrl+L)
let editorChord = 0;
window.addEventListener('keydown', (e) => {
  if (/^(Control|Shift|Alt|Meta)$/.test(e.key)) return;
  if (editorChord && Date.now() - editorChord < 2500 && focusContext() === 'editor') { editorChord = 0; return; }
  editorChord = 0;
  if (e.code === 'KeyK' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && focusContext() === 'editor' && !pendingChord) { editorChord = Date.now(); return; }
  // second key of a chord
  if (pendingChord) {
    const first = pendingChord;
    pendingChord = null;
    clearTimeout(chordTimer);
    e.preventDefault();
    e.stopPropagation();
    const c = chords.find((x) => x.firstLabel === first && keyMatches(x.second, e));
    if (c && commands[c.cmd]) { status('Ready'); commands[c.cmd](); }
    else status(`The key combination (${first}, ${e.key.length === 1 ? e.key.toUpperCase() : e.key}) is not a command.`);
    return;
  }
  // first key of a chord (not in the terminal, where Ctrl+R searches history, or in text boxes)
  const ctx0 = focusContext();
  const starts = ctx0 !== 'terminal' && ctx0 !== 'input' ? chords.find((x) => keyMatches(x.first, e)) : null;
  if (starts) {
    e.preventDefault();
    e.stopPropagation();
    pendingChord = starts.firstLabel;
    status(`(${starts.firstLabel}) was pressed. Waiting for second key of chord...`);
    chordTimer = setTimeout(() => { pendingChord = null; status('Ready'); }, 2500);
    return;
  }
  if (e.repeat && !/^F\d/.test(e.code)) return;
  const hit = keymap.find((k) => keyMatches(k, e));
  if (!hit) return;
  const ctx = focusContext();
  // editor-native keys: let Monaco (or the text box / terminal) do its own thing
  if (hit.editor && ctx !== 'none') return;
  if (!commands[hit.cmd]) return;
  e.preventDefault();
  e.stopPropagation();
  commands[hit.cmd]();
}, true); // capture phase: runs before the editor/terminal see the key

// ---------- editor commands used by the menu (Edit > Go To / IntelliSense / Advanced) ----------
const editorAction = (id) => () => {
  if (!editor || !state.active) return status('Open a file first');
  editor.focus();
  editor.trigger('menu', id);
};
Object.assign(commands, {
  gotoDefinition: editorAction('editor.action.revealDefinition'),
  peekDefinition: editorAction('editor.action.peekDefinition'),
  gotoImplementation: editorAction('editor.action.goToImplementation'),
  findReferences: editorAction('editor.action.goToReferences'),
  renameSymbol: editorAction('editor.action.rename'),
  quickActions: editorAction('editor.action.quickFix'),
  triggerSuggest: editorAction('editor.action.triggerSuggest'),
  parameterInfo: editorAction('editor.action.triggerParameterHints'),
  quickInfo: editorAction('editor.action.showHover'),
  commentLines: editorAction('editor.action.addCommentLine'),
  uncommentLines: editorAction('editor.action.removeCommentLine'),
  format: editorAction('editor.action.formatDocument'),
  devTools: () => api.toggleDevTools(),
  showShortcuts: () => {
    const rows = keymap.map((k) => `  ${k.key.padEnd(18)} ${k.label}`).join('\n');
    log(`\nKeyboard shortcuts\n${rows}\n  Ctrl+K, Ctrl+D     Format Document\n  Ctrl+K, Ctrl+C     Comment Selection\n  Ctrl+K, Ctrl+U     Uncomment Selection\n  Ctrl+R, Ctrl+R     Rename\n  Ctrl+;             Search Solution Explorer\n`, 'info');
    showPanel('output');
  }
});

// Visual Studio key chords inside the editor
bus.on('ready', () => {
  const { KeyMod, KeyCode } = monacoRef;
  const chord = (a, b, action) => editor.addCommand(KeyMod.chord(KeyMod.CtrlCmd | a, KeyMod.CtrlCmd | b), () => editor.trigger('keyboard', action));
  chord(KeyCode.KeyK, KeyCode.KeyD, 'editor.action.formatDocument');
  chord(KeyCode.KeyK, KeyCode.KeyC, 'editor.action.addCommentLine');
  chord(KeyCode.KeyK, KeyCode.KeyU, 'editor.action.removeCommentLine');
  // Ctrl+R, Ctrl+R (Rename) is handled by the chord table above, together with the Test chords
});
