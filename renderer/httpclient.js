// Nova IDE - .http / .rest files, like Visual Studio's HTTP file editor (and Rider's / VS Code REST Client):
// "Send request" above each request (or Ctrl+Alt+S), the response beside the editor, file variables (@name = value),
// environments from the nearest http-client.env.json (+ .user, $shared), request variables
// ({{login.response.body.$.token}}) and dynamic variables ($guid, $randomInt, $datetime, $timestamp, $processEnv, $dotenv).
'use strict';

const HC = { results: new Map(), envCache: new Map(), seq: 0, sending: new Map() }; // results: "path|name" -> last exchange

LANGS.http = 'http';
LANGS.rest = 'http';

// ---------------- parsing ----------------
const HC_METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+/i;
function hcParse(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const vars = []; // [{ name, value, line }] in file order
  const requests = [];
  let block = { start: 0 };
  const blocks = [];
  lines.forEach((l, i) => { if (/^\s*###/.test(l)) { block.end = i - 1; blocks.push(block); block = { start: i + 1 }; } });
  block.end = lines.length - 1;
  blocks.push(block);
  for (const b of blocks) {
    let name = null;
    let i = b.start;
    let req = null;
    // before the request line: comments (# @name x), variables, blank lines
    for (; i <= b.end; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const nm = l.match(/^(?:#|\/\/)\s*@name\s+([\w-]+)/);
      if (nm) { name = nm[1]; continue; }
      if (/^(#|\/\/)/.test(l)) continue;
      const v = l.match(/^@([\w.-]+)\s*=\s*(.*)$/);
      if (v) { vars.push({ name: v[1], value: v[2].trim(), line: i + 1 }); continue; }
      const m = l.match(HC_METHODS);
      const rest = m ? l.slice(m[0].length) : l;
      const ver = rest.match(/\s+(HTTP\/[\d.]+)\s*$/i);
      req = { name, method: m ? m[1].toUpperCase() : 'GET', url: (ver ? rest.slice(0, ver.index) : rest).trim(), httpVersion: ver ? ver[1] : null, headers: [], body: '', line: i + 1, endLine: b.end + 1 };
      i++;
      break;
    }
    if (!req) continue;
    // headers, up to the first blank line
    for (; i <= b.end; i++) {
      const l = lines[i];
      if (!l.trim()) { i++; break; }
      if (/^\s*(#|\/\/)/.test(l)) continue;
      const h = l.match(/^\s*([^:\s]+)\s*:\s*(.*)$/);
      if (h) req.headers.push([h[1], h[2].trim()]);
    }
    const body = lines.slice(i, b.end + 1);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    req.body = body.join('\n');
    requests.push(req);
  }
  return { vars, requests };
}

// ---------------- environments ----------------
async function hcEnvFiles(httpPath) {
  let dir = dirName(httpPath);
  for (let n = 0; n < 40 && dir; n++) {
    const f = `${dir}${sep()}http-client.env.json`;
    try {
      const text = await api.readFile(f);
      let user = {};
      try { user = lpParse(await api.readFile(`${f}.user`)); } catch {}
      return { file: f, env: lpParse(text), user };
    } catch {}
    const up = dirName(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}
function hcEnvNames(envs) {
  if (!envs) return [];
  return [...new Set([...Object.keys(envs.env || {}), ...Object.keys(envs.user || {})])].filter((n) => n !== '$shared');
}
// $shared < environment < .user environment (and .user's $shared below its environment)
function hcEnvVars(envs, name) {
  if (!envs) return {};
  const pick = (o, k) => (o && typeof o[k] === 'object' && o[k] ? o[k] : {});
  return { ...pick(envs.env, '$shared'), ...pick(envs.user, '$shared'), ...(name ? pick(envs.env, name) : {}), ...(name ? pick(envs.user, name) : {}) };
}
const hcEnvKey = (path) => `nova.httpEnv:${normPathKey(dirName(path))}`;
function hcChosenEnv(path) { try { return localStorage.getItem(hcEnvKey(path)) || ''; } catch { return ''; } }

// ---------------- variables ----------------
const HC_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function hcOffset(date, n, unit) {
  const d = new Date(date.getTime());
  const k = parseInt(n, 10);
  if (!unit || Number.isNaN(k)) return d;
  if (unit === 'M') d.setUTCMonth(d.getUTCMonth() + k);
  else if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() + k);
  else if (HC_UNITS[unit]) d.setTime(d.getTime() + k * HC_UNITS[unit]);
  return d;
}
function hcFormatDate(d, fmt, local) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  if (!fmt || fmt === 'iso8601') return local ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : d.toISOString();
  if (fmt === 'rfc1123') return d.toUTCString();
  const f = fmt.replace(/^["']|["']$/g, '');
  const parts = local
    ? { yyyy: d.getFullYear(), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), fff: pad(d.getMilliseconds(), 3) }
    : { yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()), fff: pad(d.getUTCMilliseconds(), 3) };
  return f.replace(/yyyy|MM|dd|HH|mm|ss|fff/g, (t) => parts[t]);
}
function hcGuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
}
// $.a.b[0]['c d'] on parsed JSON
function hcJsonPath(obj, p) {
  if (p === '*' || p === '$') return obj;
  const parts = [];
  String(p).replace(/^\$\.?/, '').replace(/\[(\d+)\]|\[['"]([^'"]+)['"]\]|([^.[\]]+)/g, (m, idx, q, key) => { parts.push(idx != null ? +idx : q != null ? q : key); return m; });
  let cur = obj;
  for (const k of parts) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}
function hcRequestVar(expr, results, path) {
  const m = expr.match(/^([\w-]+)\.(response|request)\.(body|headers)\.(.+)$/);
  if (!m) return undefined;
  const r = results.get(`${normPathKey(path)}|${m[1]}`);
  if (!r) throw new Error(`Send the request "${m[1]}" first: {{${expr}}} uses its ${m[2]}`);
  const part = m[2] === 'response' ? r.response : r.request;
  if (!part) return undefined;
  if (m[3] === 'headers') { const h = (part.headers || []).find(([k]) => k.toLowerCase() === m[4].toLowerCase()); return h ? h[1] : undefined; }
  if (m[4] === '*') return part.body;
  let json;
  try { json = JSON.parse(part.body); } catch { throw new Error(`{{${expr}}}: the ${m[2]} body of "${m[1]}" is not JSON`); }
  const v = hcJsonPath(json, m[4]);
  return v == null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v);
}
// ctx: { fileVars: Map name -> raw value, env: {}, results, path, processEnv: {}, dotenv: {} }
function hcSubstitute(text, ctx, depth = 0) {
  if (depth > 10) throw new Error('Variables refer to each other in a loop');
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, expr) => {
    if (expr.startsWith('$')) {
      const [fn, ...args] = expr.match(/"[^"]*"|'[^']*'|\S+/g);
      switch (fn) {
        case '$guid': return hcGuid();
        case '$randomInt': { const min = args[0] != null ? parseInt(args[0], 10) : 0; const max = args[1] != null ? parseInt(args[1], 10) : 1000; return String(Math.floor(min + Math.random() * (max - min))); }
        case '$timestamp': return String(Math.floor(hcOffset(new Date(), args[0], args[1]).getTime() / 1000));
        case '$datetime': case '$localDatetime': return hcFormatDate(hcOffset(new Date(), args[1], args[2]), args[0], fn === '$localDatetime');
        case '$processEnv': { const k = args[0] && args[0].replace(/^%/, ''); const v = ctx.processEnv && ctx.processEnv[k]; if (v == null) throw new Error(`The environment variable ${k} is not set`); return v; }
        case '$dotenv': { const v = ctx.dotenv && ctx.dotenv[args[0]]; if (v == null) throw new Error(`${args[0]} is not in a .env file next to the .http file`); return v; }
        default: throw new Error(`Unknown dynamic variable {{${expr}}}`);
      }
    }
    if (ctx.fileVars && ctx.fileVars.has(expr)) return hcSubstitute(ctx.fileVars.get(expr), ctx, depth + 1);
    if (ctx.env && Object.prototype.hasOwnProperty.call(ctx.env, expr)) {
      const v = ctx.env[expr];
      if (v && typeof v === 'object') throw new Error(`{{${expr}}} comes from a secret provider (${v.provider || 'unknown'}), which Nova can't read: put the value in http-client.env.json.user`);
      return hcSubstitute(String(v), ctx, depth + 1);
    }
    const rv = hcRequestVar(expr, ctx.results || new Map(), ctx.path || '');
    if (rv !== undefined) return rv;
    throw new Error(`The variable {{${expr}}} is not defined`);
  });
}
function hcDotenv(text) {
  const out = {};
  for (const l of String(text || '').split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); }
  return out;
}

// the request as it will be sent: variables defined above it (later definitions win), the environment, the results
function hcBuild(parsed, req, ctx) {
  const fileVars = new Map();
  for (const v of parsed.vars) if (v.line < req.line) fileVars.set(v.name, v.value);
  const c = { ...ctx, fileVars };
  return {
    method: req.method,
    url: hcSubstitute(req.url, c),
    headers: req.headers.map(([k, v]) => [k, hcSubstitute(v, c)]),
    body: req.body ? hcSubstitute(req.body, c) : ''
  };
}

// ---------------- sending ----------------
async function hcSend(tab, line) {
  const parsed = hcParse(tab.model.getValue());
  const req = parsed.requests.find((r) => line >= r.line && line <= r.endLine) || parsed.requests.filter((r) => r.line <= line).pop() || parsed.requests[0];
  if (!req) return status('There is no request here');
  const envs = await hcEnvFiles(tab.path);
  const envName = hcChosenEnv(tab.path);
  let dotenv = {};
  try { dotenv = hcDotenv(await api.readFile(`${dirName(tab.path)}${sep()}.env`)); } catch {}
  let built;
  try {
    built = hcBuild(parsed, req, { env: hcEnvVars(envs, envName), results: HC.results, path: tab.path, processEnv: await hcProcessEnv(), dotenv });
  } catch (e) {
    tab.hcLast = { request: { method: req.method, url: req.url, headers: [], body: '' }, error: e.message, name: req.name, line: req.line };
    tab.hcShow = true;
    hcShowResponse(tab);
    return null;
  }
  const id = ++HC.seq;
  tab.hcLast = { request: built, pending: true, name: req.name, line: req.line, id };
  tab.hcShow = true;
  hcShowResponse(tab);
  status(`${built.method} ${built.url}...`);
  const res = await api.httpSend(id, built);
  const ex = { request: built, response: res.error ? null : res, error: res.error || null, name: req.name, line: req.line, at: new Date() };
  if (req.name && !res.error) HC.results.set(`${normPathKey(tab.path)}|${req.name}`, ex);
  tab.hcLast = ex;
  if (state.tabs.includes(tab)) hcShowResponse(tab);
  status(res.error ? `Request failed: ${res.error}` : `${res.status} ${res.statusText} · ${res.ms} ms · ${hcSize(res.size)}`);
  bus.emit('httpResponse', ex);
  return ex;
}
let hcEnvCache = null;
async function hcProcessEnv() { if (!hcEnvCache) { try { hcEnvCache = await api.processEnv(); } catch { hcEnvCache = {}; } } return hcEnvCache; }
const hcSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function hcPretty(body, headers) {
  const ct = ((headers || []).find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  if (/json/i.test(ct) || /^\s*[[{]/.test(body)) { try { return { text: JSON.stringify(JSON.parse(body), null, 2), lang: 'json' }; } catch {} }
  if (/xml/i.test(ct)) return { text: body, lang: 'xml' };
  if (/html/i.test(ct)) return { text: body, lang: 'html' };
  return { text: body, lang: 'plaintext' };
}
async function hcShowResponse(tab) {
  const ex = tab.hcLast;
  const body = spOpen('http', tab, `Response: ${ex && ex.name ? ex.name : baseName(tab.path)}`);
  body.className = 'sp-body hc-body';
  if (!ex) { body.innerHTML = '<div class="hc-empty">Send a request to see its response here.</div>'; return; }
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const reqLine = `${ex.request.method} ${ex.request.url}`;
  if (ex.pending) { body.innerHTML = `<div class="hc-status">Sending...</div><div class="hc-req">${esc(reqLine)}</div>`; return; }
  if (ex.error) { body.innerHTML = `<div class="hc-status hc-err">${esc(ex.error)}</div><div class="hc-req">${esc(reqLine)}</div>`; return; }
  const r = ex.response;
  const cls = r.status < 300 ? 'hc-ok' : r.status < 400 ? 'hc-redirect' : 'hc-err';
  const pretty = hcPretty(r.body, r.headers);
  body.innerHTML = `<div class="hc-status ${cls}"><b>${r.status} ${esc(r.statusText)}</b> <span>${r.ms} ms · ${hcSize(r.size)}</span></div>
    <div class="hc-req">${esc(reqLine)}</div>
    <div class="hc-tabs"><button data-v="body" class="active">Body</button><button data-v="headers">Headers (${r.headers.length})</button><button data-v="request">Request</button><button data-v="raw">Raw</button><span class="tb-spacer"></span><button class="hc-copy" title="Copy the response body">Copy</button></div>
    <pre class="hc-view" data-v="body"></pre><table class="hc-view hidden var-table" data-v="headers"></table><pre class="hc-view hidden" data-v="request"></pre><pre class="hc-view hidden" data-v="raw"></pre>`;
  const view = (v) => body.querySelector(`.hc-view[data-v="${v}"]`);
  view('body').textContent = pretty.text;
  if (pretty.lang !== 'plaintext' && pretty.text.length < 300000) { try { view('body').innerHTML = await monacoRef.editor.colorize(pretty.text, pretty.lang, { tabSize: 2 }); } catch {} }
  for (const [k, v] of r.headers) { const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td></td>'; tr.children[0].textContent = k; tr.children[1].textContent = v; view('headers').appendChild(tr); }
  view('request').textContent = `${reqLine}\n${ex.request.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${ex.request.body ? `\n\n${ex.request.body}` : ''}`;
  view('raw').textContent = `HTTP/${r.httpVersion} ${r.status} ${r.statusText}\n${r.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${r.body}`;
  body.querySelectorAll('.hc-tabs button[data-v]').forEach((b) => { b.onclick = () => {
    body.querySelectorAll('.hc-tabs button[data-v]').forEach((x) => x.classList.toggle('active', x === b));
    body.querySelectorAll('.hc-view').forEach((x) => x.classList.toggle('hidden', x.dataset.v !== b.dataset.v));
  }; });
  body.querySelector('.hc-copy').onclick = () => { navigator.clipboard.writeText(r.body).catch(() => {}); status('Response body copied'); };
}

// ---------------- the editor: language, Send request lenses, environment picker ----------------
const hcIsHttp = (tab) => tab && /\.(http|rest)$/i.test(tab.path);
async function hcRenderEnvBar(tab = state.active) {
  const bar = $('#hcBar');
  if (!hcIsHttp(tab)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const envs = await hcEnvFiles(tab.path);
  const names = hcEnvNames(envs);
  const sel = $('#hcEnv');
  const chosen = hcChosenEnv(tab.path);
  sel.innerHTML = '<option value="">No environment</option>';
  for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
  sel.value = names.includes(chosen) ? chosen : '';
  sel.title = envs ? `Environments from ${envs.file}` : 'No http-client.env.json next to this file or in a parent folder';
}

bus.on('ready', () => {
  const L = monacoRef.languages;
  L.register({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP'] });
  L.setMonarchTokensProvider('http', {
    tokenizer: {
      root: [
        [/^\s*###.*$/, 'comment.doc'],
        [/^\s*(#|\/\/)\s*[@]name\b.*$/, 'annotation'],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^(@[\w.-]+)(\s*=\s*)(.*)$/, ['variable', 'delimiter', 'string']],
        [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s+)/, ['keyword', 'white']],
        [/\{\{[^}]*\}\}/, 'variable'],
        [/^([\w-]+)(\s*:)/, ['attribute.name', 'delimiter']],
        [/HTTP\/[\d.]+/, 'keyword'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number']
      ]
    }
  });
  L.setLanguageConfiguration('http', { comments: { lineComment: '#' }, brackets: [['{', '}'], ['[', ']']], autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }] });
  monacoRef.editor.registerCommand('nova.http.send', (_a, path, line) => { const t = findTab(path); if (t) hcSend(t, line); });
  L.registerCodeLensProvider('http', {
    provideCodeLenses(model) {
      const tab = state.tabs.find((t) => t.model === model);
      if (!tab) return { lenses: [], dispose() {} };
      const lenses = hcParse(model.getValue()).requests.map((r) => ({
        range: new monacoRef.Range(r.line, 1, r.line, 1),
        command: { id: 'nova.http.send', title: `▷ Send request${r.name ? ` (${r.name})` : ''}`, arguments: [tab.path, r.line] }
      }));
      return { lenses, dispose() {} };
    }
  });
  L.registerCompletionItemProvider('http', {
    triggerCharacters: ['{', '$'],
    async provideCompletionItems(model, pos) {
      const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const m = before.match(/\{\{\s*([$\w.-]*)$/);
      if (!m) return { suggestions: [] };
      const tab = state.tabs.find((t) => t.model === model);
      const range = new monacoRef.Range(pos.lineNumber, pos.column - m[1].length, pos.lineNumber, pos.column);
      const parsed = hcParse(model.getValue());
      const envs = tab ? await hcEnvFiles(tab.path) : null;
      const names = new Set([...parsed.vars.map((v) => v.name), ...Object.keys(hcEnvVars(envs, tab ? hcChosenEnv(tab.path) : ''))]);
      const K = L.CompletionItemKind;
      const s = [...names].map((n) => ({ label: n, kind: K.Variable, insertText: n, range }));
      for (const d of ['$guid', '$randomInt 1 100', '$timestamp', '$datetime iso8601', '$localDatetime iso8601', '$processEnv NAME', '$dotenv NAME']) s.push({ label: d, kind: K.Function, insertText: d, range });
      for (const r of parsed.requests.filter((x) => x.name)) s.push({ label: `${r.name}.response.body.$.`, kind: K.Reference, insertText: `${r.name}.response.body.$.`, range });
      return { suggestions: s };
    }
  });
  $('#hcEnv').onchange = (e) => {
    const t = state.active;
    if (!t) return;
    try { localStorage.setItem(hcEnvKey(t.path), e.target.value); } catch {}
    status(e.target.value ? `HTTP environment: ${e.target.value}` : 'No HTTP environment');
  };
  $('#hcSend').onclick = () => commands.httpSendRequest();
  editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Alt | monacoRef.KeyCode.KeyS, () => commands.httpSendRequest());
});
commands.httpSendRequest = () => {
  const t = state.active;
  if (!hcIsHttp(t)) return status('Open a .http file first');
  return hcSend(t, editor.getPosition().lineNumber);
};
const hcActivate = activate;
activate = function (tab) { hcActivate(tab); hcRenderEnvBar(tab); };
bus.on('saved', (tab) => { if (/http-client\.env\.json(\.user)?$/i.test(tab.path) && hcIsHttp(state.active)) hcRenderEnvBar(); });
