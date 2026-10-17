import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION } from '../../../src/saas/db/migrations/040_gateway_provider_account_runtime_health.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  ProviderAccountDispatchFailureFeedback,
  ProviderAccountModelRateLimit,
  type ProviderAccountRuntimeHealthEvidence,
  ProviderAccountRuntimeHealthStoreError,
  providerDispatchFeedbackOutcome,
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
      assert.match(statement, /current_health\.state IN \('healthy', 'degraded'\)/i);
      const [ownerScopeKey, ownerKind, ownerTenantId, accountId, staleAfterMs] = values;
      // The sequence is drawn on every attempt, winners and losers alike.
      const fencingToken = BigInt(this.database.fencingSeq++);
      const key = `${String(ownerScopeKey)}${String.fromCharCode(0)}${String(accountId)}`;
      const current = this.database.health.get(key);
      if (!current || current.ownerKind !== ownerKind || current.ownerTenantId !== ownerTenantId) {
        return result([] as Row[]);
      }
      if (current.sourceFence >= fencingToken) return result([] as Row[]);
      const now = this.database.now;
      // H5a: probe eligibility is expired cooldown OR a merely-stale
      // fresh-state row ($5 = the caller's freshness bound).
      const staleAfter = Number(staleAfterMs ?? 30_000);
      const expiredCooldown =
        current.state === 'cooldown' &&
        current.cooldownUntil !== null &&
        current.cooldownUntil.getTime() <= now.getTime();
      const staleFreshState =
        (current.state === 'healthy' || current.state === 'degraded') &&
        current.observedAt.getTime() + staleAfter <= now.getTime();
      if (!expiredCooldown && !staleFreshState) return result([] as Row[]);
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
    if (statement.startsWith('INSERT INTO saas_provider_account_runtime_health')) {
      // P18: the cold-start prime. The primary key is the single-winner fence:
      // an existing row (any state) loses exactly like a failed admission CAS.
      if (this.database.failHealthWrites) throw new Error('runtime health admission write failed');
      assert.match(statement, /ON CONFLICT \(owner_scope_key, account_id\) DO NOTHING/i);
      assert.match(statement, /nextval\('saas_provider_account_lease_fencing_seq'\)/i);
      const [ownerScopeKey, ownerKind, ownerTenantId, accountId] = values;
      const fencingToken = BigInt(this.database.fencingSeq++);
      const key = `${String(ownerScopeKey)}${String.fromCharCode(0)}${String(accountId)}`;
      if (this.database.health.has(key)) return result([] as Row[]);
      const observedAt = new Date(this.database.now);
      const row: StoredHealth = {
        ownerScopeKey: String(ownerScopeKey),
        ownerKind: ownerKind as StoredHealth['ownerKind'],
        ownerTenantId: ownerTenantId as string | null,
        accountId: String(accountId),
        state: 'cooldown',
        failureCount: 1,
        observedAt,
        cooldownUntil: new Date(observedAt.getTime() + 30_000),
        lastOutcome: 'probe_protocol_failure',
        sourceFence: fencingToken,
        revision: 1n,
        healthScore: null,
        halfOpenProbeAt: new Date(observedAt),
      };
      this.database.health.set(key, row);
      return result([{ revision: '1' } as Row]);
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
      // K2 mirror of the authoritative per-outcome cooldown curves. The
      // account-attributable kinds carry short bounded curves (and a
      // count-only first write for 429); the pre-K2 kinds keep the exact
      // original 1 s → 300 s doubling. A fresh row (no current) uses the
      // same first-failure values the SQL INSERT branch applies.
      const outcomeText = String(outcome);
      let backoffMs: number;
      if (outcomeText === 'gateway_rate_limited_failure' && failureCount < 2) {
        backoffMs = 0; // count-only: cooldown_until = observed_at
      } else if (outcomeText === 'gateway_account_access_failure' || outcomeText === 'gateway_stream_abort_failure') {
        backoffMs = Math.min(15_000, 5_000 * 2 ** Math.min(previousFailureCount, 2));
      } else if (outcomeText === 'gateway_rate_limited_failure') {
        backoffMs = Math.min(15_000, 2_000 * 2 ** Math.min(previousFailureCount, 3));
      } else {
        backoffMs = Math.min(300_000, 1000 * 2 ** Math.min(previousFailureCount, 8));
      }
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

test('account access failures cool immediately with a short capped curve (K2)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const key = `${scopeKey(account)}\u0000${account.accountId}`;

  // First 401/403 on a never-observed account: the INSERT branch applies the
  // kind's base cooldown (5 s), not the generic 1 s.
  seedLease(database, account, '20');
  assert.equal(
    await record(health, account, '20', {
      source: 'gateway',
      result: 'retryable_failure',
      failureKind: 'account_access',
    }),
    'applied',
  );
  let row = database.health.get(key);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.lastOutcome, 'gateway_account_access_failure');
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime() + 5_000);
  const cooling = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(cooling.decision, 'allow');
  if (cooling.decision === 'allow') assert.equal(cooling.value.status, 'cooldown');

  // Second and third consecutive failures double to the 15 s cap.
  for (const [fence, expectedMs, atMs] of [
    ['21', 10_000, 5_000],
    ['22', 15_000, 15_000],
    ['23', 15_000, 30_000],
  ] as const) {
    database.now = new Date(NOW.getTime() + atMs);
    seedLease(database, account, fence);
    assert.equal(
      await record(health, account, fence, {
        source: 'gateway',
        result: 'retryable_failure',
        failureKind: 'account_access',
      }),
      'applied',
    );
    row = database.health.get(key);
    assert.equal(row?.cooldownUntil?.getTime(), database.now.getTime() + expectedMs);
  }

  // Post-window recovery is cooldown expiry: the account is schedulable
  // again (degraded rank) without any external probe.
  database.now = new Date(NOW.getTime() + 45_001);
  const recovered = await health.get({ caller: caller(), candidate: account, now: database.now });
  assert.equal(recovered.decision, 'allow');
  if (recovered.decision === 'allow') assert.equal(recovered.value.status, 'degraded');
});

test('rate limited failures count first and cool from the second (K2)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const key = `${scopeKey(account)}\u0000${account.accountId}`;

  // First 429: count-only — cooldown_until equals observed_at, so the row
  // reads as expired ('degraded') and the account stays schedulable.
  seedLease(database, account, '20');
  assert.equal(
    await record(health, account, '20', {
      source: 'gateway',
      result: 'retryable_failure',
      failureKind: 'rate_limited',
    }),
    'applied',
  );
  let row = database.health.get(key);
  assert.equal(row?.state, 'cooldown');
  assert.equal(row?.failureCount, 1);
  assert.equal(row?.lastOutcome, 'gateway_rate_limited_failure');
  assert.equal(row?.cooldownUntil?.getTime(), NOW.getTime());
  const first = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(first.decision, 'allow');
  if (first.decision === 'allow') assert.equal(first.value.status, 'degraded');

  // From the second consecutive 429: 4 s doubling to the 15 s cap (the
  // first write already counted failure_count = 1).
  for (const [fence, expectedMs, atMs] of [
    ['21', 4_000, 1_000],
    ['22', 8_000, 3_000],
    ['23', 15_000, 7_000],
    ['24', 15_000, 15_000],
  ] as const) {
    database.now = new Date(NOW.getTime() + atMs);
    seedLease(database, account, fence);
    assert.equal(
      await record(health, account, fence, {
        source: 'gateway',
        result: 'retryable_failure',
        failureKind: 'rate_limited',
      }),
      'applied',
    );
    row = database.health.get(key);
    assert.equal(row?.cooldownUntil?.getTime(), database.now.getTime() + expectedMs);
  }
});

test('stream abort failures use the short capped curve (K2)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const key = `${scopeKey(account)}\u0000${account.accountId}`;
  seedLease(database, account, '20');
  await record(health, account, '20', {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'stream_abort',
  });
  assert.equal(database.health.get(key)?.lastOutcome, 'gateway_stream_abort_failure');
  assert.equal(database.health.get(key)?.cooldownUntil?.getTime(), NOW.getTime() + 5_000);
  database.now = new Date(NOW.getTime() + 5_000);
  seedLease(database, account, '21');
  await record(health, account, '21', {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'stream_abort',
  });
  assert.equal(database.health.get(key)?.cooldownUntil?.getTime(), database.now.getTime() + 10_000);
});

test('pre-K2 failure kinds keep the original 1 s to 300 s doubling curve (K2 red line)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const key = `${scopeKey(account)}\u0000${account.accountId}`;
  seedLease(database, account, '20');
  await record(health, account, '20', {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'provider_5xx',
  });
  assert.equal(database.health.get(key)?.cooldownUntil?.getTime(), NOW.getTime() + 1_000);
  // A high failure_count on an original kind still reaches the long cap —
  // the K2 short curves must not leak into the existing vocabulary.
  const row = database.health.get(key);
  assert.ok(row);
  database.health.set(key, { ...row, failureCount: 8 });
  seedLease(database, account, '21');
  await record(health, account, '21', {
    source: 'gateway',
    result: 'retryable_failure',
    failureKind: 'network',
  });
  assert.equal(database.health.get(key)?.cooldownUntil?.getTime(), NOW.getTime() + 256_000);
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
  assert.equal(
    row?.sourceFence,
    1002n,
    'the losing active-cooldown attempt burned two sequence values: the failed UPDATE and the P18 prime insert that lost on the primary key',
  );

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

  // A healthy row never admits a probe.
  const healthyToken = nextToken(database);
  seedLease(database, account, healthyToken);
  await record(health, account, healthyToken, { source: 'probe', result: 'success' });
  assert.equal(await admit(health, account), 'closed', 'a healthy row is not probe-eligible');
  // P18: a zero-row account now admits the one-time cold-start prime
  // instead of staying closed forever (covered in full below).
  assert.equal(await admit(health, candidate(TENANT_A, 'other-account')), 'admitted');
  assert.equal(await admit(health, candidate(TENANT_A, 'other-account')), 'closed', 'the prime is single-winner');

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

/* ------------------------------------------------------------------ */
/* H1 (R9 bench finding P5b): clock-skew tolerance                     */
/* ------------------------------------------------------------------ */

function seedHealth(
  database: FakeHealthDatabase,
  account: RequestPreparationCandidateAuthority,
  overrides: Partial<StoredHealth> = {},
): StoredHealth {
  const row: StoredHealth = {
    ownerScopeKey: scopeKey(account),
    ownerKind: account.supplyMode === 'byok' ? 'tenant' : 'platform',
    ownerTenantId: account.supplyMode === 'byok' ? account.tenantId : null,
    accountId: account.accountId,
    state: 'healthy',
    failureCount: 0,
    observedAt: new Date(NOW.getTime() - 1000),
    cooldownUntil: null,
    lastOutcome: 'gateway_success',
    sourceFence: 1n,
    revision: 1n,
    healthScore: '1.000',
    halfOpenProbeAt: null,
    ...overrides,
  };
  database.health.set(`${scopeKey(account)}${String.fromCharCode(0)}${account.accountId}`, row);
  return row;
}

test('observed_at up to the skew tolerance ahead of now is clamped to age zero (H1)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  seedHealth(database, account, { observedAt: new Date(NOW.getTime() + 200) });
  const health = store(database);
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(decision.decision, 'allow');
  if (decision.decision === 'allow') assert.equal(decision.value.status, 'healthy');
  const view = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(view.decision, 'allow');
});

test('observed_at beyond the skew tolerance stays malformed and blocks fail-closed (H1)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  seedHealth(database, account, { observedAt: new Date(NOW.getTime() + 251) });
  const health = store(database);
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(decision.decision, 'block');
  if (decision.decision === 'block') assert.match(decision.reason, /stale or malformed/);
  const view = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(view.decision, 'block');
  if (view.decision === 'block') assert.equal(view.code, 'malformed');
});

test('scheduling view block reasons carry a discriminating code (H5a)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  const unknown = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(unknown.decision, 'block');
  if (unknown.decision === 'block') assert.equal(unknown.code, 'unknown');

  seedHealth(database, account, { observedAt: new Date(NOW.getTime() - 30_001) });
  const stale = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(stale.decision, 'block');
  if (stale.decision === 'block') assert.equal(stale.code, 'stale');

  const invalid = await health.getSchedulingView({
    caller: caller(TENANT_B),
    candidate: account,
    now: NOW,
  });
  assert.equal(invalid.decision, 'block');
  if (invalid.decision === 'block') assert.equal(invalid.code, 'input');

  const malformedScore = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  seedHealth(database, account, { healthScore: '9.999', observedAt: new Date(NOW.getTime() - 1000) });
  const corrupt = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(corrupt.decision, 'block');
  if (corrupt.decision === 'block') assert.equal(corrupt.code, 'malformed');
  assert.equal(malformedScore.decision, 'block');
});

/* ------------------------------------------------------------------ */
/* H5b (R9 bench finding P6): bounded write-failure latch              */
/* ------------------------------------------------------------------ */

test('a failed health write latches only for a bounded window, then a read recovers it (H5b)', async (t) => {
  t.mock.timers.enable({ now: NOW.getTime() });
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedLease(database, account, '110');
  await record(health, account, '110', { source: 'gateway', result: 'success' });
  database.failHealthWrites = true;
  seedLease(database, account, '111');
  await assert.rejects(
    record(health, account, '111', { source: 'gateway', result: 'success' }),
    (error: unknown) => error instanceof ProviderAccountRuntimeHealthStoreError && error.code === 'STORAGE_ERROR',
  );

  // Inside the (first-failure) 1 s window the authority stays fail-closed.
  const callsBeforeRead = database.calls.length;
  const latched = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(latched.decision, 'block');
  assert.equal(database.calls.length, callsBeforeRead);

  // Once the window expires the read runs again and its success clears the latch.
  t.mock.timers.tick(1_000);
  const recovered = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(recovered.decision, 'allow');
  assert.equal((await health.get({ caller: caller(), candidate: account, now: NOW })).decision, 'allow');
});

test('a successful health write clears the latch immediately without waiting out the window (H5b)', async (t) => {
  t.mock.timers.enable({ now: NOW.getTime() });
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  database.failHealthWrites = true;
  await assert.rejects(
    record(health, account, '120', { source: 'gateway', result: 'success' }),
    (error: unknown) => error instanceof ProviderAccountRuntimeHealthStoreError && error.code === 'STORAGE_ERROR',
  );
  assert.equal((await health.get({ caller: caller(), candidate: account, now: NOW })).decision, 'block');

  database.failHealthWrites = false;
  seedLease(database, account, '121');
  assert.equal(await record(health, account, '121', { source: 'gateway', result: 'success' }), 'applied');
  // No tick: the successful statement already proved the pool recovered.
  const decision = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(decision.decision, 'allow');
});

test('repeated write failures escalate the latch window instead of wedging forever (H5b)', async (t) => {
  t.mock.timers.enable({ now: NOW.getTime() });
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedHealth(database, account);
  database.failHealthWrites = true;

  await assert.rejects(record(health, account, '130', { source: 'gateway', result: 'success' }));
  t.mock.timers.tick(500);
  await assert.rejects(record(health, account, '131', { source: 'gateway', result: 'success' }));
  // Second failure: a 2 s window from t=500 (latched until t=2500).
  assert.equal((await health.get({ caller: caller(), candidate: account, now: NOW })).decision, 'block');
  t.mock.timers.tick(1_000);
  assert.equal((await health.get({ caller: caller(), candidate: account, now: NOW })).decision, 'block');
  t.mock.timers.tick(1_000);
  const recovered = await health.get({ caller: caller(), candidate: account, now: NOW });
  assert.equal(recovered.decision, 'allow');
});

/* ------------------------------------------------------------------ */
/* H5a (R9 bench finding P5a): stale-row half-open probe admission     */
/* ------------------------------------------------------------------ */

test('a stale healthy row admits exactly one half-open probe and keeps the binary columns unchanged (H5a)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  seedHealth(database, account, { observedAt: new Date(NOW.getTime() - 31_000) });
  database.now = NOW;

  // Not stale under a looser caller-provided bound: stays closed.
  assert.equal(await health.tryAdmitHalfOpenProbe({ candidate: account, staleAfterMs: 60_000 }), 'closed');

  assert.equal(await admit(health, account), 'admitted');
  const row = healthRow(database, account);
  assert.ok(row);
  assert.equal(row.halfOpenProbeAt?.getTime(), NOW.getTime());
  assert.equal(row.state, 'healthy');
  assert.equal(row.failureCount, 0);
  assert.equal(row.cooldownUntil, null);
  assert.equal(row.healthScore, '1.000');
  assert.equal(row.revision, 2n);

  // The live admission is single-winner until the crash-recovery lease.
  assert.equal(await admit(health, account), 'closed');
  database.now = new Date(NOW.getTime() + 30_000);
  assert.equal(await admit(health, account), 'admitted');

  // A fresh healthy row never admits.
  database.now = NOW;
  seedHealth(database, account, { observedAt: new Date(NOW.getTime() - 1_000) });
  assert.equal(await admit(health, account), 'closed');
});

/* ------------------------------------------------------------------ */
/* P18 (R9 re-run finding): zero-row cold-start priming                */
/* ------------------------------------------------------------------ */

test('a zero-row account admits exactly one cold-start prime that the probe outcome completes (P18)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  database.now = NOW;

  // No row at all: the prime creates the pending-probe row.
  assert.equal(await admit(health, account), 'admitted');
  let row = healthRow(database, account);
  assert.ok(row);
  assert.equal(row.state, 'cooldown');
  assert.equal(row.failureCount, 1);
  assert.equal(row.cooldownUntil?.getTime(), NOW.getTime() + 30_000);
  assert.equal(row.halfOpenProbeAt?.getTime(), NOW.getTime());
  assert.equal(row.healthScore, null);
  assert.equal(row.revision, 1n);
  // Two sequence values burned: the losing UPDATE attempt and the prime.
  assert.equal(row.sourceFence, 1001n);

  // The live prime denies plain scheduling readers (fail-closed) and is
  // single-winner: the cooldown state blocks every admission branch.
  const view = await health.getSchedulingView({ caller: caller(), candidate: account, now: NOW });
  assert.equal(view.decision, 'allow');
  if (view.decision === 'allow') {
    assert.equal(view.value.status, 'cooldown');
    assert.equal(view.value.cooldownUntil?.getTime(), NOW.getTime() + 30_000);
  }
  assert.equal(await admit(health, account), 'closed');

  // Crash recovery: an abandoned prime expires with the 30s lease window.
  database.now = new Date(NOW.getTime() + 29_999);
  assert.equal(await admit(health, account), 'closed');
  database.now = new Date(NOW.getTime() + 30_000);
  assert.equal(await admit(health, account), 'admitted');

  // The winner's lease-authorized probe outcome rewrites the prime into a
  // clean healthy row: the cooldown encoding is erased entirely (revision 3
  // = prime, crash-recovery re-admission, probe outcome).
  const probeToken = nextToken(database);
  seedLease(database, account, probeToken);
  assert.equal(await record(health, account, probeToken, { source: 'probe', result: 'success' }), 'applied');
  row = healthRow(database, account);
  assert.ok(row);
  assert.equal(row.state, 'healthy');
  assert.equal(row.failureCount, 0);
  assert.equal(row.cooldownUntil, null);
  assert.equal(row.healthScore, '1.000', 'a NULL score seeds the EMA at the optimistic 1.000');
  assert.equal(row.lastOutcome, 'probe_success');
  assert.equal(row.revision, 3n);

  // The completed row behaves like any healthy row: no further admission.
  assert.equal(await admit(health, account), 'closed');
});

test('a cold-start prime never inserts over an existing row (P18)', async () => {
  const database = new FakeHealthDatabase();
  const account = candidate();
  const health = store(database);
  // A fresh healthy row fails the admission UPDATE branches; the prime
  // INSERT then loses on the primary key and the call stays 'closed'.
  seedHealth(database, account, { observedAt: new Date(NOW.getTime() - 1_000) });
  database.now = NOW;
  const callsBefore = database.calls.length;
  assert.equal(await admit(health, account), 'closed');
  assert.equal(database.calls.length, callsBefore + 2, 'the update ran, then the prime insert lost on the PK');
  assert.equal(healthRow(database, account)?.revision, 1n);
});

/* ------------------------------------------------------------------ */
/* H5c (R9 bench finding P8): in-process dispatch failure feedback     */
/* ------------------------------------------------------------------ */

test('dispatch feedback maps only account-attributable statuses (H5c)', () => {
  assert.equal(providerDispatchFeedbackOutcome(200), 'success');
  assert.equal(providerDispatchFeedbackOutcome(299), 'success');
  assert.equal(providerDispatchFeedbackOutcome(401), 'auth_or_permission_failure');
  assert.equal(providerDispatchFeedbackOutcome(403), 'auth_or_permission_failure');
  assert.equal(providerDispatchFeedbackOutcome(429), 'rate_limited');
  // 5xx and other 4xx belong to the durable health classification or are
  // request-attributable: no in-process feedback signal.
  assert.equal(providerDispatchFeedbackOutcome(500), null);
  assert.equal(providerDispatchFeedbackOutcome(400), null);
  assert.equal(providerDispatchFeedbackOutcome(404), null);
  assert.equal(providerDispatchFeedbackOutcome(null), null);
  assert.equal(providerDispatchFeedbackOutcome(undefined), null);
  // Batch 2.3: the kind-aware mapping and the 402 status fallback.
  assert.equal(providerDispatchFeedbackOutcome(500, 'insufficient-balance'), 'insufficient_balance');
  assert.equal(providerDispatchFeedbackOutcome(403, 'concurrency-limited'), 'concurrency_limited');
  assert.equal(providerDispatchFeedbackOutcome(404, 'model-unavailable'), 'rate_limited');
  assert.equal(providerDispatchFeedbackOutcome(402), 'insufficient_balance');
  assert.equal(providerDispatchFeedbackOutcome(402, 'forbidden'), 'insufficient_balance');
});

test('a single 429 does not cool the account; consecutive 429s cool briefly and escalate (H5c)', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'rate_limited' });
  assert.equal(isExcluded(clockMs), false, 'a single routine 429 must not cool');

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'rate_limited' });
  assert.equal(isExcluded(clockMs), true);
  assert.equal(isExcluded(clockMs + 999), true);
  assert.equal(isExcluded(clockMs + 1_000), false, 'the base 429 cooldown is one second');

  clockMs += 1_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'rate_limited' });
  assert.equal(isExcluded(clockMs), true);
  assert.equal(isExcluded(clockMs + 2_000), false, 'the second consecutive cooldown doubles');
});

test('a 401/403 cools immediately, doubles, and caps at 60 seconds (H5c)', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  assert.equal(isExcluded(clockMs), true, 'a revoked credential cools on the first failure');
  assert.equal(isExcluded(clockMs + 9_999), true);
  assert.equal(isExcluded(clockMs + 10_000), false);

  // Batch 2.3 — OAuth 401 second-strike escalation: the second consecutive
  // auth failure jumps straight to the 60 s max cooldown (the sub2api
  // 401-escalated-to-error port; permanence stays with the durable store).
  clockMs += 10_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  assert.equal(isExcluded(clockMs + 59_999), true);
  assert.equal(isExcluded(clockMs + 60_000), false);

  // A success resets the chain: the next auth failure is a fresh first
  // strike (10 s base — the consecutive counter drives the doubling, so
  // without the reset the fourth strike would already cap at 60 s).
  clockMs += 60_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'success' });
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  assert.equal(isExcluded(clockMs + 19_999), false);
  assert.equal(isExcluded(clockMs + 9_999), true, 'a fresh first auth strike cools for the 10 s base');
  // Batch 2.3: the rate_limited outcome between auth failures does NOT
  // itself escalate (the escalation is 401-after-401 only) — the next auth
  // after the rate outcome uses the doubling ladder from its own streak.
  clockMs += 10_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'success' });
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  clockMs += 10_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'rate_limited' });
  clockMs += 2_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  // Auth streak length 2 with a rate in between: the previous outcome was
  // rate_limited, so no escalation — but the consecutive counter (3) puts
  // the doubling ladder at 10 s × 2² = 40 s.
  assert.equal(isExcluded(clockMs + 39_999), true);
  assert.equal(isExcluded(clockMs + 40_000), false);
});

test('a success resets the failure feedback and scopes stay isolated (H5c)', () => {
  const clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs) }), true);

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'success' });
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs) }), false);

  // The next failure starts a fresh count (10 s base, not 20 s).
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs + 10_000) }), false);

  // Tenant-scoped (BYOK) and platform-scoped accounts never share a cooldown.
  const platformAccount = candidate(TENANT_A, account.accountId, 'platform');
  feedback.recordDispatchOutcome({ candidate: platformAccount, outcome: 'auth_or_permission_failure' });
  // The BYOK account keeps its own (still-active) cooldown; the platform
  // account has a fresh, independent one.
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs) }), true);
  assert.equal(feedback.isExcluded({ candidate: platformAccount, now: new Date(clockMs) }), true);
  assert.equal(
    feedback.isExcluded({ candidate: candidate(TENANT_A, 'unrelated-account'), now: new Date(clockMs) }),
    false,
  );

  // Malformed input never throws and never excludes.
  assert.equal(feedback.isExcluded({ candidate: {} as never, now: new Date(clockMs) }), false);
  feedback.recordDispatchOutcome({ candidate: null as never, outcome: 'success' });
});

test('a mid-stream abort cools immediately, doubles, and caps at 30 seconds (K2)', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_abort' });
  assert.equal(isExcluded(clockMs), true, 'a provider that kills a committed stream cools on the first abort');
  assert.equal(isExcluded(clockMs + 4_999), true);
  assert.equal(isExcluded(clockMs + 5_000), false);

  clockMs += 5_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_abort' });
  assert.equal(isExcluded(clockMs + 9_999), true);
  assert.equal(isExcluded(clockMs + 10_000), false, 'the second consecutive abort doubles');

  // A success between aborts resets the count (the provider recovered).
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'success' });
  clockMs += 10_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_abort' });
  assert.equal(isExcluded(clockMs + 5_000), false, 'the fresh count restarts at the 5 s base');
});

test('failures older than the stale window start a fresh consecutive count (H5c)', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  clockMs += 300_001; // past the 5-minute stale window
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'auth_or_permission_failure' });
  // A fresh count means the 10 s base, not the doubled 20 s.
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs + 10_000) }), false);
  assert.equal(feedback.isExcluded({ candidate: account, now: new Date(clockMs + 9_999) }), true);
});

test('batch 2.3: a 402 insufficient-balance cools for 2× the balance-check period and recovers on success', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'insufficient_balance' });
  assert.equal(isExcluded(clockMs), true);
  assert.equal(isExcluded(clockMs + 20 * 60_000 - 1), true);
  assert.equal(isExcluded(clockMs + 20 * 60_000), false, 'the balance cooldown is 2× the 10-minute check period');

  // A successful dispatch clears the cooldown entirely (balance recovered).
  clockMs += 60_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'success' });
  assert.equal(isExcluded(clockMs), false);
});

test('batch 2.3: a Kimi 403 concurrency limit cools for one minute without escalation', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'concurrency_limited' });
  assert.equal(isExcluded(clockMs + 59_999), true);
  assert.equal(isExcluded(clockMs + 60_000), false);
  // The second strike cools for the same minute — no escalation ladder.
  clockMs += 60_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'concurrency_limited' });
  assert.equal(isExcluded(clockMs + 60_000), false);
});

test('batch 2.3: stream timeouts cool only at the threshold inside the window', () => {
  let clockMs = NOW.getTime();
  const feedback = new ProviderAccountDispatchFailureFeedback({ now: () => new Date(clockMs) });
  const account = candidate();
  const isExcluded = (nowMs: number) => feedback.isExcluded({ candidate: account, now: new Date(nowMs) });

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_timeout' });
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_timeout' });
  assert.equal(isExcluded(clockMs), false, 'two timeouts below the threshold of three do not cool');

  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_timeout' });
  assert.equal(isExcluded(clockMs), true, 'the third timeout inside the window cools');
  assert.equal(isExcluded(clockMs + 10 * 60_000 - 1), true);
  assert.equal(isExcluded(clockMs + 10 * 60_000), false);

  // Timeouts older than the window leave the count: after the cooldown, a
  // fresh single timeout does not immediately re-cool.
  clockMs += 11 * 60_000;
  feedback.recordDispatchOutcome({ candidate: account, outcome: 'stream_timeout' });
  assert.equal(isExcluded(clockMs), false);
});

test('batch 2.3: the model rate limit cools the (account, model) pair for 30 minutes only', () => {
  const clockMs = NOW.getTime();
  const modelLimits = new ProviderAccountModelRateLimit({ now: () => new Date(clockMs) });
  const account = candidate();
  const otherAccount = candidate('tenant-a', 'account-b');

  modelLimits.recordModelRateLimit({ candidate: account, model: 'provider-model' });
  assert.equal(
    modelLimits.isModelExcluded({ candidate: account, model: 'provider-model', now: new Date(clockMs) }),
    true,
  );
  assert.equal(
    modelLimits.isModelExcluded({
      candidate: account,
      model: 'provider-model',
      now: new Date(clockMs + 30 * 60_000 - 1),
    }),
    true,
  );
  assert.equal(
    modelLimits.isModelExcluded({ candidate: account, model: 'provider-model', now: new Date(clockMs + 30 * 60_000) }),
    false,
  );
  // The account stays schedulable for every other model.
  assert.equal(
    modelLimits.isModelExcluded({ candidate: account, model: 'another-model', now: new Date(clockMs) }),
    false,
  );
  assert.equal(
    modelLimits.isModelExcluded({ candidate: otherAccount, model: 'provider-model', now: new Date(clockMs) }),
    false,
  );
  // Whitespace and malformed models record nothing.
  modelLimits.recordModelRateLimit({ candidate: account, model: '  ' });
  assert.equal(modelLimits.isModelExcluded({ candidate: account, model: '  ', now: new Date(clockMs) }), false);
});
