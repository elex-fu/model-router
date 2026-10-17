/**
 * Batch-3 Bedrock upstream error classification (the AWS half of the
 * batch-2.3 health-classifier matrix extension). The status/body decision
 * matrix itself is shared and category-agnostic
 * (gateway/oauth-subscription/health-classifier.ts); this module adds the
 * AWS exception-type mapping Bedrock needs before the shared matrix runs,
 * because AWS reports several conditions as 400 with a structured
 * `__type` body that the status-only matrix would misclassify as a
 * permanent request error:
 *
 * - ThrottlingException (400 or 429) ⇒ `rate-limited` (the 429 semantics:
 *   cooldown to the retry hint, same-account recovery, never a strike).
 * - ModelStreamedException / ModelInvocationException bodies carry the
 *   Anthropic `overloaded_error` event ⇒ `overloaded` (failover).
 * - ValidationException with an access-denied message ⇒ `forbidden`.
 * - AccessDeniedException / UnrecognizedClientException (401/403/400) keep
 *   their shared-matrix kind (auth-revoked / forbidden).
 *
 * Failover policy (the task #10 contract, mirroring the Go reference's
 * shouldFailoverUpstreamError): 401/403/429/529 and every ≥500 fail over
 * to another account; 400 never retries (Bedrock ValidationException is a
 * request-shape error — retrying the same body can only fail again).
 */

import {
  classifyUpstreamError,
  shouldFailover,
  type UpstreamErrorClassification,
} from '../oauth-subscription/health-classifier.js';

export type BedrockUpstreamErrorKind = import('../oauth-subscription/health-classifier.js').UpstreamErrorKind;
export type BedrockUpstreamErrorInput = import('../oauth-subscription/health-classifier.js').UpstreamErrorInput;
export type BedrockUpstreamErrorClassification =
  import('../oauth-subscription/health-classifier.js').UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';

/** AWS error body shape: `{"__type":"ThrottlingException","message":"..."}` (or the `type`/`code` spellings). */
export interface ParsedAwsErrorBody {
  /** The bare exception type (`com.amazonaws...#ThrottlingException` → `ThrottlingException`). */
  readonly type: string | null;
  readonly message: string | null;
}

/** Parses the AWS JSON error body; null when the body is not AWS-shaped. */
export function parseAwsErrorBody(bodyText: string | null): ParsedAwsErrorBody | null {
  if (typeof bodyText !== 'string' || bodyText.length === 0 || bodyText.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawType = record.__type ?? record.type ?? record.code;
  if (typeof rawType !== 'string' || rawType === '') return null;
  const bareType = rawType.includes('#') ? rawType.slice(rawType.lastIndexOf('#') + 1) : rawType;
  const message = typeof record.message === 'string' ? record.message : null;
  return { type: bareType, message };
}

/**
 * Classifies one Bedrock upstream failure: AWS exception-type pre-mapping,
 * then the shared batch-2.3 matrix. `headers` is accepted for call-site
 * shape stability (the retry hint lives in quota-headers.ts).
 */
export function classifyBedrockUpstreamError(input: BedrockUpstreamErrorInput): UpstreamErrorClassification {
  const aws = parseAwsErrorBody(input.bodyText);
  if (aws !== null) {
    // AWS surfaces throttling as 400 or 429 with ThrottlingException —
    // both are the 429 semantics (recoverable cooldown, failover).
    if (aws.type === 'ThrottlingException' || aws.type === 'TooManyRequestsException') {
      return { kind: 'rate-limited', status: input.status };
    }
    // A streamed Anthropic overloaded event surfacing through the AWS
    // envelope keeps the overloaded failover semantics.
    if (aws.type === 'ModelStreamedException' && /overloaded/i.test(aws.message ?? '')) {
      return { kind: 'overloaded', status: input.status };
    }
    // Model-not-found ValidationExceptions keep the model-level cooldown
    // (the account stays schedulable for other models).
    if (
      aws.type === 'ValidationException' &&
      /model/i.test(aws.message ?? '') &&
      /not (found|available)|access denied/i.test(aws.message ?? '')
    ) {
      return { kind: 'model-unavailable', status: input.status };
    }
    // A bad or revoked static key set: there is no OAuth refresh path for
    // AWS keys (the account must be swapped or the key re-imported), so
    // UnrecognizedClientException is always auth-revoked.
    if (aws.type === 'UnrecognizedClientException') {
      return { kind: 'auth-revoked', status: input.status };
    }
  }
  // 401 on static AWS keys likewise has no same-account recovery (the
  // shared matrix's `auth-expired` kind assumes an OAuth refresh worker):
  // classify it as auth-revoked so the in-flight request fails over.
  if (input.status === 401) {
    return { kind: 'auth-revoked', status: input.status };
  }
  return classifyUpstreamError(input);
}

/** The task #10 failover matrix: 401/403/429/529/≥500 fail over; 400 never retries. */
export function shouldBedrockFailover(classification: UpstreamErrorClassification): boolean {
  if (shouldFailover(classification)) return true;
  // The shared matrix keeps generic 5xx as `transient` (surfaced, not
  // failed over); the Bedrock contract additionally fails over on ≥500 and
  // 529 so the dispatch layer retries the request on another account.
  return classification.kind === 'overloaded' || (classification.status >= 500 && classification.status < 600);
}
