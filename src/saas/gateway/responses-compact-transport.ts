import type { PreparedEvidenceTransport } from './prepared-evidence-dispatch-service.js';

/**
 * Compact has its own signed operation and fixed target binding. Category
 * transports that always send `/responses` must never consume it. The native
 * HTTP transport owns credential proof, timeout, cancellation and usage.
 *
 * P2-a: the Codex standalone alpha_search operation joins compact on the
 * native codex OAuth transport — it is the one operation whose dispatch URL
 * is operation-owned (the pinned ChatGPT codex alpha target), so the generic
 * endpoint-routing/generation path must never consume it either. The binding
 * is checked exactly like compact's: a native OpenAI-family operation, never
 * a bridge.
 */
export function createNativeResponsesCompactRoutingTransport(
  native: PreparedEvidenceTransport,
  generation: PreparedEvidenceTransport,
): PreparedEvidenceTransport & {
  readonly nativeTransport: PreparedEvidenceTransport;
  readonly generationTransport: PreparedEvidenceTransport;
} {
  return {
    nativeTransport: native,
    generationTransport: generation,
    send(input) {
      if (input.evidence.providerOperation === 'alpha_search') {
        if (
          input.evidence.protocol !== 'openai' ||
          input.evidence.providerProtocol !== 'openai' ||
          input.evidence.clientOperation !== 'alpha_search'
        ) {
          throw new Error('alpha search requires a native OpenAI-family operation binding');
        }
        return native.send(input);
      }
      if (input.evidence.providerOperation !== 'responses.compact') return generation.send(input);
      if (
        input.evidence.protocol !== 'responses' ||
        input.evidence.providerProtocol !== 'responses' ||
        input.evidence.clientOperation !== 'responses.compact'
      ) {
        throw new Error('compact requires a native Responses operation binding');
      }
      return native.send(input);
    },
  };
}
