import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeB64ImageBytes,
  imageSizeTierFromDimensions,
  sniffImageContentType,
  sniffImageDimensions,
} from '../../../../src/saas/gateway/images/image-bytes.js';

/**
 * Batch 4 §4.2 (task #16): image byte utilities — magic-byte content type,
 * header-only dimension probing, and bounded base64 decoding.
 */

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpegSof(width: number, height: number): Uint8Array {
  // SOI + APP0 (JFIF) + SOF0 with the frame size.
  const bytes = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0 marker, length, precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // 3 components
  ]);
  return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  bytes.set([0x30, 0x00, 0x00], 20); // frame tag
  bytes.set([0x9d, 0x01, 0x2a], 23); // sync code
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

test('4.2: sniffs the content type from magic bytes', () => {
  assert.equal(sniffImageContentType(png(1, 1)), 'image/png');
  assert.equal(sniffImageContentType(gif(1, 1)), 'image/gif');
  assert.equal(sniffImageContentType(jpegSof(8, 8)), 'image/jpeg');
  assert.equal(sniffImageContentType(webpLossy(8, 8)), 'image/webp');
  assert.equal(sniffImageContentType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), null);
  assert.equal(sniffImageContentType(new Uint8Array(4)), null);
});

test('4.2: probes dimensions for png, gif, jpeg and webp headers', () => {
  assert.deepEqual(sniffImageDimensions(png(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(sniffImageDimensions(gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(sniffImageDimensions(jpegSof(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(sniffImageDimensions(webpLossy(550, 368)), { width: 550, height: 368 });
  // Truncated / unknown bytes never guess.
  assert.equal(sniffImageDimensions(png(1, 1).subarray(0, 10)), null);
  assert.equal(sniffImageDimensions(new Uint8Array(64)), null);
});

test('4.2: the longest-edge tier matches the #15 normalization buckets', () => {
  assert.equal(imageSizeTierFromDimensions({ width: 1024, height: 1024 }), '1k');
  assert.equal(imageSizeTierFromDimensions({ width: 1024, height: 768 }), '1k');
  assert.equal(imageSizeTierFromDimensions({ width: 1536, height: 1024 }), '2k');
  assert.equal(imageSizeTierFromDimensions({ width: 1792, height: 1792 }), '2k');
  assert.equal(imageSizeTierFromDimensions({ width: 2048, height: 1170 }), '4k');
  assert.equal(imageSizeTierFromDimensions({ width: 4096, height: 4096 }), '4k');
  assert.equal(imageSizeTierFromDimensions(null), null);
  assert.equal(imageSizeTierFromDimensions({ width: 0, height: 10 }), null);
  assert.equal(imageSizeTierFromDimensions({ width: -5, height: 10 }), null);
});

test('4.2: decodes canonical base64 with the decoded-byte ceiling', () => {
  const decoded = decodeB64ImageBytes(Buffer.from('hello image bytes').toString('base64'));
  assert.equal(Buffer.from(decoded).toString('utf8'), 'hello image bytes');
  // Exactly at the ceiling passes.
  const atLimit = decodeB64ImageBytes(Buffer.alloc(16).toString('base64'), 16);
  assert.equal(atLimit.byteLength, 16);
  // One byte over the ceiling throws.
  assert.throws(() => decodeB64ImageBytes(Buffer.alloc(17).toString('base64'), 16), /ceiling/);
  // Non-canonical alphabets and padding throw instead of truncating.
  assert.throws(() => decodeB64ImageBytes('aGVsbG8*'), /canonical base64/);
  assert.throws(() => decodeB64ImageBytes('aGVsbG8'), /multiple of 4/);
  assert.throws(() => decodeB64ImageBytes(''));
});
