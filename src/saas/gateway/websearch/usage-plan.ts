import type { ProviderMediaUsagePlan } from '../provider-http-transport.js';
import { SEARCH_PROVIDER_OPERATIONS, SearchMediaUsageExtractor } from './usage.js';

/**
 * §4.3 (task #17): the web_search/x_search media usage plan for the generic
 * provider HTTP transport (the §4.2 mediaUsagePlan seam). Binds the per-call
 * extractor; search responses carry no provider-declared service tier, so
 * the serviceTier side stays null.
 */
export function createSearchMediaUsagePlan(input: {
  readonly providerOperation: string | undefined;
  readonly payloadBytes: Uint8Array;
}): ProviderMediaUsagePlan | null {
  if (input.providerOperation === undefined || !SEARCH_PROVIDER_OPERATIONS.has(input.providerOperation)) {
    return null;
  }
  return { extractor: new SearchMediaUsageExtractor(), serviceTier: null };
}
