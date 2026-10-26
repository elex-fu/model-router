import { reportFastGatewayFailure, type FastGatewayDiagnosticObserver } from './fast/failure-diagnostic.js';
import { FastGatewayExecutionError, type FastGatewayExecutorPort } from './fast/executor.js';
import type { PersistentResponsesContinuationResolver, ResolvedResponsesHistory } from './responses-continuation-resolver.js';
import { normalizeResponsesHistoryConversationId, type ResponsesHistoryIdentity } from './responses-continuation-history.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AuthenticatedApiKey } from '../keys/types.js';
import {
  beginGatewayInflightRequest,
  recordGatewayAttemptOutcome,
  recordGatewayRequestEnd,
} from '../observability/metrics.js';
import type { GatewayCapabilityReadiness } from '../runtime/gateway-capability-readiness.js';
import { resolveClientAddress } from './client-address.js';
import type { GatewayProtocol } from './contracts.js';
import {
  COUNT_TOKENS_POLICY_HEADER,
  CountTokensRateLimiter,
  countTokensPolicyHeader,
  DEFAULT_COUNT_TOKENS_RATE_LIMIT_PER_MINUTE,
  estimateCountTokensInputTokens,
  resolveCountTokensPolicy,
} from './count-tokens.js';
import { matchGeminiNativeContentPath, matchSaasEndpointEntry } from './endpoint-registry.js';
import { geminiModelListResponseBody } from './gemini-model-list.js';
import type { SaasGatewayAsyncMediaPort, SaasGatewayAsyncMediaSubmission } from './images/async-media-port.js';
import { JsonKeepaliveClientStream } from './images/json-keepalive-client-stream.js';
import { RecordingClientStream } from './images/recording-client-stream.js';
import type { SaasModelPlazaPort } from './model-plaza/endpoint.js';
import { type GatewayMultipartEnvelope, GatewayMultipartParseError, parseMultipartBody } from './multipart-envelope.js';
import type { GatewayPreDispatchCompensationPort } from './pre-dispatch-compensation-service.js';
import {
  type PreparedEvidenceClientStream,
  type PreparedEvidenceDispatchInput,
  type PreparedEvidenceDispatchResult,
  SaasPreparedEvidenceDispatchError,
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
import { TeeRecordingClientStream } from './videos/tee-recording-client-stream.js';
import { extractVideoRequestIdFromBody } from './videos/video-billing.js';
import type { SaasGatewayVideoCreatePort } from './videos/video-create-port.js';

const GATEWAY_PREFIX = '/v1';
/**
 * R2 §7.2: the native Gemini inbound mount (`/v1beta/...`). Like /v1 it is
 * served by this handler; unknown /v1beta paths fall through to the generic
 * 404 exactly like unknown /v1 paths.
 */
const GATEWAY_BETA_PREFIX = '/v1beta';
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
/** §4.3 (task #17): the video create family shares the images media ceiling. */
const VIDEO_FAMILY_PATH_PREFIX = '/v1/videos/';

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
/*
 * G-B2: the STT family accepts multipart (normalized at the boundary when
 * a staging root is configured) AND direct JSON b64_json bodies — both
 * shapes are live. The remaining paths stay JSON-only for now.
 */
const MULTIPART_NORMALIZING_ENDPOINT_PATHS = new Set<string>(['/v1/audio/transcriptions', '/v1/audio/translations']);
const MULTIPART_ONLY_ENDPOINT_PATHS = new Set<string>([
  '/v1/images/edits',
  // §4.3 (task #17): the xAI Voice STT surface is multipart-only upstream
  // (sub2api bills it from the multipart body-size heuristic), so the JSON
  // gateway reserves the sub2api path shape with the same precise 501
  // instead of a 404 — the recorded STT legacy boundary.
  '/v1/stt',
]);
const MULTIPART_UNSUPPORTED_MESSAGE =
  'This endpoint accepts multipart/form-data or a JSON body with base64-encoded input; send a multipart/form-data request or a JSON body';
const MULTIPART_STAGING_UNAVAILABLE_MESSAGE =
  'Multipart parsing is not enabled on this deployment; use the JSON request shape with base64-encoded input instead';
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
  ['/v1/responses/compact', 'responses'],
  ['/v1/messages', 'anthropic'],
  // R2: the OpenAI embeddings operation rides the OpenAI inbound protocol
  // family; the per-route client operation below distinguishes it from chat.
  ['/v1/embeddings', 'openai'],
  // §4.3 (task #17): the standalone search endpoints ride the Responses
  // inbound family (the emulation constructs the outbound Responses body);
  // the per-route client operation below distinguishes web/x search.
  ['/v1/web_search', 'responses'],
  ['/v1/x_search', 'responses'],
  // §4.3 (task #17): the TTS audio passthrough rides the Responses inbound
  // family (the xAI Voice /tts surface rides the responses-family catalog
  // endpoint); the per-route client operation below distinguishes it. STT
  // stays unimplemented (the upstream /stt surface is multipart-only — see
  // the 501 reservation below); custom-voices CRUD stays unexposed this
  // phase (GET/PATCH/DELETE method dispatch + an unbilled admission shape
  // are its follow-up).
  ['/v1/tts', 'responses'],
  // G-B3: the OpenAI-standard speech path is a pure alias of /v1/tts — the
  // SAME audio.tts operation, request idempotency domain and pricing
  // policy (the plan's 别名不双扣 rule); only the route table entry
  // differs.
  ['/v1/audio/speech', 'responses'],
  // G-B2: the OpenAI-standard transcription/translation surfaces ride the
  // Responses family exactly like /v1/tts (the xAI Voice upstream); the
  // client operation below distinguishes the STT per-unit 'stt' tier.
  ['/v1/audio/transcriptions', 'responses'],
  ['/v1/audio/translations', 'responses'],
  // §4.2 (task #16): the images.generations operation rides the OpenAI
  // inbound protocol family (the R2 embeddings precedent); the async
  // submission endpoint is the same operation with a 202+task contract.
  ['/v1/images/generations', 'openai'],
  ['/v1/images/generations/async', 'openai'],
  // §4.3 (task #17): the async video create family rides the OpenAI
  // inbound protocol family the same way — a synchronous forward whose
  // upstream answers with a request id (the gateway-side task state is
  // the migration-124 snapshot, not a gateway-executed task).
  ['/v1/videos', 'openai'],
  ['/v1/videos/generations', 'openai'],
  ['/v1/videos/edits', 'openai'],
  ['/v1/videos/extensions', 'openai'],
]);

/**
 * Server-owned client operation overrides for routes whose protocol hosts
 * more than one canonical operation. Values are never read from the request
 * body; only this trusted HTTP boundary may set them.
 */
const ROUTE_CLIENT_OPERATIONS = new Map<string, string>([
  ['/v1/responses/compact', 'responses.compact'],
  ['/v1/embeddings', 'embeddings'],
  // §4.3 (task #17): search operations (server-owned, path-derived).
  ['/v1/web_search', 'web_search'],
  ['/v1/x_search', 'x_search'],
  // §4.3 (task #17): the TTS audio passthrough (server-owned, path-derived;
  // stateless — the spoken text is the entire billable input).
  ['/v1/tts', 'audio.tts'],
  // G-B3: /v1/audio/speech shares the audio.tts client operation.
  ['/v1/audio/speech', 'audio.tts'],
  // G-B2: the STT family (multipart normalized at the boundary or direct
  // JSON b64_json) — one server-owned operation for both surfaces.
  ['/v1/audio/transcriptions', 'audio.stt'],
  ['/v1/audio/translations', 'audio.stt'],
  // §4.2 (task #16): image generation operations (server-owned,
  // path-derived; stateless — the sub2api /v1/images precedent).
  ['/v1/images/generations', 'images.generations'],
  ['/v1/images/generations/async', 'images.generations'],
  // §4.3 (task #17): video create operations (server-owned, path-derived;
  // the bare /v1/videos path is the generations alias).
  ['/v1/videos', 'videos.generations'],
  ['/v1/videos/generations', 'videos.generations'],
  ['/v1/videos/edits', 'videos.edits'],
  ['/v1/videos/extensions', 'videos.extensions'],
]);

/**
 * §4.2 (task #16): the async image submission endpoint. It shares the
 * images.generations preparation/dispatch path; only the response contract
 * differs (202 + task poll instead of the upstream JSON body).
 */
const ASYNC_IMAGE_SUBMIT_PATH = '/v1/images/generations/async';
/** The poll route prefix a submitted task's Location header points at. */
const ASYNC_IMAGE_POLL_PATH_PREFIX = '/v1/images/tasks/';

/**
 * §4.3 (task #17): the async video create endpoints (the bare /v1/videos
 * path is the generations alias). These forward synchronously; the
 * migration-124 snapshot registration runs against the recorded create
 * response after dispatch completes.
 */
const VIDEO_CREATE_PATHS = new Set<string>([
  '/v1/videos',
  '/v1/videos/generations',
  '/v1/videos/edits',
  '/v1/videos/extensions',
]);

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
  /** Ceiling for POST bodies on /v1/videos/* endpoints. Default 10 MiB. */
  readonly videos?: number;
}

/** Resolved, immutable per-family body ceilings. `default` is the text family. */
export interface SaasGatewayBodyLimits {
  readonly default: number;
  readonly images: number;
  readonly audio: number;
  readonly videos: number;
}

/** Path-family body limit for one request path. Unmatched prefixes are text. */
export function bodyLimitForPath(path: string, limits: SaasGatewayBodyLimits): number {
  if (path.startsWith(IMAGE_FAMILY_PATH_PREFIX)) return limits.images;
  if (path.startsWith(AUDIO_FAMILY_PATH_PREFIX)) return limits.audio;
  if (path.startsWith(VIDEO_FAMILY_PATH_PREFIX)) return limits.videos;
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
  const videos = families?.videos ?? DEFAULT_IMAGE_FAMILY_BODY_BYTES;
  const valid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  if (!valid(images) || !valid(audio) || !valid(videos)) return null;
  return { default: maxBodyBytes, images, audio, videos };
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

/**
 * Resolves model IDs through the same key, entitlement and route authority as
 * preparation. Customer advertisements additionally require live sellability;
 * auxiliary authorization can still support direct authenticated verification.
 */
export interface ModelDiscoveryPort {
  list(
    authenticatedCaller: AuthenticatedApiKey,
    purpose: 'advertisement' | 'authorization',
  ): Promise<readonly string[]>;
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
  /**
   * §4.3 (task #17): the bounded client `Range` header for the video
   * content proxy (the only header the task-content route needs; absent
   * for every other query route). Collected at the trusted boundary,
   * capped, and never derived from request bodies.
   */
  readonly clientRangeHeader?: string | null;
}

/** Result contract for one query endpoint hit. */
export interface SaasGatewayQueryResult {
  /** Complete HTTP status for the client response (integer in 200..599). */
  readonly status: number;
  /** Response media type; defaults to application/json; charset=utf-8. */
  readonly contentType?: string;
  /** Body sent verbatim: string (JSON text) or Uint8Array (binary content). */
  readonly body?: Uint8Array | string | null;
  /**
   * §4.2 (task #16): optional Retry-After polling hint (integer seconds)
   * for task endpoints — a processing image task reports 3 (the sub2api
   * image_task_handler.Get precedent). The boundary owns the actual header.
   */
  readonly retryAfterSeconds?: number;
}

/** Reserved query-endpoint port for #16/#17: async task status/content reads. */
export interface SaasGatewayQueryPort {
  serve(context: SaasGatewayQueryRequestContext): Promise<SaasGatewayQueryResult>;
}

/**
 * Content risk control (roadmap batch 5 §5.4, task #19): the moderation seam
 * runs exactly once per request, after proxy-key authentication and body/model
 * extraction and strictly before request preparation — it never enters the
 * preparation transaction. A hit returns the configured block status with the
 * `content_policy_violation` code; every failure inside the port must allow
 * the request (fail-open is the port's own contract, and this boundary also
 * defends against a port that throws).
 */
export interface ContentModerationCheckRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly apiKeyId: string;
  readonly apiKeyName: string;
  /** R2 §7.2: native Gemini inbound bodies join the moderation seam. */
  readonly protocol: 'anthropic' | 'openai' | 'responses' | 'gemini';
  readonly model: string;
  readonly body: Record<string, unknown>;
}

export interface ContentModerationCheckResponse {
  readonly allowed: boolean;
  /** HTTP status for the rejection (400..599; 403 by default). */
  readonly statusCode: number;
  readonly message: string;
}

export interface ContentModerationPort {
  check(input: ContentModerationCheckRequest): Promise<ContentModerationCheckResponse>;
}

/**
 * The aliases keep this adapter usable by composition code while it is still
 * being wired. A missing capability is handled as a closed 503 at request
 * time; this adapter never creates a local fallback authenticator or service.
 */
/**
 * G-C1: the readiness report — process liveness is implied by answering at
 * all; every field beyond it must be non-secret (never a key, internal
 * address or raw SQL). A single optional upstream being down does NOT make
 * the gateway unready (§13.2); only required dependencies do.
 */
export interface SaasGatewayReadinessReport {
  readonly database: 'ok' | 'error' | 'unknown';
  /** The applied migration head when the database is readable; null otherwise. */
  readonly migrationHead: number | null;
  /** Required-dependency states; every value must be 'ok' for readiness. */
  readonly dependencies: Readonly<Record<string, 'ok' | 'error' | 'unknown'>>;
  /** Per-capability assembled flags (present only for registered capabilities). */
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** Sanitized v2 projection; absent on the original v1 runtime contract. */
  readonly providerCapabilities?: GatewayCapabilityReadiness;
}

export interface SaasGatewayReadinessProvider {
  /** Must never throw — an unavailable authority reports 'unknown'. */
  readiness(): Promise<SaasGatewayReadinessReport>;
}

export interface SaasGatewayHttpOptions {
  /** Opt-in text data plane; fallback is allowed only before durable intent. */
  readonly fastGateway?: FastGatewayExecutorPort;
  /** Failure-only, sanitized and nonblocking; observer failures never affect the response. */
  readonly fastGatewayDiagnostic?: FastGatewayDiagnosticObserver;
  readonly continuationHistoryResolver?: PersistentResponsesContinuationResolver;
  /**
   * G-B4: the Responses WebSocket surface. When present, an upgrade
   * request on GET /v1/responses hands the socket to this handle (the
   * connection layer's auth/Origin/limits already ran by construction);
   * absent keeps the recorded 501 boundary. Non-upgrade GET /v1/responses
   * answers the precise 426.
   */
  readonly responsesWs?: {
    /** True when this handle owns the request (the /v1/responses path). */
    readonly handleUpgrade: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean;
    readonly close: () => Promise<void>;
  };
  /**
   * G-B2: the multipart staging root for /v1/audio/transcriptions,
   * /v1/audio/translations and /v1/images/edits multipart inputs. Each
   * request parses into its own subdirectory (mode 0700) under this root;
   * the request handler removes it after the body normalizes to JSON
   * (b64_inline) — files are never retained past the boundary. Absent
   * keeps the multipart endpoints closed with the reserved 501.
   */
  readonly multipartStagingRoot?: string;
  /**
   * G-C1: the readiness authority for GET /readyz — reports the process,
   * database/migration state, required dependencies and per-capability
   * assembled flags. Absent keeps /readyz answering the process-only
   * payload (the same contract as the local proxy's /healthz liveness —
   * probe SPLIT: /readyz = readiness, /healthz = liveness).
   */
  readonly readiness?: SaasGatewayReadinessProvider;
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
  /**
   * Content risk control (roadmap batch 5 §5.4, task #19): post-auth,
   * pre-preparation moderation. Absent means the deployment runs without
   * risk control — the request path is byte-identical.
   */
  readonly contentModeration?: ContentModerationPort;
  /**
   * Model plaza port (roadmap batch 5 §5.5, task #22): the read-only
   * GET /v1/model-plaza showcase with three-tier authentication (proxy key /
   * console session / anonymous). Absent means the deployment has no plaza
   * authority and hits fail closed with 503.
   */
  readonly modelPlaza?: SaasModelPlazaPort;
  /**
   * §4.2 (task #16): the async image task port (task store + S3 offload).
   * Absent keeps POST /v1/images/generations/async closed with 503.
   */
  readonly asyncMedia?: SaasGatewayAsyncMediaPort;
  /**
   * §4.3 (task #17): the video create-time persistence port (the
   * migration-124 snapshot + bound-account binding). Absent keeps the
   * POST /v1/videos* create endpoints closed with 503; the GET status and
   * content query routes serve through `queryEndpoints` regardless.
   */
  readonly videoCreate?: SaasGatewayVideoCreatePort;
  /**
   * §4.2 (task #16): non-streaming JSON keepalive for the synchronous
   * images endpoint — whitespace heartbeats while waiting for a slow
   * upstream (the sub2api StartOpenAIImagesJSONKeepalive semantics; the
   * first heartbeat commits status 200 and late upstream errors pass
   * through as an error JSON body). Default 0 (disabled) keeps every
   * pre-#16 response byte-identical.
   */
  readonly imageKeepaliveIntervalMs?: number;
  /**
   * §4.2: the async task execution timeout (default 30 minutes, the
   * sub2api defaultImageTaskExecutionTimeout).
   */
  readonly asyncExecutionTimeoutMs?: number;
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
  /**
   * R2 §7.2: independent per-key rate limit for POST
   * /v1/messages/count_tokens (requests per 60s window). The auxiliary
   * operation must not share the generation admission budget. Default 120.
   */
  readonly countTokensRateLimitPerMinute?: number;
  /**
   * R2 §7.2: per-model predicate for supplies that declare NATIVE upstream
   * token counting. Absent (or false) keeps the boundary on the explicit
   * local-estimate policy, labeled on every response.
   */
  readonly countTokensNativeSupply?: (model: string) => boolean;
  /**
   * R2 §7.2: per-model predicate for supplies that declare NATIVE compact
   * support. Absent (or false) fails /v1/responses/compact closed with 404
   * CAPABILITY_UNSUPPORTED — opaque compact items are never forged through
   * the Chat bridge.
   */
  readonly responsesCompactNativeSupply?: (model: string) => boolean;
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
    /** Core-plan 9.2: optional Retry-After (integer seconds) on 429 responses. */
    readonly retryAfterSeconds?: number,
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

/** Classify inference using the same route authorities as the HTTP dispatcher. */
export function isSaasGatewayInferenceRequest(req: IncomingMessage): boolean {
  if ((req.method ?? '').toUpperCase() !== 'POST') return false;
  if (oneHeader(req, 'upgrade')?.trim().toLowerCase() === 'websocket') return false;
  const path = requestPath(req);
  return path !== undefined && (ROUTES.has(path) || matchGeminiNativeContentPath(path) !== null);
}

/** Reject before authentication, preparation, or any database work. */
export function rejectSaasGatewayCapacityRequest(req: IncomingMessage, res: ServerResponse, requestId: string): void {
  drainRequest(req);
  writeJsonError(res, 429, 'GATEWAY_CAPACITY_EXHAUSTED', requestId, undefined, 1);
}

/**
 * §4.3 (task #17): the bounded client `Range` header for the video content
 * proxy — single header value, capped, printable ASCII only. Anything else
 * is dropped (the content fetch then runs without a range).
 */
function boundedRangeHeader(req: IncomingMessage): string | null {
  const raw = oneHeader(req, 'range');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 512) return null;
  if ([...trimmed].some((character) => character.charCodeAt(0) < 0x21 || character.charCodeAt(0) > 0x7e)) {
    return null;
  }
  return trimmed;
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  requestId: string,
  message = 'The request could not be completed',
  retryAfterSeconds?: number,
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
      ...(typeof retryAfterSeconds === 'number' &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 0 &&
      retryAfterSeconds <= 86400
        ? { 'retry-after': String(retryAfterSeconds) }
        : {}),
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
  writeJsonError(
    res,
    error.status,
    error.code,
    requestId,
    message,
    error.retryAfterSeconds !== undefined && Number.isSafeInteger(error.retryAfterSeconds)
      ? error.retryAfterSeconds
      : undefined,
  );
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

/**
 * §4.2 (task #16): the async submission acceptance response — the sub2api
 * image_task_handler.Submit contract (202 + Cache-Control: no-store +
 * Location + Retry-After: 3 + the accepted task body).
 */
function sendAsyncAccepted(
  res: ServerResponse,
  requestId: string,
  submission: { readonly taskId: string; readonly createdAt: number; readonly expiresAt: number },
): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const pollUrl = `${ASYNC_IMAGE_POLL_PATH_PREFIX}${submission.taskId}`;
  try {
    res.writeHead(202, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
      location: pollUrl,
      'retry-after': '3',
    });
    res.end(
      JSON.stringify({
        id: submission.taskId,
        task_id: submission.taskId,
        object: 'image.generation.task',
        status: 'processing',
        created_at: submission.createdAt,
        expires_at: submission.expiresAt,
        poll_url: pollUrl,
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

/** A bounded best-effort capture. Overflow disables history without affecting inference delivery. */
class ResponsesHistoryHttpCapture implements PreparedEvidenceClientStream {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private complete = false;
  private overflow = false;
  private status: number | null = null;
  private headers: Readonly<Record<string,string>> = {};
  private started = false;
  private finished = false;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private pending = '';
  private held = '';
  private terminal = false;
  private streaming = false;
  constructor(private readonly inner: NodePreparedEvidenceClientStream | JsonKeepaliveClientStream) {}
  get signal(): AbortSignal { return this.inner.signal; }
  async start(status: number | null, headers: Readonly<Record<string,string>>): Promise<void> {
    this.status = status; this.headers = headers;
    const contentType = Object.entries(headers).find(([name])=>name.toLowerCase()==='content-type')?.[1];
    this.streaming = typeof contentType === 'string' && contentType.split(';',1)[0].trim().toLowerCase()==='text/event-stream';
    if (this.streaming) { await this.inner.start(status,headers); this.started = true; }
  }
  private async sendText(text: string): Promise<void> { if (text) await this.inner.write(this.encoder.encode(text)); }
  async write(chunk: Uint8Array): Promise<void> {
    if (!this.overflow && chunk.byteLength > 16*1024*1024-this.size) {
      this.overflow = true;
      if (!this.streaming) {
        if (!this.started) { await this.inner.start(this.status,this.headers); this.started = true; }
        for (const old of this.chunks) await this.inner.write(old);
      }
      this.clear();
    }
    if (!this.overflow) { this.chunks.push(new Uint8Array(chunk)); this.size += chunk.byteLength; }
    if (!this.streaming) { if (this.overflow) await this.inner.write(chunk); return; }
    const text = this.decoder.decode(chunk,{stream:true});
    if (this.overflow) { await this.sendText(this.held+this.pending+text); this.held=''; this.pending=''; return; }
    this.pending += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) {
      const block = this.pending.slice(0,boundary.index+boundary[0].length); this.pending=this.pending.slice(block.length);
      if (!this.terminal) {
        const data = block.split(/\r\n|\n|\r/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
        try { const event: unknown = data && data !== '[DONE]' ? JSON.parse(data) : null; if (isRecord(event) && ['response.completed','response.incomplete','response.failed','response.cancelled','error'].includes(String(event.type))) this.terminal=true; } catch { /* malformed upstream bytes remain verbatim */ }
      }
      if (this.terminal) this.held+=block; else await this.sendText(block);
    }
  }
  async end(): Promise<void> { if (this.streaming) this.pending+=this.decoder.decode(); this.complete=true; }
  async finish(): Promise<void> {
    if (this.finished || this.signal.aborted) { this.clear(); return; } this.finished=true;
    try {
      if (!this.started) { await this.inner.start(this.status,this.headers); this.started=true; }
      if (this.streaming) await this.sendText(this.held+this.pending);
      else if (!this.overflow) for (const chunk of this.chunks) await this.inner.write(chunk);
      await this.inner.end();
    } finally { this.held=''; this.pending=''; this.clear(); }
  }
  async abort(error?: unknown): Promise<void> { this.complete=false; this.held=''; this.pending=''; this.clear(); await this.inner.abort(error); }
  dispose(): void { this.inner.dispose(); }
  clear(): void { for (const chunk of this.chunks) chunk.fill(0); this.chunks=[]; this.size=0; }
  response(compact: boolean): {id: string; output: readonly unknown[]} | null {
    if (!this.complete || this.overflow || this.signal.aborted || this.status === null || this.status < 200 || this.status >= 300) return null;
    let bytes: Buffer | undefined;
    try {
      bytes=Buffer.concat(this.chunks); const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);
      let response: unknown;
      if (!this.streaming) response=JSON.parse(text);
      else {
        for (const block of text.split(/\r\n\r\n|\n\n|\r\r/)) {
          const data=block.split(/\r\n|\n|\r/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
          if (!data || data==='[DONE]') continue;
          const event: unknown=JSON.parse(data);
          if (isRecord(event) && ['response.completed','response.incomplete'].includes(String(event.type))) { if (response!==undefined) return null; response=event.response; }
          if (isRecord(event) && ['response.failed','response.cancelled','error'].includes(String(event.type))) return null;
        }
      }
      if (!isRecord(response) || typeof response.id!=='string' || response.id.length<1 || response.id.length>512 || !Array.isArray(response.output) || response.error) return null;
      if (!compact && response.status!=='completed' && response.status!=='incomplete') return null;
      return {id:response.id,output:response.output};
    } catch { return null; } finally { bytes?.fill(0); }
  }
}
function responsesHistoryPreparedIdentity(prepared: RequestPreparationPreparedResult, conversationId: string, caller: AuthenticatedApiKey): ResponsesHistoryIdentity | null {
  const e = prepared.evidenceInput;
  if (!e || e.tenantId !== caller.metadata.tenantId || e.projectId !== caller.metadata.projectId || e.proxyKeyId !== caller.metadata.id) return null;
  const identity = {tenantId:e.tenantId,projectId:e.projectId,proxyKeyId:e.proxyKeyId,conversationId,providerId:e.providerId,productId:e.productId,accountId:e.accountId,credentialId:e.credentialId,credentialVersion:String(e.credentialVersion),credentialAuthzVersion:String(e.credentialAuthzVersion),publicModel:e.publicModel,resolvedModel:e.resolvedModel};
  if (Object.values(identity).some(value=>typeof value !== 'string' || value.length < 1) || !/^[1-9][0-9]*$/.test(identity.credentialVersion) || !/^[1-9][0-9]*$/.test(identity.credentialAuthzVersion)) return null;
  return identity;
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

/*
 * Native Anthropic clients (Claude Code, the Anthropic SDKs) present the API
 * key in x-api-key rather than a Bearer authorization header. The gateway
 * accepts the same key material through either presentation: when an
 * authorization header is present it remains authoritative (malformed values
 * still fail closed), otherwise a bounded non-empty x-api-key value is used.
 * The single authenticator and its trust model are unchanged.
 */
function apiKeyHeader(req: IncomingMessage): string | undefined {
  const header = oneHeader(req, 'x-api-key');
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value.length === 0 || value.length > MAX_AUTHORIZATION_LENGTH) return undefined;
  return value;
}

function callerKey(req: IncomingMessage): string | undefined {
  return oneHeader(req, 'authorization') !== undefined ? bearerKey(req) : apiKeyHeader(req);
}

/*
 * Model plaza (task #22): the console session cookie value, for the plaza's
 * session tier. The gateway boundary only parses the bounded cookie pair it
 * knows by name; validation belongs to the plaza port's session authority.
 */
const PLAZA_SESSION_COOKIE_NAME = 'mr_saas_session';

function plazaSessionToken(req: IncomingMessage): string | null {
  const header = oneHeader(req, 'cookie');
  if (header === undefined || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== PLAZA_SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value.length === 0 || value.length > MAX_AUTHORIZATION_LENGTH) return null;
    return value;
  }
  return null;
}

async function authenticateCaller(
  req: IncomingMessage,
  authenticator: ProxyKeyAuthenticator,
): Promise<AuthenticatedApiKey> {
  const key = callerKey(req);
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

/**
 * R2 §7.2: the native Gemini ListModels envelope for the caller-scoped
 * model list (same scope-validated input as sendModelList).
 */
function sendGeminiModelList(res: ServerResponse, requestId: string, models: readonly string[]): void {
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
    res.end(JSON.stringify(geminiModelListResponseBody(models)));
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
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
      ...(typeof result.retryAfterSeconds === 'number' &&
      Number.isSafeInteger(result.retryAfterSeconds) &&
      result.retryAfterSeconds >= 0 &&
      result.retryAfterSeconds <= 86400
        ? { 'retry-after': String(result.retryAfterSeconds) }
        : {}),
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
      return new GatewayHttpError(429, 'RATE_LIMITED', result.retryAfterSeconds);
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

/**
 * §4.2: the async task execution timeout — default 30 minutes (the sub2api
 * defaultImageTaskExecutionTimeout); invalid injected values fall back to
 * the default rather than failing the boundary.
 */
const DEFAULT_ASYNC_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;
function validAsyncExecutionTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ASYNC_EXECUTION_TIMEOUT_MS;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ASYNC_EXECUTION_TIMEOUT_MS;
}

/** §4.2: the keepalive heartbeat cadence; default 0 (disabled). */
function validKeepaliveInterval(value: number | undefined): number {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
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
  const contentModeration = options.contentModeration;
  const modelPlaza = options.modelPlaza;
  const trustedProxyCidrs = options.trustedProxyCidrs;
  const bodyLimits = resolveSaasGatewayBodyLimits(validMaxBodyBytes(options.maxBodyBytes), options.endpointBodyLimits);
  const entryPoint = validEntryPoint(options.entryPoint);
  const countTokensRateLimiter = new CountTokensRateLimiter(
    options.countTokensRateLimitPerMinute ?? DEFAULT_COUNT_TOKENS_RATE_LIMIT_PER_MINUTE,
  );

  return async (req, res, context) => {
    const requestId = trustedRequestId(context) ?? `gateway_${randomUUID()}`;
    // G-B2: set when a multipart media request was normalized at the
    // boundary; the JSON body read then consumes this instead of the wire.
    let multipartNormalizedBody: { body: string; contentType: string; contentLength: number } | undefined;
    let nativeCompactRequest: { authenticatedCaller: AuthenticatedApiKey; body: Record<string, unknown> } | undefined;
    const path = requestPath(req);
    if (path === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(400, 'INVALID_PATH'), requestId);
      return true;
    }
    /*
     * G-C1: GET /readyz — the readiness probe (the process-liveness half is
     * answering at all). Unauthenticated by design (a probe must not depend
     * on key auth), never exposes secrets/internal addresses, and reports
     * per-capability assembled flags from the readiness provider. A single
     * optional upstream being down does NOT fail readiness — only required
     * dependencies (the provider encodes which is which).
     */
    if (path === '/readyz' || path.startsWith('/readyz?')) {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        drainRequest(req);
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      let report: SaasGatewayReadinessReport = {
        database: 'unknown',
        migrationHead: null,
        dependencies: {},
        capabilities: {},
      };
      if (options.readiness) {
        try {
          report = await options.readiness.readiness();
        } catch {
          // an unavailable authority reports the process-only payload
        }
      }
      const requiredOk = Object.values(report.dependencies).every((state) => state === 'ok');
      const ready = report.database !== 'error' && requiredOk;
      const body = JSON.stringify({
        status: ready ? 'ready' : 'not-ready',
        database: report.database,
        migrationHead: report.migrationHead,
        dependencies: report.dependencies,
        capabilities: report.capabilities,
        ...(report.providerCapabilities === undefined ? {} : { providerCapabilities: report.providerCapabilities }),
      });
      res.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      if (method === 'HEAD') res.end();
      else res.end(body);
      return true;
    }

    if (
      !path.startsWith(`${GATEWAY_PREFIX}/`) &&
      path !== GATEWAY_PREFIX &&
      !path.startsWith(`${GATEWAY_BETA_PREFIX}/`) &&
      path !== GATEWAY_BETA_PREFIX
    ) {
      return false;
    }

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
        models = validatedDiscoveredModels(
          authenticatedCaller,
          await modelDiscovery.list(authenticatedCaller, 'advertisement'),
        );
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
     * Model plaza (roadmap batch 5 §5.5, task #22): a read-only showcase
     * mount with its own three-tier authentication (proxy key / console
     * session / anonymous) — the one /v1 surface where anonymous access is
     * by design, gated by the plaza settings port. Like /v1/models and the
     * query endpoints, it never enters preparation/admission: it reads state
     * instead of creating billable work. All tier decisions, settings
     * gating, and rate limiting live inside the port (model-plaza/endpoint).
     */
    if (path === '/v1/model-plaza') {
      drainRequest(req);
      if ((req.method ?? '').toUpperCase() !== 'GET') {
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      if (!modelPlaza) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }
      let plazaResult: SaasGatewayQueryResult;
      try {
        const clientAddress = resolveClientAddress(
          req.socket?.remoteAddress ?? '',
          req.headers['x-forwarded-for'],
          trustedProxyCidrs ?? [],
        );
        plazaResult = await modelPlaza.serve({
          requestId,
          bearerToken: bearerKey(req) ?? null,
          sessionToken: plazaSessionToken(req),
          clientAddress: clientAddress.status === 'resolved' ? clientAddress.address : null,
          authenticateProxyKey: (rawKey) => authenticator.authenticate(rawKey),
        });
      } catch {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }
      sendQueryResult(res, requestId, plazaResult);
      return true;
    }

    /*
     * R2 §7.2 (docs/core-capability-alignment-technical-plan-2026-10-18.md):
     * GET /v1beta/models — the native Gemini ListModels surface. Like
     * GET /v1/models it reads state instead of creating billable work, but
     * the list is strictly the CURRENT caller's key permissions ∩ sellable
     * capabilities (§6.3): the advertisement modelDiscovery port output,
     * never the raw provider list.
     */
    if (path === '/v1beta/models') {
      drainRequest(req);
      const endpointMatch = matchSaasEndpointEntry(req.method ?? '', path);
      if (!endpointMatch.matched || !endpointMatch.methodAllowed) {
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
        models = validatedDiscoveredModels(
          authenticatedCaller,
          await modelDiscovery.list(authenticatedCaller, 'advertisement'),
        );
      } catch {
        models = null;
      }
      if (!models) {
        sendHttpError(res, new GatewayHttpError(503, 'MODEL_DISCOVERY_UNAVAILABLE'), requestId);
        return true;
      }
      sendGeminiModelList(res, requestId, models);
      return true;
    }

    /*
     * R2 §7.2: POST /v1/messages/count_tokens — a metered-but-not-generation
     * auxiliary operation. It does NOT ride the generation preparation path
     * (that hold reserves an output bound, which §7.2 explicitly forbids
     * count_tokens from consuming); instead the boundary enforces the full
     * auth → model-scope → independent-rate-limit admission itself and
     * answers under an EXPLICIT counting policy. The policy is labeled on
     * every response via x-model-router-count-policy; the pricing policy is
     * declared (explicit-zero), never implicit free. When a supply declares
     * native upstream counting (countTokensNativeSupply), the boundary
     * fails closed toward the native path rather than silently estimating.
     */
    if (path === '/v1/messages/count_tokens') {
      const endpointMatch = matchSaasEndpointEntry(req.method ?? '', path);
      if (!endpointMatch.matched || !endpointMatch.methodAllowed) {
        drainRequest(req);
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      let authenticatedCaller: AuthenticatedApiKey;
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
      if (!supportedContentType(req)) {
        drainRequest(req);
        sendHttpError(res, new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'), requestId);
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
      // Keep the PG-authoritative caller/entitlement/route intersection for
      // direct counting. Commercial advertisement verification is separate,
      // so an operator can verify an authorized route before publishing it.
      // Out-of-scope fails closed like preparation-stage account_denied.
      if (!modelDiscovery) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }
      let discovered: readonly string[] | null;
      try {
        discovered = validatedDiscoveredModels(
          authenticatedCaller,
          await modelDiscovery.list(authenticatedCaller, 'authorization'),
        );
      } catch {
        discovered = null;
      }
      if (!discovered?.includes(model)) {
        sendHttpError(
          res,
          new GatewayHttpError(403, 'REQUEST_REJECTED'),
          requestId,
          'the requested model is not available to this key',
        );
        return true;
      }
      // Independent rate limit: never shares the generation RPM budget.
      const rateDecision = countTokensRateLimiter.check(authenticatedCaller.metadata.id);
      if (!rateDecision.allowed) {
        sendHttpError(res, new GatewayHttpError(429, 'RATE_LIMITED', rateDecision.retryAfterSeconds), requestId);
        return true;
      }
      const policy = resolveCountTokensPolicy(options.countTokensNativeSupply?.(model) ?? false);
      if (policy.kind === 'native-upstream') {
        // A supply declared native counting but this boundary has no
        // assembled native count transport yet: fail closed, never
        // silently substitute the estimate.
        sendHttpError(
          res,
          new GatewayHttpError(501, 'NATIVE_COUNT_TOKENS_UNAVAILABLE'),
          requestId,
          'the resolved supply declares native token counting but no native count transport is assembled in this deployment',
        );
        return true;
      }
      const inputTokens = estimateCountTokensInputTokens(body);
      if (res.destroyed || res.writableEnded) return true;
      try {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'x-request-id': requestId,
          [COUNT_TOKENS_POLICY_HEADER]: countTokensPolicyHeader(policy),
        });
        res.end(JSON.stringify({ input_tokens: inputTokens }));
      } catch {
        try {
          res.destroy();
        } catch {
          // Nothing else is safe after the response write failed.
        }
      }
      return true;
    }

    /*
     * R2 §7.2: POST /v1/responses/compact — served ONLY by supplies that
     * explicitly declare NATIVE compact support. Opaque compact items are
     * never forged through the Chat bridge: a supply without the declared
     * capability is a missing capability (404 CAPABILITY_UNSUPPORTED, the
     * embeddings precedent). A declared supply enters the normal signed
     * preparation and dispatch lifecycle using its native compact target.
     */
    if (path === '/v1/responses/compact') {
      const endpointMatch = matchSaasEndpointEntry(req.method ?? '', path);
      if (!endpointMatch.matched || !endpointMatch.methodAllowed) {
        drainRequest(req);
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      let authenticatedCaller: AuthenticatedApiKey;
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
      if (!supportedContentType(req)) {
        drainRequest(req);
        sendHttpError(res, new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'), requestId);
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
      if (!authenticatedModelScopes(authenticatedCaller)?.includes(model)) {
        sendHttpError(
          res,
          new GatewayHttpError(403, 'REQUEST_REJECTED'),
          requestId,
          'the requested model is not available to this key',
        );
        return true;
      }
      if (!options.responsesCompactNativeSupply?.(model)) {
        sendHttpError(
          res,
          new GatewayHttpError(404, 'CAPABILITY_UNSUPPORTED'),
          requestId,
          'responses.compact is served only by supplies that declare native compact support; compact items are never served through the chat bridge',
        );
        return true;
      }
      if (body.stream === true) {
        sendHttpError(
          res,
          new GatewayHttpError(400, 'INVALID_BODY'),
          requestId,
          'responses.compact is not a streaming operation',
        );
        return true;
      }
      // Native compact continues through the same preparation, admission,
      // evidence, dispatch and settlement path as every billable request.
      nativeCompactRequest = { authenticatedCaller, body };
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
      // G-B4: GET /v1/responses upgrades to the Responses WebSocket when
      // the deployment mounted the surface; every other path keeps the
      // recorded 501 boundary.
      if (options.responsesWs !== undefined && path === '/v1/responses') {
        // The raw socket upgrade leaves the ServerResponse world: the
        // handler returns true (handled) and the WS layer owns the socket.
        const socket = (req as unknown as { socket?: import('node:stream').Duplex }).socket;
        if (socket !== undefined) {
          options.responsesWs.handleUpgrade(req, socket, Buffer.alloc(0));
          return true;
        }
      }
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(501, 'WEBSOCKET_UNSUPPORTED'), requestId, WEBSOCKET_UNSUPPORTED_MESSAGE);
      return true;
    }
    // G-B4: a plain (non-upgrade) GET on the WS path answers 426.
    if (options.responsesWs !== undefined && path === '/v1/responses' && (req.method ?? '').toUpperCase() === 'GET') {
      drainRequest(req);
      res.writeHead(426, { 'Content-Type': 'application/json', Upgrade: 'websocket' });
      res.end(
        JSON.stringify({ error: { code: 'UPGRADE_REQUIRED', message: 'this endpoint requires a WebSocket upgrade' } }),
      );
      return true;
    }

    // §4.0 ③ (task #14): GET query endpoints — the /v1/models-style
    // lightweight bypass (authenticate, parse parameters, delegate); they
    // never enter preparation/admission because they read task state
    // instead of creating billable work. Method scoping: a non-GET request
    // whose path matches a query-route pattern keeps the #14 contract 405
    // — EXCEPT when the path is also a registered POST route (§4.3's
    // POST /v1/videos/generations|edits|extensions are three-segment paths
    // that collide with the videos.task_status :taskId pattern and must
    // fall through to the create-route table).
    const queryRouteMatch = matchQueryRoute(path);
    const isGetMethod = (req.method ?? '').toUpperCase() === 'GET';
    if (queryRouteMatch !== null && (isGetMethod || !ROUTES.has(path))) {
      const queryRoute = queryRouteMatch;
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
          // §4.3 (task #17): the content proxy's Range passthrough — the
          // one bounded header a task-content read needs.
          ...(queryRoute.routeId === 'videos.task_content' ? { clientRangeHeader: boundedRangeHeader(req) } : {}),
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

    /*
     * G-B3 (gap-remediation §4): POST /v1/rerank is REGISTERED in the
     * endpoint registry (openai.rerank) but no catalog supply declares the
     * rerank operation yet — the 能力不可售 principle keeps the boundary
     * closed with the precise capability 503 (method-aware via the
     * registry: a wrong method answers 405) until a rerank-capable supply
     * is assembled. Registered ≠ sellable.
     */
    if (path === '/v1/rerank') {
      drainRequest(req);
      const rerankMatch = matchSaasEndpointEntry(req.method ?? '', path);
      if (!rerankMatch.matched || !rerankMatch.methodAllowed) {
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      sendHttpError(
        res,
        new GatewayHttpError(503, 'CAPABILITY_NOT_ASSEMBLED'),
        requestId,
        'This rerank endpoint is registered but no assembled supply declares rerank capability yet',
      );
      return true;
    }

    /*
     * §4.0 ② → G-B2: the multipart media endpoints. With a staging root
     * configured, a multipart/form-data request on one of these paths is
     * parsed by the streamed envelope (eight-resource bounds, SHA-256 per
     * file, private random-named staging) and NORMALIZED at this boundary
     * into the JSON body shape the existing audio/images pipeline already
     * serves: every file part inlines as a b64_json field, non-file fields
     * pass through verbatim, and the request continues as JSON. The staged
     * bytes are removed immediately after normalization — no file survives
     * the boundary (§11.2: input shapes live only here and the transport).
     * A JSON request keeps its fast path unchanged; without a staging root
     * the reserved 501 stands.
     */

    /*
     * §4.3 (task #17): the video create family requires the create-time
     * persistence port (the migration-124 snapshot). A deployment without
     * video media keeps the create endpoints closed with 503 — the GET
     * status/content query routes remain independently gated by
     * `queryEndpoints`.
     */
    if (VIDEO_CREATE_PATHS.has(path) && !options.videoCreate) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
      return true;
    }

    /*
     * G-B2: multipart normalization — see the block header below.
     */
    // G-B2: the still-unwired multipart-only surfaces keep the precise
    // JSON-only 501 reservation (4.0 ②).
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

    if (MULTIPART_NORMALIZING_ENDPOINT_PATHS.has(path)) {
      const contentTypeHeader = String(oneHeader(req, 'content-type') ?? '');
      const isMultipart = /^multipart\/form-data/i.test(contentTypeHeader);
      const isJson = contentTypeHeader === '' || /^application\/json/i.test(contentTypeHeader);
      // A JSON body (the base64-encoded shape) takes the normal flow below;
      // only a multipart body needs the staging root.
      if (isMultipart && options.multipartStagingRoot === undefined) {
        drainRequest(req);
        sendHttpError(
          res,
          new GatewayHttpError(501, 'MULTIPART_NOT_SUPPORTED'),
          requestId,
          MULTIPART_STAGING_UNAVAILABLE_MESSAGE,
        );
        return true;
      }
      if (!isMultipart && !isJson) {
        drainRequest(req);
        sendHttpError(
          res,
          new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'),
          requestId,
          MULTIPART_UNSUPPORTED_MESSAGE,
        );
        return true;
      }
      if (isMultipart) {
        const stagingDirectory = join(options.multipartStagingRoot ?? '.', `req-${requestId}`);
        await mkdir(stagingDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);
        let envelope: GatewayMultipartEnvelope;
        try {
          envelope = await parseMultipartBody(req, req, { stagingDirectory });
        } catch (error) {
          drainRequest(req);
          const code = error instanceof GatewayMultipartParseError ? error.code : 'READ_FAILED';
          const oversized = code === 'FILE_TOO_LARGE' || code === 'TOTAL_TOO_LARGE';
          sendHttpError(
            res,
            new GatewayHttpError(oversized ? 413 : 400, oversized ? 'BODY_TOO_LARGE' : 'INVALID_BODY'),
            requestId,
            error instanceof Error ? error.message : 'the multipart body was rejected',
          );
          return true;
        }
        try {
          const normalized: Record<string, unknown> = {};
          for (const field of envelope.fields) {
            normalized[field.name] = field.value;
          }
          for (const [index, file] of envelope.files.entries()) {
            const bytes = await readFile(file.path);
            normalized[envelope.files.length === 1 ? 'b64_json' : `b64_json_${index + 1}`] = bytes.toString('base64');
            if (normalized.file === undefined) {
              normalized.file = file.filename;
            }
            if (normalized.file_content_type === undefined) {
              normalized.file_content_type = file.contentType;
            }
          }
          multipartNormalizedBody = {
            body: JSON.stringify(normalized),
            contentType: 'application/json',
            contentLength: Buffer.byteLength(JSON.stringify(normalized)),
          };
        } finally {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
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

    /*
     * R2 §7.2: native Gemini inbound content paths
     * (`/v1beta/models/{model}:generateContent|:streamGenerateContent`)
     * resolve to the gemini client protocol here; every other path keeps
     * the registered route-table lookup. A matched Gemini path with a
     * non-POST method answers 405 exactly like a registered /v1 route;
     * unmatched /v1beta paths keep the generic 404.
     */
    const geminiNative = matchGeminiNativeContentPath(path);
    const protocol: GatewayProtocol | undefined = geminiNative !== null ? 'gemini' : ROUTES.get(path);
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

    // G-B2: a multipart body on a normalizing endpoint already normalized
    // above (multipartNormalizedBody set); the JSON gate must not reject it.
    const contentTypeForJsonGate = String(oneHeader(req, 'content-type') ?? '');
    const multipartNormalizingPass =
      MULTIPART_NORMALIZING_ENDPOINT_PATHS.has(path) && /^multipart\/form-data/i.test(contentTypeForJsonGate);
    if (!supportedContentType(req) && !multipartNormalizingPass && multipartNormalizedBody === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'), requestId);
      return true;
    }

    let authenticatedCaller: AuthenticatedApiKey | null;
    try {
      authenticatedCaller = nativeCompactRequest?.authenticatedCaller ?? (await authenticateCaller(req, authenticator));
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
      if (nativeCompactRequest !== undefined) {
        body = nativeCompactRequest.body;
      } else if (multipartNormalizedBody !== undefined) {
        if (multipartNormalizedBody.contentLength > pathBodyLimit) {
          throw new GatewayHttpError(413, 'BODY_TOO_LARGE');
        }
        const parsed: unknown = JSON.parse(multipartNormalizedBody.body);
        if (!isRecord(parsed)) throw new GatewayHttpError(400, 'INVALID_BODY');
        body = parsed;
      } else {
        body = await readJsonBody(req, pathBodyLimit);
      }
      if (clientAuthorityField(body)) throw new GatewayHttpError(400, 'INVALID_BODY');
    } catch (error) {
      const httpError = error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY');
      sendHttpError(res, httpError, requestId);
      return true;
    }

    const historyOperation = path === '/v1/responses' || path === '/v1/responses/compact';
    const historyResolver = historyOperation ? options.continuationHistoryResolver : undefined;
    let historyConversation: string | undefined;
    let resolvedHistory: ResolvedResponsesHistory | undefined;
    if (historyOperation) {
      try {
        historyConversation = normalizeResponsesHistoryConversationId(req.headers.conversation_id, body.conversation_id);
        if (body.previous_response_id !== undefined) {
          if (!historyResolver || !historyConversation || typeof body.previous_response_id !== 'string' || body.previous_response_id.length < 1 || body.previous_response_id.length > 512) throw new Error('context unavailable');
          resolvedHistory = await historyResolver.resolve({tenantId:authenticatedCaller.metadata.tenantId,projectId:authenticatedCaller.metadata.projectId,proxyKeyId:authenticatedCaller.metadata.id,conversationId:historyConversation,responseId:body.previous_response_id},body);
          // This exact server-marked object must reach prepare; do not clone it.
          body = resolvedHistory.body;
        }
      } catch {
        writeJsonError(res,409,'full_context_required',requestId,'the response context is unavailable; resend full context');
        return true;
      }
    }

    let model: string;
    try {
      // R2 §7.2: native Gemini requests carry the public model in the path
      // (`/v1beta/models/{model}:generateContent`), never in the body.
      model = geminiNative !== null ? geminiNative.model : publicModel(body);
    } catch (error) {
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY'),
        requestId,
      );
      return true;
    }

    /*
     * R2 §7.2: native Gemini carries the public model in the path and the
     * SSE action in the path suffix — the body has neither. The trusted
     * boundary injects both as server-owned facts before fingerprinting
     * (the same discipline as the path-derived client operations): the
     * payload compiler's canonical body and the billing input then carry
     * exactly one consistent model. The path is authoritative; a body
     * `model`, if a client sends one, is never trusted.
     */
    if (geminiNative !== null) {
      body = {
        ...body,
        model: geminiNative.model,
        ...(geminiNative.stream ? { stream: true } : {}),
      };
    }

    /*
     * Roadmap batch 5 §5.4 (task #19): the content risk-control seam. Runs
     * exactly once per request, after authentication and body/model
     * extraction, strictly before preparation — the moderation decision
     * never enters the preparation transaction. The port owns the
     * fail-open contract; this boundary additionally defends against a
     * throwing port so moderation can never take a request down. Absent
     * port (deployments without risk control) keeps the path unchanged.
     */
    if (contentModeration) {
      let moderation: ContentModerationCheckResponse;
      try {
        moderation = await contentModeration.check({
          requestId,
          tenantId: authenticatedCaller.metadata.tenantId,
          userId: authenticatedCaller.metadata.principalUserId,
          apiKeyId: authenticatedCaller.metadata.id,
          apiKeyName: authenticatedCaller.metadata.name,
          protocol,
          model,
          body,
        });
      } catch {
        moderation = { allowed: true, statusCode: 0, message: '' };
      }
      if (!moderation.allowed) {
        drainRequest(req);
        writeJsonError(
          res,
          moderation.statusCode >= 400 && moderation.statusCode <= 599 ? moderation.statusCode : 403,
          'CONTENT_POLICY_VIOLATION',
          requestId,
          moderation.message !== '' ? moderation.message : 'The request was blocked by content policy',
        );
        return true;
      }
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
    /*
     * R2 §7.2: native Gemini inbound stays outside the sticky seam for now —
     * the reference derivation knows the anthropic/openai/responses header
     * and body shapes only, and a Gemini client must never inherit a
     * misparsed session reference. (Follow-up: a gemini tier once the
     * reference grammar covers Gemini bodies.)
     */
    const scheduling =
      options.stickyScheduling && protocol !== 'gemini'
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
    if (options.fastGateway) {
      const fastClient = new NodePreparedEvidenceClientStream(req, res, requestId);
      try {
        const handled = await options.fastGateway.execute({
          requestId,
          authenticatedCaller,
          path,
          publicModel: model,
          protocol,
          body,
          clientAddress,
          idempotencyKey: requestIdempotencyKey,
          client: fastClient,
          selected: (mode, reason) => {
            if (!res.headersSent) {
              res.setHeader('x-model-router-execution-mode', mode === 'fast' ? 'fast-reserved-max' : 'strict');
              if (mode === 'strict') res.setHeader('x-model-router-fast-fallback', reason);
            }
          },
        });
        if (handled) return true;
      } catch (error) {
        reportFastGatewayFailure(options.fastGatewayDiagnostic, error, requestId, res.headersSent);
        if (res.headersSent) await fastClient.abort();
        else
          sendHttpError(
            res,
            new GatewayHttpError(
              error instanceof FastGatewayExecutionError ? error.status : 503,
              error instanceof FastGatewayExecutionError ? error.code : 'FAST_GATEWAY_UNAVAILABLE',
            ),
            requestId,
          );
        return true;
      } finally {
        fastClient.dispose();
      }
    }
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

    const preparedRequest = prepared;
    const historyIdentity = historyConversation ? responsesHistoryPreparedIdentity(preparedRequest,historyConversation,authenticatedCaller) : null;
    if (resolvedHistory) {
      try {
        if (!historyIdentity) throw new Error('context identity unavailable');
        historyResolver?.assertPreparedIdentity(resolvedHistory,historyIdentity);
      } catch {
        // Preparation may own a hold already. Release through its authority before reporting the mismatch.
        await options.preDispatchCompensation?.compensate({prepared:preparedRequest,cause:'dispatch_failed',responseMayHaveStarted:false}).catch(()=>undefined);
        writeJsonError(res,409,'full_context_required',requestId,'the response context is unavailable; resend full context');
        return true;
      }
    }

    /*
     * §4.2 (task #16) async image submission: once the request is prepared,
     * create the task, answer 202 + Location + Retry-After: 3 (the sub2api
     * "替换响应" contract), then run the dispatch in the background against
     * a RecordingClientStream and settle the task through the media port.
     * A background promise rejection settles the task failed; a stranded
     * attempt (e.g. a process crash between dispatch classification and
     * task settlement) is the unknown-outcome recovery worker's
     * reconciliation domain (the dispatching→unknown→failed guarded path).
     */
    if (path === ASYNC_IMAGE_SUBMIT_PATH) {
      const asyncMedia = options.asyncMedia;
      if (!asyncMedia) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }
      const compensate = async (cause: 'client_cancelled' | 'dispatch_failed') => {
        try {
          await options.preDispatchCompensation?.compensate({
            prepared: preparedRequest,
            cause,
            responseMayHaveStarted: res.headersSent,
          });
        } catch {
          // The transaction owner retains unresolved reservations.
        }
      };
      let submission: SaasGatewayAsyncMediaSubmission;
      try {
        submission = await asyncMedia.createTask({ authenticatedCaller });
      } catch {
        await compensate('dispatch_failed');
        sendHttpError(res, new GatewayHttpError(503, 'IMAGE_TASK_UNAVAILABLE'), requestId);
        return true;
      }
      // 202 goes out before dispatch starts; a client disconnect after this
      // point can never cancel the background execution (sub2api parity).
      sendAsyncAccepted(res, requestId, submission);
      const recording = new RecordingClientStream({ maxRecordedBytes: bodyLimits.images });
      const executionTimeoutMs = validAsyncExecutionTimeout(options.asyncExecutionTimeoutMs);
      const dispatchAuditAsync: PreparedRequestEvidenceAudit = {
        ...auditContext,
        actorUserId: authenticatedCaller.authorization.principalId,
        requestId,
      };
      const dispatchRouteAsync =
        isRecord(preparedRequest.evidenceInput) && typeof preparedRequest.evidenceInput.routeConfigId === 'string'
          ? preparedRequest.evidenceInput.routeConfigId
          : 'unknown';
      const executionTimer = setTimeout(() => recording.abort(), executionTimeoutMs);
      const dispatchStartedAtMs = Date.now();
      void (async () => {
        let dispatched: PreparedEvidenceDispatchResult;
        try {
          dispatched = await dispatch.dispatch({
            evidenceId: preparedRequest.evidence.evidenceId,
            preparedEvidence: preparedRequest.evidence,
            payloadBytes: preparedRequest.payloadBytes,
            normalSuccessSnapshot: preparedRequest.normalSuccessSnapshot,
            audit: dispatchAuditAsync,
            client: recording,
          });
        } catch {
          // The dispatch service durably classifies the attempt before
          // throwing; the task settles failed and compensation fires.
          recordGatewayAttemptOutcome({
            route: dispatchRouteAsync,
            ok: false,
            durationMs: Date.now() - dispatchStartedAtMs,
          });
          await compensate(recording.signal.aborted ? 'client_cancelled' : 'dispatch_failed');
          await asyncMedia.failTask({
            taskId: submission.taskId,
            httpStatus: recording.signal.aborted ? 504 : 502,
            error: recording.signal.aborted
              ? { type: 'timeout_error', message: 'image generation task timed out' }
              : { type: 'api_error', message: 'image generation failed' },
          });
          return;
        }
        recordGatewayAttemptOutcome({
          route: dispatchRouteAsync,
          ok:
            dispatched.kind === 'sent' &&
            typeof dispatched.transport?.resultHttpStatus === 'number' &&
            dispatched.transport.resultHttpStatus >= 200 &&
            dispatched.transport.resultHttpStatus < 300,
          durationMs: Date.now() - dispatchStartedAtMs,
        });
        if (dispatched.kind !== 'sent' || !recording.isComplete) {
          await asyncMedia.failTask({
            taskId: submission.taskId,
            httpStatus: 502,
            error: { type: 'api_error', message: 'the upstream image request outcome is unknown' },
          });
          return;
        }
        await asyncMedia.completeTask({
          taskId: submission.taskId,
          resultHttpStatus: dispatched.transport.resultHttpStatus ?? null,
          recordedBody: recording.recordedBody(),
        });
      })()
        .catch(() => {
          // Settlement failures are last-ditch: fail the task idempotently.
          return asyncMedia
            .failTask({
              taskId: submission.taskId,
              httpStatus: 502,
              error: { type: 'api_error', message: 'image generation failed' },
            })
            .catch(() => undefined);
        })
        .finally(() => {
          clearTimeout(executionTimer);
        });
      return true;
    }

    /*
     * §4.2 keepalive decision: the generic prepared-evidence transport has
     * no client keepalive mechanism (headers commit only when the first
     * upstream body chunk arrives). For the synchronous images endpoint the
     * handler installs a whitespace-heartbeat stream when configured —
     * sub2api StartOpenAIImagesJSONKeepalive semantics: the first heartbeat
     * commits status 200, and a late upstream error passes through as an
     * OpenAI-compatible JSON error body. This architecture has no
     * post-response-start failover (dispatch is a single attempt per
     * prepared request), so the sub2api "written bytes forbid failover"
     * constraint is structurally satisfied.
     */
    const keepaliveIntervalMs = validKeepaliveInterval(options.imageKeepaliveIntervalMs);
    const videoCreatePort = VIDEO_CREATE_PATHS.has(path) ? options.videoCreate : undefined;
    const innerClient =
      path === '/v1/images/generations' && keepaliveIntervalMs > 0
        ? new JsonKeepaliveClientStream(req, res, requestId, { intervalMs: keepaliveIntervalMs })
        : new NodePreparedEvidenceClientStream(req, res, requestId);
    /*
     * §4.3 (task #17): a delivered video create response is teed into a
     * bounded recording so the upstream request id can be extracted after
     * dispatch; the client sees the upstream JSON verbatim either way.
     */
    const historyCapture = historyResolver && historyIdentity ? new ResponsesHistoryHttpCapture(innerClient) : undefined;
    const client =
      videoCreatePort !== undefined
        ? new TeeRecordingClientStream(innerClient, { maxRecordedBytes: bodyLimits.videos })
        : historyCapture ?? innerClient;
    const compensate = async (cause: 'client_cancelled' | 'dispatch_failed') => {
      try {
        return await options.preDispatchCompensation?.compensate({
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
        preparedEvidence: prepared.evidence,
        payloadBytes: prepared.payloadBytes,
        normalSuccessSnapshot: prepared.normalSuccessSnapshot,
        audit: dispatchAudit,
        client,
      });
      const attemptStatus =
        dispatched.kind === 'sent'
          ? ((dispatched.transport?.resultHttpStatus as number | null | undefined) ?? null)
          : null;
      recordGatewayAttemptOutcome({
        route: dispatchRoute,
        ok: dispatched.kind === 'sent' && attemptStatus !== null && attemptStatus >= 200 && attemptStatus < 300,
        durationMs: Date.now() - dispatchStartedAtMs,
      });
    } catch (error) {
      recordGatewayAttemptOutcome({
        route: dispatchRoute,
        ok: false,
        durationMs: Date.now() - dispatchStartedAtMs,
      });
      const clientWasAborted = client.signal.aborted;
      const responseWasStarted = res.headersSent;
      const cause = clientWasAborted ? 'client_cancelled' : 'dispatch_failed';
      client.abort();
      const compensation = await compensate(cause);
      // A known full PostgreSQL account is a concurrency rejection only after
      // the already committed preparation resources are authoritatively released.
      const capacityReleased =
        error instanceof SaasPreparedEvidenceDispatchError &&
        error.code === 'LEASE_CAPACITY_EXHAUSTED' &&
        !clientWasAborted &&
        !responseWasStarted &&
        !req.aborted &&
        (req.complete || !req.destroyed) &&
        !res.headersSent &&
        !res.destroyed &&
        !res.writableEnded &&
        compensation?.requestId === preparedRequest.requestId &&
        compensation.attemptId === preparedRequest.attemptId &&
        compensation.disposition === 'released' &&
        compensation.quotaReservation === 'released' &&
        compensation.rateReservation === 'released' &&
        compensation.manualReconciliationRequired === false &&
        ((preparedRequest.caller.supplyMode === 'byok' && compensation.holdReservation === 'not_applicable') ||
          (preparedRequest.caller.supplyMode === 'platform' && compensation.holdReservation === 'released'));
      sendHttpError(
        res,
        capacityReleased ? new GatewayHttpError(429, 'RATE_LIMITED') : new GatewayHttpError(502, 'DISPATCH_FAILED'),
        requestId,
      );
      client.dispose();
      historyCapture?.clear();
      return true;
    }
    if (!historyCapture) client.dispose();

    if (!isRecord(dispatched) || (dispatched.kind !== 'sent' && dispatched.kind !== 'unknown')) {
      await compensate('dispatch_failed');
      await historyCapture?.abort(); historyCapture?.dispose();
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_FAILED'), requestId);
      return true;
    }
    if (historyCapture && historyResolver && historyIdentity) {
      // 'sent' can still require financial reconciliation. Only an authoritative settled disposition permits persistence.
      if (dispatched.kind === 'sent' && dispatched.settlementOutcome === 'settled') {
        const response = historyCapture.response(path === '/v1/responses/compact');
        if (response) {
          await historyResolver.remember({identity:historyIdentity,responseId:response.id,request:body,output:response.output,operation:path === '/v1/responses/compact' ? 'responses.compact' : 'responses'}).catch(()=>false);
        }
      }
      try { await historyCapture.finish(); } catch {
        // Delivery failed after committed settlement: release the client without compensating or retrying inference.
        await historyCapture.abort().catch(()=>undefined);
        if (!res.writableEnded && !res.destroyed) { try { res.destroy(); } catch { /* socket already unavailable */ } }
      } finally { historyCapture.dispose(); }
    }
    if (dispatched.kind === 'unknown' && !res.headersSent && !res.destroyed) {
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_OUTCOME_UNKNOWN'), requestId);
    }
    /*
     * §4.3 (task #17): register the create-time snapshot for a delivered
     * 2xx video create. The response is already with the client, so
     * persistence is strictly background best-effort — a failure leaves
     * the task unregistered and the later billing path fails closed (the
     * 404 poll surface and the skip-with-alert state machine).
     */
    if (videoCreatePort !== undefined && dispatched.kind === 'sent' && client instanceof TeeRecordingClientStream) {
      const recording = client;
      const dispatchedStatus = dispatched.transport?.resultHttpStatus;
      const evidence = preparedRequest.evidence;
      const snapshot = preparedRequest.normalSuccessSnapshot;
      void (async () => {
        if (!recording.isComplete) return;
        if (typeof dispatchedStatus !== 'number' || dispatchedStatus < 200 || dispatchedStatus >= 300) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recording.recordedBody()));
        } catch {
          return;
        }
        const taskId = extractVideoRequestIdFromBody(parsed);
        if (taskId === '') return;
        const facts =
          snapshot.supplyMode === 'platform' &&
          typeof snapshot.customerPriceVersion === 'string' &&
          snapshot.customerPriceVersion !== '' &&
          typeof snapshot.priceSnapshotRef === 'string' &&
          snapshot.priceSnapshotRef !== '' &&
          typeof snapshot.currency === 'string'
            ? {
                customerPriceVersion: snapshot.customerPriceVersion,
                priceSnapshotRef: snapshot.priceSnapshotRef,
                currency: snapshot.currency,
              }
            : null;
        await videoCreatePort.registerCreate({
          authenticatedCaller,
          taskId,
          account: {
            accountId: evidence.accountId,
            credentialId: evidence.credentialId,
            credentialVersion: evidence.credentialVersion,
          },
          settlement: { requestId: preparedRequest.requestId, attemptId: preparedRequest.attemptId },
          requestBody: body,
          settlementFacts: facts,
        });
      })().catch(() => undefined);
    }
    return true;
  };
}

export type {
  SaasGatewayAsyncMediaPort,
  SaasGatewayAsyncMediaSubmission,
} from './images/async-media-port.js';
export { createSaasGatewayHandler as createSaasHostedGatewayHandler };
