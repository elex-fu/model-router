import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  PostgresCnProvidersQuotaStore,
} from '../../../src/saas/supply/cn-providers-quota-store-postgres.js';
import type { CnQuotaAccountRef } from '../../../src/saas/supply/cn-providers-quota-worker.js';
import {
  createPostgresCnProvidersAccountConfigStore,
} from '../../../src/saas/platform/cn-providers/account-config-store.js';

type Row = Record<string, unknown>;

const ZHIPU_ACCOUNT: CnQuotaAccountRef = Object.freeze({
  ownerKind: 'platform',
  tenantId: null,
  accountId: 'account-zhipu',
  providerId: 'zhipu',
});
const MINIMAX_ACCOUNT: CnQuotaAccountRef = Object.freeze({
  ownerKind: 'tenant',
  tenantId: 'tenant-1',
  accountId: 'account-minimax',
  providerId: 'minimax',
});

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly updates: Array<{ sql: string; values: readonly unknown[] }>;
  claimRows: Row[];
  configRows: Row[];
}

class FakeDatabase implements SaasDatabase {
  constructor(readonly state: FakeState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    let rows: Row[] = [];
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        // Claim statements only run against their own owner-scope table and
        // their own provider (values[0] carries the provider id).
        rows = this.state.claimRows.filter(
          (row) =>
            row.provider_id === values[0] &&
            !(
              (sql.includes('saas_tenant_provider_accounts') && row.owner === 'platform') ||
              (sql.includes('saas_platform_provider_accounts') && row.owner === 'tenant')
            ),
        );
      } else if (sql.includes('RETURNING authz_version')) {
        rows = this.state.configRows;
      }
    } else if (sql.startsWith('SELECT authz_version')) {
      rows = this.state.configRows;
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 120)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return { statements: [], updates: [], claimRows: [], configRows: [], ...overrides };
}

const UNSEALING_KMS = { decryptDataKey: async () => Buffer.alloc(32, 0x5b) } as never;

function quotaStore(database: SaasDatabase): PostgresCnProvidersQuotaStore {
  return new PostgresCnProvidersQuotaStore(database, UNSEALING_KMS, {
    deployment: 'cn-quota-store-test',
    environment: 'test',
  });
}

test('readDueAccounts claims due coding accounts per provider with the SKIP LOCKED lease', async () => {
  const state = fakeState({
    claimRows: [
      { owner: 'tenant', tenant_id: 'tenant-1', id: 'account-minimax', provider_id: 'minimax' },
      { owner: 'platform', id: 'account-zhipu', provider_id: 'zhipu' },
    ],
  });
  const refs = await quotaStore(new FakeDatabase(state)).readDueAccounts({
    nowMs: 1_000_000,
    debounceMs: 60_000,
    intervalMs: 900_000,
    limit: 5,
  });
  // The claim loop scans tenant scope first, then platform.
  assert.deepEqual(refs, [MINIMAX_ACCOUNT, ZHIPU_ACCOUNT]);
  // One claim statement per (owner scope × provider).
  assert.equal(state.updates.length, 4);
  for (const claim of state.updates) {
    assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claim.sql, /claim\.credential_type = 'api-key'/);
    assert.match(claim.sql, /claim\.provider_id = \$1/);
    // The per-provider column family is selected by the whitelisted prefix —
    // zhipu and minimax claims each carry their own columns.
    if (claim.values[0] === 'zhipu') {
      assert.match(claim.sql, /claim\.zhipu_account_mode = 'coding'/);
      assert.match(claim.sql, /SET zhipu_usage_updated_at = \$2::timestamptz/);
      assert.doesNotMatch(claim.sql, /minimax_/);
    } else {
      assert.equal(claim.values[0], 'minimax');
      assert.match(claim.sql, /claim\.minimax_account_mode = 'coding'/);
      assert.match(claim.sql, /SET minimax_usage_updated_at = \$2::timestamptz/);
      assert.doesNotMatch(claim.sql, /zhipu_/);
    }
  }
});

test('writeQuotaSnapshot/writeQuotaFailure/markRateLimited target the per-provider columns', async () => {
  const state = fakeState();
  const store = quotaStore(new FakeDatabase(state));
  await store.writeQuotaSnapshot(ZHIPU_ACCOUNT, {
    fiveHour: { window: '5h', usedPercent: 42, resetAt: '2026-10-17T12:00:00.000Z' },
    weekly: { window: 'weekly', usedPercent: 71, resetAt: '2026-10-20T00:00:00.000Z' },
    fetchedAtMs: 1_000_000,
    nextDueAtMs: 1_900_000,
  });
  await store.writeQuotaFailure(MINIMAX_ACCOUNT, {
    attemptedAtMs: 1_000_000,
    errorCode: 'provider_rate_limited',
    httpStatus: 429,
    retryAfterMs: 30_000,
    nextDueAtMs: 1_900_000,
    failureCount: 1,
  });
  await store.markRateLimited(MINIMAX_ACCOUNT, 1_030_000);

  assert.equal(state.updates.length, 3);
  const snapshot = state.updates[0]?.sql ?? '';
  assert.match(snapshot, /SET zhipu_5h_used_percent = \$2,/);
  assert.match(snapshot, /zhipu_weekly_used_percent = \$4,/);
  assert.match(snapshot, /zhipu_usage_failure_count = 0/);
  assert.match(snapshot, /zhipu_rate_limited_until = NULL/);
  assert.doesNotMatch(snapshot, /minimax_/);

  const failure = state.updates[1]?.sql ?? '';
  assert.match(failure, /SET minimax_usage_updated_at = \$3,/);
  assert.match(failure, /minimax_usage_failure_count = \$5,/);
  assert.doesNotMatch(failure, /zhipu_/);

  const rateLimited = state.updates[2]?.sql ?? '';
  assert.match(rateLimited, /SET minimax_rate_limited_until = \$3/);
});

test('an unknown provider id fails closed at the store boundary', async () => {
  const store = quotaStore(new FakeDatabase(fakeState()));
  await assert.rejects(
    store.markRateLimited({ ...ZHIPU_ACCOUNT, providerId: 'someone-else' }, 1),
    /CN provider quota store is unavailable/,
  );
});

test('the account-config store reads and CAS-updates the dual-mode columns', async () => {
  const state = fakeState({
    configRows: [{ authz_version: 7, account_mode: 'coding', api_protocol: 'adaptive' }],
  });
  const database = new FakeDatabase(state);
  const store = createPostgresCnProvidersAccountConfigStore(database);

  const read = await store.read(
    { ownerKind: 'tenant', tenantId: 'tenant-1', accountId: 'account-zhipu' },
    'zhipu',
  );
  assert.deepEqual(read, { authzVersion: 7, accountMode: 'coding', apiProtocol: 'adaptive' });
  assert.match(state.statements[0]?.sql ?? '', /SELECT authz_version,\s+zhipu_account_mode AS account_mode,\s+zhipu_api_protocol AS api_protocol/);

  const updated = await store.update(
    { ownerKind: 'tenant', tenantId: 'tenant-1', accountId: 'account-zhipu' },
    'zhipu',
    { accountMode: 'payg', apiProtocol: 'anthropic', expectedAuthzVersion: 7 },
  );
  assert.deepEqual(updated, { authzVersion: 7, accountMode: 'coding', apiProtocol: 'adaptive' });
  const updateSql = state.updates[0]?.sql ?? '';
  assert.match(updateSql, /SET zhipu_account_mode = \$3,/);
  assert.match(updateSql, /zhipu_api_protocol = \$4,/);
  assert.match(updateSql, /authz_version = authz_version \+ 1/);
  assert.match(updateSql, /AND authz_version = \$5/);

  // The minimax family uses its own columns; unknown providers fail closed.
  await store.read({ ownerKind: 'platform', tenantId: null, accountId: 'a' }, 'minimax');
  // statements: [0] zhipu read SELECT, [1] zhipu CAS UPDATE, [2] minimax read.
  assert.match(state.statements[2]?.sql ?? '', /minimax_account_mode AS account_mode/);
  await assert.rejects(
    store.read({ ownerKind: 'platform', tenantId: null, accountId: 'a' }, 'bedrock'),
    /CN provider account config store is unavailable/,
  );
  // Invalid enum values fail closed before any SQL runs.
  await assert.rejects(
    store.update(
      { ownerKind: 'platform', tenantId: null, accountId: 'a' },
      'zhipu',
      { accountMode: 'oops' as 'payg', apiProtocol: null, expectedAuthzVersion: 1 },
    ),
    /CN provider account config store is unavailable/,
  );
});
