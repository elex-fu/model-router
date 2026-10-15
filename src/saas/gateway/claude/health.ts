/**
 * R5 Claude upstream error classification. The decision matrix lives in the
 * shared OAuth subscription layer (gateway/oauth-subscription/
 * health-classifier.ts) because it is category-agnostic; this module keeps
 * the per-package import surface so the claude transport, its tests and any
 * future health-store wiring see one stable local path (the same pattern the
 * codex package uses after the R5 step 1 extraction).
 */

export type ClaudeUpstreamErrorKind = import('../oauth-subscription/health-classifier.js').UpstreamErrorKind;
export type ClaudeUpstreamErrorInput = import('../oauth-subscription/health-classifier.js').UpstreamErrorInput;
export type ClaudeUpstreamErrorClassification =
  import('../oauth-subscription/health-classifier.js').UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';
