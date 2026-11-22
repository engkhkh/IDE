// Nova IDE - merge conflicts (banner, Merge Changes list, 3-pane merge editor, in-editor conflict actions) and stashes
'use strict';

const MG = { open: false, file: null, info: null, conflicts: [], editors: null, zones: null, resultDecos: [], current: 0, applying: false };
const OP_TEXT = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };
const lineCount = (t) => (t ? (t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length) : 0);
const withNl = (t) => (t && !t.endsWith('\n') ? `${t}\n` : t || '');

// ---------------- Git Changes: banner + Merge Changes ----------------
function opBanner(s) {
  const op = s.op;
  const n = (s.conflicts || []).length;
  const box = el('div', 'git-op-banner');
  let text;
  if (op.kind === 'merge') text = `Merging '${op.incoming}' into '${s.branch}'`;
  else if (op.kind === 'rebase') text = `Rebasing '${op.branch}' onto '${op.onto}'${op.total ? ` (${op.step}/${op.total})` : ''}`;
  else if (op.kind === 'cherry-pick') text = `Cherry-picking ${op.incoming}`;
  else text = `Reverting: ${op.incoming}`;
  box.append(el('div', 'git-op-title', `⚠ ${text}`));
  box.append(el('div', 'git-op-desc', n ? `${n} file${n === 1 ? ' has' : 's have'} conflicts. Resolve them, then continue.` : op.kind === 'merge' ? 'All conflicts resolved. Commit the merge to finish.' : 'All conflicts resolved. Continue to finish.'));
  const row = el('div', 'git-op-actions');
  const btn = (label, title, fn, primary) => { const b = el('button', primary ? 'primary' : null, label); b.title = title; b.onclick = fn; row.appendChild(b); return b; };
  if (n) btn('Resolve Conflicts', 'Open the first conflicted file in the merge editor', () => openConflict(s.conflicts[0]), true);
  const cont = btn(op.kind === 'merge' ? 'Commit Merge' : 'Continue', op.kind === 'merge' ? 'Commit the merge (git commit)' : `git ${op.kind} --continue`, () => mergeControl('continue'), !n);
  cont.disabled = n > 0;
  if (op.kind === 'rebase') btn('Skip', 'Skip this commit (git rebase --skip)', () => confirm('Skip this commit? Its changes are dropped from the rebase.') && mergeControl('skip'));
  btn(`Abort ${OP_TEXT[op.kind]}`, `Stop and go back to how things were (git ${op.kind} --abort)`, () => confirm(`Abort the ${OP_TEXT[op.kind].toLowerCase()}? Your conflict resolutions are lost.`) && mergeControl('abort'));
  box.appendChild(row);
  return box;
}

function conflictSection(s) {
  const sec = el('details', 'git-section git-conflicts');
  sec.open = true;
  sec.appendChild(el('summary', null, `Merge Changes (${s.conflicts.length})`));
  for (const f of s.conflicts) {
    const row = el('div', 'git-file');
    row.title = `${f.file}\n${f.label}`;
    const st = el('span', 'git-st git-c', '⚠');
    const name = el('span', 'git-name', baseName(f.file));
    const dir = el('span', 'git-dir', `${f.label}${f.file.includes('/') ? ` · ${f.file.slice(0, f.file.lastIndexOf('/'))}` : ''}`);
    row.append(st, name, dir);
    row.onclick = () => openConflict(f);
    row.oncontextmenu = (e) => { e.preventDefault(); conflictMenu(e.clientX, e.clientY, f); };
    sec.appendChild(row);
  }
  return sec;
}

function conflictMenu(x, y, f) {
  const s = gitState.status;
  const items = [{ label: 'Open Merge Editor', run: () => openConflict(f) }];
  if (f.code === 'UU' || f.code === 'AA') {
    items.push({ label: `Take Incoming (${incomingName(s)})`, run: () => takeSide(f, 'theirs') });
    items.push({ label: `Take Current (${currentName(s)})`, run: () => takeSide(f, 'ours') });
  } else {
    items.push({ label: 'Keep File', run: () => resolveFile(f, 'keep', `Keep ${f.file}`) });
    items.push({ label: 'Delete File', run: () => resolveFile(f, 'delete', `Delete ${f.file}`) });
  }
  if (f.code !== 'DD' && f.code !== 'DU') items.push({ label: 'Open File (with markers)', run: () => openFile(repoPath(f.file)) });
  if (f.code === 'UU' || f.code === 'AA') items.push('-', { label: 'Mark as Resolved', run: () => markResolved(f) });
  popup(x, y, items);
}

const incomingName = (s) => (s.op ? (s.op.kind === 'rebase' ? s.op.incoming : s.op.incoming) : 'incoming');
const currentName = (s) => (s.op && s.op.kind === 'rebase' ? s.op.onto : s.branch);

async function resolveFile(f, how, label, content) {
  const r = await gitRun(label, () => api.gitmerge.resolve(gitState.status.root, f.file, how, content));
  reloadCleanTabs();
  return r;
}
// the file was fixed by hand: stage it (warn when markers are left)
async function markResolved(f) {
  await saveAll();
  const info = await api.gitmerge.info(gitState.status.root, f.file);
  if (info.workingHasMarkers && !confirm(`${f.file} still contains conflict markers (<<<<<<< / >>>>>>>). Mark it as resolved anyway?`)) return;
  return resolveFile(f, 'keep', `Mark ${f.file} as resolved`);
}
const takeSide = (f, side) => resolveFile(f, side, `Take ${side === 'theirs' ? 'Incoming' : 'Current'} for ${f.file}`);

async function mergeControl(action) {
  await saveAll();
  const s = gitState.status;
  const kind = s.op ? s.op.kind : 'merge';
  const r = await gitRun(`${OP_TEXT[kind]} ${action}`, () => api.gitmerge.control(s.root, action));
  reloadCleanTabs();
  if (r && r.ok === false && /conflict/i.test(r.stderr + r.stdout)) status('More conflicts to resolve');
  if (MG.open) closeMerge();
  return r;
}

// ---------------- opening a conflict ----------------
async function openConflict(f) {
  const s = gitState.status;
  if (!s || !s.repo) return;
  const info = await api.gitmerge.info(s.root, f.file);
  if (info.resolved) { status(`${f.file} is already resolved`); refreshGit(); return; }
  if (info.binary || !info.segments) return deleteOrBinaryDialog(f, info);
  openMergeEditor(f, info);
}

function deleteOrBinaryDialog(f, info) {
  const s = gitState.status;
  const inc = incomingName(s), cur = currentName(s);
  let text;
  if (info.binary) text = `${f.file} is a binary file that was changed on both sides. Choose which version to keep.`;
  else if (!info.oursExists && info.theirsExists) text = `${f.file} was deleted in ${cur} (current) and changed in ${inc} (incoming).`;
  else if (info.oursExists && !info.theirsExists) text = `${f.file} was changed in ${cur} (current) and deleted in ${inc} (incoming).`;
  else text = `${f.file}: ${f.label}.`;
  const buttons = ['spacer'];
  if (info.binary) {
    buttons.push({ label: 'Take Incoming', primary: true, id: 'mgTakeIncoming', onClick: (close) => { close(); takeSide(f, 'theirs'); } });
    buttons.push({ label: 'Take Current', id: 'mgTakeCurrent', onClick: (close) => { close(); takeSide(f, 'ours'); } });
  } else {
    buttons.push({ label: info.oursExists ? 'Keep Current File' : info.theirsExists ? 'Keep Incoming File' : 'Keep File', primary: true, id: 'mgKeep', onClick: (close) => { close(); resolveFile(f, info.oursExists ? 'ours' : 'keep', `Keep ${f.file}`); } });
    buttons.push({ label: 'Delete File', id: 'mgDelete', onClick: (close) => { close(); resolveFile(f, 'delete', `Delete ${f.file}`); } });
  }
  buttons.push({ label: 'Cancel', onClick: (close) => close() });
  makeDialog({ title: 'Resolve Conflict', body: h('div', {}, h('p', {}, text), h('p', { class: 'dlg-desc' }, f.label)), buttons });
}

// ---------------- the merge editor ----------------
function blockText(c) {
  if (!c.order.length) return c.edited != null ? c.edited : c.base;
  return c.order.map((side) => (side === 'ours' ? withNl(c.ours) : withNl(c.theirs))).join('');
}

function openMergeEditor(f, info) {
  closeDiff();
  if (MG.open) closeMerge(true);
  const s = gitState.status;
  MG.open = true;
  MG.file = f;
  MG.info = info;
  MG.conflicts = [];
  MG.current = 0;
  // build the three texts and the line ranges of each conflict
  let inc = '', cur = '', res = '';
  for (const seg of info.segments) {
    if (seg.type === 'common') { inc += seg.text; cur += seg.text; res += seg.text; continue; }
    const c = { ours: seg.ours, theirs: seg.theirs, base: seg.base, order: [], edited: null,
      incStart: lineCount(inc) + 1, curStart: lineCount(cur) + 1, incLines: lineCount(seg.theirs), curLines: lineCount(seg.ours), resStart: lineCount(res) + 1 };
    inc += seg.theirs; cur += seg.ours; res += seg.base;
    MG.conflicts.push(c);
  }
  $('#mergeView').classList.remove('hidden');
  $('#mgTitle').textContent = `Merging: ${f.file}`;
  $('#mgIncomingTitle').textContent = `Incoming: ${incomingName(s)}`;
  $('#mgCurrentTitle').textContent = `Current: ${currentName(s)}`;
  $('#mgResultTitle').textContent = `Result: ${f.file}`;
  const path = repoPath(f.file);
  const opts = { automaticLayout: true, fontSize: state.settings.fontSize, fontFamily: state.settings.fontFamily, minimap: { enabled: false }, stickyScroll: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: false, folding: false, lineNumbersMinChars: 3, renderLineHighlight: 'none' };
  const mk = (host, text, readOnly) => {
    const ed = monacoRef.editor.create($(host), { ...opts, readOnly, renderLineHighlight: readOnly ? 'none' : 'line' });
    ed.setModel(monacoRef.editor.createModel(text, langFor(path)));
    return ed;
  };
  MG.editors = { inc: mk('#mgIncoming', inc, true), cur: mk('#mgCurrent', cur, true), res: mk('#mgResult', res, false) };
  MG.zones = { inc: [], cur: [], res: [] };
  // conflict highlights in the two inputs
  const hl = (ed, key, cls) => ed.getModel().deltaDecorations([], MG.conflicts.filter((c) => c[`${key}Lines`]).map((c) => ({ range: new monacoRef.Range(c[`${key}Start`], 1, c[`${key}Start`] + c[`${key}Lines`] - 1, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: `${cls}-bar` } })));
  hl(MG.editors.inc, 'inc', 'mg-incoming');
  hl(MG.editors.cur, 'cur', 'mg-current');
  // tracked ranges for the conflicts in the result
  const resModel = MG.editors.res.getModel();
  MG.resultDecos = resModel.deltaDecorations([], MG.conflicts.map((c) => ({ range: resRange(c.resStart, lineCount(c.base)), options: resDecoOptions(c) })));
  resModel.onDidChangeContent((e) => { if (!MG.applying) onResultEdited(e); });
  layoutZones();
  // keep the three panes scrolled together
  let syncing = false;
  for (const [k, ed] of Object.entries(MG.editors)) {
    ed.onDidScrollChange((e) => {
      if (syncing || !e.scrollTopChanged) return;
      syncing = true;
      for (const [k2, other] of Object.entries(MG.editors)) if (k2 !== k) other.setScrollTop(e.scrollTop);
      syncing = false;
    });
  }
  updateMergeStatus();
  setTimeout(() => goConflict(0), 50);
}

const resRange = (start, lines) => new monacoRef.Range(start, 1, start + lines, 1);
function resDecoOptions(c) {
  const resolved = c.order.length || c.edited != null;
  return { className: resolved ? 'mg-res-resolved' : 'mg-res-open', isWholeLine: false, stickiness: monacoRef.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges, showIfCollapsed: true };
}

// current line range of conflict i in the result: [start, start + lines)
function resultRange(i) {
  const r = MG.editors.res.getModel().getDecorationRange(MG.resultDecos[i]);
  if (!r) return null;
  const lines = r.endLineNumber - r.startLineNumber + (r.endColumn > 1 ? 1 : 0);
  return { start: r.startLineNumber, lines };
}

// align the panes: blank space under the shorter side of every conflict + the checkbox rows
function layoutZones() {
  const lh = MG.editors.inc.getOption(monacoRef.editor.EditorOption.lineHeight);
  const HEADER = 24;
  for (const [key, ed] of Object.entries(MG.editors)) {
    ed.changeViewZones((acc) => {
      for (const id of MG.zones[key]) acc.removeZone(id);
      MG.zones[key] = [];
      MG.conflicts.forEach((c, i) => {
        const rr = key === 'res' ? resultRange(i) : null;
        const start = key === 'inc' ? c.incStart : key === 'cur' ? c.curStart : rr ? rr.start : c.resStart;
        const lines = key === 'inc' ? c.incLines : key === 'cur' ? c.curLines : rr ? rr.lines : 0;
        const max = Math.max(c.incLines, c.curLines, rr ? rr.lines : 0);
        MG.zones[key].push(acc.addZone({ afterLineNumber: start - 1, heightInPx: HEADER, domNode: zoneHeader(key, c, i) }));
        if (max > lines) MG.zones[key].push(acc.addZone({ afterLineNumber: start - 1 + lines, heightInPx: (max - lines) * lh, domNode: h('div', { class: 'mg-pad' }) }));
      });
    });
  }
}

function zoneHeader(key, c, i) {
  const n = MG.conflicts.length;
  if (key === 'res') {
    const resolved = c.order.length || c.edited != null;
    const node = h('div', { class: `mg-zone mg-zone-res${resolved ? ' resolved' : ''}` },
      h('span', {}, resolved ? `✓ Conflict ${i + 1} of ${n} resolved` : `⚠ Conflict ${i + 1} of ${n}: choose Incoming and/or Current above, or edit here`));
    if (resolved) { const b = h('a', { href: '#', class: 'mg-reset' }, 'Reset'); b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); resetConflict(i); }; node.appendChild(b); }
    return node;
  }
  const side = key === 'inc' ? 'theirs' : 'ours';
  const checked = c.order.includes(side);
  const label = key === 'inc' ? 'Take Incoming' : 'Take Current';
  const box = h('span', { class: `mg-check${checked ? ' on' : ''}` }, checked ? '☑' : '☐');
  const node = h('div', { class: `mg-zone mg-zone-${key}`, title: `${label} for conflict ${i + 1}`, 'data-conflict': i, 'data-side': side }, box, h('span', {}, ` ${label}`), h('span', { class: 'dlg-desc' }, `  · conflict ${i + 1} of ${n}${(key === 'inc' ? c.incLines : c.curLines) ? '' : ' (removes these lines)'}`));
  // Monaco swallows clicks inside view zones; use mousedown
  node.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); toggleSide(i, side); };
  return node;
}

function setBlock(i, text) {
  const model = MG.editors.res.getModel();
  const rr = resultRange(i);
  MG.applying = true;
  const range = resRange(rr.start, rr.lines);
  // keep the edit on whole lines; a block at the very end of a file without newline
  let t = text;
  if (range.endLineNumber > model.getLineCount()) {
    const r2 = new monacoRef.Range(rr.start, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount()));
    t = text.replace(/\n$/, '');
    model.pushEditOperations([], [{ range: r2, text: t }], () => null);
  } else model.pushEditOperations([], [{ range, text: t }], () => null);
  // re-anchor the tracked range on the new lines
  const lines = lineCount(text);
  MG.resultDecos[i] = model.deltaDecorations([MG.resultDecos[i]], [{ range: resRange(rr.start, lines), options: resDecoOptions(MG.conflicts[i]) }])[0];
  MG.applying = false;
}

function toggleSide(i, side) {
  const c = MG.conflicts[i];
  c.order = c.order.includes(side) ? c.order.filter((x) => x !== side) : [...c.order, side];
  c.edited = null;
  setBlock(i, blockText(c));
  MG.current = i;
  layoutZones();
  updateMergeStatus();
}
function resetConflict(i) {
  const c = MG.conflicts[i];
  c.order = []; c.edited = null;
  setBlock(i, c.base);
  layoutZones();
  updateMergeStatus();
}
function takeAll(side) {
  MG.conflicts.forEach((c, i) => { c.order = [side]; c.edited = null; setBlock(i, blockText(c)); });
  layoutZones();
  updateMergeStatus();
}

let zoneTimer = null;
function onResultEdited(e) {
  // typing inside a conflict marks it as resolved by hand
  for (const ch of e.changes) {
    MG.conflicts.forEach((c, i) => {
      const rr = resultRange(i);
      if (!rr) return;
      if (ch.range.startLineNumber >= rr.start && ch.range.startLineNumber <= rr.start + Math.max(rr.lines - 1, 0)) {
        const model = MG.editors.res.getModel();
        c.edited = rr.lines ? model.getValueInRange(resRange(rr.start, rr.lines)) : '';
        c.order = [];
      }
    });
  }
  clearTimeout(zoneTimer);
  zoneTimer = setTimeout(() => { layoutZones(); updateMergeStatus(); }, 300);
}

const unresolvedCount = () => MG.conflicts.filter((c) => !c.order.length && c.edited == null).length;
function updateMergeStatus() {
  const n = MG.conflicts.length, u = unresolvedCount();
  $('#mgCount').textContent = u ? `${u} of ${n} conflict${n === 1 ? '' : 's'} unresolved` : `All ${n} conflict${n === 1 ? '' : 's'} resolved`;
  $('#mgCount').className = u ? 'mg-count open' : 'mg-count done';
  // keep result decorations in sync with the state
  const model = MG.editors.res.getModel();
  MG.conflicts.forEach((c, i) => { const r = model.getDecorationRange(MG.resultDecos[i]); if (r) MG.resultDecos[i] = model.deltaDecorations([MG.resultDecos[i]], [{ range: r, options: resDecoOptions(c) }])[0]; });
}

function goConflict(i) {
  if (!MG.conflicts.length) return;
  MG.current = (i + MG.conflicts.length) % MG.conflicts.length;
  const c = MG.conflicts[MG.current];
  const rr = resultRange(MG.current);
  MG.editors.res.revealLineInCenter(rr ? rr.start : c.resStart);
  MG.editors.inc.setScrollTop(MG.editors.res.getScrollTop());
  MG.editors.cur.setScrollTop(MG.editors.res.getScrollTop());
  MG.editors.res.setPosition({ lineNumber: rr ? rr.start : c.resStart, column: 1 });
}

async function acceptMerge() {
  const text = MG.editors.res.getModel().getValue();
  const u = unresolvedCount();
  if (u && !confirm(`${u} conflict${u === 1 ? ' is' : 's are'} not resolved. The result keeps the base text there.\n\nAccept the merge anyway?`)) return;
  if (/^(<{7}|>{7})( |$)/m.test(text) && !confirm('The result still contains conflict markers (<<<<<<< / >>>>>>>). Accept anyway?')) return;
  const f = MG.file;
  const r = await resolveFile(f, 'content', `Resolve ${f.file}`, text);
  if (r && r.ok === false) return;
  const t = state.tabs.find((x) => normPath(x.path) === normPath(repoPath(f.file)));
  if (t) reloadTabFromDisk(t);
  closeMerge();
  // next conflict, if any
  const next = (gitState.status.conflicts || [])[0];
  if (next) { status(`Resolved ${f.file}. Next: ${next.file}`); openConflict(next); } else status(`Resolved ${f.file}. All conflicts resolved.`);
}

function closeMerge(silent) {
  if (!MG.editors) { $('#mergeView').classList.add('hidden'); MG.open = false; return; }
  for (const ed of Object.values(MG.editors)) { const m = ed.getModel(); ed.dispose(); if (m) m.dispose(); }
  MG.editors = null;
  MG.open = false;
  $('#mergeView').classList.add('hidden');
  if (!silent) refreshGit();
}

$('#mgAccept').onclick = () => acceptMerge();
$('#mgClose').onclick = () => { if (MG.conflicts.some((c) => c.order.length || c.edited != null) && !confirm('Close the merge editor? Your choices are not saved.')) return; closeMerge(); };
$('#mgPrev').onclick = () => goConflict(MG.current - 1);
$('#mgNext').onclick = () => goConflict(MG.current + 1);
$('#mgTakeIncoming').onclick = () => takeAll('theirs');
$('#mgTakeCurrent').onclick = () => takeAll('ours');

// ---------------- conflict markers in a normal editor ----------------
// parse <<<<<<< / ||||||| / ======= / >>>>>>> blocks (line numbers are 1-based)
function findMarkerBlocks(model) {
  const blocks = [];
  const n = model.getLineCount();
  let b = null;
  for (let i = 1; i <= n; i++) {
    const l = model.getLineContent(i);
    if (/^<{7}( |$)/.test(l)) b = { start: i, mid: 0, base: 0, oursLabel: l.slice(8) };
    else if (b && /^\|{7}( |$)/.test(l) && !b.mid) b.base = i;
    else if (b && /^={7}$/.test(l)) b.mid = i;
    else if (b && b.mid && /^>{7}( |$)/.test(l)) { b.end = i; b.theirsLabel = l.slice(8); blocks.push(b); b = null; }
  }
  return blocks;
}
function markerText(model, from, to) { return from > to ? '' : model.getValueInRange(new monacoRef.Range(from, 1, to + 1, 1)); }
function resolveMarkerBlock(model, b, how) {
  const ours = markerText(model, b.start + 1, (b.base || b.mid) - 1);
  const theirs = markerText(model, b.mid + 1, b.end - 1);
  const text = how === 'ours' ? ours : how === 'theirs' ? theirs : withNl(ours) + theirs;
  const endRange = b.end < model.getLineCount() ? new monacoRef.Range(b.start, 1, b.end + 1, 1) : new monacoRef.Range(b.start, 1, b.end, model.getLineMaxColumn(b.end));
  const tgt = editor.getModel() === model ? editor : null;
  const edit = [{ range: endRange, text: b.end < model.getLineCount() ? withNl(text) : text.replace(/\n$/, '') }];
  if (tgt) { tgt.pushUndoStop(); tgt.executeEdits('nova-merge', edit); tgt.pushUndoStop(); } else model.pushEditOperations([], edit, () => null);
}
const markerDecos = new Map();
function paintMarkers(model) {
  if (!model || model.isDisposed()) return;
  const key = model.uri.toString();
  const blocks = model.getLineCount() < 50000 ? findMarkerBlocks(model) : [];
  const d = [];
  for (const b of blocks) {
    const range = (a, z, cls) => { if (z >= a) d.push({ range: new monacoRef.Range(a, 1, z, 1), options: { isWholeLine: true, className: cls } }); };
    range(b.start, b.start, 'mk-head-ours');
    range(b.start + 1, (b.base || b.mid) - 1, 'mk-ours');
    if (b.base) range(b.base, b.mid - 1, 'mk-base');
    range(b.mid, b.mid, 'mk-sep');
    range(b.mid + 1, b.end - 1, 'mk-theirs');
    range(b.end, b.end, 'mk-head-theirs');
  }
  markerDecos.set(key, model.deltaDecorations(markerDecos.get(key) || [], d));
  MG.markerBlocks = MG.markerBlocks || new Map();
  MG.markerBlocks.set(key, blocks);
  if (MG.lensEmitter) MG.lensEmitter.fire();
}

function wireMarkerEditor() {
  MG.lensEmitter = new monacoRef.Emitter();
  monacoRef.languages.registerCodeLensProvider('*', {
    onDidChange: MG.lensEmitter.event,
    provideCodeLenses: (model) => {
      const blocks = (MG.markerBlocks && MG.markerBlocks.get(model.uri.toString())) || [];
      const lenses = [];
      blocks.forEach((b, i) => {
        const range = new monacoRef.Range(b.start, 1, b.start, 1);
        lenses.push({ range, command: { id: 'nova.merge.ours', title: 'Accept Current Change', arguments: [model.uri.toString(), i] } });
        lenses.push({ range, command: { id: 'nova.merge.theirs', title: 'Accept Incoming Change', arguments: [model.uri.toString(), i] } });
        lenses.push({ range, command: { id: 'nova.merge.both', title: 'Accept Both Changes', arguments: [model.uri.toString(), i] } });
        if (gitState.status && (gitState.status.conflicts || []).length) lenses.push({ range, command: { id: 'nova.merge.editor', title: 'Open Merge Editor', arguments: [model.uri.toString()] } });
      });
      return { lenses, dispose() {} };
    },
    resolveCodeLens: (_m, l) => l
  });
  const byUri = (u) => monacoRef.editor.getModel(monacoRef.Uri.parse(u));
  const run = (how) => (_a, uri, i) => { const m = byUri(uri); const b = m && findMarkerBlocks(m)[i]; if (b) resolveMarkerBlock(m, b, how); };
  monacoRef.editor.registerCommand('nova.merge.ours', run('ours'));
  monacoRef.editor.registerCommand('nova.merge.theirs', run('theirs'));
  monacoRef.editor.registerCommand('nova.merge.both', run('both'));
  monacoRef.editor.registerCommand('nova.merge.editor', (_a, uri) => {
    const m = byUri(uri);
    const t = state.tabs.find((x) => x.model === m);
    const f = t && (gitState.status.conflicts || []).find((c) => normPath(repoPath(c.file)) === normPath(t.path));
    if (f) openConflict(f); else status('This file is not in conflict in Git');
  });
  let timer = null;
  editor.onDidChangeModelContent(() => { clearTimeout(timer); timer = setTimeout(() => paintMarkers(editor.getModel()), 250); });
  editor.onDidChangeModel(() => paintMarkers(editor.getModel()));
}

// ---------------- stashes ----------------
const STASH = { list: [], open: new Set(), files: new Map() };
async function loadStashes() {
  const s = gitState.status;
  STASH.list = s && s.repo ? await api.gitmerge.stashList(s.root) : [];
}

function stashButton(s) {
  const b = el('button', 'git-stash-btn', 'Stash ▾');
  b.title = 'Stash your changes';
  b.disabled = !(s.staged.length + s.changes.length);
  b.onclick = (e) => {
    const r = b.getBoundingClientRect();
    popup(r.left, r.bottom, [
      { label: 'Stash All', run: () => commands.gitStash() },
      { label: 'Stash All and Keep Staged', disabled: !s.staged.length, run: () => commands.gitStashKeepStaged() },
      { label: 'Stash All (Include Untracked)', run: () => commands.gitStashUntracked() }
    ]);
    e.stopPropagation();
  };
  return b;
}

async function doStash(opts) {
  const s = gitState.status;
  if (!s || !s.repo) return;
  await saveAll();
  const msgBox = $('#gitMsg');
  const message = msgBox && msgBox.value.trim() && !(s.op && msgBox.value.trim() === s.op.message) ? msgBox.value.trim() : '';
  const r = await gitRun('Stash', () => api.gitmerge.stash(s.root, 'push', { ...opts, message }));
  if (r && r.ok) { if (message) gitState.draft = ''; reloadCleanTabs(); await afterStash(); }
}
async function stashAction(st, action, label) {
  const s = gitState.status;
  await saveAll();
  const r = await gitRun(label, () => api.gitmerge.stash(s.root, action, { ref: st.ref }));
  if (r && r.ok === false && /conflict/i.test(`${r.stdout}${r.stderr}`)) status('The stash conflicts with your changes: resolve the conflicts');
  reloadCleanTabs();
  STASH.files.clear();
  await afterStash();
}
async function afterStash() { await loadStashes(); renderGit(); }

function stashSection(s) {
  const sec = el('details', 'git-section git-stashes');
  sec.open = STASH.sectionOpen !== false && STASH.list.length > 0;
  sec.ontoggle = () => { STASH.sectionOpen = sec.open; };
  sec.appendChild(el('summary', null, `Stashes (${STASH.list.length})`));
  if (!STASH.list.length) sec.appendChild(el('div', 'git-empty', 'No stashes. Stash ▾ puts your changes aside.'));
  for (const st of STASH.list) {
    const row = el('div', 'git-file git-stash');
    const open = STASH.open.has(st.hash);
    row.append(el('span', 'git-st', open ? '▾' : '▸'), el('span', 'git-name', st.message || '(no message)'), el('span', 'git-dir', `${st.ref} · ${st.branch} · ${relTime(st.time)}`));
    row.title = `${st.ref}: ${st.message}\nOn ${st.branch}, ${new Date(st.time * 1000).toLocaleString()}\nRight-click for Apply / Pop / Drop`;
    row.onclick = async () => { if (open) STASH.open.delete(st.hash); else { STASH.open.add(st.hash); if (!STASH.files.has(st.hash)) STASH.files.set(st.hash, await api.gitmerge.stashFiles(s.root, st.ref)); } renderGit(); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      popup(e.clientX, e.clientY, [
        { label: 'Apply', run: () => stashAction(st, 'apply', `Apply ${st.ref}`) },
        { label: 'Pop (apply and delete)', run: () => stashAction(st, 'pop', `Pop ${st.ref}`) },
        { label: 'New Branch from Stash...', run: async () => { const name = await ask(`New branch from ${st.ref}`); if (name) { await saveAll(); await gitRun(`Branch ${name} from ${st.ref}`, () => api.gitmerge.stash(s.root, 'branch', { ref: st.ref, name })); reloadCleanTabs(); STASH.files.clear(); await afterStash(); } } },
        '-',
        { label: 'Drop (delete)', run: () => confirm(`Delete ${st.ref} "${st.message}"? Its changes are lost.`) && stashAction(st, 'drop', `Drop ${st.ref}`) }
      ]);
    };
    sec.appendChild(row);
    if (open) {
      for (const f of STASH.files.get(st.hash) || []) {
        const fr = el('div', 'git-file git-stash-file');
        fr.append(el('span', `git-st ${GIT_COLORS[f.status] || ''}`, f.status), el('span', 'git-name', baseName(f.path)), el('span', 'git-dir', f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''));
        fr.title = `${f.path}${f.untracked ? ' (untracked)' : ''}: click to see the change`;
        fr.onclick = async () => {
          const d = await api.gitmerge.stashFile(s.root, st.ref, f.path, f.untracked);
          openTextDiff({ title: `${f.path}  —  ${st.ref} "${st.message}"  (read-only)`, original: d.before, modified: d.after, path: repoPath(f.path) });
        };
        sec.appendChild(fr);
      }
    }
  }
  return sec;
}

// ---------------- wiring ----------------
Object.assign(commands, {
  gitStash: () => doStash({}),
  gitStashKeepStaged: () => doStash({ keepIndex: true }),
  gitStashUntracked: () => doStash({ untracked: true }),
  gitResolveConflicts: () => { const c = gitState.status && (gitState.status.conflicts || [])[0]; if (c) openConflict(c); else status('No merge conflicts'); },
  gitAbortOperation: () => { const s = gitState.status; if (!s || !s.op) { status('No merge, rebase or cherry-pick in progress'); return; } if (confirm(`Abort the ${OP_TEXT[s.op.kind].toLowerCase()}?`)) mergeControl('abort'); },
  gitContinueOperation: () => { const s = gitState.status; if (!s || !s.op) { status('No merge, rebase or cherry-pick in progress'); return; } mergeControl('continue'); },
  gitMergeBranch: async () => {
    const s = gitState.status;
    if (!s || !s.repo) return;
    const branches = (await api.git.branches(s.root)).filter((b) => !b.current).map((b) => b.name);
    const name = await ask(`Merge into '${s.branch}' (branches: ${branches.join(', ') || 'none'})`);
    if (!name) return;
    await saveAll();
    const r = await gitRun(`Merge ${name}`, () => api.githist.op(s.root, 'merge', { ref: name }));
    reloadCleanTabs();
    if (r && r.ok === false && gitState.status.conflicts && gitState.status.conflicts.length) { showSide('git'); status(`Merge has ${gitState.status.conflicts.length} conflict(s): resolve them in Git Changes`); }
  }
});

// stashes are part of the Git Changes refresh
const _refreshGitMG = refreshGit;
refreshGit = async function () { const r = await _refreshGitMG.apply(this, arguments); if (gitState.status && gitState.status.repo) { const before = STASH.list.length; await loadStashes(); if (before !== STASH.list.length || STASH.list.length) renderGit(); } return r; }; // eslint-disable-line no-func-assign
const _activateMG = activate;
activate = function (tab) { if (MG.open) closeMerge(true); _activateMG(tab); }; // eslint-disable-line no-func-assign

bus.on('ready', () => wireMarkerEditor());
bus.on('tabOpened', (tab) => { if (tab && tab.model) paintMarkers(tab.model); });
bus.on('folder', () => { if (MG.open) closeMerge(true); STASH.list = []; STASH.files.clear(); STASH.open.clear(); });

window.MG = MG;
window.STASH = STASH;
window.openConflict = openConflict;
window.findMarkerBlocks = findMarkerBlocks;
