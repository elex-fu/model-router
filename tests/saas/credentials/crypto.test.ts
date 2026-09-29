import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREDENTIAL_ENVELOPE_ALGORITHM,
  CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  CredentialCryptoError,
  type CredentialEnvelope,
  type CredentialKeyMaterial,
  type CredentialKeyProvider,
  decryptCredential,
  encryptCredential,
  rewrapCredential,
} from '../../../src/saas/credentials/crypto.js';

const context = {
  tenantId: 'tenant-1',
  provider: 'openai-compatible',
  credentialId: 'credential-1',
} as const;

function keyMaterial(keyId: string, fill: number): CredentialKeyMaterial {
  return { keyId, key: Buffer.alloc(32, fill) };
}

function createKeyProvider(
  current: CredentialKeyMaterial,
  history: CredentialKeyMaterial[] = [],
): {
  provider: CredentialKeyProvider;
  setCurrent(key: CredentialKeyMaterial): void;
} {
  let active = current;
  const keys = new Map<string, Uint8Array>([current, ...history].map(({ keyId, key }) => [keyId, key]));
  return {
    provider: {
      getCurrentKey: () => active,
      getKey: (keyId) => keys.get(keyId),
    },
    setCurrent(key) {
      active = key;
      keys.set(key.keyId, key.key);
    },
  };
}

function assertCryptoError(error: unknown, code: CredentialCryptoError['code']): void {
  assert.ok(error instanceof CredentialCryptoError);
  assert.equal(error.code, code);
}

test('encrypts and decrypts a versioned AES-256-GCM envelope without exposing secret material', async () => {
  const key = keyMaterial('key-1', 0x11);
  const { provider } = createKeyProvider(key);
  const plaintext = 'sk-live-example-secret';
  const envelope = await encryptCredential(plaintext, context, provider);

  assert.deepEqual(Object.keys(envelope).sort(), [
    'algorithm',
    'authTag',
    'ciphertext',
    'keyId',
    'nonce',
    'schemaVersion',
  ]);
  assert.equal(envelope.schemaVersion, CREDENTIAL_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.algorithm, CREDENTIAL_ENVELOPE_ALGORITHM);
  assert.equal(envelope.keyId, key.keyId);
  assert.equal(envelope.ciphertext.includes(plaintext), false);
  assert.equal(JSON.stringify(envelope).includes(key.key.toString('hex')), false);
  assert.match(envelope.nonce, /^[A-Za-z0-9_-]+$/);
  assert.match(envelope.ciphertext, /^[A-Za-z0-9_-]+$/);
  assert.match(envelope.authTag, /^[A-Za-z0-9_-]+$/);
  assert.equal(await decryptCredential(envelope, context, provider), plaintext);
});

test('can decrypt the active key when the provider reserves getKey for historical keys', async () => {
  const current = keyMaterial('current-only', 0x15);
  const provider: CredentialKeyProvider = {
    getCurrentKey: () => current,
    getKey: () => undefined,
  };
  const envelope = await encryptCredential('current-key-secret', context, provider);
  assert.equal(await decryptCredential(envelope, context, provider), 'current-key-secret');
});

test('binds authentication to tenant, provider, and credential context', async () => {
  const { provider } = createKeyProvider(keyMaterial('key-1', 0x12));
  const envelope = await encryptCredential('context-bound-secret', context, provider);
  for (const changedContext of [
    { ...context, tenantId: 'tenant-2' },
    { ...context, provider: 'another-provider' },
    { ...context, credentialId: 'credential-2' },
  ]) {
    await assert.rejects(decryptCredential(envelope, changedContext, provider), (error: unknown) => {
      assertCryptoError(error, 'AUTHENTICATION_FAILED');
      assert.equal((error as Error).message.includes('context-bound-secret'), false);
      return true;
    });
  }
});

test('rewraps an old envelope under the current key and keeps old-key decrypt support', async () => {
  const oldKey = keyMaterial('key-old', 0x21);
  const newKey = keyMaterial('key-new', 0x22);
  const keyProvider = createKeyProvider(oldKey);
  const original = await encryptCredential('rotate-me', context, keyProvider.provider);

  keyProvider.setCurrent(newKey);
  const rotated = await rewrapCredential(original, context, keyProvider.provider);

  assert.equal(original.keyId, oldKey.keyId);
  assert.equal(rotated.keyId, newKey.keyId);
  assert.notEqual(rotated.ciphertext, original.ciphertext);
  assert.equal(await decryptCredential(rotated, context, keyProvider.provider), 'rotate-me');
  assert.equal(await decryptCredential(original, context, keyProvider.provider), 'rotate-me');
});

test('does not mutate provider-owned key buffers and rejects tampering uniformly', async () => {
  const key = keyMaterial('key-1', 0x31);
  const originalKey = Buffer.from(key.key);
  const { provider } = createKeyProvider(key);
  const envelope = await encryptCredential('do-not-leak', context, provider);
  assert.deepEqual(key.key, originalKey);

  const replacement = envelope.authTag[0] === 'A' ? 'B' : 'A';
  const tampered: CredentialEnvelope = { ...envelope, authTag: `${replacement}${envelope.authTag.slice(1)}` };
  await assert.rejects(decryptCredential(tampered, context, provider), (error: unknown) => {
    assertCryptoError(error, 'AUTHENTICATION_FAILED');
    assert.equal((error as Error).message.includes('do-not-leak'), false);
    return true;
  });
});

test('fails explicitly for missing providers, invalid keys, and malformed envelopes', async () => {
  await assert.rejects(encryptCredential('secret', context, undefined as never), (error: unknown) => {
    assertCryptoError(error, 'KEY_PROVIDER_UNAVAILABLE');
    return true;
  });

  const invalidProvider: CredentialKeyProvider = {
    getCurrentKey: () => ({ keyId: 'bad', key: Buffer.alloc(31) }),
    getKey: () => undefined,
  };
  await assert.rejects(encryptCredential('secret', context, invalidProvider), (error: unknown) => {
    assertCryptoError(error, 'INVALID_KEY');
    return true;
  });

  const { provider } = createKeyProvider(keyMaterial('key-1', 0x41));
  await assert.rejects(
    decryptCredential(
      {
        schemaVersion: CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
        algorithm: CREDENTIAL_ENVELOPE_ALGORITHM,
        keyId: 'key-1',
        nonce: 'not-base64url!',
        ciphertext: 'AA',
        authTag: 'AA',
      },
      context,
      provider,
    ),
    (error: unknown) => {
      assertCryptoError(error, 'INVALID_ENVELOPE');
      return true;
    },
  );
});
