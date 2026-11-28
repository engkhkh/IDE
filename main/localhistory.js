// Nova IDE - Local History: a copy of every saved file for 5 days (also of files Git doesn't track), to compare
// with and restore — like Rider / Passenger's Local History. Stored in the user data folder, per file.
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let root = null;
const KEEP_MS = 5 * 24 * 3600 * 1000;
const MAX_PER_FILE = 100;
const MAX_BYTES = 2 * 1024 * 1024;
const keyOf = (file) => crypto.createHash('sha1').update(process.platform === 'win32' ? file.toLowerCase() : file).digest('hex').slice(0, 20);
const dirOf = (file) => path.join(root, keyOf(file));

async function versions(file) {
  let names = [];
  try { names = await fsp.readdir(dirOf(file)); } catch { return []; }
  return names.filter((n) => /^\d+\.v$/.test(n)).map((n) => ({ id: n, at: +n.slice(0, -2) })).sort((a, b) => b.at - a.at);
}
async function prune(file, now = Date.now()) {
  const list = await versions(file);
  for (const [i, v] of list.entries()) if (i >= MAX_PER_FILE || now - v.at > KEEP_MS) await fsp.rm(path.join(dirOf(file), v.id), { force: true });
}
// called after each save: skips unchanged content and big files
async function record(file, text, label) {
  if (Buffer.byteLength(text) > MAX_BYTES) return false;
  const dir = dirOf(file);
  await fsp.mkdir(dir, { recursive: true });
  const list = await versions(file);
  if (list.length) { try { if (await fsp.readFile(path.join(dir, list[0].id), 'utf8') === text) return false; } catch {} }
  let at = Date.now();
  if (list.length && list[0].at >= at) at = list[0].at + 1;
  await fsp.writeFile(path.join(dir, `${at}.v`), text);
  await fsp.writeFile(path.join(dir, 'file.json'), JSON.stringify({ file }));
  if (label) await fsp.writeFile(path.join(dir, `${at}.label`), label);
  await prune(file);
  return true;
}
async function list(file) {
  const out = [];
  for (const v of await versions(file)) {
    let label = '';
    try { label = await fsp.readFile(path.join(dirOf(file), `${v.at}.label`), 'utf8'); } catch {}
    const st = await fsp.stat(path.join(dirOf(file), v.id)).catch(() => null);
    out.push({ id: v.id, at: v.at, label, size: st ? st.size : 0 });
  }
  return out;
}

module.exports = {
  record, list, versions, prune, setRoot(r) { root = r; },
  register({ ipcMain, app }) {
    root = path.join(app.getPath('userData'), 'history');
    ipcMain.handle('history:record', (_e, file, text, label) => record(file, text, label).catch(() => false));
    ipcMain.handle('history:list', (_e, file) => list(file));
    ipcMain.handle('history:read', (_e, file, id) => fsp.readFile(path.join(dirOf(file), path.basename(id)), 'utf8'));
  }
};
