/** This is process/dependency readiness, not a promise every tenant has credit. */
export function createFastGatewayReadiness(input: {
  readonly admission: { checkReady(): Promise<boolean> };
  readonly journal: { checkReady(): Promise<void> };
  readonly snapshots: { isAvailable(): boolean };
  readonly receipts?: { isReady(): boolean };
}): () => Promise<boolean> {
  return async () => {
    if (!input.snapshots.isAvailable() || input.receipts?.isReady() === false) return false;
    try {
      const [admission] = await Promise.all([input.admission.checkReady(), input.journal.checkReady()]);
      return admission && input.snapshots.isAvailable() && input.receipts?.isReady() !== false;
    } catch {
      return false;
    }
  };
}
