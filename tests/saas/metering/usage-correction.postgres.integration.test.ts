import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SaasBillingError } from '../../../src/saas/billing/errors.js';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { DurableNormalSuccessSettlementPort } from '../../../src/saas/metering/conditional-settlement-port.js';
import { SaasMeteringError } from '../../../src/saas/metering/errors.js';
import type { NormalizedUsageExact } from '../../../src/saas/metering/types.js';
import {
  type RecordUsageCorrectionInput,
  UsageCorrectionService,
} from '../../../src/saas/metering/usage-correction.js';
import {
  anyRoleConfigured,
  type Fixture,
  observedDatabase,
  observedUsage,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  safeCodes,
  seedFixture,
} from './normal-success-postgres-fixture.js';

// 063 real-PG gate: digest-addressed append-only usage corrections under the
// restricted control-plane role. Registered schema and the three
// preprovisioned roles are required. No bootstrap, HTTP fixture dependency,
// migrations, DDL, role changes or provider traffic.
interface CorrectionSnapshot {
  corrections: string;
  correctionFacts: string;
  correctionLedger: string;
  correctionAudits: string;
  balance: string;
  walletLedger: string;
  unbalanced: string;
  usageFacts: string;
  settlementFacts: string;
  requestFacts: string;
}

async function snapshot(migrator: SqlExecutor, fixture: Fixture): Promise<CorrectionSnapshot> {
  return phase('snapshot', async () => {
    const result = await migrator.query<CorrectionSnapshot>(
      `SELECT
        (SELECT count(*)::text FROM saas_usage_correction_events WHERE tenant_id = $1) AS corrections,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)::text)
           FROM saas_usage_correction_events c WHERE c.tenant_id = $1) AS "correctionFacts",
        (SELECT count(*)::text FROM saas_ledger_transactions
           WHERE tenant_id = $1 AND source_type = 'usage_correction') AS "correctionLedger",
        (SELECT count(*)::text FROM saas_audit_events
           WHERE tenant_id = $1 AND action = 'usage_correction_recorded') AS "correctionAudits",
        (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
        (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
           FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS "walletLedger",
        (SELECT count(*)::text FROM (
           SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
            WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
            HAVING count(e.id) <> 2 OR
              COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
              COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
         ) invalid) AS unbalanced,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.id), '[]'::jsonb)::text)
           FROM saas_usage_events u WHERE u.tenant_id = $1) AS "usageFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)::text)
           FROM saas_usage_settlements s WHERE s.tenant_id = $1) AS "settlementFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)::text)
           FROM saas_requests r WHERE r.tenant_id = $1) AS "requestFacts"`,
      [fixture.tenantId],
    );
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.balance, row.walletLedger, 'committed wallet projection must equal the actual ledger');
    assert.equal(row.unbalanced, '0', 'every committed ledger transaction stays balanced');
    return row;
  });
}

const CORRECTED_USAGE: NormalizedUsageExact = {
  ...observedUsage(),
  inputTotal: '2',
  inputUncached: '2',
  outputTotal: '1',
};

function correctionInput(
  fixture: Fixture,
  usageEventId: string,
  settlementId: string | null,
  delta: string,
  operatorIdentity: string,
) {
  return {
    tenantId: fixture.tenantId,
    usageEventId,
    settlementId,
    reasonCode: 'provider_reported_correction',
    correctionUsage: CORRECTED_USAGE,
    amountDeltaMinorUnits: delta,
    currency: 'USD',
    operatorIdentity,
  } satisfies RecordUsageCorrectionInput;
}

/** The audit actor FK requires a real saas_users row per operator identity. */
async function seedOperator(migrator: SqlExecutor, label: string): Promise<string> {
  const operatorId = randomUUID();
  await phase('setup', () =>
    migrator.query('INSERT INTO saas_users (id, email) VALUES ($1, $2)', [
      operatorId,
      `fin063-${label}-${operatorId}@example.test`,
    ]),
  );
  return operatorId;
}

type ExpectedCode =
  | 'USAGE_EVENT_NOT_FOUND'
  | 'USAGE_SETTLEMENT_CONFLICT'
  | 'USAGE_CORRECTION_STATE_CONFLICT'
  | 'METERING_INVALID_INPUT'
  | 'INSUFFICIENT_FUNDS';

function matchesDomainError(error: unknown, expected: ExpectedCode): boolean {
  if (safeCodes(error).hasSqlState) return false;
  if (Object.hasOwn(error as object, 'cause')) return false;
  // Overdraft surfaces from the billing ledger itself; every other rejection is
  // a metering-domain error.
  if (expected === 'INSUFFICIENT_FUNDS') {
    return error instanceof SaasBillingError && error.code === expected;
  }
  return error instanceof SaasMeteringError && error.code === expected;
}

async function assertRejected(work: () => Promise<unknown>, expected: ExpectedCode): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    if (!matchesDomainError(error, expected)) throw error;
    return true;
  });
}

class UnexpectedProbeSuccess extends Error {}
async function rejectedDml(database: SaasDatabase, sql: string, values: readonly unknown[]): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      await tx.query(sql, values);
      // If a broken ACL accepts the probe, unconditionally roll it back. This
      // sentinel is NOT presented as a fabricated PostgreSQL rejection.
      throw new UnexpectedProbeSuccess();
    });
    assert.fail('FIN063 negative transaction unexpectedly returned');
  } catch (error) {
    if (error instanceof UnexpectedProbeSuccess) assert.fail('FIN063 ACL probe was actually accepted');
    assert.equal(safeCodes(error).sqlState, '42501', 'negative probe must have the exact real driver SQLSTATE');
  }
}

async function correctionAcl(controlPlane: SqlExecutor): Promise<void> {
  await phase('acl', async () => {
    // Column-level least privilege never rolls up to has_table_privilege in
    // PostgreSQL; probe a representative column for SELECT/INSERT and the
    // table level for the mutation paths that must stay entirely absent.
    const result = await controlPlane.query<{
      role: string;
      selectCorrection: boolean;
      insertCorrection: boolean;
      updateCorrection: boolean;
      deleteCorrection: boolean;
    }>(`SELECT current_user AS role,
         has_column_privilege(current_user, 'model_router_saas.saas_usage_correction_events', 'correction_digest', 'SELECT') AS "selectCorrection",
         has_column_privilege(current_user, 'model_router_saas.saas_usage_correction_events', 'correction_digest', 'INSERT') AS "insertCorrection",
         has_table_privilege(current_user, 'model_router_saas.saas_usage_correction_events', 'UPDATE') AS "updateCorrection",
         has_table_privilege(current_user, 'model_router_saas.saas_usage_correction_events', 'DELETE') AS "deleteCorrection"`);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.role, 'model_router_saas_control_plane');
    assert.equal(row.selectCorrection, true);
    assert.equal(row.insertCorrection, true);
    assert.equal(row.updateCorrection, false, 'corrections are append-only: no UPDATE grant');
    assert.equal(row.deleteCorrection, false, 'corrections are append-only: no DELETE grant');
  });
}

test('FIN063: real persistent usage corrections, replay, concurrency and reconciliation fence', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require FIN063`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const controlPlanePeer = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            gateway.database.close(),
            controlPlane.database.close(),
            controlPlanePeer.database.close(),
            migrator.database.close(),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('FIN063 cleanup deadline')), 30_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });
  await correctionAcl(controlPlane.database);

  await t.test(
    'platform: correction credits the wallet atomically; replay and concurrency stay single-effect',
    { timeout: 60_000 },
    async () => {
      const fixture = await seedFixture(migrator.database, gateway.database, 'platform');
      const operatorId = await seedOperator(migrator.database, 'platform');
      const port = new DurableNormalSuccessSettlementPort(gateway.database, {
        metering: fixture.metering,
        billing: fixture.billing,
      });
      await phase('first_complete', () => port.complete(fixture.input));
      const events = await phase('snapshot', () =>
        fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId),
      );
      assert.equal(events.length, 1);
      const usageEventId = events[0]!.id;
      const settlement = await phase('snapshot', () =>
        fixture.metering.getUsageSettlement(fixture.tenantId, usageEventId),
      );
      assert.ok(settlement);
      const before = await snapshot(migrator.database, fixture);
      assert.equal(before.corrections, '0');
      assert.equal(before.correctionLedger, '0');
      assert.equal(before.balance, '88');

      const service = new UsageCorrectionService(controlPlane.database, {
        ledger: new PlatformWalletLedgerService(),
      });
      const credited = await phase('conflict', () =>
        service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '5', operatorId)),
      );
      assert.equal(credited.replayed, false);
      assert.ok(credited.ledgerTransactionId);
      assert.equal(credited.correction.amountDeltaMinorUnits, '5');
      assert.equal(credited.correction.correctedSettlementId, settlement.id);
      const afterCredit = await snapshot(migrator.database, fixture);
      assert.equal(afterCredit.corrections, '1');
      assert.equal(afterCredit.correctionLedger, '1');
      assert.equal(afterCredit.correctionAudits, '1', 'every created correction appends its platform audit row');
      assert.equal(afterCredit.balance, '93');
      assert.equal(afterCredit.usageFacts, before.usageFacts, 'corrections never rewrite the usage event');
      assert.equal(afterCredit.settlementFacts, before.settlementFacts, 'corrections never rewrite the settlement');
      assert.equal(afterCredit.requestFacts, before.requestFacts, 'corrections never rewrite the request');

      const replayed = await phase('replay', () =>
        service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '5', operatorId)),
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.ledgerTransactionId, null);
      assert.equal(replayed.correction.id, credited.correction.id);
      assert.equal(replayed.correction.correctionDigest, credited.correction.correctionDigest);
      assert.deepEqual(
        await snapshot(migrator.database, fixture),
        afterCredit,
        'digest replay cannot add a second effect',
      );

      // Two real connections race the identical correction. The advisory fence
      // serializes them: exactly one insert commits and one replay is observed.
      const peer = new UsageCorrectionService(controlPlanePeer.database, {
        ledger: new PlatformWalletLedgerService(),
      });
      const raceInput = correctionInput(fixture, usageEventId, settlement.id, '7', operatorId);
      const [first, second] = await phase('conflict', () =>
        Promise.all([service.recordUsageCorrection(raceInput), peer.recordUsageCorrection(raceInput)]),
      );
      assert.equal(first.replayed === second.replayed, false, 'exactly one racer commits the correction');
      assert.equal(first.correction.id, second.correction.id);
      const afterRace = await snapshot(migrator.database, fixture);
      assert.equal(afterRace.corrections, '2');
      assert.equal(afterRace.correctionLedger, '2');
      assert.equal(afterRace.correctionAudits, '2', 'the losing racer replays and adds no audit row');
      assert.equal(afterRace.balance, '100');

      const debited = await phase('conflict', () =>
        service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '-3', operatorId)),
      );
      assert.equal(debited.replayed, false);
      assert.equal((await snapshot(migrator.database, fixture)).balance, '97');

      await assertRejected(
        () => service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '-1000', operatorId)),
        'INSUFFICIENT_FUNDS',
      );
      assert.equal(
        (await snapshot(migrator.database, fixture)).corrections,
        '3',
        'overdraft rolls back the correction event',
      );
      assert.equal((await snapshot(migrator.database, fixture)).balance, '97');

      await assertRejected(
        () => service.recordUsageCorrection(correctionInput(fixture, usageEventId, null, '1', operatorId)),
        'METERING_INVALID_INPUT',
      );
      await assertRejected(
        () =>
          service.recordUsageCorrection(correctionInput(fixture, usageEventId, 'wrong-settlement', '1', operatorId)),
        'USAGE_SETTLEMENT_CONFLICT',
      );

      const listed = await phase('snapshot', () => service.listUsageCorrections({ tenantId: fixture.tenantId }));
      assert.equal(listed.length, 3);
      const listedForEvent = await phase('snapshot', () =>
        service.listUsageCorrections({ tenantId: fixture.tenantId, usageEventId }),
      );
      assert.equal(listedForEvent.length, 3);
    },
  );

  await t.test('byok: corrections are event-only and reject any wallet delta', { timeout: 60_000 }, async () => {
    const fixture = await seedFixture(migrator.database, gateway.database, 'byok');
    const operatorId = await seedOperator(migrator.database, 'byok');
    const port = new DurableNormalSuccessSettlementPort(gateway.database, {
      metering: fixture.metering,
      billing: fixture.billing,
    });
    await phase('first_complete', () => port.complete(fixture.input));
    const events = await phase('snapshot', () =>
      fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId),
    );
    const usageEventId = events[0]!.id;
    const settlement = await phase('snapshot', () =>
      fixture.metering.getUsageSettlement(fixture.tenantId, usageEventId),
    );
    assert.ok(settlement);
    const service = new UsageCorrectionService(controlPlane.database, {
      ledger: new PlatformWalletLedgerService(),
    });

    await assertRejected(
      () => service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '1', operatorId)),
      'METERING_INVALID_INPUT',
    );
    const created = await phase('first_complete', () =>
      service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '0', operatorId)),
    );
    assert.equal(created.replayed, false);
    assert.equal(created.ledgerTransactionId, null, 'BYOK never touches the platform wallet');
    const committed = await snapshot(migrator.database, fixture);
    assert.equal(committed.corrections, '1');
    assert.equal(committed.correctionLedger, '0');
    assert.equal(committed.correctionAudits, '1');
    assert.equal(committed.balance, '0');
  });

  await t.test('a request under unknown-outcome reconciliation refuses corrections', { timeout: 60_000 }, async () => {
    const fixture = await seedFixture(migrator.database, gateway.database, 'platform');
    const operatorId = await seedOperator(migrator.database, 'reconciliation');
    const i = fixture.input;
    const usageEventId = await phase('first_complete', () =>
      gateway.database.transaction(async (tx) => {
        const event = await fixture.metering.recordUsageEvent({ ...i, eventKey: i.usageEventKey }, { executor: tx });
        await fixture.metering.createUsageSettlement(
          { tenantId: i.tenantId, usageEventId: event.id, settlementKey: i.settlementKey },
          { executor: tx },
        );
        await fixture.metering.transitionRequest({
          ...i,
          executor: tx,
          expectedResultState: 'pending',
          expectedReconciliationState: 'none',
          expectedStateVersion: 1,
          resultState: 'pending',
          reconciliationState: 'pending',
        });
        return event.id;
      }),
    );
    const settlement = await phase('snapshot', () =>
      fixture.metering.getUsageSettlement(fixture.tenantId, usageEventId),
    );
    assert.ok(settlement);
    const service = new UsageCorrectionService(controlPlane.database, {
      ledger: new PlatformWalletLedgerService(),
    });
    const before = await snapshot(migrator.database, fixture);
    await assertRejected(
      () => service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '5', operatorId)),
      'USAGE_CORRECTION_STATE_CONFLICT',
    );
    assert.deepEqual(await snapshot(migrator.database, fixture), before, 'reconciliation fence cannot add an effect');
  });

  await t.test('control-plane role cannot mutate or erase recorded corrections', { timeout: 60_000 }, async () => {
    const fixture = await seedFixture(migrator.database, gateway.database, 'platform');
    const operatorId = await seedOperator(migrator.database, 'acl');
    const port = new DurableNormalSuccessSettlementPort(gateway.database, {
      metering: fixture.metering,
      billing: fixture.billing,
    });
    await phase('first_complete', () => port.complete(fixture.input));
    const events = await phase('snapshot', () =>
      fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId),
    );
    const usageEventId = events[0]!.id;
    const settlement = await phase('snapshot', () =>
      fixture.metering.getUsageSettlement(fixture.tenantId, usageEventId),
    );
    assert.ok(settlement);
    const service = new UsageCorrectionService(controlPlane.database, {
      ledger: new PlatformWalletLedgerService(),
    });
    const created = await phase('first_complete', () =>
      service.recordUsageCorrection(correctionInput(fixture, usageEventId, settlement.id, '0', operatorId)),
    );
    assert.equal(created.replayed, false);
    const before = await snapshot(migrator.database, fixture);
    await phase('acl', () =>
      rejectedDml(
        controlPlane.database,
        'UPDATE saas_usage_correction_events SET amount_delta_minor_units = 0 WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, created.correction.id],
      ),
    );
    await phase('acl', () =>
      rejectedDml(controlPlane.database, 'DELETE FROM saas_usage_correction_events WHERE tenant_id = $1 AND id = $2', [
        fixture.tenantId,
        created.correction.id,
      ]),
    );
    assert.deepEqual(await snapshot(migrator.database, fixture), before);
  });
});
