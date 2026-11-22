'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('../main/githistory');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

test('parseRefs: HEAD, current branch, tags, remotes', () => {
  assert.deepStrictEqual(H.parseRefs('HEAD -> main, origin/main, origin/HEAD, tag: v1.0'), [
    { type: 'head', name: 'HEAD' }, { type: 'branch', name: 'main', current: true }, { type: 'branch', name: 'origin/main' }, { type: 'tag', name: 'v1.0' }]);
  assert.deepStrictEqual(H.parseRefs('HEAD'), [{ type: 'head', name: 'HEAD', detached: true }]);
  assert.deepStrictEqual(H.parseRefs(''), []);
});

test('layoutGraph: a branch that is merged back', () => {
  // M (merge of B into A) <- A <- base ; B <- base
  const commits = [
    { hash: 'm', parents: ['a', 'b'] },
    { hash: 'b', parents: ['base'] },
    { hash: 'a', parents: ['base'] },
    { hash: 'base', parents: [] }
  ];
  const { rows, state } = H.layoutGraph(commits);
  assert.deepStrictEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  // merge: dot -> lane 0 (first parent) and dot -> lane 1 (second parent)
  assert.deepStrictEqual(rows[0].segs, [[0, 1, 0, 2, 0], [0, 1, 1, 2, 1]]);
  // b: lane 0 passes, lane 1 comes in and goes on (to base)
  assert.deepStrictEqual(rows[1].segs, [[0, 0, 0, 2, 0], [1, 0, 1, 1, 1], [1, 1, 1, 2, 1]]);
  // base: both lanes converge into the root commit, no line below
  assert.deepStrictEqual(rows[3].segs, [[0, 0, 0, 1, 0], [1, 0, 0, 1, 1]]);
  assert.strictEqual(rows[1].color !== rows[0].color, true);
  assert.deepStrictEqual(state.lanes, []);
});

test('layoutGraph: paging keeps the lanes', () => {
  const all = [{ hash: '3', parents: ['2'] }, { hash: 'x', parents: ['1'] }, { hash: '2', parents: ['1'] }, { hash: '1', parents: [] }];
  const one = H.layoutGraph(all);
  const p1 = H.layoutGraph(all.slice(0, 2));
  const p2 = H.layoutGraph(all.slice(2), p1.state);
  assert.deepStrictEqual([...p1.rows, ...p2.rows], one.rows);
});

test('parsers: log records, name-status, numstat, blame', () => {
  const RS = '\x1e', US = '\x1f';
  const out = `${RS}${'a'.repeat(40)}${US}${'b'.repeat(40)}${US}Ann${US}ann@x${US}1700000000${US}HEAD -> main${US}Fix: a${US}b\n\nR087\tsrc/Old.cs\tsrc/New.cs\n`;
  const [c] = H.parseLog(out, { withFiles: true });
  assert.strictEqual(c.subject, `Fix: a${US}b`);
  assert.deepStrictEqual(c.parents, ['b'.repeat(40)]);
  assert.deepStrictEqual(c.file, { status: 'R', path: 'src/New.cs', from: 'src/Old.cs' });
  assert.deepStrictEqual(H.parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0'), [
    { status: 'M', path: 'a.txt' }, { status: 'R', from: 'old.txt', path: 'new.txt' }, { status: 'D', path: 'gone.txt' }]);
  const ns = H.parseNumstat('3\t1\ta.txt\0' + '0\t0\t\0old.txt\0new.txt\0' + '-\t-\timg.png\0');
  assert.deepStrictEqual([...ns], [['a.txt', { added: 3, deleted: 1 }], ['new.txt', { added: 0, deleted: 0 }], ['img.png', { added: null, deleted: null }]]);
  const h1 = '1'.repeat(40), h0 = '0'.repeat(40);
  const b = H.parseBlame(`${h1} 1 1 2\nauthor Ann\nauthor-mail <ann@x>\nauthor-time 1700000000\nsummary First\nfilename a.txt\n\tline1\n${h1} 2 2\n\tline2\n${h0} 3 3 1\nauthor Not Committed Yet\nsummary Version of a.txt from a.txt\nfilename a.txt\n\tnew\n`);
  assert.deepStrictEqual(b.lines, [h1, h1, h0]);
  assert.strictEqual(b.commits[h1].email, 'ann@x');
  assert.strictEqual(b.commits[h0].uncommitted, true);
});

test('real repository: history, search, file history across a rename, details, blame, operations', { skip: !hasGit }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novagit-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' } }).toString();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'first');
  g('checkout', '-qb', 'topic'); fs.writeFileSync(path.join(root, 'b.txt'), 'b\n'); g('add', '.'); g('commit', '-qm', 'topic work');
  g('checkout', '-q', 'main'); g('mv', 'a.txt', 'c.txt'); g('commit', '-qm', 'rename a to c');
  fs.appendFileSync(path.join(root, 'c.txt'), 'two\n'); g('commit', '-qam', 'second line');
  g('merge', '-q', '--no-ff', 'topic', '-m', 'merge topic');

  const r = await H.history(root, {});
  const by = (subj) => r.commits.find((c) => c.subject === subj);
  assert.deepStrictEqual(r.commits.map((c) => c.subject).sort(), ['first', 'merge topic', 'rename a to c', 'second line', 'topic work']);
  assert.strictEqual(r.commits[0].subject, 'merge topic'); // children always before parents
  assert.strictEqual(r.commits[4].subject, 'first');
  assert.strictEqual(r.rows.length, 5);
  assert.ok(by('merge topic').refs.some((x) => x.type === 'branch' && x.name === 'main' && x.current));
  assert.ok(by('topic work').refs.some((x) => x.type === 'branch' && x.name === 'topic'));
  const s = await H.history(root, { search: 'TOPIC' });
  assert.deepStrictEqual(s.commits.map((c) => c.subject), ['merge topic', 'topic work']);
  const f = await H.history(root, { file: path.join(root, 'c.txt') });
  assert.deepStrictEqual(f.commits.map((c) => `${c.subject}:${c.file.status}`), ['second line:M', 'rename a to c:R', 'first:A']);
  const d = await H.details(root, by('rename a to c').hash);
  assert.deepStrictEqual(d.files.map((x) => `${x.status} ${x.from}->${x.path}`), ['R a.txt->c.txt']);
  const first = await H.details(root, by('first').hash);
  assert.deepStrictEqual(first.files, [{ status: 'A', path: 'a.txt', added: 1, deleted: 0 }]);
  assert.strictEqual((await H.fileAt(root, by('first').hash, 'a.txt')).text, 'one\n');
  const b = await H.blame(root, path.join(root, 'c.txt'), 'one\ntwo\nthree\n');
  assert.deepStrictEqual(b.lines.map((h) => b.commits[h].summary), ['first', 'second line', 'Not committed yet']);
  assert.ok((await H.op(root, 'tag', { name: 'v1', at: by('second line').hash })).ok);
  assert.ok((await H.op(root, 'branch', { name: 'fix', at: by('first').hash, checkout: true })).ok);
  assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix');
  const refs = await H.refs(root);
  assert.deepStrictEqual(refs.local.map((x) => `${x.name}${x.current ? '*' : ''}`), ['fix*', 'main', 'topic']);
  assert.deepStrictEqual(refs.tags.map((x) => x.name), ['v1']);
  fs.rmSync(root, { recursive: true, force: true });
});
