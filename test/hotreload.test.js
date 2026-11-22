// Phase 17: the Hot Reload status follows `dotnet watch` output (lines captured from .NET 8 SDK)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const el = () => ({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, addEventListener() {}, textContent: '', title: '' });
  const ctx = { $: el, api: { on() {} }, bus: { on() {} }, commands: {}, window: {}, state: { errors: [{ sev: 'error' }] }, renderErrors() {}, status() {}, baseName: (p) => p.split(/[\\/]/).pop(), ANSI_RE: /\x1b\[[0-9;?]*[A-Za-z]/g };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hotreload.js'), 'utf8')}\nthis.hrLine = hrLine; this.HR = HR;`, ctx);
  return ctx;
}
const feed = (ctx, text) => { for (const l of text.split('\n')) ctx.hrLine(l.replace(ctx.ANSI_RE, '')); };

test('hot reload: start, apply, nothing to apply', () => {
  const c = load();
  feed(c, 'dotnet watch 🔥 Hot reload enabled. For a list of supported edits, see https://aka.ms/dotnet/hot-reload.\ndotnet watch 🔧 Building...\n  app -> /x/bin/Debug/net8.0/app.dll\ndotnet watch 🚀 Started\nhello 1');
  assert.strictEqual(c.HR.state, 'ready');
  feed(c, 'dotnet watch ⌚ File changed: ./Program.cs.\ndotnet watch 🔥 Hot reload of changes succeeded.');
  assert.strictEqual(c.HR.state, 'applied');
  assert.strictEqual(c.HR.applied, 1);
  assert.ok(c.HR.events.some((e) => e.text === 'File changed: Program.cs'));
  feed(c, 'dotnet watch ⌚ File changed: ./Program.cs.\ndotnet watch ⌚ No hot reload changes to apply.');
  assert.strictEqual(c.HR.state, 'nochange');
});

test('hot reload: build errors, then a fix clears them', () => {
  const c = load();
  feed(c, 'dotnet watch 🚀 Started\ndotnet watch ⌚ File changed: ./Program.cs.\ndotnet watch ⌚ \x1b[40m\x1b[31m/x/Program.cs(8,60): error CS1010: Newline in constant\ndotnet watch ⌚ \x1b[40m\x1b[31m/x/Program.cs(8,62): error CS1002: ; expected');
  assert.strictEqual(c.HR.state, 'errors');
  assert.strictEqual(c.HR.errors, 2);
  feed(c, 'dotnet watch ⌚ File changed: ./Program.cs.');
  assert.strictEqual(c.HR.errors, 0);
  assert.strictEqual(c.state.errors.length, 0);
  feed(c, 'dotnet watch 🔥 Hot reload of changes succeeded.');
  assert.strictEqual(c.HR.state, 'applied');
});

test('hot reload: rude edit restarts; crash and waiting', () => {
  const c = load();
  feed(c, 'dotnet watch 🚀 Started\ndotnet watch ⌚ File changed: ./Program.cs.\ndotnet watch ⌚ Unable to apply hot reload because of a rude edit.\ndotnet watch ⌚ Exited\ndotnet watch 🔧 Building...\ndotnet watch 🚀 Started');
  assert.strictEqual(c.HR.state, 'ready');
  assert.strictEqual(JSON.stringify(c.HR.events.map((e) => e.kind)), JSON.stringify(['ready', 'applying', 'rude', 'ready']));
  assert.strictEqual(c.HR.events[3].text, 'App restarted');
  feed(c, 'dotnet watch ❌ Exited with error code 134\ndotnet watch ⏳ Waiting for a file to change before restarting dotnet...');
  assert.strictEqual(JSON.stringify(c.HR.events.slice(-2).map((e) => e.kind)), JSON.stringify(['crashed', 'waiting']));
  assert.ok(/code 134/.test(c.HR.events[c.HR.events.length - 2].text));
});
