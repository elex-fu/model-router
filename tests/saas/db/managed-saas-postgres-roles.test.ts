import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
} from '../../../src/saas/db/runtime-privileges.js';

const roleTemplate = readFileSync(resolve(process.cwd(), 'deploy/managed-saas-postgres-roles.sql'), 'utf8');

test('managed PostgreSQL role template creates distinct least-privilege principals and schema ownership', () => {
  assert.match(roleTemplate, /managed SaaS requires PostgreSQL 15 or later/);
  assert.match(
    roleTemplate,
    /CREATE ROLE model_router_saas_migrator\s+LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(
    roleTemplate,
    /CREATE ROLE model_router_saas_control_plane\s+LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(
    roleTemplate,
    /CREATE ROLE model_router_saas_gateway\s+LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(
    roleTemplate,
    /CREATE SCHEMA IF NOT EXISTS model_router_saas\s+AUTHORIZATION model_router_saas_migrator/,
  );
  assert.match(
    roleTemplate,
    /ALTER ROLE model_router_saas_control_plane IN DATABASE %I SET search_path TO model_router_saas/,
  );
  assert.match(roleTemplate, /WHERE membership\.member IN \(v_migrator_oid, v_runtime_oid, v_gateway_oid\)/);
  assert.match(
    roleTemplate,
    /routine\.prosecdef\s+AND pg_catalog\.has_function_privilege\(v_runtime_oid, routine\.oid, 'EXECUTE'\)/,
  );
  const functionRevokeOffset = roleTemplate.indexOf(
    'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA model_router_saas\n    FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;',
  );
  const securityDefinerGuardOffset = roleTemplate.indexOf('routine.prosecdef');
  assert.ok(functionRevokeOffset >= 0 && functionRevokeOffset < securityDefinerGuardOffset);
  assert.match(roleTemplate, /pg_catalog\.aclexplode\(attribute\.attacl\)/);
  assert.match(roleTemplate, /'MAINTAIN'/);
  assert.match(roleTemplate, /has_schema_privilege\(v_runtime_oid, app_namespace\.oid, 'USAGE'\)/);
  assert.match(
    roleTemplate,
    /ALTER ROLE model_router_saas_gateway IN DATABASE %I SET search_path TO model_router_saas/,
  );
  assert.match(
    roleTemplate,
    /has_table_privilege\(v_gateway_oid, relation\.oid, 'DELETE'\)[\s\S]+relation\.relname <> 'saas_billing_spending_freezes'/,
  );
});

test('control-plane grants mirror the source-backed column, table and sequence manifests', () => {
  const grantBlockStart = roleTemplate.indexOf('DO $control_plane_runtime_grants$');
  const grantBlockEnd = roleTemplate.indexOf('$control_plane_runtime_grants$;', grantBlockStart);
  assert.ok(grantBlockStart >= 0 && grantBlockEnd > grantBlockStart);
  const grantBlock = roleTemplate.slice(grantBlockStart, grantBlockEnd);

  const deployedColumnGrants = [...grantBlock.matchAll(/\('([^']+)', '(SELECT|INSERT|UPDATE)', '([^']+)'\)/g)]
    .flatMap((match) => match[3].split(/\s+/).map((column) => `${match[1]}\t${column}\t${match[2]}`))
    .sort();
  const expectedDashboardReadGrants = [
    ['saas_requests', 'financial_status', 'SELECT'],
    ['saas_provider_account_runtime_health', 'owner_scope_key', 'SELECT'],
    ['saas_provider_account_runtime_health', 'owner_kind', 'SELECT'],
    ['saas_provider_account_runtime_health', 'state', 'SELECT'],
    ['saas_provider_account_runtime_health', 'cooldown_until', 'SELECT'],
    ['saas_provider_account_runtime_health', 'observed_at', 'SELECT'],
  ] as const;
  const expectedDashboardReadGrantKeys = expectedDashboardReadGrants
    .map(([table, column, privilege]) => `${table}\t${column}\t${privilege}`)
    .sort();
  const healthGrantPrefix = 'saas_provider_account_runtime_health\t';
  assert.deepEqual(
    deployedColumnGrants.filter((grant) => grant.startsWith(healthGrantPrefix)),
    expectedDashboardReadGrantKeys.filter((grant) => grant.startsWith(healthGrantPrefix)),
  );
  assert.deepEqual(
    deployedColumnGrants.filter((grant) => expectedDashboardReadGrantKeys.includes(grant)),
    expectedDashboardReadGrantKeys,
  );
  assert.deepEqual(
    deployedColumnGrants,
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.map(
      ([table, column, privilege]) => `${table}\t${column}\t${privilege}`,
    ).sort(),
  );

  const deployedTableGrants = [...grantBlock.matchAll(/\('([^']+)', '(DELETE)'\)/g)]
    .map((match) => [match[1], match[2]])
    .sort(([leftTable], [rightTable]) => leftTable.localeCompare(rightTable));
  assert.deepEqual(
    deployedTableGrants,
    [...SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS].sort(([leftTable], [rightTable]) =>
      leftTable.localeCompare(rightTable),
    ),
  );
  assert.deepEqual(SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS, []);
  assert.match(grantBlock, /'saas_schema_migrations', 'SELECT', 'version name checksum'/);
  assert.match(grantBlock, /SELECT NULL::text AS sequence_name, NULL::text AS privilege_type WHERE FALSE/);
  assert.match(grantBlock, /GRANT %s \(%s\) ON TABLE %I\.%I TO %I/);
  assert.match(grantBlock, /GRANT %s ON TABLE %I\.%I TO %I/);

  const webhookGrants = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) =>
    table.startsWith('saas_customer_webhook_'),
  );
  assert.deepEqual(
    webhookGrants.filter(
      ([table, , privilege]) => table === 'saas_customer_webhook_tenant_policies' && privilege === 'UPDATE',
    ),
    [['saas_customer_webhook_tenant_policies', 'updated_at', 'UPDATE']],
  );
  assert.equal(
    SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS.some(([table]) => table.startsWith('saas_customer_webhook_')),
    false,
  );
  for (const immutableTable of ['saas_customer_webhook_events', 'saas_customer_webhook_endpoint_versions']) {
    assert.equal(
      webhookGrants.some(([table, , privilege]) => table === immutableTable && privilege === 'UPDATE'),
      false,
      `${immutableTable} must not receive UPDATE`,
    );
  }
  assert.equal(
    webhookGrants.some(
      ([table, , privilege]) => table === 'saas_customer_webhook_tenant_usage' && privilege === 'INSERT',
    ),
    false,
    'event enqueue is not mounted in this composition',
  );

  assert.doesNotMatch(
    roleTemplate,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)(?:\s*,\s*(?:SELECT|INSERT|UPDATE|DELETE))*\s+ON\s+(?:ALL\s+)?TABLES?[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.doesNotMatch(
    roleTemplate,
    /GRANT\s+(?:USAGE|SELECT|UPDATE)\s+ON\s+(?:ALL\s+)?SEQUENCES?[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.doesNotMatch(
    roleTemplate,
    /GRANT\s+EXECUTE\s+ON\s+(?:ALL\s+)?FUNCTIONS?[^;]*TO\s+model_router_saas_control_plane\b/is,
  );
  assert.match(roleTemplate, /out-of-schema routines/);
  assert.match(roleTemplate, /ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator/);
});

test('role template contains no broad destructive or ownership-transfer commands', () => {
  assert.doesNotMatch(roleTemplate, /^\s*(?:DROP\s|REASSIGN\s+OWNED|DELETE\s+FROM|TRUNCATE(?:\s|;))/im);
  assert.doesNotMatch(roleTemplate, /\b(?:DROP\s+OWNED|REASSIGN\s+OWNED)\b/i);
});

test('gateway grant template mirrors the exact column manifest and read allowlist', () => {
  const gatewayBlockStart = roleTemplate.indexOf('DO $gateway_runtime_grants$');
  const gatewayBlockEnd = roleTemplate.indexOf('$gateway_runtime_grants$;', gatewayBlockStart);
  assert.ok(gatewayBlockStart >= 0 && gatewayBlockEnd > gatewayBlockStart);
  const gatewayBlock = roleTemplate.slice(gatewayBlockStart, gatewayBlockEnd);

  for (const table of SAAS_GATEWAY_RUNTIME_READ_TABLES) {
    assert.ok(gatewayBlock.includes(`('${table}')`), `missing gateway read table ${table}`);
  }
  for (const [table, column, privilege] of SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS) {
    assert.ok(gatewayBlock.includes(`('${table}', '${column}', '${privilege}')`), `${privilege} ${table}.${column}`);
  }
  assert.doesNotMatch(gatewayBlock, /\('saas_gateway_provider_account_affinity',\s*'[^']+',\s*'(?:DELETE|TRUNCATE)'\)/);
  const deployedColumnGrants = [...gatewayBlock.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)]
    .map((match) => [match[1], match[2], match[3]].join('\t'))
    .sort();
  assert.deepEqual(
    deployedColumnGrants,
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.map((grant) => grant.join('\t')).sort(),
    'the template must contain no missing, duplicate or excess column grant',
  );

  assert.match(gatewayBlock, /GRANT SELECT \(%s\) ON TABLE/);
  assert.match(gatewayBlock, /GRANT %s \(%s\) ON TABLE/);
  assert.match(gatewayBlock, /GRANT INSERT \(%s\) ON TABLE %I\.%I TO %I/);
  assert.match(
    gatewayBlock,
    /GRANT DELETE ON TABLE model_router_saas\.saas_billing_spending_freezes TO model_router_saas_gateway/,
  );
  assert.match(
    gatewayBlock,
    /GRANT USAGE ON SEQUENCE model_router_saas\.saas_provider_account_lease_fencing_seq TO model_router_saas_gateway/,
  );
  assert.doesNotMatch(gatewayBlock, /GRANT (?:SELECT|INSERT|UPDATE) ON TABLE model_router_saas\./);
  assert.doesNotMatch(gatewayBlock, /TO model_router_saas_control_plane/);
});

test('gateway pricing template grants only exact snapshot INSERTs while worker and price versions remain unwritable', () => {
  const gatewayBlock = roleTemplate.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  assert.ok(gatewayBlock);
  const deployed = [...gatewayBlock.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)]
    .map((match) => [match[1], match[2], match[3]]);
  const workerTemplate = readFileSync(
    resolve(process.cwd(), 'deploy/managed-saas-validation-worker-role-grants.sql'), 'utf8',
  );
  for (const [table, columnCount] of [
    ['saas_request_customer_price_snapshots', 30],
    ['saas_attempt_supplier_cost_snapshots', 22],
  ] as const) {
    const expected = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([relation]) => relation === table);
    assert.equal(expected.length, columnCount);
    assert.deepEqual(
      deployed.filter(([relation]) => relation === table).map((grant) => grant.join('\t')).sort(),
      expected.map((grant) => grant.join('\t')).sort(),
    );
    assert.ok(expected.every(([, , privilege]) => privilege === 'INSERT'));
    assert.ok(gatewayBlock.includes("('" + table + "')"), 'existing column SELECT allowlist stays intact');
    assert.doesNotMatch(
      gatewayBlock,
      new RegExp(
        '\\bGRANT\\s+(?:ALL(?:\\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|TRUNCATE)' +
        '(?:\\s*,\\s*(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE))*\\s+ON\\s+(?:TABLE\\s+)?' +
        '(?:model_router_saas\\.)?' + table + '\\b', 'i',
      ),
      'no table-wide snapshot grant',
    );
    assert.doesNotMatch(
      workerTemplate, new RegExp('\\bGRANT\\b[^;]*\\bmodel_router_saas\\.' + table + '\\b', 'i'),
      'the dedicated validation worker receives no snapshot grant',
    );
  }
  for (const table of ['saas_customer_price_versions', 'saas_supplier_cost_versions'] as const) {
    assert.ok(gatewayBlock.includes("('" + table + "')"));
    assert.equal(deployed.some(([relation, , privilege]) => relation === table && privilege !== 'SELECT'), false);
  }
  assert.deepEqual(
    [...gatewayBlock.matchAll(/GRANT (USAGE|SELECT|UPDATE) ON SEQUENCE model_router_saas\.([a-z_]+) TO model_router_saas_gateway/g)]
      .map((match) => [match[2], match[1]]),
    [['saas_provider_account_lease_fencing_seq', 'USAGE']],
    'pricing adds no sequence grant',
  );
  assert.doesNotMatch(gatewayBlock, /\bGRANT\s+EXECUTE\b/i);
  assert.doesNotMatch(gatewayBlock, /TO model_router_saas_control_plane|TO model_router_saas_validation_worker/);
});

test('gateway audit template grants only the six claim-proof SELECT columns and no broad read', () => {
  const gatewayBlock = roleTemplate.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  assert.ok(gatewayBlock);
  const auditGrants = [...gatewayBlock.matchAll(/\('saas_audit_events', '([^']+)', '(SELECT|INSERT|UPDATE)'\)/g)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(auditGrants.filter(([, privilege]) => privilege === 'SELECT').map(([column]) => column).sort(),
    ['action', 'id', 'occurred_at', 'target_id', 'target_type', 'tenant_id']);
  assert.deepEqual(auditGrants.filter(([, privilege]) => privilege === 'INSERT').map(([column]) => column).sort(), [
    'action', 'actor_user_id', 'entry_point', 'id', 'occurred_at', 'request_id', 'source_ip',
    'target_id', 'target_type', 'tenant_id', 'user_agent',
  ], 'existing audit INSERT contract is unchanged');
  assert.equal(auditGrants.some(([, privilege]) => privilege === 'UPDATE'), false);
  for (const column of ['actor_user_id', 'source_ip', 'user_agent', 'entry_point', 'request_id']) {
    assert.equal(auditGrants.some(([field, privilege]) => field === column && privilege === 'SELECT'), false);
  }
  assert.doesNotMatch(gatewayBlock, /\('saas_audit_events'\)/, 'never enumerate all audit columns for SELECT');
  assert.equal((SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes('saas_audit_events'), false);
  assert.doesNotMatch(gatewayBlock,
    /\bGRANT\s+(?:ALL(?:\s+PRIVILEGES)?|SELECT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\s+ON\s+(?:TABLE\s+)?model_router_saas\.saas_audit_events\b/i);
  assert.doesNotMatch(gatewayBlock, /\bGRANT\s+EXECUTE\b/i);
  assert.doesNotMatch(gatewayBlock, /TO model_router_saas_control_plane|TO model_router_saas_credential_validation_worker/);
});

test('control-plane owns the exact unknown-outcome columns and gateway owns none', () => {
  const gatewayBlock = roleTemplate.match(/DO \$gateway_runtime_grants\$([\s\S]*?)\$gateway_runtime_grants\$/)?.[1];
  const controlPlaneBlock = roleTemplate.match(
    /DO \$control_plane_runtime_grants\$([\s\S]*?)\$control_plane_runtime_grants\$/,
  )?.[1];
  assert.ok(gatewayBlock);
  assert.ok(controlPlaneBlock);

  const relationNames = new Set([
    'saas_unknown_outcome_reconciliation_cases',
    'saas_unknown_outcome_reconciliation_observations',
  ]);
  const deployedControlGrants = [...controlPlaneBlock.matchAll(/\('([^']+)', '(SELECT|INSERT|UPDATE)', '([^']+)'\)/g)]
    .flatMap((match) => match[3].split(/\s+/).map((column) => `${match[1]}\t${column}\t${match[2]}`))
    .filter((grant) => grant.startsWith('saas_unknown_outcome_reconciliation_'))
    .sort();
  const expectedGrants = SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => relationNames.has(table))
    .map(([table, column, privilege]) => `${table}\t${column}\t${privilege}`)
    .sort();
  assert.deepEqual(deployedControlGrants, expectedGrants);

  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(
      ([table, column]) =>
        (table === 'saas_unknown_outcome_reconciliation_cases' && column === 'resolution_support_ticket_ref') ||
        (table === 'saas_unknown_outcome_reconciliation_observations' && column === 'support_ticket_ref'),
    ).sort(),
    [
      ['saas_unknown_outcome_reconciliation_cases', 'resolution_support_ticket_ref', 'SELECT'],
      ['saas_unknown_outcome_reconciliation_cases', 'resolution_support_ticket_ref', 'UPDATE'],
      ['saas_unknown_outcome_reconciliation_observations', 'support_ticket_ref', 'SELECT'],
      ['saas_unknown_outcome_reconciliation_observations', 'support_ticket_ref', 'INSERT'],
    ].sort(),
  );
  assert.equal(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
      ([table, column]) =>
        (table === 'saas_unknown_outcome_reconciliation_cases' && column === 'resolution_support_ticket_ref') ||
        (table === 'saas_unknown_outcome_reconciliation_observations' && column === 'support_ticket_ref'),
    ),
    false,
  );

  const deployedGatewayGrants = [
    ...gatewayBlock.matchAll(/\('([^']+)', '([^']+)', '(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)'\)/g),
  ]
    .filter((match) => relationNames.has(match[1] ?? ''))
    .map((match) => `${match[1]}\t${match[2]}\t${match[3]}`)
    .sort();
  assert.deepEqual(deployedGatewayGrants, []);

  for (const relation of relationNames) {
    assert.match(controlPlaneBlock, new RegExp(`\\('${relation}', '(?:SELECT|INSERT|UPDATE)',`));
    assert.equal(
      gatewayBlock.includes(`('${relation}')`),
      false,
      `${relation} must not be on the gateway broad read list`,
    );
    assert.equal(gatewayBlock.includes(`('${relation}',`), false, `${relation} must not receive gateway column grants`);
    assert.doesNotMatch(
      gatewayBlock,
      new RegExp(
        `GRANT\\s+(?:ALL(?:\\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\\s+ON\\s+TABLE\\s+model_router_saas\\.${relation}\\b`,
        'i',
      ),
      `${relation} must not receive a table-level grant`,
    );
  }
  assert.equal(
    deployedControlGrants.some(
      (grant) => grant.startsWith('saas_unknown_outcome_reconciliation_observations\t') && grant.endsWith('\tUPDATE'),
    ),
    false,
    'observations must never receive UPDATE',
  );
  assert.equal(
    deployedControlGrants.some((grant) => grant.endsWith('\tDELETE') || grant.endsWith('\tTRUNCATE')),
    false,
    'neither recovery relation receives DELETE or TRUNCATE',
  );
});

test('gateway role receives no broad/default grants and health uses explicit column ACLs', () => {
  assert.match(
    roleTemplate,
    /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA model_router_saas\s+FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway/,
  );
  assert.match(
    roleTemplate,
    /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA model_router_saas\s+FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway/,
  );
  assert.match(
    roleTemplate,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA model_router_saas\s+FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway/,
  );
  assert.match(
    roleTemplate,
    /REVOKE ALL PRIVILEGES ON TABLES\s+FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway/,
  );
  assert.doesNotMatch(
    roleTemplate,
    /GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA model_router_saas\s+TO model_router_saas_gateway/,
  );
  assert.doesNotMatch(
    roleTemplate,
    /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA model_router_saas\s+TO model_router_saas_gateway/,
  );
  assert.match(roleTemplate, /health relation is not on the broad read allowlist/i);
  assert.equal(
    (SAAS_GATEWAY_RUNTIME_READ_TABLES as readonly string[]).includes('saas_provider_account_runtime_health'),
    false,
  );
});

test('customer request read template is exactly CP eleven-column SELECT and rejects privilege mutations', () => {
  const expected = [
    'id', 'tenant_id', 'project_id', 'public_model', 'protocol', 'supply_mode',
    'execution_state', 'financial_status', 'reconciliation_state', 'created_at', 'updated_at',
  ].map((column) => column + '\tSELECT').sort();
  const validate = (source: string): void => {
    const block = source.match(/DO \$control_plane_runtime_grants\$([\s\S]*?)\$control_plane_runtime_grants\$/)?.[1];
    assert.ok(block);
    const actual = [...block.matchAll(/\('saas_requests', '(SELECT|INSERT|UPDATE)', '([^']+)'\)/g)]
      .flatMap((match) => match[2].split(/\s+/).map((column) => column + '\t' + match[1])).sort();
    assert.deepEqual(actual, expected);
    assert.doesNotMatch(source,
      /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\s+ON\s+(?:TABLE\s+)?model_router_saas\.saas_requests\s+TO\s+model_router_saas_control_plane\b/i);
    assert.doesNotMatch(source, /GRANT\s+EXECUTE\s+ON\s+[^;]*TO\s+model_router_saas_control_plane\b/i);
  };
  validate(roleTemplate);
  const readList = 'execution_state financial_status reconciliation_state created_at';
  assert.ok(roleTemplate.includes(readList));
  for (const mutated of [
    roleTemplate.replace(readList, 'execution_state financial_status created_at'),
    roleTemplate.replace(readList, readList + ' proxy_key_id'),
    roleTemplate.replace(readList, readList + ' request_fingerprint'),
    roleTemplate.replace("('saas_requests', 'SELECT',", "('saas_requests', 'UPDATE',"),
    roleTemplate + '\nGRANT SELECT ON TABLE model_router_saas.saas_requests TO model_router_saas_control_plane;',
    roleTemplate + '\nGRANT UPDATE ON TABLE model_router_saas.saas_requests TO model_router_saas_control_plane;',
    roleTemplate + '\nGRANT EXECUTE ON FUNCTION model_router_saas.saas_prepared_evidence_valid_input_buckets(text[]) TO model_router_saas_control_plane;',
  ]) assert.throws(() => validate(mutated));
});
