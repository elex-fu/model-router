import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';
import type { PlatformCredentialRewrapOperations } from './credential-rewrap-operations.js';

const ROUTE_PREFIX = '/admin/api/v1/supply/accounts/';
const MAX_ID_LENGTH = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface PlatformCredentialRewrapHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly operations: PlatformCredentialRewrapOperations;
  readonly publicOrigin: string;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
}

export type PlatformCredentialRewrapHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface Route {
  readonly accountId: string;
  readonly credentialId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'PlatformCredentialRewrapHttpError';
  }
}

function parsePath(pathname: string): Route | undefined {
  if (!pathname.startsWith(ROUTE_PREFIX)) return undefined;
  const parts = pathname.slice(ROUTE_PREFIX.length).split('/');
  if (parts.length !== 4 || parts[1] !== 'credentials' || parts[3] !== 'rewrap') return undefined;
  const [encodedAccountId, , encodedCredentialId] = parts;
  if (!encodedAccountId || !encodedCredentialId)
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid');
  return {
    accountId: pathIdentifier(encodedAccountId),
    credentialId: pathIdentifier(encodedCredentialId),
  };
}

function pathIdentifier(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid');
  }
  if (
    decoded.length > MAX_ID_LENGTH ||
    decoded.trim() === '' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    [...decoded].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid');
  }
  return decoded;
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
  let expected: URL;
  try {
    expected = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, 'REWRAP_UNAVAILABLE', 'Credential rewrapping is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: PlatformCredentialRewrapHttpOptions['authService'],
): Promise<void> {
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is not valid JSON');
  }
}

function bodyInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid revision metadata');
  }
  return value;
}

function requestMetadata(req: IncomingMessage): {
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
} {
  const remoteAddress = req.socket?.remoteAddress;
  const sourceIp = typeof remoteAddress === 'string' && isIP(remoteAddress) !== 0 ? remoteAddress : null;
  const userAgent = req.headers['user-agent'];
  const normalized = typeof userAgent === 'string' ? userAgent.trim() : '';
  return {
    sourceIp,
    userAgent:
      normalized.length > 0 && ![...normalized].some((character) => character.charCodeAt(0) <= 0x1f)
        ? normalized.slice(0, 512)
        : null,
  };
}

function positiveRevision(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function operationErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function createPlatformCredentialRewrapHttpHandler(
  options: PlatformCredentialRewrapHttpOptions,
): PlatformCredentialRewrapHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options.operations) throw new TypeError('rewrap operations are required');
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }

  return async (req, res) => {
    let route: Route | undefined;
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      route = parsePath(url.pathname);
      if (!route) return false;
      if (url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        req.resume();
        res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }),
        );
        return true;
      }
      if (method === 'POST') requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      if (method === 'GET') {
        const status = await options.operations.getStatus(route.accountId, route.credentialId);
        sendJson(res, 200, requestId, {
          state: status.state,
          credentialVersion: positiveRevision(status.credentialVersion),
          wrappingRevision: positiveRevision(status.wrappingRevision),
        });
        return true;
      }

      await requireCsrf(req, options.authService);
      const raw = await readJson(req);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body is invalid');
      }
      const body = raw as Record<string, unknown>;
      if (Object.keys(body).some((key) => key !== 'expectedVersion' && key !== 'expectedWrappingRevision')) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains unsupported fields');
      }
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
      }
      const metadata = requestMetadata(req);
      const result = await options.operations.rewrap({
        accountId: route.accountId,
        credentialId: route.credentialId,
        expectedVersion: bodyInteger(body, 'expectedVersion'),
        expectedWrappingRevision: bodyInteger(body, 'expectedWrappingRevision'),
        operationId: idempotencyKey,
        actorUserId: actor.userId,
        ...metadata,
      });
      sendJson(res, 200, requestId, {
        state: result.outcome,
        credentialVersion: positiveRevision(result.credentialVersion),
        expectedWrappingRevision: positiveRevision(result.expectedWrappingRevision),
        wrappingRevision: positiveRevision(result.wrappingRevision),
        refreshRequired: result.refreshRequired,
      });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
      } else {
        const code = operationErrorCode(error);
        if (code === 'NOT_FOUND' || code === 'CREDENTIAL_NOT_FOUND') {
          sendError(res, 404, requestId, 'CREDENTIAL_NOT_FOUND', 'The platform credential was not found');
        } else {
          sendError(res, 503, requestId, 'REWRAP_UNAVAILABLE', 'Credential rewrapping could not be completed');
        }
      }
      return true;
    }
  };
}
