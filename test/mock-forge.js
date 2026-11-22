// A small stand-in for the GitHub and Azure DevOps REST APIs, backed by real bare git repositories.
// Used by the unit and end-to-end tests (not shipped). Pull request heads/merges are real git objects.
'use strict';
const http = require('http');
const { execFileSync } = require('child_process');

function startForge({ github, azure, token = 'good-token' }) {
  const g = (bare, ...a) => execFileSync('git', a, { cwd: bare, env: { ...process.env, GIT_AUTHOR_NAME: 'Forge', GIT_AUTHOR_EMAIL: 'forge@x', GIT_COMMITTER_NAME: 'Forge', GIT_COMMITTER_EMAIL: 'forge@x' } }).toString().trim();
  const sha = (bare, ref) => { try { return g(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; } };
  const now = () => new Date().toISOString();
  const state = { gh: { prs: [], issues: [], comments: {}, reviews: {}, codeComments: {}, statuses: {}, runs: {}, timeline: {}, next: 1 }, az: { prs: [], threads: {}, statuses: {}, next: 100, items: [], wiComments: {}, nextItem: 500 }, requests: [] };

  // merge `head` into branch `base` inside the bare repo
  function mergeInBare(bare, base, headSha, method, title) {
    const baseSha = sha(bare, `refs/heads/${base}`);
    const tree = g(bare, 'merge-tree', '--write-tree', baseSha, headSha).split('\n')[0];
    const commit = method === 'merge'
      ? g(bare, 'commit-tree', tree, '-p', baseSha, '-p', headSha, '-m', title)
      : g(bare, 'commit-tree', tree, '-p', baseSha, '-m', title);
    g(bare, 'update-ref', `refs/heads/${base}`, commit);
    return commit;
  }
  const commitsBetween = (bare, base, head) => {
    const out = g(bare, 'log', '--format=%H%x1f%s%x1f%an%x1f%aI', `${base}..${head}`);
    return out ? out.split('\n').map((l) => { const [h, s, n, d] = l.split('\x1f'); return { h, s, n, d }; }).reverse() : [];
  };

  // ---------- GitHub ----------
  const ghUser = (login) => ({ login, avatar_url: '' });
  function ghPr(p) {
    // keep the head current, as GitHub does when the branch moves
    if (p.state === 'open') { const s = sha(github.bare, `refs/heads/${p.head}`); if (s && s !== p.headSha) { p.headSha = s; g(github.bare, 'update-ref', `refs/pull/${p.number}/head`, s); } }
    return {
      number: p.number, title: p.title, body: p.body, state: p.state, draft: p.draft, merged: !!p.merged_at, merged_at: p.merged_at,
      html_url: `https://github.com/${github.owner}/${github.repo}/pull/${p.number}`, user: ghUser(p.author), created_at: p.created, updated_at: p.updated,
      head: { ref: p.head, sha: p.headSha, repo: { full_name: p.fork || `${github.owner}/${github.repo}` } },
      base: { ref: p.base, sha: sha(github.bare, `refs/heads/${p.base}`) },
      labels: p.labels || [], requested_reviewers: (p.requested || []).map(ghUser),
      mergeable: true, mergeable_state: 'clean', comments: (state.gh.comments[p.number] || []).length, review_comments: (state.gh.codeComments[p.number] || []).length
    };
  }
  function ghCreate({ title, body = '', head, base, draft = false, author = 'alice', fork = null, labels = [], requested = [] }) {
    const headSha = sha(github.bare, `refs/heads/${head}`);
    if (!headSha) return [422, { message: 'Validation Failed', errors: [{ message: `No branch named ${head}` }] }];
    if (state.gh.prs.some((p) => p.state === 'open' && p.head === head && p.base === base)) return [422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${github.owner}:${head}.` }] }];
    if (!commitsBetween(github.bare, base, head).length) return [422, { message: 'Validation Failed', errors: [{ message: `No commits between ${base} and ${head}` }] }];
    const p = { number: state.gh.next++, title, body, head, headSha, base, draft, state: 'open', author, fork, labels, requested, created: now(), updated: now() };
    g(github.bare, 'update-ref', `refs/pull/${p.number}/head`, headSha);
    state.gh.prs.push(p);
    return [201, ghPr(p)];
  }
  // issues share their numbers with pull requests, like on GitHub
  const ghIssue = (i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, state_reason: i.state_reason || null, user: ghUser(i.author), assignees: i.assignees.map(ghUser), labels: i.labels.map((n) => ({ name: n, color: 'd73a4a' })), created_at: i.created, updated_at: i.updated, html_url: `https://github.com/${github.owner}/${github.repo}/issues/${i.number}`, comments: (state.gh.comments[i.number] || []).length });
  function ghCreateIssue({ title, body = '', assignees = [], labels = [], author = 'alice' }) {
    const i = { number: state.gh.next++, title, body, state: 'open', author, assignees, labels, created: now(), updated: now() };
    state.gh.issues.push(i);
    return [201, ghIssue(i)];
  }
  function githubRoute(method, url, body) {
    const base = `/repos/${github.owner}/${github.repo}`;
    const u = new URL(url, 'http://x');
    const p = u.pathname;
    if (method === 'GET' && p === '/user') return [200, ghUser('alice')];
    if (!p.startsWith(base)) return [404, { message: 'Not Found' }];
    const rest = p.slice(base.length);
    let m;
    if (method === 'GET' && rest === '') return [200, { default_branch: 'main', html_url: `https://github.com/${github.owner}/${github.repo}` }];
    if (method === 'GET' && rest === '/pulls') {
      const st = u.searchParams.get('state') || 'open';
      const head = u.searchParams.get('head');
      return [200, state.gh.prs.filter((x) => (st === 'all' || x.state === st) && (!head || `${github.owner}:${x.head}` === head)).sort((a, b) => b.number - a.number).map(ghPr)];
    }
    if (method === 'POST' && rest === '/pulls') return ghCreate(body);
    if (method === 'GET' && rest === '/issues') {
      const q = u.searchParams;
      const st = q.get('state') || 'open';
      let list = state.gh.issues.filter((i) => st === 'all' || i.state === st);
      if (q.get('assignee')) list = list.filter((i) => i.assignees.includes(q.get('assignee')));
      if (q.get('creator')) list = list.filter((i) => i.author === q.get('creator'));
      if (q.get('mentioned')) list = list.filter((i) => new RegExp(`@${q.get('mentioned')}\\b`).test(i.body) || (state.gh.comments[i.number] || []).some((c) => c.body.includes(`@${q.get('mentioned')}`)));
      // the real API mixes pull requests into /issues
      const prs = state.gh.prs.filter((x) => st === 'all' || x.state === st).map((x) => ({ ...ghPr(x), pull_request: { url: 'x' } }));
      return [200, [...list.sort((a, b) => b.number - a.number).map(ghIssue), ...(q.get('assignee') || q.get('creator') || q.get('mentioned') ? [] : prs)]];
    }
    if (method === 'POST' && rest === '/issues') return ghCreateIssue(body);
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const i = state.gh.issues.find((x) => x.number === +m[1]);
      if (!i) { const pr = state.gh.prs.find((x) => x.number === +m[1]); return pr ? [200, { ...ghPr(pr), pull_request: { url: 'x' } }] : [404, { message: 'Not Found' }]; }
      if (method === 'GET') return [200, ghIssue(i)];
      if (method === 'PATCH') { Object.assign(i, body.state ? { state: body.state, state_reason: body.state_reason || null } : {}, body.title ? { title: body.title } : {}); i.updated = now(); return [200, ghIssue(i)]; }
    }
    if ((m = /^\/issues\/(\d+)\/assignees$/.exec(rest)) && method === 'POST') { const i = state.gh.issues.find((x) => x.number === +m[1]); for (const a of body.assignees) if (!i.assignees.includes(a)) i.assignees.push(a); return [201, ghIssue(i)]; }
    if ((m = /^\/issues\/(\d+)\/timeline$/.exec(rest))) return [200, state.gh.timeline[+m[1]] || []];
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = state.gh.prs.find((x) => x.number === +m[1]);
      if (!pr) return [404, { message: 'Not Found' }];
      if (method === 'GET') return [200, ghPr(pr)];
      if (method === 'PATCH') { if (body.state) pr.state = body.state; pr.updated = now(); return [200, ghPr(pr)]; }
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const pr = state.gh.prs.find((x) => x.number === +m[1]);
      if (!pr || pr.state !== 'open') return [405, { message: 'Pull Request is not mergeable' }];
      ghPr(pr);
      mergeInBare(github.bare, pr.base, pr.headSha, body.merge_method || 'merge', body.merge_method === 'merge' ? `Merge pull request #${pr.number} from ${github.owner}/${pr.head}` : `${pr.title} (#${pr.number})`);
      pr.state = 'closed'; pr.merged_at = now(); pr.mergeMethod = body.merge_method;
      return [200, { merged: true, message: 'Pull Request successfully merged' }];
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) {
      const n = +m[1];
      state.gh.reviews[n] = state.gh.reviews[n] || [];
      if (method === 'GET') return [200, state.gh.reviews[n]];
      const r = { user: ghUser('alice'), state: { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[body.event], body: body.body || '', submitted_at: now() };
      state.gh.reviews[n].push(r);
      return [200, r];
    }
    if ((m = /^\/pulls\/(\d+)\/comments$/.exec(rest)) && method === 'GET') return [200, state.gh.codeComments[+m[1]] || []];
    if ((m = /^\/pulls\/(\d+)\/commits$/.exec(rest)) && method === 'GET') {
      const pr = state.gh.prs.find((x) => x.number === +m[1]);
      return [200, commitsBetween(github.bare, pr.base, pr.headSha).map((c) => ({ sha: c.h, commit: { message: c.s, author: { name: c.n, date: c.d } } }))];
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const n = +m[1];
      state.gh.comments[n] = state.gh.comments[n] || [];
      if (method === 'GET') return [200, state.gh.comments[n]];
      const c = { id: Date.now(), user: ghUser('alice'), body: body.body, created_at: now() };
      state.gh.comments[n].push(c);
      return [201, c];
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest))) return [200, { state: 'success', statuses: state.gh.statuses[m[1]] || [] }];
    if ((m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) return [200, { check_runs: state.gh.runs[m[1]] || [] }];
    return [404, { message: 'Not Found' }];
  }

  // ---------- Azure DevOps ----------
  const azBase = azure ? `/${azure.org}/${azure.project}/_apis/git/repositories/${azure.repo}`.toLowerCase() : '';
  function azPr(p) {
    if (p.status === 'active') { const s = sha(azure.bare, `refs/heads/${p.source}`); if (s) p.sourceSha = s; }
    return {
      pullRequestId: p.id, title: p.title, description: p.description, status: p.status, isDraft: p.isDraft,
      createdBy: { displayName: p.author, uniqueName: `${p.author.split(' ')[0].toLowerCase()}@contoso.com`, id: 'u-' + p.author },
      creationDate: p.created, closedDate: p.closed, sourceRefName: `refs/heads/${p.source}`, targetRefName: `refs/heads/${p.target}`,
      lastMergeSourceCommit: { commitId: p.sourceSha }, lastMergeTargetCommit: { commitId: sha(azure.bare, `refs/heads/${p.target}`) },
      reviewers: p.reviewers, mergeStatus: 'succeeded', labels: []
    };
  }
  function azCreate({ sourceRefName, targetRefName, title, description = '', isDraft = false, author = 'Alice Smith', reviewers = [], workItemRefs = [] }) {
    const source = sourceRefName.replace(/^refs\/heads\//, ''), target = targetRefName.replace(/^refs\/heads\//, '');
    const s = sha(azure.bare, `refs/heads/${source}`);
    if (!s) return [400, { message: `TF401398: The pull request cannot be activated because the source branch ${source} does not exist.` }];
    if (state.az.prs.some((p) => p.status === 'active' && p.source === source && p.target === target)) return [409, { message: 'TF401179: An active pull request for the source and target branch already exists.' }];
    const p = { id: state.az.next++, title, description, isDraft, status: 'active', source, target, sourceSha: s, author, reviewers, created: now(), workItemRefs };
    state.az.prs.push(p);
    // like Azure DevOps: linked work items get an artifact link to the pull request
    for (const ref of workItemRefs) { const w = state.az.items.find((x) => x.id === +ref.id); if (w) w.relations.push({ rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/proj-1%2Frepo-1%2F${p.id}`, attributes: { name: 'Pull Request' } }); }
    return [201, azPr(p)];
  }
  const azItem = (w, withRel) => ({ id: w.id, rev: w.rev, fields: { 'System.Id': w.id, 'System.Title': w.title, 'System.WorkItemType': w.type, 'System.State': w.state, 'System.AssignedTo': w.assignedTo ? { displayName: w.assignedTo, uniqueName: 'alice@contoso.com' } : undefined, 'System.CreatedBy': { displayName: w.createdBy }, 'System.CreatedDate': w.created, 'System.ChangedDate': w.changed, 'System.Tags': w.tags || '', 'System.Description': w.description || '', 'System.CommentCount': (state.az.wiComments[w.id] || []).length }, ...(withRel ? { relations: w.relations } : {}) });
  const AZ_STATES = { Bug: [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed']], Task: [['To Do', 'Proposed'], ['Doing', 'InProgress'], ['Done', 'Completed']], 'User Story': [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']] };
  const azCat = (w) => (AZ_STATES[w.type].find(([n]) => n === w.state) || [0, 'Proposed'])[1];
  function azCreateItem({ type = 'Task', title, description = '', assignedTo = null, createdBy = 'Alice Smith', tags = '', state: st }) {
    const w = { id: state.az.nextItem++, rev: 1, type, title, description, assignedTo, createdBy, tags, state: st || AZ_STATES[type][0][0], created: now(), changed: now(), relations: [] };
    state.az.items.push(w);
    return w;
  }
  function applyPatch(w, ops) {
    for (const o of ops) {
      const f = o.path.replace('/fields/', '');
      if (o.path === '/relations/-') w.relations.push(o.value);
      else if (f === 'System.Title') w.title = o.value;
      else if (f === 'System.State') { if (!AZ_STATES[w.type].some(([n]) => n === o.value)) throw Object.assign(new Error(`TF401320: Rule Error for field State. Error code: Required, InvalidListValue.`), { status: 400 }); w.state = o.value; }
      else if (f === 'System.AssignedTo') w.assignedTo = /alice/i.test(o.value) ? 'Alice Smith' : o.value;
      else if (f === 'System.Description') w.description = o.value;
      else if (f === 'System.Tags') w.tags = o.value;
    }
    w.rev++; w.changed = now();
  }
  function witRoute(method, u, p, body) {
    const org = `/${azure.org}`.toLowerCase(), proj = `/${azure.org}/${azure.project}`.toLowerCase();
    let m;
    if (method === 'POST' && p === `${proj}/_apis/wit/wiql`) {
      const q = body.query;
      let list = state.az.items.slice();
      if (/\[System\.AssignedTo\] = @Me/.test(q)) list = list.filter((w) => w.assignedTo === 'Alice Smith');
      if (/\[System\.CreatedBy\] = @Me/.test(q)) list = list.filter((w) => w.createdBy === 'Alice Smith');
      if (/StateCategory\] NOT IN \('Completed', 'Removed'\)/.test(q)) list = list.filter((w) => !['Completed', 'Removed'].includes(azCat(w)));
      else if (/StateCategory\] IN \('Completed', 'Removed'\)/.test(q)) list = list.filter((w) => ['Completed', 'Removed'].includes(azCat(w)));
      if ((m = /\[System\.Title\] CONTAINS '([^']*)'/.exec(q))) list = list.filter((w) => w.title.toLowerCase().includes(m[1].toLowerCase()));
      if ((m = /\[System\.Id\] = (\d+)/.exec(q))) list = list.filter((w) => w.id === +m[1]);
      return [200, { workItems: list.sort((a, b) => String(b.changed).localeCompare(String(a.changed)) || b.id - a.id).map((w) => ({ id: w.id })) }];
    }
    if (method === 'GET' && p === `${org}/_apis/wit/workitems`) return [200, { value: u.searchParams.get('ids').split(',').map(Number).map((id) => state.az.items.find((w) => w.id === id)).filter(Boolean).map((w) => azItem(w)) }];
    if ((m = new RegExp(`^${org}/_apis/wit/workitems/(\\d+)$`).exec(p))) {
      const w = state.az.items.find((x) => x.id === +m[1]);
      if (!w) return [404, { message: `TF401232: Work item ${m[1]} does not exist.` }];
      if (method === 'GET') return [200, azItem(w, true)];
      if (method === 'PATCH') { try { applyPatch(w, body); } catch (e) { return [e.status || 400, { message: e.message }]; } return [200, azItem(w, true)]; }
    }
    if (method === 'POST' && (m = new RegExp(`^${proj}/_apis/wit/workitems/\\$(.+)$`).exec(p))) {
      const type = Object.keys(AZ_STATES).find((t) => t.toLowerCase() === m[1]);
      if (!type) return [404, { message: `VS402323: Work item type ${m[1]} does not exist.` }];
      const w = azCreateItem({ type, title: '' });
      applyPatch(w, body);
      w.rev = 1;
      return [200, azItem(w, true)];
    }
    if (method === 'GET' && p === `${proj}/_apis/wit/workitemtypes`) return [200, { value: [...Object.keys(AZ_STATES), 'Test Case', 'Shared Steps'].map((name) => ({ name })) }];
    if (method === 'GET' && (m = new RegExp(`^${proj}/_apis/wit/workitemtypes/(.+)/states$`).exec(p))) { const type = Object.keys(AZ_STATES).find((t) => t.toLowerCase() === m[1]); return [200, { value: (AZ_STATES[type] || []).map(([name, category]) => ({ name, category })) }]; }
    if ((m = new RegExp(`^${proj}/_apis/wit/workitems/(\\d+)/comments$`).exec(p))) {
      const id = +m[1];
      state.az.wiComments[id] = state.az.wiComments[id] || [];
      if (method === 'GET') return [200, { comments: state.az.wiComments[id] }];
      const c = { text: body.text, createdBy: { displayName: 'Alice Smith' }, createdDate: now() };
      state.az.wiComments[id].push(c);
      return [200, c];
    }
    return null;
  }
  function azureRoute(method, url, body) {
    const u = new URL(url, 'http://x');
    const p = decodeURIComponent(u.pathname).toLowerCase();
    let m;
    if (method === 'GET' && p === `/${azure.org}/_apis/connectiondata`.toLowerCase()) return [200, { authenticatedUser: { id: 'me-1', providerDisplayName: 'Alice Smith', properties: { Account: { $value: 'alice@contoso.com' } } } }];
    const wit = witRoute(method, u, p, body);
    if (wit) return wit;
    if (!p.startsWith(azBase)) return [404, { message: 'Not found' }];
    const rest = p.slice(azBase.length);
    if (method === 'GET' && rest === '') return [200, { id: 'repo-1', project: { id: 'proj-1', name: azure.project }, name: azure.repo, defaultBranch: 'refs/heads/main', webUrl: `https://dev.azure.com/${azure.org}/${azure.project}/_git/${azure.repo}` }];
    if (rest === '/pullrequests' && method === 'GET') {
      const st = u.searchParams.get('searchCriteria.status') || 'active';
      const src = u.searchParams.get('searchCriteria.sourceRefName');
      return [200, { value: state.az.prs.filter((x) => (st === 'all' || x.status === st) && (!src || `refs/heads/${x.source}` === src)).sort((a, b) => b.id - a.id).map(azPr) }];
    }
    if (rest === '/pullrequests' && method === 'POST') return azCreate(body);
    if ((m = /^\/pullrequests\/(\d+)$/.exec(rest))) {
      const pr = state.az.prs.find((x) => x.id === +m[1]);
      if (!pr) return [404, { message: 'TF401180: The requested pull request was not found.' }];
      if (method === 'GET') return [200, azPr(pr)];
      if (method === 'PATCH') {
        if (body.status === 'completed') {
          azPr(pr);
          const strategy = (body.completionOptions || {}).mergeStrategy || 'noFastForward';
          mergeInBare(azure.bare, pr.target, pr.sourceSha, strategy === 'noFastForward' ? 'merge' : 'squash', `Merged PR ${pr.id}: ${pr.title}`);
          pr.status = 'completed'; pr.closed = now(); pr.strategy = strategy;
        } else if (body.status) pr.status = body.status;
        return [200, azPr(pr)];
      }
    }
    if ((m = /^\/pullrequests\/(\d+)\/statuses$/.exec(rest))) return [200, { value: state.az.statuses[+m[1]] || [] }];
    if ((m = /^\/pullrequests\/(\d+)\/commits$/.exec(rest))) {
      const pr = state.az.prs.find((x) => x.id === +m[1]);
      return [200, { value: commitsBetween(azure.bare, pr.target, pr.sourceSha).map((c) => ({ commitId: c.h, comment: c.s, author: { name: c.n, date: c.d } })) }];
    }
    if ((m = /^\/pullrequests\/(\d+)\/threads$/.exec(rest))) {
      const n = +m[1];
      state.az.threads[n] = state.az.threads[n] || [];
      if (method === 'GET') return [200, { value: state.az.threads[n] }];
      const t = { id: state.az.threads[n].length + 1, comments: body.comments.map((c) => ({ author: { displayName: 'Alice Smith' }, content: c.content, publishedDate: now(), commentType: 'text' })), status: 'active' };
      state.az.threads[n].push(t);
      return [200, t];
    }
    if ((m = /^\/pullrequests\/(\d+)\/reviewers\/([^/]+)$/.exec(rest)) && method === 'PUT') {
      const pr = state.az.prs.find((x) => x.id === +m[1]);
      let r = pr.reviewers.find((x) => x.id.toLowerCase() === m[2]);
      if (!r) { r = { id: 'me-1', displayName: 'Alice Smith', vote: 0 }; pr.reviewers.push(r); }
      r.vote = body.vote;
      return [200, r];
    }
    return [404, { message: 'Not found' }];
  }

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      let body = {};
      try { body = data ? JSON.parse(data) : {}; } catch {}
      const auth = req.headers.authorization || '';
      const isAzure = azure && decodeURIComponent(req.url).toLowerCase().startsWith(`/az/`);
      const url = isAzure ? req.url.slice(3) : req.url.replace(/^\/gh/, '');
      state.requests.push(`${req.method} ${req.url}`);
      const ok = isAzure ? auth === `Basic ${Buffer.from(`:${token}`).toString('base64')}` : auth === `Bearer ${token}`;
      let out;
      if (!ok) out = [401, { message: 'Bad credentials' }];
      else {
        try { out = isAzure ? azureRoute(req.method, url, body) : githubRoute(req.method, url, body); } catch (e) { out = [500, { message: e.message }]; }
      }
      res.writeHead(out[0], { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out[1]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      port, state, server,
      githubApiUrl: `http://127.0.0.1:${port}/gh`, azureDevOpsUrl: `http://127.0.0.1:${port}/az`,
      ghCreate, azCreate, ghCreateIssue, azCreateItem,
      close: () => new Promise((r) => server.close(r))
    });
  }));
}

module.exports = { startForge };
