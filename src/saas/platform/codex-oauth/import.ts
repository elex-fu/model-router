import type { CodexCredentialEnvelope } from './binding-service.js';
import { CODEX_OAUTH_CLIENT_ID, CodexOAuthError, codexOauthError, decodeIdTokenClaims } from './oauth.js';

/**
 * Phase 1b Codex CLI auth.json import (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.2 batch import).
 * The operator pastes the content of the Codex CLI's ~/.codex/auth.json; this
 * parser converts it to the same envelope shape the OAuth binding produces.
 * Lenient on optional fields, strict on the required ones: an import without
 * a usable refresh token or account id is rejected rather than guessed. The
 * id_token (when present) is decoded without the freshness gate — a CLI
 * snapshot legitimately carries a stale id_token while its refresh token is
 * still valid — but a contradictory account id is a hard rejection.
 */
export function parseCodexAuthJson(text: string): CodexCredentialEnvelope {
  if (typeof text !== 'string' || text.length === 0 || text.length > 65_536) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const tokens = (body as Record<string, unknown>).tokens;
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const record = tokens as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  const refreshToken = tokenText(record.refresh_token);
  const accountId = tokenText(record.account_id);
  if (accessToken === null || refreshToken === null || accountId === null) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const idToken = tokenText(record.id_token);
  let email: string | null = null;
  let chatgptUserId: string | null = null;
  let planType: string | null = null;
  if (idToken !== null) {
    try {
      const claims = decodeIdTokenClaims(idToken);
      if (claims.chatgptAccountId !== accountId) throw codexOauthError('AUTH_JSON_INVALID');
      email = claims.email;
      chatgptUserId = claims.chatgptUserId;
      planType = claims.planType;
    } catch (error) {
      if (error instanceof CodexOAuthError && error.code === 'AUTH_JSON_INVALID') throw error;
      // A stale or opaque id_token never blocks the import: the refresh
      // token is the credential and the account id is already known.
    }
  }
  return Object.freeze({
    accessToken,
    refreshToken,
    idToken,
    expiresAt: null,
    // The CLI does not record its client id in auth.json, but the refresh
    // grant must use the same public client the tokens were issued to.
    clientId: CODEX_OAUTH_CLIENT_ID,
    email,
    chatgptAccountId: accountId,
    chatgptUserId,
    planType,
  });
}

function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}
