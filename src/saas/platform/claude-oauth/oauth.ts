import { createHash, timingSafeEqual } from 'node:crypto';
import {
  buildPkceAuthorizeUrl,
  type PkceAuthorizeUrlInput,
  createPkcePair as sharedCreatePkcePair,
} from '../../gateway/oauth-subscription/pkce.js';

/**
 * R5 Claude OAuth account binding constants (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5; sub2api's
 * backend/internal/pkg/oauth/oauth.go). These are the empirically verified
 * public Claude Code OAuth constants: a public RFC 6749 §2.1 client (the
 * client id is not a secret), the claude.com authorize endpoint, the
 * platform.claude.com token endpoint and its OAuth code callback redirect.
 * The token exchange is a JSON POST (not form-urlencoded) and the response
 * carries `organization.uuid` plus `account{uuid,email_address}`. Nothing in
 * this module is confidential.
 */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_ENDPOINT = 'https://claude.com/cai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** Browser-flow scopes (the plan's full tier, including user:inference). */
export const CLAUDE_OAUTH_AUTH_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
/** Internal-API scopes (org:create_api_key is not supported there). */
export const CLAUDE_OAUTH_API_SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
/** Setup-token tier: inference only. */
export const CLAUDE_OAUTH_INFERENCE_SCOPES = 'user:inference';
/** Refresh grants send no scope: the original grant's scopes persist. */
export const CLAUDE_OAUTH_REFRESH_SCOPE = null;
/** Canonical outbound UA for the token exchange (sub2api's captured client). */
export const CLAUDE_OAUTH_TOKEN_USER_AGENT = 'axios/1.13.6';
/** Organization listing endpoint for the sessionKey-cookie resolution flow. */
export const CLAUDE_ORGANIZATIONS_ENDPOINT = 'https://claude.ai/api/organizations';

export type ClaudeOauthErrorCode =
  | 'STATE_INVALID'
  | 'PKCE_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'CODE_INVALID'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'ORGANIZATION_RESOLUTION_FAILED'
  | 'CREDENTIALS_JSON_INVALID';

const ERROR_MESSAGES: Record<ClaudeOauthErrorCode, string> = {
  STATE_INVALID: 'The binding state is invalid',
  PKCE_INVALID: 'The PKCE challenge is invalid',
  SESSION_NOT_FOUND: 'The Claude OAuth binding session is unknown or already consumed',
  SESSION_EXPIRED: 'The Claude OAuth binding session has expired',
  CODE_INVALID: 'The authorization code is invalid',
  TOKEN_EXCHANGE_FAILED: 'The Claude token endpoint rejected the exchange',
  TOKEN_RESPONSE_INVALID: 'The Claude token response is invalid',
  ORGANIZATION_RESOLUTION_FAILED: 'The Claude organization could not be resolved',
  CREDENTIALS_JSON_INVALID: 'The Claude credentials.json payload is invalid',
};

export class ClaudeOAuthError extends Error {
  constructor(readonly code: ClaudeOauthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ClaudeOAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function claudeOauthError(code: ClaudeOauthErrorCode): ClaudeOAuthError {
  return new ClaudeOAuthError(code);
}

/** Constant-time equality for non-secret session state values (hash-then-compare). */
export function constantTimeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export interface ClaudePkcePair {
  /** 32 random bytes as 43 base64url characters (the Claude CLI shape). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly codeChallenge: string;
}

/** PKCE pair in the Claude CLI's 43-char base64url verifier shape. */
export function createPkcePair(): ClaudePkcePair {
  return sharedCreatePkcePair({ verifierBytes: 32, verifierEncoding: 'base64url' });
}

export interface ClaudeAuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

/** The authorize URL the platform operator opens in a local browser. */
export function buildAuthorizeUrl(input: ClaudeAuthorizeUrlInput): URL {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
    throw claudeOauthError('STATE_INVALID');
  }
  if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw claudeOauthError('PKCE_INVALID');
  }
  const shared: PkceAuthorizeUrlInput = {
    endpoint: CLAUDE_OAUTH_AUTHORIZE_ENDPOINT,
    clientId: CLAUDE_OAUTH_CLIENT_ID,
    redirectUri: CLAUDE_OAUTH_REDIRECT_URI,
    scope: CLAUDE_OAUTH_AUTH_SCOPES,
    state: input.state,
    codeChallenge: input.codeChallenge,
  };
  return buildPkceAuthorizeUrl(shared);
}

/** Organization facts from the sessionKey-cookie organization listing. */
export interface ClaudeOrganizationEntry {
  readonly uuid: string;
  readonly name: string | null;
  /** null for personal orgs; "team" for team organizations. */
  readonly ravenType: string | null;
}

/**
 * Organization selection over the /api/organizations listing: a single org
 * wins outright; with several, a team org is preferred, else the first.
 * Mirrors sub2api's GetOrganizationUUID.
 */
export function selectClaudeOrganization(entries: readonly ClaudeOrganizationEntry[]): ClaudeOrganizationEntry | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  return entries.find((entry) => entry.ravenType === 'team') ?? entries[0];
}

/** Parses the /api/organizations response body. */
export function parseClaudeOrganizations(body: unknown): ClaudeOrganizationEntry[] {
  if (!Array.isArray(body)) return [];
  const entries: ClaudeOrganizationEntry[] = [];
  for (const item of body) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.uuid !== 'string' || record.uuid.length === 0) continue;
    entries.push({
      uuid: record.uuid,
      name: typeof record.name === 'string' ? record.name : null,
      ravenType: typeof record.raven_type === 'string' ? record.raven_type : null,
    });
  }
  return entries;
}

export type ClaudeOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Resolves the organization UUID through the claude.ai session cookie: the
 * operator's browser session lists their organizations; a single org wins,
 * a team org is preferred otherwise. The sessionKey never leaves this call.
 */
export async function resolveClaudeOrganizationUuid(
  sessionKey: string,
  fetcher: ClaudeOauthFetch = (url, init) => fetch(url, init),
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0 || sessionKey.length > 4_096) {
    throw claudeOauthError('ORGANIZATION_RESOLUTION_FAILED');
  }
  let response: Response;
  try {
    response = await fetcher(new URL(CLAUDE_ORGANIZATIONS_ENDPOINT), {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: `sessionKey=${sessionKey}`,
        'user-agent': CLAUDE_OAUTH_TOKEN_USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw claudeOauthError('ORGANIZATION_RESOLUTION_FAILED');
  }
  if (response.status < 200 || response.status >= 300) {
    try {
      void response.body?.cancel();
    } catch {
      // The body is neither consumed nor surfaced.
    }
    throw claudeOauthError('ORGANIZATION_RESOLUTION_FAILED');
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > 65_536) throw new Error('too large');
    body = JSON.parse(text);
  } catch {
    throw claudeOauthError('ORGANIZATION_RESOLUTION_FAILED');
  }
  const selected = selectClaudeOrganization(parseClaudeOrganizations(body));
  if (selected === null) throw claudeOauthError('ORGANIZATION_RESOLUTION_FAILED');
  return selected.uuid;
}
