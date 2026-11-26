// Nova IDE - Settings Sync (Tools > Settings Sync): Upload / Download your Options, dictionary words and extension
// list through a secret GitHub Gist, or Export / Import them as a file.
'use strict';

const SSY = { skip: /^(recent|window|lastUpdate|syncGistId$)/i };

async function ssPayload() {
  const settings = {};
  for (const [k, v] of Object.entries(state.settings)) if (!SSY.skip.test(k)) settings[k] = v;
  const exts = await api.ext.list().catch(() => []);
  return {
    app: 'Nova IDE', format: 1, at: new Date().toISOString(),
    settings,
    dictionary: await api.spell.userWords().catch(() => []),
    extensions: (exts || []).map((e) => ({ id: e.id, name: e.name, version: e.version, enabled: e.enabled }))
  };
}
// apply what came from another PC; returns a short report
async function ssApply(p) {
  if (!p || p.app !== 'Nova IDE' || !p.settings) throw new Error('This is not a Nova IDE settings file');
  const patch = {};
  for (const [k, v] of Object.entries(p.settings)) if (!SSY.skip.test(k) && JSON.stringify(state.settings[k]) !== JSON.stringify(v)) patch[k] = v;
  if (Object.keys(patch).length) await updateSetting(patch);
  const have = new Set(await api.spell.userWords().catch(() => []));
  const words = (p.dictionary || []).filter((w) => !have.has(w));
  for (const w of words) await api.spell.add(w);
  const installed = new Set(((await api.ext.list().catch(() => [])) || []).map((e) => e.id));
  const samples = (await api.ext.samples().catch(() => [])) || [];
  const missing = [];
  const added = [];
  for (const e of p.extensions || []) {
    if (installed.has(e.id)) continue;
    const s = samples.find((x) => x.id === e.id);
    if (s) { await api.ext.installSample(s.id).catch(() => {}); added.push(e.name || e.id); } else missing.push(e.name || e.id);
  }
  if (typeof scRecheckAll === 'function' && words.length) scRecheckAll();
  return { settings: Object.keys(patch), words: words.length, added, missing };
}
function ssReport(what, r) {
  showPanel('output');
  log(`\n------ Settings Sync: ${what} ------\n` +
    `${r.settings.length} setting(s) changed${r.settings.length ? `: ${r.settings.join(', ')}` : ''}\n` +
    `${r.words} word(s) added to your dictionary\n` +
    (r.added.length ? `Extensions installed: ${r.added.join(', ')}\n` : '') +
    (r.missing.length ? `Extensions to install by hand (Extensions > Manage): ${r.missing.join(', ')}\n` : ''), 'info');
  status(`Settings Sync: ${r.settings.length} setting(s), ${r.words} word(s)${r.added.length ? `, ${r.added.length} extension(s)` : ''}`);
}

async function ssUpload() {
  status('Settings Sync: uploading...');
  const r = await api.sync.upload(await ssPayload());
  if (r.error) { status(r.error); log(`Settings Sync: ${r.error}\n`, 'stderr'); return r; }
  if (r.gistId !== state.settings.syncGistId) await updateSetting({ syncGistId: r.gistId });
  status(`Settings uploaded${r.created ? ` to a new secret gist ${r.gistId}` : ''}`);
  log(`Settings Sync: uploaded to ${r.url || r.gistId}${r.created ? ' (enter this gist ID on your other PC: Tools > Settings Sync > Download)' : ''}\n`, 'info');
  return r;
}
async function ssDownload() {
  let id = state.settings.syncGistId;
  if (!id) { id = await ask('Gist ID of your Nova settings (shown when you uploaded them)', ''); if (!id) return; id = id.trim().replace(/^.*\//, ''); }
  status('Settings Sync: downloading...');
  const r = await api.sync.download(id);
  if (r.error) { status(r.error); log(`Settings Sync: ${r.error}\n`, 'stderr'); return r; }
  if (r.gistId !== state.settings.syncGistId) await updateSetting({ syncGistId: r.gistId });
  const rep = await ssApply(r.payload);
  ssReport(`downloaded (uploaded ${new Date(r.payload.at).toLocaleString()})`, rep);
  return rep;
}
async function ssExport() {
  const p = await ask('Export settings to file', `${state.root || ''}${state.root ? sep() : ''}nova-settings.json`);
  if (!p) return;
  await api.writeFile(p, JSON.stringify(await ssPayload(), null, 2));
  status(`Settings exported to ${p}`);
  return p;
}
async function ssImport() {
  const p = await ask('Import settings from file', `${state.root || ''}${state.root ? sep() : ''}nova-settings.json`);
  if (!p) return;
  let payload;
  try { payload = JSON.parse(await api.readFile(p)); } catch (e) { return status(`Could not read ${p}: ${e.message}`); }
  try { const rep = await ssApply(payload); ssReport(`imported from ${baseName(p)}`, rep); return rep; } catch (e) { status(e.message); }
}

Object.assign(commands, { syncUpload: () => ssUpload(), syncDownload: () => ssDownload(), syncExport: () => ssExport(), syncImport: () => ssImport() });
