import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from './provider-payload-compiler.js';

/**
 * R2 embeddings usage upper-bound estimator.
 *
 * Embeddings requests produce input tokens only: the text (or pre-tokenized
 * id vectors) sent in the OpenAI `input` field is billed with the model's
 * input rate and there is no output, so the hold reserves
 * `{ inputUpperBound, outputUpperBound: 0, feasibleInputBuckets: ['input'] }`.
 *
 * The bound is deliberately coarse and safe: plain text is bounded by
 * characters / 4 (the plan's upper-bound heuristic), pre-tokenized id
 * vectors are counted per id, and mixed arrays sum per-element bounds.
 * Settlement always replaces the bound with the provider-reported
 * `usage.prompt_tokens`.
 *
 * Register this estimator where the composition's other per-operation
 * estimators register (the gateway runtime module's `providerPayload`
 * options), selecting it for `providerOperation === 'embeddings'`.
 */
export const EMBEDDINGS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'embeddings-usage-upper-bound/v1';

function ceilDiv4(length: number): number {
  return Math.ceil(length / 4);
}

function elementUpperBound(element: unknown): number {
  if (typeof element === 'string') return ceilDiv4(element.length);
  if (typeof element === 'number') return 1;
  if (Array.isArray(element) && element.every((item) => typeof item === 'number')) return element.length;
  return 4;
}

/**
 * A conservative token upper bound for the OpenAI embeddings `input` value.
 * Text is bounded by characters / 4; arrays of numbers (token ids) are
 * counted exactly; anything else contributes a small per-element floor.
 */
export function embeddingsInputTokenUpperBound(input: unknown): number {
  if (typeof input === 'string') return ceilDiv4(input.length);
  if (Array.isArray(input)) {
    // A flat array of numbers is a pre-tokenized id vector: one token per id.
    if (input.length > 0 && input.every((element) => typeof element === 'number')) return input.length;
    return input.reduce((total, element) => total + elementUpperBound(element), 0);
  }
  return 0;
}

export class EmbeddingsUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = EMBEDDINGS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    if (input.normalizedRequest.providerOperation !== 'embeddings') {
      // Miscomposition is a closed failure, never a silently wrong bound.
      throw new Error('the embeddings estimator only serves the embeddings operation');
    }
    const body = input.normalizedRequest.body as Readonly<Record<string, unknown>>;
    const inputUpperBound = embeddingsInputTokenUpperBound(body.input);
    const bound = String(inputUpperBound);
    return {
      inputTotalUpperBound: bound,
      inputUncachedUpperBound: bound,
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '0',
      reasoningOutputUpperBound: '0',
      feasibleInputBuckets: ['input'],
    };
  }
}

export function createEmbeddingsUsageUpperBoundEstimator(): EmbeddingsUsageUpperBoundEstimator {
  return new EmbeddingsUsageUpperBoundEstimator();
}

/**
 * Composition helper: selects the embeddings estimator for embeddings
 * traffic, the video estimator for the §4.3 video create family, and the
 * default estimator for everything else, so a runtime module can keep one
 * `providerPayload.estimator` dependency.
 */
export function selectUsageUpperBoundEstimatorByOperation(options: {
  readonly default: ProviderUsageUpperBoundEstimator;
  readonly embeddings?: ProviderUsageUpperBoundEstimator;
  /** §4.3 (task #17): the videos.* create operations' per-unit hold estimator. */
  readonly videos?: ProviderUsageUpperBoundEstimator;
}): ProviderUsageUpperBoundEstimator {
  const embeddings = options.embeddings ?? createEmbeddingsUsageUpperBoundEstimator();
  const videos = options.videos ?? null;
  return {
    version: `${options.default.version}+${embeddings.version}${videos === null ? '' : `+${videos.version}`}`,
    estimate(input) {
      if (input.normalizedRequest.providerOperation === 'embeddings') {
        return embeddings.estimate(input);
      }
      if (
        videos !== null &&
        (input.normalizedRequest.providerOperation === 'videos.generations' ||
          input.normalizedRequest.providerOperation === 'videos.edits' ||
          input.normalizedRequest.providerOperation === 'videos.extensions')
      ) {
        return videos.estimate(input);
      }
      return options.default.estimate(input);
    },
  };
}
