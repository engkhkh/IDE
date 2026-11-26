// Nova IDE - spell checker (Visual Studio 2022+ has one): words in comments and strings of code, and all words of
// text files (Markdown, .txt), get a dotted underline; Ctrl+. offers the corrections, Ignore, Add to dictionary.
// Identifiers are split (camelCase, snake_case), so "GetOrderTotl" flags "Totl". Edit > Toggle Spell Checker.
'use strict';

const SC = { timers: new Map(), ignored: new Set(), on: true };
const SC_TEXT_LANGS = new Set(['markdown', 'plaintext']);
// words every programmer writes that a general dictionary lacks
const SC_TECH = new Set(('api apis async await bool boolean config const csproj csharp dotnet enum enums env http https json jsonpath ' +
  'localhost middleware namespace nuget npm nullable param params repo runtime sln stdin stdout stderr struct sql ' +
  'typeof ui uri url urls utf xml yaml yml dto dtos guid guids id ids impl init lang lsp mutex oauth regex ' +
  'serializer src todo uuid webhook workflow app args cli cpu ctor dict dir dirs eol func lambda linq ' +
  'readonly rect refactor util utils kubernetes docker dockerfile postgres mongo redis github gitlab').split(' '));

// the words to check in a piece of text: split identifiers, skip URLs, paths, hex, all-caps short words
function scWords(text) {
  const out = [];
  const cleaned = String(text).replace(/\b(?:https?|ftp|file):\/\/\S+/g, (m) => ' '.repeat(m.length))
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, (m) => ' '.repeat(m.length))
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, (m) => ' '.repeat(m.length));
  const re = /[A-Za-z][A-Za-z']*[A-Za-z]|[A-Za-z]/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const token = m[0];
    // a word glued to digits or underscores belongs to an identifier: still split it
    const before = cleaned[m.index - 1] || '';
    const after = cleaned[m.index + token.length] || '';
    if (/[0-9_]/.test(before) || /[0-9_]/.test(after)) { if (token.length < 4) continue; }
    // camelCase / PascalCase pieces
    for (const p of token.replace(/'s$/, '').matchAll(/[A-Z]{2,}(?=[A-Z][a-z]|$|')|[A-Z]?[a-z']+|[A-Z]+/g)) {
      const w = p[0].replace(/^'+|'+$/g, '');
      if (w.length < 3 || /^[A-Z]{2,5}$/.test(w)) continue; // short words, acronyms
      out.push({ word: w, index: m.index + p.index });
    }
  }
  return out;
}
// ranges of the model to check: comments and strings (from the editor's own tokenizer), or everything in text files
function scRegions(model) {
  const lang = model.getLanguageId();
  const lines = model.getLinesContent();
  if (SC_TEXT_LANGS.has(lang)) {
    let inFence = false;
    return lines.map((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return null; }
      return inFence ? null : { line: i + 1, start: 0, text: l.replace(/`[^`]*`/g, (x) => ' '.repeat(x.length)).replace(/\]\([^)]*\)/g, (x) => ' '.repeat(x.length)) };
    }).filter(Boolean);
  }
  const out = [];
  let tokens;
  try { tokens = monacoRef.editor.tokenize(model.getValue(), lang); } catch { return out; }
  tokens.forEach((lineTokens, i) => {
    const text = lines[i] || '';
    lineTokens.forEach((t, k) => {
      if (!/comment|string/.test(t.type) || /regexp|escape/.test(t.type)) return;
      const end = k + 1 < lineTokens.length ? lineTokens[k + 1].offset : text.length;
      out.push({ line: i + 1, start: t.offset, text: text.slice(t.offset, end), string: /string/.test(t.type) });
    });
  });
  return out;
}
async function scCheck(tab) {
  if (!tab || !tab.model || tab.model.isDisposed()) return;
  const model = tab.model;
  if (!SC.on || state.settings.spellCheck === false || model.getLineCount() > 20000) { monacoRef.editor.setModelMarkers(model, 'spell', []); return; }
  const found = [];
  for (const r of scRegions(model)) {
    // a string that looks like code (a format, a route, an identifier) is not prose
    if (r.string && !/\s/.test(r.text.replace(/^["'@$`]+|["'`]+$/g, '').trim())) continue;
    for (const w of scWords(r.text)) found.push({ ...w, line: r.line, col: r.start + w.index + 1 });
  }
  const unique = [...new Set(found.map((f) => f.word))].filter((w) => !SC_TECH.has(w.toLowerCase()) && !SC.ignored.has(w));
  const res = unique.length ? await api.spell.check(unique, [...(tab.scExtra || [])]) : { wrong: [] };
  if (model.isDisposed()) return;
  if (res.error) { monacoRef.editor.setModelMarkers(model, 'spell', []); return; }
  const wrong = new Set(res.wrong);
  tab.scLast = found.filter((f) => wrong.has(f.word));
  monacoRef.editor.setModelMarkers(model, 'spell', tab.scLast.map((f) => ({
    severity: monacoRef.MarkerSeverity.Info, message: `Spelling: "${f.word}" is not in the dictionary`, source: 'Spell Checker', code: 'spell',
    startLineNumber: f.line, startColumn: f.col, endLineNumber: f.line, endColumn: f.col + f.word.length, tags: []
  })));
}
function scSchedule(tab, ms = 600) {
  clearTimeout(SC.timers.get(tab));
  SC.timers.set(tab, setTimeout(() => { SC.timers.delete(tab); scCheck(tab); }, ms));
}
const scRecheckAll = () => { for (const t of state.tabs) scSchedule(t, 50); };

// .editorconfig spelling_exclusion_path: a file of extra words for this code base (Visual Studio's setting)
async function scExtraWords(tab) {
  const p = tab.editorConfig && tab.editorConfig.spelling_exclusion_path;
  if (!p) return [];
  const file = /^([A-Za-z]:|[\\/])/.test(p) ? p : `${dirName(tab.path)}${sep()}${p}`;
  try { return (await api.readFile(file)).split(/\r?\n/).map((w) => w.trim()).filter(Boolean); } catch { return []; }
}

Object.assign(commands, {
  toggleSpellCheck: () => { SC.on = !SC.on; scRecheckAll(); status(`Spell checker ${SC.on ? 'on' : 'off'}`); }
});
bus.on('ready', () => {
  monacoRef.editor.registerCommand('nova.spell.replace', (_a, uri, range, text) => {
    const model = monacoRef.editor.getModel(uri);
    if (model) model.pushEditOperations([], [{ range, text }], () => null);
  });
  monacoRef.editor.registerCommand('nova.spell.add', async (_a, word) => { await api.spell.add(word); scRecheckAll(); status(`"${word}" added to your dictionary`); });
  monacoRef.editor.registerCommand('nova.spell.ignore', (_a, word) => { SC.ignored.add(word); scRecheckAll(); status(`Ignoring "${word}" in this session`); });
  monacoRef.languages.registerCodeActionProvider('*', {
    async provideCodeActions(model, range, context) {
      const marks = context.markers.filter((m) => m.owner === 'spell' || m.source === 'Spell Checker');
      const actions = [];
      for (const m of marks) {
        const word = model.getValueInRange(m);
        const r = { startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn };
        for (const s of await api.spell.suggest(word)) {
          actions.push({ title: `Change to "${s}"`, kind: 'quickfix', diagnostics: [m], isPreferred: !actions.length, edit: { edits: [{ resource: model.uri, textEdit: { range: r, text: s }, versionId: model.getVersionId() }] } });
        }
        actions.push({ title: `Ignore "${word}"`, kind: 'quickfix', diagnostics: [m], command: { id: 'nova.spell.ignore', title: 'Ignore', arguments: [word] } });
        actions.push({ title: `Add "${word}" to dictionary`, kind: 'quickfix', diagnostics: [m], command: { id: 'nova.spell.add', title: 'Add', arguments: [word] } });
      }
      return { actions, dispose() {} };
    }
  });
});
bus.on('tabOpened', async (tab) => {
  tab.model.onDidChangeContent(() => scSchedule(tab));
  setTimeout(async () => { tab.scExtra = await scExtraWords(tab); scSchedule(tab, 0); }, 300);
});
bus.on('settings', () => scRecheckAll());
