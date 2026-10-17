/**
 * Batch-3 Grok outbound identity (pure; zero IO). Parses the sealed-envelope
 * plaintext shapes the grok category serves and derives the per-account
 * identity namespace used for conversation isolation.
 */

import type { GrokQuotaHeaderSnapshot } from './quota-headers.js';

/** The unsealed OAuth Grok account facts the transport needs (envelope subset). */
export interface GrokOAuthCredential {
  readonly kind: 'oauth';
  readonly accessToken: string;
  readonly email: string | null;
  readonly userId: string;
  readonly teamId: string | null;
  /** Snake_case subscription tier from the access-token payload; null when unparsable. */
  readonly subscriptionTier: string | null;
}

/** An xAI API key credential (plaintext ASCII token inside the envelope). */
export interface GrokApiKeyCredential {
  readonly kind: 'api-key';
  readonly apiKey: string;
}

export type GrokUpstreamCredential = GrokOAuthCredential | GrokApiKeyCredential;

export type GrokIdentityErrorCode = 'MALFORMED_CREDENTIAL' | 'MALFORMED_ACCOUNT' | 'MALFORMED_INPUT';

export class GrokIdentityError extends Error {
  constructor(readonly code: GrokIdentityErrorCode) {
    super(
      code === 'MALFORMED_CREDENTIAL'
        ? 'grok credential material is malformed'
        : code === 'MALFORMED_ACCOUNT'
          ? 'grok account coordinates are malformed'
          : 'grok identity input is malformed',
    );
    this.name = 'GrokIdentityError';
  }
}

function tokenText(value: unknown, max = 4_096): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

/**
 * Parses the OAuth Grok credential envelope plaintext (the
 * platform/grok-oauth supply-sink shape): a compact JSON object carrying at
 * least access_token, with email/user_id/team_id/subscription_tier as the
 * gateway-required metadata the refresh worker preserves across rotations.
 * Returns null when the material is not a usable OAuth grok envelope.
 */
export function parseGrokOAuthCredentialMaterial(secret: Uint8Array): GrokOAuthCredential | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  if (accessToken === null) return null;
  const userId = tokenText(record.user_id, 128) ?? tokenText(record.sub, 128);
  return {
    kind: 'oauth',
    accessToken,
    email: tokenText(record.email, 320),
    userId: userId ?? '',
    teamId: tokenText(record.team_id, 128),
    subscriptionTier: tokenText(record.subscription_tier, 64),
  };
}

/** Parses a raw ASCII API-key envelope (the api-key credential shape). */
export function parseGrokApiKeyMaterial(secret: Uint8Array): GrokApiKeyCredential | null {
  const apiKey = tokenText(new TextDecoder('utf-8', { fatal: true }).decode(secret).trim());
  return apiKey === null ? null : { kind: 'api-key', apiKey };
}

/**
 * Per-account identity namespace `grok:{teamId|userId}`. An OAuth credential
 * without either coordinate throws: an account without them must never
 * silently share a namespace with another account. API-key credentials carry
 * no identity namespace (no account-bound conversation isolation upstream).
 */
export function grokAccountIdentityNamespace(credential: GrokOAuthCredential): string {
  const scope =
    credential.teamId !== null && credential.teamId.length > 0
      ? credential.teamId
      : credential.userId.length > 0
        ? credential.userId
        : null;
  if (scope === null) throw new GrokIdentityError('MALFORMED_ACCOUNT');
  return `grok:${scope}`;
}

/**
 * The scheduling-relevant tier of one observation: the persisted subscription
 * tier wins (access-token derived at binding/refresh time — the only trusted
 * source), the response-header tier from a quota snapshot is an advisory
 * cross-check that never overrides it (sub2api: subscription_tier 只信
 * access_token).
 */
export function grokEffectiveSubscriptionTier(
  persistedTier: string | null,
  observed: Pick<GrokQuotaHeaderSnapshot, 'subscriptionTier'> | null,
): string | null {
  if (persistedTier !== null && persistedTier.trim() !== '') return persistedTier;
  return observed?.subscriptionTier ?? null;
}
