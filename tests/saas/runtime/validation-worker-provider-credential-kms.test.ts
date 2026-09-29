import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderEnvironment } from '../../../src/saas/runtime/providers.js';
import {
  loadValidationWorkerProviderCredentialKms,
  SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  ValidationWorkerProviderCredentialKmsError,
} from '../../../src/saas/runtime/validation-worker-provider-credential-kms.js';

test('loads only the validation-worker decrypt factory under its independent setting', async () => {
  const key = Buffer.alloc(32, 0x4a);
  let receivedEnvironment: ProviderEnvironment | undefined;
  let closed = false;
  const loaded = await loadValidationWorkerProviderCredentialKms({
    env: {
      [SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: 'trusted-worker-kms',
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: 'must-not-be-used',
    },
    importer: async (specifier) => {
      assert.equal(specifier, 'trusted-worker-kms');
      return {
        createCredentialValidationWorkerUnsealingKms: async ({ env }: { env: ProviderEnvironment }) => {
          receivedEnvironment = env;
          return {
            decryptDataKey: async () => key,
            checkReady: async () => undefined,
            close: async () => {
              closed = true;
            },
          };
        },
      };
    },
  });

  assert.ok(loaded);
  assert.ok(receivedEnvironment);
  assert.equal(Object.isFrozen(receivedEnvironment), true);
  const copied = await loaded.decryptDataKey({
    kmsKeyId: 'kms/test-key',
    ciphertextBlob: Buffer.from('wrapped'),
    encryptionContext: Object.freeze({ purpose: 'test' }),
  });
  assert.notEqual(copied, key);
  assert.equal(
    key.every((value) => value === 0),
    true,
  );
  assert.deepEqual(copied, Buffer.alloc(32, 0x4a));
  await loaded.close();
  assert.equal(closed, true);
});

test('does not load when only the gateway KMS setting is present', async () => {
  let imports = 0;
  const loaded = await loadValidationWorkerProviderCredentialKms({
    env: { SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: 'trusted-gateway-kms' },
    importer: async () => {
      imports += 1;
      return {};
    },
  });
  assert.equal(loaded, undefined);
  assert.equal(imports, 0);
});

test('fails closed when the worker module lacks its exact decrypt-only factory', async () => {
  await assert.rejects(
    loadValidationWorkerProviderCredentialKms({
      env: { [SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: 'trusted-worker-kms' },
      importer: async () => ({ createGatewayProviderCredentialUnsealingKms: async () => ({}) }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationWorkerProviderCredentialKmsError);
      assert.equal(error.code, 'MODULE_EXPORT_INVALID');
      return true;
    },
  );
});
