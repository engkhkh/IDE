// Phase 23: AI request/stream formats, docker CLI output parsing, SQLite queries (sql.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('../main/ai');
const ct = require('../main/containers');
const db = require('../main/database');

test('AI: Anthropic Messages API request and its stream events', () => {
  const cfg = ai.config({ aiProvider: 'anthropic' });
  assert.deepStrictEqual(cfg, { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', maxTokens: 4096 });
  const r = ai.buildRequest(cfg, 'k1', 'sys', [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.url, 'https://api.anthropic.com/v1/messages');
  assert.deepStrictEqual(r.headers, { 'content-type': 'application/json', 'x-api-key': 'k1', 'anthropic-version': '2023-06-01' });
  assert.deepStrictEqual(r.body, { model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'sys', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.deepStrictEqual(ai.parseEvent('anthropic', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}'), { text: 'Hel' });
  assert.deepStrictEqual(ai.parseEvent('anthropic', '{"type":"message_stop"}'), { done: true });
  assert.deepStrictEqual(ai.parseEvent('anthropic', '{"type":"ping"}'), {});
  assert.deepStrictEqual(ai.parseEvent('anthropic', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { error: 'Overloaded' });
});

test('AI: OpenAI-compatible and Ollama requests and stream chunks', () => {
  const o = ai.config({ aiProvider: 'ollama', aiModel: 'llama3' });
  assert.deepStrictEqual(o, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3', maxTokens: 4096 });
  const r = ai.buildRequest(ai.config({ aiProvider: 'openai', aiBaseUrl: 'http://x/v1/' }), 'sk', 'sys', [{ role: 'user', content: 'q' }]);
  assert.strictEqual(r.url, 'http://x/v1/chat/completions');
  assert.strictEqual(r.headers.authorization, 'Bearer sk');
  assert.deepStrictEqual(r.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]);
  assert.ok(!('authorization' in ai.buildRequest(o, null, 's', []).headers));
  assert.deepStrictEqual(ai.parseEvent('openai', '{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}'), { text: 'lo', done: false });
  assert.deepStrictEqual(ai.parseEvent('openai', '[DONE]'), { done: true });
  assert.deepStrictEqual(ai.parseEvent('openai', '{"choices":[{"delta":{},"finish_reason":"stop"}]}'), { done: true });
});

test('Containers: docker --format json lines and published ports', () => {
  assert.deepStrictEqual(ct.parsePorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:5433->5432/tcp, 6379/tcp'), [{ host: 8080, container: 80, proto: 'tcp' }, { host: 5433, container: 5432, proto: 'tcp' }]);
  assert.deepStrictEqual(ct.jsonLines('{"ID":"a"}\nWARNING: x\n{"ID":"b"}\n{broken\n'), [{ ID: 'a' }, { ID: 'b' }]);
});

test('Database: schema, queries, changes written back, errors', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'shop.db');
  await db.create(f);
  let r = await db.query(f, 'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL, note TEXT, data BLOB); CREATE INDEX ix_orders_customer ON orders(customer_id);');
  assert.ok(r.saved && !r.error, JSON.stringify(r));
  r = await db.query(f, "INSERT INTO customers(name) VALUES ('Ada'), ('Grace'); INSERT INTO orders(customer_id, total, note, data) VALUES (1, 9.5, NULL, x'0102'), (2, 20, 'gift', NULL);");
  assert.strictEqual(r.changes, 4);
  assert.ok(r.saved);
  r = await db.query(f, 'SELECT c.name, o.total, o.note, o.data FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.total');
  assert.deepStrictEqual(r.results[0].columns, ['name', 'total', 'note', 'data']);
  assert.deepStrictEqual(r.results[0].rows, [['Ada', 9.5, null, { blob: 2 }], ['Grace', 20, 'gift', null]]);
  assert.strictEqual(r.saved, false);
  r = await db.query(f, 'SELECT * FROM customers', 1);
  assert.strictEqual(r.results[0].rows.length, 1);
  assert.strictEqual(r.results[0].more, true);
  const s = await db.schema(f);
  const orders = s.objects.find((o) => o.name === 'orders');
  assert.deepStrictEqual(s.objects.map((o) => `${o.type}:${o.name}:${o.rows}`), ['table:customers:2', 'table:orders:2']);
  assert.deepStrictEqual(orders.foreignKeys, [{ from: 'customer_id', table: 'customers', to: 'id' }]);
  assert.deepStrictEqual(orders.indexes.map((i) => i.name), ['ix_orders_customer']);
  assert.ok(orders.columns.find((c) => c.name === 'id').pk);
  r = await db.query(f, 'SELEC nope');
  assert.match(r.error, /syntax error/);
  fs.writeFileSync(path.join(path.dirname(f), 'x.db'), 'not a database at all, just text');
  await assert.rejects(db.schema(path.join(path.dirname(f), 'x.db')), /not a SQLite database/);
});
