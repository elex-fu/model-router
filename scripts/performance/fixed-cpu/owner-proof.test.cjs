'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { validateOwnerProof, readOwnerProof } = require('./owner-proof.cjs');
const input = { arm: 'bounded', httpInFlight: 64, creditCap: '67133440' };
const identity = { tenantId: 'tenant-fixture', namespace: 'quota-fixture' };
const deploymentId = 'r9-current-test';
const epoch = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ policies: [], slots: [], owners: [], history: [], allocationOwners: [] });
function bounded() {
  const ready = { version: 1, phase: 'ready', deploymentId, machineId: 'a'.repeat(64),
    bootId: epoch(90), generation: epoch(91), policyDigest: 'b'.repeat(64),
    creditCapMinorUnits: input.creditCap, primary: { pid: 1, startTicks: '100' },
    totals: { httpInFlight: 64, databasePoolMax: 16, receiptEntries: 256, receiptBytes: 2097152,
      receiptPerTenant: 64, receiptWorkers: 8, creditStripes: 8 },
    slots: [0, 1].map(slot => ({ slot, epoch: epoch(slot + 1), recoveryEpochs: [],
      process: { pid: 10 + slot, startTicks: String(200 + slot) }, phase: 'ready',
      forced: false, signal: null, exitCode: null })) };
  const state = clone(ready); state.phase = 'closed';
  state.slots.forEach(slot => { slot.phase = 'exited'; slot.exitCode = 0; });
  const rows = empty();
  rows.policies = [{ deployment_id: deploymentId, policy_digest: ready.policyDigest, credit_cap_minor_units: input.creditCap }];
  rows.slots = ready.slots.map(slot => ({ owner: deploymentId + ':bounded-slot-' + slot.slot,
    deployment_id: deploymentId, slot: slot.slot, epoch: slot.epoch, active: true, retired_epoch: null }));
  rows.owners = rows.slots.map(({ owner, epoch }) => ({ owner, epoch }));
  rows.history = clone(rows.owners);
  rows.allocationOwners = rows.owners.map(pair => ({ tenant_id: identity.tenantId, currency: 'USD', ...pair }));
  return { rows, evidence: { seed: empty(), ready, closed: { state, schemaValidated: true, exactStartupIdentities: true } } };
}
test('bounded clean stop retains only the exact original durable activation claims', () => {
  const value = bounded(); let schemas = 0;
  validateOwnerProof(value.rows, input, identity, value.evidence, true, () => schemas++);
  assert.equal(schemas, 3, 'ready and both members of the closed pair use native schema validation');
});
test('count two is insufficient: reject wrong identity, history, policy, flag and manifest', () => {
  const changes = [
    value => { value.rows.slots[0].owner = 'foreign'; },
    value => { value.rows.slots[0].epoch = epoch(7); },
    value => { value.rows.slots[0].active = false; },
    value => { value.rows.slots[0].retired_epoch = epoch(7); },
    value => { value.rows.owners[0].epoch = epoch(7); },
    value => { value.rows.owners.push({ owner: 'extra', epoch: epoch(8) }); },
    value => { value.rows.history.pop(); },
    value => { value.rows.history.push({ owner: value.rows.owners[0].owner, epoch: epoch(8) }); },
    value => { value.rows.history[1].epoch = value.rows.history[0].epoch; },
    value => { value.rows.policies[0].policy_digest = 'c'.repeat(64); },
    value => { value.rows.policies.push(clone(value.rows.policies[0])); },
    value => { value.rows.allocationOwners[0].epoch = epoch(7); },
    value => { value.rows.allocationOwners[0].tenant_id = 'foreign'; },
    value => { value.evidence.seed.history.push({ owner: 'old', epoch: epoch(7) }); },
    value => { value.evidence.closed.state.slots[0].epoch = epoch(7); },
    value => { value.evidence.closed.state.slots[0].forced = true; },
    value => { value.evidence.closed.state.slots[0].process.startTicks = '999'; },
    value => { value.evidence.closed.state.policyDigest = 'c'.repeat(64); },
    value => { value.evidence.closed.state.generation = epoch(7); },
    value => { value.evidence.closed.exactStartupIdentities = false; },
    value => { value.evidence.ready.slots[0].recoveryEpochs = [epoch(7)]; },
  ];
  for (const change of changes) {
    const value = bounded(); change(value);
    assert.throws(() => validateOwnerProof(value.rows, input, identity, value.evidence, true, () => {}));
  }
});
function single() {
  const singleInput = { ...input, arm: 'single' };
  const seed = empty();
  seed.policies = [{ deployment_id: deploymentId, credit_cap_minor_units: input.creditCap,
    policy_digest: createHash('sha256').update(JSON.stringify({ contract: 'fixed-cpu-single-control/v1',
      http: input.httpInFlight, cap: input.creditCap })).digest('hex') }];
  seed.slots = [0, 1].map(slot => ({ owner: deploymentId + ':bounded-slot-' + slot,
    deployment_id: deploymentId, slot, epoch: epoch(slot + 1), active: false, retired_epoch: null }));
  seed.owners = seed.slots.map(({ owner, epoch }) => ({ owner, epoch }));
  const rows = clone(seed), native = { owner: identity.namespace, epoch: epoch(3) };
  rows.owners.push(native);
  rows.allocationOwners = [{ tenant_id: identity.tenantId, currency: 'USD', ...native }];
  return { singleInput, rows, evidence: { seed, warm: clone(rows) } };
}
test('single keeps two exact inactive seed fences plus one native owner, with no activation history', () => {
  const value = single();
  validateOwnerProof(value.rows, value.singleInput, identity, value.evidence, true, () => assert.fail('single has no bounded process manifest'));
  for (const change of [
    value => { value.rows.slots[0].active = true; },
    value => { value.rows.slots[0].epoch = epoch(7); },
    value => { value.rows.history.push({ owner: identity.namespace, epoch: epoch(3) }); },
    value => { value.rows.owners[2].epoch = epoch(7); value.rows.allocationOwners[0].epoch = epoch(7); },
    value => { value.rows.owners.push({ owner: 'extra', epoch: epoch(8) }); },
  ]) {
    const changed = single(); change(changed);
    assert.throws(() => validateOwnerProof(changed.rows, changed.singleInput, identity, changed.evidence, true, () => {}));
  }
});


test('owner census reads all rows without joins or filters that could hide extras', async () => {
  const seen = [];
  const value = await readOwnerProof({ query: async sql => { seen.push(sql); return { rows: [] }; } });
  assert.deepEqual(value, empty());
  assert.equal(seen.length, 5);
  for (const sql of seen) {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(WHERE|JOIN|UPDATE|DELETE|INSERT)\b/);
  }
  for (const name of ['deployments', 'owner_slots', 'owners', 'owner_activations'])
    assert.ok(seen.some(sql => sql.includes('saas_fast_gateway_' + name)));
  assert.ok(seen.some(sql => sql.includes('saas_fast_credit_allocations')));
});
