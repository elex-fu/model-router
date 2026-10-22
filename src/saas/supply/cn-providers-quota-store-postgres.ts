/**
 * Batch 3 CN-provider quota-snapshot Postgres store (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三; migration 120;
 * sub2api reference: backend/internal/service/cn_provider_quota_service.go).
 * Implements the CnQuotaStore contract the quota worker depends on,
 * following the opencode-go usage store's Postgres access patterns exactly
 * (owner-scoped account tables, SKIP LOCKED claim whose attempt stamp is the
 * lease, verified-current credential resolution, KMS decrypt-only unsealing).
 *
 * The existing account snapshot authority is shared by all three providers:
 * - the due scan covers zhipu, minimax, and Kimi Coding in one claim round,
 *   filtered on provider_id + credential_type 'api-key' + the provider's
 *   account_mode column = 'coding' (payg accounts have no rolling-window
 *   quota endpoint and are never claimed);
 * - every scheduling column is prefixed per provider ({zhipu_,minimax_}), so
 *   the SQL is composed from a whitelisted column prefix, never from
 *   caller-supplied strings;
 * - no fixed product binding: zhipu has two products (payg + coding), and
 *   the account's product choice carries the inference-host distinction. Kimi
 *   Coding is selected by the catalog products, without a redundant mode flag.
 *
 * The snapshot is a scheduling signal only; it never enters the billing path
 * (093/099/108 quota-snapshot precedent). A failed attempt advances the
 * horizon and attempt stamp while preserving the successful observation stamp
 * and last observed windows: a
 * transient upstream failure must not erase real scheduling state.
 */

import {
  createProviderCredentialContext,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialUnsealingKms,
  withUnsealedProviderCredential,
} from '../credentials/provider-crypto.js';
import type { SaasDatabase } from '../db/index.js';
import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from '../gateway/cn-providers/catalog-identity.js';
import { KIMI_CODING_PRODUCT_IDS, KIMI_CODING_PROVIDER_ID } from '../gateway/cn-providers/quota.js';
import type { ProviderHttpEgressAllowlist } from '../gateway/provider-http-address.js';
import {
  type AccountOutboundConnectionFactory,
  type AccountOutboundFetch,
  withAccountOutbound,
} from './account-outbound.js';
import type {
  CnQuotaAccountRef,
  CnQuotaFailure,
  CnQuotaFetch,
  CnQuotaSnapshot,
  CnQuotaStore,
} from './cn-providers-quota-worker.js';

export class CnProvidersQuotaStoreError extends Error {
  readonly code = 'CN_QUOTA_STORE_UNAVAILABLE' as const;

  constructor() {
    super('CN provider quota store is unavailable');
    this.name = 'CnProvidersQuotaStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function storeUnavailable(): never {
  throw new CnProvidersQuotaStoreError();
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    storeUnavailable();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) storeUnavailable();
  return result;
}

function positiveBound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min) return min;
  return Math.min(value, max);
}

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) storeUnavailable();
  return new Date(value).toISOString();
}

function nullableIsoTimestamp(value: number | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

function nullablePercent(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) storeUnavailable();
  return value;
}

interface CnQuotaOwnerScope {
  readonly ownerKind: 'tenant' | 'platform';
  readonly accounts: string;
  readonly credentials: string;
  readonly versions: string;
  readonly wrappings: string;
}

const TENANT_OWNER_SCOPE: CnQuotaOwnerScope = Object.freeze({
  ownerKind: 'tenant',
  accounts: 'saas_tenant_provider_accounts',
  credentials: 'saas_tenant_provider_credentials',
  versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
});
const PLATFORM_OWNER_SCOPE: CnQuotaOwnerScope = Object.freeze({
  ownerKind: 'platform',
  accounts: 'saas_platform_provider_accounts',
  credentials: 'saas_platform_provider_credentials',
  versions: 'saas_platform_provider_credential_versions',
  wrappings: 'saas_platform_provider_credential_wrappings',
});
const CN_QUOTA_OWNER_SCOPES: readonly CnQuotaOwnerScope[] = Object.freeze([TENANT_OWNER_SCOPE, PLATFORM_OWNER_SCOPE]);

/** Provider ids the due scan claims for (compile-time constant). */
const CN_QUOTA_PROVIDER_IDS_COLUMN: readonly string[] = Object.freeze([
  ZHIPU_PROVIDER_ID,
  MINIMAX_PROVIDER_ID,
  KIMI_CODING_PROVIDER_ID,
]);

function scopeFor(ownerKind: string): CnQuotaOwnerScope {
  if (ownerKind === 'tenant') return TENANT_OWNER_SCOPE;
  if (ownerKind === 'platform') return PLATFORM_OWNER_SCOPE;
  storeUnavailable();
}

/** Compile-time whitelist; no caller text enters a SQL identifier. */
function columnPrefixFor(providerId: string): 'zhipu_' | 'minimax_' | 'kimi_' {
  if (providerId === ZHIPU_PROVIDER_ID) return 'zhipu_';
  if (providerId === MINIMAX_PROVIDER_ID) return 'minimax_';
  if (providerId === KIMI_CODING_PROVIDER_ID) return 'kimi_';
  storeUnavailable();
}

/** Kimi's catalog product fixes the subscription plan; no redundant mode flag. */
function codingAccountPredicate(providerId: string, alias: string): string {
  if (providerId === KIMI_CODING_PROVIDER_ID) {
    return `${alias}.product_id IN ('kimi-code', 'kimi-code-global')`;
  }
  return `${alias}.${columnPrefixFor(providerId)}account_mode = 'coding'`;
}

function accountPredicate(account: CnQuotaAccountRef, next: number): { sql: string; values: unknown[] } {
  if (account.ownerKind === 'tenant') {
    if (typeof account.tenantId !== 'string' || account.tenantId.length === 0) storeUnavailable();
    return { sql: `tenant_id = $${next} AND id = $${next + 1}`, values: [account.tenantId, account.accountId] };
  }
  if (account.tenantId !== null) storeUnavailable();
  return { sql: `id = $${next}`, values: [account.accountId] };
}

interface ClaimedAccountRow {
  tenant_id?: string;
  id: string;
  provider_id: string;
  product_id?: string;
  usage_failure_count?: number | string | null;
}

interface AccountBindingRow {
  tenant_id?: string;
  id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  purpose: string;
}

interface CurrentCredentialRow {
  id: string;
  current_version: number | string | null;
}

interface LockedVersionRow {
  version: number | string;
  schema_version: number | string;
  context_version: number | string;
  algorithm: string;
  kms_purpose: string;
  kms_key_id: string;
  wrapped_dek: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

export interface PostgresCnProvidersQuotaStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  readonly createEgressConnection?: AccountOutboundConnectionFactory;
}

/**
 * Postgres implementation of the quota worker's store contract against the
 * migration-120 scheduling columns. The plaintext credential exists only
 * inside the unseal callback (quota-sync/opencode-go precedent); no method
 * logs or returns provider or credential data.
 */
export class PostgresCnProvidersQuotaStore implements CnQuotaStore {
  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: PostgresCnProvidersQuotaStoreOptions,
  ) {
    if (!options || typeof options !== 'object') storeUnavailable();
    safeText(options.deployment);
    safeText(options.environment);
  }

  private async query<Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.database.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof CnProvidersQuotaStoreError) throw error;
      storeUnavailable();
    }
  }

  async readDueAccounts(input: {
    readonly nowMs: number;
    readonly debounceMs: number;
    readonly intervalMs: number;
    readonly limit: number;
  }): Promise<readonly CnQuotaAccountRef[]> {
    if (!input || typeof input !== 'object') storeUnavailable();
    const now = isoTimestamp(input.nowMs);
    const debounceCutoff = isoTimestamp(input.nowMs - positiveBound(input.debounceMs, 1, 86_400_000));
    positiveBound(input.intervalMs, 1, 86_400_000);
    let remaining = positiveBound(input.limit, 1, 1_000);
    const claimed: CnQuotaAccountRef[] = [];
    for (const scope of CN_QUOTA_OWNER_SCOPES) {
      if (remaining < 1) break;
      for (const providerId of CN_QUOTA_PROVIDER_IDS_COLUMN) {
        if (remaining < 1) break;
        const prefix = columnPrefixFor(providerId);
        // The due predicate is provider-scoped: only coding-mode accounts of
        // this provider with a due horizon, past the debounce floor, outside
        // the rate-limited cooldown, in active/verified state.
        const duePredicate = `
            AND claim.status = 'active' AND claim.validation_state = 'verified'
            AND claim.provider_id = $1 AND claim.credential_type = 'api-key'
            AND ${codingAccountPredicate(providerId, 'claim')}
            AND (claim.${prefix}usage_next_due_at IS NULL
              OR claim.${prefix}usage_next_due_at <= $2::timestamptz)
            AND (claim.${prefix}usage_attempted_at IS NULL
              OR claim.${prefix}usage_attempted_at <= $3::timestamptz)
            AND (claim.${prefix}rate_limited_until IS NULL
              OR claim.${prefix}rate_limited_until <= $2::timestamptz)`;
        const claimTarget = scope.ownerKind === 'tenant' ? '(account.tenant_id, account.id)' : 'account.id';
        const claimSource = scope.ownerKind === 'tenant' ? 'claim.tenant_id, claim.id' : 'claim.id';
        const returning =
          scope.ownerKind === 'tenant'
            ? 'account.tenant_id, account.id, account.provider_id, account.product_id'
            : 'account.id, account.provider_id, account.product_id';
        const rows = await this.query<ClaimedAccountRow>(
          `UPDATE ${scope.accounts} AS account
             SET ${prefix}usage_attempted_at = $2::timestamptz, updated_at = clock_timestamp()
           WHERE ${claimTarget} IN (
                 SELECT ${claimSource}
                   FROM ${scope.accounts} AS claim
                  WHERE TRUE${duePredicate}
                  ORDER BY claim.${prefix}usage_next_due_at ASC NULLS FIRST, claim.id
                  LIMIT $4::int
                  FOR UPDATE SKIP LOCKED)
           RETURNING ${returning}, account.${prefix}usage_failure_count AS usage_failure_count`,
          [providerId, now, debounceCutoff, remaining],
        );
        for (const row of rows) {
          claimed.push(
            Object.freeze({
              ownerKind: scope.ownerKind,
              tenantId: scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null,
              accountId: safeText(row.id),
              providerId: safeText(row.provider_id),
              ...(row.provider_id === KIMI_CODING_PROVIDER_ID ? { productId: safeText(row.product_id) } : {}),
              ...(row.usage_failure_count === undefined
                ? {}
                : { failureCount: nonNegativeInteger(row.usage_failure_count ?? 0) }),
            }),
          );
        }
        remaining -= rows.length;
      }
    }
    return Object.freeze(claimed);
  }

  /**
   * Resolves the account's current binding (claim metadata is re-read, never
   * trusted from the caller), then unseals the current verified credential
   * through the KMS decrypt-only seam and invokes the callback. Resolves
   * null when no verified credential is available; the callback's result
   * (and errors) pass through unchanged.
   */
  async withUnsealedApiKey<T>(
    account: CnQuotaAccountRef,
    callback: (secret: Buffer, fetcher?: CnQuotaFetch) => Promise<T>,
    fetcher?: CnQuotaFetch,
  ): Promise<T | null> {
    if (!account || typeof account !== 'object' || typeof callback !== 'function') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    columnPrefixFor(account.providerId);
    const predicate = accountPredicate(account, 1);
    const tenantColumn = scope.ownerKind === 'tenant' ? 'account.tenant_id, ' : '';
    const rows = await this.query<AccountBindingRow>(
      `SELECT ${tenantColumn}account.id, account.provider_id, account.product_id,
              account.credential_type, account.purpose
         FROM ${scope.accounts} AS account
        WHERE account.status = 'active' AND account.validation_state = 'verified'
          AND account.provider_id = $${predicate.values.length + 1}
          AND account.credential_type = 'api-key'
          AND ${codingAccountPredicate(account.providerId, 'account')}
          AND ${predicate.sql}
        LIMIT 1`,
      [...predicate.values, account.providerId],
    );
    const row = rows[0];
    if (!row) return null;
    const providerId = safeText(row.provider_id);
    const productId = safeText(row.product_id);
    if (providerId === KIMI_CODING_PROVIDER_ID && !KIMI_CODING_PRODUCT_IDS.includes(productId)) return null;
    const credentialType = safeText(row.credential_type);
    const purpose = safeText(row.purpose);
    const accountId = safeText(row.id);
    const tenantId = scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null;

    const credentials = await this.query<CurrentCredentialRow>(
      scope.ownerKind === 'tenant'
        ? `SELECT credential.id, credential.current_version
             FROM ${scope.credentials} AS credential
            WHERE credential.tenant_id = $1 AND credential.account_id = $2
              AND credential.provider_id = $3 AND credential.product_id = $4
              AND credential.credential_type = $5
              AND credential.status = 'active' AND credential.validation_state = 'verified'
              AND credential.current_version IS NOT NULL
              AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            ORDER BY credential.id
            LIMIT 1`
        : `SELECT credential.id, credential.current_version
             FROM ${scope.credentials} AS credential
            WHERE credential.account_id = $1
              AND credential.provider_id = $2 AND credential.product_id = $3
              AND credential.credential_type = $4
              AND credential.status = 'active' AND credential.validation_state = 'verified'
              AND credential.current_version IS NOT NULL
              AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            ORDER BY credential.id
            LIMIT 1`,
      scope.ownerKind === 'tenant'
        ? [tenantId, accountId, providerId, productId, credentialType]
        : [accountId, providerId, productId, credentialType],
    );
    const credential = credentials[0];
    if (!credential) return null;
    const credentialId = safeText(credential.id);
    const credentialVersion = nonNegativeInteger(credential.current_version);
    if (credentialVersion < 1) return null;

    const versions = await this.query<LockedVersionRow>(
      scope.ownerKind === 'tenant'
        ? `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${scope.versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${scope.wrappings}
                WHERE tenant_id = version_row.tenant_id AND account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.tenant_id = $1 AND version_row.account_id = $2
              AND version_row.credential_id = $3 AND version_row.version = $4
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`
        : `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag
             FROM ${scope.versions} AS version_row
             LEFT JOIN LATERAL (
               SELECT kms_key_id, wrapped_dek
                 FROM ${scope.wrappings}
                WHERE account_id = version_row.account_id
                  AND credential_id = version_row.credential_id
                  AND credential_version = version_row.version
                ORDER BY wrapping_revision DESC
                LIMIT 1
             ) AS wrapping ON TRUE
            WHERE version_row.account_id = $1
              AND version_row.credential_id = $2 AND version_row.version = $3
              AND version_row.status = 'active'
              AND (version_row.expires_at IS NULL OR version_row.expires_at > clock_timestamp())`,
      scope.ownerKind === 'tenant'
        ? [tenantId, accountId, credentialId, credentialVersion]
        : [accountId, credentialId, credentialVersion],
    );
    const version = versions[0];
    if (!version || version.kms_purpose !== purpose) return null;
    if (
      nonNegativeInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      nonNegativeInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return null;
    }

    const context: ProviderCredentialContext = createProviderCredentialContext(
      scope.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose,
            providerId,
            productId,
            credentialType,
            accountId,
            credentialId,
            credentialVersion,
          }
        : {
            ownerKind: 'tenant',
            tenantId: tenantId as string,
            supplyMode: 'byok',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose,
            providerId,
            productId,
            credentialType,
            accountId,
            credentialId,
            credentialVersion,
          },
    );
    const envelope: ProviderCredentialEnvelope = {
      schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
      contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
      algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
      kmsKeyId: safeText(version.kms_key_id),
      wrappedDek: safeText(version.wrapped_dek),
      nonce: safeText(version.nonce),
      ciphertext: safeText(version.ciphertext),
      authTag: safeText(version.auth_tag),
    };

    let result: T | undefined;
    let invoked = false;
    try {
      await withAccountOutbound(
        this.database,
        this.kms,
        account,
        {
          ...this.options,
          ...(fetcher === undefined
            ? {}
            : { fetch: ((url, init) => fetcher(new URL(url), init)) as AccountOutboundFetch }),
        },
        async (outbound) => {
          await withUnsealedProviderCredential(envelope, context, this.kms, async (secret) => {
            invoked = true;
            result = await callback(secret, outbound.fetch);
          });
        },
      );
    } catch (error) {
      if (!invoked) return null;
      throw error;
    }
    return invoked ? (result as T) : null;
  }

  async writeQuotaSnapshot(account: CnQuotaAccountRef, snapshot: CnQuotaSnapshot): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const prefix = columnPrefixFor(account.providerId);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET ${prefix}5h_used_percent = $${predicate.values.length + 1},
              ${prefix}5h_reset_at = $${predicate.values.length + 2},
              ${prefix}weekly_used_percent = $${predicate.values.length + 3},
              ${prefix}weekly_reset_at = $${predicate.values.length + 4},
              ${prefix}usage_updated_at = $${predicate.values.length + 5},
              ${prefix}usage_next_due_at = $${predicate.values.length + 6},
              ${prefix}usage_failure_count = 0,
              ${prefix}rate_limited_until = NULL,
              ${
                account.providerId === KIMI_CODING_PROVIDER_ID
                  ? `scheduling_threshold_pause_until = CASE
                WHEN scheduling_threshold_pause_reason->>'source' = 'account_scheduling_threshold'
                 AND scheduling_threshold_pause_reason->>'platform' = 'kimi' THEN NULL
                ELSE scheduling_threshold_pause_until END,
              scheduling_threshold_pause_reason = CASE
                WHEN scheduling_threshold_pause_reason->>'source' = 'account_scheduling_threshold'
                 AND scheduling_threshold_pause_reason->>'platform' = 'kimi' THEN NULL
                ELSE scheduling_threshold_pause_reason END,`
                  : ''
              }
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [
        ...predicate.values,
        nullablePercent(snapshot.fiveHour?.usedPercent ?? null),
        nullableIsoTimestamp(resetAtMsOf(snapshot.fiveHour)),
        nullablePercent(snapshot.weekly?.usedPercent ?? null),
        nullableIsoTimestamp(resetAtMsOf(snapshot.weekly)),
        isoTimestamp(snapshot.fetchedAtMs),
        isoTimestamp(snapshot.nextDueAtMs),
      ],
    );
  }

  async writeQuotaFailure(account: CnQuotaAccountRef, failure: CnQuotaFailure): Promise<void> {
    if (!failure || typeof failure !== 'object') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const prefix = columnPrefixFor(account.providerId);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET ${prefix}usage_attempted_at = $${predicate.values.length + 1},
              ${prefix}usage_next_due_at = $${predicate.values.length + 2},
              ${prefix}usage_failure_count = $${predicate.values.length + 3},
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [
        ...predicate.values,
        isoTimestamp(failure.attemptedAtMs),
        isoTimestamp(failure.nextDueAtMs),
        nonNegativeInteger(failure.failureCount),
      ],
    );
  }

  async markRateLimited(account: CnQuotaAccountRef, untilMs: number): Promise<void> {
    const scope = scopeFor(account.ownerKind);
    const prefix = columnPrefixFor(account.providerId);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET ${prefix}rate_limited_until = $${predicate.values.length + 1},
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [...predicate.values, isoTimestamp(untilMs)],
    );
  }
}

/** RFC 3339 reset string → epoch ms (the worker's snapshot carries tier objects). */
function resetAtMsOf(tier: { readonly resetAt: string } | null): number | null {
  if (tier === null || tier.resetAt === '') return null;
  const parsed = Date.parse(tier.resetAt);
  return Number.isFinite(parsed) ? parsed : null;
}
