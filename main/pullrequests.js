// Nova IDE - pull requests for GitHub (and GitHub Enterprise) and Azure DevOps
// One shape for both: list / get / files / commits / conversation / create / review / merge / close / checkout.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { git } = require('./git');
const H = require('./githistory');

let app = null;
let readSettings = async () => ({});
// Electron's net.fetch uses the system proxy; plain Node (unit tests) has fetch built in
const doFetch = (...a) => {
  let net = null;
  try { const e = require('electron'); net = e && typeof e === 'object' && e.net ? e.net : null; } catch {}
  return (net ? net.fetch : globalThis.fetch)(...a);
};

// ---------------- remotes ----------------
// https://github.com/acme/shop(.git) · git@github.com:acme/shop.git · ssh://git@ghe.corp.com/acme/shop
// https://dev.azure.com/org/Project/_git/repo · https://org@dev.azure.com/org/Project/_git/repo
// git@ssh.dev.azure.com:v3/org/Project/repo · https://org.visualstudio.com/Project/_git/repo
function parseRemote(url) {
  if (!url) return null;
  const u = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  let m = /^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azure', host: 'dev.azure.com', org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  m = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azure', host: 'dev.azure.com', org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  m = /^(?:https?:\/\/)?(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azure', host: 'dev.azure.com', org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  m = /^(?:https?:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/i.exec(u) || /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/]([^/]+)\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'github', host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
  return null;
}
async function remoteInfo(root, remote = 'origin') {
  // the configured URL (not the insteadOf-rewritten one): that is what names the service
  const r = await git(root, ['config', '--get', `remote.${remote}.url`]);
  if (!r.ok) {
    const list = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean);
    if (remote === 'origin' && list.length) return remoteInfo(root, list[0]);
    return { error: 'This repository has no remote. Publish it to GitHub or Azure DevOps first.' };
  }
  const info = parseRemote(r.stdout.trim());
  if (!info) return { error: `Pull requests need a GitHub or Azure DevOps remote (${remote} is ${r.stdout.trim()}).` };
  return { ...info, remote, url: r.stdout.trim() };
}

// ---------------- accounts (tokens) ----------------
const accountsFile = () => path.join(app ? app.getPath('userData') : require('os').tmpdir(), 'accounts.json');
function safe() { try { const { safeStorage } = require('electron'); return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null; } catch { return null; } }
async function readAccounts() { try { return JSON.parse(await fsp.readFile(accountsFile(), 'utf8')); } catch { return {}; } }
async function saveToken(provider, host, token, user) {
  const all = await readAccounts();
  const key = `${provider}|${host}`;
  if (!token) delete all[key];
  else {
    const s = safe();
    // Windows: DPAPI through Electron's safeStorage; without it (some Linux setups) only obfuscated
    all[key] = s ? { enc: 'safe', data: s.encryptString(token).toString('base64'), user } : { enc: 'b64', data: Buffer.from(token).toString('base64'), user };
  }
  await fsp.mkdir(path.dirname(accountsFile()), { recursive: true });
  await fsp.writeFile(accountsFile(), JSON.stringify(all, null, 2));
  return true;
}
function ghCliToken(host) {
  return new Promise((resolve) => execFile('gh', ['auth', 'token', '--hostname', host], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim() || null)));
}
async function tokenFor(provider, host) {
  const a = (await readAccounts())[`${provider}|${host}`];
  if (a) {
    try {
      if (a.enc === 'safe') { const s = safe(); if (s) return { token: s.decryptString(Buffer.from(a.data, 'base64')), source: 'Nova IDE', user: a.user }; }
      if (a.enc === 'b64') return { token: Buffer.from(a.data, 'base64').toString(), source: 'Nova IDE', user: a.user };
    } catch {}
  }
  if (provider === 'github') {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return { token: env, source: 'GITHUB_TOKEN' };
    const cli = await ghCliToken(host);
    if (cli) return { token: cli, source: 'GitHub CLI' };
  }
  if (provider === 'azure' && process.env.AZURE_DEVOPS_EXT_PAT) return { token: process.env.AZURE_DEVOPS_EXT_PAT, source: 'AZURE_DEVOPS_EXT_PAT' };
  return null;
}

// ---------------- HTTP ----------------
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function http(method, url, { headers = {}, body, contentType = 'application/json' } = {}) {
  let res;
  try {
    res = await doFetch(url, { method, headers: { 'User-Agent': 'NovaIDE', ...headers, ...(body !== undefined ? { 'Content-Type': contentType } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) { throw new ApiError(`Could not reach ${new URL(url).host}: ${e.message}`, 0); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    // GitHub puts the reason in errors[] ("Validation Failed: A pull request already exists for ...")
    const details = data && Array.isArray(data.errors) ? data.errors.map((e) => e.message || [e.field, e.code].filter(Boolean).join(' ')).filter(Boolean).join('; ') : '';
    const msg = [data && data.message, details].filter(Boolean).join(': ') || (typeof data === 'string' ? data.slice(0, 200) : '') || res.statusText;
    if (res.status === 401) throw new ApiError('Not signed in, or the token is no longer valid. Add a token in Git > Accounts.', 401);
    if (res.status === 403 && /rate limit/i.test(msg)) throw new ApiError('GitHub rate limit reached. Add a token in Git > Accounts.', 403);
    throw new ApiError(`${res.status} ${msg}`, res.status);
  }
  return data;
}

// ---------------- GitHub ----------------
function github(info, token, settings) {
  const api = (settings.githubApiUrl || (info.host === 'github.com' ? 'https://api.github.com' : `https://${info.host}/api/v3`)).replace(/\/$/, '');
  const web = info.host === 'github.com' || !settings.githubApiUrl ? `https://${info.host}` : api.replace(/\/api\/v3$/, '');
  const repo = `${api}/repos/${info.owner}/${info.repo}`;
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = (u) => http('GET', u, { headers: h });
  const send = (m, u, body) => http(m, u, { headers: h, body });
  const norm = (p) => ({
    id: p.number, number: p.number, title: p.title, body: p.body || '', url: p.html_url,
    state: p.merged_at || p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: !!p.draft,
    author: { name: p.user ? p.user.login : '?', login: p.user ? p.user.login : '' },
    created: p.created_at, updated: p.updated_at,
    head: { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo ? p.head.repo.full_name : null },
    base: { ref: p.base.ref, sha: p.base.sha },
    sameRepo: !!p.head.repo && p.head.repo.full_name.toLowerCase() === `${info.owner}/${info.repo}`.toLowerCase(),
    labels: (p.labels || []).map((l) => ({ name: l.name, color: l.color ? `#${l.color}` : null })),
    reviewers: (p.requested_reviewers || []).map((r) => ({ name: r.login, state: 'pending' })),
    mergeable: p.mergeable, mergeableState: p.mergeable_state, comments: (p.comments || 0) + (p.review_comments || 0)
  });
  return {
    provider: 'github', label: info.host === 'github.com' ? 'GitHub' : `GitHub (${info.host})`, web,
    async me() { const u = await get(`${api}/user`); return { name: u.login }; },
    async repoInfo() { const r = await get(repo); return { defaultBranch: r.default_branch, url: r.html_url }; },
    async list({ state = 'open', head } = {}) {
      const st = state === 'merged' ? 'closed' : state;
      const q = `state=${st}&per_page=50&sort=updated&direction=desc${head ? `&head=${encodeURIComponent(`${info.owner}:${head}`)}` : ''}`;
      let list = (await get(`${repo}/pulls?${q}`)).map(norm);
      if (state === 'merged') list = list.filter((p) => p.state === 'merged');
      return list;
    },
    async get(n) {
      const p = norm(await get(`${repo}/pulls/${n}`));
      const [reviews, status, runs] = await Promise.all([
        get(`${repo}/pulls/${n}/reviews?per_page=100`).catch(() => []),
        get(`${repo}/commits/${p.head.sha}/status`).catch(() => null),
        get(`${repo}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => null)
      ]);
      // latest review of each person decides their state; requested reviewers who have not answered are pending
      const byUser = new Map(p.reviewers.map((r) => [r.name, r]));
      for (const r of reviews) {
        const state = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'pending' }[r.state] || 'pending';
        const cur = byUser.get(r.user.login);
        if (!cur || state !== 'commented' || cur.state === 'pending') byUser.set(r.user.login, { name: r.user.login, state });
      }
      p.reviewers = [...byUser.values()];
      const items = [
        ...((status && status.statuses) || []).map((s) => ({ name: s.context, state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure', description: s.description || '', url: s.target_url })),
        ...((runs && runs.check_runs) || []).map((c) => ({ name: c.name, state: c.status !== 'completed' ? 'pending' : c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral' ? 'success' : 'failure', description: c.conclusion || c.status, url: c.html_url }))
      ];
      p.checks = { state: !items.length ? 'none' : items.some((i) => i.state === 'failure') ? 'failure' : items.some((i) => i.state === 'pending') ? 'pending' : 'success', items };
      return p;
    },
    async commits(n) { return (await get(`${repo}/pulls/${n}/commits?per_page=100`)).map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date })); },
    async conversation(n) {
      const [comments, reviews, review] = await Promise.all([
        get(`${api}/repos/${info.owner}/${info.repo}/issues/${n}/comments?per_page=100`),
        get(`${repo}/pulls/${n}/reviews?per_page=100`).catch(() => []),
        get(`${repo}/pulls/${n}/comments?per_page=100`).catch(() => [])
      ]);
      const items = [
        ...comments.map((c) => ({ kind: 'comment', author: c.user.login, body: c.body || '', date: c.created_at })),
        ...reviews.filter((r) => r.state !== 'PENDING').map((r) => ({ kind: 'review', author: r.user.login, state: { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }[r.state] || 'commented', body: r.body || '', date: r.submitted_at })),
        ...review.map((c) => ({ kind: 'code', author: c.user.login, body: c.body || '', date: c.created_at, path: c.path, line: c.line || c.original_line }))
      ];
      return items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    },
    async comment(n, body) { await send('POST', `${api}/repos/${info.owner}/${info.repo}/issues/${n}/comments`, { body }); return true; },
    async review(n, vote, body) {
      const event = { approve: 'APPROVE', reject: 'REQUEST_CHANGES', comment: 'COMMENT' }[vote];
      await send('POST', `${repo}/pulls/${n}/reviews`, { event, ...(body ? { body } : {}) });
      return true;
    },
    async create({ base, head, title, body, draft }) { return norm(await send('POST', `${repo}/pulls`, { base, head, title, body, draft: !!draft })); },
    async merge(n, method, pr) { const r = await send('PUT', `${repo}/pulls/${n}/merge`, { merge_method: method, sha: pr && pr.head.sha }); if (!r.merged) throw new ApiError(r.message || 'Not merged'); return true; },
    async setState(n, state) { await send('PATCH', `${repo}/pulls/${n}`, { state: state === 'open' ? 'open' : 'closed' }); return true; },
    // the commit ids git can fetch
    fetchRefs(pr) { return [`refs/pull/${pr.number}/head`, `refs/heads/${pr.base.ref}`]; },
    webUrl(pr) { return pr.url; },
    newPrUrl(base, head) { return `${web}/${info.owner}/${info.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`; }
  };
}

// ---------------- Azure DevOps ----------------
function azure(info, token, settings) {
  const root = (settings.azureDevOpsUrl || 'https://dev.azure.com').replace(/\/$/, '');
  const proj = `${root}/${encodeURIComponent(info.org)}/${encodeURIComponent(info.project)}`;
  const repo = `${proj}/_apis/git/repositories/${encodeURIComponent(info.repo)}`;
  const web = `${proj}/_git/${encodeURIComponent(info.repo)}`;
  const V = 'api-version=7.1';
  const h = { Accept: 'application/json', ...(token ? { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {}) };
  const get = (u) => http('GET', u, { headers: h });
  const send = (m, u, body) => http(m, u, { headers: h, body });
  const short = (r) => String(r || '').replace(/^refs\/heads\//, '');
  const VOTE = { 10: 'approved', 5: 'approved', 0: 'pending', '-5': 'changes', '-10': 'rejected' };
  const norm = (p) => ({
    id: p.pullRequestId, number: p.pullRequestId, title: p.title, body: p.description || '', url: `${web}/pullrequest/${p.pullRequestId}`,
    state: p.status === 'completed' ? 'merged' : p.status === 'abandoned' ? 'closed' : 'open', draft: !!p.isDraft,
    author: { name: p.createdBy ? p.createdBy.displayName : '?', login: p.createdBy ? p.createdBy.uniqueName : '' },
    created: p.creationDate, updated: p.closedDate || p.creationDate,
    head: { ref: short(p.sourceRefName), sha: p.lastMergeSourceCommit ? p.lastMergeSourceCommit.commitId : null },
    base: { ref: short(p.targetRefName), sha: p.lastMergeTargetCommit ? p.lastMergeTargetCommit.commitId : null },
    sameRepo: !p.forkSource,
    labels: (p.labels || []).map((l) => ({ name: l.name, color: null })),
    reviewers: (p.reviewers || []).map((r) => ({ name: r.displayName, state: VOTE[r.vote] || 'pending', id: r.id })),
    mergeable: p.mergeStatus ? p.mergeStatus === 'succeeded' : null, mergeableState: p.mergeStatus || '', comments: 0
  });
  let meCache = null;
  const me = async () => {
    if (!meCache) { const c = await get(`${root}/${encodeURIComponent(info.org)}/_apis/connectionData`); meCache = { id: c.authenticatedUser.id, name: c.authenticatedUser.providerDisplayName || c.authenticatedUser.customDisplayName || 'me' }; }
    return meCache;
  };
  return {
    provider: 'azure', label: 'Azure DevOps', web,
    me,
    async repoInfo() { const r = await get(`${repo}?${V}`); return { defaultBranch: short(r.defaultBranch), url: r.webUrl || web }; },
    async list({ state = 'open', head } = {}) {
      const st = { open: 'active', closed: 'abandoned', merged: 'completed', all: 'all' }[state] || 'active';
      const q = `searchCriteria.status=${st}${head ? `&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${head}`)}` : ''}&$top=50&${V}`;
      return ((await get(`${repo}/pullrequests?${q}`)).value || []).map(norm);
    },
    async get(n) {
      const p = norm(await get(`${repo}/pullrequests/${n}?${V}`));
      const st = await get(`${repo}/pullRequests/${n}/statuses?${V}`).catch(() => ({ value: [] }));
      const latest = new Map();
      for (const s of st.value || []) latest.set(`${s.context && s.context.genre}/${s.context && s.context.name}`, s);
      const items = [...latest.values()].map((s) => ({ name: s.context ? s.context.name : 'status', state: s.state === 'succeeded' ? 'success' : s.state === 'pending' || s.state === 'notSet' ? 'pending' : 'failure', description: s.description || '', url: s.targetUrl }));
      p.checks = { state: !items.length ? 'none' : items.some((i) => i.state === 'failure') ? 'failure' : items.some((i) => i.state === 'pending') ? 'pending' : 'success', items };
      return p;
    },
    async commits(n) { return ((await get(`${repo}/pullRequests/${n}/commits?${V}`)).value || []).map((c) => ({ sha: c.commitId, message: c.comment, author: c.author ? c.author.name : '', date: c.author ? c.author.date : '' })); },
    async conversation(n) {
      const threads = (await get(`${repo}/pullRequests/${n}/threads?${V}`)).value || [];
      const items = [];
      for (const t of threads) {
        if (t.isDeleted) continue;
        for (const c of t.comments || []) {
          if (c.isDeleted) continue;
          const system = c.commentType === 'system' || c.commentType === 3;
          items.push({ kind: system ? 'event' : t.threadContext && t.threadContext.filePath ? 'code' : 'comment', author: c.author ? c.author.displayName : '', body: c.content || '', date: c.publishedDate, path: t.threadContext && t.threadContext.filePath ? t.threadContext.filePath.replace(/^\//, '') : undefined, line: t.threadContext && t.threadContext.rightFileStart ? t.threadContext.rightFileStart.line : undefined });
        }
      }
      return items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    },
    async comment(n, body) { await send('POST', `${repo}/pullRequests/${n}/threads?${V}`, { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 }); return true; },
    async review(n, vote, body) {
      const m = await me();
      if (body) await this.comment(n, body);
      if (vote !== 'comment') await send('PUT', `${repo}/pullRequests/${n}/reviewers/${m.id}?${V}`, { vote: vote === 'approve' ? 10 : -5 });
      return true;
    },
    async create({ base, head, title, body, draft, workItems = [] }) { return norm(await send('POST', `${repo}/pullrequests?${V}`, { sourceRefName: `refs/heads/${head}`, targetRefName: `refs/heads/${base}`, title, description: body, isDraft: !!draft, ...(workItems.length ? { workItemRefs: workItems.map((id) => ({ id: String(id) })) } : {}) })); },
    async merge(n, method, pr) {
      const strategy = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' }[method] || 'noFastForward';
      const r = await send('PATCH', `${repo}/pullrequests/${n}?${V}`, { status: 'completed', lastMergeSourceCommit: { commitId: pr.head.sha }, completionOptions: { mergeStrategy: strategy, deleteSourceBranch: false } });
      if (r && r.status && r.status !== 'completed' && r.mergeStatus === 'conflicts') throw new ApiError('The pull request has merge conflicts.');
      return true;
    },
    async setState(n, state) { await send('PATCH', `${repo}/pullrequests/${n}?${V}`, { status: state === 'open' ? 'active' : 'abandoned' }); return true; },
    fetchRefs(pr) { return [`refs/heads/${pr.head.ref}`, `refs/heads/${pr.base.ref}`]; },
    webUrl(pr) { return pr.url; },
    newPrUrl(base, head) { return `${web}/pullrequestcreate?sourceRef=${encodeURIComponent(head)}&targetRef=${encodeURIComponent(base)}`; }
  };
}

// ---------------- service for a repository ----------------
async function service(root) {
  const info = await remoteInfo(root);
  if (info.error) return { error: info.error };
  const s = await readSettings();
  const auth = await tokenFor(info.provider, info.host);
  const svc = info.provider === 'github' ? github(info, auth && auth.token, s) : azure(info, auth && auth.token, s);
  return { info, svc, auth };
}
// what other services (work items) need: remote, token, settings
async function context(root) {
  const info = await remoteInfo(root);
  if (info.error) return { error: info.error };
  return { info, auth: await tokenFor(info.provider, info.host), settings: await readSettings() };
}
// run one call and turn errors into { error }
async function call(root, fn) {
  const r = await service(root);
  if (r.error) return { error: r.error, noRemote: true };
  try { return { result: await fn(r.svc, r), provider: r.svc.provider, label: r.svc.label, signedIn: !!r.auth }; } catch (e) {
    return { error: e.message, status: e.status, needsToken: e.status === 401 || (e.status === 403 && !r.auth) || (e.status === 404 && !r.auth), provider: r.svc.provider, label: r.svc.label };
  }
}

// fetch the commits of a pull request so diffs come from local git
async function fetchPr(root, svc, info, pr) {
  const refs = svc.fetchRefs(pr).map((r, i) => `+${r}:refs/nova/pr/${pr.number}/${i ? 'base' : 'head'}`);
  const f = await git(root, ['fetch', '--no-tags', info.remote, ...refs]);
  if (!f.ok) throw new Error(`git fetch failed: ${f.stderr.trim()}`);
  const head = (await git(root, ['rev-parse', `refs/nova/pr/${pr.number}/head`])).stdout.trim();
  const base = (await git(root, ['rev-parse', `refs/nova/pr/${pr.number}/base`])).stdout.trim();
  const mb = await git(root, ['merge-base', base, head]);
  return { head, base, mergeBase: mb.ok ? mb.stdout.trim() : base };
}
async function files(root, svc, info, pr) {
  const c = await fetchPr(root, svc, info, pr);
  const [ns, num] = await Promise.all([
    git(root, ['-c', 'core.quotePath=false', 'diff', '-M', '-z', '--name-status', c.mergeBase, c.head]),
    git(root, ['-c', 'core.quotePath=false', 'diff', '-M', '-z', '--numstat', c.mergeBase, c.head])
  ]);
  const stats = H.parseNumstat(num.stdout);
  return { ...c, files: H.parseNameStatus(ns.stdout).map((f) => ({ ...f, ...(stats.get(f.path) || {}) })) };
}

async function checkout(root, svc, info, pr) {
  await fetchPr(root, svc, info, pr);
  const exists = async (b) => (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).ok;
  if (pr.sameRepo) {
    // the branch itself, tracking the remote one
    const b = pr.head.ref;
    await git(root, ['fetch', '--no-tags', info.remote, `+refs/heads/${b}:refs/remotes/${info.remote}/${b}`]);
    if (await exists(b)) {
      const c = await git(root, ['checkout', b]);
      if (!c.ok) return c;
      const ff = await git(root, ['merge', '--ff-only', `${info.remote}/${b}`]);
      return { ok: true, branch: b, stdout: c.stdout + ff.stdout, stderr: c.stderr + (ff.ok ? '' : `\nYour local ${b} has commits that are not in the pull request; it was not updated.\n${ff.stderr}`) };
    }
    const c = await git(root, ['checkout', '-b', b, '--track', `${info.remote}/${b}`]);
    return { ...c, branch: b };
  }
  // a fork: a local branch pr/<n>
  const b = `pr/${pr.number}`;
  const c = (await exists(b)) ? await git(root, ['checkout', b]) : await git(root, ['checkout', '-b', b, `refs/nova/pr/${pr.number}/head`]);
  if (c.ok) await git(root, ['merge', '--ff-only', `refs/nova/pr/${pr.number}/head`]);
  return { ...c, branch: b };
}

// what the create dialog needs: branches, default target, pushed or not, suggested title/description
async function createInfo(root, svc, info) {
  const st = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = st.stdout.trim();
  const repo = await svc.repoInfo().catch(() => ({ defaultBranch: null }));
  const remoteBranches = (await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${info.remote}`])).stdout.split('\n').filter(Boolean).map((b) => b.slice(info.remote.length + 1)).filter((b) => b && b !== 'HEAD');
  const target = repo.defaultBranch || (remoteBranches.includes('main') ? 'main' : remoteBranches.includes('master') ? 'master' : remoteBranches[0] || 'main');
  const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).stdout.trim();
  const remoteHas = (await git(root, ['ls-remote', '--heads', info.remote, branch])).stdout.trim();
  const remoteSha = remoteHas.split(/\s+/)[0] || null;
  const localSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const log = await git(root, ['log', '--format=%s%x1f%b%x1e', `${info.remote}/${target}..HEAD`]);
  const commits = log.ok ? log.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => { const [s, b] = x.split('\x1f'); return { subject: s, body: (b || '').trim() }; }) : [];
  const title = commits.length === 1 ? commits[0].subject : branch.replace(/^(feature|bugfix|fix|users\/[^/]+)\//, '').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  let body = commits.length === 1 ? commits[0].body : commits.map((c) => `- ${c.subject}`).reverse().join('\n');
  // work items: "#12" in the commits, or a branch named like feature/12-something
  const ids = new Set();
  for (const c of commits) for (const m of `${c.subject}\n${c.body}`.matchAll(/(?:^|[^\w&/])(?:AB)?#(\d{1,7})\b/g)) ids.add(+m[1]);
  const bm = /(?:^|\/)(\d{1,7})(?:-|$)/.exec(branch);
  if (bm) ids.add(+bm[1]);
  const workItems = [...ids];
  if (workItems.length && !workItems.every((id) => new RegExp(`#${id}\\b`).test(body))) body = `${body ? `${body}\n\n` : ''}Related work items: ${workItems.map((i) => `#${i}`).join(', ')}`;
  return { workItems, branch, target, branches: remoteBranches, upstream, pushed: !!remoteSha && remoteSha === localSha, onRemote: !!remoteSha, ahead: commits.length, title, body };
}

module.exports = {
  parseRemote, remoteInfo, tokenFor, saveToken, github, azure, service, context, http, ApiError, fetchPr, files, checkout, createInfo,
  setReadSettings: (fn) => { readSettings = fn; },
  register({ ipcMain, app: a }) {
    app = a;
    readSettings = () => require('./settings').read();
    ipcMain.handle('pr:remote', async (_e, root) => {
      const info = await remoteInfo(root);
      if (info.error) return info;
      const auth = await tokenFor(info.provider, info.host);
      return { ...info, signedIn: !!auth, tokenSource: auth ? auth.source : null, user: auth ? auth.user : null };
    });
    ipcMain.handle('pr:list', (_e, root, opts) => call(root, (svc) => svc.list(opts || {})));
    ipcMain.handle('pr:get', (_e, root, n) => call(root, (svc) => svc.get(n)));
    ipcMain.handle('pr:commits', (_e, root, n) => call(root, (svc) => svc.commits(n)));
    ipcMain.handle('pr:conversation', (_e, root, n) => call(root, (svc) => svc.conversation(n)));
    ipcMain.handle('pr:files', (_e, root, pr) => call(root, (svc, r) => files(root, svc, r.info, pr)));
    ipcMain.handle('pr:comment', (_e, root, n, body) => call(root, (svc) => svc.comment(n, body)));
    ipcMain.handle('pr:review', (_e, root, n, vote, body) => call(root, (svc) => svc.review(n, vote, body)));
    ipcMain.handle('pr:merge', (_e, root, pr, method) => call(root, (svc) => svc.merge(pr.number, method, pr)));
    ipcMain.handle('pr:setState', (_e, root, n, state) => call(root, (svc) => svc.setState(n, state)));
    ipcMain.handle('pr:checkout', (_e, root, pr) => call(root, (svc, r) => checkout(root, svc, r.info, pr)));
    ipcMain.handle('pr:createInfo', (_e, root) => call(root, (svc, r) => createInfo(root, svc, r.info)));
    ipcMain.handle('pr:create', (_e, root, opts) => call(root, (svc) => svc.create(opts)));
    ipcMain.handle('pr:newPrUrl', (_e, root, base, head) => call(root, (svc) => svc.newPrUrl(base, head)));
    ipcMain.handle('pr:fileAt', async (_e, root, ref, file) => { const r = await git(root, ['show', `${ref}:${file}`]); return r.ok ? r.stdout : ''; });
    // accounts
    ipcMain.handle('pr:accounts', async () => {
      const all = await readAccounts();
      return Object.entries(all).map(([k, v]) => { const [provider, host] = k.split('|'); return { provider, host, user: v.user || '', encrypted: v.enc === 'safe' }; });
    });
    ipcMain.handle('pr:signIn', async (_e, provider, host, token, root) => {
      // check the token first: who is it?
      try {
        const s = await readSettings();
        let user;
        if (provider === 'github') user = (await github({ host, owner: '-', repo: '-' }, token, s).me()).name;
        else {
          const info = root ? await remoteInfo(root) : null;
          const org = info && info.provider === 'azure' ? info.org : null;
          if (!org) throw new Error('Open a repository with an Azure DevOps remote to check the token.');
          user = (await azure(info, token, s).me()).name;
        }
        await saveToken(provider, host, token, user);
        return { ok: true, user, encrypted: !!safe() };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('pr:signOut', (_e, provider, host) => saveToken(provider, host, null));
  }
};
