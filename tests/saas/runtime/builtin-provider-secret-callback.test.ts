import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeBuiltinProviderSecret } from '../../../src/saas/runtime/builtin-provider-secret-callback.js';
import { CodexNativeWsSessionError } from '../../../src/saas/gateway/codex/native-ws-session.js';

test('credential callback preserves only fixed typed native session errors and wipes the secret', async () => {
  const secret = new Uint8Array([1, 2, 3]);
  const error = new CodexNativeWsSessionError('full_context_required');
  await assert.rejects(consumeBuiltinProviderSecret(secret, async () => { throw error; }), (observed) => observed === error);
  assert.deepEqual([...secret], [0, 0, 0]);
});
test('credential callback removes arbitrary exception text while still clearing secret bytes', async () => {
  const secret = new Uint8Array([1, 2, 3]);
  await assert.rejects(consumeBuiltinProviderSecret(secret, async () => { throw new Error('synthetic credential material must not escape'); }), (error) => error instanceof Error && error.message === 'Built-in provider credential is unavailable');
  assert.deepEqual([...secret], [0, 0, 0]);
});
