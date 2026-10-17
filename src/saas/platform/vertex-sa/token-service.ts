import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import {
  createProviderCredentialContext,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialUnsealingKms,
  withUnsealedProviderCredential,
} from '../../credentials/provider-crypto.js';
import type { SqlExecutor } from '../../db/index.js';
import {
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
} from '../../gateway/vertex/catalog-identity.js';
import {
  VERTEX_ASSERTION_LIFETIME_MS,
  VERTEX_CLOUD_PLATFORM_SCOPE,
  VERTEX_JWT_BEARER_GRANT_TYPE,
  VERTEX_TOKEN_CACHE_SKEW_MS,
  VERTEX_TOKEN_DEFAULT_TTL_MS,
  VERTEX_TOKEN_URL,
} from '../../gateway/vertex/constants.js';
import { type VertexServiceAccountKey, vertexServiceAccountKeyFromEnvelopeMaterial } from './service-account.js';

/**
 * Batch-3 Vertex SA JWT→OAuth token exchange (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's exchangeVertexServiceAccountToken plus the 094
 * oauth-refresh-worker's claim/lease semantics). The RS256 assertion is
 * signed with node:crypto natively — zero new dependencies.
 *
 * Distributed refresh: the gateway topology contract has no Redis, so the
 * exchange's distributed lock REUSES the 094 pattern verbatim — the
 * credential row's oauth_* lease columns claimed with
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside one transaction that also
 * unseals the envelope and performs the bounded token call (the row lock is
 * the lease; a crash rolls back and leaves the row due; a stale
 * 'refreshing' row is reclaimed after `staleRefreshingMs`). The rotated
 * envelope (SA fields passthrough + fresh access_token/expires_at) is
 * written ONLY through the injected rotation seam — the same
 * `OauthCredentialRotator` contract the 094 worker uses, so production
 * wires the persistence service's audited
 * replaceProviderCredentialSecretWithAudit and every rotation rides the
 * version chain, the 058 invalidation family and the D3 revalidation
 * requeue unchanged.
 *
 * Token lifetime: `expires_in` minus the 5-minute cache skew (sub2api
 * vertexServiceAccountCacheSkew), so a token is treated as stale before
 * Google would reject it.
 */

export const VERTEX_SA_TOKEN_TIMEOUT_MS = 15_000;
export const VERTEX_SA_TOKEN_MAX_RESPONSE_BYTES = 8_192;
export const VERTEX_SA_STALE_REFRESHING_MS = 900_000;
export const VERTEX_SA_MIN_BACKOFF_MS = 60_000;
export const VERTEX_SA_MAX_BACKOFF_MS = 3_600_000;
/** sub2api vertexLockWaitTime: how long a lock loser waits before re-reading. */
export const VERTEX_SA_LOCK_WAIT_MS = 200;

export type VertexSaTokenErrorCode =
  | 'ASSERTION_SIGN_FAILED'
  | 'TOKEN_ENDPOINT_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'ROTATION_FAILED'
  | 'ROTATION_CONFLICT'
  | 'STORE_UNAVAILABLE'
  | 'TIMEOUT';

export class VertexSaTokenError extends Error {
  constructor(
    readonly code: VertexSaTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VertexSaTokenError';
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Signs `${headerB64}.${claimsB64}` with RS256 (node:crypto, no dependencies). */
export type VertexSaAssertionSigner = (signingInput: string, privateKeyPem: string) => string;

function defaultAssertionSigner(signingInput: string, privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new VertexSaTokenError('ASSERTION_SIGN_FAILED', 'the service account private key is not parseable');
  }
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  try {
    return signer.sign(key, 'base64url');
  } catch {
    throw new VertexSaTokenError('ASSERTION_SIGN_FAILED', 'the service account assertion could not be signed');
  }
}

/**
 * Builds the signed RS256 JWT assertion (sub2api
 * exchangeVertexServiceAccountToken claims): iss=client_email,
 * scope=cloud-platform, aud=token_uri (the pinned endpoint), iat=now,
 * exp=now+1h; header kid=private_key_id when present.
 */
export function buildVertexSaAssertion(
  key: VertexServiceAccountKey,
  nowMs: number = Date.now(),
  sign: VertexSaAssertionSigner = defaultAssertionSigner,
): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + VERTEX_ASSERTION_LIFETIME_MS) / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.privateKeyId !== null && key.privateKeyId !== '') header.kid = key.privateKeyId;
  const headerB64 = base64Url(JSON.stringify(header));
  const claimsB64 = base64Url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: VERTEX_CLOUD_PLATFORM_SCOPE,
      aud: key.tokenUri,
      iat,
      exp,
    }),
  );
  return `${headerB64}.${claimsB64}.${sign(`${headerB64}.${claimsB64}`, key.privateKey)}`;
}

export interface VertexSaTokenExchange {
  readonly accessToken: string;
  readonly expiresInSeconds: number | null;
}

/**
 * The jwt-bearer exchange against the pinned Google token endpoint:
 * POST form-urlencoded `grant_type=urn:ietf:params:oauth:grant-type:jwt-
 * bearer&assertion=<jwt>`. The URL is validated against the pinned literal
 * — the key's tokenUri already is the pinned endpoint, and anything else
 * fails closed (SSRF guard, sub2api parity).
 */
export async function exchangeVertexSaToken(input: {
  readonly key: VertexServiceAccountKey;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly nowMs?: () => number;
  readonly sign?: VertexSaAssertionSigner;
}): Promise<VertexSaTokenExchange> {
  if (input.key.tokenUri !== VERTEX_TOKEN_URL) {
    throw new VertexSaTokenError('TOKEN_ENDPOINT_FAILED', 'the token endpoint is not the pinned Google endpoint');
  }
  const assertion = buildVertexSaAssertion(input.key, (input.nowMs ?? Date.now)(), input.sign);
  const body = `grant_type=${encodeURIComponent(VERTEX_JWT_BEARER_GRANT_TYPE)}&assertion=${encodeURIComponent(assertion)}`;
  const response = await input.fetch(VERTEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'manual',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const text = await response.text();
  if (text.length > VERTEX_SA_TOKEN_MAX_RESPONSE_BYTES) {
    throw new VertexSaTokenError('TOKEN_RESPONSE_INVALID', 'the token response was too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (response.status < 200 || response.status >= 300) {
    const description =
      typeof record.error_description === 'string' && record.error_description !== ''
        ? record.error_description
        : typeof record.error === 'string'
          ? record.error
          : `status ${response.status}`;
    throw new VertexSaTokenError('TOKEN_ENDPOINT_FAILED', `the token endpoint rejected the assertion: ${description}`);
  }
  const accessToken = typeof record.access_token === 'string' ? record.access_token.trim() : '';
  if (accessToken === '') {
    throw new VertexSaTokenError('TOKEN_RESPONSE_INVALID', 'the token response carried no access_token');
  }
  const expiresIn =
    typeof record.expires_in === 'number' && Number.isSafeInteger(record.expires_in) && record.expires_in > 0
      ? record.expires_in
      : null;
  return { accessToken, expiresInSeconds: expiresIn };
}

/** The rotation seam contract — the 094 worker's `OauthCredentialRotator`. */
export type VertexSaCredentialRotator = (input: {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly secret: Uint8Array;
}) => Promise<{ readonly version: number }>;

/** The due/token state columns the refresher claims (the 094 lease family). */
interface ClaimedVertexCredentialRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly account_id: string;
  readonly provider_id: string;
  readonly product_id: string;
  readonly credential_type: string;
  readonly current_version: number;
  readonly oauth_refresh_state: string | null;
  readonly oauth_next_refresh_at: Date | string | null;
  readonly oauth_last_refresh_at: Date | string | null;
  readonly oauth_force_refresh_requested: boolean;
  readonly purpose: string;
}

interface VertexOwnerScope {
  readonly ownerKind: 'tenant' | 'platform';
  readonly credentials: string;
  readonly accounts: string;
  readonly versions: string;
  readonly wrappings: string;
}

const VERTEX_OWNER_SCOPES: Readonly<Record<'tenant' | 'platform', VertexOwnerScope>> = Object.freeze({
  tenant: Object.freeze({
    ownerKind: 'tenant',
    credentials: 'saas_tenant_provider_credentials',
    accounts: 'saas_tenant_provider_accounts',
    versions: 'saas_tenant_provider_credential_versions',
    wrappings: 'saas_tenant_provider_credential_wrappings',
  }),
  platform: Object.freeze({
    ownerKind: 'platform',
    credentials: 'saas_platform_provider_credentials',
    accounts: 'saas_platform_provider_accounts',
    versions: 'saas_platform_provider_credential_versions',
    wrappings: 'saas_platform_provider_credential_wrappings',
  }),
});

/** The only vertex binding this refresher ever touches (fail-closed). */
export const VERTEX_SA_BINDING = Object.freeze({
  providerId: VERTEX_PROVIDER_ID,
  productId: VERTEX_PRODUCT_ID,
  credentialType: VERTEX_CREDENTIAL_TYPE,
  purpose: VERTEX_PURPOSE,
});

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes(' ')) {
    throw new VertexSaTokenError('STORE_UNAVAILABLE', 'the vertex credential store returned an unexpected row shape');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new VertexSaTokenError('STORE_UNAVAILABLE', 'the vertex credential store returned an unexpected version');
  }
  return result;
}

function timestampMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** expires_in − 5-minute cache skew; never below one minute. */
export function vertexSaTokenTtlMs(expiresInSeconds: number | null): number {
  const ttlSeconds = expiresInSeconds ?? Math.round(VERTEX_TOKEN_DEFAULT_TTL_MS / 1000);
  const skewed = ttlSeconds * 1000 - VERTEX_TOKEN_CACHE_SKEW_MS;
  return Math.max(60_000, skewed);
}

/** Exponential failure backoff: 1m, 2m, 4m... capped at 1h. */
export function vertexSaFailureBackoffMs(previousIntervalMs: number | null): number {
  if (previousIntervalMs === null || !Number.isFinite(previousIntervalMs)) return VERTEX_SA_MIN_BACKOFF_MS;
  const rounded = Math.round(previousIntervalMs);
  if (rounded < VERTEX_SA_MIN_BACKOFF_MS) return VERTEX_SA_MIN_BACKOFF_MS;
  return Math.min(VERTEX_SA_MAX_BACKOFF_MS, rounded * 2);
}

export interface PostgresVertexSaTokenRefresherOptions {
  /** Structural database handle: one transaction() and one query() are enough. */
  readonly database: {
    transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
    query<Row = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
  };
  readonly deployment: string;
  readonly environment: string;
  readonly kms: ProviderCredentialUnsealingKms;
  /** Test/custom seam; production uses the global fetch against the pinned endpoint. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** A 'refreshing' row whose attempt stamp is older than this is reclaimable. */
  readonly staleRefreshingMs?: number;
  readonly signal?: AbortSignal;
}

export type VertexSaRefreshOutcome =
  | { readonly outcome: 'idle' }
  | { readonly outcome: 'refreshed'; readonly credentialId: string }
  | { readonly outcome: 'failed'; readonly credentialId: string; readonly errorCode: VertexSaTokenErrorCode };

/**
 * The Vertex SA token refresher. Two entries share one claim cycle:
 *
 * - `refreshNext(rotator)`: the worker entry — one due credential per call
 *   (a deployment loop polls it exactly like the 094 worker's refreshNext);
 * - `resolveAccessToken(ref, useToken)`: the gateway hot path — reads the
 *   sealed envelope, returns the fresh access token through the callback,
 *   and runs the same claim cycle when the stored token is stale (losing
 *   the SKIP LOCKED lease means another instance is mid-exchange: wait
 *   200ms, re-read, and fail closed when the token is still stale).
 *
 * Plaintext key/token material never leaves the unsealing callback and is
 * never logged or embedded in errors.
 */
export class PostgresVertexSaTokenRefresher {
  private readonly options: Required<Pick<PostgresVertexSaTokenRefresherOptions, 'deployment' | 'environment'>> &
    PostgresVertexSaTokenRefresherOptions & { readonly staleRefreshingMs: number };

  constructor(options: PostgresVertexSaTokenRefresherOptions) {
    if (!options?.database || typeof options.database.transaction !== 'function') {
      throw new VertexSaTokenError('STORE_UNAVAILABLE', 'a database handle is required');
    }
    if (typeof options.kms?.decryptDataKey !== 'function') {
      throw new VertexSaTokenError('CREDENTIAL_UNAVAILABLE', 'a provider credential unsealing KMS is required');
    }
    this.options = {
      ...options,
      deployment: safeText(options.deployment),
      environment: safeText(options.environment),
      staleRefreshingMs: options.staleRefreshingMs ?? VERTEX_SA_STALE_REFRESHING_MS,
    };
  }

  private duePredicate(): string {
    return `
          AND credential.status = 'active' AND account.status = 'active'
          AND credential.current_version IS NOT NULL
          AND credential.provider_id = '${VERTEX_SA_BINDING.providerId}'
          AND credential.product_id = '${VERTEX_SA_BINDING.productId}'
          AND credential.credential_type = '${VERTEX_SA_BINDING.credentialType}'
          AND (
            (credential.oauth_refresh_state IS NULL
              AND (credential.oauth_next_refresh_at IS NULL
                   OR credential.oauth_next_refresh_at <= clock_timestamp()))
            OR (credential.oauth_refresh_state IN ('idle', 'failed')
              AND (credential.oauth_force_refresh_requested = true
                OR credential.oauth_next_refresh_at IS NULL
                OR credential.oauth_next_refresh_at <= clock_timestamp()))
            OR (credential.oauth_refresh_state = 'refreshing'
              AND credential.oauth_last_refresh_at <= clock_timestamp() - ($1 * interval '1 millisecond'))
          )`;
  }

  private candidateSelect(scope: VertexOwnerScope): string {
    const tenantColumns = scope.ownerKind === 'tenant' ? 'credential.tenant_id, ' : '';
    const tenantJoin =
      scope.ownerKind === 'tenant'
        ? 'account.tenant_id = credential.tenant_id AND account.id = credential.account_id'
        : 'account.id = credential.account_id';
    return `SELECT ${tenantColumns}credential.id, credential.account_id, credential.provider_id,
                credential.product_id, credential.credential_type, credential.current_version,
                credential.oauth_refresh_state, credential.oauth_next_refresh_at,
                credential.oauth_last_refresh_at, credential.oauth_force_refresh_requested,
                account.purpose
           FROM ${scope.credentials} AS credential
           JOIN ${scope.accounts} AS account
             ON ${tenantJoin}
            AND account.provider_id = credential.provider_id
            AND account.product_id = credential.product_id
          WHERE TRUE${this.duePredicate()}
          ORDER BY credential.oauth_force_refresh_requested DESC,
                   credential.oauth_next_refresh_at ASC NULLS FIRST, credential.id
          LIMIT 1`;
  }

  private lockSelect(scope: VertexOwnerScope, identitySql: string): string {
    const tenantColumns = scope.ownerKind === 'tenant' ? 'credential.tenant_id, ' : '';
    const tenantJoin =
      scope.ownerKind === 'tenant'
        ? 'account.tenant_id = credential.tenant_id AND account.id = credential.account_id'
        : 'account.id = credential.account_id';
    return `SELECT ${tenantColumns}credential.id, credential.account_id, credential.provider_id,
                credential.product_id, credential.credential_type, credential.current_version,
                credential.oauth_refresh_state, credential.oauth_next_refresh_at,
                credential.oauth_last_refresh_at, credential.oauth_force_refresh_requested,
                account.purpose
           FROM ${scope.credentials} AS credential
           JOIN ${scope.accounts} AS account
             ON ${tenantJoin}
            AND account.provider_id = credential.provider_id
            AND account.product_id = credential.product_id
          WHERE ${identitySql}${this.duePredicate()}
          FOR UPDATE OF credential SKIP LOCKED`;
  }

  /** The worker entry: refresh the next due vertex credential, if any. */
  async refreshNext(rotator: VertexSaCredentialRotator): Promise<VertexSaRefreshOutcome> {
    if (typeof rotator !== 'function') throw new VertexSaTokenError('STORE_UNAVAILABLE', 'a rotator is required');
    for (const scope of [VERTEX_OWNER_SCOPES.tenant, VERTEX_OWNER_SCOPES.platform]) {
      const outcome = await this.refreshNextInScope(scope, rotator);
      if (outcome !== null) return outcome;
    }
    return { outcome: 'idle' };
  }

  private async refreshNextInScope(
    scope: VertexOwnerScope,
    rotator: VertexSaCredentialRotator,
  ): Promise<VertexSaRefreshOutcome | null> {
    const prepared = await this.options.database.transaction(async (tx) => {
      const candidates = await tx.query<ClaimedVertexCredentialRow>(this.candidateSelect(scope), [
        this.options.staleRefreshingMs,
      ]);
      const candidate = candidates.rows[0];
      if (!candidate) return null;
      const locked = await tx.query<ClaimedVertexCredentialRow>(
        this.lockSelect(
          scope,
          scope.ownerKind === 'tenant' ? 'credential.tenant_id = $2 AND credential.id = $3' : 'credential.id = $2',
        ),
        scope.ownerKind === 'tenant'
          ? [this.options.staleRefreshingMs, candidate.tenant_id, candidate.id]
          : [this.options.staleRefreshingMs, candidate.id],
      );
      const row = locked.rows[0];
      if (!row) return null;
      return this.exchangeUnderLease(tx, scope, row);
    });
    if (prepared === null) return null;
    if (prepared.kind === 'failed') {
      return { outcome: 'failed', credentialId: prepared.credentialId, errorCode: prepared.errorCode };
    }
    const rotated = await this.rotate(prepared, rotator);
    if (rotated !== null) return { outcome: 'failed', credentialId: prepared.ref.credentialId, errorCode: rotated };
    return { outcome: 'refreshed', credentialId: prepared.ref.credentialId };
  }

  /**
   * The gateway hot path: resolves the sealed envelope, and returns the
   * fresh access token through the callback. A stale stored token runs the
   * same claim/rotate cycle first; losing the lease (another instance is
   * mid-exchange) waits one lock interval and re-reads before failing
   * closed.
   */
  async resolveAccessToken<T>(
    ref: {
      readonly ownerKind: 'tenant' | 'platform';
      readonly tenantId: string | null;
      readonly accountId: string;
      readonly credentialId: string;
    },
    useToken: (credential: {
      readonly accessToken: string;
      readonly projectId: string;
      readonly location: string | null;
      readonly vertexModelLocations: Readonly<Record<string, string>> | null;
    }) => Promise<T>,
    rotator: VertexSaCredentialRotator,
  ): Promise<T> {
    const scope = VERTEX_OWNER_SCOPES[ref.ownerKind];
    const read = await this.readSealedMaterial(scope, ref);
    if (read !== null && read.expiresAtMs !== null && read.expiresAtMs - VERTEX_TOKEN_CACHE_SKEW_MS > Date.now()) {
      return useToken(read);
    }
    // Stale (or never exchanged): run the claim cycle for this credential.
    const forced = await this.forceRefresh(scope, ref, rotator);
    if (forced !== null) return useToken(forced);
    // Lost the lease — another instance is mid-exchange. Wait one lock
    // interval and re-read (sub2api vertexLockWaitTime semantics).
    await new Promise((resolve) => setTimeout(resolve, VERTEX_SA_LOCK_WAIT_MS));
    const reread = await this.readSealedMaterial(scope, ref);
    if (
      reread !== null &&
      reread.expiresAtMs !== null &&
      reread.expiresAtMs - VERTEX_TOKEN_CACHE_SKEW_MS > Date.now()
    ) {
      return useToken(reread);
    }
    throw new VertexSaTokenError('CREDENTIAL_UNAVAILABLE', 'the vertex access token is not fresh');
  }

  private async forceRefresh(
    scope: VertexOwnerScope,
    ref: { readonly tenantId: string | null; readonly credentialId: string },
    rotator: VertexSaCredentialRotator,
  ): Promise<{
    readonly accessToken: string;
    readonly projectId: string;
    readonly location: string | null;
    readonly vertexModelLocations: Readonly<Record<string, string>> | null;
  } | null> {
    const prepared = await this.options.database.transaction(async (tx) => {
      const locked = await tx.query<ClaimedVertexCredentialRow>(
        this.lockSelect(
          scope,
          scope.ownerKind === 'tenant' ? 'credential.tenant_id = $2 AND credential.id = $3' : 'credential.id = $2',
        ),
        scope.ownerKind === 'tenant'
          ? [this.options.staleRefreshingMs, ref.tenantId, ref.credentialId]
          : [this.options.staleRefreshingMs, ref.credentialId],
      );
      const row = locked.rows[0];
      if (!row) return null;
      return this.exchangeUnderLease(tx, scope, row);
    });
    if (prepared === null) return null;
    if (prepared.kind === 'failed') {
      throw new VertexSaTokenError(prepared.errorCode, 'the vertex token exchange failed');
    }
    const rotated = await this.rotate(prepared, rotator);
    if (rotated !== null) throw new VertexSaTokenError(rotated, 'the vertex credential rotation failed');
    const reread = await this.readSealedMaterial(scope, {
      tenantId: ref.tenantId,
      credentialId: ref.credentialId,
      // readSealedMaterial resolves the credential's own account row.
      accountId: prepared.ref.accountId,
    });
    if (reread === null) {
      throw new VertexSaTokenError('CREDENTIAL_UNAVAILABLE', 'the rotated vertex credential could not be read back');
    }
    return reread;
  }

  private async rotate(
    prepared: { kind: 'ready'; ref: VertexCredentialRef; newSecret: Buffer; nextRefreshAtMs: number },
    rotator: VertexSaCredentialRotator,
  ): Promise<VertexSaTokenErrorCode | null> {
    const { ref, newSecret } = prepared;
    let errorCode: VertexSaTokenErrorCode | null = null;
    try {
      await rotator({
        ownerKind: ref.ownerKind,
        tenantId: ref.tenantId,
        accountId: ref.accountId,
        credentialId: ref.credentialId,
        expectedVersion: ref.currentVersion,
        secret: newSecret,
      });
    } catch (error) {
      errorCode =
        (error as { code?: string } | null)?.code === 'CREDENTIAL_VERSION_CONFLICT'
          ? 'ROTATION_CONFLICT'
          : 'ROTATION_FAILED';
    } finally {
      newSecret.fill(0);
    }
    // The finalize write: idle + the next due stamp (or the failure ladder).
    await this.options.database.transaction(async (tx) => {
      const scope = VERTEX_OWNER_SCOPES[ref.ownerKind];
      if (errorCode !== null) {
        await this.writeFailure(tx, scope, ref, errorCode);
        return;
      }
      await this.writeIdle(tx, scope, ref, prepared.nextRefreshAtMs);
    });
    return errorCode;
  }

  private async exchangeUnderLease(
    tx: SqlExecutor,
    scope: VertexOwnerScope,
    row: ClaimedVertexCredentialRow,
  ): Promise<VertexSaLeaseOutcome> {
    const ref: VertexCredentialRef = {
      ownerKind: scope.ownerKind,
      tenantId: scope.ownerKind === 'tenant' ? safeText(row.tenant_id) : null,
      accountId: safeText(row.account_id),
      credentialId: safeText(row.id),
      currentVersion: positiveInteger(row.current_version),
      previousState: row.oauth_refresh_state,
      previousIntervalMs: previousInterval(row),
    };
    const sealed = await this.loadSealedEnvelope(tx, scope, ref);
    if (sealed === null) {
      await this.writeFailure(tx, scope, ref, 'CREDENTIAL_UNAVAILABLE');
      return { kind: 'failed', credentialId: ref.credentialId, errorCode: 'CREDENTIAL_UNAVAILABLE' };
    }
    let newSecret: Buffer | undefined;
    let expiresInSeconds: number | null = null;
    try {
      const exchanged = await withUnsealedProviderCredential(
        sealed.envelope,
        sealed.context,
        this.options.kms,
        async (secret) => {
          let material: Record<string, unknown>;
          try {
            material = JSON.parse(secret.toString('utf8')) as Record<string, unknown>;
          } catch {
            throw new VertexSaTokenError('CREDENTIAL_INVALID', 'the vertex envelope material is not JSON');
          }
          const key = vertexServiceAccountKeyFromEnvelopeMaterial(material);
          const token = await exchangeVertexSaToken({
            key,
            fetch: this.options.fetch ?? ((url, init) => fetch(url, init)),
            ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
          });
          // Passthrough every non-token envelope field (location,
          // vertex_model_locations, ...), then overlay the fresh token.
          const rotated: Record<string, unknown> = { ...material };
          rotated.access_token = token.accessToken;
          const expiresAtMs = Date.now() + vertexSaTokenTtlMs(token.expiresInSeconds) + VERTEX_TOKEN_CACHE_SKEW_MS;
          rotated.expires_at = new Date(expiresAtMs).toISOString();
          expiresInSeconds = token.expiresInSeconds;
          return Buffer.from(JSON.stringify(rotated), 'utf8');
        },
      );
      newSecret = exchanged;
    } catch (error) {
      const errorCode: VertexSaTokenErrorCode = error instanceof VertexSaTokenError ? error.code : 'CREDENTIAL_INVALID';
      await this.writeFailure(tx, scope, ref, errorCode);
      return { kind: 'failed', credentialId: ref.credentialId, errorCode };
    }
    if (newSecret === undefined) {
      await this.writeFailure(tx, scope, ref, 'CREDENTIAL_INVALID');
      return { kind: 'failed', credentialId: ref.credentialId, errorCode: 'CREDENTIAL_INVALID' };
    }
    await this.writeRefreshing(tx, scope, ref);
    return {
      kind: 'ready',
      ref,
      nextRefreshAtMs: Date.now() + vertexSaTokenTtlMs(expiresInSeconds),
      newSecret,
    };
  }

  private async loadSealedEnvelope(
    tx: SqlExecutor,
    scope: VertexOwnerScope,
    ref: VertexCredentialRef,
  ): Promise<{ readonly envelope: ProviderCredentialEnvelope; readonly context: ProviderCredentialContext } | null> {
    const versions = await tx.query<{
      readonly version: number;
      readonly schema_version: number;
      readonly context_version: number;
      readonly algorithm: string;
      readonly kms_purpose: string;
      readonly kms_key_id: string;
      readonly wrapped_dek: string;
      readonly nonce: string;
      readonly ciphertext: string;
      readonly auth_tag: string;
      readonly provider_id: string;
      readonly product_id: string;
      readonly credential_type: string;
    }>(
      scope.ownerKind === 'tenant'
        ? `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag,
                  version_row.provider_id, version_row.product_id, version_row.credential_type
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
              AND version_row.status = 'active'`
        : `SELECT version_row.version, version_row.schema_version, version_row.context_version,
                  version_row.algorithm, version_row.kms_purpose,
                  COALESCE(wrapping.kms_key_id, version_row.kms_key_id) AS kms_key_id,
                  COALESCE(wrapping.wrapped_dek, version_row.wrapped_dek) AS wrapped_dek,
                  version_row.nonce, version_row.ciphertext, version_row.auth_tag,
                  version_row.provider_id, version_row.product_id, version_row.credential_type
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
              AND version_row.status = 'active'`,
      scope.ownerKind === 'tenant'
        ? [ref.tenantId, ref.accountId, ref.credentialId, ref.currentVersion]
        : [ref.accountId, ref.credentialId, ref.currentVersion],
    );
    const version = versions.rows[0];
    if (
      !version ||
      version.kms_purpose !== VERTEX_SA_BINDING.purpose ||
      version.provider_id !== VERTEX_SA_BINDING.providerId ||
      version.product_id !== VERTEX_SA_BINDING.productId ||
      version.credential_type !== VERTEX_SA_BINDING.credentialType ||
      positiveInteger(version.schema_version) !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      positiveInteger(version.context_version) !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      return null;
    }
    const context = createProviderCredentialContext(
      scope.ownerKind === 'platform'
        ? {
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: version.kms_purpose,
            providerId: version.provider_id,
            productId: version.product_id,
            credentialType: version.credential_type,
            accountId: ref.accountId,
            credentialId: ref.credentialId,
            credentialVersion: ref.currentVersion,
          }
        : {
            ownerKind: 'tenant',
            tenantId: ref.tenantId as string,
            supplyMode: 'byok',
            deployment: this.options.deployment,
            environment: this.options.environment,
            purpose: version.kms_purpose,
            providerId: version.provider_id,
            productId: version.product_id,
            credentialType: version.credential_type,
            accountId: ref.accountId,
            credentialId: ref.credentialId,
            credentialVersion: ref.currentVersion,
          },
    );
    return {
      envelope: {
        schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
        contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
        algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
        kmsKeyId: safeText(version.kms_key_id),
        wrappedDek: safeText(version.wrapped_dek),
        nonce: safeText(version.nonce),
        ciphertext: safeText(version.ciphertext),
        authTag: safeText(version.auth_tag),
      },
      context,
    };
  }

  /** Plain read of the current envelope material (no lock, no exchange). */
  private async readSealedMaterial(
    scope: VertexOwnerScope,
    ref: { readonly tenantId: string | null; readonly accountId: string; readonly credentialId: string },
  ): Promise<{
    readonly accessToken: string;
    readonly projectId: string;
    readonly location: string | null;
    readonly vertexModelLocations: Readonly<Record<string, string>> | null;
    readonly expiresAtMs: number | null;
  } | null> {
    const credentials = await this.options.database.query<{
      readonly current_version: number;
      readonly provider_id: string;
      readonly product_id: string;
      readonly credential_type: string;
      readonly account_id: string;
    }>(
      scope.ownerKind === 'tenant'
        ? `SELECT current_version, provider_id, product_id, credential_type, account_id
             FROM ${scope.credentials}
            WHERE tenant_id = $1 AND id = $2 AND status = 'active'
              AND provider_id = '${VERTEX_SA_BINDING.providerId}'
              AND credential_type = '${VERTEX_SA_BINDING.credentialType}'`
        : `SELECT current_version, provider_id, product_id, credential_type, account_id
             FROM ${scope.credentials}
            WHERE id = $1 AND status = 'active'
              AND provider_id = '${VERTEX_SA_BINDING.providerId}'
              AND credential_type = '${VERTEX_SA_BINDING.credentialType}'`,
      scope.ownerKind === 'tenant' ? [ref.tenantId, ref.credentialId] : [ref.credentialId],
    );
    const credential = credentials.rows[0];
    if (!credential) return null;
    const version = positiveInteger(credential.current_version);
    const fakeRef: VertexCredentialRef = {
      ownerKind: scope.ownerKind,
      tenantId: scope.ownerKind === 'tenant' ? (ref.tenantId as string) : null,
      accountId: credential.account_id,
      credentialId: ref.credentialId,
      currentVersion: version,
      previousState: null,
      previousIntervalMs: null,
    };
    const sealed = await this.options.database.transaction(async (tx) => this.loadSealedEnvelope(tx, scope, fakeRef));
    if (sealed === null) return null;
    return withUnsealedProviderCredential(sealed.envelope, sealed.context, this.options.kms, async (secret) => {
      let material: Record<string, unknown>;
      try {
        material = JSON.parse(secret.toString('utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
      const accessToken = typeof material.access_token === 'string' ? material.access_token : '';
      const projectId = typeof material.project_id === 'string' ? material.project_id.trim() : '';
      if (accessToken === '' || projectId === '') return null;
      const location =
        typeof material.location === 'string' && material.location.trim() !== '' ? material.location : null;
      const rawLocations = material.vertex_model_locations;
      const vertexModelLocations =
        rawLocations !== null && typeof rawLocations === 'object' && !Array.isArray(rawLocations)
          ? (rawLocations as Record<string, string>)
          : null;
      const expiresAt = typeof material.expires_at === 'string' ? Date.parse(material.expires_at) : Number.NaN;
      return {
        accessToken,
        projectId,
        location,
        vertexModelLocations,
        expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : null,
      };
    });
  }

  private identityPredicate(scope: VertexOwnerScope): string {
    return scope.ownerKind === 'tenant' ? 'tenant_id = $1 AND id = $2' : 'id = $1';
  }

  private async writeRefreshing(tx: SqlExecutor, scope: VertexOwnerScope, ref: VertexCredentialRef): Promise<void> {
    const nowIso = isoTimestamp(Date.now());
    await tx.query(
      `UPDATE ${scope.credentials}
          SET oauth_refresh_state = 'refreshing',
              oauth_last_refresh_at = $1::timestamptz,
              oauth_next_refresh_at = $1::timestamptz,
              oauth_force_refresh_requested = false
        WHERE ${this.identityPredicate(scope)}`,
      scope.ownerKind === 'tenant' ? [nowIso, ref.tenantId, ref.credentialId] : [nowIso, ref.credentialId],
    );
  }

  private async writeIdle(
    tx: SqlExecutor,
    scope: VertexOwnerScope,
    ref: VertexCredentialRef,
    nextRefreshAtMs: number,
  ): Promise<void> {
    await tx.query(
      `UPDATE ${scope.credentials}
          SET oauth_refresh_state = 'idle',
              oauth_next_refresh_at = $1::timestamptz,
              oauth_last_refresh_at = $2::timestamptz,
              oauth_refresh_error_code = NULL,
              oauth_force_refresh_requested = false
        WHERE ${this.identityPredicate(scope)}`,
      scope.ownerKind === 'tenant'
        ? [isoTimestamp(nextRefreshAtMs), isoTimestamp(Date.now()), ref.tenantId, ref.credentialId]
        : [isoTimestamp(nextRefreshAtMs), isoTimestamp(Date.now()), ref.credentialId],
    );
  }

  private async writeFailure(
    tx: SqlExecutor,
    scope: VertexOwnerScope,
    ref: VertexCredentialRef,
    errorCode: VertexSaTokenErrorCode,
  ): Promise<void> {
    const backoffMs = vertexSaFailureBackoffMs(ref.previousIntervalMs);
    await tx.query(
      `UPDATE ${scope.credentials}
          SET oauth_refresh_state = 'failed',
              oauth_next_refresh_at = $1::timestamptz,
              oauth_refresh_error_code = $2,
              oauth_force_refresh_requested = false
        WHERE ${this.identityPredicate(scope)}`,
      scope.ownerKind === 'tenant'
        ? [isoTimestamp(Date.now() + backoffMs), errorCode, ref.tenantId, ref.credentialId]
        : [isoTimestamp(Date.now() + backoffMs), errorCode, ref.credentialId],
    );
  }
}

interface VertexCredentialRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly currentVersion: number;
  readonly previousState: string | null;
  readonly previousIntervalMs: number | null;
}

type VertexSaLeaseOutcome =
  | { readonly kind: 'failed'; readonly credentialId: string; readonly errorCode: VertexSaTokenErrorCode }
  | {
      readonly kind: 'ready';
      readonly ref: VertexCredentialRef;
      readonly nextRefreshAtMs: number;
      readonly newSecret: Buffer;
    };

function previousInterval(row: ClaimedVertexCredentialRow): number | null {
  const next = timestampMs(row.oauth_next_refresh_at);
  const last = timestampMs(row.oauth_last_refresh_at);
  return next !== null && last !== null && next > last ? next - last : null;
}
