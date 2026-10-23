import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCompletionsUsage, anthropicUsageFields } from '../../../../src/saas/gateway/codex/response-bridge.js';
import { ResponsesUsageWatcher, codexUsageToObservedUsage } from '../../../../src/saas/gateway/codex/transport.js';

function feed(watcher: ResponsesUsageWatcher, event: unknown): void {
  watcher.feed(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}
test('Codex missing token fields are unknown; explicit zero remains reported', () => {
  assert.equal(codexUsageToObservedUsage({ inputTokens: null, outputTokens: 1, cachedTokens: null, reasoningTokens: null }), null);
  assert.equal(codexUsageToObservedUsage({ inputTokens: 1, outputTokens: null, cachedTokens: null, reasoningTokens: null }), null);
  assert.notEqual(codexUsageToObservedUsage({ inputTokens: 0, outputTokens: 0, cachedTokens: null, reasoningTokens: null }), null);
});
for (const status of ['completed', 'incomplete', 'failed']) {
  test(`Codex ${status} preserves terminal usage independently from execution status`, () => {
    const watcher = new ResponsesUsageWatcher();
    feed(watcher, { type: `response.${status}`, response: { status, usage: { input_tokens: 5, output_tokens: 3 } } });
    assert.equal(watcher.observed?.inputTokens, 5);
    assert.equal(watcher.completeness, 'complete');
  });
}
test('Codex conflicting terminal, partial usage and truncation never prove complete evidence', () => {
  const partial = new ResponsesUsageWatcher();
  feed(partial, { type: 'response.completed', response: { usage: { input_tokens: 5 } } });
  assert.equal(partial.completeness, 'incomplete-missing');
  const conflict = new ResponsesUsageWatcher();
  feed(conflict, { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } });
  feed(conflict, { type: 'response.failed', response: { usage: { input_tokens: 9, output_tokens: 3 } } });
  assert.equal(conflict.observed, null);
  assert.equal(conflict.completeness, 'incomplete-malformed');
  const truncated = new ResponsesUsageWatcher();
  truncated.feed(new TextEncoder().encode('data: {"type":"response.completed"'));
  assert.equal(truncated.completeness, 'incomplete-truncated');
});

test('compatibility usage fields do not invent zero counters', () => {
  const partial = { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null };
  assert.deepEqual(chatCompletionsUsage(partial), {});
  assert.deepEqual(anthropicUsageFields(partial), { cache_creation_input_tokens: 0 });
});
