// Nova IDE - .NET tools: the ILSpy decompiler (ilspycmd) for assemblies without source, and the EF Core tools
// (dotnet ef) for migrations. Both are dotnet global tools; Nova can install them.
'use strict';

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const settings = () => require('./settings').read();
// "dotnet ef" -> ['dotnet', ['ef']]; a path with spaces stays one word when quoted
function splitCommand(cmd) {
  const parts = String(cmd).match(/"[^"]+"|\S+/g) || [];
  return [parts[0].replace(/"/g, ''), parts.slice(1).map((p) => p.replace(/"/g, ''))];
}
function run(cmd, args, opts = {}) {
  const [file, pre] = splitCommand(cmd);
  return new Promise((resolve) => {
    execFile(file, [...pre, ...args], { cwd: opts.cwd, timeout: opts.timeout || 180000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', PATH: `${process.env.PATH}${path.delimiter}${path.join(os.homedir(), '.dotnet', 'tools')}` } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: !!(err && err.code === 'ENOENT'), stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// ---- decompiler ----
async function listTypes(dll) {
  const s = await settings();
  const r = await run(s.ilspyPath || 'ilspycmd', [dll, '-l', 'cisde']);
  if (r.missing) return { error: 'ilspycmd was not found', missing: true };
  if (!r.ok) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') };
  // lines like "Class Foo.Bar" / "Interface Foo.IBar"
  const types = r.stdout.split(/\r?\n/).map((l) => l.trim().match(/^(Class|Interface|Struct|Delegate|Enum)\s+(\S+)/)).filter(Boolean).map((m) => ({ kind: m[1], name: m[2] }));
  return { types };
}
async function decompile(dll, type) {
  const s = await settings();
  const r = await run(s.ilspyPath || 'ilspycmd', type ? [dll, '-t', type] : [dll]);
  if (r.missing) return { error: 'ilspycmd was not found', missing: true };
  if (!r.ok) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') };
  const out = path.join(os.tmpdir(), 'nova-decompiled', path.basename(dll, path.extname(dll)));
  await fsp.mkdir(out, { recursive: true });
  const file = path.join(out, `${(type || path.basename(dll, path.extname(dll))).replace(/[<>:"/\\|?*`]/g, '_')}.cs`);
  await fsp.writeFile(file, `// Decompiled with ILSpy from ${dll}\n// (read-only: not your source)\n${r.stdout}`);
  return { file };
}

// ---- EF Core ----
// dotnet ef ... --json prints log lines first, then the JSON
function efJson(stdout) {
  const i = stdout.search(/^\s*[[{]/m);
  if (i < 0) return null;
  try { return JSON.parse(stdout.slice(i)); } catch { return null; }
}
async function efRun(project, args, startup) {
  const s = await settings();
  const r = await run(s.efCommand || 'dotnet ef', [...args, '--project', project, ...(startup ? ['--startup-project', startup] : []), '--prefix-output'], { cwd: path.dirname(project), timeout: 600000 });
  if (r.missing) return { error: 'The EF Core tools were not found', missing: true };
  const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => l.trim());
  const text = lines.map((l) => l.replace(/^(info|data|warn|error|verbose):\s{0,4}/, '')).join('\n');
  return { ok: r.ok, code: r.code, output: text, data: lines.filter((l) => /^data:/.test(l)).map((l) => l.replace(/^data:\s{0,4}/, '')).join('\n'), errors: lines.filter((l) => /^error:/.test(l)).map((l) => l.replace(/^error:\s*/, '')) };
}
async function efMigrations(project, startup) {
  const r = await efRun(project, ['migrations', 'list', '--json'], startup);
  if (r.error) return r;
  const j = efJson(r.data || '') || efJson(r.output);
  if (!r.ok || !Array.isArray(j)) return { error: r.errors.join('\n') || r.output.split('\n').slice(-5).join('\n') || 'dotnet ef migrations list failed', output: r.output };
  return { migrations: j.map((m) => ({ id: m.id, name: m.name, safeName: m.safeName, applied: m.applied })) };
}

module.exports = {
  splitCommand, efJson,
  register({ ipcMain }) {
    ipcMain.handle('ilspy:types', (_e, dll) => listTypes(dll));
    ipcMain.handle('ilspy:decompile', (_e, dll, type) => decompile(dll, type));
    ipcMain.handle('ef:migrations', (_e, project, startup) => efMigrations(project, startup));
    ipcMain.handle('ef:run', (_e, project, args, startup) => efRun(project, args, startup));
  }
};
