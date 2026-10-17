import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { AuthenticatedApiKey } from '../keys/types.js';
import {
  beginGatewayInflightRequest,
  recordGatewayAttemptOutcome,
  recordGatewayRequestEnd,
} from '../observability/metrics.js';
import { resolveClientAddress } from './client-address.js';
import type { GatewayPreDispatchCompensationPort } from './pre-dispatch-compensation-service.js';
import type {
  PreparedEvidenceClientStream,
  PreparedEvidenceDispatchInput,
  PreparedEvidenceDispatchResult,
} from './prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceAudit } from './prepared-request-evidence-service.js';
import type { ProviderAccountSchedulerClientEvidence } from './provider-account-scheduler.js';
import type {
  CanonicalRequestStatusReference,
  RequestPreparationFailureResult,
  RequestPreparationInput,
  RequestPreparationPreparedResult,
  RequestPreparationResult,
} from './request-preparation-service.js';
import { stickySchedulingContext } from './sticky-session-reference.js';

const GATEWAY_PREFIX = '/v1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/*
 * Roadmap batch 4 §4.0 ① (task #14): endpoint-family POST body limits.
 *
 * The 1 MiB default is the text-family bound (chat/messages/responses/
 * embeddings JSON). Media endpoints need a family-specific ceiling because
 * first-phase media support is JSON `generations` + `b64_json` mode (§4.0 ②):
 * base64 inflates payloads by ~4/3, so a 25 MiB raw audio file (the OpenAI
 * STT cap) arrives as ~34 MiB of JSON — hence a 26 MiB family ceiling for
 * JSON-mode audio inputs near that cap, and 10 MiB for image payloads
 * (b64-encoded 1024×1024 PNG/JPEG plus prompt stays well under it).
 *
 * Cost evaluation for the larger ceilings: a 10–26 MiB body is fully
 * buffered once (readJsonBody chunk array) plus the parsed JSON object
 * (transiently ~2× the byte size), and flows through the standard
 * preparation chain: a single streaming SHA-256 pass for the request
 * fingerprint (no additional retention — only the 64-hex digest survives
 * admission) and the payload compiler's canonical re-serialization. That
 * per-request memory is bounded by the family ceiling itself, and aggregate
 * exposure is bounded by the existing preparation-capacity admission guard,
 * so raising the per-request ceiling does not change the worst-case
 * concurrent buffer profile the deployment was sized for.
 */
const DEFAULT_IMAGE_FAMILY_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_AUDIO_FAMILY_BODY_BYTES = 26 * 1024 * 1024;
const IMAGE_FAMILY_PATH_PREFIX = '/v1/images/';
const AUDIO_FAMILY_PATH_PREFIX = '/v1/audio/';

/*
 * Roadmap batch 4 §4.0 ② (task #14): JSON-only media policy.
 *
 * First-phase hosted media support is JSON generations with b64_json input
 * only. These endpoints are multipart/form-data file-upload surfaces, which
 * the hosted gateway deliberately does not accept: multipart is a new
 * transport face (a second body channel, a new admission-fingerprint
 * strategy for non-JSON parts, and the entire preparation chain's
 * JSON-body assumption), so it is an explicitly deferred follow-up task.
 * The paths are still reserved here (fail closed with a precise 501
 * instead of a generic 404) so clients get an actionable answer and task
 * #16/#17 route registration never has to touch this policy.
 */
const MULTIPART_ONLY_ENDPOINT_PATHS = new Set<string>([
  '/v1/images/edits',
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
]);
const MULTIPART_UNSUPPORTED_MESSAGE =
  'This endpoint requires multipart/form-data, which the hosted gateway does not support yet; use the JSON media generation endpoints with base64-encoded input instead';
const WEBSOCKET_UNSUPPORTED_MESSAGE =
  'Realtime WebSocket sessions are not supported by the hosted gateway; use the HTTP media endpoints instead';

/*
 * Roadmap batch 4 §4.0 ③ (task #14): the query endpoint family.
 *
 * Asynchronous media tasks (image generations, video renders) are polled
 * through GET status/content endpoints. These are deliberately a
 * lightweight bypass modeled on the /v1/models precedent: authenticate,
 * parse path parameters, delegate to a query port — no preparation, no
 * admission, no evidence lifecycle, because they read task state rather
 * than create billable work. The port contract below is the reserved
 * interface shape for #16 (images) and #17 (video/audio): route ids,
 * parsed path parameters, and the authenticated caller are all the
 * handlers receive; response framing stays boundary-owned.
 */
export type SaasGatewayQueryRouteId = 'images.task_status' | 'videos.task_status' | 'videos.task_content';

interface QueryRoutePattern {
  readonly routeId: SaasGatewayQueryRouteId;
  readonly segments: readonly string[];
}

const QUERY_ROUTES: readonly QueryRoutePattern[] = [
  { routeId: 'images.task_status', segments: ['v1', 'images', 'tasks', ':taskId'] },
  { routeId: 'videos.task_status', segments: ['v1', 'videos', ':taskId'] },
  { routeId: 'videos.task_content', segments: ['v1', 'videos', ':taskId', 'content'] },
];

/**
 * Parameter values are the raw (still percent-encoded) path segments. The
 * printable-ASCII bound keeps them opaque, bounded identifiers; #16/#17 own
 * any decoding policy for their task id space.
 */
const QUERY_PATH_PARAMETER = /^[\x21-\x7e]{1,255}$/;

interface MatchedQueryRoute {
  readonly routeId: SaasGatewayQueryRouteId;
  readonly pathParameters: Readonly<Record<string, string>>;
}

function matchQueryRoute(path: string): MatchedQueryRoute | null {
  const parts = path.split('/');
  if (parts[0] !== '') return null;
  const segments = parts.slice(1);
  // Strict segment matching: a trailing slash or an interior empty segment
  // matches no query route (no lenient normalization at this boundary).
  if (segments.some((segment) => segment.length === 0)) return null;
  for (const route of QUERY_ROUTES) {
    if (route.segments.length !== segments.length) continue;
    const pathParameters: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < segments.length; index += 1) {
      const pattern = route.segments[index];
      const segment = segments[index];
      if (pattern === undefined || segment === undefined) {
        matched = false;
        break;
      }
      if (pattern.startsWith(':')) {
        if (!QUERY_PATH_PARAMETER.test(segment)) {
          matched = false;
          break;
        }
        pathParameters[pattern.slice(1)] = segment;
      } else if (pattern !== segment) {
        matched = false;
        break;
      }
    }
    if (matched) return { routeId: route.routeId, pathParameters };
  }
  return null;
}
const MAX_MODEL_LENGTH = 512;
const MAX_AUTHORIZATION_LENGTH = 4096;
const MAX_AUDIT_VALUE_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;
const ENTRY_POINT = 'hosted-gateway-http';

/*
 * G1 (task #41): Claude Code client-identity evidence collected at the
 * trusted HTTP boundary for the account scheduler's claude_code_only
 * enforcement (F2/R5). Bounded by construction: only the Claude-relevant
 * header names plus the x-stainless-* SDK fingerprint family, lowercased
 * keys, and per-value caps far above any genuine client shape. The evidence
 * is request-scoped scheduler input only — never logged, never audited,
 * and never forwarded to providers.
 */
const MAX_CLIENT_EVIDENCE_VALUE_LENGTH = 2048;
const CLAUDE_CLIENT_EVIDENCE_HEADER_NAMES = new Set([
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'x-app',
  'x-anthropic-billing-header',
]);
const CLAUDE_CLIENT_EVIDENCE_HEADER_PREFIX = 'x-stainless-';

const ROUTES = new Map<string, 'openai' | 'responses' | 'anthropic'>([
  ['/v1/chat/completions', 'openai'],
  ['/v1/responses', 'responses'],
  ['/v1/messages', 'anthropic'],
  // R2: the OpenAI embeddings operation rides the OpenAI inbound protocol
  // family; the per-route client operation below distinguishes it from chat.
  ['/v1/embeddings', 'openai'],
]);

/**
 * Server-owned client operation overrides for routes whose protocol hosts
 * more than one canonical operation. Values are never read from the request
 * body; only this trusted HTTP boundary may set them.
 */
const ROUTE_CLIENT_OPERATIONS = new Map<string, string>([['/v1/embeddings', 'embeddings']]);

/**
 * Per-endpoint-family POST body ceilings (roadmap 4.0 ①). Values are
 * positive safe integers injected by the trusted composition boundary —
 * never derived from the environment inside this handler. Omitted families
 * keep their documented defaults (images 10 MiB, audio 26 MiB); every other
 * path family uses the global {@link SaasGatewayHttpOptions.maxBodyBytes}.
 */
export interface SaasGatewayEndpointFamilyBodyLimits {
  /** Ceiling for POST bodies on /v1/images/* endpoints. Default 10 MiB. */
  readonly images?: number;
  /** Ceiling for POST bodies on /v1/audio/* endpoints. Default 26 MiB. */
  readonly audio?: number;
}

/** Resolved, immutable per-family body ceilings. `default` is the text family. */
export interface SaasGatewayBodyLimits {
  readonly default: number;
  readonly images: number;
  readonly audio: number;
}

/** Path-family body limit for one request path. Unmatched prefixes are text. */
export function bodyLimitForPath(path: string, limits: SaasGatewayBodyLimits): number {
  if (path.startsWith(IMAGE_FAMILY_PATH_PREFIX)) return limits.images;
  if (path.startsWith(AUDIO_FAMILY_PATH_PREFIX)) return limits.audio;
  return limits.default;
}

/**
 * Validates and resolves the endpoint-family ceilings. Any invalid injected
 * value fails closed to `null`, which the handler surfaces as 503 — the
 * same posture as an invalid global `maxBodyBytes`.
 */
export function resolveSaasGatewayBodyLimits(
  maxBodyBytes: number | null,
  families: SaasGatewayEndpointFamilyBodyLimits | undefined,
): SaasGatewayBodyLimits | null {
  if (maxBodyBytes === null) return null;
  const images = families?.images ?? DEFAULT_IMAGE_FAMILY_BODY_BYTES;
  const audio = families?.audio ?? DEFAULT_AUDIO_FAMILY_BODY_BYTES;
  const valid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  if (!valid(images) || !valid(audio)) return null;
  return { default: maxBodyBytes, images, audio };
}

/** The only authentication capability accepted by the hosted HTTP boundary. */
export interface ProxyKeyAuthenticator {
  authenticate(rawKey: string): Promise<AuthenticatedApiKey | null>;
}

export interface RequestPreparationPort {
  prepare(input: RequestPreparationInput): Promise<RequestPreparationResult>;
}

export interface PreparedEvidenceDispatchPort {
  dispatch(input: PreparedEvidenceDispatchInput): Promise<PreparedEvidenceDispatchResult>;
}

/** Resolves model IDs through the same key, entitlement, and route authority as request preparation. */
export interface ModelDiscoveryPort {
  list(authenticatedCaller: AuthenticatedApiKey): Promise<readonly string[]>;
}

/**
 * Per-request context handed to a query endpoint handler after
 * authentication (roadmap 4.0 ③). Everything a #16/#17 task-status or
 * task-content reader needs; the boundary owns framing and security
 * headers, so the port never touches the response object.
 */
export interface SaasGatewayQueryRequestContext {
  readonly routeId: SaasGatewayQueryRouteId;
  readonly pathParameters: Readonly<Record<string, string>>;
  readonly authenticatedCaller: AuthenticatedApiKey;
}

/** Result contract for one query endpoint hit. */
export interface SaasGatewayQueryResult {
  /** Complete HTTP status for the client response (integer in 200..599). */
  readonly status: number;
  /** Response media type; defaults to application/json; charset=utf-8. */
  readonly contentType?: string;
  /** Body sent verbatim: string (JSON text) or Uint8Array (binary content). */
  readonly body?: Uint8Array | string | null;
}

/** Reserved query-endpoint port for #16/#17: async task status/content reads. */
export interface SaasGatewayQueryPort {
  serve(context: SaasGatewayQueryRequestContext): Promise<SaasGatewayQueryResult>;
}

/**
 * The aliases keep this adapter usable by composition code while it is still
 * being wired. A missing capability is handled as a closed 503 at request
 * time; this adapter never creates a local fallback authenticator or service.
 */
export interface SaasGatewayHttpOptions {
  readonly authenticator?: ProxyKeyAuthenticator;
  readonly proxyKeyAuthenticator?: ProxyKeyAuthenticator;
  readonly preparation?: RequestPreparationPort;
  readonly preparationService?: RequestPreparationPort;
  readonly dispatch?: PreparedEvidenceDispatchPort;
  readonly dispatchService?: PreparedEvidenceDispatchPort;
  readonly preDispatchCompensation?: GatewayPreDispatchCompensationPort;
  readonly modelDiscovery?: ModelDiscoveryPort;
  readonly maxBodyBytes?: number;
  /**
   * Endpoint-family POST body ceilings (roadmap 4.0 ①). Optional; each
   * family falls back to its documented default. Invalid values fail the
   * whole boundary closed (503), mirroring `maxBodyBytes`.
   */
  readonly endpointBodyLimits?: SaasGatewayEndpointFamilyBodyLimits;
  /**
   * Query endpoint family port (roadmap 4.0 ③): GET task status/content
   * reads for #16/#17. Absent means the deployment has no query authority
   * and hits fail closed with 503.
   */
  readonly queryEndpoints?: SaasGatewayQueryPort;
  readonly entryPoint?: string;
  /**
   * CIDRs of trusted reverse proxies allowed to attest X-Forwarded-For. Empty
   * (default) means only the socket peer is ever used as the client address.
   */
  readonly trustedProxyCidrs?: readonly string[];
  /**
   * Roadmap batch 2 §2.1: when true, this trusted boundary derives the merged
   * sticky-session reference (sub2api口径: metadata.user_id session UUID →
   * conversation_id → prompt_cache_key/ephemeral content → content fallback)
   * and fills input.scheduling.sessionId for the account scheduler's
   * affinity resolution. Default false keeps the boundary byte-identical:
   * a scheduling context REQUIRES the full scheduling chain (an account
   * scheduler with affinity binding), so only compositions that wire one
   * (the managed production gateway always does) may enable it.
   */
  readonly stickyScheduling?: boolean;
}

/** Server-created request identity passed by a trusted composition boundary. */
export interface SaasGatewayHttpRequestContext {
  readonly requestId: string;
}

export type SaasGatewayHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context?: SaasGatewayHttpRequestContext,
) => Promise<boolean>;

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super();
    this.name = 'GatewayHttpError';
  }
}

class ClientStreamError extends Error {
  constructor(readonly code: 'CLIENT_STREAM_ABORTED' | 'CLIENT_STREAM_FAILED') {
    super();
    this.name = 'ClientStreamError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function drainRequest(req: IncomingMessage): void {
  try {
    req.resume();
  } catch {
    // The response remains a stable error even when a test or transport shim
    // does not expose a fully functional IncomingMessage.
  }
}

function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const rawValues: string[] = [];
  const rawHeaders = req.rawHeaders ?? [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'idempotency-key') rawValues.push(rawHeaders[index + 1] ?? '');
  }
  if (rawValues.length > 1) throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  const raw = rawValues[0] ?? req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255 || raw.trim() !== raw) {
    throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  }
  if (
    [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  }
  return raw;
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    const pathname = new URL(req.url ?? '/', 'http://saas-gateway.invalid').pathname;
    return pathname.length <= MAX_PATH_LENGTH ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  requestId: string,
  message = 'The request could not be completed',
): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    });
    res.end(JSON.stringify({ error: { code, message, requestId } }));
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function sendHttpError(res: ServerResponse, error: GatewayHttpError, requestId: string, message?: string): void {
  writeJsonError(res, error.status, error.code, requestId, message);
}

function sendCanonicalRequestStatus(
  res: ServerResponse,
  requestId: string,
  canonicalRequest: CanonicalRequestStatusReference,
): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    const statusCode = canonicalRequest.status === 'completed' ? 200 : 202;
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
      'x-canonical-request-id': canonicalRequest.requestId,
    });
    res.end(
      JSON.stringify({
        object: 'request_status',
        id: canonicalRequest.requestId,
        status: canonicalRequest.status,
        response_replayed: false,
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function supportedContentType(req: IncomingMessage): boolean {
  const value = oneHeader(req, 'content-type');
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function declaredBodyLength(req: IncomingMessage, maxBodyBytes: number): 'valid' | 'too_large' | 'invalid' {
  const raw = req.headers['content-length'];
  if (raw === undefined) return 'valid';
  if (Array.isArray(raw) || typeof raw !== 'string') return 'invalid';
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return 'invalid';
  try {
    return BigInt(value) > BigInt(maxBodyBytes) ? 'too_large' : 'valid';
  } catch {
    return 'invalid';
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        throw new GatewayHttpError(400, 'INVALID_BODY');
      }
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBodyBytes) {
        drainRequest(req);
        throw new GatewayHttpError(413, 'BODY_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    drainRequest(req);
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }

  if (size === 0) throw new GatewayHttpError(400, 'INVALID_BODY');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }
  if (!isRecord(parsed)) throw new GatewayHttpError(400, 'INVALID_BODY');
  return parsed;
}

function clientAuthorityField(body: Record<string, unknown>): boolean {
  const forbidden = new Set(['endpoint', 'account', 'accountId', 'credential', 'credentialId', 'credentials']);
  return Object.keys(body).some((key) => forbidden.has(key));
}

function publicModel(body: Record<string, unknown>): string {
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model || model.length > MAX_MODEL_LENGTH) {
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }
  return model;
}

function bearerKey(req: IncomingMessage): string | undefined {
  const header = oneHeader(req, 'authorization');
  if (header === undefined) return undefined;
  const value = header.trim();
  const match = /^Bearer[ \t]+([^ \t\r\n]+)$/i.exec(value);
  if (!match || match[1].length === 0 || match[1].length > MAX_AUTHORIZATION_LENGTH) return undefined;
  return match[1];
}

async function authenticateCaller(
  req: IncomingMessage,
  authenticator: ProxyKeyAuthenticator,
): Promise<AuthenticatedApiKey> {
  const key = bearerKey(req);
  if (key === undefined) throw new GatewayHttpError(401, 'UNAUTHENTICATED');

  try {
    const authenticatedCaller = await authenticator.authenticate(key);
    if (!authenticatedCaller) throw new GatewayHttpError(401, 'UNAUTHENTICATED');
    return authenticatedCaller;
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    throw new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE');
  }
}

function authenticatedModelScopes(authenticatedCaller: AuthenticatedApiKey): readonly string[] | null {
  const authorizationScopes = authenticatedCaller?.authorization?.modelScopes;
  const metadataScopes = authenticatedCaller?.metadata?.modelScopes;
  if (
    authenticatedCaller?.metadata?.status !== 'active' ||
    !Array.isArray(authorizationScopes) ||
    !Array.isArray(metadataScopes) ||
    authorizationScopes.length === 0 ||
    authorizationScopes.length !== metadataScopes.length ||
    new Set(authorizationScopes).size !== authorizationScopes.length ||
    authorizationScopes.some(
      (scope, index) =>
        typeof scope !== 'string' ||
        scope.length === 0 ||
        scope.length > MAX_MODEL_LENGTH ||
        scope.trim() !== scope ||
        scope !== metadataScopes[index],
    )
  ) {
    return null;
  }
  return authorizationScopes;
}

function validatedDiscoveredModels(
  authenticatedCaller: AuthenticatedApiKey,
  models: unknown,
): readonly string[] | null {
  const scopes = authenticatedModelScopes(authenticatedCaller);
  if (!scopes || !Array.isArray(models)) return null;
  const scopeSet = new Set(scopes);
  const seen = new Set<string>();
  for (const model of models) {
    if (
      typeof model !== 'string' ||
      model.length === 0 ||
      model.length > MAX_MODEL_LENGTH ||
      model.trim() !== model ||
      !scopeSet.has(model) ||
      seen.has(model)
    ) {
      return null;
    }
    seen.add(model);
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function sendModelList(res: ServerResponse, requestId: string, models: readonly string[]): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    });
    res.end(
      JSON.stringify({
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'managed-saas' })),
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function sendQueryResult(res: ServerResponse, requestId: string, result: SaasGatewayQueryResult): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    res.writeHead(result.status, {
      'content-type': result.contentType ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    });
    res.end(result.body ?? '');
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

/** Defensive contract check for a query port result; invalid shapes fail closed to 503. */
function validQueryResult(value: SaasGatewayQueryResult): boolean {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) return false;
  if (value.body !== undefined && value.body !== null) {
    if (typeof value.body !== 'string' && !(value.body instanceof Uint8Array)) return false;
  }
  const contentType = value.contentType;
  if (contentType !== undefined) {
    if (
      typeof contentType !== 'string' ||
      contentType.length === 0 ||
      contentType.length > 128 ||
      [...contentType].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      return false;
    }
  }
  return true;
}

function safeAuditValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AUDIT_VALUE_LENGTH) return null;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    return null;
  }
  return value;
}

function requestAudit(req: IncomingMessage, entryPoint: string): Omit<PreparedRequestEvidenceAudit, 'actorUserId'> {
  return {
    entryPoint,
    sourceIp: safeAuditValue(req.socket?.remoteAddress) ?? null,
    userAgent: safeAuditValue(oneHeader(req, 'user-agent')),
  };
}

/**
 * G1: a header value is kept only when a single, non-empty, in-bounds string.
 * Oversized or ambiguous (multi-value) headers carry no detection shape a
 * genuine client produces; dropping them keeps the evidence bounded.
 */
function boundedClientEvidenceValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_CLIENT_EVIDENCE_VALUE_LENGTH) return undefined;
  return value;
}

/** G1: only the Claude-relevant headers, lowercased, values capped. */
function claudeCodeClientHeaders(req: IncomingMessage): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const name of Object.keys(req.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (
      !CLAUDE_CLIENT_EVIDENCE_HEADER_NAMES.has(normalized) &&
      !normalized.startsWith(CLAUDE_CLIENT_EVIDENCE_HEADER_PREFIX)
    ) {
      continue;
    }
    const value = boundedClientEvidenceValue(oneHeader(req, normalized));
    if (value !== undefined) collected[normalized] = value;
  }
  return collected;
}

/**
 * G1 (task #41): the trusted-boundary Claude Code client evidence forwarded
 * through request preparation into the scheduler input (F2 consumption).
 * The body is the exact parsed client object the payload compiler already
 * receives; the evidence itself never reaches logs, audits, or providers.
 */
function claudeCodeClientEvidence(
  req: IncomingMessage,
  path: string | undefined,
  body: Record<string, unknown>,
): ProviderAccountSchedulerClientEvidence {
  return {
    userAgent: boundedClientEvidenceValue(oneHeader(req, 'user-agent')) ?? null,
    path: path ?? null,
    headers: claudeCodeClientHeaders(req),
    body,
  };
}

function preparationError(result: RequestPreparationResult): GatewayHttpError {
  if (result.outcome !== 'prepared' && result.code === 'idempotency_conflict') {
    return new GatewayHttpError(409, 'IDEMPOTENCY_CONFLICT');
  }
  if (result.outcome !== 'prepared' && result.code === 'idempotency_replay') {
    return new GatewayHttpError(409, 'IDEMPOTENCY_REPLAY_UNAVAILABLE');
  }
  // R2 capability matrix: a provider that can never serve the requested
  // operation (e.g. embeddings outside the OpenAI protocol family) is a
  // missing capability, not an outage.
  if (result.outcome !== 'prepared' && result.code === 'capability_unsupported') {
    return new GatewayHttpError(404, 'CAPABILITY_UNSUPPORTED');
  }
  if (result.outcome === 'rejected') {
    // R1 (roadmap 1.3): authoritative rate ceilings (tenant/project/key RPM,
    // TPM and concurrency, and the billing-group RPM ceiling) are rate-limit
    // rejections — 429, not the generic 403 refusal.
    if (result.code === 'rate_limited' || result.code === 'quota_exceeded') {
      return new GatewayHttpError(429, 'RATE_LIMITED');
    }
    // R1 (roadmap 1.3, phase 3): spend ceilings (the wallet hold, the KEY-BUD
    // budget, and the billing-group daily/weekly/monthly spend windows) are
    // payment-required rejections — 402.
    if (result.code === 'budget_exceeded' || result.code === 'hold_denied') {
      return new GatewayHttpError(402, 'PAYMENT_REQUIRED');
    }
    return new GatewayHttpError(403, 'REQUEST_REJECTED');
  }
  return new GatewayHttpError(503, 'REQUEST_BLOCKED');
}

function isPreparedResult(value: RequestPreparationResult): value is RequestPreparationPreparedResult {
  return (
    isRecord(value) &&
    value.outcome === 'prepared' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    isRecord(value.evidence) &&
    typeof value.evidence.evidenceId === 'string' &&
    value.evidence.evidenceId.length > 0 &&
    value.payloadBytes instanceof Uint8Array
  );
}

function safeResponseHeaders(headers: Readonly<Record<string, string>>): OutgoingHttpHeaders {
  const allowlist = new Set([
    'cache-control',
    'content-encoding',
    'content-language',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'retry-after',
    'vary',
  ]);
  const reduced: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!allowlist.has(normalized) || typeof value !== 'string') continue;
    if (
      [...normalized, ...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      continue;
    }
    reduced[normalized] = value;
  }
  return reduced;
}

function responseStatus(status: number | null): number {
  if (status === null) return 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new ClientStreamError('CLIENT_STREAM_FAILED');
  }
  return status;
}

/**
 * Adapts the dispatch service's cancellation-aware sink to Node's response.
 * It deliberately does not expose arbitrary provider headers to the client.
 */
export class NodePreparedEvidenceClientStream implements PreparedEvidenceClientStream {
  private readonly controller = new AbortController();
  private responseStarted = false;
  private disposed = false;
  private readonly onRequestAborted = () => this.controller.abort();
  private readonly onRequestClose = () => {
    if (!this.request.complete) this.controller.abort();
  };
  private readonly onResponseClose = () => {
    if (!this.response.writableEnded) this.controller.abort();
  };
  private readonly onResponseError = () => this.controller.abort();

  constructor(
    private readonly request: IncomingMessage,
    private readonly response: ServerResponse,
    private readonly requestId: string,
  ) {
    this.request.once('aborted', this.onRequestAborted);
    this.request.once('close', this.onRequestClose);
    this.response.once('close', this.onResponseClose);
    this.response.once('error', this.onResponseError);
    // Cancellation can occur during awaited preparation, before listeners exist.
    if (
      this.request.aborted ||
      (!this.request.complete && this.request.destroyed) ||
      this.response.destroyed ||
      this.response.writableEnded
    ) {
      this.controller.abort();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (this.responseStarted || this.response.headersSent) throw new ClientStreamError('CLIENT_STREAM_FAILED');
    this.response.writeHead(responseStatus(status), {
      ...safeResponseHeaders(headers),
      'x-request-id': this.requestId,
    });
    this.responseStarted = true;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.writableEnded || this.response.destroyed) {
      throw new ClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (!(chunk instanceof Uint8Array)) throw new ClientStreamError('CLIENT_STREAM_FAILED');

    let accepted: boolean;
    try {
      accepted = this.response.write(Buffer.from(chunk));
    } catch {
      throw new ClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (accepted) return;
    await this.waitForDrain();
  }

  end(): void {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.destroyed) throw new ClientStreamError('CLIENT_STREAM_FAILED');
    if (!this.response.writableEnded) this.response.end();
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort();
    if (this.response.headersSent && !this.response.writableEnded && !this.response.destroyed) {
      try {
        this.response.destroy();
      } catch {
        // The socket is already unusable; the abort signal is the durable fact.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request.removeListener('aborted', this.onRequestAborted);
    this.request.removeListener('close', this.onRequestClose);
    this.response.removeListener('close', this.onResponseClose);
    this.response.removeListener('error', this.onResponseError);
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.response.removeListener('drain', onDrain);
        this.response.removeListener('close', onClose);
        this.response.removeListener('error', onError);
        this.signal.removeEventListener('abort', onAbort);
      };
      const settle = (error?: ClientStreamError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDrain = () => settle();
      const onClose = () => {
        this.controller.abort();
        settle(new ClientStreamError('CLIENT_STREAM_ABORTED'));
      };
      const onError = () => settle(new ClientStreamError('CLIENT_STREAM_FAILED'));
      const onAbort = () => settle(new ClientStreamError('CLIENT_STREAM_ABORTED'));

      this.response.once('drain', onDrain);
      this.response.once('close', onClose);
      this.response.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted || this.response.destroyed) onAbort();
    });
  }
}

function validMaxBodyBytes(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_MAX_BODY_BYTES;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validEntryPoint(value: string | undefined): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    return value;
  }
  return ENTRY_POINT;
}

function trustedRequestId(context: SaasGatewayHttpRequestContext | undefined): string | undefined {
  const requestId = context?.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256) return undefined;
  if (
    [...requestId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    return undefined;
  }
  return requestId;
}

export function createSaasGatewayHandler(options: SaasGatewayHttpOptions): SaasGatewayHttpHandler {
  const authenticator = options.authenticator ?? options.proxyKeyAuthenticator;
  const preparation = options.preparation ?? options.preparationService;
  const dispatch = options.dispatch ?? options.dispatchService;
  const modelDiscovery = options.modelDiscovery;
  const queryEndpoints = options.queryEndpoints;
  const bodyLimits = resolveSaasGatewayBodyLimits(validMaxBodyBytes(options.maxBodyBytes), options.endpointBodyLimits);
  const entryPoint = validEntryPoint(options.entryPoint);

  return async (req, res, context) => {
    const requestId = trustedRequestId(context) ?? `gateway_${randomUUID()}`;
    const path = requestPath(req);
    if (path === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(400, 'INVALID_PATH'), requestId);
      return true;
    }
    if (!path.startsWith(`${GATEWAY_PREFIX}/`) && path !== GATEWAY_PREFIX) return false;

    res.setHeader('x-request-id', requestId);

    if (bodyLimits === null || !authenticator) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
      return true;
    }

    if (path === '/v1/models') {
      drainRequest(req);
      if ((req.method ?? '').toUpperCase() !== 'GET') {
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      if (!modelDiscovery) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }

      let authenticatedCaller: AuthenticatedApiKey;
      try {
        authenticatedCaller = await authenticateCaller(req, authenticator);
      } catch (error) {
        sendHttpError(
          res,
          error instanceof GatewayHttpError ? error : new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE'),
          requestId,
        );
        return true;
      }

      let models: readonly string[] | null;
      try {
        models = validatedDiscoveredModels(authenticatedCaller, await modelDiscovery.list(authenticatedCaller));
      } catch {
        models = null;
      }
      if (!models) {
        sendHttpError(res, new GatewayHttpError(503, 'MODEL_DISCOVERY_UNAVAILABLE'), requestId);
        return true;
      }
      sendModelList(res, requestId, models);
      return true;
    }

    /*
     * Roadmap batch 4 §4.0 ④ + §4.3 (task #14): zero WebSocket
     * infrastructure is a recorded boundary, not an omission. Realtime
     * sessions need an independent upgrade handler plus a connection-scoped
     * admission/billing path parallel to the request-scoped
     * prepared-evidence lifecycle — that is task #17's separate sub-task.
     * The authoritative boundary is that the hosted server registers no
     * 'upgrade' listener (Node destroys such sockets); this check gives any
     * upgrade-shaped request that still reaches the request handler an
     * explicit, documented 501 instead of falling through to route
     * dispatch.
     */
    if (oneHeader(req, 'upgrade')?.trim().toLowerCase() === 'websocket') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(501, 'WEBSOCKET_UNSUPPORTED'), requestId, WEBSOCKET_UNSUPPORTED_MESSAGE);
      return true;
    }

    // §4.0 ③ (task #14): GET query endpoints — the /v1/models-style
    // lightweight bypass (authenticate, parse parameters, delegate); they
    // never enter preparation/admission because they read task state
    // instead of creating billable work.
    const queryRoute = matchQueryRoute(path);
    if (queryRoute !== null) {
      drainRequest(req);
      if ((req.method ?? '').toUpperCase() !== 'GET') {
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      if (!queryEndpoints) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }

      let authenticatedQueryCaller: AuthenticatedApiKey;
      try {
        authenticatedQueryCaller = await authenticateCaller(req, authenticator);
      } catch (error) {
        sendHttpError(
          res,
          error instanceof GatewayHttpError ? error : new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE'),
          requestId,
        );
        return true;
      }

      let queryResult: SaasGatewayQueryResult;
      try {
        queryResult = await queryEndpoints.serve({
          routeId: queryRoute.routeId,
          pathParameters: queryRoute.pathParameters,
          authenticatedCaller: authenticatedQueryCaller,
        });
        if (!validQueryResult(queryResult)) throw new Error('invalid query endpoint result');
      } catch {
        sendHttpError(res, new GatewayHttpError(503, 'QUERY_ENDPOINT_UNAVAILABLE'), requestId);
        return true;
      }
      sendQueryResult(res, requestId, queryResult);
      return true;
    }

    if (!preparation || !dispatch) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
      return true;
    }

    // §4.0 ② (task #14): reserved multipart-only media endpoints fail closed
    // with a precise, actionable 501 before any routing decision.
    if (MULTIPART_ONLY_ENDPOINT_PATHS.has(path)) {
      drainRequest(req);
      sendHttpError(
        res,
        new GatewayHttpError(501, 'MULTIPART_NOT_SUPPORTED'),
        requestId,
        MULTIPART_UNSUPPORTED_MESSAGE,
      );
      return true;
    }

    /*
     * §4.0 ① (task #14): the declared content-length bound is transport-level
     * admission control, so it runs before route resolution — every /v1
     * request, registered or not, is bounded by its endpoint family's
     * ceiling. The streaming accumulation below enforces the same resolved
     * value for bodies that do reach the read stage.
     */
    const pathBodyLimit = bodyLimitForPath(path, bodyLimits);
    const length = declaredBodyLength(req, pathBodyLimit);
    if (length === 'too_large') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(413, 'BODY_TOO_LARGE'), requestId);
      return true;
    }
    if (length === 'invalid') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(400, 'INVALID_BODY'), requestId);
      return true;
    }

    const protocol = ROUTES.get(path);
    if (protocol === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(404, 'NOT_FOUND'), requestId);
      return true;
    }

    if ((req.method ?? '').toUpperCase() !== 'POST') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
      return true;
    }

    if (!supportedContentType(req)) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'), requestId);
      return true;
    }

    let authenticatedCaller: AuthenticatedApiKey | null;
    try {
      authenticatedCaller = await authenticateCaller(req, authenticator);
    } catch (error) {
      drainRequest(req);
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE'),
        requestId,
      );
      return true;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, pathBodyLimit);
      if (clientAuthorityField(body)) throw new GatewayHttpError(400, 'INVALID_BODY');
    } catch (error) {
      const httpError = error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY');
      sendHttpError(res, httpError, requestId);
      return true;
    }

    let model: string;
    try {
      model = publicModel(body);
    } catch (error) {
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY'),
        requestId,
      );
      return true;
    }

    const auditContext = requestAudit(req, entryPoint);
    let requestIdempotencyKey: string | undefined;
    try {
      requestIdempotencyKey = idempotencyKey(req);
    } catch (error) {
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY'),
        requestId,
      );
      return true;
    }
    // Resolved at the trusted HTTP boundary only; the admission guard
    // fails closed on a non-disabled key IP policy without it. Also the
    // sticky-session content fallback's client discriminator.
    const clientAddress = resolveClientAddress(
      req.socket?.remoteAddress ?? '',
      req.headers['x-forwarded-for'],
      options.trustedProxyCidrs ?? [],
    );
    /*
     * Roadmap batch 2 §2.1 (task #5): the sticky-session scheduling seam.
     * The merged sessionHash derivation (sub2api口径: metadata.user_id
     * session UUID → conversation_id → prompt_cache_key/ephemeral content →
     * content fallback) runs here at the trusted boundary — the only place
     * that sees the parsed body, inbound headers, client address, and key
     * identity together — and fills input.scheduling.sessionId with one
     * opaque reference. Absent any session signal the field stays undefined
     * and the default preparation path is byte-identical. The reference is
     * request-scoped scheduler input only: never logged, never audited, and
     * HMACed by the durable affinity store before any SQL.
     */
    const scheduling = options.stickyScheduling
      ? stickySchedulingContext({
          protocol,
          headers: req.headers,
          body,
          clientIp: clientAddress.status === 'resolved' ? clientAddress.address : null,
          userAgent: oneHeader(req, 'user-agent') ?? null,
          proxyKeyId: authenticatedCaller.metadata.id,
          // Stateless operations (embeddings) never pin content-derived
          // sessions (the sub2api /v1/images precedent).
          stateless: ROUTE_CLIENT_OPERATIONS.has(path),
        })
      : undefined;
    let prepared: RequestPreparationResult;
    try {
      prepared = await preparation.prepare({
        authenticatedCaller,
        publicModel: model,
        protocol,
        // Server-owned, path-derived operation override (R2 embeddings);
        // absent for every route with a single canonical operation.
        clientOperation: ROUTE_CLIENT_OPERATIONS.get(path),
        clientRequest: body,
        idempotencyKey: requestIdempotencyKey,
        audit: auditContext,
        ...(scheduling ? { scheduling } : {}),
        clientAddress,
        // G1 (task #41): server-collected, bounded Claude Code client
        // evidence for the scheduler's claude_code_only enforcement (F2);
        // the clientAddress precedent — only this boundary may set it.
        claudeCodeClient: claudeCodeClientEvidence(req, path, body),
      });
    } catch {
      sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      return true;
    }

    if (!isPreparedResult(prepared)) {
      if (isRecord(prepared) && (prepared.outcome === 'rejected' || prepared.outcome === 'blocked')) {
        const rejected = prepared as RequestPreparationFailureResult;
        if (rejected.code === 'idempotency_replay' && rejected.canonicalRequest) {
          sendCanonicalRequestStatus(res, requestId, rejected.canonicalRequest);
          return true;
        }
        sendHttpError(res, preparationError(prepared as RequestPreparationResult), requestId);
      } else {
        sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      }
      return true;
    }
    if (prepared.requestId !== requestId) {
      sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      return true;
    }

    const client = new NodePreparedEvidenceClientStream(req, res, requestId);
    const preparedRequest = prepared;
    const compensate = async (cause: 'client_cancelled' | 'dispatch_failed') => {
      try {
        await options.preDispatchCompensation?.compensate({
          prepared: preparedRequest,
          cause,
          responseMayHaveStarted: res.headersSent,
        });
      } catch {
        // The transaction owner retains unresolved reservations; never retry here.
      }
    };
    if (client.signal.aborted) {
      await compensate('client_cancelled');
      client.dispose();
      return true;
    }
    // Phase 3 observability: in-flight watermark for the admitted request and
    // a request counter on response close; both are in-memory and never block
    // the dispatch path. Attached only once the request is truly dispatched so
    // the pre-dispatch cancellation path stays listener-free.
    const endInflight = beginGatewayInflightRequest();
    res.once('close', () => {
      endInflight();
      recordGatewayRequestEnd(path, res.statusCode ?? 0);
    });
    const dispatchAudit: PreparedRequestEvidenceAudit = {
      ...auditContext,
      actorUserId: authenticatedCaller.authorization.principalId,
      requestId,
    };
    let dispatched: PreparedEvidenceDispatchResult;
    const dispatchStartedAtMs = Date.now();
    // Route label is best-effort: the handler-level prepared contract does not
    // guarantee evidenceInput, so observability must never break dispatch.
    const dispatchRoute =
      isRecord(prepared.evidenceInput) && typeof prepared.evidenceInput.routeConfigId === 'string'
        ? prepared.evidenceInput.routeConfigId
        : 'unknown';
    try {
      dispatched = await dispatch.dispatch({
        evidenceId: prepared.evidence.evidenceId,
        payloadBytes: prepared.payloadBytes,
        normalSuccessSnapshot: prepared.normalSuccessSnapshot,
        audit: dispatchAudit,
        client,
      });
      const attemptStatus = dispatched.kind === 'sent' ? (dispatched.transport.resultHttpStatus ?? null) : null;
      recordGatewayAttemptOutcome({
        route: dispatchRoute,
        ok: dispatched.kind === 'sent' && attemptStatus !== null && attemptStatus >= 200 && attemptStatus < 300,
        durationMs: Date.now() - dispatchStartedAtMs,
      });
    } catch {
      recordGatewayAttemptOutcome({
        route: dispatchRoute,
        ok: false,
        durationMs: Date.now() - dispatchStartedAtMs,
      });
      const cause = client.signal.aborted ? 'client_cancelled' : 'dispatch_failed';
      client.abort();
      await compensate(cause);
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_FAILED'), requestId);
      client.dispose();
      return true;
    }
    client.dispose();

    if (!isRecord(dispatched) || (dispatched.kind !== 'sent' && dispatched.kind !== 'unknown')) {
      await compensate('dispatch_failed');
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_FAILED'), requestId);
      return true;
    }
    if (dispatched.kind === 'unknown' && !res.headersSent && !res.destroyed) {
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_OUTCOME_UNKNOWN'), requestId);
    }
    return true;
  };
}

export { createSaasGatewayHandler as createSaasHostedGatewayHandler };
