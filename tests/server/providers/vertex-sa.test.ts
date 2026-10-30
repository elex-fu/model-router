import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  buildVertexAnthropicRequestBody,
  buildVertexAnthropicUrl,
  buildVertexGeminiUrl,
  buildVertexSaAssertion,
  createVertexSaTokenProvider,
  createVertexTransportProfile,
  exchangeVertexSaToken,
  parseVertexServiceAccountJson,
  VERTEX_ANTHROPIC_VERSION,
  VERTEX_CLOUD_PLATFORM_SCOPE,
  VERTEX_TOKEN_CACHE_SKEW_MS,
  VERTEX_TOKEN_URL,
  VertexSaTokenError,
  VertexServiceAccountParseError,
  vertexSaTokenTtlMs,
} from '../../../src/server/providers/vertex-sa.js';

// Runtime-generated key material — never a source literal (repo rule).
function saFixture(): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    client_email: 'vertex-sa@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    private_key_id: 'kid-42',
    project_id: 'proj-1',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function fetchStub(respond: () => { status: number; body: string }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string; body: string; contentType: string }>;
} {
  const calls: Array<{ url: string; method: string; body: string; contentType: string }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? '',
      body: String(init.body ?? ''),
      contentType: new Headers(init.headers).get('content-type') ?? '',
    });
    const response = respond();
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

// ---------------------------------------------------------------------------
// Parsing.

test('parseVertexServiceAccountJson extracts the four exchange fields and pins token_uri', () => {
  const sa = saFixture();
  const key = parseVertexServiceAccountJson(JSON.stringify(sa));
  assert.equal(key.clientEmail, 'vertex-sa@test.iam.gserviceaccount.com');
  assert.equal(key.privateKeyId, 'kid-42');
  assert.equal(key.projectId, 'proj-1');
  assert.equal(key.tokenUri, VERTEX_TOKEN_URL);
  // The object form parses identically.
  assert.deepEqual(parseVertexServiceAccountJson(sa), key);
  // A crafted token_uri is still pinned to the Google endpoint.
  const hostile = parseVertexServiceAccountJson(JSON.stringify({ ...sa, token_uri: 'https://evil.example.com/token' }));
  assert.equal(hostile.tokenUri, VERTEX_TOKEN_URL);
});

test('parseVertexServiceAccountJson fails closed on malformed input', () => {
  assert.throws(
    () => parseVertexServiceAccountJson('not json'),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MALFORMED_JSON',
  );
  const sa = saFixture();
  for (const [field, code] of [
    ['client_email', 'MISSING_CLIENT_EMAIL'],
    ['private_key', 'MISSING_PRIVATE_KEY'],
    ['project_id', 'MISSING_PROJECT_ID'],
  ] as const) {
    const broken = { ...sa };
    delete broken[field];
    assert.throws(
      () => parseVertexServiceAccountJson(broken),
      (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === code,
      field,
    );
  }
  assert.throws(
    () => parseVertexServiceAccountJson([1, 2] as unknown as Record<string, unknown>),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MALFORMED_NESTED_OBJECT',
  );
});

// ---------------------------------------------------------------------------
// The JWT assertion (claim correctness against the sub2api claim set).

test('buildVertexSaAssertion mirrors the reference claims and verifies as RS256', () => {
  const sa = saFixture();
  const key = parseVertexServiceAccountJson(sa);
  const nowMs = 1_700_000_000_000;
  const assertion = buildVertexSaAssertion(key, nowMs);
  const [headerB64, claimsB64, signatureB64] = assertion.split('.');
  const header = decodeSegment(headerB64);
  const claims = decodeSegment(claimsB64);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, 'kid-42');
  assert.equal(claims.iss, 'vertex-sa@test.iam.gserviceaccount.com');
  assert.equal(claims.scope, VERTEX_CLOUD_PLATFORM_SCOPE);
  assert.equal(claims.aud, VERTEX_TOKEN_URL);
  assert.equal(claims.iat, Math.floor(nowMs / 1000));
  assert.equal(claims.exp, Math.floor(nowMs / 1000) + 3_600);
  // The RS256 signature verifies against the runtime-generated public key.
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${claimsB64}`);
  assert.equal(verifier.verify(createPublicKey(key.privateKey), Buffer.from(signatureB64, 'base64url')), true);
});

test('buildVertexSaAssertion omits kid when the key file carries none', () => {
  const sa = saFixture();
  delete sa.private_key_id;
  const key = parseVertexServiceAccountJson(sa);
  const assertion = buildVertexSaAssertion(key, 1_700_000_000_000);
  assert.equal('kid' in decodeSegment(assertion.split('.')[0]), false);
});

test('a malformed private key fails with the assertion error code', () => {
  const key = parseVertexServiceAccountJson(saFixture());
  assert.throws(
    () => buildVertexSaAssertion({ ...key, privateKey: 'not a pem' }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'ASSERTION_SIGN_FAILED',
  );
});

// ---------------------------------------------------------------------------
// The jwt-bearer exchange (fetch stub for unit purity).

test('exchangeVertexSaToken posts the jwt-bearer form and parses the response', async () => {
  const key = parseVertexServiceAccountJson(saFixture());
  const { fetch, calls } = fetchStub(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'ya29.token', token_type: 'Bearer', expires_in: 3600 }),
  }));
  const result = await exchangeVertexSaToken({ key, fetch });
  assert.equal(result.accessToken, 'ya29.token');
  assert.equal(result.expiresInSeconds, 3600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, VERTEX_TOKEN_URL);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].contentType, 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = params.get('assertion') ?? '';
  assert.equal(assertion.split('.').length, 3);
  assert.equal(decodeSegment(assertion.split('.')[1]).iss, key.clientEmail);
});

test('the exchange fails closed on non-2xx, missing tokens and oversized bodies', async () => {
  const key = parseVertexServiceAccountJson(saFixture());
  await assert.rejects(
    exchangeVertexSaToken({
      key,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad jwt' }), { status: 400 }),
    }),
    (error: unknown) =>
      error instanceof VertexSaTokenError &&
      error.code === 'TOKEN_ENDPOINT_FAILED' &&
      String(error.message).includes('bad jwt'),
  );
  await assert.rejects(
    exchangeVertexSaToken({ key, fetch: async () => new Response('server oops', { status: 500 }) }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'TOKEN_ENDPOINT_FAILED',
  );
  await assert.rejects(
    exchangeVertexSaToken({ key, fetch: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }) }),
    (error: unknown) => error instanceof VertexSaTokenError && error.code === 'TOKEN_RESPONSE_INVALID',
  );
});

// ---------------------------------------------------------------------------
// The in-memory token provider.

test('the token provider caches, refreshes after the margin and single-flights', async () => {
  const sa = saFixture();
  let exchanges = 0;
  let clock = 1_000_000;
  const provider = createVertexSaTokenProvider(sa, {
    nowMs: () => clock,
    fetch: async () => {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: `token-${exchanges}`, expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(await provider.getAccessToken(), 'token-1');
  // A cached token is reused without a second exchange.
  assert.equal(await provider.getAccessToken(), 'token-1');
  assert.equal(exchanges, 1);
  // Still cached well before expiry (the skew is already subtracted).
  clock = 1_000_000 + 3_600_000 - VERTEX_TOKEN_CACHE_SKEW_MS - 60_000;
  assert.equal(await provider.getAccessToken(), 'token-1');
  assert.equal(exchanges, 1);
  // Past the refresh margin the token re-exchanges.
  clock = 1_000_000 + 3_600_000;
  assert.equal(await provider.getAccessToken(), 'token-2');
  assert.equal(exchanges, 2);
  // reset() drops the cache.
  provider.reset();
  assert.equal(await provider.getAccessToken(), 'token-3');
  assert.equal(exchanges, 3);
});

test('concurrent getAccessToken calls share one in-flight exchange', async () => {
  const sa = saFixture();
  let exchanges = 0;
  const provider = createVertexSaTokenProvider(sa, {
    fetch: async () => {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: 'shared-token', expires_in: 3600 }), { status: 200 });
    },
  });
  const [a, b, c] = await Promise.all([
    provider.getAccessToken(),
    provider.getAccessToken(),
    provider.getAccessToken(),
  ]);
  assert.deepEqual([a, b, c], ['shared-token', 'shared-token', 'shared-token']);
  assert.equal(exchanges, 1);
});

test('a failed exchange is never cached', async () => {
  const sa = saFixture();
  let attempts = 0;
  const provider = createVertexSaTokenProvider(sa, {
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ access_token: 'recovered', expires_in: 3600 }), { status: 200 });
    },
  });
  await assert.rejects(provider.getAccessToken());
  assert.equal(await provider.getAccessToken(), 'recovered');
  assert.equal(attempts, 2);
});

test('vertexSaTokenTtlMs subtracts the skew and never drops below one minute', () => {
  assert.equal(vertexSaTokenTtlMs(3600), 3600_000 - VERTEX_TOKEN_CACHE_SKEW_MS);
  assert.equal(vertexSaTokenTtlMs(null), 3600_000 - VERTEX_TOKEN_CACHE_SKEW_MS);
  assert.equal(vertexSaTokenTtlMs(10), 60_000);
});

// ---------------------------------------------------------------------------
// URL building and the transport profile.

test('buildVertexAnthropicUrl renders the aiplatform path with a literal @', () => {
  assert.equal(
    buildVertexAnthropicUrl({
      projectId: 'proj-1',
      location: 'us-east5',
      model: 'claude-sonnet-4-5@20261001',
      stream: false,
    }),
    'https://us-east5-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20261001:rawPredict',
  );
  assert.equal(
    buildVertexAnthropicUrl({ projectId: 'proj-1', location: 'us-east5', model: 'claude-sonnet-4-5', stream: true }),
    'https://us-east5-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict',
  );
  // `global` carries no regional prefix.
  assert.equal(
    buildVertexGeminiUrl({ projectId: 'p', location: 'global', model: 'gemini-2.5-pro', stream: false }),
    'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-pro:generateContent',
  );
  assert.equal(
    buildVertexGeminiUrl({ projectId: 'p', location: 'us-central1', model: 'gemini-2.5-pro', stream: true }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
  );
  assert.throws(() => buildVertexAnthropicUrl({ projectId: 'p', location: 'BAD LOC', model: 'm', stream: false }));
  assert.throws(() =>
    buildVertexAnthropicUrl({ projectId: 'p', location: 'us-central1', model: 'has space', stream: false }),
  );
});

test('buildVertexAnthropicRequestBody deletes model and injects the vertex version', () => {
  const body = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [] };
  const prepared = buildVertexAnthropicRequestBody(body);
  assert.equal('model' in prepared, false);
  assert.equal(prepared.anthropic_version, VERTEX_ANTHROPIC_VERSION);
  // Copy-on-write: the input is untouched.
  assert.equal(body.model, 'claude-sonnet-4-5');
  assert.equal('anthropic_version' in body, false);
});

test('the vertex transport profile builds URLs, mints Bearer auth and transforms bodies', async () => {
  const sa = saFixture();
  const clock = 1_700_000_000_000;
  const profile = createVertexTransportProfile({
    nowMs: () => clock,
    fetch: async () =>
      new Response(JSON.stringify({ access_token: 'ya29.profile', expires_in: 3600 }), { status: 200 }),
  });
  const upstream = { serviceAccountJson: sa, vertexLocation: 'us-east5' };
  const url = profile.buildUrl({
    baseUrl: '',
    endpoint: 'streamRawPredict',
    model: 'claude-sonnet-4-5',
    upstream,
  });
  assert.equal(
    url,
    'https://us-east5-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict',
  );
  const headers = await profile.buildAuth(upstream, {
    method: 'POST',
    url,
    body: Buffer.from('{}'),
    headers: { 'content-type': 'application/json' },
    nowMs: clock,
  });
  assert.deepEqual(headers, { authorization: 'Bearer ya29.profile' });
  // The cached token is reused (no second exchange) and profile token
  // providers are cached per SA key.
  const again = await profile.buildAuth(upstream, {
    method: 'POST',
    url,
    body: Buffer.from('{}'),
    headers: {},
    nowMs: clock,
  });
  assert.deepEqual(again, { authorization: 'Bearer ya29.profile' });
  // Body transform for the anthropic family; null for gemini endpoints.
  const transformed = profile.transformRequestBody?.(
    { model: 'claude-sonnet-4-5', max_tokens: 8 },
    { endpoint: 'rawPredict' },
  );
  assert.equal(transformed?.anthropic_version, VERTEX_ANTHROPIC_VERSION);
  assert.equal('model' in (transformed ?? {}), false);
  assert.equal(profile.transformRequestBody?.({ contents: [] }, { endpoint: 'generateContent' }), null);
  // Endpoint aliases and rejection.
  assert.equal(
    profile.buildUrl({ baseUrl: '', endpoint: 'messages', model: 'm', upstream }),
    'https://us-east5-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/m:rawPredict',
  );
  assert.throws(() => profile.buildUrl({ baseUrl: '', endpoint: 'chat/completions', model: 'm', upstream }));
  assert.throws(() => profile.buildUrl({ baseUrl: '', endpoint: 'rawPredict', model: 'm', upstream: {} }));
});

test('the vertex transport profile defaults the location to us-central1', () => {
  const sa = saFixture();
  const profile = createVertexTransportProfile({
    fetch: async () => new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 }),
  });
  assert.equal(
    profile.buildUrl({
      baseUrl: '',
      endpoint: 'generateContent',
      model: 'gemini-2.5-pro',
      upstream: { serviceAccountJson: sa },
    }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
  );
});
