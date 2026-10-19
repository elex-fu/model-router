import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderAccountModelCooldownRegistry } from '../../../src/saas/gateway/postgres-provider-account-model-cooldowns.js';
import {
  MODEL_RATE_LIMIT_COOLDOWN_MS,
  ProviderAccountModelRateLimit,
} from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';

function platformCandidate(accountId = 'account-1'): RequestPreparationCandidateAuthority {
  return {
    tenantId: 'tenant-1',
    accountId,
    upstreamId: 'upstream-1',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
  } as RequestPreparationCandidateAuthority;
}

function tenantCandidate(accountId = 'account-1'): RequestPreparationCandidateAuthority {
  return {
    tenantId: 'tenant-1',
    accountId,
    upstreamId: 'upstream-1',
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
  } as RequestPreparationCandidateAuthority;
}

interface RecordedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeDatabase {
  readonly queries: RecordedQuery[] = [];
  readonly rows: unknown[] = [];
  failWrites = false;
  failReads = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.queries.push({ sql, values });
    if (sql.includes('postgres-provider-account-model-cooldowns:upsert')) {
      if (this.failWrites) throw new Error('upsert failed');
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('postgres-provider-account-model-cooldowns:read')) {
      if (this.failReads) throw new Error('read failed');
      return { rows: this.rows as Row[], rowCount: this.rows.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function registry(database: FakeDatabase, local?: ProviderAccountModelRateLimit) {
  const errors: unknown[] = [];
  const created = new PostgresProviderAccountModelCooldownRegistry({
    database: database as unknown as SaasDatabase,
    ...(local ? { local } : {}),
    onError: (error) => errors.push(error),
  });
  return { created, errors };
}

test('record writes the L1 and a GREATEST-merged durable upsert in the shared key shape', async () => {
  const database = new FakeDatabase();
  const local = new ProviderAccountModelRateLimit();
  const { created, errors } = registry(database, local);
  const nowMs = Date.UTC(2026, 9, 19, 1, 0, 0);

  await created.recordModelRateLimit({ candidate: platformCandidate(), model: ' model-a ', nowMs });

  assert.equal(database.queries.length, 1);
  const upsert = database.queries[0];
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT \(owner_scope_key, account_id, model\)/);
  assert.match(upsert.sql, /GREATEST\(/);
  assert.deepEqual(upsert.values, [
    'platform',
    'account-1',
    'model-a',
    new Date(nowMs + MODEL_RATE_LIMIT_COOLDOWN_MS),
    new Date(nowMs),
  ]);
  // The L1 sees the record immediately (same-process reads never wait for PG).
  assert.equal(
    local.isModelExcluded({ candidate: platformCandidate(), model: 'model-a', now: new Date(nowMs + 1) }),
    true,
  );
  assert.deepEqual(errors, []);
});

test('record maps tenant-owned accounts to the tenant owner scope', async () => {
  const database = new FakeDatabase();
  const { created } = registry(database);
  await created.recordModelRateLimit({ candidate: tenantCandidate(), model: 'model-a', nowMs: 0 });
  assert.equal(database.queries[0]?.values[0], 'tenant-1');
});

test('record ignores malformed candidates and empty models without touching the database', async () => {
  const database = new FakeDatabase();
  const { created } = registry(database);
  await created.recordModelRateLimit({
    candidate: { tenantId: 'tenant-1' } as RequestPreparationCandidateAuthority,
    model: 'model-a',
  });
  await created.recordModelRateLimit({ candidate: platformCandidate(), model: '   ' });
  assert.equal(database.queries.length, 0);
});

test('record is best-effort: a failed upsert resolves, reports, and keeps the L1 cooldown', async () => {
  const database = new FakeDatabase();
  database.failWrites = true;
  const local = new ProviderAccountModelRateLimit();
  const { created, errors } = registry(database, local);
  const nowMs = 1_000;
  await created.recordModelRateLimit({ candidate: platformCandidate(), model: 'model-a', nowMs });
  assert.equal(errors.length, 1);
  assert.equal(
    local.isModelExcluded({ candidate: platformCandidate(), model: 'model-a', now: new Date(nowMs + 1) }),
    true,
  );
});

test('read consults the L1 first and never queries PG on a local hit', async () => {
  const database = new FakeDatabase();
  const local = new ProviderAccountModelRateLimit();
  const now = new Date(1_000);
  local.recordModelRateLimit({ candidate: platformCandidate(), model: 'model-a', nowMs: now.getTime() });
  const { created } = registry(database, local);
  assert.equal(await created.isModelExcluded({ candidate: platformCandidate(), model: 'model-a', now }), true);
  assert.equal(database.queries.length, 0);
});

test('read resolves the cooldown from the durable rows for a different instance', async () => {
  const database = new FakeDatabase();
  database.rows.push({ excluded: 1 });
  const { created } = registry(database);
  const now = new Date(Date.UTC(2026, 9, 19, 1, 0, 0));
  assert.equal(await created.isModelExcluded({ candidate: platformCandidate(), model: ' model-a ', now }), true);
  const read = database.queries[0];
  assert.ok(read);
  assert.match(read.sql, /cooled_until > \$4/);
  assert.deepEqual(read.values, ['platform', 'account-1', 'model-a', now]);
});

test('read resolves false when the durable row is absent (the until bound is the invalidation)', async () => {
  const database = new FakeDatabase();
  const { created } = registry(database);
  assert.equal(
    await created.isModelExcluded({ candidate: platformCandidate(), model: 'model-a', now: new Date(2_000) }),
    false,
  );
  assert.equal(database.queries.length, 1);
});

test('read fails open on a database error and reports it', async () => {
  const database = new FakeDatabase();
  database.failReads = true;
  const { created, errors } = registry(database);
  assert.equal(
    await created.isModelExcluded({ candidate: platformCandidate(), model: 'model-a', now: new Date(2_000) }),
    false,
  );
  assert.equal(errors.length, 1);
});

test('read fails open on malformed input without querying the database', async () => {
  const database = new FakeDatabase();
  const { created } = registry(database);
  assert.equal(
    await created.isModelExcluded({
      candidate: { tenantId: 'tenant-1' } as RequestPreparationCandidateAuthority,
      model: 'model-a',
      now: new Date(2_000),
    }),
    false,
  );
  assert.equal(
    await created.isModelExcluded({
      candidate: platformCandidate(),
      model: 'model-a',
      now: 'not-a-date' as unknown as Date,
    }),
    false,
  );
  assert.equal(database.queries.length, 0);
});
