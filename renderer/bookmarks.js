// Nova IDE - bookmarks, like Visual Studio's Bookmark window:
// Ctrl+K, Ctrl+K toggle · Ctrl+K, Ctrl+N next · Ctrl+K, Ctrl+P previous · Ctrl+K, Ctrl+L clear all · Ctrl+K, Ctrl+W window.
// A bookmark follows its line while you edit (it is an editor decoration); they are kept per folder.
'use strict';

const BM = { list: [], decos: new Map(), ids: new WeakMap(), saveTimer: null }; // list: [{ path, line, name }]; ids: bookmark -> decoration

const bmKey = () => (state.root ? `bookmarks:${normPathKey(state.root)}` : 'bookmarks:');
function bmLoad() { BM.list = load(bmKey(), []).filter((b) => b && b.path && b.line > 0); }
function bmSave() { store(bmKey(), BM.list); }
function bmSorted() {
  return [...BM.list].sort((a, b) => (normPathKey(a.path) < normPathKey(b.path) ? -1 : normPathKey(a.path) > normPathKey(b.path) ? 1 : a.line - b.line));
}
const bmOf = (path) => BM.list.filter((b) => samePath(b.path, path));

function bmDecorate(tab) {
  if (!tab || !tab.model || tab.model.isDisposed()) return;
  const k = normPathKey(tab.path);
  const old = BM.decos.get(k) || [];
  const mine = bmOf(tab.path);
  const ids = tab.model.deltaDecorations(old, mine.map((b) => {
    const ln = Math.min(b.line, tab.model.getLineCount());
    return { range: new monacoRef.Range(ln, 1, ln, 1), options: { glyphMarginClassName: 'bm-glyph', glyphMarginHoverMessage: { value: `Bookmark: ${b.name}` }, stickiness: 1, overviewRuler: { color: '#4da3ff', position: 4 } } };
  }));
  mine.forEach((b, i) => BM.ids.set(b, ids[i]));
  BM.decos.set(k, ids);
}
// lines move as text is edited: read them back from the decorations
function bmSync(tab) {
  if (!(BM.decos.get(normPathKey(tab.path)) || []).length) return;
  let changed = false;
  for (const b of bmOf(tab.path)) {
    const r = BM.ids.has(b) ? tab.model.getDecorationRange(BM.ids.get(b)) : null;
    if (r && r.startLineNumber !== b.line) { b.line = r.startLineNumber; changed = true; }
  }
  // two bookmarks squeezed onto one line (the lines between them were deleted) become one
  const seen = new Set();
  let merged = false;
  BM.list = BM.list.filter((b) => { if (!samePath(b.path, tab.path)) return true; if (seen.has(b.line)) { merged = true; return false; } seen.add(b.line); return true; });
  if (merged) { bmDecorate(tab); changed = true; }
  if (changed) { clearTimeout(BM.saveTimer); BM.saveTimer = setTimeout(() => { bmSave(); bmRender(); }, 300); }
}

function bmToggle(path = state.active && state.active.path, line = editor && editor.getPosition() && editor.getPosition().lineNumber) {
  if (!path || !line) return status('Open a file first');
  const i = BM.list.findIndex((b) => samePath(b.path, path) && b.line === line);
  if (i >= 0) BM.list.splice(i, 1);
  else BM.list.push({ path, line, name: `Bookmark${BM.list.length + 1}` });
  bmSave();
  const tab = findTab(path);
  if (tab) bmDecorate(tab);
  bmRender();
  status(i >= 0 ? 'Bookmark removed' : `Bookmark set at line ${line}`);
}
// next / previous over all files, in the Bookmark window's order (wraps around, like VS)
async function bmGo(dir) {
  for (const t of state.tabs) bmSync(t);
  const all = bmSorted();
  if (!all.length) return status('There are no bookmarks');
  const cur = state.active ? { path: state.active.path, line: editor.getPosition().lineNumber } : null;
  const cmp = (b) => (cur ? (normPathKey(b.path) === normPathKey(cur.path) ? b.line - cur.line : normPathKey(b.path) < normPathKey(cur.path) ? -1 : 1) : 0);
  const target = dir > 0 ? all.find((b) => cmp(b) > 0) || all[0] : [...all].reverse().find((b) => cmp(b) < 0) || all[all.length - 1];
  await openFile(target.path, target.line, 1);
}
function bmClear() {
  if (!BM.list.length) return status('There are no bookmarks');
  BM.list = [];
  bmSave();
  for (const t of state.tabs) bmDecorate(t);
  bmRender();
  status('All bookmarks deleted');
}

function bmRender() {
  const body = $('#bmBody');
  if (!body) return;
  for (const t of state.tabs) bmSync(t);
  const all = bmSorted();
  $('#bmCount').textContent = all.length;
  body.innerHTML = '';
  for (const b of all) {
    const tr = document.createElement('tr');
    const tab = findTab(b.path);
    const text = tab && b.line <= tab.model.getLineCount() ? tab.model.getLineContent(b.line).trim() : '';
    tr.innerHTML = '<td class="bm-name"></td><td></td><td></td><td class="bm-text"></td><td><button class="bm-del" title="Delete Bookmark">✕</button></td>';
    tr.children[0].textContent = b.name;
    tr.children[1].textContent = state.root ? b.path.replace(state.root, '.').replace(/^\.[\\/]/, '') : b.path;
    tr.children[2].textContent = b.line;
    tr.children[3].textContent = text.slice(0, 120);
    tr.ondblclick = () => openFile(b.path, b.line, 1);
    tr.onclick = (e) => { if (!e.target.closest('.bm-del')) openFile(b.path, b.line, 1); };
    tr.children[0].ondblclick = async (e) => { e.stopPropagation(); const n = await ask('Rename Bookmark', b.name); if (n) { b.name = n; bmSave(); bmRender(); } };
    tr.querySelector('.bm-del').onclick = () => bmToggle(b.path, b.line);
    body.appendChild(tr);
  }
}

Object.assign(commands, {
  bookmarkToggle: () => bmToggle(),
  bookmarkNext: () => bmGo(1),
  bookmarkPrev: () => bmGo(-1),
  bookmarkClearAll: () => bmClear(),
  showBookmarks: () => { bmRender(); showPanel('bookmarks'); }
});

bus.on('ready', () => {
  const { KeyMod, KeyCode } = monacoRef;
  const chord = (b, fn) => editor.addCommand(KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | b), fn);
  chord(KeyCode.KeyK, () => commands.bookmarkToggle());
  chord(KeyCode.KeyN, () => commands.bookmarkNext());
  chord(KeyCode.KeyP, () => commands.bookmarkPrev());
  chord(KeyCode.KeyL, () => commands.bookmarkClearAll());
  chord(KeyCode.KeyW, () => commands.showBookmarks());
  $('#bmPrev').onclick = () => bmGo(-1);
  $('#bmNext').onclick = () => bmGo(1);
  $('#bmToggle').onclick = () => bmToggle();
  $('#bmClear').onclick = () => bmClear();
  bmLoad();
  bmRender();
});
bus.on('folder', () => { BM.decos.clear(); bmLoad(); for (const t of state.tabs) bmDecorate(t); bmRender(); });
bus.on('tabOpened', (tab) => {
  bmDecorate(tab);
  tab.model.onDidChangeContent(() => bmSync(tab));
});
bus.on('tabClosing', (tab) => { bmSync(tab); bmSave(); BM.decos.delete(normPathKey(tab.path)); });
