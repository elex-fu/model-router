import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SaasCompositeModelRoutesError,
  SaasCompositeModelRoutesService,
} from '../../../../src/saas/billing/composite-routes/service.js';
import { SaasBillingGroupsService } from '../../../../src/saas/billing/groups/service.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';

/**
 * Batch 4 §4.4 composite model routing (migration 121): the registry table,
 * the group composite marker and the durable evidence decision column exist
 * on the real disposable PostgreSQL database; the re-applied role template
 * grants the gateway read-only registry access and the control plane full
 * CRUD; the live privilege probes pass; and the control-plane service
 * round-trips CRUD + the three-level resolution preview against real SQL.
 * Same env contract as the 112 gate.
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
    assert.ok(value, `${name} is required for the 121 gate`);
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
    assert.ok(identity === target, 'all 121 roles must use the same disposable target');
    return value;
  });
}

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

interface IndexRow {
  readonly indexname: string;
}

test('121 composite route registry, group marker and evidence column hold on live PostgreSQL', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async () => {
  const [migratorUrl, controlPlaneUrl, gatewayUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const controlPlane: SaasDatabase = createSaasDatabase({ connectionString: controlPlaneUrl, max: 1 });
  const gateway: SaasDatabase = createSaasDatabase({ connectionString: gatewayUrl, max: 1 });
  try {
    const applied = await migrator.query<{ version: number; name: string }>(
      'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 121',
    );
    assert.equal(applied.rows.length, 1, 'migration 121 must be applied');
    assert.equal(applied.rows[0]?.name, 'composite_model_routes');

    // The registry columns and their shapes.
    const columns = await migrator.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_composite_model_routes'
          AND column_name IN ('id', 'group_id', 'public_model', 'match_type', 'target_platform',
                              'upstream_model', 'endpoint', 'priority', 'enabled', 'notes')`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    for (const [name, type, nullable, defaultValue] of [
      ['id', 'bigint', 'NO', null],
      ['group_id', 'text', 'NO', null],
      ['public_model', 'character varying', 'NO', null],
      ['match_type', 'text', 'NO', "'exact'::text"],
      ['target_platform', 'character varying', 'NO', null],
      ['upstream_model', 'character varying', 'NO', "''::character varying"],
      ['endpoint', 'text', 'NO', "'any'::text"],
      ['priority', 'integer', 'NO', '100'],
      ['enabled', 'boolean', 'NO', 'true'],
      ['notes', 'text', 'NO', "''::text"],
    ] as const) {
      const column = byName.get(name);
      assert.ok(column, `column ${name} must exist`);
      assert.equal(column.data_type, type, `column ${name} type`);
      assert.equal(column.is_nullable, nullable, `column ${name} nullability`);
      assert.equal(column.column_default, defaultValue, `column ${name} default`);
    }

    // The covering indexes and the shape-uniqueness constraint.
    const indexes = await migrator.query<IndexRow>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'model_router_saas' AND tablename = 'saas_composite_model_routes'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of [
      'saas_composite_model_routes_pkey',
      'saas_composite_model_routes_shape',
      'saas_composite_model_routes_group_idx',
      'saas_composite_model_routes_group_enabled_idx',
      'saas_composite_model_routes_group_endpoint_idx',
      'saas_composite_model_routes_group_platform_idx',
      'saas_composite_model_routes_priority_idx',
    ]) {
      assert.ok(indexNames.has(name), `index ${name} must exist`);
    }

    // The group marker and the durable evidence decision column.
    const marker = await migrator.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_billing_groups' AND column_name = 'composite'`,
    );
    assert.equal(marker.rows[0]?.data_type, 'boolean');
    assert.equal(marker.rows[0]?.is_nullable, 'NO');
    assert.equal(marker.rows[0]?.column_default, 'false');
    const evidenceColumn = await migrator.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_prepared_request_evidence' AND column_name = 'composite_route'`,
    );
    assert.equal(evidenceColumn.rows[0]?.data_type, 'jsonb');
    assert.equal(evidenceColumn.rows[0]?.is_nullable, 'YES');

    // The re-applied role template: gateway read-only, control plane CRUD.
    const gatewayGrants = await gateway.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_composite_model_routes' AND column_name = 'group_id'
          AND grantee = 'model_router_saas_gateway'`,
    );
    assert.deepEqual(
      gatewayGrants.rows.map((row) => row.privilege_type),
      ['SELECT'],
      'the gateway reads the registry and never writes it',
    );
    // group_id is immutable (SELECT+INSERT only); mutable columns carry
    // UPDATE too.
    const controlPlaneGrants = await controlPlane.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_composite_model_routes'
          AND column_name IN ('group_id', 'priority', 'upstream_model')
          AND grantee = 'model_router_saas_control_plane'`,
    );
    const grantsByColumn = new Map<string, Set<string>>();
    for (const row of controlPlaneGrants.rows) {
      const set = grantsByColumn.get(row.column_name) ?? new Set<string>();
      set.add(row.privilege_type);
      grantsByColumn.set(row.column_name, set);
    }
    assert.deepEqual(
      grantsByColumn.get('group_id'),
      new Set(['SELECT', 'INSERT']),
      'the immutable group binding carries SELECT+INSERT only',
    );
    assert.deepEqual(
      grantsByColumn.get('priority'),
      new Set(['SELECT', 'INSERT', 'UPDATE']),
      'the control plane owns the registry CRUD',
    );
    assert.deepEqual(grantsByColumn.get('upstream_model'), new Set(['SELECT', 'INSERT', 'UPDATE']));
    const controlPlaneDelete = await controlPlane.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'model_router_saas'
          AND table_name = 'saas_composite_model_routes' AND grantee = 'model_router_saas_control_plane'`,
    );
    assert.ok(
      controlPlaneDelete.rows.some((row) => row.privilege_type === 'DELETE'),
      'the control plane deletes registry rows',
    );

    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane, 'control_plane');

    // Control-plane round trip: mark a group composite, CRUD routes, and run
    // the exact three-level resolution preview against real SQL.
    const groups = new SaasBillingGroupsService(controlPlane);
    const routes = new SaasCompositeModelRoutesService(controlPlane);
    const groupId = `composite-e2e-${Date.now()}`;
    await groups.createBillingGroup({
      id: groupId,
      displayName: 'Composite E2E group',
      rateMultiplier: { numerator: 1n, denominator: 1n },
      topupMultiplier: { numerator: 1n, denominator: 1n },
      peakEnabled: false,
      peakStart: null,
      peakEnd: null,
      peakMultiplier: null,
      modelPricing: null,
      rpmLimit: null,
      dailyLimitMinorUnits: null,
      weeklyLimitMinorUnits: null,
      monthlyLimitMinorUnits: null,
      profitMinMargin: null,
      profitSafetyBuffer: null,
      claudeCodeOnly: false,
      fallbackGroupId: null,
      supportedModelScopes: null,
      composite: true,
      status: 'active',
    });

    const created = await routes.createRoute({
      groupId,
      publicModel: 'all/gpt-5',
      matchType: 'exact',
      targetPlatform: 'openai-codex',
      upstreamModel: 'gpt-5.1',
      endpoint: 'responses',
      priority: 100,
      enabled: true,
      notes: 'e2e',
    });
    assert.ok(created.id !== '');

    // The shape-uniqueness constraint rejects a duplicate pattern.
    await assert.rejects(
      () =>
        routes.createRoute({
          groupId,
          publicModel: 'all/gpt-5',
          matchType: 'exact',
          targetPlatform: 'anthropic-claude',
          upstreamModel: 'claude-sonnet-4-6',
          endpoint: 'responses',
          priority: 1,
          enabled: true,
          notes: '',
        }),
      (error: unknown) => error instanceof SaasCompositeModelRoutesError && error.code === 'ROUTE_CONFLICT',
    );

    const updated = await routes.updateRoute(created.id, {
      groupId,
      publicModel: 'all/gpt-5',
      matchType: 'exact',
      targetPlatform: 'openai-codex',
      upstreamModel: 'gpt-5.2',
      endpoint: 'responses',
      priority: 10,
      enabled: true,
      notes: 'e2e updated',
    });
    assert.equal(updated.upstreamModel, 'gpt-5.2');

    // Preview: Level 1 (the exact route), Level 3 (detector, no route), and
    // the fail-closed unknown model.
    const level1 = await routes.previewRoute({ groupId, model: 'all/gpt-5', endpoint: 'responses' });
    assert.deepEqual(
      [
        level1.decision.matched,
        level1.decision.source,
        level1.decision.targetPlatform,
        level1.decision.upstreamModel,
        level1.decision.routeId,
      ],
      [true, 'route', 'openai-codex', 'gpt-5.2', created.id],
    );
    const level3 = await routes.previewRoute({ groupId, model: 'gemini-2.5-pro', endpoint: 'any' });
    assert.deepEqual(
      [level3.decision.matched, level3.decision.source, level3.decision.targetPlatform],
      [true, 'detector', 'google-gemini'],
    );
    const unknown = await routes.previewRoute({ groupId, model: 'e2e-private-model', endpoint: 'any' });
    assert.equal(unknown.decision.matched, false);
    assert.equal(unknown.decision.reason, 'no explicit route or built-in detector match');

    await routes.deleteRoute(created.id);
    const emptied = await routes.listRoutes(groupId);
    assert.equal(emptied.length, 0);
  } finally {
    await gateway.close();
    await controlPlane.close();
    await migrator.close();
  }
});
