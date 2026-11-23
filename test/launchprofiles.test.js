// launchSettings.json (Visual Studio launch profiles) and the async-exception rule for netcoredbg
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLP(files = {}) {
  const el = () => ({ classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, bottom: 0 }) });
  const opened = [];
  const ctx = {
    $: el, bus: { on() {} }, commands: { runNoDebug: () => 'ran' }, window: {}, state: { settings: {}, project: null, runId: null }, DBG: {},
    api: { on() {}, readFile: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); }, openExternal: (u) => opened.push(u) },
    status() {}, popup() {}, openFile() {}, renderStartupSelect() {}, localStorage: { getItem: () => null, setItem() {} },
    dirName: (p) => p.replace(/[\\/][^\\/]*$/, ''), baseName: (p) => p.split(/[\\/]/).pop(), sep: () => '/', normPathKey: (p) => p
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'launchprofiles.js'), 'utf8')}\nthis.lp = { lpParse, lpSplitArgs, lpProfiles, lpSelected, lpApply, lpForProject, lpOpenBrowserWhenReady, lpOutput, LP };`, ctx);
  return { ...ctx.lp, ctx, opened };
}
const J = (x) => JSON.parse(JSON.stringify(x));

const SETTINGS = `{
  // Visual Studio allows comments
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "IIS Express": { "commandName": "IISExpress", "launchBrowser": true },
    "Sample.WebApp": {
      "commandName": "Project",
      "launchBrowser": true,
      "launchUrl": "nexusmq",
      "applicationUrl": "https://localhost:7001;http://localhost:5690",
      "commandLineArgs": "--seed 3 \\"two words\\"",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", "URL_IN_STRING": "http://x//not-a-comment" },
    },
    "Worker": { "commandName": "Project", "workingDirectory": "data", "environmentVariables": { "ASPNETCORE_URLS": "http://+:8080" } }
  }
}`;

test('parse launchSettings.json: comments, trailing commas, // inside strings', () => {
  const { lpParse } = loadLP();
  const j = lpParse(SETTINGS);
  assert.strictEqual(j.profiles['Sample.WebApp'].environmentVariables.URL_IN_STRING, 'http://x//not-a-comment');
  assert.strictEqual(Object.keys(j.profiles).length, 3);
});

test('command line args with quotes', () => {
  const { lpSplitArgs } = loadLP();
  assert.deepStrictEqual(J(lpSplitArgs('--seed 3 "two words" a\\"b')), ['--seed', '3', 'two words', 'a\\"b']);
  assert.deepStrictEqual(J(lpSplitArgs('')), []);
});

test('profiles: only "Project" ones; the one named like the project is used', async () => {
  const csproj = '/src/Sample.WebApp/Sample.WebApp.csproj';
  const { lpProfiles, lpSelected } = loadLP({ '/src/Sample.WebApp/Properties/launchSettings.json': SETTINGS });
  assert.deepStrictEqual(J((await lpProfiles(csproj)).map((p) => p.name)), ['Sample.WebApp', 'Worker']);
  assert.strictEqual((await lpSelected(csproj)).name, 'Sample.WebApp');
  assert.strictEqual(await lpSelected('/other/None.csproj'), null);
});

test('apply a profile: URLs, environment, args, browser address, working folder', async () => {
  const csproj = '/src/Sample.WebApp/Sample.WebApp.csproj';
  const { lpForProject, lpProfiles, lpApply } = loadLP({ '/src/Sample.WebApp/Properties/launchSettings.json': SETTINGS });
  const a = await lpForProject(csproj);
  assert.strictEqual(a.env.ASPNETCORE_URLS, 'https://localhost:7001;http://localhost:5690');
  assert.strictEqual(a.env.ASPNETCORE_ENVIRONMENT, 'Development');
  assert.deepStrictEqual(J(a.args), ['--seed', '3', 'two words']);
  assert.strictEqual(a.browserUrl, 'https://localhost:7001/nexusmq');
  assert.strictEqual(a.cwd, '/src/Sample.WebApp');
  const w = lpApply((await lpProfiles(csproj))[1], csproj);
  assert.strictEqual(w.env.ASPNETCORE_URLS, 'http://+:8080'); // the profile's own variable wins
  assert.strictEqual(w.cwd, '/src/Sample.WebApp/data');
  assert.strictEqual(w.browserUrl, null);
});

test('the browser opens when the app is listening, once', () => {
  const { lpOpenBrowserWhenReady, lpOutput, opened, ctx } = loadLP();
  lpOpenBrowserWhenReady('http://localhost:5690/nexusmq');
  lpOutput('info: starting\n');
  assert.strictEqual(opened.length, 0);
  lpOutput('info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5690\n');
  lpOutput('Now listening on: http://localhost:5690\n');
  assert.deepStrictEqual(J(opened), ['http://localhost:5690/nexusmq']);
  ctx.state.settings.hotReloadBrowser = false;
  lpOpenBrowserWhenReady('http://localhost:1/');
  lpOutput('Now listening on: http://localhost:1\n');
  assert.strictEqual(opened.length, 1);
});

// ---------------- async exceptions (netcoredbg "user-unhandled") ----------------
function loadSkip(files, settings = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'debug.js'), 'utf8');
  const body = src.slice(src.indexOf('const DBG_LINES'), src.indexOf('async function showException'));
  const logs = [];
  const ctx = { state: { settings }, api: { readFile: async (p) => files[p] }, log: (t) => logs.push(t), baseName: (p) => p.split('/').pop(), DBG: { threadId: 1, stopped: true } };
  vm.createContext(ctx);
  vm.runInContext(`${body}\nthis.skip = dbgSkipAsyncException;`, ctx);
  return { skip: ctx.skip, logs, ctx };
}
function session(info, frames) {
  const calls = [];
  return { type: 'coreclr', caps: { supportsExceptionInfoRequest: true }, calls,
    request: async (cmd, args) => { calls.push(cmd); if (cmd === 'exceptionInfo') return info; if (cmd === 'stackTrace') return { stackFrames: frames }; return {}; } };
}
const NEXUS = { '/src/NexusConnect.cs': Array.from({ length: 80 }, (_, i) => (i === 70 ? '            await socket.ConnectAsync(new IPEndPoint(address, port), ct).ConfigureAwait(false);' : i === 20 ? '        throw new InvalidOperationException("boom");' : '')).join('\n') };
const USER_UNHANDLED = { exceptionId: 'CLR/System.Net.Sockets.SocketException', breakMode: 'userUnhandled', description: "An exception of type 'System.Net.Sockets.SocketException' occurred in System.Net.Sockets.dll but was not handled in user code: 'No connection could be made because the target machine actively refused it.'" };

test('exception passing out of an await in user code: logged and continued', async () => {
  const { skip, logs, ctx } = loadSkip(NEXUS);
  const s = session(USER_UNHANDLED, [{ name: 'System.Net.Sockets.Socket.AwaitableSocketAsyncEventArgs.ThrowException' }, { name: 'NexusMQ.Client.NexusConnect.AttemptAsync', line: 71, source: { path: '/src/NexusConnect.cs' } }]);
  assert.strictEqual(await skip(s, { reason: 'exception', threadId: 1 }), true);
  assert.ok(s.calls.includes('continue'));
  assert.ok(/Exception in async code at NexusConnect\.cs:71 \(System\.Net\.Sockets\.SocketException: 'No connection could be made/.test(logs[0]), logs[0]);
  assert.strictEqual(ctx.DBG.stopped, false);
});

test('async state machine frame (MoveNext) counts as async too', async () => {
  const { skip } = loadSkip({});
  const s = session(USER_UNHANDLED, [{ name: 'App.Worker.<RunAsync>d__4.MoveNext()', line: 9, source: { path: '/src/Worker.cs' } }]);
  assert.strictEqual(await skip(s, { reason: 'exception', threadId: 1 }), true);
});

test('still breaks: a plain throw, an unhandled exception, other adapters, or when the option asks', async () => {
  const plain = session(USER_UNHANDLED, [{ name: 'App.Go', line: 21, source: { path: '/src/NexusConnect.cs' } }]);
  assert.strictEqual(await loadSkip(NEXUS).skip(plain, { reason: 'exception' }), false);
  const unhandled = session({ ...USER_UNHANDLED, breakMode: 'unhandled', description: "An unhandled exception of type 'X' occurred" }, [{ name: 'A', line: 71, source: { path: '/src/NexusConnect.cs' } }]);
  assert.strictEqual(await loadSkip(NEXUS).skip(unhandled, { reason: 'exception' }), false);
  const node = { ...session(USER_UNHANDLED, []), type: 'pwa-node' };
  assert.strictEqual(await loadSkip(NEXUS).skip(node, { reason: 'exception' }), false);
  const opt = session(USER_UNHANDLED, [{ name: 'A', line: 71, source: { path: '/src/NexusConnect.cs' } }]);
  assert.strictEqual(await loadSkip(NEXUS, { breakOnAsyncUserUnhandled: true }).skip(opt, { reason: 'exception' }), false);
});
