import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { QuotaAdmission, QuotaDecision } from './ledger.js';
import type { QuotaStateBatch, QuotaStatePersistence, QuotaStateRow } from './redis-state.js';

type Reply = { kind: 'ready' | 'result' | 'fatal' | 'closed'; id?: number; value?: unknown; error?: string };

/** Immediate business-state RPCs. This worker never waits for or writes observation logs. */
export class QuotaWriteClient implements QuotaStatePersistence {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private failure?: Error;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  private constructor(dbPath: string, namespace: string) {
    const sourceMode = __filename.endsWith('.ts');
    this.worker = new Worker(join(__dirname, sourceMode ? 'write-worker.ts' : 'write-worker.js'), {
      workerData: { dbPath, namespace },
      execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [],
    });
    this.worker.on('message', (reply: Reply) => {
      if (reply.kind === 'ready') this.readyResolve();
      else if (reply.kind === 'fatal') this.fail(new Error(reply.error ?? 'Quota worker failed'));
      else if (reply.kind === 'closed') this.closed = true;
      else if (reply.kind === 'result' && reply.id !== undefined) {
        const operation = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (reply.error) operation?.reject(new Error(reply.error));
        else operation?.resolve(reply.value);
      }
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Quota worker exited unexpectedly (${code})`));
    });
  }

  static async open(dbPath: string, namespace = 'model-router'): Promise<QuotaWriteClient> {
    const client = new QuotaWriteClient(dbPath, namespace);
    try {
      await client.ready;
      return client;
    } catch (error) {
      await client.worker.terminate();
      throw error;
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rpc<T>(operation: string, input: unknown = null): Promise<T> {
    if (this.failure || this.closing || this.closed)
      return Promise.reject(this.failure ?? new Error('Quota worker is closed'));
    if (this.pending.size >= 1024) return Promise.reject(new Error('Quota operation queue is full'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ kind: 'operation', id, operation, input });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  admit(input: QuotaAdmission): Promise<QuotaDecision> {
    return this.rpc('admit', input);
  }
  topUp(requestId: string, extraTokens: number, dailyTokens?: number, reportedTokensSoFar = 0): Promise<QuotaDecision> {
    return this.rpc('topUp', { requestId, extraTokens, dailyTokens, reportedTokensSoFar });
  }
  markAttemptSent(requestId: string, attemptId?: string): Promise<void> {
    return this.rpc('markAttemptSent', { requestId, attemptId });
  }
  recordAttemptUsage(requestId: string, attemptId: string, reportedTokens: number): Promise<void> {
    return this.rpc('recordAttemptUsage', { requestId, attemptId, reportedTokens });
  }
  settle(requestId: string, reportedTokens: number | null, unknownSentAttempts?: number): Promise<void> {
    return this.rpc('settle', { requestId, reportedTokens, unknownSentAttempts });
  }
  ping(generation?: number): Promise<void> {
    return generation === undefined ? this.rpc('ping') : this.rpc('state.ping', generation);
  }
  identity(): Promise<string> {
    return this.rpc('state.identity');
  }
  generation(): Promise<number> {
    return this.rpc('state.generation');
  }
  beginGeneration(expected: number): Promise<number> {
    return this.rpc('state.beginGeneration', expected);
  }
  load(keys: string[]): Promise<QuotaStateRow[]> {
    return this.rpc('state.load', keys);
  }
  apply(batches: QuotaStateBatch[]): Promise<void> {
    return this.rpc('state.apply', batches);
  }
  expiredRequests(nowMs: number, limit: number): Promise<string[]> {
    return this.rpc('state.expiredRequests', { nowMs, limit });
  }

  close(timeoutMs = 5_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.failure)
      return this.worker.terminate().then(() => {
        throw this.failure;
      });
    this.closing = true;
    this.closePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Quota worker drain timed out');
        this.fail(error);
        void this.worker.terminate().then(() => reject(error));
      }, timeoutMs);
      this.worker.once('exit', () => {
        clearTimeout(timer);
        if (this.failure || !this.closed) reject(this.failure ?? new Error('Quota worker did not close cleanly'));
        else resolve();
      });
      // MessagePort FIFO orders close after all accepted business transactions.
      this.worker.postMessage({ kind: 'close' });
    });
    return this.closePromise;
  }
}
