import { createHash, timingSafeEqual } from 'node:crypto';
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
  type SseUsageWatcher,
} from '../oauth-subscription/transport-skeleton.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../prepared-request-evidence-service.js';
import type { VertexUpstreamCredential } from './catalog-identity.js';
import { resolveVertexLocation } from './constants.js';
import { classifyVertex429, type VertexRateLimitClassification } from './quota-headers.js';
import {
  type GeminiUsageMetadata,
  geminiUsageFromMetadata,
  mergeGeminiUsageMetadata,
  parseGeminiUsageMetadata,
  type VertexResponseUsage,
  vertexUsageToObservedUsage,
} from './response-bridge.js';
import {
  applyVertexAnthropicTransform,
  buildVertexAnthropicHeaders,
  buildVertexAnthropicUrl,
  buildVertexGeminiUrl,
  normalizeVertexAnthropicModelId,
} from './transform.js';

/**
 * Batch-3 Vertex AI HTTP transport (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's buildUpstreamRequestAnthropicVertex / buildVertexGeminiURL
 * dispatch). Assembles the outbound request for BOTH Vertex endpoint
 * families on the shared oauth-subscription skeleton:
 *
 * - Anthropic on Vertex (`{location}-aiplatform.googleapis.com/v1/projects/
 *   {project}/locations/{location}/publishers/anthropic/models/{model}:
 *   {rawPredict|streamRawPredict}`): the body drops `model` and gains
 *   `anthropic_version: "vertex-2023-10-16"`, the dated CLI model spelling
 *   rewrites onto the `@` spelling, the client's headers forward only
 *   through the allowlist (minus anthropic-version and every authentication
 *   header), and the client's `anthropic-beta` is filtered onto the Vertex
 *   whitelist (unknown tokens would draw an upstream HTTP 400; an empty
 *   filtered value omits the header);
 * - Gemini on Vertex (`.../publishers/google/models/{model}:{generateContent|
 *   streamGenerateContent?alt=sse}`): the compiled Gemini native body posts
 *   as-is with Bearer authentication;
 * - `Authorization: Bearer <access_token>` is the only upstream
 *   authentication; the token is resolved from the sealed credential
 *   envelope through the injected resolver (the plaintext exists only
 *   inside its callback — the JWT→OAuth exchange itself lives in
 *   platform/vertex-sa/token-service.ts);
 * - the location resolves per request from the credential
 *   (vertex_model_locations[model] → location → us-central1);
 * - 429 classification from the Google JSON error body
 *   (retry-after, then google.rpc.RetryInfo capped at 15 minutes, then the
 *   one-minute pay-as-you-go fallback), written through an at-least-30s
 *   throttled, best-effort sink;
 * - upstream error classification (shared health classifier) split into the
 *   account health signal and the in-flight failover signal;
 * - SSE relay (Gemini protocol) that keeps draining the upstream after the
 *   client disconnects so the terminal usageMetadata chunk is still
 *   collected.
 */

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type VertexCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: VertexUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort 429 classification write (persistence is the sink's job). */
export type VertexRateLimitSink = (record: {
  readonly accountId: string;
  readonly classification: VertexRateLimitClassification;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type VertexAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: UpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

/** The two Vertex endpoint families, selected by the signed provider protocol. */
export type VertexProtocol = 'anthropic' | 'gemini';

export interface VertexTransportRequest {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** Which endpoint family this request targets (from the signed provider protocol). */
  readonly protocol: VertexProtocol;
  /** The resolved provider model id (already normalized by the payload compiler). */
  readonly model: string;
  /** The compiled provider-protocol outbound body. */
  readonly body: unknown;
  /** Whether the client asked for a stream (selects the streaming action). */
  readonly stream: boolean;
  /** The client's raw `anthropic-beta` header (anthropic protocol only). */
  readonly anthropicBetaHeader?: string | null;
  /** Lowercased client request headers (anthropic protocol passthrough). */
  readonly clientHeaders?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface VertexTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal usageMetadata chunk (gemini protocol). */
  readonly usage: Promise<VertexResponseUsage | null>;
  readonly rateLimitWritten: boolean;
}

export interface VertexTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: UpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly rateLimitWritten: boolean;
}

export type VertexTransportResult = VertexTransportStreamResult | VertexTransportErrorResult;

export type VertexTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class VertexHttpTransportError extends Error {
  constructor(
    readonly code: VertexTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VertexHttpTransportError';
  }
}

function fail(code: VertexTransportErrorCode, message: string): never {
  throw new VertexHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builds the pinned production upstream URL for one request. Injectable so
 * tests can point the transport at a local mock upstream (the same
 * local-upstream escape hatch the claude/gemini transports' baseUrl option
 * provides); production always uses the pinned aiplatform builders.
 */
export type VertexUrlBuilder = (input: {
  readonly protocol: VertexProtocol;
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
}) => string;

/** The pinned production URL builder (both endpoint families, both hosts). */
export function defaultVertexUrlBuilder(input: {
  readonly protocol: VertexProtocol;
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
}): string {
  return input.protocol === 'anthropic' ? buildVertexAnthropicUrl(input) : buildVertexGeminiUrl(input);
}

/**
 * Incremental Vertex SSE watcher (gemini protocol): extracts the
 * usageMetadata from every chunk without buffering whole events; the
 * terminal observation is the merged view of every chunk that carries one.
 */
class VertexUsageWatcher implements SseUsageWatcher<VertexResponseUsage> {
  private buffer = '';
  private usage: GeminiUsageMetadata | null = null;

  feed(chunk: Uint8Array): void {
    this.buffer += new TextDecoder('utf-8', { fatal: false }).decode(chunk, { stream: true });
    for (let boundary = findEventBoundary(this.buffer); boundary !== null; boundary = findEventBoundary(this.buffer)) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.acceptBlock(block);
    }
    // Bound the buffer so a malformed stream cannot grow it unbounded.
    if (this.buffer.length > 1_048_576) this.buffer = '';
  }

  private acceptBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const metadata = parseGeminiUsageMetadata(parsed.usageMetadata);
    if (metadata !== null) this.usage = mergeGeminiUsageMetadata(this.usage, metadata);
  }

  /** Non-null only once a usageMetadata chunk has been observed. */
  get observed(): VertexResponseUsage | null {
    return this.usage === null ? null : geminiUsageFromMetadata(this.usage);
  }
}

/** The no-op watcher for the anthropic protocol (usage is the dispatch layer's job). */
class NullUsageWatcher implements SseUsageWatcher<null> {
  feed(): void {}
  get observed(): null {
    return null;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export interface VertexHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable URL builder; production pins the aiplatform hosts. */
  readonly buildUrl?: VertexUrlBuilder;
  readonly resolveCredential: VertexCredentialResolver;
  readonly writeRateLimit?: VertexRateLimitSink;
  readonly recordAccountHealth?: VertexAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly buildUrl: VertexUrlBuilder;
  readonly resolveCredential: VertexCredentialResolver;
  readonly writeRateLimit: VertexRateLimitSink | null;
  readonly recordAccountHealth: VertexAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot vertex transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class VertexHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly rateLimitThrottle: QuotaSnapshotWriteThrottle;

  constructor(options: VertexHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a vertex credential resolver is required');
    }
    const buildUrl = options.buildUrl ?? defaultVertexUrlBuilder;
    if (typeof buildUrl !== 'function') fail('INVALID_INPUT', 'the vertex URL builder is invalid');
    this.options = {
      fetch: options.fetch,
      buildUrl,
      resolveCredential: options.resolveCredential,
      writeRateLimit: options.writeRateLimit ?? null,
      recordAccountHealth: options.recordAccountHealth ?? null,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotMinIntervalMs: options.snapshotMinIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
    this.rateLimitThrottle = new QuotaSnapshotWriteThrottle(this.options.snapshotMinIntervalMs, this.options.nowMs);
  }

  async send(request: VertexTransportRequest): Promise<VertexTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a vertex transport request is required');
    if (request.protocol !== 'anthropic' && request.protocol !== 'gemini') {
      fail('INVALID_INPUT', 'the vertex transport request protocol must be anthropic or gemini');
    }
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the vertex outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion', 'model'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `vertex transport request field ${field} is required`);
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
      if (error instanceof VertexHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'vertex transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'vertex transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'vertex credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: VertexTransportRequest,
    credential: VertexUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<VertexTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'vertex credential is invalid');
    if (typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) {
      fail('CREDENTIAL_INVALID', 'vertex credential carries no access token');
    }
    if (typeof credential.projectId !== 'string' || credential.projectId.trim().length === 0) {
      fail('CREDENTIAL_INVALID', 'vertex credential carries no project id');
    }
    const location = resolveVertexLocation(
      {
        projectId: credential.projectId,
        location: credential.location ?? null,
        vertexModelLocations: credential.vertexModelLocations ?? null,
      },
      request.model,
    );
    if (location === null) fail('CREDENTIAL_INVALID', 'vertex credential carries a malformed location');

    let url: string;
    let headers: Record<string, string>;
    let bodyBytes: Buffer;
    if (request.protocol === 'anthropic') {
      const model = normalizeVertexAnthropicModelId(request.model);
      if (model === '') fail('INVALID_INPUT', 'the vertex model id is required');
      url = this.options.buildUrl({
        protocol: 'anthropic',
        projectId: credential.projectId.trim(),
        location: location.location,
        model,
        stream: request.stream,
      });
      const transformed = applyVertexAnthropicTransform(request.body, {
        anthropicBetaHeader: request.anthropicBetaHeader,
      });
      headers = {
        host: new URL(url).host,
        ...buildVertexAnthropicHeaders({
          clientHeaders: request.clientHeaders ?? {},
          accessToken: credential.accessToken,
          anthropicBeta: transformed.anthropicBeta,
          stream: request.stream,
        }),
      };
      bodyBytes = Buffer.from(JSON.stringify(transformed.body), 'utf8');
    } else {
      url = this.options.buildUrl({
        protocol: 'gemini',
        projectId: credential.projectId.trim(),
        location: location.location,
        model: request.model,
        stream: request.stream,
      });
      headers = {
        host: new URL(url).host,
        authorization: `Bearer ${credential.accessToken}`,
        'content-type': 'application/json',
        accept: request.stream ? 'text/event-stream' : 'application/json',
      };
      bodyBytes = Buffer.from(JSON.stringify(request.body), 'utf8');
    }

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(bodyBytes),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (timedOut()) fail('TIMEOUT', 'vertex transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'vertex transport was aborted');
      fail('NETWORK_ERROR', 'vertex upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'vertex upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'vertex upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'vertex upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await boundedErrorBody(response, controller.signal, MAX_ERROR_BODY_BYTES);
      const rateLimitWritten = await this.maybeWriteRateLimit(
        request.accountId,
        responseHeaders,
        response.status,
        bodyText,
      );
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
        rateLimitWritten: false,
      };
    }
    const watcher = request.protocol === 'gemini' ? new VertexUsageWatcher() : new NullUsageWatcher();
    const relay = createDrainingRelay(body, controller.signal, watcher, {
      maxDrainBufferBytes: MAX_DRAIN_BUFFER_BYTES,
      errorMessage: 'vertex drain buffer exceeded',
    });
    return {
      ok: true,
      status: response.status,
      headers: responseHeaders,
      body: relay.stream,
      usage: relay.usage,
      rateLimitWritten: false,
    };
  }

  private async maybeWriteRateLimit(
    accountId: string,
    headers: Readonly<Record<string, string>>,
    status: number,
    bodyText: string | null,
  ): Promise<boolean> {
    if (this.options.writeRateLimit === null) return false;
    if (status !== 429) return false;
    const classification = classifyVertex429(
      { headers: headers as Record<string, string>, bodyText },
      this.options.nowMs(),
    );
    if (!this.rateLimitThrottle.shouldWrite(accountId)) return false;
    const observedAtMs = this.options.nowMs();
    // Best-effort by contract: persistence failures never affect the response.
    void Promise.resolve()
      .then(() => this.options.writeRateLimit?.({ accountId, classification, observedAtMs, fromStatus: status }))
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

const PREPARED_PAYLOAD_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Per-request dispatch context for the prepared-evidence adapter; the gateway
 * resolves it from the prepared evidence's route facts (signed provider
 * protocol, resolved model, client stream ask) plus the client's forwarded
 * header view. The client header map is the composition's lowercased copy of
 * the original request headers; the transport applies the Vertex allowlist
 * and the beta filter itself so the policy can never drift from the
 * category package.
 */
export interface VertexRequestDispatchContext {
  /** Which endpoint family (from the signed provider protocol on the evidence). */
  readonly protocol: VertexProtocol;
  /** The resolved provider model id. */
  readonly model: string;
  /** Whether the client asked for a stream (selects the streaming action). */
  readonly stream: boolean;
  /** The client's raw `anthropic-beta` header, when the client sent one. */
  readonly anthropicBetaHeader?: string | null;
  /** The client's lowercased request headers (anthropic protocol passthrough). */
  readonly clientHeaders?: Readonly<Record<string, string>>;
}

/**
 * Adapter that plugs `VertexHttpTransport` into the gateway's
 * prepared-evidence dispatch chain (the direct analog of
 * `GeminiPreparedEvidenceTransport`). The evidence record carries the
 * account/credential binding and the signed payload digest; the per-request
 * dispatch context comes from the injected resolver. Dispatch routes
 * evidence whose signed endpoint scope is the Vertex catalog endpoint
 * (`vertex-raw-predict`, either provider protocol) here.
 */
export interface VertexPreparedEvidenceTransportOptions extends VertexHttpTransportOptions {
  readonly resolveRequestContext: (
    evidence: PreparedRequestEvidenceRecord,
  ) => Promise<VertexRequestDispatchContext> | VertexRequestDispatchContext;
}

export class VertexPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly transport: VertexHttpTransport;
  private readonly resolveRequestContext: VertexPreparedEvidenceTransportOptions['resolveRequestContext'];

  constructor(options: VertexPreparedEvidenceTransportOptions) {
    if (typeof options.resolveRequestContext !== 'function') {
      fail('INVALID_INPUT', 'a vertex request context resolver is required');
    }
    this.transport = new VertexHttpTransport(options);
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
      protocol: context.protocol,
      model: context.model,
      body,
      stream: context.stream,
      anthropicBetaHeader: context.anthropicBetaHeader ?? null,
      clientHeaders: context.clientHeaders,
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
    // The Gemini-on-Vertex usage arrives with the terminal usageMetadata
    // chunk; the anthropic family exposes none (the dispatch layer's generic
    // Anthropic usage observers own that response shape).
    let observedUsage: VertexResponseUsage | null = null;
    if (context.protocol === 'gemini') {
      void result.usage
        .then((usage) => {
          observedUsage = usage;
          return usage;
        })
        .catch(() => null);
    }
    return {
      responseStarted: false,
      resultHttpStatus: result.status,
      headers: result.headers,
      body: result.body,
      get providerUsage(): NormalSuccessObservedUsage | null {
        return observedUsage === null ? null : vertexUsageToObservedUsage(observedUsage);
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
    fail('INVALID_INPUT', 'payload bytes are not the vertex JSON body');
  }
  if (!isRecord(parsed)) fail('INVALID_INPUT', 'payload bytes are not the vertex JSON body');
  return parsed;
}
