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

/**
 * The percent floor of the snapshot-based free-tier soft gate: the same
 * GROK_FREE_SOFT_GATE_FRACTION (95%) expressed against an upstream-observed
 * window percentage.
 */
export const GROK_FREE_SOFT_GATE_PERCENT_FLOOR = GROK_FREE_SOFT_GATE_FRACTION * 100;

/**
 * Core-plan 9.1 (B06 consumption half): the scheduler-side adapter for the
 * free-tier soft gate. The account rows persisted by migration 119 (the
 * quota-header observer) carry `grok_subscription_tier` (the ONLY trusted tier
 * source) and the upstream-observed 5h token window used percent — not the
 * locally aggregated rolling-24h absolute token count the base gate models.
 * This adapter therefore applies the same soft-gate fraction against the
 * OBSERVED window percentage and keeps the whole contract fail-open:
 * a missing tier, a missing/stale snapshot, or a malformed value all admit the
 * account (the gate exists to protect the account from hard 429 bans, never
 * to reduce capacity on missing data).
 */
export interface GrokFreeTierGateSnapshotInput {
  /** The persisted `grok_subscription_tier`; null means never observed. */
  readonly subscriptionTier: string | null;
  /** The persisted `grok_5h_used_percent`; null means never observed. */
  readonly observedUsedPercent: number | null;
  /** Epoch ms of the persisted `grok_usage_updated_at`; null means never observed. */
  readonly observedAtMs: number | null;
  /** The revalidation clock (epoch ms). */
  readonly nowMs: number;
  /** Snapshot freshness bound (epoch ms); default 2h (the threshold precedent). */
  readonly maxSnapshotAgeMs?: number;
}

export function evaluateGrokFreeTierGateSnapshot(input: GrokFreeTierGateSnapshotInput): GrokFreeTierGateDecision {
  if (!input || typeof input !== 'object') return 'admit';
  if (
    input.subscriptionTier === null ||
    typeof input.subscriptionTier !== 'string' ||
    normalizeGrokSubscriptionTier(input.subscriptionTier) !== 'free'
  ) {
    return 'admit';
  }
  const maxAgeMs = input.maxSnapshotAgeMs === undefined ? 2 * 60 * 60 * 1000 : Math.max(0, input.maxSnapshotAgeMs);
  if (
    input.observedAtMs === null ||
    typeof input.observedAtMs !== 'number' ||
    !Number.isFinite(input.observedAtMs) ||
    typeof input.nowMs !== 'number' ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs - input.observedAtMs > maxAgeMs
  ) {
    return 'admit';
  }
  if (
    input.observedUsedPercent === null ||
    typeof input.observedUsedPercent !== 'number' ||
    !Number.isFinite(input.observedUsedPercent)
  ) {
    return 'admit';
  }
  return input.observedUsedPercent >= GROK_FREE_SOFT_GATE_PERCENT_FLOOR ? 'excluded' : 'admit';
}
