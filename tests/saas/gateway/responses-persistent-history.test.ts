import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AesGcmResponsesHistoryCipher } from '../../../src/saas/gateway/responses-continuation-cipher.js';
import { PersistentResponsesContinuationResolver } from '../../../src/saas/gateway/responses-continuation-resolver.js';
import { codexContinuationMode } from '../../../src/saas/gateway/codex/continuation-metadata.js';
import type { ResponsesContinuationHistoryPort, ResponsesHistoryIdentity, ResponsesHistoryRecord } from '../../../src/saas/gateway/responses-continuation-history.js';
const identity: ResponsesHistoryIdentity = { tenantId: 'tenant', projectId: 'project', proxyKeyId: 'key', conversationId: 'conversation', providerId: 'openai-codex', productId: 'codex-chatgpt', accountId: 'account', credentialId: 'credential', credentialVersion: '1', credentialAuthzVersion: '1', publicModel: 'model', resolvedModel: 'model' };
function fixture() {
  let saved: ResponsesHistoryRecord | null = null;
  const history: ResponsesContinuationHistoryPort = {
    async find() { return saved; }, async insert(value) { saved = value; return 'inserted'; }, async delete() { saved = null; }, async purgeExpired() { return 0; },
  };
  const cipher = new AesGcmResponsesHistoryCipher('history-v1', new Map([['history-v1', new Uint8Array(32).fill(7)]]));
  const resolver = new PersistentResponsesContinuationResolver({ history, cipher, maxBytes: 10000, ttlMs: 1000, nowMs: () => 100 });
  return { resolver, cipher, get saved() { return saved; } };
}
test('persisted context is ciphertext and replays full output under authenticated scope', async () => {
  const f = fixture();
  const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', content: 'answer' }];
  assert.equal(await f.resolver.remember({ identity, responseId: 'response', request: { model: 'model', input: 'first' }, output, operation: 'responses' }), true);
  assert.ok(f.saved);
  assert.equal(Buffer.from(f.saved.encryptedContext).includes(Buffer.from('first')), false);
  const resolved = await f.resolver.resolve({ ...identity, responseId: 'response' }, { model: 'model', input: 'next', previous_response_id: 'response' });
  assert.deepEqual(resolved.body.input, [{ role: 'user', content: 'first' }, ...output, { role: 'user', content: 'next' }]);
  assert.equal(codexContinuationMode(resolved.body), 'canonical-replay');
  assert.equal(codexContinuationMode(JSON.parse(JSON.stringify(resolved.body))), 'full');
  assert.throws(() => f.resolver.assertPreparedIdentity(resolved, { ...identity, credentialVersion: '2' }), /resend full context/);
  await assert.rejects(() => f.resolver.resolve({ ...identity, projectId: 'other', responseId: 'response' }, { input: 'next' }), /resend full context/);
  f.cipher.close();
});
test('compact replaces old context using every returned output item', async () => {
  const f = fixture();
  const output = [{ type: 'message', content: 'summary' }, { type: 'compaction', encrypted_content: 'opaque' }];
  await f.resolver.remember({ identity, responseId: 'compact', request: { model: 'model', input: 'old-long-context' }, output, operation: 'responses.compact' });
  const resolved = await f.resolver.resolve({ ...identity, responseId: 'compact' }, { input: 'next' });
  assert.deepEqual(resolved.body.input, [...output, { role: 'user', content: 'next' }]);
  f.cipher.close();
});
test('history cipher authenticates key identity and associated scope', async () => {
  const cipher = new AesGcmResponsesHistoryCipher('history-v1', new Map([['history-v1', new Uint8Array(32).fill(7)]]));
  const sealed = await cipher.seal(new TextEncoder().encode('context'), new TextEncoder().encode('tenant/project/key'));
  await assert.rejects(() => cipher.open(sealed, new TextEncoder().encode('other/project/key')), /authentication failed/);
  const last = sealed.encryptedContext.length - 1;
  sealed.encryptedContext[last] = (sealed.encryptedContext[last] ?? 0) ^ 1;
  await assert.rejects(() => cipher.open(sealed, new TextEncoder().encode('tenant/project/key')), /authentication failed/);
  cipher.close();
});
