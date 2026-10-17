import assert from 'node:assert/strict';
import { test } from 'node:test';

import { S3ObjectClient } from '../../src/storage/s3-object-client.js';

/**
 * Batch 4 §4.2 (task #16): the zero-dependency S3-compatible client. The
 * presign construction is pinned to the AWS S3 developer-guide
 * "Example: GET Object" (query-parameter authentication) vector; PutObject
 * is verified by signing-shape assertions and a fake-fetch round trip.
 */

const OFFICIAL_VECTOR = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://s3.amazonaws.com',
  bucket: 'examplebucket',
  region: 'us-east-1',
  key: 'test.txt',
  amzDate: '20130524T000000Z',
  expires: 86400,
  signature: 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  presignedUrl:
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
};

function officialClient(overrides: Record<string, unknown> = {}): S3ObjectClient {
  return new S3ObjectClient(
    {
      endpoint: OFFICIAL_VECTOR.endpoint,
      bucket: OFFICIAL_VECTOR.bucket,
      region: OFFICIAL_VECTOR.region,
      accessKeyId: OFFICIAL_VECTOR.accessKeyId,
      secretAccessKey: OFFICIAL_VECTOR.secretAccessKey,
      ...overrides,
    },
    {
      nowMs: () => Date.parse('2013-05-24T00:00:00Z'),
      presignExpirySeconds: OFFICIAL_VECTOR.expires,
    },
  );
}

test('4.2: presignGetObjectUrl matches the AWS S3 developer-guide GET-object vector', () => {
  const client = officialClient();
  assert.equal(client.presignGetObjectUrl(OFFICIAL_VECTOR.key), OFFICIAL_VECTOR.presignedUrl);
});

test('4.2: presign honors path-style addressing and custom expiry', () => {
  const pathStyle = officialClient({ endpoint: 'https://storage.example.internal:9000', forcePathStyle: true });
  const url = new URL(pathStyle.presignGetObjectUrl('images/task-1-0.png', 3600));
  assert.equal(url.pathname, '/examplebucket/images/task-1-0.png');
  assert.equal(url.host, 'storage.example.internal:9000');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});

test('4.2: objectUrlForDownload prefers the public base URL when configured', () => {
  const publicClient = officialClient({ publicBaseUrl: 'https://cdn.example.com/assets/' });
  assert.equal(publicClient.objectUrlForDownload('images/a.png'), 'https://cdn.example.com/assets/images/a.png');
  const presignClient = officialClient();
  const url = presignClient.objectUrlForDownload('images/a.png');
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/images/a.png?'));
  assert.ok(url.includes('X-Amz-Signature='));
});

test('4.2: putObject signs the payload hash and reports upstream failures', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const okClient = new S3ObjectClient(
    {
      endpoint: 'https://s3.example.internal',
      bucket: 'img-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    },
    {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response('', { status: 200 });
      },
      nowMs: () => Date.parse('2026-10-17T00:00:00Z'),
    },
  );
  await okClient.putObject({ key: 'images/t-0.png', contentType: 'image/png', data: new Uint8Array([1, 2, 3]) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://s3.example.internal/img-bucket/images/t-0.png');
  assert.equal(seen[0]?.init.method, 'PUT');
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.match(
    headers.authorization ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261017\/us-east-1\/s3\/aws4_request/,
  );
  assert.match(headers.authorization ?? '', /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.equal(headers['content-type'], 'image/png');
  assert.match(headers['x-amz-content-sha256'] ?? '', /^[0-9a-f]{64}$/);

  const failingClient = new S3ObjectClient(
    {
      endpoint: 'https://s3.example.internal',
      bucket: 'img-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    },
    { fetch: async () => new Response('nope', { status: 403 }), nowMs: () => 0 },
  );
  await assert.rejects(
    failingClient.putObject({ key: 'x.png', contentType: 'image/png', data: new Uint8Array([1]) }),
    /status 403/,
  );
});

test('4.2: configuration fails closed on invalid inputs', () => {
  const base = {
    endpoint: 'https://s3.example.internal',
    bucket: 'b',
    region: 'us-east-1',
    accessKeyId: 'a',
    secretAccessKey: 's',
  };
  assert.throws(() => new S3ObjectClient({ ...base, endpoint: 'not-a-url' }), /endpoint/);
  assert.throws(() => new S3ObjectClient({ ...base, bucket: '' }), /bucket/);
  assert.throws(() => new S3ObjectClient({ ...base, secretAccessKey: '' }), /secretAccessKey/);
  assert.throws(
    () =>
      new S3ObjectClient(base, {
        fetch: async () => new Response('', { status: 200 }),
        presignExpirySeconds: 1_000_000,
      }),
    /presignExpirySeconds/,
  );
});
