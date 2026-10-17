/**
 * Batch-3 Vertex upstream error classification. The decision matrix lives in
 * the shared OAuth subscription layer (gateway/oauth-subscription/
 * health-classifier.ts) because it is category-agnostic; this module keeps
 * the per-package import surface so the vertex transport, its tests and any
 * future health-store wiring see one stable local path (the same pattern the
 * gemini package uses).
 */

export type VertexUpstreamErrorKind = import('../oauth-subscription/health-classifier.js').UpstreamErrorKind;
export type VertexUpstreamErrorInput = import('../oauth-subscription/health-classifier.js').UpstreamErrorInput;
export type VertexUpstreamErrorClassification =
  import('../oauth-subscription/health-classifier.js').UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';
