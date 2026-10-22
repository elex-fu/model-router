import { createHash } from 'node:crypto';
import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import {
  PLATFORM_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION,
  PLATFORM_VALIDATION_REQUEUE_WRITER_SOURCE,
} from '../db/migrations/137_platform_credential_validation_requeue.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { PlatformAdminActor } from './access/types.js';

export const PLATFORM_VALIDATION_REQUEUE_INSERT_COLUMNS = [
  'actor_user_id',
  'actor_session_id',
  'account_id',
  'credential_id',
  'job_id',
  'expected_credential_version',
  'expected_credential_authz_version',
  'expected_lease_generation',
  'idempotency_key',
  'request_id',
  'reason',
] as const;
export const PLATFORM_VALIDATION_REQUEUE_READ_COLUMNS = [
  ...PLATFORM_VALIDATION_REQUEUE_INSERT_COLUMNS.filter((column) => column !== 'actor_session_id'),
  'id',
  'audit_event_id',
  'request_digest',
  'result_lease_generation',
  'recorded_at',
] as const;

export interface PlatformValidationRequeueStatus {
  readonly state: 'ready' | 'not_eligible';
  readonly jobId: string | null;
  readonly credentialVersion: number | null;
  readonly credentialAuthzVersion: number | null;
  readonly leaseGeneration: number | null;
}

export interface PlatformValidationRequeueCommand {
  readonly accountId: string;
  readonly credentialId: string;
  readonly jobId: string;
  readonly expectedCredentialVersion: number;
  readonly expectedCredentialAuthzVersion: number;
  readonly expectedLeaseGeneration: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly reason: string;
}

export interface PlatformValidationRequeueReceipt {
  readonly outcome: 'queued';
  readonly jobId: string;
  readonly credentialVersion: number;
  readonly leaseGeneration: number;
  readonly auditEventId: string;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

export interface PlatformCredentialValidationRequeueOperations {
  getStatus(
    actor: PlatformAdminActor,
    accountId: string,
    credentialId: string,
  ): Promise<PlatformValidationRequeueStatus>;
  requeue(
    actor: PlatformAdminActor,
    command: PlatformValidationRequeueCommand,
  ): Promise<PlatformValidationRequeueReceipt>;
}

export class PlatformValidationRequeueError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'STATE_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TARGET_NOT_AUTHORIZED'
      | 'SCHEMA_NOT_READY'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super('Platform credential validation retry is unavailable');
    this.name = 'PlatformValidationRequeueError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    [...value].every((character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f)
  );
}
const STATUS_SQL = `SELECT job.id AS job_id,credential.current_version,credential.authz_version,
  job.lease_generation,
  account.status='pending' AND account.validation_state='failed'
    AND credential.status='pending' AND credential.validation_state='failed'
    AND job.status='failed' AND job.last_error_code='provider_response_too_large'
    AND job.completed_at IS NOT NULL AND job.lease_until IS NULL
    AND account.provider_id='kimi' AND account.product_id IN('kimi-code','kimi-code-global')
    AND account.credential_type='api-key' AND job.target_endpoint='messages' AS eligible
  FROM saas_platform_provider_accounts account
  JOIN saas_platform_provider_credentials credential ON credential.account_id=account.id
  JOIN saas_platform_provider_credential_validation_jobs job ON job.account_id=account.id
    AND job.credential_id=credential.id AND job.credential_version=credential.current_version
  WHERE account.id=$1 AND credential.id=$2`;
const ACTOR_SQL = `SELECT EXISTS(SELECT 1 FROM saas_platform_sessions s
  JOIN saas_users u ON u.id=s.user_id
  JOIN saas_mfa_credentials m ON m.id=s.credential_id AND m.user_id=s.user_id
  WHERE s.id=$1::uuid AND s.user_id=$2::uuid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND u.disabled_at IS NULL AND u.anonymized_at IS NULL AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM saas_platform_role_assignments r WHERE r.user_id=u.id
      AND r.role IN('superadmin','operations'))) AS authorized`;

function refuse(code: PlatformValidationRequeueError['code']): never {
  throw new PlatformValidationRequeueError(code);
}

function integer(value: unknown, minimum = 0): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) refuse('STORAGE_UNAVAILABLE');
  return parsed;
}

function normalize(input: PlatformValidationRequeueCommand): PlatformValidationRequeueCommand {
  const keys = [
    'accountId',
    'credentialId',
    'jobId',
    'expectedCredentialVersion',
    'expectedCredentialAuthzVersion',
    'expectedLeaseGeneration',
    'idempotencyKey',
    'requestId',
    'reason',
  ];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    typeof input.accountId !== 'string' ||
    !validId(input.accountId) ||
    typeof input.credentialId !== 'string' ||
    !validId(input.credentialId) ||
    !UUID.test(input.jobId) ||
    !Number.isSafeInteger(input.expectedCredentialVersion) ||
    input.expectedCredentialVersion < 1 ||
    input.expectedCredentialVersion > 2_147_483_647 ||
    !Number.isSafeInteger(input.expectedCredentialAuthzVersion) ||
    input.expectedCredentialAuthzVersion < 1 ||
    !Number.isSafeInteger(input.expectedLeaseGeneration) ||
    input.expectedLeaseGeneration < 0 ||
    input.expectedLeaseGeneration >= Number.MAX_SAFE_INTEGER ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) ||
    typeof input.requestId !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(input.requestId) ||
    typeof input.reason !== 'string' ||
    input.reason.length < 1 ||
    input.reason.length > 512 ||
    [...input.reason].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) ||
    input.reason.trim() !== input.reason
  )
    refuse('INVALID_INPUT');
  return Object.freeze({ ...input });
}

function status(row: Record<string, unknown> | undefined): PlatformValidationRequeueStatus {
  if (!row)
    return {
      state: 'not_eligible',
      jobId: null,
      credentialVersion: null,
      credentialAuthzVersion: null,
      leaseGeneration: null,
    };
  if (typeof row.job_id !== 'string' || !UUID.test(row.job_id)) refuse('STORAGE_UNAVAILABLE');
  return {
    state: row.eligible === true ? 'ready' : 'not_eligible',
    jobId: row.job_id,
    credentialVersion: integer(row.current_version, 1),
    credentialAuthzVersion: integer(row.authz_version, 1),
    leaseGeneration: integer(row.lease_generation),
  };
}

function receipt(row: Record<string, unknown>, replayed: boolean): PlatformValidationRequeueReceipt {
  if (
    typeof row.job_id !== 'string' ||
    !UUID.test(row.job_id) ||
    typeof row.audit_event_id !== 'string' ||
    !UUID.test(row.audit_event_id)
  )
    refuse('STORAGE_UNAVAILABLE');
  const date =
    row.recorded_at instanceof Date
      ? row.recorded_at
      : typeof row.recorded_at === 'string'
        ? new Date(row.recorded_at)
        : null;
  if (!date || !Number.isFinite(date.getTime())) refuse('STORAGE_UNAVAILABLE');
  return {
    outcome: 'queued',
    jobId: row.job_id,
    credentialVersion: integer(row.expected_credential_version, 1),
    leaseGeneration: integer(row.result_lease_generation, 1),
    auditEventId: row.audit_event_id,
    recordedAt: date.toISOString(),
    replayed,
  };
}

/** No secret access, target mutation or unaudited job UPDATE is exposed here. */
export class PlatformCredentialValidationRequeueService implements PlatformCredentialValidationRequeueOperations {
  constructor(private readonly database: SaasDatabase) {}

  private async transaction<T>(actor: PlatformAdminActor, run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (!actor || !UUID.test(actor.userId) || !UUID.test(actor.sessionId)) refuse('UNAUTHENTICATED');
    if (!Array.isArray(actor.roles) || !actor.roles.some((role) => role === 'superadmin' || role === 'operations'))
      refuse('FORBIDDEN');
    try {
      await this.database.verifySchema();
      return await this.database.transaction(async (tx) => {
        await tx.query("SELECT set_config('lock_timeout','2s',TRUE),set_config('statement_timeout','10s',TRUE)");
        await tx.query('SELECT pg_advisory_xact_lock_shared(1396788563,46)');
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,0))', [
          saasAdvisoryKey.user(actor.userId),
        ]);
        if (
          (await tx.query<{ authorized: boolean }>(ACTOR_SQL, [actor.sessionId, actor.userId])).rows[0]?.authorized !==
          true
        )
          refuse('FORBIDDEN');
        return run(tx);
      });
    } catch (error) {
      if (error instanceof PlatformValidationRequeueError) throw error;
      const constraint = error && typeof error === 'object' && 'constraint' in error ? error.constraint : null;
      if (constraint === 'saas_platform_requeue_actor') refuse('FORBIDDEN');
      if (constraint === 'saas_platform_requeue_state') refuse('STATE_CONFLICT');
      if (constraint === 'saas_platform_requeue_authority') refuse('TARGET_NOT_AUTHORIZED');
      if (constraint === 'saas_platform_requeue_identity') refuse('IDEMPOTENCY_CONFLICT');
      refuse('STORAGE_UNAVAILABLE');
    }
  }

  async getStatus(
    actor: PlatformAdminActor,
    accountId: string,
    credentialId: string,
  ): Promise<PlatformValidationRequeueStatus> {
    if (
      typeof accountId !== 'string' ||
      !validId(accountId) ||
      typeof credentialId !== 'string' ||
      !validId(credentialId)
    )
      refuse('INVALID_INPUT');
    return this.transaction(actor, async (tx) =>
      status((await tx.query<Record<string, unknown>>(STATUS_SQL, [accountId, credentialId])).rows[0]),
    );
  }

  async requeue(
    actor: PlatformAdminActor,
    input: PlatformValidationRequeueCommand,
  ): Promise<PlatformValidationRequeueReceipt> {
    const command = normalize(input);
    return this.transaction(actor, async (tx) => {
      const migration = PLATFORM_CREDENTIAL_VALIDATION_REQUEUE_SAAS_MIGRATION;
      const checksum = createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
      const ready = await tx.query<{ ready: boolean }>(
        `SELECT
        current_user='model_router_saas_control_plane' AND session_user=current_user
        AND current_setting('transaction_isolation')='read committed'
        AND EXISTS(SELECT 1 FROM saas_schema_migrations WHERE version=137 AND name=$1 AND checksum=$2)
        AND NOT has_any_column_privilege(current_user,'saas_platform_provider_credential_validation_jobs','UPDATE')
        AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('model_router_saas.saas_platform_credential_validation_requeue_insert()')
          AND p.proowner='model_router_saas_migrator'::regrole AND p.prosecdef AND p.prosrc=$3
          AND p.proconfig=ARRAY['search_path=pg_catalog, model_router_saas, pg_temp']
          AND NOT has_function_privilege(current_user,p.oid,'EXECUTE')) AS ready`,
        [migration.name, checksum, PLATFORM_VALIDATION_REQUEUE_WRITER_SOURCE],
      );
      if (ready.rows[0]?.ready !== true) refuse('SCHEMA_NOT_READY');
      for (const key of [
        saasAdvisoryKey.platformProviderAccount(command.accountId),
        saasAdvisoryKey.platformProviderCredential(command.credentialId),
        saasAdvisoryKey.credentialVersion(
          'platform',
          command.accountId,
          command.credentialId,
          command.expectedCredentialVersion,
        ),
      ]) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [key]);
      }
      const prior = (
        await tx.query<Record<string, unknown>>(
          `SELECT ${PLATFORM_VALIDATION_REQUEUE_READ_COLUMNS.join(',')}
        FROM saas_platform_credential_validation_requeue_requests WHERE actor_user_id=$1::uuid AND idempotency_key=$2`,
          [actor.userId, command.idempotencyKey],
        )
      ).rows;
      if (prior.length) {
        const row = prior[0];
        if (
          prior.length !== 1 ||
          !row ||
          row.account_id !== command.accountId ||
          row.credential_id !== command.credentialId ||
          row.job_id !== command.jobId ||
          integer(row.expected_credential_version, 1) !== command.expectedCredentialVersion ||
          integer(row.expected_credential_authz_version, 1) !== command.expectedCredentialAuthzVersion ||
          integer(row.expected_lease_generation) !== command.expectedLeaseGeneration ||
          row.reason !== command.reason
        )
          refuse('IDEMPOTENCY_CONFLICT');
        return receipt(row, true);
      }
      const current = status(
        (await tx.query<Record<string, unknown>>(STATUS_SQL, [command.accountId, command.credentialId])).rows[0],
      );
      if (
        current.state !== 'ready' ||
        current.jobId !== command.jobId ||
        current.credentialVersion !== command.expectedCredentialVersion ||
        current.credentialAuthzVersion !== command.expectedCredentialAuthzVersion ||
        current.leaseGeneration !== command.expectedLeaseGeneration
      )
        refuse('STATE_CONFLICT');
      const inserted = await tx.query<Record<string, unknown>>(
        `INSERT INTO saas_platform_credential_validation_requeue_requests
        (${PLATFORM_VALIDATION_REQUEUE_INSERT_COLUMNS.join(',')}) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11)
        RETURNING ${PLATFORM_VALIDATION_REQUEUE_READ_COLUMNS.join(',')}`,
        [
          actor.userId,
          actor.sessionId,
          command.accountId,
          command.credentialId,
          command.jobId,
          command.expectedCredentialVersion,
          command.expectedCredentialAuthzVersion,
          command.expectedLeaseGeneration,
          command.idempotencyKey,
          command.requestId,
          command.reason,
        ],
      );
      if (inserted.rows.length !== 1 || !inserted.rows[0]) refuse('STORAGE_UNAVAILABLE');
      return receipt(inserted.rows[0], false);
    });
  }
}
