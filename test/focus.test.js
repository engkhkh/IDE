// Delayed autofocus in dialogs must not move the caret out of a field the user is typing in (e2e13 flake)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const fn = new Function('document', `${src.slice(src.indexOf('function focusIfIdle'), src.indexOf('const ANSI_RE'))}; return focusIfIdle;`);

// activeTag: what has focus; inDialog: whether it is in the same dialog as the element
function env(activeTag, inDialog = true) {
  const calls = [];
  const active = activeTag ? { tagName: activeTag, disabled: false } : { tagName: 'BODY' };
  const box = { contains: (x) => x === active ? inDialog && !!activeTag : true };
  const el = { tagName: 'INPUT', focus: () => calls.push('focus'), closest: () => box };
  return { calls, el, doc: { activeElement: active } };
}

test('focusIfIdle focuses when nothing is being typed in', () => {
  const e = env(null);
  fn(e.doc)(e.el);
  assert.deepStrictEqual(e.calls, ['focus']);
});

test('focusIfIdle leaves the caret where the user already is', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const e = env(tag);
    fn(e.doc)(e.el);
    assert.deepStrictEqual(e.calls, [], tag);
  }
});

test('focusIfIdle still focuses the dialog when the caret is in the editor behind it', () => {
  const e = env('TEXTAREA', false); // Monaco's hidden textarea
  fn(e.doc)(e.el);
  assert.deepStrictEqual(e.calls, ['focus']);
});

test('no dialog autofocuses with a bare setTimeout(...focus())', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'renderer')).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
    assert.ok(!/setTimeout\(\(\) => \w+\.focus\(\), \d+\)/.test(s), f);
  }
});
