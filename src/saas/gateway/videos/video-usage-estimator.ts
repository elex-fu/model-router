import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from '../provider-payload-compiler.js';
import { videoHoldSizeTier, videoHoldUnitsUpperBound } from './video-billing.js';

/**
 * Roadmap batch 4 §4.3 (task #17) video usage upper-bound estimator — the
 * per-unit media estimator (§4.1) applied to the video create family.
 *
 * The hold for one async create is the conservative family maximum:
 * `MAX_VIDEO_DURATION_SECONDS (15) × n` per-unit (second) units at the
 * request's resolution tier (480p default). The request's own `duration`
 * is deliberately NOT the bound — the upstream has not confirmed the
 * rendered duration yet, and the deferred settlement replaces the bound
 * with the observed `video.duration` (× count) once a status poll sees
 * the completed video.
 *
 * A malformed `n` (non-integer, < 1, > 10) is a closed failure, never a
 * silently wrong hold; a malformed `resolution` falls to the 480p default
 * (the documented upstream default — the same value the create-time
 * snapshot stores).
 */
export const VIDEO_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'video-usage-upper-bound/v1';

/** The video create operations this estimator serves (server-owned, path-derived). */
export const VIDEO_PROVIDER_OPERATIONS = ['videos.generations', 'videos.edits', 'videos.extensions'] as const;

export type VideoProviderOperation = (typeof VIDEO_PROVIDER_OPERATIONS)[number];

const VIDEO_OPERATION_SET: ReadonlySet<string> = new Set(VIDEO_PROVIDER_OPERATIONS as readonly string[]);

export function isVideoProviderOperation(value: unknown): value is VideoProviderOperation {
  return typeof value === 'string' && VIDEO_OPERATION_SET.has(value);
}

export class VideoUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = VIDEO_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    const operation = input.normalizedRequest.providerOperation as string;
    if (!isVideoProviderOperation(operation)) {
      // Miscomposition is a closed failure, never a silently wrong bound.
      throw new Error('the video estimator only serves the videos.* operations');
    }
    const body = input.normalizedRequest.body as Readonly<Record<string, unknown>>;
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
      perUnitUnitsUpperBound: String(videoHoldUnitsUpperBound(body)),
      sizeTier: videoHoldSizeTier(body),
    };
  }
}

export function createVideoUsageUpperBoundEstimator(): VideoUsageUpperBoundEstimator {
  return new VideoUsageUpperBoundEstimator();
}
