// Nova IDE - code coverage: read Cobertura XML (coverlet, Microsoft Code Coverage, coverage.py)
// and LCOV (c8, nyc, Jest, coverage.py), merge several reports and build the results tree.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const isAbs = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = (s) => { const o = {}; s.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_m, k, v) => { o[k] = unxml(v); }); return o; };

// ---------------- resolving file paths ----------------
// Reports name files relative to <source> folders, sometimes with deterministic paths (/_/src/...)
// that only match by their ending; those are looked up in the workspace.
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', '.vs', '.idea', 'dist', 'out', '__pycache__', '.venv', 'venv', 'TestResults']);
function workspaceIndex(root) {
  const byName = new Map();
  if (!root) return byName;
  let count = 0;
  (function walk(d, depth) {
    if (depth > 12 || count > 50000) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
      count++;
      const k = e.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(path.join(d, e.name));
    }
  })(root, 0);
  return byName;
}
function makeResolver(sources, root) {
  let index = null;
  const cache = new Map();
  return (file) => {
    if (!file) return file;
    if (cache.has(file)) return cache.get(file);
    const tries = [];
    if (isAbs(file)) tries.push(file);
    for (const s of sources) tries.push(isAbs(file) ? null : path.join(s, file));
    if (root && !isAbs(file)) tries.push(path.join(root, file));
    let found = tries.find((t) => t && fs.existsSync(t));
    if (!found) {
      // match on the longest common ending, e.g. /_/src/Calc/Calculator.cs -> <root>/src/Calc/Calculator.cs
      if (!index) index = workspaceIndex(root);
      const parts = file.split(/[\\/]+/).filter(Boolean);
      const cands = index.get((parts[parts.length - 1] || '').toLowerCase()) || [];
      let best = null, bestScore = 0;
      for (const c of cands) {
        const cp = c.split(/[\\/]+/);
        let n = 0;
        while (n < parts.length && n < cp.length && parts[parts.length - 1 - n].toLowerCase() === cp[cp.length - 1 - n].toLowerCase()) n++;
        if (n > bestScore) { best = c; bestScore = n; }
      }
      found = best || tries.find(Boolean) || file;
    }
    cache.set(file, found);
    return found;
  };
}

// ---------------- .NET names ----------------
// coverlet: "Calc.Calculator/<AddLaterAsync>d__5" (async/iterator state machine), "Calc.Calculator/<>c" (lambdas),
// "Outer/Inner" (nested class). Generated parts are folded into the method they came from.
function splitClass(name) {
  const segs = name.split('/');
  const real = [segs[0]];
  let fromMethod = null;
  for (const s of segs.slice(1)) {
    const m = /^<([^>]*)>/.exec(s);
    if (m) { if (m[1]) fromMethod = m[1]; } else real.push(s);
  }
  return { cls: real.join('.'), fromMethod };
}
function cleanMethod(name, fromMethod) {
  if ((name === 'MoveNext' || name === 'SetStateMachine') && fromMethod) return fromMethod;
  const m = /^<([^>]+)>[a-z]__/.exec(name); // <SumEven>b__6_0 (lambda), <Main>g__Local|0_0 (local function)
  if (m) return m[1];
  return name;
}

// ---------------- Cobertura ----------------
function parseCobertura(xml, { root } = {}) {
  const sources = [];
  xml.replace(/<source>([\s\S]*?)<\/source>/g, (_m, s) => { const t = unxml(s.trim()); if (t) sources.push(t); });
  const resolve = makeResolver(sources, root);
  const records = [];
  let pkg = '', cls = null, method = null, inMethods = false;
  let target = null; // lines map being filled
  const tagRe = /<(\/?)(package|class|methods|method|line)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const [, close, tag, rest, selfClose] = m;
    if (close) {
      if (tag === 'method') { method = null; target = null; } else if (tag === 'methods') inMethods = false;
      else if (tag === 'class') { if (cls && cls.classLines && Object.keys(cls.classLines).length) records.push({ ...cls.base, method: null, sig: '', lines: cls.classLines }); cls = null; target = null; }
      continue;
    }
    const a = attrs(rest);
    if (tag === 'package') pkg = a.name || '';
    else if (tag === 'class') {
      const { cls: name, fromMethod } = splitClass(a.name || a.filename || '');
      const file = resolve(a.filename || '');
      const isFileClass = a.filename && path.basename(a.filename) === a.name; // coverage.py: class = file
      cls = { base: { module: pkg && pkg !== '.' ? pkg : (root ? path.basename(root) : '(root)'), cls: name, ns: isFileClass ? '' : (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : ''), file, fileClass: !!isFileClass }, fromMethod, hasMethods: false, classLines: {} };
      target = cls.classLines;
    } else if (tag === 'methods' && !selfClose) inMethods = true;
    else if (tag === 'method' && cls) {
      cls.hasMethods = true;
      method = { ...cls.base, method: cleanMethod(a.name || '', cls.fromMethod), sig: a.signature || '', lines: {} };
      records.push(method);
      target = method.lines;
    } else if (tag === 'line' && cls) {
      // class-level <lines> repeat the method lines; only use them when the class has no methods
      if (!method && cls.hasMethods) continue;
      if (!method && inMethods) continue;
      const n = +a.number;
      if (!n) continue;
      const hits = +a.hits || 0;
      let bc = 0, bt = 0;
      const cc = /\((\d+)\/(\d+)\)/.exec(a['condition-coverage'] || '');
      if (cc) { bc = +cc[1]; bt = +cc[2]; }
      addLine(target, n, hits, bc, bt);
    }
  }
  // drop the class-level copies for classes that had methods
  return { format: 'cobertura', records: records.filter((r) => r.method !== null || !records.some((o) => o !== r && o.method !== null && o.file === r.file && o.cls === r.cls)) };
}

function addLine(map, n, hits, bc, bt) {
  const cur = map[n];
  if (!cur) map[n] = [hits, bc, bt];
  else { cur[0] += hits; cur[1] = Math.max(cur[1], bc); cur[2] = Math.max(cur[2], bt); }
}

// ---------------- LCOV ----------------
function parseLcov(text, { root } = {}) {
  const resolve = makeResolver([], root);
  const records = [];
  let file = null, fns = [], lines = {}, branches = {};
  const flush = () => {
    if (!file) return;
    for (const [n, b] of Object.entries(branches)) { const l = lines[n] || (lines[n] = [0, 0, 0]); l[1] = b.c; l[2] = b.t; }
    const rel = root && file.toLowerCase().startsWith(root.toLowerCase()) ? path.relative(root, file) : file;
    const base = { module: root ? path.basename(root) : 'Coverage', cls: rel.replace(/\\/g, '/'), ns: '', file, fileClass: true };
    fns.sort((a, b) => a.line - b.line);
    if (!fns.length) records.push({ ...base, method: null, sig: '', lines });
    else {
      // lines belong to the closest function that starts at or above them
      const per = fns.map((f) => ({ ...base, method: f.name, sig: '', line: f.line, lines: {} }));
      const top = { ...base, method: null, sig: '', lines: {} };
      for (const [n, l] of Object.entries(lines)) {
        let owner = null;
        for (const f of per) if (f.line <= +n) owner = f; else break;
        (owner || top).lines[n] = l;
      }
      records.push(...per);
      if (Object.keys(top.lines).length) records.push(top);
    }
    file = null; fns = []; lines = {}; branches = {};
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.indexOf(':');
    const key = i > 0 ? line.slice(0, i) : line;
    const val = i > 0 ? line.slice(i + 1) : '';
    if (key === 'SF') { flush(); file = resolve(val); }
    else if (key === 'FN') { const [ln, ...name] = val.split(','); fns.push({ line: +ln, name: name.join(',') }); }
    else if (key === 'DA') { const [ln, hits] = val.split(','); addLine(lines, +ln, +hits || 0, 0, 0); }
    else if (key === 'BRDA') {
      const [ln, , , taken] = val.split(',');
      const b = branches[ln] || (branches[ln] = { c: 0, t: 0 });
      b.t++; if (taken !== '-' && +taken > 0) b.c++;
    } else if (key === 'end_of_record') flush();
  }
  flush();
  return { format: 'lcov', records };
}

function parseAny(text, opts) {
  if (/<coverage[\s>]/.test(text)) return parseCobertura(text, opts);
  if (/^\s*(TN:|SF:)/m.test(text)) return parseLcov(text, opts);
  throw new Error('Not a coverage file Nova IDE can read. Supported: Cobertura XML (coverlet, Microsoft Code Coverage with Format=cobertura, coverage.py "coverage xml") and LCOV (c8, nyc, Jest, "coverage lcov").');
}

// ---------------- merging + results tree ----------------
// Several reports (one per test project) can cover the same code: hits add up, branches take the best.
function merge(recordLists) {
  const byKey = new Map();
  for (const r of recordLists.flat()) {
    const key = `${r.module}|${r.cls}|${r.method}|${r.sig}|${String(r.file).toLowerCase()}`;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { ...r, lines: Object.fromEntries(Object.entries(r.lines).map(([n, l]) => [n, l.slice()])) }); continue; }
    for (const [n, l] of Object.entries(r.lines)) addLine(cur.lines, n, l[0], l[1], l[2]);
  }
  return [...byKey.values()];
}

function metrics(lineMaps) {
  let covered = 0, total = 0, bc = 0, bt = 0;
  for (const lines of lineMaps) for (const l of Object.values(lines)) { total++; if (l[0] > 0) covered++; bc += l[1]; bt += l[2]; }
  return { covered, total, bc, bt };
}
const firstLine = (lines) => { const ns = Object.keys(lines).map(Number); return ns.length ? Math.min(...ns) : 0; };

function summarize(recordLists, info = {}) {
  const records = merge(recordLists);
  // per-file line map for the editor
  const files = {};
  for (const r of records) {
    if (!r.file) continue;
    const f = files[r.file] || (files[r.file] = {});
    for (const [n, l] of Object.entries(r.lines)) addLine(f, n, l[0], l[1], l[2]);
  }
  // module > namespace > class > method
  const modules = new Map();
  for (const r of records) {
    if (!modules.has(r.module)) modules.set(r.module, new Map());
    const nss = modules.get(r.module);
    if (!nss.has(r.ns)) nss.set(r.ns, new Map());
    const classes = nss.get(r.ns);
    const ckey = `${r.cls}|${r.file}`;
    if (!classes.has(ckey)) classes.set(ckey, { name: r.ns ? r.cls.slice(r.ns.length + 1) : r.cls, full: r.cls, file: r.file, recs: [] });
    classes.get(ckey).recs.push(r);
  }
  const node = (kind, name, maps, extra = {}) => ({ kind, name, ...metrics(maps), ...extra });
  const tree = [];
  for (const [mod, nss] of [...modules].sort((a, b) => a[0].localeCompare(b[0]))) {
    const modMaps = [];
    const nsNodes = [];
    for (const [ns, classes] of [...nss].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nsMaps = [];
      const clsNodes = [];
      for (const c of [...classes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        // methods with the same name (overloads keep their signature)
        const methods = new Map();
        for (const r of c.recs) {
          if (r.method == null) continue;
          const sameName = c.recs.filter((x) => x.method === r.method).length > 1;
          const label = sameName ? `${r.method}${shortSig(r.sig)}` : r.method;
          if (!methods.has(label)) methods.set(label, []);
          methods.get(label).push(r.lines);
        }
        const maps = c.recs.map((r) => r.lines);
        const children = [...methods].map(([label, ms]) => node('method', label, ms, { file: c.file, line: Math.min(...ms.map(firstLine).filter(Boolean)) || 0 })).sort((a, b) => a.line - b.line);
        clsNodes.push(node(c.recs[0].fileClass ? 'file' : 'class', c.name, maps, { full: c.full, file: c.file, line: Math.min(...maps.map(firstLine).filter(Boolean)) || 0, children }));
        nsMaps.push(...maps);
      }
      modMaps.push(...nsMaps);
      if (ns) nsNodes.push(node('namespace', ns, nsMaps, { children: clsNodes }));
      else nsNodes.push(...clsNodes);
    }
    tree.push(node('module', mod, modMaps, { children: nsNodes }));
  }
  const fileList = Object.entries(files).map(([file, lines]) => ({ file, lines: Object.entries(lines).map(([n, l]) => [+n, ...l]).sort((a, b) => a[0] - b[0]) }));
  return { totals: metrics(Object.values(files)), tree, files: fileList, info: { created: Date.now(), ...info } };
}
// "(System.Int32,System.String)" -> "(int, string)"
const ALIASES = { 'System.Int32': 'int', 'System.Int64': 'long', 'System.String': 'string', 'System.Boolean': 'bool', 'System.Double': 'double', 'System.Single': 'float', 'System.Object': 'object', 'System.Decimal': 'decimal', 'System.Byte': 'byte', 'System.Char': 'char', 'System.Void': 'void' };
function shortSig(sig) {
  if (!sig) return '';
  return sig.replace(/[\w.`]+/g, (t) => ALIASES[t] || t.split('.').pop().replace(/`\d+/, '')).replace(/,/g, ', ');
}

async function loadFile(file, root) {
  const text = await fsp.readFile(file, 'utf8');
  const parsed = parseAny(text, { root });
  return { ...summarize([parsed.records], { source: file, format: parsed.format }), records: parsed.records };
}

// all coverage reports under a folder (a test run's results directory)
async function findReports(dir) {
  const out = [];
  async function walk(d, depth) {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) await walk(p, depth + 1); } else if (/\.cobertura\.xml$/i.test(e.name) || /^coverage\.xml$/i.test(e.name) || /\.info$/i.test(e.name)) out.push(p);
    }
  }
  await walk(dir, 0);
  return out;
}

// which collector a test project can use
function collectorFor(projText) {
  if (/coverlet\.collector/i.test(projText || '')) return 'XPlat Code Coverage';
  return 'Code Coverage;Format=cobertura';
}

module.exports = {
  parseCobertura, parseLcov, parseAny, merge, summarize, shortSig, splitClass, cleanMethod, findReports, collectorFor, loadFile,
  register({ ipcMain }) {
    ipcMain.handle('coverage:load', async (_e, file, root) => { try { return await loadFile(file, root); } catch (e) { return { error: e.message }; } });
    ipcMain.handle('coverage:summarize', (_e, recordLists, info) => summarize(recordLists, info));
  }
};
