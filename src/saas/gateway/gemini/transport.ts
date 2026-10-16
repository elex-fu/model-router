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
import { GEMINI_CLI_BASE_URL } from './catalog-identity.js';
import { GEMINI_CLI_USER_AGENT } from './constants.js';
import type { GeminiQuotaTierId } from './identity.js';
import { classifyGemini429, type GeminiRateLimitClassification } from './quota-headers.js';
import { type GeminiUsageMetadata, mergeGeminiUsageMetadata, parseGeminiUsageMetadata } from './quota-usage.js';
import { type GeminiResponseUsage, geminiUsageFromMetadata } from './response-bridge.js';

/**
 * F4 Gemini HTTP transport (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). Assembles the
 * outbound request for the Gemini Code Assist internal endpoint on the shared
 * oauth-subscription skeleton (sub2api's buildGeminiChatCompletions
 * UpstreamRequestFunc, OAuth-with-project branch):
 *
 * - URL/Host pinned to cloudcode-pa.googleapis.com (injectable base for
 *   tests); the action is `v1internal:generateContent` /
 *   `v1internal:streamGenerateContent?alt=sse`;
 * - `Authorization: Bearer <access_token>` resolved from the sealed
 *   credential envelope through the injected resolver (the plaintext token
 *   exists only inside its callback);
 * - the pinned GeminiCLI user agent and JSON content type;
 * - the wrapped `{model, project, request}` body the internal endpoint
 *   expects (transform.ts builds it; the transport only re-validates);
 * - 429 classification from the Google JSON error body + retry-after, with
 *   an at-least-30s throttled, best-effort classification write;
 * - upstream error classification (shared health classifier) split into the
 *   account health signal and the in-flight failover signal;
 * - SSE relay that keeps draining the upstream after the client disconnects
 *   so the usageMetadata in the terminal stream chunks is still collected.
 */

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;

/** The unsealed Gemini account facts the transport needs (envelope subset). */
export interface GeminiUpstreamCredential {
  readonly accessToken: string;
  /** The Cloud Code Assist project the v1internal wrap targets. */
  readonly projectId: string;
  /** Canonical tier id when known (drives the 429 cooldown). */
  readonly tierId?: string | null;
}

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type GeminiCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: GeminiUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort 429 classification write (persistence is the sink's job). */
export type GeminiRateLimitSink = (record: {
  readonly accountId: string;
  readonly classification: GeminiRateLimitClassification;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type GeminiAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: UpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

export interface GeminiTransportRequest {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The model id (already normalized by transform.ts). */
  readonly model: string;
  /** The wrapped `{model, project, request}` outbound body. */
  readonly body: unknown;
  /** Whether the client asked for a stream (selects the streamGenerateContent action). */
  readonly stream: boolean;
  /** Canonical tier id for the 429 cooldown; null uses the unknown-tier default. */
  readonly tierId?: GeminiQuotaTierId | null;
  readonly signal: AbortSignal;
}

export interface GeminiTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal usageMetadata chunk. */
  readonly usage: Promise<GeminiResponseUsage | null>;
  readonly rateLimitWritten: boolean;
}

export interface GeminiTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: UpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly rateLimitWritten: boolean;
}

export type GeminiTransportResult = GeminiTransportStreamResult | GeminiTransportErrorResult;

export type GeminiTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class GeminiHttpTransportError extends Error {
  constructor(
    readonly code: GeminiTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiHttpTransportError';
  }
}

function fail(code: GeminiTransportErrorCode, message: string): never {
  throw new GeminiHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Incremental Gemini SSE watcher: extracts the usageMetadata from every
 * chunk (wrapped or bare) without buffering whole events; the terminal
 * observation is the last chunk that carries one.
 */
class GeminiUsageWatcher {
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
    const metadata = parseGeminiUsageMetadata(
      isRecord(parsed.response) ? (parsed.response as Record<string, unknown>).usageMetadata : parsed.usageMetadata,
    );
    if (metadata !== null) this.usage = mergeGeminiUsageMetadata(this.usage, metadata);
  }

  /** Non-null only once a usageMetadata chunk has been observed. */
  get observed(): GeminiResponseUsage | null {
    return this.usage === null ? null : geminiUsageFromMetadata(this.usage);
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export interface GeminiHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable override of the pinned endpoint (tests use a local mock). */
  readonly baseUrl?: string;
  readonly resolveCredential: GeminiCredentialResolver;
  readonly writeRateLimit?: GeminiRateLimitSink;
  readonly recordAccountHealth?: GeminiAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly baseUrl: URL;
  readonly resolveCredential: GeminiCredentialResolver;
  readonly writeRateLimit: GeminiRateLimitSink | null;
  readonly recordAccountHealth: GeminiAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot gemini transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class GeminiHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly rateLimitThrottle: QuotaSnapshotWriteThrottle;

  constructor(options: GeminiHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a gemini credential resolver is required');
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl ?? GEMINI_CLI_BASE_URL);
    } catch {
      fail('INVALID_INPUT', 'the gemini base URL is invalid');
    }
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
      fail('INVALID_INPUT', 'the gemini base URL must be https except for local test upstreams');
    }
    this.options = {
      fetch: options.fetch,
      baseUrl,
      resolveCredential: options.resolveCredential,
      writeRateLimit: options.writeRateLimit ?? null,
      recordAccountHealth: options.recordAccountHealth ?? null,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotMinIntervalMs: options.snapshotMinIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
    this.rateLimitThrottle = new QuotaSnapshotWriteThrottle(this.options.snapshotMinIntervalMs, this.options.nowMs);
  }

  async send(request: GeminiTransportRequest): Promise<GeminiTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a gemini transport request is required');
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the gemini outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion', 'model'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `gemini transport request field ${field} is required`);
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
      if (error instanceof GeminiHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'gemini transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'gemini transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'gemini credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: GeminiTransportRequest,
    credential: GeminiUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<GeminiTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'gemini credential is invalid');
    if (typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) {
      fail('CREDENTIAL_INVALID', 'gemini credential carries no access token');
    }
    if (typeof credential.projectId !== 'string' || credential.projectId.trim().length === 0) {
      fail('CREDENTIAL_INVALID', 'gemini credential carries no code assist project');
    }

    const action = request.stream ? 'streamGenerateContent' : 'generateContent';
    const url = new URL(`${this.options.baseUrl.toString().replace(/\/+$/, '')}/v1internal:${action}`);
    if (request.stream) url.searchParams.set('alt', 'sse');
    const headers: Record<string, string> = {
      host: url.host,
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      'user-agent': GEMINI_CLI_USER_AGENT,
      accept: request.stream ? 'text/event-stream' : 'application/json',
    };
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
      if (timedOut()) fail('TIMEOUT', 'gemini transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'gemini transport was aborted');
      fail('NETWORK_ERROR', 'gemini upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'gemini upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'gemini upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'gemini upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await boundedErrorBody(response, controller.signal, MAX_ERROR_BODY_BYTES);
      const rateLimitWritten = await this.maybeWriteRateLimit(
        request.accountId,
        responseHeaders,
        response.status,
        request.tierId ?? null,
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
    const relay = createDrainingRelay(body, controller.signal, new GeminiUsageWatcher(), {
      maxDrainBufferBytes: MAX_DRAIN_BUFFER_BYTES,
      errorMessage: 'gemini drain buffer exceeded',
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
    tierId: GeminiQuotaTierId | null,
    bodyText: string | null,
  ): Promise<boolean> {
    if (this.options.writeRateLimit === null) return false;
    if (status !== 429) return false;
    const classification = classifyGemini429(
      { headers: headers as Record<string, string>, bodyText, tierId },
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
