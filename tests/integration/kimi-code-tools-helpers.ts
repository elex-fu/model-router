import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { parseSseStream } from '../../src/protocol/sse.js';
import { proxyHandler } from '../../src/server/proxy.js';

const PROXY_KEY = 'local-kimi-tool-fixture';
export const TOOL_MODEL = 'kimi-tools';
export const ADD_TOOL = {
  type: 'function',
  function: {
    name: 'add',
    description: 'Return the sum of two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
};

export interface ToolMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  anthropic_content?: Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

export interface NativeToolSummary {
  status: number;
  contentType: string;
  bytes: number;
  events: Record<string, number>;
  blocks: Record<string, number>;
  stopReasons: string[];
  finishReasons: string[];
  thinkingType?: string;
  toolChoiceType?: string;
  toolChoiceName?: string;
  toolNames?: string[];
  toolSchemaSha256?: string;
  requestSha256IgnoringStream?: string;
  requestedStream?: boolean;
  selectedToolDeclared?: boolean;
  complete: boolean;
}

function observeNativeToolResponse(response: Response, summary: NativeToolSummary): Response {
  if (!response.body) {
    summary.complete = true;
    return response;
  }
  const decoder = new TextDecoder();
  let buffered = '';
  const inspect = (value: any, event?: string) => {
    if (event) summary.events[event] = (summary.events[event] ?? 0) + 1;
    const blockType = value?.content_block?.type;
    if (typeof blockType === 'string') summary.blocks[blockType] = (summary.blocks[blockType] ?? 0) + 1;
    const reason = value?.delta?.stop_reason ?? value?.stop_reason;
    if (typeof reason === 'string') summary.stopReasons.push(reason);
    const finish = value?.choices?.[0]?.finish_reason;
    if (typeof finish === 'string') summary.finishReasons.push(finish);
    if (!event && Array.isArray(value?.content)) {
      for (const block of value.content) {
        if (typeof block?.type === 'string') summary.blocks[block.type] = (summary.blocks[block.type] ?? 0) + 1;
      }
    }
  };
  const inspectEvent = (raw: string) => {
    const name = /^event:\s*([^\r\n]+)/m.exec(raw)?.[1];
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      inspect(JSON.parse(data), name ?? 'unnamed');
    } catch {
      /* Structural diagnostics never affect forwarding. */
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        summary.bytes += chunk.byteLength;
        buffered += decoder.decode(chunk, { stream: true });
        if (summary.contentType.includes('text/event-stream')) {
          const events = buffered.split(/\r?\n\r?\n/);
          buffered = events.pop() ?? '';
          for (const event of events) inspectEvent(event);
        }
        // Keep only a bounded transient parse window. Neither its text nor
        // thinking/signature values enter this summary or a persisted file.
        if (buffered.length > 1024 * 1024) buffered = '';
        controller.enqueue(chunk);
      },
      flush() {
        buffered += decoder.decode();
        if (summary.contentType.includes('text/event-stream')) inspectEvent(buffered);
        else {
          try {
            inspect(JSON.parse(buffered));
          } catch {
            /* No raw data is reported. */
          }
        }
        buffered = '';
        summary.complete = true;
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function startKimiToolProxy(
  input: { baseUrl?: string; live?: boolean; provider?: string; observeUpstream?: boolean } = {},
) {
  const raw = defaultConfigV2(`/tmp/kimi-tools-${process.pid}.json`, 'kimi-tools-fixture');
  raw.admin.enabled = false;
  const upstreamModel = input.live ? (process.env.KIMI_CODE_LIVE_MODEL ?? 'kimi-for-coding') : 'kimi-for-coding';
  raw.upstreams.push({
    id: 'kimi-tool-upstream',
    name: 'Kimi tool fixture',
    provider: input.provider ?? 'kimi',
    protocol: 'anthropic',
    enabled: true,
    baseUrl: input.baseUrl ?? 'https://api.kimi.com/coding/v1',
    endpoints: { generate: 'messages' },
    auth: { mode: 'x-api-key' },
    credentials: [
      {
        id: 'kimi-tool-key',
        label: 'Tool fixture',
        enabled: true,
        secret: input.live
          ? { type: 'env', name: 'KIMI_CODE_API_KEY' }
          : { type: 'inline', value: 'local-upstream-fixture' },
      },
    ],
    models: [
      {
        id: upstreamModel,
        enabled: true,
        capabilities: { text: 'supported', tools: 'supported', thinking: 'supported' },
        capabilitiesSource: 'manual',
      },
    ],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  raw.routes.push({
    id: TOOL_MODEL,
    name: TOOL_MODEL,
    enabled: true,
    clientProtocols: ['openai'],
    match: { kind: 'exact', value: TOOL_MODEL },
    order: 0,
    publishedModels: [TOOL_MODEL],
    targets: [{ upstreamId: 'kimi-tool-upstream', model: upstreamModel }],
  });
  raw.proxyKeys.push({
    name: 'Tool fixture',
    enabled: true,
    createdAt: new Date().toISOString(),
    keyHash: createHash('sha256').update(PROXY_KEY).digest('hex'),
    keyPrefix: 'local-tool-fixture',
  });
  const runtime = await compileRuntimeConfig(raw);
  const upstreamSummaries: NativeToolSummary[] = [];
  const originalFetch = globalThis.fetch;
  if (input.observeUpstream) {
    const upstreamBase = input.baseUrl ?? 'https://api.kimi.com/coding/v1';
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (!target.startsWith(`${upstreamBase}/`)) return response;
      const summary: NativeToolSummary = {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: 0,
        events: {},
        blocks: {},
        stopReasons: [],
        finishReasons: [],
        complete: false,
      };
      const requestBytes = init?.body;
      const requestText =
        typeof requestBytes === 'string'
          ? requestBytes
          : requestBytes instanceof Uint8Array
            ? new TextDecoder().decode(requestBytes)
            : null;
      if (requestText !== null) {
        try {
          const request = JSON.parse(requestText);
          if (typeof request.thinking?.type === 'string') summary.thinkingType = request.thinking.type;
          if (typeof request.tool_choice?.type === 'string') summary.toolChoiceType = request.tool_choice.type;
          if (typeof request.tool_choice?.name === 'string') summary.toolChoiceName = request.tool_choice.name;
          if (Array.isArray(request.tools)) {
            summary.toolNames = request.tools
              .map((tool: any) => tool.name)
              .filter((name: unknown): name is string => typeof name === 'string');
            summary.toolSchemaSha256 = createHash('sha256').update(JSON.stringify(request.tools)).digest('hex');
            summary.selectedToolDeclared =
              (request.tool_choice?.type === 'any' && request.tools.length === 1) ||
              request.tools.some((tool: any) => tool.name === request.tool_choice?.name);
          }
          summary.requestedStream = request.stream === true;
          delete request.stream;
          summary.requestSha256IgnoringStream = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        } catch {
          /* No request content enters diagnostics. */
        }
      }
      upstreamSummaries.push(summary);
      return observeNativeToolResponse(response, summary);
    };
  }
  const store = new RuntimeConfigStore('/tmp/kimi-tools-unused.json', runtime);
  const server = http.createServer((req, res) => {
    void proxyHandler(req, res, store, () => {}, { maxRetries: 1, requestTimeoutMs: 60_000 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    upstreamSummaries,
    async request(body: Record<string, unknown>) {
      return fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(65_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${PROXY_KEY}` },
        body: JSON.stringify({ model: TOOL_MODEL, max_completion_tokens: 1024, ...body }),
      });
    },
    async close() {
      if (input.observeUpstream) globalThis.fetch = originalFetch;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

export async function readToolResponse(response: Response, streaming: boolean) {
  if (!streaming) {
    const body = (await response.json()) as { choices: Array<{ message: ToolMessage; finish_reason: string }> };
    return { message: body.choices[0].message, finishReason: body.choices[0].finish_reason, done: true };
  }
  assert.ok(response.body, 'Expected a streaming response body');
  const message: ToolMessage = { role: 'assistant', content: null };
  const tools: NonNullable<ToolMessage['tool_calls']> = [];
  let finishReason = '';
  let done = false;
  for await (const event of parseSseStream(response.body)) {
    if (event.data === '[DONE]') {
      done = true;
      continue;
    }
    const chunk = JSON.parse(event.data);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') message.content = (message.content ?? '') + delta.content;
    if (typeof delta.reasoning_content === 'string') {
      message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content;
    }
    // This is a completed native history snapshot, not an append-only delta.
    if (Array.isArray(delta.anthropic_content)) message.anthropic_content = delta.anthropic_content;
    for (const call of delta.tool_calls ?? []) {
      const current = tools[call.index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      tools[call.index] = current;
    }
  }
  if (tools.length > 0) message.tool_calls = tools;
  return { message, finishReason, done };
}
