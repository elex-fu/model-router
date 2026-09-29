import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';
import { proxyHandler } from '../../src/server/proxy.js';

type Json = Record<string, any>;
type Call = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Json };
type Reply = { status?: number; body: Json | string; contentType?: string };
type Check = (call: Call, index: number) => Reply;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function harness(upstream: Omit<Config['upstreams'][number], 'baseUrl'> & { basePath: string }, check: Check) {
  const calls: Call[] = [];
  const violations: string[] = [];
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Json;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
    } catch {
      violations.push('non-JSON upstream body');
      res.writeHead(400);
      res.end();
      return;
    }
    const call: Call = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
    calls.push(call);
    try {
      const reply = check(call, calls.length - 1);
      res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'strict mock rejected request' }));
    }
  });
  const mockBase = await listen(mock);
  const directory = mkdtempSync(join(tmpdir(), 'mr-provider-matrix-'));
  const path = join(directory, 'config.json');
  const { basePath, ...definition } = upstream;
  const config: Config = {
    server: { port: 0 },
    proxyKeys: [{ name: 'client', key: 'client-secret', enabled: true, createdAt: '2026-01-01T00:00:00Z' }],
    upstreams: [{ ...definition, baseUrl: `${mockBase}${basePath}` }],
  };
  writeFileSync(path, JSON.stringify(config));
  const store = new ConfigStore(path);
  const logs: LogEntry[] = [];
  const proxy = createServer((req, res) => {
    proxyHandler(req, res, store, (entry) => logs.push(entry)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  const proxyBase = await listen(proxy);
  return {
    base: proxyBase,
    calls,
    logs,
    violations,
    close: async () => {
      await close(proxy);
      await close(mock);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function send(base: string, path: string, body: Json) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const openaiReply = {
  id: 'chatcmpl-strict',
  object: 'chat.completion',
  model: 'model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 },
};
const anthropicReply = {
  id: 'msg_strict',
  type: 'message',
  role: 'assistant',
  model: 'model',
  content: [{ type: 'text', text: 'OK' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, output_tokens: 20 },
};

for (const item of [
  {
    name: 'Kimi Platform',
    provider: 'kimi-platform',
    protocol: 'openai',
    basePath: '/v1',
    path: '/v1/chat/completions',
    auth: 'bearer',
  },
  {
    name: 'DeepSeek Chat',
    provider: 'deepseek-chat',
    protocol: 'openai',
    basePath: '',
    path: '/chat/completions',
    auth: 'bearer',
  },
  {
    name: 'custom OpenAI',
    provider: 'custom-openai',
    protocol: 'openai',
    basePath: '/gateway/v1',
    path: '/gateway/v1/chat/completions',
    auth: 'bearer',
  },
  {
    name: 'Kimi Code',
    provider: 'kimi-code',
    protocol: 'anthropic',
    basePath: '/coding/v1',
    path: '/coding/v1/messages',
    auth: 'x-api-key',
  },
  {
    name: 'DeepSeek Messages',
    provider: 'deepseek-anthropic',
    protocol: 'anthropic',
    basePath: '/anthropic/v1',
    path: '/anthropic/v1/messages',
    auth: 'x-api-key',
  },
  {
    name: 'custom Anthropic',
    provider: 'custom-anthropic',
    protocol: 'anthropic',
    basePath: '/custom/v1',
    path: '/custom/v1/messages',
    auth: 'x-api-key',
  },
  {
    name: 'custom Responses',
    provider: 'custom-responses',
    protocol: 'responses',
    basePath: '/v1',
    path: '/v1/responses',
    auth: 'bearer',
  },
] as const) {
  test(`${item.name}: strict URL, authentication, request fields and nonstream usage`, async () => {
    const responses = item.protocol === 'responses';
    const anthropic = item.protocol === 'anthropic';
    const upstream = await harness(
      {
        name: item.name,
        provider: item.provider,
        protocol: item.protocol,
        basePath: item.basePath,
        apiKeys: ['upstream-secret'],
        models: ['model'],
        enabled: true,
      },
      (call) => {
        assert.equal(call.method, 'POST');
        assert.equal(call.url, item.path);
        assert.equal(call.headers.authorization, item.auth === 'bearer' ? 'Bearer upstream-secret' : undefined);
        assert.equal(call.headers['x-api-key'], item.auth === 'x-api-key' ? 'upstream-secret' : undefined);
        if (anthropic) assert.equal(call.headers['anthropic-version'], '2023-06-01');
        assert.equal(call.body.model, 'model');
        if (responses) assert.equal(call.body.input, 'hello');
        else {
          assert.equal(call.body.messages[0].content, 'hello');
          if (anthropic) assert.equal(call.body.max_tokens, 32);
        }
        return {
          body: responses
            ? { id: 'resp_strict', object: 'response', output: [], usage: { input_tokens: 100, output_tokens: 20 } }
            : anthropic
              ? anthropicReply
              : openaiReply,
        };
      },
    );
    try {
      const path = responses ? '/v1/responses' : anthropic ? '/v1/messages' : '/v1/chat/completions';
      const request = responses
        ? { model: 'model', input: 'hello' }
        : anthropic
          ? { model: 'model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }
          : { model: 'model', messages: [{ role: 'user', content: 'hello' }] };
      const response = await send(upstream.base, path, request);
      assert.equal(response.status, 200, `${item.name}: ${await response.clone().text()}`);
      const result = (await response.json()) as Json;
      assert.equal(result.id, responses ? 'resp_strict' : anthropic ? 'msg_strict' : 'chatcmpl-strict');
      assert.equal(upstream.calls.length, 1);
      assert.deepEqual(upstream.violations, []);
      assert.equal(upstream.logs.at(-1)?.response_tokens, 20);
      assert.equal(upstream.logs.at(-1)?.request_tokens, anthropic ? 110 : 100);
    } finally {
      await upstream.close();
    }
  });
}

for (const item of [
  { name: 'Kimi Code', provider: 'kimi-code', basePath: '/coding/v1', target: '/coding/v1/messages' },
  {
    name: 'DeepSeek Messages',
    provider: 'deepseek-anthropic',
    basePath: '/anthropic/v1',
    target: '/anthropic/v1/messages',
  },
  { name: 'custom Anthropic', provider: 'custom-anthropic', basePath: '/custom/v1', target: '/custom/v1/messages' },
] as const) {
  test(`${item.name}: native tool IDs and SSE lifecycle are preserved`, async () => {
    const upstream = await harness(
      {
        name: item.name,
        provider: item.provider,
        protocol: 'anthropic',
        basePath: item.basePath,
        apiKeys: ['native-key'],
        models: ['model'],
        enabled: true,
      },
      (call, index) => {
        assert.equal(call.url, item.target);
        assert.equal(call.headers['x-api-key'], 'native-key');
        assert.equal(call.headers.authorization, undefined);
        assert.equal(call.body.model, 'model');
        assert.deepEqual(call.body.tools, [
          { name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } },
        ]);
        if (index === 0) {
          assert.equal(call.body.stream, undefined);
          return {
            body: {
              ...anthropicReply,
              content: [{ type: 'tool_use', id: 'toolu_123', name: 'lookup', input: {} }],
              stop_reason: 'tool_use',
            },
          };
        }
        assert.equal(call.body.stream, true);
        assert.deepEqual(call.body.messages[0].content, [
          { type: 'tool_result', tool_use_id: 'toolu_123', content: 'found' },
        ]);
        return {
          contentType: 'text/event-stream',
          body: [
            'event: message_start\ndata: ' +
              JSON.stringify({
                type: 'message_start',
                message: {
                  id: 'msg_stream',
                  type: 'message',
                  role: 'assistant',
                  usage: { input_tokens: 40, output_tokens: 0 },
                },
              }),
            'event: content_block_start\ndata: ' +
              JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            'event: content_block_delta\ndata: ' +
              JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }),
            'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }),
            'event: message_delta\ndata: ' +
              JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 3 },
              }),
            'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }),
            '',
          ].join('\n\n'),
        };
      },
    );
    const tools = [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }];
    try {
      const first = await send(upstream.base, '/v1/messages', {
        model: 'model',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'lookup' }],
        tools,
      });
      assert.equal(first.status, 200);
      const initial = (await first.json()) as Json;
      assert.equal(initial.content[0].id, 'toolu_123');
      assert.equal(initial.stop_reason, 'tool_use');
      const second = await send(upstream.base, '/v1/messages', {
        model: 'model',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'found' }] }],
        tools,
      });
      assert.equal(second.status, 200);
      assert.match(second.headers.get('content-type') ?? '', /text\/event-stream/);
      const stream = await second.text();
      for (const event of [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ])
        assert.match(stream, new RegExp(`event: ${event}`));
      assert.match(stream, /"text":"done"/);
      assert.equal(upstream.calls.length, 2);
      assert.deepEqual(upstream.violations, []);
    } finally {
      await upstream.close();
    }
  });
}

test('DeepSeek reasoning_content survives a real two-turn proxy exchange', async () => {
  const upstream = await harness(
    {
      name: 'DeepSeek Chat',
      provider: 'deepseek-chat',
      protocol: 'openai',
      basePath: '',
      apiKeys: ['reasoning-key'],
      models: ['deepseek-reasoner'],
      enabled: true,
    },
    (call, index) => {
      assert.equal(call.url, '/chat/completions');
      assert.equal(call.headers.authorization, 'Bearer reasoning-key');
      if (index === 1) {
        assert.equal(call.body.messages[0].role, 'assistant');
        assert.equal(call.body.messages[0].reasoning_content, 'chain-one');
        assert.equal(call.body.messages[0].content, 'answer-one');
      }
      return {
        body: {
          ...openaiReply,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: index ? 'answer-two' : 'answer-one',
                reasoning_content: index ? 'chain-two' : 'chain-one',
              },
              finish_reason: 'stop',
            },
          ],
        },
      };
    },
  );
  try {
    const first = await send(upstream.base, '/v1/chat/completions', {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'first' }],
    });
    assert.equal(first.status, 200);
    const initial = (await first.json()) as Json;
    assert.equal(initial.choices[0].message.reasoning_content, 'chain-one');
    const second = await send(upstream.base, '/v1/chat/completions', {
      model: 'deepseek-reasoner',
      messages: [initial.choices[0].message, { role: 'user', content: 'continue' }],
    });
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as Json).choices[0].message.reasoning_content, 'chain-two');
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.violations, []);
    assert.equal(upstream.logs.at(-1)?.cache_read_tokens, 60);
  } finally {
    await upstream.close();
  }
});

for (const provider of ['custom-openai', 'openai-compatible'] as const) {
  test(`${provider} Responses compact is rejected without an explicit endpoint`, async () => {
    const upstream = await harness(
      {
        name: provider,
        provider,
        protocol: 'openai',
        basePath: '/v1',
        apiKeys: ['openai-key'],
        models: ['model'],
        enabled: true,
      },
      () => {
        throw new Error('compact reached upstream unexpectedly');
      },
    );
    try {
      const response = await send(upstream.base, '/v1/responses/compact', { model: 'model', input: 'hello' });
      assert.equal(response.status, 422);
      assert.equal(((await response.json()) as Json).error.type, 'unsupported_capability');
      assert.equal(upstream.calls.length, 0);
      assert.deepEqual(upstream.violations, []);
    } finally {
      await upstream.close();
    }
  });
}

test('native Responses compact uses its explicitly configured endpoint', async () => {
  const upstream = await harness(
    {
      name: 'Responses',
      provider: 'custom-responses',
      protocol: 'responses',
      basePath: '/v1',
      compactEndpoint: 'responses/compact-custom',
      apiKeys: ['responses-key'],
      models: ['model'],
      enabled: true,
    },
    (call) => {
      assert.equal(call.url, '/v1/responses/compact-custom');
      assert.equal(call.headers.authorization, 'Bearer responses-key');
      return { body: { id: 'compact-result', object: 'response', model: 'model', output: [] } };
    },
  );
  try {
    const response = await send(upstream.base, '/v1/responses/compact', { model: 'model', input: 'hello' });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.violations, []);
  } finally {
    await upstream.close();
  }
});

for (const item of [
  { name: 'Kimi Platform', provider: 'kimi-platform', basePath: '/v1', target: '/v1/chat/completions' },
  { name: 'DeepSeek Chat', provider: 'deepseek-chat', basePath: '', target: '/chat/completions' },
  { name: 'custom OpenAI', provider: 'custom-openai', basePath: '/custom/v1', target: '/custom/v1/chat/completions' },
] as const) {
  test(`${item.name}: SSE terminates and tail usage is measured`, async () => {
    const upstream = await harness(
      {
        name: item.name,
        provider: item.provider,
        protocol: 'openai',
        basePath: item.basePath,
        apiKeys: ['stream-key'],
        models: ['model'],
        enabled: true,
      },
      (call) => {
        assert.equal(call.url, item.target);
        assert.equal(call.headers.authorization, 'Bearer stream-key');
        assert.equal(call.headers.accept, 'text/event-stream');
        assert.equal(call.body.stream, true);
        return {
          contentType: 'text/event-stream',
          body: [
            'data: ' + JSON.stringify({ choices: [{ delta: { content: 'streamed' } }] }),
            'data: ' +
              JSON.stringify({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 },
              }),
            'data: [DONE]',
            '',
          ].join('\n\n'),
        };
      },
    );
    try {
      const response = await send(upstream.base, '/v1/chat/completions', {
        model: 'model',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await response.text();
      assert.match(text, /streamed/);
      assert.match(text, /\[DONE\]/);
      assert.equal(upstream.calls.length, 1);
      assert.deepEqual(upstream.violations, []);
      assert.equal(upstream.logs.at(-1)?.request_tokens, 10);
      assert.equal(upstream.logs.at(-1)?.response_tokens, 2);
      assert.equal(upstream.logs.at(-1)?.cache_read_tokens, 4);
    } finally {
      await upstream.close();
    }
  });
}

test('custom Responses native tool call ID and SSE completion usage survive unchanged', async () => {
  const upstream = await harness(
    {
      name: 'Responses',
      provider: 'custom-responses',
      protocol: 'responses',
      basePath: '/v1',
      apiKeys: ['responses-key'],
      models: ['model'],
      enabled: true,
    },
    (call, index) => {
      assert.equal(call.url, '/v1/responses');
      assert.equal(call.headers.authorization, 'Bearer responses-key');
      assert.equal(call.body.model, 'model');
      if (index === 0) {
        assert.deepEqual(call.body.tools, [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }]);
        return {
          body: {
            id: 'resp_tool',
            object: 'response',
            model: 'model',
            output: [{ type: 'function_call', call_id: 'call_123', name: 'lookup', arguments: '{}' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        };
      }
      assert.equal(call.body.stream, true);
      assert.equal(call.body.input[0].call_id, 'call_123');
      return {
        contentType: 'text/event-stream',
        body: [
          'event: response.created\ndata: ' +
            JSON.stringify({ type: 'response.created', response: { id: 'resp_stream', model: 'model' } }),
          'event: response.output_text.delta\ndata: ' +
            JSON.stringify({ type: 'response.output_text.delta', delta: 'done' }),
          'event: response.completed\ndata: ' +
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_stream', usage: { input_tokens: 7, output_tokens: 3 } },
            }),
          '',
        ].join('\n\n'),
      };
    },
  );
  try {
    const first = await send(upstream.base, '/v1/responses', {
      model: 'model',
      input: 'lookup',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    });
    assert.equal(first.status, 200);
    const reply = (await first.json()) as Json;
    assert.equal(reply.output[0].call_id, 'call_123');
    const second = await send(upstream.base, '/v1/responses', {
      model: 'model',
      stream: true,
      input: [{ type: 'function_call_output', call_id: reply.output[0].call_id, output: 'found' }],
    });
    assert.equal(second.status, 200);
    const events = await second.text();
    assert.match(events, /response\.completed/);
    assert.match(events, /done/);
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.violations, []);
    assert.equal(upstream.logs.at(-1)?.request_tokens, 7);
    assert.equal(upstream.logs.at(-1)?.response_tokens, 3);
  } finally {
    await upstream.close();
  }
});

test('Kimi Platform OpenAI upstream bridges Messages tool IDs, usage and SSE lifecycle', async () => {
  const upstream = await harness(
    {
      name: 'Kimi Platform',
      provider: 'kimi-platform',
      protocol: 'openai',
      basePath: '/v1',
      apiKeys: ['kimi-bridge-key'],
      models: ['model'],
      enabled: true,
    },
    (call, index) => {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, '/v1/chat/completions');
      assert.equal(call.headers.authorization, 'Bearer kimi-bridge-key');
      assert.equal(call.headers['x-api-key'], undefined);
      assert.equal(call.body.model, 'model');
      assert.equal(call.body.max_tokens, 32);
      assert.equal(call.body.stream_options, undefined);
      assert.deepEqual(call.body.tools, [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } },
        },
      ]);
      if (index === 0) {
        assert.deepEqual(call.body.messages, [{ role: 'user', content: 'lookup' }]);
        assert.equal(call.body.stream, undefined);
        return {
          body: {
            ...openaiReply,
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'kimi_call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
                  ],
                },
              },
            ],
          },
        };
      }
      assert.deepEqual(call.body.messages, [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'kimi_call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'kimi_call_1', content: 'found' },
      ]);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.stream_options, undefined);
      return {
        contentType: 'text/event-stream',
        body: [
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl_kimi_stream',
              model: 'model',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
            }),
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl_kimi_stream',
              model: 'model',
              choices: [],
              usage: { prompt_tokens: 11, completion_tokens: 3 },
            }),
          'data: [DONE]',
          '',
        ].join('\n\n'),
      };
    },
  );
  try {
    const first = await send(upstream.base, '/v1/messages', {
      model: 'model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(first.status, 200, `${await first.clone().text()} ${upstream.violations.join('; ')}`);
    const firstBody = (await first.json()) as Json;
    assert.equal(firstBody.content[0].id, 'kimi_call_1');
    assert.deepEqual(firstBody.content[0].input, { q: 'x' });
    assert.deepEqual(firstBody.usage, { input_tokens: 100, output_tokens: 20 });

    const second = await send(upstream.base, '/v1/messages', {
      model: 'model',
      max_tokens: 32,
      stream: true,
      messages: [
        { role: 'user', content: 'lookup' },
        { role: 'assistant', content: firstBody.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'kimi_call_1', content: 'found' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(second.status, 200, `${await second.clone().text()} ${upstream.violations.join('; ')}`);
    assert.match(second.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = await second.text();
    assert.match(stream, /event: message_start/);
    assert.match(stream, /event: content_block_delta/);
    assert.match(stream, /"text":"done"/);
    assert.match(stream, /event: message_delta/);
    assert.match(stream, /"output_tokens":3/);
    assert.match(stream, /event: message_stop/);
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.violations, []);
    assert.equal(upstream.logs.at(-1)?.request_tokens, 11);
    assert.equal(upstream.logs.at(-1)?.response_tokens, 3);
  } finally {
    await upstream.close();
  }
});

test('custom OpenAI upstream bridges Messages tool IDs, usage and SSE lifecycle', async () => {
  const upstream = await harness(
    {
      name: 'custom OpenAI',
      provider: 'custom-openai',
      protocol: 'openai',
      basePath: '/gateway/v1',
      apiKeys: ['custom-openai-bridge-key'],
      models: ['model'],
      enabled: true,
    },
    (call, index) => {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, '/gateway/v1/chat/completions');
      assert.equal(call.headers.authorization, 'Bearer custom-openai-bridge-key');
      assert.equal(call.headers['x-api-key'], undefined);
      assert.equal(call.body.model, 'model');
      assert.equal(call.body.max_tokens, 24);
      assert.deepEqual(call.body.tools, [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } },
        },
      ]);
      if (index === 0) {
        assert.deepEqual(call.body.messages, [{ role: 'user', content: 'lookup' }]);
        return {
          body: {
            ...openaiReply,
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'custom_call_7', type: 'function', function: { name: 'lookup', arguments: '{"n":7}' } },
                  ],
                },
              },
            ],
          },
        };
      }
      assert.deepEqual(call.body.messages, [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'custom_call_7', type: 'function', function: { name: 'lookup', arguments: '{"n":7}' } }],
        },
        { role: 'tool', tool_call_id: 'custom_call_7', content: 'seven' },
      ]);
      assert.equal(call.body.stream, true);
      return {
        contentType: 'text/event-stream',
        body: [
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl_custom_stream',
              model: 'model',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'bridged' }, finish_reason: null }],
            }),
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl_custom_stream',
              model: 'model',
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            }),
          'data: [DONE]',
          '',
        ].join('\n\n'),
      };
    },
  );
  try {
    const first = await send(upstream.base, '/v1/messages', {
      model: 'model',
      max_tokens: 24,
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(first.status, 200, `${await first.clone().text()} ${upstream.violations.join('; ')}`);
    const firstBody = (await first.json()) as Json;
    assert.equal(firstBody.content[0].id, 'custom_call_7');
    assert.deepEqual(firstBody.content[0].input, { n: 7 });
    assert.deepEqual(firstBody.usage, { input_tokens: 100, output_tokens: 20 });

    const second = await send(upstream.base, '/v1/messages', {
      model: 'model',
      max_tokens: 24,
      stream: true,
      messages: [
        { role: 'user', content: 'lookup' },
        { role: 'assistant', content: firstBody.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'custom_call_7', content: 'seven' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(second.status, 200, `${await second.clone().text()} ${upstream.violations.join('; ')}`);
    assert.match(second.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = await second.text();
    assert.match(stream, /event: message_start/);
    assert.match(stream, /event: content_block_delta/);
    assert.match(stream, /"text":"bridged"/);
    assert.match(stream, /event: message_delta/);
    assert.match(stream, /"output_tokens":2/);
    assert.match(stream, /event: message_stop/);
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.violations, []);
    assert.equal(upstream.logs.at(-1)?.request_tokens, 8);
    assert.equal(upstream.logs.at(-1)?.response_tokens, 2);
  } finally {
    await upstream.close();
  }
});

test('custom Anthropic upstream bridges Chat tool IDs, usage and SSE lifecycle', async () => {
  const upstream = await harness(
    {
      name: 'custom Anthropic',
      provider: 'custom-anthropic',
      protocol: 'anthropic',
      basePath: '/custom/v1',
      apiKeys: ['custom-anthropic-bridge-key'],
      models: ['model'],
      enabled: true,
    },
    (call, index) => {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, '/custom/v1/messages');
      assert.equal(call.headers['x-api-key'], 'custom-anthropic-bridge-key');
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers['anthropic-version'], '2023-06-01');
      assert.equal(call.body.model, 'model');
      assert.equal(call.body.max_tokens, 32);
      assert.deepEqual(call.body.tools, [
        { name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } },
      ]);
      if (index === 0) {
        assert.deepEqual(call.body.messages, [{ role: 'user', content: 'lookup' }]);
        return {
          body: {
            ...anthropicReply,
            content: [{ type: 'tool_use', id: 'anth_call_9', name: 'lookup', input: { k: 9 } }],
            stop_reason: 'tool_use',
          },
        };
      }
      assert.deepEqual(call.body.messages, [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'anth_call_9', name: 'lookup', input: { k: 9 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anth_call_9', content: 'nine' }] },
      ]);
      assert.equal(call.body.stream, true);
      return {
        contentType: 'text/event-stream',
        body: [
          'event: message_start\ndata: ' +
            JSON.stringify({
              type: 'message_start',
              message: {
                id: 'msg_custom_stream',
                type: 'message',
                role: 'assistant',
                model: 'model',
                usage: { input_tokens: 12, output_tokens: 0 },
              },
            }),
          'event: content_block_start\ndata: ' +
            JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          'event: content_block_delta\ndata: ' +
            JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bridged' } }),
          'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }),
          'event: message_delta\ndata: ' +
            JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
          'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }),
          '',
        ].join('\n\n'),
      };
    },
  );
  try {
    const first = await send(upstream.base, '/v1/chat/completions', {
      model: 'model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'lookup' }],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    assert.equal(first.status, 200, `${await first.clone().text()} ${upstream.violations.join('; ')}`);
    const firstBody = (await first.json()) as Json;
    assert.equal(firstBody.choices[0].finish_reason, 'tool_calls');
    assert.equal(firstBody.choices[0].message.tool_calls[0].id, 'anth_call_9');
    assert.deepEqual(JSON.parse(firstBody.choices[0].message.tool_calls[0].function.arguments), { k: 9 });
    assert.deepEqual(firstBody.usage, { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });

    const second = await send(upstream.base, '/v1/chat/completions', {
      model: 'model',
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
      messages: [firstBody.choices[0].message, { role: 'tool', tool_call_id: 'anth_call_9', content: 'nine' }],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    assert.equal(second.status, 200, `${await second.clone().text()} ${upstream.violations.join('; ')}`);
    assert.match(second.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = await second.text();
    assert.match(stream, /data: \[DONE\]/);
    assert.match(stream, /"content":"bridged"/);
    const frames = stream.split(/\n\n/).flatMap((event) => {
      const data = event.match(/^data: (.+)$/m)?.[1];
      return data && data !== '[DONE]' ? [JSON.parse(data) as Json] : [];
    });
    const usageFrame = frames.find((frame) => frame.choices.length === 0 && frame.usage);
    assert.deepEqual(usageFrame?.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    assert.ok(stream.indexOf(JSON.stringify(usageFrame)) < stream.indexOf('data: [DONE]'));
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.violations, []);
    assert.equal(upstream.logs.at(-1)?.request_tokens, 12);
    assert.equal(upstream.logs.at(-1)?.response_tokens, 4);
  } finally {
    await upstream.close();
  }
});

for (const item of [
  { name: 'Kimi Platform', provider: 'kimi-platform', basePath: '/v1', target: '/v1/chat/completions' },
  { name: 'DeepSeek Chat', provider: 'deepseek-chat', basePath: '', target: '/chat/completions' },
  { name: 'custom OpenAI', provider: 'custom-openai', basePath: '/custom/v1', target: '/custom/v1/chat/completions' },
] as const) {
  test(`${item.name}: OpenAI tool call ID survives assistant/tool continuation`, async () => {
    const upstream = await harness(
      {
        name: item.name,
        provider: item.provider,
        protocol: 'openai',
        basePath: item.basePath,
        apiKeys: ['tool-key'],
        models: ['model'],
        enabled: true,
      },
      (call, index) => {
        assert.equal(call.url, item.target);
        assert.equal(call.headers.authorization, 'Bearer tool-key');
        assert.equal(call.body.model, 'model');
        if (index === 0) {
          assert.equal(call.body.tools[0].function.name, 'lookup');
          return {
            body: {
              ...openaiReply,
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      { id: 'call_abc', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
                    ],
                  },
                },
              ],
            },
          };
        }
        assert.equal(call.body.messages[0].tool_calls[0].id, 'call_abc');
        assert.equal(call.body.messages[1].tool_call_id, 'call_abc');
        assert.equal(call.body.messages[1].content, 'found');
        return { body: openaiReply };
      },
    );
    try {
      const first = await send(upstream.base, '/v1/chat/completions', {
        model: 'model',
        messages: [{ role: 'user', content: 'lookup' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      });
      assert.equal(first.status, 200);
      const reply = (await first.json()) as Json;
      assert.equal(reply.choices[0].message.tool_calls[0].id, 'call_abc');
      const second = await send(upstream.base, '/v1/chat/completions', {
        model: 'model',
        messages: [reply.choices[0].message, { role: 'tool', tool_call_id: 'call_abc', content: 'found' }],
      });
      assert.equal(second.status, 200);
      assert.equal(((await second.json()) as Json).choices[0].message.content, 'OK');
      assert.equal(upstream.calls.length, 2);
      assert.deepEqual(upstream.violations, []);
    } finally {
      await upstream.close();
    }
  });
}
