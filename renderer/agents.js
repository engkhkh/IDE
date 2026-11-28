// Nova IDE - Agents: the MCP server (Tools > Agents) lets coding agents — Claude Code, Codex, OpenCode, Cursor —
// work through the running IDE: build, run tests, read the Error List and unsaved editor text, open files, set
// breakpoints, debug and look at the window. "Write .mcp.json" shares the server with the team through the repo.
'use strict';

const AG = { status: { running: false, port: null } };
const agUrl = () => `http://127.0.0.1:${AG.status.port || state.settings.mcpPort || 7811}/mcp`;
const agWait = async (cond, ms = 30 * 60000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150)); };
const agAbs = (p) => (!p ? null : /^([A-Za-z]:[\\/]|\/)/.test(p) ? p : `${state.root}${sep()}${p.replace(/[\\/]/g, sep())}`);
const agRel = (p) => (state.root && p && p.startsWith(state.root) ? p.slice(state.root.length + 1) : p);

const AG_TOOLS = {
  async get_workspace() {
    const a = state.active;
    const sel = a && editor.getSelection();
    return {
      folder: state.root, trusted: typeof TR === 'undefined' || TR.trusted,
      solution: SOL.model ? SOL.model.path : null,
      projects: projects().map((p) => ({ name: p.name, path: agRel(p.path), kind: p.info && p.info.kind, runnable: !!(p.info && p.info.runnable) })),
      startupProject: SOL.startup ? agRel(SOL.startup) : null,
      openFiles: state.tabs.map((t) => ({ path: agRel(t.path), unsaved: isDirty(t) })),
      activeFile: a ? { path: agRel(a.path), line: editor.getPosition().lineNumber, column: editor.getPosition().column, selection: sel && !sel.isEmpty() ? a.model.getValueInRange(sel) : null } : null,
      configuration: $('#config') ? $('#config').value : 'Debug'
    };
  },
  async get_editor_text({ path }) {
    const p = agAbs(path) || (state.active && state.active.path);
    if (!p) throw new Error('No file is open');
    const t = findTab(p);
    return t ? t.model.getValue() : await api.readFile(p);
  },
  async open_file({ path, line }) { const p = agAbs(path); await openFile(p, line || 1, 1); return `Opened ${agRel(p)}${line ? ` at line ${line}` : ''}`; },
  async get_diagnostics({ path } = {}) {
    const p = agAbs(path);
    const all = [...state.errors.map((e) => ({ ...e, source: 'Build' })), ...intellisenseProblems()];
    return all.filter((e) => !p || samePath(resolvePath(e.file), p)).slice(0, 500)
      .map((e) => ({ severity: e.sev, code: e.code || '', message: e.msg, file: agRel(resolvePath(e.file)), line: e.line, column: e.col, source: e.source }));
  },
  async build({ rebuild } = {}) {
    const start = $('#panel-output').textContent.length;
    const code = await exec(rebuild ? 'rebuild' : 'build');
    if (code === null) return { success: false, message: state.runId ? 'Another build or program is running' : 'Nothing to build (or the folder is not trusted)' };
    const errors = state.errors.filter((e) => e.sev === 'error'), warnings = state.errors.filter((e) => e.sev === 'warning');
    const fmt = (e) => `${agRel(resolvePath(e.file))}(${e.line},${e.col}): ${e.code} ${e.msg}`;
    return { success: code === 0, exitCode: code, errors: errors.slice(0, 100).map(fmt), warnings: warnings.slice(0, 50).map(fmt), outputTail: $('#panel-output').textContent.slice(start).slice(-3000) };
  },
  async run_tests({ filter } = {}) {
    if (!TX.tests.length) await discover();
    const tests = allTests().filter((t) => !filter || t.fqn.toLowerCase().includes(filter.toLowerCase()));
    if (!tests.length) return { message: filter ? `No test matches "${filter}"` : 'No tests found' };
    if (filter) runNodes(tests.map((t) => ({ kind: 'test', key: `t:${t.key}`, project: t.project, test: t, tests: [t] })));
    else commands.testRunAll();
    await new Promise((r) => setTimeout(r, 300));
    await agWait(() => !TX.runId && !(TX.queue && TX.queue.length));
    const res = tests.map((t) => {
      const r = TX.results.get(t.fqn);
      const x = Array.isArray(r) ? r[0] : r;
      return { test: t.fqn, outcome: statusOfFqn(t.fqn), message: x && (x.message || x.errorMessage) ? String(x.message || x.errorMessage).slice(0, 1000) : undefined };
    });
    return { passed: res.filter((r) => r.outcome === 'passed').length, failed: res.filter((r) => r.outcome === 'failed').length, notRun: res.filter((r) => !/passed|failed/.test(r.outcome)).length, results: res.filter((r) => r.outcome !== 'passed').concat(res.filter((r) => r.outcome === 'passed').slice(0, 50)) };
  },
  async find_symbol({ query }) {
    const r = await lspWorkspaceSymbols(query);
    return r.slice(0, 50).map((s) => ({ name: s.name, container: s.container, file: agRel(s.path), line: s.line }));
  },
  async set_breakpoint({ path, line, condition, remove }) {
    const p = agAbs(path);
    const e = bpEntry(p, true);
    const has = e.items.some((b) => b.line === line);
    if (remove ? has : !has) toggleBreakpoint(p, line);
    if (!remove && condition != null) { const b = e.items.find((x) => x.line === line); b.condition = condition; breakpointsChanged(p); }
    return `${remove ? 'Removed the breakpoint' : 'Breakpoint'} at ${agRel(p)}:${line}${condition ? ` when ${condition}` : ''}`;
  },
  async debug({ action }) {
    const state0 = () => {
      const f = DBG.frames[DBG.frameIndex] || DBG.frames[0];
      return { running: !!DBG.root, stopped: !!DBG.stopped, location: f && f.source ? { file: agRel(f.source.path), line: f.line, function: f.name } : null, callStack: DBG.frames.slice(0, 15).map((x) => `${x.name}${x.source && x.source.path ? ` (${agRel(x.source.path)}:${x.line})` : ''}`) };
    };
    const waitStop = async () => { await new Promise((r) => setTimeout(r, 200)); await agWait(() => !DBG.root || (DBG.stopped && DBG.frames.length > 0), 60000); await new Promise((r) => setTimeout(r, 300)); };
    const map = { continue: 'debugContinue', step_over: 'debugStepOver', step_into: 'debugStepInto', step_out: 'debugStepOut' };
    if (action === 'start') { commands.debugStart(); await agWait(() => DBG.root, 120000); await waitStop(); }
    else if (map[action]) { if (!DBG.stopped) return { error: 'The program is not paused' }; commands[map[action]](); await waitStop(); }
    else if (action === 'stop') { await commands.stop(); await agWait(() => !DBG.root, 10000); }
    const st = state0();
    if (st.stopped && DBG.focus) {
      const f = DBG.frames[DBG.frameIndex];
      const locals = [];
      try {
        const scopes = (await DBG.focus.request('scopes', { frameId: f.id })).scopes || [];
        for (const sc of scopes.filter((x) => !x.expensive).slice(0, 2)) for (const v of ((await DBG.focus.request('variables', { variablesReference: sc.variablesReference })).variables || []).slice(0, 50)) locals.push({ name: v.name, value: v.value, type: v.type });
      } catch {}
      st.locals = locals;
      if (DBG.lastException) st.exception = String(DBG.lastException);
    }
    return st;
  }
};

api.on('mcp:call', async ({ id, name, args }) => {
  let reply;
  try {
    const fn = AG_TOOLS[name];
    if (!fn) throw new Error(`Unknown tool ${name}`);
    const result = await fn(args || {});
    reply = result && result.error ? { error: result.error } : { result };
    status(`Agent: ${name.replace(/_/g, ' ')}`);
  } catch (e) { reply = { error: e.message || String(e) }; }
  api.mcp.result(id, reply);
});

async function agApply() {
  if (state.settings.mcpServer) {
    const r = await api.mcp.start(state.settings.mcpPort || 7811);
    if (r.error) { status(`MCP server: ${r.error}`); log(`MCP server: ${r.error}\n`, 'stderr'); }
  } else await api.mcp.stop();
  AG.status = await api.mcp.status();
  $('#stMcp').classList.toggle('hidden', !AG.status.running);
  $('#stMcp').title = AG.status.running ? `MCP server for agents: ${agUrl()}` : '';
}
async function agWriteMcpJson() {
  if (!state.root) return status('Open a folder first');
  const file = `${state.root}${sep()}.mcp.json`;
  let j = {};
  try { j = JSON.parse(await api.readFile(file)); } catch {}
  j.mcpServers = { ...(j.mcpServers || {}), nova: { type: 'http', url: agUrl() } };
  await api.writeFile(file, `${JSON.stringify(j, null, 2)}\n`);
  status('.mcp.json written: agents started in this folder can use Nova');
  return file;
}

Object.assign(commands, {
  agentsToggleServer: () => updateSetting({ mcpServer: !state.settings.mcpServer }),
  agentsWriteMcpJson: () => agWriteMcpJson(),
  agentsCopyClaudeCommand: () => { const c = `claude mcp add --transport http nova ${agUrl()}`; navigator.clipboard.writeText(c).catch(() => {}); status(`Copied: ${c}`); return c; }
});
let agLast;
bus.on('settings', (s) => { const k = `${!!s.mcpServer}|${s.mcpPort}`; if (k !== agLast) { agLast = k; agApply(); } });
bus.on('folder', () => api.mcp.folder(state.root));
bus.on('ready', () => { $('#stMcp').onclick = () => commands.agentsCopyClaudeCommand(); });
