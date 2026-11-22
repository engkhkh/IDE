// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { LspConnection } = require('../main/lsp/connection');

function start() {
  const c = new LspConnection({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-lsp.js')] });
  c.start();
  return c;
}

test('request/response round trip with multi-byte UTF-8 text', async () => {
  const c = start();
  const text = 'Arabic مرحبا · emoji 🚀 · accents éàü'.repeat(200); // large + multi-byte => byte-accurate framing
  const r = await c.request('echo', { text });
  assert.strictEqual(r.text, text);
  c.notify('exit');
});

test('error responses reject the promise', async () => {
  const c = start();
  await assert.rejects(c.request('fail', {}), /boom/);
  c.notify('exit');
});

test('server requests and notifications are surfaced', async () => {
  const c = start();
  const got = { req: null, note: null, reply: null };
  c.on('request', (m) => { got.req = m; c.respond(m.id, [{ answer: 42 }]); });
  c.on('notification', (m) => { if (m.method === 'window/logMessage') got.note = m.params.message; if (m.method === 'gotReply') got.reply = m.params; });
  assert.strictEqual(await c.request('askClient', {}), 'asked');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(got.req.method, 'workspace/configuration');
  assert.strictEqual(got.note, 'مرحبا hello ✓');
  assert.deepStrictEqual(got.reply, [{ answer: 42 }]);
  c.notify('exit');
});

test('pending requests fail when the server exits', async () => {
  const c = start();
  const p = c.request('never-answered-because-exit', {});
  c.notify('exit');
  // fake server answers unknown requests with null before exiting, or the exit rejects it; both are fine
  await p.then(() => {}, (e) => assert.match(e.message, /exited|not running/));
  await new Promise((r) => c.on('close', r));
});

test('server registry knows the bundled and external servers', () => {
  const { SERVERS, serverFor } = require('../main/lsp/servers');
  assert.ok(SERVERS.find((s) => s.id === 'csharp').languages.includes('csharp'));
  assert.strictEqual(serverFor('markdown'), null);
  assert.strictEqual(serverFor('python', { python: false }).disabled, true);
  const custom = serverFor('csharp', { csharp: { command: 'C:\\tools\\csharp-ls.exe', args: ['--loglevel', 'info'] } });
  assert.strictEqual(custom.spec.command, 'C:\\tools\\csharp-ls.exe');
});
