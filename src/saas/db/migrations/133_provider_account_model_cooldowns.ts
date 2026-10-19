import type { SaasMigration } from './001_initial_schema.js';

/**
 * Core-plan 9.1 (multi-instance state propagation, migration 133): the
 * durable (account, model) cooldown table behind the model-level rate-limit
 * registry.
 *
 * The dispatch side records a `model-unavailable` outcome (a model-not-found
 * 404 or a plan-gated 400) as a 30-minute cooldown of the (account, model)
 * pair while the account stays schedulable for every other model. Until now
 * that registry was a per-process Map (`ProviderAccountModelRateLimit`), so
 * with more than one gateway instance a cooldown recorded by one process was
 * invisible to the others — the exact gap the plan closes: "多实例下影响真实
 * 可用性的状态应有 PG 权威记录或有界共享缓存和明确的失效上界".
 *
 * Design:
 *
 * - The row key mirrors the in-process Map key exactly: `owner_scope_key`
 *   ('platform' for platform-owned accounts, the tenant id for tenant-owned
 *   accounts) + `account_id` + `model`. Upstream id is deliberately NOT part
 *   of the key — an account id is unique per provider in both account tables
 *   (the same scope the health store already uses).
 * - `cooled_until` (timestamptz) is the single semantic field: a pair is
 *   excluded exactly while `cooled_until > now()`. Reads therefore carry
 *   their own invalidation bound — no row versioning, no last-writer wins.
 * - The upsert takes `GREATEST(existing, excluded)` so a shorter cooldown can
 *   never shorten a longer one recorded by another instance (monotone within
 *   a row's lifetime, the same posture as the health-store cooldowns).
 * - Writes are best-effort durable: the recording instance keeps its local
 *   Map as an L1 (instant same-process reads, availability when PG is down);
 *   the table is the cross-instance authority. Read failures fail OPEN
 *   (not excluded) — a missing observation must never remove capacity (the
 *   P17 posture the scheduler seam already documents).
 * - Retention: expired rows are inert (every read filters `cooled_until >
 *   now()`) and the table is bounded by distinct (account, model) pairs, not
 *   by events — no runtime DELETE privilege is taken. A stale row is
 *   refreshed in place the next time the pair cools.
 *
 * Runtime privileges: table-level SELECT via the gateway read allowlist,
 * column INSERT/UPDATE grants for the upsert — added to the privileges
 * manifest alongside this migration (the generator (re)renders every mirror).
 *
 * Numbered 133: appends after the applied head 132.
 */
const providerAccountModelCooldownsSql = `
CREATE TABLE saas_provider_account_model_cooldowns (
  owner_scope_key text NOT NULL,
  account_id text NOT NULL,
  model text NOT NULL,
  cooled_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT saas_provider_account_model_cooldowns_pkey
    PRIMARY KEY (owner_scope_key, account_id, model),
  CONSTRAINT saas_provider_account_model_cooldowns_scope_shape CHECK (
    char_length(btrim(owner_scope_key)) > 0 AND char_length(owner_scope_key) <= 200
  ),
  CONSTRAINT saas_provider_account_model_cooldowns_account_shape CHECK (
    char_length(btrim(account_id)) > 0 AND char_length(account_id) <= 200
  ),
  CONSTRAINT saas_provider_account_model_cooldowns_model_shape CHECK (
    char_length(btrim(model)) > 0 AND char_length(model) <= 256
  )
);

CREATE INDEX saas_provider_account_model_cooldowns_cooled_until_idx
  ON saas_provider_account_model_cooldowns (cooled_until);
`;

export const PROVIDER_ACCOUNT_MODEL_COOLDOWNS_SAAS_MIGRATION: SaasMigration = {
  version: 133,
  name: 'provider_account_model_cooldowns',
  sql: providerAccountModelCooldownsSql,
};
