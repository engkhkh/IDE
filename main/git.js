// Nova IDE - Git integration (wraps the git CLI)
const path = require('path');
const { execFile } = require('child_process');

function git(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' }, ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && err.code === 'ENOENT' ? 'git is not installed or not on PATH' : '') }));
  });
}

const toPosix = (p) => p.split(path.sep).join('/');
// unmerged paths (XY codes) during a merge / rebase / cherry-pick
const CONFLICT_KINDS = { UU: 'Both modified', AA: 'Both added', DD: 'Both deleted', AU: 'Added by us', UA: 'Added by them', DU: 'Deleted by us', UD: 'Deleted by them' };

// Parse `git status --porcelain=v1 -b -z`
function parseStatus(out) {
  const parts = out.split('\0');
  const result = { branch: '', upstream: '', ahead: 0, behind: 0, staged: [], changes: [], conflicts: [] };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const m = rec.slice(3).match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/);
      if (m) {
        result.branch = m[1];
        result.upstream = m[2] || '';
        const info = m[3] || '';
        const a = info.match(/ahead (\d+)/); const b = info.match(/behind (\d+)/);
        result.ahead = a ? +a[1] : 0; result.behind = b ? +b[1] : 0;
      }
      continue;
    }
    const x = rec[0], y = rec[1];
    let file = rec.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') { from = parts[++i]; }
    if (x === '?' && y === '?') { result.changes.push({ file, status: 'U', label: 'Untracked' }); continue; }
    if (CONFLICT_KINDS[x + y]) { result.conflicts.push({ file, status: 'C', code: x + y, label: CONFLICT_KINDS[x + y] }); continue; }
    if (x !== ' ' && x !== '?') result.staged.push({ file, from, status: x, label: LABELS[x] || x });
    if (y !== ' ' && y !== '?') result.changes.push({ file, status: y, label: LABELS[y] || y });
  }
  return result;
}
const LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', T: 'Type changed' };

async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.normalize(r.stdout.trim()) : null;
}

module.exports = {
  parseStatus, git, repoRoot, CONFLICT_KINDS,
  register({ ipcMain }) {
    ipcMain.handle('git:status', async (_e, cwd) => {
      const root = await repoRoot(cwd);
      if (!root) {
        const v = await git(cwd, ['--version']);
        return { repo: false, gitInstalled: v.ok };
      }
      const r = await git(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
      if (!r.ok) return { repo: true, root, error: r.stderr };
      const op = await require('./gitmerge').operationState(root);
      return { repo: true, root, ...parseStatus(r.stdout), op };
    });

    // Content of a file at HEAD (or the index with ref ':') for the diff view
    ipcMain.handle('git:show', async (_e, root, file, ref = 'HEAD') => {
      const rel = toPosix(path.relative(root, path.resolve(root, file)));
      const r = await git(root, ['show', `${ref}:${rel}`]);
      return r.ok ? r.stdout : '';
    });

    ipcMain.handle('git:stage', (_e, root, files) => git(root, ['add', '--', ...files]));
    ipcMain.handle('git:unstage', async (_e, root, files) => {
      const r = await git(root, ['restore', '--staged', '--', ...files]);
      return r.ok ? r : git(root, ['rm', '--cached', '-r', '--', ...files]); // no commits yet
    });
    ipcMain.handle('git:discard', async (_e, root, files, untracked) => {
      if (untracked) return git(root, ['clean', '-f', '--', ...files]);
      return git(root, ['restore', '--', ...files]);
    });
    // signed commits: SSH key (gpg.format=ssh), GPG key, or X.509 (gpgsm) — from Options > Source Control
    ipcMain.handle('git:commit', async (_e, root, message, opts = {}) => {
      const s = await require('./settings').read();
      const sign = s.gitSignCommits ? [...(s.gitSigningFormat && s.gitSigningFormat !== 'openpgp' ? ['-c', `gpg.format=${s.gitSigningFormat}`] : []), ...(s.gitSigningKey ? ['-c', `user.signingkey=${s.gitSigningKey}`] : [])] : [];
      return git(root, [...sign, 'commit', ...(s.gitSignCommits ? ['-S'] : []), ...(opts.all ? ['-a'] : []), ...(opts.amend ? ['--amend'] : []), '-m', message]);
    });
    // partial staging: write the chosen text as the file's index entry (stage / unstage selected lines)
    ipcMain.handle('git:setIndex', async (_e, root, file, text) => {
      const ls = await git(root, ['ls-files', '-s', '--', file]);
      const mode = (ls.stdout.match(/^(\d{6}) /) || [])[1] || '100644';
      const hash = await new Promise((resolve) => {
        const p = require('child_process').execFile('git', ['hash-object', '-w', '--stdin', '--path', file], { cwd: root, windowsHide: true }, (err, stdout, stderr) => resolve(err ? { error: stderr || err.message } : { sha: stdout.trim() }));
        p.stdin.end(text);
      });
      if (hash.error) return { ok: false, stderr: hash.error };
      return git(root, ['update-index', '--add', '--cacheinfo', `${mode},${hash.sha},${toPosix(file)}`]);
    });
    // signature of a commit: G good, B bad, U good but unknown validity, N none...
    ipcMain.handle('git:signature', async (_e, root, rev = 'HEAD') => {
      const r = await git(root, ['log', '-1', '--format=%G?|%GS|%GK', rev]);
      const [status, signer, key] = r.stdout.trim().split('|');
      return { status: status || 'N', signer, key, ok: r.ok };
    });
    ipcMain.handle('git:branches', async (_e, root) => {
      const r = await git(root, ['branch', '-a', '--format=%(HEAD)|%(refname:short)']);
      return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [h, name] = l.split('|'); return { name, current: h === '*', remote: name.includes('/') }; })
        .filter((b) => !b.name.endsWith('/HEAD'));
    });
    ipcMain.handle('git:checkout', (_e, root, branch, create) => git(root, create ? ['checkout', '-b', branch] : ['checkout', branch]));
    ipcMain.handle('git:pull', (_e, root) => git(root, ['pull']));
    ipcMain.handle('git:push', async (_e, root) => {
      const r = await git(root, ['push']);
      // no upstream yet, or one with another name (a branch started from origin/main): publish it under its own name
      if (!r.ok && /no upstream|does not match\s+the name of your current branch/i.test(r.stderr)) return git(root, ['push', '-u', 'origin', 'HEAD']);
      return r;
    });
    ipcMain.handle('git:fetch', (_e, root) => git(root, ['fetch', '--all', '--prune']));
    ipcMain.handle('git:init', (_e, cwd) => git(cwd, ['init']));
    ipcMain.handle('git:log', async (_e, root, n = 50) => {
      const r = await git(root, ['log', `-n${n}`, '--date=relative', '--pretty=format:%h\x1f%an\x1f%ad\x1f%s']);
      return r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, author, date, subject] = l.split('\x1f'); return { hash, author, date, subject }; });
    });
  }
};
