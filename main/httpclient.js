// Nova IDE - sends the requests of .http / .rest files (like Visual Studio's HTTP file editor).
// The request is sent from the main process, so there is no CORS, and the ASP.NET Core development
// certificate (self-signed, localhost) is accepted for local addresses only.
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;
const inflight = new Map();

function send(id, req) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(req.url); } catch { resolve({ error: `Not a valid URL: ${req.url}` }); return; }
    if (!/^https?:$/.test(url.protocol)) { resolve({ error: `Only http and https requests can be sent (got ${url.protocol})` }); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {};
    for (const [k, v] of req.headers || []) headers[k] = v;
    const body = req.body == null || req.body === '' ? null : Buffer.from(req.body, 'utf8');
    if (body && !Object.keys(headers).some((k) => /^content-length$/i.test(k))) headers['Content-Length'] = body.length;
    const started = process.hrtime.bigint();
    const r = lib.request(url, {
      method: req.method || 'GET', headers,
      rejectUnauthorized: !(url.protocol === 'https:' && LOCAL.test(url.hostname)),
      timeout: req.timeout || 100000
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        inflight.delete(id);
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch {}
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const binary = /^(image|audio|video)\/|octet-stream|application\/(pdf|zip)/i.test(res.headers['content-type'] || '');
        resolve({
          status: res.statusCode, statusText: res.statusMessage || '', httpVersion: res.httpVersion,
          headers: Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
          body: binary ? `(${buf.length} bytes of ${res.headers['content-type']})` : buf.toString('utf8'),
          size: buf.length, ms: Math.round(ms * 10) / 10
        });
      });
    });
    inflight.set(id, r);
    r.on('timeout', () => r.destroy(new Error('The request timed out')));
    r.on('error', (e) => { inflight.delete(id); resolve({ error: e.code === 'ECONNREFUSED' ? `Could not connect to ${url.host} (is the app running?)` : e.message }); });
    if (body) r.write(body);
    r.end();
  });
}

module.exports = {
  send,
  register({ ipcMain }) {
    ipcMain.handle('http:send', (_e, id, req) => send(id, req));
    ipcMain.handle('http:processEnv', () => ({ ...process.env }));
    ipcMain.handle('http:cancel', (_e, id) => { const r = inflight.get(id); if (r) { r.destroy(new Error('Canceled')); inflight.delete(id); } return !!r; });
  },
  dispose() { for (const r of inflight.values()) { try { r.destroy(); } catch {} } inflight.clear(); }
};
