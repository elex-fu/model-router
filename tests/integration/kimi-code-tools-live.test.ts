import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executeOpaqueLookup,
  OPAQUE_LOOKUP_PROMPT,
  OPAQUE_LOOKUP_TOOL,
  OPAQUE_LOOKUP_VALUE,
} from './kimi-code-opaque-tool-fixture.js';
import { readToolResponse, startKimiToolProxy } from './kimi-code-tools-helpers.js';

// Explicit opt-in; no provider credentials, thinking text or signatures are
// written to logs or files. Run:
// RUN_KIMI_CODE_TOOLS_LIVE=1 node --test --import tsx tests/integration/kimi-code-tools-live.test.ts
const skip =
  process.env.RUN_KIMI_CODE_TOOLS_LIVE !== '1'
    ? 'Set RUN_KIMI_CODE_TOOLS_LIVE=1 to opt into real Kimi tool rounds'
    : !process.env.KIMI_CODE_API_KEY
      ? 'Set KIMI_CODE_API_KEY'
      : false;

test('real Kimi OpenAI tools: automatic thinking and forced disabled, non-stream and SSE, two turns', {
  skip,
  timeout: 540_000,
}, async (t) => {
  const selectedCase = process.env.KIMI_CODE_TOOLS_CASE;
  if (selectedCase)
    assert.ok(
      ['json-auto', 'json-forced', 'sse-auto', 'sse-forced'].includes(selectedCase),
      'Unknown KIMI_CODE_TOOLS_CASE',
    );
  const diagnostics = process.env.KIMI_CODE_TOOLS_DIAGNOSTICS === '1';
  const proxy = await startKimiToolProxy({ live: true, observeUpstream: diagnostics });
  try {
    // Serialize real requests to keep the provider's rate limit independent
    // of Node's test concurrency and leave all automatic retries disabled.
    for (const streaming of [false, true]) {
      for (const forced of [false, true]) {
        const caseId = `${streaming ? 'sse' : 'json'}-${forced ? 'forced' : 'auto'}`;
        if (selectedCase && selectedCase !== caseId) continue;
        await t.test(
          `${streaming ? 'SSE' : 'JSON'} ${forced ? 'forced, thinking disabled' : 'automatic, thinking enabled'}`,
          async () => {
            const controls = forced ? { reasoning_effort: 'none' } : { thinking: { type: 'enabled' } };
            const initial = [{ role: 'user', content: OPAQUE_LOOKUP_PROMPT }];
            const response = await proxy.request({
              ...controls,
              stream: streaming,
              messages: initial,
              tools: [OPAQUE_LOOKUP_TOOL],
              tool_choice: forced ? { type: 'function', function: { name: OPAQUE_LOOKUP_TOOL.function.name } } : 'auto',
            });
            assert.equal(response.status, 200, 'First Kimi tool turn HTTP status');
            const first = await readToolResponse(response, streaming);
            if (diagnostics)
              t.diagnostic(
                JSON.stringify({
                  caseId,
                  phase: 'first',
                  native: proxy.upstreamSummaries.at(-1),
                  client: {
                    finishReason: first.finishReason,
                    toolCalls: first.message.tool_calls?.length ?? 0,
                    contentChars: first.message.content?.length ?? 0,
                    reasoningChars: first.message.reasoning_content?.length ?? 0,
                  },
                }),
              );
            assert.equal(first.done, true, 'Expected a complete first response');
            assert.equal(first.finishReason, 'tool_calls');
            assert.equal(first.message.tool_calls?.length, 1);
            const call = first.message.tool_calls?.[0];
            assert.ok(call, 'Expected an external lookup tool call');
            const toolResult = executeOpaqueLookup(call);
            if (!forced) {
              assert.ok((first.message.reasoning_content?.length ?? 0) > 0, 'Expected readable thinking');
              assert.ok(
                first.message.anthropic_content?.some((block) => block.type === 'thinking'),
                'Expected native thinking history for replay',
              );
              assert.ok(
                first.message.anthropic_content?.some((block) => block.type === 'tool_use'),
                'Expected ordered native tool history',
              );
            }
            const response2 = await proxy.request({
              ...controls,
              stream: streaming,
              tools: [OPAQUE_LOOKUP_TOOL],
              tool_choice: 'none',
              messages: [...initial, first.message, { role: 'tool', tool_call_id: call.id, content: toolResult }],
            });
            assert.equal(response2.status, 200, 'Second Kimi tool turn HTTP status');
            const second = await readToolResponse(response2, streaming);
            assert.equal(second.done, true, 'Expected a complete second response');
            assert.equal(second.finishReason, 'stop');
            assert.equal(second.message.content?.trim(), OPAQUE_LOOKUP_VALUE);
          },
        );
      }
    }
  } finally {
    await proxy.close();
  }
});
