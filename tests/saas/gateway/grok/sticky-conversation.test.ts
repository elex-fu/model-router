import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stickySchedulingContext } from '../../../../src/saas/gateway/sticky-session-reference.js';

/**
 * Batch-3 grok addition: the `x-grok-conv-id` request header is a
 * first-class conversation reference (upstream CLI-proxy shard routing keys
 * on it), so a client that presents it gets a sticky scheduling context
 * without any body parsing. This is the one-line source addition to
 * sticky-session-reference.ts; the test pins its behavior.
 */
test('x-grok-conv-id feeds the sticky conversation reference tier', () => {
  const context = stickySchedulingContext({
    protocol: 'openai',
    headers: { 'x-grok-conv-id': 'conv-abc-123' },
    body: {},
    clientIp: null,
    userAgent: null,
    proxyKeyId: 'key-1',
  });
  assert.deepEqual(context, { sessionId: 'conv-abc-123' });

  // The session-id tier still wins when both are present.
  const sessionWins = stickySchedulingContext({
    protocol: 'openai',
    headers: { 'session-id': 'sess-1', 'x-grok-conv-id': 'conv-abc-123' },
    body: {},
    clientIp: null,
    userAgent: null,
    proxyKeyId: 'key-1',
  });
  assert.deepEqual(sessionWins, { sessionId: 'sess-1' });

  // An empty value never produces a reference.
  const none = stickySchedulingContext({
    protocol: 'openai',
    headers: { 'x-grok-conv-id': '   ' },
    body: {},
    clientIp: null,
    userAgent: null,
    proxyKeyId: 'key-1',
  });
  assert.equal(none, undefined);
});
