import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigStore } from '../config/store.js';
import { selectUpstreams } from '../router/upstream.js';
import { AnthropicAdapter } from '../protocol/anthropic.js';
import type { ProtocolAdapter } from '../protocol/adapter.js';
import { authenticateProxyKey, sendAuthError, sendNoUpstreamError } from './auth.js';
import type { LogEntry } from '../logger/types.js';

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pickAdapter(protocol: string): ProtocolAdapter {
  if (protocol === 'anthropic') return new AnthropicAdapter();
  throw new Error(`Unsupported protocol: ${protocol}`);
}

export async function proxyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: ConfigStore,
  enqueue: (entry: LogEntry) => void
): Promise<void> {
  const startTime = Date.now();

  const auth = authenticateProxyKey(store, req);
  if (!auth.ok) {
    sendAuthError(res);
    return;
  }
  const proxyKeyName = auth.keyName;

  const bodyBuffer = await collectBody(req);
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
  const candidates = model ? selectUpstreams(model, config.upstreams) : [];

  if (candidates.length === 0) {
    sendNoUpstreamError(res);
    enqueue({
      proxy_key_name: proxyKeyName,
      client_ip: getClientIp(req),
      request_model: model,
      status_code: 404,
      duration_ms: Date.now() - startTime,
      is_streaming: false,
    } as LogEntry);
    return;
  }

  const isStreaming = parsedBody?.stream === true;

  for (let i = 0; i < candidates.length; i++) {
    const upstream = candidates[i];
    const adapter = pickAdapter(upstream.protocol);
    const actualModel = adapter.extractModel(parsedBody) || model;

    const tryStart = Date.now();
    const result = await trySingleUpstream({
      req,
      res,
      bodyBuffer,
      upstream,
      adapter,
      isStreaming,
    });

    if (result.ok) {
      if (isStreaming && result.logPromise) {
        result.logPromise.then((usage) => {
          enqueue({
            proxy_key_name: proxyKeyName,
            client_ip: getClientIp(req),
            request_model: model,
            actual_model: actualModel,
            upstream_name: upstream.name,
            status_code: result.statusCode ?? 200,
            request_tokens: usage.inputTokens,
            response_tokens: usage.outputTokens,
            total_tokens:
              usage.inputTokens !== undefined && usage.outputTokens !== undefined
                ? usage.inputTokens + usage.outputTokens
                : undefined,
            duration_ms: Date.now() - startTime,
            is_streaming: true,
          } as LogEntry);
        });
      } else if (!isStreaming) {
        enqueue({
          proxy_key_name: proxyKeyName,
          client_ip: getClientIp(req),
          request_model: model,
          actual_model: actualModel,
          upstream_name: upstream.name,
          status_code: result.statusCode ?? 200,
          error_message: result.errorMessage,
          request_tokens: result.usage?.inputTokens,
          response_tokens: result.usage?.outputTokens,
          total_tokens:
            result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined
              ? result.usage.inputTokens + result.usage.outputTokens
              : undefined,
          duration_ms: Date.now() - startTime,
          is_streaming: false,
        } as LogEntry);
      }
      return;
    }

    const duration = Date.now() - tryStart;
    const shouldRetry = result.shouldRetry ?? false;
    const status = result.statusCode ?? 502;

    enqueue({
      proxy_key_name: proxyKeyName,
      client_ip: getClientIp(req),
      request_model: model,
      actual_model: actualModel,
      upstream_name: upstream.name,
      status_code: status,
      error_message: result.errorMessage,
      duration_ms: duration,
      is_streaming: isStreaming,
    } as LogEntry);

    if (!shouldRetry) {
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: result.errorMessage || 'Upstream error' } }));
      }
      return;
    }

    if (i < candidates.length - 1) continue;
  }

  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'All upstreams failed' } }));
  }
}

interface TryResult {
  ok: boolean;
  shouldRetry?: boolean;
  statusCode?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  errorMessage?: string;
  logPromise?: Promise<{ inputTokens?: number; outputTokens?: number }>;
}

async function trySingleUpstream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  bodyBuffer: Buffer;
  upstream: { name: string; baseUrl: string; apiKey: string; protocol: string };
  adapter: ProtocolAdapter;
  isStreaming: boolean;
}): Promise<TryResult> {
  const { req, res, bodyBuffer, upstream, adapter, isStreaming } = options;

  const upstreamUrl = new URL(`${upstream.baseUrl.replace(/\/$/, '')}${req.url || '/'}`);
  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === 'host' || key === 'authorization' || key === 'x-api-key') continue;
    if (Array.isArray(value)) {
      for (const v of value) upstreamHeaders.append(key, v);
    } else {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set('authorization', `Bearer ${upstream.apiKey}`);
  upstreamHeaders.set('host', upstreamUrl.host);
  upstreamHeaders.set('accept', req.headers.accept || 'application/json');
  upstreamHeaders.set('content-type', req.headers['content-type'] || 'application/json');

  const requestInit = adapter.transformRequest({
    method: req.method,
    headers: upstreamHeaders,
    body: bodyBuffer.length > 0 ? bodyBuffer : undefined,
  });

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl.toString(), requestInit as RequestInit);
  } catch (err: any) {
    return { ok: false, shouldRetry: true, statusCode: 502, errorMessage: err.message };
  }

  if (upstreamRes.status >= 400 && upstreamRes.status < 500) {
    let message = 'Upstream returned client error';
    try {
      const cloned = upstreamRes.clone();
      const errBody: any = await cloned.json();
      message = errBody?.error?.message || message;
    } catch {}
    return { ok: false, shouldRetry: false, statusCode: upstreamRes.status, errorMessage: message };
  }

  if (upstreamRes.status >= 500) {
    let message = 'Upstream returned server error';
    try {
      const cloned = upstreamRes.clone();
      const errBody: any = await cloned.json();
      message = errBody?.error?.message || message;
    } catch {}
    return { ok: false, shouldRetry: true, statusCode: upstreamRes.status, errorMessage: message };
  }

  const responseHeaders: Record<string, string> = {};
  upstreamRes.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (!isStreaming) {
    const cloned = upstreamRes.clone();
    const resBody: any = await cloned.json().catch(() => ({}));
    const usage = adapter.extractUsage(resBody);

    res.writeHead(upstreamRes.status, responseHeaders);
    const finalRes = await adapter.transformResponse(upstreamRes);
    const buf = Buffer.from(await finalRes.arrayBuffer());
    res.end(buf);

    return { ok: true, statusCode: upstreamRes.status, usage, errorMessage: resBody?.error?.message };
  }

  if (!upstreamRes.body) {
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end();
    return { ok: true, statusCode: upstreamRes.status };
  }

  const [clientStream, logStream] = upstreamRes.body.tee();
  const logPromise = parseStreamForUsage(logStream, adapter);

  res.writeHead(upstreamRes.status, responseHeaders);
  const reader = clientStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }

  return { ok: true, statusCode: upstreamRes.status, logPromise };
}

async function parseStreamForUsage(
  stream: ReadableStream<Uint8Array>,
  adapter: ProtocolAdapter
): Promise<{ inputTokens?: number; outputTokens?: number }> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buffer = '';
  const events: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (part.trim()) events.push(part.trim());
      }
    }
    if (buffer.trim()) events.push(buffer.trim());
  } finally {
    reader.releaseLock();
  }

  return adapter.extractStreamUsage(events);
}
