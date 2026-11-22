// Nova IDE - work items: GitHub Issues and Azure Boards, in one shape
// list (queries) / get (with comments + links) / create / setState / assign / comment / types / states / linkBranch
'use strict';

const { git } = require('./git');
const P = require('./pullrequests');
const { http, ApiError } = P;

// Azure DevOps descriptions are HTML: turn them into plain text with Markdown-ish lists (the UI escapes it again)
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*li\s*>/gi, '')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr)\s*>/gi, '\n')
    .replace(/<\s*(b|strong)\s*>/gi, '**').replace(/<\s*\/\s*(b|strong)\s*>/gi, '**')
    .replace(/<\s*code\s*>/gi, '`').replace(/<\s*\/\s*code\s*>/gi, '`')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const escHtml = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// plain text -> simple HTML for Azure (paragraphs + line breaks)
const textToHtml = (t) => String(t || '').split(/\n{2,}/).map((p) => `<div>${escHtml(p).replace(/\n/g, '<br>')}</div>`).join('');

// "Fix login (#12)" -> branch name feature/12-fix-login
function branchName(item, prefix = 'feature') {
  const slug = String(item.title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-');
  return `${prefix}/${item.id}${slug ? `-${slug}` : ''}`.slice(0, 80).replace(/-+$/, '');
}
// "#12", "fixes #12", "AB#12" in text -> [12]
function mentionedIds(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[^\w&/])(?:AB)?#(\d{1,7})\b/g)) out.add(+m[1]);
  return [...out];
}

// ---------------- GitHub Issues ----------------
function githubItems(info, token, settings) {
  const api = (settings.githubApiUrl || (info.host === 'github.com' ? 'https://api.github.com' : `https://${info.host}/api/v3`)).replace(/\/$/, '');
  const repo = `${api}/repos/${info.owner}/${info.repo}`;
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = (u) => http('GET', u, { headers: h });
  const send = (m, u, body) => http(m, u, { headers: h, body });
  let meCache = null;
  const me = async () => { if (!meCache) meCache = (await get(`${api}/user`)).login; return meCache; };
  const norm = (i) => ({
    id: i.number, title: i.title, type: 'Issue', state: i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'Closed (not planned)' : 'Closed') : 'Open', category: i.state === 'closed' ? 'closed' : 'open',
    author: i.user ? i.user.login : '', assignees: (i.assignees || []).map((a) => a.login), labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l } : { name: l.name, color: l.color ? `#${l.color}` : null })),
    created: i.created_at, updated: i.updated_at, url: i.html_url, body: i.body || '', comments: i.comments || 0
  });
  return {
    provider: 'github', label: 'GitHub Issues', canCreateBranchLink: false,
    queries: [['mine', 'Assigned to me'], ['created', 'Created by me'], ['mentioned', 'Mentioning me'], ['open', 'All open'], ['closed', 'Recently closed']],
    async list({ query = 'mine', text = '' } = {}) {
      const q = { mine: `assignee=${encodeURIComponent(await me())}&state=open`, created: `creator=${encodeURIComponent(await me())}&state=open`, mentioned: `mentioned=${encodeURIComponent(await me())}&state=open`, open: 'state=open', closed: 'state=closed' }[query] || 'state=open';
      const items = (await get(`${repo}/issues?${q}&per_page=100&sort=updated&direction=desc`)).filter((i) => !i.pull_request).map(norm);
      const t = text.trim().toLowerCase();
      return t ? items.filter((i) => `#${i.id} ${i.title}`.toLowerCase().includes(t)) : items;
    },
    async get(id) {
      const [i, comments, timeline] = await Promise.all([
        get(`${repo}/issues/${id}`),
        get(`${repo}/issues/${id}/comments?per_page=100`),
        get(`${repo}/issues/${id}/timeline?per_page=100`).catch(() => [])
      ]);
      if (i.pull_request) throw new ApiError(`#${id} is a pull request, not an issue.`, 404);
      const item = norm(i);
      item.commentList = comments.map((c) => ({ author: c.user.login, body: c.body || '', date: c.created_at }));
      // pull requests and commits that mention it
      item.links = [];
      for (const ev of timeline) {
        if (ev.event === 'cross-referenced' && ev.source && ev.source.issue && ev.source.issue.pull_request) item.links.push({ kind: 'pr', id: ev.source.issue.number, title: ev.source.issue.title, state: ev.source.issue.state, url: ev.source.issue.html_url });
        else if (ev.event === 'referenced' && ev.commit_id) item.links.push({ kind: 'commit', id: ev.commit_id, title: ev.commit_id.slice(0, 8), url: ev.commit_url });
        else if (ev.event === 'connected' || ev.event === 'closed') { if (ev.commit_id) item.links.push({ kind: 'commit', id: ev.commit_id, title: ev.commit_id.slice(0, 8) }); }
      }
      item.states = item.category === 'open' ? ['Closed', 'Closed (not planned)'] : ['Open'];
      return item;
    },
    async types() { return ['Issue']; },
    async states(item) { return item.category === 'open' ? ['Closed', 'Closed (not planned)'] : ['Open']; },
    async create({ title, body, assignToMe, labels = [] }) {
      return norm(await send('POST', `${repo}/issues`, { title, body, ...(assignToMe ? { assignees: [await me()] } : {}), ...(labels.length ? { labels } : {}) }));
    },
    async setState(id, state) {
      const body = state === 'Open' ? { state: 'open' } : { state: 'closed', state_reason: state === 'Closed (not planned)' ? 'not_planned' : 'completed' };
      return norm(await send('PATCH', `${repo}/issues/${id}`, body));
    },
    async assignToMe(id) { await send('POST', `${repo}/issues/${id}/assignees`, { assignees: [await me()] }); return true; },
    async comment(id, body) { await send('POST', `${repo}/issues/${id}/comments`, { body }); return true; },
    async linkBranch() { return false; },
    webUrl: (id) => `https://${info.host}/${info.owner}/${info.repo}/issues/${id}`,
    listUrl: () => `https://${info.host}/${info.owner}/${info.repo}/issues`,
    // GitHub closes the issue when a commit with this lands on the default branch
    commitText: (id, closes) => (closes ? `Fixes #${id}` : `#${id}`)
  };
}

// ---------------- Azure Boards ----------------
const AZ_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate', 'System.Tags', 'System.CommentCount'];
function azureItems(info, token, settings) {
  const root = (settings.azureDevOpsUrl || 'https://dev.azure.com').replace(/\/$/, '');
  const org = `${root}/${encodeURIComponent(info.org)}`;
  const proj = `${org}/${encodeURIComponent(info.project)}`;
  const V = 'api-version=7.1';
  const h = { Accept: 'application/json', ...(token ? { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {}) };
  const get = (u) => http('GET', u, { headers: h });
  const send = (m, u, body, contentType) => http(m, u, { headers: h, body, contentType });
  const person = (p) => (!p ? '' : typeof p === 'string' ? p.replace(/\s*<[^>]+>$/, '') : p.displayName || p.uniqueName || '');
  const CATEGORY = { Proposed: 'open', InProgress: 'open', Resolved: 'open', Completed: 'closed', Removed: 'closed' };
  const stateCats = new Map(); // "Bug|Active" -> category
  const norm = (w) => {
    const f = w.fields || {};
    const type = f['System.WorkItemType'] || 'Work Item';
    const state = f['System.State'] || '';
    return {
      id: w.id, title: f['System.Title'] || '', type, state, category: stateCats.get(`${type}|${state}`) || (/^(Closed|Done|Removed|Resolved)$/i.test(state) ? 'closed' : 'open'),
      author: person(f['System.CreatedBy']), assignees: f['System.AssignedTo'] ? [person(f['System.AssignedTo'])] : [],
      labels: String(f['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean).map((name) => ({ name })),
      created: f['System.CreatedDate'], updated: f['System.ChangedDate'], url: `${proj}/_workitems/edit/${w.id}`,
      body: htmlToText(f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || ''), comments: f['System.CommentCount'] || 0
    };
  };
  let meCache = null;
  const me = async () => {
    if (!meCache) { const c = await get(`${org}/_apis/connectionData`); meCache = { id: c.authenticatedUser.id, name: c.authenticatedUser.providerDisplayName, unique: (c.authenticatedUser.properties && c.authenticatedUser.properties.Account && c.authenticatedUser.properties.Account.$value) || c.authenticatedUser.providerDisplayName }; }
    return meCache;
  };
  const patch = (ops) => ops.map(([path, value, op = 'add']) => ({ op, path, value }));
  async function loadStates(type) {
    const r = await get(`${proj}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?${V}`).catch(() => ({ value: [] }));
    for (const s of r.value || []) stateCats.set(`${type}|${s.name}`, CATEGORY[s.category] || 'open');
    return (r.value || []).map((s) => s.name);
  }
  return {
    provider: 'azure', label: 'Azure Boards', canCreateBranchLink: true,
    queries: [['mine', 'Assigned to me'], ['created', 'Created by me'], ['open', 'All open'], ['recent', 'Recently changed'], ['closed', 'Recently closed']],
    async list({ query = 'mine', text = '' } = {}) {
      const where = {
        mine: "[System.AssignedTo] = @Me AND [System.StateCategory] NOT IN ('Completed', 'Removed')",
        created: "[System.CreatedBy] = @Me AND [System.StateCategory] NOT IN ('Completed', 'Removed')",
        open: "[System.StateCategory] NOT IN ('Completed', 'Removed')",
        recent: '[System.ChangedDate] >= @Today - 30',
        closed: "[System.StateCategory] IN ('Completed', 'Removed') AND [System.ChangedDate] >= @Today - 60"
      }[query] || "[System.StateCategory] NOT IN ('Completed', 'Removed')";
      const t = text.trim().replace(/'/g, "''");
      const extra = t ? (/^#?\d+$/.test(t) ? ` AND [System.Id] = ${t.replace('#', '')}` : ` AND [System.Title] CONTAINS '${t}'`) : '';
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${where}${extra} ORDER BY [System.ChangedDate] DESC`;
      const r = await send('POST', `${proj}/_apis/wit/wiql?$top=200&${V}`, { query: wiql });
      const ids = (r.workItems || []).map((w) => w.id).slice(0, 200);
      if (!ids.length) return [];
      const items = await get(`${org}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${AZ_FIELDS.join(',')}&${V}`);
      const byId = new Map((items.value || []).map((w) => [w.id, w]));
      return ids.map((id) => byId.get(id)).filter(Boolean).map(norm);
    },
    async get(id) {
      const w = await get(`${org}/_apis/wit/workitems/${id}?$expand=relations&${V}`);
      const type = w.fields['System.WorkItemType'];
      const states = await loadStates(type);
      const item = norm(w);
      item.states = states.filter((s) => s !== item.state);
      const c = await get(`${proj}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`).catch(() => ({ comments: [] }));
      item.commentList = (c.comments || []).map((x) => ({ author: person(x.createdBy), body: htmlToText(x.text), date: x.createdDate })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      // links: pull requests, commits, branches (vstfs artifact links), other work items
      item.links = [];
      for (const r of w.relations || []) {
        const name = (r.attributes && r.attributes.name) || '';
        let m;
        if (r.rel === 'ArtifactLink' && (m = /^vstfs:\/\/\/Git\/PullRequestId\/[^%]+%2F[^%]+%2F(\d+)$/i.exec(r.url))) item.links.push({ kind: 'pr', id: +m[1], title: `Pull request ${m[1]}` });
        else if (r.rel === 'ArtifactLink' && (m = /^vstfs:\/\/\/Git\/Commit\/[^%]+%2F[^%]+%2F([0-9a-f]+)$/i.exec(r.url))) item.links.push({ kind: 'commit', id: m[1], title: m[1].slice(0, 8) });
        else if (r.rel === 'ArtifactLink' && (m = /^vstfs:\/\/\/Git\/Ref\/[^%]+%2F[^%]+%2FGB(.+)$/i.exec(r.url))) item.links.push({ kind: 'branch', id: decodeURIComponent(m[1]), title: decodeURIComponent(m[1]) });
        else if (/^System\.LinkTypes\./.test(r.rel) && (m = /\/workItems\/(\d+)$/i.exec(r.url))) item.links.push({ kind: 'item', id: +m[1], title: `${name || 'Related'} #${m[1]}` });
      }
      return item;
    },
    async types() {
      const r = await get(`${proj}/_apis/wit/workitemtypes?${V}`);
      const hidden = /^(Test |Shared |Code Review|Feedback|Microsoft\.)/;
      return (r.value || []).map((t) => t.name).filter((n) => !hidden.test(n));
    },
    async states(item) { return (await loadStates(item.type)).filter((s) => s !== item.state); },
    async create({ title, body, type = 'Task', assignToMe, labels = [] }) {
      const m = assignToMe ? await me() : null;
      const ops = [['/fields/System.Title', title], ['/fields/System.Description', textToHtml(body)]];
      if (m) ops.push(['/fields/System.AssignedTo', m.unique]);
      if (labels.length) ops.push(['/fields/System.Tags', labels.join('; ')]);
      return norm(await send('POST', `${proj}/_apis/wit/workitems/$${encodeURIComponent(type)}?${V}`, patch(ops), 'application/json-patch+json'));
    },
    async setState(id, state) { return norm(await send('PATCH', `${org}/_apis/wit/workitems/${id}?${V}`, patch([['/fields/System.State', state]]), 'application/json-patch+json')); },
    async assignToMe(id) { const m = await me(); await send('PATCH', `${org}/_apis/wit/workitems/${id}?${V}`, patch([['/fields/System.AssignedTo', m.unique]]), 'application/json-patch+json'); return true; },
    async comment(id, body) { await send('POST', `${proj}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`, { text: textToHtml(body) }); return true; },
    // link a branch to the work item (shows in Azure Boards "Development")
    async linkBranch(id, branch) {
      const repo = await get(`${proj}/_apis/git/repositories/${encodeURIComponent(info.repo)}?${V}`);
      const url = `vstfs:///Git/Ref/${repo.project.id}%2F${repo.id}%2FGB${encodeURIComponent(branch)}`;
      await send('PATCH', `${org}/_apis/wit/workitems/${id}?${V}`, [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Branch' } } }], 'application/json-patch+json');
      return true;
    },
    webUrl: (id) => `${proj}/_workitems/edit/${id}`,
    listUrl: () => `${proj}/_workitems`,
    // Azure Repos links "#12" in commit messages to work item 12; "Fixes #12" also resolves it on merge
    commitText: (id, closes) => (closes ? `Fixes #${id}` : `#${id}`)
  };
}

async function itemsFor(root) {
  const c = await P.context(root);
  if (c.error) return { error: c.error };
  const svc = c.info.provider === 'github' ? githubItems(c.info, c.auth && c.auth.token, c.settings) : azureItems(c.info, c.auth && c.auth.token, c.settings);
  return { ...c, svc };
}
async function call(root, fn) {
  const r = await itemsFor(root);
  if (r.error) return { error: r.error, noRemote: true };
  try { return { result: await fn(r.svc, r), provider: r.svc.provider, label: r.svc.label, signedIn: !!r.auth }; } catch (e) {
    return { error: e.message, status: e.status, needsToken: e.status === 401 || (!r.auth && (e.status === 403 || e.status === 404)), provider: r.svc.provider, label: r.svc.label };
  }
}

// a branch for a work item, from a base branch; optionally checked out and (Azure) linked
async function createBranch(root, svc, r, item, { name, base, checkout }) {
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  if (exists.ok) return { ok: false, stderr: `A branch named ${name} already exists.` };
  const ok = await git(root, ['check-ref-format', '--branch', name]);
  if (!ok.ok) return { ok: false, stderr: `"${name}" is not a valid branch name.` };
  // --no-track: based on origin/main must not make origin/main its upstream (push would refuse)
  const c = checkout ? await git(root, ['checkout', '--no-track', '-b', name, base]) : await git(root, ['branch', '--no-track', name, base]);
  if (!c.ok) return c;
  let linked = false;
  if (svc.canCreateBranchLink) { try { linked = await svc.linkBranch(item.id, name); } catch (e) { return { ...c, linked: false, linkError: e.message }; } }
  return { ...c, ok: true, linked };
}

module.exports = {
  htmlToText, textToHtml, branchName, mentionedIds, githubItems, azureItems, createBranch,
  register({ ipcMain }) {
    ipcMain.handle('wi:info', (_e, root) => call(root, (svc) => ({ queries: svc.queries, provider: svc.provider, label: svc.label, canLinkBranch: svc.canCreateBranchLink, listUrl: svc.listUrl() })));
    ipcMain.handle('wi:list', (_e, root, opts) => call(root, (svc) => svc.list(opts || {})));
    ipcMain.handle('wi:get', (_e, root, id) => call(root, (svc) => svc.get(id)));
    ipcMain.handle('wi:types', (_e, root) => call(root, (svc) => svc.types()));
    ipcMain.handle('wi:create', (_e, root, opts) => call(root, (svc) => svc.create(opts)));
    ipcMain.handle('wi:setState', (_e, root, id, state) => call(root, (svc) => svc.setState(id, state)));
    ipcMain.handle('wi:assignToMe', (_e, root, id) => call(root, (svc) => svc.assignToMe(id)));
    ipcMain.handle('wi:comment', (_e, root, id, body) => call(root, (svc) => svc.comment(id, body)));
    ipcMain.handle('wi:createBranch', (_e, root, item, opts) => call(root, (svc, r) => createBranch(root, svc, r, item, opts)));
    ipcMain.handle('wi:commitText', (_e, root, id, closes) => call(root, (svc) => svc.commitText(id, closes)));
    ipcMain.handle('wi:mentioned', (_e, text) => mentionedIds(text));
  }
};
