import type { CustomerWebhookEgressTransport } from './egress-transport.js';
import { CustomerWebhookTransportError } from './egress-transport.js';
import {
  type ClaimedCustomerWebhookDelivery,
  CUSTOMER_WEBHOOK_MAX_ATTEMPTS,
  CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE,
  CUSTOMER_WEBHOOK_MAX_LEASE_MS,
  type PostgresCustomerWebhookDeliveryStore,
} from './postgres-store.js';
import {
  assertUnprotectedWebhookSecret,
  type WebhookSigningSecretProtector,
  webhookSigningSecretAad,
} from './signing-secret-protector.js';

export interface CustomerWebhookWorkerOptions {
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface CustomerWebhookWorkerResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly deadLettered: number;
  readonly stale: number;
}

interface NormalizedWorkerOptions {
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

function validateOptions(options: CustomerWebhookWorkerOptions): NormalizedWorkerOptions {
  const concurrency = options.concurrency ?? 8;
  const leaseMs = options.leaseMs ?? 60_000;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE) {
    throw new RangeError(`concurrency must be between 1 and ${CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE}`);
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > CUSTOMER_WEBHOOK_MAX_LEASE_MS) {
    throw new RangeError(`leaseMs must be between 1 and ${CUSTOMER_WEBHOOK_MAX_LEASE_MS}`);
  }
  if (
    !Number.isSafeInteger(baseBackoffMs) ||
    baseBackoffMs < 10 ||
    !Number.isSafeInteger(maxBackoffMs) ||
    maxBackoffMs < baseBackoffMs ||
    maxBackoffMs > 24 * 60 * 60 * 1000
  ) {
    throw new RangeError('webhook worker backoff bounds are invalid');
  }
  return { concurrency, leaseMs, baseBackoffMs, maxBackoffMs };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/** One bounded poll/dispatch pass. Persisted delivery rows and fencing make restarts idempotent. */
export class CustomerWebhookDeliveryWorker {
  private readonly options: NormalizedWorkerOptions;

  constructor(
    private readonly store: PostgresCustomerWebhookDeliveryStore,
    private readonly protector: WebhookSigningSecretProtector,
    private readonly transport: CustomerWebhookEgressTransport,
    options: CustomerWebhookWorkerOptions = {},
  ) {
    this.options = validateOptions(options);
    if (protector?.purpose !== 'customer-webhook-signing-secret-v1') {
      throw new TypeError('a dedicated customer webhook signing-secret protector is required');
    }
  }

  async runOnce(signal?: AbortSignal): Promise<CustomerWebhookWorkerResult> {
    if (isAborted(signal)) return Object.freeze({ claimed: 0, delivered: 0, retrying: 0, deadLettered: 0, stale: 0 });
    const deliveries = await this.store.claimReady(this.options.concurrency, this.options.leaseMs);
    const outcomeCounts = { delivered: 0, retrying: 0, deadLettered: 0, stale: 0 };
    let cursor = 0;
    const runners = Array.from({ length: Math.min(this.options.concurrency, deliveries.length) }, async () => {
      while (cursor < deliveries.length) {
        const delivery = deliveries[cursor];
        cursor += 1;
        if (!delivery) continue;
        const outcome = await this.deliverOne(delivery, signal);
        outcomeCounts[outcome] += 1;
      }
    });
    await Promise.all(runners);
    return Object.freeze({ claimed: deliveries.length, ...outcomeCounts });
  }

  private async deliverOne(
    delivery: ClaimedCustomerWebhookDelivery,
    signal?: AbortSignal,
  ): Promise<keyof Omit<CustomerWebhookWorkerResult, 'claimed'>> {
    const plaintextKeys: Array<{ version: number; secret: Uint8Array }> = [];
    let failure: { code: string; retryable: boolean; httpStatus?: number; latencyMs?: number } | undefined;
    let sendResult: { httpStatus: number; latencyMs: number } | undefined;
    try {
      if (isAborted(signal)) throw new CustomerWebhookTransportError('ABORTED', 'webhook worker was cancelled', true);
      for (const snapshot of delivery.signingSecrets) {
        const plaintext = await this.protector.unprotect(
          snapshot.envelope,
          webhookSigningSecretAad({
            tenantId: delivery.tenantId,
            endpointId: delivery.endpointId,
            secretVersion: snapshot.version,
          }),
        );
        try {
          assertUnprotectedWebhookSecret(plaintext);
          plaintextKeys.push({ version: snapshot.version, secret: Buffer.from(plaintext) });
        } finally {
          plaintext.fill(0);
        }
      }
      if (isAborted(signal)) throw new CustomerWebhookTransportError('ABORTED', 'webhook worker was cancelled', true);
      sendResult = await this.transport.send({
        targetUrl: delivery.targetUrl,
        event: delivery.event,
        signingKeys: plaintextKeys,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof CustomerWebhookTransportError) {
        failure = {
          code: error.code,
          retryable: error.retryable,
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
          ...(error.latencyMs === undefined ? {} : { latencyMs: error.latencyMs }),
        };
      } else {
        // Protector errors are intentionally collapsed; never persist KMS/provider error text.
        failure = { code: 'SIGNING_SECRET_UNAVAILABLE', retryable: true };
      }
    } finally {
      for (const key of plaintextKeys) key.secret.fill(0);
      for (const snapshot of delivery.signingSecrets) {
        if (snapshot.envelope instanceof Uint8Array) snapshot.envelope.fill(0);
      }
    }

    if (sendResult) {
      const accepted = await this.store.markDelivered({
        tenantId: delivery.tenantId,
        deliveryId: delivery.deliveryId,
        leaseToken: delivery.leaseToken,
        fencingToken: delivery.fencingToken,
        httpStatus: sendResult.httpStatus,
        latencyMs: sendResult.latencyMs,
      });
      return accepted ? 'delivered' : 'stale';
    }

    const outcome = await this.store.recordFailure(
      {
        tenantId: delivery.tenantId,
        deliveryId: delivery.deliveryId,
        leaseToken: delivery.leaseToken,
        fencingToken: delivery.fencingToken,
        errorCode: failure?.code ?? 'WORKER_FAILURE',
        retryable: failure?.retryable ?? true,
        ...(failure?.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        ...(failure?.latencyMs === undefined ? {} : { latencyMs: failure.latencyMs }),
      },
      { baseBackoffMs: this.options.baseBackoffMs, maxBackoffMs: this.options.maxBackoffMs },
    );
    if (outcome === 'dead_lettered') return 'deadLettered';
    return outcome;
  }
}

export const CUSTOMER_WEBHOOK_WORKER_MAX_ATTEMPTS = CUSTOMER_WEBHOOK_MAX_ATTEMPTS;
