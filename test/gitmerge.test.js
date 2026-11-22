'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../main/gitmerge');
const { parseStatus } = require('../main/git');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

test('parseConflicts: diff3 blocks, common text, empty sides', () => {
  const t = 'a\n<<<<<<< Current\nours\n||||||| Base\nbase\n=======\ntheirs1\ntheirs2\n>>>>>>> Incoming\nb\n<<<<<<< Current\n=======\nnew\n>>>>>>> Incoming\n';
  assert.deepStrictEqual(M.parseConflicts(t), [
    { type: 'common', text: 'a\n' },
    { type: 'conflict', ours: 'ours\n', base: 'base\n', theirs: 'theirs1\ntheirs2\n', hasBase: true },
    { type: 'common', text: 'b\n' },
    { type: 'conflict', ours: '', base: '', theirs: 'new\n', hasBase: false }
  ]);
  // text that only looks like a marker stays text; an unterminated block is kept as text
  assert.deepStrictEqual(M.parseConflicts('x <<<<<<< y\n'), [{ type: 'common', text: 'x <<<<<<< y\n' }]);
  assert.strictEqual(M.parseConflicts('<<<<<<< A\none\n').map((s) => s.type).join(), 'common');
  assert.ok(M.hasMarkers('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n'));
  assert.ok(!M.hasMarkers('// <<<<<<< not a marker\n'));
});

test('parseStatus: unmerged paths are conflicts, not staged/changes', () => {
  const s = parseStatus('## main\0UU src/a.cs\0DU b.cs\0AA c.md\0M  d.cs\0');
  assert.deepStrictEqual(s.conflicts.map((c) => `${c.code} ${c.file} ${c.label}`), ['UU src/a.cs Both modified', 'DU b.cs Deleted by us', 'AA c.md Both added']);
  assert.deepStrictEqual(s.staged.map((x) => x.file), ['d.cs']);
  assert.deepStrictEqual(s.changes, []);
});

test('real repository: merge conflict -> info -> resolve -> commit; stashes', { skip: !hasGit }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novamerge-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' };
  const g = (...a) => { try { return execFileSync('git', a, { cwd: root, env, stdio: 'pipe' }).toString(); } catch (e) { return e.stdout.toString(); } };
  const w = (f, t) => fs.writeFileSync(path.join(root, f), t);
  g('init', '-q', '-b', 'main');
  w('a.txt', 'one\ntwo\nthree\n'); w('gone.txt', 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'topic'); w('a.txt', 'one\nTWO topic\nthree\n'); w('gone.txt', 'x changed\n'); g('commit', '-qam', 'topic');
  g('checkout', '-q', 'main'); w('a.txt', 'one\ntwo main\nthree\n'); g('rm', '-q', 'gone.txt'); g('commit', '-qam', 'main');
  g('merge', 'topic');

  const op = await M.operationState(root);
  assert.strictEqual(op.kind, 'merge');
  assert.strictEqual(op.incoming, 'topic');
  const info = await M.conflictInfo(root, 'a.txt');
  assert.deepStrictEqual(info.stages, [1, 2, 3]);
  assert.ok(info.workingHasMarkers);
  assert.deepStrictEqual(info.segments, [
    { type: 'common', text: 'one\n' },
    { type: 'conflict', ours: 'two main\n', base: 'two\n', theirs: 'TWO topic\n', hasBase: true },
    { type: 'common', text: 'three\n' }]);
  const del = await M.conflictInfo(root, path.join(root, 'gone.txt'));
  assert.deepStrictEqual([del.oursExists, del.theirsExists, del.segments], [false, true, null]);

  assert.ok((await M.resolve(root, 'a.txt', 'content', 'one\ntwo main\nTWO topic\nthree\n')).ok);
  assert.ok((await M.resolve(root, 'gone.txt', 'delete')).ok);
  assert.strictEqual(parseStatus(g('status', '--porcelain=v1', '-b', '-z')).conflicts.length, 0);
  assert.ok((await M.control(root, 'continue')).ok);
  assert.strictEqual(await M.operationState(root), null);
  assert.match(g('log', '-1', '--format=%s %p'), /^Merge branch 'topic' \w+ \w+/);
  assert.ok(!fs.existsSync(path.join(root, 'gone.txt')));

  // abort
  g('checkout', '-qb', 'other', 'HEAD~1'); w('a.txt', 'clash\n'); g('commit', '-qam', 'clash'); g('checkout', '-q', 'main');
  g('merge', 'other');
  assert.strictEqual((await M.operationState(root)).kind, 'merge');
  assert.ok((await M.control(root, 'abort')).ok);
  assert.strictEqual(await M.operationState(root), null);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo main\nTWO topic\nthree\n');

  // stashes
  w('a.txt', 'stashed edit\n'); w('new.txt', 'untracked\n');
  assert.ok((await M.stash(root, 'push', { untracked: true, message: 'my work' })).ok);
  let list = await M.stashList(root);
  assert.deepStrictEqual(list.map((s) => [s.ref, s.branch, s.message]), [['stash@{0}', 'main', 'my work']]);
  const files = await M.stashFiles(root, 'stash@{0}');
  assert.deepStrictEqual(files.map((f) => `${f.status} ${f.path}`), ['M a.txt', 'U new.txt']);
  assert.deepStrictEqual(await M.stashFile(root, 'stash@{0}', 'a.txt'), { before: 'one\ntwo main\nTWO topic\nthree\n', after: 'stashed edit\n' });
  assert.strictEqual((await M.stashFile(root, 'stash@{0}', 'new.txt', true)).after, 'untracked\n');
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
  assert.ok((await M.stash(root, 'pop', { ref: 'stash@{0}' })).ok);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'stashed edit\n');
  assert.ok(fs.existsSync(path.join(root, 'new.txt')));
  list = await M.stashList(root);
  assert.strictEqual(list.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
