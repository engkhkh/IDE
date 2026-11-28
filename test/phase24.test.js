// Phase 24 (from Passenger): MCP server protocol, Local History store, hit counts, inline values, project file context
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const J = (x) => JSON.parse(JSON.stringify(x));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
// a top-level function: from its declaration to the first line that is just "}"
const fnSrc = (file, name) => { const t = src(file); const i = t.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return t.slice(i, t.indexOf('\n}\n', i) + 2); };

test('MCP: initialize, tools/list, notifications, unknown methods', async () => {
  const mcp = require('../main/mcp');
  const init = await mcp.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code' } } });
  assert.strictEqual(init.result.protocolVersion, '2025-03-26');
  assert.deepStrictEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.strictEqual(init.result.serverInfo.name, 'nova-ide');
  assert.strictEqual(await mcp.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await mcp.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['get_workspace', 'get_editor_text', 'open_file', 'get_diagnostics', 'build', 'run_tests', 'find_symbol', 'debug', 'set_breakpoint', 'screenshot']);
  for (const t of list.result.tools) assert.strictEqual(t.inputSchema.type, 'object');
  assert.deepStrictEqual((await mcp.rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).error.code, -32601);
  assert.deepStrictEqual((await mcp.rpc({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
});

test('Local History: versions newest first, unchanged saves skipped, older than 5 days pruned', async () => {
  const lh = require('../main/localhistory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
  lh.setRoot(dir);
  const file = path.join(dir, 'src', 'A.cs');
  assert.strictEqual(await lh.record(file, 'v1'), true);
  assert.strictEqual(await lh.record(file, 'v1'), false, 'same text twice is one version');
  assert.strictEqual(await lh.record(file, 'v2', 'before refactoring'), true);
  const list = await lh.list(file);
  assert.deepStrictEqual(list.map((v) => [v.label, v.size]), [['before refactoring', 2], ['', 2]]);
  assert.ok(list[0].at > list[1].at);
  await lh.prune(file, Date.now() + 6 * 24 * 3600 * 1000);
  assert.deepStrictEqual(await lh.list(file), []);
});

test('Breakpoints: Visual Studio hit count forms', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fnSrc('debug.js', 'dbgHitMatches')}; this.f = dbgHitMatches;`, ctx);
  const hits = (c) => J([1, 2, 3, 4, 5, 6].filter((n) => ctx.f(c, n)));
  assert.deepStrictEqual(hits('3'), [3]);
  assert.deepStrictEqual(hits('= 3'), [3]);
  assert.deepStrictEqual(hits('>= 4'), [4, 5, 6]);
  assert.deepStrictEqual(hits('% 2'), [2, 4, 6]);
  assert.deepStrictEqual(hits('nonsense'), [1, 2, 3, 4, 5, 6]);
});

test('Inline values: the locals each line reads, not words in strings or comments', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fnSrc('debuginline.js', 'diLineValues')}; ${fnSrc('debuginline.js', 'diMethodStart')}; const diShort = (v) => String(v); this.f = diLineValues; this.m = diMethodStart;`, ctx);
  const lines = ['class A {', '  static int Sum(int[] items) {', '    var total = 0; // total of items', '    foreach (var i in items) total += i;', '    Console.WriteLine("total is " + total);', '    return total;', '  }', '}'];
  assert.strictEqual(ctx.m(lines, 5), 2);
  const vals = ctx.f(lines, 2, 5, [{ name: 'items', value: 'int[3]' }, { name: 'total', value: '6' }, { name: 'i', value: '3' }]);
  assert.deepStrictEqual(J(vals), [{ line: 2, text: 'items = int[3]' }, { line: 3, text: 'total = 6' }, { line: 4, text: 'i = 3, items = int[3], total = 6' }, { line: 5, text: 'total = 6' }]);
  const py = ['def f(x):', '    y = x * 2  # y', '    return y'];
  assert.strictEqual(ctx.m(py, 3), 1);
});

test('Project files: where the cursor is', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fnSrc('projectfiles.js', 'pjContext')}; this.f = pjContext;`, ctx);
  const head = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    ';
  assert.deepStrictEqual(J(ctx.f(`${head}<Tar`)), { kind: 'element', parent: 'PropertyGroup', typed: 'Tar' });
  assert.deepStrictEqual(J(ctx.f(`${head}<OutputType>Ex`)), { kind: 'value', prop: 'OutputType', typed: 'Ex' });
  assert.deepStrictEqual(J(ctx.f(`${head}<Nullable>enable</Nullable>\n  </PropertyGroup>\n  <ItemGroup>\n    <`)), { kind: 'element', parent: 'ItemGroup', typed: '' });
  assert.deepStrictEqual(J(ctx.f('<ItemGroup>\n <PackageReference Include="Serilog" Version="4.')), { kind: 'attr', tag: 'PackageReference', attr: 'Version', typed: '4.', include: 'Serilog' });
  assert.deepStrictEqual(J(ctx.f('<ItemGroup>\n <PackageReference Include="Newton')), { kind: 'attr', tag: 'PackageReference', attr: 'Include', typed: 'Newton', include: null });
});
