// Nova IDE - integrated terminal
// Uses a real pseudo-terminal (@lydell/node-pty, prebuilt binaries: no C++ build tools needed).
// If the native module can't load, falls back to a plain piped shell so the terminal still works.
const os = require('os');
const { spawn } = require('child_process');
const settings = require('./settings');

let pty = null;
try { pty = require('@lydell/node-pty'); } catch (e) { console.warn('[terminal] node-pty unavailable, using fallback:', e.message); }

const terms = new Map();
let nextId = 1;

function defaultShell(configured) {
  if (configured) return configured;
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

function create({ cwd, cols = 80, rows = 24 }, send, owner = 0) {
  return settings.read().then((s) => {
    const id = nextId++;
    const shell = defaultShell(s.terminalShell);
    const dir = cwd || os.homedir();
    const env = { ...process.env, TERM_PROGRAM: 'NovaIDE' };

    if (pty) {
      const p = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: dir, env, useConpty: true });
      p.onData((data) => send('term:data', { id, data }));
      p.onExit(({ exitCode }) => { terms.delete(id); send('term:exit', { id, code: exitCode }); });
      terms.set(id, { kind: 'pty', p, owner });
      return { id, shell, mode: 'pty' };
    }

    // Fallback: piped shell (no colors/line editing, but commands work)
    const args = /powershell|pwsh/i.test(shell) ? ['-NoLogo', '-NoExit', '-Command', '-'] : [];
    const c = spawn(shell, args, { cwd: dir, env });
    const out = (d) => send('term:data', { id, data: d.toString().replace(/\r?\n/g, '\r\n') });
    c.stdout.on('data', out);
    c.stderr.on('data', out);
    c.on('error', (err) => send('term:data', { id, data: `\r\n${err.message}\r\n` }));
    c.on('close', (code) => { terms.delete(id); send('term:exit', { id, code }); });
    terms.set(id, { kind: 'pipe', p: c, line: '', owner });
    return { id, shell, mode: 'pipe' };
  });
}

function write(id, data, send) {
  const t = terms.get(id);
  if (!t) return;
  if (t.kind === 'pty') return t.p.write(data);
  // Fallback: do simple local line editing + echo
  for (const ch of data) {
    if (ch === '\r') { send('term:data', { id, data: '\r\n' }); t.p.stdin.write(t.line + os.EOL); t.line = ''; }
    else if (ch === '\x7f' || ch === '\b') { if (t.line) { t.line = t.line.slice(0, -1); send('term:data', { id, data: '\b \b' }); } }
    else if (ch === '\x03') { t.line = ''; send('term:data', { id, data: '^C\r\n' }); }
    else if (ch >= ' ') { t.line += ch; send('term:data', { id, data: ch }); }
  }
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return;
  try {
    if (t.kind === 'pty') t.p.kill();
    else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(t.p.pid), '/T', '/F']);
    else t.p.kill();
  } catch {}
  terms.delete(id);
}

module.exports = {
  register({ ipcMain, send }) {
    ipcMain.handle('term:create', (e, opts) => create(opts || {}, send, e.sender.id));
    ipcMain.on('term:write', (_e, id, data) => write(id, data, send));
    ipcMain.on('term:resize', (_e, id, cols, rows) => {
      const t = terms.get(id);
      if (t && t.kind === 'pty' && cols > 0 && rows > 0) { try { t.p.resize(cols, rows); } catch {} }
    });
    ipcMain.handle('term:kill', (_e, id) => kill(id));
  },
  windowClosed(owner) { for (const [id, t] of [...terms]) if (t.owner === owner) kill(id); },
  dispose() { for (const id of [...terms.keys()]) kill(id); }
};
