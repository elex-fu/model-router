import { createHash } from 'node:crypto';
import { canonicalTokenEndpoint, type OAuthRefreshAdapter } from './adapters.js';

/**
 * Neutral OAuth refresh engine core (design:
 * docs/oauth-refresh-engine-unification-plan-20261101.md §2.1).
 *
 * The single network/parse/classify implementation for both refresh planes:
 * one refresh_token grant round-trip (form build, bounded response contract,
 * strict token-response parse, failure taxonomy), plus the backoff ladder and
 * the expiry-margin predicate. Core is stateless and store-free — scheduling
 * state (singleflight, sweep cadence, leases, backoff stamps) stays with each
 * plane's shell.
 *
 * Extracted from the two formerly identical implementations:
 * src/server/oauth-refresh.ts (classic) and
 * src/saas/supply/oauth-token-refresh-worker.ts (SaaS). Where they disagree
 * the stricter, more defensive reading wins; every such divergence is marked
 * with a "DIVERGENCE" comment below.
 */

export const OAUTH_REFRESH_TIMEOUT_MS = 5_000;
/**
 * Response byte cap. DIVERGENCE: the SaaS worker capped at 4_096, classic at
 * 65_536 — the stricter SaaS cap wins. Consequences noted for the classic
 * plane: an id_token longer than the cap (classic parsed up to 32_768 chars)
 * can no longer appear because the whole response is rejected first, and any
 * response between 4_096 and 65_536 bytes now classifies as too large.
 */
export const OAUTH_REFRESH_MAX_RESPONSE_BYTES = 4_096;
export const OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS = 31_536_000;
export const OAUTH_REFRESH_MIN_BACKOFF_MS = 60_000;
/**
 * DIVERGENCE: classic capped failure backoff at 24h, the SaaS worker at 6h.
 * The ladder itself is shared; each plane passes its own cap, and this
 * default (24h) matches the classic engine's exported constant.
 */
export const OAUTH_REFRESH_MAX_BACKOFF_MS = 24 * 60 * 60_000;

/**
 * Terminal RFC 6749 §5.2 / provider-specific rejections: the grant is gone
 * (revoked, expired or rotated elsewhere). An account that fails with one of
 * these is never auto-refreshed again. DIVERGENCE: only the classic plane
 * classified these terminal (the SaaS worker records the provider error code
 * but keeps the failure ladder); the defensive classic reading wins.
 */
export const NON_RETRYABLE_OAUTH_ERRORS: readonly string[] = Object.freeze([
  'invalid_grant',
  'refresh_token_reused',
  'token_expired',
  'app_session_terminated',
  'refresh_token_invalidated',
]);

/**
 * Neutral error taxonomy: the union of both planes' transport/parse
 * classifications. Each shell maps these onto its own public error codes.
 */
export type CoreRefreshErrorCode =
  /** No fixed adapter, or the adapter's token endpoint failed canonical validation. */
  | 'adapter_unsupported'
  /** The refresh token failed the printable-token contract. */
  | 'credential_invalid'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  /** 400/401/403 from the token endpoint; see outcome.oauthError for the §5.2 code. */
  | 'endpoint_rejected'
  /** 3xx redirect the core will not follow. */
  | 'redirect_rejected'
  /** Unexpected non-2xx status. */
  | 'endpoint_unsupported'
  /** 2xx whose body is not a valid token response. */
  | 'response_invalid'
  /** Declared or streamed response body over the byte cap. */
  | 'response_too_large';

/**
 * Outcome kinds. 'terminal' is the revoked class (NON_RETRYABLE_OAUTH_ERRORS);
 * 'retryable' failures re-run on the backoff ladder; 'failure' is the
 * non-retryable non-terminal middle (bad response shapes, unsupported
 * statuses — the classic plane backs these off at the max cap); 'unsupported'
 * is not the account's fault (no adapter / unusable credential). 'backing-off'
 * is an engine-scheduling state shells may construct; the stateless core
 * never emits it.
 */
export type RefreshOutcomeKind = 'success' | 'terminal' | 'retryable' | 'failure' | 'unsupported' | 'backing-off';

/** Normalized account snapshot the engine core refreshes (mapped in by each plane). */
export interface RefreshableCredential {
  /** Lease/singleflight key (classic: `${provider}:${accountId}`; SaaS: ownerKind:accountId:credentialId). */
  readonly key: string;
  /** Normalized provider id (see the adapters registry). */
  readonly providerId: string;
  readonly refreshToken: string;
  readonly expiresAtMs: number | null;
}

/** The parsed token response a plane commits through its store. */
export interface RefreshWriteback {
  readonly key: string;
  readonly accessToken: string;
  /** null means the endpoint did not rotate the refresh token; retain the old one. */
  readonly refreshToken: string | null;
  /** id_token when the endpoint returns one (parsed, not persisted by the classic engine). */
  readonly idToken: string | null;
  /** null when the endpoint gave no expiry. */
  readonly expiresAtMs: number | null;
  /** Raw expires_in as the endpoint returned it (SaaS schedules on 0.8 × expires_in). */
  readonly expiresInSeconds: number | null;
  /** Response fields the binding preserves across a rotation (SaaS envelope passthrough). */
  readonly passthrough?: Readonly<Record<string, string>>;
}

export interface RefreshOutcome {
  readonly kind: RefreshOutcomeKind;
  /** null on success. */
  readonly errorCode: CoreRefreshErrorCode | null;
  /** RFC 6749 §5.2 error code from a rejection body, or null. Never token material. */
  readonly oauthError: string | null;
  readonly httpStatus: number | null;
  /** Optional engine-scheduling hint; the stateless core leaves it unset. */
  readonly retryAfterMs?: number;
}

export interface OAuthRefreshAttempt {
  readonly outcome: RefreshOutcome;
  readonly writeback: RefreshWriteback | null;
}

export type OAuthRefreshFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PerformOAuthRefreshOptions {
  /** Clock used for the writeback expiry; default Date.now(). */
  readonly nowMs?: number;
  /** External abort (worker shutdown); aborts classify as timeout (retryable). */
  readonly signal?: AbortSignal;
}

/**
 * The store contract each plane adapts (plan §2.3). `commit` may be
 * synchronous (the classic JSON store fails fast) or asynchronous (the SaaS
 * CAS/KMS path); both satisfy this signature. Atomicity is the
 * implementation's responsibility.
 */
export interface OAuthRefreshCommitResult {
  readonly outcome: RefreshOutcome;
  readonly writeback: RefreshWriteback | null;
  /** Engine-owned scheduling clock for stamps; default Date.now(). */
  readonly nowMs?: number;
  /** Backoff stamp for failure-class outcomes; shells that do not use backoff may omit it. */
  readonly backoffMs?: number | null;
}

export interface OAuthRefreshStore {
  /** Normalized due-credential snapshots (the engine only sees this shape). */
  listDue(nowMs: number, marginMs: number, limit: number): readonly RefreshableCredential[];
  /** Commit an attempt (success writeback / terminal mark / failure stamp). */
  commit(credential: RefreshableCredential, result: OAuthRefreshCommitResult): void | Promise<void>;
}

// --- Shared parse primitives ---

/**
 * Printable ASCII token text (RFC 6749 §1.4 vsvar); never logged.
 * DIVERGENCE: classic allowed spaces (0x20) and id_tokens up to 32_768 chars;
 * the SaaS contract (0x21-0x7e, 4_096 max) is stricter and wins.
 */
function tokenText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attempt(outcome: RefreshOutcome): OAuthRefreshAttempt {
  return { outcome, writeback: null };
}

function failed(
  kind: 'terminal' | 'retryable' | 'failure' | 'unsupported',
  errorCode: CoreRefreshErrorCode,
  httpStatus: number | null,
  oauthError: string | null = null,
): OAuthRefreshAttempt {
  return attempt({ kind, errorCode, oauthError, httpStatus });
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

/**
 * Streaming bounded response-body reader (the SaaS contract): the cap is
 * enforced against the actual byte stream, not a declared content-length, and
 * the stream is cancelled the moment the cap would be exceeded.
 */
async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<BoundedBodyResult> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const buffer = new Uint8Array(OAUTH_REFRESH_MAX_RESPONSE_BYTES);
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
      if (value.byteLength > OAUTH_REFRESH_MAX_RESPONSE_BYTES - bytesRead) {
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

/**
 * Only access_token, refresh_token, id_token and expires_in survive, plus
 * the binding's passthrough fields (a non-string or empty value is
 * discarded; the previous envelope's copy stays authoritative).
 */
function parseTokenEndpointResponse(
  bytes: Uint8Array,
  fields: readonly string[],
): {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresInSeconds: number | null;
  readonly passthrough: Record<string, string>;
} | null {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) return null;
    body = parsed;
  } catch {
    return null;
  }
  const accessToken = tokenText(body.access_token, 4_096);
  if (accessToken === null) return null;
  let refreshToken: string | null = null;
  if (body.refresh_token !== undefined) {
    refreshToken = tokenText(body.refresh_token, 4_096);
    if (refreshToken === null) return null;
  }
  let idToken: string | null = null;
  if (body.id_token !== undefined) {
    idToken = tokenText(body.id_token, 4_096);
    if (idToken === null) return null;
  }
  let expiresInSeconds: number | null = null;
  if (body.expires_in !== undefined) {
    const raw = body.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS) return null;
    expiresInSeconds = parsed;
  }
  const passthrough: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) passthrough[field] = value;
  }
  return { accessToken, refreshToken, idToken, expiresInSeconds, passthrough };
}

/**
 * Best-effort RFC 6749 §5.2 error-code extraction from a rejection body.
 * Bounded by the same byte cap, never throws, never surfaces anything but a
 * short printable code.
 */
async function providerRejectionCode(response: Response, signal: AbortSignal): Promise<string | null> {
  const body = await boundedResponseBody(response, signal);
  if (body.state !== 'ok') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return tokenText(parsed.error, 64);
}

/**
 * One refresh_token grant call against the provider token endpoint.
 * Ported from the SaaS worker's requestOauthTokenRefresh and the classic
 * refreshOAuthAccount (identical form contract, SaaS's stricter response
 * discipline): form-urlencoded grant, client_id, optional scope narrowing,
 * optional client_secret, pinned User-Agent, manual redirects, bounded
 * response. Never throws; every failure mode is a classified outcome.
 */
export async function performOAuthRefresh(
  credential: RefreshableCredential,
  adapter: OAuthRefreshAdapter,
  fetchImpl: OAuthRefreshFetch = (url, init) => fetch(url, init),
  options: PerformOAuthRefreshOptions = {},
): Promise<OAuthRefreshAttempt> {
  const url = canonicalTokenEndpoint(adapter.tokenEndpoint);
  if (url === null) return failed('unsupported', 'adapter_unsupported', null);
  if (tokenText(credential.refreshToken, 4_096) === null) {
    return failed('unsupported', 'credential_invalid', null);
  }

  const nowMs = options.nowMs ?? Date.now();
  const form =
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(credential.refreshToken)}` +
    `&client_id=${encodeURIComponent(adapter.clientId)}` +
    (adapter.refreshScope === null ? '' : `&scope=${encodeURIComponent(adapter.refreshScope)}`) +
    (adapter.clientSecret === undefined || adapter.clientSecret === null || adapter.clientSecret === ''
      ? ''
      : `&client_secret=${encodeURIComponent(adapter.clientSecret)}`);
  const deadline = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
  const timeoutSignal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetchImpl(url.href, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': adapter.userAgent,
      },
      body: form,
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    // DIVERGENCE: classic only inspected the abort flag; the SaaS worker also
    // honors a TimeoutError name — both are checked (the stricter union).
    const isTimeout = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    return failed('retryable', isTimeout ? 'timeout' : 'network_error', null);
  }

  if (timeoutSignal.aborted) {
    cancelResponseBody(response);
    return failed('retryable', 'timeout', response.status);
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > OAUTH_REFRESH_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return failed('failure', 'response_too_large', response.status);
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return failed('failure', 'redirect_rejected', response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Structured rejection signal (RFC 6749 §5.2, e.g. 'invalid_grant') so
      // callers can distinguish a rotated refresh token from a revoked one.
      const oauthError = await providerRejectionCode(response, timeoutSignal);
      const terminal = oauthError !== null && NON_RETRYABLE_OAUTH_ERRORS.includes(oauthError);
      return failed(terminal ? 'terminal' : 'failure', 'endpoint_rejected', response.status, oauthError);
    }
    if (response.status === 429) return failed('retryable', 'rate_limited', response.status);
    if (response.status >= 500) return failed('retryable', 'provider_unavailable', response.status);
    return failed('failure', 'endpoint_unsupported', response.status);
  }
  // DIVERGENCE: classic tolerated a missing content-type header; the SaaS
  // worker required application/json exactly — the stricter check wins.
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    cancelResponseBody(response);
    return failed('failure', 'response_invalid', response.status);
  }
  const bodyResult = await boundedResponseBody(response, timeoutSignal);
  if (bodyResult.state === 'too_large') {
    return failed('failure', 'response_too_large', response.status);
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    // DIVERGENCE: a failed body read was response_invalid (non-retryable) in
    // classic and network_error (retryable) in the SaaS worker — the
    // retryable SaaS reading wins: a torn stream is transport, not content.
    return failed('retryable', bodyResult.state === 'timeout' ? 'timeout' : 'network_error', response.status);
  }
  const parsed = parseTokenEndpointResponse(bodyResult.bytes, adapter.passthroughFields ?? []);
  if (parsed === null) {
    return failed('failure', 'response_invalid', response.status);
  }
  return {
    outcome: { kind: 'success', errorCode: null, oauthError: null, httpStatus: response.status },
    writeback: {
      key: credential.key,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      idToken: parsed.idToken,
      expiresAtMs: parsed.expiresInSeconds === null ? null : nowMs + parsed.expiresInSeconds * 1000,
      expiresInSeconds: parsed.expiresInSeconds,
      passthrough: parsed.passthrough,
    },
  };
}

// --- Backoff (single implementation; plan §2.1) ---

function jitterFraction(key: string): number {
  const digest = createHash('sha256').update('oauth-refresh-jitter').update(key).digest();
  const unit = digest.readUInt32BE(0) / 0xffffffff;
  return (unit * 2 - 1) * 0.1;
}

export interface RefreshBackoffOptions {
  readonly min?: number;
  readonly max?: number;
  /**
   * Deterministic ±10% jitter key (both planes key it by their account /
   * credential identity). Omitted = no jitter.
   */
  readonly jitterKey?: string;
}

/**
 * Exponential failure backoff: min, 2×min, 4×min, ... capped at max, with
 * optional deterministic ±10% jitter, clamped to [min, max].
 */
export function refreshBackoffMs(failureCount: number, options: RefreshBackoffOptions = {}): number {
  const min = options.min ?? OAUTH_REFRESH_MIN_BACKOFF_MS;
  const max = options.max ?? OAUTH_REFRESH_MAX_BACKOFF_MS;
  const attempts = Math.max(1, failureCount);
  let base = min;
  for (let index = 1; index < attempts; index += 1) {
    base = Math.min(max, base * 2);
    if (base >= max) break;
  }
  const bounded = Math.min(max, base);
  const jittered =
    options.jitterKey === undefined ? bounded : Math.round(bounded * (1 + jitterFraction(options.jitterKey)));
  return Math.min(max, Math.max(min, jittered));
}

/**
 * Expiry-margin predicate with the force bypass: a null expiry is never
 * proactively due (classic semantics), but `force` — a live 401 from the
 * upstream is definitive expiry evidence — refreshes regardless.
 */
export function shouldRefresh(expiresAtMs: number | null, marginMs: number, nowMs: number, force: boolean): boolean {
  if (force) return true;
  if (expiresAtMs === null) return false;
  return expiresAtMs <= nowMs + marginMs;
}
