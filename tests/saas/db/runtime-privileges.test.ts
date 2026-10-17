import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL } from '../../../src/saas/db/credential-validation-worker-privileges.js';
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
    [
      ['saas_requests', 'financial_status', 'SELECT'],
      // R9 P7: the recovery worker's guard-enforced financial reconciliation.
      ['saas_requests', 'financial_status', 'UPDATE'],
    ],
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
    'per_unit_rate_numerator_minor_units',
    'per_unit_rate_denominator_units',
    'per_unit_tier_rates',
    'token_multipliers',
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
    // E4 platform governance: disable/enable and operator-set password reset.
    ['saas_users', 'UPDATE', ['password_hash', 'disabled_at', 'updated_at']],
    ['saas_platform_role_assignments', 'SELECT', ['user_id', 'role']],
    ['saas_sessions', 'INSERT', ['id', 'user_id', 'token_hash', 'csrf_token_hash', 'expires_at']],
    ['saas_platform_sessions', 'UPDATE', ['revoked_at']],
    ['saas_mfa_credentials', 'UPDATE', ['verified_at', 'revoked_at', 'last_used_step']],
    ['saas_platform_mfa_setup_tokens', 'UPDATE', ['attempt_count', 'locked_at', 'consumed_at']],
    ['saas_tenants', 'UPDATE', ['status', 'requests_per_minute', 'tokens_per_minute', 'max_concurrent_requests']],
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
    [
      'saas_customer_webhook_tenant_policies',
      'SELECT',
      [
        'tenant_id',
        'enabled',
        'max_active_endpoints',
        'allowed_event_types',
        'max_events_per_minute',
        'max_pending_deliveries',
        'low_balance_threshold_minor_units',
        'revision',
        // ON CONFLICT DO UPDATE reads these from EXCLUDED, which PostgreSQL
        // prices as a SELECT privilege on the underlying column; RETURNING
        // prices updated_at the same way.
        'updated_by_user_id',
        'audit_event_id',
        'updated_at',
      ],
    ],
    [
      'saas_customer_webhook_tenant_policies',
      'UPDATE',
      [
        'enabled',
        'max_active_endpoints',
        'max_events_per_minute',
        'max_pending_deliveries',
        'revision',
        'updated_by_user_id',
        'audit_event_id',
        'updated_at',
      ],
    ],
    [
      'saas_customer_webhook_tenant_policies',
      'INSERT',
      [
        'tenant_id',
        'enabled',
        'max_active_endpoints',
        'max_events_per_minute',
        'max_pending_deliveries',
        'revision',
        'updated_by_user_id',
        'audit_event_id',
      ],
    ],
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
      ['tenant_id', 'event_id', 'event_type', 'schema_version', 'occurred_at', 'payload', 'idempotency_key'],
    ],
    [
      'saas_customer_webhook_events',
      'INSERT',
      [
        'tenant_id',
        'event_id',
        'idempotency_key',
        'event_type',
        'schema_version',
        'occurred_at',
        'payload',
        'api_key_id',
        'service_plan_order_id',
        'refund_id',
        'request_id',
        'project_id',
        'request_supply_mode',
      ],
    ],
    [
      'saas_customer_webhook_deliveries',
      'INSERT',
      [
        'tenant_id',
        'id',
        'event_id',
        'endpoint_id',
        'endpoint_version',
        'secret_version',
        'overlap_secret_version',
        'payload_version',
      ],
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
        'replay_count',
        'last_http_status',
        'last_latency_ms',
        'last_error_code',
        'available_at',
        'lease_token',
        'lease_expires_at',
        'fencing_token',
        'created_at',
        'updated_at',
      ],
    ],
    [
      'saas_customer_webhook_deliveries',
      'UPDATE',
      [
        'state',
        'attempt_count',
        'attempt_sequence',
        'replay_count',
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
    [
      'saas_customer_webhook_tenant_usage',
      'SELECT',
      ['tenant_id', 'pending_deliveries', 'minute_bucket', 'events_in_bucket'],
    ],
    [
      'saas_customer_webhook_tenant_usage',
      'INSERT',
      ['tenant_id', 'minute_bucket', 'events_in_bucket', 'pending_deliveries'],
    ],
    [
      'saas_customer_webhook_tenant_usage',
      'UPDATE',
      ['pending_deliveries', 'minute_bucket', 'events_in_bucket', 'updated_at'],
    ],
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
  // F3: the producer enqueue is mounted; the quota reservation INSERT is
  // exactly the bootstrap-row column set (asserted by the deepEqual above).
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, , privilege]) => table === 'saas_customer_webhook_tenant_usage' && privilege === 'INSERT',
    ),
    [
      ['saas_customer_webhook_tenant_usage', 'tenant_id', 'INSERT'],
      ['saas_customer_webhook_tenant_usage', 'minute_bucket', 'INSERT'],
      ['saas_customer_webhook_tenant_usage', 'events_in_bucket', 'INSERT'],
      ['saas_customer_webhook_tenant_usage', 'pending_deliveries', 'INSERT'],
    ],
    'producer quota bootstrap stays column-scoped',
  );
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, column, privilege]) =>
        table === 'saas_customer_webhook_deliveries' && column === 'replay_count' && privilege === 'UPDATE',
    ),
    true,
    'F4: dead-letter replay is mounted in the managed composition',
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
    // E4 platform governance: operator role revocation.
    ['saas_platform_role_assignments', 'DELETE'],
    // F4: retention pruning deletes bounded terminal delivery/attempt metadata.
    ['saas_customer_webhook_deliveries', 'DELETE'],
    ['saas_customer_webhook_delivery_attempts', 'DELETE'],
    // P3 observability: metrics retention pruning and operator rule deletion.
    ['saas_obs_channel_metrics_1m', 'DELETE'],
    ['saas_obs_channel_metrics_hourly', 'DELETE'],
    ['saas_obs_alert_rules', 'DELETE'],
    // R1 (105): billing group account-pool membership replacement.
    ['saas_billing_group_account_pools', 'DELETE'],
    // R4 (106): verification-code expiry pruning and delivery-failure
    // compensation delete code rows.
    ['saas_email_verification_codes', 'DELETE'],
    // R3 (107): proxy registry lifecycle; in-use proxies are FK-protected.
    ['saas_egress_proxies', 'DELETE'],
    // Batch-2 §2.4 (116): TLS fingerprint profile registry lifecycle. There
    // is no FK from the tri-state account column (0/-1 are sentinels), so
    // deleting a referenced profile leaves the resolver's fail-open default.
    ['saas_tls_fingerprint_profiles', 'DELETE'],
    // R6a (109): probe monitor lifecycle (runs cascade with the monitor) and
    // the 30-day probe run retention cleanup (control-plane retention loop).
    ['saas_probe_monitors', 'DELETE'],
    ['saas_probe_runs', 'DELETE'],
    // (121) composite model routes: registry row lifecycle.
    ['saas_composite_model_routes', 'DELETE'],
  ]);
  assert.deepEqual(SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS, []);
});

test('role template mirrors the control-plane manifest and grants no broad table DML', () => {
  const sql = readFileSync(resolve(process.cwd(), 'deploy/managed-saas-postgres-roles.sql'), 'utf8');
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
    /GRANT\s+DELETE\s+ON\s+TABLE\s+model_router_saas\.(?!saas_billing_spending_freezes\b|saas_refund_wallet_freezes\b|saas_platform_role_assignments\b|saas_customer_webhook_deliveries\b|saas_customer_webhook_delivery_attempts\b|saas_obs_channel_metrics_1m\b|saas_obs_channel_metrics_hourly\b|saas_obs_alert_rules\b|saas_billing_group_account_pools\b|saas_email_verification_codes\b|saas_egress_proxies\b|saas_probe_monitors\b|saas_probe_runs\b)[^\s;]+[^;]*TO\s+model_router_saas_control_plane\b/is,
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
  const sql = readFileSync(resolve(process.cwd(), 'deploy/managed-saas-postgres-roles.sql'), 'utf8');
  const gatewayBlock = sql.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  assert.ok(gatewayBlock);
  assert.doesNotMatch(
    gatewayBlock,
    /\('(saas_tenants|saas_projects|saas_project_inference_policy_versions|saas_api_keys|saas_capacity_policy_audit_details)', '[^']+', '(?:INSERT|UPDATE)'\)/,
  );
});

test('057 requires only gateway evidence-reference INSERT/SELECT; no CP or immutable-fact UPDATE is added', async () => {
  const evidenceGrants = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(
    ([table, column]) => table === 'saas_usage_settlements' && column === 'normal_success_evidence_ref',
  );
  assert.deepEqual(evidenceGrants, [
    ['saas_usage_settlements', 'normal_success_evidence_ref', 'INSERT'],
    ['saas_usage_settlements', 'normal_success_evidence_ref', 'SELECT'],
  ]);
  // 063 adds the minimal control-plane read needed by the operator usage-
  // correction membership check: identity columns only, never a financial
  // column, and never INSERT/UPDATE/DELETE on the immutable settlement facts.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_usage_settlements'),
    [
      ['saas_usage_settlements', 'id', 'SELECT'],
      ['saas_usage_settlements', 'tenant_id', 'SELECT'],
      ['saas_usage_settlements', 'usage_event_id', 'SELECT'],
    ],
    'control-plane settlement access stays limited to correction membership identity reads',
  );
  assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes('saas_usage_settlements'));
  assert.deepEqual(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(
      ([table, , privilege]) => table === 'saas_usage_settlements' && privilege === 'UPDATE',
    ),
    [['saas_usage_settlements', 'settlement_digest', 'UPDATE']],
    'no new immutable-fact UPDATE grant',
  );
  const deployment = readFileSync(resolve(process.cwd(), 'deploy/managed-saas-postgres-roles.sql'), 'utf8');
  const gatewayBlock = deployment.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  assert.ok(gatewayBlock);
  assert.match(gatewayBlock, /\('saas_usage_settlements', 'normal_success_evidence_ref', 'INSERT'\)/);
  assert.match(gatewayBlock, /\('saas_usage_settlements', 'normal_success_evidence_ref', 'SELECT'\)/);
  assert.doesNotMatch(gatewayBlock, /\('saas_usage_settlements', 'normal_success_evidence_ref', 'UPDATE'\)/);
  assert.match(gatewayBlock, /attribute\.attnum > 0 AND NOT attribute\.attisdropped/);
  assert.match(gatewayBlock, /v_columns, 'model_router_saas', v_table, 'model_router_saas_gateway'/);
  for (const unsafe of [
    { missing_column_privilege_count: 1 },
    { missing_read_column_count: 1 },
    { unexpected_column_privilege_count: 1 },
    { unexpected_table_privilege_count: 1 },
    { application_function_execute_count: 1 },
  ])
    await assert.rejects(
      verifySaasRuntimeDatabasePrivileges(databaseReturning(safeGatewayRow(unsafe)), 'gateway'),
      SaasRuntimePrivilegeError,
    );
});

test('058 changes no CP rotation columns and grants neither CP job UPDATE nor gateway key/account UPDATE', () => {
  for (const table of ['saas_tenant_provider_credentials', 'saas_platform_provider_credentials']) {
    for (const column of ['current_version', 'expires_at'])
      assert.ok(
        SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
          ([relation, field, privilege]) => relation === table && field === column && privilege === 'UPDATE',
        ),
      );
  }
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_tenant_provider_credential_validation_jobs' && privilege === 'UPDATE',
    ),
    false,
  );
  // 115 (R-dormant batch 2.2) is the single sanctioned exception: the
  // scheduler's lazy scheduling-threshold pause columns. Every other
  // account-table column — credentials, rotation, quota state — stays
  // gateway-read-only.
  const gatewayAccountUpdates = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(
    ([relation, , privilege]) =>
      privilege === 'UPDATE' &&
      (relation === 'saas_tenant_provider_accounts' || relation === 'saas_platform_provider_accounts'),
  );
  assert.deepEqual(
    gatewayAccountUpdates
      .map(([relation, field]) => [relation, field])
      .sort(([aRelation, aField], [bRelation, bField]) =>
        aRelation === bRelation ? aField.localeCompare(bField) : aRelation.localeCompare(bRelation),
      ),
    [
      ['saas_platform_provider_accounts', 'scheduling_threshold_pause_reason'],
      ['saas_platform_provider_accounts', 'scheduling_threshold_pause_until'],
      ['saas_tenant_provider_accounts', 'scheduling_threshold_pause_reason'],
      ['saas_tenant_provider_accounts', 'scheduling_threshold_pause_until'],
    ],
  );
  for (const table of ['saas_api_keys']) {
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
        ([relation, , privilege]) => relation === table && privilege === 'UPDATE',
      ),
      false,
    );
  }
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

test('recovery worker owns exactly the metering CAS and sweep grants, never wide request reads', () => {
  // R9 P7/P9/P10: the control-plane recovery worker drives the metering guard
  // triggers with narrow CAS statements. Its attempt contract is the snapshot
  // columns plus the terminal transition columns — nothing more.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_attempts'),
    [
      ...[
        'id',
        'tenant_id',
        'request_id',
        'ordinal',
        'result_state',
        'response_started',
        'response_started_at',
        'result_http_status',
        'created_at',
        'updated_at',
        'provider_id',
        'upstream_id',
        'route_config_id',
        'resolved_model',
        'dispatch_state',
        'unknown_reason',
        'state_version',
        'account_owner_kind',
        'account_id',
        'product_id',
      ].map((column) => ['saas_attempts', column, 'SELECT'] as [string, string, string]),
      ...['dispatch_state', 'result_state', 'unknown_reason', 'updated_at', 'state_version'].map(
        (column) => ['saas_attempts', column, 'UPDATE'] as [string, string, string],
      ),
    ],
  );
  for (const column of [
    'account_owner_kind',
    'account_id',
    'product_id',
    'state_version',
    'credential_id',
    'pool_id',
    'payload_sha256',
  ]) {
    assert.equal(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
        ([table, field, privilege]) => table === 'saas_attempts' && field === column && privilege === 'SELECT',
      ) === ['account_owner_kind', 'account_id', 'product_id', 'state_version'].includes(column),
      true,
      `attempt snapshot column contract drifted for ${column}`,
    );
  }
  // Usage snapshots read only the digest scope the worker's observations need.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, column]) => table === 'saas_usage_events' && ['attempt_id', 'event_digest'].includes(column),
    ),
    [
      ['saas_usage_events', 'attempt_id', 'SELECT'],
      ['saas_usage_events', 'event_digest', 'SELECT'],
    ],
  );
  // The stale-admission sweep fails never-dispatched reservations under their
  // own transactions with the fail-closed disposition only.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_gateway_capacity_reservations'),
    [
      ['saas_gateway_capacity_reservations', 'tenant_id', 'SELECT'],
      ['saas_gateway_capacity_reservations', 'request_id', 'SELECT'],
      ['saas_gateway_capacity_reservations', 'state', 'SELECT'],
      ['saas_gateway_capacity_reservations', 'state', 'UPDATE'],
      ['saas_gateway_capacity_reservations', 'updated_at', 'UPDATE'],
    ],
  );
  // R9 P15: the live migration 024/028 prepared-evidence guard FOR SHAREs the
  // claimed-evidence identity window on every saas_attempts UPDATE whose row
  // carries prepared_evidence_id while the control plane runs its CAS writes.
  // The read set is exactly the guard's WHERE key plus its projection; the
  // lock-only UPDATE (created_at) exists solely because PostgreSQL prices a
  // FOR SHARE row lock as UPDATE privilege on at least one column, and the
  // migration 024 immutability trigger freezes created_at, leaving no
  // reachable write path.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, , privilege]) => table === 'saas_prepared_request_evidence' && privilege === 'SELECT',
    ),
    [
      ['saas_prepared_request_evidence', 'tenant_id', 'SELECT'],
      ['saas_prepared_request_evidence', 'id', 'SELECT'],
      ['saas_prepared_request_evidence', 'request_id', 'SELECT'],
      ['saas_prepared_request_evidence', 'attempt_id', 'SELECT'],
      ['saas_prepared_request_evidence', 'attempt_ordinal', 'SELECT'],
      ['saas_prepared_request_evidence', 'claimed_attempt_id', 'SELECT'],
      ['saas_prepared_request_evidence', 'status', 'SELECT'],
      ['saas_prepared_request_evidence', 'expires_at', 'SELECT'],
      ['saas_prepared_request_evidence', 'dispatch_deadline', 'SELECT'],
    ],
    'prepared-request evidence reads are exactly the 024 guard-trigger FOR SHARE set',
  );
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, , privilege]) => table === 'saas_prepared_request_evidence' && privilege === 'UPDATE',
    ),
    [['saas_prepared_request_evidence', 'created_at', 'UPDATE']],
    'the only UPDATE grant is the FOR SHARE row-lock pricing on the immutability-frozen created_at column',
  );
  for (const [table, column, privilege] of SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS) {
    if (table !== 'saas_prepared_request_evidence') continue;
    assert.equal(
      privilege === 'SELECT' || (privilege === 'UPDATE' && column === 'created_at'),
      true,
      `unexpected prepared-request evidence grant ${column} ${privilege}`,
    );
    assert.equal(
      [
        'payload_sha256',
        'statement',
        'statement_sha256',
        'usage_feasible_input_buckets',
        'provider_id',
        'product_id',
        'pool_id',
        'pool_authz_version',
      ].includes(column),
      false,
      `prepared-request evidence column ${column} is not a guard-trigger read`,
    );
  }
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
      ([table, , privilege]) => table === 'saas_prepared_request_evidence' && privilege === 'INSERT',
    ),
    false,
    'control plane never creates prepared-request evidence',
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

test('gateway pricing snapshots have exactly the service INSERT columns and keep immutable facts read-only', () => {
  const snapshots = [
    [
      'saas_request_customer_price_snapshots',
      'CUSTOMER_SNAPSHOT_COLUMNS',
      [
        'id',
        'tenant_id',
        'request_id',
        'customer_price_version',
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
        'hold_input_total',
        'hold_input_uncached',
        'hold_input_cache_read',
        'hold_input_cache_write',
        'hold_input_cache_write_5m',
        'hold_input_cache_write_1h',
        'hold_input_output_total',
        'hold_input_reasoning_output',
        'hold_input_per_unit_units',
        'hold_input_size_tier',
        'hold_amount_minor_units',
        'wallet_hold_required',
        'admission_expires_at',
        'idempotency_key',
        'snapshot_digest',
        'created_at',
        'billing_group_id',
        'rate_multiplier_num',
        'rate_multiplier_den',
        'peak_applied',
        'model_pricing_override_digest',
        'model_pricing_override',
        'group_rpm_limit',
        'group_daily_limit_minor_units',
        'group_weekly_limit_minor_units',
        'group_monthly_limit_minor_units',
        'group_supported_model_scopes',
        'group_fallback_group_id',
      ],
    ],
    [
      'saas_attempt_supplier_cost_snapshots',
      'SUPPLIER_SNAPSHOT_COLUMNS',
      [
        'id',
        'tenant_id',
        'request_id',
        'attempt_id',
        'supplier_cost_version',
        'platform_account_id',
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
        'idempotency_key',
        'snapshot_digest',
        'created_at',
      ],
    ],
  ] as const;
  const pricingSource = readFileSync(resolve(process.cwd(), 'src/saas/pricing/service.ts'), 'utf8');
  const expectedColumns = SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL.match(
    /expected_column_privileges\(table_name, column_name, privilege_type\) AS \(VALUES([\s\S]*?)\),\nexpected_full_insert_tables/,
  )?.[1];
  const fullInsertTables = SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL.match(
    /expected_full_insert_tables\(table_name\) AS \(VALUES ([\s\S]*?)\),/,
  )?.[1];
  assert.ok(expectedColumns && fullInsertTables);

  for (const [table, projection, columns] of snapshots) {
    const grants = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([relation]) => relation === table);
    assert.deepEqual(
      grants.map(([, column, privilege]) => [column, privilege]),
      columns.map((column) => [column, 'INSERT']),
      'no duplicate, future column, UPDATE or other snapshot grant may be added',
    );
    assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes(table), 'existing column SELECT remains required');
    const delimiter = String.fromCharCode(96);
    const serviceColumns = pricingSource.match(
      new RegExp('const ' + projection + ' = ' + delimiter + '([\\s\\S]*?)' + delimiter + ';'),
    )?.[1];
    assert.ok(serviceColumns);
    assert.deepEqual(
      serviceColumns.split(',').map((column) => column.trim()),
      [...columns],
    );
    assert.match(pricingSource, new RegExp('INSERT INTO ' + table + '\\s+\\(\\$\\{' + projection + '\\.replace'));
    assert.deepEqual(
      [...expectedColumns.matchAll(new RegExp("\\('" + table + "', '([^']+)', '([^']+)'\\)", 'g'))].map((match) => [
        match[1],
        match[2],
      ]),
      columns.map((column) => [column, 'INSERT']),
      'the native startup probe requires the same exact column manifest',
    );
    assert.equal(fullInsertTables.includes(table), false, 'never enumerate future columns for snapshot INSERT');
    assert.equal(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.includes("('" + table + "',"), false);
    assert.equal(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(([relation]) => relation === table),
      false,
    );
  }
  for (const table of ['saas_customer_price_versions', 'saas_supplier_cost_versions'] as const) {
    assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes(table));
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
        ([relation, , privilege]) => relation === table && privilege !== 'SELECT',
      ),
      false,
      'gateway must never append or mutate price versions',
    );
  }
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /AS extra_column_privilege/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /AS any_table_level_privilege/);
});

test('gateway snapshot probe retains rejection of missing, unlisted, mutable and broad privileges', async (context) => {
  // Catalog-counter inputs exercise the unchanged verifier, not live PG snapshot INSERTs.
  for (const [name, unsafe] of [
    ['missing snapshot INSERT column', { missing_column_privilege_count: 1 }],
    ['missing snapshot or price-version SELECT column', { missing_read_column_count: 1 }],
    ['future or unlisted snapshot INSERT column', { unexpected_column_privilege_count: 1 }],
    ['snapshot UPDATE', { unexpected_column_privilege_count: 1 }],
    ['snapshot DELETE', { unexpected_delete_privilege_count: 1 }],
    ['table-wide snapshot SELECT/INSERT/UPDATE', { unexpected_table_privilege_count: 1 }],
    ['price-version INSERT/UPDATE', { unexpected_column_privilege_count: 1 }],
    ['price-version DELETE', { unexpected_delete_privilege_count: 1 }],
    ['extra sequence grant', { unexpected_sequence_privilege_count: 1 }],
    ['application function EXECUTE', { application_function_execute_count: 1 }],
  ] as const) {
    await context.test(name, async () => {
      await assert.rejects(
        verifySaasRuntimeDatabasePrivileges(databaseReturning(safeGatewayRow(unsafe)), 'gateway'),
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

test('gateway claim-audit reads require exactly six purpose columns and retain append-only writes', () => {
  const auditGrants = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_audit_events');
  assert.deepEqual(
    auditGrants.filter(([, , privilege]) => privilege === 'SELECT'),
    [
      ['saas_audit_events', 'tenant_id', 'SELECT'],
      ['saas_audit_events', 'action', 'SELECT'],
      ['saas_audit_events', 'target_type', 'SELECT'],
      ['saas_audit_events', 'target_id', 'SELECT'],
      ['saas_audit_events', 'occurred_at', 'SELECT'],
      ['saas_audit_events', 'id', 'SELECT'],
    ],
  );
  assert.deepEqual(
    auditGrants.filter(([, , privilege]) => privilege === 'INSERT').map(([, column]) => column),
    [
      'id',
      'tenant_id',
      'actor_user_id',
      'action',
      'target_type',
      'target_id',
      'occurred_at',
      'source_ip',
      'user_agent',
      'entry_point',
      'request_id',
    ],
    'existing append-only audit INSERT columns remain unchanged',
  );
  assert.equal(
    auditGrants.some(([, , privilege]) => privilege === 'UPDATE'),
    false,
  );
  assert.equal((SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes('saas_audit_events'), false);
  for (const column of ['actor_user_id', 'source_ip', 'user_agent', 'entry_point', 'request_id']) {
    assert.equal(
      auditGrants.some(([, field, privilege]) => field === column && privilege === 'SELECT'),
      false,
    );
  }

  const expectedColumns = SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL.match(
    /expected_column_privileges\(table_name, column_name, privilege_type\) AS \(VALUES([\s\S]*?)\),\nexpected_full_insert_tables/,
  )?.[1];
  const expectedReadTables = SAAS_GATEWAY_RUNTIME_PRIVILEGE_PROBE_SQL.match(
    /expected_read_tables\(table_name\) AS \(VALUES([\s\S]*?)\),\nexpected_column_privileges/,
  )?.[1];
  assert.ok(expectedColumns && expectedReadTables);
  assert.deepEqual(
    [...expectedColumns.matchAll(/\('saas_audit_events', '([^']+)', 'SELECT'\)/g)].map((match) => match[1]).sort(),
    ['action', 'id', 'occurred_at', 'target_id', 'target_type', 'tenant_id'],
  );
  assert.doesNotMatch(expectedReadTables, /saas_audit_events/);
});

test('gateway claim-audit probe rejects catalog-reported missing, private, broad and mutation privileges', async (context) => {
  // These counter results exercise the real verifier, not live PostgreSQL ACLs.
  // Restricted-role positive and per-column negative reads still need PG15/18.
  for (const [name, unsafe] of [
    ['missing purpose SELECT column', { missing_column_privilege_count: 1 }],
    ['private or future unlisted audit SELECT column', { unexpected_column_privilege_count: 1 }],
    ['audit UPDATE column', { unexpected_column_privilege_count: 1 }],
    ['table-wide audit SELECT or UPDATE', { unexpected_table_privilege_count: 1 }],
    ['audit DELETE', { unexpected_delete_privilege_count: 1 }],
    ['audit TRUNCATE', { unexpected_table_privilege_count: 1 }],
    ['custom routine EXECUTE', { application_function_execute_count: 1 }],
    ['gateway key/account management write', { unexpected_column_privilege_count: 1 }],
  ] as const) {
    await context.test(name, async () => {
      await assert.rejects(
        verifySaasRuntimeDatabasePrivileges(databaseReturning(safeGatewayRow(unsafe)), 'gateway'),
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
    // R7: continuous health score and half-open probe state ride the same
    // gateway-owned health relation (098).
    'half_open_probe_at',
    'health_score',
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
    'half_open_probe_at',
    'health_score',
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

test('customer request axes keep CP reads purpose-scoped; only the recovery worker owns state-machine UPDATEs', () => {
  const expected = [
    ...[
      'id',
      'tenant_id',
      'project_id',
      'public_model',
      'protocol',
      'supply_mode',
      // R9 P15: migration 018's provider-binding guard reads `endpoint` and
      // migration 019's dispatch-authority guard reads `supply_profile_id` and
      // `endpoint` from saas_requests with the invoker's privileges whenever
      // this role UPDATEs saas_attempts, so the stale-admission cancel sweep
      // needs SELECT on both even though the worker never projects them.
      'endpoint',
      'supply_profile_id',
      'execution_state',
      'financial_status',
      'reconciliation_state',
      'created_at',
      'updated_at',
      // R9 P7: the unknown-outcome recovery worker's CAS reconciliation reads.
      'state_version',
    ].map((column) => ['saas_requests', column, 'SELECT'].join('\t')),
    // R9 P7/P9/P10: guard-enforced terminal reconciliation writes (execution
    // escalation, operator resolution, stale-admission sweep); the only
    // request columns the control plane may mutate.
    ...['execution_state', 'reconciliation_state', 'financial_status', 'updated_at', 'state_version'].map((column) =>
      ['saas_requests', column, 'UPDATE'].join('\t'),
    ),
  ].sort();
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_requests')
      .map((grant) => grant.join('\t'))
      .sort(),
    expected,
  );
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS.some(([table]) => table === 'saas_requests'),
    false,
  );
  assert.deepEqual(SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS, []);
  assert.ok(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL.includes("('saas_requests', 'reconciliation_state', 'SELECT')"));
  assert.ok(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL.includes("('saas_requests', 'state_version', 'UPDATE')"));
  for (const column of ['proxy_key_id', 'principal_id', 'entitlement_id', 'request_fingerprint']) {
    assert.equal(
      SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(([table, field]) => table === 'saas_requests' && field === column),
      false,
      'customer projection cannot authorize an internal request field',
    );
  }
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /missing_select_count/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /extra_table_privilege/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /aclexplode\(attribute\.attacl\)/);
  assert.match(SAAS_RUNTIME_PRIVILEGE_PROBE_SQL, /missing_function_execute_count/);
});

test('customer reconciliation read does not relax startup rejection of missing or excess authority', async () => {
  for (const unsafe of [
    { missing_select_count: 1 },
    { extra_table_privilege: true },
    { unsafe_delete_privilege: true },
    { missing_function_execute_count: 1 },
    { unsafe_security_definer_function_count: 1 },
    { out_of_schema_function_privilege: true },
  ]) {
    await assert.rejects(
      verifySaasRuntimeDatabasePrivileges(databaseReturning(safeRow(unsafe))),
      SaasRuntimePrivilegeError,
    );
  }
});

test('108 grants the control plane only the opencode_go protocol rules column, never the usage scheduling columns', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const privilege of ['SELECT', 'UPDATE'] as const) {
      assert.ok(
        SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
          ([relation, column, granted]) =>
            relation === table && column === 'opencode_go_protocol_rules' && granted === privilege,
        ),
        `missing ${privilege} ${table}.opencode_go_protocol_rules`,
      );
    }
    // The usage worker owns the scheduling snapshot columns; the control
    // plane never reads or writes them (gateway reads stay dynamic).
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
      assert.equal(
        SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(([relation, field]) => relation === table && field === column),
        false,
        `unexpected control-plane grant ${table}.${column}`,
      );
      assert.equal(
        SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(([relation, field]) => relation === table && field === column),
        false,
        `unexpected gateway write grant ${table}.${column}`,
      );
    }
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
        ([relation, field]) => relation === table && field === 'opencode_go_protocol_rules',
      ),
      false,
      'gateway reads protocol_rules through the dynamic all-column read-table grants only',
    );
  }
});

test('120 grants the control plane only the CN-provider dual-mode config columns, never the quota snapshot columns', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const privilege of ['SELECT', 'UPDATE'] as const) {
      for (const column of [
        'zhipu_account_mode',
        'zhipu_api_protocol',
        'minimax_account_mode',
        'minimax_api_protocol',
      ]) {
        assert.ok(
          SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(
            ([relation, field, granted]) => relation === table && field === column && granted === privilege,
          ),
          `missing ${privilege} ${table}.${column}`,
        );
      }
    }
    // The quota worker owns the scheduling snapshot columns; the control
    // plane never reads or writes them (gateway reads stay dynamic).
    for (const column of [
      'zhipu_5h_used_percent',
      'zhipu_5h_reset_at',
      'zhipu_weekly_used_percent',
      'zhipu_weekly_reset_at',
      'zhipu_usage_updated_at',
      'zhipu_usage_next_due_at',
      'zhipu_usage_failure_count',
      'zhipu_rate_limited_until',
      'minimax_5h_used_percent',
      'minimax_5h_reset_at',
      'minimax_weekly_used_percent',
      'minimax_weekly_reset_at',
      'minimax_usage_updated_at',
      'minimax_usage_next_due_at',
      'minimax_usage_failure_count',
      'minimax_rate_limited_until',
    ]) {
      assert.equal(
        SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.some(([relation, field]) => relation === table && field === column),
        false,
        `unexpected control-plane grant ${table}.${column}`,
      );
      assert.equal(
        SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(([relation, field]) => relation === table && field === column),
        false,
        `unexpected gateway write grant ${table}.${column}`,
      );
    }
  }
});
