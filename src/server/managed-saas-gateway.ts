import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SaasBillingGroupsService } from '../saas/billing/groups/service.js';
import { createBillingGroupSpendResolution } from '../saas/billing/groups/spend-resolution.js';
import { SaasCatalogService } from '../saas/catalog/service.js';
import type { SaasDatabase } from '../saas/db/index.js';
import { BEDROCK_ENDPOINT } from '../saas/gateway/bedrock/catalog-identity.js';
import { CachedRequestPreparationAuthority } from '../saas/gateway/cached-request-preparation-authority.js';
import { CachedRequestPreparationEntitlement } from '../saas/gateway/cached-request-preparation-entitlement.js';
import { CachedSchedulerHints } from '../saas/gateway/cached-scheduler-hints.js';
import { CLAUDE_ENDPOINT, CLAUDE_MESSAGES_ENDPOINT } from '../saas/gateway/claude/catalog-identity.js';
import {
  MINIMAX_ENDPOINT,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_ENDPOINT,
} from '../saas/gateway/cn-providers/catalog-identity.js';
import {
  type CnProvidersProtocolRoutingConfig,
  cnProviderOperationForProtocol,
  resolveCnNativeProtocol,
  resolveCnProviderApiProtocol,
} from '../saas/gateway/cn-providers/protocol-rules.js';
import { cnProvidersProviderRequestTransform } from '../saas/gateway/cn-providers/transform.js';
import { cnProvidersFixedRequestHeaders } from '../saas/gateway/cn-providers/transport-headers.js';
import { CODEX_ENDPOINT } from '../saas/gateway/codex/catalog-identity.js';
import { SaasCommercialMeteringPolicyService } from '../saas/gateway/commercial-metering-policy-service.js';
import type { GatewayProtocol, ModelResolutionProvenance } from '../saas/gateway/contracts.js';
import {
  DispatchUsageSettlementCoordinator,
  type NormalSuccessSettlementPort,
} from '../saas/gateway/dispatch-usage-settlement.js';
import { FastGatewayExecutor, type FastGatewayExecutorPort } from '../saas/gateway/fast/executor.js';
import type { FastGatewayDiagnosticObserver } from '../saas/gateway/fast/failure-diagnostic.js';
import { createFastGatewayJournal } from '../saas/gateway/fast/journal.js';
import { FastPinnedConnectorPool } from '../saas/gateway/fast/pinned-connector-pool.js';
import { createPostgresFastGatewaySnapshotLoader } from '../saas/gateway/fast/postgres-snapshot-loader.js';
import { createFastGatewayReadiness } from '../saas/gateway/fast/readiness.js';
import {
  FastReceiptQueue,
  type FastReceiptQueueLimits,
  type FastReceiptQueueSnapshot,
} from '../saas/gateway/fast/receipt-queue.js';
import { openRedisFastGatewayAdmission } from '../saas/gateway/fast/redis-admission.js';
import { createRedisFastGatewaySnapshotCacheStore } from '../saas/gateway/fast/redis-snapshot-store.js';
import {
  createRuntimeFastGatewaySnapshotSource,
  fastGatewayModelCompatibility,
} from '../saas/gateway/fast/runtime-snapshot.js';
import { CachedFastGatewaySnapshots } from '../saas/gateway/fast/snapshots.js';
import { GEMINI_ENDPOINT } from '../saas/gateway/gemini/catalog-identity.js';
import { GROK_ENDPOINT } from '../saas/gateway/grok/catalog-identity.js';
import type { GrokCredentialResolver } from '../saas/gateway/grok/transport.js';
import type { ContentModerationPort, SaasGatewayReadinessProvider } from '../saas/gateway/http-handler.js';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort as GatewayPreparedEvidenceDispatchPort,
  isSaasGatewayInferenceRequest,
  type ModelDiscoveryPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
  rejectSaasGatewayCapacityRequest,
  type SaasGatewayAsyncMediaPort,
  type SaasGatewayHttpHandler,
  type SaasGatewayQueryPort,
} from '../saas/gateway/http-handler.js';
import { SaasGatewayAsyncImageMediaPort } from '../saas/gateway/images/async-image-media-port.js';
import { ImageResultOffloader } from '../saas/gateway/images/image-result-offloader.js';
import {
  IMAGE_TASK_EXECUTION_TIMEOUT_MS,
  IMAGE_TASK_TTL_MS,
  SaasImageTaskService,
  startImageTaskStuckSweeper,
} from '../saas/gateway/images/image-task-service.js';
import { PostgresImageTaskStore } from '../saas/gateway/images/image-task-store.js';
import { SaasGatewayImagesQueryPort } from '../saas/gateway/images/images-query-port.js';
import { createImagesMediaUsagePlan } from '../saas/gateway/images/media-usage-plan.js';
import { createSaasModelPlazaEndpoint, type SaasModelPlazaPort } from '../saas/gateway/model-plaza/endpoint.js';
import { ModelsDevOfficialPricingRegistry } from '../saas/gateway/model-plaza/official-pricing.js';
import { SaasModelPlazaService } from '../saas/gateway/model-plaza/service.js';
import { createModelPlazaSettingsProvider } from '../saas/gateway/model-plaza/settings.js';
import { PostgresModelPlazaFacts } from '../saas/gateway/model-plaza/store.js';
import { OPENCODE_GO_ENDPOINT, OPENCODE_GO_PROVIDER_ID } from '../saas/gateway/opencode-go/catalog-identity.js';
import {
  DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  isOpenCodeGoCrossResponsesRoute,
  type OpenCodeGoProtocolRule,
  openCodeGoProviderOperationForProtocol,
  resolveOpenCodeGoProtocol,
  resolveOpenCodeGoProtocolRulesFromConfig,
} from '../saas/gateway/opencode-go/protocol-rules.js';
import { openCodeGoFixedRequestHeaders } from '../saas/gateway/opencode-go/transport-headers.js';
import { createOpenRouterFixedRequestHeaders } from '../saas/gateway/openrouter/transport-headers.js';
import type { PostgresPreparationObserver } from '../saas/gateway/postgres-preparation-observer.js';
import { supportsPreparationTransactionFacts } from '../saas/gateway/postgres-preparation-ports.js';
import { PostgresProviderAccountModelCooldownRegistry } from '../saas/gateway/postgres-provider-account-model-cooldowns.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  ProviderAccountDispatchFailureFeedback,
  type ProviderAccountDispatchFailureFeedbackPort,
  ProviderAccountModelRateLimit,
  type ProviderAccountRuntimeHealthWriter,
} from '../saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { PostgresProviderAccountSchedulerOptions } from '../saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresProviderAccountScheduler } from '../saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresProviderEgressProxyResolver } from '../saas/gateway/postgres-provider-egress-proxy-resolver.js';
import {
  PostgresRequestPreparationAuthorityAdapter,
  type PostgresRequestPreparationAuthorityAdapterDependencies,
} from '../saas/gateway/postgres-request-preparation-authority-adapter.js';
import { PostgresRequestPreparationEntitlementAdapter } from '../saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import { PostgresProviderTlsFingerprintResolver } from '../saas/gateway/postgres-tls-fingerprint-profile-resolver.js';
import { GatewayPreDispatchCompensationService } from '../saas/gateway/pre-dispatch-compensation-service.js';
import {
  type PreparationFailureObserver,
  withPreparationFailureObserver,
} from '../saas/gateway/preparation-failure-observer.js';
import type { PreparedEvidenceDispatchObserver } from '../saas/gateway/prepared-evidence-dispatch-observer.js';
import {
  type PreparedEvidenceLeaseProvider,
  type PreparedEvidenceMeteringPort,
  type PreparedEvidenceTransport,
  SaasPreparedEvidenceDispatchError,
  SaasPreparedEvidenceDispatchService,
} from '../saas/gateway/prepared-evidence-dispatch-service.js';
import {
  type PreparedRequestEvidenceDispatchPort,
  type PreparedRequestEvidenceRegistrar,
  SaasPreparedRequestEvidenceService,
  type TrustedPreparedRequestVerifierKey,
} from '../saas/gateway/prepared-request-evidence-service.js';
import { PostgresProviderAccountLeaseService } from '../saas/gateway/provider-account-lease-service.js';
import type {
  ProviderAccountSchedulerAffinityPort,
  ProviderAccountSchedulerStickyWaitConfig,
  ProviderAccountSchedulerStrategiesOptions,
} from '../saas/gateway/provider-account-scheduler.js';
import {
  evaluateWindowCostSchedulability,
  getAccountWindowCostFactsBatch,
} from '../saas/gateway/provider-account-window-cost-gate.js';
import {
  createPinnedProviderHttpConnector,
  createPinnedProviderHttpTestConnectorFactory,
  isProviderHttpTestAddressCapability,
  type ProviderHttpEgressAllowlist,
  type ProviderHttpTestAddressCapability,
} from '../saas/gateway/provider-http-address.js';
import {
  createTlsFingerprintSidecarConnectorFactory,
  type ProviderTlsFingerprintEgress,
} from '../saas/gateway/provider-http-tls-fingerprint-connector.js';
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
  createRedisStickyProviderAccountAffinity,
  type RedisStickyAffinityOptions,
} from '../saas/gateway/redis-sticky-provider-account-affinity.js';
import { RequestDiagnosticTrace, withRequestDiagnosticTrace } from '../saas/gateway/request-diagnostic-trace.js';
import {
  type GatewayRequestIdempotencyClaimResult,
  GatewayRequestIdempotencyStore,
} from '../saas/gateway/request-idempotency.js';
import {
  allowRequestPreparation,
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
import { createNativeResponsesCompactRoutingTransport } from '../saas/gateway/responses-compact-transport.js';
import type { PersistentResponsesContinuationResolver } from '../saas/gateway/responses-continuation-resolver.js';
import { createResponsesWsServer } from '../saas/gateway/responses-ws-connection.js';
import { ResponsesWsEngine } from '../saas/gateway/responses-ws-engine.js';
import { createResponsesWsRoundExecutor, responsesWsProxyKey } from '../saas/gateway/responses-ws-executor.js';
import { SaasRouteConfigService } from '../saas/gateway/route-config-service.js';
import { VERTEX_ENDPOINT } from '../saas/gateway/vertex/catalog-identity.js';
import { GrokVideoUpstreamForwarder } from '../saas/gateway/videos/grok-video-upstream.js';
import { SaasVideoBillingStateMachine } from '../saas/gateway/videos/video-billing-state-machine.js';
import type { SaasGatewayVideoCreatePort } from '../saas/gateway/videos/video-create-port.js';
import { PersistentSaasGatewayVideoCreatePort } from '../saas/gateway/videos/video-create-port.js';
import { startVideoTaskRecoveryWorker, VideoTaskRecoveryWorker } from '../saas/gateway/videos/video-recovery-worker.js';
import { ReconciliationVideoSettlementPort } from '../saas/gateway/videos/video-settlement-port.js';
import { PostgresVideoTaskStore } from '../saas/gateway/videos/video-task-store.js';
import {
  createSaasGatewayQueryPortRouter,
  SaasGatewayVideosQueryPort,
} from '../saas/gateway/videos/videos-query-port.js';
import { createKeyBudgetResolution } from '../saas/keys/budget-resolution.js';
import { CachedKeyAuthenticator } from '../saas/keys/cached-authenticator.js';
import { PostgresSupplyProfileResolver } from '../saas/keys/resolver.js';
import { KeyService } from '../saas/keys/service.js';
import type { AuthenticatedApiKey } from '../saas/keys/types.js';
import {
  DurableConditionalSettlementPort,
  DurableNormalSuccessSettlementPort,
} from '../saas/metering/conditional-settlement-port.js';
import { SaasMeteringService } from '../saas/metering/service.js';
import { ByokServicePlanService } from '../saas/plans/service.js';
import {
  type PluginHostClient,
  type PluginRouteReader,
  PluginRoutingClaudeTransport,
} from '../saas/plugins/gateway-plugin-router.js';
import { SaasPricingService } from '../saas/pricing/service.js';
import { type ModerationEmailSender, SaasContentModerationService } from '../saas/risk/moderation.js';
import { PostgresContentModerationStore } from '../saas/risk/postgres-store.js';
import type { GatewayProviderEvidenceTransportFactory } from '../saas/runtime/builtin-provider-transports.js';
import { createGatewayCapabilityAdvertisementPolicy } from '../saas/runtime/gateway-capability-advertisement.js';
import type { GatewayCapabilityReadiness } from '../saas/runtime/gateway-capability-readiness.js';
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
import type { RedisRuntimeCache } from '../saas/runtime/redis-concurrency-slots.js';
import {
  type RequestPreparationSigner,
  RequestPreparationSignerAdapter,
} from '../saas/runtime/request-preparation-signer-adapter.js';
import { PostgresProviderSupplyRepository } from '../saas/supply/repository.js';
import { createCustomerWebhookEventProducer } from '../saas/webhooks/producers.js';
import { S3ObjectClient, type S3ObjectClientConfig } from '../storage/s3-object-client.js';

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
  /** Stop new admission before awaiting active handler-to-queue handoffs. */
  stopAdmission?(): void;
  /** Optional bounded handoff wait. Timeout reports failure without closing financial resources. */
  readonly handoffTimeoutMs?: number;
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
  readonly observer?: PreparedEvidenceDispatchObserver;
  readonly evidence: PreparedRequestEvidenceDispatchPort;
  readonly metering: PreparedEvidenceMeteringPort;
  readonly leaseProvider: PreparedEvidenceLeaseProvider;
  readonly transport: PreparedEvidenceTransport;
  readonly normalSuccessSettlement?: NormalSuccessSettlementPort;
  /** Installed by the production composition; tests may supply a recording fake. */
  readonly runtimeHealthWriter?: ProviderAccountRuntimeHealthWriter;
  /**
   * H5c (R9 bench finding P8): in-process dispatch failure feedback installed
   * by the production composition. Optional; absent keeps dispatch unchanged.
   */
  readonly dispatchFailureFeedback?: ProviderAccountDispatchFailureFeedbackPort;
  /**
   * Batch 2.3: the model-level rate limit registry. A model-not-found 404
   * or plan-gated 400 cools the (account, model) pair for 30 minutes while
   * the account stays schedulable for other models. Core-plan 9.1: the
   * record may be promise-returning (the durable registry) and is awaited.
   */
  readonly modelRateLimit?: {
    recordModelRateLimit(input: {
      readonly candidate: import('../saas/gateway/postgres-provider-account-runtime-health-store.js').ProviderAccountRuntimeHealthCandidate;
      readonly model: string;
    }): void | Promise<void>;
  };
}

/**
 * Required graph input for the low-level builder. It accepts ports, not an
 * already assembled HTTP handler, so the builder owns construction of the
 * preparation service, dispatch service, and HTTP boundary.
 */
/**
 * Roadmap batch 4 §4.2 (task #16): the async image media binding. The
 * resolved S3 config is injected by the deployment runtime (the
 * egress-proxy credential convention — plaintext never lives in a column;
 * a sealed platform-settings surface is the recorded follow-up).
 */
export interface SaasGatewayImageMediaOptions {
  /** Zero-dep S3-compatible storage config (endpoint/bucket/region/keys/path style/public base URL). */
  readonly s3: S3ObjectClientConfig;
  /** Object key prefix for offloaded images; default `images/`. */
  readonly keyPrefix?: string;
  /** Task TTL; default 24 h. */
  readonly taskTtlMs?: number;
  /** Execution timeout; default 30 min. */
  readonly executionTimeoutMs?: number;
  /** Sync-path JSON keepalive heartbeat cadence; default 0 (disabled). */
  readonly keepaliveIntervalMs?: number;
  /**
   * G-A1: the stuck-task sweep timer (processing rows past the execution
   * timeout → failed). Default ON whenever imageMedia is wired — a dead
   * worker's rows must terminate without a client poll. `disabled: true`
   * opts out (single-process deployments that prefer manual sweeps).
   */
  readonly stuckSweep?: {
    readonly disabled?: boolean;
    readonly intervalMs?: number;
    readonly limit?: number;
  };
}

export interface ManagedSaasGatewayCompositionDependencies {
  readonly fastGateway?: FastGatewayExecutorPort;
  readonly fastGatewayDiagnostic?: FastGatewayDiagnosticObserver;
  readonly continuationHistoryResolver?: PersistentResponsesContinuationResolver;
  /** Opt-in diagnostic sampling. Observer must enqueue without blocking or awaiting persistence. */
  readonly requestDiagnostics?: {
    readonly select: (requestId: string) => boolean;
    readonly observe: (sample: {
      readonly requestId: string;
      readonly trace: ReturnType<RequestDiagnosticTrace['snapshot']>;
    }) => void;
  };
  /**
   * Override the built-in per-connection Responses round executor. The
   * default refreshes authentication and runs preparation, admission,
   * dispatch and settlement for every response.create.
   */
  readonly responsesWsRoundExecutor?: import('../saas/gateway/responses-ws-engine.js').ResponsesWsRoundExecutor;
  readonly responsesWsLimits?: import('../saas/gateway/responses-ws-connection.js').ResponsesWsConnectionLimits;
  readonly responsesCompactNativeSupply?: (model: string) => boolean;
  /**
   * G-C1: the readiness authority for GET /readyz. The production
   * composition builds a PG-backed provider when unset; absent entirely
   * answers the process-only payload.
   */
  readonly readiness?: SaasGatewayReadinessProvider;
  /** Fresh commercial advertisement authority; absent closes customer model lists with 503. */
  readonly capabilityReadiness?: () => Promise<GatewayCapabilityReadiness>;
  readonly authenticator: ProxyKeyAuthenticator;
  readonly capacityCompletion?: (requestId: string) => Promise<void>;
  readonly preparation: ManagedSaasGatewayPreparationDependencies;
  readonly preparationFailureObserver?: PreparationFailureObserver;
  readonly preparationOptions: {
    readonly evidenceVerifierKeyId: string;
    readonly idFactory: RequestPreparationIdFactory;
    readonly observe?: PostgresPreparationObserver;
  };
  readonly dispatch: ManagedSaasGatewayDispatchDependencies;
  readonly lifecycle: ManagedSaasGatewayLifecycle;
  /** Optional process-local inference cap; unset disables early HTTP backpressure. */
  readonly maxHttpInFlight?: number;
  readonly maxBodyBytes: number;
  readonly entryPoint: string;
  /** Trusted reverse-proxy CIDRs for client address resolution; empty means socket peer only. */
  readonly trustedProxyCidrs?: readonly string[];
  /**
   * Roadmap batch 4 §4.2 (task #16): the async image task media binding —
   * the object-storage config plus task lifecycle tuning. Absent keeps the
   * async images endpoints and the task query route closed (503).
   */
  readonly imageMedia?: SaasGatewayImageMediaOptions & {
    /** Built by the production composition; the plain composition accepts them pre-built. */
    readonly queryEndpoints: SaasGatewayQueryPort;
    readonly asyncMedia: SaasGatewayAsyncMediaPort;
  };
  /**
   * Roadmap batch 4 §4.3 (task #17): the async video media binding —
   * built by the production composition; the plain composition accepts
   * the ports pre-built. Absent keeps the video create endpoints closed
   * (503) and the video query routes unrouted (503).
   */
  readonly videoMedia?: {
    readonly queryEndpoints: SaasGatewayQueryPort;
    readonly videoCreate: SaasGatewayVideoCreatePort;
  };
  /**
   * Roadmap batch 2 §2.1: enable the sticky-session scheduling seam at the
   * HTTP boundary. Only compositions that wire an account scheduler with
   * affinity binding (the managed production gateway always does) may set
   * this; default false keeps preparation input byte-identical.
   */
  readonly stickyScheduling?: boolean;
  /**
   * Model plaza port (roadmap batch 5 §5.5, task #22): the read-only
   * GET /v1/model-plaza showcase. Absent keeps the endpoint closed (503).
   */
  readonly modelPlaza?: SaasModelPlazaPort;
  /**
   * Content risk control (roadmap batch 5 §5.4, task #19): the post-auth,
   * pre-preparation moderation seam. Absent keeps the gateway without risk
   * control (the request path is byte-identical).
   */
  readonly contentModeration?: ContentModerationPort;
}

export interface ManagedSaasGatewayComposition {
  readonly handler: SaasGatewayHttpHandler;
  /** Node's upgrade listener must forward the original head bytes here. */
  readonly handleUpgrade: (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => boolean;
  readonly preparation: RequestPreparationPort;
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

function createModelDiscoveryPort(
  preparation: ManagedSaasGatewayPreparationDependencies,
  capabilityReadiness: ManagedSaasGatewayCompositionDependencies['capabilityReadiness'],
): ModelDiscoveryPort {
  return {
    async list(authenticatedCaller, purpose) {
      let canAdvertise: ReturnType<typeof createGatewayCapabilityAdvertisementPolicy> | undefined;
      if (purpose === 'advertisement') {
        if (!capabilityReadiness) throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
        canAdvertise = createGatewayCapabilityAdvertisementPolicy(await capabilityReadiness());
      }
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
        if (
          canAdvertise &&
          !canAdvertise({
            providerId: authority.candidate.providerId,
            productId: authority.candidate.productId,
            endpoint: authority.route.endpoint,
          })
        )
          continue;
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
  if (dependencies.maxHttpInFlight !== undefined) requirePositiveInteger(dependencies.maxHttpInFlight);
  requireText(dependencies.entryPoint);
  if (dependencies.responsesWsRoundExecutor !== undefined)
    requireDependency(dependencies.responsesWsRoundExecutor, 'executeRound');
  if (dependencies.responsesCompactNativeSupply !== undefined)
    requireCallable(dependencies.responsesCompactNativeSupply);
  requireDependency(dependencies.lifecycle, 'close');
  if (dependencies.videoMedia !== undefined) {
    requireDependency(dependencies.videoMedia.queryEndpoints, 'serve');
    requireDependency(dependencies.videoMedia.videoCreate, 'registerCreate');
  }
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
  const runWithDiagnostics = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    let selected = false;
    try {
      selected = dependencies.requestDiagnostics?.select(id) === true;
    } catch {
      /* Diagnostic only. */
    }
    if (!selected) return work();
    const trace = new RequestDiagnosticTrace();
    return withRequestDiagnosticTrace(trace, async () => {
      try {
        return await work();
      } finally {
        // No await, queue flush, or persistent write in the request path.
        try {
          dependencies.requestDiagnostics?.observe({ requestId: id, trace: trace.snapshot() });
        } catch {
          /* Diagnostic failure cannot change a financial outcome. */
        }
      }
    });
  };
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
  const preparation = withPreparationFailureObserver(
    new SaasRequestPreparationService(dependencies.preparation, {
      evidenceVerifierKeyId: dependencies.preparationOptions.evidenceVerifierKeyId,
      idFactory: requestScopedIdFactory,
      ...(dependencies.preparationOptions.observe ? { observe: dependencies.preparationOptions.observe } : {}),
    }),
    dependencies.preparationFailureObserver,
  );
  const dispatch = new SaasPreparedEvidenceDispatchService(
    dependencies.dispatch.evidence,
    dependencies.dispatch.metering,
    dependencies.dispatch.leaseProvider,
    dependencies.dispatch.transport,
    dependencies.dispatch.normalSuccessSettlement,
    dependencies.dispatch.runtimeHealthWriter,
    dependencies.dispatch.dispatchFailureFeedback,
    dependencies.dispatch.modelRateLimit,
    dependencies.dispatch.observer,
  );
  /*
   * G-B4: the Responses WebSocket surface. The connection layer's upgrade
   * auth rides the composition's key authenticator (Authorization: Bearer
   * / x-api-key on the upgrade request); every round then replays the
   * full gateway chain through the default request-bound executor.
   */
  const preDispatchCompensation = new GatewayPreDispatchCompensationService(
    dependencies.preparation.transaction,
    dependencies.preparation.compensation,
  );
  const responsesWs = createResponsesWsServer({
    authenticate: async (upgradeRequest: import('node:http').IncomingMessage) => {
      // The same key extraction the HTTP boundary uses: Authorization
      // Bearer or x-api-key on the upgrade request itself.
      const rawKey = responsesWsProxyKey(upgradeRequest);
      if (rawKey === null) return { ok: false, reason: 'unauthenticated' };
      try {
        const caller = await dependencies.authenticator.authenticate(rawKey);
        return caller !== null ? { ok: true } : { ok: false, reason: 'unauthenticated' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    createEngine: (upgradeRequest) =>
      new ResponsesWsEngine({
        executor:
          dependencies.responsesWsRoundExecutor ??
          createResponsesWsRoundExecutor({
            ...(dependencies.continuationHistoryResolver
              ? { continuationHistoryResolver: dependencies.continuationHistoryResolver }
              : {}),
            request: upgradeRequest,
            authenticator: dependencies.authenticator,
            preparation,
            dispatch,
            compensation: preDispatchCompensation,
            entryPoint: dependencies.entryPoint,
            maxBodyBytes: dependencies.maxBodyBytes,
            trustedProxyCidrs: dependencies.trustedProxyCidrs,
            contentModeration: dependencies.contentModeration,
            runWithRequestId: (roundRequestId, work) =>
              requestIdContext.run(roundRequestId, () =>
                runWithDiagnostics(roundRequestId, async () => {
                  try {
                    return await work();
                  } finally {
                    await dependencies.capacityCompletion?.(roundRequestId).catch(() => {});
                  }
                }),
              ),
          }),
        send: () => {},
        close: () => {},
        idFactory: requestId,
      }),
    ...(dependencies.responsesWsLimits ? { limits: dependencies.responsesWsLimits } : {}),
  });
  const httpHandler = createSaasGatewayHandler({
    ...(dependencies.fastGateway ? { fastGateway: dependencies.fastGateway } : {}),
    ...(dependencies.fastGatewayDiagnostic ? { fastGatewayDiagnostic: dependencies.fastGatewayDiagnostic } : {}),
    ...(dependencies.continuationHistoryResolver
      ? { continuationHistoryResolver: dependencies.continuationHistoryResolver }
      : {}),
    authenticator: dependencies.authenticator,
    preparation,
    dispatch,
    preDispatchCompensation,
    modelDiscovery: createModelDiscoveryPort(dependencies.preparation, dependencies.capabilityReadiness),
    maxBodyBytes: dependencies.maxBodyBytes,
    entryPoint: dependencies.entryPoint,
    trustedProxyCidrs: dependencies.trustedProxyCidrs,
    ...(dependencies.readiness ? { readiness: dependencies.readiness } : {}),
    ...(responsesWs !== undefined ? { responsesWs } : {}),
    ...(dependencies.responsesCompactNativeSupply
      ? { responsesCompactNativeSupply: dependencies.responsesCompactNativeSupply }
      : {}),
    ...(dependencies.stickyScheduling ? { stickyScheduling: true } : {}),
    ...(dependencies.modelPlaza ? { modelPlaza: dependencies.modelPlaza } : {}),
    ...(dependencies.contentModeration ? { contentModeration: dependencies.contentModeration } : {}),
    ...(dependencies.imageMedia
      ? {
          asyncMedia: dependencies.imageMedia.asyncMedia,
          asyncExecutionTimeoutMs: dependencies.imageMedia.executionTimeoutMs,
          ...(dependencies.imageMedia.keepaliveIntervalMs
            ? { imageKeepaliveIntervalMs: dependencies.imageMedia.keepaliveIntervalMs }
            : {}),
        }
      : {}),
    /*
     * §4.0 ③ (task #14) + §4.3 (task #17): the query-endpoint family composes
     * through an explicit route router — the images port serves
     * images.task_status, the videos port serves the two video routes; a
     * route without a port fails closed with 503. A videoMedia binding
     * without imageMedia (and vice versa) keeps the other family closed.
     */
    ...(dependencies.imageMedia || dependencies.videoMedia
      ? {
          queryEndpoints: createSaasGatewayQueryPortRouter({
            ...(dependencies.imageMedia ? { 'images.task_status': dependencies.imageMedia.queryEndpoints } : {}),
            ...(dependencies.videoMedia
              ? {
                  'videos.task_status': dependencies.videoMedia.queryEndpoints,
                  'videos.task_content': dependencies.videoMedia.queryEndpoints,
                }
              : {}),
          }),
        }
      : {}),
    ...(dependencies.videoMedia ? { videoCreate: dependencies.videoMedia.videoCreate } : {}),
  });
  const pendingHttpHandlers = new Set<Promise<boolean>>();
  const maxHttpInFlight = dependencies.maxHttpInFlight;
  let httpInFlight = 0;
  let closing = false;
  const handler: SaasGatewayHttpHandler = (req, res) => {
    const currentRequestId = requestId();
    if (closing && isSaasGatewayInferenceRequest(req)) {
      rejectSaasGatewayCapacityRequest(req, res, currentRequestId);
      return Promise.resolve(true);
    }
    let limited = false;
    if (maxHttpInFlight !== undefined && isSaasGatewayInferenceRequest(req)) {
      if (httpInFlight >= maxHttpInFlight) {
        rejectSaasGatewayCapacityRequest(req, res, currentRequestId);
        return Promise.resolve(true);
      }
      httpInFlight += 1;
      limited = true;
    }
    let pending: Promise<boolean>;
    try {
      pending = requestIdContext
        .run(currentRequestId, () =>
          runWithDiagnostics(currentRequestId, () => httpHandler(req, res, { requestId: currentRequestId })),
        )
        .finally(async () => {
          await dependencies.capacityCompletion?.(currentRequestId).catch(() => {});
        });
    } catch (error) {
      if (limited) httpInFlight -= 1;
      throw error;
    }
    pendingHttpHandlers.add(pending);
    const settled = () => {
      pendingHttpHandlers.delete(pending);
      if (limited) httpInFlight -= 1;
    };
    // Response EOF/close and client abort can precede financial cleanup.
    // Retain the permit and the original drain promise until the handler settles.
    void pending.then(settled, settled);
    return pending;
  };
  const close = closeOnce({
    close: async () => {
      closing = true;
      dependencies.lifecycle.stopAdmission?.();
      await responsesWs.close();
      // The listener owner stops new requests before closing this composition.
      // HTTP EOF can precede settlement and fenced lease cleanup.
      if (dependencies.lifecycle.handoffTimeoutMs !== undefined && pendingHttpHandlers.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...pendingHttpHandlers]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('FAST_RECEIPT_HANDOFF_TIMEOUT')),
                dependencies.lifecycle.handoffTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        while (pendingHttpHandlers.size > 0) await Promise.allSettled([...pendingHttpHandlers]);
      }
      await dependencies.lifecycle.close();
    },
  });
  return Object.freeze({ handler, handleUpgrade: responsesWs.handleUpgrade, preparation, dispatch, close });
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
  readonly providerRequestTransform?: import('../saas/gateway/provider-payload-compiler.js').ProviderRequestTransform;
}

export interface ManagedSaasFastGatewayOptions {
  readonly mode: 'reserved-max';
  readonly redisUrl: string;
  readonly namespace: string;
  /** Stable instance identity; each journal boot fences its prior allocation epoch. */
  readonly allocationOwner: string;
  /** Explicit value is a hard cap; absent selects wallet-backed automatic liquidity sizing. */
  readonly allocationTrancheMinorUnits?: string;
  readonly allocationStripes?: number;
  /** Group-commit admission window in ms; 0/undefined keeps single-statement reserves. */
  readonly reserveBatchWindowMs?: number;
  /** Maximum rows per group-commit reserve statement (1..32, default 16). */
  readonly reserveBatchMaxRows?: number;
  /** Global queued-reserve cap before admissions fall back to direct statements. */
  readonly reserveBatchMaxQueue?: number;
  /** Only a proven fresh/drained deployment may bypass conservative Redis restart quarantine. */
  readonly redisDrained?: boolean;
  /** Optional AES-256 deployment key enables encrypted shared L2; no plaintext credential values. */
  readonly snapshotEncryptionKey?: Uint8Array;
  /** Pinned direct-HTTPS reuse defaults on inside opt-in fast mode; false is the rollback control. */
  readonly reuseConnections?: boolean;
  /** memory-queue explicitly trades final evidence durability at terminal for lower tail latency. */
  readonly receiptMode?: 'durable' | 'memory-queue';
  readonly receiptQueue?: FastReceiptQueueLimits;
}

export interface ManagedSaasGatewayProductionOptions {
  /** Activated by the private supervisor startup gate, never supplied by a request or runtime module. */
  readonly boundedGatewayOwner?: import('../saas/gateway/fast/bounded-deployment-budget.js').BoundedOwnerActivation;
  readonly fastReceiptQueueObserver?: (snapshot: FastReceiptQueueSnapshot) => void;
  readonly fastGateway?: ManagedSaasFastGatewayOptions;
  readonly fastGatewayDiagnostic?: FastGatewayDiagnosticObserver;
  readonly continuationHistoryResolver?: PersistentResponsesContinuationResolver;
  readonly requestDiagnostics?: ManagedSaasGatewayCompositionDependencies['requestDiagnostics'];
  readonly capacityCompletion?: (requestId: string) => Promise<void>;
  /** Optional process-local inference cap; unset disables early HTTP backpressure. */
  readonly maxHttpInFlight?: number;
  readonly preparationObserver?: PostgresPreparationObserver;
  readonly preparationFailureObserver?: PreparationFailureObserver;
  readonly dispatchObserver?: PreparedEvidenceDispatchObserver;
  readonly capabilityReadiness?: () => Promise<GatewayCapabilityReadiness>;
  /** Native compact target with the same evidence-bound credential proof. */
  readonly responsesCompactEvidenceTransport?: PreparedEvidenceTransport;
  readonly providerEvidenceTransports?: GatewayProviderEvidenceTransportFactory;
  readonly providerNativeProtocol?: (
    providerId: string,
    productId: string,
    model: string,
    clientProtocol: GatewayProtocol,
  ) => GatewayProtocol;
  readonly responsesCompactNativeSupply?: (model: string) => boolean;
  readonly responsesWsLimits?: import('../saas/gateway/responses-ws-connection.js').ResponsesWsConnectionLimits;
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
  /**
   * R9 §4 P1: operator-configured provider egress allowlist. Validated CIDR
   * entries that additionally permit dispatch to otherwise-denied provider
   * and egress-proxy addresses (container-network deployments: Docker 172.x,
   * k8s services, private VPCs). Unset keeps the exact global-only
   * fail-closed posture for every existing deployment.
   */
  readonly providerHttpEgressAllowlist?: ProviderHttpEgressAllowlist;
  /**
   * P1c: the codex transport (CodexPreparedEvidenceTransport). When set,
   * prepared evidence routed to the codex catalog endpoint is dispatched
   * through it instead of the generic provider HTTP transport.
   */
  readonly codexEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Dispatch seam for the Claude Code subscription transport
   * (ClaudePreparedEvidenceTransport). When set, prepared evidence whose
   * signed endpoint scope is the Claude catalog endpoint (`claude-messages`,
   * provider protocol `anthropic`) is dispatched through it instead of the
   * generic provider HTTP transport — the direct analog of
   * `codexEvidenceTransport`. Unset keeps claude traffic on the generic
   * transport path unchanged.
   */
  readonly claudeEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Batch-5 §5.1 plugin routing dependencies. When set (gateway deployment
   * with MODEL_ROUTER_SAAS_PLUGIN_HOST_URL + the shared internal token), the
   * claude route is wrapped by PluginRoutingClaudeTransport; unset keeps the
   * native claude path byte-identical.
   */
  readonly pluginRouting?: {
    readonly routeReader: PluginRouteReader;
    readonly pluginHostClient: PluginHostClient;
  };
  /**
   * Dispatch seam for the Gemini CLI subscription transport
   * (GeminiPreparedEvidenceTransport). When set, prepared evidence whose
   * signed endpoint scope is the Gemini catalog endpoint
   * (`gemini-generate-content`, provider protocol `gemini`) is dispatched
   * through it instead of the generic provider HTTP transport — the direct
   * analog of `codexEvidenceTransport`. Unset keeps gemini traffic on the
   * generic transport path unchanged.
   */
  readonly geminiEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * R5b-2: multi-protocol adaptive routing for the OpenCode Go subscription
   * pool. For prepared requests whose authority candidate is the `opencode-go`
   * provider, the provider protocol is re-derived per request from the
   * normalized, post-modelMap resolved model id via the protocol rule table —
   * after modelMap resolution and before payload compilation and endpoint
   * signing, exactly the plan §R5b task #22 contract. The derivation is
   * applied consistently at two layers (the authority route facts that the
   * signed evidence statement carries, and the payload-compile route), so the
   * two can never disagree and `validatePayload` always matches. The
   * per-protocol dispatch key is the signed endpoint scope `opencode-go-zen`
   * plus the signed `providerProtocol` (the same pair the codex split keys
   * on); the generic transport's provider-target bindings then select the
   * upstream URL per protocol. When this option is unset the built-in default
   * table applies, so the feature is live for any deployment that routes
   * `opencode-go` traffic; every other provider keeps its exact previous
   * behavior.
   */
  readonly opencodeGoProtocolRouting?: {
    /**
     * Explicit resolved rule table; omitted → fall through to `config`, then
     * the built-in default table. An empty array intentionally routes
     * everything to Chat Completions.
     */
    readonly rules?: readonly OpenCodeGoProtocolRule[];
    /**
     * Raw provider-config value for the rule table — the migration-108
     * `protocol_rules` JSONB column (or the sub2api credentials-map wrapper).
     * Used only when `rules` is unset; absent or malformed values fall back to
     * the built-in default table (sub2api semantics).
     */
    readonly config?: unknown;
  };
  /**
   * F3: how a Responses-routed OpenCode Go model is served to a non-responses
   * client. `'bridge'` (default) compiles the request through the real
   * generic Responses bridge (gateway/responses-bridge: chat.completions /
   * Anthropic Messages → Responses). `'restrict'` restores the R5b-4
   * fail-closed gate — responses-routed models then require a `responses`
   * client protocol and every other client protocol is blocked with the
   * capability-style error — for operators who prefer the restrictive
   * posture. Non-OpenCode-Go providers are never affected by this option.
   */
  readonly opencodeGoCrossResponsesRouting?: 'bridge' | 'restrict';
  /**
   * R5b-2 mount point: when set, prepared evidence whose signed endpoint
   * scope is the OpenCode Go catalog endpoint (`opencode-go-zen`, any of the
   * three native provider protocols) is dispatched through this transport
   * instead of the generic provider HTTP transport — the direct analog of
   * `codexEvidenceTransport`. Unset keeps OpenCode Go traffic on the generic
   * transport, which already serves all three protocols via per-protocol
   * provider-target bindings.
   */
  readonly opencodeGoEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Batch-3 dispatch seam for the CN-provider category adapter
   * (CnProvidersPreparedEvidenceTransport — a classifying decorator over the
   * generic transport). When set, prepared evidence whose signed endpoint
   * scope is a CN-provider catalog endpoint (`zhipu-glm`,
   * `zhipu-glm-coding`, `minimax-m`, any provider protocol) is dispatched
   * through it instead of the generic provider HTTP transport directly. The
   * adapter delegates the actual send to the generic transport (URL,
   * credential, egress proxy, TLS fingerprint, usage observation all stay
   * its job) and adds the bounded error-body classification a payg
   * insufficient-balance 429 needs to reach the failure-feedback layer as
   * `insufficient-balance` instead of the status-only `rate-limited`
   * fallback. Unset keeps CN-provider traffic on the generic transport with
   * the status-only classification.
   */
  readonly cnProvidersEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Batch-3 CN-provider adaptive protocol routing (the opencode-go
   * `opencodeGoProtocolRouting` shape): the per-provider api_protocol the
   * authority decorator and payload-compile layer resolve the native
   * protocol from. Explicit map first, then the lenient config value (the
   * migration-120 account columns read through the runtime module or the
   * sub2api credentials-map wrapper), then the adaptive default (the native
   * endpoint follows the inbound client protocol).
   */
  readonly cnProvidersProtocolRouting?: CnProvidersProtocolRoutingConfig;
  /**
   * Batch-3 dispatch seam for the Grok category transport
   * (GrokPreparedEvidenceTransport). When set, prepared evidence whose signed
   * endpoint scope is the Grok catalog endpoint (`grok-responses`, provider
   * protocol `responses`) is dispatched through it instead of the generic
   * provider HTTP transport — the direct analog of `codexEvidenceTransport`.
   * Unset keeps grok traffic on the generic transport path unchanged.
   */
  readonly grokEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Batch-3 dispatch seam for the Bedrock category transport
   * (BedrockPreparedEvidenceTransport). When set, prepared evidence whose
   * signed endpoint scope is the Bedrock catalog endpoint
   * (`bedrock-invoke`, provider protocol `anthropic`) is dispatched through
   * it instead of the generic provider HTTP transport — the direct analog
   * of `codexEvidenceTransport`. Bedrock cannot ride the generic transport:
   * SigV4 signing, the InvokeModel request-body transform and the binary
   * EventStream decoding all live inside the category transport. Unset
   * keeps bedrock traffic undispatchable (no catalog route exists yet).
   */
  readonly bedrockEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Batch-3 dispatch seam for the Vertex AI service-account category
   * transport (VertexPreparedEvidenceTransport). When set, prepared
   * evidence whose signed endpoint scope is the Vertex catalog endpoint
   * (`vertex-raw-predict`, provider protocol `anthropic` OR `gemini` — the
   * scope covers both the Anthropic-on-Vertex rawPredict family and the
   * Gemini-on-Vertex generateContent family) is dispatched through it
   * instead of the generic provider HTTP transport — the direct analog of
   * `geminiEvidenceTransport`. The transport authenticates with the
   * service-account JWT→OAuth Bearer token, so it cannot ride the generic
   * transport's static-header resolver. Unset keeps vertex traffic
   * undispatchable (no catalog route exists yet).
   */
  readonly vertexEvidenceTransport?: PreparedEvidenceTransport;
  /**
   * Roadmap batch 4 §4.2 (task #16): the async image media binding — S3
   * config plus task lifecycle tuning. Absent keeps the async images
   * endpoints and the task query route closed (503). The resolved secret
   * supply is the deployment runtime module's concern (the egress-proxy
   * credential convention).
   */
  readonly imageMedia?: SaasGatewayImageMediaOptions;
  /**
   * Model plaza (roadmap batch 5 §5.5, task #22): the settings overlay
   * source (store-first; the deployment resolves what its database role can
   * read). Absent resolves the plaza switches from the environment only.
   */
  readonly modelPlazaSettingsOverlay?: () => Promise<Readonly<Record<string, unknown>>>;
  /**
   * Model plaza console-session validation for the session tier. Absent
   * degrades presented session credentials to the anonymous view (the
   * split-gateway deployment holds no saas_sessions grant).
   */
  readonly modelPlazaSessionAuth?: {
    readonly getSession: (token: string) => Promise<{ readonly userId: string } | null>;
  };
  /**
   * Content risk control (roadmap batch 5 §5.4, task #19): optional email
   * sender (violation / account-disabled notices) and site name for the
   * moderation service. The moderation store is always the gateway database
   * (fail-open on any store failure); absent sender skips emails.
   */
  readonly riskControl?: {
    readonly emailSender?: ModerationEmailSender;
    readonly siteName?: string;
  };
  /**
   * Roadmap batch 4 §4.3 (task #17): the async video media binding — the
   * bound-account status/content forwarder plus task lifecycle tuning.
   * Absent keeps the POST /v1/videos* create endpoints and the video
   * query routes closed (503). The credential resolver is the batch-3
   * Grok transport's contract (SSRF hard gate enforced by the forwarder).
   */
  readonly videoMedia?: {
    /** Undici-compatible fetch the status/content lookups dial. */
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    /** The batch-3 Grok credential resolver (oauth / api-key accounts). */
    readonly resolveCredential: GrokCredentialResolver;
    /** Credential-kind-scoped base override (tests / custom api-key upstreams). */
    readonly baseUrl?: string;
    /** Operator allowlist of custom base hosts for api-key credentials. */
    readonly operatorHostAllowlist?: readonly string[];
    /** Task TTL; default 24 h (the sub2api pending-billing TTL). */
    readonly taskTtlMs?: number;
    /** Upstream lookup timeout; default 120 s. */
    readonly timeoutMs?: number;
    /** In-memory ceiling for one proxied content response; default 64 MiB. */
    readonly maxContentBytes?: number;
    /**
     * G-A1: the no-client-poll video recovery loop (migration 132 lease
     * columns + the recovery worker). Default ON whenever videoMedia is
     * wired — pending billing must settle even if the client never polls
     * again. `disabled: true` opts out (single-process test deployments).
     */
    readonly recovery?: {
      readonly disabled?: boolean;
      readonly intervalMs?: number;
      readonly batchSize?: number;
      readonly leaseMs?: number;
      readonly maxPollFailures?: number;
      readonly interTaskDelayMs?: number;
    };
  };
  /**
   * F6 (task #39): OpenRouter supplier-attribute headers (`HTTP-Referer` /
   * `X-Title`). When set, the values are mounted on the generic transport's
   * fixed-request-header resolver for every request whose signed endpoint
   * scope is `openrouter-api`, on top of the R5b-4 OpenCode Go
   * anthropic-version rule. Unset keeps the default attribution
   * (`X-Title: model-router`, no referer); every other provider keeps its
   * exact previous header set either way.
   */
  readonly openRouterAttribution?: {
    /** The deployment's public site URL (`HTTP-Referer`); omitted when unset. */
    readonly referer?: string;
    /** App name (`X-Title`); defaults to 'model-router'. */
    readonly title?: string;
  };
  readonly providerCredentialUnsealingKms: ProviderCredentialUnsealingKms;
  readonly credentialContext: GatewayProviderCredentialUnsealerOptions;
  /**
   * R3 egress proxies: when enabled, the composition resolves each claimed
   * account's bound egress proxy (shared lookup with the OAuth refresh
   * worker) and tunnels the provider request through it. Unset keeps the
   * exact pre-R3 direct-egress behavior — the escape hatch for deployments
   * that have not yet re-applied the roles template after migration 107.
   */
  readonly egressProxyResolution?: { readonly enabled?: boolean };
  /**
   * Batch-2 §2.4 TLS fingerprints: when enabled, the composition resolves
   * each claimed account's bound TLS-fingerprint profile (migration 116,
   * fail-open posture) and mounts the sidecar connector factory on the
   * generic transport. The sidecar process itself is deployment-managed
   * (compose/systemd); the gateway only connects to the Unix socket.
   * Unset keeps the exact pre-116 connector behavior.
   */
  readonly tlsFingerprintResolution?: {
    readonly enabled?: boolean;
    /** The sidecar's Unix socket path. */
    readonly sidecarSocketPath: string;
  };
  /**
   * F3: when enabled, settlement terminal commits and terminal request
   * failures enqueue customer webhook events inside their own transactions.
   */
  readonly customerWebhooks?: { readonly enabled?: boolean };
  readonly resolveAuthenticationHeader: ProviderSupplyHttpAuthenticationHeaderResolver;
  readonly fetch: ProviderHttpFetch;
  readonly endpointPolicy: ProviderHttpEndpointPolicy;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly leaseTtlMs: number;
  /**
   * R7 scheduling-strategy toggles (plan §R7). Optional and default-off, so
   * the default account-selection order is byte-identical to the pre-R7
   * behavior; operators enable individual strategies per deployment.
   */
  readonly schedulerStrategies?: ProviderAccountSchedulerStrategiesOptions;
  /**
   * Core-plan 9.2: the bounded sticky-wait budget. Optional and default-OFF:
   * when absent, a busy sticky target behaves exactly as before (invalidated
   * as stale → load balancing). When set, a busy-but-schedulable sticky
   * target holds the session's binding and waits up to `maxWaitMs`
   * (recommended initial 2000) for a free lease slot, with a per-target
   * in-process waiter queue (`maxQueueLength`) and re-check tick (`tickMs`);
   * expiry answers 429 + Retry-After (values are initial suggestions, to be
   * frozen after load testing per plan §9.2 — no durable state involved).
   */
  readonly schedulerStickyWait?: ProviderAccountSchedulerStickyWaitConfig;
  /**
   * F2 (task #35): optional Redis concurrency-slot pre-check in front of the
   * PostgreSQL lease snapshot (R6b hot state). Default absent = OFF, keeping
   * the concurrency port byte-identical. Only combined/control-plane
   * topologies that hold a Redis connection should provide it — the
   * dedicated gateway workload cannot, by deployment contract.
   */
  /** Dedicated, optional Redis connection for bounded scheduler snapshots. */
  readonly schedulerHintRedisCache?: RedisRuntimeCache;
  readonly schedulerRedisConcurrencySlots?: PostgresProviderAccountSchedulerOptions['redisConcurrencySlots'];
  /**
   * F2 (task #35): when set, the scheduler affinity port is decorated with
   * the R6b Redis sticky-session fast path (createRedisStickyProviderAccount
   * Affinity). The PostgreSQL affinity table stays authoritative on every
   * miss and on bind; Redis only short-circuits hits whose account is still
   * eligible. Absent keeps the undecorated port exactly.
   */
  readonly schedulerAffinityStickyCache?: RedisStickyAffinityOptions;
  readonly maxBodyBytes: number;
  readonly entryPoint: string;
  /** Trusted reverse-proxy CIDRs for client address resolution; empty means socket peer only. */
  readonly trustedProxyCidrs?: readonly string[];
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
    async revalidateAuthorization(input, sqlOptions) {
      if (!admission.revalidateAuthorization) {
        return blockRequestPreparation('capability_unavailable', 'Transactional replay authorization is unavailable.');
      }
      return admission.revalidateAuthorization(input, sqlOptions);
    },
    async readCanonicalCompilation(input, sqlOptions) {
      if (!admission.revalidateAuthorization) {
        return blockRequestPreparation('capability_unavailable', 'Transactional replay authorization is unavailable.');
      }
      const authorized = await admission.revalidateAuthorization(input, sqlOptions);
      if (authorized.decision !== 'allow') return authorized;
      try {
        return allowRequestPreparation(
          await store.readCanonicalCompilation(sqlOptions.executor, {
            tenantId: input.caller.tenantId,
            projectId: input.caller.projectId,
            proxyKeyId: input.caller.proxyKeyId,
            clientKey: input.clientKey,
          }),
        );
      } catch {
        return blockRequestPreparation('storage_failure', 'The canonical compilation identity is unavailable.');
      }
    },
    async lookupExisting(input, sqlOptions) {
      if (!admission.revalidateAuthorization) {
        return blockRequestPreparation('capability_unavailable', 'Transactional replay authorization is unavailable.');
      }
      const authorized = await admission.revalidateAuthorization(input, sqlOptions);
      if (authorized.decision !== 'allow') return authorized;
      try {
        const existing = await store.lookupExisting(sqlOptions.executor, {
          tenantId: input.caller.tenantId,
          projectId: input.caller.projectId,
          proxyKeyId: input.caller.proxyKeyId,
          clientKey: input.clientKey,
          requestId: input.requestId,
          requestFingerprint: input.requestFingerprint,
          requestFingerprintVersion: input.requestFingerprintVersion,
        });
        if (existing.kind === 'missing')
          return blockRequestPreparation('storage_failure', 'The canonical idempotency binding disappeared.');
        if (existing.kind === 'fingerprint_conflict') {
          return rejectRequestPreparation(
            'idempotency_conflict',
            'The idempotency key is already bound to a different request fingerprint.',
          );
        }
        return rejectRequestPreparation(
          'idempotency_replay',
          'The existing canonical request is returned without replaying its response.',
          { requestId: existing.canonicalRequestId, status: existing.canonicalRequestStatus },
        );
      } catch {
        return blockRequestPreparation('storage_failure', 'The canonical idempotency binding is unavailable.');
      }
    },
    async authorizeAndReserve(input, sqlOptions) {
      const executor = sqlOptions?.executor;
      if (!executor) {
        return blockRequestPreparation(
          'capability_unavailable',
          'Persistent request idempotency requires the admission transaction.',
        );
      }
      if (!admission.revalidateAuthorization) {
        return blockRequestPreparation(
          'capability_unavailable',
          'Transactional admission authorization is unavailable.',
        );
      }
      const authorized = await admission.revalidateAuthorization(
        {
          caller: input.caller,
          entitlement: input.entitlement,
          publicModel: input.authority.route.publicModel,
          protocol: input.authority.route.protocol,
          clientAddress: input.clientAddress,
          clientKey: input.idempotencyKey,
          requestId: input.requestId,
        },
        { executor },
      );
      if (authorized.decision !== 'allow') return authorized;
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
        const freshAuthorization = await admission.revalidateAuthorization(
          {
            caller: input.caller,
            entitlement: input.entitlement,
            publicModel: input.authority.route.publicModel,
            protocol: input.authority.route.protocol,
            clientAddress: input.clientAddress,
            clientKey: input.idempotencyKey,
            requestId: input.requestId,
          },
          { executor },
        );
        if (freshAuthorization.decision !== 'allow') return freshAuthorization;
        return rejectRequestPreparation(
          'idempotency_replay',
          'The existing canonical request is returned without replaying its response.',
          { requestId: claim.canonicalRequestId, status: claim.canonicalRequestStatus },
        );
      }
      if (claim.canonicalRequestId !== input.requestId) {
        return rejectRequestPreparation('binding_mismatch', 'SaaS request admission could not be authorized.');
      }
      const admitted = await admission.authorizeAndReserve(
        {
          ...input,
          idempotencyClaim: claim,
          // revalidateAuthorization above already ran on this executor in this
          // transaction (fence before claim); pass its fresh result so admission
          // skips the redundant entry revalidation.
          prevalidatedAuthorization: authorized.value,
        },
        sqlOptions,
      );
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

/** One signed-endpoint dispatch split; `providerProtocol` further narrows it when set. */
interface EndpointRoutingRoute {
  /** Signed catalog endpoint scope from the prepared evidence. */
  readonly endpoint: string;
  /** Optional signed provider protocol that must also match (codex: 'responses'). */
  readonly providerProtocol?: string;
  readonly transport: PreparedEvidenceTransport;
}

/**
 * Endpoint-scoped dispatch split. Prepared evidence is routed to the first
 * matching entry (signed endpoint scope, optionally narrowed by the signed
 * provider protocol) instead of the generic provider HTTP transport. The
 * endpoint descriptor comes from the signed prepared evidence, so the split
 * is catalog-driven, never client-supplied.
 *
 * P1c: the codex transport takes over exactly the signed `codex-responses`
 * endpoint scope with provider protocol `responses`; every other provider
 * keeps the generic transport path unchanged. R5b-2: an OpenCode Go transport
 * (when mounted) takes over the signed `opencode-go-zen` endpoint scope for
 * all three native provider protocols.
 */
function createEndpointRoutingTransport(
  defaultTransport: PreparedEvidenceTransport,
  routes: readonly EndpointRoutingRoute[],
): PreparedEvidenceTransport {
  return {
    async send(input) {
      for (const route of routes) {
        if (
          input.evidence.endpoint === route.endpoint &&
          (route.providerProtocol === undefined || input.evidence.providerProtocol === route.providerProtocol)
        ) {
          return route.transport.send(input);
        }
      }
      return defaultTransport.send(input);
    },
  };
}

/**
 * R5b-2 rule-table resolution for the composition: explicit resolved rules
 * first, then the raw provider-config value (the migration-108 JSONB column
 * or the sub2api credentials-map wrapper) through
 * `resolveOpenCodeGoProtocolRulesFromConfig`, then the built-in default table.
 * An explicitly empty `rules` array is honored (everything → Chat Completions).
 */
function resolveOpenCodeGoProtocolRules(
  routing: ManagedSaasGatewayProductionOptions['opencodeGoProtocolRouting'],
  fallback: readonly OpenCodeGoProtocolRule[],
): readonly OpenCodeGoProtocolRule[] {
  if (routing?.rules !== undefined) return routing.rules;
  if (routing?.config !== undefined) {
    return resolveOpenCodeGoProtocolRulesFromConfig(routing.config) ?? fallback;
  }
  return fallback;
}

/**
 * R5b-2 OpenCode Go adaptive protocol routing (plan §R5b task #22): after
 * modelMap resolution, the resolved provider model id is normalized and run
 * through the protocol rule table; the matched native protocol and its
 * canonical provider operation replace the route's provider-side protocol
 * before payload compilation and endpoint signing. Non-OpenCode-Go
 * candidates keep the route untouched. The three native protocols use the
 * repository's existing GatewayProtocol spellings ('responses' |
 * 'openai'=Chat Completions | 'anthropic'=Anthropic Messages), so the
 * existing per-protocol bridges and usage observers take over unchanged.
 *
 * Exported for direct testing; production wiring is the two call sites in
 * this module (the authority decorator below and the payload-compile route).
 */
export function applyOpenCodeGoProtocolRouting(
  route: ManagedSaasProviderPreparationRoute,
  candidate: { readonly providerId: string; readonly resolvedModel: string },
  rules: readonly OpenCodeGoProtocolRule[],
): ManagedSaasProviderPreparationRoute {
  if (candidate.providerId !== OPENCODE_GO_PROVIDER_ID) return route;
  const protocol = resolveOpenCodeGoProtocol(rules, candidate.resolvedModel);
  return {
    ...route,
    providerProtocol: protocol,
    providerOperation: openCodeGoProviderOperationForProtocol(protocol),
  };
}

/**
 * C0 §29.65: the version-keyed preparation authority cache is ON by default
 * (the CachedKeyAuthenticator precedent — admission still revalidates
 * authorization versions, so a bounded cache cannot fail open). The
 * MODEL_ROUTER_PREPARATION_AUTHORITY_CACHE kill switch ('0' / 'false') is an
 * emergency escape hatch, not an opt-in.
 */
function preparationAuthorityCacheDisabled(): boolean {
  const setting = process.env.MODEL_ROUTER_PREPARATION_AUTHORITY_CACHE;
  return setting === '0' || setting === 'false';
}

/**
 * §12.2 Phase A2a (D2): the version-keyed preparation entitlement cache is
 * ON by default, mirroring the authority cache above (the admission guard
 * still re-reads and revalidates the entitlement/project-policy versions
 * inside the admission transaction, so a bounded cache cannot fail open).
 * The MODEL_ROUTER_PREPARATION_ENTITLEMENT_CACHE kill switch ('0' / 'false')
 * is an emergency escape hatch, not an opt-in.
 */
function preparationEntitlementCacheDisabled(): boolean {
  const setting = process.env.MODEL_ROUTER_PREPARATION_ENTITLEMENT_CACHE;
  return setting === '0' || setting === 'false';
}

/**
 * §12.2 Phase A2a (D2): the version-keyed scheduler static-read cache (the
 * eligibility authority's route + eligibility joins) is ON by default. The
 * admission guard remains the fail-closed defense line — it re-reads every
 * route/account/credential/pool/rights/capability epoch inside the
 * admission transaction — so a bounded, version-keyed, allow-only cache
 * cannot fail open. Dynamic scheduler state (concurrency leases, selection
 * audit writes, model cooldowns, runtime health) is never part of this
 * cache. The MODEL_ROUTER_SCHEDULER_STATIC_CACHE kill switch ('0' / 'false')
 * is an emergency escape hatch, not an opt-in.
 */
function schedulerStaticCacheDisabled(): boolean {
  const setting = process.env.MODEL_ROUTER_SCHEDULER_STATIC_CACHE;
  return setting === '0' || setting === 'false';
}

/**
 * R5b-2 OpenCode Go adaptive protocol routing, authority layer: the resolved
 * protocol is written into `authority.route.providerProtocol` — the field the
 * preparation service's route facts, `validatePayload` and the signed
 * prepared-evidence statement all derive from — so the per-request protocol
 * decision is signed and later dispatch (endpoint scope + providerProtocol
 * keys, per-protocol provider-target bindings, usage observers) sees exactly
 * one consistent value. Non-OpenCode-Go authorities pass through unchanged.
 * Together with `applyOpenCodeGoProtocolRouting` (the payload-compile layer
 * that keeps the compiled payload on the same protocol even when a
 * deployment's runtime route resolver is OpenCode-Go-unaware) the two layers
 * can never disagree, so `validatePayload` always matches.
 *
 * Exported for direct testing; the production composition wraps the
 * PostgreSQL authority adapter with it unconditionally (non-OpenCode-Go
 * resolves pass through unchanged, so no other provider's behavior moves).
 */
export function createOpenCodeGoProtocolRoutingAuthority(
  authority: RequestPreparationAuthorityPort,
  rules: readonly OpenCodeGoProtocolRule[],
): RequestPreparationAuthorityPort {
  return {
    async resolve(input) {
      const decision = await authority.resolve(input);
      if (decision.decision !== 'allow') return decision;
      const value = decision.value;
      if (value.candidate.providerId !== OPENCODE_GO_PROVIDER_ID) return decision;
      const protocol = resolveOpenCodeGoProtocol(rules, value.candidate.resolvedModel);
      return allowRequestPreparation({
        ...value,
        route: {
          ...value.route,
          providerProtocol: protocol,
          providerOperation: openCodeGoProviderOperationForProtocol(protocol),
        },
      });
    },
    /**
     * Composition introspection contract: the decorator stays transparent to
     * instanceof-style checks by exposing the wrapped adapter. Real gateway
     * E2E fixtures unwrap one optional layer before asserting the concrete
     * authority class; anything deeper is a composition bug they must catch.
     */
    underlyingAuthority: authority,
  } as RequestPreparationAuthorityPort & { readonly underlyingAuthority: RequestPreparationAuthorityPort };
}

/**
 * Batch-3 CN-provider adaptive protocol routing (the opencode-go
 * applyOpenCodeGoProtocolRouting analog): after modelMap resolution, the
 * candidate's provider-resolved api_protocol (composition routing config,
 * default adaptive) decides the native protocol — pinned
 * (chat_completions/anthropic/responses) or inbound-client-following — and
 * the matched native protocol and its canonical provider operation replace
 * the route's provider-side protocol before payload compilation and
 * endpoint signing. Non-CN-provider candidates keep the route untouched.
 *
 * The returned second element is true when the client protocol has no
 * servable native route for this provider (a gemini client — defensive: the
 * capability-protocol eligibility check never surfaces a CN candidate for a
 * gemini client); callers fail closed on it instead of guessing.
 *
 * Exported for direct testing; production wiring is the two call sites in
 * this module (the authority decorator below and the payload-compile route).
 */
export function applyCnProvidersProtocolRouting(
  route: ManagedSaasProviderPreparationRoute,
  candidate: { readonly providerId: string },
  routing: CnProvidersProtocolRoutingConfig | undefined,
): { readonly route: ManagedSaasProviderPreparationRoute; readonly blocked: boolean } {
  if (candidate.providerId !== 'zhipu' && candidate.providerId !== 'minimax') {
    return { route, blocked: false };
  }
  const native = resolveCnNativeProtocol({
    providerId: candidate.providerId,
    apiProtocol: resolveCnProviderApiProtocol(routing, candidate.providerId),
    clientProtocol: route.clientProtocol,
  });
  if (native === null) return { route, blocked: true };
  return {
    route: {
      ...route,
      providerProtocol: native,
      providerOperation: cnProviderOperationForProtocol(native),
    },
    blocked: false,
  };
}

/**
 * Batch-3 CN-provider adaptive protocol routing, authority layer (the
 * opencode-go decorator analog): the resolved native protocol is written
 * into `authority.route.providerProtocol` — the field the preparation
 * service's route facts, `validatePayload` and the signed prepared-evidence
 * statement all derive from — so the per-request protocol decision is
 * signed and later dispatch (endpoint scope + providerProtocol keys,
 * per-protocol provider-target bindings, usage observers) sees exactly one
 * consistent value. Non-CN-provider authorities pass through unchanged; a
 * blocked resolution keeps the route untouched (the payload-compile layer
 * owns the fail-closed block).
 */
export function createCnProvidersProtocolRoutingAuthority(
  authority: RequestPreparationAuthorityPort,
  routing: CnProvidersProtocolRoutingConfig | undefined,
): RequestPreparationAuthorityPort {
  return {
    async resolve(input) {
      const decision = await authority.resolve(input);
      if (decision.decision !== 'allow') return decision;
      const value = decision.value;
      const providerId = value.candidate.providerId;
      if (providerId !== 'zhipu' && providerId !== 'minimax') return decision;
      // value.route.protocol is the client protocol (the compile-layer
      // route's clientProtocol); a blocked resolution (no servable native
      // for this client protocol) keeps the route untouched — the
      // payload-compile layer owns the fail-closed block.
      const native = resolveCnNativeProtocol({
        providerId,
        apiProtocol: resolveCnProviderApiProtocol(routing, providerId),
        clientProtocol: value.route.protocol,
      });
      if (native === null) return decision;
      if (value.route.providerProtocol === native) return decision;
      return allowRequestPreparation({
        ...value,
        route: {
          ...value.route,
          providerProtocol: native,
          providerOperation: cnProviderOperationForProtocol(native),
        },
      });
    },
    underlyingAuthority: authority,
  } as RequestPreparationAuthorityPort & { readonly underlyingAuthority: RequestPreparationAuthorityPort };
}

/**
 * Exported for direct testing (the production composition is the only other
 * caller): the production payload-compile wrapper that applies OpenCode Go
 * protocol routing and (unless restricted via
 * `opencodeGoCrossResponsesRouting: 'restrict'`) bridges cross-protocol
 * Responses routes through the real generic Responses conversion.
 */
export function createProviderPayloadCompiler(
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

  // R5b-2: the OpenCode Go rule table is resolved once per composition —
  // explicit rules, then the raw provider-config value (the migration-108
  // JSONB column), then the built-in default table.
  const openCodeGoProtocolRules = resolveOpenCodeGoProtocolRules(
    options.opencodeGoProtocolRouting,
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );

  const compiler = new ProviderPayloadCompiler({
    estimator: payloadOptions.estimator,
    modelCompatibility: payloadOptions.modelCompatibility,
    maxPayloadBytes: payloadOptions.maxPayloadBytes,
    compilerVersion: payloadOptions.compilerVersion,
    allowIdentityModelResolution: false,
    // Batch-3: the CN-provider thinking-protocol transform (MiniMax M-series
    // thinking.type enabled→adaptive on the Anthropic native; verbatim
    // passback for glm-/minimax-m-) — the dormant providerRequestTransform
    // seam's first consumer. Copy-on-write and provider-scoped: every other
    // provider's payload bytes are unchanged.
    providerRequestTransform: (input) => {
      const transformed = cnProvidersProviderRequestTransform(input);
      return payloadOptions.providerRequestTransform && record(transformed)
        ? payloadOptions.providerRequestTransform({ ...input, body: transformed })
        : transformed;
    },
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
      if (input.clientOperation === 'responses.compact') {
        if (route.clientProtocol !== 'responses' || route.providerProtocol !== 'responses') {
          return {
            decision: 'block',
            code: 'capability_unsupported',
            message: 'compact requires native Responses supply',
          };
        }
        route = { ...route, clientOperation: 'responses.compact', providerOperation: 'responses.compact' };
        return compiler.compile({ ...input, ...route, operation: 'responses.compact' });
      }
      // R5b-2: OpenCode Go candidates re-derive the provider protocol from
      // the post-modelMap resolved model id. The override stays within the
      // validated route invariants (native GatewayProtocol + canonical
      // operation); an unsupported client→provider bridge pair then fails
      // closed inside the compiler as a capability_unavailable block.
      const routedRoute = applyOpenCodeGoProtocolRouting(route, input.authority.candidate, openCodeGoProtocolRules);
      // F3: the generic cross→Responses bridges are real conversions now
      // (gateway/responses-bridge), so a Responses-routed OpenCode Go model
      // requested through any client protocol compiles through the bridge by
      // default. Operators who prefer the R5b-4 fail-closed posture restore it
      // with `opencodeGoCrossResponsesRouting: 'restrict'`.
      if (
        options.opencodeGoCrossResponsesRouting === 'restrict' &&
        input.authority.candidate.providerId === OPENCODE_GO_PROVIDER_ID &&
        isOpenCodeGoCrossResponsesRoute(routedRoute.clientProtocol, routedRoute.providerProtocol)
      ) {
        return {
          decision: 'block',
          code: 'capability_unsupported',
          message: 'opencode-go responses-routed models require a responses client protocol',
        };
      }
      // Batch-3: CN-provider candidates re-derive the provider protocol from
      // the per-provider api_protocol (default adaptive: the native endpoint
      // follows the inbound client protocol). A blocked resolution (no
      // servable native for this client protocol) fails closed here instead
      // of compiling a wrong-shaped payload.
      const cnRouted = applyCnProvidersProtocolRouting(
        routedRoute,
        input.authority.candidate,
        options.cnProvidersProtocolRouting,
      );
      if (cnRouted.blocked) {
        return {
          decision: 'block',
          code: 'capability_unsupported',
          message: 'cn-provider accounts cannot serve this client protocol',
        };
      }
      return compiler.compile({
        ...input,
        clientProtocol: cnRouted.route.clientProtocol,
        providerProtocol: cnRouted.route.providerProtocol,
        clientOperation: cnRouted.route.clientOperation,
        providerOperation: cnRouted.route.providerOperation,
        operation: cnRouted.route.providerOperation,
        modelResolution: cnRouted.route.modelResolution,
      } as ProviderPayloadCompilerInput);
    },
  };
}

function createProviderDispatchProfileResolver(
  options: ManagedSaasGatewayProductionOptions,
  resolveEgressProxy?: (input: {
    readonly tenantId: string;
    readonly supplyMode: 'byok' | 'platform' | undefined;
    readonly accountOwnerKind: 'tenant' | 'platform' | undefined;
    readonly accountId: string;
  }) => Promise<{ readonly url: string } | null>,
  resolveTlsFingerprint?: (input: {
    readonly tenantId: string;
    readonly supplyMode: 'byok' | 'platform' | undefined;
    readonly accountOwnerKind: 'tenant' | 'platform' | undefined;
    readonly accountId: string;
  }) => Promise<ProviderTlsFingerprintEgress | null>,
): ConstructorParameters<typeof ProviderHttpTransport>[0]['resolveDispatchProfile'] {
  requireDependency(options.providerTargetResolver, 'resolve');
  requireCallable(options.providerTargetRoute);
  return async (input) => {
    const route = await options.providerTargetRoute(input);
    if (!route) return null;
    requireText(route.productId);
    requireText(route.providerProtocol);
    requireText(route.providerOperation);
    if (
      input.providerOperation === 'responses.compact' &&
      (route.providerProtocol !== 'responses' || route.providerOperation !== 'responses.compact')
    ) {
      return null;
    }
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
    if (typeof url !== 'string' || url.length === 0) return null;
    // R3: the per-account egress proxy rides on the dispatch profile. The
    // resolver's failures propagate — a bound proxy that cannot be read must
    // fail the dispatch, never silently direct-egress the account.
    const egressProxy =
      resolveEgressProxy === undefined
        ? null
        : await resolveEgressProxy({
            tenantId: input.tenantId,
            supplyMode: input.supplyMode,
            accountOwnerKind: input.accountOwnerKind,
            accountId: input.accountId,
          });
    // Batch-2 §2.4: the per-account TLS fingerprint rides alongside. The
    // resolver itself fails open (null descriptor = ordinary connector), so
    // unlike the proxy a resolution miss never fails the dispatch.
    const tlsFingerprint =
      resolveTlsFingerprint === undefined
        ? null
        : await resolveTlsFingerprint({
            tenantId: input.tenantId,
            supplyMode: input.supplyMode,
            accountOwnerKind: input.accountOwnerKind,
            accountId: input.accountId,
          });
    if (egressProxy === null && tlsFingerprint === null) return { url };
    return {
      url,
      ...(egressProxy === null ? {} : { egressProxy }),
      ...(tlsFingerprint === null ? {} : { tlsFingerprint }),
    };
  };
}

/** Only the owned PostgreSQL provider defines null as an authoritative full account. */
export function createPostgresDispatchLeaseProvider(
  provider: PostgresProviderAccountLeaseService,
): PreparedEvidenceLeaseProvider {
  if (!(provider instanceof PostgresProviderAccountLeaseService)) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  return {
    async acquire(input) {
      const lease = await provider.acquire(input);
      if (lease === null) {
        throw new SaasPreparedEvidenceDispatchError(
          'LEASE_CAPACITY_EXHAUSTED',
          'Provider account concurrency capacity is occupied.',
        );
      }
      return lease;
    },
  };
}

/**
 * Compose the real database-backed services around the required runtime
 * adapters. Missing caller/admission/route/KMS/config capabilities throw
 * before startup can bind the gateway listener.
 */
export function resolveManagedSaasFastGatewayConfiguration(
  options: Pick<ManagedSaasGatewayProductionOptions, 'fastGateway'>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ManagedSaasFastGatewayOptions | undefined {
  const invalid = () => {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  };
  const validate = (value: ManagedSaasFastGatewayOptions): ManagedSaasFastGatewayOptions => {
    if (
      value.mode !== 'reserved-max' ||
      !value.redisUrl ||
      !value.namespace ||
      !value.allocationOwner ||
      (value.reuseConnections !== undefined && typeof value.reuseConnections !== 'boolean') ||
      (value.receiptMode !== undefined && !['durable', 'memory-queue'].includes(value.receiptMode)) ||
      (value.receiptQueue !== undefined &&
        (value.receiptMode !== 'memory-queue' ||
          !value.receiptQueue ||
          typeof value.receiptQueue !== 'object' ||
          Array.isArray(value.receiptQueue))) ||
      (value.allocationTrancheMinorUnits !== undefined &&
        (typeof value.allocationTrancheMinorUnits !== 'string' ||
          !/^[1-9][0-9]*$/.test(value.allocationTrancheMinorUnits))) ||
      (value.allocationStripes !== undefined &&
        (!Number.isSafeInteger(value.allocationStripes) ||
          value.allocationStripes < 1 ||
          value.allocationStripes > 8)) ||
      (value.reserveBatchWindowMs !== undefined &&
        (!Number.isSafeInteger(value.reserveBatchWindowMs) ||
          value.reserveBatchWindowMs < 0 ||
          value.reserveBatchWindowMs > 50)) ||
      (value.reserveBatchMaxRows !== undefined &&
        (!Number.isSafeInteger(value.reserveBatchMaxRows) ||
          value.reserveBatchMaxRows < 1 ||
          value.reserveBatchMaxRows > 32)) ||
      (value.reserveBatchMaxQueue !== undefined &&
        (!Number.isSafeInteger(value.reserveBatchMaxQueue) ||
          value.reserveBatchMaxQueue < (value.reserveBatchMaxRows ?? 1) ||
          value.reserveBatchMaxQueue > 4096))
    )
      invalid();
    if (value.receiptQueue) {
      const bounds: Record<keyof FastReceiptQueueLimits, number> = {
        maxEntries: 65536,
        maxBytes: 256 * 1024 * 1024,
        workers: 32,
        maxPerTenant: 65536,
        maxAgeMs: 3600000,
        drainTimeoutMs: 3600000,
      };
      for (const [key, limit] of Object.entries(value.receiptQueue)) {
        const maximum = bounds[key as keyof FastReceiptQueueLimits];
        if (!maximum || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) invalid();
      }
    }
    return { ...value, reuseConnections: value.reuseConnections ?? true, receiptMode: value.receiptMode ?? 'durable' };
  };
  if (options.fastGateway) return validate(options.fastGateway);
  const mode = environment.MODEL_ROUTER_FAST_GATEWAY;
  if (mode === undefined || mode === '' || mode === 'off') return undefined;
  if (mode !== 'reserved-max') return invalid();
  const redisUrl = environment.MODEL_ROUTER_FAST_REDIS_URL ?? environment.MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL;
  const namespace = environment.MODEL_ROUTER_FAST_NAMESPACE;
  const allocationOwner = environment.MODEL_ROUTER_FAST_OWNER;
  const reuse = environment.MODEL_ROUTER_FAST_CONNECTION_REUSE;
  const receiptMode = environment.MODEL_ROUTER_FAST_RECEIPT_MODE;
  const receiptQueue: Record<string, number> = {};
  for (const [key, suffix] of Object.entries({
    maxEntries: 'MAX_ENTRIES',
    maxBytes: 'MAX_BYTES',
    workers: 'WORKERS',
    maxPerTenant: 'MAX_PER_TENANT',
    maxAgeMs: 'MAX_AGE_MS',
    drainTimeoutMs: 'DRAIN_TIMEOUT_MS',
  })) {
    const raw = environment[`MODEL_ROUTER_FAST_RECEIPT_${suffix}`];
    if (raw !== undefined) {
      if (!/^[1-9][0-9]*$/.test(raw)) return invalid();
      receiptQueue[key] = Number(raw);
    }
  }
  if (!redisUrl || !namespace || !allocationOwner || (reuse !== undefined && reuse !== '0' && reuse !== '1'))
    return invalid();
  return validate({
    mode,
    redisUrl,
    namespace,
    allocationOwner,
    ...(environment.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS === undefined
      ? {}
      : { allocationTrancheMinorUnits: environment.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS }),
    ...(environment.MODEL_ROUTER_FAST_CREDIT_STRIPES === undefined
      ? {}
      : { allocationStripes: Number(environment.MODEL_ROUTER_FAST_CREDIT_STRIPES) }),
    ...(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_WINDOW_MS === undefined
      ? {}
      : { reserveBatchWindowMs: Number(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_WINDOW_MS) }),
    ...(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_MAX_ROWS === undefined
      ? {}
      : { reserveBatchMaxRows: Number(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_MAX_ROWS) }),
    ...(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_MAX_QUEUE === undefined
      ? {}
      : { reserveBatchMaxQueue: Number(environment.MODEL_ROUTER_FAST_RESERVE_BATCH_MAX_QUEUE) }),
    redisDrained: environment.MODEL_ROUTER_FAST_REDIS_DRAINED === '1',
    reuseConnections: reuse !== '0',
    ...(receiptMode === undefined ? {} : { receiptMode: receiptMode as 'durable' | 'memory-queue' }),
    ...(Object.keys(receiptQueue).length === 0 ? {} : { receiptQueue }),
    ...(environment.MODEL_ROUTER_FAST_SNAPSHOT_KEY_BASE64
      ? { snapshotEncryptionKey: Buffer.from(environment.MODEL_ROUTER_FAST_SNAPSHOT_KEY_BASE64, 'base64') }
      : {}),
  });
}

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
  if (options.maxHttpInFlight !== undefined) requirePositiveInteger(options.maxHttpInFlight);
  requirePositiveInteger(options.timeoutMs);
  requirePositiveInteger(options.maxConcurrency);
  requirePositiveInteger(options.leaseTtlMs);
  if (!(options.idempotencyHmacKey instanceof Uint8Array) || options.idempotencyHmacKey.byteLength < 32) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  const idempotencyStore = new GatewayRequestIdempotencyStore({ hmacKey: options.idempotencyHmacKey });

  const runtimeHealthStore = new PostgresProviderAccountRuntimeHealthStore({ database });
  // H5c (P8): the in-process dispatch failure feedback shared by scheduling
  // (exclusion hint) and dispatch (outcome recording). Purely in-memory; the
  // PostgreSQL runtime health rows remain the durable authority.
  const dispatchFailureFeedback = new ProviderAccountDispatchFailureFeedback();
  /*
   * Core-plan 9.1 (B06): one shared model-cooldown registry — the dispatch
   * side records model-unavailable outcomes into it and the scheduler reads
   * the same instance via modelCooldown, so the (account, model) cooldown is
   * both written AND consumed. Core-plan 9.1 (multi-instance, migration 133):
   * the shared instance is the durable registry — the in-process Map stays an
   * L1 (instant local reads), the PostgreSQL rows are the cross-instance
   * authority with `cooled_until > now()` as the invalidation bound.
   */
  const modelRateLimitRegistry = new ProviderAccountModelRateLimit();
  const modelCooldownRegistry = new PostgresProviderAccountModelCooldownRegistry({
    database,
    local: modelRateLimitRegistry,
  });
  // The lease service is created before the scheduler so the same fenced
  // lease authority can back the scheduler's half-open health probes (H5a).
  const leaseProvider = new PostgresProviderAccountLeaseService({
    database,
    maxConcurrency: options.maxConcurrency,
    leaseTtlMs: options.leaseTtlMs,
  });
  // F2 (task #35): additive scheduler composition options. The sticky cache
  // decorates the affinity port (PG stays authoritative); the Redis slot
  // pre-check is forwarded to the PostgreSQL scheduler (default off, and the
  // PG lease remains the final admission either way).
  const schedulerAffinityPort = options.schedulerAffinityStickyCache
    ? createRedisStickyProviderAccountAffinity(options.schedulerAffinity, options.schedulerAffinityStickyCache)
    : options.schedulerAffinity;
  const schedulerHints =
    process.env.MODEL_ROUTER_SCHEDULER_HINT_CACHE === 'off'
      ? undefined
      : new CachedSchedulerHints(database, modelRateLimitRegistry, { redis: options.schedulerHintRedisCache });
  const scheduler = new PostgresProviderAccountScheduler({
    database,
    health: runtimeHealthStore,
    // H5a (P5a): self-heal stale runtime health through the half-open probe
    // so a quiet phase no longer walls all scheduling.
    healthProbe: { store: runtimeHealthStore, leaseProvider },
    // H5c (P8): fast fail-away from accounts returning 401/403/429.
    failureFeedback: dispatchFailureFeedback,
    modelCooldown: {
      isModelExcluded: (input) =>
        schedulerHints?.cooldown(input.candidate, input.model, input.now) ??
        modelCooldownRegistry.isModelExcluded(input),
    },
    ...(schedulerHints
      ? {
          hintScope: <T>(
            input: import('../saas/gateway/provider-account-scheduler.js').ProviderAccountSchedulerInput,
            work: () => Promise<T>,
          ) => schedulerHints.run(input, work),
        }
      : {}),
    // G-B1 (window three-state): the migration-130 gate — batch PG facts
    // (policy columns + exact supplier-cost window aggregation) feeding the
    // pure three-state judgment. Fail-open on any read failure.
    windowCost: {
      resolveWindowCostSchedulability: async ({ candidate, now }) => {
        try {
          const cached = schedulerHints?.window(candidate.accountId);
          const fact =
            cached === undefined
              ? (await getAccountWindowCostFactsBatch(database, [candidate.accountId], now.getTime())).get(
                  candidate.accountId,
                )
              : cached;
          if (fact == null) return 'admit'; // no frozen policy — the gate is OFF
          return evaluateWindowCostSchedulability({
            usageMinorUnits: fact.usageMinorUnits ?? 0n,
            limitMinorUnits: fact.limitMinorUnits,
            reserveMinorUnits: fact.reserveMinorUnits,
          });
        } catch {
          return 'admit'; // fail-open: a failed read never removes capacity
        }
      },
    },
    affinity: schedulerAffinityPort,
    leaseConcurrencyLimit: options.maxConcurrency,
    strategies: options.schedulerStrategies,
    ...(options.schedulerStickyWait ? { stickyWait: options.schedulerStickyWait } : {}),
    ...(options.schedulerRedisConcurrencySlots
      ? { redisConcurrencySlots: options.schedulerRedisConcurrencySlots }
      : {}),
    // §12.2 Phase A2a (D2): version-keyed, allow-only cache around the
    // scheduler's STATIC eligibility reads (route join + eligibility join).
    // The key is the complete caller/entitlement/candidate identity +
    // version tuple; the admission guard still re-reads and revalidates
    // every authority epoch inside the admission transaction (fail-closed),
    // so the cache can never bypass the final defense line. Dynamic state
    // (concurrency, audit writes, cooldowns, runtime health) stays on its
    // own per-call ports. Only the production wiring passes the option, so
    // direct scheduler constructions in tests stay byte-identical. Disable
    // with MODEL_ROUTER_SCHEDULER_STATIC_CACHE=0.
    ...(schedulerStaticCacheDisabled() ? {} : { staticEligibilityCache: {} }),
  });

  const routes = new SaasRouteConfigService(database);
  const commercial = new SaasCommercialMeteringPolicyService(database);
  const catalog = new SaasCatalogService(database);
  const byokEntitlements = new ByokServicePlanService(database);
  const authorityDependencies: PostgresRequestPreparationAuthorityAdapterDependencies = {
    database,
    ...(options.preparationObserver ? { observe: options.preparationObserver } : {}),
    ...(options.providerNativeProtocol ? { providerNativeProtocol: options.providerNativeProtocol } : {}),
    routes,
    commercial,
    catalog,
    byokEntitlements,
    // R3 §8.1: composite dispatches resolve their supplier cost version on
    // the resolved target-platform identity inside the preparation
    // transaction (fail-closed when the target platform has no effective
    // cost version for the route's public model).
    pricing: new SaasPricingService(database),
  };
  // R5b-2: OpenCode Go prepared requests re-derive their provider protocol
  // per request from the protocol rule table (after modelMap resolution,
  // before endpoint signing): explicit rules, then the raw provider-config
  // value (the migration-108 JSONB column), then the built-in default table.
  const openCodeGoProtocolRules = resolveOpenCodeGoProtocolRules(
    options.opencodeGoProtocolRouting,
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  const authority: RequestPreparationAuthorityPort = createOpenCodeGoProtocolRoutingAuthority(
    // Batch-3: CN-provider adaptive routing wraps OUTSIDE the OpenCode Go
    // decorator (the provider sets are disjoint, so the two decorators
    // commute; non-CN-provider decisions pass through unchanged).
    createCnProvidersProtocolRoutingAuthority(
      // C0 §29.65: version-keyed, allow-only cache around the PostgreSQL
      // authority adapter. The key is the complete caller/entitlement
      // version tuple; the admission guard still re-reads and revalidates
      // every authority fact inside the admission transaction (fail-closed),
      // so the cache can never bypass the final defense line. The pure
      // in-memory protocol-routing decorators stay outside the cache and run
      // per request. Disable with MODEL_ROUTER_PREPARATION_AUTHORITY_CACHE=0.
      preparationAuthorityCacheDisabled()
        ? new PostgresRequestPreparationAuthorityAdapter(authorityDependencies)
        : new CachedRequestPreparationAuthority(new PostgresRequestPreparationAuthorityAdapter(authorityDependencies)),
      options.cnProvidersProtocolRouting,
    ),
    openCodeGoProtocolRules,
  );

  const evidence = new SaasPreparedRequestEvidenceService(database, {
    trustedVerifierPublicKeys: options.trustedVerifierPublicKeys,
  });
  const signer = new RequestPreparationSignerAdapter({
    signer: options.evidenceSigner,
    runtimeVerifierKeyId: options.evidenceVerifierKeyId,
  });
  const webhookEventProducer = options.customerWebhooks?.enabled ? createCustomerWebhookEventProducer() : undefined;
  const metering = new SaasMeteringService(database, {
    ...(webhookEventProducer ? { webhookEvents: webhookEventProducer } : {}),
  });
  const normalSuccessSettlement = new DispatchUsageSettlementCoordinator(
    new SaasPricingService(database),
    new DurableNormalSuccessSettlementPort(database, {
      keyBudget: createKeyBudgetResolution(),
      // R1 (roadmap 1.3, phase 3): group spend windows settle with the
      // ACTUAL group-multiplied charge at the settlement terminal commit.
      billingGroupSpend: createBillingGroupSpendResolution(),
      ...(webhookEventProducer ? { webhookEvents: webhookEventProducer } : {}),
    }),
  );
  // (The lease service was created before the scheduler so its fenced
  // authority backs the half-open health probes; see H5a above.)
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
  // R3 egress proxies: resolve the account's bound proxy through the shared
  // lookup so forwarding, OAuth refresh, and probes provably share one exit
  // IP. The resolver is optional only so pre-107 deployments that have not
  // re-applied the roles template keep the direct-egress path until the
  // probe SQL is satisfied; production wiring always provides it.
  const egressProxyResolver = options.egressProxyResolution?.enabled
    ? new PostgresProviderEgressProxyResolver({
        database,
        kms: options.providerCredentialUnsealingKms,
        credentialContext: options.credentialContext,
      })
    : undefined;
  // Batch-2 §2.4: the per-account TLS-fingerprint resolver (PG authoritative
  // + short-TTL in-process profile cache; fail-open by design). The sidecar
  // connector factory composes over the ordinary pinned connector, so
  // accounts without a bound profile keep the exact previous path.
  const tlsFingerprintResolver = options.tlsFingerprintResolution?.enabled
    ? new PostgresProviderTlsFingerprintResolver({ database })
    : undefined;
  const tlsFingerprintConnectorFactory =
    options.tlsFingerprintResolution?.enabled === true &&
    typeof options.tlsFingerprintResolution.sidecarSocketPath === 'string' &&
    options.tlsFingerprintResolution.sidecarSocketPath !== ''
      ? createTlsFingerprintSidecarConnectorFactory({
          socketPath: options.tlsFingerprintResolution.sidecarSocketPath,
        })
      : undefined;
  // F6: OpenRouter supplier-attribute headers, built once (input validation
  // happens at composition time, not per request).
  const openRouterFixedRequestHeaders = createOpenRouterFixedRequestHeaders(options.openRouterAttribution);
  const transport = new ProviderHttpTransport({
    ...(options.dispatchObserver ? { observe: options.dispatchObserver } : {}),
    fetch: options.fetch,
    resolveDispatchProfile: createProviderDispatchProfileResolver(
      options,
      egressProxyResolver === undefined ? undefined : egressProxyResolver.resolveEgressProxy.bind(egressProxyResolver),
      tlsFingerprintResolver === undefined
        ? undefined
        : tlsFingerprintResolver.resolveTlsFingerprint.bind(tlsFingerprintResolver),
    ),
    resolveCredential: credentialResolver.resolveCredential,
    endpointPolicy: options.endpointPolicy,
    ...(options.providerHttpTestAddressCapability === undefined
      ? {}
      : { testAddressCapability: options.providerHttpTestAddressCapability }),
    // R9 §4 P1: operator egress allowlist for container-network providers.
    ...(options.providerHttpEgressAllowlist === undefined
      ? {}
      : { egressAllowlist: options.providerHttpEgressAllowlist }),
    // R5b-4 (closes R5b-2 gap 2): anthropic-routed OpenCode Go requests carry
    // anthropic-version. The resolver keys on the signed endpoint scope plus
    // the signed provider protocol, so every other provider keeps its exact
    // previous header set. F6 composes the OpenRouter supplier-attribute
    // headers (HTTP-Referer / X-Title, endpoint-keyed across all protocols)
    // in front of it — the two endpoint scopes are disjoint, so at most one
    // resolver ever matches.
    resolveFixedRequestHeaders: (input) =>
      openRouterFixedRequestHeaders(input) ??
      openCodeGoFixedRequestHeaders(input) ??
      cnProvidersFixedRequestHeaders(input),
    ...(tlsFingerprintConnectorFactory === undefined ? {} : { createConnector: tlsFingerprintConnectorFactory }),
    timeoutMs: options.timeoutMs,
    // §4.2 (task #16): the images media usage plan (units + output-first
    // tier + service-tier terms) rides the generic transport's 2xx JSON
    // branch; other operations get no plan and stay byte-identical.
    mediaUsagePlan: createImagesMediaUsagePlan,
  });
  const transportOptions = {
    ...options,
    ...options.providerEvidenceTransports?.({
      genericTransport: transport,
      proofReader,
      unsealer,
      resolveEgressProfile: async (input) => {
        const identity = {
          tenantId: input.tenantId,
          supplyMode: input.supplyMode,
          accountOwnerKind: input.accountOwnerKind,
          accountId: input.accountId,
        };
        const [egressProxy, tlsFingerprint] = await Promise.all([
          egressProxyResolver?.resolveEgressProxy(identity) ?? null,
          tlsFingerprintResolver?.resolveTlsFingerprint(identity) ?? null,
        ]);
        return { ...(egressProxy ? { egressProxy } : {}), ...(tlsFingerprint ? { tlsFingerprint } : {}) };
      },
      ...(tlsFingerprintConnectorFactory ? { createConnector: tlsFingerprintConnectorFactory } : {}),
      ...(options.providerHttpEgressAllowlist ? { egressAllowlist: options.providerHttpEgressAllowlist } : {}),
    }),
  };
  if (transportOptions.responsesCompactEvidenceTransport !== undefined) {
    requireDependency(transportOptions.responsesCompactEvidenceTransport, 'send');
  }
  // P1c codex dispatch split: the codex transport takes over exactly the
  // signed `codex-responses` endpoint scope (provider protocol `responses`);
  // every other provider keeps the generic transport path unchanged.
  // R5b-2: an OpenCode Go transport, when mounted, takes over the signed
  // `opencode-go-zen` endpoint scope for all three native provider protocols.
  // Batch-3 dispatch seams: claude (`claude-messages` + `anthropic`) and
  // gemini (`gemini-generate-content` + `gemini`) transports, when mounted,
  // take over their single native provider protocol the same way.
  if (transportOptions.codexEvidenceTransport !== undefined) {
    requireDependency(transportOptions.codexEvidenceTransport, 'send');
  }
  if (transportOptions.claudeEvidenceTransport !== undefined) {
    requireDependency(transportOptions.claudeEvidenceTransport, 'send');
  }
  if (transportOptions.geminiEvidenceTransport !== undefined) {
    requireDependency(transportOptions.geminiEvidenceTransport, 'send');
  }
  if (transportOptions.opencodeGoEvidenceTransport !== undefined) {
    requireDependency(transportOptions.opencodeGoEvidenceTransport, 'send');
  }
  if (transportOptions.cnProvidersEvidenceTransport !== undefined) {
    requireDependency(transportOptions.cnProvidersEvidenceTransport, 'send');
  }
  if (transportOptions.grokEvidenceTransport !== undefined) {
    requireDependency(transportOptions.grokEvidenceTransport, 'send');
  }
  if (transportOptions.bedrockEvidenceTransport !== undefined) {
    requireDependency(transportOptions.bedrockEvidenceTransport, 'send');
  }
  if (transportOptions.vertexEvidenceTransport !== undefined) {
    requireDependency(transportOptions.vertexEvidenceTransport, 'send');
  }
  const endpointRoutingRoutes: EndpointRoutingRoute[] = [];
  if (transportOptions.codexEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: CODEX_ENDPOINT,
      providerProtocol: 'responses',
      transport: transportOptions.codexEvidenceTransport,
    });
  }
  if (transportOptions.claudeEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: CLAUDE_ENDPOINT,
      providerProtocol: 'anthropic',
      // Batch-5 §5.1: the optional plugin routing layer wraps the claude
      // transport at its exit. Unrouted accounts and no-binding deployments
      // delegate to the inner transport unchanged; routed accounts whose
      // plugin cannot serve fail closed (see gateway-plugin-router.ts).
      transport:
        options.pluginRouting === undefined
          ? transportOptions.claudeEvidenceTransport
          : new PluginRoutingClaudeTransport({
              inner: transportOptions.claudeEvidenceTransport,
              capability: 'claude.oauth.outbound_transport.v1',
              routeReader: options.pluginRouting.routeReader,
              pluginHostClient: options.pluginRouting.pluginHostClient,
              baseUrl: CLAUDE_MESSAGES_ENDPOINT,
            }),
    });
  }
  if (transportOptions.geminiEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: GEMINI_ENDPOINT,
      providerProtocol: 'gemini',
      transport: transportOptions.geminiEvidenceTransport,
    });
  }
  if (transportOptions.opencodeGoEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: OPENCODE_GO_ENDPOINT,
      transport: transportOptions.opencodeGoEvidenceTransport,
    });
  }
  // Batch-3: the CN-provider adapter takes over all three endpoint scopes
  // with no providerProtocol narrowing (the opencode-go whole-scope
  // precedent) — the adapter itself delegates to the generic transport and
  // only adds the error-body classification.
  if (transportOptions.cnProvidersEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({ endpoint: ZHIPU_ENDPOINT, transport: transportOptions.cnProvidersEvidenceTransport });
    endpointRoutingRoutes.push({
      endpoint: ZHIPU_CODING_ENDPOINT,
      transport: transportOptions.cnProvidersEvidenceTransport,
    });
    endpointRoutingRoutes.push({
      endpoint: MINIMAX_ENDPOINT,
      transport: transportOptions.cnProvidersEvidenceTransport,
    });
  }
  if (transportOptions.grokEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: GROK_ENDPOINT,
      providerProtocol: 'responses',
      transport: transportOptions.grokEvidenceTransport,
    });
  }
  if (transportOptions.bedrockEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({
      endpoint: BEDROCK_ENDPOINT,
      providerProtocol: 'anthropic',
      transport: transportOptions.bedrockEvidenceTransport,
    });
  }
  // The Vertex route takes over the whole `vertex-raw-predict` endpoint
  // scope with no providerProtocol narrowing — the scope covers BOTH
  // provider protocols (anthropic for the rawPredict family, gemini for the
  // generateContent family) and the transport selects the endpoint family
  // from the signed provider protocol on the evidence (the opencode-go
  // whole-scope precedent).
  if (transportOptions.vertexEvidenceTransport !== undefined) {
    endpointRoutingRoutes.push({ endpoint: VERTEX_ENDPOINT, transport: transportOptions.vertexEvidenceTransport });
  }
  const dispatchTransport = createNativeResponsesCompactRoutingTransport(
    transportOptions.responsesCompactEvidenceTransport ?? transport,
    endpointRoutingRoutes.length === 0 ? transport : createEndpointRoutingTransport(transport, endpointRoutingRoutes),
  );
  // §4.2 (task #16): the async image media binding — the zero-dep S3
  // client, the offloader, the PG-backed task service and the two boundary
  // ports (async submit + task-status query). Absent keeps the endpoints closed.
  let imageTaskService: SaasImageTaskService | undefined;
  const imageMedia = options.imageMedia
    ? (() => {
        const storage = new S3ObjectClient(options.imageMedia.s3);
        const taskService = new SaasImageTaskService({
          store: new PostgresImageTaskStore(database),
          offloader: new ImageResultOffloader({
            storage,
            keyPrefix: options.imageMedia.keyPrefix,
          }),
          ttlMs: options.imageMedia.taskTtlMs ?? IMAGE_TASK_TTL_MS,
          executionTimeoutMs: options.imageMedia.executionTimeoutMs ?? IMAGE_TASK_EXECUTION_TIMEOUT_MS,
        });
        imageTaskService = taskService;
        return {
          ...options.imageMedia,
          queryEndpoints: new SaasGatewayImagesQueryPort(taskService),
          asyncMedia: new SaasGatewayAsyncImageMediaPort(taskService),
        };
      })()
    : undefined;
  /*
   * G-A1 (image half): the stuck-task sweep timer. A dead worker's
   * `processing` rows (synchronous upstream dispatch, nothing to re-poll)
   * terminate at the execution deadline without any client poll; the
   * stranded attempt's billing stays with the unknown-outcome worker.
   * Default ON whenever imageMedia is wired; `stuckSweep.disabled` opts out.
   */
  const imageStuckSweeper =
    imageTaskService !== undefined &&
    options.imageMedia !== undefined &&
    options.imageMedia.stuckSweep?.disabled !== true
      ? startImageTaskStuckSweeper(imageTaskService, {
          ...(options.imageMedia.stuckSweep?.intervalMs === undefined
            ? {}
            : { intervalMs: options.imageMedia.stuckSweep.intervalMs }),
          ...(options.imageMedia.stuckSweep?.limit === undefined ? {} : { limit: options.imageMedia.stuckSweep.limit }),
        })
      : undefined;
  /*
   * §4.3 (task #17): the async video media binding — the PG-backed task
   * store (migration 124), the bound-account status/content forwarder, the
   * one-shot billing state machine (its deferred settlement runs through
   * the unknown-outcome reconciliation channel against the create's frozen
   * admission facts), and the two boundary ports (create-time snapshot
   * registration + the status/content query port). Absent keeps the
   * endpoints closed.
   */
  const videoMedia = options.videoMedia
    ? (() => {
        const store = new PostgresVideoTaskStore(database);
        const forwarder = new GrokVideoUpstreamForwarder({
          fetch: options.videoMedia.fetch,
          resolveCredential: options.videoMedia.resolveCredential,
          ...(options.videoMedia.baseUrl === undefined ? {} : { baseUrl: options.videoMedia.baseUrl }),
          ...(options.videoMedia.operatorHostAllowlist === undefined
            ? {}
            : { operatorHostAllowlist: options.videoMedia.operatorHostAllowlist }),
          ...(options.videoMedia.timeoutMs === undefined ? {} : { timeoutMs: options.videoMedia.timeoutMs }),
          ...(options.videoMedia.maxContentBytes === undefined
            ? {}
            : { maxContentBytes: options.videoMedia.maxContentBytes }),
        });
        const billing = new SaasVideoBillingStateMachine({
          store,
          settlement: new ReconciliationVideoSettlementPort({
            metering,
            settlement: new DurableConditionalSettlementPort(database),
            pricing: new SaasPricingService(database),
          }),
        });
        return {
          queryEndpoints: new SaasGatewayVideosQueryPort({ store, forwarder, billing }),
          videoCreate: new PersistentSaasGatewayVideoCreatePort({
            store,
            ...(options.videoMedia.taskTtlMs === undefined ? {} : { ttlMs: options.videoMedia.taskTtlMs }),
          }),
          recoveryWorker: new VideoTaskRecoveryWorker({
            store,
            forwarder,
            billing,
            ...(options.videoMedia.recovery?.batchSize === undefined
              ? {}
              : { batchSize: options.videoMedia.recovery.batchSize }),
            ...(options.videoMedia.recovery?.leaseMs === undefined
              ? {}
              : { leaseMs: options.videoMedia.recovery.leaseMs }),
            ...(options.videoMedia.recovery?.maxPollFailures === undefined
              ? {}
              : { maxPollFailures: options.videoMedia.recovery.maxPollFailures }),
            ...(options.videoMedia.recovery?.interTaskDelayMs === undefined
              ? {}
              : { interTaskDelayMs: options.videoMedia.recovery.interTaskDelayMs }),
          }),
        };
      })()
    : undefined;
  /*
   * G-A1 (video half): the no-client-poll recovery loop — pending billing
   * settles through the same one-shot state machine even if the client
   * never polls again, under the migration-132 lease (any instance adopts
   * an expired lease; the epoch fences zombie writes). Default ON whenever
   * videoMedia is wired; `recovery.disabled` opts out.
   */
  const videoRecoveryHandle =
    videoMedia !== undefined && options.videoMedia !== undefined && options.videoMedia.recovery?.disabled !== true
      ? startVideoTaskRecoveryWorker(videoMedia.recoveryWorker, {
          ...(options.videoMedia.recovery?.intervalMs === undefined
            ? {}
            : { intervalMs: options.videoMedia.recovery.intervalMs }),
        })
      : undefined;
  const payload = createProviderPayloadCompiler(options);
  const fastConfig = resolveManagedSaasFastGatewayConfiguration(options);
  if (
    options.boundedGatewayOwner &&
    (!fastConfig || fastConfig.allocationOwner !== options.boundedGatewayOwner.owner)
  ) {
    throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
  }
  let fastClose: (() => Promise<void>) | undefined;
  let closeFastResources: (() => Promise<void>) | undefined;
  let fastGateway: FastGatewayExecutorPort | undefined;
  let fastReadiness: (() => Promise<boolean>) | undefined;
  let fastStopping = false;
  if (fastConfig) {
    fastReadiness = async () => false;
    if (fastConfig.mode !== 'reserved-max') throw new ManagedSaasGatewayCompositionError('INVALID_CONFIGURATION');
    const snapshotSource = createPostgresFastGatewaySnapshotLoader({
      database,
      caller: options.caller,
      entitlement: new PostgresRequestPreparationEntitlementAdapter(options.entitlement, byokEntitlements),
      createAuthority: (scopedDatabase) =>
        new PostgresRequestPreparationAuthorityAdapter({
          database: scopedDatabase,
          ...(options.providerNativeProtocol ? { providerNativeProtocol: options.providerNativeProtocol } : {}),
          routes: new SaasRouteConfigService(scopedDatabase),
          commercial: new SaasCommercialMeteringPolicyService(scopedDatabase),
          catalog: new SaasCatalogService(scopedDatabase),
          byokEntitlements: new ByokServicePlanService(scopedDatabase),
          pricing: new SaasPricingService(scopedDatabase),
        }),
      maxBodyBytes: options.maxBodyBytes,
      accountMaxConcurrency: options.maxConcurrency,
    });
    const runtimeSnapshotSource = createRuntimeFastGatewaySnapshotSource(snapshotSource, {
      modelCompatibility: options.providerPayload.modelCompatibility,
      authenticationHeader: options.resolveAuthenticationHeader,
    });
    // Initialization starts once, outside individual requests. A failed Redis
    // authority never falls back to a second strict dispatch after an intent.
    const ready = openRedisFastGatewayAdmission({
      url: fastConfig.redisUrl,
      namespace: fastConfig.namespace,
      maxTtlMs: options.timeoutMs,
      drained: fastConfig.redisDrained,
    }).then((admission) => {
      const snapshots = new CachedFastGatewaySnapshots(
        runtimeSnapshotSource,
        fastConfig.snapshotEncryptionKey
          ? {
              minimumValidityMs: 1000,
              refreshAheadMs: 1500,
              encryptionKey: fastConfig.snapshotEncryptionKey,
              namespace: fastConfig.namespace,
              store: createRedisFastGatewaySnapshotCacheStore(admission.cacheCommands),
            }
          : { minimumValidityMs: 1000, refreshAheadMs: 1500 },
      );
      const journal = createFastGatewayJournal(database, {
        allocationOwner: fastConfig.allocationOwner,
        ...(options.boundedGatewayOwner ? { boundedDeployment: options.boundedGatewayOwner } : {}),
        ...(fastConfig.allocationTrancheMinorUnits === undefined
          ? {}
          : { allocationTrancheMinorUnits: fastConfig.allocationTrancheMinorUnits }),
        ...(fastConfig.allocationStripes === undefined ? {} : { allocationStripes: fastConfig.allocationStripes }),
        ...(fastConfig.reserveBatchWindowMs === undefined
          ? {}
          : { reserveBatchWindowMs: fastConfig.reserveBatchWindowMs }),
        ...(fastConfig.reserveBatchMaxRows === undefined
          ? {}
          : { reserveBatchMaxRows: fastConfig.reserveBatchMaxRows }),
        ...(fastConfig.reserveBatchMaxQueue === undefined
          ? {}
          : { reserveBatchMaxQueue: fastConfig.reserveBatchMaxQueue }),
      });
      // Two workers share the DB pool with durable admission and ledger work;
      // do not copy a large goroutine pool or treat capacity as usable credit.
      const receipts =
        fastConfig.receiptMode === 'memory-queue'
          ? new FastReceiptQueue({ journal, ...fastConfig.receiptQueue, observe: options.fastReceiptQueueObserver })
          : undefined;
      const checkFastReady = createFastGatewayReadiness({ admission, journal, snapshots, receipts });
      fastReadiness = async () => !fastStopping && (await checkFastReady());
      const connectorPool = fastConfig.reuseConnections
        ? new FastPinnedConnectorPool({
            createConnector: options.providerHttpTestAddressCapability
              ? createPinnedProviderHttpTestConnectorFactory(options.providerHttpTestAddressCapability)
              : createPinnedProviderHttpConnector,
            maximumEntries: Math.min(4096, Math.max(64, options.maxHttpInFlight ?? 256)),
          })
        : undefined;
      closeFastResources = async () => {
        snapshots.markUnavailable();
        fastReadiness = async () => false;
        // All active handlers have handed off before lifecycle.close. On a
        // drain failure retain evidence/M and do NOT retire or close dependencies.
        await receipts?.close();
        await connectorPool?.close();
        await journal.close();
        await admission.close();
      };
      return new FastGatewayExecutor({
        snapshots,
        admission,
        journal,
        ...(receipts ? { receiptQueue: receipts } : {}),
        unsealer,
        payload: (candidate) =>
          createProviderPayloadCompiler({
            ...options,
            providerPayload: {
              ...options.providerPayload,
              modelCompatibility: (input) => fastGatewayModelCompatibility(candidate, input),
            },
          }),
        allocationOwner: fastConfig.allocationOwner,
        ...(options.maxHttpInFlight === undefined ? {} : { maxLocalConcurrency: options.maxHttpInFlight }),
        timeoutMs: options.timeoutMs,
        transport: {
          ...(connectorPool ? { createConnector: connectorPool.createConnector } : {}),
          ...(options.dispatchObserver ? { observe: options.dispatchObserver } : {}),
          fetch: options.fetch,
          timeoutMs: options.timeoutMs,
          resolveDispatchProfile: createProviderDispatchProfileResolver(options),
          endpointPolicy: options.endpointPolicy,
          ...(options.providerHttpTestAddressCapability
            ? { testAddressCapability: options.providerHttpTestAddressCapability }
            : {}),
          ...(options.providerHttpEgressAllowlist ? { egressAllowlist: options.providerHttpEgressAllowlist } : {}),
        },
      });
    });
    void ready.catch(() => undefined); // requests/readiness observe the same failure, not an unhandled rejection
    fastGateway = {
      execute: async (input) => {
        if (fastStopping) throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
        return (await ready).execute(input);
      },
    };
    fastClose = async () => {
      await ready.catch(() => undefined);
      await closeFastResources?.();
    };
  }

  const keyService = new KeyService(database, {
    resolver: new PostgresSupplyProfileResolver(database),
  });

  // Model plaza (batch 5 §5.5, task #22): the read-only showcase rides the
  // same database and the same pricing service as admission (the facts port
  // resolves every display price through resolveCustomerPriceVersion inside
  // one snapshot transaction). Settings resolve store-first when the
  // deployment supplies an overlay reader, env-only otherwise; the session
  // tier is wired by the deployment when a console-session authority is in
  // scope (the split-gateway role holds no saas_sessions grant).
  // Always install an enforcing policy in production, including custom/v1
  // runtimes without readiness. Missing facts close advertisements while
  // authenticated preparation remains available for direct verification.
  const capabilityReadiness = async (): Promise<GatewayCapabilityReadiness> => {
    if (!options.capabilityReadiness) throw new ManagedSaasGatewayCompositionError('UNAVAILABLE');
    return options.capabilityReadiness();
  };
  const modelPlaza = createSaasModelPlazaEndpoint({
    service: new SaasModelPlazaService({
      capabilityReadiness,
      facts: new PostgresModelPlazaFacts({
        database,
        pricing: new SaasPricingService(database),
        groups: new SaasBillingGroupsService(database),
      }),
      officialPricing: new ModelsDevOfficialPricingRegistry(),
    }),
    settings: createModelPlazaSettingsProvider({
      ...(options.modelPlazaSettingsOverlay ? { overlay: options.modelPlazaSettingsOverlay } : {}),
    }),
    ...(options.modelPlazaSessionAuth ? { sessionAuth: options.modelPlazaSessionAuth } : {}),
  });

  return createManagedSaasGatewayComposition({
    ...(fastGateway ? { fastGateway } : {}),
    ...(options.fastGatewayDiagnostic ? { fastGatewayDiagnostic: options.fastGatewayDiagnostic } : {}),
    ...(options.continuationHistoryResolver
      ? { continuationHistoryResolver: options.continuationHistoryResolver }
      : {}),
    ...(options.requestDiagnostics ? { requestDiagnostics: options.requestDiagnostics } : {}),
    authenticator: new CachedKeyAuthenticator(keyService),
    ...(options.capacityCompletion ? { capacityCompletion: options.capacityCompletion } : {}),
    capabilityReadiness,
    ...(options.preparationFailureObserver ? { preparationFailureObserver: options.preparationFailureObserver } : {}),
    preparation: {
      caller: options.caller,
      // §12.2 Phase A2a (D2): version-keyed, allow-only cache around the
      // pre-dispatch entitlement resolution (the outermost DB-facing layer,
      // including the BYOK plan overlay). The key is the caller's complete
      // identity/entitlement version tuple plus publicModel/protocol; the
      // admission guard still re-reads the entitlement/profile/project-policy
      // rows inside the admission transaction and revalidates the frozen
      // versions (fail-closed), so the cache can never bypass the final
      // defense line. Only the preparation/model-list paths flow here —
      // executor-carrying (in-transaction) resolves bypass the cache
      // entirely inside the decorator. Disable with
      // MODEL_ROUTER_PREPARATION_ENTITLEMENT_CACHE=0.
      entitlement: preparationEntitlementCacheDisabled()
        ? new PostgresRequestPreparationEntitlementAdapter(options.entitlement, byokEntitlements)
        : new CachedRequestPreparationEntitlement(
            new PostgresRequestPreparationEntitlementAdapter(options.entitlement, byokEntitlements),
          ),
      authority,
      scheduler,
      payload,
      // Check the exact native port before adding the trusted idempotency
      // decorator. Custom/test ports retain the original executor identity.
      reuseTransactionFacts: supportsPreparationTransactionFacts(options.admission),
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
      ...(options.preparationObserver ? { observe: options.preparationObserver } : {}),
    },
    dispatch: {
      evidence: evidence as PreparedRequestEvidenceDispatchPort,
      metering,
      leaseProvider: createPostgresDispatchLeaseProvider(leaseProvider),
      transport: dispatchTransport,
      normalSuccessSettlement,
      runtimeHealthWriter: runtimeHealthStore,
      dispatchFailureFeedback,
      modelRateLimit: modelCooldownRegistry,
      ...(options.dispatchObserver ? { observer: options.dispatchObserver } : {}),
    },
    lifecycle: {
      stopAdmission: () => {
        fastStopping = true;
      },
      ...(fastConfig?.receiptMode === 'memory-queue'
        ? { handoffTimeoutMs: Math.max(options.timeoutMs, fastConfig.receiptQueue?.drainTimeoutMs ?? 10000) }
        : {}),
      close: async () => {
        // G-A1: stop the media recovery loops before the KMS (their PG
        // leases expire on their own; an in-flight cycle finishes first).
        await fastClose?.();
        await videoRecoveryHandle?.stop();
        await imageStuckSweeper?.stop();
        await options.providerCredentialUnsealingKms.close();
      },
    },
    ...(options.maxHttpInFlight === undefined ? {} : { maxHttpInFlight: options.maxHttpInFlight }),
    maxBodyBytes: options.maxBodyBytes,
    entryPoint: options.entryPoint,
    ...(options.responsesWsLimits ? { responsesWsLimits: options.responsesWsLimits } : {}),
    ...(options.responsesCompactNativeSupply
      ? { responsesCompactNativeSupply: options.responsesCompactNativeSupply }
      : {}),
    trustedProxyCidrs: options.trustedProxyCidrs,
    // G-C1: PG-backed readiness — database + migration head from the
    // ledger, the KMS as the required dependency, and the media binding
    // assemblies as capability flags. Never throws; secrets never appear.
    readiness: {
      readiness: async () => {
        let databaseState: 'ok' | 'error' | 'unknown' = 'unknown';
        let migrationHead: number | null = null;
        try {
          const result = await database.query<{ version: number }>(
            'SELECT version FROM saas_schema_migrations ORDER BY version DESC LIMIT 1',
          );
          migrationHead = result.rows[0]?.version ?? null;
          databaseState = 'ok';
        } catch {
          databaseState = 'error';
        }
        let kmsReady: 'ok' | 'error' = 'error';
        try {
          await options.providerCredentialUnsealingKms.checkReady();
          kmsReady = 'ok';
        } catch {
          kmsReady = 'error';
        }
        let providerCapabilities: GatewayCapabilityReadiness | undefined;
        let capabilityFactsReady: 'ok' | 'error' | undefined;
        if (options.capabilityReadiness) {
          try {
            providerCapabilities = await options.capabilityReadiness();
            capabilityFactsReady = providerCapabilities.configurationValid ? 'ok' : 'error';
          } catch {
            capabilityFactsReady = 'error';
          }
        }
        return {
          database: databaseState,
          migrationHead,
          dependencies: {
            'provider-credential-kms': kmsReady,
            ...(fastReadiness
              ? { 'fast-data-plane': (await fastReadiness()) ? ('ok' as const) : ('error' as const) }
              : {}),
            ...(capabilityFactsReady ? { 'provider-capability-facts': capabilityFactsReady } : {}),
          },
          ...(providerCapabilities ? { providerCapabilities } : {}),
          capabilities: {
            'images.async': imageMedia !== undefined,
            'videos.create': videoMedia !== undefined,
            'model-plaza': modelPlaza !== undefined,
            ...(options.capabilityReadiness
              ? {
                  'responses.ws': true,
                  'responses.compact': options.responsesCompactNativeSupply !== undefined,
                }
              : {}),
          },
        };
      },
    },
    ...(imageMedia ? { imageMedia } : {}),
    ...(videoMedia ? { videoMedia } : {}),
    // Batch 2 §2.1: the production composition always wires the scheduler
    // with the affinity port (required above), so the sticky-session
    // scheduling seam is unconditionally live here.
    stickyScheduling: true,
    modelPlaza,
    // Batch 5 §5.4 (task #19): content risk control — always wired with the
    // gateway database store; the service itself fails open when the feature
    // is disabled or the store errors, so this never gates startup.
    contentModeration: new SaasContentModerationService({
      store: new PostgresContentModerationStore(database),
      ...(options.riskControl?.emailSender ? { emailSender: options.riskControl.emailSender } : {}),
      ...(options.riskControl?.siteName ? { siteName: options.riskControl.siteName } : {}),
    }),
  });
}

/** Type-only aliases make the composition contract easy to inspect in tests. */
export type ManagedSaasGatewayRequestPreparationPort = RequestPreparationPort;
export type ManagedSaasGatewayDispatchPort = GatewayPreparedEvidenceDispatchPort;
