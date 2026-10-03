/** Test-only observation of real dispatch promises; never cancels or replaces their work. */
export type DispatchCompletionOutcome = 'sent' | 'unknown' | 'lease_release_failed' | 'threw';

export type DispatchCompletionFailureCode =
  | 'invalid_checkpoint' | 'missing_request_id' | 'missing_dispatch' | 'stale_dispatch'
  | 'duplicate_dispatch' | 'unexpected_dispatch' | 'unknown' | 'lease_release_failed'
  | 'dispatch_rejected' | 'completion_timeout' | 'observer_failed' | 'cleanup_rejected' | 'unexpected_outcome';

export class DispatchCompletionBarrierError extends Error {
  constructor(readonly code: DispatchCompletionFailureCode) {
    // Only a fixed enum is exposed, never the original error or request identity.
    super(`gateway dispatch completion barrier failed: ${code}`);
    this.name = 'DispatchCompletionBarrierError';
  }
}

export interface DispatchCompletionCleanupDiagnostic {
  readonly phase: 'before_close_drain' | 'resource_close';
  readonly code: DispatchCompletionFailureCode;
}

interface CompletionEntry {
  readonly sequence: number;
  readonly requestId: string | null;
  readonly completion: Promise<DispatchCompletionOutcome>;
  observed: boolean;
}

type BoundedResult<T> = { readonly completed: true; readonly value: T } | { readonly completed: false };

function requestIdentity(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    [...value].every((character) => character.charCodeAt(0) >= 0x21 && character.charCodeAt(0) <= 0x7e)
    ? value : null;
}

function failureCode(outcome: DispatchCompletionOutcome): DispatchCompletionFailureCode | null {
  switch (outcome) {
    case 'sent': return null;
    case 'unknown': return 'unknown';
    case 'lease_release_failed': return 'lease_release_failed';
    case 'threw': return 'dispatch_rejected';
  }
}

export class DispatchCompletionTracker {
  private readonly entries: CompletionEntry[] = [];
  private sequence = 0;
  private primaryFailure = false;
  private closing = false;

  constructor(private readonly timeoutMs = 5_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
      throw new Error('test dispatch completion timeout must be within one to five thousand milliseconds');
    }
  }

  get closeStarted(): boolean { return this.closing; }

  checkpoint(): number { return this.sequence; }

  track<T>(
    requestId: string | null | undefined,
    pending: Promise<T>,
    classify: (result: T) => DispatchCompletionOutcome,
  ): void {
    // This handled side branch only observes the original promise. The caller
    // still returns that original promise, including its original rejection.
    const completion = pending.then((result): DispatchCompletionOutcome => {
      try {
        const outcome = classify(result);
        return outcome === 'sent' || outcome === 'unknown' || outcome === 'lease_release_failed' || outcome === 'threw'
          ? outcome : 'threw';
      } catch { return 'threw'; }
    }, (): DispatchCompletionOutcome => 'threw');
    this.entries.push({ sequence: ++this.sequence, requestId: requestIdentity(requestId), completion, observed: false });
  }

  /** Capture only the sole real post-checkpoint dispatch identity, after an upstream receipt. */
  requestIdSince(checkpoint: number): string {
    this.validateCheckpoint(checkpoint);
    const fresh = this.entries.filter((entry) => entry.sequence > checkpoint);
    if (fresh.length === 0) throw new DispatchCompletionBarrierError('missing_dispatch');
    if (fresh.length !== 1) throw new DispatchCompletionBarrierError('duplicate_dispatch');
    const identity = fresh[0].requestId;
    if (identity === null) throw new DispatchCompletionBarrierError('missing_request_id');
    return identity;
  }

  async waitForCompletion(
    requestId: string | null, checkpoint: number, expected: 'sent' | 'unknown' = 'sent',
  ): Promise<void> {
    this.validateCheckpoint(checkpoint);
    const identity = requestIdentity(requestId);
    if (identity === null) throw new DispatchCompletionBarrierError('missing_request_id');
    const matching = this.entries.filter((entry) => entry.requestId === identity);
    if (matching.length === 0) throw new DispatchCompletionBarrierError('missing_dispatch');
    if (matching.length !== 1) throw new DispatchCompletionBarrierError('duplicate_dispatch');
    const entry = matching[0];
    if (entry.sequence <= checkpoint) throw new DispatchCompletionBarrierError('stale_dispatch');
    const result = await this.bounded(entry.completion);
    if (!result.completed) throw new DispatchCompletionBarrierError('completion_timeout');
    entry.observed = true;
    if (result.value !== expected) {
      const code = failureCode(result.value) ?? 'unexpected_outcome';
      throw new DispatchCompletionBarrierError(code);
    }
    // An explicitly expected unknown is observed, not converted to success.
    // Sent/unknown barriers both require independent durable SQL assertions;
    // the default and cleanup drain still reject unanticipated unknowns.
  }

  assertNoDispatchSince(checkpoint: number): void {
    this.validateCheckpoint(checkpoint);
    if (this.sequence !== checkpoint) throw new DispatchCompletionBarrierError('unexpected_dispatch');
  }

  notePrimaryFailure(): void { this.primaryFailure = true; }

  async preserveFailure<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { this.notePrimaryFailure(); throw error; }
  }

  async drain(): Promise<DispatchCompletionFailureCode | null> {
    const unobserved = this.entries.filter((entry) => !entry.observed);
    if (unobserved.length === 0) return null;
    // One shared deadline for the whole drain, not a timeout per request.
    const result = await this.bounded(Promise.all(unobserved.map((entry) => entry.completion)));
    if (!result.completed) return 'completion_timeout';
    for (const entry of unobserved) entry.observed = true;
    for (const outcome of result.value) {
      const code = failureCode(outcome);
      if (code !== null) return code;
    }
    return null;
  }

  async finalize(
    close: () => Promise<void>,
    report: (diagnostic: DispatchCompletionCleanupDiagnostic) => void,
  ): Promise<void> {
    const publish = (diagnostic: DispatchCompletionCleanupDiagnostic) => {
      try { report(diagnostic); } catch { /* Reporting must not replace the first failure. */ }
    };
    let drainFailure: DispatchCompletionFailureCode | null;
    try { drainFailure = await this.drain(); }
    catch { drainFailure = 'observer_failed'; }
    if (drainFailure !== null) publish({ phase: 'before_close_drain', code: drainFailure });

    // An expired observation deadline does not cancel dispatch/KMS/SQL work.
    // Later dispatch diagnostics can identify that resource closing has begun,
    // without claiming closing caused the original failure.
    this.closing = true;
    let closeFailed = false;
    try { await close(); }
    catch { closeFailed = true; publish({ phase: 'resource_close', code: 'cleanup_rejected' }); }

    if (!this.primaryFailure) {
      if (drainFailure !== null) throw new DispatchCompletionBarrierError(drainFailure);
      if (closeFailed) throw new DispatchCompletionBarrierError('cleanup_rejected');
    }
  }

  private validateCheckpoint(checkpoint: number): void {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0 || checkpoint > this.sequence) {
      throw new DispatchCompletionBarrierError('invalid_checkpoint');
    }
  }

  private async bounded<T>(pending: Promise<T>): Promise<BoundedResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<BoundedResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ completed: false }), this.timeoutMs);
    });
    try {
      return await Promise.race([
        pending.then((value): BoundedResult<T> => ({ completed: true, value })),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
