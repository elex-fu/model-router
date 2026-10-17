/**
 * Batch-3 Grok free-tier local soft gate (sub2api
 * backend/internal/service/grok_free_quota_gate.go semantics). A
 * subscription_tier=free OAuth account is removed from the scheduling
 * candidates once its LOCAL rolling-24h token usage reaches 95% of the
 * nominal 500k allowance; statistics failure never blocks the account
 * (fail-open: the gate exists to protect the account from hard 429 bans, not
 * to reduce capacity on missing data).
 */

import { normalizeGrokSubscriptionTier } from '../../platform/grok-oauth/oauth.js';
import { GROK_FREE_ROLLING_24H_TOKEN_LIMIT, GROK_FREE_SOFT_GATE_FRACTION } from './constants.js';

/** The soft-gate exclusion threshold in tokens (95% of the nominal limit). */
export const GROK_FREE_SOFT_GATE_TOKEN_FLOOR = Math.floor(
  GROK_FREE_ROLLING_24H_TOKEN_LIMIT * GROK_FREE_SOFT_GATE_FRACTION,
);

export type GrokFreeTierGateDecision = 'admit' | 'excluded';

export interface GrokFreeTierGateInput {
  /** Persisted subscription tier (access-token derived — the only trusted source). */
  readonly subscriptionTier: string | null;
  /**
   * Locally observed rolling-24h token usage for the account. Null means the
   * statistics are missing/unavailable — fail-open, the account is admitted.
   */
  readonly rolling24hTokens: number | null;
}

/**
 * The pure gate. Decision table:
 * - tier missing or not `free` (after normalization) → admit;
 * - tier `free` and rolling24hTokens null (statistics missing) → admit (fail-open);
 * - tier `free` and usage at or above the 95% floor → excluded;
 * - otherwise → admit.
 */
export function evaluateGrokFreeTierGate(input: GrokFreeTierGateInput): GrokFreeTierGateDecision {
  if (!input || typeof input !== 'object') return 'admit';
  const tier = input.subscriptionTier;
  if (typeof tier !== 'string' || normalizeGrokSubscriptionTier(tier) !== 'free') return 'admit';
  if (
    input.rolling24hTokens === null ||
    typeof input.rolling24hTokens !== 'number' ||
    !Number.isFinite(input.rolling24hTokens)
  ) {
    return 'admit';
  }
  return input.rolling24hTokens >= GROK_FREE_SOFT_GATE_TOKEN_FLOOR ? 'excluded' : 'admit';
}
