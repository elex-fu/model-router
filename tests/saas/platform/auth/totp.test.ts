import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeBase32,
  decodeTotpSecret,
  encodeBase32,
  generateTotpSecret,
  hotpCode,
  totpCode,
  totpCodeAtSeconds,
  totpUri,
  verifyTotpCode,
} from '../../../../src/saas/platform/auth/totp.js';

const rfcHmacSecret = Buffer.from('12345678901234567890');
const rfcHmacSecretBase32 = encodeBase32(rfcHmacSecret);

test('encodes and decodes standard Base32 with optional RFC padding', () => {
  const source = Buffer.from('foobar');
  assert.equal(encodeBase32(source), 'MZXW6YTBOI');
  assert.equal(encodeBase32(source, true), 'MZXW6YTBOI======');
  assert.deepEqual(decodeBase32('mzxw6ytboi======'), source);
  assert.deepEqual(decodeBase32('MZXW6YTBOI'), source);
});

test('generates independent cryptographically random TOTP secrets', () => {
  const first = generateTotpSecret();
  const second = generateTotpSecret();

  assert.match(first, /^[A-Z2-7]+$/);
  assert.equal(first.length, 32);
  assert.notEqual(first, second);
  const decoded = decodeTotpSecret(first);
  assert.equal(decoded.length, 20);
  decoded.fill(0);
});

test('matches RFC 4226 HOTP vectors', () => {
  const expectedCodes = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  for (const [counter, expected] of expectedCodes.entries()) {
    assert.equal(hotpCode(rfcHmacSecret, counter), expected);
  }
});

test('matches RFC 6238 vectors for SHA-1, SHA-256, and SHA-512', () => {
  const vectors = [
    {
      algorithm: 'sha1' as const,
      secret: Buffer.from('12345678901234567890'),
      expected: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
    },
    {
      algorithm: 'sha256' as const,
      secret: Buffer.from('12345678901234567890123456789012'),
      expected: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
    },
    {
      algorithm: 'sha512' as const,
      secret: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
      expected: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'],
    },
  ];
  const timestamps = [59, 1_111_111_109, 1_111_111_111, 1_234_567_890, 2_000_000_000, 20_000_000_000];

  for (const vector of vectors) {
    for (const [index, timestamp] of timestamps.entries()) {
      assert.equal(
        totpCodeAtSeconds(encodeBase32(vector.secret), timestamp, {
          algorithm: vector.algorithm,
          digits: 8,
          stepSeconds: 30,
        }),
        vector.expected[index],
        `${vector.algorithm} at ${timestamp}`,
      );
    }
  }
});

test('accepts the current code and one adjacent time step, but rejects two steps away', () => {
  const nowMs = 1_700_000_000_000;
  const stepMs = 30_000;
  const secret = rfcHmacSecretBase32;
  const current = totpCode(secret, nowMs);
  const previous = totpCode(secret, nowMs - stepMs);
  const next = totpCode(secret, nowMs + stepMs);
  const tooOld = totpCode(secret, nowMs - stepMs * 2);
  const tooNew = totpCode(secret, nowMs + stepMs * 2);

  assert.equal(verifyTotpCode(secret, current, nowMs), true);
  assert.equal(verifyTotpCode(secret, previous, nowMs), true);
  assert.equal(verifyTotpCode(secret, next, nowMs), true);
  assert.equal(verifyTotpCode(secret, tooOld, nowMs), false);
  assert.equal(verifyTotpCode(secret, tooNew, nowMs), false);
});

test('rejects malformed Base32, malformed codes, and secrets that are too short', () => {
  assert.throws(() => decodeBase32('A'));
  assert.throws(() => decodeBase32('MZXW6YTBOI=====X'));
  assert.throws(() => decodeBase32('MZXW6YTBOJ'));
  assert.throws(() => totpCode('not a base32 secret', 0));

  const shortSecret = encodeBase32(Buffer.alloc(10));
  assert.throws(() => totpCode(shortSecret, 0));
  assert.throws(() => verifyTotpCode(rfcHmacSecretBase32, '12345', 0));
  assert.throws(() => verifyTotpCode(rfcHmacSecretBase32, '123456', 0, { digits: 7 as never }));
});

test('generates an encoded otpauth URI', () => {
  const uri = totpUri(rfcHmacSecretBase32, 'Acme & Co/平台', 'user+tag@example.com');
  assert.equal(
    uri,
    'otpauth://totp/Acme%20%26%20Co%2F%E5%B9%B3%E5%8F%B0:user%2Btag%40example.com' +
      '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
      '&issuer=Acme%20%26%20Co%2F%E5%B9%B3%E5%8F%B0&algorithm=SHA1&digits=6&period=30',
  );
  assert.throws(() => totpUri(shortSecretForTest(), 'issuer', 'account'));
});

function shortSecretForTest(): string {
  return encodeBase32(Buffer.alloc(10));
}
