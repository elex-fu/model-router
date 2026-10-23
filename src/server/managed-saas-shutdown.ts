/** Tracks application work, independently of client EOF or socket lifetime. */
export class ManagedSaasRequestTracker {
  private readonly pending = new Set<Promise<unknown>>();

  track(original: Promise<unknown>): void {
    this.pending.add(original);
    void original.then(() => this.pending.delete(original), () => this.pending.delete(original));
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

/** A settled failure permits best effort cleanup; a hung owner forbids advancing. */
export async function closeManagedSaasResources(
  steps: readonly (() => void | PromiseLike<void>)[],
  budgetMs = 5_000,
): Promise<void> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new TypeError('Invalid managed shutdown deadline');
  const deadline = performance.now() + budgetMs;
  let failed = false;
  for (const close of steps) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('MANAGED_SAAS_SHUTDOWN_RESOURCE_TIMEOUT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(close).then(() => 'closed' as const, () => 'failed' as const),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), remaining); }),
      ]);
      if (result === 'timeout') throw new Error('MANAGED_SAAS_SHUTDOWN_RESOURCE_TIMEOUT');
      if (result === 'failed') failed = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (failed) throw new Error('MANAGED_SAAS_SHUTDOWN_RESOURCE_FAILED');
}

/** Keep resource owners alive until original handlers finish, even after socket abort. */
export async function drainManagedSaasShutdown(
  drains: readonly Promise<unknown>[],
  forceConnectionsClosed: () => void,
  graceMs = 30_000,
  cleanupMs = 5_000,
): Promise<void> {
  for (const duration of [graceMs, cleanupMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1) throw new TypeError('Invalid managed shutdown deadline');
  }
  const completion = Promise.allSettled(drains);
  const wait = async (duration: number): Promise<Awaited<typeof completion> | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), duration); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let results = await wait(graceMs);
  if (results === undefined) {
    forceConnectionsClosed();
    results = await wait(cleanupMs);
  }
  if (results === undefined) throw new Error('MANAGED_SAAS_SHUTDOWN_TIMEOUT');
  if (results.some((result) => result.status === 'rejected')) throw new Error('MANAGED_SAAS_SHUTDOWN_DRAIN_FAILED');
}
