import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { QuotaAdmission, QuotaDecision } from '../quota/ledger.js';
import type { AttemptRecord, RequestRecord } from '../telemetry/types.js';

export class TelemetryWriteQueueFullError extends Error {
  constructor() {
    super('Telemetry writer queue is full; request admission refused');
  }
}
export class TelemetryRecorderDegradedError extends Error {
  constructor(message = 'Telemetry recorder is degraded; request admission refused') {
    super(message);
  }
}

export interface TelemetryWriterStatus {
  degraded: boolean;
  reason: string | null;
  pendingEvents: number;
  retainedEvents: number;
}

type WriteEvent = { operation: 'request'; record: RequestRecord } | { operation: 'attempt'; record: AttemptRecord };
type Pending = { resolve: (value?: unknown) => void; reject: (error: Error) => void; queuedAt?: number; postedAt?: number };
type Reply = {
  kind: 'ready' | 'committed' | 'rpc-result' | 'status' | 'fatal' | 'closed';
  id?: number;
  ids?: number[];
  ok?: boolean;
  value?: unknown;
  error?: string;
  degraded?: boolean;
  reason?: string | null;
  retainedEvents?: number;
};

const perfEnabled = process.env.MODEL_ROUTER_PERF === '1';
function reportWriteBatch(samples: Array<{ queueMs: number; workerAckMs: number; totalMs: number }>): void {
  if (!perfEnabled || !samples.length) return;
  process.stderr.write(`${JSON.stringify({ kind: 'telemetry-write-perf', batchSize: samples.length,
    queueMs: samples.map((item) => Math.round(item.queueMs * 100) / 100),
    workerAckMs: samples.map((item) => Math.round(item.workerAckMs * 100) / 100),
    enqueueToCommitMs: samples.map((item) => Math.round(item.totalMs * 100) / 100) })}\n`);
}

/** Worker RPC with bounded buffering. All writes resolve only after a durable batch commit. */
export class TelemetryWriteClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly writeBuffer: Array<{ id: number; event: WriteEvent }> = [];
  private sequence = 0;
  private state: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting';
  private failure: Error | undefined;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private flushTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  private closeResolve?: () => void;
  private closeReject?: (error: Error) => void;
  private closeSent = false;
  private degraded = false;
  private degradedReason: string | null = null;
  private retainedEvents = 0;

  private constructor(
    dbPath: string,
    private readonly maxPending: number,
  ) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('maxPending must be positive');
    const sourceMode = __filename.endsWith('.ts');
    const entry = join(__dirname, sourceMode ? 'telemetry-write-worker.ts' : 'telemetry-write-worker.js');
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker = new Worker(entry, {
      workerData: { dbPath, maxPending },
      execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [],
    });
    this.worker.on('message', (reply: Reply) => this.onReply(reply));
    this.worker.once('error', (error) => this.fail(error));
    this.worker.once('exit', (code) => {
      if (this.state !== 'closed') this.fail(new Error(`Telemetry write worker exited before close (${code})`));
    });
  }

  static async open(dbPath: string, options: { maxPending?: number } = {}): Promise<TelemetryWriteClient> {
    const client = new TelemetryWriteClient(dbPath, options.maxPending ?? 1024);
    try {
      await client.ready;
      return client;
    } catch (error) {
      await client.worker.terminate();
      throw error;
    }
  }

  getStatus(): TelemetryWriterStatus {
    return {
      degraded: this.degraded || this.state === 'failed',
      reason: this.degradedReason ?? (this.state === 'failed' ? (this.failure?.message ?? 'worker_failed') : null),
      pendingEvents: this.pending.size,
      retainedEvents: this.retainedEvents,
    };
  }

  private onReply(reply: Reply): void {
    if (reply.kind === 'ready' && this.state === 'starting') {
      this.state = 'open';
      this.readyResolve();
      return;
    }
    if (reply.kind === 'status') {
      this.retainedEvents = reply.retainedEvents ?? this.retainedEvents;
      if (reply.degraded) {
        this.degraded = true;
        this.degradedReason = reply.reason ?? 'write_failed';
      } else if (this.degradedReason !== 'queue_overflow') {
        this.degraded = false;
        this.degradedReason = null;
      }
      return;
    }
    if (reply.kind === 'fatal') {
      this.fail(new Error(reply.error ?? 'Telemetry worker failed'));
      return;
    }
    if (reply.kind === 'closed') {
      this.state = 'closed';
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeResolve?.();
      return;
    }
    if (reply.kind === 'committed') {
      const now = perfEnabled ? performance.now() : 0;
      const samples: Array<{ queueMs: number; workerAckMs: number; totalMs: number }> = [];
      for (const id of reply.ids ?? []) {
        const pending = this.pending.get(id);
        if (pending?.queuedAt !== undefined && pending.postedAt !== undefined)
          samples.push({ queueMs: pending.postedAt - pending.queuedAt,
            workerAckMs: now - pending.postedAt, totalMs: now - pending.queuedAt });
        this.settlePending(id);
      }
      reportWriteBatch(samples);
      this.maybeFinishClose();
      return;
    }
    if (reply.kind === 'rpc-result' && typeof reply.id === 'number') {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error ?? 'Telemetry worker RPC failed'));
      this.maybeFinishClose();
    }
  }

  private settlePending(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve();
  }

  private fail(error: Error): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.failure = error;
    this.degraded = true;
    this.degradedReason = 'worker_failed';
    const starting = this.state === 'starting';
    this.state = 'failed';
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (starting) this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.writeBuffer.length = 0;
    this.closeReject?.(error);
  }

  private markDegraded(reason: string): void {
    this.degraded = true;
    this.degradedReason = reason;
    try {
      this.worker.postMessage({ kind: 'mark-degraded', reason });
    } catch {
      /* existing failure is reported through status */
    }
  }

  private reservePending(): number {
    if (this.state !== 'open') throw this.failure ?? new Error('Telemetry writer is closed');
    if (this.pending.size >= this.maxPending) {
      this.markDegraded('queue_overflow');
      throw new TelemetryWriteQueueFullError();
    }
    const id = ++this.sequence;
    return id;
  }

  private write(event: WriteEvent): Promise<void> {
    if (this.getStatus().degraded) return Promise.reject(new TelemetryRecorderDegradedError());
    let id: number;
    try {
      id = this.reservePending();
    } catch (error) {
      return Promise.reject(error);
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject, ...(perfEnabled ? { queuedAt: performance.now() } : {}) });
    });
    this.writeBuffer.push({ id, event });
    if (this.writeBuffer.length >= 100) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250);
    return promise;
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.writeBuffer.length || this.state === 'failed' || this.state === 'closed') return;
    while (this.writeBuffer.length) {
      const items = this.writeBuffer.splice(0, 100);
      try {
        if (perfEnabled) {
          const postedAt = performance.now();
          for (const item of items) {
            const pending = this.pending.get(item.id);
            if (pending) pending.postedAt = postedAt;
          }
        }
        this.worker.postMessage({ kind: 'write-batch', items });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private async rpc<T>(operation: string, input: unknown): Promise<T> {
    this.flush();
    const id = this.reservePending();
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v?: unknown) => void, reject });
    });
    try {
      this.worker.postMessage({ kind: 'quota', id, operation, input });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  async admit(input: QuotaAdmission): Promise<QuotaDecision> {
    if (this.getStatus().degraded) return { allowed: false, reason: 'recorder_degraded' };
    return this.rpc<QuotaDecision>('admit', input);
  }
  topUp(requestId: string, extraTokens: number, dailyTokens?: number, reportedTokensSoFar = 0): Promise<QuotaDecision> {
    return this.rpc('topUp', { requestId, extraTokens, dailyTokens, reportedTokensSoFar });
  }
  markAttemptSent(requestId: string): Promise<void> {
    return this.rpc('markAttemptSent', { requestId });
  }
  settle(requestId: string, reportedTokens: number | null, unknownSentAttempts?: number): Promise<void> {
    return this.rpc('settle', { requestId, reportedTokens, unknownSentAttempts });
  }

  upsertRequest(record: RequestRecord): Promise<void> {
    return this.write({ operation: 'request', record });
  }
  upsertAttempt(record: AttemptRecord): Promise<void> {
    return this.write({ operation: 'attempt', record });
  }

  private maybeFinishClose(): void {
    if (this.state !== 'closing' || this.pending.size || this.writeBuffer.length || this.closeSent) return;
    this.closeSent = true;
    try {
      this.worker.postMessage({ kind: 'close' });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(timeoutMs = 5_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return Promise.resolve();
    if (this.state === 'failed') return Promise.reject(this.failure);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      return Promise.reject(new Error('timeoutMs must be positive'));
    this.state = 'closing';
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
    this.closeTimer = setTimeout(() => {
      const error = new Error(`Telemetry writer did not drain within ${timeoutMs}ms`);
      void this.worker.terminate().finally(() => this.fail(error));
    }, timeoutMs);
    this.flush();
    this.maybeFinishClose();
    this.closePromise
      .finally(() => {
        if (this.closeTimer) clearTimeout(this.closeTimer);
      })
      .catch(() => {});
    return this.closePromise;
  }
}
