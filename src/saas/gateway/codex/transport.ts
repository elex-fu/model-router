import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../prepared-request-evidence-service.js';
import { type CodexUpstreamErrorClassification, classifyUpstreamError, shouldFailover } from './health.js';
import {
  accountIdentityNamespace,
  buildCanonicalIdentity,
  type FingerprintMode,
  isolateSessionId,
  resolveFingerprintIds,
} from './identity.js';
import { type CodexRateLimitSnapshot, parseCodexRateLimitHeaders } from './quota-headers.js';
import { type CodexResponsesUsage, parseResponsesUsage } from './response-bridge.js';

/**
 * P1c Codex HTTP transport (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.5). Assembles the
 * outbound request for `chatgpt.com/backend-api/codex/responses`:
 *
 * - URL/Host pinned to the ChatGPT codex backend (injectable base for tests);
 * - `Authorization: Bearer <access_token>` plus the `chatgpt-account-id`
 *   header, both resolved from the sealed credential envelope through the
 *   injected resolver (the plaintext token exists only inside its callback);
 * - the canonical identity trio (`user-agent`/`originator`/`version`) from
 *   identity.ts, `OpenAI-Beta: responses=experimental`, and an SSE accept;
 * - per-account identity namespace isolation for session/conversation ids so
 *   a failover never exposes one client conversation under two accounts;
 * - optional fingerprint convergence (account opt-in, mode != off);
 * - `x-codex-*` rate-limit header parsing on every response (including 429)
 *   with an at-least-30s throttled, best-effort snapshot write;
 * - upstream error classification (health.ts) split into the account health
 *   signal and the in-flight failover signal;
 * - SSE relay that keeps draining the upstream after the client disconnects
 *   so the usage in the terminal `response.completed` event is still
 *   collected (sub2api parity).
 */

/** Pinned upstream target; the only base this transport ever dials in production. */
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_RESPONSES_HOST = 'chatgpt.com';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32_768;
const MAX_DRAIN_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 4_096;
const SHA256 = /^[0-9a-f]{64}$/;

/** The unsealed ChatGPT account facts the transport needs (envelope subset). */
export interface CodexUpstreamCredential {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string;
}

/**
 * Resolves the sealed credential and injects it only through the callback.
 * The callback's return value is surfaced unchanged; the credential never
 * escapes the resolver boundary.
 */
export type CodexCredentialResolver = <T>(
  input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly credentialVersion: string;
    readonly signal: AbortSignal;
  },
  useCredential: (credential: CodexUpstreamCredential) => Promise<T>,
) => Promise<T>;

/** Throttled, best-effort quota snapshot write (persistence is the sink's job). */
export type CodexQuotaSnapshotSink = (record: {
  readonly accountId: string;
  readonly snapshot: CodexRateLimitSnapshot;
  readonly observedAtMs: number;
  readonly fromStatus: number;
}) => void | Promise<void>;

/** Account health signal (classification) separate from the failover signal. */
export type CodexAccountHealthSink = (signal: {
  readonly accountId: string;
  readonly classification: CodexUpstreamErrorClassification;
  readonly failover: boolean;
}) => void | Promise<void>;

/** Per-request identity context; the gateway resolves it from its own state. */
export interface CodexRequestIdentityContext {
  /** Proxy key id: the first namespace component of session isolation. */
  readonly proxyKeyId: string;
  readonly clientSessionId: string | null;
  readonly clientConversationId: string | null;
  readonly fingerprintMode: FingerprintMode;
  readonly fingerprintSeed: string | null;
  readonly adminDeviceId?: string | null;
  /** Tracked CLI version override; below the minimum it degrades to baseline. */
  readonly identityVersionOverride?: string;
}

export interface CodexTransportRequest extends CodexRequestIdentityContext {
  readonly accountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The codex-transformed outbound body (applyCodexOAuthTransform applied). */
  readonly body: unknown;
  /**
   * Client-provided headers restricted to the codex passthrough whitelist
   * (`session_id`, `conversation_id`, `originator`, `x-codex-*`). Canonical
   * identity and namespace isolation always win over these values.
   */
  readonly passthroughHeaders?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface CodexTransportStreamResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Settles with the usage from the terminal response.completed event. */
  readonly usage: Promise<CodexResponsesUsage | null>;
  readonly quotaSnapshotWritten: boolean;
}

export interface CodexTransportErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly classification: CodexUpstreamErrorClassification;
  /** Whether the in-flight request should fail over to another account. */
  readonly failover: boolean;
  readonly bodyText: string | null;
  readonly quotaSnapshotWritten: boolean;
}

export type CodexTransportResult = CodexTransportStreamResult | CodexTransportErrorResult;

export type CodexTransportErrorCode =
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class CodexHttpTransportError extends Error {
  constructor(
    readonly code: CodexTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexHttpTransportError';
  }
}

function fail(code: CodexTransportErrorCode, message: string): never {
  throw new CodexHttpTransportError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function printableHeaderValue(value: unknown, name: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) fail('INVALID_INPUT', `passthrough header ${name} carries control characters`);
  }
  return value;
}

function isPassthroughHeaderName(name: string): boolean {
  return name === 'session_id' || name === 'conversation_id' || name === 'originator' || name.startsWith('x-codex-');
}

/** Normalized Responses usage → the gateway's observed-usage contract. */
export function codexUsageToObservedUsage(usage: CodexResponsesUsage): NormalSuccessObservedUsage | null {
  const raw = {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    ...(usage.cachedTokens === null ? {} : { input_tokens_details: { cached_tokens: usage.cachedTokens } }),
    ...(usage.reasoningTokens === null ? {} : { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
  const normalized = normalizeUsage('responses', raw);
  if (normalized.status !== 'reported' || normalized.inputTotal === null || normalized.outputTotal === null) {
    return null;
  }
  return Object.freeze({ ...normalized, source: 'upstream' });
}

/**
 * Incremental SSE data-frame watcher: extracts the `usage` object from the
 * terminal `response.completed` event without buffering whole events.
 */
class ResponsesUsageWatcher {
  private buffer = '';
  private usage: CodexResponsesUsage | null = null;

  feed(chunk: Uint8Array): void {
    if (this.usage !== null) return;
    this.buffer += new TextDecoder('utf-8', { fatal: false }).decode(chunk, { stream: true });
    for (let boundary = findEventBoundary(this.buffer); boundary !== null; boundary = findEventBoundary(this.buffer)) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.acceptBlock(block);
      if (this.usage !== null) {
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
    if (isRecord(parsed) && parsed.type === 'response.completed') {
      const response = isRecord(parsed.response) ? parsed.response : null;
      const usage = response === null ? null : parseResponsesUsage(response.usage);
      if (usage !== null) this.usage = usage;
    }
  }

  get observed(): CodexResponsesUsage | null {
    return this.usage;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export interface CodexHttpTransportOptions {
  /** Undici-compatible adapter; tests inject a local mock upstream. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable override of the pinned endpoint (tests use a local mock). */
  readonly baseUrl?: string;
  readonly resolveCredential: CodexCredentialResolver;
  readonly writeQuotaSnapshot?: CodexQuotaSnapshotSink;
  readonly recordAccountHealth?: CodexAccountHealthSink;
  readonly timeoutMs?: number;
  readonly snapshotMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

interface NormalizedTransportOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly baseUrl: URL;
  readonly resolveCredential: CodexCredentialResolver;
  readonly writeQuotaSnapshot: CodexQuotaSnapshotSink | null;
  readonly recordAccountHealth: CodexAccountHealthSink | null;
  readonly timeoutMs: number;
  readonly snapshotMinIntervalMs: number;
  readonly nowMs: () => number;
}

/**
 * One-shot codex transport. Construct once per process; all mutable state
 * (snapshot throttling) is per-account and fails open on write errors.
 */
export class CodexHttpTransport {
  private readonly options: NormalizedTransportOptions;
  private readonly lastSnapshotWriteMs = new Map<string, number>();

  constructor(options: CodexHttpTransportOptions) {
    if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
    if (typeof options.resolveCredential !== 'function') {
      fail('INVALID_INPUT', 'a codex credential resolver is required');
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl ?? CODEX_RESPONSES_ENDPOINT);
    } catch {
      fail('INVALID_INPUT', 'the codex base URL is invalid');
    }
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
      fail('INVALID_INPUT', 'the codex base URL must be https except for local test upstreams');
    }
    this.options = {
      fetch: options.fetch,
      baseUrl,
      resolveCredential: options.resolveCredential,
      writeQuotaSnapshot: options.writeQuotaSnapshot ?? null,
      recordAccountHealth: options.recordAccountHealth ?? null,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotMinIntervalMs: options.snapshotMinIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
  }

  async send(request: CodexTransportRequest): Promise<CodexTransportResult> {
    if (!request || typeof request !== 'object') fail('INVALID_INPUT', 'a codex transport request is required');
    if (!isRecord(request.body)) fail('INVALID_INPUT', 'the codex outbound body must be a JSON object');
    for (const field of ['accountId', 'credentialId', 'credentialVersion', 'proxyKeyId'] as const) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_INPUT', `codex transport request field ${field} is required`);
      }
    }
    if (
      request.fingerprintMode !== 'off' &&
      (typeof request.fingerprintSeed !== 'string' || request.fingerprintSeed.length === 0)
    ) {
      fail('INVALID_INPUT', 'fingerprint convergence requires a per-account seed');
    }
    const passthrough = normalizePassthroughHeaders(request.passthroughHeaders);

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
        (credential) => this.sendWithCredential(request, passthrough, credential, controller, () => timedOut),
      );
    } catch (error) {
      if (error instanceof CodexHttpTransportError) throw error;
      if (timedOut) fail('TIMEOUT', 'codex transport timed out');
      if (request.signal.aborted || controller.signal.aborted) fail('ABORTED', 'codex transport was aborted');
      fail('CREDENTIAL_UNAVAILABLE', 'codex credential resolution failed');
    } finally {
      cleanup();
    }
  }

  private async sendWithCredential(
    request: CodexTransportRequest,
    passthrough: Readonly<Record<string, string>>,
    credential: CodexUpstreamCredential,
    controller: AbortController,
    timedOut: () => boolean,
  ): Promise<CodexTransportResult> {
    if (!credential || typeof credential !== 'object') fail('CREDENTIAL_INVALID', 'codex credential is invalid');
    if (typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) {
      fail('CREDENTIAL_INVALID', 'codex credential carries no access token');
    }
    if (typeof credential.chatgptAccountId !== 'string' || credential.chatgptAccountId.length === 0) {
      fail('CREDENTIAL_INVALID', 'codex credential carries no chatgpt account id');
    }
    if (typeof credential.chatgptUserId !== 'string' || credential.chatgptUserId.length === 0) {
      fail('CREDENTIAL_INVALID', 'codex credential carries no chatgpt user id');
    }

    const headers = this.buildHeaders(request, passthrough, credential);
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
      if (timedOut()) fail('TIMEOUT', 'codex transport timed out');
      if (controller.signal.aborted) fail('ABORTED', 'codex transport was aborted');
      fail('NETWORK_ERROR', 'codex upstream request failed');
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'codex upstream returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      void cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'codex upstream redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      void cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'codex upstream returned an invalid status');
    }

    const responseHeaders = flattenHeaders(response);
    const quotaSnapshotWritten = this.maybeWriteQuotaSnapshot(request.accountId, responseHeaders, response.status);

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await boundedErrorBody(response, controller.signal);
      const classification = classifyUpstreamError({
        status: response.status,
        bodyText: bodyText ?? '',
        headers: responseHeaders,
      });
      const failover = shouldFailover(classification);
      await this.recordHealth(request.accountId, classification, failover);
      return { ok: false, status: response.status, classification, failover, bodyText, quotaSnapshotWritten };
    }

    const body = response.body ?? null;
    if (body === null) {
      return {
        ok: true,
        status: response.status,
        headers: responseHeaders,
        body: null,
        usage: Promise.resolve(null),
        quotaSnapshotWritten,
      };
    }
    const relay = createDrainingRelay(body, controller.signal);
    return {
      ok: true,
      status: response.status,
      headers: responseHeaders,
      body: relay.stream,
      usage: relay.usage,
      quotaSnapshotWritten,
    };
  }

  private buildHeaders(
    request: CodexTransportRequest,
    passthrough: Readonly<Record<string, string>>,
    credential: CodexUpstreamCredential,
  ): Record<string, string> {
    const identity = buildCanonicalIdentity(request.identityVersionOverride);
    const headers: Record<string, string> = {
      host: this.options.baseUrl.host,
      authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.chatgptAccountId,
      'user-agent': identity.userAgent,
      originator: identity.originator,
      version: identity.version,
      'openai-beta': 'responses=experimental',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    };

    // Mandatory per-account identity namespace: the same client conversation
    // hashes to a different id under every (proxy key, ChatGPT account) pair.
    const namespace = accountIdentityNamespace({
      chatgptAccountId: credential.chatgptAccountId,
      chatgptUserId: credential.chatgptUserId,
    });
    const namespacedSession =
      request.clientSessionId !== null && request.clientSessionId.length > 0
        ? isolateSessionId(request.proxyKeyId, namespace, request.clientSessionId)
        : null;
    const namespacedConversation =
      request.clientConversationId !== null && request.clientConversationId.length > 0
        ? isolateSessionId(request.proxyKeyId, namespace, request.clientConversationId)
        : null;

    // Whitelisted client passthrough first; canonical identity wins below.
    for (const [name, value] of Object.entries(passthrough)) {
      headers[name.toLowerCase()] = value;
    }

    if (request.fingerprintMode !== 'off') {
      const fingerprints = resolveFingerprintIds({
        mode: request.fingerprintMode,
        seed: request.fingerprintSeed ?? '',
        clientSessionId: namespacedSession,
        adminDeviceId: request.adminDeviceId ?? null,
      });
      const installationId = fingerprints.installationId ?? passthrough['x-codex-installation-id'];
      if (installationId !== undefined && installationId !== null && installationId.length > 0) {
        headers['x-codex-installation-id'] = installationId;
      }
      if (fingerprints.sessionId !== null) headers.session_id = fingerprints.sessionId;
      if (fingerprints.threadId !== null) headers['thread-id'] = fingerprints.threadId;
      headers['x-codex-client-request-id'] = randomUUID();
    } else if (namespacedSession !== null) {
      headers.session_id = namespacedSession;
    }
    if (namespacedConversation !== null) headers.conversation_id = namespacedConversation;

    // The canonical trio is forced last: a client-supplied originator or UA
    // must never reach the upstream.
    headers.originator = identity.originator;
    headers['user-agent'] = identity.userAgent;
    headers.version = identity.version;
    return headers;
  }

  private maybeWriteQuotaSnapshot(
    accountId: string,
    headers: Readonly<Record<string, string>>,
    status: number,
  ): boolean {
    if (this.options.writeQuotaSnapshot === null) return false;
    const snapshot = parseCodexRateLimitHeaders(headers as Record<string, string>);
    if (snapshot === null) return false;
    const nowMs = this.options.nowMs();
    const last = this.lastSnapshotWriteMs.get(accountId);
    if (last !== undefined && nowMs - last < this.options.snapshotMinIntervalMs) return false;
    this.lastSnapshotWriteMs.set(accountId, nowMs);
    // Best-effort by contract: persistence failures never affect the response.
    void Promise.resolve()
      .then(() => this.options.writeQuotaSnapshot?.({ accountId, snapshot, observedAtMs: nowMs, fromStatus: status }))
      .catch(() => undefined);
    return true;
  }

  private async recordHealth(
    accountId: string,
    classification: CodexUpstreamErrorClassification,
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

function normalizePassthroughHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) fail('INVALID_INPUT', 'passthrough headers must be a header map');
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!isPassthroughHeaderName(name)) continue;
    const headerValue = printableHeaderValue(rawValue, name);
    if (headerValue !== null) normalized[name] = headerValue;
  }
  return normalized;
}

function flattenHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

async function boundedErrorBody(response: Response, signal: AbortSignal): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_ERROR_BODY_BYTES);
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) break;
      if (value.byteLength > buffer.byteLength - bytesRead) {
        try {
          await reader.cancel();
        } catch {
          // The truncated text is still the classification input.
        }
        break;
      }
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    if (signal.aborted) return null;
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytesRead));
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to observe on a rejected redirect body.
  }
}

/**
 * SSE relay with client-disconnect drain: chunks flow to the client while it
 * reads; after the client cancels, the pump keeps consuming the upstream so
 * the terminal `response.completed` usage is still collected (bounded by
 * MAX_DRAIN_BUFFER_BYTES of discarded buffering).
 */
function createDrainingRelay(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly usage: Promise<CodexResponsesUsage | null>;
} {
  const reader = upstream.getReader();
  const watcher = new ResponsesUsageWatcher();
  let resolveUsage!: (usage: CodexResponsesUsage | null) => void;
  const usage = new Promise<CodexResponsesUsage | null>((resolve) => {
    resolveUsage = resolve;
  });
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let pumpDone = false;
  let pumpError: unknown = null;
  let waiters: Array<() => void> = [];
  let clientCancelled = false;
  let upstreamCancelled = false;

  const notify = (): void => {
    const current = waiters;
    waiters = [];
    for (const waiter of current) waiter();
  };

  const cancelUpstream = (reason: unknown): void => {
    if (upstreamCancelled) return;
    upstreamCancelled = true;
    void reader.cancel(reason).catch(() => undefined);
  };

  const pump = (async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;
        watcher.feed(value);
        if (watcher.observed !== null && clientCancelled) {
          // Usage collected and the client is gone: stop draining early.
          cancelUpstream(undefined);
          break;
        }
        if (clientCancelled) {
          queuedBytes += value.byteLength;
          if (queuedBytes > MAX_DRAIN_BUFFER_BYTES) {
            cancelUpstream(new Error('codex drain buffer exceeded'));
            break;
          }
          continue;
        }
        queue.push(value);
        notify();
      }
    } catch (error) {
      pumpError = error;
    } finally {
      pumpDone = true;
      notify();
      resolveUsage(watcher.observed);
    }
  })();

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift();
            if (chunk !== undefined) {
              controller.enqueue(chunk);
              return;
            }
          }
          if (pumpDone) {
            if (pumpError !== null && !signal.aborted) {
              controller.error(pumpError instanceof Error ? pumpError : new Error('codex upstream stream failed'));
              return;
            }
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      },
      async cancel(reason) {
        clientCancelled = true;
        queue.length = 0;
        // Deliberately NOT cancelling the upstream here: the pump keeps
        // draining until usage arrives or the bounded buffer trips.
        void pump;
        void reason;
      },
    },
    { highWaterMark: 0 },
  );

  return { stream, usage };
}

/**
 * Adapter that plugs `CodexHttpTransport` into the gateway's prepared-evidence
 * dispatch chain. The evidence record carries the account/credential binding;
 * the per-request identity context (proxy key, session ids, fingerprint
 * config) comes from the injected resolver, which in production reads the
 * account's codex scheduling columns and the authenticated caller.
 */
export interface CodexPreparedEvidenceTransportOptions extends CodexHttpTransportOptions {
  readonly resolveRequestContext: (
    evidence: PreparedRequestEvidenceRecord,
  ) => Promise<CodexRequestIdentityContext> | CodexRequestIdentityContext;
}

export class CodexPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly transport: CodexHttpTransport;
  private readonly resolveRequestContext: CodexPreparedEvidenceTransportOptions['resolveRequestContext'];

  constructor(options: CodexPreparedEvidenceTransportOptions) {
    this.transport = new CodexHttpTransport(options);
    if (typeof options.resolveRequestContext !== 'function') {
      fail('INVALID_INPUT', 'a codex request context resolver is required');
    }
    this.resolveRequestContext = options.resolveRequestContext;
  }

  async send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    const body = assertPayloadBinding(input);
    const evidence = input.evidence;
    const context = await this.resolveRequestContext(evidence);
    const result = await this.transport.send({
      ...context,
      accountId: evidence.accountId,
      credentialId: evidence.credentialId,
      credentialVersion: evidence.credentialVersion,
      body,
      signal: input.signal,
    });
    if (!result.ok) {
      return {
        responseStarted: false,
        resultHttpStatus: result.status,
        headers: {},
        body: null,
      };
    }
    // The codex usage arrives with the stream's terminal event; expose it
    // through the same lazy accessor contract as the generic transport.
    let observedUsage: CodexResponsesUsage | null = null;
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
        return observedUsage === null ? null : codexUsageToObservedUsage(observedUsage);
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
  if (typeof evidence.payloadSha256 !== 'string' || !SHA256.test(evidence.payloadSha256)) {
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
    fail('INVALID_INPUT', 'payload bytes are not the codex JSON body');
  }
  if (!isRecord(parsed)) fail('INVALID_INPUT', 'payload bytes are not the codex JSON body');
  return parsed;
}
