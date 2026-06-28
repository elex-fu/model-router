interface KeyState {
  key: string;
  failures: number;
  cooledUntil: number;
}

export interface KeyPoolOptions {
  cooldownMs?: number;
  maxFailures?: number;
  strategy?: 'round-robin' | 'random';
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

  register(upstreamName: string, keys: string[]): void {
    this.states.set(
      upstreamName,
      keys.map((k) => ({ key: k, failures: 0, cooledUntil: 0 })),
    );
    this.lastIndex.set(upstreamName, -1);
  }

  pick(upstreamName: string): string | null {
    const states = this.states.get(upstreamName);
    if (!states || states.length === 0) return null;
    const now = Date.now();

    if (this.strategy === 'random') {
      const available = states.filter((s) => s.cooledUntil <= now);
      if (available.length === 0) return null;
      const idx = Math.floor(Math.random() * available.length);
      return available[idx].key;
    }

    const last = this.lastIndex.get(upstreamName) ?? -1;
    for (let offset = 1; offset <= states.length; offset++) {
      const idx = (last + offset) % states.length;
      const state = states[idx];
      if (state && state.cooledUntil <= now) {
        this.lastIndex.set(upstreamName, idx);
        return state.key;
      }
    }
    return null;
  }

  markSuccess(upstreamName: string, key: string): void {
    const states = this.states.get(upstreamName);
    if (!states) return;
    const state = states.find((s) => s.key === key);
    if (state) {
      state.failures = 0;
      state.cooledUntil = 0;
    }
  }

  markFailure(upstreamName: string, key: string): void {
    const states = this.states.get(upstreamName);
    if (!states) return;
    const state = states.find((s) => s.key === key);
    if (state) {
      state.failures += 1;
      if (state.failures >= this.maxFailures) {
        state.cooledUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  getAvailableKeys(upstreamName: string): string[] {
    const states = this.states.get(upstreamName);
    if (!states) return [];
    const now = Date.now();
    return states.filter((s) => s.cooledUntil <= now).map((s) => s.key);
  }
}
