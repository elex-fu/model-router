import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import {
  classifyUpstreamError,
  shouldFailover,
  type UpstreamErrorClassification,
} from '../oauth-subscription/health-classifier.js';
import {
  boundedErrorBody,
  cancelResponseBody,
  createDrainingRelay,
  flattenHeaders,
  QuotaSnapshotWriteThrottle,
} from '../oauth-subscription/transport-skeleton.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../prepared-request-evidence-service.js';
import {
  applyGrokCliProxyHeaders,
  GROK_API_KEY_DEFAULT_BASE_URL,
  GROK_OAUTH_DEFAULT_BASE_URL,
  isGrokOfficialHost,
} from './constants.js';
import type { GrokUpstreamCredential } from './identity.js';
import {
  type GrokQuotaHeaderSnapshot,
  grokSchedulingSnapshotFromHeaders,
  parseGrokQuotaHeaders,
} from './quota-headers.js';
import { type GrokResponseUsage, GrokUsageWatcher } from './response-bridge.js';

/**
 * Batch-3 Grok HTTP transport (the codex/gemini PreparedEvidenceTransport
 * pattern applied to the xAI surface; sub2api grok_upstream_headers.go +
 * grok_upstream_url.go port). Assembles the outbound request for the grok
 * catalog endpoint:
 *
 * - base URL per credential kind: OAuth Grok CLI subscriptions dial the CLI
 *   chat proxy (cli-chat-proxy.grok.com/v1), API-key accounts dial the
 *   official api.x.ai/v1;
 * - SSRF hard gate: an OAuth token is ONLY ever sent to an official xAI host
 *   (api.x.ai / *.api.x.ai / cli-chat-proxy.grok.com). A custom base host is
 *   permitted for api-key credentials and only through the operator-supplied
 *   host allowlist — never for OAuth material;
 * - CLI identity masquerade: requests whose target host is the CLI chat proxy
 *   carry the pinned Grok CLI identity (`X-XAI-Token-Auth: xai-grok-cli`,
 *   `x-grok-client-version`, `x-grok-client-identifier: grok-shell`,
 *   `User-Agent: xai-grok-workspace/<version>`); official api.x.ai traffic is
 *   left unchanged (it rejects CLI headers on OAuth traffic);
 * - `x-grok-conv-id` carries the client conversation reference (the sticky
 *   session's conversation tier) so upstream routing keeps one conversation
 *   on one CLI proxy shard;
 * - `x-ratelimit-*` quota header parsing on every response (including 429)
 *   with an at-least-30s throttled, best-effort snapshot write;
 * - upstream error classification (shared health classifier) split into the
 *   account health signal and the in-flight failover signal;
 * - SSE relay that keeps draining the upstream after the client disconnects
 *   so the usage in the terminal event is still collected.
 */

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;
const PREPARED_PAYLOAD_SHA256 = /^[0-9a-f]{64}$/;

/** The upstream path a request is dispatched onto (both native OpenAI wire shapes). */
export type GrokUpstreamPath = 'responses' | 'chat/completions';

export type GrokTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'HOST_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class GrokHttpTransportError extends Error {
  constructor(
    readonly code: GrokTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GrokHttpTransportError';
  }
}

function fail(code: GrokTransportErrorCode, message: string): never {
  throw new GrokHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves and validates the outbound URL (the SSRF hard gate, pure).
 * `credentialKind: 'oauth'` pins the host to the official xAI family; an
 * api-key credential may dial an operator-allowlisted custom host. Returns
 * the URL or a HOST_NOT_ALLOWED failure.
 */
export function resolveGrokUpstreamUrl(input: {
  readonly credentialKind: 'oauth' | 'api-key';
  readonly baseUrl?: string;
  readonly upstreamPath: GrokUpstreamPath;
  readonly operatorHostAllowlist?: readonly string[];
}): URL {
  const base =
    input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl.trim() !== ''
      ? input.baseUrl.trim()
      : input.credentialKind === 'oauth'
        ? GROK_OAUTH_DEFAULT_BASE_URL
        : GROK_API_KEY_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    fail('HOST_NOT_ALLOWED', 'the grok base URL is invalid');
  }
  if (url.protocol !== 'https:') fail('HOST_NOT_ALLOWED', 'the grok base URL must be https');
  if (url.username !== '' || url.password !== '') fail('HOST_NOT_ALLOWED', 'the grok base URL must not carry userinfo');
  if (url.search !== '' || url.hash !== '')
    fail('HOST_NOT_ALLOWED', 'the grok base URL must not carry a query or fragment');
  const host = url.hostname.toLowerCase();
  const official = isGrokOfficialHost(host);
  if (input.credentialKind === 'oauth') {
    // SSRF hard gate: OAuth token material only ever reaches an official xAI
    // host. No operator override exists for this branch by design.
    if (!official) fail('HOST_NOT_ALLOWED', 'grok OAuth traffic may only target official xAI hosts');
  } else if (!official) {
    const allowlist = (input.operatorHostAllowlist ?? []).map((entry) => entry.trim().toLowerCase());
    if (!allowlist.includes(host)) {
      fail('HOST_NOT_ALLOWED', 'the grok custom base host is not on the operator allowlist');
    }
  }
  const path = url.pathname.replace(/\/+$/, '');
  return new URL(`${url.origin}${path}/${input.upstreamPath}`);
}

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type GrokCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: GrokUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort quota snapshot write (persistence is the sink's job). */
export type GrokQuotaSnapshotSink = (record: {
  readonly accountId: string;
  readonly snapshot: GrokQuotaHeaderSnapshot;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type GrokAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: UpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

export interface GrokTransportRequest {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The model id (already normalized by transform.ts). */
  readonly model: string;
  /** The outbound OpenAI-shaped JSON body (responses or chat shape). */
  readonly body: unknown;
  /** Whether the client asked for a stream. */
  readonly stream: boolean;
  /** The upstream path this request rides (default: responses). */
  readonly upstreamPath: GrokUpstreamPath;
  /**
   * The client conversation reference (the sticky session conversation tier);
   * stamped as `x-grok-conv-id` so upstream shard routing stays sticky.
   */
  readonly conversationId: string | null;
  readonly signal: AbortSignal;
}

export interface GrokTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal SSE event. */
  readonly usage: Promise<GrokResponseUsage | null>;
  readonly rateLimitWritten: boolean;
}

export interface GrokTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: UpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly rateLimitWritten: boolean;
}

export type GrokTransportResult = GrokTransportStreamResult | GrokTransportErrorResult;

export interface GrokHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Credential-kind-scoped base override (tests / custom api-key upstreams). */
  readonly baseUrl?: string;
  /**
   * Operator allowlist of custom base hosts for api-key credentials. OAuth
   * credentials ignore it entirely (official hosts only).
   */
  readonly operatorHostAllowlist?: readonly string[];
  readonly resolveCredential: GrokCredentialResolver;
  readonly writeQuotaSnapshot?: GrokQuotaSnapshotSink;
  readonly recordAccountHealth?: GrokAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly baseUrl: string | undefined;
  readonly operatorHostAllowlist: readonly string[];
  readonly resolveCredential: GrokCredentialResolver;
  readonly writeQuotaSnapshot: GrokQuotaSnapshotSink | null;
  readonly recordAccountHealth: GrokAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot grok transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class GrokHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly rateLimitThrottle: QuotaSnapshotWriteThrottle;

  constructor(options: GrokHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a grok credential resolver is required');
    }
    this.options = {
      fetch: options.fetch,
      baseUrl: options.baseUrl,
      operatorHostAllowlist: options.operatorHostAllowlist ?? [],
      resolveCredential: options.resolveCredential,
      writeQuotaSnapshot: options.writeQuotaSnapshot ?? null,
      recordAccountHealth: options.recordAccountHealth ?? null,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotMinIntervalMs: options.snapshotMinIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
    this.rateLimitThrottle = new QuotaSnapshotWriteThrottle(this.options.snapshotMinIntervalMs, this.options.nowMs);
  }

  async send(request: GrokTransportRequest): Promise<GrokTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a grok transport request is required');
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the grok outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion', 'model'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `grok transport request field ${field} is required`);
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const abortFromRequest = () => controller.abort();
    request.signal.addEventListener('abort', abortFromRequest, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abortFromRequest);
    };
    try {
      return await this.options.resolveCredential(
        {
          accountId: request.accountId,
          credentialId: request.credentialId,
          credentialVersion: request.credentialVersion,
          signal: controller.signal,
        },
        (credential) => this.sendWithCredential(request, credential, controller, () => timedOut),
      );
    } catch (error) {
      if (error instanceof GrokHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'grok transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'grok transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'grok credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: GrokTransportRequest,
    credential: GrokUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<GrokTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'grok credential is invalid');
    const token = credential.kind === 'oauth' ? credential.accessToken : credential.apiKey;
    if (typeof token !== 'string' || token.length === 0) {
      fail('CREDENTIAL_INVALID', 'grok credential carries no token');
    }

    // The SSRF hard gate runs inside the credential callback so the token
    // never exists outside a URL decision that has already passed it.
    const url = resolveGrokUpstreamUrl({
      credentialKind: credential.kind,
      ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
      upstreamPath: request.upstreamPath,
      ...(this.options.operatorHostAllowlist.length === 0
        ? {}
        : { operatorHostAllowlist: this.options.operatorHostAllowlist }),
    });
    // CLI identity masquerade: stamped only when the target is the CLI proxy.
    const headers = applyGrokCliProxyHeaders(
      {
        host: url.host,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: request.stream ? 'text/event-stream' : 'application/json',
      },
      url.hostname,
    );
    if (request.conversationId !== null && request.conversationId.trim() !== '') {
      headers['x-grok-conv-id'] = request.conversationId.trim();
    }
    const bodyBytes = Buffer.from(JSON.stringify(request.body), 'utf8');
    let response: Response;
    try {
      response = await this.options.fetch(url.toString(), {
        method: 'POST',
        headers,
        body: bodyBytes,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (timedOut()) fail('TIMEOUT', 'grok transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'grok transport was aborted');
      fail('NETWORK_ERROR', 'grok upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'grok upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'grok upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'grok upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);
    // Quota headers are observed on EVERY response (including 200s) so the
    // migration-119 scheduling columns track healthy accounts too.
    const rateLimitWritten = await this.maybeWriteQuotaSnapshot(request.accountId, responseHeaders, response.status);

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await boundedErrorBody(response, controller.signal, MAX_ERROR_BODY_BYTES);
      const classification = classifyUpstreamError({
        status: response.status,
        bodyText: bodyText ?? '',
        headers: responseHeaders,
      });
      const failover = shouldFailover(classification);
      await this.recordHealth(request.accountId, classification, failover);
      return { ok: false, status: response.status, classification, failover, bodyText, rateLimitWritten };
    }
    const body = response.body ?? null;
    if (body === null) {
      return {
        ok: true,
        status: response.status,
        headers: responseHeaders,
        body: null,
        usage: Promise.resolve(null),
        rateLimitWritten,
      };
    }
    const relay = createDrainingRelay(body, controller.signal, new GrokUsageWatcher(), {
      maxDrainBufferBytes: MAX_DRAIN_BUFFER_BYTES,
      errorMessage: 'grok drain buffer exceeded',
    });
    return {
      ok: true,
      status: response.status,
      headers: responseHeaders,
      body: relay.stream,
      usage: relay.usage,
      rateLimitWritten,
    };
  }

  private async maybeWriteQuotaSnapshot(
    accountId: string,
    headers: Readonly<Record<string, string>>,
    status: number,
  ): Promise<boolean> {
    if (this.options.writeQuotaSnapshot === null) return false;
    const snapshot = parseGrokQuotaHeaders(headers as Record<string, string>, this.options.nowMs());
    if (snapshot === null) return false;
    if (!this.rateLimitThrottle.shouldWrite(accountId)) return false;
    const observedAtMs = this.options.nowMs();
    // Best-effort by contract: persistence failures never affect the response.
    void Promise.resolve()
      .then(() => this.options.writeQuotaSnapshot?.({ accountId, snapshot, observedAtMs, fromStatus: status }))
      .catch(() => undefined);
    return true;
  }

  private async recordHealth(
    accountId: string,
    classification: UpstreamErrorClassification,
    failover: boolean,
  ): Promise<void> {
    if (this.options.recordAccountHealth === null) return;
    try {
      await this.options.recordAccountHealth({ accountId, classification, failover });
    } catch {
      // Health observation is best-effort; the dispatch result stands.
    }
  }
}

/**
 * Grok usage → the gateway's observed-usage contract (the shared openai
 * normalizer; input totals include the cached split the same way the codex
 * adapter reconstructs them).
 */
export function grokUsageToObservedUsage(usage: GrokResponseUsage): NormalSuccessObservedUsage | null {
  // The openai normalizer expects prompt_tokens to already include cached
  // tokens (OpenAI semantics both wire shapes share); the cached split rides
  // prompt_tokens_details.
  const normalized = normalizeUsage('openai', {
    prompt_tokens: usage.inputTokens ?? undefined,
    completion_tokens: usage.outputTokens ?? undefined,
    ...(usage.cachedTokens === null ? {} : { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }),
  });
  if (normalized.status !== 'reported' || normalized.inputTotal === null || normalized.outputTotal === null) {
    return null;
  }
  return Object.freeze({ ...normalized, source: 'upstream' });
}

/**
 * Per-request dispatch context for the prepared-evidence adapter; the gateway
 * resolves it from the prepared evidence's route facts (resolved model, client
 * protocol, stream ask, sticky conversation reference) and the account's
 * credential shape.
 */
export interface GrokRequestDispatchContext {
  /** The model id (already normalized by transform.ts). */
  readonly model: string;
  /** Whether the client asked for a stream. */
  readonly stream: boolean;
  /** The upstream path this request rides (responses by default). */
  readonly upstreamPath: GrokUpstreamPath;
  /** The credential kind selecting the base URL and SSRF posture. */
  readonly credentialKind: 'oauth' | 'api-key';
  /** The client conversation reference (sticky conversation tier) or null. */
  readonly conversationId: string | null;
}

/**
 * Adapter that plugs `GrokHttpTransport` into the gateway's prepared-evidence
 * dispatch chain (the direct analog of `CodexPreparedEvidenceTransport`).
 * The evidence record carries the account/credential binding and the signed
 * payload digest; the per-request dispatch context comes from the injected
 * resolver. Dispatch routes evidence whose signed endpoint scope is the Grok
 * catalog endpoint (`grok-responses`) here.
 */
export interface GrokPreparedEvidenceTransportOptions extends GrokHttpTransportOptions {
  readonly resolveRequestContext: (
    evidence: PreparedRequestEvidenceRecord,
  ) => Promise<GrokRequestDispatchContext> | GrokRequestDispatchContext;
}

export class GrokPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly transport: GrokHttpTransport;
  private readonly resolveRequestContext: GrokPreparedEvidenceTransportOptions['resolveRequestContext'];

  constructor(options: GrokPreparedEvidenceTransportOptions) {
    if (typeof options.resolveRequestContext !== 'function') {
      fail('INVALID_INPUT', 'a grok request context resolver is required');
    }
    this.transport = new GrokHttpTransport(options);
    this.resolveRequestContext = options.resolveRequestContext;
  }

  async send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    const body = assertPayloadBinding(input);
    const evidence = input.evidence;
    const context = await this.resolveRequestContext(evidence);
    const result = await this.transport.send({
      accountId: evidence.accountId,
      credentialId: evidence.credentialId,
      credentialVersion: evidence.credentialVersion,
      model: context.model,
      body,
      stream: context.stream,
      upstreamPath: context.upstreamPath,
      conversationId: context.conversationId,
      signal: input.signal,
    });
    if (!result.ok) {
      return {
        responseStarted: false,
        resultHttpStatus: result.status,
        upstreamErrorKind: result.classification.kind,
        headers: {},
        body: null,
      };
    }
    // The grok usage arrives with the terminal SSE event; expose it through
    // the same lazy accessor contract as the codex/gemini adapters.
    let observedUsage: GrokResponseUsage | null = null;
    void result.usage
      .then((usage) => {
        observedUsage = usage;
        return usage;
      })
      .catch(() => null);
    return {
      responseStarted: false,
      resultHttpStatus: result.status,
      headers: result.headers,
      body: result.body,
      get providerUsage(): NormalSuccessObservedUsage | null {
        return observedUsage === null ? null : grokUsageToObservedUsage(observedUsage);
      },
    };
  }
}

function assertPayloadBinding(input: PreparedEvidenceTransportRequest): Record<string, unknown> {
  if (!input || typeof input !== 'object' || !input.evidence) fail('INVALID_INPUT', 'transport request is required');
  const evidence = input.evidence;
  if (evidence.status !== 'claimed' || evidence.claimedAttemptId !== input.attemptId) {
    fail('INVALID_INPUT', 'prepared evidence is not bound to this transport request');
  }
  if (typeof evidence.payloadSha256 !== 'string' || !PREPARED_PAYLOAD_SHA256.test(evidence.payloadSha256)) {
    fail('INVALID_INPUT', 'prepared evidence payload digest is invalid');
  }
  if (!(input.payloadBytes instanceof Uint8Array)) fail('INVALID_INPUT', 'payload bytes are invalid');
  const actual = createHash('sha256').update(input.payloadBytes).digest();
  const expected = Buffer.from(evidence.payloadSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail('INVALID_INPUT', 'payload bytes do not match prepared evidence');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.payloadBytes));
  } catch {
    fail('INVALID_INPUT', 'payload bytes are not the grok JSON body');
  }
  if (!isRecord(parsed)) fail('INVALID_INPUT', 'payload bytes are not the grok JSON body');
  return parsed;
}

export { grokSchedulingSnapshotFromHeaders };
