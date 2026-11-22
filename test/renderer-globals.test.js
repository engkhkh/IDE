'use strict';
// Renderer files are classic <script>s sharing one global scope: a top-level name declared twice
// (const/let/class) stops the second file from loading at all. Catch that here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('renderer scripts do not declare the same top-level name twice', () => {
  const dir = path.join(__dirname, '..', 'renderer');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"/]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 15, `found ${scripts.length} scripts`);
  const seen = new Map();
  const dupes = [];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== f) dupes.push(`${m[1]} (${seen.get(m[1])} and ${f})`);
      else seen.set(m[1], f);
    }
  }
  assert.deepStrictEqual(dupes, []);
});
