/**
 * R2 §7.2 `POST /v1/messages/count_tokens` — the auxiliary-operation policy
 * seam (docs/core-capability-alignment-technical-plan-2026-10-18.md §7.2).
 *
 * count_tokens is metered-but-not-generation: it has real resource cost, so
 * it gets an INDEPENDENT rate limit and an EXPLICIT pricing policy — never an
 * implicit free ride, and never a reservation from the generation request's
 * output budget (the messages hold path would reserve an output bound, which
 * §7.2 explicitly forbids for this operation).
 *
 * Native upstream counting is preferred where the supply declares it
 * (COUNT_TOKENS_FEATURE_NATIVE). No catalog supply declares native counting
 * today, so the boundary serves the LOCAL_ESTIMATE policy and labels it
 * explicitly on every response (`x-model-router-count-policy`); a supply that
 * later declares the feature switches the policy to NATIVE_UPSTREAM, whose
 * dispatch must then ride the full preparation → admission → evidence chain.
 */

import { COUNT_TOKENS_FEATURE_ESTIMATE, COUNT_TOKENS_FEATURE_NATIVE } from './endpoint-registry.js';

export const COUNT_TOKENS_OPERATION = 'count_tokens';
export const COUNT_TOKENS_POLICY_VERSION = 'count-tokens-policy/v1';
export const COUNT_TOKENS_ESTIMATOR_VERSION = 'count-tokens-estimate/v1';
/** Response header that makes the active policy explicit to the caller. */
export const COUNT_TOKENS_POLICY_HEADER = 'x-model-router-count-policy';

/**
 * The pricing policy is explicit by construction: zero-priced is a declared
 * policy version, never an absent price. When migration 131+ gives the
 * operation its own provenance identity, a per-request price version
 * attaches at this seam without touching the boundary.
 */
export interface CountTokensPricingPolicy {
  readonly operation: typeof COUNT_TOKENS_OPERATION;
  readonly policyVersion: typeof COUNT_TOKENS_POLICY_VERSION;
  /** 'explicit-zero': defined zero rate (the Gemini placeholder-cost precedent: zero, never null). */
  readonly priceKind: 'explicit-zero';
  /** Independent from the generation request's rate/quota budget. */
  readonly rateLimitScope: 'count_tokens';
}

export const COUNT_TOKENS_PRICING_POLICY: CountTokensPricingPolicy = {
  operation: COUNT_TOKENS_OPERATION,
  policyVersion: COUNT_TOKENS_POLICY_VERSION,
  priceKind: 'explicit-zero',
  rateLimitScope: 'count_tokens',
};

export type CountTokensPolicy =
  | { readonly kind: 'native-upstream' }
  | { readonly kind: 'local-estimate'; readonly estimatorVersion: string };

/** Native upstream counting is preferred wherever the supply declares it. */
export function resolveCountTokensPolicy(supplyDeclaresNativeCount: boolean): CountTokensPolicy {
  if (supplyDeclaresNativeCount) return { kind: 'native-upstream' };
  return { kind: 'local-estimate', estimatorVersion: COUNT_TOKENS_ESTIMATOR_VERSION };
}

export function countTokensPolicyHeader(policy: CountTokensPolicy): string {
  return policy.kind === 'native-upstream' ? COUNT_TOKENS_FEATURE_NATIVE : COUNT_TOKENS_FEATURE_ESTIMATE;
}

function ceilDiv4(chars: number): number {
  return Math.ceil(chars / 4);
}

function textChars(value: string): number {
  return value.length;
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') return textChars(content);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block === 'string') {
      chars += textChars(block);
      continue;
    }
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') chars += textChars(text);
    }
  }
  return chars;
}

/**
 * Estimate the input token count of a Messages-shaped count_tokens body
 * (the Anthropic count_tokens request carries the same body shape as
 * /v1/messages). The bound is the established chars/4 heuristic over the
 * system prompt and every message's text content; an unreadable body
 * estimates 0 — the boundary rejects non-object bodies before this runs.
 */
export function estimateCountTokensInputTokens(body: Record<string, unknown>): number {
  let chars = 0;
  chars += contentChars(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        chars += contentChars((message as Record<string, unknown>).content);
      }
    }
  }
  return ceilDiv4(chars);
}

export interface CountTokensRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

const RATE_WINDOW_MS = 60_000;
export const DEFAULT_COUNT_TOKENS_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Independent per-proxy-key fixed-window limiter for count_tokens. This is
 * deliberately NOT the generation admission path's RPM reservation: §7.2
 * requires the auxiliary operation to carry its own limit so counting can
 * never crowd out (or be crowded out by) generation traffic.
 */
export class CountTokensRateLimiter {
  private readonly windows = new Map<string, { windowStartMs: number; count: number }>();

  constructor(
    private readonly limitPerMinute: number = DEFAULT_COUNT_TOKENS_RATE_LIMIT_PER_MINUTE,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(limitPerMinute) || limitPerMinute < 1) {
      throw new Error('count_tokens rate limit must be a positive integer');
    }
  }

  check(proxyKeyId: string): CountTokensRateLimitDecision {
    const nowMs = this.now();
    const current = this.windows.get(proxyKeyId);
    if (current === undefined || nowMs - current.windowStartMs >= RATE_WINDOW_MS) {
      this.windows.set(proxyKeyId, { windowStartMs: nowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count < this.limitPerMinute) {
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const elapsed = nowMs - current.windowStartMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((RATE_WINDOW_MS - elapsed) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
}
