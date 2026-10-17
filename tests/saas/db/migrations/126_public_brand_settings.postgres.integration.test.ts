import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { BRAND_SETTINGS_KEYS } from '../../../../src/saas/platform/brand/snapshot.js';
import { PublicBrandSnapshotStore } from '../../../../src/saas/platform/brand/store.js';

/**
 * Batch 5 §5.2 OEM white-label (migration 126): the public brand snapshot
 * table holds on the real disposable PostgreSQL database; the re-applied
 * role template grants the gateway read-only access and the control plane
 * SELECT/INSERT/UPDATE with no DELETE; the live privilege probes pass; and
 * the materializer/read round trip runs against real SQL. Same env contract
 * as the 121/122 gates.
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
    assert.ok(value, `${name} is required for the 126 gate`);
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
    assert.ok(identity === target, 'all 126 roles must use the same disposable target');
    return value;
  });
}

test('126 public brand snapshot table, grants and materializer hold on live PostgreSQL', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, controlPlaneUrl, gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const controlPlane: SaasDatabase = createSaasDatabase({ connectionString: controlPlaneUrl, max: 1 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const applied = await migrator.query<{ version: number; name: string }>(
      'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 126',
    );
    assert.equal(applied.rows.length, 1, 'migration 126 must be applied');
    assert.equal(applied.rows[0]?.name, 'public_brand_settings');

    // The singleton row (the migration seeds it; later gate runs may have
    // re-materialized it, so only the shape is asserted here — the exact
    // empty-object seed is pinned by the static migration test).
    const seeded = await migrator.query<{ singleton: boolean; version: string; snapshot: unknown }>(
      'SELECT singleton, version, snapshot FROM model_router_saas.saas_public_brand_settings',
    );
    assert.equal(seeded.rows.length, 1, 'exactly one snapshot row exists');
    assert.equal(seeded.rows[0]?.singleton, true);
    assert.ok(Number(seeded.rows[0]?.version) >= 1, 'the version starts at the seeded 1');
    assert.equal(typeof seeded.rows[0]?.snapshot, 'object');

    // The re-applied role template: gateway SELECT-only (the dynamic
    // read-table grant), control-plane SELECT/INSERT/UPDATE and no DELETE.
    const gatewayGrants = await gateway.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_public_brand_settings' AND column_name = 'snapshot'
          AND grantee = 'model_router_saas_gateway'`,
    );
    assert.deepEqual(
      gatewayGrants.rows.map((row) => row.privilege_type),
      ['SELECT'],
      'the gateway reads the snapshot and never writes it',
    );
    const controlPlaneGrants = await controlPlane.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_public_brand_settings'
          AND column_name IN ('singleton', 'snapshot')
          AND grantee = 'model_router_saas_control_plane'`,
    );
    const byColumn = new Map<string, Set<string>>();
    for (const row of controlPlaneGrants.rows) {
      const set = byColumn.get(row.column_name) ?? new Set<string>();
      set.add(row.privilege_type);
      byColumn.set(row.column_name, set);
    }
    assert.deepEqual(byColumn.get('singleton'), new Set(['SELECT', 'INSERT']), 'the singleton binding is immutable');
    assert.deepEqual(
      byColumn.get('snapshot'),
      new Set(['SELECT', 'INSERT', 'UPDATE']),
      'the control plane re-materializes the snapshot',
    );
    const controlPlaneDelete = await controlPlane.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_public_brand_settings' AND grantee = 'model_router_saas_control_plane'`,
    );
    assert.equal(
      controlPlaneDelete.rows.some((row) => row.privilege_type === 'DELETE'),
      false,
      'the snapshot row is never deleted',
    );

    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');

    // Control-plane round trip: write a brand setting row, materialize, and
    // read the snapshot back through the gateway role.
    const controlPlaneStore = new PublicBrandSnapshotStore({ database: controlPlane });
    await controlPlane.query(
      `INSERT INTO model_router_saas.saas_platform_settings (key, value, updated_by_user_id)
       VALUES ($1, $2::jsonb, NULL)
       ON CONFLICT (key) DO NOTHING`,
      [BRAND_SETTINGS_KEYS.siteName, JSON.stringify({ value: 'Acme PG' })],
    );
    const version = await controlPlaneStore.materialize();
    assert.ok(version >= 2, 'materialization increments the seeded version');
    const gatewayStore = new PublicBrandSnapshotStore({ database: gateway });
    const snapshot = await gatewayStore.read();
    assert.equal(snapshot.siteName, 'Acme PG');

    // A corrupted settings row fails the materialization fail-closed and
    // keeps the previously materialized snapshot serving.
    await controlPlane.query(
      `INSERT INTO model_router_saas.saas_platform_settings (key, value, updated_by_user_id)
       VALUES ($1, $2::jsonb, NULL)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [BRAND_SETTINGS_KEYS.siteLogo, JSON.stringify({ value: 'javascript:alert(1)' })],
    );
    await assert.rejects(controlPlaneStore.materialize());
    assert.equal((await gatewayStore.read()).siteName, 'Acme PG');
    // Cleanup: the settings rows are never deleted (the 110 convention), so
    // the gate resets the injected values to valid empties instead — the
    // next run's INSERT DO NOTHING and assertions stay idempotent.
    await controlPlane.query(
      `UPDATE model_router_saas.saas_platform_settings
          SET value = $2::jsonb WHERE key = $1`,
      [BRAND_SETTINGS_KEYS.siteLogo, JSON.stringify({ value: '' })],
    );
    await controlPlaneStore.materialize();
    assert.equal((await gatewayStore.read()).siteName, 'Acme PG');
    assert.equal((await gatewayStore.read()).siteLogo, '');
  } finally {
    await Promise.allSettled([migrator.close(), controlPlane.close(), gateway.close()]);
  }
});
