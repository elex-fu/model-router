import type { SaasMigration } from './001_initial_schema.js';

const platformAuthorizationFencesSql = `
/*
 * Authorization readers acquire the per-user shared advisory fence before
 * ordinary authority SELECTs, then lock any mutable target heads. Auth-fact
 * writers take one namespaced transaction advisory lock in a BEFORE STATEMENT
 * trigger (before tuple locks), then the matching per-user exclusive fence in
 * an AFTER ROW trigger; that writer lock serializes multi-row auth mutations
 * and both locks survive until commit. Auth writers do not acquire capacity or
 * payment target locks. Readers never row-lock auth facts, so a waiting writer
 * cannot form a row/advisory cycle with them. Login's provisional session
 * INSERT takes FK KEY SHARE locks before its trigger's exclusive fence; those
 * are compatible with ordinary disabled_at/revoked_at NO KEY UPDATE writers.
 * No authorization reader tuple-locks an existing user, role, session, or MFA
 * row.
 */
CREATE FUNCTION saas_platform_authorization_fence_users(user_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  target_user_id uuid;
BEGIN
  /* Writers fail closed instead of waiting indefinitely behind an action. */
  PERFORM set_config('lock_timeout', '2s', TRUE);
  FOR target_user_id IN
    SELECT DISTINCT candidate.user_id
      FROM unnest(user_ids) AS candidate(user_id)
     WHERE candidate.user_id IS NOT NULL
     ORDER BY candidate.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));
  END LOOP;
END;
$$;

CREATE FUNCTION saas_platform_authorization_fence_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_user_id uuid;
  new_user_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_user_id := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_user_id := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  END IF;

  PERFORM saas_platform_authorization_fence_users(ARRAY[old_user_id, new_user_id]);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

/* Serialize authorization-fact writers before they take any target tuple
 * locks. The two-int advisory namespace is separate from per-user bigint
 * fences. Statement locks address multi-row changes; user fences below make
 * each authorization decision wait only on facts for its subject. */
CREATE FUNCTION saas_platform_authorization_writer_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('lock_timeout', '2s', TRUE);
  PERFORM set_config('statement_timeout', '10s', TRUE);
  PERFORM pg_advisory_xact_lock(1396788563, 46);
  RETURN NULL;
END;
$$;

CREATE TRIGGER saas_platform_role_assignments_authorization_writer
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_role_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_platform_role_assignments_authorization_fence
  AFTER INSERT OR UPDATE OR DELETE ON saas_platform_role_assignments
  FOR EACH ROW EXECUTE FUNCTION saas_platform_authorization_fence_row('user_id');

/* Session issuance and every existing-session authority change are fenced.
 * The login path inserts its uncommitted session before its shared-fence
 * authority recheck; the trigger's exclusive lock is reentrant in that same
 * transaction and the token is returned only after commit. */
CREATE TRIGGER saas_platform_sessions_authorization_writer
  BEFORE INSERT OR UPDATE OF id, user_id, credential_id, token_hash, csrf_token_hash, expires_at, revoked_at OR DELETE
  ON saas_platform_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_platform_sessions_authorization_fence
  AFTER INSERT OR UPDATE OF id, user_id, credential_id, token_hash, csrf_token_hash, expires_at, revoked_at OR DELETE
  ON saas_platform_sessions
  FOR EACH ROW EXECUTE FUNCTION saas_platform_authorization_fence_row('user_id');

CREATE TRIGGER saas_users_platform_authorization_writer
  BEFORE UPDATE OF disabled_at, anonymized_at, email, password_hash ON saas_users
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_users_platform_authorization_fence
  AFTER UPDATE OF disabled_at, anonymized_at, email, password_hash ON saas_users
  FOR EACH ROW EXECUTE FUNCTION saas_platform_authorization_fence_row('id');

/* last_used_step is replay-CAS state, not eligibility. Login updates it in a
 * standalone statement before the final shared-fence session issuance. */
CREATE TRIGGER saas_mfa_credentials_platform_authorization_writer
  BEFORE INSERT OR DELETE OR UPDATE OF id, user_id, kind, credential_id,
    public_key, encrypted_secret, created_at, verified_at, revoked_at
  ON saas_mfa_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION saas_platform_authorization_writer_statement();
CREATE TRIGGER saas_mfa_credentials_platform_authorization_fence
  AFTER INSERT OR DELETE OR UPDATE OF id, user_id, kind, credential_id,
    public_key, encrypted_secret, created_at, verified_at, revoked_at
  ON saas_mfa_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_platform_authorization_fence_row('user_id');

/* Replace only the principal-proof clauses of the applied 024 guard, plus the
 * immutable-history row lock. Migration 012 defines a project-service key as
 * execution_principal_id = project_id with principal_user_id IS NULL; the
 * existing active key row is the durable proof. Project-service execution
 * intentionally has no creator/member identity; all tenant, project-head,
 * history-status, key, entitlement, supply, mode, route, and account guards
 * below remain byte-for-byte unchanged. Member principals retain their user
 * and both inference-capable membership checks.
 *
 * Forward-migration dependency: do not remove the FOR SHARE clauses on
 * saas_tenants, saas_projects, saas_users, saas_memberships, or
 * saas_project_memberships here. Migration 047 installs the matching tenant,
 * project, and per-user authorization writer fences later in replay order.
 * The 047 follow-up owns acquiring their matching shared advisory fences
 * before replacing these row locks with plain SELECTs. Until that replacement,
 * the gateway runtime role's SELECT-only grants cannot run this evidence path. */
DO $saas_platform_evidence_policy_lock$
DECLARE
  function_oid regprocedure := to_regprocedure('saas_prepared_request_evidence_guard()');
  function_definition text;
  rewritten_definition text;
  function_source text;
  expected_source text;
  installed_source text;
  history_lock_count integer;
  unsupported_project_service_guard constant text := $unsupported_project_service_guard$
  IF NEW.principal_kind = 'project_service' THEN
    RAISE EXCEPTION 'Project-service prepared-request evidence is unsupported'
      USING ERRCODE = '55000';
  END IF;
$unsupported_project_service_guard$;
  project_service_guard_replacement constant text := $project_service_guard_replacement$
  IF NEW.principal_kind IS DISTINCT FROM 'member'
    AND NEW.principal_kind IS DISTINCT FROM 'project_service' THEN
    RAISE EXCEPTION 'Prepared-request evidence principal kind is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.principal_kind = 'project_service'
    AND NEW.principal_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Project-service prepared-request evidence principal must match its project'
      USING ERRCODE = '23514';
  END IF;
$project_service_guard_replacement$;
  member_principal_guard constant text := $member_principal_guard$
  PERFORM 1 FROM saas_users
   WHERE id = NEW.principal_id AND disabled_at IS NULL AND anonymized_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence principal is disabled or anonymized'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM saas_memberships
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.principal_id
     AND status = 'active' AND revoked_at IS NULL
     AND role IN ('owner', 'admin', 'developer')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence tenant membership is not inference-capable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM saas_project_memberships
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND user_id = NEW.principal_id
     AND status = 'active' AND revoked_at IS NULL
     AND role IN ('owner', 'admin', 'developer')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence project membership is not inference-capable'
      USING ERRCODE = '23514';
  END IF;
$member_principal_guard$;
  conditional_member_guard constant text := $conditional_member_guard$
  IF NEW.principal_kind = 'member' THEN
    PERFORM 1 FROM saas_users
     WHERE id = NEW.principal_id AND disabled_at IS NULL AND anonymized_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Prepared-request evidence principal is disabled or anonymized'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM saas_memberships
     WHERE tenant_id = NEW.tenant_id AND user_id = NEW.principal_id
       AND status = 'active' AND revoked_at IS NULL
       AND role IN ('owner', 'admin', 'developer')
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Prepared-request evidence tenant membership is not inference-capable'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM saas_project_memberships
     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND user_id = NEW.principal_id
       AND status = 'active' AND revoked_at IS NULL
       AND role IN ('owner', 'admin', 'developer')
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Prepared-request evidence project membership is not inference-capable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
$conditional_member_guard$;
  key_principal_match constant text := $key_principal_match$
    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id
$key_principal_match$;
  key_principal_replacement constant text := $key_principal_replacement$
    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id
    OR (NEW.principal_kind = 'member'
      AND key_record.principal_user_id IS DISTINCT FROM NEW.principal_id)
    OR (NEW.principal_kind = 'project_service'
      AND key_record.principal_user_id IS NOT NULL)
$key_principal_replacement$;
  policy_history_lock_pattern constant text :=
    'AND version = NEW[.]project_policy_version[[:space:]]+FOR SHARE;';
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'Prepared-request evidence guard is missing before platform authorization fences';
  END IF;

  SELECT pg_get_functiondef(function_oid), prosrc
    INTO function_definition, function_source
    FROM pg_proc
   WHERE oid = function_oid;
  SELECT count(*) INTO history_lock_count
    FROM regexp_matches(function_source, policy_history_lock_pattern, 'g');
  IF length(function_source) - length(replace(function_source, unsupported_project_service_guard, ''))
       <> length(unsupported_project_service_guard)
     OR length(function_source) - length(replace(function_source, member_principal_guard, ''))
       <> length(member_principal_guard)
     OR length(function_source) - length(replace(function_source, key_principal_match, ''))
       <> length(key_principal_match)
     OR history_lock_count <> 1
  THEN
    RAISE EXCEPTION 'Prepared-request evidence principal or policy-history guard drifted';
  END IF;

  expected_source := replace(
    function_source,
    unsupported_project_service_guard,
    project_service_guard_replacement
  );
  expected_source := replace(expected_source, member_principal_guard, conditional_member_guard);
  expected_source := replace(expected_source, key_principal_match, key_principal_replacement);
  expected_source := regexp_replace(
    expected_source,
    policy_history_lock_pattern,
    'AND version = NEW.project_policy_version;',
    'g'
  );

  rewritten_definition := replace(
    function_definition,
    unsupported_project_service_guard,
    project_service_guard_replacement
  );
  rewritten_definition := replace(rewritten_definition, member_principal_guard, conditional_member_guard);
  rewritten_definition := replace(rewritten_definition, key_principal_match, key_principal_replacement);
  rewritten_definition := regexp_replace(
    rewritten_definition,
    policy_history_lock_pattern,
    'AND version = NEW.project_policy_version;',
    'g'
  );
  EXECUTE rewritten_definition;

  SELECT prosrc INTO installed_source FROM pg_proc WHERE oid = function_oid;
  IF installed_source IS DISTINCT FROM expected_source THEN
    RAISE EXCEPTION 'Prepared-request evidence guard rewrite changed an unapproved clause';
  END IF;
  IF installed_source LIKE '%Project-service prepared-request evidence is unsupported%'
     OR installed_source NOT LIKE '%NEW.principal_id IS DISTINCT FROM NEW.project_id%'
     OR installed_source NOT LIKE '%key_record.principal_user_id IS NOT NULL%'
     OR installed_source ~ policy_history_lock_pattern
  THEN
    RAISE EXCEPTION 'Prepared-request evidence project-service proof or history fence is invalid';
  END IF;
END;
$saas_platform_evidence_policy_lock$;
`;

export const PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION: SaasMigration = {
  version: 46,
  name: 'platform_authorization_fences',
  sql: platformAuthorizationFencesSql,
};
