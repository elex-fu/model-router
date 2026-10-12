import assert from 'node:assert/strict';
import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  decodeBase64url,
  PasskeyVerificationError,
  parseCosePublicKey,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from '../../../src/saas/identity/customer-passkey-webauthn.js';

// Test-side CBOR encoder (definite lengths only) + a simulated authenticator.
// These helpers build the exact byte shapes a real passkey produces; they are
// fixtures, never part of the shipped verification path.
function cborUint(value: number): Buffer {
  if (value < 24) return Buffer.from([value]);
  if (value < 256) return Buffer.from([24, value]);
  if (value < 65536) {
    const b = Buffer.alloc(3);
    b[0] = 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 26;
  b.writeUInt32BE(value, 1);
  return b;
}
function cborMajor(major: number, value: number): Buffer {
  const head = cborUint(value);
  head[0] = (head[0] as number) | (major << 5);
  return head;
}
const cborBstr = (value: Buffer): Buffer => Buffer.concat([cborMajor(2, value.length), value]);
const cborTstr = (value: string): Buffer => {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([cborMajor(3, encoded.length), encoded]);
};
const cborMap = (entries: Array<[number | string, Buffer]>): Buffer =>
  Buffer.concat([
    cborMajor(5, entries.length),
    ...entries.flatMap(([key, value]) => [typeof key === 'string' ? cborTstr(key) : cborInt(key), value]),
  ]);
const cborInt = (value: number): Buffer =>
  value >= 0
    ? cborUint(value)
    : (cborUint(-1 - value).map((byte, index) => (index === 0 ? byte | 0x20 : byte)) as Buffer);

const rpId = 'console.example.test';
const origins = ['https://console.example.test'];
const challenge = Buffer.from('test-only-challenge-32-bytes-pad!!').subarray(0, 32).toString('base64url');

function clientData(type: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, challenge, origin: origins[0], ...overrides });
}

interface SimulatedKey {
  readonly cose: Buffer;
  readonly sign: (data: Buffer) => Buffer;
}
function simulateEcKey(): SimulatedKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = cborMap([
    [1, cborUint(2)],
    [3, cborInt(-7)],
    [-1, cborUint(1)],
    [-2, cborBstr(Buffer.from(String(jwk.x), 'base64url'))],
    [-3, cborBstr(Buffer.from(String(jwk.y), 'base64url'))],
  ]);
  return { cose, sign: (data) => cryptoSign('sha256', data, pair.privateKey) };
}
function simulateRsaKey(): SimulatedKey {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = cborMap([
    [1, cborUint(3)],
    [3, cborInt(-257)],
    [-1, cborBstr(Buffer.from(String(jwk.n), 'base64url'))],
    [-2, cborBstr(Buffer.from(String(jwk.e), 'base64url'))],
  ]);
  return { cose, sign: (data) => cryptoSign('sha256', data, pair.privateKey) };
}

const credentialIdBytes = Buffer.from('test-only-credential-id-32b!!').subarray(0, 32);
const credentialId = credentialIdBytes.toString('base64url');

function authData(options: {
  flags: number;
  signCount: number;
  rp?: string;
  attested?: Buffer;
  suffix?: Buffer;
}): Buffer {
  const parts = [
    createHash('sha256')
      .update(options.rp ?? rpId, 'utf8')
      .digest(),
    Buffer.from([options.flags]),
    Buffer.alloc(4),
  ];
  (parts[2] as Buffer).writeUInt32BE(options.signCount);
  if (options.attested) parts.push(options.attested);
  if (options.suffix) parts.push(options.suffix);
  return Buffer.concat(parts);
}
function attestedCredentialData(cose: Buffer, id: Buffer = credentialIdBytes): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  return Buffer.concat([Buffer.alloc(16), length, id, cose]);
}
function attestationObject(data: Buffer, fmt = 'none', attStmt: Buffer = cborMap([])): Buffer {
  return cborMap([
    ['fmt', cborTstr(fmt)],
    ['attStmt', attStmt],
    ['authData', cborBstr(data)],
  ]);
}

const party = { rpId, origins, requireUserVerification: true };
const relaxed = { rpId, origins, requireUserVerification: false };
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const ED = 0x80;

function rejects(reason: string): (error: unknown) => boolean {
  return (error) => error instanceof PasskeyVerificationError && error.reason === reason;
}

test('registration accepts a well-formed fmt=none ES256 attestation and round-trips the COSE key', () => {
  const key = simulateEcKey();
  const data = authData({ flags: UP | UV | AT, signCount: 0, attested: attestedCredentialData(key.cose) });
  const result = verifyPasskeyRegistration(
    { clientDataJSON: clientData('webauthn.create'), attestationObject: attestationObject(data).toString('base64url') },
    party,
    challenge,
  );
  assert.equal(result.credentialId, credentialId);
  assert.equal(result.signCount, 0);
  assert.deepEqual(result.coseKey, key.cose);
  const parsed = parseCosePublicKey(result.coseKey);
  assert.equal(parsed.alg, -7);
});

test('registration honors the user-verification policy in both directions', () => {
  const key = simulateEcKey();
  const withoutUv = authData({ flags: UP | AT, signCount: 0, attested: attestedCredentialData(key.cose) });
  const input = {
    clientDataJSON: clientData('webauthn.create'),
    attestationObject: attestationObject(withoutUv).toString('base64url'),
  };
  assert.throws(() => verifyPasskeyRegistration(input, party, challenge), rejects('flags'));
  assert.doesNotThrow(() => verifyPasskeyRegistration(input, relaxed, challenge));
});

test('registration rejects every structural deviation fail-closed', () => {
  const key = simulateEcKey();
  const good = () => authData({ flags: UP | UV | AT, signCount: 7, attested: attestedCredentialData(key.cose) });
  const attempt = (data: Buffer, client: string, fmt?: string, attStmt?: Buffer) => () =>
    verifyPasskeyRegistration(
      { clientDataJSON: client, attestationObject: attestationObject(data, fmt, attStmt).toString('base64url') },
      party,
      challenge,
    );
  assert.throws(
    attempt(good(), clientData('webauthn.create', { challenge: Buffer.alloc(32).toString('base64url') })),
    rejects('challenge'),
  );
  assert.throws(
    attempt(good(), clientData('webauthn.create', { origin: 'https://evil.example.test' })),
    rejects('origin'),
  );
  assert.throws(
    attempt(good(), clientData('webauthn.create', { origin: 'https://console.example.test.evil.test' })),
    rejects('origin'),
  );
  assert.throws(attempt(good(), clientData('webauthn.get')), rejects('client_data'));
  assert.throws(
    attempt(good(), clientData('webauthn.create', { tokenBinding: { status: 'present' } })),
    rejects('client_data'),
  );
  assert.throws(attempt(good(), clientData('webauthn.create', { crossOrigin: true })), rejects('client_data'));
  assert.throws(attempt(good(), clientData('webauthn.create'), 'packed'), rejects('attestation'));
  assert.throws(
    attempt(good(), clientData('webauthn.create'), 'none', cborMap([['sig', cborBstr(Buffer.alloc(8))]])),
    rejects('attestation'),
  );
  assert.throws(
    attempt(
      authData({ flags: UP | UV | AT, signCount: 7, rp: 'other.test', attested: attestedCredentialData(key.cose) }),
      clientData('webauthn.create'),
    ),
    rejects('rp'),
  );
  assert.throws(
    attempt(
      authData({ flags: UV | AT, signCount: 7, attested: attestedCredentialData(key.cose) }),
      clientData('webauthn.create'),
    ),
    rejects('flags'),
  );
  assert.throws(attempt(authData({ flags: UP | UV, signCount: 7 }), clientData('webauthn.create')), rejects('flags'));
  assert.throws(
    attempt(
      authData({
        flags: UP | UV | AT | ED,
        signCount: 7,
        attested: attestedCredentialData(key.cose),
        suffix: cborMap([]),
      }),
      clientData('webauthn.create'),
    ),
    rejects('attestation'),
  );
  assert.throws(
    attempt(
      authData({ flags: UP | UV | AT, signCount: 7, attested: attestedCredentialData(key.cose, Buffer.alloc(4)) }),
      clientData('webauthn.create'),
    ),
    rejects('attestation'),
  );
  assert.throws(
    attempt(Buffer.concat([good(), Buffer.from([0])]), clientData('webauthn.create')),
    rejects('attestation'),
  );
  // EdDSA (alg -8) is outside the algorithm allowlist.
  const eddsa = cborMap([
    [1, cborUint(1)],
    [3, cborInt(-8)],
    [-1, cborUint(6)],
    [-2, cborBstr(Buffer.alloc(32))],
  ]);
  assert.throws(
    attempt(
      authData({ flags: UP | UV | AT, signCount: 7, attested: attestedCredentialData(eddsa) }),
      clientData('webauthn.create'),
    ),
    rejects('algorithm'),
  );
  // Indefinite-length CBOR and duplicate map keys are never valid input.
  const indefinite = Buffer.from([0x9f, 0x01, 0xff]);
  assert.throws(
    () =>
      verifyPasskeyRegistration(
        { clientDataJSON: clientData('webauthn.create'), attestationObject: indefinite.toString('base64url') },
        party,
        challenge,
      ),
    rejects('cbor'),
  );
  const duplicate = Buffer.concat([
    cborMajor(5, 2),
    cborTstr('fmt'),
    cborTstr('none'),
    cborTstr('fmt'),
    cborTstr('none'),
  ]);
  assert.throws(
    () =>
      verifyPasskeyRegistration(
        { clientDataJSON: clientData('webauthn.create'), attestationObject: duplicate.toString('base64url') },
        party,
        challenge,
      ),
    rejects('cbor'),
  );
});

test('assertion verifies ES256/RS256 signatures over authData || sha256(clientData)', () => {
  for (const key of [simulateEcKey(), simulateRsaKey()]) {
    const data = authData({ flags: UP | UV, signCount: 1 });
    const client = clientData('webauthn.get');
    const signature = key.sign(Buffer.concat([data, createHash('sha256').update(client, 'utf8').digest()]));
    const result = verifyPasskeyAssertion(
      {
        clientDataJSON: client,
        authenticatorData: data.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      party,
      challenge,
      key.cose,
      null,
    );
    assert.equal(result.signCount, 1);
  }
});

test('assertion counter rules accept first use and zero-pairs but reject cloned counters', () => {
  const key = simulateEcKey();
  const attempt = (signCount: number, stored: number | null) => {
    const data = authData({ flags: UP | UV, signCount });
    const client = clientData('webauthn.get');
    const signature = key.sign(Buffer.concat([data, createHash('sha256').update(client, 'utf8').digest()]));
    return () =>
      verifyPasskeyAssertion(
        {
          clientDataJSON: client,
          authenticatorData: data.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        party,
        challenge,
        key.cose,
        stored,
      );
  };
  assert.equal(attempt(0, null)().signCount, 0); // first use, non-incrementing authenticator
  assert.equal(attempt(41, null)().signCount, 41); // first use, incrementing authenticator
  assert.equal(attempt(0, 0)().signCount, 0); // zero/zero pair stays valid
  assert.equal(attempt(9, 8)().signCount, 9); // strictly increasing passes
  assert.throws(attempt(8, 8), rejects('counter')); // equal nonzero = cloned
  assert.throws(attempt(2, 8), rejects('counter')); // regression = cloned
  assert.throws(attempt(0, 8), rejects('counter')); // reset-to-zero = cloned
});

test('assertion rejects tampered signatures, challenges, origins and flag shapes', () => {
  const key = simulateEcKey();
  const build = (data: Buffer, client: string, signature?: Buffer) => ({
    clientDataJSON: client,
    authenticatorData: data.toString('base64url'),
    signature: (
      signature ?? key.sign(Buffer.concat([data, createHash('sha256').update(client, 'utf8').digest()]))
    ).toString('base64url'),
  });
  const good = authData({ flags: UP | UV, signCount: 3 });
  assert.throws(
    () =>
      verifyPasskeyAssertion(build(good, clientData('webauthn.get'), Buffer.alloc(64)), party, challenge, key.cose, 2),
    rejects('signature'),
  );
  assert.throws(
    () =>
      verifyPasskeyAssertion(
        build(good, clientData('webauthn.get', { challenge: Buffer.alloc(32).toString('base64url') })),
        party,
        challenge,
        key.cose,
        2,
      ),
    rejects('challenge'),
  );
  assert.throws(
    () => verifyPasskeyAssertion(build(good, clientData('webauthn.create')), party, challenge, key.cose, 2),
    rejects('client_data'),
  );
  const signedElsewhere = (() => {
    const data = authData({ flags: UP | UV, signCount: 3 });
    const client = clientData('webauthn.get', { origin: 'https://evil.example.test' });
    return build(data, client, key.sign(Buffer.concat([data, createHash('sha256').update(client, 'utf8').digest()])));
  })();
  assert.throws(() => verifyPasskeyAssertion(signedElsewhere, party, challenge, key.cose, 2), rejects('origin'));
  assert.throws(
    () =>
      verifyPasskeyAssertion(
        build(authData({ flags: UP, signCount: 3 }), clientData('webauthn.get')),
        party,
        challenge,
        key.cose,
        2,
      ),
    rejects('flags'),
  );
  assert.throws(
    () =>
      verifyPasskeyAssertion(
        build(
          authData({ flags: UP | UV | AT, signCount: 3, attested: attestedCredentialData(key.cose) }),
          clientData('webauthn.get'),
        ),
        party,
        challenge,
        key.cose,
        2,
      ),
    rejects('flags'),
  );
  assert.throws(
    () =>
      verifyPasskeyAssertion(
        build(authData({ flags: UP | UV, signCount: 3, rp: 'other.test' }), clientData('webauthn.get')),
        party,
        challenge,
        key.cose,
        2,
      ),
    rejects('rp'),
  );
  // A signature over a DIFFERENT authData payload can never verify.
  const swapped = build(good, clientData('webauthn.get'));
  swapped.authenticatorData = authData({ flags: UP | UV, signCount: 4 }).toString('base64url');
  assert.throws(() => verifyPasskeyAssertion(swapped, party, challenge, key.cose, 2), rejects('signature'));
});

test('strict base64url and COSE bounds reject malformed encodings', () => {
  assert.throws(() => decodeBase64url('abc=', 64), rejects('encoding'));
  assert.throws(() => decodeBase64url('ab+c', 64), rejects('encoding'));
  assert.throws(() => decodeBase64url('', 64), rejects('encoding'));
  assert.throws(() => decodeBase64url(Buffer.alloc(65).toString('base64url'), 64), rejects('encoding'));
  assert.throws(() => parseCosePublicKey(Buffer.from('not cbor')), rejects('cbor'));
  const shortRsa = cborMap([
    [1, cborUint(3)],
    [3, cborInt(-257)],
    [-1, cborBstr(Buffer.alloc(16))],
    [-2, cborBstr(Buffer.from([1, 0, 1]))],
  ]);
  assert.throws(() => parseCosePublicKey(shortRsa), rejects('algorithm'));
  const badCurvePoint = cborMap([
    [1, cborUint(2)],
    [3, cborInt(-7)],
    [-1, cborUint(1)],
    [-2, cborBstr(Buffer.alloc(31))],
    [-3, cborBstr(Buffer.alloc(32))],
  ]);
  assert.throws(() => parseCosePublicKey(badCurvePoint), rejects('algorithm'));
});
