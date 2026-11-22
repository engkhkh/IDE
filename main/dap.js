// Nova IDE - Debug Adapter Protocol transport + debugger installation (main process)
// The renderer implements the debugger logic; this file only starts adapters and moves messages.
//   .NET   -> netcoredbg (Samsung, MIT)            stdio      downloaded on first use
//   Node   -> js-debug (Microsoft, the VS Code one) TCP server downloaded on first use
//   Python -> debugpy (Microsoft)                  stdio      "pip install debugpy" on first use
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const { spawn, exec } = require('child_process');
const { findExecutable } = require('./lsp/servers');
const settings = require('./settings');

const isWin = process.platform === 'win32';
const JS_DEBUG_VERSION = '1.105.0';
let app, send;
const sessions = new Map(); // id -> { kind, proc, socket, server, buffer }
let nextId = 1;

const debuggersDir = () => path.join(app.getPath('userData'), 'debuggers');

// ---------------- adapter resolution ----------------
function netcoredbgAsset() {
  if (isWin) return 'netcoredbg-win64.zip';
  if (process.platform === 'darwin') return 'netcoredbg-osx-amd64.tar.gz';
  return process.arch === 'arm64' ? 'netcoredbg-linux-arm64.tar.gz' : 'netcoredbg-linux-amd64.tar.gz';
}

const ADAPTERS = {
  coreclr: {
    name: '.NET (netcoredbg)',
    find: (s) => {
      const custom = s.debuggers && s.debuggers.netcoredbg;
      if (custom && fs.existsSync(custom)) return custom;
      const local = path.join(debuggersDir(), 'netcoredbg', isWin ? 'netcoredbg.exe' : 'netcoredbg');
      if (fs.existsSync(local)) return local;
      return findExecutable('netcoredbg');
    },
    spec: (exe) => ({ kind: 'stdio', command: exe, args: ['--interpreter=vscode'] }),
    download: { url: `https://github.com/Samsung/netcoredbg/releases/latest/download/${netcoredbgAsset()}`, file: netcoredbgAsset(), dir: '' },
    missing: 'The .NET debugger (netcoredbg, ~10 MB) is not installed yet.'
  },
  'pwa-node': {
    name: 'Node.js (js-debug)',
    find: (s) => {
      const custom = s.debuggers && s.debuggers.jsDebug;
      if (custom && fs.existsSync(custom)) return custom;
      const local = path.join(debuggersDir(), 'js-debug', 'src', 'dapDebugServer.js');
      return fs.existsSync(local) ? local : null;
    },
    spec: (file) => ({ kind: 'server', command: process.execPath, args: [file, '0', '127.0.0.1'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    download: { url: `https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`, file: 'js-debug.tar.gz', dir: '' },
    missing: 'The Node.js debugger (js-debug, ~3 MB) is not installed yet.'
  },
  python: {
    name: 'Python (debugpy)',
    find: async (s) => {
      const py = findPython(s);
      if (!py) return null;
      const ok = await run(`${quoteCmd(py)} -c "import debugpy"`);
      return ok.ok ? py : null;
    },
    spec: (py) => ({ kind: 'stdio', command: py, args: ['-m', 'debugpy.adapter'] }),
    pip: true,
    missing: 'The Python debugger (debugpy) is not installed for this Python.'
  }
};

function findPython(s) {
  if (s.pythonPath && fs.existsSync(s.pythonPath)) return s.pythonPath;
  const extra = isWin
    ? fs.readdirSync('C:\\', { withFileTypes: true }).filter((d) => d.isDirectory() && /^Python3\d+$/i.test(d.name)).map((d) => `C:\\${d.name}`)
      .concat(fs.existsSync(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'))
        ? fs.readdirSync(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python')).map((d) => path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', d)) : [])
    : [];
  // skip the Microsoft Store "python.exe" stub in WindowsApps
  for (const name of isWin ? ['python'] : ['python3', 'python']) {
    const found = findExecutable(name, extra);
    if (found && !/WindowsApps/i.test(found)) return found;
  }
  for (const d of extra) { const f = path.join(d, 'python.exe'); if (fs.existsSync(f)) return f; }
  return null;
}

const quoteCmd = (p) => (/\s/.test(p) ? `"${p}"` : p);
function run(cmd, opts = {}) {
  return new Promise((resolve) => exec(cmd, { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...opts },
    (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !stdout ? err.message : '') })));
}

async function resolveAdapter(type) {
  const a = ADAPTERS[type];
  if (!a) return { ok: false, message: `No debugger for "${type}"` };
  const s = await settings.read();
  const found = await a.find(s);
  if (found) return { ok: true, name: a.name, spec: a.spec(found) };
  return { ok: false, missing: true, name: a.name, message: a.missing, installable: !!(a.download || a.pip) };
}

// ---------------- installing ----------------
async function install(type) {
  const a = ADAPTERS[type];
  const progress = (text) => send('dap:installProgress', { type, text });
  if (!a) return { ok: false, output: 'unknown debugger' };
  if (a.pip) {
    const s = await settings.read();
    const py = findPython(s);
    if (!py) return { ok: false, output: 'Python was not found. Install it from python.org (tick "Add to PATH") or set "pythonPath" in settings.json.' };
    progress(`${py} -m pip install --user debugpy`);
    const r = await run(`${quoteCmd(py)} -m pip install --user --upgrade debugpy`);
    return { ok: r.ok, output: r.stdout + r.stderr };
  }
  const { net: enet } = require('electron');
  const dest = debuggersDir();
  await fsp.mkdir(dest, { recursive: true });
  const archive = path.join(dest, a.download.file);
  progress(`Downloading ${a.download.url}`);
  try {
    const res = await enet.fetch(a.download.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = []; let got = 0; let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); got += value.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct >= 0 && pct !== lastPct && pct % 10 === 0) { lastPct = pct; progress(`Downloading... ${pct}%`); }
    }
    await fsp.writeFile(archive, Buffer.concat(chunks));
  } catch (e) {
    return { ok: false, output: `Could not download the debugger: ${e.message}\nYou can download it yourself from ${a.download.url} and extract it into ${dest}` };
  }
  progress('Extracting...');
  // tar ships with Windows 10+ and also extracts .zip files
  const r = await run(`tar -xf "${archive}" -C "${dest}"`);
  try { await fsp.unlink(archive); } catch {}
  if (!r.ok) return { ok: false, output: `Extracting failed: ${r.stderr}` };
  if (!isWin && type === 'coreclr') { try { await fsp.chmod(path.join(dest, 'netcoredbg', 'netcoredbg'), 0o755); } catch {} }
  const check = await resolveAdapter(type);
  return { ok: check.ok, output: check.ok ? `${a.name} installed in ${dest}` : 'Installed files not found after extracting.' };
}

// ---------------- transport ----------------
function attachFraming(id, readable) {
  const rec = sessions.get(id);
  readable.on('data', (chunk) => {
    rec.buffer = Buffer.concat([rec.buffer, chunk]);
    for (;;) {
      const h = rec.buffer.indexOf('\r\n\r\n');
      if (h < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(rec.buffer.slice(0, h).toString('ascii'));
      if (!m) { rec.buffer = rec.buffer.slice(h + 4); continue; }
      const len = +m[1];
      if (rec.buffer.length < h + 4 + len) return;
      const body = rec.buffer.slice(h + 4, h + 4 + len).toString('utf8');
      rec.buffer = rec.buffer.slice(h + 4 + len);
      try { send('dap:message', { id, msg: JSON.parse(body) }); } catch {}
    }
  });
}

function closed(id, info) {
  const rec = sessions.get(id);
  if (!rec || rec.closed) return;
  rec.closed = true;
  send('dap:closed', { id, ...info, stderr: (rec.stderr || '').slice(-3000) });
}

function connect(id, port) {
  return new Promise((resolve, reject) => {
    const rec = sessions.get(id);
    const sock = net.connect({ host: '127.0.0.1', port }, () => resolve());
    sock.once('error', reject);
    rec.socket = sock;
    attachFraming(id, sock);
    sock.on('close', () => closed(id, { code: 0 }));
  });
}

async function start({ type, parentId, cwd }, owner = 0) {
  const id = nextId++;
  const rec = { id, owner, buffer: Buffer.alloc(0), stderr: '' };
  sessions.set(id, rec);

  // js-debug child sessions connect to the parent's debug server
  if (parentId) {
    const parent = sessions.get(parentId);
    if (!parent || !parent.port) throw new Error('parent debug session is gone');
    rec.port = parent.port;
    rec.parentId = parentId;
    await connect(id, parent.port);
    return { id };
  }

  const r = await resolveAdapter(type);
  if (!r.ok) { sessions.delete(id); return { error: r.message, missing: r.missing, installable: r.installable, name: r.name }; }
  const spec = r.spec;
  const proc = spawn(spec.command, spec.args, { cwd: cwd || os.homedir(), env: { ...process.env, ...(spec.env || {}) }, windowsHide: true });
  rec.proc = proc;
  proc.stderr.on('data', (d) => { rec.stderr = (rec.stderr + d.toString()).slice(-8000); send('dap:log', { id, text: d.toString() }); });
  proc.on('error', (e) => closed(id, { code: -1, error: e.message }));
  proc.on('exit', (code) => closed(id, { code }));

  if (spec.kind === 'stdio') {
    proc.stdin.on('error', () => {});
    attachFraming(id, proc.stdout);
  } else {
    // server mode: wait for "listening at host:port", then connect
    rec.port = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`debug server did not start: ${out || rec.stderr}`)), 20000);
      proc.stdout.on('data', (d) => {
        out += d.toString();
        const m = /listening at [^:\s]+:(\d+)/i.exec(out);
        if (m) { clearTimeout(t); resolve(+m[1]); }
      });
      proc.on('exit', () => { clearTimeout(t); reject(new Error(`debug server exited: ${rec.stderr || out}`)); });
    }).catch((e) => { closed(id, { code: -1, error: e.message }); throw e; });
    await connect(id, rec.port);
  }
  return { id, name: r.name };
}

function write(id, msg) {
  const rec = sessions.get(id);
  if (!rec || rec.closed) return false;
  const json = JSON.stringify(msg);
  const data = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  if (rec.socket) rec.socket.write(data);
  else if (rec.proc) rec.proc.stdin.write(data);
  return true;
}

function kill(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  sessions.delete(id);
  try { if (rec.socket) rec.socket.destroy(); } catch {}
  if (rec.proc && rec.proc.exitCode === null) {
    try { if (isWin) spawn('taskkill', ['/pid', String(rec.proc.pid), '/T', '/F'], { windowsHide: true }); else rec.proc.kill(); } catch {}
  }
  closed(id, { code: 0 });
}

// the debug adapter's process (child sessions share their parent's): the program runs under it
function adapterPid(id) {
  const rec = sessions.get(id);
  if (!rec) return null;
  if (rec.proc) return rec.proc.pid;
  return rec.parentId ? adapterPid(rec.parentId) : null;
}

module.exports = {
  adapterPid,
  ADAPTERS,
  register({ ipcMain, send: s, app: a }) {
    send = s; app = a;
    ipcMain.handle('dap:start', async (ev, opts) => { try { return await start(opts, ev.sender.id); } catch (e) { return { error: e.message }; } });
    ipcMain.on('dap:send', (_e, id, msg) => write(id, msg));
    ipcMain.handle('dap:kill', (_e, id) => kill(id));
    ipcMain.handle('dap:resolve', (_e, type) => resolveAdapter(type));
    ipcMain.handle('dap:install', (_e, type) => install(type));
    // run a command and capture its output (used for "dotnet msbuild -getProperty:TargetPath")
    ipcMain.handle('proc:capture', (_e, command, cwd) => run(command, { cwd }));
  },
  windowClosed(owner) { for (const [id, s] of [...sessions]) if (s.owner === owner) kill(id); },
  dispose() { for (const id of [...sessions.keys()]) kill(id); }
};
