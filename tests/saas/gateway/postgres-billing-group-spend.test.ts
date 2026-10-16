import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasBillingGroupsError } from '../../../src/saas/billing/groups/errors.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  BillingGroupSpendAdmissionDeniedError,
  createPostgresBillingGroupSpendAdmission,
  evaluateBillingGroupSpendWindow,
} from '../../../src/saas/gateway/postgres-billing-group-spend.js';

class FakeExecutor implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  /** The frozen snapshot row; null = no row. */
  snapshot: Record<string, unknown> | null = null;
  /** Post-upsert counter values per window kind. */
  counters: Record<string, { settled: string; outstanding: string; currency: string | null }> = {};

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values });
    const normalized = sql.trim().toLowerCase();
    if (normalized.includes('from saas_request_customer_price_snapshots')) {
      const rows = this.snapshot ? [{ ...this.snapshot }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (normalized.includes('insert into saas_billing_group_spend_counters')) {
      const kind = String(values[1]);
      const counter = this.counters[kind] ?? { settled: '0', outstanding: '0', currency: null };
      return {
        rows: [
          {
            charge_settled: counter.settled,
            charge_outstanding_reserved: counter.outstanding,
            charge_currency: counter.currency,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (normalized.includes('insert into saas_billing_group_spend_reservations')) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    throw new Error(`unexpected spend SQL: ${sql}`);
  }
}

const platformFacts = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  requestId: '22222222-2222-2222-2222-222222222222',
  supplyMode: 'platform' as const,
  charge: { currency: 'USD', amountMinorUnits: '100' },
};

const now = () => new Date('2026-10-17T12:00:00.000Z');

test('group spend admission reserves every configured window and denies on the exceeded one', async () => {
  const executor = new FakeExecutor();
  executor.snapshot = {
    billing_group_id: 'vip',
    group_daily_limit_minor_units: '1000',
    group_weekly_limit_minor_units: '5000',
    group_monthly_limit_minor_units: null,
  };
  // The daily window already carries settled 500 + outstanding 600 (including
  // this reservation's 100); projected 1100 > 1000 denies on daily.
  executor.counters = {
    daily: { settled: '500', outstanding: '600', currency: 'USD' },
    weekly: { settled: '1000', outstanding: '300', currency: 'USD' },
  };
  const port = createPostgresBillingGroupSpendAdmission({ now });

  await assert.rejects(
    port.reserve(executor, platformFacts),
    (error: unknown) => error instanceof BillingGroupSpendAdmissionDeniedError && error.deniedWindow === 'daily',
  );
  // Exactly the two configured windows were upserted (monthly is unlimited).
  const counterStatements = executor.statements.filter(({ sql }) =>
    sql.includes('INSERT INTO saas_billing_group_spend_counters'),
  );
  assert.equal(counterStatements.length, 2);
  assert.ok(counterStatements.some(({ values }) => values[1] === 'daily'));
  assert.ok(counterStatements.some(({ values }) => values[1] === 'weekly'));
});

test('group spend admission allows when every window stays within its ceiling', async () => {
  const executor = new FakeExecutor();
  executor.snapshot = {
    billing_group_id: 'vip',
    group_daily_limit_minor_units: '1000',
    group_weekly_limit_minor_units: null,
    group_monthly_limit_minor_units: null,
  };
  // Settled 500 + outstanding 400 (including this reservation's 100) = 900,
  // inside the 1000 ceiling.
  executor.counters = { daily: { settled: '500', outstanding: '400', currency: 'USD' } };
  const port = createPostgresBillingGroupSpendAdmission({ now });

  await port.reserve(executor, platformFacts);
  assert.equal(executor.statements.length, 3, 'the snapshot read plus one counter upsert plus one reservation row');
});

test('a group without frozen spend ceilings performs no write', async () => {
  const executor = new FakeExecutor();
  executor.snapshot = {
    billing_group_id: 'default',
    group_daily_limit_minor_units: null,
    group_weekly_limit_minor_units: null,
    group_monthly_limit_minor_units: null,
  };
  const port = createPostgresBillingGroupSpendAdmission({ now });

  await port.reserve(executor, platformFacts);
  assert.equal(executor.statements.length, 1, 'only the snapshot terms read');
});

test('a platform admission without its snapshot fails closed', async () => {
  const executor = new FakeExecutor();
  executor.snapshot = null;
  const port = createPostgresBillingGroupSpendAdmission({ now });

  await assert.rejects(port.reserve(executor, platformFacts), SaasBillingGroupsError);
});

test('BYOK is a no-op without a charge and fails closed with one', async () => {
  const executor = new FakeExecutor();
  const port = createPostgresBillingGroupSpendAdmission({ now });

  await port.reserve(executor, {
    ...platformFacts,
    supplyMode: 'byok',
    charge: null,
  });
  assert.equal(executor.statements.length, 0);

  await assert.rejects(port.reserve(executor, { ...platformFacts, supplyMode: 'byok' }), SaasBillingGroupsError);
});

test('the pure window evaluation treats the ceiling as inclusive', () => {
  const at = (settled: string, outstanding: string) =>
    evaluateBillingGroupSpendWindow({
      kind: 'daily',
      windowStart: '2026-10-17',
      settled,
      outstandingReserved: outstanding,
      limitMinorUnits: '1000',
    });
  assert.deepEqual(at('500', '500'), { allowed: true, projectedTotal: 1000n, cap: 1000n });
  assert.deepEqual(at('500', '501'), { allowed: false, projectedTotal: 1001n, cap: 1000n });
  // A zero ceiling is finite: the first reservation (outstanding 1) denies.
  const zero = evaluateBillingGroupSpendWindow({
    kind: 'daily',
    windowStart: '2026-10-17',
    settled: '0',
    outstandingReserved: '1',
    limitMinorUnits: '0',
  });
  assert.equal(zero.allowed, false);
});
