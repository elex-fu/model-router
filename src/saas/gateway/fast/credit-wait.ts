import { performance } from 'node:perf_hooks';

export type FastCreditWaitResult = 'completed' | 'cancelled' | 'authority_expired' | 'budget_exhausted';

/** Internal clock port permits exact timer-boundary tests without PostgreSQL sleeps. */
export interface FastCreditWaitClock {
  wallNow(): number;
  monotonicNow(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const systemClock: FastCreditWaitClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Stop waiting, never cancel or reinterpret the tracked durable transaction. */
export function waitForFastCreditWork(
  work: Promise<void>,
  input: { readonly sendDeadlineMs: number; readonly signal?: AbortSignal },
  recoveryDeadline = Number.POSITIVE_INFINITY,
  clock: FastCreditWaitClock = systemClock,
): Promise<FastCreditWaitResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimer: (() => void) | undefined;
    const cleanup = () => {
      cancelTimer?.();
      input.signal?.removeEventListener('abort', abort);
    };
    const finish = (result: FastCreditWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const boundary = (): FastCreditWaitResult | undefined => {
      if (input.signal?.aborted) return 'cancelled';
      if (clock.wallNow() >= input.sendDeadlineMs) return 'authority_expired';
      if (clock.monotonicNow() >= recoveryDeadline) return 'budget_exhausted';
      return undefined;
    };
    const abort = () => finish('cancelled');
    const wake = () => {
      if (settled) return;
      const stopped = boundary();
      if (stopped) return finish(stopped);
      // Node/libuv timer quantization can wake before the requested boundary.
      // Recheck both clocks; ceil and a 1ms floor prevent premature denial/spin.
      const remaining = Math.min(input.sendDeadlineMs - clock.wallNow(), recoveryDeadline - clock.monotonicNow());
      cancelTimer = clock.schedule(wake, Math.max(1, Math.ceil(remaining)));
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    work.then(
      () => finish(boundary() ?? 'completed'),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    wake();
  });
}
