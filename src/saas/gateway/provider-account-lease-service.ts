import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import type {
  PreparedEvidenceLease,
  PreparedEvidenceLeaseProvider,
  PreparedEvidenceLeaseRequest,
} from './prepared-evidence-dispatch-service.js';

type LeaseOwnerKind = 'tenant' | 'platform';

interface AccountRow {
  readonly id: string;
  readonly status: string;
  readonly validation_state: string;
  readonly revoked_at: string | Date | null;
}

interface HeldLeaseRow {
  readonly id: string;
  readonly slot: unknown;
  readonly fencing_token: unknown;
  readonly lease_expires_at: unknown;
}

interface LeaseIdentityRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_kind: string;
  readonly owner_tenant_id: string | null;
  readonly account_id: string;
  readonly upstream_id: string;
  readonly attempt_id: string;
  readonly slot: unknown;
  readonly fencing_token: unknown;
  readonly status: string;
  readonly lease_expires_at: unknown;
}

interface DbClockRow {
  readonly db_now: unknown;
}

export type ProviderAccountLeaseErrorCode =
  | 'INVALID_INPUT'
  | 'ACCOUNT_UNAVAILABLE'
  | 'LEASE_UNAVAILABLE'
  | 'STALE_LEASE'
  | 'STORAGE_ERROR';

export class ProviderAccountLeaseError extends Error {
  constructor(
    readonly code: ProviderAccountLeaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderAccountLeaseError';
  }
}

export interface ProviderAccountLeaseServiceOptions {
  readonly database: SaasDatabase;
  /** One account-wide bound applied by this provider instance. */
  readonly maxConcurrency: number;
  /** Lease duration in milliseconds. It is never derived from wall-clock JS time. */
  readonly leaseTtlMs: number;
}

export interface ProviderAccountLease extends PreparedEvidenceLease {
  renew(): Promise<void>;
}

interface NormalizedLeaseInput {
  readonly tenantId: string;
  readonly ownerKind: LeaseOwnerKind;
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly attemptId: string;
}

interface LeaseIdentity {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerKind: LeaseOwnerKind;
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly attemptId: string;
  readonly fencingToken: string;
}

const LEASE_TABLE = 'saas_provider_account_leases';

function fail(code: ProviderAccountLeaseErrorCode, message: string, cause?: unknown): never {
  throw new ProviderAccountLeaseError(code, message, cause === undefined ? undefined : { cause });
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    fail('INVALID_INPUT', `${field} is required`);
  }
  return value.trim();
}

function boundedPositiveInteger(value: unknown, field: string, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail('INVALID_INPUT', `${field} must be a bounded positive integer`);
  }
  return parsed;
}

function normalizeConfiguration(options: ProviderAccountLeaseServiceOptions): {
  readonly maxConcurrency: number;
  readonly leaseTtlMs: number;
} {
  return {
    maxConcurrency: boundedPositiveInteger(options.maxConcurrency, 'maxConcurrency', 10_000),
    leaseTtlMs: boundedPositiveInteger(options.leaseTtlMs, 'leaseTtlMs', 3_600_000),
  };
}

function normalizeInput(input: PreparedEvidenceLeaseRequest): NormalizedLeaseInput {
  if (!input?.evidence) fail('INVALID_INPUT', 'lease evidence is required');
  const tenantId = nonEmpty(input.tenantId, 'tenantId');
  const accountId = nonEmpty(input.accountId, 'accountId');
  const upstreamId = nonEmpty(input.upstreamId, 'upstreamId');
  const attemptId = nonEmpty(input.attemptId, 'attemptId');
  if (
    input.evidence.tenantId !== tenantId ||
    input.evidence.accountId !== accountId ||
    input.evidence.upstreamId !== upstreamId ||
    input.evidence.attemptId !== attemptId
  ) {
    fail('INVALID_INPUT', 'lease identity does not match prepared evidence');
  }

  if (input.evidence.supplyMode !== 'byok' && input.evidence.supplyMode !== 'platform') {
    fail('INVALID_INPUT', 'lease supply mode is invalid');
  }

  const ownerKind: LeaseOwnerKind = input.evidence.supplyMode === 'byok' ? 'tenant' : 'platform';
  return {
    tenantId,
    ownerKind,
    ownerTenantId: ownerKind === 'tenant' ? tenantId : null,
    accountId,
    upstreamId,
    attemptId,
  };
}

function exactlyOne<Row>(rows: readonly Row[], code: ProviderAccountLeaseErrorCode, message: string): Row {
  if (rows.length !== 1) fail(code, message);
  return rows[0];
}

function asDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail('STORAGE_ERROR', `${field} is not a valid database timestamp`);
  return date;
}

function asSlot(value: unknown): number {
  const slot = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(slot) || slot < 0) fail('STORAGE_ERROR', 'stored lease slot is invalid');
  return slot;
}

function asFencingToken(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < 1n) fail('STORAGE_ERROR', 'stored fencing token is invalid');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) fail('STORAGE_ERROR', 'stored fencing token is invalid');
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  fail('STORAGE_ERROR', 'stored fencing token is invalid');
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function storageError(error: unknown): ProviderAccountLeaseError {
  return error instanceof ProviderAccountLeaseError
    ? error
    : new ProviderAccountLeaseError('STORAGE_ERROR', 'provider account lease storage failed', { cause: error });
}

export class PostgresProviderAccountLeaseService implements PreparedEvidenceLeaseProvider {
  private readonly database: SaasDatabase;
  private readonly maxConcurrency: number;
  private readonly leaseTtlMs: number;

  constructor(options: ProviderAccountLeaseServiceOptions) {
    if (!options?.database || typeof options.database.transaction !== 'function') {
      fail('INVALID_INPUT', 'a transactional SaaS database is required');
    }
    const configuration = normalizeConfiguration(options);
    this.database = options.database;
    this.maxConcurrency = configuration.maxConcurrency;
    this.leaseTtlMs = configuration.leaseTtlMs;
  }

  async acquire(input: PreparedEvidenceLeaseRequest): Promise<ProviderAccountLease | null> {
    const normalized = normalizeInput(input);
    try {
      return await this.database.transaction((tx) => this.acquireInTransaction(tx, normalized));
    } catch (error) {
      throw storageError(error);
    }
  }

  private async acquireInTransaction(
    tx: SqlExecutor,
    input: NormalizedLeaseInput,
  ): Promise<ProviderAccountLease | null> {
    await this.fenceAndReadAccount(tx, input);

    /* Lock all current held rows before taking the database clock sample. */
    const heldResult = await tx.query<HeldLeaseRow>(
      `SELECT id, slot, fencing_token, lease_expires_at
         FROM ${LEASE_TABLE}
        WHERE owner_kind = $1
          AND owner_tenant_id IS NOT DISTINCT FROM $2
          AND account_id = $3
          AND status = 'held'
        FOR UPDATE`,
      [input.ownerKind, input.ownerTenantId, input.accountId],
    );
    const databaseNow = await this.databaseClock(tx);
    const heldRows = heldResult.rows;
    const occupiedSlots = new Set<number>();
    for (const row of heldRows) {
      const slot = asSlot(row.slot);
      if (occupiedSlots.has(slot)) fail('STORAGE_ERROR', 'duplicate active lease slot');
      if (asDate(row.lease_expires_at, 'lease_expires_at').getTime() > databaseNow.getTime()) {
        occupiedSlots.add(slot);
      }
    }

    await tx.query(
      `UPDATE ${LEASE_TABLE}
          SET status = 'expired', released_at = $4, updated_at = $4
        WHERE owner_kind = $1
          AND owner_tenant_id IS NOT DISTINCT FROM $2
          AND account_id = $3
          AND status = 'held'
          AND lease_expires_at <= $4`,
      [input.ownerKind, input.ownerTenantId, input.accountId, databaseNow],
    );

    if (occupiedSlots.size >= this.maxConcurrency) return null;
    let slot: number | null = null;
    for (let candidate = 0; candidate < this.maxConcurrency; candidate += 1) {
      if (!occupiedSlots.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    if (slot === null) return null;

    const sequenceResult = await tx.query<{ fencing_token: unknown }>(
      `SELECT nextval('saas_provider_account_lease_fencing_seq') AS fencing_token`,
    );
    const fencingToken = asFencingToken(
      exactlyOne(sequenceResult.rows, 'STORAGE_ERROR', 'fencing sequence failed').fencing_token,
    );
    const leaseId = randomUUID();
    const inserted = await tx.query<{ id: string; fencing_token: unknown }>(
      `INSERT INTO ${LEASE_TABLE}
        (id, tenant_id, owner_kind, owner_tenant_id, account_id, upstream_id, attempt_id,
         slot, fencing_token, status, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'held',
               clock_timestamp() + ($10 * interval '1 millisecond'))
       RETURNING id, fencing_token`,
      [
        leaseId,
        input.tenantId,
        input.ownerKind,
        input.ownerTenantId,
        input.accountId,
        input.upstreamId,
        input.attemptId,
        slot,
        fencingToken,
        this.leaseTtlMs,
      ],
    );
    const insertedRow = exactlyOne(inserted.rows, 'STORAGE_ERROR', 'lease insert did not return exactly one row');
    if (insertedRow.id !== leaseId || asFencingToken(insertedRow.fencing_token) !== fencingToken) {
      fail('STORAGE_ERROR', 'lease insert returned an unexpected identity');
    }

    const identity: LeaseIdentity = { ...input, id: leaseId, fencingToken };
    return {
      fencingToken,
      renewIntervalMs: Math.max(1, Math.floor(this.leaseTtlMs / 3)),
      renew: () => this.renewLease(identity),
      release: () => this.releaseLease(identity),
    };
  }

  private async fenceAndReadAccount(tx: SqlExecutor, input: NormalizedLeaseInput): Promise<void> {
    // Match migration 050's account writer fence, and serialize acquisitions
    // even when the account has no held lease rows yet. Account authority is
    // SELECT-only for the gateway: it must not require a tuple-lock UPDATE ACL.
    // All live acquirers must share this fence; a legacy tuple-lock-only
    // acquirer does not participate and is not safe to mix during rollout.
    const key = input.ownerKind === 'tenant'
      ? saasAdvisoryKey.tenantProviderAccount(input.tenantId, input.accountId)
      : saasAdvisoryKey.platformProviderAccount(input.accountId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);

    // Keep this a separate statement after the wait. The production database
    // transaction boundary forces READ COMMITTED, so a committed CP revocation
    // is visible here, not hidden by the snapshot taken by the lock statement.
    const result =
      input.ownerKind === 'tenant'
        ? await tx.query<AccountRow>(
            `SELECT id, status, validation_state, revoked_at
               FROM saas_tenant_provider_accounts
              WHERE tenant_id = $1
                AND id = $2
                AND status = 'active'
                AND validation_state = 'verified'
                AND revoked_at IS NULL`,
            [input.tenantId, input.accountId],
          )
        : await tx.query<AccountRow>(
            `SELECT id, status, validation_state, revoked_at
               FROM saas_platform_provider_accounts
              WHERE id = $1
                AND status = 'active'
                AND validation_state = 'verified'
                AND revoked_at IS NULL`,
            [input.accountId],
          );
    if (result.rows.length !== 1) fail('ACCOUNT_UNAVAILABLE', 'provider account is not currently leasable');
    const account = result.rows[0];
    if (account.id !== input.accountId || account.status !== 'active' || account.validation_state !== 'verified') {
      fail('ACCOUNT_UNAVAILABLE', 'provider account is not currently leasable');
    }
  }

  private async databaseClock(tx: SqlExecutor): Promise<Date> {
    const result = await tx.query<DbClockRow>('SELECT clock_timestamp() AS db_now');
    return asDate(exactlyOne(result.rows, 'STORAGE_ERROR', 'database clock query failed').db_now, 'db_now');
  }

  private async loadLease(tx: SqlExecutor, identity: LeaseIdentity): Promise<LeaseIdentityRow> {
    const result = await tx.query<LeaseIdentityRow>(
      `SELECT id, tenant_id, owner_kind, owner_tenant_id, account_id, upstream_id, attempt_id,
              slot, fencing_token, status, lease_expires_at
         FROM ${LEASE_TABLE}
        WHERE id = $1
        FOR UPDATE`,
      [identity.id],
    );
    const row = exactlyOne(result.rows, 'STALE_LEASE', 'provider account lease is no longer present');
    if (
      row.tenant_id !== identity.tenantId ||
      row.owner_kind !== identity.ownerKind ||
      !sameNullable(row.owner_tenant_id, identity.ownerTenantId) ||
      row.account_id !== identity.accountId ||
      row.upstream_id !== identity.upstreamId ||
      row.attempt_id !== identity.attemptId ||
      asFencingToken(row.fencing_token) !== identity.fencingToken
    ) {
      fail('STALE_LEASE', 'provider account lease fencing identity is stale');
    }
    return row;
  }

  private async renewLease(identity: LeaseIdentity): Promise<void> {
    try {
      await this.database.transaction(async (tx) => {
        const row = await this.loadLease(tx, identity);
        const databaseNow = await this.databaseClock(tx);
        if (row.status !== 'held' || asDate(row.lease_expires_at, 'lease_expires_at') <= databaseNow) {
          fail('STALE_LEASE', 'expired or terminal provider account lease cannot be renewed');
        }
        const updated = await tx.query<{ id: string }>(
          `UPDATE ${LEASE_TABLE}
              SET lease_expires_at = clock_timestamp() + ($2 * interval '1 millisecond'),
                  updated_at = clock_timestamp()
            WHERE id = $1
              AND fencing_token = $3
              AND status = 'held'
              AND lease_expires_at > clock_timestamp()
            RETURNING id`,
          [identity.id, this.leaseTtlMs, identity.fencingToken],
        );
        if (updated.rows.length !== 1 || updated.rows[0].id !== identity.id) {
          fail('STALE_LEASE', 'provider account lease renewal lost its fencing race');
        }
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  private async releaseLease(identity: LeaseIdentity): Promise<void> {
    try {
      await this.database.transaction(async (tx) => {
        const row = await this.loadLease(tx, identity);
        const databaseNow = await this.databaseClock(tx);
        if (row.status === 'released') return;
        if (row.status !== 'held' || asDate(row.lease_expires_at, 'lease_expires_at') <= databaseNow) {
          fail('STALE_LEASE', 'expired or terminal provider account lease cannot be released');
        }
        const updated = await tx.query<{ id: string }>(
          `UPDATE ${LEASE_TABLE}
              SET status = 'released', released_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1
              AND fencing_token = $2
              AND status = 'held'
              AND lease_expires_at > clock_timestamp()
            RETURNING id`,
          [identity.id, identity.fencingToken],
        );
        if (updated.rows.length !== 1 || updated.rows[0].id !== identity.id) {
          fail('STALE_LEASE', 'provider account lease release lost its fencing race');
        }
      });
    } catch (error) {
      throw storageError(error);
    }
  }
}
