import type { SaasMigration } from './001_initial_schema.js';

export const PLATFORM_VALIDATION_REQUEUE_TABLE = 'saas_platform_credential_validation_requeue_requests';
export const PLATFORM_VALIDATION_REQUEUE_WRITER = 'saas_platform_credential_validation_requeue_insert()';

/** Trigger-only repair for the observed Kimi Code onboarding size rejection. */
export const PLATFORM_VALIDATION_REQUEUE_WRITER_SOURCE = `
DECLARE
  job_row model_router_saas.saas_platform_provider_credential_validation_jobs%ROWTYPE;
  account_row model_router_saas.saas_platform_provider_accounts%ROWTYPE;
  credential_row model_router_saas.saas_platform_provider_credentials%ROWTYPE;
  version_row record;
  evidence text;
  checked_time timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 0
    OR TG_RELID <> 'model_router_saas.saas_platform_credential_validation_requeue_requests'::regclass
    OR session_user <> 'model_router_saas_control_plane' OR current_user <> 'model_router_saas_migrator'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed'
  THEN RAISE EXCEPTION 'Platform validation retry context is invalid' USING ERRCODE='42501'; END IF;
  IF NEW.audit_event_id IS NOT NULL OR NEW.request_digest IS NOT NULL OR NEW.prior_snapshot IS NOT NULL
    OR NEW.target_evidence_sha256 IS NOT NULL OR NEW.result_lease_generation IS NOT NULL OR NEW.recorded_at IS NOT NULL
  THEN RAISE EXCEPTION 'Platform validation retry receipt is server owned' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_input'; END IF;
  PERFORM pg_catalog.set_config('lock_timeout','2s',TRUE);
  PERFORM pg_catalog.set_config('statement_timeout','10s',TRUE);
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1396788563,46);
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(NEW.actor_user_id::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:platform-provider-account:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.account_id,'UTF8'),'hex'),0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:platform-provider-credential:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.credential_id,'UTF8'),'hex'),0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:credential-version:platform:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.account_id,'UTF8'),'hex') || ':' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.credential_id,'UTF8'),'hex') || ':' || NEW.expected_credential_version::text,0));

  checked_time := pg_catalog.clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_platform_sessions s
    JOIN model_router_saas.saas_users u ON u.id=s.user_id
    JOIN model_router_saas.saas_mfa_credentials m ON m.id=s.credential_id AND m.user_id=s.user_id
    WHERE s.id=NEW.actor_session_id AND s.user_id=NEW.actor_user_id
      AND s.revoked_at IS NULL AND s.expires_at>checked_time
      AND u.disabled_at IS NULL AND u.anonymized_at IS NULL AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments r
        WHERE r.user_id=u.id AND r.role IN('superadmin','operations')))
  THEN RAISE EXCEPTION 'Platform validation retry actor is not current' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_actor'; END IF;
  IF EXISTS(SELECT 1 FROM model_router_saas.saas_platform_credential_validation_requeue_requests
    WHERE actor_user_id=NEW.actor_user_id AND idempotency_key=NEW.idempotency_key)
  THEN RAISE EXCEPTION 'Platform validation retry identity exists' USING ERRCODE='23505', CONSTRAINT='saas_platform_requeue_identity'; END IF;

  SELECT * INTO account_row FROM model_router_saas.saas_platform_provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR account_row.status<>'pending' OR account_row.validation_state<>'failed'
    OR account_row.supply_mode<>'platform' OR account_row.provider_id<>'kimi'
    OR account_row.product_id NOT IN('kimi-code','kimi-code-global') OR account_row.credential_type<>'api-key'
  THEN RAISE EXCEPTION 'Platform validation retry account changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_state'; END IF;
  SELECT * INTO credential_row FROM model_router_saas.saas_platform_provider_credentials WHERE id=NEW.credential_id FOR UPDATE;
  IF NOT FOUND OR credential_row.account_id IS DISTINCT FROM account_row.id
    OR credential_row.provider_id IS DISTINCT FROM account_row.provider_id OR credential_row.product_id IS DISTINCT FROM account_row.product_id
    OR credential_row.credential_type<>'api-key' OR credential_row.status<>'pending' OR credential_row.validation_state<>'failed'
    OR credential_row.current_version IS DISTINCT FROM NEW.expected_credential_version
    OR credential_row.authz_version IS DISTINCT FROM NEW.expected_credential_authz_version
  THEN RAISE EXCEPTION 'Platform validation retry credential changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_state'; END IF;
  SELECT account_id,status,expires_at INTO version_row FROM model_router_saas.saas_platform_provider_credential_versions
    WHERE credential_id=NEW.credential_id AND version=NEW.expected_credential_version FOR SHARE;
  IF NOT FOUND OR version_row.account_id IS DISTINCT FROM NEW.account_id OR version_row.status<>'active'
  THEN RAISE EXCEPTION 'Platform validation retry version changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_authority'; END IF;
  PERFORM 1 FROM model_router_saas.saas_provider_products
    WHERE provider_id=account_row.provider_id AND product_id=account_row.product_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Platform validation retry product changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_authority'; END IF;
  SELECT * INTO job_row FROM model_router_saas.saas_platform_provider_credential_validation_jobs WHERE id=NEW.job_id FOR UPDATE;
  IF NOT FOUND OR job_row.account_id IS DISTINCT FROM NEW.account_id OR job_row.credential_id IS DISTINCT FROM NEW.credential_id
    OR job_row.credential_version IS DISTINCT FROM NEW.expected_credential_version
    OR job_row.provider_id IS DISTINCT FROM account_row.provider_id OR job_row.product_id IS DISTINCT FROM account_row.product_id
    OR job_row.credential_type<>'api-key' OR job_row.target_endpoint<>'messages'
    OR job_row.status<>'failed' OR job_row.last_error_code IS DISTINCT FROM 'provider_response_too_large'
    OR job_row.completed_at IS NULL OR job_row.lease_until IS NOT NULL
    OR job_row.lease_generation IS DISTINCT FROM NEW.expected_lease_generation
  THEN RAISE EXCEPTION 'Platform validation retry terminal generation changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_state'; END IF;
  SELECT c.evidence_sha256 INTO evidence FROM model_router_saas.saas_platform_provider_account_capabilities b
    JOIN model_router_saas.saas_provider_capabilities c ON c.provider_id=b.provider_id AND c.product_id=b.product_id
      AND c.model=b.model AND c.endpoint=b.endpoint AND c.version=b.capability_version
    WHERE b.account_id=NEW.account_id AND b.provider_id=job_row.provider_id AND b.product_id=job_row.product_id
      AND b.model=job_row.target_model AND b.endpoint=job_row.target_endpoint AND b.capability_version=job_row.capability_version
      AND c.protocol='anthropic-compatible' AND c.support_level='supported' AND c.validation_state='verified'
      AND NOT EXISTS(SELECT 1 FROM model_router_saas.saas_provider_capabilities newer WHERE newer.provider_id=c.provider_id
        AND newer.product_id=c.product_id AND newer.model=c.model AND newer.endpoint=c.endpoint AND newer.version>c.version)
    FOR SHARE OF b;
  checked_time := pg_catalog.clock_timestamp();
  IF NOT FOUND OR evidence IS NULL OR evidence !~ '^[0-9a-f]{64}$'
    OR (credential_row.expires_at IS NOT NULL AND credential_row.expires_at<=checked_time)
    OR (version_row.expires_at IS NOT NULL AND version_row.expires_at<=checked_time)
    OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_provider_rights r
      WHERE r.rights_id=account_row.rights_id AND r.version=account_row.rights_version
        AND r.provider_id=job_row.provider_id AND r.product_id=job_row.product_id AND r.credential_type='api-key'
        AND r.supply_mode='platform' AND r.region=account_row.region AND r.purpose=account_row.purpose AND r.status='active'
        AND r.effective_at<=checked_time AND (r.expires_at IS NULL OR r.expires_at>checked_time)
        AND r.model_scope @> ARRAY[job_row.target_model]::text[] AND r.endpoint_scope @> ARRAY[job_row.target_endpoint]::text[]
        AND NOT EXISTS(SELECT 1 FROM model_router_saas.saas_provider_rights newer WHERE newer.rights_id=r.rights_id AND newer.version>r.version))
    OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_platform_sessions s WHERE s.id=NEW.actor_session_id
      AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL AND s.expires_at>checked_time)
  THEN RAISE EXCEPTION 'Platform validation retry authority expired' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_authority'; END IF;

  NEW.audit_event_id := pg_catalog.gen_random_uuid();
  NEW.prior_snapshot := pg_catalog.to_jsonb(job_row);
  NEW.target_evidence_sha256 := evidence;
  NEW.result_lease_generation := job_row.lease_generation+1;
  NEW.recorded_at := checked_time;
  NEW.request_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    'platform-credential-validation-requeue-v1',NEW.actor_user_id,NEW.account_id,NEW.credential_id,NEW.job_id,
    NEW.expected_credential_version,NEW.expected_credential_authz_version,NEW.expected_lease_generation,
    NEW.idempotency_key,NEW.reason)::text,'UTF8')),'hex');
  INSERT INTO model_router_saas.saas_audit_events
    (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
    VALUES(NEW.audit_event_id,NULL,NEW.actor_user_id,'provider-credential.validation-requeued','credential-validation-job',
      NEW.job_id::text,checked_time,'platform-credential-validation-requeue',NEW.request_id);
  /* Preserve the prior per-cycle attempt count in immutable history. This
   * mirrors the existing platform D3 sweep's fresh, bounded attempt budget. */
  UPDATE model_router_saas.saas_platform_provider_credential_validation_jobs
    SET status='queued',attempt_count=0,available_at=checked_time,lease_until=NULL,
      lease_generation=NEW.result_lease_generation,last_error_code=NULL,completed_at=NULL,updated_at=checked_time
    WHERE id=NEW.job_id AND lease_generation=NEW.expected_lease_generation AND status='failed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Platform validation retry generation changed' USING ERRCODE='23514', CONSTRAINT='saas_platform_requeue_state'; END IF;
  RETURN NEW;
END;
`;

export const PLATFORM_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION: SaasMigration = {
  version: 137,
  name: 'platform_credential_validation_requeue',
  sql: `
CREATE TABLE saas_platform_credential_validation_requeue_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  actor_session_id uuid NOT NULL REFERENCES saas_platform_sessions(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES saas_platform_provider_accounts(id) ON DELETE RESTRICT,
  credential_id text NOT NULL REFERENCES saas_platform_provider_credentials(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES saas_platform_provider_credential_validation_jobs(id) ON DELETE RESTRICT,
  expected_credential_version integer NOT NULL CHECK(expected_credential_version>=1),
  expected_credential_authz_version bigint NOT NULL CHECK(expected_credential_authz_version BETWEEN 1 AND 9007199254740991),
  expected_lease_generation bigint NOT NULL CHECK(expected_lease_generation BETWEEN 0 AND 9007199254740990),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_id text NOT NULL CHECK(request_id ~ '^[!-~]{1,128}$'),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 512 AND reason=btrim(reason) AND reason !~ '[[:cntrl:]]'),
  reason_code text NOT NULL DEFAULT 'retry_provider_validation' CHECK(reason_code='retry_provider_validation'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES saas_audit_events(id) ON DELETE RESTRICT,
  prior_snapshot jsonb NOT NULL CHECK(jsonb_typeof(prior_snapshot)='object'),
  target_evidence_sha256 text NOT NULL CHECK(target_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  result_lease_generation bigint NOT NULL CHECK(result_lease_generation=expected_lease_generation+1),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT saas_platform_requeue_identity UNIQUE(actor_user_id,idempotency_key)
);
CREATE FUNCTION saas_platform_credential_validation_requeue_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, model_router_saas, pg_temp
AS $platform_requeue$${PLATFORM_VALIDATION_REQUEUE_WRITER_SOURCE}$platform_requeue$;
REVOKE ALL ON FUNCTION saas_platform_credential_validation_requeue_insert() FROM PUBLIC;
CREATE TRIGGER saas_platform_validation_requeue_insert BEFORE INSERT
  ON saas_platform_credential_validation_requeue_requests
  FOR EACH ROW EXECUTE FUNCTION saas_platform_credential_validation_requeue_insert();
CREATE TRIGGER saas_platform_validation_requeue_immutable BEFORE UPDATE OR DELETE
  ON saas_platform_credential_validation_requeue_requests
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_platform_validation_requeue_no_truncate BEFORE TRUNCATE
  ON saas_platform_credential_validation_requeue_requests
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();
`,
};
