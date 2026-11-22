// Nova IDE - integrated terminal panel (xterm.js front end, node-pty back end)
'use strict';

const terminals = []; // { id, term, fit, el, title, exited }
let activeTerm = null;

const TERM_THEMES = {
  dark: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e', selectionBackground: '#add6ff' }
};
const termTheme = () => TERM_THEMES[state.settings.theme === 'light' ? 'light' : 'dark'];

// Keys the IDE should handle even while the terminal has focus
const IDE_KEYS = [
  (e) => e.ctrlKey && e.key === '`',
  (e) => e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p'),
  (e) => e.ctrlKey && !e.shiftKey && (e.key === 'p' || e.key === 'P'),
  (e) => e.ctrlKey && e.key === ',',
  (e) => e.key === 'F5' || e.key === 'F12',
  (e) => e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')
];

async function newTerminal(cwd) {
  if (typeof Terminal === 'undefined') { log('Terminal component missing: run "npm install" in the NovaIDE folder.\n', 'stderr'); showPanel('output'); return; }
  revealTerminalPanel();
  const host = $('#panel-terminal');
  const el = document.createElement('div');
  el.className = 'term-instance';
  host.appendChild(el);

  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: state.settings.terminalFontSize || 13,
    cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: termTheme()
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try { fit.fit(); } catch {}

  const info = await api.term.create({ cwd: cwd || state.root || undefined, cols: term.cols, rows: term.rows });
  const t = { id: info.id, term, fit, el, title: `${baseName(info.shell).replace(/\.exe$/i, '')} ${terminals.length + 1}`, exited: false };
  terminals.push(t);
  if (info.mode === 'pipe') term.writeln('\x1b[33m(basic mode: native terminal module not loaded, run "npm install" to enable full terminal)\x1b[0m');

  term.onData((data) => api.term.write(t.id, data));
  term.onResize(({ cols, rows }) => api.term.resize(t.id, cols, rows));

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (IDE_KEYS.some((k) => k(e))) return false; // let the menu accelerator handle it
    // Ctrl+C copies when there is a selection, otherwise sends ^C (like Visual Studio's terminal)
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); e.preventDefault(); return false;
    }
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      navigator.clipboard.readText().then((txt) => txt && term.paste(txt));
      return false;
    }
    return true;
  });
  el.addEventListener('contextmenu', (e) => { // right click: copy selection or paste
    e.preventDefault();
    if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); }
    else navigator.clipboard.readText().then((txt) => txt && term.paste(txt));
  });

  selectTerminal(t);
  return t;
}

function selectTerminal(t) {
  activeTerm = t;
  for (const x of terminals) x.el.classList.toggle('active', x === t);
  renderTermSelect();
  if (t) requestAnimationFrame(() => { fitActive(); t.term.focus(); });
}

function renderTermSelect() {
  const sel = $('#termSelect');
  sel.innerHTML = '';
  terminals.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = t.title + (t.exited ? ' (exited)' : '');
    if (t === activeTerm) o.selected = true;
    sel.appendChild(o);
  });
}
$('#termSelect').onchange = (e) => selectTerminal(terminals[+e.target.value]);

async function killTerminal(t = activeTerm) {
  if (!t) return;
  if (!t.exited) await api.term.kill(t.id);
  t.term.dispose();
  t.el.remove();
  terminals.splice(terminals.indexOf(t), 1);
  selectTerminal(terminals[terminals.length - 1] || null);
}

function fitActive() {
  if (!activeTerm || !$('#panel-terminal').classList.contains('active')) return;
  try { activeTerm.fit.fit(); } catch {}
}

api.on('term:data', ({ id, data }) => { const t = terminals.find((x) => x.id === id); if (t) t.term.write(data); });
api.on('term:exit', ({ id, code }) => {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  t.exited = true;
  t.term.writeln(`\r\n\x1b[90m[process exited with code ${code}] - press any key to close\x1b[0m`);
  const sub = t.term.onKey(() => { sub.dispose(); killTerminal(t); });
  renderTermSelect();
});

// Fit on panel resize
new ResizeObserver(() => fitActive()).observe($('#panel-terminal'));

// Show terminal controls only on the Terminal tab; create the first terminal lazily
const _showPanel = showPanel;
function revealTerminalPanel() {
  _showPanel('terminal');
  $('#termControls').classList.remove('hidden');
  $('#btnClearOutput').classList.add('hidden');
}
showPanel = function (name) { // eslint-disable-line no-func-assign
  _showPanel(name);
  const isTerm = name === 'terminal';
  $('#termControls').classList.toggle('hidden', !isTerm);
  $('#btnClearOutput').classList.toggle('hidden', isTerm);
  if (isTerm) {
    if (!terminals.length && !creatingFirst) { creatingFirst = true; newTerminal().finally(() => { creatingFirst = false; }); }
    else requestAnimationFrame(() => { fitActive(); activeTerm && activeTerm.term.focus(); });
  }
};
let creatingFirst = false;

bus.on('settings', (s) => {
  for (const t of terminals) {
    t.term.options.theme = termTheme();
    t.term.options.fontSize = s.terminalFontSize || 13;
  }
  fitActive();
});

$('#btnNewTerm').onclick = () => newTerminal();
$('#btnKillTerm').onclick = () => killTerminal();
commands.showTerminal = () => showPanel('terminal');
commands.newTerminal = () => newTerminal();
commands.killTerminal = () => killTerminal();

// Open a terminal in a specific folder (used by the Solution Explorer context menu)
window.openTerminalAt = (dir) => newTerminal(dir);
