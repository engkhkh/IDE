// Nova IDE - updates (electron-updater). Off until you say where updates are published:
//   settings.json: "updateUrl": "https://example.com/nova-ide/"   (a folder with latest.yml + the installer)
//             or   "updateGithub": "owner/repo"                     (GitHub Releases)
'use strict';
const settings = require('./settings');
const log = require('./log');

let updater = null;
let app, send;
let state = { phase: 'idle', version: null, percent: 0, error: null };

function setState(patch) { state = { ...state, ...patch }; send('update:status', state); }

function getUpdater() {
  if (updater) return updater;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = log;
  updater.on('checking-for-update', () => setState({ phase: 'checking', error: null }));
  updater.on('update-available', (info) => setState({ phase: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '' }));
  updater.on('update-not-available', (info) => setState({ phase: 'latest', version: info && info.version }));
  updater.on('download-progress', (p) => setState({ phase: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => setState({ phase: 'ready', version: info.version }));
  updater.on('error', (e) => { log.error('update error', e); setState({ phase: 'error', error: e.message.split('\n')[0] }); });
  return updater;
}

async function configure() {
  const s = await settings.read();
  if (!s.updateUrl && !s.updateGithub) return false;
  const u = getUpdater();
  if (s.updateGithub) {
    const [owner, repo] = String(s.updateGithub).split('/');
    u.setFeedURL({ provider: 'github', owner, repo });
  } else u.setFeedURL({ provider: 'generic', url: s.updateUrl });
  if (!app.isPackaged) u.forceDevUpdateConfig = true; // lets updates be tested from a development run
  return true;
}

async function check() {
  if (!(await configure())) return { configured: false };
  const u = getUpdater();
  return new Promise((resolve) => {
    const done = (r) => { cleanup(); resolve({ configured: true, current: app.getVersion(), ...r }); };
    const onAvail = (info) => done({ available: true, version: info.version });
    const onNone = (info) => done({ available: false, version: info && info.version });
    const onErr = (e) => done({ error: e.message.split('\n')[0] });
    const cleanup = () => { u.off('update-available', onAvail); u.off('update-not-available', onNone); u.off('error', onErr); };
    u.on('update-available', onAvail); u.on('update-not-available', onNone); u.on('error', onErr);
    u.checkForUpdates().then((r) => { if (!r) done({ available: false, inactive: true }); }).catch(onErr);
  });
}

module.exports = {
  register({ ipcMain, send: s, app: a }) {
    send = s; app = a;
    ipcMain.handle('update:check', () => check());
    ipcMain.handle('update:download', async () => { try { await getUpdater().downloadUpdate(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
    // quit (after the usual "save changes?" question) and run the new installer
    ipcMain.handle('update:install', () => { getUpdater().quitAndInstall(false, true); });
    ipcMain.handle('update:state', () => state);
    // quiet check shortly after start, when updates are set up
    app.whenReady().then(async () => {
      const st = await settings.read();
      if (st.checkUpdatesOnStartup === false) return;
      setTimeout(async () => { try { const r = await check(); if (r.available) log.info(`update ${r.version} available`); } catch {} }, 8000);
    });
  }
};
