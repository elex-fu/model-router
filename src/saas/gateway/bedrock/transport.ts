import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
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
import { BEDROCK_API_KEY_CREDENTIAL_TYPE } from './catalog-identity.js';
import { BEDROCK_DEFAULT_REGION } from './constants.js';
import { BedrockEventStreamDecoder } from './eventstream.js';
import { classifyBedrockUpstreamError, shouldBedrockFailover } from './health.js';
import { type BedrockRateLimitClassification, classifyBedrockRateLimit } from './quota-headers.js';
import {
  anthropicSseEventUsage,
  type BedrockObservedUsage,
  extractBedrockChunkData,
  formatAnthropicSseEvent,
  mergeBedrockObservedUsage,
  transformBedrockInvocationMetrics,
} from './response-bridge.js';
import { signBedrockRequest } from './sigv4.js';
import { buildBedrockInvokeUrl, prepareBedrockRequestBody, resolveBedrockModel } from './transform.js';

/**
 * Batch-3 AWS Bedrock HTTP transport (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Bedrock 核验修正 1;
 * port of sub2api's gateway_bedrock.go / bedrock_signer.go /
 * bedrock_stream.go onto the shared oauth-subscription skeleton). The
 * complete Bedrock-specific pipeline lives here because SigV4 cannot pass
 * the generic transport's static-header auth resolver
 * (ProviderSupplyHttpAuthenticationHeaderResolver is static-header only):
 *
 * - model resolution + the full request-body transform (transform.ts);
 * - the invoke URL with `%3A`-encoded model ids, pinned to
 *   bedrock-runtime.<region>.amazonaws.com;
 * - SigV4 signing over exactly Content-Type/Accept plus the AWS headers
 *   (the litellm lesson — extra signed headers fail verification), or the
 *   Bearer header for API-key credentials;
 * - the response bridging: non-streaming bodies pass through with
 *   amazon-bedrock-invocationMetrics converted to standard usage, and
 *   InvokeModelWithResponseStream binary EventStream frames are decoded
 *   (double CRC-32/IEEE verified) into standard Anthropic SSE;
 * - ThrottlingException classification with an at-least-30s throttled,
 *   best-effort rate-limit write;
 * - upstream error classification (shared matrix + AWS exception mapping)
 *   split into the account health signal and the in-flight failover
 *   signal (401/403/429/529/≥500 fail over; 400 never retries);
 * - an SSE relay that keeps draining the upstream after the client
 *   disconnects so the usage in the terminal stream events is still
 *   collected.
 */

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;
/** Bounded non-streaming response read (usage must be extractable). */
const MAX_NON_STREAM_BODY_BYTES = 32 * 1024 * 1024;

/** The unsealed Bedrock account facts the transport needs (envelope subset). */
export interface BedrockUpstreamCredential {
  /** SigV4 mode: the AWS access key id. */
  readonly accessKeyId?: string;
  /** SigV4 mode: the AWS secret access key. */
  readonly secretAccessKey?: string;
  /** SigV4 mode: the optional STS session token. */
  readonly sessionToken?: string | null;
  /** Bearer mode (Bedrock API key): `Authorization: Bearer <apiKey>`. */
  readonly apiKey?: string;
  /** The AWS region the invoke URL targets; defaults to us-east-1. */
  readonly region?: string;
  /** Forces the `global.` cross-region inference prefix. */
  readonly forceGlobal?: boolean;
}

/**
 * Parses the sealed-envelope plaintext into one credential shape. Exactly
 * one auth mode may be present: SigV4 keys (aws_access_key_id +
 * aws_secret_access_key [, aws_session_token]) or a bearer api_key.
 * Exported for the supply sink and the probe (the shared shape contract).
 */
export function parseBedrockCredentialMaterial(material: Record<string, unknown>): BedrockUpstreamCredential | null {
  const accessKeyId = typeof material.aws_access_key_id === 'string' ? material.aws_access_key_id : undefined;
  const secretAccessKey =
    typeof material.aws_secret_access_key === 'string' ? material.aws_secret_access_key : undefined;
  const apiKey = typeof material.api_key === 'string' ? material.api_key : undefined;
  const region =
    typeof material.aws_region === 'string' && material.aws_region !== '' ? material.aws_region : undefined;
  const sessionToken =
    typeof material.aws_session_token === 'string' && material.aws_session_token !== ''
      ? material.aws_session_token
      : null;
  const forceGlobal = material.aws_force_global === 'true' || material.aws_force_global === true;
  if (accessKeyId !== undefined && accessKeyId !== '') {
    if (secretAccessKey === undefined || secretAccessKey === '') return null;
    return { accessKeyId, secretAccessKey, sessionToken, region, forceGlobal };
  }
  if (apiKey !== undefined && apiKey !== '') {
    return { apiKey, region, forceGlobal };
  }
  return null;
}

/** The credential-type spellings the bedrock sink and transport accept. */
export const BEDROCK_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(['aws-sigv4', BEDROCK_API_KEY_CREDENTIAL_TYPE]);

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type BedrockCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: BedrockUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort ThrottlingException write (persistence is the sink's job). */
export type BedrockRateLimitSink = (record: {
  readonly accountId: string;
  readonly classification: BedrockRateLimitClassification;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type BedrockAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: import('./health.js').BedrockUpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

export interface BedrockTransportRequest {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The client-visible model id (resolved against the credential region here). */
  readonly model: string;
  /** The client's Anthropic Messages JSON body (untransformed). */
  readonly body: unknown;
  /** Whether the client asked for a stream (selects the stream endpoint). */
  readonly stream: boolean;
  /** The client's anthropic-beta header value, when the caller captured one. */
  readonly betaHeader?: string | null;
  readonly signal: AbortSignal;
}

export interface BedrockTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal SSE events. */
  readonly usage: Promise<BedrockObservedUsage | null>;
  readonly rateLimitWritten: boolean;
}

export interface BedrockTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: import('./health.js').BedrockUpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly rateLimitWritten: boolean;
}

export type BedrockTransportResult = BedrockTransportStreamResult | BedrockTransportErrorResult;

export type BedrockTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'UNSUPPORTED_MODEL'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class BedrockHttpTransportError extends Error {
  constructor(
    readonly code: BedrockTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BedrockHttpTransportError';
  }
}

function fail(code: BedrockTransportErrorCode, message: string): never {
  throw new BedrockHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Incremental Anthropic SSE usage watcher: every decoded Bedrock chunk is
 * an Anthropic event; message_start carries the full usage and
 * message_delta the output patch. The terminal observation merges them.
 */
class AnthropicUsageWatcher implements SseUsageWatcher<BedrockObservedUsage> {
  private buffer = '';
  private usage: BedrockObservedUsage | null = null;

  feed(chunk: Uint8Array): void {
    this.buffer += new TextDecoder('utf-8', { fatal: false }).decode(chunk, { stream: true });
    for (let boundary = this.buffer.indexOf('\n\n'); boundary >= 0; boundary = this.buffer.indexOf('\n\n')) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
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
    const usage = anthropicSseEventUsage(parsed);
    if (usage !== null) this.usage = mergeBedrockObservedUsage(this.usage, usage);
  }

  get observed(): BedrockObservedUsage | null {
    return this.usage;
  }
}

export interface BedrockHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable override of the region-pinned base URL (tests use a local mock). */
  readonly baseUrl?: string;
  readonly resolveCredential: BedrockCredentialResolver;
  readonly writeRateLimit?: BedrockRateLimitSink;
  readonly recordAccountHealth?: BedrockAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly baseUrl: string | null;
  readonly resolveCredential: BedrockCredentialResolver;
  readonly writeRateLimit: BedrockRateLimitSink | null;
  readonly recordAccountHealth: BedrockAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot bedrock transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class BedrockHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly rateLimitThrottle: QuotaSnapshotWriteThrottle;

  constructor(options: BedrockHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a bedrock credential resolver is required');
    }
    let base: URL | null = null;
    if (options.baseUrl !== undefined) {
      try {
        base = new URL(options.baseUrl);
      } catch {
        fail('INVALID_INPUT', 'the bedrock base URL is invalid');
      }
      if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
        fail('INVALID_INPUT', 'the bedrock base URL must be https except for local test upstreams');
      }
    }
    this.options = {
      fetch: options.fetch,
      baseUrl: base === null ? null : base.toString(),
      resolveCredential: options.resolveCredential,
      writeRateLimit: options.writeRateLimit ?? null,
      recordAccountHealth: options.recordAccountHealth ?? null,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotMinIntervalMs: options.snapshotMinIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
    this.rateLimitThrottle = new QuotaSnapshotWriteThrottle(this.options.snapshotMinIntervalMs, this.options.nowMs);
  }

  async send(request: BedrockTransportRequest): Promise<BedrockTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a bedrock transport request is required');
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the bedrock outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion', 'model'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `bedrock transport request field ${field} is required`);
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
      if (error instanceof BedrockHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'bedrock transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'bedrock transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'bedrock credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: BedrockTransportRequest,
    credential: BedrockUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<BedrockTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'bedrock credential is invalid');
    const sigv4 = credential.accessKeyId !== undefined && credential.secretAccessKey !== undefined;
    const bearer = !sigv4 && typeof credential.apiKey === 'string' && credential.apiKey.length > 0;
    if (!sigv4 && !bearer) fail('CREDENTIAL_INVALID', 'bedrock credential carries neither aws keys nor an api key');
    const region =
      credential.region === undefined || credential.region === '' ? BEDROCK_DEFAULT_REGION : credential.region;

    const resolution = resolveBedrockModel(request.model, { region, forceGlobal: credential.forceGlobal === true });
    if (!resolution.ok) {
      fail('UNSUPPORTED_MODEL', `the requested model is not a bedrock model id: ${request.model}`);
    }
    const modelId = resolution.modelId;
    const prepared = prepareBedrockRequestBody(request.body, {
      modelId,
      ...(request.betaHeader === undefined || request.betaHeader === null ? {} : { betaHeader: request.betaHeader }),
    });
    const payload = Buffer.from(JSON.stringify(prepared.body), 'utf8');

    const target = buildBedrockInvokeUrl({
      region,
      modelId,
      stream: request.stream,
      ...(this.options.baseUrl === null ? {} : { baseUrl: this.options.baseUrl }),
    });
    const headers: Record<string, string> = sigv4
      ? signBedrockRequest({
          credential: {
            accessKeyId: credential.accessKeyId as string,
            secretAccessKey: credential.secretAccessKey as string,
            sessionToken: credential.sessionToken ?? null,
          },
          method: 'POST',
          host: target.host,
          path: target.path,
          payload,
          region,
          nowMs: this.options.nowMs(),
        }).headers
      : {
          accept: 'application/json',
          'content-type': 'application/json',
          host: target.host,
          authorization: `Bearer ${credential.apiKey}`,
        };
    if (request.stream) headers.accept = 'application/json';

    let response: Response;
    try {
      response = await this.options.fetch(target.url, {
        method: 'POST',
        headers,
        body: payload,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (timedOut()) fail('TIMEOUT', 'bedrock transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'bedrock transport was aborted');
      fail('NETWORK_ERROR', 'bedrock upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'bedrock upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'bedrock upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'bedrock upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);
    // Bedrock's request id rides x-amzn-requestid; surface it as x-request-id
    // so the shared error extraction sees it (sub2api parity).
    const outboundHeaders: Record<string, string> = {};
    const requestId = responseHeaders['x-amzn-requestid'];
    if (typeof requestId === 'string' && requestId !== '') outboundHeaders['x-request-id'] = requestId;

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await boundedErrorBody(response, controller.signal, MAX_ERROR_BODY_BYTES);
      const rateLimitWritten = await this.maybeWriteRateLimit(
        request.accountId,
        responseHeaders,
        response.status,
        bodyText,
      );
      const classification = classifyBedrockUpstreamError({
        status: response.status,
        bodyText: bodyText ?? '',
        headers: responseHeaders,
      });
      const failover = shouldBedrockFailover(classification);
      await this.recordHealth(request.accountId, classification, failover);
      return { ok: false, status: response.status, classification, failover, bodyText, rateLimitWritten };
    }

    const body = response.body ?? null;
    if (body === null) {
      return {
        ok: true,
        status: response.status,
        headers: outboundHeaders,
        body: null,
        usage: Promise.resolve(null),
        rateLimitWritten: false,
      };
    }
    if (request.stream) {
      return this.relayEventStream(body, controller.signal, response.status, outboundHeaders);
    }
    return this.readNonStreaming(body, controller.signal, response.status, outboundHeaders);
  }

  /**
   * Streaming: the binary EventStream is decoded into Anthropic SSE bytes
   * through a TransformStream, then the shared draining relay carries it to
   * the client and keeps draining after a client disconnect so the terminal
   * usage events are still observed.
   */
  private relayEventStream(
    upstream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    status: number,
    headers: Record<string, string>,
  ): BedrockTransportStreamResult {
    const decoder = new BedrockEventStreamDecoder();
    const encoder = new TextEncoder();
    const watcher = new AnthropicUsageWatcher();
    const sse = upstream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const payload of decoder.feed(chunk)) {
            const event = extractBedrockChunkData(payload);
            if (event === null) continue;
            controller.enqueue(encoder.encode(formatAnthropicSseEvent(transformBedrockInvocationMetrics(event))));
          }
        },
      }),
    );
    const relay = createDrainingRelay(sse, signal, watcher, {
      maxDrainBufferBytes: MAX_DRAIN_BUFFER_BYTES,
      errorMessage: 'bedrock drain buffer exceeded',
    });
    return {
      ok: true,
      status,
      headers: { ...headers, 'content-type': 'text/event-stream' },
      body: relay.stream,
      usage: relay.usage,
      rateLimitWritten: false,
    };
  }

  /** Non-streaming: pass the body through with the invocationMetrics bridge. */
  private async readNonStreaming(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    status: number,
    headers: Record<string, string>,
  ): Promise<BedrockTransportStreamResult> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) break;
        total += value.byteLength;
        if (total > MAX_NON_STREAM_BODY_BYTES) {
          await reader.cancel(new Error('bedrock non-stream body exceeded the bound'));
          fail('INVALID_RESPONSE', 'bedrock non-stream body exceeded the bound');
        }
        chunks.push(value);
      }
    } catch {
      if (signal.aborted) fail('ABORTED', 'bedrock transport was aborted');
      fail('INVALID_RESPONSE', 'bedrock non-stream body read failed');
    }
    const merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(merged).toString('utf8'));
    } catch {
      fail('INVALID_RESPONSE', 'bedrock non-stream body is not JSON');
    }
    if (!isRecord(parsed)) fail('INVALID_RESPONSE', 'bedrock non-stream body is not a JSON object');
    const bridged = transformBedrockInvocationMetrics(parsed);
    const bridgedBytes = Buffer.from(JSON.stringify(bridged), 'utf8');
    const usage: BedrockObservedUsage | null = (() => {
      const observed = anthropicSseEventUsage(bridged);
      return observed === null ? null : observed;
    })();
    return {
      ok: true,
      status,
      headers: { ...headers, 'content-type': 'application/json' },
      body: new Response(bridgedBytes).body,
      usage: Promise.resolve(usage),
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
    // AWS reports throttling as 429 or as a 400 ValidationException-family
    // ThrottlingException; classify both spellings.
    if (status !== 429 && status !== 400) return false;
    const classification = classifyBedrockRateLimit(
      { headers: headers as Record<string, string>, bodyText },
      this.options.nowMs(),
    );
    if (!classification.throttlingException) return false;
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
    classification: import('./health.js').BedrockUpstreamErrorClassification,
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
 * Normalized Anthropic usage → the gateway's observed-usage contract. The
 * invocationMetrics bridge already produced the standard field names, so
 * the shared anthropic normalizer runs unchanged.
 */
export function bedrockUsageToObservedUsage(usage: BedrockObservedUsage): NormalSuccessObservedUsage | null {
  const normalized = normalizeUsage('anthropic', {
    input_tokens: usage.inputTokens ?? undefined,
    cache_read_input_tokens: usage.cacheReadTokens ?? undefined,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? undefined,
    output_tokens: usage.outputTokens ?? undefined,
  });
  if (normalized.status !== 'reported' || normalized.inputTotal === null || normalized.outputTotal === null) {
    return null;
  }
  return Object.freeze({ ...normalized, source: 'upstream' });
}

/**
 * Per-request dispatch context for the prepared-evidence adapter; the gateway
 * resolves it from the prepared evidence's route facts (resolved model,
 * client stream ask, captured beta header).
 */
export interface BedrockRequestDispatchContext {
  /** The client-visible model id (already normalized by the modelMap layer). */
  readonly model: string;
  /** Whether the client asked for a stream. */
  readonly stream: boolean;
  /** The client's anthropic-beta header value, when the caller captured one. */
  readonly betaHeader?: string | null;
}

/**
 * Adapter that plugs `BedrockHttpTransport` into the gateway's
 * prepared-evidence dispatch chain (the direct analog of
 * `GeminiPreparedEvidenceTransport`). The evidence record carries the
 * account/credential binding and the signed payload digest; the
 * per-request dispatch context comes from the injected resolver. Dispatch
 * routes evidence whose signed endpoint scope is the Bedrock catalog
 * endpoint (`bedrock-invoke`, provider protocol `anthropic`) here.
 */
export interface BedrockPreparedEvidenceTransportOptions extends BedrockHttpTransportOptions {
  readonly resolveRequestContext: (
    evidence: PreparedRequestEvidenceRecord,
  ) => Promise<BedrockRequestDispatchContext> | BedrockRequestDispatchContext;
}

export class BedrockPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly transport: BedrockHttpTransport;
  private readonly resolveRequestContext: BedrockPreparedEvidenceTransportOptions['resolveRequestContext'];

  constructor(options: BedrockPreparedEvidenceTransportOptions) {
    if (typeof options.resolveRequestContext !== 'function') {
      fail('INVALID_INPUT', 'a bedrock request context resolver is required');
    }
    this.transport = new BedrockHttpTransport(options);
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
      ...(context.betaHeader === undefined ? {} : { betaHeader: context.betaHeader }),
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
    // The usage arrives with the terminal SSE events (streaming) or the
    // bridged body (non-streaming); expose it through the same lazy
    // accessor contract as the gemini/codex adapters.
    let observedUsage: BedrockObservedUsage | null = null;
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
        return observedUsage === null ? null : bedrockUsageToObservedUsage(observedUsage);
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
    fail('INVALID_INPUT', 'payload bytes are not the bedrock JSON body');
  }
  if (!isRecord(parsed)) fail('INVALID_INPUT', 'payload bytes are not the bedrock JSON body');
  return parsed;
}
