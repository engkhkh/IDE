// Minimal fake language server for tests: echoes requests, sends a server->client request, and a notification
let buf = Buffer.alloc(0);
const send = (o) => { const j = JSON.stringify({ jsonrpc: '2.0', ...o }); process.stdout.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`); };
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) return;
    const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1];
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString('utf8'));
    buf = buf.slice(h + 4 + len);
    if (msg.method === 'echo') send({ id: msg.id, result: msg.params });
    else if (msg.method === 'fail') send({ id: msg.id, error: { code: -32603, message: 'boom' } });
    else if (msg.method === 'askClient') { send({ id: 'srv-1', method: 'workspace/configuration', params: { items: [{ section: 'x' }] } }); send({ method: 'window/logMessage', params: { type: 3, message: 'مرحبا hello ✓' } }); send({ id: msg.id, result: 'asked' }); }
    else if (msg.method === 'exit') process.exit(0);
    else if (msg.id !== undefined && msg.method) send({ id: msg.id, result: null });
    else if (msg.id === 'srv-1') send({ method: 'gotReply', params: msg.result });
  }
});
