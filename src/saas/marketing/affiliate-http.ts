import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SaasIdentityService } from '../identity/service.js';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import type { AffiliatePolicyView, AffiliateRewardView, BindInviterResult, MyAffiliateView } from './affiliate.js';
import { MarketingAffiliateError } from './affiliate.js';

/**
 * Track R2/G3 affiliate HTTP entries (design:
 * docs/marketing-domain-design-2026-10-11.md §8). The customer surface lives
 * under the console origin: any active tenant member may read their own
 * affiliate view (invite code, attribution count, reward page) and bind an
 * inviter by invite code (CSRF-protected, strict body, two-dimension fixed
 * window rate limit). The operations surface lives under the platform-admin
 * origin with the operations/finance role band: policy read/replace (CAS,
 * strict body, same-origin + CSRF on the mutation) and reward listing.
 * Handlers are standalone and composable; managed-saas.ts wiring is a
 * separate integration step. The actor identity always comes from the
 * authenticated session, never from the request body.
 */

const CONSOLE_PREFIX = '/console/api/v1/tenants';
const OPS_POLICY_PATH = '/admin/api/v1/marketing/affiliate-policy';
const OPS_REWARDS_PATH = '/admin/api/v1/marketing/affiliate-rewards';
const CUSTOMER_SESSION_COOKIE = 'mr_saas_session';
const CUSTOMER_CSRF_COOKIE = 'mr_saas_csrf';
const MAX_BODY_BYTES = 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_INVITE_CODE_LENGTH = 64;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPS_ROLE_BAND = ['operations', 'finance'] as const;
const MAX_LIMITER_KEYS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BIND_USER_LIMIT = 10;
const BIND_SOURCE_LIMIT = 30;
const BIND_RATE_LIMIT_NAMESPACE = 'marketing-affiliate-bind:source:v1';

export const MARKETING_AFFILIATE_PATHS = Object.freeze({
  opsPolicy: OPS_POLICY_PATH,
  opsRewards: OPS_REWARDS_PATH,
  customerAffiliate: (tenantId: string) => `${CONSOLE_PREFIX}/${tenantId}/affiliate`,
  customerBind: (tenantId: string) => `${CONSOLE_PREFIX}/${tenantId}/affiliate/bind`,
} as const);

type JsonObject = Record<string, unknown>;

export type MarketingAffiliateHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface MarketingAffiliateCustomerOperations {
  getMyAffiliate(
    context: { tenantId: string; userId: string },
    input: { limit?: unknown; cursor?: unknown },
  ): Promise<MyAffiliateView>;
  bindInviter(
    context: { tenantId: string; userId: string },
    input: { inviteCode: unknown },
  ): Promise<BindInviterResult>;
}

export interface MarketingAffiliateOpsOperations {
  getAffiliatePolicy(actor: { userId: string }): Promise<AffiliatePolicyView>;
  replaceAffiliatePolicy(
    actor: { userId: string },
    input: { rewardBp: unknown; enabled: unknown; expectedVersion: unknown },
  ): Promise<AffiliatePolicyView>;
  listRewards(
    actor: { userId: string },
    input: { inviterTenantId?: unknown; limit?: unknown; cursor?: unknown },
  ): Promise<{ rewards: AffiliateRewardView[]; nextCursor: string | null }>;
}

export interface MarketingAffiliateCustomerHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken' | 'resolveTenantContext'>;
  /** Omission leaves the customer endpoints unavailable (503); no mutation is attempted. */
  readonly operations?: MarketingAffiliateCustomerOperations;
  readonly publicOrigin: string;
}

export interface MarketingAffiliateOpsHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  /** Omission leaves the operations endpoints unavailable (503). */
  readonly operations?: MarketingAffiliateOpsOperations;
  readonly publicOrigin: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'MarketingAffiliateHttpError';
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

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
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

function requestUrl(req: IncomingMessage, publicOrigin: string): URL | undefined {
  try {
    return new URL(req.url ?? '/', publicOrigin);
  } catch {
    return undefined;
  }
}

function uuidIdentifier(encoded: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The path identifier is invalid');
  }
  if (!UUID.test(value)) throw new HttpError(400, 'INVALID_PATH', 'The path identifier is invalid');
  return value;
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

function optionalQueryText(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return value;
}

function optionalQueryLimit(values: Map<string, string>): number | undefined {
  const raw = values.get('limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return limit;
}

function bindBody(value: unknown): { inviteCode: string } {
  const object = strictObject(value, ['inviteCode'], ['inviteCode']);
  const inviteCode = object.inviteCode;
  if (typeof inviteCode !== 'string' || inviteCode.length === 0 || inviteCode.length > MAX_INVITE_CODE_LENGTH) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return { inviteCode };
}

function policyBody(value: unknown): { rewardBp: number; enabled: boolean; expectedVersion: number } {
  const object = strictObject(
    value,
    ['rewardBp', 'enabled', 'expectedVersion'],
    ['rewardBp', 'enabled', 'expectedVersion'],
  );
  const { rewardBp, enabled, expectedVersion } = object;
  if (
    typeof rewardBp !== 'number' ||
    !Number.isSafeInteger(rewardBp) ||
    rewardBp < 0 ||
    rewardBp > 5000 ||
    typeof enabled !== 'boolean' ||
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return { rewardBp, enabled, expectedVersion };
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let matches = 0;
  let value: string | undefined;
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    matches += 1;
    if (matches > 1) return undefined;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return matches === 1 && value !== undefined && value.length > 0 ? value : undefined;
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

function parseOrigin(publicOrigin: string): { readonly origin: string; readonly host: string } {
  if (typeof publicOrigin !== 'string' || publicOrigin.length === 0) {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  return { origin: parsed.origin, host: parsed.host };
}

function requireOrigin(req: IncomingMessage, originPolicy: { readonly origin: string; readonly host: string }): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }
  if (origin !== originPolicy.origin) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (host !== originPolicy.host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function contentTypeIsJson(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!contentTypeIsJson(req.headers['content-type'])) {
    drainRequest(req);
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    if (!/^\d+$/u.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid');
    }
    if (Number(rawLength) > MAX_BODY_BYTES) {
      drainRequest(req);
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  } else if (Array.isArray(rawLength)) {
    drainRequest(req);
    throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
    else tooLarge = true;
  }
  if (tooLarge) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
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

function methodNotAllowed(res: ServerResponse, requestId: string, allow: string): void {
  res.writeHead(405, {
    allow,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }));
}

/**
 * Error rebuild: stable customer-facing codes, no internal messages. An
 * unresolvable invite code is indistinguishable from a malformed one at the
 * HTTP layer (both 400) so code existence is never an oracle beyond what a
 * bind attempt itself reveals.
 */
function serviceError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof MarketingAffiliateError) {
    switch (error.code) {
      case 'AFFILIATE_INVALID_INPUT':
        return new HttpError(400, error.code, 'The affiliate request is invalid');
      case 'AFFILIATE_INVITE_CODE_INVALID':
        return new HttpError(400, error.code, 'The invite code is invalid');
      case 'AFFILIATE_SELF_INVITE':
      case 'AFFILIATE_CYCLE':
      case 'AFFILIATE_ALREADY_BOUND':
      case 'AFFILIATE_POLICY_VERSION_CONFLICT':
        return new HttpError(409, error.code, 'The affiliate request conflicts with the current state');
      case 'AFFILIATE_FORBIDDEN':
        return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      default:
        break;
    }
  }
  // Identity-service failures carry a numeric status (e.g. 404
  // TENANT_ACCESS_DENIED for non-members); mirror them without leaking codes.
  const status = asObject(error)?.status;
  if (status === 401) return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (status === 403) return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  if (status === 404) return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
  if (status === 409) return new HttpError(409, 'CONFLICT', 'The request conflicts with existing data');
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

function respondError(req: IncomingMessage, res: ServerResponse, requestId: string, error: unknown): void {
  drainRequest(req);
  if (res.destroyed || res.writableEnded) return;
  const safe = serviceError(error);
  sendError(res, safe.status, requestId, safe.code, safe.safeMessage);
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

/** Process-local fixed-window counter (rate tier `marketing-affiliate-bind:source:v1`). */
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
  res.writeHead(429, {
    'retry-after': String(retryAfterSeconds),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many bind attempts', requestId } }));
}

function unavailable(): HttpError {
  return new HttpError(503, 'AFFILIATE_UNAVAILABLE', 'Marketing affiliate is not configured');
}

type CustomerRoute =
  | { readonly route: 'view'; readonly tenantId: string }
  | { readonly route: 'bind'; readonly tenantId: string };

function matchCustomerRoute(pathname: string): CustomerRoute | undefined {
  if (!pathname.startsWith(`${CONSOLE_PREFIX}/`)) return undefined;
  const segments = pathname.slice(CONSOLE_PREFIX.length + 1).split('/');
  if (segments.length === 2 && segments[1] === 'affiliate') {
    return { route: 'view', tenantId: uuidIdentifier(segments[0] as string) };
  }
  if (segments.length === 3 && segments[1] === 'affiliate' && segments[2] === 'bind') {
    return { route: 'bind', tenantId: uuidIdentifier(segments[0] as string) };
  }
  return undefined;
}

/**
 * Customer surface (`/console/api/v1/tenants/:tenantId/affiliate[/bind]`).
 * Every active tenant role may read and bind; membership itself is enforced
 * by resolveTenantContext. Bind attempts are brute-force-limited on two
 * dimensions: 10/min per user and 30/min per source address.
 */
export function createMarketingAffiliateCustomerHttpHandler(
  options: MarketingAffiliateCustomerHttpOptions,
): MarketingAffiliateHttpHandler {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (
    !options.service ||
    typeof options.service.getSession !== 'function' ||
    typeof options.service.verifyCsrfToken !== 'function' ||
    typeof options.service.resolveTenantContext !== 'function'
  ) {
    throw new TypeError('identity service methods are required');
  }
  const originPolicy = parseOrigin(options.publicOrigin);
  const sourceLimiter = new FixedWindowLimiter(BIND_SOURCE_LIMIT, RATE_LIMIT_WINDOW_MS);
  const userLimiter = new FixedWindowLimiter(BIND_USER_LIMIT, RATE_LIMIT_WINDOW_MS);

  return async (req, res): Promise<boolean> => {
    const requestId = `marketing_affiliate_${randomUUID()}`;
    const url = requestUrl(req, originPolicy.origin);
    if (url === undefined) return false;
    let match: CustomerRoute | undefined;
    try {
      match = matchCustomerRoute(url.pathname);
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
    if (match === undefined) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const allowed = match.route === 'view' ? ['GET'] : ['POST'];
    if (!allowed.includes(method)) {
      drainRequest(req);
      methodNotAllowed(res, requestId, allowed.join(', '));
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');

      if (match.route === 'bind') {
        const sourceRetry = sourceLimiter.take(
          `${BIND_RATE_LIMIT_NAMESPACE}:ip:${req.socket.remoteAddress ?? 'unknown'}`,
        );
        if (sourceRetry !== undefined) {
          drainRequest(req);
          rateLimited(res, requestId, sourceRetry);
          return true;
        }
      }

      const token = cookieValue(req, CUSTOMER_SESSION_COOKIE);
      if (token === undefined) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (session === undefined || typeof session.userId !== 'string' || session.userId.trim() === '') {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      }

      if (match.route === 'bind') {
        const userRetry = userLimiter.take(`${BIND_RATE_LIMIT_NAMESPACE}:user:${session.userId}`);
        if (userRetry !== undefined) {
          drainRequest(req);
          rateLimited(res, requestId, userRetry);
          return true;
        }
      }

      const context = await options.service.resolveTenantContext({ userId: session.userId, tenantId: match.tenantId });
      if (context.userId !== session.userId || context.tenantId !== match.tenantId) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }
      const customer = { tenantId: context.tenantId, userId: context.userId };

      if (match.route === 'view') {
        if (!options.operations) throw unavailable();
        const values = queryValues(url, ['limit', 'cursor']);
        const result = await options.operations.getMyAffiliate(customer, {
          limit: optionalQueryLimit(values),
          cursor: optionalQueryText(values, 'cursor'),
        });
        sendJson(res, 200, requestId, result);
        return true;
      }

      requireOrigin(req, originPolicy);
      const csrfCookie = cookieValue(req, CUSTOMER_CSRF_COOKIE);
      const csrfHeader = req.headers['x-csrf-token'];
      if (
        csrfCookie === undefined ||
        typeof csrfHeader !== 'string' ||
        !sameSecret(csrfCookie, csrfHeader) ||
        !(await options.service.verifyCsrfToken(token, csrfCookie))
      ) {
        throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
      }
      if (!options.operations) {
        drainRequest(req);
        throw unavailable();
      }
      const body = bindBody(await readJson(req));
      const result = await options.operations.bindInviter(customer, body);
      sendJson(res, 200, requestId, result);
      return true;
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
  };
}

type OpsRoute = { readonly route: 'policy' } | { readonly route: 'rewards' };

function matchOpsRoute(pathname: string): OpsRoute | undefined {
  if (pathname === OPS_POLICY_PATH) return { route: 'policy' };
  if (pathname === OPS_REWARDS_PATH) return { route: 'rewards' };
  return undefined;
}

/**
 * Operations surface: `GET/PUT /admin/api/v1/marketing/affiliate-policy`
 * (CAS replace) and `GET /admin/api/v1/marketing/affiliate-rewards` (keyset
 * listing, optional inviter filter). The operator identity comes from the
 * platform session only.
 */
export function createMarketingAffiliateOpsHttpHandler(
  options: MarketingAffiliateOpsHttpOptions,
): MarketingAffiliateHttpHandler {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  const originPolicy = parseOrigin(options.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const requestId = `marketing_affiliate_ops_${randomUUID()}`;
    const url = requestUrl(req, originPolicy.origin);
    if (url === undefined) return false;
    const match = matchOpsRoute(url.pathname);
    if (match === undefined) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const allowed = match.route === 'policy' ? ['GET', 'PUT'] : ['GET'];
    if (!allowed.includes(method)) {
      drainRequest(req);
      methodNotAllowed(res, requestId, allowed.join(', '));
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);

      if (method === 'GET') {
        if (!options.operations) throw unavailable();
        if (match.route === 'policy') {
          const policy = await options.operations.getAffiliatePolicy({ userId: actor.userId });
          sendJson(res, 200, requestId, { policy });
          return true;
        }
        const values = queryValues(url, ['inviterTenantId', 'limit', 'cursor']);
        const result = await options.operations.listRewards(
          { userId: actor.userId },
          {
            inviterTenantId: optionalQueryText(values, 'inviterTenantId'),
            limit: optionalQueryLimit(values),
            cursor: optionalQueryText(values, 'cursor'),
          },
        );
        sendJson(res, 200, requestId, { items: result.rewards, nextCursor: result.nextCursor });
        return true;
      }

      requireOrigin(req, originPolicy);
      await requirePlatformCsrf(req, options.authService);
      if (!options.operations) {
        drainRequest(req);
        throw unavailable();
      }
      const body = policyBody(await readJson(req));
      const policy = await options.operations.replaceAffiliatePolicy({ userId: actor.userId }, body);
      sendJson(res, 200, requestId, { policy });
      return true;
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
  };
}
