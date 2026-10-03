import type { SaasMigration } from './001_initial_schema.js';
import { GATEWAY_METERING_SAAS_MIGRATION } from './010_gateway_metering.js';

const marker = 'CREATE FUNCTION saas_metering_guard_attempt_update() RETURNS trigger\nLANGUAGE plpgsql AS $$';
const historical = GATEWAY_METERING_SAAS_MIGRATION.sql;
const start = historical.indexOf(marker);
const end = historical.indexOf('\n$$;', start + marker.length);
if (start < 0 || end < 0 || historical.indexOf(marker, start + marker.length) !== -1) {
  throw new Error('059 requires exactly one historical attempt guard');
}
export const PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE = historical.slice(start + marker.length, end + 1);

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('059 historical attempt guard anchor changed');
  return source.replace(before, after);
}

let body = replaceOnce(PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE, '\nBEGIN\n', `
BEGIN
  IF OLD.dispatch_state = 'not_sent' AND OLD.result_state = 'failed'
    AND (NEW.dispatch_state IS DISTINCT FROM OLD.dispatch_state
      OR NEW.result_state IS DISTINCT FROM OLD.result_state
      OR NEW.response_started IS DISTINCT FROM OLD.response_started
      OR NEW.prepared_evidence_id IS DISTINCT FROM OLD.prepared_evidence_id) THEN
    RAISE EXCEPTION 'A cancelled pre-dispatch attempt is terminal' USING ERRCODE = '55000';
  END IF;
  IF NEW.dispatch_state = 'not_sent' AND NEW.result_state = 'failed'
    AND NOT (OLD.dispatch_state = 'not_sent' AND OLD.result_state IN ('pending', 'failed')
      AND NOT OLD.response_started AND NOT NEW.response_started
      AND NEW.result_http_status IS NULL AND NEW.response_started_at IS NULL
      AND NEW.unknown_reason IS NULL) THEN
    RAISE EXCEPTION 'Pre-dispatch cancellation requires authoritative non-dispatch' USING ERRCODE = '55000';
  END IF;
`);
body = replaceOnce(body,
  "IF NEW.dispatch_state = 'not_sent' AND (NEW.result_state <> 'pending' OR NEW.response_started) THEN",
  "IF NEW.dispatch_state = 'not_sent' AND (NEW.result_state NOT IN ('pending', 'failed') OR NEW.response_started) THEN");
body = replaceOnce(body,
  "AND NEW.dispatch_state NOT IN ('sent', 'unknown') THEN\n    RAISE EXCEPTION 'A terminal SaaS attempt result requires sent or unknown dispatch evidence'",
  "AND NEW.dispatch_state NOT IN ('sent', 'unknown')\n    AND NOT (NEW.dispatch_state = 'not_sent' AND NEW.result_state = 'failed' AND NOT NEW.response_started) THEN\n    RAISE EXCEPTION 'A terminal SaaS attempt result requires sent or unknown dispatch evidence'");
export const PRE_DISPATCH_ATTEMPT_GUARD_SOURCE = body;

export const PRE_DISPATCH_TERMINAL_CHECK_SQL = `
  (dispatch_state = 'not_sent' AND result_state = 'pending' AND response_started = false)
  OR (dispatch_state = 'not_sent' AND result_state = 'failed' AND response_started = false
    AND response_started_at IS NULL AND result_http_status IS NULL AND unknown_reason IS NULL)
  OR dispatch_state <> 'not_sent'`;

/** Forward only. The migration runner executes this entire SQL in one transaction. */
export const PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION: SaasMigration = {
  version: 59,
  name: 'pre_dispatch_terminal_cancellation',
  sql: `
DO $pre_dispatch_cancellation$
DECLARE
  owner_id oid := pg_catalog.to_regrole('model_router_saas_migrator');
  schema_id oid := pg_catalog.to_regnamespace('model_router_saas');
  table_id oid := pg_catalog.to_regclass('model_router_saas.saas_attempts');
  guard_id oid := pg_catalog.to_regprocedure('model_router_saas.saas_metering_guard_attempt_update()');
  routine record;
  check_id oid;
  acl_before jsonb;
  acl_after jsonb;
BEGIN
  IF current_user <> 'model_router_saas_migrator' OR session_user <> current_user
    OR owner_id IS NULL OR schema_id IS NULL OR table_id IS NULL OR guard_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = owner_id
      AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = schema_id AND nspowner = owner_id)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = table_id AND relowner = owner_id
      AND relnamespace = schema_id AND relkind = 'r' AND relpersistence = 'p' AND NOT relispartition) THEN
    RAISE EXCEPTION '059 requires the trusted managed schema owner and attempt table' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE model_router_saas.saas_attempts IN ACCESS EXCLUSIVE MODE;
  SELECT * INTO routine FROM pg_catalog.pg_proc WHERE oid = guard_id;
  IF routine.prosrc IS DISTINCT FROM $historical_guard$${PRE_DISPATCH_ATTEMPT_GUARD_EXPECTED_SOURCE}$historical_guard$
    OR routine.proowner <> owner_id OR routine.prosecdef OR routine.proconfig IS NOT NULL
    OR routine.prorettype <> 'pg_catalog.trigger'::regtype OR routine.pronargs <> 0
    OR routine.pronamespace <> schema_id OR routine.prokind <> 'f' OR routine.proretset
    OR routine.proisstrict OR routine.proleakproof OR routine.provolatile <> 'v' OR routine.proparallel <> 'u'
    OR routine.pronargdefaults <> 0 OR routine.prosupport <> 0
    OR routine.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = table_id
      AND tgname = 'saas_attempts_guard_update' AND tgfoid = guard_id AND tgtype = 19
      AND tgenabled = 'O' AND NOT tgisinternal AND tgqual IS NULL AND tgattr::text = ''
      AND tgnargs = 0 AND tgargs = pg_catalog.decode('', 'hex')) THEN
    RAISE EXCEPTION '059 historical attempt guard body or binding drifted' USING ERRCODE = '55000';
  END IF;
  SELECT oid INTO check_id FROM pg_catalog.pg_constraint WHERE conrelid = table_id
    AND conname = 'saas_attempts_status_consistency' AND contype = 'c' AND convalidated
    AND NOT condeferrable AND NOT condeferred AND NOT connoinherit AND conislocal AND coninhcount = 0
    AND pg_catalog.pg_get_expr(conbin, conrelid) =
      '(((dispatch_state = ''not_sent''::text) AND (result_state = ''pending''::text) AND (response_started = false)) OR (dispatch_state <> ''not_sent''::text))';
  IF check_id IS NULL THEN
    RAISE EXCEPTION '059 historical attempt consistency CHECK drifted' USING ERRCODE = '55000';
  END IF;
  SELECT jsonb_build_array(routine.proacl,
    (SELECT relacl FROM pg_catalog.pg_class WHERE oid = table_id),
    (SELECT jsonb_agg(jsonb_build_array(attnum, attacl) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid = table_id)) INTO acl_before;

  ALTER TABLE model_router_saas.saas_attempts DROP CONSTRAINT saas_attempts_status_consistency,
    ADD CONSTRAINT saas_attempts_status_consistency CHECK (${PRE_DISPATCH_TERMINAL_CHECK_SQL});
  EXECUTE $guard_ddl$CREATE OR REPLACE FUNCTION model_router_saas.saas_metering_guard_attempt_update()
    RETURNS trigger LANGUAGE plpgsql AS $new_guard$${PRE_DISPATCH_ATTEMPT_GUARD_SOURCE}$new_guard$$guard_ddl$;

  SELECT jsonb_build_array(proacl,
    (SELECT relacl FROM pg_catalog.pg_class WHERE oid = table_id),
    (SELECT jsonb_agg(jsonb_build_array(attnum, attacl) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid = table_id)) INTO acl_after
    FROM pg_catalog.pg_proc WHERE oid = guard_id;
  IF acl_after IS DISTINCT FROM acl_before
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = guard_id AND proowner = owner_id
      AND NOT prosecdef AND proconfig IS NULL AND prosrc = $installed_guard$${PRE_DISPATCH_ATTEMPT_GUARD_SOURCE}$installed_guard$)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = table_id
      AND conname = 'saas_attempts_status_consistency' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION '059 installation changed ACLs or failed validation' USING ERRCODE = '55000';
  END IF;
END;
$pre_dispatch_cancellation$;
`,
};
