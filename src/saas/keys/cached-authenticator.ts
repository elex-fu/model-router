import { createHash } from 'node:crypto';
import type { ProxyKeyAuthenticator } from '../gateway/http-handler.js';
import type { AuthenticatedApiKey } from './types.js';

/** Bounded, positive-only process cache; admission still revalidates authorization versions. */
export class CachedKeyAuthenticator implements ProxyKeyAuthenticator {
  private readonly entries = new Map<string, { until: number; value: AuthenticatedApiKey }>();
  private readonly pending = new Map<string, Promise<AuthenticatedApiKey | null>>();
  constructor(
    private readonly source: ProxyKeyAuthenticator,
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    for (const n of [options.ttlMs ?? 5000, options.maxEntries ?? 4096])
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid authentication cache bounds');
  }
  async authenticate(rawKey: string): Promise<AuthenticatedApiKey | null> {
    if (typeof rawKey !== 'string' || rawKey.length > 512 || rawKey.length === 0) return null;
    const now = this.options.now ?? Date.now;
    const digest = createHash('sha256').update(rawKey).digest('hex');
    const cached = this.entries.get(digest);
    if (cached && cached.until > now()) {
      this.entries.delete(digest);
      this.entries.set(digest, cached);
      return structuredClone(cached.value);
    }
    this.entries.delete(digest);
    const existing = this.pending.get(digest);
    if (existing) return structuredClone(await existing);
    if (this.pending.size >= (this.options.maxEntries ?? 4096)) throw new Error('Authentication cache queue full');
    const observedAt = now();
    const operation = this.source
      .authenticate(rawKey)
      .then((value) => {
        if (value) {
          const expiresAt = value.metadata.expiresAt === null ? Infinity : Date.parse(value.metadata.expiresAt);
          const until = Math.min(observedAt + (this.options.ttlMs ?? 5000), expiresAt);
          if (until > now()) {
            while (this.entries.size >= (this.options.maxEntries ?? 4096))
              this.entries.delete(this.entries.keys().next().value!);
            this.entries.set(digest, { until, value: structuredClone(value) });
          }
        }
        return value;
      })
      .finally(() => this.pending.delete(digest));
    this.pending.set(digest, operation);
    return structuredClone(await operation);
  }
}
