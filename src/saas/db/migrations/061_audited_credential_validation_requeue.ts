import { createHash } from 'node:crypto';
import type { SaasMigration } from './001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from './035_credential_validation_jobs.js';
import {
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS,
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
} from './058_credential_validation_invalidation_trigger_execution.js';
import { PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION } from './059_pre_dispatch_terminal_cancellation.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from './060_prepared_evidence_claim_generated_account.js';

// Isolated stage-1 candidate. Register/apply/reconcile ONLY at integration GO.
// No migration calls a public application routine or grants application rights.
export const REQUEUE_REQUEST_TABLE = 'saas_credential_validation_requeue_requests';
export const REQUEUE_CYCLE_TABLE = 'saas_credential_validation_cycles';
export const REQUEUE_JOB_TABLE = 'saas_tenant_provider_credential_validation_jobs';
export const REQUEUE_WRITER_SIGNATURE = 'saas_credential_validation_requeue_request_insert()';
export const REQUEUE_COUNTER_SIGNATURE = 'saas_credential_validation_job_cycle_guard()';
export const REQUEUE_CYCLE_COLUMNS = ['current_cycle_id', 'cycle_start_attempt_count', 'cycle_attempt_limit'] as const;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const checksum = (migration: SaasMigration) => createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
const originalFunctions = CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS.map(({ signature, source }, index) =>
  `(${quote(signature)}, $original_${index}$${source}$original_${index}$, ${index < 2})`).join(',\n    ');
const originalBindings = CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS.map(([table, name, signature, type, columns]) =>
  `(${quote(table)}, ${quote(name.slice(0, 63))}, ${quote(signature)}, ${type}, ARRAY[${columns.map(quote).join(',')}]::text[])`).join(',\n    ');
const immutableSource = `\nBEGIN\n  RAISE EXCEPTION 'SaaS records are immutable' USING ERRCODE = '55000';\nEND;\n`;
// Compose compact JSON from pg_catalog primitives, not jsonb::text (which adds
// whitespace). Its array order matches the EXISTING JS snapshot helper exactly.
const compactArray = (expressions: readonly string[]) =>
  `('[' || ${expressions.map((value) => `pg_catalog.to_json(${value})::text`).join(" || ',' || ")} || ']')`;
const snapshotJson = compactArray([
  "'model-router-credential-validation-job-v1'::text", 'job_row.id::text', 'job_row.tenant_id::text',
  'job_row.account_id', 'job_row.credential_id', 'job_row.credential_version', 'job_row.provider_id',
  'job_row.product_id', 'job_row.credential_type', 'job_row.allowed_models', 'job_row.target_model',
  'job_row.target_endpoint', 'job_row.capability_version', 'job_row.idempotency_key',
  `pg_catalog.to_char(job_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
]);
const requestJson = compactArray([
  "'model-router-credential-validation-requeue-v1'::text", 'NEW.tenant_id::text', 'NEW.actor_user_id::text',
  'NEW.job_id::text', 'NEW.expected_credential_authz_version', 'NEW.expected_lease_generation',
  'NEW.snapshot_sha256', 'NEW.idempotency_key', 'NEW.request_id', 'NEW.reason_code', 'NEW.reason',
  'capability_evidence_sha256',
]);

export const REQUEUE_WRITER_SOURCE = `
DECLARE
  job_ref record;
  job_row model_router_saas.saas_tenant_provider_credential_validation_jobs%ROWTYPE;
  account_row model_router_saas.saas_tenant_provider_accounts%ROWTYPE;
  credential_row model_router_saas.saas_tenant_provider_credentials%ROWTYPE;
  version_row model_router_saas.saas_tenant_provider_credential_versions%ROWTYPE;
  checked_time timestamptz;
  capability_evidence_sha256 text;
  expected_protocol text;
  snapshot_digest text;
  command_digest text;
  audit_id uuid;
  changed integer;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 0
    OR TG_RELID <> 'model_router_saas.saas_credential_validation_requeue_requests'::regclass
    OR session_user IS DISTINCT FROM 'model_router_saas_control_plane'
    OR current_user IS DISTINCT FROM 'model_router_saas_migrator'
    OR pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = 'model_router_saas.saas_credential_validation_requeue_request_insert()'::regprocedure
        AND p.proowner = 'model_router_saas_migrator'::regrole AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'])
  THEN RAISE EXCEPTION 'Requeue writer context is not trusted' USING ERRCODE = '42501'; END IF;
  IF NEW.id IS NULL OR NEW.tenant_id IS NULL OR NEW.actor_user_id IS NULL OR NEW.actor_session_id IS NULL
    OR NEW.job_id IS NULL OR NEW.request_digest IS NULL OR NEW.snapshot_sha256 IS NULL
    OR NEW.idempotency_key IS NULL OR NEW.request_id IS NULL OR NEW.reason_code IS NULL OR NEW.reason IS NULL
    OR NEW.expected_credential_authz_version IS NULL OR NEW.expected_lease_generation IS NULL
    OR NEW.expected_credential_authz_version NOT BETWEEN 1 AND 9007199254740991
    OR NEW.expected_lease_generation NOT BETWEEN 0 AND 9007199254740990
    OR NEW.request_digest !~ '^[0-9a-f]{64}$' OR NEW.snapshot_sha256 !~ '^[0-9a-f]{64}$'
    OR NEW.idempotency_key !~ '^[0-9a-f]{64}$' OR NEW.request_id !~ '^[!-~]{1,128}$'
    OR NEW.reason_code NOT IN ('target_approved', 'retry_provider_validation')
    OR NEW.reason !~ '^[ -~]{1,512}$' OR NEW.reason <> pg_catalog.btrim(NEW.reason)
    OR NEW.audit_event_id IS NOT NULL OR NEW.target_evidence_sha256 IS NOT NULL
    OR NEW.result_lease_generation IS NOT NULL OR NEW.cycle_start_attempt_count IS NOT NULL
    OR NEW.cycle_attempt_limit IS NOT NULL OR NEW.recorded_at IS NOT NULL
  THEN RAISE EXCEPTION 'Requeue command shape is invalid' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_input'; END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '2s', TRUE);
  PERFORM pg_catalog.set_config('statement_timeout', '10s', TRUE);
  /* User/member/tenant facts use matching 046/047 fences, never tuple locks.
   * Tenant is exclusive from the start (no lock upgrade). Customer sessions
   * are different from 046 platform_sessions: legacy logout directly UPDATEs
   * saas_sessions. Lock ONLY this customer session after the auth fences;
   * ordinary logout takes no advisory locks, audited session writers acquire
   * global-exclusive first, so neither creates a tuple/advisory inversion. */
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1396788563, 46);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:tenant:' || NEW.tenant_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(NEW.actor_user_id::text, 0));
  PERFORM 1 FROM model_router_saas.saas_sessions
    WHERE id=NEW.actor_session_id AND user_id=NEW.actor_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requeue customer session disappeared' USING ERRCODE='23514', CONSTRAINT='saas_requeue_actor'; END IF;
  checked_time := pg_catalog.clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM model_router_saas.saas_sessions s
      JOIN model_router_saas.saas_users u ON u.id = s.user_id
      JOIN model_router_saas.saas_memberships m ON m.user_id = u.id AND m.tenant_id = NEW.tenant_id
      JOIN model_router_saas.saas_tenants t ON t.id = m.tenant_id
      WHERE s.id = NEW.actor_session_id AND s.user_id = NEW.actor_user_id
        AND s.revoked_at IS NULL AND s.expires_at > checked_time
        AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
        AND t.status = 'active' AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  THEN RAISE EXCEPTION 'Requeue actor authority is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_actor'; END IF;
  IF EXISTS (SELECT 1 FROM model_router_saas.saas_credential_validation_requeue_requests r
    WHERE r.tenant_id = NEW.tenant_id AND (r.idempotency_key = NEW.idempotency_key OR r.request_id = NEW.request_id))
  THEN RAISE EXCEPTION 'Requeue identity already exists; use the read-only receipt' USING ERRCODE = '23505', CONSTRAINT = 'saas_requeue_identity'; END IF;

  /* Only an immutable reference is read before supply fences; never lock the
   * job first. Exact workerAuthorityLockLayers: tenant -> account -> credential
   * -> credential-version, all exclusive, with migration050 UTF8 hex/seed0. */
  SELECT tenant_id, account_id, credential_id, credential_version INTO job_ref
    FROM model_router_saas.saas_tenant_provider_credential_validation_jobs
    WHERE id = NEW.job_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requeue job is not in this tenant' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_state'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:tenant-provider-account:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':' ||
    pg_catalog.encode(pg_catalog.convert_to(job_ref.account_id, 'UTF8'), 'hex'), 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:tenant-provider-credential:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':' ||
    pg_catalog.encode(pg_catalog.convert_to(job_ref.credential_id, 'UTF8'), 'hex'), 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('saas-authz:credential-version:tenant:' ||
    pg_catalog.encode(pg_catalog.convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':' ||
    pg_catalog.encode(pg_catalog.convert_to(job_ref.credential_id, 'UTF8'), 'hex') || ':' || job_ref.credential_version::text, 0));

  SELECT * INTO account_row FROM model_router_saas.saas_tenant_provider_accounts
    WHERE tenant_id = NEW.tenant_id AND id = job_ref.account_id FOR UPDATE;
  IF NOT FOUND OR account_row.status NOT IN ('pending', 'active') OR account_row.supply_mode <> 'byok'
  THEN RAISE EXCEPTION 'Requeue account is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_authority'; END IF;
  SELECT * INTO credential_row FROM model_router_saas.saas_tenant_provider_credentials
    WHERE tenant_id = NEW.tenant_id AND id = job_ref.credential_id FOR UPDATE;
  IF NOT FOUND OR credential_row.account_id IS DISTINCT FROM account_row.id
    OR credential_row.provider_id IS DISTINCT FROM account_row.provider_id OR credential_row.product_id IS DISTINCT FROM account_row.product_id
    OR credential_row.credential_type IS DISTINCT FROM account_row.credential_type
    OR credential_row.status NOT IN ('pending', 'active') OR credential_row.current_version IS DISTINCT FROM job_ref.credential_version
    OR credential_row.authz_version IS DISTINCT FROM NEW.expected_credential_authz_version
  THEN RAISE EXCEPTION 'Requeue credential is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_authority'; END IF;
  /* Do not read ciphertext into history/audit. Row lock preserves version
   * expiry/status while validation uses only its non-secret metadata. */
  SELECT tenant_id, account_id, credential_id, version, status, expires_at
    INTO version_row.tenant_id, version_row.account_id, version_row.credential_id,
      version_row.version, version_row.status, version_row.expires_at
    FROM model_router_saas.saas_tenant_provider_credential_versions
    WHERE tenant_id = NEW.tenant_id AND credential_id = job_ref.credential_id AND version = job_ref.credential_version FOR SHARE;
  IF NOT FOUND OR version_row.account_id IS DISTINCT FROM account_row.id OR version_row.status <> 'active'
  THEN RAISE EXCEPTION 'Requeue version is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_authority'; END IF;

  /* 034 catalog appenders lock the product FOR UPDATE before inserting a
   * version. Owner-held SHARE prevents a moving latest capability/rights head.
   * No SELECT-only application acquires a catalog row lock or gains UPDATE. */
  PERFORM 1 FROM model_router_saas.saas_provider_products
    WHERE provider_id = account_row.provider_id AND product_id = account_row.product_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Requeue product is not active' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_target'; END IF;
  /* All account/credential/version locks precede the job lock/CAS, as in
   * completion; claim uses the same exclusive authority fences first. */
  SELECT * INTO job_row FROM model_router_saas.saas_tenant_provider_credential_validation_jobs
    WHERE id = NEW.job_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR job_row.account_id IS DISTINCT FROM account_row.id OR job_row.credential_id IS DISTINCT FROM credential_row.id
    OR job_row.credential_version IS DISTINCT FROM job_ref.credential_version OR job_row.provider_id IS DISTINCT FROM account_row.provider_id
    OR job_row.product_id IS DISTINCT FROM account_row.product_id OR job_row.credential_type IS DISTINCT FROM account_row.credential_type
    OR job_row.status NOT IN ('failed', 'cancelled') OR job_row.lease_until IS NOT NULL OR job_row.completed_at IS NULL
    OR job_row.lease_generation IS DISTINCT FROM NEW.expected_lease_generation OR job_row.attempt_count > 2147483642
    OR pg_catalog.array_ndims(job_row.allowed_models) <> 1 OR job_row.credential_type <> 'api-key'
    OR (job_row.provider_id='custom' AND (job_row.target_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' OR position('://' in job_row.target_model)>0))
    OR (job_row.provider_id<>'custom' AND job_row.target_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
    OR EXTRACT(YEAR FROM job_row.created_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
  THEN RAISE EXCEPTION 'Requeue terminal generation is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_state'; END IF;
  expected_protocol := CASE
    WHEN job_row.provider_id = 'custom' AND job_row.product_id = 'custom-openai' AND job_row.target_endpoint = 'chat-completions' THEN 'openai-compatible'
    WHEN job_row.provider_id = 'custom' AND job_row.product_id = 'custom-anthropic' AND job_row.target_endpoint = 'messages' THEN 'anthropic-compatible'
    WHEN job_row.provider_id = 'kimi' AND job_row.product_id IN ('kimi-platform','kimi-platform-global') AND job_row.target_endpoint = 'chat-completions' THEN 'openai-compatible'
    WHEN job_row.provider_id = 'deepseek' AND job_row.product_id = 'deepseek-chat' AND job_row.target_endpoint = 'chat-completions' THEN 'openai-compatible'
    WHEN job_row.provider_id = 'kimi' AND job_row.product_id IN ('kimi-code','kimi-code-global') AND job_row.target_endpoint = 'messages' THEN 'anthropic-compatible'
    WHEN job_row.provider_id = 'deepseek' AND job_row.product_id = 'deepseek-anthropic' AND job_row.target_endpoint = 'messages' THEN 'anthropic-compatible'
    ELSE NULL END;
  SELECT c.evidence_sha256 INTO capability_evidence_sha256
    FROM model_router_saas.saas_tenant_provider_account_capabilities b
    JOIN model_router_saas.saas_provider_capabilities c
      ON c.provider_id = b.provider_id AND c.product_id = b.product_id AND c.model = b.model
      AND c.endpoint = b.endpoint AND c.version = b.capability_version
    WHERE b.tenant_id = NEW.tenant_id AND b.account_id = job_row.account_id
      AND b.provider_id = job_row.provider_id AND b.product_id = job_row.product_id
      AND b.model = job_row.target_model AND b.endpoint = job_row.target_endpoint AND b.capability_version = job_row.capability_version
      AND c.protocol = expected_protocol AND c.support_level = 'supported' AND c.validation_state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM model_router_saas.saas_provider_capabilities newer
        WHERE newer.provider_id = c.provider_id AND newer.product_id = c.product_id AND newer.model = c.model
          AND newer.endpoint = c.endpoint AND newer.version > c.version)
    FOR SHARE OF b;
  IF NOT FOUND OR capability_evidence_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'Requeue capability is not current' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_target'; END IF;
  checked_time := pg_catalog.clock_timestamp();
  IF (credential_row.expires_at IS NOT NULL AND credential_row.expires_at <= checked_time)
    OR (version_row.expires_at IS NOT NULL AND version_row.expires_at <= checked_time)
    OR NOT EXISTS (SELECT 1 FROM model_router_saas.saas_provider_rights r
      WHERE r.rights_id = account_row.rights_id AND r.version = account_row.rights_version
        AND r.provider_id = job_row.provider_id AND r.product_id = job_row.product_id
        AND r.credential_type = job_row.credential_type AND r.supply_mode = 'byok'
        AND r.region = account_row.region AND r.purpose = account_row.purpose AND r.status = 'active'
        AND r.effective_at <= checked_time AND (r.expires_at IS NULL OR r.expires_at > checked_time)
        AND r.model_scope @> ARRAY[job_row.target_model]::text[] AND r.endpoint_scope @> ARRAY[job_row.target_endpoint]::text[]
        AND NOT EXISTS (SELECT 1 FROM model_router_saas.saas_provider_rights newer WHERE newer.rights_id = r.rights_id AND newer.version > r.version))
    OR NOT EXISTS (SELECT 1 FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id = s.user_id
      JOIN model_router_saas.saas_memberships m ON m.user_id = u.id AND m.tenant_id = NEW.tenant_id
      JOIN model_router_saas.saas_tenants t ON t.id = m.tenant_id
      WHERE s.id = NEW.actor_session_id AND s.user_id = NEW.actor_user_id AND s.revoked_at IS NULL AND s.expires_at > checked_time
        AND u.disabled_at IS NULL AND u.anonymized_at IS NULL AND t.status = 'active' AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  THEN RAISE EXCEPTION 'Requeue locked authority expired' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_authority'; END IF;
  snapshot_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${snapshotJson}, 'UTF8')), 'hex');
  command_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${requestJson}, 'UTF8')), 'hex');
  IF snapshot_digest IS DISTINCT FROM NEW.snapshot_sha256 OR command_digest IS DISTINCT FROM NEW.request_digest
  THEN RAISE EXCEPTION 'Requeue canonical snapshot/command differs' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_state'; END IF;

  audit_id := pg_catalog.gen_random_uuid();
  INSERT INTO model_router_saas.saas_audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
    VALUES(audit_id,NEW.tenant_id,NEW.actor_user_id,'provider-credential.validation-requeued','credential-validation-job',
      NEW.job_id::text,checked_time,'credential-validation-requeue',NEW.request_id);
  INSERT INTO model_router_saas.saas_credential_validation_cycles
    (id,tenant_id,job_id,actor_user_id,actor_session_id,audit_event_id,prior_cycle_id,prior_state,prior_lease_generation,
     prior_attempt_count,prior_error_code,prior_completed_at,prior_snapshot,snapshot_sha256,target_evidence_sha256,
     credential_authz_version,cycle_start_attempt_count,cycle_attempt_limit,result_lease_generation,recorded_at)
    VALUES(NEW.id,NEW.tenant_id,NEW.job_id,NEW.actor_user_id,NEW.actor_session_id,audit_id,job_row.current_cycle_id,
      job_row.status,job_row.lease_generation,job_row.attempt_count,job_row.last_error_code,job_row.completed_at,
      pg_catalog.to_jsonb(job_row),snapshot_digest,capability_evidence_sha256,credential_row.authz_version,
      job_row.attempt_count,5,job_row.lease_generation+1,checked_time);
  UPDATE model_router_saas.saas_tenant_provider_credential_validation_jobs
    SET status='queued',lease_until=NULL,lease_generation=lease_generation+1,
      available_at=checked_time,last_error_code=NULL,completed_at=NULL,updated_at=checked_time,
      current_cycle_id=NEW.id,cycle_start_attempt_count=job_row.attempt_count,cycle_attempt_limit=5
    WHERE id=NEW.job_id AND tenant_id=NEW.tenant_id AND status=job_row.status
      AND lease_until IS NULL AND lease_generation=NEW.expected_lease_generation AND attempt_count=job_row.attempt_count;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'Requeue generation CAS lost' USING ERRCODE = '23514', CONSTRAINT = 'saas_requeue_state'; END IF;
  NEW.audit_event_id := audit_id;
  NEW.target_evidence_sha256 := capability_evidence_sha256;
  NEW.result_lease_generation := job_row.lease_generation+1;
  NEW.cycle_start_attempt_count := job_row.attempt_count;
  NEW.cycle_attempt_limit := 5;
  NEW.recorded_at := checked_time;
  RETURN NEW;
END;
`;

export const REQUEUE_COUNTER_SOURCE = `
BEGIN
  IF NEW.current_cycle_id IS DISTINCT FROM OLD.current_cycle_id
    OR NEW.cycle_start_attempt_count IS DISTINCT FROM OLD.cycle_start_attempt_count
    OR NEW.cycle_attempt_limit IS DISTINCT FROM OLD.cycle_attempt_limit THEN
    /* Only the exact nested request trigger may open a cycle. CP/worker have
     * no metadata UPDATE; even a direct migrator UPDATE is not a requeue. */
    IF current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM 'model_router_saas_control_plane'
      OR pg_catalog.pg_trigger_depth() <> 2 OR OLD.status NOT IN ('failed','cancelled') OR OLD.lease_until IS NOT NULL
      OR NEW.status <> 'queued' OR NEW.lease_until IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
      OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation+1
      OR NEW.cycle_start_attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.cycle_attempt_limit IS DISTINCT FROM 5
      OR NOT EXISTS (SELECT 1 FROM model_router_saas.saas_credential_validation_cycles c
        JOIN model_router_saas.saas_audit_events a ON a.id=c.audit_event_id
        WHERE c.id=NEW.current_cycle_id AND c.tenant_id=OLD.tenant_id AND c.job_id=OLD.id
          AND c.prior_cycle_id IS NOT DISTINCT FROM OLD.current_cycle_id AND c.prior_state=OLD.status
          AND c.prior_attempt_count=OLD.attempt_count AND c.prior_lease_generation=OLD.lease_generation
          AND c.cycle_start_attempt_count=OLD.attempt_count AND c.cycle_attempt_limit=5 AND c.result_lease_generation=NEW.lease_generation
          AND c.prior_snapshot IS NOT DISTINCT FROM pg_catalog.to_jsonb(OLD)
          AND a.tenant_id=c.tenant_id AND a.actor_user_id=c.actor_user_id
          AND a.action='provider-credential.validation-requeued' AND a.target_type='credential-validation-job'
          AND a.target_id=OLD.id::text AND a.entry_point='credential-validation-requeue')
    THEN RAISE EXCEPTION 'Validation cycle can only open through the audited request' USING ERRCODE='55000'; END IF;
  ELSIF NEW.current_cycle_id IS NOT NULL THEN
    /* No nested helper/history SELECT in the ordinary restricted worker path.
     * Cumulative attempts stay monotonic; only a real claim increments by one.
     * An OLD binary's global attempt_limit failure on a fresh cycle refuses
     * instead of silently consuming the newly audited budget. */
    IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count+1
      OR NEW.attempt_count-NEW.cycle_start_attempt_count > NEW.cycle_attempt_limit
      OR (NEW.attempt_count=OLD.attempt_count+1 AND
        (NEW.status <> 'leased' OR NEW.lease_generation <> OLD.lease_generation+1
          OR NOT (OLD.status='queued' OR (OLD.status='leased' AND OLD.lease_until <= pg_catalog.clock_timestamp()))))
      OR (NEW.status='leased' AND OLD.status<>'leased' AND NEW.attempt_count<>OLD.attempt_count+1)
      OR (NEW.last_error_code='attempt_limit' AND NEW.status='failed'
        AND NEW.attempt_count-NEW.cycle_start_attempt_count < NEW.cycle_attempt_limit)
    THEN RAISE EXCEPTION 'Validation cycle cumulative/per-cycle attempts are invalid' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END;
`;

const schemaSql = `
CREATE TABLE model_router_saas.saas_credential_validation_requeue_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES model_router_saas.saas_tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES model_router_saas.saas_users(id) ON DELETE RESTRICT,
  actor_session_id uuid NOT NULL REFERENCES model_router_saas.saas_sessions(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES model_router_saas.saas_tenant_provider_credential_validation_jobs(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  request_id text NOT NULL CHECK(request_id ~ '^[!-~]{1,128}$'),
  expected_credential_authz_version bigint NOT NULL CHECK(expected_credential_authz_version BETWEEN 1 AND 9007199254740991),
  expected_lease_generation bigint NOT NULL CHECK(expected_lease_generation BETWEEN 0 AND 9007199254740990),
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK(reason_code IN ('target_approved','retry_provider_validation')),
  reason text NOT NULL CHECK(reason ~ '^[ -~]{1,512}$' AND reason=btrim(reason)),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES model_router_saas.saas_audit_events(id) ON DELETE RESTRICT,
  target_evidence_sha256 text NOT NULL CHECK(target_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  result_lease_generation bigint NOT NULL CHECK(result_lease_generation=expected_lease_generation+1),
  cycle_start_attempt_count integer NOT NULL CHECK(cycle_start_attempt_count BETWEEN 0 AND 2147483642),
  cycle_attempt_limit smallint NOT NULL CHECK(cycle_attempt_limit=5),
  recorded_at timestamptz NOT NULL,
  UNIQUE(tenant_id,idempotency_key), UNIQUE(tenant_id,request_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES model_router_saas.saas_memberships(tenant_id,user_id) ON DELETE RESTRICT
);
CREATE TABLE model_router_saas.saas_credential_validation_cycles (
  id uuid PRIMARY KEY REFERENCES model_router_saas.saas_credential_validation_requeue_requests(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  tenant_id uuid NOT NULL REFERENCES model_router_saas.saas_tenants(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES model_router_saas.saas_tenant_provider_credential_validation_jobs(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES model_router_saas.saas_users(id) ON DELETE RESTRICT,
  actor_session_id uuid NOT NULL REFERENCES model_router_saas.saas_sessions(id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL UNIQUE REFERENCES model_router_saas.saas_audit_events(id) ON DELETE RESTRICT,
  prior_cycle_id uuid REFERENCES model_router_saas.saas_credential_validation_cycles(id) ON DELETE RESTRICT,
  prior_state text NOT NULL CHECK(prior_state IN ('failed','cancelled')),
  prior_lease_generation bigint NOT NULL CHECK(prior_lease_generation BETWEEN 0 AND 9007199254740990),
  prior_attempt_count integer NOT NULL CHECK(prior_attempt_count BETWEEN 0 AND 2147483642),
  prior_error_code text,
  prior_completed_at timestamptz NOT NULL,
  prior_snapshot jsonb NOT NULL CHECK(jsonb_typeof(prior_snapshot)='object'),
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  target_evidence_sha256 text NOT NULL CHECK(target_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  credential_authz_version bigint NOT NULL CHECK(credential_authz_version BETWEEN 1 AND 9007199254740991),
  cycle_start_attempt_count integer NOT NULL CHECK(cycle_start_attempt_count=prior_attempt_count),
  cycle_attempt_limit smallint NOT NULL CHECK(cycle_attempt_limit=5),
  result_lease_generation bigint NOT NULL CHECK(result_lease_generation=prior_lease_generation+1),
  recorded_at timestamptz NOT NULL,
  UNIQUE(tenant_id,job_id,prior_lease_generation)
);
ALTER TABLE model_router_saas.saas_tenant_provider_credential_validation_jobs
  ADD COLUMN current_cycle_id uuid,
  ADD COLUMN cycle_start_attempt_count integer,
  ADD COLUMN cycle_attempt_limit smallint,
  ADD CONSTRAINT saas_validation_job_cycle_shape CHECK (
    (current_cycle_id IS NULL AND cycle_start_attempt_count IS NULL AND cycle_attempt_limit IS NULL)
    OR (current_cycle_id IS NOT NULL AND cycle_start_attempt_count IS NOT NULL AND cycle_attempt_limit IS NOT NULL
      AND cycle_start_attempt_count BETWEEN 0 AND 2147483642 AND cycle_attempt_limit=5
      AND attempt_count BETWEEN cycle_start_attempt_count AND cycle_start_attempt_count+cycle_attempt_limit)),
  ADD CONSTRAINT saas_validation_job_cycle_fk FOREIGN KEY(current_cycle_id)
    REFERENCES model_router_saas.saas_credential_validation_cycles(id) ON DELETE RESTRICT;
CREATE TRIGGER saas_validation_requeue_requests_immutable BEFORE UPDATE OR DELETE
  ON model_router_saas.saas_credential_validation_requeue_requests
  FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
CREATE TRIGGER saas_validation_requeue_requests_no_truncate BEFORE TRUNCATE
  ON model_router_saas.saas_credential_validation_requeue_requests
  FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
CREATE TRIGGER saas_validation_cycles_immutable BEFORE UPDATE OR DELETE
  ON model_router_saas.saas_credential_validation_cycles
  FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
CREATE TRIGGER saas_validation_cycles_no_truncate BEFORE TRUNCATE
  ON model_router_saas.saas_credential_validation_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
`;

const sql = `
/* Forward only: no old row backfill, attempt reset, old routine rewrite, ACL
 * grant or ledger modification. New table privileges belong to the normal
 * exact-role reconciliation at a separate integration GO. All custom routine
 * EXECUTE remains denied to CP/GW/worker, including this trigger-only writer.
 */
DO $audited_credential_validation_requeue$
DECLARE
  trusted_owner oid := pg_catalog.to_regrole('model_router_saas_migrator');
  managed_schema oid := pg_catalog.to_regnamespace('model_router_saas');
  jobs_table oid := pg_catalog.to_regclass('model_router_saas.saas_tenant_provider_credential_validation_jobs');
  expected record; routine record; binding record; role_name text;
  old_functions oid[]; old_relations oid[]; old_constraints oid[]; old_triggers oid[]; old_indexes oid[];
  function_before jsonb; function_after jsonb; acl_before jsonb; acl_after jsonb;
  column_before jsonb; column_after jsonb; constraint_before jsonb; constraint_after jsonb;
  trigger_before jsonb; trigger_after jsonb; index_before jsonb; index_after jsonb;
  original_count bigint;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM current_user
    OR trusted_owner IS NULL OR managed_schema IS NULL OR jobs_table IS NULL
    OR pg_catalog.current_setting('server_version_num')::integer < 150000
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=trusted_owner
      AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE oid=managed_schema AND nspowner=trusted_owner)
    OR (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('model_router_saas_control_plane','model_router_saas_gateway')) <> 2
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN
      ('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
      AND (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
        OR pg_catalog.pg_has_role(oid,trusted_owner,'MEMBER') OR pg_catalog.has_schema_privilege(oid,managed_schema,'CREATE')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN
      ('model_router_saas_migrator','model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
      WHERE n.oid=managed_schema AND a.grantee<>trusted_owner AND a.privilege_type='CREATE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc p ON p.pronamespace=managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
        AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('model_router_saas_control_plane','model_router_saas_gateway')
      AND pg_catalog.has_any_column_privilege(oid,jobs_table,'UPDATE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='model_router_saas_gateway'
      AND pg_catalog.has_any_column_privilege(oid,'model_router_saas.saas_api_keys','UPDATE'))
  THEN RAISE EXCEPTION 'Migration 061 requires exact isolated trusted owner and unchanged restricted roles'; END IF;
  IF (SELECT count(*) FROM model_router_saas.saas_schema_migrations) <> 60
    OR (SELECT min(version) FROM model_router_saas.saas_schema_migrations) <> 1
    OR (SELECT max(version) FROM model_router_saas.saas_schema_migrations) <> 60
    OR EXISTS(SELECT 1 FROM (VALUES
      (35,${quote(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.name)},${quote(checksum(CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION))}),
      (58,${quote(CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION.name)},${quote(checksum(CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION))}),
      (59,${quote(PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION.name)},${quote(checksum(PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION))}),
      (60, ${quote(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.name)}, ${quote(checksum(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION))})
    ) AS release(version,name,checksum) WHERE NOT EXISTS(SELECT 1 FROM model_router_saas.saas_schema_migrations h
      WHERE h.version=release.version AND h.name=release.name AND h.checksum=release.checksum))
    OR pg_catalog.to_regclass('model_router_saas.saas_credential_validation_requeue_requests') IS NOT NULL
    OR pg_catalog.to_regclass('model_router_saas.saas_credential_validation_cycles') IS NOT NULL
    OR pg_catalog.to_regprocedure('model_router_saas.saas_credential_validation_requeue_request_insert()') IS NOT NULL
    OR pg_catalog.to_regprocedure('model_router_saas.saas_credential_validation_job_cycle_guard()') IS NOT NULL
  THEN RAISE EXCEPTION 'Migration 061 requires the normal verified 060 prefix and no adopted requeue objects'; END IF;
  FOR expected IN SELECT * FROM (VALUES ('saas_tenants'),('saas_users'),('saas_memberships'),('saas_sessions'),('saas_audit_events'),
    ('saas_provider_products'),('saas_provider_capabilities'),('saas_provider_rights'),('saas_tenant_provider_accounts'),
    ('saas_tenant_provider_credentials'),('saas_tenant_provider_credential_versions'),
    ('saas_tenant_provider_account_capabilities'),('saas_tenant_provider_credential_validation_jobs')) e(name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('model_router_saas.'||expected.name)
      AND c.relowner=trusted_owner AND c.relnamespace=managed_schema AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN
        ('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
        AND pg_catalog.has_table_privilege(r.oid,pg_catalog.to_regclass('model_router_saas.'||expected.name),'TRIGGER'))
    THEN RAISE EXCEPTION 'Migration 061 trusted relation/attachment owner drift'; END IF;
  END LOOP;
  LOCK TABLE model_router_saas.saas_tenant_provider_accounts,model_router_saas.saas_tenant_provider_credentials,
    model_router_saas.saas_tenant_provider_credential_validation_jobs IN ACCESS EXCLUSIVE MODE;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=jobs_table AND attnum>0 AND NOT attisdropped) <> 22
    OR EXISTS(SELECT 1 FROM (VALUES
      (1,'id','uuid',true),(2,'tenant_id','uuid',true),(3,'account_id','text',true),(4,'credential_id','text',true),
      (5,'credential_version','int4',true),(6,'provider_id','text',true),(7,'product_id','text',true),
      (8,'credential_type','text',true),(9,'allowed_models','text[]',true),(10,'target_model','text',true),
      (11,'target_endpoint','text',true),(12,'capability_version','int4',true),(13,'idempotency_key','text',true),
      (14,'status','text',true),(15,'attempt_count','int4',true),(16,'available_at','timestamptz',true),
      (17,'lease_until','timestamptz',false),(18,'lease_generation','int8',true),(19,'last_error_code','text',false),
      (20,'completed_at','timestamptz',false),(21,'created_at','timestamptz',true),(22,'updated_at','timestamptz',true)
    ) e(position,name,type,not_null) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=jobs_table AND a.attnum=e.position AND a.attname=e.name AND a.atttypid=pg_catalog.to_regtype(e.type)
        AND a.attnotnull=e.not_null AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity=''))
    OR (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid=jobs_table) <> 18
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_table AND NOT convalidated)
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=jobs_table AND NOT tgisinternal) <> 2
  THEN RAISE EXCEPTION 'Migration 061 original 035 job columns/validated constraints/triggers drift'; END IF;
  /* Exact original keys/FKs, not merely a count of constraints. Harmless
   * deparser grouping is normalized ONLY for the listed atomic boolean facts;
   * complex models/endpoint/error checks are not rewritten or generalized. */
  FOR expected IN SELECT * FROM (VALUES
    ('saas_tenant_provider_credential_validation_jobs_pkey','p',ARRAY['id'],NULL::text,NULL::text[]),
    ('saas_tenant_provider_credential_validation_jobs_identity_unique','u',ARRAY['tenant_id','credential_id','credential_version'],NULL::text,NULL::text[]),
    ('saas_tenant_provider_credential_validation_jobs_idempotency_unique','u',ARRAY['idempotency_key'],NULL::text,NULL::text[]),
    ('saas_tenant_provider_credential_validation_jobs_account_fk','f',ARRAY['tenant_id','account_id','provider_id','product_id'],
      'saas_tenant_provider_accounts',ARRAY['tenant_id','id','provider_id','product_id']),
    ('saas_tenant_provider_credential_validation_jobs_credential_fk','f',ARRAY['tenant_id','credential_id','account_id'],
      'saas_tenant_provider_credentials',ARRAY['tenant_id','id','account_id']),
    ('saas_tenant_provider_credential_validation_jobs_version_fk','f',ARRAY['tenant_id','credential_id','credential_version'],
      'saas_tenant_provider_credential_versions',ARRAY['tenant_id','credential_id','version'])
  ) e(name,kind,columns,referenced,reference_columns) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=jobs_table AND c.conname=left(expected.name,63)
      AND c.contype::text=expected.kind AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(number,position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.number ORDER BY k.position)=expected.columns
      AND (expected.kind<>'f' OR (c.confrelid=pg_catalog.to_regclass('model_router_saas.'||expected.referenced)
        AND c.confupdtype='a' AND c.confdeltype='r' AND c.confmatchtype='s'
        AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(number,position)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.number ORDER BY k.position)=expected.reference_columns)))
    THEN RAISE EXCEPTION 'Migration 061 original 035 key/FK contract drift'; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('attempt_count >= 0'),('lease_generation >= 0'),('credential_version >= 1'),('capability_version >= 1'),
    ($check$status = ANY (ARRAY['queued'::text, 'leased'::text, 'verified'::text, 'failed'::text, 'cancelled'::text])$check$),
    ($check$(status = 'leased'::text) = (lease_until IS NOT NULL)$check$),
    ($check$(status = ANY (ARRAY['verified'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL)$check$)
  ) e(expression) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=jobs_table AND c.contype='c' AND c.convalidated
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g')
        =pg_catalog.regexp_replace(expected.expression,'[()[:space:]]','','g'))
    THEN RAISE EXCEPTION 'Migration 061 original atomic status/attempt/lease/completion check drift'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    WHERE c.relnamespace=managed_schema AND c.relname='saas_tenant_provider_credential_validation_jobs_claim_idx'
      AND i.indrelid=jobs_table AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
      AND i.indexprs IS NULL AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indkey::text='16 21 1'
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),'[()[:space:]]','','g')
        =pg_catalog.regexp_replace($claim$status = ANY (ARRAY['queued'::text, 'leased'::text])$claim$,'[()[:space:]]','','g'))
  THEN RAISE EXCEPTION 'Migration 061 original claim index contract drift'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ${originalFunctions},
    ('saas_reject_immutable_change()',$immutable$${immutableSource}$immutable$,false)
  ) e(signature,source,definer) LOOP
    SELECT p.*,l.lanname INTO routine FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=pg_catalog.to_regprocedure('model_router_saas.'||expected.signature);
    IF NOT FOUND OR routine.proowner IS DISTINCT FROM trusted_owner OR routine.pronamespace IS DISTINCT FROM managed_schema
      OR routine.prosrc IS DISTINCT FROM expected.source OR routine.lanname <> 'plpgsql' OR routine.prorettype <> 'pg_catalog.trigger'::regtype
      OR routine.prosecdef IS DISTINCT FROM expected.definer OR routine.proconfig IS DISTINCT FROM
        CASE WHEN expected.definer THEN ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'] ELSE NULL::text[] END
      OR routine.pronargs<>0 OR routine.prokind<>'f' OR routine.proretset OR routine.proisstrict OR routine.proleakproof
      OR routine.provolatile<>'v' OR routine.proparallel<>'u' OR routine.pronargdefaults<>0 OR routine.provariadic<>0 OR routine.prosupport<>0
      OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(routine.proacl,pg_catalog.acldefault('f',routine.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
    THEN RAISE EXCEPTION 'Migration 061 exact historical function body/security/owner drift'; END IF;
  END LOOP;
  FOR binding IN SELECT * FROM (VALUES ${originalBindings}) e(table_name,name,signature,type,columns) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('model_router_saas.'||binding.table_name)
      AND t.tgname=binding.name AND t.tgfoid=pg_catalog.to_regprocedure('model_router_saas.'||binding.signature)
      AND t.tgtype=binding.type AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgargs=pg_catalog.decode('','hex')
      AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND t.tgattr::text=pg_catalog.array_to_string(ARRAY(SELECT a.attnum FROM pg_catalog.unnest(binding.columns)
        WITH ORDINALITY cols(name,position) JOIN pg_catalog.pg_attribute a
          ON a.attrelid=t.tgrelid AND a.attname=cols.name AND a.attnum>0 AND NOT a.attisdropped ORDER BY cols.position),' '))
    THEN RAISE EXCEPTION 'Migration 061 historical invalidation/identity/delete binding drift'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid IN
    (SELECT pg_catalog.to_regprocedure('model_router_saas.'||signature) FROM (VALUES
      ('saas_invalidate_account_credential_validation_jobs()'),('saas_invalidate_credential_validation_jobs()'),
      ('saas_credential_validation_job_identity_immutable()'),('saas_provider_credential_validation_job_reject_delete()')) e(signature))) <> 4
  THEN RAISE EXCEPTION 'Migration 061 original 035 attachment cardinality drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='model_router_saas.saas_audit_events'::regclass
    AND t.tgname='saas_audit_events_immutable' AND t.tgfoid='model_router_saas.saas_reject_immutable_change()'::regprocedure
    AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgargs=pg_catalog.decode('','hex')
    AND t.tgattr::text='' AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred)
  THEN RAISE EXCEPTION 'Migration 061 requires the original immutable audit attachment'; END IF;

  SELECT array_agg(oid ORDER BY oid),jsonb_agg(to_jsonb(p) ORDER BY oid) INTO old_functions,function_before
    FROM pg_catalog.pg_proc p WHERE pronamespace=managed_schema;
  SELECT array_agg(oid ORDER BY oid),jsonb_agg(jsonb_build_array(oid,relnamespace,relowner,relkind,relacl) ORDER BY oid)
    INTO old_relations,acl_before FROM pg_catalog.pg_class WHERE relnamespace=managed_schema;
  SELECT jsonb_agg(to_jsonb(a) ORDER BY attrelid,attnum) INTO column_before FROM pg_catalog.pg_attribute a WHERE attrelid=ANY(old_relations);
  SELECT array_agg(oid ORDER BY oid),jsonb_agg(to_jsonb(k) ORDER BY oid) INTO old_constraints,constraint_before
    FROM pg_catalog.pg_constraint k WHERE connamespace=managed_schema;
  SELECT array_agg(t.oid ORDER BY t.oid),jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO old_triggers,trigger_before
    FROM pg_catalog.pg_trigger t WHERE tgrelid=ANY(old_relations);
  SELECT array_agg(indexrelid ORDER BY indexrelid),jsonb_agg(to_jsonb(i) ORDER BY indexrelid) INTO old_indexes,index_before
    FROM pg_catalog.pg_index i WHERE indrelid=ANY(old_relations);
  SELECT count(*) INTO original_count FROM model_router_saas.saas_tenant_provider_credential_validation_jobs;

  EXECUTE $new_schema$${schemaSql}$new_schema$;
  EXECUTE $new_writer$CREATE FUNCTION model_router_saas.saas_credential_validation_requeue_request_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,model_router_saas,pg_temp AS $body$${REQUEUE_WRITER_SOURCE}$body$;$new_writer$;
  EXECUTE $new_counter$CREATE FUNCTION model_router_saas.saas_credential_validation_job_cycle_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path TO pg_catalog,model_router_saas,pg_temp AS $body$${REQUEUE_COUNTER_SOURCE}$body$;$new_counter$;
  EXECUTE 'REVOKE ALL ON FUNCTION model_router_saas.saas_credential_validation_requeue_request_insert() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION model_router_saas.saas_credential_validation_job_cycle_guard() FROM PUBLIC';
  FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN
    ('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION model_router_saas.saas_credential_validation_requeue_request_insert() FROM %I',role_name);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION model_router_saas.saas_credential_validation_job_cycle_guard() FROM %I',role_name);
  END LOOP;
  EXECUTE 'CREATE TRIGGER saas_validation_requeue_request_insert BEFORE INSERT ON model_router_saas.saas_credential_validation_requeue_requests
    FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_credential_validation_requeue_request_insert()';
  EXECUTE 'CREATE TRIGGER saas_validation_job_cycle_guard BEFORE UPDATE ON model_router_saas.saas_tenant_provider_credential_validation_jobs
    FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_credential_validation_job_cycle_guard()';

  SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) INTO function_after FROM pg_catalog.pg_proc p WHERE oid=ANY(old_functions);
  SELECT jsonb_agg(jsonb_build_array(oid,relnamespace,relowner,relkind,relacl) ORDER BY oid) INTO acl_after
    FROM pg_catalog.pg_class WHERE oid=ANY(old_relations);
  SELECT jsonb_agg(to_jsonb(a) ORDER BY attrelid,attnum) INTO column_after FROM pg_catalog.pg_attribute a
    WHERE attrelid=ANY(old_relations) AND NOT (attrelid=jobs_table AND attnum>22);
  SELECT jsonb_agg(to_jsonb(k) ORDER BY oid) INTO constraint_after FROM pg_catalog.pg_constraint k WHERE oid=ANY(old_constraints);
  SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) INTO trigger_after FROM pg_catalog.pg_trigger t WHERE oid=ANY(old_triggers);
  SELECT jsonb_agg(to_jsonb(i) ORDER BY indexrelid) INTO index_after FROM pg_catalog.pg_index i WHERE indexrelid=ANY(old_indexes);
  IF function_after IS DISTINCT FROM function_before OR acl_after IS DISTINCT FROM acl_before
    OR column_after IS DISTINCT FROM column_before OR constraint_after IS DISTINCT FROM constraint_before
    OR trigger_after IS DISTINCT FROM trigger_before OR index_after IS DISTINCT FROM index_before
    OR (SELECT count(*) FROM model_router_saas.saas_tenant_provider_credential_validation_jobs) <> original_count
    OR EXISTS(SELECT 1 FROM model_router_saas.saas_tenant_provider_credential_validation_jobs
      WHERE current_cycle_id IS NOT NULL OR cycle_start_attempt_count IS NOT NULL OR cycle_attempt_limit IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=jobs_table AND attnum>22
      AND (attnotnull OR atthasdef OR attacl IS NOT NULL OR attgenerated<>'' OR attidentity<>''))
    OR (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=jobs_table AND attnum>22 AND NOT attisdropped)<>3
    OR EXISTS(SELECT 1 FROM (VALUES(23,'current_cycle_id','uuid'),(24,'cycle_start_attempt_count','int4'),(25,'cycle_attempt_limit','int2'))
      e(position,name,type) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=jobs_table
        AND a.attnum=e.position AND a.attname=e.name AND a.atttypid=pg_catalog.to_regtype(e.type) AND NOT a.attisdropped))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace=managed_schema AND NOT convalidated)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc p ON p.pronamespace=managed_schema
      WHERE r.rolname IN ('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
        AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('model_router_saas_control_plane','model_router_saas_gateway')
      AND pg_catalog.has_any_column_privilege(r.oid,jobs_table,'UPDATE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid IN('model_router_saas.saas_credential_validation_requeue_requests'::regclass,'model_router_saas.saas_credential_validation_cycles'::regclass)
        AND (c.relowner<>trusted_owner OR a.grantee<>trusted_owner))
  THEN RAISE EXCEPTION 'Migration 061 exceeded its additive no-backfill/no-ACL/no-history-change contract'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('saas_credential_validation_requeue_request_insert()',$writer_source$${REQUEUE_WRITER_SOURCE}$writer_source$,true),
    ('saas_credential_validation_job_cycle_guard()',$counter_source$${REQUEUE_COUNTER_SOURCE}$counter_source$,false)
  ) e(signature,source,definer) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('model_router_saas.'||expected.signature)
      AND p.proowner=trusted_owner AND p.pronamespace=managed_schema AND p.prosrc=expected.source AND p.prosecdef=expected.definer
      AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'] AND p.pronargs=0 AND p.prokind='f'
      AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof
      AND p.provolatile='v' AND p.proparallel='u' AND p.pronargdefaults=0 AND p.provariadic=0 AND p.prosupport=0)
    THEN RAISE EXCEPTION 'Migration 061 new routine source/owner/security attributes differ'; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('saas_credential_validation_requeue_requests','saas_validation_requeue_request_insert','saas_credential_validation_requeue_request_insert()',7),
    ('saas_tenant_provider_credential_validation_jobs','saas_validation_job_cycle_guard','saas_credential_validation_job_cycle_guard()',19),
    ('saas_credential_validation_requeue_requests','saas_validation_requeue_requests_immutable','saas_reject_immutable_change()',27),
    ('saas_credential_validation_requeue_requests','saas_validation_requeue_requests_no_truncate','saas_reject_immutable_change()',34),
    ('saas_credential_validation_cycles','saas_validation_cycles_immutable','saas_reject_immutable_change()',27),
    ('saas_credential_validation_cycles','saas_validation_cycles_no_truncate','saas_reject_immutable_change()',34)
  ) e(relation,name,signature,type) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('model_router_saas.'||expected.relation)
      AND t.tgname=expected.name AND t.tgfoid=pg_catalog.to_regprocedure('model_router_saas.'||expected.signature)
      AND t.tgtype=expected.type AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgargs=pg_catalog.decode('','hex')
      AND t.tgattr::text='' AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
    THEN RAISE EXCEPTION 'Migration 061 new trigger attachment/events/arguments drift'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid='model_router_saas.saas_credential_validation_requeue_request_insert()'::regprocedure)<>1
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid='model_router_saas.saas_credential_validation_job_cycle_guard()'::regprocedure)<>1
    OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace=managed_schema)<>pg_catalog.cardinality(old_functions)+2
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=jobs_table AND NOT tgisinternal)<>3
    OR (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid=jobs_table)<>20
  THEN RAISE EXCEPTION 'Migration 061 additive function/trigger/constraint cardinality drift'; END IF;
END;
$audited_credential_validation_requeue$;
`;

export const AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION: SaasMigration = {
  version: 61,
  name: 'audited_credential_validation_requeue',
  sql,
};
