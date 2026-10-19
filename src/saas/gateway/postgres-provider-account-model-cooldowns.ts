import type { SaasDatabase } from '../db/types.js';
import {
  MODEL_RATE_LIMIT_COOLDOWN_MS,
  type ProviderAccountModelRateLimit,
  type ProviderAccountRuntimeHealthCandidate,
  providerAccountModelCooldownScope,
} from './postgres-provider-account-runtime-health-store.js';
import type { RequestPreparationCandidateAuthority } from './request-preparation-service.js';

/**
 * Core-plan 9.1 (multi-instance state propagation): the durable
 * (account, model) cooldown registry — the PostgreSQL authority behind the
 * model-level rate limit (migration 133).
 *
 * The in-process `ProviderAccountModelRateLimit` collapses a
 * `model-unavailable` dispatch outcome (404 / plan-gated 400) into a local
 * Map, so with more than one gateway instance a cooldown recorded by one
 * process is invisible to the others. This registry keeps that Map as an L1
 * (instant same-process reads, availability while PG is down) and makes the
 * table the cross-instance authority:
 *
 * - Record: L1 first, then a best-effort durable upsert. The upsert merges
 *   with GREATEST so a shorter cooldown never shortens a longer one recorded
 *   by another instance. A failed write is swallowed (diagnostics hook only):
 *   the dispatch path that recorded it must not fail because of it.
 * - Read: L1 first, then one indexed point-select (`cooled_until > now`).
 *   The comparison IS the invalidation bound — no cached state, no TTL to
 *   reason about. A failed read resolves `false` (not excluded): a missing
 *   observation must never remove capacity (the scheduler's P17 posture).
 * - The row key is the same (owner scope, account, model) triple the
 *   in-process registry uses (`providerAccountModelCooldownScope`), so both
 *   implementations agree on scope by construction.
 *
 * Compositions that do not wire this registry keep the in-process Map alone
 * and the selection stays byte-identical (the optional-seam red line).
 */
const UPSERT_SQL = `/* postgres-provider-account-model-cooldowns:upsert */
INSERT INTO saas_provider_account_model_cooldowns
       (owner_scope_key, account_id, model, cooled_until, updated_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (owner_scope_key, account_id, model)
DO UPDATE SET cooled_until = GREATEST(
                saas_provider_account_model_cooldowns.cooled_until,
                EXCLUDED.cooled_until
              ),
              updated_at = EXCLUDED.updated_at
`;

const READ_SQL = `/* postgres-provider-account-model-cooldowns:read */
SELECT 1 AS excluded
  FROM saas_provider_account_model_cooldowns
 WHERE owner_scope_key = $1
   AND account_id = $2
   AND model = $3
   AND cooled_until > $4
 LIMIT 1
`;

export interface PostgresProviderAccountModelCooldownRegistryOptions {
  readonly database: SaasDatabase;
  /**
   * The same-process L1. When present it is written first (instant local
   * reads, availability during a PG outage) and consulted first on reads.
   */
  readonly local?: ProviderAccountModelRateLimit;
  readonly now?: () => Date;
  /** Best-effort failure diagnostics; the registry never rethrows. */
  readonly onError?: (error: unknown) => void;
}

export class PostgresProviderAccountModelCooldownRegistry {
  private readonly database: SaasDatabase;
  private readonly local?: ProviderAccountModelRateLimit;
  private readonly now: () => Date;
  private readonly onError?: (error: unknown) => void;

  constructor(options: PostgresProviderAccountModelCooldownRegistryOptions) {
    if (!options || typeof options !== 'object' || !options.database || typeof options.database.query !== 'function') {
      throw new TypeError('database is required');
    }
    this.database = options.database;
    this.local = options.local;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  /**
   * Records the (account, model) cooldown: L1 immediately, durable upsert
   * best-effort. Never throws — the caller is a dispatch failure path.
   */
  async recordModelRateLimit(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly model: string;
    readonly nowMs?: number;
  }): Promise<void> {
    this.local?.recordModelRateLimit(input);
    const scope = providerAccountModelCooldownScope(input?.candidate, input?.model);
    if (!scope) return;
    const nowMs = input.nowMs ?? this.now().getTime();
    try {
      await this.database.query(UPSERT_SQL, [
        scope.ownerScopeKey,
        scope.accountId,
        scope.model,
        new Date(nowMs + MODEL_RATE_LIMIT_COOLDOWN_MS),
        new Date(nowMs),
      ]);
    } catch (error) {
      // Best-effort durability: the L1 still holds the cooldown locally and a
      // failed write must never break the recording dispatch path.
      this.onError?.(error);
    }
  }

  /**
   * True while the pair is inside its cooldown, read from the durable rows
   * (L1 first for same-process immediacy). Fail-open: any read failure
   * resolves false — a missing observation must never remove capacity.
   */
  async isModelExcluded(input: {
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly model: string;
    readonly now: Date;
  }): Promise<boolean> {
    if (this.local?.isModelExcluded(input)) return true;
    const scope = providerAccountModelCooldownScope(input?.candidate, input?.model);
    if (!scope || !(input?.now instanceof Date)) return false;
    try {
      const result = await this.database.query<{ excluded: number }>(READ_SQL, [
        scope.ownerScopeKey,
        scope.accountId,
        scope.model,
        input.now,
      ]);
      return Array.isArray(result?.rows) && result.rows.length > 0;
    } catch (error) {
      this.onError?.(error);
      return false;
    }
  }
}
