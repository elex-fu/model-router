/**
 * Shared OAuth-subscription upstream error classification (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Moved verbatim
 * from the codex package (gateway/codex/health.ts) — the decision matrix is
 * category-agnostic: the gateway transport calls `classifyUpstreamError` on
 * every non-2xx (and stream-aborting) response and writes the resulting kind
 * into the runtime-health store (040); `shouldFailover` decides whether the
 * in-flight request should be retried on another account. The codex package
 * re-exports these under its original type aliases.
 *
 * Matrix (first match wins):
 * - 401 with `token_invalidated` / `token_revoked` / `Unauthorized` in the
 *   body ⇒ `auth-revoked` (permanent; the token was explicitly killed).
 * - 401 otherwise ⇒ `auth-expired` (refresh token + temporary unschedulable).
 * - 403 with an HTML body or a Cloudflare `code 1010` block ⇒ `transient`
 *   (exempt from strike counting; the edge, not the account, is at fault).
 * - 403 otherwise ⇒ `forbidden` (strike counter path).
 * - 429 ⇒ `rate-limited` (exact cooldown from the exhausted window).
 * - 529, or a body containing `server_is_overloaded` ⇒ `overloaded`.
 * - 400 with `organization has been disabled` / `identity verification` ⇒
 *   `org-disabled` (permanent).
 * - other 5xx ⇒ `transient`; other 4xx ⇒ `request-error`.
 */

export type UpstreamErrorKind =
  | 'auth-revoked'
  | 'auth-expired'
  | 'forbidden'
  | 'rate-limited'
  | 'overloaded'
  | 'org-disabled'
  | 'transient'
  | 'request-error';

export interface UpstreamErrorInput {
  readonly status: number;
  readonly bodyText: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface UpstreamErrorClassification {
  readonly kind: UpstreamErrorKind;
  readonly status: number;
}

function bodyContains(bodyText: string, needle: string): boolean {
  return typeof bodyText === 'string' && bodyText.toLowerCase().includes(needle);
}

function isHtmlBody(bodyText: string): boolean {
  if (typeof bodyText !== 'string') return false;
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html') || bodyText.includes('<html');
}

function classifyAuthFailure(bodyText: string): UpstreamErrorKind {
  if (
    bodyContains(bodyText, 'token_invalidated') ||
    bodyContains(bodyText, 'token_revoked') ||
    bodyContains(bodyText, 'unauthorized')
  ) {
    return 'auth-revoked';
  }
  return 'auth-expired';
}

function classifyForbidden(bodyText: string): UpstreamErrorKind {
  // Cloudflare blocks surface as an HTML challenge page or an "error code:
  // 1010" text; both are edge-level, not account-level, faults.
  if (isHtmlBody(bodyText) || /code[:\s]+1010/.test(bodyText)) return 'transient';
  return 'forbidden';
}

function isOverloaded(status: number, bodyText: string): boolean {
  return status === 529 || bodyContains(bodyText, 'server_is_overloaded');
}

function isOrgDisabled(bodyText: string): boolean {
  return bodyContains(bodyText, 'organization has been disabled') || bodyContains(bodyText, 'identity verification');
}

/**
 * Maps one upstream failure to its health-store kind. `headers` is accepted
 * for shape stability with the transport call site but does not currently
 * participate: every distinguishing signal lives in the status or body.
 * Statuses below 400 (a misrouted success) classify as `request-error` so
 * callers never mistake them for retryable.
 */
export function classifyUpstreamError(input: UpstreamErrorInput): UpstreamErrorClassification {
  const status = input?.status;
  const bodyText = typeof input?.bodyText === 'string' ? input.bodyText : '';
  if (!Number.isFinite(status)) return { kind: 'request-error', status: Number.NaN };
  if (status === 401) return { kind: classifyAuthFailure(bodyText), status };
  if (status === 403) return { kind: classifyForbidden(bodyText), status };
  if (status === 429) return { kind: 'rate-limited', status };
  if (isOverloaded(status, bodyText)) return { kind: 'overloaded', status };
  if (status === 400 && isOrgDisabled(bodyText)) return { kind: 'org-disabled', status };
  if (status >= 500) return { kind: 'transient', status };
  return { kind: 'request-error', status };
}

const FAILOVER_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  'auth-revoked',
  'forbidden',
  'rate-limited',
  'overloaded',
  'org-disabled',
]);

/**
 * Whether an in-flight request should fail over to a different account.
 * `auth-expired` does not fail over (the same account refreshes and retries);
 * `transient` and `request-error` are surfaced to the caller as-is.
 */
export function shouldFailover(classification: UpstreamErrorClassification): boolean {
  return FAILOVER_KINDS.has(classification?.kind);
}
