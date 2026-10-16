/**
 * F4 Gemini outbound identity (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). Pure helpers: the
 * per-account identity namespace built on the shared oauth-subscription
 * kernel (a failover never exposes one client conversation under two Gemini
 * projects), and the tier-id normalization sub2api's quota policy keys on.
 * The outbound UA is a fixed constant (constants.ts), not a per-account
 * identity signal, so this module carries no version-pin machinery.
 */

import { GEMINI_LEGACY_TIER_IDS, GEMINI_TIER_QUOTAS, type GeminiQuotaTierId } from './constants.js';

export type { GeminiQuotaTierId } from './constants.js';

export type GeminiIdentityErrorCode = 'MALFORMED_ACCOUNT';

export class GeminiIdentityError extends Error {
  constructor(readonly code: GeminiIdentityErrorCode) {
    super('gemini account coordinates are malformed');
    this.name = 'GeminiIdentityError';
  }
}

/** Gemini account coordinates carried inside the sealed credential envelope. */
export interface GeminiAccountCoordinates {
  /** The Cloud Code Assist project the v1internal dispatch wrap targets. */
  readonly projectId: string;
  /** The tier id observed from loadCodeAssist (canonical or legacy spelling). */
  readonly tierId?: string | null;
  readonly email?: string | null;
}

/**
 * Per-account identity namespace `gemini:project:{projectId}`. Empty
 * coordinates throw: an account without a project must never silently share
 * a namespace with another account.
 */
export function geminiAccountIdentityNamespace(account: GeminiAccountCoordinates): string {
  if (typeof account?.projectId !== 'string' || account.projectId.trim().length === 0) {
    throw new GeminiIdentityError('MALFORMED_ACCOUNT');
  }
  return `gemini:project:${account.projectId.trim()}`;
}

/**
 * Normalizes an upstream/legacy tier spelling onto the canonical quota-tier
 * ids. Unknown spellings (and the sentinel `google_one_unknown`) return null
 * so callers fall back to the unknown-tier cooldown instead of guessing a
 * quota class.
 */
export function normalizeGeminiTierId(rawTierId: string | null | undefined): GeminiQuotaTierId | null {
  if (typeof rawTierId !== 'string') return null;
  const trimmed = rawTierId.trim();
  if (trimmed.length === 0) return null;
  if (trimmed in GEMINI_TIER_QUOTAS) return trimmed as GeminiQuotaTierId;
  const legacy = GEMINI_LEGACY_TIER_IDS[trimmed];
  return legacy === undefined ? null : legacy;
}

/** The tier's quota policy, or null when the tier is unknown/undetectable. */
export function geminiTierQuota(
  tierId: GeminiQuotaTierId | null,
): (typeof GEMINI_TIER_QUOTAS)[GeminiQuotaTierId] | null {
  return tierId === null ? null : (GEMINI_TIER_QUOTAS[tierId] ?? null);
}

/** The tier's 429 cooldown; the unknown-tier default when the tier is unknown. */
export function geminiTierCooldownMs(tierId: GeminiQuotaTierId | null, unknownCooldownMs: number): number {
  const quota = geminiTierQuota(tierId);
  return quota === null ? unknownCooldownMs : quota.cooldownMs;
}

/**
 * Model class for per-class quota accounting (sub2api
 * geminiModelClassFromName): names containing "flash" or "lite" count against
 * the flash pool, everything else against pro.
 */
export function geminiModelClass(model: string): 'pro' | 'flash' {
  const name = typeof model === 'string' ? model.toLowerCase() : '';
  return name.includes('flash') || name.includes('lite') ? 'flash' : 'pro';
}
