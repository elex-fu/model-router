import type { SaasCatalogService } from '../catalog/service.js';
import type { ProviderEligibilityRequest } from '../catalog/types.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type { ByokPlanEntitlementResolver, EffectiveByokEntitlement } from '../plans/types.js';
import {
  type RouteCommercialAuthorityRecord,
  SaasCommercialMeteringPolicyError,
  type SaasCommercialMeteringPolicyService,
} from './commercial-metering-policy-service.js';
import type { ModelMappingSource, ModelResolutionProvenance } from './contracts.js';
import {
  blockRequestPreparation,
  type RequestPreparationAuthority,
  type RequestPreparationAuthorityPort,
  type RequestPreparationCaller,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  rejectRequestPreparation,
} from './request-preparation-service.js';
import { type RouteConfigRecord, SaasRouteConfigError, type SaasRouteConfigService } from './route-config-service.js';

type Database = Pick<SaasDatabase, 'transaction'>;
type RouteReader = Pick<SaasRouteConfigService, 'resolve'>;
type CommercialReader = Pick<SaasCommercialMeteringPolicyService, 'resolveDispatchableRoute'>;
type CatalogReader = Pick<SaasCatalogService, 'evaluateProviderEligibility'>;
type PlanEntitlementReader = Pick<ByokPlanEntitlementResolver, 'resolveBoundForRequest'>;
type Row = Record<string, unknown>;

export interface PostgresRequestPreparationAuthorityAdapterDependencies {
  readonly database: Database;
  readonly routes: RouteReader;
  readonly commercial: CommercialReader;
  readonly catalog: CatalogReader;
  /** Required for BYOK; platform resolution does not consult this reader. */
  readonly byokEntitlements?: PlanEntitlementReader;
}

type SafeFailureStage = 'route' | 'account' | 'capability';

class SafeAuthorityFailure extends Error {
  constructor(readonly stage: SafeFailureStage) {
    super(stage);
  }
}

const SAFE_MESSAGES = {
  route: 'A current route and commercial authority could not be established.',
  account: 'A unique active upstream authority could not be established.',
  capability: 'The upstream capability authority is unavailable.',
  storage: 'Request authority could not be resolved.',
} as const;

function fail(stage: SafeFailureStage): never {
  throw new SafeAuthorityFailure(stage);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) fail('account');
  return value;
}

function version(value: unknown): string {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^[0-9]+$/.test(value)) parsed = BigInt(value);
    else fail('account');
  } catch (error) {
    if (error instanceof SafeAuthorityFailure) throw error;
    return fail('account');
  }
  if (parsed < 1n) fail('account');
  return parsed.toString(10);
}

function sameVersion(actual: unknown, expected: unknown): boolean {
  try {
    return version(actual) === version(expected);
  } catch {
    return false;
  }
}

function validProviderScope(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (providerId) => typeof providerId === 'string' && providerId.trim() !== '' && providerId === providerId.trim(),
    )
  );
}

function sameProviderScope(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((providerId, index) => providerId === right[index]);
}

function versionNumber(value: unknown): number {
  const normalized = version(value);
  const parsed = BigInt(normalized);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('account');
  return Number(parsed);
}

function mappingText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) fail('route');
  return value;
}

function catalogModelResolution(requestedModel: string, resolvedModel: string, alias: Row): ModelResolutionProvenance {
  const configuredSource = alias.mapping_source;
  const mappingSource: ModelMappingSource =
    configuredSource === undefined
      ? requestedModel === resolvedModel
        ? 'none'
        : 'alias'
      : configuredSource === 'none' || configuredSource === 'alias' || configuredSource === 'wildcard'
        ? configuredSource
        : fail('route');
  if (mappingSource === 'wildcard') fail('route');
  const configuredMappedModel = alias.mapped_model;
  const mappedModel =
    configuredMappedModel === undefined
      ? mappingSource === 'none'
        ? requestedModel
        : resolvedModel
      : mappingText(configuredMappedModel);
  if (mappingSource === 'none') {
    if (mappedModel !== requestedModel || (alias.mapping_version !== undefined && alias.mapping_version !== null)) {
      fail('route');
    }
  } else {
    if (mappedModel !== resolvedModel) fail('route');
  }
  let mappingVersion: number | null = null;
  if (mappingSource !== 'none') {
    try {
      const rawVersion = Object.hasOwn(alias, 'mapping_version') ? alias.mapping_version : alias.version;
      if (rawVersion === null || rawVersion === undefined) fail('route');
      mappingVersion = versionNumber(rawVersion);
    } catch {
      fail('route');
    }
  } else if (alias.mapping_version !== undefined && alias.mapping_version !== null) {
    fail('route');
  }
  return {
    requestedModel,
    mappedModel,
    resolvedModel,
    mappingSource,
    mappingVersion,
  };
}

function operationForProtocol(protocol: RequestPreparationAuthority['route']['protocol']): string {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'openai':
      return 'chat.completions';
    case 'gemini':
      return 'generateContent';
    case 'responses':
      return 'responses';
  }
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) fail('account');
  return value;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) fail('account');
  return parsed;
}

function isCurrentWindow(row: Row, effectiveKey: string, expiryKey: string, now: Date): boolean {
  const effectiveAt = date(row[effectiveKey]);
  const expiresAt = date(row[expiryKey]);
  return (!effectiveAt || effectiveAt <= now) && (!expiresAt || expiresAt > now);
}

function isNotExpired(row: Row, expiryKey: string, now: Date): boolean {
  const expiresAt = date(row[expiryKey]);
  return !expiresAt || expiresAt > now;
}

function exactOne<T>(rows: readonly T[]): T {
  if (rows.length !== 1) fail('account');
  const row = rows[0];
  if (!row) fail('account');
  return row;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(
  left: RequestPreparationAuthority['candidate'],
  right: RequestPreparationAuthority['candidate'],
): number {
  const leftPoolId = left.supplyMode === 'platform' ? left.poolId : '';
  const rightPoolId = right.supplyMode === 'platform' ? right.poolId : '';
  for (const [leftValue, rightValue] of [
    [left.accountId, right.accountId],
    [left.credentialId, right.credentialId],
    [leftPoolId, rightPoolId],
    [left.providerId, right.providerId],
    [left.productId, right.productId],
  ] as const) {
    const comparison = compareText(leftValue, rightValue);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

async function queryRows(executor: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
  const result = await executor.query<Row>(sql, values);
  if (!result || !Array.isArray(result.rows)) throw new Error('invalid SQL result');
  return result.rows;
}

function matchesInput(caller: RequestPreparationCaller, entitlement: RequestPreparationEntitlement): boolean {
  return (
    caller.tenantId === entitlement.tenantId &&
    caller.projectId === entitlement.projectId &&
    caller.proxyKeyId === entitlement.proxyKeyId &&
    caller.entitlementId === entitlement.entitlementId &&
    caller.entitlementVersion === entitlement.entitlementVersion &&
    caller.supplyProfileId === entitlement.supplyProfileId &&
    caller.supplyProfileVersion === entitlement.supplyProfileVersion &&
    caller.supplyMode === entitlement.supplyMode &&
    caller.modelScopeVersion === entitlement.modelScopeVersion
  );
}

function assertProfile(
  row: Row,
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  publicModel: string,
): number {
  if (
    row.status !== 'active' ||
    row.supply_mode !== entitlement.supplyMode ||
    !sameVersion(row.authz_version, caller.supplyProfileVersion) ||
    !sameVersion(row.authz_version, entitlement.supplyProfileVersion)
  ) {
    fail('account');
  }
  const scopes = row.model_scopes;
  if (!Array.isArray(scopes) || !scopes.includes(publicModel)) fail('account');
  return versionNumber(row.authz_version);
}

function assertRelationEvidence(row: Row, referenceKey: string, digestKey: string): void {
  const reference = nullableText(row[referenceKey]);
  const digest = nullableText(row[digestKey]);
  if (!reference || !digest || !/^[0-9a-f]{64}$/.test(digest)) fail('account');
}

function assertCredential(row: Row, mode: 'byok' | 'platform', now: Date): void {
  const owner = mode === 'byok' ? 'tenant' : 'platform';
  if (
    row.account_status !== 'active' ||
    row.account_validation_state !== 'verified' ||
    row.account_owner_kind !== owner ||
    row.account_supply_mode !== mode ||
    row.credential_status !== 'active' ||
    row.credential_validation_state !== 'verified' ||
    row.credential_owner_kind !== owner ||
    row.credential_supply_mode !== mode ||
    row.version_owner_kind !== owner ||
    row.version_supply_mode !== mode ||
    row.version_status !== 'active' ||
    !sameVersion(row.credential_current_version, row.credential_version) ||
    !sameVersion(row.account_authz_version, row.mapping_account_authz_version ?? row.member_account_authz_version) ||
    !sameVersion(row.credential_version, row.credential_current_version) ||
    row.credential_id !== row.version_credential_id ||
    row.account_id !== row.credential_account_id ||
    !isNotExpired(row, 'credential_expires_at', now) ||
    !isNotExpired(row, 'version_expires_at', now)
  ) {
    fail('account');
  }
  version(row.account_authz_version);
  version(row.credential_authz_version);
  version(row.credential_version);
}

function assertAccountIdentity(row: Row, providerId: string, productId: string): void {
  if (
    text(row, 'account_provider_id') !== providerId ||
    text(row, 'account_product_id') !== productId ||
    text(row, 'credential_provider_id') !== providerId ||
    text(row, 'credential_product_id') !== productId ||
    row.credential_account_id !== row.account_id
  ) {
    fail('account');
  }
}

function validateRightsRow(
  row: Row,
  expected: {
    readonly providerId: string;
    readonly productId: string;
    readonly credentialType: string;
    readonly region: string;
    readonly purpose: string;
    readonly model: string;
    readonly endpoint: string;
  },
  now: Date,
): void {
  const modelScope = row.model_scope;
  const endpointScope = row.endpoint_scope;
  if (
    row.status !== 'active' ||
    row.provider_id !== expected.providerId ||
    row.product_id !== expected.productId ||
    row.credential_type !== expected.credentialType ||
    row.supply_mode !== 'platform' ||
    row.region !== expected.region ||
    row.purpose !== expected.purpose ||
    !Array.isArray(modelScope) ||
    !modelScope.includes(expected.model) ||
    !Array.isArray(endpointScope) ||
    !endpointScope.includes(expected.endpoint) ||
    !nullableText(row.approval_ref) ||
    !nullableText(row.evidence_ref) ||
    !/^[0-9a-f]{64}$/.test(text(row, 'evidence_sha256')) ||
    !isCurrentWindow(row, 'effective_at', 'expires_at', now)
  ) {
    fail('account');
  }
}

/**
 * Resolves database-backed route candidates. It reads identifiers, epochs and
 * lifecycle facts only; credential envelopes and plaintext never enter this
 * adapter.
 */
export class PostgresRequestPreparationAuthorityAdapter implements RequestPreparationAuthorityPort {
  constructor(private readonly dependencies: PostgresRequestPreparationAuthorityAdapterDependencies) {}

  private async resolveByokEntitlement(
    executor: SqlExecutor,
    caller: RequestPreparationCaller,
    entitlement: RequestPreparationEntitlement,
    now: Date,
    publicModel: string,
  ): Promise<EffectiveByokEntitlement> {
    const resolver = this.dependencies.byokEntitlements;
    if (!resolver || typeof resolver.resolveBoundForRequest !== 'function') fail('account');

    const resolved = await resolver.resolveBoundForRequest(
      { tenantId: caller.tenantId, projectId: caller.projectId },
      caller.entitlementId,
      { executor, now },
    );
    if (
      !resolved ||
      resolved.tenantId !== caller.tenantId ||
      resolved.projectId !== caller.projectId ||
      resolved.entitlementId !== caller.entitlementId ||
      resolved.snapshot.tenantId !== caller.tenantId ||
      resolved.snapshot.supplyMode !== 'byok' ||
      resolved.snapshot.supplyProfileId !== caller.supplyProfileId ||
      resolved.entitlementAuthzVersion !== caller.entitlementVersion ||
      resolved.supplyProfileAuthzVersion !== caller.supplyProfileVersion ||
      resolved.modelScopeVersion !== caller.modelScopeVersion ||
      !resolved.modelScopes.includes(publicModel) ||
      !resolved.snapshot.allowedModels.includes(publicModel) ||
      !validProviderScope(resolved.allowedProviderIds) ||
      !sameProviderScope(resolved.allowedProviderIds, resolved.snapshot.allowedProviderIds) ||
      !validProviderScope(entitlement.allowedProviderIds) ||
      !sameProviderScope(entitlement.allowedProviderIds, resolved.allowedProviderIds)
    ) {
      fail('account');
    }
    return resolved;
  }

  async resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly publicModel: string;
    readonly protocol: RequestPreparationAuthority['route']['protocol'];
  }): Promise<RequestPreparationDecision<RequestPreparationAuthority>> {
    if (
      !matchesInput(input.caller, input.entitlement) ||
      !input.publicModel ||
      !input.entitlement.allowedModels.includes(input.publicModel) ||
      !input.caller.modelScopes.includes(input.publicModel)
    ) {
      return rejectRequestPreparation('account_denied', SAFE_MESSAGES.account);
    }

    try {
      const authority = await this.dependencies.database.transaction(async (executor) => {
        await queryRows(executor, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const clockRows = await queryRows(executor, 'SELECT clock_timestamp() AS authority_now');
        const clockRow = exactOne(clockRows);
        const authorityAt = date(clockRow.authority_now);
        if (!authorityAt) throw new Error('database clock unavailable');

        let route: RouteConfigRecord;
        try {
          route = await this.dependencies.routes.resolve({
            tenantId: input.caller.tenantId,
            projectId: input.caller.projectId,
            publicModel: input.publicModel,
            protocol: input.protocol,
            supplyMode: input.entitlement.supplyMode,
            executor,
          });
        } catch (error) {
          if (error instanceof SaasRouteConfigError && error.code === 'STORAGE_ERROR') throw error;
          fail('route');
        }

        const aliasRows = await queryRows(
          executor,
          `SELECT v.public_model_id, v.version, m.alias, m.status AS model_status,
                  v.provider_id, v.product_id, v.model, v.endpoint_scope, v.status AS version_status
           FROM saas_public_model_versions v
           JOIN saas_public_models m ON m.id = v.public_model_id
           WHERE v.public_model_id = $1 AND v.version = $2
           LIMIT 2`,
          [route.publicModelId, route.publicModelVersion],
        );
        const alias = exactOne(aliasRows);
        const resolvedModel = text(alias, 'model');
        const providerId = text(alias, 'provider_id');
        const productId = text(alias, 'product_id');
        if (
          alias.model_status !== 'active' ||
          alias.version_status !== 'active' ||
          alias.alias !== input.publicModel ||
          !Array.isArray(alias.endpoint_scope) ||
          !alias.endpoint_scope.includes(route.endpoint) ||
          !sameVersion(alias.version, route.publicModelVersion) ||
          route.tenantId !== input.caller.tenantId ||
          route.projectId !== input.caller.projectId ||
          route.protocol !== input.protocol ||
          route.supplyMode !== input.entitlement.supplyMode ||
          route.targetMode !== (route.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool')
        ) {
          fail('route');
        }

        if (input.entitlement.supplyMode === 'byok') {
          const planEntitlement = await this.resolveByokEntitlement(
            executor,
            input.caller,
            input.entitlement,
            authorityAt,
            input.publicModel,
          );
          if (!planEntitlement.allowedProviderIds.includes(providerId)) fail('account');
        }

        let commercial: RouteCommercialAuthorityRecord | null;
        try {
          commercial = await this.dependencies.commercial.resolveDispatchableRoute(
            input.caller.tenantId,
            input.caller.projectId,
            route.routeId,
            route.version,
            executor,
          );
        } catch (error) {
          if (error instanceof SaasCommercialMeteringPolicyError && error.code !== 'STORAGE_ERROR') fail('route');
          throw error;
        }
        if (
          !commercial ||
          commercial.tenantId !== route.tenantId ||
          commercial.projectId !== route.projectId ||
          commercial.routeId !== route.routeId ||
          !sameVersion(commercial.routeVersion, route.version)
        ) {
          fail('route');
        }

        const profileRows = await queryRows(
          executor,
          `SELECT tenant_id, id, supply_mode, status, authz_version, model_scopes
           FROM saas_supply_profiles
           WHERE tenant_id = $1 AND id = $2
           LIMIT 2`,
          [input.caller.tenantId, input.entitlement.supplyProfileId],
        );
        const profile = exactOne(profileRows);
        const profileVersion = assertProfile(profile, input.caller, input.entitlement, input.publicModel);

        const supplies =
          input.entitlement.supplyMode === 'byok'
            ? await this.resolveByok(executor, input.caller, input.entitlement, authorityAt, providerId, productId)
            : await this.resolvePlatform(executor, input.caller, input.entitlement, authorityAt, providerId, productId);

        const customerPriceVersion = nullableText(commercial.customerPriceVersion);
        const supplierCostVersion = nullableText(commercial.supplierCostVersion);
        if (
          (input.entitlement.supplyMode === 'byok' &&
            (customerPriceVersion !== null || supplierCostVersion !== null)) ||
          (input.entitlement.supplyMode === 'platform' && (!customerPriceVersion || !supplierCostVersion))
        ) {
          fail('route');
        }

        const verified = [] as Array<{
          readonly candidate: RequestPreparationAuthority['candidate'];
          readonly poolMemberAuthzVersion: number | null;
        }>;
        for (const supply of supplies) {
          try {
            const eligibilityInput: ProviderEligibilityRequest = {
              providerId,
              productId,
              model: resolvedModel,
              endpoint: route.endpoint,
              credentialType: supply.credentialType,
              supplyMode: input.entitlement.supplyMode,
              region: supply.region,
              purpose: supply.purpose,
            };
            const eligibility = await this.dependencies.catalog.evaluateProviderEligibility(
              eligibilityInput,
              authorityAt,
              executor,
            );
            if (
              eligibility.decision !== 'allow' ||
              eligibility.providerId !== providerId ||
              eligibility.productId !== productId ||
              eligibility.model !== resolvedModel ||
              eligibility.endpoint !== route.endpoint ||
              eligibility.capability.protocol !== input.protocol ||
              String(eligibility.rights.rightsId) !== supply.accountRightsId ||
              !sameVersion(eligibility.rights.version, supply.accountRightsVersion)
            ) {
              continue;
            }
            await this.assertAccountCapability(
              executor,
              supply.accountId,
              input.caller,
              providerId,
              productId,
              resolvedModel,
              route.endpoint,
              eligibility.capability.version,
            );
            if (supply.poolRights) {
              validateRightsRow(
                supply.poolRights,
                {
                  providerId,
                  productId,
                  credentialType: supply.credentialType,
                  region: supply.region,
                  purpose: supply.purpose,
                  model: resolvedModel,
                  endpoint: route.endpoint,
                },
                authorityAt,
              );
            }
            verified.push({
              candidate: supply.candidate(
                input,
                route,
                resolvedModel,
                providerId,
                productId,
                profileVersion,
                supplierCostVersion,
              ),
              poolMemberAuthzVersion: supply.poolMemberAuthzVersion,
            });
          } catch (error) {
            if (error instanceof SafeAuthorityFailure && error.stage === 'account') continue;
            throw error;
          }
        }
        if (verified.length === 0) fail('account');
        verified.sort((left, right) => compareCandidates(left.candidate, right.candidate));
        const accountIds = new Set<string>();
        for (const { candidate: value } of verified) {
          if (accountIds.has(value.accountId)) fail('account');
          accountIds.add(value.accountId);
        }
        const first = verified[0];
        if (!first) fail('account');
        const candidate = first.candidate;
        const candidates = verified.map(({ candidate: value }) => value);
        const modelResolution = catalogModelResolution(input.publicModel, resolvedModel, alias);
        return {
          route: {
            tenantId: route.tenantId,
            projectId: route.projectId,
            publicModel: input.publicModel,
            publicModelId: route.publicModelId,
            publicModelVersion: version(route.publicModelVersion),
            routeConfigId: route.routeId,
            routeConfigVersion: version(route.version),
            protocol: route.protocol,
            providerProtocol: route.protocol,
            clientOperation: operationForProtocol(route.protocol),
            providerOperation: operationForProtocol(route.protocol),
            targetMode: route.targetMode,
            upstreamId: route.upstreamId,
            endpoint: route.endpoint,
          },
          candidate,
          ...(candidates.length > 1 ? { candidates } : {}),
          modelMappingRules:
            modelResolution.mappingSource === 'none'
              ? []
              : [
                  {
                    pattern: input.publicModel,
                    mappedModel: modelResolution.mappedModel,
                    mappingSource: modelResolution.mappingSource,
                    mappingVersion: modelResolution.mappingVersion as number,
                  },
                ],
          modelResolution,
          poolMemberAuthzVersion: first.poolMemberAuthzVersion,
          credentialRef: candidate.credentialId,
          configVersion: version(route.version),
          commercial: {
            customerMeteringPolicyId: commercial.customerPolicyId,
            customerMeteringPolicyVersion: version(commercial.customerPolicyVersion),
            providerMeteringPolicyId: commercial.providerPolicyId,
            providerMeteringPolicyVersion: version(commercial.providerPolicyVersion),
            contractAttestationId: commercial.contractAttestationId,
            customerPriceVersion,
            supplierCostVersion,
          },
        } satisfies RequestPreparationAuthority;
      });
      return { decision: 'allow', value: authority };
    } catch (error) {
      if (error instanceof SafeAuthorityFailure) {
        if (error.stage === 'route') return rejectRequestPreparation('route_denied', SAFE_MESSAGES.route);
        if (error.stage === 'capability')
          return blockRequestPreparation('capability_unavailable', SAFE_MESSAGES.capability);
        return rejectRequestPreparation('account_denied', SAFE_MESSAGES.account);
      }
      return blockRequestPreparation('storage_failure', SAFE_MESSAGES.storage);
    }
  }

  private async resolveByok(
    executor: SqlExecutor,
    caller: RequestPreparationCaller,
    entitlement: RequestPreparationEntitlement,
    now: Date,
    providerId: string,
    productId: string,
  ): Promise<SupplyResolution[]> {
    const rows = await queryRows(
      executor,
      `/* preparation-authority:byok */
       SELECT m.tenant_id AS mapping_tenant_id, m.supply_profile_id AS mapping_profile_id,
              m.supply_mode AS mapping_supply_mode, m.account_id AS account_id,
              m.provider_id AS mapping_provider_id, m.product_id AS mapping_product_id,
              m.account_authz_version AS mapping_account_authz_version,
              m.status AS mapping_status, m.effective_at AS mapping_effective_at,
              m.expires_at AS mapping_expires_at, m.authz_version AS mapping_authz_version,
              m.evidence_ref AS mapping_evidence_ref, m.evidence_sha256 AS mapping_evidence_sha256,
              a.owner_kind AS account_owner_kind, a.supply_mode AS account_supply_mode,
              a.provider_id AS account_provider_id, a.product_id AS account_product_id,
              a.credential_type AS credential_type, a.region AS region, a.purpose AS purpose,
              a.rights_id AS account_rights_id, a.rights_version AS account_rights_version,
              a.status AS account_status, a.validation_state AS account_validation_state,
              a.authz_version AS account_authz_version,
              c.owner_kind AS credential_owner_kind, c.supply_mode AS credential_supply_mode,
              c.id AS credential_id, c.account_id AS credential_account_id,
              c.provider_id AS credential_provider_id, c.product_id AS credential_product_id,
              c.status AS credential_status, c.validation_state AS credential_validation_state,
              c.current_version AS credential_current_version, c.expires_at AS credential_expires_at,
              c.authz_version AS credential_authz_version,
              v.owner_kind AS version_owner_kind, v.supply_mode AS version_supply_mode,
              v.credential_id AS version_credential_id, v.version AS credential_version,
              v.status AS version_status, v.expires_at AS version_expires_at
       FROM saas_tenant_provider_supply_profile_accounts m
       JOIN saas_tenant_provider_accounts a
         ON a.tenant_id = m.tenant_id AND a.id = m.account_id
       JOIN saas_tenant_provider_credentials c
         ON c.tenant_id = a.tenant_id AND c.account_id = a.id
        AND c.provider_id = a.provider_id AND c.product_id = a.product_id
       JOIN saas_tenant_provider_credential_versions v
         ON v.tenant_id = c.tenant_id AND v.account_id = c.account_id
        AND v.credential_id = c.id AND v.version = c.current_version
       WHERE m.tenant_id = $1 AND m.supply_profile_id = $2 AND m.supply_mode = 'byok'
         AND m.status = 'active' AND m.effective_at <= $3::timestamptz
         AND (m.expires_at IS NULL OR m.expires_at > $3::timestamptz)
         AND a.status = 'active' AND a.validation_state = 'verified'
         AND m.account_authz_version = a.authz_version
         AND m.provider_id = a.provider_id AND m.product_id = a.product_id
         AND a.provider_id = $4 AND a.product_id = $5
         AND c.status = 'active' AND c.validation_state = 'verified'
         AND c.current_version IS NOT NULL
         AND (c.expires_at IS NULL OR c.expires_at > $3::timestamptz)
         AND v.owner_kind = 'tenant' AND v.supply_mode = 'byok' AND v.status = 'active'
         AND (v.expires_at IS NULL OR v.expires_at > $3::timestamptz)
       ORDER BY m.account_id ASC, c.id ASC`,
      [caller.tenantId, entitlement.supplyProfileId, now, providerId, productId],
    );
    const resolutions: SupplyResolution[] = [];
    for (const row of rows) {
      try {
        if (
          row.mapping_tenant_id !== caller.tenantId ||
          row.mapping_profile_id !== entitlement.supplyProfileId ||
          row.mapping_supply_mode !== 'byok' ||
          row.mapping_status !== 'active' ||
          row.mapping_provider_id !== providerId ||
          row.mapping_product_id !== productId ||
          !isCurrentWindow(row, 'mapping_effective_at', 'mapping_expires_at', now) ||
          !sameVersion(row.mapping_account_authz_version, row.account_authz_version)
        ) {
          fail('account');
        }
        assertRelationEvidence(row, 'mapping_evidence_ref', 'mapping_evidence_sha256');
        assertCredential(row, 'byok', now);
        assertAccountIdentity(row, providerId, productId);
        const accountId = text(row, 'account_id');
        const credentialId = text(row, 'credential_id');
        const mappingVersion = versionNumber(row.mapping_authz_version);
        const accountAuthzVersion = versionNumber(row.account_authz_version);
        const credentialAuthzVersion = versionNumber(row.credential_authz_version);
        const credentialVersion = versionNumber(row.credential_version);
        const credentialType = text(row, 'credential_type');
        const region = text(row, 'region');
        const purpose = text(row, 'purpose');
        const accountRightsId = text(row, 'account_rights_id');
        const accountRightsVersion = version(row.account_rights_version);
        resolutions.push({
          accountId,
          credentialType,
          region,
          purpose,
          accountRightsId,
          accountRightsVersion,
          poolRights: null,
          poolMemberAuthzVersion: null,
          candidate: (
            input,
            route,
            resolvedModel,
            resolvedProviderId,
            resolvedProductId,
            profileVersion,
            _supplierCostVersion,
          ) => ({
            tenantId: caller.tenantId,
            projectId: caller.projectId,
            proxyKeyId: caller.proxyKeyId,
            supplyProfileId: entitlement.supplyProfileId,
            supplyMode: 'byok',
            accountOwnerKind: 'tenant',
            upstreamId: route.upstreamId,
            accountId,
            credentialId,
            credentialVersion,
            credentialAuthzVersion,
            accountAuthzVersion,
            dispatchProfileId: entitlement.supplyProfileId,
            supplyProfileAuthzVersion: profileVersion,
            resolvedModel,
            protocol: input.protocol,
            endpoint: route.endpoint,
            supplierCostVersion: null,
            profileAccountAuthzVersion: mappingVersion,
            providerId: resolvedProviderId,
            productId: resolvedProductId,
          }),
        });
      } catch (error) {
        if (error instanceof SafeAuthorityFailure && error.stage === 'account') continue;
        throw error;
      }
    }
    return resolutions;
  }

  private async resolvePlatform(
    executor: SqlExecutor,
    caller: RequestPreparationCaller,
    entitlement: RequestPreparationEntitlement,
    now: Date,
    providerId: string,
    productId: string,
  ): Promise<SupplyResolution[]> {
    const rows = await queryRows(
      executor,
      `/* preparation-authority:platform */
       SELECT g.tenant_id AS grant_tenant_id, g.supply_profile_id AS grant_profile_id,
              g.supply_mode AS grant_supply_mode, g.status AS grant_status,
              g.effective_at AS grant_effective_at, g.expires_at AS grant_expires_at,
              g.authz_version AS grant_authz_version,
              g.profile_authz_version AS grant_profile_authz_version,
              g.pool_authz_version AS grant_pool_authz_version,
              g.evidence_ref AS grant_evidence_ref, g.evidence_sha256 AS grant_evidence_sha256,
              p.id AS pool_id, p.provider_id AS pool_provider_id, p.product_id AS pool_product_id,
              p.status AS pool_status, p.validation_state AS pool_validation_state,
              p.authz_version AS pool_authz_version, p.credential_type AS pool_credential_type,
              p.region AS pool_region, p.purpose AS pool_purpose,
              p.rights_id AS pool_rights_id, p.rights_version AS pool_rights_version,
              m.account_id AS account_id, m.provider_id AS member_provider_id,
              m.product_id AS member_product_id, m.status AS member_status,
              m.authz_version AS member_authz_version,
              m.account_authz_version AS member_account_authz_version,
              a.owner_kind AS account_owner_kind, a.supply_mode AS account_supply_mode,
              a.provider_id AS account_provider_id, a.product_id AS account_product_id,
              a.credential_type AS credential_type, a.region AS region, a.purpose AS purpose,
              a.rights_id AS account_rights_id, a.rights_version AS account_rights_version,
              a.status AS account_status, a.validation_state AS account_validation_state,
              a.authz_version AS account_authz_version,
              c.owner_kind AS credential_owner_kind, c.supply_mode AS credential_supply_mode,
              c.id AS credential_id, c.account_id AS credential_account_id,
              c.provider_id AS credential_provider_id, c.product_id AS credential_product_id,
              c.status AS credential_status, c.validation_state AS credential_validation_state,
              c.current_version AS credential_current_version, c.expires_at AS credential_expires_at,
              c.authz_version AS credential_authz_version,
              v.owner_kind AS version_owner_kind, v.supply_mode AS version_supply_mode,
              v.credential_id AS version_credential_id, v.version AS credential_version,
              v.status AS version_status, v.expires_at AS version_expires_at
       FROM saas_platform_provider_pool_grants g
       JOIN saas_platform_provider_pools p ON p.id = g.pool_id
       JOIN saas_platform_provider_pool_members m ON m.pool_id = p.id
       JOIN saas_platform_provider_accounts a ON a.id = m.account_id
       JOIN saas_platform_provider_credentials c
         ON c.account_id = a.id AND c.provider_id = a.provider_id AND c.product_id = a.product_id
       JOIN saas_platform_provider_credential_versions v
         ON v.account_id = c.account_id AND v.credential_id = c.id AND v.version = c.current_version
       WHERE g.tenant_id = $1 AND g.supply_profile_id = $2 AND g.supply_mode = 'platform'
         AND g.status = 'active' AND g.effective_at <= $3::timestamptz
         AND (g.expires_at IS NULL OR g.expires_at > $3::timestamptz)
         AND g.profile_authz_version = $4 AND p.authz_version = g.pool_authz_version
         AND p.provider_id = $5 AND p.product_id = $6
         AND p.status = 'active' AND p.validation_state = 'verified'
         AND m.status = 'active' AND m.account_authz_version = a.authz_version
         AND m.provider_id = a.provider_id AND m.product_id = a.product_id
         AND a.status = 'active' AND a.validation_state = 'verified'
         AND c.status = 'active' AND c.validation_state = 'verified'
         AND c.current_version IS NOT NULL
         AND (c.expires_at IS NULL OR c.expires_at > $3::timestamptz)
         AND v.owner_kind = 'platform' AND v.supply_mode = 'platform' AND v.status = 'active'
         AND (v.expires_at IS NULL OR v.expires_at > $3::timestamptz)
       ORDER BY m.account_id ASC, p.id ASC, c.id ASC`,
      [caller.tenantId, entitlement.supplyProfileId, now, caller.supplyProfileVersion, providerId, productId],
    );
    const resolutions: SupplyResolution[] = [];
    for (const row of rows) {
      try {
        if (
          row.grant_tenant_id !== caller.tenantId ||
          row.grant_profile_id !== entitlement.supplyProfileId ||
          row.grant_supply_mode !== 'platform' ||
          row.grant_status !== 'active' ||
          !isCurrentWindow(row, 'grant_effective_at', 'grant_expires_at', now) ||
          !sameVersion(row.grant_profile_authz_version, caller.supplyProfileVersion) ||
          !sameVersion(row.grant_profile_authz_version, entitlement.supplyProfileVersion) ||
          row.pool_status !== 'active' ||
          row.pool_validation_state !== 'verified' ||
          row.pool_provider_id !== providerId ||
          row.pool_product_id !== productId ||
          row.member_status !== 'active' ||
          row.member_provider_id !== providerId ||
          row.member_product_id !== productId ||
          !sameVersion(row.member_account_authz_version, row.account_authz_version) ||
          !sameVersion(row.grant_pool_authz_version, row.pool_authz_version)
        ) {
          fail('account');
        }
        assertRelationEvidence(row, 'grant_evidence_ref', 'grant_evidence_sha256');
        assertCredential(row, 'platform', now);
        assertAccountIdentity(row, providerId, productId);
        if (
          text(row, 'pool_credential_type') !== text(row, 'credential_type') ||
          text(row, 'pool_region') !== text(row, 'region') ||
          text(row, 'pool_purpose') !== text(row, 'purpose')
        ) {
          fail('account');
        }
        const poolRightRows = await queryRows(
          executor,
          `SELECT rights_id, version, provider_id, product_id, credential_type, supply_mode,
                  region, purpose, model_scope, endpoint_scope, effective_at, expires_at,
                  approval_ref, evidence_ref, evidence_sha256, status
           FROM saas_provider_rights
           WHERE rights_id = $1 AND version = $2
           LIMIT 2`,
          [row.pool_rights_id, row.pool_rights_version],
        );
        const poolRights = exactOne(poolRightRows);
        const poolId = text(row, 'pool_id');
        const accountId = text(row, 'account_id');
        const credentialId = text(row, 'credential_id');
        const accountAuthzVersion = versionNumber(row.account_authz_version);
        const credentialAuthzVersion = versionNumber(row.credential_authz_version);
        const credentialVersion = versionNumber(row.credential_version);
        const poolAuthzVersion = versionNumber(row.pool_authz_version);
        const poolMemberAccountAuthzVersion = versionNumber(row.member_account_authz_version);
        const poolMemberAuthzVersion = versionNumber(row.member_authz_version);
        const poolGrantAuthzVersion = versionNumber(row.grant_authz_version);
        const poolGrantProfileAuthzVersion = versionNumber(row.grant_profile_authz_version);
        const poolGrantPoolAuthzVersion = versionNumber(row.grant_pool_authz_version);
        resolutions.push({
          accountId,
          credentialType: text(row, 'credential_type'),
          region: text(row, 'region'),
          purpose: text(row, 'purpose'),
          accountRightsId: text(row, 'account_rights_id'),
          accountRightsVersion: version(row.account_rights_version),
          poolRights,
          poolMemberAuthzVersion,
          candidate: (
            input,
            route,
            resolvedModel,
            resolvedProviderId,
            resolvedProductId,
            profileVersion,
            supplierCostVersion,
          ) => ({
            tenantId: caller.tenantId,
            projectId: caller.projectId,
            proxyKeyId: caller.proxyKeyId,
            supplyProfileId: entitlement.supplyProfileId,
            supplyMode: 'platform',
            accountOwnerKind: 'platform',
            upstreamId: route.upstreamId,
            accountId,
            credentialId,
            credentialVersion,
            credentialAuthzVersion,
            accountAuthzVersion,
            dispatchProfileId: entitlement.supplyProfileId,
            supplyProfileAuthzVersion: profileVersion,
            resolvedModel,
            protocol: input.protocol,
            endpoint: route.endpoint,
            supplierCostVersion,
            poolId,
            poolAuthzVersion,
            poolMemberAccountAuthzVersion,
            poolMemberAuthzVersion,
            poolGrantAuthzVersion,
            poolGrantProfileAuthzVersion,
            poolGrantPoolAuthzVersion,
            providerId: resolvedProviderId,
            productId: resolvedProductId,
          }),
        });
      } catch (error) {
        if (error instanceof SafeAuthorityFailure && error.stage === 'account') continue;
        throw error;
      }
    }
    return resolutions;
  }

  private async assertAccountCapability(
    executor: SqlExecutor,
    accountId: string,
    caller: RequestPreparationCaller,
    providerId: string,
    productId: string,
    model: string,
    endpoint: string,
    capabilityVersion: number,
  ): Promise<void> {
    const table =
      caller.supplyMode === 'byok'
        ? 'saas_tenant_provider_account_capabilities'
        : 'saas_platform_provider_account_capabilities';
    const values =
      caller.supplyMode === 'byok'
        ? [caller.tenantId, accountId, providerId, productId, model, endpoint, capabilityVersion]
        : [accountId, providerId, productId, model, endpoint, capabilityVersion];
    const predicate =
      caller.supplyMode === 'byok'
        ? 'tenant_id = $1 AND account_id = $2 AND provider_id = $3 AND product_id = $4 AND model = $5 AND endpoint = $6 AND capability_version = $7'
        : 'account_id = $1 AND provider_id = $2 AND product_id = $3 AND model = $4 AND endpoint = $5 AND capability_version = $6';
    const rows = await queryRows(
      executor,
      `/* preparation-authority:account-capability */
       SELECT capability_version FROM ${table} WHERE ${predicate} LIMIT 2`,
      values,
    );
    const row = exactOne(rows);
    if (!sameVersion(row.capability_version, capabilityVersion)) fail('account');
  }
}

interface SupplyResolution {
  readonly accountId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly accountRightsId: string;
  readonly accountRightsVersion: string;
  readonly poolRights: Row | null;
  readonly poolMemberAuthzVersion: number | null;
  candidate(
    input: {
      readonly protocol: RequestPreparationAuthority['route']['protocol'];
    },
    route: {
      readonly upstreamId: string;
      readonly endpoint: string;
    },
    resolvedModel: string,
    providerId: string,
    productId: string,
    profileVersion: number,
    supplierCostVersion: string | null,
  ): RequestPreparationAuthority['candidate'];
}
