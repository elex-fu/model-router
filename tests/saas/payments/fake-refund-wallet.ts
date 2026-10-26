/** Exact normalized SQL contract: refund admission protects all durable escrow backing. */
export const REFUND_WALLET_COMMITMENTS_SQL =
  'select ((select coalesce(sum(amount_minor_units), 0) from saas_billing_reservations ' +
  "where tenant_id = $1 and currency = $2 and state in ('reserved', 'reconciliation_pending')) " +
  '+ (select coalesce(sum(backing_minor_units), 0) from saas_fast_credit_allocations ' +
  'where tenant_id = $1 and currency = $2))::text as total';

export interface FakeFastCreditAllocation {
  tenant_id: string;
  currency: string;
  state: 'active' | 'retired';
  backing_minor_units: bigint;
  available_minor_units: bigint;
}
