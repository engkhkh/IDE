// Nova IDE - Containers window (like Visual Studio's Containers window / Rider's Services > Docker): containers,
// images and Compose through the docker CLI (Docker Desktop, Podman with the docker alias, or a remote DOCKER_HOST).
'use strict';

const { execFile } = require('child_process');

let readSettings = async () => ({});
const dockerPath = async () => (await readSettings()).dockerPath || 'docker';

function docker(args, opts = {}) {
  return new Promise(async (resolve) => {
    execFile(await dockerPath(), args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') resolve({ error: 'Docker was not found. Install Docker Desktop (or set Options > Containers > docker path).', missing: true });
      else if (err) resolve({ error: String(stderr || err.message).trim().split('\n').slice(-3).join('\n'), stdout: String(stdout) });
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
// `docker ... --format '{{json .}}'` prints one JSON object per line
const jsonLines = (text) => String(text || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> [{ host: 8080, container: 80 }]
function parsePorts(ports) {
  const out = [];
  for (const m of String(ports || '').matchAll(/(?:[\d.]+|\[?::\]?):(\d+)->(\d+)\/(tcp|udp)/g)) if (!out.some((p) => p.host === +m[1])) out.push({ host: +m[1], container: +m[2], proto: m[3] });
  return out;
}

async function list() {
  const ps = await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  if (ps.error) return ps;
  const im = await docker(['images', '--format', '{{json .}}']);
  return {
    containers: jsonLines(ps.stdout).map((c) => ({
      id: c.ID, name: c.Names, image: c.Image, state: c.State || (/^Up/.test(c.Status) ? 'running' : 'exited'), status: c.Status, ports: parsePorts(c.Ports),
      compose: (String(c.Labels || '').match(/com\.docker\.compose\.project=([^,]+)/) || [])[1] || null, created: c.CreatedAt
    })),
    images: im.error ? [] : jsonLines(im.stdout).map((i) => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince || i.CreatedAt }))
  };
}

module.exports = {
  parsePorts, jsonLines,
  register({ ipcMain }) {
    readSettings = () => require('./settings').read();
    ipcMain.handle('docker:list', () => list());
    ipcMain.handle('docker:action', async (_e, action, id) => {
      const map = { start: ['start', id], stop: ['stop', id], restart: ['restart', id], remove: ['rm', '-f', id], removeImage: ['rmi', id] };
      if (!map[action]) return { error: `Unknown action ${action}` };
      return docker(map[action], { timeout: 120000 });
    });
    ipcMain.handle('docker:logs', (_e, id) => docker(['logs', '--tail', '500', '--timestamps', id]));
    ipcMain.handle('docker:inspect', async (_e, id) => {
      const r = await docker(['inspect', id]);
      if (r.error) return r;
      try { return { data: JSON.parse(r.stdout)[0] }; } catch { return { error: 'docker inspect returned no JSON' }; }
    });
    ipcMain.handle('docker:path', () => dockerPath());
  }
};
