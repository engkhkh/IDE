// Phase 15: EventPipe protocol + nettrace parser, V8 / cProfile conversion, .NET method lookup, live runs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ep = require('../main/eventpipe');
const pr = require('../main/profiler');

test('diagnostics IPC messages', () => {
  const m = ep.collectTracing2(ep.providersFor({ cpu: true, alloc: true }));
  assert.strictEqual(m.subarray(0, 14).toString('latin1'), 'DOTNET_IPC_V1\0');
  assert.strictEqual(m.readUInt16LE(14), m.length);
  assert.strictEqual(m[16], 0x02); // EventPipe
  assert.strictEqual(m[17], 0x03); // CollectTracing2
  assert.strictEqual(m.readUInt32LE(20), 256); // buffer MB
  assert.strictEqual(m.readUInt32LE(24), 1); // nettrace
  assert.strictEqual(m[28], 1); // rundown
  assert.strictEqual(m.readUInt32LE(29), 2); // providers
  assert.strictEqual(m.readBigUInt64LE(33), 0xF00000000000n);
  assert.strictEqual(m.readUInt32LE(41), 4);
  const nameLen = m.readUInt32LE(45);
  assert.strictEqual(m.toString('utf16le', 49, 49 + (nameLen - 1) * 2), 'Microsoft-DotNETCore-SampleProfiler');
  const rt = ep.providersFor({ cpu: false, alloc: true });
  assert.strictEqual(rt.length, 1);
  assert.strictEqual(rt[0].keywords & 0x1n, 0x1n); // GC keyword for allocation ticks
  assert.strictEqual(ep.ipcString('').length, 4);
});

// ---- a small nettrace stream built by hand ----
function varu(n) { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const wstr = (s) => Buffer.from(`${s}\0`, 'utf16le');
function event(metaId, stackId, payload, first) {
  // compressed header: metadata id, thread, stack, timestamp, payload size
  const flags = 1 | 4 | 8 | 128;
  return Buffer.concat([Buffer.from([flags]), varu(metaId), varu(first ? 7 : 7), varu(stackId), varu(first ? 1000 : 10), varu(payload.length), payload]);
}
function block(name, content, offsetSoFar) {
  const head = Buffer.concat([Buffer.from([5, 5, 1]), i32(2), i32(0), i32(name.length), Buffer.from(name, 'latin1'), Buffer.from([6]), i32(content.length)]);
  let pad = 0;
  while ((offsetSoFar + head.length + pad) % 4) pad++;
  return Buffer.concat([head, Buffer.alloc(pad), content, Buffer.from([6])]);
}
function eventBlock(events) {
  const header = Buffer.alloc(20); header.writeUInt16LE(20, 0); header.writeUInt16LE(1, 2);
  return Buffer.concat([header, ...events]);
}
function buildTrace() {
  const parts = [Buffer.from('Nettrace', 'latin1'), i32(20), Buffer.from('!FastSerialization.1', 'latin1')];
  const trace = Buffer.concat([Buffer.from([5, 5, 1]), i32(4), i32(4), i32(5), Buffer.from('Trace'), Buffer.from([6]), Buffer.alloc(16), u64(0), u64(1000000), i32(8), i32(4242), i32(4), i32(1000), Buffer.from([6])]);
  parts.push(trace);
  let off = () => Buffer.concat(parts).length;
  const meta = (id, provider, eventId, name, version) => event(0, 0, Buffer.concat([i32(id), wstr(provider), i32(eventId), wstr(name), u64(0), i32(version), i32(5)]), id === 1);
  parts.push(block('MetadataBlock', eventBlock([
    meta(1, 'Microsoft-DotNETCore-SampleProfiler', 0, 'ThreadSample', 0),
    meta(2, 'Microsoft-Windows-DotNETRuntime', 143, 'MethodLoadVerbose', 1),
    meta(3, 'Microsoft-Windows-DotNETRuntime', 10, 'GCAllocationTick', 4)
  ]), off()));
  // stacks (leaf first): 1 = Inner <- Burn <- Main, 2 = Burn <- Main
  const stack = (ips) => Buffer.concat([i32(ips.length * 8), ...ips.map(u64)]);
  parts.push(block('StackBlock', Buffer.concat([i32(1), i32(2), stack([0x3010, 0x2010, 0x1010]), stack([0x2020, 0x1020])]), off()));
  const method = (start, size, ns, name, sig) => Buffer.concat([u64(1), u64(2), u64(start), i32(size), i32(0x06000001), i32(0), wstr(ns), wstr(name), wstr(sig), Buffer.from([0, 0])]);
  const sample = (type) => i32(type);
  const alloc = (type, amount, size) => Buffer.concat([i32(amount), i32(0), Buffer.from([0, 0]), u64(amount), u64(0xABC), wstr(type), i32(0), u64(0xDEF), u64(size)]);
  parts.push(block('EventBlock', eventBlock([
    event(2, 0, method(0x1000, 0x100, 'Program', '<Main>$', 'void  (class System.String[])'), true),
    event(2, 0, method(0x2000, 0x100, 'Calc', 'Burn', 'float64  (int32)')),
    event(2, 0, method(0x3000, 0x100, 'Calc', 'Inner', 'float64  (float64)')),
    event(1, 1, sample(2)), event(1, 1, sample(2)), event(1, 1, sample(2)),
    event(1, 2, sample(2)),
    event(1, 2, sample(1)), // waiting: not CPU
    event(3, 2, alloc('Widget', 100000, 32))
  ]), off()));
  parts.push(Buffer.from([1]));
  return Buffer.concat(parts);
}

test('nettrace parser: samples, method names, allocation ticks', () => {
  const t = ep.parseNettrace(buildTrace());
  assert.strictEqual(t.pid, 4242);
  assert.strictEqual(t.cpus, 4);
  assert.strictEqual(t.methods.length, 3);
  assert.strictEqual(t.samples.length, 5);
  assert.strictEqual(t.samples.filter((s) => s.managed).length, 4);
  const cs = ep.cpuStacks(t);
  const names = (s) => s.frames.map((f) => cs.functions[f].name).join(' > ');
  assert.deepStrictEqual(cs.stacks.map((s) => [names(s), s.w]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['Program.<Main>$(String[]) > Calc.Burn(int32)', 1],
    ['Program.<Main>$(String[]) > Calc.Burn(int32) > Calc.Inner(float64)', 3]
  ]);
  const a = ep.allocTable(t);
  assert.strictEqual(a[0].name, 'Widget');
  assert.strictEqual(a[0].bytes, 100000);
  assert.strictEqual(a[0].count, 3125);
  assert.strictEqual(a[0].by[0].name, 'Calc.Burn(int32)');
  assert.throws(() => ep.parseNettrace(Buffer.from('nope')), /not a nettrace/);
});

test('V8 CPU profile: stacks, self time, hot lines', () => {
  const file = path.join(os.tmpdir(), 'w.js');
  const url = require('url').pathToFileURL(file).href;
  const cf = (functionName, lineNumber, u = url) => ({ functionName, scriptId: '1', url: u, lineNumber, columnNumber: 0 });
  const prof = {
    nodes: [
      { id: 1, callFrame: cf('(root)', -1, ''), children: [2, 5] },
      { id: 2, callFrame: cf('', 0), children: [3] },
      { id: 3, callFrame: cf('main', 4), children: [4], positionTicks: [{ line: 6, ticks: 1 }] },
      { id: 4, callFrame: cf('hot', 1), children: [], positionTicks: [{ line: 2, ticks: 3 }, { line: 3, ticks: 1 }] },
      { id: 5, callFrame: cf('(garbage collector)', -1, ''), children: [] }
    ],
    startTime: 0, endTime: 6000, samples: [4, 4, 4, 4, 3, 5], timeDeltas: [0, 1000, 1000, 1000, 1000, 1000]
  };
  const r = pr.fromCpuProfile(prof);
  const byName = Object.fromEntries(r.functions.map((f, i) => [f.name.split(' ')[0], i]));
  const hot = r.stacks.find((s) => s.frames[s.frames.length - 1] === byName.hot);
  assert.ok(hot && Math.abs(hot.w - 4) < 0.01, JSON.stringify(r.stacks));
  assert.strictEqual(r.functions[byName.hot].file, file);
  assert.strictEqual(r.functions[byName.hot].line, 2);
  assert.strictEqual(r.functions[byName['[Garbage']].framework, true);
  assert.ok(Math.abs(r.lines[file][2] - 3) < 0.01 && Math.abs(r.lines[file][3] - 1) < 0.01, JSON.stringify(r.lines));
  // npm's own profile is recognised
  assert.ok(!require('../main/profiler').mergeProfiles([r]).functions.some((f) => /npm/.test(f.file)));
});

test('cProfile data: functions and call edges, library code marked', () => {
  const r = pr.fromPython({
    prefix: ['/usr'], hook: '/tmp/x/sitecustomize.py',
    functions: [
      { file: '/home/me/app.py', line: 1, name: '<module>', calls: 1, self: 1, total: 100, callers: [] },
      { file: '/home/me/app.py', line: 3, name: 'hot', calls: 5, self: 70, total: 90, callers: [[0, 5, 90]] },
      { file: '~', line: 0, name: '<built-in method math.sqrt>', calls: 1000, self: 20, total: 20, callers: [[1, 1000, 20]] },
      { file: '/usr/lib/python3/json/__init__.py', line: 10, name: 'dumps', calls: 1, self: 5, total: 5, callers: [[0, 1, 5]] },
      { file: '/tmp/x/sitecustomize.py', line: 9, name: '_save', calls: 1, self: 1, total: 1, callers: [] }
    ]
  });
  assert.strictEqual(r.functions.length, 4);
  assert.strictEqual(r.functions[1].name, 'hot (app.py:3)');
  assert.strictEqual(r.functions[2].framework, true);
  assert.strictEqual(r.functions[3].framework, true);
  assert.deepStrictEqual(r.edges.find((e) => e[1] === 1), [0, 1, 90]);
});

test('find a .NET method in the source by name', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
  fs.writeFileSync(path.join(d, 'Program.cs'), 'using System;\n\nvar c = new Calc();\nConsole.WriteLine(c.Burn(3));\n');
  fs.mkdirSync(path.join(d, 'Lib'));
  fs.writeFileSync(path.join(d, 'Lib', 'Calc.cs'), 'namespace Demo;\n\npublic class Calc\n{\n    public Calc() { }\n    public double Burn(int ms)\n    {\n        return Inner(ms);\n    }\n    private static double Inner(double x) => x;\n    async Task<int> LoadAsync() { await Task.Delay(1); return 1; }\n}\n');
  assert.deepStrictEqual(await pr.findMethod(d, 'Demo.Calc', 'Burn'), { file: path.join(d, 'Lib', 'Calc.cs'), line: 6 });
  assert.deepStrictEqual(await pr.findMethod(d, 'Demo.Calc', 'Inner'), { file: path.join(d, 'Lib', 'Calc.cs'), line: 10 });
  assert.deepStrictEqual(await pr.findMethod(d, 'Demo.Calc', '.ctor'), { file: path.join(d, 'Lib', 'Calc.cs'), line: 5 });
  assert.deepStrictEqual(await pr.findMethod(d, 'Demo.Calc+<LoadAsync>d__3', '<LoadAsync>d__3'), { file: path.join(d, 'Lib', 'Calc.cs'), line: 11 });
  assert.deepStrictEqual(await pr.findMethod(d, 'Program', '<Main>$'), { file: path.join(d, 'Program.cs'), line: 3 });
  assert.strictEqual(await pr.findMethod(d, 'Nope', 'Missing'), null);
});

async function runProfiled(o, cmd, cwd) {
  const p = await pr.prepare(o, 1);
  assert.ok(!p.error, p.error);
  const c = spawn(p.command || cmd, { shell: true, cwd, env: { ...process.env, ...p.env }, stdio: 'ignore' });
  await new Promise((r) => c.on('exit', r));
  return pr.finish(p.id);
}

test('live: Node CPU profile + allocations', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-'));
  fs.writeFileSync(path.join(d, 'w.js'), 'const keep = [];\nfunction hot(n) { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i); return x; }\nfunction make() { for (let i = 0; i < 100000; i++) keep.push({ i, s: "x" + i }); }\nlet t = 0; for (let r = 0; r < 20; r++) t += hot(2e6);\nmake();\n');
  const r = await runProfiled({ lang: 'node', cpu: true, alloc: true }, 'node w.js', d);
  assert.ok(r.cpu, JSON.stringify(r.notes));
  const hot = r.cpu.functions.findIndex((f) => /^hot \(w\.js:2\)/.test(f.name));
  const self = r.cpu.stacks.filter((s) => s.frames[s.frames.length - 1] === hot).reduce((a, s) => a + s.w, 0);
  assert.ok(self > 20, `hot self ${self}`);
  assert.ok(Object.values(r.cpu.lines).some((ls) => ls[2] > 10));
  assert.ok(!r.cpu.functions.some((f) => /nova-hook/.test(f.file)));
  assert.ok(r.alloc.rows.some((x) => /^make \(w\.js:3\)/.test(x.name) && x.bytes > 1e6), JSON.stringify(r.alloc.rows.slice(0, 3)));
});

const python = (() => { for (const p of ['python3', 'python']) { try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch { /* */ } } return null; })();
test('live: Python cProfile', { skip: !python }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  fs.writeFileSync(path.join(d, 'w.py'), 'def hot(n):\n    return sum(i * i for i in range(n))\n\ndef main():\n    for _ in range(5):\n        hot(100000)\n\nmain()\n');
  const r = await runProfiled({ lang: 'python', cpu: true }, `${python} w.py`, d);
  assert.ok(r.cpu, JSON.stringify(r.notes));
  const hot = r.cpu.functions.find((f) => f.name === 'hot (w.py:1)');
  assert.ok(hot && hot.calls === 5 && hot.total > 1, JSON.stringify(hot));
  assert.ok(r.cpu.edges.length > 0);
});

const dotnet = (() => { try { execFileSync('dotnet', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('live: .NET EventPipe trace of a real program', { skip: !dotnet, timeout: 240000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
  fs.writeFileSync(path.join(d, 'nuget.config'), '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(d, 'pd.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
  fs.writeFileSync(path.join(d, 'Program.cs'), 'var keep = new List<byte[]>();\ndouble x = 0;\nfor (int r = 0; r < 150000; r++) x += Work.Spin(x);\nfor (int i = 0; i < 2000; i++) keep.Add(new byte[1000]);\nConsole.WriteLine(x > 0);\nstatic class Work { public static double Spin(double v) { double s = 0; for (int i = 0; i < 1000; i++) s += Math.Sqrt(v + i); return s; } }\n');
  execFileSync('dotnet', ['build', '-nologo', '-v', 'q'], { cwd: d, stdio: 'ignore' });
  const r = await runProfiled({ lang: 'dotnet', cpu: true, alloc: true, project: path.join(d, 'pd.csproj'), config: 'Debug' }, null, d);
  assert.ok(r.cpu, JSON.stringify(r.notes));
  const spin = r.cpu.functions.findIndex((f) => f.name === 'Work.Spin(float64)');
  assert.ok(spin >= 0, r.cpu.functions.slice(0, 10).map((f) => f.name).join(', '));
  const total = r.cpu.stacks.filter((s) => s.frames.includes(spin)).reduce((a, s) => a + s.w, 0);
  assert.ok(total > 200, `Spin ${total} ms; ${r.cpu.source}; ${r.cpu.stacks.length} stacks`);
  assert.ok(r.alloc.rows.some((x) => x.name === 'System.Byte[]' && x.by.some((b) => /<Main>\$/.test(b.name))), JSON.stringify(r.alloc.rows.slice(0, 2)));
});

// ---------------- Phase 16: portable PDB, source lines, heap snapshots ----------------
const pdb = require('../main/pdb');

test('compressed integers (ECMA-335)', () => {
  assert.deepStrictEqual(pdb.compressedU(Buffer.from([0x03]), 0).slice(0, 2), [3, 1]);
  assert.deepStrictEqual(pdb.compressedU(Buffer.from([0x80, 0x80]), 0).slice(0, 2), [0x80, 2]);
  assert.deepStrictEqual(pdb.compressedU(Buffer.from([0xC0, 0x00, 0x40, 0x00]), 0).slice(0, 2), [0x4000, 4]);
  // signed: 3 -> 0x06, -3 -> 0x7B, 64 -> 0x8080, -8192 -> 0x8001 (spec examples)
  assert.strictEqual(pdb.compressedS(Buffer.from([0x06]), 0)[0], 3);
  assert.strictEqual(pdb.compressedS(Buffer.from([0x7B]), 0)[0], -3);
  assert.strictEqual(pdb.compressedS(Buffer.from([0x80, 0x80]), 0)[0], 64);
  assert.strictEqual(pdb.compressedS(Buffer.from([0x80, 0x01]), 0)[0], -8192);
  assert.throws(() => pdb.parsePdb(Buffer.from('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0')), /not a portable PDB/);
});

test('find a .NET type declaration', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  fs.writeFileSync(path.join(d, 'A.cs'), 'namespace X;\n// class Widget is below\n\npublic sealed record class Widget(int Id);\npublic enum Kind { A }\n');
  assert.deepStrictEqual(await pr.findType(d, 'X.Widget'), { file: path.join(d, 'A.cs'), line: 4 });
  assert.deepStrictEqual(await pr.findType(d, 'X.Widget[]'), { file: path.join(d, 'A.cs'), line: 4 });
  assert.deepStrictEqual(await pr.findType(d, 'X.Kind'), { file: path.join(d, 'A.cs'), line: 5 });
  assert.strictEqual(await pr.findType(d, 'System.String'), null);
});

test('live: .NET source lines from the PDB + heap snapshots', { skip: !dotnet, timeout: 240000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  fs.writeFileSync(path.join(d, 'nuget.config'), '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(d, 'pl.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
  fs.writeFileSync(path.join(d, 'Program.cs'), [
    'var keep = new List<Item>();',
    'double x = 0;',
    'for (int r = 0; r < 100000; r++) x += Work.Spin(x);',
    'for (int i = 0; i < 20000; i++) keep.Add(new Item(i));',
    'if (args.Length > 0) { Console.WriteLine("ready"); Thread.Sleep(60000); }',
    'Console.WriteLine(x > 0);',
    'record Item(int Id);',
    'static class Work',
    '{',
    '    public static double Spin(double v)',
    '    {',
    '        double s = 0;',
    '        for (int i = 0; i < 1000; i++) s += Math.Sqrt(v + i);',
    '        return s;',
    '    }',
    '}',
    ''
  ].join('\n'));
  execFileSync('dotnet', ['build', '-nologo', '-v', 'q'], { cwd: d, stdio: 'ignore' });
  const prog = path.join(d, 'Program.cs');
  // the PDB itself
  const p = pdb.loadPdb(path.join(d, 'bin', 'Debug', 'net8.0', 'pl.pdb'));
  assert.ok(p && p.docs.includes(prog), JSON.stringify(p && p.docs));
  // a profiled run: functions and hot lines come with files and lines
  const r = await runProfiled({ lang: 'dotnet', cpu: true, alloc: true, project: path.join(d, 'pl.csproj'), config: 'Debug' }, null, d);
  const spin = r.cpu.functions.find((f) => f.name === 'Work.Spin(float64)');
  assert.ok(spin && spin.file === prog && spin.line === 10, JSON.stringify(spin)); // the declaration, not the "{"
  const lines = r.cpu.lines[prog] || {};
  const hottest = Object.entries(lines).sort((a, b) => b[1] - a[1])[0];
  assert.ok(hottest && hottest[0] === '13', JSON.stringify(lines));
  const items = r.alloc.rows.find((x) => x.name === 'Item');
  assert.ok(items && items.by.some((b) => b.file === prog && b.line === 4), JSON.stringify(items && items.by));
  // heap snapshot of a running program (the port every .NET process opens)
  const c = spawn('dotnet', [path.join(d, 'bin', 'Debug', 'net8.0', 'pl.dll'), 'wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((res) => c.stdout.on('data', (b) => { if (/ready/.test(b)) res(); }));
  try {
    const found = await ep.findDotnet([c.pid]);
    assert.ok(found && found.pid === c.pid);
    const snap = await ep.heapSnapshot(() => ep.connectTo(found.address));
    assert.ok(!snap.error, snap.error);
    const item = snap.types.find((t) => t.name === 'Item');
    assert.ok(item && item.count === 20000, JSON.stringify(snap.types.slice(0, 5)));
    assert.ok(snap.objects > 20000 && snap.bytes > item.bytes);
    // the object graph: Items are kept by List<Item> (the local `keep` in Main, on the stack)
    const hg = require('../main/heapgraph');
    const snap2 = await ep.heapSnapshot(() => ep.connectTo(found.address), { graph: true });
    const a = hg.analyze(snap2.graph);
    const flat = (n, d = 0) => [`${'.'.repeat(d)}${n.name}`, ...n.children.flatMap((c) => flat(c, d + 1))];
    const paths = flat(a.paths('Item'));
    assert.ok(paths.includes('.Item[]') && paths.some((x) => /^\.\.System\.Collections\.Generic\.List`1\[Item\]$/.test(x)) && paths.includes('...[Stack]'), paths.join(' '));
    const t = a.types.find((x) => x.name === 'Item');
    assert.strictEqual(t.inclusive, t.bytes); // Items reference nothing
    const list = a.types.find((x) => /^System\.Collections\.Generic\.List`1\[Item\]$/.test(x.name));
    assert.ok(list.inclusive >= t.bytes, `${list.inclusive} >= ${t.bytes}`);
  } finally { c.kill(); }
});
