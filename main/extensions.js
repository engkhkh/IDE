// Nova IDE - extensions: folders in userData/extensions, each with a package.json and a script
// that runs in the IDE window and talks to the `nova` API (see renderer/extensions.js, EXTENSIONS.md).
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const settings = require('./settings');

let app, shell;
const extDir = () => path.join(app.getPath('userData'), 'extensions');
// sample extensions ship with the app (resources/samples when installed, ./samples when run from source)
const samplesDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'samples', 'extensions') : path.join(__dirname, '..', 'samples', 'extensions'));

async function readManifest(dir) {
  const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  const main = path.join(dir, pkg.main || 'extension.js');
  return {
    id: path.basename(dir), name: pkg.displayName || pkg.name || path.basename(dir), version: pkg.version || '0.0.0',
    description: pkg.description || '', author: typeof pkg.author === 'object' ? pkg.author.name : (pkg.author || ''),
    main, mainUrl: pathToFileURL(main).href, hasMain: fs.existsSync(main), dir
  };
}

async function list() {
  const s = await settings.read();
  const disabled = new Set(s.disabledExtensions || []);
  await fsp.mkdir(extDir(), { recursive: true });
  const out = [];
  for (const e of await fsp.readdir(extDir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(extDir(), e.name);
    try { out.push({ ...(await readManifest(dir)), enabled: !disabled.has(e.name) }); }
    catch (err) { out.push({ id: e.name, name: e.name, error: `Invalid extension: ${err.message}`, enabled: false, dir }); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function samples() {
  const dir = samplesDir();
  if (!fs.existsSync(dir)) return [];
  const installed = new Set((await list()).map((e) => e.id));
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try { out.push({ ...(await readManifest(path.join(dir, e.name))), installed: installed.has(e.name) }); } catch {}
  }
  return out;
}

async function install(src) {
  const pkgFile = path.join(src, 'package.json');
  if (!fs.existsSync(pkgFile)) return { ok: false, error: 'That folder has no package.json, so it is not a Nova IDE extension.' };
  const dest = path.join(extDir(), path.basename(src));
  await fsp.mkdir(extDir(), { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(src, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  return { ok: true, id: path.basename(src) };
}

module.exports = {
  register({ ipcMain, app: a }) {
    app = a;
    shell = require('electron').shell;
    ipcMain.handle('ext:list', () => list());
    ipcMain.handle('ext:samples', () => samples());
    ipcMain.handle('ext:installSample', (_e, id) => install(path.join(samplesDir(), path.basename(id))));
    ipcMain.handle('ext:installFolder', (_e, src) => install(src));
    ipcMain.handle('ext:uninstall', async (_e, id) => {
      const dir = path.join(extDir(), path.basename(id));
      try { await shell.trashItem(dir); } catch { await fsp.rm(dir, { recursive: true, force: true }); }
      return true;
    });
    ipcMain.handle('ext:setEnabled', async (_e, id, enabled) => {
      const s = await settings.read();
      const set = new Set(s.disabledExtensions || []);
      if (enabled) set.delete(id); else set.add(id);
      await settings.write({ ...s, disabledExtensions: [...set] });
      return true;
    });
    ipcMain.handle('ext:openFolder', async () => { await fsp.mkdir(extDir(), { recursive: true }); return shell.openPath(extDir()); });
    ipcMain.handle('ext:dir', () => extDir());
  }
};
