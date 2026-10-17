/**
 * Shared OAuth-subscription upstream error classification (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5; batch 2.3 matrix
 * extension). Moved verbatim from the codex package (gateway/codex/health.ts)
 * — the decision matrix is category-agnostic: the gateway transport calls
 * `classifyUpstreamError` on every non-2xx (and stream-aborting) response and
 * writes the resulting kind into the runtime-health store (040);
 * `shouldFailover` decides whether the in-flight request should be retried
 * on another account. The codex package re-exports these under its original
 * type aliases.
 *
 * Matrix (first match wins):
 * - 401 with `token_invalidated` / `token_revoked` / `Unauthorized` in the
 *   body ⇒ `auth-revoked` (permanent; the token was explicitly killed).
 * - 401 otherwise ⇒ `auth-expired` (refresh token + temporary unschedulable;
 *   a second consecutive 401 escalation is decided by the cooldown layer,
 *   which owns the previous-outcome state).
 * - 402 with a CN-provider insufficient-balance body ⇒ `insufficient-balance`
 *   (recoverable temporary pause: 2× the balance-check period, the sub2api
 *   handleCNProviderInsufficientBalance port; never a permanent disable).
 * - 402 otherwise ⇒ `insufficient-balance` (billing failure; still a
 *   failover — the same account cannot pay for this request).
 * - 403 with the Kimi concurrency-limit message ⇒ `concurrency-limited`
 *   (recoverable temporary pause — the per-account concurrent-request
 *   ceiling; minute-scale cooldown, never the forbidden strike path).
 * - 403 with a coding-plan quota-window-exhausted body ⇒ `rate-limited`
 *   (the 429 semantics: cool to the real window reset — the sub2api
 *   handleCNProviderQuotaExhausted403 port).
 * - 403 with an HTML body or a Cloudflare `code 1010` block ⇒ `transient`
 *   (exempt from strike counting; the edge, not the account, is at fault).
 * - 403 otherwise ⇒ `forbidden` (strike counter path).
 * - 404 with a model-not-found body ⇒ `model-unavailable` (model-level
 *   cooldown: the account stays schedulable for other models — the sub2api
 *   SetModelRateLimit port).
 * - 400 with the Codex plan-gated model phrase ⇒ `model-unavailable`
 *   (same model-level cooldown: "model is not supported when using Codex").
 * - 429 ⇒ `rate-limited` (exact cooldown from the exhausted window, or the
 *   second-scale fallback cooldown when nothing parses — the fallback lives
 *   in the cooldown layer).
 * - 529, or a body containing `server_is_overloaded` ⇒ `overloaded`.
 * - 400 with `organization has been disabled` / `identity verification` ⇒
 *   `org-disabled` (permanent).
 * - other 5xx ⇒ `transient`; other 4xx ⇒ `request-error`.
 *
 * Stream timeouts never reach this matrix (they are not HTTP statuses); the
 * cooldown layer counts them per account over a window and temporarily
 * unschedules at the threshold (the sub2api stream-timeout port).
 */

export type UpstreamErrorKind =
  | 'auth-revoked'
  | 'auth-expired'
  | 'insufficient-balance'
  | 'concurrency-limited'
  | 'forbidden'
  | 'rate-limited'
  | 'model-unavailable'
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

/** Lowercased, separator-folded body for keyword matching (sub2api parity). */
function normalizedBody(bodyText: string): string {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return '';
  const lower = bodyText.toLowerCase();
  const folded = lower.replace(/[_\n\r\t]+/g, ' ').replace(/-/g, ' ');
  return folded
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(' ');
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

/** The Kimi concurrent-request-limit 403 (sub2api exact-message match). */
const KIMI_CONCURRENT_REQUEST_LIMIT_MESSAGE =
  "you've reached your concurrent request limit. please wait for your ongoing requests to finish and try again.";

function isConcurrencyLimit403(bodyText: string): boolean {
  return normalizedBody(bodyText) === KIMI_CONCURRENT_REQUEST_LIMIT_MESSAGE;
}

/**
 * The coding-plan quota-window-exhausted 403: cheap text match first
 * ("usage limit" / "quota will reset"), then the structured Kimi
 * `access_terminated_error` type. Mutually exclusive with the concurrency
 * limit message (checked first).
 */
function isQuotaWindowExhausted403(bodyText: string): boolean {
  const normalized = normalizedBody(bodyText);
  if (normalized.includes('usage limit') || normalized.includes('quota will reset')) return true;
  return bodyContains(bodyText, 'access_terminated_error');
}

function classifyForbidden(bodyText: string): UpstreamErrorKind {
  // Kimi reports its per-account concurrency ceiling as a 403: recoverable
  // temporary pause, never the forbidden strike path.
  if (isConcurrencyLimit403(bodyText)) return 'concurrency-limited';
  // The coding-plan rolling-window exhaustion also surfaces as a 403: rate
  // limiting, not permission loss — the 429 cooldown semantics apply.
  if (isQuotaWindowExhausted403(bodyText)) return 'rate-limited';
  // Cloudflare blocks surface as an HTML challenge page or an "error code:
  // 1010" text; both are edge-level, not account-level, faults.
  if (isHtmlBody(bodyText) || /code[:\s]+1010/.test(bodyText)) return 'transient';
  return 'forbidden';
}

/** 404 carrying a model-not-found body (sub2api keyword set). */
function isModelNotFoundBody(status: number, bodyText: string): boolean {
  if (status !== 404) return false;
  const normalized = normalizedBody(bodyText);
  if (normalized.length === 0 || !normalized.includes('model')) return false;
  return (
    normalized.includes('model not found') || normalized.includes('unknown model') || normalized.includes('not found')
  );
}

/** The deterministic Codex 400 for a plan-gated model on a ChatGPT account. */
const CODEX_PLAN_GATED_MODEL_PHRASE = 'model is not supported when using codex';

function isPlanGatedModel400(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const normalized = normalizedBody(bodyText);
  return normalized.length > 0 && normalized.includes(CODEX_PLAN_GATED_MODEL_PHRASE);
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
  if (status === 402) return { kind: 'insufficient-balance', status };
  if (status === 403) return { kind: classifyForbidden(bodyText), status };
  if (isModelNotFoundBody(status, bodyText) || isPlanGatedModel400(status, bodyText)) {
    return { kind: 'model-unavailable', status };
  }
  if (status === 429) return { kind: 'rate-limited', status };
  if (isOverloaded(status, bodyText)) return { kind: 'overloaded', status };
  if (status === 400 && isOrgDisabled(bodyText)) return { kind: 'org-disabled', status };
  if (status >= 500) return { kind: 'transient', status };
  return { kind: 'request-error', status };
}

const FAILOVER_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  'auth-revoked',
  'insufficient-balance',
  'concurrency-limited',
  'forbidden',
  'rate-limited',
  'model-unavailable',
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
