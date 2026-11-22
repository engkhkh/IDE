'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../main/pullrequests');
const { startForge } = require('./mock-forge');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const env = { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' };

test('parseRemote: GitHub, GitHub Enterprise, Azure DevOps url styles', () => {
  assert.deepStrictEqual(P.parseRemote('https://github.com/acme/shop.git'), { provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' });
  assert.deepStrictEqual(P.parseRemote('git@github.com:acme/shop.git'), { provider: 'github', host: 'github.com', owner: 'acme', repo: 'shop' });
  assert.strictEqual(P.parseRemote('ssh://git@ghe.corp.com/acme/shop').host, 'ghe.corp.com');
  for (const u of ['https://dev.azure.com/org/Proj/_git/repo', 'https://org@dev.azure.com/org/Proj/_git/repo', 'git@ssh.dev.azure.com:v3/org/Proj/repo', 'https://org.visualstudio.com/Proj/_git/repo']) {
    assert.deepStrictEqual(P.parseRemote(u), { provider: 'azure', host: 'dev.azure.com', org: 'org', project: 'Proj', repo: 'repo' }, u);
  }
  assert.strictEqual(P.parseRemote('https://dev.azure.com/org/My%20Project/_git/repo').project, 'My Project');
  assert.strictEqual(P.parseRemote('/some/local/path'), null);
});

// a bare "server" repo + a clone whose origin is a github.com / dev.azure.com URL (mapped to the bare repo)
function makeRepos(dir, url) {
  const bare = path.join(dir, 'server.git');
  const work = path.join(dir, 'work');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env }).toString().trim();
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', `url.${bare}.insteadOf`, url);
  g(work, 'remote', 'add', 'origin', url);
  fs.writeFileSync(path.join(work, 'app.txt'), 'one\ntwo\n');
  g(work, 'add', '.'); g(work, 'commit', '-qm', 'first'); g(work, 'push', '-q', 'origin', 'main');
  g(work, 'checkout', '-qb', 'feature/login');
  fs.writeFileSync(path.join(work, 'app.txt'), 'one\ntwo\nlogin\n'); fs.writeFileSync(path.join(work, 'login.txt'), 'login\n');
  g(work, 'add', '.'); g(work, 'commit', '-qm', 'Add login'); g(work, 'push', '-q', '-u', 'origin', 'feature/login');
  g(work, 'checkout', '-qb', 'contrib'); fs.writeFileSync(path.join(work, 'contrib.txt'), 'c\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'Contribution'); g(work, 'push', '-q', 'origin', 'contrib');
  g(work, 'checkout', '-q', 'main'); g(work, 'branch', '-qD', 'feature/login', 'contrib');
  return { bare, work, g: (...a) => g(work, ...a) };
}

test('GitHub: list, details, files, conversation, review, checkout, merge, close', { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapr-'));
  const { bare, work, g } = makeRepos(dir, 'https://github.com/acme/shop.git');
  const forge = await startForge({ github: { owner: 'acme', repo: 'shop', bare } });
  try {
    const info = await P.remoteInfo(work);
    assert.deepStrictEqual([info.provider, info.owner, info.repo], ['github', 'acme', 'shop']);
    const svc = P.github(info, 'good-token', { githubApiUrl: forge.githubApiUrl });
    const bad = P.github(info, 'nope', { githubApiUrl: forge.githubApiUrl });
    await assert.rejects(bad.list(), /Not signed in/);
    assert.strictEqual((await svc.me()).name, 'alice');
    const created = await svc.create({ base: 'main', head: 'feature/login', title: 'Add login', body: 'Adds **login**', draft: false });
    assert.strictEqual(created.number, 1);
    forge.ghCreate({ title: 'Contribution', head: 'contrib', base: 'main', author: 'bob', fork: 'bob/shop' });
    await assert.rejects(svc.create({ base: 'main', head: 'feature/login', title: 'again' }), /already exists/);
    const list = await svc.list({ state: 'open' });
    assert.deepStrictEqual(list.map((p) => `${p.number}:${p.title}:${p.author.name}:${p.sameRepo}`), ['2:Contribution:bob:false', '1:Add login:alice:true']);
    forge.state.gh.statuses[created.head.sha] = [{ context: 'ci/build', state: 'success', description: 'Build passed' }];
    forge.state.gh.runs[created.head.sha] = [{ name: 'tests', status: 'completed', conclusion: 'failure', html_url: 'x' }];
    let pr = await svc.get(1);
    assert.deepStrictEqual([pr.checks.state, pr.checks.items.map((i) => `${i.name}=${i.state}`).join()], ['failure', 'ci/build=success,tests=failure']);
    const c = await P.fetchPr(work, svc, info, pr);
    assert.strictEqual(c.head, created.head.sha);
    const fl = await P.files(work, svc, info, pr);
    assert.deepStrictEqual(fl.files.map((x) => `${x.status} ${x.path} +${x.added} -${x.deleted}`), ['M app.txt +1 -0', 'A login.txt +1 -0']);
    // checkout: same-repo branch tracks origin; a fork gets pr/<n>
    const co = await P.checkout(work, svc, info, pr);
    assert.ok(co.ok, co.stderr);
    assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD'), 'feature/login');
    assert.strictEqual(g('rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/login');
    const co2 = await P.checkout(work, svc, info, await svc.get(2));
    assert.ok(co2.ok, co2.stderr);
    assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD'), 'pr/2');
    assert.ok(fs.existsSync(path.join(work, 'contrib.txt')));
    g('checkout', '-q', 'feature/login');
    const ci = await P.createInfo(work, svc, info);
    assert.deepStrictEqual([ci.branch, ci.target, ci.pushed, ci.ahead, ci.title], ['feature/login', 'main', true, 1, 'Add login']);
    g('checkout', '-q', 'main');
    // conversation + review
    await svc.comment(1, 'Looks good');
    await svc.review(1, 'approve', 'Ship it');
    pr = await svc.get(1);
    assert.deepStrictEqual(pr.reviewers, [{ name: 'alice', state: 'approved' }]);
    const conv = await svc.conversation(1);
    assert.deepStrictEqual(conv.map((x) => `${x.kind}:${x.body}`), ['comment:Looks good', 'review:Ship it']);
    assert.deepStrictEqual((await svc.commits(1)).map((x) => x.message), ['Add login']);
    // merge for real (in the bare repo) and see main move
    await svc.merge(1, 'squash', pr);
    assert.strictEqual((await svc.get(1)).state, 'merged');
    assert.match(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: bare }).toString(), /^Add login \(#1\)/);
    await svc.setState(2, 'closed');
    assert.deepStrictEqual((await svc.list({ state: 'open' })).length, 0);
    assert.deepStrictEqual((await svc.list({ state: 'merged' })).map((p) => p.number), [1]);
    g('fetch', '-q', 'origin');
  } finally { await forge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Azure DevOps: create, list, details, threads, vote, complete', { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaaz-'));
  const { bare, work } = makeRepos(dir, 'https://dev.azure.com/contoso/Shop/_git/shop');
  const forge = await startForge({ azure: { org: 'contoso', project: 'Shop', repo: 'shop', bare } });
  try {
    const info = await P.remoteInfo(work);
    assert.deepStrictEqual([info.provider, info.org, info.project, info.repo], ['azure', 'contoso', 'Shop', 'shop']);
    const svc = P.azure(info, 'good-token', { azureDevOpsUrl: forge.azureDevOpsUrl });
    await assert.rejects(P.azure(info, 'bad', { azureDevOpsUrl: forge.azureDevOpsUrl }).list(), /Not signed in/);
    assert.strictEqual((await svc.me()).name, 'Alice Smith');
    assert.strictEqual((await svc.repoInfo()).defaultBranch, 'main');
    const pr = await svc.create({ base: 'main', head: 'feature/login', title: 'Login', body: 'desc', draft: true });
    assert.deepStrictEqual([pr.number, pr.state, pr.draft, pr.head.ref, pr.base.ref], [100, 'open', true, 'feature/login', 'main']);
    forge.state.az.statuses[100] = [{ state: 'succeeded', description: 'CI', context: { name: 'build', genre: 'ci' } }];
    const got = await svc.get(100);
    assert.strictEqual(got.checks.state, 'success');
    await svc.review(100, 'approve', 'Nice');
    const again = await svc.get(100);
    assert.deepStrictEqual(again.reviewers.map((r) => `${r.name}:${r.state}`), ['Alice Smith:approved']);
    assert.deepStrictEqual((await svc.conversation(100)).map((x) => x.body), ['Nice']);
    assert.deepStrictEqual((await svc.commits(100)).map((x) => x.message), ['Add login']);
    await svc.merge(100, 'merge', again);
    assert.strictEqual((await svc.get(100)).state, 'merged');
    assert.match(execFileSync('git', ['log', '-1', '--format=%s %p', 'main'], { cwd: bare }).toString(), /^Merged PR 100: Login \w+ \w+/);
    assert.deepStrictEqual((await svc.list({ state: 'merged' })).map((p) => p.number), [100]);
  } finally { await forge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
