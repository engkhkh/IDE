// Nova IDE - Workspace Trust (Restricted Mode): a folder you haven't trusted can be read and edited, but its code
// doesn't run — no build, run, debug, tests, Hot Reload, profiler, Containers build, .http requests or agent
// builds — until you trust it. Like Visual Studio's "trusted locations" / Passenger's "code that waits for your trust".
'use strict';

const TR = { trusted: true, asked: null };

async function trCheck() {
  TR.trusted = state.root ? await api.trust.get(state.root) : true;
  $('#trustBar').classList.toggle('hidden', TR.trusted);
  $('#stTrust').classList.toggle('hidden', TR.trusted);
  return TR.trusted;
}
// ask once; resolves true when the folder is (now) trusted
function trAsk(what) {
  if (TR.trusted) return Promise.resolve(true);
  if (TR.asked) return TR.asked;
  $('#trWhat').textContent = what ? `Nova is about to ${what}. ` : '';
  $('#trFolder').textContent = state.root;
  $('#trDlg').classList.remove('hidden');
  TR.asked = new Promise((resolve) => {
    const done = async (yes) => {
      $('#trDlg').classList.add('hidden');
      TR.asked = null;
      if (yes) { await api.trust.set(state.root, true); await trCheck(); status('Folder trusted'); }
      else status('Restricted Mode: the folder\'s code was not run');
      resolve(yes);
    };
    $('#trYes').onclick = () => done(true);
    $('#trNo').onclick = () => done(false);
  });
  return TR.asked;
}
// wrap everything that runs the folder's code
const trGuard = (what, fn) => async function (...args) { if (!(await trAsk(what))) return null; return fn.apply(this, args); };
exec = trGuard('build or run code from this folder', exec); // eslint-disable-line no-func-assign
for (const [cmd, what] of Object.entries({ debugStart: 'start debugging', runNoDebug: 'run the program', hotReloadStart: 'start Hot Reload', performanceProfiler: 'profile the program', testRunAll: 'run its tests', testRunFailed: 'run its tests', testRunContext: 'run its tests', testDebugContext: 'debug its tests', httpSendRequest: 'send an HTTP request from this folder' })) {
  if (typeof commands[cmd] === 'function') commands[cmd] = trGuard(what, commands[cmd]);
}
if (typeof runNodes === 'function') runNodes = trGuard('run its tests', runNodes); // eslint-disable-line no-global-assign
if (typeof hcSend === 'function') hcSend = trGuard('send an HTTP request from this folder', hcSend); // eslint-disable-line no-global-assign
if (typeof ctRun === 'function') ctRun = trGuard('run Docker for this folder', ctRun); // eslint-disable-line no-global-assign

Object.assign(commands, {
  trustFolder: async () => { if (!state.root) return; await api.trust.set(state.root, true); await trCheck(); status('Folder trusted'); },
  untrustFolder: async () => { if (!state.root) return; await api.trust.set(state.root, false); await trCheck(); status('Restricted Mode'); }
});
bus.on('ready', () => {
  $('#trBarTrust').onclick = () => trAsk('');
  $('#stTrust').onclick = () => trAsk('');
});
bus.on('folder', () => trCheck());
bus.on('settings', () => { if (state.root) trCheck(); });
