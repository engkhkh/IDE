// Nova IDE - JSON-RPC 2.0 connection to a language server over stdio (LSP base protocol)
'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HEADER_END = Buffer.from('\r\n\r\n');

class LspConnection extends EventEmitter {
  /**
   * @param {{command:string,args:string[],env?:object,cwd?:string,shell?:boolean}} spec
   */
  constructor(spec) {
    super();
    this.spec = spec;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.stderrTail = '';
  }

  start() {
    const { command, args = [], env, cwd, shell } = this.spec;
    this.proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: !!shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (d) => {
      const text = d.toString();
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      this.emit('stderr', text);
    });
    this.proc.on('error', (err) => this._close(err));
    this.proc.on('exit', (code, signal) => this._close(null, code, signal));
    this.proc.stdin.on('error', () => {}); // EPIPE when the server dies
  }

  _close(err, code, signal) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error(err ? err.message : `server exited (${code ?? signal})`));
    this.pending.clear();
    this.emit('close', { error: err ? err.message : null, code, signal, stderr: this.stderrTail });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buffer = this.buffer.slice(headerEnd + 4); continue; } // skip garbage
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return; // wait for the rest (lengths are in BYTES)
      const body = this.buffer.slice(start, start + len).toString('utf8');
      this.buffer = this.buffer.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch (e) { this.emit('stderr', `bad JSON from server: ${e.message}\n`); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      // response to one of our requests
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; e.data = msg.error.data; p.reject(e); }
      else p.resolve(msg.result === undefined ? null : msg.result);
    } else if (msg.id !== undefined) {
      this.emit('request', msg); // server -> client request; must be answered with respond()
    } else {
      this.emit('notification', msg);
    }
  }

  _send(obj) {
    if (this.closed || !this.proc || !this.proc.stdin.writable) return false;
    const json = JSON.stringify({ jsonrpc: '2.0', ...obj });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    return true;
  }

  request(method, params, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('server is not running'));
      const id = this.nextId++;
      let timer = null;
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      if (timeoutMs) timer = setTimeout(() => { if (this.pending.delete(id)) { this.notify('$/cancelRequest', { id }); reject(new Error(`${method} timed out`)); } }, timeoutMs);
      this._send({ id, method, params });
    });
  }

  cancel(method) { // cancel all pending requests of a method (e.g. superseded completion requests)
    for (const [id, p] of this.pending) if (p.method === method) { this.pending.delete(id); this.notify('$/cancelRequest', { id }); p.reject(new Error('cancelled')); }
  }

  notify(method, params) { return this._send({ method, params }); }

  respond(id, result, error) { return this._send(error ? { id, error } : { id, result: result === undefined ? null : result }); }

  kill() {
    if (!this.proc || this.closed) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.proc.kill('SIGTERM');
    } catch {}
  }
}

module.exports = { LspConnection };
