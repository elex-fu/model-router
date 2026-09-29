import type { PaymentRefundWorkerBatchResult } from './types.js';

export interface PaymentRefundWorkerPort {
  processPendingRefunds(limit?: number): Promise<PaymentRefundWorkerBatchResult>;
}

export interface PaymentRefundWorkerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: () => void;
  readonly onUnresolved?: (count: number) => void;
}

export interface PaymentRefundWorkerHandle {
  stop(): Promise<void>;
}

/** Polls refund reconciliation; the database lease fences work across instances. */
export function startPaymentRefundWorker(
  service: PaymentRefundWorkerPort,
  options: PaymentRefundWorkerOptions = {},
): PaymentRefundWorkerHandle {
  const intervalMs = options.intervalMs ?? 5_000;
  const batchSize = options.batchSize ?? 20;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) {
    throw new RangeError('Payment refund worker interval must be between 50 and 60000 ms');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Payment refund worker batch size must be between 1 and 100');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => tick(), delayMs);
    timer.unref();
  };

  const tick = (): void => {
    if (stopped || running) return;
    running = service
      .processPendingRefunds(batchSize)
      .then((result) => {
        if (result.unresolved > 0) {
          try {
            options.onUnresolved?.(result.unresolved);
          } catch {
            // Metrics and alert hooks cannot stop reconciliation.
          }
        }
        schedule(result.claimed === batchSize ? 0 : intervalMs);
      })
      .catch(() => {
        try {
          options.onError?.();
        } catch {
          // A hook failure cannot stop the durable worker.
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
