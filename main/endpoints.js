// Nova IDE - Endpoints Explorer (like Visual Studio's): the HTTP endpoints of the ASP.NET Core projects in the folder,
// read from the source — minimal APIs (app.MapGet, MapGroup prefixes, MapMethods) and controllers
// ([Route] on the class + [HttpGet("...")] / [Route] on actions, [controller] / [action] tokens).
'use strict';

const fs = require('fs/promises');
const path = require('path');

const VERBS = ['Get', 'Post', 'Put', 'Delete', 'Patch'];
const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.nova']);
const strArg = (s) => { const m = String(s || '').match(/^\s*@?"((?:[^"\\]|\\.)*)"/); return m ? m[1] : null; };
function joinRoute(a, b) {
  if (b == null) return `/${(a || '').replace(/^\/+/, '')}`;
  const left = (a || '').replace(/\/+$/, '');
  const right = (b || '').replace(/^\/+/, '');
  const r = `${left}${right ? `/${right}` : ''}`;
  return r.startsWith('/') ? r : `/${r}`;
}
const stripComments = (line) => line.replace(/\/\/.*$/, (m) => (/"[^"]*\/\/[^"]*"/.test(line) ? m : ''));

function parseEndpoints(text, file = '') {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  // ---- minimal APIs ----
  const groups = new Map(); // variable -> prefix
  const prefixOf = (v) => (groups.has(v) ? groups.get(v) : '');
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    let m;
    const g = /(?:var|const|RouteGroupBuilder|[\w<>]+)?\s*(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*(@?"[^"]*")/.exec(line);
    if (g) groups.set(g[1], joinRoute(prefixOf(g[2]), strArg(g[3])));
    const re = /(\w+)\s*\.\s*Map(Get|Post|Put|Delete|Patch|Methods)\s*\(\s*(@?"(?:[^"\\]|\\.)*")(?:\s*,\s*new\s*(?:string)?\s*\[\s*\]\s*\{([^}]*)\})?/g;
    while ((m = re.exec(line))) {
      const route = joinRoute(prefixOf(m[1]), strArg(m[3]));
      const verbs = m[2] === 'Methods' ? (m[4] || '').match(/"(\w+)"/g)?.map((x) => x.replace(/"/g, '').toUpperCase()) || ['GET'] : [m[2].toUpperCase()];
      for (const v of verbs) out.push({ method: v, route, file, line: i + 1, kind: 'minimal' });
    }
  });
  // ---- controllers ----
  let attrs = [];
  let cls = null; // { name, route }
  for (let i = 0; i < lines.length; i++) {
    let line = stripComments(lines[i]).trim();
    if (!line) continue;
    // attributes, alone on the line or in front of the declaration ([HttpGet] public int Get())
    const lead = line.match(/^(\[(?!assembly:)(?:[^\]"]|"[^"]*")*\]\s*)+/);
    if (lead) {
      for (const a of lead[0].matchAll(/(\w+)(?:Attribute)?\s*(?:\(([^)]*)\))?\s*[,\]]/g)) attrs.push({ name: a[1], arg: a[2] || '', line: i + 1 });
      line = line.slice(lead[0].length).trim();
      if (!line) continue;
    }
    const c = line.match(/\bclass\s+(\w+)/);
    if (c) {
      const route = attrs.find((a) => a.name === 'Route');
      const isController = /Controller$/.test(c[1]) || attrs.some((a) => a.name === 'ApiController' || a.name === 'Controller');
      cls = isController ? { name: c[1], route: route ? strArg(route.arg) : null } : null;
      attrs = [];
      continue;
    }
    if (cls && attrs.length && /\w+\s*(<[^>]*>)?\s*\(/.test(line) && !/^(if|for|foreach|while|switch|return|using)\b/.test(line)) {
      const action = (line.match(/(\w+)\s*(?:<[^>]*>)?\s*\(/) || [])[1];
      const verbs = attrs.filter((a) => /^Http(Get|Post|Put|Delete|Patch)$/.test(a.name));
      const methodRoute = attrs.find((a) => a.name === 'Route');
      const ctl = cls.name.replace(/Controller$/, '');
      const tok = (r) => (r == null ? r : r.replace(/\[controller\]/gi, ctl).replace(/\[action\]/gi, action));
      const list = verbs.length ? verbs : methodRoute ? [{ name: 'HttpGet', arg: '', line: methodRoute.line, any: true }] : [];
      for (const v of list) {
        const own = strArg(v.arg) ?? strArg(methodRoute && methodRoute.arg);
        if (cls.route == null && own == null) continue; // conventional routing: not from attributes
        const route = own != null && /^~?\//.test(own) ? own.replace(/^~/, '') : joinRoute(tok(cls.route) || '', tok(own));
        out.push({ method: v.any ? 'ANY' : v.name.slice(4).toUpperCase(), route: tok(route), file, line: v.line, kind: 'controller', handler: `${cls.name}.${action}` });
      }
      attrs = [];
      continue;
    }
    if (!/^\[/.test(line)) attrs = [];
  }
  return out;
}

// the project a file belongs to: nearest folder with a .csproj
async function projectOf(file, root, cache) {
  let dir = path.dirname(file);
  while (dir.length >= root.length) {
    if (!cache.has(dir)) {
      let proj = null;
      try { proj = (await fs.readdir(dir)).find((n) => /\.csproj$/i.test(n)) || null; } catch {}
      cache.set(dir, proj ? path.join(dir, proj) : null);
    }
    if (cache.get(dir)) return cache.get(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
// the address the project listens on (launchSettings.json: first "Project" profile's first URL)
async function hostAddress(projFile) {
  try {
    const text = await fs.readFile(path.join(path.dirname(projFile), 'Properties', 'launchSettings.json'), 'utf8');
    // JSON with comments and trailing commas (a "//" inside a string, like an URL, is not a comment)
    const clean = text.replace(/^\uFEFF/, '').replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
    const json = JSON.parse(clean.replace(/,(\s*[}\]])/g, '$1'));
    const profiles = Object.values(json.profiles || {});
    const p = profiles.find((x) => x.commandName === 'Project' && x.applicationUrl) || profiles.find((x) => x.applicationUrl);
    if (p) return p.applicationUrl.split(';').map((u) => u.trim()).filter(Boolean).sort((a, b) => (a.startsWith('http:') ? -1 : 0) - (b.startsWith('http:') ? -1 : 0))[0];
  } catch {}
  return 'http://localhost:5000';
}

async function scan(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(full); } else if (/\.cs$/i.test(e.name)) files.push(full);
    }
  }
  await walk(root);
  const cache = new Map();
  const projects = new Map();
  for (const f of files) {
    let text;
    try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    if (!/\.Map(Get|Post|Put|Delete|Patch|Methods|Group)\s*\(|\[(Http(Get|Post|Put|Delete|Patch)|Route)\b/.test(text)) continue;
    const eps = parseEndpoints(text, f);
    if (!eps.length) continue;
    const proj = (await projectOf(f, root, cache)) || path.join(root, '(no project)');
    if (!projects.has(proj)) projects.set(proj, { project: proj, name: path.basename(proj).replace(/\.csproj$/i, ''), host: await hostAddress(proj), endpoints: [] });
    projects.get(proj).endpoints.push(...eps);
  }
  const list = [...projects.values()];
  for (const p of list) p.endpoints.sort((a, b) => a.route.toLowerCase().localeCompare(b.route.toLowerCase()) || VERBS.indexOf(a.method[0] + a.method.slice(1).toLowerCase()) - VERBS.indexOf(b.method[0] + b.method.slice(1).toLowerCase()));
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  parseEndpoints, scan,
  register({ ipcMain }) { ipcMain.handle('endpoints:scan', (_e, root) => scan(root)); }
};
