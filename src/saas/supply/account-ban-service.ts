import type { SaasDatabase } from '../db/types.js';
import {
  type AccountWindowStats,
  getAccountWindowStatsBatch,
} from '../gateway/postgres-provider-account-window-stats.js';
import type { ProviderAccountRecord, ProviderAccountReference, ProviderSupplyAuditContext } from './types.js';

const DAY_MS = 86_400_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_BATCH_SIZE = 100;

export interface ProviderAccountBanCommand {
  readonly account: ProviderAccountReference;
  readonly expectedAuthzVersion?: number;
  readonly reason: string;
  readonly lastError: string;
  readonly audit: ProviderSupplyAuditContext;
}

/** Implemented by ProviderSupplyService; kept narrow for worker assembly and tests. */
export interface ProviderAccountBanWriter {
  banProviderAccount(input: ProviderAccountBanCommand): Promise<ProviderAccountRecord>;
}

export interface GatewayAccountBanCandidate {
  readonly accountId: string;
  readonly authzVersion: number;
  readonly reason: 'persistent_forbidden' | 'verification_wall';
  readonly lastError: 'gateway_forbidden_failure' | 'gateway_verification_wall_failure';
}

export interface GatewayAccountBanCandidateSource {
  listGatewayAccountBanCandidates(input: {
    readonly failureThreshold: number;
    readonly limit: number;
  }): Promise<readonly GatewayAccountBanCandidate[]>;
}

interface BanCandidateRow {
  readonly id: unknown;
  readonly authz_version: unknown;
  readonly last_outcome: unknown;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function storedInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reads durable gateway health only from a background sweep. Candidate CAS is
 * completed by the normal supply lifecycle writer, so an operator mutation or
 * a concurrent replica cannot be overwritten by a stale ban decision.
 */
export class PostgresGatewayAccountBanCandidateSource implements GatewayAccountBanCandidateSource {
  constructor(private readonly database: SaasDatabase) {}

  async listGatewayAccountBanCandidates(input: {
    readonly failureThreshold: number;
    readonly limit: number;
  }): Promise<readonly GatewayAccountBanCandidate[]> {
    const result = await this.database.query<BanCandidateRow>(
      `SELECT account.id, account.authz_version, health.last_outcome
         FROM saas_provider_account_runtime_health health
         JOIN saas_platform_provider_accounts account ON account.id = health.account_id
        WHERE health.owner_kind = 'platform'
          AND health.owner_scope_key = 'platform'
          AND account.status = 'active'
          AND (
            (health.last_outcome = 'gateway_forbidden_failure'
              AND health.forbidden_failure_count >= $1)
            OR (health.last_outcome = 'gateway_verification_wall_failure'
              AND health.verification_wall_failure_count >= $1)
          )
        ORDER BY health.observed_at, account.id
        LIMIT $2`,
      [input.failureThreshold, input.limit],
    );
    const candidates: GatewayAccountBanCandidate[] = [];
    for (const row of result.rows) {
      const authzVersion = storedInteger(row.authz_version);
      if (typeof row.id !== 'string' || row.id === '' || authzVersion === null) continue;
      if (row.last_outcome === 'gateway_forbidden_failure') {
        candidates.push({
          accountId: row.id,
          authzVersion,
          reason: 'persistent_forbidden',
          lastError: row.last_outcome,
        });
      } else if (row.last_outcome === 'gateway_verification_wall_failure') {
        candidates.push({
          accountId: row.id,
          authzVersion,
          reason: 'verification_wall',
          lastError: row.last_outcome,
        });
      }
    }
    return candidates;
  }
}

export interface AccountBanDispositionOptions {
  readonly failureThreshold?: number;
  readonly batchSize?: number;
  readonly onError?: (error: unknown) => void;
}

export interface AccountBanSweepResult {
  readonly candidates: number;
  readonly banned: number;
  readonly failed: number;
}

/** Batched disposition; never constructed or called by request dispatch. */
export class AccountBanDispositionService {
  private readonly failureThreshold: number;
  private readonly batchSize: number;

  constructor(
    private readonly candidates: GatewayAccountBanCandidateSource,
    private readonly writer: ProviderAccountBanWriter,
    private readonly options: AccountBanDispositionOptions = {},
  ) {
    this.failureThreshold = positiveInteger(options.failureThreshold, DEFAULT_FAILURE_THRESHOLD, 8);
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 500);
  }

  async runGatewaySweep(): Promise<AccountBanSweepResult> {
    const candidates = await this.candidates.listGatewayAccountBanCandidates({
      failureThreshold: this.failureThreshold,
      limit: this.batchSize,
    });
    let banned = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.writer.banProviderAccount({
          account: { ownerKind: 'platform', tenantId: null, accountId: candidate.accountId },
          expectedAuthzVersion: candidate.authzVersion,
          reason: candidate.reason,
          lastError: candidate.lastError,
          audit: {
            actorUserId: 'account-ban-disposition-worker',
            entryPoint: 'account-ban-disposition-service',
          },
        });
        banned += 1;
      } catch (error) {
        failed += 1;
        this.options.onError?.(error);
      }
    }
    return { candidates: candidates.length, banned, failed };
  }
}

export interface AccountBanLedgerEntry {
  readonly accountId: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly status: 'banned';
  readonly bannedAt: string;
  readonly reason: string;
  readonly lastError: string;
  readonly aliveDays: number;
  readonly output: AccountWindowStats;
}

export type AccountOutputAggregator = (
  accountIds: readonly string[],
) => Promise<ReadonlyMap<string, AccountWindowStats>>;

interface AccountBanLedgerRow {
  readonly id: unknown;
  readonly created_at: unknown;
  readonly banned_at: unknown;
  readonly ban_reason: unknown;
  readonly ban_last_error: unknown;
}

interface AccountStateRow {
  readonly status: unknown;
  readonly banned_at: unknown;
}

function storedTimestamp(value: unknown): string | null {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Simple operational-state lookup consumed by account-cost-service, plus a
 * paginated ban ledger. Output aggregation is injectable and defaults to the
 * existing batched usage/attempt join from the beginning of epoch time.
 */
export class PostgresAccountBanLedger {
  private readonly aggregateOutput: AccountOutputAggregator;

  constructor(
    private readonly database: SaasDatabase,
    aggregateOutput?: AccountOutputAggregator,
  ) {
    this.aggregateOutput =
      aggregateOutput ?? ((accountIds) => getAccountWindowStatsBatch(this.database, accountIds, 0));
  }

  async getProviderAccountState(accountId: string): Promise<{ status: string; bannedAt: string | null } | null> {
    const result = await this.database.query<AccountStateRow>(
      `SELECT status, banned_at FROM saas_platform_provider_accounts WHERE id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    if (!row || typeof row.status !== 'string') return null;
    return { status: row.status, bannedAt: storedTimestamp(row.banned_at) };
  }

  async list(
    input: { readonly ownerKind?: 'tenant' | 'platform'; readonly tenantId?: string; readonly limit?: number } = {},
  ): Promise<readonly AccountBanLedgerEntry[]> {
    const ownerKind = input.ownerKind ?? 'platform';
    if (ownerKind === 'tenant' && (typeof input.tenantId !== 'string' || input.tenantId === '')) {
      throw new Error('tenantId is required for the tenant ban ledger');
    }
    const table = ownerKind === 'tenant' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
    const values: unknown[] = [positiveInteger(input.limit, DEFAULT_BATCH_SIZE, 500)];
    const tenantPredicate = ownerKind === 'tenant' ? 'AND tenant_id = $2' : '';
    if (ownerKind === 'tenant') values.push(input.tenantId);
    const result = await this.database.query<AccountBanLedgerRow>(
      `SELECT id, created_at, banned_at, ban_reason, ban_last_error
         FROM ${table}
        WHERE status = 'banned' ${tenantPredicate}
        ORDER BY banned_at, id
        LIMIT $1`,
      values,
    );
    const output = await this.aggregateOutput(
      result.rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])),
    );
    const entries: AccountBanLedgerEntry[] = [];
    for (const row of result.rows) {
      const bannedAt = storedTimestamp(row.banned_at);
      const createdAt = storedTimestamp(row.created_at);
      if (
        typeof row.id !== 'string' ||
        bannedAt === null ||
        createdAt === null ||
        typeof row.ban_reason !== 'string' ||
        typeof row.ban_last_error !== 'string'
      ) {
        continue;
      }
      entries.push({
        accountId: row.id,
        ownerKind,
        tenantId: ownerKind === 'tenant' ? (input.tenantId ?? null) : null,
        status: 'banned',
        bannedAt,
        reason: row.ban_reason,
        lastError: row.ban_last_error,
        aliveDays: Math.max(0, Math.floor((Date.parse(bannedAt) - Date.parse(createdAt)) / DAY_MS)),
        output: output.get(row.id) ?? { requests: 0, tokens: 0n },
      });
    }
    return entries;
  }
}
