import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { SaasIdentityRateLimiter } from '../http.js';
import type { OAuthLoginService } from './oauth-login-service.js';
import { OAuthLoginError, type OAuthLoginProvider } from './types.js';

const PREFIX = '/console/api/v1/auth/oauth';
const STATE_COOKIE_NAME = 'mr_saas_oauth_state';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const SESSION_COOKIE_PATH = '/console/api/v1';
const CSRF_COOKIE_PATH = '/console';
const STATE_COOKIE_PATH = '/console';
// The provider callback is a top-level cross-site GET redirect, so the state
// cookie must be SameSite=Lax (Strict would never reach the callback).
const STATE_COOKIE_MAX_AGE = 600;
const MAX_BODY_BYTES = 4096;

type Route = 'start' | 'callback' | 'completeRegistration' | 'completeAdoption';
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('OAuth login request rejected.');
  }
}

export interface OAuthLoginHttpOptions {
  readonly service: OAuthLoginService;
  readonly publicOrigin: string;
  readonly sessionTtlSeconds: number;
  readonly rateLimiter: SaasIdentityRateLimiter;
  /** Same effective Secure attribute as the existing identity cookie issuer. */
  readonly cookieSecure?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return undefined;
  const matches: string[] = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0 || trimmed.slice(0, separator) !== name) continue;
    matches.push(trimmed.slice(separator + 1));
  }
  if (matches.length !== 1) return undefined;
  try {
    return decodeURIComponent(matches[0]) || undefined;
  } catch {
    return undefined;
  }
}

function constantTimeMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new BoundaryError(400, 'INVALID_BODY');
  return value;
}

function reply(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  errorCode?: string,
  cookies?: string[],
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(cookies === undefined ? {} : { 'set-cookie': cookies }),
  });
  res.end(
    errorCode === undefined
      ? JSON.stringify({ data, meta: { requestId } })
      : JSON.stringify({
          error: { code: errorCode, message: 'The OAuth login request could not be completed.', requestId },
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
    if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
      throw new BoundaryError(400, 'INVALID_BODY');
    if (required.some((key) => !Object.hasOwn(value, key))) throw new BoundaryError(400, 'INVALID_BODY');
    for (const key of allowed) {
      if (!Object.hasOwn(value, key)) continue;
      const field = value[key];
      if (field === undefined && !required.includes(key)) continue;
      if (typeof field !== 'string' || field.length === 0 || Buffer.byteLength(field) > 1024) {
        throw new BoundaryError(400, 'INVALID_BODY');
      }
    }
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Match deployment's numeric loopback contract; never accept hostname prefixes.
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const normalized = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 6) return normalized === '::1';
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
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

function expiredStateCookie(secure: boolean): string {
  return [
    `${STATE_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${STATE_COOKIE_PATH}`,
    'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function stateCookie(state: string, secure: boolean): string {
  return [
    `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${STATE_COOKIE_PATH}`,
    `Max-Age=${STATE_COOKIE_MAX_AGE}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Provider-scoped start/callback plus the two pending-completion endpoints. */
export function createOAuthLoginHandler(options: OAuthLoginHttpOptions): HttpHandler {
  const url = new URL(options.publicOrigin);
  if (
    options.publicOrigin !== url.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    typeof options.service?.startLogin !== 'function' ||
    typeof options.rateLimiter?.take !== 'function' ||
    !Number.isSafeInteger(options.sessionTtlSeconds) ||
    options.sessionTtlSeconds < 1 ||
    options.sessionTtlSeconds > 30 * 24 * 60 * 60
  ) {
    throw new TypeError('Invalid OAuth login deployment configuration');
  }
  const secure = url.protocol === 'https:' || options.cookieSecure === true;
  const providerPattern = /^\/console\/api\/v1\/auth\/oauth\/(oidc|wechat)(\/(?:start|callback))?$/;

  const enforceRateLimit = async (req: IncomingMessage, scope: string): Promise<void> => {
    let retryAfter: number | undefined;
    try {
      retryAfter = await options.rateLimiter.take(
        createHash('sha256')
          .update('saas-identity:oauth-login:v1\0', 'utf8')
          .update(scope, 'utf8')
          .update('\0', 'utf8')
          .update('source', 'utf8')
          .update('\0', 'utf8')
          .update(req.socket.remoteAddress ?? 'unknown-peer', 'utf8')
          .digest('hex'),
      );
    } catch {
      throw new BoundaryError(503, 'UNAVAILABLE');
    }
    if (retryAfter === undefined) return;
    if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) throw new BoundaryError(503, 'UNAVAILABLE');
    throw new BoundaryError(429, 'RATE_LIMITED');
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestId = randomUUID();
    let path: URL;
    try {
      path = new URL(req.url ?? '/', url.origin);
    } catch {
      return false;
    }
    const match = providerPattern.exec(path.pathname);
    let route: Route | undefined;
    let provider: OAuthLoginProvider | undefined;
    if (path.pathname === `${PREFIX}/complete-registration`) {
      route = 'completeRegistration';
    } else if (path.pathname === `${PREFIX}/complete-adoption`) {
      route = 'completeAdoption';
    } else if (match?.[1] !== undefined && match[2] === '/start') {
      route = 'start';
      provider = match[1] as OAuthLoginProvider;
    } else if (match?.[1] !== undefined && match[2] === '/callback') {
      route = 'callback';
      provider = match[1] as OAuthLoginProvider;
    }
    if (route === undefined || path.origin !== url.origin || path.hash) return false;
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== (route === 'callback' ? 'GET' : 'POST')) throw new BoundaryError(405, 'METHOD_NOT_ALLOWED');
      if (req.headers.host !== url.host) throw new BoundaryError(403, 'HOST_REJECTED');
      if (route !== 'callback') {
        // Same-origin write boundary, mirroring the identity session contract.
        if (req.headers.origin !== url.origin) throw new BoundaryError(403, 'ORIGIN_REJECTED');
      } else if (req.headers.origin !== undefined && req.headers.origin !== url.origin) {
        throw new BoundaryError(403, 'ORIGIN_REJECTED');
      }
      await enforceRateLimit(req, route);

      if (route === 'start') {
        const input = await body(req, ['redirectUri'], ['redirectUri']);
        const started = await options.service.startLogin(provider as OAuthLoginProvider, text(input.redirectUri));
        reply(res, 200, requestId, { authorizeUrl: started.authorizeUrl }, undefined, [
          stateCookie(started.state, secure),
        ]);
        return true;
      }

      if (route === 'callback') {
        const params = path.searchParams;
        if (
          [...params.keys()].some((key) => key !== 'code' && key !== 'state') ||
          params.getAll('code').length !== 1 ||
          params.getAll('state').length !== 1
        ) {
          throw new BoundaryError(400, 'INVALID_PATH');
        }
        const queryState = params.get('state');
        const code = params.get('code');
        if (!queryState || !code) throw new BoundaryError(400, 'INVALID_PATH');
        // Defense in depth: the cookie copy must constant-time match the query
        // copy before the service validates its single-use server-side state.
        const cookieState = cookie(req, STATE_COOKIE_NAME);
        if (!cookieState || !constantTimeMatches(cookieState, queryState)) {
          throw new BoundaryError(400, 'STATE_INVALID');
        }
        const completion = await options.service.completeLogin(provider as OAuthLoginProvider, {
          state: queryState,
          code,
        });
        if (completion.kind === 'authenticated') {
          reply(res, 200, requestId, { status: 'authenticated', session: completion.session }, undefined, [
            ...sessionCookies(completion.token, completion.csrfToken, options.sessionTtlSeconds, secure),
            expiredStateCookie(secure),
          ]);
          return true;
        }
        const data: Record<string, unknown> = { kind: completion.kind, pendingToken: completion.pendingToken };
        if (completion.email !== undefined) data.email = completion.email;
        reply(res, 200, requestId, data, undefined, [expiredStateCookie(secure)]);
        return true;
      }

      if (route === 'completeRegistration') {
        const input = await body(req, ['pendingToken', 'password', 'displayName'], ['pendingToken', 'password']);
        const session = await options.service.completeRegistration(text(input.pendingToken), {
          password: text(input.password),
          ...(input.displayName === undefined ? {} : { displayName: text(input.displayName) }),
        });
        reply(
          res,
          201,
          requestId,
          { session: session.session },
          undefined,
          sessionCookies(session.token, session.csrfToken, options.sessionTtlSeconds, secure),
        );
        return true;
      }

      const input = await body(req, ['pendingToken', 'password'], ['pendingToken', 'password']);
      const session = await options.service.completeAdoption(text(input.pendingToken), {
        password: text(input.password),
      });
      reply(
        res,
        200,
        requestId,
        { session: session.session },
        undefined,
        sessionCookies(session.token, session.csrfToken, options.sessionTtlSeconds, secure),
      );
      return true;
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        if (error instanceof BoundaryError) reply(res, error.status, requestId, null, error.code);
        else if (error instanceof OAuthLoginError) reply(res, error.status, requestId, null, error.code);
        else reply(res, 503, requestId, null, 'UNAVAILABLE');
      }
      return true;
    }
  };
}
