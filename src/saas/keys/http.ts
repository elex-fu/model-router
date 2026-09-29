import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { SupplyMode } from '../gateway/contracts.js';
import type { SaasIdentityService } from '../identity/service.js';
import type { TenantContext } from '../identity/types.js';
import type { KeyService } from './service.js';
import type { ApiKeyMetadata, ApiKeyPrincipalKind, CreateApiKeyInput, CreatedApiKey } from './types.js';

const API_PREFIX = '/console/api/v1';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const MAX_BODY_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;

export type SaasKeyHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface SaasKeyHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken' | 'authorizeProjectAccess'>;
  readonly keyService?: Pick<KeyService, 'create' | 'list' | 'rotate' | 'revoke'>;
  readonly publicOrigin: string;
  readonly cookieSecure?: boolean;
  /** Accepted for composition compatibility; key routes do not issue sessions. */
  readonly sessionTtlSeconds?: number;
}

type KeyRoute = 'projectKeys' | 'keyRotate' | 'keyRevoke';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaasKeyHttpError';
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringField(value: unknown, name: string): string | undefined {
  const candidate = asObject(value)?.[name];
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined;
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

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_BODY', `${name} is required`);
  }
  return value;
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

function principalKind(value: unknown): ApiKeyPrincipalKind {
  if (value === undefined) return 'member';
  if (value !== 'member' && value !== 'project_service') {
    throw new HttpError(400, 'INVALID_BODY', 'principalKind must be member or project_service');
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
      req.resume();
      throw new HttpError(400, 'INVALID_BODY', 'The request body is invalid');
    }
    if (Number(rawLength) > MAX_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
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
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

async function readEmptyJsonObject(req: IncomingMessage): Promise<void> {
  const contentLength = req.headers['content-length'];
  const hasTransferEncoding = typeof req.headers['transfer-encoding'] === 'string';
  if (contentLength === '0' && !hasTransferEncoding) return;
  if (contentLength === undefined && !hasTransferEncoding && req.headers['content-type'] === undefined) return;
  parseStrictObject(await readJson(req), [], []);
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
    case 503:
      return new HttpError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable');
    default:
      return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    matches.push(part.slice(separator + 1).trim());
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
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
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
  if (typeof req.headers.host !== 'string') {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (req.headers.host !== host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
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

function routePath(req: IncomingMessage, origin: string): string | undefined {
  try {
    return new URL(req.url ?? '/', origin).pathname;
  } catch {
    return undefined;
  }
}

function findRoute(
  path: string,
):
  | { route: 'projectKeys'; tenantId: string; projectId: string }
  | { route: 'keyRotate' | 'keyRevoke'; tenantId: string; projectId: string; keyId: string }
  | undefined {
  const match = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/projects/([^/]+)/keys(?:/([^/]+)/(rotate|revoke))?$`).exec(
    path,
  );
  if (!match) return undefined;
  const tenantId = pathIdentifier(match[1], 'tenant');
  const projectId = pathIdentifier(match[2], 'project');
  if (!match[3]) return { route: 'projectKeys', tenantId, projectId };
  const keyId = pathIdentifier(match[3], 'key');
  return { route: match[4] === 'rotate' ? 'keyRotate' : 'keyRevoke', tenantId, projectId, keyId };
}

function publicApiKey(value: ApiKeyMetadata | CreatedApiKey): JsonObject {
  const data: JsonObject = {
    id: value.id,
    tenantId: value.tenantId,
    projectId: value.projectId,
    principalUserId: value.principalUserId,
    executionPrincipalType: value.executionPrincipalType,
    executionPrincipalId: value.executionPrincipalId,
    createdByUserId: value.createdByUserId,
    rotatedByUserId: value.rotatedByUserId,
    revokedByUserId: value.revokedByUserId,
    entitlementId: value.entitlementId,
    supplyProfileId: value.supplyProfileId,
    supplyMode: value.supplyMode,
    name: value.name,
    prefix: value.prefix,
    modelScopes: [...value.modelScopes],
    status: value.status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
    lastUsedAt: value.lastUsedAt,
    authzVersion: value.authzVersion,
    modelScopeVersion: value.modelScopeVersion,
    entitlementAuthzVersion: value.entitlementAuthzVersion,
    supplyProfileAuthzVersion: value.supplyProfileAuthzVersion,
  };
  if ('secret' in value) data.secret = value.secret;
  return data;
}

function requestMethodError(res: ServerResponse, requestId: string, methods: readonly string[]): void {
  const error = new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint');
  sendError(res, requestId, error, { allow: methods.join(', ') });
}

export function createSaasKeyHandler(options: SaasKeyHttpOptions): SaasKeyHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;
  const keyService = options.keyService;

  const getSession = async (req: IncomingMessage): Promise<{ token: string; session: unknown }> => {
    const token = cookieValue(req, SESSION_COOKIE_NAME);
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    const session = await options.service.getSession(token);
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return { token, session };
  };

  const requireCsrf = async (req: IncomingMessage, token: string): Promise<void> => {
    requireSameOrigin(req, expectedOrigin);
    const cookieToken = cookieValue(req, CSRF_COOKIE_NAME);
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

  const authorize = async (session: unknown, tenantId: string, projectId: string): Promise<TenantContext> =>
    options.service.authorizeProjectAccess({ userId: requireUserId(session), tenantId, projectId });

  return async (req, res) => {
    const requestId = `saas_key_${randomUUID()}`;
    try {
      const path = routePath(req, expectedOrigin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      if (!path.startsWith(`${API_PREFIX}/`)) return false;
      const match = findRoute(path);
      if (!match) return false;

      const method = (req.method ?? 'GET').toUpperCase();
      const methods: Record<KeyRoute, readonly string[]> = {
        projectKeys: ['GET', 'POST'],
        keyRotate: ['POST'],
        keyRevoke: ['POST'],
      };
      if (!methods[match.route].includes(method)) {
        requestMethodError(res, requestId, methods[match.route]);
        return true;
      }

      if (method === 'POST') requireWriteBoundary(req, expectedOrigin, expectedHost);
      const { token, session } = await getSession(req);
      if (method !== 'GET') await requireCsrf(req, token);
      if (!keyService) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'The key service is unavailable');

      if (match.route === 'projectKeys' && method === 'POST') {
        const body = parseStrictObject(
          await readJson(req),
          ['name', 'modelScopes', 'supplyMode', 'principalKind', 'expiresAt'],
          ['name', 'modelScopes', 'supplyMode'],
        );
        const expiresAt = Object.hasOwn(body, 'expiresAt') ? body.expiresAt : undefined;
        if (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'string') {
          throw new HttpError(400, 'INVALID_BODY', 'expiresAt must be a timestamp string or null');
        }
        const input: CreateApiKeyInput = {
          name: nonEmptyString(body.name, 'name'),
          modelScopes: modelScopes(body.modelScopes),
          supplyMode: supplyMode(body.supplyMode),
          principalKind: principalKind(body.principalKind),
          ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as string | null }),
        };
        const context = await authorize(session, match.tenantId, match.projectId);
        const created = await keyService.create(context, input);
        sendJson(res, 201, requestId, publicApiKey(created));
        return true;
      }

      if (match.route === 'projectKeys' && method === 'GET') {
        const context = await authorize(session, match.tenantId, match.projectId);
        const listed = await keyService.list(context);
        sendJson(res, 200, requestId, listed.map(publicApiKey));
        return true;
      }

      await readEmptyJsonObject(req);
      const context = await authorize(session, match.tenantId, match.projectId);
      if (match.route === 'keyRotate') {
        const rotated = await keyService.rotate(context, match.keyId);
        sendJson(res, 201, requestId, publicApiKey(rotated));
        return true;
      }
      if (match.route !== 'keyRevoke') {
        throw new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
      }
      const revoked = await keyService.revoke(context, match.keyId);
      sendJson(res, 200, requestId, publicApiKey(revoked));
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : safeServiceError(error));
      return true;
    }
  };
}

export const createSaasKeysHandler = createSaasKeyHandler;
