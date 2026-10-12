import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION } from '../../../src/saas/db/migrations/040_gateway_provider_account_runtime_health.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  type ProviderAccountRuntimeHealthEvidence,
  ProviderAccountRuntimeHealthStoreError,
} from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
} from '../../../src/saas/gateway/request-preparation-service.js';

const NOW = new Date('2026-09-29T00:00:00.000Z');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';

interface StoredHealth {
  readonly ownerScopeKey: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  state: 'healthy' | 'degraded' | 'cooldown' | 'unhealthy';
  failureCount: number;
  observedAt: Date;
  cooldownUntil: Date | null;
  lastOutcome: string;
  sourceFence: bigint;
  revision: bigint;
  /** Stored exactly as PostgreSQL returns numeric(4,3): a three-decimal string. */
  healthScore: string | null;
  halfOpenProbeAt: Date | null;
}

interface StoredLease {
  readonly tenantId: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly attemptId: string;
  readonly fencingToken: bigint;
}

interface FakeCall {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly inTransaction: boolean;
}

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function scopeKey(candidate: RequestPreparationCandidateAuthority): string {
  return candidate.supplyMode === 'byok' ? candidate.tenantId : 'platform';
}

class FakeExecutor implements SqlExecutor {
  constructor(
    private readonly database: FakeHealthDatabase,
    private readonly inTransaction: boolean,
  ) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalizeSql(sql);
    this.database.calls.push({ sql: statement, values: [...values], inTransaction: this.inTransaction });
    if (
      statement.startsWith(
        'SELECT state, observed_at, cooldown_until, failure_count, health_score, half_open_probe_at FROM saas_provider_account_runtime_health',
      )
    ) {
      const [ownerScopeKey, accountId, ownerKind, ownerTenantId] = values;
      const row = this.database.health.get(`${String(ownerScopeKey)}\u0000${String(accountId)}`);
      if (!row || row.ownerKind !== ownerKind || row.ownerTenantId !== ownerTenantId) return result([] as Row[]);
      return result([
        {
          state: row.state,
          observed_at: new Date(row.observedAt),
          cooldown_until: row.cooldownUntil ? new Date(row.cooldownUntil) : null,
          failure_count: row.failureCount,
          health_score: row.healthScore,
          half_open_probe_at: row.halfOpenProbeAt ? new Date(row.halfOpenProbeAt) : null,
        } as Row,
      ]);
    }
    if (statement.startsWith('SELECT state, observed_at, cooldown_until FROM saas_provider_account_runtime_health')) {
      const [ownerScopeKey, accountId, ownerKind, ownerTenantId] = values;
      const row = this.database.health.get(`${String(ownerScopeKey)}\u0000${String(accountId)}`);
      if (!row || row.ownerKind !== ownerKind || row.ownerTenantId !== ownerTenantId) return result([] as Row[]);
      return result([
        {
          state: row.state,
          observed_at: new Date(row.observedAt),
          cooldown_until: row.cooldownUntil ? new Date(row.cooldownUntil) : null,
        } as Row,
      ]);
    }
    if (
      statement.startsWith('WITH observation AS ( SELECT clock_timestamp() AS observed_at, nextval') &&
      statement.includes('UPDATE saas_provider_account_runtime_health AS current_health')
    ) {
      if (this.database.failHealthWrites) throw new Error('runtime health admission write failed');
      assert.match(statement, /nextval\('saas_provider_account_lease_fencing_seq'\)/i);
      assert.match(statement, /current_health\.state = 'cooldown'/i);
      const [ownerScopeKey, ownerKind, ownerTenantId, accountId] = values;
      // The sequence is drawn on every attempt, winners and losers alike.
      const fencingToken = BigInt(this.database.fencingSeq++);
      const key = `${String(ownerScopeKey)}${String.fromCharCode(0)}${String(accountId)}`;
      const current = this.database.health.get(key);
      if (!current || current.ownerKind !== ownerKind || current.ownerTenantId !== ownerTenantId) {
        return result([] as Row[]);
      }
      if (current.sourceFence >= fencingToken) return result([] as Row[]);
      const now = this.database.now;
      if (current.state !== 'cooldown' || !current.cooldownUntil) return result([] as Row[]);
      if (current.cooldownUntil.getTime() > now.getTime()) return result([] as Row[]);
      // A probe is live iff its admission is newer than the last outcome
      // (observedAt) and younger than the 30s crash-recovery lease.
      if (
        current.halfOpenProbeAt &&
        current.halfOpenProbeAt.getTime() > current.observedAt.getTime() &&
        current.halfOpenProbeAt.getTime() + 30_000 > now.getTime()
      ) {
        return result([] as Row[]);
      }
      // The admission CAS touches only the probe timestamp, fence and revision;
      // every binary column and the score stay byte-for-byte identical.
      const next: StoredHealth = {
        ...current,
        halfOpenProbeAt: new Date(now),
        sourceFence: fencingToken,
        revision: current.revision + 1n,
      };
      this.database.health.set(key, next);
      return result([{ revision: next.revision.toString() } as Row]);
    }
    if (statement.startsWith('WITH observation AS ( SELECT clock_timestamp() AS observed_at ), authorized_lease AS')) {
      if (this.database.failHealthWrites) throw new Error('runtime health write failed');
      assert.match(statement, /WHERE current_health\.source_fencing_token < EXCLUDED\.source_fencing_token/i);
      const [
        tenantId,
        ownerKind,
        ownerTenantId,
        accountId,
        upstreamId,
        attemptId,
        fence,
        ownerScopeKey,
        state,
        outcome,
      ] = values;
      const fencingToken = BigInt(String(fence));
      const lease = this.database.leases.find(
        (item) =>
          item.tenantId === tenantId &&
          item.ownerKind === ownerKind &&
          item.ownerTenantId === ownerTenantId &&
          item.accountId === accountId &&
          item.upstreamId === upstreamId &&
          item.attemptId === attemptId &&
          item.fencingToken === fencingToken,
      );
      if (!lease) return result([] as Row[]);
      const key = `${String(ownerScopeKey)}\u0000${String(accountId)}`;
      const current = this.database.health.get(key);
      if (current && current.sourceFence >= fencingToken) return result([] as Row[]);
      const failed = state === 'cooldown';
      const previousFailureCount = current?.failureCount ?? 0;
      const failureCount = failed ? Math.min(previousFailureCount + 1, 8) : 0;
      const backoffMs = Math.min(300_000, 1000 * 2 ** Math.min(previousFailureCount, 8));
      const observedAt = new Date(this.database.now);
      // EMA mirror of the authoritative SQL: NULL seeds at 1.000, alpha 0.2,
      // one step per applied outcome on the three-decimal grid.
      const seedMilli =
        current?.healthScore === null || current === undefined ? 1000 : Math.round(Number(current.healthScore) * 1000);
      const targetMilli = failed ? 0 : 1000;
      const healthScore = (Math.round(seedMilli + 0.2 * (targetMilli - seedMilli)) / 1000).toFixed(3);
      const next: StoredHealth = {
        ownerScopeKey: String(ownerScopeKey),
        ownerKind: ownerKind as StoredHealth['ownerKind'],
        ownerTenantId: ownerTenantId as string | null,
        accountId: String(accountId),
        state: state as StoredHealth['state'],
        failureCount,
        observedAt,
        cooldownUntil: failed ? new Date(observedAt.getTime() + backoffMs) : null,
        lastOutcome: String(outcome),
        sourceFence: fencingToken,
        revision: (current?.revision ?? 0n) + 1n,
        healthScore,
        halfOpenProbeAt: current?.halfOpenProbeAt ?? null,
      };
      this.database.health.set(key, next);
      return result([{ revision: next.revision.toString() } as Row]);
    }
    throw new Error(`Unexpected health SQL: ${statement}`);
  }
}

class FakeHealthDatabase implements SaasDatabase {
  readonly health = new Map<string, StoredHealth>();
  readonly leases: StoredLease[] = [];
  readonly calls: FakeCall[] = [];
  transactionCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  failHealthWrites = false;
  now = new Date(NOW);
  /** Fake fence sequence; starts above every literal test token (1-99). */
  fencingSeq = 1_000;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return new FakeExecutor(this, false).query(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const priorHealth = structuredClone(this.health);
    this.transactionCount += 1;
    try {
      const value = await work(new FakeExecutor(this, true));
      this.commitCount += 1;
      return value;
    } catch (error) {
      this.health.clear();
      for (const [key, row] of priorHealth) this.health.set(key, row);
      this.rollbackCount += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function caller(tenantId = TENANT_A, supplyMode: 'byok' | 'platform' = 'byok'): RequestPreparationCaller {
  return {
    tenantId,
    projectId: `${tenantId}-project`,
    proxyKeyId: `${tenantId}-key`,
    principalKind: 'member',
    principalId: `${tenantId}-member`,
    entitlementId: `${tenantId}-entitlement`,
    supplyProfileId: `${tenantId}-profile`,
    supplyMode,
    modelScopes: ['model'],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
}

function candidate(
  tenantId = TENANT_A,
  accountId = 'account-a',
  supplyMode: 'byok' | 'platform' = 'byok',
): RequestPreparationCandidateAuthority {
  const common = {
    tenantId,
    projectId: `${tenantId}-project`,
    proxyKeyId: `${tenantId}-key`,
    supplyProfileId: `${tenantId}-profile`,
    accountId,
    credentialId: `credential-${accountId}`,
    credentialVersion: 1,
    credentialAuthzVersion: 1,
    accountAuthzVersion: 1,
    dispatchProfileId: `${tenantId}-profile`,
    supplyProfileAuthzVersion: 1,
    resolvedModel: 'provider-model',
    protocol: 'openai' as const,
    endpoint: 'https://provider.example/v1',
    supplierCostVersion: supplyMode === 'platform' ? 'cost-v1' : null,
    providerId: 'provider-a',
    productId: 'product-a',
  };
  return supplyMode === 'byok'
    ? {
        ...common,
        supplyMode,
        accountOwnerKind: 'tenant',
        upstreamId: `${tenantId}-route`,
        profileAccountAuthzVersion: 1,
      }
    : {
        ...common,
        supplyMode,
        accountOwnerKind: 'platform',
        upstreamId: 'pool-a',
        poolId: 'pool-a',
        poolAuthzVersion: 1,
        poolMemberAccountAuthzVersion: 1,
        poolMemberAuthzVersion: 1,
        poolGrantAuthzVersion: 1,
        poolGrantProfileAuthzVersion: 1,
        poolGrantPoolAuthzVersion: 1,
      };
}

function store(database = new FakeHealthDatabase()): PostgresProviderAccountRuntimeHealthStore {
  return new PostgresProviderAccountRuntimeHealthStore({ database });
}

function seedLease(
  database: FakeHealthDatabase,
  account: RequestPreparationCandidateAuthority,
  fencingToken: string,
  attemptId = `attempt-${fencingToken}`,
): void {
  database.leases.push({
    tenantId: account.tenantId,
    ownerKind: account.supplyMode === 'byok' ? 'tenant' : 'platform',
    ownerTenantId: account.supplyMode === 'byok' ? account.tenantId : null,
    accountId: account.accountId,
    upstreamId: account.upstreamId,
    attemptId,
    fencingToken: BigInt(fencingToken),
  });
}

async function record(
  target: PostgresProviderAccountRuntimeHealthStore,
  account: RequestPreparationCandidateAuthority,
  fencingToken: string,
  evidence: ProviderAccountRuntimeHealthEvidence,
  attemptId = `attempt-${fencingToken}`,
): Promise<'applied' | 'stale'> {
  return target.recordRuntimeOutcome({ candidate: account, attemptId, fencingToken, evidence });
}

test('migration 040 defines a bounded, account-scoped runtime health row', () => {
  const { version, name, sql } = GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION;
  assert.equal(version, 40);
  assert.equal(name, 'gateway_provider_account_runtime_health');
  assert.match(sql, /CREATE TABLE saas_provider_account_runtime_health/i);
  assert.match(sql, /PRIMARY KEY \(owner_scope_key, account_id\)/i);
  assert.match(sql, /owner_kind IN \('tenant', 'platform'\)/i);
  assert.match(sql, /state IN \('healthy', 'degraded', 'cooldown', 'unhealthy'\)/i);
  assert.match(sql, /failure_count BETWEEN 0 AND 8/i);
  assert.match(sql, /interval '5 minutes'/i);
  assert.match(sql, /source_fencing_token bigint NOT NULL/i);
  assert.match(sql, /revision bigint NOT NULL/i);
  assert.match(sql, /OLD\.source_fencing_token/i);
  assert.doesNotMatch(sql, /credential|prompt|response|endpoint|url|error_text/i);
});

test('unknown health is blocked and caller validation cannot be recorded as runtime evidence', async () => {
  const database = new FakeHealthDatabase();
  const health = store(database);
  const account = candidate();
  const unknown = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(unknown.decision, 'block');
  assert.equal(database.calls.length, 1);

  seedLease(database, account, '1');
  await assert.rejects(
    record(health, account, '1', { source: 'gateway', result: 'client_4xx' } as never),
    (error: unknown) => error instanceof ProviderAccountRuntimeHealthStoreError && error.code === 'INVALID_INPUT',
  );
  assert.equal(database.transactionCount, 0);
  assert.equal(database.health.size, 0);
});

test('stale observations remain blocked', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  database.health.set(`${scopeKey(account)}\u0000${account.accountId}`, {
    ownerScopeKey: scopeKey(account),
    ownerKind: 'tenant',
    ownerTenantId: TENANT_A,
    accountId: account.accountId,
    state: 'healthy',
    failureCount: 0,
    observedAt: new Date(NOW.getTime() - 30_001),
    cooldownUntil: null,
    lastOutcome: 'gateway_success',
    sourceFence: 1n,
    revision: 1n,
    healthScore: '1.000',
    halfOpenProbeAt: null,
  });
  const decision = await store(database).get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(decision.decision, 'block');
  if (decision.decision === 'block') assert.match(decision.reason, /stale/);
});

test('a persisted successful runtime outcome is fresh and eligible', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  seedLease(database, account, '10');
  const health = store(database);
  assert.equal(await record(health, account, '10', { source: 'gateway', result: 'success' }), 'applied');
  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 1);
  assert.equal(database.calls.at(-1)?.inTransaction, true);
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.deepEqual(decision, {
    decision: 'allow',
    value: { status: 'healthy', observedAt: NOW, cooldownUntil: null },
  });
});

test('retryable failures create bounded exponential cooldown and expire to degraded eligibility', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '20');
  assert.equal(
    await record(health, account, '20', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' }),
    'applied',
  );
  let row = database.health.get(`${scopeKey(account)}\u0000${account.accountId}`);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.failureCount, 1);
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 1000);
  const cooling = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(cooling.decision, 'allow');
  if (cooling.decision === 'allow') assert.equal(cooling.value.status, 'cooldown');

  database.now = new Date(NOW.getTime() + 1000);
  const recoveredWindow = await health.get({ caller: caller(), candidate: account, now: database.now });
  assert.equal(recoveredWindow.decision, 'allow');
  if (recoveredWindow.decision === 'allow') assert.equal(recoveredWindow.value.status, 'degraded');

  seedLease(database, account, '21');
  assert.equal(
    await record(health, account, '21', {
      source: 'gateway',
      result: 'retryable_failure',
      failureKind: 'provider_5xx',
    }),
    'applied',
  );
  row = database.health.get(`${scopeKey(account)}\u0000${account.accountId}`);
  assert.equal(row?.failureCount, 2);
  assert.equal(row?.cooldownUntil?.getTime(), database.now.getTime() + 2000);

  assert.ok(row);
  row = { ...row, failureCount: 8 };
  database.health.set(`${scopeKey(account)}\u0000${account.accountId}`, row);
  seedLease(database, account, '22');
  await record(health, account, '22', { source: 'probe', result: 'retryable_failure', failureKind: 'protocol' });
  row = database.health.get(`${scopeKey(account)}\u0000${account.accountId}`);
  assert.equal(row?.failureCount, 8);
  assert.ok((row?.cooldownUntil?.getTime() ?? 0) - database.now.getTime() <= 300_000);
});

test('newer success heals a circuit and older failure cannot reopen it', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '30');
  await record(health, account, '30', { source: 'gateway', result: 'retryable_failure', failureKind: 'protocol' });
  seedLease(database, account, '31');
  assert.equal(await record(health, account, '31', { source: 'probe', result: 'success' }), 'applied');
  const key = `${scopeKey(account)}\u0000${account.accountId}`;
  assert.equal(database.health.get(key)?.state, 'healthy');
  assert.equal(database.health.get(key)?.failureCount, 0);
  assert.equal(database.health.get(key)?.cooldownUntil, null);
  seedLease(database, account, '29');
  assert.equal(
    await record(health, account, '29', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' }),
    'stale',
  );
  assert.equal(database.health.get(key)?.state, 'healthy');
});

test('concurrent outcomes are fenced by lease token and revision', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '40');
  seedLease(database, account, '41');
  const results = await Promise.all([
    record(health, account, '40', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' }),
    record(health, account, '41', { source: 'gateway', result: 'success' }),
  ]);
  assert.deepEqual(results, ['applied', 'applied']);
  const key = `${scopeKey(account)}\u0000${account.accountId}`;
  assert.equal(database.health.get(key)?.sourceFence, 41n);
  assert.equal(database.health.get(key)?.revision, 2n);
  assert.equal(database.health.get(key)?.state, 'healthy');

  seedLease(database, account, '41');
  assert.equal(
    await record(health, account, '41', { source: 'gateway', result: 'retryable_failure', failureKind: 'protocol' }),
    'stale',
  );
  assert.equal(database.health.get(key)?.state, 'healthy');
});

test('BYOK health is tenant and account isolated while platform health is globally shared', async () => {
  const database = new FakeHealthDatabase();
  const health = store(database);
  const tenantAAccount = candidate(TENANT_A, 'shared-id');
  const tenantBAccount = candidate(TENANT_B, 'shared-id');
  seedLease(database, tenantAAccount, '50');
  seedLease(database, tenantBAccount, '51');
  await record(health, tenantAAccount, '50', { source: 'gateway', result: 'success' });
  await record(health, tenantBAccount, '51', {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'network',
  });
  const a = await health.get({ caller: caller(TENANT_A), candidate: tenantAAccount, now: NOW });
  const b = await health.get({ caller: caller(TENANT_B), candidate: tenantBAccount, now: NOW });
  assert.equal(a.decision, 'allow');
  if (a.decision === 'allow') assert.equal(a.value.status, 'healthy');
  assert.equal(b.decision, 'allow');
  if (b.decision === 'allow') assert.equal(b.value.status, 'cooldown');

  const platformForA = candidate(TENANT_A, 'platform-account', 'platform');
  const platformForB = candidate(TENANT_B, 'platform-account', 'platform');
  seedLease(database, platformForA, '52');
  await record(health, platformForA, '52', { source: 'gateway', result: 'success' });
  const platformReadA = await health.get({ caller: caller(TENANT_A, 'platform'), candidate: platformForA, now: NOW });
  const platformReadB = await health.get({ caller: caller(TENANT_B, 'platform'), candidate: platformForB, now: NOW });
  assert.deepEqual(platformReadB, platformReadA);

  const otherAccount = candidate(TENANT_A, 'other-account');
  assert.equal((await health.get({ caller: caller(), candidate: otherAccount, now: NOW })).decision, 'block');
  const wrongTenant = await health.get({ caller: caller(TENANT_C), candidate: tenantAAccount, now: NOW });
  assert.equal(wrongTenant.decision, 'block');
});

test('health writes require matching persisted lease identity', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const outcome = await record(health, account, '60', { source: 'gateway', result: 'success' });
  assert.equal(outcome, 'stale');
  assert.equal(database.health.size, 0);
});

test('failed health observation writes close the same runtime to future selections', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '61');
  database.failHealthWrites = true;

  await assert.rejects(
    record(health, account, '61', { source: 'gateway', result: 'success' }),
    (error: unknown) => error instanceof ProviderAccountRuntimeHealthStoreError && error.code === 'STORAGE_ERROR',
  );
  const callsBeforeRead = database.calls.length;
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(decision.decision, 'block');
  assert.equal(database.calls.length, callsBeforeRead);
});

function healthRow(
  database: FakeHealthDatabase,
  account: RequestPreparationCandidateAuthority,
): StoredHealth | undefined {
  return database.health.get(`${scopeKey(account)}${String.fromCharCode(0)}${account.accountId}`);
}

async function admit(
  target: PostgresProviderAccountRuntimeHealthStore,
  account: RequestPreparationCandidateAuthority,
): Promise<'admitted' | 'closed'> {
  return target.tryAdmitHalfOpenProbe({ candidate: account });
}

/** Allocates a post-admission lease token above the fake sequence counter. */
function nextToken(database: FakeHealthDatabase): string {
  const token = String(database.fencingSeq);
  database.fencingSeq += 1;
  return token;
}

test('runtime outcomes update the EMA health score in the same transaction while binary semantics stay unchanged', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '70');
  assert.equal(
    await record(health, account, '70', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' }),
    'applied',
  );
  assert.equal(database.transactionCount, 1);
  assert.equal(database.calls.at(-1)?.inTransaction, true);
  let row = healthRow(database, account);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.failureCount, 1);
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 1000);
  assert.equal(row?.healthScore, '0.800', 'first failure applies one EMA step from the optimistic 1.000 seed');
  assert.equal(row?.halfOpenProbeAt, null);

  seedLease(database, account, '71');
  assert.equal(
    await record(health, account, '71', {
      source: 'gateway',
      result: 'retryable_failure',
      failureKind: 'provider_5xx',
    }),
    'applied',
  );
  row = healthRow(database, account);
  assert.equal(row?.failureCount, 2);
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 2000);
  assert.equal(row?.healthScore, '0.640');

  seedLease(database, account, '72');
  assert.equal(await record(health, account, '72', { source: 'gateway', result: 'success' }), 'applied');
  row = healthRow(database, account);
  assert.equal(row?.state, 'healthy');
  assert.equal(row?.failureCount, 0);
  assert.equal(row?.cooldownUntil, null);
  assert.equal(row?.healthScore, '0.712');
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.deepEqual(decision, {
    decision: 'allow',
    value: { status: 'healthy', observedAt: NOW, cooldownUntil: null },
  });
});

test('stale outcomes leave both the binary state and the health score untouched', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '80');
  assert.equal(await record(health, account, '80', { source: 'gateway', result: 'success' }), 'applied');
  assert.equal(healthRow(database, account)?.healthScore, '1.000');
  seedLease(database, account, '79');
  assert.equal(
    await record(health, account, '79', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' }),
    'stale',
  );
  const row = healthRow(database, account);
  assert.equal(row?.state, 'healthy');
  assert.equal(row?.healthScore, '1.000');
  assert.equal(row?.revision, 1n);
});

test('the scheduling view exposes score, probe and failure facts and blocks malformed scores', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '81');
  await record(health, account, '81', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' });
  const view = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(view.decision, 'allow');
  if (view.decision !== 'allow') return;
  assert.equal(view.value.status, 'cooldown');
  assert.equal(view.value.healthScore, 0.8);
  assert.equal(view.value.consecutiveFailures, 1);
  assert.equal(view.value.halfOpenProbeAt, null);
  assert.equal(view.value.cooldownUntil?.getTime(), NOW.getTime() + 1000);

  // An expired cooldown maps to degraded status but keeps the raw deadline:
  // exactly the half-open probe candidate shape the scheduler evaluates.
  const expired = await health.getSchedulingView({
    caller: caller(),
    candidate: account,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(expired.decision, 'allow');
  if (expired.decision !== 'allow') return;
  assert.equal(expired.value.status, 'degraded');
  assert.equal(expired.value.cooldownUntil?.getTime(), NOW.getTime() + 1000);

  // A pre-R7 row without a score reads as NULL, never as a fabricated value.
  const key = `${scopeKey(account)}${String.fromCharCode(0)}${account.accountId}`;
  const legacy = database.health.get(key);
  assert.ok(legacy);
  database.health.set(key, { ...legacy, healthScore: null });
  const legacyView = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(legacyView.decision, 'allow');
  if (legacyView.decision === 'allow') assert.equal(legacyView.value.healthScore, null);

  // Corruption blocks fail-closed; it is never reinterpreted as NULL.
  database.health.set(key, { ...legacy, healthScore: '9.999' });
  const corrupt = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(corrupt.decision, 'block');
  if (corrupt.decision === 'block') assert.match(corrupt.reason, /score is malformed/);
});

test('half-open admission is single-winner and probe outcomes drive recovery or re-entry with backoff', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '90');
  await record(health, account, '90', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' });
  let row = healthRow(database, account);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 1000);

  // The active cooldown admits no probe.
  assert.equal(await admit(health, account), 'closed');
  assert.equal(healthRow(database, account)?.halfOpenProbeAt, null);

  // After expiry exactly one probe wins; binary columns stay byte-identical.
  // The admission fence comes from the fencing sequence, above every prior
  // lease token and below any lease acquired after the admission.
  const cooled = new Date(NOW.getTime() + 1000);
  database.now = cooled;
  assert.equal(await admit(health, account), 'admitted');
  row = healthRow(database, account);
  assert.equal(row?.halfOpenProbeAt?.getTime(), cooled.getTime());
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.failureCount, 1);
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 1000);
  assert.equal(row?.lastOutcome, 'gateway_network_failure');
  assert.equal(row?.healthScore, '0.800');
  assert.equal(row?.revision, 2n);
  assert.equal(row?.sourceFence, 1001n, 'the losing active-cooldown attempt burned sequence value 1000');

  // A concurrent second admission loses while the probe lease is live.
  assert.equal(await admit(health, account), 'closed');

  // Probe success restores normal eligibility and the score joins the EMA.
  // The probe dispatch lease is acquired after the admission, so its token
  // is strictly greater than the admission fence.
  const probeSuccessToken = nextToken(database);
  seedLease(database, account, probeSuccessToken);
  assert.equal(await record(health, account, probeSuccessToken, { source: 'probe', result: 'success' }), 'applied');
  row = healthRow(database, account);
  assert.equal(row?.state, 'healthy');
  assert.equal(row?.failureCount, 0);
  assert.equal(row?.cooldownUntil, null);
  assert.equal(row?.healthScore, '0.840');
  assert.equal(row?.halfOpenProbeAt?.getTime(), cooled.getTime(), 'probe admission timestamp is kept as history');

  // A fresh failure re-enters cooldown; the next probe is admitted after expiry.
  const failureToken = nextToken(database);
  seedLease(database, account, failureToken);
  await record(health, account, failureToken, {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'protocol',
  });
  row = healthRow(database, account);
  assert.equal(row?.healthScore, '0.672');
  const secondExpiry = new Date(cooled.getTime() + 1000);
  database.now = secondExpiry;
  assert.equal(await admit(health, account), 'admitted');
  assert.equal(healthRow(database, account)?.halfOpenProbeAt?.getTime(), secondExpiry.getTime());

  // Probe failure re-enters cooldown with the doubled binary backoff; the
  // probe admission timestamp stays at the failed probe's admission.
  const probeFailureToken = nextToken(database);
  seedLease(database, account, probeFailureToken);
  assert.equal(
    await record(health, account, probeFailureToken, {
      source: 'probe',
      result: 'retryable_failure',
      failureKind: 'provider_5xx',
    }),
    'applied',
  );
  row = healthRow(database, account);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.failureCount, 2);
  assert.equal(row?.cooldownUntil?.getTime(), secondExpiry.getTime() + 2000);
  assert.equal(row?.healthScore, '0.538');
  assert.equal(row?.halfOpenProbeAt?.getTime(), secondExpiry.getTime());

  // A concluded probe never blocks: once the doubled binary cooldown
  // expires, the next probe is admitted immediately.
  database.now = new Date(secondExpiry.getTime() + 2000);
  assert.equal(await admit(health, account), 'admitted');

  // A healthy or unknown row never admits a probe.
  const healthyToken = nextToken(database);
  seedLease(database, account, healthyToken);
  await record(health, account, healthyToken, { source: 'probe', result: 'success' });
  assert.equal(await admit(health, account), 'closed', 'a healthy row is not probe-eligible');
  assert.equal(await admit(health, candidate(TENANT_A, 'other-account')), 'closed', 'unknown health stays closed');

  // A crashed probe (admission without a recorded outcome) blocks further
  // probes only until the crash-recovery lease expires.
  const crashToken = nextToken(database);
  seedLease(database, account, crashToken);
  await record(health, account, crashToken, { source: 'gateway', result: 'retryable_failure', failureKind: 'network' });
  const crashExpiry = new Date(database.now.getTime() + 1000);
  database.now = crashExpiry;
  assert.equal(await admit(health, account), 'admitted');
  database.now = new Date(crashExpiry.getTime() + 29_999);
  assert.equal(await admit(health, account), 'closed');
  database.now = new Date(crashExpiry.getTime() + 30_000);
  assert.equal(await admit(health, account), 'admitted');
});

test('failed half-open admission writes close the same runtime to future selections', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '98');
  await record(health, account, '98', { source: 'gateway', result: 'retryable_failure', failureKind: 'network' });
  database.now = new Date(NOW.getTime() + 1000);
  database.failHealthWrites = true;

  await assert.rejects(
    admit(health, account),
    (error: unknown) => error instanceof ProviderAccountRuntimeHealthStoreError && error.code === 'STORAGE_ERROR',
  );
  const callsBeforeRead = database.calls.length;
  const decision = await health.getSchedulingView({ caller: caller(), candidate: account, now: database.now });
  assert.equal(decision.decision, 'block');
  assert.equal(database.calls.length, callsBeforeRead);
});
