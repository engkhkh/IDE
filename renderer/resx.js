// Nova IDE - .resx resource editor (like Visual Studio's / Passenger's): a grid of Name / Value / Comment over the
// XML, kept in the same document (Ctrl+S saves, Ctrl+Z undoes, "View Code" shows the XML). Non-text resources
// (images, files) are listed read-only. Neighbour culture files (Strings.de.resx...) are shown as extra columns.
'use strict';

const RX = { tab: null, filter: '', cultures: [] };
const rxIsResx = (tab) => tab && /\.resx$/i.test(tab.path);

function rxParse(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return { error: 'The file is not valid XML: fix it in View Code' };
  return {
    doc,
    rows: [...doc.documentElement.children].filter((e) => e.tagName === 'data').map((e) => {
      const child = (n) => [...e.children].find((x) => x.tagName === n);
      return { name: e.getAttribute('name') || '', value: child('value') ? child('value').textContent : '', comment: child('comment') ? child('comment').textContent : '', type: e.getAttribute('type') || '', mimetype: e.getAttribute('mimetype') || '', el: e };
    })
  };
}
const rxEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// edits go into the XML text (so the file keeps its header, schema and order)
function rxSetValue(xml, name, field, value) {
  const re = new RegExp(`(<data\\s[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)([\\s\\S]*?)(</data>)`);
  const m = xml.match(re);
  if (!m) return xml;
  let body = m[2];
  const tag = new RegExp(`<${field}>[\\s\\S]*?</${field}>|<${field}\\s*/>`);
  const indent = (body.match(/\n(\s*)</) || [, '    '])[1];
  if (tag.test(body)) body = value === '' && field === 'comment' ? body.replace(new RegExp(`\\s*<${field}>[\\s\\S]*?</${field}>|\\s*<${field}\\s*/>`), '') : body.replace(tag, `<${field}>${rxEsc(value)}</${field}>`);
  else if (value !== '') body = body.replace(/(\s*)$/, `\n${indent}<${field}>${rxEsc(value)}</${field}>$1`);
  return xml.slice(0, m.index) + m[1] + body + m[3] + xml.slice(m.index + m[0].length);
}
function rxAdd(xml, name, value = '', comment = '') {
  const node = `  <data name="${rxEsc(name)}" xml:space="preserve">\n    <value>${rxEsc(value)}</value>${comment ? `\n    <comment>${rxEsc(comment)}</comment>` : ''}\n  </data>\n`;
  return xml.replace(/(\s*)<\/root>\s*$/, `\n${node}</root>\n`).replace(/\n\n(\s*<data)/, '\n$1');
}
function rxRemove(xml, name) {
  return xml.replace(new RegExp(`[ \\t]*<data\\s[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?</data>[ \\t]*\\r?\\n?`), '');
}
function rxRename(xml, from, to) { return xml.replace(new RegExp(`(<data\\s[^>]*name=")${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`), `$1${rxEsc(to)}$2`); }

function rxEdit(fn) {
  const m = RX.tab.model;
  const next = fn(m.getValue());
  if (next === m.getValue()) return;
  m.pushStackElement();
  m.pushEditOperations([], [{ range: m.getFullModelRange(), text: next }], () => null);
  m.pushStackElement();
}
async function rxCultures(tab) {
  // Strings.resx -> Strings.de.resx, Strings.fr-FR.resx in the same folder
  const base = baseName(tab.path).replace(/\.resx$/i, '');
  if (/\.[a-z]{2}(-[A-Za-z]{2,4})?$/.test(base)) return [];
  const files = await api.ws.listFiles(dirName(tab.path)).catch(() => []);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([a-z]{2}(?:-[A-Za-z]{2,4})?)\\.resx$`, 'i');
  const out = [];
  for (const f of files.filter((x) => samePath(dirName(x), dirName(tab.path)) && re.test(baseName(x)))) {
    const p = rxParse(await api.readFile(f).catch(() => ''));
    out.push({ culture: baseName(f).match(re)[1], file: f, values: new Map((p.rows || []).map((r) => [r.name, r.value])) });
  }
  return out;
}
async function rxRender() {
  const tab = RX.tab;
  const host = $('#rxBody');
  if (!tab) return;
  const p = rxParse(tab.model.getValue());
  $('#rxMsg').textContent = p.error || `${p.rows.length} resource(s)${RX.cultures.length ? ` · cultures: ${RX.cultures.map((c) => c.culture).join(', ')}` : ''}`;
  host.innerHTML = '';
  if (p.error) return;
  $('#rxHead').innerHTML = `<tr><th>Name</th><th>Value</th>${RX.cultures.map((c) => `<th>${rxEsc(c.culture)}</th>`).join('')}<th>Comment</th><th></th></tr>`;
  const q = RX.filter.toLowerCase();
  for (const r of p.rows.filter((x) => !q || `${x.name} ${x.value} ${x.comment}`.toLowerCase().includes(q))) {
    const tr = document.createElement('tr');
    const text = !r.type || /System\.String/.test(r.type);
    const cell = (field, value, editable) => {
      const td = document.createElement('td');
      if (!editable) { td.textContent = value; td.className = 'dlg-desc'; return td; }
      const ta = document.createElement(field === 'name' ? 'input' : 'textarea');
      ta.value = value; ta.spellcheck = field !== 'name'; ta.className = `rx-${field}`;
      if (field !== 'name') ta.rows = Math.min(4, value.split('\n').length);
      ta.onchange = () => {
        if (field === 'name') { if (!ta.value.trim() || p.rows.some((x) => x !== r && x.name === ta.value.trim())) { status('Names must be unique and not empty'); ta.value = r.name; return; } rxEdit((x) => rxRename(x, r.name, ta.value.trim())); }
        else rxEdit((x) => rxSetValue(x, r.name, field, ta.value));
        rxRender();
      };
      td.appendChild(ta);
      return td;
    };
    tr.append(cell('name', r.name, true), cell('value', text ? r.value : `(${(r.type.split(',')[0] || r.mimetype).replace(/^System\./, '')}) ${r.value.slice(0, 60)}`, text));
    for (const c of RX.cultures) { const td = document.createElement('td'); td.textContent = c.values.get(r.name) ?? ''; td.className = c.values.has(r.name) ? '' : 'rx-missing'; if (!c.values.has(r.name)) td.textContent = '(missing)'; tr.appendChild(td); }
    tr.append(cell('comment', r.comment, true));
    const del = document.createElement('td');
    del.innerHTML = '<button class="git-mini" title="Remove">✕</button>';
    del.firstChild.onclick = () => { rxEdit((x) => rxRemove(x, r.name)); rxRender(); };
    tr.appendChild(del);
    host.appendChild(tr);
  }
}
async function rxShow(tab) {
  RX.tab = tab;
  $('#resxView').classList.remove('hidden');
  $('#rxTitle').textContent = baseName(tab.path);
  RX.cultures = await rxCultures(tab);
  rxRender();
}
function rxHide() { $('#resxView').classList.add('hidden'); RX.tab = null; }
async function rxAddRow() {
  const tab = RX.tab;
  if (!tab) return;
  const names = new Set((rxParse(tab.model.getValue()).rows || []).map((r) => r.name));
  let n = 1;
  while (names.has(`String${n}`)) n++;
  rxEdit((x) => rxAdd(x, `String${n}`));
  await rxRender();
  const inputs = $$('#rxBody .rx-name');
  const last = [...inputs].find((i) => i.value === `String${n}`);
  if (last) { last.focus(); last.select(); }
}

const rxActivate = activate;
activate = function (tab) { // eslint-disable-line no-func-assign
  rxActivate(tab);
  if (rxIsResx(tab) && tab.rxCode !== true) rxShow(tab); else rxHide();
  $('#rxBackToGrid').classList.toggle('hidden', !(rxIsResx(tab) && tab.rxCode === true));
};
bus.on('tabOpened', (tab) => { if (rxIsResx(tab)) tab.model.onDidChangeContent(() => { if (RX.tab === tab && !document.activeElement.closest('#rxBody')) rxRender(); }); });
bus.on('ready', () => {
  $('#rxAdd').onclick = () => rxAddRow();
  $('#rxCode').onclick = () => { if (RX.tab) { RX.tab.rxCode = true; rxHide(); editor.focus(); $('#rxBackToGrid').classList.remove('hidden'); } };
  $('#rxBackToGrid').onclick = () => { const t = state.active; if (rxIsResx(t)) { t.rxCode = false; $('#rxBackToGrid').classList.add('hidden'); rxShow(t); } };
  $('#rxFilter').oninput = (e) => { RX.filter = e.target.value; rxRender(); };
});
commands.resxViewDesigner = () => $('#rxBackToGrid').click();
