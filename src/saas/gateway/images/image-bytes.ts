import { normalizeMediaSizeTier, type UsageSizeTier } from '../../../telemetry/usage.js';

/**
 * Roadmap batch 4 §4.2 (task #16) image byte utilities: bounded base64
 * decoding plus magic-byte content-type and dimension sniffing for the four
 * browser image formats OpenAI `images.generations` returns
 * (`image/png`, `image/jpeg`, `image/gif`, `image/webp`).
 *
 * These are deliberately tiny hand-rolled parsers (the repo's
 * zero-dependency discipline): no image library, no full decode — the
 * dimension probes read only the fixed header fields, so a malformed or
 * adversarial image can never make them read past a bounded offset window.
 */

/** §4.2: the per-image decoded-bytes ceiling (the sub2api default, 32 MiB). */
export const IMAGE_MAX_DECODED_BYTES = 32 * 1024 * 1024;

export type SniffedImageContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface SniffedImageDimensions {
  readonly width: number;
  readonly height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

function bigEndianUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function bigEndianUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

function littleEndianUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function littleEndianUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  );
}

/** PNG: 8-byte signature + IHDR (width/height at fixed offsets 16/20). */
function pngDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.length < 24) return null;
  if (ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n' || ascii(bytes, 12, 4) !== 'IHDR') {
    return null;
  }
  return { width: bigEndianUint32(bytes, 16), height: bigEndianUint32(bytes, 20) };
}

/** GIF: "GIF8" magic + little-endian logical screen size at offsets 6/8. */
function gifDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.length < 10) return null;
  if (ascii(bytes, 0, 4) !== 'GIF8') return null;
  return { width: littleEndianUint16(bytes, 6), height: littleEndianUint16(bytes, 8) };
}

/** JPEG: FFD8 magic, then a bounded SOF-marker scan for the frame size. */
function jpegDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Bounded scan: the SOF marker lives in the header segment chain, never
  // deep in the entropy-coded scan. 512 KiB is far above any real header.
  const limit = Math.min(bytes.length, 512 * 1024);
  let offset = 2;
  while (offset + 9 < limit) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bigEndianUint16(bytes, offset + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      return {
        height: bigEndianUint16(bytes, offset + 5),
        width: bigEndianUint16(bytes, offset + 7),
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** WEBP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X chunk. */
function webpDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: frame tag (3 bytes) + sync code 0x9d012a, then 14-bit sizes.
    if ((bytes[23] ?? 0) !== 0x9d || (bytes[24] ?? 0) !== 0x01 || (bytes[25] ?? 0) !== 0x2a) {
      return null;
    }
    const width = littleEndianUint16(bytes, 26) & 0x3fff;
    const height = littleEndianUint16(bytes, 28) & 0x3fff;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if ((bytes[20] ?? 0) !== 0x2f) return null;
    const bits = littleEndianUint32(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas width/height minus one at offsets 24/27.
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { width, height };
  }
  return null;
}

/** Magic-byte content-type detection; unknown bytes return null. */
export function sniffImageContentType(bytes: Uint8Array): SniffedImageContentType | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  if (ascii(bytes, 0, 4) === '\x89PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Header-only dimension probe. Returns null for unknown formats or a
 * malformed header — callers treat that as "dimensions unknown", never as a
 * guess.
 */
export function sniffImageDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (!(bytes instanceof Uint8Array)) return null;
  const type = sniffImageContentType(bytes);
  if (type === 'image/png') return pngDimensions(bytes);
  if (type === 'image/gif') return gifDimensions(bytes);
  if (type === 'image/jpeg') return jpegDimensions(bytes);
  if (type === 'image/webp') return webpDimensions(bytes);
  return null;
}

/**
 * §4.2 size normalization: the observed tier prefers the output side's
 * actual dimensions (longest-edge buckets via #15's
 * `normalizeMediaSizeTier`), so a 1024×1024 image generated from a
 * default-tier request settles at 1k and a provider that silently upgrades
 * size is billed at what it actually produced.
 */
export function imageSizeTierFromDimensions(dimensions: SniffedImageDimensions | null): UsageSizeTier | null {
  if (dimensions === null) return null;
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    return null;
  }
  return normalizeMediaSizeTier(`${dimensions.width}x${dimensions.height}`);
}

/**
 * Decodes one `b64_json` value with an explicit decoded-byte ceiling. The
 * base64 alphabet is validated strictly (the standard alphabet with
 * canonical padding) so a malformed value fails instead of silently
 * producing truncated bytes.
 */
export function decodeB64ImageBytes(value: string, maxBytes: number = IMAGE_MAX_DECODED_BYTES): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('b64_json payload is empty');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('b64_json payload is not canonical base64');
  }
  if (value.length % 4 !== 0) throw new Error('b64_json payload is not a multiple of 4 bytes');
  const decodedLength = Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (decodedLength > maxBytes) {
    throw new Error(`decoded image exceeds the ${maxBytes}-byte ceiling`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength !== decodedLength) throw new Error('b64_json payload decoded to an unexpected length');
  return new Uint8Array(buffer);
}
