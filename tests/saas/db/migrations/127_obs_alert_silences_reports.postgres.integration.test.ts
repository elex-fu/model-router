import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { ObservabilityAlertSilenceService } from '../../../../src/saas/observability/alert-silences.js';

/**
 * Batch 5 §5.6 (task #23, migration 127): the alert silences and report
 * state tables exist on the real disposable PostgreSQL database; the
 * re-applied role template grants the control plane silence CRUD (plus
 * DELETE), report-state INSERT/UPDATE and the alert-events resolved_at
 * UPDATE the evaluator's auto-resolve needs; and the silence service
 * round-trips against real SQL. Same env contract as the 121 gate.
 */
const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required for the 127 gate`);
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
    assert.ok(identity === target, 'all 127 roles must use the same disposable target');
    return value;
  });
}

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
}

interface IndexRow {
  readonly indexname: string;
}

test('127 alert silences and report state hold on live PostgreSQL', {
  skip: process.env[required] !== '1' ? `set ${required}=1 with the disposable role-template database` : false,
}, async (t) => {
  const [migratorUrl, controlPlaneUrl] = safeRoleUrls();
  const migrator: SaasDatabase = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const controlPlane: SaasDatabase = createSaasDatabase({ connectionString: controlPlaneUrl, max: 1 });
  t.after(async () => {
    await migrator.close();
    await controlPlane.close();
  });

  const applied = await migrator.query<{ version: number; name: string }>(
    'SELECT version, name FROM model_router_saas.saas_schema_migrations WHERE version = 127',
  );
  assert.equal(applied.rows.length, 1, 'migration 127 must be applied');
  assert.equal(applied.rows[0]?.name, 'obs_alert_silences_and_report_state');

  // The silence columns and their shapes.
  const columns = await migrator.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'model_router_saas'
        AND table_name = 'saas_obs_alert_silences'
        AND column_name IN ('id', 'rule_id', 'platform', 'group_id', 'region', 'until', 'reason', 'created_by', 'created_at')`,
  );
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
  for (const [name, type, nullable] of [
    ['id', 'uuid', 'NO'],
    ['rule_id', 'uuid', 'YES'],
    ['platform', 'text', 'YES'],
    ['group_id', 'text', 'YES'],
    ['region', 'text', 'YES'],
    ['until', 'timestamp with time zone', 'NO'],
    ['reason', 'text', 'YES'],
    ['created_by', 'text', 'NO'],
    ['created_at', 'timestamp with time zone', 'NO'],
  ] as const) {
    const column = byName.get(name);
    assert.ok(column, `column ${name} must exist`);
    assert.equal(column.data_type, type, `column ${name} type`);
    assert.equal(column.is_nullable, nullable, `column ${name} nullability`);
  }

  // The report state columns and the report-type CHECK.
  const stateColumns = await migrator.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'model_router_saas' AND table_name = 'saas_obs_report_state'`,
  );
  assert.deepEqual(
    stateColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    [
      ['report_type', 'NO'],
      ['last_run_at', 'NO'],
      ['updated_at', 'NO'],
    ],
  );
  // The report-type CHECK admits exactly the four scheduled report types.
  const stateConstraint = await migrator.query<{ readonly consrc: string | null }>(
    `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
      WHERE conrelid = 'model_router_saas.saas_obs_report_state'::regclass AND contype = 'c'`,
  );
  assert.match(
    stateConstraint.rows.map((row) => row.consrc ?? '').join(' '),
    /daily_summary.*weekly_summary.*error_digest.*account_health/s,
  );

  // The indexes: until scan and the rule-scoped partial index.
  const indexes = await migrator.query<IndexRow>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'model_router_saas' AND tablename = 'saas_obs_alert_silences'`,
  );
  const names = indexes.rows.map((row) => row.indexname);
  assert.ok(names.includes('saas_obs_alert_silences_until_idx'));
  assert.ok(names.includes('saas_obs_alert_silences_rule_idx'));

  // The runtime privileges the evaluator and scheduler rely on. The DML
  // grants are column-level (the role-template posture), so the probes use
  // has_column_privilege; DELETE is the one table-level grant.
  const privileges = await migrator.query<{ readonly ok: boolean }>(`
    SELECT
      has_table_privilege('model_router_saas_control_plane', 'model_router_saas.saas_obs_alert_silences', 'DELETE')
      AND has_column_privilege('model_router_saas_control_plane', 'model_router_saas.saas_obs_alert_silences', 'created_by', 'INSERT')
      AND has_column_privilege('model_router_saas_control_plane', 'model_router_saas.saas_obs_report_state', 'last_run_at', 'UPDATE')
      AND has_column_privilege('model_router_saas_control_plane', 'model_router_saas.saas_obs_report_state', 'report_type', 'INSERT')
      AND has_column_privilege('model_router_saas_control_plane', 'model_router_saas.saas_obs_alert_events', 'resolved_at', 'UPDATE')
      AND NOT has_column_privilege('model_router_saas_gateway', 'model_router_saas.saas_obs_alert_silences', 'id', 'INSERT')
      AND NOT has_column_privilege('model_router_saas_gateway', 'model_router_saas.saas_obs_alert_silences', 'id', 'SELECT')
      AS ok`);
  assert.equal(privileges.rows[0]?.ok, true, 'the control-plane grants hold and the gateway stays read-free');

  // The silence service round-trips against real SQL on the control-plane role.
  const silences = new ObservabilityAlertSilenceService(controlPlane);
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await silences.createSilence({
    platform: 'kimi',
    until,
    reason: '127 gate round trip',
    createdBy: 'gate-user',
  });
  t.after(async () => {
    await silences.deleteSilence(created.id).catch(() => undefined);
  });
  assert.equal(created.platform, 'kimi');
  const listed = await silences.listSilences();
  assert.ok(listed.some((silence) => silence.id === created.id));
  assert.equal(await silences.deleteSilence(created.id), true);
  assert.equal(await silences.deleteSilence(created.id), false);

  // A silence with no scope is rejected: by the service first, and by the
  // table's own CHECK constraint when the service layer is bypassed.
  await assert.rejects(() => silences.createSilence({ until, createdBy: 'gate-user' }));
  await assert.rejects(() =>
    controlPlane.query(
      `INSERT INTO model_router_saas.saas_obs_alert_silences (id, until, created_by)
       VALUES (gen_random_uuid(), now() + interval '1 hour', 'gate-user')`,
    ),
  );
});
