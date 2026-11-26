// Nova IDE - EditorConfig (https://editorconfig.org), which Visual Studio, Rider and VS Code all follow:
// indent_style, indent_size, tab_width, end_of_line, trim_trailing_whitespace, insert_final_newline.
// The .editorconfig files from the file's folder up to the first "root = true" one are combined; nearer wins.
'use strict';

const EC = { cache: new Map() }; // .editorconfig path -> parsed sections (null = no file)

function ecParse(text) {
  const out = { root: false, sections: [] };
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const sec = line.match(/^\[(.*)\]$/);
    if (sec) { cur = { glob: sec[1], props: {} }; out.sections.push(cur); continue; }
    const kv = line.match(/^([^=:]+?)\s*[=:]\s*(.*?)\s*(?:\s[#;].*)?$/);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].trim();
    if (!cur) { if (k === 'root') out.root = v.toLowerCase() === 'true'; continue; }
    cur.props[k] = /^(true|false|unset)$/i.test(v) || /^(indent_style|end_of_line|charset)$/.test(k) ? v.toLowerCase() : v;
  }
  return out;
}

// EditorConfig globs: * (not /), ** (anything), ?, [abc], [!abc], {a,b}, {1..3}
function ecGlobToRegex(glob) {
  let re = '';
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i += 2; continue; } re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) re += '\\[';
      else { const body = glob.slice(i + 1, end); re += `[${body[0] === '!' ? '^' + body.slice(1) : body}]`; i = end; }
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      const body = end > 0 ? glob.slice(i + 1, end) : '';
      const range = body.match(/^(-?\d+)\.\.(-?\d+)$/);
      if (range) { const [a, b] = [+range[1], +range[2]].sort((x, y) => x - y); re += `(?:${Array.from({ length: b - a + 1 }, (_, n) => a + n).join('|')})`; i = end; }
      else if (end > 0 && body.includes(',')) { re += '(?:'; braces++; }
      else re += '\\{';
    } else if (c === ',' && braces) re += '|';
    else if (c === '}' && braces) { re += ')'; braces--; }
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  return re;
}
// does a section pattern apply to the file? (relative to the folder of the .editorconfig)
function ecMatches(glob, relPath) {
  const rel = relPath.replace(/\\/g, '/');
  let g = glob;
  if (!g.includes('/')) g = `**/${g}`; // "*.cs" matches at any depth
  else if (g.startsWith('/')) g = g.slice(1);
  try { return new RegExp(`^${ecGlobToRegex(g).replace(/^\.\*\//, '(?:.*/)?')}$`).test(rel); } catch { return false; }
}
// files: [{ dir, parsed }] from the nearest folder outwards
function ecProps(files, filePath) {
  const props = {};
  // outermost first, so nearer files (and later sections) win
  for (const { dir, parsed } of [...files].reverse()) {
    const rel = filePath.slice(dir.length).replace(/^[\\/]/, '');
    for (const s of parsed.sections) if (ecMatches(s.glob, rel)) Object.assign(props, s.props);
  }
  for (const [k, v] of Object.entries(props)) if (v === 'unset') delete props[k];
  if (props.indent_style === 'tab' && !props.indent_size) props.indent_size = 'tab';
  if (props.indent_size === 'tab' && props.tab_width) props.indent_size = props.tab_width;
  if (props.indent_size && props.indent_size !== 'tab' && !props.tab_width) props.tab_width = props.indent_size;
  return props;
}

async function ecReadFile(file) {
  if (EC.cache.has(file)) return EC.cache.get(file);
  let parsed = null;
  try { parsed = ecParse(await api.readFile(file)); } catch {}
  EC.cache.set(file, parsed);
  return parsed;
}
async function ecFor(filePath) {
  const files = [];
  let dir = dirName(filePath);
  for (let n = 0; n < 40 && dir; n++) {
    const parsed = await ecReadFile(`${dir}${sep()}.editorconfig`);
    if (parsed) { files.push({ dir, parsed }); if (parsed.root) break; }
    const up = dirName(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return files.length ? ecProps(files, filePath) : {};
}

async function ecApply(tab) {
  if (!tab || !tab.model || state.settings.editorConfig === false) return;
  const p = await ecFor(tab.path);
  tab.editorConfig = p;
  const opts = {};
  if (p.indent_style === 'space' || p.indent_style === 'tab') opts.insertSpaces = p.indent_style === 'space';
  const size = parseInt(p.indent_size === 'tab' ? p.tab_width : p.indent_size, 10);
  if (size > 0) { opts.tabSize = size; opts.indentSize = size; }
  if (Object.keys(opts).length) tab.model.updateOptions(opts);
  if (p.end_of_line === 'lf' || p.end_of_line === 'crlf') tab.model.pushEOL(p.end_of_line === 'lf' ? monacoRef.editor.EndOfLineSequence.LF : monacoRef.editor.EndOfLineSequence.CRLF);
  if (tab === state.active) ecStatus(tab);
}
function ecStatus(tab) {
  const el = $('#stEditorConfig');
  if (!el) return;
  const p = tab && tab.editorConfig;
  const on = p && Object.keys(p).length;
  el.classList.toggle('hidden', !on);
  if (on) el.title = `EditorConfig: ${Object.entries(p).map(([k, v]) => `${k} = ${v}`).join(', ')}`;
}

// on save: trim trailing whitespace / add the final newline, as edits (so Undo brings them back)
function ecBeforeSave(tab) {
  const p = tab.editorConfig;
  if (!p || state.settings.editorConfig === false) return;
  const m = tab.model;
  const edits = [];
  if (p.trim_trailing_whitespace === 'true') {
    for (let ln = 1; ln <= m.getLineCount(); ln++) {
      const text = m.getLineContent(ln);
      const t = text.replace(/[ \t]+$/, '');
      if (t.length !== text.length) edits.push({ range: new monacoRef.Range(ln, t.length + 1, ln, text.length + 1), text: '' });
    }
  }
  const last = m.getLineCount();
  if (p.insert_final_newline === 'true' && m.getLineContent(last) !== '') edits.push({ range: new monacoRef.Range(last, m.getLineMaxColumn(last), last, m.getLineMaxColumn(last)), text: m.getEOL() });
  else if (p.insert_final_newline === 'false') {
    let ln = last;
    while (ln > 1 && m.getLineContent(ln) === '') ln--;
    if (ln < last) edits.push({ range: new monacoRef.Range(ln, m.getLineMaxColumn(ln), last, 1), text: '' });
  }
  // its own Undo step, apart from your typing
  if (edits.length) { m.pushStackElement(); m.pushEditOperations([], edits, () => null); m.pushStackElement(); }
}

const ecSaveTab = saveTab;
saveTab = async function (tab = state.active) {
  if (tab) ecBeforeSave(tab);
  return ecSaveTab(tab);
};
bus.on('tabOpened', (tab) => ecApply(tab));
bus.on('settings', () => { for (const t of state.tabs) ecApply(t); });
bus.on('folder', () => EC.cache.clear());
// an edited .editorconfig takes effect at once
bus.on('saved', (tab) => {
  if (baseName(tab.path) !== '.editorconfig') return;
  EC.cache.clear();
  for (const t of state.tabs) ecApply(t);
});
const ecActivate = activate;
activate = function (tab) { ecActivate(tab); ecStatus(tab); };
