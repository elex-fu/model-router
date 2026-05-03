import type { ProxyKey } from '../config/types.js';

export interface UsageState {
  rpmWindow: number[];
  dailyTokensUsed: number;
  dailyResetAt: number;
}

export interface ReserveResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: 'rpm_exceeded' | 'daily_tokens_exceeded';
}

export interface LimiterOptions {
  now?: () => number;
  nextDailyReset?: (now: number) => number;
}

const RPM_WINDOW_MS = 60_000;

function defaultNextDailyReset(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

export class KeyLimiter {
  private readonly now: () => number;
  private readonly nextDailyReset: (now: number) => number;
  private readonly states = new Map<string, UsageState>();

  constructor(opts: LimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.nextDailyReset = opts.nextDailyReset ?? defaultNextDailyReset;
  }

  reserveRequest(keyName: string, key: ProxyKey): ReserveResult {
    const t = this.now();
    const state = this.ensureState(keyName, t);
    this.maybeResetDaily(state, t);

    if (key.dailyTokens !== undefined) {
      if (key.dailyTokens === 0 || state.dailyTokensUsed >= key.dailyTokens) {
        return {
          allowed: false,
          reason: 'daily_tokens_exceeded',
          retryAfterMs: Math.max(0, state.dailyResetAt - t),
        };
      }
    }

    if (key.rpm !== undefined) {
      if (key.rpm === 0) {
        return { allowed: false, reason: 'rpm_exceeded', retryAfterMs: RPM_WINDOW_MS };
      }
      const cutoff = t - RPM_WINDOW_MS;
      while (state.rpmWindow.length > 0 && state.rpmWindow[0] <= cutoff) {
        state.rpmWindow.shift();
      }
      if (state.rpmWindow.length >= key.rpm) {
        const oldest = state.rpmWindow[0];
        const retryAfterMs = oldest + RPM_WINDOW_MS - t;
        return { allowed: false, reason: 'rpm_exceeded', retryAfterMs };
      }
      state.rpmWindow.push(t);
    }

    return { allowed: true };
  }

  recordUsage(keyName: string, inputTokens: number, outputTokens: number): void {
    const t = this.now();
    const state = this.ensureState(keyName, t);
    this.maybeResetDaily(state, t);
    state.dailyTokensUsed += (inputTokens || 0) + (outputTokens || 0);
  }

  hydrate(usage: Iterable<{ keyName: string; tokensUsed: number }>): void {
    const t = this.now();
    for (const { keyName, tokensUsed } of usage) {
      const state = this.ensureState(keyName, t);
      state.dailyTokensUsed = tokensUsed;
    }
  }

  getUsage(keyName: string): UsageState | undefined {
    return this.states.get(keyName);
  }

  private ensureState(keyName: string, t: number): UsageState {
    let state = this.states.get(keyName);
    if (!state) {
      state = { rpmWindow: [], dailyTokensUsed: 0, dailyResetAt: this.nextDailyReset(t) };
      this.states.set(keyName, state);
    }
    return state;
  }

  private maybeResetDaily(state: UsageState, t: number): void {
    if (t >= state.dailyResetAt) {
      state.dailyTokensUsed = 0;
      state.dailyResetAt = this.nextDailyReset(t);
    }
  }
}
