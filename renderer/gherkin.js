// Nova IDE - Reqnroll / SpecFlow: .feature files get Gherkin colors, each step is matched to its C# binding
// ([Given("...")], [When], [Then], [StepDefinition]; regular expressions or Cucumber expressions like {int},
// {string}), F12 goes to the binding, steps without one are underlined, and step texts are completed.
'use strict';

const GK = { bindings: [], timer: null };
LANGS.feature = 'gherkin';

// a binding's text -> RegExp (regex if it looks like one, else a Cucumber expression)
function gkBindingRegex(text) {
  const isRegex = /^\^|\$$|\(\.\*\)|\(\.\+\)|\\d|\\w|\(\?|\[\^/.test(text);
  if (isRegex) return new RegExp(`^${text.replace(/^\^/, '').replace(/\$$/, '')}$`, 'i');
  let src = '';
  for (const part of text.split(/(\{[a-zA-Z]*\}|\([^)]*\)|\S+\/\S+)/)) {
    if (!part) continue;
    const m = part.match(/^\{([a-zA-Z]*)\}$/);
    if (m) src += ({ int: '(-?\\d+)', float: '(-?\\d*\\.?\\d+)', double: '(-?\\d*\\.?\\d+)', decimal: '(-?\\d*\\.?\\d+)', long: '(-?\\d+)', string: '("[^"]*"|\'[^\']*\')', word: '([^\\s]+)', '': '(.*)' })[m[1]] || '(.*)';
    else if (/^\([^)]*\)$/.test(part)) src += `(?:${part.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?`;
    else if (/^\S+\/\S+$/.test(part) && !/[{}]/.test(part)) src += `(?:${part.split('/').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
    else src += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'i');
}
// the steps of a feature file: keyword kind (And/But take the one before), text, line
function gkSteps(text) {
  const out = [];
  let last = 'Given';
  String(text).split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^(\s*)(Given|When|Then|And|But|\*)\s+(.*?)\s*$/);
    if (!m) { if (/^\s*(Scenario|Example|Background|Rule|Scenario Outline|Scenario Template)\b/.test(l)) last = 'Given'; return; }
    const kind = /^(And|But|\*)$/.test(m[2]) ? last : m[2];
    last = kind;
    out.push({ kind, keyword: m[2], text: m[3], line: i + 1, col: m[1].length + m[2].length + 2 });
  });
  return out;
}
function gkMatch(step, bindings = GK.bindings) {
  // outline steps: <placeholders> can be anything
  const texts = /<[^>]+>/.test(step.text) ? ['1', 'x', '"x"'].map((v) => step.text.replace(/<[^>]+>/g, v)) : [step.text];
  return bindings.find((b) => (b.kind === step.kind || b.kind === 'StepDefinition') && texts.some((t) => { try { return b.re.test(t); } catch { return false; } }));
}
async function gkScan() {
  if (!state.root) { GK.bindings = []; return; }
  const res = await api.searchInFiles(state.root, '\\[\\s*(Given|When|Then|StepDefinition)(?:Attribute)?\\s*\\(\\s*(@?)"((?:[^"\\\\]|\\\\.|"")*)"', { regex: true, caseSensitive: true, groups: true, include: '*.cs', limit: 5000 });
  GK.bindings = (Array.isArray(res) ? res : []).map((r) => {
    // C# string literal -> its text: @"..." doubles quotes, "..." escapes with backslashes
    const text = r.groups[2] ? r.groups[3].replace(/""/g, '"') : r.groups[3].replace(/\\(.)/g, '$1');
    let re;
    try { re = gkBindingRegex(text); } catch { re = /$^/; }
    return { kind: r.groups[1], text, re, file: r.file, line: r.line };
  });
  for (const t of state.tabs) if (t.model.getLanguageId() === 'gherkin') gkCheck(t);
  return GK.bindings;
}
function gkCheck(tab) {
  const marks = gkSteps(tab.model.getValue()).filter((s) => !gkMatch(s)).map((s) => ({
    severity: monacoRef.MarkerSeverity.Warning, message: `No step definition found for this step: add a [${s.kind}("${s.text.replace(/"/g, '\\"')}")] binding`, source: 'Reqnroll',
    startLineNumber: s.line, startColumn: s.col, endLineNumber: s.line, endColumn: s.col + s.text.length
  }));
  monacoRef.editor.setModelMarkers(tab.model, 'gherkin', marks);
  tab.gkUndefined = marks.length;
}

bus.on('ready', () => {
  const L = monacoRef.languages;
  L.register({ id: 'gherkin', extensions: ['.feature'], aliases: ['Gherkin', 'Reqnroll', 'SpecFlow'] });
  L.setMonarchTokensProvider('gherkin', { tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'], [/^\s*[@]\S+/, 'annotation'], [/@\S+/, 'annotation'],
      [/^\s*(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):/, 'keyword'],
      [/^\s*(Given|When|Then|And|But|\*)(?=\s)/, 'keyword.step'], [/^\s*"""/, { token: 'string', next: '@doc' }],
      [/<[^>]+>/, 'variable'], [/"[^"]*"/, 'string'], [/'[^']*'/, 'string'], [/\b-?\d+(\.\d+)?\b/, 'number'], [/\|/, 'delimiter']
    ],
    doc: [[/^\s*"""/, { token: 'string', next: '@pop' }], [/.*$/, 'string']]
  } });
  L.setLanguageConfiguration('gherkin', { comments: { lineComment: '#' }, autoClosingPairs: [{ open: '"', close: '"' }, { open: '<', close: '>' }] });
  L.registerDefinitionProvider('gherkin', { provideDefinition(model, pos) {
    const s = gkSteps(model.getValue()).find((x) => x.line === pos.lineNumber);
    const b = s && gkMatch(s);
    return b ? [{ uri: monacoRef.Uri.file(b.file), range: new monacoRef.Range(b.line, 1, b.line, 1) }] : [];
  } });
  L.registerCompletionItemProvider('gherkin', { triggerCharacters: [' '], provideCompletionItems(model, pos) {
    const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const m = before.match(/^\s*(Given|When|Then|And|But)\s+(.*)$/);
    if (!m) return { suggestions: [] };
    const kind = /^(And|But)$/.test(m[1]) ? ([...gkSteps(model.getValueInRange(new monacoRef.Range(1, 1, pos.lineNumber, 1)))].pop() || { kind: 'Given' }).kind : m[1];
    const range = new monacoRef.Range(pos.lineNumber, pos.column - m[2].length, pos.lineNumber, pos.column);
    return { suggestions: GK.bindings.filter((b) => b.kind === kind || b.kind === 'StepDefinition').map((b) => ({
      label: b.text, kind: L.CompletionItemKind.Function, detail: `${baseName(b.file)}:${b.line}`, range,
      insertText: b.text.replace(/^\^|\$$/g, '').replace(/\{int\}|\(-?\\d\+\)|\(\\d\+\)/g, '0').replace(/\{string\}|"\(\.\*\)"|"\(\[\^"\]\*\)"/g, '""').replace(/\{word\}|\{\}|\(\.\*\)/g, 'x')
    })) };
  } });
});
bus.on('folder', () => { GK.bindings = []; setTimeout(gkScan, 500); });
bus.on('saved', (tab) => { if (/\.cs$/i.test(tab.path)) { clearTimeout(GK.timer); GK.timer = setTimeout(gkScan, 300); } });
bus.on('tabOpened', (tab) => {
  if (!/\.feature$/i.test(tab.path)) return;
  if (!GK.bindings.length) gkScan(); else gkCheck(tab);
  tab.model.onDidChangeContent(() => { clearTimeout(tab.gkTimer); tab.gkTimer = setTimeout(() => gkCheck(tab), 300); });
});
commands.reqnrollRescan = () => gkScan();
