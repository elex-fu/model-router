import { randomUUID } from 'node:crypto';
import {
  addMinorUnits,
  type MinorUnitInput,
  normalizeCurrency,
  parseMinorUnits,
  parseStoredMinorUnits,
} from '../billing/money.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';

const DAY_MS = 86_400_000;
const TOKENS_PER_MILLION = 1_000_000n;

export type ProviderAccountCostPeriod = 'month' | 'quarter' | 'year';
export type AccountCostTimestampInput = string | Date;

export interface ProviderAccountCost {
  readonly id: string;
  readonly accountId: string;
  readonly priceMinorUnits: bigint;
  readonly currency: string;
  readonly period: ProviderAccountCostPeriod;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProviderAccountCostInput {
  readonly id?: string;
  readonly accountId: string;
  readonly priceMinorUnits: MinorUnitInput;
  readonly currency: string;
  readonly period: ProviderAccountCostPeriod;
  readonly effectiveFrom: AccountCostTimestampInput;
  readonly effectiveTo?: AccountCostTimestampInput | null;
  readonly sourceNote?: string | null;
}

export type ReplaceEffectiveProviderAccountCostInput = CreateProviderAccountCostInput;

export interface ReplaceEffectiveCostWrite {
  readonly previousCostId: string;
  readonly previousEffectiveTo: string;
  readonly previousUpdatedAt: string;
  readonly replacement: ProviderAccountCost;
}

/**
 * Persistence seam for the operational ledger. replaceEffective must close
 * the previous interval and insert the replacement atomically; implementations
 * should rely on migration 151's overlap constraint as the final guard.
 */
export interface ProviderAccountCostStore {
  create(cost: ProviderAccountCost): Promise<void>;
  getById(id: string): Promise<ProviderAccountCost | null>;
  listByAccount(accountId: string): Promise<readonly ProviderAccountCost[]>;
  listForReport(input: { readonly asOf: string; readonly currency: string }): Promise<readonly ProviderAccountCost[]>;
  findEffective(accountId: string, at: string): Promise<ProviderAccountCost | null>;
  replaceEffective(write: ReplaceEffectiveCostWrite): Promise<void>;
}

export interface ProviderAccountOperationalState {
  readonly status: string;
  /** Required to stop amortization at the ban rather than at report time. */
  readonly bannedAt?: string | null;
}

export interface ProviderAccountStateLookup {
  getProviderAccountState(accountId: string): Promise<ProviderAccountOperationalState | null>;
}

export interface AccountUsageAggregationQuery {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  /** The ledger/report currency expected for settledAmountMinorUnits. */
  readonly currency: string;
}

export interface AccountUsageAggregate {
  readonly tokens: bigint;
  readonly requests: bigint;
  readonly settledAmountMinorUnits: bigint;
}

/**
 * Read-only aggregation seam. A PostgreSQL adapter can reuse the existing
 * saas_usage_events/saas_attempts account join and add settled reservations;
 * this service deliberately contains no usage-table SQL and performs no writes.
 */
export interface ProviderAccountUsageAggregator {
  aggregateAccountUsage(query: AccountUsageAggregationQuery): Promise<AccountUsageAggregate>;
}

export interface AccountCogsReportRow {
  readonly accountId: string;
  readonly currency: string;
  readonly costMinorUnits: bigint;
  readonly amortizedCostMinorUnits: bigint;
  readonly sunkCostMinorUnits: bigint;
  readonly aliveDays: number;
  readonly tokens: bigint;
  readonly requests: bigint;
  readonly settledAmountMinorUnits: bigint;
  /** Floor(amortized cost * 1,000,000 / tokens); null when tokens are zero. */
  readonly costPerMillionTokensMinorUnits: bigint | null;
}

export interface AccountCogsPoolSummary {
  readonly currency: string;
  readonly costMinorUnits: bigint;
  readonly amortizedCostMinorUnits: bigint;
  readonly sunkCostMinorUnits: bigint;
  readonly aliveDays: number;
  readonly tokens: bigint;
  readonly requests: bigint;
  readonly settledAmountMinorUnits: bigint;
  readonly costPerMillionTokensMinorUnits: bigint | null;
}

export interface AccountCogsReport {
  readonly asOf: string;
  readonly currency: string;
  readonly accounts: readonly AccountCogsReportRow[];
  readonly pool: AccountCogsPoolSummary;
}

export interface ProviderAccountCostServiceOptions {
  readonly store: ProviderAccountCostStore;
  readonly usageAggregator: ProviderAccountUsageAggregator;
  readonly accountStateLookup: ProviderAccountStateLookup;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type AccountCostServiceErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'STORAGE_ERROR';

export class AccountCostServiceError extends Error {
  readonly code: AccountCostServiceErrorCode;

  constructor(code: AccountCostServiceErrorCode, message: string) {
    super(message);
    this.name = 'AccountCostServiceError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function invalid(message: string): never {
  throw new AccountCostServiceError('INVALID_INPUT', message);
}

function identifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 255 || value.trim() !== value) {
    return invalid(`${label} must be a non-empty, trimmed identifier of at most 255 characters.`);
  }
  return value;
}

function timestamp(value: AccountCostTimestampInput, label: string): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return invalid(`${label} must be a valid timestamp.`);
  return new Date(milliseconds).toISOString();
}

function storedTimestamp(value: AccountCostTimestampInput, label: string): string {
  try {
    return timestamp(value, label);
  } catch (error) {
    if (error instanceof AccountCostServiceError) {
      throw new AccountCostServiceError('STORAGE_ERROR', error.message);
    }
    throw error;
  }
}

function sourceNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.trim().length === 0 || value.length > 1024) {
    return invalid('sourceNote must be non-empty and at most 1024 characters when supplied.');
  }
  return value;
}

function periodMonths(period: ProviderAccountCostPeriod): number {
  switch (period) {
    case 'month':
      return 1;
    case 'quarter':
      return 3;
    case 'year':
      return 12;
    default:
      return invalid('period must be month, quarter, or year.');
  }
}

function addUtcMonths(milliseconds: number, months: number): number {
  const value = new Date(milliseconds);
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const targetMonthFirst = new Date(Date.UTC(year, month + months, 1));
  const targetYear = targetMonthFirst.getUTCFullYear();
  const targetMonth = targetMonthFirst.getUTCMonth();
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(value.getUTCDate(), daysInTargetMonth);
  return Date.UTC(
    targetYear,
    targetMonth,
    day,
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  );
}

function completeDays(fromMs: number, toMs: number): number {
  return toMs <= fromMs ? 0 : Math.floor((toMs - fromMs) / DAY_MS);
}

function amortizedMinorUnits(priceMinorUnits: bigint, aliveDays: number, periodDays: number): bigint {
  if (aliveDays <= 0) return 0n;
  if (aliveDays >= periodDays) return priceMinorUnits;
  return (priceMinorUnits * BigInt(aliveDays)) / BigInt(periodDays);
}

function perMillionMinorUnits(amortizedCostMinorUnits: bigint, tokens: bigint): bigint | null {
  return tokens === 0n ? null : (amortizedCostMinorUnits * TOKENS_PER_MILLION) / tokens;
}

function normalizeStoredCost(cost: ProviderAccountCost): ProviderAccountCost {
  try {
    const effectiveFrom = storedTimestamp(cost.effectiveFrom, 'effectiveFrom');
    const effectiveTo = cost.effectiveTo === null ? null : storedTimestamp(cost.effectiveTo, 'effectiveTo');
    if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
      throw new AccountCostServiceError('STORAGE_ERROR', 'Stored cost effectiveTo must follow effectiveFrom.');
    }
    periodMonths(cost.period);
    return {
      ...cost,
      id: identifier(cost.id, 'id'),
      accountId: identifier(cost.accountId, 'accountId'),
      priceMinorUnits: parseMinorUnits(cost.priceMinorUnits),
      currency: normalizeCurrency(cost.currency),
      period: cost.period,
      effectiveFrom,
      effectiveTo,
      sourceNote: sourceNote(cost.sourceNote),
      createdAt: storedTimestamp(cost.createdAt, 'createdAt'),
      updatedAt: storedTimestamp(cost.updatedAt, 'updatedAt'),
    };
  } catch (error) {
    if (error instanceof AccountCostServiceError && error.code === 'STORAGE_ERROR') throw error;
    throw new AccountCostServiceError('STORAGE_ERROR', 'Stored provider account cost is invalid.');
  }
}

interface MutableAccountReport {
  accountId: string;
  currency: string;
  costMinorUnits: bigint;
  amortizedCostMinorUnits: bigint;
  sunkCostMinorUnits: bigint;
  aliveDays: number;
  tokens: bigint;
  requests: bigint;
  settledAmountMinorUnits: bigint;
  usageFromMs: number;
  usageToMs: number;
}

type MutableAccountCogsPoolSummary = {
  -readonly [Key in keyof AccountCogsPoolSummary]: AccountCogsPoolSummary[Key];
};

function emptyPool(currency: string): MutableAccountCogsPoolSummary {
  return {
    currency,
    costMinorUnits: 0n,
    amortizedCostMinorUnits: 0n,
    sunkCostMinorUnits: 0n,
    aliveDays: 0,
    tokens: 0n,
    requests: 0n,
    settledAmountMinorUnits: 0n,
    costPerMillionTokensMinorUnits: null,
  };
}

/** Operational COGS only: no method here is called by customer billing or dispatch. */
export class ProviderAccountCostService {
  private readonly store: ProviderAccountCostStore;
  private readonly usageAggregator: ProviderAccountUsageAggregator;
  private readonly accountStateLookup: ProviderAccountStateLookup;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ProviderAccountCostServiceOptions) {
    this.store = options.store;
    this.usageAggregator = options.usageAggregator;
    this.accountStateLookup = options.accountStateLookup;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async createCost(input: CreateProviderAccountCostInput): Promise<ProviderAccountCost> {
    const cost = this.newCost(input);
    await this.store.create(cost);
    return cost;
  }

  async replaceEffectiveCost(input: ReplaceEffectiveProviderAccountCostInput): Promise<{
    readonly previous: ProviderAccountCost;
    readonly replacement: ProviderAccountCost;
  }> {
    const replacement = this.newCost(input);
    const previous = await this.store.findEffective(replacement.accountId, replacement.effectiveFrom);
    if (previous === null) {
      throw new AccountCostServiceError('NOT_FOUND', 'No effective cost exists at the replacement start.');
    }
    const normalizedPrevious = normalizeStoredCost(previous);
    if (Date.parse(normalizedPrevious.effectiveFrom) >= Date.parse(replacement.effectiveFrom)) {
      throw new AccountCostServiceError('CONFLICT', 'A replacement must start after the preceding cost.');
    }
    if (normalizedPrevious.currency !== replacement.currency) {
      throw new AccountCostServiceError('CONFLICT', 'A replacement cannot change the ledger currency.');
    }
    const previousUpdatedAt = timestamp(this.now(), 'now');
    await this.store.replaceEffective({
      previousCostId: normalizedPrevious.id,
      previousEffectiveTo: replacement.effectiveFrom,
      previousUpdatedAt,
      replacement,
    });
    return {
      previous: {
        ...normalizedPrevious,
        effectiveTo: replacement.effectiveFrom,
        updatedAt: previousUpdatedAt,
      },
      replacement,
    };
  }

  async getCost(id: string): Promise<ProviderAccountCost | null> {
    const cost = await this.store.getById(identifier(id, 'id'));
    return cost === null ? null : normalizeStoredCost(cost);
  }

  async listAccountCosts(accountId: string): Promise<readonly ProviderAccountCost[]> {
    const costs = await this.store.listByAccount(identifier(accountId, 'accountId'));
    return costs
      .map(normalizeStoredCost)
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || left.id.localeCompare(right.id));
  }

  async createCogsReport(input: {
    readonly asOf: AccountCostTimestampInput;
    readonly currency: string;
  }): Promise<AccountCogsReport> {
    const asOf = timestamp(input.asOf, 'asOf');
    const asOfMs = Date.parse(asOf);
    const currency = normalizeCurrency(input.currency);
    const costs = await this.store.listForReport({ asOf, currency });
    const accounts = new Map<string, MutableAccountReport>();

    for (const storedCost of costs) {
      const cost = normalizeStoredCost(storedCost);
      const startMs = Date.parse(cost.effectiveFrom);
      if (startMs >= asOfMs || cost.currency !== currency) continue;
      periodMonths(cost.period);
      const periodEndMs = addUtcMonths(startMs, periodMonths(cost.period));
      const periodDays = completeDays(startMs, periodEndMs);
      if (periodDays <= 0) throw new AccountCostServiceError('STORAGE_ERROR', 'Stored cost period has no days.');
      const state = await this.accountStateLookup.getProviderAccountState(cost.accountId);
      const observedBannedAtMs =
        state?.status === 'banned' && state.bannedAt !== undefined && state.bannedAt !== null
          ? Date.parse(storedTimestamp(state.bannedAt, 'bannedAt'))
          : null;
      const banned = state?.status === 'banned' && (observedBannedAtMs === null || observedBannedAtMs <= asOfMs);
      const bannedAtMs = banned ? observedBannedAtMs : null;
      let endMs = Math.min(asOfMs, periodEndMs);
      if (cost.effectiveTo !== null) endMs = Math.min(endMs, Date.parse(cost.effectiveTo));
      if (bannedAtMs !== null) endMs = Math.min(endMs, bannedAtMs);
      endMs = Math.max(startMs, endMs);
      const aliveDays = completeDays(startMs, endMs);
      const amortized = amortizedMinorUnits(cost.priceMinorUnits, aliveDays, periodDays);
      const sunk = banned ? cost.priceMinorUnits - amortized : 0n;
      const current = accounts.get(cost.accountId) ?? {
        accountId: cost.accountId,
        currency,
        costMinorUnits: 0n,
        amortizedCostMinorUnits: 0n,
        sunkCostMinorUnits: 0n,
        aliveDays: 0,
        tokens: 0n,
        requests: 0n,
        settledAmountMinorUnits: 0n,
        usageFromMs: startMs,
        usageToMs: startMs,
      };
      current.costMinorUnits = addMinorUnits(current.costMinorUnits, cost.priceMinorUnits);
      current.amortizedCostMinorUnits = addMinorUnits(current.amortizedCostMinorUnits, amortized);
      current.sunkCostMinorUnits = addMinorUnits(current.sunkCostMinorUnits, sunk);
      current.aliveDays += aliveDays;
      current.usageFromMs = Math.min(current.usageFromMs, startMs);
      current.usageToMs = Math.max(current.usageToMs, endMs);
      accounts.set(cost.accountId, current);
    }

    const rows: AccountCogsReportRow[] = [];
    const pool = emptyPool(currency);
    let poolAliveDays = 0;
    for (const account of [...accounts.values()].sort((left, right) => left.accountId.localeCompare(right.accountId))) {
      if (account.usageToMs > account.usageFromMs) {
        const usage = await this.usageAggregator.aggregateAccountUsage({
          accountId: account.accountId,
          from: new Date(account.usageFromMs).toISOString(),
          to: new Date(account.usageToMs).toISOString(),
          currency,
        });
        account.tokens = parseStoredMinorUnits(usage.tokens);
        account.requests = parseStoredMinorUnits(usage.requests);
        account.settledAmountMinorUnits = parseStoredMinorUnits(usage.settledAmountMinorUnits);
      }
      rows.push({
        accountId: account.accountId,
        currency,
        costMinorUnits: account.costMinorUnits,
        amortizedCostMinorUnits: account.amortizedCostMinorUnits,
        sunkCostMinorUnits: account.sunkCostMinorUnits,
        aliveDays: account.aliveDays,
        tokens: account.tokens,
        requests: account.requests,
        settledAmountMinorUnits: account.settledAmountMinorUnits,
        costPerMillionTokensMinorUnits: perMillionMinorUnits(account.amortizedCostMinorUnits, account.tokens),
      });
      pool.costMinorUnits = addMinorUnits(pool.costMinorUnits, account.costMinorUnits);
      pool.amortizedCostMinorUnits = addMinorUnits(pool.amortizedCostMinorUnits, account.amortizedCostMinorUnits);
      pool.sunkCostMinorUnits = addMinorUnits(pool.sunkCostMinorUnits, account.sunkCostMinorUnits);
      pool.tokens += account.tokens;
      pool.requests += account.requests;
      pool.settledAmountMinorUnits = addMinorUnits(pool.settledAmountMinorUnits, account.settledAmountMinorUnits);
      poolAliveDays += account.aliveDays;
    }
    pool.aliveDays = poolAliveDays;
    pool.costPerMillionTokensMinorUnits = perMillionMinorUnits(pool.amortizedCostMinorUnits, pool.tokens);
    return { asOf, currency, accounts: rows, pool };
  }

  private newCost(input: CreateProviderAccountCostInput): ProviderAccountCost {
    const effectiveFrom = timestamp(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo =
      input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : timestamp(input.effectiveTo, 'effectiveTo');
    if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
      return invalid('effectiveTo must be later than effectiveFrom.');
    }
    const now = timestamp(this.now(), 'now');
    periodMonths(input.period);
    return {
      id: identifier(input.id ?? this.idFactory(), 'id'),
      accountId: identifier(input.accountId, 'accountId'),
      priceMinorUnits: parseMinorUnits(input.priceMinorUnits),
      currency: normalizeCurrency(input.currency),
      period: input.period,
      effectiveFrom,
      effectiveTo,
      sourceNote: sourceNote(input.sourceNote),
      createdAt: now,
      updatedAt: now,
    };
  }
}

interface ProviderAccountCostRow {
  readonly id: unknown;
  readonly account_id: unknown;
  readonly price_minor_units: unknown;
  readonly currency: unknown;
  readonly period: unknown;
  readonly effective_from: Date | string;
  readonly effective_to: Date | string | null;
  readonly source_note: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const COST_SELECT_COLUMNS = `id, account_id, price_minor_units::text AS price_minor_units,
  currency, period, effective_from, effective_to, source_note, created_at, updated_at`;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AccountCostServiceError('STORAGE_ERROR', `Stored ${label} must be text.`);
  }
  return value;
}

function storedPeriod(value: unknown): ProviderAccountCostPeriod {
  switch (value) {
    case 'month':
    case 'quarter':
    case 'year':
      return value;
    default:
      throw new AccountCostServiceError('STORAGE_ERROR', 'Stored cost period is invalid.');
  }
}

function costFromRow(row: ProviderAccountCostRow): ProviderAccountCost {
  return normalizeStoredCost({
    id: requiredText(row.id, 'id'),
    accountId: requiredText(row.account_id, 'account_id'),
    priceMinorUnits: parseStoredMinorUnits(row.price_minor_units),
    currency: requiredText(row.currency, 'currency'),
    period: storedPeriod(row.period),
    effectiveFrom: storedTimestamp(row.effective_from, 'effective_from'),
    effectiveTo: row.effective_to === null ? null : storedTimestamp(row.effective_to, 'effective_to'),
    sourceNote: row.source_note === null ? null : requiredText(row.source_note, 'source_note'),
    createdAt: storedTimestamp(row.created_at, 'created_at'),
    updatedAt: storedTimestamp(row.updated_at, 'updated_at'),
  });
}

async function insertCost(executor: SqlExecutor, cost: ProviderAccountCost): Promise<void> {
  await executor.query(
    `INSERT INTO provider_account_cost
       (id, account_id, price_minor_units, currency, period, effective_from, effective_to,
        source_note, created_at, updated_at)
     VALUES ($1, $2, $3::bigint, $4, $5, $6::timestamptz, $7::timestamptz,
             $8, $9::timestamptz, $10::timestamptz)`,
    [
      cost.id,
      cost.accountId,
      cost.priceMinorUnits.toString(10),
      cost.currency,
      cost.period,
      cost.effectiveFrom,
      cost.effectiveTo,
      cost.sourceNote,
      cost.createdAt,
      cost.updatedAt,
    ],
  );
}

/** Production cost persistence; usage and account-state reads remain injected. */
export function createPostgresProviderAccountCostStore(database: SaasDatabase): ProviderAccountCostStore {
  return {
    async create(cost): Promise<void> {
      await insertCost(database, cost);
    },

    async getById(id): Promise<ProviderAccountCost | null> {
      const result = await database.query<ProviderAccountCostRow>(
        `SELECT ${COST_SELECT_COLUMNS} FROM provider_account_cost WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : costFromRow(row);
    },

    async listByAccount(accountId): Promise<readonly ProviderAccountCost[]> {
      const result = await database.query<ProviderAccountCostRow>(
        `SELECT ${COST_SELECT_COLUMNS}
           FROM provider_account_cost
          WHERE account_id = $1
          ORDER BY effective_from, id`,
        [accountId],
      );
      return result.rows.map(costFromRow);
    },

    async listForReport(input): Promise<readonly ProviderAccountCost[]> {
      const result = await database.query<ProviderAccountCostRow>(
        `SELECT ${COST_SELECT_COLUMNS}
           FROM provider_account_cost
          WHERE currency = $1 AND effective_from < $2::timestamptz
          ORDER BY account_id, effective_from, id`,
        [input.currency, input.asOf],
      );
      return result.rows.map(costFromRow);
    },

    async findEffective(accountId, at): Promise<ProviderAccountCost | null> {
      const result = await database.query<ProviderAccountCostRow>(
        `SELECT ${COST_SELECT_COLUMNS}
           FROM provider_account_cost
          WHERE account_id = $1
            AND effective_from <= $2::timestamptz
            AND (effective_to IS NULL OR effective_to > $2::timestamptz)
          ORDER BY effective_from DESC, id DESC
          LIMIT 1`,
        [accountId, at],
      );
      const row = result.rows[0];
      return row === undefined ? null : costFromRow(row);
    },

    async replaceEffective(write): Promise<void> {
      await database.transaction(async (transaction) => {
        const closed = await transaction.query<{ readonly id: string }>(
          `UPDATE provider_account_cost
              SET effective_to = $2::timestamptz, updated_at = $3::timestamptz
            WHERE id = $1
              AND effective_from < $2::timestamptz
              AND (effective_to IS NULL OR effective_to > $2::timestamptz)
            RETURNING id`,
          [write.previousCostId, write.previousEffectiveTo, write.previousUpdatedAt],
        );
        if (closed.rowCount !== 1) {
          throw new AccountCostServiceError('CONFLICT', 'The effective cost changed before replacement.');
        }
        await insertCost(transaction, write.replacement);
      });
    },
  };
}
