import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import { getAccountWindowStatsBatch } from '../../../src/saas/gateway/postgres-provider-account-window-stats.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import {
  PostgresProviderQuotaSnapshotStore,
  resolveQuotaSnapshotAccountOwner,
} from '../../../src/saas/supply/provider-account-quota-snapshot-store-postgres.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { type Fixture, seedFixture } from '../metering/normal-success-postgres-fixture.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
  cancellationSqlState,
} from './pre-dispatch-postgres-fixture.js';

type Mode = 'byok' | 'platform';

const WORKER_ROLE_URL = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL';

async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    const state = cancellationSqlState(error);
    const domain =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown';
    // Never retain a raw driver error/cause/message/detail/stack or parameters.
    const safe = new Error(`R-dormant gate phase=${name} code=${domain}${state ? ` sqlState=${state}` : ''}`);
    safe.stack = undefined;
    throw safe;
  }
}

function candidateAuthority(
  fixture: Fixture,
  mode: Mode,
  pool?: {
    readonly poolId: string;
    readonly poolAuthzVersion: number;
    readonly poolMemberAccountAuthzVersion: number;
    readonly poolMemberAuthzVersion: number;
    readonly poolGrantAuthzVersion: number;
    readonly poolGrantProfileAuthzVersion: number;
    readonly poolGrantPoolAuthzVersion: number;
  },
): RequestPreparationCandidateAuthority {
  const sent = fixture.sent;
  const common = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    supplyProfileId: fixture.profileId,
    supplyMode: mode,
    accountId: sent.accountId,
    upstreamId: sent.upstreamId,
    credentialId: sent.credentialId,
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    dispatchProfileId: sent.dispatchProfileId,
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    resolvedModel: sent.resolvedModel,
    protocol: 'openai' as const,
    endpoint: sent.endpoint,
    supplierCostVersion: sent.supplierCostVersion,
    providerId: sent.providerId,
    productId: sent.productId,
  };
  if (mode === 'byok') {
    return {
      ...common,
      accountOwnerKind: 'tenant',
      profileAccountAuthzVersion: Number(sent.profileAccountAuthzVersion as string),
    } as RequestPreparationCandidateAuthority;
  }
  assert.ok(pool, 'platform candidates need the route-aligned pool facts');
  return {
    ...common,
    accountOwnerKind: 'platform',
    poolId: pool.poolId,
    poolAuthzVersion: pool.poolAuthzVersion,
    poolMemberAccountAuthzVersion: pool.poolMemberAccountAuthzVersion,
    poolMemberAuthzVersion: pool.poolMemberAuthzVersion,
    poolGrantAuthzVersion: pool.poolGrantAuthzVersion,
    poolGrantProfileAuthzVersion: pool.poolGrantProfileAuthzVersion,
    poolGrantPoolAuthzVersion: pool.poolGrantPoolAuthzVersion,
  } as RequestPreparationCandidateAuthority;
}

interface PlatformPoolFacts {
  readonly poolId: string;
  readonly poolAuthzVersion: number;
  readonly poolMemberAccountAuthzVersion: number;
  readonly poolMemberAuthzVersion: number;
  readonly poolGrantAuthzVersion: number;
  readonly poolGrantProfileAuthzVersion: number;
  readonly poolGrantPoolAuthzVersion: number;
}

async function alignPlatformPool(
  migrator: { query: SqlExecutor['query'] },
  fixture: Fixture,
): Promise<PlatformPoolFacts> {
  const account = (
    await migrator.query<{ rights_id: string; rights_version: string; authz_version: string }>(
      'SELECT rights_id, rights_version::text AS rights_version, authz_version::text AS authz_version FROM saas_platform_provider_accounts WHERE id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  assert.ok(account, 'seeded platform account must exist');
  const capability = (
    await migrator.query<{ capability_version: string }>(
      'SELECT capability_version::text AS capability_version FROM saas_platform_provider_account_capabilities WHERE account_id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  assert.ok(capability, 'seeded platform account capability must exist');
  const providerId = fixture.sent.providerId;
  const productId = fixture.sent.productId;
  const endpoint = fixture.sent.endpoint;
  const resolvedModel = fixture.sent.resolvedModel;
  const accountId = fixture.sent.accountId;
  assert.ok(
    providerId !== null && productId !== null && endpoint !== null && resolvedModel !== null && accountId !== null,
    'seeded dispatch fields must be present',
  );
  const supply = new ProviderSupplyService(migrator as never, {
    deployment: 'rdormant-test',
    environment: 'test',
    kmsKeyId: 'rdormant-synthetic-kms',
    sealingKms: {
      generateDataKey: async () => ({
        plaintextKey: Buffer.alloc(32, 0x57),
        ciphertextBlob: Buffer.from('rdormant-synthetic-dek'),
      }),
    },
  });
  const pool = await supply.createPlatformProviderPool({
    id: fixture.sent.upstreamId,
    displayName: 'R-dormant route-aligned pool',
    providerId,
    productId,
    credentialType: 'api-key',
    region: 'test',
    purpose: 'inference',
    rightsId: account.rights_id,
    rightsVersion: Number(account.rights_version),
    capabilities: [{ model: resolvedModel, endpoint, version: Number(capability.capability_version) }],
    status: 'active',
    validationState: 'verified',
  });
  await supply.addPlatformPoolMember({
    poolId: pool.id,
    accountId,
    expectedAccountAuthzVersion: Number(account.authz_version),
  });
  const grant = await supply.grantPlatformPoolToProfile({
    poolId: pool.id,
    tenantId: fixture.tenantId,
    supplyProfileId: fixture.profileId,
    evidenceReference: `rdormant-grant-${randomUUID()}`,
    evidenceSha256: 'd'.repeat(64),
  });
  return {
    poolId: pool.id,
    poolAuthzVersion: pool.authzVersion,
    poolMemberAccountAuthzVersion: Number(account.authz_version),
    poolMemberAuthzVersion: 1,
    poolGrantAuthzVersion: grant.authzVersion,
    poolGrantProfileAuthzVersion: grant.profileAuthzVersion,
    poolGrantPoolAuthzVersion: grant.poolAuthzVersion,
  };
}

interface PauseRow {
  readonly scheduling_threshold_pause_until: Date | null;
  readonly scheduling_threshold_pause_reason: unknown;
}

async function readPause(
  executor: { query: SqlExecutor['query'] },
  table: string,
  accountId: string,
): Promise<PauseRow | null> {
  const result = await executor.query<PauseRow>(
    `SELECT scheduling_threshold_pause_until, scheduling_threshold_pause_reason FROM ${table} WHERE id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

test('R-dormant scheduling-threshold pause drives selection eligibility on real PG (restricted gateway role)', {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and all disposable E2E role URLs`
      : false,
  timeout: 300_000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: threshold breach pauses until the window reset; idempotent; expiry restores`, async () => {
        const table = mode === 'byok' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
        const scope = mode === 'byok' ? ('tenant' as const) : ('platform' as const);
        const fixture = await phase('seed', () => seedFixture(migrator, gateway, mode));
        const accountId = fixture.sent.accountId;
        assert.ok(accountId !== null, 'seeded account id must be present');
        const pool =
          mode === 'platform' ? await phase('pool-align', () => alignPlatformPool(migrator, fixture)) : undefined;
        const alias = (
          await phase('alias', () =>
            gateway.query<{ public_model: string }>(
              'SELECT public_model FROM saas_requests WHERE tenant_id = $1 AND id = $2',
              [fixture.tenantId, fixture.input.requestId],
            ),
          )
        ).rows[0]?.public_model;
        assert.ok(alias !== undefined && alias !== '');
        // Supply-owner setup seeds the health row; the gateway never writes it.
        await phase('health-seed', () =>
          migrator.query(
            `INSERT INTO saas_provider_account_runtime_health
                 (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
                  observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
               VALUES ($1, $2, $3, $4, 'healthy', 0, clock_timestamp(), NULL, 'gateway_success', 1, 1)`,
            [
              mode === 'byok' ? fixture.tenantId : 'platform',
              scope,
              mode === 'byok' ? fixture.tenantId : null,
              accountId,
            ],
          ),
        );

        const scheduler = new PostgresProviderAccountScheduler({
          database: gateway,
          leaseConcurrencyLimit: 2,
          health: new PostgresProviderAccountRuntimeHealthStore({ database: gateway, maxHealthAgeMs: 300_000 }),
          maxHealthAgeMs: 300_000,
        });
        const select = (requestId: string) =>
          scheduler.select({
            requestId,
            caller: {
              tenantId: fixture.tenantId,
              projectId: fixture.projectId,
              proxyKeyId: fixture.keyId,
              principalKind: 'member',
              principalId: fixture.userId,
              entitlementId: fixture.entitlementId,
              supplyProfileId: fixture.profileId,
              supplyMode: mode,
              modelScopes: [alias],
              authzVersion: 1,
              entitlementVersion: 1,
              supplyProfileVersion: 1,
              modelScopeVersion: 1,
            },
            entitlement: {
              tenantId: fixture.tenantId,
              projectId: fixture.projectId,
              proxyKeyId: fixture.keyId,
              entitlementId: fixture.entitlementId,
              entitlementVersion: 1,
              supplyProfileId: fixture.profileId,
              supplyProfileVersion: 1,
              supplyMode: mode,
              modelScopeVersion: 1,
              allowedModels: [alias],
              allowedProviderIds: mode === 'byok' ? [fixture.sent.providerId as string] : [],
              projectPolicyVersion: Number(fixture.sent.projectPolicyVersion as string),
            },
            candidates: [candidateAuthority(fixture, mode, pool)],
            publicModel: alias,
            protocol: 'openai',
          });

        // Dormant default: no thresholds configured — the selection allows
        // and no pause is written (the golden-fixture red line on real PG).
        const before = await phase('select-before', () => select(`rdormant-${randomUUID()}`));
        assert.equal(before.decision, 'allow', 'no threshold configured keeps the account eligible');
        const pauseBefore = await phase('pause-before', () => readPause(migrator, table, accountId));
        assert.ok(pauseBefore !== null);
        assert.equal(pauseBefore.scheduling_threshold_pause_until, null);
        assert.equal(pauseBefore.scheduling_threshold_pause_reason, null);

        // Arm the threshold: a fresh codex snapshot at 95% with a reset one
        // hour out, against a 90% 5h auto-pause threshold.
        const resetAt = new Date(Date.now() + 60 * 60 * 1000);
        await phase('arm', () =>
          migrator.query(
            `UPDATE ${table}
                SET codex_5h_used_percent = 95,
                    codex_5h_reset_at = $2::timestamptz,
                    codex_usage_updated_at = clock_timestamp(),
                    auto_pause_5h_threshold = 90
              WHERE id = $1`,
            [accountId, resetAt.toISOString()],
          ),
        );
        const denied = await phase('select-denied', () => select(`rdormant-${randomUUID()}`));
        assert.equal(denied.decision, 'reject', 'a window at or above its threshold removes the only candidate');
        if (denied.decision === 'reject') assert.equal(denied.code, 'account_denied');
        const paused = await phase('pause-written', () => readPause(migrator, table, accountId));
        assert.ok(paused !== null && paused.scheduling_threshold_pause_until !== null);
        assert.ok(
          Math.abs(paused.scheduling_threshold_pause_until.getTime() - resetAt.getTime()) <= 1000,
          'the pause runs to the window reset',
        );
        const reason = paused.scheduling_threshold_pause_reason as Record<string, unknown>;
        assert.equal(reason.source, 'account_scheduling_threshold');
        assert.equal(reason.platform, 'codex');
        assert.equal(reason.window, '5h');
        assert.equal(reason.threshold_percent, 90);
        assert.ok(Math.abs(Number(reason.used_percent) - 95) < 1e-9);

        // Idempotency: an identical re-evaluation writes nothing — the
        // persisted reason (including triggered_at) is byte-identical.
        const deniedAgain = await phase('select-denied-again', () => select(`rdormant-${randomUUID()}`));
        assert.equal(deniedAgain.decision, 'reject');
        const pausedAgain = await phase('pause-again', () => readPause(migrator, table, accountId));
        assert.ok(pausedAgain !== null);
        assert.deepEqual(
          pausedAgain.scheduling_threshold_pause_reason,
          reason,
          'an identical re-evaluation must not rewrite the reason',
        );
        assert.equal(
          Math.floor(new Date(pausedAgain.scheduling_threshold_pause_until as Date).getTime() / 1000),
          Math.floor(new Date(paused.scheduling_threshold_pause_until as Date).getTime() / 1000),
        );

        // The pause write never shortens: a manually longer deadline survives
        // a re-evaluation that computes the original (shorter) one.
        const longerUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await phase('extend', () =>
          migrator.query(`UPDATE ${table} SET scheduling_threshold_pause_until = $2::timestamptz WHERE id = $1`, [
            accountId,
            longerUntil.toISOString(),
          ]),
        );
        await phase('select-extended', () => select(`rdormant-${randomUUID()}`));
        const afterExtend = await phase('pause-extended', () => readPause(migrator, table, accountId));
        assert.ok(afterExtend !== null && afterExtend.scheduling_threshold_pause_until !== null);
        assert.ok(
          Math.abs(afterExtend.scheduling_threshold_pause_until.getTime() - longerUntil.getTime()) <= 1000,
          'a live pause is only ever extended, never shortened',
        );

        // Expiry recovery: an elapsed pause restores eligibility naturally.
        // The threshold is cleared together with the deadline so the lazy
        // evaluator computes no new pause (the natural operator recovery:
        // thresholds and snapshots are re-armed by the quota pipeline).
        await phase('expire', () =>
          migrator.query(
            `UPDATE ${table}
                SET scheduling_threshold_pause_until = clock_timestamp() - interval '1 second',
                    auto_pause_5h_threshold = NULL
              WHERE id = $1`,
            [accountId],
          ),
        );
        const expired = await phase('select-expired', () => select(`rdormant-${randomUUID()}`));
        assert.equal(expired.decision, 'allow', 'an elapsed pause restores eligibility');

        // The window-cost batch aggregation runs under the gateway role
        // without error (zero consumption reads as an empty map).
        const stats = await phase('window-stats', () =>
          getAccountWindowStatsBatch(gateway, [accountId], Date.now() - 60 * 60 * 1000),
        );
        assert.ok(stats instanceof Map);
      });
    }

    await t.test('the quota snapshot store writes every family under the validation-worker role', async () => {
      const workerUrl = process.env[WORKER_ROLE_URL]?.trim();
      if (workerUrl === undefined || workerUrl === '') {
        assert.ok(false, `${WORKER_ROLE_URL} is required; the worker-role store gate cannot skip in a configured run`);
      }
      const worker = createSaasDatabase({ connectionString: workerUrl, max: 1 });
      try {
        const fixture = await phase('seed-worker', () => seedFixture(migrator, gateway, 'platform'));
        const accountId = fixture.sent.accountId;
        assert.ok(accountId !== null);
        const table = 'saas_platform_provider_accounts';
        // Owner resolution maps the neutral id onto the platform row.
        const owner = await phase('resolve-owner', () => resolveQuotaSnapshotAccountOwner(worker, accountId));
        assert.ok(owner !== null);
        assert.equal(owner.ownerKind, 'platform');
        assert.equal(owner.accountId, accountId);

        const store = new PostgresProviderQuotaSnapshotStore(worker);
        const observedAt = Date.now();
        await phase('write-codex', () =>
          store.writeCodexSnapshot(
            owner,
            {
              used5hPercent: 42.5,
              reset5hSeconds: 1800,
              window5hMinutes: 300,
              used7dPercent: 12,
              reset7dSeconds: 400_000,
              window7dMinutes: 10080,
            },
            observedAt,
          ),
        );
        await phase('write-claude', () =>
          store.writeClaudeSnapshot(
            owner,
            {
              observedAtMs: observedAt,
              windows: [
                {
                  window: '5h',
                  status: 'allowed',
                  utilization: 0.31,
                  surpassedThreshold: false,
                  resetAtMs: observedAt + 3 * 60 * 60 * 1000,
                  exhausted: false,
                  rejected: false,
                },
              ],
            },
            observedAt,
          ),
        );
        await phase('write-gemini', () =>
          store.writeGeminiSnapshot(
            owner,
            {
              sharedDaily: { used: 5, limit: 100 },
              proDaily: null,
              flashDaily: null,
              minute: { used: 2, limit: 10 },
              dailyResetAtMs: observedAt + 12 * 60 * 60 * 1000,
              observedAtMs: observedAt,
            },
            observedAt,
          ),
        );
        const rateLimitResetAt = observedAt + 4 * 60 * 60 * 1000;
        await phase('write-claude-rate-limit', () =>
          store.writeClaudeRateLimit(
            owner,
            {
              window: '5h',
              resetAtMs: rateLimitResetAt,
              fiveHourResetAtMs: rateLimitResetAt,
              sessionWindowStartMs: rateLimitResetAt - 5 * 60 * 60 * 1000,
              sessionWindowEndMs: rateLimitResetAt,
            },
            observedAt,
          ),
        );
        await phase('claim-gemini', () => store.claimDueGeminiAccounts({ refreshMs: 900_000, limit: 1 }));
        await phase('count-gemini-day', () =>
          store.readGeminiWindowRequestCounts(owner, observedAt - 24 * 60 * 60 * 1000),
        );
        await phase('count-gemini-minute', () => store.readGeminiMinuteRequestCount(owner, observedAt));
        const row = (
          await phase('read-snapshot', () =>
            gateway.query<{
              codex_5h_used_percent: number;
              claude_5h_utilization: number;
              gemini_shared_daily_used: number;
              gemini_minute_limit: number;
              claude_session_window_end: Date | null;
            }>(
              `SELECT codex_5h_used_percent, claude_5h_utilization, gemini_shared_daily_used,
                      gemini_minute_limit, claude_session_window_end
                 FROM ${table} WHERE id = $1`,
              [accountId],
            ),
          )
        ).rows[0];
        assert.ok(row !== undefined);
        assert.ok(Math.abs(row.codex_5h_used_percent - 42.5) < 1e-6);
        assert.ok(Math.abs(row.claude_5h_utilization - 0.31) < 1e-6);
        assert.equal(row.gemini_shared_daily_used, 5);
        assert.equal(row.gemini_minute_limit, 10);
        assert.ok(row.claude_session_window_end !== null, 'the 5h session window anchored to [reset−5h, reset]');
        assert.equal(row.claude_session_window_end.getTime(), rateLimitResetAt);

        // The gateway role holds no UPDATE on the worker-owned snapshot
        // columns (115 keeps them validation-worker-owned).
        const gatewayDenied = await gateway
          .query(`UPDATE ${table} SET codex_5h_used_percent = 1 WHERE id = $1`, [accountId])
          .then(() => null)
          .catch((error: unknown) => cancellationSqlState(error) ?? 'unknown');
        assert.equal(gatewayDenied, '42501', 'the gateway must not write the codex snapshot columns');
      } finally {
        await worker.close();
      }
    });
  } finally {
    await Promise.all(databases.map((database) => database.close()));
  }
});
