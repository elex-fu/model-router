import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ProviderModuleImporter } from '../../../src/saas/runtime/providers.js';
import * as softwareModule from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  createGatewayProviderCredentialUnsealingKms,
  createProviderCredentialSealingKms,
  createWebhookSigningSecretProtector,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY,
  MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS,
  SoftwareProviderCredentialKmsError,
} from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  loadWebhookSigningSecretProtector,
  MODEL_ROUTER_SAAS_CUSTOMER_WEBHOOK_SIGNING_PROTECTOR_MODULE,
  WebhookSigningSecretProtectorLoaderError,
} from '../../../src/saas/runtime/webhook-signing-secret-protector.js';
import { webhookSigningSecretAad } from '../../../src/saas/webhooks/signing-secret-protector.js';

// F1 / C-2.2: the software webhook signing-secret protector is exercised
// through the REAL trusted-module loader, proving purpose pinning, AAD
// authentication, cross-domain magic separation, the embedded-key-id rotation
// story, and the pilot-only production readiness gate end to end.

const PROTECTOR_SPECIFIER = './src/saas/runtime/software-provider-credential-kms.ts';

const MASTER_KEY_V1 = randomBytes(32).toString('hex');
const MASTER_KEY_V2 = randomBytes(32).toString('hex');
const KEY_ID_V1 = 'hook-v1';
const KEY_ID_V2 = 'hook-v2';

const TENANT_ID = randomUUID();
const ENDPOINT_ID = randomUUID();
const AAD = webhookSigningSecretAad({ tenantId: TENANT_ID, endpointId: ENDPOINT_ID, secretVersion: 1 });
const OTHER_AAD = webhookSigningSecretAad({ tenantId: TENANT_ID, endpointId: randomUUID(), secretVersion: 1 });

const softwareImporter: ProviderModuleImporter = async () => softwareModule;

function protectorEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [MODEL_ROUTER_SAAS_CUSTOMER_WEBHOOK_SIGNING_PROTECTOR_MODULE]: PROTECTOR_SPECIFIER,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V1,
    [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V1,
    ...overrides,
  };
}

test('protector round-trips 32-byte and 256-byte secrets through the loader', async () => {
  const protector = await loadWebhookSigningSecretProtector({ env: protectorEnv(), importer: softwareImporter });
  assert.ok(protector);
  assert.equal(protector.purpose, 'customer-webhook-signing-secret-v1');
  for (const bytes of [32, 43, 256]) {
    const plaintext = randomBytes(bytes);
    const envelope = await protector.protect(plaintext, AAD);
    assert.ok(envelope.byteLength > plaintext.byteLength);
    assert.ok(Buffer.from(envelope).subarray(0, 7).equals(Buffer.from('MRWHKS1', 'ascii')));
    const unwrapped = await protector.unprotect(envelope, AAD);
    assert.ok(Buffer.from(unwrapped).equals(plaintext));
  }
  await protector.close();
  await protector.close();
});

test('a wrong AAD fails closed and never returns plaintext', async () => {
  const protector = await loadWebhookSigningSecretProtector({ env: protectorEnv(), importer: softwareImporter });
  assert.ok(protector);
  const envelope = await protector.protect(randomBytes(32), AAD);
  await assert.rejects(protector.unprotect(envelope, OTHER_AAD), (error: unknown) => {
    assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
    assert.equal(error.code, 'UNPROTECT_FAILED');
    return true;
  });
  const wrongVersion = webhookSigningSecretAad({ tenantId: TENANT_ID, endpointId: ENDPOINT_ID, secretVersion: 2 });
  await assert.rejects(protector.unprotect(envelope, wrongVersion), /unprotect operation failed/i);
  await protector.close();
});

test('webhook and provider-credential envelopes are non-interchangeable', async () => {
  const env = protectorEnv();
  const protector = createWebhookSigningSecretProtector({ env });
  const sealing = createProviderCredentialSealingKms({ env });
  const unsealing = createGatewayProviderCredentialUnsealingKms({ env });

  // A webhook blob refused by the provider-credential unwrap path.
  const webhookEnvelope = await protector.protect(randomBytes(32), AAD);
  assert.throws(
    () =>
      unsealing.decryptDataKey({
        ciphertextBlob: webhookEnvelope,
        kmsKeyId: KEY_ID_V1,
        encryptionContext: { purpose: 'provider-credential', owner: 'tenant-1' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SoftwareProviderCredentialKmsError);
      assert.equal(error.code, 'OPERATION_FAILED');
      return true;
    },
  );

  // A provider-credential blob refused by the webhook unprotect path.
  const generated = sealing.generateDataKey({
    kmsKeyId: KEY_ID_V1,
    keySpec: 'AES_256',
    encryptionContext: { purpose: 'provider-credential', owner: 'tenant-1' },
  });
  await assert.rejects(protector.unprotect(generated.ciphertextBlob, AAD), (error: unknown) => {
    assert.ok(error instanceof SoftwareProviderCredentialKmsError);
    assert.equal(error.code, 'OPERATION_FAILED');
    return true;
  });
  await protector.close();
  await sealing.close();
  await unsealing.close();
});

test('plaintext and AAD bounds are enforced before any crypto runs', async () => {
  const protector = createWebhookSigningSecretProtector({ env: protectorEnv() });
  await assert.rejects(protector.protect(randomBytes(31), AAD), TypeError);
  await assert.rejects(protector.protect(randomBytes(257), AAD), TypeError);
  await assert.rejects(protector.protect(randomBytes(32), Buffer.alloc(0)), (error: unknown) => {
    assert.ok(error instanceof SoftwareProviderCredentialKmsError);
    assert.equal(error.code, 'OPERATION_FAILED');
    return true;
  });
  await assert.rejects(protector.protect(randomBytes(32), randomBytes(1025)), SoftwareProviderCredentialKmsError);
  // The loader rejects out-of-contract plaintext before calling the module.
  const loaded = await loadWebhookSigningSecretProtector({ env: protectorEnv(), importer: softwareImporter });
  assert.ok(loaded);
  await assert.rejects(loaded.protect(randomBytes(16), AAD), TypeError);
  await loaded.close();
  await protector.close();
});

test('previous master keys keep envelopes unprotectable after rotation via the embedded key id', async () => {
  const rotated = await loadWebhookSigningSecretProtector({
    env: protectorEnv({
      [MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]: MASTER_KEY_V2,
      [MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]: KEY_ID_V2,
      [MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS]: `${KEY_ID_V1}=${MASTER_KEY_V1}`,
    }),
    importer: softwareImporter,
  });
  assert.ok(rotated);
  const beforeRotation = createWebhookSigningSecretProtector({ env: protectorEnv() });
  const plaintext = randomBytes(32);
  const envelope = await beforeRotation.protect(plaintext, AAD);
  assert.ok(Buffer.from(await rotated.unprotect(envelope, AAD)).equals(plaintext));
  // New envelopes wrap under the current key only.
  const freshEnvelope = await rotated.protect(plaintext, AAD);
  assert.ok(Buffer.from(await rotated.unprotect(freshEnvelope, AAD)).equals(plaintext));
  await assert.rejects(beforeRotation.unprotect(freshEnvelope, AAD), SoftwareProviderCredentialKmsError);
  await rotated.close();
  await beforeRotation.close();
});

test('the pilot-only gate refuses production readiness without the explicit opt-in', async () => {
  const direct = createWebhookSigningSecretProtector({ env: protectorEnv({ NODE_ENV: 'production' }) });
  await assert.rejects(direct.checkReady(), (error: unknown) => {
    assert.ok(error instanceof SoftwareProviderCredentialKmsError);
    assert.equal(error.code, 'CONFIGURATION_INVALID');
    return true;
  });
  await direct.close();

  await assert.rejects(
    loadWebhookSigningSecretProtector({
      env: protectorEnv({ NODE_ENV: 'production' }),
      importer: softwareImporter,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'READINESS_FAILED');
      return true;
    },
  );

  const optedIn = await loadWebhookSigningSecretProtector({
    env: protectorEnv({ NODE_ENV: 'production', [MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT]: 'true' }),
    importer: softwareImporter,
  });
  assert.ok(optedIn);
  await optedIn.close();

  // Non-production deployments need no opt-in.
  const development = await loadWebhookSigningSecretProtector({
    env: protectorEnv({ NODE_ENV: 'development' }),
    importer: softwareImporter,
  });
  assert.ok(development);
  await development.close();
});

test('close zeroes the ring, is idempotent, and closes every operation', async () => {
  const protector = createWebhookSigningSecretProtector({ env: protectorEnv() });
  const envelope = await protector.protect(randomBytes(32), AAD);
  await protector.close();
  await protector.close();
  await assert.rejects(protector.protect(randomBytes(32), AAD), (error: unknown) => {
    assert.ok(error instanceof SoftwareProviderCredentialKmsError);
    assert.equal(error.code, 'PROVIDER_CLOSED');
    return true;
  });
  await assert.rejects(protector.unprotect(envelope, AAD), SoftwareProviderCredentialKmsError);
  await assert.rejects(protector.checkReady(), SoftwareProviderCredentialKmsError);
});

test('the loader fails closed on missing exports, wrong purpose, and bad lifecycle', async () => {
  // No module specifier configured → the optional capability stays absent.
  assert.equal(await loadWebhookSigningSecretProtector({ env: {}, importer: softwareImporter }), undefined);

  await assert.rejects(
    loadWebhookSigningSecretProtector({ env: protectorEnv(), importer: async () => ({}) }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'MODULE_EXPORT_INVALID');
      return true;
    },
  );

  await assert.rejects(
    loadWebhookSigningSecretProtector({
      env: protectorEnv(),
      importer: async () => ({
        createWebhookSigningSecretProtector: () => ({
          purpose: 'provider-credential-data-key-v1',
          protect: async () => new Uint8Array(64),
          unprotect: async () => new Uint8Array(32),
          checkReady: async () => undefined,
          close: async () => undefined,
        }),
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'PROTECTOR_INVALID');
      return true;
    },
  );

  await assert.rejects(
    loadWebhookSigningSecretProtector({
      env: protectorEnv(),
      importer: async () => ({
        createWebhookSigningSecretProtector: () => ({
          purpose: 'customer-webhook-signing-secret-v1',
          protect: async () => new Uint8Array(64),
          unprotect: async () => new Uint8Array(32),
          checkReady: async () => undefined,
        }),
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'PROTECTOR_INVALID');
      return true;
    },
  );

  await assert.rejects(
    loadWebhookSigningSecretProtector({
      env: protectorEnv(),
      importer: async () => ({
        createWebhookSigningSecretProtector: () => {
          throw new Error('boom');
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'FACTORY_FAILED');
      return true;
    },
  );

  await assert.rejects(
    loadWebhookSigningSecretProtector({ env: protectorEnv(), importer: async () => Promise.reject(new Error('nope')) }),
    (error: unknown) => {
      assert.ok(error instanceof WebhookSigningSecretProtectorLoaderError);
      assert.equal(error.code, 'MODULE_LOAD_FAILED');
      return true;
    },
  );
});

test('the loader re-validates module output against the contract assertions', async () => {
  const lyingModule = {
    createWebhookSigningSecretProtector: () => ({
      purpose: 'customer-webhook-signing-secret-v1',
      protect: async () => new Uint8Array(0),
      unprotect: async () => new Uint8Array(8),
      checkReady: async () => undefined,
      close: async () => undefined,
    }),
  };
  const protector = await loadWebhookSigningSecretProtector({
    env: protectorEnv(),
    importer: async () => lyingModule,
  });
  assert.ok(protector);
  await assert.rejects(protector.protect(randomBytes(32), AAD), TypeError);
  await assert.rejects(protector.unprotect(randomBytes(64), AAD), TypeError);
  await protector.close();
});
