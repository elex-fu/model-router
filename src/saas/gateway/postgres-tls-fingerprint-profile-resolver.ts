import type { SaasDatabase } from '../db/types.js';
import {
  readTlsFingerprintBindingForAccount,
  readTlsFingerprintProfileById,
  type TlsFingerprintProfileOwnerKind,
  type TlsFingerprintProfileRecord,
} from '../supply/tls-fingerprint-profile-lookup.js';
import type { ProviderTlsFingerprintEgress } from './provider-http-tls-fingerprint-connector.js';

/**
 * Batch-2 §2.4: the gateway's per-account TLS-fingerprint resolver. It backs
 * the dispatch-profile resolver's `tlsFingerprint` field (the direct analog
 * of PostgresProviderEgressProxyResolver for the R3 proxy).
 *
 * Profile caching follows the roadmap-corrected plan: PostgreSQL is
 * authoritative and the process keeps a short-TTL in-process cache with
 * accepted staleness — the RESP client has no PubSub and a 16KB frame limit
 * by design, so Redis-based invalidation is ruled out (移植律 #5: DB 权威).
 *
 * Failure posture (deliberate contrast with the egress proxy): an unreadable
 * binding or a bound-but-missing profile row fails OPEN to the default
 * profile. A fingerprint miss degrades mimicry but never changes the
 * account's exit IP — failing the request would be the wrong trade.
 */

const SAFE_MESSAGES = Object.freeze({
  INVALID_INPUT: 'tls fingerprint resolver input is invalid',
});

export type ProviderTlsFingerprintResolverErrorCode = keyof typeof SAFE_MESSAGES;

export class ProviderTlsFingerprintResolverError extends Error {
  constructor(readonly code: ProviderTlsFingerprintResolverErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ProviderTlsFingerprintResolverError';
  }
}

export interface ProviderTlsFingerprintResolveInput {
  readonly tenantId: string;
  readonly supplyMode: 'byok' | 'platform' | undefined;
  readonly accountOwnerKind: 'tenant' | 'platform' | undefined;
  readonly accountId: string;
}

export interface PostgresProviderTlsFingerprintResolverOptions {
  readonly database: SaasDatabase;
  /** In-process profile cache TTL; defaults to 30s (accepted staleness). */
  readonly profileCacheTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly nowMs?: () => number;
}

interface CacheEntry {
  readonly profile: TlsFingerprintProfileRecord | null;
  readonly expiresAtMs: number;
}

const DEFAULT_PROFILE_CACHE_TTL_MS = 30_000;

export class PostgresProviderTlsFingerprintResolver {
  private readonly database: SaasDatabase;
  private readonly profileCacheTtlMs: number;
  private readonly nowMs: () => number;
  private readonly profileCache = new Map<number, CacheEntry>();

  constructor(options: PostgresProviderTlsFingerprintResolverOptions) {
    if (!options || typeof options !== 'object') throw new ProviderTlsFingerprintResolverError('INVALID_INPUT');
    if (!options.database || typeof options.database.query !== 'function') {
      throw new ProviderTlsFingerprintResolverError('INVALID_INPUT');
    }
    this.database = options.database;
    this.profileCacheTtlMs = options.profileCacheTtlMs ?? DEFAULT_PROFILE_CACHE_TTL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Resolve the account's TLS fingerprint binding into a dispatch
   * descriptor. Returns null when the account carries no binding (fingerprint
   * off — the exact pre-116 behavior).
   */
  async resolveTlsFingerprint(input: ProviderTlsFingerprintResolveInput): Promise<ProviderTlsFingerprintEgress | null> {
    if (!input || typeof input.accountId !== 'string' || input.accountId.trim() === '') {
      throw new ProviderTlsFingerprintResolverError('INVALID_INPUT');
    }
    const ownerKind = ownerKindFrom(input);
    let binding: Awaited<ReturnType<typeof readTlsFingerprintBindingForAccount>>;
    try {
      binding = await readTlsFingerprintBindingForAccount(this.database, {
        ownerKind,
        ...(ownerKind === 'tenant' ? { tenantId: input.tenantId } : {}),
        accountId: input.accountId,
      });
    } catch {
      // Unreadable binding: fail open to no fingerprinting (the request
      // proceeds on the ordinary connector; nothing about the egress path
      // changed).
      return null;
    }
    if (binding === null || binding.boundProfileId === null) return null;
    if (binding.boundProfileId === 0) return { selector: 'default' };
    if (binding.boundProfileId === -1) return { selector: 'random' };
    if (binding.boundProfileId <= 0) return null;
    const profile = binding.profile ?? (await this.readProfileCached(binding.boundProfileId));
    if (profile === null) {
      // Bound-but-missing row (deleted profile, replication lag): degrade to
      // the built-in default fingerprint rather than failing the dispatch.
      return { selector: 'default' };
    }
    return { selector: 'custom', profile: toSpec(profile) };
  }

  private async readProfileCached(profileId: number): Promise<TlsFingerprintProfileRecord | null> {
    const cached = this.profileCache.get(profileId);
    if (cached !== undefined && cached.expiresAtMs > this.nowMs()) return cached.profile;
    const profile = await readTlsFingerprintProfileById(this.database, profileId).catch(() => null);
    this.profileCache.set(profileId, { profile, expiresAtMs: this.nowMs() + this.profileCacheTtlMs });
    return profile;
  }
}

function ownerKindFrom(input: ProviderTlsFingerprintResolveInput): TlsFingerprintProfileOwnerKind {
  if (input.accountOwnerKind === 'tenant' || input.accountOwnerKind === 'platform') return input.accountOwnerKind;
  if (input.supplyMode === 'byok') return 'tenant';
  if (input.supplyMode === 'platform') return 'platform';
  throw new ProviderTlsFingerprintResolverError('INVALID_INPUT');
}

function toSpec(record: TlsFingerprintProfileRecord): ProviderTlsFingerprintEgress['profile'] {
  return {
    name: record.name,
    enableGrease: record.enableGrease,
    ...(record.cipherSuites.length === 0 ? {} : { cipherSuites: [...record.cipherSuites] }),
    ...(record.curves.length === 0 ? {} : { curves: [...record.curves] }),
    ...(record.pointFormats.length === 0 ? {} : { pointFormats: [...record.pointFormats] }),
    ...(record.signatureAlgorithms.length === 0 ? {} : { signatureAlgorithms: [...record.signatureAlgorithms] }),
    ...(record.alpnProtocols.length === 0 ? {} : { alpnProtocols: [...record.alpnProtocols] }),
    ...(record.supportedVersions.length === 0 ? {} : { supportedVersions: [...record.supportedVersions] }),
    ...(record.keyShareGroups.length === 0 ? {} : { keyShareGroups: [...record.keyShareGroups] }),
    ...(record.pskModes.length === 0 ? {} : { pskModes: [...record.pskModes] }),
    ...(record.extensions.length === 0 ? {} : { extensions: [...record.extensions] }),
  };
}
