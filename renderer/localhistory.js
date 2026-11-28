// Nova IDE - Local History (File > Local History, or the tab's context): every save is kept for 5 days, also for
// files Git doesn't track. Pick a version to compare it with the file (diff view) or Restore it (one Undo step).
'use strict';

const LH = { path: null, versions: [] };
const lhAgo = (at) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} day(s) ago`; };

async function lhShow(path = state.active && state.active.path) {
  if (!path) return status('Open a file first');
  LH.path = path;
  LH.versions = await api.history.list(path);
  $('#lhTitle').textContent = `${baseName(path)} — ${LH.versions.length} version(s), kept 5 days`;
  const body = $('#lhBody');
  body.innerHTML = '';
  for (const v of LH.versions) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td class="lh-actions"><button class="lh-cmp">Compare</button><button class="lh-restore">Restore</button></td>';
    tr.children[0].textContent = new Date(v.at).toLocaleString();
    tr.children[1].textContent = lhAgo(v.at);
    tr.children[2].textContent = `${v.label ? `${v.label} · ` : ''}${v.size.toLocaleString()} bytes`;
    tr.querySelector('.lh-cmp').onclick = () => lhCompare(v);
    tr.querySelector('.lh-restore').onclick = () => lhRestore(v);
    tr.ondblclick = () => lhCompare(v);
    body.appendChild(tr);
  }
  if (!LH.versions.length) body.innerHTML = '<tr><td colspan="4" class="dlg-desc">No saved versions yet: they are kept from the next save.</td></tr>';
  showPanel('history');
  return LH.versions;
}
// the diff view of Git Changes: the old version on the left, the file (editable when open) on the right
async function lhCompare(v) {
  const path = LH.path;
  const old = await api.history.read(path, v.id);
  closeDiff();
  const tab = findTab(path);
  const modified = tab ? tab.model : monacoRef.editor.createModel(await api.readFile(path).catch(() => ''), langFor(path));
  const original = monacoRef.editor.createModel(old, langFor(path));
  const diffEditor = monacoRef.editor.createDiffEditor($('#diffEditor'), { automaticLayout: true, readOnly: !tab, originalEditable: false, renderSideBySide: !gitState.inline, fontSize: state.settings.fontSize, minimap: { enabled: false } });
  diffEditor.setModel({ original, modified });
  gitState.diff = { diffEditor, originalModel: original, modifiedModel: modified, ownsModel: !tab, path };
  $('#diffTitle').textContent = `${baseName(path)}  —  Local History ${new Date(v.at).toLocaleString()} ↔ current`;
  $('#diffView').classList.remove('hidden');
  return diffEditor;
}
async function lhRestore(v) {
  const path = LH.path;
  const text = await api.history.read(path, v.id);
  closeDiff();
  let tab = findTab(path);
  if (!tab) { await openFile(path); tab = findTab(path); }
  tab.model.pushStackElement();
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
  tab.model.pushStackElement();
  activate(tab);
  status(`Restored the version from ${lhAgo(v.at)} (not saved yet; Ctrl+Z undoes it)`);
}

bus.on('saved', (tab) => { if (state.settings.localHistory !== false && tab && tab.model) api.history.record(tab.path, tab.model.getValue()); });
commands.showLocalHistory = () => lhShow();
