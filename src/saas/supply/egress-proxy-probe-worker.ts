import { randomUUID } from 'node:crypto';
import type { Dispatcher } from 'undici';
import type { ProviderCredentialUnsealingKms } from '../credentials/provider-crypto.js';
import type { SaasDatabase } from '../db/index.js';
import type { ProviderHttpEgressAllowlist, ProviderHttpPinnedConnector } from '../gateway/provider-http-address.js';
import { createProviderEgressProxyConnection } from '../gateway/provider-http-address.js';
import type { EgressProxyRecord } from './egress-proxy-lookup.js';
import { assembleEgressProxyUrl } from './egress-proxy-record.js';
import { withUnsealedEgressProxyCredentials } from './egress-proxy-seal.js';

/**
 * R3 egress proxies (docs/token-resale-implementation-plan-2026-10-15.md
 * §R3): the probe + expiry-sweep worker (sub2api's proxy probe service and
 * SweepExpiredProxies ticker, on this repo's worker conventions).
 *
 * Probe semantics:
 * - The two fixed probe endpoints (ip-api.com/json and api64.ipify.org, both
 *   deployment-owned constants — never request-derived) are requested
 *   THROUGH the proxy itself, so the recorded exit IP is the IP the provider
 *   sees. Bounded: 10s per request, 1 MiB response cap (sub2api limits).
 * - Quality: any success → 'ok' under the degraded-latency threshold,
 *   'degraded' at/above it; no success → 'dead'.
 * - Claim/lease: one proxy is claimed, probed and written in ONE transaction
 *   (SELECT ... FOR UPDATE SKIP LOCKED) — the repo's established lease
 *   pattern (quota-sync, oauth-refresh): replicas never wait on each other
 *   and a crash rolls the probe back to due.
 *
 * Sweep semantics (runs on the same worker cadence):
 * - An active proxy whose expires_at passed transitions to status='expired'.
 * - Accounts migrate per fallback_mode: none = audit alert only (accounts
 *   stay bound — the operator decides), proxy = rebind to the cycle-safe
 *   backup chain resolution, direct = unbind. Every migrated account records
 *   proxy_fallback_origin_id for manual rollback.
 * - Quality is a scheduling signal, never removal: dead proxies demote the
 *   bound accounts' scheduling weight (read by the gateway eligibility
 *   query); expiry migration is the only rebind path, so probe jitter cannot
 *   trigger account migration storms.
 *
 * Red lines: proxy credentials are unsealed only inside the KMS callback and
 * exist as the assembled URL for the lifetime of one probe; error paths and
 * logs never contain the URL or credentials.
 */

const DEFAULT_PROBE_PRIMARY_URL = 'http://ip-api.com/json/';
const DEFAULT_PROBE_SECONDARY_URL = 'https://api64.ipify.org?format=json';
const DEFAULT_PROBE_INTERVAL_MS = 300_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PROBE_RESPONSE_BYTES = 1_048_576;
const DEFAULT_DEGRADED_LATENCY_MS = 2_000;
const PROBE_ROUND_CAP = 10;
const AUDIT_ENTRY_POINT = 'egress-proxy-probe-worker';

export type EgressProxyProbeQuality = 'ok' | 'degraded' | 'dead';

export interface EgressProxyProbeOutcome {
  readonly quality: EgressProxyProbeQuality;
  readonly latencyMs: number | null;
  readonly ip: string | null;
  readonly country: string | null;
}

export type EgressProxyProbeFetchInit = RequestInit & {
  readonly dispatcher?: Dispatcher;
};

export type EgressProxyProbeFetch = (url: string, init: EgressProxyProbeFetchInit) => Promise<Response>;

/** Test seam over the egress dispatcher factory; production uses the real connector. */
export type EgressProxyProbeConnectionFactory = typeof createProviderEgressProxyConnection;

export interface PostgresEgressProxyProbeWorkerStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly probeIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxProbeResponseBytes?: number;
  readonly degradedLatencyMs?: number;
  readonly probeUrls?: { readonly primary: string; readonly secondary: string };
  /** Test/custom seam; production uses the global fetch. */
  readonly fetch?: EgressProxyProbeFetch;
  /** Test seam; production uses createProviderEgressProxyConnection. */
  readonly createConnection?: EgressProxyProbeConnectionFactory;
  /**
   * R9 §4 P1: operator-configured egress allowlist shared with the gateway
   * dispatch transport. Validated CIDR entries additionally permit otherwise
   * denied proxy addresses (container-network proxies). Unset keeps the exact
   * global-only fail-closed posture.
   */
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export class EgressProxyProbeWorkerError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'INVALID_INPUT') {
    super(
      code === 'STORE_UNAVAILABLE' ? 'egress proxy probe store is unavailable' : 'egress proxy probe input is invalid',
    );
    this.name = 'EgressProxyProbeWorkerError';
  }
}

function fail(code: 'STORE_UNAVAILABLE' | 'INVALID_INPUT'): never {
  throw new EgressProxyProbeWorkerError(code);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) fail('INVALID_INPUT');
  return candidate;
}

function safeText(value: unknown, maxBytes = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxBytes) {
    fail('STORE_UNAVAILABLE');
  }
  return value;
}

function probeUrl(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('INVALID_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_INPUT');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    fail('INVALID_INPUT');
  }
  return parsed.toString();
}

function isStoredProxyRow(value: unknown): value is StoredProxyRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.protocol === 'string' &&
    typeof row.host === 'string' &&
    typeof row.port === 'number' &&
    typeof row.status === 'string' &&
    typeof row.fallback_mode === 'string'
  );
}

function proxyIsActive(proxy: EgressProxyRecord): boolean {
  return proxy.status === 'active';
}

function proxyIsExpired(proxy: EgressProxyRecord, now: Date): boolean {
  if (proxy.expiresAt === null) return false;
  const expires = Date.parse(proxy.expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

/**
 * Compute where an expired proxy's accounts should go (sub2api's
 * ResolveProxyFallbackTarget, cycle-safe): change=false leaves accounts
 * untouched (mode none, or an unresolvable chain — cycle/all-expired);
 * change=true + null target = direct; change=true + id = that backup.
 */
export function resolveEgressProxyFallbackTarget(
  start: Pick<EgressProxyRecord, 'id' | 'fallbackMode' | 'backupProxyId'>,
  byId: ReadonlyMap<string, EgressProxyRecord>,
  now: Date,
): { readonly targetProxyId: string | null; readonly change: boolean } {
  if (start.fallbackMode === 'direct') return { targetProxyId: null, change: true };
  if (start.fallbackMode !== 'proxy') return { targetProxyId: null, change: false };
  const visited = new Set<string>([start.id]);
  let current: string | null = start.backupProxyId;
  while (current !== null) {
    if (visited.has(current)) return { targetProxyId: null, change: false };
    const proxy = byId.get(current);
    if (proxy === undefined) return { targetProxyId: null, change: false };
    if (proxyIsActive(proxy) && !proxyIsExpired(proxy, now)) {
      return { targetProxyId: current, change: true };
    }
    visited.add(current);
    if (proxy.fallbackMode === 'direct') return { targetProxyId: null, change: true };
    if (proxy.fallbackMode !== 'proxy') return { targetProxyId: null, change: false };
    current = proxy.backupProxyId;
  }
  return { targetProxyId: null, change: false };
}

interface RawProbeCandidateRow {
  readonly id: string;
  readonly auth_sealed_envelope: unknown;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
}

async function readBoundedProbeBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(new Error('probe response exceeded the size limit')).catch(() => undefined);
        return '';
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released by the cancel path.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseProbeIp(bodyText: string): { ip: string | null; country: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ip: null, country: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ip: null, country: null };
  const record = parsed as Record<string, unknown>;
  const ip = typeof record.ip === 'string' && record.ip !== '' ? record.ip : null;
  const country = typeof record.country === 'string' && record.country !== '' ? record.country : null;
  return { ip, country };
}

interface StoredProxyRow {
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
}

function toRecord(row: StoredProxyRow): EgressProxyRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    authSealedEnvelope: row.auth_sealed_envelope,
    status: row.status,
    expiresAt:
      row.expires_at === null
        ? null
        : row.expires_at instanceof Date
          ? row.expires_at.toISOString()
          : String(row.expires_at),
    fallbackMode: row.fallback_mode,
    backupProxyId: row.backup_proxy_id,
    lastProbeAt: null,
    lastProbeLatencyMs: null,
    lastProbeIp: null,
    lastProbeQuality: null,
  };
}

const PROXY_SELECT_COLUMNS = `id, name, protocol, host, port, auth_sealed_envelope, status, expires_at, fallback_mode, backup_proxy_id`;

export class PostgresEgressProxyProbeWorkerStore {
  private readonly database: SaasDatabase;
  private readonly kms: ProviderCredentialUnsealingKms;
  private readonly options: {
    readonly deployment: string;
    readonly environment: string;
    readonly probeIntervalMs: number;
    readonly probeTimeoutMs: number;
    readonly maxProbeResponseBytes: number;
    readonly degradedLatencyMs: number;
    readonly probeUrls: { readonly primary: string; readonly secondary: string };
    readonly fetch: EgressProxyProbeFetch;
    readonly createConnection: EgressProxyProbeConnectionFactory;
    readonly egressAllowlist?: ProviderHttpEgressAllowlist;
    readonly now: () => Date;
    readonly signal?: AbortSignal;
  };

  constructor(
    database: SaasDatabase,
    kms: ProviderCredentialUnsealingKms,
    options: PostgresEgressProxyProbeWorkerStoreOptions,
  ) {
    if (!options || typeof options !== 'object') fail('STORE_UNAVAILABLE');
    if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
      fail('STORE_UNAVAILABLE');
    }
    if (!kms || typeof kms.decryptDataKey !== 'function') fail('STORE_UNAVAILABLE');
    const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    if (typeof fetcher !== 'function') fail('INVALID_INPUT');
    const connectionFactory = options.createConnection ?? createProviderEgressProxyConnection;
    if (typeof connectionFactory !== 'function') fail('INVALID_INPUT');
    if (
      options.egressAllowlist !== undefined &&
      (typeof options.egressAllowlist.allows !== 'function' || !Array.isArray(options.egressAllowlist.entries))
    ) {
      fail('INVALID_INPUT');
    }
    this.database = database;
    this.kms = kms;
    this.options = {
      deployment: safeText(options.deployment),
      environment: safeText(options.environment),
      probeIntervalMs: boundedInteger(options.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS, 10_000, 86_400_000),
      probeTimeoutMs: boundedInteger(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 1_000, 60_000),
      maxProbeResponseBytes: boundedInteger(
        options.maxProbeResponseBytes,
        DEFAULT_MAX_PROBE_RESPONSE_BYTES,
        256,
        16 * 1_048_576,
      ),
      degradedLatencyMs: boundedInteger(options.degradedLatencyMs, DEFAULT_DEGRADED_LATENCY_MS, 1, 3_600_000),
      probeUrls: {
        primary: probeUrl(options.probeUrls?.primary ?? DEFAULT_PROBE_PRIMARY_URL),
        secondary: probeUrl(options.probeUrls?.secondary ?? DEFAULT_PROBE_SECONDARY_URL),
      },
      fetch: fetcher,
      createConnection: connectionFactory,
      ...(options.egressAllowlist === undefined ? {} : { egressAllowlist: options.egressAllowlist }),
      now: options.now ?? (() => new Date()),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  /** Probe one due proxy; returns false when nothing was due. */
  async probeNext(): Promise<boolean> {
    const duePredicate = `
       AND status = 'active'
       AND (last_probe_at IS NULL
            OR last_probe_at <= clock_timestamp() - ($1 * interval '1 millisecond'))`;
    return this.database.transaction(async (tx) => {
      const candidates = await tx.query<RawProbeCandidateRow>(
        `SELECT id FROM saas_egress_proxies WHERE TRUE${duePredicate}
          ORDER BY last_probe_at ASC NULLS FIRST, id LIMIT 1`,
        [this.options.probeIntervalMs],
      );
      const candidate = candidates.rows[0];
      if (candidate === undefined) return false;
      const locked = await tx.query<RawProbeCandidateRow>(
        `SELECT id, auth_sealed_envelope, protocol, host, port
           FROM saas_egress_proxies
          WHERE id = $2${duePredicate}
          FOR UPDATE SKIP LOCKED`,
        [this.options.probeIntervalMs, candidate.id],
      );
      const row = locked.rows[0];
      if (row === undefined) return false;

      const outcome = await this.probeProxy(row);
      await tx.query(
        `UPDATE saas_egress_proxies
            SET last_probe_at = clock_timestamp(),
                last_probe_latency_ms = $2,
                last_probe_ip = $3::inet,
                last_probe_quality = $4,
                updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'active'`,
        [row.id, outcome.latencyMs, outcome.ip, outcome.quality],
      );
      return true;
    });
  }

  /**
   * Run one probe round through the proxy itself. Never throws: every
   * failure maps to quality 'dead' (the scheduling-weight signal), and the
   * error text is discarded so no credential fragment can leak.
   */
  private async probeProxy(row: RawProbeCandidateRow): Promise<EgressProxyProbeOutcome> {
    let connection: ProviderHttpPinnedConnector | null = null;
    try {
      const proxyUrl = await withUnsealedEgressProxyCredentials(
        row.auth_sealed_envelope,
        { deployment: this.options.deployment, environment: this.options.environment, proxyId: row.id },
        this.kms,
        (credentials) =>
          assembleEgressProxyUrl({
            protocol: row.protocol,
            host: row.host,
            port: row.port,
            ...(credentials.username === undefined ? {} : { username: credentials.username }),
            ...(credentials.password === undefined ? {} : { password: credentials.password }),
          }).url,
      );
      connection = await this.options.createConnection(
        { url: proxyUrl },
        {
          ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
          ...(this.options.egressAllowlist === undefined ? {} : { egressAllowlist: this.options.egressAllowlist }),
        },
      );
      const dispatcher = connection.dispatcher;
      const fetcher = this.options.fetch;
      const timeoutMs = this.options.probeTimeoutMs;
      const maxBytes = this.options.maxProbeResponseBytes;
      const probeOnce = async (
        url: string,
      ): Promise<{ latencyMs: number; ip: string | null; country: string | null } | null> => {
        const started = performance.now();
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = this.options.signal === undefined ? deadline : AbortSignal.any([deadline, this.options.signal]);
        const response = await fetcher(url, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { accept: 'application/json' },
          dispatcher,
        });
        if (response.status < 200 || response.status >= 300) return null;
        const bodyText = await readBoundedProbeBody(response, maxBytes);
        const { ip, country } = parseProbeIp(bodyText);
        if (ip === null) return null;
        return { latencyMs: Math.max(0, Math.round(performance.now() - started)), ip, country };
      };
      const primary = await probeOnce(this.options.probeUrls.primary);
      const result = primary ?? (await probeOnce(this.options.probeUrls.secondary));
      if (result === null) return { quality: 'dead', latencyMs: null, ip: null, country: null };
      return {
        quality: result.latencyMs >= this.options.degradedLatencyMs ? 'degraded' : 'ok',
        latencyMs: result.latencyMs,
        ip: result.ip,
        country: result.country,
      };
    } catch {
      return { quality: 'dead', latencyMs: null, ip: null, country: null };
    } finally {
      if (connection !== null) {
        const captured = connection;
        connection = null;
        void captured.close().catch(() => undefined);
      }
    }
  }

  /**
   * Expiry sweep: transition expired active proxies to 'expired' and migrate
   * their accounts per fallback_mode. Returns the number of accounts whose
   * egress binding changed (0 when only alerts fired).
   */
  async sweepExpiredProxies(): Promise<number> {
    const now = this.options.now();
    const snapshot = await this.database.query<StoredProxyRow>(
      `SELECT ${PROXY_SELECT_COLUMNS} FROM saas_egress_proxies`,
    );
    const byId = new Map<string, EgressProxyRecord>();
    for (const row of snapshot.rows) {
      if (!isStoredProxyRow(row)) continue;
      byId.set(row.id, toRecord(row));
    }
    let changedAccounts = 0;
    for (const proxy of byId.values()) {
      if (!proxyIsActive(proxy) || !proxyIsExpired(proxy, now)) continue;
      const fallback = resolveEgressProxyFallbackTarget(proxy, byId, now);
      if (!fallback.change && proxy.fallbackMode === 'proxy') {
        // Configured backup chain is unresolvable (cycle / all expired):
        // alert only, keep the accounts bound.
        await this.appendSweepAuditEvent(proxy.id, 'saas_egress_proxy.expiry_fallback_unresolved', 0);
        continue;
      }
      changedAccounts += await this.sweepOneExpiredProxy(proxy, fallback);
    }
    return changedAccounts;
  }

  private async sweepOneExpiredProxy(
    proxy: EgressProxyRecord,
    fallback: { readonly targetProxyId: string | null; readonly change: boolean },
  ): Promise<number> {
    return this.database.transaction(async (tx) => {
      const claimed = await tx.query<{ readonly id: string }>(
        `SELECT id FROM saas_egress_proxies
          WHERE id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
          FOR UPDATE SKIP LOCKED`,
        [proxy.id],
      );
      if (claimed.rows.length === 0) return 0;
      await tx.query(
        `UPDATE saas_egress_proxies SET status = 'expired', updated_at = clock_timestamp() WHERE id = $1`,
        [proxy.id],
      );
      if (!fallback.change) {
        await this.appendSweepAuditEvent(proxy.id, 'saas_egress_proxy.expiry_alert', 0);
        return 0;
      }
      let changed = 0;
      for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts'] as const) {
        const result = await tx.query(
          `UPDATE ${table}
              SET egress_proxy_id = $2,
                  proxy_fallback_origin_id = $1,
                  updated_at = clock_timestamp()
            WHERE egress_proxy_id = $1`,
          [proxy.id, fallback.targetProxyId],
        );
        changed += result.rowCount ?? 0;
      }
      await this.appendSweepAuditEvent(
        proxy.id,
        fallback.targetProxyId === null
          ? 'saas_egress_proxy.expiry_migrated_direct'
          : 'saas_egress_proxy.expiry_migrated_proxy',
        changed,
      );
      return changed;
    });
  }

  private async appendSweepAuditEvent(proxyId: string, action: string, _changedAccounts: number): Promise<void> {
    await this.database
      .query(
        `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, NULL, NULL, $2, 'saas_egress_proxies', $3, clock_timestamp(), $4)`,
        [randomUUID(), action, proxyId, AUDIT_ENTRY_POINT],
      )
      .catch(() => undefined);
  }
}

export interface EgressProxyProbeWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly onError?: (code: 'cycle_failed') => void;
}

export interface EgressProxyProbeWorkerHandle {
  readonly close: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class EgressProxyProbeWorker {
  private readonly store: PostgresEgressProxyProbeWorkerStore;
  private readonly pollIntervalMs: number;
  private readonly onError?: (code: 'cycle_failed') => void;

  constructor(store: PostgresEgressProxyProbeWorkerStore, options: EgressProxyProbeWorkerOptions = {}) {
    this.store = store;
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1_000, 3_600_000);
    this.onError = options.onError;
  }

  /** One bounded probe round plus one expiry sweep; returns probed proxy count. */
  async runOnce(): Promise<number> {
    let probed = 0;
    for (let index = 0; index < PROBE_ROUND_CAP; index += 1) {
      const worked = await this.store.probeNext();
      if (!worked) break;
      probed += 1;
    }
    await this.store.sweepExpiredProxies();
    return probed;
  }

  async run(closed: () => boolean, delay: (durationMs: number) => Promise<void>): Promise<void> {
    while (!closed()) {
      try {
        await this.runOnce();
      } catch {
        this.onError?.('cycle_failed');
      }
      if (closed()) break;
      await delay(this.pollIntervalMs);
    }
  }
}

export function startEgressProxyProbeWorker(
  store: PostgresEgressProxyProbeWorkerStore,
  options: EgressProxyProbeWorkerOptions = {},
): EgressProxyProbeWorkerHandle {
  const worker = new EgressProxyProbeWorker(store, options);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const closed = (): boolean => stopped;
  const delay = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = worker.run(closed, delay);
  return {
    async close() {
      if (stopped) return loop;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await loop;
    },
  };
}
