import { type NormalizedUsage, normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import type { ProviderMediaUsagePlan } from '../provider-http-transport.js';
import type { ProviderMediaUsageExtractor } from '../provider-json-usage-observer.js';
import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from '../provider-payload-compiler.js';

/**
 * P2-a (docs/standalone-relay-capability-plan-2026-10-30.md; sub2api
 * backend/internal/service/openai_alpha_search.go parity): the Codex
 * standalone web search surface.
 *
 * `POST /v1/alpha/search` rides the OpenAI protocol family as the
 * `alpha_search` operation (the R2 embeddings precedent) and is
 * passthrough-only onto this pinned ChatGPT Codex target, dispatched with a
 * codex OAuth account. The request and response schemas stay unbound — the
 * proxy never interprets the evolving alpha shapes, exactly like sub2api's
 * ForwardAlphaSearch.
 *
 * Billing semantics ported from sub2api: one call is one billable unit, and
 * ONLY a 2xx upstream response is a successful (billable) search. Error
 * responses pass through to the client free of charge (the generic
 * transport's non-success path never reaches the usage observer); a
 * structurally unusable 2xx body stays unknown so settlement retains the
 * hold for reconciliation instead of zero-billing.
 */

/** Pinned upstream target; the only URL the codex dispatch resolves for alpha_search. */
export const CODEX_ALPHA_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';

export const ALPHA_SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'alpha-search-usage-upper-bound/v1';

/** The provider operation this module serves (the registry's true identity). */
export const ALPHA_SEARCH_PROVIDER_OPERATION = 'alpha_search';

/** Operations the per-call media extractor serves (the §4.1 seam's key set). */
export const ALPHA_SEARCH_PROVIDER_OPERATIONS: ReadonlySet<string> = Object.freeze(
  new Set([ALPHA_SEARCH_PROVIDER_OPERATION]),
);

/**
 * sub2api openAIAlphaSearchUnsupportedBodyFields: alpha/search is its own
 * SearchRequest protocol, not a /responses sub-request. Newer Codex clients
 * and third-party proxies may forward Responses-common fields; the ChatGPT
 * alpha endpoint rejects them ("Unknown parameter", e.g. prompt_cache_key),
 * so the boundary strips exactly this documented set before the body is
 * signed. Every other field rides opaque passthrough.
 */
const UNSUPPORTED_BODY_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set(['prompt_cache_key', 'prompt_cache_retention', 'store']),
);

/**
 * Strips the Responses-only fields an alpha/search body must never carry
 * (sub2api sanitizeOpenAIAlphaSearchBody). The input is the already-validated
 * client body record; an unchanged body returns the same reference so the
 * compiled payload bytes stay byte-identical to the passthrough contract.
 */
export function sanitizeAlphaSearchBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  let changed = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (UNSUPPORTED_BODY_FIELDS.has(key)) {
      changed = true;
      continue;
    }
    sanitized[key] = value;
  }
  return changed ? sanitized : (body as Record<string, unknown>);
}

/**
 * sub2api billing classification: only a 2xx upstream response is one
 * successful (billable) search call. Errors and redirects pass through to
 * the client without producing usage.
 */
export function isSuccessfulAlphaSearchStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The exact usage shape of one completed search call: one per-request unit
 * (sub2api's WebSearchCalls=1) with neutral token counters — the same
 * convention the §4.3 web_search/x_search settlement uses.
 */
export function alphaSearchBilling(body?: Readonly<Record<string, unknown>>): NormalizedUsage {
  // The body is deliberately not inspected: one call is one unit regardless
  // of the (unbound, evolving) request shape. Kept in the signature to
  // mirror the estimator/observer input contract.
  void body;
  return normalizeUsage('openai', { billing_mode: 'per_request', units: 1 });
}

/**
 * Per-call admission hold (the embeddings-usage-estimator precedent applied
 * to per-call work): the upper bound is exactly one unit, no tier, no token
 * counters. Settlement replaces the bound with the observed per-call usage.
 */
export class AlphaSearchUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = ALPHA_SEARCH_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    const operation = input.normalizedRequest.providerOperation as string;
    if (!ALPHA_SEARCH_PROVIDER_OPERATIONS.has(operation)) {
      // Miscomposition is a closed failure, never a silently wrong bound.
      throw new Error('the alpha search estimator only serves the alpha_search operation');
    }
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
      // One call, one unit; the flat per-call rate prices the hold.
      perUnitUnitsUpperBound: '1',
    };
  }
}

export function createAlphaSearchUsageUpperBoundEstimator(): AlphaSearchUsageUpperBoundEstimator {
  return new AlphaSearchUsageUpperBoundEstimator();
}

/**
 * Media-usage extractor for the alpha_search operation (the §4.1
 * ProviderMediaUsageExtractor seam): the observer consults it only on the
 * 2xx JSON response branch, so reaching here already means one successful
 * search call. A JSON object without an error envelope yields the per-call
 * usage; anything else yields null (unknown → the settlement retains the
 * hold, never zero-bills).
 */
export class AlphaSearchMediaUsageExtractor implements ProviderMediaUsageExtractor {
  readonly operations = ALPHA_SEARCH_PROVIDER_OPERATIONS;

  extract(body: Record<string, unknown>): NormalizedUsage | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.error !== undefined && body.error !== null) return null;
    return alphaSearchBilling(body);
  }
}

export function createAlphaSearchMediaUsageExtractor(): AlphaSearchMediaUsageExtractor {
  return new AlphaSearchMediaUsageExtractor();
}

/** The settlement-side observed usage of one completed alpha search call. */
export function observedAlphaSearchCallUsage(): NormalSuccessObservedUsage {
  const usage = alphaSearchBilling();
  if (usage.status !== 'reported') {
    throw new Error('alpha search call usage is incomplete');
  }
  return Object.freeze({ ...usage, source: 'upstream' });
}

/**
 * The alpha_search media usage plan for the codex provider HTTP transport
 * (the §4.2 mediaUsagePlan seam, the websearch/usage-plan precedent). Binds
 * the per-call extractor; alpha search responses carry no provider-declared
 * service tier, so the serviceTier side stays null.
 */
export function createAlphaSearchMediaUsagePlan(input: {
  readonly providerOperation: string | undefined;
  readonly payloadBytes: Uint8Array;
}): ProviderMediaUsagePlan | null {
  if (input.providerOperation === undefined || !ALPHA_SEARCH_PROVIDER_OPERATIONS.has(input.providerOperation)) {
    return null;
  }
  return { extractor: new AlphaSearchMediaUsageExtractor(), serviceTier: null };
}
