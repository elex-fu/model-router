import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { effectiveWeight, isHalfOpenProbeAllowed, recordOutcomeEma } from '../../../src/saas/gateway/health-score.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  type ProviderAccountRuntimeHealthCandidate,
} from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { RequestPreparationCaller } from '../../../src/saas/gateway/request-preparation-service.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleUrls = {
  migrator: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim(),
  control_plane: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL?.trim(),
  gateway: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim(),
};
const anyConfigured = Object.values(roleUrls).some(Boolean);

// Same disposable target contract as the other gateway PostgreSQL gates: the
// designated CI service or an explicit nondefault loopback model_router_test_*
// database, never a user's ordinary local instance.
function disposableRoleTargets(): Record<keyof typeof roleUrls, string> {
  let target: string | undefined;
  const validated = {} as Record<keyof typeof roleUrls, string>;
  for (const role of Object.keys(roleUrls) as Array<keyof typeof roleUrls>) {
    const value = roleUrls[role];
    assert.ok(value, `the disposable gateway E2E ${role} URL is required`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`the disposable gateway E2E ${role} URL must be a valid PostgreSQL URL`);
    }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'the test target must be PostgreSQL');
    assert.equal(decodeURIComponent(parsed.username), `model_router_saas_${role}`);
    assert.equal(parsed.hash, '', 'database URL fragments are not supported');
    assert.equal(parsed.search, '', 'database URLs must not contain connection overrides');
    const hostname = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const ciTarget = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const localTarget =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Boolean(parsed.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(
      ciTarget || localTarget,
      'use the designated CI service or a disposable model_router_saas_ci/model_router_test_* loopback database on an explicit nondefault port',
    );
    const currentTarget = `${hostname}:${port}/${database}`;
    target ??= currentTarget;
    assert.equal(currentTarget, target, 'all three roles must use the same disposable database');
    validated[role] = value;
  }
  return validated;
}

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

interface HealthRow {
  readonly state: string;
  readonly failure_count: number;
  readonly observed_at: Date;
  readonly cooldown_until: Date | null;
  readonly last_outcome: string;
  readonly source_fencing_token: string;
  readonly revision: string;
  readonly health_score: string | null;
  readonly half_open_probe_at: Date | null;
}

const ACCOUNT_A = `r7-account-a-${randomUUID()}`;
const ACCOUNT_B = `r7-account-b-${randomUUID()}`;
const ACCOUNT_C = `r7-account-c-${randomUUID()}`;
const UPSTREAM = `r7-upstream-${randomUUID()}`;

function platformCandidate(accountId: string, tenantId: string): ProviderAccountRuntimeHealthCandidate {
  return {
    tenantId,
    accountId,
    upstreamId: UPSTREAM,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
  } as ProviderAccountRuntimeHealthCandidate;
}

function platformCaller(tenantId: string): RequestPreparationCaller {
  return {
    tenantId,
    projectId: `${tenantId}-project`,
    proxyKeyId: `${tenantId}-key`,
    principalKind: 'member',
    principalId: `${tenantId}-member`,
    entitlementId: `${tenantId}-entitlement`,
    supplyProfileId: `${tenantId}-profile`,
    supplyMode: 'platform',
    modelScopes: ['model'],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
}

async function seedTenant(seed: SaasDatabase): Promise<string> {
  const tenantId = randomUUID();
  const inserted = await seed.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [
    tenantId,
    `r7-health-${tenantId}`,
  ]);
  assert.equal(inserted.rowCount, 1);
  return tenantId;
}

async function seedLease(
  seed: SaasDatabase,
  tenantId: string,
  accountId: string,
): Promise<{ attemptId: string; fencingToken: string }> {
  const attemptId = randomUUID();
  const result = await seed.query<{ fencing_token: string }>(
    `INSERT INTO saas_provider_account_leases
       (id, tenant_id, owner_kind, owner_tenant_id, account_id, upstream_id, attempt_id, slot, lease_expires_at)
     VALUES ($1, $2, 'platform', NULL, $3, $4, $5, 0, clock_timestamp() + interval '5 minutes')
     RETURNING fencing_token::text`,
    [`r7-lease-${randomUUID()}`, tenantId, accountId, UPSTREAM, attemptId],
  );
  assert.equal(result.rows.length, 1);
  return { attemptId, fencingToken: result.rows[0]!.fencing_token };
}

async function healthRow(reader: SaasDatabase, accountId: string): Promise<HealthRow> {
  const result = await reader.query<HealthRow>(
    `SELECT state, failure_count, observed_at, cooldown_until, last_outcome,
            source_fencing_token::text, revision::text, health_score::text, half_open_probe_at
       FROM saas_provider_account_runtime_health
      WHERE owner_scope_key = 'platform' AND account_id = $1 AND owner_kind = 'platform'`,
    [accountId],
  );
  assert.equal(result.rows.length, 1, 'exactly one platform-scoped health row required');
  return result.rows[0]!;
}

test('restricted gateway role writes EMA health scores and admits single half-open probes', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three disposable gateway E2E role URLs to require this gate`
      : false,
  timeout: 120_000,
}, async (t) => {
  const urls = disposableRoleTargets();
  const migrator = createSaasDatabase({ connectionString: urls.migrator, max: 2 });
  const control = createSaasDatabase({ connectionString: urls.control_plane, max: 1 });
  const gateway = createSaasDatabase({ connectionString: urls.gateway, max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.close(), control.close(), gateway.close()]);
  });
  await migrator.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
  await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  const identity = (await gateway.query<{ role: string }>('SELECT current_user AS role')).rows[0];
  assert.equal(identity?.role, 'model_router_saas_gateway');

  const tenantId = await seedTenant(migrator);
  const store = new PostgresProviderAccountRuntimeHealthStore({ database: gateway });
  const candidateA = platformCandidate(ACCOUNT_A, tenantId);
  const caller = platformCaller(tenantId);

  // Failure outcomes apply EMA steps in the same write as the unchanged
  // binary transition; the row guard accepts every write.
  const lease1 = await seedLease(migrator, tenantId, ACCOUNT_A);
  assert.equal(
    await store.recordRuntimeOutcome({
      candidate: candidateA,
      attemptId: lease1.attemptId,
      fencingToken: lease1.fencingToken,
      evidence: { source: 'gateway', result: 'retryable_failure', failureKind: 'network' },
    }),
    'applied',
  );
  let row = await healthRow(migrator, ACCOUNT_A);
  assert.equal(row.state, 'cooldown');
  assert.equal(row.failure_count, 1);
  assert.equal(row.health_score, '0.800', 'first failure applies one EMA step from the optimistic 1.000 seed');
  assert.equal(row.half_open_probe_at, null);
  assert.equal(row.revision, '1');
  const firstCooldownMs = row.cooldown_until!.getTime() - row.observed_at.getTime();
  assert.equal(firstCooldownMs, 1000, 'binary cooldown expression unchanged');

  const lease2 = await seedLease(migrator, tenantId, ACCOUNT_A);
  await store.recordRuntimeOutcome({
    candidate: candidateA,
    attemptId: lease2.attemptId,
    fencingToken: lease2.fencingToken,
    evidence: { source: 'gateway', result: 'retryable_failure', failureKind: 'provider_5xx' },
  });
  row = await healthRow(migrator, ACCOUNT_A);
  assert.equal(row.failure_count, 2);
  assert.equal(row.health_score, '0.640');
  assert.equal(row.cooldown_until!.getTime() - row.observed_at.getTime(), 2000);

  const lease3 = await seedLease(migrator, tenantId, ACCOUNT_A);
  await store.recordRuntimeOutcome({
    candidate: candidateA,
    attemptId: lease3.attemptId,
    fencingToken: lease3.fencingToken,
    evidence: { source: 'gateway', result: 'success' },
  });
  row = await healthRow(migrator, ACCOUNT_A);
  assert.equal(row.state, 'healthy');
  assert.equal(row.failure_count, 0);
  assert.equal(row.cooldown_until, null);
  assert.equal(row.health_score, '0.712', 'SQL EMA matches recordOutcomeEma(0.64, success)');
  assert.equal(recordOutcomeEma(0.64, 'success'), 0.712);

  // The scheduling view exposes the score to the restricted gateway role.
  const view = await store.getSchedulingView({ caller, candidate: candidateA, now: new Date() });
  assert.equal(view.decision, 'allow');
  if (view.decision === 'allow') {
    assert.equal(view.value.status, 'healthy');
    assert.equal(view.value.healthScore, 0.712);
    assert.equal(view.value.consecutiveFailures, 0);
    assert.equal(effectiveWeight(100, view.value.healthScore), 71);
  }

  // Half-open: seed an expired-cooldown row (migrator only seeds; all
  // guarded writes below run as the restricted gateway role).
  const seededAt = await migrator.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const reference = seededAt.rows[0]!.now;
  const seeded = await migrator.query(
    `INSERT INTO saas_provider_account_runtime_health
       (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
        observed_at, cooldown_until, last_outcome, source_fencing_token, revision, health_score)
     VALUES ('platform', 'platform', NULL, $1, 'cooldown', 3, $2, $3,
             'gateway_network_failure', 1, 1, 0.500)`,
    [ACCOUNT_B, new Date(reference.getTime() - 10_000), new Date(reference.getTime() - 5_000)],
  );
  assert.equal(seeded.rowCount, 1);

  const candidateB = platformCandidate(ACCOUNT_B, tenantId);
  assert.equal(await store.tryAdmitHalfOpenProbe({ candidate: candidateB }), 'admitted');
  row = await healthRow(migrator, ACCOUNT_B);
  assert.ok(row.half_open_probe_at, 'admission stamps the probe timestamp');
  assert.equal(row.revision, '2');
  const admissionFence = BigInt(row.source_fencing_token);
  assert.ok(admissionFence > 1n, 'the admission fence is a fresh fencing-sequence draw');
  // Every binary column and the score stay byte-for-byte identical.
  assert.equal(row.state, 'cooldown');
  assert.equal(row.failure_count, 3);
  assert.equal(row.cooldown_until!.getTime(), reference.getTime() - 5_000);
  assert.equal(row.observed_at.getTime(), reference.getTime() - 10_000);
  assert.equal(row.last_outcome, 'gateway_network_failure');
  assert.equal(row.health_score, '0.500');

  // The pure gate agrees with the authoritative row shape.
  assert.equal(
    isHalfOpenProbeAllowed({
      cooldownUntil: row.cooldown_until,
      halfOpenProbeAt: row.half_open_probe_at,
      observedAt: row.observed_at,
      now: new Date(),
    }),
    false,
    'the admitted probe is in flight, so a second probe is not allowed',
  );

  // A concurrent second admission loses while the probe is in flight.
  assert.equal(await store.tryAdmitHalfOpenProbe({ candidate: candidateB }), 'closed');

  // The probe dispatch lease is acquired after the admission, so its token
  // is strictly greater and the lease-authorized outcome write applies.
  const lease4 = await seedLease(migrator, tenantId, ACCOUNT_B);
  assert.ok(
    BigInt(lease4.fencingToken) > admissionFence,
    'the post-admission lease token is newer than the admission fence',
  );
  assert.equal(
    await store.recordRuntimeOutcome({
      candidate: candidateB,
      attemptId: lease4.attemptId,
      fencingToken: lease4.fencingToken,
      evidence: { source: 'probe', result: 'success' },
    }),
    'applied',
  );
  row = await healthRow(migrator, ACCOUNT_B);
  assert.equal(row.state, 'healthy');
  assert.equal(row.failure_count, 0);
  assert.equal(row.cooldown_until, null);
  assert.equal(row.health_score, '0.600', 'SQL EMA matches recordOutcomeEma(0.5, success)');
  assert.ok(row.half_open_probe_at, 'the probe admission timestamp is kept as history');
});

test('restricted gateway role faces 42501 on identity mutation and row removal, 23514 on score range', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three disposable gateway E2E role URLs to require this gate`
      : false,
  timeout: 120_000,
}, async (t) => {
  const urls = disposableRoleTargets();
  const migrator = createSaasDatabase({ connectionString: urls.migrator, max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls.gateway, max: 2 });
  t.after(async () => {
    await Promise.allSettled([migrator.close(), gateway.close()]);
  });
  const tenantId = await seedTenant(migrator);
  const store = new PostgresProviderAccountRuntimeHealthStore({ database: gateway });
  const lease = await seedLease(migrator, tenantId, ACCOUNT_C);
  await store.recordRuntimeOutcome({
    candidate: platformCandidate(ACCOUNT_C, tenantId),
    attemptId: lease.attemptId,
    fencingToken: lease.fencingToken,
    evidence: { source: 'gateway', result: 'success' },
  });

  // Row removal is not granted at all (the no-delete trigger never fires).
  const removal = await gateway
    .query('DELETE FROM saas_provider_account_runtime_health WHERE account_id = $1', [ACCOUNT_C])
    .then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );
  assert.equal(removal, '42501');

  // Identity columns carry no UPDATE grant for the gateway role.
  const identityMutation = await gateway
    .query("UPDATE saas_provider_account_runtime_health SET owner_scope_key = 'platform-x' WHERE account_id = $1", [
      ACCOUNT_C,
    ])
    .then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );
  assert.equal(identityMutation, '42501');

  // The score range CHECK rejects out-of-range writes even when the guard
  // trigger fields are advanced correctly.
  const current = await healthRow(migrator, ACCOUNT_C);
  const outOfRange = await gateway
    .query(
      `UPDATE saas_provider_account_runtime_health
        SET health_score = 1.5,
            source_fencing_token = $2::bigint,
            revision = $3::bigint
      WHERE account_id = $1`,
      [ACCOUNT_C, String(BigInt(current.source_fencing_token) + 1n), String(BigInt(current.revision) + 1n)],
    )
    .then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );
  assert.equal(outOfRange, '23514');

  // The negative probes left the row untouched.
  const after = await healthRow(migrator, ACCOUNT_C);
  assert.equal(after.health_score, current.health_score);
  assert.equal(after.revision, current.revision);
  assert.equal(after.source_fencing_token, current.source_fencing_token);
});
