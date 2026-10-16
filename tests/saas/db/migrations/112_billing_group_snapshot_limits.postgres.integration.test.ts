import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';

/**
 * R1 billing-group limit enforcement, phase 1 (migration 112): the frozen
 * enforcement columns exist on the real disposable PostgreSQL database, the
 * re-applied role template grants the gateway exactly those columns, and
 * the live gateway privilege probe passes. Runs only against the
 * disposable E2E database (same env contract as the 056 gate).
 */
const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required for the 112 gate`);
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
    assert.ok(identity === target, 'all 112 roles must use the same disposable target');
    return value;
  });
}

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

const EXPECTED_112_COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ['group_rpm_limit', 'integer'],
  ['group_daily_limit_minor_units', 'bigint'],
  ['group_weekly_limit_minor_units', 'bigint'],
  ['group_monthly_limit_minor_units', 'bigint'],
  ['group_supported_model_scopes', 'ARRAY'],
  ['group_fallback_group_id', 'text'],
];

test('112 frozen enforcement columns exist nullable and the gateway mirror holds on live PostgreSQL', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const applied = await migrator.query<{ version: number }>(
      'SELECT version FROM model_router_saas.saas_schema_migrations WHERE version = 112',
    );
    assert.equal(applied.rows.length, 1, 'migration 112 must be applied');

    const columns = await migrator.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_request_customer_price_snapshots'
          AND column_name IN ('group_rpm_limit', 'group_daily_limit_minor_units', 'group_weekly_limit_minor_units',
                              'group_monthly_limit_minor_units', 'group_supported_model_scopes', 'group_fallback_group_id')`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    for (const [name, type] of EXPECTED_112_COLUMNS) {
      const column = byName.get(name);
      assert.ok(column, `column ${name} must exist`);
      assert.equal(column.data_type, type, `column ${name} type`);
      assert.equal(column.is_nullable, 'YES', `${name} backfills existing rows to NULL (no limit)`);
      assert.equal(column.column_default, null, `${name} carries no default`);
    }

    // The re-applied role template grants the gateway INSERT on exactly the
    // new columns and SELECT through the dynamic all-current-columns grant.
    for (const [name] of EXPECTED_112_COLUMNS) {
      const privileges = await gateway.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.column_privileges
          WHERE table_schema = 'model_router_saas'
            AND table_name = 'saas_request_customer_price_snapshots'
            AND column_name = $1
            AND grantee = 'model_router_saas_gateway'`,
        [name],
      );
      const granted = new Set(privileges.rows.map((row) => row.privilege_type));
      assert.ok(granted.has('INSERT'), `gateway INSERT on ${name}`);
      assert.ok(granted.has('SELECT'), `gateway SELECT on ${name}`);
    }

    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  } finally {
    await gateway.close();
    await migrator.close();
  }
});
