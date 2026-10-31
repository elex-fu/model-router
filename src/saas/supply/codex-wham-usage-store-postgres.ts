import { CODEX_CREDENTIAL_TYPE, CODEX_PRODUCT_ID, CODEX_PROVIDER_ID } from '../catalog/codex-registration.js';
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
import type { CodexRateLimitSnapshot } from '../gateway/codex/quota-headers.js';
import type { PostgresProviderQuotaSnapshotStore } from './provider-account-quota-snapshot-store-postgres.js';

/**
 * P1-3b Codex /wham active-usage Postgres store (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4 follow-up). Implements
 * the CodexWhamUsageStore contract the usage worker depends on:
 *
 * - claim: the gemini claim's SKIP LOCKED attempt-stamp lease
 *   (`provider-account-quota-snapshot-store-postgres.ts`) adapted to the codex
 *   binding triple and the migration-099 `codex_usage_updated_at` stamp column
 *   — the column already exists, so there is NO new migration;
 * - credential resolution: the opencode-go store's verified-current-credential
 *   chain (account binding re-read, current active/verified credential, locked
 *   active version with the latest DEK wrapping) with the KMS unseal invoked
 *   ONLY inside the callback (the plaintext OAuth JSON never leaves it);
 * - snapshot write: delegates to the shared quota-snapshot store's
 *   `writeCodexSnapshot` so the worker persists exactly the passive transport
 *   sink's normalized 5h/7d shape.
 *
 * Lease semantics (the gemini/opencode precedent): the claim's UPDATE stamps
 * `codex_usage_updated_at`, and that stamp IS the lease — a crashed round
 * leaves it behind, so no replica re-queries the account until the refresh
 * debounce floor passes. The snapshot stays a scheduling signal only; it never
 * enters the billing path (093/099 quota-snapshot precedent).
 */

export class CodexWhamUsageStoreError extends Error {
  readonly code = 'CODEX_WHAM_USAGE_STORE_UNAVAILABLE' as const;

  constructor() {
    super('Codex wham usage store is unavailable');
    this.name = 'CodexWhamUsageStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function storeUnavailable(): never {
  throw new CodexWhamUsageStoreError();
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

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) storeUnavailable();
  return new Date(value).toISOString();
}

/** Owner-scoped reference to one codex provider account row. */
export interface CodexWhamAccountRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
}

/**
 * The codex OAuth secret materialized from the unsealed credential JSON —
 * exactly the fields the quota-plane headers need (see how
 * `builtin-provider-transports.ts` reads `access_token` /
 * `chatgpt_account_id` off the unsealed codex envelope). The strings exist
 * only inside the unseal callback scope.
 */
export interface CodexWhamCredentialSecret {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
}

/**
 * Typed outcome of a credential resolution: `ok` carries the callback's value;
 * the failure states never invoke the callback. `credential_unavailable`
 * means no verified current credential; `credential_format_invalid` means the
 * unsealed plaintext did not carry the OAuth access-token shape.
 */
export type CodexWhamCredentialResolution<T> =
  | { readonly state: 'ok'; readonly value: T }
  | { readonly state: 'failed'; readonly reason: 'credential_unavailable' | 'credential_format_invalid' };

/**
 * Structural store contract the codex wham usage worker depends on (stub- and
 * test-friendly: any object with these three methods qualifies).
 */
export interface CodexWhamUsageStore {
  /** Returns at most `limit` claimed due codex accounts for this round. */
  claimDueCodexAccounts(input: {
    readonly refreshMs: number;
    readonly limit: number;
  }): Promise<readonly CodexWhamAccountRef[]>;
  /**
   * Unseals the account's current codex OAuth credential and invokes the
   * callback with the quota-plane identity fields. Resolves to a typed failure
   * (never invoking the callback) when no usable credential exists.
   */
  withUnsealedCodexCredential<T>(
    account: CodexWhamAccountRef,
    callback: (secret: CodexWhamCredentialSecret) => Promise<T>,
  ): Promise<CodexWhamCredentialResolution<T>>;
  /** Persists the normalized 5h/7d snapshot (the shared codex sink shape). */
  writeSnapshot(account: CodexWhamAccountRef, snapshot: CodexRateLimitSnapshot, observedAtMs: number): Promise<void>;
}

/**
 * Compile-time fixed account binding the claim filters on (the identity
 * contract `saas/catalog/codex-registration.ts` registers everywhere):
 * provider `openai-codex`, product `codex-chatgpt`, credential type `oauth`.
 */
export const CODEX_WHAM_USAGE_ACCOUNT_BINDING = Object.freeze({
  providerId: CODEX_PROVIDER_ID,
  productId: CODEX_PRODUCT_ID,
  credentialType: CODEX_CREDENTIAL_TYPE,
});

interface OwnerScope {
  readonly ownerKind: 'tenant' | 'platform';
  readonly accounts: string;
  readonly credentials: string;
  readonly versions: string;
  readonly wrappings: string;
}

const TENANT_OWNER_SCOPE: OwnerScope = Object.freeze({
  ownerKind: 'tenant',
  accounts: 'saas_tenant_provider_accounts',
  credentials: 'saas_tenant_provider_credentials',
  versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
});
const PLATFORM_OWNER_SCOPE: OwnerScope = Object.freeze({
  ownerKind: 'platform',
  accounts: 'saas_platform_provider_accounts',
  credentials: 'saas_platform_provider_credentials',
  versions: 'saas_platform_provider_credential_versions',
  wrappings: 'saas_platform_provider_credential_wrappings',
});
const CODEX_WHAM_OWNER_SCOPES: readonly OwnerScope[] = Object.freeze([TENANT_OWNER_SCOPE, PLATFORM_OWNER_SCOPE]);

interface AccountBindingRow {
  readonly id: string;
  readonly tenant_id?: string;
  readonly provider_id: string;
  readonly product_id: string;
  readonly credential_type: string;
  readonly purpose: string;
}

interface CurrentCredentialRow {
  readonly id: string;
  readonly current_version: number | string | null;
}

interface LockedVersionRow {
  readonly version: number | string;
  readonly schema_version: number | string;
  readonly context_version: number | string;
  readonly algorithm: string;
  readonly kms_purpose: string;
  readonly kms_key_id: string;
  readonly wrapped_dek: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly auth_tag: string;
}

export interface PostgresCodexWhamUsageStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  /** Overridable clock (claim stamp tests); defaults to Date.now. */
  readonly nowMs?: () => number;
}

/** Printable non-empty ASCII field bound (the transport identity precedent). */
function printableField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) return null;
  if (!/^[\x21-\x7e]+$/.test(value)) return null;
  return value;
}

/**
 * Parses the unsealed codex OAuth secret JSON into the quota-plane identity.
 * Returns null when the plaintext is not the expected
 * `{access_token, chatgpt_account_id}` shape (fail closed — the worker treats
 * it as an unusable credential, never guesses headers).
 */
function parseCodexOAuthSecret(secret: Uint8Array): CodexWhamCredentialSecret | null {
  if (secret.byteLength === 0 || secret.byteLength > 128 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(secret));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const accessToken = printableField(record.access_token);
  const chatgptAccountId = printableField(record.chatgpt_account_id);
  if (accessToken === null || chatgptAccountId === null) return null;
  return Object.freeze({ accessToken, chatgptAccountId });
}

/**
 * Postgres implementation of the codex wham usage store. The plaintext
 * credential exists only inside the unseal callback (the opencode-go store
 * precedent); no method logs or returns provider or credential data.
 */
export class PostgresCodexWhamUsageStore implements CodexWhamUsageStore {
  private readonly nowMs: () => number;
  private readonly deploymentId: string;
  private readonly environmentId: string;

  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly snapshotStore: Pick<PostgresProviderQuotaSnapshotStore, 'writeCodexSnapshot'>,
    options: PostgresCodexWhamUsageStoreOptions,
  ) {
    if (!options || typeof options !== 'object') storeUnavailable();
    this.deploymentId = safeText(options.deployment);
    this.environmentId = safeText(options.environment);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private async query<Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.database.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof CodexWhamUsageStoreError) throw error;
      storeUnavailable();
    }
  }

  /**
   * Codex claim (the gemini attempt-stamp lease): one atomic
   * UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING per
   * owner table stamps `codex_usage_updated_at` for due codex accounts
   * (binding triple + active/verified + refresh debounce). The stamp IS the
   * lease: a crashed round leaves it behind and the account re-enters the scan
   * only after the debounce floor passes.
   */
  async claimDueCodexAccounts(input: {
    readonly refreshMs: number;
    readonly limit: number;
  }): Promise<readonly CodexWhamAccountRef[]> {
    if (!input || typeof input !== 'object') storeUnavailable();
    const now = isoTimestamp(this.nowMs());
    const refreshSeconds = Math.max(1, Math.round(input.refreshMs / 1000));
    const limit = nonNegativeInteger(input.limit) || 1;
    const binding = CODEX_WHAM_USAGE_ACCOUNT_BINDING;
    const claimed: CodexWhamAccountRef[] = [];
    for (const scope of CODEX_WHAM_OWNER_SCOPES) {
      const rows = await this.query<{ id: string; tenant_id: string | null }>(
        `UPDATE ${scope.accounts} AS account
            SET codex_usage_updated_at = $1::timestamptz, updated_at = clock_timestamp()
          WHERE account.id IN (
                SELECT claim.id
                  FROM ${scope.accounts} AS claim
                 WHERE claim.status = 'active' AND claim.validation_state = 'verified'
                   AND claim.provider_id = $2 AND claim.product_id = $3 AND claim.credential_type = $4
                   AND (claim.codex_usage_updated_at IS NULL
                        OR claim.codex_usage_updated_at
                           <= clock_timestamp() - ($5::text || ' seconds')::interval)
                 ORDER BY claim.id
                 LIMIT $6
                   FOR UPDATE SKIP LOCKED)
          RETURNING account.id${scope.ownerKind === 'tenant' ? ', account.tenant_id' : ', NULL::text AS tenant_id'}`,
        [now, binding.providerId, binding.productId, binding.credentialType, String(refreshSeconds), limit],
      );
      for (const row of rows) {
        claimed.push({
          ownerKind: scope.ownerKind,
          tenantId:
            scope.ownerKind === 'tenant' && typeof row.tenant_id === 'string' && row.tenant_id.length > 0
              ? row.tenant_id
              : null,
          accountId: safeText(row.id),
        });
      }
    }
    return claimed;
  }

  /**
   * Resolves the account's current binding (claim metadata is re-read, never
   * trusted from the caller), then unseals the current verified credential
   * through the KMS decrypt-only seam, parses the OAuth secret shape and
   * invokes the callback with it. Resolves a typed failure — without invoking
   * the callback — when no verified credential is available or the plaintext
   * does not carry the access-token shape; callback results and errors pass
   * through unchanged.
   */
  async withUnsealedCodexCredential<T>(
    account: CodexWhamAccountRef,
    callback: (secret: CodexWhamCredentialSecret) => Promise<T>,
  ): Promise<CodexWhamCredentialResolution<T>> {
    if (!account || typeof account !== 'object' || typeof callback !== 'function') storeUnavailable();
    const scope =
      account.ownerKind === 'tenant'
        ? TENANT_OWNER_SCOPE
        : account.ownerKind === 'platform'
          ? PLATFORM_OWNER_SCOPE
          : undefined;
    if (scope === undefined) storeUnavailable();
    if (scope.ownerKind === 'tenant') {
      if (typeof account.tenantId !== 'string' || account.tenantId.length === 0) storeUnavailable();
    } else if (account.tenantId !== null) {
      storeUnavailable();
    }
    const accountId = safeText(account.accountId);
    const binding = CODEX_WHAM_USAGE_ACCOUNT_BINDING;
    const tenantPredicate =
      scope.ownerKind === 'tenant' ? 'account.tenant_id = $1 AND account.id = $2' : 'account.id = $1';
    const tenantValues = scope.ownerKind === 'tenant' ? [account.tenantId, accountId] : [accountId];
    const rows = await this.query<AccountBindingRow>(
      `SELECT ${scope.ownerKind === 'tenant' ? 'account.tenant_id, ' : ''}account.id, account.provider_id,
              account.product_id, account.credential_type, account.purpose
         FROM ${scope.accounts} AS account
        WHERE account.status = 'active' AND account.validation_state = 'verified'
          AND account.provider_id = $${tenantValues.length + 1}
          AND account.product_id = $${tenantValues.length + 2}
          AND account.credential_type = $${tenantValues.length + 3}
          AND ${tenantPredicate}
        LIMIT 1`,
      [...tenantValues, binding.providerId, binding.productId, binding.credentialType],
    );
    const row = rows[0];
    if (!row) return { state: 'failed', reason: 'credential_unavailable' };
    const providerId = safeText(row.provider_id);
    const productId = safeText(row.product_id);
    const credentialType = safeText(row.credential_type);
    const purpose = safeText(row.purpose);
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
    if (!credential) return { state: 'failed', reason: 'credential_unavailable' };
    const credentialId = safeText(credential.id);
    const credentialVersion = nonNegativeInteger(credential.current_version);
    if (credentialVersion < 1) return { state: 'failed', reason: 'credential_unavailable' };

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
    if (!version || version.kms_purpose !== purpose) return { state: 'failed', reason: 'credential_unavailable' };
    if (
      nonNegativeInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      nonNegativeInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return { state: 'failed', reason: 'credential_unavailable' };
    }

    const context: ProviderCredentialContext = createProviderCredentialContext(
      scope.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.deploymentId,
            environment: this.environmentId,
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
            deployment: this.deploymentId,
            environment: this.environmentId,
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

    let value: T | undefined;
    let invoked = false;
    let formatValid = true;
    try {
      await withUnsealedProviderCredential<T | undefined>(envelope, context, this.kms, async (secret) => {
        const parsedSecret = parseCodexOAuthSecret(secret);
        if (parsedSecret === null) {
          formatValid = false;
          return undefined;
        }
        invoked = true;
        value = await callback(parsedSecret);
        return value;
      });
    } catch (error) {
      if (!invoked && !formatValid) return { state: 'failed', reason: 'credential_format_invalid' };
      throw error;
    }
    if (!formatValid) return { state: 'failed', reason: 'credential_format_invalid' };
    if (!invoked) return { state: 'failed', reason: 'credential_unavailable' };
    return { state: 'ok', value: value as T };
  }

  /** Delegates to the shared quota-snapshot store's codex sink (099 columns). */
  async writeSnapshot(
    account: CodexWhamAccountRef,
    snapshot: CodexRateLimitSnapshot,
    observedAtMs: number,
  ): Promise<void> {
    if (!snapshot || typeof snapshot !== 'object') storeUnavailable();
    if (!account || typeof account !== 'object') storeUnavailable();
    if (account.ownerKind !== 'tenant' && account.ownerKind !== 'platform') storeUnavailable();
    if (account.ownerKind === 'tenant' && (typeof account.tenantId !== 'string' || account.tenantId.length === 0)) {
      storeUnavailable();
    }
    if (account.ownerKind === 'platform' && account.tenantId !== null) storeUnavailable();
    await this.snapshotStore.writeCodexSnapshot(
      {
        ownerKind: account.ownerKind,
        tenantId: account.tenantId,
        accountId: safeText(account.accountId),
      },
      snapshot,
      nonNegativeInteger(observedAtMs),
    );
  }
}
