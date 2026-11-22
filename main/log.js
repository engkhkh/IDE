// Nova IDE - log file (userData/logs/main.log) for crashes and errors, so problems on other PCs can be diagnosed
'use strict';
const path = require('path');
const fs = require('fs');

let dir = null;
let file = null;
const MAX = 2 * 1024 * 1024;

function init(app) {
  dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  file = path.join(dir, 'main.log');
  write('info', `---- Nova IDE ${app.getVersion()} started (Electron ${process.versions.electron}, ${process.platform} ${process.arch}${app.isPackaged ? '' : ', development'}) ----`);
}

function write(level, ...args) {
  const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
  if (level === 'error') console.error(line.trim()); else if (process.argv.includes('--dev')) console.log(line.trim());
  if (!file) return;
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX) fs.renameSync(file, path.join(dir, 'main.old.log'));
    fs.appendFileSync(file, line);
  } catch {}
}

module.exports = {
  init,
  info: (...a) => write('info', ...a),
  warn: (...a) => write('warn', ...a),
  error: (...a) => write('error', ...a),
  debug: () => {},
  dir: () => dir,
  file: () => file
};
