/**
 * P1-3a Codex /wham rate-limit reset credits (active quota plane, design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4 follow-up). Pure helpers
 * with zero IO, ported from sub2api's quota service semantics:
 *
 * - details parse: sub2api `backend/internal/service/openai_quota_reset_credits.go:10-122`
 *   (field-name variants, codex_rate_limits/available filtering, expiry requirement);
 * - consume request + idempotency key: sub2api
 *   `backend/internal/service/openai_quota_service.go:341-347, 399-409, 622-634`
 *   (POST body `{redeem_request_id[, credit_id]}`, UUID-v4-shaped idempotency key).
 *
 * The gateway transport owns the actual network call; these modules only build
 * and interpret it. No secrets are logged or persisted here.
 */

import { randomUUID } from 'node:crypto';

/** Reset-credit details endpoint (GET). */
export const WHAM_RATE_LIMIT_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/** Reset-credit consume endpoint (POST). */
export const WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

/** The only reset type the Codex quota plane grants (s2a filters others out). */
export const CODEX_RESET_CREDIT_RESET_TYPE = 'codex_rate_limits';
/** Status of a credit that can still be consumed. */
export const CODEX_RESET_CREDIT_STATUS_AVAILABLE = 'available';

/**
 * One projected reset credit. `expiryAtMs` is the parsed epoch-milliseconds
 * form of `expiresAt` (`null` when the upstream timestamp is absent or
 * unparsable); consumers must treat an unknown expiry as not consumable
 * (fail-closed, mirroring s2a's refusal to cache count>0 snapshots without
 * expiration details — openai_quota_service.go:242-246).
 */
export interface CodexResetCredit {
  /** Upstream credit identifier (`id` / `credit_id` / `creditId` variants). */
  readonly id: string | null;
  /** e.g. `'codex_rate_limits'`; `null` when the entry omits it (s2a allows empty). */
  readonly resetType: string | null;
  /** e.g. `'available'`; `null` when the entry omits it (s2a allows empty). */
  readonly status: string | null;
  /** Raw upstream expiry timestamp (s2a keeps the string to preserve fidelity). */
  readonly expiresAt: string | null;
  /** Parsed expiry as epoch milliseconds; `null` when unknown/unparsable. */
  readonly expiryAtMs: number | null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lenient field-name projection for one raw credit entry: maps the
 * snake_case/camelCase variants s2a's payload struct accepts
 * (openai_quota_reset_credits.go:10-19) WITHOUT the details-endpoint filters.
 * The /wham/usage body embeds a reset-credit summary whose entries carry only
 * `expires_at` (s2a `OpenAIRateLimitResetCredits`, openai_quota_service.go:74-77),
 * so the strict `codex_rate_limits`/`available`/expiry filters must not run
 * there. Returns `null` for non-object entries.
 */
export function mapWhamResetCreditEntry(entry: unknown): CodexResetCredit | null {
  if (!isRecord(entry)) return null;
  const id = trimmedString(entry.id) ?? trimmedString(entry.credit_id) ?? trimmedString(entry.creditId);
  const resetType = trimmedString(entry.reset_type) ?? trimmedString(entry.resetType);
  const status = trimmedString(entry.status);
  const expiresAt = trimmedString(entry.expires_at) ?? trimmedString(entry.expiresAt);
  const parsedExpiry = expiresAt !== null ? Date.parse(expiresAt) : Number.NaN;
  return {
    id,
    resetType,
    status,
    expiresAt,
    expiryAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : null,
  };
}

/** First non-`null` array among the container keys s2a probes, in order. */
function firstCreditArray(body: Record<string, unknown>): readonly unknown[] | null {
  for (const key of ['credits', 'rate_limit_reset_credits', 'items', 'data'] as const) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return null; // malformed authoritative list (s2a errors out)
    return value;
  }
  return null;
}

/**
 * Parses a /wham/rate-limit-reset-credits response into the consumable
 * credits list, porting s2a's details parse (openai_quota_reset_credits.go:45-122):
 *
 * - the body may be a bare array of credits, or an object whose credit list
 *   lives under the first present of `credits` / `rate_limit_reset_credits` /
 *   `items` / `data`;
 * - entries with a non-empty `reset_type` other than `codex_rate_limits`
 *   (case-insensitive) are skipped, as are entries with a non-empty `status`
 *   other than `available` (empty values pass, per s2a);
 * - entries without an expiry timestamp are skipped from the details list
 *   (s2a lines 99-101);
 * - `available_count` is deliberately not projected here: s2a only uses it for
 *   the count-precedence merge in `QueryUsage` (openai_quota_service.go:216-232),
 *   which belongs to the transport layer.
 *
 * Malformed bodies (non-object/non-array, or a non-array credit container)
 * return an empty array.
 */
export function parseWhamResetCreditsResponse(body: unknown): readonly CodexResetCredit[] {
  if (body === undefined || body === null) return [];
  const entries = Array.isArray(body) ? body : isRecord(body) ? firstCreditArray(body) : null;
  if (entries === null) return [];

  const credits: CodexResetCredit[] = [];
  for (const entry of entries) {
    const credit = mapWhamResetCreditEntry(entry);
    if (credit === null) continue;
    if (credit.resetType !== null && credit.resetType.toLowerCase() !== CODEX_RESET_CREDIT_RESET_TYPE) continue;
    if (credit.status !== null && credit.status.toLowerCase() !== CODEX_RESET_CREDIT_STATUS_AVAILABLE) continue;
    if (credit.expiresAt === null) continue;
    credits.push(credit);
  }
  return credits;
}

/** Shape of the consume request built by `buildWhamConsumeResetCreditsRequest`. */
export interface WhamConsumeResetCreditsRequest {
  readonly url: string;
  readonly method: 'POST';
  /** Idempotency key; upstream deduplicates repeated consumes on this value. */
  readonly idempotencyKey: string;
  /**
   * JSON body. s2a always sends `redeem_request_id` and adds `credit_id` only
   * for a targeted consume (openai_quota_service.go:399-403).
   */
  readonly body: { readonly redeem_request_id: string; readonly credit_id?: string };
}

/**
 * Builds the reset-credit consume request: `POST` to the consume endpoint with
 * the idempotency key in the body field s2a puts it (`redeem_request_id`,
 * openai_quota_service.go:399-409) plus an optional `credit_id` for targeted
 * consumes (s2a `ResetCreditTargeted`, openai_quota_service.go:351-358).
 * Quota-plane headers come from `buildWhamQuotaPlaneHeaders` (wham-usage.ts).
 * Blank keys throw rather than producing a request upstream would reject.
 */
export function buildWhamConsumeResetCreditsRequest(input: {
  idempotencyKey: string;
  creditId?: string;
}): WhamConsumeResetCreditsRequest {
  const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length === 0) {
    throw new Error('reset-credit consume requires a non-empty idempotency key');
  }
  const creditId = typeof input?.creditId === 'string' ? input.creditId.trim() : '';
  if (input?.creditId !== undefined && creditId.length === 0) {
    throw new Error('targeted reset-credit consume requires a non-empty credit id');
  }
  const body: { redeem_request_id: string; credit_id?: string } = { redeem_request_id: idempotencyKey };
  if (creditId.length > 0) body.credit_id = creditId;
  return {
    url: WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
    method: 'POST',
    idempotencyKey,
    body,
  };
}

/**
 * Random UUIDv4 idempotency key for the consume call. s2a generates the same
 * shape by hand (openai_quota_service.go:622-634); ChatGPT uses it to
 * deduplicate repeated consumes. Retries must reuse one key, not regenerate.
 */
export function generateResetCreditsIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Whether a credit is still consumable at `nowMs`: available (or unset)
 * status AND a known expiry strictly in the future. An unknown expiry is
 * fail-closed false — a credit that cannot be aged out must not be offered
 * for consumption (s2a caching rationale, openai_quota_service.go:242-246).
 * An expiry exactly at `nowMs` counts as expired, matching the reset-deadline
 * convention in quota-headers.ts.
 */
export function isResetCreditAvailable(credit: CodexResetCredit | null, nowMs: number): boolean {
  if (credit === null || credit === undefined) return false;
  const status = typeof credit.status === 'string' ? credit.status.trim().toLowerCase() : '';
  if (status.length > 0 && status !== CODEX_RESET_CREDIT_STATUS_AVAILABLE) return false;
  if (credit.expiryAtMs === null || !Number.isFinite(credit.expiryAtMs)) return false;
  return credit.expiryAtMs > nowMs;
}
