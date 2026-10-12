import { performance } from 'node:perf_hooks';
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
import type { SaasDatabase, SqlExecutor } from '../db/index.js';

/**
 * Track D4 provider quota sync worker (design:
 * docs/parallel-iteration-plan-2026-10-10.md Track D; migration 093).
 *
 * The worker periodically probes the upstream billing/quota endpoint of
 * adapter-supported provider accounts and overwrites the account row's quota
 * snapshot columns. The snapshot is a scheduling signal only: it never enters
 * the billing path and never authorizes a profit/cost failover decision.
 *
 * Fail-closed rules:
 * - only compile-time fixed (provider, product, credential type) bindings are
 *   probed; every other account is skipped in the due scan itself, so its
 *   snapshot stays NULL (unknown) and never hot-loops;
 * - any probe failure — network, timeout, redirect, unexpected status, or a
 *   malformed/oversized response — writes quota_state='unknown' and clears
 *   the amount; the worker never guesses a number it did not parse exactly;
 * - amounts are fixed-point minor units derived by exact decimal parsing
 *   (no binary floating point, no rounding, no exponent notation).
 *
 * Claim/lease semantics: each account is claimed, probed, and written in ONE
 * transaction. The claim is SELECT ... FOR UPDATE SKIP LOCKED, so replicas
 * never wait on each other, a crash rolls back and leaves the account due
 * (natural requeue), and the row lock held across the bounded probe is the
 * lease — there are no lease columns to expire. quota_checked_at is stamped
 * on every attempt (success or failure), which throttles retries of a
 * failing account to one probe per refresh interval.
 */

export const PROVIDER_QUOTA_PROBE_TIMEOUT_MS = 5_000;
export const PROVIDER_QUOTA_MAX_RESPONSE_BYTES = 4_096;
export const QUOTA_SYNC_POLL_INTERVAL_MS = 1_000;
export const QUOTA_SYNC_REFRESH_INTERVAL_MS = 1_800_000;

export type ProviderQuotaState = 'unknown' | 'ok' | 'low' | 'exhausted';

export type ProviderQuotaProbeErrorCode =
  | 'adapter_unsupported'
  | 'credential_format_invalid'
  | 'credential_unavailable'
  | 'credential_rejected'
  | 'provider_endpoint_unsupported'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected';

export interface ProviderQuotaProbeSuccess {
  readonly state: Exclude<ProviderQuotaState, 'unknown'>;
  /** Fixed-point minor units as decimal text: ^[0-9]{1,20}$. */
  readonly remainingMinorUnits: string;
  /** ISO 4217 uppercase alpha code carried next to the amount. */
  readonly currency: string;
  readonly adapterId: string;
  readonly httpStatus: number;
  readonly durationMs: number;
}

export interface ProviderQuotaProbeUnknown {
  readonly state: 'unknown';
  readonly errorCode: ProviderQuotaProbeErrorCode;
  readonly retryable: boolean;
  readonly adapterId: string | null;
  readonly httpStatus: number | null;
  readonly durationMs: number;
}

export type ProviderQuotaProbeResult = ProviderQuotaProbeSuccess | ProviderQuotaProbeUnknown;

export interface QuotaSyncAccountRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly purpose: string;
}

export type ProviderQuotaSyncFetch = (url: URL, init: RequestInit) => Promise<Response>;

interface FixedProviderQuotaAdapter {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly adapterId: string;
  readonly url: string;
  /** Fixed-point minor units; a remaining amount at or below this is 'low'. */
  readonly lowWatermarkMinorUnits: string;
}

/*
 * The only currently verified quota bindings. The single generic
 * OpenAI-style billing reader below parses the DeepSeek balance shape; every
 * product absent here is skipped by the due scan (fail-closed, never
 * guessed). The endpoint is an account-level billing read: it grants no
 * catalog capability, commercial right, or dispatch authority.
 * https://api-docs.deepseek.com/api/get-user-balance
 */
const FIXED_QUOTA_ADAPTERS: readonly FixedProviderQuotaAdapter[] = Object.freeze([
  Object.freeze({
    providerId: 'deepseek',
    productId: 'deepseek-chat',
    credentialType: 'api-key',
    adapterId: 'deepseek-balance-v1',
    url: 'https://api.deepseek.com/user/balance',
    lowWatermarkMinorUnits: '500',
  }),
  Object.freeze({
    providerId: 'deepseek',
    productId: 'deepseek-anthropic',
    credentialType: 'api-key',
    adapterId: 'deepseek-balance-v1',
    url: 'https://api.deepseek.com/user/balance',
    lowWatermarkMinorUnits: '500',
  }),
]);

function unknownResult(
  errorCode: ProviderQuotaProbeErrorCode,
  retryable: boolean,
  adapterId: string | null,
  httpStatus: number | null,
  durationMs: number,
): ProviderQuotaProbeUnknown {
  return { state: 'unknown', errorCode, retryable, adapterId, httpStatus, durationMs };
}

function resolveQuotaAdapter(account: {
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
}): FixedProviderQuotaAdapter | null {
  return (
    FIXED_QUOTA_ADAPTERS.find(
      (candidate) =>
        candidate.providerId === account.providerId &&
        candidate.productId === account.productId &&
        candidate.credentialType === account.credentialType,
    ) ?? null
  );
}

function canonicalAdapterUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== value
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function asciiCredential(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

/**
 * Exact decimal-to-minor-units conversion. Accepts a decimal string or a
 * JSON number rendered through String(); rejects exponent notation, signs,
 * more than two fraction digits (rounding would be guessing), and more than
 * ten integer digits. Returns canonical minor units (no leading zeros).
 */
export function quotaDecimalToMinorUnits(value: unknown): string | null {
  const text =
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (text === null) return null;
  const match = /^([0-9]{1,10})(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match) return null;
  const units = BigInt(match[1] as string);
  const fraction = match[2] === undefined ? 0n : BigInt(match[2].padEnd(2, '0'));
  return (units * 100n + fraction).toString();
}

export function deriveProviderQuotaState(
  remainingMinorUnits: string,
  lowWatermarkMinorUnits: string,
): 'ok' | 'low' | 'exhausted' {
  const remaining = BigInt(remainingMinorUnits);
  if (remaining === 0n) return 'exhausted';
  return remaining <= BigInt(lowWatermarkMinorUnits) ? 'low' : 'ok';
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

type BoundedBodyResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' }
  | { readonly state: 'timeout' };

async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<BoundedBodyResult> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const buffer = new Uint8Array(PROVIDER_QUOTA_MAX_RESPONSE_BYTES);
  let bytesRead = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer.subarray(0, bytesRead) };
      if (!(value instanceof Uint8Array)) {
        cancel();
        return { state: 'read_error' };
      }
      if (value.byteLength > PROVIDER_QUOTA_MAX_RESPONSE_BYTES - bytesRead) {
        cancel();
        return { state: 'too_large' };
      }
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    cancel();
    return { state: signal.aborted ? 'timeout' : 'read_error' };
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
}

/*
 * Generic OpenAI-style billing reader: one JSON object with exactly one
 * balance entry carrying a currency and an exact decimal total. A response
 * with multiple currency entries, a missing amount, or a non-decimal amount
 * is malformed and fails closed — mixing currencies or guessing a total is
 * never acceptable for a scheduling signal.
 */
function parseOpenAiStyleBalance(bytes: Uint8Array): { remainingMinorUnits: string; currency: string } | null {
  try {
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!body || !Array.isArray(body.balance_infos) || body.balance_infos.length !== 1) return null;
    const info = record(body.balance_infos[0]);
    if (!info || typeof info.currency !== 'string' || !/^[A-Z]{3}$/.test(info.currency)) return null;
    const remainingMinorUnits = quotaDecimalToMinorUnits(info.total_balance);
    if (remainingMinorUnits === null) return null;
    return { remainingMinorUnits, currency: info.currency };
  } catch {
    return null;
  }
}

/**
 * Probes the fixed upstream billing endpoint for one account. Every failure
 * mode returns state 'unknown'; this function never throws and never invents
 * an amount.
 */
export async function probeProviderQuota(
  account: { readonly providerId: string; readonly productId: string; readonly credentialType: string },
  secret: Buffer,
  fetcher: ProviderQuotaSyncFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<ProviderQuotaProbeResult> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const adapter = resolveQuotaAdapter(account);
  if (!adapter) return unknownResult('adapter_unsupported', false, null, null, 0);
  const url = canonicalAdapterUrl(adapter.url);
  if (!url) return unknownResult('adapter_unsupported', false, adapter.adapterId, null, 0);
  const token = asciiCredential(secret);
  if (token === null) return unknownResult('credential_format_invalid', false, adapter.adapterId, null, elapsed());

  const deadline = AbortSignal.timeout(PROVIDER_QUOTA_PROBE_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'model-router' },
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    const isTimeout = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    return unknownResult(
      isTimeout ? 'provider_timeout' : 'provider_network_error',
      true,
      adapter.adapterId,
      null,
      elapsed(),
    );
  }

  if (timeoutSignal.aborted) {
    cancelResponseBody(response);
    return unknownResult('provider_timeout', true, adapter.adapterId, response.status, elapsed());
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > PROVIDER_QUOTA_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return unknownResult('provider_response_too_large', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return unknownResult('provider_redirect_rejected', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.status < 200 || response.status >= 300) {
    cancelResponseBody(response);
    if (response.status === 401 || response.status === 403) {
      return unknownResult('credential_rejected', false, adapter.adapterId, response.status, elapsed());
    }
    if (response.status === 429) {
      return unknownResult('provider_rate_limited', true, adapter.adapterId, response.status, elapsed());
    }
    if (response.status >= 500) {
      return unknownResult('provider_unavailable', true, adapter.adapterId, response.status, elapsed());
    }
    return unknownResult('provider_endpoint_unsupported', false, adapter.adapterId, response.status, elapsed());
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    cancelResponseBody(response);
    return unknownResult('provider_response_invalid', false, adapter.adapterId, response.status, elapsed());
  }
  const bodyResult = await boundedResponseBody(response, timeoutSignal);
  if (bodyResult.state === 'too_large') {
    return unknownResult('provider_response_too_large', false, adapter.adapterId, response.status, elapsed());
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return unknownResult(
      bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error',
      true,
      adapter.adapterId,
      response.status,
      elapsed(),
    );
  }
  const parsed = parseOpenAiStyleBalance(bodyResult.bytes);
  if (!parsed) {
    return unknownResult('provider_response_invalid', false, adapter.adapterId, response.status, elapsed());
  }
  return {
    state: deriveProviderQuotaState(parsed.remainingMinorUnits, adapter.lowWatermarkMinorUnits),
    remainingMinorUnits: parsed.remainingMinorUnits,
    currency: parsed.currency,
    adapterId: adapter.adapterId,
    httpStatus: response.status,
    durationMs: elapsed(),
  };
}

export type QuotaSyncWorkerErrorCode = 'STORE_UNAVAILABLE' | 'LEASE_LOST';

export class QuotaSyncWorkerError extends Error {
  constructor(readonly code: QuotaSyncWorkerErrorCode) {
    super(code === 'LEASE_LOST' ? 'Quota sync claim is no longer current' : 'Quota sync store is unavailable');
    this.name = 'QuotaSyncWorkerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function workerError(code: QuotaSyncWorkerErrorCode): QuotaSyncWorkerError {
  return new QuotaSyncWorkerError(code);
}

function leaseLost(): never {
  throw workerError('LEASE_LOST');
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    throw workerError('STORE_UNAVAILABLE');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw workerError('STORE_UNAVAILABLE');
  return result;
}

function positiveBound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min) return min;
  return Math.min(value, max);
}

export type QuotaSyncOwnerKind = 'tenant' | 'platform';

interface QuotaSyncOwnerScope {
  readonly ownerKind: QuotaSyncOwnerKind;
  readonly supplyMode: 'byok' | 'platform';
  readonly accounts: string;
  readonly credentials: string;
  readonly versions: string;
  readonly wrappings: string;
}

const TENANT_OWNER_SCOPE: QuotaSyncOwnerScope = Object.freeze({
  ownerKind: 'tenant',
  supplyMode: 'byok',
  accounts: 'saas_tenant_provider_accounts',
  credentials: 'saas_tenant_provider_credentials',
  versions: 'saas_tenant_provider_credential_versions',
  wrappings: 'saas_tenant_provider_credential_wrappings',
});
const PLATFORM_OWNER_SCOPE: QuotaSyncOwnerScope = Object.freeze({
  ownerKind: 'platform',
  supplyMode: 'platform',
  accounts: 'saas_platform_provider_accounts',
  credentials: 'saas_platform_provider_credentials',
  versions: 'saas_platform_provider_credential_versions',
  wrappings: 'saas_platform_provider_credential_wrappings',
});
const QUOTA_SYNC_OWNER_SCOPES: Readonly<Record<QuotaSyncOwnerKind, QuotaSyncOwnerScope>> = Object.freeze({
  tenant: TENANT_OWNER_SCOPE,
  platform: PLATFORM_OWNER_SCOPE,
});

const DEFAULT_QUOTA_SYNC_OWNERS = ['tenant', 'platform'] as const satisfies readonly QuotaSyncOwnerKind[];

function ownerScopes(owners: readonly QuotaSyncOwnerKind[] | undefined): readonly QuotaSyncOwnerScope[] {
  if (owners !== undefined && (!Array.isArray(owners) || owners.length === 0)) {
    throw workerError('STORE_UNAVAILABLE');
  }
  const requested: readonly QuotaSyncOwnerKind[] = owners ?? DEFAULT_QUOTA_SYNC_OWNERS;
  const scopes: QuotaSyncOwnerScope[] = [];
  for (const owner of requested) {
    const scope = QUOTA_SYNC_OWNER_SCOPES[owner];
    if (scope === undefined || scopes.includes(scope)) throw workerError('STORE_UNAVAILABLE');
    scopes.push(scope);
  }
  return Object.freeze(scopes);
}

export interface PostgresQuotaSyncWorkerStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  /** Minimum age of the previous attempt before an account is due again. */
  readonly refreshIntervalMs?: number;
  /** Owner account tables scanned in poll order; tenant/BYOK first by default. */
  readonly owners?: readonly QuotaSyncOwnerKind[];
  /** Worker-owned lifetime; an abort rolls the in-flight claim back. */
  readonly signal?: AbortSignal;
}

export type QuotaSyncStoreOutcome =
  | { readonly outcome: 'idle' }
  | {
      readonly outcome: 'synced';
      readonly ownerKind: QuotaSyncOwnerKind;
      readonly accountId: string;
      readonly state: 'ok' | 'low' | 'exhausted';
    }
  | {
      readonly outcome: 'unknown';
      readonly ownerKind: QuotaSyncOwnerKind;
      readonly accountId: string;
      readonly errorCode: ProviderQuotaProbeErrorCode;
    };

interface ClaimedAccountRow {
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

const ADAPTER_PROVIDER_IDS = FIXED_QUOTA_ADAPTERS.map((adapter) => adapter.providerId);
const ADAPTER_PRODUCT_IDS = FIXED_QUOTA_ADAPTERS.map((adapter) => adapter.productId);
const ADAPTER_CREDENTIAL_TYPES = FIXED_QUOTA_ADAPTERS.map((adapter) => adapter.credentialType);

function validProbeSuccess(result: ProviderQuotaProbeResult): result is ProviderQuotaProbeSuccess {
  return (
    result.state !== 'unknown' &&
    (result.state === 'ok' || result.state === 'low' || result.state === 'exhausted') &&
    typeof (result as ProviderQuotaProbeSuccess).remainingMinorUnits === 'string' &&
    /^[0-9]{1,20}$/.test((result as ProviderQuotaProbeSuccess).remainingMinorUnits) &&
    typeof (result as ProviderQuotaProbeSuccess).currency === 'string' &&
    /^[A-Z]{3}$/.test((result as ProviderQuotaProbeSuccess).currency)
  );
}

/**
 * Claim, probe, and snapshot write run in one transaction per account: the
 * SKIP LOCKED row lock is the lease, a rollback is the requeue, and
 * quota_checked_at throttles every attempt. The plaintext credential exists
 * only inside the unseal callback and is wiped before the write.
 */
export class PostgresQuotaSyncWorkerStore {
  private readonly refreshIntervalMs: number;
  private readonly scopes: readonly QuotaSyncOwnerScope[];

  constructor(
    private readonly database: SaasDatabase,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: PostgresQuotaSyncWorkerStoreOptions,
  ) {
    if (!options || typeof options !== 'object') throw workerError('STORE_UNAVAILABLE');
    safeText(options.deployment);
    safeText(options.environment);
    this.scopes = ownerScopes(options.owners);
    this.refreshIntervalMs = positiveBound(
      options.refreshIntervalMs ?? QUOTA_SYNC_REFRESH_INTERVAL_MS,
      60_000,
      86_400_000,
    );
  }

  private async safeTransaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async (tx) => {
        if (this.options.signal?.aborted) leaseLost();
        const result = await work(tx);
        if (this.options.signal?.aborted) leaseLost();
        return result;
      });
    } catch (error) {
      if (error instanceof QuotaSyncWorkerError) throw error;
      throw workerError('STORE_UNAVAILABLE');
    }
  }

  async syncNext(
    probe: (account: QuotaSyncAccountRef, secret: Buffer) => Promise<ProviderQuotaProbeResult>,
  ): Promise<QuotaSyncStoreOutcome> {
    if (typeof probe !== 'function') throw workerError('STORE_UNAVAILABLE');
    for (const scope of this.scopes) {
      const outcome = await this.syncNextInScope(scope, probe);
      if (outcome !== null) return outcome;
    }
    return { outcome: 'idle' };
  }

  private async syncNextInScope(
    scope: QuotaSyncOwnerScope,
    probe: (account: QuotaSyncAccountRef, secret: Buffer) => Promise<ProviderQuotaProbeResult>,
  ): Promise<QuotaSyncStoreOutcome | null> {
    return this.safeTransaction(async (tx) => {
      const tenantPredicate = scope.ownerKind === 'tenant' ? 'account.tenant_id, ' : '';
      const duePredicate = `
          AND account.status = 'active' AND account.validation_state = 'verified'
          AND (account.provider_id, account.product_id, account.credential_type) IN (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
          )
          AND (account.quota_checked_at IS NULL
            OR account.quota_checked_at <= clock_timestamp() - ($4 * interval '1 millisecond'))`;
      const candidates = await tx.query<ClaimedAccountRow>(
        `SELECT ${tenantPredicate}account.id, account.provider_id, account.product_id,
                account.credential_type, account.purpose
           FROM ${scope.accounts} AS account
          WHERE TRUE${duePredicate}
          ORDER BY account.quota_checked_at ASC NULLS FIRST, account.id
          LIMIT 1`,
        [ADAPTER_PROVIDER_IDS, ADAPTER_PRODUCT_IDS, ADAPTER_CREDENTIAL_TYPES, this.refreshIntervalMs],
      );
      const candidate = candidates.rows[0];
      if (!candidate) return null;

      const locked = await tx.query<ClaimedAccountRow>(
        scope.ownerKind === 'tenant'
          ? `SELECT account.tenant_id, account.id, account.provider_id, account.product_id,
                    account.credential_type, account.purpose
               FROM ${scope.accounts} AS account
              WHERE account.tenant_id = $5 AND account.id = $6${duePredicate}
              FOR UPDATE SKIP LOCKED`
          : `SELECT account.id, account.provider_id, account.product_id,
                    account.credential_type, account.purpose
               FROM ${scope.accounts} AS account
              WHERE account.id = $5${duePredicate}
              FOR UPDATE SKIP LOCKED`,
        scope.ownerKind === 'tenant'
          ? [
              ADAPTER_PROVIDER_IDS,
              ADAPTER_PRODUCT_IDS,
              ADAPTER_CREDENTIAL_TYPES,
              this.refreshIntervalMs,
              candidate.tenant_id,
              candidate.id,
            ]
          : [ADAPTER_PROVIDER_IDS, ADAPTER_PRODUCT_IDS, ADAPTER_CREDENTIAL_TYPES, this.refreshIntervalMs, candidate.id],
      );
      const row = locked.rows[0];
      if (!row) return null;

      const account: QuotaSyncAccountRef = Object.freeze({
        ownerKind: scope.ownerKind,
        tenantId: scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null,
        accountId: safeText(row.id),
        providerId: safeText(row.provider_id),
        productId: safeText(row.product_id),
        credentialType: safeText(row.credential_type),
        purpose: safeText(row.purpose),
      });

      let result: ProviderQuotaProbeResult;
      try {
        result = await this.probeWithCurrentCredential(tx, scope, account, probe);
      } catch (error) {
        if (error instanceof QuotaSyncWorkerError) throw error;
        result = unknownResult('provider_network_error', true, null, null, 0);
      }
      if (this.options.signal?.aborted) leaseLost();
      if (!validProbeSuccess(result) && result.state !== 'unknown') {
        result = unknownResult('provider_response_invalid', false, null, null, 0);
      }

      if (result.state === 'unknown') {
        await tx.query(
          scope.ownerKind === 'tenant'
            ? `UPDATE ${scope.accounts}
                  SET quota_state = 'unknown', quota_remaining_minor_units = NULL, quota_currency = NULL,
                      quota_checked_at = clock_timestamp(), updated_at = clock_timestamp()
                WHERE tenant_id = $1 AND id = $2`
            : `UPDATE ${scope.accounts}
                  SET quota_state = 'unknown', quota_remaining_minor_units = NULL, quota_currency = NULL,
                      quota_checked_at = clock_timestamp(), updated_at = clock_timestamp()
                WHERE id = $1`,
          scope.ownerKind === 'tenant' ? [account.tenantId, account.accountId] : [account.accountId],
        );
        return {
          outcome: 'unknown',
          ownerKind: scope.ownerKind,
          accountId: account.accountId,
          errorCode: result.errorCode,
        };
      }
      await tx.query(
        scope.ownerKind === 'tenant'
          ? `UPDATE ${scope.accounts}
                SET quota_state = $3, quota_remaining_minor_units = $4, quota_currency = $5,
                    quota_checked_at = clock_timestamp(), updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2`
          : `UPDATE ${scope.accounts}
                SET quota_state = $2, quota_remaining_minor_units = $3, quota_currency = $4,
                    quota_checked_at = clock_timestamp(), updated_at = clock_timestamp()
              WHERE id = $1`,
        scope.ownerKind === 'tenant'
          ? [account.tenantId, account.accountId, result.state, result.remainingMinorUnits, result.currency]
          : [account.accountId, result.state, result.remainingMinorUnits, result.currency],
      );
      return { outcome: 'synced', ownerKind: scope.ownerKind, accountId: account.accountId, state: result.state };
    });
  }

  /**
   * Unseals the account's current verified credential and invokes the probe.
   * Unavailable or inconsistent credential authority is an 'unknown' probe
   * outcome, never a store failure; the account row lock is already held.
   */
  private async probeWithCurrentCredential(
    tx: SqlExecutor,
    scope: QuotaSyncOwnerScope,
    account: QuotaSyncAccountRef,
    probe: (account: QuotaSyncAccountRef, secret: Buffer) => Promise<ProviderQuotaProbeResult>,
  ): Promise<ProviderQuotaProbeResult> {
    const credentials = await tx.query<CurrentCredentialRow>(
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
        ? [account.tenantId, account.accountId, account.providerId, account.productId, account.credentialType]
        : [account.accountId, account.providerId, account.productId, account.credentialType],
    );
    const credential = credentials.rows[0];
    if (!credential) return unknownResult('credential_unavailable', false, null, null, 0);
    const credentialId = safeText(credential.id);
    const credentialVersion = positiveInteger(credential.current_version);

    const versions = await tx.query<LockedVersionRow>(
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
        ? [account.tenantId, account.accountId, credentialId, credentialVersion]
        : [account.accountId, credentialId, credentialVersion],
    );
    const version = versions.rows[0];
    if (!version || version.kms_purpose !== account.purpose) {
      return unknownResult('credential_unavailable', false, null, null, 0);
    }
    if (
      positiveInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      positiveInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return unknownResult('credential_unavailable', false, null, null, 0);
    }

    const context: ProviderCredentialContext = createProviderCredentialContext(
      scope.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: account.purpose,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            accountId: account.accountId,
            credentialId,
            credentialVersion,
          }
        : {
            ownerKind: 'tenant',
            tenantId: account.tenantId as string,
            supplyMode: 'byok',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: account.purpose,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            accountId: account.accountId,
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

    let result: ProviderQuotaProbeResult | undefined;
    try {
      await withUnsealedProviderCredential(envelope, context, this.kms, async (secret) => {
        try {
          result = await probe(account, secret);
        } catch {
          result = unknownResult('provider_network_error', true, null, null, 0);
        }
      });
    } catch {
      return unknownResult('credential_unavailable', false, null, null, 0);
    }
    return result ?? unknownResult('credential_unavailable', false, null, null, 0);
  }
}

export interface QuotaSyncWorkerOptions extends PostgresQuotaSyncWorkerStoreOptions {
  readonly pollIntervalMs?: number;
  /** Test/custom seam; production uses the global fetch with fixed adapter URLs. */
  readonly fetch?: ProviderQuotaSyncFetch;
  /** Receives only a stable cycle code; never provider or credential data. */
  readonly onError?: (code: 'cycle_failed') => void;
}

export type QuotaSyncWorkerResult = 'idle' | 'processed' | 'stale';

export class QuotaSyncWorker {
  private readonly store: PostgresQuotaSyncWorkerStore;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<QuotaSyncWorkerResult>>();
  private closePromise?: Promise<void>;

  constructor(
    database: SaasDatabase,
    kms: ProviderCredentialUnsealingKms,
    private readonly options: QuotaSyncWorkerOptions,
  ) {
    this.options = Object.freeze({ ...options });
    this.store = new PostgresQuotaSyncWorkerStore(database, kms, {
      ...this.options,
      signal: this.halt.signal,
    });
  }

  async runOnce(): Promise<QuotaSyncWorkerResult> {
    if (this.halt.signal.aborted) return 'stale';
    const run = this.processOnce();
    this.activeRuns.add(run);
    try {
      return await run;
    } catch (error) {
      if (this.halt.signal.aborted) return 'stale';
      throw error;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async processOnce(): Promise<QuotaSyncWorkerResult> {
    try {
      const outcome = await this.store.syncNext((account, secret) => {
        if (this.halt.signal.aborted) leaseLost();
        return probeProviderQuota(account, secret, this.options.fetch, this.halt.signal);
      });
      if (this.halt.signal.aborted) return 'stale';
      return outcome.outcome === 'idle' ? 'idle' : 'processed';
    } catch (error) {
      if (this.halt.signal.aborted) return 'stale';
      if (error instanceof QuotaSyncWorkerError && error.code === 'LEASE_LOST') return 'stale';
      throw error;
    }
  }

  async run(): Promise<void> {
    const pollIntervalMs = positiveBound(this.options.pollIntervalMs ?? QUOTA_SYNC_POLL_INTERVAL_MS, 100, 60_000);
    while (!this.halt.signal.aborted) {
      try {
        const result = await this.runOnce();
        if (result === 'idle') await delay(pollIntervalMs, this.halt.signal);
      } catch {
        try {
          this.options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate quota processing.
        }
        await delay(pollIntervalMs, this.halt.signal);
      }
    }
  }

  /** Aborts in-flight probes and drains actual runs before KMS/database close. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns]).then(() => undefined);
    return this.closePromise;
  }
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface QuotaSyncWorkerHandle {
  close(): Promise<void>;
}

export function startQuotaSyncWorker(
  database: SaasDatabase,
  kms: ProviderCredentialUnsealingKms,
  options: QuotaSyncWorkerOptions,
): QuotaSyncWorkerHandle {
  const worker = new QuotaSyncWorker(database, kms, options);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    const pollIntervalMs = positiveBound(options.pollIntervalMs ?? QUOTA_SYNC_POLL_INTERVAL_MS, 100, 60_000);
    while (!closed) {
      try {
        const result = await worker.runOnce();
        if (closed) break;
        if (result === 'idle') await delayWithClose(pollIntervalMs);
      } catch {
        if (closed) break;
        try {
          options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate quota processing.
        }
        await delayWithClose(pollIntervalMs);
      }
    }
  };
  let done: Promise<void>;
  done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      const closeWorker = worker.close();
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await Promise.all([closeWorker, done]);
    },
  };
}
