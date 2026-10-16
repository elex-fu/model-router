import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import { customerPasskeyFail } from './customer-passkey-types.js';

const sources = [
  {
    name: 'saas_customer_passkey_ceremony_guard',
    body: "\nBEGIN\n IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer passkey ceremony history is permanent' USING ERRCODE='55000'; END IF;\n IF TG_OP='UPDATE' AND (\n   (to_jsonb(NEW)-ARRAY['credential_id','attempt_count','consumed_at','closed_at']) IS DISTINCT FROM\n   (to_jsonb(OLD)-ARRAY['credential_id','attempt_count','consumed_at','closed_at'])\n   OR OLD.closed_at IS NOT NULL\n   OR NEW.attempt_count NOT IN (OLD.attempt_count,OLD.attempt_count+1)\n   OR (NEW.consumed_at IS NOT NULL AND NEW.closed_at IS NULL)\n   OR (NEW.credential_id IS DISTINCT FROM OLD.credential_id AND NOT (\n     OLD.ceremony='registration' AND OLD.credential_id IS NULL AND NEW.consumed_at IS NOT NULL)))\n THEN RAISE EXCEPTION 'Customer passkey ceremony transition rejected' USING ERRCODE='23514'; END IF;\n IF TG_OP='INSERT' AND (NEW.attempt_count<>0 OR NEW.consumed_at IS NOT NULL OR NEW.closed_at IS NOT NULL)\n THEN RAISE EXCEPTION 'Customer passkey ceremony must begin pending' USING ERRCODE='23514'; END IF;\n IF TG_OP='INSERT' AND (\n   (NEW.ceremony='registration' AND NEW.credential_id IS NOT NULL)\n   OR (NEW.ceremony='assertion' AND (NEW.credential_id IS NULL OR NOT EXISTS(\n     SELECT 1 FROM model_router_saas.saas_mfa_credentials c\n       WHERE c.user_id=NEW.user_id AND c.kind='passkey' AND c.credential_id=NEW.credential_id\n         AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL)))\n   OR EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=NEW.user_id)\n   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id\n     WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()\n       AND u.disabled_at IS NULL AND u.anonymized_at IS NULL))\n THEN RAISE EXCEPTION 'Customer passkey ceremony authority binding rejected' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND;\n",
  },
  {
    name: 'saas_customer_passkey_writer',
    body: "\nBEGIN\n PERFORM set_config('lock_timeout','2s',true);\n PERFORM set_config('statement_timeout','10s',true);\n PERFORM pg_advisory_xact_lock(1396788563,85);\n RETURN NULL;\nEND;\n",
  },
  {
    name: 'saas_customer_passkey_user_fence',
    body: "\nBEGIN\n IF TG_OP='DELETE' THEN\n   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text,0)); RETURN OLD;\n END IF;\n PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0)); RETURN NEW;\nEND;\n",
  },
] as const;
/** Structural readiness only. Normal migrator/deployment approves full ledger
 * and ACL manifests independently. No app ledger read, KMS or no-op verification.
 */
export async function checkCustomerPasskeySchema(tx: SqlExecutor): Promise<void> {
  try {
    const shape = await tx.query<{ ready: boolean }>(`
      WITH wanted(relation_name,column_name,type_name) AS (VALUES
    ('saas_customer_passkey_ceremonies','id','uuid'),
    ('saas_customer_passkey_ceremonies','user_id','uuid'),
    ('saas_customer_passkey_ceremonies','session_id','uuid'),
    ('saas_customer_passkey_ceremonies','ceremony','text'),
    ('saas_customer_passkey_ceremonies','challenge_hash','text'),
    ('saas_customer_passkey_ceremonies','credential_id','text'),
    ('saas_customer_passkey_ceremonies','password_digest','text'),
    ('saas_customer_passkey_ceremonies','attempt_count','integer'),
    ('saas_customer_passkey_ceremonies','created_at','timestamp with time zone'),
    ('saas_customer_passkey_ceremonies','expires_at','timestamp with time zone'),
    ('saas_customer_passkey_ceremonies','consumed_at','timestamp with time zone'),
    ('saas_customer_passkey_ceremonies','closed_at','timestamp with time zone'),
    ('saas_mfa_credentials','sign_count','bigint'))
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
          WHERE i.indrelid='model_router_saas.saas_customer_passkey_ceremonies'::regclass
            AND i.indexrelid='model_router_saas.saas_customer_passkey_one_open_ceremony'::regclass
            AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
          WHERE c.conrelid IN (SELECT DISTINCT ('model_router_saas.'||relation_name)::regclass FROM wanted)
            AND NOT c.convalidated)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='model_router_saas' AND has_function_privilege(current_user,p.oid,'EXECUTE'))
      ) AS ready`);
    if (shape.rows.length !== 1 || shape.rows[0]?.ready !== true) return customerPasskeyFail('UNAVAILABLE');
    const routines = await tx.query<{ name: string; body: string; safe: boolean }>(
      `
      SELECT p.proname AS name,p.prosrc AS body,
        (p.proowner='model_router_saas_migrator'::regrole AND NOT p.prosecdef
          AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp']
          AND l.lanname='plpgsql' AND p.prorettype='pg_catalog.trigger'::regtype
          AND p.pronargs=0 AND p.prokind='f' AND NOT p.proretset) AS safe
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname='model_router_saas' AND p.proname=ANY($1::text[])`,
      [sources.map((x) => x.name)],
    );
    if (routines.rows.length !== sources.length) return customerPasskeyFail('UNAVAILABLE');
    for (const expected of sources) {
      const matches = routines.rows.filter((r) => r.name === expected.name);
      const found = matches[0];
      if (
        matches.length !== 1 ||
        !found ||
        found.safe !== true ||
        typeof found.body !== 'string' ||
        createHash('sha256').update(found.body).digest('hex') !==
          createHash('sha256').update(expected.body).digest('hex')
      )
        return customerPasskeyFail('UNAVAILABLE');
    }
    const bindings = await tx.query<{ ready: boolean }>(`
      WITH wanted(relation_name,trigger_name,function_name,deferred,type_bits) AS (VALUES
        ('saas_customer_passkey_ceremonies','saas_customer_passkey_ceremony_guard','saas_customer_passkey_ceremony_guard',false,31),
        ('saas_customer_passkey_ceremonies','saas_customer_passkey_ceremonies_writer','saas_customer_passkey_writer',false,30),
        ('saas_customer_passkey_ceremonies','saas_customer_passkey_ceremonies_user','saas_customer_passkey_user_fence',false,29))
      SELECT NOT EXISTS(SELECT 1 FROM wanted w WHERE NOT EXISTS(
        SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='model_router_saas' AND c.relname=w.relation_name AND t.tgname=w.trigger_name
          AND t.tgenabled='O' AND NOT t.tgisinternal AND p.proname=w.function_name
          AND p.pronamespace=n.oid AND p.proowner='model_router_saas_migrator'::regrole
          AND t.tgdeferrable=w.deferred AND t.tginitdeferred=w.deferred AND t.tgqual IS NULL
          AND t.tgtype=w.type_bits AND t.tgnargs=0
      )) AS ready`);
    if (bindings.rows.length !== 1 || bindings.rows[0]?.ready !== true) return customerPasskeyFail('UNAVAILABLE');
  } catch {
    return customerPasskeyFail('UNAVAILABLE');
  }
}
