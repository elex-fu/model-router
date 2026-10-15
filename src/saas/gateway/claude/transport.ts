import {
  classifyUpstreamError,
  shouldFailover,
  type UpstreamErrorClassification,
} from '../oauth-subscription/health-classifier.js';
import { deriveStableUUIDv4 } from '../oauth-subscription/identity-namespace.js';
import {
  boundedErrorBody,
  cancelResponseBody,
  createDrainingRelay,
  flattenHeaders,
  QuotaSnapshotWriteThrottle,
} from '../oauth-subscription/transport-skeleton.js';
import { CLAUDE_MESSAGES_ENDPOINT } from './catalog-identity.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_CLIENT_IDENTITY_HEADERS,
  CLAUDE_CODE_MIMICRY_BETA_HEADER,
  CLAUDE_STAINLESS_HEADERS,
} from './constants.js';
import { buildClaudeUserAgent, resolveClaudeCliVersion } from './identity.js';
import { type ClaudeRateLimitClassification, classifyClaude429 } from './quota-headers.js';
import { type ClaudeMessagesUsage, parseMessagesUsage } from './response-bridge.js';

/**
 * R5 Claude HTTP transport (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Assembles the
 * outbound request for `api.anthropic.com/v1/messages` on the shared
 * oauth-subscription skeleton:
 *
 * - URL/Host pinned to the Anthropic messages endpoint (injectable base for
 *   tests);
 * - `Authorization: Bearer <access_token>` resolved from the sealed
 *   credential envelope through the injected resolver (the plaintext token
 *   exists only inside its callback);
 * - the full Claude Code mimicry header set: ordered `anthropic-beta`, UA
 *   `claude-cli/{version}`, the `x-stainless-*` family, `x-app: cli`,
 *   `anthropic-dangerous-direct-browser-access: true`,
 *   `anthropic-version: 2023-06-01`;
 * - per-account identity namespace isolation for the metadata user id so a
 *   failover never exposes one client conversation under two Claude
 *   accounts;
 * - `anthropic-ratelimit-unified-*` parsing on every 429 with an
 *   at-least-30s throttled, best-effort classification write;
 * - upstream error classification (shared health classifier) split into the
 *   account health signal and the in-flight failover signal;
 * - SSE relay that keeps draining the upstream after the client disconnects
 *   so the usage in the terminal `message_delta`/`message_stop` events is
 *   still collected.
 */

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;
const CLAUDE_METADATA_USER_ID_NAMESPACE = 'mr:claude-metadata-user-id:v1:';

/** The unsealed Claude account facts the transport needs (envelope subset). */
export interface ClaudeUpstreamCredential {
  readonly accessToken: string;
  readonly organizationUuid: string;
  readonly accountUuid: string;
}

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type ClaudeCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: ClaudeUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort 429 classification write (persistence is the sink's job). */
export type ClaudeRateLimitSink = (record: {
  readonly accountId: string;
  readonly classification: ClaudeRateLimitClassification;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type ClaudeAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: UpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

export interface ClaudeTransportRequest {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The claude-transformed outbound /v1/messages body. */
  readonly body: unknown;
  /** Proxy key id: the first namespace component of session isolation. */
  readonly proxyKeyId: string | null;
  /** Operator CLI version override (scheduling column); null uses the pin. */
  readonly cliVersionOverride?: string | null;
  readonly signal: AbortSignal;
}

export interface ClaudeTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal message events. */
  readonly usage: Promise<ClaudeMessagesUsage | null>;
  readonly rateLimitWritten: boolean;
}

export interface ClaudeTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: UpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly rateLimitWritten: boolean;
}

export type ClaudeTransportResult = ClaudeTransportStreamResult | ClaudeTransportErrorResult;

export type ClaudeTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class ClaudeHttpTransportError extends Error {
  constructor(
    readonly code: ClaudeTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeHttpTransportError';
  }
}

function fail(code: ClaudeTransportErrorCode, message: string): never {
  throw new ClaudeHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Incremental Messages SSE watcher: extracts the usage facts from
 * `message_start` (input side) and the terminal `message_delta`
 * (authoritative output_tokens) without buffering whole events.
 */
class MessagesUsageWatcher {
  private buffer = '';
  private usage: ClaudeMessagesUsage | null = null;
  private complete = false;

  feed(chunk: Uint8Array): void {
    if (this.complete) return;
    this.buffer += new TextDecoder('utf-8', { fatal: false }).decode(chunk, { stream: true });
    for (let boundary = findEventBoundary(this.buffer); boundary !== null; boundary = findEventBoundary(this.buffer)) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.acceptBlock(block);
      if (this.complete) {
        this.buffer = '';
        return;
      }
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
    if (parsed.type === 'message_start') {
      const message = isRecord(parsed.message) ? parsed.message : null;
      const usage = message === null ? null : parseMessagesUsage(message.usage);
      if (usage !== null) this.usage = usage;
      return;
    }
    if (parsed.type === 'message_delta') {
      const outputUsage = parseMessagesUsage(parsed.usage);
      if (outputUsage !== null) {
        this.usage = {
          inputTokens: this.usage?.inputTokens ?? outputUsage.inputTokens,
          cacheReadTokens: this.usage?.cacheReadTokens ?? outputUsage.cacheReadTokens,
          cacheCreationTokens: this.usage?.cacheCreationTokens ?? outputUsage.cacheCreationTokens,
          outputTokens: outputUsage.outputTokens ?? this.usage?.outputTokens ?? null,
        };
      }
      // message_delta carries the authoritative final output token count:
      // the terminal event for drain purposes.
      this.complete = true;
    }
  }

  /** Non-null only once the terminal usage event has been observed. */
  get observed(): ClaudeMessagesUsage | null {
    return this.complete ? this.usage : null;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export interface ClaudeHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable override of the pinned endpoint (tests use a local mock). */
  readonly baseUrl?: string;
  readonly resolveCredential: ClaudeCredentialResolver;
  readonly writeRateLimit?: ClaudeRateLimitSink;
  readonly recordAccountHealth?: ClaudeAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly baseUrl: URL;
  readonly resolveCredential: ClaudeCredentialResolver;
  readonly writeRateLimit: ClaudeRateLimitSink | null;
  readonly recordAccountHealth: ClaudeAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot claude transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class ClaudeHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly rateLimitThrottle: QuotaSnapshotWriteThrottle;

  constructor(options: ClaudeHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a claude credential resolver is required');
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl ?? CLAUDE_MESSAGES_ENDPOINT);
    } catch {
      fail('INVALID_INPUT', 'the claude base URL is invalid');
    }
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
      fail('INVALID_INPUT', 'the claude base URL must be https except for local test upstreams');
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

  async send(request: ClaudeTransportRequest): Promise<ClaudeTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a claude transport request is required');
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the claude outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `claude transport request field ${field} is required`);
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
      if (error instanceof ClaudeHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'claude transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'claude transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'claude credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: ClaudeTransportRequest,
    credential: ClaudeUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<ClaudeTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'claude credential is invalid');
    if (typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) {
      fail('CREDENTIAL_INVALID', 'claude credential carries no access token');
    }

    const headers = this.buildHeaders(request, credential);
    const bodyBytes = Buffer.from(JSON.stringify(request.body), 'utf8');
    let response: Response;
    try {
      response = await this.options.fetch(this.options.baseUrl.toString(), {
        method: 'POST',
        headers,
        body: bodyBytes,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (timedOut()) fail('TIMEOUT', 'claude transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'claude transport was aborted');
      fail('NETWORK_ERROR', 'claude upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'claude upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'claude upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'claude upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);
    const rateLimitWritten = this.maybeWriteRateLimit(request.accountId, responseHeaders, response.status);

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
    const relay = createDrainingRelay(body, controller.signal, new MessagesUsageWatcher(), {
      maxDrainBufferBytes: MAX_DRAIN_BUFFER_BYTES,
      errorMessage: 'claude drain buffer exceeded',
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

  /**
   * The Claude Code mimicry header set. The ordered `anthropic-beta` value
   * and the UA/cli-version agreement are the load-bearing signals; the
   * billing attribution block itself lives in the body (transform.ts).
   */
  private buildHeaders(request: ClaudeTransportRequest, credential: ClaudeUpstreamCredential): Record<string, string> {
    const cliVersion = resolveClaudeCliVersion(request.cliVersionOverride ?? undefined);
    const headers: Record<string, string> = {
      host: this.options.baseUrl.host,
      authorization: `Bearer ${credential.accessToken}`,
      'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_CODE_MIMICRY_BETA_HEADER,
      'user-agent': buildClaudeUserAgent(cliVersion),
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...CLAUDE_STAINLESS_HEADERS,
      ...CLAUDE_CLIENT_IDENTITY_HEADERS,
    };
    return headers;
  }

  private maybeWriteRateLimit(accountId: string, headers: Readonly<Record<string, string>>, status: number): boolean {
    if (this.options.writeRateLimit === null) return false;
    if (status !== 429) return false;
    const classification = classifyClaude429(headers as Record<string, string>, this.options.nowMs());
    if (classification === null) return false;
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

/** Deterministic metadata user id seed helper shared with the payload layer. */
export function claudeMetadataUserSeed(proxyKeyId: string, accountUuid: string): string {
  return `${CLAUDE_METADATA_USER_ID_NAMESPACE}${proxyKeyId}:${accountUuid}`;
}

/** The deriveStableUUIDv4-based metadata user id (identity namespace kernel). */
export function claudeMetadataUserId(proxyKeyId: string, accountUuid: string): string {
  return deriveStableUUIDv4(claudeMetadataUserSeed(proxyKeyId, accountUuid));
}
