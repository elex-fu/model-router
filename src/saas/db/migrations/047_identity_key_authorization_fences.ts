import type { SaasMigration } from './001_initial_schema.js';

const identityKeyAuthorizationFencesSql = `
/*
 * Requires migration 046. Its per-user helper hashes UUID text with seed 0,
 * sorts distinct UUIDs, and takes the exclusive bigint advisory lock. Readers
 * take the matching shared lock. Its statement writer fence is reused by DML
 * writer triggers before those statements take tuple locks. Callers that take
 * an explicit row lock before their DML must acquire this writer fence first.
 * Entity writers take their tenant/project/provider-rights fence after the
 * tuple change; readers never row-lock those authority relations, so they can
 * finish on the prior committed snapshot while a revocation waits.
 *
 * Authorization transactions follow the plan's tenant -> project/membership/user ->
 * API-key binding -> entitlement/profile/route/provider-rights -> audit order.
 * Rotation locks its existing key before rechecking the bound entitlement;
 * creation has no existing key row to lock. Session mutations follow 046's
 * writer order: global statement fence -> session tuple -> per-user fence.
 */
DO $saas_identity_key_authorization_fence_contract$
DECLARE
  user_fence_source text;
  writer_fence_source text;
  user_fence_oid oid := to_regprocedure('saas_platform_authorization_fence_users(uuid[])');
  writer_fence_oid oid := to_regprocedure('saas_platform_authorization_writer_statement()');
BEGIN
  IF user_fence_oid IS NULL OR writer_fence_oid IS NULL THEN
    RAISE EXCEPTION 'Migration 047 requires migration 046 authorization fence helpers';
  END IF;

  SELECT prosrc INTO user_fence_source FROM pg_proc WHERE oid = user_fence_oid;
  SELECT prosrc INTO writer_fence_source FROM pg_proc WHERE oid = writer_fence_oid;
  IF user_fence_source NOT LIKE '%SELECT DISTINCT candidate.user_id%'
     OR user_fence_source NOT LIKE '%ORDER BY candidate.user_id%'
     OR user_fence_source NOT LIKE '%PERFORM set_config(''lock_timeout'', ''2s'', TRUE)%'
     OR user_fence_source NOT LIKE '%pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0))%'
     OR writer_fence_source NOT LIKE '%PERFORM set_config(''lock_timeout'', ''2s'', TRUE)%'
     OR writer_fence_source NOT LIKE '%PERFORM set_config(''statement_timeout'', ''10s'', TRUE)%'
     OR writer_fence_source NOT LIKE '%pg_advisory_xact_lock(1396788563, 46)%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'saas_users'::regclass
          AND trigger_record.tgname = 'saas_users_platform_authorization_fence'
          AND trigger_record.tgenabled <> 'D'
          AND pg_get_triggerdef(trigger_record.oid) LIKE '%UPDATE OF disabled_at%'
          AND pg_get_triggerdef(trigger_record.oid) LIKE '%saas_platform_authorization_fence_row(''id'')%'
          AND NOT trigger_record.tgisinternal
     )
  THEN
    RAISE EXCEPTION 'Migration 046 authorization fence semantics or user trigger drifted';
  END IF;
END;
$saas_identity_key_authorization_fence_contract$;

CREATE FUNCTION saas_control_plane_authorization_fence_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  old_fence_key text;
  new_fence_key text;
  target_fence_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;

  IF TG_ARGV[0] = 'provider_rights' THEN
    old_fence_key := 'saas-authz:provider-rights';
    new_fence_key := old_fence_key;
  ELSIF TG_ARGV[0] = 'tenant' THEN
    IF old_row IS NOT NULL THEN
      old_fence_key := 'saas-authz:tenant:' || (old_row ->> TG_ARGV[1]);
    END IF;
    IF new_row IS NOT NULL THEN
      new_fence_key := 'saas-authz:tenant:' || (new_row ->> TG_ARGV[1]);
    END IF;
  ELSIF TG_ARGV[0] = 'project' THEN
    IF old_row IS NOT NULL THEN
      old_fence_key := 'saas-authz:project:' || (old_row ->> TG_ARGV[1]) || ':' || (old_row ->> TG_ARGV[2]);
    END IF;
    IF new_row IS NOT NULL THEN
      new_fence_key := 'saas-authz:project:' || (new_row ->> TG_ARGV[1]) || ':' || (new_row ->> TG_ARGV[2]);
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported authorization fence scope: %', TG_ARGV[0];
  END IF;

  FOR target_fence_key IN
    SELECT DISTINCT candidate.fence_key
      FROM unnest(ARRAY[old_fence_key, new_fence_key]) AS candidate(fence_key)
     WHERE candidate.fence_key IS NOT NULL
     ORDER BY candidate.fence_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(target_fence_key, 0));
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

/* Tenant and membership authority. INSERT only grants new authority; a reader
 * that misses an uncommitted grant fails closed. Changes that can revoke or
 * replace existing authority wait on the tenant fence. */
CREATE TRIGGER saas_tenants_authorization_writer
  BEFORE UPDATE OF status OR DELETE ON saas_tenants
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_tenants_authorization_fence
  AFTER UPDATE OF status OR DELETE ON saas_tenants
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('tenant', 'id');

CREATE TRIGGER saas_memberships_authorization_writer
  BEFORE UPDATE OR DELETE ON saas_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_memberships_authorization_fence
  AFTER UPDATE OR DELETE ON saas_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('tenant', 'tenant_id');

CREATE TRIGGER saas_project_memberships_authorization_writer
  BEFORE UPDATE OR DELETE ON saas_project_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_project_memberships_authorization_fence
  AFTER UPDATE OR DELETE ON saas_project_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('tenant', 'tenant_id');

/* Project policy, entitlement, and route heads. Version/history rows stay
 * immutable and are read with ordinary SELECTs. */
CREATE TRIGGER saas_projects_authorization_writer
  BEFORE UPDATE OF inference_policy_version, inference_policy_status OR DELETE ON saas_projects
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_projects_authorization_fence
  AFTER UPDATE OF inference_policy_version, inference_policy_status OR DELETE ON saas_projects
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('project', 'tenant_id', 'id');

CREATE TRIGGER saas_project_entitlements_authorization_writer
  BEFORE INSERT OR DELETE OR UPDATE OF tenant_id, project_id, supply_profile_id, supply_mode,
    status, model_scopes, authz_version, effective_at, expires_at, superseded_at, disabled_at
  ON saas_project_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_project_entitlements_authorization_fence
  AFTER INSERT OR DELETE OR UPDATE OF tenant_id, project_id, supply_profile_id, supply_mode,
    status, model_scopes, authz_version, effective_at, expires_at, superseded_at, disabled_at
  ON saas_project_entitlements
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('project', 'tenant_id', 'project_id');

CREATE TRIGGER saas_supply_profiles_authorization_writer
  BEFORE UPDATE OR DELETE ON saas_supply_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_supply_profiles_authorization_fence
  AFTER UPDATE OR DELETE ON saas_supply_profiles
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('tenant', 'tenant_id');

CREATE TRIGGER saas_route_config_heads_authorization_writer
  BEFORE INSERT OR UPDATE OR DELETE ON saas_route_config_heads
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_route_config_heads_authorization_fence
  AFTER INSERT OR UPDATE OR DELETE ON saas_route_config_heads
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('project', 'tenant_id', 'project_id');

/* Provider rights are append-only versions; insertion of a newer version can
 * retire the formerly current version, so readers fence the complete history. */
CREATE TRIGGER saas_provider_rights_authorization_writer
  BEFORE INSERT OR UPDATE OR DELETE ON saas_provider_rights
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_provider_rights_authorization_fence
  AFTER INSERT OR UPDATE OR DELETE ON saas_provider_rights
  FOR EACH ROW EXECUTE FUNCTION saas_control_plane_authorization_fence_row('provider_rights');
`;

export const IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION: SaasMigration = {
  version: 47,
  name: 'identity_key_authorization_fences',
  sql: identityKeyAuthorizationFencesSql,
};
