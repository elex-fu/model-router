import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigStore } from '../config/store.js';
import { selectUpstreams } from '../router/upstream.js';
import { pickBridge, type Bridge, type Protocol } from '../protocol/bridge.js';
import { authenticateProxyKey } from './auth.js';
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

function clientProtocolFromPath(path: string): Protocol | null {
  // Anthropic: /v1/messages (canonical)
  // OpenAI: /v1/chat/completions (canonical)
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

export async function proxyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  store: ConfigStore,
  enqueue: (entry: LogEntry) => void
): Promise<void> {
  const startTime = Date.now();

  const reqPath = req.url || '/';
  const clientProto = clientProtocolFromPath(reqPath);
  if (!clientProto) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found_error', code: null } }));
    return;
  }

  const auth = authenticateProxyKey(store, req);
  if (!auth.ok) {
    writeProtocolError(res, clientProto, 401, 'authentication_error', 'Invalid proxy key');
    return;
  }
  const proxyKey = auth.key;
  const proxyKeyName = proxyKey.name;

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
      client_ip: getClientIp(req),
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

  for (let i = 0; i < candidates.length; i++) {
    const { upstream, resolvedModel } = candidates[i];
    const bridge = pickBridge(clientProto, upstream.protocol);

    const tryStart = Date.now();
    const result = await trySingleUpstream({
      req,
      res,
      parsedBody,
      resolvedModel,
      upstream,
      bridge,
      isStreaming,
    });

    if (result.ok) {
      if (isStreaming && result.usagePromise) {
        result.usagePromise.then((usage) => {
          enqueue({
            proxy_key_name: proxyKeyName,
            client_ip: getClientIp(req),
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
        });
      } else if (!isStreaming) {
        enqueue({
          proxy_key_name: proxyKeyName,
          client_ip: getClientIp(req),
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

    const duration = Date.now() - tryStart;
    const shouldRetry = result.shouldRetry ?? false;
    const status = result.statusCode ?? 502;

    enqueue({
      proxy_key_name: proxyKeyName,
      client_ip: getClientIp(req),
      client_protocol: clientProto,
      upstream_protocol: upstream.protocol,
      request_model: model,
      actual_model: resolvedModel,
      upstream_name: upstream.name,
      status_code: status,
      error_message: result.errorMessage ?? null,
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

    if (i < candidates.length - 1) continue;
  }

  if (!res.headersSent) {
    const lastBridge = pickBridge(clientProto, candidates[candidates.length - 1].upstream.protocol);
    const err = lastBridge.wrapError(502, 'All upstreams failed');
    res.writeHead(502, { 'Content-Type': err.contentType });
    res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
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
  upstream: { name: string; baseUrl: string; apiKey: string; protocol: Protocol };
  bridge: Bridge;
  isStreaming: boolean;
}): Promise<TryResult> {
  const { req, res, parsedBody, resolvedModel, upstream, bridge, isStreaming } = options;

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
  upstreamHeaders.set('authorization', `Bearer ${upstream.apiKey}`);
  upstreamHeaders.set('host', upstreamUrl.host);
  upstreamHeaders.set('accept', isStreaming ? 'text/event-stream' : 'application/json');
  upstreamHeaders.set('content-type', 'application/json');

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method ?? 'POST',
      headers: upstreamHeaders,
      body: upstreamBodyBytes,
    });
  } catch (err: any) {
    return { ok: false, shouldRetry: true, statusCode: 502, errorMessage: err.message };
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
    return { ok: false, shouldRetry: false, statusCode: upstreamRes.status, errorMessage: message };
  }

  if (upstreamRes.status >= 500) {
    let message = 'Upstream returned server error';
    try {
      const errBody: any = await upstreamRes.clone().json();
      message = errBody?.error?.message ?? message;
    } catch {}
    return { ok: false, shouldRetry: true, statusCode: upstreamRes.status, errorMessage: message };
  }

  if (!isStreaming) {
    let upstreamJson: any;
    try {
      upstreamJson = await upstreamRes.json();
    } catch (err: any) {
      return { ok: false, shouldRetry: false, statusCode: 502, errorMessage: 'Invalid upstream JSON' };
    }
    const usage = extractNonStreamUsage(upstream.protocol, upstreamJson);
    const transformed = bridge.transformResponse(upstreamJson);
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transformed));
    return { ok: true, statusCode: upstreamRes.status, usage };
  }

  if (!upstreamRes.body) {
    res.writeHead(upstreamRes.status, { 'Content-Type': 'text/event-stream' });
    res.end();
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
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } catch {
    // upstream/client disconnect; usage promise will still settle
  } finally {
    reader.releaseLock();
    res.end();
  }

  return { ok: true, statusCode: upstreamRes.status, usagePromise: usage };
}
