import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuiltinUsageUpperBoundEstimator } from '../../../src/saas/runtime/builtin-usage-bounds.js';

function estimate(
  body: unknown,
  options = { maxInputTokens: 8192, maxOutputTokens: 128 },
  native = 'anthropic',
  providerId = 'kimi',
  normalizedBody = body,
) {
  return createBuiltinUsageUpperBoundEstimator(options).estimate({
    normalizedRequest: { body: normalizedBody, providerProtocol: native, providerId },
    compiledPayloadBytes: Buffer.from(JSON.stringify(body)),
  } as never) as { inputTotalUpperBound: number; outputTotalUpperBound: number };
}

test('an arbitrarily lowered input ceiling cannot authorize a larger prompt hold', () => {
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 };
  assert.throws(() => estimate(body, { maxInputTokens: 1, maxOutputTokens: 128 }), /usage bound is unavailable/);
  const needed = Buffer.byteLength(JSON.stringify(body)) * 2 + 4096;
  assert.throws(
    () => estimate(body, { maxInputTokens: needed - 1, maxOutputTokens: 128 }),
    /usage bound is unavailable/,
  );
  assert.equal(estimate(body, { maxInputTokens: needed, maxOutputTokens: 128 }).inputTotalUpperBound, needed);
  assert.throws(
    () => estimate({ ...body, messages: [{ role: 'user', content: 'x'.repeat(10000) }] }),
    /usage bound is unavailable/,
  );
});

test('bounds inspect final compiled bytes and native output fields rather than the smaller client body', () => {
  assert.throws(
    () =>
      estimate(
        { model: 'model-a', messages: [{ role: 'user', content: 'x'.repeat(10000) }], max_tokens: 8 },
        undefined,
        'anthropic',
        'kimi',
        { max_tokens: 8 },
      ),
    /usage bound is unavailable/,
  );
  const gemini = {
    model: 'model-a',
    max_tokens: 1,
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    generationConfig: { maxOutputTokens: 32 },
  };
  assert.throws(
    () => estimate(gemini, { maxInputTokens: 8192, maxOutputTokens: 16 }, 'gemini', 'google-gemini'),
    /usage bound is unavailable/,
  );
  assert.equal(
    estimate(gemini, { maxInputTokens: 8192, maxOutputTokens: 64 }, 'gemini', 'google-gemini').outputTotalUpperBound,
    32,
  );
  assert.throws(() => estimate({ model: 'model-a', messages: [] }), /usage bound is unavailable/);
});

test('remote history, multimedia resources and opaque compact context require trusted model bounds', () => {
  for (const extra of [
    { previous_response_id: 'response-a' },
    { conversation: 'conversation-a' },
    { cachedContent: 'cached-a' },
    { input: [{ type: 'compaction', encrypted_content: 'opaque-a' }] },
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
      ],
    },
    { tools: [{ type: 'web_search_preview' }] },
  ])
    assert.throws(
      () => estimate({ model: 'model-a', max_output_tokens: 8, ...extra }, undefined, 'responses', 'opencode-go'),
      /usage bound is unavailable/,
    );
  assert.throws(
    () => estimate({ model: 'model-a', input: [], stream: true }, undefined, 'responses', 'openai-codex'),
    /usage bound is unavailable/,
  );
});

test('local function schemas and arguments may use resource-like property names', () => {
  const body = {
    model: 'model-a',
    max_tokens: 16,
    tools: [
      {
        name: 'lookup',
        input_schema: {
          type: 'object',
          properties: { file_id: { type: 'string' }, conversation: { type: 'string' }, image_url: { type: 'string' } },
        },
      },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'lookup',
            id: 'call-a',
            input: { file_id: 'local-reference', conversation: 'local-text' },
          },
        ],
      },
    ],
  };
  assert.equal(estimate(body).outputTotalUpperBound, 16);
});

function nativeRequest(native: string, extra: Record<string, unknown>): Record<string, unknown> {
  const output =
    native === 'anthropic'
      ? { messages: [], max_tokens: 16 }
      : native === 'openai'
        ? { messages: [], max_completion_tokens: 16 }
        : native === 'gemini'
          ? { contents: [], generationConfig: { maxOutputTokens: 16 } }
          : { input: [], max_output_tokens: 16 };
  return { model: 'model-a', ...output, ...extra };
}

test('native server tools and unknown future tool kinds cannot use local byte bounds', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ...[
      'web_search_20250305',
      'code_execution_20250522',
      'code_execution_20250825',
      'web_fetch_20250910',
      'mcp_toolset',
      'computer_20250124',
      'future_server_tool_20990101',
    ].map((type) => ['anthropic', { type, name: 'lookup', input_schema: { type: 'object' } }] as const),
    ...[
      'web_search',
      'web_search_preview',
      'file_search',
      'code_interpreter',
      'computer',
      'computer_use_preview',
      'mcp',
      'image_generation',
      'future_server_tool',
    ].map((type) => ['responses', { type, name: 'lookup' }] as const),
    ['openai', { type: 'future_server_tool', function: { name: 'lookup', parameters: {} } }],
    ['gemini', { codeExecution: {} }],
    ['gemini', { googleSearch: {} }],
    ['gemini', { google_search: {} }],
    ['gemini', { retrieval: { vertexAiSearch: { datastore: 'remote-a' } } }],
    ['gemini', { computerUse: {} }],
    ['gemini', { futureServerTool: {} }],
    ['gemini', { functionDeclarations: [{ name: 'lookup' }], googleSearch: {} }],
  ];
  for (const [native, tool] of cases) {
    assert.throws(
      () => estimate(nativeRequest(native, { tools: [tool] }), undefined, native, 'provider-a'),
      /usage bound is unavailable/,
      `${native}: ${JSON.stringify(tool)}`,
    );
  }
});

test('server configuration and non-direct callers fail at request and tool declaration positions', () => {
  const local = { name: 'lookup', input_schema: { type: 'object' } };
  for (const extra of [
    { mcp_servers: [{ type: 'url', name: 'remote-a', url: 'https://example.com/mcp' }] },
    { mcp_servers: [] },
    { mcp_servers: null },
    { container: 'container-a' },
    { container: { type: 'auto' } },
    { server_config: {} },
    { tools: [{ ...local, allowed_callers: ['code_execution_20250825'] }] },
    { tools: [{ ...local, allowed_callers: ['direct', 'future_server_caller'] }] },
    { tools: [{ ...local, allowed_callers: 'direct' }] },
    { tools: [{ ...local, container: 'container-a' }] },
    { tools: [{ ...local, server_url: 'https://example.com/mcp' }] },
    { tools: [{ ...local, connector_id: 'connector-a' }] },
  ]) {
    assert.throws(
      () => estimate(nativeRequest('anthropic', extra)),
      /usage bound is unavailable/,
      JSON.stringify(extra),
    );
  }
  assert.throws(
    () =>
      estimate(
        nativeRequest('openai', {
          tools: [{ type: 'function', function: { name: 'lookup', allowed_callers: ['code_execution_20250825'] } }],
        }),
        undefined,
        'openai',
      ),
    /usage bound is unavailable/,
  );
});

test('each native local tool form preserves schema, name and supplied function data exemptions', () => {
  const schema = {
    type: 'object',
    properties: {
      web_search: { type: 'string' },
      file_id: { type: 'string' },
      container: { type: 'string' },
      mcp_servers: { type: 'array' },
      server_url: { type: 'string' },
      allowed_callers: { type: 'array' },
    },
  };
  const data = {
    type: 'image',
    file_id: 'local-text',
    container: 'local-text',
    mcp_servers: [{ type: 'future_server_tool', server_url: 'local-text' }],
    allowed_callers: ['local-text'],
  };
  const cases: readonly [string, Record<string, unknown>][] = [
    [
      'anthropic',
      {
        tools: [{ name: 'web_search', input_schema: schema, allowed_callers: ['direct'] }],
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', name: 'web_search', id: 'call-a', input: data }] },
        ],
      },
    ],
    ['anthropic', { tools: [{ type: 'custom', name: 'container', input_schema: schema }] }],
    ['openai', { tools: [{ type: 'function', function: { name: 'file_id', parameters: schema } }] }],
    ['openai', { tools: [{ type: 'custom', custom: { name: 'web_search', format: { type: 'text' } } }] }],
    [
      'responses',
      {
        tools: [{ type: 'function', name: 'container', parameters: schema }],
        input: [{ type: 'function_call', name: 'container', call_id: 'call-a', arguments: JSON.stringify(data) }],
      },
    ],
    [
      'responses',
      {
        tools: [{ type: 'custom', name: 'web_search', format: { type: 'text' } }],
        input: [{ type: 'custom_tool_call', name: 'web_search', call_id: 'call-a', input: JSON.stringify(data) }],
      },
    ],
    [
      'gemini',
      {
        tools: [
          {
            functionDeclarations: [
              { name: 'web_search', parameters: schema },
              { name: 'container', parametersJsonSchema: schema, responseJsonSchema: schema },
            ],
          },
        ],
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'web_search', args: data } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'web_search', response: data } }] },
        ],
      },
    ],
  ];
  for (const [native, extra] of cases) {
    assert.equal(
      estimate(nativeRequest(native, extra), undefined, native, 'provider-a').outputTotalUpperBound,
      16,
      native,
    );
  }
});

test('malformed native local tool declarations fail closed', () => {
  for (const [native, tools] of [
    ['anthropic', null],
    ['anthropic', [null]],
    ['anthropic', [{ name: 'lookup' }]],
    ['openai', [{ type: 'function', name: 'lookup', parameters: {} }]],
    ['responses', [{ type: 'function', function: { name: 'lookup' } }]],
    ['gemini', [{ functionDeclarations: [{ name: 'lookup', type: 'future_server_tool' }] }]],
    ['gemini', [{ functionDeclarations: 'lookup' }]],
  ] as const) {
    assert.throws(
      () => estimate(nativeRequest(native, { tools }), undefined, native, 'provider-a'),
      /usage bound is unavailable/,
      native,
    );
  }
});
