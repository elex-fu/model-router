import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderTargetResolver,
  type ProviderTargetBinding,
  ProviderTargetResolverError,
} from '../../../src/saas/runtime/provider-target-resolver.js';

const SECRET = 'provider-secret-do-not-leak';

function binding(overrides: Partial<ProviderTargetBinding> = {}): ProviderTargetBinding {
  return {
    upstreamId: 'upstream-1',
    product: 'product-1',
    protocol: 'openai',
    operation: 'generate',
    baseUrl: 'https://provider.example:8443/api',
    allowedHosts: ['provider.example'],
    allowedPorts: [8443],
    path: '/v1/chat/completions',
    method: 'POST',
    ...overrides,
  } as ProviderTargetBinding;
}

function input(overrides: Partial<ProviderTargetBinding> = {}) {
  const candidate = binding(overrides);
  const product = candidate.product ?? candidate.productId;
  if (typeof product !== 'string') throw new Error('test binding product is missing');
  return {
    upstreamId: candidate.upstreamId,
    product,
    protocol: candidate.protocol,
    operation: candidate.operation,
  } as const;
}

function assertResolverError(action: () => unknown, code: ProviderTargetResolverError['code']): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProviderTargetResolverError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(String(error).includes('provider.example'), false);
    assert.equal(String(error).includes('8443'), false);
    return true;
  });
}

test('resolves a trusted exact binding and freezes its copied target policy', () => {
  const configured = binding();
  const resolver = createProviderTargetResolver({ bindings: [configured] });

  const mutableConfigured = configured as unknown as {
    path: string;
    allowedHosts: string[];
    allowedPorts: number[];
  };
  mutableConfigured.path = '/attacker';
  mutableConfigured.allowedHosts[0] = 'attacker.example';
  mutableConfigured.allowedPorts[0] = 443;

  const target = resolver.resolve(input());
  assert.equal(target.url, 'https://provider.example:8443/api/v1/chat/completions');
  assert.equal(target.method, 'POST');
  assert.deepEqual(target.endpointPolicy, {
    allowedHosts: ['provider.example'],
    allowedPorts: [8443],
  });
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.endpointPolicy), true);
  assert.equal(Object.isFrozen(target.endpointPolicy.allowedHosts), true);
  assert.equal(Object.isFrozen(target.endpointPolicy.allowedPorts), true);
  assert.equal(Object.isFrozen(resolver), true);
});

test('fails closed when the exact upstream/product/protocol/operation binding is missing', () => {
  const resolver = createProviderTargetResolver({ bindings: [binding()] });

  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'upstream-1',
        product: 'product-1',
        protocol: 'openai',
        operation: 'models',
      }),
    'BINDING_NOT_FOUND',
  );
  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'unknown-upstream',
        product: 'product-1',
        protocol: 'openai',
        operation: 'generate',
      }),
    'BINDING_NOT_FOUND',
  );
});

test('rejects a binding whose base host or effective port is outside its exact policy', () => {
  assertResolverError(
    () =>
      createProviderTargetResolver({
        bindings: [binding({ allowedHosts: ['other.example'] })],
      }),
    'TARGET_POLICY_VIOLATION',
  );
  assertResolverError(
    () =>
      createProviderTargetResolver({
        bindings: [binding({ allowedPorts: [443] })],
      }),
    'TARGET_POLICY_VIOLATION',
  );
});

test('rejects HTTP, userinfo, and fragment base URLs during startup validation', () => {
  for (const baseUrl of [
    'http://provider.example:8443/api',
    'https://user:password@provider.example:8443/api',
    'https://provider.example:8443/api#fragment',
    SECRET,
  ]) {
    assertResolverError(
      () => createProviderTargetResolver({ bindings: [binding({ baseUrl })] }),
      'INVALID_CONFIGURATION',
    );
  }
});

test('rejects unknown operations and path injection without accepting a request URL as a target', () => {
  const resolver = createProviderTargetResolver({ bindings: [binding()] });

  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'upstream-1',
        product: 'product-1',
        protocol: 'openai',
        operation: '../admin',
      }),
    'INVALID_INPUT',
  );
  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'upstream-1',
        product: 'product-1',
        protocol: 'openai',
        operation: 'generate?url=https://attacker.example',
      }),
    'INVALID_INPUT',
  );
  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'upstream-1',
        product: 'product-1',
        protocol: 'openai',
        operation: 'generate',
        endpoint: 'https://attacker.example/secret',
      } as never),
    'INVALID_INPUT',
  );
  assertResolverError(
    () =>
      resolver.resolve({
        upstreamId: 'upstream-1',
        product: 'product-1',
        protocol: 'openai',
        operation: 'generate',
        host: 'attacker.example',
        port: 443,
      } as never),
    'INVALID_INPUT',
  );
  assertResolverError(
    () => createProviderTargetResolver({ bindings: [binding({ path: '/v1/chat/completions?redirect=1' })] }),
    'INVALID_CONFIGURATION',
  );
});

test('rejects unsupported methods and wildcard binding keys instead of inventing a path contract', () => {
  assertResolverError(
    () => createProviderTargetResolver({ bindings: [binding({ method: 'GET' as never })] }),
    'UNSUPPORTED_METHOD',
  );
  assertResolverError(
    () => createProviderTargetResolver({ bindings: [binding({ operation: 'custom/*' })] }),
    'INVALID_CONFIGURATION',
  );
});
