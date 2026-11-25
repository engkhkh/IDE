// Nova IDE - debugger (Debug Adapter Protocol client)
// Breakpoints, F5/F10/F11 stepping, Locals / Watch / Call Stack / Breakpoints / Immediate windows, data tips.
'use strict';

const DBG = {
  sessions: new Map(),   // id -> DebugSession
  root: null,            // the session we started
  focus: null,           // session whose stop is shown
  stopped: false,
  threadId: null,
  threads: [],
  frames: [],
  frameIndex: 0,
  config: null,          // last launch configuration (for Restart)
  bps: new Map(),        // path key -> { path, items: [{ line, condition, enabled, verified, decoId }] }
  tempBp: null,          // Run to Cursor
  lineDecos: new Map(),  // model uri -> decoration ids for the current line
  expanded: new Set(load('dbgExpanded', [])),
  prevValues: new Map(),
  watches: load('watches', []),
  immHistory: [], immIndex: 0,
  stopping: false,
  starting: false
};

// ---------------- a DAP session ----------------
class DebugSession {
  constructor(id, type, parent) {
    Object.assign(this, { id, type, parent, seq: 1, pending: new Map(), caps: {}, configured: false, ended: false, name: '' });
    this.initializedP = new Promise((r) => { this._initialized = r; });
  }
  request(command, args, timeoutMs = 30000) {
    if (this.ended) return Promise.reject(new Error('session ended'));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out`)); }, timeoutMs) : null;
      this.pending.set(seq, { command, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      api.dap.send(this.id, { seq, type: 'request', command, arguments: args });
    });
  }
  respond(req, body, success = true, message) {
    api.dap.send(this.id, { seq: this.seq++, type: 'response', request_seq: req.seq, success, command: req.command, body, message });
  }
  handle(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else {
        const fmt = msg.body && msg.body.error && msg.body.error.format;
        const vars = (msg.body && msg.body.error && msg.body.error.variables) || {};
        p.reject(new Error((fmt ? fmt.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? k) : '') || msg.message || `${p.command} failed`));
      }
    } else if (msg.type === 'event') onEvent(this, msg);
    else if (msg.type === 'request') onReverseRequest(this, msg);
  }
  end() {
    this.ended = true;
    for (const p of this.pending.values()) p.reject(new Error('session ended'));
    this.pending.clear();
  }
}

api.on('dap:message', ({ id, msg }) => { const s = DBG.sessions.get(id); if (s) s.handle(msg); });
api.on('dap:closed', ({ id, code, error, stderr }) => {
  const s = DBG.sessions.get(id);
  if (!s) return;
  if (error) log(`Debugger stopped: ${error}\n`, 'stderr');
  else if (code && !DBG.stopping && stderr) log(`Debugger exited (${code}): ${stderr.trim().split('\n').slice(-3).join('\n')}\n`, 'stderr');
  endSession(s);
});
api.on('dap:log', ({ text }) => { if (/error|exception/i.test(text) && !DBG.stopping) console.warn('[debug adapter]', text); });
api.on('dap:installProgress', ({ text }) => { status(text); log(`${text}\n`, 'info'); });

// ---------------- launch configuration ----------------
const isUnder = (p) => state.root && normPathKey(p).startsWith(normPathKey(state.root));
function substitute(v, file) {
  if (typeof v === 'string') return v.replace(/\$\{workspaceFolder\}/g, state.root || '').replace(/\$\{file\}/g, file || '').replace(/\$\{fileDirname\}/g, file ? dirName(file) : '');
  if (Array.isArray(v)) return v.map((x) => substitute(x, file));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, file)]));
  return v;
}
const TYPE_ALIASES = { node: 'pwa-node', 'pwa-node': 'pwa-node', coreclr: 'coreclr', python: 'python', debugpy: 'python' };

async function resolveLaunchConfig({ stopAtEntry }) {
  const file = state.active && state.active.path;
  const p = state.project || {};

  // 1) .nova/launch.json (VS Code style) wins when present
  if (state.root) {
    try {
      const json = JSON.parse((await api.readFile(`${state.root}${sep()}.nova${sep()}launch.json`)).replace(/^\s*\/\/.*$/gm, ''));
      const list = json.configurations || [];
      const cfg = list.find((c) => c.default) || list[0];
      if (cfg) {
        const c = substitute({ ...cfg }, file);
        c.type = TYPE_ALIASES[c.type] || c.type;
        if (stopAtEntry) { c.stopAtEntry = true; c.stopOnEntry = true; }
        return { config: { request: 'launch', console: 'internalConsole', ...c }, name: c.name || 'launch.json' };
      }
    } catch {}
  }

  const e = file ? ext(file) : '';
  // 2) .NET project: build, then debug the built dll
  if (p.type === 'dotnet' && (!file || !['py', 'js', 'mjs', 'cjs'].includes(e) || !isUnder(file))) {
    if (!p.startup) return { error: 'No runnable .NET project (.csproj with OutputType Exe) found.' };
    const csproj = p.startup;
    const cfgName = $('#config').value || 'Debug';
    return {
      name: baseName(csproj).replace(/\.\w+proj$/i, ''),
      preLaunch: async () => {
        const code = await exec('build', `dotnet build "${csproj}" -c ${cfgName}`);
        if (code !== 0) return { error: code === null ? 'Build could not start.' : 'Build failed. Fix the errors and try again.' };
        const r = await api.capture(`dotnet msbuild "${csproj}" -getProperty:TargetPath -p:Configuration=${cfgName}`, dirName(csproj));
        const target = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
        if (!r.ok || !target) return { error: `Could not find the built program: ${r.stderr || r.stdout}` };
        // Properties/launchSettings.json: URLs, environment, arguments, working folder, browser (like Visual Studio)
        const lp = typeof lpForProject === 'function' ? await lpForProject(csproj) : null;
        if (!lp) return { patch: { program: target } };
        log(`Launch profile: ${lp.name}${lp.env.ASPNETCORE_URLS ? ` (${lp.env.ASPNETCORE_URLS})` : ''}\n`, 'info');
        lpOpenBrowserWhenReady(lp.browserUrl);
        return { patch: { program: target, cwd: lp.cwd, args: lp.args, env: { DOTNET_ENVIRONMENT: 'Development', ...lp.env } } };
      },
      config: { type: 'coreclr', request: 'launch', cwd: dirName(csproj), args: [], stopAtEntry: !!stopAtEntry, console: 'internalConsole', justMyCode: true, env: { DOTNET_ENVIRONMENT: 'Development' } }
    };
  }
  // 3) Python file
  const pyFile = e === 'py' ? file : null;
  if (pyFile || p.type === 'python') {
    const program = pyFile || await firstExisting(['main.py', 'app.py', '__main__.py']);
    if (!program) return { error: 'Open the Python file you want to debug.' };
    const s = state.settings;
    return { name: baseName(program), config: { type: 'python', request: 'launch', program, cwd: state.root || dirName(program), console: 'internalConsole', justMyCode: true, stopOnEntry: !!stopAtEntry, ...(s.pythonPath ? { python: s.pythonPath } : {}) } };
  }
  // 4) Node.js
  const jsFile = ['js', 'mjs', 'cjs'].includes(e) ? file : null;
  if (jsFile || p.type === 'node') {
    let program = jsFile;
    if (!program && state.root) {
      try { const pkg = JSON.parse(await api.readFile(`${state.root}${sep()}package.json`)); if (pkg.main) program = `${state.root}${sep()}${pkg.main.replace(/\//g, sep())}`; } catch {}
      program = program || await firstExisting(['index.js', 'main.js', 'app.js', 'server.js']);
    }
    if (!program) return { error: 'Open the JavaScript file you want to debug.' };
    return { name: baseName(program), config: { type: 'pwa-node', request: 'launch', program, cwd: state.root || dirName(program), console: 'internalConsole', outputCapture: 'std', stopOnEntry: !!stopAtEntry, skipFiles: ['<node_internals>/**'] } };
  }
  if (['ts', 'tsx'].includes(e)) return { error: 'To debug TypeScript, compile it to JavaScript and debug the .js file (or add .nova/launch.json).' };
  if (p.type === 'flutter') return { error: 'Flutter debugging is not supported yet. Use Start Without Debugging (Ctrl+F5).' };
  return { error: 'Nothing to debug: open a .NET project, a Python file or a JavaScript file.' };
}
async function firstExisting(names) {
  if (!state.root) return null;
  for (const n of names) { const p = `${state.root}${sep()}${n}`; if ((await api.ws.stat(p)).exists) return p; }
  return null;
}

// ---------------- start / stop ----------------
async function startDebugging({ stopAtEntry = false } = {}) {
  if (DBG.root || DBG.starting) return;
  if (state.runId) return status('A process is already running. Stop it first (Shift+F5).');
  DBG.starting = true;
  try {
    const r = await resolveLaunchConfig({ stopAtEntry });
    if (r.error) { log(`${r.error}\n`, 'info'); showPanel('output'); status(r.error); return; }
    await saveAll();
    const config = { ...r.config };
    if (r.preLaunch) {
      const pre = await r.preLaunch();
      if (pre.error) { log(`${pre.error}\n`, 'stderr'); status(pre.error); return; }
      Object.assign(config, pre.patch || {});
    }
    DBG.config = { ...r, config };
    log(`\n------ Debugging ${r.name} (${config.type}) started: ${new Date().toLocaleTimeString()} ------\n`, 'info');
    const s = await createSession(config.type, null, config.cwd);
    if (!s) return;
    s.name = r.name;
    DBG.root = s;
    updateDebugUI();
    // Diagnostic Tools and others listen to these debug-* events
    bus.emit('debugStarted', { session: s, name: r.name, type: config.type });
    await initSession(s, config.request || 'launch', config);
  } catch (e) {
    log(`Could not start debugging: ${e.message}\n`, 'stderr');
    showPanel('output');
    await stopDebugging();
  } finally {
    DBG.starting = false;
    updateDebugUI();
  }
}

// Attach the .NET debugger to a running process (used by Test Explorer: "Debug Tests")
async function debugAttach({ pid, name, cwd }) {
  if (DBG.root || DBG.starting) { status('A debugging session is already running'); return false; }
  DBG.starting = true;
  try {
    const config = { type: 'coreclr', request: 'attach', processId: pid, justMyCode: true };
    const s = await createSession('coreclr', null, cwd);
    if (!s) return false;
    s.name = name || `process ${pid}`;
    s.skipExternalStops = true; // the test host breaks once in its own code right after attach
    DBG.root = s;
    log(`\n------ Debugging ${s.name} (attached to process ${pid}) ------\n`, 'info');
    updateDebugUI();
    bus.emit('debugStarted', { session: s, name: s.name, type: 'coreclr', pid });
    await initSession(s, 'attach', config);
    return true;
  } catch (e) {
    log(`Could not attach the debugger: ${e.message}\n`, 'stderr');
    await stopDebugging();
    return false;
  } finally {
    DBG.starting = false;
    updateDebugUI();
  }
}
window.debugAttach = debugAttach;

async function createSession(type, parent, cwd) {
  let res = await api.dap.start({ type, parentId: parent ? parent.id : undefined, cwd });
  if (res.missing && res.installable) {
    if (!confirm(`${res.message}\n\nDownload and install it now?`)) { status('Debugger not installed'); return null; }
    showPanel('output');
    const inst = await api.dap.install(type);
    log(`${inst.output}\n`, inst.ok ? 'info' : 'stderr');
    if (!inst.ok) { status('Debugger install failed (see Output)'); return null; }
    res = await api.dap.start({ type, cwd });
  }
  if (res.error) { log(`${res.error}\n`, 'stderr'); showPanel('output'); status('Could not start the debugger'); return null; }
  const s = new DebugSession(res.id, type, parent);
  DBG.sessions.set(res.id, s);
  return s;
}

async function initSession(s, request, config) {
  s.caps = (await s.request('initialize', {
    clientID: 'nova-ide', clientName: 'Nova IDE', adapterID: s.type, locale: 'en', pathFormat: 'path',
    linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: false,
    supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: true, supportsInvalidatedEvent: true,
    supportsProgressReporting: false, supportsMemoryReferences: false, supportsArgsCanBeInterpretedByShell: false
  })) || {};
  // launch/attach answers only after configurationDone for most adapters, so don't await it yet
  const launched = s.request(request, config, 0);
  launched.catch(() => {});
  await Promise.race([s.initializedP, launched.then(() => s.initializedP)]);
  await configureSession(s);
  await launched;
}

async function configureSession(s) {
  for (const entry of DBG.bps.values()) await sendBreakpoints(s, entry.path);
  if (DBG.tempBp && !DBG.bps.has(normPathKey(DBG.tempBp.path))) await sendBreakpoints(s, DBG.tempBp.path);
  const filters = (s.caps.exceptionBreakpointFilters || [])
    .filter((f) => (state.settings.breakOnUncaughtExceptions !== false ? /uncaught|unhandled/i.test(f.filter) : false))
    .map((f) => f.filter);
  try { await s.request('setExceptionBreakpoints', { filters }); } catch {}
  if (s.caps.supportsConfigurationDoneRequest) await s.request('configurationDone', {});
  s.configured = true;
}

async function stopDebugging() {
  const root = DBG.root;
  if (!root) return;
  DBG.stopping = true;
  status('Stopping debugger...');
  const programs = [root, ...[...DBG.sessions.values()].filter((x) => x.peer)];
  await Promise.all(programs.map(async (p) => {
    try {
      if (p.caps.supportsTerminateRequest && !p.ended) await p.request('terminate', {}, 3000);
      else if (!p.ended) await p.request('disconnect', { terminateDebuggee: true, restart: false }, 3000);
    } catch {}
  }));
  // give the adapter a moment to exit cleanly, then make sure everything is gone
  setTimeout(() => { for (const s of [...DBG.sessions.values()]) { api.dap.kill(s.id); endSession(s); } }, 1500);
}

function endSession(s) {
  if (!DBG.sessions.has(s.id)) return;
  s.end();
  DBG.sessions.delete(s.id);
  // multiple startup projects: a program that ends leaves the others debugging
  const peers = [...DBG.sessions.values()].filter((x) => x.peer);
  if (s.peer) {
    api.dap.kill(s.id);
    log(`------ Debugging ${s.name} ended ------\n`, 'info');
    if (DBG.focus === s) { DBG.focus = null; clearStopState(); }
    updateDebugUI();
    return;
  }
  if (s === DBG.root && peers.length && !DBG.stopping) {
    for (const c of [...DBG.sessions.values()]) if (c.parent === s && !c.peer) { c.end(); DBG.sessions.delete(c.id); api.dap.kill(c.id); }
    api.dap.kill(s.id);
    log(`------ Debugging ${s.name} ended ------\n`, 'info');
    const next = peers[0];
    next.peer = false; next.parent = null;
    for (const p of peers.slice(1)) p.parent = next;
    DBG.root = next;
    if (DBG.focus === s) { DBG.focus = null; clearStopState(); }
    updateDebugUI();
    return;
  }
  if (s !== DBG.root && DBG.root && DBG.sessions.size) {
    if (DBG.focus === s) { DBG.focus = null; clearStopState(); }
    return;
  }
  // root ended: end everything
  for (const other of [...DBG.sessions.values()]) { other.end(); DBG.sessions.delete(other.id); api.dap.kill(other.id); }
  api.dap.kill(s.id);
  const name = DBG.root ? DBG.root.name : '';
  DBG.root = null; DBG.focus = null; DBG.tempBp = null;
  clearStopState();
  if (name) log(`------ Debugging ${name} ended ------\n`, 'info');
  bus.emit('debugEnded', { name });
  DBG.stopping = false;
  for (const e of DBG.bps.values()) for (const b of e.items) b.verified = undefined;
  redecorateAll();
  renderBreakpoints();
  updateDebugUI();
  status('Ready');
}

// Multiple startup projects: each session's output lines start with "[Project] "
function dbgPrefix(s, text) {
  if (!s.prefix) return text;
  let out = '';
  for (const part of String(text).split(/(\n)/)) {
    if (part === '\n') { out += part; s.midLine = false; continue; }
    if (!part) continue;
    if (!s.midLine) { out += s.prefix; s.midLine = true; }
    out += part;
  }
  return out;
}

// ---------------- events from the debugger ----------------
async function onEvent(s, ev) {
  const b = ev.body || {};
  switch (ev.event) {
    case 'initialized': s._initialized(); break;
    case 'stopped': await onStopped(s, b); break;
    case 'continued':
      if (DBG.focus === s && (b.allThreadsContinued !== false || b.threadId === DBG.threadId)) { DBG.stopped = false; clearStopState(); updateDebugUI(); bus.emit('debugEvent', { kind: 'run', session: s }); }
      break;
    case 'output':
      if (b.category === 'telemetry') break;
      if (b.output) log(dbgPrefix(s, b.output), b.category === 'stderr' ? 'stderr' : (b.category === 'console' || b.category === 'important') ? 'info' : null);
      if (b.output && b.category !== 'console') bus.emit('debugEvent', { kind: 'output', session: s, category: b.category || 'stdout', text: b.output });
      break;
    case 'exited':
      log(`${s.prefix || ''}The program has exited with code ${b.exitCode} (0x${(b.exitCode >>> 0).toString(16)}).\n`, 'info');
      bus.emit('debugEvent', { kind: 'exited', session: s, exitCode: b.exitCode });
      break;
    case 'terminated': endSession(s); break;
    case 'breakpoint': onBreakpointEvent(b); break;
    case 'capabilities': Object.assign(s.caps, b.capabilities || {}); break;
    case 'process':
      if (b.name) s.processName = b.name;
      if (b.systemProcessId) bus.emit('debugEvent', { kind: 'process', session: s, pid: b.systemProcessId, name: b.name });
      break;
    case 'thread': if (DBG.stopped && DBG.focus === s) loadThreads(s); break;
    case 'invalidated': if (DBG.stopped && DBG.focus === s) refreshVariables(); break;
    default: break;
  }
}

async function onReverseRequest(s, req) {
  if (req.command === 'startDebugging') {
    // js-debug: the real program runs in a child session on the same debug server
    s.respond(req, {});
    const child = await createSession(s.type, s, null);
    if (!child) return;
    child.name = s.name;
    try { await initSession(child, req.arguments.request, req.arguments.configuration); }
    catch (e) { log(`Debug child session failed: ${e.message}\n`, 'stderr'); }
  } else if (req.command === 'runInTerminal') {
    s.respond(req, undefined, false, 'Nova IDE runs programs in the Output window (console: internalConsole).');
  } else s.respond(req, undefined, false, `Unsupported request ${req.command}`);
}

async function onStopped(s, b) {
  DBG.focus = s;
  DBG.stopped = true;
  DBG.threadId = b.threadId ?? DBG.threadId;
  await loadThreads(s);
  if (DBG.threadId == null && DBG.threads.length) DBG.threadId = DBG.threads[0].id;
  // Run to Cursor: remove the temporary breakpoint again
  if (DBG.tempBp) { const t = DBG.tempBp; DBG.tempBp = null; for (const x of DBG.sessions.values()) if (x.configured) sendBreakpoints(x, t.path); }
  // .NET exceptions that only pass into an async method's Task: log and continue (like Visual Studio)
  if (b.reason === 'exception' && await dbgSkipAsyncException(s, b)) return;
  const reason = b.reason === 'exception' ? 'Exception thrown' : b.reason === 'breakpoint' ? 'Breakpoint hit' : b.reason === 'step' ? 'Step' : b.reason === 'entry' ? 'Stopped at entry' : `Paused (${b.reason})`;
  status(`${DBG.sessions.size > 1 && s.name && (s.peer || [...DBG.sessions.values()].some((x) => x.peer)) ? `[${s.name}] ` : ''}${reason}${b.description && b.reason !== 'breakpoint' && b.reason !== 'step' ? `: ${b.description}` : ''}`);
  if (b.reason === 'exception') await showException(s, b);
  await loadStack();
  // attached to a test host: skip its own startup break until we stop in your code
  if (s.skipExternalStops) {
    const inUserCode = DBG.frames.some((f) => f.source && f.source.path && isUnder(f.source.path));
    if (!inUserCode && b.reason !== 'exception') { control('continue'); return; }
    s.skipExternalStops = false;
  }
  updateDebugUI();
  const top = DBG.frames[0];
  if (b.reason !== 'exception') DBG.lastException = null;
  bus.emit('debugEvent', { kind: 'break', session: s, reason: b.reason, description: b.description || b.text || '', exception: b.reason === 'exception' ? (DBG.lastException || b.text || b.description || 'Exception') : null,
    file: top && top.source ? top.source.path : null, line: top ? top.line : null, frame: top ? top.name : null });
  // Visual Studio shows the Locals window when the program breaks
  const activePanel = document.querySelector('#bottomTabs button.active');
  if (!activePanel || !['locals', 'watch', 'callstack', 'immediate'].includes(activePanel.dataset.panel)) showPanel('locals');
  if (!document.hasFocus()) window.focus();
}

// .NET: netcoredbg reports an exception as "not handled in user code" when it leaves an async method, although
// the method's Task carries it to the code that awaits it (Visual Studio doesn't break there). When the user
// frame is at an await (or is an async state machine), log it and continue, unless the option asks to break.
const DBG_LINES = new Map();
async function dbgSkipAsyncException(s, b) {
  if (s.type !== 'coreclr' || state.settings.breakOnAsyncUserUnhandled) return false;
  let info = null;
  if (s.caps && s.caps.supportsExceptionInfoRequest) { try { info = await s.request('exceptionInfo', { threadId: b.threadId ?? DBG.threadId }); } catch { /* */ } }
  const userUnhandled = (info && info.breakMode === 'userUnhandled') || /not handled in user code/i.test(`${(info && info.description) || ''} ${b.text || ''} ${b.description || ''}`);
  if (!userUnhandled) return false;
  let frames = [];
  try { frames = (await s.request('stackTrace', { threadId: b.threadId ?? DBG.threadId, startFrame: 0, levels: 30 })).stackFrames || []; } catch { return false; }
  const f = frames.find((x) => x.source && x.source.path);
  if (!f) return false;
  let atAwait = /MoveNext|>d__\d+/.test(f.name || '');
  if (!atAwait) {
    try {
      let lines = DBG_LINES.get(f.source.path);
      if (!lines) { lines = (await api.readFile(f.source.path)).split(/\r?\n/); DBG_LINES.set(f.source.path, lines); }
      atAwait = /\bawait\b/.test(lines[f.line - 1] || '');
    } catch { /* */ }
  }
  if (!atAwait) return false;
  const what = info ? `${(info.exceptionId || '').replace(/^CLR\//, '')}${info.description ? `: ${info.description.replace(/^An exception of type '[^']*' occurred in \S+ but was not handled in user code:?\s*/, '')}` : ''}` : (b.text || 'Exception');
  log(`Exception in async code at ${baseName(f.source.path)}:${f.line} (${what}) - passed to the awaiting Task, continuing\n`, 'info');
  DBG.stopped = false;
  try { await s.request('continue', { threadId: b.threadId ?? DBG.threadId }); } catch { /* */ }
  return true;
}

async function showException(s, b) {
  let text = b.text || b.description || 'Exception';
  if (s.caps.supportsExceptionInfoRequest) {
    try {
      const info = await s.request('exceptionInfo', { threadId: DBG.threadId });
      text = `${info.exceptionId || ''}${info.description ? `: ${info.description}` : ''}`;
      if (info.details && info.details.stackTrace) text += `\n${info.details.stackTrace}`;
    } catch {}
  }
  DBG.lastException = text.split('\n')[0];
  log(`Exception thrown: ${text}\n`, 'stderr');
  status(`Exception thrown: ${text.split('\n')[0].slice(0, 140)}`);
}

async function loadThreads(s) {
  try { DBG.threads = (await s.request('threads', {})).threads || []; } catch { DBG.threads = []; }
  const sel = $('#dbgThread');
  sel.innerHTML = '';
  for (const t of DBG.threads) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = `${t.id}: ${t.name}`;
    if (t.id === DBG.threadId) o.selected = true;
    sel.appendChild(o);
  }
  sel.classList.toggle('hidden', DBG.threads.length < 2);
}
$('#dbgThread').onchange = (e) => { DBG.threadId = +e.target.value; loadStack(); };

// ---------------- call stack + current line ----------------
async function loadStack() {
  const s = DBG.focus;
  if (!s || !DBG.stopped) return;
  try { DBG.frames = (await s.request('stackTrace', { threadId: DBG.threadId, startFrame: 0, levels: 100 })).stackFrames || []; }
  catch { DBG.frames = []; }
  // first frame with real source = the "current statement"
  DBG.frameIndex = Math.max(0, DBG.frames.findIndex((f) => f.source && f.source.path && f.presentationHint !== 'subtle' && f.presentationHint !== 'label'));
  renderCallStack();
  await selectFrame(DBG.frameIndex, true);
}

async function selectFrame(i, reveal) {
  DBG.frameIndex = i;
  const f = DBG.frames[i];
  renderCallStack();
  clearCurrentLine();
  if (f && f.source && f.source.path) {
    if (reveal) await openFile(f.source.path, f.line, f.column || 1);
    const tab = findTab(f.source.path);
    if (tab) setCurrentLine(tab.model, f.line, i === firstUserFrame());
  }
  await refreshVariables();
}
const firstUserFrame = () => Math.max(0, DBG.frames.findIndex((f) => f.source && f.source.path));

function setCurrentLine(model, line, isTop) {
  // the arrow is drawn on top of the breakpoint dot when both are on the same line (like Visual Studio)
  const tab = state.tabs.find((t) => t.model === model);
  const e = tab && bpEntry(tab.path);
  const bp = e && e.items.find((b) => b.line === line && b.enabled);
  const glyph = `${isTop ? 'dbg-current-arrow' : 'dbg-frame-arrow'}${bp ? ' with-bp' : ''}`;
  const ids = model.deltaDecorations(DBG.lineDecos.get(model.uri.toString()) || [], [{
    range: new monacoRef.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: isTop ? 'dbg-current-line' : 'dbg-frame-line', glyphMarginClassName: glyph, stickiness: 1, zIndex: 20 }
  }]);
  DBG.lineDecos.set(model.uri.toString(), ids);
}
function clearCurrentLine() {
  for (const [uri, ids] of DBG.lineDecos) { const m = monacoRef.editor.getModel(monacoRef.Uri.parse(uri)); if (m) m.deltaDecorations(ids, []); }
  DBG.lineDecos.clear();
}

function renderCallStack() {
  const tb = $('#stackBody');
  tb.innerHTML = '';
  let external = false;
  DBG.frames.forEach((f, i) => {
    const hasSrc = f.source && f.source.path;
    if (!hasSrc && f.presentationHint !== 'label') { // collapse runs of frames without source like VS "[External Code]"
      if (external) return;
      external = true;
    } else external = false;
    const tr = document.createElement('tr');
    tr.className = (i === DBG.frameIndex ? 'sel' : '') + (hasSrc ? '' : ' dim');
    tr.innerHTML = '<td class="arrow"></td><td></td><td></td><td></td>';
    tr.children[0].textContent = i === firstUserFrame() ? '➜' : i === DBG.frameIndex ? '▸' : '';
    tr.children[1].textContent = hasSrc ? f.name : (f.presentationHint === 'label' ? f.name : '[External Code]');
    tr.children[2].textContent = hasSrc ? baseName(f.source.path) : '';
    tr.children[3].textContent = hasSrc ? f.line : '';
    tr.title = hasSrc ? f.source.path : '';
    if (hasSrc) tr.ondblclick = tr.onclick = () => selectFrame(i, true);
    tb.appendChild(tr);
  });
}

function clearStopState() {
  DBG.stopped = false;
  DBG.frames = [];
  clearCurrentLine();
  $('#stackBody').innerHTML = '';
  $('#localsBody').innerHTML = '';
  renderWatches(true);
}

// ---------------- variables (Locals / Watch) ----------------
const currentFrameId = () => { const f = DBG.frames[DBG.frameIndex]; return f ? f.id : undefined; };

async function fetchChildren(ref) {
  if (!DBG.focus || !ref) return [];
  try { return (await DBG.focus.request('variables', { variablesReference: ref })).variables || []; }
  catch { return []; }
}

async function refreshVariables() {
  await Promise.all([renderLocals(), renderWatches()]);
}

async function renderLocals() {
  const tb = $('#localsBody');
  const s = DBG.focus;
  const fid = currentFrameId();
  if (!s || !DBG.stopped || fid === undefined) { tb.innerHTML = ''; return; }
  let scopes = [];
  try { scopes = (await s.request('scopes', { frameId: fid })).scopes || []; } catch {}
  const rows = [];
  for (const [i, sc] of scopes.entries()) {
    // local scopes are shown inline like Visual Studio (Node splits them into "Block" + "Local");
    // globals, closures and other big scopes stay as expandable groups
    const inline = !sc.expensive && (i === 0 || /^(local|locals|block|arguments)\b/i.test(sc.name));
    if (inline) {
      for (const v of await fetchChildren(sc.variablesReference)) rows.push(...await varRows(v, 0, `L/${v.name}`, sc.variablesReference));
    } else {
      rows.push(...await varRows({ name: sc.name, value: '', type: '', variablesReference: sc.variablesReference, isScope: true }, 0, `S/${sc.name}`, 0));
    }
  }
  tb.replaceChildren(...rows);
}

async function varRows(v, depth, key, parentRef) {
  const tr = document.createElement('tr');
  const expandable = v.variablesReference > 0;
  const open = expandable && DBG.expanded.has(key);
  const changed = DBG.prevValues.has(key) && DBG.prevValues.get(key) !== v.value && !v.isScope;
  DBG.prevValues.set(key, v.value);
  tr.innerHTML = '<td class="vname"></td><td class="vval"></td><td class="vtype"></td>';
  const name = tr.children[0];
  name.style.paddingLeft = `${6 + depth * 16}px`;
  name.innerHTML = `<span class="chev">${expandable ? (open ? '▾' : '▸') : ''}</span>`;
  name.appendChild(document.createTextNode(v.name));
  tr.children[1].textContent = v.value;
  tr.children[1].title = v.value;
  tr.children[2].textContent = v.type || '';
  if (changed) tr.children[1].classList.add('changed');
  if (v.isScope) tr.classList.add('scope-row');
  if (expandable) name.onclick = () => { if (DBG.expanded.has(key)) DBG.expanded.delete(key); else DBG.expanded.add(key); store('dbgExpanded', [...DBG.expanded].slice(-300)); refreshVariables(); };
  // double-click a value to edit it (when the debugger supports it)
  if (parentRef && DBG.focus && DBG.focus.caps.supportsSetVariable) {
    tr.children[1].ondblclick = async () => {
      const nv = await ask(`New value for ${v.name}`, v.value);
      if (nv == null) return;
      try { await DBG.focus.request('setVariable', { variablesReference: parentRef, name: v.name, value: nv }); }
      catch (e) { status(`Could not set value: ${e.message}`); }
      refreshVariables();
    };
  }
  const rows = [tr];
  if (open) for (const c of await fetchChildren(v.variablesReference)) rows.push(...await varRows(c, depth + 1, `${key}/${c.name}`, v.variablesReference));
  return rows;
}

async function evaluate(expression, context) {
  const s = DBG.focus;
  if (!s || !DBG.stopped) throw new Error('not stopped at a breakpoint');
  return s.request('evaluate', { expression, frameId: currentFrameId(), context }, 10000);
}

async function renderWatches(clearOnly) {
  const tb = $('#watchBody');
  const rows = [];
  for (const [i, expr] of DBG.watches.entries()) {
    let v = { name: expr, value: '', type: '', variablesReference: 0 };
    if (!clearOnly && DBG.stopped) {
      try { const r = await evaluate(expr, 'watch'); v = { name: expr, value: r.result, type: r.type || '', variablesReference: r.variablesReference || 0 }; }
      catch (e) { v.value = `⚠ ${e.message}`; }
    }
    const r = await varRows(v, 0, `W/${expr}`, 0);
    const del = document.createElement('button');
    del.className = 'git-mini watch-del'; del.textContent = '✕'; del.title = 'Delete watch';
    del.onclick = (ev) => { ev.stopPropagation(); DBG.watches.splice(i, 1); store('watches', DBG.watches); renderWatches(); };
    r[0].children[2].appendChild(del);
    r[0].children[0].ondblclick = async () => { const n = await ask('Edit watch', expr); if (n) { DBG.watches[i] = n; store('watches', DBG.watches); renderWatches(); } };
    rows.push(...r);
  }
  const add = document.createElement('tr');
  add.innerHTML = '<td colspan="3"><input class="watch-add" placeholder="Add item to watch" spellcheck="false" /></td>';
  add.querySelector('input').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { addWatch(e.target.value.trim()); }
  };
  rows.push(add);
  tb.replaceChildren(...rows);
}
function addWatch(expr) {
  DBG.watches.push(expr);
  store('watches', DBG.watches);
  renderWatches();
}

// ---------------- Immediate window ----------------
function immLog(text, cls) {
  const pre = $('#immediateLog');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}
$('#immediateInput').addEventListener('keydown', async (e) => {
  const input = e.target;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!DBG.immHistory.length) return;
    DBG.immIndex = Math.min(DBG.immHistory.length, Math.max(0, DBG.immIndex + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = DBG.immHistory[DBG.immIndex] || '';
    return;
  }
  if (e.key !== 'Enter' || !input.value.trim()) return;
  const expr = input.value.trim();
  input.value = '';
  DBG.immHistory.push(expr); DBG.immIndex = DBG.immHistory.length;
  immLog(`> ${expr}\n`, 'info');
  try {
    const r = await evaluate(expr, 'repl');
    immLog(`${r.result}${r.type ? `   (${r.type})` : ''}\n`);
    refreshVariables(); // the expression may have changed state
  } catch (err) { immLog(`${err.message}\n`, 'stderr'); }
});

// ---------------- breakpoints ----------------
function bpEntry(path, create) {
  const k = normPathKey(path);
  let e = DBG.bps.get(k);
  if (!e && create) { e = { path, items: [] }; DBG.bps.set(k, e); }
  return e;
}

// read the current line numbers back from the editor (breakpoints move with edits)
function syncLines(path) {
  const e = bpEntry(path);
  const tab = findTab(path);
  if (!e || !tab) return;
  for (const b of e.items) {
    if (!b.decoId) continue;
    const r = tab.model.getDecorationRange(b.decoId);
    if (r) b.line = r.startLineNumber;
  }
  // two breakpoints may have collapsed onto one line
  const seen = new Set();
  e.items = e.items.filter((b) => (seen.has(b.line) ? false : seen.add(b.line)));
}

function decorate(path) {
  const tab = findTab(path);
  if (!tab) return;
  const e = bpEntry(path);
  const items = e ? e.items : [];
  const old = tab.bpDecos || [];
  const decos = items.map((b) => {
    const cls = !b.enabled ? 'bp-glyph-disabled' : b.verified === false ? 'bp-glyph-unverified' : b.condition ? 'bp-glyph-cond' : 'bp-glyph';
    const hover = `Breakpoint${b.condition ? `\nCondition: ${b.condition}` : ''}${!b.enabled ? ' (disabled)' : b.verified === false ? `\n${b.message || 'Not bound yet (no code loaded for this line)'}` : ''}`;
    return { range: new monacoRef.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: cls, glyphMarginHoverMessage: { value: hover }, stickiness: 1, className: b.enabled ? 'bp-line' : undefined, isWholeLine: b.enabled } };
  });
  tab.bpDecos = tab.model.deltaDecorations(old, decos);
  items.forEach((b, i) => { b.decoId = tab.bpDecos[i]; });
}
function redecorateAll() { for (const t of state.tabs) decorate(t.path); }

function saveBreakpoints() {
  const list = [];
  for (const e of DBG.bps.values()) { syncLines(e.path); for (const b of e.items) list.push({ path: e.path, line: b.line, condition: b.condition || '', enabled: b.enabled }); }
  store(`bps:${state.root || ''}`, list);
}
function loadBreakpoints() {
  DBG.bps.clear();
  for (const b of load(`bps:${state.root || ''}`, [])) bpEntry(b.path, true).items.push({ line: b.line, condition: b.condition, enabled: b.enabled !== false });
  redecorateAll();
  renderBreakpoints();
}

async function sendBreakpoints(s, path) {
  if (s.ended) return;
  syncLines(path);
  const e = bpEntry(path);
  const items = e ? e.items.filter((b) => b.enabled) : [];
  const req = items.map((b) => ({ line: b.line, condition: b.condition || undefined }));
  if (DBG.tempBp && normPathKey(DBG.tempBp.path) === normPathKey(path) && !items.some((b) => b.line === DBG.tempBp.line)) req.push({ line: DBG.tempBp.line });
  try {
    const res = await s.request('setBreakpoints', { source: { path, name: baseName(path) }, breakpoints: req, lines: req.map((b) => b.line), sourceModified: false });
    (res.breakpoints || []).forEach((rb, i) => {
      const b = items[i];
      if (!b) return;
      b.id = rb.id;
      // js-debug's parent session never binds breakpoints; only trust sessions that run code
      if (rb.verified || s.parent || !hasChildren(s)) { b.verified = !!rb.verified; b.message = rb.message; }
      if (rb.verified && rb.line && rb.line !== b.line) { b.line = rb.line; }
    });
  } catch (err) { console.warn('setBreakpoints failed', err.message); }
  decorate(path);
  renderBreakpoints();
}
const hasChildren = (s) => [...DBG.sessions.values()].some((x) => x.parent === s);

function onBreakpointEvent({ breakpoint: rb }) {
  if (!rb || rb.id == null) return;
  for (const e of DBG.bps.values()) {
    const b = e.items.find((x) => x.id === rb.id);
    if (!b) continue;
    b.verified = !!rb.verified;
    b.message = rb.message;
    if (rb.line) b.line = rb.line;
    decorate(e.path);
    renderBreakpoints();
    return;
  }
}

function breakpointsChanged(path) {
  saveBreakpoints();
  decorate(path);
  renderBreakpoints();
  for (const s of DBG.sessions.values()) if (s.configured) sendBreakpoints(s, path);
}

function toggleBreakpoint(path, line) {
  syncLines(path);
  const e = bpEntry(path, true);
  const i = e.items.findIndex((b) => b.line === line);
  if (i >= 0) e.items.splice(i, 1);
  else e.items.push({ line, condition: '', enabled: true });
  e.items.sort((a, b) => a.line - b.line);
  breakpointsChanged(path);
}

async function editCondition(path, line) {
  syncLines(path);
  const e = bpEntry(path, true);
  let b = e.items.find((x) => x.line === line);
  const cond = await ask(`Breakpoint condition (stop when true), line ${line}`, b ? b.condition : '');
  if (cond == null) return;
  if (!b) { b = { line, condition: '', enabled: true }; e.items.push(b); e.items.sort((x, y) => x.line - y.line); }
  b.condition = cond;
  breakpointsChanged(path);
}

function renderBreakpoints() {
  const tb = $('#bpBody');
  tb.innerHTML = '';
  let n = 0;
  for (const e of DBG.bps.values()) {
    for (const b of e.items) {
      n++;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="checkbox" /></td><td></td><td></td><td></td>';
      const cb = tr.querySelector('input');
      cb.checked = b.enabled;
      cb.onchange = () => { b.enabled = cb.checked; breakpointsChanged(e.path); };
      tr.children[1].innerHTML = `<span class="${!b.enabled ? 'bp-dot off' : b.verified === false ? 'bp-dot unverified' : 'bp-dot'}"></span>`;
      tr.children[1].appendChild(document.createTextNode(`${baseName(e.path)}, line ${b.line}`));
      tr.children[1].title = e.path;
      tr.children[2].textContent = b.condition ? `when ${b.condition}` : '';
      tr.children[2].ondblclick = () => editCondition(e.path, b.line);
      const del = document.createElement('button');
      del.className = 'git-mini'; del.textContent = '✕'; del.title = 'Delete';
      del.onclick = (ev) => { ev.stopPropagation(); toggleBreakpoint(e.path, b.line); };
      tr.children[3].appendChild(del);
      tr.children[1].onclick = () => openFile(e.path, b.line);
      tb.appendChild(tr);
    }
  }
  $('#bpCount').textContent = n;
}
$('#bpDeleteAll').onclick = () => commands.deleteAllBreakpoints();
$('#bpToggleAll').onclick = () => {
  const all = [...DBG.bps.values()].flatMap((e) => e.items);
  const enable = all.some((b) => !b.enabled);
  for (const e of DBG.bps.values()) { for (const b of e.items) b.enabled = enable; breakpointsChanged(e.path); }
};

// editor gutter: click to toggle, right-click for options, hover shows a faint dot
bus.on('ready', () => {
  const T = monacoRef.editor.MouseTargetType;
  editor.onMouseDown((e) => {
    if (e.target.type !== T.GUTTER_GLYPH_MARGIN || !state.active || e.event.rightButton) return;
    toggleBreakpoint(state.active.path, e.target.position.lineNumber);
  });
  editor.onContextMenu((e) => {
    if (e.target.type !== T.GUTTER_GLYPH_MARGIN || !state.active) return;
    const path = state.active.path, line = e.target.position.lineNumber;
    const b = (bpEntry(path) || { items: [] }).items.find((x) => x.line === line);
    const menu = $('#ctxMenu');
    menu.innerHTML = '';
    const item = (label, fn) => { const d = document.createElement('div'); d.textContent = label; d.onclick = () => { menu.classList.add('hidden'); fn(); }; menu.appendChild(d); };
    item(b ? 'Delete Breakpoint' : 'Insert Breakpoint', () => toggleBreakpoint(path, line));
    item(b && b.condition ? 'Edit Condition...' : 'Conditional Breakpoint...', () => editCondition(path, line));
    if (b) item(b.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint', () => { b.enabled = !b.enabled; breakpointsChanged(path); });
    if (DBG.stopped) item('Run to Cursor', () => runToCursor(path, line));
    menu.style.left = `${e.event.posx}px`; menu.style.top = `${e.event.posy}px`;
    menu.classList.remove('hidden');
  });
  let hintIds = [];
  editor.onMouseMove((e) => {
    const m = editor.getModel();
    if (!m) return;
    const over = e.target.type === T.GUTTER_GLYPH_MARGIN ? e.target.position.lineNumber : 0;
    hintIds = m.deltaDecorations(hintIds, over ? [{ range: new monacoRef.Range(over, 1, over, 1), options: { glyphMarginClassName: 'bp-glyph-hint' } }] : []);
  });
  editor.onMouseLeave(() => { const m = editor.getModel(); if (m) hintIds = m.deltaDecorations(hintIds, []); });

  // Data tips: hover a variable while stopped to see its value
  monacoRef.languages.registerHoverProvider('*', {
    async provideHover(model, position) {
      if (!DBG.stopped || !DBG.focus) return null;
      const lineText = model.getLineContent(position.lineNumber);
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // include the member chain to the left: obj.prop.value
      let start = word.startColumn - 1;
      while (start > 0 && /[\w$.\]\[]/.test(lineText[start - 1])) start--;
      const expr = lineText.slice(start, word.endColumn - 1).replace(/^\.+/, '');
      if (!expr || /^\d/.test(expr)) return null;
      try {
        const r = await evaluate(expr, 'hover');
        if (!r || r.result == null || r.result === '') return null;
        return { range: new monacoRef.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn), contents: [{ value: `**${expr}** = \`${String(r.result).replace(/`/g, "'")}\`${r.type ? `  *(${r.type})*` : ''}` }] };
      } catch { return null; }
    }
  });
  loadBreakpoints();
});
bus.on('tabOpened', (tab) => { decorate(tab.path); const f = DBG.frames[DBG.frameIndex]; if (f && f.source && f.source.path && samePath(f.source.path, tab.path)) setCurrentLine(tab.model, f.line, DBG.frameIndex === firstUserFrame()); });
bus.on('tabClosing', (tab) => { syncLines(tab.path); saveBreakpoints(); });
bus.on('saved', (tab) => { if (bpEntry(tab.path)) { saveBreakpoints(); renderBreakpoints(); } });
bus.on('folder', () => { if (!DBG.root) loadBreakpoints(); });

// ---------------- stepping ----------------
async function control(command) {
  const s = DBG.focus;
  if (!s || !DBG.stopped) return;
  DBG.stopped = false;
  clearCurrentLine();
  updateDebugUI();
  status(command === 'continue' ? 'Running...' : 'Stepping...');
  bus.emit('debugEvent', { kind: 'run', session: s, command });
  try { await s.request(command, { threadId: DBG.threadId }); }
  catch (e) { status(`${command} failed: ${e.message}`); DBG.stopped = true; updateDebugUI(); }
}
async function runToCursor(path, line) {
  if (!DBG.stopped) return;
  DBG.tempBp = { path, line };
  for (const s of DBG.sessions.values()) if (s.configured) await sendBreakpoints(s, path);
  control('continue');
}

// ---------------- toolbar / status ----------------
function updateDebugUI() {
  const active = !!DBG.root || DBG.starting;
  $('#debugBar').classList.toggle('hidden', !active);
  $('#status').classList.toggle('debugging', !!DBG.root);
  $('#dbgContinue').disabled = !DBG.stopped;
  $('#dbgPause').disabled = !DBG.root || DBG.stopped;
  for (const id of ['#dbgStepInto', '#dbgStepOver', '#dbgStepOut']) $(id).disabled = !DBG.stopped;
  $('#btnRun').disabled = (active && !DBG.stopped) || !!state.runId;
  $('#runLabel').textContent = DBG.root ? 'Continue' : (window.startLabel ? window.startLabel() : 'Start');
  $('#btnStop').disabled = !active && !state.runId;
  $('#btnRunNoDebug').disabled = active || !!state.runId;
  if (DBG.root && !DBG.stopped && !DBG.starting) status(`Running ${DBG.root.name}...`);
}

// ---------------- commands ----------------
const stopProcess = commands.stop;
Object.assign(commands, {
  debugStart: () => (DBG.root ? (DBG.stopped ? control('continue') : status('The program is running. Use Break All to pause it.')) : startDebugging()),
  run: () => commands.debugStart(),
  runNoDebug: () => exec('run'),
  debugContinue: () => control('continue'),
  debugStepOver: () => (DBG.root ? control('next') : startDebugging({ stopAtEntry: true })),
  debugStepInto: () => (DBG.root ? control('stepIn') : startDebugging({ stopAtEntry: true })),
  debugStepOut: () => control('stepOut'),
  debugPause: async () => {
    if (!(DBG.focus || DBG.root)) return;
    const s = DBG.focus || [...DBG.sessions.values()].pop();
    try {
      // a program that never stopped has no known threads yet: ask for them (netcoredbg refuses an unknown id)
      let threadId = DBG.threadId || (DBG.threads[0] && DBG.threads[0].id);
      if (!threadId) { try { const t = (await s.request('threads', {})).threads || []; if (t.length) { DBG.threads = t; threadId = t[0].id; } } catch { /* */ } }
      await s.request('pause', { threadId: threadId || 1 });
    } catch (e) { status(e.message); }
  },
  debugRunToCursor: () => { if (state.active && editor) runToCursor(state.active.path, editor.getPosition().lineNumber); },
  debugRestart: async () => {
    if (!DBG.root) return startDebugging();
    await stopDebugging();
    const t0 = Date.now();
    while (DBG.root && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    startDebugging();
  },
  stop: () => (DBG.root ? stopDebugging() : stopProcess()),
  toggleBreakpoint: () => { if (state.active && editor) toggleBreakpoint(state.active.path, editor.getPosition().lineNumber); },
  conditionalBreakpoint: () => { if (state.active && editor) editCondition(state.active.path, editor.getPosition().lineNumber); },
  deleteAllBreakpoints: () => {
    const paths = [...DBG.bps.values()].map((e) => e.path);
    DBG.bps.clear();
    for (const p of paths) breakpointsChanged(p);
    renderBreakpoints();
  },
  showLocals: () => showPanel('locals'),
  showWatch: () => showPanel('watch'),
  showCallStack: () => showPanel('callstack'),
  showBreakpoints: () => showPanel('breakpoints'),
  showImmediate: () => { showPanel('immediate'); $('#immediateInput').focus(); },
  addWatchFromEditor: () => {
    if (!editor || !editor.getModel()) return;
    const sel = editor.getModel().getValueInRange(editor.getSelection());
    const w = sel || (editor.getModel().getWordAtPosition(editor.getPosition()) || {}).word;
    if (w) { addWatch(w); showPanel('watch'); }
  },
  debugInstallers: async () => {
    showPanel('output');
    for (const t of ['coreclr', 'pwa-node', 'python']) {
      const r = await api.dap.resolve(t);
      log(`${r.name}: ${r.ok ? 'installed' : r.message}\n`, r.ok ? 'info' : null);
      if (!r.ok && r.installable && confirm(`${r.message}\n\nInstall it now?`)) {
        const inst = await api.dap.install(t);
        log(`${inst.output}\n`, inst.ok ? 'info' : 'stderr');
      }
    }
  }
});

// Editor right-click: "Add Watch" like Visual Studio
bus.on('ready', () => {
  editor.addAction({ id: 'nova.addWatch', label: 'Add Watch', contextMenuGroupId: '9_debug', run: () => commands.addWatchFromEditor() });
  editor.addAction({ id: 'nova.toggleBp', label: 'Toggle Breakpoint', contextMenuGroupId: '9_debug', run: () => commands.toggleBreakpoint() });
  editor.addAction({ id: 'nova.runToCursor', label: 'Run to Cursor', contextMenuGroupId: '9_debug', precondition: undefined, run: () => commands.debugRunToCursor() });
  renderWatches(true);
  updateDebugUI();
});
window.addEventListener('beforeunload', () => saveBreakpoints());

// expose for tests / other modules
window.DBG = DBG;
