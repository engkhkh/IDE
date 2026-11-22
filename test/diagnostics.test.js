'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { spawn } = require('child_process');
const D = require('../main/diagnostics');

test('parsers: /proc stat, ps, Windows rows', () => {
  const st = D.parseProcStat('4242 (my (odd) app) S 17 4242 4242 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0 100 1000 200');
  assert.deepStrictEqual(st, { ppid: 17, cpuTicks: 300, name: 'my (odd) app' });
  assert.strictEqual(D.parsePsTime('01:02.50'), 62.5);
  assert.strictEqual(D.parsePsTime('1-02:03:04'), 86400 + 7384);
  const ps = D.parsePs('  10     1  2048 0:01.00 /usr/bin/dotnet\n  11    10  1024 00:00:30 Shop\nbad line\n');
  assert.deepStrictEqual([...ps], [[10, { ppid: 1, mem: 2097152, cpu: 1, name: '/usr/bin/dotnet' }], [11, { ppid: 10, mem: 1048576, cpu: 30, name: 'Shop' }]]);
  const win = D.parseWinRows('4,0,0,12345,System\r\n5120,812,104857600,25000000,Shop.exe\r\n\r\n');
  assert.deepStrictEqual(win.get(5120), { ppid: 812, mem: 104857600, cpu: 2.5, name: 'Shop.exe' });
  assert.ok(/Win32_Process/.test(D.PS_SCRIPT) && /BEGIN/.test(D.PS_SCRIPT) && /END/.test(D.PS_SCRIPT));
});

test('subtree: a process and everything it started', () => {
  const t = new Map([[1, { ppid: 0 }], [10, { ppid: 1 }], [11, { ppid: 10 }], [12, { ppid: 11 }], [20, { ppid: 1 }]]);
  assert.deepStrictEqual([...D.subtree(t, 10)].sort(), [10, 11, 12]);
  assert.deepStrictEqual([...D.subtree(t, 10, { includeRoot: false })].sort(), [11, 12]);
  assert.deepStrictEqual([...D.subtree(t, 99)], []);
});

test('Windows sampler protocol: one helper process answers every request', async () => {
  // stands in for PowerShell: answers each line with BEGIN / rows / END, split over several writes
  const fake = "let n=0;require('readline').createInterface({input:process.stdin}).on('line',()=>{n++;process.stdout.write('BEG');setTimeout(()=>{process.stdout.write('IN\\r\\n100,1,'+(n*1048576)+','+(n*10000000)+',app.exe\\r\\n');process.stdout.write('E');setTimeout(()=>process.stdout.write('ND\\r\\n'),5)},5)})";
  const w = new D.WinSampler(process.execPath, ['-e', fake]);
  const a = await w.table();
  const b = await w.table();
  assert.deepStrictEqual(a.get(100), { ppid: 1, mem: 1048576, cpu: 1, name: 'app.exe' });
  assert.deepStrictEqual(b.get(100), { ppid: 1, mem: 2097152, cpu: 2, name: 'app.exe' });
  const pid = w.proc.pid;
  w.stop();
  assert.ok(pid > 0);
});

test('live: CPU and memory of a busy process (and only its children with "under")', { skip: process.platform !== 'linux' }, async () => {
  const samples = [];
  D._setSend((ch, s) => { if (ch === 'diag:sample') samples.push(s); });
  // a parent shell that starts a node process using ~1 CPU and 80 MB
  const busy = "const b=Buffer.alloc(80*1024*1024,1);const end=Date.now()+4000;while(Date.now()<end){b[Math.random()*b.length|0]++}";
  const sh = spawn('sh', ['-c', `"${process.execPath}" -e '${busy}'; sleep 0.1`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const all = D.start({ pid: sh.pid, interval: 300 }, 0);
  await new Promise((r) => setTimeout(r, 100));
  const kids = D.start({ pid: sh.pid, interval: 300 }, 0);
  D.stop(kids.id);
  const under = D.start({ pid: 1, interval: 300 }, 0); D.stop(under.id);
  await new Promise((r) => setTimeout(r, 2000));
  D.stop(all.id);
  sh.kill();
  const mine = samples.filter((s) => s.id === all.id && !s.error);
  const last = mine[mine.length - 1];
  assert.ok(mine.length >= 5, `samples: ${mine.length}`);
  assert.ok(last.procs >= 2, `procs: ${last.procs}`);
  assert.ok(last.mem > 80 * 1024 * 1024, `mem: ${last.mem}`);
  const cpu = Math.max(...mine.slice(1).map((s) => s.cpu));
  assert.ok(cpu * os.cpus().length > 60, `cpu % of all processors: ${cpu} on ${os.cpus().length} cpus`);
  assert.ok(mine.every((s) => s.cpu <= 100));
  assert.ok(last.names.includes('node'), last.names.join());
});
