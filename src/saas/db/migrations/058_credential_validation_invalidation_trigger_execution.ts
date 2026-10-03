import type { SaasMigration } from './001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from './035_credential_validation_jobs.js';

function historicalBody(name: string): string {
  const source = CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql;
  const marker = `CREATE FUNCTION ${name}() RETURNS trigger\nLANGUAGE plpgsql AS $$`;
  const start = source.indexOf(marker);
  const end = start < 0 ? -1 : source.indexOf('\n$$;', start + marker.length);
  if (start < 0 || end < 0 || source.indexOf(marker, start + marker.length) !== -1) {
    throw new Error(`Migration 058 requires exactly one original ${name} body`);
  }
  return source.slice(start + marker.length, end + 1);
}

export const CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS = [
  'saas_invalidate_account_credential_validation_jobs()',
  'saas_invalidate_credential_validation_jobs()',
] as const;
export const CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS = [
  ...CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS,
  'saas_credential_validation_job_identity_immutable()',
  'saas_provider_credential_validation_job_reject_delete()',
].map((signature) => ({ signature, source: historicalBody(signature.slice(0, -2)) }));
export const CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS = [
  ['saas_tenant_provider_accounts', 'saas_tenant_provider_accounts_invalidate_validation_jobs',
    CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS[0], 17, ['status']],
  ['saas_tenant_provider_credentials', 'saas_tenant_provider_credentials_invalidate_validation_jobs',
    CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS[1], 17, ['current_version', 'status']],
  ['saas_tenant_provider_credential_validation_jobs', 'saas_tenant_provider_credential_validation_jobs_identity_immutable',
    'saas_credential_validation_job_identity_immutable()', 19, []],
  ['saas_tenant_provider_credential_validation_jobs', 'saas_tenant_provider_credential_validation_jobs_no_delete',
    'saas_provider_credential_validation_job_reject_delete()', 11, []],
] as const;

const expectedFunctions = CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS.map(({ signature, source }, i) =>
  `('${signature}', $source_${i}$${source}$source_${i}$)`).join(',\n    ');
// The original job trigger identifiers exceed PostgreSQL's 63-byte name limit.
// All identifiers here are trusted ASCII; compare their actual catalog names.
const expectedBindings = CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS.map(([relation, name, signature, type, columns]) =>
  `('${relation}', '${name.slice(0, 63)}', '${signature}', ${type}, ARRAY[${columns.map((column) => `'${column}'`).join(', ')}]::text[])`).join(',\n    ');
const targetList = CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS.map((signature) => `'${signature}'`).join(', ');

const sql = `
/* Forward-only trigger metadata repair. The two 035 invalidation wrappers
 * execute only through their exact original row-trigger attachments as the
 * existing trusted owner. Bodies, OLD/NEW predicates, generation fencing,
 * timestamps, job guards, 050 writer lock order and all ACLs remain unchanged.
 * No application function EXECUTE or direct control-plane job UPDATE is added.
 * There is no down migration or business-data/backfill operation.
 */
DO $credential_validation_invalidation_trigger_execution$
DECLARE
  trusted_owner oid := pg_catalog.to_regrole('model_router_saas_migrator');
  managed_schema oid := pg_catalog.to_regnamespace('model_router_saas');
  jobs_table oid := pg_catalog.to_regclass('model_router_saas.saas_tenant_provider_credential_validation_jobs');
  expected record;
  routine record;
  binding record;
  target_signature text;
  target_oids oid[];
  checked_oids oid[] := ARRAY[]::oid[];
  function_catalog_before jsonb; function_catalog_after jsonb;
  table_acl_before jsonb; table_acl_after jsonb;
  column_catalog_before jsonb; column_catalog_after jsonb;
  constraint_catalog_before jsonb; constraint_catalog_after jsonb;
  trigger_catalog_before jsonb; trigger_catalog_after jsonb;
  index_catalog_before jsonb; index_catalog_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM current_user
    OR trusted_owner IS NULL OR managed_schema IS NULL OR jobs_table IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = trusted_owner
      AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR (SELECT count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
      AND (rolsuper OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
        OR pg_catalog.pg_has_role(oid, trusted_owner, 'MEMBER')
        OR pg_catalog.has_schema_privilege(oid, managed_schema, 'CREATE')
        OR pg_catalog.has_any_column_privilege(oid, jobs_table, 'UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN
        ('model_router_saas_migrator', 'model_router_saas_control_plane', 'model_router_saas_gateway')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      WHERE n.oid = managed_schema AND a.grantee <> trusted_owner AND a.privilege_type = 'CREATE')
  THEN RAISE EXCEPTION 'Migration 058 requires the exact trusted migrator, isolated roles and no direct application job UPDATE'; END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('saas_tenant_provider_accounts'), ('saas_tenant_provider_credentials'),
    ('saas_tenant_provider_credential_validation_jobs')
  ) AS contract(relation_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('model_router_saas.' || expected.relation_name)
      AND relnamespace = managed_schema AND relowner = trusted_owner AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND pg_catalog.has_table_privilege(oid, pg_catalog.to_regclass('model_router_saas.' || expected.relation_name), 'TRIGGER'))
    THEN RAISE EXCEPTION 'Migration 058 trusted relation/trigger privilege precondition drifted: %', expected.relation_name; END IF;
  END LOOP;
  /* Match the business account -> credential -> job relation order. */
  LOCK TABLE model_router_saas.saas_tenant_provider_accounts,
    model_router_saas.saas_tenant_provider_credentials,
    model_router_saas.saas_tenant_provider_credential_validation_jobs IN ACCESS EXCLUSIVE MODE;

  FOR expected IN SELECT * FROM (VALUES
    ${expectedFunctions}
  ) AS contract(signature, source) LOOP
    SELECT p.*, l.lanname INTO routine FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure('model_router_saas.' || expected.signature);
    IF NOT FOUND OR routine.proowner IS DISTINCT FROM trusted_owner OR routine.pronamespace IS DISTINCT FROM managed_schema
      OR routine.prosrc IS DISTINCT FROM expected.source OR routine.lanname IS DISTINCT FROM 'plpgsql'
      OR routine.prorettype <> 'pg_catalog.trigger'::regtype OR routine.pronargs <> 0 OR routine.prokind <> 'f'
      OR routine.proretset OR routine.proisstrict OR routine.proleakproof OR routine.provolatile <> 'v'
      OR routine.proparallel <> 'u' OR routine.pronargdefaults <> 0 OR routine.provariadic <> 0 OR routine.prosupport <> 0
      OR routine.prosecdef OR routine.proconfig IS NOT NULL
      OR NOT pg_catalog.has_function_privilege(trusted_owner, routine.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    THEN RAISE EXCEPTION 'Migration 058 exact original invoker function owner/body/catalog drifted: %', expected.signature; END IF;
    checked_oids := pg_catalog.array_append(checked_oids, routine.oid);
  END LOOP;
  SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure('model_router_saas.' || signature)::oid ORDER BY signature)
    INTO target_oids FROM pg_catalog.unnest(ARRAY[${targetList}]) target(signature);
  IF pg_catalog.cardinality(target_oids) <> 2 OR pg_catalog.cardinality(checked_oids) <> 4
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_gateway'
      AND pg_catalog.has_any_column_privilege(oid, 'model_router_saas.saas_api_keys', 'UPDATE'))
  THEN RAISE EXCEPTION 'Migration 058 requires exactly two targets, four original functions and unchanged zero runtime EXECUTE/API-key UPDATE'; END IF;

  FOR binding IN SELECT * FROM (VALUES
    ${expectedBindings}
  ) AS contract(relation_name, trigger_name, signature, trigger_type, update_columns) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      WHERE c.oid = pg_catalog.to_regclass('model_router_saas.' || binding.relation_name)
        AND t.tgname = binding.trigger_name AND t.tgfoid = pg_catalog.to_regprocedure('model_router_saas.' || binding.signature)
        AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = binding.trigger_type
        AND t.tgnargs = 0 AND t.tgargs = pg_catalog.decode('', 'hex') AND t.tgqual IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint = 0 AND t.tgparentid = 0
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND t.tgattr::text = pg_catalog.array_to_string(ARRAY(SELECT a.attnum
          FROM pg_catalog.unnest(binding.update_columns) WITH ORDINALITY AS cols(name, position)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = cols.name
          AND a.attnum > 0 AND NOT a.attisdropped ORDER BY cols.position), ' ')
        AND pg_catalog.cardinality(binding.update_columns) = (SELECT count(*)
          FROM pg_catalog.unnest(binding.update_columns) cols(name) JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid AND a.attname = cols.name AND a.attnum > 0 AND NOT a.attisdropped))
    THEN RAISE EXCEPTION 'Migration 058 exact trigger body attachment/events/columns/arguments drifted: %', binding.trigger_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid = ANY(checked_oids)) <> 4
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid = jobs_table AND NOT tgisinternal) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = jobs_table AND NOT convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
      WHERE c.relnamespace = managed_schema AND c.relname = 'saas_tenant_provider_credential_validation_jobs_claim_idx'
        AND i.indrelid = jobs_table AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
        AND i.indexprs IS NULL AND i.indnkeyatts = 3 AND i.indnatts = 3)
  THEN RAISE EXCEPTION 'Migration 058 original attachments/validated job constraints/claim index precondition drifted'; END IF;

  SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid = ANY(target_oids)
    THEN pg_catalog.to_jsonb(p) - 'prosecdef' - 'proconfig' ELSE pg_catalog.to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_before FROM pg_catalog.pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid, c.relnamespace, c.relowner, c.relkind, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_catalog.pg_class c WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid, a.attnum) INTO column_catalog_before
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_before
    FROM pg_catalog.pg_constraint c WHERE c.connamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid) INTO index_catalog_before
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = managed_schema;

  FOREACH target_signature IN ARRAY ARRAY[${targetList}] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION model_router_saas.%s SECURITY DEFINER', target_signature);
    EXECUTE pg_catalog.format('ALTER FUNCTION model_router_saas.%s SET search_path TO pg_catalog, model_router_saas, pg_temp', target_signature);
  END LOOP;

  SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid = ANY(target_oids)
    THEN pg_catalog.to_jsonb(p) - 'prosecdef' - 'proconfig' ELSE pg_catalog.to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_after FROM pg_catalog.pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid, c.relnamespace, c.relowner, c.relkind, c.relacl) ORDER BY c.oid)
    INTO table_acl_after FROM pg_catalog.pg_class c WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid, a.attnum) INTO column_catalog_after
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_after
    FROM pg_catalog.pg_constraint c WHERE c.connamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_after
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid) INTO index_catalog_after
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = managed_schema;
  IF function_catalog_after IS DISTINCT FROM function_catalog_before OR table_acl_after IS DISTINCT FROM table_acl_before
    OR column_catalog_after IS DISTINCT FROM column_catalog_before OR constraint_catalog_after IS DISTINCT FROM constraint_catalog_before
    OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before OR index_catalog_after IS DISTINCT FROM index_catalog_before
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = ANY(checked_oids)
      AND (p.prosecdef IS DISTINCT FROM (p.oid = ANY(target_oids))
        OR (p.oid = ANY(target_oids) AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'])
        OR (NOT p.oid = ANY(target_oids) AND p.proconfig IS NOT NULL)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  THEN RAISE EXCEPTION 'Migration 058 exceeded its two-wrapper SECURITY DEFINER/search_path-only atomic contract'; END IF;
END;
$credential_validation_invalidation_trigger_execution$;
`;

export const CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION: SaasMigration = {
  version: 58,
  name: 'credential_validation_invalidation_trigger_execution',
  sql,
};
