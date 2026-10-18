import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../db/index.js';
import type { RedisConcurrencySlots } from '../runtime/redis-concurrency-slots.js';
import { CLAUDE_PRODUCT_ID, CLAUDE_PROVIDER_ID } from './claude/catalog-identity.js';
import { validateClaudeCodeClient } from './claude/claude-code-validator.js';
import type { GatewayProtocol } from './contracts.js';
import { evaluateGrokFreeTierGateSnapshot } from './grok/free-tier-gate.js';
import { effectiveWeight, parseHealthScoreColumn } from './health-score.js';
import type {
  ProviderAccountHalfOpenProbeAdmissionPort,
  ProviderAccountHealthProbeLeaseProvider,
  ProviderAccountHealthSchedulingPort,
  ProviderAccountRuntimeHealthWriter,
} from './postgres-provider-account-runtime-health-store.js';
import {
  accountWindowStatsOrZero,
  getAccountWindowStatsBatch,
  groupAccountIdsByWindowStart,
} from './postgres-provider-account-window-stats.js';
import {
  MAX_HEALTH_OBSERVED_AT_SKEW_MS,
  ProviderAccountScheduler,
  type ProviderAccountSchedulerAffinityBindDecision,
  type ProviderAccountSchedulerAffinityBindingInput,
  type ProviderAccountSchedulerAffinityPort,
  type ProviderAccountSchedulerCompositeContext,
  type ProviderAccountSchedulerConcurrencyDecision,
  type ProviderAccountSchedulerEligibilityDecision,
  type ProviderAccountSchedulerFailureFeedbackPort,
  type ProviderAccountSchedulerHealthDecision,
  type ProviderAccountSchedulerHealthPort,
  type ProviderAccountSchedulerInput,
  type ProviderAccountSchedulerModelCooldownPort,
  type ProviderAccountSchedulerOptions,
  type ProviderAccountSchedulerPort,
  type ProviderAccountSchedulerRevalidatedRoute,
  type ProviderAccountSchedulerRights,
  type ProviderAccountSchedulerSelectionTrace,
  type ProviderAccountSchedulerWindowCostPort,
  resolveMaxHealthAgeMs,
} from './provider-account-scheduler.js';
import {
  buildSchedulingThresholdPauseReason,
  evaluateSchedulingThresholdPause,
  type SchedulingThresholdAccountRow,
  schedulingThresholdCandidatesFromRow,
  schedulingThresholdPauseMatches,
  schedulingThresholdWindowStartMs,
} from './provider-account-scheduling-threshold.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationDecision,
  RequestPreparationEntitlement,
} from './request-preparation-service.js';
import { blockRequestPreparation, rejectRequestPreparation } from './request-preparation-service.js';

type Row = Record<string, unknown>;

interface RouteRow extends Row {
  tenant_id: unknown;
  project_id: unknown;
  route_id: unknown;
  current_version: unknown;
  route_version: unknown;
  route_status: unknown;
  public_model_id: unknown;
  public_model_version: unknown;
  protocol: unknown;
  supply_mode: unknown;
  target_mode: unknown;
  upstream_id: unknown;
  endpoint: unknown;
  public_model_alias: unknown;
  public_model_status: unknown;
  public_model_version_status: unknown;
  provider_id: unknown;
  product_id: unknown;
  model: unknown;
}

interface EligibilityRow extends Row {
  product_status: unknown;
  profile_tenant_id: unknown;
  profile_id: unknown;
  profile_supply_mode: unknown;
  profile_status: unknown;
  profile_authz_version: unknown;
  profile_model_scopes: unknown;
  account_owner_kind: unknown;
  account_supply_mode: unknown;
  account_id: unknown;
  account_provider_id: unknown;
  account_product_id: unknown;
  account_credential_type: unknown;
  account_region: unknown;
  account_purpose: unknown;
  account_rights_id: unknown;
  account_rights_version: unknown;
  account_status: unknown;
  account_validation_state: unknown;
  account_authz_version: unknown;
  account_priority: unknown;
  account_weight: unknown;
  account_quota_state: unknown;
  account_rpm_limit: unknown;
  account_tpm_limit: unknown;
  account_health_score: unknown;
  account_egress_proxy_quality: unknown;
  /* R7 (migrations 099/100/108): quota-window scheduling signals. */
  account_codex_5h_reset_at?: unknown;
  account_codex_7d_reset_at?: unknown;
  account_codex_usage_updated_at?: unknown;
  account_claude_5h_reset_at?: unknown;
  account_claude_7d_reset_at?: unknown;
  account_claude_7d_sonnet_reset_at?: unknown;
  account_claude_7d_oi_reset_at?: unknown;
  account_claude_usage_updated_at?: unknown;
  account_opencode_go_rolling_5h_reset_at?: unknown;
  account_opencode_go_weekly_reset_at?: unknown;
  account_opencode_go_monthly_reset_at?: unknown;
  account_opencode_go_usage_updated_at?: unknown;
  /* Migration 119 (batch 3 grok): the free-tier soft gate + 429 cooldown inputs. */
  account_grok_subscription_tier?: unknown;
  account_grok_5h_used_percent?: unknown;
  account_grok_usage_updated_at?: unknown;
  account_grok_rate_limited_until?: unknown;
  /* F2 (migration 105): billing-group account-pool priority signal. */
  group_pool_priority?: unknown;
  credential_owner_kind: unknown;
  credential_supply_mode: unknown;
  credential_id: unknown;
  credential_account_id: unknown;
  credential_provider_id: unknown;
  credential_product_id: unknown;
  credential_type: unknown;
  credential_status: unknown;
  credential_validation_state: unknown;
  credential_current_version: unknown;
  credential_expires_at: unknown;
  credential_authz_version: unknown;
  version_owner_kind: unknown;
  version_supply_mode: unknown;
  version_credential_id: unknown;
  credential_version: unknown;
  version_status: unknown;
  version_expires_at: unknown;
  account_rights_provider_id: unknown;
  account_rights_product_id: unknown;
  account_rights_credential_type: unknown;
  account_rights_supply_mode: unknown;
  account_rights_region: unknown;
  account_rights_purpose: unknown;
  account_rights_model_scope: unknown;
  account_rights_endpoint_scope: unknown;
  account_rights_effective_at: unknown;
  account_rights_expires_at: unknown;
  account_rights_status: unknown;
  selected_account_rights_version?: unknown;
  capability_version: unknown;
  capability_protocol: unknown;
  capability_support_level: unknown;
  capability_validation_state: unknown;
  account_capability_version: unknown;
  mapping_tenant_id?: unknown;
  mapping_profile_id?: unknown;
  mapping_supply_mode?: unknown;
  mapping_account_id?: unknown;
  mapping_provider_id?: unknown;
  mapping_product_id?: unknown;
  mapping_account_authz_version?: unknown;
  mapping_status?: unknown;
  mapping_effective_at?: unknown;
  mapping_expires_at?: unknown;
  mapping_authz_version?: unknown;
  pool_id?: unknown;
  pool_provider_id?: unknown;
  pool_product_id?: unknown;
  pool_credential_type?: unknown;
  pool_region?: unknown;
  pool_purpose?: unknown;
  pool_rights_id?: unknown;
  pool_rights_version?: unknown;
  pool_status?: unknown;
  pool_validation_state?: unknown;
  pool_authz_version?: unknown;
  member_pool_id?: unknown;
  member_account_id?: unknown;
  member_provider_id?: unknown;
  member_product_id?: unknown;
  member_status?: unknown;
  member_account_authz_version?: unknown;
  member_authz_version?: unknown;
  grant_tenant_id?: unknown;
  grant_profile_id?: unknown;
  grant_supply_mode?: unknown;
  grant_status?: unknown;
  grant_effective_at?: unknown;
  grant_expires_at?: unknown;
  grant_authz_version?: unknown;
  grant_profile_authz_version?: unknown;
  grant_pool_authz_version?: unknown;
  pool_rights_provider_id?: unknown;
  pool_rights_product_id?: unknown;
  pool_rights_credential_type?: unknown;
  pool_rights_supply_mode?: unknown;
  pool_rights_region?: unknown;
  pool_rights_purpose?: unknown;
  pool_rights_model_scope?: unknown;
  pool_rights_endpoint_scope?: unknown;
  pool_rights_effective_at?: unknown;
  pool_rights_expires_at?: unknown;
  pool_rights_status?: unknown;
  selected_pool_rights_version?: unknown;
}

export interface PostgresProviderAccountSchedulerOptions extends ProviderAccountSchedulerOptions {
  readonly database: SaasDatabase;
  /** Must be the exact maxConcurrency configured on PostgresProviderAccountLeaseService. */
  readonly leaseConcurrencyLimit?: number;
  /** Runtime health source. There is no health/cooldown table in the current SaaS schema. */
  readonly health?: ProviderAccountSchedulerHealthPort;
  /** Optional so an uncomposed runtime fails closed when a request carries affinity. */
  readonly affinity?: ProviderAccountSchedulerAffinityPort;
  /**
   * F2 (task #35) Redis concurrency-slot pre-check (R6b hot state): OPTIONAL
   * and default OFF — absent or `enabled: false` keeps the concurrency port
   * byte-identical (the pure PostgreSQL lease-count read). When enabled with
   * a slot client, the per-candidate admission path pre-checks the account's
   * Redis slot before the PostgreSQL lease snapshot: 'saturated' skips the
   * candidate (shaping only), 'unavailable' fails OPEN to the PostgreSQL
   * path (the fenced PG lease remains the final admission), and 'acquired'
   * proceeds. Slots acquired for candidates that are checked but not
   * selected are released after the selection; the selected account's slot
   * rides the lazy-eviction window (dispatch-completion release is the
   * dispatch path's integration, outside this scheduler).
   */
  readonly redisConcurrencySlots?: {
    readonly enabled?: boolean;
    readonly slots: RedisConcurrencySlots;
    /** Slot capacity per account; defaults to the lease concurrency limit. */
    readonly maxSlots?: number;
    /** Lazy-eviction window in milliseconds; defaults to 60 seconds. */
    readonly windowMs?: number;
  };
  /**
   * H5a (R9 bench finding P5a): wire the R7/D6 half-open probe into the
   * scheduling path so runtime health self-heals. When provided, the wrapper
   * replaces the plain health port with a self-healing adapter: a candidate
   * whose scheduling view is merely STALE (a well-formed row older than the
   * freshness bound) — or, P18 (R9 re-run), has NO row at all (a never-
   * observed account on a freshly seeded deployment) — gets a single-winner
   * half-open probe admission; the winner acquires a short-lived account
   * lease and records a lease-authorized probe outcome (the exact probe
   * pattern of the reference E2E), refreshing (or cold-start priming) the
   * row, and is then schedulable. This is NOT a billing event and never
   * bypasses billing admission: the request still passes every eligibility,
   * concurrency, billing, and fenced-lease check. Losers (probe already in
   * flight) are denied for this candidate only. Absent keeps the plain port
   * (fail-closed on stale and unknown rows), byte-identical to before.
   */
  readonly healthProbe?: {
    readonly store: ProviderAccountHealthSchedulingPort &
      ProviderAccountHalfOpenProbeAdmissionPort &
      ProviderAccountRuntimeHealthWriter;
    readonly leaseProvider: ProviderAccountHealthProbeLeaseProvider;
  };
  /**
   * H5c (R9 bench finding P8): optional in-process failure feedback. Forwarded
   * to the core scheduler, which excludes a cooled account from selection
   * like a health deny. Absent keeps the selection byte-identical.
   */
  readonly failureFeedback?: ProviderAccountSchedulerFailureFeedbackPort;
  /**
   * Core-plan 9.1 (B06): the model-level cooldown read. The composition passes
   * the SAME ProviderAccountModelRateLimit instance the dispatch side records
   * into, so a cooled (account, model) pair is skipped during selection.
   * Absent keeps the selection byte-identical.
   */
  readonly modelCooldown?: ProviderAccountSchedulerModelCooldownPort;
  /**
   * G-B1 (window three-state): forwarded to the core scheduler verbatim —
   * the composition wires the PG facts reader
   * (getAccountWindowCostFactsBatch + evaluateWindowCostSchedulability).
   * Absent keeps the selection byte-identical.
   */
  readonly windowCost?: ProviderAccountSchedulerWindowCostPort;
}

interface PersistedRoute extends ProviderAccountSchedulerRevalidatedRoute {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
}

const ROUTE_SQL = `/* postgres-provider-account-scheduler:route */
SELECT h.tenant_id, h.project_id, h.route_id, h.current_version,
       rv.version AS route_version, rv.status AS route_status,
       rv.public_model_id, rv.public_model_version, rv.protocol,
       rv.supply_mode, rv.target_mode, rv.upstream_id, rv.endpoint,
       pm.alias AS public_model_alias, pm.status AS public_model_status,
       pmv.status AS public_model_version_status,
       pmv.provider_id, pmv.product_id, pmv.model
  FROM saas_route_config_heads h
  JOIN saas_route_config_versions rv
    ON rv.tenant_id = h.tenant_id AND rv.project_id = h.project_id
   AND rv.route_id = h.route_id AND rv.version = h.current_version
  JOIN saas_public_model_versions pmv
    ON pmv.public_model_id = rv.public_model_id
   AND pmv.version = rv.public_model_version
  JOIN saas_public_models pm ON pm.id = pmv.public_model_id
 WHERE h.tenant_id = $1 AND h.project_id = $2
   AND pm.alias = $3 AND rv.protocol = $4 AND rv.supply_mode = $5
   AND h.status = 'active' AND rv.status = 'active'
   AND pm.status = 'active' AND pmv.status = 'active'
 LIMIT 2`;

/* Values held by credentials are intentionally absent from both queries. */
const BYOK_ELIGIBILITY_SQL = `/* postgres-provider-account-scheduler:byok-eligibility */
SELECT product.status AS product_status,
       profile.tenant_id AS profile_tenant_id, profile.id AS profile_id,
       profile.supply_mode AS profile_supply_mode, profile.status AS profile_status,
       profile.authz_version AS profile_authz_version, profile.model_scopes AS profile_model_scopes,
       account.owner_kind AS account_owner_kind, account.supply_mode AS account_supply_mode,
       account.id AS account_id, account.provider_id AS account_provider_id,
       account.product_id AS account_product_id, account.credential_type AS account_credential_type,
       account.region AS account_region, account.purpose AS account_purpose,
       account.rights_id AS account_rights_id, account.rights_version AS account_rights_version,
       account.status AS account_status, account.validation_state AS account_validation_state,
       account.authz_version AS account_authz_version,
       account.priority AS account_priority, account.weight AS account_weight,
       account.quota_state AS account_quota_state,
       account.rpm_limit AS account_rpm_limit, account.tpm_limit AS account_tpm_limit,
       health.health_score AS account_health_score,
       egress_proxy.last_probe_quality AS account_egress_proxy_quality,
       account.codex_5h_reset_at AS account_codex_5h_reset_at,
       account.codex_7d_reset_at AS account_codex_7d_reset_at,
       account.codex_usage_updated_at AS account_codex_usage_updated_at,
       account.claude_5h_reset_at AS account_claude_5h_reset_at,
       account.claude_7d_reset_at AS account_claude_7d_reset_at,
       account.claude_7d_sonnet_reset_at AS account_claude_7d_sonnet_reset_at,
       account.claude_7d_oi_reset_at AS account_claude_7d_oi_reset_at,
       account.claude_usage_updated_at AS account_claude_usage_updated_at,
       account.opencode_go_rolling_5h_reset_at AS account_opencode_go_rolling_5h_reset_at,
       account.opencode_go_weekly_reset_at AS account_opencode_go_weekly_reset_at,
       account.opencode_go_monthly_reset_at AS account_opencode_go_monthly_reset_at,
       account.opencode_go_usage_updated_at AS account_opencode_go_usage_updated_at,
       /* Migration 119 (batch 3 grok): the trusted tier + observed 5h window,
        * consumed by the TS-side free-tier soft gate below; never a billing
        * input (the 093 quota-snapshot precedent). */
       account.grok_subscription_tier AS account_grok_subscription_tier,
       account.grok_5h_used_percent AS account_grok_5h_used_percent,
       account.grok_usage_updated_at AS account_grok_usage_updated_at,
       account.grok_rate_limited_until AS account_grok_rate_limited_until,
       credential.owner_kind AS credential_owner_kind, credential.supply_mode AS credential_supply_mode,
       credential.id AS credential_id, credential.account_id AS credential_account_id,
       credential.provider_id AS credential_provider_id, credential.product_id AS credential_product_id,
       credential.credential_type AS credential_type, credential.status AS credential_status,
       credential.validation_state AS credential_validation_state,
       credential.current_version AS credential_current_version,
       credential.expires_at AS credential_expires_at,
       credential.authz_version AS credential_authz_version,
       credential_version.owner_kind AS version_owner_kind,
       credential_version.supply_mode AS version_supply_mode,
       credential_version.credential_id AS version_credential_id,
       credential_version.version AS credential_version,
       credential_version.status AS version_status,
       credential_version.expires_at AS version_expires_at,
       mapping.tenant_id AS mapping_tenant_id, mapping.supply_profile_id AS mapping_profile_id,
       mapping.supply_mode AS mapping_supply_mode, mapping.account_id AS mapping_account_id,
       mapping.provider_id AS mapping_provider_id, mapping.product_id AS mapping_product_id,
       mapping.account_authz_version AS mapping_account_authz_version,
       mapping.status AS mapping_status, mapping.effective_at AS mapping_effective_at,
       mapping.expires_at AS mapping_expires_at, mapping.authz_version AS mapping_authz_version,
       rights.provider_id AS account_rights_provider_id,
       rights.product_id AS account_rights_product_id,
       rights.credential_type AS account_rights_credential_type,
       rights.supply_mode AS account_rights_supply_mode, rights.region AS account_rights_region,
       rights.purpose AS account_rights_purpose, rights.model_scope AS account_rights_model_scope,
       rights.endpoint_scope AS account_rights_endpoint_scope,
       rights.version AS selected_account_rights_version,
       rights.effective_at AS account_rights_effective_at,
       rights.expires_at AS account_rights_expires_at,
       rights.status AS account_rights_status,
       capability.version AS capability_version, capability.protocol AS capability_protocol,
       capability.support_level AS capability_support_level,
       capability.validation_state AS capability_validation_state,
       account_capability.capability_version AS account_capability_version
  FROM saas_provider_products product
  JOIN saas_supply_profiles profile
    ON profile.tenant_id = $1 AND profile.id = $2
  JOIN saas_tenant_provider_accounts account
    ON account.tenant_id = $1 AND account.id = $3
  JOIN saas_tenant_provider_supply_profile_accounts mapping
    ON mapping.tenant_id = $1 AND mapping.supply_profile_id = $2
   AND mapping.account_id = account.id
  JOIN saas_tenant_provider_credentials credential
    ON credential.tenant_id = account.tenant_id AND credential.account_id = account.id
   AND credential.provider_id = account.provider_id AND credential.product_id = account.product_id
   AND credential.id = $8
  JOIN saas_tenant_provider_credential_versions credential_version
    ON credential_version.tenant_id = credential.tenant_id
   AND credential_version.account_id = credential.account_id
   AND credential_version.credential_id = credential.id
   AND credential_version.version = credential.current_version
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = account.rights_id AND r.effective_at <= $14::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) rights ON TRUE
  JOIN LATERAL (
    SELECT c.* FROM saas_provider_capabilities c
     WHERE c.provider_id = $4 AND c.product_id = $5 AND c.model = $6 AND c.endpoint = $7
     ORDER BY c.version DESC LIMIT 1
  ) capability ON TRUE
  JOIN saas_tenant_provider_account_capabilities account_capability
    ON account_capability.tenant_id = account.tenant_id
   AND account_capability.account_id = account.id
   AND account_capability.provider_id = capability.provider_id
   AND account_capability.product_id = capability.product_id
   AND account_capability.model = capability.model
   AND account_capability.endpoint = capability.endpoint
   AND account_capability.capability_version = capability.version
  /* R7 (migration 098): PK (owner_scope_key, account_id) keeps this fan-out free. */
  LEFT JOIN saas_provider_account_runtime_health health
    ON health.owner_scope_key = $1::text AND health.account_id = account.id
   AND health.owner_kind = 'tenant'
  /* R3 (migration 107): the account's egress proxy probe quality demotes the
   * scheduling weight only — never eligibility. PK lookups stay free. */
  LEFT JOIN saas_egress_proxies egress_proxy
    ON egress_proxy.id = account.egress_proxy_id
 WHERE product.provider_id = $4 AND product.product_id = $5 AND product.status = 'active'
   AND profile.supply_mode = 'byok' AND profile.status = 'active'
   AND profile.authz_version = $12 AND profile.model_scopes @> ARRAY[$15]::text[]
   AND account.owner_kind = 'tenant' AND account.supply_mode = 'byok'
   AND account.provider_id = $4 AND account.product_id = $5
   AND account.status = 'active' AND account.validation_state = 'verified'
   AND account.authz_version = $10
   /* R6a (migration 109): the probe worker's temporary-unschedulable signal
    * excludes the account while it is in the future; NULL (never probed or
    * recovered) and past deadlines keep the account eligible — exactly the
    * pre-R6a behavior. $14 is the same revalidation clock as every other
    * window predicate in this query. */
   AND (account.probe_temp_unschedulable_until IS NULL
        OR account.probe_temp_unschedulable_until <= $14::timestamptz)
   /* R-dormant (migration 115): the scheduling-threshold lazy pause — same
    * NULL-or-elapsed shape as the 109 probe signal; NULL (never paused)
    * keeps the pre-115 behavior exactly. */
   AND (account.scheduling_threshold_pause_until IS NULL
        OR account.scheduling_threshold_pause_until <= $14::timestamptz)
   AND mapping.supply_mode = 'byok' AND mapping.provider_id = $4 AND mapping.product_id = $5
   AND mapping.account_authz_version = account.authz_version
   AND mapping.authz_version = $13 AND mapping.status = 'active'
   AND mapping.effective_at <= $14::timestamptz
   AND (mapping.expires_at IS NULL OR mapping.expires_at > $14::timestamptz)
   AND credential.owner_kind = 'tenant' AND credential.supply_mode = 'byok'
   AND credential.credential_type = account.credential_type
   AND credential.status = 'active' AND credential.validation_state = 'verified'
   AND credential.current_version = $9 AND credential.authz_version = $11
   AND (credential.expires_at IS NULL OR credential.expires_at > $14::timestamptz)
   AND credential_version.owner_kind = 'tenant' AND credential_version.supply_mode = 'byok'
   AND credential_version.status = 'active' AND credential_version.version = $9
   AND (credential_version.expires_at IS NULL OR credential_version.expires_at > $14::timestamptz)
   AND rights.version = account.rights_version
   AND rights.provider_id = account.provider_id AND rights.product_id = account.product_id
   AND rights.credential_type = account.credential_type AND rights.supply_mode = 'byok'
   AND rights.region = account.region AND rights.purpose = account.purpose
   AND rights.status = 'active' AND rights.model_scope @> ARRAY[$6]::text[]
   AND rights.endpoint_scope @> ARRAY[$7]::text[]
   AND (rights.expires_at IS NULL OR rights.expires_at > $14::timestamptz)
   AND capability.protocol = $16 AND capability.support_level = 'supported'
   AND capability.validation_state = 'verified'
 LIMIT 2`;

const PLATFORM_ELIGIBILITY_SQL = `/* postgres-provider-account-scheduler:platform-eligibility */
SELECT product.status AS product_status,
       profile.tenant_id AS profile_tenant_id, profile.id AS profile_id,
       profile.supply_mode AS profile_supply_mode, profile.status AS profile_status,
       profile.authz_version AS profile_authz_version, profile.model_scopes AS profile_model_scopes,
       account.owner_kind AS account_owner_kind, account.supply_mode AS account_supply_mode,
       account.id AS account_id, account.provider_id AS account_provider_id,
       account.product_id AS account_product_id, account.credential_type AS account_credential_type,
       account.region AS account_region, account.purpose AS account_purpose,
       account.rights_id AS account_rights_id, account.rights_version AS account_rights_version,
       account.status AS account_status, account.validation_state AS account_validation_state,
       account.authz_version AS account_authz_version,
       account.priority AS account_priority, account.weight AS account_weight,
       account.quota_state AS account_quota_state,
       account.rpm_limit AS account_rpm_limit, account.tpm_limit AS account_tpm_limit,
       health.health_score AS account_health_score,
       egress_proxy.last_probe_quality AS account_egress_proxy_quality,
       account.codex_5h_reset_at AS account_codex_5h_reset_at,
       account.codex_7d_reset_at AS account_codex_7d_reset_at,
       account.codex_usage_updated_at AS account_codex_usage_updated_at,
       account.claude_5h_reset_at AS account_claude_5h_reset_at,
       account.claude_7d_reset_at AS account_claude_7d_reset_at,
       account.claude_7d_sonnet_reset_at AS account_claude_7d_sonnet_reset_at,
       account.claude_7d_oi_reset_at AS account_claude_7d_oi_reset_at,
       account.claude_usage_updated_at AS account_claude_usage_updated_at,
       account.opencode_go_rolling_5h_reset_at AS account_opencode_go_rolling_5h_reset_at,
       account.opencode_go_weekly_reset_at AS account_opencode_go_weekly_reset_at,
       account.opencode_go_monthly_reset_at AS account_opencode_go_monthly_reset_at,
       account.opencode_go_usage_updated_at AS account_opencode_go_usage_updated_at,
       /* Migration 119 (batch 3 grok): see the BYOK projection above. */
       account.grok_subscription_tier AS account_grok_subscription_tier,
       account.grok_5h_used_percent AS account_grok_5h_used_percent,
       account.grok_usage_updated_at AS account_grok_usage_updated_at,
       account.grok_rate_limited_until AS account_grok_rate_limited_until,
       group_pool.priority AS group_pool_priority,
       credential.owner_kind AS credential_owner_kind, credential.supply_mode AS credential_supply_mode,
       credential.id AS credential_id, credential.account_id AS credential_account_id,
       credential.provider_id AS credential_provider_id, credential.product_id AS credential_product_id,
       credential.credential_type AS credential_type, credential.status AS credential_status,
       credential.validation_state AS credential_validation_state,
       credential.current_version AS credential_current_version,
       credential.expires_at AS credential_expires_at,
       credential.authz_version AS credential_authz_version,
       credential_version.owner_kind AS version_owner_kind,
       credential_version.supply_mode AS version_supply_mode,
       credential_version.credential_id AS version_credential_id,
       credential_version.version AS credential_version,
       credential_version.status AS version_status,
       credential_version.expires_at AS version_expires_at,
       account_rights.provider_id AS account_rights_provider_id,
       account_rights.product_id AS account_rights_product_id,
       account_rights.credential_type AS account_rights_credential_type,
       account_rights.supply_mode AS account_rights_supply_mode,
       account_rights.region AS account_rights_region,
       account_rights.purpose AS account_rights_purpose,
       account_rights.model_scope AS account_rights_model_scope,
       account_rights.endpoint_scope AS account_rights_endpoint_scope,
       account_rights.version AS selected_account_rights_version,
       account_rights.effective_at AS account_rights_effective_at,
       account_rights.expires_at AS account_rights_expires_at,
       account_rights.status AS account_rights_status,
       capability.version AS capability_version, capability.protocol AS capability_protocol,
       capability.support_level AS capability_support_level,
       capability.validation_state AS capability_validation_state,
       account_capability.capability_version AS account_capability_version,
       pool.id AS pool_id, pool.provider_id AS pool_provider_id,
       pool.product_id AS pool_product_id, pool.credential_type AS pool_credential_type,
       pool.region AS pool_region, pool.purpose AS pool_purpose,
       pool.rights_id AS pool_rights_id, pool.rights_version AS pool_rights_version,
       pool.status AS pool_status, pool.validation_state AS pool_validation_state,
       pool.authz_version AS pool_authz_version,
       member.pool_id AS member_pool_id, member.account_id AS member_account_id,
       member.provider_id AS member_provider_id, member.product_id AS member_product_id,
       member.status AS member_status,
       member.account_authz_version AS member_account_authz_version,
       member.authz_version AS member_authz_version,
       grant_row.tenant_id AS grant_tenant_id,
       grant_row.supply_profile_id AS grant_profile_id,
       grant_row.supply_mode AS grant_supply_mode, grant_row.status AS grant_status,
       grant_row.effective_at AS grant_effective_at, grant_row.expires_at AS grant_expires_at,
       grant_row.authz_version AS grant_authz_version,
       grant_row.profile_authz_version AS grant_profile_authz_version,
       grant_row.pool_authz_version AS grant_pool_authz_version,
       pool_rights.provider_id AS pool_rights_provider_id,
       pool_rights.product_id AS pool_rights_product_id,
       pool_rights.credential_type AS pool_rights_credential_type,
       pool_rights.supply_mode AS pool_rights_supply_mode,
       pool_rights.region AS pool_rights_region,
       pool_rights.purpose AS pool_rights_purpose,
       pool_rights.model_scope AS pool_rights_model_scope,
       pool_rights.endpoint_scope AS pool_rights_endpoint_scope,
       pool_rights.version AS selected_pool_rights_version,
       pool_rights.effective_at AS pool_rights_effective_at,
       pool_rights.expires_at AS pool_rights_expires_at,
       pool_rights.status AS pool_rights_status
  FROM saas_provider_products product
  JOIN saas_supply_profiles profile
    ON profile.tenant_id = $1 AND profile.id = $2
  JOIN saas_platform_provider_accounts account ON account.id = $4
  JOIN saas_platform_provider_pools pool ON pool.id = $3
  JOIN saas_platform_provider_pool_members member
    ON member.pool_id = pool.id AND member.account_id = account.id
  JOIN saas_platform_provider_pool_grants grant_row
    ON grant_row.pool_id = pool.id AND grant_row.tenant_id = $1
   AND grant_row.supply_profile_id = $2
  JOIN saas_platform_provider_credentials credential
    ON credential.account_id = account.id AND credential.id = $9
   AND credential.provider_id = account.provider_id AND credential.product_id = account.product_id
  JOIN saas_platform_provider_credential_versions credential_version
    ON credential_version.account_id = credential.account_id
   AND credential_version.credential_id = credential.id
   AND credential_version.version = credential.current_version
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = account.rights_id AND r.effective_at <= $20::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) account_rights ON TRUE
  JOIN LATERAL (
    SELECT r.* FROM saas_provider_rights r
     WHERE r.rights_id = pool.rights_id AND r.effective_at <= $20::timestamptz
     ORDER BY r.effective_at DESC, r.version DESC LIMIT 1
  ) pool_rights ON TRUE
  JOIN LATERAL (
    SELECT c.* FROM saas_provider_capabilities c
     WHERE c.provider_id = $5 AND c.product_id = $6 AND c.model = $7 AND c.endpoint = $8
     ORDER BY c.version DESC LIMIT 1
  ) capability ON TRUE
  JOIN saas_platform_provider_account_capabilities account_capability
    ON account_capability.account_id = account.id
   AND account_capability.provider_id = capability.provider_id
   AND account_capability.product_id = capability.product_id
   AND account_capability.model = capability.model
   AND account_capability.endpoint = capability.endpoint
   AND account_capability.capability_version = capability.version
  /* R7 (migration 098): PK (owner_scope_key, account_id) keeps this fan-out free. */
  LEFT JOIN saas_provider_account_runtime_health health
    ON health.owner_scope_key = 'platform' AND health.account_id = account.id
   AND health.owner_kind = 'platform'
  /* R3 (migration 107): see the BYOK query above. */
  LEFT JOIN saas_egress_proxies egress_proxy
    ON egress_proxy.id = account.egress_proxy_id
  /* F2 (migration 105): billing-group account pools narrow the platform
   * candidate domain. $23 is the server-resolved group id (key binding, then
   * the tenant default). A group with NO pool rows is UNRESTRICTED — the
   * seeded 'default' group ships without rows and the NOT EXISTS guard keeps
   * every account eligible, byte-identical to pre-F2 — while any explicit
   * pool row set requires membership. The per-group priority is surfaced as
   * a scheduling-only signal; pool writes bump saas_api_keys.authz_version
   * (the groups service), and this live read is what an in-flight selection
   * actually enforces. */
  LEFT JOIN saas_billing_group_account_pools group_pool
    ON group_pool.group_id = $23 AND group_pool.account_id = account.id
 WHERE product.provider_id = $5 AND product.product_id = $6 AND product.status = 'active'
   AND profile.supply_mode = 'platform' AND profile.status = 'active'
   AND profile.authz_version = $13 AND profile.model_scopes @> ARRAY[$21]::text[]
   AND account.owner_kind = 'platform' AND account.supply_mode = 'platform'
   AND account.provider_id = $5 AND account.product_id = $6
   AND account.status = 'active' AND account.validation_state = 'verified'
   AND account.authz_version = $12
   /* R6a (migration 109): see the BYOK query above; $20 is the shared
    * revalidation clock. */
   AND (account.probe_temp_unschedulable_until IS NULL
        OR account.probe_temp_unschedulable_until <= $20::timestamptz)
   /* R-dormant (migration 115): the scheduling-threshold lazy pause — same
    * NULL-or-elapsed shape as the 109 probe signal; NULL (never paused)
    * keeps the pre-115 behavior exactly. */
   AND (account.scheduling_threshold_pause_until IS NULL
        OR account.scheduling_threshold_pause_until <= $20::timestamptz)
   AND (NOT EXISTS (SELECT 1 FROM saas_billing_group_account_pools guard_pool
                    WHERE guard_pool.group_id = $23)
        OR group_pool.account_id IS NOT NULL)
   AND pool.owner_kind = 'platform' AND pool.supply_mode = 'platform'
   AND pool.provider_id = $5 AND pool.product_id = $6
   AND pool.credential_type = account.credential_type
   AND pool.region = account.region AND pool.purpose = account.purpose
   AND pool.status = 'active' AND pool.validation_state = 'verified'
   AND pool.authz_version = $14
   AND member.provider_id = account.provider_id AND member.product_id = account.product_id
   AND member.status = 'active' AND member.account_authz_version = account.authz_version
   AND member.account_authz_version = $15
   AND member.authz_version = $16
   AND grant_row.supply_mode = 'platform' AND grant_row.status = 'active'
   AND grant_row.authz_version = $17 AND grant_row.profile_authz_version = $18
   AND grant_row.pool_authz_version = $19
   AND grant_row.effective_at <= $20::timestamptz
   AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $20::timestamptz)
   AND credential.owner_kind = 'platform' AND credential.supply_mode = 'platform'
   AND credential.credential_type = account.credential_type
   AND credential.status = 'active' AND credential.validation_state = 'verified'
   AND credential.current_version = $10 AND credential.authz_version = $11
   AND (credential.expires_at IS NULL OR credential.expires_at > $20::timestamptz)
   AND credential_version.owner_kind = 'platform' AND credential_version.supply_mode = 'platform'
   AND credential_version.status = 'active' AND credential_version.version = $10
   AND (credential_version.expires_at IS NULL OR credential_version.expires_at > $20::timestamptz)
   AND account_rights.version = account.rights_version
   AND account_rights.provider_id = account.provider_id
   AND account_rights.product_id = account.product_id
   AND account_rights.credential_type = account.credential_type
   AND account_rights.supply_mode = 'platform'
   AND account_rights.region = account.region AND account_rights.purpose = account.purpose
   AND account_rights.status = 'active'
   AND account_rights.model_scope @> ARRAY[$7]::text[]
   AND account_rights.endpoint_scope @> ARRAY[$8]::text[]
   AND (account_rights.expires_at IS NULL OR account_rights.expires_at > $20::timestamptz)
   AND pool_rights.version = pool.rights_version
   AND pool_rights.provider_id = pool.provider_id AND pool_rights.product_id = pool.product_id
   AND pool_rights.credential_type = pool.credential_type
   AND pool_rights.supply_mode = 'platform'
   AND pool_rights.region = pool.region AND pool_rights.purpose = pool.purpose
   AND pool_rights.status = 'active'
   AND pool_rights.model_scope @> ARRAY[$7]::text[]
   AND pool_rights.endpoint_scope @> ARRAY[$8]::text[]
   AND (pool_rights.expires_at IS NULL OR pool_rights.expires_at > $20::timestamptz)
   AND capability.protocol = $22 AND capability.support_level = 'supported'
   AND capability.validation_state = 'verified'
 LIMIT 2`;

const CONCURRENCY_SQL = `/* postgres-provider-account-scheduler:concurrency */
SELECT count(*)::text AS in_flight
  FROM saas_provider_account_leases
 WHERE owner_kind = $1
   AND owner_tenant_id IS NOT DISTINCT FROM $2
   AND account_id = $3
   AND status = 'held'
   AND lease_expires_at > clock_timestamp()`;

/*
 * R6 (migration 098): the trailing 60-second per-account consumption window.
 * The (account_scope, account_id, window_start DESC) index keeps this a
 * bounded single-index range scan over at most one row per admission second;
 * no heavy aggregation ever enters the eligibility path.
 */
const RATE_WINDOW_SQL = `/* postgres-provider-account-scheduler:rate-window */
SELECT coalesce(sum(requests), 0)::text AS requests,
       coalesce(sum(tokens), 0)::text AS tokens
  FROM saas_provider_account_rate_counters
 WHERE account_scope = $1
   AND account_id = $2
   AND window_start > $3::timestamptz - interval '60 seconds'`;

/*
 * R7 cost-priority signal: the candidate's supplier cost version carries the
 * exact rational per-token rates. The blended input+output rate is combined
 * with pure bigint arithmetic so the scheduler's cross-multiplication compare
 * stays exact. Only read when the cost-priority strategy is enabled; the
 * default (strategy-free) path never issues this statement. A missing row
 * (no such cost version) is a null signal, not an error; a malformed rate
 * blocks the whole selection, mirroring the health-score fail-closed rule.
 */
const SUPPLIER_COST_RATE_SQL = `/* postgres-provider-account-scheduler:supplier-cost-rate */
SELECT input_rate_numerator_minor_units, input_rate_denominator_units,
       output_rate_numerator_minor_units, output_rate_denominator_units
  FROM saas_supplier_cost_versions
 WHERE id = $1
 LIMIT 1`;

/*
 * R-dormant activation (batch 2.2, migration 115): the scheduling-threshold
 * lazy evaluation reads every quota-snapshot window family (099/100/108/111)
 * plus the dormant auto_pause_*_threshold overrides (099) and the current
 * pause state in ONE batched id lookup per owner scope — the sub2api
 * account_scheduling_threshold_eval candidate read. Accounts with no
 * threshold configured produce zero candidates and the selection proceeds
 * byte-identically to the pre-activation path.
 */
function schedulingThresholdCandidatesSql(
  accountsTable: 'saas_tenant_provider_accounts' | 'saas_platform_provider_accounts',
): string {
  return `/* postgres-provider-account-scheduler:threshold-candidates */
SELECT account.id AS account_id,
       account.codex_5h_used_percent, account.codex_5h_reset_at,
       account.codex_7d_used_percent, account.codex_7d_reset_at,
       account.codex_usage_updated_at,
       account.claude_5h_utilization, account.claude_5h_reset_at,
       account.claude_7d_utilization, account.claude_7d_reset_at,
       account.claude_7d_sonnet_utilization, account.claude_7d_sonnet_reset_at,
       account.claude_7d_oi_utilization, account.claude_7d_oi_reset_at,
       account.claude_usage_updated_at, account.claude_session_window_start,
       account.gemini_shared_daily_used, account.gemini_shared_daily_limit,
       account.gemini_pro_daily_used, account.gemini_pro_daily_limit,
       account.gemini_flash_daily_used, account.gemini_flash_daily_limit,
       account.gemini_daily_reset_at, account.gemini_usage_updated_at,
       account.opencode_go_rolling_5h_used_percent, account.opencode_go_rolling_5h_reset_at,
       account.opencode_go_weekly_used_percent, account.opencode_go_weekly_reset_at,
       account.opencode_go_monthly_used_percent, account.opencode_go_monthly_reset_at,
       account.opencode_go_usage_updated_at,
       account.zhipu_5h_used_percent, account.zhipu_5h_reset_at,
       account.zhipu_weekly_used_percent, account.zhipu_weekly_reset_at,
       account.zhipu_usage_updated_at,
       account.minimax_5h_used_percent, account.minimax_5h_reset_at,
       account.minimax_weekly_used_percent, account.minimax_weekly_reset_at,
       account.minimax_usage_updated_at,
       account.grok_5h_used_percent, account.grok_5h_reset_at,
       account.grok_usage_updated_at,
       account.auto_pause_5h_threshold, account.auto_pause_7d_threshold,
       account.scheduling_threshold_pause_until, account.scheduling_threshold_pause_reason
  FROM ${accountsTable} account
 WHERE account.id = ANY($1::text[])`;
}

/*
 * The pause write (sub2api SetTempUnschedulable port): the guard
 * `scheduling_threshold_pause_until IS NULL OR < until` means a live pause is
 * only ever EXTENDED, never shortened — a rows-affected zero is a no-op, not
 * an error. Idempotent re-evaluations (same deadline at second granularity,
 * same reason with triggered_at zeroed) are skipped in TypeScript before the
 * statement ever runs.
 */
function schedulingThresholdPauseWriteSql(
  accountsTable: 'saas_tenant_provider_accounts' | 'saas_platform_provider_accounts',
  ownerKind: 'tenant' | 'platform',
): {
  sql: string;
  values: (untilIso: string, reasonJson: string, accountId: string, tenantId: string | null) => unknown[];
} {
  const predicate = ownerKind === 'tenant' ? 'tenant_id = $1 AND id = $2' : 'id = $1';
  const untilParam = ownerKind === 'tenant' ? 3 : 2;
  const reasonParam = untilParam + 1;
  return {
    sql: `/* postgres-provider-account-scheduler:threshold-pause-write */
UPDATE ${accountsTable}
   SET scheduling_threshold_pause_until = $${untilParam}::timestamptz,
       scheduling_threshold_pause_reason = $${reasonParam}::jsonb
 WHERE ${predicate}
   AND (scheduling_threshold_pause_until IS NULL
        OR scheduling_threshold_pause_until < $${untilParam}::timestamptz)`,
    values: (untilIso, reasonJson, accountId, tenantId) =>
      ownerKind === 'tenant' ? [tenantId, accountId, untilIso, reasonJson] : [accountId, untilIso, reasonJson],
  };
}

interface SchedulingThresholdCandidateRow extends SchedulingThresholdAccountRow {
  readonly scheduling_threshold_pause_until: Date | string | null;
  readonly scheduling_threshold_pause_reason: unknown;
}

/*
 * F2 (task #35): resolve the request's billing group — the key's binding
 * (migration 105), then the tenant default, then the seeded 'default' —
 * together with the claude_code_only enforcement flags. Read once per
 * platform selection by the wrapper and forwarded as the eligibility
 * narrowing group. A missing or ambiguous row is authority drift and blocks
 * the whole selection (fail closed): an unresolvable group must never fall
 * back to "unrestricted", which would bypass pool narrowing.
 */
const BILLING_GROUP_SQL = `/* postgres-provider-account-scheduler:billing-group */
SELECT g.id, g.claude_code_only, g.fallback_group_id, g.supported_model_scopes
  FROM saas_api_keys k
  JOIN saas_tenants t ON t.id = k.tenant_id
  JOIN saas_billing_groups g ON g.id = COALESCE(k.billing_group_id, t.default_billing_group_id, 'default')
 WHERE k.tenant_id = $1 AND k.project_id = $2 AND k.id = $3
 LIMIT 2`;

/* F2: the fallback group's own flags, read only on the enforcement failure path. */
const BILLING_GROUP_BY_ID_SQL = `/* postgres-provider-account-scheduler:billing-group-by-id */
SELECT id, claude_code_only, fallback_group_id, supported_model_scopes
  FROM saas_billing_groups
 WHERE id = $1
 LIMIT 2`;

/**
 * F2/R1: the resolved billing-group facts the wrapper enforces.
 * supportedModelScopes (roadmap 1.3, phase 4) is null when the group is
 * unrestricted; entries are exact public model ids (the key model-scopes
 * semantics — no globs).
 */
interface ResolvedBillingGroup {
  readonly id: string;
  readonly claudeCodeOnly: boolean;
  readonly fallbackGroupId: string | null;
  readonly supportedModelScopes: readonly string[] | null;
}

function parseBillingGroupRow(row: unknown): ResolvedBillingGroup | null {
  if (!isRecord(row)) return null;
  const id = row.id;
  const claudeCodeOnly = row.claude_code_only;
  const fallbackGroupId = row.fallback_group_id;
  const supportedModelScopes = row.supported_model_scopes;
  if (!nonEmpty(id)) return null;
  if (typeof claudeCodeOnly !== 'boolean') return null;
  if (fallbackGroupId !== null && fallbackGroupId !== undefined && !nonEmpty(fallbackGroupId)) return null;
  let scopes: readonly string[] | null = null;
  if (supportedModelScopes !== null && supportedModelScopes !== undefined) {
    if (
      !Array.isArray(supportedModelScopes) ||
      supportedModelScopes.length === 0 ||
      supportedModelScopes.some((scope) => !nonEmpty(scope))
    ) {
      return null;
    }
    scopes = supportedModelScopes;
  }
  return {
    id,
    claudeCodeOnly,
    fallbackGroupId: fallbackGroupId === null || fallbackGroupId === undefined ? null : (fallbackGroupId as string),
    supportedModelScopes: scopes,
  };
}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim() && !value.includes('\u0000');
}

function exactText(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual === expected;
}

function versionText(value: unknown): string | null {
  try {
    if (typeof value === 'bigint' && value > 0n) return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return BigInt(value).toString();
  } catch {
    return null;
  }
  return null;
}

function sameVersion(actual: unknown, expected: unknown): boolean {
  const left = versionText(actual);
  const right = versionText(expected);
  return left !== null && right !== null && left === right;
}

/* Contract C-7 bounds, mirrored by the 082 CHECK constraints on both account tables. */
const SCHEDULING_PRIORITY_MAX = 1000;
const SCHEDULING_WEIGHT_MAX = 10_000;

function schedulingScalar(value: unknown, min: number, max: number): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function schedulingPriority(value: unknown): number | null {
  return schedulingScalar(value, 0, SCHEDULING_PRIORITY_MAX);
}

function schedulingWeight(value: unknown): number | null {
  return schedulingScalar(value, 1, SCHEDULING_WEIGHT_MAX);
}

/*
 * Track D4 (migration 093): the persisted quota snapshot is a scheduling
 * signal only. NULL (never checked), 'unknown' (last check untrustworthy),
 * and 'ok' leave the candidate untouched — exactly the pre-D4 behavior.
 * 'low' demotes the candidate to the minimum contract weight, and
 * 'exhausted' denies this candidate alone. Any other persisted shape blocks
 * the whole selection, mirroring the fail-closed scheduling-scalar rule;
 * the signal never enters the billing path.
 */
type SchedulingQuotaSignal = 'none' | 'low' | 'exhausted' | 'malformed';

function schedulingQuotaSignal(value: unknown): SchedulingQuotaSignal {
  if (value === null || value === undefined || value === 'unknown' || value === 'ok') return 'none';
  if (value === 'low' || value === 'exhausted') return value;
  return 'malformed';
}

/*
 * R6 (migration 098): persisted per-account rate ceilings. NULL keeps the
 * pre-R6 "no account-level cap" behavior and skips the window read entirely;
 * a positive safe integer is a hard ceiling; anything else blocks the whole
 * selection, mirroring the D1 scheduling-scalar fail-closed rule. The 098
 * CHECK constraints already enforce positivity, so a non-positive or
 * non-integer persisted value is authority drift and must never be guessed.
 */
const SCHEDULING_RATE_LIMIT_MAX = 1_000_000_000;

function schedulingRateLimit(value: unknown): number | null | 'malformed' {
  if (value === null || value === undefined) return null;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= SCHEDULING_RATE_LIMIT_MAX
    ? parsed
    : 'malformed';
}

const RATE_WINDOW_SUM_MAX = 1_000_000_000_000_000n;

function rateWindowSum(value: unknown): bigint | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^[0-9]+$/.test(value)
            ? BigInt(value)
            : null;
    return parsed !== null && parsed >= 0n && parsed <= RATE_WINDOW_SUM_MAX ? parsed : null;
  } catch {
    return null;
  }
}

function timestamp(value: unknown): Date | null {
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** Epoch ms of a persisted timestamp column; null/unknown/malformed → null (fail-open). */
function timestampMs(value: unknown): number | null {
  const parsed = timestamp(value);
  return parsed === null ? null : parsed.getTime();
}

/** Exact non-negative integer as persisted by PostgreSQL (bigint/text/safe number). */
function exactNonNegativeBigInt(value: unknown): bigint | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
            ? BigInt(value)
            : null;
    return parsed !== null && parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * R7 soonest-reset signal: the earliest upcoming quota-window reset across
 * the observed codex (099), claude (100), and opencode-go (108) snapshot
 * families. A window only counts when its family carries a refresh stamp
 * (usage_updated_at) — a reset without one is not a trustworthy snapshot —
 * and when the reset is still in the future. The staleness horizon itself
 * is enforced by the core scheduler (snapshotMaxAgeMs), keeping every R7
 * threshold in one testable place. NULL columns (never observed) produce no
 * signal at all, exactly the pre-R7 behavior.
 */
function soonestQuotaReset(row: EligibilityRow, now: Date): { resetAt: Date; observedAt: Date } | null {
  const families: ReadonlyArray<{ resets: readonly unknown[]; updated: unknown }> = [
    {
      resets: [row.account_codex_5h_reset_at, row.account_codex_7d_reset_at],
      updated: row.account_codex_usage_updated_at,
    },
    {
      resets: [
        row.account_claude_5h_reset_at,
        row.account_claude_7d_reset_at,
        row.account_claude_7d_sonnet_reset_at,
        row.account_claude_7d_oi_reset_at,
      ],
      updated: row.account_claude_usage_updated_at,
    },
    {
      resets: [
        row.account_opencode_go_rolling_5h_reset_at,
        row.account_opencode_go_weekly_reset_at,
        row.account_opencode_go_monthly_reset_at,
      ],
      updated: row.account_opencode_go_usage_updated_at,
    },
  ];
  let best: { resetAt: Date; observedAt: Date } | null = null;
  for (const family of families) {
    const observedAt = timestamp(family.updated);
    if (observedAt === null) continue;
    for (const raw of family.resets) {
      const resetAt = timestamp(raw);
      if (resetAt === null || resetAt.getTime() <= now.getTime()) continue;
      if (best === null || resetAt.getTime() < best.resetAt.getTime()) {
        best = { resetAt, observedAt };
      }
    }
  }
  return best;
}

function currentWindow(effectiveAt: unknown, expiresAt: unknown, now: Date): boolean {
  const effective = timestamp(effectiveAt);
  if (!effective || effective.getTime() > now.getTime()) return false;
  if (expiresAt === null) return true;
  const expires = timestamp(expiresAt);
  return expires !== null && expires.getTime() > now.getTime();
}

function unexpired(expiresAt: unknown, now: Date): boolean {
  if (expiresAt === null) return true;
  const expires = timestamp(expiresAt);
  return expires !== null && expires.getTime() > now.getTime();
}

function containsScope(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') && value.includes(expected);
}

function entitlementMatchesInput(input: ProviderAccountSchedulerInput): boolean {
  const { caller, entitlement } = input;
  return (
    entitlement.tenantId === caller.tenantId &&
    entitlement.projectId === caller.projectId &&
    entitlement.proxyKeyId === caller.proxyKeyId &&
    entitlement.entitlementId === caller.entitlementId &&
    sameVersion(entitlement.entitlementVersion, caller.entitlementVersion) &&
    entitlement.supplyProfileId === caller.supplyProfileId &&
    sameVersion(entitlement.supplyProfileVersion, caller.supplyProfileVersion) &&
    entitlement.supplyMode === caller.supplyMode &&
    sameVersion(entitlement.modelScopeVersion, caller.modelScopeVersion) &&
    versionText(entitlement.projectPolicyVersion) !== null &&
    Array.isArray(entitlement.allowedModels) &&
    entitlement.allowedModels.includes(input.publicModel) &&
    Array.isArray(caller.modelScopes) &&
    caller.modelScopes.includes(input.publicModel) &&
    Array.isArray(entitlement.allowedProviderIds) &&
    (caller.supplyMode === 'platform' ? entitlement.allowedProviderIds.length === 0 : true)
  );
}

function parseRoute(row: RouteRow, input: ProviderAccountSchedulerInput): PersistedRoute | null {
  const expectedTargetMode = input.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (
    !exactText(row.tenant_id, input.caller.tenantId) ||
    !exactText(row.project_id, input.caller.projectId) ||
    !exactText(row.public_model_alias, input.publicModel) ||
    row.route_status !== 'active' ||
    row.public_model_status !== 'active' ||
    row.public_model_version_status !== 'active' ||
    !sameVersion(row.route_version, row.current_version) ||
    versionText(row.current_version) === null ||
    !nonEmpty(row.route_id) ||
    !nonEmpty(row.public_model_id) ||
    versionText(row.public_model_version) === null ||
    !exactText(row.protocol, input.protocol) ||
    !exactText(row.supply_mode, input.caller.supplyMode) ||
    !exactText(row.target_mode, expectedTargetMode) ||
    !nonEmpty(row.upstream_id) ||
    !nonEmpty(row.endpoint) ||
    !nonEmpty(row.provider_id) ||
    !nonEmpty(row.product_id) ||
    !nonEmpty(row.model)
  ) {
    return null;
  }
  return {
    tenantId: input.caller.tenantId,
    projectId: input.caller.projectId,
    routeConfigId: row.route_id,
    routeConfigVersion: versionText(row.current_version) as string,
    publicModelId: row.public_model_id,
    publicModelVersion: versionText(row.public_model_version) as string,
    publicModel: input.publicModel,
    protocol: input.protocol,
    supplyMode: input.caller.supplyMode,
    targetMode: expectedTargetMode,
    upstreamId: row.upstream_id,
    providerId: row.provider_id,
    productId: row.product_id,
    model: row.model,
    endpoint: row.endpoint,
  };
}

function candidateMatchesRoute(
  candidate: RequestPreparationCandidateAuthority,
  route: PersistedRoute,
  input: ProviderAccountSchedulerInput,
  composite: ProviderAccountSchedulerCompositeContext | undefined,
): boolean {
  if (composite !== undefined) {
    /*
     * §4.4 composite: the candidate is expected on the RESOLVED target
     * platform — not the route config's nominal pin. The eligibility SQL
     * below still narrows the platform column through the candidate's own
     * provider/product params ($5/$6) and revalidates the pool/grant chain
     * from the candidate's pool facts; the nominal route's upstreamId is not
     * the composite target's pool, so the pool-id equality check does not
     * apply (the SQL joins enforce membership instead).
     */
    return (
      candidate.protocol === input.protocol &&
      candidate.supplyMode === input.caller.supplyMode &&
      candidate.supplyMode === 'platform' &&
      candidate.resolvedModel === composite.upstreamModel &&
      candidate.providerId === composite.targetPlatform &&
      candidate.productId === composite.productId &&
      candidate.endpoint === composite.endpoint
    );
  }
  if (
    candidate.protocol !== input.protocol ||
    candidate.supplyMode !== input.caller.supplyMode ||
    candidate.resolvedModel !== route.model ||
    candidate.providerId !== route.providerId ||
    candidate.productId !== route.productId ||
    candidate.endpoint !== route.endpoint ||
    candidate.upstreamId !== route.upstreamId
  ) {
    return false;
  }
  return candidate.supplyMode !== 'platform' || candidate.poolId === route.upstreamId;
}

function validateCommonEligibilityRow(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  input: Pick<ProviderAccountSchedulerInput, 'caller' | 'publicModel' | 'protocol'>,
  now: Date,
): boolean {
  const ownerKind = candidate.supplyMode === 'byok' ? 'tenant' : 'platform';
  return (
    row.product_status === 'active' &&
    exactText(row.profile_tenant_id, input.caller.tenantId) &&
    exactText(row.profile_id, input.caller.supplyProfileId) &&
    exactText(row.profile_supply_mode, candidate.supplyMode) &&
    row.profile_status === 'active' &&
    sameVersion(row.profile_authz_version, input.caller.supplyProfileVersion) &&
    containsScope(row.profile_model_scopes, input.publicModel) &&
    exactText(row.account_owner_kind, ownerKind) &&
    exactText(row.account_supply_mode, candidate.supplyMode) &&
    exactText(row.account_id, candidate.accountId) &&
    exactText(row.account_provider_id, candidate.providerId) &&
    exactText(row.account_product_id, candidate.productId) &&
    nonEmpty(row.account_credential_type) &&
    nonEmpty(row.account_region) &&
    nonEmpty(row.account_purpose) &&
    nonEmpty(row.account_rights_id) &&
    versionText(row.account_rights_version) !== null &&
    row.account_status === 'active' &&
    row.account_validation_state === 'verified' &&
    sameVersion(row.account_authz_version, candidate.accountAuthzVersion) &&
    exactText(row.credential_owner_kind, ownerKind) &&
    exactText(row.credential_supply_mode, candidate.supplyMode) &&
    exactText(row.credential_id, candidate.credentialId) &&
    exactText(row.credential_account_id, candidate.accountId) &&
    exactText(row.credential_provider_id, candidate.providerId) &&
    exactText(row.credential_product_id, candidate.productId) &&
    exactText(row.credential_type, row.account_credential_type) &&
    row.credential_status === 'active' &&
    row.credential_validation_state === 'verified' &&
    sameVersion(row.credential_current_version, candidate.credentialVersion) &&
    sameVersion(row.credential_version, candidate.credentialVersion) &&
    sameVersion(row.credential_authz_version, candidate.credentialAuthzVersion) &&
    exactText(row.version_owner_kind, ownerKind) &&
    exactText(row.version_supply_mode, candidate.supplyMode) &&
    exactText(row.version_credential_id, candidate.credentialId) &&
    row.version_status === 'active' &&
    unexpired(row.credential_expires_at, now) &&
    unexpired(row.version_expires_at, now) &&
    exactText(row.account_rights_provider_id, candidate.providerId) &&
    exactText(row.account_rights_product_id, candidate.productId) &&
    exactText(row.account_rights_credential_type, row.account_credential_type) &&
    exactText(row.account_rights_supply_mode, candidate.supplyMode) &&
    exactText(row.account_rights_region, row.account_region as string) &&
    exactText(row.account_rights_purpose, row.account_purpose as string) &&
    row.account_rights_status === 'active' &&
    sameVersion(row.account_rights_version, row.selected_account_rights_version) &&
    containsScope(row.account_rights_model_scope, candidate.resolvedModel) &&
    containsScope(row.account_rights_endpoint_scope, candidate.endpoint) &&
    currentWindow(row.account_rights_effective_at, row.account_rights_expires_at, now) &&
    sameVersion(row.capability_version, row.account_capability_version) &&
    exactText(row.capability_protocol, input.protocol) &&
    row.capability_support_level === 'supported' &&
    row.capability_validation_state === 'verified'
  );
}

function validateByokRelation(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  now: Date,
): boolean {
  return (
    candidate.supplyMode === 'byok' &&
    versionText(
      (candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown })
        .profileAccountAuthzVersion,
    ) !== null &&
    exactText(row.mapping_tenant_id, candidate.tenantId) &&
    exactText(row.mapping_profile_id, candidate.supplyProfileId) &&
    exactText(row.mapping_supply_mode, 'byok') &&
    exactText(row.mapping_account_id, candidate.accountId) &&
    exactText(row.mapping_provider_id, candidate.providerId) &&
    exactText(row.mapping_product_id, candidate.productId) &&
    sameVersion(row.mapping_account_authz_version, candidate.accountAuthzVersion) &&
    row.mapping_status === 'active' &&
    sameVersion(
      row.mapping_authz_version,
      (candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown })
        .profileAccountAuthzVersion,
    ) &&
    currentWindow(row.mapping_effective_at, row.mapping_expires_at, now)
  );
}

function validatePlatformRelation(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
  now: Date,
): boolean {
  const platform = candidate as RequestPreparationCandidateAuthority & {
    poolId?: unknown;
    poolAuthzVersion?: unknown;
    poolMemberAccountAuthzVersion?: unknown;
    poolMemberAuthzVersion?: unknown;
    poolGrantAuthzVersion?: unknown;
    poolGrantProfileAuthzVersion?: unknown;
    poolGrantPoolAuthzVersion?: unknown;
  };
  return (
    candidate.supplyMode === 'platform' &&
    nonEmpty(platform.poolId) &&
    versionText(platform.poolAuthzVersion) !== null &&
    versionText(platform.poolMemberAccountAuthzVersion) !== null &&
    versionText(platform.poolMemberAuthzVersion) !== null &&
    versionText(platform.poolGrantAuthzVersion) !== null &&
    versionText(platform.poolGrantProfileAuthzVersion) !== null &&
    versionText(platform.poolGrantPoolAuthzVersion) !== null &&
    exactText(row.pool_id, platform.poolId) &&
    exactText(row.pool_provider_id, candidate.providerId) &&
    exactText(row.pool_product_id, candidate.productId) &&
    exactText(row.pool_credential_type, row.account_credential_type as string) &&
    exactText(row.pool_region, row.account_region as string) &&
    exactText(row.pool_purpose, row.account_purpose as string) &&
    nonEmpty(row.pool_rights_id) &&
    sameVersion(row.pool_rights_version, row.selected_pool_rights_version) &&
    row.pool_status === 'active' &&
    row.pool_validation_state === 'verified' &&
    sameVersion(row.pool_authz_version, platform.poolAuthzVersion) &&
    exactText(row.member_pool_id, platform.poolId) &&
    exactText(row.member_account_id, candidate.accountId) &&
    exactText(row.member_provider_id, candidate.providerId) &&
    exactText(row.member_product_id, candidate.productId) &&
    row.member_status === 'active' &&
    sameVersion(row.member_account_authz_version, platform.poolMemberAccountAuthzVersion) &&
    sameVersion(row.member_authz_version, platform.poolMemberAuthzVersion) &&
    exactText(row.grant_tenant_id, candidate.tenantId) &&
    exactText(row.grant_profile_id, candidate.supplyProfileId) &&
    exactText(row.grant_supply_mode, 'platform') &&
    row.grant_status === 'active' &&
    sameVersion(row.grant_authz_version, platform.poolGrantAuthzVersion) &&
    sameVersion(row.grant_profile_authz_version, platform.poolGrantProfileAuthzVersion) &&
    sameVersion(row.grant_profile_authz_version, candidate.supplyProfileAuthzVersion) &&
    sameVersion(row.grant_pool_authz_version, platform.poolGrantPoolAuthzVersion) &&
    sameVersion(row.grant_pool_authz_version, platform.poolAuthzVersion) &&
    currentWindow(row.grant_effective_at, row.grant_expires_at, now) &&
    exactText(row.pool_rights_provider_id, candidate.providerId) &&
    exactText(row.pool_rights_product_id, candidate.productId) &&
    exactText(row.pool_rights_credential_type, row.account_credential_type as string) &&
    exactText(row.pool_rights_supply_mode, 'platform') &&
    exactText(row.pool_rights_region, row.account_region as string) &&
    exactText(row.pool_rights_purpose, row.account_purpose as string) &&
    row.pool_rights_status === 'active' &&
    containsScope(row.pool_rights_model_scope, candidate.resolvedModel) &&
    containsScope(row.pool_rights_endpoint_scope, candidate.endpoint) &&
    currentWindow(row.pool_rights_effective_at, row.pool_rights_expires_at, now)
  );
}

function toRights(
  row: EligibilityRow,
  candidate: RequestPreparationCandidateAuthority,
): ProviderAccountSchedulerRights {
  return {
    providerId: row.account_rights_provider_id as string,
    productId: row.account_rights_product_id as string,
    model: candidate.resolvedModel,
    endpoint: candidate.endpoint,
    supplyMode: candidate.supplyMode,
    status: 'active',
    version: row.account_rights_version as string | number,
    effectiveAt: row.account_rights_effective_at as string | Date,
    expiresAt: row.account_rights_expires_at as string | Date | null,
  };
}

function inputScopeIsInvalid(input: ProviderAccountSchedulerInput): boolean {
  return (
    !entitlementMatchesInput(input) ||
    (input.caller.supplyMode === 'byok' &&
      (!Array.isArray(input.entitlement.allowedProviderIds) ||
        input.entitlement.allowedProviderIds.some((value) => !nonEmpty(value))))
  );
}

class PostgresEligibilityAuthority {
  constructor(
    private readonly database: SaasDatabase,
    private readonly options: { readonly supplierCostRates: boolean } = { supplierCostRates: false },
  ) {}

  async revalidate(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly billingGroupId?: string;
    readonly composite?: ProviderAccountSchedulerCompositeContext;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerEligibilityDecision> {
    try {
      if (
        inputScopeIsInvalid({
          requestId: 'scheduler-revalidation',
          caller: input.caller,
          entitlement: input.entitlement,
          candidates: [input.candidate],
          publicModel: input.publicModel,
          protocol: input.protocol,
        })
      ) {
        return { decision: 'block', reason: 'persisted caller and entitlement scopes do not agree' };
      }
      if (!isRecord(input.candidate) || !nonEmpty(input.candidate.accountId)) {
        return { decision: 'block', reason: 'candidate account authority is malformed' };
      }
      if (
        input.caller.supplyMode === 'byok' &&
        !input.entitlement.allowedProviderIds.includes(input.candidate.providerId)
      ) {
        return { decision: 'deny', reason: 'provider is outside the persisted BYOK entitlement' };
      }
      // F2: platform revalidation without a resolved billing group can never
      // enforce pool narrowing — fail closed rather than guessing unrestricted.
      if (input.caller.supplyMode === 'platform' && !nonEmpty(input.billingGroupId)) {
        return { decision: 'block', reason: 'billing group authority is unavailable' };
      }
      // §4.4 composite: the resolved decision is platform-pool routing; a
      // composite context on a BYOK selection can never be honored.
      if (input.composite !== undefined && input.caller.supplyMode !== 'platform') {
        return { decision: 'block', reason: 'composite route context is outside the platform supply mode' };
      }

      return await this.database.transaction(async (tx) => {
        const routeResult = await tx.query<RouteRow>(ROUTE_SQL, [
          input.caller.tenantId,
          input.caller.projectId,
          input.publicModel,
          input.protocol,
          input.caller.supplyMode,
        ]);
        if (routeResult.rows.length === 0) {
          return { decision: 'block', reason: 'active persisted route authority is missing' };
        }
        if (routeResult.rows.length !== 1) {
          return { decision: 'block', reason: 'active persisted route authority is ambiguous' };
        }
        const route = parseRoute(routeResult.rows[0], {
          requestId: 'scheduler-revalidation',
          caller: input.caller,
          entitlement: input.entitlement,
          candidates: [input.candidate],
          publicModel: input.publicModel,
          protocol: input.protocol,
        });
        if (!route) return { decision: 'block', reason: 'active persisted route authority is malformed' };
        if (
          !candidateMatchesRoute(
            input.candidate,
            route,
            {
              requestId: 'scheduler-revalidation',
              caller: input.caller,
              entitlement: input.entitlement,
              candidates: [input.candidate],
              publicModel: input.publicModel,
              protocol: input.protocol,
            },
            input.composite,
          )
        ) {
          return { decision: 'deny', reason: 'candidate is outside the exact persisted route provider/product' };
        }

        const rowResult = await tx.query<EligibilityRow>(
          input.caller.supplyMode === 'byok' ? BYOK_ELIGIBILITY_SQL : PLATFORM_ELIGIBILITY_SQL,
          input.caller.supplyMode === 'byok' ? byokValues(input, route) : platformValues(input, route),
        );
        if (rowResult.rows.length === 0) {
          return {
            decision: 'deny',
            reason: 'account, rights, capability, credential, or active supply relation is unavailable',
          };
        }
        if (rowResult.rows.length !== 1) {
          return { decision: 'block', reason: 'persisted account eligibility authority is ambiguous' };
        }
        const row = rowResult.rows[0];
        const relationIsValid =
          input.caller.supplyMode === 'byok'
            ? validateByokRelation(row, input.candidate, input.now)
            : validatePlatformRelation(row, input.candidate, input.now);
        if (!validateCommonEligibilityRow(row, input.candidate, input, input.now) || !relationIsValid) {
          return { decision: 'deny', reason: 'persisted account eligibility facts no longer match the candidate' };
        }
        const priority = schedulingPriority(row.account_priority);
        const weight = schedulingWeight(row.account_weight);
        if (priority === null || weight === null) {
          return { decision: 'block', reason: 'persisted account scheduling scalars are malformed' };
        }
        // F2 (migration 105): the billing-group pool priority is a scheduling
        // signal only — it never grants or removes eligibility here (the SQL
        // membership guard does that) and never enters the billing path. NULL
        // (no pool rows / BYOK) is "no signal"; a present-but-malformed value
        // is authority drift and blocks the whole selection, mirroring the
        // scheduling-scalar fail-closed rule.
        const groupPoolPriority =
          row.group_pool_priority === null || row.group_pool_priority === undefined
            ? null
            : schedulingScalar(row.group_pool_priority, 0, 1000);
        if (row.group_pool_priority != null && groupPoolPriority === null) {
          return { decision: 'block', reason: 'persisted billing group pool priority is malformed' };
        }
        const quotaSignal = schedulingQuotaSignal(row.account_quota_state);
        if (quotaSignal === 'malformed') {
          return { decision: 'block', reason: 'persisted account quota signal is malformed' };
        }
        if (quotaSignal === 'exhausted') {
          return { decision: 'deny', reason: 'persisted account quota snapshot is exhausted' };
        }
        // Migration 119 (batch 3 grok; core-plan 9.1 B06): the persisted Grok
        // 429 cooldown deadline and the free-tier soft gate are consumed here.
        // Both are fail-open on absent/malformed data: a quota-header write in
        // flight (or a never-probed account) never removes availability —
        // matching the free-tier gate's fail-open rule and the R3 egress
        // precedent for jitters that must not block scheduling. A live 429
        // cooldown is a DURABLE scheduling signal (the SQL 109/115 precedent),
        // so an excluded candidate is denied for this attempt only, exactly
        // like an exhausted quota snapshot — the durable authority stays the
        // pause-write and the next request re-evaluates.
        const grokRateLimitedUntilMs = timestampMs(row.account_grok_rate_limited_until);
        const nowMs = input.now.getTime();
        if (grokRateLimitedUntilMs !== null && Number.isFinite(nowMs) && grokRateLimitedUntilMs > nowMs) {
          return { decision: 'deny', reason: 'persisted grok 429 cooldown is still active' };
        }
        const grokGateDecision = evaluateGrokFreeTierGateSnapshot({
          subscriptionTier:
            row.account_grok_subscription_tier === null || row.account_grok_subscription_tier === undefined
              ? null
              : typeof row.account_grok_subscription_tier === 'string'
                ? row.account_grok_subscription_tier
                : null,
          observedUsedPercent:
            typeof row.account_grok_5h_used_percent === 'number' ? row.account_grok_5h_used_percent : null,
          observedAtMs: timestampMs(row.account_grok_usage_updated_at),
          nowMs,
        });
        if (grokGateDecision === 'excluded') {
          return {
            decision: 'deny',
            reason: 'grok free-tier soft gate: observed window at or above the 95% allowance floor',
          };
        }
        // R6: account-level rpm/tpm ceilings deny only this candidate (the D4
        // exhausted semantics); NULL limits skip the window read entirely.
        const rpmLimit = schedulingRateLimit(row.account_rpm_limit);
        const tpmLimit = schedulingRateLimit(row.account_tpm_limit);
        if (rpmLimit === 'malformed' || tpmLimit === 'malformed') {
          return { decision: 'block', reason: 'persisted account rate limits are malformed' };
        }
        if (rpmLimit !== null || tpmLimit !== null) {
          const windowResult = await tx.query<{ requests: unknown; tokens: unknown }>(RATE_WINDOW_SQL, [
            input.candidate.supplyMode === 'byok' ? 'tenant' : 'platform',
            input.candidate.accountId,
            input.now,
          ]);
          if (windowResult.rows.length !== 1) {
            return { decision: 'block', reason: 'persisted account rate window is unavailable' };
          }
          const windowRequests = rateWindowSum(windowResult.rows[0]?.requests);
          const windowTokens = rateWindowSum(windowResult.rows[0]?.tokens);
          if (windowRequests === null || windowTokens === null) {
            return { decision: 'block', reason: 'persisted account rate window is malformed' };
          }
          if (rpmLimit !== null && windowRequests >= BigInt(rpmLimit)) {
            return { decision: 'deny', reason: 'persisted account rpm limit is exhausted' };
          }
          if (tpmLimit !== null && windowTokens >= BigInt(tpmLimit)) {
            return { decision: 'deny', reason: 'persisted account tpm limit is exhausted' };
          }
        }
        // R7: the continuous health score modulates the weighted draw only;
        // it never grants or removes eligibility by itself. The shared
        // health-score module (agent N's R7 formula) throws on any malformed
        // persisted shape, which maps to the fail-closed scheduling block
        // instead of a guess.
        // R3 (migration 107): a 'dead' egress proxy demotes the account to
        // the contract minimum weight — an eligibility signal only. Proxy
        // jitter must never remove an account (that would migrate traffic
        // across exit IPs and trip the provider risk control this feature
        // exists to prevent); anything but a known quality is ignored so a
        // probe write in flight cannot block scheduling.
        const egressProxyQuality = row.account_egress_proxy_quality;
        const deadEgressProxy = egressProxyQuality === 'dead';
        let adjustedWeight: number;
        try {
          const healthScore = parseHealthScoreColumn(row.account_health_score);
          // D4: a 'low' quota snapshot demotes to the contract minimum
          // weight; the R7 health multiplier then applies on top of it.
          adjustedWeight = effectiveWeight(quotaSignal === 'low' || deadEgressProxy ? 1 : weight, healthScore);
        } catch {
          return { decision: 'block', reason: 'persisted account health score is malformed' };
        }
        // R7 (plan §R7 items 1–2): scheduling-only signals — the soonest
        // upcoming quota-window reset (099/100/108 columns, always surfaced;
        // NULL = never observed = no signal) and, when the cost-priority
        // strategy is enabled, the candidate's exact rational supplier rate
        // read from saas_supplier_cost_versions. Neither ever enters the
        // billing path (093 quota-snapshot precedent).
        const quotaReset = soonestQuotaReset(row, input.now);
        let supplierCostRate: {
          numeratorMinorUnits: bigint | number | string;
          denominatorUnits: bigint | number | string;
        } | null = null;
        if (this.options.supplierCostRates && nonEmpty(input.candidate.supplierCostVersion)) {
          const rateResult = await tx.query<{
            input_rate_numerator_minor_units: unknown;
            input_rate_denominator_units: unknown;
            output_rate_numerator_minor_units: unknown;
            output_rate_denominator_units: unknown;
          }>(SUPPLIER_COST_RATE_SQL, [input.candidate.supplierCostVersion]);
          if (rateResult.rows.length > 1) {
            return { decision: 'block', reason: 'persisted supplier cost version is ambiguous' };
          }
          if (rateResult.rows.length === 1) {
            const rate = rateResult.rows[0];
            const inputNumerator = exactNonNegativeBigInt(rate.input_rate_numerator_minor_units);
            const inputDenominator = exactNonNegativeBigInt(rate.input_rate_denominator_units);
            const outputNumerator = exactNonNegativeBigInt(rate.output_rate_numerator_minor_units);
            const outputDenominator = exactNonNegativeBigInt(rate.output_rate_denominator_units);
            if (
              inputNumerator === null ||
              inputDenominator === null ||
              outputNumerator === null ||
              outputDenominator === null ||
              inputDenominator === 0n ||
              outputDenominator === 0n
            ) {
              return { decision: 'block', reason: 'persisted supplier cost rate is malformed' };
            }
            // Blended input+output rate: inNum/outDen + outNum/inDen over the
            // common denominator — pure bigint arithmetic, never floating point.
            supplierCostRate = {
              numeratorMinorUnits: inputNumerator * outputDenominator + outputNumerator * inputDenominator,
              denominatorUnits: inputDenominator * outputDenominator,
            };
          }
        }
        return {
          decision: 'allow',
          candidate: input.candidate,
          // §4.4 composite: the revalidated route identity carries the
          // resolved target platform so downstream route checks compare the
          // candidate against its actual serving provider.
          route:
            input.composite !== undefined
              ? {
                  ...route,
                  providerId: input.composite.targetPlatform,
                  productId: input.composite.productId,
                }
              : route,
          status: 'active',
          capability: {
            protocol: input.protocol,
            supportLevel: 'supported',
            validationState: 'verified',
          },
          rights: toRights(row, input.candidate),
          // Contract C-7: persisted scheduling scalars (082), never inferred.
          priority,
          weight: adjustedWeight,
          scheduling: {
            soonestResetAt: quotaReset === null ? null : quotaReset.resetAt,
            soonestResetObservedAt: quotaReset === null ? null : quotaReset.observedAt,
            supplierCostRate,
            groupPoolPriority,
          },
        };
      });
    } catch {
      return { decision: 'block', reason: 'PostgreSQL provider eligibility authority is unavailable' };
    }
  }
}

function byokValues(
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly now: Date;
  },
  _route: PersistedRoute,
): readonly unknown[] {
  const candidate = input.candidate as RequestPreparationCandidateAuthority & { profileAccountAuthzVersion?: unknown };
  return [
    input.caller.tenantId,
    input.caller.supplyProfileId,
    candidate.accountId,
    candidate.providerId,
    candidate.productId,
    candidate.resolvedModel,
    candidate.endpoint,
    candidate.credentialId,
    candidate.credentialVersion,
    candidate.accountAuthzVersion,
    candidate.credentialAuthzVersion,
    input.caller.supplyProfileVersion,
    candidate.profileAccountAuthzVersion,
    input.now,
    input.publicModel,
    candidate.protocol,
  ];
}

function platformValues(
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly billingGroupId?: string;
    readonly composite?: ProviderAccountSchedulerCompositeContext;
    readonly now: Date;
  },
  route: PersistedRoute,
): readonly unknown[] {
  const candidate = input.candidate as RequestPreparationCandidateAuthority & {
    poolId?: unknown;
    poolAuthzVersion?: unknown;
    poolMemberAccountAuthzVersion?: unknown;
    poolMemberAuthzVersion?: unknown;
    poolGrantAuthzVersion?: unknown;
    poolGrantProfileAuthzVersion?: unknown;
    poolGrantPoolAuthzVersion?: unknown;
  };
  return [
    input.caller.tenantId,
    input.caller.supplyProfileId,
    candidate.poolId,
    candidate.accountId,
    candidate.providerId,
    candidate.productId,
    candidate.resolvedModel,
    // §4.4 composite: the serving endpoint is the resolved target's; the
    // nominal route endpoint does not describe the composite dispatch.
    input.composite !== undefined ? input.composite.endpoint : route.endpoint,
    candidate.credentialId,
    candidate.credentialVersion,
    candidate.credentialAuthzVersion,
    candidate.accountAuthzVersion,
    input.caller.supplyProfileVersion,
    candidate.poolAuthzVersion,
    candidate.poolMemberAccountAuthzVersion,
    candidate.poolMemberAuthzVersion,
    candidate.poolGrantAuthzVersion,
    candidate.poolGrantProfileAuthzVersion,
    candidate.poolGrantPoolAuthzVersion,
    input.now,
    input.publicModel,
    candidate.protocol,
    // F2: $23 — the server-resolved billing group narrowing the pool domain.
    input.billingGroupId,
  ];
}

function parseCount(value: unknown): number | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number'
          ? BigInt(value)
          : typeof value === 'string' && /^[0-9]+$/.test(value)
            ? BigInt(value)
            : null;
    if (parsed === null || parsed < 0n || parsed > 1_000_000_000n) return null;
    return Number(parsed);
  } catch {
    return null;
  }
}

function isLeaseConcurrencyLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

async function postgresConcurrency(
  database: SaasDatabase,
  leaseConcurrencyLimit: number | undefined,
  input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
  },
): Promise<ProviderAccountSchedulerConcurrencyDecision> {
  if (!isLeaseConcurrencyLimit(leaseConcurrencyLimit)) {
    return {
      decision: 'block',
      reason:
        'provider account lease concurrency limit is missing; configure the same maxConcurrency as the lease service',
    };
  }
  try {
    const ownerKind = input.candidate.supplyMode === 'byok' ? 'tenant' : 'platform';
    const ownerTenantId = ownerKind === 'tenant' ? input.caller.tenantId : null;
    const result = await database.query<{ in_flight: unknown }>(CONCURRENCY_SQL, [
      ownerKind,
      ownerTenantId,
      input.candidate.accountId,
    ]);
    if (result.rows.length !== 1) {
      return { decision: 'block', reason: 'provider account lease concurrency snapshot is unavailable' };
    }
    const inFlight = parseCount(result.rows[0].in_flight);
    if (inFlight === null) {
      return { decision: 'block', reason: 'provider account lease concurrency snapshot is malformed' };
    }
    if (inFlight >= leaseConcurrencyLimit) {
      return { decision: 'deny', reason: 'provider account has no observed free lease slot' };
    }
    return { decision: 'allow', value: { inFlight, limit: leaseConcurrencyLimit } };
  } catch {
    return { decision: 'block', reason: 'provider account lease concurrency authority is unavailable' };
  }
}

const MISSING_HEALTH: ProviderAccountSchedulerHealthPort = {
  async get() {
    return {
      decision: 'block',
      reason:
        'runtime health authority is missing: the SaaS schema has no account health/cooldown observation contract; validation_state is not runtime health',
    };
  },
};

const MISSING_AFFINITY: ProviderAccountSchedulerAffinityPort = {
  async resolve() {
    return {
      decision: 'block',
      reason:
        'affinity authority is missing: the SaaS schema has no persisted session/response-to-account mapping contract',
    };
  },
  async bind() {
    return {
      decision: 'block',
      reason:
        'affinity authority is missing: the SaaS schema has no persisted session/response-to-account mapping contract',
    };
  },
};

/*
 * H5a (R9 bench finding P5a): the self-healing health port. Without an
 * in-product refresher, any quiet phase longer than maxHealthAgeMs left
 * every account's runtime-health row stale, and the plain port's fail-closed
 * block then walled ALL traffic ('provider account health authority is
 * unavailable') until an external primer ran (the R9 bench shipped a
 * health-warmer shell script for exactly this).
 *
 * This adapter keeps the fail-closed posture for everything except the two
 * conditions that are genuinely self-healable: a well-formed row whose
 * observation is merely OLD, and — P18 (R9 re-run finding) — a candidate
 * with NO row at all (a freshly seeded deployment; rows are DELETE-proof,
 * so a missing row means "never observed" and previously blocked forever).
 * For both cases it admits a half-open probe through the existing
 * single-winner CAS (the zero-row case through the P18 cold-start prime),
 * and the winner performs the reference-E2E probe pattern — acquire an
 * account lease, record a lease-authorized probe outcome, release — which
 * refreshes (or creates) the row's observed_at. The probe outcome is
 * justified by the eligibility revalidation that ran immediately before
 * this port is consulted in the same selection (account active, credential
 * verified, rights active, capability verified); it claims nothing about
 * the provider endpoint. If the account is actually faulted, the dispatch
 * failure feedback (H5c) cools it again within a couple of dispatches, and
 * a genuinely failing probe outcome re-enters the durable cooldown path.
 */
class HalfOpenProbeHealthPort implements ProviderAccountSchedulerHealthPort {
  constructor(
    private readonly store: ProviderAccountHealthSchedulingPort &
      ProviderAccountHalfOpenProbeAdmissionPort &
      ProviderAccountRuntimeHealthWriter,
    private readonly leaseProvider: ProviderAccountHealthProbeLeaseProvider,
    private readonly maxHealthAgeMs: number,
  ) {}

  async get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerHealthDecision> {
    const view = await this.store.getSchedulingView({
      caller: input.caller,
      candidate: input.candidate,
      now: input.now,
    });
    if (view.decision === 'allow') {
      const observedAt = view.value.observedAt;
      const skewMs = observedAt.getTime() - input.now.getTime();
      const ageMs = input.now.getTime() - observedAt.getTime();
      // Fresh per this scheduler's own bound: pass the exact decision the
      // plain port would have produced (the core scheduler re-validates).
      if (skewMs <= MAX_HEALTH_OBSERVED_AT_SKEW_MS && ageMs <= this.maxHealthAgeMs) {
        return {
          decision: 'allow',
          value: {
            status: view.value.status,
            observedAt,
            cooldownUntil: view.value.status === 'cooldown' ? view.value.cooldownUntil : null,
          },
        };
      }
      // Stale per this scheduler's (possibly tighter) bound: fall through to
      // the half-open probe path below.
      return this.probeCandidate(input.candidate, input.now, 'stale');
    }
    // Everything but staleness and the zero-row cold start keeps the
    // fail-closed block: malformed data (including genuinely future
    // timestamps), an unavailable authority, or invalid input.
    if (view.code !== 'stale' && view.code !== 'unknown') {
      return { decision: 'block', reason: view.reason };
    }
    // P18: a missing row is the one-time built-in cold-start priming case —
    // the same single-winner CAS + lease + probe-outcome pattern, with the
    // store's prime INSERT creating the row the probe then refreshes.
    return this.probeCandidate(input.candidate, input.now, view.code === 'unknown' ? 'unobserved' : 'stale');
  }

  /**
   * Single-winner half-open probe for one stale (or never-observed)
   * candidate. The winner records a lease-authorized probe outcome and
   * becomes schedulable; every loser (probe in flight, storage blip, no free
   * lease slot) is denied for this candidate only — never a whole-selection
   * block.
   */
  private async probeCandidate(
    candidate: RequestPreparationCandidateAuthority,
    now: Date,
    cause: 'stale' | 'unobserved',
  ): Promise<ProviderAccountSchedulerHealthDecision> {
    let admitted: 'admitted' | 'closed';
    try {
      admitted = await this.store.tryAdmitHalfOpenProbe({ candidate, staleAfterMs: this.maxHealthAgeMs });
    } catch {
      admitted = 'closed';
    }
    if (admitted !== 'admitted') {
      return {
        decision: 'deny',
        reason: `provider account runtime health is ${cause} and a half-open probe is already in flight`,
      };
    }
    const attemptId = randomUUID();
    try {
      const lease = await this.leaseProvider.acquire({
        tenantId: candidate.tenantId,
        accountId: candidate.accountId,
        upstreamId: candidate.upstreamId,
        attemptId,
        evidence: {
          tenantId: candidate.tenantId,
          accountId: candidate.accountId,
          upstreamId: candidate.upstreamId,
          attemptId,
          supplyMode: candidate.supplyMode,
        },
      });
      if (lease === null) {
        return {
          decision: 'deny',
          reason: `provider account runtime health is ${cause} and the probe lease is unavailable`,
        };
      }
      try {
        const applied = await this.store.recordRuntimeOutcome({
          candidate,
          attemptId,
          fencingToken: lease.fencingToken,
          evidence: { source: 'probe', result: 'success' },
        });
        if (applied !== 'applied') {
          return {
            decision: 'deny',
            reason: `provider account runtime health is ${cause} and the probe outcome was fenced out`,
          };
        }
      } finally {
        try {
          await lease.release();
        } catch {
          // The lease TTL bounds a failed release; the probe outcome write
          // has already been recorded.
        }
      }
      // The probe outcome was just persisted with observed_at = the
      // PostgreSQL clock, i.e. fresh as of this decision.
      return { decision: 'allow', value: { status: 'healthy', observedAt: now, cooldownUntil: null } };
    } catch {
      return {
        decision: 'deny',
        reason: `provider account runtime health is ${cause} and the half-open probe failed`,
      };
    }
  }
}

/*
 * R7 observability (plan §R7 item 5): one append-only saas_audit_events row
 * per strategy-enabled selection, targeting the attempt this selection
 * prepared (request-scoped when the caller did not allocate an attempt id).
 * The action carries the discriminated strategy dimensions so operators can
 * filter by prefix. The write is best-effort by design: the selection has
 * already been made and is separately authorized and audited downstream, so
 * an observability insert failure must never turn into an availability
 * failure — it is swallowed, not allowed to block dispatch.
 */
const SCHEDULER_SELECTION_AUDIT_SQL = `/* postgres-provider-account-scheduler:selection-audit */
INSERT INTO saas_audit_events
  (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point, request_id)
VALUES ($1, $2, NULL, $3, $4, $5, $6, 'provider_account_scheduler', $7)`;

const SCHEDULER_SELECTION_AUDIT_ACTION = 'provider_account_scheduler.selection';

/**
 * PostgreSQL revalidation for the commercial gateway. Every eligible account
 * must match the current route, explicit rights, verified account-bound
 * capability, current credential metadata, and active supply relationship.
 * Health/affinity are never inferred from account labels or validation state.
 * The lease snapshot is observational; dispatch must still acquire the fenced
 * lease through PostgresProviderAccountLeaseService before transport I/O.
 *
 * F2 (task #35) composition: the wrapper resolves the request's billing group
 * once per platform selection (key binding → tenant default → 'default') and
 * enforces the group's claude_code_only flag against the R5 validator using
 * the trusted-boundary client evidence on the input — a failed validation
 * reroutes to the group's fallback (one hop; a fallback that is itself
 * claude_code_only rejects rather than looping) or rejects with account_denied.
 * It also optionally pre-checks the R6b Redis concurrency slots in front of
 * the PostgreSQL lease snapshot (default off; fail-open; PG stays final).
 */
export class PostgresProviderAccountScheduler implements ProviderAccountSchedulerPort {
  private readonly scheduler: ProviderAccountScheduler;
  private readonly healthAuthorityConfigured: boolean;
  private readonly database: SaasDatabase;
  private readonly now: () => Date;
  /** The lease limit captured at construction for the slot-wrapped port. */
  private readonly leaseConcurrencyLimit: number | undefined;
  /** F2/R6b: configured only when the Redis slot pre-check is enabled. */
  private readonly redisSlots: RedisConcurrencySlots | undefined;
  private readonly redisSlotMaxSlots: number | undefined;
  private readonly redisSlotWindowMs: number | undefined;
  /** requestId → { scope, accounts } for slots acquired during one selection. */
  private readonly redisSlotAcquisitions = new Map<string, { ownerScopeKey: string; accounts: Set<string> }>();

  constructor(options: PostgresProviderAccountSchedulerOptions) {
    if (
      !options?.database ||
      typeof options.database.query !== 'function' ||
      typeof options.database.transaction !== 'function'
    ) {
      throw new TypeError('a transactional PostgreSQL SaaS database is required');
    }
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.leaseConcurrencyLimit = options.leaseConcurrencyLimit;
    this.healthAuthorityConfigured = options.health !== undefined;
    const redisSlotOptions = options.redisConcurrencySlots;
    if (redisSlotOptions?.enabled === true) {
      if (!redisSlotOptions.slots || typeof redisSlotOptions.slots.tryAcquire !== 'function') {
        throw new TypeError('a Redis concurrency slot client is required when the slot pre-check is enabled');
      }
      const maxSlots =
        redisSlotOptions.maxSlots !== undefined
          ? isLeaseConcurrencyLimit(redisSlotOptions.maxSlots)
            ? redisSlotOptions.maxSlots
            : null
          : (options.leaseConcurrencyLimit ?? null);
      if (maxSlots === null) {
        throw new TypeError('the Redis slot capacity must be a safe integer in [1, 10000]');
      }
      const windowMs = redisSlotOptions.windowMs ?? 60_000;
      if (typeof windowMs !== 'number' || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
        throw new TypeError('the Redis slot window must be a safe integer in [1000, 3600000]');
      }
      this.redisSlots = redisSlotOptions.slots;
      this.redisSlotMaxSlots = maxSlots;
      this.redisSlotWindowMs = windowMs;
    }
    const eligibility = new PostgresEligibilityAuthority(options.database, {
      // Only the cost-priority strategy needs an extra authority read; the
      // default (strategy-free) path never issues the supplier-cost query.
      supplierCostRates: options.strategies?.costPriority?.enabled === true,
    });
    this.scheduler = new ProviderAccountScheduler(
      {
        eligibility,
        health: options.healthProbe
          ? new HalfOpenProbeHealthPort(
              options.healthProbe.store,
              options.healthProbe.leaseProvider,
              resolveMaxHealthAgeMs(options.maxHealthAgeMs),
            )
          : (options.health ?? MISSING_HEALTH),
        concurrency: {
          get: (input) =>
            this.redisSlots === undefined
              ? postgresConcurrency(options.database, options.leaseConcurrencyLimit, input)
              : this.concurrencyWithRedisSlotPreCheck(input),
        },
        affinity: options.affinity ?? MISSING_AFFINITY,
        // H5c (P8): in-process post-failure cooldown; absent keeps the
        // candidate loop byte-identical.
        failureFeedback: options.failureFeedback,
        modelCooldown: options.modelCooldown,
        windowCost: options.windowCost,
      },
      options,
    );
  }

  async select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    if (!this.healthAuthorityConfigured) {
      return blockRequestPreparation(
        'capability_unavailable',
        'runtime health authority is missing: the SaaS schema has no account health/cooldown observation contract; validation_state is not runtime health',
      );
    }
    // F2: the empty-candidate shape is delegated to the core scheduler's
    // existing rejection untouched (no group resolution, no side reads).
    const hasCandidates = isRecord(input) && Array.isArray(input.candidates) && input.candidates.length > 0;
    let schedulingInput = input;
    if (
      hasCandidates &&
      isRecord(input?.caller) &&
      (input.caller as { supplyMode?: unknown }).supplyMode === 'platform'
    ) {
      const resolution = await this.resolveBillingGroupForSelection(input);
      if (resolution.decision !== 'allow') return resolution.decision;
      schedulingInput = { ...input, billingGroupId: resolution.billingGroupId };
    }
    // R-dormant (batch 2.2, migration 115): lazy scheduling-threshold
    // evaluation at candidate-collection time. Fail-open by design — a
    // threshold read/write failure must never break selection (the accounts
    // simply stay schedulable until the next evaluation).
    if (hasCandidates) {
      schedulingInput = await this.applySchedulingThresholdPause(schedulingInput);
    }
    const decision = await this.scheduler.select(schedulingInput).then((result) => {
      // R7: record the chosen strategy dimensions on the attempt audit. The
      // trace exists only when a strategy is enabled, so the default path
      // performs no extra write.
      if (result.decision === 'allow' && result.scheduling) {
        void this.recordSelectionAudit(schedulingInput, result.scheduling);
      }
      return result;
    });
    // F2/R6b: slots acquired for candidates that were checked but not chosen
    // are released; the selected account keeps its slot (the PG lease remains
    // the authority and the lazy-eviction window bounds a lost release).
    await this.settleRedisSlots(
      isRecord(schedulingInput) ? String((schedulingInput as { requestId?: unknown }).requestId ?? '') : '',
      decision.decision === 'allow' ? decision.value.accountId : null,
    );
    return decision;
  }

  /**
   * R-dormant (batch 2.2, migration 115; sub2api
   * ApplyAccountSchedulingThreshold port): lazy candidate-collection-time
   * evaluation of the scheduling-threshold pause. One batched id lookup per
   * owner scope reads the 099/100/108/111 quota windows, the dormant
   * auto_pause_*_threshold overrides and the current pause state; a window
   * at or above its threshold pauses the account until the LATEST breaching
   * window reset (the write never shortens a live pause, and an identical
   * re-evaluation is skipped without a statement). Paused candidates are
   * filtered out before the core scheduler sees them; the eligibility SQL's
   * pause predicate keeps the exclusion durable for any later revalidation.
   * Accounts with no threshold configured produce zero candidates — the
   * pre-activation behavior, byte-identical (the golden-fixture red line).
   */
  private async applySchedulingThresholdPause(
    input: ProviderAccountSchedulerInput,
  ): Promise<ProviderAccountSchedulerInput> {
    try {
      const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
      if (candidates.length === 0) return input;
      const nowMs = this.now().getTime();
      const byScope = new Map<'tenant' | 'platform', { accountId: string; tenantId: string | null }[]>();
      for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const accountId = typeof candidate.accountId === 'string' ? candidate.accountId : '';
        if (accountId === '') continue;
        const scope: 'tenant' | 'platform' =
          (candidate as { supplyMode?: unknown }).supplyMode === 'byok' ? 'tenant' : 'platform';
        const bucket = byScope.get(scope) ?? [];
        bucket.push({ accountId, tenantId: (input.caller as { tenantId?: unknown }).tenantId as string | null });
        byScope.set(scope, bucket);
      }
      const paused = new Set<string>();
      for (const [scope, accounts] of byScope) {
        const accountsTable = scope === 'tenant' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
        const result = await this.database.query<SchedulingThresholdCandidateRow>(
          schedulingThresholdCandidatesSql(accountsTable),
          [accounts.map((account) => account.accountId)],
        );
        const rows = result.rows;
        if (rows.length === 0) continue;
        // First pass: honor live pauses, evaluate new ones.
        const pendingWrites: {
          row: SchedulingThresholdCandidateRow;
          pause: ReturnType<typeof evaluateSchedulingThresholdPause>;
        }[] = [];
        for (const row of rows) {
          if (typeof row.account_id !== 'string' || row.account_id === '') continue;
          const storedUntilMs =
            row.scheduling_threshold_pause_until instanceof Date
              ? row.scheduling_threshold_pause_until.getTime()
              : typeof row.scheduling_threshold_pause_until === 'string' && row.scheduling_threshold_pause_until !== ''
                ? Date.parse(row.scheduling_threshold_pause_until)
                : Number.NaN;
          const storedUntil = Number.isFinite(storedUntilMs) ? storedUntilMs : null;
          if (storedUntil !== null && storedUntil > nowMs) {
            paused.add(row.account_id);
          }
          const pause = evaluateSchedulingThresholdPause({
            nowMs,
            candidates: schedulingThresholdCandidatesFromRow(row, nowMs),
          });
          if (pause === null) continue;
          // Never shorten: a stored pause at or beyond the new deadline
          // stays as-is (the sub2api SetTempUnschedulable guard).
          if (storedUntil !== null && storedUntil >= pause.untilMs) {
            if (pause.untilMs > nowMs) paused.add(row.account_id);
            continue;
          }
          const reason = buildSchedulingThresholdPauseReason({ pause, triggeredAtMs: nowMs });
          if (
            schedulingThresholdPauseMatches(
              { untilMs: storedUntil, reason: row.scheduling_threshold_pause_reason },
              pause,
              reason,
            )
          ) {
            if (pause.untilMs > nowMs) paused.add(row.account_id);
            continue;
          }
          pendingWrites.push({ row, pause });
        }
        if (pendingWrites.length === 0) continue;
        // Window-cost enrichment (the GetAccountWindowStats batch pattern):
        // one grouped aggregation per DISTINCT window start, fail-open.
        let windowCosts: ReadonlyMap<string, { requests: number; tokens: bigint }> = new Map();
        try {
          const starts = new Map<string, number>();
          for (const write of pendingWrites) {
            starts.set(write.row.account_id, schedulingThresholdWindowStartMs(write.row, nowMs));
          }
          const buckets = groupAccountIdsByWindowStart(
            starts,
            [...starts.keys()],
            Math.floor(nowMs / 3_600_000) * 3_600_000,
          );
          const merged = new Map<string, { requests: number; tokens: bigint }>();
          for (const [startMs, accountIds] of buckets) {
            const batch = await getAccountWindowStatsBatch(this.database, accountIds, startMs);
            for (const [accountId, stats] of batch) merged.set(accountId, stats);
          }
          windowCosts = merged;
        } catch {
          // The cost observation is enrichment only; the pause stands without it.
        }
        const writeStatement = schedulingThresholdPauseWriteSql(accountsTable, scope);
        for (const write of pendingWrites) {
          const pause = write.pause;
          if (pause === null) continue;
          const reason = buildSchedulingThresholdPauseReason({
            pause,
            triggeredAtMs: nowMs,
            windowCost: windowCosts.size > 0 ? accountWindowStatsOrZero(windowCosts, write.row.account_id) : null,
          });
          const tenantId =
            scope === 'tenant'
              ? (accounts.find((account) => account.accountId === write.row.account_id)?.tenantId ?? null)
              : null;
          if (scope === 'tenant' && (typeof tenantId !== 'string' || tenantId === '')) continue;
          await this.database.query(writeStatement.sql, [
            ...writeStatement.values(
              new Date(pause.untilMs).toISOString(),
              JSON.stringify(reason),
              write.row.account_id,
              tenantId,
            ),
          ]);
          if (pause.untilMs > nowMs) paused.add(write.row.account_id);
        }
      }
      if (paused.size === 0) return input;
      const remaining = candidates.filter(
        (candidate) =>
          !isRecord(candidate) || typeof candidate.accountId !== 'string' || !paused.has(candidate.accountId),
      );
      return { ...input, candidates: remaining };
    } catch {
      // Fail-open: the threshold pause is a scheduling optimization; a read
      // or write failure leaves the accounts schedulable until the next
      // evaluation (the eligibility-SQL predicate stays the durable guard).
      return input;
    }
  }

  /**
   * F2 + R1 (roadmap 1.3, phase 4): resolves the effective billing group for
   * one platform selection and applies the claude_code_only enforcement (R5
   * validator) and the supported_model_scopes gate (the requested public
   * model must be an exact entry; null scopes are unrestricted), walking the
   * fallback chain with cycle detection when either gate fails. Group
   * resolution failure blocks the whole selection — an unresolvable group
   * must never silently widen the domain. The fallback reroutes SCHEDULING
   * only (pool narrowing); pricing stays on the key's own group terms, the
   * F2 semantics.
   */
  private async resolveBillingGroupForSelection(
    input: ProviderAccountSchedulerInput,
  ): Promise<
    | { readonly decision: 'allow'; readonly billingGroupId: string }
    | { readonly decision: RequestPreparationDecision<RequestPreparationCandidateAuthority> }
  > {
    try {
      const caller = input.caller as { tenantId?: unknown; projectId?: unknown; proxyKeyId?: unknown };
      const group = await this.queryBillingGroup(BILLING_GROUP_SQL, [
        caller.tenantId,
        caller.projectId,
        caller.proxyKeyId,
      ]);
      if (group === 'block') {
        return {
          decision: blockRequestPreparation('capability_unavailable', 'billing group authority is unavailable'),
        };
      }
      const requestedModel = (input as { publicModel?: unknown }).publicModel;
      // A scope-restricted group with an unresolvable requested model can
      // never be verified — fail closed rather than waive the gate.
      if (group.supportedModelScopes !== null && !nonEmpty(requestedModel)) {
        return {
          decision: blockRequestPreparation('capability_unavailable', 'billing group authority is unavailable'),
        };
      }
      const visited = new Set<string>();
      let current: ResolvedBillingGroup = group;
      // The chain is finite: every hop is a DISTINCT group id (a repeated id
      // is a cycle and blocks below), and the fallback FK graph is finite.
      for (;;) {
        if (visited.has(current.id)) {
          // A cyclic fallback chain is control-plane drift; it can never
          // resolve, so blocking (not rejecting) is the fail-closed shape.
          return {
            decision: blockRequestPreparation('capability_unavailable', 'billing group authority is unavailable'),
          };
        }
        visited.add(current.id);
        const claudeViolation =
          current.claudeCodeOnly && this.hasClaudeSubscriptionCandidate(input) && !this.claudeCodeClientPasses(input);
        const scopeViolation =
          current.supportedModelScopes !== null && !current.supportedModelScopes.includes(requestedModel as string);
        if (!claudeViolation && !scopeViolation) {
          return { decision: 'allow', billingGroupId: current.id };
        }
        if (current.fallbackGroupId === null) {
          return claudeViolation
            ? {
                decision: rejectRequestPreparation(
                  'account_denied',
                  'the request’s billing group admits only Claude Code clients on this provider',
                ),
              }
            : {
                decision: rejectRequestPreparation(
                  'route_denied',
                  'the request’s billing group does not admit the requested model',
                ),
              };
        }
        const next = await this.queryBillingGroup(BILLING_GROUP_BY_ID_SQL, [current.fallbackGroupId]);
        if (next === 'block') {
          return {
            decision: blockRequestPreparation('capability_unavailable', 'billing group authority is unavailable'),
          };
        }
        current = next;
      }
    } catch {
      return {
        decision: blockRequestPreparation('capability_unavailable', 'billing group authority is unavailable'),
      };
    }
  }

  private async queryBillingGroup(sql: string, values: readonly unknown[]): Promise<ResolvedBillingGroup | 'block'> {
    const result = await this.database.query<Row>(sql, values);
    if (result.rows.length !== 1) return 'block';
    const group = parseBillingGroupRow(result.rows[0]);
    return group === null ? 'block' : group;
  }

  /**
   * The claude subscription catalog identity (gateway/claude/catalog-identity.ts):
   * anthropic-claude / claude-subscription. Enforcement applies only when the
   * candidate domain actually is that supply.
   */
  private hasClaudeSubscriptionCandidate(input: ProviderAccountSchedulerInput): boolean {
    const candidates = (input as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) return false;
    return candidates.some(
      (candidate) =>
        isRecord(candidate) &&
        (candidate as { providerId?: unknown }).providerId === CLAUDE_PROVIDER_ID &&
        (candidate as { productId?: unknown }).productId === CLAUDE_PRODUCT_ID,
    );
  }

  /**
   * F2/R5: the pure validator over the trusted-boundary client evidence
   * (user agent, path, headers, parsed body — the RequestPreparationInput
   * audit/clientRequest surfaces). Absent or malformed evidence fails closed:
   * a claude_code_only group must never admit unverifiable traffic.
   */
  private claudeCodeClientPasses(input: ProviderAccountSchedulerInput): boolean {
    const evidence = (input as { claudeCodeClient?: unknown }).claudeCodeClient;
    if (!isRecord(evidence)) return false;
    const userAgent = evidence.userAgent;
    const path = evidence.path;
    const headers = evidence.headers;
    if (
      (userAgent !== undefined && userAgent !== null && typeof userAgent !== 'string') ||
      (path !== undefined && path !== null && typeof path !== 'string') ||
      !isRecord(headers)
    ) {
      return false;
    }
    return validateClaudeCodeClient({
      userAgent: userAgent === undefined ? null : (userAgent as string | null),
      path: path === undefined ? null : (path as string | null),
      headers: headers as Record<string, string>,
      body: evidence.body,
    }).valid;
  }

  /**
   * F2/R6b seam: the Redis slot pre-check in front of the PostgreSQL lease
   * snapshot inside the per-candidate concurrency port. 'saturated' denies
   * only this candidate (shaping); 'unavailable' fails OPEN to the PostgreSQL
   * authority; 'acquired' records the acquisition so non-selected candidates
   * are released after the selection. The fenced PG lease stays final.
   */
  private async concurrencyWithRedisSlotPreCheck(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly requestId: string;
  }): Promise<ProviderAccountSchedulerConcurrencyDecision> {
    const slots = this.redisSlots as RedisConcurrencySlots;
    const ownerScopeKey = input.candidate.supplyMode === 'byok' ? input.caller.tenantId : 'platform';
    let slot: Awaited<ReturnType<RedisConcurrencySlots['tryAcquire']>>;
    try {
      slot = await slots.tryAcquire({
        ownerScopeKey,
        accountId: input.candidate.accountId,
        requestId: input.requestId,
        maxSlots: this.redisSlotMaxSlots as number,
        windowMs: this.redisSlotWindowMs as number,
      });
    } catch {
      // A throwing client is a broken pre-check, never a broken admission:
      // fail open to the authoritative PostgreSQL lease snapshot.
      slot = { state: 'unavailable' };
    }
    if (slot.state === 'saturated') {
      return { decision: 'deny', reason: 'redis concurrency slot pre-check is saturated' };
    }
    if (slot.state === 'acquired') {
      const tracked = this.redisSlotAcquisitions.get(input.requestId);
      if (tracked) {
        tracked.accounts.add(input.candidate.accountId);
      } else {
        this.redisSlotAcquisitions.set(input.requestId, {
          ownerScopeKey,
          accounts: new Set([input.candidate.accountId]),
        });
      }
    }
    return postgresConcurrency(this.database, this.leaseConcurrencyLimit, input);
  }

  /** Releases every non-winning (or, on failure, every) slot acquired for a request. */
  private async settleRedisSlots(requestId: string, winnerAccountId: string | null): Promise<void> {
    if (this.redisSlots === undefined || requestId === '') return;
    const tracked = this.redisSlotAcquisitions.get(requestId);
    if (!tracked) return;
    this.redisSlotAcquisitions.delete(requestId);
    for (const accountId of tracked.accounts) {
      if (accountId === winnerAccountId) continue;
      await this.redisSlots.release({ ownerScopeKey: tracked.ownerScopeKey, accountId, requestId });
    }
  }

  /** Best-effort observability write; see SCHEDULER_SELECTION_AUDIT_SQL. */
  private async recordSelectionAudit(
    input: ProviderAccountSchedulerInput,
    trace: ProviderAccountSchedulerSelectionTrace,
  ): Promise<void> {
    const occurredAt = this.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) return;
    const action =
      trace.reasons.length > 0
        ? `${SCHEDULER_SELECTION_AUDIT_ACTION}:${trace.reasons.join('+')}`
        : SCHEDULER_SELECTION_AUDIT_ACTION;
    try {
      await this.database.query(SCHEDULER_SELECTION_AUDIT_SQL, [
        randomUUID(),
        input.caller.tenantId,
        action,
        input.attemptId === undefined ? 'saas_requests' : 'saas_attempts',
        input.attemptId === undefined ? input.requestId : input.attemptId,
        occurredAt.toISOString(),
        input.requestId,
      ]);
    } catch {
      // Observability only: the selection decision stands.
    }
  }

  bindAffinity(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision> {
    return this.scheduler.bindAffinity(input);
  }
}
