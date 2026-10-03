import type { SaasMigration } from './001_initial_schema.js';
import { GATEWAY_METERING_SAAS_MIGRATION } from './010_gateway_metering.js';

function historicalBody(name: string): string {
  const source = GATEWAY_METERING_SAAS_MIGRATION.sql;
  const marker = `CREATE FUNCTION ${name}() RETURNS trigger\nLANGUAGE plpgsql AS $$`;
  const start = source.indexOf(marker);
  const end = start < 0 ? -1 : source.indexOf('\n$$;', start + marker.length);
  if (start < 0 || end < 0 || source.indexOf(marker, start + marker.length) !== -1) {
    throw new Error(`Migration 057 requires exactly one historical ${name} body`);
  }
  return source.slice(start + marker.length, end + 1);
}

export const USAGE_SETTLEMENT_IMMUTABLE_EXPECTED_SOURCE = historicalBody('saas_metering_reject_immutable_change');
export const USAGE_SETTLEMENT_SCOPE_EXPECTED_SOURCE = historicalBody('saas_metering_guard_settlement_scope');

// NULL marks legacy/non-normal facts, never a reconstructed provider reference.
// This bounds representation only; the service must bind the ORIGINAL opaque
// reference to the canonical normal-success settlement digest in its real tx.
export const NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_CHECK_SQL = `normal_success_evidence_ref IS NULL
  OR (kind = 'usage_recorded'
    AND pg_catalog.octet_length(normal_success_evidence_ref) = 64
    AND normal_success_evidence_ref COLLATE pg_catalog."C" ~ '^[0-9a-f]{64}$')`;

const sql = `
/* Forward-only, isolated schema candidate. Failure rolls back this atomic DDL;
 * there is no down migration: removing a populated reference would destroy
 * replay evidence. Historical rows remain NULL, with no guessed backfill or
 * recomputation of their settlement_digest. Existing whole-row UPDATE/DELETE
 * immutability already covers the appended column, without a new helper.
 * Role ACLs deliberately remain unchanged. After schema registration is
 * separately authorized, the exact-role contract must grant ONLY this new
 * column's INSERT and SELECT to the gateway before new source can start.
 */
DO $normal_success_usage_evidence_reference$
DECLARE
  trusted_owner oid := pg_catalog.to_regrole('model_router_saas_migrator');
  managed_schema oid := pg_catalog.to_regnamespace('model_router_saas');
  settlement_table oid := pg_catalog.to_regclass('model_router_saas.saas_usage_settlements');
  immutable_oid oid := pg_catalog.to_regprocedure('model_router_saas.saas_metering_reject_immutable_change()');
  scope_oid oid := pg_catalog.to_regprocedure('model_router_saas.saas_metering_guard_settlement_scope()');
  expected record;
  routine record;
  old_column_count smallint;
  old_check_count smallint;
  kind_column smallint;
  reference_column smallint;
  reference_check oid;
  function_catalog_before jsonb; function_catalog_after jsonb;
  table_acl_before jsonb; table_acl_after jsonb;
  column_catalog_before jsonb; column_catalog_after jsonb;
  constraint_catalog_before jsonb; constraint_catalog_after jsonb;
  trigger_catalog_before jsonb; trigger_catalog_after jsonb;
  index_catalog_before jsonb; index_catalog_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator'
    OR session_user IS DISTINCT FROM current_user
    OR trusted_owner IS NULL OR managed_schema IS NULL OR settlement_table IS NULL
    OR immutable_oid IS NULL OR scope_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = trusted_owner
      AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = settlement_table
      AND relnamespace = managed_schema AND relowner = trusted_owner AND relkind = 'r'
      AND relpersistence = 'p' AND NOT relispartition)
    OR (SELECT count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
      AND (rolsuper OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
        OR pg_catalog.pg_has_role(oid, trusted_owner, 'MEMBER')
        OR pg_catalog.has_schema_privilege(oid, managed_schema, 'CREATE')
        OR pg_catalog.has_table_privilege(oid, settlement_table, 'TRIGGER')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN
        ('model_router_saas_migrator', 'model_router_saas_control_plane', 'model_router_saas_gateway')))
  THEN RAISE EXCEPTION 'Migration 057 requires the exact isolated non-superuser managed migrator and runtime roles'; END IF;

  /* Serialize schema checks with all readers/writers of this relation. Do not
   * adopt a preexisting column/constraint or silently repair catalog drift.
   */
  LOCK TABLE model_router_saas.saas_usage_settlements IN ACCESS EXCLUSIVE MODE;
  SELECT relnatts, relchecks INTO old_column_count, old_check_count
    FROM pg_catalog.pg_class WHERE oid = settlement_table;
  IF old_column_count <> 9
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = settlement_table AND attnum > 0
      AND (attisdropped OR attinhcount <> 0 OR NOT attislocal OR attidentity <> '' OR attgenerated <> ''))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = settlement_table
      AND attname = 'normal_success_evidence_ref')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = settlement_table
      AND (conname = 'saas_usage_settlements_normal_success_evidence_ref_check' OR NOT convalidated))
  THEN RAISE EXCEPTION 'Migration 057 exact historical settlement shape or unapplied-column precondition drifted'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    (1, 'id', 'uuid'), (2, 'tenant_id', 'uuid'), (3, 'usage_event_id', 'uuid'),
    (4, 'request_id', 'uuid'), (5, 'attempt_id', 'uuid'), (6, 'settlement_key_digest', 'text'),
    (7, 'settlement_digest', 'text'), (8, 'kind', 'text'), (9, 'created_at', 'timestamptz')
  ) AS contract(position, column_name, type_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = settlement_table
      AND attnum = expected.position AND attname = expected.column_name AND NOT attisdropped AND attnotnull
      AND atttypid = pg_catalog.to_regtype('pg_catalog.' || expected.type_name)::oid
      AND atttypmod = -1 AND attndims = 0)
    THEN RAISE EXCEPTION 'Migration 057 historical settlement column drifted: %', expected.column_name; END IF;
  END LOOP;
  SELECT attnum INTO kind_column FROM pg_catalog.pg_attribute
    WHERE attrelid = settlement_table AND attname = 'kind' AND NOT attisdropped;

  FOR expected IN SELECT * FROM (VALUES
    (immutable_oid, $immutable_source$${USAGE_SETTLEMENT_IMMUTABLE_EXPECTED_SOURCE}$immutable_source$),
    (scope_oid, $scope_source$${USAGE_SETTLEMENT_SCOPE_EXPECTED_SOURCE}$scope_source$)
  ) AS contract(function_oid, source) LOOP
    SELECT p.*, l.lanname INTO routine FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = expected.function_oid;
    IF NOT FOUND OR routine.proowner IS DISTINCT FROM trusted_owner
      OR routine.pronamespace IS DISTINCT FROM managed_schema OR routine.prosrc IS DISTINCT FROM expected.source
      OR routine.lanname IS DISTINCT FROM 'plpgsql' OR routine.prorettype <> 'pg_catalog.trigger'::regtype
      OR routine.pronargs <> 0 OR routine.prokind <> 'f' OR routine.proretset OR routine.proisstrict
      OR routine.proleakproof OR routine.provolatile <> 'v' OR routine.proparallel <> 'u'
      OR routine.provariadic <> 0 OR routine.pronargdefaults <> 0 OR routine.prosupport <> 0
      OR routine.prosecdef OR routine.proconfig IS NOT NULL
      OR NOT pg_catalog.has_function_privilege(trusted_owner, routine.oid, 'EXECUTE')
    THEN RAISE EXCEPTION 'Migration 057 original invoker immutability/scope function owner/body/catalog drifted'; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('saas_usage_settlements_immutable', immutable_oid, 27),
    ('saas_usage_settlements_scope', scope_oid, 7)
  ) AS contract(trigger_name, function_oid, trigger_type) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = settlement_table
      AND t.tgname = expected.trigger_name AND t.tgfoid = expected.function_oid AND t.tgtype = expected.trigger_type
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgnargs = 0 AND t.tgargs = pg_catalog.decode('', 'hex')
      AND t.tgattr::text = '' AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred
      AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
    THEN RAISE EXCEPTION 'Migration 057 exact whole-row immutable/scope trigger binding/events/arguments drifted'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid = settlement_table AND NOT tgisinternal) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_gateway'
      AND pg_catalog.has_any_column_privilege(oid, 'model_router_saas.saas_api_keys', 'UPDATE'))
  THEN RAISE EXCEPTION 'Migration 057 requires unchanged trigger attachments, zero runtime application EXECUTE and no API-key UPDATE'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO function_catalog_before
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relnamespace, c.relowner, c.relkind, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_catalog.pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum) INTO column_catalog_before
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_before
    FROM pg_catalog.pg_constraint c WHERE c.connamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) INTO index_catalog_before
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = managed_schema;

  ALTER TABLE model_router_saas.saas_usage_settlements
    ADD COLUMN normal_success_evidence_ref text,
    ADD CONSTRAINT saas_usage_settlements_normal_success_evidence_ref_check
      CHECK (${NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_CHECK_SQL});

  SELECT attnum INTO reference_column FROM pg_catalog.pg_attribute WHERE attrelid = settlement_table
    AND attname = 'normal_success_evidence_ref' AND attnum = old_column_count + 1 AND NOT attisdropped
    AND atttypid = 'pg_catalog.text'::regtype AND atttypmod = -1 AND attndims = 0
    AND NOT attnotnull AND NOT atthasdef AND NOT atthasmissing AND attmissingval IS NULL
    AND attacl IS NULL AND attidentity = '' AND attgenerated = '' AND attinhcount = 0 AND attislocal;
  SELECT oid INTO reference_check FROM pg_catalog.pg_constraint WHERE conrelid = settlement_table
    AND connamespace = managed_schema AND conname = 'saas_usage_settlements_normal_success_evidence_ref_check'
    AND contype = 'c' AND convalidated AND NOT condeferrable AND NOT condeferred AND NOT connoinherit
    AND conislocal AND coninhcount = 0 AND cardinality(conkey) = 2
    AND conkey @> ARRAY[kind_column, reference_column]::smallint[];
  IF reference_column IS NULL OR reference_check IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = settlement_table
      AND relnatts = old_column_count + 1 AND relchecks = old_check_count + 1)
    OR EXISTS (SELECT 1 FROM model_router_saas.saas_usage_settlements WHERE normal_success_evidence_ref IS NOT NULL)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid
      WHERE d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = reference_check
        AND d.refclassid = 'pg_catalog.pg_proc'::regclass AND p.pronamespace = managed_schema)
  THEN RAISE EXCEPTION 'Migration 057 nullable legacy column or validated pg_catalog-only CHECK postcondition failed'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO function_catalog_after
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relnamespace, c.relowner, c.relkind, c.relacl) ORDER BY c.oid)
    INTO table_acl_after FROM pg_catalog.pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum) INTO column_catalog_after
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = managed_schema AND NOT (a.attrelid = settlement_table AND a.attnum = reference_column);
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_after
    FROM pg_catalog.pg_constraint c WHERE c.connamespace = managed_schema AND c.oid <> reference_check;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_after
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) INTO index_catalog_after
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = managed_schema;
  IF function_catalog_after IS DISTINCT FROM function_catalog_before
    OR table_acl_after IS DISTINCT FROM table_acl_before OR column_catalog_after IS DISTINCT FROM column_catalog_before
    OR constraint_catalog_after IS DISTINCT FROM constraint_catalog_before OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before
    OR index_catalog_after IS DISTINCT FROM index_catalog_before
  THEN RAISE EXCEPTION 'Migration 057 exceeded its one-nullable-column/one-validated-CHECK and unchanged catalog/ACL contract'; END IF;
END;
$normal_success_usage_evidence_reference$;
`;

export const NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION: SaasMigration = {
  version: 57,
  name: 'normal_success_usage_evidence_reference',
  sql,
};
