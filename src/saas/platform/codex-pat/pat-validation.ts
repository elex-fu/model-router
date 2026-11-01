import { buildCanonicalIdentity } from '../../gateway/codex/identity.js';

/**
 * P2c Codex personal access token (PAT, `at-*`) validation surface (sub2api
 * parity: backend/internal/service/openai_codex_pat_service.go). A PAT is a
 * first-class Codex credential: it never refreshes (the R4 refresh worker's
 * codex bindings are OAuth-only, so PAT credentials are skipped by
 * construction) and it is validated read-only through the same
 * `whoami` endpoint the Codex client uses.
 *
 * This module is pure: it builds request descriptions and parses response
 * bodies. No IO, no logging, and the token never appears in errors.
 */

/**
 * Fixed credential-plane whoami endpoint (sub2api
 * `openAICodexPATWhoamiURLDefault`). Read-only identity resolution: no
 * upstream state is mutated by a whoami call.
 */
export const CODEX_PAT_WHOAMI_URL = 'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami';

/** Bounded response body the parser accepts (sub2api uses the same 64 KiB cap). */
export const CODEX_PAT_WHOAMI_MAX_RESPONSE_BYTES = 65_536;

/** Longest personal access token accepted by `isCodexPatShape`. */
const CODEX_PAT_MAX_LENGTH = 4_096;

const CODEX_PAT_BODY = /^[A-Za-z0-9._-]+$/;

/**
 * Structural shape of a Codex personal access token: the `at-` prefix plus a
 * printable, whitespace-free body. This mirrors sub2api's prefix check while
 * rejecting bodies that could not survive an HTTP header (control chars,
 * spaces, non-ASCII).
 */
export function isCodexPatShape(token: unknown): token is string {
  if (typeof token !== 'string' || token.length < 3 || token.length > CODEX_PAT_MAX_LENGTH) return false;
  if (!token.startsWith('at-')) return false;
  return CODEX_PAT_BODY.test(token.slice(3));
}

/** Bounded non-empty text helper shared by the identity parser. */
function identityText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return null;
  return value.trim();
}

/**
 * Identity resolved from a whoami response. `chatgptAccountId` is the field
 * the dispatch envelope persists (`chatgpt_account_id`), so a PAT credential
 * rides the same codex transport as an OAuth credential; `expiresAt` is null
 * unless the endpoint reports an `expires_at` timestamp for the token.
 */
export interface CodexPatWhoamiIdentity {
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string;
  readonly email: string;
  readonly planType: string;
  readonly accountIsFedramp: boolean;
  readonly expiresAt: string | null;
}

/**
 * Parses a whoami response body. Mirrors sub2api's
 * `validateOpenAICodexPATWhoami`: `email`, `chatgpt_user_id`,
 * `chatgpt_account_id`, `chatgpt_plan_type` and the boolean
 * `chatgpt_account_is_fedramp` are all required — anything else is malformed
 * and returns null, never a partial identity.
 */
export function parseCodexPatWhoamiResponse(body: unknown): CodexPatWhoamiIdentity | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const chatgptAccountId = identityText(record.chatgpt_account_id);
  const chatgptUserId = identityText(record.chatgpt_user_id);
  const email = identityText(record.email);
  const planType = identityText(record.chatgpt_plan_type);
  if (
    chatgptAccountId === null ||
    chatgptAccountId.length === 0 ||
    chatgptUserId === null ||
    chatgptUserId.length === 0 ||
    email === null ||
    email.length === 0 ||
    planType === null ||
    planType.length === 0
  ) {
    return null;
  }
  const fedramp = record.chatgpt_account_is_fedramp;
  if (typeof fedramp !== 'boolean') return null;
  let expiresAt: string | null = null;
  if (record.expires_at !== undefined && record.expires_at !== null) {
    const raw = record.expires_at;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    expiresAt = new Date(parsed).toISOString();
  }
  return Object.freeze({
    chatgptAccountId,
    chatgptUserId,
    email,
    planType,
    accountIsFedramp: fedramp,
    expiresAt,
  });
}

/** A whoami request description: fixed URL, GET, protocol-owned headers. */
export interface CodexPatWhoamiRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Builds the credential-plane whoami request. The header set is exactly
 * sub2api's `ValidateCodexPersonalAccessToken`: bearer authorization, JSON
 * accept, and the canonical Codex identity pair (`user-agent` +
 * `originator`, deliberately without the inference-plane `version` header —
 * and never `chatgpt-account-id`, which the whoami endpoint resolves
 * itself). Returns null when the token is not a PAT shape.
 */
export function buildCodexPatWhoamiRequest(input: { readonly pat: string }): CodexPatWhoamiRequest | null {
  if (typeof input?.pat !== 'string' || !isCodexPatShape(input.pat)) return null;
  const identity = buildCanonicalIdentity();
  return {
    url: CODEX_PAT_WHOAMI_URL,
    method: 'GET',
    headers: Object.freeze({
      authorization: `Bearer ${input.pat}`,
      accept: 'application/json',
      'user-agent': identity.userAgent,
      originator: identity.originator,
    }),
  };
}
