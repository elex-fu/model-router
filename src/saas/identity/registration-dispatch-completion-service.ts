import { createHash, createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
  saasAdvisoryKey,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { GatewayProtocol } from '../gateway/contracts.js';
import {
  type CommercialMeteringDimension,
  type CommercialMeteringPolicyServiceOptions,
  type CommercialMeteringRoundingMode,
  type CommercialMeteringTokenSource,
  canonicalContractAttestationPayload,
  type ProviderMeteringPolicyDefinition,
  type RouteConfigDefinition,
} from '../gateway/index.js';
import {
  REGISTRATION_DEFAULT_ACCESS_ENV,
  REGISTRATION_DEFAULT_ACCESS_SOURCE,
} from './registration-default-access-service.js';

/**
 * Server-only registration dispatch defaults. Pool and scopes deliberately
 * reuse RegistrationDefaultAccessService's settings; setting only those two
 * values does not enable dispatch completion. Setting any value below enables
 * this workflow and makes every other value mandatory.
 */
export const REGISTRATION_DISPATCH_COMPLETION_ENV = Object.freeze({
  tenantRequestsPerMinute: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_TENANT_RPM',
  tenantTokensPerMinute: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_TENANT_TPM',
  tenantMaxConcurrentRequests: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_TENANT_MAX_CONCURRENCY',
  projectRequestsPerMinute: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_PROJECT_RPM',
  projectTokensPerMinute: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_PROJECT_TPM',
  projectMaxConcurrentRequests: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_PROJECT_MAX_CONCURRENCY',
  currency: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_CURRENCY',
  usageDimensions: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_USAGE_DIMENSIONS',
  tokenSource: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_TOKEN_SOURCE',
  roundingVersion: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_ROUNDING_VERSION',
  roundingMode: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_ROUNDING_MODE',
  commercialPolicyVersion: 'MODEL_ROUTER_SAAS_REGISTRATION_DISPATCH_COMMERCIAL_POLICY_VERSION',
} as const);

export const REGISTRATION_DISPATCH_COMPLETION_SOURCE = 'registration-dispatch-completion:v1';
const DEFAULT_PROFILE_ID = 'registration-default-platform';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LIMIT = Number.MAX_SAFE_INTEGER;
const MAX_CONCURRENCY = 2_147_483_647;
const DIMENSIONS = new Set([
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output_total',
  'reasoning_output',
]);
const PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);
const ROUNDING_MODES = new Set(['floor', 'ceil', 'half_up', 'half_even']);
const TOKEN_SOURCES = new Set(['upstream', 'local-estimate', 'legacy']);

export interface RegistrationDispatchCapacityLimits {
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly maxConcurrentRequests: number;
}

export interface RegistrationDispatchCompletionConfig {
  readonly poolId: string;
  readonly modelScopes: readonly string[];
  readonly currency: string;
  readonly usageDimensions: readonly CommercialMeteringDimension[];
  readonly tokenSource: CommercialMeteringTokenSource;
  readonly roundingVersion: string;
  readonly roundingMode: CommercialMeteringRoundingMode;
  readonly commercialPolicyVersion: string;
  readonly tenant: RegistrationDispatchCapacityLimits;
  readonly project: RegistrationDispatchCapacityLimits;
}

export interface RegistrationDispatchCompletionPort {
  complete(input: { readonly tenantId: string }): Promise<RegistrationDispatchCompletionResult>;
}

/** Input to a real trusted contract-test runner. It is not permission to self-attest. */
export interface RegistrationContractTestInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly routeVersion: '2';
  readonly providerPolicyId: string;
  readonly providerPolicyVersion: '2';
  readonly definition: ProviderMeteringPolicyDefinition;
}

/** Evidence returned only after the runner actually executed the named suite. */
export interface RegistrationContractTestEvidence {
  readonly contractDigest: string;
  readonly suiteVersion: string;
  readonly testVectorDigest: string;
  readonly verifierKeyId: string;
  readonly signatureBase64: string;
}

export interface RegistrationContractTestPort {
  execute(input: RegistrationContractTestInput): Promise<RegistrationContractTestEvidence>;
}

export interface RegistrationDispatchCompletionServiceOptions {
  readonly database: SaasDatabase;
  /** Undefined is a deliberate no-op; partial enabled configuration fails closed. */
  readonly config?: RegistrationDispatchCompletionConfig;
  readonly contractTests?: RegistrationContractTestPort;
  readonly trustedVerifierPublicKeys?: CommercialMeteringPolicyServiceOptions['trustedVerifierPublicKeys'];
  readonly trustedTestVectorDigests?: CommercialMeteringPolicyServiceOptions['trustedTestVectorDigests'];
}

export type RegistrationDispatchCompletionErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'REGISTRATION_ACCESS_MISMATCH'
  | 'PUBLIC_MODEL_UNAVAILABLE'
  | 'PRICING_UNAVAILABLE'
  | 'ATTESTATION_REQUIRED'
  | 'ATTESTATION_INVALID'
  | 'PROVISIONING_CONFLICT'
  | 'STORAGE_ERROR';

export class RegistrationDispatchCompletionError extends Error {
  constructor(
    readonly code: RegistrationDispatchCompletionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RegistrationDispatchCompletionError';
  }
}

export type RegistrationDispatchCompletionResult =
  | { readonly status: 'disabled' }
  | { readonly status: 'operator_disabled'; readonly tenantId: string; readonly projectId?: string }
  | {
      readonly status: 'completed';
      readonly tenantId: string;
      readonly projectId: string;
      readonly routes: readonly {
        readonly modelScope: string;
        readonly routeId: string;
        readonly customerPriceVersion: string;
        readonly supplierCostVersion: string;
      }[];
    };

function fail(code: RegistrationDispatchCompletionErrorCode, message: string, cause?: unknown): never {
  throw new RegistrationDispatchCompletionError(code, message, cause === undefined ? undefined : { cause });
}

class OperatorDisabled extends Error {}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[Number.parseInt(hex[16] ?? '0', 16) & 3] ?? '8';
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function text(value: unknown, label: string, maxLength = 255): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    fail('INVALID_CONFIGURATION', `Registration dispatch ${label} is malformed.`);
  }
  return value;
}

function limit(value: unknown, label: string, maximum = MAX_LIMIT): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      'INVALID_CONFIGURATION',
      `Registration dispatch ${label} must be a positive safe integer within its SQL limit.`,
    );
  }
  return value;
}

function limits(value: RegistrationDispatchCapacityLimits, label: string): RegistrationDispatchCapacityLimits {
  return {
    requestsPerMinute: limit(value?.requestsPerMinute, `${label} RPM`),
    tokensPerMinute: limit(value?.tokensPerMinute, `${label} TPM`),
    maxConcurrentRequests: limit(value?.maxConcurrentRequests, `${label} concurrency`, MAX_CONCURRENCY),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function normalizeConfig(
  config: RegistrationDispatchCompletionConfig | undefined,
): RegistrationDispatchCompletionConfig | undefined {
  if (config === undefined) return undefined;
  const poolId = text(config.poolId, 'pool id');
  if (!Array.isArray(config.modelScopes) || config.modelScopes.length < 1 || config.modelScopes.length > 64) {
    fail('INVALID_CONFIGURATION', 'Registration dispatch requires between 1 and 64 model scopes.');
  }
  const modelScopes = config.modelScopes.map((scope) => text(scope, 'model scope'));
  if (new Set(modelScopes).size !== modelScopes.length) {
    fail('INVALID_CONFIGURATION', 'Registration dispatch model scopes must be unique.');
  }
  const currency = text(config.currency, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(currency))
    fail('INVALID_CONFIGURATION', 'Registration dispatch currency must be ISO-style uppercase.');
  if (
    !Array.isArray(config.usageDimensions) ||
    config.usageDimensions.length < 1 ||
    config.usageDimensions.length > 8
  ) {
    fail('INVALID_CONFIGURATION', 'Registration dispatch requires 1 to 8 usage dimensions.');
  }
  const usageDimensions = config.usageDimensions.map((dimension) => text(dimension, 'usage dimension', 64));
  if (
    new Set(usageDimensions).size !== usageDimensions.length ||
    usageDimensions.some((dimension) => !DIMENSIONS.has(dimension))
  ) {
    fail('INVALID_CONFIGURATION', 'Registration dispatch usage dimensions are unsupported or duplicated.');
  }
  if (!TOKEN_SOURCES.has(config.tokenSource))
    fail('INVALID_CONFIGURATION', 'Registration dispatch token source is invalid.');
  if (!ROUNDING_MODES.has(config.roundingMode))
    fail('INVALID_CONFIGURATION', 'Registration dispatch rounding mode is invalid.');
  return {
    poolId,
    modelScopes,
    currency,
    usageDimensions: usageDimensions as CommercialMeteringDimension[],
    tokenSource: config.tokenSource,
    roundingVersion: text(config.roundingVersion, 'rounding version', 128),
    roundingMode: config.roundingMode,
    commercialPolicyVersion: text(config.commercialPolicyVersion, 'commercial policy version', 128),
    tenant: limits(config.tenant, 'tenant'),
    project: limits(config.project, 'project'),
  };
}

function numericEnv(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const raw = env[name]?.trim() ?? '';
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
}

/** Parse without throwing so RegistrationService can report errors post-commit. */
export function registrationDispatchCompletionConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RegistrationDispatchCompletionConfig | undefined {
  const names = Object.values(REGISTRATION_DISPATCH_COMPLETION_ENV);
  if (!names.some((name) => (env[name]?.trim() ?? '').length > 0)) return undefined;
  const rawScopes = env[REGISTRATION_DEFAULT_ACCESS_ENV.modelScopes]?.trim() ?? '';
  return {
    poolId: env[REGISTRATION_DEFAULT_ACCESS_ENV.poolId]?.trim() ?? '',
    modelScopes: rawScopes.length === 0 ? [] : rawScopes.split(',').map((scope) => scope.trim()),
    tenant: {
      requestsPerMinute: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.tenantRequestsPerMinute),
      tokensPerMinute: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.tenantTokensPerMinute),
      maxConcurrentRequests: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.tenantMaxConcurrentRequests),
    },
    project: {
      requestsPerMinute: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.projectRequestsPerMinute),
      tokensPerMinute: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.projectTokensPerMinute),
      maxConcurrentRequests: numericEnv(env, REGISTRATION_DISPATCH_COMPLETION_ENV.projectMaxConcurrentRequests),
    },
    currency: env[REGISTRATION_DISPATCH_COMPLETION_ENV.currency]?.trim() ?? '',
    usageDimensions: (env[REGISTRATION_DISPATCH_COMPLETION_ENV.usageDimensions]?.trim() ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0) as CommercialMeteringDimension[],
    tokenSource: (env[REGISTRATION_DISPATCH_COMPLETION_ENV.tokenSource]?.trim() ?? '') as CommercialMeteringTokenSource,
    roundingVersion: env[REGISTRATION_DISPATCH_COMPLETION_ENV.roundingVersion]?.trim() ?? '',
    roundingMode: (env[REGISTRATION_DISPATCH_COMPLETION_ENV.roundingMode]?.trim() ??
      '') as CommercialMeteringRoundingMode,
    commercialPolicyVersion: env[REGISTRATION_DISPATCH_COMPLETION_ENV.commercialPolicyVersion]?.trim() ?? '',
  };
}

function positiveDecimal(value: unknown, label: string): string {
  const result = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(result) || BigInt(result) > BigInt(MAX_LIMIT)) {
    fail('STORAGE_ERROR', `Registration dispatch read an invalid ${label}.`);
  }
  return result;
}

async function lock(tx: SqlExecutor, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
}

function trustValue<T>(
  values: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return values instanceof Map ? values.get(key) : (values as Readonly<Record<string, T>> | undefined)?.[key];
}

interface ProjectCapacityRow {
  readonly id: string;
  readonly inference_policy_version: number | string;
  readonly inference_policy_status: string;
  readonly tenant_status: string;
  readonly capacity_policy_revision: number | string;
  readonly tenant_rpm: number | string | null;
  readonly tenant_tpm: number | string | null;
  readonly tenant_concurrency: number | string | null;
}

interface RegistrationAccessRow {
  readonly entitlement_id: string;
  readonly entitlement_authz_version: number | string;
  readonly entitlement_status: string;
  readonly entitlement_profile_id: string;
  readonly entitlement_supply_mode: string;
  readonly entitlement_scopes: readonly string[];
  readonly entitlement_source_type: string;
  readonly entitlement_source_ref: string | null;
  readonly profile_status: string;
  readonly profile_supply_mode: string;
  readonly profile_scopes: readonly string[];
  readonly profile_authz_version: number | string;
  readonly pool_status: string;
  readonly pool_validation_state: string;
  readonly pool_authz_version: number | string;
  readonly pool_provider_id: string;
  readonly pool_product_id: string;
  readonly grant_status: string;
  readonly grant_supply_mode: string;
  readonly grant_profile_authz_version: number | string;
  readonly grant_pool_authz_version: number | string;
  readonly grant_expires_at: string | Date | null;
  readonly grant_evidence_ref: string;
  readonly grant_evidence_sha256: string;
  /** Transaction-clock predicate: the grant must already be effective. */
  readonly grant_effective: boolean;
}

interface ModelRow {
  readonly id: string;
  readonly alias: string;
  readonly version: number | string;
  readonly provider_id: string;
  readonly product_id: string;
  readonly resolved_model: string;
  readonly endpoint_scope: readonly string[];
}

interface PriceRow {
  readonly id: string;
  readonly currency: string;
  readonly commercial_policy_version: string;
  readonly rounding_version: string;
  readonly rounding_mode: string;
  readonly rounding_boundary: string;
}

interface Plan {
  readonly modelScope: string;
  readonly routeId: string;
  readonly customerPolicyId: string;
  readonly providerPolicyId: string;
  readonly attestationId: string;
  readonly definition: RouteConfigDefinition;
  readonly providerDefinition: ProviderMeteringPolicyDefinition;
  readonly customerPriceVersion: string;
  readonly supplierCostVersion: string;
}

function routeDefinitionMatches(row: Record<string, unknown>, definition: RouteConfigDefinition): boolean {
  return (
    row.public_model_id === definition.publicModelId &&
    String(row.public_model_version) === String(definition.publicModelVersion) &&
    row.protocol === definition.protocol &&
    row.supply_mode === definition.supplyMode &&
    row.target_mode === definition.targetMode &&
    row.upstream_id === definition.upstreamId &&
    row.endpoint === definition.endpoint
  );
}

function policyDefinitionMatches(
  row: Record<string, unknown>,
  definition: ProviderMeteringPolicyDefinition,
  customerPriceVersion: string,
  kind: 'customer' | 'provider',
): boolean {
  const common =
    row.public_model_id === definition.publicModelId &&
    String(row.public_model_version) === String(definition.publicModelVersion) &&
    row.protocol === definition.protocol &&
    row.endpoint === definition.endpoint &&
    row.supply_mode === definition.supplyMode &&
    row.target_mode === definition.targetMode &&
    sameStrings((row.usage_dimensions ?? []) as readonly string[], definition.usageDimensions) &&
    row.token_source === definition.tokenSource &&
    row.rounding_version === definition.roundingVersion &&
    row.rounding_mode === definition.roundingMode &&
    row.rounding_boundary === 'total' &&
    row.commercial_policy_version === definition.commercialPolicyVersion;
  if (!common) return false;
  if (kind === 'provider') {
    return (
      row.provider_id === definition.providerId &&
      row.product_id === definition.productId &&
      row.resolved_model === definition.resolvedModel &&
      row.supplier_cost_version === definition.supplierCostVersion
    );
  }
  return row.customer_price_version === customerPriceVersion;
}

export class RegistrationDispatchCompletionService implements RegistrationDispatchCompletionPort {
  constructor(private readonly options: RegistrationDispatchCompletionServiceOptions) {}

  async complete(input: { readonly tenantId: string }): Promise<RegistrationDispatchCompletionResult> {
    const config = normalizeConfig(this.options.config);
    if (config === undefined) return { status: 'disabled' };
    if (!UUID_PATTERN.test(input?.tenantId)) fail('INVALID_CONFIGURATION', 'Registration tenant id is malformed.');
    if (this.options.trustedVerifierPublicKeys === undefined || this.options.trustedTestVectorDigests === undefined) {
      fail('INVALID_CONFIGURATION', 'Registration dispatch requires commercial attestation trust configuration.');
    }
    const tenantId = input.tenantId.toLowerCase();
    try {
      return await this.options.database.transaction(async (tx) => {
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
        await lock(tx, saasAdvisoryKey.tenant(tenantId));
        const projects = await tx.query<ProjectCapacityRow>(
          `SELECT p.id, p.inference_policy_version, p.inference_policy_status,
                  t.status AS tenant_status, t.capacity_policy_revision,
                  t.requests_per_minute AS tenant_rpm, t.tokens_per_minute AS tenant_tpm,
                  t.max_concurrent_requests AS tenant_concurrency
             FROM saas_projects p JOIN saas_tenants t ON t.id=p.tenant_id
            WHERE p.tenant_id=$1 AND p.is_default=TRUE
            ORDER BY p.id LIMIT 2 FOR UPDATE OF p,t`,
          [tenantId],
        );
        if (projects.rows.length !== 1)
          fail('REGISTRATION_ACCESS_MISMATCH', 'Exactly one default project is required.');
        const project = projects.rows[0];
        if (project === undefined || !UUID_PATTERN.test(project.id))
          fail('STORAGE_ERROR', 'Default project id is invalid.');
        const projectId = project.id.toLowerCase();
        await lock(tx, saasAdvisoryKey.project(tenantId, projectId));
        await lock(tx, saasAdvisoryKey.platformPool(config.poolId));
        await lock(tx, saasAdvisoryKey.supplyProfile(tenantId, DEFAULT_PROFILE_ID));
        if (project.tenant_status === 'disabled' || project.inference_policy_status === 'disabled') {
          throw new OperatorDisabled();
        }
        if (project.tenant_status !== 'active') fail('PROVISIONING_CONFLICT', 'Registration tenant is not active.');

        const entitlementId = stableUuid(`${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${tenantId}:${projectId}`);
        const sourceRef = `${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${tenantId}:${projectId}`;
        const evidenceSha256 = createHash('sha256').update(sourceRef, 'utf8').digest('hex');
        const accessRows = await tx.query<RegistrationAccessRow>(
          `SELECT e.id AS entitlement_id, e.authz_version AS entitlement_authz_version,
                  e.status AS entitlement_status, e.supply_profile_id AS entitlement_profile_id,
                  e.supply_mode AS entitlement_supply_mode, e.model_scopes AS entitlement_scopes,
                  e.source_type AS entitlement_source_type, e.source_ref AS entitlement_source_ref,
                  s.status AS profile_status, s.supply_mode AS profile_supply_mode,
                  s.model_scopes AS profile_scopes, s.authz_version AS profile_authz_version,
                  p.status AS pool_status, p.validation_state AS pool_validation_state,
                  p.authz_version AS pool_authz_version, p.provider_id AS pool_provider_id,
                  p.product_id AS pool_product_id, g.status AS grant_status,
                  g.supply_mode AS grant_supply_mode, g.profile_authz_version AS grant_profile_authz_version,
                  g.pool_authz_version AS grant_pool_authz_version, g.expires_at AS grant_expires_at,
                  g.evidence_ref AS grant_evidence_ref, g.evidence_sha256 AS grant_evidence_sha256,
                  (g.effective_at <= now()) AS grant_effective
             FROM saas_project_entitlements e
             JOIN saas_supply_profiles s ON s.tenant_id=e.tenant_id AND s.id=e.supply_profile_id
             JOIN saas_platform_provider_pool_grants g
               ON g.tenant_id=e.tenant_id AND g.supply_profile_id=e.supply_profile_id
             JOIN saas_platform_provider_pools p ON p.id=g.pool_id
            WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.id=$3 AND g.pool_id=$4
            LIMIT 1 FOR UPDATE OF e,s,g`,
          [tenantId, projectId, entitlementId, config.poolId],
        );
        const access = accessRows.rows[0];
        if (access === undefined) {
          fail(
            'REGISTRATION_ACCESS_MISMATCH',
            'Registration profile, entitlement, and configured pool grant must already exist.',
          );
        }
        if (
          access.entitlement_status === 'disabled' ||
          access.profile_status === 'disabled' ||
          access.grant_status === 'disabled'
        ) {
          throw new OperatorDisabled();
        }
        if (
          access.entitlement_status !== 'active' ||
          positiveDecimal(access.entitlement_authz_version, 'entitlement authz version') !== '1' ||
          access.entitlement_profile_id !== DEFAULT_PROFILE_ID ||
          access.entitlement_supply_mode !== 'platform' ||
          !sameScopes(access.entitlement_scopes, config.modelScopes) ||
          access.entitlement_source_type !== 'admin_grant' ||
          access.entitlement_source_ref !== sourceRef ||
          access.profile_status !== 'active' ||
          access.profile_supply_mode !== 'platform' ||
          !sameScopes(access.profile_scopes, config.modelScopes) ||
          access.pool_status !== 'active' ||
          access.pool_validation_state !== 'verified' ||
          access.grant_status !== 'active' ||
          access.grant_supply_mode !== 'platform' ||
          access.grant_effective !== true ||
          access.grant_expires_at !== null ||
          access.grant_evidence_ref !== sourceRef ||
          access.grant_evidence_sha256 !== evidenceSha256 ||
          positiveDecimal(access.grant_profile_authz_version, 'grant profile authz version') !==
            positiveDecimal(access.profile_authz_version, 'profile authz version') ||
          positiveDecimal(access.grant_pool_authz_version, 'grant pool authz version') !==
            positiveDecimal(access.pool_authz_version, 'pool authz version')
        ) {
          fail(
            'REGISTRATION_ACCESS_MISMATCH',
            'Existing registration access does not exactly match the configured authority.',
          );
        }

        const plans: Plan[] = [];
        for (const modelScope of config.modelScopes) {
          plans.push(await this.resolvePlan(tx, config, tenantId, projectId, modelScope, access));
        }
        for (const plan of plans) await this.completeRoute(tx, tenantId, projectId, plan);
        await this.completeCapacity(tx, tenantId, projectId, project, config);
        for (const plan of plans) {
          const dispatchable = await tx.query<{ route_id: string }>(
            `SELECT route_id FROM saas_route_config_dispatchable
              WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 AND version=2`,
            [tenantId, projectId, plan.routeId],
          );
          if (dispatchable.rows.length !== 1)
            fail('STORAGE_ERROR', 'Published registration route is not dispatchable.');
        }
        return {
          status: 'completed' as const,
          tenantId,
          projectId,
          routes: plans.map((plan) => ({
            modelScope: plan.modelScope,
            routeId: plan.routeId,
            customerPriceVersion: plan.customerPriceVersion,
            supplierCostVersion: plan.supplierCostVersion,
          })),
        };
      });
    } catch (error) {
      if (error instanceof OperatorDisabled) return { status: 'operator_disabled', tenantId };
      throw error;
    }
  }

  private async resolvePlan(
    tx: SqlExecutor,
    config: RegistrationDispatchCompletionConfig,
    tenantId: string,
    projectId: string,
    modelScope: string,
    access: RegistrationAccessRow,
  ): Promise<Plan> {
    const models = await tx.query<ModelRow>(
      `SELECT m.id, m.alias, v.version, v.provider_id, v.product_id,
              v.model AS resolved_model, v.endpoint_scope
         FROM saas_public_models m
         JOIN saas_public_model_versions v ON v.public_model_id=m.id
        WHERE m.alias=$1 AND m.status='active' AND v.status='active'
        ORDER BY v.version LIMIT 2`,
      [modelScope],
    );
    if (models.rows.length !== 1) {
      fail(
        'PUBLIC_MODEL_UNAVAILABLE',
        `Configured public model scope ${modelScope} must resolve to exactly one active version.`,
      );
    }
    const model = models.rows[0];
    if (model === undefined || model.alias !== modelScope)
      fail('STORAGE_ERROR', 'Resolved public model identity is inconsistent.');
    if (model.provider_id !== access.pool_provider_id || model.product_id !== access.pool_product_id) {
      fail(
        'PUBLIC_MODEL_UNAVAILABLE',
        `Configured public model ${modelScope} is not supplied by the registration pool.`,
      );
    }
    const capabilities = await tx.query<{ protocol: GatewayProtocol; endpoint: string }>(
      `SELECT cap.protocol, cap.endpoint
         FROM saas_provider_capabilities cap
        WHERE cap.provider_id=$1 AND cap.product_id=$2 AND cap.model=$3
          AND cap.endpoint=ANY($4::text[])
          AND cap.validation_state='verified' AND cap.support_level IN ('supported','limited')
          AND cap.version=(SELECT MAX(latest.version) FROM saas_provider_capabilities latest
                            WHERE latest.provider_id=cap.provider_id AND latest.product_id=cap.product_id
                              AND latest.model=cap.model AND latest.endpoint=cap.endpoint)
        ORDER BY cap.protocol,cap.endpoint LIMIT 2`,
      [model.provider_id, model.product_id, model.resolved_model, model.endpoint_scope],
    );
    if (capabilities.rows.length !== 1 || !PROTOCOLS.has(capabilities.rows[0]?.protocol ?? '')) {
      fail(
        'PUBLIC_MODEL_UNAVAILABLE',
        `Configured public model ${modelScope} has no unique verified protocol and endpoint.`,
      );
    }
    const capability = capabilities.rows[0];
    if (capability === undefined) fail('STORAGE_ERROR', 'Capability resolution returned no row.');
    const publicModelVersion = positiveDecimal(model.version, 'public model version');
    const definition: RouteConfigDefinition = {
      publicModelId: model.id,
      publicModelVersion,
      protocol: capability.protocol,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      upstreamId: config.poolId,
      endpoint: capability.endpoint,
    };
    const price = await this.resolvePrice(tx, 'customer', config, model, capability);
    const cost = await this.resolvePrice(tx, 'supplier', config, model, capability);
    const routeKey = `${REGISTRATION_DISPATCH_COMPLETION_SOURCE}:${tenantId}:${projectId}:${modelScope}`;
    const providerPolicyId = stableUuid(`${routeKey}:provider-policy`);
    const providerDefinition: ProviderMeteringPolicyDefinition = {
      publicModelId: model.id,
      publicModelVersion,
      protocol: capability.protocol,
      endpoint: capability.endpoint,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      providerId: model.provider_id,
      productId: model.product_id,
      resolvedModel: model.resolved_model,
      supplierCostVersion: cost,
      usageDimensions: config.usageDimensions,
      tokenSource: config.tokenSource,
      roundingVersion: config.roundingVersion,
      roundingMode: config.roundingMode,
      roundingBoundary: 'total',
      commercialPolicyVersion: config.commercialPolicyVersion,
    };
    await this.requirePoolReadiness(tx, config.poolId, providerDefinition);
    return {
      modelScope,
      routeId: stableUuid(`${routeKey}:route`),
      customerPolicyId: stableUuid(`${routeKey}:customer-policy`),
      providerPolicyId,
      attestationId: stableUuid(`${routeKey}:contract-attestation`),
      definition,
      providerDefinition,
      customerPriceVersion: price,
      supplierCostVersion: cost,
    };
  }

  private async resolvePrice(
    tx: SqlExecutor,
    kind: 'customer' | 'supplier',
    config: RegistrationDispatchCompletionConfig,
    model: ModelRow,
    capability: { readonly protocol: GatewayProtocol; readonly endpoint: string },
  ): Promise<string> {
    const customer = kind === 'customer';
    const table = customer ? 'saas_customer_price_versions' : 'saas_supplier_cost_versions';
    const values: unknown[] = [
      model.id,
      positiveDecimal(model.version, 'public model version'),
      model.provider_id,
      model.product_id,
    ];
    if (!customer) values.push(model.resolved_model);
    values.push(capability.protocol, capability.endpoint, config.currency);
    const resolvedModelPredicate = customer ? '' : `AND resolved_model=$5`;
    const protocolIndex = customer ? 5 : 6;
    // The exact commercial/rounding policy must be part of selection itself:
    // filtering only after ORDER BY would let a newer incompatible row mask
    // an older currently-effective row that exactly matches the configured policy.
    values.push(config.commercialPolicyVersion, config.roundingVersion, config.roundingMode);
    const commercialIndex = protocolIndex + 3;
    const selected = await tx.query<PriceRow>(
      `SELECT id,currency,commercial_policy_version,rounding_version,rounding_mode,rounding_boundary
         FROM ${table}
        WHERE public_model_id=$1 AND public_model_version=$2 AND provider_id=$3 AND product_id=$4
          ${resolvedModelPredicate}
          AND protocol=$${protocolIndex} AND endpoint=$${protocolIndex + 1} AND currency=$${protocolIndex + 2}
          AND effective_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp())
          AND commercial_policy_version=$${commercialIndex} AND rounding_version=$${commercialIndex + 1}
          AND rounding_mode=$${commercialIndex + 2} AND rounding_boundary='total'
        ORDER BY effective_at DESC,version DESC LIMIT 1`,
      values,
    );
    const row = selected.rows[0];
    if (
      row === undefined ||
      row.currency !== config.currency ||
      row.commercial_policy_version !== config.commercialPolicyVersion ||
      row.rounding_version !== config.roundingVersion ||
      row.rounding_mode !== config.roundingMode ||
      row.rounding_boundary !== 'total'
    ) {
      fail(
        'PRICING_UNAVAILABLE',
        `No effective ${kind} price exactly matches registration commercial policy for ${model.alias}.`,
      );
    }
    return row.id;
  }

  private async requirePoolReadiness(
    tx: SqlExecutor,
    poolId: string,
    provider: ProviderMeteringPolicyDefinition,
  ): Promise<void> {
    const available = await tx.query<{ id: string }>(
      `SELECT a.id FROM saas_platform_provider_pools p
         JOIN saas_platform_provider_pool_members m ON m.pool_id=p.id
         JOIN saas_platform_provider_accounts a ON a.id=m.account_id AND a.provider_id=p.provider_id AND a.product_id=p.product_id
         JOIN saas_platform_provider_credentials c ON c.account_id=a.id AND c.provider_id=a.provider_id AND c.product_id=a.product_id
         JOIN saas_platform_provider_credential_versions v ON v.account_id=c.account_id AND v.credential_id=c.id AND v.version=c.current_version
         JOIN saas_platform_provider_account_capabilities ac ON ac.account_id=a.id AND ac.provider_id=a.provider_id AND ac.product_id=a.product_id AND ac.model=$4 AND ac.endpoint=$5
         JOIN saas_provider_capabilities cap ON cap.provider_id=ac.provider_id AND cap.product_id=ac.product_id AND cap.model=ac.model AND cap.endpoint=ac.endpoint AND cap.version=ac.capability_version
         JOIN saas_provider_products product ON product.provider_id=p.provider_id AND product.product_id=p.product_id AND product.status='active'
         JOIN saas_provider_rights rights ON rights.rights_id=a.rights_id AND rights.version=a.rights_version
         JOIN saas_provider_rights pool_rights ON pool_rights.rights_id=p.rights_id AND pool_rights.version=p.rights_version
        WHERE p.id=$1 AND p.provider_id=$2 AND p.product_id=$3 AND p.status='active' AND p.validation_state='verified'
          AND m.provider_id=a.provider_id AND m.product_id=a.product_id AND m.status='active' AND m.account_authz_version=a.authz_version
          AND a.status='active' AND a.validation_state='verified'
          AND c.status='active' AND c.validation_state='verified' AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
          AND c.credential_type=a.credential_type AND c.credential_type=p.credential_type
          AND v.status='active' AND v.owner_kind='platform' AND v.supply_mode='platform' AND (v.expires_at IS NULL OR v.expires_at>clock_timestamp())
          AND cap.validation_state='verified' AND cap.support_level IN ('supported','limited') AND cap.protocol=$6
          AND cap.version=(SELECT MAX(latest.version) FROM saas_provider_capabilities latest WHERE latest.provider_id=cap.provider_id AND latest.product_id=cap.product_id AND latest.model=cap.model AND latest.endpoint=cap.endpoint)
          AND rights.status='active' AND rights.effective_at<=clock_timestamp() AND (rights.expires_at IS NULL OR rights.expires_at>clock_timestamp())
          AND rights.provider_id=a.provider_id AND rights.product_id=a.product_id AND rights.credential_type=a.credential_type AND rights.supply_mode=a.supply_mode AND rights.region=a.region AND rights.purpose=a.purpose
          AND pool_rights.provider_id=p.provider_id AND pool_rights.product_id=p.product_id AND pool_rights.credential_type=p.credential_type AND pool_rights.supply_mode=p.supply_mode AND pool_rights.region=p.region AND pool_rights.purpose=p.purpose
          AND pool_rights.status='active' AND pool_rights.effective_at<=clock_timestamp() AND (pool_rights.expires_at IS NULL OR pool_rights.expires_at>clock_timestamp())
          AND pool_rights.version=(SELECT latest.version FROM saas_provider_rights latest WHERE latest.rights_id=pool_rights.rights_id AND latest.effective_at<=clock_timestamp() ORDER BY latest.effective_at DESC,latest.version DESC LIMIT 1)
          AND $4=ANY(pool_rights.model_scope) AND $5=ANY(pool_rights.endpoint_scope)
          AND rights.version=(SELECT latest.version FROM saas_provider_rights latest WHERE latest.rights_id=rights.rights_id AND latest.effective_at<=clock_timestamp() ORDER BY latest.effective_at DESC,latest.version DESC LIMIT 1)
          AND $4=ANY(rights.model_scope) AND $5=ANY(rights.endpoint_scope) LIMIT 1`,
      [poolId, provider.providerId, provider.productId, provider.resolvedModel, provider.endpoint, provider.protocol],
    );
    if (available.rows.length !== 1) {
      fail('PUBLIC_MODEL_UNAVAILABLE', 'The registration pool has no verified ready account for the resolved model.');
    }
  }

  private async completeRoute(tx: SqlExecutor, tenantId: string, projectId: string, plan: Plan): Promise<void> {
    await this.ensureRoute(tx, tenantId, projectId, plan);
    await this.ensurePolicy(tx, tenantId, projectId, plan, 'customer');
    await this.ensurePolicy(tx, tenantId, projectId, plan, 'provider');
    await this.ensureAttestation(tx, tenantId, projectId, plan);
    const binding = await tx.query<Record<string, unknown>>(
      `SELECT customer_policy_id,customer_policy_version,provider_policy_id,provider_policy_version,
              contract_attestation_id,customer_price_version,supplier_cost_version
         FROM saas_route_config_commercial_authorities
        WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 AND route_version=2 LIMIT 1`,
      [tenantId, projectId, plan.routeId],
    );
    const existing = binding.rows[0];
    if (existing !== undefined) {
      if (
        existing.customer_policy_id !== plan.customerPolicyId ||
        String(existing.customer_policy_version) !== '2' ||
        existing.provider_policy_id !== plan.providerPolicyId ||
        String(existing.provider_policy_version) !== '2' ||
        existing.contract_attestation_id !== plan.attestationId ||
        existing.customer_price_version !== plan.customerPriceVersion ||
        existing.supplier_cost_version !== plan.supplierCostVersion
      ) {
        fail('PROVISIONING_CONFLICT', 'Existing route commercial binding does not match registration configuration.');
      }
      return;
    }
    await tx.query(
      `INSERT INTO saas_route_config_commercial_authorities
         (tenant_id,project_id,route_id,route_version,customer_policy_id,customer_policy_version,
          provider_policy_id,provider_policy_version,contract_attestation_id,customer_price_version,
          supplier_cost_version,created_by_user_id,created_at)
       VALUES($1,$2,$3,2,$4,2,$5,2,$6,$7,$8,NULL,clock_timestamp())`,
      [
        tenantId,
        projectId,
        plan.routeId,
        plan.customerPolicyId,
        plan.providerPolicyId,
        plan.attestationId,
        plan.customerPriceVersion,
        plan.supplierCostVersion,
      ],
    );
    await this.audit(
      tx,
      tenantId,
      projectId,
      'commercial_metering.route_authority_bound',
      'saas_route_config',
      plan.routeId,
      'binding',
    );
  }

  private async ensureRoute(tx: SqlExecutor, tenantId: string, projectId: string, plan: Plan): Promise<void> {
    const heads = await tx.query<{ current_version: number | string; status: string }>(
      `SELECT current_version,status FROM saas_route_config_heads
        WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 LIMIT 1 FOR UPDATE`,
      [tenantId, projectId, plan.routeId],
    );
    const head = heads.rows[0];
    if (head?.status === 'disabled') throw new OperatorDisabled();
    if (head === undefined) {
      await this.insertRouteVersion(tx, tenantId, projectId, plan, 1, 'draft');
      await tx.query(
        `INSERT INTO saas_route_config_heads(tenant_id,project_id,route_id,current_version,status,changed_by_user_id,created_at,updated_at)
         VALUES($1,$2,$3,1,'draft',NULL,clock_timestamp(),clock_timestamp())`,
        [tenantId, projectId, plan.routeId],
      );
      await this.audit(
        tx,
        tenantId,
        projectId,
        'route_config.created',
        'saas_route_config',
        plan.routeId,
        'route-created',
      );
    } else {
      await this.requireRouteVersion(
        tx,
        tenantId,
        projectId,
        plan,
        positiveDecimal(head.current_version, 'route version'),
        head.status,
      );
      if (String(head.current_version) === '2' && head.status === 'active') return;
      if (String(head.current_version) !== '1' || head.status !== 'draft') {
        fail('PROVISIONING_CONFLICT', 'Existing registration route head cannot be resumed safely.');
      }
    }
    await this.insertRouteVersion(tx, tenantId, projectId, plan, 2, 'active');
    const updated = await tx.query<{ route_id: string }>(
      `UPDATE saas_route_config_heads SET current_version=2,status='active',changed_by_user_id=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 AND current_version=1 AND status='draft' RETURNING route_id`,
      [tenantId, projectId, plan.routeId],
    );
    if (updated.rows.length !== 1)
      fail('PROVISIONING_CONFLICT', 'Registration route publication lost its version fence.');
    await this.audit(
      tx,
      tenantId,
      projectId,
      'route_config.published',
      'saas_route_config',
      plan.routeId,
      'route-published',
    );
  }

  private async requireRouteVersion(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    plan: Plan,
    version: string,
    status: string,
  ): Promise<void> {
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT public_model_id,public_model_version,protocol,supply_mode,target_mode,upstream_id,endpoint,status
         FROM saas_route_config_versions
        WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 AND version=$4 LIMIT 1`,
      [tenantId, projectId, plan.routeId, version],
    );
    const row = rows.rows[0];
    if (row === undefined || row.status !== status || !routeDefinitionMatches(row, plan.definition)) {
      fail('PROVISIONING_CONFLICT', 'Existing registration route version does not exactly match configuration.');
    }
  }

  private async insertRouteVersion(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    plan: Plan,
    version: number,
    status: 'draft' | 'active',
  ): Promise<void> {
    await tx.query(
      `INSERT INTO saas_route_config_versions
         (tenant_id,project_id,route_id,version,status,public_model_id,public_model_version,
          protocol,supply_mode,target_mode,upstream_id,endpoint,changed_by_user_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'platform','platform_pool',$9,$10,NULL,clock_timestamp())`,
      [
        tenantId,
        projectId,
        plan.routeId,
        version,
        status,
        plan.definition.publicModelId,
        plan.definition.publicModelVersion,
        plan.definition.protocol,
        plan.definition.upstreamId,
        plan.definition.endpoint,
      ],
    );
  }

  private async ensurePolicy(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    plan: Plan,
    kind: 'customer' | 'provider',
  ): Promise<void> {
    const customer = kind === 'customer';
    const table = customer ? 'customer' : 'provider';
    const policyId = customer ? plan.customerPolicyId : plan.providerPolicyId;
    const heads = await tx.query<{ current_version: number | string; status: string }>(
      `SELECT current_version,status FROM saas_${table}_metering_policy_heads
        WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$3 LIMIT 1 FOR UPDATE`,
      [tenantId, projectId, policyId],
    );
    const head = heads.rows[0];
    if (head?.status === 'disabled') throw new OperatorDisabled();
    if (head === undefined) {
      await this.insertPolicyVersion(tx, tenantId, projectId, plan, kind, 1, 'draft');
      await tx.query(
        `INSERT INTO saas_${table}_metering_policy_heads
           (tenant_id,project_id,policy_id,current_version,status,changed_by_user_id,created_at,updated_at)
         VALUES($1,$2,$3,1,'draft',NULL,clock_timestamp(),clock_timestamp())`,
        [tenantId, projectId, policyId],
      );
      await this.audit(
        tx,
        tenantId,
        projectId,
        `commercial_metering.${kind}_policy_created`,
        'saas_commercial_metering_authority',
        policyId,
        `${kind}-created`,
      );
    } else {
      await this.requirePolicyVersion(
        tx,
        tenantId,
        projectId,
        plan,
        kind,
        positiveDecimal(head.current_version, 'policy version'),
        head.status,
      );
      if (String(head.current_version) === '2' && head.status === 'active') return;
      if (String(head.current_version) !== '1' || head.status !== 'draft') {
        fail('PROVISIONING_CONFLICT', `Existing registration ${kind} policy cannot be resumed safely.`);
      }
    }
    await this.insertPolicyVersion(tx, tenantId, projectId, plan, kind, 2, 'active');
    const updated = await tx.query<{ policy_id: string }>(
      `UPDATE saas_${table}_metering_policy_heads SET current_version=2,status='active',changed_by_user_id=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$3 AND current_version=1 AND status='draft' RETURNING policy_id`,
      [tenantId, projectId, policyId],
    );
    if (updated.rows.length !== 1)
      fail('PROVISIONING_CONFLICT', `Registration ${kind} policy publication lost its version fence.`);
    await this.audit(
      tx,
      tenantId,
      projectId,
      `commercial_metering.${kind}_policy_published`,
      'saas_commercial_metering_authority',
      policyId,
      `${kind}-published`,
    );
  }

  private async requirePolicyVersion(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    plan: Plan,
    kind: 'customer' | 'provider',
    version: string,
    status: string,
  ): Promise<void> {
    const table = kind === 'customer' ? 'customer' : 'provider';
    const policyId = kind === 'customer' ? plan.customerPolicyId : plan.providerPolicyId;
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT * FROM saas_${table}_metering_policy_versions
        WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$3 AND version=$4 LIMIT 1`,
      [tenantId, projectId, policyId, version],
    );
    const row = rows.rows[0];
    if (
      row === undefined ||
      row.status !== status ||
      !policyDefinitionMatches(row, plan.providerDefinition, plan.customerPriceVersion, kind)
    ) {
      fail('PROVISIONING_CONFLICT', `Existing registration ${kind} policy does not exactly match configuration.`);
    }
  }

  private async insertPolicyVersion(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    plan: Plan,
    kind: 'customer' | 'provider',
    version: number,
    status: 'draft' | 'active',
  ): Promise<void> {
    const definition = plan.providerDefinition;
    const common: unknown[] = [
      tenantId,
      projectId,
      kind === 'customer' ? plan.customerPolicyId : plan.providerPolicyId,
      version,
      status,
      definition.publicModelId,
      definition.publicModelVersion,
      definition.protocol,
      definition.endpoint,
    ];
    if (kind === 'customer') {
      await tx.query(
        `INSERT INTO saas_customer_metering_policy_versions
           (tenant_id,project_id,policy_id,version,status,public_model_id,public_model_version,
            protocol,endpoint,supply_mode,target_mode,customer_price_version,usage_dimensions,
            token_source,rounding_version,rounding_mode,rounding_boundary,commercial_policy_version,
            changed_by_user_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'platform','platform_pool',$10,$11,$12,$13,$14,'total',$15,NULL,clock_timestamp())`,
        [
          ...common,
          plan.customerPriceVersion,
          definition.usageDimensions,
          definition.tokenSource,
          definition.roundingVersion,
          definition.roundingMode,
          definition.commercialPolicyVersion,
        ],
      );
      return;
    }
    await tx.query(
      `INSERT INTO saas_provider_metering_policy_versions
         (tenant_id,project_id,policy_id,version,status,public_model_id,public_model_version,
          provider_id,product_id,resolved_model,protocol,endpoint,supply_mode,target_mode,
          supplier_cost_version,usage_dimensions,token_source,rounding_version,rounding_mode,
          rounding_boundary,commercial_policy_version,changed_by_user_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'platform','platform_pool',$13,$14,$15,$16,$17,'total',$18,NULL,clock_timestamp())`,
      [
        tenantId,
        projectId,
        plan.providerPolicyId,
        version,
        status,
        definition.publicModelId,
        definition.publicModelVersion,
        definition.providerId,
        definition.productId,
        definition.resolvedModel,
        definition.protocol,
        definition.endpoint,
        definition.supplierCostVersion,
        definition.usageDimensions,
        definition.tokenSource,
        definition.roundingVersion,
        definition.roundingMode,
        definition.commercialPolicyVersion,
      ],
    );
  }

  private async ensureAttestation(tx: SqlExecutor, tenantId: string, projectId: string, plan: Plan): Promise<void> {
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT provider_policy_id,provider_policy_version,public_model_id,public_model_version,
              protocol,endpoint,supply_mode,target_mode,contract_digest,suite_version,test_vector_digest,
              verifier_key_id,signature_base64,verification_result,verified_at
         FROM saas_contract_test_attestations
        WHERE tenant_id=$1 AND project_id=$2 AND id=$3 LIMIT 1`,
      [tenantId, projectId, plan.attestationId],
    );
    let evidence: RegistrationContractTestEvidence;
    const existing = rows.rows[0];
    if (existing !== undefined) {
      evidence = {
        contractDigest: String(existing.contract_digest ?? ''),
        suiteVersion: String(existing.suite_version ?? ''),
        testVectorDigest: String(existing.test_vector_digest ?? ''),
        verifierKeyId: String(existing.verifier_key_id ?? ''),
        signatureBase64: String(existing.signature_base64 ?? ''),
      };
      if (
        existing.provider_policy_id !== plan.providerPolicyId ||
        String(existing.provider_policy_version) !== '2' ||
        existing.public_model_id !== plan.providerDefinition.publicModelId ||
        String(existing.public_model_version) !== plan.providerDefinition.publicModelVersion ||
        existing.protocol !== plan.providerDefinition.protocol ||
        existing.endpoint !== plan.providerDefinition.endpoint ||
        existing.supply_mode !== 'platform' ||
        existing.target_mode !== 'platform_pool' ||
        existing.verification_result !== 'verified' ||
        existing.verified_at === null
      ) {
        fail('ATTESTATION_INVALID', 'Existing registration attestation identity or result is invalid.');
      }
    } else {
      if (this.options.contractTests === undefined) {
        fail(
          'ATTESTATION_REQUIRED',
          'No genuine registration contract-test execution port is configured; no attestation was written.',
        );
      }
      evidence = await this.options.contractTests.execute({
        tenantId,
        projectId,
        routeId: plan.routeId,
        routeVersion: '2',
        providerPolicyId: plan.providerPolicyId,
        providerPolicyVersion: '2',
        definition: plan.providerDefinition,
      });
    }
    this.verifyAttestation(evidence, plan);
    if (existing === undefined) {
      await tx.query(
        `INSERT INTO saas_contract_test_attestations
           (tenant_id,project_id,id,provider_policy_id,provider_policy_version,public_model_id,
            public_model_version,protocol,endpoint,supply_mode,target_mode,contract_digest,suite_version,
            test_vector_digest,verifier_key_id,signature_base64,verification_result,verified_at,created_at)
         VALUES($1,$2,$3,$4,2,$5,$6,$7,$8,'platform','platform_pool',$9,$10,$11,$12,$13,'verified',clock_timestamp(),clock_timestamp())`,
        [
          tenantId,
          projectId,
          plan.attestationId,
          plan.providerPolicyId,
          plan.providerDefinition.publicModelId,
          plan.providerDefinition.publicModelVersion,
          plan.providerDefinition.protocol,
          plan.providerDefinition.endpoint,
          evidence.contractDigest,
          evidence.suiteVersion,
          evidence.testVectorDigest,
          evidence.verifierKeyId,
          evidence.signatureBase64,
        ],
      );
      await this.audit(
        tx,
        tenantId,
        projectId,
        'commercial_metering.attestation_verified',
        'saas_commercial_metering_authority',
        plan.attestationId,
        'attestation',
      );
    }
  }

  private verifyAttestation(evidence: RegistrationContractTestEvidence, plan: Plan): void {
    if (
      !evidence ||
      !DIGEST_PATTERN.test(evidence.contractDigest) ||
      !DIGEST_PATTERN.test(evidence.testVectorDigest) ||
      typeof evidence.suiteVersion !== 'string' ||
      evidence.suiteVersion.length < 1 ||
      evidence.suiteVersion.length > 128 ||
      typeof evidence.verifierKeyId !== 'string' ||
      evidence.verifierKeyId.length < 1 ||
      evidence.verifierKeyId.length > 255 ||
      typeof evidence.signatureBase64 !== 'string' ||
      evidence.signatureBase64.length < 1 ||
      evidence.signatureBase64.length > 8192
    ) {
      fail('ATTESTATION_INVALID', 'Contract-test evidence has an invalid shape.');
    }
    if (trustValue(this.options.trustedTestVectorDigests, evidence.suiteVersion) !== evidence.testVectorDigest) {
      fail('ATTESTATION_INVALID', 'Contract-test vector is not trusted for its suite version.');
    }
    const trusted = trustValue(this.options.trustedVerifierPublicKeys, evidence.verifierKeyId);
    if (trusted === undefined) fail('ATTESTATION_INVALID', 'Contract-test verifier key is not trusted.');
    let publicKey: KeyObject;
    try {
      publicKey =
        typeof trusted === 'object' && trusted !== null && 'type' in trusted
          ? (trusted as KeyObject)
          : createPublicKey(trusted);
    } catch (error) {
      fail('ATTESTATION_INVALID', 'Trusted contract-test verifier key is invalid.', error);
    }
    const definition = plan.providerDefinition;
    const payload = canonicalContractAttestationPayload({
      contractDigest: evidence.contractDigest,
      suiteVersion: evidence.suiteVersion,
      testVectorDigest: evidence.testVectorDigest,
      providerPolicyId: plan.providerPolicyId,
      providerPolicyVersion: '2',
      publicModelId: definition.publicModelId,
      publicModelVersion: String(definition.publicModelVersion),
      protocol: definition.protocol,
      endpoint: definition.endpoint,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      usageDimensions: definition.usageDimensions,
      tokenSource: definition.tokenSource,
      roundingVersion: definition.roundingVersion,
      roundingMode: definition.roundingMode,
      roundingBoundary: 'total',
    });
    let valid = false;
    try {
      valid = verifySignature(
        null,
        Buffer.from(payload, 'utf8'),
        publicKey,
        Buffer.from(evidence.signatureBase64, 'base64'),
      );
    } catch (error) {
      fail('ATTESTATION_INVALID', 'Contract-test signature could not be verified.', error);
    }
    if (!valid) fail('ATTESTATION_INVALID', 'Contract-test signature is invalid.');
  }

  private async completeCapacity(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    initialProject: ProjectCapacityRow,
    config: RegistrationDispatchCompletionConfig,
  ): Promise<void> {
    const tenantLimits = {
      requestsPerMinute: initialProject.tenant_rpm,
      tokensPerMinute: initialProject.tenant_tpm,
      maxConcurrentRequests: initialProject.tenant_concurrency,
    };
    if (!this.sameLimits(tenantLimits, config.tenant)) {
      if (!this.nullLimits(tenantLimits))
        fail('PROVISIONING_CONFLICT', 'Tenant capacity was already configured differently.');
      const before = positiveDecimal(initialProject.capacity_policy_revision, 'tenant capacity revision');
      const after = (BigInt(before) + 1n).toString();
      const updated = await tx.query<{ id: string }>(
        `UPDATE saas_tenants SET requests_per_minute=$2,tokens_per_minute=$3,max_concurrent_requests=$4,
                capacity_policy_revision=capacity_policy_revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND capacity_policy_revision=$5 AND requests_per_minute IS NULL
            AND tokens_per_minute IS NULL AND max_concurrent_requests IS NULL RETURNING id`,
        [
          tenantId,
          config.tenant.requestsPerMinute,
          config.tenant.tokensPerMinute,
          config.tenant.maxConcurrentRequests,
          before,
        ],
      );
      if (updated.rows.length !== 1)
        fail('PROVISIONING_CONFLICT', 'Tenant capacity initialization lost its revision fence.');
      await this.capacityAudit(tx, tenantId, projectId, 'tenant', null, before, after, null, config.tenant);
    }

    let version = positiveDecimal(initialProject.inference_policy_version, 'project policy version');
    const status = initialProject.inference_policy_status;
    const current = await this.projectPolicy(tx, tenantId, projectId, version);
    if (current.status !== status) fail('STORAGE_ERROR', 'Project policy head and version statuses disagree.');
    const currentLimits = {
      requestsPerMinute: current.requests_per_minute,
      tokensPerMinute: current.tokens_per_minute,
      maxConcurrentRequests: current.max_concurrent_requests,
    };
    if (!this.sameLimits(currentLimits, config.project)) {
      if (!this.nullLimits(currentLimits))
        fail('PROVISIONING_CONFLICT', 'Project capacity was already configured differently.');
      const next = (BigInt(version) + 1n).toString();
      await this.insertProjectPolicy(tx, tenantId, projectId, next, status, config.project);
      const updated = await tx.query<{ id: string }>(
        `UPDATE saas_projects SET inference_policy_version=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4 AND inference_policy_status=$5 RETURNING id`,
        [tenantId, projectId, next, version, status],
      );
      if (updated.rows.length !== 1)
        fail('PROVISIONING_CONFLICT', 'Project capacity initialization lost its version fence.');
      await this.capacityAudit(tx, tenantId, projectId, 'project', projectId, version, next, null, config.project);
      version = next;
    }
    if (status === 'disabled') throw new OperatorDisabled();
    if (status === 'suspended') {
      const next = (BigInt(version) + 1n).toString();
      await this.insertProjectPolicy(tx, tenantId, projectId, next, 'active', config.project);
      const updated = await tx.query<{ id: string }>(
        `UPDATE saas_projects SET inference_policy_version=$3,inference_policy_status='active',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4 AND inference_policy_status='suspended' RETURNING id`,
        [tenantId, projectId, next, version],
      );
      if (updated.rows.length !== 1) fail('PROVISIONING_CONFLICT', 'Project activation lost its version fence.');
      await this.audit(
        tx,
        tenantId,
        projectId,
        'project_inference_policy.activated',
        'saas_project_inference_policy',
        projectId,
        `activation-${next}`,
      );
    } else if (status !== 'active') {
      fail('PROVISIONING_CONFLICT', 'Project inference policy status cannot be resumed safely.');
    }
  }

  private nullLimits(value: {
    readonly requestsPerMinute: unknown;
    readonly tokensPerMinute: unknown;
    readonly maxConcurrentRequests: unknown;
  }): boolean {
    return value.requestsPerMinute === null && value.tokensPerMinute === null && value.maxConcurrentRequests === null;
  }

  private sameLimits(
    value: {
      readonly requestsPerMinute: unknown;
      readonly tokensPerMinute: unknown;
      readonly maxConcurrentRequests: unknown;
    },
    expected: RegistrationDispatchCapacityLimits,
  ): boolean {
    return (
      String(value.requestsPerMinute ?? '') === String(expected.requestsPerMinute) &&
      String(value.tokensPerMinute ?? '') === String(expected.tokensPerMinute) &&
      String(value.maxConcurrentRequests ?? '') === String(expected.maxConcurrentRequests)
    );
  }

  private async projectPolicy(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    version: string,
  ): Promise<{
    readonly status: string;
    readonly requests_per_minute: number | string | null;
    readonly tokens_per_minute: number | string | null;
    readonly max_concurrent_requests: number | string | null;
  }> {
    const rows = await tx.query<{
      readonly status: string;
      readonly requests_per_minute: number | string | null;
      readonly tokens_per_minute: number | string | null;
      readonly max_concurrent_requests: number | string | null;
    }>(
      `SELECT status,requests_per_minute,tokens_per_minute,max_concurrent_requests
         FROM saas_project_inference_policy_versions
        WHERE tenant_id=$1 AND project_id=$2 AND version=$3 LIMIT 1`,
      [tenantId, projectId, version],
    );
    const row = rows.rows[0];
    if (row === undefined) fail('STORAGE_ERROR', 'Current project inference policy version is missing.');
    return row;
  }

  private async insertProjectPolicy(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    version: string,
    status: string,
    limits: RegistrationDispatchCapacityLimits,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO saas_project_inference_policy_versions
         (tenant_id,project_id,version,status,changed_by_user_id,requests_per_minute,tokens_per_minute,max_concurrent_requests)
       VALUES($1,$2,$3,$4,NULL,$5,$6,$7)`,
      [
        tenantId,
        projectId,
        version,
        status,
        limits.requestsPerMinute,
        limits.tokensPerMinute,
        limits.maxConcurrentRequests,
      ],
    );
  }

  private async capacityAudit(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    scope: 'tenant' | 'project',
    targetProjectId: string | null,
    beforeRevision: string,
    afterRevision: string,
    before: RegistrationDispatchCapacityLimits | null,
    after: RegistrationDispatchCapacityLimits,
  ): Promise<void> {
    const auditId = stableUuid(
      `${REGISTRATION_DISPATCH_COMPLETION_SOURCE}:${tenantId}:${projectId}:${scope}:capacity:${afterRevision}`,
    );
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO saas_audit_events
         (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
       VALUES($1,$2,NULL,'capacity_policy.updated',$3,$4,clock_timestamp(),'registration_dispatch_completion',$5) RETURNING id`,
      [
        auditId,
        tenantId,
        `${scope}_capacity_policy`,
        scope === 'tenant' ? tenantId : targetProjectId,
        stableUuid(`${REGISTRATION_DISPATCH_COMPLETION_SOURCE}:${tenantId}:${projectId}`),
      ],
    );
    if (inserted.rows[0]?.id !== auditId) fail('STORAGE_ERROR', 'Registration capacity audit event was not persisted.');
    await tx.query(
      `INSERT INTO saas_capacity_policy_audit_details
         (audit_event_id,scope,tenant_id,project_id,api_key_id,reason,revision_kind,before_revision,after_revision,
          before_requests_per_minute,before_tokens_per_minute,before_max_concurrent_requests,
          after_requests_per_minute,after_tokens_per_minute,after_max_concurrent_requests)
       VALUES($1,$2,$3,$4,NULL,'initial_provisioning',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        auditId,
        scope,
        tenantId,
        targetProjectId,
        scope === 'tenant' ? 'tenant_capacity_policy' : 'project_inference_policy',
        beforeRevision,
        afterRevision,
        before?.requestsPerMinute ?? null,
        before?.tokensPerMinute ?? null,
        before?.maxConcurrentRequests ?? null,
        after.requestsPerMinute,
        after.tokensPerMinute,
        after.maxConcurrentRequests,
      ],
    );
  }

  private async audit(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    action: string,
    targetType: string,
    targetId: string,
    discriminator: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO saas_audit_events
         (id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,entry_point,request_id)
       VALUES($1,$2,NULL,$3,$4,$5,clock_timestamp(),'registration_dispatch_completion',$6)`,
      [
        stableUuid(
          `${REGISTRATION_DISPATCH_COMPLETION_SOURCE}:${tenantId}:${projectId}:${discriminator}:${action}:${targetId}`,
        ),
        tenantId,
        action,
        targetType,
        `${projectId}:${targetId}`,
        stableUuid(`${REGISTRATION_DISPATCH_COMPLETION_SOURCE}:${tenantId}:${projectId}`),
      ],
    );
  }
}
