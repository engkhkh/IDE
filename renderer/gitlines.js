// Nova IDE - partial commits: in the Git diff view, Stage Selected Lines (working tree -> index) and Unstage
// Selected Lines (index -> HEAD) take only the changed blocks your selection touches, like Visual Studio's
// line staging / Passenger's partial commits. The file's index entry is rewritten (git hash-object + update-index).
'use strict';

// original + modified lines and Monaco's line changes -> the original with only the chosen changes applied
function glApply(origText, modText, changes, chosen) {
  const eol = /\r\n/.test(origText) || (!/\n/.test(origText) && /\r\n/.test(modText)) ? '\r\n' : '\n';
  const o = origText.split(/\r?\n/), m = modText.split(/\r?\n/);
  const out = [];
  let pos = 1;
  for (const [i, c] of [...changes].sort((a, b) => a.originalStartLineNumber - b.originalStartLineNumber).entries()) {
    const ins = c.originalEndLineNumber === 0;
    const oStart = ins ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
    out.push(...o.slice(pos - 1, oStart - 1));
    if (chosen(c, i)) { if (c.modifiedEndLineNumber !== 0) out.push(...m.slice(c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber)); }
    else if (!ins) out.push(...o.slice(c.originalStartLineNumber - 1, c.originalEndLineNumber));
    pos = ins ? oStart : c.originalEndLineNumber + 1;
  }
  out.push(...o.slice(pos - 1));
  return out.join(eol);
}
// does a selection (modified side lines) touch a change? deletions are anchored at their modified line
function glTouches(c, sels) {
  const from = c.modifiedStartLineNumber, to = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber + 1 : c.modifiedEndLineNumber;
  return sels.some((s) => s.endLineNumber >= from && s.startLineNumber <= to);
}

async function glApplySelection() {
  const d = gitState.diff;
  if (!d || !d.git) return status('Open a Git change first (Git Changes, click a file)');
  const de = d.diffEditor;
  const changes = de.getLineChanges() || [];
  const sels = de.getModifiedEditor().getSelections() || [];
  if (!changes.some((c) => glTouches(c, sels))) return status('Select lines of a change first (in the right side)');
  const orig = d.originalModel.getValue(), mod = d.modifiedModel.getValue();
  // stage: index + the selected changes; unstage: the staged text without the selected changes
  const text = d.staged ? glApply(orig, mod, changes, (c) => !glTouches(c, sels)) : glApply(orig, mod, changes, (c) => glTouches(c, sels));
  const root = gitState.status.root;
  const r = await api.git.setIndex(root, d.git.file, text);
  if (!r.ok) return status(`Git: ${r.stderr || 'could not update the index'}`);
  status(d.staged ? 'Unstaged the selected lines' : 'Staged the selected lines');
  const f = d.git;
  // let the diff editor finish the click before it is replaced
  closeDiff();
  await new Promise((r) => setTimeout(r, 0));
  await refreshGit();
  // show what is left of the same diff
  const s = gitState.status;
  const left = (d.staged ? s.staged : s.changes).find((x) => x.file === f.file);
  if (left) await openDiff(left, d.staged); else closeDiff();
  return r;
}

// remember which change the diff shows (openDiff knows; the diff state didn't)
const glOpenDiff = openDiff;
openDiff = async function (f, staged) { // eslint-disable-line no-func-assign
  await glOpenDiff(f, staged);
  if (gitState.diff) { gitState.diff.git = f; gitState.diff.staged = !!staged; }
  const b = $('#diffStageLines');
  b.classList.toggle('hidden', !gitState.diff || !gitState.diff.git || f.status === 'U' || f.status === 'D');
  b.textContent = staged ? '− Unstage Selected Lines' : '+ Stage Selected Lines';
};
const glCloseDiff = closeDiff;
closeDiff = function () { // eslint-disable-line no-func-assign
  const had = !!gitState.diff;
  glCloseDiff();
  $('#diffStageLines').classList.add('hidden');
  // the disposed diff editor may still be Monaco's "active" editor (F12, suggest use it): hand that back to the main editor
  if (had && editor && state.active) editor.focus();
};
commands.gitStageSelectedLines = () => glApplySelection();
bus.on('ready', () => { $('#diffStageLines').onclick = () => glApplySelection(); });
