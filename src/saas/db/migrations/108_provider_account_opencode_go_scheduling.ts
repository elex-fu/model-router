import type { SaasMigration } from './001_initial_schema.js';

/**
 * R5b OpenCode Go quota-window scheduling columns plus the multi-protocol
 * adaptive-routing rule table (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #25).
 *
 * Two independent column families land together because both are per-account
 * OpenCode Go provider state on the two account owner tables, both follow the
 * 099 codex-scheduling "scheduling-signal only" precedent, and both were
 * specified by already-landed modules whose headers define this migration as
 * their storage contract:
 *
 * 1. Usage-snapshot columns (src/saas/supply/opencode-go-usage-worker.ts, the
 *    R5b-3 worker): the usage worker periodically fetches the official
 *    OpenCode Zen/Go usage endpoint and overwrites the rolling-5h / weekly /
 *    monthly quota-window snapshot in place. The snapshot is a scheduling
 *    signal only: it never enters the billing path and never authorizes a
 *    profit/cost failover decision (093/099 quota-snapshot precedent). NULL
 *    means "never observed" and keeps scheduling exactly on its pre-R5b
 *    behavior, so every column is nullable and requires no backfill.
 *    - opencode_go_{rolling_5h,weekly,monthly}_{used_percent,reset_at} carry
 *      the three upstream usage windows; used_percent is upstream-observed,
 *      never extrapolated;
 *    - opencode_go_usage_updated_at is the attempt stamp the store's
 *      SKIP LOCKED claim writes as its lease (the R5b-3 leader-lock decision);
 *    - opencode_go_usage_next_due_at is the worker-computed due horizon;
 *    - opencode_go_usage_failure_count is the persisted failure streak that
 *      feeds the exponential backoff;
 *    - opencode_go_rate_limited_until is the scheduling cooldown derived from
 *      an exhausted window or a 429 Retry-After hint.
 *
 * 2. The opencode_go_protocol_rules jsonb column
 *    (src/saas/gateway/opencode-go/protocol-rules.ts, the R5b-2 rule table):
 *    one OpenCode Zen/Go subscription key serves three native upstream
 *    endpoints (Responses / Chat Completions / Anthropic Messages); the rule
 *    array decides, per normalized model id, which native protocol a request
 *    uses. Provider configuration as JSONB, not part of PricingIdentity. The
 *    database enforces the array shape and the 64-entry bound; element
 *    validation ({pattern: string, protocol: 'responses'|'openai'|'anthropic'},
 *    single trailing wildcard, no duplicates) stays in
 *    validateOpenCodeGoProtocolRules — PostgreSQL CHECK constraints cannot
 *    contain subqueries, so per-element shape is an application-layer
 *    contract. NULL keeps the built-in default routing table. Because a rule
 *    change is a scheduling-input change, the admin mutation path bumps the
 *    authorization fence with the 047/082 repository CAS pattern
 *    (`UPDATE ... SET opencode_go_protocol_rules = $1, authz_version =
 *    authz_version + 1 WHERE ... AND authz_version = $expected`).
 *
 * Numbered 108 (plan §R5b ledger assignment): the plan reserves 108 for
 * exactly this migration; the parallel R4 registration-admission migration
 * (106) landed after 108 was reserved and slots in ahead of it, and 107
 * stays available for the next workstream.
 */
const providerAccountOpencodeGoSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN opencode_go_rolling_5h_used_percent real,
  ADD COLUMN opencode_go_rolling_5h_reset_at timestamptz,
  ADD COLUMN opencode_go_weekly_used_percent real,
  ADD COLUMN opencode_go_weekly_reset_at timestamptz,
  ADD COLUMN opencode_go_monthly_used_percent real,
  ADD COLUMN opencode_go_monthly_reset_at timestamptz,
  ADD COLUMN opencode_go_usage_updated_at timestamptz,
  ADD COLUMN opencode_go_usage_next_due_at timestamptz,
  ADD COLUMN opencode_go_usage_failure_count integer,
  ADD COLUMN opencode_go_rate_limited_until timestamptz,
  ADD COLUMN opencode_go_protocol_rules jsonb,
  ADD CONSTRAINT saas_tenant_provider_accounts_opencode_go_percent_range
    CHECK (
      (opencode_go_rolling_5h_used_percent IS NULL OR opencode_go_rolling_5h_used_percent >= 0)
      AND (opencode_go_weekly_used_percent IS NULL OR opencode_go_weekly_used_percent >= 0)
      AND (opencode_go_monthly_used_percent IS NULL OR opencode_go_monthly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_opencode_go_failure_count_range
    CHECK (opencode_go_usage_failure_count IS NULL OR opencode_go_usage_failure_count >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_opencode_go_protocol_rules_shape
    CHECK (
      opencode_go_protocol_rules IS NULL
      OR (
        jsonb_typeof(opencode_go_protocol_rules) = 'array'
        AND jsonb_array_length(opencode_go_protocol_rules) <= 64
      )
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN opencode_go_rolling_5h_used_percent real,
  ADD COLUMN opencode_go_rolling_5h_reset_at timestamptz,
  ADD COLUMN opencode_go_weekly_used_percent real,
  ADD COLUMN opencode_go_weekly_reset_at timestamptz,
  ADD COLUMN opencode_go_monthly_used_percent real,
  ADD COLUMN opencode_go_monthly_reset_at timestamptz,
  ADD COLUMN opencode_go_usage_updated_at timestamptz,
  ADD COLUMN opencode_go_usage_next_due_at timestamptz,
  ADD COLUMN opencode_go_usage_failure_count integer,
  ADD COLUMN opencode_go_rate_limited_until timestamptz,
  ADD COLUMN opencode_go_protocol_rules jsonb,
  ADD CONSTRAINT saas_platform_provider_accounts_opencode_go_percent_range
    CHECK (
      (opencode_go_rolling_5h_used_percent IS NULL OR opencode_go_rolling_5h_used_percent >= 0)
      AND (opencode_go_weekly_used_percent IS NULL OR opencode_go_weekly_used_percent >= 0)
      AND (opencode_go_monthly_used_percent IS NULL OR opencode_go_monthly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_opencode_go_failure_count_range
    CHECK (opencode_go_usage_failure_count IS NULL OR opencode_go_usage_failure_count >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_opencode_go_protocol_rules_shape
    CHECK (
      opencode_go_protocol_rules IS NULL
      OR (
        jsonb_typeof(opencode_go_protocol_rules) = 'array'
        AND jsonb_array_length(opencode_go_protocol_rules) <= 64
      )
    );

CREATE INDEX saas_tenant_provider_accounts_opencode_go_usage_due_idx
  ON saas_tenant_provider_accounts (opencode_go_usage_next_due_at, id)
  WHERE status = 'active';

CREATE INDEX saas_platform_provider_accounts_opencode_go_usage_due_idx
  ON saas_platform_provider_accounts (opencode_go_usage_next_due_at, id)
  WHERE status = 'active';
`;

export const PROVIDER_ACCOUNT_OPENCODE_GO_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 108,
  name: 'provider_account_opencode_go_scheduling',
  sql: providerAccountOpencodeGoSchedulingSql,
};
