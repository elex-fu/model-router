import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import { type MarketingPromoCodeService, MarketingPromoError } from './promo-codes.js';

/**
 * R1/G2 promo-code operations HTTP entry points (design:
 * docs/remaining-capability-plan-2026-10-11.md §R1). The routes under
 * `/admin/api/v1/marketing/promo-codes` let the platform operations/finance
 * role band create, list and disable promo codes. The operator identity is
 * derived from the platform session only, mutating verbs require same-origin
 * plus CSRF, minor-unit amounts pass through as strings, and service
 * omission leaves the endpoints unavailable (503) without any mutation.
 */

const OPS_PREFIX = '/admin/api/v1/marketing/promo-codes';
const OPS_MAX_BODY_BYTES = 8 * 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_CODE_LENGTH = 64;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_CURSOR_LENGTH = 1024;
const MAX_LIST_LIMIT = 100;
const OPS_ROLE_BAND = ['operations', 'finance'] as const;

export type MarketingPromoHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface MarketingOpsPromoCodesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  /** Omission leaves the operations endpoints unavailable (503). */
  readonly promoCodes?: Pick<MarketingPromoCodeService, 'createPromoCode' | 'disablePromoCode' | 'listPromoCodes'>;
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
    this.name = 'MarketingPromoHttpError';
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

/**
 * Error rebuild. Domain codes map to stable public codes; internal messages
 * never cross the boundary and unexpected errors are rebuilt generically.
 */
function marketingPromoError(error: unknown): HttpError {
  if (error instanceof MarketingPromoError) {
    switch (error.code) {
      case 'PROMO_INVALID_INPUT':
        return new HttpError(400, 'PROMO_INVALID_INPUT', 'The promo code request is invalid');
      case 'PROMO_CODE_CONFLICT':
        return new HttpError(409, 'PROMO_CODE_CONFLICT', 'The promo code already exists');
      case 'PROMO_CODE_NOT_FOUND':
        return new HttpError(404, 'PROMO_CODE_NOT_FOUND', 'The promo code was not found');
      case 'PROMO_CODE_STATE_CONFLICT':
        return new HttpError(409, 'PROMO_CODE_STATE_CONFLICT', 'The promo code state conflicts with the request');
      case 'PROMO_FORBIDDEN':
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

function parseListQuery(url: URL): { status?: 'active' | 'disabled'; limit?: number; cursor?: string } {
  const values = queryValues(url, ['status', 'limit', 'cursor']);
  const status = values.get('status');
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
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
    ...(status === undefined ? {} : { status: status as 'active' | 'disabled' }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor: boundedQueryValue(cursor, MAX_CURSOR_LENGTH) }),
  };
}

type CreateBody =
  | {
      readonly kind: 'percent_off';
      readonly code: string;
      readonly percentBp: number;
      readonly startsAt?: string;
      readonly endsAt?: string;
      readonly maxUses?: number;
      readonly perTenantOnce?: boolean;
    }
  | {
      readonly kind: 'amount_off';
      readonly code: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
      readonly startsAt?: string;
      readonly endsAt?: string;
      readonly maxUses?: number;
      readonly perTenantOnce?: boolean;
    };

function optionalWindowFields(object: JsonObject): {
  startsAt?: string;
  endsAt?: string;
  maxUses?: number;
  perTenantOnce?: boolean;
} {
  const result: {
    startsAt?: string;
    endsAt?: string;
    maxUses?: number;
    perTenantOnce?: boolean;
  } = {};
  if (object.startsAt !== undefined) result.startsAt = stringField(object.startsAt, MAX_TIMESTAMP_LENGTH);
  if (object.endsAt !== undefined) result.endsAt = stringField(object.endsAt, MAX_TIMESTAMP_LENGTH);
  if (object.maxUses !== undefined) {
    if (typeof object.maxUses !== 'number' || !Number.isSafeInteger(object.maxUses) || object.maxUses < 1) {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
    }
    result.maxUses = object.maxUses;
  }
  if (object.perTenantOnce !== undefined) {
    if (typeof object.perTenantOnce !== 'boolean') {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
    }
    result.perTenantOnce = object.perTenantOnce;
  }
  return result;
}

function parseCreateBody(value: unknown): CreateBody {
  const candidate = asObject(value);
  const kind = candidate?.kind;
  if (kind !== 'percent_off' && kind !== 'amount_off') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  if (kind === 'percent_off') {
    const object = parseStrictObject(
      value,
      ['kind', 'code', 'percentBp', 'startsAt', 'endsAt', 'maxUses', 'perTenantOnce'],
      ['kind', 'code', 'percentBp'],
    );
    if (
      typeof object.percentBp !== 'number' ||
      !Number.isSafeInteger(object.percentBp) ||
      object.percentBp < 1 ||
      object.percentBp > 9999
    ) {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
    }
    return {
      kind: 'percent_off',
      code: stringField(object.code, MAX_CODE_LENGTH),
      percentBp: object.percentBp,
      ...optionalWindowFields(object),
    };
  }
  const object = parseStrictObject(
    value,
    ['kind', 'code', 'amountMinorUnits', 'currency', 'startsAt', 'endsAt', 'maxUses', 'perTenantOnce'],
    ['kind', 'code', 'amountMinorUnits', 'currency'],
  );
  return {
    kind: 'amount_off',
    code: stringField(object.code, MAX_CODE_LENGTH),
    // Fixed-point amounts pass through as strings; they are never parsed as numbers.
    amountMinorUnits: stringField(object.amountMinorUnits, 20),
    currency: stringField(object.currency, 3),
    ...optionalWindowFields(object),
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
  return new HttpError(503, 'MARKETING_PROMO_CODES_UNAVAILABLE', 'Marketing promo codes are not configured');
}

/**
 * Platform-operations promo-code routes under
 * `/admin/api/v1/marketing/promo-codes`: POST creates a code (kind-disjoint
 * strict body), GET lists with keyset pagination, POST `/:id/disable`
 * disables an active code. The operator identity comes from the platform
 * session only.
 */
export function createMarketingOpsPromoCodesHandler(
  options: MarketingOpsPromoCodesHttpOptions,
): MarketingPromoHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;

  return async (req, res) => {
    const requestId = `marketing_ops_promo_${randomUUID()}`;
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
        if (!options.promoCodes) throw opsUnavailable();
        const page = await options.promoCodes.listPromoCodes({ userId: actor.userId }, query);
        sendJson(res, 200, requestId, { items: page.codes, nextCursor: page.nextCursor });
        return true;
      }

      sameOrigin(req, expectedOrigin, expectedHost);
      await requirePlatformCsrf(req, options.authService);
      if (!options.promoCodes) {
        req.resume();
        throw opsUnavailable();
      }

      if (route.route === 'disable') {
        if (requestHasBody(req)) {
          req.resume();
          throw new HttpError(400, 'BODY_NOT_ALLOWED', 'A request body is not allowed for this endpoint');
        }
        const view = await options.promoCodes.disablePromoCode({ userId: actor.userId }, route.codeId);
        sendJson(res, 200, requestId, view);
        return true;
      }

      const input = parseCreateBody(await readJson(req, OPS_MAX_BODY_BYTES));
      const view = await options.promoCodes.createPromoCode({ userId: actor.userId }, input);
      sendJson(res, 201, requestId, view);
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : marketingPromoError(error));
      return true;
    }
  };
}
