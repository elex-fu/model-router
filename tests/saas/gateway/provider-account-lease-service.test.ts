import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/025_provider_account_leases.js';
import { PostgresProviderAccountLeaseService, ProviderAccountLeaseError } from '../../../src/saas/gateway/index.js';
import type { PreparedEvidenceLeaseRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';

type LeaseStatus = 'held' | 'released' | 'expired';

interface FakeLeaseRow {
  id: string;
  tenant_id: string;
  owner_kind: 'tenant' | 'platform';
  owner_tenant_id: string | null;
  account_id: string;
  upstream_id: string;
  attempt_id: string;
  slot: number;
  fencing_token: string;
  status: LeaseStatus;
  lease_expires_at: Date;
  released_at: Date | null;
}

function result<Row>(rows: Row[]): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

class FakeLeaseDatabase {
  readonly statements: string[] = [];
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  readonly events: string[] = [];
  readonly leases: FakeLeaseRow[] = [];
  nowMs = Date.parse('2026-09-28T00:00:00.000Z');
  accountAvailable = true;
  failOn: RegExp | null = null;
  private nextFencingToken = 0n;
  // Serializes this unit fixture only. Real lock exclusion and MVCC visibility
  // are proved separately by provider-account-lease-postgres.integration.test.
  private transactionTail = Promise.resolve();

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(async () => {
      const snapshot = this.leases.map((lease) => ({ ...lease, lease_expires_at: new Date(lease.lease_expires_at) }));
      try {
        return await work(this);
      } catch (error) {
        this.leases.splice(0, this.leases.length, ...snapshot);
        throw error;
      }
    });
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(normalized);
    this.calls.push({ sql: normalized, values: [...values] });
    if (this.failOn?.test(normalized)) throw new Error('fake storage failure');

    if (normalized === 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))') {
      this.events.push('account-fence');
      return result([]) as SqlResult<Row>;
    }
    if (normalized.includes('FROM saas_tenant_provider_accounts')) {
      this.events.push('account-read');
      return (
        this.accountAvailable
          ? result([{ id: String(values[1]), status: 'active', validation_state: 'verified', revoked_at: null }])
          : result([])
      ) as SqlResult<Row>;
    }
    if (normalized.includes('FROM saas_platform_provider_accounts')) {
      this.events.push('account-read');
      return (
        this.accountAvailable
          ? result([{ id: String(values[0]), status: 'active', validation_state: 'verified', revoked_at: null }])
          : result([])
      ) as SqlResult<Row>;
    }
    if (normalized.startsWith('SELECT id, slot, fencing_token')) {
      this.events.push('held-slots-lock');
      const ownerKind = String(values[0]);
      const ownerTenantId = (values[1] as string | null) ?? null;
      const accountId = String(values[2]);
      return result(
        this.leases.filter(
          (lease) =>
            lease.owner_kind === ownerKind &&
            lease.owner_tenant_id === ownerTenantId &&
            lease.account_id === accountId &&
            lease.status === 'held',
        ),
      ) as SqlResult<Row>;
    }
    if (normalized === 'SELECT clock_timestamp() AS db_now') {
      this.events.push('clock');
      return result([{ db_now: new Date(this.nowMs) }]) as SqlResult<Row>;
    }
    if (
      normalized.startsWith('UPDATE saas_provider_account_leases SET status =') &&
      !normalized.startsWith("UPDATE saas_provider_account_leases SET status = 'released'")
    ) {
      const ownerKind = String(values[0]);
      const ownerTenantId = (values[1] as string | null) ?? null;
      const accountId = String(values[2]);
      const now = new Date(values[3] as Date);
      let rowCount = 0;
      for (const lease of this.leases) {
        if (
          lease.owner_kind === ownerKind &&
          lease.owner_tenant_id === ownerTenantId &&
          lease.account_id === accountId &&
          lease.status === 'held' &&
          lease.lease_expires_at.getTime() <= now.getTime()
        ) {
          lease.status = 'expired';
          lease.released_at = new Date(now);
          rowCount += 1;
        }
      }
      return { rows: [], rowCount } as SqlResult<Row>;
    }
    if (normalized.startsWith("SELECT nextval('saas_provider_account_lease_fencing_seq')")) {
      this.events.push('next-fencing-token');
      this.nextFencingToken += 1n;
      return result([{ fencing_token: this.nextFencingToken.toString() }]) as SqlResult<Row>;
    }
    if (normalized.startsWith('INSERT INTO saas_provider_account_leases')) {
      this.events.push('insert-lease');
      const [id, tenantId, ownerKind, ownerTenantId, accountId, upstreamId, attemptId, slot, fencingToken, ttl] =
        values;
      this.leases.push({
        id: String(id),
        tenant_id: String(tenantId),
        owner_kind: ownerKind as 'tenant' | 'platform',
        owner_tenant_id: (ownerTenantId as string | null) ?? null,
        account_id: String(accountId),
        upstream_id: String(upstreamId),
        attempt_id: String(attemptId),
        slot: Number(slot),
        fencing_token: String(fencingToken),
        status: 'held',
        lease_expires_at: new Date(this.nowMs + Number(ttl)),
        released_at: null,
      });
      return result([{ id: String(id), fencing_token: String(fencingToken) }]) as SqlResult<Row>;
    }
    if (normalized.startsWith('SELECT id, tenant_id, owner_kind')) {
      const row = this.leases.find((lease) => lease.id === String(values[0]));
      return result(row ? [row] : []) as SqlResult<Row>;
    }
    if (normalized.startsWith('UPDATE saas_provider_account_leases SET lease_expires_at')) {
      const [id, ttl, fencingToken] = values;
      const row = this.leases.find((lease) => lease.id === String(id));
      if (
        row?.status !== 'held' ||
        row.fencing_token !== String(fencingToken) ||
        row.lease_expires_at.getTime() <= this.nowMs
      ) {
        return result([]) as SqlResult<Row>;
      }
      row.lease_expires_at = new Date(this.nowMs + Number(ttl));
      return result([{ id: row.id }]) as SqlResult<Row>;
    }
    if (normalized.startsWith("UPDATE saas_provider_account_leases SET status = 'released'")) {
      const [id, fencingToken] = values;
      const row = this.leases.find((lease) => lease.id === String(id));
      if (
        row?.status !== 'held' ||
        row.fencing_token !== String(fencingToken) ||
        row.lease_expires_at.getTime() <= this.nowMs
      ) {
        return result([]) as SqlResult<Row>;
      }
      row.status = 'released';
      row.released_at = new Date(this.nowMs);
      return result([{ id: row.id }]) as SqlResult<Row>;
    }
    throw new Error(`unhandled fake SQL: ${normalized}`);
  }
}

function evidence(
  supplyMode: 'byok' | 'platform' = 'platform',
  accountId = 'account-1',
  attemptId = 'attempt-1',
): PreparedRequestEvidenceRecord {
  return {
    evidenceId: `evidence-${attemptId}`,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId,
    attemptOrdinal: 1,
    supplyMode,
    publicModel: 'model-1',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    upstreamId: 'upstream-1',
    accountId,
    credentialId: 'credential-1',
    credentialVersion: '1',
    routeTargetMode: supplyMode === 'platform' ? 'platform_pool' : 'tenant_account',
    payloadSha256: 'a'.repeat(64),
    statementSha256: 'b'.repeat(64),
    status: 'claimed',
    claimedAt: '2026-09-28T00:00:00.000Z',
    claimedAttemptId: attemptId,
    expiresAt: '2026-09-28T01:00:00.000Z',
  };
}

function request(
  supplyMode: 'byok' | 'platform' = 'platform',
  accountId = 'account-1',
  attemptId = 'attempt-1',
): PreparedEvidenceLeaseRequest {
  const proof = evidence(supplyMode, accountId, attemptId);
  return {
    tenantId: proof.tenantId,
    accountId: proof.accountId,
    upstreamId: proof.upstreamId,
    attemptId: proof.attemptId,
    evidence: proof,
  };
}

function service(
  database: FakeLeaseDatabase,
  maxConcurrency = 2,
  leaseTtlMs = 1_000,
): PostgresProviderAccountLeaseService {
  return new PostgresProviderAccountLeaseService({
    database: database as unknown as SaasDatabase,
    maxConcurrency,
    leaseTtlMs,
  });
}

test('migration 025 is forward-only and defines append-only fenced slot leases', () => {
  assert.equal(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.version, 25);
  assert.match(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /CREATE SEQUENCE saas_provider_account_lease_fencing_seq/i);
  assert.match(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /CREATE TABLE saas_provider_account_leases/i);
  assert.match(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /fencing_token bigint NOT NULL DEFAULT nextval/i);
  assert.match(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /held_slot_unique/i);
  assert.match(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /BEFORE DELETE ON saas_provider_account_leases/i);
  assert.doesNotMatch(PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION.sql, /saas_attempts|UPDATE\s+saas_provider_account/i);
});

test('acquire fences then reads account and locks held slots before the database clock', async () => {
  const database = new FakeLeaseDatabase();
  const lease = await service(database).acquire(request());

  assert.ok(lease);
  assert.equal(lease.fencingToken, '1');
  assert.deepEqual(database.events.slice(0, 4), ['account-fence', 'account-read', 'held-slots-lock', 'clock']);
  assert.doesNotMatch(database.calls.find(({ sql }) => sql.includes('FROM saas_platform_provider_accounts'))!.sql,
    /FOR (?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/);
  assert.match(database.calls.find(({ sql }) => sql.startsWith('SELECT id, slot, fencing_token'))!.sql, /FOR UPDATE$/);
  assert.equal(database.leases[0]?.slot, 0);
  assert.equal(database.leases[0]?.status, 'held');
});

test('competition and configured capacity allow only finite account slots', async () => {
  const database = new FakeLeaseDatabase();
  const provider = service(database, 1);
  const results = await Promise.all([
    provider.acquire(request('platform', 'account-1', 'attempt-a')),
    provider.acquire(request('platform', 'account-1', 'attempt-b')),
  ]);

  assert.equal(results.filter((lease) => lease !== null).length, 1);
  assert.equal(results.filter((lease) => lease === null).length, 1);
  assert.equal(database.leases.filter((lease) => lease.status === 'held').length, 1);
});

test('full capacity occupies distinct account slots and rejects the next holder', async () => {
  const database = new FakeLeaseDatabase();
  const provider = service(database, 2);
  const results = await Promise.all([
    provider.acquire(request('platform', 'account-1', 'attempt-a')),
    provider.acquire(request('platform', 'account-1', 'attempt-b')),
    provider.acquire(request('platform', 'account-1', 'attempt-c')),
  ]);

  assert.ok(results[0]);
  assert.ok(results[1]);
  assert.equal(results[2], null);
  assert.deepEqual(
    database.leases.filter((lease) => lease.status === 'held').map((lease) => lease.slot),
    [0, 1],
  );
});

test('release frees a slot and every new holder receives a larger fencing token', async () => {
  const database = new FakeLeaseDatabase();
  const provider = service(database, 1);
  const first = await provider.acquire(request('platform', 'account-1', 'attempt-a'));
  assert.ok(first);
  await first.release();

  const second = await provider.acquire(request('platform', 'account-1', 'attempt-b'));
  assert.ok(second);
  assert.equal(second.fencingToken, '2');
  assert.equal(database.leases.filter((lease) => lease.status === 'held').length, 1);
});

test('renew extends a live lease but expiry recovery rejects the old token', async () => {
  const database = new FakeLeaseDatabase();
  const provider = service(database, 1, 1_000);
  const first = await provider.acquire(request('platform', 'account-1', 'attempt-a'));
  assert.ok(first);
  const firstExpiry = database.leases[0]?.lease_expires_at.getTime();

  database.nowMs += 500;
  await first.renew();
  assert.ok((database.leases[0]?.lease_expires_at.getTime() ?? 0) > (firstExpiry ?? 0));

  database.nowMs = database.leases[0]?.lease_expires_at.getTime() ?? database.nowMs + 2_000;
  const second = await provider.acquire(request('platform', 'account-1', 'attempt-b'));
  assert.ok(second);
  assert.equal(second.fencingToken, '2');
  await assert.rejects(
    first.renew(),
    (error: unknown) => error instanceof ProviderAccountLeaseError && error.code === 'STALE_LEASE',
  );
  await assert.rejects(
    first.release(),
    (error: unknown) => error instanceof ProviderAccountLeaseError && error.code === 'STALE_LEASE',
  );
  assert.equal(database.leases.find((lease) => lease.fencing_token === '2')?.status, 'held');
});

test('database failures fail closed and roll back the lease row', async () => {
  const database = new FakeLeaseDatabase();
  database.failOn = /INSERT INTO saas_provider_account_leases/;

  await assert.rejects(
    service(database).acquire(request()),
    (error: unknown) => error instanceof ProviderAccountLeaseError && error.code === 'STORAGE_ERROR',
  );
  assert.equal(database.leases.length, 0);
});

test('account fences use the existing exact owner and tenant identities without over-broad keys', async () => {
  const fences: string[] = [];
  for (const [mode, tenantId, accountId] of [
    ['byok', 'tenant-1', 'account:一'],
    ['byok', 'tenant-2', 'account:一'],
    ['platform', 'tenant-1', 'account:一'],
    ['platform', 'tenant-2', 'account:一'],
    ['platform', 'tenant-1', 'different-account'],
  ] as const) {
    const database = new FakeLeaseDatabase();
    const input = request(mode, accountId);
    const scoped = { ...input, tenantId, evidence: { ...input.evidence, tenantId } };
    assert.ok(await service(database).acquire(scoped));
    assert.equal(database.calls[0]?.sql, 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))');
    const expected = mode === 'byok'
      ? saasAdvisoryKey.tenantProviderAccount(tenantId, accountId)
      : saasAdvisoryKey.platformProviderAccount(accountId);
    assert.deepEqual(database.calls[0]?.values, [expected]);
    fences.push(expected);
    const read = database.calls[1]!;
    assert.match(read.sql, new RegExp(`FROM saas_${mode === 'byok' ? 'tenant' : 'platform'}_provider_accounts`));
    assert.doesNotMatch(read.sql, /FOR (?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/);
    assert.deepEqual(read.values, mode === 'byok' ? [tenantId, accountId] : [accountId]);
  }
  assert.notEqual(fences[0], fences[1]);
  assert.notEqual(fences[0], fences[2]);
  assert.equal(fences[2], fences[3], 'platform capacity is shared across request tenants');
  assert.notEqual(fences[2], fences[4]);
});

test('failed account fence stops before the account read, lease writes, sequence or retries', async () => {
  for (const mode of ['byok', 'platform'] as const) {
    const database = new FakeLeaseDatabase();
    database.failOn = /pg_advisory_xact_lock/;
    await assert.rejects(service(database).acquire(request(mode)),
      (error: unknown) => error instanceof ProviderAccountLeaseError && error.code === 'STORAGE_ERROR');
    assert.equal(database.calls.length, 1);
    assert.deepEqual(database.events, []);
    assert.equal(database.leases.length, 0);
  }
});

test('an unavailable account fails after its fence and before touching lease state', async () => {
  for (const mode of ['byok', 'platform'] as const) {
    const database = new FakeLeaseDatabase();
    database.accountAvailable = false;
    await assert.rejects(service(database).acquire(request(mode)),
      (error: unknown) => error instanceof ProviderAccountLeaseError && error.code === 'ACCOUNT_UNAVAILABLE');
    assert.deepEqual(database.events, ['account-fence', 'account-read']);
    assert.equal(database.calls.length, 2);
    assert.equal(database.leases.length, 0);
  }
});
