/**
 * Endpoint/Bridge Registry — minimal declaration structure (core-plan §4,
 * R2 §7.2; docs/core-capability-alignment-technical-plan-2026-10-18.md).
 *
 * This module is the declaration surface the five R2 §7.2 SaaS entries
 * populate: method, path, operation, input shape, transform version, and
 * supported features. It intentionally does NOT refactor the existing
 * http-handler route tables (the shared-file freeze discipline in §15.2);
 * the handler consults it for the new entries only, and §7.1's full
 * four-protocol convergence can later make this registry the single source
 * the compiler, pickBridge, and test matrices read.
 *
 * `operation` is the registry's true operation identity. `provenanceOperation`
 * is the operation string that may legally reach the migration-029/104
 * provenance-shape CHECK on `saas_attempts` / `saas_prepared_request_evidence`
 * (the pairs (anthropic,'messages'), (openai,'chat.completions'|'embeddings'),
 * (gemini,'generateContent'), (responses,'responses')). For the Gemini native
 * entries the true identity is already CHECK-legal. For count_tokens a
 * follow-up migration must widen the CHECK before its true
 * identity can be signed into evidence. Compact uses its native operation
 * under migration134. This registry is the authoritative
 * record of what the endpoint actually is.
 */

import type { GatewayProtocol } from './contracts.js';

export type SaasEndpointMethod = 'GET' | 'POST';

/** Input shape the trusted HTTP boundary must produce before admission. */
export type SaasEndpointInputShape = 'json' | 'none';

export interface SaasEndpointRegistration {
  /** Stable registry id (`<family>.<operation>`). */
  readonly id: string;
  readonly method: SaasEndpointMethod;
  /** Literal path for exact routes; pattern segments use `:name` placeholders. */
  readonly path: string;
  /** Inbound client protocol family. */
  readonly protocol: GatewayProtocol;
  /** True operation identity (registry truth; §7.2). */
  readonly operation: string;
  /** Operation string legal in the migration-029/104 provenance CHECK. */
  readonly provenanceOperation: string;
  readonly inputShape: SaasEndpointInputShape;
  /** Server-owned transform/boundary version for this entry. */
  readonly transformVersion: string;
  /** Features this entry can serve; a capability gate never forges an undeclared feature (§7.1). */
  readonly supportedFeatures: readonly string[];
}

/** R2 §7.2 count_tokens features: native upstream counting is preferred
 * where the supply declares it; local estimation is an explicit policy. */
export const COUNT_TOKENS_FEATURE_NATIVE = 'native-upstream-count';
export const COUNT_TOKENS_FEATURE_ESTIMATE = 'local-estimate';

/** R2 §7.2 compact feature: only supplies that declare NATIVE compact may
 * serve /v1/responses/compact; opaque compact items are never forged
 * through the Chat bridge. */
export const RESPONSES_COMPACT_FEATURE_NATIVE = 'native-compact';

export const SAAS_ENDPOINT_REGISTRY: readonly SaasEndpointRegistration[] = [
  {
    id: 'anthropic.count_tokens',
    method: 'POST',
    path: '/v1/messages/count_tokens',
    protocol: 'anthropic',
    operation: 'count_tokens',
    // Migration 131+ (blocked on the in-flight migration registry) widens
    // the 029/104 CHECK to (anthropic, 'count_tokens'); until then the
    // attempt provenance stays family-canonical.
    provenanceOperation: 'messages',
    inputShape: 'json',
    transformVersion: 'count-tokens-boundary/v1',
    supportedFeatures: [COUNT_TOKENS_FEATURE_NATIVE, COUNT_TOKENS_FEATURE_ESTIMATE],
  },
  {
    id: 'responses.compact',
    method: 'POST',
    path: '/v1/responses/compact',
    protocol: 'responses',
    operation: 'responses.compact',
    provenanceOperation: 'responses.compact',
    inputShape: 'json',
    transformVersion: 'responses-compact-boundary/v1',
    supportedFeatures: [RESPONSES_COMPACT_FEATURE_NATIVE],
  },
  {
    id: 'gemini.generateContent',
    method: 'POST',
    path: '/v1beta/models/:model:generateContent',
    protocol: 'gemini',
    operation: 'generateContent',
    provenanceOperation: 'generateContent',
    inputShape: 'json',
    transformVersion: 'gemini-native-inbound/v1',
    supportedFeatures: ['non-streaming'],
  },
  {
    id: 'gemini.streamGenerateContent',
    method: 'POST',
    path: '/v1beta/models/:model:streamGenerateContent',
    protocol: 'gemini',
    operation: 'generateContent',
    provenanceOperation: 'generateContent',
    inputShape: 'json',
    transformVersion: 'gemini-native-inbound/v1',
    supportedFeatures: ['sse-streaming'],
  },
  {
    id: 'gemini.listModels',
    method: 'GET',
    path: '/v1beta/models',
    protocol: 'gemini',
    operation: 'listModels',
    provenanceOperation: 'listModels',
    inputShape: 'none',
    transformVersion: 'gemini-native-inbound/v1',
    // §6.3: the list is the CURRENT caller's key permissions ∩ assembled
    // capabilities — never the raw provider model list.
    supportedFeatures: ['caller-scoped'],
  },
  {
    // G-B3 (gap-remediation §4): the rerank entry is REGISTERED but not
    // yet assembled — no catalog supply declares the rerank operation, so
    // the boundary answers the precise capability-unavailable 503 (the
    // new-api RelayFormatRerank surface reserved; the 能力不可售 principle:
    // registered ≠ sellable). The provenance rides the OpenAI chat family
    // until a dedicated rerank catalog migration widens the operation CHECK.
    id: 'openai.rerank',
    method: 'POST',
    path: '/v1/rerank',
    protocol: 'openai',
    operation: 'rerank',
    provenanceOperation: 'chat.completions',
    inputShape: 'json',
    transformVersion: 'rerank-boundary/v1',
    supportedFeatures: ['reserved'],
  },
];

/** Bounded, printable path-segment model identifiers (mirrors QUERY_PATH_PARAMETER). */
const GEMINI_PATH_MODEL = /^[A-Za-z0-9._-]{1,255}$/;
/** The public model may also be spelled with the `models/` or `gemini/` prefix in the path. */
const GEMINI_PATH_MODEL_PREFIX = /^(?:models\/|gemini\/)([A-Za-z0-9._-]{1,255})$/;

export interface GeminiNativeContentMatch {
  /** The public model parsed from the path segment (prefix-stripped). */
  readonly model: string;
  /** True for `:streamGenerateContent` (native SSE); false for `:generateContent`. */
  readonly stream: boolean;
}

/**
 * Parse the native Gemini inbound content path
 * `/v1beta/models/{model}:generateContent` or `:streamGenerateContent`.
 * Returns null for every other path (the generic route tables then apply,
 * including 404 NOT_FOUND for unknown /v1beta paths).
 */
export function matchGeminiNativeContentPath(path: string): GeminiNativeContentMatch | null {
  if (!path.startsWith('/v1beta/models/')) return null;
  const rest = path.slice('/v1beta/models/'.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return null;
  const rawModel = rest.slice(0, separator);
  const action = rest.slice(separator + 1);
  let model = rawModel;
  const prefixed = GEMINI_PATH_MODEL_PREFIX.exec(rawModel);
  if (prefixed) model = prefixed[1];
  if (!GEMINI_PATH_MODEL.test(model)) return null;
  if (action === 'generateContent') return { model, stream: false };
  if (action === 'streamGenerateContent') return { model, stream: true };
  return null;
}

/**
 * Method routing for the R2 §7.2 entries: given a request path, report the
 * registry entry that owns it and whether the method matches. Known path
 * with wrong method → `{ matched: true, methodAllowed: false }` so the
 * boundary answers 405; unknown path → `{ matched: false }` (404).
 */
export function matchSaasEndpointEntry(
  method: string,
  path: string,
):
  | { readonly matched: true; readonly entry: SaasEndpointRegistration; readonly methodAllowed: boolean }
  | { readonly matched: false } {
  const upper = method.toUpperCase();
  const geminiNative = matchGeminiNativeContentPath(path);
  if (geminiNative !== null) {
    const entry =
      SAAS_ENDPOINT_REGISTRY.find(
        (candidate) =>
          candidate.protocol === 'gemini' &&
          candidate.method === 'POST' &&
          candidate.inputShape === 'json' &&
          ((geminiNative.stream && candidate.supportedFeatures.includes('sse-streaming')) ||
            (!geminiNative.stream && candidate.supportedFeatures.includes('non-streaming'))),
      ) ?? null;
    if (entry === null) return { matched: false };
    return { matched: true, entry, methodAllowed: upper === 'POST' };
  }
  for (const entry of SAAS_ENDPOINT_REGISTRY) {
    if (entry.path !== path) continue;
    if (entry.protocol === 'gemini' && entry.method === 'POST') continue; // handled above
    return { matched: true, entry, methodAllowed: upper === entry.method };
  }
  return { matched: false };
}
