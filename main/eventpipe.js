// Nova IDE - .NET EventPipe client (no dotnet-trace needed)
// The IDE listens on a diagnostic port; the program is started with DOTNET_DiagnosticPorts=<port>,suspend,
// so its runtime connects to us before Main runs. We start a trace session (CPU samples, JIT method names,
// sampled allocations), resume the runtime, and read the "nettrace" stream until the program ends.
'use strict';
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const pdbLib = require('./pdb');

// ---------------- diagnostics IPC ----------------
const IPC_MAGIC = Buffer.from('DOTNET_IPC_V1\0', 'latin1'); // 14 bytes
const ADVR_MAGIC = Buffer.from('ADVR_V1\0', 'latin1'); // 8 bytes
const ADVR_SIZE = 8 + 16 + 8 + 2;

function ipcMessage(commandSet, commandId, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(20);
  IPC_MAGIC.copy(h, 0);
  h.writeUInt16LE(20 + payload.length, 14);
  h.writeUInt8(commandSet, 16);
  h.writeUInt8(commandId, 17);
  h.writeUInt16LE(0, 18);
  return Buffer.concat([h, payload]);
}
function ipcString(s) {
  if (!s) return Buffer.from([0, 0, 0, 0]);
  const chars = Buffer.from(`${s}\0`, 'utf16le');
  const n = Buffer.alloc(4);
  n.writeUInt32LE(chars.length / 2);
  return Buffer.concat([n, chars]);
}
// EventPipe CollectTracing2: circular buffer MB, format 1 = nettrace, rundown, providers
function collectTracing2(providers, { bufferMB = 256, rundown = true } = {}) {
  const parts = [];
  const head = Buffer.alloc(9);
  head.writeUInt32LE(bufferMB, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt8(rundown ? 1 : 0, 8);
  parts.push(head);
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32LE(providers.length);
  parts.push(cnt);
  for (const p of providers) {
    const b = Buffer.alloc(12);
    b.writeBigUInt64LE(BigInt(p.keywords), 0);
    b.writeUInt32LE(p.level, 8);
    parts.push(b, ipcString(p.name), ipcString(p.filter || ''));
  }
  return ipcMessage(0x02, 0x03, Buffer.concat(parts));
}
const stopTracing = (sessionId) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(sessionId); return ipcMessage(0x02, 0x01, b); };
const resumeRuntime = () => ipcMessage(0x04, 0x01);

const KW = { GC: 0x1n, LOADER: 0x8n, JIT: 0x10n, NGEN: 0x20n, IL_MAP: 0x20000n, TYPE: 0x80000n, HEAP_DUMP: 0x100000n, HEAP_COLLECT: 0x800000n, HEAP_TYPE_NAMES: 0x1000000n };
// a GC heap dump (what dotnet-gcdump asks for): an induced full GC that reports every live object and type
const HEAP_SNAPSHOT_PROVIDERS = [{ name: 'Microsoft-Windows-DotNETRuntime', keywords: KW.GC | KW.HEAP_COLLECT | KW.HEAP_DUMP | KW.HEAP_TYPE_NAMES | KW.TYPE, level: 5 }];
function providersFor({ cpu = true, alloc = false } = {}) {
  const list = [];
  if (cpu) list.push({ name: 'Microsoft-DotNETCore-SampleProfiler', keywords: 0xF00000000000n, level: 4 });
  // method names for the sampled addresses (JIT'd and ReadyToRun methods); allocation ticks (~every 100 KB)
  let kw = KW.LOADER | KW.JIT | KW.NGEN | KW.IL_MAP;
  if (alloc) kw |= KW.GC;
  list.push({ name: 'Microsoft-Windows-DotNETRuntime', keywords: kw, level: 5 });
  return list;
}

// Reads exactly n bytes from a socket (buffering)
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = null;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
  function pump() { if (want && buf.length >= want.n) { const out = buf.subarray(0, want.n); buf = buf.subarray(want.n); const w = want; want = null; w.resolve(out); } }
  sock.on('close', () => { if (want) { const w = want; want = null; w.reject(new Error('connection closed')); } });
  return {
    read: (n) => new Promise((resolve, reject) => { want = { n, resolve, reject }; pump(); }),
    rest: () => { const b = buf; buf = Buffer.alloc(0); return b; }
  };
}
async function readResponse(r) {
  const h = await r.read(20);
  if (!h.subarray(0, 14).equals(IPC_MAGIC)) throw new Error('bad diagnostics response');
  const size = h.readUInt16LE(14);
  const commandId = h.readUInt8(17);
  const payload = size > 20 ? await r.read(size - 20) : Buffer.alloc(0);
  if (commandId === 0xFF) throw new Error(`runtime refused the request (0x${payload.length >= 4 ? payload.readUInt32LE(0).toString(16) : '?'})`);
  return payload;
}

// A trace of one program run. start() gives the env to launch it with; result() resolves with the parsed trace.
class DotnetTrace {
  constructor(opts = {}) {
    this.opts = { cpu: true, alloc: false, ...opts };
    this.chunks = [];
    this.spare = null;
    this.waiters = [];
    this.sessionId = null;
    this.phase = 'wait'; // wait -> tracing -> resumed -> done
    this.error = null;
    this.pid = null;
    this.done = new Promise((resolve) => { this._done = resolve; });
  }
  async start() {
    const name = `nova-diag-${process.pid}-${Date.now()}`;
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
    this.server = net.createServer((sock) => this._conn(sock).catch((e) => { this.error = e.message; sock.destroy(); }));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.address, resolve); });
    // the runtime takes the pipe name on Windows and the socket path elsewhere
    return { DOTNET_DiagnosticPorts: `${process.platform === 'win32' ? name : this.address},suspend` };
  }
  async _conn(sock) {
    const r = reader(sock);
    const adv = await r.read(ADVR_SIZE);
    if (!adv.subarray(0, 8).equals(ADVR_MAGIC)) throw new Error('not a .NET runtime');
    this.pid = Number(adv.readBigUInt64LE(24));
    if (this.phase === 'wait') {
      this.phase = 'tracing';
      sock.write(collectTracing2(providersFor(this.opts)));
      const p = await readResponse(r);
      this.sessionId = p.readBigUInt64LE(0);
      const first = r.rest();
      if (first.length) this.chunks.push(first);
      sock.removeAllListeners('data');
      sock.on('data', (d) => this.chunks.push(d));
      sock.on('close', () => this._finish());
      sock.on('error', () => {});
    } else if (this.phase === 'tracing') {
      this.phase = 'resumed';
      sock.write(resumeRuntime());
      await readResponse(r).catch(() => {});
      sock.destroy();
    } else {
      // the runtime keeps one connection waiting for a command: hand it to whoever waits, else keep the newest
      sock.on('error', () => {});
      const w = this.waiters.shift();
      if (w) { w({ sock, r }); return; }
      if (this.spare) this.spare.sock.destroy();
      this.spare = { sock, r };
    }
  }
  // the next connection the runtime makes (for a command: stop, heap snapshot)
  nextConn(ms = 5000) {
    if (this.spare) { const c = this.spare; this.spare = null; return Promise.resolve(c); }
    if (this.phase === 'done' || !this.server) return Promise.reject(new Error('The program has ended.'));
    return new Promise((resolve, reject) => {
      const w = (c) => { clearTimeout(timer); resolve(c); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('The program did not answer.')); }, ms);
      this.waiters.push(w);
    });
  }
  // Ask the runtime to end the session (it then writes method names and closes the stream)
  async stop() {
    if (this.phase === 'done' || this.sessionId == null) return;
    let c;
    try { c = await this.nextConn(2000); } catch { return; }
    try { c.sock.write(stopTracing(this.sessionId)); await readResponse(c.r); } catch { /* the program may be gone already */ }
    c.sock.destroy();
  }
  _finish() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this._done();
  }
  // Wait for the stream to end (program exit), at most `ms` after it is called
  async result(ms = 15000) {
    await Promise.race([this.done, new Promise((r) => setTimeout(r, ms))]);
    this.close();
    if (!this.chunks.length) return { error: this.error || 'The program ended before the trace started (did it run with this runtime?)' };
    try { return parseNettrace(Buffer.concat(this.chunks)); } catch (e) { return { error: `Could not read the trace: ${e.message}` }; }
  }
  close() {
    if (this.spare) { this.spare.sock.destroy(); this.spare = null; }
    if (this.server) { this.server.close(); this.server = null; }
    if (process.platform !== 'win32' && this.address) fs.rm(this.address, { force: true }, () => {});
  }
}

// ---------------- heap snapshot ----------------
// The address a running .NET process listens on (every .NET process does, unless diagnostics are disabled)
async function listenAddress(pid) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\dotnet-diagnostic-${pid}`;
  const dir = process.env.TMPDIR || os.tmpdir();
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { /* */ }
  const hit = names.filter((n) => n.startsWith(`dotnet-diagnostic-${pid}-`) && n.endsWith('-socket')).sort().pop();
  return hit ? path.join(dir, hit) : null;
}
function connectTo(address, ms = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(address);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, ms);
    sock.once('connect', () => { clearTimeout(timer); sock.on('error', () => {}); resolve({ sock, r: reader(sock) }); });
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
// Which of these processes is a .NET runtime we can talk to (the newest one)
async function findDotnet(pids) {
  for (const pid of [...pids].sort((a, b) => b - a)) {
    const addr = await listenAddress(pid);
    if (!addr) continue;
    try { const c = await connectTo(addr, 1500); c.sock.destroy(); return { pid, address: addr }; } catch { /* not .NET */ }
  }
  return null;
}

// GC heap dump over a diagnostics connection: openConn() gives a fresh connection each time
// typeNames: names seen in earlier snapshots of the same process (the runtime names each type only once)
async function heapSnapshot(openConn, { timeoutMs = 60000, typeNames = new Map(), graph = false } = {}) {
  const started = Date.now();
  const c1 = await openConn();
  c1.sock.write(collectTracing2(HEAP_SNAPSHOT_PROVIDERS, { bufferMB: 256, rundown: false }));
  const resp = await readResponse(c1.r);
  const sessionId = resp.readBigUInt64LE(0);
  const chunks = [];
  const first = c1.r.rest();
  if (first.length) chunks.push(first);
  c1.sock.removeAllListeners('data');
  c1.sock.on('data', (d) => chunks.push(d));
  const closed = new Promise((r) => c1.sock.on('close', r));
  let isClosed = false;
  closed.then(() => { isClosed = true; });
  // wait for the end of the GC that reported the objects
  const done = (t) => t && t.heap.bulkNodes > 0 && t.heap.gcs.some((g) => g.kind === 'end' && g.afterNodes > 0);
  let parsed = null;
  while (Date.now() - started < timeoutMs && !isClosed) {
    await new Promise((r) => setTimeout(r, 300));
    try { parsed = parseNettrace(Buffer.concat(chunks)); } catch { parsed = null; }
    if (done(parsed)) break;
  }
  if (!isClosed) {
    try { const c2 = await openConn(); c2.sock.write(stopTracing(sessionId)); await readResponse(c2.r).catch(() => {}); c2.sock.destroy(); } catch { /* */ }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    c1.sock.destroy();
  }
  try { parsed = parseNettrace(Buffer.concat(chunks), { graph }); } catch (e) { if (!parsed) return { error: `Could not read the heap snapshot: ${e.message}` }; }
  if (!parsed || !parsed.heap.bulkNodes) return { error: Date.now() - started >= timeoutMs ? 'The heap snapshot timed out.' : 'The program sent no heap data.' };
  const types = [];
  let objects = 0, bytes = 0;
  for (const [id, name] of parsed.heap.types) typeNames.set(id, name);
  for (const [id, n] of parsed.heap.nodes) {
    types.push({ name: typeNames.get(id) || `[type ${id}]`, count: n.count, bytes: n.bytes });
    objects += n.count; bytes += n.bytes;
  }
  // merge generic instantiations reported more than once under the same name
  const byName = new Map();
  for (const t of types) { const e = byName.get(t.name); if (e) { e.count += t.count; e.bytes += t.bytes; } else byName.set(t.name, { ...t }); }
  const result = { objects, bytes, types: [...byName.values()].sort((a, b) => b.bytes - a.bytes), ms: Date.now() - started };
  if (graph && parsed.heap.graph) result.graph = { ...parsed.heap.graph, typeNames };
  return result;
}

// ---------------- nettrace parser ----------------
// Format: "Nettrace" + FastSerialization objects (Trace, MetadataBlock, StackBlock, EventBlock, SPBlock).
const TAG = { Null: 1, Begin: 5, End: 6 };
// opts.graph: keep every object, reference and root of a heap dump (for retained sizes and paths to root)
function parseNettrace(buf, opts = {}) {
  return parseNettraceInto(buf, opts);
}
function parseNettraceInto(buf, opts = {}) {
  let p = 0;
  const u8 = () => buf[p++];
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  if (buf.toString('latin1', 0, 8) !== 'Nettrace') throw new Error('not a nettrace stream');
  p = 8;
  const sl = i32();
  const sig = buf.toString('latin1', p, p + sl); p += sl;
  if (sig !== '!FastSerialization.1') throw new Error(`unknown serialization ${sig}`);
  const out = { pointerSize: 8, qpcFreq: 1, cpus: 1, pid: 0, metadata: new Map(), samples: [], methods: [], allocs: [], modules: new Map(), ilMaps: new Map(), events: 0, version: 0, firstTs: null, lastTs: null,
    heap: { types: new Map(), nodes: new Map(), gcs: [], bulkNodes: 0, graph: null } };
  if (opts.graph) out.heap.graph = { addr: [], size: [], type: [], edgeCount: [], edges: [], roots: [], statics: [] };
  const stacks = new Map();
  for (;;) {
    if (p >= buf.length) break; // truncated: use what we have
    const tag = u8();
    if (tag === TAG.Null) break;
    if (tag !== TAG.Begin) throw new Error(`bad object tag ${tag} at ${p - 1}`);
    // type descriptor
    if (u8() !== TAG.Begin || u8() !== TAG.Null) throw new Error('bad type header');
    const version = i32(); i32();
    const nl = i32();
    const name = buf.toString('latin1', p, p + nl); p += nl;
    if (u8() !== TAG.End) throw new Error('bad type end');
    if (name === 'Trace') {
      p += 16; // SYSTEMTIME
      out.syncQpc = buf.readBigInt64LE(p); p += 8;
      out.qpcFreq = Number(buf.readBigInt64LE(p)); p += 8;
      out.pointerSize = i32(); out.pid = i32(); out.cpus = i32(); i32();
      out.version = version;
    } else {
      const size = i32();
      while (p % 4) p++;
      if (p + size > buf.length) break; // truncated block
      const block = buf.subarray(p, p + size);
      if (name === 'EventBlock' || name === 'MetadataBlock') parseEventBlock(block, name === 'MetadataBlock', out, stacks);
      else if (name === 'StackBlock') parseStackBlock(block, out, stacks);
      p += size;
    }
    if (u8() !== TAG.End) throw new Error(`bad end of ${name}`);
  }
  out.metadata = undefined;
  return out;
}

function parseStackBlock(b, out, stacks) {
  let p = 0;
  const first = b.readUInt32LE(p); p += 4;
  const count = b.readUInt32LE(p); p += 4;
  const ps = out.pointerSize;
  for (let i = 0; i < count; i++) {
    const size = b.readUInt32LE(p); p += 4;
    const ips = [];
    for (let q = p; q + ps <= p + size; q += ps) ips.push(ps === 8 ? Number(b.readBigUInt64LE(q)) : b.readUInt32LE(q));
    stacks.set(first + i, ips);
    p += size;
  }
}

function parseEventBlock(b, isMeta, out, stacks) {
  let p = 0;
  const headerSize = b.readUInt16LE(0);
  const flags = b.readUInt16LE(2);
  p = headerSize;
  const compressed = flags & 1;
  const h = { metaId: 0, seq: 0, threadId: 0, captureThreadId: 0, proc: 0, stackId: 0, ts: 0, size: 0 };
  const varu = () => { let v = 0, shift = 0, byte; do { byte = b[p++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return v; };
  while (p < b.length) {
    let payloadStart, payloadSize;
    if (compressed) {
      const f = b[p++];
      if (f & 1) h.metaId = varu();
      if (f & 2) { h.seq += varu() + 1; h.captureThreadId = varu(); h.proc = varu(); } else if (h.metaId !== 0) h.seq++;
      if (f & 4) h.threadId = varu();
      if (f & 8) h.stackId = varu();
      h.ts += varu();
      if (f & 16) p += 16;
      if (f & 32) p += 16;
      if (f & 128) h.size = varu();
      payloadStart = p; payloadSize = h.size;
      p += payloadSize;
    } else {
      const evSize = b.readInt32LE(p);
      const start = p + 4;
      h.metaId = b.readInt32LE(start) & 0x7fffffff;
      h.threadId = Number(b.readBigInt64LE(start + 8));
      h.stackId = b.readInt32LE(start + 28);
      h.ts = Number(b.readBigInt64LE(start + 32));
      payloadSize = b.readInt32LE(start + 72);
      payloadStart = start + 76;
      p = start + evSize;
      while (p % 4) p++;
    }
    const payload = b.subarray(payloadStart, payloadStart + payloadSize);
    if (isMeta) readMetadata(payload, out);
    else onEvent(h, payload, out, stacks);
  }
}

function utf16z(b, p) {
  let e = p;
  while (e + 1 < b.length && (b[e] || b[e + 1])) e += 2;
  return [b.toString('utf16le', p, e), e + 2];
}
function readMetadata(pl, out) {
  let p = 0;
  const id = pl.readInt32LE(p); p += 4;
  const [provider, p2] = utf16z(pl, p); p = p2;
  const eventId = pl.readInt32LE(p); p += 4;
  const [eventName, p3] = utf16z(pl, p); p = p3;
  p += 8; // keywords
  const version = pl.readInt32LE(p);
  out.metadata.set(id, { provider, eventId, eventName, version });
}

function onEvent(h, pl, out, stacks) {
  const m = out.metadata.get(h.metaId);
  if (!m) return;
  out.events++;
  if (out.firstTs == null) out.firstTs = h.ts;
  out.lastTs = h.ts;
  const ps = out.pointerSize;
  const ptr = (q) => (ps === 8 ? Number(pl.readBigUInt64LE(q)) : pl.readUInt32LE(q));
  if (m.provider === 'Microsoft-DotNETCore-SampleProfiler' && m.eventId === 0) {
    // ThreadSample: 2 = in managed code, 1 = outside (waiting or in native code), 0 = error
    const type = pl.length >= 4 ? pl.readUInt32LE(0) : 2;
    const st = stacks.get(h.stackId);
    if (st && st.length) out.samples.push({ t: h.ts, thread: h.threadId, managed: type === 2, ips: st });
  } else if ((m.provider === 'Microsoft-Windows-DotNETRuntime' && (m.eventId === 143 || m.eventId === 141)) ||
             (m.provider === 'Microsoft-Windows-DotNETRuntimeRundown' && (m.eventId === 144 || m.eventId === 143))) {
    // MethodLoadVerbose / MethodDCEnd(Start)Verbose
    const methodId = pl.readBigUInt64LE(0).toString();
    const moduleId = pl.readBigUInt64LE(8).toString();
    let p = 16;
    const start = Number(pl.readBigUInt64LE(p)); p += 8;
    const size = pl.readUInt32LE(p); p += 4;
    const token = pl.readUInt32LE(p); p += 8; // token, flags
    const [ns, a] = utf16z(pl, p);
    const [name, c] = utf16z(pl, a);
    const [sig] = utf16z(pl, c);
    const m = { start, size, ns, name, sig, methodId, moduleId, token, map: null };
    // an IL-to-native map that came before its method load
    const pend = out.ilMaps.get(methodId);
    if (pend && pend.length) m.map = pend.shift();
    out.methods.push(m);
  } else if ((m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 190) || (m.provider === 'Microsoft-Windows-DotNETRuntimeRundown' && m.eventId === 149)) {
    // MethodILToNativeMap: pairs of (IL offset, native offset) for the code of a method
    const methodId = pl.readBigUInt64LE(0).toString();
    const n = pl.readUInt16LE(17);
    const il = [], nat = [];
    for (let i = 0; i < n; i++) { il.push(pl.readInt32LE(19 + i * 4)); nat.push(pl.readUInt32LE(19 + n * 4 + i * 4)); }
    const map = { il, nat };
    // the newest code of this method that has no map yet
    for (let i = out.methods.length - 1; i >= 0; i--) { const x = out.methods[i]; if (x.methodId === methodId) { if (!x.map) { x.map = map; return; } break; } }
    if (!out.ilMaps.has(methodId)) out.ilMaps.set(methodId, []);
    out.ilMaps.get(methodId).push(map);
  } else if ((m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 152) || (m.provider === 'Microsoft-Windows-DotNETRuntimeRundown' && (m.eventId === 154 || m.eventId === 153))) {
    // ModuleLoad / ModuleDCEnd: where the module (and its PDB) is
    const moduleId = pl.readBigUInt64LE(0).toString();
    const [ilPath, q1] = utf16z(pl, 24);
    const [, q2] = utf16z(pl, q1);
    let pdbPath = '';
    if (q2 + 2 + 20 <= pl.length) [pdbPath] = utf16z(pl, q2 + 2 + 16 + 4);
    out.modules.set(moduleId, { ilPath, pdbPath });
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 15) {
    // GCBulkType: names of the types in a heap dump
    const n = pl.readUInt32LE(0);
    let p = 6;
    for (let i = 0; i < n && p < pl.length; i++) {
      const id = pl.readBigUInt64LE(p).toString(); p += 8 + 8 + 4 + 4 + 1;
      const [name, q] = utf16z(pl, p); p = q;
      const tp = pl.readUInt32LE(p); p += 4 + tp * 8;
      out.heap.types.set(id, name);
    }
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 18) {
    // GCBulkNode: live objects (address, size, type, edge count)
    const n = pl.readUInt32LE(4);
    const nodes = out.heap.nodes;
    const g = out.heap.graph;
    for (let i = 0, p = 10; i < n && p + 32 <= pl.length; i++, p += 32) {
      const size = Number(pl.readBigUInt64LE(p + 8));
      const type = pl.readBigUInt64LE(p + 16).toString();
      const e = nodes.get(type);
      if (e) { e.count++; e.bytes += size; } else nodes.set(type, { count: 1, bytes: size });
      if (g) { g.addr.push(Number(pl.readBigUInt64LE(p))); g.size.push(size); g.type.push(type); g.edgeCount.push(Number(pl.readBigUInt64LE(p + 24))); }
    }
    out.heap.bulkNodes += n;
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 19) {
    // GCBulkEdge: the references of the objects above, in order (each node's EdgeCount of them)
    const g = out.heap.graph;
    if (!g) return;
    const n = pl.readUInt32LE(4);
    for (let i = 0, p = 10; i < n && p + 12 <= pl.length; i++, p += 12) g.edges.push(Number(pl.readBigUInt64LE(p)));
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 16) {
    // GCBulkRootEdge: address, kind (0 stack, 1 finalizer, 2 handle, 3 older generation, ...), flags (1 pinned, 2 weak, 4 interior, 8 ref counted)
    const g = out.heap.graph;
    if (!g) return;
    const n = pl.readUInt32LE(4);
    for (let i = 0, p = 10; i < n && p + 21 <= pl.length; i++, p += 21) g.roots.push({ addr: Number(pl.readBigUInt64LE(p)), kind: pl[p + 8], flags: pl.readUInt32LE(p + 9) });
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 38) {
    // GCBulkRootStaticVar: static fields (root id, object, declaring type, flags, field name)
    const g = out.heap.graph;
    if (!g) return;
    const n = pl.readUInt32LE(0);
    let p = 14;
    for (let i = 0; i < n && p + 28 <= pl.length; i++) {
      const obj = Number(pl.readBigUInt64LE(p + 8));
      const type = pl.readBigUInt64LE(p + 16).toString();
      const [name, q] = utf16z(pl, p + 28);
      p = q;
      g.statics.push({ addr: obj, type, name });
    }
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && (m.eventId === 1 || m.eventId === 2)) {
    // GCStart (count, depth, reason) / GCEnd (count, depth)
    out.heap.gcs.push({ kind: m.eventId === 1 ? 'start' : 'end', count: pl.readUInt32LE(0), depth: pl.readUInt32LE(4), reason: m.eventId === 1 ? pl.readUInt32LE(8) : null, afterNodes: out.heap.bulkNodes });
  } else if (m.provider === 'Microsoft-Windows-DotNETRuntime' && m.eventId === 10) {
    // GCAllocationTick_V2+: AllocationAmount, Kind, ClrInstanceID, AllocationAmount64, TypeID, TypeName...
    if (pl.length < 18 + ps) return;
    const amount = Number(pl.readBigUInt64LE(10));
    const [type, q] = utf16z(pl, 18 + ps);
    let objSize = 0;
    const sizeAt = q + 4 + ps;
    if (m.version >= 4 && pl.length >= sizeAt + 8) objSize = Number(pl.readBigUInt64LE(sizeAt));
    out.allocs.push({ t: h.ts, type, amount, objSize, ips: stacks.get(h.stackId) || [] });
  }
  void ptr;
}

// ---------------- symbolize ----------------
// Turns addresses into "Namespace.Type.Method" using the method load events
function symbolizer(methods) {
  const list = methods.filter((m) => m.size > 0).sort((a, b) => a.start - b.start);
  return (ip) => {
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = list[mid];
      if (ip < m.start) hi = mid - 1;
      else if (ip >= m.start + m.size) lo = mid + 1;
      else return m;
    }
    return null;
  };
}
// a readable method name: "Calc.Burn(int32)" from namespace "Calc", name "Burn", signature "float64  (int32)"
function methodLabel(m) {
  const ns = m.ns.replace(/`\d+/g, '').replace(/\[.*\]$/, '');
  const args = (m.sig.match(/\(([^)]*)\)/) || [, ''])[1].replace(/class |valuetype /g, '').split(',').map((s) => s.trim().split('.').pop()).filter(Boolean).join(', ');
  return `${ns}.${m.name}(${args})`;
}
const isFramework = (ns) => /^(System|Microsoft|Internal|Interop)\b/.test(ns);

// The PDB's first line of a method is its body ("{" or the expression): step back to the line that declares it
const fileLines = new Map();
function declarationLine(file, line, m) {
  let ls = fileLines.get(file);
  if (!ls) { try { ls = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { ls = []; } if (fileLines.size > 200) fileLines.clear(); fileLines.set(file, ls); }
  let name = m.name;
  if (name === '.ctor' || name === '.cctor') name = String(m.ns).split(/[.+]/).pop();
  const local = /^<[^>]*>g__([A-Za-z_]\w*)\|/.exec(name);
  if (local) name = local[1];
  if (!/^[A-Za-z_]\w*$/.test(name)) return line;
  const re = new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\s*\\(`);
  for (let l = line; l >= Math.max(1, line - 4); l--) if (re.test(ls[l - 1] || '')) return l;
  return line;
}

// Source lines: method -> module -> portable PDB -> sequence points; address -> native offset -> IL offset -> line
function sourceResolver(trace) {
  const pdbs = new Map();
  const pdbFor = (moduleId) => {
    if (pdbs.has(moduleId)) return pdbs.get(moduleId);
    const mod = trace.modules.get(moduleId);
    let pdb = null;
    if (mod) {
      for (const cand of [mod.ilPath && mod.ilPath.replace(/\.(dll|exe)$/i, '.pdb'), mod.pdbPath]) {
        if (cand && fs.existsSync(cand)) { pdb = pdbLib.loadPdb(cand); if (pdb) break; }
      }
    }
    pdbs.set(moduleId, pdb);
    return pdb;
  };
  const points = (m) => {
    if (m._pts !== undefined) return m._pts;
    const pdb = pdbFor(m.moduleId);
    m._pts = pdb && m.token ? pdbLib.sequencePoints(pdb, m.token & 0xFFFFFF) : null;
    return m._pts;
  };
  return {
    // where the method starts (its first line)
    method(m) {
      const pts = points(m);
      if (!pts || !pts.length) return null;
      const first = pts.reduce((a, x) => (x.line < a.line && x.file === pts[0].file ? x : a), pts[0]);
      return { file: first.file, line: declarationLine(first.file, first.line, m) };
    },
    // the line being executed at this address (a return address when not the leaf frame)
    at(m, ip, leaf) {
      const pts = points(m);
      if (!pts || !pts.length) return null;
      let il = null;
      if (m.map) {
        const off = ip - m.start - (leaf ? 0 : 1);
        let best = -1;
        for (let i = 0; i < m.map.nat.length; i++) if (m.map.nat[i] <= off && (best < 0 || m.map.nat[i] >= m.map.nat[best]) && m.map.il[i] >= 0) best = i;
        if (best >= 0) il = m.map.il[best];
        else if (m.map.il.some((x) => x === -2)) il = 0; // prolog
      }
      if (il == null) return null;
      const sp = pdbLib.lineForIL(pts, il);
      return sp ? { file: sp.file, line: sp.line } : null;
    }
  };
}

// Builds the call stacks (root first) of the samples, with names. Samples outside managed code are left out
// unless `all` (the runtime samples every thread every ~1 ms, also when it waits).
function cpuStacks(trace, { all = false } = {}) {
  const sym = symbolizer(trace.methods);
  const src = sourceResolver(trace);
  const fnIndex = new Map();
  const functions = [];
  const fn = (key, info) => { let i = fnIndex.get(key); if (i == null) { i = functions.length; fnIndex.set(key, i); functions.push(info); } return i; };
  const NATIVE = () => fn('[native]', { name: '[Native code]', module: '' });
  const stacks = new Map();
  const lines = {};
  const ms = 1; // the sample profiler samples every 1 ms
  for (const s of trace.samples) {
    if (!all && !s.managed) continue;
    const frames = [];
    let userLine = null; // the deepest line of user code in this stack
    for (let i = s.ips.length - 1; i >= 0; i--) {
      const m = sym(s.ips[i]);
      let f;
      if (m) {
        const key = `${m.ns}::${m.name}::${m.sig}`;
        f = fnIndex.get(key);
        if (f == null) {
          const loc = src.method(m);
          f = fn(key, { name: methodLabel(m), module: m.ns, ns: m.ns, method: m.name, framework: isFramework(m.ns), file: loc ? loc.file : '', line: loc ? loc.line : 0 });
        }
        if (!functions[f].framework) { const at = src.at(m, s.ips[i], i === 0); if (at) userLine = at; }
      } else f = NATIVE();
      if (frames[frames.length - 1] !== f || !m) frames.push(f); // fold unresolved runs
    }
    while (frames.length > 1 && functions[frames[frames.length - 1]].name === '[Native code]' && s.managed) frames.pop();
    const key = frames.join(',');
    const e = stacks.get(key);
    if (e) e.w += ms; else stacks.set(key, { frames, w: ms });
    if (userLine) { const fl = (lines[userLine.file] = lines[userLine.file] || {}); fl[userLine.line] = (fl[userLine.line] || 0) + ms; }
  }
  return { functions, stacks: [...stacks.values()], lines };
}

// Allocation ticks by type, with the user functions that allocated them
function allocTable(trace) {
  const sym = symbolizer(trace.methods);
  const src = sourceResolver(trace);
  const byType = new Map();
  for (const a of trace.allocs) {
    let t = byType.get(a.type);
    if (!t) { t = { name: a.type, bytes: 0, ticks: 0, objSize: a.objSize, by: new Map() }; byType.set(a.type, t); }
    t.bytes += a.amount; t.ticks++;
    if (a.objSize) t.objSize = a.objSize;
    // first frame (from the top of the stack) that is user code
    let who = null, at = null;
    for (let i = 0; i < a.ips.length; i++) { const m = sym(a.ips[i]); if (m && !isFramework(m.ns)) { who = m; at = src.at(m, a.ips[i], i === 0); if (!at) { const loc = src.method(m); if (loc) at = { ...loc, approx: true }; } break; } }
    const label = who ? `${methodLabel(who)}${at && !at.approx ? ` line ${at.line}` : ''}` : '[framework / runtime]';
    const b = t.by.get(label) || { name: label, ns: who && who.ns, method: who && who.name, file: at ? at.file : '', line: at ? at.line : 0, bytes: 0, ticks: 0 };
    b.bytes += a.amount; b.ticks++;
    t.by.set(label, b);
  }
  return [...byType.values()].map((t) => ({
    name: t.name, bytes: t.bytes, ticks: t.ticks, count: t.objSize ? Math.round(t.bytes / t.objSize) : null,
    by: [...t.by.values()].sort((a, b) => b.bytes - a.bytes)
  })).sort((a, b) => b.bytes - a.bytes);
}

module.exports = { heapSnapshot, findDotnet, listenAddress, connectTo, HEAP_SNAPSHOT_PROVIDERS, sourceResolver, DotnetTrace, parseNettrace, providersFor, collectTracing2, ipcMessage, ipcString, symbolizer, methodLabel, cpuStacks, allocTable, isFramework };
