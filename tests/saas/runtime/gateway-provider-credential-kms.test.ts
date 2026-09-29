import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadGatewayProviderCredentialUnsealingKms,
  type ProviderCredentialUnsealingKms,
  ProviderCredentialUnsealingKmsError,
  type ProviderEnvironment,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../../../src/saas/runtime/gateway-provider-credential-kms.js';
import {
  type ProviderLoaderError,
  ProviderLoaderError as ProviderLoaderErrorClass,
  type ProviderModuleImporter,
} from '../../../src/saas/runtime/providers.js';

const MODULE = 'trusted-gateway-provider-credential-decrypter';
const SECRET = 'provider-kms-secret-sentinel';

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: MODULE, TOKEN: 'snapshot-value', ...overrides };
}

function fakeUnsealingProvider(
  options: {
    readonly onReady?: () => void;
    readonly onClose?: () => void;
    readonly decrypt?: () => unknown | PromiseLike<unknown>;
  } = {},
): ProviderCredentialUnsealingKms {
  return {
    decryptDataKey: async () => (options.decrypt === undefined ? Buffer.alloc(32, 7) : await options.decrypt()),
    checkReady: async () => options.onReady?.(),
    close: async () => options.onClose?.(),
  };
}

function importerFor(module: unknown, seen: string[] = []): ProviderModuleImporter {
  return async (specifier) => {
    seen.push(specifier);
    return module;
  };
}

async function assertSafeLoaderError(
  action: () => Promise<unknown>,
  code: ProviderLoaderError['code'],
  ...sensitiveValues: string[]
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ProviderLoaderErrorClass);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    for (const value of sensitiveValues) {
      assert.equal(error.message.includes(value), false);
      assert.equal(String(error).includes(value), false);
    }
    return true;
  });
}

test('returns undefined without importing when the gateway decrypt setting is unset', async () => {
  let importerCalls = 0;
  const loaded = await loadGatewayProviderCredentialUnsealingKms({
    env: { SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: MODULE, TOKEN: 'not a gateway configuration' },
    importer: async () => {
      importerCalls += 1;
      return {};
    },
  });
  assert.equal(loaded, undefined);
  assert.equal(importerCalls, 0);
});

test('loads the distinct gateway factory, snapshots environment, and exposes only unsealing methods', async () => {
  const sourceEnv = environment();
  let factoryEnv: ProviderEnvironment | undefined;
  let readyCalls = 0;
  let decryptCalls = 0;
  let closeCalls = 0;
  let generatePropertyReads = 0;
  const sourceDataKey = Buffer.alloc(32, 9);
  const rawProvider = {
    ...fakeUnsealingProvider({
      onReady: () => (readyCalls += 1),
      onClose: () => (closeCalls += 1),
      decrypt: () => {
        decryptCalls += 1;
        return sourceDataKey;
      },
    }),
    get generateDataKey() {
      generatePropertyReads += 1;
      throw new Error(SECRET);
    },
  };
  const seen: string[] = [];
  const loaded = await loadGatewayProviderCredentialUnsealingKms({
    env: sourceEnv,
    cwd: '/tmp/provider-workdir',
    importer: importerFor(
      {
        createGatewayProviderCredentialUnsealingKms: async (options: { env: ProviderEnvironment }) => {
          factoryEnv = options.env;
          return rawProvider;
        },
      },
      seen,
    ),
  });

  assert.ok(loaded);
  assert.deepEqual(seen, [MODULE]);
  assert.notEqual(factoryEnv, sourceEnv);
  assert.equal(Object.isFrozen(factoryEnv), true);
  assert.equal(factoryEnv?.TOKEN, 'snapshot-value');
  sourceEnv.TOKEN = 'mutated-after-load';
  assert.equal(factoryEnv?.TOKEN, 'snapshot-value');
  assert.equal(readyCalls, 1);
  assert.equal(decryptCalls, 0);
  assert.equal(generatePropertyReads, 0);
  assert.equal(Object.hasOwn(loaded, 'generateDataKey'), false);
  assert.deepEqual(Object.keys(loaded).sort(), ['checkReady', 'close', 'decryptDataKey']);

  const decrypted = await loaded.decryptDataKey({
    kmsKeyId: 'fake-key',
    ciphertextBlob: Buffer.from('wrapped-key'),
    encryptionContext: Object.freeze({ purpose: 'test-only' }),
  });
  assert.equal(decryptCalls, 1);
  assert.equal(decrypted.byteLength, 32);
  assert.notEqual(decrypted, sourceDataKey);
  assert.deepEqual(decrypted, sourceDataKey);

  await loaded.checkReady();
  assert.equal(readyCalls, 2);
  await Promise.all([loaded.close(), loaded.close()]);
  assert.equal(closeCalls, 1);
});

test('rejects invalid named exports without accepting a default export', async () => {
  await assertSafeLoaderError(
    () =>
      loadGatewayProviderCredentialUnsealingKms({
        env: environment(),
        importer: importerFor({ default: { createGatewayProviderCredentialUnsealingKms: async () => ({}) } }),
      }),
    'PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID',
    MODULE,
  );
});

test('sanitizes importer and factory failures', async () => {
  await assertSafeLoaderError(
    () =>
      loadGatewayProviderCredentialUnsealingKms({
        env: environment(),
        importer: async () => {
          throw new Error(`${SECRET}:${MODULE}`);
        },
      }),
    'PROVIDER_CREDENTIAL_KMS_MODULE_LOAD_FAILED',
    SECRET,
    MODULE,
  );

  await assertSafeLoaderError(
    () =>
      loadGatewayProviderCredentialUnsealingKms({
        env: environment(),
        importer: importerFor({
          createGatewayProviderCredentialUnsealingKms: async () => {
            throw new Error(`${SECRET}:${MODULE}`);
          },
        }),
      }),
    'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED',
    SECRET,
    MODULE,
  );
});

test('sanitizes readiness failure and closes the partially initialized provider', async () => {
  let closeCalls = 0;
  await assertSafeLoaderError(
    () =>
      loadGatewayProviderCredentialUnsealingKms({
        env: environment(),
        importer: importerFor({
          createGatewayProviderCredentialUnsealingKms: async () => ({
            ...fakeUnsealingProvider({ onClose: () => (closeCalls += 1) }),
            checkReady: async () => {
              throw new Error(`${SECRET}:${MODULE}`);
            },
          }),
        }),
      }),
    'PROVIDER_CREDENTIAL_KMS_READINESS_FAILED',
    SECRET,
    MODULE,
  );
  assert.equal(closeCalls, 1);
});

test('closes an invalid provider that is missing the decrypt method', async () => {
  let closeCalls = 0;
  await assertSafeLoaderError(
    () =>
      loadGatewayProviderCredentialUnsealingKms({
        env: environment(),
        importer: importerFor({
          createGatewayProviderCredentialUnsealingKms: async () => ({
            generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32), ciphertextBlob: Buffer.alloc(1) }),
            checkReady: async () => undefined,
            close: async () => (closeCalls += 1),
          }),
        }),
      }),
    'PROVIDER_CREDENTIAL_KMS_PROVIDER_INVALID',
    SECRET,
    MODULE,
  );
  assert.equal(closeCalls, 1);
});

test('validates and clears invalid decrypted data-key buffers', async () => {
  const invalidDataKey = Buffer.alloc(31, 5);
  const loaded = await loadGatewayProviderCredentialUnsealingKms({
    env: environment(),
    importer: importerFor({
      createGatewayProviderCredentialUnsealingKms: async () => fakeUnsealingProvider({ decrypt: () => invalidDataKey }),
    }),
  });
  assert.ok(loaded);

  await assert.rejects(
    loaded.decryptDataKey({
      kmsKeyId: 'fake-key',
      ciphertextBlob: Buffer.from('wrapped-key'),
      encryptionContext: Object.freeze({ purpose: 'test-only' }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCredentialUnsealingKmsError);
      assert.equal(error.code, 'INVALID_DATA_KEY');
      assert.equal(error.message.includes(SECRET), false);
      return true;
    },
  );
  assert.deepEqual(invalidDataKey, Buffer.alloc(31));
  await loaded.close();
});

test('sanitizes decrypt and close failures while making close idempotent', async () => {
  let closeCalls = 0;
  const loaded = await loadGatewayProviderCredentialUnsealingKms({
    env: environment(),
    importer: importerFor({
      createGatewayProviderCredentialUnsealingKms: async () => ({
        decryptDataKey: async () => {
          throw new Error(`${SECRET}:${MODULE}`);
        },
        checkReady: async () => undefined,
        close: async () => {
          closeCalls += 1;
          throw new Error(`${SECRET}:${MODULE}`);
        },
      }),
    }),
  });
  assert.ok(loaded);

  await assert.rejects(
    loaded.decryptDataKey({
      kmsKeyId: 'fake-key',
      ciphertextBlob: Buffer.from('wrapped-key'),
      encryptionContext: Object.freeze({ purpose: 'test-only' }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCredentialUnsealingKmsError);
      assert.equal(error.code, 'DATA_KEY_DECRYPTION_FAILED');
      assert.equal(error.message.includes(SECRET), false);
      return true;
    },
  );

  await assert.rejects(loaded.close(), (error: unknown) => {
    assert.ok(error instanceof ProviderCredentialUnsealingKmsError);
    assert.equal(error.code, 'PROVIDER_CLOSE_FAILED');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  await assert.rejects(loaded.close(), (error: unknown) => {
    assert.ok(error instanceof ProviderCredentialUnsealingKmsError);
    assert.equal(error.code, 'PROVIDER_CLOSE_FAILED');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  assert.equal(closeCalls, 1);
});
