interface KeyState {
  key: string;
  failures: number;
  cooledUntil: number;
}

export interface KeyPoolOptions {
  cooldownMs?: number;
  maxFailures?: number;
}

export class KeyPool {
  private states = new Map<string, KeyState[]>();
  private cooldownMs: number;
  private maxFailures: number;

  constructor(options: KeyPoolOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 5 * 60 * 1000;
    this.maxFailures = options.maxFailures ?? 3;
  }

  register(upstreamName: string, keys: string[]): void {
    this.states.set(
      upstreamName,
      keys.map((k) => ({ key: k, failures: 0, cooledUntil: 0 }))
    );
  }

  pick(upstreamName: string): string | null {
    const states = this.states.get(upstreamName);
    if (!states || states.length === 0) return null;
    const now = Date.now();
    const available = states.filter((s) => s.cooledUntil <= now);
    if (available.length === 0) return null;
    const idx = Math.floor(Math.random() * available.length);
    return available[idx].key;
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
}
