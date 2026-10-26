import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../db/types.js';
import { canonicalizeIpPolicy } from '../../keys/ip-policy.js';
import { SaasPricingService } from '../../pricing/service.js';
import { PostgresProviderSupplyRepository } from '../../supply/repository.js';
import type { ProviderAccountReference, ProviderCredentialReference } from '../../supply/types.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../authorization-prelock.js';
import type {
  RequestPreparationAuthorityPort,
  RequestPreparationCallerPort,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlementPort,
} from '../request-preparation-service.js';
import type {
  FastGatewayCandidate,
  FastGatewaySnapshot,
  FastGatewaySnapshotInput,
  FastGatewaySnapshotProvider,
} from './snapshots.js';
import { FastGatewaySnapshotError } from './snapshots.js';

type Row = Record<string, unknown>;

export type FastGatewaySnapshotUnsupportedReason =
  | 'operation'
  | 'group_controls'
  | 'key_budget'
  | 'route_protocol'
  | 'candidate_count'
  | 'group_account_pool'
  | 'account_cooldown'
  | 'account_controls'
  | 'account_transport'
  | 'account_quota'
  | 'account_credentials'
  | 'runtime_health'
  | 'candidate_unavailable';

export interface PostgresFastGatewaySnapshotLoaderOptions {
  readonly database: SaasDatabase;
  /** Pure caller adapter; it must not perform independent database reads. */
  readonly caller: RequestPreparationCallerPort;
  /** Must honor the supplied executor (the standard cached decorator does). */
  readonly entitlement: RequestPreparationEntitlementPort;
  /** Build the native authority adapter against this read-only, transaction-bound database. */
  readonly createAuthority: (database: SaasDatabase) => RequestPreparationAuthorityPort;
  readonly maxBodyBytes: number;
  readonly accountMaxConcurrency: number;
  readonly ttlMs?: number;
  readonly coldTimeoutMs?: number;
  readonly maxCandidates?: number;
  readonly monotonicNow?: () => number;
  /** Fixed reason labels only; observer failure cannot change authorization. */
  readonly observeUnsupported?: (reason: FastGatewaySnapshotUnsupportedReason) => void;
}

/** Safe errors deliberately contain no SQL, parameters, envelopes, or underlying error causes. */
export class PostgresFastGatewaySnapshotError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'TIMEOUT' | 'INVALID_OPTIONS') {
    super(`Fast gateway snapshot ${code.toLowerCase()}`);
    this.name = 'PostgresFastGatewaySnapshotError';
  }
}

class UnsupportedSnapshot extends Error {
  constructor(readonly reason: FastGatewaySnapshotUnsupportedReason) {
    super('Unsupported fast snapshot');
  }
}
function unsupported(reason: FastGatewaySnapshotUnsupportedReason = 'candidate_unavailable'): never {
  throw new UnsupportedSnapshot(reason);
}
function unavailable(): never {
  throw new PostgresFastGatewaySnapshotError('UNAVAILABLE');
}
function denied(): never {
  throw new FastGatewaySnapshotError('SNAPSHOT_DENIED');
}
function record(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Row;
}
function one(value: readonly Row[]): Row {
  if (value.length !== 1) unavailable();
  return record(value[0]);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || value.includes('\0')) unavailable();
  return value;
}
function positive(value: unknown): number {
  const result =
    typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result <= 0) unavailable();
  return result;
}
function nullableLimit(value: unknown): number | null {
  return value === null ? null : positive(value);
}
function timestamp(value: unknown): number {
  const result = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(result)) unavailable();
  return result;
}
function sameVersion(left: unknown, right: unknown): boolean {
  try {
    return BigInt(String(left)) > 0n && BigInt(String(left)) === BigInt(String(right));
  } catch {
    return false;
  }
}

/**
 * The native adapters already select and validate validity windows. Observe
 * those ORIGINAL rows before their public DTOs discard expiry columns. This
 * is conservative: an unselected expiring row can shorten the cache window,
 * never extend it. The outer cache must not reset this absolute deadline.
 */
function collectExpiries(value: unknown, expiries: Set<number>, depth = 0): void {
  if (depth > 12) unavailable();
  if (Array.isArray(value)) {
    for (const item of value) collectExpiries(item, expiries, depth + 1);
  } else if (value !== null && typeof value === 'object' && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (
        /(?:^|_)(?:expires_at|valid_until|ends_at)$/.test(key) ||
        /(?:ExpiresAt|expiresAt|validUntil|endsAt)$/.test(key)
      ) {
        if (item !== null && item !== undefined) expiries.add(timestamp(item));
      } else if (item !== null && typeof item === 'object') collectExpiries(item, expiries, depth + 1);
    }
  }
}

const POLICY_SQL = `/* fast-snapshot:policy */
SELECT t.status AS tenant_status, t.requests_per_minute AS tenant_rpm,
       t.tokens_per_minute AS tenant_tpm, t.max_concurrent_requests AS tenant_concurrency,
       p.inference_policy_status AS project_status, p.inference_policy_version AS project_version,
       v.status AS policy_status, v.requests_per_minute AS project_rpm,
       v.tokens_per_minute AS project_tpm, v.max_concurrent_requests AS project_concurrency,
       k.status AS key_status, k.authz_version AS key_version, k.expires_at AS key_expires_at,
       k.requests_per_minute AS key_rpm, k.tokens_per_minute AS key_tpm,
       k.max_concurrent_requests AS key_concurrency,
       ip.mode AS ip_mode, ip.rules AS ip_rules,
       b.token_daily, b.token_lifetime, b.charge_daily, b.charge_lifetime,
       EXISTS(SELECT 1 FROM saas_billing_spending_freezes f WHERE f.tenant_id = t.id) AS spending_frozen,
       to_jsonb(g) AS billing_group,
       (SELECT COALESCE(jsonb_agg(gp.account_id ORDER BY gp.account_id), '[]'::jsonb)
          FROM saas_billing_group_account_pools gp WHERE gp.group_id = g.id) AS group_accounts
  FROM saas_tenants t
  JOIN saas_projects p ON p.tenant_id = t.id
  JOIN saas_project_inference_policy_versions v
    ON v.tenant_id = p.tenant_id AND v.project_id = p.id AND v.version = p.inference_policy_version
  JOIN saas_api_keys k ON k.tenant_id = p.tenant_id AND k.project_id = p.id AND k.id = $3
  LEFT JOIN saas_api_key_ip_policies ip ON ip.tenant_id = k.tenant_id AND ip.project_id = k.project_id AND ip.key_id = k.id
  LEFT JOIN saas_api_key_budget_policies b ON b.tenant_id = k.tenant_id AND b.project_id = k.project_id AND b.key_id = k.id
  JOIN saas_billing_groups g ON g.id = COALESCE(k.billing_group_id, t.default_billing_group_id, 'default')
 WHERE t.id = $1 AND p.id = $2 LIMIT 2`;

function supportedGroup(group: Row, publicModel: string): void {
  if (group.status !== 'active') denied();
  // This first native slice intentionally does not reinterpret group financial
  // or provider-special controls. The caller may use strict mode BEFORE intent.
  if (
    !sameVersion(group.rate_multiplier_num, group.rate_multiplier_den) ||
    group.peak_enabled !== false ||
    group.model_pricing !== null ||
    group.daily_limit_minor_units !== null ||
    group.weekly_limit_minor_units !== null ||
    group.monthly_limit_minor_units !== null ||
    group.profit_min_margin_num !== null ||
    group.profit_min_margin_den !== null ||
    group.profit_safety_buffer_num !== null ||
    group.profit_safety_buffer_den !== null ||
    group.claude_code_only !== false ||
    group.fallback_group_id !== null ||
    group.composite !== false
  )
    unsupported('group_controls');
  if (group.supported_model_scopes !== null) {
    if (!Array.isArray(group.supported_model_scopes) || !group.supported_model_scopes.includes(publicModel)) denied();
  }
}

function candidateReference(candidate: RequestPreparationCandidateAuthority): ProviderCredentialReference {
  return {
    ownerKind: candidate.accountOwnerKind,
    tenantId: candidate.supplyMode === 'byok' ? candidate.tenantId : null,
    accountId: candidate.accountId,
    credentialId: candidate.credentialId,
    version: positive(candidate.credentialVersion),
  };
}

function accountRuntimeSql(owner: 'tenant' | 'platform'): string {
  const table = owner === 'tenant' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
  return `/* fast-snapshot:account-runtime */
SELECT to_jsonb(a) AS account,
       (SELECT to_jsonb(h) FROM saas_provider_account_runtime_health h
         WHERE h.owner_scope_key = $3 AND h.account_id = a.id) AS health,
       EXISTS(SELECT 1 FROM saas_provider_account_model_cooldowns c
         WHERE c.owner_scope_key = $3 AND c.account_id = a.id AND c.model = $4 AND c.cooled_until > $5) AS model_cooling
  FROM ${table} a WHERE a.id = $1 ${owner === 'tenant' ? 'AND a.tenant_id = $2' : 'AND $2::uuid IS NULL'} LIMIT 2`;
}

function supportedRuntime(row: Row, now: number): { rpm: number | null; tpm: number | null } {
  const account = record(row.account);
  if (row.model_cooling !== false) unsupported('account_cooldown');
  for (const key of [
    'probe_temp_unschedulable_until',
    'scheduling_threshold_pause_until',
    'grok_rate_limited_until',
    'kimi_rate_limited_until',
  ]) {
    if (account[key] != null && timestamp(account[key]) > now) unsupported('account_cooldown');
  }
  for (const key of [
    'auto_pause_5h_threshold',
    'auto_pause_7d_threshold',
    'window_cost_limit_minor_units',
    'window_cost_sticky_reserve_minor_units',
    'egress_proxy_id',
    'tls_fingerprint_profile_id',
  ]) {
    if (account[key] != null)
      unsupported(
        key === 'egress_proxy_id' || key === 'tls_fingerprint_profile_id' ? 'account_transport' : 'account_controls',
      );
  }
  if (account.quota_state !== null && !['unknown', 'ok', 'low'].includes(String(account.quota_state)))
    unsupported('account_quota');
  // OAuth/subscription accounts need their protocol-specific refresh and
  // scheduling semantics. This first slice is deliberately API-key only.
  if (account.credential_type !== 'api-key') unsupported('account_credentials');
  if (row.health !== null) {
    const health = record(row.health);
    if (!['healthy', 'degraded'].includes(String(health.state))) unsupported('runtime_health');
    if (health.cooldown_until !== null && timestamp(health.cooldown_until) > now) unsupported('runtime_health');
    // A retained historical probe timestamp is not an active probe lease once
    // state is healthy/degraded. New fast outcomes are owned by Redis.
  }
  // Verified active accounts without history are neutral, not unhealthy.
  // Requiring a PG success row here would recreate a legacy-write prerequisite.
  return { rpm: nullableLimit(account.rpm_limit), tpm: nullableLimit(account.tpm_limit) };
}

/**
 * Native cold path ONLY. Every source read, sealed envelope and pinned price
 * is bound to one READ ONLY REPEATABLE READ transaction. No request/attempt,
 * dispatch proof, financial registration, wallet claim or mutation runs here.
 */
export function createPostgresFastGatewaySnapshotLoader(
  options: PostgresFastGatewaySnapshotLoaderOptions,
): FastGatewaySnapshotProvider {
  const ttlMs = options.ttlMs ?? 5000;
  const coldTimeoutMs = options.coldTimeoutMs ?? 2000;
  const maxCandidates = options.maxCandidates ?? 64;
  for (const [value, max] of [
    [ttlMs, 5000],
    [coldTimeoutMs, 30_000],
    [maxCandidates, 256],
    [options.maxBodyBytes, 64 * 1024 * 1024],
    [options.accountMaxConcurrency, 100_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new PostgresFastGatewaySnapshotError('INVALID_OPTIONS');
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const observeUnsupported = (reason: FastGatewaySnapshotUnsupportedReason) => {
    try {
      options.observeUnsupported?.(reason);
    } catch {
      /* diagnostics never grant or deny */
    }
  };
  return {
    async resolve(input: FastGatewaySnapshotInput) {
      if (input.protocol !== 'openai' || input.clientOperation !== 'chat.completions') {
        observeUnsupported('operation');
        return null;
      }
      const started = monotonicNow();
      const expiries = new Set<number>();
      let queries = 0;
      const check = () => {
        if (monotonicNow() - started >= coldTimeoutMs) throw new PostgresFastGatewaySnapshotError('TIMEOUT');
      };
      try {
        return await options.database.transaction(async (raw) => {
          check();
          await raw.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const scoped: SqlExecutor = {
            async query<T>(sql: string, values?: readonly unknown[]): Promise<SqlResult<T>> {
              check();
              if (sql.trim() === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') return { rows: [], rowCount: 0 };
              if (++queries > 2048) unavailable();
              // Bounds each blocked query by the REMAINING total load budget;
              // no blocked source statement can outlive the remaining load budget.
              await raw.query(
                "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
                [`${Math.max(1, Math.floor(coldTimeoutMs - (monotonicNow() - started)))}ms`],
              );
              const result = await raw.query<T>(sql, values);
              check();
              collectExpiries(result.rows, expiries);
              return result;
            },
          };
          const forbidden = async (): Promise<never> => unavailable();
          const database: SaasDatabase = {
            query: scoped.query,
            transaction: async (work) => work(scoped),
            migrate: forbidden,
            verifySchema: forbidden,
            ping: forbidden,
            close: forbidden,
          };
          // BEGIN time precedes the first RR snapshot (including the timeout
          // configuration SELECT); a later wall-clock read would renew its age.
          const clock = one(
            (await scoped.query<Row>('/* fast-snapshot:clock */ SELECT transaction_timestamp() AS observed_at')).rows,
          );
          const observedAtMs = timestamp(clock.observed_at);
          const validation = await options.caller.validate(input);
          if (validation.decision === 'block') unavailable();
          if (validation.decision !== 'allow') denied();
          const caller = validation.value;
          const entitlementDecision = await options.entitlement.resolve(
            { caller, publicModel: input.publicModel, protocol: input.protocol },
            { executor: scoped, now: new Date(observedAtMs) },
          );
          if (entitlementDecision.decision === 'block') unavailable();
          if (entitlementDecision.decision !== 'allow') denied();
          const entitlement = entitlementDecision.value;
          await new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock({
            executor: scoped,
            request: {
              ...caller,
              publicModel: input.publicModel,
              projectPolicyVersion: entitlement.projectPolicyVersion,
            },
            authenticatedKey: input.authenticatedCaller,
          });
          const policy = one(
            (await scoped.query<Row>(POLICY_SQL, [caller.tenantId, caller.projectId, caller.proxyKeyId])).rows,
          );
          if (
            policy.tenant_status !== 'active' ||
            policy.project_status !== 'active' ||
            policy.policy_status !== 'active' ||
            policy.key_status !== 'active' ||
            !sameVersion(policy.key_version, caller.authzVersion) ||
            !sameVersion(policy.project_version, entitlement.projectPolicyVersion)
          )
            denied();
          if (
            [policy.token_daily, policy.token_lifetime, policy.charge_daily, policy.charge_lifetime].some(
              (value) => value !== null,
            )
          )
            unsupported('key_budget');
          if (typeof policy.spending_frozen !== 'boolean') unavailable();
          if (caller.supplyMode === 'platform' && policy.spending_frozen) denied();
          const group = record(policy.billing_group);
          supportedGroup(group, input.publicModel);
          const ipPolicy = canonicalizeIpPolicy(
            policy.ip_mode === null && policy.ip_rules === null
              ? { mode: 'disabled', rules: [] }
              : { mode: policy.ip_mode, rules: policy.ip_rules },
          );
          if (ipPolicy.mode === 'disabled' && ipPolicy.rules.length !== 0) unavailable();
          const authorityDecision = await options.createAuthority(database).resolve({
            caller,
            entitlement,
            publicModel: input.publicModel,
            protocol: input.protocol,
            clientOperation: input.clientOperation,
          });
          if (authorityDecision.decision === 'block') unavailable();
          if (authorityDecision.decision !== 'allow') denied();
          const authority = authorityDecision.value;
          if (
            authority.composite !== undefined ||
            (authority.route.providerProtocol ?? authority.route.protocol) !== 'openai' ||
            (authority.route.providerOperation ?? 'chat.completions') !== 'chat.completions'
          )
            unsupported('route_protocol');
          const allCandidates = authority.candidates ?? [authority.candidate];
          if (allCandidates.length < 1 || allCandidates.length > maxCandidates) unsupported('candidate_count');
          if (!Array.isArray(policy.group_accounts) || !policy.group_accounts.every((id) => typeof id === 'string'))
            unavailable();
          const groupAccounts = new Set(policy.group_accounts as string[]);
          const repository = new PostgresProviderSupplyRepository(database, scoped, true);
          const prices = new SaasPricingService(database, { now: () => new Date(observedAtMs) });
          const customerPrice =
            authority.commercial.customerPriceVersion === null
              ? null
              : await prices.getCustomerPriceVersion(authority.commercial.customerPriceVersion);
          const candidates: FastGatewayCandidate[] = [];
          let emptyReason: FastGatewaySnapshotUnsupportedReason = 'group_account_pool';
          for (const candidate of allCandidates) {
            check();
            if (
              candidate.supplyMode === 'platform' &&
              groupAccounts.size > 0 &&
              !groupAccounts.has(candidate.accountId)
            )
              continue;
            const reference = candidateReference(candidate);
            const account = await repository.getAccount(reference as ProviderAccountReference);
            const credential = await repository.getCredential(reference);
            const version = await repository.getCredentialVersionEnvelope({
              ...reference,
              version: positive(candidate.credentialVersion),
            });
            if (!account || !credential || !version) unsupported();
            if (
              account.status !== 'active' ||
              account.validationState !== 'verified' ||
              credential.status !== 'active' ||
              credential.validationState !== 'verified' ||
              version.status !== 'active' ||
              !sameVersion(account.authzVersion, candidate.accountAuthzVersion) ||
              !sameVersion(credential.authzVersion, candidate.credentialAuthzVersion) ||
              !sameVersion(credential.currentVersion, candidate.credentialVersion)
            )
              unsupported();
            if (
              account.id !== candidate.accountId ||
              credential.accountId !== candidate.accountId ||
              credential.id !== candidate.credentialId ||
              version.accountId !== candidate.accountId ||
              version.credentialId !== candidate.credentialId ||
              account.providerId !== candidate.providerId ||
              account.productId !== candidate.productId ||
              credential.providerId !== candidate.providerId ||
              credential.productId !== candidate.productId
            )
              unavailable();
            const runtime = one(
              (
                await scoped.query<Row>(accountRuntimeSql(reference.ownerKind), [
                  reference.accountId,
                  reference.tenantId,
                  reference.tenantId ?? 'platform',
                  candidate.resolvedModel,
                  new Date(observedAtMs),
                ])
              ).rows,
            );
            let limits: { rpm: number | null; tpm: number | null };
            try {
              limits = supportedRuntime(runtime, observedAtMs);
            } catch (error) {
              if (error instanceof UnsupportedSnapshot) {
                emptyReason = error.reason;
                continue;
              }
              throw error;
            }
            const supplierCost =
              candidate.supplierCostVersion === null
                ? null
                : await prices.getSupplierCostVersion(candidate.supplierCostVersion);
            if (
              candidate.supplyMode === 'platform'
                ? customerPrice === null || supplierCost === null
                : customerPrice !== null || supplierCost !== null
            )
              unavailable();
            candidates.push({
              authority: candidate,
              credential: {
                account: {
                  ownerKind: account.ownerKind,
                  tenantId: account.tenantId,
                  supplyMode: account.supplyMode,
                  id: account.id,
                  providerId: account.providerId,
                  productId: account.productId,
                  credentialType: account.credentialType,
                  purpose: account.purpose,
                },
                credential: {
                  ownerKind: credential.ownerKind,
                  tenantId: credential.tenantId,
                  supplyMode: credential.supplyMode,
                  id: credential.id,
                  accountId: credential.accountId,
                  providerId: credential.providerId,
                  productId: credential.productId,
                },
                version,
              },
              customerPrice,
              supplierCost,
              limits: { ...limits, concurrency: options.accountMaxConcurrency },
            });
          }
          const firstCandidate = candidates[0];
          if (firstCandidate === undefined) unsupported(emptyReason);
          const validUntilMs = Math.min(observedAtMs + ttlMs, ...expiries);
          if (validUntilMs <= observedAtMs || monotonicNow() - started >= validUntilMs - observedAtMs) denied();
          const limits = {
            tenant: {
              rpm: positive(policy.tenant_rpm),
              tpm: positive(policy.tenant_tpm),
              concurrency: positive(policy.tenant_concurrency),
            },
            project: {
              rpm: positive(policy.project_rpm),
              tpm: positive(policy.project_tpm),
              concurrency: positive(policy.project_concurrency),
            },
            key: {
              rpm: positive(policy.key_rpm),
              tpm: positive(policy.key_tpm),
              concurrency: positive(policy.key_concurrency),
            },
            group: { id: text(group.id), rpm: group.rpm_limit === null ? null : Number(group.rpm_limit) },
          };
          if (limits.group.rpm !== null && (!Number.isSafeInteger(limits.group.rpm) || limits.group.rpm < 0))
            unavailable();
          const snapshot: Omit<FastGatewaySnapshot, 'revision'> = {
            caller,
            entitlement,
            authority: {
              ...authority,
              candidate: firstCandidate.authority,
              candidates: candidates.map((item) => item.authority),
            },
            candidates,
            observedAtMs,
            validUntilMs,
            policy: {
              keyStatus: 'active',
              tenantStatus: 'active',
              projectStatus: 'active',
              principalStatus: 'active',
              groupStatus: 'active',
              spendingFrozen: policy.spending_frozen,
              ipPolicy,
              maxBodyBytes: options.maxBodyBytes,
              absoluteExpiryMs: [...expiries],
            },
            limits,
          } as const;
          const revision = createHash('sha256')
            .update(
              JSON.stringify(snapshot, (_key, value: unknown) =>
                typeof value === 'bigint' ? value.toString() : value,
              ),
            )
            .digest('hex');
          return { ...snapshot, revision };
        });
      } catch (error) {
        if (error instanceof UnsupportedSnapshot) {
          observeUnsupported(error.reason);
          return null;
        }
        if (error instanceof PostgresFastGatewaySnapshotError || error instanceof FastGatewaySnapshotError) throw error;
        // Security denials also stay fail-closed. The strict gateway may decide
        // how to map a null eligibility result, but storage faults are not null.
        if (
          error instanceof Error &&
          error.name === 'SaasAdmissionAuthorizationError' &&
          'code' in error &&
          error.code === 'authorization_denied'
        )
          denied();
        throw new PostgresFastGatewaySnapshotError('UNAVAILABLE');
      }
    },
  };
}
