// Nova IDE - Git history: commit graph, commit details, file history, blame and history operations
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { git } = require('./git');

const US = '\x1f', RS = '\x1e';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const toPosix = (p) => p.split(path.sep).join('/');
const rel = (root, file) => toPosix(path.relative(root, path.resolve(root, file)));

// ---------------- log ----------------
const LOG_FORMAT = `${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%D${US}%s`;
function parseRefs(d) {
  // "HEAD -> main, origin/main, tag: v1.0"
  const refs = [];
  for (let r of (d || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (r.startsWith('HEAD -> ')) { refs.push({ type: 'head', name: 'HEAD' }); r = r.slice(8); refs.push({ type: 'branch', name: r, current: true }); continue; }
    if (r === 'HEAD') { refs.push({ type: 'head', name: 'HEAD', detached: true }); continue; }
    if (r.startsWith('tag: ')) { refs.push({ type: 'tag', name: r.slice(5) }); continue; }
    if (r.endsWith('/HEAD')) continue;
    refs.push({ type: 'branch', name: r }); // history() marks the ones that are not local branches as remote
  }
  return refs;
}
function parseLog(out, { withFiles = false } = {}) {
  const commits = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const head = nl < 0 ? rec : rec.slice(0, nl);
    const [hash, parents, author, email, time, refs, ...subject] = head.split(US);
    if (!hash || !/^[0-9a-f]{7,}$/.test(hash)) continue;
    const c = { hash, parents: parents ? parents.split(' ').filter(Boolean) : [], author, email, time: +time, refs: parseRefs(refs), subject: subject.join(US) };
    if (withFiles && nl >= 0) {
      // --name-status lines: "M\tpath" or "R087\told\tnew"
      const ns = rec.slice(nl + 1).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t'));
      const last = ns.find((p) => /^[A-Z]/.test(p[0]));
      if (last) c.file = { status: last[0][0], path: last[last.length - 1], from: last.length > 2 ? last[1] : null };
    }
    commits.push(c);
  }
  return commits;
}

// ---------------- graph lanes ----------------
// Lanes are columns. Each lane waits for a commit hash. Every row says which lane the commit sits in
// and which line segments to draw: from the top of the row to the commit dot ("in"), from the dot to the
// bottom ("out") and lanes that just pass through. state carries on to the next page of commits.
function newGraphState() { return { lanes: [], next: 0 }; }
function layoutGraph(commits, state = newGraphState()) {
  const lanes = state.lanes;
  const rows = [];
  for (const c of commits) {
    const before = lanes.slice();
    let idx = before.findIndex((s) => s && s.hash === c.hash);
    const hasIncoming = idx >= 0;
    if (idx < 0) {
      idx = lanes.findIndex((s) => !s);
      if (idx < 0) idx = lanes.length;
      lanes[idx] = { hash: c.hash, color: state.next++ };
    }
    const color = lanes[idx].color;
    for (let j = 0; j < lanes.length; j++) if (j !== idx && lanes[j] && lanes[j].hash === c.hash) lanes[j] = null; // children converge here
    lanes[idx] = c.parents[0] ? { hash: c.parents[0], color } : null;
    for (const p of c.parents.slice(1)) {
      if (lanes.some((s) => s && s.hash === p)) continue;
      let slot = lanes.findIndex((s, j) => !s && j > idx);
      if (slot < 0) slot = lanes.findIndex((s) => !s);
      if (slot < 0) slot = lanes.length;
      lanes[slot] = { hash: p, color: state.next++ };
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const after = lanes.slice();
    const segs = [];
    before.forEach((s, j) => {
      if (!s) return;
      if (s.hash === c.hash) { segs.push([j, 0, idx, 1, s.color]); return; } // top -> dot
      const k = after[j] && after[j].hash === s.hash ? j : after.findIndex((a) => a && a.hash === s.hash);
      if (k >= 0) segs.push([j, 0, k, 2, s.color]); // passing through
    });
    c.parents.forEach((p, n) => {
      const k = n === 0 ? idx : after.findIndex((a) => a && a.hash === p);
      if (k >= 0) segs.push([idx, 1, k, 2, n === 0 ? color : (after[k] ? after[k].color : color)]); // dot -> bottom
    });
    rows.push({ lane: idx, color, segs, width: Math.max(before.length, after.length, idx + 1), incoming: hasIncoming });
  }
  return { rows, state };
}

// ---------------- details ----------------
function parseNameStatus(out) {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (!s) continue;
    if (/^[RC]\d*$/.test(s)) { files.push({ status: s[0], from: t[i + 1], path: t[i + 2] }); i += 2; } else if (/^[AMDTU]$/.test(s)) { files.push({ status: s, path: t[i + 1] }); i += 1; }
  }
  return files;
}
function parseNumstat(out) {
  const t = out.split('\0');
  const map = new Map();
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (!s) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(s);
    if (!m) continue;
    let p = m[3];
    if (p === '') { p = t[i + 2]; i += 2; } // rename: "a\td\t" old new
    map.set(p, { added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2] });
  }
  return map;
}

// ---------------- blame ----------------
function parseBlame(out) {
  const commits = {};
  const lines = [];
  let cur = null;
  const rows = out.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i];
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(l);
    if (h) { cur = h[1]; if (!commits[cur]) commits[cur] = { hash: cur }; lines[+h[3] - 1] = cur; continue; }
    if (!cur) continue;
    if (l.startsWith('\t')) continue;
    const sp = l.indexOf(' ');
    const key = sp < 0 ? l : l.slice(0, sp), val = sp < 0 ? '' : l.slice(sp + 1);
    const c = commits[cur];
    if (key === 'author') c.author = val;
    else if (key === 'author-mail') c.email = val.replace(/[<>]/g, '');
    else if (key === 'author-time') c.time = +val;
    else if (key === 'summary') c.summary = val;
  }
  for (const c of Object.values(commits)) if (/^0+$/.test(c.hash)) { c.uncommitted = true; c.author = 'You'; c.summary = 'Not committed yet'; }
  return { lines, commits };
}
function blame(root, file, contents) {
  return new Promise((resolve) => {
    const args = ['blame', '--porcelain', ...(contents != null ? ['--contents', '-'] : []), '--', rel(root, file)];
    const p = spawn('git', args, { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' } });
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? parseBlame(out) : { error: err.trim() || `git blame exited with ${code}` }));
    if (contents != null) p.stdin.end(contents); else p.stdin.end();
  });
}

// ---------------- requests ----------------
async function markRemotes(root, commits) {
  const local = new Set((await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean));
  for (const c of commits) for (const x of c.refs) if (x.type === 'branch' && !local.has(x.name)) x.type = 'remote';
}
async function history(root, opts = {}) {
  const { ref = 'all', skip = 0, limit = 400, file = null, search = '', graphState = null } = opts;
  const args = ['-c', 'core.quotePath=false', 'log', `--pretty=format:${LOG_FORMAT}`, `--skip=${skip}`, `-n${limit}`];
  if (file) args.push('--follow', '--name-status', '-M');
  else args.push('--date-order');
  if (!file) {
    if (ref === 'all') args.push('--branches', '--remotes', '--tags', 'HEAD');
    else args.push(ref);
  } else args.push(ref === 'all' ? 'HEAD' : ref);
  if (file) args.push('--', rel(root, file));
  if (search) {
    // message OR author OR commit id (git would AND --grep with --author, so run them separately)
    const base = args.filter((x) => !/^--skip=/.test(x));
    const at = base.indexOf('log') + 1;
    const q = (extra) => git(root, [...base.slice(0, at), ...extra, ...base.slice(at)]);
    const results = await Promise.all([q(['-i', `--grep=${search}`]), q(['-i', `--author=${search}`])]);
    const seen = new Map();
    if (/^[0-9a-f]{4,40}$/i.test(search)) {
      const v = await git(root, ['rev-parse', '--verify', '--quiet', `${search}^{commit}`]);
      if (v.ok) for (const c of parseLog((await git(root, ['log', '-1', `--pretty=format:${LOG_FORMAT}`, v.stdout.trim()])).stdout)) seen.set(c.hash, c);
    }
    for (const x of results) for (const c of parseLog(x.stdout, { withFiles: !!file })) if (!seen.has(c.hash)) seen.set(c.hash, c);
    const commits = [...seen.values()].sort((a, b2) => b2.time - a.time);
    await markRemotes(root, commits);
    return { commits, rows: null, done: true };
  }
  const r = await git(root, args);
  if (!r.ok) {
    if (/does not have any commits|unknown revision|bad default revision/i.test(r.stderr)) return { commits: [], rows: [], done: true, graphState: newGraphState() };
    return { error: r.stderr.trim() || 'git log failed' };
  }
  const commits = parseLog(r.stdout, { withFiles: !!file });
  await markRemotes(root, commits);
  if (file) return { commits, rows: null, done: commits.length < limit };
  const g = layoutGraph(commits, graphState || newGraphState());
  return { commits, rows: g.rows, graphState: g.state, done: commits.length < limit };
}

async function refs(root) {
  const r = await git(root, ['for-each-ref', `--format=%(refname)${US}%(objectname)${US}%(HEAD)${US}%(upstream:short)${US}%(upstream:track)${US}%(committerdate:unix)`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const out = { local: [], remote: [], tags: [], head: null };
  for (const l of r.stdout.split('\n').filter(Boolean)) {
    const [name, hash, head, upstream, track, time] = l.split(US);
    if (name.endsWith('/HEAD')) continue;
    if (name.startsWith('refs/heads/')) out.local.push({ name: name.slice(11), hash, current: head === '*', upstream, track: track.replace(/[[\]]/g, ''), time: +time });
    else if (name.startsWith('refs/remotes/')) out.remote.push({ name: name.slice(13), hash, time: +time });
    else out.tags.push({ name: name.slice(10), hash, time: +time });
  }
  const h = await git(root, ['rev-parse', 'HEAD']);
  out.head = h.ok ? h.stdout.trim() : null;
  return out;
}

async function details(root, hash) {
  const r = await git(root, ['show', '-s', `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${US}%D${US}%B`, hash]);
  if (!r.ok) return { error: r.stderr.trim() };
  const [h, parents, author, email, atime, committer, cemail, ctime, refsText, ...body] = r.stdout.split(US);
  const ps = parents ? parents.split(' ').filter(Boolean) : [];
  const base = ps[0] || EMPTY_TREE;
  const [ns, num] = await Promise.all([
    git(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-M', '-z', '--name-status', base, h]),
    git(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-M', '-z', '--numstat', base, h])
  ]);
  const stats = parseNumstat(num.stdout);
  const files = parseNameStatus(ns.stdout).map((f) => ({ ...f, ...(stats.get(f.path) || {}) }));
  return { hash: h, parents: ps, author, email, time: +atime, committer, committerEmail: cemail, committerTime: +ctime, refs: parseRefs(refsText), message: body.join(US).trim(), files };
}

async function fileAt(root, ref, file) {
  if (!ref) return { text: '' };
  const r = await git(root, ['show', `${ref}:${toPosix(file)}`]);
  return r.ok ? { text: r.stdout } : { text: '', missing: true };
}

// operations started from the history (all return the git result)
async function op(root, kind, a = {}) {
  const run = (args) => git(root, args);
  switch (kind) {
    case 'checkout': return run(['checkout', a.ref]);
    case 'branch': return run(a.checkout ? ['checkout', '-b', a.name, a.at] : ['branch', a.name, a.at]);
    case 'tag': return run(a.message ? ['tag', '-a', a.name, a.at, '-m', a.message] : ['tag', a.name, a.at]);
    case 'deleteBranch': return run(['branch', a.force ? '-D' : '-d', a.name]);
    case 'deleteTag': return run(['tag', '-d', a.name]);
    case 'cherryPick': return run(['cherry-pick', ...(a.merge ? ['-m', '1'] : []), a.hash]);
    case 'revert': return run(['revert', '--no-edit', ...(a.merge ? ['-m', '1'] : []), a.hash]);
    case 'reset': return run(['reset', a.mode === 'hard' ? '--hard' : a.mode === 'soft' ? '--soft' : '--mixed', a.hash]);
    case 'merge': return run(['merge', '--no-edit', a.ref]);
    default: return { ok: false, stderr: `Unknown operation ${kind}` };
  }
}

module.exports = {
  parseLog, parseRefs, layoutGraph, newGraphState, parseNameStatus, parseNumstat, parseBlame, history, refs, details, blame, fileAt, op,
  register({ ipcMain }) {
    ipcMain.handle('githist:log', (_e, root, opts) => history(root, opts));
    ipcMain.handle('githist:refs', (_e, root) => refs(root));
    ipcMain.handle('githist:details', (_e, root, hash) => details(root, hash));
    ipcMain.handle('githist:fileAt', (_e, root, ref, file) => fileAt(root, ref, file));
    ipcMain.handle('githist:blame', (_e, root, file, contents) => blame(root, file, contents));
    ipcMain.handle('githist:op', (_e, root, kind, args) => op(root, kind, args));
  }
};
