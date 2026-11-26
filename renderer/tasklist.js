// Nova IDE - Task List (View > Task List, like Visual Studio): the TODO / HACK / UNDONE / FIXME comments
// of the whole folder. Saved files update their entries at once; the tokens are set in Tools > Options.
'use strict';

const TL = { items: [], filter: '', scanning: false };

function tlTokens() {
  return String(state.settings.taskListTokens || 'TODO, HACK, UNDONE, FIXME').split(/[,;\s]+/).map((t) => t.trim()).filter((t) => /^\w+$/.test(t));
}
// a token right after a comment start: //, #, /*, *, <!--, --, ', ;, REM
function tlRegexSource(tokens = tlTokens()) {
  return `(?://+|#+|/\\*+|^\\s*\\*+|<!--|--|'|;|\\bREM\\b)\\s*(${tokens.join('|')})\\b[:\\s-]*(.*?)\\s*(?:\\*/|-->)?\\s*$`;
}
function tlScanText(path, text, tokens = tlTokens()) {
  if (!tokens.length) return [];
  const re = new RegExp(tlRegexSource(tokens));
  const out = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const m = re.exec(line);
    if (m) out.push({ path, line: i + 1, col: m.index + 1, token: m[1], text: m[2] || m[1] });
  });
  return out;
}

async function tlScan() {
  if (!state.root) { TL.items = []; tlRender(); return; }
  const tokens = tlTokens();
  if (!tokens.length) { TL.items = []; tlRender(); return; }
  TL.scanning = true;
  tlRender();
  const res = await api.searchInFiles(state.root, tlRegexSource(tokens), { regex: true, caseSensitive: true, groups: true, limit: 5000 });
  TL.scanning = false;
  TL.items = Array.isArray(res) ? res.map((r) => ({ path: r.file, line: r.line, col: r.col, token: r.groups[1], text: r.groups[2] || r.groups[1] })) : [];
  // open files that are not saved yet count as they are in the editor
  for (const t of state.tabs) if (isDirty(t)) tlUpdate(t, false);
  tlRender();
}
function tlUpdate(tab, render = true) {
  TL.items = TL.items.filter((i) => !samePath(i.path, tab.path)).concat(tlScanText(tab.path, tab.model.getValue()));
  if (render) tlRender();
}

function tlRender() {
  const body = $('#tlBody');
  if (!body) return;
  const q = TL.filter.toLowerCase();
  const rows = TL.items
    .filter((i) => !q || `${i.token} ${i.text} ${i.path}`.toLowerCase().includes(q))
    .sort((a, b) => (normPathKey(a.path) < normPathKey(b.path) ? -1 : normPathKey(a.path) > normPathKey(b.path) ? 1 : a.line - b.line));
  $('#tlCount').textContent = TL.items.length;
  $('#tlSummary').textContent = TL.scanning ? 'Scanning...' : `${rows.length} item(s)${q ? ` matching "${TL.filter}"` : ''} · tokens: ${tlTokens().join(', ')}`;
  body.innerHTML = '';
  for (const i of rows.slice(0, 2000)) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="tl-token"></td><td></td><td></td><td></td>';
    tr.children[0].textContent = i.token;
    tr.children[1].textContent = i.text;
    tr.children[2].textContent = state.root ? i.path.replace(state.root, '').replace(/^[\\/]/, '') : i.path;
    tr.children[3].textContent = i.line;
    tr.onclick = () => openFile(i.path, i.line, i.col);
    body.appendChild(tr);
  }
}

Object.assign(commands, { showTaskList: () => { showPanel('tasks'); if (!TL.items.length && !TL.scanning) tlScan(); else tlRender(); } });
bus.on('ready', () => {
  $('#tlRefresh').onclick = () => tlScan();
  $('#tlFilter').oninput = (e) => { TL.filter = e.target.value; tlRender(); };
});
bus.on('folder', () => tlScan());
bus.on('saved', (tab) => tlUpdate(tab));
bus.on('settings', () => { const t = tlTokens().join(); if (TL.lastTokens !== undefined && TL.lastTokens !== t) tlScan(); TL.lastTokens = t; });
