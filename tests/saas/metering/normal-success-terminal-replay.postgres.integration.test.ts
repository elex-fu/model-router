import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import type { NormalSuccessTransactionInput } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { DurableNormalSuccessSettlementPort } from '../../../src/saas/metering/conditional-settlement-port.js';
import { SaasMeteringError } from '../../../src/saas/metering/errors.js';
import { REQUIRED_FLAG, anyRoleConfigured, completeLegacy, observedDatabase, observedUsage, phase,
  roleUrls, safeCodes, seedFixture, type Fixture } from './normal-success-postgres-fixture.js';

// Registered schema/three preprovisioned roles are required. No bootstrap,
// HTTP fixture dependency, migrations, DDL, role changes or provider traffic.
// This is a billing/metering transaction proof, NOT full gateway acceptance.
interface Snapshot {
  usage: string; settlements: string; wallets: string; balance: string; walletLedger: string;
  reservations: string; activeHold: string; billingTransactions: string; entries: string; unbalanced: string;
  prices: string; evidence: string; providerLeases: string; capacity: string;
  requestFacts: string; attemptFacts: string; usageFacts: string; settlementFacts: string; holdFacts: string;
}
async function snapshot(migrator: SqlExecutor, fixture: Fixture): Promise<Snapshot> {
  return phase('snapshot', async () => {
    const result = await migrator.query<Snapshot>(
      `SELECT
        (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1) AS usage,
        (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1) AS settlements,
        (SELECT count(*)::text FROM saas_wallets WHERE tenant_id = $1) AS wallets,
        (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
        (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
           FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS "walletLedger",
        (SELECT count(*)::text FROM saas_billing_reservations WHERE tenant_id = $1) AS reservations,
        (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_billing_reservations
          WHERE tenant_id = $1 AND state IN ('reserved', 'reconciliation_pending')) AS "activeHold",
        (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = $1 AND source_type = 'billing_settlement') AS "billingTransactions",
        (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS entries,
        (SELECT count(*)::text FROM (
           SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
            WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
            HAVING count(e.id) <> 2 OR
              COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
              COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
         ) invalid) AS unbalanced,
        (SELECT count(*)::text FROM saas_request_customer_price_snapshots WHERE tenant_id = $1) AS prices,
        (SELECT count(*)::text FROM saas_prepared_request_evidence WHERE tenant_id = $1 AND status = 'claimed') AS evidence,
        (SELECT count(*)::text FROM saas_provider_account_leases WHERE tenant_id = $1) AS "providerLeases",
        (SELECT count(*)::text FROM saas_gateway_capacity_reservations WHERE tenant_id = $1) AS capacity,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)::text)
           FROM saas_requests r WHERE tenant_id = $1) AS "requestFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)::text)
           FROM saas_attempts a WHERE tenant_id = $1) AS "attemptFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.id), '[]'::jsonb)::text)
           FROM saas_usage_events u WHERE tenant_id = $1) AS "usageFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)::text)
           FROM saas_usage_settlements s WHERE tenant_id = $1) AS "settlementFacts",
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.id), '[]'::jsonb)::text)
           FROM saas_billing_reservations h WHERE tenant_id = $1) AS "holdFacts"`, [fixture.tenantId]);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.balance, row.walletLedger, 'committed wallet projection must equal the actual ledger');
    assert.equal(row.unbalanced, '0', 'every actual committed ledger transaction has one balanced pair');
    return row;
  });
}

async function assertPersistedProof(fixture: Fixture, legacy: boolean): Promise<void> {
  const events = await phase('snapshot', () => fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId));
  assert.equal(events.length, 1);
  const event = events[0]!;
  const settlement = await phase('snapshot', () => fixture.metering.getUsageSettlement(fixture.tenantId, event.id));
  assert.ok(settlement);
  assert.equal(settlement.kind, 'usage_recorded');
  assert.equal(settlement.usageEventId, event.id);
  assert.equal(settlement.settlementKeyDigest, fixture.settlementKeyDigest, 'original private HMAC key digest is bound');
  assert.equal(settlement.normalSuccessEvidenceRef, legacy ? null : fixture.input.usageEvidenceRef);
  const tuple = legacy ? [fixture.tenantId, event.id, 'usage_recorded', event.eventDigest] : [
    'model-router.normal-success-settlement.v1', fixture.tenantId, event.id, 'usage_recorded',
    event.eventDigest, fixture.settlementKeyDigest, fixture.input.usageEvidenceRef,
  ];
  const expected = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  assert.equal(settlement.settlementDigest, expected, 'database digest must bind the independently constructed canonical tuple');
}

async function assertSettledHold(gateway: SqlExecutor, fixture: Fixture): Promise<void> {
  await phase('snapshot', async () => {
    // Only manifest-allowed GW columns, never a ledger-entry SELECT.
    const result = await gateway.query<{
      id: string; tenant_id: string; request_id: string; wallet_id: string; currency: string;
      idempotency_namespace: string; business_key: string; amount: string; state: string;
      price_snapshot_ref: string; settlement_id: string; charge: string; usage_evidence_ref: string;
      ledger_transaction_id: string;
    }>(`SELECT id, tenant_id, request_id, wallet_id, currency, idempotency_namespace, business_key,
          amount_minor_units::text AS amount, state, price_snapshot_ref, settlement_id,
          settlement_amount_minor_units::text AS charge, usage_evidence_ref, ledger_transaction_id
        FROM saas_billing_reservations WHERE tenant_id = $1 AND request_id = $2`,
    [fixture.tenantId, fixture.input.requestId]);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.id, fixture.input.reservationId);
    assert.equal(row.tenant_id, fixture.tenantId); assert.equal(row.request_id, fixture.input.requestId);
    assert.ok(row.wallet_id); assert.equal(row.currency, 'USD');
    assert.equal(row.idempotency_namespace, 'saas.billing.reservation');
    assert.equal(row.business_key, `saas-request-admission:${fixture.tenantId}:${fixture.input.requestId}`);
    assert.equal(row.amount, '50'); assert.equal(row.charge, '12'); assert.equal(row.state, 'settled');
    assert.equal(row.price_snapshot_ref, fixture.input.priceSnapshotRef);
    assert.equal(row.settlement_id, fixture.input.settlementKey);
    assert.equal(row.usage_evidence_ref, fixture.input.usageEvidenceRef);
    assert.ok(row.ledger_transaction_id);
  });
}

// Each probe names its exact rejection, not a suite-wide allowlist. These
// plain messages are static contracts in DurableNormalSuccessSettlementPort;
// missing replay capability, bad state, storage and programming errors are
// deliberately absent. Never report an observed message or original error.
type ExpectedRejection = 'USAGE_DUPLICATE_CONFLICT' | 'USAGE_SETTLEMENT_CONFLICT'
  | 'normal-success settlement input is invalid'
  | 'normal-success BYOK input contains wallet authority'
  | 'normal-success settlement identity does not match stored authority'
  | 'normal-success replay does not match its settled hold';
interface ConflictCase {
  readonly change: Partial<NormalSuccessTransactionInput>;
  readonly expected: ExpectedRejection;
}
function matchesRejection(error: unknown, expected: ExpectedRejection): boolean {
  if (safeCodes(error).hasSqlState) return false;
  if (expected === 'USAGE_DUPLICATE_CONFLICT' || expected === 'USAGE_SETTLEMENT_CONFLICT') {
    return error instanceof SaasMeteringError && error.code === expected && !Object.hasOwn(error, 'cause');
  }
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype ||
    Object.hasOwn(error, 'cause') || Object.hasOwn(error, 'code') || Object.hasOwn(error, 'name')) return false;
  const message = Object.getOwnPropertyDescriptor(error, 'message');
  return Boolean(message && 'value' in message && message.value === expected);
}

async function assertNoEffects(
  migrator: SqlExecutor, gateway: ReturnType<typeof observedDatabase>, fixture: Fixture,
  work: () => Promise<unknown>, expected: ExpectedRejection | null, readOnly = true,
): Promise<void> {
  const before = await snapshot(migrator, fixture);
  const commands = { ...gateway.commands };
  if (expected !== null) await phase('conflict', () => assert.rejects(work, (error: unknown) => {
    // Any different exception is a failed test, including SQLSTATE, TypeError,
    // AssertionError, storage errors and capability-missing failures. The
    // existing outer phase sanitizes it without accepting it as evidence.
    if (!matchesRejection(error, expected)) throw error;
    return true;
  }));
  else await phase('replay', work);
  assert.deepEqual(await snapshot(migrator, fixture), before, 'replay/conflict cannot change committed facts');
  if (readOnly) assert.deepEqual(gateway.commands, commands,
    'actual PG driver must acknowledge no INSERT/UPDATE/DELETE for terminal replay or rejection');
}

class UnexpectedProbeSuccess extends Error {}
async function rejectedDml(database: SaasDatabase, sql: string, values: readonly unknown[], expected: string): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      await tx.query(sql, values);
      // If a broken guard accepts the probe, unconditionally roll it back.
      // This sentinel is NOT presented as a fabricated PostgreSQL rejection.
      throw new UnexpectedProbeSuccess();
    });
    assert.fail('FIN057 negative transaction unexpectedly returned');
  } catch (error) {
    if (error instanceof UnexpectedProbeSuccess) assert.fail('FIN057 immutable/ACL probe was actually accepted');
    assert.equal(safeCodes(error).sqlState, expected, 'negative probe must have the exact real driver SQLSTATE');
  }
}

async function acl(executor: SqlExecutor, role: 'model_router_saas_gateway' | 'model_router_saas_control_plane') {
  return phase('acl', async () => {
    const result = await executor.query<{
      role: string; safeRole: boolean; refInsert: boolean; refSelect: boolean; refUpdate: boolean;
      deleteSettlement: boolean; schemaCreate: boolean; functionExecute: string;
    }>(`SELECT current_user AS role,
       NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS "safeRole",
       has_column_privilege(current_user, 'model_router_saas.saas_usage_settlements', 'normal_success_evidence_ref', 'INSERT') AS "refInsert",
       has_column_privilege(current_user, 'model_router_saas.saas_usage_settlements', 'normal_success_evidence_ref', 'SELECT') AS "refSelect",
       has_column_privilege(current_user, 'model_router_saas.saas_usage_settlements', 'normal_success_evidence_ref', 'UPDATE') AS "refUpdate",
       has_table_privilege(current_user, 'model_router_saas.saas_usage_settlements', 'DELETE') AS "deleteSettlement",
       has_schema_privilege(current_user, 'model_router_saas', 'CREATE') AS "schemaCreate",
       (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'model_router_saas' AND has_function_privilege(current_user, p.oid, 'EXECUTE')) AS "functionExecute"
       FROM pg_roles r WHERE r.rolname = current_user`);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.role, role);
    assert.equal(row.safeRole, true);
    assert.equal(row.refUpdate, false);
    assert.equal(row.deleteSettlement, false);
    assert.equal(row.schemaCreate, false);
    assert.equal(row.functionExecute, '0');
    if (role === 'model_router_saas_gateway') {
      assert.equal(row.refInsert, true);
      assert.equal(row.refSelect, true);
    }
    return row;
  });
}

test('FIN057: real persistent normal-success evidence and terminal replay under restricted gateway', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
    ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require FIN057` : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const migrator = observedDatabase(urls[0]), controlPlane = observedDatabase(urls[1]), gateway = observedDatabase(urls[2]);
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([gateway.database.close(), controlPlane.database.close(), migrator.database.close()]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('FIN057 cleanup deadline')), 30_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });
  const gatewayAcl = await acl(gateway.database, 'model_router_saas_gateway');
  const controlAcl = await acl(controlPlane.database, 'model_router_saas_control_plane');

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(`${mode}: first completion stores original ref; same facts replay without a second effect`, { timeout: 45_000 }, async () => {
      const fixture = await seedFixture(migrator.database, gateway.database, mode);
      const port = new DurableNormalSuccessSettlementPort(gateway.database, { metering: fixture.metering, billing: fixture.billing });
      const before = await snapshot(migrator.database, fixture);
      assert.equal(before.usage, '0'); assert.equal(before.settlements, '0');
      assert.equal(before.evidence, '1');
      assert.equal(before.activeHold, mode === 'platform' ? '50' : '0');
      const completed = await phase('first_complete', () => port.complete(fixture.input));
      assert.equal(completed.kind, 'settled');
      assert.equal(completed.attempt.resultState, 'succeeded');
      await assertPersistedProof(fixture, false);
      const committed = await snapshot(migrator.database, fixture);
      assert.equal(committed.usage, '1'); assert.equal(committed.settlements, '1');
      assert.equal(committed.providerLeases, '0'); assert.equal(committed.capacity, '0');
      if (mode === 'byok') {
        assert.equal(committed.wallets, '0'); assert.equal(committed.balance, '0');
        assert.equal(committed.reservations, '0'); assert.equal(committed.billingTransactions, '0'); assert.equal(committed.entries, '0');
      } else {
        assert.equal(committed.wallets, '1'); assert.equal(committed.balance, '88');
        assert.equal(committed.reservations, '1'); assert.equal(committed.prices, '1');
        assert.equal(committed.activeHold, '0'); assert.equal(committed.billingTransactions, '1'); assert.equal(committed.entries, '4');
        await assertSettledHold(gateway.database, fixture);
      }
      for (let repeat = 0; repeat < 2; repeat += 1) await assertNoEffects(migrator.database, gateway, fixture, async () => {
        // UsageValues explicitly accepts string/number/bigint. This is a valid
        // typed service input, not a wider public DTO or a cast-based bypass.
        const replayInput: NormalSuccessTransactionInput = { ...fixture.input,
          usage: { ...observedUsage(), inputTotal: '0003', outputTotal: 2n } };
        const replay = await port.complete(replayInput);
        assert.equal(replay.kind, 'replayed');
        assert.equal(replay.attempt.id, completed.attempt.id);
        assert.equal(replay.attempt.stateVersion, completed.attempt.stateVersion);
      }, null);

      const conflicts: ConflictCase[] = [
        { change: { usageEvidenceRef: '9'.repeat(64) }, expected: 'USAGE_SETTLEMENT_CONFLICT' },
        { change: { settlementKey: 'other-settlement-key' }, expected: 'USAGE_SETTLEMENT_CONFLICT' },
        { change: { usageEventKey: 'other-event-key' }, expected: 'USAGE_DUPLICATE_CONFLICT' },
        { change: { usage: { ...observedUsage(), inputTotal: '4', inputUncached: '4' } }, expected: 'USAGE_DUPLICATE_CONFLICT' },
        { change: { usage: { ...observedUsage(), outputTotal: '3' } }, expected: 'USAGE_DUPLICATE_CONFLICT' },
      ];
      if (mode === 'platform') conflicts.push(
        { change: { currency: 'EUR' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { chargeAmountMinorUnits: '13' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { reservationId: 'another-hold' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { priceSnapshotRef: 'another-quote' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { customerPriceVersion: 'another-price' }, expected: 'normal-success settlement identity does not match stored authority' });
      else conflicts.push(
        { change: { currency: 'USD' }, expected: 'normal-success BYOK input contains wallet authority' },
        { change: { chargeAmountMinorUnits: '0' }, expected: 'normal-success BYOK input contains wallet authority' },
        { change: { reservationId: 'unexpected-hold' }, expected: 'normal-success BYOK input contains wallet authority' });
      for (const { change, expected } of conflicts) await assertNoEffects(migrator.database, gateway, fixture,
        () => port.complete({ ...fixture.input, ...change }), expected);
      await assertNoEffects(migrator.database, gateway, fixture,
        () => Reflect.apply(port.complete, port, [{ ...fixture.input, usageEvidenceRef: undefined }]),
        'normal-success settlement input is invalid');
      const events = await phase('snapshot', () => fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId));
      await assertNoEffects(migrator.database, gateway, fixture, () => fixture.metering.createUsageSettlement({
        tenantId: fixture.tenantId, usageEventId: events[0]!.id, settlementKey: fixture.input.settlementKey,
        // Omitted normalSuccessEvidenceRef cannot downgrade the already-bound row.
      }), 'USAGE_SETTLEMENT_CONFLICT', false);
    });
  }

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(`${mode}: legacy NULL-ref row is never rewritten; replay follows its safe compatibility contract`, { timeout: 45_000 }, async () => {
      const fixture = await seedFixture(migrator.database, gateway.database, mode);
      await phase('legacy_complete', () => completeLegacy(gateway.database, fixture));
      await assertPersistedProof(fixture, true);
      const committed = await snapshot(migrator.database, fixture);
      assert.equal(committed.usage, '1'); assert.equal(committed.settlements, '1');
      if (mode === 'byok') {
        assert.equal(committed.wallets, '0'); assert.equal(committed.reservations, '0'); assert.equal(committed.entries, '0');
      } else {
        assert.equal(committed.wallets, '1'); assert.equal(committed.balance, '88');
        assert.equal(committed.reservations, '1'); assert.equal(committed.prices, '1');
        assert.equal(committed.activeHold, '0'); assert.equal(committed.billingTransactions, '1'); assert.equal(committed.entries, '4');
        await assertSettledHold(gateway.database, fixture);
      }
      const port = new DurableNormalSuccessSettlementPort(gateway.database, { metering: fixture.metering, billing: fixture.billing });
      await assertNoEffects(migrator.database, gateway, fixture, async () => {
        const result = await port.complete(fixture.input);
        assert.equal(result.kind, 'replayed');
      }, mode === 'byok' ? 'USAGE_SETTLEMENT_CONFLICT' : null);
      const conflicts: ConflictCase[] = [
        { change: { usageEvidenceRef: '8'.repeat(64) }, expected: mode === 'byok'
          ? 'USAGE_SETTLEMENT_CONFLICT' : 'normal-success replay does not match its settled hold' },
        { change: { settlementKey: 'new-legacy-key' }, expected: 'USAGE_SETTLEMENT_CONFLICT' },
        { change: { usage: { ...observedUsage(), outputTotal: '3' } }, expected: 'USAGE_DUPLICATE_CONFLICT' },
      ];
      if (mode === 'platform') conflicts.push(
        { change: { chargeAmountMinorUnits: '13' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { currency: 'EUR' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { priceSnapshotRef: 'new-legacy-quote' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { reservationId: 'new-legacy-hold' }, expected: 'normal-success replay does not match its settled hold' },
        { change: { customerPriceVersion: 'new-legacy-price' }, expected: 'normal-success settlement identity does not match stored authority' });
      for (const { change, expected } of conflicts) await assertNoEffects(migrator.database, gateway, fixture,
        () => port.complete({ ...fixture.input, ...change }), expected);
      const events = await phase('snapshot', () => fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId));
      await assertNoEffects(migrator.database, gateway, fixture, () => fixture.metering.createUsageSettlement({
        tenantId: fixture.tenantId, usageEventId: events[0]!.id, settlementKey: fixture.input.settlementKey,
        normalSuccessEvidenceRef: fixture.input.usageEvidenceRef,
      }), 'USAGE_SETTLEMENT_CONFLICT', false); // Existing NULL ref is not backfilled by a normal writer.
    });
  }

  await t.test('actual UPDATE/DELETE guards and narrow evidence-column ACL remain enforced', { timeout: 45_000 }, async () => {
    const fixture = await seedFixture(migrator.database, gateway.database, 'byok');
    const port = new DurableNormalSuccessSettlementPort(gateway.database, { metering: fixture.metering, billing: fixture.billing });
    await phase('first_complete', () => port.complete(fixture.input));
    const events = await phase('snapshot', () => fixture.metering.listUsageEvents(fixture.tenantId, fixture.input.requestId));
    const settlement = await phase('snapshot', () => fixture.metering.getUsageSettlement(fixture.tenantId, events[0]!.id));
    assert.ok(settlement);
    const before = await snapshot(migrator.database, fixture);
    await phase('immutability', () => rejectedDml(gateway.database,
      'UPDATE saas_usage_settlements SET settlement_digest = $3 WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, settlement.id, '7'.repeat(64)], '55000'));
    await phase('acl', () => rejectedDml(gateway.database,
      'UPDATE saas_usage_settlements SET normal_success_evidence_ref = $3 WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, settlement.id, '6'.repeat(64)], '42501'));
    await phase('acl', () => rejectedDml(gateway.database,
      'DELETE FROM saas_usage_settlements WHERE tenant_id = $1 AND id = $2', [fixture.tenantId, settlement.id], '42501'));
    // Trusted setup-role NEGATIVE probes prove trigger immutability independently
    // of app ACL denial. Accepted mutations are forcibly rolled back and fail.
    await phase('immutability', () => rejectedDml(migrator.database,
      'DELETE FROM saas_usage_settlements WHERE tenant_id = $1 AND id = $2', [fixture.tenantId, settlement.id], '55000'));
    await phase('immutability', () => rejectedDml(migrator.database,
      'UPDATE saas_usage_settlements SET normal_success_evidence_ref = NULL WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, settlement.id], '55000'));
    assert.deepEqual(await snapshot(migrator.database, fixture), before);
  });
  assert.deepEqual(await acl(gateway.database, 'model_router_saas_gateway'), gatewayAcl);
  assert.deepEqual(await acl(controlPlane.database, 'model_router_saas_control_plane'), controlAcl);
});
