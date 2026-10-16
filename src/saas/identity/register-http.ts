import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { EmailVerificationError } from './email-verification-service.js';
import type { SaasIdentityRateLimiter } from './http.js';
import type { RegistrationService } from './register-service.js';
import { RegistrationError } from './register-service.js';

/**
 * R4 registration admission (plan §R4): the public auth boundary for
 * registration and password reset, following the oauth-login-http.ts
 * dispatch conventions (strict JSON bodies, same-origin writes, host pinning,
 * shared per-scope rate limiting, opaque limiter keys, constant reply shape).
 *
 * Routes (all under /console/api/v1/auth):
 *   GET  /register                     — public admission descriptor
 *   POST /register/send-code           — issue a registration email code
 *   POST /register                     — create the account (+ session)
 *   POST /password-reset/send-code     — issue a password-reset email code
 *   POST /password-reset/confirm       — verify code, set new password
 *
 * Code-send endpoints carry a dedicated 2-per-30-seconds per-IP fixed window
 * (new-api rule) on top of the shared customer-auth limiter; an injected
 * Redis-backed limiter is used when available, otherwise a bounded
 * process-local window (PG cooldown stays the authoritative same-email guard).
 */

const PREFIX = '/console/api/v1/auth';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const SESSION_COOKIE_PATH = '/console/api/v1';
const CSRF_COOKIE_PATH = '/console';
const MAX_BODY_BYTES = 4096;
const SEND_WINDOW_MS = 30_000;
const SEND_WINDOW_LIMIT = 2;
const MAX_LIMITER_KEYS = 10_000;

type Route = 'registerOptions' | 'registerSendCode' | 'register' | 'passwordResetSendCode' | 'passwordResetConfirm';
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super('Registration request rejected.');
  }
}

export interface RegistrationHttpOptions {
  readonly service: RegistrationService;
  readonly publicOrigin: string;
  readonly sessionTtlSeconds: number;
  readonly rateLimiter: SaasIdentityRateLimiter;
  /** Dedicated 2/30s per-IP limiter for code-send endpoints (Redis-backed when injected). */
  readonly sendRateLimiter?: SaasIdentityRateLimiter;
  /** Same effective Secure attribute as the existing identity cookie issuer. */
  readonly cookieSecure?: boolean;
}

function peerAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown-peer';
}

function opaqueLimiterKey(scope: string, peer: string): string {
  return createHash('sha256')
    .update('saas-identity:registration:v1\0', 'utf8')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update('source', 'utf8')
    .update('\0', 'utf8')
    .update(peer, 'utf8')
    .digest('hex');
}

/** Bounded process-local fixed window (the identity http.ts compatibility shape). */
class BoundedSendLimiter {
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

function reply(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  errorCode?: string,
  cookies?: string[],
  retryAfterSeconds?: number,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
    ...(cookies === undefined ? {} : { 'set-cookie': cookies }),
  });
  res.end(
    errorCode === undefined
      ? JSON.stringify({ data, meta: { requestId } })
      : JSON.stringify({
          error: { code: errorCode, message: 'The registration request could not be completed.', requestId },
        }),
  );
}

async function body(
  req: IncomingMessage,
  allowed: readonly string[],
  required: readonly string[],
): Promise<Record<string, unknown>> {
  if (
    typeof req.headers['content-type'] !== 'string' ||
    !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'])
  ) {
    throw new BoundaryError(415, 'JSON_REQUIRED');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<unknown> => {
      for await (const chunk of req) {
        const copy = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += copy.length;
        if (size > MAX_BODY_BYTES) throw new BoundaryError(413, 'BODY_TOO_LARGE');
        chunks.push(copy);
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
      } catch {
        throw new BoundaryError(400, 'INVALID_BODY');
      }
    };
    const value = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          req.destroy();
          reject(new BoundaryError(408, 'BODY_TIMEOUT'));
        }, 5000);
        timer.unref();
      }),
    ]);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BoundaryError(400, 'INVALID_BODY');
    }
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BoundaryError(400, 'INVALID_BODY');
    if (required.some((key) => !Object.hasOwn(object, key))) throw new BoundaryError(400, 'INVALID_BODY');
    for (const key of allowed) {
      if (!Object.hasOwn(object, key)) continue;
      const field = object[key];
      if (field === undefined && !required.includes(key)) continue;
      if (typeof field !== 'string' || field.length === 0 || Buffer.byteLength(field) > 1024) {
        throw new BoundaryError(400, 'INVALID_BODY');
      }
    }
    return object;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new BoundaryError(400, 'INVALID_BODY');
  return value;
}

function sessionCookies(token: string, csrfToken: string, ttlSeconds: number, secure: boolean): string[] {
  return [
    [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Strict',
      `Path=${SESSION_COOKIE_PATH}`,
      `Max-Age=${ttlSeconds}`,
      ...(secure ? ['Secure'] : []),
    ].join('; '),
    [
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
      'SameSite=Strict',
      `Path=${CSRF_COOKIE_PATH}`,
      `Max-Age=${ttlSeconds}`,
      ...(secure ? ['Secure'] : []),
    ].join('; '),
  ];
}

/** Match deployment's numeric loopback contract; never accept hostname prefixes. */
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const normalized = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 6) return normalized === '::1';
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

/** Public registration, code-send and password-reset boundary. */
export function createRegistrationHandler(options: RegistrationHttpOptions): HttpHandler {
  const url = new URL(options.publicOrigin);
  if (
    options.publicOrigin !== url.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    typeof options.service?.register !== 'function' ||
    typeof options.rateLimiter?.take !== 'function' ||
    !Number.isSafeInteger(options.sessionTtlSeconds) ||
    options.sessionTtlSeconds < 1 ||
    options.sessionTtlSeconds > 30 * 24 * 60 * 60
  ) {
    throw new TypeError('Invalid registration deployment configuration');
  }
  const secure = url.protocol === 'https:' || options.cookieSecure === true;
  const compatibilitySendLimiter = new BoundedSendLimiter(SEND_WINDOW_LIMIT, SEND_WINDOW_MS);
  const sendRateLimiter: SaasIdentityRateLimiter = options.sendRateLimiter ?? {
    take: async (key) => compatibilitySendLimiter.take(key),
  };

  const routes: ReadonlyMap<string, Route> = new Map([
    [`${PREFIX}/register`, 'register'],
    [`${PREFIX}/register/send-code`, 'registerSendCode'],
    [`${PREFIX}/password-reset/send-code`, 'passwordResetSendCode'],
    [`${PREFIX}/password-reset/confirm`, 'passwordResetConfirm'],
  ]);

  const enforceRateLimit = async (req: IncomingMessage, scope: string): Promise<void> => {
    let retryAfter: number | undefined;
    try {
      retryAfter = await options.rateLimiter.take(opaqueLimiterKey(scope, peerAddress(req)));
    } catch {
      throw new BoundaryError(503, 'UNAVAILABLE');
    }
    if (retryAfter === undefined) return;
    if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) throw new BoundaryError(503, 'UNAVAILABLE');
    throw new BoundaryError(429, 'RATE_LIMITED', retryAfter);
  };

  const enforceSendRateLimit = async (req: IncomingMessage, scope: string): Promise<void> => {
    let retryAfter: number | undefined;
    try {
      retryAfter = await sendRateLimiter.take(opaqueLimiterKey(scope, peerAddress(req)));
    } catch {
      throw new BoundaryError(503, 'UNAVAILABLE');
    }
    if (retryAfter === undefined) return;
    if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) throw new BoundaryError(503, 'UNAVAILABLE');
    throw new BoundaryError(429, 'RATE_LIMITED', retryAfter);
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestId = randomUUID();
    let path: URL;
    try {
      path = new URL(req.url ?? '/', url.origin);
    } catch {
      return false;
    }
    if (path.origin !== url.origin || path.hash || path.search) return false;

    let route: Route | undefined;
    if (path.pathname === `${PREFIX}/register/options`) {
      route = 'registerOptions';
    } else {
      route = routes.get(path.pathname);
    }
    if (route === undefined) return false;

    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== (route === 'registerOptions' ? 'GET' : 'POST')) {
        throw new BoundaryError(405, 'METHOD_NOT_ALLOWED');
      }
      if (req.headers.host !== url.host) throw new BoundaryError(403, 'HOST_REJECTED');
      if (route !== 'registerOptions') {
        // Same-origin write boundary, mirroring the identity session contract.
        if (req.headers.origin !== url.origin) throw new BoundaryError(403, 'ORIGIN_REJECTED');
      }

      if (route === 'registerOptions') {
        // F1: store-first resolution so the advertised mode always matches the
        // admission decisions the register endpoints actually enforce.
        reply(res, 200, requestId, await options.service.resolveAdmissionDescriptor());
        return true;
      }

      await enforceRateLimit(req, route);
      const remoteIp = peerAddress(req);

      if (route === 'registerSendCode' || route === 'passwordResetSendCode') {
        await enforceSendRateLimit(req, route);
        const input = await body(req, ['email'], ['email']);
        if (route === 'registerSendCode') {
          await options.service.sendRegistrationCode({ email: text(input.email), createdIp: remoteIp });
        } else {
          await options.service.requestPasswordResetCode({ email: text(input.email), createdIp: remoteIp });
        }
        reply(res, 200, requestId, { sent: true });
        return true;
      }

      if (route === 'register') {
        const input = await body(
          req,
          ['email', 'password', 'displayName', 'verificationCode', 'inviteCode', 'captchaToken'],
          ['email', 'password'],
        );
        const session = await options.service.register({
          email: text(input.email),
          password: text(input.password),
          ...(input.displayName === undefined ? {} : { displayName: text(input.displayName) }),
          ...(input.verificationCode === undefined ? {} : { verificationCode: text(input.verificationCode) }),
          ...(input.inviteCode === undefined ? {} : { inviteCode: text(input.inviteCode) }),
          ...(input.captchaToken === undefined ? {} : { captchaToken: text(input.captchaToken) }),
          remoteIp,
        });
        reply(res, 201, requestId, { session: session.session }, undefined, [
          ...sessionCookies(session.token, session.csrfToken, options.sessionTtlSeconds, secure),
        ]);
        return true;
      }

      const input = await body(req, ['email', 'code', 'newPassword', 'captchaToken'], ['email', 'code', 'newPassword']);
      // Always run the proof: an enabled backend fails closed on a missing
      // token; the disabled backend passes through.
      if (
        !(await options.service.verifyCaptcha({
          ...(input.captchaToken === undefined ? {} : { token: text(input.captchaToken) }),
          remoteIp,
        }))
      ) {
        throw new RegistrationError(403, 'CAPTCHA_REJECTED');
      }
      await options.service.confirmPasswordReset({
        email: text(input.email),
        code: text(input.code),
        newPassword: text(input.newPassword),
      });
      reply(res, 200, requestId, { reset: true });
      return true;
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        if (error instanceof BoundaryError) {
          reply(res, error.status, requestId, null, error.code, undefined, error.retryAfterSeconds);
        } else if (error instanceof RegistrationError) {
          reply(res, error.status, requestId, null, error.code);
        } else if (error instanceof EmailVerificationError) {
          reply(
            res,
            error.status,
            requestId,
            null,
            error.code === 'CODE_INVALID' ? 'VERIFICATION_CODE_INVALID' : error.code,
            undefined,
            error.retryAfterSeconds,
          );
        } else {
          reply(res, 503, requestId, null, 'UNAVAILABLE');
        }
      }
      return true;
    }
  };
}
