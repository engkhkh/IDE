// Nova IDE - Database Explorer (View > Database Explorer): the SQLite databases of the folder (*.db, *.sqlite,
// *.sqlite3, *.db3) or any you add; tables and views with columns, keys, indexes and row counts; double-click a
// table for its first rows; a query box (Ctrl+Enter) and Ctrl+Shift+E in a .sql file run SQL on the chosen database.
'use strict';

const DBX = { conns: [], current: null, schema: null, open: new Set() };
const dbxKey = () => `nova.db:${state.root ? normPathKey(state.root) : ''}`;
const dbxQuote = (n) => `"${String(n).replace(/"/g, '""')}"`;

async function dbxDiscover() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(dbxKey()) || '[]'); } catch {}
  const files = state.root ? await api.ws.listFiles(state.root).catch(() => []) : [];
  const found = (files || []).filter((f) => /\.(db|sqlite|sqlite3|db3)$/i.test(f) && !/[\\/](bin|obj|node_modules)[\\/]/.test(f));
  DBX.conns = [...new Set([...saved, ...found])];
  if (!DBX.conns.some((c) => samePath(c, DBX.current || ''))) DBX.current = DBX.conns[0] || null;
  dbxRenderConns();
  if (DBX.current) await dbxLoad();
  else { DBX.schema = null; dbxRenderTree(); }
}
function dbxRenderConns() {
  const sel = $('#dbxConn');
  sel.innerHTML = DBX.conns.length ? '' : '<option value="">No SQLite database in this folder</option>';
  for (const c of DBX.conns) { const o = document.createElement('option'); o.value = c; o.textContent = state.root && c.startsWith(state.root) ? c.slice(state.root.length + 1) : c; sel.appendChild(o); }
  if (DBX.current) sel.value = DBX.current;
}
async function dbxLoad() {
  if (!DBX.current) return;
  $('#dbxMsg').textContent = 'Reading...';
  DBX.schema = await api.db.schema(DBX.current);
  dbxRenderTree();
  return DBX.schema;
}
function dbxRenderTree() {
  const host = $('#dbxTree');
  host.innerHTML = '';
  const s = DBX.schema;
  if (!s) { $('#dbxMsg').textContent = DBX.conns.length ? '' : 'Add a .db / .sqlite file with ＋'; return; }
  if (s.error) { $('#dbxMsg').textContent = s.error; return; }
  $('#dbxMsg').textContent = `${s.objects.filter((o) => o.type === 'table').length} table(s), ${s.objects.filter((o) => o.type === 'view').length} view(s)`;
  for (const o of s.objects) {
    const row = document.createElement('div');
    row.className = 'dbx-obj';
    const open = DBX.open.has(o.name);
    row.innerHTML = '<span class="ch-twist"></span><span></span><span class="dbx-name"></span><span class="ch-detail"></span>';
    row.children[0].textContent = open ? '▾' : '▸';
    row.children[1].textContent = o.type === 'view' ? '👁' : '▦';
    row.children[2].textContent = o.name;
    row.children[3].textContent = o.rows != null ? `${o.rows} row(s)` : '';
    row.onclick = (e) => {
      if (e.detail === 2) { dbxSelectTop(o); return; }
      if (open) DBX.open.delete(o.name); else DBX.open.add(o.name);
      dbxRenderTree();
    };
    row.oncontextmenu = (e) => { e.preventDefault(); popup(e.clientX, e.clientY, [
      { label: 'Select Top 200 Rows', run: () => dbxSelectTop(o) },
      { label: 'Script as CREATE', run: () => { $('#dbxSql').value = `${o.sql};`; } },
      { label: 'Copy Name', run: () => navigator.clipboard.writeText(o.name).catch(() => {}) }
    ]); };
    host.appendChild(row);
    if (!open) continue;
    for (const c of o.columns) {
      const fk = o.foreignKeys.find((f) => f.from === c.name);
      const r = document.createElement('div');
      r.className = 'dbx-col';
      r.textContent = `${c.pk ? '🔑 ' : fk ? '🔗 ' : ''}${c.name}  ${c.type || 'ANY'}${c.notNull ? ' NOT NULL' : ''}${fk ? ` → ${fk.table}(${fk.to})` : ''}`;
      host.appendChild(r);
    }
    for (const i of o.indexes) {
      const r = document.createElement('div');
      r.className = 'dbx-col dbx-idx';
      r.textContent = `⚡ ${i.name}${i.unique ? ' (unique)' : ''}`;
      host.appendChild(r);
    }
  }
}
function dbxSelectTop(o) {
  $('#dbxSql').value = `SELECT * FROM ${dbxQuote(o.name)} LIMIT 200;`;
  return dbxRun();
}

async function dbxRun(sql = $('#dbxSql').value) {
  if (!DBX.current) return status('Choose a database first');
  if (!sql.trim()) return;
  showPanel('database');
  $('#dbxResultMsg').textContent = 'Running...';
  const r = await api.db.query(DBX.current, sql);
  const grid = $('#dbxGrid');
  grid.innerHTML = '';
  if (r.error) { $('#dbxResultMsg').textContent = `Error: ${r.error}`; $('#dbxResultMsg').classList.add('dbx-err'); return r; }
  $('#dbxResultMsg').classList.remove('dbx-err');
  const last = r.results[r.results.length - 1];
  const parts = [];
  if (last) parts.push(`${last.rows.length}${last.more ? '+' : ''} row(s)`);
  if (r.changes) parts.push(`${r.changes} row(s) affected`);
  if (r.saved) parts.push(`saved to ${baseName(DBX.current)}`);
  $('#dbxResultMsg').textContent = `${parts.join(' · ') || 'Done'} · ${r.ms} ms`;
  if (last) {
    const head = document.createElement('tr');
    for (const c of last.columns) { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    const tbody = document.createElement('tbody');
    for (const row of last.rows) {
      const tr = document.createElement('tr');
      for (const v of row) {
        const td = document.createElement('td');
        if (v === null) { td.textContent = 'NULL'; td.className = 'dbx-null'; }
        else if (v && typeof v === 'object' && 'blob' in v) { td.textContent = `(blob, ${v.blob} bytes)`; td.className = 'dbx-null'; }
        else td.textContent = String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    grid.append(thead, tbody);
  }
  if (r.saved) dbxLoad();
  bus.emit('dbQuery', r);
  return r;
}
async function dbxAdd() {
  const p = await ask('SQLite database file (a new path creates an empty database)', state.root ? `${state.root}${sep()}app.db` : '');
  if (!p) return;
  const st = await api.ws.stat(p);
  if (!st.exists) { const r = await api.db.create(p); if (r && r.error) return status(r.error); }
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(dbxKey()) || '[]'); } catch {}
  if (!saved.includes(p)) saved.push(p);
  localStorage.setItem(dbxKey(), JSON.stringify(saved));
  DBX.current = p;
  await dbxDiscover();
}

commands.showDatabase = () => { showPanel('database'); dbxDiscover(); };
commands.executeSql = () => {
  const tab = state.active;
  if (!tab || !/\.sql$/i.test(tab.path)) return status('Open a .sql file first');
  const sel = editor.getSelection();
  return dbxRun(sel && !sel.isEmpty() ? tab.model.getValueInRange(sel) : tab.model.getValue());
};
bus.on('ready', () => {
  $('#dbxConn').onchange = (e) => { DBX.current = e.target.value || null; DBX.open.clear(); dbxLoad(); };
  $('#dbxRefresh').onclick = () => dbxDiscover();
  $('#dbxAdd').onclick = () => dbxAdd();
  $('#dbxExec').onclick = () => dbxRun();
  $('#dbxSql').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); dbxRun(); } });
  editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Shift | monacoRef.KeyCode.KeyE, () => commands.executeSql());
});
bus.on('folder', () => { DBX.conns = []; DBX.current = null; DBX.schema = null; });
