import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import type { ReserveBillingInput, SettleBillingInput } from '../../../src/saas/billing/types.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';

// The managed PG15/18 job provisions these identities and all registered
// migrations before this file runs. REQUIRED=1 must turn missing config red.
const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configuredUrls = roleConfig.map(([name]) => process.env[name]?.trim());
const anyConfigured = configuredUrls.some(Boolean);

function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roleConfig.map(([name, role], index) => {
    const value = configuredUrls[index];
    assert.ok(value, `${name} is required for FIN-01`);
    // Do not include connection strings (which may contain credentials) in errors.
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid PostgreSQL URL`);
    }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), `${name} must be PostgreSQL`);
    assert.equal(decodeURIComponent(parsed.username), role, `${name} must use ${role}`);
    const hostname = parsed.hostname.toLowerCase();
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    assert.equal(parsed.hash, '', `${name} must not contain a fragment`);
    // Reject query options entirely: host, socket, port, dbname, options and
    // search_path overrides must not redirect the explicitly authorized target.
    assert.equal(parsed.search, '', `${name} must not contain connection overrides`);
    const ciTarget = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const localTarget =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Boolean(parsed.port) && Number.isInteger(port) && port > 0 && port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ciTarget || localTarget,
      `${name} must target postgres:5432/model_router_saas_ci or a disposable model_router_saas_ci/model_router_test_* loopback database on an explicit nondefault port`);
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity;
    assert.equal(identity, target, 'all FIN-01 role URLs must identify the same disposable database');
    return value;
  });
}

async function transaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SET LOCAL statement_timeout = '10s'`);
    await tx.query(`SET LOCAL idle_in_transaction_session_timeout = '15s'`);
    return work(tx);
  });
}

interface Fixture {
  tenantId: string;
  walletId: string;
  fundingId: string;
  label: string;
}

async function seedFixture(migrator: SaasDatabase, refundFreeze = false): Promise<Fixture> {
  const fixture = { tenantId: randomUUID(), walletId: randomUUID(), fundingId: randomUUID(), label: randomUUID() };
  const { tenantId, walletId, fundingId, label } = fixture;
  await transaction(migrator, async (tx) => {
    await tx.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1, 'FIN-01', $2)`,
      [tenantId, `fin-01-${label}`]);
    await tx.query(`INSERT INTO saas_wallets (id, tenant_id, currency) VALUES ($1, $2, 'USD')`,
      [walletId, tenantId]);
    // Seed a real balanced funding pair, then project its balance using the
    // normal ledger evidence guard. No rebuild flag, trigger bypass or grants.
    await tx.query(
      `INSERT INTO saas_ledger_transactions
         (id, tenant_id, currency, idempotency_namespace, business_key, source_type,
          amount_minor_units, metadata_ref, source_order_ref)
       VALUES ($1, $2, 'USD', 'fin-01.seed', $3, 'wallet_funding', 100, $3, $3)`,
      [fundingId, tenantId, `fin-01-funding-${label}`]);
    await tx.query(
      `INSERT INTO saas_ledger_entries
         (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
       VALUES ($1, $3, $4, 'USD', 'credit', 100, 'wallet', $5::text, $5::uuid),
              ($2, $3, $4, 'USD', 'debit', 100, 'funding_source', $6, NULL)`,
      [randomUUID(), randomUUID(), fundingId, tenantId, walletId, `fin-01-funding-${label}`]);
    await tx.query(
      `SELECT set_config('saas.billing_ledger_projection_write', 'on', true),
              set_config('saas.billing_ledger_transaction_id', $1, true)`, [fundingId]);
    const projected = await tx.query(
      `UPDATE saas_wallets SET posted_balance_minor_units = 100 WHERE id = $1 AND tenant_id = $2`,
      [walletId, tenantId]);
    assert.equal(projected.rowCount, 1);
    if (refundFreeze) {
      const userId = randomUUID();
      const orderId = randomUUID();
      const refundId = randomUUID();
      await tx.query(`INSERT INTO saas_users (id, email) VALUES ($1, $2)`,
        [userId, `fin-01-${label}@example.test`]);
      await tx.query(
        `INSERT INTO saas_payment_orders
           (id, tenant_id, order_type, provider_key, merchant_id, client_request_id, local_order_ref,
            funding_reference, amount_minor_units, currency, state, provider_order_id, provider_attempts,
            funding_transaction_id, paid_at, fulfilled_at)
         VALUES ($1, $2, 'wallet_topup', 'fin-01', 'fin-01', $3, $3, $4, 100, 'USD',
                 'fulfilled', $3, 1, $5, now(), now())`,
        [orderId, tenantId, `fin-01-order-${label}`, `fin-01-funding-${label}`, fundingId]);
      await tx.query(
        `INSERT INTO saas_refund_orders
           (id, tenant_id, refund_type, wallet_topup_order_id, original_funding_transaction_id, wallet_id,
            provider_key, merchant_id, provider_order_id, original_local_order_ref, idempotency_namespace,
            client_request_id, requested_by_user_id, authorization_ref, reason_code,
            amount_minor_units, currency, state, provider_attempts)
         VALUES ($1, $2, 'wallet_topup', $3, $4, $5, 'fin-01', 'fin-01', $6, $6, 'fin-01.refund',
                 $6, $7, $6, 'CUSTOMER_REQUEST', 40, 'USD', 'unknown', 1)`,
        [refundId, tenantId, orderId, fundingId, walletId, `fin-01-order-${label}`, userId]);
      await tx.query(
        `INSERT INTO saas_refund_wallet_freezes
           (refund_order_id, tenant_id, wallet_id, currency, amount_minor_units)
         VALUES ($1, $2, $3, 'USD', 40)`, [refundId, tenantId, walletId]);
    }
  });
  return fixture;
}

function reserveInput(fixture: Fixture, suffix: string, amount = '70', now = new Date()): ReserveBillingInput {
  // BillingService deliberately takes opaque refs: through 052 there is no
  // saas_requests/snapshot FK or prepared-evidence guard on this table. This
  // focused service suite does not claim to cover gateway admission guards.
  return {
    supplyMode: 'platform', tenantId: fixture.tenantId, currency: 'USD', amountMinorUnits: amount,
    requestId: `fin-01-request-${fixture.label}-${suffix}`,
    businessKey: `fin-01-request-${fixture.label}-${suffix}`,
    priceSnapshotRef: `fin-01-price-v1-${fixture.label}`,
    metadataRef: `fin-01-metadata-${fixture.label}-${suffix}`,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
}

function settleInput(input: ReserveBillingInput): SettleBillingInput {
  return {
    supplyMode: 'platform', tenantId: input.tenantId, requestId: input.requestId,
    businessKey: input.businessKey, currency: input.currency, priceSnapshotRef: input.priceSnapshotRef,
    amountMinorUnits: '30', settlementId: `settlement:${input.requestId}`, usageEvidenceRef: `usage:${input.requestId}`,
  };
}

async function snapshot(database: SaasDatabase, fixture: Fixture) {
  const result = await database.query<{
    posted: string; wallet_ledger: string; holds: string; refund_freezes: string;
    reservations: string; transactions: string; entries: string; settlements: string; unbalanced: string;
  }>(
    `SELECT w.posted_balance_minor_units::text AS posted,
       (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
          FROM saas_ledger_entries WHERE tenant_id = w.tenant_id AND wallet_id = w.id) AS wallet_ledger,
       (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_billing_reservations
          WHERE tenant_id = w.tenant_id AND state IN ('reserved', 'reconciliation_pending')) AS holds,
       (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_refund_wallet_freezes
          WHERE tenant_id = w.tenant_id) AS refund_freezes,
       (SELECT count(*)::text FROM saas_billing_reservations WHERE tenant_id = w.tenant_id) AS reservations,
       (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = w.tenant_id) AS transactions,
       (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = w.tenant_id) AS entries,
       (SELECT count(*)::text FROM saas_ledger_transactions
          WHERE tenant_id = w.tenant_id AND source_type = 'billing_settlement') AS settlements,
       (SELECT count(*)::text FROM (
          SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
          WHERE l.tenant_id = w.tenant_id GROUP BY l.id, l.amount_minor_units
          HAVING count(e.id) <> 2 OR
            COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
            COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
        ) invalid) AS unbalanced
     FROM saas_wallets w WHERE w.id = $1 AND w.tenant_id = $2`, [fixture.walletId, fixture.tenantId]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.posted, row.wallet_ledger, 'wallet projection must equal committed wallet ledger entries');
  assert.equal(row.unbalanced, '0', 'every committed ledger transaction must have exactly one balanced pair');
  assert.ok(BigInt(row.holds) + BigInt(row.refund_freezes) <= BigInt(row.posted));
  return row;
}

function billingCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, code);
    return true;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function concurrentReserves(gateway: SaasDatabase, service: PlatformWalletLedgerService,
  inputs: readonly [ReserveBillingInput, ReserveBillingInput]) {
  const ready = deferred<void>();
  const backendIds = new Set<number>();
  const reserve = (input: ReserveBillingInput) => transaction(gateway, async (tx) => {
    const pid = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    backendIds.add(pid.rows[0]!.pid);
    if (backendIds.size === 2) ready.resolve();
    // Both transactions must be open on distinct real connections before either
    // reserve enters the wallet fence. Timeouts prevent a missing peer hanging.
    await ready.promise;
    return service.reserve(tx, input);
  }).catch((error: unknown) => { ready.resolve(); throw error; });
  const results = await Promise.allSettled(inputs.map(reserve));
  assert.equal(backendIds.size, 2, 'the race must use two distinct PostgreSQL backends');
  const successes = results.filter((result) => result.status === 'fulfilled');
  const failures = results.filter((result) => result.status === 'rejected');
  assert.equal(successes.length, 1, 'exactly one competing reserve may consume the available balance');
  assert.equal(failures.length, 1);
  for (const failure of failures) billingCode('INSUFFICIENT_FUNDS')(failure.reason);
}

test('FIN-01: bounded real PostgreSQL wallet financial invariants under restricted workload identities', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
    ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require FIN-01` : false,
  timeout: 120_000,
}, async (t) => {
  // Validate all targets before creating any pool. In particular, local 5432 is
  // never eligible, while the designated CI service 5432 is explicitly allowed.
  const urls = safeRoleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0]!, max: 1 });
  const controlPlane = createSaasDatabase({ connectionString: urls[1]!, max: 1 });
  const gateway = createSaasDatabase({ connectionString: urls[2]!, max: 2 });
  const service = new PlatformWalletLedgerService();
  try {
    for (const [index, database] of [migrator, controlPlane, gateway].entries()) {
      const identity = await database.query<{ principal: string; session: string; schema: string; superuser: boolean }>(
        `SELECT current_user AS principal, session_user AS session, current_schema() AS schema,
                r.rolsuper AS superuser FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
      assert.equal(identity.rows[0]?.principal, roleConfig[index]![1]);
      assert.equal(identity.rows[0]?.session, roleConfig[index]![1]);
      assert.equal(identity.rows[0]?.schema, 'model_router_saas');
      assert.equal(identity.rows[0]?.superuser, false);
    }
    await migrator.verifySchema();
    const history = await migrator.query<{ version: number }>('SELECT version FROM saas_schema_migrations ORDER BY version');
    assert.deepEqual(history.rows.filter(({ version }) => version <= 52).map(({ version }) => version),
      Array.from({ length: 52 }, (_, index) => index + 1), 'FIN-01 requires the complete registered schema through 052');
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');

    await t.test('two concurrent 70-unit reserves cannot double-use a 100-unit wallet', async () => {
      const fixture = await seedFixture(migrator);
      await concurrentReserves(gateway, service, [reserveInput(fixture, 'a'), reserveInput(fixture, 'b')]);
      assert.deepEqual(await snapshot(migrator, fixture), {
        posted: '100', wallet_ledger: '100', holds: '70', refund_freezes: '0', reservations: '1',
        transactions: '1', entries: '2', settlements: '0', unbalanced: '0',
      });
      const wallet = await transaction(gateway, (tx) => service.getWallet(tx, fixture.tenantId, 'USD'));
      assert.equal(wallet.availableMinorUnits, 30n);
    });

    await t.test('an unresolved 40-unit refund freeze fences concurrent 40-unit reserves', async () => {
      const fixture = await seedFixture(migrator, true);
      await concurrentReserves(gateway, service, [reserveInput(fixture, 'a', '40'), reserveInput(fixture, 'b', '40')]);
      assert.deepEqual(await snapshot(migrator, fixture), {
        posted: '100', wallet_ledger: '100', holds: '40', refund_freezes: '40', reservations: '1',
        transactions: '1', entries: '2', settlements: '0', unbalanced: '0',
      });
      const wallet = await transaction(gateway, (tx) => service.getWallet(tx, fixture.tenantId, 'USD'));
      assert.equal(wallet.activeRefundFreezesMinorUnits, 40n);
      assert.equal(wallet.availableMinorUnits, 20n);
    });

    await t.test('reserve and settlement replay preserve the snapshot and post only one settlement pair', async () => {
      const fixture = await seedFixture(migrator);
      const input = reserveInput(fixture, 'replay');
      const reserved = await transaction(gateway, (tx) => service.reserve(tx, input));
      const replay = await transaction(gateway, (tx) => service.reserve(tx, input));
      assert.equal(replay.id, reserved.id);
      const before = await snapshot(migrator, fixture);
      assert.equal(before.reservations, '1');
      await assert.rejects(transaction(gateway, (tx) => service.reserve(tx,
        { ...input, priceSnapshotRef: `${input.priceSnapshotRef}:v2` })), billingCode('IDEMPOTENCY_CONFLICT'));
      const settlement = settleInput(input);
      await assert.rejects(transaction(gateway, (tx) => service.settle(tx,
        { ...settlement, priceSnapshotRef: `${input.priceSnapshotRef}:v2` })), billingCode('IDEMPOTENCY_CONFLICT'));
      assert.deepEqual(await snapshot(migrator, fixture), before);
      const settled = await transaction(gateway, (tx) => service.settle(tx, settlement));
      const repeated = await transaction(gateway, (tx) => service.settle(tx, settlement));
      assert.equal(settled.state, 'settled');
      assert.equal(repeated.ledgerTransactionId, settled.ledgerTransactionId);
      assert.equal(repeated.id, reserved.id);
      await assert.rejects(transaction(gateway, (tx) => service.settle(tx,
        { ...settlement, amountMinorUnits: '31' })), billingCode('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(transaction(gateway, (tx) => service.settle(tx,
        { ...settlement, usageEvidenceRef: `${settlement.usageEvidenceRef}:changed` })), billingCode('IDEMPOTENCY_CONFLICT'));
      const terminalReserveReplay = await transaction(gateway, (tx) => service.reserve(tx, input));
      assert.equal(terminalReserveReplay.state, 'settled');
      assert.equal(terminalReserveReplay.ledgerTransactionId, settled.ledgerTransactionId);
      assert.deepEqual(await snapshot(migrator, fixture), {
        posted: '70', wallet_ledger: '70', holds: '0', refund_freezes: '0', reservations: '1',
        transactions: '2', entries: '4', settlements: '1', unbalanced: '0',
      });
      const pair = await migrator.query<{ direction: string; account_type: string; amount: string; price: string; usage: string }>(
        `SELECT e.direction, e.account_type, e.amount_minor_units::text AS amount,
                l.price_snapshot_ref AS price, l.usage_evidence_ref AS usage
           FROM saas_ledger_transactions l JOIN saas_ledger_entries e ON e.transaction_id = l.id
          WHERE l.id = $1 AND l.tenant_id = $2 ORDER BY e.direction`, [settled.ledgerTransactionId, fixture.tenantId]);
      assert.deepEqual(pair.rows, [
        { direction: 'credit', account_type: 'billing_revenue', amount: '30', price: input.priceSnapshotRef, usage: settlement.usageEvidenceRef },
        { direction: 'debit', account_type: 'wallet', amount: '30', price: input.priceSnapshotRef, usage: settlement.usageEvidenceRef },
      ]);
      const row = await migrator.query<{ state: string; price: string; amount: string }>(
        `SELECT state, price_snapshot_ref AS price, settlement_amount_minor_units::text AS amount
         FROM saas_billing_reservations WHERE id = $1 AND tenant_id = $2`, [reserved.id, fixture.tenantId]);
      assert.deepEqual(row.rows, [{ state: 'settled', price: input.priceSnapshotRef, amount: '30' }]);
    });

    await t.test('caller rollback after ledger posting restores the wallet, hold and ledger atomically', async () => {
      const fixture = await seedFixture(migrator);
      const input = reserveInput(fixture, 'rollback');
      const reserved = await transaction(gateway, (tx) => service.reserve(tx, input));
      const before = await snapshot(migrator, fixture);
      const abort = new Error('FIN-01 intentional caller rollback');
      await assert.rejects(transaction(gateway, async (tx) => {
        const entryInserts: { rowCount: number | null; values: readonly unknown[] }[] = [];
        // The gateway has no ledger-entry SELECT privilege. Delegate every
        // service query unchanged to this real transaction, returning the real
        // driver result; observe only acknowledged entry INSERTs, never reads.
        const observedTx: SqlExecutor = {
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const result = await tx.query<Row>(sql, values);
            if (/^\s*INSERT INTO saas_ledger_entries\b/i.test(sql)) {
              assert.match(sql, /\(id,\s*transaction_id,\s*tenant_id,\s*currency,\s*direction,\s*amount_minor_units,\s*account_type,\s*account_ref,\s*wallet_id,\s*created_at\)/);
              assert.ok(values);
              assert.equal(values.length, 10);
              entryInserts.push({ rowCount: result.rowCount, values: [...values] });
            }
            return result;
          },
        };
        const settled = await service.settle(observedTx, settleInput(input));
        assert.equal(settled.state, 'settled');
        assert.equal(settled.walletPostedBalanceMinorUnits, 70n);
        assert.ok(typeof settled.ledgerTransactionId === 'string');
        assert.equal(entryInserts.length, 2, 'rollback must occur after both real entry INSERTs were acknowledged');
        assert.deepEqual(entryInserts.map(({ rowCount, values }) => ({
          rowCount, transactionId: values[1], tenantId: values[2], currency: values[3], direction: values[4],
          amount: values[5], accountType: values[6], accountRef: values[7], walletId: values[8],
        })), [
          { rowCount: 1, transactionId: settled.ledgerTransactionId, tenantId: fixture.tenantId, currency: 'USD',
            direction: 'debit', amount: '30', accountType: 'wallet', accountRef: fixture.walletId, walletId: fixture.walletId },
          { rowCount: 1, transactionId: settled.ledgerTransactionId, tenantId: fixture.tenantId, currency: 'USD',
            direction: 'credit', amount: '30', accountType: 'billing_revenue', accountRef: 'platform-revenue:USD', walletId: null },
        ]);
        throw abort;
      }), (error: unknown) => error === abort);
      assert.deepEqual(await snapshot(migrator, fixture), before);
      const row = await migrator.query<{ state: string; ledger_transaction_id: string | null; settlement_id: string | null }>(
        `SELECT state, ledger_transaction_id, settlement_id FROM saas_billing_reservations
         WHERE id = $1 AND tenant_id = $2`, [reserved.id, fixture.tenantId]);
      assert.deepEqual(row.rows, [{ state: 'reserved', ledger_transaction_id: null, settlement_id: null }]);
      // Retrying the rolled-back settlement must now commit exactly one pair.
      await transaction(gateway, (tx) => service.settle(tx, settleInput(input)));
      assert.deepEqual(await snapshot(migrator, fixture), {
        posted: '70', wallet_ledger: '70', holds: '0', refund_freezes: '0', reservations: '1',
        transactions: '2', entries: '4', settlements: '1', unbalanced: '0',
      });
    });

    await t.test('unknown outcome retains an expired hold and rejects TTL-only release', async () => {
      const fixture = await seedFixture(migrator);
      // Advance the service clock beyond a real persisted expiry; no sleeps or
      // mutation of the immutable reservation are needed to exercise TTL.
      let now = new Date(Date.now() - 120_000);
      const timedService = new PlatformWalletLedgerService({ now: () => now });
      const input = reserveInput(fixture, 'unknown', '70', now);
      const reserved = await transaction(gateway, (tx) => timedService.reserve(tx, input));
      const pendingInput = {
        supplyMode: 'platform' as const, tenantId: input.tenantId, requestId: input.requestId,
        businessKey: input.businessKey, evidenceRef: `upstream-unknown:${input.requestId}`,
      };
      await transaction(gateway, (tx) => timedService.markReconciliationPending(tx, pendingInput));
      now = new Date(Date.now() + 120_000);
      const repeated = await transaction(gateway, (tx) => timedService.markReconciliationPending(tx, pendingInput));
      assert.equal(repeated.id, reserved.id);
      assert.equal(repeated.state, 'reconciliation_pending');
      const before = await snapshot(migrator, fixture);
      assert.deepEqual(before, {
        posted: '100', wallet_ledger: '100', holds: '70', refund_freezes: '0', reservations: '1',
        transactions: '1', entries: '2', settlements: '0', unbalanced: '0',
      });
      await assert.rejects(transaction(gateway, (tx) => timedService.release(tx, {
        supplyMode: 'platform', tenantId: input.tenantId, requestId: input.requestId, businessKey: input.businessKey,
        releaseId: `ttl:${input.requestId}`, releaseEvidenceRef: `ttl-expired:${input.requestId}`,
      })), billingCode('RECONCILIATION_REQUIRED'));
      const unresolved = await transaction(gateway, (tx) => timedService.settle(tx, settleInput(input)));
      assert.equal(unresolved.state, 'reconciliation_pending', 'usage without reconciliation evidence cannot settle an unknown result');
      await assert.rejects(transaction(gateway, (tx) => timedService.reserve(tx,
        reserveInput(fixture, 'new', '40', now))), billingCode('INSUFFICIENT_FUNDS'));
      assert.deepEqual(await snapshot(migrator, fixture), before);
      const wallet = await transaction(gateway, (tx) => timedService.getWallet(tx, fixture.tenantId, 'USD'));
      assert.equal(wallet.activeHoldsMinorUnits, 70n);
      assert.equal(wallet.availableMinorUnits, 30n);
      const row = await migrator.query<{
        state: string; expired: boolean; release_id: string | null; ledger_transaction_id: string | null;
        price_snapshot_ref: string; reconciliation_reference: string;
      }>(
        `SELECT state, expires_at < clock_timestamp() AS expired, release_id, ledger_transaction_id,
                price_snapshot_ref, reconciliation_reference
         FROM saas_billing_reservations WHERE id = $1 AND tenant_id = $2`, [reserved.id, fixture.tenantId]);
      assert.deepEqual(row.rows, [{
        state: 'reconciliation_pending', expired: true, release_id: null, ledger_transaction_id: null,
        price_snapshot_ref: input.priceSnapshotRef, reconciliation_reference: pendingInput.evidenceRef,
      }]);
    });
  } finally {
    // Ledger/reservation/refund retention triggers intentionally preclude row
    // cleanup. Unique tenants stay in the disposable database until its owner
    // tears it down; this suite never drops schemas, disables guards or alters ACLs.
    await Promise.all([gateway.close(), controlPlane.close(), migrator.close()]);
  }
});
