/**
 * Batch 3 CN-provider upstream-error classification (sub2api reference:
 * backend/internal/service/ratelimit_cn_providers.go
 * cnProviderResponseIndicatesInsufficientBalance +
 * applyCNProviderReactive429). Wraps the shared OAuth-subscription health
 * classifier (oauth-subscription/health-classifier.ts) with the one
 * CN-provider-specific matrix extension:
 *
 * - 429 carrying a payg insufficient-balance body ⇒ `insufficient-balance`
 *   (the recoverable 20-minute pause — the sub2api
 *   handleCNProviderInsufficientBalance port; zhipu/minimax payg accounts
 *   have no public balance endpoint, so the balance signal only surfaces
 *   reactively through response text on a 429). The check runs BEFORE the
 *   shared matrix so a balance 429 is never mistaken for window exhaustion;
 * - everything else delegates to the shared classifier unchanged (402 ⇒
 *   insufficient-balance unconditionally; coding-plan window exhaustion 403
 *   ⇒ rate-limited; the full dae3d5b matrix).
 *
 * The dispatch failure-feedback layer maps `insufficient-balance` to the
 * 20-minute recoverable cooldown (FEEDBACK_INSUFFICIENT_BALANCE_COOLDOWN_MS)
 * and clears it on the next success; `rate-limited` keeps the 429 cooldown
 * semantics.
 */

import {
  classifyUpstreamError,
  shouldFailover,
  type UpstreamErrorClassification,
  type UpstreamErrorInput,
} from '../oauth-subscription/health-classifier.js';

/** The payg insufficient-balance text markers (sub2api verbatim set). */
const INSUFFICIENT_BALANCE_MARKERS: readonly string[] = Object.freeze([
  '余额不足',
  'insufficient balance',
  'insufficient_credit',
  'balance is not enough',
  'no enough balance',
]);

/** True when a response body identifies a payg insufficient-balance state. */
export function cnProviderResponseIndicatesInsufficientBalance(bodyText: string): boolean {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return false;
  const lowered = bodyText.toLowerCase();
  return INSUFFICIENT_BALANCE_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * CN-provider classification: the 429 balance-text branch precedes the
 * shared matrix. All other statuses (and 429s without a balance body)
 * classify through the shared classifier unchanged.
 */
export function classifyCnProviderUpstreamError(input: UpstreamErrorInput): UpstreamErrorClassification {
  if (input?.status === 429 && cnProviderResponseIndicatesInsufficientBalance(input.bodyText ?? '')) {
    return { kind: 'insufficient-balance', status: 429 };
  }
  return classifyUpstreamError(input);
}

/** Failover decision: identical to the shared matrix (alias for symmetry). */
export function shouldFailoverCnProvider(classification: UpstreamErrorClassification): boolean {
  return shouldFailover(classification);
}
