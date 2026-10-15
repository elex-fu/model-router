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
import {
  OPENCODE_GO_USAGE_ACCOUNT_BINDING,
  type OpencodeGoUsageAccountRef,
  type OpencodeGoUsageFailure,
  type OpencodeGoUsageSnapshot,
  type OpencodeGoUsageStore,
} from './opencode-go-usage-worker.js';

/**
 * R5b OpenCode Go usage-snapshot Postgres store (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #25;
 * migration 108). Implements the OpencodeGoUsageStore contract the R5b-3
 * worker depends on, following the quota-sync-worker's Postgres access
 * patterns exactly (owner-scoped account tables, unnest binding filters,
 * verified-current credential resolution, KMS decrypt-only unsealing).
 *
 * Leader/lease semantics (the R5b-3 leader-lock decision): readDueAccounts
 * claims due rows with a single atomic
 *   UPDATE ... SET opencode_go_usage_updated_at = $now
 *   WHERE (tenant_id, id) IN (SELECT ... WHERE due LIMIT n FOR UPDATE SKIP LOCKED)
 *   RETURNING ...
 * statement — the attempt stamp IS the lease. A crashed worker leaves the
 * stamp behind, so no replica re-fetches the account until the debounce
 * floor passes; there are no lease columns to expire and no rollback window
 * where an account could be double-fetched.
 *
 * Due predicate (R5b-3 store contract):
 *   next_due_at IS NULL OR next_due_at <= now
 *   AND (usage_updated_at IS NULL OR usage_updated_at + debounce <= now)
 *   AND (rate_limited_until IS NULL OR rate_limited_until <= now)
 * plus the OPENCODE_GO_USAGE_ACCOUNT_BINDING triple and active/verified
 * account state. intervalMs is accepted for interface parity only: the
 * worker persists its interval-derived horizon as next_due_at, so the due
 * scan never re-derives it server-side.
 *
 * The snapshot is a scheduling signal only; it never enters the billing
 * path (093/099 quota-snapshot precedent). A failed attempt advances the
 * horizon but deliberately leaves the last observed windows in place: a
 * transient upstream failure must not erase real scheduling state.
 *
 * Protocol-rules admin surface: readOpencodeGoProtocolRules /
 * updateOpencodeGoProtocolRules expose the migration-108
 * opencode_go_protocol_rules column with the 047/082 repository CAS shape
 * (SET opencode_go_protocol_rules = $1, authz_version = authz_version + 1
 * WHERE ... AND authz_version = $expected), so in-flight prepared evidence
 * keyed to the previous rule table fails closed. These methods are the
 * documented SQL surface for the control-plane repository path; repository
 * wiring and its integration tests land with the admin mutation endpoint.
 */

export class OpencodeGoUsageStoreError extends Error {
  readonly code = 'OPENCODE_GO_USAGE_STORE_UNAVAILABLE' as const;

  constructor() {
    super('OpenCode Go usage store is unavailable');
    this.name = 'OpencodeGoUsageStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function storeUnavailable(): never {
  throw new OpencodeGoUsageStoreError();
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

export type OpencodeGoUsageOwnerKind = 'tenant' | 'platform';

interface OpencodeGoUsageOwnerScope {
  readonly ownerKind: OpencodeGoUsageOwnerKind;
  readonly accounts: string;
  readonly credentials: string;
  readonly versions: string;
  readonly wrappings: string;
}

const TENANT_OWNER_SCOPE: OpencodeGoUsageOwnerScope = Object.freeze({
  ownerKind: 'tenant',
  accounts: 'saas_tenant_provider_accounts',
  credentials: 'saas_tenant_provider_credentials',
  versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
});
const PLATFORM_OWNER_SCOPE: OpencodeGoUsageOwnerScope = Object.freeze({
  ownerKind: 'platform',
  accounts: 'saas_platform_provider_accounts',
  credentials: 'saas_platform_provider_credentials',
  versions: 'saas_platform_provider_credential_versions',
  wrappings: 'saas_platform_provider_credential_wrappings',
});
const OPENCODE_GO_USAGE_OWNER_SCOPES: readonly OpencodeGoUsageOwnerScope[] = Object.freeze([
  TENANT_OWNER_SCOPE,
  PLATFORM_OWNER_SCOPE,
]);

function scopeFor(ownerKind: string): OpencodeGoUsageOwnerScope {
  if (ownerKind === 'tenant') return TENANT_OWNER_SCOPE;
  if (ownerKind === 'platform') return PLATFORM_OWNER_SCOPE;
  storeUnavailable();
}

function accountPredicate(account: OpencodeGoUsageAccountRef, next: number): { sql: string; values: unknown[] } {
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
  product_id: string;
  credential_type: string;
  purpose: string;
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

interface ProtocolRulesRow {
  authz_version: number | string;
  opencode_go_protocol_rules: unknown;
}

/** Read row for the protocol-rules admin surface. */
export interface OpencodeGoProtocolRulesState {
  readonly authzVersion: number;
  /** Raw jsonb column value: null or the rule array (unvalidated here). */
  readonly rules: unknown;
}

export interface PostgresOpencodeGoUsageStoreOptions {
  readonly deployment: string;
  readonly environment: string;
}

/**
 * Postgres implementation of the usage worker's store contract against the
 * migration-108 scheduling columns. The plaintext credential exists only
 * inside the unseal callback (quota-sync precedent); no method logs or
 * returns provider or credential data.
 */
export class PostgresOpencodeGoUsageStore implements OpencodeGoUsageStore {
  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: PostgresOpencodeGoUsageStoreOptions,
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
      if (error instanceof OpencodeGoUsageStoreError) throw error;
      storeUnavailable();
    }
  }

  async readDueAccounts(input: {
    readonly nowMs: number;
    readonly debounceMs: number;
    readonly intervalMs: number;
    readonly limit: number;
  }): Promise<readonly OpencodeGoUsageAccountRef[]> {
    if (!input || typeof input !== 'object') storeUnavailable();
    const now = isoTimestamp(input.nowMs);
    const debounceCutoff = isoTimestamp(input.nowMs - positiveBound(input.debounceMs, 1, 86_400_000));
    positiveBound(input.intervalMs, 1, 86_400_000);
    let remaining = positiveBound(input.limit, 1, 1_000);
    const claimed: OpencodeGoUsageAccountRef[] = [];
    for (const scope of OPENCODE_GO_USAGE_OWNER_SCOPES) {
      if (remaining < 1) break;
      const binding = OPENCODE_GO_USAGE_ACCOUNT_BINDING;
      const duePredicate = `
          AND claim.status = 'active' AND claim.validation_state = 'verified'
          AND (claim.provider_id, claim.product_id, claim.credential_type) IN (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
          )
          AND (claim.opencode_go_usage_next_due_at IS NULL
            OR claim.opencode_go_usage_next_due_at <= $4::timestamptz)
          AND (claim.opencode_go_usage_updated_at IS NULL
            OR claim.opencode_go_usage_updated_at <= $5::timestamptz)
          AND (claim.opencode_go_rate_limited_until IS NULL
            OR claim.opencode_go_rate_limited_until <= $4::timestamptz)`;
      const claimTarget = scope.ownerKind === 'tenant' ? '(account.tenant_id, account.id)' : 'account.id';
      const claimSource = scope.ownerKind === 'tenant' ? 'claim.tenant_id, claim.id' : 'claim.id';
      const returning =
        scope.ownerKind === 'tenant'
          ? 'account.tenant_id, account.id, account.provider_id, account.product_id, account.credential_type, account.purpose'
          : 'account.id, account.provider_id, account.product_id, account.credential_type, account.purpose';
      const rows = await this.query<ClaimedAccountRow>(
        `UPDATE ${scope.accounts} AS account
           SET opencode_go_usage_updated_at = $4::timestamptz, updated_at = clock_timestamp()
         WHERE ${claimTarget} IN (
               SELECT ${claimSource}
                 FROM ${scope.accounts} AS claim
                WHERE TRUE${duePredicate}
                ORDER BY claim.opencode_go_usage_next_due_at ASC NULLS FIRST, claim.id
                LIMIT $6::int
                FOR UPDATE SKIP LOCKED)
         RETURNING ${returning}`,
        [[binding.providerId], [binding.productId], [binding.credentialType], now, debounceCutoff, remaining],
      );
      for (const row of rows) {
        const account: OpencodeGoUsageAccountRef = Object.freeze({
          ownerKind: scope.ownerKind,
          tenantId: scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null,
          accountId: safeText(row.id),
        });
        claimed.push(account);
      }
      remaining -= rows.length;
    }
    return Object.freeze(claimed);
  }

  /**
   * Resolves the account's current binding (claim metadata is re-read, never
   * trusted from the caller), then unseals the current verified credential
   * through the KMS decrypt-only seam and invokes the callback. Resolves null
   * when no verified credential is available; the callback's result (and
   * errors) pass through unchanged.
   */
  async withUnsealedApiKey<T>(
    account: OpencodeGoUsageAccountRef,
    callback: (secret: Buffer) => Promise<T>,
  ): Promise<T | null> {
    if (!account || typeof account !== 'object' || typeof callback !== 'function') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const binding = OPENCODE_GO_USAGE_ACCOUNT_BINDING;
    const predicate = accountPredicate(account, 1);
    const tenantColumn = scope.ownerKind === 'tenant' ? 'account.tenant_id, ' : '';
    const rows = await this.query<AccountBindingRow>(
      `SELECT ${tenantColumn}account.id, account.provider_id, account.product_id,
              account.credential_type, account.purpose
         FROM ${scope.accounts} AS account
        WHERE account.status = 'active' AND account.validation_state = 'verified'
          AND account.provider_id = $${predicate.values.length + 1}
          AND account.product_id = $${predicate.values.length + 2}
          AND account.credential_type = $${predicate.values.length + 3}
          AND ${predicate.sql}
        LIMIT 1`,
      [...predicate.values, binding.providerId, binding.productId, binding.credentialType],
    );
    const row = rows[0];
    if (!row) return null;
    const providerId = safeText(row.provider_id);
    const productId = safeText(row.product_id);
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
      await withUnsealedProviderCredential(envelope, context, this.kms, async (secret) => {
        invoked = true;
        result = await callback(secret);
      });
    } catch (error) {
      if (!invoked) return null;
      throw error;
    }
    return invoked ? (result as T) : null;
  }

  async writeUsageSnapshot(account: OpencodeGoUsageAccountRef, snapshot: OpencodeGoUsageSnapshot): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET opencode_go_rolling_5h_used_percent = $${predicate.values.length + 1},
              opencode_go_rolling_5h_reset_at = $${predicate.values.length + 2},
              opencode_go_weekly_used_percent = $${predicate.values.length + 3},
              opencode_go_weekly_reset_at = $${predicate.values.length + 4},
              opencode_go_monthly_used_percent = $${predicate.values.length + 5},
              opencode_go_monthly_reset_at = $${predicate.values.length + 6},
              opencode_go_usage_updated_at = $${predicate.values.length + 7},
              opencode_go_usage_next_due_at = $${predicate.values.length + 8},
              opencode_go_usage_failure_count = 0,
              opencode_go_rate_limited_until = NULL,
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [
        ...predicate.values,
        nullablePercent(snapshot.rolling5h?.usedPercent ?? null),
        nullableIsoTimestamp(snapshot.rolling5h?.resetsAtMs ?? null),
        nullablePercent(snapshot.weekly?.usedPercent ?? null),
        nullableIsoTimestamp(snapshot.weekly?.resetsAtMs ?? null),
        nullablePercent(snapshot.monthly?.usedPercent ?? null),
        nullableIsoTimestamp(snapshot.monthly?.resetsAtMs ?? null),
        isoTimestamp(snapshot.fetchedAtMs),
        isoTimestamp(snapshot.nextDueAtMs),
      ],
    );
  }

  async writeUsageFailure(account: OpencodeGoUsageAccountRef, failure: OpencodeGoUsageFailure): Promise<void> {
    if (!failure || typeof failure !== 'object') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET opencode_go_usage_updated_at = $${predicate.values.length + 1},
              opencode_go_usage_next_due_at = $${predicate.values.length + 2},
              opencode_go_usage_failure_count = $${predicate.values.length + 3},
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

  async markRateLimited(account: OpencodeGoUsageAccountRef, untilMs: number): Promise<void> {
    const scope = scopeFor(account.ownerKind);
    const predicate = accountPredicate(account, 1);
    await this.query(
      `UPDATE ${scope.accounts}
          SET opencode_go_rate_limited_until = $${predicate.values.length + 1},
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}`,
      [...predicate.values, isoTimestamp(untilMs)],
    );
  }

  /**
   * Admin read of the migration-108 adaptive-routing rule table. Returns the
   * raw jsonb value (null or array) plus the authorization fence version the
   * CAS mutation must echo back.
   */
  async readOpencodeGoProtocolRules(account: OpencodeGoUsageAccountRef): Promise<OpencodeGoProtocolRulesState | null> {
    const scope = scopeFor(account.ownerKind);
    const predicate = accountPredicate(account, 1);
    const rows = await this.query<ProtocolRulesRow>(
      `SELECT authz_version, opencode_go_protocol_rules
         FROM ${scope.accounts}
        WHERE ${predicate.sql}
        LIMIT 1`,
      predicate.values,
    );
    const row = rows[0];
    if (!row) return null;
    return { authzVersion: nonNegativeInteger(row.authz_version), rules: row.opencode_go_protocol_rules };
  }

  /**
   * Admin CAS mutation of the adaptive-routing rule table (047/082 repository
   * pattern): a stale expected authz_version resolves null so the caller
   * fails closed instead of dispatching with a stale rule table. `rulesJson`
   * must already be validated (validateOpenCodeGoProtocolRules) and serialized
   * by the caller; null clears the override and restores the default table.
   */
  async updateOpencodeGoProtocolRules(
    account: OpencodeGoUsageAccountRef,
    input: { readonly rulesJson: string | null; readonly expectedAuthzVersion: number },
  ): Promise<OpencodeGoProtocolRulesState | null> {
    if (!input || typeof input !== 'object') storeUnavailable();
    nonNegativeInteger(input.expectedAuthzVersion);
    if (input.rulesJson !== null && typeof input.rulesJson !== 'string') storeUnavailable();
    const scope = scopeFor(account.ownerKind);
    const predicate = accountPredicate(account, 1);
    const rows = await this.query<ProtocolRulesRow>(
      `UPDATE ${scope.accounts}
          SET opencode_go_protocol_rules = $${predicate.values.length + 1}::jsonb,
              authz_version = authz_version + 1,
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}
          AND authz_version = $${predicate.values.length + 2}
        RETURNING authz_version, opencode_go_protocol_rules`,
      [...predicate.values, input.rulesJson, input.expectedAuthzVersion],
    );
    const row = rows[0];
    if (!row) return null;
    return { authzVersion: nonNegativeInteger(row.authz_version), rules: row.opencode_go_protocol_rules };
  }
}
