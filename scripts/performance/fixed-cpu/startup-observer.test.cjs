'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBusinessObserver, createPrimaryObserver, createCheckpointHandler, receiptScalars, sha256,
  BUSINESS_PIN_PATHS, PRIMARY_PIN_PATHS } = require('./startup-observer.cjs');

function fixture(arm = 'single', { queueThrows = false, nestedCompositionThrows = false } = {}) {
  const divisor = arm === 'single' ? 1 : 2;
  const options = { maxEntries: 256 / divisor, maxBytes: 2097152 / divisor, maxPerTenant: 64 / divisor,
    workers: 8 / divisor, maxAgeMs: 5000, drainTimeoutMs: 10000, observe: undefined };
  const identities = new WeakMap();
  class Queue {
    #private = 'native-queue';
    constructor(options) { if (queueThrows) throw Error('native queue rejected'); identities.set(this, options); }
    snapshot() { return { pending: 0, undurable: 0, running: 0, identity: this.#private, known: identities.has(this) }; }
  }
  class Executor {
    #private = 'native-executor';
    constructor(options) { identities.set(this, options); }
    identity() { return this.#private + ':' + identities.has(this); }
  }
  class Journal {
    #private = 'native-journal';
    constructor() { this.stripes = 8 / divisor; this.tranche = divisor === 1 ? null : 33566720n; }
    identity() { return this.#private; }
  }
  const native = { Queue, Executor, Journal, factory: () => new Journal(), composition: (...args) => args };
  const modules = { queue: { FastReceiptQueue: Queue }, executor: { FastGatewayExecutor: Executor },
    journal: { PostgresFastGatewayJournal: Journal, createFastGatewayJournal: native.factory },
    composition: { createManagedSaasGatewayProductionComposition: native.composition },
    database: { ownedSaasNativePoolSnapshot: () => (divisor === 1 ? [14, 2] : [6, 2]).map(maximum => ({ maximum })) } };
  if (nestedCompositionThrows) {
    native.composition = () => {
      const journal = modules.journal.createFastGatewayJournal('db', {});
      const queue = new modules.queue.FastReceiptQueue({ journal, ...options });
      new modules.executor.FastGatewayExecutor({ maxLocalConcurrency: 64 / divisor, journal, receiptQueue: queue });
      throw Error('outer native composition rejected');
    };
    modules.composition.createManagedSaasGatewayProductionComposition = native.composition;
  }
  const input = { arm, httpInFlight: 64, creditCap: '67133440' };
  const lifecycle = new EventEmitter();
  let bytes;
  const observer = createBusinessObserver({ modules, input, lifecycle, identity: { pid: 7, startTicks: '123' },
    modulePins: { 'dist/native.js': 'a'.repeat(64) }, writeProof: value => { bytes = value; } });
  function restored() {
    assert.equal(modules.queue.FastReceiptQueue, Queue);
    assert.equal(modules.executor.FastGatewayExecutor, Executor);
    assert.equal(modules.journal.createFastGatewayJournal, native.factory);
    assert.equal(modules.composition.createManagedSaasGatewayProductionComposition, native.composition);
  }
  function construct() {
    const composition = modules.composition.createManagedSaasGatewayProductionComposition('db', { maxHttpInFlight: 64 / divisor });
    const journal = modules.journal.createFastGatewayJournal('db', {});
    const queue = new modules.queue.FastReceiptQueue({ journal, ...options });
    const executor = new modules.executor.FastGatewayExecutor({ maxLocalConcurrency: 64 / divisor, journal, receiptQueue: queue });
    return { composition, journal, queue, executor };
  }
  return { observer, modules, native, options, input, lifecycle, construct, restored, proof: () => JSON.parse(bytes), bytes: () => bytes };
}

test('business observation preserves exact native private/WeakMap identities and restores before readiness', async () => {
  for (const arm of ['single', 'bounded']) {
    const f = fixture(arm);
    let calls = 0;
    const original = function () { f.restored(); assert.equal(this.checkReady, original); calls++; };
    const handle = { checkReady: original };
    assert.equal(f.observer.attachReadiness(handle), handle);
    const capturedReadiness = handle.checkReady.bind(handle); // Actual loader binds once.
    const pending = capturedReadiness();
    const values = f.construct();
    await pending;
    f.restored();
    assert.equal(handle.checkReady, original);
    assert.equal(calls, 1);
    assert.equal(Object.getPrototypeOf(values.queue), f.native.Queue.prototype);
    assert.equal(values.queue.snapshot().identity, 'native-queue');
    assert.equal(values.queue.snapshot().known, true);
    assert.equal(values.executor.identity(), 'native-executor:true');
    assert.equal(values.journal.identity(), 'native-journal');
    assert.equal(f.proof().restored, true);
    assert.deepEqual(f.proof().actual.nativePools, arm === 'single' ? [2, 14] : [2, 6]);
    assert.equal(f.proof().actual.stripes, arm === 'single' ? 8 : 4);
    assert.equal(f.proof().actual.tranche, arm === 'single' ? null : '33566720');
    assert.equal(f.lifecycle.listenerCount('uncaughtExceptionMonitor'), 0);
    assert.equal(f.lifecycle.listenerCount('exit'), 0);
    f.observer.dispose();
  }
});

test('native constructor throw restores all exports and the exact readiness property, with no proof', async () => {
  const f = fixture('single', { queueThrows: true });
  const original = () => {};
  const handle = { checkReady: original };
  f.observer.attachReadiness(handle);
  assert.throws(f.construct, /native queue rejected/);
  await assert.rejects(f.observer.completion, /native queue rejected/);
  f.restored();
  assert.equal(handle.checkReady, original);
  assert.equal(f.bytes(), undefined);
  f.observer.dispose();
});

test('HTTP proof waits for outer native composition success after nested native constructors', async () => {
  const f = fixture('single', { nestedCompositionThrows: true });
  assert.throws(f.construct, /outer native composition rejected/);
  await assert.rejects(f.observer.completion, /outer native composition rejected/);
  f.restored(); assert.equal(f.bytes(), undefined); f.observer.dispose();
});

test('module pin contract includes startup-only bound-readiness call graph without early extra imports', () => {
  assert.ok(BUSINESS_PIN_PATHS.includes('dist/server/managed-saas.js'));
  assert.ok(BUSINESS_PIN_PATHS.includes('dist/saas/runtime/gateway-runtime-module.js'));
  assert.equal(new Set(BUSINESS_PIN_PATHS).size, 7);
  assert.equal(new Set(PRIMARY_PIN_PATHS).size, 2);
  // Merely requiring this test/observer has no dependency on a dist build.
  assert.equal(Object.keys(require.cache).some(name => name.includes('/dist/server/managed-saas.js')), false);
});

test('unknown, missing or callback queue options fail; no default normalization or guessed proof', () => {
  const valid = { maxEntries: 256, maxBytes: 2097152, maxPerTenant: 64, workers: 8, maxAgeMs: 5000, drainTimeoutMs: 10000 };
  assert.deepEqual(receiptScalars(valid), valid);
  for (const change of [{ workers: undefined }, { workers: '8' }, { workers: 0 }, { retryBaseMs: 25 }, { observe: () => {} }])
    assert.throws(() => receiptScalars({ ...valid, ...change }));
  const missing = { ...valid }; delete missing.maxEntries;
  assert.throws(() => receiptScalars(missing));
});

test('bad native pools/credit fields and readiness throw fail closed after restoration', async () => {
  const f = fixture();
  f.modules.database.ownedSaasNativePoolSnapshot = () => [{ maximum: 16 }, { maximum: 2 }];
  assert.throws(f.construct, /QUOTA_OBSERVER_NATIVE_POOL_MAXIMA/);
  await assert.rejects(f.observer.completion);
  f.restored(); assert.equal(f.bytes(), undefined); f.observer.dispose();
  const next = fixture();
  const original = () => { throw Error('native readiness rejected'); };
  const handle = { checkReady: original }; next.observer.attachReadiness(handle);
  const pending = handle.checkReady(); next.construct();
  await assert.rejects(pending, /native readiness rejected/);
  next.restored(); assert.equal(handle.checkReady, original); next.observer.dispose();
});

test('uncaught/exit failure observers restore without swallowing the triggering failure', async () => {
  const f = fixture();
  const error = Error('uncaught native failure');
  f.lifecycle.emit('uncaughtExceptionMonitor', error);
  await assert.rejects(f.observer.completion, error);
  f.restored(); assert.equal(f.bytes(), undefined); f.observer.dispose();
});

test('invalid readiness handle and mismatched native component wiring restore without success proof', async () => {
  const badHandle = fixture();
  assert.throws(() => badHandle.observer.attachReadiness({}), /QUOTA_OBSERVER_READINESS_METHOD_REQUIRED/);
  await assert.rejects(badHandle.observer.completion);
  badHandle.restored(); assert.equal(badHandle.bytes(), undefined); badHandle.observer.dispose();
  const badJournal = fixture();
  badJournal.modules.journal.createFastGatewayJournal('db', {});
  assert.throws(() => new badJournal.modules.queue.FastReceiptQueue({ journal: {}, ...badJournal.options }),
    /QUOTA_OBSERVER_QUEUE_JOURNAL_IDENTITY/);
  await assert.rejects(badJournal.observer.completion);
  badJournal.restored(); assert.equal(badJournal.bytes(), undefined); badJournal.observer.dispose();
});

test('checkpoint requires a fresh nonce and exact PID/start identity; never invents zero queue facts', () => {
  const identity = { pid: 7, startTicks: '123' }, writes = [];
  const hash = sha256('exact startup proof bytes\n');
  let request = { nonce: 'a'.repeat(32), actors: [identity] };
  let reads = 0;
  const handler = createCheckpointHandler({ identity, startupProofSha256: hash,
    readRequest: () => request, writeSnapshot: value => writes.push(value), now: () => 456,
    nativeQueue: { snapshot: () => { reads++; return { pending: 3, undurable: 2 }; } } });
  assert.equal(handler(), true); assert.equal(reads, 1);
  assert.deepEqual(writes[0], { nonce: 'a'.repeat(32), identity, startupProofSha256: hash,
    observedAtUnixMs: 456, snapshot: { pending: 3, undurable: 2 } });
  assert.equal(handler(), false); // Replay cannot create a second proof.
  request = { nonce: 'b'.repeat(32), actors: [{ pid: 7, startTicks: '122' }] };
  assert.equal(handler(), false);
  request = { nonce: 'c'.repeat(32), actors: [{ pid: 8, startTicks: '123' }] };
  assert.equal(handler(), false);
  request = { nonce: 'd'.repeat(32), actors: [identity, identity] };
  assert.equal(handler(), false);
  assert.equal(reads, 1); assert.equal(writes.length, 1);
});

test('primary records actual native permit limit, no PG pool, and restores exact class identity', () => {
  const native = new WeakMap();
  class Permits { #brand = true; constructor(limit) { this.localLimit = limit; native.set(this, limit); }
    read() { return this.#brand && native.get(this); } }
  const modules = { permits: { BoundedGatewayPermits: Permits }, database: { ownedSaasNativePoolSnapshot: () => [] } };
  let bytes;
  const observer = createPrimaryObserver({ modules, input: { arm: 'bounded', httpInFlight: 256, creditCap: '268533760' },
    identity: { pid: 1, startTicks: '100' }, modulePins: {}, lifecycle: new EventEmitter(), writeProof: value => { bytes = value; } });
  const permits = new modules.permits.BoundedGatewayPermits(128);
  assert.equal(permits.read(), 128);
  assert.equal(modules.permits.BoundedGatewayPermits, Permits);
  assert.equal(Object.getPrototypeOf(permits), Permits.prototype);
  assert.deepEqual(JSON.parse(bytes).actual, { httpLocalLimit: 128, nativePools: [] });
  observer.restore();
});

test('primary constructor failure restores its exact original export without a proof', () => {
  class Permits { constructor() { throw Error('native permit constructor rejected'); } }
  const modules = { permits: { BoundedGatewayPermits: Permits }, database: { ownedSaasNativePoolSnapshot: () => [] } };
  let written = false;
  const observer = createPrimaryObserver({ modules, input: { arm: 'bounded', httpInFlight: 64, creditCap: '67133440' },
    identity: { pid: 1, startTicks: '100' }, modulePins: {}, lifecycle: new EventEmitter(), writeProof: () => { written = true; } });
  assert.throws(() => new modules.permits.BoundedGatewayPermits(32), /native permit constructor rejected/);
  assert.equal(modules.permits.BoundedGatewayPermits, Permits);
  assert.equal(written, false);
  observer.restore();
});
