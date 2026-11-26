// Nova IDE - Find and Replace in Files (Ctrl+Shift+F / Ctrl+Shift+H), like Visual Studio's dialog:
// match case, whole word, regular expressions ($1 in the replacement), file types ("*.cs; *.json").
// Replace All edits open files in their editor (Undo works, you save them) and writes the others to disk.
'use strict';

const RF = { last: { find: '', replace: '', include: '', caseSensitive: false, wholeWord: false, regex: false } };

function rfRegex(o) {
  let src = o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, o.caseSensitive ? 'gm' : 'gim');
}
// the new text and how many matches were replaced (plain replacement text is literal: "$" stays "$")
function rfReplaceText(text, o) {
  const re = rfRegex(o);
  const count = (text.match(re) || []).length;
  if (!count) return { text, count };
  // regular expressions: $1, $&, $$ like Visual Studio (and JavaScript); otherwise the text as typed
  const out = o.regex ? text.replace(re, o.replace) : text.replace(re, () => o.replace);
  return { text: out, count };
}

function rfShow(replace) {
  const dlg = $('#rfDlg');
  const sel = editor && editor.getModel() ? editor.getModel().getValueInRange(editor.getSelection()) : '';
  const o = RF.last;
  $('#rfTitle').textContent = replace ? 'Replace in Files' : 'Find in Files';
  $('#rfFind').value = sel && !sel.includes('\n') ? sel : o.find;
  $('#rfReplace').value = o.replace;
  $('#rfInclude').value = o.include;
  $('#rfCase').checked = o.caseSensitive;
  $('#rfWord').checked = o.wholeWord;
  $('#rfRegex').checked = o.regex;
  $('#rfReplaceRow').classList.toggle('hidden', !replace);
  $('#rfReplaceAll').classList.toggle('hidden', !replace);
  $('#rfMsg').textContent = state.root ? `Look in: ${state.root}` : 'Open a folder first';
  dlg.classList.remove('hidden');
  setTimeout(() => { focusIfIdle($('#rfFind')); $('#rfFind').select(); }, 30);
}
function rfOptions() {
  RF.last = {
    find: $('#rfFind').value, replace: $('#rfReplace').value, include: $('#rfInclude').value.trim(),
    caseSensitive: $('#rfCase').checked, wholeWord: $('#rfWord').checked, regex: $('#rfRegex').checked
  };
  return RF.last;
}
const rfClose = () => $('#rfDlg').classList.add('hidden');

function rfResultsHeader(host, text) {
  host.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'find-head';
  d.textContent = text;
  host.appendChild(d);
}
function rfRow(host, r, extra) {
  const d = document.createElement('div');
  d.className = 'find-row';
  d.innerHTML = '<span class="loc"></span>  <span class="txt"></span>';
  d.children[0].textContent = `${r.file.replace(state.root, '.')}(${r.line})`;
  d.children[1].textContent = extra || r.text;
  d.onclick = () => openFile(r.file, r.line, r.col);
  host.appendChild(d);
}

async function rfFindAll() {
  const o = rfOptions();
  if (!o.find) return;
  if (!state.root) return status('Open a folder first');
  try { rfRegex(o); } catch (e) { $('#rfMsg').textContent = `Invalid regular expression: ${e.message}`; return; }
  rfClose();
  status(`Searching for "${o.find}"...`);
  const res = await api.searchInFiles(state.root, o.find, { caseSensitive: o.caseSensitive, wholeWord: o.wholeWord, regex: o.regex, include: o.include });
  if (res && res.error) return status(res.error);
  // open files with unsaved edits are searched as they are in the editor
  const results = await rfMergeDirty(res, o);
  const host = $('#panel-find');
  const files = new Set(results.map((r) => normPathKey(r.file))).size;
  rfResultsHeader(host, `Find all "${o.find}"${o.include ? `, "${o.include}"` : ''}${o.caseSensitive ? ', Match case' : ''}${o.wholeWord ? ', Whole word' : ''}${o.regex ? ', Regular expressions' : ''} — ${results.length} result(s) in ${files} file(s)`);
  for (const r of results) rfRow(host, r);
  showPanel('find');
  status(`Found ${results.length} result(s) in ${files} file(s)`);
  return results;
}
async function rfMergeDirty(res, o) {
  const dirty = state.tabs.filter(isDirty);
  if (!dirty.length) return res;
  const out = res.filter((r) => !dirty.some((t) => samePath(t.path, r.file)));
  const re = rfRegex(o);
  for (const t of dirty) {
    if (o.include && !rfIncludeTest(o.include, baseName(t.path))) continue;
    t.model.getLinesContent().forEach((line, i) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) out.push({ file: t.path, line: i + 1, col: m.index + 1, len: m[0].length, text: line.trim().slice(0, 200) });
    });
  }
  return out.sort((a, b) => (normPathKey(a.file) < normPathKey(b.file) ? -1 : normPathKey(a.file) > normPathKey(b.file) ? 1 : a.line - b.line));
}
function rfIncludeTest(mask, name) {
  const parts = mask.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  return !parts.length || parts.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(name));
}

async function rfReplaceAll() {
  const o = rfOptions();
  if (!o.find) return;
  if (!state.root) return status('Open a folder first');
  try { rfRegex(o); } catch (e) { $('#rfMsg').textContent = `Invalid regular expression: ${e.message}`; return; }
  rfClose();
  const res = await api.searchInFiles(state.root, o.find, { caseSensitive: o.caseSensitive, wholeWord: o.wholeWord, regex: o.regex, include: o.include, limit: 20000 });
  if (res && res.error) return status(res.error);
  const merged = await rfMergeDirty(res, o);
  const files = [...new Map(merged.map((r) => [normPathKey(r.file), r.file])).values()];
  const host = $('#panel-find');
  const changed = [];
  let total = 0;
  for (const file of files) {
    const tab = findTab(file);
    if (tab) {
      const { text, count } = rfReplaceText(tab.model.getValue(), o);
      if (!count) continue;
      // one undoable edit for the whole file
      tab.model.pushStackElement();
      tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
      tab.model.pushStackElement();
      total += count; changed.push({ file, count, open: true });
    } else {
      let before;
      try { before = await api.readFile(file); } catch { continue; }
      const { text, count } = rfReplaceText(before, o);
      if (!count) continue;
      await api.writeFile(file, text);
      total += count; changed.push({ file, count, open: false });
    }
  }
  renderTabs();
  rfResultsHeader(host, `Replace all "${o.find}" with "${o.replace}" — ${total} occurrence(s) replaced in ${changed.length} file(s)${changed.some((c) => c.open) ? ' (open files are changed in the editor: save them to keep the changes)' : ''}`);
  for (const c of changed) rfRow(host, { file: c.file, line: 1, col: 1 }, `${c.count} occurrence(s)${c.open ? ' · open in the editor, not saved' : ' · saved'}`);
  showPanel('find');
  status(`${total} occurrence(s) replaced in ${changed.length} file(s)`);
  bus.emit('replacedInFiles', changed);
  return { total, files: changed.length };
}

commands.findInFiles = () => rfShow(false);
commands.replaceInFiles = () => rfShow(true);
bus.on('ready', () => {
  $('#rfFindAll').onclick = () => rfFindAll();
  $('#rfReplaceAll').onclick = () => rfReplaceAll();
  $('#rfCancel').onclick = rfClose;
  $('#rfClose').onclick = rfClose;
  $('#rfDlg').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); rfClose(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); ($('#rfReplaceRow').classList.contains('hidden') ? rfFindAll : rfReplaceAll)(); }
  });
});
