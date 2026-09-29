import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadProviderTargetResolver,
  ProviderTargetBindingLoaderError,
  SAAS_PROVIDER_TARGET_BINDINGS_MODULE,
} from '../../../src/saas/runtime/provider-target-binding-loader.js';
import type { ProviderTargetBinding } from '../../../src/saas/runtime/provider-target-resolver.js';
import { ProviderTargetResolverError } from '../../../src/saas/runtime/provider-target-resolver.js';
import type { ProviderModuleImporter } from '../../../src/saas/runtime/providers.js';

const MODULE = 'trusted-luna-max-target-bindings';
const SECRET = 'luna-max-target-secret';
const TARGET_URL = 'https://provider.example:8443/api/v1/chat/completions';

function binding(overrides: Record<string, unknown> = {}): ProviderTargetBinding {
  return {
    upstreamId: 'provider-1',
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

function importerFor(module: unknown, seen: string[] = []): ProviderModuleImporter {
  return async (specifier) => {
    seen.push(specifier);
    return module;
  };
}

function input(operation = 'generate') {
  return {
    upstreamId: 'provider-1',
    product: 'product-1',
    protocol: 'openai',
    operation,
  } as const;
}

async function assertLoaderError(
  action: () => Promise<unknown>,
  code: ProviderTargetBindingLoaderError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ProviderTargetBindingLoaderError);
    assert.equal(error.code, code);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes('provider.example'), false);
    assert.equal(String(error).includes('8443'), false);
    assert.equal(String(error).includes(MODULE), false);
    return true;
  });
}

function assertResolverError(action: () => unknown, code: ProviderTargetResolverError['code']): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProviderTargetResolverError);
    assert.equal(error.code, code);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes('provider.example'), false);
    assert.equal(String(error).includes('8443'), false);
    return true;
  });
}

test('requires a deployment module and never falls back to an empty resolver', async () => {
  await assertLoaderError(() => loadProviderTargetResolver({ env: {} }), 'MISSING_CONFIGURATION');
  await assertLoaderError(
    () => loadProviderTargetResolver({ env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: '' } }),
    'INVALID_MODULE_SPECIFIER',
  );
  await assertLoaderError(
    () =>
      loadProviderTargetResolver({
        env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
        importer: importerFor({ providerTargetBindings: [] }),
      }),
    'BINDINGS_INVALID',
  );
});

test('imports the exact named contract and freezes a copied resolver target', async () => {
  const configured = binding();
  const bindings = [configured];
  const seen: string[] = [];
  const resolver = await loadProviderTargetResolver({
    env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
    importer: importerFor({ providerTargetBindings: bindings }, seen),
  });

  const mutable = configured as unknown as { path: string; allowedHosts: string[]; allowedPorts: number[] };
  mutable.path = '/attacker';
  mutable.allowedHosts[0] = 'attacker.example';
  mutable.allowedPorts[0] = 443;
  bindings.length = 0;

  const target = resolver.resolve(input());
  assert.deepEqual(seen, [MODULE]);
  assert.equal(target.url, TARGET_URL);
  assert.equal(target.method, 'POST');
  assert.deepEqual(target.endpointPolicy, {
    allowedHosts: ['provider.example'],
    allowedPorts: [8443],
  });
  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.endpointPolicy), true);
  assert.equal(Object.isFrozen(target.endpointPolicy.allowedHosts), true);
  assert.equal(Object.isFrozen(target.endpointPolicy.allowedPorts), true);
});

test('rejects malformed modules and binding shapes without exposing module details', async () => {
  for (const module of [
    {},
    { default: { providerTargetBindings: [binding()] } },
    { providerTargetBindings: binding() },
    { providerTargetBindings: [null] },
  ]) {
    await assertLoaderError(
      () =>
        loadProviderTargetResolver({
          env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
          importer: importerFor(module),
        }),
      module.providerTargetBindings && Array.isArray(module.providerTargetBindings)
        ? 'BINDINGS_INVALID'
        : 'MODULE_EXPORT_INVALID',
    );
  }

  await assertLoaderError(
    () =>
      loadProviderTargetResolver({
        env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
        importer: async () => {
          throw new Error(`${SECRET}:${MODULE}:${TARGET_URL}`);
        },
      }),
    'MODULE_LOAD_FAILED',
  );
});

test('fails closed for HTTP, userinfo, fragment, and host-policy mismatches', async () => {
  for (const overrides of [
    { baseUrl: 'http://provider.example:8443/api' },
    { baseUrl: 'https://user:password@provider.example:8443/api' },
    { baseUrl: 'https://provider.example:8443/api#fragment' },
    { allowedHosts: ['other.example'] },
    { path: '/v1/chat/completions?url=https://attacker.example' },
    { path: 'https://attacker.example/secret' },
    { operation: 'custom/*' },
  ]) {
    await assertLoaderError(
      () =>
        loadProviderTargetResolver({
          env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
          importer: importerFor({ providerTargetBindings: [binding(overrides)] }),
        }),
      'BINDINGS_INVALID',
    );
  }
});

test('keeps unknown operations fail closed after a successful startup load', async () => {
  const resolver = await loadProviderTargetResolver({
    env: { [SAAS_PROVIDER_TARGET_BINDINGS_MODULE]: MODULE },
    importer: importerFor({ providerTargetBindings: [binding()] }),
  });

  assertResolverError(() => resolver.resolve(input('unknown-operation')), 'BINDING_NOT_FOUND');
});
