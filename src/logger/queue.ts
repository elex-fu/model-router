import type { LogStore } from './store.js';
import type { LogEntry } from './types.js';

export class LogQueue {
  private store: LogStore;
  private intervalMs: number;
  private batchSize: number;
  private pending: LogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(store: LogStore, intervalMs: number, batchSize: number) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.flushing;
    // An in-flight batch may have failed and put its uncommitted rows back.
    if (this.pending.length > 0) await this.flush();
    if (this.pending.length > 0) throw new Error('Log queue could not flush all pending rows');
  }

  enqueue(entry: LogEntry): void {
    if (this.stopped) return;
    this.pending.push(entry);
    if (this.pending.length >= this.batchSize) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return this.flushing;
    const batch = this.pending.splice(0, this.pending.length);
    this.flushing = this.flushing
      .then(async () => {
        while (batch.length > 0) {
          const chunk = batch.slice(0, this.batchSize);
          await this.store.insertBatch(chunk);
          batch.splice(0, chunk.length);
        }
      })
      .catch((err) => {
        this.pending = batch.concat(this.pending);
        console.error('Failed to flush logs:', err);
      });
    return this.flushing;
  }
}
