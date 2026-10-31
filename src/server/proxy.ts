import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { Agent } from 'undici';
import type { ConfigStore } from '../config/store.js';
import type { Config, OAuthConfig, ProxyKey } from '../config/types.js';
import type { IpAuthBlocker } from '../limit/ipBlocker.js';
import type { KeyLimiter, ReserveResult } from '../limit/limiter.js';
import { redactSecrets } from '../limit/redact.js';
import type { LogEntry } from '../logger/types.js';
import { type Bridge, type Protocol, pickBridge } from '../protocol/bridge.js';
import { UnsupportedBridgeFeatureError } from '../protocol/openai-gemini.js';
import {
  BridgeToolChoiceMismatchError,
  BridgeToolChoiceSelectionError,
  supportsOpenAIToAnthropicThinkingHistory,
} from '../protocol/openai-to-anth.js';
import { providerProfile } from '../providers/profiles.js';
import { joinApiUrl } from '../providers/url.js';

/** Join a base URL with a bridge-rewritten absolute path (may carry a query). */
function appendUpstreamPath(baseUrl: string, rewrittenPath: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash)
    throw new Error('Invalid upstream base URL');
  if (!rewrittenPath.startsWith('/') || rewrittenPath.includes('\\') || /(^|\/)\.{1,2}(\/|$)/.test(rewrittenPath))
    throw new Error('Invalid upstream path');
  return new URL(rewrittenPath, base);
}

import { normalizeUsage } from '../providers/usage.js';
import { estimateQuotaAttemptReserve } from '../quota/estimate.js';
import type { SQLiteQuotaLedger } from '../quota/ledger.js';
import { quotaPeriod } from '../quota/period.js';
import type { QuotaTimezoneVersions } from '../quota/timezone-versions.js';
import {
  matchRoute,
  type RoutingSnapshot,
  resolveRoute,
  routeHasAuthorizedTarget,
  selectRouteTargets,
} from '../router/routes.js';
import { selectUpstreams } from '../router/upstream.js';
import type { ResponseOwnershipStore } from '../storage/response-ownership.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import type { CostEstimate } from '../telemetry/pricing.js';
import type { AttemptRecord, RequestRecord } from '../telemetry/types.js';
import {
  confirmedTokens,
  normalizeUsage as normalizeTelemetryUsage,
  type NormalizedUsage as TelemetryUsage,
} from '../telemetry/usage.js';
import { authenticateProxyKey } from './auth.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { getClientIp } from './clientIp.js';
import { optimizeCopilotBody, optimizeCopilotHeaders } from './copilotOptimizer.js';
import { keyIpAllowed } from './key-ip-policy.js';
import type { KeyPool } from './keyPool.js';
import { extractMultipartStringField, multipartBoundary } from './multipart.js';
import type { OAuthTokenResolver } from './oauth.js';
import { preprocessRequest } from './preprocess.js';
import { bedrockTransportProfile } from './providers/bedrock.js';
import type { ProviderTransportProfile } from './providers/types.js';
import { vertexTransportProfile } from './providers/vertex-sa.js';
import {
  isThinkingBudgetError,
  isThinkingSignatureError,
  rectifyAnthropicRequest,
  rectifyThinkingBudget,
} from './rectifier.js';

export interface ProxyHandlerOptions {
  /** O4: Prometheus registry; when absent the /metrics endpoint stays dark. */
  metrics?: {
    observeRequest(labels: { proto: string; upstream: string; status: number | string }, durationMs?: number): void;
    addTokens(direction: string, upstream: string, tokens: number): void;
    addInFlight(delta?: number): void;
    setCircuitState(upstream: string, state: number): void;
    render(): string;
  };
  /** O4: optional bearer token guarding /metrics (in addition to metricsEnabled). */
  metricsAuthToken?: string;
  /** O2: best-effort session affinity store; absent disables stickiness. */
  sessionAffinity?: {
    get(key: string, nowMs?: number): string | null;
    set(key: string, upstreamName: string, nowMs?: number): void;
    remove(key: string): void;
  };
  /**
   * C3b: transport profile overrides for tests (mocked token minting). The
   * built-in Bedrock/Vertex profiles serve any upstream that declares matching
   * credentials when no override is supplied.
   */
  providerTransports?: { bedrock?: ProviderTransportProfile; vertex?: ProviderTransportProfile };
  /** Server-only invocation; never populated from HTTP headers or request JSON. */
  internalPlayground?: {
    keyId: string;
    routeId: string;
    target: { upstreamId: string; model: string };
    signal: AbortSignal;
  };
  /** V2 adapter supplies resolved credentials and the current immutable routing snapshot. */
  getRuntimeSnapshot?: () => RoutingSnapshot;
  telemetryStore?: Pick<SQLiteTelemetryStore, 'upsertRequest' | 'upsertAttempt'>;
  quotaLedger?: Pick<SQLiteQuotaLedger, 'admit' | 'markAttemptSent' | 'settle'> &
    Partial<Pick<SQLiteQuotaLedger, 'topUp' | 'recordAttemptUsage'>>;
  quotaReserveTokens?: number;
  quotaTimezone?: string;
  quotaTimezoneVersions?: Pick<QuotaTimezoneVersions, 'resolveForAdmission'>;
  missingUsagePolicy?: 'retain-reservation' | 'release-reservation';
  responseOwnership?: ResponseOwnershipStore;
  priceAttempt?: (
    usage: TelemetryUsage,
    context: { upstreamId: string; provider: string; presetId?: string; model: string; atMs: number },
  ) => CostEstimate;
  configRevision?: number;
  /** Publishes only allowlisted request lifecycle metadata to the admin event stream. */
  publishEvent?: (type: 'request.completed', data: Record<string, unknown>) => void;
  limiter?: KeyLimiter;
  keyPool?: KeyPool;
  maxBodyBytes?: number;
  healthCheck?: () => Promise<boolean>;
  recorderHealthy?: () => boolean;
  ipBlocker?: IpAuthBlocker;
  trustProxy?: boolean | string[];
  streamIdleTimeoutMs?: number;
  connectTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  circuitBreaker?: CircuitBreaker;
  oauthResolver?: OAuthTokenResolver;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /** Optional retry jitter source, primarily for deterministic policy tests. */
  retryRandom?: () => number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

const DEFAULT_STREAM_IDLE_MS = 300_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 2_000;
const statusNeedsKeyCooldown = (status?: number): boolean => status === 401 || status === 403;
const UNSAFE_AUTH_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-real-ip',
  'x-request-id',
]);

function validCustomAuthHeader(name: string | undefined): name is string {
  if (!name || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) return false;
  const lower = name.toLowerCase();
  return (
    !UNSAFE_AUTH_HEADERS.has(lower) &&
    !['proxy-', 'sec-', 'x-forwarded-', 'x-model-router-', 'x-proxy-'].some((prefix) => lower.startsWith(prefix))
  );
}

function activeCapabilities(
  body: any,
): Array<'imageInput' | 'tools' | 'parallelTools' | 'structuredOutput' | 'thinking'> {
  const result: Array<'imageInput' | 'tools' | 'parallelTools' | 'structuredOutput' | 'thinking'> = [];
  const serialized = JSON.stringify(body?.messages ?? body?.input ?? []);
  if (serialized.includes('image_url') || serialized.includes('image_source') || serialized.includes('"type":"image"'))
    result.push('imageInput');
  if (Array.isArray(body?.tools) && body.tools.length > 0) result.push('tools');
  if (body?.parallel_tool_calls === true) result.push('parallelTools');
  if (body?.response_format?.type === 'json_schema' || body?.text?.format?.type === 'json_schema')
    result.push('structuredOutput');
  if ((body?.reasoning_effort && body.reasoning_effort !== 'none') || body?.thinking?.type === 'enabled')
    result.push('thinking');
  return result;
}

/** Shared undici Agent with longer keep-alive for upstream connections. */
const upstreamAgent = new Agent({
  connect: { timeout: 30_000 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
}

function collectBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers['content-length'] || '', 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      req.on('data', () => {});
      req.on('end', () => {
        reject(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
      });
      req.on('error', reject);
      return;
    }

    if (!Number.isNaN(contentLength) && contentLength > 0) {
      const buf = Buffer.allocUnsafe(contentLength);
      let offset = 0;
      req.on('data', (chunk: Buffer) => {
        offset += chunk.copy(buf, offset);
      });
      req.on('end', () => {
        resolve(buf.subarray(0, offset));
      });
      req.on('error', reject);
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!oversized) {
          oversized = true;
          chunks.length = 0;
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

function clientProtocolFromPath(path: string): Protocol | null {
  const pathname = path.split('?')[0];
  if (pathname === '/v1/messages') return 'anthropic';
  if (pathname === '/v1/messages/count_tokens') return 'anthropic';
  if (pathname === '/v1/chat/completions') return 'openai';
  if (pathname === '/v1/responses' || pathname === '/v1/responses/compact') return 'responses';
  // R2: embeddings rides the OpenAI inbound protocol family; the upstream
  // gate in trySingleUpstream keeps it passthrough-only for OpenAI upstreams.
  if (pathname === '/v1/embeddings') return 'openai';
  // C1: media-family endpoints ride the OpenAI inbound family (except the
  // anthropic-native count_tokens); per-endpoint upstream gates live in
  // trySingleUpstream next to the embeddings gate.
  if (
    pathname === '/v1/rerank' ||
    pathname === '/v1/completions' ||
    pathname === '/v1/images/generations' ||
    pathname === '/v1/audio/speech' ||
    pathname === '/v1/audio/transcriptions' ||
    pathname === '/v1/audio/translations'
  )
    return 'openai';
  if (path.startsWith('/v1beta/')) return 'gemini';
  return null;
}

/**
 * C1/C2 media endpoints: client path → upstream relative endpoint, plus the
 * protocol family that is allowed to serve each (fail-closed 422 otherwise,
 * mirroring the embeddings rule). `messages/count_tokens` composes with the
 * legacy-base `v1/` prefix the same way the anthropic `messages` endpoint does.
 */
const MEDIA_ENDPOINTS: Readonly<Record<string, { endpoint: string; requiredUpstream: Protocol }>> = {
  '/v1/rerank': { endpoint: 'rerank', requiredUpstream: 'openai' },
  '/v1/completions': { endpoint: 'completions', requiredUpstream: 'openai' },
  '/v1/images/generations': { endpoint: 'images/generations', requiredUpstream: 'openai' },
  '/v1/audio/speech': { endpoint: 'audio/speech', requiredUpstream: 'openai' },
  '/v1/audio/transcriptions': { endpoint: 'audio/transcriptions', requiredUpstream: 'openai' },
  '/v1/audio/translations': { endpoint: 'audio/translations', requiredUpstream: 'openai' },
  '/v1/messages/count_tokens': { endpoint: 'messages/count_tokens', requiredUpstream: 'anthropic' },
};

/** Multipart-form client paths: the request body is forwarded opaquely. */
const MULTIPART_REQUEST_PATHS = new Set<string>(['/v1/audio/transcriptions', '/v1/audio/translations']);

function writeProtocolError(
  res: ServerResponse,
  clientProto: Protocol,
  statusCode: number,
  errorType: string,
  message: string,
): void {
  const body =
    clientProto === 'anthropic'
      ? { type: 'error', error: { type: errorType, message } }
      : clientProto === 'gemini'
        ? { error: { code: statusCode, message, status: errorType } }
        : { error: { message, type: errorType, code: null } };
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function extractNonStreamUsage(
  upstreamProto: Protocol,
  body: any,
): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } {
  if (!body || typeof body !== 'object') return {};
  if (upstreamProto === 'anthropic') {
    const usage = body.usage ?? {};
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
    };
  }
  const usage = body.usage ?? {};
  const promptDetails = usage.prompt_tokens_details ?? {};
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: promptDetails.cached_tokens,
  };
}

/**
 * Inject Anthropic-specific headers for Anthropic upstreams.
 * - anthropic-version: 2023-06-01 (if not already set)
 * - anthropic-beta: ensures claude-code-20250219 + thinking betas based on model
 */
export function injectAnthropicHeaders(
  headers: Headers,
  model: string,
  thinkingPolicy?: 'preserve' | 'strip' | 'force',
): void {
  if (!headers.has('anthropic-version')) {
    headers.set('anthropic-version', '2023-06-01');
  }

  const existing = headers.get('anthropic-beta') ?? '';
  const betas = new Set(
    existing
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean),
  );
  betas.add('claude-code-20250219');

  const m = (model || '').toLowerCase();
  if (thinkingPolicy === 'preserve' || thinkingPolicy === 'strip') {
    // Explicit body policies suppress automatically selected thinking betas.
  } else if (m.includes('opus-4-7') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    betas.add('context-1m-2025-08-07');
  } else if (!m.includes('haiku')) {
    betas.add('interleaved-thinking-2025-05-14');
  }

  headers.set('anthropic-beta', Array.from(betas).join(', '));
}

/** Strip thinking-related beta flags from anthropic-beta header (for rectifier retry). */
export function stripThinkingBetasFromHeaders(headers: Headers): void {
  const existing = headers.get('anthropic-beta') ?? '';
  const betas = existing
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b && b !== 'interleaved-thinking-2025-05-14' && b !== 'context-1m-2025-08-07');
  if (betas.length === 0) {
    headers.delete('anthropic-beta');
  } else {
    headers.set('anthropic-beta', betas.join(', '));
  }
}

function rateLimitMessage(reason: ReserveResult['reason'] | 'concurrency_exceeded'): string {
  if (reason === 'rpm_exceeded') return 'Requests per minute limit exceeded';
  if (reason === 'daily_tokens_exceeded') return 'Daily token quota exceeded';
  if (reason === 'concurrency_exceeded') return 'Concurrent request limit exceeded';
  return 'Rate limit exceeded';
}

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client_disconnect'));
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

export function retryAfterDelayMs(value: string | null, nowMs = Date.now()): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = value.trim();
  let delay: number;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    delay = Number(trimmed) * 1000;
  } else {
    const date = Date.parse(trimmed);
    delay = Number.isFinite(date) ? Math.max(0, date - nowMs) : DEFAULT_RETRY_AFTER_MS;
  }
  if (!Number.isFinite(delay)) return MAX_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
}

function retryBackoffMs(attempt: number, random: () => number, baseMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

function waitForRetry(ms: number, signal: AbortSignal, deadline: number): Promise<boolean> {
  const remaining = deadline - performance.now();
  if (signal.aborted || remaining <= 0) return Promise.resolve(false);
  if (ms >= remaining)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, remaining);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve(false);
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function keyFromSnapshot(config: Config, raw: string): ProxyKey | undefined {
  const digest = createHash('sha256').update(raw).digest();
  return config.proxyKeys.find((key) => {
    if (key.keyHash) {
      const expected = Buffer.from(key.keyHash, 'hex');
      return expected.length === digest.length && timingSafeEqual(expected, digest);
    }
    return key.key === raw;
  });
}

function concreteModel(model: string): boolean {
  return model.length > 0 && !/[?*]/.test(model);
}

function keyAllowsUpstream(key: ProxyKey, upstream: Config['upstreams'][number]): boolean {
  if (key.allowedUpstreamIds?.length && (!upstream.id || !key.allowedUpstreamIds.includes(upstream.id))) return false;
  if (
    key.allowedUpstreams?.length &&
    !key.allowedUpstreams.includes(upstream.name) &&
    (!upstream.id || !key.allowedUpstreams.includes(upstream.id))
  )
    return false;
  return true;
}

/** Enumerable aliases only; no supplier discovery or runtime health/circuit checks. */
function listedModels(config: Config, snapshot: RoutingSnapshot | undefined, key: ProxyKey): string[] {
  const names = new Set<string>();
  if (snapshot) {
    for (const route of snapshot.routes) {
      if (!route.enabled) continue;
      for (const name of route.publishedModels) {
        if (!concreteModel(name)) continue;
        if (
          route.clientProtocols.some(
            (protocol) =>
              matchRoute(name, protocol, snapshot)?.id === route.id &&
              selectRouteTargets(name, protocol, snapshot, key).some(({ upstream }) =>
                keyAllowsUpstream(key, upstream),
              ),
          )
        ) {
          names.add(name);
        }
      }
    }
  } else {
    for (const upstream of config.upstreams) {
      if (!upstream.enabled || !keyAllowsUpstream(key, upstream)) continue;
      for (const name of [...upstream.models, ...Object.keys(upstream.modelMap ?? {})]) {
        if (
          concreteModel(name) &&
          selectUpstreams(name, config.upstreams, key, config.server.failoverQueue).some(({ upstream: candidate }) =>
            keyAllowsUpstream(key, candidate),
          )
        )
          names.add(name);
      }
    }
  }
  return [...names].sort();
}

export async function proxyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: ConfigStore,
  enqueue: (entry: LogEntry) => void,
  options: ProxyHandlerOptions = {},
): Promise<void> {
  // O4: token usage rides the existing async log pipeline — one metrics
  // accumulation per log entry, skipped when tokens are unknown.
  const enqueueWithMetrics = (entry: LogEntry): void => {
    try {
      if (options.metrics && entry.upstream_name) {
        if (typeof entry.request_tokens === 'number')
          options.metrics.addTokens('input', entry.upstream_name, entry.request_tokens);
        if (typeof entry.response_tokens === 'number')
          options.metrics.addTokens('output', entry.upstream_name, entry.response_tokens);
        if (typeof entry.cache_read_tokens === 'number')
          options.metrics.addTokens('cache_read', entry.upstream_name, entry.cache_read_tokens);
        if (typeof entry.cache_creation_tokens === 'number')
          options.metrics.addTokens('cache_creation', entry.upstream_name, entry.cache_creation_tokens);
      }
    } catch {
      // Metrics isolation: never affect the log write.
    }
    enqueue(entry);
  };
  const startTime = Date.now();
  const monotonicStart = performance.now();
  const elapsedLatencyMs = () => Math.round(Math.max(0, performance.now() - monotonicStart));
  const requestId = randomUUID();
  // The in-process playground response sink is intentionally not a real ServerResponse.
  res.setHeader?.('x-request-id', requestId);
  const limiter = options.limiter;
  const maxBodyBytes = options.maxBodyBytes ?? Number.POSITIVE_INFINITY;

  const reqPath = req.url || '/';

  if (reqPath === '/healthz' || reqPath.startsWith('/healthz?')) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
      return;
    }
    let dbOk = true;
    if (options.healthCheck) {
      try {
        dbOk = await options.healthCheck();
      } catch {
        dbOk = false;
      }
    }
    const recorderOk = options.recorderHealthy?.() ?? true;
    const status = dbOk ? 200 : 503;
    const body = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      telemetryRecorder: recorderOk ? 'ok' : 'degraded',
    };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(JSON.stringify(body));
    }
    return;
  }

  // O4: Prometheus text exposition. Only mounted when the server enables
  // metrics (the registry is absent otherwise); an optional bearer token adds
  // a second gate on top of the listener's bind address.
  if (reqPath === '/metrics' || reqPath.startsWith('/metrics?')) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
      return;
    }
    if (!options.metrics) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }
    if (options.metricsAuthToken !== undefined) {
      const presented = req.headers.authorization;
      if (presented !== `Bearer ${options.metricsAuthToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
    }
    // Circuit gauges are sampled at scrape time from the breaker snapshot —
    // no per-request bookkeeping for this family.
    for (const state of options.circuitBreaker?.snapshot() ?? []) {
      options.metrics.setCircuitState(
        state.upstream,
        state.status === 'closed' ? 0 : state.status === 'half-open' ? 1 : 2,
      );
    }
    const exposition = options.metrics.render();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(method === 'HEAD' ? undefined : exposition);
    return;
  }

  if (reqPath.split('?')[0] === '/v1/models') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ error: { message: 'Method not allowed', type: 'invalid_request_error', code: null } }),
      );
      return;
    }
    const config = store.load();
    const clientIp = getClientIp(req, options.trustProxy ?? false);
    if (options.ipBlocker?.check(clientIp).blocked) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Too many failed authentication attempts', type: 'rate_limit_error', code: null },
        }),
      );
      return;
    }
    const pinnedKeyStore = { getProxyKeyByKey: (raw: string) => keyFromSnapshot(config, raw) } as ConfigStore;
    const auth = authenticateProxyKey(pinnedKeyStore, req);
    if (!auth.ok) {
      options.ipBlocker?.recordFailure(clientIp);
      writeProtocolError(res, 'openai', 401, 'authentication_error', 'Invalid proxy key');
      return;
    }
    options.ipBlocker?.clearSuccess(clientIp);
    const snapshot = config.routes
      ? {
          routes: config.routes,
          upstreams: config.upstreams.filter((item): item is typeof item & { id: string } => !!item.id),
        }
      : options.getRuntimeSnapshot?.();
    const data = listedModels(config, snapshot, auth.key).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'model-router',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }

  const clientPath = (req.url || '/').split('?')[0];
  const clientProto = clientProtocolFromPath(reqPath);
  if (!clientProto) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found_error', code: null } }));
    return;
  }
  // C0 fix: the gemini wire format carries the model and the streaming intent
  // in the URL path (/v1beta/models/{model}:generateContent|streamGenerateContent),
  // never in the body. Extract both so standard Gemini SDK/CLI clients work.
  let geminiPathModel: string | undefined;
  let geminiStreamMode = false;
  if (clientProto === 'gemini') {
    const match = /\/v1beta\/models\/([^/:?]+)(?::(streamGenerateContent|generateContent))?/.exec(reqPath);
    if (match) {
      try {
        geminiPathModel = decodeURIComponent(match[1]!);
      } catch {
        geminiPathModel = undefined;
      }
      geminiStreamMode = match[2] === 'streamGenerateContent';
    }
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ error: { message: 'Method not allowed', type: 'invalid_request_error' } }));
    return;
  }
  // O4: every request past the path/method guards eventually reaches exactly
  // one publishCompletion call (early rejections included), so admission is
  // counted here to keep the in-flight gauge balanced.
  options.metrics?.addInFlight();
  const config = store.load();
  const playground = options.internalPlayground;
  const source = playground ? 'playground' : 'production';
  let requestedModel: string | null = null;
  let finalUpstreamId: string | null = null;
  let completionPublished = false;
  // O4: name of the upstream the request settled on ('none' when none was attempted).
  let lastUpstreamName: string | null = null;
  const publishCompletion = (status: number, outcome: string, durationMs = Date.now() - startTime) => {
    if (completionPublished) return;
    completionPublished = true;
    // O4: one observation per request, on the single completion path.
    try {
      options.metrics?.observeRequest({ proto: clientProto, upstream: lastUpstreamName ?? 'none', status }, durationMs);
      options.metrics?.addInFlight(-1);
    } catch {
      // Metrics must never alter the finalized proxy response.
    }
    const safeModel = requestedModel && /^[A-Za-z0-9_.:/-]{1,200}$/.test(requestedModel) ? requestedModel : null;
    try {
      options.publishEvent?.('request.completed', {
        requestId,
        outcome,
        status,
        model: safeModel,
        protocol: clientProto,
        source,
        durationMs: Math.max(0, durationMs),
        ...(finalUpstreamId ? { finalUpstreamId } : {}),
      });
    } catch {
      // Event delivery must not change the finalized proxy response.
    }
  };
  const pinnedRoutingSnapshot = config.routes
    ? {
        routes: config.routes,
        upstreams: config.upstreams.filter((item): item is typeof item & { id: string } => !!item.id),
      }
    : options.getRuntimeSnapshot?.();
  // Observation failures never change admission, retries, delivery, or settlement. Snapshot now:
  // the request/attempt objects continue changing while the worker batches these events.
  const observeRequest = (record: RequestRecord): void => {
    try {
      void options.telemetryStore?.upsertRequest(structuredClone(record)).catch(() => {});
    } catch {
      /* the recorder exposes loss/degradation separately */
    }
  };
  const observeAttempt = (record: AttemptRecord): void => {
    try {
      void options.telemetryStore?.upsertAttempt(structuredClone(record)).catch(() => {});
    } catch {
      /* a synchronous recorder failure is also isolated */
    }
  };
  const recordEarlyRejection = async (status: number, proxyKeyId: string | null) => {
    const endedAtMs = Date.now();
    observeRequest({
      id: requestId,
      proxyKeyId,
      source,
      clientProtocol: clientProto,
      requestModel: null,
      routeId: null,
      configRevision: config.revision ?? options.configRevision ?? null,
      state: 'rejected',
      finalHttpStatus: status,
      startedAtMs: startTime,
      endedAtMs,
      durationMs: endedAtMs - startTime,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    publishCompletion(status, 'rejected', endedAtMs - startTime);
  };

  const clientIp = playground ? 'internal:playground' : getClientIp(req, options.trustProxy ?? false);
  if (!playground && options.ipBlocker) {
    const block = options.ipBlocker.check(clientIp);
    if (block.blocked) {
      const retryAfterSec = Math.max(1, Math.ceil((block.retryAfterMs ?? 60_000) / 1000));
      const blockBridge = pickBridge(clientProto, clientProto);
      const errEnv = blockBridge.wrapError(429, 'Too many failed authentication attempts');
      res.writeHead(429, {
        'Content-Type': errEnv.contentType,
        'Retry-After': String(retryAfterSec),
      });
      res.end(typeof errEnv.body === 'string' ? errEnv.body : JSON.stringify(errEnv.body));
      await recordEarlyRejection(429, null);
      return;
    }
  }

  const pinnedKeyStore = { getProxyKeyByKey: (raw: string) => keyFromSnapshot(config, raw) } as ConfigStore;
  const selectedKey = playground && config.proxyKeys.find((key) => key.id === playground.keyId);
  const auth = playground
    ? selectedKey?.enabled && (!selectedKey.expiresAt || Date.parse(selectedKey.expiresAt) > Date.now())
      ? { ok: true as const, key: selectedKey, rawAuth: undefined }
      : { ok: false as const }
    : authenticateProxyKey(pinnedKeyStore, req);
  if (!auth.ok) {
    if (!playground) options.ipBlocker?.recordFailure(clientIp);
    writeProtocolError(res, clientProto, 401, 'authentication_error', 'Invalid proxy key');
    await recordEarlyRejection(401, null);
    return;
  }
  if (!playground) options.ipBlocker?.clearSuccess(clientIp);
  const proxyKey = auth.key;
  // O3: per-key IP policy, evaluated after authentication so the rejection is
  // attributable to the key, not the caller's auth. Deny entries win.
  if (!keyIpAllowed(proxyKey, clientIp)) {
    writeProtocolError(res, clientProto, 403, 'forbidden', 'Proxy key is not allowed from this address');
    await recordEarlyRejection(403, (proxyKey as { id?: string }).id ?? proxyKey.name);
    return;
  }
  const proxyKeyName = proxyKey.name;
  const clientAuth = auth.rawAuth;
  const clientBridge = pickBridge(clientProto, clientProto);

  let bodyBuffer: Buffer;
  try {
    bodyBuffer = await collectBody(req, maxBodyBytes);
  } catch (err: any) {
    if (err instanceof BodyTooLargeError) {
      const errEnv = clientBridge.wrapError(413, 'Request body too large');
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': errEnv.contentType });
        res.end(typeof errEnv.body === 'string' ? errEnv.body : JSON.stringify(errEnv.body));
      }
      enqueueWithMetrics({
        proxy_key_name: proxyKeyName,
        client_ip: clientIp,
        client_protocol: clientProto,
        upstream_protocol: null,
        request_model: null,
        actual_model: null,
        upstream_name: null,
        status_code: 413,
        error_message: 'body_too_large',
        request_tokens: null,
        response_tokens: null,
        total_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        first_token_ms: null,
        duration_ms: Date.now() - startTime,
        is_streaming: false,
      });
      await recordEarlyRejection(413, (proxyKey as { id?: string }).id ?? proxyKeyName);
      return;
    }
    throw err;
  }

  let parsedBody: any = null;
  try {
    if (bodyBuffer.length > 0) {
      parsedBody = JSON.parse(bodyBuffer.toString('utf-8'));
    }
  } catch {
    // ignore parse errors
  }
  // C1: multipart media requests (transcriptions/translations) never parse as
  // JSON; routing still needs the model field, so scan it out of the form.
  const isMultipartRequest =
    MULTIPART_REQUEST_PATHS.has(clientPath) &&
    String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
  let multipartModel: string | undefined;
  if (isMultipartRequest) {
    const boundary = multipartBoundary(String(req.headers['content-type'] ?? ''));
    multipartModel = boundary ? (extractMultipartStringField(bodyBuffer, boundary, 'model') ?? undefined) : undefined;
  }

  const model = parsedBody?.model ?? multipartModel ?? geminiPathModel;
  requestedModel = typeof model === 'string' ? model : null;
  const requestRecord: RequestRecord = {
    id: requestId,
    proxyKeyId: (proxyKey as { id?: string }).id ?? proxyKeyName,
    source,
    clientProtocol: clientProto,
    requestModel: typeof model === 'string' ? model : null,
    routeId:
      typeof model === 'string' && pinnedRoutingSnapshot
        ? (resolveRoute(model, clientProto, pinnedRoutingSnapshot).route?.id ?? null)
        : null,
    configRevision: config.revision ?? options.configRevision ?? null,
    state: 'received',
    finalHttpStatus: null,
    startedAtMs: startTime,
    endedAtMs: null,
    durationMs: null,
    firstByteMs: null,
    firstEventMs: null,
    firstTextMs: null,
    finalUpstreamId: null,
  };
  let quotaSettled = false;
  let quotaNeedsSettlement = false;
  let finalQueued = false;
  let reportedAttemptTokens = 0;
  let hasReportedAttemptTokens = false;
  let sentAttempts = 0;
  let reportedAttempts = 0;
  const finishRequest = async (
    status: number,
    upstreamId: string | null,
    usage: TelemetryUsage | null,
    cancelled = false,
  ) => {
    if (requestRecord.endedAtMs === null) {
      requestRecord.state = cancelled
        ? 'cancelled'
        : status >= 200 && status < 300
          ? 'completed'
          : status === 429 || status === 404 || status === 422
            ? 'rejected'
            : 'failed';
      requestRecord.finalHttpStatus = status;
      requestRecord.endedAtMs = Date.now();
      requestRecord.durationMs = requestRecord.endedAtMs - startTime;
      requestRecord.finalUpstreamId = upstreamId;
      finalUpstreamId = upstreamId;
    }
    const errors: unknown[] = [];
    if (options.quotaLedger && quotaNeedsSettlement && !quotaSettled) {
      try {
        await options.quotaLedger?.settle(
          requestId,
          hasReportedAttemptTokens ? reportedAttemptTokens : usage ? confirmedTokens(usage) : null,
          Math.max(0, sentAttempts - reportedAttempts),
        );
        quotaSettled = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!finalQueued) {
      try {
        observeRequest(requestRecord);
        finalQueued = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (finalQueued && requestRecord.endedAtMs !== null) {
      publishCompletion(
        requestRecord.finalHttpStatus ?? status,
        requestRecord.state,
        requestRecord.durationMs ?? undefined,
      );
    }
    if (errors.length) throw new AggregateError(errors, 'Proxy request finalization failed');
  };

  try {
    observeRequest(requestRecord);

    if (playground && (playground.signal.aborted || requestRecord.routeId !== playground.routeId)) {
      const status = playground.signal.aborted ? 499 : 409;
      writeProtocolError(
        res,
        clientProto,
        status,
        'playground_route_changed',
        playground.signal.aborted ? 'Playground run cancelled' : 'Playground route changed',
      );
      await finishRequest(status, null, null, playground.signal.aborted);
      return;
    }

    if (limiter) {
      const reserved = limiter.reserveRequest(proxyKeyName, proxyKey);
      if (!reserved.allowed) {
        const message = rateLimitMessage(reserved.reason);
        const retryAfterSec = Math.max(1, Math.ceil((reserved.retryAfterMs ?? 60_000) / 1000));
        const errEnv = clientBridge.wrapError(429, message);
        res.writeHead(429, {
          'Content-Type': errEnv.contentType,
          'Retry-After': String(retryAfterSec),
        });
        res.end(typeof errEnv.body === 'string' ? errEnv.body : JSON.stringify(errEnv.body));
        enqueueWithMetrics({
          proxy_key_name: proxyKeyName,
          client_ip: clientIp,
          client_protocol: clientProto,
          upstream_protocol: null,
          request_model: model ?? null,
          actual_model: null,
          upstream_name: null,
          status_code: 429,
          error_message: reserved.reason ?? 'rate_limited',
          request_tokens: null,
          response_tokens: null,
          total_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          first_token_ms: null,
          duration_ms: Date.now() - startTime,
          is_streaming: false,
        });
        await finishRequest(429, null, null);
        return;
      }
    }

    const snapshot = pinnedRoutingSnapshot;
    const previousResponseId =
      clientProto === 'responses' && typeof parsedBody?.previous_response_id === 'string'
        ? (parsedBody.previous_response_id as string)
        : undefined;
    const previousOwner =
      previousResponseId && requestRecord.proxyKeyId
        ? options.responseOwnership?.get(previousResponseId, requestRecord.proxyKeyId)
        : undefined;
    if (previousResponseId && !previousOwner) {
      writeProtocolError(
        res,
        clientProto,
        409,
        'response_state_unknown',
        'Previous response is unknown, expired, or belongs to another key',
      );
      await finishRequest(409, null, null);
      return;
    }
    if (previousOwner) {
      const ownedUpstream = config.upstreams.find(
        (upstream) => ((upstream as { id?: string }).id ?? upstream.name) === previousOwner.upstreamId,
      );
      const authorizedOwnedCandidate = model
        ? snapshot
          ? selectRouteTargets(model, clientProto, snapshot, proxyKey)
          : selectUpstreams(model, config.upstreams, proxyKey, config.server.failoverQueue)
        : [];
      if (
        !ownedUpstream ||
        !authorizedOwnedCandidate.some(
          ({ upstream }) => ((upstream as { id?: string }).id ?? upstream.name) === previousOwner.upstreamId,
        )
      ) {
        writeProtocolError(
          res,
          clientProto,
          409,
          'response_route_unavailable',
          'Previous response upstream is not available on this route',
        );
        await finishRequest(409, null, null);
        return;
      }
      const noAuth =
        (ownedUpstream as { authMode?: string }).authMode === 'none' &&
        (ownedUpstream.provider === 'custom-openai' || ownedUpstream.provider === 'custom');
      const usesClientAuth =
        ownedUpstream.passThroughAuth ||
        !!ownedUpstream.oauth ||
        noAuth ||
        (ownedUpstream as { authMode?: string }).authMode === 'pass-through' ||
        (ownedUpstream as { authMode?: string }).authMode === 'oauth';
      const credentialIndex = previousOwner.credentialId
        ? (ownedUpstream.credentialIds?.indexOf(previousOwner.credentialId) ?? -1)
        : -1;
      const configuredCredential =
        credentialIndex >= 0
          ? {
              credentialId: ownedUpstream.credentialIds?.[credentialIndex] ?? '',
              key: ownedUpstream.apiKeys[credentialIndex],
            }
          : undefined;
      options.keyPool?.reconcile(
        ownedUpstream.name,
        ownedUpstream.apiKeys.map((key, index) => ({ credentialId: ownedUpstream.credentialIds?.[index] ?? key, key })),
      );
      const availableCredential =
        configuredCredential &&
        (
          options.keyPool?.getAvailableEntries(ownedUpstream.name) ??
          ownedUpstream.apiKeys.map((key, index) => ({
            credentialId: ownedUpstream.credentialIds?.[index] ?? key,
            key,
          }))
        ).some(
          (entry) => entry.credentialId === configuredCredential.credentialId && entry.key === configuredCredential.key,
        );
      if ((!usesClientAuth && !availableCredential) || (usesClientAuth && previousOwner.credentialId !== null)) {
        writeProtocolError(
          res,
          clientProto,
          409,
          'response_credential_unavailable',
          'Previous response credential is unavailable',
        );
        await finishRequest(409, null, null);
        return;
      }
    }
    const allCandidates = model
      ? snapshot
        ? selectRouteTargets(model, clientProto, snapshot, proxyKey)
        : selectUpstreams(model, config.upstreams, proxyKey, config.server.failoverQueue)
      : [];
    const routedCandidates = previousOwner
      ? allCandidates.filter(
          ({ upstream }) => ((upstream as { id?: string }).id ?? upstream.name) === previousOwner.upstreamId,
        )
      : allCandidates;
    const passThroughTarget =
      playground &&
      routedCandidates.find(
        ({ upstream }) =>
          ((upstream as { id?: string }).id ?? upstream.name) === playground.target.upstreamId &&
          (upstream.passThroughAuth || upstream.authMode === 'pass-through'),
      );
    if (passThroughTarget) {
      writeProtocolError(
        res,
        clientProto,
        422,
        'playground_pass_through_unsupported',
        'Playground cannot use a pass-through upstream without a recoverable client token',
      );
      await finishRequest(422, null, null);
      return;
    }
    const candidates = playground
      ? routedCandidates.filter(({ upstream }) => !upstream.passThroughAuth && upstream.authMode !== 'pass-through')
      : routedCandidates;
    if (
      playground &&
      !candidates.some(
        ({ upstream, resolvedModel }) =>
          ((upstream as { id?: string }).id ?? upstream.name) === playground.target.upstreamId &&
          resolvedModel === playground.target.model,
      )
    ) {
      writeProtocolError(res, clientProto, 409, 'playground_target_changed', 'Playground target changed');
      await finishRequest(409, null, null);
      return;
    }
    if (previousOwner && candidates.length === 0) {
      writeProtocolError(
        res,
        clientProto,
        409,
        'response_route_unavailable',
        'Previous response upstream is not available on this route',
      );
      await finishRequest(409, null, null);
      return;
    }
    const routeResolution = model && snapshot ? resolveRoute(model, clientProto, snapshot) : undefined;
    if (
      snapshot &&
      model &&
      routeResolution?.reason === 'unsupported_client_protocol' &&
      routeHasAuthorizedTarget(model, snapshot, proxyKey)
    ) {
      const message = 'The selected route does not support this client protocol';
      writeProtocolError(res, clientProto, 422, 'unsupported_client_protocol', message);
      enqueueWithMetrics({
        proxy_key_name: proxyKeyName,
        client_ip: clientIp,
        client_protocol: clientProto,
        upstream_protocol: null,
        request_model: model ?? null,
        actual_model: null,
        upstream_name: null,
        status_code: 422,
        error_message: 'unsupported_client_protocol',
        request_tokens: null,
        response_tokens: null,
        total_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        first_token_ms: null,
        duration_ms: Date.now() - startTime,
        is_streaming: false,
      });
      await finishRequest(422, null, null);
      return;
    }
    const protocolCandidates = candidates.filter(({ upstream, resolvedModel }) => {
      const profile = providerProfile(
        (upstream as { presetId?: string }).presetId ?? upstream.provider,
        upstream.protocol,
      );
      if (clientProto === 'responses') {
        if (reqPath.split('?')[0].endsWith('/compact'))
          return profile.nativeResponses && !!(upstream as { compactEndpoint?: string }).compactEndpoint;
        return profile.nativeResponses || (upstream.provider === 'openai' && upstream.protocol === 'openai');
      }
      // Responses-protocol upstreams serve responses clients natively. C0 fix:
      // gemini clients may bridge onto them (GeminiToResponsesBridge exists);
      // the openai/anthropic inbound bridges stay gated until audited.
      if (upstream.protocol === 'responses' && clientProto !== 'gemini') return false;
      if (clientProto === 'gemini' || upstream.protocol === 'gemini') return true;
      if (
        clientProto !== upstream.protocol &&
        JSON.stringify(parsedBody).match(/reasoning_content|redacted_thinking|"type":"thinking"/) &&
        !(
          clientProto === 'openai' &&
          upstream.protocol === 'anthropic' &&
          supportsOpenAIToAnthropicThinkingHistory(parsedBody, {
            provider: upstream.presetId ?? upstream.provider,
            model: resolvedModel,
          })
        )
      )
        return false;
      return true;
    });
    if (candidates.length > 0 && protocolCandidates.length === 0) {
      writeProtocolError(
        res,
        clientProto,
        422,
        'unsupported_capability',
        'No route supports this protocol or reasoning history',
      );
      await finishRequest(422, null, null);
      return;
    }
    const neededCapabilities = activeCapabilities(parsedBody);
    let unverifiedCapability = false;
    const supportedCandidates = protocolCandidates.filter(({ upstream, resolvedModel }) => {
      const capabilities = upstream.modelCapabilities?.[resolvedModel];
      if (!capabilities) return !upstream.modelCapabilities; // Legacy configuration has no capability declaration.
      for (const capability of neededCapabilities) {
        if (capabilities[capability] === 'unknown' || capabilities[capability] === undefined) {
          unverifiedCapability = true;
          return false;
        }
        if (capabilities[capability] === 'unsupported') return false;
      }
      const outputLimit = parsedBody?.max_output_tokens ?? parsedBody?.max_completion_tokens ?? parsedBody?.max_tokens;
      if (typeof outputLimit === 'number' && capabilities.maxOutputTokens && outputLimit > capabilities.maxOutputTokens)
        return false;
      return true;
    });
    if (protocolCandidates.length > 0 && supportedCandidates.length === 0) {
      writeProtocolError(
        res,
        clientProto,
        422,
        unverifiedCapability ? 'capability_unverified' : 'unsupported_capability',
        unverifiedCapability
          ? 'Model capability has not been verified'
          : 'Requested feature is unsupported by all targets',
      );
      await finishRequest(422, null, null);
      return;
    }

    if (candidates.length === 0) {
      const modelExistsForAnyUpstream =
        model !== undefined &&
        (snapshot
          ? selectRouteTargets(model, clientProto, snapshot).length > 0
          : selectUpstreams(model, config.upstreams, undefined, config.server.failoverQueue).length > 0);
      const errMessage = modelExistsForAnyUpstream
        ? 'Model not allowed for this proxy key'
        : 'No available upstream for the requested model';
      writeProtocolError(res, clientProto, 404, 'not_found_error', errMessage);
      enqueueWithMetrics({
        proxy_key_name: proxyKeyName,
        client_ip: clientIp,
        client_protocol: clientProto,
        upstream_protocol: null,
        request_model: model ?? null,
        actual_model: null,
        upstream_name: null,
        status_code: 404,
        error_message: errMessage,
        request_tokens: null,
        response_tokens: null,
        total_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        first_token_ms: null,
        duration_ms: Date.now() - startTime,
        is_streaming: false,
      });
      await finishRequest(404, null, null);
      return;
    }

    const runtimeTimeouts = config.server as Config['server'] &
      Partial<{
        connectTimeoutMs: number;
        firstByteTimeoutMs: number;
        streamIdleTimeoutMs: number;
        totalRequestTimeoutMs: number;
      }>;
    const requestTimeoutMs =
      options.requestTimeoutMs ?? runtimeTimeouts.totalRequestTimeoutMs ?? config.server.requestTimeoutMs ?? 120_000;
    const quotaAttemptReserve = options.quotaLedger
      ? estimateQuotaAttemptReserve(bodyBuffer, parsedBody, options.quotaReserveTokens)
      : 0;
    if (options.quotaLedger) {
      const admissionAtMs = Date.now();
      const versionedPeriod = options.quotaTimezoneVersions?.resolveForAdmission(admissionAtMs);
      const period = versionedPeriod ?? quotaPeriod(admissionAtMs, options.quotaTimezone ?? 'UTC');
      quotaNeedsSettlement = true;
      const decision = await options.quotaLedger.admit({
        requestId,
        newRequest: true,
        proxyKeyId: requestRecord.proxyKeyId!,
        atMs: admissionAtMs,
        periodId: period.id,
        periodStartMs: period.startMs,
        periodEndMs: period.endMs,
        timezoneVersionId: versionedPeriod?.versionId,
        reserveTokens: quotaAttemptReserve,
        dailyTokens: proxyKey.dailyTokens,
        rpm: proxyKey.rpm,
        maxConcurrentRequests: (proxyKey as { maxConcurrentRequests?: number }).maxConcurrentRequests,
        missingUsagePolicy: options.missingUsagePolicy,
        recoveryTimeoutMs: requestTimeoutMs + 60_000,
      });
      if (!decision.allowed) {
        quotaNeedsSettlement = false;
        if (decision.reason === 'recorder_degraded' || decision.reason === 'quota_unavailable') {
          writeProtocolError(res, clientProto, 503, 'service_unavailable', 'Quota ledger is unavailable; retry later');
          await finishRequest(503, null, null);
          return;
        }
        // Mirror the in-memory limiter path: 429s carry a Retry-After hint
        // so API-shaped clients back off instead of hammering the ledger.
        const quotaRetryAfterSec = Math.max(1, Math.ceil((decision.retryAfterMs ?? 60_000) / 1000));
        const quotaErrEnv = clientBridge.wrapError(429, rateLimitMessage(decision.reason));
        res.writeHead(429, {
          'Content-Type': quotaErrEnv.contentType,
          'Retry-After': String(quotaRetryAfterSec),
        });
        res.end(typeof quotaErrEnv.body === 'string' ? quotaErrEnv.body : JSON.stringify(quotaErrEnv.body));
        await finishRequest(429, null, null);
        return;
      }
    }
    requestRecord.state = 'admitted';
    observeRequest(requestRecord);

    const isStreaming = parsedBody?.stream === true || geminiStreamMode;
    const streamIdleTimeoutMs =
      options.streamIdleTimeoutMs ?? runtimeTimeouts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS;
    const connectTimeoutMs = options.connectTimeoutMs ?? runtimeTimeouts.connectTimeoutMs;
    const firstByteTimeoutMs =
      options.firstByteTimeoutMs ??
      runtimeTimeouts.firstByteTimeoutMs ??
      (isStreaming ? streamIdleTimeoutMs : undefined);
    const maxRetries = previousOwner ? 1 : (options.maxRetries ?? config.server.maxRetries ?? 3);
    const deadline = monotonicStart + requestTimeoutMs;

    const abortController = new AbortController();
    const onClientAbort = () => abortController.abort('client_disconnect');
    if (playground?.signal.aborted) abortController.abort('client_disconnect');
    else playground?.signal.addEventListener('abort', onClientAbort, { once: true });
    req.on('aborted', onClientAbort);
    res.on('close', onClientAbort);
    const totalTimer = setTimeout(
      () => abortController.abort('total_request_timeout'),
      Math.max(0, deadline - performance.now()),
    );

    try {
      let totalAttempts = 0;
      let lastFailure: TryResult | undefined;
      let lastAttemptRecord: AttemptRecord | undefined;
      const retryRandom = options.retryRandom ?? Math.random;
      const retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
      const retryMaxDelayMs = options.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS;
      // O2: best-effort stickiness — the candidate the proxy key last used for
      // this model leads the list while it is still serving and healthy.
      const affinityKey =
        options.sessionAffinity && model ? `${(proxyKey as { id?: string }).id ?? proxyKeyName}|${model}` : null;
      const stickyUpstreamName = affinityKey ? options.sessionAffinity!.get(affinityKey) : null;
      if (affinityKey && stickyUpstreamName) {
        const stickyIndex = supportedCandidates.findIndex(({ upstream }) => upstream.name === stickyUpstreamName);
        if (stickyIndex > 0) {
          const [sticky] = supportedCandidates.splice(stickyIndex, 1);
          supportedCandidates.unshift(sticky);
        } else if (stickyIndex < 0) {
          // The sticky upstream no longer serves this model/route: drop the mapping.
          options.sessionAffinity!.remove(affinityKey);
        }
      }
      for (let i = 0; i < supportedCandidates.length; i++) {
        if (abortController.signal.aborted || performance.now() >= deadline) break;
        const { upstream, resolvedModel } = supportedCandidates[i];
        const bridge = pickBridge(clientProto, upstream.protocol, {
          provider: upstream.presetId ?? upstream.provider,
          model: resolvedModel,
        });

        if (options.circuitBreaker && !options.circuitBreaker.allow(upstream.name)) {
          if (i < supportedCandidates.length - 1) continue;
          // All candidates have open circuits — fall through to final 502
          break;
        }

        options.keyPool?.reconcile(
          upstream.name,
          upstream.apiKeys.map((key, i) => ({ credentialId: upstream.credentialIds?.[i] ?? key, key })),
        );
        const rawEntries =
          options.keyPool?.getAvailableEntries(upstream.name) ??
          upstream.apiKeys.map((key, index) => ({
            credentialId: upstream.credentialIds?.[index] ?? key,
            key,
          }));
        const noAuth =
          (upstream as { authMode?: string }).authMode === 'none' &&
          (upstream.provider === 'custom-openai' || upstream.provider === 'custom');
        const usesClientAuth =
          upstream.passThroughAuth ||
          !!upstream.oauth ||
          noAuth ||
          (upstream as { authMode?: string }).authMode === 'pass-through' ||
          (upstream as { authMode?: string }).authMode === 'oauth';
        const ownedCredentialIndex = previousOwner?.credentialId
          ? (upstream.credentialIds?.indexOf(previousOwner.credentialId) ?? -1)
          : -1;
        const ownedEntry =
          ownedCredentialIndex >= 0
            ? {
                credentialId: upstream.credentialIds?.[ownedCredentialIndex] ?? '',
                key: upstream.apiKeys[ownedCredentialIndex],
              }
            : undefined;
        if (
          previousOwner &&
          !usesClientAuth &&
          (!ownedEntry ||
            !rawEntries.some((entry) => entry.credentialId === ownedEntry.credentialId && entry.key === ownedEntry.key))
        ) {
          options.circuitBreaker?.neutralRelease(upstream.name);
          writeProtocolError(
            res,
            clientProto,
            409,
            'response_credential_unavailable',
            'Previous response credential is unavailable',
          );
          await finishRequest(409, null, null);
          return;
        }
        if (rawEntries.length === 0 && !usesClientAuth) {
          options.circuitBreaker?.neutralRelease(upstream.name);
          continue;
        }
        const entriesForUpstream = ownedEntry ? [ownedEntry] : rawEntries.slice();

        const keyCount = usesClientAuth ? 1 : entriesForUpstream.length;

        for (let k = 0; k < keyCount; k++) {
          if (abortController.signal.aborted || performance.now() >= deadline) break;
          if (k > 0 && options.circuitBreaker && !options.circuitBreaker.allow(upstream.name)) break;
          if (totalAttempts >= maxRetries) {
            options.circuitBreaker?.neutralRelease(upstream.name);
            if (!res.headersSent) {
              const err = bridge.wrapError(502, 'Max retries exceeded');
              res.writeHead(502, { 'Content-Type': err.contentType });
              res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
            }
            await finishRequest(502, null, null);
            return;
          }
          totalAttempts += 1;

          const credentialEntry = usesClientAuth
            ? undefined
            : ownedEntry
              ? ownedEntry
              : options.keyPool
                ? (options.keyPool.pickEntry(upstream.name) ?? undefined)
                : entriesForUpstream[k % entriesForUpstream.length];
          const key = usesClientAuth ? '' : credentialEntry?.key;
          if (!usesClientAuth && !key) {
            options.circuitBreaker?.neutralRelease(upstream.name);
            break;
          }
          if (options.quotaLedger && totalAttempts > 1) {
            if (!options.quotaLedger.topUp) throw new Error('quota top-up unavailable');
            const topUp = await options.quotaLedger.topUp(
              requestId,
              quotaAttemptReserve,
              proxyKey.dailyTokens,
              reportedAttemptTokens,
            );
            if (!topUp.allowed) {
              options.circuitBreaker?.neutralRelease(upstream.name);
              if (topUp.reason === 'recorder_degraded' || topUp.reason === 'quota_unavailable') {
                writeProtocolError(
                  res,
                  clientProto,
                  503,
                  'service_unavailable',
                  'Quota ledger is unavailable; retry later',
                );
                await finishRequest(503, null, null);
                return;
              }
              writeProtocolError(res, clientProto, 429, 'rate_limit_error', rateLimitMessage(topUp.reason));
              await finishRequest(429, null, null);
              return;
            }
          }
          const apiKey = key ?? '';
          const credentialId = credentialEntry
            ? (upstream.credentialIds?.find(
                (id, index) => id === credentialEntry.credentialId && upstream.apiKeys[index] === credentialEntry.key,
              ) ?? null)
            : null;
          let tryStart = Date.now();
          const createAttempt = (): AttemptRecord => ({
            id: randomUUID(),
            requestId,
            ordinal: totalAttempts,
            upstreamId: (upstream as { id?: string }).id ?? upstream.name,
            credentialId: usesClientAuth ? null : credentialId,
            resolvedModel,
            reportedModel: null,
            protocol: upstream.protocol,
            outcome: 'started',
            status: null,
            retryReason: null,
            startedAtMs: tryStart,
            endedAtMs: null,
            usage: null,
            pricingVersion: null,
            costMicros: null,
            currency: null,
          });
          let attemptRecord = createAttempt();
          observeAttempt(attemptRecord);
          lastAttemptRecord = attemptRecord;
          const finishAttempt = async (result: TryResult) => {
            const simpleUsage =
              result.usage ??
              (result.usagePromise
                ? await result.usagePromise.catch(() => ({}) as NonNullable<TryResult['usage']>)
                : undefined);
            const telemetryUsage =
              result.rawUsage !== undefined
                ? normalizeTelemetryUsage(upstream.protocol, result.rawUsage, {
                    inputIncludesCache: upstream.inputIncludesCache,
                    provider:
                      upstream.provider === 'deepseek'
                        ? 'deepseek'
                        : upstream.provider.startsWith('kimi')
                          ? 'kimi'
                          : 'custom',
                  })
                : upstream.protocol === 'anthropic'
                  ? normalizeTelemetryUsage(
                      'anthropic',
                      simpleUsage
                        ? {
                            input_tokens: simpleUsage.inputTokens,
                            output_tokens: simpleUsage.outputTokens,
                            cache_read_input_tokens: simpleUsage.cacheReadTokens,
                            cache_creation_input_tokens: simpleUsage.cacheCreationTokens,
                          }
                        : {},
                      { inputIncludesCache: upstream.inputIncludesCache },
                    )
                  : normalizeTelemetryUsage(
                      'openai',
                      simpleUsage
                        ? {
                            prompt_tokens: simpleUsage.inputTokens,
                            completion_tokens: simpleUsage.outputTokens,
                            prompt_tokens_details: { cached_tokens: simpleUsage.cacheReadTokens },
                          }
                        : {},
                    );
            attemptRecord.outcome = result.ok ? 'completed' : result.statusCode === 499 ? 'cancelled' : 'failed';
            attemptRecord.status = result.statusCode ?? null;
            attemptRecord.retryReason = result.ok
              ? null
              : (result.failureReason ?? (result.shouldRetry ? 'retryable_upstream_error' : null));
            attemptRecord.endedAtMs = Date.now();
            attemptRecord.usage = telemetryUsage;
            if (options.priceAttempt) {
              const cost = options.priceAttempt(telemetryUsage, {
                upstreamId: attemptRecord.upstreamId,
                provider: upstream.provider,
                presetId: upstream.presetId,
                model: resolvedModel,
                atMs: tryStart,
              });
              attemptRecord.pricingVersion = cost.pricingVersion;
              attemptRecord.costMicros = cost.costMicros;
              attemptRecord.currency = cost.currency;
            }
            // Persist the terminal observation even if durable quota usage
            // tracking fails. The caller must not finalize this attempt twice.
            observeAttempt(attemptRecord);
            const charged = confirmedTokens(telemetryUsage);
            if (charged !== null) {
              reportedAttemptTokens += charged;
              hasReportedAttemptTokens = true;
              reportedAttempts++;
              await options.quotaLedger?.recordAttemptUsage?.(requestId, attemptRecord.id, charged);
            }

            return telemetryUsage;
          };
          // O4: the request settles on this upstream for metrics attribution.
          lastUpstreamName = upstream.name;
          const result = await trySingleUpstream({
            req,
            res,
            parsedBody,
            rawRequestBytes: isMultipartRequest ? bodyBuffer : undefined,
            resolvedModel,
            upstream: {
              name: upstream.name,
              baseUrl: upstream.baseUrl,
              protocol: upstream.protocol,
              authMode: upstream.authMode,
              authHeaderName: upstream.authHeaderName,
              copilotOptimized: upstream.copilotOptimized,
              passThroughAuth: upstream.passThroughAuth,
              oauth: upstream.oauth,
              bedrock: upstream.bedrock,
              vertex: upstream.vertex,
              provider: upstream.provider,
              presetId: (upstream as { presetId?: string }).presetId,
              endpoint: (upstream as { endpoint?: string }).endpoint,
              compactEndpoint: (upstream as { compactEndpoint?: string }).compactEndpoint,
              inputIncludesCache: upstream.inputIncludesCache,
              thinkingPolicy: upstream.thinkingPolicy,
              requestStreamUsage: upstream.requestStreamUsage,
              autoCacheControl: upstream.autoCacheControl,
              anthropicBetas: upstream.anthropicBetas,
              anthropicVersion: upstream.anthropicVersion,
            },
            apiKey,
            clientAuth,
            bridge,
            isStreaming,
            signal: abortController.signal,
            streamIdleTimeoutMs,
            connectTimeoutMs,
            firstByteTimeoutMs,
            elapsedMs: elapsedLatencyMs,
            oauthResolver: options.oauthResolver,
            providerTransports: options.providerTransports,
            onCorrectiveRetry: async (previous) => {
              if (totalAttempts >= maxRetries || abortController.signal.aborted || performance.now() >= deadline) {
                return { ...previous, shouldRetry: false, failureReason: 'corrective_retry_budget_exhausted' };
              }
              await finishAttempt({ ...previous, failureReason: 'thinking_corrective_retry' });
              totalAttempts += 1;
              tryStart = Date.now();
              attemptRecord = createAttempt();
              observeAttempt(attemptRecord);
              lastAttemptRecord = attemptRecord;
              if (options.quotaLedger) {
                try {
                  if (!options.quotaLedger.topUp) throw new Error('quota top-up unavailable');
                  const topUp = await options.quotaLedger.topUp(
                    requestId,
                    quotaAttemptReserve,
                    proxyKey.dailyTokens,
                    reportedAttemptTokens,
                  );
                  if (!topUp.allowed) {
                    const unavailable = topUp.reason === 'recorder_degraded' || topUp.reason === 'quota_unavailable';
                    return {
                      ok: false,
                      shouldRetry: false,
                      statusCode: unavailable ? 503 : 429,
                      errorMessage: unavailable
                        ? 'Quota ledger is unavailable; retry later'
                        : rateLimitMessage(
                            topUp.reason === 'recorder_degraded' || topUp.reason === 'quota_unavailable'
                              ? undefined
                              : topUp.reason,
                          ),
                      failureReason: 'corrective_retry_quota_rejected',
                    };
                  }
                } catch {
                  // A new attempt is already observed; return a terminal failure
                  // through its normal finalizer, without another network send.
                  return {
                    ok: false,
                    shouldRetry: false,
                    statusCode: 503,
                    errorMessage: 'Quota ledger is unavailable; retry later',
                    failureReason: 'corrective_retry_quota_unavailable',
                  };
                }
              }
              return undefined;
            },
            onAttemptSent: async () => {
              await options.quotaLedger?.markAttemptSent(requestId, attemptRecord.id);
              sentAttempts++;
            },
          });

          const telemetryUsage = await finishAttempt(result);

          if (requestRecord.firstByteMs === null && result.firstByteMs !== undefined)
            requestRecord.firstByteMs = result.firstByteMs;
          if (requestRecord.firstEventMs === null && result.firstEventMs !== undefined)
            requestRecord.firstEventMs = result.firstEventMs;
          if (requestRecord.firstTextMs === null && result.firstTextMs !== undefined)
            requestRecord.firstTextMs = result.firstTextMs;

          if (result.ok) {
            // O2: a served request renews the sticky mapping.
            if (affinityKey && lastUpstreamName) options.sessionAffinity?.set(affinityKey, lastUpstreamName);
            if (clientProto === 'responses' && result.responseId && options.responseOwnership) {
              options.responseOwnership.put({
                responseId: result.responseId,
                proxyKeyId: requestRecord.proxyKeyId!,
                upstreamId: (upstream as { id?: string }).id ?? upstream.name,
                credentialId: attemptRecord.credentialId,
                expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
              });
            }
            options.circuitBreaker?.reportSuccess(upstream.name);
            if (!usesClientAuth) {
              if (credentialEntry) options.keyPool?.markSuccess(upstream.name, credentialEntry);
            }
            if (isStreaming && result.usagePromise) {
              if (limiter)
                limiter.recordUsage(proxyKeyName, telemetryUsage.inputTotal ?? 0, telemetryUsage.outputTotal ?? 0);
              enqueueWithMetrics({
                proxy_key_name: proxyKeyName,
                client_ip: clientIp,
                client_protocol: clientProto,
                upstream_protocol: upstream.protocol,
                request_model: model,
                actual_model: resolvedModel,
                upstream_name: upstream.name,
                status_code: result.statusCode ?? 200,
                error_message: null,
                request_tokens: telemetryUsage.inputTotal,
                response_tokens: telemetryUsage.outputTotal,
                total_tokens: confirmedTokens(telemetryUsage),
                cache_read_tokens: telemetryUsage.cacheRead,
                cache_creation_tokens: telemetryUsage.cacheWrite,
                first_token_ms: result.firstTextMs ?? null,
                duration_ms: Date.now() - startTime,
                is_streaming: true,
              });
            } else if (!isStreaming) {
              if (limiter) {
                limiter.recordUsage(proxyKeyName, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);
              }
              enqueueWithMetrics({
                proxy_key_name: proxyKeyName,
                client_ip: clientIp,
                client_protocol: clientProto,
                upstream_protocol: upstream.protocol,
                request_model: model,
                actual_model: resolvedModel,
                upstream_name: upstream.name,
                status_code: result.statusCode ?? 200,
                error_message: null,
                request_tokens: result.usage?.inputTokens ?? null,
                response_tokens: result.usage?.outputTokens ?? null,
                total_tokens:
                  result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined
                    ? result.usage.inputTokens + result.usage.outputTokens
                    : null,
                cache_read_tokens: result.usage?.cacheReadTokens ?? null,
                cache_creation_tokens: result.usage?.cacheCreationTokens ?? null,
                first_token_ms: null,
                duration_ms: Date.now() - startTime,
                is_streaming: false,
              });
            }
            await finishRequest(result.statusCode ?? 200, attemptRecord.upstreamId, telemetryUsage);
            return;
          }
          lastFailure = result;
          // O2: the sticky upstream failed — clear the mapping so the next
          // request drifts to another candidate.
          if (affinityKey && stickyUpstreamName && upstream.name === stickyUpstreamName) {
            options.sessionAffinity?.remove(affinityKey);
          }

          // Once any response bytes or headers are visible to the client, this
          // response belongs to this upstream. Never append another attempt.
          if (result.responseCommitted || res.headersSent) {
            const status = result.statusCode ?? res.statusCode ?? 502;
            await finishRequest(status, attemptRecord.upstreamId, telemetryUsage, status === 499);
            return;
          }

          if (!usesClientAuth && result.statusCode === 429) {
            if (credentialEntry)
              options.keyPool?.markCooldown(
                upstream.name,
                credentialEntry,
                result.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
              );
          } else if (!usesClientAuth && statusNeedsKeyCooldown(result.statusCode)) {
            if (credentialEntry) options.keyPool?.markFailure(upstream.name, credentialEntry);
          }

          const duration = Date.now() - tryStart;
          const shouldRetry = result.shouldRetry ?? false;
          const status = result.statusCode ?? 502;

          if (shouldRetry && (status >= 500 || status === 502)) {
            options.circuitBreaker?.reportFailure(upstream.name);
          } else {
            options.circuitBreaker?.neutralRelease(upstream.name);
          }

          enqueueWithMetrics({
            proxy_key_name: proxyKeyName,
            client_ip: clientIp,
            client_protocol: clientProto,
            upstream_protocol: upstream.protocol,
            request_model: model,
            actual_model: resolvedModel,
            upstream_name: upstream.name,
            status_code: status,
            error_message: redactSecrets(result.errorMessage ?? null),
            request_tokens: null,
            response_tokens: null,
            total_tokens: null,
            cache_read_tokens: null,
            cache_creation_tokens: null,
            first_token_ms: null,
            duration_ms: duration,
            is_streaming: isStreaming,
          });

          if (!shouldRetry) {
            if (!res.headersSent) {
              const err = bridge.wrapError(status, result.errorMessage || 'Upstream error');
              res.writeHead(status, { 'Content-Type': err.contentType });
              res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
            }
            await finishRequest(status, attemptRecord.upstreamId, telemetryUsage, status === 499);
            return;
          }

          if (status === 429) {
            // Retry-After applies to this credential. Move directly to an independent upstream.
            break;
          }

          const backoffMs = retryBackoffMs(totalAttempts, retryRandom, retryBaseDelayMs, retryMaxDelayMs);
          if (backoffMs > 0 && !(await waitForRetry(backoffMs, abortController.signal, deadline))) break;

          // Try next key for same upstream
        }

        if (i < supportedCandidates.length - 1) continue;
      }

      if (!res.headersSent) {
        if (!abortController.signal.aborted && performance.now() >= deadline) {
          abortController.abort('total_request_timeout');
        }
        if (abortController.signal.aborted) {
          const cancelled = abortController.signal.reason === 'client_disconnect';
          if (
            !cancelled &&
            lastAttemptRecord &&
            lastAttemptRecord.outcome === 'failed' &&
            lastAttemptRecord.retryReason !== 'total_request_timeout'
          ) {
            // The shared total deadline ended the retry chain outside an in-flight
            // attempt (e.g. while waiting out the bounded backoff), so the last
            // recorded attempt still carries its own retryable failure reason.
            // Mark the chain's terminal cause so the attempt trail matches the
            // 504 timeout the client actually receives; the attempt's own status
            // (e.g. 503) is preserved on the same record.
            lastAttemptRecord.retryReason = 'total_request_timeout';
            observeAttempt(lastAttemptRecord);
          }
          writeProtocolError(
            res,
            clientProto,
            cancelled ? 499 : 504,
            cancelled ? 'client_disconnect' : 'timeout_error',
            String(abortController.signal.reason),
          );
          await finishRequest(cancelled ? 499 : 504, null, null, cancelled);
          return;
        }
        const lastBridge = pickBridge(
          clientProto,
          supportedCandidates[supportedCandidates.length - 1].upstream.protocol,
        );
        const finalStatus = lastFailure?.statusCode ?? 502;
        const err = lastBridge.wrapError(finalStatus, lastFailure?.errorMessage ?? 'All upstreams failed');
        res.writeHead(finalStatus, { 'Content-Type': err.contentType });
        res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
      }
      await finishRequest(lastFailure?.statusCode ?? 502, null, null);
    } finally {
      clearTimeout(totalTimer);
      playground?.signal.removeEventListener('abort', onClientAbort);
      req.off('aborted', onClientAbort);
      res.off('close', onClientAbort);
    }
  } catch (error) {
    console.error('Proxy request operation failed:', error);
    const cancelled = res.destroyed && !res.writableEnded;
    const status = cancelled ? 499 : res.headersSent ? res.statusCode : 503;
    try {
      await finishRequest(status, requestRecord.finalUpstreamId, null, cancelled);
    } catch (finalizationError) {
      console.error('Proxy request finalization retry failed:', finalizationError);
    }
    if (!res.headersSent && !res.destroyed) {
      writeProtocolError(res, clientProto, 503, 'internal_error', 'Proxy temporarily unavailable');
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

interface TryResult {
  ok: boolean;
  responseId?: string;
  responseCommitted?: boolean;
  shouldRetry?: boolean;
  statusCode?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  rawUsage?: unknown;
  errorMessage?: string;
  usagePromise?: Promise<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }>;
  firstByteMs?: number;
  firstEventMs?: number;
  firstTextMs?: number;
  failureReason?: string;
  retryAfterMs?: number;
}

async function readJsonWithFirstByte(response: Response, onFirstByte: () => void): Promise<any> {
  if (!response.body) throw new Error('missing_response_body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        onFirstByte();
        chunks.push(Buffer.from(value));
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Tracks complete client-visible SSE events, not arbitrary transport chunks or heartbeats. */
function streamTimings(clientProto: Protocol, elapsedMs: () => number) {
  const decoder = new TextDecoder();
  let pending = '';
  let dataLines: string[] = [];
  let eventName = '';
  let eventBytes = 0;
  let discardEvent = false;
  let firstEventMs: number | undefined;
  let firstTextMs: number | undefined;
  const completeEvent = () => {
    const data = dataLines.join('\n');
    dataLines = [];
    const namedEvent = eventName;
    eventName = '';
    eventBytes = 0;
    if (discardEvent) {
      discardEvent = false;
      return;
    }
    if (!data || data === '[DONE]') return;
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (firstEventMs === undefined) firstEventMs = elapsedMs();
    if (firstTextMs !== undefined) return;
    let text: unknown;
    if (clientProto === 'openai')
      text = payload.choices?.find(
        (choice: any) => typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0,
      )?.delta?.content;
    else if (
      clientProto === 'anthropic' &&
      payload.type === 'content_block_delta' &&
      payload.delta?.type === 'text_delta'
    )
      text = payload.delta.text;
    else if (clientProto === 'responses' && (payload.type ?? namedEvent) === 'response.output_text.delta')
      text = payload.delta;
    if (typeof text === 'string' && text.length > 0) firstTextMs = elapsedMs();
  };
  const feed = (value: Uint8Array) => {
    pending += decoder.decode(value, { stream: true });
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!line) completeEvent();
      else if (line.startsWith('data:') && !discardEvent) {
        const value = line.slice(5).trimStart();
        eventBytes += value.length;
        if (eventBytes > 65_536) {
          dataLines = [];
          discardEvent = true;
        } else dataLines.push(value);
      } else if (line.startsWith('event:')) eventName = line.slice(6).trimStart();
    }
    // A malformed unbounded SSE line must not become an unbounded metrics buffer.
    if (pending.length > 65_536) {
      pending = '';
      dataLines = [];
      discardEvent = true;
    }
  };
  return {
    feed,
    get firstEventMs() {
      return firstEventMs;
    },
    get firstTextMs() {
      return firstTextMs;
    },
  };
}

async function trySingleUpstream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedBody: any;
  /** Collected raw request bytes; set for multipart media requests so the body forwards opaquely. */
  rawRequestBytes?: Buffer;
  resolvedModel: string;
  upstream: {
    name: string;
    baseUrl: string;
    protocol: Protocol;
    authMode?: 'bearer' | 'x-api-key' | 'custom-header' | 'google' | 'none' | 'pass-through' | 'oauth';
    authHeaderName?: string;
    copilotOptimized?: boolean;
    passThroughAuth?: boolean;
    oauth?: OAuthConfig;
    bedrock?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string };
    vertex?: { serviceAccountJson: string; location?: string };
    provider: string;
    presetId?: string;
    endpoint?: string;
    compactEndpoint?: string;
    inputIncludesCache?: boolean;
    thinkingPolicy?: 'preserve' | 'strip' | 'force';
    requestStreamUsage?: boolean;
    autoCacheControl?: boolean;
    anthropicBetas?: string[];
    anthropicVersion?: string;
  };
  apiKey: string;
  clientAuth?: string;
  bridge: Bridge;
  isStreaming: boolean;
  signal: AbortSignal;
  streamIdleTimeoutMs: number;
  connectTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  elapsedMs: () => number;
  oauthResolver?: OAuthTokenResolver;
  providerTransports?: { bedrock?: ProviderTransportProfile; vertex?: ProviderTransportProfile };
  onAttemptSent?: () => Promise<void> | void;
  onCorrectiveRetry?: (previous: TryResult) => Promise<TryResult | undefined>;
}): Promise<TryResult> {
  const {
    req,
    res,
    parsedBody,
    rawRequestBytes,
    resolvedModel,
    upstream,
    apiKey,
    clientAuth,
    bridge,
    isStreaming,
    signal: parentSignal,
    streamIdleTimeoutMs,
    connectTimeoutMs,
    firstByteTimeoutMs,
    elapsedMs,
    oauthResolver,
    onAttemptSent,
    onCorrectiveRetry,
    providerTransports,
  } = options;

  const localCtl = new AbortController();
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let phase: string | undefined;
  const stopPhase = () => {
    if (phaseTimer) clearTimeout(phaseTimer);
    phaseTimer = undefined;
  };
  const startPhase = (name: string, ms: number | undefined) => {
    stopPhase();
    if (ms === undefined) return;
    phaseTimer = setTimeout(() => {
      phase = name;
      localCtl.abort(name);
    }, ms);
  };
  const onParentAbort = () => localCtl.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    localCtl.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const cleanupSignal = () => {
    stopPhase();
    parentSignal.removeEventListener('abort', onParentAbort);
  };
  const failure = (error?: unknown, retry = true): TryResult => {
    const reason = parentSignal.aborted ? String(parentSignal.reason) : phase;
    const cancelled = reason === 'client_disconnect';
    return {
      ok: false,
      shouldRetry: retry && !parentSignal.aborted,
      statusCode: cancelled ? 499 : reason ? 504 : 502,
      errorMessage: reason ?? (error instanceof Error ? error.message : 'upstream_error'),
      failureReason: reason,
    };
  };

  const clientPath = (req.url || '/').split('?')[0];
  const profile = providerProfile(upstream.presetId ?? upstream.provider, upstream.protocol);
  const mediaEndpoint = MEDIA_ENDPOINTS[clientPath];
  const isMultipartRequest =
    MULTIPART_REQUEST_PATHS.has(clientPath) &&
    String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
  // C3b: a declared Bedrock/Vertex credential block activates its transport
  // profile (SigV4 / SA-token auth, provider URL shapes, eventstream decode).
  // Scoped to anthropic-protocol upstreams: Claude-on-Bedrock/Vertex is the
  // covered path; other protocol/transport combinations fail closed below.
  const transport: ProviderTransportProfile | undefined = upstream.bedrock
    ? (options.providerTransports?.bedrock ?? bedrockTransportProfile)
    : upstream.vertex
      ? (options.providerTransports?.vertex ?? vertexTransportProfile)
      : undefined;
  if (transport && upstream.protocol !== 'anthropic') {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 422, errorMessage: 'unsupported_capability' };
  }
  const providerSettings = {
    apiKey: apiKey || undefined,
    ...(upstream.bedrock
      ? {
          awsAccessKeyId: upstream.bedrock.accessKeyId,
          awsSecretAccessKey: upstream.bedrock.secretAccessKey,
          ...(upstream.bedrock.sessionToken ? { awsSessionToken: upstream.bedrock.sessionToken } : {}),
          awsRegion: upstream.bedrock.region,
        }
      : {}),
    ...(upstream.vertex
      ? {
          serviceAccountJson: upstream.vertex.serviceAccountJson,
          ...(upstream.vertex.location ? { vertexLocation: upstream.vertex.location } : {}),
        }
      : {}),
  };
  const configuredCompactEndpoint = upstream.compactEndpoint;
  if (clientPath === '/v1/responses/compact' && (!profile.nativeResponses || !configuredCompactEndpoint)) {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 422, errorMessage: 'unsupported_capability' };
  }
  // R2: embeddings is OpenAI-family only; an upstream outside the family can
  // never serve it, so fail closed instead of bridging.
  if (clientPath === '/v1/embeddings' && upstream.protocol !== 'openai') {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 422, errorMessage: 'unsupported_capability' };
  }
  // C1/C2: media endpoints stay same-family only (openai family; count_tokens
  // is anthropic-native). Cross-protocol bridging for media shapes is out of
  // scope: fail closed like embeddings rather than half-bridge a payload.
  if (mediaEndpoint && upstream.protocol !== mediaEndpoint.requiredUpstream) {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 422, errorMessage: 'unsupported_capability' };
  }
  const compactEndpoint = configuredCompactEndpoint ?? '';
  const endpoint =
    mediaEndpoint?.endpoint ??
    (clientPath === '/v1/responses/compact'
      ? compactEndpoint
      : clientPath === '/v1/responses'
        ? (upstream.endpoint ?? 'responses')
        : clientPath === '/v1/embeddings'
          ? 'embeddings'
          : (upstream.endpoint ?? profile.endpoint));
  let upstreamUrl: URL;
  try {
    if (transport) {
      // C3b: the transport owns the URL shape (Bedrock invoke paths, Vertex
      // rawPredict paths) — model and streaming intent ride the URL.
      upstreamUrl = new URL(
        transport.buildUrl({
          baseUrl: upstream.baseUrl,
          endpoint: isStreaming ? 'messages-stream' : 'messages',
          model: resolvedModel,
          stream: isStreaming,
          upstream: providerSettings,
        }),
      );
    } else if (upstream.protocol === 'gemini') {
      // C0 fix: gemini upstreams address the model and the action in the URL
      // path (`:generateContent` / `:streamGenerateContent`), which is outside
      // joinApiUrl's fixed-endpoint charset. resolvedModel keeps modelMap
      // rewrites effective; isStreaming already folds the client's URL action
      // (gemini), body `stream` (openai/anthropic), or multipart default.
      upstreamUrl = appendUpstreamPath(
        upstream.baseUrl,
        `/v1beta/models/${encodeURIComponent(resolvedModel)}:${
          isStreaming ? 'streamGenerateContent?alt=sse' : 'generateContent'
        }`,
      );
    } else {
      // Legacy bases without an API prefix retain their old /v1 target.
      const basePath = new URL(upstream.baseUrl).pathname;
      const legacyBase = (upstream.provider === 'openai' || upstream.provider === 'anthropic') && basePath === '/';
      upstreamUrl = joinApiUrl(upstream.baseUrl, legacyBase ? `v1/${endpoint}` : endpoint);
    }
  } catch {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 502, errorMessage: 'Invalid upstream URL' };
  }
  if (upstream.authMode === 'custom-header' && !validCustomAuthHeader(upstream.authHeaderName)) {
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: 502, errorMessage: 'Invalid upstream authentication header' };
  }

  // C1: multipart media requests are opaque to the proxy — the body (and its
  // boundary-bearing Content-Type, forwarded by the header copy below) go to
  // the upstream byte-for-byte. No preprocess, no bridge, no JSON round-trip.
  // preprocessedBody stays null on that path; the anthropic-only rectifiers
  // below can never run against a multipart request (media gate = openai).
  let preprocessedBody: any = null;
  let upstreamBodyBytes: Buffer;
  if (isMultipartRequest && rawRequestBytes) {
    upstreamBodyBytes = rawRequestBytes;
  } else {
    // C0 fix: gemini-inbound bridges keep their internal state (target model,
    // streaming flag) on the bridge instance and initialize it from the client
    // URL path. The path rewrite itself is not used here — endpoint inference
    // above already resolves the upstream path — only the state side effect.
    if (bridge.clientProto === 'gemini' && upstream.protocol !== 'gemini') {
      bridge.rewriteUrlPath(clientPath);
    }
    preprocessedBody = preprocessRequest(parsedBody ?? {}, upstream.protocol, resolvedModel, profile, {
      thinking: upstream.thinkingPolicy,
      autoCacheControl: upstream.autoCacheControl,
    });
    if (upstream.copilotOptimized) {
      optimizeCopilotBody(preprocessedBody);
    }
    let transformedBody: any;
    try {
      transformedBody = bridge.transformRequest(preprocessedBody);
    } catch (error) {
      if (!(error instanceof BridgeToolChoiceSelectionError)) {
        // C0 fix: a bridge rejecting a field it cannot translate is a client
        // request problem (422), not an internal error (503).
        if (error instanceof UnsupportedBridgeFeatureError) {
          cleanupSignal();
          return { ok: false, shouldRetry: false, statusCode: 422, errorMessage: error.message };
        }
        throw error;
      }
      cleanupSignal();
      return { ok: false, shouldRetry: false, statusCode: 400, errorMessage: error.message };
    }
    if (transformedBody && typeof transformedBody === 'object') {
      transformedBody.model = resolvedModel;
      if (upstream.protocol === 'openai' && isStreaming && upstream.requestStreamUsage !== undefined) {
        const streamOptions = transformedBody.stream_options;
        if (upstream.requestStreamUsage) {
          transformedBody.stream_options = {
            ...(streamOptions && typeof streamOptions === 'object' ? streamOptions : {}),
            include_usage: true,
          };
        } else if (streamOptions && typeof streamOptions === 'object') {
          delete streamOptions.include_usage;
          if (Object.keys(streamOptions).length === 0) delete transformedBody.stream_options;
        }
      }
    }
    // C3b: transport-level wire transforms (Bedrock drops `model` and injects
    // anthropic_version in the body; Vertex injects its own version marker).
    // Copy-on-write after the bridge transform: the input body is never mutated.
    if (transport?.transformRequestBody && transformedBody && typeof transformedBody === 'object') {
      const transportBody = transport.transformRequestBody(transformedBody, {
        endpoint: isStreaming ? 'messages-stream' : 'messages',
        model: resolvedModel,
        stream: isStreaming,
      });
      if (transportBody) transformedBody = transportBody;
    }
    upstreamBodyBytes = Buffer.from(JSON.stringify(transformedBody), 'utf-8');
  }

  let upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (
      key === 'host' ||
      key === 'authorization' ||
      key === 'x-api-key' ||
      key === 'content-length' ||
      key === 'content-encoding' ||
      key === 'accept-encoding' ||
      key === 'connection' ||
      key === 'cookie' ||
      key === 'proxy-authorization' ||
      key === 'transfer-encoding' ||
      key === 'x-goog-api-key' ||
      (upstream.authMode === 'custom-header' && key.toLowerCase() === upstream.authHeaderName!.toLowerCase())
    )
      continue;
    if (Array.isArray(value)) {
      for (const v of value) upstreamHeaders.append(key, v);
    } else {
      upstreamHeaders.set(key, value);
    }
  }
  if (upstream.copilotOptimized) {
    optimizeCopilotHeaders(preprocessedBody, upstreamHeaders);
  }

  if (transport) {
    // C3b: the transport owns authentication — SigV4 (Bedrock, complete
    // signed header set) or a minted service-account OAuth token (Vertex).
    let transportHeaders: Readonly<Record<string, string>>;
    try {
      transportHeaders = await transport.buildAuth(providerSettings, {
        method: req.method ?? 'POST',
        url: upstreamUrl.toString(),
        body: upstreamBodyBytes,
        headers: {
          accept:
            upstreamHeaders.get('accept') ??
            (transport.id === 'bedrock' && isStreaming ? 'application/vnd.amazon.eventstream' : 'application/json'),
          'content-type': upstreamHeaders.get('content-type') ?? 'application/json',
        },
      });
    } catch (error) {
      const result = failure(error);
      cleanupSignal();
      return result;
    }
    if (transport.ownsHeaders) {
      // Bedrock signs a complete set; forwarding anything else breaks the
      // signature. The dispatch's accept/content-type choices already rode
      // the signed set via buildAuth's input.
      upstreamHeaders = new Headers();
    }
    for (const [key, value] of Object.entries(transportHeaders)) upstreamHeaders.set(key, value);
  } else if (
    upstream.authMode === 'none' &&
    (upstream.provider === 'custom-openai' || upstream.provider === 'custom')
  ) {
    // Explicitly unauthenticated local/custom service.
  } else if ((upstream.passThroughAuth || upstream.authMode === 'pass-through') && clientAuth) {
    if (upstream.authMode === 'x-api-key') {
      const token = clientAuth.startsWith('Bearer ') ? clientAuth.slice(7) : clientAuth;
      upstreamHeaders.set('x-api-key', token);
    } else if (upstream.authMode === 'google') {
      const token = clientAuth.startsWith('Bearer ') ? clientAuth.slice(7) : clientAuth;
      upstreamHeaders.set('x-goog-api-key', token);
    } else {
      upstreamHeaders.set('authorization', clientAuth.startsWith('Bearer ') ? clientAuth : `Bearer ${clientAuth}`);
    }
  } else if ((upstream.oauth || upstream.authMode === 'oauth') && oauthResolver && upstream.oauth) {
    try {
      const token = await oauthResolver.resolve(upstream.oauth);
      if (upstream.authMode === 'x-api-key') {
        upstreamHeaders.set('x-api-key', token);
      } else if (upstream.authMode === 'google') {
        upstreamHeaders.set('x-goog-api-key', token);
      } else {
        upstreamHeaders.set('authorization', `Bearer ${token}`);
      }
    } catch (err: any) {
      cleanupSignal();
      return {
        ok: false,
        shouldRetry: false,
        statusCode: 502,
        errorMessage: `OAuth resolution failed: ${err.message}`,
      };
    }
  } else if (upstream.authMode === 'oauth' || upstream.authMode === 'pass-through') {
    cleanupSignal();
    return {
      ok: false,
      shouldRetry: false,
      statusCode: 502,
      errorMessage: 'Upstream authentication is not configured',
    };
  } else if (upstream.authMode === 'custom-header') {
    upstreamHeaders.set(upstream.authHeaderName!, apiKey);
  } else if ((upstream.authMode ?? profile.authMode) === 'x-api-key') {
    upstreamHeaders.set('x-api-key', apiKey);
  } else if (upstream.authMode === 'google' || upstream.protocol === 'gemini') {
    upstreamHeaders.set('x-goog-api-key', apiKey);
  } else {
    upstreamHeaders.set('authorization', `Bearer ${apiKey}`);
  }

  upstreamHeaders.set('host', upstreamUrl.host);
  // C3b: Bedrock's streaming answers carry the eventstream framing, not SSE.
  upstreamHeaders.set(
    'accept',
    transport?.id === 'bedrock' && isStreaming
      ? 'application/vnd.amazon.eventstream'
      : isStreaming
        ? 'text/event-stream'
        : 'application/json',
  );
  // C1: multipart media requests keep their boundary-bearing content-type so
  // the upstream can re-parse the forwarded form; everything else is JSON.
  if (!isMultipartRequest) {
    upstreamHeaders.set('content-type', 'application/json');
  }
  if (upstream.protocol === 'anthropic' && !transport?.ownsHeaders) {
    if (upstream.anthropicVersion !== undefined) {
      upstreamHeaders.set('anthropic-version', upstream.anthropicVersion);
    }
    if (profile.claudeOptimizations) {
      injectAnthropicHeaders(upstreamHeaders, resolvedModel, upstream.thinkingPolicy);
    } else if (!upstreamHeaders.has('anthropic-version')) {
      upstreamHeaders.set('anthropic-version', '2023-06-01');
    }
    if (upstream.anthropicBetas !== undefined) {
      const configuredBetas = Array.from(new Set(upstream.anthropicBetas.map((beta) => beta.trim()).filter(Boolean)));
      if (configuredBetas.length) upstreamHeaders.set('anthropic-beta', configuredBetas.join(', '));
      else upstreamHeaders.delete('anthropic-beta');
    }
    if (upstream.thinkingPolicy === 'strip') stripThinkingBetasFromHeaders(upstreamHeaders);
  }

  let upstreamRes: Response;
  try {
    await onAttemptSent?.();
  } catch (error) {
    cleanupSignal();
    console.error('Proxy quota attempt tracking failed:', error);
    return {
      ok: false,
      shouldRetry: false,
      statusCode: 503,
      errorMessage: 'Proxy temporarily unavailable',
      failureReason: 'quota_tracking_unavailable',
    };
  }
  try {
    startPhase('connect_timeout', connectTimeoutMs);
    upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method ?? 'POST',
      headers: upstreamHeaders,
      body: upstreamBodyBytes,
      signal: localCtl.signal,
      dispatcher: upstreamAgent,
      redirect: 'manual',
    } as Parameters<typeof fetch>[1]);
    startPhase('first_byte_timeout', firstByteTimeoutMs);
  } catch (err: any) {
    const result = failure(err);
    cleanupSignal();
    return result;
  }

  let firstByteMs: number | undefined;
  const markFirstByte = () => {
    if (firstByteMs === undefined) {
      firstByteMs = elapsedMs();
      stopPhase();
      if (isStreaming) startPhase('stream_idle_timeout', streamIdleTimeoutMs);
    } else if (isStreaming) startPhase('stream_idle_timeout', streamIdleTimeoutMs);
  };

  if (upstreamRes.status >= 400 && upstreamRes.status < 500) {
    let message = 'Upstream returned client error';
    let errorUsage: unknown;
    try {
      const errBody: any = await readJsonWithFirstByte(upstreamRes, markFirstByte);
      message = errBody?.error?.message ?? errBody?.error ?? message;
      errorUsage = errBody?.usage;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}
    if (localCtl.signal.aborted) {
      const result = failure();
      cleanupSignal();
      return { ...result, firstByteMs };
    }

    // Thinking rectifiers: try signature rectifier first, then budget rectifier
    let rectifiedBody: any = null;
    let isSignatureRetry = false;

    // C3b: no corrective retries through a transport profile — the retried
    // body would differ from the signed payload (Bedrock) or re-mint tokens
    // (Vertex) for a path the transports were never validated against.
    if (
      profile.claudeOptimizations &&
      !transport &&
      upstream.protocol === 'anthropic' &&
      isThinkingSignatureError(message)
    ) {
      const rectified = rectifyAnthropicRequest(preprocessedBody);
      if (rectified.applied) {
        rectifiedBody = rectified.body;
        isSignatureRetry = true;
      }
    } else if (
      profile.claudeOptimizations &&
      !transport &&
      upstream.protocol === 'anthropic' &&
      isThinkingBudgetError(message)
    ) {
      const rectified = rectifyThinkingBudget(preprocessedBody);
      if (rectified.applied) {
        rectifiedBody = rectified.body;
      }
    }

    if (rectifiedBody) {
      const previous: TryResult = {
        ok: false,
        shouldRetry: false,
        statusCode: upstreamRes.status,
        errorMessage: message,
        rawUsage: errorUsage,
        firstByteMs,
      };
      // Every additional wire send must be explicitly admitted and observed.
      let rejection: TryResult | undefined;
      try {
        rejection = onCorrectiveRetry ? await onCorrectiveRetry(previous) : previous;
      } catch (error) {
        // The first attempt may already have been finalized. Do not feed an
        // admission/accounting exception back through its finalizer twice.
        cleanupSignal();
        throw error;
      }
      if (rejection) {
        cleanupSignal();
        return rejection;
      }
      const retryBody = bridge.transformRequest(rectifiedBody);
      if (retryBody && typeof retryBody === 'object') {
        retryBody.model = resolvedModel;
      }
      const retryBytes = Buffer.from(JSON.stringify(retryBody), 'utf-8');

      // For signature rectifier, strip thinking betas from headers before retry
      if (isSignatureRetry) {
        stripThinkingBetasFromHeaders(upstreamHeaders);
      }

      let retryRes: Response;
      try {
        await onAttemptSent?.();
      } catch {
        cleanupSignal();
        return {
          ok: false,
          shouldRetry: false,
          statusCode: 503,
          errorMessage: 'Proxy temporarily unavailable',
          failureReason: 'quota_tracking_unavailable',
        };
      }
      try {
        startPhase('connect_timeout', connectTimeoutMs);
        retryRes = await fetch(upstreamUrl.toString(), {
          method: req.method ?? 'POST',
          headers: upstreamHeaders,
          body: retryBytes,
          signal: localCtl.signal,
          dispatcher: upstreamAgent,
          redirect: 'manual',
        } as Parameters<typeof fetch>[1]);
        startPhase('first_byte_timeout', firstByteTimeoutMs);
      } catch (err: any) {
        const result = failure(err);
        cleanupSignal();
        return result;
      }

      if (retryRes.status >= 400 && retryRes.status < 500) {
        let retryMessage = 'Upstream returned client error';
        let retryUsage: unknown;
        try {
          const errBody: any = await readJsonWithFirstByte(retryRes, markFirstByte);
          retryUsage = errBody?.usage;
          retryMessage = errBody?.error?.message ?? errBody?.error ?? retryMessage;
          if (typeof retryMessage !== 'string') retryMessage = JSON.stringify(retryMessage);
        } catch {}
        if (localCtl.signal.aborted) {
          const result = failure();
          cleanupSignal();
          return { ...result, firstByteMs };
        }
        cleanupSignal();
        return {
          ok: false,
          shouldRetry: false,
          statusCode: retryRes.status,
          errorMessage: retryMessage,
          rawUsage: retryUsage,
          firstByteMs,
        };
      }

      if (retryRes.status >= 500) {
        let retryMessage = 'Upstream returned server error';
        let retryUsage: unknown;
        try {
          const errBody: any = await readJsonWithFirstByte(retryRes, markFirstByte);
          retryUsage = errBody?.usage;
          retryMessage = errBody?.error?.message ?? retryMessage;
        } catch {}
        if (localCtl.signal.aborted) {
          const result = failure();
          cleanupSignal();
          return { ...result, firstByteMs };
        }
        cleanupSignal();
        return {
          ok: false,
          shouldRetry: true,
          statusCode: retryRes.status,
          errorMessage: retryMessage,
          rawUsage: retryUsage,
          firstByteMs,
        };
      }

      // Retry succeeded – fall through to normal success handling
      upstreamRes = retryRes;
    } else {
      cleanupSignal();
      const retryableCredentialError =
        upstreamRes.status === 401 &&
        (profile.id.startsWith('kimi-') || profile.id.startsWith('deepseek-') || profile.id.startsWith('custom-'));
      return {
        ok: false,
        shouldRetry: retryableCredentialError || upstreamRes.status === 429,
        statusCode: upstreamRes.status,
        errorMessage: message,
        rawUsage: errorUsage,
        firstByteMs,
        retryAfterMs:
          upstreamRes.status === 429 ? retryAfterDelayMs(upstreamRes.headers.get('retry-after')) : undefined,
      };
    }
  }

  if (upstreamRes.status >= 500) {
    let message = 'Upstream returned server error';
    let errorUsage: unknown;
    try {
      const errBody: any = await readJsonWithFirstByte(upstreamRes, markFirstByte);
      message = errBody?.error?.message ?? message;
      errorUsage = errBody?.usage;
    } catch {}
    if (localCtl.signal.aborted) {
      const result = failure();
      cleanupSignal();
      return { ...result, firstByteMs };
    }
    cleanupSignal();
    return {
      ok: false,
      shouldRetry: true,
      statusCode: upstreamRes.status,
      errorMessage: message,
      rawUsage: errorUsage,
      firstByteMs,
    };
  }

  if (!isStreaming) {
    // C1: non-JSON success responses (audio/speech returns audio/mpeg, media
    // endpoints may return other binaries) forward verbatim — no bridge, no
    // JSON round-trip. JSON and SSE content types keep the existing paths.
    const upstreamContentType = upstreamRes.headers.get('content-type') ?? '';
    if (
      upstreamContentType !== '' &&
      !/application\/(json|[^;]*\+json)/i.test(upstreamContentType) &&
      !upstreamContentType.includes('text/event-stream')
    ) {
      res.writeHead(upstreamRes.status, { 'Content-Type': upstreamContentType });
      let binaryStreamError: string | undefined;
      if (upstreamRes.body) {
        const binaryReader = upstreamRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await binaryReader.read();
            if (done) break;
            if (value) {
              markFirstByte();
              if (!res.write(Buffer.from(value))) await waitForDrain(res);
            }
          }
        } catch (error) {
          binaryStreamError = parentSignal.aborted
            ? String(parentSignal.reason)
            : error instanceof Error
              ? error.message
              : 'binary_forward_error';
          localCtl.abort();
          await binaryReader.cancel().catch(() => {});
        } finally {
          binaryReader.releaseLock();
          res.end();
          cleanupSignal();
        }
      } else {
        res.end();
        cleanupSignal();
      }
      if (binaryStreamError) {
        const failResult = failure(new Error(binaryStreamError), !parentSignal.aborted);
        return { ...failResult, firstByteMs, responseCommitted: res.headersSent };
      }
      return {
        ok: true,
        statusCode: upstreamRes.status,
        usage: undefined,
        firstByteMs,
        responseCommitted: res.headersSent,
      };
    }
    let upstreamJson: any;
    try {
      upstreamJson = await readJsonWithFirstByte(upstreamRes, markFirstByte);
    } catch (err: any) {
      const result = failure(err, localCtl.signal.aborted);
      cleanupSignal();
      return {
        ...result,
        errorMessage: result.failureReason ?? 'Invalid upstream JSON',
        firstByteMs,
      };
    }
    const usage = normalizeUsage(upstream.protocol, upstreamJson);
    let transformed: unknown;
    try {
      transformed = bridge.transformResponse(upstreamJson);
    } catch (error) {
      if (error instanceof UnsupportedBridgeFeatureError) {
        cleanupSignal();
        return {
          ok: false,
          shouldRetry: false,
          statusCode: 422,
          errorMessage: error.message,
          usage,
          rawUsage: upstreamJson?.usage ?? upstreamJson?.usageMetadata,
          firstByteMs,
        };
      }
      if (!(error instanceof BridgeToolChoiceMismatchError)) throw error;
      cleanupSignal();
      return {
        ok: false,
        shouldRetry: false,
        statusCode: 502,
        errorMessage: error.message,
        usage,
        rawUsage: upstreamJson?.usage ?? upstreamJson?.usageMetadata,
        firstByteMs,
      };
    }
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transformed));
    cleanupSignal();
    return {
      ok: true,
      statusCode: upstreamRes.status,
      usage,
      rawUsage: upstreamJson?.usage ?? upstreamJson?.usageMetadata,
      firstByteMs,
      responseId:
        upstream.protocol === 'responses' && typeof upstreamJson?.id === 'string' ? upstreamJson.id : undefined,
    };
  }

  if (!upstreamRes.body) {
    res.writeHead(upstreamRes.status, { 'Content-Type': 'text/event-stream' });
    res.end();
    cleanupSignal();
    return { ok: true, statusCode: upstreamRes.status };
  }

  // C3b: transports answering a binary framing (Bedrock eventstream) decode
  // before the bridge sees the stream, so the SSE pipeline is unchanged.
  let observedBody: ReadableStream<Uint8Array>;
  if (transport?.decodeResponse) {
    const decoded = transport.decodeResponse(Readable.fromWeb(upstreamRes.body as never));
    const timing = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > 0) markFirstByte();
        controller.enqueue(chunk);
      },
    });
    const piped = Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>;
    observedBody = piped.pipeThrough(timing);
  } else {
    observedBody = upstreamRes.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (chunk.byteLength > 0) markFirstByte();
          controller.enqueue(chunk);
        },
      }),
    );
  }
  const { clientStream, usage } = bridge.transformStream(observedBody);

  const startClientStream = () => {
    if (!res.headersSent)
      res.writeHead(upstreamRes.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
  };

  const reader = clientStream.getReader();
  const timings = streamTimings(bridge.clientProto, elapsedMs);
  let streamError: string | undefined;
  let responseCommitted = res.headersSent;
  let responseId: string | undefined;
  let responseEventBuffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        startClientStream();
        responseCommitted = responseCommitted || res.headersSent;
        if (upstream.protocol === 'responses' && !responseId) {
          responseEventBuffer = (responseEventBuffer + Buffer.from(value).toString('utf8')).slice(-16_384);
          const match = /"id"\s*:\s*"(resp_[A-Za-z0-9_-]+)"/.exec(responseEventBuffer);
          if (match) responseId = match[1];
        }
        timings.feed(value);
        if (!res.write(value)) await waitForDrain(res);
      }
    }
  } catch (error) {
    streamError = parentSignal.aborted
      ? String(parentSignal.reason)
      : (phase ?? (error instanceof Error ? error.message : 'stream_error'));
    localCtl.abort();
    await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
    if (!streamError) startClientStream();
    responseCommitted = responseCommitted || res.headersSent;
    if (res.headersSent) res.end();
    cleanupSignal();
  }

  return {
    ok: !streamError,
    responseCommitted,
    statusCode: streamError
      ? streamError === 'client_disconnect'
        ? 499
        : phase || parentSignal.aborted
          ? 504
          : 502
      : upstreamRes.status,
    shouldRetry: !!streamError && !responseCommitted && !!phase && !parentSignal.aborted,
    errorMessage: streamError,
    failureReason: streamError && responseCommitted ? (phase ?? 'stream_truncated') : streamError,
    usagePromise: usage,
    firstByteMs,
    firstEventMs: timings.firstEventMs,
    firstTextMs: timings.firstTextMs,
    responseId,
  };
}
