import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { PlatformAdminLogin, PlatformAuthSession, PlatformMfaEnrollmentStart } from './types.js';

export const PLATFORM_ADMIN_AUTH_PREFIX = '/admin/api/v1/auth' as const;
export const PLATFORM_ADMIN_SESSION_COOKIE = 'mr_platform_admin_session' as const;
export const PLATFORM_ADMIN_CSRF_COOKIE = 'mr_platform_admin_csrf' as const;
export const PLATFORM_ADMIN_AUTH_COOKIE_PATH = '/admin/api/v1' as const;
const PLATFORM_ADMIN_LEGACY_AUTH_COOKIE_PATH = PLATFORM_ADMIN_AUTH_PREFIX;
export const PLATFORM_ADMIN_MAX_BODY_BYTES = 64 * 1024;
export const PLATFORM_ADMIN_DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

type JsonObject = Record<string, unknown>;

export interface PlatformAdminAuthHttpService {
  login(email: string, password: string, code: string): Promise<PlatformAdminLogin | undefined>;
  getSession(token: string): Promise<PlatformAuthSession | undefined>;
  verifyCsrfToken(token: string, csrfToken: string): Promise<boolean>;
  logout(token: string): Promise<void>;
  beginMfaEnrollment(token: string, issuer: string): Promise<PlatformMfaEnrollmentStart>;
  confirmMfaEnrollment(confirmationToken: string, code: string): Promise<void>;
}

export interface PlatformAdminAuthRateLimiter {
  /** Return a positive retry-after duration when the opaque key is limited. */
  take(key: string): Promise<number | undefined>;
}

export interface PlatformAdminAuthHttpOptions {
  readonly service: PlatformAdminAuthHttpService;
  readonly publicOrigin: string;
  readonly rateLimiter: PlatformAdminAuthRateLimiter;
  /** Must match the service's configured session lifetime when a non-default is used. */
  readonly sessionTtlSeconds?: number;
}

export type PlatformAdminAuthHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(safeMessage);
    this.name = 'PlatformAdminAuthHttpError';
  }
}

interface OriginPolicy {
  readonly origin: string;
  readonly host: string;
  readonly secureCookies: boolean;
}

type Route = 'session' | 'mfaStart' | 'mfaConfirm';

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function isLoopbackIpv4(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%', 1)[0];
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (isLoopbackIpv4(normalized)) return true;

  // WHATWG URL canonicalizes IPv4-mapped IPv6 addresses to hexadecimal, e.g.
  // [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isLoopbackIpv4(mapped)) return true;
    const words = mapped.split(':');
    if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return false;
    const highWord = Number.parseInt(words[0] as string, 16);
    return highWord >>> 8 === 127;
  }

  return false;
}

function parseOriginPolicy(publicOrigin: string): OriginPolicy {
  if (typeof publicOrigin !== 'string' || publicOrigin.length === 0) {
    throw new TypeError('publicOrigin must be an origin string');
  }

  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new TypeError('publicOrigin must be a valid HTTP(S) origin');
  }

  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('publicOrigin must be a valid HTTP(S) origin');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError('HTTP publicOrigin is allowed only for loopback development or test origins');
  }

  return {
    origin: parsed.origin,
    host: parsed.host,
    secureCookies: parsed.protocol === 'https:',
  };
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://platform-admin.invalid').pathname;
  } catch {
    return undefined;
  }
}

function routeForPath(path: string): Route | undefined {
  if (path === `${PLATFORM_ADMIN_AUTH_PREFIX}/session`) return 'session';
  if (path === `${PLATFORM_ADMIN_AUTH_PREFIX}/mfa/enrollment/start`) return 'mfaStart';
  if (path === `${PLATFORM_ADMIN_AUTH_PREFIX}/mfa/enrollment/confirm`) return 'mfaConfirm';
  return undefined;
}

function isOwnedNamespace(path: string): boolean {
  return path === PLATFORM_ADMIN_AUTH_PREFIX || path.startsWith(`${PLATFORM_ADMIN_AUTH_PREFIX}/`);
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function contentTypeIsJson(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;|\s*$)/i.test(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!contentTypeIsJson(req.headers['content-type'])) {
    drainRequest(req);
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    if (!/^\d+$/.test(rawLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
    }
    if (declaredLength > PLATFORM_ADMIN_MAX_BODY_BYTES) {
      drainRequest(req);
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= PLATFORM_ADMIN_MAX_BODY_BYTES) chunks.push(buffer);
    else tooLarge = true;
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

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return value;
}

function normalizeAccountIdentifier(object: JsonObject, key: string): string {
  const normalized = requiredString(object, key).trim().toLowerCase();
  if (normalized.length === 0) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return normalized;
}

function optionalString(object: JsonObject, key: string): string | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  return requiredString(object, key);
}

function authorizationBearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_AUTHORIZATION', 'The authorization header is invalid.');
  }
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match) throw new HttpError(400, 'INVALID_AUTHORIZATION', 'The authorization header is invalid.');
  return match[1];
}

function bearerOrBodyToken(req: IncomingMessage, object: JsonObject, field: string, errorCode: string): string {
  const headerToken = authorizationBearer(req);
  const bodyToken = optionalString(object, field);
  if (headerToken !== undefined && bodyToken !== undefined && headerToken !== bodyToken) {
    throw new HttpError(400, 'INVALID_AUTHORIZATION', 'The authorization credentials are invalid.');
  }
  const token = headerToken ?? bodyToken;
  if (token === undefined) throw new HttpError(401, errorCode, 'A valid bearer token is required.');
  return token;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let found: string | undefined;
  let matches = 0;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    matches += 1;
    const encoded = part.slice(separator + 1).trim();
    if (encoded.length === 0) return undefined;
    try {
      found = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  return matches === 1 ? found : undefined;
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

function requireWriteBoundary(req: IncomingMessage, policy: OriginPolicy): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') {
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }
  if (origin !== policy.origin) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }

  const host = req.headers.host;
  if (typeof host !== 'string') {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (host !== policy.host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

function peerAddress(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? 'unknown-peer';
}

function opaqueLimiterKey(bucket: 'source' | 'account', scope: string, value: string): string {
  return createHash('sha256')
    .update('model-router:platform-admin-auth:v3\0', 'utf8')
    .update(bucket, 'utf8')
    .update('\0', 'utf8')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

async function enforceRateLimit(
  req: IncomingMessage,
  rateLimiter: PlatformAdminAuthRateLimiter,
  scope: string,
  normalizedAccount?: string,
): Promise<void> {
  let retryAfter: number | undefined;
  try {
    const key =
      normalizedAccount === undefined
        ? opaqueLimiterKey('source', scope, peerAddress(req))
        : opaqueLimiterKey('account', scope, normalizedAccount);
    retryAfter = await rateLimiter.take(key);
  } catch {
    throw new HttpError(503, 'RATE_LIMITER_UNAVAILABLE', 'The authentication service is temporarily unavailable.');
  }
  if (retryAfter === undefined) return;
  if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) {
    throw new HttpError(503, 'RATE_LIMITER_UNAVAILABLE', 'The authentication service is temporarily unavailable.');
  }
  throw new HttpError(429, 'RATE_LIMITED', 'Too many authentication requests', retryAfter);
}

function publicSession(value: unknown): JsonObject {
  const session = asObject(value);
  if (!session || typeof session.userId !== 'string' || session.userId.length === 0) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  const result: JsonObject = { userId: session.userId };
  for (const field of ['id', 'createdAt', 'expiresAt'] as const) {
    if (typeof session[field] === 'string') result[field] = session[field];
  }
  return result;
}

function serviceError(value: unknown): HttpError {
  const code = asObject(value)?.code;
  switch (code) {
    case 'INVALID_INPUT':
      return new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
    case 'MFA_UNAVAILABLE':
      return new HttpError(503, 'MFA_UNAVAILABLE', 'Platform MFA is unavailable.');
    case 'MFA_ENROLLMENT_UNAVAILABLE':
      return new HttpError(409, 'MFA_ENROLLMENT_UNAVAILABLE', 'Platform MFA enrollment is unavailable.');
    case 'MFA_ENROLLMENT_TOKEN_INVALID':
      return new HttpError(401, 'MFA_ENROLLMENT_TOKEN_INVALID', 'The MFA enrollment token is invalid or expired.');
    case 'MFA_CONFIRMATION_INVALID':
      return new HttpError(401, 'MFA_CONFIRMATION_INVALID', 'The MFA confirmation could not be completed.');
    case 'PLATFORM_AUTH_STORAGE_ERROR':
      return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
    default:
      return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
}

function loginFailure(): HttpError {
  return new HttpError(401, 'INVALID_CREDENTIALS', 'The email, password, or MFA code is invalid.');
}

function sessionCookie(token: string, ttlSeconds: number, secure: boolean): string {
  return [
    `${PLATFORM_ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${PLATFORM_ADMIN_AUTH_COOKIE_PATH}`,
    `Max-Age=${ttlSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function csrfCookie(token: string, ttlSeconds: number, secure: boolean): string {
  return [
    `${PLATFORM_ADMIN_CSRF_COOKIE}=${encodeURIComponent(token)}`,
    'SameSite=Strict',
    `Path=${PLATFORM_ADMIN_AUTH_COOKIE_PATH}`,
    `Max-Age=${ttlSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function expiredCookie(name: string, path: string, secure: boolean, httpOnly: boolean): string {
  const expiry = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return `${name}=;${httpOnly ? ' HttpOnly;' : ''} SameSite=Strict; Path=${path}; ${expiry}${secure ? '; Secure' : ''}`;
}

function expiredLegacyCookies(secure: boolean): string[] {
  return [
    expiredCookie(PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_LEGACY_AUTH_COOKIE_PATH, secure, true),
    expiredCookie(PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_LEGACY_AUTH_COOKIE_PATH, secure, false),
  ];
}

function expiredCookies(secure: boolean): string[] {
  return [
    expiredCookie(PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_AUTH_COOKIE_PATH, secure, true),
    expiredCookie(PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_AUTH_COOKIE_PATH, secure, false),
    ...expiredLegacyCookies(secure),
  ];
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

function sendError(res: ServerResponse, requestId: string, error: HttpError): void {
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) }),
  });
  res.end(
    JSON.stringify({
      error: { code: error.code, message: error.safeMessage, requestId },
    }),
  );
}

function isResponseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded;
}

function validateSessionTtl(value: number | undefined): number {
  const ttl = value ?? PLATFORM_ADMIN_DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > PLATFORM_ADMIN_DEFAULT_SESSION_TTL_SECONDS) {
    throw new TypeError('sessionTtlSeconds must be an integer from 1 to 28800');
  }
  return ttl;
}

function validateFactoryOptions(options: PlatformAdminAuthHttpOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.service || typeof options.service.login !== 'function') {
    throw new TypeError('service is required');
  }
  if (!options.rateLimiter || typeof options.rateLimiter.take !== 'function') {
    throw new TypeError('an async rateLimiter.take implementation is required');
  }
}

/**
 * Isolated platform-admin authentication transport. Composition roots may mount
 * this handler later; this module intentionally does not register it anywhere.
 */
export function createPlatformAdminAuthHandler(options: PlatformAdminAuthHttpOptions): PlatformAdminAuthHttpHandler {
  validateFactoryOptions(options);
  const policy = parseOriginPolicy(options.publicOrigin);
  const sessionTtlSeconds = validateSessionTtl(options.sessionTtlSeconds);

  const getAuthenticatedSession = async (
    req: IncomingMessage,
  ): Promise<{ token: string; session: PlatformAuthSession }> => {
    const token = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    let session: PlatformAuthSession | undefined;
    try {
      session = await options.service.getSession(token);
    } catch (error) {
      throw serviceError(error);
    }
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return { token, session };
  };

  const requireCsrf = async (req: IncomingMessage, token: string): Promise<void> => {
    const csrfCookieValue = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
    const csrfHeader = req.headers['x-csrf-token'];
    if (typeof csrfHeader !== 'string' || !sameSecret(csrfCookieValue, csrfHeader)) {
      throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
    }
    let valid = false;
    try {
      valid = await options.service.verifyCsrfToken(token, csrfCookieValue as string);
    } catch {
      valid = false;
    }
    if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  };

  const methods: Record<Route, readonly string[]> = {
    session: ['GET', 'POST', 'DELETE'],
    mfaStart: ['POST'],
    mfaConfirm: ['POST'],
  };

  return async (req, res) => {
    const requestId = `platform_auth_${randomUUID()}`;
    const path = requestPath(req);
    if (path === undefined || !isOwnedNamespace(path)) return false;

    const route = routeForPath(path);
    if (!route) {
      sendError(res, requestId, new HttpError(404, 'NOT_FOUND', 'Not found'));
      return true;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (!methods[route].includes(method)) {
      drainRequest(req);
      const error = new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint');
      res.writeHead(error.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        allow: methods[route].join(', '),
      });
      res.end(JSON.stringify({ error: { code: error.code, message: error.safeMessage, requestId } }));
      return true;
    }

    try {
      if (method === 'POST') {
        requireWriteBoundary(req, policy);
        await enforceRateLimit(req, options.rateLimiter, route);
      }

      if (route === 'session' && method === 'POST') {
        const body = parseStrictObject(
          await readJson(req),
          ['email', 'password', 'code'],
          ['email', 'password', 'code'],
        );
        const email = normalizeAccountIdentifier(body, 'email');
        await enforceRateLimit(req, options.rateLimiter, route, email);
        const password = requiredString(body, 'password');
        const code = requiredString(body, 'code');
        const login: PlatformAdminLogin | undefined = await options.service.login(email, password, code);
        if (!login) throw loginFailure();
        const token = login.token;
        const csrfToken = login.csrfToken;
        if (
          typeof token !== 'string' ||
          token.length === 0 ||
          typeof csrfToken !== 'string' ||
          csrfToken.length === 0
        ) {
          throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
        }
        sendJson(
          res,
          200,
          requestId,
          { session: publicSession(login.session), csrfToken },
          {
            'set-cookie': [
              ...expiredLegacyCookies(policy.secureCookies),
              sessionCookie(token, sessionTtlSeconds, policy.secureCookies),
              csrfCookie(csrfToken, sessionTtlSeconds, policy.secureCookies),
            ],
          },
        );
        return true;
      }

      if (route === 'session' && method === 'GET') {
        const { session } = await getAuthenticatedSession(req);
        sendJson(res, 200, requestId, { session: publicSession(session) });
        return true;
      }

      if (route === 'session' && method === 'DELETE') {
        requireWriteBoundary(req, policy);
        const { token } = await getAuthenticatedSession(req);
        await requireCsrf(req, token);
        try {
          await options.service.logout(token);
        } catch (error) {
          throw serviceError(error);
        }
        sendJson(res, 200, requestId, { loggedOut: true }, { 'set-cookie': expiredCookies(policy.secureCookies) });
        return true;
      }

      if (route === 'mfaStart' && method === 'POST') {
        const body = parseStrictObject(await readJson(req), ['issuer', 'token'], ['issuer']);
        const token = bearerOrBodyToken(req, body, 'token', 'MFA_ENROLLMENT_TOKEN_INVALID');
        const issuer = requiredString(body, 'issuer');
        let result: PlatformMfaEnrollmentStart;
        try {
          result = await options.service.beginMfaEnrollment(token, issuer);
        } catch (error) {
          throw serviceError(error);
        }
        if (
          typeof result.otpauthUri !== 'string' ||
          typeof result.confirmationToken !== 'string' ||
          typeof result.expiresAt !== 'string'
        ) {
          throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
        }
        sendJson(res, 200, requestId, {
          otpauthUri: result.otpauthUri,
          confirmationToken: result.confirmationToken,
          expiresAt: result.expiresAt,
        });
        return true;
      }

      if (route === 'mfaConfirm' && method === 'POST') {
        const body = parseStrictObject(await readJson(req), ['code', 'confirmationToken'], ['code']);
        const token = bearerOrBodyToken(req, body, 'confirmationToken', 'MFA_CONFIRMATION_INVALID');
        const code = requiredString(body, 'code');
        try {
          await options.service.confirmMfaEnrollment(token, code);
        } catch (error) {
          throw serviceError(error);
        }
        sendJson(res, 200, requestId, { confirmed: true });
        return true;
      }

      throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
    } catch (error) {
      if (isResponseClosed(res)) return true;
      const safeError = error instanceof HttpError ? error : serviceError(error);
      sendError(res, requestId, safeError);
      return true;
    }
  };
}
