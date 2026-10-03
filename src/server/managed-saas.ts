import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SaasCustomerWalletQueryService } from '../saas/billing/customer-query.js';
import { PlatformWalletLedgerService } from '../saas/billing/service.js';
import { SaasCatalogService } from '../saas/catalog/index.js';
import { createSaasConsoleHandler, type SaasConsoleHttpHandler } from '../saas/console/http.js';
import { SaasConsoleUsageQueryService } from '../saas/console/index.js';
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
import { createPostgresPreparationCapacityPort } from '../saas/gateway/postgres-preparation-capacity.js';
import { createPostgresPreparationPorts } from '../saas/gateway/postgres-preparation-ports.js';
import { PostgresProviderAccountAffinity } from '../saas/gateway/postgres-provider-account-affinity.js';
import { PostgresRequestAdmissionGuard } from '../saas/gateway/postgres-request-admission-guard.js';
import { PostgresRequestPreparationEntitlementAdapter } from '../saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import { createSaasIdentityHandler, type SaasIdentityHttpOptions } from '../saas/identity/http.js';
import { SaasIdentityService } from '../saas/identity/index.js';
import { createSaasKeyHandler, type SaasKeyHttpHandler } from '../saas/keys/http.js';
import { PostgresSupplyProfileResolver } from '../saas/keys/resolver.js';
import { KeyService } from '../saas/keys/service.js';
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
import type { PaymentProviderAdapter, PaymentProviderRefundAdapter } from '../saas/payments/adapter.js';
import {
  type CustomerRefundQueryContext,
  CustomerRefundQueryError,
  SaasCustomerRefundQueryService,
} from '../saas/payments/customer-refund-query.js';
import {
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
import { PlatformAuditQueryService } from '../saas/platform/audit/index.js';
import {
  createPlatformAdminAuthHandler,
  PLATFORM_ADMIN_AUTH_PREFIX,
  type PlatformAdminAuthHttpHandler,
} from '../saas/platform/auth/http.js';
import { PlatformAdminAuthService } from '../saas/platform/auth/service.js';
import { PlatformCapacityPolicyService } from '../saas/platform/capacity-policy-service.js';
import { PlatformCatalogQueryService } from '../saas/platform/catalog/index.js';
import {
  createPlatformCredentialRewrapHttpHandler,
  type PlatformCredentialRewrapHttpHandler,
} from '../saas/platform/credential-rewrap-http.js';
import { createPlatformCredentialRewrapOperations } from '../saas/platform/credential-rewrap-operations.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminCapacityPolicyTargetSelectors,
  type PlatformAdminReadHttpHandler,
} from '../saas/platform/http/index.js';
import { PlatformOperationsSummaryService } from '../saas/platform/operations/index.js';
import { SaasPricingService } from '../saas/pricing/index.js';
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
  type ManagedRateLimiter,
  type ManagedSaasProviders,
  type ProviderModuleImporter,
} from '../saas/runtime/providers.js';
import {
  type LoadedValidationWorkerProviderCredentialKms,
  loadValidationWorkerProviderCredentialKms,
  SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../saas/runtime/validation-worker-provider-credential-kms.js';
import { loadCredentialValidationTargetsModule } from '../saas/runtime/credential-validation-targets-module.js';
import {
  type CredentialValidationWorkerHandle,
  type CredentialValidationWorkerOptions,
  startCredentialValidationWorker as startValidationWorkerLoop,
} from '../saas/supply/credential-validation-worker.js';
import { compileApprovedCredentialValidationTargets } from '../saas/supply/credential-validation-targets.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../saas/db/credential-validation-worker-schema-readiness.js';
import type { ApprovedCredentialValidationTarget } from '../saas/supply/types.js';
import type { CredentialValidationTransportTestOptions } from '../saas/supply/credential-validation-http-transport.js';
import { isProviderHttpTestAddressCapability } from '../saas/gateway/provider-http-address.js';
import { type CustomerByokHttpHandler, createCustomerByokHttpHandler } from '../saas/supply/customer-http.js';
import { ProviderSupplyService } from '../saas/supply/index.js';
import { CustomerWebhookDeliveryWorker, type CustomerWebhookWorkerOptions } from '../saas/webhooks/delivery-worker.js';
import type { CustomerWebhookEgressTransport } from '../saas/webhooks/egress-transport.js';
import { CustomerWebhookEndpointService } from '../saas/webhooks/endpoint-service.js';
import { type CustomerWebhookHttpHandler, createCustomerWebhookHandler } from '../saas/webhooks/http.js';
import { PostgresCustomerWebhookDeliveryStore } from '../saas/webhooks/postgres-store.js';
import type { WebhookSigningSecretProtector } from '../saas/webhooks/signing-secret-protector.js';
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
  /** Dedicated decrypt-only KMS import seam; only the isolated gateway workload consults it. */
  gatewayProviderCredentialKmsImporter?: ProviderModuleImporter;
  /** Deterministic seam for the isolated validation loop. */
  startCredentialValidationWorker?: (
    database: SaasDatabase,
    kms: LoadedValidationWorkerProviderCredentialKms,
    options: CredentialValidationWorkerOptions,
  ) => CredentialValidationWorkerHandle;
  /** Optional worker loop tuning or test fetch; deployment identity is always supplied by config. */
  credentialValidationWorkerOptions?: Partial<Omit<CredentialValidationWorkerOptions,
    'deployment' | 'environment' | 'approvedTargets' | 'transportTestOptions'>>;
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

function serveMountedStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mount: typeof CUSTOMER_MOUNT | typeof PLATFORM_MOUNT,
  webDistPath: string | undefined,
): void {
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
  paymentHandler: SaasPaymentHttpHandler | undefined,
  webDistPath: string | undefined,
): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
        return;
      }
      if (await refundHistoryHandler(req, res)) return;
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
        serveMountedStatic(req, res, pathname, CUSTOMER_MOUNT, webDistPath);
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
  unknownOutcomeHandler: UnknownOutcomePlatformHttpHandler | undefined,
  readHandler: PlatformAdminReadHttpHandler,
  webDistPath: string | undefined,
): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
        return;
      }
      if (isApiPath(pathname, PLATFORM_API_PREFIX)) {
        if (pathname === PLATFORM_ADMIN_AUTH_PREFIX || pathname.startsWith(`${PLATFORM_ADMIN_AUTH_PREFIX}/`)) {
          if (await authHandler(req, res)) return;
        }
        if (refundHandler && (await refundHandler(req, res))) return;
        if (rewrapHandler && (await rewrapHandler(req, res))) return;
        if (unknownOutcomeHandler && (await unknownOutcomeHandler(req, res))) return;
        if (await readHandler(req, res)) return;
        sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      if (isMountedPath(pathname, PLATFORM_MOUNT)) {
        serveMountedStatic(req, res, pathname, PLATFORM_MOUNT, webDistPath);
        return;
      }
      sendJsonError(res, 404, 'NOT_FOUND', 'Not found');
    })().catch(() => safeHandlerError(res));
  };
}

function createGatewayHandler(gatewayHandler?: SaasGatewayHttpHandler): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = requestPath(req);
      if (!pathname) {
        sendJsonError(res, 400, 'INVALID_PATH', 'The request path is invalid');
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

async function closeAllResources(
  listeners: Iterable<Server>,
  gateway: ManagedSaasGatewayComposition | undefined,
  gatewayKms: LoadedProviderCredentialUnsealingKms | undefined,
  gatewayRuntimeModule: LoadedManagedSaasGatewayRuntimeModule | undefined,
  providers: ManagedSaasProviders | undefined,
  unknownOutcomeScanner: UnknownOutcomeScannerHandle | undefined,
  paymentWorker: PaymentWebhookWorkerHandle | undefined,
  customerWebhookWorker: CustomerWebhookDeliveryWorkerHandle | undefined,
  refundWorker: PaymentRefundWorkerHandle | undefined,
  database: ManagedSaasDatabase | undefined,
  closeDatabase: (database: ManagedSaasDatabase) => Promise<void>,
): Promise<void> {
  const workerStops: Promise<void>[] = [];
  if (unknownOutcomeScanner) workerStops.push(unknownOutcomeScanner.stop());
  if (paymentWorker) workerStops.push(paymentWorker.stop());
  if (customerWebhookWorker) workerStops.push(customerWebhookWorker.stop());
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
): Promise<ManagedSaasRuntime> {
  if (options.gateway || options.payments || options.paymentHandler) {
    throw new TypeError('Credential-validation worker cannot receive gateway or payment capabilities');
  }
  const configuredTargetsModule = targetsModuleData(deployment, 'credentialValidationTargetsModule');
  const targetsModuleImporter = targetsModuleData(options, 'credentialValidationTargetsModuleImporter');
  if (
    (configuredTargetsModule !== undefined &&
      (typeof configuredTargetsModule !== 'string' || configuredTargetsModule.trim() === '' ||
        configuredTargetsModule.trim() !== configuredTargetsModule)) ||
    targetsModuleData(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE) !== configuredTargetsModule
  ) {
    throw new Error('Credential-validation worker targets module configuration is unavailable');
  }
  if (configuredTargetsModule !== undefined && options.credentialValidationTargets !== undefined) {
    throw new TypeError('Credential-validation worker SDK targets and targets module cannot both be configured');
  }
  let approvedTargets = compileApprovedCredentialValidationTargets(options.credentialValidationTargets ?? []);
  if (options.credentialValidationWorkerTestTransport &&
    (environment.NODE_ENV !== 'test' || !isProviderHttpTestAddressCapability(
      options.credentialValidationWorkerTestTransport.addressCapability))) {
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

  let database: ManagedSaasDatabase | undefined;
  let kms: LoadedValidationWorkerProviderCredentialKms | undefined;
  let worker: CredentialValidationWorkerHandle | undefined;
  let closePromise: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;
  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      removeSignals?.();
      removeSignals = undefined;
      if (worker) await Promise.allSettled([worker.close()]);
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
    });
    const runtime: ManagedSaasRuntime = {
      deployment,
      database,
      providers: null,
      gateway: null,
      credentialValidationWorker: worker,
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
 * SQLite, watcher, admin, or proxy state. Schema verification is deliberately
 * separate from migrations: server startup may prove readiness but never
 * changes the database schema.
 */
export async function startManagedSaasServer(
  deployment: ManagedSaasDeploymentConfig,
  options: ManagedSaasStartOptions = {},
): Promise<ManagedSaasRuntime> {
  if (deployment.mode !== 'managed-saas') throw new TypeError('managed SaaS deployment configuration is required');
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
  if (
    deployment.workloadRole !== 'credential-validation-worker' &&
    (targetsModuleData(deployment, 'credentialValidationTargetsModule') !== undefined ||
      targetsModuleData(environment, MODEL_ROUTER_SAAS_CREDENTIAL_VALIDATION_TARGETS_MODULE) !== undefined ||
      targetsModuleData(options, 'credentialValidationTargetsModuleImporter') !== undefined)
  ) {
    throw new TypeError('Credential-validation targets module is available only to the credential-validation worker');
  }
  if (deployment.workloadRole === 'credential-validation-worker') {
    return startCredentialValidationWorkerRuntime(deployment, options, environment);
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
  let unknownOutcomeScanner: UnknownOutcomeScannerHandle | undefined;
  let paymentWorker: PaymentWebhookWorkerHandle | undefined;
  let customerWebhookWorker: CustomerWebhookDeliveryWorkerHandle | undefined;
  let refundWorker: PaymentRefundWorkerHandle | undefined;
  const listeners = new Map<ListenerName, Server>();
  let closePromise: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;

  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      removeSignals?.();
      removeSignals = undefined;
      await closeAllResources(
        listeners.values(),
        gateway,
        gatewayKms,
        gatewayRuntimeModule,
        providers,
        unknownOutcomeScanner,
        paymentWorker,
        customerWebhookWorker,
        refundWorker,
        database,
        closeDatabase,
      );
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
      const preparationPorts = createPostgresPreparationPorts({
        database,
        metering,
        billing: new PlatformWalletLedgerService(),
        guard: new PostgresRequestAdmissionGuard(database),
        authorizationPrelock: new PostgresSaasRequestAdmissionAuthorizationPrelock(),
        entitlement: new PostgresRequestPreparationEntitlementAdapter(
          runtimeDependencies.entitlementResolver,
          new ByokServicePlanService(database),
        ),
        capacity: createPostgresPreparationCapacityPort(),
        payloadCompilerVersion: providerPayload.compilerVersion,
        usageEstimatorVersion: providerPayload.estimator.version,
      });
      gateway = createManagedSaasGatewayProductionComposition(database, {
        ...runtimeGatewayOptions,
        schedulerAffinity,
        caller: preparationPorts.caller,
        entitlement: preparationPorts.entitlement,
        admission: preparationPorts.admission,
        attempt: preparationPorts.attempt,
        compensation: preparationPorts.compensation,
        providerCredentialUnsealingKms: gatewayKms,
        credentialContext: {
          deployment: deployment.deploymentId,
          environment: deployment.environmentId,
        },
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

    const handlers: Partial<Record<ListenerName, RequestListener>> = {};
    if (controlPlaneEnabled) {
      if (!providers) throw new Error('Managed SaaS control-plane providers are unavailable');

      const customerDatabase = database;
      const identityService = new SaasIdentityService(database);
      const customerConsoleQueryService = new SaasConsoleUsageQueryService(database);
      const customerPlanService = new ByokServicePlanService(database);
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
      const customerIdentityOptions: SaasIdentityHttpOptions = {
        service: identityService,
        keyService: customerKeyService,
        publicOrigin: deploymentListener(deployment, 'customer').origin,
        sessionTtlSeconds: customerSessionTtlSeconds,
        rateLimiter: providers.customerAuthRateLimiter as ManagedRateLimiter,
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
        customerWebhookHandler = createCustomerWebhookHandler({
          service: identityService,
          database,
          endpointService,
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
        const paymentService = new PaymentFulfillmentService(database, options.payments.adapter, {
          providerKey: options.payments.providerKey,
          merchantId: options.payments.merchantId,
          checkout: options.payments.checkout,
          checkoutRedirectPolicies: options.payments.checkoutRedirectPolicies,
          submissionLeaseTtlMs: options.payments.submissionLeaseTtlMs,
          servicePlanService: customerPlanService,
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
      let platformRefundHandler: PlatformRefundHttpHandler | undefined;
      if (options.payments?.refundAdapter) {
        const refundService = new PaymentRefundService(database, options.payments.refundAdapter, {
          providerKey: options.payments.providerKey,
          merchantId: options.payments.merchantId,
          operations: createPlatformPaymentRefundOperations(),
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
      const platformOperationsService = new PlatformOperationsSummaryService(database);
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
      const startScanner = options.startUnknownOutcomeScanner ?? startUnknownOutcomeScanner;
      unknownOutcomeScanner = startScanner(recoveryWorkflow.worker, {
        ...(scannerOptions?.intervalMs === undefined ? {} : { intervalMs: scannerOptions.intervalMs }),
        onError: () => console.error('model-router managed unknown-outcome scanner cycle failed'),
        onOperatorRequired: (count) =>
          console.error(`model-router managed unknown-outcome scanner operator-required cases: ${count}`),
        onFailed: (count) => console.error(`model-router managed unknown-outcome scanner failed claims: ${count}`),
      });

      handlers.customer = createCustomerHandler(
        customerKeyHandler,
        customerIdentityHandler,
        customerPlanHandler,
        customerConsoleHandler,
        customerWebhookHandler,
        customerByokHandler,
        customerRefundHistoryHandler,
        paymentHandler,
        webDistPath,
      );
      handlers.platform = createPlatformHandler(
        platformAuthHandler,
        platformRefundHandler,
        platformCredentialRewrapHandler,
        unknownOutcomePlatformHandler,
        platformReadHandler,
        webDistPath,
      );
    }

    if (gatewayEnabled) handlers.gateway = createGatewayHandler(gateway?.handler);

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
