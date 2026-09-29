import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
  SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
  SaasRuntimePrivilegeError,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/runtime-privileges.js';
import { PLATFORM_OPERATIONS_SUMMARY_SQL } from '../../../src/saas/platform/operations/summary-service.js';

function safeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    owns_application_schema: false,
    owns_database_objects: false,
    schema_create: false,
    database_create: false,
    database_temp: false,
    truncate_privilege: false,
    extra_table_privilege: false,
    missing_table_privilege_count: 0,
    out_of_schema_table_privilege: false,
    out_of_schema_sequence_privilege: false,
    out_of_schema_function_privilege: false,
    application_table_count: 22,
    missing_select_count: 0,
    missing_insert_count: 0,
    missing_update_count: 0,
    unsafe_delete_privilege: false,
    missing_sequence_privilege_count: 0,
    unexpected_sequence_privilege_count: 0,
    missing_function_execute_count: 0,
    unsafe_security_definer_function_count: 0,
    ...overrides,
  };
}

function databaseReturning(row: unknown) {
  return {
    query: async <Row>() => ({ rows: [row as Row], rowCount: 1 }),
  };
}

function safeGatewayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_exists: true,
    gateway_role: true,
    server_version_supported: true,
    managed_schema: true,
    application_schema_usage: true,
    login_role: true,
    session_role_unchanged: true,
    superuser: false,
    create_database: false,
    create_role: false,
    inherit_role: false,
    replication_role: false,
    bypass_rls: false,
    any_role_membership: false,
    owns_database: false,
    owns_application_schema: false,
    owns_database_objects: false,
    schema_create: false,
    database_create: false,
    database_temp: false,
    missing_required_relation_count: 0,
    missing_column_privilege_count: 0,
    missing_read_column_count: 0,
    missing_full_insert_column_count: 0,
    unexpected_column_privilege_count: 0,
    unexpected_table_privilege_count: 0,
    unexpected_delete_privilege_count: 0,
    missing_spending_freeze_delete: false,
    missing_sequence_usage_count: 0,
    unexpected_sequence_privilege_count: 0,
    application_function_execute_count: 0,
    out_of_schema_table_privilege: false,
    out_of_schema_sequence_privilege: false,
    out_of_schema_function_privilege: false,
    unsafe_security_definer_function_count: 0,
    ...overrides,
  };
}

test('control-plane privilege probe accepts the dedicated least-privilege login role', async () => {
  await verifySaasRuntimeDatabasePrivileges(databaseReturning(safeRow()));
});

test('operations summary has only its exact additional control-plane SELECT grants', () => {
  const dashboardReads = [
    ['saas_requests', 'financial_status', 'r.financial_status'],
    ['saas_provider_account_runtime_health', 'owner_scope_key', 'health.owner_scope_key'],
    ['saas_provider_account_runtime_health', 'owner_kind', 'health.owner_kind'],
    ['saas_provider_account_runtime_health', 'state', 'health.state'],
    ['saas_provider_account_runtime_health', 'cooldown_until', 'health.cooldown_until'],
    ['saas_provider_account_runtime_health', 'observed_at', 'health.observed_at'],
  ] as const;
  for (const [table, column, expression] of dashboardReads) {
    assert.ok(PLATFORM_OPERATIONS_SUMMARY_SQL.includes(expression), `dashboard query must read ${expression}`);
    assert.ok(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
        ([grantedTable, grantedColumn, privilege]) =>
          grantedTable === table && grantedColumn === column && privilege === 'SELECT',
      ),
      `missing dashboard SELECT ${table}.${column}`,
    );
  }

  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_provider_account_runtime_health'),
    [
      ['saas_provider_account_runtime_health', 'owner_scope_key', 'SELECT'],
      ['saas_provider_account_runtime_health', 'owner_kind', 'SELECT'],
      ['saas_provider_account_runtime_health', 'state', 'SELECT'],
      ['saas_provider_account_runtime_health', 'cooldown_until', 'SELECT'],
      ['saas_provider_account_runtime_health', 'observed_at', 'SELECT'],
    ],
  );
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, column]) => table === 'saas_requests' && column === 'financial_status',
    ),
    [['saas_requests', 'financial_status', 'SELECT']],
  );
});

test('commercial price versions allow history reads and append inserts without UPDATE', () => {
  const customerColumns = [
    'id',
    'version',
    'public_model_id',
    'public_model_version',
    'provider_id',
    'product_id',
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
  ].sort();
  for (const [table, columns] of [
    ['saas_customer_price_versions', customerColumns],
    ['saas_supplier_cost_versions', [...customerColumns, 'resolved_model'].sort()],
  ] as const) {
    for (const privilege of ['SELECT', 'INSERT'] as const) {
      assert.deepEqual(
        SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
          ([grantedTable, , grantedPrivilege]) => grantedTable === table && grantedPrivilege === privilege,
        )
          .map(([, column]) => column)
          .sort(),
        columns,
        `${table} must grant only the columns required for ${privilege.toLowerCase()}`,
      );
    }
    assert.equal(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
        ([grantedTable, , privilege]) => grantedTable === table && privilege === 'UPDATE',
      ),
      false,
      `${table} is append-only`,
    );
  }
});

test('control-plane manifest covers startup and representative mounted SQL without lock-only UPDATE grants', () => {
  const hasColumnGrant = (table: string, column: string, privilege: 'SELECT' | 'INSERT' | 'UPDATE') =>
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([grantedTable, grantedColumn, grantedPrivilege]) =>
        grantedTable === table && grantedColumn === column && grantedPrivilege === privilege,
    );
  const requiredColumns: readonly (readonly [string, 'SELECT' | 'INSERT' | 'UPDATE', readonly string[]])[] = [
    ['saas_schema_migrations', 'SELECT', ['version', 'name', 'checksum']],
    ['saas_users', 'SELECT', ['email_canonical', 'password_hash', 'disabled_at']],
    ['saas_users', 'INSERT', ['id', 'email', 'password_hash', 'updated_at']],
    ['saas_platform_role_assignments', 'SELECT', ['user_id', 'role']],
    ['saas_sessions', 'INSERT', ['id', 'user_id', 'token_hash', 'csrf_token_hash', 'expires_at']],
    ['saas_platform_sessions', 'UPDATE', ['revoked_at']],
    ['saas_mfa_credentials', 'UPDATE', ['verified_at', 'revoked_at', 'last_used_step']],
    ['saas_platform_mfa_setup_tokens', 'UPDATE', ['attempt_count', 'locked_at', 'consumed_at']],
    ['saas_tenants', 'UPDATE', ['requests_per_minute', 'tokens_per_minute', 'max_concurrent_requests']],
    ['saas_projects', 'UPDATE', ['inference_policy_version', 'inference_policy_status']],
    ['saas_api_keys', 'INSERT', ['key_hash', 'model_scopes', 'entitlement_id']],
    ['saas_api_keys', 'UPDATE', ['status', 'authz_version', 'last_used_at']],
    ['saas_provider_products', 'INSERT', ['provider_id', 'product_id', 'display_name']],
    ['saas_provider_rights', 'INSERT', ['rights_id', 'version', 'evidence_sha256']],
    ['saas_tenant_provider_accounts', 'UPDATE', ['status', 'validation_state', 'authz_version']],
    ['saas_tenant_provider_credential_versions', 'SELECT', ['wrapped_dek', 'nonce', 'ciphertext', 'auth_tag']],
    ['saas_tenant_provider_credential_validation_jobs', 'INSERT', ['idempotency_key', 'target_model']],
    ['saas_service_plan_versions', 'SELECT', ['id', 'status', 'allowed_models']],
    ['saas_service_plan_orders', 'UPDATE', ['state', 'provider_submission_state', 'checkout_url']],
    ['saas_service_plan_snapshots', 'INSERT', ['snapshot_digest', 'plan_version_id']],
    ['saas_service_plan_subscriptions', 'UPDATE', ['status', 'cancelled_at']],
    ['saas_payment_orders', 'UPDATE', ['provider_order_id', 'provider_submission_lease_token']],
    ['saas_payment_inbox', 'INSERT', ['provider_event_id', 'processing_outcome']],
    ['saas_payment_inbox', 'UPDATE', ['processing_state', 'lease_token', 'processed_at']],
    ['saas_refund_orders', 'INSERT', ['id', 'state', 'blocked_code', 'service_plan_effect_ref']],
    ['saas_refund_orders', 'UPDATE', ['state', 'lease_token', 'completed_at']],
    ['saas_audit_events', 'INSERT', ['action', 'actor_user_id', 'request_id']],
  ];
  for (const [table, privilege, columns] of requiredColumns) {
    for (const column of columns) {
      assert.ok(hasColumnGrant(table, column, privilege), `missing ${privilege} ${table}.${column}`);
    }
  }

  const expectedWebhookColumns: readonly (readonly [string, 'SELECT' | 'INSERT' | 'UPDATE', readonly string[]])[] = [
    ['saas_customer_webhook_tenant_policies', 'SELECT', ['tenant_id', 'enabled', 'max_active_endpoints']],
    ['saas_customer_webhook_tenant_policies', 'UPDATE', ['updated_at']],
    [
      'saas_customer_webhook_endpoints',
      'SELECT',
      ['tenant_id', 'id', 'current_version', 'state', 'created_at', 'updated_at'],
    ],
    [
      'saas_customer_webhook_endpoints',
      'INSERT',
      ['tenant_id', 'id', 'current_version', 'state', 'created_by_user_id'],
    ],
    ['saas_customer_webhook_endpoints', 'UPDATE', ['current_version', 'state', 'updated_at']],
    [
      'saas_customer_webhook_endpoint_versions',
      'SELECT',
      ['tenant_id', 'endpoint_id', 'version', 'target_url', 'event_types'],
    ],
    [
      'saas_customer_webhook_endpoint_versions',
      'INSERT',
      ['tenant_id', 'endpoint_id', 'version', 'target_url', 'event_types', 'created_by_user_id', 'audit_event_id'],
    ],
    [
      'saas_customer_webhook_signing_secrets',
      'SELECT',
      ['tenant_id', 'endpoint_id', 'secret_version', 'state', 'overlap_expires_at', 'encrypted_envelope', 'created_at'],
    ],
    [
      'saas_customer_webhook_signing_secrets',
      'INSERT',
      ['tenant_id', 'endpoint_id', 'secret_version', 'state', 'encrypted_envelope', 'audit_event_id'],
    ],
    ['saas_customer_webhook_signing_secrets', 'UPDATE', ['state', 'overlap_expires_at']],
    [
      'saas_customer_webhook_events',
      'SELECT',
      ['tenant_id', 'event_id', 'event_type', 'schema_version', 'occurred_at', 'payload'],
    ],
    [
      'saas_customer_webhook_deliveries',
      'SELECT',
      [
        'tenant_id',
        'id',
        'event_id',
        'endpoint_id',
        'endpoint_version',
        'secret_version',
        'overlap_secret_version',
        'payload_version',
        'state',
        'attempt_count',
        'attempt_sequence',
        'last_http_status',
        'last_latency_ms',
        'last_error_code',
        'available_at',
        'lease_token',
        'lease_expires_at',
        'fencing_token',
        'created_at',
      ],
    ],
    [
      'saas_customer_webhook_deliveries',
      'UPDATE',
      [
        'state',
        'attempt_count',
        'attempt_sequence',
        'available_at',
        'lease_token',
        'lease_expires_at',
        'fencing_token',
        'last_http_status',
        'last_latency_ms',
        'last_error_code',
        'delivered_at',
        'updated_at',
      ],
    ],
    [
      'saas_customer_webhook_delivery_attempts',
      'SELECT',
      ['tenant_id', 'delivery_id', 'fencing_token', 'lease_token', 'state'],
    ],
    [
      'saas_customer_webhook_delivery_attempts',
      'INSERT',
      ['tenant_id', 'delivery_id', 'attempt_sequence', 'fencing_token', 'lease_token', 'state'],
    ],
    [
      'saas_customer_webhook_delivery_attempts',
      'UPDATE',
      ['state', 'http_status', 'latency_ms', 'error_code', 'finished_at'],
    ],
    ['saas_customer_webhook_tenant_usage', 'SELECT', ['tenant_id', 'pending_deliveries']],
    ['saas_customer_webhook_tenant_usage', 'UPDATE', ['pending_deliveries', 'updated_at']],
  ];
  const expectedWebhookGrants = expectedWebhookColumns
    .flatMap(([table, privilege, columns]) => columns.map((column) => `${table}\t${column}\t${privilege}`))
    .sort();
  const actualWebhookGrants = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) =>
    table.startsWith('saas_customer_webhook_'),
  )
    .map(([table, column, privilege]) => `${table}\t${column}\t${privilege}`)
    .sort();
  assert.deepEqual(actualWebhookGrants, expectedWebhookGrants);
  for (const immutableTable of ['saas_customer_webhook_events', 'saas_customer_webhook_endpoint_versions']) {
    assert.equal(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
        ([table, , privilege]) => table === immutableTable && privilege === 'UPDATE',
      ),
      false,
      `${immutableTable} must remain immutable`,
    );
  }
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_customer_webhook_tenant_usage' && privilege === 'INSERT',
    ),
    false,
    'the mounted worker only decrements usage; the event producer is not mounted here',
  );
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, column, privilege]) =>
        table === 'saas_customer_webhook_deliveries' && column === 'replay_count' && privilege === 'UPDATE',
    ),
    false,
    'replay is not mounted in the managed composition',
  );

  assert.equal(hasColumnGrant('saas_service_plan_versions', 'id', 'INSERT'), false);
  assert.equal(hasColumnGrant('saas_tenant_provider_credentials', 'ciphertext', 'SELECT'), false);

  assert.ok(hasColumnGrant('saas_platform_role_assignments', 'role', 'SELECT'));
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_platform_role_assignments' && privilege === 'UPDATE',
    ),
    false,
  );
  assert.ok(hasColumnGrant('saas_project_inference_policy_versions', 'version', 'SELECT'));
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_project_inference_policy_versions' && privilege === 'UPDATE',
    ),
    false,
  );
  assert.deepEqual(SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS, [
    ['saas_billing_spending_freezes', 'DELETE'],
    ['saas_refund_wallet_freezes', 'DELETE'],
  ]);
  assert.deepEqual(SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS, []);
});

test('role template mirrors the control-plane manifest and grants no broad table DML', () => {
  const sql = readFileSync(new URL('../../../deploy/managed-saas-postgres-roles.sql', import.meta.url), 'utf8');
  const grantBlock = sql.match(/DO \$control_plane_runtime_grants\$([\s\S]*?)\$control_plane_runtime_grants\$/)?.[1];
  assert.ok(grantBlock);
  const deployedGrants = [...grantBlock.matchAll(/\('([^']+)', '(SELECT|INSERT|UPDATE)', '([^']+)'\)/g)]
    .flatMap((match) => match[3].split(/\s+/).map((column) => `${match[1]}\t${column}\t${match[2]}`))
    .sort();
  const expectedGrants = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.map(
    ([table, column, privilege]) => `${table}\t${column}\t${privilege}`,
  ).sort();
  assert.deepEqual(deployedGrants, expectedGrants);
  const deployedTableGrants = [...grantBlock.matchAll(/\('([^']+)', '(DELETE)'\)/g)]
    .map((match) => [match[1], match[2]])
    .sort(([leftTable], [rightTable]) => leftTable.localeCompare(rightTable));
  assert.deepEqual(
    deployedTableGrants,
    [...SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS].sort(([a], [b]) => a.localeCompare(b)),
  );
  assert.match(grantBlock, /'saas_schema_migrations', 'SELECT', 'version name checksum'/);
  assert.match(grantBlock, /SELECT NULL::text AS sequence_name, NULL::text AS privilege_type WHERE FALSE/);
  assert.doesNotMatch(
    sql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE))*\s+ON\s+(?:ALL\s+)?(?:TABLES|TABLE\b)[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.doesNotMatch(
    sql,
    /GRANT\s+DELETE\s+ON\s+TABLE\s+model_router_saas\.(?!saas_billing_spending_freezes\b|saas_refund_wallet_freezes\b)[^\s;]+[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.doesNotMatch(
    sql,
    /GRANT\s+(?:USAGE|SELECT|UPDATE)\s+ON\s+(?:ALL\s+)?SEQUENCES?[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE\s+ON\s+(?:ALL\s+)?FUNCTIONS?[^;]*TO\s+model_router_saas_control_plane\b/is);
  assert.doesNotMatch(sql, /ALTER DEFAULT PRIVILEGES[\s\S]*?\bGRANT\b[^;]*TO\s+model_router_saas_control_plane\b/is);
});

test('gateway manifest contains no capacity-policy writes', () => {
  const capacityPolicyTables = new Set([
    'saas_tenants',
    'saas_projects',
    'saas_project_inference_policy_versions',
    'saas_api_keys',
    'saas_capacity_policy_audit_details',
  ]);
  assert.equal(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => capacityPolicyTables.has(table) && (privilege === 'INSERT' || privilege === 'UPDATE'),
    ),
    false,
  );
  assert.equal(
    (SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes('saas_capacity_policy_audit_details'),
    false,
  );
  const sql = readFileSync(new URL('../../../deploy/managed-saas-postgres-roles.sql', import.meta.url), 'utf8');
  const gatewayBlock = sql.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  assert.ok(gatewayBlock);
  assert.doesNotMatch(
    gatewayBlock,
    /\('(saas_tenants|saas_projects|saas_project_inference_policy_versions|saas_api_keys|saas_capacity_policy_audit_details)', '[^']+', '(?:INSERT|UPDATE)'\)/,
  );
});

test('control-plane unknown-outcome grants match the scanner and append-only observation contract', () => {
  const expectedGrants = [
    ...[
      'id',
      'tenant_id',
      'project_id',
      'request_id',
      'supply_mode',
      'case_state',
      'scan_attempt_count',
      'next_attempt_at',
      'lease_token',
      'lease_expires_at',
      'last_error_code',
      'created_at',
      'resolution_idempotency_key',
      'resolution_digest',
      'resolution_support_ticket_ref',
    ].map((column) => ['saas_unknown_outcome_reconciliation_cases', column, 'SELECT']),
    ...[
      'id',
      'tenant_id',
      'project_id',
      'request_id',
      'supply_mode',
      'case_state',
      'scan_attempt_count',
      'next_attempt_at',
      'created_at',
      'updated_at',
    ].map((column) => ['saas_unknown_outcome_reconciliation_cases', column, 'INSERT']),
    ...[
      'case_state',
      'scan_attempt_count',
      'next_attempt_at',
      'lease_token',
      'lease_expires_at',
      'last_error_code',
      'resolution_idempotency_key',
      'resolution_digest',
      'resolution_support_ticket_ref',
      'resolution_actor_user_id',
      'resolution_reason',
      'resolution_evidence_digest',
      'resolution_audit_event_id',
      'resolved_at',
      'updated_at',
    ].map((column) => ['saas_unknown_outcome_reconciliation_cases', column, 'UPDATE']),
    ...[
      'id',
      'tenant_id',
      'case_id',
      'observation_kind',
      'observed_at',
      'attempt_id',
      'usage_event_id',
      'supply_mode',
      'execution_state',
      'reconciliation_state',
      'financial_status',
      'request_state_version',
      'dispatch_state',
      'result_state',
      'response_started',
      'attempt_state_version',
      'upstream_id',
      'account_owner_kind',
      'account_id',
      'provider_id',
      'product_id',
      'resolved_model',
      'attempt_unknown_reason',
      'usage_event_digest',
      'provider_status',
      'provider_operation_id',
      'provider_identity_digest',
      'provider_usage',
      'evidence_reference',
      'operator_outcome',
      'actor_user_id',
      'reason',
      'audit_event_id',
      'support_ticket_ref',
    ].map((column) => ['saas_unknown_outcome_reconciliation_observations', column, 'SELECT']),
    ...[
      'id',
      'tenant_id',
      'case_id',
      'request_id',
      'attempt_id',
      'usage_event_id',
      'observation_kind',
      'supply_mode',
      'execution_state',
      'reconciliation_state',
      'financial_status',
      'request_state_version',
      'dispatch_state',
      'result_state',
      'response_started',
      'attempt_state_version',
      'upstream_id',
      'account_owner_kind',
      'account_id',
      'provider_id',
      'product_id',
      'resolved_model',
      'attempt_unknown_reason',
      'usage_event_digest',
      'evidence_reference',
      'operator_outcome',
      'actor_user_id',
      'reason',
      'audit_event_id',
      'support_ticket_ref',
      'observed_at',
      'provider_status',
      'provider_operation_id',
      'provider_identity_digest',
      'provider_usage',
    ].map((column) => ['saas_unknown_outcome_reconciliation_observations', column, 'INSERT']),
  ].map(([table, column, privilege]) => `${table}\t${column}\t${privilege}`);
  const relationNames = new Set([
    'saas_unknown_outcome_reconciliation_cases',
    'saas_unknown_outcome_reconciliation_observations',
  ]);
  const actualGrants = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => relationNames.has(table))
    .map(([table, column, privilege]) => `${table}\t${column}\t${privilege}`)
    .sort();

  assert.deepEqual(actualGrants, expectedGrants.sort());
  for (const relation of relationNames) {
    assert.equal(
      (SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS as readonly (readonly [string, string, string])[]).some(
        ([table]) => table === relation,
      ),
      true,
      `${relation} must be granted explicitly to control-plane`,
    );
    assert.equal(
      (SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes(relation),
      false,
      `${relation} must not be on the gateway broad read list`,
    );
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(([table]) => table === relation),
      false,
      `${relation} must not receive any gateway column grant`,
    );
  }
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_unknown_outcome_reconciliation_observations' && privilege === 'UPDATE',
    ),
    false,
    'observations are append-only and must never receive UPDATE',
  );
});

test('gateway probe is selected only by the optional workload role and defaults to control-plane policy', async () => {
  const seen: string[] = [];
  const database = {
    query: async <Row>(sql: string) => {
      seen.push(sql);
      return {
        rows: [(sql === SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL ? safeGatewayRow() : safeRow()) as Row],
        rowCount: 1,
      };
    },
  };

  await verifySaasRuntimeDatabasePrivileges(database);
  await verifySaasRuntimeDatabasePrivileges(database, 'gateway');
  assert.deepEqual(seen, [SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL]);
});

test('gateway probe fails closed on every missing or forbidden privilege class', async (context) => {
  const unsafeRows = [
    ['wrong role', { gateway_role: false }],
    ['NOINHERIT disabled', { inherit_role: true }],
    ['role membership', { any_role_membership: true }],
    ['schema USAGE missing', { application_schema_usage: false }],
    ['missing required relation', { missing_required_relation_count: 1 }],
    ['missing named column grant', { missing_column_privilege_count: 1 }],
    ['missing read grant', { missing_read_column_count: 1 }],
    ['missing evidence insert grant', { missing_full_insert_column_count: 1 }],
    ['unlisted column access', { unexpected_column_privilege_count: 1 }],
    ['table-wide privilege', { unexpected_table_privilege_count: 1 }],
    ['DELETE outside freeze table', { unexpected_delete_privilege_count: 1 }],
    ['freeze cleanup unavailable', { missing_spending_freeze_delete: true }],
    ['lease sequence unavailable', { missing_sequence_usage_count: 1 }],
    ['extra sequence privilege', { unexpected_sequence_privilege_count: 1 }],
    ['application function execution', { application_function_execute_count: 1 }],
    ['outside-schema table privilege', { out_of_schema_table_privilege: true }],
    ['outside-schema sequence privilege', { out_of_schema_sequence_privilege: true }],
    ['outside-schema function execution', { out_of_schema_function_privilege: true }],
    ['schema owner', { owns_application_schema: true }],
    ['database temporary objects', { database_temp: true }],
  ] as const;

  for (const [name, override] of unsafeRows) {
    await context.test(name, async () => {
      await assert.rejects(
        verifySaasRuntimeDatabasePrivileges(databaseReturning(safeGatewayRow(override)), 'gateway'),
        SaasRuntimePrivilegeError,
      );
    });
  }
});

test('gateway affinity probe fails closed for missing and excessive column/table privileges', async (context) => {
  const unsafeRows = [
    ['missing affinity SELECT column', { missing_column_privilege_count: 1, missing_read_column_count: 1 }],
    ['missing affinity INSERT column', { missing_column_privilege_count: 1 }],
    ['missing affinity UPDATE column', { missing_column_privilege_count: 1 }],
    ['excess affinity SELECT, INSERT, or UPDATE column', { unexpected_column_privilege_count: 1 }],
    ['table-wide affinity grant', { unexpected_table_privilege_count: 1 }],
    ['affinity DELETE grant', { unexpected_delete_privilege_count: 1 }],
    ['affinity TRUNCATE grant', { unexpected_table_privilege_count: 1 }],
  ] as const;

  for (const [name, override] of unsafeRows) {
    await context.test(name, async () => {
      await assert.rejects(
        verifySaasRuntimeDatabasePrivileges(databaseReturning(safeGatewayRow(override)), 'gateway'),
        SaasRuntimePrivilegeError,
      );
    });
  }
});

test('gateway manifest permits encrypted-envelope reads but never grants control-plane or provider-secret mutation', () => {
  assert.deepEqual(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_schema_migrations'),
    [
      ['saas_schema_migrations', 'version', 'SELECT'],
      ['saas_schema_migrations', 'name', 'SELECT'],
      ['saas_schema_migrations', 'checksum', 'SELECT'],
    ],
  );
  assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes('saas_tenant_provider_credential_versions'));
  assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes('saas_platform_provider_credential_versions'));
  assert.ok(SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.every(([, , verb]) => ['SELECT', 'INSERT', 'UPDATE'].includes(verb)));
  assert.equal(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
      ([table, , verb]) =>
        [
          'saas_users',
          'saas_memberships',
          'saas_project_memberships',
          'saas_api_keys',
          'saas_tenant_provider_credentials',
          'saas_tenant_provider_credential_versions',
          'saas_platform_provider_credentials',
          'saas_platform_provider_credential_versions',
        ].includes(table) && verb !== 'SELECT',
    ),
    false,
  );
  assert.match(SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL, /saas_provider_account_runtime_health/);
  const healthColumnGrants = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(
    ([table]) => table === 'saas_provider_account_runtime_health',
  );
  const columnsFor = (verb: 'SELECT' | 'INSERT' | 'UPDATE') =>
    healthColumnGrants
      .filter(([, , grantedVerb]) => grantedVerb === verb)
      .map(([, column]) => column)
      .sort();
  const rowColumns = [
    'account_id',
    'cooldown_until',
    'failure_count',
    'last_outcome',
    'observed_at',
    'owner_kind',
    'owner_scope_key',
    'owner_tenant_id',
    'revision',
    'source_fencing_token',
    'state',
  ];
  assert.deepEqual(columnsFor('SELECT'), rowColumns);
  assert.deepEqual(columnsFor('INSERT'), rowColumns);
  assert.deepEqual(columnsFor('UPDATE'), [
    'cooldown_until',
    'failure_count',
    'last_outcome',
    'observed_at',
    'revision',
    'source_fencing_token',
    'state',
  ]);

  assert.equal(
    (SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes('saas_gateway_provider_account_affinity'),
    false,
  );
  const affinityColumnGrants = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(
    ([table]) => table === 'saas_gateway_provider_account_affinity',
  );
  const affinityColumnsFor = (verb: 'SELECT' | 'INSERT' | 'UPDATE') =>
    affinityColumnGrants
      .filter(([, , grantedVerb]) => grantedVerb === verb)
      .map(([, column]) => column)
      .sort();
  assert.deepEqual(affinityColumnsFor('SELECT'), [
    'account_id',
    'account_owner_kind',
    'expires_at',
    'fencing_token',
    'hmac_key_version',
    'key_digest',
    'product_id',
    'project_id',
    'protocol',
    'provider_id',
    'public_model',
    'public_model_id',
    'public_model_version',
    'reference_kind',
    'revision',
    'route_config_id',
    'route_config_version',
    'state',
    'supply_mode',
    'supply_profile_id',
    'target_mode',
    'tenant_id',
    'upstream_id',
  ]);
  assert.deepEqual(affinityColumnsFor('INSERT'), [
    'account_id',
    'account_owner_kind',
    'created_at',
    'expires_at',
    'fencing_token',
    'hmac_key_version',
    'key_digest',
    'product_id',
    'project_id',
    'protocol',
    'provider_id',
    'public_model',
    'public_model_id',
    'public_model_version',
    'reference_kind',
    'revision',
    'route_config_id',
    'route_config_version',
    'state',
    'supply_mode',
    'supply_profile_id',
    'target_mode',
    'tenant_id',
    'updated_at',
    'upstream_id',
  ]);
  assert.deepEqual(affinityColumnsFor('UPDATE'), [
    'account_id',
    'expires_at',
    'fencing_token',
    'revision',
    'state',
    'updated_at',
  ]);
  assert.match(SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL, /saas_gateway_provider_account_affinity/);
});

test('control-plane privilege probe rejects every known privilege escalation shape', async (context) => {
  const unsafeRows = [
    ['missing role', { role_exists: false }],
    ['wrong application schema', { managed_schema: false }],
    ['unsupported PostgreSQL version', { server_version_supported: false }],
    ['non-login role', { login_role: false }],
    ['role switch', { session_role_unchanged: false }],
    ['superuser', { superuser: true }],
    ['database creation', { create_database: true }],
    ['role administration', { create_role: true }],
    ['replication protocol', { replication_role: true }],
    ['row security bypass', { bypass_rls: true }],
    ['role membership', { any_role_membership: true }],
    ['database ownership', { owns_database: true }],
    ['schema ownership', { owns_application_schema: true }],
    ['object ownership', { owns_database_objects: true }],
    ['schema DDL', { schema_create: true }],
    ['database CREATE', { database_create: true }],
    ['temporary objects', { database_temp: true }],
    ['TRUNCATE', { truncate_privilege: true }],
    ['extra table privileges', { extra_table_privilege: true }],
    ['outside-schema table access', { out_of_schema_table_privilege: true }],
    ['outside-schema sequence access', { out_of_schema_sequence_privilege: true }],
    ['outside-schema function execution', { out_of_schema_function_privilege: true }],
    ['empty application schema', { application_table_count: 0 }],
    ['missing SELECT', { missing_select_count: 1 }],
    ['missing INSERT', { missing_insert_count: 1 }],
    ['missing UPDATE', { missing_update_count: 1 }],
    ['DELETE on any application table', { unsafe_delete_privilege: true }],
    ['missing explicit table privilege', { missing_table_privilege_count: 1 }],
    ['missing explicit sequence privilege', { missing_sequence_privilege_count: 1 }],
    ['unexpected sequence privilege', { unexpected_sequence_privilege_count: 1 }],
    ['application function execution', { missing_function_execute_count: 1 }],
    ['SECURITY DEFINER application routines', { unsafe_security_definer_function_count: 1 }],
  ] as const;

  for (const [name, override] of unsafeRows) {
    await context.test(name, async () => {
      await assert.rejects(
        verifySaasRuntimeDatabasePrivileges(databaseReturning(safeRow(override))),
        SaasRuntimePrivilegeError,
      );
    });
  }
});

test('production privilege probe fails closed on query errors, missing rows, and malformed results', async () => {
  await assert.rejects(
    verifySaasRuntimeDatabasePrivileges({ query: async () => ({ rows: [], rowCount: 0 }) }),
    SaasRuntimePrivilegeError,
  );
  await assert.rejects(
    verifySaasRuntimeDatabasePrivileges({
      query: async () => {
        throw new Error('secret-bearing connection error');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SaasRuntimePrivilegeError);
      assert.equal(error.message.includes('secret-bearing'), false);
      return true;
    },
  );
  await assert.rejects(
    verifySaasRuntimeDatabasePrivileges(databaseReturning(safeRow({ schema_create: 'false' }))),
    SaasRuntimePrivilegeError,
  );
  await assert.rejects(
    verifySaasRuntimeDatabasePrivileges(databaseReturning(safeRow({ application_table_count: '00' }))),
    SaasRuntimePrivilegeError,
  );
});

test('probe pins the effective path and inspects role, ownership, and effective privileges', () => {
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /current_user = session_user/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /WITH RECURSIVE runtime_role/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /current_user = 'model_router_saas_control_plane'/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /SELECT NOT rolinherit FROM runtime_role/);
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /expected_column_privileges\(table_name, column_name, privilege_type\)/,
  );
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /expected_table_privileges\(table_name, privilege_type\)/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /expected_sequence_privileges\(sequence_name, privilege_type\)/);
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /has_column_privilege\(current_user, actual\.oid, actual\.attnum, 'UPDATE'\)/,
  );
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /pg_catalog\.pg_auth_members/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /pg_catalog\.current_setting\('search_path'\) = 'model_router_saas'/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /pg_catalog\.current_schemas\(true\)/);
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /pg_catalog\.has_table_privilege\(current_user, relation\.oid, 'TRUNCATE'\)/,
  );
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /pg_catalog\.has_schema_privilege\(current_user, namespace\.oid, 'CREATE'\)/,
  );
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /pg_catalog\.has_sequence_privilege\(current_user, sequence\.oid, privilege\.privilege_type\)/,
  );
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /pg_catalog\.has_function_privilege\(current_user, proc\.oid, 'EXECUTE'\)/,
  );
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /pg_catalog\.aclexplode\(attribute\.attacl\)/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /'MAINTAIN'/);
  assert.match(
    SAAS_RUNTIME_PRIVILEGE_PROBE_SQL,
    /proc\.prosecdef\s+AND pg_catalog\.has_function_privilege\(current_user, proc\.oid, 'EXECUTE'\)/,
  );
  assert.match(
    SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL,
    /routine\.prosecdef\s+AND pg_catalog\.has_function_privilege\(current_user, routine\.oid, 'EXECUTE'\)/,
  );
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /server_version_supported/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /out_of_schema_function_privilege/);
});
