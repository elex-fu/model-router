/**
 * O2 (docs/standalone-relay-capability-plan-2026-10-30.md): best-effort
 * session affinity for the classic proxy. Consecutive requests from one
 * proxy key for one model prefer the upstream that served the previous
 * request, preserving upstream conversation affinity (cache hits, provider
 * stickiness) without any cross-process state.
 *
 * Semantics: sticky within TTL and upstream availability — never a
 * correctness guarantee. The proxy clears a mapping when the sticky upstream
 * fails so the next request drifts to another candidate. Restart clears
 * everything by design.
 */

interface AffinityEntry {
  upstreamName: string;
  expiresAtMs: number;
}

export class SessionAffinityStore {
  private readonly entries = new Map<string, AffinityEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options: { maxEntries?: number; defaultTtlMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 4096;
    this.defaultTtlMs = options.defaultTtlMs ?? 10 * 60_000;
  }

  /** The upstream the key currently sticks to, or null when none/unexpired-out. */
  get(key: string, nowMs: number = Date.now()): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    // Refresh LRU recency: Map preserves insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.upstreamName;
  }

  /** Pin the key to an upstream for the TTL. */
  set(key: string, upstreamName: string, nowMs: number = Date.now()): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { upstreamName, expiresAtMs: nowMs + this.defaultTtlMs });
  }

  /** Drop the mapping (sticky upstream failed or was disabled). */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /** Number of live (not-yet-expired) mappings — for tests and metrics. */
  size(nowMs: number = Date.now()): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
      else count += 1;
      void key;
    }
    return count;
  }
}
