'use strict';
// Diagnostic assembly only: native construction is observed once, then every
// replaced export/readiness property is restored before startup succeeds.
// The only surviving observer is an explicit, out-of-timing SIGUSR2 snapshot.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_FIELDS = ['maxEntries', 'maxBytes', 'maxPerTenant', 'workers', 'maxAgeMs', 'drainTimeoutMs'];
const BUSINESS_MODULES = {
  queue: 'saas/gateway/fast/receipt-queue.js', executor: 'saas/gateway/fast/executor.js',
  journal: 'saas/gateway/fast/journal.js', composition: 'server/managed-saas-gateway.js',
  database: 'saas/db/database.js',
};
const PRIMARY_MODULES = { permits: 'server/bounded-gateway-budgets.js', database: 'saas/db/database.js' };
const BUSINESS_PIN_PATHS = Object.freeze([...Object.values(BUSINESS_MODULES).map(name => `dist/${name}`),
  'dist/server/managed-saas.js', 'dist/saas/runtime/gateway-runtime-module.js']);
const PRIMARY_PIN_PATHS = Object.freeze(Object.values(PRIMARY_MODULES).map(name => `dist/${name}`));
const FIXTURE = '/fixture';
const ROOT = path.resolve(__dirname, '../../..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function positive(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0, 'QUOTA_OBSERVER_POSITIVE_SCALAR_REQUIRED');
  return value;
}
function validateInput(input) {
  assert.ok(input && ['single', 'bounded'].includes(input.arm), 'QUOTA_OBSERVER_ARM_REQUIRED');
  assert.ok([64, 256].includes(input.httpInFlight), 'QUOTA_OBSERVER_HTTP_CONTRACT_REQUIRED');
  assert.equal(input.creditCap, String(2 * 524480 * input.httpInFlight), 'QUOTA_OBSERVER_MONEY_CONTRACT');
}
function processIdentity(pid = process.pid) {
  positive(pid);
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  assert.equal(Number(text.slice(0, text.indexOf(' '))), pid, 'QUOTA_OBSERVER_PID_IDENTITY');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.match(fields[19] ?? '', /^[1-9][0-9]*$/, 'QUOTA_OBSERVER_START_TICKS');
  return { pid, startTicks: fields[19] };
}
function validateIdentity(identity) {
  positive(identity?.pid);
  assert.match(identity?.startTicks ?? '', /^[1-9][0-9]*$/, 'QUOTA_OBSERVER_START_TICKS');
}
function atomicWrite(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function loadModules(names, pinPaths) {
  const modules = {}, modulePins = {};
  for (const [name, relative] of Object.entries(names)) {
    const file = path.join(ROOT, 'dist', relative);
    modules[name] = require(file);
  }
  // Call-graph pins are read as bytes only, never imported early to change startup.
  for (const relative of pinPaths) modulePins[relative] = sha256(fs.readFileSync(path.join(ROOT, relative)));
  return { modules, modulePins };
}
function readInput() {
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'input.json'), 'utf8'));
  validateInput(input);
  return input;
}
function receiptScalars(options) {
  assert.ok(options && typeof options === 'object', 'QUOTA_OBSERVER_QUEUE_OPTIONS');
  const allowed = new Set([...RECEIPT_FIELDS, 'journal', 'observe']);
  for (const key of Reflect.ownKeys(options)) assert.ok(allowed.has(key), 'QUOTA_OBSERVER_UNKNOWN_QUEUE_OPTION');
  assert.equal(options.observe, undefined, 'QUOTA_OBSERVER_TIMED_CALLBACK_FORBIDDEN');
  return Object.fromEntries(RECEIPT_FIELDS.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'), 'QUOTA_OBSERVER_EXPLICIT_QUEUE_SCALAR_REQUIRED');
    return [key, positive(descriptor.value)];
  }));
}
function installPatches() {
  const patches = [];
  let restored = false;
  return {
    replace(module, name, replacement) {
      assert.equal(restored, false, 'QUOTA_OBSERVER_ALREADY_RESTORED');
      const descriptor = Object.getOwnPropertyDescriptor(module, name);
      assert.ok(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable === true,
        'QUOTA_OBSERVER_WRITABLE_EXPORT_REQUIRED');
      patches.push({ module, name, descriptor });
      Object.defineProperty(module, name, { ...descriptor, value: replacement });
    },
    restore() {
      // Attempt every restoration even if one unrelated mutation made another fail.
      let failure;
      for (const item of patches.slice().reverse()) {
        try { Object.defineProperty(item.module, item.name, item.descriptor); }
        catch (error) { failure ??= error; }
      }
      restored = patches.every(item => {
        const descriptor = Object.getOwnPropertyDescriptor(item.module, item.name);
        return descriptor?.value === item.descriptor.value;
      });
      if (failure) throw failure;
      assert.ok(restored, 'QUOTA_OBSERVER_RESTORE_FAILED');
    },
    get restored() { return restored; },
  };
}

function createCheckpointHandler({ identity, nativeQueue, startupProofSha256, readRequest, writeSnapshot, now = Date.now }) {
  validateIdentity(identity);
  assert.match(startupProofSha256, /^[a-f0-9]{64}$/);
  const used = new Set();
  return () => {
    try {
      const request = readRequest();
      assert.match(request?.nonce ?? '', /^[a-f0-9]{32}$/, 'QUOTA_CHECKPOINT_NONCE');
      assert.ok(!used.has(request.nonce) && used.size < 128, 'QUOTA_CHECKPOINT_REPLAY');
      assert.ok(Array.isArray(request.actors) && request.actors.length >= 1 && request.actors.length <= 3,
        'QUOTA_CHECKPOINT_ACTORS');
      for (const actor of request.actors) validateIdentity(actor);
      assert.equal(new Set(request.actors.map(actor => actor.pid)).size, request.actors.length, 'QUOTA_CHECKPOINT_DUPLICATE_ACTOR');
      assert.equal(request.actors.filter(actor => actor.pid === identity.pid && actor.startTicks === identity.startTicks).length, 1,
        'QUOTA_CHECKPOINT_STALE_OR_UNKNOWN_ACTOR');
      // Burn a valid nonce before reading/writing: a failed checkpoint is not retried
      // under the same identity and nonce, or confused with an older proof.
      used.add(request.nonce);
      const snapshot = nativeQueue.snapshot();
      writeSnapshot({ nonce: request.nonce, identity, startupProofSha256, snapshot, observedAtUnixMs: now() });
      return true;
    } catch {
      // Never manufacture zero values or overwrite a valid older proof with success.
      // The runner must require its fresh nonce and exact identity, or fail closed.
      return false;
    }
  };
}

function createBusinessObserver({ modules, input, identity, modulePins, writeProof, checkpoint,
  lifecycle = process, deadlineMs = 240000 }) {
  validateInput(input);
  validateIdentity(identity);
  const patches = installPatches();
  const captured = {};
  let state = 'installing', failure, handleRestoration, nativeQueue, nativeJournal, checkpointHandler;
  let resolveCompletion, rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => {});
  const restore = () => {
    let error;
    try { patches.restore(); } catch (caught) { error = caught; }
    try { handleRestoration?.(); } catch (caught) { error ??= caught; }
    if (error) throw error;
  };
  const cleanupStartup = () => {
    clearTimeout(timer);
    lifecycle.removeListener('uncaughtExceptionMonitor', onFailure);
    lifecycle.removeListener('exit', onExit);
  };
  const fail = error => {
    if (state === 'failed') return;
    state = 'failed'; failure = error;
    try { restore(); } catch (caught) { failure = caught; }
    cleanupStartup();
    if (checkpointHandler) lifecycle.removeListener('SIGUSR2', checkpointHandler);
    rejectCompletion(failure);
  };
  const onFailure = error => fail(error); // Observe, do not catch/swallow Node's failure.
  const onExit = () => fail(new Error('QUOTA_OBSERVER_EXIT_BEFORE_PROOF'));
  const timer = setTimeout(() => fail(new Error('QUOTA_OBSERVER_STARTUP_DEADLINE')), deadlineMs);
  timer.unref?.();
  lifecycle.once('uncaughtExceptionMonitor', onFailure);
  lifecycle.once('exit', onExit);

  function remember(name, value) {
    assert.equal(Object.hasOwn(captured, name), false, 'QUOTA_OBSERVER_DUPLICATE_NATIVE_COMPONENT');
    captured[name] = value;
  }
  function finish() {
    if (state === 'failed') throw failure;
    if (state === 'complete' || !['receipt', 'executor', 'http', 'journal'].every(key => Object.hasOwn(captured, key))) return;
    try {
      const divisor = input.arm === 'single' ? 1 : 2;
      const pools = modules.database.ownedSaasNativePoolSnapshot().map(pool => positive(pool.maximum)).sort((a, b) => a - b);
      assert.deepEqual(pools, divisor === 1 ? [2, 14] : [2, 6], 'QUOTA_OBSERVER_NATIVE_POOL_MAXIMA');
      assert.equal(captured.http, input.httpInFlight / divisor, 'QUOTA_OBSERVER_HTTP_CAP');
      assert.equal(captured.executor, input.httpInFlight / divisor, 'QUOTA_OBSERVER_EXECUTOR_CAP');
      assert.deepEqual(captured.receipt, { maxEntries: 256 / divisor, maxBytes: 2097152 / divisor,
        maxPerTenant: 64 / divisor, workers: 8 / divisor, maxAgeMs: 5000, drainTimeoutMs: 10000 },
      'QUOTA_OBSERVER_QUEUE_LIMITS');
      assert.equal(captured.journal.stripes, 8 / divisor, 'QUOTA_OBSERVER_NATIVE_STRIPES');
      assert.equal(captured.journal.tranche, divisor === 1 ? null : String(BigInt(input.creditCap) / 2n),
        'QUOTA_OBSERVER_NATIVE_TRANCHE');
      restore();
      cleanupStartup();
      const proof = { schema: 1, role: 'business', identity, restored: patches.restored,
        modulePins, actual: { nativePools: pools, httpInFlight: captured.http,
          executorMaxLocalConcurrency: captured.executor, receipt: captured.receipt,
          stripes: captured.journal.stripes, tranche: captured.journal.tranche,
          instanceIdentitiesPreserved: true } };
      const bytes = `${JSON.stringify(proof, null, 2)}\n`;
      if (checkpoint) {
        checkpointHandler = createCheckpointHandler({ ...checkpoint, identity, nativeQueue,
          startupProofSha256: sha256(bytes) });
        lifecycle.on('SIGUSR2', checkpointHandler);
      }
      writeProof(bytes);
      state = 'complete';
      resolveCompletion(proof);
    } catch (error) { fail(error); throw error; }
  }
  function observe(action) {
    try { const value = action(); finish(); return value; }
    catch (error) { fail(error); throw error; }
  }
  try {
    const Queue = modules.queue.FastReceiptQueue;
    const Executor = modules.executor.FastGatewayExecutor;
    const Journal = modules.journal.PostgresFastGatewayJournal;
    const journalFactory = modules.journal.createFastGatewayJournal;
    const composition = modules.composition.createManagedSaasGatewayProductionComposition;
    for (const fn of [Queue, Executor, Journal, journalFactory, composition]) assert.equal(typeof fn, 'function');
    let observedQueue, observedExecutor;
    observedQueue = new Proxy(Queue, { construct(target, args, newTarget) {
      return observe(() => {
        assert.equal(newTarget, observedQueue, 'QUOTA_OBSERVER_NATIVE_QUEUE_SUBCLASS_FORBIDDEN');
        const scalars = receiptScalars(args[0]);
        assert.ok(nativeJournal && args[0].journal === nativeJournal, 'QUOTA_OBSERVER_QUEUE_JOURNAL_IDENTITY');
        const queue = Reflect.construct(target, args, target);
        assert.equal(Object.getPrototypeOf(queue), Queue.prototype, 'QUOTA_OBSERVER_QUEUE_IDENTITY');
        assert.equal(queue.constructor, Queue, 'QUOTA_OBSERVER_QUEUE_CONSTRUCTOR');
        nativeQueue = queue;
        remember('receipt', scalars);
        return queue;
      });
    } });
    observedExecutor = new Proxy(Executor, { construct(target, args, newTarget) {
      return observe(() => {
        assert.equal(newTarget, observedExecutor, 'QUOTA_OBSERVER_NATIVE_EXECUTOR_SUBCLASS_FORBIDDEN');
        assert.ok(Object.hasOwn(args[0], 'maxLocalConcurrency'), 'QUOTA_OBSERVER_EXPLICIT_EXECUTOR_CAP');
        assert.ok(nativeJournal && args[0].journal === nativeJournal && nativeQueue && args[0].receiptQueue === nativeQueue,
          'QUOTA_OBSERVER_EXECUTOR_COMPONENT_IDENTITIES');
        const executor = Reflect.construct(target, args, target);
        assert.equal(Object.getPrototypeOf(executor), Executor.prototype, 'QUOTA_OBSERVER_EXECUTOR_IDENTITY');
        assert.equal(executor.constructor, Executor, 'QUOTA_OBSERVER_EXECUTOR_CONSTRUCTOR');
        remember('executor', positive(args[0].maxLocalConcurrency));
        return executor;
      });
    } });
    patches.replace(modules.queue, 'FastReceiptQueue', observedQueue);
    patches.replace(modules.executor, 'FastGatewayExecutor', observedExecutor);
    patches.replace(modules.journal, 'createFastGatewayJournal', function (...args) {
      return observe(() => {
        const journal = Reflect.apply(journalFactory, this, args);
        assert.equal(Object.getPrototypeOf(journal), Journal.prototype, 'QUOTA_OBSERVER_JOURNAL_IDENTITY');
        assert.equal(journal.constructor, Journal, 'QUOTA_OBSERVER_JOURNAL_CONSTRUCTOR');
        assert.ok(Object.hasOwn(journal, 'stripes') && Object.hasOwn(journal, 'tranche'), 'QUOTA_OBSERVER_NATIVE_JOURNAL_FIELDS');
        assert.ok(journal.tranche === null || typeof journal.tranche === 'bigint', 'QUOTA_OBSERVER_NATIVE_TRANCHE_TYPE');
        nativeJournal = journal;
        remember('journal', { stripes: positive(journal.stripes), tranche: journal.tranche === null ? null : journal.tranche.toString() });
        return journal;
      });
    });
    patches.replace(modules.composition, 'createManagedSaasGatewayProductionComposition', function (...args) {
      return observe(() => {
        assert.ok(Object.hasOwn(args[1], 'maxHttpInFlight'), 'QUOTA_OBSERVER_EXPLICIT_HTTP_CAP');
        const httpInFlight = positive(args[1].maxHttpInFlight);
        const handle = Reflect.apply(composition, this, args);
        remember('http', httpInFlight);
        return handle;
      });
    });
    state = 'capturing';
  } catch (error) { fail(error); throw error; }
  return {
    completion,
    fail,
    restore,
    attachReadiness(handle) {
      try {
        if (state === 'failed') throw failure;
        assert.equal(handleRestoration, undefined, 'QUOTA_OBSERVER_DUPLICATE_RUNTIME_HANDLE');
        const descriptor = Object.getOwnPropertyDescriptor(handle, 'checkReady');
        assert.ok(descriptor && typeof descriptor.value === 'function' && descriptor.writable === true,
          'QUOTA_OBSERVER_READINESS_METHOD_REQUIRED');
        const original = descriptor.value;
        const gate = async function (...args) {
          try { await completion; return await Reflect.apply(original, this, args); }
          catch (error) { fail(error); throw error; }
        };
        handleRestoration = () => {
          Object.defineProperty(handle, 'checkReady', descriptor);
          assert.equal(handle.checkReady, original, 'QUOTA_OBSERVER_READINESS_RESTORE_FAILED');
        };
        Object.defineProperty(handle, 'checkReady', { ...descriptor, value: gate });
        if (state === 'complete') handleRestoration();
        return handle;
      } catch (error) { fail(error); throw error; }
    },
    dispose() {
      restore(); cleanupStartup();
      if (checkpointHandler) lifecycle.removeListener('SIGUSR2', checkpointHandler);
    },
  };
}

function createPrimaryObserver({ modules, input, identity, modulePins, writeProof, lifecycle = process, deadlineMs = 240000 }) {
  validateInput(input); validateIdentity(identity);
  assert.equal(input.arm, 'bounded');
  const patches = installPatches();
  const restore = () => { patches.restore(); clearTimeout(timer);
    lifecycle.removeListener('uncaughtExceptionMonitor', restore); lifecycle.removeListener('exit', restore); };
  const timer = setTimeout(restore, deadlineMs);
  timer.unref?.();
  lifecycle.once('uncaughtExceptionMonitor', restore); lifecycle.once('exit', restore);
  try {
    const Original = modules.permits.BoundedGatewayPermits;
    assert.equal(typeof Original, 'function');
    let observed;
    observed = new Proxy(Original, { construct(target, args, newTarget) {
      try {
        assert.equal(newTarget, observed, 'QUOTA_OBSERVER_NATIVE_PERMITS_SUBCLASS_FORBIDDEN');
        const permits = Reflect.construct(target, args, target);
        assert.equal(Object.getPrototypeOf(permits), Original.prototype);
        assert.equal(permits.constructor, Original);
        const localLimit = positive(permits.localLimit);
        assert.equal(localLimit, input.httpInFlight / 2, 'QUOTA_OBSERVER_PRIMARY_LOCAL_LIMIT');
        assert.deepEqual(modules.database.ownedSaasNativePoolSnapshot(), [], 'QUOTA_OBSERVER_PRIMARY_MUST_NOT_OWN_POOL');
        restore();
        writeProof(`${JSON.stringify({ schema: 1, role: 'primary', identity, restored: patches.restored, modulePins,
          actual: { httpLocalLimit: localLimit, nativePools: [] } }, null, 2)}\n`);
        return permits;
      } catch (error) { restore(); throw error; }
    } });
    patches.replace(modules.permits, 'BoundedGatewayPermits', observed);
  } catch (error) { restore(); throw error; }
  return { restore };
}

let businessObserver, primaryObserver;
function installBusinessObserver() {
  if (businessObserver) return businessObserver;
  const identity = processIdentity();
  businessObserver = createBusinessObserver({ ...loadModules(BUSINESS_MODULES, BUSINESS_PIN_PATHS), input: readInput(), identity,
    writeProof: bytes => atomicWrite(path.join(FIXTURE, `startup-${identity.pid}.json`), bytes),
    checkpoint: {
      readRequest: () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'checkpoint-request.json'), 'utf8')),
      writeSnapshot: value => atomicWrite(path.join(FIXTURE, `queue-${identity.pid}.json`), `${JSON.stringify(value, null, 2)}\n`),
    },
  });
  return businessObserver;
}
function installPrimaryObserver() {
  if (primaryObserver) return primaryObserver;
  primaryObserver = createPrimaryObserver({ ...loadModules(PRIMARY_MODULES, PRIMARY_PIN_PATHS), input: readInput(), identity: processIdentity(),
    writeProof: bytes => atomicWrite(path.join(FIXTURE, 'primary-startup.json'), bytes) });
  return primaryObserver;
}

module.exports = { RECEIPT_FIELDS, BUSINESS_MODULES, PRIMARY_MODULES, BUSINESS_PIN_PATHS, PRIMARY_PIN_PATHS, receiptScalars, processIdentity,
  createBusinessObserver, createPrimaryObserver, createCheckpointHandler, installBusinessObserver, installPrimaryObserver,
  readInput, sha256 };
