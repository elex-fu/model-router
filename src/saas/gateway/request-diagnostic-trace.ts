import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/** Priority for exclusive wall time attribution. Never sum inclusive spans. */
export const REQUEST_DIAGNOSTIC_PHASES = [
  'pool-checkout',
  'query',
  'transaction',
  'settle',
  'upstream-send',
  'upstream-body',
  'fast-snapshot',
  'fast-compile',
  'fast-redis',
  'fast-intent',
  'fast-lease-check',
  'fast-transport',
  'fast-receipt',
] as const;
export type RequestDiagnosticPhase = (typeof REQUEST_DIAGNOSTIC_PHASES)[number];
export type RequestDiagnosticMarker = 'upstream-send' | 'first-byte' | 'eof' | 'settled';
type Interval = readonly [number, number];
const context = new AsyncLocalStorage<RequestDiagnosticTrace>();

function union(intervals: readonly Interval[]): Interval[] {
  const result: [number, number][] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = result[result.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const duration = (intervals: readonly Interval[]) => union(intervals).reduce((sum, [a, b]) => sum + b - a, 0);

/** Opt-in, bounded, payload-free request diagnostics. No I/O or queue writes. */
export class RequestDiagnosticTrace {
  private readonly started: number;
  private readonly spans: { phase: RequestDiagnosticPhase; interval: Interval }[] = [];
  private readonly markers: Partial<Record<RequestDiagnosticMarker, number>> = {};
  private readonly counts = new Map<RequestDiagnosticPhase, { started: number; beforeUpstreamSend: number }>();
  private accepted = 0;
  private dropped = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly limit = 512,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) {
      throw new TypeError('Diagnostic span limit must be an integer between 1 and 4096');
    }
    this.started = now();
  }

  private elapsed(): number {
    return Math.max(0, this.now() - this.started);
  }

  begin(phase: RequestDiagnosticPhase): () => void {
    const count = this.counts.get(phase) ?? { started: 0, beforeUpstreamSend: 0 };
    count.started++;
    if (this.markers['upstream-send'] === undefined) count.beforeUpstreamSend++;
    this.counts.set(phase, count);
    if (this.accepted >= this.limit) {
      this.dropped++;
      return () => {};
    }
    this.accepted++;
    const start = this.elapsed();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.spans.push({ phase, interval: [start, Math.max(start, this.elapsed())] });
    };
  }

  mark(marker: RequestDiagnosticMarker): void {
    this.markers[marker] ??= this.elapsed();
  }

  snapshot() {
    let covered: Interval[] = [];
    const phases = REQUEST_DIAGNOSTIC_PHASES.map((phase) => {
      const intervals = this.spans.filter((span) => span.phase === phase).map((span) => span.interval);
      const inclusiveMs = duration(intervals);
      const combined = union([...covered, ...intervals]);
      const exclusiveMs = Math.max(0, duration(combined) - duration(covered));
      covered = combined;
      const count = this.counts.get(phase);
      return {
        phase,
        inclusiveMs,
        exclusiveMs,
        // Attempted client operations, including pending/dropped timing spans;
        // never PostgreSQL nested statements or a count of distinct SQL text.
        startedCount: count?.started ?? 0,
        beforeUpstreamSendCount: count?.beforeUpstreamSend ?? 0,
      };
    });
    return {
      elapsedMs: this.elapsed(),
      markers: { ...this.markers },
      phases,
      observedExclusiveMs: duration(covered),
      pendingSpans: this.accepted - this.spans.length,
      droppedSpans: this.dropped,
    };
  }
}

export function withRequestDiagnosticTrace<T>(trace: RequestDiagnosticTrace, work: () => T): T {
  return context.run(trace, work);
}

export function currentRequestDiagnosticTrace(): RequestDiagnosticTrace | undefined {
  return context.getStore();
}

/** Zero clocks or logs when diagnostics are disabled; fixed phase names only. */
export function observeRequestDiagnosticPhase<T>(phase: RequestDiagnosticPhase, work: () => Promise<T>): Promise<T> {
  const trace = currentRequestDiagnosticTrace();
  if (!trace) return work();
  const finish = trace.begin(phase);
  try {
    return work().finally(finish);
  } catch (error) {
    finish();
    throw error;
  }
}
