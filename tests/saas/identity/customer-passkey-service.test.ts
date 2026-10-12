import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase32, totpCode } from '../../../src/saas/platform/auth/totp.js';
import { CustomerPasskeyError } from '../../../src/saas/identity/customer-passkey-types.js';
import { CustomerPasskeyService } from '../../../src/saas/identity/customer-passkey-service.js';
import {
  CustomerPasskeyUnitDatabase,
  CustomerPasskeyUnitKeys,
  PASSKEY_TEST_PASSWORD,
} from './customer-passkey-unit-database.js';
import {
  assertionPayload,
  registrationPayload,
  SIM_ORIGIN,
  SIM_RP_ID,
  simulatePasskey,
} from './customer-passkey-simulator.js';

async function setup() {
  const db = await CustomerPasskeyUnitDatabase.create();
  const keys = new CustomerPasskeyUnitKeys(db);
  const service = new CustomerPasskeyService(db, {
    keyProvider: keys,
    rpId: SIM_RP_ID,
    rpName: 'Model Router Console (unit)',
    origins: [SIM_ORIGIN],
  });
  const proof = await db.session();
  return { db, keys, service, proof };
}
function expectCode(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof CustomerPasskeyError, 'CustomerPasskeyError expected');
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('synthetic'), false, 'sensitive detail must never surface');
    return true;
  };
}

test('registration ceremony completes end-to-end, revokes sessions and audits both facts', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const start = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  assert.match(start.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(start.rp, { id: SIM_RP_ID, name: 'Model Router Console (unit)' });
  assert.equal(start.attestation, 'none');
  assert.deepEqual(start.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
  assert.equal(start.user.name, 'synthetic-customer@example.test');
  assert.equal(start.user.id, Buffer.from(db.userId, 'utf8').toString('base64url'));
  assert.equal(db.state.ceremonies.length, 1);
  assert.equal(db.state.ceremonies[0]!.challenge_hash !== start.challenge, true, 'only the hash persists');

  const changed = await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD,
    challenge: start.challenge,
    credential: registrationPayload(key, start.challenge),
  });
  assert.equal(changed.credentialId, key.credentialId);
  assert.equal(changed.signInRequired, true);
  assert.ok(changed.sessionsRevoked >= 1);
  assert.equal(db.state.sessions.every((s) => s.revoked), true, 'factor change revokes every session');
  const stored = db.passkeys();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.credential_id, key.credentialId);
  assert.equal(stored[0]!.sign_count, '0');
  assert.deepEqual(stored[0]!.public_key, key.cose);
  assert.equal(db.state.ceremonies[0]!.consumed, true);
  assert.equal(db.state.ceremonies[0]!.credential_id, key.credentialId);
  assert.deepEqual(db.auditActions(), [
    'customer_passkey.start-registration.started',
    'customer_passkey.finish-registration.completed',
  ]);

  const listed = await service.list(await db.session());
  assert.deepEqual(listed.passkeys.map((p) => p.credentialId), [key.credentialId]);
});

test('a consumed challenge can never be reused and a second start is denied while one is open', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const start = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  await assert.rejects(
    service.startRegistration(db.next(proof), { password: PASSKEY_TEST_PASSWORD }),
    expectCode('CEREMONY_INVALID'),
  );
  await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD, challenge: start.challenge, credential: registrationPayload(key, start.challenge),
  });
  const fresh = await db.session();
  await assert.rejects(
    service.finishRegistration(fresh, {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge, credential: registrationPayload(key, start.challenge),
    }),
    expectCode('CEREMONY_INVALID'),
  );
  assert.equal(db.passkeys().length, 1, 'replay produced no second credential');
});

test('wrong password denies with REAUTH_REQUIRED and five attempts lock the ceremony', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const start = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(
      service.finishRegistration(db.next(proof), {
        password: `wrong-${attempt}`, challenge: start.challenge, credential: registrationPayload(key, start.challenge),
      }),
      attempt <= 5 ? expectCode('REAUTH_REQUIRED') : expectCode('CEREMONY_INVALID'),
    );
    assert.equal(db.state.ceremonies[0]!.attempt_count, Math.min(attempt, 5));
  }
  await assert.rejects(
    service.finishRegistration(db.next(proof), {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge, credential: registrationPayload(key, start.challenge),
    }),
    expectCode('CEREMONY_INVALID'),
  );
  assert.equal(db.passkeys().length, 0);
  assert.equal(db.auditActions().filter((a) => a === 'customer_passkey.finish-registration.denied').length, 6);
});

test('tampered or cross-ceremony registration payloads reject fail-closed', async () => {
  const { service, proof } = await setup();
  const key = simulatePasskey();
  const start = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  for (const credential of [
    registrationPayload(key, start.challenge, { challengeOverride: Buffer.alloc(32).toString('base64url') }),
    registrationPayload(key, start.challenge, { origin: 'https://evil.example.test' }),
    registrationPayload(key, start.challenge, { type: 'webauthn.get' }),
    registrationPayload(key, start.challenge, { rpId: 'other.test' }),
    { ...registrationPayload(key, start.challenge), id: simulatePasskey().credentialId },
  ]) {
    await assert.rejects(
      service.finishRegistration({ ...proof, requestId: crypto.randomUUID() }, {
        password: PASSKEY_TEST_PASSWORD, challenge: start.challenge, credential,
      }),
      expectCode('PASSKEY_REJECTED'),
    );
  }
});

test('an active TOTP factor gates registration with a single-use code', async () => {
  const { db, keys, service, proof } = await setup();
  const secret = encodeBase32(Buffer.from('unit-totp-secret-20b!'));
  await db.seedTotp(secret, keys);
  await assert.rejects(
    service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD }),
    expectCode('PASSKEY_REJECTED'),
    'missing TOTP code never starts a ceremony while a TOTP factor is active',
  );
  const start = await service.startRegistration(db.next(proof), {
    password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now),
  });
  await assert.rejects(
    service.finishRegistration(db.next(proof), {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
      credential: registrationPayload(simulatePasskey(), start.challenge),
    }),
    expectCode('PASSKEY_REJECTED'),
    'missing TOTP code never finishes a ceremony while a TOTP factor is active',
  );
  const key = simulatePasskey();
  const changed = await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now + 30000), challenge: start.challenge,
    credential: registrationPayload(key, start.challenge),
  });
  assert.equal(changed.credentialId, key.credentialId);
  // The consumed step can never authorize a second factor change. Advance the
  // window so a FRESH code exists, then replay the older in-window step.
  db.state.now += 60000;
  const second = await db.session();
  const start2 = await service.startRegistration(second, { password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now) });
  await assert.rejects(
    service.finishRegistration(db.next(second), {
      password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now - 30000), challenge: start2.challenge,
      credential: registrationPayload(simulatePasskey(), start2.challenge),
    }),
    expectCode('PASSKEY_REJECTED'),
    'a replayed TOTP step never passes the cross-factor gate',
  );
});

test('assertion ceremony verifies the signature and advances the counter exactly once', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const regStart = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD, challenge: regStart.challenge, credential: registrationPayload(key, regStart.challenge),
  });
  const session = await db.session();
  const start = await service.startAssertion(session, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId });
  assert.deepEqual(start.allowCredentials, [{ type: 'public-key', id: key.credentialId }]);
  assert.equal(start.rpId, SIM_RP_ID);
  const verified = await service.finishAssertion(session, {
    password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
    credential: assertionPayload(key, start.challenge, 5),
  });
  assert.deepEqual(verified, { verified: true, credentialId: key.credentialId });
  assert.equal(db.passkeys()[0]!.sign_count, '5');
  assert.equal(db.state.sessions.some((s) => !s.revoked), true, 'assertion never revokes the session');
  // Same challenge cannot be asserted twice.
  await assert.rejects(
    service.finishAssertion(db.next(session), {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
      credential: assertionPayload(key, start.challenge, 6),
    }),
    expectCode('CEREMONY_INVALID'),
  );
  // Next ceremony: stale or regressed counters are clone signals.
  const second = await service.startAssertion(session, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId });
  await assert.rejects(
    service.finishAssertion(db.next(session), {
      password: PASSKEY_TEST_PASSWORD, challenge: second.challenge,
      credential: assertionPayload(key, second.challenge, 5),
    }),
    expectCode('PASSKEY_REJECTED'),
    'equal nonzero counter is a cloned-authenticator signal',
  );
  assert.equal(db.passkeys()[0]!.sign_count, '5', 'rejected clone never moves the counter');
});

test('assertion rejects tampered signatures, wrong user handles and unknown passkeys', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const regStart = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD, challenge: regStart.challenge, credential: registrationPayload(key, regStart.challenge),
  });
  const session = await db.session();
  await assert.rejects(
    service.startAssertion(session, { password: PASSKEY_TEST_PASSWORD, credentialId: simulatePasskey().credentialId }),
    expectCode('PASSKEY_NOT_FOUND'),
  );
  const start = await service.startAssertion(session, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId });
  await assert.rejects(
    service.finishAssertion(db.next(session), {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
      credential: assertionPayload(key, start.challenge, 1, { tamperSignature: true }),
    }),
    expectCode('PASSKEY_REJECTED'),
  );
  await assert.rejects(
    service.finishAssertion(db.next(session), {
      password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
      credential: assertionPayload(key, start.challenge, 1, { userHandle: Buffer.from('someone-else').toString('base64url') }),
    }),
    expectCode('PASSKEY_REJECTED'),
  );
  // The honest user handle passes on the SAME still-open ceremony (rejections
  // only consume attempts; a new start stays blocked while one is open).
  await assert.rejects(
    service.startAssertion(session, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId }),
    expectCode('CEREMONY_INVALID'),
    'a second assertion ceremony cannot open while one is pending',
  );
  const verified = await service.finishAssertion(session, {
    password: PASSKEY_TEST_PASSWORD, challenge: start.challenge,
    credential: assertionPayload(key, start.challenge, 1, { userHandle: Buffer.from(db.userId, 'utf8').toString('base64url') }),
  });
  assert.equal(verified.verified, true);
});

test('remove revokes the passkey, closes ceremonies, revokes sessions and forgets it', async () => {
  const { db, service, proof } = await setup();
  const key = simulatePasskey();
  const regStart = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD });
  await service.finishRegistration(proof, {
    password: PASSKEY_TEST_PASSWORD, challenge: regStart.challenge, credential: registrationPayload(key, regStart.challenge),
  });
  const session = await db.session();
  const changed = await service.remove(session, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId });
  assert.equal(changed.credentialId, key.credentialId);
  assert.equal(changed.signInRequired, true);
  assert.equal(db.passkeys().length, 0);
  assert.equal(db.auditActions().at(-1), 'customer_passkey.remove.completed');
  const fresh = await db.session();
  await assert.rejects(
    service.remove(fresh, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId }),
    expectCode('PASSKEY_NOT_FOUND'),
  );
  await assert.rejects(
    service.startAssertion(fresh, { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId }),
    expectCode('PASSKEY_NOT_FOUND'),
    'a revoked passkey can never start an assertion',
  );
  assert.deepEqual((await service.list(fresh)).passkeys, []);
});

test('platform users, disabled users and dead sessions are denied before any ceremony', async () => {
  const { db, service, proof } = await setup();
  db.state.platform = true;
  await assert.rejects(service.list(proof), expectCode('MFA_STATE_CONFLICT'));
  await assert.rejects(
    service.startRegistration(db.next(proof), { password: PASSKEY_TEST_PASSWORD }),
    expectCode('MFA_STATE_CONFLICT'),
  );
  db.state.platform = false;
  db.state.disabled = true;
  await assert.rejects(
    service.startRegistration(db.next(proof), { password: PASSKEY_TEST_PASSWORD }),
    expectCode('UNAUTHENTICATED'),
  );
});

test('authority changes mid-flight flip the outcome to AUTHORITY_CHANGED', async () => {
  const { db, keys, service, proof } = await setup();
  const secret = encodeBase32(Buffer.from('unit-totp-secret-20b!'));
  await db.seedTotp(secret, keys);
  const start = await service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now) });
  keys.beforeLookup = () => {
    db.state.credentials.find((x) => x.kind === 'totp')!.revoked = true;
    keys.beforeLookup = undefined;
  };
  await assert.rejects(
    service.finishRegistration(proof, {
      password: PASSKEY_TEST_PASSWORD, currentTotpCode: totpCode(secret, db.state.now), challenge: start.challenge,
      credential: registrationPayload(simulatePasskey(), start.challenge),
    }),
    expectCode('AUTHORITY_CHANGED'),
  );
});

test('input validation rejects malformed proofs, bodies and identifiers', async () => {
  const { service, proof } = await setup();
  await assert.rejects(service.list({ ...proof, sessionToken: 'short' }), expectCode('INVALID_INPUT'));
  await assert.rejects(
    service.startRegistration(proof, { password: '' }), expectCode('INVALID_INPUT'));
  await assert.rejects(
    service.startRegistration(proof, { password: PASSKEY_TEST_PASSWORD, credentialId: 'x' }), expectCode('INVALID_INPUT'));
  await assert.rejects(
    service.finishAssertion(proof, { password: PASSKEY_TEST_PASSWORD, challenge: 'not-a-challenge', credential: {
      id: 'AAAAAAAAAAAAAAAAAAAAAA', clientDataJSON: '{}', authenticatorData: 'AA', signature: 'AA' } }),
    expectCode('INVALID_INPUT'));
  await assert.rejects(
    service.remove(proof, { password: PASSKEY_TEST_PASSWORD, credentialId: '!!!' }), expectCode('INVALID_INPUT'));
});

test('database failures surface as UNAVAILABLE without leaking detail', async () => {
  const { db, service, proof } = await setup();
  db.failTag = 'current';
  await assert.rejects(service.list(proof), (error: unknown) => {
    assert.ok(error instanceof CustomerPasskeyError);
    assert.equal(error.code, 'UNAVAILABLE');
    assert.equal(JSON.stringify(error).includes('synthetic'), false);
    return true;
  });
});
