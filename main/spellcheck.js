// Nova IDE - spell checker for comments, strings and text (like Visual Studio's): Hunspell English dictionary
// (dictionary-en) through nspell, plus the user's own words (exclusion.dic in the user data folder).
'use strict';

const fs = require('fs');
const path = require('path');

let checker = null;
let userFile = null;
const userWords = new Set();
const cache = new Map(); // word -> correct?

function dictDir() {
  // the package only exports index.js (ESM): find its folder next to ours
  const candidates = [path.join(__dirname, '..', 'node_modules', 'dictionary-en'), path.join(process.resourcesPath || '', 'app.asar', 'node_modules', 'dictionary-en')];
  return candidates.find((d) => { try { return fs.existsSync(path.join(d, 'index.dic')); } catch { return false; } });
}
function load() {
  if (checker) return checker;
  const nspell = require('nspell');
  const dir = dictDir();
  if (!dir) throw new Error('The English dictionary (dictionary-en) is missing: run "npm install"');
  checker = nspell(fs.readFileSync(path.join(dir, 'index.aff')), fs.readFileSync(path.join(dir, 'index.dic')));
  for (const w of userWords) checker.add(w);
  return checker;
}
function loadUser(app) {
  userFile = path.join(app.getPath('userData'), 'exclusion.dic');
  try { for (const w of fs.readFileSync(userFile, 'utf8').split(/\r?\n/)) if (w.trim()) userWords.add(w.trim()); } catch {}
}
function correct(word, extra) {
  if (userWords.has(word) || (extra && extra.has(word))) return true;
  if (cache.has(word)) return cache.get(word);
  const c = load();
  // "Json", "HTTP": also try the lower-case form, like Visual Studio's checker
  const ok = c.correct(word) || c.correct(word.toLowerCase());
  cache.set(word, ok);
  return ok;
}

module.exports = {
  correct, load,
  register({ ipcMain, app }) {
    loadUser(app);
    ipcMain.handle('spell:check', (_e, words, extraWords) => {
      const extra = new Set(extraWords || []);
      try { return { wrong: words.filter((w) => !correct(w, extra)) }; } catch (e) { return { error: e.message }; }
    });
    ipcMain.handle('spell:suggest', (_e, word) => { try { return load().suggest(word).slice(0, 6); } catch { return []; } });
    ipcMain.handle('spell:add', (_e, word) => {
      if (!word || userWords.has(word)) return true;
      userWords.add(word);
      if (checker) checker.add(word);
      cache.delete(word);
      try { fs.appendFileSync(userFile, `${word}\n`); } catch {}
      return true;
    });
    ipcMain.handle('spell:userWords', () => [...userWords]);
  }
};
