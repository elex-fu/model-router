import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  VERTEX_CLOUD_PLATFORM_SCOPE,
  VERTEX_TOKEN_CACHE_SKEW_MS,
  VERTEX_TOKEN_URL,
} from '../../../../src/saas/gateway/vertex/constants.js';
import type { VertexServiceAccountKey } from '../../../../src/saas/platform/vertex-sa/service-account.js';
import {
  buildVertexSaAssertion,
  exchangeVertexSaToken,
  VertexSaTokenError,
  vertexSaFailureBackoffMs,
  vertexSaTokenTtlMs,
} from '../../../../src/saas/platform/vertex-sa/token-service.js';

// Runtime-generated key material — never a source literal.
function keyPair(): { readonly key: VertexServiceAccountKey; readonly publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    key: {
      clientEmail: 'vertex-sa@test.iam.gserviceaccount.com',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      privateKeyId: 'kid-42',
      projectId: 'proj-1',
      tokenUri: VERTEX_TOKEN_URL,
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('JWT construction is table-driven against the sub2api claims', async () => {
  const nowMs = 1_700_000_000_000;
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly key: VertexServiceAccountKey;
    readonly expectKid: boolean;
  }> = [
    { name: 'with kid', key: keyPair().key, expectKid: true },
    {
      name: 'without kid',
      key: { ...keyPair().key, privateKeyId: null },
      expectKid: false,
    },
    {
      name: 'client_email with dots and colons survives intact',
      key: { ...keyPair().key, clientEmail: 'weird+name@sub.domain.iam.gserviceaccount.com' },
      expectKid: true,
    },
  ];
  for (const testCase of cases) {
    const assertion = buildVertexSaAssertion(testCase.key, nowMs);
    const [headerB64, claimsB64, signatureB64] = assertion.split('.');
    const header = decodeSegment(headerB64);
    const claims = decodeSegment(claimsB64);
    assert.equal(header.alg, 'RS256', testCase.name);
    assert.equal(header.typ, 'JWT', testCase.name);
    if (testCase.expectKid) {
      assert.equal(header.kid, testCase.key.privateKeyId, testCase.name);
    } else {
      assert.equal('kid' in header, false, testCase.name);
    }
    assert.equal(claims.iss, testCase.key.clientEmail, testCase.name);
    assert.equal(claims.scope, VERTEX_CLOUD_PLATFORM_SCOPE, testCase.name);
    assert.equal(claims.aud, VERTEX_TOKEN_URL, testCase.name);
    assert.equal(claims.iat, Math.floor(nowMs / 1000), testCase.name);
    assert.equal(claims.exp, Math.floor(nowMs / 1000) + 3_600, testCase.name);
    // The RS256 signature verifies with node:crypto against the public key.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${claimsB64}`);
    assert.equal(
      verifier.verify(createPublicKey(testCase.key.privateKey), Buffer.from(signatureB64, 'base64url')),
      true,
      testCase.name,
    );
  }
});

test('a malformed private key fails with the assertion error code', () => {
  assert.throws(
    () => buildVertexSaAssertion({ ...keyPair().key, privateKey: 'not a pem' }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'ASSERTION_SIGN_FAILED',
  );
});

test('the jwt-bearer exchange posts the form body and parses the token response', async () => {
  const { key } = keyPair();
  const seen: Array<{ url: string; init: RequestInit; body: string }> = [];
  const result = await exchangeVertexSaToken({
    key,
    fetch: async (url, init) => {
      seen.push({ url, init, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: 'ya29.token', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.accessToken, 'ya29.token');
  assert.equal(result.expiresInSeconds, 3600);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, VERTEX_TOKEN_URL);
  assert.equal(seen[0].init.method, 'POST');
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(seen[0].body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = params.get('assertion') ?? '';
  assert.equal(assertion.split('.').length, 3);
  assert.equal(decodeSegment(assertion.split('.')[0]).alg, 'RS256');
  // The exchange is observable end-to-end: the assertion's iss is the SA email.
  assert.equal(decodeSegment(assertion.split('.')[1]).iss, key.clientEmail);
});

test('a non-pinned token_uri fails closed before any request is made', async () => {
  const { key } = keyPair();
  let called = false;
  await assert.rejects(
    exchangeVertexSaToken({
      key: { ...key, tokenUri: 'https://evil.example.com/token' },
      fetch: async () => {
        called = true;
        return new Response('{}');
      },
    }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'TOKEN_ENDPOINT_FAILED',
  );
  assert.equal(called, false);
});

test('token endpoint rejections surface the provider error description', async () => {
  const { key } = keyPair();
  await assert.rejects(
    exchangeVertexSaToken({
      key,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), {
          status: 400,
        }),
    }),
    (error: unknown) =>
      error instanceof VertexSaTokenError &&
      error.code === 'TOKEN_ENDPOINT_FAILED' &&
      error.message.includes('Invalid JWT Signature.'),
  );
  await assert.rejects(
    exchangeVertexSaToken({
      key,
      fetch: async () => new Response('server oops', { status: 500 }),
    }),
    (error: unknown) =>
      error instanceof VertexSaTokenError && error.code === 'TOKEN_ENDPOINT_FAILED' && error.message.includes('500'),
  );
  await assert.rejects(
    exchangeVertexSaToken({
      key,
      fetch: async () => new Response(JSON.stringify({ no_token: true }), { status: 200 }),
    }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'TOKEN_RESPONSE_INVALID',
  );
});

test('the TTL math subtracts the 5-minute cache skew and never drops below one minute', () => {
  assert.equal(vertexSaTokenTtlMs(3600), 3600_000 - VERTEX_TOKEN_CACHE_SKEW_MS);
  assert.equal(vertexSaTokenTtlMs(null), 3600_000 - VERTEX_TOKEN_CACHE_SKEW_MS);
  assert.equal(vertexSaTokenTtlMs(60), 60_000);
  assert.equal(vertexSaTokenTtlMs(10), 60_000);
});

test('the failure backoff ladder is 1m, 2m, 4m... capped at 1h', () => {
  assert.equal(vertexSaFailureBackoffMs(null), 60_000);
  assert.equal(vertexSaFailureBackoffMs(60_000), 120_000);
  assert.equal(vertexSaFailureBackoffMs(240_000), 480_000);
  assert.equal(vertexSaFailureBackoffMs(3_600_000), 3_600_000);
  assert.equal(vertexSaFailureBackoffMs(7_200_000), 3_600_000);
});
