import { performance } from 'node:perf_hooks';
import type {
  ProviderHttpConnectorInput,
  ProviderHttpPinnedConnector,
  ProviderHttpPinnedConnectorFactory,
} from '../provider-http-address.js';

interface Entry {
  readonly key: string;
  readonly connector: ProviderHttpPinnedConnector;
  idleAt: number | null;
  removed: boolean;
}
export interface FastPinnedConnectorPoolOptions {
  /** One immutable TLS/CA/ALPN factory per pool. Never share a pool across deployments. */
  readonly createConnector: ProviderHttpPinnedConnectorFactory;
  readonly maximumEntries?: number;
  readonly idleTtlMs?: number;
  readonly monotonicNow?: () => number;
}

/** Request-exclusive borrowing: one active response owns one dispatcher.
 * Callers MUST first perform normal per-request URL/DNS/IP policy validation.
 * The approved address is part of the key, so pooling never overrides new DNS.
 * CA/ALPN/default TLS policy are fixed by the instance's immutable base factory.
 */
export class FastPinnedConnectorPool {
  readonly #entries = new Set<Entry>();
  readonly #idle = new Map<Entry, true>();
  readonly #byKey = new Map<string, Set<Entry>>();
  readonly #cleanup = new Set<Promise<void>>();
  readonly #maximum: number;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #factory: ProviderHttpPinnedConnectorFactory;
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(options: FastPinnedConnectorPoolOptions) {
    this.#maximum = options.maximumEntries ?? 256;
    this.#ttl = options.idleTtlMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#maximum) ||
      this.#maximum < 1 ||
      this.#maximum > 4096 ||
      !Number.isSafeInteger(this.#ttl) ||
      this.#ttl < 1 ||
      this.#ttl > 300_000
    )
      throw new Error('Invalid fast connector pool bounds');
    this.#factory = options.createConnector;
    this.#now = options.monotonicNow ?? (() => performance.now());
    this.#timer = setInterval(() => this.#expire(), Math.min(this.#ttl, 1000));
    this.#timer.unref();
  }

  readonly createConnector: ProviderHttpPinnedConnectorFactory = (input: ProviderHttpConnectorInput) => {
    if (this.#closed) throw new Error('Fast connector pool closed');
    // A later feature must define full proxy authentication/fingerprint keys.
    // Never accidentally pool them under the simpler direct-TLS identity.
    if (input.proxy !== undefined || input.tlsFingerprint !== undefined)
      throw new Error('Unsupported fast pooled transport');
    this.#expire();
    const key = JSON.stringify([input.hostname, input.port, input.address, input.family]);
    let entry = this.#byKey.get(key)?.values().next().value as Entry | undefined;
    if (entry) this.#removeIdle(entry);
    else {
      // Pending closes are bounded too; slow TLS cleanup cannot accumulate an
      // unbounded queue during endpoint churn (at most twice the live budget).
      if (this.#entries.size + this.#cleanup.size >= this.#maximum * 2)
        throw new Error('Fast connector cleanup saturated');
      while (this.#entries.size >= this.#maximum) {
        const oldest = this.#idle.keys().next().value;
        if (!oldest) throw new Error('Fast connector capacity exhausted');
        this.#retire(oldest);
      }
      entry = { key, connector: this.#factory(input), idleAt: null, removed: false };
      this.#entries.add(entry);
    }
    const borrowed = entry;
    let released = false;
    return {
      dispatcher: borrowed.connector.dispatcher,
      close: async () => {
        if (released) return;
        released = true;
        if (this.#closed || borrowed.removed) {
          await this.#retire(borrowed);
          return;
        }
        borrowed.idleAt = this.#now();
        this.#idle.set(borrowed, true);
        let entries = this.#byKey.get(key);
        if (!entries) {
          entries = new Set();
          this.#byKey.set(key, entries);
        }
        entries.add(borrowed);
      },
      destroy: async (error?: Error) => {
        if (released) return;
        released = true;
        await this.#retire(borrowed, error ?? new Error('Borrowed fast connector canceled'));
      },
    };
  };

  #removeIdle(entry: Entry): void {
    this.#idle.delete(entry);
    const entries = this.#byKey.get(entry.key);
    entries?.delete(entry);
    if (entries?.size === 0) this.#byKey.delete(entry.key);
    entry.idleAt = null;
  }
  #expire(): void {
    const cutoff = this.#now() - this.#ttl;
    for (const entry of this.#idle.keys()) {
      if (entry.idleAt !== null && entry.idleAt > cutoff) break;
      this.#retire(entry);
    }
  }
  #retire(entry: Entry, error?: Error): Promise<void> {
    if (entry.removed) return Promise.resolve();
    entry.removed = true;
    this.#removeIdle(entry);
    this.#entries.delete(entry);
    const work = (async () => {
      try {
        if (error) await entry.connector.destroy(error);
        else await entry.connector.close();
      } catch {
        try {
          await entry.connector.destroy(new Error('Fast connector cleanup failed'));
        } catch {
          /* Disposal cannot grant authority or reject cleanup ownership. */
        }
      }
    })();
    this.#cleanup.add(work);
    void work.finally(() => this.#cleanup.delete(work));
    return work;
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const entry of this.#entries) this.#retire(entry);
    await Promise.all([...this.#cleanup]);
  }
}
