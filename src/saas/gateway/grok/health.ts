/**
 * Batch-3 Grok upstream error classification. The decision matrix lives in
 * the shared OAuth subscription layer
 * (gateway/oauth-subscription/health-classifier.ts) because it is
 * category-agnostic; this module keeps the grok import surface (type aliases
 * plus the two functions) exactly like the codex/claude/gemini precedents so
 * the gateway transport, the runtime-health store wiring and every test see
 * the same behavior.
 */

import type {
  UpstreamErrorClassification,
  UpstreamErrorInput,
  UpstreamErrorKind,
} from '../oauth-subscription/health-classifier.js';

export type GrokUpstreamErrorKind = UpstreamErrorKind;
export type GrokUpstreamErrorInput = UpstreamErrorInput;
export type GrokUpstreamErrorClassification = UpstreamErrorClassification;

export { classifyUpstreamError, shouldFailover } from '../oauth-subscription/health-classifier.js';
