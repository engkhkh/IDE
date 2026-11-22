// Nova IDE - workspace: file watcher reactions, reload-from-disk, Solution Explorer search + collapse
'use strict';

// ---------- reload open files changed outside the IDE ----------
async function reloadTabFromDisk(tab) {
  let text;
  try { text = await api.readFile(tab.path); } catch { return false; }
  if (text === tab.model.getValue()) { tab.diskVersion = text; return false; }
  const view = state.active === tab ? editor.saveViewState() : null;
  // pushEditOperations keeps undo history (Ctrl+Z goes back to the old content)
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
  tab.saved = tab.model.getAlternativeVersionId();
  tab.diskVersion = text;
  if (view) editor.restoreViewState(view);
  renderTabs();
  return true;
}

const warnedConflicts = new Set();
let treeTimer = null;
const normP = (p) => p.replace(/\//g, '\\').toLowerCase();

api.on('fs:changed', async ({ root, paths }) => {
  if (!state.root || normP(root) !== normP(state.root)) return;

  if (state.settings.explorerAutoRefresh !== false && !$('#treeFilter').value) {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => renderTree(), 150);
  }

  const changed = new Set(paths.map(normP));
  for (const tab of state.tabs) {
    if (!changed.has(normP(tab.path))) continue;
    const st = await api.ws.stat(tab.path);
    if (!st.exists) { status(`${baseName(tab.path)} was deleted on disk`); continue; }
    if (isDirty(tab)) {
      let disk; try { disk = await api.readFile(tab.path); } catch { continue; }
      if (disk !== tab.diskVersion && !warnedConflicts.has(tab.path)) {
        warnedConflicts.add(tab.path);
        log(`${tab.path} changed on disk while you have unsaved edits. Saving will overwrite the disk version.\n`, 'stderr');
      }
    } else if (state.settings.reloadChangedFiles !== false) {
      if (await reloadTabFromDisk(tab)) status(`Reloaded ${baseName(tab.path)} (changed on disk)`);
    }
  }
});
bus.on('saved', (tab) => warnedConflicts.delete(tab.path));

// ---------- Solution Explorer search (Ctrl+;) ----------
let filterTimer = null;
$('#treeFilter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyTreeFilter, 150);
});
$('#treeFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; applyTreeFilter(); }
  if (e.key === 'Enter') { const first = $('#tree .tree-row[data-file]'); if (first) first.click(); }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === ';') { e.preventDefault(); showSideSolution(); $('#treeFilter').focus(); $('#treeFilter').select(); }
});
function showSideSolution() {
  const btn = document.querySelector('#sideTabs button[data-side="solution"]');
  if (btn && !btn.classList.contains('active')) btn.click();
  if ($('#explorer').classList.contains('hidden')) commands.toggleExplorer();
}

async function applyTreeFilter() {
  const q = $('#treeFilter').value.trim().toLowerCase();
  if (!q) return renderTree();
  if (!state.root) return;
  const files = await api.ws.listFiles(state.root);
  const host = $('#tree');
  const rootLen = state.root.length + 1;
  const hits = files.filter((f) => baseName(f).toLowerCase().includes(q)).slice(0, 300);
  host.innerHTML = '';
  if (!hits.length) { const d = document.createElement('div'); d.className = 'git-empty'; d.textContent = 'No matching files'; host.appendChild(d); return; }
  for (const f of hits) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = f;
    row.dataset.file = '1';
    row.innerHTML = `<span>${ICONS[ext(f)] || '📄'}</span><span class="label"></span><span class="tree-dim"></span><span class="git-badge"></span>`;
    row.querySelector('.label').textContent = baseName(f);
    row.querySelector('.tree-dim').textContent = dirName(f.slice(rootLen)) === f.slice(rootLen) ? '' : dirName(f.slice(rootLen));
    row.onclick = () => { state.selectedPath = f; openFile(f); };
    host.appendChild(row);
  }
  bus.emit('treeRendered');
}

// ---------- Collapse All / Refresh ----------
// keeps the solution node (and the "already opened" markers) so Solution view collapses to the list of projects
commands.collapseAll = () => { state.expanded = new Set([state.root, ...[...state.expanded].filter((k) => k.startsWith('sln:'))]); saveExpanded(); renderTree(); };
commands.refreshExplorer = () => { $('#treeFilter').value = ''; renderTree(); };
$('#btnCollapse').onclick = commands.collapseAll;
