// Nova IDE - Git Repository window (branch history graph, commit details), file history and blame
'use strict';

const GH = {
  open: false,
  root: null,
  file: null,          // file history mode
  ref: 'all',
  search: '',
  commits: [],
  rows: [],            // graph rows (null in search / file mode)
  graphState: null,
  done: false,
  loading: false,
  selected: null,      // hash
  details: null,
  refs: null,
  token: 0
};
const ROW_H = 24, LANE_W = 12;
const LANE_COLORS = ['#3794ff', '#f9826c', '#73c991', '#c586c0', '#e2c08d', '#4ec9b0', '#f14c4c', '#b5cea8', '#d7ba7d', '#9cdcfe'];
const laneColor = (n) => LANE_COLORS[n % LANE_COLORS.length];
const shortHash = (h) => (h || '').slice(0, 8);
const fullDate = (t) => new Date(t * 1000).toLocaleString();
function relTime(t) {
  const s = Date.now() / 1000 - t;
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v === 1 ? '' : 's'} ago`; }
  return 'just now';
}
const fmtDate = (t) => { const d = new Date(t * 1000); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; };
const gitRoot = () => gitState.status && gitState.status.repo ? gitState.status.root : null;

// ---------------- opening ----------------
async function showHistory({ file = null, ref = null, select = null } = {}) {
  if (gitState.status == null) await refreshGit();
  const root = gitRoot();
  if (!root) { status(gitState.status && gitState.status.gitInstalled === false ? 'Git is not installed' : 'This folder is not a Git repository'); return; }
  closeDiff();
  GH.open = true;
  GH.root = root;
  GH.file = file;
  GH.ref = ref || (file ? 'all' : GH.ref || 'all');
  GH.search = '';
  $('#ghSearch').value = '';
  $('#historyView').classList.remove('hidden');
  $('#historyView').classList.toggle('file-mode', !!file);
  $('#ghTitle').textContent = file ? `History - ${relPath(file)}` : 'Git Repository';
  await loadRefs();
  await reloadHistory(select);
  $('#ghList').focus();
}
function hideHistory() {
  GH.open = false;
  $('#historyView').classList.add('hidden');
}
const relPath = (p) => { const r = GH.root || gitRoot() || ''; return p.startsWith(r) ? p.slice(r.length + 1).replace(/\\/g, '/') : p; };

async function loadRefs() {
  GH.refs = await api.githist.refs(GH.root);
  const sel = $('#ghRef');
  sel.innerHTML = '';
  const opt = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); };
  opt('all', 'All branches');
  for (const b of GH.refs.local) opt(b.name, b.current ? `${b.name} (current)` : b.name);
  for (const b of GH.refs.remote) opt(b.name, b.name);
  if (![...sel.options].some((o) => o.value === GH.ref)) GH.ref = 'all';
  sel.value = GH.ref;
  renderBranches();
}

async function reloadHistory(select = null) {
  const token = ++GH.token;
  GH.commits = []; GH.rows = []; GH.graphState = null; GH.done = false; GH.details = null;
  GH.selected = select || null;
  $('#ghList').scrollTop = 0;
  await loadMore(token);
  if (token !== GH.token) return;
  if (!GH.selected && GH.commits.length) GH.selected = GH.commits[0].hash;
  // a commit further back: keep loading until it shows up
  while (GH.selected && !GH.commits.some((c) => c.hash === GH.selected) && !GH.done && token === GH.token) await loadMore(token);
  renderList();
  scrollToSelected();
  if (GH.selected) showDetails(GH.selected);
}

async function loadMore(token = GH.token) {
  if (GH.loading || GH.done) return;
  GH.loading = true;
  $('#ghStatus').textContent = 'Loading...';
  const r = await api.githist.log(GH.root, { ref: GH.ref, skip: GH.commits.length, limit: 400, file: GH.file, search: GH.search, graphState: GH.graphState });
  GH.loading = false;
  if (token !== GH.token) return;
  if (r.error) { $('#ghStatus').textContent = r.error; GH.done = true; renderList(); return; }
  GH.commits.push(...r.commits);
  if (r.rows) GH.rows.push(...r.rows); else GH.rows = null;
  GH.graphState = r.graphState || null;
  GH.done = r.done;
  $('#ghStatus').textContent = `${GH.commits.length}${GH.done ? '' : '+'} commit${GH.commits.length === 1 ? '' : 's'}${GH.search ? ` matching "${GH.search}"` : ''}`;
  renderList();
}

// ---------------- branches pane ----------------
function renderBranches() {
  const host = $('#ghBranches');
  host.innerHTML = '';
  if (!GH.refs) return;
  const group = (title, items, kind) => {
    if (!items.length) return;
    host.appendChild(h('div', { class: 'gh-group' }, title));
    for (const b of items) {
      const d = h('div', { class: `gh-ref${b.current ? ' current' : ''}${GH.ref === b.name ? ' selected' : ''}`, title: `${b.name}${b.upstream ? ` → ${b.upstream}${b.track ? ` (${b.track})` : ''}` : ''}\n${b.hash.slice(0, 8)}` },
        h('span', { class: 'gh-ref-ico' }, kind === 'tag' ? '🏷' : b.current ? '★' : '⎇'), h('span', { class: 'label' }, b.name),
        b.track ? h('span', { class: 'gh-track' }, b.track.replace('ahead ', '↑').replace('behind ', '↓').replace(', ', ' ')) : null);
      d.onclick = () => { if (kind === 'tag') { selectCommit(b.hash, true); return; } GH.ref = b.name; $('#ghRef').value = b.name; renderBranches(); reloadHistory(); };
      d.ondblclick = () => { if (kind === 'local' && !b.current) historyOp('checkout', { ref: b.name }, `Checkout ${b.name}`); };
      d.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); refMenu(e.clientX, e.clientY, b, kind); };
      host.appendChild(d);
    }
  };
  const all = h('div', { class: `gh-ref${GH.ref === 'all' ? ' selected' : ''}` }, h('span', { class: 'gh-ref-ico' }, '⋔'), h('span', { class: 'label' }, 'All branches'));
  all.onclick = () => { GH.ref = 'all'; $('#ghRef').value = 'all'; renderBranches(); reloadHistory(); };
  host.appendChild(all);
  group('Branches', GH.refs.local, 'local');
  group('Remotes', GH.refs.remote, 'remote');
  group('Tags', GH.refs.tags, 'tag');
}

function refMenu(x, y, b, kind) {
  const items = [];
  if (kind === 'local') {
    items.push({ label: 'Checkout', disabled: b.current, run: () => historyOp('checkout', { ref: b.name }, `Checkout ${b.name}`) });
    items.push({ label: `Merge '${b.name}' into current branch`, disabled: b.current, run: () => historyOp('merge', { ref: b.name }, `Merge ${b.name}`) });
    items.push({ label: 'New Branch from here...', run: () => newBranchAt(b.name) });
    items.push('-');
    items.push({ label: 'Delete', disabled: b.current, run: async () => {
      if (!confirm(`Delete branch '${b.name}'?`)) return;
      const r = await historyOp('deleteBranch', { name: b.name }, `Delete branch ${b.name}`, { quiet: true });
      if (r && !r.ok && /not fully merged/.test(r.stderr) && confirm(`'${b.name}' is not fully merged. Delete it anyway (its commits may be lost)?`)) historyOp('deleteBranch', { name: b.name, force: true }, `Delete branch ${b.name}`);
    } });
  } else if (kind === 'remote') {
    items.push({ label: 'Checkout as new local branch', run: () => historyOp('branch', { name: b.name.replace(/^[^/]+\//, ''), at: b.name, checkout: true }, `Checkout ${b.name}`) });
    items.push({ label: `Merge '${b.name}' into current branch`, run: () => historyOp('merge', { ref: b.name }, `Merge ${b.name}`) });
  } else {
    items.push({ label: 'Show commit', run: () => selectCommit(b.hash, true) });
    items.push({ label: 'Delete tag', run: () => confirm(`Delete tag '${b.name}'?`) && historyOp('deleteTag', { name: b.name }, `Delete tag ${b.name}`) });
  }
  items.push({ label: 'Copy name', run: () => navigator.clipboard.writeText(b.name) });
  popup(x, y, items);
}

// ---------------- commit list (virtual scrolling) ----------------
function graphSvg(row, width) {
  const w = Math.max(width, 1) * LANE_W + 6;
  const X = (l) => 8 + l * LANE_W;
  const Y = [0, ROW_H / 2, ROW_H];
  let s = `<svg class="gh-graph" width="${w}" height="${ROW_H}">`;
  for (const [x1, y1, x2, y2, c] of row.segs) {
    const ax = X(x1), ay = Y[y1], bx = X(x2), by = Y[y2];
    if (ax === bx) s += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${laneColor(c)}" stroke-width="2"/>`;
    else {
      const my = (ay + by) / 2;
      s += `<path d="M${ax} ${ay} C ${ax} ${my}, ${bx} ${my}, ${bx} ${by}" fill="none" stroke="${laneColor(c)}" stroke-width="2"/>`;
    }
  }
  const c = laneColor(row.color);
  s += row.merge ? `<circle cx="${X(row.lane)}" cy="${Y[1]}" r="4.5" fill="var(--bg)" stroke="${c}" stroke-width="2.5"/>` : `<circle cx="${X(row.lane)}" cy="${Y[1]}" r="4.5" fill="${c}"/>`;
  return `${s}</svg>`;
}
const escHtml = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function refChips(refs) {
  // a local branch and its remote copy on the same commit share one label: "main ☁"
  const list = refs.filter((r) => r.type !== 'head');
  const localNames = new Set(list.filter((r) => r.type === 'branch').map((r) => r.name));
  const synced = new Map();
  for (const r of list) if (r.type === 'remote') { const local = r.name.replace(/^[^/]+\//, ''); if (localNames.has(local)) synced.set(local, r.name); }
  return list.filter((r) => !(r.type === 'remote' && localNames.has(r.name.replace(/^[^/]+\//, '')))).map((r) => {
    const cls = r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'remote' : r.current ? 'branch current' : 'branch';
    const remote = r.type === 'branch' && synced.get(r.name);
    const title = r.type === 'tag' ? `Tag ${r.name}` : r.type === 'remote' ? `Remote branch ${r.name}` : `${r.current ? 'Current branch (HEAD)' : 'Local branch'} ${r.name}${remote ? `\nSame commit as ${remote}` : ''}`;
    return `<span class="gh-chip ${cls}" title="${escHtml(title)}">${r.type === 'tag' ? '🏷 ' : ''}${escHtml(r.name)}${remote ? ' ☁' : ''}</span>`;
  }).join('');
}

function renderList() {
  const list = $('#ghList');
  const inner = $('#ghInner');
  const n = GH.commits.length;
  inner.style.height = `${n * ROW_H}px`;
  const graphW = GH.rows ? Math.min(Math.max(1, ...GH.rows.map((r) => r.width)), 14) * LANE_W + 10 : 18;
  list.style.setProperty('--gh-graph-w', `${graphW}px`);
  $('#ghEmpty').classList.toggle('hidden', n > 0 || GH.loading);
  $('#ghEmpty').textContent = GH.search ? `No commits match "${GH.search}".` : 'No commits yet.';
  const top = list.scrollTop, height = list.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW_H) - 10), last = Math.min(n, Math.ceil((top + height) / ROW_H) + 10);
  let html = '';
  for (let i = first; i < last; i++) {
    const c = GH.commits[i];
    const row = GH.rows ? { ...GH.rows[i], merge: c.parents.length > 1 } : { lane: 0, color: 0, segs: [...(i > 0 ? [[0, 0, 0, 1, 0]] : []), ...(i < n - 1 || !GH.done ? [[0, 1, 0, 2, 0]] : [])], width: 1, merge: c.parents.length > 1 };
    const isHead = GH.refs && c.hash === GH.refs.head;
    html += `<div class="gh-row${c.hash === GH.selected ? ' selected' : ''}${isHead ? ' head' : ''}" data-i="${i}" style="top:${i * ROW_H}px">`
      + `<span class="gh-c-graph">${graphSvg(row, GH.rows ? row.width : 1)}</span>`
      + `<span class="gh-c-msg">${refChips(c.refs)}<span class="gh-subject">${escHtml(c.subject)}</span></span>`
      + `<span class="gh-c-author">${escHtml(c.author)}</span>`
      + `<span class="gh-c-date" title="${escHtml(fullDate(c.time))}">${escHtml(fmtDate(c.time))}</span>`
      + `<span class="gh-c-id">${shortHash(c.hash)}</span></div>`;
  }
  inner.innerHTML = html;
  // near the end: fetch more
  if (!GH.done && !GH.loading && last >= n - 5 && n) loadMore();
}

function scrollToSelected() {
  const i = GH.commits.findIndex((c) => c.hash === GH.selected);
  if (i < 0) return;
  const list = $('#ghList');
  const y = i * ROW_H;
  if (y < list.scrollTop || y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, y - list.clientHeight / 2);
  renderList();
}

async function selectCommit(hash, scroll = false) {
  if (!GH.open) return;
  GH.selected = hash;
  while (!GH.commits.some((c) => c.hash.startsWith(hash)) && !GH.done) await loadMore();
  const c = GH.commits.find((x) => x.hash.startsWith(hash));
  if (!c && GH.ref !== 'all' && !GH.file) { GH.ref = 'all'; $('#ghRef').value = 'all'; renderBranches(); return reloadHistory(hash); }
  if (c) GH.selected = c.hash;
  if (scroll) scrollToSelected(); else renderList();
  showDetails(GH.selected);
}

// ---------------- details ----------------
async function showDetails(hash) {
  const host = $('#ghDetails');
  const d = await api.githist.details(GH.root, hash);
  if (GH.selected !== hash) return;
  GH.details = d;
  host.innerHTML = '';
  if (d.error) { host.textContent = d.error; return; }
  const [subject, ...rest] = d.message.split('\n');
  const body = rest.join('\n').trim();
  const idRow = h('div', { class: 'gh-d-id' }, h('span', { class: 'gh-d-hash', title: d.hash }, shortHash(d.hash)));
  const copy = h('button', { class: 'gh-mini', title: 'Copy commit ID' }, '⧉');
  copy.onclick = () => { navigator.clipboard.writeText(d.hash); status('Commit ID copied'); };
  idRow.appendChild(copy);
  if (d.parents.length) {
    idRow.appendChild(h('span', { class: 'dlg-desc' }, d.parents.length > 1 ? ' Parents: ' : ' Parent: '));
    d.parents.forEach((p, i) => {
      const a = h('a', { href: '#', class: 'gh-parent' }, shortHash(p));
      a.onclick = (e) => { e.preventDefault(); selectCommit(p, true); };
      if (i) idRow.appendChild(document.createTextNode(', '));
      idRow.appendChild(a);
    });
  }
  const avatar = h('span', { class: 'gh-avatar', style: `background:${laneColor([...d.author].reduce((a, ch) => a + ch.charCodeAt(0), 0))}` }, (d.author || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase());
  const who = h('div', { class: 'gh-d-author' }, avatar, h('div', {},
    h('div', {}, h('b', {}, d.author), h('span', { class: 'dlg-desc' }, ` <${d.email}>`)),
    h('div', { class: 'dlg-desc', title: fullDate(d.time) }, `${fmtDate(d.time)} (${relTime(d.time)})`),
    d.committer !== d.author ? h('div', { class: 'dlg-desc' }, `Committed by ${d.committer}`) : null));
  const chips = h('div', { class: 'gh-d-refs' });
  chips.innerHTML = refChips(d.refs);
  host.append(h('div', { class: 'gh-d-subject' }, subject), idRow, who, chips);
  if (body) host.appendChild(h('pre', { class: 'gh-d-body' }, body));
  host.appendChild(h('div', { class: 'gh-d-files-title' }, `Changes (${d.files.length})${d.parents.length > 1 ? ' — compared with the first parent' : ''}`));
  const list = h('div', { class: 'gh-d-files' });
  for (const f of d.files) {
    const name = f.path.split('/').pop();
    const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
    const row = h('div', { class: `gh-file${GH.file && relPath(GH.file) === f.path ? ' current' : ''}`, title: f.from ? `${f.from} → ${f.path}` : f.path },
      h('span', { class: `gh-st st-${f.status}` }, f.status),
      h('span', { class: 'label' }, name),
      h('span', { class: 'dlg-desc gh-dir' }, f.from ? `${f.from} →` : dir),
      h('span', { class: 'gh-plus' }, f.added != null ? `+${f.added}` : ''),
      h('span', { class: 'gh-minus' }, f.deleted != null ? `−${f.deleted}` : ''));
    row.onclick = () => openCommitDiff(d, f);
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      popup(e.clientX, e.clientY, [
        { label: 'Compare with Previous', run: () => openCommitDiff(d, f) },
        { label: 'Open File', disabled: f.status === 'D', run: () => { hideHistory(); openFile(joinRoot(f.path)); } },
        { label: 'View History', run: () => showHistory({ file: joinRoot(f.path), select: d.hash }) },
        { label: 'Copy Path', run: () => navigator.clipboard.writeText(f.path) }
      ]);
    };
    list.appendChild(row);
  }
  host.appendChild(list);
}
const joinRoot = (p) => GH.root + sep() + p.split('/').join(sep());

async function openCommitDiff(d, f) {
  const before = d.parents[0] || null;
  const [a, b] = await Promise.all([
    f.status === 'A' || !before ? { text: '' } : api.githist.fileAt(GH.root, before, f.from || f.path),
    f.status === 'D' ? { text: '' } : api.githist.fileAt(GH.root, d.hash, f.path)
  ]);
  openTextDiff({
    title: `${f.path}  —  ${before ? shortHash(before) : '(empty)'} ↔ ${shortHash(d.hash)}  ${d.message.split('\n')[0]}  (read-only)`,
    original: a.text, modified: b.text, path: joinRoot(f.path)
  });
}

// a read-only diff of two texts in the diff view (opens above the history)
function openTextDiff({ title, original, modified, path }) {
  closeDiff();
  const host = $('#diffEditor');
  const diffEditor = monacoRef.editor.createDiffEditor(host, {
    automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: !gitState.inline,
    fontSize: state.settings.fontSize, fontFamily: state.settings.fontFamily, minimap: { enabled: false }
  });
  const originalModel = monacoRef.editor.createModel(original, langFor(path));
  const modifiedModel = monacoRef.editor.createModel(modified, langFor(path));
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  gitState.diff = { diffEditor, originalModel, modifiedModel, ownsModel: true, path };
  $('#diffTitle').textContent = title;
  $('#diffView').classList.remove('hidden');
}

// ---------------- operations ----------------
async function historyOp(kind, args, label, { quiet = false } = {}) {
  status(`${label}...`);
  log(`\n------ ${label} ------\n`, 'info');
  const r = await api.githist.op(GH.root || gitRoot(), kind, args);
  log(`${(r.stdout || '') + (r.stderr || '')}\n`, r.ok ? null : 'stderr');
  if (!r.ok && !quiet) {
    status(`${label} failed`);
    showPanel('output');
    alert(`${label} failed:\n\n${(r.stderr || r.stdout || '').trim().slice(0, 800)}`);
  } else if (r.ok) status(`${label}: done`);
  await refreshGit();
  reloadCleanTabs();
  if (GH.open) { await loadRefs(); await reloadHistory(GH.selected); }
  return r;
}
async function newBranchAt(at) {
  const name = await ask(`New branch from ${at.length === 40 ? shortHash(at) : at}`);
  if (!name) return;
  return historyOp('branch', { name, at, checkout: true }, `Create and checkout branch ${name}`);
}

function commitMenu(x, y, c) {
  const merge = c.parents.length > 1;
  const head = GH.refs && GH.refs.head;
  popup(x, y, [
    { label: 'Compare with Previous / View Changes', run: () => selectCommit(c.hash) },
    '-',
    { label: 'New Branch...', run: () => newBranchAt(c.hash) },
    { label: 'New Tag...', run: async () => { const name = await ask(`New tag at ${shortHash(c.hash)}`); if (name) historyOp('tag', { name, at: c.hash }, `Create tag ${name}`); } },
    { label: 'Checkout (detached)', run: () => confirm(`Check out commit ${shortHash(c.hash)}?\n\nYou will be in 'detached HEAD' state: create a branch before you commit.`) && historyOp('checkout', { ref: c.hash }, `Checkout ${shortHash(c.hash)}`) },
    '-',
    { label: 'Cherry-Pick', disabled: c.hash === head, run: () => historyOp('cherryPick', { hash: c.hash, merge }, `Cherry-pick ${shortHash(c.hash)}`) },
    { label: 'Revert', run: () => confirm(`Create a new commit that undoes ${shortHash(c.hash)} "${c.subject}"?`) && historyOp('revert', { hash: c.hash, merge }, `Revert ${shortHash(c.hash)}`) },
    { label: 'Reset > Keep Changes (--mixed)', disabled: c.hash === head, run: () => confirm(`Move the current branch to ${shortHash(c.hash)}?\n\nLater commits are removed from the branch; their changes stay in your files.`) && historyOp('reset', { hash: c.hash, mode: 'mixed' }, `Reset to ${shortHash(c.hash)}`) },
    { label: 'Reset > Delete Changes (--hard)...', disabled: c.hash === head && !(gitState.status.changes.length + gitState.status.staged.length), run: () => confirm(`Reset the current branch to ${shortHash(c.hash)} and DELETE all later commits and uncommitted changes?\n\nThis cannot be undone.`) && historyOp('reset', { hash: c.hash, mode: 'hard' }, `Reset --hard to ${shortHash(c.hash)}`) },
    '-',
    { label: 'Copy Commit ID', run: () => navigator.clipboard.writeText(c.hash) },
    { label: 'Copy Short ID', run: () => navigator.clipboard.writeText(shortHash(c.hash)) },
    { label: 'Copy Message', run: () => navigator.clipboard.writeText(c.subject) }
  ]);
}

// ---------------- blame ----------------
const BLAME = { annotate: new Set(), cache: new Map(), decos: new Map(), inline: new Map(), timers: new Map() };
const ANN_W = 30;
function annText(c) {
  const d = c.uncommitted ? 'Uncommitted' : new Date(c.time * 1000).toISOString().slice(0, 10);
  let who = c.author || '';
  if (who.length > 16) who = `${who.slice(0, 15)}…`;
  return `${d} ${who}`.padEnd(ANN_W - 1).slice(0, ANN_W - 1) + ' ';
}
function blameTitle(c) {
  if (c.uncommitted) return 'Not committed yet';
  return `${shortHash(c.hash)}  ${c.summary}\n${c.author} <${c.email}>\n${fullDate(c.time)} (${relTime(c.time)})\n\nClick to show this commit`;
}

async function getBlame(model, path) {
  const key = model.uri.toString();
  const ver = model.getAlternativeVersionId();
  const cached = BLAME.cache.get(key);
  if (cached && cached.ver === ver) return cached.data;
  const root = gitRoot();
  if (!root || !normPath(path).startsWith(normPath(root))) return { error: 'Not in a Git repository' };
  // always blame the editor text, so unsaved lines show as "not committed yet"
  const data = await api.githist.blame(root, path, model.getValue());
  BLAME.cache.set(key, { ver, data });
  return data;
}

async function applyAnnotate(tab) {
  const model = tab.model;
  const key = model.uri.toString();
  if (!BLAME.annotate.has(key)) { BLAME.decos.set(key, model.deltaDecorations(BLAME.decos.get(key) || [], [])); return; }
  const b = await getBlame(model, tab.path);
  if (b.error) { status(`Blame: ${b.error}`); BLAME.annotate.delete(key); return; }
  const decos = [];
  let prev = null, shade = 0;
  const n = Math.min(model.getLineCount(), b.lines.length);
  for (let i = 0; i < n; i++) {
    const h0 = b.lines[i];
    const c = b.commits[h0];
    const start = h0 !== prev;
    if (start) shade ^= 1;
    prev = h0;
    decos.push({
      range: new monacoRef.Range(i + 1, 1, i + 1, 1),
      options: {
        before: { content: start ? annText(c) : ' '.repeat(ANN_W), inlineClassName: `blame-ann blame-s${shade}${start ? ' blame-start' : ''}${c.uncommitted ? ' blame-new' : ''}`, cursorStops: monacoRef.editor.InjectedTextCursorStops.None },
        showIfCollapsed: true, // empty-range decorations are dropped otherwise
        stickiness: monacoRef.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    });
  }
  // lines git does not know (e.g. the empty last line) still get the padding so the code stays aligned
  for (let i = n; i < model.getLineCount(); i++) decos.push({ range: new monacoRef.Range(i + 1, 1, i + 1, 1), options: { showIfCollapsed: true, before: { content: ' '.repeat(ANN_W), inlineClassName: 'blame-ann blame-pad', cursorStops: monacoRef.editor.InjectedTextCursorStops.None } } });
  BLAME.decos.set(key, model.deltaDecorations(BLAME.decos.get(key) || [], decos));
  BLAME.lines = BLAME.lines || new Map();
  BLAME.lines.set(key, b);
}

async function toggleBlame(tab = state.active) {
  if (!tab || !tab.model) { status('Open a file first'); return; }
  const key = tab.model.uri.toString();
  if (BLAME.annotate.has(key)) BLAME.annotate.delete(key); else BLAME.annotate.add(key);
  await applyAnnotate(tab);
  status(BLAME.annotate.has(key) ? 'Blame (annotate) on: click an annotation to see the commit' : 'Blame (annotate) off');
}

// inline blame for the line with the cursor (like "Alice, 3 days ago • Fix bug")
async function updateInlineBlame() {
  const tab = state.active;
  if (!tab || !tab.model || !editor) return;
  const model = tab.model;
  const key = model.uri.toString();
  const clear = () => { BLAME.inline.set(key, model.deltaDecorations(BLAME.inline.get(key) || [], [])); };
  if (!state.settings.gitInlineBlame || BLAME.annotate.has(key) || !gitRoot() || editor.getModel() !== model) { clear(); return; }
  const b = await getBlame(model, tab.path);
  if (editor.getModel() !== model) return;
  const line = editor.getPosition() ? editor.getPosition().lineNumber : 1;
  const c = !b.error && b.lines[line - 1] ? b.commits[b.lines[line - 1]] : null;
  if (!c || editor.getSelection().startLineNumber !== editor.getSelection().endLineNumber) { clear(); return; }
  const text = c.uncommitted ? 'You, not committed yet' : `${c.author}, ${relTime(c.time)} • ${c.summary}`;
  BLAME.inline.set(key, model.deltaDecorations(BLAME.inline.get(key) || [], [{
    range: new monacoRef.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
    options: { showIfCollapsed: true, after: { content: `    ${text}`, inlineClassName: 'blame-inline', cursorStops: monacoRef.editor.InjectedTextCursorStops.None } }
  }]));
}
let inlineTimer = null;
const scheduleInline = (ms = 250) => { clearTimeout(inlineTimer); inlineTimer = setTimeout(updateInlineBlame, ms); };

function wireBlameEditor() {
  editor.onDidChangeCursorPosition(() => scheduleInline(150));
  editor.onDidChangeModel(() => scheduleInline(50));
  editor.onDidChangeModelContent(() => {
    const tab = state.active;
    if (!tab) return;
    const key = tab.model.uri.toString();
    clearTimeout(BLAME.timers.get(key));
    BLAME.timers.set(key, setTimeout(() => { if (BLAME.annotate.has(key)) applyAnnotate(tab); scheduleInline(0); }, 900));
  });
  // click on an annotation -> show the commit
  editor.onMouseDown((e) => {
    const el = e.target.element;
    if (!el || !el.classList || !el.classList.contains('blame-ann')) return;
    const key = editor.getModel().uri.toString();
    const b = BLAME.lines && BLAME.lines.get(key);
    const line = e.target.position ? e.target.position.lineNumber : null;
    const hash = b && line ? b.lines[line - 1] : null;
    if (!hash || /^0+$/.test(hash)) return;
    showHistory({ select: hash });
  });
  editor.onMouseMove((e) => {
    const el = e.target.element;
    if (!el || !el.classList || !el.classList.contains('blame-ann') || el.title) return;
    const b = BLAME.lines && BLAME.lines.get(editor.getModel().uri.toString());
    const line = e.target.position ? e.target.position.lineNumber : null;
    const c = b && line ? b.commits[b.lines[line - 1]] : null;
    if (c) el.title = blameTitle(c);
  });
  editor.addAction({ id: 'nova.git.history', label: 'Git: View History', contextMenuGroupId: '9_git', contextMenuOrder: 1, run: () => commands.gitFileHistory() });
  editor.addAction({ id: 'nova.git.blame', label: 'Git: Blame (Annotate)', contextMenuGroupId: '9_git', contextMenuOrder: 2, run: () => commands.gitBlame() });
}

// ---------------- wiring ----------------
$('#ghClose').onclick = hideHistory;
$('#ghRefresh').onclick = async () => { await loadRefs(); reloadHistory(GH.selected); };
$('#ghFetch').onclick = async () => { await commands.gitFetch(); await loadRefs(); reloadHistory(GH.selected); };
$('#ghRef').onchange = () => { GH.ref = $('#ghRef').value; renderBranches(); reloadHistory(); };
let searchTimer = null;
$('#ghSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { GH.search = $('#ghSearch').value.trim(); reloadHistory(); }, 300); };
$('#ghSearch').onkeydown = (e) => { if (e.key === 'Escape') { $('#ghSearch').value = ''; GH.search = ''; reloadHistory(); } e.stopPropagation(); };
$('#ghList').onscroll = () => renderList();
// rows are re-rendered on click, so a double-click is detected from the click count
$('#ghList').onclick = (e) => {
  const r = e.target.closest('.gh-row');
  if (!r) return;
  const c = GH.commits[+r.dataset.i];
  if (e.detail === 2) { openFromRow(c); return; }
  selectCommit(c.hash);
};
function openFromRow(c) {
  // in file history: show what changed in that file
  if (!GH.file || !c.file) return;
  (async () => {
    const d = GH.details && GH.details.hash === c.hash ? GH.details : await api.githist.details(GH.root, c.hash);
    const f = d.files && d.files.find((x) => x.path === c.file.path);
    if (f) openCommitDiff(d, f);
  })();
}
$('#ghList').oncontextmenu = (e) => { const r = e.target.closest('.gh-row'); if (!r) return; e.preventDefault(); const c = GH.commits[+r.dataset.i]; selectCommit(c.hash); commitMenu(e.clientX, e.clientY, c); };
$('#ghList').onkeydown = (e) => {
  const i = GH.commits.findIndex((c) => c.hash === GH.selected);
  const go = (j) => { e.preventDefault(); if (GH.commits[j]) { GH.selected = GH.commits[j].hash; scrollToSelected(); clearTimeout(GH.detTimer); GH.detTimer = setTimeout(() => showDetails(GH.selected), 120); } };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(Math.max(0, i - 1));
  else if (e.key === 'PageDown') go(Math.min(GH.commits.length - 1, i + 20));
  else if (e.key === 'PageUp') go(Math.max(0, i - 20));
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(GH.commits.length - 1);
  else if (e.key === 'Escape') hideHistory();
};
dragSplitter($('#ghSplit'), (e) => { const r = $('#historyView').getBoundingClientRect(); $('#ghDetails').style.width = `${Math.max(240, Math.min(r.width - 300, r.right - e.clientX))}px`; });

// any normal tab activation hides the history (like the diff view)
const _activateGH = activate;
activate = function (tab) { if (GH.open) hideHistory(); _activateGH(tab); }; // eslint-disable-line no-func-assign

const activeFile = () => state.active && state.active.path;
Object.assign(commands, {
  gitRepository: () => showHistory(),
  gitBranchHistory: () => showHistory({ ref: gitState.status && gitState.status.branch ? gitState.status.branch : 'all' }),
  gitFileHistory: (p) => { const f = typeof p === 'string' ? p : activeFile(); if (!f) { status('Open a file first'); return; } showHistory({ file: f }); },
  gitBlame: () => toggleBlame(),
  gitToggleInlineBlame: async () => { const s = await updateSetting({ gitInlineBlame: !state.settings.gitInlineBlame }); scheduleInline(0); status(s.gitInlineBlame ? 'Inline blame on' : 'Inline blame off'); }
});

// Solution Explorer / folder view: "View History" and "Blame" on files
const _extrasGH = contextMenuExtras;
contextMenuExtras = (node, dir) => {
  const base = _extrasGH ? _extrasGH(node, dir) : [];
  if (node.entry.isDir || !gitRoot()) return base;
  return [...base, ['Git: View History', () => showHistory({ file: node.entry.path })], ['Git: Blame', async () => { await openFile(node.entry.path); const t = state.tabs.find((x) => normPath(x.path) === normPath(node.entry.path)); if (t && !BLAME.annotate.has(t.model.uri.toString())) toggleBlame(t); }]];
};

bus.on('ready', () => { wireBlameEditor(); });
bus.on('tabOpened', () => scheduleInline(100));
bus.on('saved', (tab) => { if (tab && tab.model) { BLAME.cache.delete(tab.model.uri.toString()); if (BLAME.annotate.has(tab.model.uri.toString())) applyAnnotate(tab); scheduleInline(300); } });
bus.on('folder', () => { hideHistory(); BLAME.cache.clear(); BLAME.annotate.clear(); });
bus.on('settings', () => scheduleInline(0));
// after commits, checkouts etc. the blame changes
const _refreshGitGH = refreshGit;
refreshGit = async function () { const r = await _refreshGitGH.apply(this, arguments); BLAME.cache.clear(); for (const t of state.tabs) if (t.model && BLAME.annotate.has(t.model.uri.toString())) applyAnnotate(t); scheduleInline(200); return r; }; // eslint-disable-line no-func-assign

window.GH = GH;
window.BLAME = BLAME;
window.showHistory = showHistory;
window.hideHistory = hideHistory;
