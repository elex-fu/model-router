import type { SqlExecutor } from '../../db/types.js';
import { SaasBillingGroupsError } from './errors.js';
import { type BillingGroupSpendWindowKind, billingGroupSpendWindowStart } from './spend-windows.js';

/**
 * R1 billing-group spend store (roadmap 1.3, phase 3, migration 114): the
 * KEY-BUD reserve-first-then-check pattern at group scope. Every function
 * runs on the caller's executor inside the caller's transaction; a denial
 * throws and the surrounding rollback removes every effect, so group spend
 * can never be over-admitted. All amount math is exact (string/bigint minor
 * units, never floats).
 */

export type BillingGroupSpendWindow = {
  readonly kind: BillingGroupSpendWindowKind;
  readonly windowStart: string;
  readonly limitMinorUnits: string;
};

export interface BillingGroupSpendReservationFacts {
  readonly tenantId: string;
  readonly requestId: string;
  readonly billingGroupId: string;
  readonly windows: readonly BillingGroupSpendWindow[];
  readonly chargeMinorUnits: string;
  readonly chargeCurrency: string;
}

export interface BillingGroupSpendReservedWindow {
  readonly kind: BillingGroupSpendWindowKind;
  readonly windowStart: string;
  readonly settled: string;
  /** Outstanding including this new reservation. */
  readonly outstandingReserved: string;
  readonly limitMinorUnits: string;
}

function fail(code: 'GROUP_SPEND_STORAGE_ERROR' | 'GROUP_SPEND_CURRENCY_MISMATCH'): never {
  throw new SaasBillingGroupsError(code);
}

const AMOUNT = /^(0|[1-9][0-9]{0,18})$/;

function amount(value: string): string {
  if (typeof value !== 'string' || !AMOUNT.test(value)) fail('GROUP_SPEND_STORAGE_ERROR');
  return value;
}

function currencyText(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) fail('GROUP_SPEND_STORAGE_ERROR');
  return value;
}

/** The frozen group spend terms for one request, read from its price snapshot. */
export interface FrozenGroupSpendTerms {
  readonly billingGroupId: string;
  readonly dailyLimitMinorUnits: string | null;
  readonly weeklyLimitMinorUnits: string | null;
  readonly monthlyLimitMinorUnits: string | null;
}

/**
 * Reads the frozen spend ceilings from the request's own customer price
 * snapshot (migration 112) — never the mutable group table (the R1 red
 * line). Null means no snapshot row (BYOK or drift).
 */
export async function selectFrozenGroupSpendTerms(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
): Promise<FrozenGroupSpendTerms | null> {
  const result = await executor.query<{
    billing_group_id: string | null;
    group_daily_limit_minor_units: string | number | null;
    group_weekly_limit_minor_units: string | number | null;
    group_monthly_limit_minor_units: string | number | null;
  }>(
    `SELECT billing_group_id, group_daily_limit_minor_units, group_weekly_limit_minor_units,
            group_monthly_limit_minor_units
       FROM saas_request_customer_price_snapshots
      WHERE tenant_id = $1 AND request_id = $2
      LIMIT 2`,
    [tenantId, requestId],
  );
  if (result.rows.length > 1) fail('GROUP_SPEND_STORAGE_ERROR');
  const row = result.rows[0];
  if (!row || typeof row.billing_group_id !== 'string' || row.billing_group_id.trim() === '') return null;
  const limit = (value: string | number | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && AMOUNT.test(value)) return value;
    return fail('GROUP_SPEND_STORAGE_ERROR');
  };
  return {
    billingGroupId: row.billing_group_id,
    dailyLimitMinorUnits: limit(row.group_daily_limit_minor_units),
    weeklyLimitMinorUnits: limit(row.group_weekly_limit_minor_units),
    monthlyLimitMinorUnits: limit(row.group_monthly_limit_minor_units),
  };
}

/**
 * Reserve-first-then-check: atomically adds the hold amount to every
 * configured window counter and inserts the per-request reservation rows,
 * then returns the post-write windows for the caller to evaluate. A denial
 * throws and the admission transaction rolls every write back.
 */
export async function reserveBillingGroupSpend(
  executor: SqlExecutor,
  facts: BillingGroupSpendReservationFacts,
  now: Date,
): Promise<readonly BillingGroupSpendReservedWindow[]> {
  const chargeMinorUnits = amount(facts.chargeMinorUnits);
  const chargeCurrency = currencyText(facts.chargeCurrency);
  const reserved: BillingGroupSpendReservedWindow[] = [];
  for (const window of facts.windows) {
    const windowStart = billingGroupSpendWindowStart(window.kind, now);
    const upserted = await executor.query<{
      charge_settled: string | number;
      charge_outstanding_reserved: string | number;
      charge_currency: string | null;
    }>(
      `INSERT INTO saas_billing_group_spend_counters
         (billing_group_id, window_kind, window_start, charge_outstanding_reserved, charge_currency)
       VALUES ($1, $2, $3, $4::bigint, $5)
       ON CONFLICT (billing_group_id, window_kind, window_start) DO UPDATE SET
         charge_outstanding_reserved =
           saas_billing_group_spend_counters.charge_outstanding_reserved + EXCLUDED.charge_outstanding_reserved,
         charge_currency = COALESCE(saas_billing_group_spend_counters.charge_currency, EXCLUDED.charge_currency),
         updated_at = clock_timestamp()
       RETURNING charge_settled, charge_outstanding_reserved, charge_currency`,
      [facts.billingGroupId, window.kind, windowStart, chargeMinorUnits, chargeCurrency],
    );
    const row = upserted.rows[0];
    if (!row || upserted.rows.length !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
    if (row.charge_currency !== null && row.charge_currency !== chargeCurrency) {
      fail('GROUP_SPEND_CURRENCY_MISMATCH');
    }
    await executor.query(
      `INSERT INTO saas_billing_group_spend_reservations
         (tenant_id, request_id, billing_group_id, window_kind, window_start,
          amount_minor_units, charge_currency)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7)`,
      [
        facts.tenantId,
        facts.requestId,
        facts.billingGroupId,
        window.kind,
        windowStart,
        chargeMinorUnits,
        chargeCurrency,
      ],
    );
    reserved.push({
      kind: window.kind,
      windowStart,
      settled:
        typeof row.charge_settled === 'number' && Number.isSafeInteger(row.charge_settled)
          ? String(row.charge_settled)
          : amount(String(row.charge_settled)),
      outstandingReserved:
        typeof row.charge_outstanding_reserved === 'number' && Number.isSafeInteger(row.charge_outstanding_reserved)
          ? String(row.charge_outstanding_reserved)
          : amount(String(row.charge_outstanding_reserved)),
      limitMinorUnits: amount(window.limitMinorUnits),
    });
  }
  return reserved;
}

/** A reservation row of one request window. */
export interface BillingGroupSpendReservationRow {
  readonly billingGroupId: string;
  readonly windowKind: BillingGroupSpendWindowKind;
  readonly windowStart: string;
  readonly amountMinorUnits: string;
  readonly chargeCurrency: string;
  readonly state: 'outstanding' | 'settled' | 'released';
}

function parseWindowKind(value: unknown): BillingGroupSpendWindowKind {
  if (value === 'daily' || value === 'weekly' || value === 'monthly') return value;
  return fail('GROUP_SPEND_STORAGE_ERROR');
}

async function selectSpendReservations(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  lock: boolean,
): Promise<readonly BillingGroupSpendReservationRow[]> {
  const result = await executor.query<{
    billing_group_id: string;
    window_kind: string;
    window_start: string;
    amount_minor_units: string | number;
    charge_currency: string;
    state: string;
  }>(
    `SELECT billing_group_id, window_kind, window_start::text AS window_start,
            amount_minor_units, charge_currency, state
       FROM saas_billing_group_spend_reservations
      WHERE tenant_id = $1 AND request_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, requestId],
  );
  return result.rows.map((row) => {
    if (row.state !== 'outstanding' && row.state !== 'settled' && row.state !== 'released') {
      fail('GROUP_SPEND_STORAGE_ERROR');
    }
    if (typeof row.billing_group_id !== 'string' || row.billing_group_id.trim() === '') {
      fail('GROUP_SPEND_STORAGE_ERROR');
    }
    return {
      billingGroupId: row.billing_group_id,
      windowKind: parseWindowKind(row.window_kind),
      windowStart:
        typeof row.window_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.window_start)
          ? row.window_start
          : fail('GROUP_SPEND_STORAGE_ERROR'),
      amountMinorUnits:
        typeof row.amount_minor_units === 'number' && Number.isSafeInteger(row.amount_minor_units)
          ? String(row.amount_minor_units)
          : amount(String(row.amount_minor_units)),
      chargeCurrency: currencyText(row.charge_currency),
      state: row.state,
    };
  });
}

/**
 * Moves every outstanding window reservation of the request to settled with
 * the ACTUAL charge: the original window's counter drops the reserved
 * amount and gains the actual amount. Idempotent — already-resolved rows
 * are skipped; a request without rows (pre-114 admission or BYOK) is a
 * no-op returning false.
 */
export async function settleBillingGroupSpend(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  actualChargeMinorUnits: string,
  actualChargeCurrency: string,
): Promise<boolean> {
  const actual = amount(actualChargeMinorUnits);
  const currency = currencyText(actualChargeCurrency);
  const rows = await selectSpendReservations(executor, tenantId, requestId, true);
  const outstanding = rows.filter((row) => row.state === 'outstanding');
  if (outstanding.length === 0) return false;
  for (const row of outstanding) {
    if (row.chargeCurrency !== currency) fail('GROUP_SPEND_CURRENCY_MISMATCH');
    const updated = await executor.query(
      `UPDATE saas_billing_group_spend_counters
         SET charge_outstanding_reserved = charge_outstanding_reserved - $4::bigint,
             charge_settled = charge_settled + $5::bigint,
             updated_at = clock_timestamp()
       WHERE billing_group_id = $1 AND window_kind = $2 AND window_start = $3
         AND charge_outstanding_reserved >= $4::bigint`,
      [row.billingGroupId, row.windowKind, row.windowStart, row.amountMinorUnits, actual],
    );
    if (updated.rowCount !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
    const resolved = await executor.query(
      `UPDATE saas_billing_group_spend_reservations
         SET state = 'settled', settled_amount_minor_units = $4::bigint, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND request_id = $2 AND window_kind = $3 AND state = 'outstanding'`,
      [tenantId, requestId, row.windowKind, actual],
    );
    if (resolved.rowCount !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
  }
  return true;
}

/**
 * Releases every outstanding window reservation exactly once (pre-dispatch
 * cancellation or operator-resolved failure): the original window's counter
 * drops the reserved amount and no settled usage is recorded.
 */
export async function releaseBillingGroupSpend(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
): Promise<boolean> {
  const rows = await selectSpendReservations(executor, tenantId, requestId, true);
  const outstanding = rows.filter((row) => row.state === 'outstanding');
  if (outstanding.length === 0) return false;
  for (const row of outstanding) {
    const updated = await executor.query(
      `UPDATE saas_billing_group_spend_counters
         SET charge_outstanding_reserved = charge_outstanding_reserved - $4::bigint,
             updated_at = clock_timestamp()
       WHERE billing_group_id = $1 AND window_kind = $2 AND window_start = $3
         AND charge_outstanding_reserved >= $4::bigint`,
      [row.billingGroupId, row.windowKind, row.windowStart, row.amountMinorUnits],
    );
    if (updated.rowCount !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
    const resolved = await executor.query(
      `UPDATE saas_billing_group_spend_reservations
         SET state = 'released', settled_amount_minor_units = 0, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND request_id = $2 AND window_kind = $3 AND state = 'outstanding'`,
      [tenantId, requestId, row.windowKind],
    );
    if (resolved.rowCount !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
  }
  return true;
}

/**
 * Applies a usage correction delta to every window reservation of the
 * request. All rows must already be resolved; the delta moves the settled
 * side of the ORIGINAL windows.
 */
export async function correctBillingGroupSpend(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  chargeSettledDelta: string,
): Promise<boolean> {
  const delta = amount(chargeSettledDelta);
  const rows = await selectSpendReservations(executor, tenantId, requestId, true);
  if (rows.length === 0) return false;
  if (rows.some((row) => row.state === 'outstanding')) fail('GROUP_SPEND_STORAGE_ERROR');
  for (const row of rows) {
    const updated = await executor.query(
      `UPDATE saas_billing_group_spend_counters
         SET charge_settled = charge_settled + $4::bigint,
             updated_at = clock_timestamp()
       WHERE billing_group_id = $1 AND window_kind = $2 AND window_start = $3
         AND charge_settled + $4::bigint >= 0`,
      [row.billingGroupId, row.windowKind, row.windowStart, delta],
    );
    if (updated.rowCount !== 1) fail('GROUP_SPEND_STORAGE_ERROR');
  }
  return true;
}
