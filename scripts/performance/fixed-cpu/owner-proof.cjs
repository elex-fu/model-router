'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateState, validateClosedPair } = require('./process-proof.cjs');
const deploymentId = 'r9-current-test';
const uuid = value => assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const key = row => JSON.stringify([row.deployment_id, row.tenant_id, row.currency, row.owner, row.slot, row.epoch]);
const sort = rows => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
const equalRows = (actual, expected, label) => assert.deepEqual(sort(actual), sort(expected), label);
const names = ['policies', 'slots', 'owners', 'history', 'allocationOwners'];
async function readOwnerProof(database) {
  const sql = {
    policies: 'SELECT deployment_id,policy_digest,credit_cap_minor_units::text FROM saas_fast_gateway_deployments ORDER BY deployment_id',
    slots: 'SELECT owner,deployment_id,slot,epoch::text,active,retired_epoch::text FROM saas_fast_gateway_owner_slots ORDER BY owner',
    owners: 'SELECT owner,epoch::text FROM saas_fast_gateway_owners ORDER BY owner',
    history: 'SELECT owner,epoch::text FROM saas_fast_gateway_owner_activations ORDER BY owner,epoch',
    allocationOwners: 'SELECT DISTINCT tenant_id::text,currency,owner,epoch::text FROM saas_fast_credit_allocations ORDER BY tenant_id,currency,owner,epoch',
  };
  const result = {};
  for (const name of names) result[name] = (await database.query(sql[name])).rows;
  return result;
}
function shape(rows) {
  assert.deepEqual(Object.keys(rows).sort(), [...names].sort(), 'complete owner proof required');
  for (const name of names) assert.ok(Array.isArray(rows[name]), name);
}
function validateOwnerProof(rows, input, identity, evidence, stopped, validateSchema) {
  shape(rows); shape(evidence.seed);
  let pairs;
  if (input.arm === 'bounded') {
    for (const name of names) assert.deepEqual(evidence.seed[name], [], 'bounded arm must begin with no owner history');
    validateState(evidence.ready, input, 'ready', validateSchema);
    assert.equal(new Set(evidence.ready.slots.map(slot => slot.epoch)).size, 2, 'distinct original epochs');
    const expectedSlots = evidence.ready.slots.map(slot => {
      uuid(slot.epoch);
      assert.deepEqual(slot.recoveryEpochs, [], 'fresh cohort has no recovery history');
      return { owner: deploymentId + ':bounded-slot-' + slot.slot, deployment_id: deploymentId,
        slot: slot.slot, epoch: slot.epoch, active: true, retired_epoch: null };
    });
    pairs = expectedSlots.map(({ owner, epoch }) => ({ owner, epoch }));
    equalRows(rows.policies, [{ deployment_id: deploymentId, policy_digest: evidence.ready.policyDigest,
      credit_cap_minor_units: input.creditCap }], 'exact manifest policy; no extra deployments');
    equalRows(rows.slots, expectedSlots, 'exact retained activation claims; not process liveness');
    equalRows(rows.owners, pairs, 'exact native owners');
    equalRows(rows.history, pairs, 'exact fresh activation history; no extras/reused epochs');
    if (stopped) {
      assert.equal(evidence.closed.schemaValidated, true);
      assert.equal(evidence.closed.exactStartupIdentities, true);
      validateClosedPair(evidence.ready, evidence.closed.state, input, validateSchema);
    }
  } else {
    assert.equal(input.arm, 'single');
    const seed = evidence.seed;
    const policyDigest = createHash('sha256').update(JSON.stringify({
      contract: 'fixed-cpu-single-control/v1', http: input.httpInFlight, cap: input.creditCap,
    })).digest('hex');
    equalRows(seed.policies, [{ deployment_id: deploymentId, policy_digest: policyDigest,
      credit_cap_minor_units: input.creditCap }], 'single seed policy');
    assert.equal(seed.slots.length, 2);
    assert.equal(new Set(seed.slots.map(slot => slot.epoch)).size, 2);
    const expectedSlots = [0, 1].map(slot => {
      const row = seed.slots.find(row => row.slot === slot);
      assert.ok(row); uuid(row.epoch);
      return { owner: deploymentId + ':bounded-slot-' + slot, deployment_id: deploymentId,
        slot, epoch: row.epoch, active: false, retired_epoch: null };
    });
    equalRows(seed.slots, expectedSlots, 'single inactive seed slots');
    equalRows(seed.owners, expectedSlots.map(({ owner, epoch }) => ({ owner, epoch })), 'single seed owners');
    assert.deepEqual(seed.history, []); assert.deepEqual(seed.allocationOwners, []);
    for (const name of ['policies', 'slots', 'history']) equalRows(rows[name], seed[name], 'single seed remains unchanged: ' + name);
    const native = rows.owners.find(row => row.owner === identity.namespace);
    assert.ok(native); uuid(native.epoch);
    assert.ok(!seed.owners.some(row => row.epoch === native.epoch), 'native epoch differs from seed fences');
    pairs = [{ owner: identity.namespace, epoch: native.epoch }];
    equalRows(rows.owners, [...seed.owners, ...pairs], 'exact single native owner plus inactive seed owners');
    if (stopped) {
      shape(evidence.warm);
      for (const name of names) equalRows(rows[name], evidence.warm[name], 'single lifecycle identity unchanged: ' + name);
    }
  }
  equalRows(rows.allocationOwners, pairs.map(pair => ({ tenant_id: identity.tenantId, currency: 'USD', ...pair })),
    'all allocation owners and epochs belong to this exact cohort');
}
module.exports = { readOwnerProof, validateOwnerProof };

