import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SaasCompositeModelRoutesService } from '../saas/billing/composite-routes/service.js';
import { SaasCustomerWalletQueryService } from '../saas/billing/customer-query.js';
import { SaasBillingGroupsService } from '../saas/billing/groups/service.js';
import { createBillingGroupSpendResolution } from '../saas/billing/groups/spend-resolution.js';
import { PlatformWalletLedgerService } from '../saas/billing/service.js';
import { SaasCatalogService } from '../saas/catalog/index.js';
import { createSaasConsoleHandler, type SaasConsoleHttpHandler } from '../saas/console/http.js';
import { SaasConsoleUsageQueryService } from '../saas/console/index.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../saas/db/credential-validation-worker-schema-readiness.js';
import {
  closeSaasDatabase,
  createSaasDatabase,
  pingSaasDatabase,
  type SaasDatabase,
  verifyCredentialValidationWorkerRuntimePrivileges,
  verifySaasRuntimeDatabasePrivileges,
} from '../saas/db/index.js';
import type {
  DeploymentEnvironment,
  DeploymentListenerConfig,
  ListenerName,
  ManagedSaasDeploymentConfig,
} from '../saas/deployment.js';
import {
  MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  managedSaasListenerNames,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../saas/deployment.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../saas/gateway/authorization-prelock.js';
import type { SaasGatewayHttpHandler } from '../saas/gateway/http-handler.js';
import { MODEL_PLAZA_SETTINGS_KEYS } from '../saas/gateway/model-plaza/settings.js';
import { mergeOpenCodeGoModelCatalog } from '../saas/gateway/opencode-go/model-catalog-sync.js';
import { createPostgresBillingGroupSpendAdmission } from '../saas/gateway/postgres-billing-group-spend.js';
import { PostgresPreDispatchCompensation } from '../saas/gateway/postgres-pre-dispatch-compensation.js';
import { createPostgresKeyBudgetAdmission } from '../saas/gateway/postgres-preparation-budget.js';
import { createPostgresPreparationCapacityPort } from '../saas/gateway/postgres-preparation-capacity.js';
import { createPostgresPreparationPorts } from '../saas/gateway/postgres-preparation-ports.js';
import { PostgresProviderAccountAffinity } from '../saas/gateway/postgres-provider-account-affinity.js';
import { PostgresRequestAdmissionGuard } from '../saas/gateway/postgres-request-admission-guard.js';
import { PostgresRequestPreparationEntitlementAdapter } from '../saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import {
  isProviderHttpTestAddressCapability,
  type ProviderHttpEgressAllowlist,
} from '../saas/gateway/provider-http-address.js';
import { parseProviderEgressAllowlistSettings } from '../saas/gateway/provider-http-egress-allowlist.js';
import { ConsoleEmailSender, type EmailSender, SmtpEmailSender } from '../saas/identity/email-sender.js';
import { EmailVerificationService } from '../saas/identity/email-verification-service.js';
import { createSaasIdentityHandler, type SaasIdentityHttpOptions } from '../saas/identity/http.js';
import { SaasIdentityService } from '../saas/identity/index.js';
import { RegistrationService } from '../saas/identity/register-service.js';
import {
  parseRegistrationAdmissionSettings,
  type RegistrationAdmissionSettings,
  resolveRegistrationAdmissionSettings,
} from '../saas/identity/registration-settings.js';
import { type CaptchaProof, createCaptchaProof } from '../saas/identity/turnstile-service.js';
import { createKeyBudgetResolution } from '../saas/keys/budget-resolution.js';
import { createSaasKeyHandler, type SaasKeyHttpHandler } from '../saas/keys/http.js';
import { PostgresSupplyProfileResolver } from '../saas/keys/resolver.js';
import { KeyService } from '../saas/keys/service.js';
import { MarketingAffiliateService } from '../saas/marketing/affiliate.js';
import {
  createMarketingAffiliateCustomerHttpHandler,
  createMarketingAffiliateOpsHttpHandler,
  type MarketingAffiliateHttpHandler,
} from '../saas/marketing/affiliate-http.js';
import { MarketingAnnouncementService } from '../saas/marketing/announcements.js';
import {
  createMarketingAnnouncementCustomerHttpHandler,
  createMarketingAnnouncementPlatformHttpHandler,
  type MarketingAnnouncementHttpHandler,
} from '../saas/marketing/announcements-http.js';
import {
  createMarketingCustomerRedeemHandler,
  createMarketingOpsRedeemCodesHandler,
  type MarketingRedeemHttpHandler,
} from '../saas/marketing/http.js';
import { MarketingPromoCodeService } from '../saas/marketing/promo-codes.js';
import { createMarketingOpsPromoCodesHandler, type MarketingPromoHttpHandler } from '../saas/marketing/promo-http.js';
import { MarketingRedeemCodeService } from '../saas/marketing/redeem-codes.js';
import { MarketingRegistrationRewards } from '../saas/marketing/registration-rewards.js';
import { SaasMeteringService } from '../saas/metering/service.js';
import {
  createUnknownOutcomePlatformHttpHandler,
  type UnknownOutcomePlatformHttpHandler,
} from '../saas/metering/unknown-outcome-platform-http.js';
import {
  createUnknownOutcomeRecoveryWorkflow,
  type UnknownOutcomeReconciliationWorker,
} from '../saas/metering/unknown-outcome-recovery-worker.js';
import {
  startUnknownOutcomeScanner,
  type UnknownOutcomeScannerHandle,
  type UnknownOutcomeScannerSchedulerOptions,
} from '../saas/metering/unknown-outcome-scanner-scheduler.js';
import { UsageCorrectionService } from '../saas/metering/usage-correction.js';
import {
  createUsageCorrectionPlatformHttpHandler,
  type UsageCorrectionPlatformHttpHandler,
} from '../saas/metering/usage-correction-platform-http.js';
import {
  type AlertEvaluatorWorkerHandle,
  type AlertSilencesHttpHandler,
  type ChannelStatusWorkerHandle,
  createAlertSilencesHttpHandler,
  createObservabilityHttpHandler,
  createPostgresAlertSilencesAuditWriter,
  getChannelStatusPage,
  ObservabilityAlertService,
  ObservabilityAlertSilenceService,
  type ObservabilityHttpHandler,
  type ReportSchedulerWorkerHandle,
  refreshSaasRuntimeGauges,
  renderSaasMetrics,
  startAlertEvaluatorWorker,
  startChannelStatusWorker,
  startReportSchedulerWorker,
} from '../saas/observability/index.js';
import type { PaymentProviderAdapter, PaymentProviderRefundAdapter } from '../saas/payments/adapter.js';
import { SaasCustomerPaymentOrderQueryService } from '../saas/payments/customer-order-query.js';
import {
  type CustomerRefundQueryContext,
  CustomerRefundQueryError,
  SaasCustomerRefundQueryService,
} from '../saas/payments/customer-refund-query.js';
import {
  createSaasCustomerPaymentOrderHistoryHandler,
  createSaasCustomerRefundHistoryHandler,
  createSaasPaymentHandler,
  type SaasPaymentHttpHandler,
} from '../saas/payments/http.js';
import { createPlatformPaymentRefundOperations } from '../saas/payments/platform-refund-operations.js';
import {
  createPlatformRefundHttpHandler,
  type PlatformRefundHttpHandler,
} from '../saas/payments/platform-refunds-http.js';
import { type PaymentRefundWorkerHandle, startPaymentRefundWorker } from '../saas/payments/refund-worker.js';
import { PaymentRefundService } from '../saas/payments/refunds.js';
import { PaymentFulfillmentService } from '../saas/payments/service.js';
import type {
  PaymentCheckoutOptions,
  PaymentCheckoutRedirectPolicy,
  PaymentWalletTopUpPolicy,
} from '../saas/payments/types.js';
import { type PaymentWebhookWorkerHandle, startPaymentWebhookWorker } from '../saas/payments/worker.js';
import { createSaasPlanCatalogHandler, type SaasPlanHttpHandler } from '../saas/plans/http.js';
import { ByokServicePlanService } from '../saas/plans/service.js';
import { createPlatformAdminAccessService } from '../saas/platform/access/index.js';
import {
  type AccountProbeHttpHandler,
  createAccountProbeHttpHandler,
  createPostgresProbeMonitorAdminStore,
} from '../saas/platform/account-probe-http.js';
import { PlatformAuditQueryService } from '../saas/platform/audit/index.js';
import {
  createPlatformAdminAuthHandler,
  PLATFORM_ADMIN_AUTH_PREFIX,
  type PlatformAdminAuthHttpHandler,
} from '../saas/platform/auth/http.js';
import { PlatformAdminAuthService } from '../saas/platform/auth/service.js';
import {
  type BillingGroupsHttpHandler,
  createBillingGroupsHttpHandler,
  createPostgresBillingGroupsAuditWriter,
} from '../saas/platform/billing-groups-http.js';
import {
  createPublicBrandSettingsHttpHandler,
  type PublicBrandSettingsHttpHandler,
} from '../saas/platform/brand/http.js';
import {
  BRAND_SETTINGS_KEY_PREFIX,
  EMPTY_BRAND_SNAPSHOT,
  injectBrandAppConfig,
  type PublicBrandSnapshot,
} from '../saas/platform/brand/snapshot.js';
import {
  type CachedBrandSnapshotReader,
  createCachedBrandSnapshotReader,
  PublicBrandSnapshotStore,
  type PublicBrandSnapshotWorkerHandle,
  startPublicBrandSnapshotWorker,
} from '../saas/platform/brand/store.js';
import { PlatformCapacityPolicyService } from '../saas/platform/capacity-policy-service.js';
import { PlatformCatalogQueryService } from '../saas/platform/catalog/index.js';
import { CodexOAuthBindingService, InMemoryBindingSessionStore } from '../saas/platform/codex-oauth/binding-service.js';
import { type CodexOauthHttpHandler, createCodexOauthHttpHandler } from '../saas/platform/codex-oauth/http.js';
import {
  createPostgresCodexCatalogBindingResolver,
  createProviderSupplyCodexCredentialSink,
} from '../saas/platform/codex-oauth/supply-sink.js';
import {
  type CompositeModelRoutesHttpHandler,
  createCompositeModelRoutesHttpHandler,
  createPostgresCompositeModelRoutesAuditWriter,
} from '../saas/platform/composite-routes-http.js';
import {
  createPlatformCredentialRewrapHttpHandler,
  type PlatformCredentialRewrapHttpHandler,
} from '../saas/platform/credential-rewrap-http.js';
import { createPlatformCredentialRewrapOperations } from '../saas/platform/credential-rewrap-operations.js';
import {
  createEgressProxiesHttpHandler,
  createPostgresEgressProxyAdminStore,
  createPostgresEgressProxyAuditWriter,
  type EgressProxiesHttpHandler,
} from '../saas/platform/egress-proxies-http.js';
import {
  PlatformOperatorManagementService,
  PlatformTenantLifecycleService,
  PlatformUserGovernanceService,
} from '../saas/platform/governance/index.js';
import {
  GrokOAuthBindingService,
  InMemoryGrokBindingSessionStore,
} from '../saas/platform/grok-oauth/binding-service.js';
import { createGrokOauthHttpHandler, type GrokOauthHttpHandler } from '../saas/platform/grok-oauth/http.js';
import {
  createPostgresGrokCatalogBindingResolver,
  createProviderSupplyGrokCredentialSink,
} from '../saas/platform/grok-oauth/supply-sink.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminCapacityPolicyTargetSelectors,
  type PlatformAdminReadHttpHandler,
} from '../saas/platform/http/index.js';
import {
  createOpencodeGoModelCatalogHttpHandler,
  createOpencodeGoRulesHttpHandler,
  createPostgresOpencodeGoRulesAuditWriter,
  createPostgresOpencodeGoRulesStore,
  type OpencodeGoModelCatalogHttpHandler,
  type OpencodeGoRulesHttpHandler,
} from '../saas/platform/opencode-go-rules-http.js';
import { PlatformOperationsSummaryService } from '../saas/platform/operations/index.js';
import { createPluginsHttpHandler, type PluginsHttpHandler } from '../saas/platform/plugins-http.js';
import {
  createPostgresRiskControlAuditWriter,
  createRiskControlHttpHandler,
  type RiskControlHttpHandler,
} from '../saas/platform/risk-control-http.js';
import {
  createPlatformSettingsHttpHandler,
  PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION,
  type PlatformSettingsHttpHandler,
  PlatformSettingsService,
} from '../saas/platform/settings/index.js';
import { PluginAdminService } from '../saas/plugins/admin-service.js';
import { PluginHostClient, PostgresPluginRouteReader } from '../saas/plugins/gateway-plugin-router.js';
import { type StartPluginHostRuntimeOptions, startPluginHostRuntime } from '../saas/plugins/plugin-host-runtime.js';
import { PostgresPluginStore } from '../saas/plugins/store.js';
import { SaasPricingService } from '../saas/pricing/index.js';
import type { ModerationEmailSender } from '../saas/risk/moderation.js';
import { PostgresRiskControlAdminStore } from '../saas/risk/postgres-store.js';
import {
  type RiskControlRetentionWorkerHandle,
  startRiskControlRetentionWorker,
} from '../saas/risk/retention-worker.js';
import { loadCredentialValidationTargetsModule } from '../saas/runtime/credential-validation-targets-module.js';
import {
  assertCustomerMfaDeploymentConfiguration,
  createCustomerMfaForDeployment,
} from '../saas/runtime/customer-mfa-capability.js';
import {
  assertCustomerPasskeyDeploymentConfiguration,
  createCustomerPasskeyForDeployment,
} from '../saas/runtime/customer-passkey-capability.js';
import {
  type LoadedProviderCredentialUnsealingKms,
  loadGatewayProviderCredentialUnsealingKms,
} from '../saas/runtime/gateway-provider-credential-kms.js';
import {
  type LoadedManagedSaasGatewayRuntimeModule,
  loadManagedSaasGatewayRuntimeModule,
} from '../saas/runtime/gateway-runtime-module.js';
import {
  loadManagedSaasProviders,
  MANAGED_SAAS_REDIS_KEY_PREFIX,
  type ManagedRateLimiter,
  type ManagedSaasProviders,
  type ProviderModuleImporter,
  type RedisProvider,
} from '../saas/runtime/providers.js';
import { createRedisProvider } from '../saas/runtime/redis-rate-limit-provider.js';
import {
  type LoadedValidationWorkerProviderCredentialKms,
  loadValidationWorkerProviderCredentialKms,
  SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../saas/runtime/validation-worker-provider-credential-kms.js';
import { PostgresCnProvidersQuotaStore } from '../saas/supply/cn-providers-quota-store-postgres.js';
import {
  type CnProvidersQuotaWorkerHandle,
  type CnProvidersQuotaWorkerOptions,
  startCnProvidersQuotaWorker,
} from '../saas/supply/cn-providers-quota-worker.js';
import type { CredentialValidationTransportTestOptions } from '../saas/supply/credential-validation-http-transport.js';
import { compileApprovedCredentialValidationTargets } from '../saas/supply/credential-validation-targets.js';
import {
  type CredentialValidationWorkerHandle,
  type CredentialValidationWorkerOptions,
  startCredentialValidationWorker as startValidationWorkerLoop,
} from '../saas/supply/credential-validation-worker.js';
import { type CustomerByokHttpHandler, createCustomerByokHttpHandler } from '../saas/supply/customer-http.js';
import {
  type EgressProxyProbeWorkerHandle,
  type EgressProxyProbeWorkerOptions,
  PostgresEgressProxyProbeWorkerStore,
  startEgressProxyProbeWorker,
} from '../saas/supply/egress-proxy-probe-worker.js';
import {
  type GeminiUsageWorkerHandle,
  type GeminiUsageWorkerOptions,
  startGeminiUsageWorker,
} from '../saas/supply/gemini-usage-worker.js';
import { ProviderSupplyService } from '../saas/supply/index.js';
import {
  type OauthCredentialRotator,
  type OauthTokenRefreshWorkerHandle,
  startOauthTokenRefreshWorker,
} from '../saas/supply/oauth-token-refresh-worker.js';
import {
  PostgresOpencodeGoUsageStore,
  type PostgresOpencodeGoUsageStoreOptions,
} from '../saas/supply/opencode-go-usage-store-postgres.js';
import {
  type OpencodeGoUsageStore,
  type OpencodeGoUsageWorkerHandle,
  type OpencodeGoUsageWorkerOptions,
  startOpencodeGoUsageWorker,
} from '../saas/supply/opencode-go-usage-worker.js';
import { createOpenRouterModelPricingSyncStore } from '../saas/supply/openrouter-model-pricing-sync-store.js';
import {
  type OpenRouterModelPricingSyncStore,
  type OpenRouterModelPricingSyncWorkerHandle,
  type OpenRouterModelPricingSyncWorkerOptions,
  startOpenRouterModelPricingSyncWorker,
} from '../saas/supply/openrouter-model-pricing-sync-worker.js';
import {
  PostgresProbeMonitorStore,
  type ProbeMonitorWorkerHandle,
  type ProbeMonitorWorkerOptions,
  startProbeMonitorWorker,
  startProbeRunRetentionWorker,
} from '../saas/supply/probe-monitor-worker.js';
import {
  PostgresProviderQuotaSnapshotStore,
  type PostgresProviderQuotaSnapshotStoreOptions,
} from '../saas/supply/provider-account-quota-snapshot-store-postgres.js';
import {
  type QuotaSyncWorkerHandle,
  type QuotaSyncWorkerOptions,
  startQuotaSyncWorker as startQuotaSyncWorkerLoop,
} from '../saas/supply/quota-sync-worker.js';
import type { ApprovedCredentialValidationTarget } from '../saas/supply/types.js';
import {
  type AnnouncementFanoutWorkerHandle,
  createAnnouncementFanoutEventPort,
  startAnnouncementFanoutWorker,
} from '../saas/webhooks/announcement-fanout-worker.js';
import { CustomerWebhookDeliveryWorker, type CustomerWebhookWorkerOptions } from '../saas/webhooks/delivery-worker.js';
import type { CustomerWebhookEgressTransport } from '../saas/webhooks/egress-transport.js';
import { CustomerWebhookEndpointService } from '../saas/webhooks/endpoint-service.js';
import { type CustomerWebhookHttpHandler, createCustomerWebhookHandler } from '../saas/webhooks/http.js';
import { CustomerWebhookNotificationScanner } from '../saas/webhooks/notification-scanner.js';
import {
  CUSTOMER_WEBHOOK_DEFAULT_HISTORY_RETENTION_MS,
  CUSTOMER_WEBHOOK_MAX_HISTORY_RETENTION_MS,
  CUSTOMER_WEBHOOK_MIN_HISTORY_RETENTION_MS,
  PostgresCustomerWebhookDeliveryStore,
} from '../saas/webhooks/postgres-store.js';
import { createCustomerWebhookEventProducer } from '../saas/webhooks/producers.js';
import type { WebhookSigningSecretProtector } from '../saas/webhooks/signing-secret-protector.js';
import { CustomerWebhookTenantPolicyService } from '../saas/webhooks/tenant-policy-service.js';
import {
  createManagedSaasGatewayProductionComposition,
  type ManagedSaasGatewayComposition,
  type ManagedSaasGatewayProductionOptions,
} from './managed-saas-gateway.js';

const CUSTOMER_MOUNT = '/console' as const;
const PLATFORM_MOUNT = '/admin' as const;
const GATEWAY_MOUNT = '/v1' as const;
const CUSTOMER_API_PREFIX = '/console/api/v1' as const;
const PLATFORM_API_PREFIX = '/admin/api/v1' as const;
const DEFAULT_CUSTOMER_SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PLATFORM_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const SAAS_PLATFORM_AUDIT_CURSOR_SECRET = 'SAAS_PLATFORM_AUDIT_CURSOR_SECRET' as const;
const PLATFORM_AUDIT_CURSOR_SECRET_MIN_BYTES = 16;
const PLATFORM_AUDIT_CURSOR_SECRET_MAX_BYTES = 4096;

export type ManagedSaasDatabase = SaasDatabase & {
  /** Added by the managed database implementation; startup never calls migrate(). */
  verifySchema?: () => Promise<void>;
};

export interface ManagedSaasRuntime {
  readonly deployment: ManagedSaasDeploymentConfig;
  readonly database: ManagedSaasDatabase;
  /** Control-plane provider capabilities are absent from inference/worker workloads. */
  readonly providers: ManagedSaasProviders | null;
  /** Null means the listener is intentionally mounted as GATEWAY_UNAVAILABLE. */
  readonly gateway: ManagedSaasGatewayComposition | null;
  /** Present only in the dedicated credential-validation-worker workload. */
  readonly credentialValidationWorker: CredentialValidationWorkerHandle | null;
  /** D4 quota sync loop sharing the credential-validation-worker workload. */
  readonly quotaSyncWorker: QuotaSyncWorkerHandle | null;
  /** R5b OpenCode Go usage-snapshot loop; same workload as quota sync. */
  readonly opencodeGoUsageWorker: OpencodeGoUsageWorkerHandle | null;
  /** Batch-3 CN-provider coding-plan quota probe loop; same workload. */
  readonly cnProvidersQuotaWorker: CnProvidersQuotaWorkerHandle | null;
  /** R-dormant (batch 2.2): the gemini usage-snapshot loop; same workload. */
  readonly geminiUsageWorker: GeminiUsageWorkerHandle | null;
  /** F6 OpenRouter model-catalog/pricing sync loop; opt-in on the worker workload. */
  readonly openRouterModelPricingSyncWorker: OpenRouterModelPricingSyncWorkerHandle | null;
  /** R3 egress-proxy probe + expiry-sweep loop; same workload as quota sync. */
  readonly egressProxyProbeWorker: EgressProxyProbeWorkerHandle | null;
  /** R6a scheduled probe monitor loop; same workload as quota sync. */
  readonly probeMonitorWorker: ProbeMonitorWorkerHandle | null;
  /** R6a probe run retention loop; control-plane workload only. */
  readonly probeRunRetentionWorker: ProbeMonitorWorkerHandle | null;
  /** Batch-5 §5.4 risk-control retention loop; control-plane workload only. */
  readonly riskControlRetentionWorker: RiskControlRetentionWorkerHandle | null;
  /** Batch-5 §5.2 public brand snapshot materialization loop; control-plane workload only. */
  readonly publicBrandSnapshotWorker: PublicBrandSnapshotWorkerHandle | null;
  /** R4 OAuth refresh loop; only when the deployment wires a privileged rotator. */
  readonly oauthTokenRefreshWorker: OauthTokenRefreshWorkerHandle | null;
  /** G4.5 announcement fan-out loop; only when customer webhooks are enabled. */
  readonly announcementFanoutWorker: AnnouncementFanoutWorkerHandle | null;
  /** Present only when the control-plane owns the unknown-outcome recovery loop. */
  readonly unknownOutcomeScanner: UnknownOutcomeScannerHandle | null;
  /** Only listeners assigned to this workload role are present and bound. */
  readonly listeners: Readonly<Partial<Record<ListenerName, Server>>>;
  close(): Promise<void>;
}

export interface ManagedSaasPaymentsOptions {
  readonly adapter: PaymentProviderAdapter;
  /** Omitted keeps platform refund routes and reconciliation worker disabled. */
  readonly refundAdapter?: PaymentProviderRefundAdapter;
  readonly providerKey: string;
  readonly merchantId: string;
  /** Explicit action policy; absent redirect policy means no redirect action is exposed. */
  readonly checkout?: PaymentCheckoutOptions;
  /** Compatibility alias for direct provider redirect policy configuration. */
  readonly checkoutRedirectPolicies?: readonly PaymentCheckoutRedirectPolicy[];
  /** Without an explicit currency and range, customer wallet checkout stays unavailable. */
  readonly walletTopUpPolicy?: PaymentWalletTopUpPolicy;
  readonly submissionLeaseTtlMs?: number;
}

export interface ManagedSaasCustomerWebhooksOptions {
  /** Customer routes and delivery are created only when this explicit switch is true. */
  readonly enabled: boolean;
  /** Dedicated trusted KMS-backed signing-secret protector; provider-credential crypto is not compatible. */
  readonly signingSecretProtector?: WebhookSigningSecretProtector;
  /** Trusted SSRF-pinned egress transport supplied by production composition. */
  readonly egressTransport?: CustomerWebhookEgressTransport;
  readonly workerOptions?: CustomerWebhookWorkerOptions;
  readonly intervalMs?: number;
  /**
   * F3: periodic wallet.low_balance / api_key.expiring sweep. Absent disables
   * the scanner (delivery of state-machine events is unaffected).
   */
  readonly notificationScan?: {
    /** Bounded delay between completed sweeps (10s..1h; default 5min). */
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly expiringKeyWindowMs?: number;
  };
  /**
   * F4: periodic pruneTerminalHistory pass over terminal delivery/attempt
   * metadata. Absent disables retention pruning (immutable event facts and
   * idempotency tombstones are never pruned either way).
   */
  readonly retentionPrune?: {
    /** Bounded delay between completed prune passes (1min..24h; default 1h). */
    readonly intervalMs?: number;
    /** Terminal-row retention window (7..365 days; default 90 days). */
    readonly retentionMs?: number;
    /** Maximum deliveries pruned per pass (1..1000; default 100). */
    readonly limit?: number;
  };
  /**
   * G4.5: periodic platform.maintenance fan-out sweep over the announcement
   * publish cursor. Absent uses the worker defaults (batch 10, 15s interval);
   * publish itself stays O(1) either way.
   */
  readonly announcementFanout?: {
    readonly intervalMs?: number;
    readonly batchSize?: number;
  };
}

export interface ManagedSaasUnknownOutcomeScannerOptions {
  /** Bounded delay between completed scanner cycles. */
  readonly intervalMs?: number;
  /** Durable scanner claim batch size. */
  readonly batchSize?: number;
  /** Durable scanner lease duration. */
  readonly leaseMs?: number;
  /** Maximum durable scanner attempts before operator escalation. */
  readonly maxAttempts?: number;
}

export interface ManagedSaasStartOptions {
  /** The environment snapshot used both for mode resolution and provider loading. */
  environment?: DeploymentEnvironment;
  /** Override the bundled web root in tests or alternate distributions. */
  webDistPath?: string;
  customerSessionTtlSeconds?: number;
  platformSessionTtlSeconds?: number;
  /** Injectable PG seam; the default is the production PostgreSQL pool. */
  createDatabase?: (options: { connectionString: string }) => ManagedSaasDatabase;
  pingDatabase?: (database: ManagedSaasDatabase) => Promise<void>;
  verifySchema?: (database: ManagedSaasDatabase) => Promise<void>;
  /** Control-plane-only readiness check for the 049/050/051 unknown-outcome schema. */
  verifyUnknownOutcomeSchema?: (database: ManagedSaasDatabase) => Promise<void>;
  closeDatabase?: (database: ManagedSaasDatabase) => Promise<void>;
  /** Injectable provider seam; the default loads the configured KMS and Redis modules. */
  loadProviders?: (
    config: ManagedSaasDeploymentConfig,
    environment: DeploymentEnvironment,
  ) => Promise<ManagedSaasProviders>;
  /** Worker-only decrypt KMS loader; it is never consulted by gateway/control-plane roles. */
  loadValidationWorkerKms?: (
    environment: DeploymentEnvironment,
  ) => Promise<LoadedValidationWorkerProviderCredentialKms | undefined>;
  /** Worker-only metadata import seam; it does not receive database, KMS, job or HTTP capabilities. */
  credentialValidationTargetsModuleImporter?: ProviderModuleImporter;
  /** Runtime module import seam; only the isolated gateway workload consults it. */
  gatewayRuntimeModuleImporter?: ProviderModuleImporter;
  /** Trusted metadata-only customer MFA module; no operations/readiness override. */
  customerMfaCapabilityModuleImporter?: ProviderModuleImporter;
  customerPasskeyCapabilityModuleImporter?: ProviderModuleImporter;
  /** Dedicated decrypt-only KMS import seam; only the isolated gateway workload consults it. */
  gatewayProviderCredentialKmsImporter?: ProviderModuleImporter;
  /** Deterministic seam for the isolated validation loop. */
  startCredentialValidationWorker?: (
    database: SaasDatabase,
    kms: LoadedValidationWorkerProviderCredentialKms,
    options: CredentialValidationWorkerOptions,
  ) => CredentialValidationWorkerHandle;
  /** Optional worker loop tuning or test fetch; deployment identity is always supplied by config. */
  /** Batch-5 §5.1: plugin-host workload seams (role `plugin-host` only). */
  pluginHost?: StartPluginHostRuntimeOptions;
  credentialValidationWorkerOptions?: Partial<
    Omit<CredentialValidationWorkerOptions, 'deployment' | 'environment' | 'approvedTargets' | 'transportTestOptions'>
  >;
  /** Deterministic seam for the D4 quota sync loop sharing the worker workload. */
  startQuotaSyncWorker?: (
    database: SaasDatabase,
    kms: LoadedValidationWorkerProviderCredentialKms,
    options: QuotaSyncWorkerOptions,
  ) => QuotaSyncWorkerHandle;
  /** Optional quota loop tuning or test fetch; deployment identity is always supplied by config. */
  quotaSyncWorkerOptions?: Partial<Omit<QuotaSyncWorkerOptions, 'deployment' | 'environment'>>;
  /** Deterministic seam for the R5b OpenCode Go usage store backing the worker loop. */
  createOpencodeGoUsageStore?: (
    database: SaasDatabase,
    kms: LoadedValidationWorkerProviderCredentialKms,
    options: PostgresOpencodeGoUsageStoreOptions,
  ) => OpencodeGoUsageStore;
  /** Optional usage loop tuning or test fetch; deployment identity always reaches the store. */
  opencodeGoUsageWorkerOptions?: Partial<OpencodeGoUsageWorkerOptions>;
  cnProvidersQuotaWorkerOptions?: Partial<CnProvidersQuotaWorkerOptions>;
  /** Deterministic seam for the R-dormant quota-snapshot store (gemini loop). */
  createQuotaSnapshotStore?: (
    database: SaasDatabase,
    options: PostgresProviderQuotaSnapshotStoreOptions,
  ) => PostgresProviderQuotaSnapshotStore;
  /** Optional gemini usage loop tuning; same workload as quota sync. */
  geminiUsageWorkerOptions?: Partial<GeminiUsageWorkerOptions>;
  /**
   * F6 (task #39): OpenRouter catalog/pricing sync loop on the
   * credential-validation-worker workload. Presence of this option ENABLES
   * the loop — the R4 OAuth-refresh opt-in precedent — because the sync
   * writes provider catalog, public-model and supplier-cost rows, which the
   * restricted validation-worker role cannot do by default (it is SELECT-only
   * on the catalog). Deployments enable it only after granting those INSERT
   * privileges to the role, or by wiring a custom store bound to a role that
   * already has them. Absent keeps the workload exactly as before.
   */
  openRouterModelPricingSync?: {
    /** Custom store seam (tests or a privileged-role binding); default is the service-backed store on this database. */
    readonly store?: OpenRouterModelPricingSyncStore;
    /** Optional sync loop tuning or test fetch. */
    readonly worker?: Partial<OpenRouterModelPricingSyncWorkerOptions>;
  };
  /** R3: optional egress-proxy probe/sweep loop tuning. */
  egressProxyProbeWorkerOptions?: EgressProxyProbeWorkerOptions;
  /** R6a: deterministic seam for the probe monitor loop on the worker workload. */
  startProbeMonitorWorker?: (
    store: PostgresProbeMonitorStore,
    options: ProbeMonitorWorkerOptions,
  ) => ProbeMonitorWorkerHandle;
  /** R6a: optional probe monitor loop tuning. */
  probeMonitorWorkerOptions?: ProbeMonitorWorkerOptions;
  /** R6a: deterministic seam for the control-plane probe run retention loop. */
  startProbeRunRetentionWorker?: (
    database: SaasDatabase,
    options: ProbeMonitorWorkerOptions,
  ) => ProbeMonitorWorkerHandle;
  /** R6a: optional probe run retention loop tuning. */
  probeRunRetentionWorkerOptions?: ProbeMonitorWorkerOptions;
  /**
   * Batch-5 §5.2 OEM white-label: optional public brand snapshot
   * materialization loop tuning (control-plane workload only; the loop runs
   * with the default 60s cadence otherwise).
   */
  publicBrandSnapshot?: { readonly intervalMs?: number };
  /**
   * R4: the privileged rotation seam for the OAuth refresh worker. Rotation
   * writes the new credential version chain through the audited supply path,
   * which the restricted worker role cannot perform; a deployment wires this
   * only where a control-plane-grade persistence entry and operator identity
   * are available (combined/dev topologies or a reviewed cross-role
   * composition). Absent means the refresh worker is not started.
   */
  oauthTokenRefreshRotator?: OauthCredentialRotator;
  /** Optional refresh loop tuning; batchSize/pollIntervalMs bounds are enforced by the worker. */
  oauthTokenRefreshWorkerOptions?: { readonly batchSize?: number; readonly pollIntervalMs?: number };
  /**
   * R4 production assembly (docs/oauth-refresh-production-assembly.md,
   * decision A): run the OAuth refresh worker inside the control-plane
   * workload with the audited rotation path. Both fields are required to
   * enable; absence keeps the worker stopped (pre-R4 behavior). Mutually
   * exclusive with oauthTokenRefreshRotator (the alternative worker-workload wiring).
   */
  oauthTokenRefresh?: {
    /** Deployment-injected decrypt-only KMS for envelope unsealing (pilot: the software module instance). */
    readonly unsealingKms: import('../saas/credentials/provider-crypto.js').ProviderCredentialUnsealingKms;
    /** Existing saas_users identity for the rotation audit actor (bootstrap admin or a dedicated operations account). */
    readonly operatorUserId: string;
    readonly batchSize?: number;
    readonly pollIntervalMs?: number;
  };
  /** Trusted SDK metadata; mutually exclusive with the configured targets module. Neither source grants catalog approval. */
  credentialValidationTargets?: readonly ApprovedCredentialValidationTarget[];
  /** Requires the opaque Node-test-runner CA/address capability; never a production DNS/TLS override. */
  credentialValidationWorkerTestTransport?: CredentialValidationTransportTestOptions;
  /** Explicit production payment composition; omission leaves payment routes unmounted. */
  payments?: ManagedSaasPaymentsOptions;
  /** Explicit trusted webhook composition; enabled startup requires a dedicated protector and egress transport. */
  customerWebhooks?: ManagedSaasCustomerWebhooksOptions;
  /** The durable unknown-outcome scanner and operator routes are control-plane-only. */
  unknownOutcomeScanner?: ManagedSaasUnknownOutcomeScannerOptions;
  /** Injectable workflow seam for startup tests; production uses the real authorization adapter by default. */
  createUnknownOutcomeRecoveryWorkflow?: typeof createUnknownOutcomeRecoveryWorkflow;
  /** Injectable scheduler seam for lifecycle tests. */
  startUnknownOutcomeScanner?: (
    worker: Pick<UnknownOutcomeReconciliationWorker, 'runOnce'>,
    options: UnknownOutcomeScannerSchedulerOptions,
  ) => UnknownOutcomeScannerHandle;
  /** Optional precomposed payment routes mounted on the customer listener. */
  paymentHandler?: SaasPaymentHttpHandler;
  /** Injectable listener seam for deterministic bind and cleanup tests. */
  createListener?: (name: ListenerName, handler: RequestListener) => Server;
  /** Combined-mode compatibility injection. Dedicated gateway workloads use their trusted runtime module. */
  gateway?: ManagedSaasGatewayProductionOptions;
  /** Disable process signal registration for direct unit tests. */
  installSignalHandlers?: boolean;
  /** Called only after PG/schema/providers are ready and every listener is bound. */
  onReady?: (runtime: ManagedSaasRuntime) => void | Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function requestPath(req: IncomingMessage): string | undefined {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://managed-saas.invalid').pathname);
  } catch {
    return undefined;
  }
}

function isMountedPath(pathname: string, mount: string): boolean {
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

function isApiPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function deploymentListener(deployment: ManagedSaasDeploymentConfig, name: ListenerName): DeploymentListenerConfig {
  const listener = deployment.listeners[name];
  if (!listener) throw new Error(`Managed SaaS ${name} listener is not configured for this workload`);
  return listener;
}

function hasResidualEncodedPathControl(pathname: string): boolean {
  return /%(?:00|2e|2f|5c)/i.test(pathname);
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId = `managed_${randomUUID()}`,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code, message, requestId } }));
}

/**
 * Serves the mounted web console (customer /console, platform /admin).
 *
 * Batch-5 §5.2 OEM white-label: when a brand reader is wired, every HTML
 * document is served through `injectBrandAppConfig` — the materialized public
 * brand snapshot is embedded as `window.__APP_CONFIG__` (nonce'd script, HTML
 * breakers escaped) and the CSP is derived from the snapshot (logo origin →
 * img-src, iframe page origins → frame-src, configurable frame-ancestors).
 * A reader failure serves the empty snapshot fail-open: the console must
 * never hard-fail on a brand hiccup. Non-HTML assets keep the fixed baseline
 * CSP and stream unchanged; an empty snapshot keeps the pre-brand response
 * byte-identical.
 *
 * Exported for the brand injection tests (the createManagedOauthTokenRefresh-
 * Rotator test-seam precedent).
 */
export async function serveMountedStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mount: typeof CUSTOMER_MOUNT | typeof PLATFORM_MOUNT,
  webDistPath: string | undefined,
  brandReader?: Pick<CachedBrandSnapshotReader, 'read'>,
): Promise<void> {
  if (!webDistPath || (req.method !== 'GET' && req.method !== 'HEAD')) {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }
  if (pathname === mount) {
    res.writeHead(308, { location: `${mount}/` });
    res.end();
    return;
  }
  if (!pathname.startsWith(`${mount}/`) || isApiPath(pathname, `${mount}/api`)) {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  const file = pathname.slice(`${mount}/`.length);
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    hasResidualEncodedPathControl(file) ||
    file.startsWith('/') ||
    file
      .split('/')
      .some(
        (part) =>
          part === '..' || part.startsWith('.') || ['admin-exports', 'admin-backups', 'data', 'secrets'].includes(part),
      )
  ) {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }
  if (basename(file) === 'config.json' || (extname(file) && !MIME_TYPES[extname(file)])) {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  let root: string;
  try {
    if (!existsSync(webDistPath)) {
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
      return;
    }
    root = realpathSync(resolve(webDistPath));
  } catch {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  let target = resolve(root, file || 'index.html');
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (file && (extname(file) || !String(req.headers.accept ?? '').includes('text/html'))) {
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
      return;
    }
    target = resolve(root, 'index.html');
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }
  try {
    const rel = relative(root, realpathSync(target));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
      return;
    }
  } catch {
    sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  const extension = extname(target);
  if (extension === '.html' && brandReader !== undefined) {
    // OEM white-label HTML path: read → inject → serve with the derived CSP.
    let snapshot: PublicBrandSnapshot;
    try {
      snapshot = await brandReader.read();
    } catch {
      snapshot = EMPTY_BRAND_SNAPSHOT;
    }
    const source = await readFile(target, 'utf8');
    const injected = injectBrandAppConfig(source, snapshot);
    const body = Buffer.from(injected.html, 'utf8');
    res.writeHead(200, {
      'content-type': MIME_TYPES['.html'] ?? 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': injected.contentSecurityPolicy,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': statSync(target).size,
    'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target)
    .on('error', () => {
      if (!res.destroyed) res.destroy();
    })
    .pipe(res);
}

function safeHandlerError(res: ServerResponse): void {
  sendJsonError(res, 500, 'INTERNAL_ERROR', 'The request could not be completed');
}

function createCustomerHandler(
  keyHandler: SaasKeyHttpHandler,
  identityHandler: ReturnType<typeof createSaasIdentityHandler>,
  planHandler: SaasPlanHttpHandler,
  consoleHandler: SaasConsoleHttpHandler,
  customerWebhookHandler: CustomerWebhookHttpHandler | undefined,
  byokHandler: CustomerByokHttpHandler,
  refundHistoryHandler: SaasPaymentHttpHandler,
  paymentOrderHistoryHandler: SaasPaymentHttpHandler,
  marketingRedeemHandler: MarketingRedeemHttpHandler,
  marketingAnnouncementsHandler: MarketingAnnouncementHttpHandler,
  marketingAffiliateHandler: MarketingAffiliateHttpHandler,
  paymentHandler: SaasPaymentHttpHandler | undefined,
  webDistPath: string | undefined,
  brandReader?: Pick<CachedBrandSnapshotReader, 'read'>,
): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
        return;
      }
      if (await refundHistoryHandler(req, res)) return;
      if (await paymentOrderHistoryHandler(req, res)) return;
      if (await marketingRedeemHandler(req, res)) return;
      if (await marketingAnnouncementsHandler(req, res)) return;
      if (await marketingAffiliateHandler(req, res)) return;
      if (paymentHandler && (await paymentHandler(req, res))) return;
      if (isApiPath(pathname, CUSTOMER_API_PREFIX)) {
        if (await keyHandler(req, res)) return;
        if (await identityHandler(req, res)) return;
        if (await planHandler(req, res)) return;
        if (customerWebhookHandler && (await customerWebhookHandler(req, res))) return;
        if (await consoleHandler(req, res)) return;
        if (await byokHandler(req, res)) return;
        sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      if (isMountedPath(pathname, CUSTOMER_MOUNT)) {
        await serveMountedStatic(req, res, pathname, CUSTOMER_MOUNT, webDistPath, brandReader);
        return;
      }
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    })().catch(() => safeHandlerError(res));
  };
}

async function resolveCustomerRefundTenantContext(
  database: ManagedSaasDatabase,
  input: { readonly userId: string; readonly tenantId: string },
): Promise<CustomerRefundQueryContext> {
  const result = await database.transaction(async (executor) => {
    await executor.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return executor.query<{ readonly tenant_id: unknown; readonly tenant_role: unknown }>(
      `SELECT t.id AS tenant_id, m.role AS tenant_role
       FROM saas_tenants t
       JOIN saas_memberships m ON m.tenant_id = t.id
       JOIN saas_users u ON u.id = m.user_id
       WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'
         AND t.status = 'active' AND u.disabled_at IS NULL
       LIMIT 1`,
      [input.tenantId, input.userId],
    );
  });
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.tenant_id !== input.tenantId ||
    (row?.tenant_role !== 'owner' && row?.tenant_role !== 'admin' && row?.tenant_role !== 'billing')
  ) {
    throw new CustomerRefundQueryError('CUSTOMER_REFUND_QUERY_ACCESS_DENIED');
  }
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    tenantRole: row.tenant_role,
  };
}

function createPlatformHandler(
  authHandler: PlatformAdminAuthHttpHandler,
  refundHandler: PlatformRefundHttpHandler | undefined,
  rewrapHandler: PlatformCredentialRewrapHttpHandler | undefined,
  codexOauthHandler: CodexOauthHttpHandler | undefined,
  grokOauthHandler: GrokOauthHttpHandler | undefined,
  accountProbeHandler: AccountProbeHttpHandler | undefined,
  platformSettingsHandler: PlatformSettingsHttpHandler,
  billingGroupsHandler: BillingGroupsHttpHandler | undefined,
  compositeModelRoutesHandler: CompositeModelRoutesHttpHandler | undefined,
  riskControlHandler: RiskControlHttpHandler | undefined,
  pluginsHandler: PluginsHttpHandler | undefined,
  egressProxiesHandler: EgressProxiesHttpHandler | undefined,
  opencodeGoRulesHandler: OpencodeGoRulesHttpHandler | undefined,
  opencodeGoModelsHandler: OpencodeGoModelCatalogHttpHandler | undefined,
  unknownOutcomeHandler: UnknownOutcomePlatformHttpHandler | undefined,
  usageCorrectionHandler: UsageCorrectionPlatformHttpHandler | undefined,
  marketingOpsRedeemCodesHandler: MarketingRedeemHttpHandler,
  marketingOpsAnnouncementsHandler: MarketingAnnouncementHttpHandler,
  marketingOpsPromoCodesHandler: MarketingPromoHttpHandler,
  marketingOpsAffiliateHandler: MarketingAffiliateHttpHandler,
  observabilityHandler: ObservabilityHttpHandler,
  alertSilencesHandler: AlertSilencesHttpHandler | undefined,
  readHandler: PlatformAdminReadHttpHandler,
  webDistPath: string | undefined,
  brandReader?: Pick<CachedBrandSnapshotReader, 'read'>,
): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
        return;
      }
      if (await observabilityHandler(req, res)) return;
      if (alertSilencesHandler && (await alertSilencesHandler(req, res))) return;
      if (isApiPath(pathname, PLATFORM_API_PREFIX)) {
        if (pathname === PLATFORM_ADMIN_AUTH_PREFIX || pathname.startsWith(`${PLATFORM_ADMIN_AUTH_PREFIX}/`)) {
          if (await authHandler(req, res)) return;
        }
        if (refundHandler && (await refundHandler(req, res))) return;
        if (rewrapHandler && (await rewrapHandler(req, res))) return;
        if (codexOauthHandler && (await codexOauthHandler(req, res))) return;
        if (grokOauthHandler && (await grokOauthHandler(req, res))) return;
        if (accountProbeHandler && (await accountProbeHandler(req, res))) return;
        if (await platformSettingsHandler(req, res)) return;
        if (billingGroupsHandler && (await billingGroupsHandler(req, res))) return;
        if (compositeModelRoutesHandler && (await compositeModelRoutesHandler(req, res))) return;
        if (riskControlHandler && (await riskControlHandler(req, res))) return;
        if (pluginsHandler && (await pluginsHandler(req, res))) return;
        if (egressProxiesHandler && (await egressProxiesHandler(req, res))) return;
        if (opencodeGoRulesHandler && (await opencodeGoRulesHandler(req, res))) return;
        if (opencodeGoModelsHandler && (await opencodeGoModelsHandler(req, res))) return;
        if (unknownOutcomeHandler && (await unknownOutcomeHandler(req, res))) return;
        if (usageCorrectionHandler && (await usageCorrectionHandler(req, res))) return;
        if (await marketingOpsRedeemCodesHandler(req, res)) return;
        if (await marketingOpsAnnouncementsHandler(req, res)) return;
        if (await marketingOpsPromoCodesHandler(req, res)) return;
        if (await marketingOpsAffiliateHandler(req, res)) return;
        if (await readHandler(req, res)) return;
        sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      if (isMountedPath(pathname, PLATFORM_MOUNT)) {
        await serveMountedStatic(req, res, pathname, PLATFORM_MOUNT, webDistPath, brandReader);
        return;
      }
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    })().catch(() => safeHandlerError(res));
  };
}

/**
 * The gateway listener handler. Exported for the public brand surface tests
 * (the createManagedOauthTokenRefreshRotator test-seam precedent).
 *
 * Batch-5 §5.2: `publicBrandHandler` mounts the unauthenticated
 * `GET /settings/public` (+ `/settings/public/pages/:slug`) surface on this
 * listener — the /metrics precedent: public, non-secret data (the
 * gateway-read-only brand snapshot table), no session.
 */
export function createGatewayHandler(
  gatewayHandler?: SaasGatewayHttpHandler,
  publicBrandHandler?: PublicBrandSettingsHttpHandler,
): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
        return;
      }
      // Batch-5 §5.2 OEM white-label: public brand snapshot + custom page
      // content, unauthenticated by design (no secrets in the snapshot by
      // construction; the handler owns its own 404/405 semantics).
      if (publicBrandHandler && (await publicBrandHandler(req, res))) return;
      // Phase 3 observability: read-only Prometheus exposition on the gateway
      // listener. Unauthenticated by design (counters only, no secrets);
      // deployments should restrict scraper network access.
      if (pathname === '/metrics') {
        if ((req.method ?? '').toUpperCase() !== 'GET') {
          req.resume();
          sendJsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported for metrics');
          return;
        }
        req.resume();
        try {
          const body = Buffer.from(await renderSaasMetrics(), 'utf8');
          res.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            'content-length': String(body.length),
            'cache-control': 'no-store',
          });
          res.end(body);
        } catch {
          sendJsonError(res, 500, 'INTERNAL_ERROR', 'The request could not be completed');
        }
        return;
      }
      if (isMountedPath(pathname, GATEWAY_MOUNT)) {
        if (gatewayHandler) {
          if (await gatewayHandler(req, res)) return;
          req.resume();
          sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
          return;
        }
        req.resume();
        sendJsonError(res, 503, 'GATEWAY_UNAVAILABLE', 'The commercial gateway is not available in this deployment.');
        return;
      }
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    })().catch(() => safeHandlerError(res));
  };
}

function defaultCreateDatabase(options: { connectionString: string }): ManagedSaasDatabase {
  return createSaasDatabase(options);
}

async function defaultVerifySchema(database: ManagedSaasDatabase): Promise<void> {
  const verifySchema = database.verifySchema;
  if (typeof verifySchema !== 'function') {
    throw new Error('Managed SaaS database schema verification is unavailable');
  }
  await verifySchema.call(database);
}

async function defaultVerifyUnknownOutcomeSchema(database: ManagedSaasDatabase): Promise<void> {
  const verifySchema = database.verifyUnknownOutcomeSchema;
  if (typeof verifySchema !== 'function') {
    throw new Error('Managed SaaS unknown-outcome schema verification is unavailable');
  }
  await verifySchema.call(database);
}

function defaultCreateListener(_name: ListenerName, handler: RequestListener): Server {
  return http.createServer(handler);
}

function listenerAddress(listener: DeploymentListenerConfig): string {
  return `${listener.bindAddress}:${listener.port}`;
}

function selectedAuditCursorSecret(environment: DeploymentEnvironment): string | undefined {
  const value = environment[SAAS_PLATFORM_AUDIT_CURSOR_SECRET];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < PLATFORM_AUDIT_CURSOR_SECRET_MIN_BYTES ||
    Buffer.byteLength(value, 'utf8') > PLATFORM_AUDIT_CURSOR_SECRET_MAX_BYTES
  ) {
    throw new Error('Managed SaaS platform audit cursor secret is invalid');
  }
  return value;
}

async function bindListener(server: Server, listener: DeploymentListenerConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      server.off('listening', onListening);
      server.off('error', onError);
      reject(error);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(listener.port, listener.bindAddress);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function closeListener(server: Server): Promise<void> {
  try {
    server.closeAllConnections();
  } catch {
    // The server may be a deterministic test double without closeAllConnections.
  }
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

interface CustomerWebhookDeliveryWorkerHandle {
  stop(): Promise<void>;
}

const CUSTOMER_WEBHOOK_SCHEMA_TABLES = Object.freeze([
  'saas_customer_webhook_tenant_policies',
  'saas_customer_webhook_tenant_usage',
  'saas_customer_webhook_endpoints',
  'saas_customer_webhook_endpoint_versions',
  'saas_customer_webhook_signing_secrets',
  'saas_customer_webhook_events',
  'saas_customer_webhook_deliveries',
  'saas_customer_webhook_delivery_attempts',
]);

async function verifyCustomerWebhookSchema(database: ManagedSaasDatabase): Promise<void> {
  const result = await database.query<{ readonly table_name: unknown; readonly present: unknown }>(
    `SELECT table_name, to_regclass(table_name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS required(table_name)`,
    [CUSTOMER_WEBHOOK_SCHEMA_TABLES],
  );
  if (
    result.rows.length !== CUSTOMER_WEBHOOK_SCHEMA_TABLES.length ||
    result.rows.some((row) => typeof row.table_name !== 'string' || row.present !== true) ||
    new Set(result.rows.map((row) => row.table_name)).size !== CUSTOMER_WEBHOOK_SCHEMA_TABLES.length
  ) {
    throw new Error('Managed SaaS customer webhook schema is unavailable');
  }
}

function startCustomerWebhookDeliveryWorker(
  worker: CustomerWebhookDeliveryWorker,
  options: { readonly intervalMs?: number; readonly concurrency?: number } = {},
): CustomerWebhookDeliveryWorkerHandle {
  const intervalMs = options.intervalMs ?? 1_000;
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) {
    throw new RangeError('Customer webhook worker interval must be between 50 and 60000 ms');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError('Customer webhook worker concurrency must be between 1 and 32');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delayMs);
    timer.unref();
  };
  const tick = (): void => {
    if (stopped || running) return;
    running = worker
      .runOnce()
      .then((result) => schedule(result.claimed === concurrency ? 0 : intervalMs))
      .catch(() => {
        console.error('model-router customer webhook delivery worker cycle failed');
        schedule(intervalMs);
      })
      .finally(() => {
        running = undefined;
      });
  };
  schedule(intervalMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

export interface CustomerWebhookNotificationScannerHandle {
  readonly stop: () => Promise<void>;
}

function startCustomerWebhookNotificationScanner(
  scanner: CustomerWebhookNotificationScanner,
  options: { readonly intervalMs?: number } = {},
): CustomerWebhookNotificationScannerHandle {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 60 * 60 * 1000) {
    throw new RangeError('Customer webhook notification scan interval must be between 10000 and 3600000 ms');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delayMs);
    timer.unref();
  };
  const tick = (): void => {
    if (stopped || running) return;
    running = scanner
      .runOnce()
      .then(() => schedule(intervalMs))
      .catch(() => {
        console.error('model-router customer webhook notification scan cycle failed');
        schedule(intervalMs);
      })
      .finally(() => {
        running = undefined;
      });
  };
  schedule(intervalMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

export interface CustomerWebhookRetentionPrunerHandle {
  readonly stop: () => Promise<void>;
}

/**
 * F4: bounded pruneTerminalHistory scheduling. Retention/limit bounds mirror
 * the store's own validation so misconfiguration fails fast at startup
 * instead of on the first tick.
 */
function startCustomerWebhookRetentionPruner(
  store: Pick<PostgresCustomerWebhookDeliveryStore, 'pruneTerminalHistory'>,
  options: { readonly intervalMs?: number; readonly retentionMs?: number; readonly limit?: number } = {},
): CustomerWebhookRetentionPrunerHandle {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 24 * 60 * 60 * 1000) {
    throw new RangeError('Customer webhook retention prune interval must be between 60000 and 86400000 ms');
  }
  const retentionMs = options.retentionMs ?? CUSTOMER_WEBHOOK_DEFAULT_HISTORY_RETENTION_MS;
  if (
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < CUSTOMER_WEBHOOK_MIN_HISTORY_RETENTION_MS ||
    retentionMs > CUSTOMER_WEBHOOK_MAX_HISTORY_RETENTION_MS
  ) {
    throw new RangeError('Customer webhook retention window must be between 7 and 365 days');
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Customer webhook retention batch limit must be between 1 and 1000');
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delayMs);
    timer.unref();
  };
  const tick = (): void => {
    if (stopped || running) return;
    running = store
      .pruneTerminalHistory({ retentionMs, limit })
      .then(() => schedule(intervalMs))
      .catch(() => {
        console.error('model-router customer webhook retention prune cycle failed');
        schedule(intervalMs);
      })
      .finally(() => {
        running = undefined;
      });
  };
  schedule(intervalMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

async function closeAllResources(
  listeners: Iterable<Server>,
  gateway: ManagedSaasGatewayComposition | undefined,
  gatewayKms: LoadedProviderCredentialUnsealingKms | undefined,
  gatewayRuntimeModule: LoadedManagedSaasGatewayRuntimeModule | undefined,
  providers: ManagedSaasProviders | undefined,
  unknownOutcomeScanner: UnknownOutcomeScannerHandle | undefined,
  paymentWorker: PaymentWebhookWorkerHandle | undefined,
  oauthRefreshWorker: OauthTokenRefreshWorkerHandle | undefined,
  customerWebhookWorker: CustomerWebhookDeliveryWorkerHandle | undefined,
  customerWebhookScanner: CustomerWebhookNotificationScannerHandle | undefined,
  customerWebhookPruner: CustomerWebhookRetentionPrunerHandle | undefined,
  announcementFanoutWorker: AnnouncementFanoutWorkerHandle | undefined,
  refundWorker: PaymentRefundWorkerHandle | undefined,
  database: ManagedSaasDatabase | undefined,
  closeDatabase: (database: ManagedSaasDatabase) => Promise<void>,
): Promise<void> {
  const workerStops: Promise<void>[] = [];
  if (unknownOutcomeScanner) workerStops.push(unknownOutcomeScanner.stop());
  if (paymentWorker) workerStops.push(paymentWorker.stop());
  if (oauthRefreshWorker) workerStops.push(oauthRefreshWorker.close());
  if (customerWebhookWorker) workerStops.push(customerWebhookWorker.stop());
  if (customerWebhookScanner) workerStops.push(customerWebhookScanner.stop());
  if (customerWebhookPruner) workerStops.push(customerWebhookPruner.stop());
  if (announcementFanoutWorker) workerStops.push(announcementFanoutWorker.close());
  if (refundWorker) workerStops.push(refundWorker.stop());
  await Promise.allSettled(workerStops);
  await Promise.allSettled([...listeners].map((listener) => closeListener(listener)));
  if (gateway) await Promise.allSettled([gateway.close()]);
  else if (gatewayKms) await Promise.allSettled([gatewayKms.close()]);
  if (gatewayRuntimeModule) await Promise.allSettled([gatewayRuntimeModule.close()]);
  if (providers) await Promise.allSettled([providers.close()]);
  if (database) await Promise.allSettled([closeDatabase(database)]);
}

function installSignals(runtime: ManagedSaasRuntime): () => void {
  let closed = false;
  const onSignal = () => {
    if (closed) return;
    closed = true;
    void runtime.close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

/** Snapshot only the new metadata controls, without invoking caller-owned accessors. */
function targetsModuleData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid data control');
    return descriptor?.value;
  } catch {
    throw new Error('Credential-validation worker targets module configuration is unavailable');
  }
}

async function startCredentialValidationWorkerRuntime(
  deployment: ManagedSaasDeploymentConfig,
  options: ManagedSaasStartOptions,
  environment: DeploymentEnvironment,
  providerEgressAllowlistOption: { readonly egressAllowlist?: ProviderHttpEgressAllowlist },
): Promise<ManagedSaasRuntime> {
  if (options.gateway || options.payments || options.paymentHandler) {
    throw new TypeError('Credential-validation worker cannot receive gateway or payment capabilities');
  }
  const configuredTargetsModule = targetsModuleData(deployment, 'credentialValidationTargetsModule');
  const targetsModuleImporter = targetsModuleData(options, 'credentialValidationTargetsModuleImporter');
  if (
    (configuredTargetsModule !== undefined &&
      (typeof configuredTargetsModule !== 'string' ||
        configuredTargetsModule.trim() === '' ||
        configuredTargetsModule.trim() !== configuredTargetsModule)) ||
    targetsModuleData(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE) !== configuredTargetsModule
  ) {
    throw new Error('Credential-validation worker targets module configuration is unavailable');
  }
  if (configuredTargetsModule !== undefined && options.credentialValidationTargets !== undefined) {
    throw new TypeError('Credential-validation worker SDK targets and targets module cannot both be configured');
  }
  let approvedTargets = compileApprovedCredentialValidationTargets(options.credentialValidationTargets ?? []);
  if (
    options.credentialValidationWorkerTestTransport &&
    (environment.NODE_ENV !== 'test' ||
      !isProviderHttpTestAddressCapability(options.credentialValidationWorkerTestTransport.addressCapability))
  ) {
    throw new TypeError('Credential-validation worker test transport is unavailable');
  }
  const configuredKmsModule = deployment.validationWorkerProviderCredentialDecryptKmsModule;
  if (
    typeof configuredKmsModule !== 'string' ||
    configuredKmsModule.trim() === '' ||
    environment[SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE] !== configuredKmsModule
  ) {
    throw new Error('Credential-validation worker KMS configuration is unavailable');
  }

  const createDatabase = options.createDatabase ?? defaultCreateDatabase;
  const pingDatabase = options.pingDatabase ?? ((database: ManagedSaasDatabase) => pingSaasDatabase(database));
  const closeDatabase = options.closeDatabase ?? ((database: ManagedSaasDatabase) => closeSaasDatabase(database));
  const loadKms =
    options.loadValidationWorkerKms ??
    ((env: DeploymentEnvironment) => loadValidationWorkerProviderCredentialKms({ env }));
  const startWorker = options.startCredentialValidationWorker ?? startValidationWorkerLoop;
  const startQuotaWorker = options.startQuotaSyncWorker ?? startQuotaSyncWorkerLoop;
  const createUsageStore =
    options.createOpencodeGoUsageStore ??
    ((
      database: SaasDatabase,
      kms: LoadedValidationWorkerProviderCredentialKms,
      storeOptions: PostgresOpencodeGoUsageStoreOptions,
    ) => new PostgresOpencodeGoUsageStore(database, kms, storeOptions));
  const createSnapshotStore =
    options.createQuotaSnapshotStore ??
    ((database: SaasDatabase, storeOptions: PostgresProviderQuotaSnapshotStoreOptions) =>
      new PostgresProviderQuotaSnapshotStore(database, storeOptions));

  let database: ManagedSaasDatabase | undefined;
  let kms: LoadedValidationWorkerProviderCredentialKms | undefined;
  let worker: CredentialValidationWorkerHandle | undefined;
  let quotaWorker: QuotaSyncWorkerHandle | undefined;
  let opencodeGoUsageWorker: OpencodeGoUsageWorkerHandle | undefined;
  let cnProvidersQuotaWorker: CnProvidersQuotaWorkerHandle | undefined;
  let geminiUsageWorker: GeminiUsageWorkerHandle | undefined;
  let openRouterModelPricingSyncWorker: OpenRouterModelPricingSyncWorkerHandle | undefined;
  let oauthRefreshWorker: OauthTokenRefreshWorkerHandle | undefined;
  let egressProxyProbeWorker: EgressProxyProbeWorkerHandle | undefined;
  let probeMonitorWorker: ProbeMonitorWorkerHandle | undefined;
  let closePromise: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;
  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      removeSignals?.();
      removeSignals = undefined;
      if (worker) await Promise.allSettled([worker.close()]);
      if (quotaWorker) await Promise.allSettled([quotaWorker.close()]);
      if (opencodeGoUsageWorker) await Promise.allSettled([opencodeGoUsageWorker.close()]);
      if (geminiUsageWorker) await Promise.allSettled([geminiUsageWorker.close()]);
      if (cnProvidersQuotaWorker) await Promise.allSettled([cnProvidersQuotaWorker.close()]);
      if (openRouterModelPricingSyncWorker) {
        await Promise.allSettled([openRouterModelPricingSyncWorker.close()]);
      }
      if (oauthRefreshWorker) await Promise.allSettled([oauthRefreshWorker.close()]);
      if (egressProxyProbeWorker) await Promise.allSettled([egressProxyProbeWorker.close()]);
      if (probeMonitorWorker) await Promise.allSettled([probeMonitorWorker.close()]);
      if (kms) await Promise.allSettled([Promise.resolve().then(() => kms?.close())]);
      if (database) await Promise.allSettled([closeDatabase(database)]);
    })();
    await closePromise;
  };

  try {
    database = createDatabase({ connectionString: deployment.postgresUrl });
    try {
      await pingDatabase(database);
    } catch {
      throw new Error('Managed SaaS credential-validation worker PostgreSQL ping failed');
    }
    try {
      // The restricted worker cannot read the migration ledger. Always prove
      // its real catalog-only structure; deployment/migrator history approval
      // remains independent, and the generic history hook is not a substitute.
      await verifyCredentialValidationWorkerSchemaReadiness(database);
    } catch {
      throw new Error('Managed SaaS credential-validation worker schema readiness failed');
    }
    // Configured operator code requires the actual restricted-role proof even
    // in test/development; the generic history hook cannot substitute for it.
    if (environment.NODE_ENV === 'production' || configuredTargetsModule !== undefined) {
      try {
        await verifyCredentialValidationWorkerRuntimePrivileges(database);
      } catch {
        throw new Error('Managed SaaS credential-validation worker database privileges are unsafe');
      }
    }
    if (configuredTargetsModule !== undefined) {
      // In-process trusted code is not a sandbox. Pass only the dedicated
      // setting to the reviewed metadata loader, never the supervisor's DB,
      // KMS, tenant, headers or fetch configuration. The factory receives only
      // its frozen purpose, and the worker independently checks live authority.
      const metadata = await loadCredentialValidationTargetsModule({
        env: Object.freeze({ [MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE]: configuredTargetsModule }),
        importer: targetsModuleImporter as ProviderModuleImporter | undefined,
      });
      if (metadata === undefined) throw new Error('Credential-validation worker targets metadata is unavailable');
      approvedTargets = compileApprovedCredentialValidationTargets(metadata);
    }
    kms = await loadKms(environment);
    if (!kms) throw new Error('Managed SaaS credential-validation worker KMS is unavailable');
    try {
      await kms.checkReady();
    } catch {
      throw new Error('Managed SaaS credential-validation worker KMS readiness failed');
    }

    worker = startWorker(database, kms, {
      ...options.credentialValidationWorkerOptions,
      approvedTargets,
      transportTestOptions: options.credentialValidationWorkerTestTransport,
      deployment: deployment.deploymentId,
      environment: deployment.environmentId,
      // R9 §4 P1: the validation transport consults the same operator
      // egress allowlist as gateway dispatch (empty = strict posture).
      ...providerEgressAllowlistOption,
    });
    // Track D4: the quota sync loop shares this workload's database role and
    // decrypt-only KMS. Its snapshot writes never feed the billing path.
    quotaWorker = startQuotaWorker(database, kms, {
      ...options.quotaSyncWorkerOptions,
      deployment: deployment.deploymentId,
      environment: deployment.environmentId,
    });
    // R5b (task #25): the OpenCode Go usage-snapshot loop shares this
    // workload's database role and decrypt-only KMS, exactly like the quota
    // sync loop. Its SKIP LOCKED claim and snapshot writes are scheduling
    // signals only and never feed the billing path; the due scan itself
    // filters on the compile-time fixed opencode-go binding triple, so a
    // deployment without opencode-go accounts simply idles every round.
    opencodeGoUsageWorker = startOpencodeGoUsageWorker(
      createUsageStore(database, kms, {
        deployment: deployment.deploymentId,
        environment: deployment.environmentId,
      }),
      options.opencodeGoUsageWorkerOptions,
    );
    // R-dormant (batch 2.2): the gemini usage-snapshot loop folds per-model
    // request counts from saas_attempts into the migration-111 tier snapshot.
    // Same workload, role and lease semantics as the opencode-go loop above;
    // a deployment without gemini accounts simply idles every round.
    geminiUsageWorker = startGeminiUsageWorker(createSnapshotStore(database, {}), options.geminiUsageWorkerOptions);
    // Batch-3 (task #13): the CN-provider coding-plan quota probe loop
    // (zhipu /api/monitor/usage/quota/limit without Bearer; minimax
    // coding_plan/remains with Bearer). Same workload, role and lease
    // semantics as the opencode-go loop above; the due scan only ever claims
    // coding-mode accounts, so a deployment without zhipu/minimax accounts
    // simply idles every round.
    cnProvidersQuotaWorker = startCnProvidersQuotaWorker(
      new PostgresCnProvidersQuotaStore(database, kms, {
        deployment: deployment.deploymentId,
        environment: deployment.environmentId,
      }),
      options.cnProvidersQuotaWorkerOptions,
    );
    // F6 (task #39): the OpenRouter model-catalog/pricing sync loop. It is
    // strictly opt-in (the R4 OAuth-refresh precedent): the sync appends
    // provider catalog, public-model alias and supplier-cost version rows,
    // and the restricted validation-worker role is SELECT-only on the
    // catalog, so a deployment enables the loop only after granting those
    // INSERT privileges (or wiring a custom store on a privileged role).
    // The loop itself never touches credentials or the KMS — OpenRouter's
    // models catalog is public — and every write is idempotent
    // (content-addressed supplier-cost keys; duplicate-tolerant structure
    // seeding), so crashes and replays are free.
    if (options.openRouterModelPricingSync) {
      openRouterModelPricingSyncWorker = startOpenRouterModelPricingSyncWorker(
        options.openRouterModelPricingSync.store ?? createOpenRouterModelPricingSyncStore(database),
        options.openRouterModelPricingSync.worker,
      );
    }
    // Track R3: the egress-proxy probe/sweep loop shares this workload's
    // database role and decrypt-only KMS, exactly like the quota sync loop.
    // Probes measure the exit IP the provider sees; the expiry sweep is the
    // only path that rebinds accounts (fallback_mode), so probe jitter never
    // migrates traffic. A deployment without proxies simply idles.
    egressProxyProbeWorker = startEgressProxyProbeWorker(
      new PostgresEgressProxyProbeWorkerStore(database, kms, {
        ...(options.egressProxyProbeWorkerOptions ?? {}),
        deployment: deployment.deploymentId,
        environment: deployment.environmentId,
        // R9 §4 P1: proxy probes honor the same operator egress allowlist.
        ...providerEgressAllowlistOption,
      }),
      options.egressProxyProbeWorkerOptions,
    );
    // Track R6a: the probe monitor loop shares this workload's database role
    // and decrypt-only KMS (the only non-gateway runtime with credential
    // unsealing), exactly like the R3 proxy probe loop. Each due monitor is
    // claimed, probed and written in one SKIP LOCKED transaction; the probe
    // derives the probe_temp_unschedulable_until scheduling signal with
    // probe-success-only recovery. A deployment without monitors simply
    // idles; run-history retention pruning runs on the control-plane role.
    probeMonitorWorker = (options.startProbeMonitorWorker ?? startProbeMonitorWorker)(
      new PostgresProbeMonitorStore(database, kms, {
        ...(options.probeMonitorWorkerOptions ?? {}),
        deployment: deployment.deploymentId,
        environment: deployment.environmentId,
        // R9 §4 P1: account probes honor the same operator egress allowlist.
        ...providerEgressAllowlistOption,
      }),
      options.probeMonitorWorkerOptions ?? {},
    );
    // Track R4: the OAuth refresh loop runs only when the deployment wires a
    // privileged rotator (the restricted worker role cannot write the version
    // chain). An absent rotator keeps pre-R4 behavior, documented at the option.
    if (options.oauthTokenRefreshRotator) {
      oauthRefreshWorker = startOauthTokenRefreshWorker(database, kms, options.oauthTokenRefreshRotator, {
        ...(options.oauthTokenRefreshWorkerOptions ?? {}),
        deployment: deployment.deploymentId,
        environment: deployment.environmentId,
        // R9 §4 P1: OAuth refresh egress honors the same operator allowlist.
        ...providerEgressAllowlistOption,
      } as Parameters<typeof startOauthTokenRefreshWorker>[3]);
    }
    const runtime: ManagedSaasRuntime = {
      deployment,
      database,
      providers: null,
      gateway: null,
      credentialValidationWorker: worker,
      quotaSyncWorker: quotaWorker,
      opencodeGoUsageWorker: opencodeGoUsageWorker,
      geminiUsageWorker: geminiUsageWorker,
      cnProvidersQuotaWorker: cnProvidersQuotaWorker,
      openRouterModelPricingSyncWorker: openRouterModelPricingSyncWorker ?? null,
      egressProxyProbeWorker,
      probeMonitorWorker: probeMonitorWorker ?? null,
      probeRunRetentionWorker: null,
      riskControlRetentionWorker: null,
      publicBrandSnapshotWorker: null,
      oauthTokenRefreshWorker: oauthRefreshWorker ?? null,
      announcementFanoutWorker: null,
      unknownOutcomeScanner: null,
      listeners: Object.freeze({}),
      close,
    };
    if (options.installSignalHandlers !== false) removeSignals = installSignals(runtime);
    await options.onReady?.(runtime);
    return runtime;
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Compose the hosted runtime without importing or constructing local config,
/**
 * R4 production assembly (decision A): the audited rotation seam used by the
 * control-plane OAuth refresh worker. Dispatch follows the claimed credential's
 * ownerKind — platform keeps the platform resolver path, while tenant (BYOK)
 * rotations go through the operator-semantics tenant path (full reference from
 * the claim, no TenantContext). Both paths audit the deployment-provided
 * operator identity with the refresh-worker entry point.
 */
export function createManagedOauthTokenRefreshRotator(
  supply: ProviderSupplyService,
  operatorUserId: string,
): OauthCredentialRotator {
  return async (input) => {
    const audit = { actorUserId: operatorUserId, entryPoint: 'oauth-token-refresh-worker' } as const;
    const result =
      input.ownerKind === 'tenant'
        ? await supply.replaceTenantProviderCredentialSecretForOperator({
            credential: {
              ownerKind: 'tenant',
              tenantId: operatorTenantId(input),
              accountId: input.accountId,
              credentialId: input.credentialId,
            },
            expectedVersion: input.expectedVersion,
            secret: input.secret,
            audit,
          })
        : await supply.replacePlatformProviderCredentialSecret({
            credentialId: input.credentialId,
            expectedVersion: input.expectedVersion,
            secret: input.secret,
            audit,
          });
    return { version: result.version.version };
  };
}

function operatorTenantId(input: { readonly tenantId: string | null }): string {
  if (input.tenantId === null) throw new Error('OAuth token refresh tenant rotation requires a tenantId');
  return input.tenantId;
}

/**
 * Compose the hosted runtime without importing or constructing local config,
 * SQLite, watcher, admin, or proxy state. Schema verification is deliberately
 * separate from migrations: server startup may prove readiness but never
 * changes the database schema.
 */
export async function startManagedSaasServer(
  deployment: ManagedSaasDeploymentConfig,
  options: ManagedSaasStartOptions = {},
): Promise<ManagedSaasRuntime> {
  if (deployment.mode !== 'managed-saas') throw new TypeError('managed SaaS deployment configuration is required');
  assertCustomerMfaDeploymentConfiguration(deployment, options.environment ?? process.env);
  assertCustomerPasskeyDeploymentConfiguration(deployment, options.environment ?? process.env);
  if (options.customerWebhooks?.enabled) {
    if (deployment.workloadRole !== 'combined' && deployment.workloadRole !== 'control-plane') {
      throw new TypeError('Customer webhook routes require a managed SaaS control-plane workload');
    }
    const protector = options.customerWebhooks.signingSecretProtector;
    if (
      protector?.purpose !== 'customer-webhook-signing-secret-v1' ||
      typeof protector.protect !== 'function' ||
      typeof protector.unprotect !== 'function' ||
      typeof options.customerWebhooks.egressTransport?.send !== 'function'
    ) {
      throw new Error('Managed SaaS customer webhook protector and egress dependencies are unavailable');
    }
  }
  if (options.payments !== undefined && options.paymentHandler !== undefined) {
    throw new TypeError('Managed SaaS payments and paymentHandler cannot both be configured');
  }

  const environment = options.environment ?? process.env;
  // R9 §4 P1: operator egress allowlist for container-network providers.
  // Strict env parsing — malformed CIDR entries fail EVERY workload startup
  // closed (gateway dispatch, credential validation, account probing and
  // OAuth refresh all share this one parsed value). The effective entries
  // (CIDRs, never credentials) are logged.
  const providerHttpEgressAllowlist = parseProviderEgressAllowlistSettings(environment);
  console.log(
    `model-router provider egress allowlist: ${
      providerHttpEgressAllowlist.entries.length === 0
        ? 'none (strict global-only provider egress)'
        : providerHttpEgressAllowlist.entries.join(', ')
    }`,
  );
  // R9 §4 P1 composition: an empty allowlist is the pre-R9 strict posture —
  // omit the option entirely so every consumer keeps byte-identical default
  // behavior.
  const providerEgressAllowlistOption =
    providerHttpEgressAllowlist.entries.length === 0 ? {} : { egressAllowlist: providerHttpEgressAllowlist };
  if (
    deployment.workloadRole !== 'credential-validation-worker' &&
    (targetsModuleData(deployment, 'credentialValidationTargetsModule') !== undefined ||
      targetsModuleData(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE) !== undefined ||
      targetsModuleData(options, 'credentialValidationTargetsModuleImporter') !== undefined)
  ) {
    throw new TypeError('Credential-validation targets module is available only to the credential-validation worker');
  }
  if (deployment.workloadRole === 'credential-validation-worker') {
    return startCredentialValidationWorkerRuntime(deployment, options, environment, providerEgressAllowlistOption);
  }
  if (deployment.workloadRole === 'plugin-host') {
    // Batch-5 §5.1: the isolated plugin-host workload (same codebase, own
    // process; the credential-validation-worker deployment precedent).
    if (options.gateway !== undefined || options.payments !== undefined || options.paymentHandler !== undefined) {
      throw new TypeError('Plugin-host workload cannot receive gateway or payment capabilities');
    }
    const handle = await startPluginHostRuntime(deployment, options.pluginHost ?? {}, environment);
    let removeSignals: (() => void) | undefined;
    const runtime: ManagedSaasRuntime = {
      deployment,
      database: handle.database,
      providers: null,
      gateway: null,
      credentialValidationWorker: null,
      quotaSyncWorker: null,
      opencodeGoUsageWorker: null,
      cnProvidersQuotaWorker: null,
      geminiUsageWorker: null,
      openRouterModelPricingSyncWorker: null,
      egressProxyProbeWorker: null,
      probeMonitorWorker: null,
      probeRunRetentionWorker: null,
      riskControlRetentionWorker: null,
      publicBrandSnapshotWorker: null,
      oauthTokenRefreshWorker: null,
      announcementFanoutWorker: null,
      unknownOutcomeScanner: null,
      listeners: Object.freeze({}),
      close: async () => {
        removeSignals?.();
        removeSignals = undefined;
        await handle.close();
      },
    };
    if (options.installSignalHandlers !== false) removeSignals = installSignals(runtime);
    await options.onReady?.(runtime);
    return runtime;
  }

  const controlPlaneEnabled = deployment.workloadRole === 'combined' || deployment.workloadRole === 'control-plane';
  const gatewayEnabled = deployment.workloadRole === 'combined' || deployment.workloadRole === 'gateway';
  const listenerNames = managedSaasListenerNames(deployment.workloadRole);
  if (deployment.workloadRole === 'control-plane' && options.gateway !== undefined) {
    throw new TypeError('Control-plane workload cannot receive gateway credential-unsealing dependencies');
  }
  if (deployment.workloadRole === 'gateway' && options.gateway !== undefined) {
    throw new TypeError('Gateway workload dependencies must come from its trusted runtime module');
  }
  if (
    deployment.workloadRole === 'gateway' &&
    (options.payments !== undefined || options.paymentHandler !== undefined)
  ) {
    throw new TypeError('Gateway workload cannot mount customer payment routes');
  }
  const auditCursorSecret = controlPlaneEnabled ? selectedAuditCursorSecret(environment) : undefined;
  if (
    deployment.workloadRole === 'gateway' &&
    (typeof deployment.gatewayRuntimeModule !== 'string' ||
      deployment.gatewayRuntimeModule.trim() === '' ||
      environment[MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE] !== deployment.gatewayRuntimeModule ||
      typeof deployment.gatewayProviderCredentialDecryptKmsModule !== 'string' ||
      environment[SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE] !==
        deployment.gatewayProviderCredentialDecryptKmsModule)
  ) {
    throw new Error('Managed SaaS gateway runtime configuration is unavailable');
  }
  const createDatabase = options.createDatabase ?? defaultCreateDatabase;
  const pingDatabase = options.pingDatabase ?? ((database: ManagedSaasDatabase) => pingSaasDatabase(database));
  const verifySchema = options.verifySchema ?? defaultVerifySchema;
  const verifyUnknownOutcomeSchema = options.verifyUnknownOutcomeSchema ?? defaultVerifyUnknownOutcomeSchema;
  const closeDatabase = options.closeDatabase ?? ((database: ManagedSaasDatabase) => closeSaasDatabase(database));
  const loadProviders =
    options.loadProviders ??
    ((config: ManagedSaasDeploymentConfig, env: DeploymentEnvironment) => loadManagedSaasProviders(config, { env }));
  const createListener = options.createListener ?? defaultCreateListener;
  const webDistPath = options.webDistPath ?? resolve(__dirname, '../../web/dist');

  let database: ManagedSaasDatabase | undefined;
  let providers: ManagedSaasProviders | undefined;
  let gateway: ManagedSaasGatewayComposition | undefined;
  let gatewayKms: LoadedProviderCredentialUnsealingKms | undefined;
  let gatewayRuntimeModule: LoadedManagedSaasGatewayRuntimeModule | undefined;
  // Gateway-scoped Redis (optional MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL):
  // one core-owned RESP connection for the sticky-session hot path.
  let gatewayRedis: RedisProvider | undefined;
  let unknownOutcomeScanner: UnknownOutcomeScannerHandle | undefined;
  let channelStatusWorker: ChannelStatusWorkerHandle | undefined;
  let alertEvaluatorWorker: AlertEvaluatorWorkerHandle | undefined;
  let reportSchedulerWorker: ReportSchedulerWorkerHandle | undefined;
  let probeRunRetentionWorker: ProbeMonitorWorkerHandle | undefined;
  let riskControlRetentionWorker: RiskControlRetentionWorkerHandle | undefined;
  let publicBrandSnapshotWorker: PublicBrandSnapshotWorkerHandle | undefined;
  let paymentWorker: PaymentWebhookWorkerHandle | undefined;
  let oauthRefreshWorker: OauthTokenRefreshWorkerHandle | undefined;
  let customerWebhookWorker: CustomerWebhookDeliveryWorkerHandle | undefined;
  let customerWebhookScanner: CustomerWebhookNotificationScannerHandle | undefined;
  let customerWebhookPruner: CustomerWebhookRetentionPrunerHandle | undefined;
  let announcementFanoutWorker: AnnouncementFanoutWorkerHandle | undefined;
  let refundWorker: PaymentRefundWorkerHandle | undefined;
  const listeners = new Map<ListenerName, Server>();
  let closePromise: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;

  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      removeSignals?.();
      removeSignals = undefined;
      await Promise.allSettled([
        ...(channelStatusWorker ? [channelStatusWorker.close()] : []),
        ...(alertEvaluatorWorker ? [alertEvaluatorWorker.close()] : []),
        ...(reportSchedulerWorker ? [reportSchedulerWorker.close()] : []),
        ...(probeRunRetentionWorker ? [probeRunRetentionWorker.close()] : []),
        ...(riskControlRetentionWorker ? [riskControlRetentionWorker.close()] : []),
        ...(publicBrandSnapshotWorker ? [publicBrandSnapshotWorker.close()] : []),
      ]);
      await closeAllResources(
        listeners.values(),
        gateway,
        gatewayKms,
        gatewayRuntimeModule,
        providers,
        unknownOutcomeScanner,
        paymentWorker,
        oauthRefreshWorker,
        customerWebhookWorker,
        customerWebhookScanner,
        customerWebhookPruner,
        announcementFanoutWorker,
        refundWorker,
        database,
        closeDatabase,
      );
      // The gateway composition closes first; its Redis connection follows.
      if (gatewayRedis) await Promise.allSettled([gatewayRedis.close()]);
    })();
    await closePromise;
  };

  try {
    database = createDatabase({ connectionString: deployment.postgresUrl });
    try {
      await pingDatabase(database);
    } catch {
      throw new Error('Managed SaaS PostgreSQL ping failed');
    }
    if (controlPlaneEnabled && options.verifySchema === undefined) {
      try {
        await verifyUnknownOutcomeSchema(database);
      } catch {
        throw new Error('Managed SaaS unknown-outcome schema readiness failed');
      }
    } else {
      try {
        await verifySchema(database);
      } catch {
        throw new Error('Managed SaaS PostgreSQL schema verification failed');
      }
      if (controlPlaneEnabled) {
        try {
          await verifyUnknownOutcomeSchema(database);
        } catch {
          throw new Error('Managed SaaS unknown-outcome schema readiness failed');
        }
      }
    }
    if (environment.NODE_ENV === 'production') {
      try {
        await verifySaasRuntimeDatabasePrivileges(
          database,
          deployment.workloadRole === 'gateway' ? 'gateway' : 'control_plane',
        );
      } catch {
        throw new Error('Managed SaaS PostgreSQL runtime privilege verification failed');
      }
    }
    if (options.customerWebhooks?.enabled) {
      try {
        await verifyCustomerWebhookSchema(database);
      } catch {
        throw new Error('Managed SaaS customer webhook schema verification failed');
      }
    }

    if (controlPlaneEnabled) providers = await loadProviders(deployment, environment);
    if (controlPlaneEnabled && deployment.providerCredentialKmsKeyId && !providers?.providerCredentialSealingKms) {
      throw new Error('Managed SaaS provider credential sealing KMS is unavailable');
    }

    if (deployment.workloadRole === 'gateway') {
      gatewayRuntimeModule = await loadManagedSaasGatewayRuntimeModule({
        deployment,
        database,
        environment,
        ...(options.gatewayRuntimeModuleImporter === undefined
          ? {}
          : { importer: options.gatewayRuntimeModuleImporter }),
      });
      gatewayKms = await loadGatewayProviderCredentialUnsealingKms({
        env: environment,
        ...(options.gatewayProviderCredentialKmsImporter === undefined
          ? {}
          : { importer: options.gatewayProviderCredentialKmsImporter }),
      });
      if (!gatewayKms) throw new Error('Managed SaaS gateway credential KMS is unavailable');

      // Optional gateway-scoped Redis (deployment contract change, roadmap
      // batch 2 §2.0): a configured-but-unreachable Redis fails startup
      // closed, mirroring the control-plane provider readiness posture.
      // Once loaded it only accelerates the sticky-session fast path — PG
      // affinity stays authoritative and every cache error fails open.
      if (deployment.gatewayRedisUrl !== undefined) {
        try {
          gatewayRedis = await createRedisProvider({
            url: deployment.gatewayRedisUrl,
            keyPrefix: MANAGED_SAAS_REDIS_KEY_PREFIX,
          });
          await gatewayRedis.checkReady();
        } catch {
          throw new Error('Managed SaaS gateway Redis provider is unavailable');
        }
      }

      const runtimeDependencies = gatewayRuntimeModule.dependencies;
      const { schedulerAuthorities, ...runtimeGatewayOptions } = runtimeDependencies;
      if (
        !runtimeDependencies.entitlementResolver ||
        typeof runtimeDependencies.entitlementResolver.resolve !== 'function'
      ) {
        throw new Error('Managed SaaS gateway entitlement dependency is unavailable');
      }
      if (schedulerAuthorities.leaseConcurrencyLimit !== runtimeDependencies.maxConcurrency) {
        throw new Error('Managed SaaS gateway scheduler and provider lease concurrency limits do not match');
      }
      const schedulerAffinity = new PostgresProviderAccountAffinity({
        database,
        keys: schedulerAuthorities.affinityKeyring.keys,
        activeKeyVersion: schedulerAuthorities.affinityKeyring.activeKeyVersion,
      });
      const providerPayload = runtimeDependencies.providerPayload;
      if (
        !providerPayload ||
        typeof providerPayload.compilerVersion !== 'string' ||
        typeof providerPayload.estimator?.version !== 'string'
      ) {
        throw new Error('Managed SaaS gateway payload configuration is unavailable');
      }

      const metering = new SaasMeteringService(database);
      const billingLedger = new PlatformWalletLedgerService();
      const capacityPort = createPostgresPreparationCapacityPort();
      const gatewayClock = () => new Date();
      const keyBudgetResolution = createKeyBudgetResolution();
      const billingGroupSpendResolution = createBillingGroupSpendResolution();
      const preparationPorts = createPostgresPreparationPorts({
        database,
        metering,
        billing: billingLedger,
        guard: new PostgresRequestAdmissionGuard(database),
        authorizationPrelock: new PostgresSaasRequestAdmissionAuthorizationPrelock(),
        entitlement: new PostgresRequestPreparationEntitlementAdapter(
          runtimeDependencies.entitlementResolver,
          new ByokServicePlanService(database),
        ),
        capacity: capacityPort,
        keyBudget: createPostgresKeyBudgetAdmission({ now: gatewayClock }),
        billingGroupSpend: createPostgresBillingGroupSpendAdmission({ now: gatewayClock }),
        payloadCompilerVersion: providerPayload.compilerVersion,
        usageEstimatorVersion: providerPayload.estimator.version,
        now: gatewayClock,
      });
      // R9 §4 P1: the operator egress allowlist is parsed once at server
      // startup (see startManagedSaasServer) and shared by gateway dispatch,
      // credential validation, account probing and OAuth refresh.
      // Gateway-scoped Redis decorates the PG affinity port with the R6b
      // sticky fast path (sliding 1h TTL; PG remains authoritative).
      const plazaDatabase = database;
      const plazaSettingsService = new PlatformSettingsService(plazaDatabase);
      const plazaIdentityService = new SaasIdentityService(plazaDatabase);

      const gatewayStickyCache =
        gatewayRedis === undefined
          ? undefined
          : {
              cache: await gatewayRedis.createCacheClient(),
              keyPrefix: MANAGED_SAAS_REDIS_KEY_PREFIX,
            };
      // Batch-5 §5.4 (task #19): risk-control violation/ban emails reuse the
      // registration SMTP seam — settings re-resolve per message, the
      // console sender degrades gracefully when SMTP is unconfigured.
      const riskControlEmailSender: ModerationEmailSender = {
        send: async (message) => {
          const unsealingKms = options.gateway?.providerCredentialUnsealingKms;
          const settingsService = new PlatformSettingsService(plazaDatabase ?? database, {
            ...(unsealingKms === undefined ? {} : { unsealingKms }),
          });
          let settings: ReturnType<typeof parseRegistrationAdmissionSettings>;
          try {
            const plain = await settingsService.readRegistrationSettingsOverlay();
            const secrets =
              unsealingKms === undefined
                ? {}
                : await settingsService.readRegistrationSecretsOverlay(
                    PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION,
                  );
            settings = resolveRegistrationAdmissionSettings({ ...plain, ...secrets }, process.env);
          } catch {
            settings = parseRegistrationAdmissionSettings(process.env);
          }
          const sender =
            settings.smtp === undefined
              ? new ConsoleEmailSender()
              : new SmtpEmailSender({
                  host: settings.smtp.host,
                  port: settings.smtp.port,
                  secure: settings.smtp.secure,
                  ...(settings.smtp.username === undefined ? {} : { username: settings.smtp.username }),
                  ...(settings.smtp.password === undefined ? {} : { password: settings.smtp.password }),
                  from: settings.smtp.from,
                });
          return sender.send(message);
        },
      };
      gateway = createManagedSaasGatewayProductionComposition(database, {
        riskControl: { emailSender: riskControlEmailSender },
        ...runtimeGatewayOptions,
        // Batch-5 §5.1: the optional claude-exit plugin routing layer. Only
        // wired when the gateway deployment declares the plugin-host URL and
        // the shared internal token; otherwise the claude route stays on the
        // native transport byte-for-byte. Placed AFTER the runtime-module
        // spread so operator runtime code cannot override or forge it.
        ...(deployment.gatewayPluginHostUrl !== undefined && deployment.pluginHostInternalToken !== undefined
          ? {
              pluginRouting: {
                routeReader: new PostgresPluginRouteReader({ executor: database }),
                pluginHostClient: new PluginHostClient({
                  baseUrl: deployment.gatewayPluginHostUrl,
                  internalToken: deployment.pluginHostInternalToken,
                }),
              },
            }
          : {}),
        // Model plaza (batch 5 §5.5, task #22): store-first settings overlay
        // and console-session validation. On the dedicated gateway workload
        // the role holds no grant on saas_platform_settings / saas_sessions,
        // so both degrade (env-only settings, anonymous session view) — the
        // documented posture until the #20 public-settings snapshot face
        // lands. Combined/control-plane deployments read the live store and
        // validate sessions natively.
        modelPlazaSettingsOverlay: async () => {
          try {
            return await plazaSettingsService.readPlainValues([
              MODEL_PLAZA_SETTINGS_KEYS.enabled,
              MODEL_PLAZA_SETTINGS_KEYS.requireAuth,
              MODEL_PLAZA_SETTINGS_KEYS.description,
              MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups,
            ]);
          } catch {
            return {};
          }
        },
        modelPlazaSessionAuth: {
          getSession: async (token: string) => {
            try {
              const session = await plazaIdentityService.getSession(token);
              return session?.userId ? { userId: session.userId } : null;
            } catch {
              return null;
            }
          },
        },

        schedulerAffinity,
        ...(gatewayStickyCache ? { schedulerAffinityStickyCache: gatewayStickyCache } : {}),
        // F3: settlement terminal commits enqueue customer webhook events.
        ...(options.customerWebhooks?.enabled ? { customerWebhooks: { enabled: true } } : {}),
        caller: preparationPorts.caller,
        entitlement: preparationPorts.entitlement,
        admission: preparationPorts.admission,
        attempt: preparationPorts.attempt,
        // KEY-BUD (contract C-4): same port shape as preparationPorts.compensation
        // plus the budget release hook; shares the capacity/billing instances.
        compensation: new PostgresPreDispatchCompensation({
          capacity: capacityPort,
          billing: billingLedger,
          keyBudget: keyBudgetResolution,
          billingGroupSpend: billingGroupSpendResolution,
        }),
        providerCredentialUnsealingKms: gatewayKms,
        credentialContext: {
          deployment: deployment.deploymentId,
          environment: deployment.environmentId,
        },
        // R3 egress proxies: enable the per-account egress resolution on the
        // production composition. The gateway reads saas_egress_proxies and
        // the accounts' FK columns through the dynamic read grant; until the
        // roles template is re-applied after migration 107 the runtime
        // privilege probe fails closed by design.
        egressProxyResolution: { enabled: true },
        ...(providerHttpEgressAllowlist.entries.length === 0 ? {} : { providerHttpEgressAllowlist }),
      });
      try {
        await gatewayRuntimeModule.checkReady();
      } catch {
        throw new Error('Managed SaaS gateway runtime readiness failed');
      }
    } else if (gatewayEnabled && options.gateway) {
      try {
        await options.gateway.providerCredentialUnsealingKms.checkReady();
      } catch {
        throw new Error('Managed SaaS gateway credential KMS readiness failed');
      }
      gateway = createManagedSaasGatewayProductionComposition(database, options.gateway);
    }

    // Batch-5 §5.2 OEM white-label: the public brand snapshot data plane.
    // Every workload that serves the console HTML or the public endpoint
    // reads through this TTL cache; the control plane additionally
    // materializes the snapshot (the worker started below). A read failure
    // serves the last good snapshot (or the empty default) fail-open — the
    // brand surface is cosmetic and must never take the console down.
    const publicBrandSnapshotStore = new PublicBrandSnapshotStore({ database });
    const brandSnapshotReader = createCachedBrandSnapshotReader(publicBrandSnapshotStore, {
      onError: (error) =>
        console.error('model-router public brand snapshot read failed; serving the cached brand', error),
    });
    const refreshPublicBrandSnapshotAfterWrite = (key: string): void => {
      if (!key.startsWith(BRAND_SETTINGS_KEY_PREFIX)) return;
      void publicBrandSnapshotStore
        .materialize()
        .then(() => brandSnapshotReader.invalidate())
        .catch((error) => console.error('model-router public brand snapshot eager refresh failed', error));
    };

    const handlers: Partial<Record<ListenerName, RequestListener>> = {};
    if (controlPlaneEnabled) {
      if (!providers) throw new Error('Managed SaaS control-plane providers are unavailable');

      const customerDatabase = database;
      const identityService = new SaasIdentityService(database);
      const customerMfaService = await createCustomerMfaForDeployment(database, {
        deployment,
        environment,
        credentialKeyProvider: providers.credentialKeyProvider,
        ...(options.customerMfaCapabilityModuleImporter === undefined
          ? {}
          : { importer: options.customerMfaCapabilityModuleImporter }),
      });
      const customerPasskeyService = await createCustomerPasskeyForDeployment(database, {
        deployment,
        environment,
        credentialKeyProvider: providers.credentialKeyProvider,
        ...(options.customerPasskeyCapabilityModuleImporter === undefined
          ? {}
          : { importer: options.customerPasskeyCapabilityModuleImporter }),
      });
      const customerConsoleQueryService = new SaasConsoleUsageQueryService(database);
      // F3: when customer webhooks are enabled, payments/plans state machines
      // emit transition events through the entitlement-gated producer.
      const webhookEventProducer = options.customerWebhooks?.enabled ? createCustomerWebhookEventProducer() : undefined;
      const customerPlanService = new ByokServicePlanService(database, {
        ...(webhookEventProducer ? { webhookEvents: webhookEventProducer } : {}),
      });
      const platformCatalogService = new PlatformCatalogQueryService(database);
      const supplyProfileResolver = new PostgresSupplyProfileResolver(database);
      const providerSupplyService =
        deployment.providerCredentialKmsKeyId && providers.providerCredentialSealingKms
          ? new ProviderSupplyService(database, {
              deployment: deployment.deploymentId,
              environment: deployment.environmentId,
              kmsKeyId: deployment.providerCredentialKmsKeyId,
              sealingKms: providers.providerCredentialSealingKms,
              ...(providers.providerCredentialRewrappingKms
                ? { rewrappingKms: providers.providerCredentialRewrappingKms }
                : {}),
              supplyProfileResolver,
            })
          : undefined;
      const customerKeyService = new KeyService(database, { resolver: supplyProfileResolver });
      const customerSessionTtlSeconds = options.customerSessionTtlSeconds ?? DEFAULT_CUSTOMER_SESSION_TTL_SECONDS;
      const customerKeyHandler = createSaasKeyHandler({
        service: identityService,
        keyService: customerKeyService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
        sessionTtlSeconds: customerSessionTtlSeconds,
      });
      // R2: affiliate rebates accrue at the wallet funding terminal through
      // the walletFundingHook port (same fulfillment transaction, fail-closed).
      const marketingAffiliateService = new MarketingAffiliateService({
        database,
        fundingLedger: new PlatformWalletLedgerService(),
        inviteCodeSalt: `affiliate-invite-v1:${deployment.deploymentId}`,
      });
      // R4 registration admission (public register + password reset), with
      // F1 platform settings store consumption (task #34). Non-secret
      // admission switches resolve store-first (a store hit wins) with env
      // fallback — an empty store keeps the exact pre-F1 env/default posture.
      // G4 sealed-secret consumption: the only runtime role allowed to hold
      // an unsealing key provider is the gateway-class credential KMS, which
      // reaches the control-plane code path only in the combined workload
      // through the injected gateway composition (split control-plane
      // workloads get no unsealing KMS and keep the F1 env-only posture —
      // the service fails closed with UNSEALING_UNAVAILABLE on sealed reads).
      // When an unsealing KMS IS wired, store-carried secrets (Turnstile
      // secret, SMTP password) win over the environment through the audited
      // withSettingSecret path, and an unseal failure fails closed (no
      // silent env fallback against a present store envelope). Unconfigured
      // SMTP degrades to the console sender (the alerts.ts behavior) so
      // nothing dials out by surprise; default mode is fail-closed (closed).
      const platformSettingsUnsealingKms = options.gateway?.providerCredentialUnsealingKms;
      const platformSettingsSealing =
        providers?.providerCredentialSealingKms && deployment.providerCredentialKmsKeyId
          ? {
              sealingKms: providers.providerCredentialSealingKms,
              kmsKeyId: deployment.providerCredentialKmsKeyId,
            }
          : {};
      const platformSettingsService = new PlatformSettingsService(database, {
        ...platformSettingsSealing,
        ...(platformSettingsSealing.kmsKeyId !== undefined || platformSettingsUnsealingKms !== undefined
          ? {
              sealContext: {
                deployment: deployment.deploymentId,
                environment: deployment.environmentId,
              },
            }
          : {}),
        ...(platformSettingsUnsealingKms === undefined ? {} : { unsealingKms: platformSettingsUnsealingKms }),
      });
      // The env snapshot stays the constructor-validated fallback; the live
      // resolver merges the store overlay over the environment on every
      // admission decision. A resolution failure (unreadable store or a
      // misconfigured overlay) fails closed to the parser's empty-source
      // defaults rather than admitting traffic against an unverifiable
      // configuration. G4: sealed secrets join the overlay store-first only
      // when an unsealing KMS is wired; otherwise the env-only posture holds.
      const registrationSettings = parseRegistrationAdmissionSettings(process.env);
      const resolveRegistrationSettingsFailClosed = async (): Promise<RegistrationAdmissionSettings> => {
        try {
          return resolveRegistrationAdmissionSettings(
            {
              ...(await platformSettingsService.readRegistrationSettingsOverlay()),
              ...(platformSettingsUnsealingKms === undefined
                ? {}
                : await platformSettingsService.readRegistrationSecretsOverlay(
                    PLATFORM_SETTINGS_CONSUMER_REGISTRATION_ADMISSION,
                  )),
            },
            process.env,
          );
        } catch (error) {
          console.error('model-router registration settings resolution failed; failing closed', error);
          return parseRegistrationAdmissionSettings({});
        }
      };
      const registrationEmailSender: EmailSender = {
        send: async (message) => {
          const settings = await resolveRegistrationSettingsFailClosed();
          const sender =
            settings.smtp === undefined
              ? new ConsoleEmailSender()
              : new SmtpEmailSender({
                  host: settings.smtp.host,
                  port: settings.smtp.port,
                  secure: settings.smtp.secure,
                  ...(settings.smtp.username === undefined ? {} : { username: settings.smtp.username }),
                  ...(settings.smtp.password === undefined ? {} : { password: settings.smtp.password }),
                  from: settings.smtp.from,
                });
          return sender.send(message);
        },
      };
      // The captcha proof re-resolves per verification so a store-side
      // turnstile.enabled flip can never diverge from the proof backend the
      // register endpoints actually enforce (fail-open hole otherwise).
      const registrationCaptcha: CaptchaProof = {
        backend: registrationSettings.turnstile.enabled ? 'turnstile' : 'disabled',
        verify: async (input) => {
          const settings = await resolveRegistrationSettingsFailClosed();
          const proof = createCaptchaProof(
            settings.turnstile.enabled && settings.turnstile.secret !== undefined
              ? { backend: 'turnstile', secret: settings.turnstile.secret }
              : { backend: 'disabled' },
          );
          return proof.verify({
            token: input.token,
            ...(input.remoteIp === undefined ? {} : { remoteIp: input.remoteIp }),
          });
        },
      };
      const registrationService = new RegistrationService({
        database,
        identity: identityService,
        verification: new EmailVerificationService({
          database,
          emailSender: registrationEmailSender,
        }),
        captcha: registrationCaptcha,
        settings: registrationSettings,
        settingsResolver: resolveRegistrationSettingsFailClosed,
        sessionTtlSeconds: customerSessionTtlSeconds,
        affiliate: new MarketingRegistrationRewards({
          database,
          affiliate: marketingAffiliateService,
          fundingLedger: new PlatformWalletLedgerService(),
          rewards: registrationSettings.rewards,
          rewardsResolver: async () => (await resolveRegistrationSettingsFailClosed()).rewards,
        }),
      });
      const customerIdentityOptions: SaasIdentityHttpOptions = {
        service: identityService,
        ...(customerMfaService === undefined ? {} : { customerMfa: customerMfaService }),
        ...(customerPasskeyService === undefined ? {} : { customerPasskey: customerPasskeyService }),
        keyService: customerKeyService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
        sessionTtlSeconds: customerSessionTtlSeconds,
        rateLimiter: providers.customerAuthRateLimiter as ManagedRateLimiter,
        registration: {
          service: registrationService,
          sendRateLimiter: providers.customerAuthCodeSendRateLimiter as ManagedRateLimiter,
        },
        captcha: registrationCaptcha,
      };
      const customerIdentityHandler = createSaasIdentityHandler(customerIdentityOptions);
      const customerPlanHandler = createSaasPlanCatalogHandler({
        service: identityService,
        planService: customerPlanService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      const customerConsoleHandler = createSaasConsoleHandler({
        service: identityService,
        queryService: customerConsoleQueryService,
        customerWalletQueryService: new SaasCustomerWalletQueryService(database),
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      const customerRefundHistoryHandler = createSaasCustomerRefundHistoryHandler({
        service: {
          getSession: (token) => identityService.getSession(token),
          resolveTenantBillingContext: (input) => resolveCustomerRefundTenantContext(customerDatabase, input),
        },
        refundQueryService: new SaasCustomerRefundQueryService(database),
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      const customerPaymentOrderHistoryHandler = createSaasCustomerPaymentOrderHistoryHandler({
        service: {
          getSession: (token) => identityService.getSession(token),
          resolveTenantBillingContext: (input) => resolveCustomerRefundTenantContext(customerDatabase, input),
        },
        paymentOrderQueryService: new SaasCustomerPaymentOrderQueryService(database),
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      // G1: balance-type redeem codes post into the platform wallet through the
      // shared postVerifiedFunding port (idempotency namespace marketing.redeem).
      // G1.5: subscription-type codes grant through the plans service's
      // marketing grant port inside the redeem transaction (no wallet effects).
      const marketingRedeemCodeService = new MarketingRedeemCodeService({
        database,
        fundingLedger: new PlatformWalletLedgerService(),
        subscriptionGrants: customerPlanService,
      });
      const customerMarketingRedeemHandler = createMarketingCustomerRedeemHandler({
        service: identityService,
        redeemService: marketingRedeemCodeService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      // G4: announcements. G4.5 wires the frozen no-op event port; the
      // fan-out worker below produces the actual webhook events.
      const marketingAnnouncementService = new MarketingAnnouncementService({
        database,
        events: createAnnouncementFanoutEventPort(),
      });
      const customerMarketingAnnouncementsHandler = createMarketingAnnouncementCustomerHttpHandler({
        service: identityService,
        operations: marketingAnnouncementService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      // R1: promo codes feed the checkout pricing snapshot through the
      // walletTopUpPromo port (priced inside the order transaction).
      const marketingPromoCodeService = new MarketingPromoCodeService({ database });
      // R2: affiliate service is constructed with the R4 registration wiring
      // above (the registration rewards adapter shares it); only the customer
      // HTTP handler mounts here.
      const customerMarketingAffiliateHandler = createMarketingAffiliateCustomerHttpHandler({
        service: identityService,
        operations: marketingAffiliateService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      let customerWebhookHandler: CustomerWebhookHttpHandler | undefined;
      if (options.customerWebhooks?.enabled) {
        const protector = options.customerWebhooks.signingSecretProtector;
        const egressTransport = options.customerWebhooks.egressTransport;
        if (!protector || !egressTransport) {
          throw new Error('Managed SaaS customer webhook protector and egress dependencies are unavailable');
        }
        const endpointService = new CustomerWebhookEndpointService(database, protector);
        const deliveryStore = new PostgresCustomerWebhookDeliveryStore(database);
        const deliveryWorker = new CustomerWebhookDeliveryWorker(
          deliveryStore,
          protector,
          egressTransport,
          options.customerWebhooks.workerOptions,
        );
        customerWebhookWorker = startCustomerWebhookDeliveryWorker(deliveryWorker, {
          ...(options.customerWebhooks.intervalMs === undefined
            ? {}
            : { intervalMs: options.customerWebhooks.intervalMs }),
          concurrency: options.customerWebhooks.workerOptions?.concurrency ?? 8,
        });
        // F3: the scan-derived events (wallet.low_balance / api_key.expiring)
        // are option-gated separately from delivery; the producer is shared.
        if (options.customerWebhooks.notificationScan !== undefined) {
          const notificationProducer = webhookEventProducer ?? createCustomerWebhookEventProducer();
          customerWebhookScanner = startCustomerWebhookNotificationScanner(
            new CustomerWebhookNotificationScanner(database, notificationProducer, {
              ...(options.customerWebhooks.notificationScan.batchSize === undefined
                ? {}
                : { batchSize: options.customerWebhooks.notificationScan.batchSize }),
              ...(options.customerWebhooks.notificationScan.expiringKeyWindowMs === undefined
                ? {}
                : { expiringKeyWindowMs: options.customerWebhooks.notificationScan.expiringKeyWindowMs }),
            }),
            {
              ...(options.customerWebhooks.notificationScan.intervalMs === undefined
                ? {}
                : { intervalMs: options.customerWebhooks.notificationScan.intervalMs }),
            },
          );
        }
        // F4: terminal delivery/attempt retention pruning is option-gated
        // separately; immutable event facts are never touched by the pruner.
        if (options.customerWebhooks.retentionPrune !== undefined) {
          customerWebhookPruner = startCustomerWebhookRetentionPruner(deliveryStore, {
            ...(options.customerWebhooks.retentionPrune.intervalMs === undefined
              ? {}
              : { intervalMs: options.customerWebhooks.retentionPrune.intervalMs }),
            ...(options.customerWebhooks.retentionPrune.retentionMs === undefined
              ? {}
              : { retentionMs: options.customerWebhooks.retentionPrune.retentionMs }),
            ...(options.customerWebhooks.retentionPrune.limit === undefined
              ? {}
              : { limit: options.customerWebhooks.retentionPrune.limit }),
          });
        }
        // G4.5: the announcement fan-out sweep produces platform.maintenance
        // events from the publish cursor; publish itself stays O(1).
        announcementFanoutWorker = startAnnouncementFanoutWorker(
          database,
          marketingAnnouncementService,
          webhookEventProducer ?? createCustomerWebhookEventProducer(),
          {
            ...(options.customerWebhooks.announcementFanout?.batchSize === undefined
              ? {}
              : { batchSize: options.customerWebhooks.announcementFanout.batchSize }),
            ...(options.customerWebhooks.announcementFanout?.intervalMs === undefined
              ? {}
              : { intervalMs: options.customerWebhooks.announcementFanout.intervalMs }),
            onError: () => console.error('model-router announcement fan-out cycle failed'),
          },
        );
        customerWebhookHandler = createCustomerWebhookHandler({
          service: identityService,
          database,
          endpointService,
          deliveryStore,
          publicOrigin: deploymentListener(deployment, 'customer').origin,
        });
      }
      const customerByokHandler = createCustomerByokHttpHandler({
        service: identityService,
        supplyService: providerSupplyService,
        catalog: platformCatalogService,
        supplyProfileResolver,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
      });
      let paymentHandler = options.paymentHandler;
      if (options.payments) {
        // R1 (105): wallet topup conversion through the tenant's default
        // billing-group topup multiplier. F1: amount-tier discounts resolve
        // store-first from the saas.payments.topup.amount_tier_discounts
        // platform settings key (an empty store keeps the no-discounts
        // default). A store read failure fails the fulfillment closed
        // (FULFILLMENT_RETRYABLE) — never a silent discount skip.
        const billingGroupsService = new SaasBillingGroupsService(database);
        const paymentService = new PaymentFulfillmentService(database, options.payments.adapter, {
          providerKey: options.payments.providerKey,
          merchantId: options.payments.merchantId,
          checkout: options.payments.checkout,
          checkoutRedirectPolicies: options.payments.checkoutRedirectPolicies,
          submissionLeaseTtlMs: options.payments.submissionLeaseTtlMs,
          servicePlanService: customerPlanService,
          walletTopUpPromo: marketingPromoCodeService,
          walletFundingHook: marketingAffiliateService,
          topupCredit: {
            resolveTopupCredit: async (executor, input) => {
              const tiers = await platformSettingsService.readTopupAmountTierDiscounts();
              return billingGroupsService.resolveTopupCredit(executor, input, { tiers });
            },
          },
          ...(webhookEventProducer ? { webhookEvents: webhookEventProducer } : {}),
        });
        paymentWorker = startPaymentWebhookWorker(paymentService, {
          onError: () => console.error('model-router payment webhook worker cycle failed'),
          onExhausted: (count) =>
            console.error(`model-router payment webhook events moved to reconciliation: ${count}`),
        });
        paymentHandler = createSaasPaymentHandler({
          service: identityService,
          paymentService,
          walletTopUpPolicy: options.payments.walletTopUpPolicy,
          publicOrigin: deploymentListener(deployment, 'customer').origin,
        });
      }

      const platformAuthService = new PlatformAdminAuthService(database, providers.credentialKeyProvider, {
        sessionTtlSeconds: options.platformSessionTtlSeconds ?? DEFAULT_PLATFORM_SESSION_TTL_SECONDS,
      });
      const platformAuthHandler = createPlatformAdminAuthHandler({
        service: platformAuthService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
        rateLimiter: providers.platformAuthRateLimiter,
        sessionTtlSeconds: options.platformSessionTtlSeconds ?? DEFAULT_PLATFORM_SESSION_TTL_SECONDS,
      });
      const platformAccessService = createPlatformAdminAccessService({
        authService: platformAuthService,
        database,
      });
      const platformCredentialRewrapHandler =
        providerSupplyService && providers.providerCredentialRewrappingKms && deployment.providerCredentialKmsKeyId
          ? createPlatformCredentialRewrapHttpHandler({
              access: platformAccessService,
              operations: createPlatformCredentialRewrapOperations({
                database,
                service: providerSupplyService,
                destinationKmsKeyId: deployment.providerCredentialKmsKeyId,
              }),
              publicOrigin: deploymentListener(deployment, 'platform').origin,
              authService: platformAuthService,
            })
          : undefined;
      // P1c Codex OAuth account binding surface (Phase 1.2 mount): available
      // exactly when the supply service (sealing + audited account/credential
      // creation) is wired. The sink resolves the openai-codex catalog binding
      // from the control-plane database and fails closed until the provider is
      // registered (saas/catalog/codex-registration.ts).
      const codexOauthHandler = providerSupplyService
        ? createCodexOauthHttpHandler({
            access: platformAccessService,
            authService: platformAuthService,
            service: new CodexOAuthBindingService({ sessionStore: new InMemoryBindingSessionStore() }),
            sink: createProviderSupplyCodexCredentialSink({
              supply: providerSupplyService,
              resolveCatalogBinding: createPostgresCodexCatalogBindingResolver(database),
            }),
            publicOrigin: deploymentListener(deployment, 'platform').origin,
          })
        : undefined;
      // Batch-3 Grok OAuth account binding surface: available exactly when
      // the supply service is wired, mirroring the codex mount. The sink
      // resolves the xai-grok catalog binding from the control-plane
      // database and fails closed until the provider is registered
      // (saas/catalog/grok-registration.ts).
      const grokOauthHandler = providerSupplyService
        ? createGrokOauthHttpHandler({
            access: platformAccessService,
            authService: platformAuthService,
            service: new GrokOAuthBindingService({ sessionStore: new InMemoryGrokBindingSessionStore() }),
            sink: createProviderSupplyGrokCredentialSink({
              supply: providerSupplyService,
              resolveCatalogBinding: createPostgresGrokCatalogBindingResolver(database),
            }),
            publicOrigin: deploymentListener(deployment, 'platform').origin,
          })
        : undefined;
      // R6a active probing admin surface: the trigger/list endpoints run on
      // the control-plane role (monitor registry CRUD). The probe itself
      // executes asynchronously in the probe monitor worker on the
      // credential-validation-worker workload, so the trigger only marks the
      // monitor due; no credential ever passes through this handler.
      const accountProbeHandler = createAccountProbeHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        store: createPostgresProbeMonitorAdminStore(database),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // F1 platform settings admin surface (task #34): GET/PUT
      // /admin/api/v1/platform-settings on the control-plane role — the only
      // role with grants on saas_platform_settings. Secret values are sealed
      // at write time and never echoed; every mutation is audited with a
      // redacted before/after diff.
      const platformSettingsAdminHandler = createPlatformSettingsHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        service: platformSettingsService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
        // Batch-5 §5.2: a brand-key write re-materializes the public snapshot
        // immediately instead of waiting for the periodic cycle.
        afterWrite: refreshPublicBrandSnapshotAfterWrite,
      });
      // F5 console surfaces (task #38): the R1 billing-groups admin CRUD,
      // the R3 egress-proxy admin CRUD (credentials sealed server-side
      // through the provider-credential KMS, never echoed), the R5b
      // opencode-go adaptive-routing rule-table CAS editor, and the
      // read-only opencode-go model-catalog view. All follow the
      // codex-oauth admin contract; audit writes are best-effort on the
      // control-plane role.
      const billingGroupsAdminHandler = createBillingGroupsHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        service: new SaasBillingGroupsService(database),
        audit: createPostgresBillingGroupsAuditWriter(database),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // Batch-4 §4.4 composite model routing: the composite-group route
      // registry admin surface (CRUD + the three-level resolution preview).
      const compositeModelRoutesAdminHandler = createCompositeModelRoutesHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        service: new SaasCompositeModelRoutesService(database),
        audit: createPostgresCompositeModelRoutesAuditWriter(database),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // Batch-5 §5.4 (task #19): the content risk-control admin surface
      // (config, decision logs, unban, blocklist lifecycle, retention sweep).
      const riskControlAdminHandler = createRiskControlHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        store: new PostgresRiskControlAdminStore(database),
        audit: createPostgresRiskControlAuditWriter(database),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // Batch-5 §5.1 plugin admin surface (install/enable/disable/config/
      // delete). The control plane verifies packages and writes the
      // authoritative DB state; the plugin-host workload converges to it —
      // the control plane NEVER spawns a plugin (types.ts decision #1).
      const pluginsAdminHandler = createPluginsHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        service: new PluginAdminService({
          store: new PostgresPluginStore({ database }),
          trustedPublishers: deployment.pluginsTrustedPublishers ?? {},
          allowUnsigned: deployment.pluginsAllowUnsigned === true,
        }),
        store: new PostgresPluginStore({ database }),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      const egressProxiesAdminHandler =
        providers.providerCredentialSealingKms && deployment.providerCredentialKmsKeyId
          ? createEgressProxiesHttpHandler({
              access: platformAccessService,
              authService: platformAuthService,
              store: createPostgresEgressProxyAdminStore(database, {
                deployment: deployment.deploymentId,
                environment: deployment.environmentId,
                kms: providers.providerCredentialSealingKms,
                kmsKeyId: deployment.providerCredentialKmsKeyId,
              }),
              audit: createPostgresEgressProxyAuditWriter(database),
              publicOrigin: deploymentListener(deployment, 'platform').origin,
            })
          : undefined;
      const opencodeGoRulesAdminHandler = createOpencodeGoRulesHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        store: createPostgresOpencodeGoRulesStore(database),
        audit: createPostgresOpencodeGoRulesAuditWriter(database),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // Read-only model-catalog view. The control plane holds no
      // credential-unsealing KMS, so the live upstream sync cache cannot be
      // read through here; the built-in fallback catalog (the cache module's
      // never-fail floor) is served, and deployments able to supply a
      // resolver seam can inject a live cache.
      const opencodeGoModelsAdminHandler = createOpencodeGoModelCatalogHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        resolveModels: () => mergeOpenCodeGoModelCatalog(null),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      let platformRefundHandler: PlatformRefundHttpHandler | undefined;
      if (options.payments?.refundAdapter) {
        const refundService = new PaymentRefundService(database, options.payments.refundAdapter, {
          providerKey: options.payments.providerKey,
          merchantId: options.payments.merchantId,
          operations: createPlatformPaymentRefundOperations(),
          ...(webhookEventProducer ? { webhookEvents: webhookEventProducer } : {}),
        });
        refundWorker = startPaymentRefundWorker(refundService, {
          onError: () => console.error('model-router payment refund reconciliation cycle failed'),
          onUnresolved: (count) => console.error(`model-router payment refunds remain unresolved: ${count}`),
        });
        platformRefundHandler = createPlatformRefundHttpHandler({
          access: platformAccessService,
          service: refundService,
          publicOrigin: deploymentListener(deployment, 'platform').origin,
          authService: platformAuthService,
        });
      }
      // Const captures preserve the earlier undefined-narrowing inside probe closures.
      const operationsDatabase = database;
      const operationsProviders = providers;
      const platformOperationsService = new PlatformOperationsSummaryService(database, {
        probes: {
          // The control-plane connection doubles as the PostgreSQL probe.
          postgresql: async () => {
            await operationsDatabase.query('SELECT 1');
            return 'ok' as const;
          },
          redis: async () => {
            await operationsProviders.redisReady();
            return 'ok' as const;
          },
          kms: async () => {
            await operationsProviders.credentialKeyReady();
            return 'ok' as const;
          },
          // Worker liveness is a heartbeat signal: any validation-job write
          // (claim, completion, requeue) in the last 10 minutes on either the
          // tenant or platform queue. An idle queue reports 'degraded'.
          worker: async () => {
            const heartbeat = await operationsDatabase.query(
              `SELECT 1 AS present
                 FROM (
                   SELECT 1 FROM saas_tenant_provider_credential_validation_jobs
                    WHERE updated_at > clock_timestamp() - interval '10 minutes'
                   UNION ALL
                   SELECT 1 FROM saas_platform_provider_credential_validation_jobs
                    WHERE updated_at > clock_timestamp() - interval '10 minutes'
                 ) AS worker_heartbeat
                LIMIT 1`,
            );
            return heartbeat.rows.length === 1 ? ('ok' as const) : ('degraded' as const);
          },
        },
      });
      const platformCapacityPolicyService = new PlatformCapacityPolicyService(database);
      const capacityPolicyDatabase = database;
      const platformCapacityPolicyTargets: PlatformAdminCapacityPolicyTargetSelectors = {
        listTenantIds: async (afterId, limit) => {
          const result = await capacityPolicyDatabase.query<{ readonly id: unknown }>(
            `SELECT id::text AS id
               FROM saas_tenants
              WHERE ($1::uuid IS NULL OR id > $1::uuid)
              ORDER BY id ASC
              LIMIT $2`,
            [afterId ?? null, limit],
          );
          return result.rows.map((row) => (typeof row.id === 'string' ? row.id : ''));
        },
        listProjectIds: async (tenantId, afterId, limit) => {
          const result = await capacityPolicyDatabase.query<{ readonly id: unknown }>(
            `SELECT id::text AS id
               FROM saas_projects
              WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
              ORDER BY id ASC
              LIMIT $3`,
            [tenantId, afterId ?? null, limit],
          );
          return result.rows.map((row) => (typeof row.id === 'string' ? row.id : ''));
        },
        listApiKeyIds: async (tenantId, projectId, afterId, limit) => {
          const result = await capacityPolicyDatabase.query<{ readonly id: unknown }>(
            `SELECT id::text AS id
               FROM saas_api_keys
              WHERE tenant_id = $1 AND project_id = $2
                AND ($3::uuid IS NULL OR id > $3::uuid)
              ORDER BY id ASC
              LIMIT $4`,
            [tenantId, projectId, afterId ?? null, limit],
          );
          return result.rows.map((row) => (typeof row.id === 'string' ? row.id : ''));
        },
      };
      const platformCatalogWriter = new SaasCatalogService(database);
      const platformPricingService = new SaasPricingService(database);
      const platformAuditService =
        auditCursorSecret === undefined
          ? undefined
          : new PlatformAuditQueryService(database, { cursorSecret: auditCursorSecret });
      const platformReadHandler = createPlatformAdminReadHandler({
        access: platformAccessService,
        operations: platformOperationsService,
        catalog: {
          listProducts: (query) => platformCatalogService.listProducts(query),
          listCapabilities: (query) => platformCatalogService.listCapabilities(query),
          listRights: (query) => platformCatalogService.listRights(query),
          registerProviderRightsVersion: (input) => platformCatalogWriter.registerProviderRightsVersion(input),
          revokeProviderRights: (input) => platformCatalogWriter.revokeProviderRights(input),
        },
        audit: platformAuditService,
        pricing: platformPricingService,
        supply: providerSupplyService,
        capacityPolicies: platformCapacityPolicyService,
        capacityPolicyTargets: platformCapacityPolicyTargets,
        governance: {
          users: new PlatformUserGovernanceService(database),
          tenants: new PlatformTenantLifecycleService(database),
          operators: new PlatformOperatorManagementService(database),
        },
        // F4: platform-side webhook quota provisioning rides the same audited
        // control-plane database; absent webhook capability leaves the route 503.
        ...(options.customerWebhooks?.enabled
          ? { webhookTenantPolicies: new CustomerWebhookTenantPolicyService(database) }
          : {}),
        writeSecurity: {
          publicOrigin: deploymentListener(deployment, 'platform').origin,
          authService: platformAuthService,
        },
      });
      const scannerOptions = options.unknownOutcomeScanner;
      const workerOptions =
        scannerOptions === undefined ||
        (scannerOptions.batchSize === undefined &&
          scannerOptions.leaseMs === undefined &&
          scannerOptions.maxAttempts === undefined)
          ? undefined
          : {
              ...(scannerOptions.batchSize === undefined ? {} : { batchSize: scannerOptions.batchSize }),
              ...(scannerOptions.leaseMs === undefined ? {} : { leaseMs: scannerOptions.leaseMs }),
              ...(scannerOptions.maxAttempts === undefined ? {} : { maxAttempts: scannerOptions.maxAttempts }),
            };
      const createRecoveryWorkflow =
        options.createUnknownOutcomeRecoveryWorkflow ?? createUnknownOutcomeRecoveryWorkflow;
      const recoveryWorkflow = createRecoveryWorkflow({
        database,
        metering: new SaasMeteringService(database),
        keyBudget: createKeyBudgetResolution(),
        billingGroupSpend: createBillingGroupSpendResolution(),
        ...(workerOptions === undefined ? {} : { worker: workerOptions }),
      });
      const unknownOutcomePlatformHandler = createUnknownOutcomePlatformHttpHandler({
        access: platformAccessService,
        operations: {
          listCases: ({ tenantId, limit }) => recoveryWorkflow.operatorResolution.list(tenantId, limit),
          getCase: ({ tenantId, caseId }) => recoveryWorkflow.operatorResolution.get(tenantId, caseId),
          resolveCase: (input) => recoveryWorkflow.operatorResolution.resolveNotExecuted(input),
        },
        publicOrigin: deploymentListener(deployment, 'platform').origin,
        authService: platformAuthService,
      });
      const usageCorrectionService = new UsageCorrectionService(database, {
        ledger: new PlatformWalletLedgerService(),
        keyBudget: createKeyBudgetResolution(),
        billingGroupSpend: createBillingGroupSpendResolution(),
      });
      const usageCorrectionPlatformHandler = createUsageCorrectionPlatformHttpHandler({
        access: platformAccessService,
        operations: {
          listCorrections: ({ tenantId, usageEventId, limit }) =>
            usageCorrectionService.listUsageCorrections({
              tenantId,
              ...(usageEventId === undefined ? {} : { usageEventId }),
              limit,
            }),
          recordCorrection: ({ actorUserId, ...input }) =>
            usageCorrectionService.recordUsageCorrection({
              ...input,
              operatorIdentity: actorUserId,
            }),
        },
        publicOrigin: deploymentListener(deployment, 'platform').origin,
        authService: platformAuthService,
      });
      const marketingOpsRedeemCodesHandler = createMarketingOpsRedeemCodesHandler({
        access: platformAccessService,
        authService: platformAuthService,
        redeemCodes: marketingRedeemCodeService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      const marketingOpsAnnouncementsHandler = createMarketingAnnouncementPlatformHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        operations: marketingAnnouncementService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      const marketingOpsPromoCodesHandler = createMarketingOpsPromoCodesHandler({
        access: platformAccessService,
        authService: platformAuthService,
        promoCodes: marketingPromoCodeService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      const marketingOpsAffiliateHandler = createMarketingAffiliateOpsHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        operations: marketingAffiliateService,
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      // R4 production assembly (decision A): the OAuth refresh worker runs
      // inside the control-plane workload with the audited rotation path.
      // Enabling it requires the deployment-provided unsealing KMS and audit
      // operator identity; it is mutually exclusive with the worker-workload rotator seam.
      if (options.oauthTokenRefresh !== undefined) {
        if (options.oauthTokenRefreshRotator !== undefined) {
          throw new Error('Managed SaaS oauthTokenRefresh and oauthTokenRefreshRotator cannot both be configured');
        }
        if (!providerSupplyService) {
          throw new Error('Managed SaaS OAuth token refresh requires the provider credential sealing KMS');
        }
        const refresh = options.oauthTokenRefresh;
        // Decision A requires the audit actor to be an existing saas_users
        // identity; the control-plane role already holds saas_users SELECT, so
        // prove it once here and fail the whole startup otherwise.
        const operator = await database.query<{ readonly id: unknown }>(
          'SELECT id FROM saas_users WHERE id = $1 AND disabled_at IS NULL LIMIT 1',
          [refresh.operatorUserId],
        );
        if (operator.rowCount !== 1 || typeof operator.rows[0]?.id !== 'string') {
          throw new Error(
            'Managed SaaS OAuth token refresh operatorUserId must reference an enabled saas_users identity',
          );
        }
        const rotator = createManagedOauthTokenRefreshRotator(providerSupplyService, refresh.operatorUserId);
        oauthRefreshWorker = startOauthTokenRefreshWorker(database, refresh.unsealingKms, rotator, {
          ...(refresh.batchSize === undefined ? {} : { batchSize: refresh.batchSize }),
          ...(refresh.pollIntervalMs === undefined ? {} : { pollIntervalMs: refresh.pollIntervalMs }),
          deployment: deployment.deploymentId,
          environment: deployment.environmentId,
          // R9 §4 P1: control-plane OAuth refresh egress honors the same
          // operator allowlist (empty = strict global-only posture).
          ...providerEgressAllowlistOption,
        } as Parameters<typeof startOauthTokenRefreshWorker>[3]);
      }
      const startScanner = options.startUnknownOutcomeScanner ?? startUnknownOutcomeScanner;
      unknownOutcomeScanner = startScanner(recoveryWorkflow.worker, {
        ...(scannerOptions?.intervalMs === undefined ? {} : { intervalMs: scannerOptions.intervalMs }),
        onError: () => console.error('model-router managed unknown-outcome scanner cycle failed'),
        onOperatorRequired: (count) =>
          console.error(`model-router managed unknown-outcome scanner operator-required cases: ${count}`),
        onFailed: (count) => console.error(`model-router managed unknown-outcome scanner failed claims: ${count}`),
      });

      // Phase 3 observability: read-only metrics/SSE/status surface on the
      // control-plane listener plus the two single-leader workers behind it.
      const observabilityDatabase = database;
      const observabilityAlertService = new ObservabilityAlertService(observabilityDatabase);
      const observabilityAlertSilenceService = new ObservabilityAlertSilenceService(observabilityDatabase);
      // Batch-5 §5.6: the operator silence CRUD surface (the
      // composite-routes contract shape) mounted next to the read-only
      // observability handler.
      const alertSilencesHandler = createAlertSilencesHttpHandler({
        access: platformAccessService,
        authService: platformAuthService,
        service: observabilityAlertSilenceService,
        audit: createPostgresAlertSilencesAuditWriter(observabilityDatabase),
        publicOrigin: deploymentListener(deployment, 'platform').origin,
      });
      const observabilityHandler = createObservabilityHttpHandler({
        access: platformAccessService,
        channelStatus: (query) => getChannelStatusPage(observabilityDatabase, query),
        alertRules: () => observabilityAlertService.listRules(),
        alertEvents: (limit) => observabilityAlertService.listEvents(limit),
        refreshMetrics: () => refreshSaasRuntimeGauges(observabilityDatabase),
      });
      channelStatusWorker = startChannelStatusWorker(database, {
        onError: (phase, error) =>
          console.error(`model-router managed observability channel-status ${phase} cycle failed`, error),
      });
      alertEvaluatorWorker = startAlertEvaluatorWorker(database, {
        onError: (error) => console.error('model-router managed observability alert evaluator cycle failed', error),
      });
      // Batch-5 §5.6: the scheduled email reports (daily/weekly summary,
      // error digest, account health). The SMTP transport reuses the
      // registration email sender seam (settings-resolved, console fallback
      // when unconfigured); last_run persists in the migration-127 PG rows.
      reportSchedulerWorker = startReportSchedulerWorker(database, {
        emailSender: registrationEmailSender,
        templateDir: process.env.MODEL_ROUTER_SAAS_OBS_REPORT_TEMPLATE_DIR?.trim() || undefined,
        onError: (error, type) =>
          console.error(`model-router managed observability report ${type ?? 'scheduler'} cycle failed`, error),
      });
      // R6a: probe run retention (30 days) prunes on the control-plane role —
      // the validation-worker role that appends the history rows holds no
      // table-level grants by contract, so the DELETE lives here next to the
      // observability retention loops.
      probeRunRetentionWorker = (options.startProbeRunRetentionWorker ?? startProbeRunRetentionWorker)(database, {
        ...(options.probeRunRetentionWorkerOptions ?? {}),
        onError: () => console.error('model-router managed probe run retention cycle failed'),
      });
      // Batch-5 §5.4 (task #19): moderation log retention (hit/non-hit
      // windows) plus flagged-hash expiry, on the control-plane DELETE grant.
      riskControlRetentionWorker = startRiskControlRetentionWorker(database, {
        onError: (error) => console.error('model-router managed risk-control retention cycle failed', error),
      });

      // Batch-5 §5.2 OEM white-label: the control plane owns the snapshot
      // materialization loop (periodic cycles; the first is delayed by the
      // interval so startup stays read-only). A failed cycle keeps the
      // previously materialized snapshot serving and reschedules.
      publicBrandSnapshotWorker = startPublicBrandSnapshotWorker(publicBrandSnapshotStore, {
        ...(options.publicBrandSnapshot?.intervalMs === undefined
          ? {}
          : { intervalMs: options.publicBrandSnapshot.intervalMs }),
        onError: (error) => console.error('model-router public brand snapshot materialization cycle failed', error),
      });

      handlers.customer = createCustomerHandler(
        customerKeyHandler,
        customerIdentityHandler,
        customerPlanHandler,
        customerConsoleHandler,
        customerWebhookHandler,
        customerByokHandler,
        customerRefundHistoryHandler,
        customerPaymentOrderHistoryHandler,
        customerMarketingRedeemHandler,
        customerMarketingAnnouncementsHandler,
        customerMarketingAffiliateHandler,
        paymentHandler,
        webDistPath,
        brandSnapshotReader,
      );
      handlers.platform = createPlatformHandler(
        platformAuthHandler,
        platformRefundHandler,
        platformCredentialRewrapHandler,
        codexOauthHandler,
        grokOauthHandler,
        accountProbeHandler,
        platformSettingsAdminHandler,
        billingGroupsAdminHandler,
        compositeModelRoutesAdminHandler,
        riskControlAdminHandler,
        pluginsAdminHandler,
        egressProxiesAdminHandler,
        opencodeGoRulesAdminHandler,
        opencodeGoModelsAdminHandler,
        unknownOutcomePlatformHandler,
        usageCorrectionPlatformHandler,
        marketingOpsRedeemCodesHandler,
        marketingOpsAnnouncementsHandler,
        marketingOpsPromoCodesHandler,
        marketingOpsAffiliateHandler,
        observabilityHandler,
        alertSilencesHandler,
        platformReadHandler,
        webDistPath,
        brandSnapshotReader,
      );
    }

    if (gatewayEnabled) {
      handlers.gateway = createGatewayHandler(
        gateway?.handler,
        createPublicBrandSettingsHttpHandler({
          read: brandSnapshotReader.read,
          onError: (error) => console.error('model-router public brand snapshot read failed', error),
        }),
      );
    }

    for (const name of listenerNames) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Managed SaaS ${name} handler is not configured for this workload`);
      listeners.set(name, createListener(name, handler));
    }

    for (const name of listenerNames) {
      const listener = listeners.get(name);
      if (!listener) throw new Error(`Managed SaaS ${name} listener was not created`);
      const listenerConfig = deploymentListener(deployment, name);
      await bindListener(listener, listenerConfig);
      console.log(`model-router managed ${name} listening on ${listenerAddress(listenerConfig)}`);
    }

    const boundListeners = Object.fromEntries(listeners) as Partial<Record<ListenerName, Server>>;
    const runtime: ManagedSaasRuntime = {
      deployment,
      database,
      providers: providers ?? null,
      gateway: gateway ?? null,
      credentialValidationWorker: null,
      quotaSyncWorker: null,
      opencodeGoUsageWorker: null,
      geminiUsageWorker: null,
      cnProvidersQuotaWorker: null,
      openRouterModelPricingSyncWorker: null,
      egressProxyProbeWorker: null,
      probeMonitorWorker: null,
      probeRunRetentionWorker: probeRunRetentionWorker ?? null,
      riskControlRetentionWorker: riskControlRetentionWorker ?? null,
      publicBrandSnapshotWorker: publicBrandSnapshotWorker ?? null,
      oauthTokenRefreshWorker: oauthRefreshWorker ?? null,
      announcementFanoutWorker: announcementFanoutWorker ?? null,
      unknownOutcomeScanner: unknownOutcomeScanner ?? null,
      listeners: boundListeners,
      close,
    };
    if (options.installSignalHandlers !== false) removeSignals = installSignals(runtime);
    await options.onReady?.(runtime);
    return runtime;
  } catch (error) {
    removeSignals?.();
    removeSignals = undefined;
    if (options.gateway && !gateway) {
      await Promise.allSettled([Promise.resolve().then(() => options.gateway?.providerCredentialUnsealingKms.close())]);
    }
    await close();
    throw error;
  }
}
