import type { ByokPlanEntitlementResolver, EffectiveByokEntitlement } from '../plans/types.js';
import type { GatewayProtocol } from './contracts.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationCaller,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  type RequestPreparationEntitlementPort,
  rejectRequestPreparation,
} from './request-preparation-service.js';

type RequestPlanResolver = Pick<ByokPlanEntitlementResolver, 'resolveBoundForRequest'>;

const ENTITLEMENT_DENIED = 'The current BYOK service-plan entitlement does not authorize this request.';
const STORAGE_UNAVAILABLE = 'The BYOK service-plan entitlement authority is unavailable.';

function validScope(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (providerId) => typeof providerId === 'string' && providerId.trim() !== '' && providerId === providerId.trim(),
    )
  );
}

function sameScope(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((providerId, index) => providerId === right[index]);
}

function matchesRequest(
  resolved: EffectiveByokEntitlement,
  caller: RequestPreparationCaller,
  publicModel: string,
): boolean {
  return (
    resolved.tenantId === caller.tenantId &&
    resolved.projectId === caller.projectId &&
    resolved.entitlementId === caller.entitlementId &&
    resolved.snapshot.tenantId === caller.tenantId &&
    resolved.snapshot.supplyMode === 'byok' &&
    resolved.snapshot.supplyProfileId === caller.supplyProfileId &&
    resolved.entitlementAuthzVersion === caller.entitlementVersion &&
    resolved.supplyProfileAuthzVersion === caller.supplyProfileVersion &&
    resolved.modelScopeVersion === caller.modelScopeVersion &&
    resolved.modelScopes.includes(publicModel) &&
    resolved.snapshot.allowedModels.includes(publicModel) &&
    validScope(resolved.allowedProviderIds) &&
    sameScope(resolved.allowedProviderIds, resolved.snapshot.allowedProviderIds)
  );
}

/**
 * Adds the immutable BYOK provider scope to the gateway entitlement from the
 * plan service. The delegate may resolve the ordinary project entitlement,
 * but its provider list is never trusted for authorization.
 */
export class PostgresRequestPreparationEntitlementAdapter implements RequestPreparationEntitlementPort {
  constructor(
    private readonly delegate: RequestPreparationEntitlementPort,
    private readonly plans: RequestPlanResolver,
  ) {}

  async resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
  }): Promise<RequestPreparationDecision<RequestPreparationEntitlement>> {
    const delegated = await this.delegate.resolve(input);
    if (delegated.decision !== 'allow' || input.caller.supplyMode !== 'byok') return delegated;

    let resolved: EffectiveByokEntitlement | null;
    try {
      resolved = await this.plans.resolveBoundForRequest(
        { tenantId: input.caller.tenantId, projectId: input.caller.projectId },
        input.caller.entitlementId,
      );
    } catch {
      return blockRequestPreparation('storage_failure', STORAGE_UNAVAILABLE);
    }

    if (!resolved || !matchesRequest(resolved, input.caller, input.publicModel)) {
      return rejectRequestPreparation('entitlement_denied', ENTITLEMENT_DENIED);
    }

    return allowRequestPreparation({
      ...delegated.value,
      allowedModels: [...resolved.modelScopes],
      allowedProviderIds: [...resolved.allowedProviderIds],
    });
  }
}
