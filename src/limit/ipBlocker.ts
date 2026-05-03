export interface IpBlockerOptions {
  windowMs?: number;
  threshold?: number;
  now?: () => number;
}

export interface IpCheckResult {
  blocked: boolean;
  retryAfterMs?: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 10;

export class IpAuthBlocker {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(opts: IpBlockerOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.now = opts.now ?? Date.now;
  }

  recordFailure(ip: string): void {
    if (!ip) return;
    const t = this.now();
    let arr = this.failures.get(ip);
    if (!arr) {
      arr = [];
      this.failures.set(ip, arr);
    }
    arr.push(t);
    this.prune(arr, t);
  }

  check(ip: string): IpCheckResult {
    if (!ip) return { blocked: false };
    const t = this.now();
    const arr = this.failures.get(ip);
    if (!arr || arr.length === 0) return { blocked: false };
    this.prune(arr, t);
    if (arr.length === 0) {
      this.failures.delete(ip);
      return { blocked: false };
    }
    if (arr.length >= this.threshold) {
      const oldest = arr[0];
      return { blocked: true, retryAfterMs: Math.max(0, oldest + this.windowMs - t) };
    }
    return { blocked: false };
  }

  clearSuccess(ip: string): void {
    if (!ip) return;
    this.failures.delete(ip);
  }

  private prune(arr: number[], t: number): void {
    const cutoff = t - this.windowMs;
    while (arr.length > 0 && arr[0] <= cutoff) {
      arr.shift();
    }
  }
}
