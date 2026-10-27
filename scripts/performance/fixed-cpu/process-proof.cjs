'use strict';
// Explicit untimed readback in the app PID namespace. Never inspects host PIDs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const totals = input => ({ httpInFlight: input.httpInFlight, databasePoolMax: 16, receiptEntries: 256,
  receiptBytes: 2097152, receiptPerTenant: 64, receiptWorkers: 8, creditStripes: 8 });
function validateState(state, input, phase, validateSchema) {
  validateSchema(state);
  assert.equal(state.phase, phase);
  assert.equal(state.deploymentId, 'r9-current-test');
  assert.equal(state.creditCapMinorUnits, input.creditCap);
  assert.deepEqual(state.totals, totals(input));
  assert.equal(state.primary.pid, 1);
  assert.equal(state.slots.length, 2);
  assert.equal(new Set(state.slots.map(slot => slot?.process?.pid)).size, 2);
  for (const [index, slot] of state.slots.entries()) {
    assert.ok(slot?.process);
    assert.equal(slot.slot, index);
    assert.equal(slot.phase, phase === 'ready' ? 'ready' : 'exited');
    assert.equal(slot.forced, false);
    assert.equal(slot.signal, null);
    assert.equal(slot.exitCode, phase === 'ready' ? null : 0);
  }
}
function closed(input) {
  const state = JSON.parse(fs.readFileSync('/fixture/state/state.json', 'utf8'));
  const native = require(path.join(root, 'dist/server/bounded-gateway-state.js'));
  validateState(state, input, 'closed', native.validateBoundedGatewayState);
  const previous = JSON.parse(fs.readFileSync('/fixture/process-proof.json', 'utf8')).state;
  assert.equal(state.generation, previous.generation);
  assert.deepEqual(state.primary, previous.primary);
  for (const [index, slot] of state.slots.entries()) {
    assert.deepEqual(slot.process, previous.slots[index].process);
    assert.equal(slot.epoch, previous.slots[index].epoch);
  }
  fs.writeFileSync('/fixture/closed-state-proof.json', JSON.stringify({ state, schemaValidated: true, exactStartupIdentities: true }) + '\n', { mode: 0o600 });
}
function ready(input) {
  const native = require(path.join(root, 'dist/server/bounded-gateway-state.js'));
  const state = input.arm === 'bounded' ? JSON.parse(fs.readFileSync('/fixture/state/state.json', 'utf8')) : null;
  if (state) validateState(state, input, 'ready', native.validateBoundedGatewayState);
  const pids = state ? [state.primary.pid, ...state.slots.map(slot => slot.process.pid)] : [1];
  const files = ['cgroup.controllers', 'cpu.max', 'cpu.stat', 'memory.max', 'memory.current', 'memory.peak', 'memory.events', 'cgroup.procs', 'cgroup.threads'];
  const cgroup = Object.fromEntries(files.map(name => [name, fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8')]));
  const members = new Set(cgroup['cgroup.procs'].trim().split(/\s+/).map(Number));
  const boundary = fs.readFileSync('/proc/1/cgroup', 'utf8');
  const processes = pids.map(pid => {
    assert.ok(members.has(pid), 'actual business/primary PID must be in the app cgroup');
    assert.equal(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'), boundary);
    const identity = native.boundedGatewayProcessIdentity(pid);
    const expected = state ? (pid === 1 ? state.primary : state.slots.find(slot => slot.process.pid === pid).process) : identity;
    assert.deepEqual(identity, expected);
    const threads = fs.readdirSync(`/proc/${pid}/task`).map(Number);
    for (const tid of threads) assert.equal(fs.readFileSync(`/proc/${pid}/task/${tid}/cgroup`, 'utf8'), boundary);
    return { ...identity, threads, cgroup: boundary };
  });
  const proof = { observedAtUnixMs: Date.now(), state, processes, cgroup, primaryAndEveryBusinessProcessProven: true };
  fs.writeFileSync('/fixture/process-proof.json', JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(proof) + '\n');
}
module.exports = { validateState, closed };
if (require.main === module) ready(JSON.parse(fs.readFileSync('/fixture/input.json', 'utf8')));
