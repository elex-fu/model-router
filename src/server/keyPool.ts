interface KeyState {
  credentialId: string;
  key: string;
  failures: number;
  cooledUntil: number;
}

export interface KeyPoolOptions {
  cooldownMs?: number;
  maxFailures?: number;
  strategy?: 'round-robin' | 'random';
}

export type KeyPoolEntry = { credentialId: string; key: string };
type KeyPoolInput = Array<string | KeyPoolEntry>;
type KeyPoolIdentity = string | KeyPoolEntry;

function normalizeEntries(entries: KeyPoolInput): KeyPoolEntry[] {
  return entries.map((entry) =>
    typeof entry === 'string' ? { credentialId: entry, key: entry } : entry,
  );
}

export class KeyPool {
  private states = new Map<string, KeyState[]>();
  private lastIndex = new Map<string, number>();
  private cooldownMs: number;
  private maxFailures: number;
  private strategy: 'round-robin' | 'random';

  constructor(options: KeyPoolOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 5 * 60 * 1000;
    this.maxFailures = options.maxFailures ?? 3;
    this.strategy = options.strategy ?? 'round-robin';
  }

  register(upstreamName: string, entries: KeyPoolInput): void {
    const normalized = normalizeEntries(entries);
    this.states.set(
      upstreamName,
      normalized.map(({ credentialId, key }) => ({ credentialId, key, failures: 0, cooledUntil: 0 })),
    );
    this.lastIndex.set(upstreamName, -1);
  }

  reconcile(upstreamName: string, entries: KeyPoolInput): void {
    const normalized = normalizeEntries(entries);
    const old = this.states.get(upstreamName) ?? [];
    if (
      old.length === normalized.length &&
      old.every((state, i) => state.credentialId === normalized[i]?.credentialId && state.key === normalized[i]?.key)
    ) return;
    this.states.set(
      upstreamName,
      normalized.map(({ credentialId, key }) => {
        const previous = old.find((state) => state.credentialId === credentialId);
        return previous?.key === key ? previous : { credentialId, key, failures: 0, cooledUntil: 0 };
      }),
    );
    this.lastIndex.set(upstreamName, -1);
  }

  pickEntry(upstreamName: string): KeyPoolEntry | null {
    const states = this.states.get(upstreamName);
    if (!states || states.length === 0) return null;
    const now = Date.now();

    if (this.strategy === 'random') {
      const available = states.filter((s) => s.cooledUntil <= now);
      if (available.length === 0) return null;
      const idx = Math.floor(Math.random() * available.length);
      return { credentialId: available[idx].credentialId, key: available[idx].key };
    }

    const last = this.lastIndex.get(upstreamName) ?? -1;
    for (let offset = 1; offset <= states.length; offset++) {
      const idx = (last + offset) % states.length;
      const state = states[idx];
      if (state && state.cooledUntil <= now) {
        this.lastIndex.set(upstreamName, idx);
        return { credentialId: state.credentialId, key: state.key };
      }
    }
    return null;
  }

  /** Backwards-compatible key-only selection. */
  pick(upstreamName: string): string | null {
    return this.pickEntry(upstreamName)?.key ?? null;
  }

  private findState(upstreamName: string, identity: KeyPoolIdentity): KeyState | undefined {
    const states = this.states.get(upstreamName);
    return typeof identity === 'string'
      ? states?.find((state) => state.key === identity)
      : states?.find((state) => state.credentialId === identity.credentialId && state.key === identity.key);
  }

  markSuccess(upstreamName: string, identity: KeyPoolIdentity): void {
    const states = this.states.get(upstreamName);
    if (!states) return;
    const state = this.findState(upstreamName, identity);
    if (state) {
      state.failures = 0;
      state.cooledUntil = 0;
    }
  }

  markFailure(upstreamName: string, identity: KeyPoolIdentity): void {
    const states = this.states.get(upstreamName);
    if (!states) return;
    const state = this.findState(upstreamName, identity);
    if (state) {
      state.failures += 1;
      if (state.failures >= this.maxFailures) {
        state.cooledUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  markCooldown(upstreamName: string, identity: KeyPoolIdentity, cooldownMs: number): void {
    const states = this.states.get(upstreamName);
    const state = this.findState(upstreamName, identity);
    if (!state) return;
    state.failures = Math.max(state.failures, this.maxFailures);
    state.cooledUntil = Math.max(state.cooledUntil, Date.now() + Math.max(0, cooldownMs));
  }

  getAvailableKeys(upstreamName: string): string[] {
    return this.getAvailableEntries(upstreamName).map((entry) => entry.key);
  }

  getAvailableEntries(upstreamName: string): KeyPoolEntry[] {
    const states = this.states.get(upstreamName);
    if (!states) return [];
    const now = Date.now();
    return states
      .filter((state) => state.cooledUntil <= now)
      .map(({ credentialId, key }) => ({ credentialId, key }));
  }

  /** Count currently available credentials without exposing secrets or advancing round-robin state. */
  getAvailableCount(upstreamName: string): number {
    const states = this.states.get(upstreamName);
    if (!states) return 0;
    const now = Date.now();
    return states.filter((state) => state.cooledUntil <= now).length;
  }
}
