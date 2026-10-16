/**
 * F4 Gemini upstream error classification. The decision matrix lives in the
 * shared OAuth subscription layer (gateway/oauth-subscription/
 * health-classifier.ts) because it is category-agnostic; this module keeps
 * the per-package import surface so the gemini transport, its tests and any
 * future health-store wiring see one stable local path (the same pattern the
 * claude package uses after the R5 step 1 extraction).
 */

export type GeminiUpstreamErrorKind = import('../oauth-subscription/health-classifier.js').UpstreamErrorKind;
export type GeminiUpstreamErrorInput = import('../oauth-subscription/health-classifier.js').UpstreamErrorInput;
export type GeminiUpstreamErrorClassification =
  import('../oauth-subscription/health-classifier.js').UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';
