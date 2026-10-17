/**
 * Batch 3 CN-provider per-account configuration store (the platform-side
 * counterpart of the opencode-go rules store): read + CAS mutation of the
 * migration-120 dual-mode columns ({zhipu,minimax}_account_mode /
 * _api_protocol) on both account owner tables.
 *
 * The CAS shape is the 047/082 repository pattern: a stale expected
 * authz_version resolves null so the caller fails closed instead of
 * dispatching with a stale protocol table. A config change is a
 * scheduling-input change — the gateway's adaptive routing decorator keys on
 * the api_protocol, so in-flight prepared evidence keyed to the previous
 * value must fail closed.
 *
 * Validation is callers' responsibility (normalizeCnProviderApiProtocol for
 * the protocol matrix; the account_mode enum is enforced by the migration
 * CHECK constraints); this store only persists.
 */

import type { SaasDatabase } from '../../db/index.js';
import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from '../../gateway/cn-providers/catalog-identity.js';

export type CnProviderConfigOwnerKind = 'tenant' | 'platform';

/** The per-account configuration snapshot (raw column values). */
export interface CnProviderAccountConfigState {
  readonly authzVersion: number;
  readonly accountMode: string | null;
  readonly apiProtocol: string | null;
}

/** The CAS mutation input (values already validated). */
export interface CnProviderAccountConfigUpdate {
  readonly accountMode: 'payg' | 'coding' | null;
  readonly apiProtocol: 'chat_completions' | 'anthropic' | 'responses' | 'adaptive' | null;
  readonly expectedAuthzVersion: number;
}

export class CnProvidersAccountConfigStoreError extends Error {
  readonly code = 'CN_PROVIDERS_ACCOUNT_CONFIG_STORE_UNAVAILABLE' as const;

  constructor() {
    super('CN provider account config store is unavailable');
    this.name = 'CnProvidersAccountConfigStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function storeUnavailable(): never {
  throw new CnProvidersAccountConfigStoreError();
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

function nullableConfigText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return safeText(value);
}

function validateAccountMode(value: unknown): 'payg' | 'coding' | null {
  if (value === null || value === undefined) return null;
  if (value !== 'payg' && value !== 'coding') storeUnavailable();
  return value;
}

function validateApiProtocol(value: unknown): 'chat_completions' | 'anthropic' | 'responses' | 'adaptive' | null {
  if (value === null || value === undefined) return null;
  if (
    value !== 'chat_completions' &&
    value !== 'anthropic' &&
    value !== 'responses' &&
    value !== 'adaptive'
  ) {
    storeUnavailable();
  }
  return value;
}

interface ConfigRow {
  authz_version: number | string;
  account_mode: string | null;
  api_protocol: string | null;
}

/**
 * Postgres read/CAS store for the migration-120 configuration columns. The
 * column family is derived from the provider id (whitelisted), never from
 * caller-supplied strings.
 */
export class PostgresCnProvidersAccountConfigStore {
  constructor(private readonly database: SaasDatabase) {
    if (!database || typeof database.query !== 'function') storeUnavailable();
  }

  private prefixFor(providerId: string): 'zhipu_' | 'minimax_' {
    if (providerId === ZHIPU_PROVIDER_ID) return 'zhipu_';
    if (providerId === MINIMAX_PROVIDER_ID) return 'minimax_';
    storeUnavailable();
  }

  private predicate(
    account: { readonly ownerKind: CnProviderConfigOwnerKind; readonly tenantId: string | null; readonly accountId: string },
    next: number,
  ): { sql: string; values: unknown[] } {
    if (account.ownerKind === 'tenant') {
      if (typeof account.tenantId !== 'string' || account.tenantId.length === 0) storeUnavailable();
      return { sql: `tenant_id = $${next} AND id = $${next + 1}`, values: [account.tenantId, account.accountId] };
    }
    if (account.tenantId !== null) storeUnavailable();
    return { sql: `id = $${next}`, values: [account.accountId] };
  }

  private tableFor(ownerKind: CnProviderConfigOwnerKind): string {
    if (ownerKind === 'tenant') return 'saas_tenant_provider_accounts';
    return 'saas_platform_provider_accounts';
  }

  async read(
    account: {
      readonly ownerKind: CnProviderConfigOwnerKind;
      readonly tenantId: string | null;
      readonly accountId: string;
    },
    providerId: string,
  ): Promise<CnProviderAccountConfigState | null> {
    const prefix = this.prefixFor(providerId);
    const predicate = this.predicate(account, 1);
    const rows = await this.query<ConfigRow>(
      `SELECT authz_version,
              ${prefix}account_mode AS account_mode,
              ${prefix}api_protocol AS api_protocol
         FROM ${this.tableFor(account.ownerKind)}
        WHERE ${predicate.sql}
        LIMIT 1`,
      predicate.values,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      authzVersion: nonNegativeInteger(row.authz_version),
      accountMode: nullableConfigText(row.account_mode),
      apiProtocol: nullableConfigText(row.api_protocol),
    };
  }

  /**
   * CAS mutation (the 047/082 repository pattern): a stale expected
   * authz_version resolves null. A null field in the update clears the
   * override (restoring the payg / adaptive defaults).
   */
  async update(
    account: {
      readonly ownerKind: CnProviderConfigOwnerKind;
      readonly tenantId: string | null;
      readonly accountId: string;
    },
    providerId: string,
    input: CnProviderAccountConfigUpdate,
  ): Promise<CnProviderAccountConfigState | null> {
    const prefix = this.prefixFor(providerId);
    const accountMode = validateAccountMode(input?.accountMode);
    const apiProtocol = validateApiProtocol(input?.apiProtocol);
    const expected = nonNegativeInteger(input?.expectedAuthzVersion);
    const predicate = this.predicate(account, 1);
    const rows = await this.query<ConfigRow>(
      `UPDATE ${this.tableFor(account.ownerKind)}
          SET ${prefix}account_mode = $${predicate.values.length + 1},
              ${prefix}api_protocol = $${predicate.values.length + 2},
              authz_version = authz_version + 1,
              updated_at = clock_timestamp()
        WHERE ${predicate.sql}
          AND authz_version = $${predicate.values.length + 3}
        RETURNING authz_version,
                  ${prefix}account_mode AS account_mode,
                  ${prefix}api_protocol AS api_protocol`,
      [...predicate.values, accountMode, apiProtocol, expected],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      authzVersion: nonNegativeInteger(row.authz_version),
      accountMode: nullableConfigText(row.account_mode),
      apiProtocol: nullableConfigText(row.api_protocol),
    };
  }

  private async query<Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.database.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof CnProvidersAccountConfigStoreError) throw error;
      storeUnavailable();
    }
  }
}

export function createPostgresCnProvidersAccountConfigStore(
  database: SaasDatabase,
): PostgresCnProvidersAccountConfigStore {
  return new PostgresCnProvidersAccountConfigStore(database);
}
