import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import {
  activateBoundedOwner,
  type BoundedDeploymentSpec,
  boundedOwnerName,
  ensureBoundedCreditBudget,
  readBoundedOwnerSlots,
  registerBoundedDeployment,
  releaseBoundedOwner,
  validateBoundedDeploymentSpec,
  verifyBoundedOwner,
} from '../../../../src/saas/gateway/fast/bounded-deployment-budget.js';
import { PostgresFastGatewayJournal } from '../../../../src/saas/gateway/fast/journal.js';

const spec: BoundedDeploymentSpec = {
  deploymentId: 'unit:bounded',
  policyDigest: 'b'.repeat(64),
  creditCapMinorUnits: '100',
};

function fixture() {
  let policy: { policy_digest: string; credit_cap_minor_units: string } | undefined;
  const owners = new Map<string, string>();
  const slots = new Map<
    string,
    { owner: string; slot: 0 | 1; epoch: string; active: boolean; retired_epoch: string | null }
  >();
  const epochs = new Set<string>();
  const statements: string[] = [];
  const database: SaasDatabase = {
    query: async <Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> => {
      statements.push(sql);
      const owner = String(values[0]);
      let rows: unknown[] = [];
      let rowCount = 0;
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) rowCount = 1;
      else if (sql.startsWith('INSERT INTO saas_fast_gateway_deployments')) {
        if (!policy) {
          policy = { policy_digest: String(values[1]), credit_cap_minor_units: String(values[2]) };
          rowCount = 1;
        }
      } else if (sql.startsWith('SELECT policy_digest')) {
        rows = policy ? [policy] : [];
        rowCount = rows.length;
      } else if (sql.startsWith('INSERT INTO saas_fast_gateway_owners')) {
        if (!owners.has(owner)) {
          owners.set(owner, String(values[1]));
          rowCount = 1;
        }
      } else if (sql.startsWith('INSERT INTO saas_fast_gateway_owner_slots')) {
        slots.set(owner, {
          owner,
          slot: Number(values[2]) as 0 | 1,
          epoch: String(values[3]),
          active: false,
          retired_epoch: null,
        });
        rowCount = 1;
      } else if (sql.startsWith('SELECT epoch FROM saas_fast_gateway_owner_activations')) {
        rows = epochs.has(String(values[0])) ? [{ epoch: values[0] }] : [];
        rowCount = rows.length;
      } else if (sql.startsWith('SELECT DISTINCT tenant_id,currency FROM saas_fast_credit_allocations')) {
        rows = [];
      } else if (sql.startsWith('SELECT owner,slot')) {
        rows = [...slots.values()].sort((a, b) => a.slot - b.slot);
        rowCount = rows.length;
      } else if (sql.startsWith('SELECT epoch FROM saas_fast_gateway_owners')) {
        rows = owners.has(owner) ? [{ epoch: owners.get(owner) }] : [];
        rowCount = rows.length;
      } else if (sql.startsWith('SELECT active,epoch')) {
        rows = slots.has(owner) ? [structuredClone(slots.get(owner))] : [];
        rowCount = rows.length;
      } else if (sql.startsWith('UPDATE saas_fast_gateway_owner_slots')) {
        const row = slots.get(owner);
        assert.ok(row);
        if (row.epoch === values[2]) {
          if (sql.startsWith('UPDATE saas_fast_gateway_owner_slots SET active=true')) {
            if (epochs.has(String(values[1]))) throw Object.assign(new Error('duplicate epoch'), { code: '23505' });
            epochs.add(String(values[1]));
            row.active = true;
            row.epoch = String(values[1]);
          } else {
            row.active = false;
            row.epoch = String(values[1]);
            row.retired_epoch = String(values[2]);
          }
          rowCount = 1;
        }
      } else if (sql.startsWith('UPDATE saas_fast_gateway_owners')) {
        owners.set(owner, String(values[1]));
        rowCount = 1;
      } else if (sql.startsWith('SELECT o.owner FROM')) {
        const row = slots.get(owner);
        if (
          row?.active &&
          row.epoch === values[1] &&
          owners.get(owner) === values[1] &&
          policy?.policy_digest === values[4] &&
          policy?.credit_cap_minor_units === values[5]
        ) {
          rows = [{ owner }];
          rowCount = 1;
        }
      } else throw new Error(`Unexpected unit statement: ${sql}`);
      return { rows: rows as Row[], rowCount };
    },
    transaction: async (work) => {
      const before = {
        policy: structuredClone(policy),
        owners: new Map(owners),
        slots: structuredClone(slots),
        epochs: new Set(epochs),
      };
      try {
        return await work(database);
      } catch (error) {
        policy = before.policy;
        owners.clear();
        slots.clear();
        epochs.clear();
        for (const row of before.owners) owners.set(...row);
        for (const row of before.slots) slots.set(...row);
        for (const epoch of before.epochs) epochs.add(epoch);
        throw error;
      }
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  return { database, owners, slots, statements };
}

test('bounded policy validation preserves exact money, canonical scope and two slots', () => {
  validateBoundedDeploymentSpec(spec);
  validateBoundedDeploymentSpec({ ...spec, creditCapMinorUnits: '9007199254740993' });
  assert.equal(boundedOwnerName(spec.deploymentId, 0), 'unit:bounded:bounded-slot-0');
  assert.equal(boundedOwnerName(spec.deploymentId, 1), 'unit:bounded:bounded-slot-1');
  for (const cap of ['0', '-1', '1.0', '01', '9223372036854775808'])
    assert.throws(() => validateBoundedDeploymentSpec({ ...spec, creditCapMinorUnits: cap }));
  assert.throws(() => boundedOwnerName(spec.deploymentId, 2 as 0));
  assert.throws(() => validateBoundedDeploymentSpec({ ...spec, deploymentId: '../../other' }));
});

test('registration is exact/idempotent, refuses unknown legacy owners and never changes policy', async () => {
  const state = fixture();
  await registerBoundedDeployment(state.database, spec);
  await registerBoundedDeployment(state.database, spec);
  assert.equal(state.slots.size, 2);
  assert.ok((await readBoundedOwnerSlots(state.database, spec)).every((slot) => !slot.active));
  await assert.rejects(
    registerBoundedDeployment(state.database, { ...spec, creditCapMinorUnits: '101' }),
    /POLICY_CONFLICT/,
  );
  await assert.rejects(
    registerBoundedDeployment(state.database, { ...spec, policyDigest: 'a'.repeat(64) }),
    /POLICY_CONFLICT/,
  );
  const legacy = fixture();
  legacy.owners.set(boundedOwnerName(spec.deploymentId, 0), randomUUID());
  await assert.rejects(registerBoundedDeployment(legacy.database, spec), /LEGACY_OWNER_CONFLICT/);
  assert.equal(legacy.slots.size, 0, 'failed registration rolls back the policy and slot writes');
});

test('activation/recovery uses owner-first locks, exact epochs, no expiry and no implicit takeover', async () => {
  const state = fixture();
  await registerBoundedDeployment(state.database, spec);
  const key = { ...spec, slot: 0 as const, epoch: randomUUID() };
  const active = await activateBoundedOwner(state.database, key);
  assert.equal(active.owner, boundedOwnerName(spec.deploymentId, 0));
  await activateBoundedOwner(state.database, key);
  await verifyBoundedOwner(state.database, active);
  await assert.rejects(activateBoundedOwner(state.database, { ...key, epoch: randomUUID() }), /SLOT_ACTIVE/);
  await assert.rejects(releaseBoundedOwner(state.database, { ...key, epoch: randomUUID() }), /RELEASE_CONFLICT/);
  await releaseBoundedOwner(state.database, key);
  await releaseBoundedOwner(state.database, key);
  await assert.rejects(verifyBoundedOwner(state.database, active), /OWNER_NOT_ACTIVE/);
  assert.notEqual(state.owners.get(active.owner), key.epoch, 'release rotates the existing reserve epoch fence');
  await assert.rejects(activateBoundedOwner(state.database, key), /REUSED_EPOCH/);
  const next = { ...key, epoch: randomUUID() };
  await activateBoundedOwner(state.database, next);
  await assert.rejects(releaseBoundedOwner(state.database, key), /RELEASE_CONFLICT/);
  assert.ok(state.statements.some((sql) => sql.endsWith('FOR UPDATE')));
  assert.ok(state.statements.every((sql) => !/expires|lease|now\(\)/i.test(sql)));
});

test('bounded journal verifies a preactivated owner instead of blind owner upsert', async () => {
  const state = fixture();
  await registerBoundedDeployment(state.database, spec);
  const active = await activateBoundedOwner(state.database, { ...spec, slot: 0, epoch: randomUUID() });
  state.statements.length = 0;
  const journal = new PostgresFastGatewayJournal(state.database, {
    allocationOwner: active.owner,
    boundedDeployment: active,
  });
  await journal.checkReady();
  assert.deepEqual(
    state.statements.map((sql) => sql.split('\n')[0]),
    [
      'SELECT o.owner FROM saas_fast_gateway_owners o',
      "SELECT DISTINCT tenant_id,currency FROM saas_fast_credit_allocations WHERE owner=$1 AND epoch<>$2 AND state='active' ORDER BY tenant_id,currency",
    ],
  );
  await journal.close({ drain: false });
  await releaseBoundedOwner(state.database, active);
  const stale = new PostgresFastGatewayJournal(state.database, {
    allocationOwner: active.owner,
    boundedDeployment: active,
  });
  await assert.rejects(stale.checkReady(), /OWNER_NOT_ACTIVE/);
  await assert.rejects(stale.close({ drain: false }), /OWNER_NOT_ACTIVE/);
});

test('slow refill global headroom counts all existing epochs and remains bigint-exact', async () => {
  const statements: string[] = [];
  let cap = '9007199254741093';
  let backing = '9007199254740993';
  const tx: SqlExecutor = {
    query: async <Row>(sql: string): Promise<SqlResult<Row>> => {
      statements.push(sql);
      return {
        rows: (sql.startsWith('SELECT')
          ? [{ credit_cap_minor_units: cap, allocated_minor_units: backing }]
          : []) as Row[],
        rowCount: 1,
      };
    },
  };
  const precise = { ...spec, creditCapMinorUnits: cap };
  assert.equal(await ensureBoundedCreditBudget(tx, precise, randomUUID(), 'USD'), 100n);
  assert.match(statements[0], /SUM\(backing_minor_units\)/);
  assert.doesNotMatch(statements[0], /owner=|epoch=|state=/, 'unmapped legacy/retired owners are never filtered out');
  cap = '100';
  backing = '101';
  await assert.rejects(ensureBoundedCreditBudget(tx, spec, randomUUID(), 'USD'), /EXISTING_BACKING_EXCEEDS_CAP/);
  cap = '101';
  await assert.rejects(ensureBoundedCreditBudget(tx, spec, randomUUID(), 'USD'), /GLOBAL_CAP_CONFLICT/);
});

test('bounded startup retires only prior unused funds before readiness using owner then wallet fencing', async () => {
  const activation = { ...spec, slot: 0 as const, epoch: randomUUID(), owner: boundedOwnerName(spec.deploymentId, 0) };
  const statements: string[] = [];
  const tenantId = randomUUID();
  const database = {
    query: async <Row>(sql: string): Promise<SqlResult<Row>> => {
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.startsWith('SELECT o.owner')) rows = [{ owner: activation.owner }];
      else if (sql.startsWith('SELECT DISTINCT')) rows = [{ tenant_id: tenantId, currency: 'USD' }];
      else if (sql.startsWith('SELECT epoch FROM')) rows = [{ epoch: activation.epoch }];
      else if (sql.startsWith('SELECT credit_cap'))
        rows = [{ credit_cap_minor_units: '100', allocated_minor_units: '90' }];
      return { rows: rows as Row[], rowCount: rows.length || 1 };
    },
    transaction: async <Result>(work: (tx: SqlExecutor) => Promise<Result>): Promise<Result> => work(database),
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  } satisfies SaasDatabase;
  const journal = new PostgresFastGatewayJournal(database, {
    allocationOwner: activation.owner,
    boundedDeployment: activation,
  });
  await journal.checkReady();
  const lockOwner = statements.findIndex((sql) => sql.endsWith('FOR SHARE'));
  const lockWallet = statements.findIndex((sql) => sql.startsWith('SELECT pg_advisory'));
  const policy = statements.findIndex((sql) => sql.startsWith('INSERT INTO saas_fast_gateway_credit_budgets'));
  const retire = statements.findIndex((sql) => sql.startsWith('UPDATE saas_fast_credit_allocations'));
  assert.ok(lockOwner >= 0 && lockWallet > lockOwner && policy > lockWallet && retire > policy);
  assert.match(statements[retire], /backing_minor_units=backing_minor_units-available_minor_units/);
  assert.match(statements[retire], /owner=\$3 AND epoch<>\$4 AND state='active'/);
  assert.doesNotMatch(statements.join('\n'), /saas_fast_gateway_receipts|saas_fast_billing_jobs|expires|lease_until/);
  await journal.close({ drain: false });
});
