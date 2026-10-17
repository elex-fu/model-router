import { normalizeMediaSizeTier } from '../../telemetry/usage.js';
import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from './provider-payload-compiler.js';

/**
 * §4.1 (roadmap batch 4) media usage upper-bound estimator — the
 * embeddings-usage-estimator precedent applied to per-unit work.
 *
 * Image `generations` requests bill per generated image: the unit upper
 * bound is the request's `n` (default 1, OpenAI's default when omitted) and
 * the size tier is derived from the request's `size` (longest-edge buckets
 * 1024→1k, ≤1792→2k, else 4k) or passed through when the transport already
 * selected a canonical tier (`size_tier`/`sizeTier`). Token bounds are zero:
 * image generations report no tokens, so the conservative hold is exactly
 * n × tier rate. Settlement replaces the bound with the provider-reported
 * unit count.
 *
 * The #16 image / #17 video-audio category transports feed richer
 * estimators through the same `ProviderUsageUpperBoundEstimator` seam
 * (select on `providerOperation`); this estimator covers the shared
 * image-generations shape so the billing horizontal has an end-to-end
 * producer today.
 */
export const MEDIA_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'media-usage-upper-bound/v1';

const DEFAULT_IMAGE_COUNT = 1;
const MAX_IMAGE_COUNT = 100;

function imageCountUpperBound(body: Readonly<Record<string, unknown>>): number {
  const count = body.n;
  if (count === undefined || count === null) return DEFAULT_IMAGE_COUNT;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_IMAGE_COUNT) {
    // A malformed count is a closed failure, never a silently wrong bound.
    throw new Error('the media estimator requires n to be an integer between 1 and 100');
  }
  return count;
}

export function imageSizeTierUpperBound(body: Readonly<Record<string, unknown>>): string | null {
  const declared = body.size_tier ?? body.sizeTier;
  if (declared !== undefined && declared !== null) {
    const tier = normalizeMediaSizeTier(declared);
    if (tier === null) throw new Error('the media estimator received a non-canonical size_tier');
    return tier;
  }
  const size = body.size;
  if (size === undefined || size === null) return null;
  return normalizeMediaSizeTier(size);
}

/**
 * Conservative per-unit upper bound for an image `generations` request:
 * `n` images at the request's size tier (or, when the request leaves the
 * tier open, at any tier — the conservative hold prices the max tier).
 */
export function imageUnitsUpperBound(body: Readonly<Record<string, unknown>>): number {
  return imageCountUpperBound(body);
}

export class MediaUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = MEDIA_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    /*
     * The payload operation union gains its media members with the #16/#17
     * category transports; the runtime value is already an open string at
     * the estimator seam, so the guard compares defensively.
     */
    const operation = input.normalizedRequest.providerOperation as string;
    if (operation !== 'images.generations') {
      // Miscomposition is a closed failure, never a silently wrong bound.
      throw new Error('the media estimator only serves the images.generations operation');
    }
    const body = input.normalizedRequest.body as Readonly<Record<string, unknown>>;
    const units = imageUnitsUpperBound(body);
    const sizeTier = imageSizeTierUpperBound(body);
    return {
      inputTotalUpperBound: '0',
      inputUncachedUpperBound: '0',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '0',
      reasoningOutputUpperBound: '0',
      feasibleInputBuckets: ['input'],
      perUnitUnitsUpperBound: String(units),
      ...(sizeTier === null ? {} : { sizeTier }),
    };
  }
}

export function createMediaUsageUpperBoundEstimator(): MediaUsageUpperBoundEstimator {
  return new MediaUsageUpperBoundEstimator();
}
