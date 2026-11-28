// Nova IDE - MCP server for coding agents (Claude Code, Codex, OpenCode, Cursor...): the agent builds, runs tests,
// reads the Error List and the editor, opens files, debugs and looks at the IDE through Nova — like Passenger.
// Streamable HTTP transport (JSON responses) on 127.0.0.1 only; a browser page can't call it (Origin check).
// The tools run in the focused Nova window (or the one whose folder the agent names).
'use strict';

const http = require('http');
const { BrowserWindow, ipcMain: rawIpc } = require('electron');

const PROTOCOL = '2025-06-18';
let server = null;
let port = null;
let seq = 0;
const pending = new Map();
let appVersion = '0.0.0';

const TOOLS = [
  { name: 'get_workspace', description: 'The open folder, solution, projects, open files, the active file with the cursor, and whether the folder is trusted.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_editor_text', description: 'The text of a file as it is in the editor, including unsaved changes (the active file when no path is given).', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'open_file', description: 'Open a file in the editor, optionally at a line.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' } }, required: ['path'] } },
  { name: 'get_diagnostics', description: 'The Error List: build errors and warnings and IntelliSense problems (optionally for one file).', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'build', description: 'Build the solution / project (saves all files first). Returns success, the errors and warnings, and the end of the build output.', inputSchema: { type: 'object', properties: { rebuild: { type: 'boolean' } } } },
  { name: 'run_tests', description: 'Run the tests of the folder\'s test projects (Test Explorer), optionally only those whose name contains a filter. Returns passed / failed with messages.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'find_symbol', description: 'Find classes, methods and other symbols by name with the language servers (Go to All).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'debug', description: 'Control the debugger: start, continue, step_over, step_into, step_out, stop, or state (where it stopped, call stack, locals).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'continue', 'step_over', 'step_into', 'step_out', 'stop', 'state'] } }, required: ['action'] } },
  { name: 'set_breakpoint', description: 'Set (or remove with remove=true) a breakpoint, optionally with a condition.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, condition: { type: 'string' }, remove: { type: 'boolean' } }, required: ['path', 'line'] } },
  { name: 'screenshot', description: 'A picture of the Nova window, to see what the IDE (or a dialog) shows.', inputSchema: { type: 'object', properties: {} } }
];

function targetWindow(folder) {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return (folder && wins.find((w) => w.__novaFolder && w.__novaFolder.toLowerCase() === String(folder).toLowerCase())) || BrowserWindow.getFocusedWindow() || wins[0];
}
function callRenderer(win, name, args, timeout = 30 * 60000) {
  return new Promise((resolve) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: `${name} timed out` }); }, timeout);
    pending.set(id, (r) => { clearTimeout(t); resolve(r); });
    win.webContents.send('mcp:call', { id, name, args });
  });
}
async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
  const win = targetWindow(args && args.folder);
  if (!win) return { isError: true, content: [{ type: 'text', text: 'No Nova window is open' }] };
  if (name === 'screenshot') {
    const img = await win.webContents.capturePage();
    return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }] };
  }
  const r = await callRenderer(win, name, args || {});
  if (r.error) return { isError: true, content: [{ type: 'text', text: r.error }] };
  return { content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2) }], structuredContent: typeof r.result === 'object' && r.result && !Array.isArray(r.result) ? r.result : undefined };
}

async function rpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': return ok({ protocolVersion: (params && params.protocolVersion) || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nova-ide', title: 'Nova IDE', version: appVersion }, instructions: 'Tools of the running Nova IDE: build, test, read errors, debug, open files and look at the IDE.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': return ok(await callTool(params && params.name, params && params.arguments));
    default:
      if (id === undefined) return null; // a notification (notifications/initialized ...)
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403); res.end(); return; }
  if (req.url.split('?')[0] !== '/mcp') { res.writeHead(404); res.end(); return; }
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; } // no server-to-client stream
  if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 10e6) req.destroy(); });
  req.on('end', async () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
    const batch = Array.isArray(msg);
    const out = (await Promise.all((batch ? msg : [msg]).map((m) => rpc(m).catch((e) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }))))).filter(Boolean);
    if (!out.length) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'nova' });
    res.end(JSON.stringify(batch ? out : out[0]));
  });
}

async function start(p) {
  if (server && port === p) return { port };
  await stop();
  return new Promise((resolve) => {
    const s = http.createServer(handle);
    s.on('error', (e) => resolve({ error: e.code === 'EADDRINUSE' ? `Port ${p} is in use (another Nova window or program): change Options > Agents > port` : e.message }));
    s.listen(p, '127.0.0.1', () => { server = s; port = p; resolve({ port }); });
  });
}
async function stop() { if (server) { const s = server; server = null; port = null; await new Promise((r) => s.close(() => r())); } return true; }

module.exports = {
  TOOLS, rpc, start, stop,
  register({ ipcMain, app }) {
    appVersion = app.getVersion();
    ipcMain.handle('mcp:start', async (_e, p) => start(p || 7811));
    ipcMain.handle('mcp:stop', () => stop());
    ipcMain.handle('mcp:status', () => ({ running: !!server, port }));
    ipcMain.handle('mcp:folder', (e, folder) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.__novaFolder = folder; return true; });
    if (!rawIpc.__novaMcp) {
      rawIpc.__novaMcp = true;
      rawIpc.handle('mcp:result', (_e, id, r) => { const f = pending.get(id); if (f) { pending.delete(id); f(r); } return true; });
    }
  },
  dispose() { stop(); }
};
