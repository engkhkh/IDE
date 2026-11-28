// Nova IDE - project files (.csproj / .props / .targets): evaluated property values for the editor's hovers,
// from MSBuild itself (`dotnet msbuild -getProperty`), so $(OutputPath), TargetFramework etc. show what the build sees.
'use strict';

const { execFile } = require('child_process');
const path = require('path');

const cache = new Map(); // project|names -> { at, value }
function evaluate(project, names, configuration = 'Debug') {
  const list = [...new Set([...names, 'MSBuildProjectName'])]; // two or more names: MSBuild answers in JSON
  const key = `${project}|${configuration}|${list.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20000) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    execFile('dotnet', ['msbuild', project, '-nologo', `-p:Configuration=${configuration}`, ...list.map((n) => `-getProperty:${n}`)],
      { cwd: path.dirname(project), timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        let value;
        try { value = { properties: JSON.parse(stdout).Properties }; } catch { value = { error: String(stderr || stdout || (err && err.message) || 'dotnet msbuild failed').trim().split('\n').slice(-3).join('\n') }; }
        if (!value.error) cache.set(key, { at: Date.now(), value });
        resolve(value);
      });
  });
}
module.exports = {
  evaluate,
  register({ ipcMain }) {
    ipcMain.handle('msbuild:evaluate', (_e, project, names, configuration) => evaluate(project, names, configuration));
  }
};
