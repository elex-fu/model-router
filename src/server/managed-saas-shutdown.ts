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
