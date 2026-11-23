// Nova IDE - launch profiles (Properties/launchSettings.json), like Visual Studio:
// F5 and the profiler start the built program with the profile's URLs, environment, arguments and working folder,
// and open the browser when the web app is listening; Ctrl+F5 / Hot Reload pass --launch-profile to dotnet.
'use strict';

const LP = { cache: new Map(), pendingBrowser: null };

// launchSettings.json allows comments and trailing commas
function lpParse(text) {
  const noComments = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}
// "a b \"c d\"" -> ['a', 'b', 'c d']
function lpSplitArgs(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] != null ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

// the profiles that run the project itself (IIS Express / Docker profiles need other hosts)
async function lpProfiles(csproj) {
  if (!csproj) return [];
  const file = `${dirName(csproj)}${sep()}Properties${sep()}launchSettings.json`;
  let text;
  try { text = await api.readFile(file); } catch { return []; }
  try {
    const json = lpParse(text);
    return Object.entries(json.profiles || {}).filter(([, p]) => !p.commandName || p.commandName === 'Project').map(([name, p]) => ({ name, ...p, file }));
  } catch (e) { status(`launchSettings.json could not be read: ${e.message}`); return []; }
}
const lpKey = (csproj) => `nova.launchProfile:${normPathKey(csproj)}`;
function lpChosenName(csproj) { try { return localStorage.getItem(lpKey(csproj)); } catch { return null; } }

// the profile to use: the one picked, else the one named like the project, else the first
async function lpSelected(csproj) {
  const list = await lpProfiles(csproj);
  if (!list.length) return null;
  const want = lpChosenName(csproj);
  const proj = baseName(csproj).replace(/\.\w+proj$/i, '');
  return list.find((p) => p.name === want) || list.find((p) => p.name === proj) || list[0];
}

// what starting with a profile means: environment, arguments, working folder, browser address
function lpApply(profile, csproj) {
  const env = {};
  for (const [k, v] of Object.entries(profile.environmentVariables || {})) env[k] = String(v).replace(/%(\w+)%/g, (m, n) => (n in env ? env[n] : m));
  if (profile.applicationUrl && !env.ASPNETCORE_URLS && !env.URLS) env.ASPNETCORE_URLS = profile.applicationUrl;
  const projDir = dirName(csproj);
  let cwd = projDir;
  if (profile.workingDirectory) {
    cwd = profile.workingDirectory.replace(/\$\(ProjectDir\)[\\/]?/gi, `${projDir}${sep()}`).replace(/[\\/]+$/, '');
    if (!/^([a-zA-Z]:)?[\\/]/.test(cwd)) cwd = `${projDir}${sep()}${cwd}`;
  }
  let browserUrl = null;
  if (profile.launchBrowser) {
    const base = (profile.applicationUrl || env.ASPNETCORE_URLS || 'http://localhost:5000').split(';')[0].trim().replace(/\/\/(\*|\+|0\.0\.0\.0|\[::\])/, '//localhost').replace(/\/$/, '');
    const lu = profile.launchUrl || '';
    browserUrl = /^https?:\/\//i.test(lu) ? lu : `${base}/${lu.replace(/^\//, '')}`.replace(/\/$/, lu ? '' : '/');
  }
  return { name: profile.name, env, args: lpSplitArgs(profile.commandLineArgs), cwd, browserUrl };
}

// for the debugger / profiler: everything at once (null when the project has no launch profile)
async function lpForProject(csproj) {
  const p = await lpSelected(csproj);
  return p ? lpApply(p, csproj) : null;
}

// open the browser once the web app says it is listening (or has started)
function lpOpenBrowserWhenReady(url) {
  if (!url || state.settings.hotReloadBrowser === false) { LP.pendingBrowser = null; return; }
  LP.pendingBrowser = { url, at: Date.now() };
}
function lpOutput(text) {
  if (!LP.pendingBrowser) return;
  if (/Now listening on:|Application started\./.test(text)) {
    const url = LP.pendingBrowser.url;
    LP.pendingBrowser = null;
    api.openExternal(url);
    status(`Opened ${url}`);
  }
}
bus.on('debugEvent', (ev) => { if (ev.kind === 'output') lpOutput(ev.text || ''); });
bus.on('debugEnded', () => { LP.pendingBrowser = null; });
api.on('proc:data', ({ id, data }) => { if (id === state.runId) lpOutput(String(data)); });

// Debug > Launch Profile...: pick one of the startup project's profiles
async function lpPick(anchor) {
  const proj = state.project && state.project.type === 'dotnet' ? state.project.startup : null;
  if (!proj) { status('Launch profiles belong to a .NET startup project'); return; }
  const list = await lpProfiles(proj);
  if (!list.length) { status(`${baseName(proj)} has no launch profiles (Properties/launchSettings.json)`); return; }
  const cur = await lpSelected(proj);
  const r = anchor ? anchor.getBoundingClientRect() : { left: 200, bottom: 40 };
  popup(r.left, r.bottom, [
    ...list.map((p) => ({ label: `${p === cur || p.name === cur.name ? '● ' : '   '}${p.name}${p.applicationUrl ? `  (${p.applicationUrl.split(';')[0]})` : ''}`, run: () => { try { localStorage.setItem(lpKey(proj), p.name); } catch { /* */ } status(`Launch profile: ${p.name}`); lpRender(); } })),
    '-',
    { label: 'Open launchSettings.json', run: () => openFile(list[0].file) }
  ]);
}
// show the profile next to the startup project
async function lpRender() {
  const el = $('#lpProfile');
  if (!el) return;
  const proj = state.project && state.project.type === 'dotnet' ? state.project.startup : null;
  const p = proj ? await lpSelected(proj) : null;
  el.classList.toggle('hidden', !p);
  if (p) { el.textContent = `${p.name} ▾`; el.title = `Launch profile: ${p.name}${p.applicationUrl ? `\n${p.applicationUrl}` : ''}\nClick to choose another (Properties/launchSettings.json)`; }
}
$('#lpProfile').addEventListener('click', (e) => { e.stopPropagation(); lpPick(e.currentTarget); });
bus.on('folder', () => setTimeout(lpRender, 0));
bus.on('ready', () => lpRender());

Object.assign(commands, { launchProfile: () => lpPick($('#lpProfile')) });
const lpOrigRunNoDebug = commands.runNoDebug;
commands.runNoDebug = async (...a) => {
  const proj = state.project && state.project.type === 'dotnet' ? state.project.startup : null;
  if (proj && !state.runId && !DBG.root) { const lp = await lpForProject(proj); if (lp) lpOpenBrowserWhenReady(lp.browserUrl); }
  return lpOrigRunNoDebug(...a);
};
// keep the profile button next to the startup project
const lpOrigRenderStartup = renderStartupSelect;
renderStartupSelect = function (...a) { const r = lpOrigRenderStartup.apply(this, a); lpRender(); return r; }; // eslint-disable-line no-func-assign
window.LP = LP;
