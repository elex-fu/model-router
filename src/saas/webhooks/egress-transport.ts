import { isIP } from 'node:net';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import {
  createPinnedProviderHttpConnector,
  isGlobalProviderAddress,
  type ProviderHttpAddressResolver,
  type ProviderHttpPinnedConnector,
  type ProviderHttpPinnedConnectorFactory,
  type ProviderHttpResolvedAddress,
  resolveProviderHttpAddresses,
  selectPinnedProviderAddress,
} from '../gateway/provider-http-address.js';
import {
  CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES,
  type CustomerWebhookEnvelope,
  type CustomerWebhookEventDataByType,
  type CustomerWebhookEventType,
  createCustomerWebhookEnvelope,
} from './events.js';
import {
  CUSTOMER_WEBHOOK_EVENT_ID_HEADER,
  CUSTOMER_WEBHOOK_SIGNATURE_HEADER,
  CUSTOMER_WEBHOOK_TIMESTAMP_HEADER,
  type CustomerWebhookSigningKey,
  computeCustomerWebhookSignature,
  formatCustomerWebhookSignatureHeader,
} from './signatures.js';
import { normalizeCustomerWebhookTargetUrl } from './target-policy.js';

const MAX_TIMEOUT_MS = 30_000;
const MAX_CONNECTOR_LIFETIME_MS = 30_000;

export type CustomerWebhookFetchInit = UndiciRequestInit & { readonly dispatcher: Dispatcher };
export type CustomerWebhookFetch = (url: string, init: CustomerWebhookFetchInit) => Promise<Response>;

export interface CustomerWebhookEgressRequest<T extends CustomerWebhookEventType = CustomerWebhookEventType> {
  readonly targetUrl: string;
  readonly event: CustomerWebhookEnvelope<T>;
  readonly signingKeys: readonly CustomerWebhookSigningKey[];
  readonly signal?: AbortSignal;
}

export interface CustomerWebhookEgressResult {
  readonly httpStatus: number;
  readonly latencyMs: number;
}

export type CustomerWebhookTransportErrorCode =
  | 'INVALID_TARGET'
  | 'DNS_POLICY_REJECTED'
  | 'DNS_RESOLUTION_FAILED'
  | 'BODY_TOO_LARGE'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'HTTP_STATUS';

export class CustomerWebhookTransportError extends Error {
  constructor(
    readonly code: CustomerWebhookTransportErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly latencyMs?: number,
  ) {
    super(message);
    this.name = 'CustomerWebhookTransportError';
  }
}

export interface CustomerWebhookEgressOptions {
  readonly resolveAddresses?: ProviderHttpAddressResolver;
  readonly createConnector?: ProviderHttpPinnedConnectorFactory;
  /** Must forward the explicitly supplied dispatcher and never use redirect/proxy fallback. */
  readonly fetch?: CustomerWebhookFetch;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly now?: () => number;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function validateOptions(options: CustomerWebhookEgressOptions): Required<CustomerWebhookEgressOptions> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPayloadBytes = options.maxPayloadBytes ?? CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 256 ||
    maxPayloadBytes > CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES
  ) {
    throw new RangeError(`maxPayloadBytes must be between 256 and ${CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES}`);
  }
  const fetcher: CustomerWebhookFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init as RequestInit));
  return {
    resolveAddresses: options.resolveAddresses ?? resolveProviderHttpAddresses,
    createConnector: options.createConnector ?? createPinnedProviderHttpConnector,
    fetch: fetcher,
    timeoutMs,
    maxPayloadBytes,
    now: options.now ?? Date.now,
  };
}

function validateSigningKeys(value: readonly CustomerWebhookSigningKey[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new TypeError('one or two webhook signing keys are required');
  }
  const seen = new Set<number>();
  for (const key of value) {
    if (
      !key ||
      !Number.isSafeInteger(key.version) ||
      key.version < 1 ||
      key.version > 999_999_999 ||
      !(key.secret instanceof Uint8Array) ||
      key.secret.byteLength < 32 ||
      key.secret.byteLength > 256 ||
      seen.has(key.version)
    ) {
      throw new TypeError('webhook signing key set is invalid');
    }
    seen.add(key.version);
  }
}

function safeStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

function isWebhookGlobalAddress(address: string): boolean {
  if (!isGlobalProviderAddress(address)) return false;
  // RFC 5737 TEST-NET-2 is intentionally denied; the older shared provider
  // helper's conservative ranges do not include this documentation block.
  if (address.startsWith('192.0.2.')) return false;
  return true;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => {});
  } catch {
    // Ignore cancellation failure; response bodies are never consumed or retained.
  }
}

function normalizedEnvelope<T extends CustomerWebhookEventType>(event: CustomerWebhookEnvelope<T>): Buffer {
  const safe = createCustomerWebhookEnvelope({
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    data: event.data as CustomerWebhookEventDataByType[T],
  });
  return Buffer.from(JSON.stringify(safe), 'utf8');
}

/** HTTPS-only, DNS-rebinding-resistant transport for tenant-configured endpoints. */
export class CustomerWebhookEgressTransport {
  private readonly options: Required<CustomerWebhookEgressOptions>;

  constructor(options: CustomerWebhookEgressOptions = {}) {
    this.options = validateOptions(options);
  }

  async send<T extends CustomerWebhookEventType>(
    input: CustomerWebhookEgressRequest<T>,
  ): Promise<CustomerWebhookEgressResult> {
    validateSigningKeys(input.signingKeys);
    const urlText = normalizeCustomerWebhookTargetUrl(input.targetUrl);
    const parsed = new URL(urlText);
    const hostname =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname;
    const literalFamily = isIP(hostname);
    const controller = new AbortController();
    const parent = input.signal;
    let timeoutReached = false;
    let connector: ProviderHttpPinnedConnector | undefined;
    let disposed = false;
    const startedAt = this.options.now();
    const onParentAbort = () => controller.abort(parent?.reason);
    if (parent?.aborted) controller.abort(parent.reason);
    else parent?.addEventListener('abort', onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      timeoutReached = true;
      controller.abort(new Error('webhook timeout'));
    }, this.options.timeoutMs);
    const disposeConnector = async (error?: Error): Promise<void> => {
      if (!connector || disposed) return;
      disposed = true;
      try {
        if (error) await connector.destroy(error);
        else await connector.close();
      } catch {
        // Connector teardown must not leak implementation errors or secret material.
      }
    };
    const latency = () => Math.max(0, Math.min(MAX_CONNECTOR_LIFETIME_MS * 10, this.options.now() - startedAt));

    try {
      if (parent?.aborted) throw new CustomerWebhookTransportError('ABORTED', 'webhook send was cancelled', true);
      let resolved: readonly ProviderHttpResolvedAddress[];
      if (literalFamily === 0) {
        try {
          resolved = await awaitWithAbort(
            this.options.resolveAddresses(hostname, controller.signal),
            controller.signal,
          );
        } catch {
          if (timeoutReached)
            throw new CustomerWebhookTransportError('TIMEOUT', 'webhook address lookup timed out', true);
          if (parent?.aborted) throw new CustomerWebhookTransportError('ABORTED', 'webhook send was cancelled', true);
          throw new CustomerWebhookTransportError(
            'DNS_RESOLUTION_FAILED',
            'webhook target could not be resolved',
            true,
          );
        }
      } else {
        resolved = [];
      }
      if (controller.signal.aborted) {
        if (timeoutReached) throw new CustomerWebhookTransportError('TIMEOUT', 'webhook send timed out', true);
        throw new CustomerWebhookTransportError('ABORTED', 'webhook send was cancelled', true);
      }
      if (!Array.isArray(resolved) || resolved.length > 32) {
        throw new CustomerWebhookTransportError('DNS_POLICY_REJECTED', 'webhook target resolution was rejected', false);
      }
      if (
        resolved.some(
          (entry) =>
            !entry ||
            typeof entry.address !== 'string' ||
            (entry.family !== 4 && entry.family !== 6) ||
            !isWebhookGlobalAddress(entry.address),
        )
      ) {
        throw new CustomerWebhookTransportError(
          'DNS_POLICY_REJECTED',
          'webhook target address policy rejected the destination',
          false,
        );
      }
      let selected: ProviderHttpResolvedAddress;
      try {
        selected = selectPinnedProviderAddress(hostname, resolved);
        if (!isWebhookGlobalAddress(selected.address)) throw new Error('reserved address');
      } catch {
        throw new CustomerWebhookTransportError(
          'DNS_POLICY_REJECTED',
          'webhook target address policy rejected the destination',
          false,
        );
      }

      const body = normalizedEnvelope(input.event);
      if (body.byteLength > this.options.maxPayloadBytes) {
        throw new CustomerWebhookTransportError(
          'BODY_TOO_LARGE',
          'webhook payload exceeds the configured limit',
          false,
        );
      }
      const timestampSeconds = Math.floor(startedAt / 1000);
      const signatures = input.signingKeys.map((key) =>
        computeCustomerWebhookSignature(key, timestampSeconds, input.event.event_id, body),
      );
      let signatureHeader: string;
      try {
        signatureHeader = formatCustomerWebhookSignatureHeader(signatures);
      } catch {
        throw new CustomerWebhookTransportError('INVALID_TARGET', 'webhook signing configuration is invalid', false);
      }

      connector = this.options.createConnector({
        hostname,
        port: Number(parsed.port || 443),
        address: selected.address,
        family: selected.family,
      });
      if (typeof connector?.dispatcher?.dispatch !== 'function') {
        throw new CustomerWebhookTransportError('NETWORK_ERROR', 'webhook connector could not be created', true);
      }
      const response = await awaitWithAbort(
        this.options.fetch(urlText, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [CUSTOMER_WEBHOOK_EVENT_ID_HEADER]: input.event.event_id,
            [CUSTOMER_WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
            [CUSTOMER_WEBHOOK_SIGNATURE_HEADER]: signatureHeader,
          },
          body,
          redirect: 'manual',
          signal: controller.signal,
          dispatcher: connector.dispatcher,
        }),
        controller.signal,
      );
      cancelResponseBody(response);
      const elapsedMs = latency();
      if (!safeStatus(response.status)) {
        throw new CustomerWebhookTransportError(
          'NETWORK_ERROR',
          'webhook endpoint returned an invalid HTTP status',
          true,
          undefined,
          elapsedMs,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new CustomerWebhookTransportError(
          'REDIRECT_REJECTED',
          'webhook redirects are not followed',
          false,
          response.status,
          elapsedMs,
        );
      }
      if (response.status >= 200 && response.status < 300) {
        await disposeConnector();
        return Object.freeze({ httpStatus: response.status, latencyMs: elapsedMs });
      }
      const retryable =
        response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new CustomerWebhookTransportError(
        'HTTP_STATUS',
        'webhook endpoint returned a non-success status',
        retryable,
        response.status,
        elapsedMs,
      );
    } catch (error) {
      await disposeConnector(error instanceof Error ? error : undefined);
      if (error instanceof CustomerWebhookTransportError) throw error;
      if (timeoutReached)
        throw new CustomerWebhookTransportError('TIMEOUT', 'webhook send timed out', true, undefined, latency());
      if (parent?.aborted || controller.signal.aborted) {
        throw new CustomerWebhookTransportError('ABORTED', 'webhook send was cancelled', true, undefined, latency());
      }
      throw new CustomerWebhookTransportError(
        'NETWORK_ERROR',
        'webhook network request failed',
        true,
        undefined,
        latency(),
      );
    } finally {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
      await disposeConnector();
    }
  }
}
