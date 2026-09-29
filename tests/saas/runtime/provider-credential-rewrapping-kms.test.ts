import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type {
  ReencryptedProviderCredentialDataKey,
  ReencryptProviderCredentialDataKeyRequest,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  loadProviderCredentialRewrappingKms,
  ProviderCredentialRewrappingKmsError,
  type ProviderCredentialRewrappingKmsModule,
  type ProviderEnvironment,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
} from '../../../src/saas/runtime/provider-credential-rewrapping-kms.js';

const KEY_ID = 'arn:trusted:current-provider-key';

function environment(overrides: Record<string, string | undefined> = {}): ProviderEnvironment {
  return {
    [SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE]: '/trusted/provider-rewrap.mjs',
    MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID: KEY_ID,
    SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: '/trusted/provider-seal.mjs',
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: '/trusted/gateway-decrypt.mjs',
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: '/trusted/worker-decrypt.mjs',
    ...overrides,
  };
}

function sampleRequest(destinationKmsKeyId = KEY_ID): ReencryptProviderCredentialDataKeyRequest {
  return {
    sourceKmsKeyId: 'arn:trusted:old-provider-key',
    destinationKmsKeyId,
    ciphertextBlob: Buffer.from('wrapped-dek'),
    sourceEncryptionContext: { deployment: 'prod', credential: 'credential-a' },
    destinationEncryptionContext: { deployment: 'prod', credential: 'credential-a' },
  };
}

function reencryptModule(
  reencrypt: (request: ReencryptProviderCredentialDataKeyRequest) => ReencryptedProviderCredentialDataKey,
): ProviderCredentialRewrappingKmsModule {
  return {
    createProviderCredentialRewrappingKms: () => ({
      reencryptDataKey: reencrypt,
      checkReady: () => undefined,
      close: () => undefined,
    }),
  };
}

test('dedicated runtime forwards only wrapped-DEK ReEncrypt and binds destination to deployment key', async () => {
  const calls: ReencryptProviderCredentialDataKeyRequest[] = [];
  const module = reencryptModule((request) => {
    calls.push(request);
    return {
      sourceKmsKeyId: request.sourceKmsKeyId,
      destinationKmsKeyId: request.destinationKmsKeyId,
      ciphertextBlob: Buffer.from('new-wrapped-dek'),
    };
  });
  const kms = await loadProviderCredentialRewrappingKms({ env: environment(), importer: async () => module });
  assert.ok(kms);

  await assert.rejects(
    kms.reencryptDataKey(sampleRequest('arn:untrusted:request-key')),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'REENCRYPT_FAILED',
  );
  assert.equal(calls.length, 0);

  const original = sampleRequest();
  const result = await kms.reencryptDataKey(original);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.destinationKmsKeyId, KEY_ID);
  assert.deepEqual(result.ciphertextBlob, Buffer.from('new-wrapped-dek'));
  assert.deepEqual(Object.keys(calls[0] ?? {}).sort(), [
    'ciphertextBlob',
    'destinationEncryptionContext',
    'destinationKmsKeyId',
    'sourceEncryptionContext',
    'sourceKmsKeyId',
  ]);
  assert.deepEqual(calls[0]?.ciphertextBlob, Buffer.alloc('wrapped-dek'.length));
  await kms.close();
  original.ciphertextBlob.fill(0);
});

test('dedicated runtime refuses a provider exposing decrypt or generate capabilities', async () => {
  const invalid = {
    createProviderCredentialRewrappingKms: () => ({
      reencryptDataKey: async () => ({
        sourceKmsKeyId: 'old',
        destinationKmsKeyId: KEY_ID,
        ciphertextBlob: randomBytes(48),
      }),
      decrypt: async () => Buffer.alloc(32),
      generateDataKey: async () => ({ plaintextKey: Buffer.alloc(32), ciphertextBlob: Buffer.alloc(48) }),
      checkReady: async () => undefined,
      close: async () => undefined,
    }),
  };
  await assert.rejects(
    loadProviderCredentialRewrappingKms({ env: environment(), importer: async () => invalid }),
    (error: unknown) =>
      error instanceof ProviderCredentialRewrappingKmsError && error.code === 'PROVIDER_CONTRACT_INVALID',
  );
});

test('dedicated module cannot alias sealing or decrypt module settings', async () => {
  let importerCalls = 0;
  await assert.rejects(
    loadProviderCredentialRewrappingKms({
      env: environment({ [SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE]: '/trusted/provider-seal.mjs' }),
      importer: async () => {
        importerCalls += 1;
        return {};
      },
    }),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'CONFIGURATION_INVALID',
  );
  assert.equal(importerCalls, 0);
});

test('dedicated module rejects additional decrypt-capable module exports', async () => {
  let factoryCalls = 0;
  const module = {
    createProviderCredentialRewrappingKms: () => {
      factoryCalls += 1;
      return {};
    },
    createProviderCredentialDecryptor: () => ({ decrypt: () => Buffer.alloc(32) }),
  };
  await assert.rejects(
    loadProviderCredentialRewrappingKms({ env: environment(), importer: async () => module }),
    (error: unknown) =>
      error instanceof ProviderCredentialRewrappingKmsError && error.code === 'MODULE_CONTRACT_INVALID',
  );
  assert.equal(factoryCalls, 0);
});

test('dedicated module rejects alternate specifiers resolving to a sealing module', async () => {
  let importerCalls = 0;
  await assert.rejects(
    loadProviderCredentialRewrappingKms({
      env: environment({
        [SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE]: 'file:///trusted/provider-seal.mjs',
      }),
      importer: async () => {
        importerCalls += 1;
        return {};
      },
    }),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'CONFIGURATION_INVALID',
  );
  assert.equal(importerCalls, 0);
});

test('destination policy cannot disagree with the configured current key', async () => {
  let importerCalls = 0;
  await assert.rejects(
    loadProviderCredentialRewrappingKms({
      env: environment(),
      destinationKmsKeyId: 'arn:untrusted:other-key',
      importer: async () => {
        importerCalls += 1;
        return {};
      },
    }),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'CONFIGURATION_INVALID',
  );
  assert.equal(importerCalls, 0);
});
