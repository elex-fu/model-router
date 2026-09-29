import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  loadProviderCredentialSealingKms,
  ProviderCredentialKmsError,
  type ProviderCredentialSealingKms,
  type ProviderEnvironment,
  type ProviderLoaderError,
  ProviderLoaderError as ProviderLoaderErrorClass,
  type ProviderModuleImporter,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../../../src/saas/runtime/providers.js';

const MODULE = 'trusted-provider-credential-sealer';
const SECRET = 'provider-kms-secret-sentinel';

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: MODULE, TOKEN: 'snapshot-value', ...overrides };
}

function fakeSealingProvider(
  options: {
    readonly onReady?: () => void;
    readonly onClose?: () => void;
    readonly generate?: () => unknown | PromiseLike<unknown>;
  } = {},
): ProviderCredentialSealingKms {
  return {
    generateDataKey: async () =>
      (await options.generate?.()) ?? {
        plaintextKey: randomBytes(32),
        ciphertextBlob: randomBytes(48),
      },
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

test('returns undefined without importing when the independent module setting is unset', async () => {
  let importerCalls = 0;
  const loaded = await loadProviderCredentialSealingKms({
    env: { TOKEN: 'not a KMS configuration' },
    importer: async () => {
      importerCalls += 1;
      return {};
    },
  });
  assert.equal(loaded, undefined);
  assert.equal(importerCalls, 0);
});

test('loads the named factory, copies bounded environment, and exposes only sealing methods', async () => {
  const sourceEnv = environment();
  let factoryEnv: ProviderEnvironment | undefined;
  let readyCalls = 0;
  let closeCalls = 0;
  let decryptPropertyReads = 0;
  const sourcePlaintextKey = Buffer.alloc(32, 9);
  const sourceCiphertextBlob = Buffer.from('wrapped-key');
  const rawProvider = {
    ...fakeSealingProvider({
      onReady: () => (readyCalls += 1),
      onClose: () => (closeCalls += 1),
      generate: () => ({ plaintextKey: sourcePlaintextKey, ciphertextBlob: sourceCiphertextBlob }),
    }),
    get decryptDataKey() {
      decryptPropertyReads += 1;
      throw new Error(SECRET);
    },
  };
  const seen: string[] = [];
  const loaded = await loadProviderCredentialSealingKms({
    env: sourceEnv,
    cwd: '/tmp/provider-workdir',
    importer: importerFor(
      {
        createProviderCredentialSealingKms: async (options: { env: ProviderEnvironment }) => {
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
  assert.equal(decryptPropertyReads, 0);
  assert.equal(Object.hasOwn(loaded, 'decryptDataKey'), false);

  const generated = await loaded.generateDataKey({
    kmsKeyId: 'fake-key',
    keySpec: 'AES_256',
    encryptionContext: Object.freeze({ purpose: 'test-only' }),
  });
  assert.equal(generated.plaintextKey.byteLength, 32);
  assert.equal(generated.ciphertextBlob.byteLength, sourceCiphertextBlob.byteLength);
  assert.notEqual(generated.plaintextKey, sourcePlaintextKey);
  assert.notEqual(generated.ciphertextBlob, sourceCiphertextBlob);
  assert.deepEqual(generated.plaintextKey, sourcePlaintextKey);
  assert.deepEqual(generated.ciphertextBlob, sourceCiphertextBlob);
  assert.deepEqual(Object.keys(generated).sort(), ['ciphertextBlob', 'plaintextKey']);

  await loaded.checkReady();
  assert.equal(readyCalls, 2);
  await Promise.all([loaded.close(), loaded.close()]);
  assert.equal(closeCalls, 1);
});

test('rejects invalid named exports without accepting a default export', async () => {
  await assertSafeLoaderError(
    () =>
      loadProviderCredentialSealingKms({
        env: environment(),
        importer: importerFor({ default: { createProviderCredentialSealingKms: async () => ({}) } }),
      }),
    'PROVIDER_CREDENTIAL_KMS_MODULE_EXPORT_INVALID',
    MODULE,
  );
});

test('sanitizes importer and factory failures', async () => {
  await assertSafeLoaderError(
    () =>
      loadProviderCredentialSealingKms({
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
      loadProviderCredentialSealingKms({
        env: environment(),
        importer: importerFor({
          createProviderCredentialSealingKms: async () => {
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
      loadProviderCredentialSealingKms({
        env: environment(),
        importer: importerFor({
          createProviderCredentialSealingKms: async () => ({
            ...fakeSealingProvider({ onClose: () => (closeCalls += 1) }),
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

test('rejects oversized environment snapshots and malformed data-key results with safe errors', async () => {
  await assertSafeLoaderError(
    () =>
      loadProviderCredentialSealingKms({
        env: environment({ LARGE: 'x'.repeat(16 * 1024 + 1) }),
        importer: importerFor({}),
      }),
    'PROVIDER_CREDENTIAL_KMS_CONFIGURATION_INVALID',
    SECRET,
  );

  const loaded = await loadProviderCredentialSealingKms({
    env: environment(),
    importer: importerFor({
      createProviderCredentialSealingKms: async () =>
        fakeSealingProvider({
          generate: async () => ({ plaintextKey: Buffer.alloc(31), ciphertextBlob: Buffer.alloc(1) }),
        }),
    }),
  });
  assert.ok(loaded);
  await assert.rejects(
    loaded.generateDataKey({
      kmsKeyId: 'fake-key',
      keySpec: 'AES_256',
      encryptionContext: Object.freeze({ purpose: 'test-only' }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCredentialKmsError);
      assert.equal(error.code, 'INVALID_DATA_KEY');
      assert.equal(error.message.includes(SECRET), false);
      return true;
    },
  );
  await loaded.close();
});
