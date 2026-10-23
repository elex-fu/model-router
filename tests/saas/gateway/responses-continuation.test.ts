import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsesContinuationStore } from '../../../src/saas/gateway/responses-continuation.js';
import type { ResponsesWsPinnedIdentity } from '../../../src/saas/gateway/responses-ws-engine.js';
const pin: ResponsesWsPinnedIdentity = {
  tenantId: 'tenant', proxyKeyId: 'key', providerId: 'openai-codex', accountId: 'account', upstreamModel: 'model',
  publicModel: 'model', upstreamSessionId: null, credentialId: 'credential', credentialVersion: '1', credentialAuthzVersion: '1',
};
test('continuation compiles complete canonical history including all compaction outputs', () => {
  const store = new ResponsesContinuationStore(10000);
  const output = [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'compaction', encrypted_content: 'opaque' }];
  store.remember({ model: 'model', input: 'first' }, { type: 'response.completed', response: { id: 'r1', output } }, pin);
  const resolved = store.resolve({ model: 'model', previous_response_id: 'r1', input: 'next' }, { tenantId: 'tenant', proxyKeyId: 'key', pinned: pin });
  assert.equal(resolved.previous_response_id, undefined);
  assert.deepEqual(resolved.input, [{ role: 'user', content: 'first' }, ...output, { role: 'user', content: 'next' }]);
});
test('unknown, cross-connection, cross-tenant and changed credentials require full context', () => {
  const store = new ResponsesContinuationStore(10000);
  store.remember({ model: 'model', input: 'first' }, { type: 'response.completed', response: { id: 'r1', output: [] } }, pin);
  for (const identity of [
    { tenantId: 'other', proxyKeyId: 'key', pinned: pin },
    { tenantId: 'tenant', proxyKeyId: 'key', pinned: { ...pin, credentialVersion: '2' } },
    { tenantId: 'tenant', proxyKeyId: 'key', pinned: null },
  ]) assert.throws(() => store.resolve({ model: 'model', input: 'next', previous_response_id: 'r1' }, identity), /resend full context/);
  assert.throws(() => new ResponsesContinuationStore(10000).resolve({ model: 'model', input: 'next', previous_response_id: 'r1' }, { tenantId: 'tenant', proxyKeyId: 'key', pinned: pin }), /resend full context/);
});
