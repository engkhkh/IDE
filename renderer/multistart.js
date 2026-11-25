// Nova IDE - multiple startup projects (Visual Studio's multi-project launch profiles)
// Profiles live next to the solution in <Solution>.slnLaunch (shared) or .slnLaunch.user (yours), the same JSON
// Visual Studio 2022 17.11+ writes: [{ "Name": "...", "Projects": [{ "Path": "src\\A\\A.csproj", "Action": "Start",
// "DebugTarget": "<launch profile>" }] }]. F5 debugs the "Start" projects and runs the "Start without debugging" ones;
// Ctrl+F5 runs them all; Shift+F5 stops everything.
'use strict';

const MS = { profiles: [], active: null, procs: [], browsers: new Map(), running: false, loadedFor: null };
const MS_ACTIONS = [['None', 'None'], ['Start', 'Start'], ['StartWithoutDebugging', 'Start without debugging']];

function msSolution() { return typeof SOL !== 'undefined' && SOL.model && SOL.model.path && /\.slnx?$/i.test(SOL.model.path) ? SOL.model.path : null; }
function msFiles(sln) {
  const base = sln.replace(/\.slnx?$/i, '');
  return [`${base}.slnLaunch.user`, `${base}.slnLaunch`, `${base}.slnxLaunch`];
}
// "src\\A\\A.csproj" (relative to the solution) <-> absolute path
function msAbs(sln, rel) {
  const dir = dirName(sln);
  const parts = `${dir}${sep()}${String(rel).replace(/[\\/]/g, sep())}`.split(sep());
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join(sep());
}
function msRel(sln, abs) {
  const dir = dirName(sln) + sep();
  return (abs.startsWith(dir) ? abs.slice(dir.length) : abs).replace(/[\\/]/g, '\\');
}

// read every profile file (yours first); a profile name seen once wins
async function msLoad() {
  const sln = msSolution();
  MS.profiles = [];
  MS.loadedFor = sln;
  if (!sln) return;
  const seen = new Set();
  for (const file of msFiles(sln)) {
    let text;
    try { text = await api.readFile(file); } catch { continue; }
    let list;
    try { list = lpParse(text); } catch (e) { status(`${baseName(file)} could not be read: ${e.message}`); continue; }
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !p.Name || seen.has(p.Name)) continue;
      seen.add(p.Name);
      // Visual Studio wrote the project path in "Name" in early versions, "Path" later
      const projects = (p.Projects || []).map((e) => ({ path: msAbs(sln, e.Path || e.Name || ''), action: e.Action || 'Start', target: e.DebugTarget || null })).filter((e) => /proj$/i.test(e.path));
      MS.profiles.push({ name: p.Name, projects, file, shared: !/\.user$/.test(file) });
    }
  }
  const saved = load(`multiStartup:${sln}`, null);
  MS.active = saved && MS.profiles.some((p) => p.name === saved) ? saved : null;
}

async function msSave(profile, { shared = false, oldName = null } = {}) {
  const sln = msSolution();
  const file = shared ? msFiles(sln)[1] : msFiles(sln)[0];
  let list = [];
  try { list = lpParse(await api.readFile(file)); if (!Array.isArray(list)) list = []; } catch { list = []; }
  const entry = {
    Name: profile.name,
    Projects: profile.projects.filter((e) => e.action !== 'None').map((e) => {
      const rel = msRel(sln, e.path);
      const o = { Path: rel, Name: rel, Action: e.action };
      if (e.target) o.DebugTarget = e.target;
      return o;
    })
  };
  list = list.filter((p) => p && p.Name !== profile.name && p.Name !== oldName);
  list.push(entry);
  await api.writeFile(file, `${JSON.stringify(list, null, 2)}\n`);
  // a profile moved between the shared and the personal file
  for (const other of msFiles(sln).slice(0, 2)) {
    if (other === file) continue;
    try {
      const l = lpParse(await api.readFile(other));
      if (Array.isArray(l) && l.some((p) => p && (p.Name === profile.name || p.Name === oldName))) await api.writeFile(other, `${JSON.stringify(l.filter((p) => p.Name !== profile.name && p.Name !== oldName), null, 2)}\n`);
    } catch { /* no such file */ }
  }
  await msLoad();
}
async function msDelete(name) {
  const sln = msSolution();
  for (const file of msFiles(sln)) {
    try {
      const l = lpParse(await api.readFile(file));
      if (Array.isArray(l) && l.some((p) => p && p.Name === name)) await api.writeFile(file, `${JSON.stringify(l.filter((p) => p.Name !== name), null, 2)}\n`);
    } catch { /* */ }
  }
  if (MS.active === name) msSetActive(null);
  await msLoad();
}

function msSetActive(name) {
  MS.active = name;
  const sln = msSolution();
  if (sln) store(`multiStartup:${sln}`, name);
  renderStartupSelect();
}

// ---------------- the startup project box: single projects + multi-project profiles ----------------
const msOrigRenderStartup = renderStartupSelect;
renderStartupSelect = function (...a) { // eslint-disable-line no-func-assign
  const r = msOrigRenderStartup.apply(this, a);
  const sel = $('#startupSelect');
  if (!msSolution() || sel.classList.contains('hidden')) return r;
  if (MS.loadedFor !== msSolution()) { msLoad().then(() => renderStartupSelect()); return r; }
  const g = document.createElement('optgroup');
  g.label = 'Multiple startup projects';
  for (const p of MS.profiles) { const o = document.createElement('option'); o.value = `ms:${p.name}`; o.textContent = `⧉ ${p.name}`; g.appendChild(o); }
  const c = document.createElement('option');
  c.value = 'ms::configure'; c.textContent = 'Configure Startup Projects...';
  g.appendChild(c);
  sel.appendChild(g);
  if (MS.active) sel.value = `ms:${MS.active}`;
  if (!DBG.root) $('#runLabel').textContent = window.startLabel();
  const lpBtn = $('#lpProfile');
  if (lpBtn && MS.active) lpBtn.classList.add('hidden');
  return r;
};
const msOrigStartLabel = window.startLabel;
window.startLabel = () => (MS.active && msSolution() ? MS.active : msOrigStartLabel());
const msOrigLpRender = lpRender;
lpRender = async function (...a) { await msOrigLpRender.apply(this, a); if (MS.active && msSolution()) $('#lpProfile').classList.add('hidden'); }; // eslint-disable-line no-func-assign
$('#startupSelect').onchange = (e) => {
  const v = e.target.value;
  if (v === 'ms::configure') { renderStartupSelect(); msShowDialog(); return; }
  if (v.startsWith('ms:')) { msSetActive(v.slice(3)); status(`Startup: ${v.slice(3)} (multiple projects)`); lpRender(); return; }
  if (MS.active) MS.active = null, store(`multiStartup:${msSolution()}`, null);
  setStartup(v);
  lpRender();
};

// ---------------- starting and stopping ----------------
async function msProfileNamed(csproj, name) {
  const list = await lpProfiles(csproj);
  const p = (name && list.find((x) => x.name === name)) || (await lpSelected(csproj));
  return p ? lpApply(p, csproj) : null;
}

async function msStart(debug) {
  const prof = MS.profiles.find((p) => p.name === MS.active);
  if (!prof) { status('Pick a startup profile (Configure Startup Projects)'); return; }
  if (DBG.root || DBG.starting || state.runId || MS.procs.length) { status('Already running: stop it first (Shift+F5)'); return; }
  const entries = prof.projects.filter((e) => e.action !== 'None');
  if (!entries.length) { status(`${prof.name} starts no projects`); return; }
  MS.running = true;
  DBG.starting = true;
  updateDebugUI();
  try {
    await saveAll();
    const code = await exec('build');
    if (code !== 0) { status('Build failed. Fix the errors and try again.'); return; }
    const cfg = $('#config').value || 'Debug';
    log(`\n------ Starting ${entries.length} project${entries.length === 1 ? '' : 's'} (${prof.name}): ${new Date().toLocaleTimeString()} ------\n`, 'info');
    for (const e of entries) {
      const name = baseName(e.path).replace(/\.\w+proj$/i, '');
      const lp = await msProfileNamed(e.path, e.target);
      if (debug && e.action === 'Start') {
        const r = await api.capture(`dotnet msbuild "${e.path}" -getProperty:TargetPath -p:Configuration=${cfg}`, dirName(e.path));
        const program = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
        if (!r.ok || !program) { log(`[${name}] Could not find the built program: ${r.stderr || r.stdout}\n`, 'stderr'); continue; }
        const config = { type: 'coreclr', request: 'launch', program, cwd: lp ? lp.cwd : dirName(e.path), args: lp ? lp.args : [], env: { DOTNET_ENVIRONMENT: 'Development', ...(lp ? lp.env : {}) }, console: 'internalConsole', justMyCode: true, stopAtEntry: false };
        log(`[${name}] Debugging${lp ? ` (launch profile ${lp.name}${lp.env.ASPNETCORE_URLS ? `, ${lp.env.ASPNETCORE_URLS}` : ''})` : ''}\n`, 'info');
        const s = await createSession('coreclr', null, config.cwd);
        if (!s) continue;
        s.name = name;
        s.prefix = `[${name}] `;
        if (!DBG.root) {
          DBG.root = s;
          DBG.config = { name, config };
          bus.emit('debugStarted', { session: s, name, type: 'coreclr' });
        } else { s.peer = true; s.parent = DBG.root; }
        if (lp && lp.browserUrl) MS.browsers.set(`s:${s.id}`, lp.browserUrl);
        updateDebugUI();
        try { await initSession(s, 'launch', config); } catch (err) { log(`[${name}] Could not start debugging: ${err.message}\n`, 'stderr'); }
      } else {
        const command = `dotnet run --no-build --project "${e.path}" -c ${cfg}${lp ? ` --launch-profile "${lp.name}"` : ''}`;
        log(`[${name}] > ${command}\n`, 'info');
        const id = await api.run({ command, cwd: dirName(e.path) });
        MS.procs.push({ id, name, midLine: false });
        if (lp && lp.browserUrl) MS.browsers.set(`p:${id}`, lp.browserUrl);
      }
    }
  } finally {
    DBG.starting = false;
    MS.running = MS.procs.length > 0 || !!DBG.root;
    updateDebugUI();
    if (MS.procs.length && !DBG.root) status(`Running ${MS.procs.length} project${MS.procs.length === 1 ? '' : 's'} (${prof.name})...`);
  }
}

async function msStopAll() {
  for (const p of MS.procs) api.kill(p.id);
}

// output of the programs started without the debugger: "[Name] line"
api.on('proc:data', ({ id, data, stream }) => {
  const p = MS.procs.find((x) => x.id === id);
  if (!p) return;
  let out = '';
  for (const part of String(data).split(/(\n)/)) {
    if (part === '\n') { out += part; p.midLine = false; continue; }
    if (!part) continue;
    if (!p.midLine) { out += `[${p.name}] `; p.midLine = true; }
    out += part;
  }
  log(out, stream === 'stderr' ? 'stderr' : null);
  msBrowser(`p:${id}`, String(data));
});
api.on('proc:exit', ({ id, code }) => {
  const i = MS.procs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const p = MS.procs[i];
  MS.procs.splice(i, 1);
  MS.browsers.delete(`p:${id}`);
  log(`${p.midLine ? '\n' : ''}[${p.name}] exited with code ${code}\n`, 'info');
  if (!MS.procs.length && !DBG.root) { MS.running = false; log('====== All projects ended ======\n', 'info'); status('Ready'); }
  updateDebugUI();
});
bus.on('debugEvent', (ev) => { if (ev.kind === 'output' && ev.session) msBrowser(`s:${ev.session.id}`, ev.text || ''); });
bus.on('debugEnded', () => { for (const k of [...MS.browsers.keys()]) if (k.startsWith('s:')) MS.browsers.delete(k); if (!MS.procs.length) MS.running = false; });
function msBrowser(key, text) {
  const url = MS.browsers.get(key);
  if (!url || !/Now listening on:|Application started\./.test(text)) return;
  MS.browsers.delete(key);
  if (state.settings.hotReloadBrowser !== false) api.openExternal(url);
}

// F5 / Ctrl+F5 / Shift+F5 with a multi-project profile
const msOrigDebugStart = commands.debugStart;
commands.debugStart = (...a) => (MS.active && msSolution() && !DBG.root && !MS.procs.length ? msStart(true) : msOrigDebugStart(...a));
const msOrigRunNoDebug = commands.runNoDebug;
commands.runNoDebug = (...a) => (MS.active && msSolution() ? msStart(false) : msOrigRunNoDebug(...a));
const msOrigStop = commands.stop;
commands.stop = async (...a) => { if (MS.procs.length) await msStopAll(); if (DBG.root || state.runId) return msOrigStop(...a); return undefined; };
const msOrigUpdateDebugUI = updateDebugUI;
updateDebugUI = function (...a) { // eslint-disable-line no-func-assign
  msOrigUpdateDebugUI.apply(this, a);
  if (MS.procs.length) { $('#btnStop').disabled = false; $('#btnRun').disabled = !DBG.root || !DBG.stopped; $('#btnRunNoDebug').disabled = true; }
};

// ---------------- Configure Startup Projects ----------------
const MSD = { profile: null, oldName: null };
async function msShowDialog() {
  const sln = msSolution();
  if (!sln) { status('Open a solution (.sln / .slnx) to set multiple startup projects'); return; }
  await msLoad();
  const start = MS.profiles.find((p) => p.name === MS.active) || MS.profiles[0];
  msEdit(start ? JSON.parse(JSON.stringify(start)) : null);
  $('#msDlg').classList.remove('hidden');
}
// the runnable projects: the profile's order first, then the rest
function msEdit(profile) {
  const all = runnable().map((p) => p.path);
  const p = profile || { name: msNewName(), projects: [], shared: false, isNew: true };
  const ordered = [...p.projects.filter((e) => all.some((x) => samePath(x, e.path))), ...all.filter((x) => !p.projects.some((e) => samePath(x, e.path))).map((x) => ({ path: x, action: 'None', target: null }))];
  MSD.profile = { ...p, projects: ordered };
  MSD.oldName = p.isNew ? null : p.name;
  msRenderDialog();
}
function msNewName() { let n = 'New Profile', i = 2; while (MS.profiles.some((p) => p.name === n)) n = `New Profile ${i++}`; return n; }
async function msRenderDialog() {
  const p = MSD.profile;
  const sel = $('#msProfiles');
  sel.innerHTML = '';
  for (const x of MS.profiles) sel.appendChild(h('option', { value: x.name }, x.name));
  if (MSD.oldName == null) sel.appendChild(h('option', { value: '' }, `(new) ${p.name}`));
  sel.value = MSD.oldName == null ? '' : MSD.oldName;
  $('#msName').value = p.name;
  $('#msShared').checked = !!p.shared;
  $('#msDelete').disabled = MSD.oldName == null;
  const t = $('#msTable');
  t.innerHTML = '';
  t.appendChild(h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Action'), h('th', {}, 'Debug Target'), h('th', {}, '')));
  for (let i = 0; i < p.projects.length; i++) {
    const e = p.projects[i];
    const name = baseName(e.path).replace(/\.\w+proj$/i, '');
    const action = h('select', { class: 'ms-action', 'data-project': name });
    for (const [v, label] of MS_ACTIONS) action.appendChild(h('option', { value: v }, label));
    action.value = e.action;
    action.onchange = () => { e.action = action.value; msRenderDialog(); };
    const target = h('select', { class: 'ms-target', 'data-project': name });
    target.appendChild(h('option', { value: '' }, '(default)'));
    for (const lp of await lpProfiles(e.path)) target.appendChild(h('option', { value: lp.name }, lp.name));
    target.value = e.target || '';
    target.disabled = e.action === 'None' || target.options.length === 1;
    target.onchange = () => { e.target = target.value || null; };
    const up = h('button', { title: 'Start earlier' }, '↑'); up.disabled = i === 0;
    up.onclick = () => { [p.projects[i - 1], p.projects[i]] = [p.projects[i], p.projects[i - 1]]; msRenderDialog(); };
    const down = h('button', { title: 'Start later' }, '↓'); down.disabled = i === p.projects.length - 1;
    down.onclick = () => { [p.projects[i + 1], p.projects[i]] = [p.projects[i], p.projects[i + 1]]; msRenderDialog(); };
    t.appendChild(h('tr', { class: e.action === 'None' ? 'ms-none' : '' }, h('td', {}, name), h('td', {}, action), h('td', {}, target), h('td', { class: 'ms-order' }, up, down)));
  }
  const n = p.projects.filter((e) => e.action !== 'None').length;
  $('#msSummary').textContent = `${n} project${n === 1 ? '' : 's'} will start, in this order. Saved to ${baseName(msFiles(msSolution())[$('#msShared').checked ? 1 : 0])}.`;
}
$('#msProfiles').onchange = () => { const v = $('#msProfiles').value; const p = MS.profiles.find((x) => x.name === v); if (p) msEdit(JSON.parse(JSON.stringify(p))); };
$('#msNew').onclick = () => msEdit(null);
$('#msShared').onchange = () => { MSD.profile.shared = $('#msShared').checked; msRenderDialog(); };
$('#msName').oninput = () => { MSD.profile.name = $('#msName').value; };
$('#msDelete').onclick = async () => { if (MSD.oldName == null || !confirm(`Delete the profile "${MSD.oldName}"?`)) return; await msDelete(MSD.oldName); const next = MS.profiles[0]; msEdit(next ? JSON.parse(JSON.stringify(next)) : null); renderStartupSelect(); };
$('#msCancel').onclick = () => $('#msDlg').classList.add('hidden');
$('#msClose').onclick = () => $('#msDlg').classList.add('hidden');
$('#msSave').onclick = async () => {
  const p = MSD.profile;
  p.name = ($('#msName').value || '').trim();
  if (!p.name) { status('Give the profile a name'); return; }
  if (MS.profiles.some((x) => x.name === p.name) && p.name !== MSD.oldName) { status(`A profile named "${p.name}" exists already`); return; }
  if (!p.projects.some((e) => e.action !== 'None')) { status('Choose at least one project to start'); return; }
  await msSave(p, { shared: $('#msShared').checked, oldName: MSD.oldName });
  $('#msDlg').classList.add('hidden');
  msSetActive(p.name);
  lpRender();
  status(`Startup: ${p.name} (multiple projects)`);
};
$('#msDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#msDlg').classList.add('hidden'); });

bus.on('folder', () => { MS.profiles = []; MS.active = null; MS.loadedFor = null; });
Object.assign(commands, { configureStartupProjects: () => msShowDialog() });
window.MS = MS;
