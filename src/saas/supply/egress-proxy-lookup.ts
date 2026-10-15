import type { SqlExecutor } from '../db/types.js';

/**
 * R3 egress proxies: the single account → proxy lookup shared by every
 * egress path (gateway forwarding dispatch profiles, the OAuth token-refresh
 * worker, and the probe worker's account joins). All three paths MUST
 * resolve the same proxy record for one account — sub2api's core lesson is
 * that a mixed exit IP between binding, refresh, and request traffic trips
 * provider risk control. Keeping the SQL and row mapping in one module is
 * what makes that invariant testable.
 *
 * The SELECT deliberately omits the credential envelope from this lookup:
 * callers that need the URL unseal through egress-proxy-seal.ts with the
 * proxy id they read here, on their own audited KMS handle.
 */

export interface EgressProxyRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  /** The sealed KMS envelope object, or null when the proxy has no auth. */
  readonly authSealedEnvelope: unknown;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly fallbackMode: string;
  readonly backupProxyId: string | null;
  readonly lastProbeAt: string | null;
  readonly lastProbeLatencyMs: number | null;
  readonly lastProbeIp: string | null;
  readonly lastProbeQuality: string | null;
}

export type EgressProxyOwnerKind = 'tenant' | 'platform';

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

interface RawProxyRow {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  readonly auth_sealed_envelope: unknown;
  readonly status: string;
  readonly expires_at: string | Date | null;
  readonly fallback_mode: string;
  readonly backup_proxy_id: string | null;
  readonly last_probe_at: string | Date | null;
  readonly last_probe_latency_ms: number | null;
  readonly last_probe_ip: string | null;
  readonly last_probe_quality: string | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapProxyRow(row: RawProxyRow): EgressProxyRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    authSealedEnvelope: row.auth_sealed_envelope,
    status: row.status,
    expiresAt: iso(row.expires_at),
    fallbackMode: row.fallback_mode,
    backupProxyId: row.backup_proxy_id,
    lastProbeAt: iso(row.last_probe_at),
    lastProbeLatencyMs: row.last_probe_latency_ms,
    lastProbeIp: row.last_probe_ip,
    lastProbeQuality: row.last_probe_quality,
  };
}

function isRawProxyRow(value: unknown): value is RawProxyRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.protocol === 'string' &&
    typeof row.host === 'string' &&
    typeof row.port === 'number' &&
    typeof row.status === 'string' &&
    typeof row.fallback_mode === 'string'
  );
}

/**
 * Read one account's bound egress proxy. The tenant scope keys on
 * (tenant_id, id); the platform scope keys on id alone. Returns null when
 * the account exists but carries no proxy binding.
 */
export async function readEgressProxyForAccount(
  executor: SqlExecutor,
  input: { readonly ownerKind: EgressProxyOwnerKind; readonly tenantId?: string; readonly accountId: string },
): Promise<EgressProxyRecord | null> {
  if (input.ownerKind === 'tenant') {
    if (typeof input.tenantId !== 'string' || input.tenantId === '') {
      throw new Error('egress proxy account lookup requires the tenant id for tenant-scoped accounts');
    }
    const result = await executor.query<RawProxyRow>(
      `SELECT proxy.id, proxy.name, proxy.protocol, proxy.host, proxy.port,
              proxy.auth_sealed_envelope, proxy.status, proxy.expires_at,
              proxy.fallback_mode, proxy.backup_proxy_id,
              proxy.last_probe_at, proxy.last_probe_latency_ms, proxy.last_probe_ip, proxy.last_probe_quality
         FROM ${ACCOUNT_TABLES.tenant} AS account
         JOIN saas_egress_proxies AS proxy ON proxy.id = account.egress_proxy_id
        WHERE account.tenant_id = $1 AND account.id = $2
        LIMIT 1`,
      [input.tenantId, input.accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (!isRawProxyRow(row)) throw new Error('egress proxy account lookup returned a malformed row');
    return mapProxyRow(row);
  }
  const result = await executor.query<RawProxyRow>(
    `SELECT proxy.id, proxy.name, proxy.protocol, proxy.host, proxy.port,
            proxy.auth_sealed_envelope, proxy.status, proxy.expires_at,
            proxy.fallback_mode, proxy.backup_proxy_id,
            proxy.last_probe_at, proxy.last_probe_latency_ms, proxy.last_probe_ip, proxy.last_probe_quality
       FROM ${ACCOUNT_TABLES.platform} AS account
       JOIN saas_egress_proxies AS proxy ON proxy.id = account.egress_proxy_id
      WHERE account.id = $1
      LIMIT 1`,
    [input.accountId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (!isRawProxyRow(row)) throw new Error('egress proxy account lookup returned a malformed row');
  return mapProxyRow(row);
}

/** Read one proxy by id (probe worker and expiry-sweep paths). */
export async function readEgressProxyById(executor: SqlExecutor, proxyId: string): Promise<EgressProxyRecord | null> {
  const result = await executor.query<RawProxyRow>(
    `SELECT id, name, protocol, host, port, auth_sealed_envelope, status, expires_at,
            fallback_mode, backup_proxy_id,
            last_probe_at, last_probe_latency_ms, last_probe_ip, last_probe_quality
       FROM saas_egress_proxies
      WHERE id = $1
      LIMIT 1`,
    [proxyId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (!isRawProxyRow(row)) throw new Error('egress proxy lookup returned a malformed row');
  return mapProxyRow(row);
}
