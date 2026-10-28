import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boundedGatewayBudgets } from '../../src/server/bounded-gateway-budgets.js';
import {
  type BoundedGatewayState,
  boundedGatewayMachineId,
  boundedGatewayProcessIdentity,
  boundedGatewayProcessIsAlive,
  readBoundedGatewayState,
  validateBoundedGatewayState,
  writeBoundedGatewayState,
} from '../../src/server/bounded-gateway-state.js';
import { boundedGatewayConnectionScope } from '../../src/server/bounded-gateway-supervisor.js';

function state(): BoundedGatewayState {
  return {
    version: 1,
    deploymentId: 'unit',
    machineId: 'a'.repeat(64),
    bootId: randomUUID(),
    generation: randomUUID(),
    primary: { pid: process.pid, startTicks: '1' },
    totals: boundedGatewayBudgets(),
    creditCapMinorUnits: '1000',
    policyDigest: 'b'.repeat(64),
    phase: 'starting',
    slots: [null, null],
  };
}
test('persisted generation and every process/slot identity are validated before recovery can inspect or delete a lock', () => {
  const good = state();
  validateBoundedGatewayState(good);
  for (const invalid of [
    { ...good, generation: undefined },
    { ...good, generation: 'x' },
    { ...good, primary: {} },
    { ...good, primary: { pid: -1, startTicks: '1' } },
    { ...good, slots: [null] },
    { ...good, creditCapMinorUnits: '0' },
    { ...good, totals: { databasePoolMax: 16 } },
    { ...good, totals: { ...good.totals, additionalPool: 2 } },
    {
      ...good,
      slots: [
        {
          slot: 0,
          epoch: randomUUID(),
          process: null,
          phase: 'ready',
          recoveryEpochs: [],
          exitCode: null,
          signal: null,
          forced: false,
        },
        null,
      ],
    },
  ]) {
    assert.throws(() => validateBoundedGatewayState(invalid), /INVALID_STATE/);
  }
});
test('state roundtrip preserves recovery epoch history without receipts, credentials or pending client closures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-state-'));
  try {
    const expected = state();
    expected.slots[0] = {
      slot: 0,
      epoch: randomUUID(),
      process: { pid: process.pid, startTicks: '1' },
      phase: 'exited',
      recoveryEpochs: [randomUUID()],
      exitCode: null,
      signal: 'SIGKILL',
      forced: false,
    };
    writeBoundedGatewayState(directory, expected);
    assert.deepEqual(readBoundedGatewayState(directory), expected);
    assert.equal(readBoundedGatewayState(join(directory, 'absent')), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('Linux process identity compares process start ticks, not PID existence alone', {
  skip: process.platform !== 'linux',
}, () => {
  const identity = boundedGatewayProcessIdentity(process.pid);
  assert.equal(boundedGatewayProcessIsAlive(identity), true);
  assert.equal(boundedGatewayProcessIsAlive({ ...identity, startTicks: `${BigInt(identity.startTicks) + 1n}` }), false);
  assert.match(boundedGatewayMachineId(), /^[a-f0-9]{64}$/);
});

test('recovery pins endpoint/database/login and Redis scope while permitting credential rotation', () => {
  const reference = boundedGatewayConnectionScope('postgresql://gateway:fixture-one@db.local:5432/gateway');
  assert.equal(reference, boundedGatewayConnectionScope('postgresql://gateway:fixture-two@db.local:5432/gateway'));
  for (const value of [
    'postgresql://other@db.local:5432/gateway',
    'postgresql://gateway@other.local:5432/gateway',
    'postgresql://gateway@db.local:5433/gateway',
    'postgresql://gateway@db.local:5432/other',
  ]) {
    assert.notEqual(reference, boundedGatewayConnectionScope(value));
  }
  for (const query of [
    'host=other.local',
    'user=other',
    'options=-crole=other',
    'application_name=untracked',
    'password=hidden',
  ]) {
    assert.throws(() => boundedGatewayConnectionScope(`postgresql://gateway@db.local/gateway?${query}`));
  }
  assert.throws(() => boundedGatewayConnectionScope('postgresql://db.local/gateway'));
  assert.notEqual(
    boundedGatewayConnectionScope('redis://redis.local/0'),
    boundedGatewayConnectionScope('redis://redis.local/1'),
  );
});
