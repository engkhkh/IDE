// Nova IDE - .NET Hot Reload: run the startup project under `dotnet watch` and apply code edits to the
// running app when files are saved (rude edits restart it). Status in the status bar, errors in the Error List.
'use strict';

const HR = { runId: null, state: 'off', events: [], buf: '', project: null, errors: 0, applied: 0, startedAt: null };
const HR_LABEL = {
  building: '🔧 Hot Reload: building...', ready: '🔥 Hot Reload: ready', applying: '⏳ Hot Reload: applying...',
  applied: '🔥 Hot Reload: changes applied', nochange: '🔥 Hot Reload: no changes to apply', errors: '⛔ Hot Reload: build errors',
  rude: '🔁 Hot Reload: rude edit, restarting', crashed: '❌ Hot Reload: the app crashed', exited: '⏹ Hot Reload: the app exited', waiting: '⏳ Hot Reload: waiting for a change'
};

function hrEvent(kind, text) {
  HR.events.push({ at: new Date(), kind, text });
  if (HR.events.length > 200) HR.events.shift();
}
function hrSet(stateName, text) {
  HR.state = stateName;
  if (text) hrEvent(stateName, text);
  hrRender();
}
function hrRender() {
  const el = $('#stHot');
  const on = HR.runId != null;
  el.classList.toggle('hidden', !on && !HR.events.length);
  el.textContent = on ? (HR_LABEL[HR.state] || '🔥 Hot Reload') : '🔥 Hot Reload: stopped';
  el.className = `clickable hr-${HR.state}${!on && !HR.events.length ? ' hidden' : ''}`;
  $('#btnHotReload').classList.toggle('active', on);
  $('#btnHotReload').title = on ? 'Apply Code Changes (Alt+F10)' : 'Start With Hot Reload (Alt+Shift+F5)';
}

// the .NET project to run: the solution's startup project
function hrProject() {
  const p = state.project;
  if (p && p.type === 'dotnet' && p.startup && /\.(cs|fs|vb)proj$/i.test(p.startup)) return p.startup;
  return null;
}

async function hrStart() {
  if (DBG.root || DBG.starting) { status('Hot Reload runs without the debugger: stop debugging first (Shift+F5)'); return; }
  if (state.runId) { status('A process is already running. Stop it first (Shift+F5).'); return; }
  const proj = hrProject();
  if (!proj) { status('Hot Reload needs a .NET startup project'); log('Hot Reload needs a .NET project: open a folder with a .csproj or a solution and pick the startup project.\n', 'info'); showPanel('output'); return; }
  HR.project = proj; HR.buf = ''; HR.errors = 0; HR.applied = 0; HR.events = []; HR.startedAt = Date.now();
  const cfg = $('#config') ? $('#config').value : 'Debug';
  const lpName = typeof lpChosenName === 'function' ? lpChosenName(proj) : null;
  const command = `dotnet watch --non-interactive --project "${proj}" run -c ${cfg}${lpName ? ` --launch-profile "${lpName}"` : ''}`;
  hrSet('building', `Starting ${baseName(proj)} with Hot Reload`);
  state.errors = []; renderErrors();
  const env = { DOTNET_WATCH_RESTART_ON_RUDE_EDIT: '1' };
  if (state.settings.hotReloadBrowser === false) env.DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER = '1';
  const done = exec('run', command, env);
  for (let i = 0; i < 100 && !state.runId; i++) await new Promise((r) => setTimeout(r, 30));
  HR.runId = state.runId;
  hrRender();
  done.then(() => { HR.runId = null; hrSet('off', 'Hot Reload session ended'); });
}

// Apply now: save everything (dotnet watch picks up the saved files)
async function hrApply() {
  if (HR.runId == null) return hrStart();
  const dirty = state.tabs.filter(isDirty).length;
  await saveAll();
  if (!dirty) { status('Hot Reload: no unsaved changes (saved edits are applied automatically)'); return; }
  status('Hot Reload: applying code changes...');
}

// read `dotnet watch` lines from the run output
api.on('proc:data', ({ id, data }) => {
  if (id !== HR.runId) return;
  HR.buf += String(data).replace(ANSI_RE, '');
  const lines = HR.buf.split(/\r?\n/);
  HR.buf = lines.pop();
  for (const line of lines) hrLine(line);
});
function hrLine(line) {
  const m = /^dotnet watch \S*\s*(.*)$/.exec(line.trim());
  if (!m) return;
  const t = m[1];
  let x;
  if (/^Building/.test(t)) hrSet('building');
  else if (/^Started/.test(t)) { if (HR.restarting) status('Hot Reload: the app restarted with your changes'); hrSet('ready', HR.restarting ? 'App restarted' : 'App started'); HR.restarting = false; }
  else if ((x = /^File changed: (.+?)\.?$/.exec(t))) {
    // a new edit: the old build errors no longer apply
    if (HR.errors) { state.errors = []; renderErrors(); HR.errors = 0; }
    hrSet('applying', `File changed: ${baseName(x[1])}`);
  } else if (/Hot reload of changes succeeded/i.test(t)) { HR.applied++; HR.appliedAt = Date.now(); hrSet('applied', 'Changes applied'); status('Hot Reload: code changes applied'); }
  // one save can reach dotnet watch as two file events: the second finds nothing new, which is not news
  else if (/No hot reload changes to apply/i.test(t)) { if (HR.state === 'applied' && Date.now() - (HR.appliedAt || 0) < 3000) hrEvent('nochange', 'No changes to apply'); else hrSet('nochange', 'No changes to apply'); }
  else if (/\berror [A-Z]+\d+\b/.test(t)) {
    HR.errors++;
    const msg = t.replace(/^.*?:\s*error\s+/, 'error ');
    hrSet('errors', msg);
    status(`Hot Reload: ${HR.errors} build error${HR.errors === 1 ? '' : 's'} (see the Error List)`);
  } else if (/rude edit/i.test(t)) { HR.restarting = true; hrSet('rude', 'Rude edit: the change can\'t be applied while running, restarting the app'); status('Hot Reload: rude edit, restarting the app'); }
  else if ((x = /^Exited with error code (-?\d+)/.exec(t))) hrSet('crashed', `The app exited with code ${x[1]}`);
  else if (/^Exited\b/.test(t)) { if (!HR.restarting) hrSet('exited', 'The app exited'); }
  else if (/^Waiting for a file to change/.test(t)) hrSet('waiting', 'Waiting for a file to change before restarting');
}

// status bar: recent Hot Reload events + actions
$('#stHot').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = $('#stHot').getBoundingClientRect();
  const items = HR.events.slice(-12).reverse().map((ev) => ({ label: `${ev.at.toLocaleTimeString()}  ${ev.text}`, disabled: true }));
  popup(r.left, r.top - Math.min(16, items.length + 3) * 24, [
    ...(HR.runId != null ? [{ label: 'Apply Code Changes (Alt+F10)', run: () => hrApply() }, { label: 'Stop (Shift+F5)', run: () => commands.stop() }] : [{ label: 'Start With Hot Reload (Alt+Shift+F5)', run: () => hrStart() }]),
    { label: 'Show Output', run: () => showPanel('output') },
    ...(items.length ? ['-', ...items] : [])
  ]);
});

Object.assign(commands, {
  hotReloadStart: () => hrStart(),
  hotReloadApply: () => hrApply()
});
bus.on('ready', () => hrRender());
window.HR = HR;
