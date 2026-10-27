import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PlatformWalletLedgerService } from '../../../../src/saas/billing/service.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import {
  activateBoundedOwner,
  type BoundedDeploymentSpec,
  type BoundedOwnerActivation,
  readBoundedOwnerSlots,
  registerBoundedDeployment,
  releaseBoundedOwner,
} from '../../../../src/saas/gateway/fast/bounded-deployment-budget.js';
import { PostgresFastGatewayJournal } from '../../../../src/saas/gateway/fast/journal.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../../metering/normal-success-postgres-fixture.js';
import { intentFixture, priceFixture, receiptFixture } from './journal-fixture.js';

const enabled = process.env[REQUIRED_FLAG] === '1' || anyRoleConfigured;
test('bounded global budgets retain every old owner and epoch under real restricted PostgreSQL roles', {
  skip: !enabled,
  timeout: 60_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await gateway.close();
    await migrator.close();
  });
  await gateway.verifySchema();
  const billing = new PlatformWalletLedgerService();
  async function tenant() {
    const id = randomUUID();
    await migrator.query("INSERT INTO saas_tenants(id,name,slug) VALUES($1,'bounded-budget-test',$2)", [id, id]);
    await migrator.transaction((tx) =>
      billing.postVerifiedFunding(tx, {
        tenantId: id,
        currency: 'USD',
        amountMinorUnits: '1000',
        sourceOrderRef: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    return id;
  }
  async function deployment(cap = '100') {
    const spec: BoundedDeploymentSpec = {
      deploymentId: `native:${randomUUID()}`,
      policyDigest: 'c'.repeat(64),
      creditCapMinorUnits: cap,
    };
    await registerBoundedDeployment(gateway, spec);
    const activations = await Promise.all(
      ([0, 1] as const).map((slot) => activateBoundedOwner(gateway, { ...spec, slot, epoch: randomUUID() })),
    );
    return { spec, activations };
  }
  function journal(activation: BoundedOwnerActivation, tranche = '50') {
    return new PostgresFastGatewayJournal(gateway, {
      allocationOwner: activation.owner,
      boundedDeployment: activation,
      allocationTrancheMinorUnits: tranche,
      allocationStripes: 4,
    });
  }
  async function census(tenantId: string) {
    const result = await gateway.query<{ actual: string; counter: string; cap: string; retired: string }>(
      `SELECT (SELECT COALESCE(SUM(backing_minor_units),0)::text FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND currency='USD') AS actual,
        allocated_minor_units::text AS counter,credit_cap_minor_units::text AS cap,
        (SELECT COALESCE(SUM(backing_minor_units),0)::text FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND currency='USD' AND state='retired') AS retired
       FROM saas_fast_gateway_credit_budgets WHERE tenant_id=$1 AND currency='USD'`,
      [tenantId],
    );
    const row = result.rows[0];
    assert.ok(row);
    assert.equal(row.actual, row.counter, 'trigger-owned counter equals all active + retired allocations');
    assert.ok(BigInt(row.actual) <= BigInt(row.cap));
    return row;
  }

  await t.test(
    'initial global policy counts unrelated legacy retired liabilities, never adopts their identity',
    async () => {
      const tenantId = await tenant();
      const legacyOwner = randomUUID();
      const legacy = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: legacyOwner,
        allocationTrancheMinorUnits: '100',
      });
      await legacy.replenish(tenantId, 'USD');
      assert.equal((await legacy.reserveIntent(intentFixture(tenantId, legacyOwner))).kind, 'created');
      await legacy.close(); // Missing receipt remains backed at80, retired.
      const { activations } = await deployment();
      const a = journal(activations[0]);
      const b = journal(activations[1]);
      await Promise.all([a.replenish(tenantId, 'USD'), b.replenish(tenantId, 'USD')]);
      assert.deepEqual(await census(tenantId), { actual: '100', counter: '100', cap: '100', retired: '80' });
      await Promise.all([a.close(), b.close()]);
      assert.equal((await census(tenantId)).actual, '80');
    },
  );

  await t.test('restart cannot refill over old uncertainty; settlement reopens only proved headroom', async () => {
    const tenantId = await tenant();
    const { spec, activations } = await deployment();
    const a = journal(activations[0]);
    const b = journal(activations[1]);
    await Promise.all([a.replenish(tenantId, 'USD'), b.replenish(tenantId, 'USD')]);
    const held = await a.reserveIntent(intentFixture(tenantId, activations[0].owner, priceFixture('30')));
    assert.equal(held.kind, 'created');
    if (held.kind !== 'created') throw new Error('missing intent');
    await a.close();
    assert.deepEqual(await census(tenantId), { actual: '80', counter: '80', cap: '100', retired: '30' });
    await releaseBoundedOwner(gateway, activations[0]); // This test has closed its exact old runtime owner.
    const replacement = await activateBoundedOwner(gateway, { ...spec, slot: 0, epoch: randomUUID() });
    const next = journal(replacement);
    await next.replenish(tenantId, 'USD');
    assert.deepEqual(await census(tenantId), { actual: '100', counter: '100', cap: '100', retired: '30' });
    assert.equal(
      (await next.reserveIntent(intentFixture(tenantId, replacement.owner, priceFixture('21')))).kind,
      'denied',
    );
    await next.appendReceipt(receiptFixture(held.intent, '10'));
    await next.drain();
    assert.equal((await census(tenantId)).actual, '70');
    await next.replenish(tenantId, 'USD');
    assert.equal((await census(tenantId)).actual, '100');
    await Promise.all([next.close(), b.close()]);
    assert.equal((await census(tenantId)).actual, '0');
  });

  await t.test('explicit restart retires dormant prior unused backing at startup but keeps unresolved H', async () => {
    const tenantId = await tenant();
    const { spec, activations } = await deployment();
    const old = journal(activations[0]);
    await old.replenish(tenantId, 'USD');
    assert.equal(
      (await old.reserveIntent(intentFixture(tenantId, activations[0].owner, priceFixture('30')))).kind,
      'created',
    );
    // Fatal owner stopped: intentionally preserve its durable allocation. This
    // adapter has no independent pool; closing it proves it issues no more work.
    await old.close({ drain: false });
    await releaseBoundedOwner(gateway, activations[0]);
    const active = await activateBoundedOwner(gateway, { ...spec, slot: 0, epoch: randomUUID() });
    const next = journal(active);
    await next.checkReady(); // No replenish/request is needed to release old A=20.
    assert.deepEqual(await census(tenantId), { actual: '30', counter: '30', cap: '100', retired: '30' });
    await next.close();
    assert.equal(
      (await census(tenantId)).actual,
      '30',
      'missing receipt remains backed after graceful successor shutdown',
    );
  });

  await t.test(
    'direct budget initialization takes the wallet fence before a concurrent legitimate backing writer',
    async () => {
      const tenantId = await tenant();
      const { spec } = await deployment();
      const legacy = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '50',
      });
      const concurrent = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      await legacy.replenish(tenantId, 'USD');
      const key = saasAdvisoryKey.walletFence(tenantId, 'USD');
      let acknowledge = () => {};
      let release = () => {};
      const inserted = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const initializer = gateway.transaction(async (tx) => {
        // Intentionally omit the application fence: the INSERT guard must own it.
        await tx.query(
          `INSERT INTO saas_fast_gateway_credit_budgets(tenant_id,currency,deployment_id,credit_cap_minor_units,allocated_minor_units)
        VALUES($1,'USD',$2,100,50)`,
          [tenantId, spec.deploymentId],
        );
        const owned = await tx.query<{ owned: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
          AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended($1,0)&4294967295) AND objsubid=1) AS owned`,
          [key],
        );
        assert.equal(owned.rows[0]?.owned, true, 'the exact existing wallet fence is held by direct INSERT');
        acknowledge();
        await held;
      });
      void initializer.catch(() => {});
      let writer: Promise<void> | undefined;
      try {
        await Promise.race([
          inserted,
          initializer.then(() => {
            throw new Error('initializer exited before barrier');
          }),
        ]);
        writer = concurrent.replenish(tenantId, 'USD');
        void writer.catch(() => {});
        const deadline = Date.now() + 5000;
        let waiting = false;
        do {
          const locks = await migrator.query<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND NOT granted
            AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
            AND objid::bigint=(hashtextextended($1,0)&4294967295) AND objsubid=1) AS waiting`,
            [key],
          );
          waiting = locks.rows[0]?.waiting === true;
          if (!waiting) await delay(10);
        } while (!waiting && Date.now() < deadline);
        assert.equal(
          waiting,
          true,
          'concurrent existing-protocol refill waits rather than missing an uncommitted policy',
        );
      } finally {
        release();
      }
      await initializer;
      assert.ok(writer);
      await assert.rejects(writer, { code: '23514' });
      assert.equal((await census(tenantId)).actual, '50');
      await Promise.all([legacy.close(), concurrent.close()]);
    },
  );

  await t.test(
    'old writers cannot bypass the cap, direct counter mutation is forbidden and rebalance is atomic',
    async () => {
      const tenantId = await tenant();
      const { activations } = await deployment();
      const a = journal(activations[0]);
      const b = journal(activations[1]);
      await Promise.all([a.replenish(tenantId, 'USD'), b.replenish(tenantId, 'USD')]);
      const legacy = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      await assert.rejects(legacy.replenish(tenantId, 'USD'), { code: '23514' });
      assert.equal((await census(tenantId)).actual, '100');
      await assert.rejects(
        gateway.query('UPDATE saas_fast_gateway_credit_budgets SET allocated_minor_units=0 WHERE tenant_id=$1', [
          tenantId,
        ]),
        { code: '42501' },
      );
      await assert.rejects(
        migrator.query('UPDATE saas_fast_gateway_credit_budgets SET allocated_minor_units=0 WHERE tenant_id=$1', [
          tenantId,
        ]),
        { code: '55000' },
      );
      assert.equal(
        (
          await gateway.query<{ allowed: boolean }>(
            "SELECT has_function_privilege(current_user,'saas_fast_global_budget_backing()','EXECUTE') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
      // A temporary positive stripe movement followed by the matching negative
      // movement is legal only because the final transaction total is unchanged.
      await gateway.transaction(async (tx) => {
        await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, 'USD')]);
        const rows = await tx.query<{ id: string }>(
          "SELECT id FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND state='active' ORDER BY id FOR UPDATE",
          [tenantId],
        );
        assert.ok(rows.rows.length >= 2);
        await tx.query(
          'UPDATE saas_fast_credit_allocations SET backing_minor_units=backing_minor_units+1,available_minor_units=available_minor_units+1 WHERE id=$1',
          [rows.rows[0].id],
        );
        await tx.query(
          'UPDATE saas_fast_credit_allocations SET backing_minor_units=backing_minor_units-1,available_minor_units=available_minor_units-1 WHERE id=$1',
          [rows.rows[1].id],
        );
      });
      assert.equal((await census(tenantId)).actual, '100');
      await Promise.all([a.close(), b.close(), legacy.close()]);
    },
  );

  await t.test(
    'over-cap opt-in and wrong policy roll back; active epochs cannot be silently overwritten or reused',
    async () => {
      const tenantId = await tenant();
      const legacy = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '150',
      });
      await legacy.replenish(tenantId, 'USD');
      const { spec, activations } = await deployment();
      const a = journal(activations[0]);
      await assert.rejects(a.replenish(tenantId, 'USD'), /EXISTING_BACKING_EXCEEDS_CAP/);
      assert.equal(
        (await gateway.query('SELECT tenant_id FROM saas_fast_gateway_credit_budgets WHERE tenant_id=$1', [tenantId]))
          .rowCount,
        0,
      );
      await assert.rejects(
        registerBoundedDeployment(gateway, { ...spec, creditCapMinorUnits: '200' }),
        /POLICY_CONFLICT/,
      );
      await assert.rejects(activateBoundedOwner(gateway, { ...spec, slot: 0, epoch: randomUUID() }), /SLOT_ACTIVE/);
      await assert.rejects(
        gateway.query('UPDATE saas_fast_gateway_owners SET epoch=$2 WHERE owner=$1', [
          activations[0].owner,
          randomUUID(),
        ]),
        { code: '55000' },
      );
      await a.close();
      await releaseBoundedOwner(gateway, activations[0]);
      await releaseBoundedOwner(gateway, activations[0]);
      await assert.rejects(
        gateway.transaction(async (tx) => {
          await tx.query('UPDATE saas_fast_gateway_owner_slots SET active=true,epoch=$2 WHERE owner=$1', [
            activations[0].owner,
            activations[0].epoch,
          ]);
          await tx.query('UPDATE saas_fast_gateway_owners SET epoch=$2 WHERE owner=$1', [
            activations[0].owner,
            activations[0].epoch,
          ]);
        }),
        { code: '23505' },
        'direct restricted-role SQL cannot resurrect ANY historical epoch',
      );

      await assert.rejects(activateBoundedOwner(gateway, activations[0]), /REUSED_EPOCH/);
      const next = await activateBoundedOwner(gateway, { ...spec, slot: 0, epoch: randomUUID() });
      await releaseBoundedOwner(gateway, next);
      await assert.rejects(activateBoundedOwner(gateway, activations[0]), /REUSED_EPOCH/);
      assert.equal((await readBoundedOwnerSlots(gateway, spec))[0].active, false);
      await legacy.close();
    },
  );
});
