// Nova IDE - solutions (.sln / .slnx), project files (.csproj/.fsproj/.vbproj), dotnet templates and NuGet (main process)
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { exec } = require('child_process');
const settings = require('./settings');

const FOLDER_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';
const toLocal = (rel) => rel.replace(/[\\/]+/g, path.sep);
const xmlUnescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function langOf(file) {
  const e = path.extname(file).toLowerCase();
  return { '.csproj': 'csharp', '.fsproj': 'fsharp', '.vbproj': 'vb', '.sqlproj': 'sql', '.esproj': 'javascript', '.pyproj': 'python', '.njsproj': 'javascript' }[e] || 'other';
}

// ---------------- .sln (classic text format) ----------------
function parseSln(text, slnPath) {
  const dir = path.dirname(slnPath);
  const items = [];
  const re = /^Project\("\{([0-9A-F-]+)\}"\)\s*=\s*"([^"]*)",\s*"([^"]*)",\s*"\{([0-9A-F-]+)\}"/gim;
  let m;
  while ((m = re.exec(text))) {
    const [, typeGuid, name, rel, guid] = m;
    if (typeGuid.toUpperCase() === FOLDER_GUID) items.push({ type: 'folder', name, id: guid.toUpperCase(), parent: null });
    else items.push({ type: 'project', name, id: guid.toUpperCase(), parent: null, path: path.resolve(dir, toLocal(rel)), lang: langOf(rel) });
  }
  const nested = /GlobalSection\(NestedProjects\)[^\n]*\n([\s\S]*?)EndGlobalSection/i.exec(text);
  if (nested) {
    for (const line of nested[1].split(/\r?\n/)) {
      const n = /\{([0-9A-F-]+)\}\s*=\s*\{([0-9A-F-]+)\}/i.exec(line);
      if (!n) continue;
      const child = items.find((i) => i.id === n[1].toUpperCase());
      if (child) child.parent = n[2].toUpperCase();
    }
  }
  const configs = [];
  const cfg = /GlobalSection\(SolutionConfigurationPlatforms\)[^\n]*\n([\s\S]*?)EndGlobalSection/i.exec(text);
  if (cfg) for (const line of cfg[1].split(/\r?\n/)) { const c = /^\s*([^=|]+)\|/.exec(line); if (c && !configs.includes(c[1].trim())) configs.push(c[1].trim()); }
  return { items, configurations: configs.length ? configs : ['Debug', 'Release'] };
}

// ---------------- .slnx (XML format, .NET 9+) ----------------
function parseSlnx(text, slnPath) {
  const dir = path.dirname(slnPath);
  const items = [];
  const stack = []; // open <Folder> ids
  const configs = [];
  const tagRe = /<(\/?)(Folder|Project|BuildType)\b([^>]*?)(\/?)>/gi;
  const attr = (s, n) => { const a = new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i').exec(s); return a ? xmlUnescape(a[1]) : null; };
  let m;
  while ((m = tagRe.exec(text))) {
    const [, closing, tag, attrs, selfClosing] = m;
    const t = tag.toLowerCase();
    if (t === 'buildtype') { const n = attr(attrs, 'Name'); if (n && !configs.includes(n)) configs.push(n); continue; }
    if (closing) { if (t === 'folder') stack.pop(); continue; }
    if (t === 'folder') {
      const full = attr(attrs, 'Name') || '/';
      const name = full.split('/').filter(Boolean).pop() || full;
      // a folder's parent is the folder whose name is its path prefix ("/src/" contains "/src/tests/")
      const parentPath = `/${full.split('/').filter(Boolean).slice(0, -1).join('/')}/`.replace('//', '/');
      const parent = items.find((i) => i.type === 'folder' && i.id === parentPath.toUpperCase());
      items.push({ type: 'folder', name, id: full.toUpperCase(), parent: parent ? parent.id : (stack.length ? stack[stack.length - 1] : null) });
      if (!selfClosing) stack.push(full.toUpperCase());
    } else if (t === 'project') {
      const rel = attr(attrs, 'Path');
      if (!rel) continue;
      const p = path.resolve(dir, toLocal(rel));
      items.push({ type: 'project', name: path.basename(p).replace(/\.\w+$/, ''), id: rel.toUpperCase(), parent: stack.length ? stack[stack.length - 1] : null, path: p, lang: langOf(rel) });
    }
  }
  return { items, configurations: configs.length ? configs : ['Debug', 'Release'] };
}

// ---------------- project files ----------------
function parseProject(text, projPath) {
  const tag = (n) => { const m = new RegExp(`<${n}>([^<]*)</${n}>`, 'i').exec(text); return m ? m[1].trim() : ''; };
  const sdkM = /<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(text);
  const sdk = sdkM ? sdkM[1] : '';
  const frameworks = (tag('TargetFrameworks') || tag('TargetFramework')).split(';').map((s) => s.trim()).filter(Boolean);
  const outputType = tag('OutputType') || (/Microsoft\.NET\.Sdk\.(Web|Worker)/i.test(sdk) ? 'Exe' : 'Library');
  const packages = [];
  const pkgRe = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let m;
  while ((m = pkgRe.exec(text))) {
    const id = /\bInclude\s*=\s*"([^"]+)"/i.exec(m[1]);
    if (!id) continue;
    const vAttr = /\bVersion\s*=\s*"([^"]+)"/i.exec(m[1]);
    const vEl = m[2] && /<Version>([^<]+)<\/Version>/i.exec(m[2]);
    packages.push({ id: id[1], version: vAttr ? vAttr[1] : vEl ? vEl[1].trim() : '' });
  }
  const refs = [];
  const refRe = /<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi;
  while ((m = refRe.exec(text))) refs.push(path.resolve(path.dirname(projPath), toLocal(m[1])));
  const isTest = /<IsTestProject>\s*true/i.test(text) || packages.some((p) => /^Microsoft\.NET\.Test\.Sdk$/i.test(p.id));
  const kind = isTest ? 'test'
    : /Sdk\.Web/i.test(sdk) ? 'web'
    : /<UseWPF>\s*true/i.test(text) ? 'wpf'
    : /<UseWindowsForms>\s*true/i.test(text) ? 'winforms'
    : /<UseMaui>\s*true/i.test(text) ? 'maui'
    : /Sdk\.Worker/i.test(sdk) ? 'worker'
    : /^(Exe|WinExe)$/i.test(outputType) ? 'console' : 'library';
  return {
    path: projPath, name: tag('AssemblyName') || path.basename(projPath).replace(/\.\w+$/, ''),
    rootNamespace: tag('RootNamespace') || path.basename(projPath).replace(/\.\w+$/, '').replace(/[^\w.]/g, '_'),
    sdk, frameworks, outputType, kind, packages, references: refs, lang: langOf(projPath),
    runnable: /^(Exe|WinExe)$/i.test(outputType) && !isTest
  };
}

async function projectInfo(projPath) {
  try { return parseProject(await fsp.readFile(projPath, 'utf8'), projPath); }
  catch (e) { return { path: projPath, name: path.basename(projPath).replace(/\.\w+$/, ''), error: `Project file not found or unreadable (${e.code || e.message})`, frameworks: [], packages: [], references: [], kind: 'missing', lang: langOf(projPath), runnable: false }; }
}

async function loadSolution(slnPath) {
  const text = await fsp.readFile(slnPath, 'utf8');
  const format = /\.slnx$/i.test(slnPath) ? 'slnx' : 'sln';
  const parsed = format === 'slnx' ? parseSlnx(text, slnPath) : parseSln(text, slnPath);
  for (const it of parsed.items) if (it.type === 'project') it.info = await projectInfo(it.path);
  return { path: slnPath, name: path.basename(slnPath).replace(/\.slnx?$/i, ''), format, ...parsed };
}

async function findSolutions(root) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && /\.slnx?$/i.test(e.name)) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth > 0 && !/^(node_modules|bin|obj|\.git|\.vs)$/i.test(e.name)) await walk(path.join(dir, e.name), depth - 1);
    }
  }
  await walk(root, 1);
  // solutions in the folder itself first, then by name
  return out.sort((a, b) => (path.dirname(a) === root ? 0 : 1) - (path.dirname(b) === root ? 0 : 1) || a.localeCompare(b));
}

// ---------------- dotnet CLI helpers ----------------
function run(cmd, cwd) {
  return new Promise((resolve) => exec(cmd, { cwd, windowsHide: true, timeout: 600000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_UI_LANGUAGE: 'en' } },
    (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !stdout ? err.message : '') })));
}

let sdkCache = null;
async function sdks() {
  if (sdkCache) return sdkCache;
  const r = await run('dotnet --list-sdks');
  if (!r.ok) return { installed: false, versions: [], frameworks: [] };
  const versions = r.stdout.split(/\r?\n/).map((l) => (/^(\d+\.\d+\.\d+\S*)/.exec(l.trim()) || [])[1]).filter(Boolean);
  const majors = [...new Set(versions.map((v) => +v.split('.')[0]))].filter((n) => n >= 6).sort((a, b) => b - a);
  sdkCache = { installed: true, versions, frameworks: majors.map((n) => `net${n}.0`) };
  return sdkCache;
}

let templateCache = null;
async function templates() {
  if (templateCache) return templateCache;
  const r = await run('dotnet new list');
  // the table's "Short Name" column; several names can share a row ("webapp,razor")
  const names = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 3 && !/^-+$/.test(cols[1])) for (const n of cols[1].split(',')) names.add(n.trim().toLowerCase());
  }
  templateCache = { ok: r.ok, names: [...names] };
  return templateCache;
}

// ---------------- NuGet (v3 protocol) ----------------
const feedCache = new Map();
async function fetchJson(url) {
  const { net } = require('electron');
  const res = await net.fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
async function feed() {
  const s = await settings.read();
  const source = s.nugetSource || 'https://api.nuget.org/v3/index.json';
  if (feedCache.has(source)) return feedCache.get(source);
  const index = await fetchJson(source);
  const find = (type) => { const r = (index.resources || []).find((x) => String(x['@type']).startsWith(type)); return r ? r['@id'] : null; };
  const f = { source, search: find('SearchQueryService'), flat: find('PackageBaseAddress') };
  if (!f.search || !f.flat) throw new Error('This NuGet source does not support search');
  feedCache.set(source, f);
  return f;
}
async function nugetSearch(query, prerelease, skip = 0) {
  const f = await feed();
  const url = `${f.search}?q=${encodeURIComponent(query || '')}&skip=${skip}&take=25&prerelease=${!!prerelease}&semVerLevel=2.0.0`;
  const r = await fetchJson(url);
  return (r.data || []).map((p) => ({
    id: p.id, version: p.version, description: p.description || p.summary || '', authors: [].concat(p.authors || []).join(', '),
    downloads: p.totalDownloads || 0, verified: !!p.verified, iconUrl: p.iconUrl || '', projectUrl: p.projectUrl || '',
    versions: (p.versions || []).map((v) => v.version).reverse()
  }));
}
async function nugetVersions(id) {
  const f = await feed();
  const r = await fetchJson(`${f.flat}${id.toLowerCase()}/index.json`);
  return (r.versions || []).slice().reverse(); // newest first
}

// newest stable version (or newest prerelease if allowed)
function newest(versions, prerelease) {
  const list = prerelease ? versions : versions.filter((v) => !v.includes('-'));
  return list.slice().sort(compareVersions).pop() || null;
}
function compareVersions(a, b) {
  const [pa, ra] = a.split('-'); const [pb, rb] = b.split('-');
  const na = pa.split('.').map(Number); const nb = pb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) { const d = (na[i] || 0) - (nb[i] || 0); if (d) return d; }
  if (ra && !rb) return -1; if (!ra && rb) return 1;
  return (ra || '').localeCompare(rb || '');
}

const q = (p) => `"${p}"`;
module.exports = {
  parseSln, parseSlnx, parseProject, compareVersions, newest,
  register({ ipcMain }) {
    ipcMain.handle('sln:find', (_e, root) => findSolutions(root));
    ipcMain.handle('sln:load', async (_e, p) => { try { return await loadSolution(p); } catch (e) { return { error: e.message }; } });
    ipcMain.handle('proj:info', (_e, p) => projectInfo(p));
    ipcMain.handle('dotnet:sdks', () => sdks());
    ipcMain.handle('dotnet:templates', () => templates());
    ipcMain.handle('dotnet:run', (_e, cmd, cwd) => run(cmd, cwd));
    ipcMain.handle('sln:addProject', (_e, sln, proj, folder) => run(`dotnet sln ${q(sln)} add ${q(proj)}${folder ? ` --solution-folder ${q(folder)}` : ''}`, path.dirname(sln)));
    ipcMain.handle('sln:removeProject', (_e, sln, proj) => run(`dotnet sln ${q(sln)} remove ${q(proj)}`, path.dirname(sln)));
    ipcMain.handle('proj:addRef', (_e, proj, target) => run(`dotnet add ${q(proj)} reference ${q(target)}`, path.dirname(proj)));
    ipcMain.handle('proj:removeRef', (_e, proj, target) => run(`dotnet remove ${q(proj)} reference ${q(target)}`, path.dirname(proj)));
    ipcMain.handle('nuget:search', async (_e, query, pre, skip) => { try { return { items: await nugetSearch(query, pre, skip) }; } catch (e) { return { error: e.message }; } });
    ipcMain.handle('nuget:versions', async (_e, id) => { try { return { versions: await nugetVersions(id) }; } catch (e) { return { error: e.message }; } });
    ipcMain.handle('nuget:latest', async (_e, ids, pre) => {
      const out = {};
      await Promise.all(ids.map(async (id) => { try { out[id] = newest(await nugetVersions(id), pre); } catch { out[id] = null; } }));
      return out;
    });
    ipcMain.handle('nuget:install', (_e, proj, id, version) => run(`dotnet add ${q(proj)} package ${id}${version ? ` --version ${version}` : ''}`, path.dirname(proj)));
    ipcMain.handle('nuget:uninstall', (_e, proj, id) => run(`dotnet remove ${q(proj)} package ${id}`, path.dirname(proj)));
    ipcMain.handle('nuget:resetFeed', () => { feedCache.clear(); return true; });
    ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
    // Visual Studio's default location for new projects
    ipcMain.handle('app:projectsDir', () => path.join(require('os').homedir(), 'source', 'repos'));
    ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) require('electron').shell.openExternal(url); });
  }
};
