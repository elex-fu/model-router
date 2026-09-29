import {
  createProviderCredentialContext,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialUnsealingKms,
  withUnsealedProviderCredential,
} from '../credentials/provider-crypto.js';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import {
  credentialValidationCapabilityProtocol,
  isSupportedCredentialValidationTarget,
  type ProviderCredentialValidationErrorCode,
  type ProviderCredentialValidationFetch,
  type ProviderCredentialValidationResult,
  validateProviderCredential,
} from './credential-validation-adapters.js';
import type { ProviderCredentialValidationJobRecord, ProviderCredentialValidationJobState } from './types.js';

export const CREDENTIAL_VALIDATION_LEASE_TTL_MS = 30_000;
export const CREDENTIAL_VALIDATION_MAX_ATTEMPTS = 5;
export const CREDENTIAL_VALIDATION_POLL_INTERVAL_MS = 1_000;
export const CREDENTIAL_VALIDATION_RETRY_BASE_MS = 1_000;
export const CREDENTIAL_VALIDATION_RETRY_MAX_MS = 60_000;

export interface CredentialValidationLease {
  readonly job: ProviderCredentialValidationJobRecord;
  /** Monotonically increasing database generation; every mutation must present it. */
  readonly fencingToken: number;
}

export type CredentialValidationWorkerResult = 'idle' | 'processed' | 'stale';

export type CredentialValidationWorkerErrorCode = 'STORE_UNAVAILABLE' | 'LEASE_LOST';

export class CredentialValidationWorkerError extends Error {
  constructor(readonly code: CredentialValidationWorkerErrorCode) {
    super(
      code === 'LEASE_LOST'
        ? 'Credential validation lease is no longer current'
        : 'Credential validation store is unavailable',
    );
    this.name = 'CredentialValidationWorkerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ValidationJobRow {
  id: string;
  tenant_id: string;
  account_id: string;
  credential_id: string;
  credential_version: number | string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  allowed_models: string[];
  target_model: string;
  target_endpoint: string;
  capability_version: number | string;
  idempotency_key: string;
  status: string;
  attempt_count: number | string;
  available_at: string | Date;
  lease_until: string | Date | null;
  lease_generation: number | string;
  last_error_code: string | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface LockedAccountRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  region: string;
  purpose: string;
  rights_id: string;
  rights_version: number | string;
  status: string;
  validation_state: string;
  authz_version: number | string;
}

interface LockedCredentialRow {
  id: string;
  tenant_id: string;
  account_id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  status: string;
  validation_state: string;
  current_version: number | string | null;
  expires_at: string | Date | null;
  authz_version: number | string;
}

interface LockedVersionRow {
  tenant_id: string;
  account_id: string;
  credential_id: string;
  version: number | string;
  status: string;
  schema_version: number | string;
  context_version: number | string;
  algorithm: string;
  kms_purpose: string;
  kms_key_id: string;
  wrapping_revision: number | string;
  wrapped_dek: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  expires_at: string | Date | null;
}

const JOB_COLUMNS = `id, tenant_id, account_id, credential_id, credential_version,
  provider_id, product_id, credential_type, allowed_models, target_model, target_endpoint,
  capability_version, idempotency_key, status, attempt_count, available_at, lease_until,
  lease_generation, last_error_code, completed_at, created_at, updated_at`;

function workerError(code: CredentialValidationWorkerErrorCode): CredentialValidationWorkerError {
  return new CredentialValidationWorkerError(code);
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    throw workerError('STORE_UNAVAILABLE');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw workerError('STORE_UNAVAILABLE');
  return result;
}

function nonnegativeInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw workerError('STORE_UNAVAILABLE');
  return result;
}

function safeTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw workerError('STORE_UNAVAILABLE');
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : safeTimestamp(value);
}

function jobState(value: unknown): ProviderCredentialValidationJobState {
  if (value === 'queued' || value === 'leased' || value === 'verified' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw workerError('STORE_UNAVAILABLE');
}

function mapJob(row: ValidationJobRow): ProviderCredentialValidationJobRecord {
  if (!Array.isArray(row.allowed_models) || row.allowed_models.length === 0) throw workerError('STORE_UNAVAILABLE');
  return {
    id: safeText(row.id),
    tenantId: safeText(row.tenant_id),
    accountId: safeText(row.account_id),
    credentialId: safeText(row.credential_id),
    credentialVersion: positiveInteger(row.credential_version),
    providerId: safeText(row.provider_id),
    productId: safeText(row.product_id),
    credentialType: safeText(row.credential_type),
    allowedModels: row.allowed_models.map(safeText),
    target: {
      model: safeText(row.target_model),
      endpoint: safeText(row.target_endpoint),
      version: positiveInteger(row.capability_version),
    },
    idempotencyKey: safeText(row.idempotency_key),
    state: jobState(row.status),
    attemptCount: nonnegativeInteger(row.attempt_count),
    availableAt: safeTimestamp(row.available_at),
    leaseUntil: nullableTimestamp(row.lease_until),
    leaseGeneration: nonnegativeInteger(row.lease_generation),
    lastErrorCode: row.last_error_code === null ? null : safeText(row.last_error_code),
    completedAt: nullableTimestamp(row.completed_at),
    createdAt: safeTimestamp(row.created_at),
    updatedAt: safeTimestamp(row.updated_at),
  };
}

function queryRows<Row>(executor: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
  return executor.query<Row>(sql, values);
}

function leaseLost(): never {
  throw workerError('LEASE_LOST');
}

function errorCode(value: ProviderCredentialValidationResult): ProviderCredentialValidationErrorCode | null {
  return value.state === 'failed' ? value.errorCode : null;
}

async function lockAdvisoryLayers(
  executor: SqlExecutor,
  layers: readonly (readonly string[])[],
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const functionName = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  for (const layer of layers) {
    for (const key of sortAndDedupeAdvisoryKeys(layer)) {
      await executor.query(`SELECT ${functionName}(hashtextextended($1::text, 0))`, [key]);
    }
  }
}

function workerAuthorityLockLayers(
  job: Pick<ProviderCredentialValidationJobRecord, 'tenantId' | 'accountId' | 'credentialId' | 'credentialVersion'>,
): readonly (readonly string[])[] {
  return [
    [saasAdvisoryKey.tenant(job.tenantId)],
    [saasAdvisoryKey.tenantProviderAccount(job.tenantId, job.accountId)],
    [saasAdvisoryKey.tenantProviderCredential(job.tenantId, job.credentialId)],
    [saasAdvisoryKey.credentialVersion('tenant', job.tenantId, job.credentialId, job.credentialVersion)],
  ];
}

export interface PostgresCredentialValidationWorkerOptions {
  readonly leaseTtlMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly deployment: string;
  readonly environment: string;
}

/**
 * PostgreSQL queue operations use DB time for every eligibility, lease and
 * completion decision. Envelopes can only be read through a live fenced lease.
 */
export class PostgresCredentialValidationWorkerStore {
  private readonly leaseTtlMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly consumedLeases = new WeakSet<object>();

  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: PostgresCredentialValidationWorkerOptions,
  ) {
    this.leaseTtlMs = positiveBound(options.leaseTtlMs ?? CREDENTIAL_VALIDATION_LEASE_TTL_MS, 1_000, 120_000);
    this.maxAttempts = positiveBound(options.maxAttempts ?? CREDENTIAL_VALIDATION_MAX_ATTEMPTS, 1, 20);
    this.retryBaseMs = positiveBound(options.retryBaseMs ?? CREDENTIAL_VALIDATION_RETRY_BASE_MS, 100, 60_000);
    this.retryMaxMs = positiveBound(
      options.retryMaxMs ?? CREDENTIAL_VALIDATION_RETRY_MAX_MS,
      this.retryBaseMs,
      300_000,
    );
    safeText(options.deployment);
    safeText(options.environment);
  }

  private async safeTransaction<T>(work: (executor: SqlExecutor) => Promise<T>, serializable = false): Promise<T> {
    try {
      return await this.database.transaction(async (tx) => {
        if (serializable) await queryRows(tx, 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        return work(tx);
      });
    } catch (error) {
      if (error instanceof CredentialValidationWorkerError) throw error;
      throw workerError('STORE_UNAVAILABLE');
    }
  }

  async claimNext(): Promise<CredentialValidationLease | null> {
    return this.safeTransaction(async (tx) => {
      const candidates = await queryRows<{
        id: string;
        tenant_id: string;
        account_id: string;
        credential_id: string;
        credential_version: number | string;
      }>(
        tx,
        `SELECT id, tenant_id, account_id, credential_id, credential_version
           FROM saas_tenant_provider_credential_validation_jobs
          WHERE (status = 'queued' AND available_at <= clock_timestamp())
             OR (status = 'leased' AND lease_until <= clock_timestamp())
          ORDER BY available_at, created_at, id
          LIMIT 1`,
      );
      const candidate = candidates.rows[0];
      if (!candidate) return null;
      const candidateReference = {
        tenantId: safeText(candidate.tenant_id),
        accountId: safeText(candidate.account_id),
        credentialId: safeText(candidate.credential_id),
        credentialVersion: positiveInteger(candidate.credential_version),
      };
      await lockAdvisoryLayers(tx, workerAuthorityLockLayers(candidateReference), 'exclusive');

      const lockedRows = await queryRows<ValidationJobRow>(
        tx,
        `SELECT ${JOB_COLUMNS}
           FROM saas_tenant_provider_credential_validation_jobs
          WHERE id = $1
            AND ((status = 'queued' AND available_at <= clock_timestamp())
              OR (status = 'leased' AND lease_until <= clock_timestamp()))
          FOR UPDATE`,
        [candidate.id],
      );
      const lockedRow = lockedRows.rows[0];
      if (!lockedRow) return null;
      const lockedJob = mapJob(lockedRow);
      if (lockedJob.attemptCount >= this.maxAttempts) {
        await queryRows(
          tx,
          `UPDATE saas_tenant_provider_credential_validation_jobs
              SET status = 'failed', lease_until = NULL,
                  lease_generation = lease_generation + 1,
                  last_error_code = 'attempt_limit', completed_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [lockedJob.id],
        );
        return null;
      }

      const currentAuthority = await queryRows<{ id: string }>(
        tx,
        `SELECT job.id
           FROM saas_tenant_provider_credential_validation_jobs AS job
           JOIN saas_tenant_provider_credentials AS credential
             ON credential.tenant_id = job.tenant_id
            AND credential.id = job.credential_id
           JOIN saas_tenant_provider_accounts AS account
             ON account.tenant_id = credential.tenant_id
            AND account.id = credential.account_id
            AND account.provider_id = credential.provider_id
            AND account.product_id = credential.product_id
           JOIN saas_tenant_provider_credential_versions AS version
             ON version.tenant_id = credential.tenant_id
            AND version.account_id = credential.account_id
            AND version.credential_id = credential.id
            AND version.version = job.credential_version
          WHERE job.id = $1
            AND credential.tenant_id = job.tenant_id
            AND credential.account_id = job.account_id
            AND credential.provider_id = job.provider_id
            AND credential.product_id = job.product_id
            AND credential.credential_type = job.credential_type
            AND credential.current_version = job.credential_version
            AND credential.status IN ('pending', 'active')
            AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            AND account.status IN ('pending', 'active')
            AND version.status = 'active'
            AND (version.expires_at IS NULL OR version.expires_at > clock_timestamp())`,
        [lockedJob.id],
      );
      if (currentAuthority.rows.length !== 1) {
        await queryRows(
          tx,
          `UPDATE saas_tenant_provider_credential_validation_jobs
              SET status = 'cancelled', lease_until = NULL,
                  lease_generation = lease_generation + 1,
                  last_error_code = 'credential_changed',
                  completed_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1`,
          [lockedJob.id],
        );
        return null;
      }

      const claimed = await queryRows<ValidationJobRow>(
        tx,
        `UPDATE saas_tenant_provider_credential_validation_jobs
            SET status = 'leased', attempt_count = attempt_count + 1,
                lease_generation = lease_generation + 1,
                lease_until = clock_timestamp() + ($2 * interval '1 millisecond'),
                last_error_code = NULL, completed_at = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1
         RETURNING ${JOB_COLUMNS}`,
        [lockedJob.id, this.leaseTtlMs],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      const job = mapJob(row);
      return Object.freeze({ job, fencingToken: job.leaseGeneration });
    });
  }

  private async lockCurrentAuthority(
    tx: SqlExecutor,
    lease: CredentialValidationLease,
    requireSupportedCapability = false,
  ): Promise<{
    account: LockedAccountRow;
    credential: LockedCredentialRow;
    version: LockedVersionRow;
  } | null> {
    const job = lease.job;
    await lockAdvisoryLayers(tx, workerAuthorityLockLayers(job), 'exclusive');
    const expectedProtocol = credentialValidationCapabilityProtocol(job);
    if (requireSupportedCapability && expectedProtocol === null) return null;
    const accounts = await queryRows<LockedAccountRow>(
      tx,
      `SELECT id, tenant_id, provider_id, product_id, credential_type, purpose,
              region, rights_id, rights_version, status, validation_state, authz_version
         FROM saas_tenant_provider_accounts
        WHERE tenant_id = $1 AND id = $2 AND provider_id = $3 AND product_id = $4
        FOR UPDATE`,
      [job.tenantId, job.accountId, job.providerId, job.productId],
    );
    const account = accounts.rows[0];
    if (!account || !['pending', 'active'].includes(account.status) || account.credential_type !== job.credentialType) {
      return null;
    }
    if (!job.allowedModels.includes(job.target.model)) return null;

    const credentials = await queryRows<LockedCredentialRow>(
      tx,
      `SELECT id, tenant_id, account_id, provider_id, product_id, credential_type,
              status, validation_state, current_version, expires_at, authz_version
         FROM saas_tenant_provider_credentials
        WHERE tenant_id = $1 AND id = $2 AND account_id = $3
          AND provider_id = $4 AND product_id = $5 AND credential_type = $6
          AND current_version = $7
          AND status IN ('pending', 'active')
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        FOR UPDATE`,
      [
        job.tenantId,
        job.credentialId,
        job.accountId,
        job.providerId,
        job.productId,
        job.credentialType,
        job.credentialVersion,
      ],
    );
    const credential = credentials.rows[0];
    if (!credential) return null;

    const rights = await queryRows<{ rights_id: string }>(
      tx,
      `SELECT rights.rights_id
         FROM saas_provider_products AS product
         JOIN saas_provider_rights AS rights
           ON rights.provider_id = product.provider_id
          AND rights.product_id = product.product_id
        WHERE product.provider_id = $1 AND product.product_id = $2
          AND product.status = 'active'
          AND rights.rights_id = $3 AND rights.version = $4
          AND rights.provider_id = $1 AND rights.product_id = $2
          AND rights.credential_type = $5 AND rights.supply_mode = 'byok'
          AND rights.region = $6 AND rights.purpose = $7
          AND rights.status = 'active'
          AND rights.effective_at <= clock_timestamp()
          AND (rights.expires_at IS NULL OR rights.expires_at > clock_timestamp())
          AND rights.model_scope @> ARRAY[$8]::text[]
          AND rights.endpoint_scope @> ARRAY[$9]::text[]
          AND NOT EXISTS (
            SELECT 1 FROM saas_provider_rights AS newer
             WHERE newer.rights_id = rights.rights_id AND newer.version > rights.version
          )
        `,
      [
        job.providerId,
        job.productId,
        account.rights_id,
        positiveInteger(account.rights_version),
        job.credentialType,
        account.region,
        account.purpose,
        job.target.model,
        job.target.endpoint,
      ],
    );
    if (rights.rows.length !== 1) return null;

    if (expectedProtocol !== null) {
      const capabilities = await queryRows<{ version: number | string }>(
        tx,
        `SELECT capability.version
           FROM saas_provider_products AS product
           JOIN saas_tenant_provider_account_capabilities AS binding
             ON binding.provider_id = product.provider_id
            AND binding.product_id = product.product_id
           JOIN saas_provider_capabilities AS capability
             ON capability.provider_id = binding.provider_id
            AND capability.product_id = binding.product_id
            AND capability.model = binding.model
            AND capability.endpoint = binding.endpoint
            AND capability.version = binding.capability_version
          WHERE product.provider_id = $1 AND product.product_id = $2
            AND product.status = 'active'
            AND binding.tenant_id = $3 AND binding.account_id = $4
            AND binding.provider_id = $1 AND binding.product_id = $2
            AND binding.model = $5 AND binding.endpoint = $6
            AND binding.capability_version = $7
            AND capability.protocol = $8
            AND capability.support_level = 'supported'
            AND capability.validation_state = 'verified'
            AND NOT EXISTS (
              SELECT 1 FROM saas_provider_capabilities AS newer
               WHERE newer.provider_id = capability.provider_id
                 AND newer.product_id = capability.product_id
                 AND newer.model = capability.model
                 AND newer.endpoint = capability.endpoint
                 AND newer.version > capability.version
            )
          `,
        [
          job.providerId,
          job.productId,
          job.tenantId,
          job.accountId,
          job.target.model,
          job.target.endpoint,
          job.target.version,
          expectedProtocol,
        ],
      );
      if (capabilities.rows.length !== 1) return null;
    }

    const versions = await queryRows<LockedVersionRow>(
      tx,
      `SELECT version_row.tenant_id, version_row.account_id, version_row.credential_id,
              version_row.version, version_row.status, version_row.schema_version,
              version_row.context_version, version_row.algorithm, version_row.kms_purpose,
              COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
              COALESCE(wrapping.wrapping_revision, version_row.wrapping_revision) AS wrapping_revision,
              COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
              version_row.nonce, version_row.ciphertext, version_row.auth_tag, version_row.expires_at
         FROM saas_tenant_provider_credential_versions AS version_row
         LEFT JOIN LATERAL (
           SELECT kms_key_id, wrapping_revision, wrapped_dek
             FROM saas_tenant_provider_credential_wrappings
            WHERE tenant_id = version_row.tenant_id AND account_id = version_row.account_id
              AND credential_id = version_row.credential_id
              AND credential_version = version_row.version
            ORDER BY wrapping_revision DESC
            LIMIT 1
         ) AS wrapping ON TRUE
        WHERE version_row.tenant_id = $1 AND version_row.account_id = $2
          AND version_row.credential_id = $3 AND version_row.version = $4
          AND version_row.status = 'active'
          AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`,
      [job.tenantId, job.accountId, job.credentialId, job.credentialVersion],
    );
    const version = versions.rows[0];
    if (!version || version.kms_purpose !== account.purpose) return null;

    const jobs = await queryRows<{ id: string }>(
      tx,
      `SELECT id
         FROM saas_tenant_provider_credential_validation_jobs
        WHERE id = $1 AND tenant_id = $2 AND account_id = $3
          AND credential_id = $4 AND credential_version = $5
          AND status = 'leased' AND lease_generation = $6
          AND lease_until > clock_timestamp()
        FOR UPDATE`,
      [job.id, job.tenantId, job.accountId, job.credentialId, job.credentialVersion, lease.fencingToken],
    );
    if (jobs.rows.length !== 1) return null;

    return { account, credential, version };
  }

  async withCredential<T>(
    lease: CredentialValidationLease,
    callback: (secret: Buffer) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.consumedLeases.has(lease)) leaseLost();
    this.consumedLeases.add(lease);
    let secretForCallback: Buffer | undefined;
    try {
      const secret = await this.safeTransaction(async (tx) => {
        const authority = await this.lockCurrentAuthority(tx, lease, true);
        if (!authority) {
          await this.cancelLeaseForAuthorityChange(tx, lease);
          return null;
        }
        const { account, credential, version } = authority;
        if (
          positiveInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
          positiveInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
          version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
        ) {
          await this.cancelLeaseForAuthorityChange(tx, lease);
          return null;
        }
        const context: ProviderCredentialContext = createProviderCredentialContext({
          ownerKind: 'tenant',
          tenantId: account.tenant_id,
          supplyMode: 'byok',
          deployment: this.options.deployment,
          environment: this.options.environment,
          purpose: account.purpose,
          providerId: account.provider_id,
          productId: account.product_id,
          credentialType: account.credential_type,
          accountId: account.id,
          credentialId: credential.id,
          credentialVersion: positiveInteger(version.version),
        });
        const envelope: ProviderCredentialEnvelope = {
          schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
          contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
          algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
          kmsKeyId: safeText(version.kms_key_id),
          wrappedDek: safeText(version.wrapped_dek),
          nonce: safeText(version.nonce),
          ciphertext: safeText(version.ciphertext),
          authTag: safeText(version.auth_tag),
        };
        let copy: Buffer | undefined;
        await withUnsealedProviderCredential(envelope, context, this.kms, (plaintext) => {
          copy = Buffer.from(plaintext);
        });
        if (!copy) throw workerError('STORE_UNAVAILABLE');
        secretForCallback = copy;
        return copy;
      }, true);
      if (secret === null) leaseLost();
      return await callback(secret);
    } finally {
      secretForCallback?.fill(0);
    }
  }

  async recheckBeforeProviderRequest(lease: CredentialValidationLease): Promise<void> {
    const authorized = await this.safeTransaction(async (tx) => {
      if (await this.lockCurrentAuthority(tx, lease, true)) return true;
      await this.cancelLeaseForAuthorityChange(tx, lease);
      return false;
    }, true);
    if (!authorized) leaseLost();
  }

  private async cancelLeaseForAuthorityChange(tx: SqlExecutor, lease: CredentialValidationLease): Promise<void> {
    await queryRows(
      tx,
      `UPDATE saas_tenant_provider_credential_validation_jobs
          SET status = 'cancelled', lease_until = NULL,
              lease_generation = lease_generation + 1,
              last_error_code = 'authority_changed',
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'leased' AND lease_generation = $2
          AND lease_until > clock_timestamp()`,
      [lease.job.id, lease.fencingToken],
    );
  }

  private async lockLeaseForCompletion(
    tx: SqlExecutor,
    lease: CredentialValidationLease,
    requireSupportedCapability: boolean,
  ): Promise<boolean> {
    const authority = await this.lockCurrentAuthority(tx, lease, requireSupportedCapability);
    if (authority !== null) return true;
    await this.cancelLeaseForAuthorityChange(tx, lease);
    return false;
  }

  async complete(lease: CredentialValidationLease, result: ProviderCredentialValidationResult): Promise<boolean> {
    return this.safeTransaction(async (tx) => {
      if (!(await this.lockLeaseForCompletion(tx, lease, result.state === 'verified'))) return false;
      const terminalState = result.state === 'verified' ? 'verified' : 'failed';
      const resultErrorCode = errorCode(result);
      const terminal = result.state === 'verified' || !result.retryable || lease.job.attemptCount >= this.maxAttempts;
      const retryDelayMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, lease.job.attemptCount - 1));
      const jobUpdate = terminal
        ? await queryRows<{ id: string }>(
            tx,
            `UPDATE saas_tenant_provider_credential_validation_jobs
                SET status = $1, lease_until = NULL,
                    lease_generation = lease_generation + 1,
                    last_error_code = $2, completed_at = clock_timestamp(), updated_at = clock_timestamp()
              WHERE id = $3 AND status = 'leased' AND lease_generation = $4
                AND lease_until > clock_timestamp()
             RETURNING id`,
            [terminalState, resultErrorCode, lease.job.id, lease.fencingToken],
          )
        : await queryRows<{ id: string }>(
            tx,
            `UPDATE saas_tenant_provider_credential_validation_jobs
                SET status = 'queued', lease_until = NULL,
                    lease_generation = lease_generation + 1,
                    available_at = clock_timestamp() + ($1 * interval '1 millisecond'),
                    last_error_code = $2, completed_at = NULL, updated_at = clock_timestamp()
              WHERE id = $3 AND status = 'leased' AND lease_generation = $4
                AND lease_until > clock_timestamp()
             RETURNING id`,
            [retryDelayMs, resultErrorCode, lease.job.id, lease.fencingToken],
          );
      if (jobUpdate.rows.length !== 1) return false;

      if (result.state === 'verified') {
        await this.updateHealthState(tx, lease, 'verified', null);
      } else if (terminal && result.errorCode !== 'adapter_unsupported') {
        await this.updateHealthState(tx, lease, 'failed', result.errorCode);
      }
      return true;
    }, true);
  }

  private async updateHealthState(
    tx: SqlExecutor,
    lease: CredentialValidationLease,
    state: 'verified' | 'failed',
    errorCodeValue: ProviderCredentialValidationErrorCode | null,
  ): Promise<void> {
    const status = state === 'verified' ? 'active' : 'pending';
    const credential = await queryRows<{ id: string }>(
      tx,
      `UPDATE saas_tenant_provider_credentials
          SET status = $1, validation_state = $2, validation_error_code = $3,
              last_validated_at = clock_timestamp(), updated_at = clock_timestamp(),
              authz_version = authz_version + 1
        WHERE tenant_id = $4 AND id = $5 AND account_id = $6
          AND provider_id = $7 AND product_id = $8
          AND current_version = $9 AND status IN ('pending', 'active')
       RETURNING id`,
      [
        status,
        state,
        errorCodeValue,
        lease.job.tenantId,
        lease.job.credentialId,
        lease.job.accountId,
        lease.job.providerId,
        lease.job.productId,
        lease.job.credentialVersion,
      ],
    );
    const account = await queryRows<{ id: string }>(
      tx,
      `UPDATE saas_tenant_provider_accounts
          SET status = $1, validation_state = $2, validation_error_code = $3,
              last_validated_at = clock_timestamp(), updated_at = clock_timestamp(),
              authz_version = authz_version + 1
        WHERE tenant_id = $4 AND id = $5 AND provider_id = $6 AND product_id = $7
          AND status IN ('pending', 'active')
       RETURNING id`,
      [
        status,
        state,
        errorCodeValue,
        lease.job.tenantId,
        lease.job.accountId,
        lease.job.providerId,
        lease.job.productId,
      ],
    );
    if (credential.rows.length !== 1 || account.rows.length !== 1) leaseLost();
  }
}

function positiveBound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw workerError('STORE_UNAVAILABLE');
  return value;
}

export interface CredentialValidationWorkerOptions {
  readonly fetch?: ProviderCredentialValidationFetch;
  readonly deployment: string;
  readonly environment: string;
  readonly pollIntervalMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Receives only a stable cycle code. It never receives provider or credential data. */
  readonly onError?: (code: 'cycle_failed') => void;
}

export class CredentialValidationWorker {
  private readonly store: PostgresCredentialValidationWorkerStore;

  constructor(
    database: SaasDatabase,
    kms: ProviderCredentialUnsealingKms,
    private readonly options: CredentialValidationWorkerOptions,
  ) {
    this.store = new PostgresCredentialValidationWorkerStore(database, kms, options);
  }

  async runOnce(): Promise<CredentialValidationWorkerResult> {
    const lease = await this.store.claimNext();
    if (!lease) return 'idle';

    let result: ProviderCredentialValidationResult;
    if (!isSupportedTarget(lease.job)) {
      result = {
        state: 'failed',
        errorCode: 'adapter_unsupported',
        retryable: false,
        adapterId: null,
        httpStatus: null,
        durationMs: 0,
      };
    } else {
      try {
        result = await this.store.withCredential(lease, async (secret) => {
          await this.store.recheckBeforeProviderRequest(lease);
          return validateProviderCredential(lease.job, secret, this.options.fetch);
        });
      } catch (error) {
        if (error instanceof CredentialValidationWorkerError && error.code === 'LEASE_LOST') return 'stale';
        result = {
          state: 'failed',
          errorCode: 'credential_unavailable',
          retryable: true,
          adapterId: null,
          httpStatus: null,
          durationMs: 0,
        };
      }
    }

    try {
      return (await this.store.complete(lease, result)) ? 'processed' : 'stale';
    } catch (error) {
      if (error instanceof CredentialValidationWorkerError && error.code === 'LEASE_LOST') return 'stale';
      throw error;
    }
  }

  async run(): Promise<void> {
    const pollIntervalMs = positiveBound(
      this.options.pollIntervalMs ?? CREDENTIAL_VALIDATION_POLL_INTERVAL_MS,
      100,
      60_000,
    );
    for (;;) {
      try {
        const result = await this.runOnce();
        if (result === 'idle') await delay(pollIntervalMs);
      } catch {
        try {
          this.options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate credential processing.
        }
        await delay(pollIntervalMs);
      }
    }
  }
}

function isSupportedTarget(job: ProviderCredentialValidationJobRecord): boolean {
  return isSupportedCredentialValidationTarget(job);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export interface CredentialValidationWorkerHandle {
  close(): Promise<void>;
}

export function startCredentialValidationWorker(
  database: SaasDatabase,
  kms: ProviderCredentialUnsealingKms,
  options: CredentialValidationWorkerOptions,
): CredentialValidationWorkerHandle {
  const worker = new CredentialValidationWorker(database, kms, options);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    const pollIntervalMs = positiveBound(options.pollIntervalMs ?? CREDENTIAL_VALIDATION_POLL_INTERVAL_MS, 100, 60_000);
    while (!closed) {
      try {
        const result = await worker.runOnce();
        if (result === 'idle') await delayWithClose(pollIntervalMs);
      } catch {
        try {
          options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate credential processing.
        }
        await delayWithClose(pollIntervalMs);
      }
    }
  };
  let done: Promise<void>;
  done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await done;
    },
  };
}
