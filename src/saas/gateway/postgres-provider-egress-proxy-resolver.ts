import type { SaasDatabase } from '../db/types.js';
import type { ProviderCredentialUnsealingKms } from '../runtime/gateway-provider-credential-kms.js';
import { type EgressProxyOwnerKind, readEgressProxyForAccount } from '../supply/egress-proxy-lookup.js';
import { assembleEgressProxyUrl } from '../supply/egress-proxy-record.js';
import { withUnsealedEgressProxyCredentials } from '../supply/egress-proxy-seal.js';

/**
 * R3 egress proxies: the gateway's per-account egress-proxy resolver. It
 * backs the dispatch-profile resolver's `egressProxy` field for the
 * forwarding path. The lookup goes through the shared
 * readEgressProxyForAccount module (the same one the OAuth refresh worker
 * uses), so forwarding and refresh provably resolve the same proxy record
 * for one account — the sub2api three-paths-one-egress invariant.
 *
 * The assembled URL (which carries the unsealed credentials) exists only in
 * the returned descriptor for the lifetime of one dispatch; it is never
 * logged and every failure surfaces a safe generic error.
 */

const SAFE_MESSAGES = Object.freeze({
  INVALID_INPUT: 'egress proxy resolver input is invalid',
  UNAVAILABLE: 'egress proxy is unavailable',
  INVALID: 'egress proxy record is invalid',
});

export type ProviderEgressProxyResolverErrorCode = keyof typeof SAFE_MESSAGES;

export class ProviderEgressProxyResolverError extends Error {
  constructor(readonly code: ProviderEgressProxyResolverErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ProviderEgressProxyResolverError';
  }
}

export interface ProviderEgressProxyResolveInput {
  readonly tenantId: string;
  readonly supplyMode: 'byok' | 'platform' | undefined;
  readonly accountOwnerKind: 'tenant' | 'platform' | undefined;
  readonly accountId: string;
}

export interface PostgresProviderEgressProxyResolverOptions {
  readonly database: SaasDatabase;
  readonly kms: ProviderCredentialUnsealingKms;
  /** Deployment/environment must match the control-plane sealing context exactly. */
  readonly credentialContext: { readonly deployment: string; readonly environment: string };
}

function ownerKindFrom(input: ProviderEgressProxyResolveInput): EgressProxyOwnerKind {
  if (input.accountOwnerKind === 'tenant' || input.accountOwnerKind === 'platform') return input.accountOwnerKind;
  if (input.supplyMode === 'byok') return 'tenant';
  if (input.supplyMode === 'platform') return 'platform';
  throw new ProviderEgressProxyResolverError('INVALID_INPUT');
}

export class PostgresProviderEgressProxyResolver {
  private readonly database: SaasDatabase;
  private readonly kms: ProviderCredentialUnsealingKms;
  private readonly credentialContext: { readonly deployment: string; readonly environment: string };

  constructor(options: PostgresProviderEgressProxyResolverOptions) {
    if (!options || typeof options !== 'object') throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    if (!options.database || typeof options.database.query !== 'function') {
      throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    }
    if (!options.kms || typeof options.kms.decryptDataKey !== 'function') {
      throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    }
    if (
      typeof options.credentialContext?.deployment !== 'string' ||
      typeof options.credentialContext?.environment !== 'string'
    ) {
      throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    }
    this.database = options.database;
    this.kms = options.kms;
    this.credentialContext = options.credentialContext;
  }

  /**
   * Resolve the account's egress proxy into a dispatch descriptor. Returns
   * null when the account carries no proxy binding (pre-R3 behavior). A
   * bound-but-unreadable proxy fails closed instead of silently direct-
   * egressing: an exit-IP change is exactly the risk-control trigger this
   * feature exists to prevent.
   */
  async resolveEgressProxy(input: ProviderEgressProxyResolveInput): Promise<{ readonly url: string } | null> {
    if (!input || typeof input.accountId !== 'string' || input.accountId.trim() === '') {
      throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    }
    let ownerKind: EgressProxyOwnerKind;
    try {
      ownerKind = ownerKindFrom(input);
    } catch {
      throw new ProviderEgressProxyResolverError('INVALID_INPUT');
    }
    let record: Awaited<ReturnType<typeof readEgressProxyForAccount>>;
    try {
      record = await readEgressProxyForAccount(this.database, {
        ownerKind,
        ...(ownerKind === 'tenant' ? { tenantId: input.tenantId } : {}),
        accountId: input.accountId,
      });
    } catch {
      throw new ProviderEgressProxyResolverError('UNAVAILABLE');
    }
    if (record === null) return null;
    try {
      return await withUnsealedEgressProxyCredentials(
        record.authSealedEnvelope,
        { ...this.credentialContext, proxyId: record.id },
        this.kms,
        (credentials) => ({
          url: assembleEgressProxyUrl({
            protocol: record.protocol,
            host: record.host,
            port: record.port,
            ...(credentials.username === undefined ? {} : { username: credentials.username }),
            ...(credentials.password === undefined ? {} : { password: credentials.password }),
          }).url,
        }),
      );
    } catch {
      throw new ProviderEgressProxyResolverError('INVALID');
    }
  }
}
