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

function extractNonStreamUsage(
  upstreamProto: Protocol,
  body: any
): { inputTokens?: number; outputTokens?: number } {
  if (!body || typeof body !== 'object') return {};
  if (upstreamProto === 'anthropic') {
    return {
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
    };
  }
  return {
    inputTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
  };
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
          upstream: { name: upstream.name, baseUrl: upstream.baseUrl, protocol: upstream.protocol },
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
  usage?: { inputTokens?: number; outputTokens?: number };
  errorMessage?: string;
  usagePromise?: Promise<{ inputTokens?: number; outputTokens?: number }>;
}

async function trySingleUpstream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedBody: any;
  resolvedModel: string;
  upstream: { name: string; baseUrl: string; protocol: Protocol };
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

  const transformedBody = bridge.transformRequest(parsedBody ?? {});
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
  upstreamHeaders.set('authorization', `Bearer ${apiKey}`);
  upstreamHeaders.set('host', upstreamUrl.host);
  upstreamHeaders.set('accept', isStreaming ? 'text/event-stream' : 'application/json');
  upstreamHeaders.set('content-type', 'application/json');

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
    cleanupSignal();
    return { ok: false, shouldRetry: false, statusCode: upstreamRes.status, errorMessage: message };
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
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('idle_timeout')), streamIdleTimeoutMs)
        ),
      ]);
      if (done) break;
      if (value) res.write(value);
    }
  } catch {
    // upstream/client disconnect or idle timeout; usage promise will still settle
  } finally {
    reader.releaseLock();
    res.end();
    cleanupSignal();
  }

  return { ok: true, statusCode: upstreamRes.status, usagePromise: usage };
}
