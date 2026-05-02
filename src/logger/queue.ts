import type { LogStore } from './store.js';
import type { LogEntry } from './types.js';

export class LogQueue {
  private store: LogStore;
  private intervalMs: number;
  private batchSize: number;
  private pending: LogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(store: LogStore, intervalMs: number, batchSize: number) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  enqueue(entry: LogEntry): void {
    if (this.stopped) return;
    this.pending.push(entry);
    if (this.pending.length >= this.batchSize) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      // further cap to batchSize in case of burst
      while (batch.length > 0) {
        const chunk = batch.splice(0, this.batchSize);
        await this.store.insertBatch(chunk);
      }
    } catch (err) {
      console.error('Failed to flush logs:', err);
    }
  }
}
