'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const { makeProbe, transform, install, COMPILED_SHA256 } = require('./bounded-business-capacity-probe.cjs');
const compiled = () => fs.readFileSync(path.join(__dirname, '../../dist/server/managed-saas-gateway.js'), 'utf8');

function graph(httpHandler) {
  const source = transform(compiled());
  const begin = source.indexOf('    const pendingHttpHandlers = new Set();');
  const end = source.indexOf('    return Object.freeze({ handler, handleUpgrade: responsesWs.handleUpgrade, preparation, dispatch, close });', begin);
  assert.ok(begin > 0 && end > begin);
  const body = source.slice(begin, source.indexOf('\n', end));
  const probe = makeProbe(128);
  let id = 0, closed = 0;
  const context = {
    require: () => ({ createProbe: limit => { assert.equal(limit, 128); return probe; } }),
    requestId: () => `request-${++id}`,
    requestIdContext: { run: (_id, work) => work() },
    runWithDiagnostics: (_id, work) => work(),
    httpHandler,
    http_handler_js_1: {
      isSaasGatewayInferenceRequest: req => req.inference !== false,
      rejectSaasGatewayCapacityRequest: (_req, res) => { res.statusCode = 429; res.writableEnded = true; },
    },
    closeOnce: ({ close }) => close,
    responsesWs: { close: async () => {}, handleUpgrade() {} }, preparation: {}, dispatch: {},
  };
  const create = vm.runInNewContext(`(function(dependencies) {${body}\n})`, context);
  const gateway = create({ maxHttpInFlight: 128, lifecycle: { close: async () => { closed++; } } });
  return { gateway, probe, closed: () => closed };
}

test('strict source pin and opt-in leave ordinary module loader untouched', () => {
  const original = Module._extensions['.js'];
  assert.equal(install('/unreadable/not-used', {}), null);
  assert.equal(Module._extensions['.js'], original);
  assert.throws(() => transform(compiled() + '\n'), /SOURCE_PIN/);
  assert.throws(() => install('/unused', { BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC: '1' }), /FIXED_PROFILE/);
  assert.throws(() => makeProbe(256), /LOCAL_128/);
  assert.match(transform(compiled()), /capacityProbe.reject\(httpInFlight, closing, currentRequestId\)/);
  assert.equal(COMPILED_SHA256.length, 64);
});

test('symlink dist resolves to the loader identity and pin failure restores loader', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-pin-'));
  const real = path.join(directory, 'real');
  fs.mkdirSync(path.join(real, 'server'), { recursive: true });
  fs.writeFileSync(path.join(real, 'server/managed-saas-gateway.js'), 'throw new Error("must not execute");\n');
  fs.symlinkSync(real, path.join(directory, 'dist'));
  const original = Module._extensions['.js'];
  try {
    install(path.join(directory, 'dist'), { BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC: '1',
      BOUNDED_CLUSTER_DIAGNOSTIC: '1', BOUNDED_CLUSTER_PROFILE: 'c200',
      BOUNDED_CLUSTER_WORKERS: '2', MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: '128' });
    assert.throws(() => require(path.join(directory, 'dist/server/managed-saas-gateway.js')), /SOURCE_PIN/);
    assert.equal(Module._extensions['.js'], original);
  } finally {
    Module._extensions['.js'] = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native gate records exact 128 occupancy after EOF, retains original promises, and drains', async () => {
  const releases = [];
  const g = graph(() => new Promise(resolve => releases.push(resolve)));
  const responses = [], promises = [];
  const sockets = Array.from({ length: 100 }, () => ({}));
  g.probe.attachPublicServer({ _connections: 100 });
  for (let i = 0; i < 128; i++) {
    const res = { writableEnded: i < 35, writableFinished: i < 30 };
    responses.push(res); promises.push(g.gateway.handler({ socket: sockets[i % 100] }, res));
  }
  const overflow = {};
  assert.equal(await g.gateway.handler({ socket: {} }, overflow), true);
  assert.equal(overflow.statusCode, 429);
  const before = g.probe.snapshot();
  assert.equal(before.current, 128); assert.equal(before.peak, 128);
  assert.equal(before.samples[0].httpInFlight, 128); assert.equal(before.samples[0].limit, 128);
  assert.equal(before.samples[0].closing, false); assert.equal(before.samples[0].pendingResponses, 128);
  assert.equal(before.samples[0].writableEnded, 35); assert.equal(before.samples[0].writableFinished, 30);
  assert.equal(before.samples[0].uniqueSockets, 100); assert.equal(before.samples[0].publicSocketsCurrent, 100);
  releases[0](true); await promises[0];
  assert.equal(g.probe.snapshot().current, 127);
  const closing = g.gateway.close();
  assert.equal(g.closed(), 0);
  await g.gateway.handler({ socket: {} }, {});
  assert.equal(g.probe.snapshot().samples[1].closing, true);
  for (const release of releases.slice(1)) release(true);
  await Promise.all(promises); await closing;
  const after = g.probe.snapshot();
  assert.equal(after.current, 0); assert.equal(after.pendingResponses, 0);
  assert.equal(after.accepted, 128); assert.equal(after.settled, 128);
  assert.equal(after.violations, 0); assert.equal(g.closed(), 1);
});

test('native synchronous throw and rejected original promise remove retained responses', async () => {
  const sync = graph(() => { throw new Error('sync'); });
  assert.throws(() => sync.gateway.handler({ socket: {} }, {}), /sync/);
  assert.equal(sync.probe.snapshot().current, 0); assert.equal(sync.probe.snapshot().pendingResponses, 0);
  const async = graph(() => Promise.reject(new Error('async')));
  await assert.rejects(async.gateway.handler({ socket: {} }, {}), /async/);
  assert.equal(async.probe.snapshot().current, 0); assert.equal(async.probe.snapshot().pendingResponses, 0);
  assert.equal(async.probe.snapshot().violations, 0);
});

test('sample retention is bounded; finished and aborted flags never release a permit', () => {
  const p = makeProbe(128), response = { writableEnded: false, writableFinished: false };
  p.accept(response, {}, 1);
  response.writableEnded = true; response.writableFinished = true; response.destroyed = true;
  for (let i = 0; i < 200; i++) p.reject(1, true, `r${i}`);
  const value = p.snapshot();
  assert.equal(value.current, 1); assert.equal(value.pendingResponses, 1);
  assert.equal(value.samples.length, 128); assert.equal(value.dropped, 72); assert.equal(value.rejected, 200);
  p.settle(response, 0);
  assert.equal(p.snapshot().current, 0);
});
