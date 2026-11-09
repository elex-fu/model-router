import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { PostgresRiskControlAdminStore } from '../../../src/saas/risk/postgres-store.js';
import { selectUserLimitPolicy } from '../../../src/saas/risk/postgres-user-limits.js';
import { runRiskControlRetentionOnce } from '../../../src/saas/risk/retention-worker.js';
import { PostgresUserAnomalyDetector, PostgresUserRiskObservationRecorder } from '../../../src/saas/risk/user-risk.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

/**
 * M3 §7 acceptance drill — the 限速 / 暂停 / 封禁 / 撤销 disposition matrix on
 * the disposable E2E database, over the three production roles:
 *
 * 1. Observation capture: the gateway-role recorder INSERTs digest-only
 *    evidence (migration 153) — proving the gateway INSERT grant and the
 *    HMAC digest contract (never a raw address).
 * 2. 限速 (rate limit): three distinct addresses inside one detector window
 *    escalate to the rate_limited marker (rpm 10) with full audit; an
 *    immediate re-run detects nothing (window-bucket idempotency).
 * 3. 暂停 (suspend): the second detection suspends the key (migration 154)
 *    instead of revoking it; the operator resume path restores it.
 * 4. 封禁 (ban): the third detection disables the user, revokes active keys
 *    and sessions, and sets the account_suspended marker; the resume path
 *    then refuses (no resurrecting keys inside a banned account).
 * 5. 撤销 irreversibility: unban clears markers and re-enables the user but
 *    never restores the revoked key.
 * 6. Retention: aged observations are deleted by the control-plane sweep
 *    (proving the DELETE grant).
 * 7. The user-limit projection resolves under the control-plane role (the
 *    SELECT the key clamp reads).
 */

const WINDOW_SECONDS = 300;
const SECRET = new Uint8Array(32).fill(7);

interface DrillContext {
  readonly migrator: SaasDatabase;
  readonly control: SaasDatabase;
  readonly gateway: SaasDatabase;
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly keyId: string;
}

async function insertObservation(
  gateway: SaasDatabase,
  input: { userId: string; tenantId: string; apiKeyId: string; digest: string; occurredAt: string },
): Promise<void> {
  await gateway.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO saas_user_risk_observations
         (user_id, tenant_id, api_key_id, client_address_digest, public_model, protocol, occurred_at)
       VALUES ($1, $2, $3, $4, 'drill-model', 'anthropic', $5::timestamptz)`,
      [input.userId, input.tenantId, input.apiKeyId, input.digest, input.occurredAt],
    );
  });
}

function digestOf(address: string): string {
  // The recorder's digest contract: HMAC-SHA256 over the deployment key with
  // the pinned domain prefix. Duplicated here deliberately — the drill asserts
  // the wire contract, not an internal helper.
  return createHmac('sha256', SECRET).update('model-router/user-risk/address/v1\0').update(address).digest('hex');
}

async function assertAuditActions(
  executor: SaasDatabase,
  context: DrillContext,
  expected: readonly string[],
): Promise<readonly string[]> {
  const result = await executor.query<{ readonly action: string }>(
    `SELECT action FROM saas_audit_events
      WHERE entry_point = 'user-anomaly-detection' AND target_id IN ($1, $2)
      ORDER BY occurred_at, id`,
    [context.userId, context.keyId],
  );
  const actions = result.rows.map((row) => row.action);
  assert.deepEqual(actions, expected);
  return actions;
}

test('user risk control drill: observation capture, rate-limit, suspend, ban, revoke, retention', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to run the user risk drill`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const control = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), control.close(), gateway.close()]);
  });
  await phase('readiness', async () => {
    await gateway.verifySchema();
    await control.verifySchema();
  });
  const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
  const context: DrillContext = {
    migrator: migrator.database,
    control,
    gateway,
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    userId: fixture.userId,
    keyId: fixture.keyId,
  };
  const recorder = new PostgresUserRiskObservationRecorder(SECRET);

  await t.test('the gateway role captures digest-only evidence', async () => {
    await gateway.transaction(async (tx) => {
      await recorder.record(tx, {
        userId: context.userId,
        tenantId: context.tenantId,
        apiKeyId: context.keyId,
        publicModel: 'drill-model',
        protocol: 'anthropic',
        clientAddress: { status: 'resolved', address: '192.0.2.10', source: 'socket-peer' },
      });
      await recorder.record(tx, {
        userId: context.userId,
        tenantId: context.tenantId,
        apiKeyId: context.keyId,
        publicModel: 'drill-model',
        protocol: 'anthropic',
        clientAddress: { status: 'unresolved', reason: 'malformed-forwarded-address' },
      });
    });
    // Read-back runs on the control plane: the gateway lane has INSERT-only
    // grants on observations (it records evidence, never reads it).
    const observed = await control.query<{ readonly client_address_digest: string | null }>(
      'SELECT client_address_digest FROM saas_user_risk_observations WHERE api_key_id = $1 ORDER BY id',
      [context.keyId],
    );
    assert.equal(observed.rows.length, 2);
    assert.match(String(observed.rows[0]?.client_address_digest), /^[0-9a-f]{64}$/);
    assert.equal(observed.rows[1]?.client_address_digest, null);
    assert.doesNotMatch(JSON.stringify(observed.rows), /192\.0\.2/);
  });

  const t0 = Date.now();
  const at = (secondsBeforeNow: number) => new Date(t0 - secondsBeforeNow * 1000).toISOString();
  const detectorWindow = (offsetSeconds: number) => new Date(t0 + offsetSeconds * 1000);

  await t.test('rate limit: the first detection marks the user and is idempotent', async () => {
    for (const address of ['192.0.2.20', '192.0.2.21', '198.51.100.22']) {
      await insertObservation(gateway, {
        userId: context.userId,
        tenantId: context.tenantId,
        apiKeyId: context.keyId,
        digest: digestOf(address),
        occurredAt: at(60),
      });
    }
    const detector = new PostgresUserAnomalyDetector(control, { now: () => detectorWindow(0) });
    const first = await phase('terminal_transition', () => detector.runBatch());
    assert.deepEqual(first, { detected: 1, rateLimited: 1, keysSuspended: 0, accountsSuspended: 0 });

    const marker = await control.query<{ readonly stage: string; readonly requests_per_minute: string }>(
      'SELECT stage, requests_per_minute::text AS requests_per_minute FROM saas_user_risk_markers WHERE user_id = $1',
      [context.userId],
    );
    assert.equal(marker.rows[0]?.stage, 'rate_limited');
    assert.equal(marker.rows[0]?.requests_per_minute, '10');
    await assertAuditActions(control, context, ['user_anomaly.detected', 'user_risk.rate_limited']);

    const replay = await phase('replay', () => detector.runBatch());
    assert.deepEqual(
      replay,
      { detected: 0, rateLimited: 0, keysSuspended: 0, accountsSuspended: 0 },
      'the window-bucket conflict key makes re-runs inert',
    );
  });

  await t.test('suspend: the second detection suspends the key, and resume restores it', async () => {
    for (const address of ['192.0.2.30', '192.0.2.31', '198.51.100.32']) {
      await insertObservation(gateway, {
        userId: context.userId,
        tenantId: context.tenantId,
        apiKeyId: context.keyId,
        digest: digestOf(address),
        occurredAt: new Date(t0 + 360 * 1000).toISOString(),
      });
    }
    const detector = new PostgresUserAnomalyDetector(control, { now: () => detectorWindow(660) });
    const second = await phase('terminal_transition', () => detector.runBatch());
    assert.deepEqual(second, { detected: 1, rateLimited: 0, keysSuspended: 1, accountsSuspended: 0 });

    const key = await control.query<{
      readonly status: string;
      readonly suspended_at: string | null;
      readonly revoked_at: string | null;
      readonly authz_version: string;
    }>(
      'SELECT status, suspended_at::text AS suspended_at, revoked_at::text AS revoked_at, authz_version::text AS authz_version FROM saas_api_keys WHERE id = $1',
      [context.keyId],
    );
    assert.equal(key.rows[0]?.status, 'suspended');
    assert.ok(key.rows[0]?.suspended_at);
    assert.equal(key.rows[0]?.revoked_at, null, 'suspension is not revocation');

    const store = new PostgresRiskControlAdminStore(control);
    const resumed = await phase('terminal_transition', () =>
      store.resumeApiKey(context.tenantId, context.projectId, context.keyId),
    );
    assert.deepEqual(resumed, { status: 'resumed' });
    const afterResume = await control.query<{ readonly status: string; readonly authz_version: string }>(
      'SELECT status, authz_version::text AS authz_version FROM saas_api_keys WHERE id = $1',
      [context.keyId],
    );
    assert.equal(afterResume.rows[0]?.status, 'active');
    assert.ok(BigInt(String(afterResume.rows[0]?.authz_version)) > BigInt(String(key.rows[0]?.authz_version)));
  });

  await t.test('ban: the third detection disables the user and revokes active keys', async () => {
    for (const address of ['192.0.2.40', '192.0.2.41', '198.51.100.42']) {
      await insertObservation(gateway, {
        userId: context.userId,
        tenantId: context.tenantId,
        apiKeyId: context.keyId,
        digest: digestOf(address),
        occurredAt: new Date(t0 + 720 * 1000).toISOString(),
      });
    }
    const detector = new PostgresUserAnomalyDetector(control, { now: () => detectorWindow(1020) });
    const third = await phase('terminal_transition', () => detector.runBatch());
    assert.deepEqual(third, { detected: 1, rateLimited: 0, keysSuspended: 0, accountsSuspended: 1 });

    const user = await control.query<{ readonly disabled_at: string | null }>(
      'SELECT disabled_at::text AS disabled_at FROM saas_users WHERE id = $1',
      [context.userId],
    );
    assert.ok(user.rows[0]?.disabled_at);
    const key = await control.query<{ readonly status: string; readonly revoked_at: string | null }>(
      'SELECT status, revoked_at::text AS revoked_at FROM saas_api_keys WHERE id = $1',
      [context.keyId],
    );
    assert.equal(key.rows[0]?.status, 'revoked');
    assert.ok(key.rows[0]?.revoked_at);
    const marker = await control.query<{ readonly stage: string }>(
      'SELECT stage FROM saas_user_risk_markers WHERE user_id = $1',
      [context.userId],
    );
    assert.equal(marker.rows[0]?.stage, 'account_suspended');
  });

  await t.test('revoke irreversibility: resume refuses, unban clears markers but restores nothing', async () => {
    const store = new PostgresRiskControlAdminStore(control);
    const bannedRefusal = await phase('conflict', () =>
      store.resumeApiKey(context.tenantId, context.projectId, context.keyId),
    );
    assert.deepEqual(bannedRefusal, {
      status: 'unchanged',
      reason: 'principal_disabled',
    });

    const unbanned = await phase('terminal_transition', () => store.enableUser(context.userId));
    assert.equal(unbanned, true);
    const user = await control.query<{ readonly disabled_at: string | null }>(
      'SELECT disabled_at::text AS disabled_at FROM saas_users WHERE id = $1',
      [context.userId],
    );
    assert.equal(user.rows[0]?.disabled_at, null);
    const markers = await control.query<{ readonly count: string }>(
      'SELECT count(*)::text AS count FROM saas_user_risk_markers WHERE user_id = $1',
      [context.userId],
    );
    assert.equal(markers.rows[0]?.count, '0', 'unban clears enforcement markers');
    const key = await control.query<{ readonly status: string }>('SELECT status FROM saas_api_keys WHERE id = $1', [
      context.keyId,
    ]);
    assert.equal(key.rows[0]?.status, 'revoked', 'unban never restores revoked keys');

    const revokedRefusal = await phase('conflict', () =>
      store.resumeApiKey(context.tenantId, context.projectId, context.keyId),
    );
    assert.deepEqual(revokedRefusal, { status: 'unchanged', reason: 'revoked' });
  });

  await t.test('retention: the control-plane sweep deletes aged observations', async () => {
    const label = randomUUID();
    await migrator.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO saas_user_risk_observations
           (user_id, tenant_id, api_key_id, client_address_digest, public_model, protocol, occurred_at)
         VALUES ($1, $2, $3, NULL, 'drill-aged-${label}', 'anthropic', now() - interval '30 days')`,
        [context.userId, context.tenantId, context.keyId],
      );
    });
    const swept = await phase('cleanup', () => runRiskControlRetentionOnce(control));
    assert.ok(
      swept.deletedObservations >= 1,
      `the control-plane DELETE grant ages out observations (deleted ${swept.deletedObservations})`,
    );
    const aged = await control.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM saas_user_risk_observations WHERE public_model = 'drill-aged-${label}'`,
    );
    assert.equal(aged.rows[0]?.count, '0');
  });

  await t.test('the user-limit projection resolves under the control-plane role', async () => {
    await migrator.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO saas_user_limit_policies
           (user_id, requests_per_minute, max_concurrent_requests)
         VALUES ($1, 10, 2)
         ON CONFLICT (user_id) DO NOTHING`,
        [context.userId],
      );
    });
    const policy = await phase('snapshot', () =>
      control.transaction((tx) => selectUserLimitPolicy(tx, context.userId)),
    );
    assert.equal(policy.requestsPerMinute, 10n, 'the per-user override wins over the NULL defaults');
    assert.equal(policy.maxConcurrentRequests, 2n);
    assert.equal(policy.dailyTokenUnits, null);
  });
});
