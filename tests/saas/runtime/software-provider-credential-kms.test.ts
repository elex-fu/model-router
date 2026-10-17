import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { GeneratedProviderCredentialDataKey } from '../../../src/saas/credentials/provider-crypto.js';
import {
  loadGatewayProviderCredentialUnsealingKms,
  ProviderCredentialUnsealingKmsError,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../../../src/saas/runtime/gateway-provider-credential-kms.js';
import {
  loadProviderCredentialSealingKms,
  ProviderCredentialKmsError,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
} from '../../../src/saas/runtime/provider-credential-kms.js';
import {
  loadProviderCredentialRewrappingKms,
  ProviderCredentialRewrappingKmsError,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
} from '../../../src/saas/runtime/provider-credential-rewrapping-kms.js';
import type { ProviderModuleImporter } from '../../../src/saas/runtime/providers.js';
import * as softwareModule from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS,
} from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  loadValidationWorkerProviderCredentialKms,
  SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  ValidationWorkerProviderCredentialKmsError,
} from '../../../src/saas/runtime/validation-worker-provider-credential-kms.js';

// B1a: the pilot-only software KMS module is exercised through the REAL
// trusted-module loaders, proving the factory contracts, the wrapped-blob
// authentication (key id + encryption context as AAD), rotation rewrap and
// fail-closed behavior end to end.

const SEAL_SPECIFIER = './src/saas/runtime/software-provider-credential-kms.ts';
// Pure ESM rewrap entry: loaded through the loader's REAL dynamic import (no
// importer injection), proving the exact-single-export module contract.
const REWRAP_SPECIFIER = './src/saas/runtime/software-provider-credential-rewrapping-kms.mjs';
const DESTINATION_KEY_ID_SETTING = 'MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID';

const MASTER_KEY_V1 = randomBytes(32).toString('hex');
const MASTER_KEY_V2 = randomBytes(32).toString('hex');
const KEY_ID_V1 = 'soft-v1';
const KEY_ID_V2 = 'soft-v2';

const CONTEXT = Object.freeze({ purpose: 'provider-credential', owner: 'tenant-1', provider: 'openai' }) as const;

const softwareImporter: ProviderModuleImporter = async () => softwareModule;

function sealEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE]: SEAL_SPECIFIER,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V1,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V1,
    ...overrides,
  };
}

function gatewayEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: SEAL_SPECIFIER,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V1,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V1,
    ...overrides,
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: SEAL_SPECIFIER,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V1,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V1,
    ...overrides,
  };
}

function rotatedEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V2,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V2,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS]: `${KEY_ID_V1}=${MASTER_KEY_V1}`,
    ...overrides,
  };
}

async function seal(
  overrides: Record<string, string | undefined> = {},
): Promise<GeneratedProviderCredentialDataKey & { close: () => Promise<void> }> {
  const kms = await loadProviderCredentialSealingKms({ env: sealEnv(overrides), importer: softwareImporter });
  assert.ok(kms);
  const generated = await kms.generateDataKey({ kmsKeyId: KEY_ID_V1, keySpec: 'AES_256', encryptionContext: CONTEXT });
  return { ...generated, close: () => kms.close() };
}

test('the pilot-only warning is emitted exactly once per process', async (t) => {
  const emitWarning = t.mock.method(process, 'emitWarning');
  await loadProviderCredentialSealingKms({ env: sealEnv(), importer: softwareImporter });
  await loadGatewayProviderCredentialUnsealingKms({ env: gatewayEnv(), importer: softwareImporter });
  const pilotWarnings = emitWarning.mock.calls.filter((call) => String(call.arguments[0]).includes('pilot-only'));
  assert.equal(pilotWarnings.length, 1);
  assert.match(String(pilotWarnings[0]?.arguments[0]), /must not serve a charging production environment/);
});

test('seal and gateway decrypt roundtrip through the real loaders', async () => {
  const generated = await seal();
  const gateway = await loadGatewayProviderCredentialUnsealingKms({ env: gatewayEnv(), importer: softwareImporter });
  assert.ok(gateway);
  const plaintext = await gateway.decryptDataKey({
    kmsKeyId: KEY_ID_V1,
    ciphertextBlob: generated.ciphertextBlob,
    encryptionContext: CONTEXT,
  });
  assert.deepEqual(Buffer.from(plaintext), Buffer.from(generated.plaintextKey));
  assert.equal(Buffer.from(generated.ciphertextBlob).subarray(0, 7).toString('ascii'), 'MRSKMS1');
  await generated.close();
  await gateway.close();
});

test('seal and validation-worker decrypt roundtrip through the real loaders', async () => {
  const generated = await seal();
  const worker = await loadValidationWorkerProviderCredentialKms({ env: workerEnv(), importer: softwareImporter });
  assert.ok(worker);
  const plaintext = await worker.decryptDataKey({
    kmsKeyId: KEY_ID_V1,
    ciphertextBlob: generated.ciphertextBlob,
    encryptionContext: CONTEXT,
  });
  assert.deepEqual(Buffer.from(plaintext), Buffer.from(generated.plaintextKey));
  await generated.close();
  await worker.close();
});

test('decryption fails closed on a mismatched encryption context, key id or tampered blob', async () => {
  const generated = await seal();
  const gateway = await loadGatewayProviderCredentialUnsealingKms({ env: gatewayEnv(), importer: softwareImporter });
  assert.ok(gateway);
  await assert.rejects(
    gateway.decryptDataKey({
      kmsKeyId: KEY_ID_V1,
      ciphertextBlob: generated.ciphertextBlob,
      encryptionContext: { ...CONTEXT, owner: 'tenant-2' },
    }),
    (error: unknown) =>
      error instanceof ProviderCredentialUnsealingKmsError && error.code === 'DATA_KEY_DECRYPTION_FAILED',
  );
  await assert.rejects(
    gateway.decryptDataKey({
      kmsKeyId: 'soft-other',
      ciphertextBlob: generated.ciphertextBlob,
      encryptionContext: CONTEXT,
    }),
    (error: unknown) =>
      error instanceof ProviderCredentialUnsealingKmsError && error.code === 'DATA_KEY_DECRYPTION_FAILED',
  );
  const tampered = Buffer.from(generated.ciphertextBlob);
  tampered[tampered.byteLength - 1] = tampered[tampered.byteLength - 1]! ^ 1;
  await assert.rejects(
    gateway.decryptDataKey({ kmsKeyId: KEY_ID_V1, ciphertextBlob: tampered, encryptionContext: CONTEXT }),
    (error: unknown) =>
      error instanceof ProviderCredentialUnsealingKmsError && error.code === 'DATA_KEY_DECRYPTION_FAILED',
  );
  // Safe errors carry no request or key detail.
  const failure = await gateway
    .decryptDataKey({ kmsKeyId: KEY_ID_V1, ciphertextBlob: tampered, encryptionContext: CONTEXT })
    .then(
      () => undefined,
      (error: unknown) => error as Error,
    );
  assert.ok(failure);
  for (const leaked of [MASTER_KEY_V1, KEY_ID_V1, 'tenant-1']) {
    assert.equal(failure.message.includes(leaked), false);
  }
  await generated.close();
  await gateway.close();
});

test('decryption under a ring without the wrapping key fails closed', async () => {
  const generated = await seal();
  const other = await loadGatewayProviderCredentialUnsealingKms({
    env: gatewayEnv({ [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V2 }),
    importer: softwareImporter,
  });
  assert.ok(other);
  await assert.rejects(
    other.decryptDataKey({ kmsKeyId: KEY_ID_V1, ciphertextBlob: generated.ciphertextBlob, encryptionContext: CONTEXT }),
    (error: unknown) =>
      error instanceof ProviderCredentialUnsealingKmsError && error.code === 'DATA_KEY_DECRYPTION_FAILED',
  );
  await generated.close();
  await other.close();
});

test('generation rejects a mismatched request key id or key spec', async () => {
  const kms = await loadProviderCredentialSealingKms({ env: sealEnv(), importer: softwareImporter });
  assert.ok(kms);
  await assert.rejects(
    kms.generateDataKey({ kmsKeyId: 'soft-other', keySpec: 'AES_256', encryptionContext: CONTEXT }),
    (error: unknown) => error instanceof ProviderCredentialKmsError && error.code === 'DATA_KEY_GENERATION_FAILED',
  );
  await assert.rejects(
    kms.generateDataKey({
      kmsKeyId: KEY_ID_V1,
      keySpec: 'AES_128' as 'AES_256',
      encryptionContext: CONTEXT,
    }),
    (error: unknown) => error instanceof ProviderCredentialKmsError && error.code === 'DATA_KEY_GENERATION_FAILED',
  );
  await kms.close();
});

test('rewrap rotates a wrapped key to the current master key without exposing plaintext', async () => {
  const generated = await seal();
  // Rotation deployment: the rewrap module is a DISTINCT specifier from seal/decrypt.
  const rewrap = await loadProviderCredentialRewrappingKms({
    env: {
      [SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE]: REWRAP_SPECIFIER,
      [DESTINATION_KEY_ID_SETTING]: KEY_ID_V2,
      ...rotatedEnv(),
    },
  });
  assert.ok(rewrap);
  const rotatedContext = { ...CONTEXT, rotated: 'true' };
  const reencrypted = await rewrap.reencryptDataKey({
    sourceKmsKeyId: KEY_ID_V1,
    destinationKmsKeyId: KEY_ID_V2,
    ciphertextBlob: generated.ciphertextBlob,
    sourceEncryptionContext: CONTEXT,
    destinationEncryptionContext: rotatedContext,
  });
  assert.equal(reencrypted.sourceKmsKeyId, KEY_ID_V1);
  assert.equal(reencrypted.destinationKmsKeyId, KEY_ID_V2);

  // The rotated blob unwraps under the current v2 key with the NEW context.
  const gateway = await loadGatewayProviderCredentialUnsealingKms({
    env: gatewayEnv(rotatedEnv()),
    importer: softwareImporter,
  });
  assert.ok(gateway);
  const plaintext = await gateway.decryptDataKey({
    kmsKeyId: KEY_ID_V2,
    ciphertextBlob: reencrypted.ciphertextBlob,
    encryptionContext: rotatedContext,
  });
  assert.deepEqual(Buffer.from(plaintext), Buffer.from(generated.plaintextKey));

  // The old context no longer authenticates the rotated blob.
  await assert.rejects(
    gateway.decryptDataKey({
      kmsKeyId: KEY_ID_V2,
      ciphertextBlob: reencrypted.ciphertextBlob,
      encryptionContext: CONTEXT,
    }),
    (error: unknown) =>
      error instanceof ProviderCredentialUnsealingKmsError && error.code === 'DATA_KEY_DECRYPTION_FAILED',
  );

  // A source-context mismatch rejects the rewrap before any plaintext exists.
  await assert.rejects(
    rewrap.reencryptDataKey({
      sourceKmsKeyId: KEY_ID_V1,
      destinationKmsKeyId: KEY_ID_V2,
      ciphertextBlob: generated.ciphertextBlob,
      sourceEncryptionContext: { ...CONTEXT, owner: 'tenant-2' },
      destinationEncryptionContext: rotatedContext,
    }),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'REENCRYPT_FAILED',
  );
  await generated.close();
  await rewrap.close();
  await gateway.close();
});

test('rewrap rejects a destination key id that is not the configured current key', async () => {
  const generated = await seal();
  const rewrap = await loadProviderCredentialRewrappingKms({
    env: {
      [SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE]: REWRAP_SPECIFIER,
      [DESTINATION_KEY_ID_SETTING]: KEY_ID_V1,
      [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V1,
      [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V1,
    },
  });
  assert.ok(rewrap);
  await assert.rejects(
    rewrap.reencryptDataKey({
      sourceKmsKeyId: KEY_ID_V1,
      destinationKmsKeyId: 'soft-other',
      ciphertextBlob: generated.ciphertextBlob,
      sourceEncryptionContext: CONTEXT,
      destinationEncryptionContext: CONTEXT,
    }),
    (error: unknown) => error instanceof ProviderCredentialRewrappingKmsError && error.code === 'REENCRYPT_FAILED',
  );
  await generated.close();
  await rewrap.close();
});

test('previous master keys keep old envelopes decryptable after rotation', async () => {
  const generated = await seal();
  const gateway = await loadGatewayProviderCredentialUnsealingKms({
    env: gatewayEnv(rotatedEnv()),
    importer: softwareImporter,
  });
  assert.ok(gateway);
  const plaintext = await gateway.decryptDataKey({
    kmsKeyId: KEY_ID_V1,
    ciphertextBlob: generated.ciphertextBlob,
    encryptionContext: CONTEXT,
  });
  assert.deepEqual(Buffer.from(plaintext), Buffer.from(generated.plaintextKey));
  await generated.close();
  await gateway.close();
});

test('a missing or malformed master key fails the factory without leaking detail', async () => {
  await assert.rejects(
    loadProviderCredentialSealingKms({
      env: sealEnv({ [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: undefined }),
      importer: softwareImporter,
    }),
    (error: unknown) => {
      const record = error as { code?: string; message?: string };
      assert.equal(record.code, 'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED');
      return true;
    },
  );
  await assert.rejects(
    loadProviderCredentialSealingKms({
      env: sealEnv({ [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: 'not-hex' }),
      importer: softwareImporter,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED',
  );
  await assert.rejects(
    loadGatewayProviderCredentialUnsealingKms({
      env: gatewayEnv({
        [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: randomBytes(16).toString('hex'),
      }),
      importer: softwareImporter,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED',
  );
});

test('invalid previous-key configuration fails the factory', async () => {
  for (const previous of [
    `${KEY_ID_V1}=${MASTER_KEY_V2}`, // duplicates the current key id
    `soft-old=not-hex`,
    `soft-old=${MASTER_KEY_V2},soft-old=${MASTER_KEY_V1}`,
    'soft-old',
  ]) {
    await assert.rejects(
      loadProviderCredentialSealingKms({
        env: sealEnv({ [MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS]: previous }),
        importer: softwareImporter,
      }),
      (error: unknown) => (error as { code?: string }).code === 'PROVIDER_CREDENTIAL_KMS_FACTORY_FAILED',
    );
  }
});

test('close zeroes the ring, is idempotent and closes every operation', async () => {
  const kms = await loadProviderCredentialSealingKms({ env: sealEnv(), importer: softwareImporter });
  assert.ok(kms);
  await kms.close();
  await kms.close();
  await assert.rejects(
    kms.generateDataKey({ kmsKeyId: KEY_ID_V1, keySpec: 'AES_256', encryptionContext: CONTEXT }),
    (error: unknown) => error instanceof ProviderCredentialKmsError && error.code === 'DATA_KEY_GENERATION_FAILED',
  );
  await assert.rejects(
    kms.checkReady(),
    (error: unknown) => error instanceof ProviderCredentialKmsError && error.code === 'READINESS_FAILED',
  );

  const worker = await loadValidationWorkerProviderCredentialKms({ env: workerEnv(), importer: softwareImporter });
  assert.ok(worker);
  await worker.close();
  await assert.rejects(
    worker.decryptDataKey({ kmsKeyId: KEY_ID_V1, ciphertextBlob: randomBytes(64), encryptionContext: CONTEXT }),
    (error: unknown) => error instanceof ValidationWorkerProviderCredentialKmsError,
  );
});
