// Nova IDE - Performance Profiler: CPU usage by function and memory allocations
//   .NET   - EventPipe (main/eventpipe.js): CPU samples + allocation ticks, no extra tools
//   Node   - V8 --cpu-prof / --heap-prof (through NODE_OPTIONS, so npm start works too)
//   Python - cProfile, started from a sitecustomize.py on PYTHONPATH
// The renderer runs the program itself (Output window, Stop); this service prepares the environment and
// turns what was collected into one report format: functions + call stacks (or call edges) + allocation rows.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const ep = require('./eventpipe');
const diag = require('./diagnostics');
const heapgraph = require('./heapgraph');

const sessions = new Map();
let seq = 0;

// ---------------- Node ----------------
const NODE_HOOK = `// written by Nova IDE: lets V8 write its profiles when the program is stopped,
// and samples allocations (all of them, also objects already freed) when NOVA_HEAP_DIR is set
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) { try { process.on(s, () => process.exit(128 + (s === 'SIGINT' ? 2 : s === 'SIGHUP' ? 1 : 15))); } catch {} }
if (process.env.NOVA_HEAP_DIR) {
  try {
    const inspector = require('inspector');
    const session = new inspector.Session();
    session.connect();
    session.post('HeapProfiler.enable');
    session.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    process.on('exit', () => {
      session.post('HeapProfiler.stopSampling', (err, r) => {
        if (!err) require('fs').writeFileSync(require('path').join(process.env.NOVA_HEAP_DIR, 'heap-' + process.pid + '.heapprofile'), JSON.stringify(r.profile));
      });
    });
  } catch {}
}
`;
const q = (s) => `"${s.replace(/"/g, '\\"')}"`;

function nodeFrameInfo(cf) {
  let file = '';
  const url = cf.url || '';
  const user = url.startsWith('file:') || path.isAbsolute(url);
  if (url.startsWith('file:')) { try { file = fileURLToPath(url); } catch { file = url; } } else file = url;
  const raw = cf.functionName;
  const special = { '(program)': '[Native code / VM]', '(garbage collector)': '[Garbage collection]', '(root)': '[root]', '(idle)': '[idle]' }[raw];
  const name = special || `${raw || '(anonymous)'}${file ? ` (${path.basename(file)}:${cf.lineNumber + 1})` : ''}`;
  const framework = !!special || !user || /[\\/]node_modules[\\/]/.test(file);
  return { key: `${raw}|${file}|${cf.lineNumber}|${cf.columnNumber}`, info: { name, file: user ? file : '', line: cf.lineNumber + 1, module: file ? path.basename(file) : '', framework, special: !!special } };
}

// .cpuprofile -> functions + root-first stacks weighted in ms; + ms per source line
function fromCpuProfile(prof) {
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const n = prof.samples ? prof.samples.length : 0;
  const durMs = (prof.endTime - prof.startTime) / 1000;
  const per = n ? durMs / n : 0;
  // time per node: the delta to the next sample belongs to this sample
  const selfMs = new Map();
  if (prof.timeDeltas && n) {
    for (let i = 0; i < n; i++) {
      const dt = (i + 1 < n ? prof.timeDeltas[i + 1] : per * 1000) / 1000;
      selfMs.set(prof.samples[i], (selfMs.get(prof.samples[i]) || 0) + Math.max(0, dt));
    }
  } else for (const x of prof.nodes) selfMs.set(x.id, (x.hitCount || 0) * per);
  const index = new Map();
  const functions = [];
  const fnOf = (cf) => { const { key, info } = nodeFrameInfo(cf); let i = index.get(key); if (i == null) { i = functions.length; index.set(key, i); functions.push(info); } return i; };
  const stacks = [];
  const lines = {};
  for (const x of prof.nodes) {
    const w = selfMs.get(x.id) || 0;
    if (x.callFrame.functionName === '(idle)' || x.callFrame.functionName === '(root)') continue;
    if (w > 0) {
      const frames = [];
      for (let id = x.id; id != null; id = parent.get(id)) { const nn = nodes.get(id); if (nn.callFrame.functionName !== '(root)') frames.push(fnOf(nn.callFrame)); }
      frames.reverse();
      stacks.push({ frames, w });
    }
    // hot lines: ticks per line of this function
    if (x.positionTicks && x.positionTicks.length && functions[fnOf(x.callFrame)].file) {
      const f = functions[fnOf(x.callFrame)].file;
      const total = x.positionTicks.reduce((a, t) => a + t.ticks, 0) || 1;
      for (const t of x.positionTicks) { (lines[f] = lines[f] || {})[t.line] = ((lines[f] || {})[t.line] || 0) + (w * t.ticks) / total; }
    }
  }
  return { functions, stacks, lines, durationMs: durMs };
}

// merge several profiles (npm start runs node twice: npm itself and the program)
function mergeProfiles(list) {
  const functions = [], index = new Map(), stacks = [], lines = {};
  let durationMs = 0;
  for (const r of list) {
    const map = r.functions.map((f) => { const k = `${f.name}|${f.file}|${f.line}`; let i = index.get(k); if (i == null) { i = functions.length; index.set(k, i); functions.push(f); } return i; });
    for (const s of r.stacks) stacks.push({ frames: s.frames.map((x) => map[x]), w: s.w });
    for (const [f, ls] of Object.entries(r.lines)) for (const [l, ms] of Object.entries(ls)) { (lines[f] = lines[f] || {})[l] = (lines[f][l] || 0) + ms; }
    durationMs = Math.max(durationMs, r.durationMs);
  }
  return { functions, stacks, lines, durationMs };
}
const isNpmProfile = (r) => r.functions.some((f) => /[\\/]npm[\\/](bin|lib)[\\/]|npm-cli\.js/.test(f.file));

// .heapprofile (sampling heap profiler, memory still in use at exit) -> rows by allocating function
function fromHeapProfile(prof) {
  const rows = new Map();
  const walk = (n) => {
    if (n.selfSize > 0) {
      const { key, info } = nodeFrameInfo(n.callFrame);
      const r = rows.get(key) || { ...info, bytes: 0, count: null, samples: 0 };
      r.bytes += n.selfSize;
      rows.set(key, r);
    }
    for (const c of n.children || []) walk(c);
  };
  walk(prof.head);
  const byNode = new Map();
  const nodeKey = new Map();
  const index = (n) => { nodeKey.set(n.id, nodeFrameInfo(n.callFrame).key); (n.children || []).forEach(index); };
  index(prof.head);
  for (const smp of prof.samples || []) { const k = nodeKey.get(smp.nodeId); byNode.set(k, (byNode.get(k) || 0) + 1); }
  for (const [k, r] of rows) r.samples = byNode.get(k) || 0;
  return [...rows.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---------------- Python ----------------
const PY_HOOK = `# written by Nova IDE: profiles the program with cProfile and saves the result at exit
import os, sys
_out = os.environ.get('NOVA_PROF_OUT')
if _out and not os.environ.get('NOVA_PROF_STARTED'):
    os.environ['NOVA_PROF_STARTED'] = '1'
    import atexit, cProfile, json, pstats, signal
    _p = cProfile.Profile()
    def _save():
        try:
            _p.disable()
            st = pstats.Stats(_p).stats
            keys = list(st.keys())
            idx = {k: i for i, k in enumerate(keys)}
            fns = []
            for k in keys:
                cc, nc, tt, ct, callers = st[k]
                fns.append({'file': k[0], 'line': k[1], 'name': k[2], 'calls': nc, 'self': tt * 1000, 'total': ct * 1000,
                            'callers': [[idx[c], v[1], v[3] * 1000] for c, v in callers.items() if c in idx]})
            with open(_out, 'w') as f:
                json.dump({'functions': fns, 'prefix': [sys.prefix, sys.base_prefix], 'hook': __file__}, f)
        except Exception as e:
            sys.stderr.write('Nova profiler: %s\\n' % e)
    atexit.register(_save)
    try:
        signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
    except Exception:
        pass
    _p.enable()
`;
function fromPython(data) {
  const prefixes = (data.prefix || []).filter(Boolean).map((p) => path.resolve(p));
  const hook = data.hook ? path.resolve(data.hook) : '';
  const keep = [];
  const map = new Map();
  data.functions.forEach((f, i) => {
    if (f.file && path.resolve(f.file) === hook) return;
    if (/^(<built-in method builtins\.exec>|<method 'disable' of '_lsprof\.Profiler' objects>)$/.test(f.name)) return;
    map.set(i, keep.length);
    const builtin = f.file === '~' || f.file.startsWith('<');
    const framework = builtin || prefixes.some((p) => path.resolve(f.file).startsWith(p + path.sep)) || /[\\/]site-packages[\\/]/.test(f.file);
    keep.push({
      name: builtin ? f.name : `${f.name} (${path.basename(f.file)}:${f.line})`, file: builtin ? '' : f.file, line: f.line, module: builtin ? 'built-in' : path.basename(f.file),
      framework, self: f.self, total: f.total, calls: f.calls, _callers: f.callers
    });
  });
  const edges = [];
  for (const f of keep) { const to = keep.indexOf(f); for (const [c, , ct] of f._callers) if (map.has(c)) edges.push([map.get(c), to, ct]); delete f._callers; }
  return { functions: keep, edges };
}

// ---------------- .NET helpers ----------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 16 << 20, timeout: 120000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
}
async function dotnetTargetPath(project, config) {
  const r = await run('dotnet', ['msbuild', project, '-nologo', '-getProperty:TargetPath', `-p:Configuration=${config || 'Debug'}`], { cwd: path.dirname(project), env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en' } });
  const out = r.stdout.trim().split(/\r?\n/).pop();
  return r.code === 0 && out && /\.(dll|exe)$/i.test(out) ? out : null;
}

// Find where a .NET method is defined in the folder's .cs files (no PDB reading): best effort by name
async function findMethod(root, ns, method, skip) {
  if (!root || !method) return null;
  const typeName = (ns || '').split(/[.+]/).pop().replace(/`\d+$/, '');
  let name = method;
  let ctor = false;
  const local = method.match(/^<[^>]*>g__([A-Za-z_]\w*)\|/);
  if (local) name = local[1];
  else if (/^<Main>\$$/.test(method)) name = null; // top-level statements
  else if (/^<(\w+)>/.test(method)) name = method.match(/^<(\w+)>/)[1]; // lambda / async state machine: the method
  else if (method === '.ctor' || method === '.cctor') { ctor = true; name = typeName; }
  const files = [];
  const walk = async (d, depth) => {
    if (depth > 8 || files.length > 3000) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!(skip && skip.has(e.name)) && !['bin', 'obj', '.git', 'node_modules'].includes(e.name)) await walk(path.join(d, e.name), depth + 1); } else if (/\.cs$/i.test(e.name)) files.push(path.join(d, e.name));
    }
  };
  await walk(root, 0);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = name && new RegExp(ctor ? `^\\s*(?:(?:public|private|protected|internal|static)\\s+)*(?:record\\s+(?:class\\s+|struct\\s+)?|class\\s+|struct\\s+)?${esc(name)}\\s*\\(` : `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|extern|unsafe|new|partial|readonly)\\s+)*[\\w<>\\[\\],.?()\\s]+?\\s+${esc(name)}\\s*(?:<[^>]*>)?\\s*\\(`);
  const typeRe = typeName && new RegExp(`\\b(?:class|record|struct|interface)\\s+${esc(typeName)}\\b`);
  let best = null;
  for (const f of files) {
    let text;
    try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
    const ls = text.split(/\r?\n/);
    if (!name) {
      // top-level statements: a file whose first code line is a statement, not a namespace or type
      const i = ls.findIndex((l) => l.trim() && !/^\s*(using\b|\/\/|#|\/\*|\*)/.test(l));
      if (i >= 0 && !/^\s*(namespace|public|internal|private|protected|static|sealed|abstract|partial|class|record|struct|interface|enum|\[)/.test(ls[i])) {
        const hit = { file: f, line: i + 1, score: /^program\.cs$/i.test(path.basename(f)) ? 2 : 1 };
        if (!best || hit.score > best.score) best = hit;
        if (hit.score === 2) break;
      }
      continue;
    }
    const hasType = typeRe ? typeRe.test(text) : true;
    for (let i = 0; i < ls.length; i++) {
      if (defRe.test(ls[i]) && !/^\s*(?:return|else|if|while|for|foreach|switch|using|catch|new)\b/.test(ls[i]) && !/=\s*new\b/.test(ls[i].split('(')[0])) {
        const score = hasType ? 2 : 1;
        if (!best || score > best.score) best = { file: f, line: i + 1, score };
        if (hasType) break;
      }
    }
    if (best && best.score === 2) break;
  }
  return best ? { file: best.file, line: best.line } : null;
}

// ---------------- sessions ----------------
async function prepare(o, owner) {
  const id = `prof${++seq}`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-prof-'));
  const s = { id, owner, lang: o.lang, cpu: o.cpu !== false, alloc: !!o.alloc, dir, started: Date.now(), root: o.root };
  sessions.set(id, s);
  const out = { id, env: {}, command: null };
  if (o.lang === 'node') {
    const hook = path.join(dir, 'nova-hook.js');
    await fsp.writeFile(hook, NODE_HOOK);
    const opts = [`--require ${q(hook)}`];
    if (s.cpu) opts.push('--cpu-prof', `--cpu-prof-dir=${q(dir)}`);
    if (s.alloc) out.env.NOVA_HEAP_DIR = dir;
    out.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, ...opts].filter(Boolean).join(' ');
  } else if (o.lang === 'python') {
    await fsp.writeFile(path.join(dir, 'sitecustomize.py'), PY_HOOK);
    out.env.PYTHONPATH = [dir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    out.env.NOVA_PROF_OUT = path.join(dir, 'py.json');
    s.alloc = false;
  } else if (o.lang === 'dotnet') {
    const target = await dotnetTargetPath(o.project, o.config);
    if (!target) { sessions.delete(id); return { error: `Could not find the program that ${path.basename(o.project)} builds. Build it first (Ctrl+Shift+B).` }; }
    s.trace = new ep.DotnetTrace({ cpu: s.cpu, alloc: s.alloc });
    Object.assign(out.env, await s.trace.start());
    out.command = /\.exe$/i.test(target) && process.platform === 'win32' ? q(target) : `dotnet ${q(target)}`;
    out.target = target;
  } else { sessions.delete(id); return { error: `Profiling ${o.lang || 'this'} programs by function isn't supported.` }; }
  return out;
}

// Called just before the renderer stops a profiled program: .NET is asked to end the trace first
async function beforeStop(id) {
  const s = sessions.get(id);
  if (s && s.trace) { await s.trace.stop(); await new Promise((r) => setTimeout(r, 400)); }
  return true;
}

async function finish(id) {
  const s = sessions.get(id);
  if (!s) return { error: 'No such profiling session' };
  sessions.delete(id);
  const report = { lang: s.lang, cpu: null, alloc: null, notes: [], durationMs: Date.now() - s.started };
  try {
    if (s.lang === 'node') {
      const files = await fsp.readdir(s.dir).catch(() => []);
      const cpu = [];
      for (const f of files.filter((x) => x.endsWith('.cpuprofile'))) { try { cpu.push(fromCpuProfile(JSON.parse(await fsp.readFile(path.join(s.dir, f), 'utf8')))); } catch { /* partial file */ } }
      const mine = cpu.filter((r) => !isNpmProfile(r));
      if (s.cpu) {
        if ((mine.length ? mine : cpu).length) report.cpu = { ...mergeProfiles(mine.length ? mine : cpu), unit: 'ms', source: 'V8 CPU profile (sampled every ~1 ms)' };
        else report.notes.push('No CPU profile was written. Node writes it when the program exits normally.');
      }
      if (s.alloc) {
        const rows = [];
        for (const f of files.filter((x) => x.endsWith('.heapprofile'))) { try { const r = fromHeapProfile(JSON.parse(await fsp.readFile(path.join(s.dir, f), 'utf8'))); if (!r.some((x) => /[\\/]npm[\\/]/.test(x.file))) rows.push(...r); } catch { /* */ } }
        report.alloc = { rows, by: 'function', source: 'V8 allocation sampling (about every 32 KB), by the function that allocated' };
      }
    } else if (s.lang === 'python') {
      try { report.cpu = { ...fromPython(JSON.parse(await fsp.readFile(path.join(s.dir, 'py.json'), 'utf8'))), unit: 'ms', source: 'cProfile (wall time, every call measured)' }; } catch { report.notes.push('No Python profile was written (the program may have been killed).'); }
    } else if (s.lang === 'dotnet') {
      const t = await s.trace.result(8000);
      if (t.error) report.notes.push(t.error);
      else {
        report.pid = t.pid;
        if (s.cpu) { const cs = ep.cpuStacks(t); report.cpu = { ...cs, unit: 'ms', source: `.NET EventPipe sample profiler (every 1 ms, ${t.samples.length} thread samples, managed code only)` }; }
        if (s.alloc) report.alloc = { rows: ep.allocTable(t), by: 'type', source: '.NET allocation ticks: a sample about every 100 KB allocated' };
      }
    }
  } finally {
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
  }
  // our own helper files are not part of the program
  const ours = (f) => f && f.startsWith(s.dir);
  for (const part of [report.cpu, report.alloc]) {
    if (!part) continue;
    for (const f of part.functions || part.rows || []) if (ours(f.file)) { f.framework = true; f.file = ''; f.name = '[Nova profiler hook]'; }
    if (part.lines) for (const k of Object.keys(part.lines)) if (ours(k)) delete part.lines[k];
  }
  if (report.alloc && report.alloc.by === 'function') report.alloc.rows = report.alloc.rows.filter((r) => r.name !== '[Nova profiler hook]');
  // keep the message small: drop tiny stacks when there are very many
  if (report.cpu && report.cpu.stacks && report.cpu.stacks.length > 20000) {
    const total = report.cpu.stacks.reduce((a, x) => a + x.w, 0);
    report.cpu.stacks = report.cpu.stacks.filter((x) => x.w >= total * 0.0001);
  }
  return report;
}

// Find where a type is declared (class / record / struct / interface / enum) in the folder's .cs files
async function findType(root, typeName, skip) {
  const short = String(typeName || '').replace(/`\d+.*$/, '').replace(/<.*$/, '').replace(/\[\]$/, '').split(/[.+]/).pop();
  if (!root || !short || !/^[A-Za-z_]\w*$/.test(short)) return null;
  const re = new RegExp(`\\b(?:class|record|struct|interface|enum)\\s+(?:class\\s+|struct\\s+)?${short}\\b`);
  const hit = await searchCs(root, skip, (ls) => ls.findIndex((l) => re.test(l) && !/^\s*\/\//.test(l)));
  return hit;
}
async function searchCs(root, skip, fn) {
  const stack = [[root, 0]];
  let seen = 0;
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8 && !(skip && skip.has(e.name)) && !['bin', 'obj', '.git', 'node_modules'].includes(e.name)) stack.push([full, depth + 1]); continue; }
      if (!/\.cs$/i.test(e.name) || ++seen > 3000) continue;
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      const i = fn(text.split(/\r?\n/));
      if (i >= 0) return { file: full, line: i + 1 };
    }
  }
  return null;
}

// Heap snapshot of the .NET program: of a profiled run (through its diagnostic port), or of the
// processes a Diagnostic Tools session watches (debugging: through the port every .NET process opens)
const typeCaches = new Map(); // 'prof:<id>' | 'pid:<pid>' -> type id -> name
const typeCache = (key) => { if (!typeCaches.has(key)) { if (typeCaches.size > 50) typeCaches.delete(typeCaches.keys().next().value); typeCaches.set(key, new Map()); } return typeCaches.get(key); };
// analyzed snapshots (object graphs) kept for Paths to Root / Referenced Types: newest few per window
const heapGraphs = new Map(); // key -> { owner, analysis }
let heapSeq = 0;
function keepAnalysis(owner, analysis) {
  const key = `heap${++heapSeq}`;
  heapGraphs.set(key, { owner, analysis });
  const mine = [...heapGraphs].filter(([, v]) => v.owner === owner);
  while (mine.length > 8) heapGraphs.delete(mine.shift()[0]);
  return key;
}
// counts and sizes per type name (generic types can be reported once per module)
function withAnalysis(r, owner) {
  if (!r || r.error || !r.graph) { if (r) delete r.graph; return r; }
  try {
    const a = heapgraph.analyze(r.graph);
    const byName = new Map();
    for (const t of a.types) { const e = byName.get(t.name); if (e) { e.count += t.count; e.bytes += t.bytes; e.inclusive += t.inclusive; } else byName.set(t.name, { ...t }); }
    r.types = [...byName.values()].sort((x, y) => y.inclusive - x.inclusive);
    r.key = keepAnalysis(owner, a);
    r.roots = a.roots; r.unknownRoots = a.unknownRoots; r.analysisMs = a.ms;
  } catch (e) { r.analysisError = e.message; }
  delete r.graph;
  return r;
}
async function heapSnapshot({ profId, diagId }, owner) {
  const s = profId && sessions.get(profId);
  if (s && s.trace) return withAnalysis(await ep.heapSnapshot(() => s.trace.nextConn(5000), { typeNames: typeCache(`prof:${profId}`), graph: true }), owner);
  const pids = diagId != null ? diag.pidsOf(diagId) : [];
  if (!pids.length) return { error: 'The program is not running.' };
  const found = await ep.findDotnet(pids);
  if (!found) return { error: 'No .NET runtime found in the program\'s processes.' };
  const r = await ep.heapSnapshot(() => ep.connectTo(found.address), { typeNames: typeCache(`pid:${found.pid}:${found.address}`), graph: true });
  return { ...withAnalysis(r, owner), pid: found.pid };
}

function register({ ipcMain, ownerId, SKIP_DIRS }) {
  ipcMain.handle('prof:heapSnapshot', (_e, o) => heapSnapshot(o || {}, ownerId()));
  ipcMain.handle('prof:heapPaths', (_e, { key, type }) => { const h = heapGraphs.get(key); return h ? h.analysis.paths(type) : null; });
  ipcMain.handle('prof:heapRefs', (_e, { key, type }) => { const h = heapGraphs.get(key); return h ? h.analysis.refs(type) : null; });
  ipcMain.handle('prof:findType', (_e, { root, name }) => findType(root, name, SKIP_DIRS));
  ipcMain.handle('prof:prepare', (_e, o) => prepare(o, ownerId()));
  ipcMain.handle('prof:beforeStop', (_e, id) => beforeStop(id));
  ipcMain.handle('prof:finish', (_e, id) => finish(id));
  ipcMain.handle('prof:findMethod', (_e, { root, ns, method }) => findMethod(root, ns, method, SKIP_DIRS));
}
function windowClosed(owner) {
  for (const [k, v] of heapGraphs) if (v.owner === owner) heapGraphs.delete(k);
  for (const [id, s] of sessions) if (s.owner === owner) { if (s.trace) s.trace.close(); fs.rm(s.dir, { recursive: true, force: true }, () => {}); sessions.delete(id); }
}

module.exports = { heapGraphs, heapSnapshot, findType, register, windowClosed, fromCpuProfile, fromHeapProfile, fromPython, mergeProfiles, findMethod, dotnetTargetPath, prepare, finish, beforeStop, NODE_HOOK, PY_HOOK, _sessions: sessions };
void pathToFileURL;
