import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  BEDROCK_ANTHROPIC_VERSION,
  BEDROCK_DEFAULT_REGION,
  bedrockTransportProfile,
  type SigV4Credential,
  type SigV4Request,
  signBedrockRequest,
  signSigV4,
  sigv4AmzDate,
  sigv4CanonicalRequest,
  sigv4PayloadHash,
  sigv4Signature,
  sigv4SigningKey,
  sigv4StringToSign,
  sigv4UriEncode,
} from '../../../src/server/providers/bedrock.js';

/**
 * Two verification layers:
 *
 * 1. The official AWS SigV4 test-suite get-vanilla vector (the suite's
 *    published expected signature) — the same table the SaaS signer was
 *    verified against.
 * 2. A bedrock-shaped request checked against an INDEPENDENT minimal
 *    reference implementation written inline below (deliberately different
 *    structure: single function, no shared helpers) so a shared bug in the
 *    module's helper chain cannot self-confirm.
 */

const VECTOR_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const VECTOR_ACCESS_KEY = 'AKIDEXAMPLE';

// --- Layer 1: the official test-suite vector --------------------------------

const VANILLA: SigV4Request = {
  method: 'GET',
  path: '/',
  headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
  payload: new Uint8Array(0),
  amzDate: '20150830T123600Z',
  dateStamp: '20150830',
  region: 'us-east-1',
  service: 'service',
};

test('sigv4 known-answer: the AWS test-suite get-vanilla vector (canonical request)', () => {
  assert.equal(
    sigv4CanonicalRequest(VANILLA),
    [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n',
      'host;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'),
  );
});

test('sigv4 known-answer: the AWS test-suite get-vanilla vector (string to sign)', () => {
  const canonical = sigv4CanonicalRequest(VANILLA);
  assert.equal(
    sigv4StringToSign(VANILLA, canonical),
    [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/service/aws4_request',
      'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    ].join('\n'),
  );
});

test('sigv4 known-answer: the AWS test-suite get-vanilla vector (full Authorization)', () => {
  const signed = signSigV4({ accessKeyId: VECTOR_ACCESS_KEY, secretAccessKey: VECTOR_SECRET }, VANILLA);
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
  assert.equal(signed.payloadHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// --- Layer 2: the independent reference implementation ----------------------

/**
 * Minimal independent SigV4: one function, node:crypto only, assembled
 * differently from the module under test (inline string building, no
 * helper reuse — including its own percent-encoder). Returns the exact
 * Authorization header value.
 */
function referenceAuthorization(
  credential: SigV4Credential,
  input: {
    method: string;
    url: URL;
    payload: Uint8Array;
    region: string;
    amzDate: string;
    extraHeaders: Record<string, string>;
  },
): string {
  const sha256hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const uriEncode = (value: string): string => {
    const UNRESERVED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~');
    let out = '';
    for (const char of value) {
      if (UNRESERVED.has(char)) out += char;
      else for (const byte of Buffer.from(char, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
  };

  // Header set: the AWS fixed headers plus any extra (host from the URL).
  const headerEntries: Array<[string, string]> = [
    ['host', input.url.host],
    ...Object.entries(input.extraHeaders).map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string]),
  ];
  headerEntries.sort(([a], [b]) => (a < b ? -1 : 1));

  const queryEntries = [...input.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalQuery = queryEntries.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');

  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256hex(input.payload),
  ].join('\n');

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/bedrock/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credential.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 'bedrock');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return (
    `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}` +
    `, SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/** Independent payload-hash for feeding the reference (no module reuse). */
function referencePayloadHash(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

const NOW_MS = Date.parse('2026-01-17T09:15:03Z');
const AMZ_DATE = '20260117T091503Z';
const CREDENTIAL_WITH_TOKEN: SigV4Credential = {
  accessKeyId: VECTOR_ACCESS_KEY,
  secretAccessKey: VECTOR_SECRET,
  sessionToken: 'IQoJb3JpZ2luX2VxEXAMPLE==',
};

test('sigv4 known-answer: a bedrock invoke request matches the independent implementation', () => {
  const payload = Buffer.from(
    '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"2+2=?"}]}',
    'utf8',
  );
  const url = new URL(
    'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke',
  );
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    host: 'bedrock-runtime.us-west-2.amazonaws.com',
    'x-amz-content-sha256': sigv4PayloadHash(payload),
    'x-amz-date': AMZ_DATE,
    'x-amz-security-token': 'IQoJb3JpZ2luX2VxEXAMPLE==',
  };
  const signed = signSigV4(CREDENTIAL_WITH_TOKEN, {
    method: 'POST',
    path: url.pathname,
    headers,
    payload,
    amzDate: AMZ_DATE,
    dateStamp: '20260117',
    region: 'us-west-2',
    service: 'bedrock',
  });
  const expected = referenceAuthorization(CREDENTIAL_WITH_TOKEN, {
    method: 'POST',
    url,
    payload,
    region: 'us-west-2',
    amzDate: AMZ_DATE,
    extraHeaders: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-amz-content-sha256': referencePayloadHash(payload),
      'x-amz-date': AMZ_DATE,
      'x-amz-security-token': 'IQoJb3JpZ2luX2VxEXAMPLE==',
    },
  });
  assert.equal(signed.authorization, expected);
  // And the known-shape assertion: the signed header list is the fixed AWS set.
  assert.equal(signed.signedHeaders, 'accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token');
});

test('sigv4 known-answer: signBedrockRequest matches the independent implementation (with query)', () => {
  const payload = Buffer.from('{"anthropic_version":"bedrock-2023-05-31"}', 'utf8');
  const url = new URL(
    'https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-opus-4-6-v1%3A0/invoke-with-response-stream?foo=bar&baz=qux',
  );
  const signed = signBedrockRequest({
    credential: CREDENTIAL_WITH_TOKEN,
    method: 'POST',
    host: url.host,
    path: url.pathname,
    query: [...url.searchParams.entries()],
    payload,
    region: 'eu-central-1',
    nowMs: NOW_MS,
  });
  const expected = referenceAuthorization(CREDENTIAL_WITH_TOKEN, {
    method: 'POST',
    url,
    payload,
    region: 'eu-central-1',
    amzDate: AMZ_DATE,
    extraHeaders: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-amz-content-sha256': referencePayloadHash(payload),
      'x-amz-date': AMZ_DATE,
      'x-amz-security-token': 'IQoJb3JpZ2luX2VxEXAMPLE==',
    },
  });
  assert.equal(signed.headers.authorization, expected);
  // The x-amz-security-token rode the signed set.
  assert.match(signed.headers.authorization ?? '', /x-amz-security-token/);
});

test('signBedrockRequest assembles exactly the AWS header set', () => {
  const payload = Buffer.from('{"anthropic_version":"bedrock-2023-05-31"}', 'utf8');
  const { headers, payloadHash } = signBedrockRequest({
    credential: { accessKeyId: VECTOR_ACCESS_KEY, secretAccessKey: VECTOR_SECRET },
    method: 'POST',
    host: 'bedrock-runtime.us-west-2.amazonaws.com',
    path: '/model/anthropic.claude-sonnet-4-5-v1%3A0/invoke',
    payload,
    region: 'us-west-2',
    nowMs: NOW_MS,
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    'accept',
    'authorization',
    'content-type',
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
  ]);
  assert.equal(headers['x-amz-date'], AMZ_DATE);
  assert.equal(headers['x-amz-content-sha256'], payloadHash);
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
});

test('sigv4 rejects an x-amz-content-sha256 header that disagrees with the payload', () => {
  assert.throws(
    () =>
      signSigV4(
        { accessKeyId: VECTOR_ACCESS_KEY, secretAccessKey: VECTOR_SECRET },
        {
          ...VANILLA,
          headers: { ...VANILLA.headers, 'x-amz-content-sha256': '0'.repeat(64) },
        },
      ),
    /does not match the payload/,
  );
});

test('sigv4UriEncode and sigv4AmzDate basics', () => {
  assert.equal(sigv4UriEncode('aA9-._~'), 'aA9-._~');
  assert.equal(sigv4UriEncode('a b+c/d'), 'a%20b%2Bc%2Fd');
  assert.equal(sigv4UriEncode('a/b', false), 'a/b');
  assert.equal(sigv4UriEncode(':'), '%3A');
  assert.equal(sigv4UriEncode('é'), '%C3%A9');
  assert.equal(sigv4AmzDate(NOW_MS), AMZ_DATE);
});

// --- The transport profile ---------------------------------------------------

test('bedrockTransportProfile.buildUrl renders invoke URLs per region/stream', () => {
  assert.equal(
    bedrockTransportProfile.buildUrl({
      baseUrl: '',
      endpoint: 'invoke',
      model: 'anthropic.claude-sonnet-4-5-v1:0',
      upstream: { awsRegion: 'us-west-2' },
    }),
    'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-4-5-v1%3A0/invoke',
  );
  assert.equal(
    bedrockTransportProfile.buildUrl({
      baseUrl: '',
      endpoint: 'invoke-with-response-stream',
      model: 'us.anthropic.claude-sonnet-4-5-v1:0',
      upstream: {},
    }),
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke-with-response-stream',
  );
  // Protocol-style aliases map onto the invoke actions.
  assert.equal(
    bedrockTransportProfile.buildUrl({
      baseUrl: '',
      endpoint: 'messages',
      model: 'm:0',
      upstream: { awsRegion: 'eu-central-1' },
    }),
    'https://bedrock-runtime.eu-central-1.amazonaws.com/model/m%3A0/invoke',
  );
  assert.equal(
    bedrockTransportProfile.buildUrl({
      baseUrl: '',
      endpoint: 'messages-stream',
      model: 'm:0',
      upstream: { awsRegion: 'eu-central-1' },
    }),
    'https://bedrock-runtime.eu-central-1.amazonaws.com/model/m%3A0/invoke-with-response-stream',
  );
  // A baseUrl override redirects the origin (local test upstreams).
  assert.equal(
    bedrockTransportProfile.buildUrl({
      baseUrl: 'http://127.0.0.1:8787',
      endpoint: 'invoke',
      model: 'm:0',
      upstream: {},
    }),
    'http://127.0.0.1:8787/model/m%3A0/invoke',
  );
  assert.throws(() =>
    bedrockTransportProfile.buildUrl({ baseUrl: '', endpoint: 'chat/completions', model: 'm:0', upstream: {} }),
  );
  assert.throws(() => bedrockTransportProfile.buildUrl({ baseUrl: '', endpoint: 'invoke', model: '', upstream: {} }));
  assert.equal(bedrockTransportProfile.ownsHeaders, true);
});

test('bedrockTransportProfile.buildAuth signs the URL the profile itself built', async () => {
  const upstream = {
    awsAccessKeyId: VECTOR_ACCESS_KEY,
    awsSecretAccessKey: VECTOR_SECRET,
    awsSessionToken: 'IQoJb3JpZ2luX2VxEXAMPLE==',
    awsRegion: 'us-west-2',
  };
  const url = bedrockTransportProfile.buildUrl({
    baseUrl: '',
    endpoint: 'invoke',
    model: 'anthropic.claude-sonnet-4-5-v1:0',
    upstream,
  });
  const payload = Buffer.from(
    `{"anthropic_version":"${BEDROCK_ANTHROPIC_VERSION}","max_tokens":16,"messages":[{"role":"user","content":"2+2=?"}]}`,
    'utf8',
  );
  const headers = await bedrockTransportProfile.buildAuth(upstream, {
    method: 'POST',
    url,
    body: payload,
    headers: { 'content-type': 'application/json' },
    nowMs: NOW_MS,
  });
  // Independent re-derivation over the exact same material.
  const expected = referenceAuthorization(CREDENTIAL_WITH_TOKEN, {
    method: 'POST',
    url: new URL(url),
    payload,
    region: 'us-west-2',
    amzDate: AMZ_DATE,
    extraHeaders: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-amz-content-sha256': referencePayloadHash(payload),
      'x-amz-date': AMZ_DATE,
      'x-amz-security-token': 'IQoJb3JpZ2luX2VxEXAMPLE==',
    },
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    'accept',
    'authorization',
    'content-type',
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
    'x-amz-security-token',
  ]);
  assert.equal(headers.authorization, expected);
});

test('bedrockTransportProfile.buildAuth requires credential material', async () => {
  await assert.rejects(
    bedrockTransportProfile.buildAuth(
      { awsAccessKeyId: '', awsSecretAccessKey: '' },
      {
        method: 'POST',
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke',
        body: Buffer.alloc(0),
        headers: {},
      },
    ),
    /awsAccessKeyId and awsSecretAccessKey/,
  );
});

test('bedrockTransportProfile.transformRequestBody injects the version and drops URL-riding fields', () => {
  const body = {
    model: 'anthropic.claude-sonnet-4-5-v1:0',
    stream: true,
    provider: 'x',
    metadata: {},
    max_tokens: 16,
    messages: [],
  };
  const prepared = bedrockTransportProfile.transformRequestBody?.(body);
  assert.notEqual(prepared, null);
  assert.equal(prepared?.anthropic_version, BEDROCK_ANTHROPIC_VERSION);
  for (const field of ['model', 'stream', 'provider', 'metadata']) {
    assert.equal(field in (prepared ?? {}), false, field);
  }
  // Copy-on-write: the input is untouched.
  assert.equal(body.model, 'anthropic.claude-sonnet-4-5-v1:0');
  assert.equal('anthropic_version' in body, false);
  // An already-prepared body is left unchanged (null).
  assert.equal(
    bedrockTransportProfile.transformRequestBody?.({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, max_tokens: 4 }),
    null,
  );
  assert.equal(BEDROCK_DEFAULT_REGION, 'us-east-1');
});

test('sigv4SigningKey derives the documented HMAC chain', () => {
  const key = sigv4SigningKey(VECTOR_SECRET, '20150830', 'us-east-1', 'service');
  // The chain is deterministic and byte-stable across calls.
  assert.deepEqual(key, sigv4SigningKey(VECTOR_SECRET, '20150830', 'us-east-1', 'service'));
  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.length, 32);
  // The signature helper consumes it as documented.
  const stringToSign = sigv4StringToSign(VANILLA, sigv4CanonicalRequest(VANILLA));
  assert.equal(sigv4Signature(key, stringToSign), '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});
