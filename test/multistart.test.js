// Multiple startup projects: Visual Studio's .slnLaunch / .slnLaunch.user files
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(files) {
  const el = () => ({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, addEventListener() {}, appendChild() {}, set onchange(v) {}, set onclick(v) {}, set oninput(v) {} });
  const store = new Map();
  const ctx = {
    $: el, bus: { on() {} }, window: { startLabel: () => 'Start' }, state: { settings: {} }, DBG: {},
    commands: { debugStart() {}, runNoDebug() {}, stop() {} }, SOL: { model: { path: '/w/Mesh/Mesh.slnx' } },
    api: { on() {}, readFile: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); }, writeFile: async (p, t) => { files[p] = t; } },
    status() {}, renderStartupSelect() {}, lpRender: async () => {}, updateDebugUI() {}, store: (k, v) => store.set(k, v), load: (k, d) => (store.has(k) ? store.get(k) : d),
    dirName: (p) => p.replace(/[\\/][^\\/]*$/, ''), baseName: (p) => p.split(/[\\/]/).pop(), sep: () => '/', samePath: (a, b) => a === b, runnable: () => [], h: () => el()
  };
  vm.createContext(ctx);
  const lp = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'launchprofiles.js'), 'utf8').match(/function lpParse[\s\S]*?\n}\n/)[0];
  vm.runInContext(`${lp}\n${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'multistart.js'), 'utf8')}\nthis.ms = { MS, msLoad, msSave, msDelete, msAbs, msRel, msFiles };`, ctx);
  return { ...ctx.ms, files, store };
}
const J = (x) => JSON.parse(JSON.stringify(x));

test('project paths are relative to the solution, with backslashes (like Visual Studio)', () => {
  const { msAbs, msRel, msFiles } = load({});
  assert.strictEqual(msAbs('/w/Mesh/Mesh.slnx', 'src\\Server\\Server.csproj'), '/w/Mesh/src/Server/Server.csproj');
  assert.strictEqual(msAbs('/w/Mesh/Mesh.slnx', '..\\Other\\O.csproj'), '/w/Other/O.csproj');
  assert.strictEqual(msRel('/w/Mesh/Mesh.slnx', '/w/Mesh/src/Server/Server.csproj'), 'src\\Server\\Server.csproj');
  assert.deepStrictEqual(J(msFiles('/w/Mesh/Mesh.sln')), ['/w/Mesh/Mesh.slnLaunch.user', '/w/Mesh/Mesh.slnLaunch', '/w/Mesh/Mesh.slnxLaunch']);
});

test('reads both Visual Studio styles ("Name" and "Path"), yours first, comments allowed', async () => {
  const { MS, msLoad } = load({
    '/w/Mesh/Mesh.slnLaunch': `[
      // shared with the team
      { "Name": "All", "Projects": [
        { "Name": "src\\\\Server\\\\Server.csproj", "Action": "Start", "DebugTarget": "Server" },
        { "Name": "samples\\\\Producer\\\\Producer.csproj", "Action": "StartWithoutDebugging" },
      ] },
      { "Name": "Mine", "Projects": [] }
    ]`,
    '/w/Mesh/Mesh.slnLaunch.user': JSON.stringify([{ Name: 'Mine', Projects: [{ Path: 'src\\Server\\Server.csproj', Action: 'Start' }] }])
  });
  await msLoad();
  assert.deepStrictEqual(J(MS.profiles.map((p) => [p.name, p.shared, p.projects.map((e) => [e.path, e.action, e.target])])), [
    ['Mine', false, [['/w/Mesh/src/Server/Server.csproj', 'Start', null]]],
    ['All', true, [['/w/Mesh/src/Server/Server.csproj', 'Start', 'Server'], ['/w/Mesh/samples/Producer/Producer.csproj', 'StartWithoutDebugging', null]]]
  ]);
  assert.strictEqual(MS.active, null);
});

test('save writes Visual Studio JSON to .slnLaunch.user; sharing moves it to .slnLaunch', async () => {
  const files = {};
  const { MS, msSave, msLoad, msDelete } = load(files);
  await msLoad();
  const p = { name: 'Server + Producer', projects: [
    { path: '/w/Mesh/src/Server/Server.csproj', action: 'Start', target: 'Server' },
    { path: '/w/Mesh/samples/Producer/Producer.csproj', action: 'StartWithoutDebugging', target: null },
    { path: '/w/Mesh/samples/Consumer/Consumer.csproj', action: 'None', target: null }
  ] };
  await msSave(p);
  const written = JSON.parse(files['/w/Mesh/Mesh.slnLaunch.user']);
  assert.deepStrictEqual(written, [{ Name: 'Server + Producer', Projects: [
    { Path: 'src\\Server\\Server.csproj', Name: 'src\\Server\\Server.csproj', Action: 'Start', DebugTarget: 'Server' },
    { Path: 'samples\\Producer\\Producer.csproj', Name: 'samples\\Producer\\Producer.csproj', Action: 'StartWithoutDebugging' }
  ] }]);
  assert.strictEqual(MS.profiles.length, 1);
  // share it (and rename): it leaves the personal file
  await msSave({ ...p, name: 'Backend' }, { shared: true, oldName: 'Server + Producer' });
  assert.deepStrictEqual(JSON.parse(files['/w/Mesh/Mesh.slnLaunch.user']), []);
  assert.strictEqual(JSON.parse(files['/w/Mesh/Mesh.slnLaunch'])[0].Name, 'Backend');
  assert.deepStrictEqual(J(MS.profiles.map((x) => [x.name, x.shared])), [['Backend', true]]);
  await msDelete('Backend');
  assert.deepStrictEqual(JSON.parse(files['/w/Mesh/Mesh.slnLaunch']), []);
  assert.strictEqual(MS.profiles.length, 0);
});
