// Phase 25: line staging, Reqnroll step matching, .resx text edits, VS Code theme conversion, .vsix reading, EF / ILSpy helpers
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const J = (x) => JSON.parse(JSON.stringify(x));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
const fnSrc = (file, name) => { const t = src(file); const i = t.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return t.slice(i, t.indexOf('\n}\n', i) + 2); };
const load = (file, names, pre = '') => { const ctx = {}; vm.createContext(ctx); vm.runInContext(`${pre}\n${names.map((n) => fnSrc(file, n)).join('\n')}\nthis.f = { ${names.join(', ')} };`, ctx); return ctx.f; };

test('Line staging: only the chosen changes reach the index', () => {
  const { glApply, glTouches } = load('gitlines.js', ['glApply', 'glTouches']);
  const orig = 'a\nb\nc\nd\ne\n';
  const mod = 'a\nB\nc\nnew\nd\n';
  // changes as Monaco reports them: b->B (2..2 / 2..2), insert "new" after c (3,0 / 4..4), delete e (5..5 / 5,0)
  const changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
    { originalStartLineNumber: 5, originalEndLineNumber: 5, modifiedStartLineNumber: 5, modifiedEndLineNumber: 0 }
  ];
  assert.strictEqual(glApply(orig, mod, changes, () => false), orig);
  assert.strictEqual(glApply(orig, mod, changes, () => true), mod);
  assert.strictEqual(glApply(orig, mod, changes, (c, i) => i === 0), 'a\nB\nc\nd\ne\n');
  assert.strictEqual(glApply(orig, mod, changes, (c, i) => i === 1), 'a\nb\nc\nnew\nd\ne\n');
  assert.strictEqual(glApply(orig, mod, changes, (c, i) => i === 2), 'a\nb\nc\nd\n');
  assert.strictEqual(glApply('x\r\ny\r\n', 'x\r\nY\r\n', [changes[0]].map((c) => ({ ...c, originalStartLineNumber: 2, originalEndLineNumber: 2 })), () => true), 'x\r\nY\r\n');
  const sel = (a, b) => [{ startLineNumber: a, endLineNumber: b }];
  assert.deepStrictEqual(changes.map((c) => glTouches(c, sel(4, 4))), [false, true, false]);
  assert.deepStrictEqual(changes.map((c) => glTouches(c, sel(1, 2))), [true, false, false]);
  assert.deepStrictEqual(changes.map((c) => glTouches(c, sel(6, 6))), [false, false, true], 'a deletion is touched at the line after it');
});

test('Reqnroll: Cucumber expressions, regular expressions, And/But, outlines', () => {
  const f = load('gherkin.js', ['gkBindingRegex', 'gkSteps', 'gkMatch'], 'const GK = { bindings: [] }; const LANGS = {};');
  const b = (kind, text) => ({ kind, text, re: f.gkBindingRegex(text) });
  const bindings = [b('Given', 'the basket has {int} item(s)'), b('When', 'I add {string} to the basket'), b('Then', '^the total is (\\d+) (euro|dollar)s?$'), b('Given', 'I am a member/guest'), b('StepDefinition', 'I wait {float} seconds')];
  const steps = f.gkSteps(['Feature: Basket', '  Scenario: add', '    Given the basket has 1 item', '    And I am a guest', '    When I add "apple" to the basket', '    And I wait 0.5 seconds', '    Then the total is 3 euros', '    But the total is three euros', '  Scenario Outline: many', '    Given the basket has <n> items', '    When I add <fruit> to the basket'].join('\n'));
  assert.deepStrictEqual(J(steps.map((s) => [s.kind, s.line])), [['Given', 3], ['Given', 4], ['When', 5], ['When', 6], ['Then', 7], ['Then', 8], ['Given', 10], ['When', 11]]);
  assert.deepStrictEqual(J(steps.map((s) => !!f.gkMatch(s, bindings))), [true, true, true, true, true, false, true, true]);
  assert.strictEqual(steps[0].col, 11);
});

test('.resx: values, comments, rename, add, remove as text edits', () => {
  const f = load('resx.js', ['rxSetValue', 'rxAdd', 'rxRemove', 'rxRename'], "const rxEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');");
  let x = '<?xml version="1.0" encoding="utf-8"?>\n<root>\n  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>\n  <data name="Hello" xml:space="preserve">\n    <value>Hello</value>\n  </data>\n</root>\n';
  x = f.rxSetValue(x, 'Hello', 'value', 'Hi <you> & "me"');
  assert.match(x, /<value>Hi &lt;you&gt; &amp; &quot;me&quot;<\/value>/);
  x = f.rxSetValue(x, 'Hello', 'comment', 'greeting');
  assert.match(x, /<value>Hi[^\n]*<\/value>\n {4}<comment>greeting<\/comment>\n {2}<\/data>/);
  x = f.rxSetValue(x, 'Hello', 'comment', '');
  assert.ok(!/<comment>/.test(x));
  x = f.rxAdd(x, 'Bye', 'Goodbye', 'farewell');
  assert.match(x, /<\/data>\n {2}<data name="Bye" xml:space="preserve">\n {4}<value>Goodbye<\/value>\n {4}<comment>farewell<\/comment>\n {2}<\/data>\n<\/root>\n$/);
  x = f.rxRename(x, 'Bye', 'Farewell');
  assert.match(x, /<data name="Farewell"/);
  x = f.rxRemove(x, 'Hello');
  assert.ok(!/name="Hello"/.test(x) && /name="Farewell"/.test(x) && /<resheader/.test(x));
});

test('Themes: VS Code token colors and workbench colors -> Monaco + Nova', () => {
  const s = src('themes.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${s.slice(s.indexOf('const TH_VARS'), s.indexOf('function thApply'))}; this.f = { thToMonaco, thVars };`, ctx);
  const t = { dark: true, theme: { colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'sideBar.background': '#21222c', focusBorder: '#6272a4', 'badge.background': 'var(--x)' }, tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6272A4', fontStyle: 'italic' } },
    { scope: 'string.quoted', settings: { foreground: '#F1FA8C' } }, { scope: 'storage.type, keyword.control', settings: { foreground: '#FF79C6' } },
    { scope: 'meta.class string', settings: { foreground: '#000000' } }, { settings: { background: '#282a36' } }
  ] } };
  const m = ctx.f.thToMonaco(t);
  assert.strictEqual(m.base, 'vs-dark');
  const rule = (tok) => J(m.rules.find((r) => r.token === tok));
  assert.deepStrictEqual(rule('comment'), { token: 'comment', foreground: '6272A4', fontStyle: 'italic' });
  assert.deepStrictEqual(rule('string'), { token: 'string', foreground: 'F1FA8C' });
  assert.deepStrictEqual(rule('keyword'), { token: 'keyword', foreground: 'FF79C6' });
  assert.ok(m.rules.some((r) => r.token === 'storage.type') && !m.rules.some((r) => r.foreground === '000000'));
  assert.deepStrictEqual(J(m.colors), { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2' });
  const v = J(ctx.f.thVars(t));
  assert.strictEqual(v['--bg'], '#282a36'); assert.strictEqual(v['--bg2'], '#21222c'); assert.strictEqual(v['--accent'], '#6272a4');
});

// a tiny zip writer for the test (deflated entries)
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); centrals.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
test('.vsix: contributed themes with "include" chains and comments', () => {
  const { themesFromVsix } = require('../main/themes');
  const vsix = zip({
    'extension/package.json': JSON.stringify({ name: 'x', contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' }, { label: 'Day', uiTheme: 'vs', path: './themes/day.json' }] } }),
    'extension/themes/base.json': '{ "colors": { "editor.background": "#000000", "focusBorder": "#111111" }, "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#777777" } }] }',
    'extension/themes/night.json': '{\n // night\n "include": "./base.json", "name": "Night", "colors": { "editor.background": "#101010", }, "tokenColors": [{ "scope": "string", "settings": { "foreground": "#00ff00" } }] }',
    'extension/themes/day.json': '{ "name": "Day", "type": "light", "colors": { "editor.background": "#ffffff" } }'
  });
  const t = themesFromVsix(vsix, 'pub.x');
  assert.deepStrictEqual(t.map((x) => [x.id, x.label, x.dark]), [['pub.x/Night', 'Night', true], ['pub.x/Day', 'Day', false]]);
  assert.deepStrictEqual(t[0].theme.colors, { 'editor.background': '#101010', focusBorder: '#111111' });
  assert.deepStrictEqual(t[0].theme.tokenColors.map((c) => c.scope), ['comment', 'string']);
});

test('EF Core / tools: JSON after log lines, commands with arguments', () => {
  const { efJson, splitCommand } = require('../main/dotnettools');
  assert.deepStrictEqual(efJson('Build started...\nBuild succeeded.\n[\n  { "id": "20260101_Init", "name": "Init", "applied": true }\n]\n'), [{ id: '20260101_Init', name: 'Init', applied: true }]);
  assert.strictEqual(efJson('no json here'), null);
  assert.deepStrictEqual(splitCommand('dotnet ef'), ['dotnet', ['ef']]);
  assert.deepStrictEqual(splitCommand('"C:\\Program Files\\tools\\ilspycmd.exe" --x'), ['C:\\Program Files\\tools\\ilspycmd.exe', ['--x']]);
});
