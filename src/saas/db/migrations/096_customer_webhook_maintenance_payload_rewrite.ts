import type { SaasMigration } from './001_initial_schema.js';

/**
 * R8/G4.5 acceptance evidence found that the 043 payload contract pins the
 * platform.maintenance event payload to a placeholder shape
 * {starts_at, ends_at, impact} written before any producer existed. The
 * announcement fan-out worker (Track R8) emits the real payload
 * {announcement_id, kind, severity, title, body, publish_at, unpublish_at},
 * which the historical CHECK rejects with 23514.
 *
 * Unlike 088's equivalence swap, this is a semantic extension confined to
 * the platform.maintenance disjunct; every other event-type disjunct is
 * byte-identical. The swap is safe only because the placeholder shape never
 * had a producer: the migration fails closed if any platform.maintenance
 * event rows exist at all (a database that somehow produced them needs an
 * operator decision, not a silent contract change). One transactional ALTER
 * swaps the validated constraint under an ACCESS EXCLUSIVE lock; ADD
 * CONSTRAINT revalidates every existing row, which succeeds because the
 * only changed disjunct matches zero rows. No role/ACL changes, no new or
 * dropped functions, no data rewrites.
 */
const customerWebhookMaintenancePayloadRewriteSql = `
DO $customer_webhook_maintenance_payload_rewrite$
DECLARE
  managed_schema oid := (SELECT oid FROM pg_namespace WHERE nspname = 'model_router_saas');
  events_table oid := (SELECT oid FROM pg_class WHERE relnamespace = managed_schema AND relname = 'saas_customer_webhook_events' AND relkind = 'r');
  check_oid oid;
  historical_def text;
  function_catalog_before jsonb;
  table_acl_before jsonb;
  column_catalog_before jsonb;
  constraint_catalog_before jsonb;
  trigger_catalog_before jsonb;
  function_catalog_after jsonb;
  table_acl_after jsonb;
  column_catalog_after jsonb;
  constraint_catalog_after jsonb;
  trigger_catalog_after jsonb;
BEGIN
  SELECT c.oid, pg_get_constraintdef(c.oid, false) INTO check_oid, historical_def
    FROM pg_constraint c
    WHERE c.conrelid = events_table AND c.conname = 'saas_customer_webhook_events_payload_contract'
      AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND NOT c.connoinherit AND c.conislocal AND c.coninhcount = 0;
  IF events_table IS NULL OR check_oid IS NULL
    OR historical_def NOT LIKE '%''starts_at''%'
    OR historical_def NOT LIKE '%''ends_at''%'
    OR historical_def NOT LIKE '%''impact''%'
    OR historical_def LIKE '%''announcement_id''%'
  THEN RAISE EXCEPTION 'Migration 096 exact validated historical payload constraint drifted'; END IF;

  -- The placeholder shape never had a producer. Any pre-existing
  -- platform.maintenance event row means this database took a path the
  -- rewrite was not reviewed for; fail closed for an operator decision.
  IF EXISTS (SELECT 1 FROM model_router_saas.saas_customer_webhook_events
    WHERE event_type = 'platform.maintenance')
  THEN RAISE EXCEPTION 'Migration 096 found pre-existing platform.maintenance events; operator review required'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
    INTO function_catalog_before FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
    INTO column_catalog_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid)
    INTO constraint_catalog_before FROM pg_constraint c
    WHERE c.connamespace = managed_schema AND c.oid <> check_oid;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
    INTO trigger_catalog_before FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;

  LOCK TABLE model_router_saas.saas_customer_webhook_events IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE model_router_saas.saas_customer_webhook_events
    DROP CONSTRAINT saas_customer_webhook_events_payload_contract,
    ADD CONSTRAINT saas_customer_webhook_events_payload_contract CHECK (COALESCE((
      (event_type = 'wallet.low_balance'
        AND payload ?& ARRAY['supply_mode','balance_minor_units','threshold_minor_units','currency']
        AND payload - ARRAY['supply_mode','balance_minor_units','threshold_minor_units','currency'] = '{}'::jsonb
        AND payload ->> 'supply_mode' = 'platform'
        AND jsonb_typeof(payload -> 'balance_minor_units') = 'number'
        AND payload ->> 'balance_minor_units' ~ '^(0|[1-9][0-9]{0,15})$'
        AND jsonb_typeof(payload -> 'threshold_minor_units') = 'number'
        AND payload ->> 'threshold_minor_units' ~ '^[1-9][0-9]{0,15}$'
        AND (payload ->> 'balance_minor_units')::numeric <= (payload ->> 'threshold_minor_units')::numeric
        AND (payload ->> 'balance_minor_units')::numeric <= 9007199254740991
        AND (payload ->> 'threshold_minor_units')::numeric <= 9007199254740991
        AND payload ->> 'currency' ~ '^[A-Z]{3}$')
      OR (event_type = 'api_key.expiring'
        AND payload ?& ARRAY['api_key_id','expires_at']
        AND payload - ARRAY['api_key_id','expires_at'] = '{}'::jsonb
        AND payload ->> 'api_key_id' = api_key_id::text
        AND jsonb_typeof(payload -> 'expires_at') = 'string'
        AND payload ->> 'expires_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$')
      OR (event_type = 'service_plan_order.status_changed'
        AND payload ?& ARRAY['service_plan_order_id','status']
        AND payload - ARRAY['service_plan_order_id','status'] = '{}'::jsonb
        AND payload ->> 'service_plan_order_id' = service_plan_order_id::text
        AND payload ->> 'status' IN ('pending','paid','fulfilling','fulfilled','cancelled','reconciliation_pending'))
      OR (event_type = 'refund.status_changed'
        AND payload ?& ARRAY['refund_id','status','amount_minor_units','currency']
        AND payload - ARRAY['refund_id','status','amount_minor_units','currency'] = '{}'::jsonb
        AND payload ->> 'refund_id' = refund_id::text
        AND payload ->> 'status' IN ('submitting','pending','succeeded','failed','unknown','blocked')
        AND jsonb_typeof(payload -> 'amount_minor_units') = 'number'
        AND payload ->> 'amount_minor_units' ~ '^[1-9][0-9]{0,15}$'
        AND (payload ->> 'amount_minor_units')::numeric <= 9007199254740991
        AND payload ->> 'currency' ~ '^[A-Z]{3}$')
      OR (event_type = 'request.completed'
        AND payload ?& ARRAY['request_id','project_id','supply_mode','status','duration_ms']
        AND payload - ARRAY['request_id','project_id','supply_mode','status','duration_ms'] = '{}'::jsonb
        AND payload ->> 'request_id' = request_id::text AND payload ->> 'project_id' = project_id::text
        AND payload ->> 'supply_mode' IN ('byok','platform')
        AND payload ->> 'supply_mode' = request_supply_mode
        AND payload ->> 'status' IN ('succeeded','failed')
        AND jsonb_typeof(payload -> 'duration_ms') = 'number'
        AND payload ->> 'duration_ms' ~ '^(0|[1-9][0-9]{0,8})$'
        AND (payload ->> 'duration_ms')::numeric <= 86400000)
      OR (event_type = 'usage.completed'
        AND payload ?& ARRAY['request_id','project_id','supply_mode','input_tokens','output_tokens','total_tokens']
        AND payload - ARRAY['request_id','project_id','supply_mode','input_tokens','output_tokens','total_tokens'] = '{}'::jsonb
        AND payload ->> 'request_id' = request_id::text AND payload ->> 'project_id' = project_id::text
        AND payload ->> 'supply_mode' IN ('byok','platform')
        AND payload ->> 'supply_mode' = request_supply_mode
        AND jsonb_typeof(payload -> 'input_tokens') = 'number'
        AND payload ->> 'input_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (payload ->> 'input_tokens')::numeric <= 9007199254740991
        AND jsonb_typeof(payload -> 'output_tokens') = 'number'
        AND payload ->> 'output_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (payload ->> 'output_tokens')::numeric <= 9007199254740991
        AND jsonb_typeof(payload -> 'total_tokens') = 'number'
        AND payload ->> 'total_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (payload ->> 'total_tokens')::numeric <= 9007199254740991
        AND (payload ->> 'input_tokens')::numeric + (payload ->> 'output_tokens')::numeric = (payload ->> 'total_tokens')::numeric)
      OR (event_type = 'platform.maintenance'
        AND payload ?& ARRAY['announcement_id','kind','severity','title','body','publish_at','unpublish_at']
        AND payload - ARRAY['announcement_id','kind','severity','title','body','publish_at','unpublish_at'] = '{}'::jsonb
        AND payload ->> 'announcement_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND payload ->> 'kind' IN ('maintenance','info','billing')
        AND payload ->> 'severity' IN ('info','warning','critical')
        AND jsonb_typeof(payload -> 'title') = 'string'
        AND char_length(payload ->> 'title') BETWEEN 1 AND 200
        AND jsonb_typeof(payload -> 'body') = 'string'
        AND char_length(payload ->> 'body') BETWEEN 1 AND 8000
        AND payload ->> 'publish_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
        AND (payload -> 'unpublish_at' = 'null'::jsonb
          OR (jsonb_typeof(payload -> 'unpublish_at') = 'string'
            AND payload ->> 'unpublish_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
            AND (payload ->> 'unpublish_at')::timestamptz > (payload ->> 'publish_at')::timestamptz)))
    ), FALSE));

  SELECT c.oid, pg_get_constraintdef(c.oid, false) INTO check_oid, historical_def
    FROM pg_constraint c WHERE c.conrelid = events_table
    AND c.conname = 'saas_customer_webhook_events_payload_contract' AND c.convalidated;
  IF check_oid IS NULL
    OR historical_def NOT LIKE '%''announcement_id''%'
    OR historical_def LIKE '%''starts_at''%'
    OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
      WHERE d.classid = 'pg_constraint'::regclass AND d.objid = check_oid AND d.refclassid = 'pg_proc'::regclass
        AND p.pronamespace = managed_schema)
  THEN RAISE EXCEPTION 'Migration 096 validated constraint shape or pg_catalog-only postcondition failed'; END IF;

  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
    INTO function_catalog_after FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_after FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum)
    INTO column_catalog_after FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid)
    INTO constraint_catalog_after FROM pg_constraint c
    WHERE c.connamespace = managed_schema AND c.oid <> check_oid;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
    INTO trigger_catalog_after FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  IF function_catalog_after IS DISTINCT FROM function_catalog_before
    OR table_acl_after IS DISTINCT FROM table_acl_before OR column_catalog_after IS DISTINCT FROM column_catalog_before
    OR constraint_catalog_after IS DISTINCT FROM constraint_catalog_before OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before
    OR EXISTS (SELECT 1 FROM pg_roles r JOIN pg_proc p ON p.pronamespace = managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  THEN RAISE EXCEPTION 'Migration 096 exceeded its one-CHECK catalog and unchanged ACL contract'; END IF;
END;
$customer_webhook_maintenance_payload_rewrite$;
`;

export const CUSTOMER_WEBHOOK_MAINTENANCE_PAYLOAD_REWRITE_SAAS_MIGRATION: SaasMigration = {
  version: 96,
  name: 'customer_webhook_maintenance_payload_rewrite',
  sql: customerWebhookMaintenancePayloadRewriteSql,
};
