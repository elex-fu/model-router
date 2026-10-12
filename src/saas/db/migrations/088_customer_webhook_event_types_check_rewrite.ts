import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track F acceptance evidence found that the 043 event-types CHECK calls the
 * schema helper `saas_customer_webhook_text_array_is_unique`, whose EXECUTE is
 * revoked from the runtime roles by design (deploy/managed-saas-postgres-roles.sql
 * keeps every model_router_saas function non-callable; trigger invocation is
 * exempt, CHECK evaluation is not). Endpoint writes as the restricted
 * control-plane role therefore failed closed with 42501 on the function.
 *
 * Migration 056 established the repair pattern for exactly this class: keep
 * the helper byte-identical, invoker and non-callable, and rewrite the CHECK
 * as equivalent pg_catalog-only SQL. Because the whitelist conjunct already
 * restricts values to the frozen seven-type set, "no duplicates" is exactly
 * "each allowed value occurs at most once". One transactional ALTER swaps the
 * validated constraint under an ACCESS EXCLUSIVE lock; existing rows must
 * satisfy BOTH the historical helper and its replacement before the swap, and
 * ADD CONSTRAINT performs its own complete validation scan. No role/ACL
 * changes, no new or dropped functions, no data rewrites.
 */
export const CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL = `pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'wallet.low_balance'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'api_key.expiring'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'service_plan_order.status_changed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'refund.status_changed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'request.completed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'usage.completed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(event_types, 'platform.maintenance'::text)) <= 1`;

// pg_get_constraintdef deparses through the caller's search_path; this
// migration requires current_user = model_router_saas_migrator, whose role
// template pins search_path to model_router_saas, so the schema helper
// deparses unqualified (migration 056 pinned the same caller-visible shape).
const HISTORICAL_CHECK_DEFINITION =
  'CHECK ((((cardinality(event_types) >= 1) AND (cardinality(event_types) <= 7)) ' +
  'AND (array_position(event_types, NULL::text) IS NULL) ' +
  "AND (array_position(event_types, ''::text) IS NULL) " +
  "AND (event_types <@ ARRAY['wallet.low_balance'::text, 'api_key.expiring'::text, " +
  "'service_plan_order.status_changed'::text, 'refund.status_changed'::text, " +
  "'request.completed'::text, 'usage.completed'::text, 'platform.maintenance'::text]) " +
  'AND saas_customer_webhook_text_array_is_unique(event_types)))';

const customerWebhookEventTypesCheckRewriteSql = `
/* Only one confirmed restricted-role execution repair: the 043 event-types
 * CHECK becomes equivalent pg_catalog-only SQL. The helper stays byte-identical
 * and non-callable. No role/ACL changes, new functions, historical rewrites,
 * or business DML.
 */
DO $customer_webhook_event_types_check_rewrite$
DECLARE
  trusted_owner oid := to_regrole('model_router_saas_migrator');
  managed_schema oid := to_regnamespace('model_router_saas');
  versions_table oid := to_regclass('model_router_saas.saas_customer_webhook_endpoint_versions');
  helper_oid oid := to_regprocedure('model_router_saas.saas_customer_webhook_text_array_is_unique(text[])');
  check_oid oid;
  check_shape jsonb;
  event_types_column smallint;
  function_catalog_before jsonb; function_catalog_after jsonb;
  table_acl_before jsonb; table_acl_after jsonb;
  column_catalog_before jsonb; column_catalog_after jsonb;
  constraint_catalog_before jsonb; constraint_catalog_after jsonb;
  trigger_catalog_before jsonb; trigger_catalog_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator'
    OR trusted_owner IS NULL OR managed_schema IS NULL OR versions_table IS NULL OR helper_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = trusted_owner
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = versions_table
      AND relowner = trusted_owner AND relnamespace = managed_schema AND relkind = 'r')
  THEN RAISE EXCEPTION 'Migration 088 requires the trusted non-superuser managed migrator and schema-owned endpoint versions'; END IF;

  IF EXISTS (SELECT 1 FROM pg_roles r JOIN pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  THEN RAISE EXCEPTION 'Migration 088 requires zero runtime application EXECUTE'; END IF;

  SELECT attnum INTO event_types_column FROM pg_attribute
    WHERE attrelid = versions_table AND attname = 'event_types' AND attnotnull AND NOT attisdropped;
  SELECT c.oid, to_jsonb(c) - 'oid' - 'conbin' INTO check_oid, check_shape FROM pg_constraint c
    WHERE c.conrelid = versions_table AND c.conname = 'saas_customer_webhook_endpoint_versions_event_types'
      AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND NOT c.connoinherit AND c.conislocal AND c.coninhcount = 0
      AND c.conkey = ARRAY[event_types_column]::smallint[]
      AND pg_get_constraintdef(c.oid, false) = $historical$${HISTORICAL_CHECK_DEFINITION}$historical$;
  IF event_types_column IS NULL OR check_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_constraint'::regclass AND objid = check_oid
      AND refclassid = 'pg_proc'::regclass AND refobjid = helper_oid AND deptype = 'n')
    OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
      WHERE d.classid = 'pg_constraint'::regclass AND d.objid = check_oid AND d.refclassid = 'pg_proc'::regclass
        AND p.pronamespace = managed_schema AND p.oid <> helper_oid)
  THEN RAISE EXCEPTION 'Migration 088 exact validated historical event-types constraint/dependency drifted'; END IF;

  IF EXISTS (SELECT 1 FROM model_router_saas.saas_customer_webhook_endpoint_versions
    WHERE model_router_saas.saas_customer_webhook_text_array_is_unique(event_types) IS NOT TRUE
      OR (${CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL}) IS NOT TRUE)
  THEN RAISE EXCEPTION 'Migration 088 existing event-types row does not satisfy both equivalent constraints'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
    INTO function_catalog_before FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
    INTO column_catalog_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) INTO constraint_catalog_before FROM pg_constraint c
    WHERE c.connamespace = managed_schema AND c.oid <> check_oid;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;

  LOCK TABLE model_router_saas.saas_customer_webhook_endpoint_versions IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE model_router_saas.saas_customer_webhook_endpoint_versions
    DROP CONSTRAINT saas_customer_webhook_endpoint_versions_event_types,
    ADD CONSTRAINT saas_customer_webhook_endpoint_versions_event_types CHECK (
      cardinality(event_types) BETWEEN 1 AND 7
      AND array_position(event_types, NULL) IS NULL
      AND array_position(event_types, '') IS NULL
      AND event_types <@ ARRAY[
        'wallet.low_balance', 'api_key.expiring', 'service_plan_order.status_changed',
        'refund.status_changed', 'request.completed', 'usage.completed', 'platform.maintenance'
      ]::text[]
      AND ${CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL}
    );

  SELECT c.oid INTO check_oid FROM pg_constraint c WHERE c.conrelid = versions_table
    AND c.conname = 'saas_customer_webhook_endpoint_versions_event_types'
    AND to_jsonb(c) - 'oid' - 'conbin' = check_shape AND c.convalidated;
  IF check_oid IS NULL OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
    WHERE d.classid = 'pg_constraint'::regclass AND d.objid = check_oid AND d.refclassid = 'pg_proc'::regclass
      AND p.pronamespace = managed_schema)
  THEN RAISE EXCEPTION 'Migration 088 validated constraint shape or pg_catalog-only postcondition failed'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
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
  THEN RAISE EXCEPTION 'Migration 088 exceeded its one-CHECK catalog and unchanged ACL contract'; END IF;
END;
$customer_webhook_event_types_check_rewrite$;
`;

export const CUSTOMER_WEBHOOK_EVENT_TYPES_CHECK_REWRITE_SAAS_MIGRATION: SaasMigration = {
  version: 88,
  name: 'customer_webhook_event_types_check_rewrite',
  sql: customerWebhookEventTypesCheckRewriteSql,
};
