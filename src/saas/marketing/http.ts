import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { SaasIdentityService } from '../identity/service.js';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import { type MarketingRedeemCodeService, MarketingRedeemError } from './redeem-codes.js';

/**
 * Track G1 redeem-code HTTP entry points (design:
 * docs/marketing-domain-design-2026-10-11.md §4/§8). The customer route lets
 * any active tenant member redeem a balance code; the operations routes let
 * the platform operations/finance role band generate, list and disable codes.
 * Plaintext codes exist only in the generation response; code existence is
 * never disclosed through distinct customer-side errors; minor-unit amounts
 * pass through as strings; the actor identity is derived from the
 * authenticated session, never from the request body.
 */

const CUSTOMER_API_PREFIX = '/console/api/v1';
const OPS_PREFIX = '/admin/api/v1/marketing/redeem-codes';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const CUSTOMER_MAX_BODY_BYTES = 1024;
const OPS_MAX_BODY_BYTES = 8 * 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_CODE_LENGTH = 256;
const MAX_BATCH_REF_LENGTH = 128;
const MAX_CURSOR_LENGTH = 1024;
const MAX_GENERATE_COUNT = 100;
const MAX_LIST_LIMIT = 100;
const MAX_LIMITER_KEYS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const REDEEM_USER_LIMIT = 10;
const REDEEM_SOURCE_LIMIT = 30;
const REDEEM_RATE_LIMIT_NAMESPACE = 'marketing-redeem:source:v1';
const OPS_ROLE_BAND = ['operations', 'finance'] as const;

export type MarketingRedeemHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface MarketingCustomerRedeemHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken' | 'resolveTenantContext'>;
  /** Omission leaves redemption unavailable (503); no mutation is attempted. */
  readonly redeemService?: Pick<MarketingRedeemCodeService, 'redeem'>;
  readonly publicOrigin: string;
}

export interface MarketingOpsRedeemCodesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  /** Omission leaves the operations endpoints unavailable (503). */
  readonly redeemCodes?: Pick<
    MarketingRedeemCodeService,
    'generateBalanceCodes' | 'generateSubscriptionCodes' | 'disableCode' | 'listCodes'
  >;
  readonly publicOrigin: string;
}

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MarketingRedeemHttpError';
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
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

/** A bounded string field. The value passes through verbatim; format rules stay in the domain service. */
function stringField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasControlCharacter(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return value;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
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
    if (Number(contentLength) > maxBytes) {
      req.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      req.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const contentLength = req.headers['content-length'];
  return contentLength !== undefined && !/^0+$/.test(contentLength);
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

function requestMethodError(res: ServerResponse, requestId: string, allow: string): void {
  sendError(res, requestId, new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'), {
    allow,
  });
}

function requestUrl(req: IncomingMessage, origin: string): URL | undefined {
  try {
    const url = new URL(req.url ?? '/', origin);
    return url.pathname.length <= 4096 ? url : undefined;
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

function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function userId(session: unknown): string {
  const value = asObject(session)?.userId;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  return value;
}

/**
 * Error rebuild. Unknown, disabled and foreign-redeemed codes share one
 * refusal (REDEEM_CODE_INVALID → 400 "The redeem code is invalid") so the
 * existence of a code is never disclosed. Internal messages never cross the
 * boundary; storage failures and unexpected errors are rebuilt generically.
 */
function marketingRedeemError(error: unknown): HttpError {
  if (error instanceof MarketingRedeemError) {
    switch (error.code) {
      case 'REDEEM_INVALID_INPUT':
        return new HttpError(400, 'REDEEM_INVALID_INPUT', 'The redeem request is invalid');
      case 'REDEEM_CODE_INVALID':
        return new HttpError(400, 'REDEEM_CODE_INVALID', 'The redeem code is invalid');
      case 'REDEEM_KIND_UNSUPPORTED':
        return new HttpError(400, 'REDEEM_KIND_UNSUPPORTED', 'This redeem code kind is not supported');
      case 'REDEEM_CODE_STATE_CONFLICT':
        return new HttpError(409, 'REDEEM_CODE_STATE_CONFLICT', 'The redeem code state conflicts with the request');
      case 'REDEEM_FORBIDDEN':
        return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      default:
        return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
    }
  }
  const status = asObject(error)?.status;
  if (status === 401) return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (status === 403) return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  if (status === 404) return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

/** Process-local fixed-window counter (rate tier `marketing-redeem:source:v1`). */
class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private nextCleanupAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Return a positive retry-after duration in seconds when the key is limited. */
  take(key: string, now = Date.now()): number | undefined {
    if (now >= this.nextCleanupAt) {
      for (const [candidate, window] of this.windows) {
        if (now - window.startedAt >= this.windowMs) this.windows.delete(candidate);
      }
      this.nextCleanupAt = now + this.windowMs;
    }

    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (!window && this.windows.size >= MAX_LIMITER_KEYS) {
        const oldest = this.windows.keys().next().value as string | undefined;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }

    window.count += 1;
    if (window.count <= this.limit) return undefined;
    return Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
  }
}

function rateLimited(res: ServerResponse, requestId: string, retryAfterSeconds: number): void {
  sendError(res, requestId, new HttpError(429, 'RATE_LIMITED', 'Too many redeem attempts'), {
    'retry-after': String(retryAfterSeconds),
  });
}

/**
 * Customer-side redemption (`POST /console/api/v1/tenants/:tenantId/redeem`).
 * Every active tenant role may redeem; membership itself is enforced by
 * resolveTenantContext. Brute-force protection is a process-local fixed
 * window on two dimensions: 10 attempts/min per user and 30/min per source.
 */
export function createMarketingCustomerRedeemHandler(
  options: MarketingCustomerRedeemHttpOptions,
): MarketingRedeemHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;
  const route = new RegExp(`^${CUSTOMER_API_PREFIX}/tenants/([^/]+)/redeem$`);
  const sourceLimiter = new FixedWindowLimiter(REDEEM_SOURCE_LIMIT, RATE_LIMIT_WINDOW_MS);
  const userLimiter = new FixedWindowLimiter(REDEEM_USER_LIMIT, RATE_LIMIT_WINDOW_MS);

  return async (req, res) => {
    const requestId = `marketing_redeem_${randomUUID()}`;
    try {
      const url = requestUrl(req, expectedOrigin);
      if (url === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      const match = route.exec(url.pathname);
      if (!match) return false;

      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        req.resume();
        requestMethodError(res, requestId, 'POST');
        return true;
      }

      const sourceRetry = sourceLimiter.take(
        `${REDEEM_RATE_LIMIT_NAMESPACE}:ip:${req.socket.remoteAddress ?? 'unknown'}`,
      );
      if (sourceRetry !== undefined) {
        req.resume();
        rateLimited(res, requestId, sourceRetry);
        return true;
      }

      const tenantId = pathIdentifier(match[1], 'tenant');
      const token = cookieValue(req, SESSION_COOKIE_NAME);
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const sessionUserId = userId(session);

      const userRetry = userLimiter.take(`${REDEEM_RATE_LIMIT_NAMESPACE}:user:${sessionUserId}`);
      if (userRetry !== undefined) {
        req.resume();
        rateLimited(res, requestId, userRetry);
        return true;
      }

      const context = await options.service.resolveTenantContext({ userId: sessionUserId, tenantId });
      if (context.userId !== sessionUserId || context.tenantId !== tenantId) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }

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

      if (!options.redeemService) {
        req.resume();
        throw new HttpError(503, 'REDEEM_UNAVAILABLE', 'Marketing redeem is not configured');
      }

      const body = parseStrictObject(await readJson(req, CUSTOMER_MAX_BODY_BYTES), ['code'], ['code']);
      if (typeof body.code !== 'string' || body.code.length === 0 || body.code.length > MAX_CODE_LENGTH) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
      }
      const result = await options.redeemService.redeem(
        { tenantId: context.tenantId, userId: context.userId },
        { code: body.code },
      );
      sendJson(
        res,
        200,
        requestId,
        result.kind === 'balance'
          ? {
              outcome: result.outcome,
              kind: result.kind,
              codeId: result.codeId,
              amountMinorUnits: result.amountMinorUnits,
              currency: result.currency,
              ledgerTransactionId: result.ledgerTransactionId,
            }
          : {
              outcome: result.outcome,
              kind: result.kind,
              codeId: result.codeId,
              servicePlanVersionId: result.servicePlanVersionId,
              subscriptionId: result.subscriptionId,
              entitlementId: result.entitlementId,
              expiresAt: result.expiresAt,
            },
      );
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : marketingRedeemError(error));
      return true;
    }
  };
}

type OpsRoute = { readonly route: 'collection' } | { readonly route: 'disable'; readonly codeId: string };

function findOpsRoute(path: string): OpsRoute | undefined {
  if (path === OPS_PREFIX) return { route: 'collection' };
  const disable = new RegExp(`^${OPS_PREFIX}/([^/]+)/disable$`).exec(path);
  if (disable) return { route: 'disable', codeId: pathIdentifier(disable[1], 'code') };
  return undefined;
}

function queryValues(url: URL, allowedKeys: readonly string[]): Map<string, string> {
  const allowed = new Set(allowedKeys);
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || values.has(key)) {
      throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
    }
    values.set(key, value);
  }
  return values;
}

function boundedQueryValue(value: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength || hasControlCharacter(value)) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return value;
}

function parseListQuery(url: URL): {
  batchRef?: string;
  status?: 'active' | 'redeemed' | 'disabled';
  limit?: number;
  cursor?: string;
} {
  const values = queryValues(url, ['batchRef', 'status', 'limit', 'cursor']);
  const batchRef = values.get('batchRef');
  const status = values.get('status');
  if (status !== undefined && status !== 'active' && status !== 'redeemed' && status !== 'disabled') {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  const rawLimit = values.get('limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
    }
  }
  const cursor = values.get('cursor');
  return {
    ...(batchRef === undefined ? {} : { batchRef: boundedQueryValue(batchRef, MAX_BATCH_REF_LENGTH) }),
    ...(status === undefined ? {} : { status: status as 'active' | 'redeemed' | 'disabled' }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor: boundedQueryValue(cursor, MAX_CURSOR_LENGTH) }),
  };
}

function parseGenerateBody(
  value: unknown,
):
  | { kind: 'balance'; count: number; amountMinorUnits: string; currency: string; batchRef?: string }
  | { kind: 'subscription'; count: number; servicePlanVersionId: string; batchRef?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body must be an object');
  }
  const rawKind = (value as Record<string, unknown>).kind;
  const kind = rawKind === undefined ? 'balance' : rawKind;
  if (kind !== 'balance' && kind !== 'subscription') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  if (kind === 'subscription') {
    const object = parseStrictObject(
      value,
      ['kind', 'count', 'servicePlanVersionId', 'batchRef'],
      ['kind', 'count', 'servicePlanVersionId'],
    );
    if (
      typeof object.count !== 'number' ||
      !Number.isSafeInteger(object.count) ||
      object.count < 1 ||
      object.count > MAX_GENERATE_COUNT
    ) {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
    }
    return {
      kind: 'subscription',
      count: object.count,
      servicePlanVersionId: stringField(object.servicePlanVersionId, 64),
      ...(object.batchRef === undefined ? {} : { batchRef: stringField(object.batchRef, MAX_BATCH_REF_LENGTH) }),
    };
  }
  const object = parseStrictObject(
    value,
    ['kind', 'count', 'amountMinorUnits', 'currency', 'batchRef'],
    ['count', 'amountMinorUnits', 'currency'],
  );
  const count = object.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return {
    kind: 'balance',
    count,
    // Fixed-point amounts pass through as strings; they are never parsed as numbers.
    amountMinorUnits: stringField(object.amountMinorUnits, 20),
    currency: stringField(object.currency, 3),
    ...(object.batchRef === undefined ? {} : { batchRef: stringField(object.batchRef, MAX_BATCH_REF_LENGTH) }),
  };
}

function requireOperator(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (
    actor === undefined ||
    typeof actor.userId !== 'string' ||
    actor.userId.trim() === '' ||
    typeof actor.sessionId !== 'string' ||
    actor.sessionId.trim() === ''
  ) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  if (!hasPlatformRole(actor, OPS_ROLE_BAND)) {
    throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  }
}

async function requirePlatformCsrf(
  req: IncomingMessage,
  authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>,
): Promise<void> {
  const sessionToken = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrfCookie = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const csrfHeader = req.headers['x-csrf-token'];
  if (
    sessionToken === undefined ||
    csrfCookie === undefined ||
    typeof csrfHeader !== 'string' ||
    !sameSecret(csrfCookie, csrfHeader)
  ) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }

  let valid = false;
  try {
    valid = await authService.verifyCsrfToken(sessionToken, csrfCookie);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

function opsUnavailable(): HttpError {
  return new HttpError(503, 'MARKETING_REDEEM_CODES_UNAVAILABLE', 'Marketing redeem codes are not configured');
}

/**
 * Platform-operations redeem-code routes under
 * `/admin/api/v1/marketing/redeem-codes`: POST generates a batch (plaintext
 * codes are returned exactly once), GET lists with keyset pagination (the
 * code hash never leaves the store), POST `/:id/disable` disables an active
 * code. The operator identity comes from the platform session only.
 */
export function createMarketingOpsRedeemCodesHandler(
  options: MarketingOpsRedeemCodesHttpOptions,
): MarketingRedeemHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;

  return async (req, res) => {
    const requestId = `marketing_ops_redeem_${randomUUID()}`;
    try {
      const url = requestUrl(req, expectedOrigin);
      if (url === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      const route = findOpsRoute(url.pathname);
      if (!route) return false;

      const method = (req.method ?? 'GET').toUpperCase();
      if (route.route === 'collection') {
        if (method !== 'GET' && method !== 'POST') {
          req.resume();
          requestMethodError(res, requestId, 'GET, POST');
          return true;
        }
      } else if (method !== 'POST') {
        req.resume();
        requestMethodError(res, requestId, 'POST');
        return true;
      }

      const actor = await options.access.authenticate(req);
      requireOperator(actor);

      if (route.route === 'collection' && method === 'GET') {
        const query = parseListQuery(url);
        if (!options.redeemCodes) throw opsUnavailable();
        const page = await options.redeemCodes.listCodes({ userId: actor.userId }, query);
        sendJson(res, 200, requestId, { items: page.codes, nextCursor: page.nextCursor });
        return true;
      }

      sameOrigin(req, expectedOrigin, expectedHost);
      await requirePlatformCsrf(req, options.authService);
      if (!options.redeemCodes) {
        req.resume();
        throw opsUnavailable();
      }

      if (route.route === 'disable') {
        if (requestHasBody(req)) {
          req.resume();
          throw new HttpError(400, 'BODY_NOT_ALLOWED', 'A request body is not allowed for this endpoint');
        }
        const view = await options.redeemCodes.disableCode({ userId: actor.userId }, route.codeId);
        sendJson(res, 200, requestId, view);
        return true;
      }

      const input = parseGenerateBody(await readJson(req, OPS_MAX_BODY_BYTES));
      const generated =
        input.kind === 'subscription'
          ? await options.redeemCodes.generateSubscriptionCodes(
              { userId: actor.userId },
              {
                count: input.count,
                servicePlanVersionId: input.servicePlanVersionId,
                ...(input.batchRef === undefined ? {} : { batchRef: input.batchRef }),
              },
            )
          : await options.redeemCodes.generateBalanceCodes(
              { userId: actor.userId },
              {
                count: input.count,
                amountMinorUnits: input.amountMinorUnits,
                currency: input.currency,
                ...(input.batchRef === undefined ? {} : { batchRef: input.batchRef }),
              },
            );
      sendJson(res, 201, requestId, generated);
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : marketingRedeemError(error));
      return true;
    }
  };
}
