import { createHash } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
  saasAdvisoryKey,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';

/** Server-only configuration for the personal registration supply bootstrap. */
export const REGISTRATION_DEFAULT_ACCESS_ENV = Object.freeze({
  poolId: 'MODEL_ROUTER_SAAS_REGISTRATION_DEFAULT_POOL_ID',
  modelScopes: 'MODEL_ROUTER_SAAS_REGISTRATION_DEFAULT_MODEL_SCOPES',
} as const);

export const REGISTRATION_DEFAULT_ACCESS_SOURCE = 'registration-default-access:v1';
const DEFAULT_PROFILE_ID = 'registration-default-platform';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegistrationDefaultAccessConfig {
  readonly poolId: string;
  readonly modelScopes: readonly string[];
}

/** The registration orchestration cannot accept pool or model choices from a client. */
export interface RegistrationDefaultAccessPort {
  provision(input: { readonly tenantId: string }): Promise<void>;
}

export interface RegistrationDefaultAccessServiceOptions {
  readonly database: SaasDatabase;
  /** Undefined is the disabled, fail-closed configuration and is reported on use. */
  readonly config?: RegistrationDefaultAccessConfig;
}

export type RegistrationDefaultAccessErrorCode =
  | 'CONFIGURATION_REQUIRED'
  | 'INVALID_CONFIGURATION'
  | 'PROVISIONING_CONFLICT'
  | 'STORAGE_ERROR';

export class RegistrationDefaultAccessError extends Error {
  constructor(
    readonly code: RegistrationDefaultAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistrationDefaultAccessError';
  }
}

function fail(code: RegistrationDefaultAccessErrorCode, message: string): never {
  throw new RegistrationDefaultAccessError(code, message);
}

/**
 * Read raw server configuration without throwing during composition. Shape
 * validation is deliberately deferred to provision(), where RegistrationService
 * can report the failure through its post-commit error channel.
 */
export function registrationDefaultAccessConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RegistrationDefaultAccessConfig | undefined {
  const poolId = env[REGISTRATION_DEFAULT_ACCESS_ENV.poolId]?.trim() ?? '';
  const rawScopes = env[REGISTRATION_DEFAULT_ACCESS_ENV.modelScopes]?.trim() ?? '';
  if (poolId.length === 0 && rawScopes.length === 0) return undefined;
  return {
    poolId,
    modelScopes: rawScopes.length === 0 ? [] : rawScopes.split(',').map((scope) => scope.trim()),
  };
}

function normalizeConfig(config: RegistrationDefaultAccessConfig | undefined): RegistrationDefaultAccessConfig {
  if (config === undefined) {
    fail(
      'CONFIGURATION_REQUIRED',
      'Registration default access is disabled: pool and model scopes are not configured.',
    );
  }
  if (typeof config.poolId !== 'string' || config.poolId.length === 0 || config.poolId.length > 256) {
    fail('INVALID_CONFIGURATION', 'Registration default access requires a non-empty pool id.');
  }
  if (config.poolId.trim() !== config.poolId || !Array.isArray(config.modelScopes)) {
    fail('INVALID_CONFIGURATION', 'Registration default access pool id or model scopes are malformed.');
  }
  if (config.modelScopes.length === 0 || config.modelScopes.length > 64) {
    fail('INVALID_CONFIGURATION', 'Registration default access requires between 1 and 64 model scopes.');
  }
  const scopes: string[] = [];
  for (const scope of config.modelScopes) {
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > 256 || scope.trim() !== scope) {
      fail('INVALID_CONFIGURATION', 'Registration default access contains an invalid model scope.');
    }
    if (scopes.includes(scope)) {
      fail('INVALID_CONFIGURATION', 'Registration default access contains a duplicate model scope.');
    }
    scopes.push(scope);
  }
  return { poolId: config.poolId, modelScopes: scopes };
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[Number.parseInt(hex[16] ?? '0', 16) & 3] ?? '8';
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((scope, index) => scope === normalizedRight[index]);
}

function positiveVersion(value: number | string): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('STORAGE_ERROR', 'Registration default access read an invalid authorization version.');
  }
  return version;
}

interface ProjectRow {
  readonly id: string;
}

interface PoolRow {
  readonly status: string;
  readonly validation_state: string;
  readonly authz_version: number | string;
}

interface ProfileRow {
  readonly supply_mode: string;
  readonly status: string;
  readonly model_scopes: readonly string[];
  readonly authz_version: number | string;
}

interface EntitlementRow {
  readonly id: string;
  readonly supply_profile_id: string;
  readonly supply_mode: string;
  readonly status: string;
  readonly model_scopes: readonly string[];
  readonly source_type: string;
  readonly source_ref: string | null;
}

interface PoolGrantRow {
  readonly supply_mode: string;
  readonly profile_authz_version: number | string;
  readonly pool_authz_version: number | string;
  readonly status: string;
  readonly expires_at: string | Date | null;
  readonly evidence_ref: string;
  readonly evidence_sha256: string;
}

async function lock(tx: SqlExecutor, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
}

/**
 * Creates only the static personal supply records. Route, commercial, capacity,
 * key and admission provisioning remain separate, explicitly authenticated
 * platform workflows; this bootstrap must not impersonate their administrators.
 */
export class RegistrationDefaultAccessService implements RegistrationDefaultAccessPort {
  constructor(private readonly options: RegistrationDefaultAccessServiceOptions) {}

  async provision(input: { readonly tenantId: string }): Promise<void> {
    const config = normalizeConfig(this.options.config);
    if (!UUID_PATTERN.test(input?.tenantId)) fail('INVALID_CONFIGURATION', 'Registration tenant id is malformed.');
    const tenantId = input.tenantId.toLowerCase();
    const profileId = DEFAULT_PROFILE_ID;

    await this.options.database.transaction(async (tx) => {
      await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      await lock(tx, saasAdvisoryKey.tenant(tenantId));

      const projects = await tx.query<ProjectRow>(
        `SELECT id FROM saas_projects
          WHERE tenant_id = $1 AND is_default = TRUE
          ORDER BY id LIMIT 2 FOR UPDATE`,
        [tenantId],
      );
      if (projects.rows.length !== 1) {
        fail('PROVISIONING_CONFLICT', 'Registration default access requires exactly one default project.');
      }
      const projectId = projects.rows[0]?.id;
      if (projectId === undefined || !UUID_PATTERN.test(projectId)) {
        fail('STORAGE_ERROR', 'Registration default project id is invalid.');
      }
      await lock(tx, saasAdvisoryKey.project(tenantId, projectId));

      const entitlementId = stableUuid(`${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${tenantId}:${projectId}`);
      const sourceRef = `${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${tenantId}:${projectId}`;
      const evidenceSha256 = createHash('sha256').update(sourceRef, 'utf8').digest('hex');
      const entitlements = await tx.query<EntitlementRow>(
        `SELECT id, supply_profile_id, supply_mode, status, model_scopes, source_type, source_ref
           FROM saas_project_entitlements
          WHERE tenant_id = $1 AND project_id = $2
            AND (id = $3 OR (supply_mode = 'platform' AND status = 'active'))
          ORDER BY id LIMIT 3 FOR UPDATE`,
        [tenantId, projectId, entitlementId],
      );
      const defaultEntitlement = entitlements.rows.find((row) => row.id === entitlementId);
      const activeEntitlements = entitlements.rows.filter(
        (row) => row.supply_mode === 'platform' && row.status === 'active',
      );
      if (defaultEntitlement?.status === 'disabled') {
        // An operator's disable decision is authoritative; retries never revive it.
        return;
      }
      if (activeEntitlements.length > 1 || (activeEntitlements.length === 1 && defaultEntitlement === undefined)) {
        fail('PROVISIONING_CONFLICT', 'The default project already has a different active platform entitlement.');
      }
      if (
        defaultEntitlement !== undefined &&
        (defaultEntitlement.status !== 'active' ||
          defaultEntitlement.supply_mode !== 'platform' ||
          defaultEntitlement.supply_profile_id !== profileId ||
          defaultEntitlement.source_type !== 'admin_grant' ||
          defaultEntitlement.source_ref !== sourceRef ||
          !sameScopes(defaultEntitlement.model_scopes, config.modelScopes))
      ) {
        fail('PROVISIONING_CONFLICT', 'The existing registration entitlement does not match the server configuration.');
      }

      await lock(tx, saasAdvisoryKey.platformPool(config.poolId));
      const pools = await tx.query<PoolRow>(
        `SELECT status, validation_state, authz_version
           FROM saas_platform_provider_pools WHERE id = $1 LIMIT 1`,
        [config.poolId],
      );
      const pool = pools.rows[0];
      if (pool === undefined || pool.status !== 'active' || pool.validation_state !== 'verified') {
        fail('PROVISIONING_CONFLICT', 'The configured registration pool is not active and verified.');
      }
      const poolAuthzVersion = positiveVersion(pool.authz_version);

      await lock(tx, saasAdvisoryKey.supplyProfile(tenantId, profileId));
      const profiles = await tx.query<ProfileRow>(
        `SELECT supply_mode, status, model_scopes, authz_version
           FROM saas_supply_profiles WHERE tenant_id = $1 AND id = $2 LIMIT 1 FOR UPDATE`,
        [tenantId, profileId],
      );
      let profile = profiles.rows[0];
      if (
        profile !== undefined &&
        (profile.supply_mode !== 'platform' ||
          profile.status !== 'active' ||
          !sameScopes(profile.model_scopes, config.modelScopes))
      ) {
        fail(
          'PROVISIONING_CONFLICT',
          'The existing registration supply profile does not match the server configuration.',
        );
      }
      if (profile === undefined) {
        const inserted = await tx.query<{ authz_version: number | string }>(
          `INSERT INTO saas_supply_profiles(tenant_id, id, supply_mode, status, model_scopes)
           VALUES($1, $2, 'platform', 'active', $3)
           RETURNING authz_version`,
          [tenantId, profileId, config.modelScopes],
        );
        const authzVersion = inserted.rows[0]?.authz_version;
        if (authzVersion === undefined) fail('STORAGE_ERROR', 'Registration supply profile creation returned no row.');
        profile = {
          supply_mode: 'platform',
          status: 'active',
          model_scopes: config.modelScopes,
          authz_version: authzVersion,
        };
      }
      const profileAuthzVersion = positiveVersion(profile.authz_version);

      if (defaultEntitlement === undefined) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO saas_project_entitlements
             (id, tenant_id, project_id, supply_profile_id, supply_mode, status, model_scopes, source_type, source_ref)
           VALUES($1, $2, $3, $4, 'platform', 'active', $5, 'admin_grant', $6)
           RETURNING id`,
          [entitlementId, tenantId, projectId, profileId, config.modelScopes, sourceRef],
        );
        if (inserted.rows[0]?.id !== entitlementId) {
          fail('STORAGE_ERROR', 'Registration entitlement creation returned no row.');
        }
      }

      const grants = await tx.query<PoolGrantRow>(
        `SELECT supply_mode, profile_authz_version, pool_authz_version, status, expires_at, evidence_ref, evidence_sha256
           FROM saas_platform_provider_pool_grants
          WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3
          LIMIT 1 FOR UPDATE`,
        [config.poolId, tenantId, profileId],
      );
      const grant = grants.rows[0];
      if (
        grant !== undefined &&
        (grant.supply_mode !== 'platform' ||
          positiveVersion(grant.profile_authz_version) !== profileAuthzVersion ||
          positiveVersion(grant.pool_authz_version) !== poolAuthzVersion ||
          grant.status !== 'active' ||
          grant.expires_at !== null ||
          grant.evidence_ref !== sourceRef ||
          grant.evidence_sha256 !== evidenceSha256)
      ) {
        fail('PROVISIONING_CONFLICT', 'The existing registration pool grant does not match the server configuration.');
      }
      if (grant === undefined) {
        const inserted = await tx.query<{ pool_id: string }>(
          `INSERT INTO saas_platform_provider_pool_grants
             (pool_id, tenant_id, supply_profile_id, supply_mode, profile_authz_version,
              pool_authz_version, status, effective_at, expires_at, authz_version,
              evidence_ref, evidence_sha256, created_at, updated_at)
           SELECT $1, $2, $3, 'platform', $4, $5, 'active', grant_clock.observed_at, NULL, 1, $6, $7,
                  grant_clock.observed_at, grant_clock.observed_at
             FROM (SELECT clock_timestamp() AS observed_at) AS grant_clock
           RETURNING pool_id`,
          [config.poolId, tenantId, profileId, profileAuthzVersion, poolAuthzVersion, sourceRef, evidenceSha256],
        );
        if (inserted.rows[0]?.pool_id !== config.poolId) {
          fail('STORAGE_ERROR', 'Registration pool grant creation returned no row.');
        }
      }
    });
  }
}
