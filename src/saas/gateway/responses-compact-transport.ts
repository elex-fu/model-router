import type { PreparedEvidenceTransport } from './prepared-evidence-dispatch-service.js';

/**
 * Compact has its own signed operation and fixed target binding. Category
 * transports that always send `/responses` must never consume it. The native
 * HTTP transport owns credential proof, timeout, cancellation and usage.
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
