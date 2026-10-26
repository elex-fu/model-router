import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import type { SaasDatabase } from '../db/types.js';
import type { RedisRuntimeCache } from '../runtime/redis-concurrency-slots.js';
import {
  type ProviderAccountModelRateLimit,
  providerAccountModelCooldownScope,
} from './postgres-provider-account-runtime-health-store.js';
import type { ProviderAccountSchedulerInput } from './provider-account-scheduler.js';
import { type AccountWindowCostFacts, getAccountWindowCostFactsBatch } from './provider-account-window-cost-gate.js';
import type { RequestPreparationCandidateAuthority } from './request-preparation-service.js';

interface Snapshot {
  version: 1;
  key: string;
  observedAt: number;
  expiresAt: number;
  cooldowns: Array<[string, number]>;
  windows: Array<[string, string | null, string | null, number, string]>;
}
export interface SchedulerHintCacheOptions {
  readonly redis?: RedisRuntimeCache;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly redisBudgetMs?: number;
}

const scopeKey = (scope: { ownerScopeKey: string; accountId: string; model: string }) =>
  JSON.stringify([scope.ownerScopeKey, scope.accountId, scope.model]);
const integer = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

/** Short-lived, non-authoritative scheduling observations. Never caches errors.
 * One Redis operation per candidate SET, not per candidate. Cache writes are
 * dispensable and bounded; financial/state writes do not use this mechanism.
 */
export class CachedSchedulerHints {
  private readonly context = new AsyncLocalStorage<
    { snapshot?: Snapshot; keys: string[]; ids: string[] } | undefined
  >();
  private readonly entries = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();
  private redisBusy = false;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly budget: number;

  constructor(
    private readonly database: SaasDatabase,
    private readonly localCooldown: ProviderAccountModelRateLimit,
    private readonly options: SchedulerHintCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 100;
    this.maxEntries = options.maxEntries ?? 512;
    this.budget = options.redisBudgetMs ?? 5;
    for (const value of [this.ttlMs, this.maxEntries, this.budget]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid scheduler hint cache bounds');
    }
  }

  async run<T>(input: ProviderAccountSchedulerInput, work: () => Promise<T>): Promise<T> {
    if (
      !Array.isArray(input?.candidates) ||
      input.candidates.length === 0 ||
      input.candidates.length > 128 ||
      input.candidates.some((candidate) => !candidate || typeof candidate !== 'object')
    )
      return work();
    const scopes = input.candidates.map((candidate) =>
      providerAccountModelCooldownScope(candidate, candidate.resolvedModel),
    );
    if (scopes.some((scope) => scope === null)) return work();
    const keys = [...new Set(scopes.flatMap((scope) => (scope === null ? [] : [scopeKey(scope)])))].sort();
    const ids = [...new Set(input.candidates.map((candidate) => candidate.accountId))].sort();
    const key = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
    let snapshot: Snapshot | undefined;
    try {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > this.now()) snapshot = cached;
      else {
        this.entries.delete(key);
        let pending = this.pending.get(key);
        if (!pending) {
          pending = this.load(key, keys, ids);
          if (this.pending.size < this.maxEntries) {
            this.pending.set(key, pending);
            void pending.finally(() => this.pending.delete(key)).catch(() => {});
          }
        }
        snapshot = await pending;
      }
    } catch {
      // Preserve each original port's existing fail-open read semantics.
    }
    return this.context.run({ snapshot, keys, ids }, work);
  }

  cooldown(candidate: RequestPreparationCandidateAuthority, model: string, now: Date): boolean | undefined {
    // A just-recorded local cooldown must win over an older negative snapshot.
    if (this.localCooldown.isModelExcluded({ candidate, model, now })) return true;
    const scope = providerAccountModelCooldownScope(candidate, model);
    const context = this.context.getStore();
    if (!scope || !context?.keys.includes(scopeKey(scope))) return undefined;
    // This optional hint is unavailable: do not amplify one slow/failed batch
    // into a fresh DB query per candidate. Durable health/lease still gate send.
    if (!context.snapshot || context.snapshot.expiresAt <= this.now()) return false;
    const until = context.snapshot.cooldowns.find(([key]) => key === scopeKey(scope))?.[1];
    return until !== undefined && until > now.getTime();
  }

  window(accountId: string): AccountWindowCostFacts | null | undefined {
    const context = this.context.getStore();
    if (!context?.ids.includes(accountId)) return undefined;
    if (!context.snapshot || context.snapshot.expiresAt <= this.now()) return null;
    const row = context.snapshot.windows.find(([id]) => id === accountId);
    return row
      ? {
          limitMinorUnits: row[1] === null ? null : BigInt(row[1]),
          reserveMinorUnits: row[2] === null ? null : BigInt(row[2]),
          windowStartMs: row[3],
          usageMinorUnits: BigInt(row[4]),
        }
      : null; // Explicitly confirmed no policy, distinct from an unknown read.
  }

  private remember(snapshot: Snapshot): void {
    if (snapshot.expiresAt <= this.now()) return;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(snapshot.key, snapshot);
  }

  private async load(key: string, keys: string[], ids: string[]): Promise<Snapshot> {
    const redis = this.options.redis;
    if (redis && !this.redisBusy) {
      const result = await this.redisOperation(() => redis.get(`scheduler-hints:v1:${key}`));
      if (result?.state === 'hit' && result.value && result.value.length <= 4096) {
        const decoded = this.decode(result.value, key, keys, ids);
        if (decoded) {
          this.remember(decoded);
          return decoded;
        }
      }
    }
    const observedAt = this.now();
    const scopes = keys.map((key) => JSON.parse(key) as [string, string, string]);
    const [cooldowns, windows] = await Promise.all([
      this.database.query<{ owner_scope_key: string; account_id: string; model: string; cooled_until: Date | string }>(
        `/* scheduler-hints:cooldowns-batch */
         SELECT cooldown.owner_scope_key, cooldown.account_id, cooldown.model, cooldown.cooled_until
           FROM saas_provider_account_model_cooldowns cooldown
           JOIN jsonb_to_recordset($1::jsonb) AS scope(owner_scope_key text, account_id text, model text)
             USING (owner_scope_key, account_id, model)
          WHERE cooldown.cooled_until > $2::timestamptz`,
        [
          JSON.stringify(
            scopes.map(([owner_scope_key, account_id, model]) => ({ owner_scope_key, account_id, model })),
          ),
          new Date(observedAt),
        ],
      ),
      getAccountWindowCostFactsBatch(this.database, ids, observedAt),
    ]);
    const snapshot: Snapshot = {
      version: 1,
      key,
      observedAt,
      expiresAt: Math.min(observedAt + this.ttlMs, (Math.floor(observedAt / 3_600_000) + 1) * 3_600_000),
      cooldowns: cooldowns.rows.map((row) => [
        scopeKey({ ownerScopeKey: row.owner_scope_key, accountId: row.account_id, model: row.model }),
        new Date(row.cooled_until).getTime(),
      ]),
      windows: [...windows].map(([id, fact]) => [
        id,
        fact.limitMinorUnits?.toString() ?? null,
        fact.reserveMinorUnits?.toString() ?? null,
        fact.windowStartMs,
        (fact.usageMinorUnits ?? 0n).toString(),
      ]),
    };
    for (const row of snapshot.windows) {
      const end = row[3] + 5 * 3_600_000;
      if (end > observedAt) snapshot.expiresAt = Math.min(snapshot.expiresAt, end);
    }
    // Validate PG data too: do not turn malformed/missing fields into negatives.
    const encoded = Buffer.from(JSON.stringify(snapshot));
    if (!this.decode(encoded, key, keys, ids, false)) throw new Error('Invalid scheduler hint snapshot');
    this.remember(snapshot);
    const ttl = Math.floor(snapshot.expiresAt - this.now());
    if (redis && !this.redisBusy && encoded.length <= 4096 && ttl > 0) {
      void this.redisOperation(() => redis.set(`scheduler-hints:v1:${key}`, encoded, ttl));
    }
    return snapshot;
  }

  private decode(bytes: Buffer, key: string, keys: string[], ids: string[], requireFresh = true): Snapshot | undefined {
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Snapshot;
      if (
        value.version !== 1 ||
        value.key !== key ||
        !Number.isSafeInteger(value.observedAt) ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.observedAt > this.now() ||
        value.expiresAt > value.observedAt + this.ttlMs ||
        value.expiresAt <= value.observedAt ||
        (requireFresh && value.expiresAt <= this.now()) ||
        !Array.isArray(value.cooldowns) ||
        !Array.isArray(value.windows)
      )
        return;
      if (value.cooldowns.length > keys.length || value.windows.length > ids.length) return;
      if (
        new Set(value.cooldowns.map((row) => row[0])).size !== value.cooldowns.length ||
        new Set(value.windows.map((row) => row[0])).size !== value.windows.length
      )
        return;
      if (
        !value.cooldowns.every(
          (row) => Array.isArray(row) && row.length === 2 && keys.includes(row[0]) && Number.isSafeInteger(row[1]),
        )
      )
        return;
      if (
        !value.windows.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 5 &&
            ids.includes(row[0]) &&
            (row[1] === null || integer(row[1])) &&
            (row[2] === null || integer(row[2])) &&
            Number.isSafeInteger(row[3]) &&
            integer(row[4]),
        )
      )
        return;
      const hourEnd = (Math.floor(value.observedAt / 3_600_000) + 1) * 3_600_000;
      if (value.expiresAt > hourEnd) return;
      for (const row of value.windows) {
        const end = row[3] + 5 * 3_600_000;
        if (end > value.observedAt && value.expiresAt > end) return;
      }
      return value;
    } catch {
      return;
    }
  }

  private async redisOperation<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.redisBusy) return undefined;
    this.redisBusy = true;
    // Timeout is not cancellation. Retain ownership until the actual command
    // settles; subsequent requests bypass rather than queue behind it.
    const pending = Promise.resolve()
      .then(operation)
      .catch(() => undefined)
      .finally(() => {
        this.redisBusy = false;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.budget);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
