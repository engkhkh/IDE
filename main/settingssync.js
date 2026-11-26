// Nova IDE - Settings Sync: your Options, dictionary words and the list of extensions in a secret GitHub Gist
// (signed in with the same GitHub account as Pull Requests: Git > Accounts, GITHUB_TOKEN or the GitHub CLI),
// so another PC gets them with "Download". Without GitHub: Export / Import a file (OneDrive, a USB stick...).
'use strict';

const { tokenFor, http } = require('./pullrequests');
const FILE = 'nova-settings.json';

async function target() {
  const s = await require('./settings').read();
  const host = s.syncGithubHost || 'github.com';
  const api = (s.githubApiUrl || (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)).replace(/\/$/, '');
  const auth = await tokenFor('github', host);
  if (!auth) throw new Error(`Settings Sync needs a GitHub sign-in for ${host}: add a token in Git > Accounts (scope "gist")`);
  return { api, headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, gistId: s.syncGistId || '' };
}

async function upload(payload) {
  const t = await target();
  const files = { [FILE]: { content: JSON.stringify(payload, null, 2) } };
  if (t.gistId) {
    const g = await http('PATCH', `${t.api}/gists/${t.gistId}`, { headers: t.headers, body: { files } });
    return { gistId: g.id, url: g.html_url, updated: g.updated_at };
  }
  const g = await http('POST', `${t.api}/gists`, { headers: t.headers, body: { description: 'Nova IDE settings (Settings Sync)', public: false, files } });
  return { gistId: g.id, url: g.html_url, updated: g.updated_at, created: true };
}
async function download(gistId) {
  const t = await target();
  const id = gistId || t.gistId;
  if (!id) throw new Error('No Settings Sync gist yet: Upload from your other PC first, or enter its gist ID');
  const g = await http('GET', `${t.api}/gists/${id}`, { headers: t.headers });
  const f = g.files && g.files[FILE];
  if (!f) throw new Error(`The gist ${id} has no ${FILE}`);
  let content = f.content;
  if (f.truncated && f.raw_url) content = await http('GET', f.raw_url, { headers: t.headers });
  return { gistId: g.id, updated: g.updated_at, payload: typeof content === 'string' ? JSON.parse(content) : content };
}

module.exports = {
  register({ ipcMain }) {
    const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { error: e.message }; } };
    ipcMain.handle('sync:upload', wrap((_e, payload) => upload(payload)));
    ipcMain.handle('sync:download', wrap((_e, gistId) => download(gistId)));
  }
};
