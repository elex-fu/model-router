import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SaasCatalogService } from '../saas/catalog/service.js';
import type { SaasDatabase } from '../saas/db/index.js';
import { SaasCommercialMeteringPolicyService } from '../saas/gateway/commercial-metering-policy-service.js';
import type { GatewayProtocol, ModelResolutionProvenance } from '../saas/gateway/contracts.js';
import {
  DispatchUsageSettlementCoordinator,
  type NormalSuccessSettlementPort,
} from '../saas/gateway/dispatch-usage-settlement.js';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort as GatewayPreparedEvidenceDispatchPort,
  type ModelDiscoveryPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
  type SaasGatewayHttpHandler,
} from '../saas/gateway/http-handler.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  type ProviderAccountRuntimeHealthWriter,
} from '../saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../saas/gateway/postgres-provider-account-scheduler.js';
import {
  PostgresRequestPreparationAuthorityAdapter,
  type PostgresRequestPreparationAuthorityAdapterDependencies,
} from '../saas/gateway/postgres-request-preparation-authority-adapter.js';
import { PostgresRequestPreparationEntitlementAdapter } from '../saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import {
  type PreparedEvidenceLeaseProvider,
  type PreparedEvidenceMeteringPort,
  type PreparedEvidenceTransport,
  SaasPreparedEvidenceDispatchService,
} from '../saas/gateway/prepared-evidence-dispatch-service.js';
import {
  type PreparedRequestEvidenceDispatchPort,
  type PreparedRequestEvidenceRegistrar,
  SaasPreparedRequestEvidenceService,
  type TrustedPreparedRequestVerifierKey,
} from '../saas/gateway/prepared-request-evidence-service.js';
import {
  PostgresProviderAccountLeaseService,
  type ProviderAccountLeaseServiceOptions,
} from '../saas/gateway/provider-account-lease-service.js';
import type { ProviderAccountSchedulerAffinityPort } from '../saas/gateway/provider-account-scheduler.js';
import {
  isProviderHttpTestAddressCapability,
  type ProviderHttpTestAddressCapability,
} from '../saas/gateway/provider-http-address.js';
import {
  type ProviderHttpDispatchProfileResolveInput,
  type ProviderHttpEndpointPolicy,
  type ProviderHttpFetch,
  ProviderHttpTransport,
} from '../saas/gateway/provider-http-transport.js';
import {
  type ProviderModelCompatibilityChecker,
  ProviderPayloadCompiler,
  type ProviderPayloadCompilerInput,
  type ProviderUsageUpperBoundEstimator,
} from '../saas/gateway/provider-payload-compiler.js';
import {
  type GatewayRequestIdempotencyClaimResult,
  GatewayRequestIdempotencyStore,
} from '../saas/gateway/request-idempotency.js';
import {
  blockRequestPreparation,
  type RequestPreparationAdmissionPort,
  type RequestPreparationAttemptPort,
  type RequestPreparationAuthority,
  type RequestPreparationAuthorityPort,
  type RequestPreparationCaller,
  type RequestPreparationCallerPort,
  type RequestPreparationCompensationPort,
  type RequestPreparationDependencies,
  type RequestPreparationEntitlement,
  type RequestPreparationEntitlementPort,
  type RequestPreparationEvidenceSigner,
  type RequestPreparationIdFactory,
  type RequestPreparationPayloadCompiler,
  type RequestPreparationTransactionPort,
  rejectRequestPreparation,
  SaasRequestPreparationService,
} from '../saas/gateway/request-preparation-service.js';
import { SaasRouteConfigService } from '../saas/gateway/route-config-service.js';
import { PostgresSupplyProfileResolver } from '../saas/keys/resolver.js';
import { KeyService } from '../saas/keys/service.js';
import type { AuthenticatedApiKey } from '../saas/keys/types.js';
import { DurableNormalSuccessSettlementPort } from '../saas/metering/conditional-settlement-port.js';
import { SaasMeteringService } from '../saas/metering/service.js';
import { ByokServicePlanService } from '../saas/plans/service.js';
import { SaasPricingService } from '../saas/pricing/service.js';
import type { ProviderCredentialUnsealingKms } from '../saas/runtime/gateway-provider-credential-kms.js';
import {
  GatewayProviderCredentialUnsealer,
  type GatewayProviderCredentialUnsealerOptions,
} from '../saas/runtime/gateway-provider-credential-unsealer.js';
import {
  type ProviderSupplyHttpAuthenticationHeaderResolver,
  ProviderSupplyHttpCredentialResolver,
} from '../saas/runtime/provider-supply-http-credential-resolver.js';
import type { ProviderTarget, ProviderTargetResolver } from '../saas/runtime/provider-target-resolver.js';
import {
  type RequestPreparationSigner,
  RequestPreparationSignerAdapter,
} from '../saas/runtime/request-preparation-signer-adapter.js';
import { PostgresProviderSupplyRepository } from '../saas/supply/repository.js';

/** Stable safe error used when the `/v1` graph cannot be constructed. */
export class ManagedSaasGatewayCompositionError extends Error {
  constructor(readonly code: 'MISSING_DEPENDENCY' | 'INVALID_CONFIGURATION' | 'UNAVAILABLE') {
    super(
      code === 'MISSING_DEPENDENCY'
        ? 'Managed SaaS gateway dependencies are incomplete'
        : code === 'INVALID_CONFIGURATION'
          ? 'Managed SaaS gateway configuration is invalid'
          : 'Managed SaaS gateway is unavailable',
    );
    this.name = 'ManagedSaasGatewayCompositionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ManagedSaasGatewayLifecycle {
  /** Closes resources owned by the gateway composition exactly once. */
  close(): Promise<void>;
}

/**
 * The preparation service's optional fields are deliberately required here.
 * The production composition must never turn a missing signer, registrar, or
 * compensation capability into an apparently usable gateway.
 */
export type ManagedSaasGatewayPreparationDependencies = Omit<
  RequestPreparationDependencies,
  'compensation' | 'signer' | 'registrar' | 'transaction'
> & {
  readonly transaction: RequestPreparationTransactionPort;
  readonly compensation: RequestPreparationCompensationPort;
  readonly signer: RequestPreparationEvidenceSigner;
  readonly registrar: PreparedRequestEvidenceRegistrar;
};

export interface ManagedSaasGatewayDispatchDependencies {
  readonly evidence: PreparedRequestEvidenceDispatchPort;
  readonly metering: PreparedEvidenceMeteringPort;
  readonly leaseProvider: PreparedEvidenceLeaseProvider;
  readonly transport: PreparedEvidenceTransport;
  readonly normalSuccessSettlement?: NormalSuccessSettlementPort;
  /** Installed by the production composition; tests may supply a recording fake. */
  readonly runtimeHealthWriter?: ProviderAccountRuntimeHealthWriter;
}

/**
 * Required graph input for the low-level builder. It accepts ports, not an
 * already assembled HTTP handler, so the builder owns construction of the
 * preparation service, dispatch service, and HTTP boundary.
 */
export interface ManagedSaasGatewayCompositionDependencies {
  readonly authenticator: ProxyKeyAuthenticator;
  readonly preparation: ManagedSaasGatewayPreparationDependencies;
  readonly preparationOptions: {
    readonly evidenceVerifierKeyId: string;
    readonly idFactory: RequestPreparationIdFactory;
  };
  readonly dispatch: ManagedSaasGatewayDispatchDependencies;
  readonly lifecycle: ManagedSaasGatewayLifecycle;
  readonly maxBodyBytes: number;
  readonly entryPoint: string;
}

export interface ManagedSaasGatewayComposition {
  readonly handler: SaasGatewayHttpHandler;
  readonly preparation: SaasRequestPreparationService;
  readonly dispatch: SaasPreparedEvidenceDispatchService;
  close(): Promise<void>;
}

function hasFunction(value: unknown, name: string): boolean {
  if (!value || typeof value !== 'object') return false;
  try {
    return typeof (value as Record<string, unknown>)[name] === 'function';
  } catch {
    return false;
  }
}

function requireCallable(value: unknown): void {
  if (typeof value !== 'function') throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
}

function requireDependency(value: unknown, name: string): void {
  if (!value || typeof value !== 'object') throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  if (!hasFunction(value, name)) throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
}

function requirePositiveInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decisionValue<T>(decision: unknown): T | null {
  if (!record(decision)) throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
  if (decision.decision === 'reject') return null;
  if (decision.decision === 'block') throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
  if (decision.decision !== 'allow' || !Object.hasOwn(decision, 'value') || !record(decision.value)) {
    throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
  }
  return decision.value as T;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasPositiveExactVersion(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value === 'bigint') return value > 0n && value <= 9_223_372_036_854_775_807n;
  if (typeof value !== 'string' || value.length === 0 || value.length > 19 || !/^\d+$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function authenticatedKeyModelScopes(authenticatedCaller: AuthenticatedApiKey): readonly string[] {
  const metadata = authenticatedCaller?.metadata;
  const authorization = authenticatedCaller?.authorization;
  const scopes = authorization?.modelScopes;
  const metadataScopes = metadata?.modelScopes;
  if (
    !metadata ||
    !authorization ||
    metadata.status !== 'active' ||
    metadata.id !== authorization.keyId ||
    metadata.tenantId !== authorization.tenantId ||
    metadata.projectId !== authorization.projectId ||
    metadata.executionPrincipalType !== authorization.principalKind ||
    metadata.executionPrincipalId !== authorization.principalId ||
    metadata.entitlementId !== authorization.entitlementId ||
    metadata.supplyProfileId !== authorization.supplyProfileId ||
    metadata.supplyMode !== authorization.supplyMode ||
    String(metadata.authzVersion) !== String(authorization.authzVersion) ||
    String(metadata.modelScopeVersion) !== String(authorization.modelScopeVersion) ||
    String(metadata.entitlementAuthzVersion) !== String(authorization.entitlementAuthzVersion) ||
    String(metadata.supplyProfileAuthzVersion) !== String(authorization.supplyProfileAuthzVersion) ||
    !Array.isArray(scopes) ||
    !Array.isArray(metadataScopes) ||
    scopes.length === 0 ||
    !sameOrderedStrings(scopes, metadataScopes) ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '' || scope !== scope.trim())
  ) {
    throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
  }
  return scopes;
}

function callerMatchesAuthenticatedKey(
  caller: RequestPreparationCaller,
  authenticatedCaller: AuthenticatedApiKey,
  publicModel: string,
): boolean {
  const authorization = authenticatedCaller.authorization;
  return (
    caller.tenantId === authorization.tenantId &&
    caller.projectId === authorization.projectId &&
    caller.proxyKeyId === authorization.keyId &&
    caller.principalKind === authorization.principalKind &&
    caller.principalId === authorization.principalId &&
    caller.entitlementId === authorization.entitlementId &&
    caller.supplyProfileId === authorization.supplyProfileId &&
    caller.supplyMode === authorization.supplyMode &&
    String(caller.authzVersion) === String(authorization.authzVersion) &&
    String(caller.entitlementVersion) === String(authorization.entitlementAuthzVersion) &&
    String(caller.supplyProfileVersion) === String(authorization.supplyProfileAuthzVersion) &&
    String(caller.modelScopeVersion) === String(authorization.modelScopeVersion) &&
    Array.isArray(caller.modelScopes) &&
    sameOrderedStrings(caller.modelScopes, authorization.modelScopes) &&
    caller.modelScopes.includes(publicModel)
  );
}

function entitlementAuthorizesModel(
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  publicModel: string,
): boolean {
  const allowedModels = entitlement.allowedModels;
  const allowedProviderIds = entitlement.allowedProviderIds;
  return (
    entitlement.tenantId === caller.tenantId &&
    entitlement.projectId === caller.projectId &&
    entitlement.proxyKeyId === caller.proxyKeyId &&
    entitlement.entitlementId === caller.entitlementId &&
    String(entitlement.entitlementVersion) === String(caller.entitlementVersion) &&
    entitlement.supplyProfileId === caller.supplyProfileId &&
    String(entitlement.supplyProfileVersion) === String(caller.supplyProfileVersion) &&
    entitlement.supplyMode === caller.supplyMode &&
    String(entitlement.modelScopeVersion) === String(caller.modelScopeVersion) &&
    hasPositiveExactVersion(entitlement.projectPolicyVersion) &&
    Array.isArray(allowedModels) &&
    new Set(allowedModels).size === allowedModels.length &&
    allowedModels.every((model) => typeof model === 'string' && model.trim() !== '' && model === model.trim()) &&
    allowedModels.includes(publicModel) &&
    Array.isArray(allowedProviderIds) &&
    new Set(allowedProviderIds).size === allowedProviderIds.length &&
    allowedProviderIds.every(
      (providerId) => typeof providerId === 'string' && providerId.trim() !== '' && providerId === providerId.trim(),
    ) &&
    (caller.supplyMode === 'byok' ? allowedProviderIds.length > 0 : allowedProviderIds.length === 0)
  );
}

function authorityMatchesRequest(
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  authority: RequestPreparationAuthority,
  publicModel: string,
): boolean {
  const targetMode = caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  const ownerKind = caller.supplyMode === 'byok' ? 'tenant' : 'platform';
  const candidate = authority.candidate;
  return (
    authority.route.tenantId === caller.tenantId &&
    authority.route.projectId === caller.projectId &&
    authority.route.publicModel === publicModel &&
    authority.route.protocol === 'openai' &&
    authority.route.targetMode === targetMode &&
    candidate.tenantId === caller.tenantId &&
    candidate.projectId === caller.projectId &&
    candidate.proxyKeyId === caller.proxyKeyId &&
    candidate.supplyProfileId === entitlement.supplyProfileId &&
    candidate.supplyMode === caller.supplyMode &&
    candidate.accountOwnerKind === ownerKind &&
    (caller.supplyMode !== 'byok' || entitlement.allowedProviderIds.includes(candidate.providerId))
  );
}

function createModelDiscoveryPort(preparation: ManagedSaasGatewayPreparationDependencies): ModelDiscoveryPort {
  return {
    async list(authenticatedCaller) {
      const models: string[] = [];
      for (const publicModel of authenticatedKeyModelScopes(authenticatedCaller)) {
        const caller = decisionValue<RequestPreparationCaller>(
          await preparation.caller.validate({ authenticatedCaller, publicModel, protocol: 'openai' }),
        );
        if (!caller) continue;
        if (!callerMatchesAuthenticatedKey(caller, authenticatedCaller, publicModel)) {
          throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
        }

        const entitlement = decisionValue<RequestPreparationEntitlement>(
          await preparation.entitlement.resolve({ caller, publicModel, protocol: 'openai' }),
        );
        if (!entitlement) continue;
        if (!entitlementAuthorizesModel(caller, entitlement, publicModel)) {
          throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
        }

        const authority = decisionValue<RequestPreparationAuthority>(
          await preparation.authority.resolve({ caller, entitlement, publicModel, protocol: 'openai' }),
        );
        if (!authority) continue;
        if (!authorityMatchesRequest(caller, entitlement, authority, publicModel)) {
          throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
        }
        models.push(publicModel);
      }
      return models;
    },
  };
}

function closeOnce(lifecycle: ManagedSaasGatewayLifecycle): () => Promise<void> {
  requireDependency(lifecycle, 'close');
  let closed: Promise<void> | undefined;
  return () => {
    closed ??= Promise.resolve().then(() => lifecycle.close());
    return closed;
  };
}

function validateCompositionDependencies(dependencies: ManagedSaasGatewayCompositionDependencies): void {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  requireDependency(dependencies.authenticator, 'authenticate');
  const preparation = dependencies.preparation;
  if (!preparation || typeof preparation !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  for (const [value, method] of [
    [preparation.caller, 'validate'],
    [preparation.entitlement, 'resolve'],
    [preparation.authority, 'resolve'],
    [preparation.payload, 'compile'],
    [preparation.admission, 'authorizeAndReserve'],
    [preparation.attempt, 'persist'],
    [preparation.transaction, 'transaction'],
    [preparation.compensation, 'releasePreDispatch'],
    [preparation.signer, 'sign'],
    [preparation.registrar, 'register'],
  ] as const) {
    requireDependency(value, method);
  }
  const preparationOptions = dependencies.preparationOptions;
  if (!preparationOptions || typeof preparationOptions !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  requireText(preparationOptions.evidenceVerifierKeyId);
  requireDependency(preparationOptions.idFactory, 'requestId');
  requireDependency(preparationOptions.idFactory, 'attemptId');
  requireDependency(preparationOptions.idFactory, 'evidenceId');

  const dispatch = dependencies.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  for (const [value, method] of [
    [dispatch.evidence, 'preflightForDispatch'],
    [dispatch.evidence, 'claimForDispatch'],
    [dispatch.metering, 'getAttempt'],
    [dispatch.metering, 'transitionAttempt'],
    [dispatch.leaseProvider, 'acquire'],
    [dispatch.transport, 'send'],
  ] as const) {
    requireDependency(value, method);
  }
  if (dispatch.normalSuccessSettlement !== undefined) {
    requireDependency(dispatch.normalSuccessSettlement, 'complete');
    requireDependency(dispatch.normalSuccessSettlement, 'retainUnknown');
  }
  if (dispatch.runtimeHealthWriter !== undefined) {
    requireDependency(dispatch.runtimeHealthWriter, 'recordRuntimeOutcome');
  }
  requirePositiveInteger(dependencies.maxBodyBytes);
  requireText(dependencies.entryPoint);
  requireDependency(dependencies.lifecycle, 'close');
}

/**
 * Construct the only HTTP handler that can be mounted at `/v1`.
 * Every capability is validated before a listener is created.
 */
export function createManagedSaasGatewayComposition(
  dependencies: ManagedSaasGatewayCompositionDependencies,
): ManagedSaasGatewayComposition {
  validateCompositionDependencies(dependencies);
  const requestIdContext = new AsyncLocalStorage<string>();
  const configuredIdFactory = dependencies.preparationOptions.idFactory;
  const requestId = (): string => {
    try {
      const generated = configuredIdFactory.requestId();
      if (
        typeof generated === 'string' &&
        generated.length > 0 &&
        generated.length <= 256 &&
        ![...generated].some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x21 || code > 0x7e;
        })
      ) {
        return generated;
      }
    } catch {
      // A server generated UUID keeps the HTTP boundary available.
    }
    return randomUUID();
  };
  const requestScopedIdFactory: RequestPreparationIdFactory = {
    requestId: () => requestIdContext.getStore() ?? configuredIdFactory.requestId(),
    attemptId: () => configuredIdFactory.attemptId(),
    evidenceId: () => configuredIdFactory.evidenceId(),
  };
  const preparation = new SaasRequestPreparationService(dependencies.preparation, {
    evidenceVerifierKeyId: dependencies.preparationOptions.evidenceVerifierKeyId,
    idFactory: requestScopedIdFactory,
  });
  const dispatch = new SaasPreparedEvidenceDispatchService(
    dependencies.dispatch.evidence,
    dependencies.dispatch.metering,
    dependencies.dispatch.leaseProvider,
    dependencies.dispatch.transport,
    dependencies.dispatch.normalSuccessSettlement,
    dependencies.dispatch.runtimeHealthWriter,
  );
  const httpHandler = createSaasGatewayHandler({
    authenticator: dependencies.authenticator,
    preparation,
    dispatch,
    modelDiscovery: createModelDiscoveryPort(dependencies.preparation),
    maxBodyBytes: dependencies.maxBodyBytes,
    entryPoint: dependencies.entryPoint,
  });
  const handler: SaasGatewayHttpHandler = (req, res) => {
    const currentRequestId = requestId();
    return requestIdContext.run(currentRequestId, () => httpHandler(req, res, { requestId: currentRequestId }));
  };
  const close = closeOnce(dependencies.lifecycle);
  return Object.freeze({ handler, preparation, dispatch, close });
}

export interface ManagedSaasProviderPreparationRoute {
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly modelResolution: ModelResolutionProvenance;
}

export type ManagedSaasProviderPreparationRouteResolver = (input: {
  readonly authority: Parameters<RequestPreparationPayloadCompiler['compile']>[0]['authority'];
  readonly caller: Parameters<RequestPreparationPayloadCompiler['compile']>[0]['caller'];
  readonly entitlement: Parameters<RequestPreparationPayloadCompiler['compile']>[0]['entitlement'];
}) => Promise<ManagedSaasProviderPreparationRoute>;

export interface ManagedSaasProviderTargetRoute {
  readonly productId: string;
  readonly providerProtocol: string;
  readonly providerOperation: string;
}

export type ManagedSaasProviderTargetRouteResolver = (
  input: ProviderHttpDispatchProfileResolveInput,
) => Promise<ManagedSaasProviderTargetRoute | null>;

export interface ManagedSaasProviderPayloadOptions {
  /** Required: there is no estimator default in production composition. */
  readonly estimator: ProviderUsageUpperBoundEstimator;
  /** Required: must be backed by the provider/catalog capability authority. */
  readonly modelCompatibility: ProviderModelCompatibilityChecker;
  readonly maxPayloadBytes: number;
  readonly compilerVersion: string;
}

export interface ManagedSaasGatewayProductionOptions {
  /** These preparation ports remain required until their real runtime adapters land. */
  readonly caller: RequestPreparationCallerPort;
  readonly entitlement: RequestPreparationEntitlementPort;
  /** Affinity remains a preference source; account rights are revalidated by the PostgreSQL scheduler. */
  readonly schedulerAffinity: ProviderAccountSchedulerAffinityPort;
  readonly admission: RequestPreparationAdmissionPort;
  readonly attempt: RequestPreparationAttemptPort;
  readonly compensation: RequestPreparationCompensationPort;
  /** Stable across gateway replicas and restarts; at least 32 bytes. Required at runtime. */
  readonly idempotencyHmacKey?: Uint8Array;

  readonly providerPreparationRoute: ManagedSaasProviderPreparationRouteResolver;
  readonly providerPayload: ManagedSaasProviderPayloadOptions;
  readonly evidenceSigner: RequestPreparationSigner;
  readonly evidenceVerifierKeyId: string;
  /** Request/attempt/evidence IDs are owned by the gateway caller. */
  readonly idFactory: RequestPreparationIdFactory;
  readonly trustedVerifierPublicKeys:
    | ReadonlyMap<string, TrustedPreparedRequestVerifierKey>
    | Readonly<Record<string, TrustedPreparedRequestVerifierKey>>;

  readonly providerTargetResolver: Pick<ProviderTargetResolver, 'resolve'>;
  readonly providerTargetRoute: ManagedSaasProviderTargetRouteResolver;
  /** Test-runner-only capability for pinned local HTTPS integration upstreams. */
  readonly providerHttpTestAddressCapability?: ProviderHttpTestAddressCapability;
  readonly providerCredentialUnsealingKms: ProviderCredentialUnsealingKms;
  readonly credentialContext: GatewayProviderCredentialUnsealerOptions;
  readonly resolveAuthenticationHeader: ProviderSupplyHttpAuthenticationHeaderResolver;
  readonly fetch: ProviderHttpFetch;
  readonly endpointPolicy: ProviderHttpEndpointPolicy;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly leaseTtlMs: number;
  readonly maxBodyBytes: number;
  readonly entryPoint: string;
}

function sameEndpointPolicy(left: ProviderHttpEndpointPolicy, right: ProviderHttpEndpointPolicy): boolean {
  const hosts = (value: readonly string[]) => [...value].map((host) => host.toLowerCase()).sort();
  const ports = (value: readonly number[]) => [...value].sort((a, b) => a - b);
  return (
    JSON.stringify(hosts(left.allowedHosts)) === JSON.stringify(hosts(right.allowedHosts)) &&
    JSON.stringify(ports(left.allowedPorts)) === JSON.stringify(ports(right.allowedPorts))
  );
}

function requireTrustedVerifierKey(
  keys: ManagedSaasGatewayProductionOptions['trustedVerifierPublicKeys'],
  keyId: string,
): void {
  const isConfigured = (value: unknown): boolean =>
    (typeof value === 'string' && value.trim() !== '') ||
    (value instanceof Uint8Array && value.byteLength > 0) ||
    (typeof value === 'object' && value !== null);
  if (keys instanceof Map) {
    const key = keys.get(keyId);
    if (!isConfigured(key)) throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
    return;
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  if (!Object.hasOwn(keys, keyId)) throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  const key = (keys as Readonly<Record<string, TrustedPreparedRequestVerifierKey>>)[keyId];
  if (!isConfigured(key)) throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
}

function createProductionIdempotencyAdmission(
  admission: RequestPreparationAdmissionPort,
  store: GatewayRequestIdempotencyStore,
): RequestPreparationAdmissionPort {
  return {
    async authorizeAndReserve(input, sqlOptions) {
      const executor = sqlOptions?.executor;
      if (!executor) {
        return blockRequestPreparation(
          'capability_unavailable',
          'Persistent request idempotency requires the admission transaction.',
        );
      }
      let claim: GatewayRequestIdempotencyClaimResult;
      try {
        claim = await store.claim(executor, {
          tenantId: input.tenantId,
          projectId: input.projectId,
          proxyKeyId: input.proxyKeyId,
          clientKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          requestFingerprintVersion: input.requestFingerprintVersion,
          requestId: input.requestId,
        });
      } catch {
        return blockRequestPreparation('storage_failure', 'SaaS request admission could not be authorized.');
      }
      if (claim.kind === 'fingerprint_conflict') {
        return rejectRequestPreparation(
          'idempotency_conflict',
          'The idempotency key is already bound to a different request fingerprint.',
        );
      }
      if (claim.kind === 'existing') {
        return rejectRequestPreparation(
          'idempotency_replay',
          'The existing canonical request is returned without replaying its response.',
          { requestId: claim.canonicalRequestId, status: claim.canonicalRequestStatus },
        );
      }
      if (claim.canonicalRequestId !== input.requestId) {
        return rejectRequestPreparation('binding_mismatch', 'SaaS request admission could not be authorized.');
      }
      const admitted = await admission.authorizeAndReserve({ ...input, idempotencyClaim: claim }, sqlOptions);
      if (admitted.decision !== 'allow') return admitted;
      const binding = admitted.value.idempotencyBinding;
      if (
        binding?.state !== 'created' ||
        binding.keyDigest !== claim.keyDigest ||
        binding.requestFingerprint !== input.requestFingerprint ||
        binding.requestFingerprintVersion !== input.requestFingerprintVersion ||
        binding.tenantId !== input.tenantId ||
        binding.projectId !== input.projectId ||
        binding.proxyKeyId !== input.proxyKeyId ||
        binding.requestId !== claim.canonicalRequestId
      ) {
        return rejectRequestPreparation(
          'binding_mismatch',
          'Admission did not retain the durable request idempotency claim.',
        );
      }
      return admitted;
    },
  };
}

function validateEndpointPolicy(policy: ProviderHttpEndpointPolicy): void {
  if (
    !policy ||
    typeof policy !== 'object' ||
    !Array.isArray(policy.allowedHosts) ||
    !Array.isArray(policy.allowedPorts)
  ) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  if (policy.allowedHosts.length === 0 || policy.allowedPorts.length === 0) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  for (const host of policy.allowedHosts) requireText(host);
  for (const port of policy.allowedPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
    }
  }
}

function createProviderPayloadCompiler(
  options: ManagedSaasGatewayProductionOptions,
): RequestPreparationPayloadCompiler {
  const payloadOptions = options.providerPayload;
  if (!payloadOptions || typeof payloadOptions !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  requireDependency(payloadOptions.estimator, 'estimate');
  requireText(payloadOptions.estimator.version);
  requireCallable(payloadOptions.modelCompatibility);
  requirePositiveInteger(payloadOptions.maxPayloadBytes);
  requireText(payloadOptions.compilerVersion);
  requireCallable(options.providerPreparationRoute);

  const compiler = new ProviderPayloadCompiler({
    estimator: payloadOptions.estimator,
    modelCompatibility: payloadOptions.modelCompatibility,
    maxPayloadBytes: payloadOptions.maxPayloadBytes,
    compilerVersion: payloadOptions.compilerVersion,
    allowIdentityModelResolution: false,
  });

  return {
    async compile(input) {
      let route: ManagedSaasProviderPreparationRoute;
      try {
        route = await options.providerPreparationRoute({
          authority: input.authority,
          caller: input.caller,
          entitlement: input.entitlement,
        });
      } catch {
        return {
          decision: 'block',
          code: 'capability_unavailable',
          message: 'provider preparation route is unavailable',
        };
      }
      if (
        !route ||
        route.clientProtocol !== input.authority.route.protocol ||
        typeof route.providerProtocol !== 'string' ||
        route.providerProtocol.trim() === '' ||
        typeof route.clientOperation !== 'string' ||
        route.clientOperation.trim() === '' ||
        typeof route.providerOperation !== 'string' ||
        route.providerOperation.trim() === '' ||
        !route.modelResolution ||
        typeof route.modelResolution !== 'object'
      ) {
        return {
          decision: 'block',
          code: 'capability_unavailable',
          message: 'provider preparation route is incomplete',
        };
      }
      return compiler.compile({
        ...input,
        clientProtocol: route.clientProtocol,
        providerProtocol: route.providerProtocol,
        clientOperation: route.clientOperation,
        providerOperation: route.providerOperation,
        operation: route.providerOperation,
        modelResolution: route.modelResolution,
      } as ProviderPayloadCompilerInput);
    },
  };
}

function createProviderDispatchProfileResolver(
  options: ManagedSaasGatewayProductionOptions,
): ConstructorParameters<typeof ProviderHttpTransport>[0]['resolveDispatchProfile'] {
  requireDependency(options.providerTargetResolver, 'resolve');
  requireCallable(options.providerTargetRoute);
  return async (input) => {
    const route = await options.providerTargetRoute(input);
    if (!route) return null;
    requireText(route.productId);
    requireText(route.providerProtocol);
    requireText(route.providerOperation);
    const target: ProviderTarget = options.providerTargetResolver.resolve({
      upstreamId: input.upstreamId,
      productId: route.productId,
      protocol: route.providerProtocol,
      operation: route.providerOperation,
    });
    if (target.method !== 'POST' || !sameEndpointPolicy(target.endpointPolicy, options.endpointPolicy)) {
      throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
    }
    const url = target.url ?? target.targetUrl;
    return typeof url === 'string' && url.length > 0 ? { url } : null;
  };
}

/**
 * Compose the real database-backed services around the required runtime
 * adapters. Missing caller/admission/route/KMS/config capabilities throw
 * before startup can bind the gateway listener.
 */
export function createManagedSaasGatewayProductionComposition(
  database: SaasDatabase,
  options: ManagedSaasGatewayProductionOptions,
): ManagedSaasGatewayComposition {
  // Production composition constructs PostgreSQL stores that use both direct
  // queries and transactions. Check the complete database contract here so a
  // partial adapter cannot escape as a lower-level constructor TypeError.
  if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  if (!options || typeof options !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  requireDependency(options.schedulerAffinity, 'resolve');
  requireDependency(options.providerCredentialUnsealingKms, 'decryptDataKey');
  requireDependency(options.providerCredentialUnsealingKms, 'checkReady');
  requireDependency(options.providerCredentialUnsealingKms, 'close');
  requireDependency(options.evidenceSigner, 'sign');
  requireText(options.evidenceVerifierKeyId);
  requireText(options.evidenceSigner.verifierKeyId);
  if (options.evidenceSigner.verifierKeyId !== options.evidenceVerifierKeyId) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  requireDependency(options.idFactory, 'requestId');
  requireDependency(options.idFactory, 'attemptId');
  requireDependency(options.idFactory, 'evidenceId');
  requireTrustedVerifierKey(options.trustedVerifierPublicKeys, options.evidenceVerifierKeyId);
  if (
    options.providerHttpTestAddressCapability !== undefined &&
    !isProviderHttpTestAddressCapability(options.providerHttpTestAddressCapability)
  ) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  if (!options.credentialContext || typeof options.credentialContext !== 'object') {
    throw new ManagedSaasGatewayCompositionError('MISSING_DEPENDENCY');
  }
  requireText(options.credentialContext.deployment);
  requireText(options.credentialContext.environment);
  validateEndpointPolicy(options.endpointPolicy);
  requireCallable(options.resolveAuthenticationHeader);
  requireCallable(options.fetch);
  requirePositiveInteger(options.timeoutMs);
  requirePositiveInteger(options.maxConcurrency);
  requirePositiveInteger(options.leaseTtlMs);
  if (!(options.idempotencyHmacKey instanceof Uint8Array) || options.idempotencyHmacKey.byteLength < 32) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  const idempotencyStore = new GatewayRequestIdempotencyStore({ hmacKey: options.idempotencyHmacKey });

  const runtimeHealthStore = new PostgresProviderAccountRuntimeHealthStore({ database });
  const scheduler = new PostgresProviderAccountScheduler({
    database,
    health: runtimeHealthStore,
    affinity: options.schedulerAffinity,
    leaseConcurrencyLimit: options.maxConcurrency,
  });

  const routes = new SaasRouteConfigService(database);
  const commercial = new SaasCommercialMeteringPolicyService(database);
  const catalog = new SaasCatalogService(database);
  const byokEntitlements = new ByokServicePlanService(database);
  const authorityDependencies: PostgresRequestPreparationAuthorityAdapterDependencies = {
    database,
    routes,
    commercial,
    catalog,
    byokEntitlements,
  };
  const authority: RequestPreparationAuthorityPort = new PostgresRequestPreparationAuthorityAdapter(
    authorityDependencies,
  );

  const evidence = new SaasPreparedRequestEvidenceService(database, {
    trustedVerifierPublicKeys: options.trustedVerifierPublicKeys,
  });
  const signer = new RequestPreparationSignerAdapter({
    signer: options.evidenceSigner,
    runtimeVerifierKeyId: options.evidenceVerifierKeyId,
  });
  const metering = new SaasMeteringService(database);
  const normalSuccessSettlement = new DispatchUsageSettlementCoordinator(
    new SaasPricingService(database),
    new DurableNormalSuccessSettlementPort(database),
  );
  const leaseOptions: ProviderAccountLeaseServiceOptions = {
    database,
    maxConcurrency: options.maxConcurrency,
    leaseTtlMs: options.leaseTtlMs,
  };
  const leaseProvider = new PostgresProviderAccountLeaseService(leaseOptions);
  const unsealer = new GatewayProviderCredentialUnsealer(
    options.providerCredentialUnsealingKms,
    options.credentialContext,
  );
  const proofReader = new PostgresProviderSupplyRepository(database);
  const credentialResolver = new ProviderSupplyHttpCredentialResolver({
    proofReader,
    unsealer,
    resolveAuthenticationHeader: options.resolveAuthenticationHeader,
  });
  const transport = new ProviderHttpTransport({
    fetch: options.fetch,
    resolveDispatchProfile: createProviderDispatchProfileResolver(options),
    resolveCredential: credentialResolver.resolveCredential,
    endpointPolicy: options.endpointPolicy,
    ...(options.providerHttpTestAddressCapability === undefined
      ? {}
      : { testAddressCapability: options.providerHttpTestAddressCapability }),
    timeoutMs: options.timeoutMs,
  });
  const payload = createProviderPayloadCompiler(options);
  const keyService = new KeyService(database, {
    resolver: new PostgresSupplyProfileResolver(database),
  });

  return createManagedSaasGatewayComposition({
    authenticator: keyService,
    preparation: {
      caller: options.caller,
      entitlement: new PostgresRequestPreparationEntitlementAdapter(options.entitlement, byokEntitlements),
      authority,
      scheduler,
      payload,
      admission: createProductionIdempotencyAdmission(options.admission, idempotencyStore),
      attempt: options.attempt,
      transaction: database,
      compensation: options.compensation,
      signer,
      registrar: evidence as PreparedRequestEvidenceRegistrar,
    },
    preparationOptions: {
      evidenceVerifierKeyId: options.evidenceVerifierKeyId,
      idFactory: options.idFactory,
    },
    dispatch: {
      evidence: evidence as PreparedRequestEvidenceDispatchPort,
      metering,
      leaseProvider,
      transport,
      normalSuccessSettlement,
      runtimeHealthWriter: runtimeHealthStore,
    },
    lifecycle: {
      close: async () => {
        await options.providerCredentialUnsealingKms.close();
      },
    },
    maxBodyBytes: options.maxBodyBytes,
    entryPoint: options.entryPoint,
  });
}

/** Type-only aliases make the composition contract easy to inspect in tests. */
export type ManagedSaasGatewayRequestPreparationPort = RequestPreparationPort;
export type ManagedSaasGatewayDispatchPort = GatewayPreparedEvidenceDispatchPort;
