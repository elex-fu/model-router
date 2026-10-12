import { MAX_MINOR_UNITS } from '../billing/money.js';
import type { SqlExecutor } from '../db/types.js';
import type { KeyBudgetUtcDay } from './budget-policy-contract.js';
import { assertKeyBudgetUtcDay } from './budget-policy-contract.js';

/**
 * KEY-BUD (contract C-4, migration 081) persistence primitives. Every function
 * runs on the caller's executor inside the caller's transaction; none opens its
 * own transaction or performs I/O beyond SQL. All amounts are canonical
 * non-negative bigint decimal text — the same bound the frozen evaluator uses.
 *
 * Counter discipline: reserve-first-then-check. Admission upserts the
 * outstanding counters atomically (INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING) and evaluates the post-write values; a denial throws and the
 * surrounding transaction rollback undoes the reservation, so concurrent
 * admissions on one lineage can never over-admit. Settlement/compensation/
 * reconciliation resolve the per-request reservation row exactly once (state
 * outstanding -> settled/released) and move the ORIGINAL admission day's
 * counters, never the resolution day's.
 */

/** input_total + output_total; cache buckets stay inside the input total. */
export const KEY_BUDGET_TOKEN_SEMANTICS_VERSION = 'token-units-v1';
/** Lifetime counter rows use this sentinel because primary keys cannot be NULL. */
export const KEY_BUDGET_LIFETIME_DAY = '0001-01-01';

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

export type KeyBudgetStoreErrorCode =
  | 'INVALID_INPUT'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_STATE_CONFLICT'
  | 'CURRENCY_MISMATCH'
  | 'STORAGE_ERROR';

const SAFE_MESSAGES: Record<KeyBudgetStoreErrorCode, string> = {
  INVALID_INPUT: 'The key budget counter input is invalid.',
  RESERVATION_NOT_FOUND: 'The key budget reservation was not found.',
  RESERVATION_STATE_CONFLICT: 'The key budget reservation is already resolved.',
  CURRENCY_MISMATCH: 'The key budget charge currency does not match the lineage currency.',
  STORAGE_ERROR: 'The key budget counter storage failed.',
};

export class KeyBudgetStoreError extends Error {
  readonly code: KeyBudgetStoreErrorCode;

  constructor(code: KeyBudgetStoreErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'KeyBudgetStoreError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: KeyBudgetStoreErrorCode): never {
  throw new KeyBudgetStoreError(code);
}

/** Canonical non-negative decimal text bounded by the shared money ceiling. */
export function parseKeyBudgetAmount(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < 0n) fail('INVALID_INPUT');
    return parseKeyBudgetAmount(value.toString(10));
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT');
    return parseKeyBudgetAmount(String(value));
  }
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail('INVALID_INPUT');
  const parsed = BigInt(value);
  if (parsed > MAX_MINOR_UNITS) fail('INVALID_INPUT');
  return parsed.toString(10);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) fail('INVALID_INPUT');
  return value;
}

function currency(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = identifier(value);
  if (!/^[A-Z]{3}$/.test(text)) fail('INVALID_INPUT');
  return text;
}

function dayText(value: unknown): string {
  if (typeof value !== 'string' || !DAY_TEXT.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    fail('INVALID_INPUT');
  }
  return value;
}

/** Server-selected half-open UTC calendar day containing `now`. */
export function keyBudgetUtcDayFrom(now: Date): KeyBudgetUtcDay {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('INVALID_INPUT');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  const day: KeyBudgetUtcDay = {
    timezone: 'UTC',
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
  };
  assertKeyBudgetUtcDay(day);
  return day;
}

/** Day column text (YYYY-MM-DD) for a validated UTC day window. */
export function keyBudgetDayColumn(day: KeyBudgetUtcDay): string {
  assertKeyBudgetUtcDay(day);
  return day.startInclusive.slice(0, 10);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  return value as Record<string, unknown>;
}

/** Conservative reservation units from the admission usage upper-bound envelope. */
export function keyBudgetTokenUnitsFromBounds(bounds: unknown): string {
  const envelope = record(bounds);
  const input = BigInt(parseKeyBudgetAmount(envelope.inputTotalUpperBound));
  const output = BigInt(parseKeyBudgetAmount(envelope.outputTotalUpperBound));
  return parseKeyBudgetAmount(input + output);
}

/** Actual settled units from the upstream-reported exact usage. */
export function keyBudgetTokenUnitsFromUsage(usage: unknown): string {
  const exact = record(usage);
  const input = BigInt(parseKeyBudgetAmount(exact.inputTotal));
  const output = BigInt(parseKeyBudgetAmount(exact.outputTotal));
  return parseKeyBudgetAmount(input + output);
}

export interface KeyBudgetPolicyHead {
  readonly tenantId: string;
  readonly projectId: string;
  readonly keyId: string;
  readonly lineageId: string;
  readonly version: string;
  readonly tokenDaily: string | null;
  readonly tokenLifetime: string | null;
  readonly chargeDaily: string | null;
  readonly chargeLifetime: string | null;
}

interface PolicyHeadRow {
  tenant_id: string;
  project_id: string;
  key_id: string;
  lineage_id: string;
  version: string | number;
  token_daily: string | number | null;
  token_lifetime: string | number | null;
  charge_daily: string | number | null;
  charge_lifetime: string | number | null;
}

function nullableAmount(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') fail('STORAGE_ERROR');
  try {
    return parseKeyBudgetAmount(value);
  } catch {
    fail('STORAGE_ERROR');
  }
}

function versionText(value: unknown): string {
  const text = typeof value === 'bigint' || typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,18}$/.test(text)) fail('STORAGE_ERROR');
  return text;
}

/** The persisted policy head for a key; null when absent (pre-081 drift). */
export async function selectKeyBudgetPolicyHead(
  executor: SqlExecutor,
  tenantId: string,
  projectId: string,
  keyId: string,
  lock: 'UPDATE' | null = null,
): Promise<KeyBudgetPolicyHead | null> {
  const result = await executor.query<PolicyHeadRow>(
    `SELECT tenant_id, project_id, key_id, lineage_id, version,
            token_daily, token_lifetime, charge_daily, charge_lifetime
       FROM saas_api_key_budget_policies
      WHERE tenant_id = $1 AND project_id = $2 AND key_id = $3
      LIMIT 2${lock === 'UPDATE' ? ' FOR UPDATE' : ''}`,
    [identifier(tenantId), identifier(projectId), identifier(keyId)],
  );
  if (result.rows.length > 1) fail('STORAGE_ERROR');
  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId: identifier(row.tenant_id),
    projectId: identifier(row.project_id),
    keyId: identifier(row.key_id),
    lineageId: identifier(row.lineage_id),
    version: versionText(row.version),
    tokenDaily: nullableAmount(row.token_daily),
    tokenLifetime: nullableAmount(row.token_lifetime),
    chargeDaily: nullableAmount(row.charge_daily),
    chargeLifetime: nullableAmount(row.charge_lifetime),
  };
}

export interface KeyBudgetCounterWindow {
  readonly tokenSettled: string;
  readonly tokenOutstandingReserved: string;
  readonly chargeSettled: string;
  readonly chargeOutstandingReserved: string;
  readonly chargeCurrency: string | null;
}

interface CounterRow {
  token_settled: string | number;
  token_outstanding_reserved: string | number;
  charge_settled: string | number;
  charge_outstanding_reserved: string | number;
  charge_currency: string | null;
}

function counterWindow(row: CounterRow | undefined): KeyBudgetCounterWindow {
  if (!row) {
    return {
      tokenSettled: '0',
      tokenOutstandingReserved: '0',
      chargeSettled: '0',
      chargeOutstandingReserved: '0',
      chargeCurrency: null,
    };
  }
  return {
    tokenSettled: parseKeyBudgetAmount(row.token_settled),
    tokenOutstandingReserved: parseKeyBudgetAmount(row.token_outstanding_reserved),
    chargeSettled: parseKeyBudgetAmount(row.charge_settled),
    chargeOutstandingReserved: parseKeyBudgetAmount(row.charge_outstanding_reserved),
    chargeCurrency: row.charge_currency === null ? null : currency(row.charge_currency),
  };
}

export interface KeyBudgetCounterSnapshotRow {
  readonly daily: KeyBudgetCounterWindow;
  readonly lifetime: KeyBudgetCounterWindow;
}

/** Reads the lineage counters for the admission day and lifetime; missing rows are verified zeros. */
export async function selectKeyBudgetCounters(
  executor: SqlExecutor,
  tenantId: string,
  lineageId: string,
  day: KeyBudgetUtcDay,
): Promise<KeyBudgetCounterSnapshotRow> {
  const dayColumn = keyBudgetDayColumn(day);
  const result = await executor.query<CounterRow & { window_kind: string }>(
    `SELECT window_kind, token_settled, token_outstanding_reserved,
            charge_settled, charge_outstanding_reserved, charge_currency
       FROM saas_api_key_budget_counters
      WHERE tenant_id = $1 AND lineage_id = $2
        AND ((window_kind = 'daily' AND day = $3) OR (window_kind = 'lifetime' AND day = DATE '0001-01-01'))`,
    [identifier(tenantId), identifier(lineageId), dayColumn],
  );
  let daily: CounterRow | undefined;
  let lifetime: CounterRow | undefined;
  for (const row of result.rows) {
    if (row.window_kind === 'daily') {
      if (daily) fail('STORAGE_ERROR');
      daily = row;
    } else if (row.window_kind === 'lifetime') {
      if (lifetime) fail('STORAGE_ERROR');
      lifetime = row;
    } else {
      fail('STORAGE_ERROR');
    }
  }
  return { daily: counterWindow(daily), lifetime: counterWindow(lifetime) };
}

export interface KeyBudgetReservationFacts {
  readonly tenantId: string;
  readonly projectId: string;
  readonly lineageId: string;
  readonly requestId: string;
  readonly day: KeyBudgetUtcDay;
  readonly tokenUnits: string;
  readonly chargeMinorUnits: string;
  readonly chargeCurrency: string | null;
}

export interface KeyBudgetReservedWindow {
  readonly settled: string;
  /** Outstanding including this new reservation. */
  readonly outstandingReserved: string;
  readonly newReservation: string;
}

export interface KeyBudgetReservedCounters {
  readonly daily: KeyBudgetReservedWindow & { readonly charge: KeyBudgetReservedWindow };
  readonly lifetime: KeyBudgetReservedWindow & { readonly charge: KeyBudgetReservedWindow };
  readonly chargeCurrency: string | null;
}

interface UpsertedCounterRow extends CounterRow {
  window_kind: string;
}

/**
 * Atomically adds the new conservative reservation to both windows and returns
 * the post-write counters. The caller evaluates the returned values and throws
 * on denial; the transaction rollback then removes every effect.
 */
export async function reserveKeyBudgetCounters(
  executor: SqlExecutor,
  facts: KeyBudgetReservationFacts,
): Promise<KeyBudgetReservedCounters> {
  const tenantId = identifier(facts.tenantId);
  const projectId = identifier(facts.projectId);
  const lineageId = identifier(facts.lineageId);
  const requestId = identifier(facts.requestId);
  const dayColumn = keyBudgetDayColumn(facts.day);
  const tokenUnits = parseKeyBudgetAmount(facts.tokenUnits);
  const chargeMinorUnits = parseKeyBudgetAmount(facts.chargeMinorUnits);
  const chargeCurrency = chargeMinorUnits === '0' ? null : currency(facts.chargeCurrency);
  if (chargeMinorUnits !== '0' && chargeCurrency === null) fail('INVALID_INPUT');

  const upsert = (windowKind: 'daily' | 'lifetime', day: string) =>
    executor.query<UpsertedCounterRow>(
      `INSERT INTO saas_api_key_budget_counters
         (tenant_id, project_id, lineage_id, window_kind, day,
          token_outstanding_reserved, charge_outstanding_reserved, charge_currency)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8)
       ON CONFLICT (tenant_id, lineage_id, window_kind, day) DO UPDATE SET
         token_outstanding_reserved = saas_api_key_budget_counters.token_outstanding_reserved + EXCLUDED.token_outstanding_reserved,
         charge_outstanding_reserved = saas_api_key_budget_counters.charge_outstanding_reserved + EXCLUDED.charge_outstanding_reserved,
         charge_currency = COALESCE(saas_api_key_budget_counters.charge_currency, EXCLUDED.charge_currency),
         updated_at = clock_timestamp()
       RETURNING window_kind, token_settled, token_outstanding_reserved,
                 charge_settled, charge_outstanding_reserved, charge_currency`,
      [tenantId, projectId, lineageId, windowKind, day, tokenUnits, chargeMinorUnits, chargeCurrency],
    );

  const dailyRows = (await upsert('daily', dayColumn)).rows;
  const lifetimeRows = (await upsert('lifetime', KEY_BUDGET_LIFETIME_DAY)).rows;
  const daily = dailyRows[0];
  const lifetime = lifetimeRows[0];
  if (!daily || !lifetime || dailyRows.length !== 1 || lifetimeRows.length !== 1) fail('STORAGE_ERROR');

  const storedCurrency = (daily.charge_currency ?? lifetime.charge_currency) as string | null;
  if (chargeCurrency !== null && lifetime.charge_currency !== null && lifetime.charge_currency !== chargeCurrency) {
    fail('CURRENCY_MISMATCH');
  }

  await executor.query(
    `INSERT INTO saas_api_key_budget_reservations
       (tenant_id, project_id, lineage_id, request_id, day,
        token_units, charge_minor_units, charge_currency)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8)`,
    [tenantId, projectId, lineageId, requestId, dayColumn, tokenUnits, chargeMinorUnits, chargeCurrency],
  );

  const window = (row: UpsertedCounterRow): KeyBudgetReservedWindow & { charge: KeyBudgetReservedWindow } => ({
    settled: parseKeyBudgetAmount(row.token_settled),
    outstandingReserved: parseKeyBudgetAmount(row.token_outstanding_reserved),
    newReservation: tokenUnits,
    charge: {
      settled: parseKeyBudgetAmount(row.charge_settled),
      outstandingReserved: parseKeyBudgetAmount(row.charge_outstanding_reserved),
      newReservation: chargeMinorUnits,
    },
  });
  return {
    daily: window(daily),
    lifetime: window(lifetime),
    chargeCurrency: storedCurrency === null ? null : currency(storedCurrency),
  };
}

export interface KeyBudgetReservationRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly lineageId: string;
  readonly requestId: string;
  readonly day: string;
  readonly tokenUnits: string;
  readonly chargeMinorUnits: string;
  readonly chargeCurrency: string | null;
  readonly state: 'outstanding' | 'settled' | 'released';
}

interface ReservationRow {
  tenant_id: string;
  project_id: string;
  lineage_id: string;
  request_id: string;
  /** day::text — node-pg parses DATE as a LOCAL-midnight Date, which shifts the accounting day. */
  day: string;
  token_units: string | number;
  charge_minor_units: string | number;
  charge_currency: string | null;
  state: string;
}

function reservationRecord(row: ReservationRow): KeyBudgetReservationRecord {
  if (row.state !== 'outstanding' && row.state !== 'settled' && row.state !== 'released') fail('STORAGE_ERROR');
  return {
    tenantId: identifier(row.tenant_id),
    projectId: identifier(row.project_id),
    lineageId: identifier(row.lineage_id),
    requestId: identifier(row.request_id),
    day: dayText(row.day),
    tokenUnits: parseKeyBudgetAmount(row.token_units),
    chargeMinorUnits: parseKeyBudgetAmount(row.charge_minor_units),
    chargeCurrency: row.charge_currency === null ? null : currency(row.charge_currency),
    state: row.state,
  };
}

/** The per-request reservation; null when absent (requests admitted before 081). */
export async function selectKeyBudgetReservation(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  lock: 'UPDATE' | null = null,
): Promise<KeyBudgetReservationRecord | null> {
  const result = await executor.query<ReservationRow>(
    `SELECT tenant_id, project_id, lineage_id, request_id, day::text AS day,
            token_units, charge_minor_units, charge_currency, state
       FROM saas_api_key_budget_reservations
      WHERE tenant_id = $1 AND request_id = $2
      LIMIT 2${lock === 'UPDATE' ? ' FOR UPDATE' : ''}`,
    [identifier(tenantId), identifier(requestId)],
  );
  if (result.rows.length > 1) fail('STORAGE_ERROR');
  const row = result.rows[0];
  return row ? reservationRecord(row) : null;
}

function subtractColumn(column: string, amount: string): string {
  return `${column} = ${column} - ${amount}::bigint`;
}

async function adjustCounters(
  executor: SqlExecutor,
  reservation: KeyBudgetReservationRecord,
  tokenSettledDelta: string,
  chargeSettledDelta: string,
  releaseOutstanding: boolean,
): Promise<void> {
  const tokenSettled = parseKeyBudgetAmount(tokenSettledDelta);
  const chargeSettled = parseKeyBudgetAmount(chargeSettledDelta);
  const tokenOutstanding = releaseOutstanding ? reservation.tokenUnits : '0';
  const chargeOutstanding = releaseOutstanding ? reservation.chargeMinorUnits : '0';
  const update = (windowKind: 'daily' | 'lifetime', day: string) =>
    executor.query(
      `UPDATE saas_api_key_budget_counters
       SET ${subtractColumn('token_outstanding_reserved', tokenOutstanding)},
           ${subtractColumn('charge_outstanding_reserved', chargeOutstanding)},
           token_settled = token_settled + $5::bigint,
           charge_settled = charge_settled + $6::bigint,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND lineage_id = $2 AND window_kind = $3 AND day = $4
         AND token_outstanding_reserved >= $7::bigint
         AND charge_outstanding_reserved >= $8::bigint`,
      [
        reservation.tenantId,
        reservation.lineageId,
        windowKind,
        day,
        tokenSettled,
        chargeSettled,
        tokenOutstanding,
        chargeOutstanding,
      ],
    );
  for (const [windowKind, day] of [
    ['daily', reservation.day],
    ['lifetime', KEY_BUDGET_LIFETIME_DAY],
  ] as const) {
    const result = await update(windowKind, day);
    if (result.rowCount !== 1) fail('STORAGE_ERROR');
  }
}

/**
 * Settles the outstanding reservation exactly once: original-day and lifetime
 * counters move reserved -> settled with the ACTUAL amounts. Replay (already
 * resolved) is a no-op returning false; pre-081 requests without a reservation
 * row return false as well.
 */
export async function settleKeyBudgetReservation(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  actualTokenUnits: string,
  actualChargeMinorUnits: string,
): Promise<boolean> {
  const reservation = await selectKeyBudgetReservation(executor, tenantId, requestId, 'UPDATE');
  if (!reservation) return false;
  if (reservation.state !== 'outstanding') return false;
  await adjustCounters(
    executor,
    reservation,
    parseKeyBudgetAmount(actualTokenUnits),
    parseKeyBudgetAmount(actualChargeMinorUnits),
    true,
  );
  const updated = await executor.query(
    `UPDATE saas_api_key_budget_reservations
       SET state = 'settled', updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND request_id = $2 AND state = 'outstanding'`,
    [reservation.tenantId, reservation.requestId],
  );
  if (updated.rowCount !== 1) fail('RESERVATION_STATE_CONFLICT');
  return true;
}

/**
 * Releases the outstanding reservation exactly once (pre-dispatch cancellation
 * or operator-resolved failure): both windows drop the reserved amounts and no
 * settled usage is recorded. Replay is a no-op returning false.
 */
export async function releaseKeyBudgetReservation(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
): Promise<boolean> {
  const reservation = await selectKeyBudgetReservation(executor, tenantId, requestId, 'UPDATE');
  if (!reservation) return false;
  if (reservation.state !== 'outstanding') return false;
  await adjustCounters(executor, reservation, '0', '0', true);
  const updated = await executor.query(
    `UPDATE saas_api_key_budget_reservations
       SET state = 'released', updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND request_id = $2 AND state = 'outstanding'`,
    [reservation.tenantId, reservation.requestId],
  );
  if (updated.rowCount !== 1) fail('RESERVATION_STATE_CONFLICT');
  return true;
}

/**
 * Applies a usage correction (A2) to the settled counters of the ORIGINAL
 * admission day and lifetime. The reservation must already be settled; a
 * missing row is pre-081 drift and returns false.
 */
export async function applyKeyBudgetCorrection(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
  tokenSettledDelta: string,
  chargeSettledDelta: string,
): Promise<boolean> {
  const reservation = await selectKeyBudgetReservation(executor, tenantId, requestId, 'UPDATE');
  if (!reservation) return false;
  if (reservation.state !== 'settled') fail('RESERVATION_STATE_CONFLICT');
  await adjustCounters(
    executor,
    reservation,
    parseKeyBudgetAmount(tokenSettledDelta),
    parseKeyBudgetAmount(chargeSettledDelta),
    false,
  );
  return true;
}
