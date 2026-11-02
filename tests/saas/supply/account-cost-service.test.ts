import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_ACCOUNT_COST_SAAS_MIGRATION } from '../../../src/saas/db/migrations/151_provider_account_cost.js';
import {
  type AccountUsageAggregate,
  type AccountUsageAggregationQuery,
  type CreateProviderAccountCostInput,
  type ProviderAccountCost,
  ProviderAccountCostService,
  type ProviderAccountCostStore,
  type ProviderAccountOperationalState,
  type ReplaceEffectiveCostWrite,
} from '../../../src/saas/supply/account-cost-service.js';

type MutableProviderAccountCost = {
  -readonly [Key in keyof ProviderAccountCost]: ProviderAccountCost[Key];
};

class FakeAccountCostStore implements ProviderAccountCostStore {
  readonly rows: MutableProviderAccountCost[] = [];

  async create(cost: ProviderAccountCost): Promise<void> {
    assert.equal(
      this.rows.some((row) => row.id === cost.id),
      false,
    );
    this.rows.push({ ...cost });
  }

  async getById(id: string): Promise<ProviderAccountCost | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listByAccount(accountId: string): Promise<readonly ProviderAccountCost[]> {
    return this.rows.filter((row) => row.accountId === accountId);
  }

  async listForReport(input: {
    readonly asOf: string;
    readonly currency: string;
  }): Promise<readonly ProviderAccountCost[]> {
    const asOfMs = Date.parse(input.asOf);
    return this.rows.filter((row) => row.currency === input.currency && Date.parse(row.effectiveFrom) < asOfMs);
  }

  async findEffective(accountId: string, at: string): Promise<ProviderAccountCost | null> {
    const atMs = Date.parse(at);
    return (
      this.rows.find(
        (row) =>
          row.accountId === accountId &&
          Date.parse(row.effectiveFrom) <= atMs &&
          (row.effectiveTo === null || Date.parse(row.effectiveTo) > atMs),
      ) ?? null
    );
  }

  async replaceEffective(write: ReplaceEffectiveCostWrite): Promise<void> {
    const previous = this.rows.find((row) => row.id === write.previousCostId);
    assert.ok(previous);
    previous.effectiveTo = write.previousEffectiveTo;
    previous.updatedAt = write.previousUpdatedAt;
    await this.create(write.replacement);
  }
}

class FakeUsageAggregator {
  readonly calls: AccountUsageAggregationQuery[] = [];
  readonly values = new Map<string, AccountUsageAggregate>();

  async aggregateAccountUsage(query: AccountUsageAggregationQuery): Promise<AccountUsageAggregate> {
    this.calls.push(query);
    return this.values.get(query.accountId) ?? { tokens: 0n, requests: 0n, settledAmountMinorUnits: 0n };
  }
}

class FakeAccountStateLookup {
  readonly values = new Map<string, ProviderAccountOperationalState>();

  async getProviderAccountState(accountId: string): Promise<ProviderAccountOperationalState | null> {
    return this.values.get(accountId) ?? { status: 'active', bannedAt: null };
  }
}

function fixture() {
  const store = new FakeAccountCostStore();
  const usageAggregator = new FakeUsageAggregator();
  const accountStateLookup = new FakeAccountStateLookup();
  let nextId = 1;
  const service = new ProviderAccountCostService({
    store,
    usageAggregator,
    accountStateLookup,
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    idFactory: () => `cost-${nextId++}`,
  });
  return { service, store, usageAggregator, accountStateLookup };
}

function costInput(accountId = 'account-a'): CreateProviderAccountCostInput {
  return {
    accountId,
    priceMinorUnits: 3100n,
    currency: 'CNY',
    period: 'month',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    sourceNote: 'synthetic test fixture',
  };
}

test('migration 151 defines an operational minor-unit cost ledger and prevents overlaps', () => {
  const migration = PROVIDER_ACCOUNT_COST_SAAS_MIGRATION;
  assert.equal(migration.version, 151);
  assert.equal(migration.name, 'provider_account_cost');
  assert.match(migration.sql, /CREATE TABLE provider_account_cost \(/);
  assert.match(migration.sql, /account_id text NOT NULL/);
  assert.match(migration.sql, /price_minor_units bigint NOT NULL CHECK \(price_minor_units > 0\)/);
  assert.match(migration.sql, /period IN \('month', 'quarter', 'year'\)/);
  assert.match(migration.sql, /effective_from timestamptz NOT NULL/);
  assert.match(migration.sql, /effective_to timestamptz/);
  assert.match(migration.sql, /source_note text/);
  assert.match(migration.sql, /CREATE UNIQUE INDEX provider_account_cost_one_current_idx/);
  assert.match(migration.sql, /WHERE effective_to IS NULL/);
  assert.match(migration.sql, /CREATE TRIGGER provider_account_cost_no_overlap/);
  assert.match(migration.sql, /pg_advisory_xact_lock/);
  assert.match(migration.sql, /CREATE INDEX provider_account_cost_report_idx/);
  assert.doesNotMatch(migration.sql, /SAAS_MIGRATIONS/);
});

test('COGS amortizes by actual calendar days and computes integer cost per million tokens', async () => {
  const { service, usageAggregator } = fixture();
  await service.createCost(costInput());
  usageAggregator.values.set('account-a', { tokens: 2_000_000n, requests: 7n, settledAmountMinorUnits: 4200n });

  const report = await service.createCogsReport({ asOf: '2026-01-16T00:00:00.000Z', currency: 'CNY' });
  assert.equal(report.accounts.length, 1);
  const row = report.accounts[0];
  assert.ok(row);
  assert.equal(row.costMinorUnits, 3100n);
  assert.equal(row.aliveDays, 15);
  assert.equal(row.amortizedCostMinorUnits, 1500n);
  assert.equal(row.sunkCostMinorUnits, 0n);
  assert.equal(row.tokens, 2_000_000n);
  assert.equal(row.requests, 7n);
  assert.equal(row.settledAmountMinorUnits, 4200n);
  assert.equal(row.costPerMillionTokensMinorUnits, 750n);
  assert.equal(report.pool.costPerMillionTokensMinorUnits, 750n);
  assert.deepEqual(usageAggregator.calls[0], {
    accountId: 'account-a',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-16T00:00:00.000Z',
    currency: 'CNY',
  });
});

test('a banned account stops amortizing at bannedAt and carries the remainder as sunk cost', async () => {
  const { service, usageAggregator, accountStateLookup } = fixture();
  await service.createCost(costInput());
  accountStateLookup.values.set('account-a', { status: 'banned', bannedAt: '2026-01-11T00:00:00.000Z' });
  usageAggregator.values.set('account-a', { tokens: 1_000_000n, requests: 3n, settledAmountMinorUnits: 900n });

  const report = await service.createCogsReport({ asOf: '2026-02-01T00:00:00.000Z', currency: 'CNY' });
  const row = report.accounts[0];
  assert.ok(row);
  assert.equal(row.aliveDays, 10);
  assert.equal(row.amortizedCostMinorUnits, 1000n);
  assert.equal(row.sunkCostMinorUnits, 2100n);
  assert.equal(row.amortizedCostMinorUnits + row.sunkCostMinorUnits, row.costMinorUnits);
  assert.equal(row.costPerMillionTokensMinorUnits, 1000n);
  assert.equal(usageAggregator.calls[0]?.to, '2026-01-11T00:00:00.000Z');

  const beforeBan = await service.createCogsReport({ asOf: '2026-01-05T00:00:00.000Z', currency: 'CNY' });
  assert.equal(beforeBan.accounts[0]?.amortizedCostMinorUnits, 400n);
  assert.equal(beforeBan.accounts[0]?.sunkCostMinorUnits, 0n);
  assert.equal(usageAggregator.calls[1]?.to, '2026-01-05T00:00:00.000Z');
});

test('zero token output produces a null per-million cost instead of dividing by zero', async () => {
  const { service } = fixture();
  await service.createCost(costInput());

  const report = await service.createCogsReport({ asOf: '2026-01-11T00:00:00.000Z', currency: 'CNY' });
  const row = report.accounts[0];
  assert.ok(row);
  assert.equal(row.tokens, 0n);
  assert.equal(row.costPerMillionTokensMinorUnits, null);
  assert.equal(report.pool.tokens, 0n);
  assert.equal(report.pool.costPerMillionTokensMinorUnits, null);
});

test('effective bounds truncate amortization and the usage interval, and future costs are excluded', async () => {
  const { service, usageAggregator } = fixture();
  await service.createCost({
    ...costInput(),
    effectiveFrom: '2026-01-10T00:00:00.000Z',
    effectiveTo: '2026-01-20T00:00:00.000Z',
  });
  usageAggregator.values.set('account-a', { tokens: 500_000n, requests: 1n, settledAmountMinorUnits: 200n });

  const report = await service.createCogsReport({ asOf: '2026-02-01T00:00:00.000Z', currency: 'CNY' });
  const row = report.accounts[0];
  assert.ok(row);
  assert.equal(row.aliveDays, 10);
  assert.equal(row.amortizedCostMinorUnits, 1000n);
  assert.equal(row.costPerMillionTokensMinorUnits, 2000n);
  assert.equal(usageAggregator.calls[0]?.from, '2026-01-10T00:00:00.000Z');
  assert.equal(usageAggregator.calls[0]?.to, '2026-01-20T00:00:00.000Z');

  const future = await service.createCogsReport({ asOf: '2026-01-05T00:00:00.000Z', currency: 'CNY' });
  assert.deepEqual(future.accounts, []);
  assert.equal(future.pool.costMinorUnits, 0n);
  assert.equal(usageAggregator.calls.length, 1);
});

test('replacing an effective cost closes its interval and report reads the full cost history', async () => {
  const { service, usageAggregator } = fixture();
  const original = await service.createCost(costInput());
  const replaced = await service.replaceEffectiveCost({
    ...costInput(),
    priceMinorUnits: 6200n,
    effectiveFrom: '2026-01-11T00:00:00.000Z',
  });
  assert.equal(replaced.previous.id, original.id);
  assert.equal(replaced.previous.effectiveTo, '2026-01-11T00:00:00.000Z');
  assert.equal((await service.getCost(original.id))?.effectiveTo, '2026-01-11T00:00:00.000Z');
  assert.equal((await service.listAccountCosts('account-a')).length, 2);
  usageAggregator.values.set('account-a', { tokens: 3_000_000n, requests: 4n, settledAmountMinorUnits: 800n });

  const report = await service.createCogsReport({ asOf: '2026-01-21T00:00:00.000Z', currency: 'CNY' });
  const row = report.accounts[0];
  assert.ok(row);
  assert.equal(row.costMinorUnits, 9300n);
  assert.equal(row.aliveDays, 20);
  assert.equal(row.amortizedCostMinorUnits, 3000n);
  assert.equal(row.costPerMillionTokensMinorUnits, 1000n);
});

test('pool totals sum accounts and derive per-million cost from total amortization and tokens', async () => {
  const { service, usageAggregator } = fixture();
  await service.createCost(costInput('account-a'));
  await service.createCost({ ...costInput('account-b'), priceMinorUnits: 6200n, period: 'quarter' });
  usageAggregator.values.set('account-a', { tokens: 1_000_000n, requests: 2n, settledAmountMinorUnits: 500n });
  usageAggregator.values.set('account-b', { tokens: 0n, requests: 0n, settledAmountMinorUnits: 0n });

  const report = await service.createCogsReport({ asOf: '2026-01-11T00:00:00.000Z', currency: 'CNY' });
  assert.equal(report.accounts.length, 2);
  assert.equal(report.accounts[1]?.costPerMillionTokensMinorUnits, null);
  assert.equal(report.pool.costMinorUnits, 9300n);
  assert.equal(report.pool.amortizedCostMinorUnits, 1688n);
  assert.equal(report.pool.sunkCostMinorUnits, 0n);
  assert.equal(report.pool.aliveDays, 20);
  assert.equal(report.pool.tokens, 1_000_000n);
  assert.equal(report.pool.requests, 2n);
  assert.equal(report.pool.settledAmountMinorUnits, 500n);
  assert.equal(report.pool.costPerMillionTokensMinorUnits, 1688n);
});
