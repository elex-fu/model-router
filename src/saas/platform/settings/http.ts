import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hasPlatformRole } from '../access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../auth/http.js';
import { type PlatformSettingRecord, PlatformSettingsError, type PlatformSettingsService } from './service.js';

/**
 * F1 platform settings store (task #34): the operator admin API.
 *
 * GET  /admin/api/v1/platform-settings — every stored setting with metadata;
 *   sealed rows are marked secret and never carry their value.
 * PUT  /admin/api/v1/platform-settings — one audited version-CAS mutation:
 *   { key, value, expectedVersion } for plain keys, { key, secret,
 *   expectedVersion } for sealed keys (the secret is sealed at write time and
 *   never echoed).
 *
 * Boundary contract (the codex-oauth http.ts shape): same-origin only,
 * platform session authentication with the operations role, CSRF double-submit
 * plus server-side verification on the write, strict JSON with an exact-key
 * allowlist, and a generic 503 for anything unexpected. GETs authenticate but
 * carry no CSRF token (the platform admin read-handler precedent: CSRF is a
 * write concern).
 */
const SETTINGS_PATH = '/admin/api/v1/platform-settings';

export interface PlatformSettingsHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: Pick<PlatformSettingsService, 'list' | 'set' | 'setSecret' | 'get'>;
  readonly publicOrigin: string;
}

export type PlatformSettingsHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'PlatformSettingsHttpError';
  }
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
  const a = Buffer.from(left, 'utf-8');
  const b = Buffer.from(right, 'utf-8');
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
    throw new HttpError(503, 'PLATFORM_SETTINGS_UNAVAILABLE', 'Platform settings are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: PlatformSettingsHttpOptions['authService'],
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is invalid');
  }
  return parsed as Record<string, unknown>;
}

function requireExactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains unsupported fields');
  }
}

function bodyKey(body: Record<string, unknown>): string {
  const value = body.key;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid settings key');
  }
  return value;
}

function bodyExpectedVersion(body: Record<string, unknown>): number {
  const value: unknown = body.expectedVersion;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid expected version');
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

function settingsErrorStatus(error: PlatformSettingsError): { status: number; code: string } {
  switch (error.code) {
    case 'INVALID_KEY':
    case 'INVALID_VALUE':
      return { status: 400, code: 'INVALID_SETTINGS_INPUT' };
    case 'UNCHANGED':
      return { status: 409, code: 'SETTINGS_UNCHANGED' };
    case 'VERSION_CONFLICT':
      return { status: 409, code: 'VERSION_CONFLICT' };
    case 'NOT_FOUND':
      return { status: 404, code: 'SETTINGS_KEY_NOT_FOUND' };
    case 'SEALING_UNAVAILABLE':
    case 'UNSEALING_UNAVAILABLE':
      return { status: 503, code: 'SETTINGS_KMS_UNAVAILABLE' };
    default:
      return { status: 503, code: 'PLATFORM_SETTINGS_UNAVAILABLE' };
  }
}

function settingDto(record: PlatformSettingRecord): Record<string, unknown> {
  return record.secret
    ? {
        key: record.key,
        secret: true,
        version: record.version,
        updatedAt: record.updatedAt,
        ...(record.updatedByUserId === null ? {} : { updatedByUserId: record.updatedByUserId }),
      }
    : {
        key: record.key,
        secret: false,
        value: record.value,
        version: record.version,
        updatedAt: record.updatedAt,
        ...(record.updatedByUserId === null ? {} : { updatedByUserId: record.updatedByUserId }),
      };
}

export function createPlatformSettingsHttpHandler(options: PlatformSettingsHttpOptions): PlatformSettingsHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service || typeof options.service.set !== 'function')
    throw new TypeError('settings service is required');

  return async (req, res) => {
    const requestId = randomUUID();
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', options.publicOrigin);
      } catch {
        return false;
      }
      if (url.pathname !== SETTINGS_PATH) return false;
      if (url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'PUT') {
        req.resume();
        res.writeHead(405, { allow: 'GET, PUT', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }),
        );
        return true;
      }
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      const metadata = requestMetadata(req);

      if (method === 'GET') {
        const records = await options.service.list();
        sendJson(res, 200, requestId, { settings: records.map(settingDto) });
        return true;
      }

      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      const key = bodyKey(body);
      const expectedVersion = bodyExpectedVersion(body);
      const actorContext = {
        actorUserId: actor.userId,
        requestId,
        sourceIp: metadata.sourceIp ?? undefined,
        userAgent: metadata.userAgent ?? undefined,
      };
      if ('secret' in body) {
        requireExactKeys(body, ['key', 'secret', 'expectedVersion']);
        const secret = body.secret;
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid secret value');
        }
        const record = await options.service.setSecret({ key, secret, expectedVersion, actor: actorContext });
        sendJson(res, 200, requestId, settingDto(record));
        return true;
      }
      requireExactKeys(body, ['key', 'value', 'expectedVersion']);
      const record = await options.service.set({ key, value: body.value, expectedVersion, actor: actorContext });
      sendJson(res, 200, requestId, settingDto(record));
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof PlatformSettingsError) {
        const mapped = settingsErrorStatus(error);
        sendError(res, mapped.status, requestId, mapped.code, error.message);
        return true;
      }
      sendError(res, 503, requestId, 'PLATFORM_SETTINGS_UNAVAILABLE', 'Platform settings could not be updated');
      return true;
    }
  };
}
