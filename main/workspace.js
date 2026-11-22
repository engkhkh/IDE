// Nova IDE - workspace services: file index for Quick Open + file system watcher
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// one file watcher per window
const watchers = new Map(); // window id -> { watcher, pending, timer }

async function listFiles(root, skip, limit = 20000) {
  const out = [];
  async function walk(dir) {
    if (out.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) await walk(full); }
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function watch(root, skip, send, owner = 0) {
  unwatch(owner);
  if (!root) return false;
  try {
    const w = { watcher: null, pending: new Set(), timer: null };
    // recursive watching is native on Windows and macOS (and Linux on Node 20+)
    w.watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const parts = String(name).split(/[\\/]/);
      if (parts.some((p) => skip.has(p))) return;
      w.pending.add(path.join(root, String(name)));
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        const paths = [...w.pending];
        w.pending = new Set();
        send('fs:changed', { root, paths });
      }, 250);
    });
    w.watcher.on('error', () => unwatch(owner));
    watchers.set(owner, w);
    return true;
  } catch (e) {
    console.warn('[watch] failed:', e.message);
    return false;
  }
}

function unwatch(owner = 0) {
  const w = watchers.get(owner);
  if (!w) return;
  watchers.delete(owner);
  try { w.watcher.close(); } catch {}
  clearTimeout(w.timer);
}

module.exports = {
  listFiles,
  register({ ipcMain, send, SKIP_DIRS }) {
    ipcMain.handle('ws:listFiles', (_e, root) => listFiles(root, SKIP_DIRS));
    ipcMain.handle('ws:watch', (e, root) => watch(root, SKIP_DIRS, send, e.sender.id));
    ipcMain.handle('ws:stat', async (_e, p) => {
      try { const s = await fsp.stat(p); return { exists: true, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }; }
      catch { return { exists: false }; }
    });
  },
  windowClosed: (id) => unwatch(id),
  dispose() { for (const id of [...watchers.keys()]) unwatch(id); }
};
