import type { NormalizedUsage } from '../../../telemetry/usage.js';
import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import type { ProviderMediaUsageExtractor } from '../provider-json-usage-observer.js';
import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from '../provider-payload-compiler.js';
import type { SearchKind } from './emulation.js';

/**
 * §4.3 (task #17) search billing: one search call is one billable unit.
 *
 * - Estimator (admission hold): the per-call upper bound is exactly one
 *   unit, no tier, no token counters. The customer price version carries a
 *   flat `per_unit` rate (the sub2api SearchCount / per-call price).
 * - Extractor (settlement): the provider's Responses body does not express
 *   the search call count (token usage is the search model's internal
 *   cost, not the customer's bill), so a structurally usable response
 *   extracts exactly one per-call unit — `billingMode: 'per_request'`.
 *
 * Billing identity note (sub2api handler/gateway_web_search.go
 * `web_search:<uuid>`): the billing idempotency key must be unique per
 * call; query-derived identity would collapse repeated identical searches
 * into one charge. This gateway's settlement identity is the per-request
 * request/attempt pair (unique per HTTP call by construction), so the
 * uniqueness property holds without a synthetic id — the operation set is
 * what marks the call as per-call billed.
 */

export const SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'search-usage-upper-bound/v1';

export const SEARCH_PROVIDER_OPERATIONS: ReadonlySet<string> = Object.freeze(new Set(['web_search', 'x_search']));

function isSearchOperation(operation: string): operation is SearchKind {
  return SEARCH_PROVIDER_OPERATIONS.has(operation);
}

function assertSearchOperation(operation: string): void {
  if (!isSearchOperation(operation)) {
    // Miscomposition is a closed failure, never a silently wrong bound.
    throw new Error('the search estimator only serves the web_search/x_search operations');
  }
}

/** The exact usage shape of one completed search call (one per-call unit). */
export function searchCallUsage(): NormalizedUsage {
  return normalizeUsage('openai', { billing_mode: 'per_request', units: 1 });
}

export class SearchUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    const operation = input.normalizedRequest.providerOperation as string;
    assertSearchOperation(operation);
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
      // One call, one unit; the flat per_unit rate is the per-call price.
      perUnitUnitsUpperBound: '1',
    };
  }
}

export function createSearchUsageUpperBoundEstimator(): SearchUsageUpperBoundEstimator {
  return new SearchUsageUpperBoundEstimator();
}

/**
 * Media-usage extractor for the search operations (the §4.1
 * ProviderMediaUsageExtractor seam): a structurally usable provider body
 * (a Responses output array without an error envelope) yields one
 * per-request unit; anything else yields null (unknown usage → the
 * settlement retains the hold for reconciliation, never zero-bills).
 */
export class SearchMediaUsageExtractor implements ProviderMediaUsageExtractor {
  readonly operations = SEARCH_PROVIDER_OPERATIONS;

  extract(body: Record<string, unknown>): NormalizedUsage | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.error !== undefined && body.error !== null) return null;
    if (!Array.isArray(body.output)) return null;
    return searchCallUsage();
  }
}

export function createSearchMediaUsageExtractor(): SearchMediaUsageExtractor {
  return new SearchMediaUsageExtractor();
}

/** The settlement-side observed usage of one completed search call. */
export function observedSearchCallUsage(): NormalSuccessObservedUsage {
  const usage = searchCallUsage();
  if (usage.status !== 'reported') {
    throw new Error('search call usage is incomplete');
  }
  return Object.freeze({ ...usage, source: 'upstream' });
}
