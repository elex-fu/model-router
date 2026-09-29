import { createHmac } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type {
  ProviderAccountSchedulerAffinityDecision,
  ProviderAccountSchedulerAffinityPort,
  ProviderAccountSchedulerAffinityScope,
} from './provider-account-scheduler.js';
import type { RequestPreparationSchedulingContext } from './request-preparation-service.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REFERENCE_LENGTH = 512;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface PostgresProviderAccountAffinityHmacKey {
  /** Stable deployment key id. Keep prior versions during key rotation. */
  readonly version: string;
  /** Trusted gateway runtime key material; never derive this from a caller/session secret. */
  readonly key: Uint8Array;
}

export interface PostgresProviderAccountAffinityOptions {
  readonly database: SaasDatabase;
  /** Include every still-live compatibility key version; only the active key writes new rows. */
  readonly keys: readonly PostgresProviderAccountAffinityHmacKey[];
  readonly activeKeyVersion: string;
  readonly ttlMs?: number;
}

interface KeyMaterial {
  readonly version: string;
  readonly key: Buffer;
}

type ReferenceKind = 'response' | 'session';
interface Reference {
  readonly kind: ReferenceKind;
  readonly value: string;
}

interface DigestAlias {
  readonly kind: ReferenceKind;
  readonly keyVersion: string;
  readonly digest: string;
}

interface AffinityRow extends Record<string, unknown> {
  account_owner_kind: unknown;
  account_id: unknown;
  state: unknown;
  revision: unknown;
  fencing_token: unknown;
  hmac_key_version: unknown;
  key_digest: unknown;
  is_expired: unknown;
}

const SCOPE_COLUMNS = [
  'tenant_id',
  'project_id',
  'supply_profile_id',
  'supply_mode',
  'account_owner_kind',
  'route_config_id',
  'route_config_version',
  'public_model_id',
  'public_model_version',
  'public_model',
  'protocol',
  'target_mode',
  'upstream_id',
  'provider_id',
  'product_id',
] as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\u0000');
}

function version(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function references(context: RequestPreparationSchedulingContext): Reference[] | null {
  const values: Reference[] = [];
  if (context.previousResponseId !== undefined) {
    if (!nonEmpty(context.previousResponseId) || context.previousResponseId.length > MAX_REFERENCE_LENGTH) return null;
    values.push({ kind: 'response', value: context.previousResponseId });
  }
  if (context.sessionId !== undefined) {
    if (!nonEmpty(context.sessionId) || context.sessionId.length > MAX_REFERENCE_LENGTH) return null;
    values.push({ kind: 'session', value: context.sessionId });
  }
  return values.length > 0 ? values : null;
}

function scopeIsValid(scope: ProviderAccountSchedulerAffinityScope): boolean {
  return (
    nonEmpty(scope.tenantId) &&
    nonEmpty(scope.projectId) &&
    nonEmpty(scope.supplyProfileId) &&
    (scope.supplyMode === 'byok' || scope.supplyMode === 'platform') &&
    scope.accountOwnerKind === (scope.supplyMode === 'byok' ? 'tenant' : 'platform') &&
    nonEmpty(scope.routeConfigId) &&
    version(scope.routeConfigVersion) &&
    nonEmpty(scope.publicModelId) &&
    version(scope.publicModelVersion) &&
    nonEmpty(scope.publicModel) &&
    (scope.protocol === 'anthropic' ||
      scope.protocol === 'openai' ||
      scope.protocol === 'gemini' ||
      scope.protocol === 'responses') &&
    scope.targetMode === (scope.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool') &&
    nonEmpty(scope.upstreamId) &&
    nonEmpty(scope.providerId) &&
    nonEmpty(scope.productId)
  );
}

function scopeValues(scope: ProviderAccountSchedulerAffinityScope): readonly unknown[] {
  return [
    scope.tenantId,
    scope.projectId,
    scope.supplyProfileId,
    scope.supplyMode,
    scope.accountOwnerKind,
    scope.routeConfigId,
    scope.routeConfigVersion,
    scope.publicModelId,
    scope.publicModelVersion,
    scope.publicModel,
    scope.protocol,
    scope.targetMode,
    scope.upstreamId,
    scope.providerId,
    scope.productId,
  ];
}

function scopeWhere(start = 1): string {
  return SCOPE_COLUMNS.map((column, index) => `${column} = $${start + index}`).join(' AND ');
}

function referenceAliases(
  scope: ProviderAccountSchedulerAffinityScope,
  referenceList: readonly Reference[],
  keys: readonly KeyMaterial[],
): DigestAlias[] {
  const canonicalScope = scopeValues(scope);
  return referenceList.flatMap((reference) =>
    keys.map(({ version: keyVersion, key }) => {
      const material = JSON.stringify([
        'model-router/provider-account-affinity',
        1,
        keyVersion,
        canonicalScope,
        reference.kind,
        reference.value,
      ]);
      return {
        kind: reference.kind,
        keyVersion,
        digest: createHmac('sha256', key).update(material, 'utf8').digest('hex'),
      };
    }),
  );
}

function lockKeys(scope: ProviderAccountSchedulerAffinityScope, aliases: readonly DigestAlias[]): string[] {
  return [...new Set(aliases.map(({ kind, digest }) => JSON.stringify([...scopeValues(scope), kind, digest])))].sort();
}

async function lockAffinityKeys(tx: SqlExecutor, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await tx.query(
      '/* postgres-provider-account-affinity:lock */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [key],
    );
  }
}

async function requireKeyCompatibility(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  refs: readonly Reference[],
  keys: readonly KeyMaterial[],
): Promise<void> {
  const supported = new Set(keys.map(({ version }) => version));
  for (const kind of [...new Set(refs.map(({ kind: referenceKind }) => referenceKind))].sort()) {
    const result = await tx.query<{ hmac_key_version: unknown }>(
      `/* postgres-provider-account-affinity:key-versions */
SELECT DISTINCT hmac_key_version
 FROM saas_gateway_provider_account_affinity
 WHERE ${scopeWhere()} AND reference_kind = $16
   AND state IN ('active', 'invalidated')
   AND expires_at > clock_timestamp()`,
      [...scopeValues(scope), kind],
    );
    if (result.rows.some(({ hmac_key_version }) => !nonEmpty(hmac_key_version) || !supported.has(hmac_key_version))) {
      throw new AffinityCompatibilityMissing('a persisted HMAC key version is unavailable');
    }
  }
}

function aliasesForKind(aliases: readonly DigestAlias[], kind: ReferenceKind): DigestAlias[] {
  return aliases
    .filter((alias) => alias.kind === kind)
    .sort((left, right) => left.keyVersion.localeCompare(right.keyVersion));
}

async function loadRows(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  aliases: readonly DigestAlias[],
): Promise<AffinityRow[]> {
  const matching = aliasesForKind(aliases, kind);
  if (matching.length === 0) return [];
  const versions = matching.map(({ keyVersion }) => keyVersion);
  const digests = matching.map(({ digest }) => digest);
  const result = await tx.query<AffinityRow>(
    `/* postgres-provider-account-affinity:resolve */
SELECT account_owner_kind, account_id, state, revision::text, fencing_token::text,
       hmac_key_version, key_digest, expires_at <= clock_timestamp() AS is_expired
  FROM saas_gateway_provider_account_affinity
 WHERE ${scopeWhere()}
   AND reference_kind = $16
   AND (hmac_key_version, key_digest) IN (
     SELECT key_version, digest FROM unnest($17::text[], $18::text[]) AS keys(key_version, digest)
   )
 ORDER BY hmac_key_version, key_digest
 FOR UPDATE`,
    [...scopeValues(scope), kind, versions, digests],
  );
  return result.rows;
}

function rowState(row: AffinityRow): 'active' | 'expired' | 'invalidated' | null {
  return row.state === 'active' || row.state === 'expired' || row.state === 'invalidated' ? row.state : null;
}

function validRow(row: AffinityRow): boolean {
  return (
    nonEmpty(row.account_id) &&
    (row.account_owner_kind === 'tenant' || row.account_owner_kind === 'platform') &&
    row.account_owner_kind !== null &&
    rowState(row) !== null &&
    typeof row.revision === 'string' &&
    /^[1-9][0-9]*$/.test(row.revision) &&
    typeof row.fencing_token === 'string' &&
    /^[1-9][0-9]*$/.test(row.fencing_token) &&
    nonEmpty(row.hmac_key_version) &&
    DIGEST.test(String(row.key_digest)) &&
    typeof row.is_expired === 'boolean'
  );
}

function rowIdentity(row: AffinityRow, kind: ReferenceKind): readonly unknown[] | null {
  if (!validRow(row)) return null;
  return [kind, row.hmac_key_version, row.key_digest, row.revision, row.fencing_token];
}

function casValues(
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  row: AffinityRow,
): readonly unknown[] | null {
  const identity = rowIdentity(row, kind);
  return identity ? [...scopeValues(scope), ...identity] : null;
}

async function transitionExpired(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  row: AffinityRow,
): Promise<boolean> {
  const values = casValues(scope, kind, row);
  if (!values) return false;
  const result = await tx.query(
    `/* postgres-provider-account-affinity:expire */
UPDATE saas_gateway_provider_account_affinity
       SET state = 'expired', revision = revision + 1,
       fencing_token = fencing_token + 1, updated_at = statement_timestamp()
 WHERE ${scopeWhere()}
   AND reference_kind = $16 AND hmac_key_version = $17 AND key_digest = $18
   AND revision = $19::bigint AND fencing_token = $20::bigint
   AND state = 'active' AND expires_at <= clock_timestamp()
RETURNING revision`,
    values,
  );
  return result.rowCount === 1;
}

async function transitionInvalidated(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  row: AffinityRow,
): Promise<boolean> {
  const values = casValues(scope, kind, row);
  if (!values) return false;
  const result = await tx.query(
    `/* postgres-provider-account-affinity:invalidate */
UPDATE saas_gateway_provider_account_affinity
       SET state = 'invalidated', revision = revision + 1,
       fencing_token = fencing_token + 1, updated_at = statement_timestamp()
 WHERE ${scopeWhere()}
   AND reference_kind = $16 AND hmac_key_version = $17 AND key_digest = $18
   AND revision = $19::bigint AND fencing_token = $20::bigint
   AND state = 'active' AND expires_at > clock_timestamp()
RETURNING revision`,
    values,
  );
  return result.rowCount === 1;
}

function rowIsExpired(row: AffinityRow): boolean {
  return row.state === 'active' && row.is_expired === true;
}

function chosenAlias(
  aliases: readonly DigestAlias[],
  kind: ReferenceKind,
  activeKeyVersion: string,
): DigestAlias | null {
  return aliases.find((alias) => alias.kind === kind && alias.keyVersion === activeKeyVersion) ?? null;
}

async function insertBinding(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  alias: DigestAlias,
  accountId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await tx.query(
    `/* postgres-provider-account-affinity:insert */
INSERT INTO saas_gateway_provider_account_affinity (
  tenant_id, project_id, supply_profile_id, supply_mode, account_owner_kind,
  route_config_id, route_config_version, public_model_id, public_model_version,
  public_model, protocol, target_mode, upstream_id, provider_id, product_id,
  reference_kind, hmac_key_version, key_digest, account_id, state,
  revision, fencing_token, expires_at, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7::bigint, $8, $9::bigint, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19, 'active', 1, 1,
  statement_timestamp() + ($20::bigint * interval '1 millisecond'), statement_timestamp(), statement_timestamp()
)
ON CONFLICT DO NOTHING
RETURNING revision`,
    [...scopeValues(scope), kind, alias.keyVersion, alias.digest, accountId, ttlMs],
  );
  return result.rowCount === 1;
}

async function updateBinding(
  tx: SqlExecutor,
  scope: ProviderAccountSchedulerAffinityScope,
  kind: ReferenceKind,
  row: AffinityRow,
  accountId: string,
  ttlMs: number,
): Promise<boolean> {
  const values = casValues(scope, kind, row);
  if (!values) return false;
  const result = await tx.query(
    `/* postgres-provider-account-affinity:bind-update */
UPDATE saas_gateway_provider_account_affinity
   SET account_id = $21, state = 'active', revision = revision + 1,
       fencing_token = fencing_token + 1,
       expires_at = statement_timestamp() + ($22::bigint * interval '1 millisecond'),
       updated_at = statement_timestamp()
 WHERE ${scopeWhere()}
   AND reference_kind = $16 AND hmac_key_version = $17 AND key_digest = $18
   AND revision = $19::bigint AND fencing_token = $20::bigint
   AND ((state = 'active' AND expires_at > clock_timestamp() AND account_id = $21)
        OR state IN ('expired', 'invalidated'))
RETURNING revision`,
    [...values, accountId, ttlMs],
  );
  return result.rowCount === 1;
}

class AffinityConflict extends Error {}
class AffinityCompatibilityMissing extends Error {}

/** PostgreSQL affinity persistence. Caller keys are HMACed before any SQL is issued. */
export class PostgresProviderAccountAffinity implements ProviderAccountSchedulerAffinityPort {
  private readonly keys: readonly KeyMaterial[];
  private readonly activeKeyVersion: string;
  private readonly ttlMs: number;

  constructor(private readonly options: PostgresProviderAccountAffinityOptions) {
    if (!options?.database || typeof options.database.transaction !== 'function') {
      throw new TypeError('a transactional PostgreSQL SaaS database is required');
    }
    if (!Array.isArray(options.keys) || options.keys.length === 0 || !VERSION.test(options.activeKeyVersion)) {
      throw new TypeError('a versioned gateway affinity HMAC key is required');
    }
    const versions = new Set<string>();
    this.keys = options.keys.map(({ version: keyVersion, key }) => {
      if (
        !VERSION.test(keyVersion) ||
        versions.has(keyVersion) ||
        !(key instanceof Uint8Array) ||
        key.byteLength < 32
      ) {
        throw new TypeError('gateway affinity HMAC key configuration is invalid');
      }
      versions.add(keyVersion);
      return { version: keyVersion, key: Buffer.from(key) };
    });
    if (!versions.has(options.activeKeyVersion)) {
      throw new TypeError('active gateway affinity HMAC key version is unavailable');
    }
    this.activeKeyVersion = options.activeKeyVersion;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
      throw new TypeError('gateway affinity TTL is outside the supported bound');
    }
    this.ttlMs = ttlMs;
  }

  async resolve(
    input: Parameters<ProviderAccountSchedulerAffinityPort['resolve']>[0],
  ): Promise<ProviderAccountSchedulerAffinityDecision> {
    try {
      const refs = references(input.context);
      if (!refs || !scopeIsValid(input.scope) || !this.inputMatchesScope(input, input.scope)) {
        return { decision: 'block', reason: 'provider account affinity scope is invalid' };
      }
      if (
        !Array.isArray(input.eligibleAccountIds) ||
        input.eligibleAccountIds.some((id) => !nonEmpty(id)) ||
        new Set(input.eligibleAccountIds).size !== input.eligibleAccountIds.length
      ) {
        return { decision: 'block', reason: 'provider account affinity eligibility snapshot is invalid' };
      }
      const aliases = referenceAliases(input.scope, refs, this.keys);
      return await this.options.database.transaction(async (tx) => {
        await lockAffinityKeys(tx, lockKeys(input.scope, aliases));
        await requireKeyCompatibility(tx, input.scope, refs, this.keys);
        const snapshots: Array<{ kind: ReferenceKind; row: AffinityRow }> = [];
        for (const ref of refs) {
          const rows = await loadRows(tx, input.scope, ref.kind, aliases);
          if (rows.length > 1) return { decision: 'block', reason: 'provider account affinity mapping is ambiguous' };
          if (rows.length === 1) {
            if (!validRow(rows[0]))
              return { decision: 'block', reason: 'provider account affinity mapping is malformed' };
            snapshots.push({ kind: ref.kind, row: rows[0] });
          }
        }

        const activeRows = snapshots.filter(({ row }) => row.state === 'active' && !rowIsExpired(row));
        if (snapshots.some(({ row }) => row.state === 'invalidated' && row.is_expired !== true)) {
          return { decision: 'block', reason: 'provider account affinity target was invalidated' };
        }
        const activeAccounts = new Set(activeRows.map(({ row }) => String(row.account_id)));
        if (activeAccounts.size > 1) {
          return { decision: 'block', reason: 'provider account affinity references conflict' };
        }

        for (const { kind, row } of snapshots) {
          if (rowIsExpired(row) && !(await transitionExpired(tx, input.scope, kind, row))) {
            throw new AffinityConflict('expired affinity compare-and-swap failed');
          }
        }

        const accountId = activeRows.length > 0 ? String(activeRows[0].row.account_id) : null;
        if (accountId === null) return { decision: 'allow', accountId: null };
        if (!input.eligibleAccountIds.includes(accountId)) {
          for (const { kind, row } of activeRows) {
            if (!(await transitionInvalidated(tx, input.scope, kind, row))) {
              throw new AffinityConflict('stale affinity invalidation compare-and-swap failed');
            }
          }
          return { decision: 'block', reason: 'persisted provider account affinity target is no longer eligible' };
        }
        return { decision: 'allow', accountId };
      });
    } catch (error) {
      return {
        decision: 'block',
        reason:
          error instanceof AffinityCompatibilityMissing
            ? 'provider account affinity key compatibility is incomplete'
            : error instanceof AffinityConflict
              ? 'provider account affinity changed concurrently'
              : 'provider account affinity storage is unavailable',
      };
    }
  }

  async bind(
    input: NonNullable<ProviderAccountSchedulerAffinityPort['bind']> extends (arg: infer A) => unknown ? A : never,
  ) {
    try {
      const refs = references(input.context);
      if (!refs || !scopeIsValid(input.scope) || !nonEmpty(input.accountId)) {
        return { decision: 'block', reason: 'provider account affinity binding is invalid' } as const;
      }
      const aliases = referenceAliases(input.scope, refs, this.keys);
      return await this.options.database.transaction(async (tx) => {
        await lockAffinityKeys(tx, lockKeys(input.scope, aliases));
        await requireKeyCompatibility(tx, input.scope, refs, this.keys);
        const snapshots: Array<{ kind: ReferenceKind; row: AffinityRow | null }> = [];
        for (const ref of refs) {
          const rows = await loadRows(tx, input.scope, ref.kind, aliases);
          if (rows.length > 1) throw new AffinityConflict('multiple compatible affinity digests exist');
          if (rows.length === 1 && !validRow(rows[0])) throw new AffinityConflict('stored affinity row is malformed');
          snapshots.push({ kind: ref.kind, row: rows[0] ?? null });
        }
        for (const { row } of snapshots) {
          if (row && row.state === 'active' && !rowIsExpired(row) && row.account_id !== input.accountId) {
            throw new AffinityConflict('affinity is already bound to another eligible account');
          }
        }

        for (const { kind, row } of snapshots) {
          if (!row) {
            const alias = chosenAlias(aliases, kind, this.activeKeyVersion);
            if (!alias || !(await insertBinding(tx, input.scope, kind, alias, input.accountId, this.ttlMs))) {
              throw new AffinityConflict('affinity insert compare-and-swap failed');
            }
            continue;
          }
          if (row.state === 'invalidated' && row.is_expired !== true) {
            throw new AffinityConflict('invalidated affinity has not reached its expiry');
          }
          if (rowIsExpired(row) && !(await transitionExpired(tx, input.scope, kind, row))) {
            throw new AffinityConflict('expired affinity compare-and-swap failed');
          }
          const updateRow = rowIsExpired(row)
            ? {
                ...row,
                state: 'expired',
                revision: String(BigInt(String(row.revision)) + 1n),
                fencing_token: String(BigInt(String(row.fencing_token)) + 1n),
              }
            : row;
          if (!(await updateBinding(tx, input.scope, kind, updateRow, input.accountId, this.ttlMs))) {
            throw new AffinityConflict('affinity bind compare-and-swap failed');
          }
        }
        return { decision: 'allow' } as const;
      });
    } catch (error) {
      return {
        decision: 'block',
        reason:
          error instanceof AffinityCompatibilityMissing
            ? 'provider account affinity key compatibility is incomplete'
            : error instanceof AffinityConflict
              ? 'provider account affinity binding conflict'
              : 'provider account affinity storage is unavailable',
      } as const;
    }
  }

  private inputMatchesScope(
    input: Parameters<ProviderAccountSchedulerAffinityPort['resolve']>[0],
    scope: ProviderAccountSchedulerAffinityScope,
  ): boolean {
    return (
      scope.tenantId === input.caller.tenantId &&
      scope.projectId === input.caller.projectId &&
      scope.projectId === input.entitlement.projectId &&
      scope.tenantId === input.entitlement.tenantId &&
      scope.supplyProfileId === input.caller.supplyProfileId &&
      scope.supplyProfileId === input.entitlement.supplyProfileId &&
      scope.supplyMode === input.caller.supplyMode &&
      scope.supplyMode === input.entitlement.supplyMode &&
      scope.publicModel === input.publicModel &&
      scope.protocol === input.protocol
    );
  }
}
