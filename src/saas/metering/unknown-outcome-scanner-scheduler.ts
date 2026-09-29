import type {
  UnknownOutcomeReconciliationWorker,
  UnknownOutcomeRecoveryRunResult,
} from './unknown-outcome-recovery-worker.js';

const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 60_000;

export interface UnknownOutcomeScannerWorker {
  runOnce(): Promise<UnknownOutcomeRecoveryRunResult>;
}

export interface UnknownOutcomeScannerSchedulerOptions {
  /** Bounded delay between completed scan cycles. */
  readonly intervalMs?: number;
  /** Receives no error details or tenant/case data. */
  readonly onError?: () => void;
  /** Receives only the number of cases surfaced by the completed cycle. */
  readonly onOperatorRequired?: (count: number) => void;
  /** Receives only the number of claims that failed during the completed cycle. */
  readonly onFailed?: (count: number) => void;
}

export interface UnknownOutcomeScannerHandle {
  stop(): Promise<void>;
}

function observe(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Logging and alerting observers cannot terminate the scanner.
  }
}

function observeCount(callback: ((count: number) => void) | undefined, count: number): void {
  try {
    callback?.(count);
  } catch {
    // Logging and alerting observers cannot terminate the scanner.
  }
}

/** Polls the durable scanner without overlapping cycles or logging sensitive case data. */
export function startUnknownOutcomeScanner(
  worker: UnknownOutcomeScannerWorker | Pick<UnknownOutcomeReconciliationWorker, 'runOnce'>,
  options: UnknownOutcomeScannerSchedulerOptions = {},
): UnknownOutcomeScannerHandle {
  if (!worker || typeof worker.runOnce !== 'function') {
    throw new TypeError('unknown-outcome scanner worker is required');
  }
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new RangeError('Unknown-outcome scanner interval must be between 50 and 60000 ms');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, intervalMs);
    timer.unref();
  };

  const tick = (): void => {
    if (stopped || running !== undefined) return;
    running = Promise.resolve()
      .then(() => worker.runOnce())
      .then(
        (result) => {
          if (result.operatorRequired.length > 0) {
            observeCount(options.onOperatorRequired, result.operatorRequired.length);
          }
          if (result.failed > 0) observeCount(options.onFailed, result.failed);
          schedule();
        },
        () => {
          observe(options.onError);
          schedule();
        },
      )
      .finally(() => {
        running = undefined;
      });
  };

  schedule();
  return {
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        await running;
      })();
      return stopPromise;
    },
  };
}
