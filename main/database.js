// Nova IDE - Database Explorer for SQLite files (the database most .NET / Node / Python samples start with;
// Visual Studio has SQL Server Object Explorer, Rider a full database tool). Uses sql.js (SQLite compiled to
// WebAssembly): no native module, the same on every OS. Each query reads the file; a statement that changes
// data writes the file back, unless someone else changed it meanwhile.
'use strict';

const fsp = require('fs/promises');
const path = require('path');

let SQL = null;
async function sqlite() {
  if (SQL) return SQL;
  const init = require('sql.js');
  const dir = path.dirname(require.resolve('sql.js'));
  SQL = await init({ locateFile: (f) => path.join(dir, f) });
  return SQL;
}
async function open(file) {
  const S = await sqlite();
  const st = await fsp.stat(file);
  const buf = await fsp.readFile(file);
  if (buf.length && buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error(`${path.basename(file)} is not a SQLite database`);
  return { db: new S.Database(buf), mtimeMs: st.mtimeMs };
}
const cell = (v) => (v instanceof Uint8Array ? { blob: v.length } : v);

async function schema(file) {
  const { db } = await open(file);
  try {
    const objects = db.exec("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    const out = [];
    for (const [name, type, sql] of objects.length ? objects[0].values : []) {
      const q = name.replace(/"/g, '""');
      const cols = db.exec(`PRAGMA table_info("${q}")`);
      const fks = type === 'table' ? db.exec(`PRAGMA foreign_key_list("${q}")`) : [];
      const idx = type === 'table' ? db.exec(`PRAGMA index_list("${q}")`) : [];
      let rows = null;
      try { rows = db.exec(`SELECT COUNT(*) FROM "${q}"`)[0].values[0][0]; } catch {}
      out.push({
        name, type, sql, rows,
        columns: cols.length ? cols[0].values.map(([, n, t, notnull, dflt, pk]) => ({ name: n, type: t, notNull: !!notnull, default: dflt, pk: pk > 0 })) : [],
        foreignKeys: fks.length ? fks[0].values.map((f) => ({ from: f[3], table: f[2], to: f[4] })) : [],
        indexes: idx.length ? idx[0].values.map((i) => ({ name: i[1], unique: !!i[2] })) : []
      });
    }
    return { objects: out };
  } finally { db.close(); }
}

async function query(file, sql, limit = 1000) {
  const { db, mtimeMs } = await open(file);
  try {
    const started = Date.now();
    const results = [];
    let changes = 0;
    // statement by statement: the grid shows the last result set, the message counts every change
    for (const stmt of db.iterateStatements(sql)) {
      const columns = stmt.getColumnNames();
      const rows = [];
      let more = false;
      while (stmt.step()) { if (rows.length < limit) rows.push(stmt.get().map(cell)); else { more = true; break; } }
      const ch = db.getRowsModified();
      if (columns.length) results.push({ columns, rows, more });
      else changes += ch;
      stmt.free();
    }
    let saved = false;
    if (changes > 0 || /^\s*(create|drop|alter)\b/im.test(sql)) {
      const st = await fsp.stat(file);
      if (st.mtimeMs !== mtimeMs) return { error: `${path.basename(file)} changed on disk while the query ran: nothing was written. Run it again.` };
      await fsp.writeFile(file, Buffer.from(db.export()));
      saved = true;
    }
    return { results, changes, saved, ms: Date.now() - started };
  } catch (e) {
    return { error: e.message };
  } finally { db.close(); }
}
async function create(file) {
  const S = await sqlite();
  const db = new S.Database();
  await fsp.writeFile(file, Buffer.from(db.export()));
  db.close();
  return true;
}

module.exports = {
  schema, query, create,
  register({ ipcMain }) {
    ipcMain.handle('db:schema', async (_e, file) => { try { return await schema(file); } catch (e) { return { error: e.message }; } });
    ipcMain.handle('db:query', (_e, file, sql, limit) => query(file, sql, limit));
    ipcMain.handle('db:create', async (_e, file) => { try { return await create(file); } catch (e) { return { error: e.message }; } });
  }
};
