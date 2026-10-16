import { normalizeGeminiTierId } from '../../gateway/gemini/identity.js';
import type { GeminiCredentialEnvelope } from './binding-service.js';
import { GEMINI_OAUTH_CLIENT_ID, GeminiOAuthError, geminiOauthError } from './oauth.js';

/**
 * F4 Gemini CLI ~/.gemini/oauth_creds.json import (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). The operator
 * pastes the content of the Gemini CLI's OAuth credentials file; this parser
 * converts it to the same envelope shape the OAuth binding produces.
 *
 * Accepted shape (the CLI's flattened golang oauth2 token JSON, snake_case
 * keys; the camelCase spellings are accepted as a lenient variant):
 *
 * ```json
 * {
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "token_type": "Bearer",
 *   "scope": "https://www.googleapis.com/auth/cloud-platform ...",
 *   "id_token": "...",
 *   "expiry_date": 1750000000000,
 *   "project_id": "..."
 * }
 * ```
 *
 * Lenient on optional fields, strict on the required ones: an import without
 * a usable refresh token is rejected rather than guessed, and so is one
 * without a project_id — the v1internal dispatch wrap requires the Cloud
 * Code Assist project and the refresh grant alone cannot recover it
 * (fail-closed, mirroring the claude import's organization requirement).
 * `expiry_date` is a millisecond epoch (the CLI shape).
 */
export function parseGeminiCredentialsJson(text: string): GeminiCredentialEnvelope {
  if (typeof text !== 'string' || text.length === 0 || text.length > 65_536) {
    throw geminiOauthError('CREDENTIALS_JSON_INVALID');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw geminiOauthError('CREDENTIALS_JSON_INVALID');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw geminiOauthError('CREDENTIALS_JSON_INVALID');
  }
  const record = body as Record<string, unknown>;
  const accessToken = tokenText(record.access_token ?? record.accessToken);
  const refreshToken = tokenText(record.refresh_token ?? record.refreshToken);
  if (accessToken === null || refreshToken === null) {
    throw geminiOauthError('CREDENTIALS_JSON_INVALID');
  }
  const projectId = printableText(record.project_id ?? record.projectId, 128);
  if (projectId === null) {
    // The v1internal dispatch wrap requires the Code Assist project; the
    // refresh grant cannot recover it. Fail closed rather than guess.
    throw geminiOauthError('CREDENTIALS_JSON_INVALID');
  }
  const rawTier = record.tier_id ?? record.tierId;
  const tierId = rawTier === undefined || rawTier === null ? null : normalizeGeminiTierId(printableText(rawTier, 64));
  const email = printableText(record.email ?? record.email_address, 320);

  let expiresAt: string | null = null;
  const rawExpiry = record.expiry_date ?? record.expiryDate ?? record.expires_at;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    const parsed = typeof rawExpiry === 'number' ? rawExpiry : Number(rawExpiry);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) {
      throw geminiOauthError('CREDENTIALS_JSON_INVALID');
    }
    expiresAt = new Date(parsed).toISOString();
  }

  return Object.freeze({
    accessToken,
    refreshToken,
    expiresAt,
    // The CLI does not record its client id in oauth_creds.json, but the
    // refresh grant must use the same public client the tokens were issued to.
    clientId: GEMINI_OAUTH_CLIENT_ID,
    projectId,
    tierId,
    email,
  });
}

/** Re-exported so callers can narrow import failures without importing oauth.ts. */
export { GeminiOAuthError };

function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function printableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) return null;
  return value.trim();
}
