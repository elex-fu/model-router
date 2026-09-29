import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  createTrustedPreparedRequestVerifierKeyRegistry,
  loadTrustedPreparedRequestVerifierKeyRegistry,
  TrustedPreparedRequestVerifierKeyRegistryError,
} from '../../../src/saas/runtime/prepared-evidence-verifier-keys.js';

function generatedKey() {
  return generateKeyPairSync('ed25519');
}

function expectRegistryError(
  action: () => unknown,
  code: TrustedPreparedRequestVerifierKeyRegistryError['code'],
): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof TrustedPreparedRequestVerifierKeyRegistryError && error.code === code,
  );
}

test('loads real Ed25519 PEM and DER public keys with explicit active state', () => {
  const first = generatedKey();
  const second = generatedKey();
  const firstPem = first.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const secondDer = second.publicKey.export({ type: 'spki', format: 'der' });

  const registry = loadTrustedPreparedRequestVerifierKeyRegistry({
    keys: [
      { keyId: 'verifier-a', publicKey: firstPem, status: 'active' },
      { keyId: 'verifier-b', publicKey: secondDer, status: 'retired' },
    ],
  });

  assert.deepEqual(registry.activeKeyIds, ['verifier-a']);
  assert.deepEqual(registry.retiredKeyIds, ['verifier-b']);
  assert.equal(registry.getStatus('verifier-a'), 'active');
  assert.equal(registry.getStatus('verifier-b'), 'retired');
  assert.equal(registry.get('verifier-a')?.asymmetricKeyType, 'ed25519');
  assert.equal(registry.get('verifier-b')?.asymmetricKeyType, 'ed25519');
  assert.equal(registry.trustedVerifierPublicKeyMap.size, 2);
  assert.equal(registry.activeVerifierPublicKeyMap.size, 1);
  assert.equal(registry.retiredVerifierPublicKeyMap.size, 1);
  assert.equal(registry.trustedVerifierPublicKeys['verifier-a']?.type, 'public');
});

test('rotation keeps the retired key available for historical proof verification', () => {
  const oldKey = generatedKey();
  const newKey = generatedKey();
  const oldDer = oldKey.publicKey.export({ type: 'spki', format: 'der' });
  const newPem = newKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const initial = createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [{ keyId: 'old', publicKey: oldDer, status: 'active' }],
  });
  const rotated = createTrustedPreparedRequestVerifierKeyRegistry({
    keys: [
      { keyId: 'old', publicKey: oldDer, status: 'retired' },
      { keyId: 'new', publicKey: newPem, status: 'active' },
    ],
  });

  assert.equal(initial.get('old')?.export({ type: 'spki', format: 'der' }).equals(oldDer), true);
  assert.deepEqual(rotated.activeKeyIds, ['new']);
  assert.deepEqual(rotated.retiredKeyIds, ['old']);
  assert.equal(rotated.get('old')?.export({ type: 'spki', format: 'der' }).equals(oldDer), true);
  assert.equal(rotated.get('new')?.asymmetricKeyType, 'ed25519');
  assert.equal(rotated.trustedVerifierPublicKeys.old?.asymmetricKeyType, 'ed25519');
  assert.equal(rotated.activeVerifierPublicKeys.old, undefined);
});

test('fails closed for absent configuration, missing active keys, duplicate ids, and unknown ids', () => {
  expectRegistryError(() => loadTrustedPreparedRequestVerifierKeyRegistry(undefined as never), 'INVALID_CONFIGURATION');
  expectRegistryError(() => loadTrustedPreparedRequestVerifierKeyRegistry({ keys: [] }), 'NO_ACTIVE_KEYS');

  const key = generatedKey();
  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [
          { keyId: 'same', publicKey: key.publicKey, status: 'active' },
          { keyId: 'same', publicKey: key.publicKey, status: 'retired' },
        ],
      }),
    'DUPLICATE_KEY_ID',
  );

  const registry = loadTrustedPreparedRequestVerifierKeyRegistry({
    keys: [{ keyId: 'known', publicKey: key.publicKey, status: 'active' }],
  });
  assert.equal(registry.get('unknown'), undefined);
  assert.equal(registry.trustedVerifierPublicKeys.unknown, undefined);
  expectRegistryError(() => registry.getRequired('unknown'), 'UNKNOWN_KEY_ID');
});

test('rejects non-Ed25519, malformed, private, and implicit-status key material', () => {
  const ed25519 = generatedKey();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed25519PrivatePem = ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const malformedDer = Uint8Array.from([0x30, 0x01, 0x00]);
  const fakeKeyObject = { type: 'public', asymmetricKeyType: 'ed25519' };

  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: 'rsa', publicKey: rsa.publicKey, status: 'active' }],
      }),
    'UNSUPPORTED_KEY_ALGORITHM',
  );
  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: 'bad', publicKey: malformedDer, status: 'active' }],
      }),
    'INVALID_KEY_MATERIAL',
  );
  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: 'private', publicKey: ed25519PrivatePem, status: 'active' }],
      }),
    'INVALID_KEY_MATERIAL',
  );
  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: 'fake', publicKey: fakeKeyObject, status: 'active' } as never],
      }),
    'INVALID_KEY_MATERIAL',
  );
  expectRegistryError(
    () =>
      loadTrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: 'implicit', publicKey: ed25519.publicKey } as never],
      }),
    'INVALID_KEY_STATUS',
  );
});

test('freezes registry views and copies key material at construction', () => {
  const key = generatedKey();
  const der = key.publicKey.export({ type: 'spki', format: 'der' });
  const input = { keys: [{ keyId: 'stable', publicKey: der, status: 'active' as const }] };
  const registry = loadTrustedPreparedRequestVerifierKeyRegistry(input);

  der.fill(0);
  input.keys[0] = { keyId: 'changed', publicKey: key.publicKey, status: 'retired' };

  assert.equal(registry.get('stable')?.asymmetricKeyType, 'ed25519');
  assert.equal(registry.get('changed'), undefined);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.trustedVerifierPublicKeys), true);
  assert.equal(Object.isFrozen(registry.trustedVerifierPublicKeyMap), true);
  assert.equal(Object.isFrozen(registry.records), true);
  assert.throws(() => registry.trustedVerifierPublicKeyMap.set('injected', key.publicKey), TypeError);
  assert.equal(Reflect.set(registry.trustedVerifierPublicKeys, 'stable', key.publicKey), false);
  assert.equal(registry.trustedVerifierPublicKeys.stable?.asymmetricKeyType, 'ed25519');
  assert.equal(registry.get('injected'), undefined);
});
