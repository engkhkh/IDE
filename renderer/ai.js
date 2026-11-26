// Nova IDE - AI Chat window (like Copilot Chat in Visual Studio / JetBrains AI in Rider): ask about your code,
// with the active file or selection as context; answers stream in as Markdown with Insert / Copy on code blocks.
// Editor context menu: AI: Explain / Fix / Write Tests / Document the selection. Ctrl+Alt+Shift+I opens the chat.
'use strict';

const AI = { messages: [], busy: null, seq: 0, status: null };

const aiSystem = () => [
  'You are the AI assistant inside Nova IDE, a Visual Studio-style IDE. You help a developer with the code they are working on.',
  'Answer concisely. Use Markdown. Put code in fenced blocks with the language, e.g. ```csharp. When you change code, show the full changed part.',
  state.root ? `The open folder is ${baseName(state.root)}.` : ''
].filter(Boolean).join('\n');

// what the model gets about the editor: the selection, else the active file (trimmed around the cursor)
function aiContext() {
  const tab = state.active;
  if (!tab || !$('#aiUseContext').checked) return '';
  const sel = editor.getSelection();
  const lang = tab.model.getLanguageId();
  const name = baseName(tab.path);
  if (sel && !sel.isEmpty()) return `Selected code from ${name} (lines ${sel.startLineNumber}-${sel.endLineNumber}):\n\`\`\`${lang}\n${tab.model.getValueInRange(sel)}\n\`\`\``;
  const lines = tab.model.getLinesContent();
  const cur = editor.getPosition().lineNumber;
  const from = lines.length > 400 ? Math.max(0, cur - 200) : 0;
  const to = lines.length > 400 ? Math.min(lines.length, from + 400) : lines.length;
  return `Current file ${name}${from || to < lines.length ? ` (lines ${from + 1}-${to} of ${lines.length})` : ''}, cursor on line ${cur}:\n\`\`\`${lang}\n${lines.slice(from, to).join('\n')}\n\`\`\``;
}

function aiAddMessage(role, text) {
  const host = $('#aiMessages');
  const el = document.createElement('div');
  el.className = `ai-msg ai-${role}`;
  host.appendChild(el);
  const m = { role, text, el };
  aiRenderMessage(m);
  return m;
}
function aiRenderMessage(m) {
  if (m.role === 'user') { m.el.textContent = m.shown || m.text; }
  else {
    m.el.innerHTML = mdRender(m.text || (m.pending ? '…' : ''));
    for (const pre of m.el.querySelectorAll('pre.md-code')) {
      const bar = document.createElement('div');
      bar.className = 'ai-code-bar';
      bar.innerHTML = '<button class="ai-insert" title="Insert at the cursor (replaces the selection)">⤵ Insert</button><button class="ai-copy">Copy</button>';
      bar.querySelector('.ai-insert').onclick = () => aiInsert(pre.textContent);
      bar.querySelector('.ai-copy').onclick = () => { navigator.clipboard.writeText(pre.textContent).catch(() => {}); status('Copied'); };
      pre.before(bar);
    }
    if (m.error) { const e = document.createElement('div'); e.className = 'ai-error'; e.textContent = m.error; m.el.appendChild(e); }
  }
  $('#aiMessages').scrollTop = $('#aiMessages').scrollHeight;
}
function aiInsert(code) {
  const tab = state.active;
  if (!tab) return status('Open a file first');
  const sel = editor.getSelection();
  editor.pushUndoStop();
  editor.executeEdits('ai', [{ range: sel, text: code.replace(/\n$/, ''), forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
  status('Inserted the code from AI Chat');
}

async function aiSend(prompt, shown) {
  const text = (prompt || '').trim();
  if (!text || AI.busy) return;
  const ctx = aiContext();
  const user = aiAddMessage('user', ctx ? `${text}\n\n${ctx}` : text);
  user.shown = shown || text;
  aiRenderMessage(user);
  AI.messages.push({ role: 'user', content: user.text });
  const reply = aiAddMessage('assistant', '');
  reply.pending = true;
  aiRenderMessage(reply);
  const id = ++AI.seq;
  AI.busy = { id, reply };
  aiButtons();
  const res = await api.ai.chat(id, { system: aiSystem(), messages: AI.messages.map(({ role, content }) => ({ role, content })) });
  reply.pending = false;
  reply.text = res.text || reply.text;
  if (res.error) { reply.error = res.error; AI.messages.pop(); }
  else AI.messages.push({ role: 'assistant', content: reply.text });
  if (res.stopped) reply.error = '(stopped)';
  aiRenderMessage(reply);
  AI.busy = null;
  aiButtons();
  bus.emit('aiReply', { text: reply.text, error: res.error });
  return res;
}
function aiButtons() {
  $('#aiSend').classList.toggle('hidden', !!AI.busy);
  $('#aiStop').classList.toggle('hidden', !AI.busy);
}
function aiNewChat() { AI.messages = []; $('#aiMessages').innerHTML = ''; aiWelcome(); }
async function aiWelcome() {
  const s = AI.status = await api.ai.status();
  const el = document.createElement('div');
  el.className = 'ai-welcome';
  el.textContent = `${{ anthropic: 'Claude (Anthropic)', openai: 'OpenAI-compatible', ollama: 'Ollama' }[s.provider]} · ${s.model}${s.hasKey || s.provider === 'ollama' ? '' : ' · no API key yet: click ⚙'}`;
  $('#aiMessages').appendChild(el);
  $('#aiModel').textContent = s.model;
}

// ⚙: provider, model, address and key in one dialog
async function aiSettings() {
  const s = await api.ai.status();
  AI.dlgDefaults = s.defaults;
  $('#aiProvider').value = s.provider;
  $('#aiModelIn').value = s.model;
  $('#aiUrl').value = s.baseUrl;
  $('#aiKey').value = '';
  $('#aiKey').placeholder = s.hasKey ? 'saved (leave empty to keep it)' : 'paste your API key';
  aiDlgProvider(false);
  $('#aiDlg').classList.remove('hidden');
  setTimeout(() => focusIfIdle($('#aiModelIn')), 30);
}
function aiDlgProvider(reset = true) {
  const p = $('#aiProvider').value;
  const d = AI.dlgDefaults[p];
  if (reset) { $('#aiModelIn').value = d.model; $('#aiUrl').value = d.baseUrl; }
  $('#aiKeyRow').classList.toggle('hidden', p === 'ollama');
}
async function aiDlgSave() {
  const p = $('#aiProvider').value;
  const d = AI.dlgDefaults[p];
  const url = $('#aiUrl').value.trim();
  await updateSetting({ aiProvider: p, aiModel: $('#aiModelIn').value.trim() || d.model, aiBaseUrl: !url || url === d.baseUrl ? '' : url });
  if ($('#aiKey').value.trim()) await api.ai.setKey(p, $('#aiKey').value.trim());
  $('#aiDlg').classList.add('hidden');
  aiNewChat();
}

const AI_ACTIONS = {
  aiExplain: ['Explain', 'Explain what this code does, step by step.'],
  aiFix: ['Fix', 'Find bugs in this code and fix them. Show the corrected code.'],
  aiTests: ['Write Tests', 'Write unit tests for this code (use the test framework the project uses; xUnit for C# if unsure).'],
  aiDocument: ['Document', 'Add documentation comments (/// XML docs for C#, JSDoc for JavaScript/TypeScript, docstrings for Python) to this code. Show the code with the comments.']
};
function aiShow() { showSide('ai'); setTimeout(() => focusIfIdle($('#aiInput')), 30); }
for (const [cmd, [label, prompt]] of Object.entries(AI_ACTIONS)) {
  commands[cmd] = () => { aiShow(); return aiSend(prompt, `${label}: ${editor.getSelection() && !editor.getSelection().isEmpty() ? 'the selection' : `the file ${state.active ? baseName(state.active.path) : ''}`}`); };
}
Object.assign(commands, { aiChat: () => aiShow(), aiNewChat: () => aiNewChat(), aiSettings: () => aiSettings() });

bus.on('ready', () => {
  $('#aiSend').onclick = () => { const v = $('#aiInput').value; $('#aiInput').value = ''; aiSend(v); };
  $('#aiStop').onclick = () => { if (AI.busy) api.ai.stop(AI.busy.id); };
  $('#aiNew').onclick = () => aiNewChat();
  $('#aiGear').onclick = () => aiSettings();
  $('#aiProvider').onchange = () => aiDlgProvider();
  $('#aiDlgSave').onclick = () => aiDlgSave();
  $('#aiDlgCancel').onclick = () => $('#aiDlg').classList.add('hidden');
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiSend').click(); }
  });
  api.on('ai:chunk', ({ id, text }) => {
    if (!AI.busy || AI.busy.id !== id) return;
    AI.busy.reply.text += text;
    clearTimeout(AI.renderTimer);
    AI.renderTimer = setTimeout(() => { if (AI.busy) aiRenderMessage(AI.busy.reply); }, 40);
  });
  Object.entries(AI_ACTIONS).forEach(([cmd, [label]], i) => editor.addAction({ id: `nova.${cmd}`, label: `AI: ${label}`, contextMenuGroupId: 'y_ai', contextMenuOrder: i, run: () => commands[cmd]() }));
  aiWelcome();
});
