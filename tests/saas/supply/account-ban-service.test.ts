import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_BAN_LEDGER_SAAS_MIGRATION } from '../../../src/saas/db/migrations/152_account_ban_ledger.js';
import type { SaasDatabase, SqlResult } from '../../../src/saas/db/types.js';
import {
  AccountBanDispositionService,
  PostgresAccountBanLedger,
  PostgresGatewayAccountBanCandidateSource,
  type ProviderAccountBanCommand,
  startAccountBanDispositionWorker,
} from '../../../src/saas/supply/account-ban-service.js';

function databaseWith(query: (sql: string, values: readonly unknown[]) => Promise<SqlResult<never>>): SaasDatabase {
  return { query } as unknown as SaasDatabase;
}

test('migration 152 extends existing account rows and health streaks without creating a ledger table', () => {
  assert.equal(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.version, 152);
  assert.equal(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.name, 'account_ban_ledger');
  assert.doesNotMatch(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.sql, /CREATE TABLE/i);
  assert.match(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.sql, /ADD COLUMN banned_at timestamptz/);
  assert.match(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.sql, /ADD COLUMN forbidden_failure_count integer NOT NULL DEFAULT 0/);
  assert.match(ACCOUNT_BAN_LEDGER_SAAS_MIGRATION.sql, /'gateway_overloaded_failure'/);
});

test('gateway ban candidates require a same-kind consecutive failure streak and an active platform account', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const database = databaseWith(async (sql, values) => {
    statements.push({ sql: sql.replace(/\s+/g, ' '), values });
    return {
      rows: [
        { id: 'account-1', authz_version: 4, last_outcome: 'gateway_forbidden_failure' },
        { id: 'account-2', authz_version: 7, last_outcome: 'gateway_verification_wall_failure' },
      ],
      rowCount: 2,
    } as SqlResult<never>;
  });
  const candidates = await new PostgresGatewayAccountBanCandidateSource(database).listGatewayAccountBanCandidates({
    failureThreshold: 3,
    limit: 20,
  });
  assert.deepEqual(candidates, [
    {
      accountId: 'account-1',
      authzVersion: 4,
      reason: 'persistent_forbidden',
      lastError: 'gateway_forbidden_failure',
    },
    {
      accountId: 'account-2',
      authzVersion: 7,
      reason: 'verification_wall',
      lastError: 'gateway_verification_wall_failure',
    },
  ]);
  assert.match(statements[0]?.sql ?? '', /health\.forbidden_failure_count >= \$1/);
  assert.match(statements[0]?.sql ?? '', /health\.verification_wall_failure_count >= \$1/);
  assert.match(statements[0]?.sql ?? '', /account\.status = 'active'/);
  assert.deepEqual(statements[0]?.values, [3, 20]);
});

test('the batched disposition preserves authz CAS and isolates one failed account', async () => {
  const calls: ProviderAccountBanCommand[] = [];
  const errors: unknown[] = [];
  const service = new AccountBanDispositionService(
    {
      async listGatewayAccountBanCandidates(input) {
        assert.deepEqual(input, { failureThreshold: 3, limit: 2 });
        return [
          {
            accountId: 'account-1',
            authzVersion: 4,
            reason: 'persistent_forbidden',
            lastError: 'gateway_forbidden_failure',
          },
          {
            accountId: 'account-2',
            authzVersion: 8,
            reason: 'verification_wall',
            lastError: 'gateway_verification_wall_failure',
          },
        ];
      },
    },
    {
      async banProviderAccount(input) {
        calls.push(input);
        if (input.account.accountId === 'account-1') throw new Error('stale account version');
        return null as never;
      },
    },
    { batchSize: 2, onError: (error) => errors.push(error) },
  );
  assert.deepEqual(await service.runGatewaySweep(), { candidates: 2, banned: 1, failed: 1 });
  assert.equal(calls[0]?.expectedAuthzVersion, 4);
  assert.equal(calls[1]?.expectedAuthzVersion, 8);
  assert.equal(calls[1]?.audit.actorUserId, 'account-ban-disposition-worker');
  assert.equal(errors.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /response|body|credential|secret/i);
});

test('the disposition worker waits before its first sweep and close waits for an in-flight sweep', async () => {
  let sweeps = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const enteredSweep = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new AccountBanDispositionService(
    {
      async listGatewayAccountBanCandidates() {
        sweeps += 1;
        entered?.();
        await inFlight;
        return [];
      },
    },
    {
      async banProviderAccount() {
        return null as never;
      },
    },
  );
  const worker = startAccountBanDispositionWorker(service, { pollIntervalMs: 5 });
  assert.equal(sweeps, 0);
  await enteredSweep;
  const closing = worker.close();
  const duplicateClose = worker.close();
  release?.();
  await Promise.all([closing, duplicateClose]);
  assert.equal(sweeps, 1);
});

test('closing the disposition worker before the first interval prevents a sweep', async () => {
  let sweeps = 0;
  const service = new AccountBanDispositionService(
    {
      async listGatewayAccountBanCandidates() {
        sweeps += 1;
        return [];
      },
    },
    {
      async banProviderAccount() {
        return null as never;
      },
    },
  );
  const worker = startAccountBanDispositionWorker(service, { pollIntervalMs: 60_000 });
  await worker.close();
  await worker.close();
  assert.equal(sweeps, 0);
});

test('the ban ledger reports lifecycle facts, whole alive days, and injected cumulative output', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const database = databaseWith(async (sql, values) => {
    const normalized = sql.replace(/\s+/g, ' ');
    statements.push({ sql: normalized, values });
    if (normalized.startsWith('SELECT status, banned_at')) {
      return {
        rows: [{ status: 'banned', banned_at: '2026-11-03T12:00:00.000Z' }],
        rowCount: 1,
      } as SqlResult<never>;
    }
    return {
      rows: [
        {
          id: 'account-1',
          created_at: '2026-11-01T00:00:00.000Z',
          banned_at: '2026-11-03T12:00:00.000Z',
          ban_reason: 'persistent_forbidden',
          ban_last_error: 'gateway_forbidden_failure',
        },
        {
          id: 'account-without-output',
          created_at: '2026-11-03T00:00:00.000Z',
          banned_at: '2026-11-03T01:00:00.000Z',
          ban_reason: 'probe_failure_threshold',
          ban_last_error: 'probe_auth_revoked',
        },
      ],
      rowCount: 2,
    } as SqlResult<never>;
  });
  let aggregatedIds: readonly string[] = [];
  const ledger = new PostgresAccountBanLedger(database, async (accountIds) => {
    aggregatedIds = accountIds;
    return new Map([['account-1', { requests: 12, tokens: 345n }]]);
  });
  assert.deepEqual(await ledger.getProviderAccountState('account-1'), {
    status: 'banned',
    bannedAt: '2026-11-03T12:00:00.000Z',
  });
  const entries = await ledger.list({ limit: 10 });
  assert.deepEqual(aggregatedIds, ['account-1', 'account-without-output']);
  assert.equal(entries[0]?.aliveDays, 2);
  assert.deepEqual(entries[0]?.output, { requests: 12, tokens: 345n });
  assert.deepEqual(entries[1]?.output, { requests: 0, tokens: 0n });
  assert.equal(entries[0]?.lastError, 'gateway_forbidden_failure');
  assert.deepEqual(statements[1]?.values, [10]);
});

test('the tenant ban ledger requires and binds tenant scope', async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const database = databaseWith(async (sql, values) => {
    statements.push({ sql: sql.replace(/\s+/g, ' '), values });
    return { rows: [], rowCount: 0 } as SqlResult<never>;
  });
  const ledger = new PostgresAccountBanLedger(database, async () => new Map());
  await assert.rejects(ledger.list({ ownerKind: 'tenant' }), /tenantId is required/);
  await ledger.list({ ownerKind: 'tenant', tenantId: 'tenant-1' });
  assert.match(statements[0]?.sql ?? '', /FROM saas_tenant_provider_accounts/);
  assert.match(statements[0]?.sql ?? '', /AND tenant_id = \$2/);
  assert.deepEqual(statements[0]?.values, [100, 'tenant-1']);
});
