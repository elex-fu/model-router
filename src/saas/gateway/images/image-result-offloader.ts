import { decodeB64ImageBytes, IMAGE_MAX_DECODED_BYTES, sniffImageContentType } from './image-bytes.js';

/**
 * Roadmap batch 4 §4.2 (task #16) image result offload (sub2api
 * `ImageResultUploader.Rewrite` ported): each generated image in the
 * upstream response (`data[].b64_json`, or a `data:` image URL) is uploaded
 * to object storage and the response is rewritten to carry only short
 * links, so a multi-megabyte base64 blob never lands in the task store.
 *
 * Discipline (verbatim from the sub2api contract):
 * - any offload failure aborts the rewrite and the task fails — there is
 *   never a "fall back to storing the base64" branch;
 * - the b64 decode ceiling is 32 MiB per image;
 * - an http(s) `url` item is left untouched (the provider already offloaded
 *   it; the rewrite never downloads remote URLs — no SSRF surface in the
 *   first phase).
 */

export const IMAGE_OFFLOAD_KEY_PREFIX = 'images/';
/** The rewritten result JSON (short links only) is bounded explicitly. */
export const IMAGE_OFFLOAD_MAX_RESULT_BYTES = 1024 * 1024;

export class ImageResultOffloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageResultOffloadError';
  }
}

export interface ImageResultObjectStorage {
  putObject(input: { readonly key: string; readonly contentType: string; readonly data: Uint8Array }): Promise<void>;
  objectUrlForDownload(key: string): string;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  return '.png';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decodes the `data:` image URL payload (image/* media type, base64 token
 * final) — the sub2api decodeImageDataURL contract without the remote
 * download branch.
 */
function decodeDataImageUrl(value: string): { data: Uint8Array; contentType: string } {
  if (!/^data:image\//i.test(value)) throw new ImageResultOffloadError('image data URL is not an image');
  const comma = value.indexOf(',');
  if (comma < 0) throw new ImageResultOffloadError('image data URL is missing the comma separator');
  const header = value.slice(5, comma);
  const parts = header.split(';');
  const mediaType = parts[0]?.trim().toLowerCase() ?? '';
  if (!/^image\/[a-z0-9.+-]{2,32}$/.test(mediaType)) {
    throw new ImageResultOffloadError('image data URL media type is invalid');
  }
  const markers = parts.slice(1).filter((part) => part.trim().toLowerCase() === 'base64');
  if (markers.length !== 1 || parts.at(-1)?.trim().toLowerCase() !== 'base64') {
    throw new ImageResultOffloadError('image data URL payload is not base64 encoded');
  }
  try {
    const data = decodeB64ImageBytes(value.slice(comma + 1));
    const contentType = sniffImageContentType(data) ?? mediaType;
    return { data, contentType };
  } catch (error) {
    if (error instanceof ImageResultOffloadError) throw error;
    throw new ImageResultOffloadError('image data URL base64 payload failed to decode');
  }
}

export interface ImageResultOffloaderOptions {
  readonly storage: ImageResultObjectStorage;
  readonly keyPrefix?: string;
  /** Per-image decoded-byte ceiling; default 32 MiB. */
  readonly maxImageBytes?: number;
}

export class ImageResultOffloader {
  private readonly storage: ImageResultObjectStorage;
  private readonly keyPrefix: string;
  private readonly maxImageBytes: number;

  constructor(options: ImageResultOffloaderOptions) {
    if (!options || typeof options !== 'object' || !options.storage) {
      throw new ImageResultOffloadError('the image result offloader requires object storage');
    }
    if (typeof options.storage.putObject !== 'function' || typeof options.storage.objectUrlForDownload !== 'function') {
      throw new ImageResultOffloadError('the image result storage contract is incomplete');
    }
    this.storage = options.storage;
    const keyPrefix = options.keyPrefix ?? IMAGE_OFFLOAD_KEY_PREFIX;
    if (
      typeof keyPrefix !== 'string' ||
      keyPrefix.length === 0 ||
      keyPrefix.length > 256 ||
      keyPrefix.startsWith('/') ||
      keyPrefix.includes('..')
    ) {
      throw new ImageResultOffloadError('the offload key prefix is invalid');
    }
    this.keyPrefix = keyPrefix;
    const maxImageBytes = options.maxImageBytes ?? IMAGE_MAX_DECODED_BYTES;
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) {
      throw new ImageResultOffloadError('the decoded-image byte ceiling is invalid');
    }
    this.maxImageBytes = maxImageBytes;
  }

  /**
   * Rewrites the upstream image response to short links. Throws
   * (ImageResultOffloadError) on any offload failure; the caller marks the
   * task failed and never stores the raw result.
   */
  async rewrite(taskId: string, resultJsonText: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resultJsonText);
    } catch {
      throw new ImageResultOffloadError('the image response is not valid JSON');
    }
    if (!isRecord(parsed)) throw new ImageResultOffloadError('the image response is not a JSON object');
    const data = parsed.data;
    if (!Array.isArray(data)) {
      // No image array (a shaped-but-imageless envelope) passes through
      // unchanged; the caller's validation decides what that means.
      return resultJsonText;
    }
    if (data.length === 0) return resultJsonText;

    const rewritten: Record<string, unknown>[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const item = data[index];
      if (!isRecord(item)) throw new ImageResultOffloadError(`image ${index}: the item is not a JSON object`);
      const bytes = await this.imageBytes(item, index);
      const next: Record<string, unknown> = { ...item };
      if (bytes !== null) {
        const key = `${this.keyPrefix}${taskId}-${index}${extensionForContentType(bytes.contentType)}`;
        try {
          await this.storage.putObject({ key, contentType: bytes.contentType, data: bytes.data });
        } catch (error) {
          throw new ImageResultOffloadError(
            `image ${index}: upload to object storage failed (${error instanceof Error ? error.message : 'unknown error'})`,
          );
        }
        next.url = this.storage.objectUrlForDownload(key);
        delete next.b64_json;
      }
      rewritten.push(next);
    }
    const out = JSON.stringify({ ...parsed, data: rewritten });
    if (Buffer.byteLength(out, 'utf8') > IMAGE_OFFLOAD_MAX_RESULT_BYTES) {
      throw new ImageResultOffloadError('the rewritten image response exceeds the result ceiling');
    }
    return out;
  }

  private async imageBytes(
    item: Record<string, unknown>,
    index: number,
  ): Promise<{ data: Uint8Array; contentType: string } | null> {
    const b64 = item.b64_json;
    if (typeof b64 === 'string' && b64.trim() !== '') {
      let data: Uint8Array;
      try {
        data = decodeB64ImageBytes(b64.trim(), this.maxImageBytes);
      } catch {
        throw new ImageResultOffloadError(`image ${index}: the b64_json payload failed to decode`);
      }
      return { data, contentType: sniffImageContentType(data) ?? 'image/png' };
    }
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (url !== '' && url.toLowerCase().startsWith('data:')) {
      return decodeDataImageUrl(url);
    }
    // An http(s) URL item is already a link; the rewrite leaves it alone.
    return null;
  }
}
