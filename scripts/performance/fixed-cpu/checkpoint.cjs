'use strict';
// Untimed, bounded, read-only queue/constructor proof in the app PID namespace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const { BUSINESS_PIN_PATHS, PRIMARY_PIN_PATHS } = require('./startup-observer.cjs');
const requiredPins = role => [...(role === 'business' ? BUSINESS_PIN_PATHS : PRIMARY_PIN_PATHS)].sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateConstructor(proof, input, identity) {
  assert.equal(proof.schema, 1);
  assert.equal(proof.role, 'business');
  assert.deepEqual(proof.identity, identity);
  assert.equal(proof.restored, true);
  const actual = proof.actual;
  assert.equal(actual.instanceIdentitiesPreserved, true);
  const divisor = input.arm === 'bounded' ? 2 : 1;
  assert.deepEqual(actual.nativePools, divisor === 2 ? [2, 6] : [2, 14]);
  assert.equal(actual.httpInFlight, input.httpInFlight / divisor);
  assert.equal(actual.executorMaxLocalConcurrency, input.httpInFlight / divisor);
  assert.deepEqual(actual.receipt, { maxEntries: 256 / divisor, maxBytes: 2097152 / divisor,
    maxPerTenant: 64 / divisor, workers: 8 / divisor, maxAgeMs: 5000, drainTimeoutMs: 10000 });
  assert.equal(actual.stripes, 8 / divisor);
  assert.equal(actual.tranche, divisor === 2 ? String(BigInt(input.creditCap) / 2n) : null);
  assert.deepEqual(Object.keys(proof.modulePins || {}).sort(), requiredPins('business'));
}
function validateSnapshot(proof, nonce, identity, startupProofSha256) {
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.equal(proof.nonce, nonce, 'a previous checkpoint is not fresh proof');
  assert.deepEqual(proof.identity, identity);
  assert.equal(proof.startupProofSha256, startupProofSha256);
  assert.ok(Number.isSafeInteger(proof.observedAtUnixMs));
  const snapshot = proof.snapshot;
  for (const name of ['pending', 'bytes', 'running', 'receiptRunning', 'reconciliationRunning', 'undurable', 'accepted', 'durable', 'completed', 'conflicts', 'completedWithoutReconciliation'])
    assert.ok(Number.isSafeInteger(snapshot[name]) && snapshot[name] >= 0, `missing/unknown native queue field: ${name}`);
  assert.equal(snapshot.accepting, true);
  return ['pending', 'bytes', 'running', 'receiptRunning', 'reconciliationRunning', 'undurable', 'conflicts', 'completedWithoutReconciliation'].every(name => snapshot[name] === 0)
    && snapshot.accepted === snapshot.durable && snapshot.durable === snapshot.completed
    && snapshot.undurableLiabilityByCurrency && Object.keys(snapshot.undurableLiabilityByCurrency).length === 0;
}
function verifyPins(pins, role, read = fs.readFileSync, sourceRoot = root) {
  assert.deepEqual(Object.keys(pins || {}).sort(), requiredPins(role));
  for (const [relative, hash] of Object.entries(pins)) {
    assert.match(relative, /^[a-zA-Z0-9_/-]+\.js$/);
    assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'));
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(sha(read(path.join(sourceRoot, relative))), hash, 'proof must pin this exact compiled module');
  }
}
async function checkpoint(mode, nonce) {
  assert.ok(['startup', 'queue'].includes(mode));
  assert.match(nonce, /^[a-f0-9]{32}$/);
  const input = JSON.parse(fs.readFileSync('/fixture/input.json', 'utf8'));
  const membership = JSON.parse(fs.readFileSync('/fixture/process-proof.json', 'utf8'));
  const native = require(path.join(root, 'dist/server/bounded-gateway-state.js'));
  const actors = input.arm === 'bounded' ? membership.state.slots.map(slot => slot.process) : membership.processes.map(({ pid, startTicks }) => ({ pid, startTicks }));
  assert.equal(actors.length, input.arm === 'bounded' ? 2 : 1);
  const boundary = fs.readFileSync('/proc/1/cgroup', 'utf8');
  const proofs = actors.map(identity => {
    assert.deepEqual(native.boundedGatewayProcessIdentity(identity.pid), identity);
    assert.equal(fs.readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8'), boundary);
    const bytes = fs.readFileSync(`/fixture/startup-${identity.pid}.json`);
    const proof = JSON.parse(bytes);
    validateConstructor(proof, input, identity);
    verifyPins(proof.modulePins, 'business');
    return { identity, proof, sha256: sha(bytes) };
  });
  let primary;
  if (input.arm === 'bounded') {
    primary = JSON.parse(fs.readFileSync('/fixture/primary-startup.json', 'utf8'));
    assert.equal(primary.schema, 1); assert.equal(primary.role, 'primary'); assert.equal(primary.restored, true);
    assert.deepEqual(primary.identity, membership.state.primary);
    assert.deepEqual(native.boundedGatewayProcessIdentity(1), primary.identity);
    assert.equal(primary.actual.httpLocalLimit, input.httpInFlight / 2);
    assert.deepEqual(primary.actual.nativePools, []);
    verifyPins(primary.modulePins, 'primary');
  }
  if (mode === 'startup') {
    const result = { nonce, actors: proofs, primary, constructorsValidated: true, instrumentedStartup: true, timedMethodHooks: false };
    fs.writeFileSync('/fixture/constructor-proofs.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
  }
  fs.writeFileSync('/fixture/checkpoint-request.json', JSON.stringify({ nonce, actors }) + '\n', { mode: 0o600 });
  // Every target is a fresh native identity in this owned app namespace. No host
  // PIDs, port-owner lookup, respawn/replacement or process-name signal is used.
  for (const identity of actors) {
    assert.deepEqual(native.boundedGatewayProcessIdentity(identity.pid), identity);
    process.kill(identity.pid, 'SIGUSR2');
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snapshots = [];
    for (const actor of proofs) {
      let result;
      try { result = JSON.parse(fs.readFileSync(`/fixture/queue-${actor.identity.pid}.json`, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (result.nonce !== nonce) continue;
      const zero = validateSnapshot(result, nonce, actor.identity, actor.sha256);
      snapshots.push({ ...result, queueZero: zero });
    }
    if (snapshots.length === actors.length) return { nonce, snapshots, allQueuesZero: snapshots.every(snapshot => snapshot.queueZero), instrumentedCheckpointOutsideTiming: true };
    await sleep(10);
  }
  throw new Error('QUOTA_FRESH_CHECKPOINT_TIMEOUT');
}
module.exports = { validateConstructor, validateSnapshot, verifyPins, requiredPins };
if (require.main === module) checkpoint(process.argv[2], process.argv[3]).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { console.error(error.message); process.exitCode = 1; });
