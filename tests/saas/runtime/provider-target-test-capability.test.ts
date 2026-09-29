import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderHttpTestAddressCapability } from '../../../src/saas/gateway/provider-http-address.js';
import {
  createProviderTargetResolver,
  type ProviderTargetBinding,
  ProviderTargetResolverError,
} from '../../../src/saas/runtime/provider-target-resolver.js';

const TEST_CA = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----';

function localBinding(overrides: Partial<ProviderTargetBinding> = {}): ProviderTargetBinding {
  return {
    upstreamId: 'upstream-local-test',
    productId: 'product-local-test',
    protocol: 'openai',
    operation: 'chat.completions',
    baseUrl: 'https://127.0.0.1:18443',
    allowedHosts: ['127.0.0.1'],
    allowedPorts: [18_443],
    path: '/v1/chat/completions',
    method: 'POST',
    ...overrides,
  };
}

function resolveLocal(resolver: ReturnType<typeof createProviderTargetResolver>) {
  return resolver.resolve({
    upstreamId: 'upstream-local-test',
    productId: 'product-local-test',
    protocol: 'openai',
    operation: 'chat.completions',
  });
}

test('provider target resolver denies loopback by default and accepts only HTTPS loopback with a test capability', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    assert.throws(
      () => createProviderTargetResolver({ bindings: [localBinding()] }),
      (error: unknown) => error instanceof ProviderTargetResolverError && error.code === 'TARGET_POLICY_VIOLATION',
    );

    const capability = createProviderHttpTestAddressCapability(TEST_CA);
    const target = resolveLocal(
      createProviderTargetResolver({
        bindings: [localBinding()],
        testAddressCapability: capability,
      }),
    );
    assert.equal(target.url, 'https://127.0.0.1:18443/v1/chat/completions');

    assert.throws(
      () =>
        createProviderTargetResolver({
          bindings: [localBinding({ baseUrl: 'https://192.168.1.2:18443', allowedHosts: ['192.168.1.2'] })],
          testAddressCapability: capability,
        }),
      (error: unknown) => error instanceof ProviderTargetResolverError && error.code === 'TARGET_POLICY_VIOLATION',
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
