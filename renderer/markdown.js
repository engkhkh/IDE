// Nova IDE - Markdown preview beside the editor (Visual Studio 2026 / VS Code / Rider all have one):
// Ctrl+Shift+V or the Preview button of a .md tab. Updates as you type; code blocks are colored by the editor.
// Also the shared side pane (#sidePane) that the HTTP file client shows its responses in.
'use strict';

const SP = { owner: null, tab: null };

// ---------------- side pane ----------------
function spOpen(owner, tab, title) {
  SP.owner = owner; SP.tab = tab;
  $('#sidePane').classList.remove('hidden');
  $('#editorHost').classList.add('with-side');
  $('#spTitle').textContent = title;
  return $('#spBody');
}
function spClose() {
  if (SP.tab) { if (SP.owner === 'md') SP.tab.mdPreview = false; if (SP.owner === 'http') SP.tab.hcShow = false; }
  SP.owner = null; SP.tab = null;
  $('#sidePane').classList.add('hidden');
  $('#editorHost').classList.remove('with-side');
}
function spHide() { SP.owner = null; SP.tab = null; $('#sidePane').classList.add('hidden'); $('#editorHost').classList.remove('with-side'); }

// ---------------- Markdown -> HTML (CommonMark's common parts; all text is escaped) ----------------
const mdEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function mdSafeUrl(u) {
  const url = String(u || '').trim();
  return /^(javascript|vbscript|data):/i.test(url) && !/^data:image\//i.test(url) ? '#' : url;
}
function mdInline(src) {
  const codes = [];
  let t = String(src).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => { codes.push(code.trim()); return `\u0000${codes.length - 1}\u0000`; });
  t = mdEsc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt, url, title) => `<img src="${mdEsc(mdSafeUrl(url.replace(/&amp;/g, '&')))}" alt="${alt}"${title ? ` title="${title}"` : ''}>`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, label, url, title) => `<a href="${mdEsc(mdSafeUrl(url.replace(/&amp;/g, '&')))}"${title ? ` title="${title}"` : ''}>${label}</a>`);
  t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  t = t.replace(/(^|[^\w*])(\*|_)(?=\S)([\s\S]*?\S)\2(?![\w*])/g, '$1<em>$3</em>');
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  t = t.replace(/ {2,}\n|\\\n/g, '<br>');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${mdEsc(codes[+i])}</code>`);
}
const mdSlug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
function mdRender(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para.length = 0; } };
  const isTableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(```+|~~~+)\s*([\w#+.-]*)/))) {
      flush();
      const fence = m[1];
      const lang = m[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code" data-lang="${mdEsc(lang)}"><code>${mdEsc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); const h = mdInline(m[2]); out.push(`<h${m[1].length} id="${mdSlug(h)}">${h}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${mdRender(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(c)}</${tag}>`;
      out.push(`<table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] || '', k)).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if ((m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const indent = m[1].length;
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (lm && lm[1].length === indent && /\d/.test(lm[2]) === ordered) { items.push([lm[3]]); i++; continue; }
        if (items.length && lines[i].trim() && (/^\s+/.test(lines[i]) && (lines[i].match(/^\s*/)[0].length > indent))) { items[items.length - 1].push(lines[i].slice(Math.min(lines[i].match(/^\s*/)[0].length, indent + 2))); i++; continue; }
        break;
      }
      const start = ordered ? parseInt(m[2], 10) : 1;
      const li = items.map((it) => {
        let first = it[0];
        let box = '';
        const task = first.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) { box = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> `; first = task[2]; }
        const rest = it.slice(1).join('\n');
        return `<li${task ? ' class="md-task"' : ''}>${box}${mdInline(first)}${rest ? mdRender(rest) : ''}</li>`;
      }).join('');
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${li}</ol>` : `<ul>${li}</ul>`);
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    if (/^( {4}|\t)/.test(l) && !para.length) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push(`<pre class="md-code"><code>${mdEsc(body.join('\n'))}</code></pre>`);
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out.join('\n');
}

// ---------------- the preview ----------------
const MD_LANGS = { cs: 'csharp', 'c#': 'csharp', csharp: 'csharp', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript', json: 'json', xml: 'xml', html: 'html', css: 'css', py: 'python', python: 'python', sh: 'shell', bash: 'shell', shell: 'shell', ps1: 'powershell', powershell: 'powershell', sql: 'sql', yaml: 'yaml', yml: 'yaml', cpp: 'cpp', c: 'c', java: 'java', go: 'go', rust: 'rust', dart: 'dart', md: 'markdown' };
let mdTimer = null;
async function mdRefresh() {
  const tab = SP.tab;
  if (SP.owner !== 'md' || !tab) return;
  const body = $('#spBody');
  const top = body.scrollTop;
  body.className = 'sp-body md-body';
  body.innerHTML = mdRender(tab.model.getValue());
  const dir = dirName(tab.path);
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src && !/^[a-z]+:/i.test(src) && !src.startsWith('#')) img.src = `file:///${`${dir}/${src}`.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  }
  for (const a of body.querySelectorAll('a')) {
    a.onclick = (e) => {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) { const t = body.querySelector(`[id="${CSS.escape(href.slice(1))}"]`); if (t) t.scrollIntoView(); return; }
      if (/^https?:|^mailto:/i.test(href)) { api.openExternal(href); return; }
      // a relative link to another file of the folder opens it in the editor
      const [file] = href.split('#');
      if (file) openFile(`${dir}${sep()}${decodeURIComponent(file).replace(/[\\/]/g, sep())}`);
    };
  }
  body.scrollTop = top;
  for (const pre of body.querySelectorAll('pre.md-code[data-lang]')) {
    const lang = MD_LANGS[(pre.dataset.lang || '').toLowerCase()];
    if (!lang) continue;
    try { pre.firstChild.innerHTML = await monacoRef.editor.colorize(pre.textContent, lang, { tabSize: 4 }); } catch {}
  }
}
const mdIsMarkdown = (tab) => tab && /\.(md|markdown|mdx)$/i.test(tab.path);
function mdToggle(tab = state.active) {
  if (!mdIsMarkdown(tab)) return status('Markdown preview: open a .md file first');
  if (SP.owner === 'md' && SP.tab === tab) { spClose(); return; }
  tab.mdPreview = true;
  spOpen('md', tab, `Preview: ${baseName(tab.path)}`);
  mdRefresh();
}

commands.markdownPreview = () => mdToggle();
bus.on('ready', () => {
  $('#spClose').onclick = () => spClose();
  $('#mdPreviewBtn').onclick = () => mdToggle();
  editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Shift | monacoRef.KeyCode.KeyV, () => mdToggle());
});
bus.on('tabOpened', (tab) => {
  if (!mdIsMarkdown(tab)) return;
  tab.model.onDidChangeContent(() => { if (SP.owner === 'md' && SP.tab === tab) { clearTimeout(mdTimer); mdTimer = setTimeout(mdRefresh, 250); } });
});
// the pane belongs to one tab: other tabs hide it, coming back shows it again
const spActivate = activate;
activate = function (tab) {
  spActivate(tab);
  const btn = $('#mdPreviewBtn');
  if (btn) btn.classList.toggle('hidden', !mdIsMarkdown(tab));
  if (tab && tab.mdPreview && mdIsMarkdown(tab)) { spOpen('md', tab, `Preview: ${baseName(tab.path)}`); mdRefresh(); }
  else if (tab && tab.hcShow && typeof hcShowResponse === 'function') hcShowResponse(tab);
  else spHide();
};
bus.on('tabClosing', (tab) => { if (SP.tab === tab) spClose(); });
