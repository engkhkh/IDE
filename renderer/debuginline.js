// Nova IDE - values where you read them (Passenger / Rider / VS Code's inline values): while the program is paused,
// the lines of the current method up to the stopped line show the values of the locals they use, at the line end.
// Return values the debugger reports (debugpy "(return) f", netcoredbg "$ReturnValue") show at the call line.
'use strict';

const DI = { tab: null, decos: [] };
function diClear() { if (DI.tab && !DI.tab.model.isDisposed()) DI.tab.model.deltaDecorations(DI.decos, []); DI.decos = []; DI.tab = null; }
const diShort = (v) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' '); return t.length > 40 ? `${t.slice(0, 39)}…` : t; };

// which locals each line reads: identifiers outside strings and comments; lines from the method start to `line`
function diLineValues(lines, fromLine, toLine, vars) {
  const byName = new Map(vars.map((v) => [v.name, v.value]));
  const out = [];
  for (let ln = fromLine; ln <= toLine; ln++) {
    const code = (lines[ln - 1] || '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""').replace(/\/\/.*$|#(?!\w).*$/, '');
    const seen = [];
    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) if (byName.has(m[0]) && !seen.includes(m[0])) seen.push(m[0]);
    if (seen.length) out.push({ line: ln, text: seen.slice(0, 4).map((n) => `${n} = ${diShort(byName.get(n))}`).join(', ') });
  }
  return out;
}
// the method's first line: the nearest line above that opens a function (C#, JS/TS, Python)
function diMethodStart(lines, line) {
  for (let ln = line; ln >= 1 && line - ln < 200; ln--) {
    const t = lines[ln - 1] || '';
    if (/^\s*(def |async def |function\b|async function\b|(public|private|protected|internal|static|async|override|virtual)\b[^;=]*\(|[\w<>[\],\s]+\s+\w+\s*\([^;]*\)\s*(\{|=>)?\s*$)/.test(t)) return ln;
  }
  return Math.max(1, line - 30);
}

async function diShow() {
  diClear();
  if (state.settings.debugInlineValues === false || !DBG.stopped || !DBG.focus) return;
  const f = DBG.frames[DBG.frameIndex];
  if (!f || !f.source || !f.source.path) return;
  const tab = findTab(f.source.path);
  if (!tab) return;
  const s = DBG.focus;
  let vars = [];
  try {
    const scopes = (await s.request('scopes', { frameId: f.id })).scopes || [];
    for (const sc of scopes.filter((x) => !x.expensive && !/global/i.test(x.name)).slice(0, 3)) vars.push(...((await s.request('variables', { variablesReference: sc.variablesReference })).variables || []));
  } catch { return; }
  if (!DBG.stopped || DBG.frames[DBG.frameIndex] !== f) return;
  const ret = vars.find((v) => /^\(return\)|^\$ReturnValue|^\[return value\]/i.test(v.name));
  vars = vars.filter((v) => /^[A-Za-z_$][\w$]*$/.test(v.name) && v.name !== 'this' && v.name !== 'self');
  const lines = tab.model.getLinesContent();
  const items = diLineValues(lines, diMethodStart(lines, f.line), f.line, vars);
  if (ret) items.push({ line: f.line, text: `${ret.name.replace(/^\(return\)\s*/, '').replace(/^\$ReturnValue/, 'returned')} ⟵ ${diShort(ret.value)}`, ret: true });
  DI.tab = tab;
  DI.decos = tab.model.deltaDecorations([], items.map((it) => {
    const col = tab.model.getLineMaxColumn(it.line);
    return { range: new monacoRef.Range(it.line, col, it.line, col), options: { showIfCollapsed: true, after: { content: `   ${it.text}`, inlineClassName: it.ret ? 'di-value di-return' : 'di-value' } } };
  }));
  DI.items = items;
}

bus.on('debugEvent', (e) => { if (e.kind === 'run') diClear(); });
bus.on('debugEnded', () => diClear());
const diSelectFrame = selectFrame;
selectFrame = async function (i, reveal) { await diSelectFrame(i, reveal); if (DBG.stopped) diShow(); }; // eslint-disable-line no-func-assign
