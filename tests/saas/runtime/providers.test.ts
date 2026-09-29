import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { CredentialKeyMaterial, CredentialKeyProvider } from '../../../src/saas/credentials/crypto.js';
import type { ManagedSaasDeploymentConfig } from '../../../src/saas/deployment.js';
import {
  CUSTOMER_AUTH_NAMESPACE,
  CUSTOMER_AUTH_RATE_LIMIT,
  CUSTOMER_AUTH_RATE_WINDOW_MS,
  loadCredentialKeyProvider,
  loadManagedSaasProviders,
  MANAGED_SAAS_REDIS_KEY_PREFIX,
  type ManagedRateLimiter,
  PLATFORM_AUTH_NAMESPACE,
  PLATFORM_AUTH_RATE_LIMIT,
  PLATFORM_AUTH_RATE_WINDOW_MS,
  PLATFORM_TOTP_PURPOSE,
  type ProviderEnvironment,
  ProviderLoaderError,
  type ProviderModuleImporter,
  resolveProviderModuleSpecifier,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../../../src/saas/runtime/providers.js';

const SECRET = 'sentinel-provider-secret';
const REDIS_URL = 'rediss://redis-user:redis-password@redis.example:6380/0';

function managedConfig(
  overrides: Partial<
    Pick<ManagedSaasDeploymentConfig, 'credentialProviderModule' | 'redisProviderModule' | 'redisUrl'>
  > = {},
): ManagedSaasDeploymentConfig {
  return {
    mode: 'managed-saas',
    postgresUrl: 'postgresql://db.example/saas',
    redisUrl: REDIS_URL,
    redisProviderModule: 'trusted-redis-provider',
    credentialProviderModule: 'trusted-kms-provider',
    listeners: {
      customer: { bindAddress: '127.0.0.1', port: 3101, origin: 'http://127.0.0.1:4101', routePrefix: '/console' },
      platform: { bindAddress: '127.0.0.1', port: 3102, origin: 'http://127.0.0.1:4102', routePrefix: '/admin' },
      gateway: { bindAddress: '127.0.0.1', port: 3103, origin: 'http://127.0.0.1:4103', routePrefix: '/v1' },
    },
    ...overrides,
  };
}

function fakeCredentialProvider(options: { onReady?: () => void; onClose?: () => void }): CredentialKeyProvider & {
  checkReady(): Promise<void>;
  close(): Promise<void>;
} {
  const key: CredentialKeyMaterial = { keyId: 'kms-key-v1', key: randomBytes(32) };
  return {
    getCurrentKey: async () => key,
    getKey: async (keyId) => (keyId === key.keyId ? key : undefined),
    checkReady: async () => options.onReady?.(),
    close: async () => options.onClose?.(),
  };
}

function fakeLimiter(): ManagedRateLimiter {
  return { take: async () => undefined };
}

function importerFrom(modules: Record<string, unknown>, seen: string[] = []): ProviderModuleImporter {
  return async (specifier) => {
    seen.push(specifier);
    const module = modules[specifier];
    if (module === undefined) throw new Error(`missing module ${SECRET}`);
    return module;
  };
}

async function assertLoaderError(action: () => Promise<unknown>, code?: ProviderLoaderError['code']): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ProviderLoaderError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(String(error).includes(REDIS_URL), false);
    assert.equal(String(error).includes('trusted-kms-provider'), false);
    assert.equal(String(error).includes('trusted-redis-provider'), false);
    return true;
  });
}

test('resolves package, file URL, absolute, and cwd-relative provider specs consistently', () => {
  assert.equal(resolveProviderModuleSpecifier('@trusted/provider'), '@trusted/provider');
  assert.equal(resolveProviderModuleSpecifier('file:///tmp/provider.mjs'), 'file:///tmp/provider.mjs');
  assert.equal(resolveProviderModuleSpecifier('/tmp/provider.mjs'), pathToFileURL('/tmp/provider.mjs').href);
  assert.equal(resolveProviderModuleSpecifier('./provider.mjs', '/tmp/workdir'), 'file:///tmp/workdir/provider.mjs');
  assert.equal(resolveProviderModuleSpecifier('../provider.mjs', '/tmp/workdir'), 'file:///tmp/provider.mjs');
});

test('loads exact named contracts, freezes only the copied KMS environment, probes crypto, and closes idempotently', async () => {
  const sourceEnvironment: Record<string, string | undefined> = { API_SECRET: SECRET, REGION: 'test' };
  let kmsFactoryOptions: { env: ProviderEnvironment; purpose: string } | undefined;
  let kmsReadyCalls = 0;
  let kmsCloseCalls = 0;
  let redisReadyCalls = 0;
  let redisCloseCalls = 0;
  let redisFactoryOptions: { url: string; keyPrefix: string } | undefined;
  const limiterOptions: Array<Record<string, unknown>> = [];
  const kmsProvider = fakeCredentialProvider({
    onReady: () => {
      kmsReadyCalls += 1;
    },
    onClose: () => {
      kmsCloseCalls += 1;
    },
  });
  const redisProvider = {
    createRateLimiter: async (options: Record<string, unknown>) => {
      limiterOptions.push(options);
      return fakeLimiter();
    },
    checkReady: async () => {
      redisReadyCalls += 1;
    },
    close: async () => {
      redisCloseCalls += 1;
    },
  };
  const importer = importerFrom({
    'trusted-kms-provider': {
      createCredentialKeyProvider: async (options: { env: ProviderEnvironment; purpose: string }) => {
        kmsFactoryOptions = options;
        return kmsProvider;
      },
    },
    'trusted-redis-provider': {
      createRedisProvider: async (options: { url: string; keyPrefix: string }) => {
        redisFactoryOptions = options;
        return redisProvider;
      },
    },
  });

  const providers = await loadManagedSaasProviders(managedConfig(), { env: sourceEnvironment, importer });

  assert.notEqual(kmsFactoryOptions?.env, sourceEnvironment);
  assert.equal(Object.isFrozen(kmsFactoryOptions?.env), true);
  assert.deepEqual(kmsFactoryOptions?.env, sourceEnvironment);
  assert.equal(kmsFactoryOptions?.purpose, PLATFORM_TOTP_PURPOSE);
  assert.deepEqual(redisFactoryOptions, { url: REDIS_URL, keyPrefix: MANAGED_SAAS_REDIS_KEY_PREFIX });
  assert.equal(kmsReadyCalls, 1);
  assert.equal(redisReadyCalls, 1);
  assert.equal(limiterOptions.length, 2);
  assert.deepEqual(limiterOptions, [
    { namespace: PLATFORM_AUTH_NAMESPACE, limit: PLATFORM_AUTH_RATE_LIMIT, windowMs: PLATFORM_AUTH_RATE_WINDOW_MS },
    { namespace: CUSTOMER_AUTH_NAMESPACE, limit: CUSTOMER_AUTH_RATE_LIMIT, windowMs: CUSTOMER_AUTH_RATE_WINDOW_MS },
  ]);
  assert.equal(Object.hasOwn(providers, 'gateway'), false);
  assert.equal(providers.providerCredentialSealingKms, undefined);

  await Promise.all([providers.close(), providers.close(), providers.close()]);
  assert.equal(kmsCloseCalls, 1);
  assert.equal(redisCloseCalls, 1);
});

test('managed providers optionally load and close the separate generate-only KMS facade', async () => {
  const sourceEnvironment = { [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: 'seal-only-module' };
  let sealingReadyCalls = 0;
  let sealingCloseCalls = 0;
  let decryptPropertyReads = 0;
  const sealingProvider = {
    generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32, 7), ciphertextBlob: Buffer.from('wrapped') }),
    checkReady: async () => {
      sealingReadyCalls += 1;
    },
    close: async () => {
      sealingCloseCalls += 1;
    },
    get decryptDataKey() {
      decryptPropertyReads += 1;
      throw new Error(SECRET);
    },
  };
  const seen: string[] = [];
  const providers = await loadManagedSaasProviders(managedConfig(), {
    env: sourceEnvironment,
    importer: importerFrom(
      {
        'trusted-kms-provider': { createCredentialKeyProvider: async () => fakeCredentialProvider({}) },
        'trusted-redis-provider': {
          createRedisProvider: async () => ({
            createRateLimiter: async () => fakeLimiter(),
            checkReady: async () => undefined,
            close: async () => undefined,
          }),
        },
        'seal-only-module': {
          createProviderCredentialSealingKms: async () => sealingProvider,
        },
      },
      seen,
    ),
  });

  assert.deepEqual(seen, ['trusted-kms-provider', 'trusted-redis-provider', 'seal-only-module']);
  assert.ok(providers.providerCredentialSealingKms);
  assert.equal(Object.hasOwn(providers.providerCredentialSealingKms, 'decryptDataKey'), false);
  assert.equal(sealingReadyCalls, 1);
  assert.equal(decryptPropertyReads, 0);
  await providers.close();
  assert.equal(sealingCloseCalls, 1);
});

test('loadCredentialKeyProvider is reusable independently and uses the current config field', async () => {
  let factoryCalls = 0;
  let closeCalls = 0;
  const provider = fakeCredentialProvider({ onClose: () => (closeCalls += 1) });
  const importer = importerFrom({
    'kms-package': {
      createCredentialKeyProvider: async () => {
        factoryCalls += 1;
        return provider;
      },
    },
  });

  const loaded = await loadCredentialKeyProvider({ credentialProviderModule: 'kms-package' }, { env: {}, importer });
  assert.equal(factoryCalls, 1);
  assert.equal(typeof loaded.getCurrentKey, 'function');
  await loaded.close();
  await loaded.close();
  assert.equal(closeCalls, 1);
});

test('rejects missing or guessed exports without falling back to default exports', async () => {
  await assertLoaderError(
    () =>
      loadCredentialKeyProvider(
        { credentialProviderModule: 'kms-package' },
        { importer: importerFrom({ 'kms-package': { default: { createCredentialKeyProvider: async () => ({}) } } }) },
      ),
    'CREDENTIAL_MODULE_EXPORT_INVALID',
  );

  const config = managedConfig();
  await assertLoaderError(
    () =>
      loadManagedSaasProviders(config, {
        importer: importerFrom({
          'trusted-kms-provider': {
            createCredentialKeyProvider: async () => fakeCredentialProvider({}),
          },
          'trusted-redis-provider': { default: { createRedisProvider: async () => ({}) } },
        }),
      }),
    'REDIS_MODULE_EXPORT_INVALID',
  );
});

test('invalid KMS keys and readiness failures close the KMS resource and redact cause details', async () => {
  let invalidKeyCloseCalls = 0;
  const invalidKeyProvider = {
    ...fakeCredentialProvider({ onClose: () => (invalidKeyCloseCalls += 1) }),
    getCurrentKey: async () => ({ keyId: 'bad-key', key: Buffer.alloc(31) }),
  };
  await assertLoaderError(
    () =>
      loadCredentialKeyProvider(
        { credentialProviderModule: 'kms-package' },
        {
          env: { SECRET: SECRET },
          importer: importerFrom({ 'kms-package': { createCredentialKeyProvider: async () => invalidKeyProvider } }),
        },
      ),
    'CREDENTIAL_PROBE_FAILED',
  );
  assert.equal(invalidKeyCloseCalls, 1);

  let readinessCloseCalls = 0;
  await assertLoaderError(
    () =>
      loadCredentialKeyProvider(
        { credentialProviderModule: 'kms-package' },
        {
          importer: importerFrom({
            'kms-package': {
              createCredentialKeyProvider: async () => ({
                ...fakeCredentialProvider({ onClose: () => (readinessCloseCalls += 1) }),
                checkReady: async () => {
                  throw new Error(SECRET);
                },
              }),
            },
          }),
        },
      ),
    'CREDENTIAL_READINESS_FAILED',
  );
  assert.equal(readinessCloseCalls, 1);
});

test('redacts factory and readiness failures and cleans up KMS when Redis setup fails later', async () => {
  await assertLoaderError(
    () =>
      loadCredentialKeyProvider(
        { credentialProviderModule: 'kms-package' },
        {
          importer: importerFrom({
            'kms-package': {
              createCredentialKeyProvider: async () => {
                throw new Error(SECRET);
              },
            },
          }),
        },
      ),
    'CREDENTIAL_FACTORY_FAILED',
  );

  let kmsCloseCalls = 0;
  let redisCloseCalls = 0;
  const kmsProvider = fakeCredentialProvider({ onClose: () => (kmsCloseCalls += 1) });
  const config = managedConfig();
  await assertLoaderError(
    () =>
      loadManagedSaasProviders(config, {
        importer: importerFrom({
          'trusted-kms-provider': { createCredentialKeyProvider: async () => kmsProvider },
          'trusted-redis-provider': {
            createRedisProvider: async (options: { url: string }) => {
              assert.equal(options.url, REDIS_URL);
              throw new Error(`${SECRET}:${REDIS_URL}`);
            },
          },
        }),
      }),
    'REDIS_FACTORY_FAILED',
  );
  assert.equal(kmsCloseCalls, 1);
  assert.equal(redisCloseCalls, 0);

  await assertLoaderError(
    () =>
      loadManagedSaasProviders(config, {
        importer: importerFrom({
          'trusted-kms-provider': {
            createCredentialKeyProvider: async () => fakeCredentialProvider({}),
          },
          'trusted-redis-provider': {
            createRedisProvider: async () => ({
              createRateLimiter: async () => fakeLimiter(),
              checkReady: async () => {
                throw new Error(SECRET);
              },
              close: async () => {
                redisCloseCalls += 1;
              },
            }),
          },
        }),
      }),
    'REDIS_READINESS_FAILED',
  );
  assert.equal(redisCloseCalls, 1);
});

test('cleans up both resources when a later Redis limiter setup fails', async () => {
  let kmsCloseCalls = 0;
  let redisCloseCalls = 0;
  let limiterCalls = 0;
  await assertLoaderError(
    () =>
      loadManagedSaasProviders(managedConfig(), {
        importer: importerFrom({
          'trusted-kms-provider': {
            createCredentialKeyProvider: async () => fakeCredentialProvider({ onClose: () => (kmsCloseCalls += 1) }),
          },
          'trusted-redis-provider': {
            createRedisProvider: async () => ({
              createRateLimiter: async () => {
                limiterCalls += 1;
                if (limiterCalls === 2) throw new Error(SECRET);
                return fakeLimiter();
              },
              checkReady: async () => {},
              close: async () => {
                redisCloseCalls += 1;
              },
            }),
          },
        }),
      }),
    'REDIS_RATE_LIMITER_FACTORY_FAILED',
  );
  assert.equal(limiterCalls, 2);
  assert.equal(kmsCloseCalls, 1);
  assert.equal(redisCloseCalls, 1);
});
