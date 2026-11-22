// Nova IDE - Test Explorer back end: find tests in source, run them with "dotnet test", read TRX results
// Works with any VSTest framework (xUnit, NUnit, MSTest): discovery comes from the source (instant, with
// file and line) and results from the TRX file "dotnet test" writes.
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const COV = require('./coverage');

const TEST_ATTRS = /^(Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod|SkippableFact|SkippableTheory)$/;
const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'TestResults']);

// ---------------- source scanner ----------------
// Finds test methods in C# code: [Fact], [Theory], [Test], [TestCase(...)], [TestMethod], [DataTestMethod]
// The code is read in chunks between "{", "}" and ";". A namespace/class declaration attaches to the
// next "{"; every "}" closes one block. Attributes collected before a method mark it as a test.
function scanSource(text, file) {
  const tests = [];
  const lines = text.split(/\r?\n/);
  let fileNs = '';
  const stack = [];      // { kind: 'ns' | 'class' | 'block', name }
  let pendingDecl = null;
  let pendingAttrs = [];
  let pendingSkip = null;
  let inComment = false;

  function chunk(textPart, rawLine, lineNo) {
    let c = textPart;
    let m;
    if ((m = /^\s*namespace\s+([\w.]+)\s*$/.exec(c))) { pendingDecl = { kind: 'ns', name: m[1] }; return; }
    // leading attribute groups: [A] [B(1), C]
    while ((m = /^\s*\[([^\]]*)\]/.exec(c))) {
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const name = ((/^\s*([\w.]+)/.exec(part) || [])[1] || '').split('.').pop().replace(/Attribute$/, '');
        if (TEST_ATTRS.test(name)) {
          pendingAttrs.push(name);
          const sk = /\bSkip\s*=\s*"([^"]*)"/.exec(rawLine);
          if (sk) pendingSkip = sk[1] || 'skipped';
        } else if (name === 'Ignore') pendingSkip = 'ignored';
      }
      c = c.slice(m[0].length);
    }
    if ((m = /\b(?:class|record|struct)\s+(\w+)/.exec(c)) && !/\bnew\b/.test(c.slice(0, m.index))) { pendingDecl = { kind: 'class', name: m[1] }; pendingAttrs = []; pendingSkip = null; return; }
    if (pendingAttrs.length && (m = /([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(c)) && !/\bnew\b/.test(c)) {
      const ns = [fileNs, ...stack.filter((b) => b.kind === 'ns').map((b) => b.name)].filter(Boolean).join('.');
      const classes = stack.filter((b) => b.kind === 'class').map((b) => b.name);
      if (classes.length) {
        const className = [ns, classes.join('+')].filter(Boolean).join('.');
        tests.push({ fqn: `${className}.${m[1]}`, className, method: m[1], namespace: ns, file, line: lineNo, data: /Theory|TestCase|DataTestMethod/.test(pendingAttrs.join()), skip: pendingSkip });
      }
      pendingAttrs = [];
      pendingSkip = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inComment) { const e = line.indexOf('*/'); if (e < 0) continue; line = line.slice(e + 2); inComment = false; }
    // blank out strings/chars first (they may contain // or braces), then comments
    let code = line.replace(/@?\$?"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "''");
    code = code.replace(/\/\*.*?\*\//g, '');
    const bc = code.indexOf('/*'); if (bc >= 0) { code = code.slice(0, bc); inComment = true; }
    code = code.replace(/\/\/.*$/, '');
    const fm = /^\s*namespace\s+([\w.]+)\s*;/.exec(code);
    if (fm) { fileNs = fm[1]; continue; }

    let buf = '';
    for (const ch of code) {
      if (ch === '{' || ch === '}' || ch === ';') {
        if (buf.trim()) chunk(buf, line, i + 1);
        buf = '';
        if (ch === '{') { stack.push(pendingDecl || { kind: 'block' }); pendingDecl = null; }
        else if (ch === '}') stack.pop();
        else if (pendingDecl && pendingDecl.kind === 'class') pendingDecl = null; // record X(int A);
      } else buf += ch;
    }
    if (buf.trim()) chunk(buf, line, i + 1);
  }
  return tests;
}

async function scanProject(projPath) {
  const dir = path.dirname(projPath);
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full); }
      else if (/\.cs$/i.test(e.name)) {
        try { out.push(...scanSource(await fsp.readFile(full, 'utf8'), full)); } catch {}
      }
    }
  }
  await walk(dir);
  return out;
}

// ---------------- TRX parsing ----------------
const unxml = (s) => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const attr = (s, n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(s); return m ? unxml(m[1]) : ''; };
const inner = (s, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s); return m ? unxml(m[1]) : ''; };

function parseDuration(d) { // 00:00:00.0109715
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d || '');
  return m ? Math.round(((+m[1] * 60 + +m[2]) * 60 + parseFloat(m[3])) * 1000) : 0;
}

function parseTrx(text) {
  const defs = new Map();
  const defRe = /<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g;
  let m;
  while ((m = defRe.exec(text))) {
    const tm = /<TestMethod\b([^>]*)\/?>/.exec(m[2]);
    defs.set(attr(m[1], 'id'), { name: attr(m[1], 'name'), className: tm ? attr(tm[1], 'className') : '', method: tm ? attr(tm[1], 'name') : '', source: tm ? attr(tm[1], 'codeBase') : attr(m[1], 'storage') });
  }
  const results = [];
  const resRe = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  while ((m = resRe.exec(text))) {
    const id = attr(m[1], 'testId');
    const def = defs.get(id) || {};
    const body = m[2] || '';
    const outcomeRaw = attr(m[1], 'outcome');
    const outcome = /^Passed$/i.test(outcomeRaw) ? 'passed' : /^(Failed|Error|Timeout|Aborted)$/i.test(outcomeRaw) ? 'failed' : 'skipped';
    let className = def.className || '';
    let method = def.method || '';
    // xUnit reports the class name in className and the method in name; NUnit/MSTest similar. Fall back to splitting.
    const display = attr(m[1], 'testName') || def.name || '';
    if (!className || !method) { const base = display.replace(/\(.*$/, ''); className = base.slice(0, base.lastIndexOf('.')); method = base.slice(base.lastIndexOf('.') + 1); }
    if (method.includes('.')) method = method.slice(method.lastIndexOf('.') + 1);
    results.push({
      id, name: display, className, method, fqn: `${className}.${method.replace(/\(.*$/, '')}`, outcome, outcomeRaw,
      duration: parseDuration(attr(m[1], 'duration')), message: inner(body, 'Message'), stack: inner(body, 'StackTrace'), stdout: inner(body, 'StdOut'),
      source: def.source || ''
    });
  }
  const counters = /<Counters\b([^>]*)\/>/.exec(text);
  return { results, total: counters ? +attr(counters[1], 'total') : results.length };
}

// ---------------- running ----------------
const runs = new Map();
let nextRun = 1;

function escapeFilter(s) { return s.replace(/[\\()&|=!~]/g, (c) => `\\${c}`); }

async function run({ target, filters, debug, noBuild, cwd, coverage, root, owner }, send) {
  const id = nextRun++;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-tests-'));
  const args = ['test', target, '--logger', 'trx', '--results-directory', dir];
  if (noBuild) args.push('--no-build');
  if (filters && filters.length) args.push('--filter', filters.join('|'));
  let collector = null;
  if (coverage) {
    // coverlet when the project references it, otherwise Microsoft Code Coverage (part of Microsoft.NET.Test.Sdk)
    let projText = '';
    try { if (/proj$/i.test(target)) projText = await fsp.readFile(target, 'utf8'); } catch {}
    collector = COV.collectorFor(projText);
    args.push('--collect', collector);
  }
  const env = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_UI_LANGUAGE: 'en' };
  if (debug) env.VSTEST_HOST_DEBUG = '1';
  // its own process group on Linux/macOS, so Cancel also stops the test host it starts
  const child = spawn('dotnet', args, { cwd: cwd || path.dirname(target), env, windowsHide: true, detached: process.platform !== 'win32' });
  const rec = { id, child, dir, attached: false, owner: owner || 0 };
  runs.set(id, rec);
  send('tests:output', { id, text: `> dotnet ${args.map((a) => (/\s|\|/.test(a) ? `"${a}"` : a)).join(' ')}\n` });
  const onData = (d) => {
    const text = d.toString();
    send('tests:output', { id, text });
    if (debug && !rec.attached) {
      const pm = /Process Id:\s*(\d+)/.exec(text);
      if (pm) { rec.attached = true; send('tests:debugReady', { id, pid: +pm[1] }); }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => send('tests:output', { id, text: `\n${e.message}\n` }));
  child.on('close', async (code) => {
    runs.delete(id);
    let results = [];
    try {
      for (const f of await fsp.readdir(dir)) if (/\.trx$/i.test(f)) results.push(...parseTrx(await fsp.readFile(path.join(dir, f), 'utf8')).results);
    } catch {}
    let cov = null;
    if (coverage && !rec.cancelled) {
      cov = { collector, records: [], reports: 0 };
      for (const f of await COV.findReports(dir)) {
        try { cov.records.push(...COV.parseAny(await fsp.readFile(f, 'utf8'), { root }).records); cov.reports++; } catch (e) { send('tests:output', { id, text: `Could not read coverage report ${f}: ${e.message}\n` }); }
      }
    }
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    send('tests:done', { id, code, results, cancelled: !!rec.cancelled, coverage: cov });
  });
  return { id };
}

function cancel(id) {
  const rec = runs.get(id);
  if (!rec) return false;
  rec.cancelled = true;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(rec.child.pid), '/T', '/F'], { windowsHide: true });
    else {
      process.kill(-rec.child.pid, 'SIGTERM');
      // anything that ignores the polite stop is killed after 2 seconds
      setTimeout(() => { try { process.kill(-rec.child.pid, 'SIGKILL'); } catch {} }, 2000);
    }
  } catch { try { rec.child.kill(); } catch {} }
  return true;
}

module.exports = {
  scanSource, parseTrx, escapeFilter, parseDuration,
  register({ ipcMain, send }) {
    ipcMain.handle('tests:scan', async (_e, projects) => {
      const out = {};
      for (const p of projects) out[p] = await scanProject(p);
      return out;
    });
    ipcMain.handle('tests:scanText', (_e, text, file) => scanSource(text, file));
    ipcMain.handle('tests:run', (e, opts) => run({ ...opts, owner: e.sender.id }, send));
    ipcMain.handle('tests:cancel', (_e, id) => cancel(id));
  },
  windowClosed(owner) { for (const [id, r] of [...runs]) if (r.owner === owner) cancel(id); },
  dispose() { for (const id of [...runs.keys()]) cancel(id); }
};
