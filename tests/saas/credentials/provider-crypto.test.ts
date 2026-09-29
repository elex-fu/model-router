import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  createProviderCredentialEncryptionContext,
  MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  ProviderCredentialCryptoError,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  sealProviderCredential,
  withUnsealedProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';

const tenantContext = {
  deployment: 'production',
  environment: 'us-east-1',
  ownerKind: 'tenant',
  tenantId: 'tenant-1',
  purpose: 'inference',
  providerId: 'openai-compatible',
  productId: 'chat',
  credentialId: 'credential-1',
  credentialVersion: 1,
  credentialType: 'api-key',
  supplyMode: 'byok',
} as const satisfies ProviderCredentialContext;

const platformContext = {
  deployment: 'production',
  environment: 'us-east-1',
  ownerKind: 'platform',
  purpose: 'inference',
  providerId: 'openai-compatible',
  productId: 'chat',
  credentialId: 'credential-1',
  credentialVersion: 1,
  credentialType: 'api-key',
  supplyMode: 'platform',
} as const satisfies ProviderCredentialContext;

function canonicalKmsContext(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

class ContextBindingFakeKms implements ProviderCredentialKms {
  readonly generatedContexts: string[] = [];
  readonly entries = new Map<string, { kmsKeyId: string; context: string; key: Buffer }>();

  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const plaintextKey = randomBytes(32);
    const ciphertextBlob = randomBytes(48);
    const context = canonicalKmsContext(request.encryptionContext);
    this.generatedContexts.push(context);
    this.entries.set(ciphertextBlob.toString('base64url'), {
      kmsKeyId: request.kmsKeyId,
      context,
      key: Buffer.from(plaintextKey),
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (
      !entry ||
      entry.kmsKeyId !== request.kmsKeyId ||
      entry.context !== canonicalKmsContext(request.encryptionContext)
    ) {
      throw new Error('KMS encryption context mismatch');
    }
    return Buffer.from(entry.key);
  }
}

function assertCryptoError(error: unknown, code?: ProviderCredentialCryptoError['code']): void {
  assert.ok(error instanceof ProviderCredentialCryptoError);
  if (code) assert.equal(error.code, code);
}

async function seal(
  secret: Uint8Array = Buffer.from('provider-secret-value'),
  context: ProviderCredentialContext = tenantContext,
  kms: ProviderCredentialKms = new ContextBindingFakeKms(),
): Promise<{ envelope: ProviderCredentialEnvelope; kms: ProviderCredentialKms }> {
  const resolvedKms = kms;
  const envelope = await sealProviderCredential(secret, context, resolvedKms, 'kms/provider-credentials');
  return { envelope, kms: resolvedKms };
}

test('round-trips through a per-secret KMS data-key envelope and canonical context', async () => {
  const kms = new ContextBindingFakeKms();
  const secret = Buffer.from('sk-live-provider-secret');
  const envelope = await sealProviderCredential(secret, tenantContext, kms, 'kms/provider-credentials');

  assert.deepEqual(Object.keys(envelope).sort(), [
    'algorithm',
    'authTag',
    'ciphertext',
    'contextVersion',
    'kmsKeyId',
    'nonce',
    'schemaVersion',
    'wrappedDek',
  ]);
  assert.equal(envelope.schemaVersion, PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.algorithm, PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM);
  assert.equal(envelope.kmsKeyId, 'kms/provider-credentials');
  assert.notEqual(envelope.wrappedDek.length, 0);
  assert.equal(JSON.stringify(envelope).includes(secret.toString('utf8')), false);
  let unsealedCopy: Buffer | undefined;
  assert.equal(
    await withUnsealedProviderCredential(envelope, tenantContext, kms, (value) => {
      unsealedCopy = Buffer.from(value);
      return 'callback-complete';
    }),
    'callback-complete',
  );
  assert.deepEqual(unsealedCopy, secret);
  assert.deepEqual(createProviderCredentialEncryptionContext(tenantContext), {
    contextVersion: '1',
    credentialId: 'credential-1',
    credentialType: 'api-key',
    credentialVersion: '1',
    deployment: 'production',
    domain: 'model-router/saas-provider-credential',
    environment: 'us-east-1',
    ownerKind: 'tenant',
    productId: 'chat',
    providerId: 'openai-compatible',
    purpose: 'inference',
    supplyMode: 'byok',
    tenantId: 'tenant-1',
  });
});

test('builds the historic qualified credential ID for ordinary and long UTF-8 identities', () => {
  const ordinary = createProviderCredentialContext({
    deployment: 'production',
    environment: 'us-east-1',
    ownerKind: 'tenant',
    tenantId: 'tenant-1',
    supplyMode: 'byok',
    purpose: 'inference',
    providerId: 'openai-compatible',
    productId: 'chat',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 1,
    credentialType: 'api-key',
  });
  const ordinaryQualifiedId = 'owner16:tenant8:tenant-1|account9:account-1|credential12:credential-1';
  assert.equal(ordinary.credentialId, ordinaryQualifiedId);
  assert.equal(createProviderCredentialEncryptionContext(ordinary).credentialId, ordinaryQualifiedId);

  const accountId = '账'.repeat(38);
  const credentialId = '钥'.repeat(38);
  const expandedQualifiedId = `owner16:tenant8:tenant-1|account${accountId.length}:${accountId}|credential${credentialId.length}:${credentialId}`;
  assert.ok(Buffer.byteLength(expandedQualifiedId, 'utf8') > 256);
  const longIdentity = createProviderCredentialContext({
    deployment: 'production',
    environment: 'us-east-1',
    ownerKind: 'tenant',
    tenantId: 'tenant-1',
    supplyMode: 'byok',
    purpose: 'inference',
    providerId: 'openai-compatible',
    productId: 'chat',
    accountId,
    credentialId,
    credentialVersion: 1,
    credentialType: 'api-key',
  });
  const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(
    longIdentity.credentialId,
    `owner6:tenant|account-sha256:${digest(accountId)}|credential-sha256:${digest(credentialId)}`,
  );
  assert.ok(Buffer.byteLength(longIdentity.credentialId, 'utf8') <= 256);
});

test('rejects context substitution for tenant/platform owner, identity, and every bound field', async () => {
  const kms = new ContextBindingFakeKms();
  const { envelope } = await seal(Buffer.from('context-bound-secret'), tenantContext, kms);
  const substitutions: ProviderCredentialContext[] = [
    { ...tenantContext, tenantId: 'tenant-2' },
    { ...tenantContext, providerId: 'another-provider' },
    { ...tenantContext, productId: 'embeddings' },
    { ...tenantContext, credentialId: 'credential-2' },
    { ...tenantContext, credentialVersion: 2 },
    { ...tenantContext, credentialType: 'oauth-token' },
    { ...tenantContext, purpose: 'fine-tuning' },
    { ...tenantContext, environment: 'staging' },
    { ...tenantContext, deployment: 'canary' },
    platformContext,
  ];

  for (const changedContext of substitutions) {
    await assert.rejects(
      withUnsealedProviderCredential(envelope, changedContext, kms, () => undefined),
      (error: unknown) => {
        assertCryptoError(error, 'UNSEAL_FAILED');
        assert.equal((error as Error).message.includes('context-bound-secret'), false);
        return true;
      },
    );
  }

  const { envelope: platformEnvelope } = await seal(Buffer.from('platform-secret'), platformContext, kms);
  await assert.rejects(
    withUnsealedProviderCredential(platformEnvelope, tenantContext, kms, () => undefined),
    (error: unknown) => {
      assertCryptoError(error, 'UNSEAL_FAILED');
      return true;
    },
  );
});

test('rejects tampered ciphertext, authentication tag, and wrapped DEK without revealing data', async () => {
  const kms = new ContextBindingFakeKms();
  const { envelope } = await seal(Buffer.from('tamper-sensitive-secret'), tenantContext, kms);
  const tamperedCiphertext: ProviderCredentialEnvelope = {
    ...envelope,
    ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`,
  };
  const tamperedWrappedDek: ProviderCredentialEnvelope = {
    ...envelope,
    wrappedDek: `${envelope.wrappedDek[0] === 'A' ? 'B' : 'A'}${envelope.wrappedDek.slice(1)}`,
  };
  const tamperedAuthTag: ProviderCredentialEnvelope = {
    ...envelope,
    authTag: `${envelope.authTag[0] === 'A' ? 'B' : 'A'}${envelope.authTag.slice(1)}`,
  };

  for (const candidate of [tamperedCiphertext, tamperedWrappedDek, tamperedAuthTag]) {
    await assert.rejects(
      withUnsealedProviderCredential(candidate, tenantContext, kms, () => undefined),
      (error: unknown) => {
        assertCryptoError(error);
        assert.equal((error as Error).message.includes('tamper-sensitive-secret'), false);
        return true;
      },
    );
  }
});

test('rejects malformed, oversize, non-canonical, and structurally invalid values safely', async () => {
  const kms = new ContextBindingFakeKms();
  await assert.rejects(
    sealProviderCredential(Buffer.alloc(0), tenantContext, kms, 'kms/provider-credentials'),
    (error) => {
      assertCryptoError(error, 'INVALID_INPUT');
      return true;
    },
  );
  await assert.rejects(
    sealProviderCredential(
      Buffer.alloc(MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES + 1),
      tenantContext,
      kms,
      'kms/provider-credentials',
    ),
    (error) => {
      assertCryptoError(error, 'INVALID_INPUT');
      return true;
    },
  );
  await assert.rejects(
    sealProviderCredential(
      Buffer.from('secret'),
      { ...tenantContext, credentialVersion: 0 },
      kms,
      'kms/provider-credentials',
    ),
    (error) => {
      assertCryptoError(error, 'INVALID_CONTEXT');
      return true;
    },
  );
  await assert.rejects(
    sealProviderCredential(
      Buffer.from('secret'),
      { ...tenantContext, ownerKind: 'platform', supplyMode: 'platform' } as never,
      kms,
      'kms/provider-credentials',
    ),
    (error) => {
      assertCryptoError(error, 'INVALID_CONTEXT');
      return true;
    },
  );
  await assert.rejects(
    sealProviderCredential(
      Buffer.from('secret'),
      { ...tenantContext, supplyMode: 'platform' } as never,
      kms,
      'kms/provider-credentials',
    ),
    (error) => {
      assertCryptoError(error, 'INVALID_CONTEXT');
      return true;
    },
  );
  await assert.rejects(
    sealProviderCredential(
      Buffer.from('secret'),
      { ...platformContext, tenantId: 'fake-tenant' } as never,
      kms,
      'kms/provider-credentials',
    ),
    (error) => {
      assertCryptoError(error, 'INVALID_CONTEXT');
      return true;
    },
  );

  const { envelope } = await seal(Buffer.from('malformed-envelope-secret'), tenantContext, kms);
  const malformed = [
    { ...envelope, ciphertext: 'not base64!' },
    { ...envelope, ciphertext: `${envelope.ciphertext}=` },
    { ...envelope, schemaVersion: 2 as typeof envelope.schemaVersion },
    { ...envelope, contextVersion: 2 as typeof envelope.contextVersion },
    { ...envelope, extra: 'not allowed' },
    { ...envelope, ciphertext: Buffer.alloc(MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES + 1).toString('base64url') },
  ];
  for (const candidate of malformed) {
    await assert.rejects(
      withUnsealedProviderCredential(candidate as ProviderCredentialEnvelope, tenantContext, kms, () => undefined),
      (error: unknown) => {
        assertCryptoError(error);
        assert.equal((error as Error).message.includes('malformed-envelope-secret'), false);
        return true;
      },
    );
  }
});

test('zeroes the callback secret buffer after success and callback failure', async () => {
  const kms = new ContextBindingFakeKms();
  const { envelope } = await seal(Buffer.from('short-lived-callback-secret'), tenantContext, kms);
  let successfulBuffer: Buffer | undefined;
  await withUnsealedProviderCredential(envelope, tenantContext, kms, async (secret) => {
    successfulBuffer = secret;
    assert.equal(secret.toString('utf8'), 'short-lived-callback-secret');
    await Promise.resolve();
  });
  assert.ok(successfulBuffer);
  assert.deepEqual(successfulBuffer, Buffer.alloc(successfulBuffer.length));

  let failedBuffer: Buffer | undefined;
  await assert.rejects(
    withUnsealedProviderCredential(envelope, tenantContext, kms, (secret) => {
      failedBuffer = secret;
      throw new Error(secret.toString('utf8'));
    }),
    (error: unknown) => {
      assertCryptoError(error, 'CALLBACK_FAILED');
      assert.equal((error as Error).message.includes('short-lived-callback-secret'), false);
      return true;
    },
  );
  assert.ok(failedBuffer);
  assert.deepEqual(failedBuffer, Buffer.alloc(failedBuffer.length));
});

test('does not accept the legacy reusable AES key provider shape', async () => {
  const legacyProvider = {
    getCurrentKey: () => ({ keyId: 'legacy', key: randomBytes(32) }),
    getKey: () => undefined,
  };
  await assert.rejects(
    sealProviderCredential(
      Buffer.from('legacy-provider-secret'),
      tenantContext,
      legacyProvider as never,
      'kms/provider-credentials',
    ),
    (error: unknown) => {
      assertCryptoError(error, 'KMS_UNAVAILABLE');
      assert.equal((error as Error).message.includes('legacy-provider-secret'), false);
      return true;
    },
  );
});
