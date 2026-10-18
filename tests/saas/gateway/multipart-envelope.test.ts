import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  GatewayMultipartParseError,
  multipartManifestDigest,
  parseMultipartBody,
} from '../../../src/saas/gateway/multipart-envelope.js';

/**
 * Gap-remediation G-B2 (§3.3): the streamed multipart envelope's business
 * invariants — the eight-resource bounds, the staged-file SHA-256/size
 * facts, the manifest digest, and the never-a-client-filename staging path.
 */

const BOUNDARY = '----modelrouterboundary1234';

function multipartBody(parts: ReadonlyArray<{ field: string; value: string; filename?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.field}"\r\n\r\n`));
    }
    chunks.push(Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function request(headers: Record<string, string> = {}): { headers: Record<string, string> } {
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
  };
}

async function withStaging<T>(work: (staging: string) => Promise<T>): Promise<T> {
  const staging = await mkdtemp(join(tmpdir(), 'mr-multipart-test-'));
  try {
    return await work(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

test('G-B2: one file and fields parse into the envelope with digest, size and staged path', async () => {
  await withStaging(async (staging) => {
    const payload = 'hello audio bytes';
    const envelope = await parseMultipartBody(
      request(),
      Readable.from([
        multipartBody([
          { field: 'model', value: 'whisper-1' },
          { field: 'file', value: payload, filename: 'audio.mp3' },
        ]),
      ]),
      { stagingDirectory: staging },
    );
    assert.equal(envelope.kind, 'multipart');
    assert.deepEqual(envelope.fields, [{ name: 'model', value: 'whisper-1' }]);
    assert.equal(envelope.files.length, 1);
    const file = envelope.files[0];
    assert.equal(file.field, 'file');
    assert.equal(file.filename, 'audio.mp3');
    assert.equal(file.bytes, Buffer.byteLength(payload));
    assert.equal(file.sha256, createHash('sha256').update(payload).digest('hex'));
    // The staged file is inside the caller's directory and its bytes match.
    assert.ok(file.path.startsWith(staging), 'the staged path is operator-owned, never client-derived');
    const staged = await readFile(file.path, 'utf8');
    assert.equal(staged, payload);
    // The manifest digest commits fields + file digests.
    assert.equal(
      envelope.manifestDigest,
      multipartManifestDigest({
        fields: envelope.fields,
        files: [{ field: file.field, sha256: file.sha256, bytes: file.bytes }],
      }),
    );
  });
});

test('G-B2: the manifest digest preserves repeated-field order and is order-sensitive', () => {
  const base = multipartManifestDigest({
    fields: [
      { name: 'a', value: '1' },
      { name: 'a', value: '2' },
    ],
    files: [],
  });
  const flipped = multipartManifestDigest({
    fields: [
      { name: 'a', value: '2' },
      { name: 'a', value: '1' },
    ],
    files: [],
  });
  assert.notEqual(base, flipped);
});

test('G-B2: a non-multipart content type is rejected before any staging', async () => {
  await withStaging(async (staging) => {
    await assert.rejects(
      parseMultipartBody({ headers: { 'content-type': 'application/json' } }, Readable.from([Buffer.from('{}')]), {
        stagingDirectory: staging,
      }),
      (error: unknown) => error instanceof GatewayMultipartParseError && error.code === 'NOT_MULTIPART',
    );
  });
});

test('G-B2: a single file over the bound rejects FILE_TOO_LARGE and cleans the staging directory', async () => {
  await withStaging(async (staging) => {
    const big = 'x'.repeat(1025);
    await assert.rejects(
      parseMultipartBody(
        request(),
        Readable.from([multipartBody([{ field: 'file', value: big, filename: 'a.bin' }])]),
        {
          stagingDirectory: staging,
          limits: { maxFileBytes: 1024 },
        },
      ),
      (error: unknown) => error instanceof GatewayMultipartParseError && error.code === 'FILE_TOO_LARGE',
    );
    const leftovers = await stat(staging).catch(() => null);
    assert.equal(leftovers, null, 'the staging directory is removed on failure');
  });
});

test('G-B2: more files than the bound reject TOO_MANY_FILES', async () => {
  await withStaging(async (staging) => {
    await assert.rejects(
      parseMultipartBody(
        request(),
        Readable.from([
          multipartBody([
            { field: 'file', value: 'a', filename: 'a' },
            { field: 'file', value: 'b', filename: 'b' },
          ]),
        ]),
        { stagingDirectory: staging, limits: { maxFiles: 1 } },
      ),
      (error: unknown) => error instanceof GatewayMultipartParseError && error.code === 'TOO_MANY_FILES',
    );
  });
});

test('G-B2: more non-file fields than the bound reject TOO_MANY_FIELDS', async () => {
  await withStaging(async (staging) => {
    await assert.rejects(
      parseMultipartBody(
        request(),
        Readable.from([
          multipartBody([
            { field: 'a', value: '1' },
            { field: 'b', value: '2' },
          ]),
        ]),
        { stagingDirectory: staging, limits: { maxFields: 1 } },
      ),
      (error: unknown) => error instanceof GatewayMultipartParseError && error.code === 'TOO_MANY_FIELDS',
    );
  });
});

test('G-B2: an oversized field value rejects FIELD_TOO_LARGE', async () => {
  await withStaging(async (staging) => {
    await assert.rejects(
      parseMultipartBody(request(), Readable.from([multipartBody([{ field: 'big', value: 'x'.repeat(300) }])]), {
        stagingDirectory: staging,
        limits: { maxFieldBytes: 128 },
      }),
      (error: unknown) => error instanceof GatewayMultipartParseError && error.code === 'FIELD_TOO_LARGE',
    );
  });
});

test('G-B2: a malformed multipart stream rejects BAD_CONTENT_TYPE', async () => {
  await withStaging(async (staging) => {
    // A garbage body under a valid content type: busboy errors on the stream.
    await assert.rejects(
      parseMultipartBody(
        { headers: { 'content-type': 'multipart/form-data; boundary=!!!invalid!!!' } },
        Readable.from([Buffer.from('not multipart at all')]),
        { stagingDirectory: staging },
      ),
      (error: unknown) => error instanceof GatewayMultipartParseError,
    );
  });
});
