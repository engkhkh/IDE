'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../main/coverage');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('coverlet Cobertura: totals, methods, async state machines folded back', () => {
  const p = C.parseAny(fx('coverlet.cobertura.xml'));
  assert.strictEqual(p.format, 'cobertura');
  const s = C.summarize([p.records]);
  assert.deepStrictEqual(s.totals, { covered: 14, total: 22, bc: 5, bt: 10 }); // same as the report header
  const calc = s.tree[0].children.find((n) => n.name === 'Calc').children.find((n) => n.name === 'Calculator');
  const names = calc.children.map((m) => m.name);
  assert.deepStrictEqual(names, ['Add', 'Divide', 'Multiply', 'Grade', 'Clamp', 'AddLaterAsync', 'SumEven']);
  const grade = calc.children.find((m) => m.name === 'Grade');
  assert.deepStrictEqual([grade.covered, grade.total, grade.bc, grade.bt], [6, 7, 3, 4]);
  const file = s.files.find((f) => f.file.endsWith('Calculator.cs'));
  assert.strictEqual(file.file, path.join('/src/TestDemo/Calc/', 'Calculator.cs'));
  assert.deepStrictEqual(file.lines.find((l) => l[0] === 13), [13, 1, 1, 2]); // partly covered branch
  assert.deepStrictEqual(file.lines.find((l) => l[0] === 15), [15, 0, 0, 0]);
});

test('merging two reports adds hits but keeps line counts', () => {
  const p = C.parseAny(fx('coverlet.cobertura.xml'));
  const s = C.summarize([p.records, p.records]);
  assert.deepStrictEqual(s.totals, { covered: 14, total: 22, bc: 5, bt: 10 });
  assert.strictEqual(s.files.find((f) => f.file.endsWith('Calculator.cs')).lines.find((l) => l[0] === 5)[1], 8);
});

test('coverage.py Cobertura (class = file) and LCOV', () => {
  const py = C.summarize([C.parseAny(fx('coveragepy.xml')).records]);
  assert.deepStrictEqual(py.totals, { covered: 4, total: 6, bc: 1, bt: 2 });
  assert.strictEqual(py.tree[0].children[0].kind, 'file');
  assert.strictEqual(py.files[0].file, path.join('/proj', 'app.py'));
  const l = C.parseAny(fx('lcov.info'));
  assert.strictEqual(l.format, 'lcov');
  const s = C.summarize([l.records]);
  assert.deepStrictEqual(s.totals, { covered: 2, total: 4, bc: 1, bt: 2 });
  const fns = s.tree[0].children[0].children.map((m) => `${m.name}:${m.covered}/${m.total}`);
  assert.deepStrictEqual(fns, ['add:2/2', 'sub:0/2']);
  assert.throws(() => C.parseAny('hello'), /Not a coverage file/);
});

test('helpers: generated .NET names, signatures, collector choice', () => {
  assert.deepStrictEqual(C.splitClass('Calc.Calculator/<AddLaterAsync>d__5'), { cls: 'Calc.Calculator', fromMethod: 'AddLaterAsync' });
  assert.deepStrictEqual(C.splitClass('A.Outer/Inner'), { cls: 'A.Outer.Inner', fromMethod: null });
  assert.strictEqual(C.cleanMethod('MoveNext', 'Run'), 'Run');
  assert.strictEqual(C.cleanMethod('<SumEven>b__6_0', null), 'SumEven');
  assert.strictEqual(C.shortSig('(System.Int32,System.Collections.Generic.List`1<System.String>)'), '(int, List<string>)');
  assert.strictEqual(C.collectorFor('<PackageReference Include="coverlet.collector" Version="6.0.4" />'), 'XPlat Code Coverage');
  assert.strictEqual(C.collectorFor('<PackageReference Include="xunit" />'), 'Code Coverage;Format=cobertura');
});

test('deterministic paths (/_/...) are matched to workspace files by their ending', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'covroot-'));
  fs.mkdirSync(path.join(root, 'src', 'Calc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'Calc', 'Calculator.cs'), '');
  const xml = fx('coverlet.cobertura.xml').replace('<source>/src/TestDemo/Calc/</source>', '<source>/_/src/Calc/</source>');
  const s = C.summarize([C.parseAny(xml, { root }).records]);
  assert.ok(s.files.some((f) => f.file === path.join(root, 'src', 'Calc', 'Calculator.cs')), s.files.map((f) => f.file).join());
  fs.rmSync(root, { recursive: true, force: true });
});
