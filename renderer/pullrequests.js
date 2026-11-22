// Nova IDE - pull requests (GitHub / Azure DevOps): list + details window, create dialog, accounts, status bar
'use strict';

const PR = { open: false, root: null, remote: null, list: [], filter: 'open', query: '', selected: null, details: null, tab: 'overview', files: null, commits: null, conversation: null, branchPr: new Map(), token: 0 };
const PR_STATE = { open: 'Open', merged: 'Merged', closed: 'Closed' };
const VOTE_ICON = { approved: '✔', changes: '✎', rejected: '✖', pending: '○', commented: '💬' };
const VOTE_TEXT = { approved: 'Approved', changes: 'Changes requested', rejected: 'Rejected', pending: 'Review pending', commented: 'Commented' };
const CHECK_ICON = { success: '✔', failure: '✖', pending: '●', none: '' };
const prRoot = () => (gitState.status && gitState.status.repo ? gitState.status.root : null);
const remoteLabel = (r) => (r.provider === 'github' ? `${r.host === 'github.com' ? 'GitHub' : r.host} · ${r.owner}/${r.repo}` : `Azure DevOps · ${r.org}/${r.project}/${r.repo}`);

// ---------------- tiny markdown (escaped first, so nothing in a description can run) ----------------
function mdToHtml(md) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="#" data-href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="#" data-href="$2">$2</a>');
  const out = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flushPara(); flushList();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { flushPara(); flushList(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
    if ((m = /^\s*(?:[-*+]|(\d+)\.)\s+(?:\[( |x)\]\s+)?(.*)$/.exec(l))) {
      flushPara();
      const tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(`${m[2] ? `<input type="checkbox" disabled ${m[2] === 'x' ? 'checked' : ''}> ` : ''}${inline(m[3])}`);
      continue;
    }
    if (/^>\s?/.test(l)) { flushPara(); flushList(); out.push(`<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (!l.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join('');
}
function mdNode(md, cls = 'pr-md') {
  const d = h('div', { class: cls });
  d.innerHTML = md && md.trim() ? mdToHtml(md) : '<p class="dlg-desc"><i>No description.</i></p>';
  d.querySelectorAll('a[data-href]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); api.openExternal(a.dataset.href); }; });
  return d;
}

// ---------------- opening ----------------
async function showPullRequests({ select = null, filter = null } = {}) {
  if (gitState.status == null) await refreshGit();
  const root = prRoot();
  if (!root) { status('Open a Git repository first'); return; }
  const remote = await api.pr.remote(root);
  if (remote.error) { alert(remote.error); return; }
  if (typeof hideHistory === 'function' && GH.open) hideHistory();
  if (typeof WI !== 'undefined' && WI.open) hideWorkItems();
  closeDiff();
  PR.open = true; PR.root = root; PR.remote = remote;
  if (filter) PR.filter = filter;
  $('#prView').classList.remove('hidden');
  $('#prTitle').textContent = `Pull Requests · ${remoteLabel(remote)}`;
  $('#prFilter').value = PR.filter;
  await loadPrList(select);
}
function hidePullRequests() { PR.open = false; $('#prView').classList.add('hidden'); }

// a failed call: sign-in needed, or a message
function prError(host, r) {
  host.innerHTML = '';
  if (r.needsToken) {
    host.append(h('div', { class: 'pr-signin' },
      h('h3', {}, `Sign in to ${r.label || 'the service'}`),
      h('p', {}, r.error),
      h('p', { class: 'dlg-desc' }, 'Nova IDE needs a personal access token to read and change pull requests.'),
      (() => { const b = h('button', { class: 'primary', id: 'prSignIn' }, 'Sign in...'); b.onclick = () => accountsDialog(); return b; })()));
  } else host.append(h('div', { class: 'pr-empty' }, r.error || 'Something went wrong.'));
}

async function loadPrList(select = null) {
  const token = ++PR.token;
  $('#prList').innerHTML = '<div class="pr-empty">Loading...</div>';
  const r = await api.pr.list(PR.root, { state: PR.filter });
  if (token !== PR.token) return;
  if (r.error) { PR.list = []; prError($('#prList'), r); $('#prDetails').innerHTML = ''; return; }
  PR.list = r.result;
  renderPrList();
  const pick = select || (PR.selected && PR.list.some((p) => p.number === PR.selected) ? PR.selected : PR.list[0] && PR.list[0].number);
  if (pick) selectPr(pick); else { PR.selected = null; $('#prDetails').innerHTML = `<div class="pr-empty">No ${PR.filter === 'all' ? '' : `${PR.filter} `}pull requests.</div>`; }
}

function renderPrList() {
  const host = $('#prList');
  host.innerHTML = '';
  const q = PR.query.toLowerCase();
  const items = PR.list.filter((p) => !q || `#${p.number} ${p.title} ${p.author.name} ${p.head.ref}`.toLowerCase().includes(q));
  if (!items.length) { host.appendChild(h('div', { class: 'pr-empty' }, PR.list.length ? 'Nothing matches the search.' : `No ${PR.filter === 'all' ? '' : `${PR.filter} `}pull requests.`)); return; }
  for (const p of items) {
    const row = h('div', { class: `pr-item${p.number === PR.selected ? ' selected' : ''}`, 'data-n': p.number },
      h('div', { class: 'pr-item-title' }, h('span', { class: `pr-state-dot st-${p.state}${p.draft ? ' draft' : ''}`, title: p.draft ? 'Draft' : PR_STATE[p.state] }), h('span', { class: 'pr-num' }, `#${p.number}`), h('span', { class: 'label' }, p.title), p.draft ? h('span', { class: 'pr-badge draft' }, 'Draft') : null),
      h('div', { class: 'pr-item-meta dlg-desc' }, `${p.author.name} · ${p.head.ref} → ${p.base.ref} · ${relTime(Date.parse(p.updated || p.created) / 1000)}`));
    row.onclick = () => selectPr(p.number);
    host.appendChild(row);
  }
}

// ---------------- details ----------------
async function selectPr(n, { keepTab = false } = {}) {
  PR.selected = n;
  if (!keepTab) PR.tab = 'overview';
  PR.files = null; PR.commits = null; PR.conversation = null;
  renderPrList();
  const host = $('#prDetails');
  host.innerHTML = '<div class="pr-empty">Loading...</div>';
  const [d, conv] = await Promise.all([api.pr.get(PR.root, n), api.pr.conversation(PR.root, n)]);
  if (PR.selected !== n) return;
  if (d.error) { prError(host, d); return; }
  PR.details = d.result;
  PR.conversation = conv.error ? [] : conv.result;
  renderPrDetails();
  // counts for the tabs
  api.pr.commits(PR.root, n).then((c) => { if (PR.selected === n && !c.error) { PR.commits = c.result; renderPrTabs(); } });
}

function renderPrDetails() {
  const p = PR.details;
  const host = $('#prDetails');
  host.innerHTML = '';
  const head = h('div', { class: 'pr-head' },
    h('div', { class: 'pr-title' }, p.title, h('span', { class: 'pr-num' }, ` #${p.number}`)),
    h('div', { class: 'pr-sub' },
      h('span', { class: `pr-badge st-${p.state}${p.draft ? ' draft' : ''}` }, p.draft && p.state === 'open' ? 'Draft' : PR_STATE[p.state]),
      h('span', {}, ' '), h('b', {}, p.author.name), h('span', {}, ` wants to merge `), h('code', {}, p.head.ref), h('span', {}, ' into '), h('code', {}, p.base.ref),
      p.sameRepo ? null : h('span', { class: 'dlg-desc' }, ` (from ${p.head.repo || 'a fork'})`)));
  const act = h('div', { class: 'pr-actions' });
  // stopPropagation: a page-wide click handler closes menus, so a ▾ button must not let its click through
  const btn = (label, title, fn, cls) => { const b = h('button', { class: cls || '', title }, label); b.onclick = (e) => { e.stopPropagation(); fn(e); }; act.appendChild(b); return b; };
  btn('Checkout', `Switch to ${p.sameRepo ? p.head.ref : `pr/${p.number}`} with the pull request's changes`, () => checkoutPr(p));
  btn('Open in Browser', 'Open the pull request on the web', () => api.openExternal(p.url));
  if (p.state === 'open') {
    btn('Review ▾', 'Approve, request changes or comment', (e) => { const r = e.target.getBoundingClientRect(); popup(r.left, r.bottom, [
      { label: 'Approve', run: () => reviewPr('approve') },
      { label: 'Request Changes...', run: () => reviewPr('reject') },
      { label: 'Comment...', run: () => reviewPr('comment') }]); });
    btn('Merge ▾', 'Complete the pull request', (e) => { const r = e.target.getBoundingClientRect(); popup(r.left, r.bottom, [
      { label: 'Create a Merge Commit', run: () => mergePr('merge') },
      { label: 'Squash and Merge', run: () => mergePr('squash') },
      { label: 'Rebase and Merge', run: () => mergePr('rebase') }]); }, 'primary');
    btn(PR.remote.provider === 'azure' ? 'Abandon' : 'Close', 'Close without merging', () => setPrState('closed'));
  } else if (p.state === 'closed') btn(PR.remote.provider === 'azure' ? 'Reactivate' : 'Reopen', 'Open it again', () => setPrState('open'));
  head.appendChild(act);
  // checks, reviewers, labels
  const side = h('div', { class: 'pr-facts' });
  const chk = p.checks || { state: 'none', items: [] };
  side.appendChild(h('div', { class: `pr-checks ck-${chk.state}` }, chk.state === 'none' ? 'No checks' : `${CHECK_ICON[chk.state]} ${chk.state === 'success' ? 'All checks passed' : chk.state === 'failure' ? 'Some checks failed' : 'Checks in progress'} (${chk.items.length})`));
  for (const c of chk.items) {
    const row = h('div', { class: `pr-check ck-${c.state}`, title: c.description || '' }, h('span', { class: 'ck-ico' }, CHECK_ICON[c.state]), h('span', {}, c.name), c.description ? h('span', { class: 'dlg-desc' }, ` — ${c.description}`) : null);
    if (c.url && /^https?:/.test(c.url)) { row.classList.add('link'); row.onclick = () => api.openExternal(c.url); }
    side.appendChild(row);
  }
  side.appendChild(h('div', { class: 'pr-facts-title' }, 'Reviewers'));
  if (!p.reviewers.length) side.appendChild(h('div', { class: 'dlg-desc' }, 'No reviewers'));
  for (const r of p.reviewers) side.appendChild(h('div', { class: `pr-reviewer rv-${r.state}`, title: VOTE_TEXT[r.state] }, h('span', { class: 'rv-ico' }, VOTE_ICON[r.state]), ` ${r.name}`, h('span', { class: 'dlg-desc' }, ` · ${VOTE_TEXT[r.state]}`)));
  if (p.labels.length) {
    side.appendChild(h('div', { class: 'pr-facts-title' }, 'Labels'));
    const ls = h('div', {});
    for (const l of p.labels) ls.appendChild(h('span', { class: 'pr-label', style: l.color ? `border-color:${l.color}` : '' }, l.name));
    side.appendChild(ls);
  }
  const tabs = h('div', { class: 'pr-tabs', id: 'prTabs' });
  const body = h('div', { class: 'pr-body', id: 'prBody' });
  host.append(head, h('div', { class: 'pr-main' }, h('div', { class: 'pr-left' }, tabs, body), side));
  renderPrTabs();
}

function renderPrTabs() {
  const tabs = $('#prTabs');
  if (!tabs || !PR.details) return;
  tabs.innerHTML = '';
  const t = (id, label) => { const b = h('button', { class: PR.tab === id ? 'active' : '', 'data-tab': id }, label); b.onclick = () => { PR.tab = id; renderPrTabs(); }; tabs.appendChild(b); };
  t('overview', 'Overview');
  t('files', `Files${PR.files ? ` (${PR.files.files.length})` : ''}`);
  t('commits', `Commits${PR.commits ? ` (${PR.commits.length})` : ''}`);
  const body = $('#prBody');
  body.innerHTML = '';
  if (PR.tab === 'overview') renderOverview(body);
  else if (PR.tab === 'files') renderFiles(body);
  else renderCommits(body);
}

function renderOverview(body) {
  const p = PR.details;
  body.appendChild(h('div', { class: 'pr-card' }, h('div', { class: 'pr-card-head' }, h('b', {}, p.author.name), h('span', { class: 'dlg-desc' }, ` opened ${relTime(Date.parse(p.created) / 1000)}`)), mdNode(p.body)));
  for (const c of PR.conversation || []) {
    if (c.kind === 'event') { body.appendChild(h('div', { class: 'pr-event dlg-desc' }, `${c.author} ${c.body}`)); continue; }
    const what = c.kind === 'review' ? ` ${VOTE_TEXT[c.state] === 'Commented' ? 'reviewed' : VOTE_TEXT[c.state].toLowerCase()}` : c.kind === 'code' ? ` commented on ${c.path}${c.line ? `:${c.line}` : ''}` : ' commented';
    const card = h('div', { class: `pr-card${c.kind === 'review' ? ` rv-${c.state}` : ''}` },
      h('div', { class: 'pr-card-head' }, c.kind === 'review' ? h('span', { class: 'rv-ico' }, `${VOTE_ICON[c.state]} `) : null, h('b', {}, c.author), h('span', { class: 'dlg-desc' }, `${what} · ${relTime(Date.parse(c.date) / 1000)}`)));
    if (c.kind === 'code' && c.path) { const a = h('a', { href: '#', class: 'pr-code-link' }, `${c.path}${c.line ? `:${c.line}` : ''}`); a.onclick = (e) => { e.preventDefault(); openFile(prJoin(c.path), c.line || 1); hidePullRequests(); }; card.appendChild(a); }
    if (c.body) card.appendChild(mdNode(c.body));
    body.appendChild(card);
  }
  // add a comment
  const ta = h('textarea', { id: 'prComment', placeholder: 'Leave a comment (Markdown)', rows: 4 });
  const send = h('button', { class: 'primary', id: 'prCommentBtn' }, 'Comment');
  send.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    const r = await api.pr.comment(PR.root, PR.details.number, text);
    send.disabled = false;
    if (r.error) { alert(r.error); return; }
    ta.value = '';
    const c = await api.pr.conversation(PR.root, PR.details.number);
    if (!c.error) PR.conversation = c.result;
    renderPrTabs();
    status('Comment added');
  };
  ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.ctrlKey) send.click(); };
  body.appendChild(h('div', { class: 'pr-compose' }, ta, h('div', { class: 'pr-compose-row' }, h('span', { class: 'dlg-desc' }, 'Ctrl+Enter to send'), send)));
}

async function renderFiles(body) {
  if (!PR.files) {
    body.appendChild(h('div', { class: 'pr-empty' }, 'Fetching the pull request...'));
    const n = PR.details.number;
    const r = await api.pr.files(PR.root, PR.details);
    if (PR.selected !== n) return;
    if (r.error) { body.innerHTML = ''; body.appendChild(h('div', { class: 'pr-empty' }, r.error)); return; }
    PR.files = r.result;
    if (PR.tab === 'files') renderPrTabs();
    return;
  }
  const f = PR.files;
  const total = f.files.reduce((a, x) => ({ add: a.add + (x.added || 0), del: a.del + (x.deleted || 0) }), { add: 0, del: 0 });
  body.appendChild(h('div', { class: 'pr-files-sum dlg-desc' }, `${f.files.length} file${f.files.length === 1 ? '' : 's'} changed, `, h('span', { class: 'gh-plus' }, `+${total.add}`), ' ', h('span', { class: 'gh-minus' }, `−${total.del}`), ' · click a file to see its changes'));
  for (const x of f.files) {
    const name = x.path.split('/').pop();
    const row = h('div', { class: 'gh-file pr-file', title: x.from ? `${x.from} → ${x.path}` : x.path },
      h('span', { class: `gh-st st-${x.status}` }, x.status), h('span', { class: 'label' }, name),
      h('span', { class: 'dlg-desc gh-dir' }, x.from ? `${x.from} →` : x.path.slice(0, x.path.length - name.length).replace(/\/$/, '')),
      h('span', { class: 'gh-plus' }, x.added != null ? `+${x.added}` : ''), h('span', { class: 'gh-minus' }, x.deleted != null ? `−${x.deleted}` : ''));
    row.onclick = async () => {
      const [a, b] = await Promise.all([x.status === 'A' ? '' : api.pr.fileAt(PR.root, f.mergeBase, x.from || x.path), x.status === 'D' ? '' : api.pr.fileAt(PR.root, f.head, x.path)]);
      openTextDiff({ title: `${x.path}  —  #${PR.details.number} ${PR.details.title}  (${PR.details.base.ref} ↔ ${PR.details.head.ref}, read-only)`, original: a, modified: b, path: prJoin(x.path) });
    };
    body.appendChild(row);
  }
}

function renderCommits(body) {
  if (!PR.commits) { body.appendChild(h('div', { class: 'pr-empty' }, 'Loading...')); return; }
  for (const c of PR.commits) {
    body.appendChild(h('div', { class: 'pr-commit' }, h('code', {}, c.sha.slice(0, 8)), h('span', { class: 'label' }, ` ${c.message.split('\n')[0]}`), h('span', { class: 'dlg-desc' }, ` · ${c.author} · ${relTime(Date.parse(c.date) / 1000)}`)));
  }
}
const prJoin = (p) => PR.root + sep() + p.split('/').join(sep());

// ---------------- actions ----------------
async function prAction(label, fn) {
  status(`${label}...`);
  const r = await fn();
  if (r.error) { status(`${label} failed`); alert(`${label} failed:\n\n${r.error}`); return null; }
  status(`${label}: done`);
  return r;
}
async function checkoutPr(p) {
  await saveAll();
  const r = await prAction(`Checkout #${p.number}`, () => api.pr.checkout(PR.root, p));
  if (!r) return;
  const res = r.result;
  log(`\n------ Checkout pull request #${p.number} ------\n${res.stdout || ''}${res.stderr || ''}\n`, res.ok ? 'info' : 'stderr');
  if (!res.ok) { alert(`Checkout failed:\n\n${res.stderr}`); return; }
  await refreshGit();
  reloadCleanTabs();
  status(`Checked out ${res.branch} (#${p.number})`);
  renderPrStatus();
}
async function reviewPr(vote) {
  let body = '';
  if (vote !== 'approve') { body = await ask(vote === 'reject' ? 'What should change?' : 'Review comment'); if (body == null || (vote === 'comment' && !body)) return; }
  const r = await prAction(vote === 'approve' ? 'Approve' : vote === 'reject' ? 'Request changes' : 'Review', () => api.pr.review(PR.root, PR.details.number, vote, body));
  if (r) selectPr(PR.details.number, { keepTab: true });
}
async function mergePr(method) {
  const p = PR.details;
  const how = { merge: 'with a merge commit', squash: 'as one squashed commit', rebase: 'by rebasing its commits' }[method];
  if (!confirm(`Merge #${p.number} "${p.title}" into ${p.base.ref} ${how}?`)) return;
  const r = await prAction(`Merge #${p.number}`, () => api.pr.merge(PR.root, p, method));
  if (!r) return;
  // bring the merged target branch down
  await gitRun('Fetch', () => api.git.fetch(PR.root));
  PR.branchPr.clear();
  await loadPrList(p.number);
  renderPrStatus();
}
async function setPrState(state) {
  const p = PR.details;
  if (state === 'closed' && !confirm(`Close #${p.number} without merging?`)) return;
  const r = await prAction(state === 'open' ? `Reopen #${p.number}` : `Close #${p.number}`, () => api.pr.setState(PR.root, p.number, state));
  if (!r) return;
  PR.branchPr.clear();
  if (PR.filter !== 'all') PR.filter = 'all';
  $('#prFilter').value = PR.filter;
  await loadPrList(p.number);
  renderPrStatus();
}

// ---------------- create ----------------
async function newPullRequest() {
  if (gitState.status == null) await refreshGit();
  const root = prRoot();
  if (!root) { status('Open a Git repository first'); return; }
  const remote = await api.pr.remote(root);
  if (remote.error) { alert(remote.error); return; }
  const ci = await api.pr.createInfo(root);
  if (ci.error) { if (ci.needsToken) return accountsDialog(); alert(ci.error); return; }
  const c = ci.result;
  if (c.branch === c.target) { alert(`You are on ${c.target}. Create a branch with your changes first (Git > New Branch).`); return; }
  const title = h('input', { type: 'text', id: 'prNewTitle', value: c.title, spellcheck: 'false' });
  const desc = h('textarea', { id: 'prNewBody', rows: 8 });
  desc.value = c.body;
  const target = h('select', { id: 'prNewTarget' });
  for (const b of [...new Set([c.target, ...c.branches.filter((b) => b !== c.branch)])]) target.appendChild(h('option', { value: b }, b));
  const draft = h('input', { type: 'checkbox', id: 'prNewDraft' });
  const note = !c.onRemote ? `${c.branch} is not on ${remote.remote} yet: it will be pushed first.` : !c.pushed ? `${c.branch} has local commits that are not pushed: they will be pushed first.` : '';
  const body = h('div', { class: 'pr-create' },
    h('div', { class: 'np-row' }, h('label', {}, 'Into'), target, h('span', { class: 'dlg-desc' }, ` ← from `), h('code', {}, c.branch)),
    h('label', {}, 'Title'), title,
    h('label', {}, 'Description (Markdown)'), desc,
    h('label', { class: 'np-check' }, draft, ' Create as draft'),
    note ? h('div', { class: 'pr-note' }, `ℹ ${note}`) : null,
    h('div', { class: 'dlg-desc' }, `${remoteLabel(remote)} · ${c.ahead} commit${c.ahead === 1 ? '' : 's'}`));
  makeDialog({
    title: 'New Pull Request',
    body,
    buttons: ['spacer',
      { label: 'Create', primary: true, id: 'prCreateBtn', onClick: async (close, b) => {
        if (!title.value.trim()) { title.focus(); return; }
        b.disabled = true; b.textContent = c.pushed ? 'Creating...' : 'Pushing...';
        if (!c.pushed) {
          const p = await gitRun('Push', () => api.git.push(root));
          if (p && p.ok === false) { b.disabled = false; b.textContent = 'Create'; return; }
          b.textContent = 'Creating...';
        }
        const r = await api.pr.create(root, { base: target.value, head: c.branch, title: title.value.trim(), body: desc.value, draft: draft.checked, workItems: c.workItems || [] });
        if (r.error) { b.disabled = false; b.textContent = 'Create'; alert(`Could not create the pull request:\n\n${r.error}`); return; }
        close();
        PR.branchPr.clear();
        status(`Pull request #${r.result.number} created`);
        await showPullRequests({ select: r.result.number, filter: 'open' });
        renderPrStatus();
      } },
      { label: 'Cancel', onClick: (close) => close() }]
  });
  setTimeout(() => title.focus(), 50);
}

// ---------------- accounts ----------------
async function accountsDialog() {
  const root = prRoot();
  const remote = root ? await api.pr.remote(root) : null;
  const saved = await api.pr.accounts();
  const body = h('div', { class: 'pr-accounts' });
  const section = (provider, host, title, help, helpUrl) => {
    const acc = saved.find((a) => a.provider === provider && a.host === host);
    const usedHere = remote && !remote.error && remote.provider === provider && remote.host === host;
    const statusText = acc ? `Signed in as ${acc.user || '?'}${acc.encrypted ? '' : ' (token stored without OS encryption)'}` : usedHere && remote.signedIn ? `Using a token from ${remote.tokenSource}` : 'Not signed in';
    const input = h('input', { type: 'password', placeholder: 'Personal access token', class: 'pr-token', 'data-provider': provider, spellcheck: 'false' });
    const msg = h('span', { class: 'dlg-desc pr-acc-msg' }, statusText);
    const signIn = h('button', { class: 'primary' }, 'Sign in');
    signIn.onclick = async () => {
      if (!input.value.trim()) { input.focus(); return; }
      signIn.disabled = true; msg.textContent = 'Checking the token...';
      const r = await api.pr.signIn(provider, host, input.value.trim(), root);
      signIn.disabled = false;
      if (!r.ok) { msg.textContent = `✖ ${r.error}`; msg.className = 'pr-acc-msg error'; return; }
      input.value = '';
      msg.textContent = `✔ Signed in as ${r.user}${r.encrypted ? '' : ' (stored without OS encryption)'}`; msg.className = 'pr-acc-msg ok';
      PR.branchPr.clear();
      if (PR.open) loadPrList(PR.selected);
      renderPrStatus();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') signIn.click(); };
    const out = h('button', {}, 'Sign out');
    out.disabled = !acc;
    out.onclick = async () => { await api.pr.signOut(provider, host); msg.textContent = 'Signed out'; out.disabled = true; PR.branchPr.clear(); renderPrStatus(); };
    const link = h('a', { href: '#' }, help);
    link.onclick = (e) => { e.preventDefault(); api.openExternal(helpUrl); };
    body.appendChild(h('div', { class: `pr-acc${usedHere ? ' here' : ''}`, 'data-provider': provider },
      h('div', { class: 'pr-acc-title' }, h('b', {}, title), usedHere ? h('span', { class: 'pr-badge' }, 'this repository') : null),
      msg, h('div', { class: 'pr-acc-row' }, input, signIn, out), link));
  };
  const ghHost = remote && !remote.error && remote.provider === 'github' ? remote.host : 'github.com';
  section('github', ghHost, ghHost === 'github.com' ? 'GitHub' : `GitHub Enterprise (${ghHost})`, 'Create a token (scope: repo)', `https://${ghHost}/settings/tokens/new?scopes=repo&description=Nova%20IDE`);
  const azOrg = remote && !remote.error && remote.provider === 'azure' ? remote.org : null;
  section('azure', 'dev.azure.com', 'Azure DevOps', 'Create a token (Code: Read & write)', azOrg ? `https://dev.azure.com/${encodeURIComponent(azOrg)}/_usersSettings/tokens` : 'https://dev.azure.com/');
  body.appendChild(h('p', { class: 'dlg-desc' }, 'Tokens are stored encrypted with Windows (DPAPI) in your Nova IDE settings folder. A signed-in GitHub CLI (gh) or a GITHUB_TOKEN variable also works without signing in here.'));
  makeDialog({ title: 'Git Accounts', body, buttons: ['spacer', { label: 'Close', primary: true, onClick: (close) => close() }] });
}

// ---------------- the current branch's pull request (status bar) ----------------
let prStatusTimer = null;
async function renderPrStatus() {
  const el = $('#stPr');
  const s = gitState.status;
  if (!s || !s.repo || !s.branch || s.branch === 'HEAD' || /^\(/.test(s.branch)) { el.classList.add('hidden'); return; }
  const key = `${s.root}|${s.branch}`;
  let fresh = false;
  if (!PR.branchPr.has(key)) {
    PR.branchPr.set(key, undefined); // being checked
    // any failure (no remote, not signed in, git busy, network) leaves no mark, so the next refresh tries again
    const remote = await api.pr.remote(s.root).catch((e) => ({ error: e.message }));
    if (remote.error || !remote.signedIn) { PR.branchPr.delete(key); el.classList.add('hidden'); return; }
    const r = await api.pr.list(s.root, { state: 'open', head: s.branch }).catch((e) => ({ error: e.message }));
    if (r.error) { PR.branchPr.delete(key); el.classList.add('hidden'); return; }
    PR.branchPr.set(key, r.result.length ? r.result[0] : null);
    fresh = true;
  }
  const p = PR.branchPr.get(key);
  el.classList.toggle('hidden', !p);
  if (p) { el.textContent = `⇄ #${p.number}`; el.title = `Pull request #${p.number}: ${p.title}\n${p.head.ref} → ${p.base.ref}\nClick to open`; el.onclick = () => showPullRequests({ select: p.number, filter: 'open' }); }
  // Git Changes shows "Create a Pull Request" when the branch has none
  if (fresh) renderGit();
}

// "Create a Pull Request" in Git Changes, like Visual Studio after a push
function prLink(s) {
  const key = `${s.root}|${s.branch}`;
  if (PR.branchPr.get(key) !== null || !s.upstream || s.ahead) return null;
  if (/^(main|master|develop|trunk)$/.test(s.branch)) return null;
  const a = h('a', { href: '#', class: 'git-pr-link', id: 'gitCreatePr' }, '⇄ Create a Pull Request');
  a.onclick = (e) => { e.preventDefault(); newPullRequest(); };
  return h('div', { class: 'git-pr-row' }, a);
}

// ---------------- wiring ----------------
$('#prClose').onclick = hidePullRequests;
$('#prRefresh').onclick = () => loadPrList(PR.selected);
$('#prNew').onclick = () => newPullRequest();
$('#prWeb').onclick = () => { if (PR.remote) api.pr.list && api.openExternal(PR.remote.provider === 'github' ? `https://${PR.remote.host}/${PR.remote.owner}/${PR.remote.repo}/pulls` : `https://dev.azure.com/${PR.remote.org}/${PR.remote.project}/_git/${PR.remote.repo}/pullrequests`); };
$('#prFilter').onchange = () => { PR.filter = $('#prFilter').value; loadPrList(); };
$('#prSearch').oninput = () => { PR.query = $('#prSearch').value.trim(); renderPrList(); };
$('#prSearch').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { $('#prSearch').value = ''; PR.query = ''; renderPrList(); } };
$('#prView').onkeydown = (e) => { if (e.key === 'Escape' && !e.target.closest('textarea,input')) hidePullRequests(); };

Object.assign(commands, {
  pullRequests: () => showPullRequests(),
  newPullRequest: () => newPullRequest(),
  gitAccounts: () => accountsDialog()
});

const _activatePR = activate;
activate = function (tab) { if (PR.open) hidePullRequests(); _activatePR(tab); }; // eslint-disable-line no-func-assign
const _refreshGitPR = refreshGit;
// after each Git refresh; one check at a time, and a refresh during a check runs one more afterwards
// (the branch may have changed meanwhile). No timer: hidden windows slow timers down a lot.
let prStatusAgain = false;
function checkPrStatus() {
  if (prStatusTimer) { prStatusAgain = true; return; }
  prStatusTimer = renderPrStatus().catch(() => {}).finally(() => {
    prStatusTimer = null;
    if (prStatusAgain) { prStatusAgain = false; checkPrStatus(); }
  });
}
refreshGit = async function () {
  const r = await _refreshGitPR.apply(this, arguments);
  checkPrStatus();
  return r;
}; // eslint-disable-line no-func-assign
bus.on('folder', () => { hidePullRequests(); PR.branchPr.clear(); $('#stPr').classList.add('hidden'); });

window.PR = PR;
window.showPullRequests = showPullRequests;
window.mdToHtml = mdToHtml;
window.prLink = prLink;
