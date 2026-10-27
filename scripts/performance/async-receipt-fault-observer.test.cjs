'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createObserver, inspectQuery, sqlKind } = require('./async-receipt-fault-observer.cjs');

function fixture(options = {}) {
  const files = new Map();
  const io = {
    existsSync: (name) => files.has(name),
    writeFileSync: (name, value) => files.set(name, value),
    renameSync(from, to) {
      if (!files.has(from)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      files.set(to, files.get(from)); files.delete(from);
    },
  };
  const observer = createObserver({ markerDirectory: '/owned/markers', output: '/owned/result.json', io, ...options });
  return { files, observer };
}
const receipt = { text: '/* fast-journal:append-receipt */ INSERT INTO private_table VALUES ($1)', values: ['intent-secret', 'credential-not-for-output'] };

test('fixed SQL classes and hash-only parameter observation', () => {
  assert.equal(sqlKind('/* fast-journal:append-receipt */ anything'), 'receipt');
  assert.equal(sqlKind('/* fast-journal:worker-claim */ anything'), 'worker_claim');
  assert.equal(sqlKind('SELECT private_secret'), null);
  const result = inspectQuery([receipt]);
  assert.match(result.identityHash, /^[a-f0-9]{64}$/);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('normal observed query preserves exact Promise, receiver and arguments', async () => {
  const { observer } = fixture();
  const value = Promise.resolve({ rows: [1] });
  const receiver = {};
  const wrapped = observer.wrapQuery(function (...args) { assert.equal(this, receiver); assert.equal(args[0], receipt); return value; });
  assert.equal(wrapped.call(receiver, receipt), value);
  await value;
  assert.deepEqual(observer.snapshot().events.map((e) => e.phase), ['query_driver_start', 'query_driver_ack']);
});

test('unclassified query is not observed or transformed', () => {
  const { observer } = fixture();
  const marker = {};
  assert.equal(observer.wrapQuery(() => marker)('SELECT 1'), marker);
  assert.deepEqual(observer.snapshot().events, []);
});

test('receipt hold is before actual SQL, release invokes unchanged query once', async () => {
  let wake;
  const { observer, files } = fixture({ sleep: () => new Promise((resolve) => { wake = resolve; }) });
  files.set('/owned/markers/receipt-before-sql.hold', 'hold');
  let calls = 0;
  const wrapped = observer.wrapQuery((config) => { assert.equal(config, receipt); calls++; return Promise.resolve('durable'); });
  const pending = wrapped(receipt);
  assert.equal(calls, 0);
  assert.ok(files.has('/owned/markers/receipt-before-sql.waiting'));
  assert.deepEqual(observer.snapshot().events.map((e) => e.phase), ['before_sql_hold']);
  files.delete('/owned/markers/receipt-before-sql.hold'); wake();
  assert.equal(await pending, 'durable');
  assert.equal(calls, 1);
  assert.deepEqual(observer.snapshot().events.map((e) => e.phase), ['before_sql_hold', 'before_sql_released', 'query_driver_start', 'query_driver_ack']);
});

test('ledger-worker hold does not hold receipt SQL', async () => {
  const { observer, files } = fixture();
  files.set('/owned/markers/worker-before-claim.hold', 'hold');
  assert.equal(await observer.wrapQuery(() => Promise.resolve('receipt durable'))(receipt), 'receipt durable');
  assert.equal(observer.snapshot().events[0].phase, 'query_driver_start');
});

test('real successful ACK is hidden exactly once; retry records identical input', async () => {
  const { observer, files } = fixture();
  files.set('/owned/markers/receipt-ack-loss.once', 'arm');
  let calls = 0;
  const wrapped = observer.wrapQuery(() => { calls++; return Promise.resolve('actual committed result'); });
  await assert.rejects(wrapped(receipt), { code: 'ECONNRESET' });
  assert.equal(await wrapped(receipt), 'actual committed result');
  assert.equal(calls, 2);
  const events = observer.snapshot().events;
  assert.equal(events.filter((e) => e.phase === 'ack_loss_injected').length, 1);
  assert.equal(events.filter((e) => e.phase === 'query_driver_ack').length, 2);
  assert.equal(new Set(events.map((e) => e.inputHash)).size, 1);
  assert.ok(files.has('/owned/markers/receipt-ack-loss.once.used'));
});

test('callback query preserves receiver, return value and success delivery', () => {
  const { observer } = fixture();
  const marker = {};
  const receiver = {};
  let called = 0;
  const wrapped = observer.wrapQuery(function (config, callback) {
    assert.equal(config, receipt); callback.call(receiver, null, 'result'); return marker;
  });
  assert.equal(wrapped(receipt, function (error, result) {
    called++; assert.equal(this, receiver); assert.equal(error, null); assert.equal(result, 'result');
  }), marker);
  assert.equal(called, 1);
});

test('callback receipt hold delays invocation and ACK loss never fabricates success', async () => {
  let wake;
  const { observer, files } = fixture({ sleep: () => new Promise((resolve) => { wake = resolve; }) });
  files.set('/owned/markers/receipt-before-sql.hold', 'hold');
  files.set('/owned/markers/receipt-ack-loss.once', 'arm');
  let calls = 0;
  const done = new Promise((resolve) => {
    observer.wrapQuery((_config, callback) => { calls++; callback(null, 'durable'); })(receipt, (error, result) => {
      assert.equal(error.code, 'ECONNRESET'); assert.equal(result, undefined); resolve();
    });
  });
  assert.equal(calls, 0);
  files.delete('/owned/markers/receipt-before-sql.hold'); wake(); await done;
  assert.equal(calls, 1);
});

test('bounded hold timeout sends no SQL', async () => {
  let clock = 0;
  const { observer, files } = fixture({ timeoutMs: 10, now: () => clock, sleep: async () => { clock += 5; } });
  files.set('/owned/markers/receipt-before-sql.hold', 'hold');
  let calls = 0;
  await assert.rejects(observer.wrapQuery(() => { calls++; })(receipt), /HOLD_TIMEOUT/);
  assert.equal(calls, 0);
});

test('HTTP finish is recorded separately and no response/request payload is emitted', () => {
  const { observer } = fixture();
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  const wrapped = observer.wrapHttpEmit(() => 'original');
  assert.equal(wrapped('request', { url: '/v1/chat/completions', headers: { authorization: 'secret' } }, response), 'original');
  response.emit('finish'); response.emit('close');
  assert.deepEqual(observer.snapshot().events.map((e) => e.phase), ['http_request', 'http_finish', 'http_close']);
  assert.equal(JSON.stringify(observer.snapshot()).includes('secret'), false);
});

test('event bound exposes dropped count and dump contains no SQL or parameters', async () => {
  const { observer, files } = fixture({ maxEvents: 1 });
  await observer.wrapQuery(() => Promise.resolve())(receipt);
  observer.dump();
  const data = files.get('/owned/result.json');
  assert.equal(JSON.parse(data).dropped, 1);
  assert.equal(JSON.parse(data).events.length, 1);
  for (const forbidden of ['credential-not-for-output', 'intent-secret', 'private_table']) assert.equal(data.includes(forbidden), false);
});
