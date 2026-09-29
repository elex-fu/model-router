import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import { isPaymentError } from './errors.js';
import type { PaymentRefundRecord } from './types.js';

const REFUND_PATH = '/admin/api/v1/payments/refunds';
const MAX_ID_LENGTH = 255;
const MAX_REASON_LENGTH = 96;

export interface PlatformRefundService {
  requestPlatformWalletTopUpRefund(input: {
    readonly actorId: string;
    readonly sessionId: string;
    readonly actorRoles: readonly string[];
    readonly tenantId: string;
    readonly orderId: string;
    readonly clientRequestId: string;
    readonly reasonCode: string;
  }): Promise<PaymentRefundRecord>;
  getRefund(tenantId: string, refundId: string): Promise<PaymentRefundRecord | null>;
}

export interface PlatformRefundHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly service: PlatformRefundService;
  readonly publicOrigin: string;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
}

export type PlatformRefundHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type RefundRoute =
  | { readonly kind: 'collection' }
  | { readonly kind: 'record'; readonly tenantId: string; readonly refundId: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
  }
}

function routeFor(pathname: string): RefundRoute | undefined {
  if (pathname === REFUND_PATH) return { kind: 'collection' };
  if (!pathname.startsWith(`${REFUND_PATH}/`)) return undefined;
  const parts = pathname.slice(REFUND_PATH.length + 1).split('/');
  if (parts.length !== 2) return undefined;
  const [tenantId, refundId] = parts;
  if (!tenantId || !refundId) throw new HttpError(400, 'INVALID_PATH', 'The refund path is invalid');
  return { kind: 'record', tenantId: pathIdentifier(tenantId), refundId: pathIdentifier(refundId) };
}

function pathIdentifier(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The refund path is invalid');
  }
  if (
    decoded.length > MAX_ID_LENGTH ||
    decoded.trim() === '' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    [...decoded].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The refund path is invalid');
  }
  return decoded;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let found: string | undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    try {
      found = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return found || undefined;
}

function equalSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function sendJson(res: ServerResponse, status: number, requestId: string, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ data, meta: { requestId } }));
}

function sendError(res: ServerResponse, status: number, requestId: string, code: string, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code, message, requestId } }));
}

function requireFinance(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (!hasPlatformRole(actor, ['finance'])) throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
}

function requireOrigin(req: IncomingMessage, publicOrigin: string): void {
  let expected: URL;
  try {
    expected = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, 'REFUND_UNAVAILABLE', 'Platform refunds are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: PlatformRefundHttpOptions['authService']): Promise<void> {
  const session = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrf = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !session || !equalSecret(csrf, header)) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
  let valid = false;
  try {
    valid = await authService.verifyCsrfToken(session, csrf as string);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const contentLength = req.headers['content-length'];
  if (
    typeof contentLength === 'string' &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > PLATFORM_ADMIN_MAX_BODY_BYTES)
  ) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > PLATFORM_ADMIN_MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function bodyString(body: Record<string, unknown>, name: string, maxLength = MAX_ID_LENGTH): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return value.trim();
}

function idempotencyKey(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function safeRecord(record: PaymentRefundRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    refundType: record.refundType,
    originalOrderId: record.originalOrderId,
    amountMinorUnits: record.amountMinorUnits,
    currency: record.currency,
    status: record.status,
    providerRefundId: record.providerRefundId,
    failureCode: record.failureCode,
    blockedCode: record.blockedCode,
    walletRefundTransactionId: record.walletRefundTransactionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

export function createPlatformRefundHttpHandler(options: PlatformRefundHttpOptions): PlatformRefundHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options.service || typeof options.service.requestPlatformWalletTopUpRefund !== 'function') {
    throw new TypeError('refund service is required');
  }
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  return async (req, res) => {
    let route: RefundRoute | undefined;
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      route = routeFor(url.pathname);
      if (!route) return false;
      if (url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = req.method ?? 'GET';
      if ((route.kind === 'collection' && method !== 'POST') || (route.kind === 'record' && method !== 'GET')) {
        req.resume();
        res.writeHead(405, {
          allow: route.kind === 'collection' ? 'POST' : 'GET',
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }),
        );
        return true;
      }
      const actor = await options.access.authenticate(req);
      requireFinance(actor);
      if (route.kind === 'record') {
        const record = await options.service.getRefund(route.tenantId, route.refundId);
        if (!record) throw new HttpError(404, 'REFUND_NOT_FOUND', 'The refund was not found.');
        sendJson(res, 200, requestId, safeRecord(record));
        return true;
      }
      requireOrigin(req, options.publicOrigin);
      await requireCsrf(req, options.authService);
      const body = asObject(await readJson(req));
      const allowed = new Set(['tenantId', 'orderId', 'reasonCode']);
      if (!body || Object.keys(body).some((key) => !allowed.has(key))) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unsupported field');
      }
      const reasonCode = bodyString(body, 'reasonCode', MAX_REASON_LENGTH);
      const record = await options.service.requestPlatformWalletTopUpRefund({
        actorId: actor.userId,
        sessionId: actor.sessionId,
        actorRoles: actor.roles,
        tenantId: bodyString(body, 'tenantId'),
        orderId: bodyString(body, 'orderId'),
        clientRequestId: idempotencyKey(req),
        reasonCode,
      });
      sendJson(res, 200, requestId, safeRecord(record));
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
      } else if (isPaymentError(error)) {
        sendError(res, error.status, requestId, error.code, error.message);
      } else {
        sendError(res, 500, requestId, 'INTERNAL_ERROR', 'The request could not be completed');
      }
      return true;
    }
  };
}
