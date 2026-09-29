import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  createProviderCredentialEncryptionContext,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { ProviderCredentialUnsealingKms } from '../../../src/saas/runtime/gateway-provider-credential-kms.js';
import {
  type GatewayProviderCredentialAccount,
  type GatewayProviderCredentialCredential,
  GatewayProviderCredentialUnsealer,
  GatewayProviderCredentialUnsealerError,
  type GatewayProviderCredentialUnsealInput,
} from '../../../src/saas/runtime/gateway-provider-credential-unsealer.js';
import type { StoredProviderCredentialVersion } from '../../../src/saas/supply/types.js';

const SECRET = 'gateway-only-provider-secret';
const SENSITIVE_KMS_ERROR = 'kms-error-provider-secret';
const SENSITIVE_CIPHERTEXT = 'ciphertext-must-not-escape';
const KMS_KEY_ID = 'kms/provider-supply';
const OPTIONS = Object.freeze({ deployment: 'managed-saas', environment: 'test' });

const account: GatewayProviderCredentialAccount = {
  ownerKind: 'tenant',
  tenantId: 'tenant-a',
  supplyMode: 'byok',
  id: 'account-a',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  purpose: 'inference',
};

const credential: GatewayProviderCredentialCredential = {
  ownerKind: 'tenant',
  tenantId: 'tenant-a',
  supplyMode: 'byok',
  id: 'credential-a',
  accountId: 'account-a',
  providerId: 'provider-a',
  productId: 'product-a',
};

function sealingContext(overrides: Partial<ProviderCredentialContext> = {}): ProviderCredentialContext {
  return {
    ...createProviderCredentialContext({
      deployment: OPTIONS.deployment,
      environment: OPTIONS.environment,
      ownerKind: 'tenant',
      tenantId: account.tenantId,
      supplyMode: 'byok',
      purpose: account.purpose,
      providerId: account.providerId,
      productId: account.productId,
      accountId: account.id,
      credentialId: credential.id,
      credentialVersion: 1,
      credentialType: account.credentialType,
    }),
    ...overrides,
  } as ProviderCredentialContext;
}

function contextKey(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

class SealingKms implements ProviderCredentialKms {
  readonly entries = new Map<string, { readonly key: Buffer; readonly context: string }>();
  private sequence = 0;

  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const plaintextKey = randomBytes(32);
    const ciphertextBlob = Buffer.from(`wrapped-${this.sequence}`, 'utf8');
    this.sequence += 1;
    this.entries.set(ciphertextBlob.toString('base64url'), {
      key: Buffer.from(plaintextKey),
      context: contextKey(request.encryptionContext),
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!entry || entry.context !== contextKey(request.encryptionContext) || request.kmsKeyId !== KMS_KEY_ID) {
      throw new Error('KMS context mismatch');
    }
    return Buffer.from(entry.key);
  }
}

class GatewayKms {
  readonly returnedKeys: Buffer[] = [];
  calls = 0;
  fail = false;
  enforceContext = true;

  constructor(private readonly sealingKms: SealingKms) {}

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    this.calls += 1;
    if (this.fail) throw new Error(`${SENSITIVE_KMS_ERROR}:${SENSITIVE_CIPHERTEXT}`);
    const entry = this.sealingKms.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (!entry || (this.enforceContext && entry.context !== contextKey(request.encryptionContext))) {
      throw new Error('gateway KMS context mismatch');
    }
    const returned = Buffer.from(entry.key);
    this.returnedKeys.push(returned);
    return returned;
  }
}

function gatewayFacade(gateway: GatewayKms): ProviderCredentialUnsealingKms {
  return {
    decryptDataKey: gateway.decryptDataKey.bind(gateway),
    checkReady: async () => undefined,
    close: async () => undefined,
  };
}

function storedVersion(envelope: ProviderCredentialEnvelope): StoredProviderCredentialVersion {
  return {
    ownerKind: account.ownerKind,
    tenantId: account.tenantId,
    accountId: account.id,
    credentialId: credential.id,
    version: 1,
    status: 'active',
    envelopeSchemaVersion: envelope.schemaVersion,
    contextVersion: envelope.contextVersion,
    algorithm: envelope.algorithm,
    kmsPurpose: account.purpose,
    wrappingRevision: 1,
    createdAt: '2026-09-28T00:00:00.000Z',
    expiresAt: null,
    retiredAt: null,
    revokedAt: null,
    kmsKeyId: envelope.kmsKeyId,
    envelope,
  };
}

async function fixture(): Promise<{
  readonly input: GatewayProviderCredentialUnsealInput;
  readonly sealer: SealingKms;
  readonly gateway: GatewayKms;
}> {
  const sealer = new SealingKms();
  const envelope = await sealProviderCredential(Buffer.from(SECRET), sealingContext(), sealer, KMS_KEY_ID);
  const gateway = new GatewayKms(sealer);
  return {
    input: { account, credential, version: storedVersion(envelope) },
    sealer,
    gateway,
  };
}

function assertSafeError(error: unknown, code: GatewayProviderCredentialUnsealerError['code']): void {
  assert.ok(error instanceof GatewayProviderCredentialUnsealerError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(SECRET), false);
  assert.equal(error.message.includes(SENSITIVE_KMS_ERROR), false);
  assert.equal(error.message.includes(SENSITIVE_CIPHERTEXT), false);
  assert.equal(String(error).includes(SECRET), false);
  assert.equal(String(error).includes(SENSITIVE_CIPHERTEXT), false);
}

test('unseals an existing supply envelope through only the gateway decrypt facade', async () => {
  const { input, gateway } = await fixture();
  const facade = gatewayFacade(gateway);
  assert.equal('generateDataKey' in facade, false);
  const unsealer = new GatewayProviderCredentialUnsealer(facade, OPTIONS);
  let callbackBuffer: Buffer | undefined;

  const result = await unsealer.withCredential(input, (plaintext) => {
    callbackBuffer = plaintext;
    assert.equal(plaintext.toString('utf8'), SECRET);
    return 'dispatch-ready';
  });

  assert.equal(result, 'dispatch-ready');
  assert.ok(callbackBuffer);
  assert.deepEqual(callbackBuffer, Buffer.alloc(callbackBuffer.length));
  assert.equal(gateway.calls, 1);
  assert.equal(gateway.returnedKeys.length, 1);
  assert.deepEqual(gateway.returnedKeys[0], Buffer.alloc(32));
});

test('uses the exact control-plane canonical context for KMS and rejects metadata substitution', async () => {
  const { input, gateway } = await fixture();
  const expectedContext = createProviderCredentialEncryptionContext(sealingContext());
  const contextSeen: string[] = [];
  const originalDecrypt = gateway.decryptDataKey.bind(gateway);
  gateway.decryptDataKey = async (request) => {
    contextSeen.push(JSON.stringify(Object.entries(request.encryptionContext)));
    return originalDecrypt(request);
  };
  const unsealer = new GatewayProviderCredentialUnsealer(gatewayFacade(gateway), OPTIONS);
  await unsealer.withCredential(input, () => undefined);
  assert.deepEqual(JSON.parse(contextSeen[0] ?? 'null'), Object.entries(expectedContext));

  await assert.rejects(
    unsealer.withCredential(
      { ...input, account: { ...account, providerId: 'different-provider' } },
      () => 'not-reached',
    ),
    (error: unknown) => {
      assertSafeError(error, 'METADATA_MISMATCH');
      return true;
    },
  );
  assert.equal(gateway.calls, 1);
});

test('maps a gateway KMS failure without exposing provider errors', async () => {
  const { input, gateway } = await fixture();
  gateway.fail = true;
  const unsealer = new GatewayProviderCredentialUnsealer(gatewayFacade(gateway), OPTIONS);

  await assert.rejects(
    unsealer.withCredential(input, () => 'not-reached'),
    (error: unknown) => {
      assertSafeError(error, 'KMS_DECRYPTION_FAILED');
      return true;
    },
  );
});

test('maps an AAD mismatch to an authenticated decryption error', async () => {
  const { input, gateway } = await fixture();
  gateway.enforceContext = false;
  const unsealer = new GatewayProviderCredentialUnsealer(gatewayFacade(gateway), {
    deployment: OPTIONS.deployment,
    environment: 'different-environment',
  });

  await assert.rejects(
    unsealer.withCredential(input, () => 'not-reached'),
    (error: unknown) => {
      assertSafeError(error, 'GCM_DECRYPTION_FAILED');
      return true;
    },
  );
  assert.deepEqual(gateway.returnedKeys[0], Buffer.alloc(32));
});

test('maps an authenticated decryption failure and clears the gateway data key', async () => {
  const { input, gateway } = await fixture();
  gateway.enforceContext = false;
  const envelope = input.version.envelope;
  const tampered: ProviderCredentialEnvelope = {
    ...envelope,
    authTag: `${envelope.authTag[0] === 'A' ? 'B' : 'A'}${envelope.authTag.slice(1)}`,
  };
  const unsealer = new GatewayProviderCredentialUnsealer(gatewayFacade(gateway), OPTIONS);

  await assert.rejects(
    unsealer.withCredential({ ...input, version: { ...input.version, envelope: tampered } }, () => 'not-reached'),
    (error: unknown) => {
      assertSafeError(error, 'GCM_DECRYPTION_FAILED');
      return true;
    },
  );
  assert.equal(gateway.returnedKeys.length, 1);
  assert.deepEqual(gateway.returnedKeys[0], Buffer.alloc(32));
});

test('maps callback failures and zeroizes both callback plaintext and data key', async () => {
  const { input, gateway } = await fixture();
  const unsealer = new GatewayProviderCredentialUnsealer(gatewayFacade(gateway), OPTIONS);
  let callbackBuffer: Buffer | undefined;

  await assert.rejects(
    unsealer.withCredential(input, (plaintext) => {
      callbackBuffer = plaintext;
      throw new Error(`${SECRET}:${SENSITIVE_CIPHERTEXT}`);
    }),
    (error: unknown) => {
      assertSafeError(error, 'CALLBACK_FAILED');
      return true;
    },
  );
  assert.ok(callbackBuffer);
  assert.deepEqual(callbackBuffer, Buffer.alloc(callbackBuffer.length));
  assert.deepEqual(gateway.returnedKeys[0], Buffer.alloc(32));
});
