/** Production mode is deliberately two fixed business slots, not replica scaling. */
export interface BoundedGatewayBudgets {
  readonly httpInFlight: number;
  readonly databasePoolMax: number;
  readonly receiptEntries: number;
  readonly receiptBytes: number;
  readonly receiptPerTenant: number;
  readonly receiptWorkers: number;
  readonly creditStripes: number;
}

export const DEFAULT_BOUNDED_GATEWAY_BUDGETS: BoundedGatewayBudgets = Object.freeze({
  httpInFlight: 64,
  databasePoolMax: 16,
  receiptEntries: 256,
  receiptBytes: 2 * 1024 * 1024,
  receiptPerTenant: 64,
  receiptWorkers: 8,
  creditStripes: 8,
});

export function boundedGatewayBudgets(input: Partial<BoundedGatewayBudgets> = {}): BoundedGatewayBudgets {
  const result = { ...DEFAULT_BOUNDED_GATEWAY_BUDGETS, ...input };
  const maxima: BoundedGatewayBudgets = {
    httpInFlight: 8192,
    databasePoolMax: 256,
    receiptEntries: 65536,
    receiptBytes: 256 * 1024 * 1024,
    receiptPerTenant: 65536,
    receiptWorkers: 64,
    creditStripes: 16,
  };
  if (Object.keys(result).some((key) => !(key in maxima))) throw new Error('BOUNDED_GATEWAY_UNKNOWN_BUDGET');
  for (const key of Object.keys(result) as Array<keyof BoundedGatewayBudgets>) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0 || value > maxima[key]) {
      throw new Error(`BOUNDED_GATEWAY_INVALID_BUDGET:${key}`);
    }
  }
  if (result.receiptPerTenant > result.receiptEntries) throw new Error('BOUNDED_GATEWAY_INVALID_TENANT_BUDGET');
  return Object.freeze(result);
}

export function boundedGatewayWorkerBudgets(totals: BoundedGatewayBudgets): BoundedGatewayBudgets {
  boundedGatewayBudgets(totals);
  return Object.freeze(
    Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 2])),
  ) as unknown as BoundedGatewayBudgets;
}

export type BoundedGatewaySlot = 0 | 1;
export type BoundedGatewayWorkerPhase = 'starting' | 'ready' | 'unready' | 'draining' | 'exited';

/** Reservations are synchronous and stay owned until handler completion or proven child exit. */
export class BoundedGatewayPermits {
  private readonly slots = [
    { phase: 'exited' as BoundedGatewayWorkerPhase, epoch: '', tickets: new Set<string>() },
    { phase: 'exited' as BoundedGatewayWorkerPhase, epoch: '', tickets: new Set<string>() },
  ];
  private next = 0;
  constructor(readonly localLimit: number) {
    if (!Number.isSafeInteger(localLimit) || localLimit < 1) throw new Error('BOUNDED_GATEWAY_INVALID_LIMIT');
  }
  start(slot: BoundedGatewaySlot, epoch: string): void {
    const state = this.slots[slot];
    if (state.phase !== 'exited' || state.tickets.size !== 0 || !epoch)
      throw new Error('BOUNDED_GATEWAY_SLOT_STILL_OWNED');
    state.epoch = epoch;
    state.phase = 'starting';
  }
  ready(slot: BoundedGatewaySlot, epoch: string): void {
    const state = this.slots[slot];
    if (state.epoch !== epoch || state.phase !== 'starting') throw new Error('BOUNDED_GATEWAY_STALE_READY');
    state.phase = 'ready';
  }
  /** A health update cannot revive a draining/exited slot or an old epoch. */
  health(slot: BoundedGatewaySlot, epoch: string, ready: boolean): boolean {
    const state = this.slots[slot];
    if (state.epoch !== epoch || (state.phase !== 'ready' && state.phase !== 'unready')) return false;
    state.phase = ready ? 'ready' : 'unready';
    return true;
  }
  stop(slot: BoundedGatewaySlot): void {
    const state = this.slots[slot];
    if (state.phase !== 'exited') state.phase = 'draining';
  }
  reserve(ticket: string): { slot: BoundedGatewaySlot; epoch: string } | undefined {
    const candidates = ([0, 1] as const).filter(
      (slot) => this.slots[slot].phase === 'ready' && this.slots[slot].tickets.size < this.localLimit,
    );
    candidates.sort(
      (a, b) =>
        this.slots[a].tickets.size - this.slots[b].tickets.size || ((a + this.next) % 2) - ((b + this.next) % 2),
    );
    const slot = candidates[0];
    if (slot === undefined) return undefined;
    if (this.slots.some((state) => state.tickets.has(ticket))) throw new Error('BOUNDED_GATEWAY_DUPLICATE_TICKET');
    this.slots[slot].tickets.add(ticket);
    this.next = 1 - slot;
    return { slot, epoch: this.slots[slot].epoch };
  }
  complete(slot: BoundedGatewaySlot, epoch: string, ticket: string): boolean {
    const state = this.slots[slot];
    return state.epoch === epoch && state.tickets.delete(ticket);
  }
  /** Caller must establish actual process exit; a timeout, EOF or lease expiry is insufficient. */
  exited(slot: BoundedGatewaySlot, epoch: string): readonly string[] {
    const state = this.slots[slot];
    if (state.epoch !== epoch) throw new Error('BOUNDED_GATEWAY_STALE_EXIT');
    const lost = [...state.tickets];
    state.tickets.clear();
    state.phase = 'exited';
    return lost;
  }
  snapshot(): readonly {
    readonly slot: number;
    readonly epoch: string;
    readonly phase: BoundedGatewayWorkerPhase;
    readonly inFlight: number;
  }[] {
    return this.slots.map((state, slot) => ({
      slot,
      epoch: state.epoch,
      phase: state.phase,
      inFlight: state.tickets.size,
    }));
  }
}
