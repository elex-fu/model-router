import type { PaymentWebhookWorkerBatchResult } from './types.js';

export interface PaymentWebhookWorkerPort {
  processPendingWebhooks(limit?: number): Promise<PaymentWebhookWorkerBatchResult>;
}

export interface PaymentWebhookWorkerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: () => void;
  readonly onExhausted?: (count: number) => void;
}

export interface PaymentWebhookWorkerHandle {
  stop(): Promise<void>;
}

/** Polls the durable inbox without overlapping batches; each claim is DB-leased for multi-instance safety. */
export function startPaymentWebhookWorker(
  service: PaymentWebhookWorkerPort,
  options: PaymentWebhookWorkerOptions = {},
): PaymentWebhookWorkerHandle {
  const intervalMs = options.intervalMs ?? 1_000;
  const batchSize = options.batchSize ?? 20;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) {
    throw new RangeError('Payment webhook worker interval must be between 50 and 60000 ms');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Payment webhook worker batch size must be between 1 and 100');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = (): void => {
    if (stopped || running) return;
    running = service
      .processPendingWebhooks(batchSize)
      .then((result) => {
        if (result.exhausted > 0) {
          try {
            options.onExhausted?.(result.exhausted);
          } catch {
            // A logging hook must not stop the durable worker loop.
          }
        }
        schedule(result.claimed === batchSize ? 0 : intervalMs);
      })
      .catch(() => {
        try {
          options.onError?.();
        } catch {
          // A logging hook must not stop the durable worker loop.
        }
        schedule(intervalMs);
      })
      .finally(() => {
        running = undefined;
      });
  };

  tick();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
