import type { BoundedGatewayBudgets, BoundedGatewaySlot } from './bounded-gateway-budgets.js';

export const BOUNDED_GATEWAY_TICKET_HEADER = 'x-model-router-bounded-ticket';
export interface BoundedGatewayWorkerConfiguration {
  readonly deploymentId: string;
  readonly generation: string;
  readonly slot: BoundedGatewaySlot;
  readonly epoch: string;
  readonly socketPath: string;
  readonly totals: BoundedGatewayBudgets;
  readonly creditCapMinorUnits: string;
  readonly policyDigest: string;
  readonly recoveryEpochs: readonly string[];
  readonly shutdownMs: number;
}
export type BoundedGatewayParentMessage =
  | { readonly type: 'reserve'; readonly epoch: string; readonly ticket: string; readonly peerAddress: string }
  | { readonly type: 'cancel'; readonly epoch: string; readonly ticket: string }
  | { readonly type: 'stop'; readonly epoch: string };
export type BoundedGatewayWorkerMessage =
  | {
      readonly type: 'ready';
      readonly epoch: string;
      readonly pid: number;
      readonly budgets: BoundedGatewayBudgets;
      readonly nativePools: readonly number[];
    }
  | { readonly type: 'health'; readonly epoch: string; readonly ready: boolean }
  | { readonly type: 'reserved'; readonly epoch: string; readonly ticket: string }
  | { readonly type: 'completed'; readonly epoch: string; readonly ticket: string }
  | { readonly type: 'failed'; readonly epoch: string; readonly code: string };

export function isBoundedGatewayTicket(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}
