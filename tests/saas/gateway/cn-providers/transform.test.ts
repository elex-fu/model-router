import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cnProvidersProviderRequestTransform } from '../../../../src/saas/gateway/cn-providers/transform.js';

function input(overrides: Partial<Parameters<typeof cnProvidersProviderRequestTransform>[0]> = {}) {
  return {
    providerId: 'minimax',
    productId: 'minimax-m',
    clientProtocol: 'anthropic',
    providerProtocol: 'anthropic',
    providerOperation: 'messages',
    body: { model: 'MiniMax-M2.7', thinking: { type: 'enabled' } },
    ...overrides,
  };
}

test('the transform rewrites minimax thinking.type on the anthropic native', () => {
  const transformed = cnProvidersProviderRequestTransform(input());
  assert.deepEqual(transformed, { model: 'MiniMax-M2.7', thinking: { type: 'adaptive' } });
});

test('the transform is copy-on-write for everything else', () => {
  // Non-CN provider: byte-identical (by reference).
  const other = input({ providerId: 'opencode-go' });
  assert.equal(cnProvidersProviderRequestTransform(other), other.body);
  // CN provider but openai native (the bridge dropped thinking): by reference.
  const openai = input({ providerProtocol: 'openai', providerOperation: 'chat.completions' });
  assert.equal(cnProvidersProviderRequestTransform(openai), openai.body);
  // Anthropic native but non-passback model (strict semantics preserved).
  const claude = input({ body: { model: 'claude-sonnet-4-6', thinking: { type: 'enabled' } } });
  assert.equal(cnProvidersProviderRequestTransform(claude), claude.body);
  // Passback glm model with no thinking field: by reference.
  const glm = input({ providerId: 'zhipu', body: { model: 'glm-5.3' } });
  assert.equal(cnProvidersProviderRequestTransform(glm), glm.body);
  // Missing model: by reference.
  const noModel = input({ body: { thinking: { type: 'enabled' } } });
  assert.equal(cnProvidersProviderRequestTransform(noModel), noModel.body);
});
