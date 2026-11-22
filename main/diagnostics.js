// Nova IDE - Diagnostic Tools: CPU and memory of the program being debugged or profiled
// Samples the operating system's process table: /proc on Linux, `ps` on macOS, and on Windows one
// long-running PowerShell that answers each tick with Win32_Process (no new process per sample).
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------------- process tables: Map pid -> { ppid, mem (bytes), cpu (seconds used so far), name } ----------------
let clkTck = 100;
let pageSize = 4096;
try { execFile('getconf', ['CLK_TCK'], (e, out) => { if (!e && +out > 0) clkTck = +out; }); execFile('getconf', ['PAGESIZE'], (e, out) => { if (!e && +out > 0) pageSize = +out; }); } catch {}

// /proc/<pid>/stat: "pid (name) state ppid ... utime(14) stime(15) ..." - the name may contain spaces and ")"
function parseProcStat(text) {
  const close = text.lastIndexOf(')');
  const name = text.slice(text.indexOf('(') + 1, close);
  const f = text.slice(close + 2).split(' ');
  return { ppid: +f[1], cpuTicks: +f[11] + +f[12], name };
}
async function linuxTable(wanted) {
  const table = new Map();
  let ents = [];
  try { ents = await fsp.readdir('/proc'); } catch { return table; }
  await Promise.all(ents.filter((e) => /^\d+$/.test(e)).map(async (e) => {
    try {
      const st = parseProcStat(await fsp.readFile(`/proc/${e}/stat`, 'utf8'));
      table.set(+e, { ppid: st.ppid, cpu: st.cpuTicks / clkTck, mem: 0, name: st.name });
    } catch {}
  }));
  // memory only for the processes we report on
  await Promise.all([...wanted(table)].map(async (pid) => {
    try { const statm = (await fsp.readFile(`/proc/${pid}/statm`, 'utf8')).split(' '); table.get(pid).mem = +statm[1] * pageSize; } catch {}
  }));
  return table;
}

// `ps -A -o pid=,ppid=,rss=,time=,comm=`; time is [[dd-]hh:]mm:ss(.cc)
function parsePsTime(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim());
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + +m[3] * 60 + +m[4];
}
function parsePs(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) table.set(+m[1], { ppid: +m[2], mem: +m[3] * 1024, cpu: parsePsTime(m[4]), name: m[5] });
  }
  return table;
}
function psTable() {
  return new Promise((resolve) => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (e, out) => resolve(e ? new Map() : parsePs(String(out)))));
}

// Windows: PowerShell prints BEGIN, "pid,ppid,privateBytes,cpu100ns,name" lines, END for every line it reads
const PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  $rows = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,PrivatePageCount,KernelModeTime,UserModeTime,Name | ForEach-Object { '{0},{1},{2},{3},{4}' -f $_.ProcessId, $_.ParentProcessId, $_.PrivatePageCount, ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime), $_.Name }",
  "  [Console]::Out.WriteLine('BEGIN')",
  '  foreach ($r in $rows) { [Console]::Out.WriteLine($r) }',
  "  [Console]::Out.WriteLine('END')",
  '  [Console]::Out.Flush()',
  '}'
].join('\n');
function parseWinRows(text) {
  const table = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d*),(\d*),(.*)$/.exec(line.trim());
    if (m) table.set(+m[1], { ppid: +m[2], mem: +m[3] || 0, cpu: (+m[4] || 0) / 1e7, name: m[5] });
  }
  return table;
}
class WinSampler {
  constructor(command = 'powershell.exe', args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT]) {
    this.command = command; this.args = args;
    this.proc = null; this.buf = ''; this.waiting = [];
  }
  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let end;
      while ((end = this.buf.indexOf('END')) >= 0) {
        const chunk = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 3);
        const start = chunk.lastIndexOf('BEGIN');
        const w = this.waiting.shift();
        if (w) w(parseWinRows(start >= 0 ? chunk.slice(start + 5) : chunk));
      }
    });
    const fail = () => { this.proc = null; for (const w of this.waiting.splice(0)) w(new Map()); };
    this.proc.on('exit', fail);
    this.proc.on('error', fail);
    this.proc.stdin.on('error', () => {});
  }
  table() {
    this.start();
    return new Promise((resolve) => {
      const t = setTimeout(() => { const i = this.waiting.indexOf(done); if (i >= 0) this.waiting.splice(i, 1); resolve(new Map()); }, 10000);
      const done = (m) => { clearTimeout(t); resolve(m); };
      this.waiting.push(done);
      try { this.proc.stdin.write('sample\n'); } catch { done(new Map()); }
    });
  }
  stop() { if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} this.proc = null; } }
}

let winSampler = null;
function tableFor(wanted) {
  if (process.platform === 'linux') return linuxTable(wanted);
  if (process.platform === 'win32') { winSampler = winSampler || new WinSampler(); return winSampler.table(); }
  return psTable();
}

// a pid and everything started from it
function subtree(table, root, { includeRoot = true } = {}) {
  const out = new Set();
  if (!table.has(root)) return out;
  const kids = new Map();
  for (const [pid, p] of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const k of kids.get(pid) || []) stack.push(k);
  }
  if (!includeRoot) out.delete(root);
  return out;
}

// ---------------- sessions ----------------
// target: { pid } (a process and its children), or { under } (the children of a debug adapter, not the adapter)
let send = () => {};
let ownerId = () => 0;
let dap = null;
let procPid = () => null;
const sessions = new Map();
let nextId = 1;
const NCPU = Math.max(1, os.cpus().length);

function pidsFor(s, table) {
  if (s.pid) return subtree(table, s.pid);
  if (s.under) return subtree(table, s.under, { includeRoot: false });
  return new Set();
}
async function tick(s) {
  if (s.busy || s.stopped) return;
  s.busy = true;
  try {
    let wanted = null;
    const table = await tableFor((t) => (wanted = pidsFor(s, t)));
    if (s.stopped) return;
    const pids = wanted || pidsFor(s, table);
    const now = Date.now();
    let mem = 0, cpuDelta = 0;
    const cpuNow = new Map();
    for (const pid of pids) {
      const p = table.get(pid);
      if (!p) continue;
      mem += p.mem;
      cpuNow.set(pid, p.cpu);
      // processes seen last time: their CPU time grew by this much
      if (s.lastCpu.has(pid)) cpuDelta += Math.max(0, p.cpu - s.lastCpu.get(pid));
    }
    const wall = (now - s.lastAt) / 1000;
    const cpu = s.lastAt && wall > 0 ? Math.min(100, (cpuDelta / (wall * NCPU)) * 100) : 0;
    s.lastCpu = cpuNow; s.lastAt = now;
    if (pids.size) s.seen = true;
    const names = [...pids].map((p) => table.get(p) && table.get(p).name).filter(Boolean);
    const sample = { id: s.id, t: now - s.start, cpu: Math.round(cpu * 10) / 10, mem, procs: pids.size, names: [...new Set(names)].slice(0, 6) };
    s.samples.push(sample);
    s.lastPids = [...pids];
    send('diag:sample', sample);
  } catch (e) { send('diag:sample', { id: s.id, error: e.message }); } finally { s.busy = false; }
}

function start(opts, owner) {
  const id = nextId++;
  const s = { id, owner, start: Date.now(), lastAt: 0, lastCpu: new Map(), samples: [], interval: opts.interval || (process.platform === 'win32' ? 1000 : 500) };
  if (opts.pid) s.pid = +opts.pid;
  else if (opts.procId != null) { s.pid = procPid(opts.procId); if (!s.pid) return { error: 'The program is not running.' }; }
  else if (opts.dapId != null) {
    const pid = dap && dap.adapterPid(opts.dapId);
    if (!pid) return { error: 'The debugger is not running.' };
    s.under = pid;
  } else return { error: 'Nothing to watch.' };
  sessions.set(id, s);
  tick(s);
  s.timer = setInterval(() => tick(s), s.interval);
  return { id, interval: s.interval, cpus: NCPU };
}
function stop(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.stopped = true;
  clearInterval(s.timer);
  sessions.delete(id);
  if (!sessions.size && winSampler) { winSampler.stop(); winSampler = null; }
  return true;
}
// the debugger told us the program's process id: watch exactly that process (and its children)
function setPid(id, pid) { const s = sessions.get(id); if (s && pid) { s.pid = +pid; s.under = null; s.lastCpu = new Map(); } return !!s; }

// the processes the session watches right now (for heap snapshots)
function pidsOf(id) { const s = sessions.get(id); return s ? (s.lastPids || (s.pid ? [s.pid] : [])) : []; }

module.exports = {
  pidsOf,
  parseProcStat, parsePs, parsePsTime, parseWinRows, subtree, linuxTable, psTable, WinSampler, PS_SCRIPT, start, stop, setPid,
  _setSend(fn) { send = fn; },
  register({ ipcMain, send: s, ownerId: o, procPid: pp }) {
    send = s;
    if (o) ownerId = o;
    if (pp) procPid = pp;
    try { dap = require('./dap'); } catch {}
    ipcMain.handle('diag:start', (_e, opts) => start(opts || {}, ownerId()));
    ipcMain.handle('diag:stop', (_e, id) => stop(id));
    ipcMain.handle('diag:setPid', (_e, id, pid) => setPid(id, pid));
  },
  windowClosed(owner) { for (const [id, s] of [...sessions]) if (s.owner === owner) stop(id); },
  dispose() { for (const id of [...sessions.keys()]) stop(id); }
};
