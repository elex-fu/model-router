const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex');

/** The application-side equivalent of migration 046's BEFORE STATEMENT writer trigger. */
export const SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL =
  "SELECT set_config('lock_timeout', '2s', TRUE), set_config('statement_timeout', '10s', TRUE)";
export const SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL = 'SELECT pg_advisory_xact_lock(1396788563, 46)';

const positiveSafeIntegerDecimal = (version: number): string => {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new RangeError('version must be a safe positive integer');
  }

  return String(version);
};

export const saasAdvisoryKey = {
  tenant: (tenantId: string): string => `saas-authz:tenant:${tenantId}`,
  project: (tenantId: string, projectId: string): string => `saas-authz:project:${tenantId}:${projectId}`,
  /**
   * The member authorization fence. The prefixed form converges the admission
   * fence batch, the capacity/keys/commercial writers and the governance
   * disable/unban + risk-ladder writers into ONE mutual-exclusion domain:
   * previously the JS helper hashed the bare uuid while governance built
   * 'saas-authz:user:<uuid>' inline — two lock domains that did not exclude
   * each other despite comments claiming a shared fence.
   */
  user: (userId: string): string => `saas-authz:user:${userId}`,
  apiKey: (tenantId: string, projectId: string, keyId: string): string =>
    `saas-authz:api-key:${utf8Hex(tenantId)}:${utf8Hex(projectId)}:${utf8Hex(keyId)}`,
  commercialCustomer: (tenantId: string, headId: string): string =>
    `saas-authz:commercial-customer:${utf8Hex(tenantId)}:${utf8Hex(headId)}`,
  commercialProvider: (providerId: string, headId: string): string =>
    `saas-authz:commercial-provider:${utf8Hex(providerId)}:${utf8Hex(headId)}`,
  tenantProviderAccount: (tenantId: string, accountId: string): string =>
    `saas-authz:tenant-provider-account:${utf8Hex(tenantId)}:${utf8Hex(accountId)}`,
  platformProviderAccount: (accountId: string): string => `saas-authz:platform-provider-account:${utf8Hex(accountId)}`,
  tenantProviderCredential: (tenantId: string, credentialId: string): string =>
    `saas-authz:tenant-provider-credential:${utf8Hex(tenantId)}:${utf8Hex(credentialId)}`,
  platformProviderCredential: (credentialId: string): string =>
    `saas-authz:platform-provider-credential:${utf8Hex(credentialId)}`,
  credentialVersion: (ownerKind: string, ownerId: string, credentialId: string, version: number): string =>
    `saas-authz:credential-version:${ownerKind}:${utf8Hex(ownerId)}:${utf8Hex(credentialId)}:${positiveSafeIntegerDecimal(version)}`,
  supplyProfileAccount: (tenantId: string, profileId: string, accountId: string): string =>
    `saas-authz:supply-profile-account:${utf8Hex(tenantId)}:${utf8Hex(profileId)}:${utf8Hex(accountId)}`,
  platformPool: (poolId: string): string => `saas_platform_pool:${utf8Hex(poolId)}`,
  supplyProfile: (tenantId: string, profileId: string): string =>
    `saas_supply_profile:${utf8Hex(tenantId)}:${utf8Hex(profileId)}`,
  /** Serializes append-only usage corrections with reconciliation writers for one request. */
  usageCorrectionRequest: (tenantId: string, requestId: string): string =>
    `saas-metering:usage-correction:${utf8Hex(tenantId)}:${utf8Hex(requestId)}`,
  /**
   * R9 P4/P16 (roadmap batch 1.2 step 3): the per-wallet billing fence key.
   * One wallet = one tenant + one currency (saas_wallets unique constraint).
   * Every writer of wallet-derived billing state — billing reservations, the
   * spending-freeze gate, refund wallet freezes, ledger postings, the posted
   * balance projection — takes this EXCLUSIVE transaction-scoped advisory lock
   * instead of a `saas_wallets` row FOR UPDATE. Same-wallet writers still
   * serialize (the freeze-gate semantics are preserved verbatim), but no
   * admission transaction holds a wallet tuple lock across the capacity fence,
   * and lock waits no longer queue on the wallet row's tuple lock. The lock is
   * released automatically at transaction end. Both fence takers (the billing
   * ledger service and the payment refund service) MUST derive this key
   * through this helper so the two entry points stay one mutual-exclusion
   * domain — a row lock here and an advisory lock there would open a
   * double-entry race window.
   */
  walletFence: (tenantId: string, currency: string): string =>
    `model-router:wallet-fence:${utf8Hex(tenantId)}:${utf8Hex(currency)}`,
} as const;

/** The wallet-fence acquisition statement (see saasAdvisoryKey.walletFence). */
export const WALLET_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/**
 * The member authorization fence acquisition statement for governance and
 * risk-ladder writers that take the lock directly (not through the fence
 * batch). Byte-equivalent to the historical inline governance SQL: the
 * uuid cast keeps canonicalizing the identifier before the domain prefix is
 * concatenated. Callers pass the raw user uuid.
 */
export const SAAS_AUTHZ_USER_FENCE_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:user:' || $1::uuid::text, 0))";

export const sortAndDedupeAdvisoryKeys = (keys: readonly string[]): string[] => [...new Set(keys)].sort();
