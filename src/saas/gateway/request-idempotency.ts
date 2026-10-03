import { createHmac } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';

const TABLE = 'saas_gateway_request_idempotency_keys';
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_TEXT = /^[0-9a-f]{64}$/;
const HMAC_MINIMUM_KEY_BYTES = 32;
const MAX_CLIENT_KEY_BYTES = 1024;
const MAX_FINGERPRINT_VERSION_LENGTH = 128;
const HMAC_DOMAIN = Buffer.from('saas-gateway-idempotency-key-v1\0', 'utf8');

export interface GatewayRequestIdempotencyScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
}

export interface GatewayRequestIdempotencyClaimInput extends GatewayRequestIdempotencyScope {
  /** Opaque Idempotency-Key value. It is only used in the in-memory HMAC input. */
  readonly clientKey: string;
  /** Server-computed request fingerprint and its canonicalization version. */
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  /** Candidate id for this HTTP request; persisted only if this call wins the reservation. */
  readonly requestId: string;
}

export interface GatewayRequestIdempotencyStateInput extends GatewayRequestIdempotencyScope {
  /** Opaque Idempotency-Key value. It is never sent to SQL or stored. */
  readonly clientKey: string;
  /** The canonical id returned by the winning reservation. */
  readonly requestId: string;
}

export interface GatewayRequestIdempotencyClaimed {
  readonly kind: 'claimed';
  readonly canonicalRequestId: string;
  readonly keyDigest: string;
}

export type GatewayRequestIdempotencyClaimResult =
  | GatewayRequestIdempotencyClaimed
  | {
      readonly kind: 'existing';
      readonly state: 'in_progress' | 'unknown' | 'completed';
      readonly canonicalRequestId: string;
      readonly canonicalRequestStatus: 'in_progress' | 'unknown' | 'completed';
      readonly keyDigest: string;
    }
  | { readonly kind: 'fingerprint_conflict' };

const issuedClaims = new WeakSet<object>();

/** True only for a fresh claim result issued by this process's HMAC store. */
export function isGatewayRequestIdempotencyClaimed(value: unknown): value is GatewayRequestIdempotencyClaimed {
  return typeof value === 'object' && value !== null && issuedClaims.has(value);
}

interface StoredIdempotencyRow {
  request_fingerprint: unknown;
  request_fingerprint_version: unknown;
  request_id: unknown;
  state: unknown;
  execution_state: unknown;
  canonical_project_id: unknown;
  canonical_proxy_key_id: unknown;
  canonical_request_fingerprint: unknown;
  canonical_request_fingerprint_version: unknown;
}

interface StoredStateRow {
  state: unknown;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function normalizeUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_TEXT.test(value)) {
    return fail(`Invalid ${name}`);
  }
  return value.toLowerCase();
}

function validateClaimInput(input: GatewayRequestIdempotencyClaimInput): GatewayRequestIdempotencyClaimInput {
  if (!input || typeof input !== 'object') {
    return fail('Gateway idempotency claim input is required');
  }
  const tenantId = normalizeUuid(input.tenantId, 'tenantId');
  const projectId = normalizeUuid(input.projectId, 'projectId');
  const proxyKeyId = normalizeUuid(input.proxyKeyId, 'proxyKeyId');
  const requestId = normalizeUuid(input.requestId, 'requestId');
  if (typeof input.clientKey !== 'string') {
    return fail('Invalid clientKey');
  }
  const clientKeyBytes = Buffer.byteLength(input.clientKey, 'utf8');
  if (clientKeyBytes === 0 || clientKeyBytes > MAX_CLIENT_KEY_BYTES) {
    return fail('Invalid clientKey');
  }
  if (typeof input.requestFingerprint !== 'string' || !FINGERPRINT_TEXT.test(input.requestFingerprint)) {
    return fail('Invalid requestFingerprint');
  }
  if (
    typeof input.requestFingerprintVersion !== 'string' ||
    input.requestFingerprintVersion.length === 0 ||
    input.requestFingerprintVersion.length > MAX_FINGERPRINT_VERSION_LENGTH ||
    input.requestFingerprintVersion.trim() !== input.requestFingerprintVersion
  ) {
    return fail('Invalid requestFingerprintVersion');
  }
  return { ...input, tenantId, projectId, proxyKeyId, requestId };
}

function validateStateInput(input: GatewayRequestIdempotencyStateInput): GatewayRequestIdempotencyStateInput {
  if (!input || typeof input !== 'object') {
    return fail('Gateway idempotency state input is required');
  }
  const tenantId = normalizeUuid(input.tenantId, 'tenantId');
  const projectId = normalizeUuid(input.projectId, 'projectId');
  const proxyKeyId = normalizeUuid(input.proxyKeyId, 'proxyKeyId');
  const requestId = normalizeUuid(input.requestId, 'requestId');
  if (typeof input.clientKey !== 'string') {
    return fail('Invalid clientKey');
  }
  const clientKeyBytes = Buffer.byteLength(input.clientKey, 'utf8');
  if (clientKeyBytes === 0 || clientKeyBytes > MAX_CLIENT_KEY_BYTES) {
    return fail('Invalid clientKey');
  }
  return { ...input, tenantId, projectId, proxyKeyId, requestId };
}

function encodeLengthPrefixed(value: Buffer): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(value.byteLength);
  return Buffer.concat([prefix, value]);
}

function normalizeStoredState(value: unknown): 'in_progress' | 'unknown' | 'completed' {
  if (value === 'in_progress' || value === 'unknown' || value === 'completed') {
    return value;
  }
  throw new Error('Stored gateway idempotency state is invalid');
}

function canonicalRequestStatus(
  requestState: unknown,
  idempotencyState: 'in_progress' | 'unknown' | 'completed',
): 'in_progress' | 'unknown' | 'completed' {
  if (requestState === 'succeeded' || requestState === 'failed') return 'completed';
  if (requestState === 'unknown' || idempotencyState === 'unknown') return 'unknown';
  if (requestState === 'pending') return idempotencyState === 'completed' ? 'completed' : 'in_progress';
  throw new Error('Stored canonical request state is invalid');
}

function resolveExisting(
  row: StoredIdempotencyRow,
  input: GatewayRequestIdempotencyClaimInput,
  keyDigest: string,
): GatewayRequestIdempotencyClaimResult {
  if (
    row.request_fingerprint !== input.requestFingerprint ||
    row.request_fingerprint_version !== input.requestFingerprintVersion
  ) {
    return { kind: 'fingerprint_conflict' };
  }

  const state = normalizeStoredState(row.state);
  const canonicalRequestId = normalizeUuid(row.request_id, 'stored request id');
  if (
    normalizeUuid(row.canonical_project_id, 'canonical request project id') !== input.projectId ||
    normalizeUuid(row.canonical_proxy_key_id, 'canonical request Proxy Key id') !== input.proxyKeyId ||
    row.canonical_request_fingerprint !== input.requestFingerprint ||
    row.canonical_request_fingerprint_version !== input.requestFingerprintVersion
  ) {
    throw new Error('Canonical request binding does not match its idempotency mapping');
  }
  return {
    kind: 'existing',
    state,
    canonicalRequestId,
    canonicalRequestStatus: canonicalRequestStatus(row.execution_state, state),
    keyDigest,
  };
}

function createClaimedResult(canonicalRequestId: string, keyDigest: string): GatewayRequestIdempotencyClaimed {
  const claim = Object.freeze({ kind: 'claimed' as const, canonicalRequestId, keyDigest });
  issuedClaims.add(claim);
  return claim;
}

/**
 * Durable gateway idempotency mapping. The HMAC key must be supplied from
 * application configuration, be stable across gateway instances/restarts, and
 * remain available for the lifetime of these non-expiring mappings.
 *
 * This store never opens a transaction: every method requires the caller's
 * existing SqlExecutor so the reservation and later request/hold writes share
 * one commit or rollback.
 */
export class GatewayRequestIdempotencyStore {
  private readonly hmacKey: Buffer;

  constructor(options: { readonly hmacKey: Uint8Array }) {
    if (!options || !(options.hmacKey instanceof Uint8Array) || options.hmacKey.byteLength < HMAC_MINIMUM_KEY_BYTES) {
      throw new TypeError('A configured HMAC key of at least 32 bytes is required');
    }
    this.hmacKey = Buffer.from(options.hmacKey);
  }

  async claim(
    tx: SqlExecutor,
    command: GatewayRequestIdempotencyClaimInput,
  ): Promise<GatewayRequestIdempotencyClaimResult> {
    if (!tx || typeof tx.query !== 'function') {
      throw new TypeError('An existing SQL transaction executor is required');
    }
    const input = validateClaimInput(command);
    const keyDigest = this.digestClientKey(input);
    const inserted = await tx.query<{ request_id: unknown }>(
      `INSERT INTO ${TABLE}
         (tenant_id, project_id, proxy_key_id, key_digest, request_fingerprint,
          request_fingerprint_version, request_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress')
       ON CONFLICT (tenant_id, project_id, proxy_key_id, key_digest) DO NOTHING
       RETURNING request_id`,
      [
        input.tenantId,
        input.projectId,
        input.proxyKeyId,
        keyDigest,
        input.requestFingerprint,
        input.requestFingerprintVersion,
        input.requestId,
      ],
    );

    if (inserted.rows.length > 1) {
      throw new Error('Gateway idempotency reservation returned an invalid result');
    }
    if (inserted.rows.length === 1) {
      const canonicalRequestId = normalizeUuid(inserted.rows[0].request_id, 'stored request id');
      if (canonicalRequestId !== input.requestId) {
        throw new Error('Gateway idempotency reservation returned an unexpected request id');
      }
      return createClaimedResult(canonicalRequestId, keyDigest);
    }

    // ON CONFLICT waits for the competing INSERT. Lock and inspect its committed
    // row before returning so a race cannot be mistaken for a fresh claim.
    const existing = await tx.query<StoredIdempotencyRow>(
      `SELECT ${TABLE}.request_fingerprint AS request_fingerprint,
              ${TABLE}.request_fingerprint_version AS request_fingerprint_version,
              ${TABLE}.request_id AS request_id,
              ${TABLE}.state AS state,
              request_row.execution_state AS execution_state,
              request_row.project_id AS canonical_project_id,
              request_row.proxy_key_id AS canonical_proxy_key_id,
              request_row.request_fingerprint AS canonical_request_fingerprint,
              request_row.request_fingerprint_version AS canonical_request_fingerprint_version
         FROM ${TABLE}
         JOIN saas_requests AS request_row
           ON request_row.tenant_id = ${TABLE}.tenant_id
          AND request_row.id = ${TABLE}.request_id
        WHERE ${TABLE}.tenant_id = $1
          AND ${TABLE}.project_id = $2
          AND ${TABLE}.proxy_key_id = $3
          AND ${TABLE}.key_digest = $4
        FOR UPDATE OF ${TABLE}, request_row`,
      [input.tenantId, input.projectId, input.proxyKeyId, keyDigest],
    );
    if (existing.rows.length !== 1) {
      throw new Error('Gateway idempotency reservation could not be verified');
    }
    return resolveExisting(existing.rows[0], input, keyDigest);
  }

  markCompleted(tx: SqlExecutor, input: GatewayRequestIdempotencyStateInput): Promise<boolean> {
    return this.transition(tx, input, 'completed');
  }

  markUnknown(tx: SqlExecutor, input: GatewayRequestIdempotencyStateInput): Promise<boolean> {
    return this.transition(tx, input, 'unknown');
  }

  private async transition(
    tx: SqlExecutor,
    command: GatewayRequestIdempotencyStateInput,
    state: 'completed' | 'unknown',
  ): Promise<boolean> {
    if (!tx || typeof tx.query !== 'function') {
      throw new TypeError('An existing SQL transaction executor is required');
    }
    const input = validateStateInput(command);
    const keyDigest = this.digestClientKey(input);
    const updated = await tx.query<StoredStateRow>(
      `UPDATE ${TABLE}
          SET state = $5,
              updated_at = clock_timestamp(),
              completed_at = CASE WHEN $5 = 'completed' THEN clock_timestamp() ELSE NULL END,
              unknown_at = CASE WHEN $5 = 'unknown' THEN clock_timestamp() ELSE NULL END
        WHERE tenant_id = $1
          AND project_id = $2
          AND proxy_key_id = $3
          AND key_digest = $4
          AND request_id = $6
          AND state = 'in_progress'
        RETURNING state`,
      [input.tenantId, input.projectId, input.proxyKeyId, keyDigest, state, input.requestId],
    );
    if (updated.rows.length > 1) {
      throw new Error('Gateway idempotency state update returned an invalid result');
    }
    if (updated.rows.length === 1) {
      if (normalizeStoredState(updated.rows[0].state) !== state) {
        throw new Error('Gateway idempotency state update returned an unexpected state');
      }
      return true;
    }

    const existing = await tx.query<StoredStateRow>(
      `SELECT state
         FROM ${TABLE}
        WHERE tenant_id = $1
          AND project_id = $2
          AND proxy_key_id = $3
          AND key_digest = $4
          AND request_id = $5
        FOR UPDATE`,
      [input.tenantId, input.projectId, input.proxyKeyId, keyDigest, input.requestId],
    );
    if (existing.rows.length > 1) {
      throw new Error('Gateway idempotency state lookup returned an invalid result');
    }
    return existing.rows.length === 1 && normalizeStoredState(existing.rows[0].state) === state;
  }

  private digestClientKey(input: GatewayRequestIdempotencyScope & { readonly clientKey: string }): string {
    const fields = [input.tenantId, input.projectId, input.proxyKeyId, input.clientKey].map((field) =>
      encodeLengthPrefixed(Buffer.from(field, 'utf8')),
    );
    return createHmac('sha256', this.hmacKey)
      .update(Buffer.concat([HMAC_DOMAIN, ...fields]))
      .digest('hex');
  }
}
