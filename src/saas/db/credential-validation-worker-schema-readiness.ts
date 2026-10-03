import { INITIAL_SAAS_MIGRATION } from './migrations/001_initial_schema.js';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from './migrations/015_provider_supply_accounts.js';
import { PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION } from './migrations/016_provider_supply_credentials.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from './migrations/035_credential_validation_jobs.js';
import { PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION } from './migrations/039_provider_credential_wrapper_history.js';
import { RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION } from './migrations/048_runtime_role_lock_fences.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './migrations/050_prepared_evidence_authorization_advisory_fences.js';
import type { SqlExecutor } from './types.js';

const CHECKS = [
  'server_ready', 'session_ready', 'owner_ready', 'tables_ready', 'columns_ready',
  'keys_ready', 'indexes_ready', 'checks_ready', 'triggers_ready', 'routines_ready',
] as const;
type ReadinessCheck = typeof CHECKS[number];

export class SaasCredentialValidationWorkerSchemaReadinessError extends Error {
  readonly code = 'SAAS_VALIDATION_WORKER_SCHEMA_NOT_READY' as const;
  constructor(readonly failedChecks: readonly ReadinessCheck[] = []) {
    super('Managed SaaS credential-validation worker structural schema is not ready');
    this.name = 'SaasCredentialValidationWorkerSchemaReadinessError';
  }
}

const T = {
  jobs: 'saas_tenant_provider_credential_validation_jobs', products: 'saas_provider_products',
  rights: 'saas_provider_rights', capabilities: 'saas_provider_capabilities',
  accounts: 'saas_tenant_provider_accounts', bindings: 'saas_tenant_provider_account_capabilities',
  credentials: 'saas_tenant_provider_credentials', versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
} as const;
const columns: Array<{ table_name: string; column_name: string; type_name: string; not_null: boolean }> = [];
function fields(table: string, type: string, names: string): void {
  for (const name of names.split(' ')) columns.push({ table_name: table,
    column_name: name.replace(/\?$/, ''), type_name: type, not_null: !name.endsWith('?') });
}
fields(T.jobs, 'uuid', 'id tenant_id');
fields(T.jobs, 'text', 'account_id credential_id provider_id product_id credential_type target_model target_endpoint idempotency_key status last_error_code?');
fields(T.jobs, 'int4', 'credential_version capability_version attempt_count');
fields(T.jobs, 'int8', 'lease_generation');
fields(T.jobs, 'text[]', 'allowed_models');
fields(T.jobs, 'timestamptz', 'available_at created_at updated_at lease_until? completed_at?');
fields(T.products, 'text', 'provider_id product_id status');
fields(T.rights, 'text', 'rights_id provider_id product_id credential_type supply_mode region purpose status');
fields(T.rights, 'int4', 'version');
fields(T.rights, 'text[]', 'model_scope endpoint_scope');
fields(T.rights, 'timestamptz', 'effective_at expires_at?');
fields(T.capabilities, 'text', 'provider_id product_id model endpoint protocol support_level validation_state evidence_sha256');
fields(T.capabilities, 'int4', 'version');
fields(T.bindings, 'uuid', 'tenant_id');
fields(T.bindings, 'text', 'account_id provider_id product_id model endpoint');
fields(T.bindings, 'int4', 'capability_version');
for (const table of [T.accounts, T.credentials]) {
  fields(table, 'uuid', 'tenant_id');
  fields(table, 'text', 'id provider_id product_id credential_type status validation_state validation_error_code?');
  fields(table, 'int8', 'authz_version');
  fields(table, 'timestamptz', 'last_validated_at? updated_at');
}
fields(T.accounts, 'text', 'region purpose rights_id');
fields(T.accounts, 'int4', 'rights_version');
fields(T.credentials, 'text', 'account_id');
fields(T.credentials, 'int4', 'current_version?');
fields(T.credentials, 'timestamptz', 'expires_at?');
fields(T.versions, 'uuid', 'tenant_id');
fields(T.versions, 'text', 'account_id credential_id status algorithm kms_purpose kms_key_id wrapped_dek nonce ciphertext auth_tag');
fields(T.versions, 'int4', 'version schema_version context_version wrapping_revision');
fields(T.versions, 'timestamptz', 'expires_at?');
fields(T.wrappings, 'uuid', 'tenant_id');
fields(T.wrappings, 'text', 'account_id credential_id kms_key_id wrapped_dek');
fields(T.wrappings, 'int4', 'credential_version wrapping_revision');

const names = (value: string) => value.split(' ');
// Every manifest identifier is trusted ASCII. PostgreSQL stores at most 63
// bytes, including explicitly named constraints/triggers in migration 035.
const catalogName = (value: string) => value.slice(0, 63);
const keys: Array<{ table_name: string; name: string; kind: string; columns: string[];
  referenced_table: string | null; referenced_columns: string[] | null }> = [];
function key(table: string, name: string, kind: 'p' | 'u' | 'f', value: string,
  referencedTable: string | null = null, referencedColumns: string | null = null): void {
  keys.push({ table_name: table, name: catalogName(name), kind, columns: names(value), referenced_table: referencedTable,
    referenced_columns: referencedColumns === null ? null : names(referencedColumns) });
}
for (const [table, value] of [
  [T.jobs, 'id'], [T.products, 'provider_id product_id'], [T.rights, 'rights_id version'],
  [T.capabilities, 'provider_id product_id model endpoint version'], [T.accounts, 'tenant_id id'],
  [T.bindings, 'tenant_id account_id provider_id product_id model endpoint capability_version'],
  [T.credentials, 'tenant_id id'], [T.versions, 'tenant_id credential_id version'],
  [T.wrappings, 'tenant_id credential_id credential_version wrapping_revision'],
] as const) key(table, `${table}_pkey`, 'p', value);
key(T.jobs, `${T.jobs}_identity_unique`, 'u', 'tenant_id credential_id credential_version');
key(T.jobs, `${T.jobs}_idempotency_unique`, 'u', 'idempotency_key');
key(T.accounts, `${T.accounts}_account_identity_unique`, 'u', 'tenant_id id provider_id product_id');
key(T.credentials, `${T.credentials}_identity_unique`, 'u', 'tenant_id id account_id');
for (const [table, suffix, value, referenced, refValue] of [
  [T.jobs, 'account_fk', 'tenant_id account_id provider_id product_id', T.accounts, 'tenant_id id provider_id product_id'],
  [T.jobs, 'credential_fk', 'tenant_id credential_id account_id', T.credentials, 'tenant_id id account_id'],
  [T.jobs, 'version_fk', 'tenant_id credential_id credential_version', T.versions, 'tenant_id credential_id version'],
  [T.accounts, 'product_fk', 'provider_id product_id', T.products, 'provider_id product_id'],
  [T.accounts, 'rights_fk', 'rights_id rights_version', T.rights, 'rights_id version'],
  [T.credentials, 'account_fk', 'tenant_id account_id provider_id product_id', T.accounts, 'tenant_id id provider_id product_id'],
  [T.credentials, 'current_version_fk', 'tenant_id id current_version', T.versions, 'tenant_id credential_id version'],
  [T.versions, 'parent_fk', 'tenant_id credential_id account_id', T.credentials, 'tenant_id id account_id'],
  [T.bindings, 'account_fk', 'tenant_id account_id provider_id product_id', T.accounts, 'tenant_id id provider_id product_id'],
  [T.bindings, 'capability_fk', 'provider_id product_id model endpoint capability_version', T.capabilities, 'provider_id product_id model endpoint version'],
  [T.wrappings, 'version_fk', 'tenant_id credential_id account_id credential_version', T.versions, 'tenant_id credential_id account_id version'],
  [T.capabilities, 'provider_product_fk', 'provider_id product_id', T.products, 'provider_id product_id'],
  [T.rights, 'provider_product_fk', 'provider_id product_id', T.products, 'provider_id product_id'],
] as const) key(table, `${table}_${suffix}`, 'f', value, referenced, refValue);

const indexes = [
  { table_name: T.jobs, name: `${T.jobs}_claim_idx`, columns: names('available_at created_at id'), unique: false,
    predicate: "status = ANY (ARRAY['queued'::text, 'leased'::text])" },
  { table_name: T.versions, name: `${T.versions}_one_active_idx`, columns: names('tenant_id credential_id'), unique: true,
    predicate: "status = 'active'::text" },
  { table_name: T.versions, name: 'saas_tenant_provider_credential_version_wrapper_fk_idx',
    columns: names('tenant_id credential_id account_id version'), unique: true, predicate: null },
  { table_name: T.wrappings, name: `${T.wrappings}_operation_idx`,
    columns: names('tenant_id credential_id credential_version operation_id'), unique: true, predicate: null },
].map((index) => ({ ...index, name: catalogName(index.name) }));
// Only single comparisons / status ANY / equality of non-null boolean facts
// are normalized below. Removing grouping is not a general SQL equivalence rule.
const checks = [
  { table_name: T.jobs, name: `${T.jobs}_lease_shape`, expression: "(status = 'leased'::text) = (lease_until IS NOT NULL)" },
  { table_name: T.jobs, name: `${T.jobs}_completion_shape`, expression: "(status = ANY (ARRAY['verified'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL)" },
  { table_name: T.jobs, name: null, expression: "status = ANY (ARRAY['queued'::text, 'leased'::text, 'verified'::text, 'failed'::text, 'cancelled'::text])" },
  ...['attempt_count >= 0', 'lease_generation >= 0', 'credential_version >= 1', 'capability_version >= 1']
    .map((expression) => ({ table_name: T.jobs, name: null, expression })),
  { table_name: T.capabilities, name: null, expression: "evidence_sha256 ~ '^[0-9a-f]{64}$'::text" },
].map((check) => ({ ...check, name: check.name === null ? null : catalogName(check.name) }));

interface Routine { signature: string; source: string; return_type: string; volatility: string;
  definer: boolean; config: string[] | null; }
const routines: Routine[] = [];
function routine(sql: string, name: string, argumentTypes: string[] = [], definer = false): string {
  const pattern = new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION ${name}\\([^\\n]*\\) RETURNS (trigger|text|void)\\nLANGUAGE plpgsql( IMMUTABLE)? AS \\$\\$([\\s\\S]*?)\\$\\$;`, 'gm');
  const matches = [...sql.matchAll(pattern)];
  if (matches.length !== 1) throw new SaasCredentialValidationWorkerSchemaReadinessError();
  const match = matches[0]!;
  const signature = `${name}(${argumentTypes.join(',')})`;
  routines.push({ signature, source: match[3]!, return_type: match[1]!, volatility: match[2] ? 'i' : 'v',
    definer, config: definer ? ['search_path=pg_catalog, model_router_saas, pg_temp'] : null });
  return signature;
}
const immutable = routine(INITIAL_SAAS_MIGRATION.sql, 'saas_reject_immutable_change');
const supplyDelete = routine(PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION.sql, 'saas_provider_supply_reject_delete');
const versionImmutable = routine(PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION.sql, 'saas_provider_credential_version_immutable');
const rightsMatch = routine(PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION.sql, 'saas_provider_supply_validate_rights');
const rightsFence = routine(RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION.sql, 'saas_provider_supply_require_byok_rights');
const capabilityFence = routine(RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION.sql, 'saas_provider_supply_require_byok_capability');
const jobIdentity = routine(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql, 'saas_credential_validation_job_identity_immutable');
const jobDelete = routine(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql, 'saas_provider_credential_validation_job_reject_delete');
// 058 changes only these two exact 035 wrappers' execution metadata. Their
// original bodies and attachments remain authoritative; every other 035
// helper below still requires SECURITY INVOKER and a NULL proconfig.
const credentialInvalidation = routine(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql,
  'saas_invalidate_credential_validation_jobs', [], true);
const accountInvalidation = routine(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql,
  'saas_invalidate_account_credential_validation_jobs', [], true);
const wrappingImmutable = routine(PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION.sql, 'saas_provider_credential_wrapper_history_reject_change');
const writer = routine(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_authorization_writer_fence', [], true);
routine(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_writer_require_value', ['jsonb', 'text']);
routine(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_writer_lock_layer', ['text[]']);
routine(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_writer_composite_key', ['jsonb', 'text', 'text[]']);
// Source constants are inert expected DDL artifacts: none is executed and no
// ledger/history is queried. Full migration approval remains a deployment gate.
const triggers: Array<{ table_name: string; name: string; signature: string; type: number;
  columns: string[]; argument_count: number; arguments_hex: string }> = [];
function trigger(table: string, suffix: string, signature: string, type: number,
  triggerColumns: string[] = [], args: string[] = []): void {
  triggers.push({ table_name: table, name: catalogName(`${table}_${suffix}`), signature, type,
    columns: [...triggerColumns].sort(), argument_count: args.length,
    arguments_hex: Buffer.from(args.map((arg) => `${arg}\0`).join(''), 'utf8').toString('hex') });
}
// PostgreSQL ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32.
trigger(T.jobs, 'identity_immutable', jobIdentity, 19);
trigger(T.jobs, 'no_delete', jobDelete, 11);
trigger(T.accounts, 'invalidate_validation_jobs', accountInvalidation, 17, ['status']);
trigger(T.credentials, 'invalidate_validation_jobs', credentialInvalidation, 17, ['current_version', 'status']);
trigger(T.accounts, 'validate_rights', rightsMatch, 23,
  names('provider_id product_id credential_type supply_mode region purpose rights_id rights_version'));
trigger(T.accounts, 'require_byok_rights', rightsFence, 23);
trigger(T.bindings, 'byok_fence', capabilityFence, 23);
trigger(T.accounts, 'no_delete', supplyDelete, 11);
trigger(T.credentials, 'no_delete', supplyDelete, 11);
trigger(T.versions, 'immutable', versionImmutable, 27);
trigger(T.wrappings, 'immutable', wrappingImmutable, 27);
trigger(T.wrappings, 'no_truncate', wrappingImmutable, 34);
for (const table of [T.products, T.capabilities, T.rights]) trigger(table, 'immutable', immutable, 27);
trigger(T.accounts, 'pe_authz_fence', writer, 31, [], ['provider_account', 'tenant', 'tenant_id', 'id']);
trigger(T.credentials, 'pe_authz_fence', writer, 31, [], ['credential', 'tenant', 'tenant_id', 'id', 'account_id']);
trigger(T.versions, 'pe_authz_fence', writer, 31, [], ['credential_version', 'tenant', 'tenant_id', 'credential_id', 'version', 'account_id']);

const CONTRACT = JSON.stringify({ tables: Object.values(T).map((table_name) => ({ table_name })),
  columns, keys, indexes, checks, triggers, routines });

/** One snapshot of public catalog metadata; never reads application data or the migration ledger. */
export const SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL = `
WITH contract AS (SELECT $1::jsonb AS value),
ns AS (SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = 'model_router_saas'),
trusted_owner AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_migrator'),
tables AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'tables' FROM contract)) AS x(table_name text)),
relations AS (SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace),
columns AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'columns' FROM contract))
  AS x(table_name text, column_name text, type_name text, not_null boolean)),
keys AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'keys' FROM contract))
  AS x(table_name text, name text, kind text, columns text[], referenced_table text, referenced_columns text[])),
indexes AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'indexes' FROM contract))
  AS x(table_name text, name text, columns text[], "unique" boolean, predicate text)),
checks AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'checks' FROM contract))
  AS x(table_name text, name text, expression text)),
triggers AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'triggers' FROM contract))
  AS x(table_name text, name text, signature text, type integer, columns text[], argument_count integer, arguments_hex text)),
routines AS (SELECT * FROM pg_catalog.jsonb_to_recordset((SELECT value->'routines' FROM contract))
  AS x(signature text, source text, return_type text, volatility text, definer boolean, config text[]))
SELECT
  pg_catalog.current_setting('server_version_num')::integer >= 150000 AS server_ready,
  (current_user = 'model_router_saas_validation_worker' AND current_user = session_user
    AND pg_catalog.current_schema() = 'model_router_saas'
    AND pg_catalog.current_setting('search_path') = 'model_router_saas'
    AND pg_catalog.current_schemas(true) = ARRAY['pg_catalog', 'model_router_saas']::pg_catalog.name[]
    AND pg_catalog.current_setting('session_replication_role') = 'origin') AS session_ready,
  (EXISTS (SELECT 1 FROM trusted_owner o JOIN ns ON ns.nspowner = o.oid
    WHERE o.rolcanlogin AND NOT o.rolinherit AND NOT o.rolsuper AND NOT o.rolbypassrls
      AND NOT o.rolcreaterole AND NOT o.rolcreatedb AND NOT o.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = o.oid)
      AND NOT pg_catalog.pg_has_role(current_user, o.oid, 'MEMBER'))
    AND NOT EXISTS (SELECT 1 FROM ns, LATERAL pg_catalog.aclexplode(coalesce(ns.nspacl, pg_catalog.acldefault('n', ns.nspowner))) a
      WHERE a.privilege_type = 'CREATE' AND a.grantee <> ns.nspowner)) AS owner_ready,
  NOT EXISTS (SELECT 1 FROM tables e WHERE NOT EXISTS (SELECT 1 FROM relations c
    WHERE c.relname = e.table_name AND c.relkind = 'r' AND c.relpersistence = 'p'
      AND c.relowner = (SELECT oid FROM trusted_owner) AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)) AS tables_ready,
  NOT EXISTS (SELECT 1 FROM columns e WHERE NOT EXISTS (SELECT 1 FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE c.relname = e.table_name AND a.attname = e.column_name AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = pg_catalog.to_regtype('pg_catalog.' || e.type_name)::oid AND a.atttypmod = -1
      AND a.attnotnull = e.not_null AND a.attgenerated = '' AND a.attidentity = '')) AS columns_ready,
  NOT EXISTS (SELECT 1 FROM keys e WHERE NOT EXISTS (SELECT 1 FROM relations c JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
    WHERE c.relname = e.table_name AND k.conname = e.name AND k.contype::text = e.kind AND k.convalidated
      AND coalesce((pg_catalog.to_jsonb(k)->>'conenforced')::boolean, true) AND NOT k.condeferrable AND NOT k.condeferred
      AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY v(n, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = v.n ORDER BY ord) = e.columns
      AND (e.kind <> 'f' OR (k.confdeltype = 'r' AND k.confupdtype = 'a' AND k.confmatchtype = 's'
        AND EXISTS (SELECT 1 FROM relations r WHERE r.oid = k.confrelid AND r.relname = e.referenced_table
          AND r.relowner = (SELECT oid FROM trusted_owner) AND r.relkind = 'r')
        AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY v(n, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = v.n ORDER BY ord) = e.referenced_columns
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint = k.oid AND t.tgenabled <> 'O')))
      AND (e.kind = 'f' OR EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = k.conindid
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique AND i.indimmediate)))) AS keys_ready,
  NOT EXISTS (SELECT 1 FROM indexes e WHERE NOT EXISTS (SELECT 1 FROM relations c
    JOIN pg_catalog.pg_index i ON i.indrelid = c.oid JOIN relations ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
    WHERE c.relname = e.table_name AND ic.relname = e.name AND ic.relkind = 'i' AND am.amname = 'btree'
      AND ic.relowner = (SELECT oid FROM trusted_owner) AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indisunique = e."unique" AND i.indimmediate AND i.indexprs IS NULL AND i.indnatts = i.indnkeyatts
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY v(n, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = v.n ORDER BY ord) = e.columns
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '[[:space:]()]', '', 'g')
        IS NOT DISTINCT FROM pg_catalog.regexp_replace(e.predicate, '[[:space:]()]', '', 'g'))) AS indexes_ready,
  NOT EXISTS (SELECT 1 FROM checks e WHERE NOT EXISTS (SELECT 1 FROM relations c JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
    WHERE c.relname = e.table_name AND (e.name IS NULL OR k.conname = e.name) AND k.contype = 'c' AND k.convalidated
      AND coalesce((pg_catalog.to_jsonb(k)->>'conenforced')::boolean, true)
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(k.conbin, k.conrelid), '[[:space:]()]', '', 'g')
        = pg_catalog.regexp_replace(e.expression, '[[:space:]()]', '', 'g'))) AS checks_ready,
  NOT EXISTS (SELECT 1 FROM triggers e WHERE NOT EXISTS (SELECT 1 FROM relations c JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid
    WHERE c.relname = e.table_name AND t.tgname = e.name AND NOT t.tgisinternal AND t.tgenabled = 'O'
      AND t.tgfoid = pg_catalog.to_regprocedure('model_router_saas.' || e.signature)::oid AND t.tgtype = e.type
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint = 0 AND t.tgqual IS NULL
      AND t.tgnargs = e.argument_count AND t.tgargs = pg_catalog.decode(e.arguments_hex, 'hex')
      AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr) v(n)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = v.n ORDER BY a.attname) = e.columns)) AS triggers_ready,
  NOT EXISTS (SELECT 1 FROM routines e WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure('model_router_saas.' || e.signature)::oid
      AND p.pronamespace = (SELECT oid FROM ns) AND p.proowner = (SELECT oid FROM trusted_owner)
      AND l.lanname = 'plpgsql' AND p.prosrc = e.source AND p.prorettype = pg_catalog.to_regtype('pg_catalog.' || e.return_type)::oid
      AND p.prokind = 'f' AND p.provolatile::text = e.volatility AND p.prosecdef = e.definer
      AND p.proconfig IS NOT DISTINCT FROM e.config AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof
      AND p.proparallel = 'u' AND p.pronargdefaults = 0 AND p.provariadic = 0 AND p.prosupport = 0
      AND NOT pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))) AS routines_ready
`;

/** Structural worker readiness is NOT a migration history or deployment approval attestation. */
export async function verifyCredentialValidationWorkerSchemaReadiness(executor: SqlExecutor): Promise<void> {
  try {
    const result = await executor.query<Record<ReadinessCheck, unknown>>(SAAS_CREDENTIAL_VALIDATION_WORKER_SCHEMA_READINESS_SQL, [CONTRACT]);
    const row = result.rows.length === 1 ? result.rows[0] : undefined;
    if (!row || CHECKS.some((check) => typeof row[check] !== 'boolean')) throw new SaasCredentialValidationWorkerSchemaReadinessError();
    const failed = CHECKS.filter((check) => row[check] !== true);
    if (failed.length) throw new SaasCredentialValidationWorkerSchemaReadinessError(Object.freeze(failed));
  } catch (error) {
    if (error instanceof SaasCredentialValidationWorkerSchemaReadinessError) throw error;
    // No driver error/body/SQL or metadata source escapes the readiness boundary.
    throw new SaasCredentialValidationWorkerSchemaReadinessError();
  }
}
