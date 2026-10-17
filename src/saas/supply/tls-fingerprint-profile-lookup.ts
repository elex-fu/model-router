import type { SqlExecutor } from '../db/types.js';

/**
 * Batch-2 §2.4 TLS fingerprint profiles (migration 116): the shared
 * account → profile lookup used by the gateway's dispatch-profile resolver.
 * Mirrors egress-proxy-lookup.ts: one module owns the SQL and row mapping so
 * every egress path provably resolves the same profile for one account.
 *
 * Account column semantics (the 099 dormant-column adjudication, see the
 * migration-116 registration comment):
 * - NULL  → TLS fingerprinting is OFF for the account (default; exact
 *   pre-116 behavior);
 * - 0     → the sidecar's built-in Node.js 24.x default profile;
 * - -1    → a per-connection randomized ClientHello;
 * - > 0   → the specific saas_tls_fingerprint_profiles row (resolved
 *   inline; a missing/deleted row fails OPEN to the default profile — losing
 *   the fingerprint is preferable to failing the request, and unlike an
 *   egress proxy it never changes the account's exit IP).
 */

export type TlsFingerprintProfileOwnerKind = 'tenant' | 'platform';

/** The column-shaped profile payload forwarded to the sidecar. */
export interface TlsFingerprintProfileRecord {
  readonly id: number;
  readonly name: string;
  readonly enableGrease: boolean;
  readonly cipherSuites: readonly number[];
  readonly curves: readonly number[];
  readonly pointFormats: readonly number[];
  readonly signatureAlgorithms: readonly number[];
  readonly alpnProtocols: readonly string[];
  readonly supportedVersions: readonly number[];
  readonly keyShareGroups: readonly number[];
  readonly pskModes: readonly number[];
  readonly extensions: readonly number[];
}

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

const PROFILE_COLUMNS = `profile.id, profile.name, profile.enable_grease,
       profile.cipher_suites, profile.curves, profile.point_formats,
       profile.signature_algorithms, profile.alpn_protocols,
       profile.supported_versions, profile.key_share_groups,
       profile.psk_modes, profile.extensions` as const;

const BOUNDED_LIST_LENGTH = 64;

function isBoundedNumberList(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length <= BOUNDED_LIST_LENGTH &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 65_535)
  );
}

interface RawProfileRow {
  readonly id: number | string;
  readonly name: string;
  readonly enable_grease: boolean;
  readonly cipher_suites: unknown;
  readonly curves: unknown;
  readonly point_formats: unknown;
  readonly signature_algorithms: unknown;
  readonly alpn_protocols: unknown;
  readonly supported_versions: unknown;
  readonly key_share_groups: unknown;
  readonly psk_modes: unknown;
  readonly extensions: unknown;
}

function mapProfileRow(row: RawProfileRow): TlsFingerprintProfileRecord {
  const alpn = row.alpn_protocols;
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id),
    name: row.name,
    enableGrease: row.enable_grease === true,
    cipherSuites: isBoundedNumberList(row.cipher_suites) ? row.cipher_suites : [],
    curves: isBoundedNumberList(row.curves) ? row.curves : [],
    pointFormats: isBoundedNumberList(row.point_formats) ? row.point_formats : [],
    signatureAlgorithms: isBoundedNumberList(row.signature_algorithms) ? row.signature_algorithms : [],
    alpnProtocols: Array.isArray(alpn) && alpn.every((entry) => typeof entry === 'string') ? alpn : [],
    supportedVersions: isBoundedNumberList(row.supported_versions) ? row.supported_versions : [],
    keyShareGroups: isBoundedNumberList(row.key_share_groups) ? row.key_share_groups : [],
    pskModes: isBoundedNumberList(row.psk_modes) ? row.psk_modes : [],
    extensions: isBoundedNumberList(row.extensions) ? row.extensions : [],
  };
}

function isRawProfileRow(value: unknown): value is RawProfileRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'number' || typeof row.id === 'string';
  return id && typeof row.name === 'string' && typeof row.enable_grease === 'boolean';
}

/**
 * Resolve one account's TLS fingerprint binding. Returns the raw account
 * binding (null = off) plus the profile row when a specific id is bound and
 * present. A bound-but-missing profile row is reported as `profile: null`
 * with `boundProfileId` set so callers can apply the fail-open default.
 */
export async function readTlsFingerprintBindingForAccount(
  executor: SqlExecutor,
  input: {
    readonly ownerKind: TlsFingerprintProfileOwnerKind;
    readonly tenantId?: string;
    readonly accountId: string;
  },
): Promise<{
  readonly boundProfileId: number | null;
  readonly profile: TlsFingerprintProfileRecord | null;
} | null> {
  if (input.ownerKind === 'tenant') {
    if (typeof input.tenantId !== 'string' || input.tenantId === '') {
      throw new Error('tls fingerprint account lookup requires the tenant id for tenant-scoped accounts');
    }
    const result = await executor.query<RawProfileRow>(
      `SELECT account.tls_fingerprint_profile_id, ${PROFILE_COLUMNS}
         FROM ${ACCOUNT_TABLES.tenant} AS account
         LEFT JOIN saas_tls_fingerprint_profiles AS profile
           ON profile.id = account.tls_fingerprint_profile_id
        WHERE account.tenant_id = $1 AND account.id = $2
        LIMIT 1`,
      [input.tenantId, input.accountId],
    );
    return mapBindingRow(result.rows[0]);
  }
  const result = await executor.query<RawProfileRow>(
    `SELECT account.tls_fingerprint_profile_id, ${PROFILE_COLUMNS}
       FROM ${ACCOUNT_TABLES.platform} AS account
       LEFT JOIN saas_tls_fingerprint_profiles AS profile
         ON profile.id = account.tls_fingerprint_profile_id
      WHERE account.id = $1
      LIMIT 1`,
    [input.accountId],
  );
  return mapBindingRow(result.rows[0]);
}

interface BindingRow extends RawProfileRow {
  readonly tls_fingerprint_profile_id: number | string | null;
}

function mapBindingRow(
  row: unknown,
): { readonly boundProfileId: number | null; readonly profile: TlsFingerprintProfileRecord | null } | null {
  if (row === undefined) return null;
  if (typeof row !== 'object' || row === null) {
    throw new Error('tls fingerprint account lookup returned a malformed row');
  }
  const binding = row as BindingRow;
  const rawId = binding.tls_fingerprint_profile_id;
  const boundProfileId =
    rawId === null || rawId === undefined ? null : typeof rawId === 'number' ? rawId : Number(rawId);
  if (boundProfileId === null) {
    return { boundProfileId: null, profile: null };
  }
  if (!Number.isSafeInteger(boundProfileId)) {
    throw new Error('tls fingerprint account lookup returned a malformed row');
  }
  // 0/-1 bindings (default/random) never join a profile row; >0 must.
  if (boundProfileId <= 0) return { boundProfileId, profile: null };
  // A >0 binding against a deleted/missing profile row (LEFT JOIN miss)
  // yields all-NULL profile columns: the documented fail-open shape, not a
  // malformed row.
  const profileColumns: ReadonlyArray<keyof RawProfileRow> = [
    'id',
    'name',
    'enable_grease',
    'cipher_suites',
    'curves',
    'point_formats',
    'signature_algorithms',
    'alpn_protocols',
    'supported_versions',
    'key_share_groups',
    'psk_modes',
    'extensions',
  ];
  const anyProfileColumnPresent = profileColumns.some(
    (column) => binding[column] !== undefined && binding[column] !== null,
  );
  if (!anyProfileColumnPresent) return { boundProfileId, profile: null };
  if (!isRawProfileRow(binding)) {
    throw new Error('tls fingerprint account lookup returned a malformed row');
  }
  return { boundProfileId, profile: mapProfileRow(binding) };
}

/** Read one profile row by id (profile CRUD and cache refresh paths). */
export async function readTlsFingerprintProfileById(
  executor: SqlExecutor,
  profileId: number,
): Promise<TlsFingerprintProfileRecord | null> {
  const result = await executor.query<RawProfileRow>(
    `SELECT ${PROFILE_COLUMNS}
       FROM saas_tls_fingerprint_profiles
      WHERE id = $1
      LIMIT 1`,
    [profileId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (!isRawProfileRow(row)) throw new Error('tls fingerprint profile lookup returned a malformed row');
  return mapProfileRow(row);
}
