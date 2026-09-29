import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import type { PlaygroundExecutor, PlaygroundInput } from '../admin/playground.js';
import type { ConfigStore } from '../config/store.js';
import type { LogEntry } from '../logger/types.js';
import type { AttemptRecord, RequestRecord } from '../telemetry/types.js';
import { type ProxyHandlerOptions, proxyHandler } from './proxy.js';

type Invocation = Parameters<PlaygroundExecutor>[0];

class MemoryRequest extends Readable {
  readonly method = 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly socket = { remoteAddress: '127.0.0.1' };
  private sent = false;
  constructor(path: string, body: Buffer) {
    super({ autoDestroy: false });
    this.url = path;
    this.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
    this.body = body;
  }
  private readonly body: Buffer;
  override _read(): void {
    if (this.sent) return;
    this.sent = true;
    this.push(this.body);
    this.push(null);
  }
}

class MemoryResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  constructor() {
    super({ autoDestroy: false, highWaterMark: 4 * 1024 * 1024 });
  }
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Playground output is bounded independently of an upstream's response size.
    const remaining = Math.max(0, 2 * 1024 * 1024 - this.bytes);
    if (remaining) this.chunks.push(buffer.subarray(0, remaining));
    this.bytes += buffer.length;
    callback();
  }
  body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function requestBody(input: PlaygroundInput): Record<string, unknown> {
  const base = { model: input.model, stream: input.stream === true, temperature: input.temperature };
  if (input.protocol === 'anthropic')
    return {
      ...base,
      max_tokens: input.maxOutputTokens,
      messages: [{ role: 'user', content: input.input }],
    };
  if (input.protocol === 'responses')
    return {
      ...base,
      max_output_tokens: input.maxOutputTokens,
      input: input.input,
    };
  return {
    ...base,
    max_tokens: input.maxOutputTokens,
    messages: [{ role: 'user', content: input.input }],
  };
}

function textFromPayload(payload: any, protocol: PlaygroundInput['protocol']): string {
  if (protocol === 'anthropic') {
    return Array.isArray(payload?.content)
      ? payload.content
          .filter((item: any) => item?.type === 'text')
          .map((item: any) => String(item.text ?? ''))
          .join('')
      : '';
  }
  if (protocol === 'responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text;
    return Array.isArray(payload?.output)
      ? payload.output
          .flatMap((item: any) => item?.content ?? [])
          .filter((item: any) => item?.type === 'output_text')
          .map((item: any) => String(item.text ?? ''))
          .join('')
      : '';
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((item: any) => item?.type === 'text')
          .map((item: any) => String(item.text ?? ''))
          .join('')
      : '';
}

function streamText(body: string, protocol: PlaygroundInput['protocol']): string {
  const result: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    let delta: unknown;
    if (protocol === 'anthropic') delta = event?.delta?.text ?? event?.content_block?.text;
    else if (protocol === 'responses') delta = event?.delta ?? event?.data?.delta;
    else delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') result.push(delta);
  }
  return result.join('');
}

/** In-process only: no listener, public route, bearer token recovery, or request-header source override. */
export function createPlaygroundExecutor(
  store: ConfigStore,
  enqueue: (entry: LogEntry) => void,
  options: ProxyHandlerOptions & {
    quotaLedger: NonNullable<ProxyHandlerOptions['quotaLedger']>;
    telemetryStore: NonNullable<ProxyHandlerOptions['telemetryStore']>;
  },
): PlaygroundExecutor {
  if (!options.quotaLedger) throw new Error('Playground executor requires a quota ledger');
  if (!options.telemetryStore) throw new Error('Playground executor requires a telemetry store');
  return async (input: Invocation) => {
    const started = Date.now();
    if (input.signal.aborted)
      return {
        output: '',
        status: 499,
        upstreamId: '',
        model: input.model,
        durationMs: 0,
        usage: null,
        error: 'Playground run cancelled',
      };
    const path =
      input.protocol === 'anthropic'
        ? '/v1/messages'
        : input.protocol === 'responses'
          ? '/v1/responses'
          : '/v1/chat/completions';
    const bytes = Buffer.from(JSON.stringify(requestBody(input)));
    const req = new MemoryRequest(path, bytes);
    const res = new MemoryResponse();
    let request: RequestRecord | undefined;
    let lastAttempt: AttemptRecord | undefined;
    const telemetryStore = {
      upsertRequest: async (record: RequestRecord) => {
        request = { ...record };
        await options.telemetryStore.upsertRequest(record);
      },
      upsertAttempt: async (record: AttemptRecord) => {
        lastAttempt = { ...record };
        await options.telemetryStore.upsertAttempt(record);
      },
    };
    // Upstream errors can echo user input. Never persist their message through legacy logs.
    const safeEnqueue = (entry: LogEntry) =>
      enqueue({ ...entry, error_message: entry.error_message ? 'playground_upstream_error' : null });
    await proxyHandler(req as unknown as IncomingMessage, res as unknown as ServerResponse, store, safeEnqueue, {
      ...options,
      // The caller cannot provide internal transport metadata through the request body.
      internalPlayground: { keyId: input.keyId, routeId: input.routeId, target: input.target, signal: input.signal },
      quotaReserveTokens: input.maxOutputTokens,
      telemetryStore,
    });
    const status = request?.finalHttpStatus ?? res.statusCode;
    const raw = res.body();
    let output = '';
    let error: string | null = null;
    if (status >= 200 && status < 300 && !input.signal.aborted) {
      if (input.stream) output = streamText(raw, input.protocol);
      else {
        try {
          output = textFromPayload(JSON.parse(raw), input.protocol);
        } catch {
          error = 'Invalid playground response';
        }
      }
    } else {
      try {
        const parsed = JSON.parse(raw);
        error = parsed?.error?.message ?? parsed?.error?.type ?? 'Playground request failed';
      } catch {
        error = input.signal.aborted ? 'Playground run cancelled' : 'Playground request failed';
      }
    }
    return {
      output,
      status: input.signal.aborted ? 499 : status,
      upstreamId: request?.finalUpstreamId ?? lastAttempt?.upstreamId ?? '',
      model: lastAttempt?.resolvedModel ?? input.model,
      durationMs: Date.now() - started,
      usage: lastAttempt?.usage ?? null,
      error,
    };
  };
}
