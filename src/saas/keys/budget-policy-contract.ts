import { parseMinorUnits } from '../billing/money.js';
import type { SupplyMode } from '../gateway/contracts.js';

/** Canonical non-negative PostgreSQL bigint text; no JSON numbers or unit conversion. */
export type KeyBudgetDecimal = string;
export type KeyBudgetVersion = string;

/** null explicitly disables this cap; '0' is a finite zero cap. */
export interface KeyBudgetCapsDto {
  readonly daily: KeyBudgetDecimal | null;
  /** Cumulative across the server-owned lineage, including ordinary Key rotations. */
  readonly lifetime: KeyBudgetDecimal | null;
}

/**
 * Complete replacement. Supply mode, currency, units, scope, lineage, counters
 * and clock are server-owned. Missing fields never mean disabled/unlimited.
 * Parsing does not compare a DB head, reserve resources or modify a wallet.
 */
export interface ReplaceKeyBudgetPolicyInput {
  readonly expectedVersion: KeyBudgetVersion;
  readonly tokenCaps: KeyBudgetCapsDto;
  /** Explicit null disables the charge dimension; BYOK requires null. */
  readonly customerChargeCaps: KeyBudgetCapsDto | null;
}

/** Server-selected half-open [startInclusive, endExclusive) UTC calendar day. */
export interface KeyBudgetUtcDay {
  readonly timezone: 'UTC';
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export type KeyBudgetCounterSnapshot =
  | { readonly status: 'unverified' }
  | {
      readonly status: 'verified';
      readonly settled: KeyBudgetDecimal;
      /** Includes retained unknown/reconciliation reservations; not released by age/TTL. */
      readonly outstandingReserved: KeyBudgetDecimal;
    };

export interface KeyBudgetUsageSnapshot {
  readonly daily: KeyBudgetCounterSnapshot;
  readonly lifetime: KeyBudgetCounterSnapshot;
}

interface KeyBudgetSnapshotBase {
  readonly tenantId: string;
  readonly projectId: string;
  readonly keyId: string;
  /** Resolved by the server; rotating a Key does not create a new budget lineage. */
  readonly lineageId: string;
  readonly version: KeyBudgetVersion;
  /** Existing Key revision, distinct from the budget policy head. */
  readonly authzVersion: number;
  readonly tokenUnit: 'tokens';
  /** null means the authoritative token aggregation contract is not established. */
  readonly tokenCountingSemanticsVersion: string | null;
  /** UTC is fixed for this candidate; null means no verified current day was obtained. */
  readonly currentWindow: KeyBudgetUtcDay | null;
  readonly tokenCaps: KeyBudgetCapsDto;
  readonly tokenUsage: KeyBudgetUsageSnapshot;
}

/** Response facts only; these interfaces do not assert atomic admission or verified persistence. */
export type KeyBudgetPolicySnapshot = KeyBudgetSnapshotBase & (
  | {
      readonly supplyMode: 'byok';
      readonly customerChargeBudget: null;
    }
  | {
      readonly supplyMode: 'platform';
      readonly customerChargeBudget: {
        /** Server-bound customer price/settlement currency; not supplier currency. */
        readonly currency: string;
        readonly unit: 'minor_units';
        readonly caps: KeyBudgetCapsDto;
        readonly usage: KeyBudgetUsageSnapshot;
      } | null;
    }
);

function strictObject(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Expected a Key budget object');
  }
  const object = input as Record<string, unknown>;
  if (
    Object.keys(object).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(object, field))
  ) {
    throw new TypeError('Unexpected or missing Key budget field');
  }
  return object;
}

function decimal(input: unknown, allowZero: boolean): string {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input)) {
    throw new TypeError('Invalid Key budget decimal');
  }
  try {
    // The evaluator uses this same bigint bound for tokens and customer charges.
    // Reuse the billing integer validator without assigning a currency or scale.
    return parseMinorUnits(input, { allowZero }).toString(10);
  } catch {
    throw new TypeError('Invalid Key budget decimal');
  }
}

export function parseKeyBudgetVersion(input: unknown): KeyBudgetVersion {
  return decimal(input, false);
}

function caps(input: unknown): KeyBudgetCapsDto {
  const object = strictObject(input, ['daily', 'lifetime']);
  return {
    daily: object.daily === null ? null : decimal(object.daily, true),
    lifetime: object.lifetime === null ? null : decimal(object.lifetime, true),
  };
}

/** Pure strict DTO parsing; supplyMode must come from an authorized server-owned Key. */
export function parseReplaceKeyBudgetPolicyInput(
  input: unknown,
  supplyMode: SupplyMode,
): ReplaceKeyBudgetPolicyInput {
  if (supplyMode !== 'byok' && supplyMode !== 'platform') {
    throw new TypeError('Invalid Key budget supply mode');
  }
  const body = strictObject(input, ['expectedVersion', 'tokenCaps', 'customerChargeCaps']);
  const expectedVersion = parseKeyBudgetVersion(body.expectedVersion);
  const tokenCaps = caps(body.tokenCaps);
  if (supplyMode === 'byok' && body.customerChargeCaps !== null) {
    throw new TypeError('BYOK Key budgets cannot contain customer charges');
  }
  const customerChargeCaps = body.customerChargeCaps === null ? null : caps(body.customerChargeCaps);
  return { expectedVersion, tokenCaps, customerChargeCaps };
}

/** Validate server-supplied metadata only; does not read a clock or select an accounting day. */
export function assertKeyBudgetUtcDay(input: unknown): asserts input is KeyBudgetUtcDay {
  const day = strictObject(input, ['timezone', 'startInclusive', 'endExclusive']);
  const midnight = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
  if (
    day.timezone !== 'UTC' ||
    typeof day.startInclusive !== 'string' ||
    typeof day.endExclusive !== 'string' ||
    !midnight.test(day.startInclusive) ||
    !midnight.test(day.endExclusive)
  ) {
    throw new TypeError('Invalid Key budget UTC day');
  }
  const start = Date.parse(day.startInclusive);
  const end = Date.parse(day.endExclusive);
  if (
    !Number.isFinite(start) || !Number.isFinite(end) ||
    new Date(start).toISOString() !== day.startInclusive ||
    new Date(end).toISOString() !== day.endExclusive ||
    end - start !== 86_400_000
  ) {
    throw new TypeError('Invalid Key budget UTC day');
  }
}
