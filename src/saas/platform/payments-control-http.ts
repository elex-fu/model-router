import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PaymentError } from '../payments/errors.js';
import { readPaymentControl, setPaymentControl, type PaymentBindingResolver } from '../payments/merchant-binding.js';
import type { PaymentDatabase } from '../payments/types.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import { PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_MAX_BODY_BYTES, PLATFORM_ADMIN_SESSION_COOKIE, type PlatformAdminAuthHttpService } from './auth/http.js';

export interface PaymentsControlHttpOptions {
  readonly database: PaymentDatabase;
  readonly resolver: PaymentBindingResolver;
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly publicOrigin: string;
}
export type PaymentsControlHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'PaymentsControlHttpError';
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let result: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (result !== undefined) return undefined;
    try {
      result = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return result || undefined;
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

function requireOperator(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (!hasPlatformRole(actor, ['operations'])) throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
}

function requireOrigin(req: IncomingMessage, publicOrigin: string): void {
  const expected = new URL(publicOrigin);
  if (req.headers.host !== expected.host) throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin !== expected.origin) throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
    return;
  }
  // Browser GET fetches normally omit Origin. Fetch Metadata is browser-owned;
  // an explicitly cross-site/same-site request cannot fall back to Referer.
  if ((req.method ?? 'GET').toUpperCase() === 'GET') {
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin') return;
    if (site === undefined && typeof req.headers.referer === 'string') {
      try {
        const referer = new URL(req.headers.referer);
        if (referer.origin === expected.origin && !referer.username && !referer.password) return;
      } catch { /* Reject malformed Referer. */ }
    }
  }
  throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
}

async function requireCsrf(req: IncomingMessage, authService: PaymentsControlHttpOptions['authService']): Promise<void> {
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const length = req.headers['content-length'];
  if (typeof length === 'string' && (!/^\d+$/.test(length) || Number(length) > PLATFORM_ADMIN_MAX_BODY_BYTES)) {
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
  if (size === 0) throw new HttpError(400, 'INVALID_BODY', 'A JSON request body is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is invalid');
  }
  return parsed as Record<string, unknown>;
}


/** Platform-only control surface. Mutation authority and audit are rechecked atomically by the service. */
export function createPaymentsControlHttpHandler(options: PaymentsControlHttpOptions): PaymentsControlHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') throw new TypeError('platform auth service is required');
  if (!options.database || typeof options.database.query !== 'function' || typeof options.database.transaction !== 'function') throw new TypeError('payment database is required');
  if (!options.resolver || typeof options.resolver.require !== 'function' || typeof options.resolver.list !== 'function') throw new TypeError('payment binding resolver is required');
  const origin = new URL(options.publicOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new TypeError('public origin is invalid');
  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname !== '/admin/api/v1/payments/control') return false;
      if (url.origin !== origin.origin || url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'PATCH') {
        req.resume(); res.setHeader('allow', 'GET, PATCH');
        sendError(res,405,requestId,'METHOD_NOT_ALLOWED','The method is not allowed'); return true;
      }
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      if (method === 'GET') {
        if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new HttpError(400,'INVALID_BODY','GET does not accept a request body');
        sendJson(res,200,requestId,await readPaymentControl(options.database)); return true;
      }
      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      if (Object.keys(body).length !== 3 || Object.keys(body).some(k => !['expectedRevision','mode','activeBindingId'].includes(k)) ||
          typeof body.expectedRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(body.expectedRevision) || BigInt(body.expectedRevision) > 9223372036854775807n ||
          !['disabled','draining','enabled'].includes(body.mode as string) ||
          (body.activeBindingId !== null && (typeof body.activeBindingId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(body.activeBindingId))) ||
          (body.mode === 'enabled' && body.activeBindingId === null)) throw new HttpError(400,'INVALID_BODY','Payment control input is invalid');
      const next = await setPaymentControl(options.database, options.resolver, {
        expectedRevision: body.expectedRevision,
        mode: body.mode as 'disabled' | 'draining' | 'enabled',
        activeBindingId: body.activeBindingId as string | null,
        actorId: actor.userId, sessionId: actor.sessionId, actorRoles: actor.roles, requestId,
      });
      sendJson(res,200,requestId,next); return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) sendError(res,error.status,requestId,error.code,error.safeMessage);
      else if (error instanceof PaymentError) {
        const status = error.code === 'PAYMENT_CONTROL_CONFLICT' ? 409 : error.code === 'PAYMENT_CONTROL_FORBIDDEN' ? 403 : error.code === 'INVALID_INPUT' ? 400 : 503;
        sendError(res,status,requestId,error.code,status === 409 ? 'Payment control changed; reload before retrying' : status === 403 ? 'The operation is not permitted' : status === 400 ? 'Payment control input is invalid' : 'Payment control is not available');
      } else sendError(res,503,requestId,'PAYMENTS_UNAVAILABLE','Payment control is not available');
      return true;
    }
  };
}
