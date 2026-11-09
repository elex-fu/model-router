import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { KeyBudgetUtcDay } from '../../../src/saas/keys/budget-policy-contract.js';
import { evaluatePostgresUserDailyBudget } from '../../../src/saas/risk/postgres-user-budget.js';

const day: KeyBudgetUtcDay = {
  timezone: 'UTC',
  startInclusive: '2026-11-02T00:00:00.000Z',
  endExclusive: '2026-11-03T00:00:00.000Z',
};
const reservation = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  keyId: 'key-1',
  requestId: 'request-1',
  supplyMode: 'platform' as const,
  day,
  tokenUnits: '10',
  chargeMinorUnits: '10',
  chargeCurrency: 'USD',
};

class BudgetFake implements SqlExecutor {
  authority: Record<string, unknown> = {
    principal_user_id: 'user-1',
    requests_per_minute: null,
    max_concurrent_requests: null,
    daily_token_units: '100',
    daily_charge_minor_units: '100',
    charge_currency: 'USD',
  };
  usage: Record<string, unknown> = {
    settled_tokens: '20',
    outstanding_tokens: '70',
    settled_charge: '20',
    outstanding_charge: '70',
    mixed_charge_currencies: false,
  };
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values });
    const rows = sql.includes('FROM saas_api_keys k')
      ? [this.authority]
      : sql.includes('FROM saas_api_key_budget_reservations r')
        ? [this.usage]
        : [{}];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

test('user daily admission aggregates every member key through the existing exact budget evaluator', async () => {
  const executor = new BudgetFake();
  assert.equal(await evaluatePostgresUserDailyBudget(executor, reservation), null);
  const aggregate = executor.statements.find(({ sql }) => sql.includes('FROM saas_api_key_budget_reservations r'));
  assert.ok(aggregate);
  assert.match(aggregate.sql, /k\.principal_user_id = \$1/);
  assert.deepEqual(aggregate.values, ['user-1', '2026-11-02', 'USD', 'request-1']);
  assert.equal(
    executor.statements.some(({ values }) => values[0] === 'model-router:user-daily-budget:user-1'),
    true,
  );
  assert.equal(
    executor.statements.some(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql)),
    false,
  );

  executor.authority.daily_token_units = '80';
  assert.equal(await evaluatePostgresUserDailyBudget(executor, reservation), 'daily_tokens');
  executor.authority.daily_token_units = '100';
  executor.authority.daily_charge_minor_units = '80';
  assert.equal(await evaluatePostgresUserDailyBudget(executor, reservation), 'daily_customer_charge');
});

test('project-service and unlimited member keys do not touch the user aggregate', async () => {
  const executor = new BudgetFake();
  executor.authority.principal_user_id = null;
  assert.equal(await evaluatePostgresUserDailyBudget(executor, reservation), null);
  assert.equal(executor.statements.length, 1);

  executor.authority = {
    ...executor.authority,
    principal_user_id: 'user-1',
    daily_token_units: null,
    daily_charge_minor_units: null,
    charge_currency: null,
  };
  assert.equal(await evaluatePostgresUserDailyBudget(executor, reservation), null);
  assert.equal(executor.statements.length, 2);
});

test('mixed stored charge currencies fail closed rather than merging units', async () => {
  const executor = new BudgetFake();
  executor.usage.mixed_charge_currencies = true;
  await assert.rejects(evaluatePostgresUserDailyBudget(executor, reservation));
});

test('the aggregate joins head keys by reservation lineage and excludes the in-flight request', async () => {
  // saas_api_keys carries no lineage_id column — a reservation's lineage_id
  // references the head key's id, so the join must be k.id = r.lineage_id. A
  // wrong join shape silently aggregates zero rows and the user ceiling
  // becomes a no-op; both join shapes are pinned here. The mixed-currency
  // guard must ignore the reservation this call just created ($4) and stay
  // inert for token-only policies where the currency bind is NULL.
  const executor = new BudgetFake();
  await evaluatePostgresUserDailyBudget(executor, reservation);
  const aggregate = executor.statements.find(({ sql }) => sql.includes('FROM saas_api_key_budget_reservations r'));
  assert.ok(aggregate);
  assert.match(
    aggregate.sql,
    /JOIN saas_api_keys k ON k\.tenant_id = r\.tenant_id\s+AND k\.project_id = r\.project_id AND k\.id = r\.lineage_id/,
  );
  assert.match(aggregate.sql, /other_key\.project_id = other\.project_id AND other_key\.id = other\.lineage_id/);
  assert.doesNotMatch(aggregate.sql, /k\.lineage_id/);
  assert.match(aggregate.sql, /other\.request_id <> \$4/);
  assert.match(aggregate.sql, /\$3::text IS NOT NULL/);
  assert.match(aggregate.sql, /other\.charge_currency IS DISTINCT FROM \$3/);
});
