// Nova IDE - merge conflicts (merge / rebase / cherry-pick / revert) and stashes
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { git } = require('./git');

const US = '\x1f';
const toPosix = (p) => p.split(path.sep).join('/');
const rel = (root, file) => toPosix(path.relative(root, path.resolve(root, file)));
// continue/commit without opening an editor
const noEditor = () => ({ env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });

// ---------------- conflicts in `git status` ----------------
// XY codes of unmerged paths (the table lives in git.js, which parses status)
const { CONFLICT_KINDS } = require('./git');
const isConflictCode = (xy) => Object.prototype.hasOwnProperty.call(CONFLICT_KINDS, xy);

// ---------------- operation in progress ----------------
async function operationState(root) {
  const g = await git(root, ['rev-parse', '--absolute-git-dir']);
  if (!g.ok) return null;
  const dir = g.stdout.trim();
  const exists = (p) => fs.existsSync(path.join(dir, p));
  const read = (p) => { try { return fs.readFileSync(path.join(dir, p), 'utf8').trim(); } catch { return ''; } };
  const nameOf = async (hash) => {
    if (!hash) return '';
    const n = await git(root, ['name-rev', '--name-only', '--exclude=refs/tags/*', hash]);
    const name = n.ok ? n.stdout.trim() : '';
    return name && name !== 'undefined' ? name.replace(/^remotes\//, '') : hash.slice(0, 8);
  };
  if (exists('rebase-merge') || exists('rebase-apply')) {
    const d = exists('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
    const head = read(`${d}/head-name`).replace(/^refs\/heads\//, '');
    const onto = read(`${d}/onto`);
    const step = +(read(`${d}/msgnum`) || read(`${d}/next`)) || 0;
    const total = +(read(`${d}/end`) || read(`${d}/last`)) || 0;
    const cur = read('REBASE_HEAD') || read(`${d}/stopped-sha`);
    const subj = cur ? (await git(root, ['log', '-1', '--format=%s', cur])).stdout.trim() : '';
    return { kind: 'rebase', branch: head, onto: await nameOf(onto), step, total, incoming: cur ? `${cur.slice(0, 8)} ${subj}` : head, current: await nameOf(onto) };
  }
  if (exists('MERGE_HEAD')) {
    const h = read('MERGE_HEAD').split('\n')[0];
    const msg = read('MERGE_MSG').split('\n')[0];
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg);
    return { kind: 'merge', incoming: m ? m[1] : await nameOf(h), incomingHash: h, message: msg };
  }
  if (exists('CHERRY_PICK_HEAD')) {
    const h = read('CHERRY_PICK_HEAD');
    return { kind: 'cherry-pick', incoming: `${h.slice(0, 8)} ${(await git(root, ['log', '-1', '--format=%s', h])).stdout.trim()}`, incomingHash: h };
  }
  if (exists('REVERT_HEAD')) {
    const h = read('REVERT_HEAD');
    return { kind: 'revert', incoming: `revert of ${h.slice(0, 8)} ${(await git(root, ['log', '-1', '--format=%s', h])).stdout.trim()}`, incomingHash: h };
  }
  return null;
}

// ---------------- conflict versions ----------------
// git merge-file --diff3 output -> [{type:'common', text} | {type:'conflict', ours, base, theirs}]
function parseConflicts(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const segs = [];
  let common = '';
  let cur = null, part = null;
  const marker = (l, ch) => l.startsWith(ch.repeat(7)) && (l.length === 7 || /^[\s]/.test(l[7]) || l[7] === undefined);
  for (const l of lines) {
    const bare = l.replace(/\r?\n$/, '');
    if (!cur && marker(bare, '<')) { if (common) segs.push({ type: 'common', text: common }); common = ''; cur = { type: 'conflict', ours: '', base: '', theirs: '', hasBase: false }; part = 'ours'; continue; }
    if (cur && part === 'ours' && marker(bare, '|')) { part = 'base'; cur.hasBase = true; continue; }
    if (cur && (part === 'ours' || part === 'base') && marker(bare, '=')) { part = 'theirs'; continue; }
    if (cur && part === 'theirs' && marker(bare, '>')) { segs.push(cur); cur = null; part = null; continue; }
    if (cur) cur[part] += l; else common += l;
  }
  if (cur) { // unterminated: treat as text
    common += cur.ours + cur.base + cur.theirs;
  }
  if (common) segs.push({ type: 'common', text: common });
  return segs;
}
const hasMarkers = (text) => /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);

async function conflictInfo(root, file) {
  const r = rel(root, file);
  const ls = await git(root, ['ls-files', '-u', '-z', '--', r]);
  const stages = new Set();
  for (const rec of ls.stdout.split('\0').filter(Boolean)) { const m = /^\d+ [0-9a-f]+ (\d)\t/.exec(rec); if (m) stages.add(+m[1]); }
  const show = async (n) => (stages.has(n) ? (await git(root, ['show', `:${n}:${r}`], { encoding: 'buffer' })).stdout : null);
  const [b, o, t] = await Promise.all([show(1), show(2), show(3)]);
  const binary = [b, o, t].some((x) => x && x.includes(0));
  const txt = (x) => (x ? x.toString('utf8') : '');
  let working = null;
  try { working = await fsp.readFile(path.resolve(root, file), 'utf8'); } catch {}
  const info = { file: r, stages: [...stages].sort(), binary, base: txt(b), ours: txt(o), theirs: txt(t), oursExists: !!o, theirsExists: !!t, baseExists: !!b, working, workingHasMarkers: working != null && hasMarkers(working) };
  if (!stages.size) { info.resolved = true; return info; }
  if (binary || !o || !t) { info.segments = null; return info; }
  // re-run the merge with base included (diff3), so the editor always gets clean blocks
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-merge-'));
  const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
  await Promise.all([fsp.writeFile(fo, o), fsp.writeFile(fb, b || Buffer.alloc(0)), fsp.writeFile(ft, t)]);
  const m = await git(root, ['merge-file', '-p', '--diff3', '-L', 'Current', '-L', 'Base', '-L', 'Incoming', fo, fb, ft]);
  fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  info.segments = parseConflicts(m.stdout);
  return info;
}

// ---------------- resolving ----------------
async function resolve(root, file, how, content) {
  const r = rel(root, file);
  if (how === 'content') {
    await fsp.writeFile(path.resolve(root, file), content);
    return git(root, ['add', '--', r]);
  }
  if (how === 'ours' || how === 'theirs') {
    const c = await git(root, ['checkout', `--${how}`, '--', r]);
    if (!c.ok) {
      // the chosen side deleted the file
      if (/does not have (our|their) version/.test(c.stderr)) return git(root, ['rm', '-q', '--', r]);
      return c;
    }
    return git(root, ['add', '--', r]);
  }
  if (how === 'delete') return git(root, ['rm', '-q', '--', r]);
  if (how === 'keep') return git(root, ['add', '--', r]);
  return { ok: false, stderr: `unknown resolution ${how}` };
}

async function control(root, action) {
  const st = await operationState(root);
  if (!st) return { ok: false, stderr: 'No merge, rebase, cherry-pick or revert is in progress.' };
  const cmd = st.kind;
  if (action === 'abort') return git(root, [cmd, '--abort'], noEditor());
  if (action === 'skip') return git(root, [cmd, '--skip'], noEditor());
  if (action === 'continue') {
    if (cmd === 'merge') return git(root, ['commit', '--no-edit'], noEditor());
    return git(root, [cmd, '--continue'], noEditor());
  }
  return { ok: false, stderr: `unknown action ${action}` };
}

// ---------------- stashes ----------------
async function stashList(root) {
  const r = await git(root, ['stash', 'list', `--format=%gd${US}%H${US}%gs${US}%ct`]);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [ref, hash, subject, time] = l.split(US);
    // "WIP on main: 1234567 subject" / "On main: message"
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject);
    return { ref, index: +(/\{(\d+)\}/.exec(ref) || [0, 0])[1], hash, branch: m ? m[1] : '', message: m ? m[2] : subject, time: +time };
  });
}
async function stashFiles(root, ref) {
  const out = [];
  const ns = await git(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', `${ref}^1`, ref]);
  const t = ns.stdout.split('\0');
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue;
    if (/^[RC]/.test(t[i])) { out.push({ status: t[i][0], from: t[i + 1], path: t[i + 2] }); i += 2; } else { out.push({ status: t[i][0], path: t[i + 1] }); i++; }
  }
  // untracked files are kept in a third parent
  const u = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^3`]);
  if (u.ok) {
    const ls = await git(root, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', `${ref}^3`]);
    for (const p of ls.stdout.split('\0').filter(Boolean)) out.push({ status: 'U', path: p, untracked: true });
  }
  return out;
}
async function stashFile(root, ref, file, untracked) {
  const show = async (spec) => { const r = await git(root, ['show', spec]); return r.ok ? r.stdout : ''; };
  if (untracked) return { before: '', after: await show(`${ref}^3:${file}`) };
  return { before: await show(`${ref}^1:${file}`), after: await show(`${ref}:${file}`) };
}
async function stash(root, action, a = {}) {
  switch (action) {
    case 'push': return git(root, ['stash', 'push', ...(a.keepIndex ? ['--keep-index'] : []), ...(a.untracked ? ['--include-untracked'] : []), ...(a.message ? ['-m', a.message] : [])]);
    case 'apply': return git(root, ['stash', 'apply', ...(a.index ? ['--index'] : []), a.ref]);
    case 'pop': return git(root, ['stash', 'pop', ...(a.index ? ['--index'] : []), a.ref]);
    case 'drop': return git(root, ['stash', 'drop', a.ref]);
    case 'branch': return git(root, ['stash', 'branch', a.name, a.ref]);
    case 'clear': return git(root, ['stash', 'clear']);
    default: return { ok: false, stderr: `unknown stash action ${action}` };
  }
}

module.exports = {
  CONFLICT_KINDS, isConflictCode, operationState, parseConflicts, hasMarkers, conflictInfo, resolve, control, stashList, stashFiles, stashFile, stash,
  register({ ipcMain }) {
    ipcMain.handle('gitmerge:info', (_e, root, file) => conflictInfo(root, file));
    ipcMain.handle('gitmerge:resolve', (_e, root, file, how, content) => resolve(root, file, how, content));
    ipcMain.handle('gitmerge:control', (_e, root, action) => control(root, action));
    ipcMain.handle('gitmerge:stashList', (_e, root) => stashList(root));
    ipcMain.handle('gitmerge:stashFiles', (_e, root, ref) => stashFiles(root, ref));
    ipcMain.handle('gitmerge:stashFile', (_e, root, ref, file, untracked) => stashFile(root, ref, file, untracked));
    ipcMain.handle('gitmerge:stash', (_e, root, action, args) => stash(root, action, args));
  }
};
