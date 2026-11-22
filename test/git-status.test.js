// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { parseStatus } = require('../main/git');

test('parses branch, ahead/behind, staged, changes and untracked', () => {
  const out = ['## main...origin/main [ahead 2, behind 1]', 'M  src/a.cs', ' M src/b.cs', 'MM src/c.cs', '?? new.txt', 'R  new-name.cs', 'old-name.cs', ''].join('\0');
  const s = parseStatus(out);
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.upstream, 'origin/main');
  assert.strictEqual(s.ahead, 2);
  assert.strictEqual(s.behind, 1);
  assert.deepStrictEqual(s.staged.map((f) => f.file), ['src/a.cs', 'src/c.cs', 'new-name.cs']);
  assert.strictEqual(s.staged[2].from, 'old-name.cs');
  assert.deepStrictEqual(s.changes.map((f) => `${f.status}:${f.file}`), ['M:src/b.cs', 'M:src/c.cs', 'U:new.txt']);
});

test('parses a fresh repository with no commits', () => {
  const s = parseStatus(['## No commits yet on master', '?? Program.cs', ''].join('\0'));
  assert.strictEqual(s.branch, 'master');
  assert.strictEqual(s.changes.length, 1);
});
