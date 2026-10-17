/**
 * Batch 3 CN-provider prepared-evidence transport adapter (the roadmap's
 * per-platform `*PreparedEvidenceTransport` — the zhipu/minimax mount).
 *
 * Shape: a classifying DECORATOR over an inner transport (production: the
 * generic ProviderHttpTransport). The generic transport already owns the
 * whole wire contract — provider-target URL resolution, credential
 * injection, egress proxy + TLS fingerprint connectors, address pinning,
 * the egress allowlist, and usage observation (SSE + JSON) — so this
 * adapter reuses all of it and adds exactly the one thing the generic path
 * cannot do: reading the bounded upstream error body and classifying it
 * through the CN-provider matrix so a payg insufficient-balance 429
 * ("余额不足" / "insufficient balance" text) reaches the dispatch
 * failure-feedback layer as `insufficient-balance` (the recoverable
 * 20-minute pause) instead of the status-only `rate_limited` fallback. A
 * 402 already maps correctly through the status-only fallback, so the body
 * read is what makes the 429 text path observable at all.
 *
 * Classification applies ONLY to evidence whose signed endpoint scope is a
 * CN-provider endpoint; every other provider's traffic passes through
 * byte-identical. Error bodies are read to a 32 KiB cap and re-exposed as a
 * fresh one-reader stream, so downstream consumers (client error relay /
 * drain) observe the exact same bytes.
 */

import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../prepared-evidence-dispatch-service.js';
import { CN_PROVIDER_ENDPOINTS } from './catalog-identity.js';
import { classifyCnProviderUpstreamError } from './health.js';

/** Bounded upstream error-body read (the codex/claude MAX_ERROR_BODY_BYTES precedent). */
export const CN_PROVIDER_MAX_ERROR_BODY_BYTES = 32_768;

export interface CnProvidersPreparedEvidenceTransportOptions {
  /**
   * The transport that performs the actual upstream send. Production: the
   * generic ProviderHttpTransport (URL/credential/proxy/TLS/usage all stay
   * its job).
   */
  readonly inner: PreparedEvidenceTransport;
  /** Test seam: the endpoints the adapter classifies for. Defaults to the category set. */
  readonly endpoints?: readonly string[];
  /** Test seam for the classification reader body cap. */
  readonly maxErrorBodyBytes?: number;
}

function isNonSuccess(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 600;
}

async function readBoundedErrorBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly state: 'ok'; readonly bytes: Uint8Array; readonly text: string } | { readonly state: 'failed' }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { state: 'failed' };
      total += value.byteLength;
      if (total > maxBytes) {
        // Over-cap bodies are cancelled without classification: replaying a
        // truncated body to the client would corrupt it, and the status-only
        // fallback still applies downstream.
        void reader.cancel().catch(() => undefined);
        return { state: 'failed' };
      }
      chunks.push(value);
    }
  } catch {
    return { state: 'failed' };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { state: 'ok', bytes: merged, text: new TextDecoder('utf-8', { fatal: false }).decode(merged) };
}

function replayBody(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * The zhipu/minimax dispatch adapter. Construct once per composition and
 * mount through the gateway's `cnProvidersEvidenceTransport` option; the
 * composition registers it on the three CN-provider endpoint scopes.
 */
export class CnProvidersPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly inner: PreparedEvidenceTransport;
  private readonly endpoints: ReadonlySet<string>;
  private readonly maxErrorBodyBytes: number;

  constructor(options: CnProvidersPreparedEvidenceTransportOptions) {
    if (!options || typeof options.inner?.send !== 'function') {
      throw new TypeError('cn-providers transport requires an inner transport');
    }
    this.inner = options.inner;
    this.endpoints = new Set(options.endpoints ?? CN_PROVIDER_ENDPOINTS);
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? CN_PROVIDER_MAX_ERROR_BODY_BYTES;
  }

  async send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    const result = await this.inner.send(input);
    if (!this.shouldClassify(input.evidence.endpoint, result)) return result;
    if (!(result.body instanceof ReadableStream)) return result;
    const read = await readBoundedErrorBody(result.body, this.maxErrorBodyBytes);
    if (read.state === 'failed') {
      // The original body is unusable after a failed read; the status-only
      // fallback (402 ⇒ insufficient_balance, 429 ⇒ rate_limited) still
      // applies downstream, so return the classification-less result.
      return { ...result, body: null };
    }
    const classification = classifyCnProviderUpstreamError({
      status: result.resultHttpStatus ?? Number.NaN,
      bodyText: read.text,
    });
    return {
      ...result,
      upstreamErrorKind: classification.kind,
      body: replayBody([read.bytes]),
    };
  }

  private shouldClassify(endpoint: unknown, result: PreparedEvidenceTransportResponse): boolean {
    if (result.responseStarted) return false;
    if (!isNonSuccess(result.resultHttpStatus)) return false;
    if (typeof endpoint !== 'string') return false;
    return this.endpoints.has(endpoint);
  }
}
