import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  SaasCredentialValidationWorkerPrivilegeError,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from '../../../src/saas/db/credential-validation-worker-privileges.js';

const SAFE_WORKER_PRIVILEGE_ROW = {
  role_exists: true,
  server_version_supported: true,
  managed_schema: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_schema: false,
  owns_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  no_database_connect: false,
  any_table_level_privilege: false,
  missing_column_privilege: false,
  extra_column_privilege: false,
  any_sequence_privilege: false,
  any_function_privilege: false,
  catalog_scope_validator_executable: true,
  out_of_schema_object_privilege: false,
};

test('worker privilege probe grants only the documented column-level snapshot and health writes', async () => {
  let queryCount = 0;
  await verifyCredentialValidationWorkerRuntimePrivileges({
    query: async <Row>(sql: string) => {
      queryCount += 1;
      assert.equal(sql, SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL);
      return { rows: [SAFE_WORKER_PRIVILEGE_ROW] as unknown as Row[], rowCount: 1 };
    },
  });
  assert.equal(queryCount, 1);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /expected_column_privileges/);
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_rights', 'endpoint_scope', 'SELECT'/,
  );
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_capabilities', 'validation_state', 'SELECT'/,
  );
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_capabilities', 'evidence_sha256', 'SELECT'/,
  );
  // G2 (F6 mount): the OpenRouter pricing sync's capability registration
  // reads the full row via RETURNING, so SELECT now covers the evidence
  // columns — but they must never become worker-writable.
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_capabilities', '(?:evidence_ref|evidence_version)', 'SELECT'/,
  );
  assert.doesNotMatch(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_capabilities', '(?:evidence_ref|evidence_version)', '(?:UPDATE|REFERENCES)'/,
  );
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_tenant_provider_account_capabilities', 'capability_version', 'SELECT'/,
  );
  for (const column of [
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'wrapping_revision',
    'kms_key_id',
    'wrapped_dek',
  ]) {
    assert.match(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
      new RegExp(`'saas_tenant_provider_credential_wrappings', '${column}', 'SELECT'`),
    );
  }
  assert.doesNotMatch(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_tenant_provider_credential_wrappings', '[^']+', '(?:INSERT|UPDATE|REFERENCES)'/,
  );
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /extra_column_privilege/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /any_table_level_privilege/);
});

test('worker privilege probe rejects broad grants, unsafe roles and malformed probe responses', async () => {
  for (const unsafeRow of [
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_table_level_privilege: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, extra_column_privilege: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_role_membership: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_function_privilege: true },
    // G2: the CHECK-validator EXECUTE exception fails closed — the probe
    // rejects when the saas_catalog_valid_scope grant is not yet applied.
    { ...SAFE_WORKER_PRIVILEGE_ROW, catalog_scope_validator_executable: false },
    {},
  ]) {
    await assert.rejects(
      verifyCredentialValidationWorkerRuntimePrivileges({
        query: async <Row>() => ({ rows: [unsafeRow] as unknown as Row[], rowCount: 1 }),
      }),
      SaasCredentialValidationWorkerPrivilegeError,
    );
  }
});

test('worker SELECT never implies INSERT/UPDATE/REFERENCES on the same column', () => {
  const sql = SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL;
  assert.match(
    sql,
    /CROSS JOIN \(VALUES \('SELECT'\), \('INSERT'\), \('UPDATE'\), \('REFERENCES'\)\) AS actual\(privilege_type\)/,
  );
  assert.match(sql, /has_column_privilege\(current_user, relation\.oid, attribute\.attname, actual\.privilege_type\)/);
  assert.match(sql, /expected\.privilege_type = actual\.privilege_type/);
  assert.doesNotMatch(sql, /expected\.privilege_type IN \('SELECT', 'INSERT', 'UPDATE', 'REFERENCES'\)/);
  for (const column of ['current_version', 'expires_at']) {
    assert.ok(sql.includes(`('saas_tenant_provider_credentials', '${column}', 'SELECT')`));
    assert.ok(!sql.includes(`('saas_tenant_provider_credentials', '${column}', 'UPDATE')`));
  }
  assert.doesNotMatch(sql, /\('saas_(?:usage_settlements|schema_migrations)'/);
});

test('deployment grant script exposes only the worker role’s column-scoped permissions', () => {
  const sql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  assert.match(sql, /model_router_saas_validation_worker/);
  assert.match(sql, /GRANT SELECT \(/);
  assert.match(sql, /GRANT UPDATE \(/);
  assert.match(sql, /ON TABLE model_router_saas\.saas_provider_rights/);
  assert.match(sql, /ON TABLE model_router_saas\.saas_provider_capabilities/);
  assert.match(
    sql,
    /GRANT SELECT \(\s*provider_id, product_id, model, endpoint, protocol, version, support_level,\s*validation_state, evidence_sha256\s*\) ON TABLE model_router_saas\.saas_provider_capabilities\s+TO model_router_saas_validation_worker;/,
  );
  assert.match(sql, /ON TABLE model_router_saas\.saas_tenant_provider_account_capabilities/);
  assert.match(
    sql,
    /GRANT SELECT \(\s*tenant_id, account_id, credential_id, credential_version,\s*wrapping_revision, kms_key_id, wrapped_dek\s*\) ON TABLE model_router_saas\.saas_tenant_provider_credential_wrappings\s+TO model_router_saas_validation_worker;/,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE \([^)]*\) ON TABLE model_router_saas\.saas_provider_/s);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE)\b[^;]*saas_tenant_provider_credential_wrappings/is);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s*,/i);
  assert.doesNotMatch(sql, /GRANT\s+DELETE\b/i);
  // R6a (109) + G2 (F6 mount): INSERT exists only for the probe monitor
  // worker's append-only observation records and the OpenRouter pricing sync
  // worker's append-only catalog/public-model/supplier-cost registration
  // tables. No other table may gain an INSERT grant on this role.
  const workerInsertTables = new Set([
    'saas_probe_runs',
    'saas_audit_events',
    'saas_provider_products',
    'saas_provider_rights',
    'saas_provider_rights_events',
    'saas_provider_capabilities',
    'saas_public_models',
    'saas_public_model_versions',
    'saas_supplier_cost_versions',
  ]);
  for (const match of sql.matchAll(/GRANT\s+INSERT\s*\(([^)]*)\)\s*ON TABLE model_router_saas\.(\w+)/gis)) {
    assert.ok(workerInsertTables.has(match[2] ?? ''), `unexpected INSERT grant on ${match[2]}`);
  }
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS/);
  assert.match(sql, /migrations include version 058/);
  assert.doesNotMatch(
    sql,
    /GRANT UPDATE \([^)]*\b(?:current_version|expires_at)\b[^)]*\) ON TABLE model_router_saas\.saas_tenant_provider_credentials/s,
  );
  // G2 (F6 openRouterModelPricingSync): the single EXECUTE exception is the
  // IMMUTABLE CHECK-constraint validator saas_catalog_valid_scope(text[]) —
  // pinned exactly so no other routine grant can slip in.
  const executeGrantStatements = sql.match(/GRANT\s+EXECUTE\b[^;]*;/gis) ?? [];
  assert.deepEqual(
    executeGrantStatements.map((statement) => statement.replace(/\s+/g, ' ').trim()),
    [
      'GRANT EXECUTE ON FUNCTION model_router_saas.saas_catalog_valid_scope(text[]) TO model_router_saas_validation_worker;',
    ],
  );
});

test('100 grants the Claude usage worker its scheduling columns on both account tables only', () => {
  const workerGrantSql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const column of ['claude_usage_updated_at', 'claude_5h_reset_at']) {
      assert.ok(
        SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('${table}', '${column}', 'SELECT')`),
        `probe manifest missing SELECT ${table}.${column}`,
      );
      assert.match(
        workerGrantSql,
        new RegExp(`GRANT SELECT \\([^)]*\\b${column}\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`),
      );
    }
    for (const column of [
      'claude_5h_utilization',
      'claude_5h_reset_at',
      'claude_7d_utilization',
      'claude_7d_reset_at',
      'claude_7d_sonnet_utilization',
      'claude_7d_sonnet_reset_at',
      'claude_7d_oi_utilization',
      'claude_7d_oi_reset_at',
      'claude_usage_updated_at',
      'claude_session_window_start',
      'claude_session_window_end',
    ]) {
      assert.ok(
        SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('${table}', '${column}', 'UPDATE')`),
        `probe manifest missing UPDATE ${table}.${column}`,
      );
      assert.match(
        workerGrantSql,
        new RegExp(`GRANT UPDATE \\([^)]*\\b${column}\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`),
      );
    }
    // The control plane owns the operator's CLI pin override; the usage
    // worker never reads or writes it.
    assert.doesNotMatch(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
      new RegExp(`\\('${table}', 'claude_cli_version_override', '(?:SELECT|INSERT|UPDATE|REFERENCES)'\\)`),
    );
    assert.doesNotMatch(
      workerGrantSql,
      new RegExp(
        `GRANT (?:SELECT|UPDATE) \\([^)]*\\bclaude_cli_version_override\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`,
      ),
    );
  }
});

test('108 grants the OpenCode Go usage worker its scheduling columns on both account tables only', () => {
  const workerGrantSql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const column of [
      'opencode_go_usage_next_due_at',
      'opencode_go_usage_updated_at',
      'opencode_go_rate_limited_until',
    ]) {
      assert.ok(
        SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('${table}', '${column}', 'SELECT')`),
        `probe manifest missing SELECT ${table}.${column}`,
      );
      assert.match(
        workerGrantSql,
        new RegExp(`GRANT SELECT \\([^)]*\\b${column}\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`),
      );
    }
    for (const column of [
      'opencode_go_rolling_5h_used_percent',
      'opencode_go_rolling_5h_reset_at',
      'opencode_go_weekly_used_percent',
      'opencode_go_weekly_reset_at',
      'opencode_go_monthly_used_percent',
      'opencode_go_monthly_reset_at',
      'opencode_go_usage_updated_at',
      'opencode_go_usage_next_due_at',
      'opencode_go_usage_failure_count',
      'opencode_go_rate_limited_until',
    ]) {
      assert.ok(
        SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('${table}', '${column}', 'UPDATE')`),
        `probe manifest missing UPDATE ${table}.${column}`,
      );
      assert.match(
        workerGrantSql,
        new RegExp(`GRANT UPDATE \\([^)]*\\b${column}\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`),
      );
    }
    // The control plane owns the adaptive-routing rule table; the usage
    // worker never reads or writes protocol_rules.
    assert.doesNotMatch(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
      new RegExp(`\\('${table}', 'opencode_go_protocol_rules', '(?:SELECT|INSERT|UPDATE|REFERENCES)'\\)`),
    );
    assert.doesNotMatch(
      workerGrantSql,
      new RegExp(
        `GRANT (?:SELECT|UPDATE) \\([^)]*\\bopencode_go_protocol_rules\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`,
      ),
    );
  }
});

test('109 grants the probe monitor worker its claim/write surface only', () => {
  const workerGrantSql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  for (const column of [
    'id',
    'owner_scope_key',
    'owner_kind',
    'owner_tenant_id',
    'account_id',
    'provider_category',
    'probe_interval_seconds',
    'challenge_prompt',
    'challenge_answer',
    'failure_threshold',
    'consecutive_failures',
    'last_result',
    'enabled',
    'next_due_at',
    'probe_requested_at',
  ]) {
    assert.ok(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('saas_probe_monitors', '${column}', 'SELECT')`),
      `probe manifest missing SELECT saas_probe_monitors.${column}`,
    );
  }
  assert.match(
    workerGrantSql,
    /GRANT SELECT \([^)]*\bprobe_requested_at\b[^)]*\)\s+ON TABLE model_router_saas\.saas_probe_monitors/,
  );
  for (const column of [
    'consecutive_failures',
    'last_result',
    'last_result_detail',
    'last_run_at',
    'next_due_at',
    'probe_requested_at',
    'updated_at',
  ]) {
    assert.ok(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('saas_probe_monitors', '${column}', 'UPDATE')`),
      `probe manifest missing UPDATE saas_probe_monitors.${column}`,
    );
  }
  assert.match(
    workerGrantSql,
    /GRANT UPDATE \([^)]*\blast_result_detail\b[^)]*\)\s+ON TABLE model_router_saas\.saas_probe_monitors/,
  );
  // Run history is INSERT-only for the worker; retention DELETE stays on the
  // control-plane role (this role holds no table-level grants by contract).
  for (const column of [
    'id',
    'monitor_id',
    'triggered_by',
    'result',
    'detail',
    'http_status',
    'latency_ms',
    'created_at',
  ]) {
    assert.ok(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('saas_probe_runs', '${column}', 'INSERT')`),
      `probe manifest missing INSERT saas_probe_runs.${column}`,
    );
  }
  assert.match(
    workerGrantSql,
    /GRANT INSERT \([^)]*\btriggered_by\b[^)]*\)\s+ON TABLE model_router_saas\.saas_probe_runs/,
  );
  assert.doesNotMatch(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /\('saas_probe_runs', '[^']+', '(?:SELECT|UPDATE)'\)/,
  );
  assert.doesNotMatch(workerGrantSql, /GRANT (?:SELECT|UPDATE|DELETE)[^;]*saas_probe_runs/);
  // The account unschedulable signal and the egress-proxy join column.
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const [column, privilege] of [
      ['egress_proxy_id', 'SELECT'],
      ['probe_temp_unschedulable_until', 'SELECT'],
      ['probe_temp_unschedulable_until', 'UPDATE'],
    ] as const) {
      assert.ok(
        SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes(`('${table}', '${column}', '${privilege}')`),
        `probe manifest missing ${privilege} ${table}.${column}`,
      );
      assert.match(
        workerGrantSql,
        new RegExp(`GRANT ${privilege} \\([^)]*\\b${column}\\b[^)]*\\)\\s+ON TABLE model_router_saas\\.${table}`),
      );
    }
  }
  // The probe resolves the account's egress proxy (read-only) and records
  // best-effort alert audit rows.
  assert.match(
    workerGrantSql,
    /GRANT SELECT \([^)]*\bauth_sealed_envelope\b[^)]*\)\s+ON TABLE model_router_saas\.saas_egress_proxies/,
  );
  assert.match(
    workerGrantSql,
    /GRANT INSERT \([^)]*\bentry_point\b[^)]*\)\s+ON TABLE model_router_saas\.saas_audit_events/,
  );
});

test('G2 grants the OpenRouter pricing sync worker its append-only catalog and supplier-cost surface only', () => {
  const workerGrantSql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  const probeSql = SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL;
  // The exact column sets the store's service-method statements touch:
  // registerProviderProduct / registerProviderCapability /
  // registerProviderRightsVersion (rights + rights_events) /
  // registerPublicModelAlias (models + versions) / appendSupplierCostVersion.
  const supplierCostColumns = [
    'id',
    'version',
    'public_model_id',
    'public_model_version',
    'provider_id',
    'product_id',
    'resolved_model',
    'protocol',
    'endpoint',
    'currency',
    'commercial_policy_version',
    'calculator_version',
    'rounding_version',
    'rounding_mode',
    'rounding_boundary',
    'input_rate_numerator_minor_units',
    'input_rate_denominator_units',
    'cache_read_rate_numerator_minor_units',
    'cache_read_rate_denominator_units',
    'cache_write_rate_numerator_minor_units',
    'cache_write_rate_denominator_units',
    'cache_write_5m_rate_numerator_minor_units',
    'cache_write_5m_rate_denominator_units',
    'cache_write_1h_rate_numerator_minor_units',
    'cache_write_1h_rate_denominator_units',
    'output_rate_numerator_minor_units',
    'output_rate_denominator_units',
    'effective_at',
    'expires_at',
    'idempotency_key',
    'definition_digest',
    'created_at',
  ];
  const expected: ReadonlyArray<
    readonly [table: string, columns: readonly string[], privileges: readonly ('SELECT' | 'INSERT')[]]
  > = [
    [
      'saas_provider_products',
      ['provider_id', 'product_id', 'display_name', 'status', 'created_at'],
      ['SELECT', 'INSERT'],
    ],
    [
      'saas_provider_rights',
      [
        'rights_id',
        'version',
        'provider_id',
        'product_id',
        'credential_type',
        'supply_mode',
        'region',
        'purpose',
        'model_scope',
        'endpoint_scope',
        'effective_at',
        'expires_at',
        'approval_ref',
        'status',
        'evidence_ref',
        'evidence_sha256',
        'created_at',
      ],
      ['SELECT', 'INSERT'],
    ],
    [
      'saas_provider_rights_events',
      ['id', 'rights_id', 'rights_version', 'from_status', 'to_status', 'event_type', 'occurred_at'],
      ['INSERT'],
    ],
    [
      'saas_provider_capabilities',
      [
        'provider_id',
        'product_id',
        'model',
        'endpoint',
        'protocol',
        'version',
        'support_level',
        'validation_state',
        'evidence_version',
        'discovery_source',
        'evidence_ref',
        'evidence_sha256',
        'created_at',
      ],
      ['SELECT', 'INSERT'],
    ],
    ['saas_public_models', ['id', 'alias', 'display_name', 'status'], ['SELECT']],
    ['saas_public_models', ['id', 'alias', 'display_name', 'status', 'created_at'], ['INSERT']],
    [
      'saas_public_model_versions',
      ['public_model_id', 'version', 'provider_id', 'product_id', 'model', 'endpoint_scope', 'status'],
      ['SELECT'],
    ],
    [
      'saas_public_model_versions',
      ['public_model_id', 'version', 'provider_id', 'product_id', 'model', 'endpoint_scope', 'status', 'created_at'],
      ['INSERT'],
    ],
    ['saas_supplier_cost_versions', supplierCostColumns, ['SELECT', 'INSERT']],
  ];
  // Aggregate every column-scoped grant statement the manifest issues, then
  // require the aggregated sets to be exactly the expected columns — no
  // missing and no excess — for the sync surface tables.
  const grantsByKey = new Map<string, Set<string>>();
  for (const match of workerGrantSql.matchAll(
    /GRANT\s+(SELECT|INSERT|UPDATE)\s*\(([^)]*)\)\s*ON TABLE model_router_saas\.(\w+)\s+TO model_router_saas_validation_worker;/gis,
  )) {
    const key = `${match[3]}\t${(match[1] ?? '').toUpperCase()}`;
    const columns = grantsByKey.get(key) ?? new Set<string>();
    for (const column of (match[2] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)) {
      columns.add(column);
    }
    grantsByKey.set(key, columns);
  }
  for (const [table, columns, privileges] of expected) {
    for (const privilege of privileges) {
      for (const column of columns) {
        assert.ok(
          probeSql.includes(`('${table}', '${column}', '${privilege}')`),
          `probe manifest missing ${privilege} ${table}.${column}`,
        );
      }
      const granted = grantsByKey.get(`${table}\t${privilege}`);
      assert.ok(granted, `grant manifest missing ${privilege} on ${table}`);
      assert.deepEqual(
        [...granted].sort(),
        [...columns].sort(),
        `${privilege} column set on ${table} must match the store's statements exactly`,
      );
    }
  }
  // The exact grant-file INSERT column lists, grant-by-grant (the aggregated
  // set check above is order-insensitive; these pin the lists as written).
  assert.match(
    workerGrantSql,
    /GRANT INSERT \(\s*provider_id, product_id, display_name, status, created_at\s*\) ON TABLE model_router_saas\.saas_provider_products\s+TO model_router_saas_validation_worker;/,
  );
  assert.match(
    workerGrantSql,
    /GRANT INSERT \(\s*rights_id, version, provider_id, product_id, credential_type, supply_mode,\s*region, purpose, model_scope, endpoint_scope, effective_at, expires_at,\s*approval_ref, status, evidence_ref, evidence_sha256, created_at\s*\) ON TABLE model_router_saas\.saas_provider_rights\s+TO model_router_saas_validation_worker;/,
  );
  assert.match(
    workerGrantSql,
    /GRANT INSERT \(\s*provider_id, product_id, model, endpoint, protocol, version, support_level,\s*validation_state, evidence_version, discovery_source, evidence_ref,\s*evidence_sha256, created_at\s*\) ON TABLE model_router_saas\.saas_provider_capabilities\s+TO model_router_saas_validation_worker;/,
  );
  // Append-only surface: the worker never mutates or removes catalog,
  // public-model or supplier-cost rows (versioned appends only), and
  // rights history is INSERT-only with no read path.
  for (const table of [
    'saas_provider_products',
    'saas_provider_rights',
    'saas_provider_rights_events',
    'saas_provider_capabilities',
    'saas_public_models',
    'saas_public_model_versions',
    'saas_supplier_cost_versions',
  ]) {
    assert.doesNotMatch(probeSql, new RegExp(`\\('${table}', '[^']+', '(?:UPDATE|REFERENCES)'\\)`));
    assert.doesNotMatch(
      workerGrantSql,
      new RegExp(`GRANT (?:UPDATE|DELETE|TRUNCATE)[^;]*model_router_saas\\.${table}`, 'i'),
    );
  }
  assert.doesNotMatch(probeSql, /\('saas_provider_rights_events', '[^']+', '(?:SELECT|UPDATE)'\)/);
  assert.doesNotMatch(workerGrantSql, /GRANT (?:SELECT|UPDATE|DELETE)[^;]*saas_provider_rights_events/);
  // The store registers rights without an audit context, so the existing
  // eight-column audit INSERT surface is unchanged.
  assert.equal(
    [...workerGrantSql.matchAll(/GRANT\s+INSERT\s*\(([^)]*)\)\s*ON TABLE model_router_saas\.saas_audit_events/gis)]
      .length,
    1,
  );
  // The deployment note keeps the re-apply/fails-closed contract and points
  // deployments at the opt-in mount.
  assert.match(workerGrantSql, /DEPLOYMENT NOTE \(G2, F6 openRouterModelPricingSync\)/);
  assert.match(workerGrantSql, /openRouterModelPricingSync option unset/);
  // The single EXECUTE exception: the saas_provider_rights /
  // saas_public_model_versions CHECK constraints (migration 008) call the
  // IMMUTABLE validator saas_catalog_valid_scope(text[]) as the inserting
  // role. The grant must follow the blanket REVOKE EXECUTE block so
  // re-applying the template restores it.
  const revokeAllExecuteIndex = workerGrantSql.indexOf('REVOKE EXECUTE ON ALL FUNCTIONS');
  const validatorGrantIndex = workerGrantSql.indexOf(
    'GRANT EXECUTE ON FUNCTION model_router_saas.saas_catalog_valid_scope(text[])',
  );
  assert.ok(revokeAllExecuteIndex >= 0, 'grant manifest missing the blanket routine revoke');
  assert.ok(validatorGrantIndex > revokeAllExecuteIndex, 'validator EXECUTE grant must follow the blanket revoke');
  // The probe exempts exactly this routine from the any-function-privilege
  // invariant and positively requires it to stay executable (fails closed
  // until the template is re-applied).
  assert.match(
    probeSql,
    /routine\.proname = 'saas_catalog_valid_scope'\s+AND pg_catalog\.pg_get_function_identity_arguments\(routine\.oid\) = 'scope_values text\[\]'/,
  );
  assert.match(probeSql, /AS catalog_scope_validator_executable/);
});
