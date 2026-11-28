// Nova IDE - Workspace Trust: a folder's code (builds, MSBuild targets, run/debug, tests, tasks, Hot Reload,
// .http requests, the agent tools) doesn't run until you trust the folder — Restricted Mode until then.
// Trusting a folder trusts its subfolders. NOVA_TRUST_ALL=1 trusts everything (test automation).
'use strict';

const fsp = require('fs/promises');
const path = require('path');

let file = null;
let cache = null;
const norm = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { cache = { trusted: [] }; }
  return cache;
}
async function isTrusted(folder) {
  if (process.env.NOVA_TRUST_ALL === '1' || !folder) return true;
  const s = await require('./settings').read();
  if (s.workspaceTrust === false) return true;
  const f = norm(folder);
  return (await load()).trusted.some((t) => f === t || f.startsWith(t + path.sep));
}
async function setTrusted(folder, trusted) {
  const c = await load();
  const f = norm(folder);
  c.trusted = c.trusted.filter((t) => t !== f);
  if (trusted) c.trusted.push(f);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(c, null, 2));
  return true;
}

module.exports = {
  isTrusted, setTrusted,
  register({ ipcMain, app }) {
    file = path.join(app.getPath('userData'), 'trusted-folders.json');
    ipcMain.handle('trust:get', (_e, folder) => isTrusted(folder));
    ipcMain.handle('trust:set', (_e, folder, trusted) => setTrusted(folder, trusted));
    ipcMain.handle('trust:list', async () => (await load()).trusted);
  }
};
