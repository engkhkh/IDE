// Nova IDE - color themes from VS Code extensions on Open VSX (open-vsx.org): search, download the .vsix,
// take its contributed themes (with "include" chains resolved) and keep them in the user data folder.
// The renderer turns them into editor themes and window colors.
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

let dir = null;
const vsxUrl = async () => ((await require('./settings').read()).openVsxUrl || 'https://open-vsx.org').replace(/\/$/, '');

// ---- a small zip reader (a .vsix is a zip): central directory -> entries, stored or deflated ----
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip / .vsix file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    files.set(name, () => { const data = buf.slice(lh, lh + csize); return method === 8 ? zlib.inflateRawSync(data) : data; });
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
// JSON with comments / trailing commas (VS Code theme files)
function parseJsonc(text) {
  const clean = String(text).replace(/^﻿/, '').replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
  return JSON.parse(clean.replace(/,(\s*[}\]])/g, '$1'));
}
// a theme file and the ones it includes: colors / tokenColors merged, the including file winning
function loadTheme(files, file, depth = 0) {
  const get = files.get(file);
  if (!get || depth > 5) return { colors: {}, tokenColors: [] };
  const t = parseJsonc(get().toString('utf8'));
  const base = t.include ? loadTheme(files, path.posix.join(path.posix.dirname(file), t.include), depth + 1) : { colors: {}, tokenColors: [] };
  const own = Array.isArray(t.tokenColors) ? t.tokenColors : [];
  return { name: t.name, type: t.type || base.type, colors: { ...base.colors, ...(t.colors || {}) }, tokenColors: [...base.tokenColors, ...own], semanticTokenColors: t.semanticTokenColors };
}
// a .vsix buffer -> [{ id, label, uiTheme, theme }]
function themesFromVsix(buf, extId) {
  const files = unzip(buf);
  const pkg = JSON.parse(files.get('extension/package.json')().toString('utf8'));
  const list = (pkg.contributes && pkg.contributes.themes) || [];
  if (!list.length) throw new Error(`${extId} contributes no color themes`);
  return list.map((t) => {
    const file = path.posix.normalize(path.posix.join('extension', t.path));
    const theme = loadTheme(files, file);
    const dark = t.uiTheme !== 'vs' && t.uiTheme !== 'hc-light';
    return { id: `${extId}/${t.id || t.label}`, label: t.label || theme.name || t.id, extension: extId, uiTheme: t.uiTheme || 'vs-dark', dark, theme };
  });
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${url}`);
  return r.json();
}
async function search(query) {
  const base = await vsxUrl();
  const j = await getJson(`${base}/api/-/search?category=Themes&size=30&sortBy=downloadCount&sortOrder=desc&query=${encodeURIComponent(query || '')}`);
  return (j.extensions || []).map((e) => ({ id: `${e.namespace}.${e.name}`, namespace: e.namespace, name: e.name, displayName: e.displayName || e.name, description: e.description || '', version: e.version, downloads: e.downloadCount || 0 }));
}
async function install(namespace, name) {
  const base = await vsxUrl();
  const meta = await getJson(`${base}/api/${namespace}/${name}`);
  const url = meta.files && meta.files.download;
  if (!url) throw new Error(`${namespace}.${name} has no download`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} downloading ${url}`);
  const themes = themesFromVsix(Buffer.from(await r.arrayBuffer()), `${namespace}.${name}`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${namespace}.${name}.json`), JSON.stringify({ extension: `${namespace}.${name}`, version: meta.version, displayName: meta.displayName || name, themes }));
  return themes.map(({ id, label, dark }) => ({ id, label, dark }));
}
async function list() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try { const j = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); for (const t of j.themes) out.push({ ...t, extensionName: j.displayName }); } catch {}
  }
  return out;
}

module.exports = {
  unzip, parseJsonc, themesFromVsix,
  register({ ipcMain, app }) {
    dir = path.join(app.getPath('userData'), 'themes');
    const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { error: e.message }; } };
    ipcMain.handle('themes:search', wrap((_e, q) => search(q)));
    ipcMain.handle('themes:install', wrap((_e, ns, name) => install(ns, name)));
    ipcMain.handle('themes:list', () => list());
    ipcMain.handle('themes:remove', wrap(async (_e, extId) => { await fsp.rm(path.join(dir, `${path.basename(extId)}.json`), { force: true }); return true; }));
  }
};
