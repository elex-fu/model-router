interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenPermits: number;
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default 5. */
  failureThreshold?: number;
  /** Number of consecutive successes in half-open to close the circuit. Default 2. */
  successThreshold?: number;
  /** Time in ms before attempting half-open. Default 30_000. */
  recoveryTimeoutMs?: number;
  /** Minimum requests in closed state before failure count matters. Default 3. */
  minRequests?: number;
}

export class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();
  private failureThreshold: number;
  private successThreshold: number;
  private recoveryTimeoutMs: number;
  private minRequests: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000;
    this.minRequests = options.minRequests ?? 3;
  }

  /** Check if a request is allowed for the given upstream. */
  allow(upstreamName: string): boolean {
    const s = this.getState(upstreamName);
    if (s.status === 'closed') return true;
    if (s.status === 'open') {
      if (Date.now() - s.lastFailureTime >= this.recoveryTimeoutMs) {
        s.status = 'half-open';
        s.halfOpenPermits = 0;
        s.successes = 0;
        return true;
      }
      return false;
    }
    // half-open
    if (s.halfOpenPermits > 0) {
      s.halfOpenPermits--;
      return true;
    }
    return false;
  }

  /** Report a successful request. */
  reportSuccess(upstreamName: string): void {
    const s = this.getState(upstreamName);
    if (s.status === 'half-open') {
      s.successes++;
      if (s.successes >= this.successThreshold) {
        this.reset(upstreamName);
      } else {
        s.halfOpenPermits = 1;
      }
    } else if (s.status === 'closed') {
      s.failures = 0;
    }
  }

  /** Report a failed request. */
  reportFailure(upstreamName: string): void {
    const s = this.getState(upstreamName);
    if (s.status === 'half-open') {
      s.status = 'open';
      s.lastFailureTime = Date.now();
      return;
    }
    s.failures++;
    if (s.failures >= this.failureThreshold) {
      s.status = 'open';
      s.lastFailureTime = Date.now();
    }
  }

  /**
   * Neutral release: used when a request failure was due to a client-side
   * issue (e.g., rectifier error) and should not count against the provider.
   * In half-open, this refunds the permit so another probe can be attempted.
   */
  neutralRelease(upstreamName: string): void {
    const s = this.getState(upstreamName);
    if (s.status === 'half-open') {
      s.halfOpenPermits++;
    }
  }

  reset(upstreamName: string): void {
    this.states.set(upstreamName, {
      status: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      halfOpenPermits: 0,
    });
  }

  /** A read-only view for the management console; does not advance half-open state. */
  status(upstreamName: string): { state: CircuitBreakerState['status']; failures: number; lastFailureTime: number } {
    const state = this.states.get(upstreamName);
    return state
      ? { state: state.status, failures: state.failures, lastFailureTime: state.lastFailureTime }
      : { state: 'closed', failures: 0, lastFailureTime: 0 };
  }

  private getState(upstreamName: string): CircuitBreakerState {
    let s = this.states.get(upstreamName);
    if (!s) {
      s = {
        status: 'closed',
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        halfOpenPermits: 0,
      };
      this.states.set(upstreamName, s);
    }
    return s;
  }
}
