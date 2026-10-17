import type { NormalizedUsage, UsageSizeTier } from '../../../telemetry/usage.js';
import { normalizeMediaSizeTier } from '../../../telemetry/usage.js';
import type { ProviderMediaUsagePlan } from '../provider-http-transport.js';
import type { ProviderMediaUsageExtractor } from '../provider-json-usage-observer.js';
import { decodeB64ImageBytes, imageSizeTierFromDimensions, sniffImageDimensions } from './image-bytes.js';

/**
 * Roadmap batch 4 §4.2 (task #16): the images.generations media usage plan —
 * the per-request binding between the compiled provider payload and the
 * JSON observer's #15 media extractor seam.
 *
 * Two pieces:
 *
 * 1. `ProviderMediaUsageExtractor` — consumes the parsed upstream JSON
 *    response (`data[]` of `b64_json`/`url` items) and reports:
 *    - `units`: the generated image count (`data.length`);
 *    - `sizeTier`: the output-first tier (§4.2 尺寸归一化: the actual
 *      decoded image dimensions, then the provider-declared tier, then the
 *      request's declared size, then the 2k default);
 *    - token counters stay null (image generations report no tokens).
 *
 * 2. `serviceTier` — the §4.1 settlement terms: the requested tier from the
 *    request payload's `service_tier` field (the observed side stays null;
 *    OpenAI images responses do not declare a service tier), fed by the
 *    transport into the dispatch settlement input.
 *
 * The factory is bound per request by the generic transport with the signed
 * payload bytes, so the extractor closes over the request's declared size
 * without the observer's #15 seam changing shape.
 */

export const IMAGES_PROVIDER_OPERATION = 'images.generations';

/** Canonical tier cost order for picking the most conservative observed tier. */
const TIER_COST_RANK: Readonly<Record<UsageSizeTier, number>> = {
  '1k': 1,
  '2k': 2,
  '4k': 3,
  '480p': 1,
  '720p': 2,
  '1080p': 3,
  tts: 1,
  stt: 1,
  realtime: 1,
};

/** §4.2 default when neither the response nor the request pins a tier. */
const DEFAULT_IMAGE_SIZE_TIER: UsageSizeTier = '2k';

const MAX_IMAGES_PER_RESPONSE = 100;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The highest-cost tier among the observed ones (never a lower guess). */
function mostExpensiveTier(tiers: readonly UsageSizeTier[]): UsageSizeTier | null {
  let winner: UsageSizeTier | null = null;
  for (const tier of tiers) {
    if (winner === null || (TIER_COST_RANK[tier] ?? 0) > (TIER_COST_RANK[winner] ?? 0)) winner = tier;
  }
  return winner;
}

function b64JsonValue(item: Record<string, unknown>): string | null {
  const value = item.b64_json;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function dataUrlBytes(value: string): { bytes: Uint8Array } | null {
  // data:<mediatype>;base64,<payload> — image/* only, the sub2api decode
  // contract without the remote-download branch (no SSRF surface).
  if (!/^data:image\//i.test(value)) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice(5, comma);
  const parts = header.split(';');
  const mediaType = parts[0]?.trim().toLowerCase() ?? '';
  if (!/^image\/[a-z0-9.+-]{2,32}$/.test(mediaType)) return null;
  const base64 = parts.slice(1).filter((part) => part.trim().toLowerCase() === 'base64');
  if (base64.length !== 1 || parts.at(-1)?.trim().toLowerCase() !== 'base64') return null;
  try {
    return { bytes: decodeB64ImageBytes(value.slice(comma + 1)) };
  } catch {
    return null;
  }
}

/**
 * The per-request bound extractor. `requestSizeTier` is the request's
 * declared size normalized to a canonical tier (null when the request left
 * it open); decoding happens only on the final response body and is bounded
 * by the image-bytes ceiling per item.
 */
export function createImagesMediaUsageExtractor(input: {
  readonly requestSizeTier: UsageSizeTier | null;
}): ProviderMediaUsageExtractor {
  const requestSizeTier = input.requestSizeTier;
  return {
    operations: new Set([IMAGES_PROVIDER_OPERATION]),
    extract(body: Record<string, unknown>): NormalizedUsage | null {
      const data = body.data;
      if (!Array.isArray(data) || data.length === 0 || data.length > MAX_IMAGES_PER_RESPONSE) return null;
      // Untrusted error envelopes are not usage.
      if (body.error !== undefined && body.error !== null) return null;
      const observedTiers: UsageSizeTier[] = [];
      for (const item of data) {
        const entry = record(item);
        if (entry === null) return null;
        const b64 = b64JsonValue(entry);
        if (b64 !== null) {
          let bytes: Uint8Array;
          try {
            bytes = decodeB64ImageBytes(b64);
          } catch {
            // An undecodable image is an untrusted usage report.
            return null;
          }
          const tier = imageSizeTierFromDimensions(sniffImageDimensions(bytes));
          if (tier !== null) observedTiers.push(tier);
          continue;
        }
        const url = typeof entry.url === 'string' ? entry.url.trim() : '';
        if (url !== '' && url.toLowerCase().startsWith('data:')) {
          const decoded = dataUrlBytes(url);
          if (decoded === null) return null;
          const tier = imageSizeTierFromDimensions(sniffImageDimensions(decoded.bytes));
          if (tier !== null) observedTiers.push(tier);
        }
      }
      // Output-first tier selection: actual decoded dimensions win; a
      // provider-declared tier on the response comes next; then the request's
      // declared size; finally the documented 2k default.
      const responseDeclared =
        normalizeMediaSizeTier(body.size_tier ?? body.sizeTier) ??
        (typeof body.size === 'string' ? normalizeMediaSizeTier(body.size) : null);
      const sizeTier =
        mostExpensiveTier(observedTiers) ?? responseDeclared ?? requestSizeTier ?? DEFAULT_IMAGE_SIZE_TIER;
      return {
        inputTotal: null,
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: null,
        reasoningOutput: null,
        billingMode: 'image',
        units: data.length,
        sizeTier,
        status: 'reported',
        source: 'upstream',
        semanticsVersion: 'v1',
      };
    },
  };
}

/**
 * §4.2 service-tier extraction (request side): `service_tier` is the only
 * billing-relevant tier the images API accepts; invalid values are dropped
 * (never a billing guess).
 */
export function requestServiceTier(body: Record<string, unknown>): string | null {
  const value = body.service_tier;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** The request's declared image size normalized to the canonical tier. */
export function requestImageSizeTier(body: Record<string, unknown>): UsageSizeTier | null {
  const declared = body.size_tier ?? body.sizeTier;
  if (declared !== undefined && declared !== null) return normalizeMediaSizeTier(declared);
  const size = body.size;
  if (size === undefined || size === null) return null;
  return normalizeMediaSizeTier(size);
}

/**
 * Parses the signed provider payload and binds the per-request plan.
 * Returns null for any operation other than images.generations and for a
 * payload that fails to parse (the observation then stays unknown rather
 * than guessing).
 */
export function createImagesMediaUsagePlan(input: {
  readonly providerOperation: string | undefined;
  readonly payloadBytes: Uint8Array;
}): ProviderMediaUsagePlan | null {
  if (input.providerOperation !== IMAGES_PROVIDER_OPERATION) return null;
  let body: Record<string, unknown> | null = null;
  try {
    body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.payloadBytes)));
  } catch {
    body = null;
  }
  if (body === null) return null;
  const requestSizeTier = requestImageSizeTier(body);
  return {
    extractor: createImagesMediaUsageExtractor({ requestSizeTier }),
    serviceTier: { requested: requestServiceTier(body), observed: null },
  };
}
