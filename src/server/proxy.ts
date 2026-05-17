import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigStore } from '../config/store.js';
import { selectUpstreams } from '../router/upstream.js';
import { pickBridge, type Bridge, type Protocol } from '../protocol/bridge.js';
import { authenticateProxyKey } from './auth.js';
import { KeyLimiter, type ReserveResult } from '../limit/limiter.js';
import { KeyPool } from './keyPool.js';
import { IpAuthBlocker } from '../limit/ipBlocker.js';
import { redactSecrets } from '../limit/redact.js';
import { getClientIp } from './clientIp.js';
import type { LogEntry } from '../logger/types.js';
import { preprocessRequest } from './preprocess.js';
import {
  isThinkingSignatureError,
  rectifyAnthropicRequest,
  isThinkingBudgetError,
  rectifyThinkingBudget,
} from './rectifier.js';

export interface ProxyHandlerOptions {
  limiter?: KeyLimiter;
  keyPool?: KeyPool;
  maxBodyBytes?: number;
  healthCheck?: () => Promise<boolean>;
  ipBlocker?: IpAuthBlocker;
  trustProxy?: boolean;
  streamIdleTimeoutMs?: number;
}

const DEFAULT_STREAM_IDLE_MS = 60_000;

class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
}

function collectBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/chat/completions')) return 'openai';
  return null;
}

function writeProtocolError(
  res: ServerResponse,
  clientProto: Protocol,
  statusCode: number,
  errorType: string,
  message: string
): void {
  const body =
    clientProto === 'anthropic'
      ? { type: 'error', error: { type: errorType, message } }
      : { error: { message, type: errorType, code: null } };
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function extractNonStreamUsage(
  upstreamProto: Protocol,
  body: any
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
export function injectAnthropicHeaders(headers: Headers, model: string): void {
  if (!headers.has('anthropic-version')) {
    headers.set('anthropic-version', '2023-06-01');
  }

  const existing = headers.get('anthropic-beta') ?? '';
  const betas = new Set(existing.split(',').map((b) => b.trim()).filter(Boolean));
  betas.add('claude-code-20250219');

  const m = (model || '').toLowerCase();
  if (m.includes('opus-4-7') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
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

function rateLimitMessage(reason: ReserveResult['reason']): string {
  if (reason === 'rpm_exceeded') return 'Requests per minute limit exceeded';
  if (reason === 'daily_tokens_exceeded') return 'Daily token quota exceeded';
  return 'Rate limit exceeded';
}

export async function proxyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: ConfigStore,
  enqueue: (entry: LogEntry) => void,
  options: ProxyHandlerOptions = {}
): Promise<void> {
  const startTime = Date.now();
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
    const status = dbOk ? 200 : 503;
    const body = dbOk ? { status: 'ok', db: 'ok' } : { status: 'degraded', db: 'error' };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(JSON.stringify(body));
    }
    return;
  }

  const clientProto = clientProtocolFromPath(reqPath);
  if (!clientProto) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found_error', code: null } }));
    return;
  }

  const clientIp = getClientIp(req, options.trustProxy ?? false);
  if (options.ipBlocker) {
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
      return;
    }
  }

  const auth = authenticateProxyKey(store, req);
  if (!auth.ok) {
    options.ipBlocker?.recordFailure(clientIp);
    writeProtocolError(res, clientProto, 401, 'authentication_error', 'Invalid proxy key');
    return;
  }
  options.ipBlocker?.clearSuccess(clientIp);
  const proxyKey = auth.key;
  const proxyKeyName = proxyKey.name;
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
      enqueue({
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

  const config = store.load();
  const model = parsedBody?.model;

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
      enqueue({
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
      return;
    }
  }

  const candidates = model ? selectUpstreams(model, config.upstreams, proxyKey) : [];

  if (candidates.length === 0) {
    const modelExistsForAnyUpstream =
      model !== undefined && selectUpstreams(model, config.upstreams).length > 0;
    const errMessage = modelExistsForAnyUpstream
      ? 'Model not allowed for this proxy key'
      : 'No available upstream for the requested model';
    writeProtocolError(res, clientProto, 404, 'not_found_error', errMessage);
    enqueue({
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
    return;
  }

  const isStreaming = parsedBody?.stream === true;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS;

  const abortController = new AbortController();
  const onClientAbort = () => abortController.abort();
  req.on('close', onClientAbort);
  res.on('close', onClientAbort);

  try {
    for (let i = 0; i < candidates.length; i++) {
      const { upstream, resolvedModel } = candidates[i];
      const bridge = pickBridge(clientProto, upstream.protocol);

      let keysForUpstream = options.keyPool?.getAvailableKeys(upstream.name) ?? upstream.apiKeys;
      if (keysForUpstream.length === 0) continue;
      for (let k = keysForUpstream.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [keysForUpstream[k], keysForUpstream[j]] = [keysForUpstream[j], keysForUpstream[k]];
      }

      for (const key of keysForUpstream) {
        const tryStart = Date.now();
        const result = await trySingleUpstream({
          req,
          res,
          parsedBody,
          resolvedModel,
          upstream: { name: upstream.name, baseUrl: upstream.baseUrl, protocol: upstream.protocol, authMode: upstream.authMode },
          apiKey: key,
          bridge,
          isStreaming,
          signal: abortController.signal,
          streamIdleTimeoutMs,
        });

        if (result.ok) {
          options.keyPool?.markSuccess(upstream.name, key);
          if (isStreaming && result.usagePromise) {
            result.usagePromise.then((usage) => {
              if (limiter) {
                limiter.recordUsage(proxyKeyName, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
              }
              enqueue({
                proxy_key_name: proxyKeyName,
                client_ip: clientIp,
                client_protocol: clientProto,
                upstream_protocol: upstream.protocol,
                request_model: model,
                actual_model: resolvedModel,
                upstream_name: upstream.name,
                status_code: result.statusCode ?? 200,
                error_message: null,
                request_tokens: usage.inputTokens ?? null,
                response_tokens: usage.outputTokens ?? null,
                total_tokens:
                  usage.inputTokens !== undefined && usage.outputTokens !== undefined
                    ? usage.inputTokens + usage.outputTokens
                    : null,
                cache_read_tokens: usage.cacheReadTokens ?? null,
                cache_creation_tokens: usage.cacheCreationTokens ?? null,
                first_token_ms: result.firstTokenMs ?? null,
                duration_ms: Date.now() - startTime,
                is_streaming: true,
              });
            }).catch(() => {});
          } else if (!isStreaming) {
            if (limiter) {
              limiter.recordUsage(
                proxyKeyName,
                result.usage?.inputTokens ?? 0,
                result.usage?.outputTokens ?? 0
              );
            }
            enqueue({
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
          return;
        }

        options.keyPool?.markFailure(upstream.name, key);

        const duration = Date.now() - tryStart;
        const shouldRetry = result.shouldRetry ?? false;
        const status = result.statusCode ?? 502;

        enqueue({
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
          return;
        }

        // Try next key for same upstream
      }

      if (i < candidates.length - 1) continue;
    }

    if (!res.headersSent) {
      const lastBridge = pickBridge(clientProto, candidates[candidates.length - 1].upstream.protocol);
      const err = lastBridge.wrapError(502, 'All upstreams failed');
      res.writeHead(502, { 'Content-Type': err.contentType });
      res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
    }
  } finally {
    req.off('close', onClientAbort);
    res.off('close', onClientAbort);
  }
}

interface TryResult {
  ok: boolean;
  shouldRetry?: boolean;
  statusCode?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  errorMessage?: string;
  usagePromise?: Promise<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }>;
  firstTokenMs?: number;
}

async function trySingleUpstream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedBody: any;
  resolvedModel: string;
  upstream: { name: string; baseUrl: string; protocol: Protocol; authMode?: 'bearer' | 'x-api-key' };
  apiKey: string;
  bridge: Bridge;
  isStreaming: boolean;
  signal: AbortSignal;
  streamIdleTimeoutMs: number;
}): Promise<TryResult> {
  const {
    req,
    res,
    parsedBody,
    resolvedModel,
    upstream,
    apiKey,
    bridge,
    isStreaming,
    signal: parentSignal,
    streamIdleTimeoutMs,
  } = options;

  const localCtl = new AbortController();
  const onParentAbort = () => localCtl.abort();
  if (parentSignal.aborted) {
    localCtl.abort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const cleanupSignal = () => {
    parentSignal.removeEventListener('abort', onParentAbort);
  };

  const clientPath = req.url || '/';
  const upstreamPath = bridge.rewriteUrlPath(clientPath);
  const upstreamUrl = new URL(`${upstream.baseUrl.replace(/\/$/, '')}${upstreamPath}`);

  const preprocessedBody = preprocessRequest(parsedBody ?? {}, upstream.protocol, resolvedModel);
  const transformedBody = bridge.transformRequest(preprocessedBody);
  if (transformedBody && typeof transformedBody === 'object') {
    transformedBody.model = resolvedModel;
  }
  const upstreamBodyBytes = Buffer.from(JSON.stringify(transformedBody), 'utf-8');

  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (
      key === 'host' ||
      key === 'authorization' ||
      key === 'x-api-key' ||
      key === 'content-length' ||
      key === 'content-encoding' ||
      key === 'accept-encoding'
    )
      continue;
    if (Array.isArray(value)) {
      for (const v of value) upstreamHeaders.append(key, v);
    } else {
      upstreamHeaders.set(key, value);
    }
  }
  if (upstream.authMode === 'x-api-key') {
    upstreamHeaders.set('x-api-key', apiKey);
  } else {
    upstreamHeaders.set('authorization', `Bearer ${apiKey}`);
  }
  upstreamHeaders.set('host', upstreamUrl.host);
  upstreamHeaders.set('accept', isStreaming ? 'text/event-stream' : 'application/json');
  upstreamHeaders.set('content-type', 'application/json');
  if (upstream.protocol === 'anthropic') {
    injectAnthropicHeaders(upstreamHeaders, resolvedModel);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method ?? 'POST',
      headers: upstreamHeaders,
      body: upstreamBodyBytes,
      signal: localCtl.signal,
    });
  } catch (err: any) {
    cleanupSignal();
    const aborted = parentSignal.aborted;
    return {
      ok: false,
      shouldRetry: !aborted,
      statusCode: aborted ? 499 : 502,
      errorMessage: aborted ? 'client_disconnect' : err.message,
    };
  }

  if (upstreamRes.status >= 400 && upstreamRes.status < 500) {
    let message = 'Upstream returned client error';
    try {
      const errBody: any = await upstreamRes.clone().json();
      message =
        errBody?.error?.message ??
        errBody?.error ??
        message;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}

    // Thinking rectifiers: try signature rectifier first, then budget rectifier
    let rectifiedBody: any = null;
    let isSignatureRetry = false;

    if (upstream.protocol === 'anthropic' && isThinkingSignatureError(message)) {
      const rectified = rectifyAnthropicRequest(preprocessedBody);
      if (rectified.applied) {
        rectifiedBody = rectified.body;
        isSignatureRetry = true;
      }
    } else if (upstream.protocol === 'anthropic' && isThinkingBudgetError(message)) {
      const rectified = rectifyThinkingBudget(preprocessedBody);
      if (rectified.applied) {
        rectifiedBody = rectified.body;
      }
    }

    if (rectifiedBody) {
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
        retryRes = await fetch(upstreamUrl.toString(), {
          method: req.method ?? 'POST',
          headers: upstreamHeaders,
          body: retryBytes,
          signal: localCtl.signal,
        });
      } catch (err: any) {
        cleanupSignal();
        const aborted = parentSignal.aborted;
        return {
          ok: false,
          shouldRetry: !aborted,
          statusCode: aborted ? 499 : 502,
          errorMessage: aborted ? 'client_disconnect' : err.message,
        };
      }

      if (retryRes.status >= 400 && retryRes.status < 500) {
        let retryMessage = 'Upstream returned client error';
        try {
          const errBody: any = await retryRes.clone().json();
          retryMessage = errBody?.error?.message ?? errBody?.error ?? retryMessage;
          if (typeof retryMessage !== 'string') retryMessage = JSON.stringify(retryMessage);
        } catch {}
        cleanupSignal();
        return { ok: false, shouldRetry: false, statusCode: retryRes.status, errorMessage: retryMessage };
      }

      if (retryRes.status >= 500) {
        let retryMessage = 'Upstream returned server error';
        try {
          const errBody: any = await retryRes.clone().json();
          retryMessage = errBody?.error?.message ?? retryMessage;
        } catch {}
        cleanupSignal();
        return { ok: false, shouldRetry: true, statusCode: retryRes.status, errorMessage: retryMessage };
      }

      // Retry succeeded – fall through to normal success handling
      upstreamRes = retryRes;
    } else {
      cleanupSignal();
      return { ok: false, shouldRetry: false, statusCode: upstreamRes.status, errorMessage: message };
    }
  }

  if (upstreamRes.status >= 500) {
    let message = 'Upstream returned server error';
    try {
      const errBody: any = await upstreamRes.clone().json();
      message = errBody?.error?.message ?? message;
    } catch {}
    cleanupSignal();
    return { ok: false, shouldRetry: true, statusCode: upstreamRes.status, errorMessage: message };
  }

  if (!isStreaming) {
    let upstreamJson: any;
    try {
      upstreamJson = await upstreamRes.json();
    } catch (err: any) {
      cleanupSignal();
      const aborted = parentSignal.aborted;
      return {
        ok: false,
        shouldRetry: false,
        statusCode: aborted ? 499 : 502,
        errorMessage: aborted ? 'client_disconnect' : 'Invalid upstream JSON',
      };
    }
    const usage = extractNonStreamUsage(upstream.protocol, upstreamJson);
    const transformed = bridge.transformResponse(upstreamJson);
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transformed));
    cleanupSignal();
    return { ok: true, statusCode: upstreamRes.status, usage };
  }

  if (!upstreamRes.body) {
    res.writeHead(upstreamRes.status, { 'Content-Type': 'text/event-stream' });
    res.end();
    cleanupSignal();
    return { ok: true, statusCode: upstreamRes.status };
  }

  const { clientStream, usage } = bridge.transformStream(upstreamRes.body);

  res.writeHead(upstreamRes.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = clientStream.getReader();
  let firstTokenMs: number | undefined;
  const streamStart = Date.now();
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('idle_timeout')), streamIdleTimeoutMs)
        ),
      ]);
      if (done) break;
      if (value) {
        if (firstTokenMs === undefined) {
          firstTokenMs = Date.now() - streamStart;
        }
        res.write(value);
      }
    }
  } catch {
    // upstream/client disconnect or idle timeout; usage promise will still settle
  } finally {
    reader.releaseLock();
    res.end();
    cleanupSignal();
  }

  return { ok: true, statusCode: upstreamRes.status, usagePromise: usage, firstTokenMs };
}
