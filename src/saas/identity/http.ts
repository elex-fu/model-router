import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { SupplyMode } from '../gateway/contracts.js';
import type { KeyService } from '../keys/service.js';
import type { ApiKeyMetadata, CreateApiKeyInput, CreatedApiKey } from '../keys/types.js';
import type {
  CustomerSessionRevocation,
  OtherCustomerSessionsRevocation,
  SaasIdentityService,
  SafeCustomerSession,
} from './service.js';
import type { SafeProject, TenantMemberPage, TenantMemberQuery } from './types.js';

const API_PREFIX = '/console/api/v1';
const SESSION_PATH = `${API_PREFIX}/auth/session`;
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const COOKIE_PATH = API_PREFIX;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LIMITER_KEYS = 10_000;

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type JsonObject = Record<string, unknown>;

export interface SaasIdentityHttpOptions {
  service: SaasIdentityService;
  keyService?: Pick<KeyService, 'create' | 'list' | 'rotate' | 'revoke'>;
  publicOrigin: string;
  sessionTtlSeconds: number;
  cookieSecure?: boolean;
  /** Managed composition must inject the shared limiter; omission is local-only compatibility behavior. */
  rateLimiter?: SaasIdentityRateLimiter;
}

export interface SaasIdentityRateLimiter {
  /** Return a positive retry-after duration when the opaque key is limited. */
  take(key: string): Promise<number | undefined>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

class BoundedRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private nextCleanupAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

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

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringField(value: unknown, name: string): string | undefined {
  const field = asObject(value)?.[name];
  return typeof field === 'string' ? field : undefined;
}

function nonEmptyString(value: unknown, name: string, trim = true): string {
  if (typeof value !== 'string' || (trim ? !value.trim() : value.length === 0)) {
    throw new HttpError(400, 'INVALID_BODY', `${name} is required`);
  }
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

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
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
    ...(error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) }),
    ...(extraHeaders ?? {}),
  });
  res.end(
    JSON.stringify({
      error: { code: error.code, message: error.message, requestId },
    }),
  );
}

function safeServiceError(value: unknown): HttpError {
  const object = asObject(value);
  const candidate = object?.status ?? object?.statusCode;
  const status = typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : 500;
  switch (status) {
    case 400:
    case 422:
      return new HttpError(400, 'REQUEST_REJECTED', 'The request could not be processed');
    case 401:
      return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    case 403:
      return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    case 404:
      return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
    case 409:
      return new HttpError(409, 'CONFLICT', 'The request conflicts with the current resource state');
    case 429:
      return new HttpError(429, 'RATE_LIMITED', 'Too many requests');
    case 503:
      return new HttpError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable');
    default:
      return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
}

function routePath(req: IncomingMessage, baseOrigin: string): string | undefined {
  try {
    return new URL(req.url ?? '/', baseOrigin).pathname;
  } catch {
    return undefined;
  }
}

type Route =
  | 'session'
  | 'sessions'
  | 'sessionRevoke'
  | 'sessionsRevokeOthers'
  | 'tenants'
  | 'tenantProjects'
  | 'tenantMembers'
  | 'tenantInvitations'
  | 'acceptInvitation'
  | 'projectKeys'
  | 'keyRotate'
  | 'keyRevoke';

function pathIdentifier(encoded: string, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  if (
    !value ||
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

function findRoute(
  path: string,
): { route: Route; tenantId?: string; projectId?: string; keyId?: string; sessionId?: string } | undefined {
  if (path === SESSION_PATH) return { route: 'session' };
  if (path === `${API_PREFIX}/auth/sessions`) return { route: 'sessions' };
  if (path === `${API_PREFIX}/auth/sessions/revoke-others`) return { route: 'sessionsRevokeOthers' };
  if (path === `${API_PREFIX}/tenants`) return { route: 'tenants' };
  if (path === `${API_PREFIX}/invitations/accept`) return { route: 'acceptInvitation' };

  const sessionRevokeMatch = new RegExp(`^${API_PREFIX}/auth/sessions/([^/]+)/revoke$`).exec(path);
  if (sessionRevokeMatch) {
    return { route: 'sessionRevoke', sessionId: pathIdentifier(sessionRevokeMatch[1], 'session') };
  }

  const projectsMatch = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/projects$`).exec(path);
  if (projectsMatch) {
    return { route: 'tenantProjects', tenantId: pathIdentifier(projectsMatch[1], 'tenant') };
  }

  const membersMatch = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/members$`).exec(path);
  if (membersMatch) return { route: 'tenantMembers', tenantId: pathIdentifier(membersMatch[1], 'tenant') };

  const keyMatch = new RegExp(
    `^${API_PREFIX}/tenants/([^/]+)/projects/([^/]+)/keys(?:/([^/]+)/(rotate|revoke))?$`,
  ).exec(path);
  if (keyMatch) {
    const tenantId = pathIdentifier(keyMatch[1], 'tenant');
    const projectId = pathIdentifier(keyMatch[2], 'project');
    if (!keyMatch[3]) return { route: 'projectKeys', tenantId, projectId };
    const keyId = pathIdentifier(keyMatch[3], 'key');
    return { route: keyMatch[4] === 'rotate' ? 'keyRotate' : 'keyRevoke', tenantId, projectId, keyId };
  }

  const match = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/invitations$`).exec(path);
  if (!match) return undefined;
  const tenantId = pathIdentifier(match[1], 'tenant');
  return { route: 'tenantInvitations', tenantId };
}

function peerAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown-peer';
}

function cookieValue(req: IncomingMessage, cookieName: string): string | undefined {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  const matches: string[] = [];
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1) return undefined;
  try {
    return decodeURIComponent(matches[0]) || undefined;
  } catch {
    return undefined;
  }
}

function sessionTokenFromCookie(req: IncomingMessage): string | undefined {
  return cookieValue(req, SESSION_COOKIE_NAME);
}

function csrfTokenFromCookie(req: IncomingMessage): string | undefined {
  return cookieValue(req, CSRF_COOKIE_NAME);
}

function constantTimeMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safePublicValue(value: unknown, hiddenValue?: string, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 12 || value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === hiddenValue ? undefined : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => safePublicValue(item, hiddenValue, seen, depth + 1))
      .filter((item) => item !== undefined);
  }

  const result: JsonObject = {};
  for (const [key, field] of Object.entries(value)) {
    if (/token|password|secret|credential|hash/i.test(key)) continue;
    const publicField = safePublicValue(field, hiddenValue, seen, depth + 1);
    if (publicField !== undefined) result[key] = publicField;
  }
  return result;
}

function extractRawToken(value: unknown, names: readonly string[]): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  const object = asObject(value);
  for (const name of names) {
    const candidate = object?.[name];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function sessionCookieHeader(token: string, ttlSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${COOKIE_PATH}`,
    `Max-Age=${ttlSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function csrfCookieHeader(token: string, ttlSeconds: number, secure: boolean): string {
  return [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'SameSite=Strict',
    `Path=${COOKIE_PATH}`,
    `Max-Age=${ttlSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function expiredCookies(secure: boolean): string[] {
  const expiry = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const secureFlag = secure ? '; Secure' : '';
  return [
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; ${expiry}${secureFlag}`,
    `${CSRF_COOKIE_NAME}=; SameSite=Strict; Path=${COOKIE_PATH}; ${expiry}${secureFlag}`,
  ];
}

function requireSameOrigin(req: IncomingMessage, origin: string): void {
  const supplied = req.headers.origin;
  if (typeof supplied !== 'string') throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  try {
    const parsed = new URL(supplied);
    if (parsed.origin !== origin || supplied !== parsed.origin) throw new Error('origin mismatch');
  } catch {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

function requireWriteBoundary(req: IncomingMessage, origin: string, host: string): void {
  requireSameOrigin(req, origin);
  const suppliedHost = req.headers.host;
  if (typeof suppliedHost !== 'string') {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (suppliedHost !== host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

function validateOptionalString(object: JsonObject, key: string): string | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  return nonEmptyString(object[key], key);
}

function modelScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new HttpError(400, 'INVALID_BODY', 'modelScopes must be a non-empty array of strings');
  }
  return value as string[];
}

function supplyMode(value: unknown): SupplyMode {
  if (value !== 'byok' && value !== 'platform') {
    throw new HttpError(400, 'INVALID_BODY', 'supplyMode must be byok or platform');
  }
  return value;
}

function publicApiKey(value: ApiKeyMetadata | CreatedApiKey): JsonObject {
  const secret = 'secret' in value ? value.secret : undefined;
  const metadata = safePublicValue(value, secret);
  const data = asObject(metadata) ?? {};
  if (secret !== undefined) data.secret = secret;
  return data;
}

function publicProject(value: SafeProject): JsonObject {
  return {
    id: value.id,
    tenantId: value.tenantId,
    name: value.name,
    slug: value.slug,
    role: value.role,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function memberQuery(req: IncomingMessage, origin: string): TenantMemberQuery {
  const params = new URL(req.url ?? '/', origin).searchParams;
  for (const key of params.keys()) {
    if ((key !== 'limit' && key !== 'cursor') || params.getAll(key).length !== 1) {
      throw new HttpError(400, 'REQUEST_REJECTED', 'The query contains invalid data');
    }
  }
  const query: TenantMemberQuery = {};
  const limit = params.get('limit');
  if (limit !== null) {
    if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new HttpError(400, 'REQUEST_REJECTED', 'The page size is invalid');
    query.limit = Number(limit);
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!/^tm1\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024) throw new HttpError(400, 'REQUEST_REJECTED', 'The cursor is invalid');
    query.cursor = cursor;
  }
  return query;
}

function publicMemberPage(value: TenantMemberPage): JsonObject {
  if (!value || !Array.isArray(value.items) || value.items.length > 100 ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1024 || !/^tm1\.[A-Za-z0-9_-]+$/.test(value.nextCursor)))) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  return { items: value.items.map(member => {
    if (!member || typeof member.userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(member.userId) ||
      (member.displayName !== null && (typeof member.displayName !== 'string' || member.displayName.length > 120)) ||
      !['owner', 'admin', 'developer', 'billing', 'viewer'].includes(member.role) ||
      !['active', 'suspended', 'revoked', 'disabled'].includes(member.status)) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
    }
    return { userId: member.userId, displayName: member.displayName, role: member.role, status: member.status };
  }), nextCursor: value.nextCursor };
}

function publicCustomerSession(value: SafeCustomerSession): JsonObject {
  const session = asObject(value);
  if (
    !session ||
    typeof session.id !== 'string' ||
    typeof session.createdAt !== 'string' ||
    typeof session.expiresAt !== 'string' ||
    (session.revokedAt !== null && typeof session.revokedAt !== 'string') ||
    (session.status !== 'active' && session.status !== 'revoked' && session.status !== 'expired') ||
    typeof session.current !== 'boolean'
  ) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    status: session.status,
    current: session.current,
  };
}

function publicSessionRevocation(value: CustomerSessionRevocation): JsonObject {
  const result = asObject(value);
  if (
    !result ||
    typeof result.sessionId !== 'string' ||
    typeof result.revokedAt !== 'string' ||
    typeof result.currentSessionRevoked !== 'boolean'
  ) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  return {
    sessionId: result.sessionId,
    revokedAt: result.revokedAt,
    currentSessionRevoked: result.currentSessionRevoked,
  };
}

function publicOtherSessionsRevocation(value: OtherCustomerSessionsRevocation): JsonObject {
  const result = asObject(value);
  if (
    !result ||
    !Number.isSafeInteger(result.revokedCount) ||
    (result.revokedCount as number) < 0 ||
    result.currentSessionPreserved !== true
  ) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  return { revokedCount: result.revokedCount, currentSessionPreserved: true };
}

async function readEmptyJsonObject(req: IncomingMessage): Promise<void> {
  const contentLength = req.headers['content-length'];
  const hasTransferEncoding = typeof req.headers['transfer-encoding'] === 'string';
  if (contentLength === '0' && !hasTransferEncoding) return;
  if (contentLength === undefined && !hasTransferEncoding && req.headers['content-type'] === undefined) return;
  parseStrictObject(await readJson(req), [], []);
}

function requestMethodError(res: ServerResponse, requestId: string, methods: readonly string[]): void {
  const error = new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint');
  sendError(res, requestId, error, { allow: methods.join(', ') });
}

function opaqueLimiterKey(scope: string, peer: string, account?: string): string {
  const dimension = account === undefined ? 'source' : 'account';
  const value = account === undefined ? peer : account;
  return createHash('sha256')
    .update('model-router:saas-identity:v1\0', 'utf8')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(dimension, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

async function enforceRateLimit(
  req: IncomingMessage,
  rateLimiter: SaasIdentityRateLimiter,
  scope: string,
  account?: string,
): Promise<void> {
  let retryAfter: number | undefined;
  try {
    retryAfter = await rateLimiter.take(opaqueLimiterKey(scope, peerAddress(req), account));
  } catch {
    throw new HttpError(503, 'RATE_LIMITER_UNAVAILABLE', 'The authentication service is temporarily unavailable.');
  }
  if (retryAfter === undefined) return;
  if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) {
    throw new HttpError(503, 'RATE_LIMITER_UNAVAILABLE', 'The authentication service is temporarily unavailable.');
  }
  throw new HttpError(429, scope === 'tenantMembers' ? 'RATE_LIMITED' : 'LOGIN_RATE_LIMITED',
    scope === 'tenantMembers' ? 'Too many requests' : 'Too many login attempts', retryAfter);
}

/**
 * Managed callers inject a shared limiter. The bounded process-local limiter is
 * retained only as a compatibility fallback for local and direct callers.
 */
export function createSaasIdentityHandler(options: SaasIdentityHttpOptions): HttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;
  const secureCookie = publicUrl.protocol === 'https:' || options.cookieSecure === true;
  if (
    !Number.isInteger(options.sessionTtlSeconds) ||
    options.sessionTtlSeconds < 1 ||
    options.sessionTtlSeconds > 30 * 24 * 60 * 60
  ) {
    throw new TypeError('sessionTtlSeconds must be an integer from 1 to 2592000');
  }

  if (options.rateLimiter !== undefined && typeof options.rateLimiter.take !== 'function') {
    throw new TypeError('rateLimiter.take must be an asynchronous limiter implementation');
  }
  // COMPATIBILITY FALLBACK: managed composition must inject rateLimiter so all
  // instances share limits. This bounded process-local limiter is for local and
  // direct callers that have not adopted the managed dependency yet.
  const compatibilityLoginLimiter = new BoundedRateLimiter(10, 15 * 60_000);
  const rateLimiter: SaasIdentityRateLimiter = options.rateLimiter ?? {
    take: async (key) => compatibilityLoginLimiter.take(key),
  };
  const getSession = async (req: IncomingMessage): Promise<{ token: string; session: unknown }> => {
    const token = sessionTokenFromCookie(req);
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    const session = await options.service.getSession(token);
    if (!session) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    }
    return { token, session };
  };

  const requireCsrf = async (req: IncomingMessage, token: string): Promise<void> => {
    requireSameOrigin(req, expectedOrigin);
    const cookieToken = csrfTokenFromCookie(req);
    const headerToken = req.headers['x-csrf-token'];
    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      !constantTimeMatches(cookieToken, headerToken) ||
      !(await options.service.verifyCsrfToken(token, cookieToken))
    ) {
      throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
    }
  };

  const requireUserId = (session: unknown): string => {
    const userId = stringField(session, 'userId');
    if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return userId;
  };

  return async (req, res) => {
    const requestId = `saas_${randomUUID()}`;
    let path: string | undefined;
    try {
      path = routePath(req, expectedOrigin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      if (!path.startsWith(`${API_PREFIX}/`)) return false;
      const match = findRoute(path);
      if (!match) return false;

      const method = (req.method ?? 'GET').toUpperCase();
      const methods: Record<Route, readonly string[]> = {
        session: ['GET', 'POST', 'DELETE'],
        sessions: ['GET'],
        sessionRevoke: ['POST'],
        sessionsRevokeOthers: ['POST'],
        tenants: ['GET', 'POST'],
        tenantProjects: ['GET', 'POST'],
        tenantMembers: ['GET'],
        tenantInvitations: ['POST'],
        acceptInvitation: ['POST'],
        projectKeys: ['GET', 'POST'],
        keyRotate: ['POST'],
        keyRevoke: ['POST'],
      };
      if (!methods[match.route].includes(method)) {
        requestMethodError(res, requestId, methods[match.route]);
        return true;
      }

      try {
        if (method === 'POST') {
          requireWriteBoundary(req, expectedOrigin, expectedHost);
        }

        if (match.route === 'session' && method === 'POST') {
          await enforceRateLimit(req, rateLimiter, match.route);
          const body = parseStrictObject(
            await readJson(req),
            ['email', 'password', 'activeTenantId'],
            ['email', 'password'],
          );
          const email = nonEmptyString(body.email, 'email').trim().toLowerCase();
          await enforceRateLimit(req, rateLimiter, match.route, email);
          const activeTenantId = validateOptionalString(body, 'activeTenantId');
          const result = await options.service.login({
            email,
            password: nonEmptyString(body.password, 'password', false),
            ...(activeTenantId === undefined ? {} : { activeTenantId }),
            ttlSeconds: options.sessionTtlSeconds,
          });
          if (!result) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
          const sessionToken = stringField(result, 'token');
          const csrfToken = stringField(result, 'csrfToken');
          const session = asObject(result)?.session;
          if (!sessionToken || !csrfToken || !session) {
            throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
          }
          sendJson(
            res,
            200,
            requestId,
            { session: safePublicValue(session, sessionToken) },
            {
              'set-cookie': [
                sessionCookieHeader(sessionToken, options.sessionTtlSeconds, secureCookie),
                csrfCookieHeader(csrfToken, options.sessionTtlSeconds, secureCookie),
              ],
            },
          );
          return true;
        }

        if (match.route === 'session' && method === 'GET') {
          const { token, session } = await getSession(req);
          sendJson(res, 200, requestId, { session: safePublicValue(session, token) });
          return true;
        }

        if (match.route === 'session' && method === 'DELETE') {
          const { token } = await getSession(req);
          await requireCsrf(req, token);
          await options.service.logout(token);
          sendJson(res, 200, requestId, { loggedOut: true }, { 'set-cookie': expiredCookies(secureCookie) });
          return true;
        }

        if (match.route === 'sessions' && method === 'GET') {
          const { token } = await getSession(req);
          const sessions = await options.service.listSessions(token);
          if (!sessions) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
          sendJson(res, 200, requestId, { sessions: sessions.map(publicCustomerSession) });
          return true;
        }

        if (match.route === 'sessionRevoke' && method === 'POST') {
          const { token } = await getSession(req);
          await requireCsrf(req, token);
          await readEmptyJsonObject(req);
          if (!match.sessionId) throw new HttpError(400, 'INVALID_PATH', 'The session identifier is invalid');
          const result = await options.service.revokeSession(token, match.sessionId, requestId);
          if (!result) throw new HttpError(404, 'NOT_FOUND', 'The requested session was not found');
          sendJson(
            res,
            200,
            requestId,
            publicSessionRevocation(result),
            result.currentSessionRevoked ? { 'set-cookie': expiredCookies(secureCookie) } : undefined,
          );
          return true;
        }

        if (match.route === 'sessionsRevokeOthers' && method === 'POST') {
          const { token } = await getSession(req);
          await requireCsrf(req, token);
          await readEmptyJsonObject(req);
          const result = await options.service.revokeOtherSessions(token, requestId);
          sendJson(res, 200, requestId, publicOtherSessionsRevocation(result));
          return true;
        }

        if (match.route === 'tenants' && method === 'GET') {
          const { session } = await getSession(req);
          const tenants = await options.service.listTenants(requireUserId(session));
          sendJson(res, 200, requestId, safePublicValue(tenants));
          return true;
        }

        if (match.route === 'tenants' && method === 'POST') {
          const { token, session } = await getSession(req);
          await requireCsrf(req, token);
          const body = parseStrictObject(await readJson(req), ['name', 'slug'], ['name']);
          const slug = validateOptionalString(body, 'slug');
          const tenant = await options.service.createTenant(requireUserId(session), {
            name: nonEmptyString(body.name, 'name'),
            ...(slug === undefined ? {} : { slug }),
          });
          sendJson(res, 201, requestId, safePublicValue(tenant));
          return true;
        }

        if (match.route === 'tenantProjects' && (method === 'GET' || method === 'POST')) {
          const tenantId = match.tenantId;
          if (!tenantId) throw new HttpError(400, 'INVALID_PATH', 'The tenant identifier is invalid');
          const { token, session } = await getSession(req);
          if (method === 'POST') {
            await requireCsrf(req, token);
            const body = parseStrictObject(await readJson(req), ['name', 'slug'], ['name']);
            const slug = validateOptionalString(body, 'slug');
            const project = await options.service.createProject(requireUserId(session), tenantId, {
              name: nonEmptyString(body.name, 'name'),
              ...(slug === undefined ? {} : { slug }),
            });
            sendJson(res, 201, requestId, publicProject(project));
            return true;
          }

          const projects = await options.service.listProjects(requireUserId(session), tenantId);
          sendJson(res, 200, requestId, projects.map(publicProject));
          return true;
        }

        if (match.route === 'tenantMembers' && method === 'GET') {
          if (!match.tenantId) throw new HttpError(400, 'INVALID_PATH', 'The tenant identifier is invalid');
          const query = memberQuery(req, expectedOrigin);
          const { session } = await getSession(req);
          const actorUserId = requireUserId(session);
          // Reuse the shared opaque limiter, scoped to the authenticated actor,
          // not a caller-provided user/role. GET neither mutates nor requires CSRF.
          await enforceRateLimit(req, rateLimiter, match.route, actorUserId);
          const page = await options.service.listTenantMembers(actorUserId, match.tenantId, query);
          sendJson(res, 200, requestId, publicMemberPage(page));
          return true;
        }

        if (match.route === 'tenantInvitations' && method === 'POST') {
          const { token, session } = await getSession(req);
          await requireCsrf(req, token);
          const tenantId = match.tenantId;
          if (!tenantId) throw new HttpError(400, 'INVALID_PATH', 'The tenant identifier is invalid');
          const body = parseStrictObject(await readJson(req), ['email', 'role', 'ttlSeconds'], ['email', 'role']);
          const email = nonEmptyString(body.email, 'email');
          const role = nonEmptyString(body.role, 'role');
          if (role !== 'admin' && role !== 'developer' && role !== 'billing' && role !== 'viewer') {
            throw new HttpError(400, 'INVALID_BODY', 'role must be admin, developer, billing, or viewer');
          }
          let ttlSeconds: number | undefined;
          if (Object.hasOwn(body, 'ttlSeconds')) {
            if (
              !Number.isInteger(body.ttlSeconds) ||
              (body.ttlSeconds as number) < 1 ||
              (body.ttlSeconds as number) > 30 * 24 * 60 * 60
            ) {
              throw new HttpError(400, 'INVALID_BODY', 'ttlSeconds must be an integer between 1 and 2592000');
            }
            ttlSeconds = body.ttlSeconds as number;
          }
          const invitation = await options.service.createInvitation(requireUserId(session), tenantId, {
            email,
            role,
            ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          });
          const invitationToken = extractRawToken(invitation, ['token', 'invitationToken']);
          if (!invitationToken) throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
          const safeInvitation = asObject(safePublicValue(invitation, invitationToken)) ?? {};
          sendJson(res, 201, requestId, { ...safeInvitation, token: invitationToken });
          return true;
        }

        if (
          (match.route === 'projectKeys' || match.route === 'keyRotate' || match.route === 'keyRevoke') &&
          match.tenantId &&
          match.projectId
        ) {
          const { token, session } = await getSession(req);
          if (method !== 'GET') await requireCsrf(req, token);
          const keyService = options.keyService;
          if (!keyService) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'The key service is unavailable');
          if (method === 'POST' && match.route === 'projectKeys') {
            const body = parseStrictObject(
              await readJson(req),
              ['name', 'modelScopes', 'supplyMode', 'expiresAt'],
              ['name', 'modelScopes', 'supplyMode'],
            );
            const expiresAt = Object.hasOwn(body, 'expiresAt') ? body.expiresAt : undefined;
            if (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'string') {
              throw new HttpError(400, 'INVALID_BODY', 'expiresAt must be a timestamp string or null');
            }
            const context = await options.service.authorizeProjectAccess({
              userId: requireUserId(session),
              tenantId: match.tenantId,
              projectId: match.projectId,
            });
            const created = await keyService.create(context, {
              name: nonEmptyString(body.name, 'name'),
              modelScopes: modelScopes(body.modelScopes),
              supplyMode: supplyMode(body.supplyMode),
              ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as string | null }),
            } satisfies CreateApiKeyInput);
            sendJson(res, 201, requestId, publicApiKey(created));
            return true;
          }

          const context = await options.service.authorizeProjectAccess({
            userId: requireUserId(session),
            tenantId: match.tenantId,
            projectId: match.projectId,
          });
          if (match.route === 'projectKeys' && method === 'GET') {
            const listed = await keyService.list(context);
            sendJson(res, 200, requestId, listed.map(publicApiKey));
            return true;
          }
          await readEmptyJsonObject(req);
          if (!match.keyId) throw new HttpError(400, 'INVALID_PATH', 'The key identifier is invalid');
          if (match.route === 'keyRotate') {
            const rotated = await keyService.rotate(context, match.keyId);
            sendJson(res, 201, requestId, publicApiKey(rotated));
            return true;
          }
          if (match.route === 'keyRevoke') {
            const revoked = await keyService.revoke(context, match.keyId);
            sendJson(res, 200, requestId, publicApiKey(revoked));
            return true;
          }
        }

        if (match.route === 'acceptInvitation' && method === 'POST') {
          const body = parseStrictObject(
            await readJson(req),
            ['token', 'email', 'displayName', 'password'],
            ['token', 'email', 'displayName', 'password'],
          );
          const invitationToken = nonEmptyString(body.token, 'token');
          const accepted = await options.service.acceptInvitation({
            token: invitationToken,
            email: nonEmptyString(body.email, 'email'),
            displayName: nonEmptyString(body.displayName, 'displayName'),
            password: nonEmptyString(body.password, 'password', false),
          });
          sendJson(res, 201, requestId, safePublicValue(accepted, invitationToken));
          return true;
        }

        return false;
      } catch (error) {
        if (res.destroyed || res.writableEnded) return true;
        sendError(res, requestId, error instanceof HttpError ? error : safeServiceError(error));
        return true;
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : safeServiceError(error));
      return true;
    }
  };
}
