import type { SaasDatabase } from '../db/index.js';
import type { ClaudeQuotaSnapshot, ClaudeRateLimitClassification } from '../gateway/claude/quota-headers.js';
import type { CodexRateLimitSnapshot } from '../gateway/codex/quota-headers.js';
import { GEMINI_CREDENTIAL_TYPE, GEMINI_PRODUCT_ID, GEMINI_PROVIDER_ID } from '../gateway/gemini/catalog-identity.js';
import type { GeminiUsageProgress, GeminiUsageSnapshot } from '../gateway/gemini/quota-usage.js';

/**
 * R-dormant activation: the in-repo Postgres writer for the migration
 * 099/100/111 per-category quota-snapshot column families. The opencode-go
 * family (migration 108) keeps its dedicated store/worker; this store serves
 * the three oauth-subscription categories whose columns were dormant:
 *
 * - codex (099): the transport's `parseCodexRateLimitHeaders` snapshot,
 *   observed off every response (the transport already parses all statuses);
 * - claude (100): the success-path `parseClaudeQuotaSnapshot` per-window
 *   utilization snapshot plus the 5h session-window anchor
 *   [reset − 5h, reset] (the sub2api UpdateSessionWindow semantics);
 * - gemini (111): the request-count snapshot computed by the usage worker
 *   from `saas_attempts` (Gemini exposes no upstream usage endpoint; the
 *   sub2api gemini_quota.go port folds per-model-class request counts
 *   against the tier RPD/RPM policy).
 *
 * Owner scoping follows the opencode-go store: the transport sinks carry
 * only the owner-neutral account id, so `resolveQuotaSnapshotAccountOwner`
 * maps it to the owning table row (tenant rows are keyed (tenant_id, id);
 * the platform table by id). The sink adapters can pass the owner scope
 * directly when the dispatch context knows it, skipping the resolution read.
 *
 * The snapshot is a scheduling signal only; it never enters the billing
 * path (093/099/100/111 quota-snapshot precedent). Windows absent from an
 * observation are written NULL (never guessed) — the opencode-go precedent.
 */

export class ProviderQuotaSnapshotStoreError extends Error {
  readonly code = 'PROVIDER_QUOTA_SNAPSHOT_STORE_UNAVAILABLE' as const;

  constructor() {
    super('Provider quota snapshot store is unavailable');
    this.name = 'ProviderQuotaSnapshotStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function storeUnavailable(): never {
  throw new ProviderQuotaSnapshotStoreError();
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    storeUnavailable();
  }
  return value;
}

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) storeUnavailable();
  return new Date(value).toISOString();
}

function nullableIsoTimestamp(value: number | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

function nullableFinite(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) storeUnavailable();
  return value;
}

function nullableCount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) storeUnavailable();
  return value;
}

/** Owner-scoped reference to one provider account row. */
export interface QuotaSnapshotAccountRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
}

const TENANT_ACCOUNTS = 'saas_tenant_provider_accounts';
const PLATFORM_ACCOUNTS = 'saas_platform_provider_accounts';

function accountPredicate(account: QuotaSnapshotAccountRef, next: number): { sql: string; values: unknown[] } {
  if (account.ownerKind === 'tenant') {
    if (typeof account.tenantId !== 'string' || account.tenantId.length === 0) storeUnavailable();
    return { sql: `tenant_id = $${next} AND id = $${next + 1}`, values: [account.tenantId, account.accountId] };
  }
  if (account.tenantId !== null) storeUnavailable();
  return { sql: `id = $${next}`, values: [account.accountId] };
}

/**
 * Maps an owner-neutral account id to its owning row. The transport sinks
 * observe only the account id; tenant rows are keyed (tenant_id, id), so the
 * resolution reads both tables once. An id that matches nothing (deleted
 * account, foreign shape) resolves to null and the write is skipped.
 */
export async function resolveQuotaSnapshotAccountOwner(
  database: SaasDatabase,
  accountId: string,
): Promise<QuotaSnapshotAccountRef | null> {
  const id = safeText(accountId);
  const result = await database.query<{ owner_kind: string; tenant_id: string | null }>(
    `SELECT 'tenant'::text AS owner_kind, tenant_id::text AS tenant_id
       FROM ${TENANT_ACCOUNTS} WHERE id = $1
      UNION ALL
     SELECT 'platform'::text AS owner_kind, NULL::text AS tenant_id
       FROM ${PLATFORM_ACCOUNTS} WHERE id = $1`,
    [id],
  );
  const rows = result.rows;
  if (rows.length === 0) return null;
  const tenantRow = rows.find((row) => row.owner_kind === 'tenant');
  if (tenantRow !== undefined && typeof tenantRow.tenant_id === 'string' && tenantRow.tenant_id.length > 0) {
    return { ownerKind: 'tenant', tenantId: tenantRow.tenant_id, accountId: id };
  }
  return { ownerKind: 'platform', tenantId: null, accountId: id };
}

/** One claimed gemini account for the usage worker round. */
export interface ClaimedGeminiAccount {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly tierId: string | null;
}

export interface PostgresProviderQuotaSnapshotStoreOptions {
  /** Overridable clock (worker cadence tests); defaults to Date.now. */
  readonly nowMs?: () => number;
}

/**
 * Postgres writer for the migration 099/100/111 quota-snapshot column
 * families. Every method is best-effort typed: store failures surface as
 * {@link ProviderQuotaSnapshotStoreError} and the caller (a transport sink
 * or worker round) drops the observation.
 */
export class PostgresProviderQuotaSnapshotStore {
  private readonly nowMs: () => number;

  constructor(
    private readonly database: SaasDatabase,
    options: PostgresProviderQuotaSnapshotStoreOptions = {},
  ) {
    if (!options || typeof options !== 'object') storeUnavailable();
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private async query<Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.database.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof ProviderQuotaSnapshotStoreError) throw error;
      storeUnavailable();
    }
  }

  /**
   * Parameterized account-row UPDATE. `sets` receives the index of the first
   * SET parameter (after the owner predicate's parameters) so both owner
   * scopes — the tenant predicate binds two parameters, the platform one —
   * share one builder.
   */
  private async updateAccount(
    account: QuotaSnapshotAccountRef,
    sets: (start: number) => readonly string[],
    values: readonly unknown[],
  ): Promise<void> {
    const table = account.ownerKind === 'tenant' ? TENANT_ACCOUNTS : PLATFORM_ACCOUNTS;
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${table}
          SET ${sets(predicate.values.length + 1).join(', ')}, updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [...predicate.values, ...values],
    );
  }

  /** Codex (migration 099): the normalized 5h/7d used-percent snapshot. */
  async writeCodexSnapshot(
    account: QuotaSnapshotAccountRef,
    snapshot: CodexRateLimitSnapshot,
    observedAtMs: number,
  ): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') storeUnavailable();
    const observedAt = isoTimestamp(observedAtMs);
    const reset5hAtMs =
      snapshot.reset5hSeconds !== null && snapshot.reset5hSeconds >= 0
        ? observedAtMs + snapshot.reset5hSeconds * 1000
        : null;
    const reset7dAtMs =
      snapshot.reset7dSeconds !== null && snapshot.reset7dSeconds >= 0
        ? observedAtMs + snapshot.reset7dSeconds * 1000
        : null;
    await this.updateAccount(
      account,
      (start) => [
        `codex_5h_used_percent = $${start}`,
        `codex_5h_reset_at = $${start + 1}`,
        `codex_7d_used_percent = $${start + 2}`,
        `codex_7d_reset_at = $${start + 3}`,
        `codex_usage_updated_at = $${start + 4}`,
      ],
      [
        nullableFinite(snapshot.used5hPercent),
        nullableIsoTimestamp(reset5hAtMs),
        nullableFinite(snapshot.used7dPercent),
        nullableIsoTimestamp(reset7dAtMs),
        observedAt,
      ],
    );
  }

  /**
   * Claude (migration 100): the per-window utilization snapshot plus the 5h
   * session-window anchor. The session window initializes (or re-anchors on
   * a different reset) only when the observation carries a plausible 5h
   * reset — the sub2api UpdateSessionWindow shape: an unchanged, still-open
   * window never rewrites its boundary columns.
   */
  async writeClaudeSnapshot(
    account: QuotaSnapshotAccountRef,
    snapshot: ClaudeQuotaSnapshot,
    observedAtMs: number,
  ): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.windows)) storeUnavailable();
    const observedAt = isoTimestamp(observedAtMs);
    const byWindow = new Map(snapshot.windows.map((window) => [window.window, window]));
    const readWindow = (label: string) => byWindow.get(label) ?? null;
    const fiveHour = readWindow('5h');
    const sevenDay = readWindow('7d');
    const sonnet = readWindow('7d_sonnet');
    const oi = readWindow('7d_oi');
    const utilization = (window: { readonly utilization: number | null } | null): number | null =>
      nullableFinite(window?.utilization ?? null);
    const reset = (window: { readonly resetAtMs: number | null } | null): string | null =>
      nullableIsoTimestamp(window?.resetAtMs ?? null);
    const fiveHourReset = fiveHour?.resetAtMs ?? null;
    // Session-window re-anchor condition: a usable 5h reset AND (no stored
    // end OR a different end OR the stored end already elapsed).
    const sessionWindowCase = (column: 'start' | 'end') => {
      const assignment = column === 'start' ? `$reset::timestamptz - interval '5 hours'` : '$reset::timestamptz';
      return `${column === 'start' ? 'claude_session_window_start' : 'claude_session_window_end'} = CASE
           WHEN $reset::timestamptz IS NOT NULL
                AND (claude_session_window_end IS NULL
                     OR claude_session_window_end <> $reset::timestamptz
                     OR claude_session_window_end <= $observed::timestamptz)
           THEN ${assignment}
           ELSE ${column === 'start' ? 'claude_session_window_start' : 'claude_session_window_end'} END`;
    };
    const sets = [
      'claude_5h_utilization = $3',
      'claude_5h_reset_at = $4',
      'claude_7d_utilization = $5',
      'claude_7d_reset_at = $6',
      'claude_7d_sonnet_utilization = $7',
      'claude_7d_sonnet_reset_at = $8',
      'claude_7d_oi_utilization = $9',
      'claude_7d_oi_reset_at = $10',
      'claude_usage_updated_at = $11',
    ];
    await this.updateAccount(
      account,
      (start) => {
        const withStart = sets.map((clause) =>
          clause.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + start - 3}`),
        );
        withStart.push(
          sessionWindowCase('start')
            .replaceAll('$reset', `$${start + 9}`)
            .replaceAll('$observed', `$${start + 10}`),
          sessionWindowCase('end')
            .replaceAll('$reset', `$${start + 9}`)
            .replaceAll('$observed', `$${start + 10}`),
        );
        return withStart;
      },
      [
        utilization(fiveHour),
        reset(fiveHour),
        utilization(sevenDay),
        reset(sevenDay),
        utilization(sonnet),
        reset(sonnet),
        utilization(oi),
        reset(oi),
        observedAt,
        nullableIsoTimestamp(fiveHourReset),
        observedAt,
      ],
    );
  }

  /** Gemini (migration 111): the tier-shaped request-count snapshot. */
  async writeGeminiSnapshot(
    account: QuotaSnapshotAccountRef,
    snapshot: GeminiUsageSnapshot,
    observedAtMs: number,
  ): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') storeUnavailable();
    const used = (window: GeminiUsageProgress | null): number | null => nullableCount(window?.used ?? null);
    const limit = (window: GeminiUsageProgress | null): number | null => nullableCount(window?.limit ?? null);
    await this.updateAccount(
      account,
      (start) => [
        `gemini_shared_daily_used = $${start}`,
        `gemini_shared_daily_limit = $${start + 1}`,
        `gemini_pro_daily_used = $${start + 2}`,
        `gemini_pro_daily_limit = $${start + 3}`,
        `gemini_flash_daily_used = $${start + 4}`,
        `gemini_flash_daily_limit = $${start + 5}`,
        `gemini_minute_used = $${start + 6}`,
        `gemini_minute_limit = $${start + 7}`,
        `gemini_daily_reset_at = $${start + 8}`,
        `gemini_usage_updated_at = $${start + 9}`,
        'gemini_rate_limited_until = NULL',
      ],
      [
        used(snapshot.sharedDaily),
        limit(snapshot.sharedDaily),
        used(snapshot.proDaily),
        limit(snapshot.proDaily),
        used(snapshot.flashDaily),
        limit(snapshot.flashDaily),
        used(snapshot.minute),
        limit(snapshot.minute),
        isoTimestamp(snapshot.dailyResetAtMs),
        isoTimestamp(observedAtMs),
      ],
    );
  }

  /**
   * Gemini worker claim (the opencode-go attempt-stamp lease): one atomic
   * UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING per
   * owner table stamps `gemini_usage_updated_at` for due gemini accounts
   * (binding triple + active/verified + refresh debounce + 429 cooldown
   * guard). The stamp IS the lease: a crashed round leaves it behind and the
   * account re-enters the scan only after the debounce floor passes.
   */
  async claimDueGeminiAccounts(input: {
    readonly refreshMs: number;
    readonly limit: number;
  }): Promise<ClaimedGeminiAccount[]> {
    const now = isoTimestamp(this.nowMs());
    const refreshSeconds = Math.max(1, Math.round(input.refreshMs / 1000));
    const scopes = [
      { table: TENANT_ACCOUNTS, ownerKind: 'tenant' as const },
      { table: PLATFORM_ACCOUNTS, ownerKind: 'platform' as const },
    ];
    const claimed: ClaimedGeminiAccount[] = [];
    for (const scope of scopes) {
      const rows = await this.query<{
        id: string;
        tenant_id: string | null;
        gemini_tier_id: string | null;
      }>(
        `UPDATE ${scope.table} AS account
            SET gemini_usage_updated_at = $1::timestamptz, updated_at = clock_timestamp()
          WHERE account.id IN (
                SELECT claim.id
                  FROM ${scope.table} AS claim
                 WHERE claim.status = 'active' AND claim.validation_state = 'verified'
                   AND claim.provider_id = $2 AND claim.product_id = $3 AND claim.credential_type = $4
                   AND (claim.gemini_usage_updated_at IS NULL
                        OR claim.gemini_usage_updated_at
                           <= clock_timestamp() - ($5::text || ' seconds')::interval)
                   AND (claim.gemini_rate_limited_until IS NULL
                        OR claim.gemini_rate_limited_until <= clock_timestamp())
                 ORDER BY claim.id
                 LIMIT $6
                   FOR UPDATE SKIP LOCKED)
          RETURNING account.id${
            scope.ownerKind === 'tenant' ? ', account.tenant_id' : ', NULL::text AS tenant_id'
          }, account.gemini_tier_id`,
        [now, GEMINI_PROVIDER_ID, GEMINI_PRODUCT_ID, GEMINI_CREDENTIAL_TYPE, String(refreshSeconds), input.limit],
      );
      for (const row of rows) {
        claimed.push({
          ownerKind: scope.ownerKind,
          tenantId:
            scope.ownerKind === 'tenant' && typeof row.tenant_id === 'string' && row.tenant_id.length > 0
              ? row.tenant_id
              : null,
          accountId: safeText(row.id),
          tierId: typeof row.gemini_tier_id === 'string' && row.gemini_tier_id.length > 0 ? row.gemini_tier_id : null,
        });
      }
    }
    return claimed;
  }

  /**
   * Per-model request counts for one gemini account since `windowStartMs`
   * (the sub2api GetAccountWindowStats aggregate over usage facts; here the
   * attempt table is the per-account+model source — usage events carry no
   * model or account binding). Succeeded attempts only: a request the
   * upstream never served did not consume tier quota.
   */
  async readGeminiWindowRequestCounts(
    account: QuotaSnapshotAccountRef,
    windowStartMs: number,
  ): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    const rows = await this.query<{ model: string; requests: number | string }>(
      `SELECT resolved_model AS model, count(*)::int AS requests
         FROM saas_attempts
        WHERE account_id = $1 AND created_at >= $2::timestamptz AND result_state = 'succeeded'
        GROUP BY resolved_model`,
      [safeText(account.accountId), isoTimestamp(windowStartMs)],
    );
    for (const row of rows) {
      const model = safeText(row.model);
      const requests = Number(row.requests);
      if (Number.isSafeInteger(requests) && requests > 0) counts[model] = requests;
    }
    return counts;
  }

  /** Rolling-minute request total for one gemini account. */
  async readGeminiMinuteRequestCount(account: QuotaSnapshotAccountRef, nowMs: number): Promise<number> {
    const rows = await this.query<{ requests: number | string }>(
      `SELECT count(*)::int AS requests
         FROM saas_attempts
        WHERE account_id = $1 AND created_at >= $2::timestamptz AND result_state = 'succeeded'`,
      [safeText(account.accountId), isoTimestamp(nowMs - 60_000)],
    );
    const requests = Number(rows[0]?.requests ?? 0);
    return Number.isSafeInteger(requests) && requests >= 0 ? requests : 0;
  }

  /**
   * Claude 429 classification write (the ClaudeRateLimitSink sink): the
   * classification's session-window anchor [reset − 5h, reset] persists into
   * the boundary columns with the same re-anchor-only semantics as the
   * snapshot write; the per-window utilization/reset columns come from the
   * same response's quota snapshot, so this write never touches them.
   */
  async writeClaudeRateLimit(
    account: QuotaSnapshotAccountRef,
    classification: ClaudeRateLimitClassification,
    observedAtMs: number,
  ): Promise<void> {
    if (!classification || typeof classification !== 'object') storeUnavailable();
    const observedAt = isoTimestamp(observedAtMs);
    await this.updateAccount(
      account,
      (start) => {
        const reset = `$${start + 1}::timestamptz`;
        const observed = `$${start + 2}::timestamptz`;
        const condition = `${reset} IS NOT NULL
                AND (claude_session_window_end IS NULL
                     OR claude_session_window_end <> ${reset}
                     OR claude_session_window_end <= ${observed})`;
        return [
          `claude_session_window_start = CASE WHEN ${condition}
             THEN ${reset} - interval '5 hours'
             ELSE claude_session_window_start END`,
          `claude_session_window_end = CASE WHEN ${condition}
             THEN ${reset}
             ELSE claude_session_window_end END`,
          `claude_usage_updated_at = ${observed}`,
        ];
      },
      [nullableIsoTimestamp(classification.fiveHourResetAtMs ?? classification.sessionWindowEndMs ?? null), observedAt],
    );
  }

  /** Gemini 429 cooldown write (the GeminiRateLimitSink sink, migration 111). */
  async writeGeminiRateLimited(account: QuotaSnapshotAccountRef, untilMs: number): Promise<void> {
    await this.updateAccount(account, (start) => [`gemini_rate_limited_until = $${start}::timestamptz`], [
      isoTimestamp(untilMs),
    ]);
  }
}

/**
 * Transport-sink adapters over the store (R-dormant activation): each
 * adapter matches the corresponding transport sink contract structurally
 * (the sinks carry the owner-neutral account id; the adapter resolves the
 * owning row once per observation and drops the write when resolution or
 * persistence fails — best-effort by the transport contract). The operator
 * runtime module wires these into the category transports; the gemini
 * family needs no sink (its snapshot is worker-computed).
 */
export interface ProviderQuotaSnapshotSinks {
  /** Codex transport `writeQuotaSnapshot` sink (every-response headers). */
  readonly codexQuotaSnapshot: (record: {
    readonly accountId: string;
    readonly snapshot: CodexRateLimitSnapshot;
    readonly observedAtMs: number;
    readonly fromStatus: number;
  }) => Promise<void>;
  /** Claude transport `writeQuotaSnapshot` sink (every-response headers). */
  readonly claudeQuotaSnapshot: (record: {
    readonly accountId: string;
    readonly snapshot: ClaudeQuotaSnapshot;
    readonly observedAtMs: number;
    readonly fromStatus: number;
  }) => Promise<void>;
  /** Claude transport `writeRateLimit` sink (429 classification). */
  readonly claudeRateLimit: (record: {
    readonly accountId: string;
    readonly classification: ClaudeRateLimitClassification;
    readonly observedAtMs: number;
    readonly fromStatus: number;
  }) => Promise<void>;
  /** Gemini transport `writeRateLimit` sink (429 cooldown deadline). */
  readonly geminiRateLimit: (record: {
    readonly accountId: string;
    readonly classification: { readonly resetAtMs: number };
    readonly observedAtMs: number;
    readonly fromStatus: number;
  }) => Promise<void>;
}

export function createProviderQuotaSnapshotSinks(
  store: PostgresProviderQuotaSnapshotStore,
  resolveOwner: (accountId: string) => Promise<QuotaSnapshotAccountRef | null> = (accountId) =>
    resolveQuotaSnapshotAccountOwner(storeDatabase(store), accountId),
): ProviderQuotaSnapshotSinks {
  return {
    async codexQuotaSnapshot(record) {
      const account = await resolveOwner(record.accountId);
      if (account === null) return;
      await store.writeCodexSnapshot(account, record.snapshot, record.observedAtMs);
    },
    async claudeQuotaSnapshot(record) {
      const account = await resolveOwner(record.accountId);
      if (account === null) return;
      await store.writeClaudeSnapshot(account, record.snapshot, record.observedAtMs);
    },
    async claudeRateLimit(record) {
      const account = await resolveOwner(record.accountId);
      if (account === null) return;
      await store.writeClaudeRateLimit(account, record.classification, record.observedAtMs);
    },
    async geminiRateLimit(record) {
      const account = await resolveOwner(record.accountId);
      if (account === null) return;
      await store.writeGeminiRateLimited(account, record.classification.resetAtMs);
    },
  };
}

function storeDatabase(store: PostgresProviderQuotaSnapshotStore): SaasDatabase {
  // The store guards its database handle privately; the adapter's default
  // owner resolution goes through the same handle via the exported helper.
  return (store as unknown as { database: SaasDatabase }).database;
}
