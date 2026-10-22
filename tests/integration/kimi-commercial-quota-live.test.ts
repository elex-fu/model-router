import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import {
  KIMI_COMMERCIAL_REQUIRED,
  KIMI_COMMERCIAL_URLS,
  type KimiCommercialFixture,
  provisionKimiCommercialFixture,
  startBuiltCli,
  waitUntil,
} from '../../scripts/ops/verify-commercial-kimi.js';

// The supervisor supplies an ephemeral key and a runner-owned PostgreSQL 18
// database. The standard built worker performs its onboarding probe and quota
// GET using the sealed credential; this test never calls the provider itself.
// RUN_KIMI_COMMERCIAL_LIVE=1 node scripts/run-commercial-postgres-gate.mjs
//   --test-file tests/integration/kimi-commercial-quota-live.test.ts --worker-role
const enabled = process.env[KIMI_COMMERCIAL_REQUIRED] === '1';

type Stage = 'preflight' | 'provision' | 'initial-snapshot' | 'onboarding' | 'quota-poll' | 'cleanup';
type FailureCode = 'assertion' | 'operation' | '42501' | '42703' | '42P01' | '28P01' | '57014';

interface QuotaSnapshot {
  fiveHourUsedPercent: number | null;
  fiveHourResetAtMs: number | null;
  weeklyUsedPercent: number | null;
  weeklyResetAtMs: number | null;
  attemptedAtMs: number | null;
  succeededAtMs: number | null;
  nextDueAtMs: number | null;
  failureCount: number | null;
  rateLimitedUntilMs: number | null;
}

function failureCode(error: unknown): FailureCode {
  if (error instanceof assert.AssertionError) return 'assertion';
  const code: unknown =
    error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  switch (code) {
    case '42501':
    case '42703':
    case '42P01':
    case '28P01':
    case '57014':
      return code;
    default:
      return 'operation';
  }
}

function numericOrNull(value: unknown): number | null {
  if (value === null) return null;
  assert.ok(typeof value === 'number' && Number.isFinite(value), 'Quota observer requires finite numbers or null');
  return value;
}

async function readQuotaSnapshot(fixture: KimiCommercialFixture): Promise<QuotaSnapshot> {
  // Only the restricted control-plane connection observes quota. Do not read
  // credential envelopes, provider response bodies, or arbitrary error text.
  const result = await fixture.controlPlaneDatabase.query<Record<keyof QuotaSnapshot, unknown>>(
    `SELECT kimi_5h_used_percent AS "fiveHourUsedPercent",
            (EXTRACT(EPOCH FROM kimi_5h_reset_at) * 1000)::double precision AS "fiveHourResetAtMs",
            kimi_weekly_used_percent AS "weeklyUsedPercent",
            (EXTRACT(EPOCH FROM kimi_weekly_reset_at) * 1000)::double precision AS "weeklyResetAtMs",
            (EXTRACT(EPOCH FROM kimi_usage_attempted_at) * 1000)::double precision AS "attemptedAtMs",
            (EXTRACT(EPOCH FROM kimi_usage_updated_at) * 1000)::double precision AS "succeededAtMs",
            (EXTRACT(EPOCH FROM kimi_usage_next_due_at) * 1000)::double precision AS "nextDueAtMs",
            kimi_usage_failure_count AS "failureCount",
            (EXTRACT(EPOCH FROM kimi_rate_limited_until) * 1000)::double precision AS "rateLimitedUntilMs"
       FROM saas_platform_provider_accounts
      WHERE id = $1 AND provider_id = 'kimi' AND product_id = 'kimi-code' AND credential_type = 'api-key'`,
    [fixture.accountId],
  );
  assert.equal(result.rows.length, 1, 'Quota observer must select exactly its own Kimi Coding account');
  const row = result.rows[0];
  return {
    fiveHourUsedPercent: numericOrNull(row.fiveHourUsedPercent),
    fiveHourResetAtMs: numericOrNull(row.fiveHourResetAtMs),
    weeklyUsedPercent: numericOrNull(row.weeklyUsedPercent),
    weeklyResetAtMs: numericOrNull(row.weeklyResetAtMs),
    attemptedAtMs: numericOrNull(row.attemptedAtMs),
    succeededAtMs: numericOrNull(row.succeededAtMs),
    nextDueAtMs: numericOrNull(row.nextDueAtMs),
    failureCount: numericOrNull(row.failureCount),
    rateLimitedUntilMs: numericOrNull(row.rateLimitedUntilMs),
  };
}

function assertWorkerRunning(worker: ChildProcess): void {
  assert.ok(worker.exitCode === null && worker.signalCode === null, 'The owned built CLI worker must remain running');
}

async function waitVerified(fixture: KimiCommercialFixture, worker: ChildProcess): Promise<void> {
  await waitUntil(
    'Restricted Kimi credential onboarding',
    async () => {
      assertWorkerRunning(worker);
      const result = await fixture.controlPlaneDatabase.query<{
        account_status: unknown;
        account_validation: unknown;
        credential_status: unknown;
        credential_validation: unknown;
        job_status: unknown;
        attempt_count: unknown;
      }>(
        `SELECT a.status AS account_status, a.validation_state AS account_validation,
                c.status AS credential_status, c.validation_state AS credential_validation,
                j.status AS job_status, j.attempt_count
           FROM saas_platform_provider_accounts a
           JOIN saas_platform_provider_credentials c ON c.account_id = a.id AND c.id = $2
           JOIN saas_platform_provider_credential_validation_jobs j
             ON j.account_id = a.id AND j.credential_id = c.id AND j.credential_version = c.current_version
          WHERE a.id = $1`,
        [fixture.accountId, fixture.credentialId],
      );
      assert.equal(result.rows.length, 1, 'Import must create exactly one current credential validation job');
      const row = result.rows[0];
      assert.ok(
        row.attempt_count === 0 || row.attempt_count === 1,
        'Automatic onboarding must finish within its first bounded probe',
      );
      assert.notEqual(row.job_status, 'failed', 'Automatic onboarding failed');
      assert.notEqual(row.job_status, 'cancelled', 'Automatic onboarding was cancelled');
      assert.ok(!(row.job_status === 'queued' && row.attempt_count === 1), 'Automatic onboarding entered a retry');
      if (row.job_status !== 'verified') return undefined;
      assert.equal(row.account_status, 'active');
      assert.equal(row.account_validation, 'verified');
      assert.equal(row.credential_status, 'active');
      assert.equal(row.credential_validation, 'verified');
      assert.equal(row.attempt_count, 1);
      return true;
    },
    75_000,
  );
}

test('built CLI Kimi quota: sealed credential reaches fresh five-hour and weekly snapshots through the standard CN loop', {
  skip: !enabled ? `Set ${KIMI_COMMERCIAL_REQUIRED}=1 with the disposable PostgreSQL runner to opt in` : false,
  timeout: 240_000,
}, async (t) => {
  let fixture: KimiCommercialFixture | undefined;
  let worker: ChildProcess | undefined;
  let stage: Stage = 'preflight';
  let failure: { stage: Stage; code: FailureCode } | undefined;
  let initialSnapshotEmpty = 0;
  let activeVerified = 0;
  let quotaObserved = 0;
  let observationAgeMs = 0;
  let snapshot: QuotaSnapshot | undefined;
  try {
    const credential = process.env.KIMI_CODE_API_KEY;
    assert.ok(credential, 'KIMI_CODE_API_KEY must be supplied ephemerally by the live-test supervisor');
    for (const name of Object.values(KIMI_COMMERCIAL_URLS)) {
      assert.ok(process.env[name], 'Every restricted role URL must identify the disposable runner-owned database');
    }
    stage = 'provision';
    fixture = await provisionKimiCommercialFixture(credential);
    const live = fixture;
    stage = 'initial-snapshot';
    const role = await live.controlPlaneDatabase.query<{ current_user: unknown }>('SELECT current_user');
    assert.equal(role.rows[0]?.current_user, 'model_router_saas_control_plane');
    for (const value of Object.values(await readQuotaSnapshot(live))) {
      assert.equal(value, null, 'A new account must have no quota observation or poll attempt');
    }
    initialSnapshotEmpty = 1;
    const workerStartedAtMs = Date.now();
    stage = 'onboarding';
    worker = startBuiltCli(live, 'credential-validation-worker');
    const ownedWorker = worker;
    assert.equal(live.started.length, 1, 'Quota acceptance must start only its credential worker');
    await waitVerified(live, ownedWorker);
    activeVerified = 1;
    stage = 'quota-poll';
    snapshot = await waitUntil(
      'Standard CN Kimi quota persistence',
      async () => {
        assertWorkerRunning(ownedWorker);
        const row = await readQuotaSnapshot(live);
        snapshot = row;
        assert.ok(row.failureCount === null || row.failureCount === 0, 'Stop after the first failed real quota poll');
        assert.equal(row.rateLimitedUntilMs, null, 'The first real quota poll must not be rate limited');
        if (row.succeededAtMs === null) return undefined;
        return row;
      },
      90_000,
    );
    for (const percent of [snapshot.fiveHourUsedPercent, snapshot.weeklyUsedPercent]) {
      assert.ok(percent !== null && percent >= 0 && percent <= 100, 'Both Kimi windows require valid percentages');
    }
    assert.ok(snapshot.succeededAtMs !== null && snapshot.succeededAtMs >= workerStartedAtMs);
    observationAgeMs = Date.now() - snapshot.succeededAtMs;
    assert.ok(observationAgeMs >= 0 && observationAgeMs <= 15_000, 'The first observed quota success must be fresh');
    assert.ok(
      snapshot.attemptedAtMs !== null &&
        snapshot.attemptedAtMs >= workerStartedAtMs &&
        snapshot.attemptedAtMs <= snapshot.succeededAtMs,
      'A real claimed quota attempt must precede its successful observation',
    );
    for (const resetAt of [snapshot.fiveHourResetAtMs, snapshot.weeklyResetAtMs]) {
      assert.ok(resetAt !== null && resetAt > snapshot.succeededAtMs, 'Both Kimi reset bounds must remain valid');
    }
    assert.ok(snapshot.nextDueAtMs !== null && snapshot.nextDueAtMs > snapshot.succeededAtMs);
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.rateLimitedUntilMs, null);
    quotaObserved = 1;
  } catch (error) {
    failure = { stage, code: failureCode(error) };
  } finally {
    stage = 'cleanup';
    if (fixture) {
      try {
        // Reaching the first success proceeds directly here. There is no
        // gateway, pool membership, dispatch, or second quota request.
        await fixture.close();
        assert.ok(
          fixture.started.every((child) => child.exitCode !== null || child.signalCode !== null),
          'Every fixture-owned CLI child must stop during cleanup',
        );
        assert.ok(worker && (worker.exitCode !== null || worker.signalCode !== null), 'The owned worker must stop');
      } catch (error) {
        failure ??= { stage, code: failureCode(error) };
      }
    }
    // Only fixed enums and numeric projections reach TAP. Never forward an
    // exception message/cause, arbitrary CLI output, credential, or HTTP body.
    t.diagnostic(
      JSON.stringify({
        schema: 1,
        mode: 'built-cli-persisted-encrypted-credential',
        readerRole: 'model_router_saas_control_plane',
        result: failure ? 'failed' : 'passed',
        failedStage: failure?.stage ?? 'none',
        failureCode: failure?.code ?? 'none',
        initialSnapshotEmpty,
        activeVerified,
        quotaObserved,
        fiveHourUsedPercent: snapshot?.fiveHourUsedPercent ?? 0,
        fiveHourResetAtMs: snapshot?.fiveHourResetAtMs ?? 0,
        weeklyUsedPercent: snapshot?.weeklyUsedPercent ?? 0,
        weeklyResetAtMs: snapshot?.weeklyResetAtMs ?? 0,
        attemptedAtMs: snapshot?.attemptedAtMs ?? 0,
        succeededAtMs: snapshot?.succeededAtMs ?? 0,
        nextDueAtMs: snapshot?.nextDueAtMs ?? 0,
        failureCount: snapshot?.failureCount ?? 0,
        rateLimitedUntilMs: snapshot?.rateLimitedUntilMs ?? 0,
        observationAgeMs,
        ownedChildren: fixture?.started.length ?? 0,
        ownedWorkerStopped: worker && (worker.exitCode !== null || worker.signalCode !== null) ? 1 : 0,
      }),
    );
  }
  if (failure) throw new Error(`Kimi quota acceptance failed: ${failure.stage}/${failure.code}`);
});
