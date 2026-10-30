/**
 * GCP service-account OAuth for Vertex AI upstreams — classic extraction
 * (plan C3) of the SaaS implementation in src/saas/platform/vertex-sa/
 * {token-service,service-account}.ts (which itself ports sub2api's
 * exchangeVertexServiceAccountToken). Extraction, not import: this module
 * must stay free of PG/Redis/SaaS dependencies.
 *
 * The flow: parse the SA JSON (client_email / private_key / project_id),
 * mint an RS256 JWT assertion (iss=client_email,
 * scope=https://www.googleapis.com/auth/cloud-platform, aud=token_uri,
 * iat=now, exp=now+1h), exchange it at the PINNED Google token endpoint for
 * an access token, cache the token in memory with an expiry refresh margin.
 * The SA file's `token_uri` is parsed but ALWAYS overridden with the pinned
 * endpoint so a crafted key file can never steer the exchange at an
 * attacker host (the sub2api SSRF guard).
 */

import { createHash, createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { ProviderAuthRequest, ProviderTransportProfile, UpstreamProviderSettings } from './types.js';

/** The ONLY token endpoint the exchange ever dials (SSRF guard). */
export const VERTEX_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The OAuth scope the SA assertion requests (cloud-platform covers Vertex). */
export const VERTEX_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The jwt-bearer grant type identifier (RFC 7523 §4.1). */
export const VERTEX_JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** SA assertion lifetime (JWT exp − iat): one hour. */
export const VERTEX_ASSERTION_LIFETIME_MS = 3_600_000;

/** The access-token cache skew subtracted from expires_in. */
export const VERTEX_TOKEN_CACHE_SKEW_MS = 5 * 60_000;

/** Fallback access-token TTL when the token response omits expires_in. */
export const VERTEX_TOKEN_DEFAULT_TTL_MS = 3_600_000;

/** Minimum retained TTL (never treat a token as usable below this). */
export const VERTEX_TOKEN_MIN_TTL_MS = 60_000;

/** The default Vertex location when the upstream carries none. */
export const VERTEX_DEFAULT_LOCATION = 'us-central1';

/** `anthropic_version` injected into every Anthropic-on-Vertex body. */
export const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

/** The token-endpoint fetch contract (injectable for tests). */
export type VertexSaFetch = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Service-account key parsing (extraction of service-account.ts).

/** The service-account facts the JWT-bearer exchange needs. */
export interface VertexServiceAccountKey {
  /** `client_email` — the JWT `iss` claim. */
  readonly clientEmail: string;
  /** `private_key` — the PEM RSA private key the assertion is signed with. */
  readonly privateKey: string;
  /** `private_key_id` — the JWT header `kid`, when the file carries one. */
  readonly privateKeyId: string | null;
  /** `project_id` — the GCP project the aiplatform URLs interpolate. */
  readonly projectId: string;
  /** ALWAYS the pinned https://oauth2.googleapis.com/token. */
  readonly tokenUri: string;
}

export type VertexServiceAccountParseErrorCode =
  | 'MALFORMED_JSON'
  | 'MISSING_CLIENT_EMAIL'
  | 'MISSING_PRIVATE_KEY'
  | 'MISSING_PROJECT_ID'
  | 'MALFORMED_NESTED_OBJECT';

export class VertexServiceAccountParseError extends Error {
  constructor(readonly code: VertexServiceAccountParseErrorCode) {
    super(`vertex service account json is invalid: ${code}`);
    this.name = 'VertexServiceAccountParseError';
  }
}

const MAX_SERVICE_ACCOUNT_JSON_BYTES = 32_768;
const MAX_FIELD_BYTES = 4_096;

function fieldText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_FIELD_BYTES) return null;
  return trimmed;
}

/** Validates a parsed SA JSON object into the exchange key. */
export function parseVertexServiceAccountObject(raw: Record<string, unknown>): VertexServiceAccountKey {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VertexServiceAccountParseError('MALFORMED_NESTED_OBJECT');
  }
  const clientEmail = fieldText(raw.client_email);
  if (clientEmail === null) throw new VertexServiceAccountParseError('MISSING_CLIENT_EMAIL');
  const privateKey = fieldText(raw.private_key);
  if (privateKey === null) throw new VertexServiceAccountParseError('MISSING_PRIVATE_KEY');
  const projectId = fieldText(raw.project_id);
  if (projectId === null) throw new VertexServiceAccountParseError('MISSING_PROJECT_ID');
  const privateKeyId = fieldText(raw.private_key_id);
  return { clientEmail, privateKey, privateKeyId, projectId, tokenUri: VERTEX_TOKEN_URL };
}

/**
 * Parses a service-account JSON key file (text or already-parsed object).
 * The file's `token_uri` is accepted but always overridden with the pinned
 * Google endpoint.
 */
export function parseVertexServiceAccountJson(raw: string | Record<string, unknown>): VertexServiceAccountKey {
  if (typeof raw === 'string') {
    if (raw.trim() === '' || raw.length > MAX_SERVICE_ACCOUNT_JSON_BYTES) {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VertexServiceAccountParseError('MALFORMED_JSON');
    }
    return parseVertexServiceAccountObject(parsed as Record<string, unknown>);
  }
  return parseVertexServiceAccountObject(raw);
}

// ---------------------------------------------------------------------------
// JWT assertion + token exchange (extraction of token-service.ts).

export type VertexSaTokenErrorCode = 'ASSERTION_SIGN_FAILED' | 'TOKEN_ENDPOINT_FAILED' | 'TOKEN_RESPONSE_INVALID';

export class VertexSaTokenError extends Error {
  constructor(
    readonly code: VertexSaTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VertexSaTokenError';
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Signs `${headerB64}.${claimsB64}` with RS256 (node:crypto, no dependencies). */
export type VertexSaAssertionSigner = (signingInput: string, privateKeyPem: string) => string;

function defaultAssertionSigner(signingInput: string, privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new VertexSaTokenError('ASSERTION_SIGN_FAILED', 'the service account private key is not parseable');
  }
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  try {
    return signer.sign(key, 'base64url');
  } catch {
    throw new VertexSaTokenError('ASSERTION_SIGN_FAILED', 'the service account assertion could not be signed');
  }
}

/**
 * Builds the signed RS256 JWT assertion: iss=client_email,
 * scope=cloud-platform, aud=token_uri (the pinned endpoint), iat=now,
 * exp=now+1h; header kid=private_key_id when present.
 */
export function buildVertexSaAssertion(
  key: VertexServiceAccountKey,
  nowMs: number = Date.now(),
  sign: VertexSaAssertionSigner = defaultAssertionSigner,
): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + VERTEX_ASSERTION_LIFETIME_MS) / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.privateKeyId !== null && key.privateKeyId !== '') header.kid = key.privateKeyId;
  const headerB64 = base64Url(JSON.stringify(header));
  const claimsB64 = base64Url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: VERTEX_CLOUD_PLATFORM_SCOPE,
      aud: key.tokenUri,
      iat,
      exp,
    }),
  );
  return `${headerB64}.${claimsB64}.${sign(`${headerB64}.${claimsB64}`, key.privateKey)}`;
}

export interface VertexSaTokenExchange {
  readonly accessToken: string;
  readonly expiresInSeconds: number | null;
}

const VERTEX_SA_TOKEN_MAX_RESPONSE_BYTES = 8_192;

/**
 * The jwt-bearer exchange against the pinned Google token endpoint: POST
 * form-urlencoded `grant_type=...jwt-bearer&assertion=<jwt>`. Anything other
 * than the pinned endpoint fails closed before any request is made.
 */
export async function exchangeVertexSaToken(input: {
  readonly key: VertexServiceAccountKey;
  readonly fetch: VertexSaFetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
  readonly sign?: VertexSaAssertionSigner;
}): Promise<VertexSaTokenExchange> {
  if (input.key.tokenUri !== VERTEX_TOKEN_URL) {
    throw new VertexSaTokenError('TOKEN_ENDPOINT_FAILED', 'the token endpoint is not the pinned Google endpoint');
  }
  const assertion = buildVertexSaAssertion(input.key, input.nowMs ?? Date.now(), input.sign);
  const body = `grant_type=${encodeURIComponent(VERTEX_JWT_BEARER_GRANT_TYPE)}&assertion=${encodeURIComponent(assertion)}`;
  const response = await input.fetch(VERTEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'manual',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const text = await response.text();
  if (text.length > VERTEX_SA_TOKEN_MAX_RESPONSE_BYTES) {
    throw new VertexSaTokenError('TOKEN_RESPONSE_INVALID', 'the token response was too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (response.status < 200 || response.status >= 300) {
    const description =
      typeof record.error_description === 'string' && record.error_description !== ''
        ? record.error_description
        : typeof record.error === 'string'
          ? record.error
          : `status ${response.status}`;
    throw new VertexSaTokenError('TOKEN_ENDPOINT_FAILED', `the token endpoint rejected the assertion: ${description}`);
  }
  const accessToken = typeof record.access_token === 'string' ? record.access_token.trim() : '';
  if (accessToken === '') {
    throw new VertexSaTokenError('TOKEN_RESPONSE_INVALID', 'the token response carried no access_token');
  }
  const expiresIn =
    typeof record.expires_in === 'number' && Number.isSafeInteger(record.expires_in) && record.expires_in > 0
      ? record.expires_in
      : null;
  return { accessToken, expiresInSeconds: expiresIn };
}

/**
 * The cached-token TTL: `expires_in` minus the cache skew, never below one
 * minute.
 */
export function vertexSaTokenTtlMs(expiresInSeconds: number | null): number {
  const raw = expiresInSeconds === null ? VERTEX_TOKEN_DEFAULT_TTL_MS : expiresInSeconds * 1000;
  return Math.max(raw - VERTEX_TOKEN_CACHE_SKEW_MS, VERTEX_TOKEN_MIN_TTL_MS);
}

// ---------------------------------------------------------------------------
// The in-memory token provider.

export interface VertexSaTokenProvider {
  /** The current access token, exchanging/refreshing when stale. */
  getAccessToken(nowMs?: number): Promise<string>;
  /** Drops the cached token (the next call re-exchanges). */
  reset(): void;
}

export interface VertexSaTokenProviderOptions {
  /** Injectable fetch (defaults to the global fetch). */
  readonly fetch?: VertexSaFetch;
  /** Injectable clock (defaults to Date.now). */
  readonly nowMs?: () => number;
  /**
   * Refresh margin: a cached token is refreshed this many ms BEFORE its
   * real expiry (default: the 5-minute cache skew). The margin is applied
   * once, at the freshness check — the stored expiry is the raw one.
   */
  readonly refreshMarginMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Creates a token provider over one service-account key. The token is
 * cached in memory; concurrent callers share one in-flight exchange.
 * `saJson` is parsed eagerly so a malformed key fails at construction, not
 * on the first request.
 */
export function createVertexSaTokenProvider(
  saJson: string | Record<string, unknown>,
  options: VertexSaTokenProviderOptions = {},
): VertexSaTokenProvider {
  const key = parseVertexServiceAccountJson(saJson);
  const doFetch: VertexSaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const clock: () => number = options.nowMs ?? Date.now;
  const margin = options.refreshMarginMs ?? VERTEX_TOKEN_CACHE_SKEW_MS;
  let cached: { readonly token: string; readonly expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const exchange = async (): Promise<string> => {
    const result = await exchangeVertexSaToken({
      key,
      fetch: doFetch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const now = clock();
    const rawTtl = result.expiresInSeconds === null ? VERTEX_TOKEN_DEFAULT_TTL_MS : result.expiresInSeconds * 1000;
    cached = { token: result.accessToken, expiresAtMs: now + rawTtl };
    return result.accessToken;
  };

  return {
    async getAccessToken(nowMs?: number): Promise<string> {
      const now = nowMs ?? clock();
      if (cached !== null && now + margin < cached.expiresAtMs) return cached.token;
      if (inFlight !== null) return inFlight;
      inFlight = exchange()
        .catch((error: unknown) => {
          // Do not cache failures; the next caller retries the exchange.
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    reset(): void {
      cached = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Vertex aiplatform URL building (extraction of vertex transform.ts).

const VERTEX_LOCATION_PATTERN = /^[a-z0-9-]+$/;
const VERTEX_MAX_LOCATION_LENGTH = 32;
const VERTEX_MAX_MODEL_ID_LENGTH = 256;
const VERTEX_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

function requireProjectId(projectId: string): string {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : '';
  if (trimmed === '' || trimmed.length > 128) throw new Error('vertex project id is malformed');
  return trimmed;
}

function requireLocation(location: string): string {
  const trimmed = typeof location === 'string' ? location.trim() : '';
  if (trimmed === '' || trimmed.length > VERTEX_MAX_LOCATION_LENGTH || !VERTEX_LOCATION_PATTERN.test(trimmed)) {
    throw new Error('vertex location is malformed');
  }
  return trimmed;
}

function requireModel(model: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (trimmed === '' || trimmed.length > VERTEX_MAX_MODEL_ID_LENGTH || !VERTEX_MODEL_ID_PATTERN.test(trimmed)) {
    throw new Error('vertex model id is malformed');
  }
  return trimmed;
}

/** The aiplatform host for a location: `global` has no regional prefix. */
export function vertexApiHost(location: string, apiBaseHost = 'aiplatform.googleapis.com'): string {
  return location === 'global' ? apiBaseHost : `${location}-${apiBaseHost}`;
}

/**
 * Anthropic-on-Vertex URL:
 * `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/
 * locations/{location}/publishers/anthropic/models/{model}:{rawPredict|
 * streamRawPredict}`. The `@` in an already-dated model id is NOT
 * percent-encoded (Vertex expects the literal `@`).
 */
export function buildVertexAnthropicUrl(input: {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
  readonly apiBaseHost?: string;
}): string {
  const projectId = requireProjectId(input.projectId);
  const location = requireLocation(input.location);
  const model = requireModel(input.model);
  const action = input.stream ? 'streamRawPredict' : 'rawPredict';
  const host = vertexApiHost(location, input.apiBaseHost);
  const escapedModel = encodeURIComponent(model).replace(/%40/g, '@');
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    location,
  )}/publishers/anthropic/models/${escapedModel}:${action}`;
}

/**
 * Gemini-on-Vertex URL:
 * `.../publishers/google/models/{model}:{generateContent|
 * streamGenerateContent?alt=sse}`.
 */
export function buildVertexGeminiUrl(input: {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
  readonly apiBaseHost?: string;
}): string {
  const projectId = requireProjectId(input.projectId);
  const location = requireLocation(input.location);
  const model = requireModel(input.model);
  const action = input.stream ? 'streamGenerateContent' : 'generateContent';
  const host = vertexApiHost(location, input.apiBaseHost);
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    location,
  )}/publishers/google/models/${encodeURIComponent(model)}:${action}${input.stream ? '?alt=sse' : ''}`;
}

/**
 * Anthropic-on-Vertex request body: the `model` field is deleted (the model
 * rides the URL) and `anthropic_version: "vertex-2023-10-16"` is injected.
 * Copy-on-write.
 */
export function buildVertexAnthropicRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  delete next.model;
  next.anthropic_version = VERTEX_ANTHROPIC_VERSION;
  return next;
}

// ---------------------------------------------------------------------------
// The transport profile the classic dispatch will consume.

const VERTEX_ANTHROPIC_ENDPOINTS = new Set(['rawPredict', 'streamRawPredict']);
const VERTEX_GEMINI_ENDPOINTS = new Set(['generateContent', 'streamGenerateContent']);

function endpointAction(endpoint: string): { kind: 'anthropic' | 'gemini'; stream: boolean } {
  switch (endpoint) {
    case 'rawPredict':
      return { kind: 'anthropic', stream: false };
    case 'streamRawPredict':
      return { kind: 'anthropic', stream: true };
    case 'generateContent':
      return { kind: 'gemini', stream: false };
    case 'streamGenerateContent':
      return { kind: 'gemini', stream: true };
    case 'messages':
      return { kind: 'anthropic', stream: false };
    case 'messages-stream':
      return { kind: 'anthropic', stream: true };
    default:
      throw new Error(`vertex transport profile does not support endpoint "${endpoint}"`);
  }
}

interface VertexProfileOptions {
  readonly fetch?: VertexSaFetch;
  readonly nowMs?: () => number;
}

const MAX_CACHED_TOKEN_PROVIDERS = 32;

function cacheKey(saJson: string | Record<string, unknown>): string {
  const normalized = typeof saJson === 'string' ? saJson : JSON.stringify(saJson);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Builds a Vertex transport profile. Token providers are cached per SA key
 * (bounded LRU-by-insertion-order), so repeated requests reuse one cached
 * access token per upstream.
 */
export function createVertexTransportProfile(options: VertexProfileOptions = {}): ProviderTransportProfile {
  const providers = new Map<string, VertexSaTokenProvider>();

  const tokenProvider = (upstream: UpstreamProviderSettings): VertexSaTokenProvider => {
    const saJson = upstream.serviceAccountJson;
    if (saJson === undefined || saJson === null || saJson === '') {
      throw new Error('vertex transport profile requires upstream serviceAccountJson');
    }
    const key = cacheKey(saJson as string | Record<string, unknown>);
    const existing = providers.get(key);
    if (existing !== undefined) {
      // Refresh insertion order so the eviction below stays LRU.
      providers.delete(key);
      providers.set(key, existing);
      return existing;
    }
    const provider = createVertexSaTokenProvider(saJson as string | Record<string, unknown>, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    });
    providers.set(key, provider);
    if (providers.size > MAX_CACHED_TOKEN_PROVIDERS) {
      const oldest = providers.keys().next();
      if (oldest.done !== true) providers.delete(oldest.value);
    }
    return provider;
  };

  return {
    id: 'vertex',
    defaultBaseUrl: `https://${VERTEX_DEFAULT_LOCATION}-aiplatform.googleapis.com`,
    buildUrl(input): string {
      const action = endpointAction(input.endpoint);
      const saJson = input.upstream?.serviceAccountJson;
      const key =
        saJson !== undefined && saJson !== null && saJson !== ''
          ? parseVertexServiceAccountJson(saJson as string | Record<string, unknown>)
          : null;
      const projectId = key?.projectId ?? '';
      if (projectId === '') throw new Error('vertex transport profile requires a project_id in the service account');
      const location =
        input.upstream?.vertexLocation !== undefined &&
        input.upstream?.vertexLocation !== null &&
        input.upstream.vertexLocation.trim() !== ''
          ? input.upstream.vertexLocation.trim()
          : VERTEX_DEFAULT_LOCATION;
      // A non-empty baseUrl overrides the aiplatform host (test upstreams).
      const apiBaseHost =
        input.baseUrl !== undefined && input.baseUrl.trim() !== '' ? new URL(input.baseUrl.trim()).host : undefined;
      const shared = { projectId, location, apiBaseHost };
      const model = input.model ?? '';
      if (model === '') throw new Error('vertex transport profile requires a model');
      return action.kind === 'anthropic'
        ? buildVertexAnthropicUrl({ ...shared, model, stream: action.stream })
        : buildVertexGeminiUrl({ ...shared, model, stream: action.stream });
    },
    async buildAuth(upstream, request: ProviderAuthRequest): Promise<Readonly<Record<string, string>>> {
      const provider = tokenProvider(upstream);
      const accessToken = await provider.getAccessToken(request.nowMs ?? undefined);
      return { authorization: `Bearer ${accessToken}` };
    },
    transformRequestBody(
      body: Record<string, unknown>,
      context?: { endpoint?: string; model?: string | null; stream?: boolean },
    ): Record<string, unknown> | null {
      const endpoint = context?.endpoint ?? 'rawPredict';
      if (VERTEX_GEMINI_ENDPOINTS.has(endpoint)) return null;
      if (!VERTEX_ANTHROPIC_ENDPOINTS.has(endpoint) && endpoint !== 'messages' && endpoint !== 'messages-stream') {
        return null;
      }
      return buildVertexAnthropicRequestBody(body);
    },
  };
}

/** The default profile instance (global fetch, wall clock). */
export const vertexTransportProfile: ProviderTransportProfile = createVertexTransportProfile();
