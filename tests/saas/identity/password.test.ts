import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../../../src/saas/identity/password.js';

test('shared password verifier reads and writes the persisted identity scrypt format', async () => {
  const password = 'correct horse battery staple';
  const encoded = await hashPassword(password);

  assert.match(encoded, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('incorrect password', encoded), false);
});

test('shared password verifier rejects absent and malformed hashes after dummy password work', async () => {
  for (const encoded of [undefined, null, '', 'scrypt$1$8$1$short$short', 'argon2$encoded']) {
    assert.equal(await verifyPassword('candidate password', encoded), false);
  }
});
