import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractMultipartStringField, multipartBoundary } from '../../src/server/multipart.js';

function part(boundary: string, fields: Array<[string, string]>, file?: [string, string, string]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    const [fileName, field, content] = file;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${field}"; filename="${fileName}"\r\ncontent-type: text/plain\r\n\r\n${content}\r\n`,
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('multipartBoundary extracts quoted and unquoted tokens', () => {
  assert.equal(multipartBoundary('multipart/form-data; boundary="abc123"'), 'abc123');
  assert.equal(multipartBoundary('multipart/form-data; boundary=xyz-9'), 'xyz-9');
  assert.equal(multipartBoundary('multipart/form-data'), null);
  assert.equal(multipartBoundary(undefined), null);
  assert.equal(multipartBoundary('multipart/form-data; boundary='), null);
});

test('extractMultipartStringField finds the model field before and after a file part', () => {
  const boundary = 'b1';
  const before = part(boundary, [['model', 'm-1']], ['f.bin', 'file', 'DATA']);
  assert.equal(extractMultipartStringField(before, boundary, 'model'), 'm-1');
  // The file part comes before the model part; the scanner must skip the
  // file content (which must not contain the boundary, per RFC 2046).
  const onlyAfter = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.mp3"\r\ncontent-type: audio/mpeg\r\n\r\nFILEDATA-BYTES\r\n`,
    ),
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\nm-2\r\n--${boundary}--\r\n`),
  ]);
  assert.equal(extractMultipartStringField(onlyAfter, boundary, 'model'), 'm-2');
});

test('extractMultipartStringField ignores file parts named model (filename present)', () => {
  const boundary = 'b2';
  const body = part(boundary, [], ['model.bin', 'model', 'FILE-CONTENT']);
  assert.equal(extractMultipartStringField(body, boundary, 'model'), null);
});

test('extractMultipartStringField returns null for missing fields and malformed bodies', () => {
  const boundary = 'b3';
  assert.equal(extractMultipartStringField(part(boundary, [['other', 'x']]), boundary, 'model'), null);
  assert.equal(extractMultipartStringField(Buffer.from('not multipart'), boundary, 'model'), null);
  // Missing header/body separator: no value can be located.
  const noHeaders = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n`);
  assert.equal(extractMultipartStringField(noHeaders, boundary, 'model'), null);
});

test('extractMultipartStringField rejects oversized and non-printable values', () => {
  const boundary = 'b4';
  const long = 'x'.repeat(257);
  assert.equal(extractMultipartStringField(part(boundary, [['model', long]]), boundary, 'model'), null);
  const binary = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\n`),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  assert.equal(extractMultipartStringField(binary, boundary, 'model'), null);
});

test('extractMultipartStringField accepts values at the 256-byte limit', () => {
  const boundary = 'b5';
  const exact = 'y'.repeat(256);
  assert.equal(extractMultipartStringField(part(boundary, [['model', exact]]), boundary, 'model'), exact);
});
