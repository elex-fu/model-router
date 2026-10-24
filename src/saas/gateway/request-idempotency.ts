import { createHmac } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import type { GatewayProtocol, ModelResolutionProvenance } from './contracts.js';

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

export interface GatewayRequestIdempotencyLookupScope extends GatewayRequestIdempotencyScope {
  readonly clientKey: string;
}

/** Historical compilation facts only; never a grant of current provider/account authority. */
export interface GatewayRequestCanonicalCompilation {
  readonly canonicalRequestId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly publicModel: string;
  readonly endpoint: string;
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly modelResolution: ModelResolutionProvenance;
  readonly compilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
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

export type GatewayRequestIdempotencyLookupResult =
  | { readonly kind: 'missing' }
  | Exclude<GatewayRequestIdempotencyClaimResult, GatewayRequestIdempotencyClaimed>;

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

interface StoredCanonicalCompilationRow extends StoredIdempotencyRow {
  public_model: unknown;
  request_protocol: unknown;
  request_endpoint: unknown;
  route_config_id: unknown;
  route_config_version: unknown;
  route_public_model_id: unknown;
  route_public_model_version: unknown;
  route_protocol: unknown;
  route_target_mode: unknown;
  route_upstream_id: unknown;
  attempt_id: unknown;
  attempt_ordinal: unknown;
  provider_id: unknown;
  product_id: unknown;
  resolved_model: unknown;
  attempt_protocol: unknown;
  attempt_endpoint: unknown;
  attempt_upstream_id: unknown;
  provider_protocol: unknown;
  client_operation: unknown;
  provider_operation: unknown;
  model_resolution_requested_model: unknown;
  model_resolution_mapped_model: unknown;
  model_resolution_mapping_source: unknown;
  model_resolution_mapping_version: unknown;
  attempt_request_fingerprint: unknown;
  attempt_request_fingerprint_version: unknown;
  payload_compiler_version: unknown;
  usage_estimator_version: unknown;
  payload_sha256: unknown;
  attempt_route_config_id: unknown;
  attempt_route_config_version: unknown;
  attempt_route_public_model_id: unknown;
  attempt_route_public_model_version: unknown;
  attempt_route_protocol: unknown;
  attempt_route_target_mode: unknown;
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

function validateLookupScope(input: GatewayRequestIdempotencyLookupScope): GatewayRequestIdempotencyLookupScope {
  if (!input || typeof input !== 'object') fail('Gateway idempotency lookup input is required');
  const tenantId = normalizeUuid(input.tenantId, 'tenantId');
  const projectId = normalizeUuid(input.projectId, 'projectId');
  const proxyKeyId = normalizeUuid(input.proxyKeyId, 'proxyKeyId');
  if (typeof input.clientKey !== 'string' || Buffer.byteLength(input.clientKey, 'utf8') === 0 ||
      Buffer.byteLength(input.clientKey, 'utf8') > MAX_CLIENT_KEY_BYTES) fail('Invalid clientKey');
  return { tenantId, projectId, proxyKeyId, clientKey: input.clientKey };
}

function compilationUnavailable(): never {
  throw new Error('Canonical request compilation context is unavailable');
}

function storedText(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) compilationUnavailable();
  return value;
}

function storedVersion(value: unknown): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) compilationUnavailable();
  if (typeof value !== 'string' && typeof value !== 'number') compilationUnavailable();
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) compilationUnavailable();
  return text;
}

function storedProtocol(value: unknown): GatewayProtocol {
  if (value !== 'openai' && value !== 'anthropic' && value !== 'gemini' && value !== 'responses') compilationUnavailable();
  return value;
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
): Exclude<GatewayRequestIdempotencyClaimResult, GatewayRequestIdempotencyClaimed> {
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

  /** Read a committed mapping without reserving a provisional request or issuing a claim. */
  async lookupExisting(tx: SqlExecutor, command: GatewayRequestIdempotencyClaimInput): Promise<GatewayRequestIdempotencyLookupResult> {
    if (!tx || typeof tx.query !== 'function') throw new TypeError('An existing SQL transaction executor is required');
    const input = validateClaimInput(command);
    const keyDigest = this.digestClientKey(input);
    const result = await tx.query<StoredIdempotencyRow>(
      `SELECT k.request_fingerprint, k.request_fingerprint_version, k.request_id, k.state,
              r.execution_state, r.project_id AS canonical_project_id, r.proxy_key_id AS canonical_proxy_key_id,
              r.request_fingerprint AS canonical_request_fingerprint,
              r.request_fingerprint_version AS canonical_request_fingerprint_version
         FROM ${TABLE} k
         LEFT JOIN saas_requests r ON r.tenant_id=k.tenant_id AND r.id=k.request_id
        WHERE k.tenant_id=$1 AND k.project_id=$2 AND k.proxy_key_id=$3 AND k.key_digest=$4`,
      [input.tenantId, input.projectId, input.proxyKeyId, keyDigest],
    );
    if (result.rows.length === 0) return { kind: 'missing' };
    if (result.rows.length !== 1) throw new Error('Gateway idempotency lookup could not be verified');
    return resolveExisting(result.rows[0], input, keyDigest);
  }

  /** Missing means no HMAC mapping. Legacy, incomplete or corrupt hits fail closed. */
  async readCanonicalCompilation(tx: SqlExecutor, command: GatewayRequestIdempotencyLookupScope): Promise<GatewayRequestCanonicalCompilation | null> {
    if (!tx || typeof tx.query !== 'function') throw new TypeError('An existing SQL transaction executor is required');
    const input = validateLookupScope(command);
    const keyDigest = this.digestClientKey(input);
    const result = await tx.query<StoredCanonicalCompilationRow>(
      `SELECT k.request_fingerprint,k.request_fingerprint_version,k.request_id,k.state,
              r.execution_state,r.project_id AS canonical_project_id,r.proxy_key_id AS canonical_proxy_key_id,
              r.request_fingerprint AS canonical_request_fingerprint,r.request_fingerprint_version AS canonical_request_fingerprint_version,
              r.public_model,r.protocol AS request_protocol,r.endpoint AS request_endpoint,
              r.route_config_id,r.route_config_version,r.route_public_model_id,r.route_public_model_version,
              r.route_protocol,r.route_target_mode,r.route_upstream_id,
              a.id AS attempt_id,a.ordinal AS attempt_ordinal,a.provider_id,a.product_id,a.resolved_model,
              a.protocol AS attempt_protocol,a.endpoint AS attempt_endpoint,a.upstream_id AS attempt_upstream_id,
              a.provider_protocol,a.client_operation,a.provider_operation,
              a.model_resolution_requested_model,a.model_resolution_mapped_model,
              a.model_resolution_mapping_source,a.model_resolution_mapping_version,
              a.request_fingerprint AS attempt_request_fingerprint,a.request_fingerprint_version AS attempt_request_fingerprint_version,
              a.payload_compiler_version,a.usage_estimator_version,a.payload_sha256,
              a.route_config_id AS attempt_route_config_id,a.route_config_version AS attempt_route_config_version,
              a.route_public_model_id AS attempt_route_public_model_id,a.route_public_model_version AS attempt_route_public_model_version,
              a.route_protocol AS attempt_route_protocol,a.route_target_mode AS attempt_route_target_mode
         FROM ${TABLE} k
         LEFT JOIN saas_requests r ON r.tenant_id=k.tenant_id AND r.id=k.request_id
         LEFT JOIN saas_attempts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id AND a.ordinal=1
        WHERE k.tenant_id=$1 AND k.project_id=$2 AND k.proxy_key_id=$3 AND k.key_digest=$4`,
      [input.tenantId, input.projectId, input.proxyKeyId, keyDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) compilationUnavailable();
    const row = result.rows[0];
    const fingerprint = storedText(row.request_fingerprint, 64);
    if (!FINGERPRINT_TEXT.test(fingerprint)) compilationUnavailable();
    const fingerprintVersion = storedText(row.request_fingerprint_version, MAX_FINGERPRINT_VERSION_LENGTH);
    const binding = resolveExisting(row, { ...input, requestId: normalizeUuid(row.request_id, 'stored request id'),
      requestFingerprint: fingerprint, requestFingerprintVersion: fingerprintVersion }, keyDigest);
    if (binding.kind !== 'existing' || row.attempt_request_fingerprint !== fingerprint ||
        row.attempt_request_fingerprint_version !== fingerprintVersion || storedVersion(row.attempt_ordinal) !== '1') compilationUnavailable();
    normalizeUuid(row.attempt_id, 'canonical first attempt id');
    if (row.attempt_protocol !== row.request_protocol || row.attempt_endpoint !== row.request_endpoint ||
        row.model_resolution_requested_model !== row.public_model || row.attempt_upstream_id !== row.route_upstream_id) compilationUnavailable();
    for (const [requestValue, attemptValue] of [
      [row.route_config_id,row.attempt_route_config_id], [row.route_public_model_id,row.attempt_route_public_model_id],
      [row.route_protocol,row.attempt_route_protocol], [row.route_target_mode,row.attempt_route_target_mode],
    ]) if (storedText(requestValue) !== storedText(attemptValue)) compilationUnavailable();
    for (const [requestValue, attemptValue] of [
      [row.route_config_version,row.attempt_route_config_version], [row.route_public_model_version,row.attempt_route_public_model_version],
    ]) if (storedVersion(requestValue) !== storedVersion(attemptValue)) compilationUnavailable();
    if (row.route_protocol !== row.request_protocol || (row.route_target_mode !== 'tenant_account' && row.route_target_mode !== 'platform_pool')) compilationUnavailable();
    storedText(row.route_upstream_id);
    const requestedModel = storedText(row.model_resolution_requested_model), mappedModel = storedText(row.model_resolution_mapped_model);
    const resolvedModel = storedText(row.resolved_model), mappingSource = row.model_resolution_mapping_source;
    if (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard') compilationUnavailable();
    let mappingVersion: number | null = null;
    if (mappingSource === 'none') {
      if (row.model_resolution_mapping_version !== null || requestedModel !== mappedModel || requestedModel !== resolvedModel) compilationUnavailable();
    } else {
      mappingVersion = Number(storedVersion(row.model_resolution_mapping_version));
      if (!Number.isSafeInteger(mappingVersion)) compilationUnavailable();
    }
    if (!FINGERPRINT_TEXT.test(storedText(row.payload_sha256, 64))) compilationUnavailable();
    return {
      canonicalRequestId: binding.canonicalRequestId, providerId: storedText(row.provider_id), productId: storedText(row.product_id),
      resolvedModel, publicModel: storedText(row.public_model), endpoint: storedText(row.request_endpoint, 1024),
      clientProtocol: storedProtocol(row.attempt_protocol), providerProtocol: storedProtocol(row.provider_protocol),
      clientOperation: storedText(row.client_operation, 128), providerOperation: storedText(row.provider_operation, 128),
      modelResolution: { requestedModel, mappedModel, resolvedModel, mappingSource, mappingVersion },
      compilerVersion: storedText(row.payload_compiler_version, 128), usageEstimatorVersion: storedText(row.usage_estimator_version, 128),
      routeConfigId: storedText(row.route_config_id), routeConfigVersion: storedVersion(row.route_config_version),
      publicModelId: storedText(row.route_public_model_id), publicModelVersion: storedVersion(row.route_public_model_version),
    };
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
