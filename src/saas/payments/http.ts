import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { normalizeCurrency, parseMinorUnits } from '../billing/money.js';
import type { SaasIdentityService } from '../identity/service.js';
import type { TenantContext } from '../identity/types.js';
import {
  type CustomerRefundQuery,
  type CustomerRefundQueryContext,
  CustomerRefundQueryError,
  type SaasCustomerRefundQueryService,
} from './customer-refund-query.js';
import { isPaymentError } from './errors.js';
import type { PaymentFulfillmentService } from './service.js';
import type {
  CreateServicePlanPaymentInput,
  CreateWalletTopUpInput,
  PaymentOrderRecord,
  PaymentWalletTopUpPolicy,
  PaymentWebhookResult,
  ServicePlanPaymentOrderRecord,
} from './types.js';

const API_PREFIX = '/console/api/v1';
const WEBHOOK_PREFIX = '/payments/webhooks';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const BILLING_TENANT_ROLES = new Set(['owner', 'admin', 'billing']);

export type SaasPaymentHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface SaasPaymentHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken' | 'resolveTenantContext'>;
  readonly paymentService: Pick<
    PaymentFulfillmentService,
    'createWalletTopUp' | 'getWalletTopUp' | 'retryProviderOrder' | 'handleWebhook'
  > & {
    readonly providerKey: string;
    readonly createServicePlanPayment?: (
      context: TenantContext,
      input: CreateServicePlanPaymentInput,
    ) => Promise<ServicePlanPaymentOrderRecord>;
    readonly getServicePlanPayment?: (
      context: TenantContext,
      orderId: string,
    ) => Promise<ServicePlanPaymentOrderRecord | null>;
    readonly retryServicePlanPayment?: (
      context: TenantContext,
      input: { readonly tenantId: string; readonly projectId: string; readonly orderId: string },
    ) => Promise<ServicePlanPaymentOrderRecord>;
    readonly refreshWalletTopUpCheckout?: (input: {
      readonly tenantId: string;
      readonly orderId: string;
    }) => Promise<PaymentOrderRecord>;
    readonly refreshServicePlanPaymentCheckout?: (
      context: TenantContext,
      input: { readonly tenantId: string; readonly projectId: string; readonly orderId: string },
    ) => Promise<ServicePlanPaymentOrderRecord>;
  };
  readonly walletTopUpPolicy?: PaymentWalletTopUpPolicy;
  readonly publicOrigin: string;
  readonly cookieSecure?: boolean;
}

export interface SaasCustomerRefundHistoryHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession'> & {
    readonly resolveTenantBillingContext: (input: {
      readonly userId: string;
      readonly tenantId: string;
    }) => Promise<CustomerRefundQueryContext>;
  };
  /** Omission leaves refund history unavailable; no mutation or provider fallback is attempted. */
  readonly refundQueryService?: Pick<SaasCustomerRefundQueryService, 'listRefunds'>;
  readonly publicOrigin: string;
}

type PaymentRoute =
  | { readonly route: 'readWalletTopUpPolicy'; readonly tenantId: string }
  | { readonly route: 'createOrder'; readonly tenantId: string }
  | { readonly route: 'readOrder'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'retryOrder'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'refreshOrderCheckout'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'createServicePlanOrder'; readonly tenantId: string }
  | { readonly route: 'readServicePlanOrder'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'retryServicePlanOrder'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'refreshServicePlanOrderCheckout'; readonly tenantId: string; readonly orderId: string }
  | { readonly route: 'webhook'; readonly providerKey: string };

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaasPaymentHttpError';
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'INVALID_BODY', `${name} is required`);
  return value;
}

function parseStrictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
  const object = asObject(value);
  if (!object) throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  const allowedKeys = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unsupported field');
  }
  if (required.some((key) => !Object.hasOwn(object, key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is missing a required field');
  }
  return object;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      req.resume();
      throw new HttpError(400, 'INVALID_BODY', 'The request body is invalid');
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      req.resume();
      throw new HttpError(400, 'INVALID_BODY', 'The webhook body is invalid');
    }
    if (Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'The webhook body is too large');
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'The webhook body is too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, 'EMPTY_WEBHOOK', 'The webhook body is empty');
  return Buffer.concat(chunks);
}

function sendJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  extraHeaders?: OutgoingHttpHeaders,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify({ data, meta: { requestId } }));
}

function sendError(res: ServerResponse, requestId: string, error: HttpError, extraHeaders?: OutgoingHttpHeaders): void {
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify({ error: { code: error.code, message: error.message, requestId } }));
}

function requestMethodError(res: ServerResponse, requestId: string, methods: readonly string[]): void {
  sendError(res, requestId, new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'), {
    allow: methods.join(', '),
  });
}

function routePath(req: IncomingMessage, origin: string): string | undefined {
  try {
    const pathname = new URL(req.url ?? '/', origin).pathname;
    return pathname.length <= 4096 ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function pathIdentifier(encoded: string, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  if (
    value.trim() === '' ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  return value;
}

function findRoute(path: string): PaymentRoute | undefined {
  const topUpPolicy = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/wallet-topups/policy$`).exec(path);
  if (topUpPolicy) {
    return { route: 'readWalletTopUpPolicy', tenantId: pathIdentifier(topUpPolicy[1], 'tenant') };
  }
  const servicePlanCheckout = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/service-plan-orders/([^/]+)/checkout$`).exec(
    path,
  );
  if (servicePlanCheckout) {
    return {
      route: 'refreshServicePlanOrderCheckout',
      tenantId: pathIdentifier(servicePlanCheckout[1], 'tenant'),
      orderId: pathIdentifier(servicePlanCheckout[2], 'order'),
    };
  }
  const servicePlanRetry = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/service-plan-orders/([^/]+)/retry$`).exec(path);
  if (servicePlanRetry) {
    return {
      route: 'retryServicePlanOrder',
      tenantId: pathIdentifier(servicePlanRetry[1], 'tenant'),
      orderId: pathIdentifier(servicePlanRetry[2], 'order'),
    };
  }
  const servicePlan = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/service-plan-orders(?:/([^/]+))?$`).exec(path);
  if (servicePlan) {
    const tenantId = pathIdentifier(servicePlan[1], 'tenant');
    if (servicePlan[2] === undefined) return { route: 'createServicePlanOrder', tenantId };
    return { route: 'readServicePlanOrder', tenantId, orderId: pathIdentifier(servicePlan[2], 'order') };
  }
  const customer = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/orders(?:/([^/]+))?$`).exec(path);
  if (customer) {
    const tenantId = pathIdentifier(customer[1], 'tenant');
    if (customer[2] === undefined) return { route: 'createOrder', tenantId };
    return { route: 'readOrder', tenantId, orderId: pathIdentifier(customer[2], 'order') };
  }
  const retry = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/orders/([^/]+)/retry$`).exec(path);
  if (retry) {
    return {
      route: 'retryOrder',
      tenantId: pathIdentifier(retry[1], 'tenant'),
      orderId: pathIdentifier(retry[2], 'order'),
    };
  }
  const checkout = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/orders/([^/]+)/checkout$`).exec(path);
  if (checkout) {
    return {
      route: 'refreshOrderCheckout',
      tenantId: pathIdentifier(checkout[1], 'tenant'),
      orderId: pathIdentifier(checkout[2], 'order'),
    };
  }
  const webhook = new RegExp(`^${WEBHOOK_PREFIX}/([^/]+)$`).exec(path);
  if (webhook) return { route: 'webhook', providerKey: pathIdentifier(webhook[1], 'provider') };
  return undefined;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let found: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    try {
      found = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return found;
}

function sameOrigin(req: IncomingMessage, origin: string, host: string): void {
  const suppliedOrigin = req.headers.origin;
  if (typeof suppliedOrigin !== 'string')
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  try {
    if (new URL(suppliedOrigin).origin !== origin || suppliedOrigin !== origin) throw new Error('origin mismatch');
  } catch {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  if (req.headers.host !== host) throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
}

function idempotencyHeader(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
  }
  return value;
}

function userId(session: unknown): string {
  const value = asObject(session)?.userId;
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  return value;
}

function safeServiceError(value: unknown): HttpError {
  if (value instanceof CustomerRefundQueryError) {
    return new HttpError(value.status, value.code, value.message);
  }
  if (isPaymentError(value)) return new HttpError(value.status, value.code, value.message);
  const status = asObject(value)?.status;
  if (status === 401) return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (status === 403) return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  if (status === 404) return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
  if (status === 409) return new HttpError(409, 'CONFLICT', 'The request conflicts with existing data');
  if (status === 503)
    return new HttpError(503, 'SERVICE_UNAVAILABLE', 'The payment service is temporarily unavailable');
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

type CustomerWalletTopUpStatus = 'pending' | 'paid' | 'failed' | 'unknown' | 'expired';

function customerWalletTopUp(order: PaymentOrderRecord) {
  let status: CustomerWalletTopUpStatus;
  switch (order.status) {
    case 'fulfilled':
      status = order.fundingTransactionId !== null && order.fulfilledAt !== null ? 'paid' : 'unknown';
      break;
    case 'reconciliation_pending':
      status = 'unknown';
      break;
    case 'provider_failed':
      status = 'failed';
      break;
    case 'cancelled':
      status = 'expired';
      break;
    case 'paid':
    case 'fulfilling':
      status = 'pending';
      break;
    case 'created':
    case 'pending':
      status = order.checkout.status === 'expired' || order.checkout.status === 'closed' ? 'expired' : 'pending';
      break;
    default:
      status = 'unknown';
  }
  return {
    id: order.id,
    orderType: 'wallet_topup' as const,
    amountMinorUnits: order.amountMinorUnits,
    currency: order.currency,
    status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt,
    fulfilledAt: order.fulfilledAt,
    checkout: order.checkout,
  };
}

function normalizeWalletTopUpPolicy(
  policy: PaymentWalletTopUpPolicy | undefined,
): PaymentWalletTopUpPolicy | undefined {
  if (!policy || typeof policy !== 'object') return undefined;
  try {
    const currency = normalizeCurrency(policy.currency);
    const minimum = parseMinorUnits(policy.minAmountMinorUnits);
    const maximum = parseMinorUnits(policy.maxAmountMinorUnits);
    if (minimum > maximum) return undefined;
    return {
      currency,
      minAmountMinorUnits: minimum.toString(),
      maxAmountMinorUnits: maximum.toString(),
    };
  } catch {
    return undefined;
  }
}

function walletTopUpAmount(value: unknown, policy: PaymentWalletTopUpPolicy): string {
  let amount: bigint;
  try {
    amount = parseMinorUnits(value);
  } catch {
    throw new HttpError(400, 'INVALID_AMOUNT', 'The top-up amount must be a positive integer in minor units');
  }
  if (amount < BigInt(policy.minAmountMinorUnits) || amount > BigInt(policy.maxAmountMinorUnits)) {
    throw new HttpError(400, 'AMOUNT_OUT_OF_RANGE', 'The top-up amount is outside the configured limits');
  }
  return amount.toString();
}

function servicePlanOrderStatusCode(order: ServicePlanPaymentOrderRecord, created: boolean): number {
  if (order.providerFailureCode !== null) return 503;
  return created ? 201 : 200;
}

function unavailableCheckoutOrder<T extends PaymentOrderRecord | ServicePlanPaymentOrderRecord>(order: T): T {
  return { ...order, checkout: { status: 'unavailable', action: null } } as T;
}

function webhookStatus(result: PaymentWebhookResult): number {
  return result.outcome === 'fulfilled' || result.outcome === 'replayed' ? 200 : 202;
}

export function createSaasPaymentHandler(options: SaasPaymentHttpOptions): SaasPaymentHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;
  const walletTopUpPolicy = normalizeWalletTopUpPolicy(options.walletTopUpPolicy);
  const authenticate = async (req: IncomingMessage): Promise<{ token: string; session: unknown }> => {
    const token = cookieValue(req, SESSION_COOKIE_NAME);
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    const session = await options.service.getSession(token);
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return { token, session };
  };

  const requireCsrf = async (req: IncomingMessage, token: string): Promise<void> => {
    sameOrigin(req, expectedOrigin, expectedHost);
    const cookieToken = cookieValue(req, CSRF_COOKIE_NAME);
    const headerToken = req.headers['x-csrf-token'];
    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      headerToken !== cookieToken ||
      !(await options.service.verifyCsrfToken(token, cookieToken))
    ) {
      throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
    }
  };

  const authorizeTenant = async (session: unknown, tenantId: string): Promise<TenantContext> => {
    const sessionUserId = userId(session);
    const context = await options.service.resolveTenantContext({ userId: sessionUserId, tenantId });
    if (context.userId !== sessionUserId || context.tenantId !== tenantId) {
      throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    }
    if (!BILLING_TENANT_ROLES.has(context.tenantRole))
      throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    return context;
  };

  return async (req, res) => {
    const requestId = `saas_payment_${randomUUID()}`;
    try {
      const path = routePath(req, expectedOrigin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      const match = findRoute(path);
      if (!match) return false;

      const method = (req.method ?? 'GET').toUpperCase();
      const methods: Record<PaymentRoute['route'], readonly string[]> = {
        readWalletTopUpPolicy: ['GET'],
        createOrder: ['POST'],
        readOrder: ['GET'],
        retryOrder: ['POST'],
        refreshOrderCheckout: ['POST'],
        createServicePlanOrder: ['POST'],
        readServicePlanOrder: ['GET'],
        retryServicePlanOrder: ['POST'],
        refreshServicePlanOrderCheckout: ['POST'],
        webhook: ['POST'],
      };
      if (!methods[match.route].includes(method)) {
        req.resume();
        requestMethodError(res, requestId, methods[match.route]);
        return true;
      }

      if (match.route === 'webhook') {
        if (match.providerKey !== options.paymentService.providerKey) {
          req.resume();
          throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
        }
        const result = await options.paymentService.handleWebhook(req.headers, await readRawBody(req));
        sendJson(res, webhookStatus(result), requestId, result);
        return true;
      }

      const { token, session } = await authenticate(req);
      const context = await authorizeTenant(session, match.tenantId);

      if (match.route === 'readWalletTopUpPolicy') {
        if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
          throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
        }
        sendJson(
          res,
          200,
          requestId,
          walletTopUpPolicy
            ? { available: true, ...walletTopUpPolicy }
            : { available: false, currency: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        );
        return true;
      }

      if (
        match.route === 'createServicePlanOrder' ||
        match.route === 'readServicePlanOrder' ||
        match.route === 'retryServicePlanOrder' ||
        match.route === 'refreshServicePlanOrderCheckout'
      ) {
        if (!options.paymentService.createServicePlanPayment || !options.paymentService.getServicePlanPayment) {
          throw new HttpError(503, 'SERVICE_PLAN_UNAVAILABLE', 'BYOK service-plan payments are not configured');
        }
        if (match.route === 'readServicePlanOrder') {
          const order = await options.paymentService.getServicePlanPayment(context, match.orderId);
          if (!order) throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
          sendJson(res, 200, requestId, order);
          return true;
        }
        sameOrigin(req, expectedOrigin, expectedHost);
        await requireCsrf(req, token);
        if (match.route === 'refreshServicePlanOrderCheckout') {
          if (!options.paymentService.refreshServicePlanPaymentCheckout) {
            const order = await options.paymentService.getServicePlanPayment(context, match.orderId);
            if (!order) throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
            sendJson(res, 200, requestId, unavailableCheckoutOrder(order));
            return true;
          }
          const order = await options.paymentService.refreshServicePlanPaymentCheckout(context, {
            tenantId: match.tenantId,
            projectId: context.projectId,
            orderId: match.orderId,
          });
          sendJson(res, 200, requestId, order);
          return true;
        }
        if (match.route === 'retryServicePlanOrder') {
          if (!options.paymentService.retryServicePlanPayment) {
            throw new HttpError(503, 'SERVICE_PLAN_UNAVAILABLE', 'BYOK service-plan payments are not configured');
          }
          const order = await options.paymentService.retryServicePlanPayment(context, {
            tenantId: match.tenantId,
            projectId: context.projectId,
            orderId: match.orderId,
          });
          sendJson(res, servicePlanOrderStatusCode(order, false), requestId, order);
          return true;
        }
        const body = parseStrictObject(
          await readJson(req),
          ['planVersionId', 'operation', 'renewalOfSubscriptionId'],
          ['planVersionId'],
        );
        const input: CreateServicePlanPaymentInput = {
          planVersionId: nonEmptyString(body.planVersionId, 'planVersionId'),
          clientRequestId: idempotencyHeader(req),
          ...(body.operation === undefined
            ? {}
            : { operation: nonEmptyString(body.operation, 'operation') as 'activation' | 'renewal' }),
          ...(body.renewalOfSubscriptionId === undefined
            ? {}
            : { renewalOfSubscriptionId: nonEmptyString(body.renewalOfSubscriptionId, 'renewalOfSubscriptionId') }),
        };
        const order = await options.paymentService.createServicePlanPayment(context, input);
        sendJson(res, servicePlanOrderStatusCode(order, true), requestId, order);
        return true;
      }

      if (match.route === 'readOrder') {
        const order = await options.paymentService.getWalletTopUp({
          tenantId: context.tenantId,
          orderId: match.orderId,
        });
        if (!order) throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
        sendJson(res, 200, requestId, customerWalletTopUp(order));
        return true;
      }

      if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }
      sameOrigin(req, expectedOrigin, expectedHost);
      await requireCsrf(req, token);
      if (match.route === 'refreshOrderCheckout') {
        if (!walletTopUpPolicy) {
          const order = await options.paymentService.getWalletTopUp({
            tenantId: context.tenantId,
            orderId: match.orderId,
          });
          if (!order) throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
          sendJson(res, 200, requestId, customerWalletTopUp(unavailableCheckoutOrder(order)));
          return true;
        }
        if (!options.paymentService.refreshWalletTopUpCheckout) {
          const order = await options.paymentService.getWalletTopUp({
            tenantId: context.tenantId,
            orderId: match.orderId,
          });
          if (!order) throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
          sendJson(res, 200, requestId, customerWalletTopUp(unavailableCheckoutOrder(order)));
          return true;
        }
        const order = await options.paymentService.refreshWalletTopUpCheckout({
          tenantId: context.tenantId,
          orderId: match.orderId,
        });
        sendJson(res, 200, requestId, customerWalletTopUp(order));
        return true;
      }
      if (match.route === 'retryOrder') {
        if (!walletTopUpPolicy) {
          throw new HttpError(503, 'CUSTOMER_TOPUP_UNAVAILABLE', 'Customer wallet top-ups are not configured');
        }
        const order = await options.paymentService.retryProviderOrder({
          tenantId: context.tenantId,
          orderId: match.orderId,
        });
        sendJson(res, 200, requestId, customerWalletTopUp(order));
        return true;
      }

      if (!walletTopUpPolicy) {
        throw new HttpError(503, 'CUSTOMER_TOPUP_UNAVAILABLE', 'Customer wallet top-ups are not configured');
      }

      const body = parseStrictObject(
        await readJson(req),
        ['amountMinorUnits', 'currency'],
        ['amountMinorUnits', 'currency'],
      );
      const currency = nonEmptyString(body.currency, 'currency');
      if (currency !== walletTopUpPolicy.currency) {
        throw new HttpError(400, 'CURRENCY_NOT_ALLOWED', 'The requested wallet currency is not enabled');
      }
      const input: CreateWalletTopUpInput = {
        tenantId: context.tenantId,
        clientRequestId: idempotencyHeader(req),
        amountMinorUnits: walletTopUpAmount(body.amountMinorUnits, walletTopUpPolicy),
        currency: walletTopUpPolicy.currency,
      };
      const order = await options.paymentService.createWalletTopUp(input);
      sendJson(res, 201, requestId, customerWalletTopUp(order));
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : safeServiceError(error));
      return true;
    }
  };
}

function refundHistoryQuery(req: IncomingMessage, origin: string): CustomerRefundQuery {
  const target = req.url ?? '/';
  if (target.length > 8192) throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');

  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'limit' && key !== 'cursor') {
      throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
    }
  }

  const limits = url.searchParams.getAll('limit');
  const cursors = url.searchParams.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) {
    throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
  }

  let limit: number | undefined;
  if (limits.length === 1) {
    if (!/^[1-9][0-9]{0,2}$/.test(limits[0])) {
      throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
    }
    limit = Number(limits[0]);
    if (limit > 100) throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
  }
  if (cursors.length === 1 && cursors[0].length === 0) {
    throw new HttpError(400, 'INVALID_QUERY', 'The refund history query is invalid');
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursors.length === 0 ? {} : { cursor: cursors[0] }),
  };
}

function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const contentLength = req.headers['content-length'];
  return contentLength !== undefined && !/^0+$/.test(contentLength);
}

/** Read-only customer refund history. It is independent of PSP adapters and refund mutation services. */
export function createSaasCustomerRefundHistoryHandler(
  options: SaasCustomerRefundHistoryHttpOptions,
): SaasPaymentHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  return async (req, res) => {
    const requestId = `saas_refunds_${randomUUID()}`;
    try {
      const path = routePath(req, publicUrl.origin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      const match = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/refunds$`).exec(path);
      if (!match) return false;

      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        req.resume();
        requestMethodError(res, requestId, ['GET']);
        return true;
      }
      if (requestHasBody(req)) {
        req.resume();
        throw new HttpError(400, 'BODY_NOT_ALLOWED', 'A request body is not allowed for this endpoint');
      }

      const tenantId = pathIdentifier(match[1], 'tenant');
      const token = cookieValue(req, SESSION_COOKIE_NAME);
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const sessionUserId = userId(session);
      const context = await options.service.resolveTenantBillingContext({ userId: sessionUserId, tenantId });
      if (
        !context ||
        typeof context !== 'object' ||
        Array.isArray(context) ||
        context.userId !== sessionUserId ||
        context.tenantId !== tenantId
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }
      if (!BILLING_TENANT_ROLES.has(context.tenantRole)) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }

      const query = refundHistoryQuery(req, publicUrl.origin);
      if (!options.refundQueryService) {
        throw new HttpError(503, 'REFUND_HISTORY_UNAVAILABLE', 'Customer refund history is not configured');
      }
      const page = await options.refundQueryService.listRefunds(context, query);
      sendJson(res, 200, requestId, { items: page.items, nextCursor: page.nextCursor });
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : safeServiceError(error));
      return true;
    }
  };
}

export const createSaasPaymentsHandler = createSaasPaymentHandler;
