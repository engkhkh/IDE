// Nova IDE - Git Changes window, diff viewer, Solution Explorer status badges
'use strict';

const gitState = { status: null, busy: false, refreshTimer: null, diff: null, inline: false };
const GIT_COLORS = { M: 'git-m', A: 'git-a', D: 'git-d', U: 'git-u', R: 'git-a', C: 'git-a', T: 'git-m' };

const repoPath = (rel) => gitState.status.root + sep() + rel.replace(/\//g, sep());
const normPath = (p) => p.replace(/\//g, '\\').toLowerCase();

// ---------- side tabs (Solution Explorer | Git Changes) ----------
function showSide(name) {
  $$('#sideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.side === name));
  $$('.side-panel').forEach((p) => p.classList.toggle('active', p.id === `side-${name}`));
  if ($('#explorer').classList.contains('hidden')) commands.toggleExplorer();
  if (name === 'git') refreshGit();
}
$$('#sideTabs button').forEach((b) => b.addEventListener('click', () => showSide(b.dataset.side)));

// ---------- status ----------
async function refreshGit() {
  if (!state.root) { gitState.status = null; renderGit(); return; }
  if (gitState.busy) return;
  gitState.busy = true;
  try { gitState.status = await api.git.status(state.root); }
  catch (e) { gitState.status = { repo: false, error: e.message }; }
  finally { gitState.busy = false; }
  renderGit();
  paintTreeBadges();
}
function scheduleGitRefresh(ms = 400) { clearTimeout(gitState.refreshTimer); gitState.refreshTimer = setTimeout(refreshGit, ms); }

async function gitRun(label, fn) {
  status(`${label}...`);
  const r = await fn();
  if (r && r.ok === false) {
    log(`git ${label.toLowerCase()} failed:\n${r.stderr || r.stdout}\n`, 'stderr');
    showPanel('output');
    status(`git ${label.toLowerCase()} failed`);
  } else {
    if (r && (r.stdout || r.stderr)) log(`[git] ${(r.stdout + r.stderr).trim()}\n`);
    status(`${label} done`);
  }
  await refreshGit();
  return r;
}

// ---------- Git Changes panel ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function renderGit() {
  const host = $('#gitPanel');
  const s = gitState.status;
  host.innerHTML = '';
  const badge = $('#gitCount');
  const branchEl = $('#stBranch');

  if (!state.root) { host.appendChild(el('div', 'git-empty', 'Open a folder to see Git changes.')); badge.classList.add('hidden'); branchEl.classList.add('hidden'); return; }
  if (!s || !s.repo) {
    badge.classList.add('hidden'); branchEl.classList.add('hidden');
    if (s && s.gitInstalled === false) { host.appendChild(el('div', 'git-empty', 'Git is not installed. Install it from git-scm.com and restart Nova IDE.')); return; }
    host.appendChild(el('div', 'git-empty', 'This folder is not a Git repository.'));
    const b = el('button', 'primary', 'Create Git Repository');
    b.onclick = () => commands.gitInit();
    host.appendChild(b);
    return;
  }
  if (s.error) { host.appendChild(el('div', 'git-empty', s.error)); return; }

  const conflicts = s.conflicts || [];
  const total = s.staged.length + s.changes.length + conflicts.length;
  badge.textContent = total; badge.classList.toggle('hidden', !total);
  const OPS = { merge: 'MERGING', rebase: 'REBASING', 'cherry-pick': 'CHERRY-PICKING', revert: 'REVERTING' };
  branchEl.textContent = `⎇ ${s.branch}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}${s.op ? ` | ${OPS[s.op.kind]}${conflicts.length ? ` ⚠${conflicts.length}` : ''}` : ''}`;
  branchEl.classList.toggle('git-op', !!s.op);
  branchEl.classList.remove('hidden');

  // Branch + sync toolbar
  const top = el('div', 'git-top');
  const br = el('button', 'git-branch', `⎇ ${s.branch} ▾`);
  br.title = 'Switch or create branch';
  br.onclick = () => commands.gitBranch();
  const sync = el('div', 'git-sync');
  const mk = (txt, title, fn) => { const b = el('button', null, txt); b.title = title; b.onclick = fn; sync.appendChild(b); };
  mk('🕘', 'View Branch History (Git Repository)', () => commands.gitRepository());
  mk('⟳', 'Refresh', refreshGit);
  mk('⤓', 'Fetch', () => commands.gitFetch());
  mk(`↓${s.behind || ''}`, 'Pull', () => commands.gitPull());
  mk(`↑${s.ahead || ''}`, s.upstream ? `Push to ${s.upstream}` : 'Push (sets upstream)', () => commands.gitPush());
  top.append(br, sync);
  host.appendChild(top);
  if (s.op && typeof opBanner === 'function') host.appendChild(opBanner(s));
  if (!s.op && typeof prLink === 'function') { const l = prLink(s); if (l) host.appendChild(l); }

  // Commit box
  const msg = el('textarea', 'git-msg');
  msg.id = 'gitMsg';
  msg.placeholder = 'Enter a message <Required>';
  msg.value = gitState.draft || (s.op && s.op.kind === 'merge' ? s.op.message : '');
  msg.oninput = () => { gitState.draft = msg.value; };
  msg.onkeydown = (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); commit(); } };
  host.appendChild(msg);
  const actions = el('div', 'git-actions');
  const commitBtn = el('button', 'primary', s.op && s.op.kind === 'merge' && !conflicts.length ? 'Commit Merge' : s.staged.length ? 'Commit Staged' : 'Commit All');
  commitBtn.title = 'Ctrl+Enter';
  commitBtn.disabled = !total && !(s.op && s.op.kind === 'merge') || conflicts.length > 0;
  if (conflicts.length) commitBtn.title = 'Resolve the merge conflicts first';
  commitBtn.onclick = () => commit();
  const amend = el('label', 'git-amend');
  const amendBox = el('input'); amendBox.type = 'checkbox'; amendBox.id = 'gitAmend';
  amend.append(amendBox, document.createTextNode(' Amend'));
  if (typeof stashButton === 'function') actions.append(stashButton(s));
  actions.append(commitBtn, amend);
  host.appendChild(actions);

  if (!total) host.appendChild(el('div', 'git-empty', 'No changes. Working tree is clean.'));
  if (conflicts.length && typeof conflictSection === 'function') host.appendChild(conflictSection(s));
  if (s.staged.length) host.appendChild(fileSection('Staged Changes', s.staged, true));
  if (s.changes.length) host.appendChild(fileSection('Changes', s.changes, false));

  if (typeof stashSection === 'function') host.appendChild(stashSection(s));

  // History (lazy)
  const hist = el('details', 'git-section');
  const sum = el('summary', null, 'History');
  hist.appendChild(sum);
  hist.ontoggle = async () => {
    if (!hist.open || hist.dataset.loaded) return;
    hist.dataset.loaded = '1';
    const log = await api.git.log(s.root, 30);
    if (!log.length) hist.appendChild(el('div', 'git-empty', 'No commits yet.'));
    for (const c of log) {
      const row = el('div', 'git-commit');
      row.append(el('span', 'git-hash', c.hash), el('span', 'git-subj', c.subject), el('span', 'git-meta', `${c.author} · ${c.date}`));
      hist.appendChild(row);
    }
  };
  host.appendChild(hist);
}

function fileSection(title, files, staged) {
  const sec = el('details', 'git-section');
  sec.open = true;
  const sum = el('summary');
  sum.append(document.createTextNode(`${title} (${files.length})`));
  const allBtn = el('button', 'git-mini', staged ? '−' : '+');
  allBtn.title = staged ? 'Unstage All' : 'Stage All';
  allBtn.onclick = (e) => { e.preventDefault(); const list = files.map((f) => f.file); gitRun(staged ? 'Unstage' : 'Stage', () => (staged ? api.git.unstage : api.git.stage)(gitState.status.root, list)); };
  sum.appendChild(allBtn);
  sec.appendChild(sum);

  for (const f of files) {
    const row = el('div', 'git-file');
    row.title = f.from ? `${f.from} → ${f.file}` : f.file;
    const name = el('span', 'git-name', baseName(f.file));
    const dir = el('span', 'git-dir', f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '');
    const st = el('span', `git-st ${GIT_COLORS[f.status] || ''}`, f.status);
    st.title = f.label;
    const btns = el('span', 'git-btns');
    const b = (txt, title, fn) => { const x = el('button', 'git-mini', txt); x.title = title; x.onclick = (e) => { e.stopPropagation(); fn(); }; btns.appendChild(x); };
    b('📄', 'Open File', () => openFile(repoPath(f.file)));
    if (staged) b('−', 'Unstage', () => gitRun('Unstage', () => api.git.unstage(gitState.status.root, [f.file])));
    else {
      b('↶', f.status === 'U' ? 'Delete untracked file' : 'Undo Changes', async () => {
        if (!confirm(f.status === 'U' ? `Delete untracked file "${f.file}"?` : `Undo all changes to "${f.file}"? This cannot be undone.`)) return;
        await gitRun('Undo', () => api.git.discard(gitState.status.root, [f.file], f.status === 'U'));
        const t = state.tabs.find((t) => normPath(t.path) === normPath(repoPath(f.file)));
        if (t && !isDirty(t)) reloadTabFromDisk(t);
      });
      b('+', 'Stage', () => gitRun('Stage', () => api.git.stage(gitState.status.root, [f.file])));
    }
    row.append(st, name, dir, btns);
    row.onclick = () => openDiff(f, staged);
    row.ondblclick = () => openFile(repoPath(f.file));
    sec.appendChild(row);
  }
  return sec;
}

async function commit() {
  const s = gitState.status;
  const msg = ($('#gitMsg') && $('#gitMsg').value.trim()) || '';
  const amendOn = $('#gitAmend') && $('#gitAmend').checked;
  if (s.conflicts && s.conflicts.length) { status('Resolve the merge conflicts first'); return; }
  if (!msg) { status('Enter a commit message'); $('#gitMsg') && $('#gitMsg').focus(); return; }
  await saveAll();
  // Commit Staged if anything is staged, otherwise stage everything (incl. untracked) and commit
  if (!s.staged.length) {
    const all = s.changes.map((c) => c.file);
    if (all.length) { const r = await api.git.stage(s.root, all); if (!r.ok) { log(r.stderr + '\n', 'stderr'); showPanel('output'); return; } }
  }
  const r = await gitRun('Commit', () => api.git.commit(s.root, msg, { amend: amendOn }));
  if (r && r.ok) { gitState.draft = ''; renderGit(); }
}

// ---------- Diff viewer (Monaco diff editor) ----------
async function openDiff(f, staged) {
  const s = gitState.status;
  const full = repoPath(f.file);
  // left side: HEAD for staged, index (":") for unstaged changes
  const original = f.status === 'U' || f.status === 'A' ? '' : await api.git.show(s.root, f.from || f.file, staged ? 'HEAD' : '');
  let modifiedModel, ownsModel = false;
  const tab = state.tabs.find((t) => normPath(t.path) === normPath(full));
  if (staged) {
    modifiedModel = monacoRef.editor.createModel(f.status === 'D' ? '' : await api.git.show(s.root, f.file, ''), langFor(full));
    ownsModel = true;
  } else if (tab) modifiedModel = tab.model; // edit live in the diff
  else {
    let text = '';
    if (f.status !== 'D') { try { text = await api.readFile(full); } catch {} }
    modifiedModel = monacoRef.editor.createModel(text, langFor(full));
    ownsModel = true;
  }
  closeDiff();
  const host = $('#diffEditor');
  const diffEditor = monacoRef.editor.createDiffEditor(host, {
    automaticLayout: true, readOnly: ownsModel, originalEditable: false, renderSideBySide: !gitState.inline,
    fontSize: state.settings.fontSize, fontFamily: state.settings.fontFamily, minimap: { enabled: false }
  });
  const originalModel = monacoRef.editor.createModel(original, langFor(full));
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  gitState.diff = { diffEditor, originalModel, modifiedModel, ownsModel, path: full };
  $('#diffTitle').textContent = `${f.file}  —  ${staged ? 'HEAD ↔ Staged' : (f.status === 'U' ? 'New file' : 'Index ↔ Working tree')}${ownsModel ? '  (read-only)' : ''}`;
  $('#diffView').classList.remove('hidden');
}
function closeDiff() {
  const d = gitState.diff;
  if (!d) return;
  d.diffEditor.dispose();
  d.originalModel.dispose();
  if (d.ownsModel) d.modifiedModel.dispose();
  gitState.diff = null;
  $('#diffView').classList.add('hidden');
}
$('#diffClose').onclick = closeDiff;
$('#diffOpen').onclick = () => { const p = gitState.diff && gitState.diff.path; closeDiff(); if (p) openFile(p); };
$('#diffInline').onclick = () => {
  gitState.inline = !gitState.inline;
  if (gitState.diff) gitState.diff.diffEditor.updateOptions({ renderSideBySide: !gitState.inline });
};
// Activating a normal tab hides the diff
const _activate = activate;
activate = function (tab) { closeDiff(); _activate(tab); }; // eslint-disable-line no-func-assign
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && gitState.diff) closeDiff(); });

// ---------- Solution Explorer badges ----------
function paintTreeBadges() {
  const s = gitState.status;
  const map = new Map();
  const dirs = new Set();
  if (s && s.repo && !s.error) {
    const rootN = normPath(s.root);
    for (const f of [...s.changes, ...s.staged]) {
      const full = normPath(repoPath(f.file));
      if (!map.has(full) || f.status === 'U') map.set(full, f.status);
      // mark every parent folder up to the repo root
      let d = full;
      for (;;) {
        const i = d.lastIndexOf('\\');
        if (i < 0) break;
        d = d.slice(0, i);
        if (d.length < rootN.length || dirs.has(d)) break;
        dirs.add(d);
      }
    }
  }
  $$('#tree .tree-row').forEach((row) => {
    const p = normPath(row.dataset.path || '');
    const b = row.querySelector('.git-badge');
    const st = map.get(p);
    row.classList.remove('git-m', 'git-a', 'git-d', 'git-u', 'git-dir');
    if (st) { b.textContent = st; row.classList.add(GIT_COLORS[st] || 'git-m'); }
    else if (dirs.has(p)) { b.textContent = '•'; row.classList.add('git-dir'); }
    else b.textContent = '';
  });
}
bus.on('treeRendered', () => paintTreeBadges());

// ---------- commands ----------
commands.showGit = () => showSide('git');
commands.gitRefresh = refreshGit;
commands.gitCommitPrompt = async () => { showSide('git'); setTimeout(() => $('#gitMsg') && $('#gitMsg').focus(), 50); };
commands.gitPull = () => gitState.status && gitState.status.repo && gitRun('Pull', () => api.git.pull(gitState.status.root));
commands.gitPush = () => gitState.status && gitState.status.repo && gitRun('Push', () => api.git.push(gitState.status.root));
commands.gitFetch = () => gitState.status && gitState.status.repo && gitRun('Fetch', () => api.git.fetch(gitState.status.root));
commands.gitInit = async () => {
  if (!state.root) return status('Open a folder first');
  await gitRun('Create repository', () => api.git.init(state.root));
  showSide('git');
};
commands.gitBranch = async () => {
  const s = gitState.status;
  if (!s || !s.repo) return status('Not a Git repository');
  const branches = await api.git.branches(s.root);
  const local = branches.filter((b) => !b.remote).map((b) => (b.current ? `*${b.name}` : b.name)).join(', ');
  const name = await ask(`Switch to branch (existing: ${local || 'none'}). A new name creates a branch.`);
  if (!name) return;
  const exists = branches.some((b) => b.name === name || b.name.endsWith(`/${name}`));
  await saveAll();
  await gitRun(exists ? `Checkout ${name}` : `Create branch ${name}`, () => api.git.checkout(s.root, name, !exists));
  // reload unmodified open files that changed with the branch switch
  reloadCleanTabs();
};
// reload unmodified open files after git changed them (checkout, merge, stash...)
function reloadCleanTabs() { for (const t of state.tabs) if (!isDirty(t)) reloadTabFromDisk(t); }
$('#stBranch').onclick = () => commands.gitBranch();

// ---------- refresh triggers ----------
bus.on('folder', () => { closeDiff(); refreshGit(); });
bus.on('saved', () => scheduleGitRefresh());
api.on('fs:changed', () => scheduleGitRefresh(600));
window.addEventListener('focus', () => scheduleGitRefresh(100));
setInterval(() => { if (state.root && document.hasFocus()) refreshGit(); }, 10000); // catches commits made in the terminal
