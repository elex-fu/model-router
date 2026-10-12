import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
import type { SaasDatabase, SqlExecutor } from '../db/index.js';

/**
 * Track R4 OAuth account token auto-refresh worker (design:
 * docs/remaining-capability-plan-2026-10-11.md R4; migration 094).
 *
 * OAuth material (access/refresh tokens) lives only inside the existing
 * credential envelopes; the five oauth_* columns are scheduling and
 * observability state for this worker. The credential validation worker sets
 * oauth_force_refresh_requested on 401-class terminal auth failures; this
 * worker consumes and clears the flag. The gateway never writes credential
 * relations.
 *
 * Fail-closed rules:
 * - only compile-time fixed (provider, product, credential type) bindings with
 *   a pinned https token endpoint are refreshed; every other credential is
 *   excluded by the due scan itself, keeps NULL oauth state semantics, and
 *   never hot-loops;
 * - the token endpoint response contributes exactly access_token,
 *   refresh_token and expires_in; every other field is discarded;
 * - plaintext token material never leaves this module unsealed: it is not
 *   logged, not embedded in errors or outcomes, and the new secret buffer is
 *   zeroed after the rotation attempt;
 * - a successful refresh is written ONLY through the existing supply rotation
 *   path (injected as a seam; production wires the persistence service's
 *   audited replaceProviderCredentialSecretWithAudit): current_version+1, the
 *   old version retired but retained, the 058 invalidation family via
 *   authz_version bump, and the D3 revalidation requeue.
 *
 * Claim/lease semantics: each credential is claimed with SELECT ... FOR
 * UPDATE SKIP LOCKED inside one transaction that also unseals the envelope
 * and calls the bounded token endpoint (the row lock is the lease, a crash
 * rolls back and leaves the row due). A successful claim commits
 * state='refreshing' before the privileged rotation seam runs on its own
 * connection; a crash in that window is recovered by the stale-'refreshing'
 * reclamation predicate (oauth_last_refresh_at stamps the attempt start).
 */

export const OAUTH_TOKEN_REFRESH_TIMEOUT_MS = 5_000;
export const OAUTH_TOKEN_REFRESH_MAX_RESPONSE_BYTES = 4_096;
export const OAUTH_REFRESH_POLL_INTERVAL_MS = 1_000;
export const OAUTH_REFRESH_MIN_BACKOFF_MS = 60_000;
export const OAUTH_REFRESH_MAX_BACKOFF_MS = 21_600_000;
export const OAUTH_REFRESH_DEFAULT_TOKEN_TTL_MS = 3_600_000;
export const OAUTH_REFRESH_STALE_REFRESHING_MS = 900_000;
export const OAUTH_REFRESH_BATCH_SIZE = 10;
export const OAUTH_REFRESH_MIN_SUCCESS_DELAY_MS = 60_000;
export const OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS = 31_536_000;

export type OauthTokenRefreshErrorCode =
  | 'adapter_unsupported'
  | 'credential_format_invalid'
  | 'credential_unavailable'
  | 'credential_rejected'
  | 'provider_endpoint_unsupported'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected'
  | 'rotation_conflict'
  | 'rotation_failed';

export interface OauthTokenRefreshSuccess {
  readonly state: 'refreshed';
  readonly accessToken: string;
  /** null means the endpoint did not rotate the refresh token; retain the old one. */
  readonly refreshToken: string | null;
  /** null means the endpoint gave no expiry; the default TTL schedules the next refresh. */
  readonly expiresInSeconds: number | null;
  readonly adapterId: string;
  readonly httpStatus: number;
  readonly durationMs: number;
}

export interface OauthTokenRefreshFailure {
  readonly state: 'failed';
  readonly errorCode: OauthTokenRefreshErrorCode;
  readonly retryable: boolean;
  readonly adapterId: string | null;
  readonly httpStatus: number | null;
  readonly durationMs: number;
}

export type OauthTokenRefreshResult = OauthTokenRefreshSuccess | OauthTokenRefreshFailure;

export interface OauthRefreshCredentialRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly purpose: string;
}

/** The rotation seam: the only way new token material enters the version chain. */
export interface OauthCredentialRotationInput {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly expectedVersion: number;
  /** New OAuth material; sealed by the callee, never persisted as plaintext. */
  readonly secret: Uint8Array;
}

export interface OauthCredentialRotationResult {
  readonly version: number;
}

export type OauthCredentialRotator = (input: OauthCredentialRotationInput) => Promise<OauthCredentialRotationResult>;

export type OauthTokenRefreshFetch = (url: URL, init: RequestInit) => Promise<Response>;

interface FixedOauthTokenAdapter {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly adapterId: string;
  readonly tokenEndpoint: string;
  /** Public (non-confidential) OAuth client id required by the refresh grant. */
  readonly clientId: string;
}

/*
 * The only verified OAuth token bindings. Both are public OAuth clients
 * (RFC 6749 §2.1: the client id is not a secret) for the subscription
 * accounts this router's users actually connect; every product absent here
 * is skipped by the due scan (fail-closed, never guessed).
 * - Claude Code subscription: https://console.anthropic.com/v1/oauth/token
 * - Codex CLI ChatGPT account: https://auth.openai.com/oauth/token
 */
const FIXED_OAUTH_TOKEN_ADAPTERS: readonly FixedOauthTokenAdapter[] = Object.freeze([
  Object.freeze({
    providerId: 'anthropic',
    productId: 'claude-code',
    credentialType: 'oauth',
    adapterId: 'anthropic-claude-code-oauth-v1',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  }),
  Object.freeze({
    providerId: 'openai',
    productId: 'codex-cli',
    credentialType: 'oauth',
    adapterId: 'openai-codex-oauth-v1',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  }),
]);

export function resolveOauthTokenAdapter(credential: {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
}): { readonly adapterId: string; readonly tokenEndpoint: string; readonly clientId: string } | null {
  return (
    FIXED_OAUTH_TOKEN_ADAPTERS.find(
      (candidate) =>
        candidate.providerId === credential.providerId &&
        candidate.productId === credential.productId &&
        candidate.credentialType === credential.credentialType,
    ) ?? null
  );
}

function failedResult(
  errorCode: OauthTokenRefreshErrorCode,
  retryable: boolean,
  adapterId: string | null,
  httpStatus: number | null,
  durationMs: number,
): OauthTokenRefreshFailure {
  return { state: 'failed', errorCode, retryable, adapterId, httpStatus, durationMs };
}

function canonicalAdapterUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== value
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Printable ASCII token text (RFC 6749 §1.4 vschar); never logged. */
function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

/**
 * The OAuth credential envelope plaintext contract: one compact JSON object
 * carrying exactly access_token, refresh_token, token_type and (optionally)
 * expires_in. Anything else is not OAuth material for this worker.
 */
export function parseOauthCredentialMaterial(secret: Uint8Array): { readonly refreshToken: string } | null {
  let body: Fields | null;
  try {
    body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)));
  } catch {
    return null;
  }
  if (!body) return null;
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null;
  if (refreshToken === null) return null;
  return { refreshToken };
}

export function buildOauthCredentialMaterial(input: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number | null;
}): Buffer {
  const material: Fields = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    token_type: 'Bearer',
  };
  if (input.expiresInSeconds !== null) material.expires_in = input.expiresInSeconds;
  return Buffer.from(JSON.stringify(material), 'utf8');
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

type BoundedBodyResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' }
  | { readonly state: 'timeout' };

async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<BoundedBodyResult> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const buffer = new Uint8Array(OAUTH_TOKEN_REFRESH_MAX_RESPONSE_BYTES);
  let bytesRead = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer.subarray(0, bytesRead) };
      if (!(value instanceof Uint8Array)) {
        cancel();
        return { state: 'read_error' };
      }
      if (value.byteLength > OAUTH_TOKEN_REFRESH_MAX_RESPONSE_BYTES - bytesRead) {
        cancel();
        return { state: 'too_large' };
      }
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    cancel();
    return { state: signal.aborted ? 'timeout' : 'read_error' };
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
}

/** Only access_token, refresh_token and expires_in survive; everything else is discarded. */
function parseTokenEndpointResponse(
  bytes: Uint8Array,
): { accessToken: string; refreshToken: string | null; expiresInSeconds: number | null } | null {
  let body: Fields | null;
  try {
    body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
  if (!body) return null;
  const accessToken = tokenText(body.access_token);
  if (accessToken === null) return null;
  let refreshToken: string | null = null;
  if (body.refresh_token !== undefined) {
    refreshToken = tokenText(body.refresh_token);
    if (refreshToken === null) return null;
  }
  let expiresInSeconds: number | null = null;
  if (body.expires_in !== undefined) {
    const raw = body.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS) return null;
    expiresInSeconds = parsed;
  }
  return { accessToken, refreshToken, expiresInSeconds };
}

/**
 * Calls the fixed provider OAuth token endpoint with the refresh_token grant.
 * Every failure mode returns state 'failed'; this function never throws and
 * never surfaces token material in its results beyond the parsed secrets,
 * which the caller seals or discards.
 */
export async function requestOauthTokenRefresh(
  credential: { readonly providerId: string; readonly productId: string; readonly credentialType: string },
  refreshToken: string,
  fetcher: OauthTokenRefreshFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<OauthTokenRefreshResult> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const adapter = resolveOauthTokenAdapter(credential);
  if (!adapter) return failedResult('adapter_unsupported', false, null, null, 0);
  const url = canonicalAdapterUrl(adapter.tokenEndpoint);
  if (!url) return failedResult('adapter_unsupported', false, adapter.adapterId, null, 0);
  if (tokenText(refreshToken) === null) {
    return failedResult('credential_format_invalid', false, adapter.adapterId, null, elapsed());
  }

  const deadline = AbortSignal.timeout(OAUTH_TOKEN_REFRESH_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const form = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(adapter.clientId)}`;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'model-router',
      },
      body: form,
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    const isTimeout = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    return failedResult(
      isTimeout ? 'provider_timeout' : 'provider_network_error',
      true,
      adapter.adapterId,
      null,
      elapsed(),
    );
  }

  if (timeoutSignal.aborted) {
    cancelResponseBody(response);
    return failedResult('provider_timeout', true, adapter.adapterId, response.status, elapsed());
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > OAUTH_TOKEN_REFRESH_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return failedResult('provider_response_too_large', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return failedResult('provider_redirect_rejected', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.status < 200 || response.status >= 300) {
    cancelResponseBody(response);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return failedResult('credential_rejected', false, adapter.adapterId, response.status, elapsed());
    }
    if (response.status === 429) {
      return failedResult('provider_rate_limited', true, adapter.adapterId, response.status, elapsed());
    }
    if (response.status >= 500) {
      return failedResult('provider_unavailable', true, adapter.adapterId, response.status, elapsed());
    }
    return failedResult('provider_endpoint_unsupported', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    cancelResponseBody(response);
    return failedResult('provider_response_invalid', false, adapter.adapterId, response.status, elapsed());
  }
  const bodyResult = await boundedResponseBody(response, timeoutSignal);
  if (bodyResult.state === 'too_large') {
    return failedResult('provider_response_too_large', false, adapter.adapterId, response.status, elapsed());
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return failedResult(
      bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error',
      true,
      adapter.adapterId,
      response.status,
      elapsed(),
    );
  }
  const parsed = parseTokenEndpointResponse(bodyResult.bytes);
  if (!parsed) {
    return failedResult('provider_response_invalid', false, adapter.adapterId, response.status, elapsed());
  }
  return {
    state: 'refreshed',
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresInSeconds: parsed.expiresInSeconds,
    adapterId: adapter.adapterId,
    httpStatus: response.status,
    durationMs: elapsed(),
  };
}

/** Exponential failure backoff: 1m, 2m, 4m, ... capped at 6h, stateless across restarts. */
export function oauthRefreshFailureBackoffMs(previousIntervalMs: number | null): number {
  if (previousIntervalMs === null || !Number.isFinite(previousIntervalMs)) {
    return OAUTH_REFRESH_MIN_BACKOFF_MS;
  }
  // The previous interval derives from two clock_timestamp() reads whose
  // sub-millisecond skew must not reset the ladder.
  const rounded = Math.round(previousIntervalMs);
  if (rounded < OAUTH_REFRESH_MIN_BACKOFF_MS) return OAUTH_REFRESH_MIN_BACKOFF_MS;
  return Math.min(OAUTH_REFRESH_MAX_BACKOFF_MS, rounded * 2);
}

function jitterFraction(credentialId: string): number {
  const digest = createHash('sha256').update('oauth-refresh-jitter').update(credentialId).digest();
  const unit = digest.readUInt32BE(0) / 0xffffffff;
  return (unit * 2 - 1) * 0.1;
}

/** expires_in × 0.8 with a deterministic ±10% jitter keyed by credential id. */
export function oauthRefreshSuccessDelayMs(
  credentialId: string,
  expiresInSeconds: number | null,
  defaultTtlMs: number = OAUTH_REFRESH_DEFAULT_TOKEN_TTL_MS,
): number {
  const ttlMs = expiresInSeconds === null ? defaultTtlMs : expiresInSeconds * 1_000;
  const delay = Math.round(ttlMs * 0.8 * (1 + jitterFraction(credentialId)));
  return Math.max(OAUTH_REFRESH_MIN_SUCCESS_DELAY_MS, delay);
}

export type OauthTokenRefreshWorkerErrorCode = 'STORE_UNAVAILABLE' | 'LEASE_LOST';

export class OauthTokenRefreshWorkerError extends Error {
  constructor(readonly code: OauthTokenRefreshWorkerErrorCode) {
    super(
      code === 'LEASE_LOST'
        ? 'OAuth token refresh claim is no longer current'
        : 'OAuth token refresh store is unavailable',
    );
    this.name = 'OauthTokenRefreshWorkerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function workerError(code: OauthTokenRefreshWorkerErrorCode): OauthTokenRefreshWorkerError {
  return new OauthTokenRefreshWorkerError(code);
}

function leaseLost(): never {
  throw workerError('LEASE_LOST');
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes(' ')) {
    throw workerError('STORE_UNAVAILABLE');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw workerError('STORE_UNAVAILABLE');
  return result;
}

function positiveBound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min) return min;
  return Math.min(value, max);
}

function strictBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw workerError('STORE_UNAVAILABLE');
  return value;
}

export type OauthRefreshOwnerKind = 'tenant' | 'platform';

interface OauthRefreshOwnerScope {
  readonly ownerKind: OauthRefreshOwnerKind;
  readonly supplyMode: 'byok' | 'platform';
  readonly accounts: string;
  readonly credentials: string;
  readonly versions: string;
  readonly wrappings: string;
}

const TENANT_OWNER_SCOPE: OauthRefreshOwnerScope = Object.freeze({
  ownerKind: 'tenant',
  supplyMode: 'byok',
  accounts: 'saas_tenant_provider_accounts',
  credentials: 'saas_tenant_provider_credentials',
  versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
});
const PLATFORM_OWNER_SCOPE: OauthRefreshOwnerScope = Object.freeze({
  ownerKind: 'platform',
  supplyMode: 'platform',
  accounts: 'saas_platform_provider_accounts',
  credentials: 'saas_platform_provider_credentials',
  versions: 'saas_platform_provider_credential_versions',
  wrappings: 'saas_platform_provider_credential_wrappings',
});
const OAUTH_REFRESH_OWNER_SCOPES: Readonly<Record<OauthRefreshOwnerKind, OauthRefreshOwnerScope>> = Object.freeze({
  tenant: TENANT_OWNER_SCOPE,
  platform: PLATFORM_OWNER_SCOPE,
});

const DEFAULT_OAUTH_REFRESH_OWNERS = ['tenant', 'platform'] as const satisfies readonly OauthRefreshOwnerKind[];

function ownerScopes(owners: readonly OauthRefreshOwnerKind[] | undefined): readonly OauthRefreshOwnerScope[] {
  if (owners !== undefined && (!Array.isArray(owners) || owners.length === 0)) {
    throw workerError('STORE_UNAVAILABLE');
  }
  const requested: readonly OauthRefreshOwnerKind[] = owners ?? DEFAULT_OAUTH_REFRESH_OWNERS;
  const scopes: OauthRefreshOwnerScope[] = [];
  for (const owner of requested) {
    const scope = OAUTH_REFRESH_OWNER_SCOPES[owner];
    if (scope === undefined || scopes.includes(scope)) throw workerError('STORE_UNAVAILABLE');
    scopes.push(scope);
  }
  return Object.freeze(scopes);
}

export interface PostgresOauthTokenRefreshWorkerStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  /** Owner credential tables scanned in poll order; tenant/BYOK first by default. */
  readonly owners?: readonly OauthRefreshOwnerKind[];
  /**
   * A 'refreshing' row whose attempt stamp is older than this is reclaimable
   * (crash recovery between the committed claim and the finalize write).
   */
  readonly staleRefreshingMs?: number;
  /** Fallback token lifetime used when the endpoint omits expires_in. */
  readonly defaultTokenTtlMs?: number;
  /** Test/custom seam; production uses the global fetch with fixed adapter URLs. */
  readonly fetch?: OauthTokenRefreshFetch;
  /** Worker-owned lifetime; an abort rolls the in-flight claim back. */
  readonly signal?: AbortSignal;
}

export type OauthRefreshStoreOutcome =
  | { readonly outcome: 'idle' }
  | {
      readonly outcome: 'refreshed';
      readonly ownerKind: OauthRefreshOwnerKind;
      readonly credentialId: string;
      readonly version: number;
    }
  | {
      readonly outcome: 'failed';
      readonly ownerKind: OauthRefreshOwnerKind;
      readonly credentialId: string;
      readonly errorCode: OauthTokenRefreshErrorCode;
    };

interface ClaimedCredentialRow {
  tenant_id?: string;
  id: string;
  account_id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  current_version: number | string;
  oauth_refresh_state: string;
  oauth_next_refresh_at: Date | string | null;
  oauth_last_refresh_at: Date | string | null;
  purpose: string;
}

interface LockedVersionRow {
  version: number | string;
  schema_version: number | string;
  context_version: number | string;
  algorithm: string;
  kms_purpose: string;
  kms_key_id: string;
  wrapped_dek: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

interface ClaimedCredential {
  readonly ref: OauthRefreshCredentialRef;
  readonly currentVersion: number;
  readonly previousState: string;
  readonly previousIntervalMs: number | null;
}

type PreparedClaim =
  | { readonly kind: 'failed'; readonly claimed: ClaimedCredential; readonly errorCode: OauthTokenRefreshErrorCode }
  | {
      readonly kind: 'ready';
      readonly claimed: ClaimedCredential;
      readonly newSecret: Buffer;
      readonly expiresInSeconds: number | null;
    };

const ADAPTER_PROVIDER_IDS = FIXED_OAUTH_TOKEN_ADAPTERS.map((adapter) => adapter.providerId);
const ADAPTER_PRODUCT_IDS = FIXED_OAUTH_TOKEN_ADAPTERS.map((adapter) => adapter.productId);
const ADAPTER_CREDENTIAL_TYPES = FIXED_OAUTH_TOKEN_ADAPTERS.map((adapter) => adapter.credentialType);

function timestampMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function failureDelayMs(claimed: ClaimedCredential): number {
  return oauthRefreshFailureBackoffMs(claimed.previousState === 'failed' ? claimed.previousIntervalMs : null);
}

/**
 * Claim, unseal, token call and the failure write run in ONE transaction per
 * credential: the SKIP LOCKED row lock is the lease and a rollback is the
 * requeue. Only the privileged rotation seam and the finalize write run after
 * that commit, bridged by the crash-safe 'refreshing' state. Plaintext token
 * material exists only inside the unseal callback and the in-memory new
 * secret buffer, which is zeroed after the rotation attempt.
 */
export class PostgresOauthTokenRefreshWorkerStore {
  private readonly scopes: readonly OauthRefreshOwnerScope[];
  private readonly staleRefreshingMs: number;
  private readonly defaultTokenTtlMs: number;

  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: PostgresOauthTokenRefreshWorkerStoreOptions,
  ) {
    if (!options || typeof options !== 'object') throw workerError('STORE_UNAVAILABLE');
    safeText(options.deployment);
    safeText(options.environment);
    this.scopes = ownerScopes(options.owners);
    this.staleRefreshingMs = positiveBound(
      options.staleRefreshingMs ?? OAUTH_REFRESH_STALE_REFRESHING_MS,
      60_000,
      3_600_000,
    );
    this.defaultTokenTtlMs = positiveBound(
      options.defaultTokenTtlMs ?? OAUTH_REFRESH_DEFAULT_TOKEN_TTL_MS,
      60_000,
      86_400_000,
    );
  }

  private async safeTransaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async (tx) => {
        if (this.options.signal?.aborted) leaseLost();
        const result = await work(tx);
        if (this.options.signal?.aborted) leaseLost();
        return result;
      });
    } catch (error) {
      if (error instanceof OauthTokenRefreshWorkerError) throw error;
      throw workerError('STORE_UNAVAILABLE');
    }
  }

  async refreshNext(rotator: OauthCredentialRotator): Promise<OauthRefreshStoreOutcome> {
    if (typeof rotator !== 'function') throw workerError('STORE_UNAVAILABLE');
    for (const scope of this.scopes) {
      const outcome = await this.refreshNextInScope(scope, rotator);
      if (outcome !== null) return outcome;
    }
    return { outcome: 'idle' };
  }

  private duePredicate(): string {
    return `
          AND credential.status = 'active' AND account.status = 'active'
          AND credential.current_version IS NOT NULL
          AND (credential.provider_id, credential.product_id, credential.credential_type) IN (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
          )
          AND (
            (credential.oauth_refresh_state IN ('idle', 'failed')
              AND (credential.oauth_force_refresh_requested = true
                OR credential.oauth_next_refresh_at <= clock_timestamp()))
            OR (credential.oauth_refresh_state = 'refreshing'
              AND credential.oauth_last_refresh_at <= clock_timestamp() - ($4 * interval '1 millisecond'))
          )`;
  }

  private candidateSelect(scope: OauthRefreshOwnerScope): string {
    const tenantColumns = scope.ownerKind === 'tenant' ? 'credential.tenant_id, ' : '';
    const tenantJoin =
      scope.ownerKind === 'tenant'
        ? 'account.tenant_id = credential.tenant_id AND account.id = credential.account_id'
        : 'account.id = credential.account_id';
    return `SELECT ${tenantColumns}credential.id, credential.account_id, credential.provider_id,
                credential.product_id, credential.credential_type, credential.current_version,
                credential.oauth_refresh_state, credential.oauth_next_refresh_at,
                credential.oauth_last_refresh_at, account.purpose
           FROM ${scope.credentials} AS credential
           JOIN ${scope.accounts} AS account
             ON ${tenantJoin}
            AND account.provider_id = credential.provider_id
            AND account.product_id = credential.product_id
          WHERE TRUE${this.duePredicate()}
          ORDER BY credential.oauth_force_refresh_requested DESC,
                   credential.oauth_next_refresh_at ASC NULLS LAST, credential.id
          LIMIT 1`;
  }

  private lockSelect(scope: OauthRefreshOwnerScope): string {
    const tenantColumns = scope.ownerKind === 'tenant' ? 'credential.tenant_id, ' : '';
    const tenantJoin =
      scope.ownerKind === 'tenant'
        ? 'account.tenant_id = credential.tenant_id AND account.id = credential.account_id'
        : 'account.id = credential.account_id';
    const identity =
      scope.ownerKind === 'tenant' ? 'credential.tenant_id = $5 AND credential.id = $6' : 'credential.id = $5';
    return `SELECT ${tenantColumns}credential.id, credential.account_id, credential.provider_id,
                credential.product_id, credential.credential_type, credential.current_version,
                credential.oauth_refresh_state, credential.oauth_next_refresh_at,
                credential.oauth_last_refresh_at, account.purpose
           FROM ${scope.credentials} AS credential
           JOIN ${scope.accounts} AS account
             ON ${tenantJoin}
            AND account.provider_id = credential.provider_id
            AND account.product_id = credential.product_id
          WHERE ${identity}${this.duePredicate()}
          FOR UPDATE OF credential SKIP LOCKED`;
  }

  private async refreshNextInScope(
    scope: OauthRefreshOwnerScope,
    rotator: OauthCredentialRotator,
  ): Promise<OauthRefreshStoreOutcome | null> {
    const prepared = await this.safeTransaction(async (tx): Promise<PreparedClaim | null> => {
      const candidates = await tx.query<ClaimedCredentialRow>(this.candidateSelect(scope), [
        ADAPTER_PROVIDER_IDS,
        ADAPTER_PRODUCT_IDS,
        ADAPTER_CREDENTIAL_TYPES,
        this.staleRefreshingMs,
      ]);
      const candidate = candidates.rows[0];
      if (!candidate) return null;

      const locked = await tx.query<ClaimedCredentialRow>(
        this.lockSelect(scope),
        scope.ownerKind === 'tenant'
          ? [
              ADAPTER_PROVIDER_IDS,
              ADAPTER_PRODUCT_IDS,
              ADAPTER_CREDENTIAL_TYPES,
              this.staleRefreshingMs,
              candidate.tenant_id,
              candidate.id,
            ]
          : [ADAPTER_PROVIDER_IDS, ADAPTER_PRODUCT_IDS, ADAPTER_CREDENTIAL_TYPES, this.staleRefreshingMs, candidate.id],
      );
      const row = locked.rows[0];
      if (!row) return null;

      const nextAt = timestampMs(row.oauth_next_refresh_at);
      const lastAt = timestampMs(row.oauth_last_refresh_at);
      const claimed: ClaimedCredential = Object.freeze({
        ref: Object.freeze({
          ownerKind: scope.ownerKind,
          tenantId: scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null,
          accountId: safeText(row.account_id),
          credentialId: safeText(row.id),
          providerId: safeText(row.provider_id),
          productId: safeText(row.product_id),
          credentialType: safeText(row.credential_type),
          purpose: safeText(row.purpose),
        }),
        currentVersion: positiveInteger(row.current_version),
        previousState: safeText(row.oauth_refresh_state),
        previousIntervalMs: nextAt !== null && lastAt !== null && nextAt > lastAt ? nextAt - lastAt : null,
      });

      const refreshed = await this.attemptRefresh(tx, scope, claimed);
      if (this.options.signal?.aborted) leaseLost();
      if (refreshed.kind === 'failed') {
        await this.writeFailure(tx, scope, claimed.ref, refreshed.errorCode, failureDelayMs(claimed));
        return { kind: 'failed', claimed, errorCode: refreshed.errorCode };
      }
      await this.writeRefreshing(tx, scope, claimed.ref);
      return {
        kind: 'ready',
        claimed,
        newSecret: refreshed.newSecret,
        expiresInSeconds: refreshed.expiresInSeconds,
      };
    });

    if (prepared === null) return null;
    if (prepared.kind === 'failed') {
      return {
        outcome: 'failed',
        ownerKind: scope.ownerKind,
        credentialId: prepared.claimed.ref.credentialId,
        errorCode: prepared.errorCode,
      };
    }

    const { claimed, newSecret, expiresInSeconds } = prepared;
    let rotatedVersion: number | null = null;
    let rotationError: OauthTokenRefreshErrorCode | null = null;
    try {
      const rotated = await rotator({
        ownerKind: claimed.ref.ownerKind,
        tenantId: claimed.ref.tenantId,
        accountId: claimed.ref.accountId,
        credentialId: claimed.ref.credentialId,
        expectedVersion: claimed.currentVersion,
        secret: newSecret,
      });
      rotatedVersion = positiveInteger(rotated?.version);
    } catch (error) {
      rotationError =
        (error as { code?: string } | null)?.code === 'CREDENTIAL_VERSION_CONFLICT'
          ? 'rotation_conflict'
          : 'rotation_failed';
    } finally {
      newSecret.fill(0);
    }
    if (this.options.signal?.aborted) leaseLost();

    return this.safeTransaction(async (tx) => {
      if (rotationError !== null || rotatedVersion === null) {
        const errorCode = rotationError ?? 'rotation_failed';
        await this.writeFailure(tx, scope, claimed.ref, errorCode, failureDelayMs(claimed));
        return {
          outcome: 'failed',
          ownerKind: scope.ownerKind,
          credentialId: claimed.ref.credentialId,
          errorCode,
        };
      }
      const delayMs = oauthRefreshSuccessDelayMs(claimed.ref.credentialId, expiresInSeconds, this.defaultTokenTtlMs);
      const finalized = await this.writeRefreshed(tx, scope, claimed.ref, rotatedVersion, delayMs);
      if (!finalized) leaseLost();
      return {
        outcome: 'refreshed',
        ownerKind: scope.ownerKind,
        credentialId: claimed.ref.credentialId,
        version: rotatedVersion,
      };
    });
  }

  /**
   * Unseals the claimed credential's current version and runs the bounded
   * token endpoint call. Unavailable or inconsistent credential authority is
   * a failed outcome, never a store failure; the row lock is already held.
   */
  private async attemptRefresh(
    tx: SqlExecutor,
    scope: OauthRefreshOwnerScope,
    claimed: ClaimedCredential,
  ): Promise<
    | { readonly kind: 'failed'; readonly errorCode: OauthTokenRefreshErrorCode }
    | { readonly kind: 'refreshed'; readonly newSecret: Buffer; readonly expiresInSeconds: number | null }
  > {
    const { ref } = claimed;
    const versions = await tx.query<LockedVersionRow>(
      scope.ownerKind === 'tenant'
        ? `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${scope.versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${scope.wrappings}
                WHERE tenant_id = version_row.tenant_id AND account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.tenant_id = $1 AND version_row.account_id = $2
              AND version_row.credential_id = $3 AND version_row.version = $4
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`
        : `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${scope.versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${scope.wrappings}
                WHERE account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.account_id = $1
              AND version_row.credential_id = $2 AND version_row.version = $3
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`,
      scope.ownerKind === 'tenant'
        ? [ref.tenantId, ref.accountId, ref.credentialId, claimed.currentVersion]
        : [ref.accountId, ref.credentialId, claimed.currentVersion],
    );
    const version = versions.rows[0];
    if (!version || version.kms_purpose !== ref.purpose) {
      return { kind: 'failed', errorCode: 'credential_unavailable' };
    }
    if (
      positiveInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      positiveInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return { kind: 'failed', errorCode: 'credential_unavailable' };
    }

    const context: ProviderCredentialContext = createProviderCredentialContext(
      scope.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: ref.purpose,
            providerId: ref.providerId,
            productId: ref.productId,
            credentialType: ref.credentialType,
            accountId: ref.accountId,
            credentialId: ref.credentialId,
            credentialVersion: claimed.currentVersion,
          }
        : {
            ownerKind: 'tenant',
            tenantId: ref.tenantId as string,
            supplyMode: 'byok',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: ref.purpose,
            providerId: ref.providerId,
            productId: ref.productId,
            credentialType: ref.credentialType,
            accountId: ref.accountId,
            credentialId: ref.credentialId,
            credentialVersion: claimed.currentVersion,
          },
    );
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

    let result:
      | { readonly kind: 'failed'; readonly errorCode: OauthTokenRefreshErrorCode }
      | { readonly kind: 'refreshed'; readonly newSecret: Buffer; readonly expiresInSeconds: number | null }
      | undefined;
    try {
      await withUnsealedProviderCredential(envelope, context, this.kms, async (secret) => {
        const material = parseOauthCredentialMaterial(secret);
        if (!material) {
          result = { kind: 'failed', errorCode: 'credential_unavailable' };
          return;
        }
        if (tokenText(material.refreshToken) === null) {
          result = { kind: 'failed', errorCode: 'credential_format_invalid' };
          return;
        }
        const refresh = await requestOauthTokenRefresh(
          ref,
          material.refreshToken,
          this.options.fetch,
          this.options.signal,
        );
        if (refresh.state === 'failed') {
          result = { kind: 'failed', errorCode: refresh.errorCode };
          return;
        }
        result = {
          kind: 'refreshed',
          newSecret: buildOauthCredentialMaterial({
            accessToken: refresh.accessToken,
            refreshToken: refresh.refreshToken ?? material.refreshToken,
            expiresInSeconds: refresh.expiresInSeconds,
          }),
          expiresInSeconds: refresh.expiresInSeconds,
        };
      });
    } catch {
      return { kind: 'failed', errorCode: 'credential_unavailable' };
    }
    return result ?? { kind: 'failed', errorCode: 'credential_unavailable' };
  }

  private async writeRefreshing(
    tx: SqlExecutor,
    scope: OauthRefreshOwnerScope,
    ref: OauthRefreshCredentialRef,
  ): Promise<void> {
    const wrote = await tx.query(
      scope.ownerKind === 'tenant'
        ? `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'refreshing', oauth_refresh_error_code = NULL,
                  oauth_last_refresh_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND oauth_refresh_state IS NOT NULL`
        : `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'refreshing', oauth_refresh_error_code = NULL,
                  oauth_last_refresh_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1 AND oauth_refresh_state IS NOT NULL`,
      scope.ownerKind === 'tenant' ? [ref.tenantId, ref.credentialId] : [ref.credentialId],
    );
    if (wrote.rowCount !== 1) leaseLost();
  }

  private async writeRefreshed(
    tx: SqlExecutor,
    scope: OauthRefreshOwnerScope,
    ref: OauthRefreshCredentialRef,
    version: number,
    delayMs: number,
  ): Promise<boolean> {
    const wrote = await tx.query(
      scope.ownerKind === 'tenant'
        ? `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'idle', oauth_refresh_error_code = NULL,
                  oauth_force_refresh_requested = false,
                  oauth_last_refresh_at = clock_timestamp(),
                  oauth_next_refresh_at = clock_timestamp() + ($3 * interval '1 millisecond'),
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2
              AND oauth_refresh_state = 'refreshing' AND current_version = $4`
        : `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'idle', oauth_refresh_error_code = NULL,
                  oauth_force_refresh_requested = false,
                  oauth_last_refresh_at = clock_timestamp(),
                  oauth_next_refresh_at = clock_timestamp() + ($2 * interval '1 millisecond'),
                  updated_at = clock_timestamp()
            WHERE id = $1
              AND oauth_refresh_state = 'refreshing' AND current_version = $3`,
      scope.ownerKind === 'tenant'
        ? [ref.tenantId, ref.credentialId, delayMs, version]
        : [ref.credentialId, delayMs, version],
    );
    return wrote.rowCount === 1;
  }

  private async writeFailure(
    tx: SqlExecutor,
    scope: OauthRefreshOwnerScope,
    ref: OauthRefreshCredentialRef,
    errorCode: OauthTokenRefreshErrorCode,
    delayMs: number,
  ): Promise<void> {
    const wrote = await tx.query(
      scope.ownerKind === 'tenant'
        ? `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'failed', oauth_refresh_error_code = $3,
                  oauth_force_refresh_requested = false,
                  oauth_last_refresh_at = clock_timestamp(),
                  oauth_next_refresh_at = clock_timestamp() + ($4 * interval '1 millisecond'),
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2`
        : `UPDATE ${scope.credentials}
              SET oauth_refresh_state = 'failed', oauth_refresh_error_code = $2,
                  oauth_force_refresh_requested = false,
                  oauth_last_refresh_at = clock_timestamp(),
                  oauth_next_refresh_at = clock_timestamp() + ($3 * interval '1 millisecond'),
                  updated_at = clock_timestamp()
            WHERE id = $1`,
      scope.ownerKind === 'tenant'
        ? [ref.tenantId, ref.credentialId, errorCode, delayMs]
        : [ref.credentialId, errorCode, delayMs],
    );
    if (wrote.rowCount !== 1) leaseLost();
  }
}

export interface OauthTokenRefreshWorkerOptions extends PostgresOauthTokenRefreshWorkerStoreOptions {
  readonly pollIntervalMs?: number;
  /** Maximum credentials claimed per runOnce cycle (1 .. 100; out of range fails closed). */
  readonly batchSize?: number;
  /** Receives only a stable cycle code; never provider, credential or token data. */
  readonly onError?: (code: 'cycle_failed') => void;
}

export type OauthTokenRefreshWorkerResult = 'idle' | 'processed' | 'stale';

export class OauthTokenRefreshWorker {
  private readonly store: PostgresOauthTokenRefreshWorkerStore;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<OauthTokenRefreshWorkerResult>>();
  private readonly batchSize: number;
  private closePromise?: Promise<void>;

  constructor(
    database: SaasDatabase,
    kms: ProviderCredentialUnsealingKms,
    private readonly rotator: OauthCredentialRotator,
    private readonly options: OauthTokenRefreshWorkerOptions,
  ) {
    if (typeof rotator !== 'function') throw workerError('STORE_UNAVAILABLE');
    this.options = Object.freeze({ ...options });
    this.batchSize = strictBatchSize(this.options.batchSize ?? OAUTH_REFRESH_BATCH_SIZE);
    this.store = new PostgresOauthTokenRefreshWorkerStore(database, kms, {
      ...this.options,
      signal: this.halt.signal,
    });
  }

  async runOnce(): Promise<OauthTokenRefreshWorkerResult> {
    if (this.halt.signal.aborted) return 'stale';
    const run = this.processOnce();
    this.activeRuns.add(run);
    try {
      return await run;
    } catch (error) {
      if (this.halt.signal.aborted) return 'stale';
      throw error;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async processOnce(): Promise<OauthTokenRefreshWorkerResult> {
    let processed = 0;
    try {
      while (processed < this.batchSize) {
        const outcome = await this.store.refreshNext(this.rotator);
        if (this.halt.signal.aborted) return 'stale';
        if (outcome.outcome === 'idle') break;
        processed += 1;
      }
      return processed > 0 ? 'processed' : 'idle';
    } catch (error) {
      if (this.halt.signal.aborted) return 'stale';
      if (error instanceof OauthTokenRefreshWorkerError && error.code === 'LEASE_LOST') return 'stale';
      throw error;
    }
  }

  async run(): Promise<void> {
    const pollIntervalMs = positiveBound(this.options.pollIntervalMs ?? OAUTH_REFRESH_POLL_INTERVAL_MS, 100, 60_000);
    while (!this.halt.signal.aborted) {
      try {
        const result = await this.runOnce();
        if (result === 'idle') await delay(pollIntervalMs, this.halt.signal);
      } catch {
        try {
          this.options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate refresh processing.
        }
        await delay(pollIntervalMs, this.halt.signal);
      }
    }
  }

  /** Aborts in-flight token calls and drains actual runs before KMS/database close. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns]).then(() => undefined);
    return this.closePromise;
  }
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface OauthTokenRefreshWorkerHandle {
  close(): Promise<void>;
}

export function startOauthTokenRefreshWorker(
  database: SaasDatabase,
  kms: ProviderCredentialUnsealingKms,
  rotator: OauthCredentialRotator,
  options: OauthTokenRefreshWorkerOptions,
): OauthTokenRefreshWorkerHandle {
  const worker = new OauthTokenRefreshWorker(database, kms, rotator, options);
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
    const pollIntervalMs = positiveBound(options.pollIntervalMs ?? OAUTH_REFRESH_POLL_INTERVAL_MS, 100, 60_000);
    while (!closed) {
      try {
        const result = await worker.runOnce();
        if (closed) break;
        if (result === 'idle') await delayWithClose(pollIntervalMs);
      } catch {
        if (closed) break;
        try {
          options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate refresh processing.
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
      const closeWorker = worker.close();
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await Promise.all([closeWorker, done]);
    },
  };
}
