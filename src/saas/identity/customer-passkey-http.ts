import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  CustomerPasskeyError,
  type CustomerPasskeyOperations,
  type CustomerPasskeySessionProof,
} from './customer-passkey-types.js';
import type { SaasIdentityRateLimiter } from './http.js';
import type { SaasIdentityService } from './service.js';

const PREFIX = '/console/api/v1/auth/passkey';
type Route = 'list' | 'registrationStart' | 'registrationFinish' | 'assertionStart' | 'assertionFinish' | 'remove';
class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('Customer passkey request rejected.');
  }
}
interface CustomerPasskeyHttpBoundaryOptions {
  readonly publicOrigin: string;
  /** Same effective Secure attribute as the existing identity cookie issuer. */
  readonly cookieSecure?: boolean;
  /** Existing managed shared source limiter; ceremonies add their own attempt caps. */
  readonly rateLimiter: SaasIdentityRateLimiter;
}
export type CustomerPasskeyHttpOptions = CustomerPasskeyHttpBoundaryOptions &
  (
    | { readonly service: CustomerPasskeyOperations; readonly sessionAuthority?: never }
    | {
        readonly service?: undefined;
        readonly sessionAuthority: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken'>;
      }
  );
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function cookie(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) throw new BoundaryError(401, 'UNAUTHENTICATED');
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.slice(0, p.indexOf('=')) === name);
  if (parts.length !== 1) throw new BoundaryError(401, 'UNAUTHENTICATED');
  let value: string;
  try {
    value = decodeURIComponent((parts[0] ?? '').slice(name.length + 1));
  } catch {
    throw new BoundaryError(401, 'UNAUTHENTICATED');
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) throw new BoundaryError(401, 'UNAUTHENTICATED');
  return value;
}
function sessionProof(req: IncomingMessage): CustomerPasskeySessionProof {
  const sessionToken = cookie(req, 'mr_saas_session'),
    csrfToken = cookie(req, 'mr_saas_csrf');
  const supplied = req.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) > 256) throw new BoundaryError(403, 'CSRF_REJECTED');
  const a = Buffer.from(supplied),
    b = Buffer.from(csrfToken);
  try {
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BoundaryError(403, 'CSRF_REJECTED');
  } finally {
    a.fill(0);
    b.fill(0);
  }
  return { sessionToken, csrfToken, requestId: randomUUID() };
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max)
    throw new BoundaryError(400, 'INVALID_BODY');
  return value;
}
function credential(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((k) => !keys.includes(k))) throw new BoundaryError(400, 'INVALID_BODY');
  for (const key of keys) {
    if (key === 'userHandle') {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')
        throw new BoundaryError(400, 'INVALID_BODY');
      continue;
    }
    if (typeof value[key] !== 'string' || !value[key]) throw new BoundaryError(400, 'INVALID_BODY');
  }
  return value;
}
const BODY_KEYS: Record<Exclude<Route, 'list'>, readonly string[]> = {
  registrationStart: ['password', 'currentTotpCode'],
  registrationFinish: ['password', 'currentTotpCode', 'challenge', 'credential'],
  assertionStart: ['password', 'credentialId'],
  assertionFinish: ['password', 'challenge', 'credential'],
  remove: ['password', 'currentTotpCode', 'credentialId'],
};
async function body(req: IncomingMessage, route: Exclude<Route, 'list'>): Promise<Record<string, unknown>> {
  if (
    typeof req.headers['content-type'] !== 'string' ||
    !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'])
  )
    throw new BoundaryError(415, 'JSON_REQUIRED');
  const length = req.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 16384))
    throw new BoundaryError(413, 'BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let joined: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<unknown> => {
      let size = 0;
      for await (const chunk of req) {
        if (!(chunk instanceof Uint8Array)) throw new BoundaryError(400, 'INVALID_BODY');
        const copy = Buffer.from(chunk);
        chunks.push(copy);
        size += copy.length;
        if (size > 16384) throw new BoundaryError(413, 'BODY_TOO_LARGE');
      }
      joined = Buffer.concat(chunks);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown;
      } catch {
        throw new BoundaryError(400, 'INVALID_BODY');
      }
    };
    const value = await Promise.race([
      read(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          req.destroy();
          reject(new BoundaryError(408, 'BODY_TIMEOUT'));
        }, 5000);
        timer.unref();
      }),
    ]);
    if (!record(value) || Object.keys(value).some((k) => !BODY_KEYS[route].includes(k)))
      throw new BoundaryError(400, 'INVALID_BODY');
    if (typeof value.password !== 'string' || !value.password.length || Buffer.byteLength(value.password) > 1024)
      throw new BoundaryError(400, 'INVALID_BODY');
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    joined?.fill(0);
    for (const c of chunks) c.fill(0);
  }
}
function reply(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  errorCode?: string,
  cookies?: string[],
  availability?: 'deployment-unavailable-v1',
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(cookies ? { 'set-cookie': cookies } : {}),
  });
  res.end(
    JSON.stringify(
      errorCode
        ? {
            error: {
              code: errorCode,
              message: 'The customer passkey request could not be completed.',
              requestId,
              ...(availability === undefined ? {} : { availability }),
            },
          }
        : { data, meta: { requestId } },
    ),
  );
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
export function createCustomerPasskeyHandler(options: CustomerPasskeyHttpOptions) {
  const url = new URL(options.publicOrigin);
  if (
    options.publicOrigin !== url.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    typeof options.rateLimiter?.take !== 'function' ||
    (options.service === undefined &&
      (typeof options.sessionAuthority?.getSession !== 'function' ||
        typeof options.sessionAuthority.verifyCsrfToken !== 'function'))
  )
    throw new TypeError('Invalid customer passkey deployment configuration');
  const secure = url.protocol === 'https:' || options.cookieSecure === true ? '; Secure' : '';
  const expiry = `; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
  const expiredCookies = [
    `mr_saas_session=; HttpOnly; SameSite=Strict; Path=/console/api/v1${expiry}`,
    `mr_saas_csrf=; SameSite=Strict; Path=/console${expiry}`,
    `mr_saas_csrf=; SameSite=Strict; Path=/console/api/v1${expiry}`,
  ];
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestId = randomUUID();
    let path: URL;
    try {
      path = new URL(req.url ?? '/', url.origin);
    } catch {
      return false;
    }
    const route: Route | undefined =
      path.pathname === PREFIX
        ? 'list'
        : path.pathname === `${PREFIX}/registration/start`
          ? 'registrationStart'
          : path.pathname === `${PREFIX}/registration/finish`
            ? 'registrationFinish'
            : path.pathname === `${PREFIX}/assertion/start`
              ? 'assertionStart'
              : path.pathname === `${PREFIX}/assertion/finish`
                ? 'assertionFinish'
                : path.pathname === `${PREFIX}/remove`
                  ? 'remove'
                  : undefined;
    if (!route) return false;
    try {
      if (path.origin !== url.origin || path.search || path.hash) throw new BoundaryError(400, 'INVALID_PATH');
      if ((req.method ?? 'GET') !== (route === 'list' ? 'GET' : 'POST'))
        throw new BoundaryError(405, 'METHOD_NOT_ALLOWED');
      if (
        req.headers.host !== url.host ||
        (route === 'list'
          ? req.headers.origin !== undefined && req.headers.origin !== url.origin
          : req.headers.origin !== url.origin)
      )
        throw new BoundaryError(403, 'ORIGIN_REJECTED');
      let limited: number | undefined;
      try {
        limited = await options.rateLimiter.take(
          createHash('sha256')
            .update('customer-passkey:source:v1\0')
            .update(req.socket.remoteAddress ?? 'unknown')
            .digest('hex'),
        );
      } catch {
        throw new BoundaryError(503, 'UNAVAILABLE');
      }
      if (limited !== undefined) {
        if (!Number.isSafeInteger(limited) || limited < 1) throw new BoundaryError(503, 'UNAVAILABLE');
        throw new BoundaryError(429, 'RATE_LIMITED');
      }
      const proof = sessionProof(req);
      if (options.service === undefined) {
        // Existing live identity tables only. Missing schema never becomes a
        // synthetic passkey list, readiness success or a permissive service port.
        const authority = options.sessionAuthority;
        if (!(await authority.getSession(proof.sessionToken))) throw new BoundaryError(401, 'UNAUTHENTICATED');
        if (!(await authority.verifyCsrfToken(proof.sessionToken, proof.csrfToken)))
          throw new BoundaryError(403, 'CSRF_REJECTED');
        // Do not read, retain or reflect passwords/challenges from an unavailable POST.
        if (route !== 'list') res.setHeader('connection', 'close');
        reply(res, 503, requestId, null, 'UNAVAILABLE', undefined, 'deployment-unavailable-v1');
        return true;
      }
      if (route === 'list') {
        const value = await options.service.list(proof);
        reply(res, 200, requestId, { passkeys: value.passkeys });
        return true;
      }
      const object = await body(req, route);
      try {
        const totp = object.currentTotpCode === undefined ? {} : { currentTotpCode: text(object.currentTotpCode, 256) };
        if (route === 'registrationStart') {
          const value = await options.service.startRegistration(proof, { password: text(object.password), ...totp });
          reply(res, 201, requestId, value);
        } else if (route === 'registrationFinish') {
          const cred = credential(object.credential, ['id', 'clientDataJSON', 'attestationObject']);
          const value = await options.service.finishRegistration(proof, {
            password: text(object.password),
            ...totp,
            challenge: text(object.challenge, 256),
            credential: {
              id: text(cred.id, 1400),
              clientDataJSON: text(cred.clientDataJSON, 4096),
              attestationObject: text(cred.attestationObject, 5500),
            },
          });
          reply(res, 200, requestId, value, undefined, expiredCookies);
        } else if (route === 'assertionStart') {
          const value = await options.service.startAssertion(proof, {
            password: text(object.password),
            credentialId: text(object.credentialId, 1400),
          });
          reply(res, 201, requestId, value);
        } else if (route === 'assertionFinish') {
          const cred = credential(object.credential, [
            'id',
            'clientDataJSON',
            'authenticatorData',
            'signature',
            'userHandle',
          ]);
          const value = await options.service.finishAssertion(proof, {
            password: text(object.password),
            challenge: text(object.challenge, 256),
            credential: {
              id: text(cred.id, 1400),
              clientDataJSON: text(cred.clientDataJSON, 4096),
              authenticatorData: text(cred.authenticatorData, 5500),
              signature: text(cred.signature, 5500),
              ...(cred.userHandle === undefined
                ? {}
                : { userHandle: cred.userHandle === null ? null : text(cred.userHandle, 128) }),
            },
          });
          reply(res, 200, requestId, value);
        } else {
          const value = await options.service.remove(proof, {
            password: text(object.password),
            ...totp,
            credentialId: text(object.credentialId, 1400),
          });
          reply(res, 200, requestId, value, undefined, expiredCookies);
        }
      } finally {
        for (const key of Object.keys(object)) object[key] = undefined;
      }
      return true;
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        if (error instanceof BoundaryError) reply(res, error.status, requestId, null, error.code);
        else if (error instanceof CustomerPasskeyError) reply(res, error.status, requestId, null, error.code);
        else reply(res, 503, requestId, null, 'UNAVAILABLE');
      }
      return true;
    }
  };
}
