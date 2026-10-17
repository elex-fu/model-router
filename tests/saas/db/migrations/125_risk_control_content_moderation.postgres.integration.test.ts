import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { SaasContentModerationService } from '../../../../src/saas/risk/moderation.js';
import {
  PostgresContentModerationStore,
  PostgresRiskControlAdminStore,
} from '../../../../src/saas/risk/postgres-store.js';
import { runRiskControlRetentionOnce } from '../../../../src/saas/risk/retention-worker.js';

/**
 * Batch 5 §5.4 content risk control (migration 125): the three tables exist
 * on the real disposable PostgreSQL database; the re-applied role template
 * grants the gateway its write surface (log INSERT, hash INSERT, user
 * disabled_at UPDATE) and the control plane its ownership (config upsert,
 * log listing, retention DELETEs); the live privilege probes pass; and the
 * gateway moderation store + control-plane admin store round-trip real SQL.
 * Same env contract as the 121 gate.
 */
const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required for the 125 gate`);
    let url: URL;
    let user: string;
    let database: string;
    try {
      url = new URL(value);
      user = decodeURIComponent(url.username);
      database = decodeURIComponent(url.pathname.slice(1));
    } catch {
      throw new Error(`${name} must be a valid PostgreSQL URL`);
    }
    assert.ok(user === role, `${name} must use its exact managed role`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local =
      ['127.0.0.1', '[::1]'].includes(host) &&
      Boolean(url.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must use designated CI or an explicit disposable exact-loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all 125 roles must use the same disposable target');
    return value;
  });
}

interface ColumnRow {
  readonly column_name: string;
}

interface IndexRow {
  readonly indexname: string;
}

test('125 risk control tables, grants and stores hold on live PostgreSQL', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, controlPlaneUrl, gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const controlPlane: SaasDatabase = createSaasDatabase({ connectionString: controlPlaneUrl, max: 1 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const applied = await migrator.query<{ version: number; name: string }>(
      'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 125',
    );
    assert.equal(applied.rows.length, 1, 'migration 125 must be applied');
    assert.equal(applied.rows[0]?.name, 'risk_control_content_moderation');

    // Table shapes.
    const logColumns = await migrator.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'model_router_saas' AND table_name = 'saas_content_moderation_logs'
        ORDER BY ordinal_position`,
    );
    const logColumnNames = logColumns.rows.map((row) => row.column_name);
    for (const column of [
      'id',
      'request_id',
      'tenant_id',
      'user_id',
      'api_key_id',
      'api_key_name',
      'model',
      'protocol',
      'mode',
      'action',
      'flagged',
      'highest_category',
      'highest_score',
      'matched_keyword',
      'category_scores',
      'threshold_snapshot',
      'input_excerpt',
      'input_hash',
      'upstream_latency_ms',
      'error',
      'violation_count',
      'auto_banned',
      'email_sent',
      'created_at',
    ]) {
      assert.ok(logColumnNames.includes(column), `log column ${column} must exist`);
    }
    const configColumns = await migrator.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'model_router_saas' AND table_name = 'saas_risk_control_config'`,
    );
    assert.deepEqual(configColumns.rows.map((row) => row.column_name).sort(), ['config', 'id', 'updated_at']);

    // Indexes over the filter dimensions and the violation window.
    const indexes = await migrator.query<IndexRow>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'model_router_saas'
          AND tablename IN ('saas_content_moderation_logs', 'saas_content_moderation_flagged_hashes')`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of [
      'saas_content_moderation_logs_pkey',
      'saas_content_moderation_logs_created_at_idx',
      'saas_content_moderation_logs_tenant_created_idx',
      'saas_content_moderation_logs_action_created_idx',
      'saas_content_moderation_logs_model_created_idx',
      'saas_content_moderation_logs_user_flagged_created_idx',
      'saas_content_moderation_flagged_hashes_pkey',
      'saas_content_moderation_flagged_hashes_created_at_idx',
    ]) {
      assert.ok(indexNames.has(name), `index ${name} must exist`);
    }

    // Re-applied role template: gateway log INSERT carries identity columns
    // only (never id); the config table is gateway-read; auto-ban UPDATEs
    // exactly the governance columns.
    const gatewayLogGrants = await gateway.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_content_moderation_logs' AND grantee = 'model_router_saas_gateway'`,
    );
    const gatewayLogByColumn = new Map<string, Set<string>>();
    for (const row of gatewayLogGrants.rows) {
      const set = gatewayLogByColumn.get(row.column_name) ?? new Set<string>();
      set.add(row.privilege_type);
      gatewayLogByColumn.set(row.column_name, set);
    }
    assert.deepEqual(gatewayLogByColumn.get('id'), new Set(['SELECT']), 'the gateway reads but never inserts log ids');
    assert.deepEqual(gatewayLogByColumn.get('action'), new Set(['SELECT', 'INSERT']));
    assert.deepEqual(gatewayLogByColumn.get('input_excerpt'), new Set(['SELECT', 'INSERT']));
    assert.equal(
      [...gatewayLogByColumn.values()].some((set) => set.has('UPDATE') || set.has('DELETE')),
      false,
      'the gateway never updates or deletes log rows',
    );
    const gatewayConfigGrants = await gateway.query<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_risk_control_config' AND grantee = 'model_router_saas_gateway'`,
    );
    assert.deepEqual(
      gatewayConfigGrants.rows.map((row) => row.privilege_type).sort(),
      ['SELECT'],
      'the gateway reads the config and never writes it',
    );
    const gatewayUserGrants = await gateway.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_users' AND grantee = 'model_router_saas_gateway'
          AND privilege_type = 'UPDATE'`,
    );
    assert.deepEqual(
      gatewayUserGrants.rows.map((row) => row.column_name).sort(),
      ['disabled_at', 'updated_at'],
      'auto-ban may flip exactly the governance disable columns',
    );
    const controlPlaneDelete = await controlPlane.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'model_router_saas' AND grantee = 'model_router_saas_control_plane'
          AND table_name IN ('saas_content_moderation_logs', 'saas_content_moderation_flagged_hashes')`,
    );
    assert.deepEqual(
      controlPlaneDelete.rows
        .filter((row) => row.privilege_type === 'DELETE')
        .map((row) => row.table_name)
        .sort(),
      ['saas_content_moderation_flagged_hashes', 'saas_content_moderation_logs'],
      'the control plane owns retention and blocklist deletion',
    );

    // The live least-privilege probes (fail closed on anything unexpected).
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');

    // Control-plane round trip: config upsert → gateway snapshot sees it.
    const adminStore = new PostgresRiskControlAdminStore(controlPlane);
    const saved = await adminStore.saveConfig({
      enabled: true,
      mode: 'pre_block',
      base_url: 'https://moderation.example',
      api_keys: ['integration-moderation-key-1'],
      blocked_keywords: ['integration-canary'],
      ban_threshold: 2,
      hit_retention_days: 180,
      non_hit_retention_days: 3,
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.blockedKeywords[0], 'integration-canary');
    const loaded = await adminStore.loadConfig();
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.blockedKeywords[0], 'integration-canary');
    assert.deepEqual(loaded.config.apiKeys, ['integration-moderation-key-1']);

    // Gateway round trip: the moderation service reads the config through the
    // gateway role and a keyword hit produces a log row + violation count.
    const moderation = new SaasContentModerationService({
      store: new PostgresContentModerationStore(gateway),
      runtimeCacheTtlMs: 0,
      fetchImpl: async () => {
        throw new Error('the moderation API must not be called in this scenario');
      },
    });
    const userId = randomUUID();
    await controlPlane.query('INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2)', [
      userId,
      `risk-e2e-${Date.now()}@example.test`,
    ]);
    const tenantId = `risk-tenant-${Date.now()}`;
    const decision = await moderation.check({
      requestId: `risk-req-${Date.now()}`,
      tenantId,
      userId,
      apiKeyId: 'risk-e2e-key',
      apiKeyName: 'risk-e2e-key-name',
      protocol: 'anthropic',
      model: 'claude-sonnet-4',
      body: { messages: [{ role: 'user', content: 'this contains INTEGRATION-CANARY text' }] },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'keyword_block');

    const logs = await adminStore.listLogs({ tenantId, action: 'keyword_block', limit: 20, offset: 0 });
    assert.equal(logs.total, 1);
    const log = logs.items[0];
    assert.equal(log.matchedKeyword, 'integration-canary');
    assert.equal(log.violationCount, 1);
    assert.equal(log.userId, userId);

    // Violation counting on real SQL: a second hit pushes the count to 2 and
    // the ban threshold (2) disables the account through the gateway role.
    const decision2 = await moderation.check({
      requestId: `risk-req-2-${Date.now()}`,
      tenantId,
      userId,
      apiKeyId: 'risk-e2e-key',
      apiKeyName: 'risk-e2e-key-name',
      protocol: 'openai',
      model: 'gpt-4o',
      body: { messages: [{ role: 'user', content: 'again integration-canary' }] },
    });
    assert.equal(decision2.allowed, false);
    const bannedUser = await controlPlane.query<{ disabled_at: string | null }>(
      'SELECT disabled_at FROM model_router_saas.saas_users WHERE id = $1',
      [userId],
    );
    assert.ok(bannedUser.rows[0]?.disabled_at !== null, 'the second violation must auto-ban the user');

    // hash_block rows are excluded from the violation count.
    const hashCount = await new PostgresContentModerationStore(gateway).countFlaggedByUserSince(
      userId,
      new Date(Date.now() - 720 * 3_600_000).toISOString(),
    );
    assert.equal(hashCount, 2, 'both keyword_block hits count');

    // Blocklist lifecycle: record → probe → admin delete.
    const gatewayStore = new PostgresContentModerationStore(gateway);
    const hash = 'a'.repeat(64);
    await gatewayStore.recordFlaggedInputHash(hash);
    assert.equal(await gatewayStore.hasFlaggedInputHash(hash), true);
    assert.equal(await adminStore.deleteFlaggedHash(hash), true);
    assert.equal(await gatewayStore.hasFlaggedInputHash(hash), false);
    assert.equal(await adminStore.countFlaggedHashes(), 0);

    // Retention: a 30-day-old unflagged row (written through the gateway role
    // which owns log INSERTs) is inside the 3-day non-hit sweep; the fresh
    // flagged rows survive the 180-day window.
    await gateway.query(
      `INSERT INTO model_router_saas.saas_content_moderation_logs (
         request_id, tenant_id, api_key_id, mode, action, flagged, created_at
       ) VALUES ('backdated', $1, 'risk-e2e-key', 'observe', 'allow', false, clock_timestamp() - interval '30 days')`,
      [tenantId],
    );
    const swept = await runRiskControlRetentionOnce(controlPlane);
    assert.equal(swept.deletedNonHit, 1, 'the 30-day-old unflagged row is inside the 3d window sweep');
    assert.equal(swept.deletedHit, 0, 'the fresh flagged rows survive the 180d window');

    // Unban through the admin store restores the account.
    assert.equal(await adminStore.enableUser(userId), true);
    const restored = await controlPlane.query<{ disabled_at: string | null }>(
      'SELECT disabled_at FROM model_router_saas.saas_users WHERE id = $1',
      [userId],
    );
    assert.equal(restored.rows[0]?.disabled_at, null);

    // Cleanup the scenario rows through the schema-owning migrator role. The
    // user row stays: saas_reject_user_delete() makes user deletion a
    // structural invariant, and the disposable parity database is reset
    // between bootstrap cycles (the timestamped email keeps re-runs unique).
    await migrator.query('DELETE FROM model_router_saas.saas_content_moderation_logs WHERE tenant_id = $1', [tenantId]);
  } finally {
    await Promise.allSettled([migrator.close(), controlPlane.close(), gateway.close()]);
  }
});
