// Nova IDE - AI assistant: chat with a model about your code, streamed into the AI Chat window.
// Providers: Anthropic (Claude, Messages API), any OpenAI-compatible endpoint (OpenAI, Azure OpenAI's /v1,
// LM Studio, vLLM...) and Ollama on this machine (its OpenAI-compatible /v1). Bring your own key: it is kept
// encrypted with the OS (Electron safeStorage), never in settings.json.
'use strict';

const fsp = require('fs/promises');
const path = require('path');

let app = null;
const running = new Map(); // id -> AbortController
const DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' }
};

const keyFile = () => path.join(app.getPath('userData'), 'ai-keys.json');
function safe() { try { const { safeStorage } = require('electron'); return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null; } catch { return null; } }
async function readKeys() { try { return JSON.parse(await fsp.readFile(keyFile(), 'utf8')); } catch { return {}; } }
async function setKey(provider, key) {
  const all = await readKeys();
  if (!key) delete all[provider];
  else { const s = safe(); all[provider] = s ? { enc: 'safe', data: s.encryptString(key).toString('base64') } : { enc: 'b64', data: Buffer.from(key).toString('base64') }; }
  await fsp.mkdir(path.dirname(keyFile()), { recursive: true });
  await fsp.writeFile(keyFile(), JSON.stringify(all, null, 2));
  return true;
}
async function getKey(provider) {
  const a = (await readKeys())[provider];
  if (a) {
    try {
      if (a.enc === 'safe') { const s = safe(); if (s) return s.decryptString(Buffer.from(a.data, 'base64')); }
      if (a.enc === 'b64') return Buffer.from(a.data, 'base64').toString();
    } catch {}
  }
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || null;
  if (provider === 'openai') return process.env.OPENAI_API_KEY || null;
  return null;
}

function config(settings) {
  const provider = DEFAULTS[settings.aiProvider] ? settings.aiProvider : 'anthropic';
  return { provider, baseUrl: (settings.aiBaseUrl || DEFAULTS[provider].baseUrl).replace(/\/+$/, ''), model: settings.aiModel || DEFAULTS[provider].model, maxTokens: settings.aiMaxTokens || 4096 };
}

// the request for each protocol: { url, headers, body }
function buildRequest(cfg, key, system, messages) {
  if (cfg.provider === 'anthropic') {
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': key || '', 'anthropic-version': '2023-06-01' },
      body: { model: cfg.model, max_tokens: cfg.maxTokens, system, messages, stream: true }
    };
  }
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return { url: `${cfg.baseUrl}/chat/completions`, headers, body: { model: cfg.model, messages: [{ role: 'system', content: system }, ...messages], stream: true } };
}
// one Server-Sent Events "data:" payload -> { text } | { error } | { done }
function parseEvent(provider, data) {
  if (data === '[DONE]') return { done: true };
  let j;
  try { j = JSON.parse(data); } catch { return {}; }
  if (j.error) return { error: j.error.message || JSON.stringify(j.error) };
  if (provider === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') return { text: j.delta.text };
    if (j.type === 'message_stop') return { done: true };
    return {};
  }
  const c = j.choices && j.choices[0];
  if (c && c.delta && typeof c.delta.content === 'string') return { text: c.delta.content, done: !!c.finish_reason };
  if (c && c.finish_reason) return { done: true };
  return {};
}

async function chat(id, req, settings, onText) {
  const cfg = config(settings);
  const key = cfg.provider === 'ollama' ? await getKey('ollama') : await getKey(cfg.provider);
  if (!key && cfg.provider === 'anthropic') return { error: 'No Anthropic API key: AI Chat > ⚙ > enter your key (or set ANTHROPIC_API_KEY)' };
  if (!key && cfg.provider === 'openai' && /api\.openai\.com/.test(cfg.baseUrl)) return { error: 'No OpenAI API key: AI Chat > ⚙ > enter your key (or set OPENAI_API_KEY)' };
  const r = buildRequest(cfg, key, req.system, req.messages);
  const ctl = new AbortController();
  running.set(id, ctl);
  let res;
  try {
    res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: ctl.signal });
  } catch (e) {
    running.delete(id);
    if (e.name === 'AbortError') return { stopped: true };
    return { error: cfg.provider === 'ollama' ? `Could not reach Ollama at ${cfg.baseUrl} (is it running?)` : `Could not reach ${cfg.baseUrl}: ${e.cause ? e.cause.message || e.cause.code : e.message}` };
  }
  if (!res.ok) {
    running.delete(id);
    let msg = `${res.status} ${res.statusText}`;
    try { const j = JSON.parse(await res.text()); msg += `: ${(j.error && (j.error.message || j.error)) || JSON.stringify(j)}`; } catch {}
    return { error: msg };
  }
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const ev = parseEvent(cfg.provider, line.slice(5).trim());
        if (ev.error) { running.delete(id); return { error: ev.error, text: full }; }
        if (ev.text) { full += ev.text; onText(ev.text); }
      }
    }
  } catch (e) {
    running.delete(id);
    if (e.name === 'AbortError') return { stopped: true, text: full };
    return { error: e.message, text: full };
  }
  running.delete(id);
  return { text: full, model: cfg.model, provider: cfg.provider };
}

module.exports = {
  buildRequest, parseEvent, config, DEFAULTS,
  register({ ipcMain, send, app: a }) {
    app = a;
    const settings = () => require('./settings').read();
    ipcMain.handle('ai:chat', async (_e, id, req) => {
      const result = await chat(id, req, await settings(), (text) => send('ai:chunk', { id, text }));
      send('ai:done', { id, ...result });
      return result;
    });
    ipcMain.handle('ai:stop', (_e, id) => { const c = running.get(id); if (c) c.abort(); return !!c; });
    ipcMain.handle('ai:setKey', (_e, provider, key) => setKey(provider, key));
    ipcMain.handle('ai:status', async () => {
      const cfg = config(await settings());
      return { ...cfg, hasKey: !!(await getKey(cfg.provider)), defaults: DEFAULTS };
    });
  },
  dispose() { for (const c of running.values()) c.abort(); running.clear(); }
};
