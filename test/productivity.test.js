// Phase 21 (what Visual Studio / Rider / VS Code have that Nova lacked): EditorConfig, Task List,
// Replace in Files, Markdown preview, .http files
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(files, extra = '') {
  const el = () => ({ classList: { toggle() {}, add() {}, remove() {} }, set onclick(v) {}, set oninput(v) {}, addEventListener() {} });
  const ctx = {
    $: el, bus: { on() {}, emit() {} }, state: { settings: {}, tabs: [], root: '/w' }, commands: {}, LANGS: {},
    api: {}, status() {}, saveTab() {}, activate() {}, registerProviders() {}, showPanel() {}, store() {}, load: (k, d) => d,
    dirName: (p) => p.replace(/[\\/][^\\/]*$/, ''), baseName: (p) => p.split(/[\\/]/).pop(), sep: () => '/',
    normPathKey: (p) => p.toLowerCase(), samePath: (a, b) => a.toLowerCase() === b.toLowerCase(), console
  };
  vm.createContext(ctx);
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
  const lp = src('launchprofiles.js').match(/function lpParse[\s\S]*?\n}\n/)[0];
  vm.runInContext(`${lp}\n${files.map(src).join('\n')}\n${extra}`, ctx);
  return ctx;
}
const J = (x) => JSON.parse(JSON.stringify(x));

test('EditorConfig: sections, globs and nearer files win', () => {
  const c = load(['editorconfig.js'], 'this.ec = { ecParse, ecMatches, ecProps };');
  const { ecParse, ecMatches, ecProps } = c.ec;
  const root = ecParse('root = true\n\n[*]\nindent_style = space\nindent_size = 4\ntrim_trailing_whitespace = true\n\n[*.{json,yml}]\nindent_size = 2\n\n[Makefile]\nindent_style = tab\n\n[src/**/gen/*.cs]\ntrim_trailing_whitespace = false # generated\n');
  assert.strictEqual(root.root, true);
  assert.strictEqual(root.sections.length, 4);
  assert.ok(ecMatches('*.cs', 'a/b/C.cs'));
  assert.ok(ecMatches('*.{json,yml}', 'x.yml'));
  assert.ok(!ecMatches('*.{json,yml}', 'x.cs'));
  assert.ok(ecMatches('src/**/gen/*.cs', 'src/a/b/gen/X.cs'));
  assert.ok(!ecMatches('src/**/gen/*.cs', 'lib/gen/X.cs'));
  assert.ok(ecMatches('{1..3}.txt', '2.txt') && !ecMatches('{1..3}.txt', '4.txt'));
  assert.ok(ecMatches('[!a]*.md', 'b.md') && !ecMatches('[!a]*.md', 'a.md'));
  const inner = ecParse('[*.cs]\nindent_size = 3\nend_of_line = LF\n');
  const p = ecProps([{ dir: '/w/src', parsed: inner }, { dir: '/w', parsed: root }], '/w/src/a/gen/X.cs');
  assert.deepStrictEqual(J(p), { indent_style: 'space', indent_size: '3', trim_trailing_whitespace: 'false', end_of_line: 'lf', tab_width: '3' }, 'generated code under src/**/gen keeps its whitespace');
  assert.strictEqual(ecProps([{ dir: '/w', parsed: root }], '/w/src/x/gen/Y.cs').trim_trailing_whitespace, 'false');
  assert.deepStrictEqual(J(ecProps([{ dir: '/w', parsed: root }], '/w/Makefile')), { indent_style: 'tab', indent_size: '4', trim_trailing_whitespace: 'true', tab_width: '4' });
  assert.strictEqual(ecProps([{ dir: '/w', parsed: ecParse('[*]\nindent_size = unset\n') }], '/w/a.cs').indent_size, undefined);
});

test('Task List: tokens after comment starts in any language, not in plain text', () => {
  const c = load(['tasklist.js'], 'this.tl = { tlScanText, tlRegexSource };');
  const text = [
    '// TODO: wire up the cache',
    'int x = 1; // HACK work around #42',
    '/* UNDONE */',
    '# FIXME python side',
    '<!-- TODO: html -->',
    ' * TODO in a doc comment',
    'var todo = "TODO later"; // not a comment token at the start',
    'Console.WriteLine("TODO");',
    "' TODO vb"
  ].join('\n');
  const items = c.tl.tlScanText('/w/a.cs', text, ['TODO', 'HACK', 'UNDONE', 'FIXME']);
  assert.deepStrictEqual(J(items.map((i) => [i.line, i.token, i.text])), [
    [1, 'TODO', 'wire up the cache'], [2, 'HACK', 'work around #42'], [3, 'UNDONE', 'UNDONE'], [4, 'FIXME', 'python side'],
    [5, 'TODO', 'html'], [6, 'TODO', 'in a doc comment'], [9, 'TODO', 'vb']
  ]);
  // the main process gets the same pattern (JavaScript RegExp source)
  assert.ok(new RegExp(c.tl.tlRegexSource(['TODO'])).test('  // TODO x'));
});

test('Replace in Files: literal text, whole word, case, regular expression groups', () => {
  const c = load(['replaceinfiles.js'], 'this.rf = { rfReplaceText, rfIncludeTest };');
  const { rfReplaceText, rfIncludeTest } = c.rf;
  const o = (x) => ({ find: '', replace: '', caseSensitive: false, wholeWord: false, regex: false, ...x });
  assert.deepStrictEqual(J(rfReplaceText('a.b a.b axb', o({ find: 'a.b', replace: '$1' }))), { text: '$1 $1 axb', count: 2 });
  assert.deepStrictEqual(J(rfReplaceText('Order order orders', o({ find: 'order', replace: 'Item', wholeWord: true }))), { text: 'Item Item orders', count: 2 });
  assert.deepStrictEqual(J(rfReplaceText('Order order', o({ find: 'order', replace: 'x', caseSensitive: true }))), { text: 'Order x', count: 1 });
  assert.deepStrictEqual(J(rfReplaceText('GetUser(1); GetOrder(22);', o({ find: 'Get(\\w+)\\((\\d+)\\)', replace: 'Fetch$1Async($2)', regex: true }))), { text: 'FetchUserAsync(1); FetchOrderAsync(22);', count: 2 });
  assert.deepStrictEqual(J(rfReplaceText('nothing', o({ find: 'zzz', replace: 'y' }))), { text: 'nothing', count: 0 });
  assert.ok(rfIncludeTest('*.cs; *.json', 'A.json') && !rfIncludeTest('*.cs; *.json', 'A.js') && rfIncludeTest('', 'x'));
});

test('Markdown: headings, lists, tables, code, links; HTML and javascript: links are made harmless', () => {
  const c = load(['markdown.js'], 'this.md = { mdRender };');
  const h = c.md.mdRender([
    '# Title', '', 'Some **bold**, *em*, `code <x>` and [link](https://x.org "t").', '',
    '- one', '- [x] done', '  - nested', '', '1. first', '2. second', '',
    '| A | B |', '|:--|--:|', '| 1 | 2 |', '', '```cs', 'var x = "<b>";', '```', '', '> quote', '', '---',
    '<script>alert(1)</script>', '[bad](javascript:alert(1)) ![i](img.png)'
  ].join('\n'));
  assert.match(h, /<h1 id="title">Title<\/h1>/);
  assert.match(h, /<strong>bold<\/strong>, <em>em<\/em>, <code>code &lt;x&gt;<\/code> and <a href="https:\/\/x.org" title="t">link<\/a>/);
  assert.match(h, /<ul><li>one<\/li><li class="md-task"><input type="checkbox" disabled checked> done<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(h, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(h, /<th style="text-align:left">A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(h, /<pre class="md-code" data-lang="cs"><code>var x = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
  assert.match(h, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(h, /<hr>/);
  assert.ok(!/<script>/.test(h), 'raw HTML is escaped');
  assert.match(h, /<a href="#">bad<\/a>/);
  assert.match(h, /<img src="img.png" alt="i">/);
});

test('.http files: requests, names, headers, bodies, variables in file order', () => {
  const c = load(['markdown.js', 'httpclient.js'], 'this.hc = { hcParse, hcBuild, hcSubstitute, hcEnvVars, hcEnvNames, hcJsonPath, hcDotenv, hcFormatDate };');
  const { hcParse, hcBuild, hcEnvVars, hcEnvNames } = c.hc;
  assert.strictEqual(c.LANGS.http, 'http');
  const text = [
    '@host = {{HostAddress}}/api', '@user = ada', '',
    '# @name login', 'POST {{host}}/token HTTP/1.1', 'Content-Type: application/json', '# a comment', '', '{ "user": "{{user}}" }', '', '',
    '###', '', '// plain GET with no method', '{{host}}/health', '',
    '### orders', '@user = bob', 'GET {{host}}/orders?u={{user}}', 'Authorization: Bearer {{login.response.body.$.token}}'
  ].join('\n');
  const p = hcParse(text);
  assert.deepStrictEqual(J(p.requests.map((r) => [r.name, r.method, r.url, r.line, r.httpVersion])), [
    ['login', 'POST', '{{host}}/token', 5, 'HTTP/1.1'], [null, 'GET', '{{host}}/health', 15, null], [null, 'GET', '{{host}}/orders?u={{user}}', 19, null]
  ]);
  assert.deepStrictEqual(J(p.requests[0].headers), [['Content-Type', 'application/json']]);
  assert.strictEqual(p.requests[0].body, '{ "user": "{{user}}" }');
  const envs = { env: { $shared: { HostAddress: 'http://shared', Tenant: 't0' }, dev: { HostAddress: 'http://localhost:5000' }, prod: {} }, user: { dev: { Secret: 's3' } } };
  assert.deepStrictEqual(J(hcEnvNames(envs)), ['dev', 'prod']);
  assert.deepStrictEqual(J(hcEnvVars(envs, 'dev')), { HostAddress: 'http://localhost:5000', Tenant: 't0', Secret: 's3' });
  assert.strictEqual(hcEnvVars(envs, 'prod').HostAddress, 'http://shared');
  const results = new Map();
  const ctx = { env: hcEnvVars(envs, 'dev'), results, path: '/w/api.http' };
  const login = hcBuild(p, p.requests[0], ctx);
  assert.deepStrictEqual(J(login), { method: 'POST', url: 'http://localhost:5000/api/token', headers: [['Content-Type', 'application/json']], body: '{ "user": "ada" }' });
  // a request variable needs the named request to have been sent
  assert.throws(() => hcBuild(p, p.requests[2], ctx), /Send the request "login" first/);
  results.set('/w/api.http|login', { request: login, response: { body: '{"token":"abc","list":[{"id":7}]}', headers: [['X-Trace', 'q1']] } });
  const orders = hcBuild(p, p.requests[2], ctx);
  assert.strictEqual(orders.url, 'http://localhost:5000/api/orders?u=bob', 'the later @user wins below its definition');
  assert.deepStrictEqual(J(orders.headers), [['Authorization', 'Bearer abc']]);
  assert.throws(() => hcBuild(p, p.requests[0], { env: {}, results, path: '/w/api.http' }), /\{\{HostAddress\}\} is not defined/);
});

test('.http variables: dynamic values, JSONPath, headers, .env, secrets', () => {
  const c = load(['markdown.js', 'httpclient.js'], 'this.hc = { hcSubstitute, hcJsonPath, hcDotenv, hcFormatDate };');
  const { hcSubstitute, hcJsonPath, hcDotenv, hcFormatDate } = c.hc;
  const results = new Map([['/w/a.http|r', { request: { body: '{"q":1}', headers: [] }, response: { body: '{"a":{"b":[10,{"c d":"x"}]}}', headers: [['Location', '/items/5']] } }]]);
  const ctx = { env: { vault: { provider: 'AzureKeyVault', secretName: 'k' } }, results, path: '/w/a.http', processEnv: { HOME: '/home/u' }, dotenv: hcDotenv('API_KEY="k-1"\n# c\nexport OTHER=2') };
  assert.match(hcSubstitute('{{$guid}}', ctx), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const n = +hcSubstitute('{{$randomInt 5 8}}', ctx);
  assert.ok(n >= 5 && n < 8);
  const ts = +hcSubstitute('{{$timestamp}}', ctx);
  assert.ok(Math.abs(ts - Date.now() / 1000) < 5);
  assert.ok(Math.abs(+hcSubstitute('{{$timestamp 1 d}}', ctx) - ts - 86400) < 5);
  assert.match(hcSubstitute('{{$datetime iso8601}}', ctx), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(hcSubstitute('{{$datetime rfc1123}}', ctx), /GMT$/);
  assert.strictEqual(hcFormatDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), '"dd-MM-yyyy HH:mm"', false), '02-01-2026 03:04');
  assert.strictEqual(hcSubstitute('{{$processEnv HOME}} {{$dotenv API_KEY}} {{$dotenv OTHER}}', ctx), '/home/u k-1 2');
  assert.throws(() => hcSubstitute('{{$processEnv NOPE}}', ctx), /NOPE is not set/);
  assert.strictEqual(hcSubstitute('{{r.response.body.$.a.b[1][\'c d\']}}|{{r.response.body.$.a.b[0]}}|{{r.response.headers.location}}|{{r.request.body.$.q}}', ctx), 'x|10|/items/5|1');
  assert.strictEqual(hcSubstitute('{{r.response.body.*}}', ctx), '{"a":{"b":[10,{"c d":"x"}]}}');
  assert.throws(() => hcSubstitute('{{vault}}', ctx), /secret provider \(AzureKeyVault\)/);
  assert.deepStrictEqual(J(hcJsonPath({ a: [1, { b: 2 }] }, '$.a[1]')), { b: 2 });
});
