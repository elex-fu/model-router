import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import { customerMfaFail } from './customer-mfa-types.js';

const sources = [
  {
    "name": "saas_customer_mfa_enrollment_guard",
    "body": "\nBEGIN\n IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer MFA history is permanent' USING ERRCODE='55000'; END IF;\n IF TG_OP='UPDATE' AND (\n   (to_jsonb(NEW)-ARRAY['attempt_count','consumed_at','closed_at','locked_at']) IS DISTINCT FROM\n   (to_jsonb(OLD)-ARRAY['attempt_count','consumed_at','closed_at','locked_at'])\n   OR OLD.closed_at IS NOT NULL\n   OR NEW.attempt_count NOT IN (OLD.attempt_count,OLD.attempt_count+1)\n   OR (NEW.consumed_at IS NOT NULL AND (NEW.locked_at IS NOT NULL OR NEW.closed_at IS NULL)))\n THEN RAISE EXCEPTION 'Customer MFA enrollment transition rejected' USING ERRCODE='23514'; END IF;\n IF TG_OP='INSERT' AND (NEW.attempt_count<>0 OR NEW.consumed_at IS NOT NULL\n   OR NEW.closed_at IS NOT NULL OR NEW.locked_at IS NOT NULL)\n THEN RAISE EXCEPTION 'Customer MFA must begin pending' USING ERRCODE='23514'; END IF;\n IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=NEW.user_id)\n   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id\n     WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()\n       AND u.disabled_at IS NULL AND u.anonymized_at IS NULL)\n   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.credential_id AND c.user_id=NEW.user_id\n     AND c.kind='totp' AND c.verified_at IS NULL AND c.revoked_at IS NULL)\n   OR (NEW.previous_credential_id IS NOT NULL AND NOT EXISTS(\n     SELECT 1 FROM model_router_saas.saas_mfa_credentials c JOIN model_router_saas.saas_customer_mfa_enrollments e\n       ON e.user_id=c.user_id AND e.credential_id=c.id AND e.consumed_at IS NOT NULL\n     WHERE c.id=NEW.previous_credential_id AND c.user_id=NEW.user_id\n       AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL)))\n THEN RAISE EXCEPTION 'Customer MFA pending authority binding rejected' USING ERRCODE='23514'; END IF;\n IF NEW.consumed_at IS NOT NULL AND (NOT EXISTS(\n   SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.credential_id AND c.user_id=NEW.user_id\n     AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND c.last_used_step IS NOT NULL)\n   OR (NEW.previous_credential_id IS NOT NULL AND NOT EXISTS(\n     SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.previous_credential_id AND c.user_id=NEW.user_id\n       AND c.revoked_at IS NOT NULL)))\n THEN RAISE EXCEPTION 'Customer MFA confirmation facts are incomplete' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_command_guard",
    "body": "\nBEGIN\n IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer MFA command history is permanent' USING ERRCODE='55000'; END IF;\n IF TG_OP='UPDATE' AND (\n   (to_jsonb(NEW)-ARRAY['completed_at','outcome']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['completed_at','outcome'])\n   OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR NEW.outcome IS NULL)\n THEN RAISE EXCEPTION 'Customer MFA command transition rejected' USING ERRCODE='23514'; END IF;\n IF TG_OP='INSERT' AND (NEW.completed_at IS NOT NULL OR NEW.outcome IS NOT NULL)\n THEN RAISE EXCEPTION 'Customer MFA command must begin pending' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_event_audit_guard",
    "body": "\nBEGIN\n IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_audit_events a WHERE a.id=NEW.audit_id\n   AND a.actor_user_id IS NOT DISTINCT FROM NEW.user_id\n   AND a.tenant_id IS NULL AND a.entry_point='customer_mfa'\n   AND a.action='customer_mfa.'||NEW.operation||'.'||NEW.outcome\n   AND a.target_type='customer_mfa_command' AND a.target_id IS NOT DISTINCT FROM NEW.command_id::text\n   AND a.request_id=NEW.request_id::text)\n THEN RAISE EXCEPTION 'Customer MFA event requires the same audit fact' USING ERRCODE='23514'; END IF;\n IF NEW.command_id IS NOT NULL AND NOT EXISTS(\n   SELECT 1 FROM model_router_saas.saas_customer_mfa_commands c WHERE c.id=NEW.command_id\n     AND c.user_id=NEW.user_id AND c.session_id=NEW.session_id AND c.operation=NEW.operation\n     AND c.request_id=NEW.request_id\n     AND (NEW.outcome='authorized' AND c.completed_at IS NULL\n       OR NEW.outcome<>'authorized' AND c.outcome=NEW.outcome AND c.completed_at IS NOT NULL))\n THEN RAISE EXCEPTION 'Customer MFA event command binding differs' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_event_complete",
    "body": "\nBEGIN\n IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_customer_mfa_outbox o WHERE o.event_id=NEW.id)\n THEN RAISE EXCEPTION 'Customer MFA event outbox is required in the same transaction' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_command_complete",
    "body": "\nDECLARE current_command model_router_saas.saas_customer_mfa_commands%ROWTYPE;\nBEGIN\n SELECT * INTO STRICT current_command FROM model_router_saas.saas_customer_mfa_commands WHERE id=NEW.id;\n IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_customer_mfa_events e\n   WHERE e.command_id=NEW.id AND e.outcome='authorized')\n   OR (current_command.completed_at IS NOT NULL AND NOT EXISTS(\n     SELECT 1 FROM model_router_saas.saas_customer_mfa_events e\n       WHERE e.command_id=NEW.id AND e.outcome=current_command.outcome))\n THEN RAISE EXCEPTION 'Customer MFA command requires same-transaction events' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_writer",
    "body": "\nBEGIN\n PERFORM set_config('lock_timeout','2s',true);\n PERFORM set_config('statement_timeout','10s',true);\n PERFORM pg_advisory_xact_lock(1396788563,46);\n RETURN NULL;\nEND;\n"
  },
  {
    "name": "saas_customer_mfa_user_fence",
    "body": "\nBEGIN\n IF TG_OP='DELETE' THEN\n   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text,0)); RETURN OLD;\n END IF;\n PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0)); RETURN NEW;\nEND;\n"
  }
] as const;
/** Structural readiness only. Normal migrator/deployment approves full ledger
 * and ACL manifests independently. No app ledger read, KMS or no-op verification.
 */
export async function checkCustomerMfaSchema(tx:SqlExecutor):Promise<void> {
  try {
    const shape=await tx.query<{ready:boolean}>(`
      WITH wanted(relation_name,column_name,type_name) AS (VALUES
    ('saas_customer_mfa_rate_windows','user_id','uuid'),
    ('saas_customer_mfa_rate_windows','window_started_at','timestamp with time zone'),
    ('saas_customer_mfa_rate_windows','attempts','integer'),
    ('saas_customer_mfa_commands','id','uuid'),
    ('saas_customer_mfa_commands','user_id','uuid'),
    ('saas_customer_mfa_commands','session_id','uuid'),
    ('saas_customer_mfa_commands','operation','text'),
    ('saas_customer_mfa_commands','request_id','uuid'),
    ('saas_customer_mfa_commands','created_at','timestamp with time zone'),
    ('saas_customer_mfa_commands','expires_at','timestamp with time zone'),
    ('saas_customer_mfa_commands','completed_at','timestamp with time zone'),
    ('saas_customer_mfa_commands','outcome','text'),
    ('saas_customer_mfa_enrollments','id','uuid'),
    ('saas_customer_mfa_enrollments','user_id','uuid'),
    ('saas_customer_mfa_enrollments','session_id','uuid'),
    ('saas_customer_mfa_enrollments','credential_id','uuid'),
    ('saas_customer_mfa_enrollments','previous_credential_id','uuid'),
    ('saas_customer_mfa_enrollments','token_hash','text'),
    ('saas_customer_mfa_enrollments','password_digest','text'),
    ('saas_customer_mfa_enrollments','attempt_count','integer'),
    ('saas_customer_mfa_enrollments','created_at','timestamp with time zone'),
    ('saas_customer_mfa_enrollments','expires_at','timestamp with time zone'),
    ('saas_customer_mfa_enrollments','consumed_at','timestamp with time zone'),
    ('saas_customer_mfa_enrollments','closed_at','timestamp with time zone'),
    ('saas_customer_mfa_enrollments','locked_at','timestamp with time zone'),
    ('saas_customer_mfa_events','id','uuid'),
    ('saas_customer_mfa_events','audit_id','uuid'),
    ('saas_customer_mfa_events','command_id','uuid'),
    ('saas_customer_mfa_events','user_id','uuid'),
    ('saas_customer_mfa_events','session_id','uuid'),
    ('saas_customer_mfa_events','operation','text'),
    ('saas_customer_mfa_events','outcome','text'),
    ('saas_customer_mfa_events','reason_code','text'),
    ('saas_customer_mfa_events','request_id','uuid'),
    ('saas_customer_mfa_events','created_at','timestamp with time zone'),
    ('saas_customer_mfa_outbox','event_id','uuid'),
    ('saas_customer_mfa_outbox','created_at','timestamp with time zone'))
      SELECT (
        current_user='model_router_saas_control_plane' AND session_user=current_user
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
          WHERE n.nspname='model_router_saas' AND r.rolname='model_router_saas_migrator'
            AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
          AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole
            OR pg_has_role(r.oid,'model_router_saas_migrator','MEMBER')))
        AND NOT EXISTS(SELECT 1 FROM wanted w WHERE NOT EXISTS(
          SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
          WHERE n.nspname='model_router_saas' AND c.relname=w.relation_name AND c.relkind='r'
            AND c.relowner='model_router_saas_migrator'::regrole AND a.attname=w.column_name
            AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid,a.atttypmod)=w.type_name
            AND has_column_privilege(current_user,c.oid,a.attname,'SELECT')))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i
          WHERE i.indrelid='model_router_saas.saas_customer_mfa_enrollments'::regclass
            AND i.indexrelid='model_router_saas.saas_customer_mfa_one_open_enrollment'::regclass
            AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
          WHERE c.conrelid IN (SELECT DISTINCT ('model_router_saas.'||relation_name)::regclass FROM wanted)
            AND NOT c.convalidated)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='model_router_saas' AND has_function_privilege(current_user,p.oid,'EXECUTE'))
      ) AS ready`);
    if(shape.rows.length!==1||shape.rows[0]?.ready!==true)return customerMfaFail('UNAVAILABLE');
    const routines=await tx.query<{name:string;body:string;safe:boolean}>(`
      SELECT p.proname AS name,p.prosrc AS body,
        (p.proowner='model_router_saas_migrator'::regrole AND NOT p.prosecdef
          AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp']
          AND l.lanname='plpgsql' AND p.prorettype='pg_catalog.trigger'::regtype
          AND p.pronargs=0 AND p.prokind='f' AND NOT p.proretset) AS safe
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname='model_router_saas' AND p.proname=ANY($1::text[])`,[sources.map(x=>x.name)]);
    if(routines.rows.length!==sources.length)return customerMfaFail('UNAVAILABLE');
    for(const expected of sources) {
      const matches=routines.rows.filter(r=>r.name===expected.name);
      const found=matches[0];
      if(matches.length!==1||!found||found.safe!==true||typeof found.body!=='string'
        ||createHash('sha256').update(found.body).digest('hex')!==
          createHash('sha256').update(expected.body).digest('hex'))return customerMfaFail('UNAVAILABLE');
    }
    const bindings=await tx.query<{ready:boolean}>(`
      WITH wanted(relation_name,trigger_name,function_name,deferred,type_bits) AS (VALUES
        ('saas_customer_mfa_enrollments','saas_customer_mfa_enrollment_guard','saas_customer_mfa_enrollment_guard',false,31),
        ('saas_customer_mfa_commands','saas_customer_mfa_command_guard','saas_customer_mfa_command_guard',false,31),
        ('saas_customer_mfa_events','saas_customer_mfa_event_audit_guard','saas_customer_mfa_event_audit_guard',false,7),
        ('saas_customer_mfa_events','saas_customer_mfa_event_complete','saas_customer_mfa_event_complete',true,5),
        ('saas_customer_mfa_commands','saas_customer_mfa_command_complete','saas_customer_mfa_command_complete',true,21),
        ('saas_customer_mfa_events','saas_customer_mfa_event_immutable','saas_reject_immutable_change',false,27),
        ('saas_customer_mfa_outbox','saas_customer_mfa_outbox_immutable','saas_reject_immutable_change',false,27),
        ('saas_customer_mfa_enrollments','saas_customer_mfa_enrollments_writer','saas_customer_mfa_writer',false,30),
        ('saas_customer_mfa_enrollments','saas_customer_mfa_enrollments_user','saas_customer_mfa_user_fence',false,29),
        ('saas_customer_mfa_commands','saas_customer_mfa_commands_writer','saas_customer_mfa_writer',false,30),
        ('saas_customer_mfa_commands','saas_customer_mfa_commands_user','saas_customer_mfa_user_fence',false,29),
        ('saas_customer_mfa_rate_windows','saas_customer_mfa_rate_writer','saas_customer_mfa_writer',false,30),
        ('saas_customer_mfa_rate_windows','saas_customer_mfa_rate_user','saas_customer_mfa_user_fence',false,29))
      SELECT NOT EXISTS(SELECT 1 FROM wanted w WHERE NOT EXISTS(
        SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='model_router_saas' AND c.relname=w.relation_name AND t.tgname=w.trigger_name
          AND t.tgenabled='O' AND NOT t.tgisinternal AND p.proname=w.function_name
          AND p.pronamespace=n.oid AND p.proowner='model_router_saas_migrator'::regrole
          AND t.tgdeferrable=w.deferred AND t.tginitdeferred=w.deferred AND t.tgqual IS NULL
          AND t.tgtype=w.type_bits AND t.tgnargs=0
      )) AS ready`);
    if(bindings.rows.length!==1||bindings.rows[0]?.ready!==true)return customerMfaFail('UNAVAILABLE');
  } catch {return customerMfaFail('UNAVAILABLE');}
}
