/**
 * P1a Codex upstream error classification (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4).
 *
 * R5 step 1: the decision matrix moved verbatim into the shared OAuth
 * subscription layer (gateway/oauth-subscription/health-classifier.ts)
 * because it is category-agnostic; this module keeps the original codex
 * import surface (type aliases plus the two functions) so the gateway
 * transport, the runtime-health store wiring and every existing test see
 * exactly the same behavior. See the shared module for the matrix.
 */

import type {
  UpstreamErrorClassification,
  UpstreamErrorInput,
  UpstreamErrorKind,
} from '../oauth-subscription/health-classifier.js';

export type CodexUpstreamErrorKind = UpstreamErrorKind;
export type CodexUpstreamErrorInput = UpstreamErrorInput;
export type CodexUpstreamErrorClassification = UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';
