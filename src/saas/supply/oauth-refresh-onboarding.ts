import {
  OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS,
  oauthRefreshSuccessDelayMs,
  resolveOauthTokenAdapter,
} from './oauth-token-refresh-worker.js';

/**
 * Track #18a OAuth credential onboarding (design:
 * docs/remaining-capability-plan-2026-10-11.md R4; migration 094). Pure
 * scheduling decisions for the supply write paths; no I/O, no KMS, no token
 * material leaves this module.
 *
 * Binding key decision: a credential is OAuth-refreshable exactly when the R4
 * worker's fixed adapter registry binds its (provider, product, credential
 * type) triple — the same triple list the worker's due scan matches. Reusing
 * resolveOauthTokenAdapter keeps onboarding fail-closed and identical to the
 * worker's eligibility: a bare credential-type constant could initialize rows
 * the worker can never refresh (unregistered provider/product pairs), leaving
 * past-due schedules nothing would consume.
 *
 * Delay semantic decision: the first refresh is scheduled exactly like every
 * worker-driven re-schedule — expires_in x 0.8 with the deterministic
 * credential-keyed +/-10% jitter and the 60s floor — so there is one delay
 * semantic in the system. Material without a usable expires_in falls back to
 * the worker's default 1h token TTL. Malformed expires_in never blocks
 * creation or rotation; it degrades to that same default.
 */

export interface OauthRefreshSchedule {
  /** Absolute timestamp for oauth_next_refresh_at (ISO 8601, injected clock). */
  readonly nextRefreshAt: string;
}

/** True iff the R4 fixed adapter registry binds this exact credential triple. */
export function isOauthRefreshBoundCredential(credential: {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
}): boolean {
  return resolveOauthTokenAdapter(credential) !== null;
}

/**
 * Validated expires_in extraction from candidate OAuth material: a positive
 * safe-integer number of seconds (digit strings accepted, mirroring the
 * worker's token-response parser), capped at the worker's maximum. Anything
 * else — absent, non-JSON, wrong type, zero, negative, fractional, over the
 * cap — yields null, the default-TTL fallback. Never throws, never blocks.
 */
export function extractOauthMaterialExpiresInSeconds(secret: Uint8Array): number | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).expires_in;
  if (raw === undefined) return null;
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS) return null;
  return parsed;
}

/**
 * The first refresh schedule for newly installed OAuth material, computed
 * against the caller's injected clock. Callers gate on
 * isOauthRefreshBoundCredential; this function always schedules.
 */
export function oauthRefreshScheduleFromMaterial(
  secret: Uint8Array,
  credentialId: string,
  now: Date,
): OauthRefreshSchedule {
  const delayMs = oauthRefreshSuccessDelayMs(credentialId, extractOauthMaterialExpiresInSeconds(secret));
  return { nextRefreshAt: new Date(now.getTime() + delayMs).toISOString() };
}
