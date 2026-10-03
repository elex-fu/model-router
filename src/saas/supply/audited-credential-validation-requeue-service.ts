import { createHash, randomUUID } from 'node:crypto';
import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import {
  AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION,
  REQUEUE_COUNTER_SOURCE, REQUEUE_WRITER_SOURCE,
} from '../db/migrations/061_audited_credential_validation_requeue.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from '../db/migrations/060_prepared_evidence_claim_generated_account.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import {
  credentialValidationJobSnapshotSha256, isApprovedCredentialValidationTargets,
  resolveApprovedCredentialValidationTarget, type ApprovedCredentialValidationTargets,
} from './credential-validation-targets.js';
import { prepareCredentialValidationRequeue } from './credential-validation-worker.js';
import {
  CREDENTIAL_VALIDATION_MANUAL_CYCLE_ATTEMPT_LIMIT,
  CREDENTIAL_VALIDATION_REQUEUE_DIGEST_DOMAIN, CredentialValidationRequeueError,
  type AuditedCredentialValidationRequeueCommand, type AuditedCredentialValidationRequeueReceipt,
  type CredentialValidationRequeueActor, type CredentialValidationRequeueErrorCode,
} from './credential-validation-requeue-types.js';
import type { CredentialValidationRequeueCapabilityEvidence, ProviderCredentialValidationJobRecord } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const COMMAND_KEYS = ['jobId', 'expectedCredentialAuthzVersion', 'expectedLeaseGeneration', 'expectedSnapshotSha256',
  'idempotencyKey', 'requestId', 'reasonCode', 'reason'] as const;
export const REQUEUE_REQUEST_INSERT_COLUMNS = ['id', 'tenant_id', 'actor_user_id', 'actor_session_id', 'job_id',
  'idempotency_key', 'request_digest', 'request_id', 'expected_credential_authz_version', 'expected_lease_generation',
  'snapshot_sha256', 'reason_code', 'reason'] as const;
export const REQUEUE_REQUEST_READ_COLUMNS = [...REQUEUE_REQUEST_INSERT_COLUMNS.filter((column) => column !== 'actor_session_id'),
  'audit_event_id', 'target_evidence_sha256', 'result_lease_generation', 'cycle_start_attempt_count', 'cycle_attempt_limit', 'recorded_at'] as const;
export const REQUEUE_CYCLE_READ_COLUMNS = ['id', 'tenant_id', 'job_id', 'actor_user_id', 'audit_event_id', 'snapshot_sha256',
  'target_evidence_sha256', 'credential_authz_version', 'prior_lease_generation', 'cycle_start_attempt_count',
  'cycle_attempt_limit', 'result_lease_generation', 'recorded_at'] as const;
export const REQUEUE_JOB_READ_COLUMNS = ['current_cycle_id', 'cycle_start_attempt_count', 'cycle_attempt_limit'] as const;
const JOB_READ = `id,tenant_id,account_id,credential_id,credential_version,provider_id,product_id,credential_type,
  allowed_models,target_model,target_endpoint,capability_version,idempotency_key,status,attempt_count,
  available_at,lease_until,lease_generation,last_error_code,completed_at,created_at,updated_at,
  current_cycle_id,cycle_start_attempt_count,cycle_attempt_limit`;

function refuse(code: CredentialValidationRequeueErrorCode): never { throw new CredentialValidationRequeueError(code); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) refuse('STORAGE_UNAVAILABLE');
  return parsed;
}
function timestamp(value: unknown): string {
  if (!(typeof value === 'string' || value instanceof Date)) refuse('STORAGE_UNAVAILABLE');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) refuse('STORAGE_UNAVAILABLE');
  return date.toISOString();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value || value.includes('\0')) refuse('STORAGE_UNAVAILABLE');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HEX.test(value)) refuse('STORAGE_UNAVAILABLE');
  return value;
}
function normalize(input: AuditedCredentialValidationRequeueCommand): Readonly<AuditedCredentialValidationRequeueCommand> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== COMMAND_KEYS.length ||
    Object.keys(input).some((key) => !COMMAND_KEYS.includes(key as typeof COMMAND_KEYS[number])) ||
    typeof input.jobId !== 'string' || !UUID.test(input.jobId) ||
    !Number.isSafeInteger(input.expectedCredentialAuthzVersion) || input.expectedCredentialAuthzVersion < 1 ||
    !Number.isSafeInteger(input.expectedLeaseGeneration) || input.expectedLeaseGeneration < 0 || input.expectedLeaseGeneration >= Number.MAX_SAFE_INTEGER ||
    typeof input.expectedSnapshotSha256 !== 'string' || !HEX.test(input.expectedSnapshotSha256) ||
    typeof input.idempotencyKey !== 'string' || !HEX.test(input.idempotencyKey) ||
    typeof input.requestId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(input.requestId) ||
    !['target_approved', 'retry_provider_validation'].includes(input.reasonCode) ||
    typeof input.reason !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(input.reason) || input.reason.trim() !== input.reason) refuse('INVALID_INPUT');
  return Object.freeze({ ...input });
}

/** Fixed-tag canonical digest; replay uses the ORIGINAL persisted catalog ref. */
export function credentialValidationRequeueRequestDigest(
  tenantId: string, actorUserId: string, command: AuditedCredentialValidationRequeueCommand, targetEvidenceSha256: string,
): string {
  const checked = normalize(command);
  if (!UUID.test(tenantId) || !UUID.test(actorUserId) || !HEX.test(targetEvidenceSha256)) refuse('INVALID_INPUT');
  return createHash('sha256').update(JSON.stringify([CREDENTIAL_VALIDATION_REQUEUE_DIGEST_DOMAIN,
    tenantId, actorUserId, checked.jobId, checked.expectedCredentialAuthzVersion, checked.expectedLeaseGeneration,
    checked.expectedSnapshotSha256, checked.idempotencyKey, checked.requestId, checked.reasonCode, checked.reason, targetEvidenceSha256,
  ])).digest('hex');
}

export const REQUEUE_READINESS_SQL = `SELECT
  current_user='model_router_saas_control_plane' AND session_user=current_user
  AND current_setting('search_path')='model_router_saas' AND current_schemas(true)=ARRAY['pg_catalog','model_router_saas']::name[]
  AND current_setting('transaction_isolation')='read committed'
  AND EXISTS(SELECT 1 FROM saas_schema_migrations WHERE version=61 AND name=$1 AND checksum=$2)
  AND EXISTS(SELECT 1 FROM saas_schema_migrations WHERE version=60 AND name=$9 AND checksum=$10)
  AND NOT EXISTS(SELECT 1 FROM saas_schema_migrations WHERE version>61)
  AND NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_proc p ON p.pronamespace='model_router_saas'::regnamespace
    WHERE r.rolname IN('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
      AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
  AND NOT has_any_column_privilege(current_user,'saas_tenant_provider_credential_validation_jobs','UPDATE')
  AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) c(name) WHERE NOT has_column_privilege(current_user,
    'saas_credential_validation_requeue_requests',c.name,'INSERT'))
  AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) c(name) WHERE NOT has_column_privilege(current_user,
    'saas_credential_validation_requeue_requests',c.name,'SELECT'))
  AND NOT EXISTS(SELECT 1 FROM unnest($5::text[]) c(name) WHERE NOT has_column_privilege(current_user,
    'saas_credential_validation_cycles',c.name,'SELECT'))
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='model_router_saas_validation_worker')
  AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) c(name) WHERE NOT has_column_privilege(current_user,
    'saas_tenant_provider_credential_validation_jobs',c.name,'SELECT') OR NOT has_column_privilege(
    'model_router_saas_validation_worker','saas_tenant_provider_credential_validation_jobs',c.name,'SELECT'))
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('model_router_saas_control_plane','model_router_saas_gateway','model_router_saas_validation_worker')
    AND (r.rolsuper OR r.rolinherit OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)))
  AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('saas_credential_validation_requeue_request_insert()',$7::text,true),
      ('saas_credential_validation_job_cycle_guard()',$8::text,false)
    ) e(signature,source,definer) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure('model_router_saas.'||e.signature) AND p.proowner='model_router_saas_migrator'::regrole
        AND p.prosrc=e.source AND p.prosecdef=e.definer AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp']
        AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype AND p.pronargs=0 AND p.prokind='f'
        AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof AND p.provolatile='v' AND p.proparallel='u'
        AND p.pronargdefaults=0 AND p.provariadic=0 AND p.prosupport=0))
  AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('saas_credential_validation_requeue_requests','saas_validation_requeue_request_insert','saas_credential_validation_requeue_request_insert()',7),
      ('saas_tenant_provider_credential_validation_jobs','saas_validation_job_cycle_guard','saas_credential_validation_job_cycle_guard()',19)
    ) e(relation,name,signature,type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid=to_regclass('model_router_saas.'||e.relation) AND t.tgname=e.name AND t.tgfoid=to_regprocedure('model_router_saas.'||e.signature)
        AND t.tgtype=e.type AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgargs=decode('','hex')
        AND t.tgattr::text='' AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgconstraint=0 AND t.tgparentid=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)) AS ready`;

interface StoredReceipt {
  id: string; tenant_id: string; actor_user_id: string; job_id: string; idempotency_key: string; request_digest: string;
  request_id: string; target_evidence_sha256: string; audit_event_id: string; result_lease_generation: number | string;
  cycle_start_attempt_count: number | string; cycle_attempt_limit: number | string; recorded_at: Date | string;
  bound: boolean;
}
function receipt(row: StoredReceipt, replayed: boolean): Readonly<AuditedCredentialValidationRequeueReceipt> {
  if (row.bound !== true || !UUID.test(row.id) || !UUID.test(row.job_id) || !UUID.test(row.audit_event_id) ||
    integer(row.cycle_attempt_limit, 1) !== CREDENTIAL_VALIDATION_MANUAL_CYCLE_ATTEMPT_LIMIT) refuse('STORAGE_UNAVAILABLE');
  return Object.freeze({ requestId: text(row.request_id), cycleId: row.id, jobId: row.job_id, auditEventId: row.audit_event_id,
    requestDigest: hash(row.request_digest), targetEvidenceSha256: hash(row.target_evidence_sha256),
    leaseGeneration: integer(row.result_lease_generation, 1), cycleStartAttemptCount: integer(row.cycle_start_attempt_count, 0, 2_147_483_642),
    cycleAttemptLimit: integer(row.cycle_attempt_limit), recordedAt: timestamp(row.recorded_at), replayed });
}
async function persisted(tx: SqlExecutor, tenantId: string, key: string, requestId: string): Promise<StoredReceipt[]> {
  return (await tx.query<StoredReceipt>(`SELECT r.id,r.tenant_id,r.actor_user_id,r.job_id,r.idempotency_key,r.request_digest,r.request_id,
      r.target_evidence_sha256,r.audit_event_id,r.result_lease_generation,r.cycle_start_attempt_count,r.cycle_attempt_limit,r.recorded_at,
      (c.id IS NOT NULL AND c.tenant_id=r.tenant_id AND c.job_id=r.job_id AND c.actor_user_id=r.actor_user_id
        AND c.audit_event_id=r.audit_event_id AND c.snapshot_sha256=r.snapshot_sha256 AND c.target_evidence_sha256=r.target_evidence_sha256
        AND c.credential_authz_version=r.expected_credential_authz_version AND c.prior_lease_generation=r.expected_lease_generation
        AND c.cycle_start_attempt_count=r.cycle_start_attempt_count AND c.cycle_attempt_limit=r.cycle_attempt_limit
        AND c.result_lease_generation=r.result_lease_generation AND c.recorded_at=r.recorded_at
        AND a.id IS NOT NULL AND a.tenant_id=r.tenant_id AND a.actor_user_id=r.actor_user_id
        AND a.action='provider-credential.validation-requeued' AND a.target_type='credential-validation-job'
        AND a.target_id=r.job_id::text AND a.entry_point='credential-validation-requeue' AND a.request_id=r.request_id) AS bound
    FROM saas_credential_validation_requeue_requests r
    LEFT JOIN saas_credential_validation_cycles c ON c.id=r.id LEFT JOIN saas_audit_events a ON a.id=r.audit_event_id
    WHERE r.tenant_id=$1::uuid AND (r.idempotency_key=$2 OR r.request_id=$3) ORDER BY r.id`, [tenantId, key, requestId])).rows;
}

function job(row: Record<string, unknown>): ProviderCredentialValidationJobRecord {
  if (!Array.isArray(row.allowed_models) || row.allowed_models.length < 1 || row.allowed_models.length > 256) refuse('STORAGE_UNAVAILABLE');
  if (!['failed', 'cancelled'].includes(String(row.status)) || row.lease_until !== null || row.completed_at === null) refuse('STATE_CONFLICT');
  return Object.freeze({ id: text(row.id), tenantId: text(row.tenant_id), accountId: text(row.account_id), credentialId: text(row.credential_id),
    credentialVersion: integer(row.credential_version, 1), providerId: text(row.provider_id), productId: text(row.product_id),
    credentialType: text(row.credential_type), allowedModels: Object.freeze(row.allowed_models.map(text)),
    target: Object.freeze({ model: text(row.target_model), endpoint: text(row.target_endpoint), version: integer(row.capability_version, 1) }),
    idempotencyKey: hash(row.idempotency_key), state: row.status === 'failed' ? 'failed' : 'cancelled',
    attemptCount: integer(row.attempt_count, 0, 2_147_483_642), availableAt: timestamp(row.available_at), leaseUntil: null,
    leaseGeneration: integer(row.lease_generation, 0, Number.MAX_SAFE_INTEGER - 1),
    lastErrorCode: row.last_error_code === null ? null : text(row.last_error_code), completedAt: timestamp(row.completed_at),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
}

function storageFailure(error: unknown): never {
  if (error instanceof CredentialValidationRequeueError) throw error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514' && 'constraint' in error) {
    if (error.constraint === 'saas_requeue_actor') refuse('FORBIDDEN');
    if (error.constraint === 'saas_requeue_state') refuse('STATE_CONFLICT');
    if (error.constraint === 'saas_requeue_target' || error.constraint === 'saas_requeue_authority') refuse('TARGET_NOT_AUTHORIZED');
    if (error.constraint === 'saas_requeue_input') refuse('INVALID_INPUT');
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') refuse('IDEMPOTENCY_CONFLICT');
  // Driver errors/SQL arguments/secret token never enter the public cause/stack.
  refuse('STORAGE_UNAVAILABLE');
}

export class AuditedCredentialValidationRequeueService {
  constructor(private readonly database: SaasDatabase, private readonly approvedTargets?: ApprovedCredentialValidationTargets) {
    if (approvedTargets !== undefined && !isApprovedCredentialValidationTargets(approvedTargets)) refuse('INVALID_INPUT');
  }

  async requeue(actor: CredentialValidationRequeueActor, input: AuditedCredentialValidationRequeueCommand): Promise<Readonly<AuditedCredentialValidationRequeueReceipt>> {
    const command = normalize(input);
    if (!actor || !actor.context || !UUID.test(actor.context.tenantId) || !UUID.test(actor.context.userId) ||
      typeof actor.sessionToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(actor.sessionToken)) refuse('UNAUTHENTICATED');
    if (!['owner', 'admin'].includes(actor.context.tenantRole)) refuse('FORBIDDEN');
    const tenantId = actor.context.tenantId; const userId = actor.context.userId;
    const tokenHash = createHash('sha256').update(actor.sessionToken).digest('hex');
    try {
      try { await this.database.verifySchema(); } catch { refuse('SCHEMA_NOT_READY'); }
      return await this.database.transaction(async (tx) => {
        const migration = AUDITED_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION;
        const digest = createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
        const generated = PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION;
        const generatedDigest = createHash('sha256').update(generated.name).update('\0').update(generated.sql).digest('hex');
        let ready: boolean | undefined;
        try { ready = (await tx.query<{ ready: boolean }>(REQUEUE_READINESS_SQL,
          [migration.name, digest, REQUEUE_REQUEST_INSERT_COLUMNS, REQUEUE_REQUEST_READ_COLUMNS, REQUEUE_CYCLE_READ_COLUMNS,
            REQUEUE_JOB_READ_COLUMNS, REQUEUE_WRITER_SOURCE, REQUEUE_COUNTER_SOURCE, generated.name, generatedDigest])).rows[0]?.ready; }
        catch { refuse('SCHEMA_NOT_READY'); }
        if (ready !== true) refuse('SCHEMA_NOT_READY');
        await tx.query("SELECT set_config('lock_timeout','2s',TRUE),set_config('statement_timeout','10s',TRUE)");
        await tx.query('SELECT pg_advisory_xact_lock_shared(1396788563, 46)');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [saasAdvisoryKey.tenant(tenantId)]);
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [saasAdvisoryKey.user(userId)]);
        const auth = (await tx.query<{ id: string; privileged: boolean }>(`SELECT s.id,
            t.status='active' AND m.status='active' AND m.role IN('owner','admin') AS privileged
          FROM saas_sessions s JOIN saas_users u ON u.id=s.user_id
          JOIN saas_memberships m ON m.user_id=u.id AND m.tenant_id=$1::uuid JOIN saas_tenants t ON t.id=m.tenant_id
          WHERE s.token_hash=$2 AND s.user_id=$3::uuid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
          FOR SHARE OF s`, [tenantId, tokenHash, userId])).rows;
        if (auth.length !== 1 || !auth[0] || !UUID.test(auth[0].id)) refuse('UNAUTHENTICATED');
        if (auth[0].privileged !== true) refuse('FORBIDDEN');

        // Replay is read-only even when the job advanced/cancelled or the live
        // catalog changed. Fresh actor auth still applies; no authority enable.
        const prior = await persisted(tx, tenantId, command.idempotencyKey, command.requestId);
        if (prior.length > 0) {
          const original = prior[0];
          if (prior.length !== 1 || !original || original.tenant_id !== tenantId || original.actor_user_id !== userId ||
            original.job_id !== command.jobId || original.idempotency_key !== command.idempotencyKey || original.request_id !== command.requestId ||
            original.request_digest !== credentialValidationRequeueRequestDigest(tenantId, userId, command, hash(original.target_evidence_sha256))) refuse('IDEMPOTENCY_CONFLICT');
          return receipt(original, true);
        }
        const refs = (await tx.query<{ account_id: string; credential_id: string; credential_version: number | string }>(
          `SELECT account_id,credential_id,credential_version FROM saas_tenant_provider_credential_validation_jobs
            WHERE id=$1::uuid AND tenant_id=$2::uuid`, [command.jobId, tenantId])).rows;
        const ref = refs[0]; if (refs.length !== 1 || !ref) refuse('STATE_CONFLICT');
        // Exact workerAuthorityLockLayers, after tenant above; NO job row lock.
        for (const key of [saasAdvisoryKey.tenantProviderAccount(tenantId, text(ref.account_id)),
          saasAdvisoryKey.tenantProviderCredential(tenantId, text(ref.credential_id)),
          saasAdvisoryKey.credentialVersion('tenant', tenantId, text(ref.credential_id), integer(ref.credential_version, 1))]) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
        }
        const rows = (await tx.query<Record<string, unknown>>(`SELECT ${JOB_READ}
          FROM saas_tenant_provider_credential_validation_jobs WHERE id=$1::uuid AND tenant_id=$2::uuid`, [command.jobId, tenantId])).rows;
        if (rows.length !== 1 || !rows[0]) refuse('STATE_CONFLICT');
        const current = job(rows[0]);
        if (current.leaseGeneration !== command.expectedLeaseGeneration || credentialValidationJobSnapshotSha256(current) !== command.expectedSnapshotSha256) refuse('STATE_CONFLICT');
        const authority = (await tx.query<{ authz_version: number | string; protocol: string; evidence_sha256: string; checked_time: Date | string }>(
          `SELECT credential.authz_version,capability.protocol,capability.evidence_sha256,clock_timestamp() AS checked_time
           FROM saas_tenant_provider_accounts account JOIN saas_tenant_provider_credentials credential
             ON credential.tenant_id=account.tenant_id AND credential.account_id=account.id
             AND credential.provider_id=account.provider_id AND credential.product_id=account.product_id
           JOIN saas_tenant_provider_credential_versions version ON version.tenant_id=credential.tenant_id
             AND version.account_id=credential.account_id AND version.credential_id=credential.id AND version.version=credential.current_version
           JOIN saas_provider_products product ON product.provider_id=account.provider_id AND product.product_id=account.product_id
           JOIN saas_provider_rights rights ON rights.rights_id=account.rights_id AND rights.version=account.rights_version
           JOIN saas_tenant_provider_account_capabilities binding ON binding.tenant_id=account.tenant_id AND binding.account_id=account.id
             AND binding.provider_id=account.provider_id AND binding.product_id=account.product_id
           JOIN saas_provider_capabilities capability ON capability.provider_id=binding.provider_id AND capability.product_id=binding.product_id
             AND capability.model=binding.model AND capability.endpoint=binding.endpoint AND capability.version=binding.capability_version
           WHERE account.tenant_id=$1::uuid AND account.id=$2 AND credential.id=$3 AND credential.current_version=$4
             AND account.provider_id=$5 AND account.product_id=$6 AND account.credential_type=$7 AND account.supply_mode='byok'
             AND credential.credential_type=$7 AND account.status IN('pending','active') AND credential.status IN('pending','active')
             AND (credential.expires_at IS NULL OR credential.expires_at>clock_timestamp()) AND version.status='active'
             AND (version.expires_at IS NULL OR version.expires_at>clock_timestamp()) AND product.status='active'
             AND binding.model=$8 AND binding.endpoint=$9 AND binding.capability_version=$10
             AND capability.support_level='supported' AND capability.validation_state='verified'
             AND NOT EXISTS(SELECT 1 FROM saas_provider_capabilities newer WHERE newer.provider_id=capability.provider_id
               AND newer.product_id=capability.product_id AND newer.model=capability.model AND newer.endpoint=capability.endpoint AND newer.version>capability.version)
             AND rights.provider_id=account.provider_id AND rights.product_id=account.product_id AND rights.credential_type=$7
             AND rights.supply_mode='byok' AND rights.region=account.region AND rights.purpose=account.purpose AND rights.status='active'
             AND rights.effective_at<=clock_timestamp() AND (rights.expires_at IS NULL OR rights.expires_at>clock_timestamp())
             AND rights.model_scope @> ARRAY[$8]::text[] AND rights.endpoint_scope @> ARRAY[$9]::text[]
             AND NOT EXISTS(SELECT 1 FROM saas_provider_rights newer WHERE newer.rights_id=rights.rights_id AND newer.version>rights.version)`,
          [tenantId, current.accountId, current.credentialId, current.credentialVersion, current.providerId, current.productId,
            current.credentialType, current.target.model, current.target.endpoint, current.target.version])).rows;
        if (authority.length !== 1 || !authority[0]) refuse('TARGET_NOT_AUTHORIZED');
        const evidence = authority[0];
        if (integer(evidence.authz_version, 1) !== command.expectedCredentialAuthzVersion) refuse('STATE_CONFLICT');
        const dbNow = Date.parse(timestamp(evidence.checked_time));
        const custom = this.approvedTargets ? resolveApprovedCredentialValidationTarget(this.approvedTargets, current, dbNow) : null;
        if (current.providerId === 'custom' && (!custom || custom.evidenceSha256 !== evidence.evidence_sha256)) refuse('TARGET_NOT_AUTHORIZED');
        const capability: CredentialValidationRequeueCapabilityEvidence = { providerId: current.providerId, productId: current.productId,
          model: current.target.model, endpoint: current.target.endpoint, capabilityVersion: current.target.version,
          protocol: text(evidence.protocol), evidenceSha256: hash(evidence.evidence_sha256) };
        try { prepareCredentialValidationRequeue(current, { jobId: command.jobId, expectedLeaseGeneration: command.expectedLeaseGeneration,
          expectedSnapshotSha256: command.expectedSnapshotSha256, idempotencyKey: command.idempotencyKey,
          actorUserId: userId, requestId: command.requestId, reasonCode: command.reasonCode }, capability, this.approvedTargets); }
        catch { refuse('TARGET_NOT_AUTHORIZED'); }
        const commandDigest = credentialValidationRequeueRequestDigest(tenantId, userId, command, capability.evidenceSha256);
        const inserted = await tx.query<{ id: string }>(`INSERT INTO saas_credential_validation_requeue_requests
          (${REQUEUE_REQUEST_INSERT_COLUMNS.join(',')}) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::bigint,$10::bigint,$11,$12,$13)
          RETURNING id`, [randomUUID(), tenantId, userId, auth[0].id, command.jobId, command.idempotencyKey, commandDigest,
          command.requestId, command.expectedCredentialAuthzVersion, command.expectedLeaseGeneration, command.expectedSnapshotSha256, command.reasonCode, command.reason]);
        if (inserted.rowCount !== 1 || inserted.rows.length !== 1) refuse('STORAGE_UNAVAILABLE');
        // Catalog locks can wait across a runtime approval deadline. If crossed,
        // rollback the REAL trigger writes, never extend the approved target.
        if (custom?.expiresAt !== null && custom?.expiresAt !== undefined) {
          const now = (await tx.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')).rows[0]?.now;
          if (Date.parse(timestamp(now)) >= Date.parse(custom.expiresAt)) refuse('TARGET_NOT_AUTHORIZED');
        }
        const stored = await persisted(tx, tenantId, command.idempotencyKey, command.requestId);
        if (stored.length !== 1 || !stored[0] || stored[0].id !== inserted.rows[0]?.id || stored[0].request_digest !== commandDigest) refuse('STORAGE_UNAVAILABLE');
        return receipt(stored[0], false);
      });
    } catch (error) { storageFailure(error); }
  }
}
