// Phase 22: Endpoints Explorer parser, spell checker word splitting + dictionary, generated .http requests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { parseEndpoints, scan } = require('../main/endpoints');

const J = (x) => JSON.parse(JSON.stringify(x));
function load(file, extra) {
  const ctx = { $: () => ({ classList: { toggle() {} } }), bus: { on() {} }, state: { settings: {}, tabs: [] }, commands: {}, api: {}, console, baseName: (p) => p.split(/[\\/]/).pop(), sep: () => '/' };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8')}\n${extra}`, ctx);
  return ctx;
}

test('Endpoints: minimal APIs with nested MapGroup prefixes, MapMethods, comments ignored', () => {
  const eps = parseEndpoints([
    'var app = builder.Build();',
    'var api = app.MapGroup("/api");',
    'var orders = api.MapGroup("orders");',
    'orders.MapGet("/", () => 1);',
    'orders.MapGet("/{id:int}", (int id) => id);',
    'orders.MapPost("", (Order o) => o);',
    'app.MapMethods("/ping", new[] { "GET", "HEAD" }, () => "pong");',
    '// app.MapGet("/commented", () => 0);',
    'app.MapDelete("/items/{id}", (int id) => 0).WithName("x");'
  ].join('\n'), 'P.cs');
  assert.deepStrictEqual(J(eps.map((e) => `${e.method} ${e.route}:${e.line}`)), ['GET /api/orders:4', 'GET /api/orders/{id:int}:5', 'POST /api/orders:6', 'GET /ping:7', 'HEAD /ping:7', 'DELETE /items/{id}:9']);
});

test('Endpoints: controllers with [Route], [controller] / [action] tokens, absolute routes, conventional ones skipped', () => {
  const eps = parseEndpoints([
    '[ApiController]',
    '[Route("api/[controller]")]',
    'public class WeatherController : ControllerBase',
    '{',
    '    [HttpGet]',
    '    public IEnumerable<int> Get() => null;',
    '    [HttpGet("{id}")]',
    '    public int GetOne(int id) => id;',
    '    [HttpPost("[action]"), Authorize]',
    '    public async Task<IActionResult> Refresh() { return Ok(); }',
    '    [HttpPut("/absolute/{id}")]',
    '    public void Put(int id) {}',
    '    [Route("legacy")]',
    '    public string Legacy() => "";',
    '    private void Helper() {}',
    '}',
    'public class HomeController : Controller { }',
    '[Route("home")] public class PlainController : Controller {',
    '  [HttpDelete("{id}")] public void Remove(int id) {}',
    '}'
  ].join('\n'), 'W.cs');
  assert.deepStrictEqual(J(eps.map((e) => `${e.method} ${e.route} ${e.handler}`)), [
    'GET /api/Weather WeatherController.Get', 'GET /api/Weather/{id} WeatherController.GetOne', 'POST /api/Weather/Refresh WeatherController.Refresh',
    'PUT /absolute/{id} WeatherController.Put', 'ANY /api/Weather/legacy WeatherController.Legacy', 'DELETE /home/{id} PlainController.Remove'
  ]);
});

test('Endpoints: scan groups by project and takes the host address from launchSettings.json', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
  fs.mkdirSync(path.join(d, 'Api', 'Properties'), { recursive: true });
  fs.mkdirSync(path.join(d, 'Api', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Api', 'Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  fs.writeFileSync(path.join(d, 'Api', 'Program.cs'), 'app.MapGet("/hello", () => "hi");');
  fs.writeFileSync(path.join(d, 'Api', 'bin', 'Copy.cs'), 'app.MapGet("/ignored", () => "");');
  fs.writeFileSync(path.join(d, 'Api', 'Properties', 'launchSettings.json'), '{ // comment\n "profiles": { "https": { "commandName": "Project", "applicationUrl": "https://localhost:7001;http://localhost:5001", }, } }');
  const res = await scan(d);
  assert.deepStrictEqual(J(res.map((p) => [p.name, p.host, p.endpoints.map((e) => e.route)])), [['Api', 'http://localhost:5001', ['/hello']]]);
});

test('Generate Request: the text Visual Studio writes', () => {
  const c = load('endpoints.js', 'this.f = epRequestText;');
  assert.deepStrictEqual(J(c.f({ name: 'Shop.Api' }, { method: 'GET', route: '/orders/{id:int}/{**rest}' })), { variable: 'Shop_Api_HostAddress', text: 'GET {{Shop_Api_HostAddress}}/orders/{id}/{rest}\nAccept: application/json\n' });
  assert.strictEqual(c.f({ name: 'A' }, { method: 'POST', route: '/x' }).text, 'POST {{A_HostAddress}}/x\nAccept: application/json\nContent-Type: application/json\n\n{\n  \n}\n');
});

test('Spell checker: identifiers split, URLs / paths / acronyms skipped; the dictionary knows English', () => {
  const c = load('spellcheck.js', 'this.f = scWords;');
  const words = (t) => J(c.f(t).map((w) => w.word));
  assert.deepStrictEqual(words('Calculate the totl of GetOrderTotl and HTTPClient'), ['Calculate', 'the', 'totl', 'Get', 'Order', 'Totl', 'and', 'Client']);
  assert.deepStrictEqual(words('see https://exmaple.com/xyzq and C:\\Users\\qwzx\\file.txt or a@exmple.com'), ['see', 'and']);
  assert.deepStrictEqual(words("don't snake_case_wrd user's"), ["don't", 'snake', 'case', 'user'], 'short pieces of identifiers are skipped');
  assert.deepStrictEqual(J(c.f('ab teh').map((w) => w.index)), [3]);
  const sp = require('../main/spellcheck');
  assert.ok(sp.correct('receive') && !sp.correct('recieve') && sp.correct('Orders') && sp.correct("don't"));
  assert.ok(sp.load().suggest('recieve').includes('receive'));
});
