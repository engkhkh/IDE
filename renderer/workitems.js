// Nova IDE - work items (GitHub Issues / Azure Boards): window, new item, branch from item,
// "#" suggestions in the commit message, and #123 links in history and pull requests
'use strict';

const WI = { open: false, root: null, info: null, query: 'mine', text: '', list: [], selected: null, item: null, cache: { at: 0, root: null, items: [] }, token: 0 };
const WI_TYPE = { Bug: ['🐞', '#cc293d'], Task: ['☑', '#f2cb1d'], 'User Story': ['📘', '#009ccc'], 'Product Backlog Item': ['📘', '#009ccc'], Feature: ['🏆', '#773b93'], Epic: ['👑', '#ff7b00'], Issue: ['◉', '#3fb950'] };
const wiType = (t) => WI_TYPE[t] || ['▣', '#8b949e'];
const wiRoot = () => (gitState.status && gitState.status.repo ? gitState.status.root : null);
// the same rule as the main process: feature/12-short-title
function wiBranchName(item, prefix = 'feature') {
  const slug = String(item.title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-');
  return `${prefix}/${item.id}${slug ? `-${slug}` : ''}`.slice(0, 80).replace(/-+$/, '');
}

// ---------------- window ----------------
async function showWorkItems({ select = null, query = null } = {}) {
  if (gitState.status == null) await refreshGit();
  const root = wiRoot();
  if (!root) { status('Open a Git repository first'); return; }
  const info = await api.wi.info(root);
  if (info.error && info.noRemote) { alert(info.error); return; }
  if (typeof hidePullRequests === 'function' && PR.open) hidePullRequests();
  if (typeof hideHistory === 'function' && GH.open) hideHistory();
  closeDiff();
  WI.open = true; WI.root = root; WI.info = info.result || null;
  $('#wiView').classList.remove('hidden');
  const remote = await api.pr.remote(root);
  $('#wiTitle').textContent = `Work Items · ${remote.provider === 'github' ? `GitHub · ${remote.owner}/${remote.repo}` : `Azure Boards · ${remote.org}/${remote.project}`}`;
  const sel = $('#wiQuery');
  sel.innerHTML = '';
  for (const [v, label] of (WI.info ? WI.info.queries : [['mine', 'Assigned to me']])) sel.appendChild(h('option', { value: v }, label));
  if (query) WI.query = query;
  if (![...sel.options].some((o) => o.value === WI.query)) WI.query = sel.options[0].value;
  sel.value = WI.query;
  if (info.error) { wiError($('#wiList'), info); $('#wiDetails').innerHTML = ''; return; }
  await loadWorkItems(select);
}
function hideWorkItems() { WI.open = false; $('#wiView').classList.add('hidden'); }

function wiError(host, r) {
  host.innerHTML = '';
  if (r.needsToken) {
    const b = h('button', { class: 'primary', id: 'wiSignIn' }, 'Sign in...');
    b.onclick = () => accountsDialog();
    host.append(h('div', { class: 'pr-signin' }, h('h3', {}, `Sign in to ${r.provider === 'azure' ? 'Azure DevOps' : 'GitHub'}`), h('p', {}, r.error), b));
  } else host.append(h('div', { class: 'pr-empty' }, r.error || 'Something went wrong.'));
}

async function loadWorkItems(select = null) {
  const token = ++WI.token;
  $('#wiList').innerHTML = '<div class="pr-empty">Loading...</div>';
  const r = await api.wi.list(WI.root, { query: WI.query, text: WI.text });
  if (token !== WI.token) return;
  if (r.error) { WI.list = []; wiError($('#wiList'), r); $('#wiDetails').innerHTML = ''; return; }
  WI.list = r.result;
  renderWorkItemList();
  const pick = select || (WI.selected && WI.list.some((i) => i.id === WI.selected) ? WI.selected : WI.list[0] && WI.list[0].id);
  if (pick) selectWorkItem(pick); else { WI.selected = null; $('#wiDetails').innerHTML = '<div class="pr-empty">No work items.</div>'; }
}

function renderWorkItemList() {
  const host = $('#wiList');
  host.innerHTML = '';
  if (!WI.list.length) { host.appendChild(h('div', { class: 'pr-empty' }, WI.text ? 'Nothing matches the search.' : 'No work items.')); return; }
  for (const i of WI.list) {
    const [ico, color] = wiType(i.type);
    const row = h('div', { class: `pr-item wi-item${i.id === WI.selected ? ' selected' : ''}`, 'data-id': i.id },
      h('div', { class: 'pr-item-title' }, h('span', { class: 'wi-ico', style: `color:${color}`, title: i.type }, ico), h('span', { class: 'pr-num' }, `#${i.id}`), h('span', { class: 'label' }, i.title)),
      h('div', { class: 'pr-item-meta dlg-desc' }, `${i.type} · ${i.state}${i.assignees.length ? ` · ${i.assignees.join(', ')}` : ' · unassigned'} · ${relTime(Date.parse(i.updated) / 1000)}`));
    row.onclick = () => selectWorkItem(i.id);
    host.appendChild(row);
  }
}

async function selectWorkItem(id) {
  WI.selected = id;
  renderWorkItemList();
  const host = $('#wiDetails');
  host.innerHTML = '<div class="pr-empty">Loading...</div>';
  const r = await api.wi.get(WI.root, id);
  if (WI.selected !== id) return;
  if (r.error) { wiError(host, r); return; }
  WI.item = r.result;
  renderWorkItem();
}

function renderWorkItem() {
  const i = WI.item;
  const host = $('#wiDetails');
  host.innerHTML = '';
  const [ico, color] = wiType(i.type);
  const head = h('div', { class: 'pr-head' },
    h('div', { class: 'pr-title' }, h('span', { class: 'wi-ico', style: `color:${color}` }, `${ico} `), i.title, h('span', { class: 'pr-num' }, ` #${i.id}`)),
    h('div', { class: 'pr-sub' },
      h('span', { class: 'wi-type', style: `border-color:${color}` }, i.type), ' ',
      h('span', { class: `pr-badge ${i.category === 'closed' ? 'st-closed wi-closed' : 'st-open'}` }, i.state),
      h('span', { class: 'dlg-desc' }, `  Created by ${i.author}${i.created ? ` ${relTime(Date.parse(i.created) / 1000)}` : ''} · updated ${relTime(Date.parse(i.updated) / 1000)}`)));
  const act = h('div', { class: 'pr-actions' });
  const btn = (label, title, fn, cls) => { const b = h('button', { class: cls || '', title }, label); b.onclick = (e) => { e.stopPropagation(); fn(e); }; act.appendChild(b); return b; };
  btn('State ▾', 'Change the state', (e) => { const r = e.target.getBoundingClientRect(); popup(r.left, r.bottom, (i.states || []).map((st) => ({ label: st, run: () => setWorkItemState(st) }))); });
  btn('Assign to Me', 'Assign this work item to yourself', () => assignWorkItemToMe());
  btn('Create Branch...', 'Create a branch for this work item', () => createBranchDialog(i), 'primary');
  btn('Add to Commit Message ▾', 'Mention it in the commit message in Git Changes', (e) => { const r = e.target.getBoundingClientRect(); popup(r.left, r.bottom, [
    { label: `Mention (#${i.id})`, run: () => addToCommitMessage(i, false) },
    { label: `Fixes #${i.id} (closes it when merged)`, run: () => addToCommitMessage(i, true) }]); });
  btn('Open in Browser', 'Open on the web', () => api.openExternal(i.url));
  head.appendChild(act);
  // facts
  const side = h('div', { class: 'pr-facts' });
  side.appendChild(h('div', { class: 'pr-facts-title' }, 'Assigned to'));
  side.appendChild(h('div', { class: i.assignees.length ? '' : 'dlg-desc' }, i.assignees.length ? i.assignees.join(', ') : 'Nobody'));
  if (i.labels.length) {
    side.appendChild(h('div', { class: 'pr-facts-title' }, i.labels.length && WI.info && WI.info.provider === 'azure' ? 'Tags' : 'Labels'));
    const ls = h('div', {});
    for (const l of i.labels) ls.appendChild(h('span', { class: 'pr-label', style: l.color ? `border-color:${l.color}` : '' }, l.name));
    side.appendChild(ls);
  }
  side.appendChild(h('div', { class: 'pr-facts-title' }, 'Development'));
  if (!i.links.length) side.appendChild(h('div', { class: 'dlg-desc' }, 'No linked branches, commits or pull requests'));
  for (const l of i.links) {
    const icon = { pr: '⇄', commit: '◆', branch: '⎇', item: '▣' }[l.kind];
    const a = h('a', { href: '#', class: 'wi-link', 'data-kind': l.kind }, `${icon} ${l.kind === 'pr' ? `#${l.id} ${l.title}` : l.title}`);
    a.onclick = (e) => {
      e.preventDefault();
      if (l.kind === 'pr') showPullRequests({ select: l.id, filter: 'all' });
      else if (l.kind === 'commit') showHistory({ select: l.id });
      else if (l.kind === 'item') selectWorkItem(l.id);
      else if (l.kind === 'branch') status(`Branch ${l.id}`);
    };
    side.appendChild(h('div', {}, a));
  }
  const body = h('div', { class: 'pr-left' });
  body.appendChild(h('div', { class: 'pr-card' }, h('div', { class: 'pr-card-head' }, h('b', {}, 'Description')), mdNode(i.body)));
  for (const c of i.commentList || []) body.appendChild(h('div', { class: 'pr-card' }, h('div', { class: 'pr-card-head' }, h('b', {}, c.author), h('span', { class: 'dlg-desc' }, ` commented · ${relTime(Date.parse(c.date) / 1000)}`)), mdNode(c.body)));
  const ta = h('textarea', { id: 'wiComment', placeholder: 'Add a comment', rows: 3 });
  const send = h('button', { class: 'primary', id: 'wiCommentBtn' }, 'Comment');
  send.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    const r = await api.wi.comment(WI.root, i.id, text);
    send.disabled = false;
    if (r.error) { alert(r.error); return; }
    status('Comment added');
    selectWorkItem(i.id);
  };
  ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.ctrlKey) send.click(); };
  body.appendChild(h('div', { class: 'pr-compose' }, ta, h('div', { class: 'pr-compose-row' }, h('span', { class: 'dlg-desc' }, 'Ctrl+Enter to send'), send)));
  host.append(head, h('div', { class: 'pr-main' }, body, side));
}

// ---------------- actions ----------------
async function setWorkItemState(st) {
  const r = await api.wi.setState(WI.root, WI.item.id, st);
  if (r.error) { alert(`Could not change the state:\n\n${r.error}`); return; }
  status(`#${WI.item.id} is now ${st}`);
  WI.cache.at = 0;
  await loadWorkItems(WI.item.id);
}
async function assignWorkItemToMe() {
  const r = await api.wi.assignToMe(WI.root, WI.item.id);
  if (r.error) { alert(`Could not assign it:\n\n${r.error}`); return; }
  status(`#${WI.item.id} is assigned to you`);
  WI.cache.at = 0;
  selectWorkItem(WI.item.id);
}
function addToCommitMessage(item, closes) {
  const text = closes ? `Fixes #${item.id}` : `#${item.id}`;
  showSide('git');
  const box = $('#gitMsg');
  if (!box) { status('Git Changes is not available here'); return; }
  const v = box.value.replace(/\s+$/, '');
  if (new RegExp(`#${item.id}\\b`).test(v)) { status(`#${item.id} is already in the commit message`); box.focus(); return; }
  box.value = v ? `${v}${/\n/.test(v) ? '\n' : '\n\n'}${text}` : `${item.title}\n\n${text}`;
  gitState.draft = box.value;
  box.dispatchEvent(new Event('input'));
  box.focus();
  status(`Added ${text} to the commit message`);
}

async function createBranchDialog(item) {
  const root = WI.root || wiRoot();
  const branches = await api.git.branches(root);
  const current = (branches.find((b) => b.current) || {}).name;
  const name = h('input', { type: 'text', id: 'wiBranchName', value: wiBranchName(item), spellcheck: 'false' });
  const base = h('select', { id: 'wiBranchBase' });
  const remoteDefault = branches.find((b) => /^origin\/(main|master)$/.test(b.name));
  for (const b of branches) base.appendChild(h('option', { value: b.name }, `${b.name}${b.current ? ' (current)' : ''}`));
  base.value = remoteDefault ? remoteDefault.name : current || (branches[0] && branches[0].name);
  const checkout = h('input', { type: 'checkbox', id: 'wiBranchCheckout', checked: true });
  const azure = WI.info && WI.info.canLinkBranch;
  makeDialog({
    title: `Create a Branch for #${item.id}`,
    body: h('div', { class: 'pr-create' },
      h('label', {}, 'Branch name'), name,
      h('label', {}, 'Based on'), base,
      h('label', { class: 'np-check' }, checkout, ' Check out the new branch'),
      azure ? h('div', { class: 'pr-note' }, `ℹ The branch will be linked to #${item.id} in Azure Boards.`) : h('div', { class: 'dlg-desc' }, `Tip: mention #${item.id} in your commit messages to link them.`)),
    buttons: ['spacer',
      { label: 'Create', primary: true, id: 'wiBranchCreate', onClick: async (close, b) => {
        b.disabled = true;
        await saveAll();
        const r = await api.wi.createBranch(root, item, { name: name.value.trim(), base: base.value, checkout: checkout.checked });
        b.disabled = false;
        const res = r.result || {};
        if (r.error || !res.ok) { alert(`Could not create the branch:\n\n${r.error || res.stderr}`); return; }
        close();
        await refreshGit();
        reloadCleanTabs();
        status(`Created ${name.value.trim()}${res.linked ? ` and linked it to #${item.id}` : ''}${res.linkError ? ` (link failed: ${res.linkError})` : ''}`);
        if (WI.open && WI.item && WI.item.id === item.id) selectWorkItem(item.id);
      } },
      { label: 'Cancel', onClick: (close) => close() }]
  });
  setTimeout(() => { name.focus(); name.select(); }, 50);
}

async function newWorkItem() {
  if (gitState.status == null) await refreshGit();
  const root = wiRoot();
  if (!root) { status('Open a Git repository first'); return; }
  const tr = await api.wi.types(root);
  if (tr.error) { if (tr.needsToken) return accountsDialog(); alert(tr.error); return; }
  const type = h('select', { id: 'wiNewType' });
  for (const t of tr.result) type.appendChild(h('option', { value: t }, t));
  if (tr.result.includes('Task')) type.value = 'Task';
  const title = h('input', { type: 'text', id: 'wiNewTitle', spellcheck: 'false' });
  const desc = h('textarea', { id: 'wiNewBody', rows: 6 });
  const labels = h('input', { type: 'text', id: 'wiNewLabels', placeholder: tr.provider === 'azure' ? 'tags, comma separated' : 'labels, comma separated', spellcheck: 'false' });
  const mine = h('input', { type: 'checkbox', id: 'wiNewMine', checked: true });
  makeDialog({
    title: 'New Work Item',
    body: h('div', { class: 'pr-create' },
      tr.result.length > 1 ? h('div', { class: 'np-row' }, h('label', {}, 'Type'), type) : null,
      h('label', {}, 'Title'), title,
      h('label', {}, 'Description'), desc,
      h('label', {}, tr.provider === 'azure' ? 'Tags' : 'Labels'), labels,
      h('label', { class: 'np-check' }, mine, ' Assign to me')),
    buttons: ['spacer',
      { label: 'Create', primary: true, id: 'wiCreateBtn', onClick: async (close, b) => {
        if (!title.value.trim()) { title.focus(); return; }
        b.disabled = true;
        const r = await api.wi.create(root, { type: type.value || 'Issue', title: title.value.trim(), body: desc.value, assignToMe: mine.checked, labels: labels.value.split(',').map((x) => x.trim()).filter(Boolean) });
        b.disabled = false;
        if (r.error) { alert(`Could not create the work item:\n\n${r.error}`); return; }
        close();
        WI.cache.at = 0;
        status(`Created #${r.result.id}`);
        await showWorkItems({ select: r.result.id, query: mine.checked ? 'mine' : WI.query });
      } },
      { label: 'Cancel', onClick: (close) => close() }]
  });
  setTimeout(() => title.focus(), 50);
}

// ---------------- "#" suggestions in the commit message ----------------
async function wiCandidates() {
  const root = wiRoot();
  if (!root) return [];
  if (WI.cache.root === root && Date.now() - WI.cache.at < 120000) return WI.cache.items;
  const [a, b] = await Promise.all([api.wi.list(root, { query: 'mine' }), api.wi.list(root, { query: 'open' })]);
  const seen = new Map();
  for (const r of [a, b]) if (!r.error) for (const i of r.result) if (!seen.has(i.id)) seen.set(i.id, i);
  WI.cache = { at: Date.now(), root, items: [...seen.values()], error: a.error && b.error ? a.error : null };
  return WI.cache.items;
}
let wiSuggest = null;
function closeWiSuggest() { if (wiSuggest) { wiSuggest.el.remove(); wiSuggest = null; } }
async function updateWiSuggest(box) {
  const upto = box.value.slice(0, box.selectionStart);
  const m = /(^|[\s(])#([^\s#]*)$/.exec(upto);
  if (!m) { closeWiSuggest(); return; }
  const q = m[2].toLowerCase();
  const start = box.selectionStart - m[2].length - 1;
  const items = await wiCandidates();
  if (box.value.slice(0, box.selectionStart) !== upto) return; // typed on meanwhile
  const matches = items.filter((i) => (/^\d+$/.test(q) ? String(i.id).startsWith(q) : !q || i.title.toLowerCase().includes(q))).slice(0, 8);
  if (!matches.length) { closeWiSuggest(); return; }
  if (!wiSuggest) { wiSuggest = { el: h('div', { class: 'wi-suggest', id: 'wiSuggest' }), index: 0 }; document.body.appendChild(wiSuggest.el); }
  wiSuggest.items = matches; wiSuggest.start = start; wiSuggest.box = box;
  wiSuggest.index = Math.min(wiSuggest.index, matches.length - 1);
  const r = box.getBoundingClientRect();
  Object.assign(wiSuggest.el.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, width: `${Math.max(r.width, 320)}px` });
  wiSuggest.el.innerHTML = '';
  matches.forEach((i, n) => {
    const [ico, color] = wiType(i.type);
    const row = h('div', { class: `wi-sug${n === wiSuggest.index ? ' active' : ''}` }, h('span', { class: 'wi-ico', style: `color:${color}` }, ico), h('b', {}, ` #${i.id} `), h('span', {}, i.title), h('span', { class: 'dlg-desc' }, ` · ${i.state}`));
    row.onmousedown = (e) => { e.preventDefault(); pickWiSuggest(n); };
    wiSuggest.el.appendChild(row);
  });
}
function pickWiSuggest(n) {
  const s = wiSuggest;
  if (!s) return;
  const i = s.items[n];
  const box = s.box;
  const before = box.value.slice(0, s.start), after = box.value.slice(box.selectionStart);
  box.value = `${before}#${i.id} ${after.replace(/^\s+/, '')}`;
  const pos = before.length + String(i.id).length + 2;
  box.setSelectionRange(pos, pos);
  gitState.draft = box.value;
  closeWiSuggest();
  box.focus();
}
function attachWiSuggest(box) {
  if (!box || box.__wi) return;
  box.__wi = true;
  box.addEventListener('input', () => updateWiSuggest(box));
  box.addEventListener('blur', () => setTimeout(closeWiSuggest, 150));
  box.addEventListener('keydown', (e) => {
    if (!wiSuggest) return;
    const n = wiSuggest.items.length;
    if (e.key === 'ArrowDown') { wiSuggest.index = (wiSuggest.index + 1) % n; updateWiSuggest(box); }
    else if (e.key === 'ArrowUp') { wiSuggest.index = (wiSuggest.index - 1 + n) % n; updateWiSuggest(box); }
    else if (e.key === 'Enter' || e.key === 'Tab') pickWiSuggest(wiSuggest.index);
    else if (e.key === 'Escape') closeWiSuggest();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
}

// ---------------- #123 links in history and pull requests ----------------
function wiLinkify(el) {
  if (!el || !wiRoot()) return el;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('a, code, pre.code, .wi-mention') ? NodeFilter.FILTER_REJECT : /#\d/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const t of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = t.nodeValue;
    for (const m of text.matchAll(/(^|[^\w&/])((?:AB)?#(\d{1,7}))\b/g)) {
      const at = m.index + m[1].length;
      frag.appendChild(document.createTextNode(text.slice(last, at)));
      const a = h('a', { href: '#', class: 'wi-mention', title: `Open work item #${m[3]}`, 'data-id': m[3] }, m[2]);
      a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openWorkItemLink(+m[3]); };
      frag.appendChild(a);
      last = at + m[2].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
  return el;
}
// on GitHub "#12" may be a pull request
async function openWorkItemLink(id) {
  const root = wiRoot();
  const r = await api.wi.get(root, id);
  if (r.error && /pull request/i.test(r.error)) { showPullRequests({ select: id, filter: 'all' }); return; }
  await showWorkItems({ select: id, query: WI.query });
}

// the history, pull request and work item views share one layer: one at a time
const _showHistoryWI = showHistory;
showHistory = async function () { if (WI.open) hideWorkItems(); if (PR.open) hidePullRequests(); return _showHistoryWI.apply(this, arguments); }; // eslint-disable-line no-func-assign
window.showHistory = showHistory;
const _showDetailsWI = showDetails;
showDetails = async function (hash) { const r = await _showDetailsWI(hash); wiLinkify(document.querySelector('#ghDetails .gh-d-subject')); wiLinkify(document.querySelector('#ghDetails .gh-d-body')); return r; }; // eslint-disable-line no-func-assign
const _mdNodeWI = mdNode;
mdNode = function (md, cls) { return wiLinkify(_mdNodeWI(md, cls)); }; // eslint-disable-line no-func-assign
const _renderGitWI = renderGit;
renderGit = function () { const r = _renderGitWI.apply(this, arguments); attachWiSuggest(document.querySelector('#gitMsg')); return r; }; // eslint-disable-line no-func-assign

// ---------------- wiring ----------------
$('#wiClose').onclick = hideWorkItems;
$('#wiRefresh').onclick = () => { WI.cache.at = 0; loadWorkItems(WI.selected); };
$('#wiNew').onclick = () => newWorkItem();
$('#wiWeb').onclick = () => { if (WI.info) api.openExternal(WI.info.listUrl); };
$('#wiQuery').onchange = () => { WI.query = $('#wiQuery').value; loadWorkItems(); };
let wiSearchTimer = null;
$('#wiSearch').oninput = () => { clearTimeout(wiSearchTimer); wiSearchTimer = setTimeout(() => { WI.text = $('#wiSearch').value.trim(); loadWorkItems(); }, 300); };
$('#wiSearch').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { $('#wiSearch').value = ''; WI.text = ''; loadWorkItems(); } };
$('#wiView').onkeydown = (e) => { if (e.key === 'Escape' && !e.target.closest('textarea,input')) hideWorkItems(); };

Object.assign(commands, {
  workItems: () => showWorkItems(),
  newWorkItem: () => newWorkItem()
});
const _activateWI = activate;
activate = function (tab) { if (WI.open) hideWorkItems(); _activateWI(tab); }; // eslint-disable-line no-func-assign
bus.on('folder', () => { hideWorkItems(); WI.cache = { at: 0, root: null, items: [] }; closeWiSuggest(); });

window.WI = WI;
window.showWorkItems = showWorkItems;
window.wiLinkify = wiLinkify;
