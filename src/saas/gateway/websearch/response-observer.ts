import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import {
  describeSearchResponsesBody,
  type SearchResponsesBodyDescriptor,
  transformSearchResponsesBody,
} from './emulation.js';
import { observedSearchCallUsage } from './usage.js';

export type { SearchResponsesBodyDescriptor } from './emulation.js';

/**
 * §4.3 (task #17): the search response observer — the category-transport
 * hook that turns the upstream Responses envelope (web_search/x_search
 * emulation) into the client search body `{query, results, provider,
 * max_results}` and reports the per-call billing observation.
 *
 * The emulation runs non-streaming (`stream:false`, `store:false`), so the
 * upstream body is one bounded JSON envelope; this observer buffers it up
 * to {@link SEARCH_RESPONSE_MAX_BODY_BYTES}, applies the whitelist-filtered
 * extraction (the model's claimed URLs are adopted only when the search
 * tool really visited them; raw sources fill any shortfall), and emits the
 * transformed JSON to the client as one chunk. A structurally unusable
 * upstream body is never transformed into a fake empty result set: the
 * observation resolves `null` usage and the client receives the upstream
 * error/invalid response verbatim through the transport's error path.
 *
 * The observer is pull-driven (the JSON usage observer precedent) and byte
 * bounded; cancellation cancels the upstream reader exactly once.
 */

export const SEARCH_RESPONSE_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ObservedSearchResponse {
  /** The client-visible body stream (the transformed JSON, one chunk). */
  readonly body: ReadableStream<Uint8Array>;
  /** Resolves with the per-call usage once the upstream body completes. */
  readonly usage: Promise<NormalSuccessObservedUsage | null>;
  getUsage(): NormalSuccessObservedUsage | null;
}

export type SearchObservationOutcome = 'transformed' | 'invalid_body';

export class SearchResponseObservationError extends Error {
  constructor(readonly outcome: SearchObservationOutcome) {
    super('the search response could not be transformed');
    this.name = 'SearchResponseObservationError';
  }
}

/**
 * Resolves the search descriptor for one verified compiled payload: the
 * payload itself must be a body built by `buildSearchResponsesBody` (the
 * exact round-trip keeps the transport stateless) AND the evidence's
 * signed provider operation must name the search family — an ordinary
 * responses request whose prompt accidentally matched the template never
 * hits the transform.
 */
export function searchDescriptorForDispatch(
  payloadBody: unknown,
  providerOperation: string | undefined,
): SearchResponsesBodyDescriptor | null {
  if (providerOperation !== 'web_search' && providerOperation !== 'x_search') return null;
  const descriptor = describeSearchResponsesBody(payloadBody);
  if (descriptor === null) return null;
  return descriptor.kind === providerOperation ? descriptor : null;
}

/**
 * Wraps one upstream body stream with the search transform. The returned
 * stream delivers the transformed client body (or fails with
 * {@link SearchResponseObservationError}); `usage` settles with the
 * per-call observation or null (unknown → settlement retention, never
 * zero-billing).
 */
export function observeSearchProviderResponse(
  body: ReadableStream<Uint8Array>,
  descriptor: SearchResponsesBodyDescriptor,
): ObservedSearchResponse {
  const reader = body.getReader();
  let buffer: Uint8Array | undefined;
  let length = 0;
  let oversized = false;
  let cancelled = false;
  let finalUsage: NormalSuccessObservedUsage | null = null;
  let settleUsage!: (value: NormalSuccessObservedUsage | null) => void;
  const usage = new Promise<NormalSuccessObservedUsage | null>((resolve) => {
    settleUsage = resolve;
  });
  let usageSettled = false;
  const settle = (value: NormalSuccessObservedUsage | null): void => {
    if (usageSettled) return;
    usageSettled = true;
    settleUsage(value);
  };
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // A cancellation may have released the reader already.
    }
  };

  const observedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) {
          release();
          return;
        }
        try {
          // Drain the upstream envelope into the bounded buffer first.
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) throw new TypeError('invalid provider response chunk');
            if (!oversized) {
              if (next.value.byteLength > SEARCH_RESPONSE_MAX_BODY_BYTES - length) {
                oversized = true;
                buffer = undefined;
              } else {
                buffer ??= new Uint8Array(SEARCH_RESPONSE_MAX_BODY_BYTES);
                buffer.set(next.value, length);
                length += next.value.byteLength;
              }
            }
          }
        } catch (error) {
          settle(null);
          release();
          controller.error(error);
          return;
        }
        release();
        if (oversized) {
          settle(null);
          controller.error(new SearchResponseObservationError('invalid_body'));
          return;
        }
        let providerBody: unknown;
        try {
          providerBody = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer?.subarray(0, length) ?? new Uint8Array()),
          );
        } catch {
          settle(null);
          controller.error(new SearchResponseObservationError('invalid_body'));
          return;
        }
        const transformed = transformSearchResponsesBody(providerBody, descriptor);
        if (transformed === null) {
          settle(null);
          controller.error(new SearchResponseObservationError('invalid_body'));
          return;
        }
        // The response is structurally usable: one completed search call.
        finalUsage = observedSearchCallUsage();
        settle(finalUsage);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(transformed)));
        controller.close();
      },
      async cancel(reason) {
        cancelled = true;
        settle(null);
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { body: observedBody, usage, getUsage: () => finalUsage };
}
