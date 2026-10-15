import { createHash, randomBytes } from 'node:crypto';

/**
 * Shared OAuth-subscription PKCE + id_token helpers (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Extracted from
 * the codex OAuth package (platform/codex-oauth/oauth.ts) and parameterized:
 * the Codex CLI uses a 64-byte hex verifier (128 chars) while the Claude CLI
 * uses a 32-byte base64url verifier (43 chars), and each provider pins its
 * own authorize endpoint / client / scopes. The codex package re-exports the
 * hex shape behind its original API; the Claude OAuth package uses the
 * base64url shape. Everything here is a public-client flow (RFC 6749 §2.1):
 * no confidential material exists in this module.
 */

export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** S256 code challenge for an ASCII verifier (RFC 7636). */
export function computePkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

export interface PkcePair {
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly codeChallenge: string;
}

export interface CreatePkcePairOptions {
  /** Random bytes behind the verifier; the codex CLI shape is 64, Claude 32. */
  readonly verifierBytes?: number;
  /** Verifier encoding; hex yields 2× bytes chars, base64url ~4/3×. */
  readonly verifierEncoding?: 'hex' | 'base64url';
}

/** PKCE pair in the requesting client's verifier shape. */
export function createPkcePair(options: CreatePkcePairOptions = {}): PkcePair {
  const bytes = options.verifierBytes ?? 64;
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 256) {
    throw new RangeError('verifierBytes must be between 32 and 256');
  }
  const encoding = options.verifierEncoding ?? 'hex';
  const codeVerifier =
    encoding === 'hex' ? randomBytes(bytes).toString('hex') : randomBytes(bytes).toString('base64url');
  return { codeVerifier, codeChallenge: computePkceChallenge(codeVerifier) };
}

export interface PkceAuthorizeUrlInput {
  readonly endpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  /** Provider-specific extra query parameters (e.g. the codex simplified-flow marker). */
  readonly extraParams?: Readonly<Record<string, string>>;
}

/** The authorize URL the platform operator opens in a local browser. */
export function buildPkceAuthorizeUrl(input: PkceAuthorizeUrlInput): URL {
  const url = new URL(input.endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scope);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

export type PkceErrorCode = 'PKCE_INVALID' | 'ID_TOKEN_MALFORMED';

export class PkceError extends Error {
  constructor(readonly code: PkceErrorCode) {
    super(code === 'PKCE_INVALID' ? 'The PKCE challenge is invalid' : 'The id_token is malformed');
    this.name = 'PkceError';
  }
}

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes the payload segment of a JWT-shaped id_token WITHOUT verifying its
 * signature: the token arrived over the direct TLS token-endpoint response,
 * not from an untrusted audience. Structural failures throw
 * `PkceError('ID_TOKEN_MALFORMED')`.
 */
export function decodeIdTokenPayload(idToken: string): Record<string, unknown> {
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL_SEGMENT.test(segment))) {
    throw new PkceError('ID_TOKEN_MALFORMED');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new PkceError('ID_TOKEN_MALFORMED');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PkceError('ID_TOKEN_MALFORMED');
  }
  return payload as Record<string, unknown>;
}

/** The id_token `exp` claim in epoch milliseconds, or null when absent/invalid. */
export function idTokenExpiresAtMs(payload: Record<string, unknown>): number | null {
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
  return Math.round(exp * 1_000);
}
