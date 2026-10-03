import { Buffer } from 'node:buffer';
import type { SaasMigration } from './001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from './024_prepared_request_evidence.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from './046_platform_authorization_fences.js';

function body(source: string, name: string): string {
  const marker = `CREATE FUNCTION ${name}(`;
  const start = source.indexOf(marker);
  const first = start < 0 ? -1 : source.indexOf('AS $$', start);
  const last = first < 0 ? -1 : source.indexOf('\n$$;', first);
  if (start < 0 || first < 0 || last < 0 || source.indexOf(marker, start + marker.length) !== -1) {
    throw new Error(`Migration 056 requires exactly one historical ${name} body`);
  }
  return source.slice(first + 'AS $$'.length, last + 1);
}

// CASE preserves the original helper's ordering and error behavior: NULL and
// empty arrays are false; a nonempty multidimensional array reaches the same
// built-in array_position error. No array_lower(...)=1 restriction is added.
// After the NULL/whitelist checks, DISTINCT unnest equality is exactly equivalent
// to each of the five possible labels occurring at most once. Count positions,
// not their values: negative/zero/non-one lower bounds remain supported.
export const PREPARED_EVIDENCE_BUCKET_CHECK_SQL = `CASE
  WHEN usage_feasible_input_buckets IS NULL THEN FALSE
  WHEN pg_catalog.cardinality(usage_feasible_input_buckets) < 1 THEN FALSE
  WHEN pg_catalog.array_position(usage_feasible_input_buckets, NULL::text) IS NOT NULL THEN FALSE
  WHEN (usage_feasible_input_buckets <@ ARRAY['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']::text[]) IS NOT TRUE THEN FALSE
  ELSE pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, 'input'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, 'cache_read'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, 'cache_write'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, 'cache_write_5m'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, 'cache_write_1h'::text)) <= 1
END`;

const historical = PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION.sql;
export const PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE = body(historical, 'saas_platform_authorization_fence_row');
const functions = [
  ['saas_prepared_evidence_valid_input_buckets(text[])', body(PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql,
    'saas_prepared_evidence_valid_input_buckets'), 'bool', 'i'],
  ['saas_platform_authorization_fence_row()', PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE, 'trigger', 'v'],
  ['saas_platform_authorization_fence_users(uuid[])', body(historical, 'saas_platform_authorization_fence_users'), 'void', 'v'],
  ['saas_platform_authorization_writer_statement()', body(historical, 'saas_platform_authorization_writer_statement'), 'trigger', 'v'],
] as const;
const mfaColumns = ['id', 'user_id', 'kind', 'credential_id', 'public_key', 'encrypted_secret', 'created_at', 'verified_at', 'revoked_at'];
const sessionColumns = ['id', 'user_id', 'credential_id', 'token_hash', 'csrf_token_hash', 'expires_at', 'revoked_at'];
export const PLATFORM_AUTHORIZATION_ROW_BINDINGS = [
  ['saas_platform_role_assignments', 'saas_platform_role_assignments_authorization_fence', 'user_id', 29, []],
  ['saas_platform_sessions', 'saas_platform_sessions_authorization_fence', 'user_id', 29, sessionColumns],
  ['saas_users', 'saas_users_platform_authorization_fence', 'id', 17, ['disabled_at', 'anonymized_at', 'email', 'password_hash']],
  ['saas_mfa_credentials', 'saas_mfa_credentials_platform_authorization_fence', 'user_id', 29, mfaColumns],
] as const;
const bindings = PLATFORM_AUTHORIZATION_ROW_BINDINGS.map(([relation, name, argument, type, columns]) =>
  `('${relation}', '${name}', '${argument}', ${type}, ARRAY[${columns.map((c) => `'${c}'`).join(', ')}]::text[], '${Buffer.from(`${argument}\0`).toString('hex')}')`).join(',\n    ');
const expectedFunctions = functions.map(([signature, source, returnType, volatility], i) =>
  `('${signature}', $source_${i}$${source}$source_${i}$, '${returnType}', '${volatility}')`).join(',\n    ');

const sql = `
/* Only two confirmed restricted-role execution repairs. The 024 bucket helper
 * remains byte-identical, invoker and non-callable; its CHECK becomes equivalent
 * pg_catalog-only SQL. Only the 046 row-trigger wrapper gains trusted execution.
 * No role/ACL changes, new functions, historical rewrites, or business DML.
 */
DO $restricted_role_check_and_platform_auth_execution$
DECLARE
  trusted_owner oid := to_regrole('model_router_saas_migrator');
  managed_schema oid := to_regnamespace('model_router_saas');
  evidence_table oid := to_regclass('model_router_saas.saas_prepared_request_evidence');
  wrapper_oid oid := to_regprocedure('model_router_saas.saas_platform_authorization_fence_row()');
  statement_oid oid := to_regprocedure('model_router_saas.saas_platform_authorization_writer_statement()');
  bucket_oid oid := to_regprocedure('model_router_saas.saas_prepared_evidence_valid_input_buckets(text[])');
  check_oid oid;
  bucket_column smallint;
  expected record;
  routine record;
  binding record;
  check_shape jsonb;
  function_catalog_before jsonb; function_catalog_after jsonb;
  table_acl_before jsonb; table_acl_after jsonb;
  column_catalog_before jsonb; column_catalog_after jsonb;
  constraint_catalog_before jsonb; constraint_catalog_after jsonb;
  trigger_catalog_before jsonb; trigger_catalog_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator'
    OR trusted_owner IS NULL OR managed_schema IS NULL OR evidence_table IS NULL
    OR wrapper_oid IS NULL OR statement_oid IS NULL OR bucket_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = trusted_owner
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')) <> 2
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
        OR pg_has_role(oid, trusted_owner, 'MEMBER') OR has_schema_privilege(oid, managed_schema, 'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.oid = managed_schema AND a.grantee <> trusted_owner AND a.privilege_type = 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_class WHERE oid = evidence_table
      AND (relowner <> trusted_owner OR relnamespace <> managed_schema OR relkind <> 'r'))
  THEN RAISE EXCEPTION 'Migration 056 requires the trusted non-superuser managed migrator and isolated runtime roles'; END IF;

  FOR expected IN SELECT * FROM (VALUES
    ${expectedFunctions}
  ) AS contract(signature, source, return_type, volatility) LOOP
    SELECT p.*, l.lanname INTO routine FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = to_regprocedure('model_router_saas.' || expected.signature);
    IF NOT FOUND OR routine.proowner IS DISTINCT FROM trusted_owner
      OR routine.pronamespace IS DISTINCT FROM managed_schema OR routine.prosrc IS DISTINCT FROM expected.source
      OR routine.lanname IS DISTINCT FROM 'plpgsql'
      OR routine.prorettype IS DISTINCT FROM to_regtype('pg_catalog.' || expected.return_type)::oid
      OR routine.provolatile::text IS DISTINCT FROM expected.volatility
      OR routine.prokind <> 'f' OR routine.proretset OR routine.proisstrict OR routine.proleakproof
      OR routine.proparallel <> 'u' OR routine.pronargdefaults <> 0 OR routine.provariadic <> 0 OR routine.prosupport <> 0
      OR routine.prosecdef OR routine.proconfig IS NOT NULL
      OR NOT has_function_privilege(trusted_owner, routine.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE')
    THEN RAISE EXCEPTION 'Migration 056 exact invoker helper/wrapper owner/body/catalog drifted: %', expected.signature; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles r JOIN pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'model_router_saas_gateway'
      AND has_any_column_privilege(oid, 'model_router_saas.saas_api_keys', 'UPDATE'))
  THEN RAISE EXCEPTION 'Migration 056 requires zero runtime application EXECUTE and no gateway API-key UPDATE'; END IF;

  FOR binding IN SELECT * FROM (VALUES
    ${bindings}
  ) AS contract(relation_name, trigger_name, argument, trigger_type, update_columns, arguments_hex) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.oid = to_regclass('model_router_saas.' || binding.relation_name)
        AND c.relnamespace = managed_schema AND c.relowner = trusted_owner AND c.relkind = 'r'
        AND t.tgname = binding.trigger_name AND t.tgfoid = wrapper_oid AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgtype = binding.trigger_type AND t.tgnargs = 1 AND t.tgargs = decode(binding.arguments_hex, 'hex')
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint = 0
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND t.tgattr::text = array_to_string(ARRAY(SELECT a.attnum FROM unnest(binding.update_columns)
          WITH ORDINALITY AS cols(name, position) JOIN pg_attribute a ON a.attrelid = c.oid
            AND a.attname = cols.name AND a.attnum > 0 AND NOT a.attisdropped ORDER BY cols.position), ' ')
        AND cardinality(binding.update_columns) = (SELECT count(*) FROM unnest(binding.update_columns) cols(name)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = cols.name AND a.attnum > 0 AND NOT a.attisdropped))
      OR NOT EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = to_regclass('model_router_saas.' || binding.relation_name)
          AND t.tgname = replace(binding.trigger_name, '_fence', '_writer')
          AND t.tgfoid = statement_oid AND t.tgtype = binding.trigger_type + 1
          AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgnargs = 0 AND t.tgargs = decode('', 'hex')
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint = 0
          AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
          AND t.tgattr::text = array_to_string(ARRAY(SELECT a.attnum FROM unnest(binding.update_columns)
            WITH ORDINALITY AS cols(name, position) JOIN pg_attribute a ON a.attrelid = t.tgrelid
              AND a.attname = cols.name AND a.attnum > 0 AND NOT a.attisdropped ORDER BY cols.position), ' '))
      OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_table_privilege(oid, to_regclass('model_router_saas.' || binding.relation_name), 'TRIGGER'))
    THEN RAISE EXCEPTION 'Migration 056 exact row/statement trigger binding/args/events drifted: %', binding.trigger_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = wrapper_oid) <> 4
  THEN RAISE EXCEPTION 'Migration 056 platform auth wrapper has an unexpected attachment'; END IF;

  /* One transactional ALTER replaces the same validated constraint. The table
   * lock prevents a concurrent writer from observing a missing constraint; no
   * NOT VALID/disabled-trigger/catalog-write interval is introduced. Existing
   * rows must satisfy BOTH the historical helper and its replacement first,
   * and normal ADD CONSTRAINT performs its own complete validation scan.
   */
  LOCK TABLE model_router_saas.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE;
  SELECT attnum INTO bucket_column FROM pg_attribute
    WHERE attrelid = evidence_table AND attname = 'usage_feasible_input_buckets' AND attnotnull AND NOT attisdropped;
  SELECT c.oid, to_jsonb(c) - 'oid' - 'conbin' INTO check_oid, check_shape FROM pg_constraint c
    WHERE c.conrelid = evidence_table AND c.conname = 'saas_prepared_request_evidence_bucket_check'
      AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND NOT c.connoinherit AND c.conislocal AND c.coninhcount = 0
      AND c.conkey = ARRAY[bucket_column]::smallint[]
      AND pg_get_constraintdef(c.oid, false)
        = 'CHECK (saas_prepared_evidence_valid_input_buckets(usage_feasible_input_buckets))';
  IF bucket_column IS NULL OR check_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_constraint'::regclass AND objid = check_oid
      AND refclassid = 'pg_proc'::regclass AND refobjid = bucket_oid AND deptype = 'n')
    OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
      WHERE d.classid = 'pg_constraint'::regclass AND d.objid = check_oid AND d.refclassid = 'pg_proc'::regclass
        AND p.pronamespace = managed_schema AND p.oid <> bucket_oid)
  THEN RAISE EXCEPTION 'Migration 056 exact validated historical bucket constraint/dependency drifted'; END IF;
  IF EXISTS (SELECT 1 FROM model_router_saas.saas_prepared_request_evidence
    WHERE model_router_saas.saas_prepared_evidence_valid_input_buckets(usage_feasible_input_buckets) IS NOT TRUE
      OR (${PREPARED_EVIDENCE_BUCKET_CHECK_SQL}) IS NOT TRUE)
  THEN RAISE EXCEPTION 'Migration 056 existing bucket row does not satisfy both equivalent constraints'; END IF;

  SELECT jsonb_agg(CASE WHEN p.oid = wrapper_oid THEN to_jsonb(p) - 'prosecdef' - 'proconfig' ELSE to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_before FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
    INTO column_catalog_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_before FROM pg_constraint c
    WHERE c.connamespace = managed_schema AND c.oid <> check_oid;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;

  ALTER TABLE model_router_saas.saas_prepared_request_evidence
    DROP CONSTRAINT saas_prepared_request_evidence_bucket_check,
    ADD CONSTRAINT saas_prepared_request_evidence_bucket_check CHECK (${PREPARED_EVIDENCE_BUCKET_CHECK_SQL});
  ALTER FUNCTION model_router_saas.saas_platform_authorization_fence_row() SECURITY DEFINER;
  ALTER FUNCTION model_router_saas.saas_platform_authorization_fence_row()
    SET search_path TO pg_catalog, model_router_saas, pg_temp;

  SELECT c.oid INTO check_oid FROM pg_constraint c WHERE c.conrelid = evidence_table
    AND c.conname = 'saas_prepared_request_evidence_bucket_check'
    AND to_jsonb(c) - 'oid' - 'conbin' = check_shape AND c.convalidated;
  IF check_oid IS NULL OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
    WHERE d.classid = 'pg_constraint'::regclass AND d.objid = check_oid AND d.refclassid = 'pg_proc'::regclass
      AND p.pronamespace = managed_schema)
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = wrapper_oid AND prosecdef
      AND proconfig = ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'])
  THEN RAISE EXCEPTION 'Migration 056 validated constraint shape or trigger-only execution postcondition failed'; END IF;

  SELECT jsonb_agg(CASE WHEN p.oid = wrapper_oid THEN to_jsonb(p) - 'prosecdef' - 'proconfig' ELSE to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_after FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_after FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
    INTO column_catalog_after FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_after FROM pg_constraint c
    WHERE c.connamespace = managed_schema AND c.oid <> check_oid;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_after FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  IF function_catalog_after IS DISTINCT FROM function_catalog_before
    OR table_acl_after IS DISTINCT FROM table_acl_before OR column_catalog_after IS DISTINCT FROM column_catalog_before
    OR constraint_catalog_after IS DISTINCT FROM constraint_catalog_before OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before
    OR EXISTS (SELECT 1 FROM pg_roles r JOIN pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'model_router_saas_gateway'
      AND has_any_column_privilege(oid, 'model_router_saas.saas_api_keys', 'UPDATE'))
  THEN RAISE EXCEPTION 'Migration 056 exceeded its one-CHECK/one-wrapper catalog and unchanged ACL contract'; END IF;
END;
$restricted_role_check_and_platform_auth_execution$;
`;

export const RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION: SaasMigration = {
  version: 56,
  name: 'restricted_role_check_and_platform_auth_execution',
  sql,
};
