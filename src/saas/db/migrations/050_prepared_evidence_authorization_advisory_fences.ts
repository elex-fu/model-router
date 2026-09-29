import type { SaasMigration } from './001_initial_schema.js';

/*
 * 050 is a registered, forward-only repair for installations with migrations
 * 044-049. It verifies every dependency below before replacing the installed
 * authorization and prepared-evidence guards.
 *
 * The 024/046 evidence trigger used tuple locks for every authority fact.
 * Most of those relations are SELECT-only for the gateway role, so the
 * tuple-lock form is both unavailable to the role and capable of creating a
 * reverse tuple/advisory wait.  This migration replaces those authority
 * locks with shared transaction advisory fences.  Request and attempt rows
 * remain the two precise integrity locks because the gateway has the existing
 * column UPDATE contract for those rows.
 */
const preparedEvidenceAuthorizationAdvisoryFencesSql = `
/*
 * 044 accidentally qualified the durable outbox through public.  The
 * database relation is owned by model_router_saas.  Rewrite only that exact
 * reference after proving the function, trigger, and target relation are the
 * expected ones; retain all other function attributes and body text.
 */
DO $saas_project_policy_invalidation_schema_repair$
DECLARE
  function_oid regprocedure := to_regprocedure('model_router_saas.saas_projects_emit_inference_policy_invalidation()');
  function_definition text;
  function_source text;
  rewritten_definition text;
  installed_source text;
  wrong_relation constant text := concat_ws('.', 'public', 'saas_project_policy_invalidation_outbox');
  correct_relation constant text := concat_ws('.', 'model_router_saas', 'saas_project_policy_invalidation_outbox');
BEGIN
  IF function_oid IS NULL
     OR to_regclass(correct_relation) IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = to_regclass('model_router_saas.saas_projects')
          AND trigger_record.tgname = 'saas_projects_policy_invalidation_outbox'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled <> 'D'
          AND pg_get_triggerdef(trigger_record.oid) LIKE '%saas_projects_emit_inference_policy_invalidation%'
     )
  THEN
    RAISE EXCEPTION 'Migration 050 requires the 044 project-policy outbox relation and trigger';
  END IF;

  SELECT pg_get_functiondef(function_oid), prosrc
    INTO function_definition, function_source
    FROM pg_proc
   WHERE oid = function_oid;
  IF length(function_source) - length(replace(function_source, wrong_relation, '')) <> length(wrong_relation)
     OR function_source NOT LIKE '%INSERT INTO ' || wrong_relation || '%'
  THEN
    RAISE EXCEPTION 'Migration 050 found an unexpected 044 outbox function body';
  END IF;

  rewritten_definition := replace(function_definition, wrong_relation, correct_relation);
  IF rewritten_definition = function_definition THEN
    RAISE EXCEPTION 'Migration 050 did not find the schema-qualified 044 outbox reference';
  END IF;
  EXECUTE rewritten_definition;

  SELECT prosrc INTO installed_source FROM pg_proc WHERE oid = function_oid;
  IF installed_source LIKE '%' || wrong_relation || '%'
     OR installed_source NOT LIKE '%' || correct_relation || '%'
  THEN
    RAISE EXCEPTION 'Migration 050 failed to repair the 044 outbox schema reference';
  END IF;
END;
$saas_project_policy_invalidation_schema_repair$;

/*
 * 046's exact installed principal and policy-history contract. These constants
 * are byte-for-byte anchors for the already-rewritten 024 trigger source. A
 * missing or duplicated anchor fails closed instead of silently installing a
 * broader rewrite against drifted code.
 */
DO $saas_prepared_evidence_dependency_contract$
DECLARE
  prepared_guard_oid regprocedure := to_regprocedure('model_router_saas.saas_prepared_request_evidence_guard()');
  attempt_guard_oid regprocedure := to_regprocedure('model_router_saas.saas_attempts_guard_prepared_evidence()');
  pool_guard_oid regprocedure := to_regprocedure('model_router_saas.saas_prepared_request_evidence_platform_pool_fence()');
  claim_pool_guard_oid regprocedure := to_regprocedure('model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()');
  required_relation text;
  required_relations constant text[] := ARRAY[
    'saas_tenants',
    'saas_projects',
    'saas_project_inference_policy_versions',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_api_keys',
    'saas_requests',
    'saas_attempts',
    'saas_prepared_request_evidence',
    'saas_project_entitlements',
    'saas_supply_profiles',
    'saas_route_config_versions',
    'saas_route_config_heads',
    'saas_public_model_versions',
    'saas_public_models',
    'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_heads',
    'saas_customer_metering_policy_versions',
    'saas_provider_metering_policy_heads',
    'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations',
    'saas_tenant_provider_supply_profile_accounts',
    'saas_tenant_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_platform_provider_pools',
    'saas_platform_provider_pool_members',
    'saas_platform_provider_pool_grants',
    'saas_platform_provider_accounts',
    'saas_platform_provider_credentials',
    'saas_platform_provider_credential_versions',
    'saas_customer_price_versions',
    'saas_supplier_cost_versions',
    'saas_refund_service_plan_effects'
  ];
  required_column text;
  required_columns constant text[] := ARRAY[
    'saas_prepared_request_evidence:tenant_id',
    'saas_prepared_request_evidence:project_id',
    'saas_prepared_request_evidence:principal_id',
    'saas_prepared_request_evidence:proxy_key_id',
    'saas_prepared_request_evidence:request_id',
    'saas_prepared_request_evidence:attempt_id',
    'saas_prepared_request_evidence:supply_mode',
    'saas_prepared_request_evidence:pool_id',
    'saas_prepared_request_evidence:dispatch_profile_id',
    'saas_prepared_request_evidence:account_id',
    'saas_prepared_request_evidence:credential_id',
    'saas_prepared_request_evidence:credential_version',
    'saas_prepared_request_evidence:profile_account_authz_version',
    'saas_prepared_request_evidence:pool_grant_pool_authz_version',
    'saas_requests:tenant_id',
    'saas_requests:id',
    'saas_attempts:tenant_id',
    'saas_attempts:id'
  ];
  relation_oid oid;
  column_name text;
BEGIN
  FOREACH required_relation IN ARRAY required_relations LOOP
    IF to_regclass('model_router_saas.' || required_relation) IS NULL THEN
      RAISE EXCEPTION 'Migration 050 dependency relation is missing: %', required_relation;
    END IF;
  END LOOP;

  FOREACH required_column IN ARRAY required_columns LOOP
    relation_oid := to_regclass('model_router_saas.' || split_part(required_column, ':', 1));
    column_name := split_part(required_column, ':', 2);
    IF relation_oid IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM pg_attribute attribute_record
          WHERE attribute_record.attrelid = relation_oid
            AND attribute_record.attname = column_name
            AND attribute_record.attnum > 0
            AND NOT attribute_record.attisdropped
       )
    THEN
      RAISE EXCEPTION 'Migration 050 dependency column is missing: %', required_column;
    END IF;
  END LOOP;

  IF prepared_guard_oid IS NULL
     OR attempt_guard_oid IS NULL
     OR pool_guard_oid IS NULL
     OR claim_pool_guard_oid IS NULL
     OR to_regprocedure('model_router_saas.saas_platform_authorization_fence_users(uuid[])') IS NULL
     OR to_regprocedure('model_router_saas.saas_platform_authorization_writer_statement()') IS NULL
     OR to_regprocedure('model_router_saas.saas_platform_authorization_fence_row()') IS NULL
  THEN
    RAISE EXCEPTION 'Migration 050 requires the installed 046-048 authorization functions';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc procedure_record
        WHERE procedure_record.oid = to_regprocedure('model_router_saas.saas_platform_authorization_fence_users(uuid[])')
          AND procedure_record.prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0))%'
          AND procedure_record.prosrc LIKE '%ORDER BY candidate.user_id%'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc procedure_record
        WHERE procedure_record.oid = to_regprocedure('model_router_saas.saas_platform_authorization_writer_statement()')
          AND procedure_record.prosrc LIKE '%pg_advisory_xact_lock(1396788563, 46)%'
     )
  THEN
    RAISE EXCEPTION 'Migration 050 found drifted 046 authorization fence helpers';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = to_regclass('model_router_saas.saas_users')
          AND trigger_record.tgname = 'saas_users_platform_authorization_fence'
          AND trigger_record.tgenabled <> 'D'
          AND pg_get_triggerdef(trigger_record.oid) LIKE '%UPDATE OF disabled_at%'
          AND pg_get_triggerdef(trigger_record.oid) LIKE '%saas_platform_authorization_fence_row(''id'')%'
     )
  THEN
    RAISE EXCEPTION 'Migration 050 requires the 047 identity writer contract';
  END IF;
END;
$saas_prepared_evidence_dependency_contract$;

/* Shared-fence keys used by the rewritten evidence reader. */
DO $saas_prepared_evidence_guard_rewrite$
DECLARE
  function_oid regprocedure := to_regprocedure('model_router_saas.saas_prepared_request_evidence_guard()');
  function_definition text;
  rewritten_definition text;
  function_source text;
  expected_source text;
  installed_source text;
  history_lock_count integer;
  tenant_anchor_bytes integer;
  profile_anchor_bytes integer;
  request_anchor_bytes integer;
  attempt_anchor_bytes integer;
  target_fence_key_declaration_bytes integer;
  authorization_fence_preamble constant text := $authorization_fence_preamble$
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('saas-authz:tenant:' || NEW.tenant_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas-authz:project:' || NEW.tenant_id::text || ':' || NEW.project_id::text,
      0
    )
  );
  IF NEW.principal_kind = 'member' THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.principal_id::text, 0));
  END IF;
  FOR target_fence_key IN
    SELECT DISTINCT candidate.fence_key
      FROM unnest(ARRAY[
        'saas-authz:api-key:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.project_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.proxy_key_id::text, 'UTF8'), 'hex'),
        'saas-authz:commercial-customer:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.customer_metering_policy_id::text, 'UTF8'), 'hex'),
        'saas-authz:commercial-provider:'
          || encode(convert_to(NEW.provider_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.provider_metering_policy_id::text, 'UTF8'), 'hex'),
        'saas-authz:provider-rights'
      ]) AS candidate(fence_key)
     WHERE candidate.fence_key IS NOT NULL
     ORDER BY candidate.fence_key
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_fence_key, 0));
  END LOOP;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas_public_model:' || encode(convert_to(NEW.route_public_model_id::text, 'UTF8'), 'hex'),
      0
    )
  );
$authorization_fence_preamble$;
  tenant_read_anchor constant text := $tenant_read_anchor$
  PERFORM 1 FROM saas_tenants WHERE id = NEW.tenant_id AND status = 'active' FOR SHARE;
$tenant_read_anchor$;
  supply_fence_preamble constant text := $supply_fence_preamble$
  IF NEW.supply_mode = 'platform' THEN
    IF NEW.pool_id IS NULL THEN
      RAISE EXCEPTION 'Prepared-request evidence platform pool context is missing'
        USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas_platform_pool:' || encode(convert_to(NEW.pool_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  END IF;
  FOR target_fence_key IN
    SELECT DISTINCT candidate.fence_key
      FROM unnest(ARRAY[
        'saas_supply_profile:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.supply_profile_id::text, 'UTF8'), 'hex'),
        'saas_supply_profile:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.dispatch_profile_id::text, 'UTF8'), 'hex')
      ]) AS candidate(fence_key)
     WHERE candidate.fence_key IS NOT NULL
     ORDER BY candidate.fence_key
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_fence_key, 0));
  END LOOP;

  IF NEW.account_owner_kind = 'tenant' THEN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:tenant-provider-account:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.account_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  ELSE
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:platform-provider-account:'
          || encode(convert_to(NEW.account_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  END IF;

  IF NEW.account_owner_kind = 'tenant' THEN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:tenant-provider-credential:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.credential_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  ELSE
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:platform-provider-credential:'
          || encode(convert_to(NEW.credential_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas-authz:credential-version:' || NEW.account_owner_kind::text || ':'
        || encode(
             convert_to(
               CASE WHEN NEW.account_owner_kind = 'tenant' THEN NEW.tenant_id::text ELSE 'platform' END,
               'UTF8'
             ),
             'hex'
           ) || ':'
        || encode(convert_to(NEW.credential_id::text, 'UTF8'), 'hex') || ':'
        || NEW.credential_version::text,
      0
    )
  );

  IF NEW.account_owner_kind = 'tenant' AND NEW.supply_mode = 'byok' THEN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:supply-profile-account:'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.dispatch_profile_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.account_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  ELSE
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:member:'
          || encode(convert_to(NEW.pool_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.account_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.provider_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.product_id::text, 'UTF8'), 'hex'),
        0
      )
    );
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended(
        'saas-authz:grant:'
          || encode(convert_to(NEW.pool_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':'
          || encode(convert_to(NEW.dispatch_profile_id::text, 'UTF8'), 'hex'),
        0
      )
    );
  END IF;
$supply_fence_preamble$;
  profile_read_anchor constant text := $profile_read_anchor$
  SELECT p.status, p.authz_version, p.supply_mode, p.model_scopes
    INTO profile_record
    FROM saas_supply_profiles p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.supply_profile_id
     AND p.supply_mode = NEW.supply_mode
   FOR SHARE;
$profile_read_anchor$;
  request_lock_anchor constant text := $request_lock_anchor$
  SELECT * INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id
   FOR SHARE;
$request_lock_anchor$;
  attempt_lock_anchor constant text := $attempt_lock_anchor$
  SELECT * INTO attempt_record
    FROM saas_attempts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.attempt_id
   FOR SHARE;
$attempt_lock_anchor$;
  target_fence_key_declaration_anchor constant text := $target_fence_key_declaration_anchor$
  locked_at timestamptz;
$target_fence_key_declaration_anchor$;
  target_fence_key_declaration_replacement constant text := $target_fence_key_declaration_replacement$
  locked_at timestamptz;
  target_fence_key text;
$target_fence_key_declaration_replacement$;
  project_service_guard constant text := $project_service_guard$
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
$project_service_guard$;
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
  key_principal_guard constant text := $key_principal_guard$
    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id
    OR (NEW.principal_kind = 'member'
      AND key_record.principal_user_id IS DISTINCT FROM NEW.principal_id)
    OR (NEW.principal_kind = 'project_service'
      AND key_record.principal_user_id IS NOT NULL)
$key_principal_guard$;
  policy_history_lock_pattern constant text :=
    'AND version = NEW[.]project_policy_version[[:space:]]+FOR SHARE;';
  target_fence_key text;
  request_placeholder constant text := '__SAAS_KEEP_REQUEST_FOR_SHARE__';
  attempt_placeholder constant text := '__SAAS_KEEP_ATTEMPT_FOR_SHARE__';
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'Prepared-request evidence guard is missing before migration 050';
  END IF;

  SELECT pg_get_functiondef(function_oid), prosrc
    INTO function_definition, function_source
    FROM pg_proc
   WHERE oid = function_oid;
  SELECT count(*) INTO history_lock_count
    FROM regexp_matches(function_source, policy_history_lock_pattern, 'g');
  tenant_anchor_bytes := length(function_source) - length(replace(function_source, tenant_read_anchor, ''));
  profile_anchor_bytes := length(function_source) - length(replace(function_source, profile_read_anchor, ''));
  request_anchor_bytes := length(function_source) - length(replace(function_source, request_lock_anchor, ''));
  attempt_anchor_bytes := length(function_source) - length(replace(function_source, attempt_lock_anchor, ''));
  target_fence_key_declaration_bytes := length(function_source)
    - length(replace(function_source, target_fence_key_declaration_anchor, ''));

  IF length(function_source) - length(replace(function_source, project_service_guard, ''))
       <> length(project_service_guard)
     OR length(function_source) - length(replace(function_source, conditional_member_guard, ''))
       <> length(conditional_member_guard)
     OR length(function_source) - length(replace(function_source, key_principal_guard, ''))
       <> length(key_principal_guard)
     OR history_lock_count <> 0
     OR tenant_anchor_bytes <> length(tenant_read_anchor)
     OR profile_anchor_bytes <> length(profile_read_anchor)
     OR request_anchor_bytes <> length(request_lock_anchor)
     OR attempt_anchor_bytes <> length(attempt_lock_anchor)
     OR target_fence_key_declaration_bytes <> length(target_fence_key_declaration_anchor)
  THEN
    RAISE EXCEPTION 'Prepared-request evidence guard or dependency source drifted'
      USING DETAIL = format(
        'project-service-bytes=%s/%s conditional-member-bytes=%s/%s key-principal-bytes=%s/%s history-lock-count=%s tenant-anchor-bytes=%s/%s profile-anchor-bytes=%s/%s request-anchor-bytes=%s/%s attempt-anchor-bytes=%s/%s fence-variable-declaration-bytes=%s/%s',
        length(function_source) - length(replace(function_source, project_service_guard, '')),
        length(project_service_guard),
        length(function_source) - length(replace(function_source, conditional_member_guard, '')),
        length(conditional_member_guard),
        length(function_source) - length(replace(function_source, key_principal_guard, '')),
        length(key_principal_guard),
        history_lock_count,
        tenant_anchor_bytes,
        length(tenant_read_anchor),
        profile_anchor_bytes,
        length(profile_read_anchor),
        request_anchor_bytes,
        length(request_lock_anchor),
        attempt_anchor_bytes,
        length(attempt_lock_anchor),
        target_fence_key_declaration_bytes,
        length(target_fence_key_declaration_anchor)
      );
  END IF;

  expected_source := replace(
    function_source,
    target_fence_key_declaration_anchor,
    target_fence_key_declaration_replacement
  );
  expected_source := replace(
    expected_source,
    tenant_read_anchor,
    authorization_fence_preamble || supply_fence_preamble || tenant_read_anchor
  );
  expected_source := replace(expected_source, request_lock_anchor, replace(request_lock_anchor, 'FOR SHARE;', request_placeholder));
  expected_source := replace(expected_source, attempt_lock_anchor, replace(attempt_lock_anchor, 'FOR SHARE;', attempt_placeholder));
  expected_source := regexp_replace(expected_source, policy_history_lock_pattern, 'AND version = NEW.project_policy_version;', 'g');
  expected_source := replace(expected_source, 'FOR SHARE;', ';');
  expected_source := replace(expected_source, request_placeholder, 'FOR SHARE;');
  expected_source := replace(expected_source, attempt_placeholder, 'FOR SHARE;');

  rewritten_definition := replace(
    function_definition,
    target_fence_key_declaration_anchor,
    target_fence_key_declaration_replacement
  );
  rewritten_definition := replace(
    rewritten_definition,
    tenant_read_anchor,
    authorization_fence_preamble || supply_fence_preamble || tenant_read_anchor
  );
  rewritten_definition := replace(rewritten_definition, request_lock_anchor, replace(request_lock_anchor, 'FOR SHARE;', request_placeholder));
  rewritten_definition := replace(rewritten_definition, attempt_lock_anchor, replace(attempt_lock_anchor, 'FOR SHARE;', attempt_placeholder));
  rewritten_definition := regexp_replace(rewritten_definition, policy_history_lock_pattern, 'AND version = NEW.project_policy_version;', 'g');
  rewritten_definition := replace(rewritten_definition, 'FOR SHARE;', ';');
  rewritten_definition := replace(rewritten_definition, request_placeholder, 'FOR SHARE;');
  rewritten_definition := replace(rewritten_definition, attempt_placeholder, 'FOR SHARE;');

  EXECUTE rewritten_definition;
  SELECT prosrc INTO installed_source FROM pg_proc WHERE oid = function_oid;
  IF installed_source IS DISTINCT FROM expected_source
     OR installed_source LIKE '%Project-service prepared-request evidence is unsupported%'
     OR installed_source ~ policy_history_lock_pattern
     OR length(installed_source) - length(replace(installed_source, 'FOR SHARE;', ''))
       <> 2 * length('FOR SHARE;')
     OR installed_source NOT LIKE '%pg_advisory_xact_lock_shared%'
     OR installed_source NOT LIKE '%saas_public_model:%'
     OR installed_source NOT LIKE '%saas-authz:provider-rights%'
     OR installed_source NOT LIKE '%saas_platform_pool:%'
     OR installed_source NOT LIKE '%saas_supply_profile:%'
  THEN
    RAISE EXCEPTION 'Migration 050 installed an unexpected prepared-request evidence guard';
  END IF;
END;
$saas_prepared_evidence_guard_rewrite$;

/* The 028 pool readers use the same exact pool key as the main guard. */
DO $saas_prepared_evidence_pool_rewrite$
DECLARE
  pool_function_oid regprocedure := to_regprocedure('model_router_saas.saas_prepared_request_evidence_platform_pool_fence()');
  claim_function_oid regprocedure := to_regprocedure('model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()');
  pool_definition text;
  claim_definition text;
  pool_source text;
  claim_source text;
  rewritten_definition text;
  pool_fence_preamble constant text := $pool_fence_preamble$
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas_platform_pool:' || encode(convert_to(NEW.pool_id::text, 'UTF8'), 'hex'),
      0
    )
  );
$pool_fence_preamble$;
  pool_read_anchor constant text := $pool_read_anchor$
  SELECT provider_id, product_id, status, validation_state, authz_version
    INTO pool_record
    FROM saas_platform_provider_pools
   WHERE id = NEW.pool_id
   FOR SHARE;
$pool_read_anchor$;
  pool_placeholder constant text := '__SAAS_KEEP_POOL_FOR_SHARE__';
BEGIN
  IF pool_function_oid IS NULL OR claim_function_oid IS NULL THEN
    RAISE EXCEPTION 'Migration 050 requires the 028 pool guard functions';
  END IF;
  SELECT pg_get_functiondef(pool_function_oid), prosrc INTO pool_definition, pool_source FROM pg_proc WHERE oid = pool_function_oid;
  SELECT pg_get_functiondef(claim_function_oid), prosrc INTO claim_definition, claim_source FROM pg_proc WHERE oid = claim_function_oid;
  IF length(pool_source) - length(replace(pool_source, pool_read_anchor, '')) <> length(pool_read_anchor)
     OR length(claim_source) - length(replace(claim_source, pool_read_anchor, '')) <> length(pool_read_anchor)
     OR pool_source NOT LIKE '%NEW.account_owner_kind IS DISTINCT FROM ''platform''%'
     OR claim_source NOT LIKE '%NEW.account_owner_kind IS DISTINCT FROM ''platform''%'
  THEN
    RAISE EXCEPTION 'Migration 050 found drifted 028 pool guard sources';
  END IF;

  rewritten_definition := replace(pool_definition, pool_read_anchor, pool_fence_preamble || replace(pool_read_anchor, 'FOR SHARE;', ';'));
  EXECUTE rewritten_definition;
  rewritten_definition := replace(claim_definition, pool_read_anchor, pool_fence_preamble || replace(pool_read_anchor, 'FOR SHARE;', ';'));
  EXECUTE rewritten_definition;

  SELECT prosrc INTO pool_source FROM pg_proc WHERE oid = pool_function_oid;
  SELECT prosrc INTO claim_source FROM pg_proc WHERE oid = claim_function_oid;
  IF pool_source LIKE '%FROM saas_platform_provider_pools%FOR SHARE;%'
     OR pool_source NOT LIKE '%saas_platform_pool:%'
     OR claim_source LIKE '%FROM saas_platform_provider_pools%FOR SHARE;%'
     OR claim_source NOT LIKE '%saas_platform_pool:%'
     OR claim_source NOT LIKE '%FROM saas_prepared_request_evidence%FOR SHARE;%'
  THEN
    RAISE EXCEPTION 'Migration 050 installed an unexpected 028 pool guard';
  END IF;
END;
$saas_prepared_evidence_pool_rewrite$;

/*
 * Row-scoped writer fences.  Every trigger supplies the complete old/new
 * identity context it needs.  Missing context is an error; there is no
 * fallback to a table-wide advisory key.
 *
 * The resource order is explicit and matches the evidence readers:
 * tenant -> project -> user -> business -> catalog -> pool -> profile -> account
 * -> credential -> version -> mapping -> member -> grant.  Keys are sorted
 * only inside a resource layer.  A single lexical sort across heterogeneous
 * key names would allow a profile writer and a tenant reader to acquire the
 * same resources in opposite orders.
 */
CREATE FUNCTION saas_prepared_evidence_writer_require_value(row_value jsonb, column_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  raw_value text;
BEGIN
  IF row_value IS NULL OR column_name IS NULL OR btrim(column_name) = '' THEN
    RAISE EXCEPTION 'Migration 050 writer fence value context is incomplete';
  END IF;
  raw_value := row_value ->> column_name;
  IF raw_value IS NULL OR raw_value = '' THEN
    RAISE EXCEPTION 'Migration 050 writer fence column is missing: %', column_name;
  END IF;
  RETURN raw_value;
END;
$$;

CREATE FUNCTION saas_prepared_evidence_writer_lock_layer(fence_keys text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  target_key text;
BEGIN
  FOR target_key IN
    SELECT DISTINCT candidate.key_text
      FROM unnest(coalesce(fence_keys, ARRAY[]::text[])) AS candidate(key_text)
     WHERE candidate.key_text IS NOT NULL
       AND candidate.key_text <> ''
     ORDER BY candidate.key_text
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(target_key, 0));
  END LOOP;
END;
$$;

CREATE FUNCTION saas_prepared_evidence_authorization_writer_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  current_row jsonb;
  current_is_old boolean;
  scope text := TG_ARGV[0];
  tier text;
  current_tenant text;
  current_project text;
  current_user_id text;
  current_api_key text;
  current_policy text;
  current_provider text;
  current_public_model text;
  current_pool text;
  current_profile text;
  current_account text;
  current_credential text;
  current_version text;
  current_owner_kind text;
  current_owner_id text;
  current_product text;
  current_key text;
  old_tenant_keys text[] := ARRAY[]::text[];
  old_project_keys text[] := ARRAY[]::text[];
  old_user_keys text[] := ARRAY[]::text[];
  old_business_keys text[] := ARRAY[]::text[];
  old_catalog_keys text[] := ARRAY[]::text[];
  old_pool_keys text[] := ARRAY[]::text[];
  old_profile_keys text[] := ARRAY[]::text[];
  old_account_keys text[] := ARRAY[]::text[];
  old_credential_keys text[] := ARRAY[]::text[];
  old_version_keys text[] := ARRAY[]::text[];
  old_mapping_keys text[] := ARRAY[]::text[];
  old_member_keys text[] := ARRAY[]::text[];
  old_grant_keys text[] := ARRAY[]::text[];
  new_tenant_keys text[] := ARRAY[]::text[];
  new_project_keys text[] := ARRAY[]::text[];
  new_user_keys text[] := ARRAY[]::text[];
  new_business_keys text[] := ARRAY[]::text[];
  new_catalog_keys text[] := ARRAY[]::text[];
  new_pool_keys text[] := ARRAY[]::text[];
  new_profile_keys text[] := ARRAY[]::text[];
  new_account_keys text[] := ARRAY[]::text[];
  new_credential_keys text[] := ARRAY[]::text[];
  new_version_keys text[] := ARRAY[]::text[];
  new_mapping_keys text[] := ARRAY[]::text[];
  new_member_keys text[] := ARRAY[]::text[];
  new_grant_keys text[] := ARRAY[]::text[];
  old_all_keys text[];
  new_all_keys text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;

  IF scope IS NULL OR scope = '' THEN
    RAISE EXCEPTION 'Migration 050 writer fence scope is missing';
  END IF;

  FOR current_is_old, current_row IN
    SELECT true, old_row
    UNION ALL
    SELECT false, new_row
  LOOP
    IF current_row IS NULL THEN
      CONTINUE;
    END IF;

    IF scope = 'tenant' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_key := 'saas-authz:tenant:' || current_tenant;
      IF current_is_old THEN old_tenant_keys := old_tenant_keys || ARRAY[current_key];
      ELSE new_tenant_keys := new_tenant_keys || ARRAY[current_key]; END IF;

    ELSIF scope = 'project' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
      END IF;

    ELSIF scope = 'tenant_user' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_user_id := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_user_keys := old_user_keys || ARRAY[current_user_id];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_user_keys := new_user_keys || ARRAY[current_user_id];
      END IF;

    ELSIF scope = 'project_user' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_user_id := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        old_user_keys := old_user_keys || ARRAY[current_user_id];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        new_user_keys := new_user_keys || ARRAY[current_user_id];
      END IF;

    ELSIF scope = 'project_catalog' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_public_model := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_key := 'saas_public_model:' || encode(convert_to(current_public_model, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        old_catalog_keys := old_catalog_keys || ARRAY[current_key];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        new_catalog_keys := new_catalog_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'entitlement' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_profile := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_key := 'saas_supply_profile:' ||
        encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_profile, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        old_profile_keys := old_profile_keys || ARRAY[current_key];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        new_profile_keys := new_profile_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'user' THEN
      current_user_id := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      IF current_is_old THEN old_user_keys := old_user_keys || ARRAY[current_user_id];
      ELSE new_user_keys := new_user_keys || ARRAY[current_user_id]; END IF;

    ELSIF scope = 'api_key' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_api_key := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_profile := saas_prepared_evidence_writer_require_value(current_row, 'supply_profile_id');
      current_key := 'saas-authz:api-key:' ||
        encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_project, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_api_key, 'UTF8'), 'hex');
      current_user_id := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        old_user_keys := old_user_keys || ARRAY[current_user_id];
        old_business_keys := old_business_keys || ARRAY[current_key];
        old_profile_keys := old_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
        new_user_keys := new_user_keys || ARRAY[current_user_id];
        new_business_keys := new_business_keys || ARRAY[current_key];
        new_profile_keys := new_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
      END IF;

    ELSIF scope = 'commercial' THEN
      tier := TG_ARGV[1];
      IF tier IS DISTINCT FROM 'customer' AND tier IS DISTINCT FROM 'provider' THEN
        RAISE EXCEPTION 'Migration 050 writer fence has an invalid commercial tier';
      END IF;
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_project := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_policy := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_project_keys := old_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_project_keys := new_project_keys || ARRAY['saas-authz:project:' || current_tenant || ':' || current_project];
      END IF;
      IF tier = 'customer' THEN
        current_key := 'saas-authz:commercial-customer:' ||
          encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_policy, 'UTF8'), 'hex');
      ELSIF TG_ARGV[5] IS NOT NULL AND btrim(TG_ARGV[5]) <> '' THEN
        current_provider := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[5]);
        current_key := 'saas-authz:commercial-provider:' ||
          encode(convert_to(current_provider, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_policy, 'UTF8'), 'hex');
      ELSE
        current_key := NULL;
      END IF;
      IF current_key IS NOT NULL THEN
        IF current_is_old THEN old_business_keys := old_business_keys || ARRAY[current_key];
        ELSE new_business_keys := new_business_keys || ARRAY[current_key]; END IF;
      END IF;

    ELSIF scope = 'pool' THEN
      current_pool := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_key := 'saas_platform_pool:' || encode(convert_to(current_pool, 'UTF8'), 'hex');
      IF current_is_old THEN old_pool_keys := old_pool_keys || ARRAY[current_key];
      ELSE new_pool_keys := new_pool_keys || ARRAY[current_key]; END IF;

    ELSIF scope = 'profile' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_profile := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_key := 'saas_supply_profile:' ||
        encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_profile, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_profile_keys := old_profile_keys || ARRAY[current_key];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_profile_keys := new_profile_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'provider_account' THEN
      current_owner_kind := TG_ARGV[1];
      IF current_owner_kind = 'tenant' THEN
        current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
        current_key := 'saas-authz:tenant-provider-account:' ||
          encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_account, 'UTF8'), 'hex');
      ELSIF current_owner_kind = 'platform' THEN
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_key := 'saas-authz:platform-provider-account:' ||
          encode(convert_to(current_account, 'UTF8'), 'hex');
      ELSE
        RAISE EXCEPTION 'Migration 050 writer fence has an invalid account owner kind';
      END IF;
      IF current_is_old THEN
        IF current_owner_kind = 'tenant' THEN old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant]; END IF;
        old_account_keys := old_account_keys || ARRAY[current_key];
      ELSE
        IF current_owner_kind = 'tenant' THEN new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant]; END IF;
        new_account_keys := new_account_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'credential' THEN
      current_owner_kind := TG_ARGV[1];
      IF current_owner_kind = 'tenant' THEN
        current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_credential := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
        current_key := 'saas-authz:tenant-provider-credential:' ||
          encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_credential, 'UTF8'), 'hex');
      ELSIF current_owner_kind = 'platform' THEN
        current_credential := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
        current_key := 'saas-authz:platform-provider-credential:' ||
          encode(convert_to(current_credential, 'UTF8'), 'hex');
      ELSE
        RAISE EXCEPTION 'Migration 050 writer fence has an invalid credential owner kind';
      END IF;
      IF current_is_old THEN
        IF current_owner_kind = 'tenant' THEN
          old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
          old_account_keys := old_account_keys || ARRAY[
            'saas-authz:tenant-provider-account:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
        ELSE
          old_account_keys := old_account_keys || ARRAY[
            'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
        END IF;
        old_credential_keys := old_credential_keys || ARRAY[current_key];
      ELSE
        IF current_owner_kind = 'tenant' THEN
          new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
          new_account_keys := new_account_keys || ARRAY[
            'saas-authz:tenant-provider-account:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
        ELSE
          new_account_keys := new_account_keys || ARRAY[
            'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
        END IF;
        new_credential_keys := new_credential_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'credential_version' THEN
      current_owner_kind := TG_ARGV[1];
      IF current_owner_kind = 'tenant' THEN
        current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_credential := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
        current_version := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[5]);
        current_owner_id := current_tenant;
      ELSIF current_owner_kind = 'platform' THEN
        current_credential := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
        current_version := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
        current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
        current_owner_id := 'platform';
      ELSE
        RAISE EXCEPTION 'Migration 050 writer fence has an invalid credential-version owner kind';
      END IF;
      current_key := 'saas-authz:credential-version:' || current_owner_kind || ':' ||
        encode(convert_to(current_owner_id, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_credential, 'UTF8'), 'hex') || ':' || current_version;
      IF current_owner_kind = 'tenant' THEN
        IF current_is_old THEN
          old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
          old_account_keys := old_account_keys || ARRAY[
            'saas-authz:tenant-provider-account:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
          old_credential_keys := old_credential_keys || ARRAY[
            'saas-authz:tenant-provider-credential:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_credential, 'UTF8'), 'hex')
          ];
          old_version_keys := old_version_keys || ARRAY[current_key];
        ELSE
          new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
          new_account_keys := new_account_keys || ARRAY[
            'saas-authz:tenant-provider-account:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
          new_credential_keys := new_credential_keys || ARRAY[
            'saas-authz:tenant-provider-credential:' ||
            encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
            encode(convert_to(current_credential, 'UTF8'), 'hex')
          ];
          new_version_keys := new_version_keys || ARRAY[current_key];
        END IF;
      ELSE
        IF current_is_old THEN
          old_account_keys := old_account_keys || ARRAY[
            'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
          old_credential_keys := old_credential_keys || ARRAY[
            'saas-authz:platform-provider-credential:' || encode(convert_to(current_credential, 'UTF8'), 'hex')
          ];
          old_version_keys := old_version_keys || ARRAY[current_key];
        ELSE
          new_account_keys := new_account_keys || ARRAY[
            'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
          ];
          new_credential_keys := new_credential_keys || ARRAY[
            'saas-authz:platform-provider-credential:' || encode(convert_to(current_credential, 'UTF8'), 'hex')
          ];
          new_version_keys := new_version_keys || ARRAY[current_key];
        END IF;
      END IF;

    ELSIF scope = 'mapping' THEN
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_profile := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_key := 'saas-authz:supply-profile-account:' ||
        encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_profile, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_account, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_profile_keys := old_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
        old_account_keys := old_account_keys || ARRAY[
          'saas-authz:tenant-provider-account:' ||
          encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_account, 'UTF8'), 'hex')
        ];
        old_mapping_keys := old_mapping_keys || ARRAY[current_key];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_profile_keys := new_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
        new_account_keys := new_account_keys || ARRAY[
          'saas-authz:tenant-provider-account:' ||
          encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_account, 'UTF8'), 'hex')
        ];
        new_mapping_keys := new_mapping_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'member' THEN
      current_pool := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_account := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_provider := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_product := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[4]);
      current_key := 'saas-authz:member:' ||
        encode(convert_to(current_pool, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_account, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_provider, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_product, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_pool_keys := old_pool_keys || ARRAY[
          'saas_platform_pool:' || encode(convert_to(current_pool, 'UTF8'), 'hex')
        ];
        old_account_keys := old_account_keys || ARRAY[
          'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
        ];
        old_member_keys := old_member_keys || ARRAY[current_key];
      ELSE
        new_pool_keys := new_pool_keys || ARRAY[
          'saas_platform_pool:' || encode(convert_to(current_pool, 'UTF8'), 'hex')
        ];
        new_account_keys := new_account_keys || ARRAY[
          'saas-authz:platform-provider-account:' || encode(convert_to(current_account, 'UTF8'), 'hex')
        ];
        new_member_keys := new_member_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'grant' THEN
      current_pool := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_tenant := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[2]);
      current_profile := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[3]);
      current_key := 'saas-authz:grant:' ||
        encode(convert_to(current_pool, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(current_profile, 'UTF8'), 'hex');
      IF current_is_old THEN
        old_tenant_keys := old_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        old_pool_keys := old_pool_keys || ARRAY[
          'saas_platform_pool:' || encode(convert_to(current_pool, 'UTF8'), 'hex')
        ];
        old_profile_keys := old_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
        old_grant_keys := old_grant_keys || ARRAY[current_key];
      ELSE
        new_tenant_keys := new_tenant_keys || ARRAY['saas-authz:tenant:' || current_tenant];
        new_pool_keys := new_pool_keys || ARRAY[
          'saas_platform_pool:' || encode(convert_to(current_pool, 'UTF8'), 'hex')
        ];
        new_profile_keys := new_profile_keys || ARRAY[
          'saas_supply_profile:' || encode(convert_to(current_tenant, 'UTF8'), 'hex') || ':' ||
          encode(convert_to(current_profile, 'UTF8'), 'hex')
        ];
        new_grant_keys := new_grant_keys || ARRAY[current_key];
      END IF;

    ELSIF scope = 'public_model' THEN
      current_public_model := saas_prepared_evidence_writer_require_value(current_row, TG_ARGV[1]);
      current_key := 'saas_public_model:' || encode(convert_to(current_public_model, 'UTF8'), 'hex');
      IF current_is_old THEN old_catalog_keys := old_catalog_keys || ARRAY[current_key];
      ELSE new_catalog_keys := new_catalog_keys || ARRAY[current_key]; END IF;

    ELSE
      RAISE EXCEPTION 'Migration 050 writer fence has an unsupported scope: %', scope;
    END IF;
  END LOOP;

  old_all_keys := old_tenant_keys || old_project_keys || old_user_keys || old_business_keys || old_catalog_keys ||
    old_pool_keys || old_profile_keys || old_account_keys || old_credential_keys ||
    old_version_keys || old_mapping_keys || old_member_keys || old_grant_keys;
  new_all_keys := new_tenant_keys || new_project_keys || new_user_keys || new_business_keys || new_catalog_keys ||
    new_pool_keys || new_profile_keys || new_account_keys || new_credential_keys ||
    new_version_keys || new_mapping_keys || new_member_keys || new_grant_keys;

  IF TG_OP <> 'INSERT' AND cardinality(old_all_keys) = 0 THEN
    RAISE EXCEPTION 'Migration 050 writer fence could not obtain old identity context';
  END IF;
  IF TG_OP <> 'DELETE' AND cardinality(new_all_keys) = 0 THEN
    RAISE EXCEPTION 'Migration 050 writer fence could not obtain new identity context';
  END IF;

  PERFORM saas_prepared_evidence_writer_lock_layer(old_tenant_keys || new_tenant_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_project_keys || new_project_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_user_keys || new_user_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_business_keys || new_business_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_catalog_keys || new_catalog_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_pool_keys || new_pool_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_profile_keys || new_profile_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_account_keys || new_account_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_credential_keys || new_credential_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_version_keys || new_version_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_mapping_keys || new_mapping_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_member_keys || new_member_keys);
  PERFORM saas_prepared_evidence_writer_lock_layer(old_grant_keys || new_grant_keys);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_prepared_evidence_writer_composite_key(row_value jsonb, prefix text, columns text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  column_name text;
  raw_value text;
  result text := prefix;
BEGIN
  IF row_value IS NULL OR prefix IS NULL OR prefix = '' OR columns IS NULL OR cardinality(columns) = 0 THEN
    RAISE EXCEPTION 'Migration 050 writer fence composite key context is incomplete';
  END IF;
  FOREACH column_name IN ARRAY columns LOOP
    raw_value := row_value ->> column_name;
    IF raw_value IS NULL OR raw_value = '' THEN
      RAISE EXCEPTION 'Migration 050 writer fence composite key column is missing: %', column_name;
    END IF;
    result := result || ':' || encode(convert_to(raw_value, 'UTF8'), 'hex');
  END LOOP;
  RETURN result;
END;
$$;

/* Identity and project writers.  047 already owns some matching fences; the
 * row-scoped triggers here also cover INSERT/DELETE and identity replacement.
 */
CREATE TRIGGER saas_tenants_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenants
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('tenant', 'id');
CREATE TRIGGER saas_projects_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_projects
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project', 'tenant_id', 'id');
CREATE TRIGGER saas_users_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_users
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('user', 'id');
CREATE TRIGGER saas_memberships_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('tenant_user', 'tenant_id', 'user_id');
CREATE TRIGGER saas_project_memberships_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_project_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project_user', 'tenant_id', 'project_id', 'user_id');
CREATE TRIGGER saas_api_keys_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_api_keys
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('api_key', 'tenant_id', 'project_id', 'id', 'principal_user_id');
CREATE TRIGGER saas_project_entitlements_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_project_entitlements
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('entitlement', 'tenant_id', 'project_id', 'supply_profile_id');

/* Commercial and route/provider authority writers. */
CREATE TRIGGER saas_customer_metering_policy_heads_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_customer_metering_policy_heads
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('commercial', 'customer', 'tenant_id', 'project_id', 'policy_id');
CREATE TRIGGER saas_provider_metering_policy_heads_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_provider_metering_policy_heads
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('commercial', 'provider', 'tenant_id', 'project_id', 'policy_id');
CREATE TRIGGER saas_customer_metering_policy_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_customer_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project_catalog', 'tenant_id', 'project_id', 'public_model_id');
CREATE TRIGGER saas_provider_metering_policy_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_provider_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project_catalog', 'tenant_id', 'project_id', 'public_model_id');
CREATE TRIGGER saas_route_config_commercial_authorities_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_route_config_commercial_authorities
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project', 'tenant_id', 'project_id');
CREATE TRIGGER saas_route_config_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_route_config_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project_catalog', 'tenant_id', 'project_id', 'public_model_id');
CREATE TRIGGER saas_route_config_heads_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_route_config_heads
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project', 'tenant_id', 'project_id');
CREATE TRIGGER saas_contract_test_attestations_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_contract_test_attestations
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project_catalog', 'tenant_id', 'project_id', 'public_model_id');
CREATE TRIGGER saas_project_inference_policy_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_project_inference_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('project', 'tenant_id', 'project_id');

/* Supply profile, platform pool, relationship and provider credential tiers. */
CREATE TRIGGER saas_supply_profiles_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_supply_profiles
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('profile', 'tenant_id', 'id');
CREATE TRIGGER saas_platform_provider_pools_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('pool', 'id');
CREATE TRIGGER saas_tenant_provider_accounts_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('provider_account', 'tenant', 'tenant_id', 'id');
CREATE TRIGGER saas_platform_provider_accounts_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('provider_account', 'platform', 'id');
CREATE TRIGGER saas_tenant_provider_credentials_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('credential', 'tenant', 'tenant_id', 'id', 'account_id');
CREATE TRIGGER saas_platform_provider_credentials_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('credential', 'platform', 'id', 'account_id');
CREATE TRIGGER saas_tenant_provider_credential_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_provider_credential_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('credential_version', 'tenant', 'tenant_id', 'credential_id', 'version', 'account_id');
CREATE TRIGGER saas_platform_provider_credential_versions_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_credential_versions
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('credential_version', 'platform', 'credential_id', 'version', 'account_id');
CREATE TRIGGER saas_tenant_provider_supply_profile_accounts_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_provider_supply_profile_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('mapping', 'tenant_id', 'supply_profile_id', 'account_id');
CREATE TRIGGER saas_platform_provider_pool_members_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_pool_members
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('member', 'pool_id', 'account_id', 'provider_id', 'product_id');
CREATE TRIGGER saas_platform_provider_pool_grants_pe_authz_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_provider_pool_grants
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('grant', 'pool_id', 'tenant_id', 'supply_profile_id');
CREATE TRIGGER saas_public_models_prepared_evidence_authorization_fence
  BEFORE INSERT OR UPDATE OR DELETE ON saas_public_models
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence('public_model', 'id');

/* Contract checks run after DDL and fail closed if any trigger drifted. */
DO $saas_prepared_evidence_writer_contract$
DECLARE
  trigger_spec text;
  trigger_name text;
  relation_name text;
  expected_trigger constant text[] := ARRAY[
    'saas_tenants:saas_tenants_prepared_evidence_authorization_fence',
    'saas_projects:saas_projects_prepared_evidence_authorization_fence',
    'saas_users:saas_users_prepared_evidence_authorization_fence',
    'saas_memberships:saas_memberships_prepared_evidence_authorization_fence',
    'saas_project_memberships:saas_project_memberships_prepared_evidence_authorization_fence',
    'saas_api_keys:saas_api_keys_prepared_evidence_authorization_fence',
    'saas_project_entitlements:saas_project_entitlements_prepared_evidence_authorization_fence',
    'saas_customer_metering_policy_heads:saas_customer_metering_policy_heads_pe_authz_fence',
    'saas_provider_metering_policy_heads:saas_provider_metering_policy_heads_pe_authz_fence',
    'saas_customer_metering_policy_versions:saas_customer_metering_policy_versions_pe_authz_fence',
    'saas_provider_metering_policy_versions:saas_provider_metering_policy_versions_pe_authz_fence',
    'saas_route_config_commercial_authorities:saas_route_config_commercial_authorities_pe_authz_fence',
    'saas_route_config_versions:saas_route_config_versions_pe_authz_fence',
    'saas_route_config_heads:saas_route_config_heads_prepared_evidence_authorization_fence',
    'saas_contract_test_attestations:saas_contract_test_attestations_pe_authz_fence',
    'saas_project_inference_policy_versions:saas_project_inference_policy_versions_pe_authz_fence',
    'saas_platform_provider_pools:saas_platform_provider_pools_pe_authz_fence',
    'saas_supply_profiles:saas_supply_profiles_prepared_evidence_authorization_fence',
    'saas_tenant_provider_accounts:saas_tenant_provider_accounts_pe_authz_fence',
    'saas_platform_provider_accounts:saas_platform_provider_accounts_pe_authz_fence',
    'saas_tenant_provider_credentials:saas_tenant_provider_credentials_pe_authz_fence',
    'saas_platform_provider_credentials:saas_platform_provider_credentials_pe_authz_fence',
    'saas_tenant_provider_credential_versions:saas_tenant_provider_credential_versions_pe_authz_fence',
    'saas_platform_provider_credential_versions:saas_platform_provider_credential_versions_pe_authz_fence',
    'saas_tenant_provider_supply_profile_accounts:saas_tenant_provider_supply_profile_accounts_pe_authz_fence',
    'saas_platform_provider_pool_members:saas_platform_provider_pool_members_pe_authz_fence',
    'saas_platform_provider_pool_grants:saas_platform_provider_pool_grants_pe_authz_fence',
    'saas_public_models:saas_public_models_prepared_evidence_authorization_fence'
  ];
  trigger_definition text;
BEGIN
  FOREACH trigger_spec IN ARRAY expected_trigger LOOP
    relation_name := split_part(trigger_spec, ':', 1);
    trigger_name := split_part(trigger_spec, ':', 2);
    SELECT pg_get_triggerdef(trigger_record.oid)
      INTO trigger_definition
      FROM pg_trigger trigger_record
     WHERE trigger_record.tgrelid = to_regclass('model_router_saas.' || relation_name)
       AND trigger_record.tgname = trigger_name
       AND NOT trigger_record.tgisinternal
       AND trigger_record.tgenabled <> 'D';
    IF trigger_definition IS NULL
       OR trigger_definition NOT LIKE '%BEFORE%'
       OR trigger_definition NOT LIKE '%saas_prepared_evidence_authorization_writer_fence%'
    THEN
      RAISE EXCEPTION 'Migration 050 writer trigger contract is missing or drifted: %', trigger_spec
        USING DETAIL = format(
          'relation=%s trigger=%s definition=%s installed-triggers=%s',
          to_regclass('model_router_saas.' || relation_name),
          trigger_name,
          coalesce(trigger_definition, '<missing>'),
          coalesce(
            (
              SELECT string_agg(installed_trigger.tgname, ', ' ORDER BY installed_trigger.tgname)
                FROM pg_trigger installed_trigger
               WHERE installed_trigger.tgrelid = to_regclass('model_router_saas.' || relation_name)
                 AND NOT installed_trigger.tgisinternal
            ),
            '<none>'
          )
        );
    END IF;
  END LOOP;

  IF to_regprocedure('model_router_saas.saas_prepared_evidence_authorization_writer_fence()') IS NULL
     OR to_regprocedure('model_router_saas.saas_prepared_evidence_writer_require_value(jsonb,text)') IS NULL
     OR to_regprocedure('model_router_saas.saas_prepared_evidence_writer_lock_layer(text[])') IS NULL
     OR to_regprocedure('model_router_saas.saas_prepared_evidence_writer_composite_key(jsonb,text,text[])') IS NULL
  THEN
    RAISE EXCEPTION 'Migration 050 writer fence helper installation failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger trigger_record
     WHERE trigger_record.tgrelid = to_regclass('model_router_saas.saas_api_keys')
       AND trigger_record.tgname = 'saas_api_keys_prepared_evidence_authorization_fence'
       AND trigger_record.tgenabled <> 'D'
       AND pg_get_triggerdef(trigger_record.oid) LIKE '%BEFORE%'
       AND pg_get_triggerdef(trigger_record.oid) LIKE '%saas_prepared_evidence_authorization_writer_fence(''api_key'', ''tenant_id'', ''project_id'', ''id'', ''principal_user_id'')%'
  ) THEN
    RAISE EXCEPTION 'Migration 050 API-key writer fence contract is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger trigger_record
     WHERE trigger_record.tgrelid = to_regclass('model_router_saas.saas_platform_provider_pool_grants')
       AND trigger_record.tgname = 'saas_platform_provider_pool_grants_pe_authz_fence'
       AND trigger_record.tgenabled <> 'D'
       AND pg_get_triggerdef(trigger_record.oid) LIKE '%BEFORE%'
       AND pg_get_triggerdef(trigger_record.oid) LIKE '%saas_prepared_evidence_authorization_writer_fence(''grant'', ''pool_id'', ''tenant_id'', ''supply_profile_id'')%'
  ) THEN
    RAISE EXCEPTION 'Migration 050 pool-grant writer fence contract is missing';
  END IF;
END;
$saas_prepared_evidence_writer_contract$;
`;

export const PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION: SaasMigration = {
  version: 50,
  name: 'prepared_evidence_authorization_advisory_fences',
  sql: preparedEvidenceAuthorizationAdvisoryFencesSql,
};
