import type { ClaudeCredentialEnvelope } from './binding-service.js';
import { CLAUDE_OAUTH_CLIENT_ID, ClaudeOAuthError, claudeOauthError } from './oauth.js';

/**
 * R5 Claude CLI ~/.claude/.credentials.json import (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). The operator
 * pastes the content of the Claude Code CLI's credentials file; this parser
 * converts it to the same envelope shape the OAuth binding produces.
 *
 * Accepted shape (the CLI's `claudeAiOauth` object, camelCase keys; the
 * snake_case spellings are accepted as a lenient variant):
 *
 * ```json
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "...",
 *     "refreshToken": "...",
 *     "expiresAt": 1750000000000,
 *     "scopes": ["user:inference", "..."],
 *     "organizationUuid": "..."
 *   }
 * }
 * ```
 *
 * Lenient on optional fields, strict on the required ones: an import without
 * a usable refresh token is rejected rather than guessed. `expiresAt` is a
 * millisecond epoch (the CLI shape); `expireAt` is accepted as an alias.
 */
export function parseClaudeCredentialsJson(text: string): ClaudeCredentialEnvelope {
  if (typeof text !== 'string' || text.length === 0 || text.length > 65_536) {
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }
  const oauth = (body as Record<string, unknown>).claudeAiOauth;
  if (oauth === null || typeof oauth !== 'object' || Array.isArray(oauth)) {
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }
  const record = oauth as Record<string, unknown>;
  const accessToken = tokenText(record.accessToken ?? record.access_token);
  const refreshToken = tokenText(record.refreshToken ?? record.refresh_token);
  if (accessToken === null || refreshToken === null) {
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }
  const organizationUuid = printableText(record.organizationUuid ?? record.organization_uuid, 128);
  const accountUuid = printableText(record.accountUuid ?? record.account_uuid, 128);
  const email = printableText(record.emailAddress ?? record.email_address, 320);
  if (organizationUuid === null) {
    // The identity namespace requires organization coordinates; the refresh
    // grant alone cannot recover them. Fail closed rather than guess.
    throw claudeOauthError('CREDENTIALS_JSON_INVALID');
  }

  let expiresAt: string | null = null;
  const rawExpiry = record.expiresAt ?? record.expireAt ?? record.expires_at;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    const parsed = typeof rawExpiry === 'number' ? rawExpiry : Number(rawExpiry);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) {
      throw claudeOauthError('CREDENTIALS_JSON_INVALID');
    }
    expiresAt = new Date(parsed).toISOString();
  }

  return Object.freeze({
    accessToken,
    refreshToken,
    expiresAt,
    // The CLI does not record its client id in credentials.json, but the
    // refresh grant must use the same public client the tokens were issued to.
    clientId: CLAUDE_OAUTH_CLIENT_ID,
    organizationUuid,
    accountUuid,
    email,
  });
}

/** Re-exported so callers can narrow import failures without importing oauth.ts. */
export { ClaudeOAuthError };

function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function printableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}
