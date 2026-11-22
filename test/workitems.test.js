'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const W = require('../main/workitems');
const P = require('../main/pullrequests');
const { startForge } = require('./mock-forge');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const env = { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' };

test('helpers: HTML to text, branch names, #mentions', () => {
  assert.strictEqual(W.htmlToText('<div>Steps:</div><ol><li>Open <b>login</b></li><li>Click</li></ol><p>See <a href="https://x.com/a">docs</a>&nbsp;&amp; more</p><script>alert(1)</script>'),
    'Steps:\n\n- Open **login**\n- Click\nSee [docs](https://x.com/a) & more');
  assert.strictEqual(W.htmlToText('<img src=x onerror=alert(1)>Hi'), 'Hi');
  assert.strictEqual(W.textToHtml('a <b>\nb\n\nc'), '<div>a &lt;b&gt;<br>b</div><div>c</div>');
  assert.strictEqual(W.branchName({ id: 12, title: 'Login fails with "é" characters & spaces!' }), 'feature/12-login-fails-with-e-characters-spaces');
  assert.strictEqual(W.branchName({ id: 7, title: '' }, 'bugfix'), 'bugfix/7');
  assert.deepStrictEqual(W.mentionedIds('Fixes #12, see #7 and AB#300; not a#5 or &#39; or url/#9'), [12, 7, 300]);
});

function makeRepo(dir, url) {
  const bare = path.join(dir, 'server.git'), work = path.join(dir, 'work');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env }).toString().trim();
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g(work, 'init', '-q', '-b', 'main'); g(work, 'config', `url.${bare}.insteadOf`, url); g(work, 'remote', 'add', 'origin', url);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'first'); g(work, 'push', '-q', 'origin', 'main');
  return { bare, work, g: (...a) => g(work, ...a) };
}

test('GitHub Issues: queries skip pull requests, details, create, state, assign, comment', { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novawi-'));
  const { bare, work } = makeRepo(dir, 'https://github.com/acme/shop.git');
  const forge = await startForge({ github: { owner: 'acme', repo: 'shop', bare } });
  try {
    const info = await P.remoteInfo(work);
    const svc = W.githubItems(info, 'good-token', { githubApiUrl: forge.githubApiUrl });
    forge.ghCreateIssue({ title: 'Login fails', body: 'Steps…', assignees: ['alice'], labels: ['bug'] });
    forge.ghCreateIssue({ title: 'Add dark mode', author: 'bob', body: 'cc @alice' });
    execFileSync('git', ['-C', work, 'checkout', '-qb', 'f'], { env }); fs.writeFileSync(path.join(work, 'b.txt'), 'b'); execFileSync('git', ['-C', work, 'add', '.'], { env }); execFileSync('git', ['-C', work, 'commit', '-qm', 'b'], { env }); execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'f'], { env });
    forge.ghCreate({ title: 'A pull request', head: 'f', base: 'main' });
    assert.deepStrictEqual((await svc.list({ query: 'mine' })).map((i) => `#${i.id} ${i.title}`), ['#1 Login fails']);
    assert.deepStrictEqual((await svc.list({ query: 'open' })).map((i) => i.id), [2, 1]); // #3 is a pull request
    assert.deepStrictEqual((await svc.list({ query: 'mentioned' })).map((i) => i.id), [2]);
    assert.deepStrictEqual((await svc.list({ query: 'created' })).map((i) => i.id), [1]);
    assert.deepStrictEqual((await svc.list({ query: 'open', text: 'dark' })).map((i) => i.id), [2]);
    await assert.rejects(svc.get(3), /is a pull request/);
    forge.state.gh.timeline[1] = [{ event: 'cross-referenced', source: { issue: { number: 3, title: 'A pull request', state: 'open', html_url: 'u', pull_request: {} } } }];
    const it = await svc.get(1);
    assert.deepStrictEqual([it.type, it.state, it.category, it.assignees, it.labels.map((l) => l.name), it.links.map((l) => `${l.kind}:${l.id}`), it.states], ['Issue', 'Open', 'open', ['alice'], ['bug'], ['pr:3'], ['Closed', 'Closed (not planned)']]);
    const created = await svc.create({ title: 'New one', body: 'text', assignToMe: true, labels: ['ui'] });
    assert.deepStrictEqual([created.id, created.assignees, created.labels.map((l) => l.name)], [4, ['alice'], ['ui']]);
    await svc.comment(4, 'Working on it');
    assert.deepStrictEqual((await svc.get(4)).commentList.map((c) => `${c.author}: ${c.body}`), ['alice: Working on it']);
    await svc.assignToMe(2);
    assert.deepStrictEqual((await svc.list({ query: 'mine' })).map((i) => i.id).sort(), [1, 2, 4]);
    const closed = await svc.setState(2, 'Closed (not planned)');
    assert.deepStrictEqual([closed.state, closed.category], ['Closed (not planned)', 'closed']);
    assert.deepStrictEqual((await svc.list({ query: 'closed' })).map((i) => i.id), [2]);
    assert.strictEqual((await svc.setState(2, 'Open')).state, 'Open');
    assert.strictEqual(svc.commitText(1, true), 'Fixes #1');
  } finally { await forge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Azure Boards: WIQL queries, types/states, create, state, assign, comments, branch link', { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaab-'));
  const { bare, work, g } = makeRepo(dir, 'https://dev.azure.com/contoso/Shop/_git/shop');
  const forge = await startForge({ azure: { org: 'contoso', project: 'Shop', repo: 'shop', bare } });
  try {
    const info = await P.remoteInfo(work);
    const svc = W.azureItems(info, 'good-token', { azureDevOpsUrl: forge.azureDevOpsUrl });
    forge.azCreateItem({ type: 'Bug', title: 'Crash on checkout', assignedTo: 'Alice Smith', description: '<div>It <b>crashes</b></div>', state: 'Active' });
    forge.azCreateItem({ type: 'User Story', title: 'Wishlist', createdBy: 'Bob' });
    forge.azCreateItem({ type: 'Task', title: 'Old task', assignedTo: 'Alice Smith', state: 'Done' });
    assert.deepStrictEqual((await svc.list({ query: 'mine' })).map((i) => `${i.id} ${i.type} ${i.state}`), ['500 Bug Active']);
    assert.deepStrictEqual((await svc.list({ query: 'open' })).map((i) => i.id).sort(), [500, 501]);
    assert.deepStrictEqual((await svc.list({ query: 'closed' })).map((i) => i.id), [502]);
    assert.deepStrictEqual((await svc.list({ query: 'open', text: 'wish' })).map((i) => i.id), [501]);
    assert.deepStrictEqual((await svc.list({ query: 'open', text: '#500' })).map((i) => i.id), [500]);
    assert.deepStrictEqual(await svc.types(), ['Bug', 'Task', 'User Story']);
    const bug = await svc.get(500);
    assert.deepStrictEqual([bug.body, bug.states, bug.category], ['It **crashes**', ['New', 'Resolved', 'Closed'], 'open']);
    const t = await svc.create({ type: 'Task', title: 'Write tests', body: 'unit + e2e', assignToMe: true, labels: ['qa'] });
    assert.deepStrictEqual([t.id, t.type, t.state, t.assignees, t.labels.map((l) => l.name), t.body], [503, 'Task', 'To Do', ['Alice Smith'], ['qa'], 'unit + e2e']);
    await assert.rejects(svc.setState(503, 'Active'), /InvalidListValue/);
    const done = await svc.setState(503, 'Done');
    assert.deepStrictEqual([done.state], ['Done']);
    await svc.assignToMe(501);
    await svc.comment(501, 'On it\nsoon');
    const story = await svc.get(501);
    assert.deepStrictEqual([story.assignees, story.commentList.map((c) => c.body)], [['Alice Smith'], ['On it\nsoon']]);
    // branch for a work item, linked in Azure Boards
    const name = W.branchName(bug);
    const r = await W.createBranch(work, svc, null, bug, { name, base: 'main', checkout: true });
    assert.ok(r.ok && r.linked, JSON.stringify(r));
    assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD'), 'feature/500-crash-on-checkout');
    const linked = await svc.get(500);
    assert.deepStrictEqual(linked.links, [{ kind: 'branch', id: 'feature/500-crash-on-checkout', title: 'feature/500-crash-on-checkout' }]);
    const again = await W.createBranch(work, svc, null, bug, { name, base: 'main', checkout: false });
    assert.match(again.stderr, /already exists/);
  } finally { await forge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
