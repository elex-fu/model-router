import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  BULK_IMPORT_PROVIDERS,
  type BulkAccountImportService,
  type BulkImportItemInput,
  type BulkImportItemRecord,
  type BulkImportJobRecord,
  type BulkImportProvider,
} from '../../supply/bulk-import-service.js';
import type { BulkImportReadStore } from '../../supply/postgres-bulk-import-read-store.js';
import {
  hasPlatformRole,
  PLATFORM_ADMIN_ROLES,
  type PlatformAdminAccessRequest,
  type PlatformAdminAccessService,
  type PlatformAdminActor,
} from '../access/index.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../auth/http.js';

const BULK_IMPORT_PREFIX = '/admin/api/v1/supply/bulk-imports' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 1_000;
const MAX_ITEM_PAGE_SIZE = 100;
const DEFAULT_ITEM_PAGE_SIZE = 100;

export const PLATFORM_ADMIN_BULK_IMPORT_PATHS = Object.freeze({
  jobs: BULK_IMPORT_PREFIX,
  job: `${BULK_IMPORT_PREFIX}/:jobId`,
  items: `${BULK_IMPORT_PREFIX}/:jobId/items`,
} as const);

export type PlatformAdminBulkImportService = Pick<BulkAccountImportService, 'importAccounts'>;

export interface PlatformAdminBulkImportServices {
  readonly service: PlatformAdminBulkImportService;
  readonly store: BulkImportReadStore;
}

export interface PlatformAdminBulkImportHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly service?: PlatformAdminBulkImportService;
  readonly store?: BulkImportReadStore;
  readonly writeSecurity?: {
    readonly publicOrigin: string;
    readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  };
}

export type PlatformAdminBulkImportHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type Route = { readonly kind: 'jobs' } | { readonly kind: 'job' | 'items'; readonly jobId: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'PlatformAdminBulkImportHttpError';
  }
}

interface WriteOriginPolicy {
  readonly origin: string;
  readonly host: string;
}

function parseWriteOrigin(value: string): WriteOriginPolicy {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('writeSecurity.publicOrigin must be an origin string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('writeSecurity.publicOrigin must be a valid HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('writeSecurity.publicOrigin must be a valid HTTP(S) origin');
  }
  return { origin: parsed.origin, host: parsed.host };
}

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://platform-admin.invalid');
  } catch {
    return undefined;
  }
}

function jobId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  if (!UUID.test(decoded)) throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  return decoded.toLowerCase();
}

function routeForPath(path: string): Route | undefined {
  if (path === BULK_IMPORT_PREFIX) return { kind: 'jobs' };
  if (!path.startsWith(`${BULK_IMPORT_PREFIX}/`)) return undefined;
  const segments = path.slice(BULK_IMPORT_PREFIX.length + 1).split('/');
  if (segments.length === 1 && segments[0] !== '') return { kind: 'job', jobId: jobId(segments[0]) };
  if (segments.length === 2 && segments[0] !== '' && segments[1] === 'items') {
    return { kind: 'items', jobId: jobId(segments[0]) };
  }
  return undefined;
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
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

function sendError(res: ServerResponse, requestId: string, error: HttpError, allow?: string): void {
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(allow === undefined ? {} : { allow }),
  });
  res.end(JSON.stringify({ error: { code: error.code, message: error.safeMessage, requestId } }));
}

function invalidBody(): never {
  throw new HttpError(400, 'INVALID_BODY', 'The request body is invalid.');
}

function invalidQuery(): never {
  throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid.');
}

function unavailable(): never {
  throw new HttpError(503, 'BULK_IMPORT_UNAVAILABLE', 'The bulk account import service is not available');
}

function forbidden(): never {
  throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
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
    if (!/^\d+$/u.test(rawLength)) {
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
  } else if (Array.isArray(rawLength)) {
    drainRequest(req);
    throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function strictObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidBody();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) return invalidBody();
  if (required.some((key) => !Object.hasOwn(object, key))) return invalidBody();
  return object;
}

function requiredText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    return invalidBody();
  }
  return value;
}

function parseBody(value: unknown): { readonly provider: BulkImportProvider; readonly items: BulkImportItemInput[] } {
  const body = strictObject(value, ['provider', 'items'], ['provider', 'items']);
  if (typeof body.provider !== 'string' || !BULK_IMPORT_PROVIDERS.includes(body.provider as BulkImportProvider)) {
    return invalidBody();
  }
  const provider = body.provider as BulkImportProvider;
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) return invalidBody();
  const items = body.items.map((entry): BulkImportItemInput => {
    const item = strictObject(entry, ['material', 'displayName', 'egressProxyId'], ['material']);
    if (item.material === null || typeof item.material !== 'object' || Array.isArray(item.material)) {
      return invalidBody();
    }
    const displayName = Object.hasOwn(item, 'displayName') ? requiredText(item.displayName, 256) : undefined;
    const egressProxyId = Object.hasOwn(item, 'egressProxyId') ? requiredText(item.egressProxyId, 36) : undefined;
    if (egressProxyId !== undefined && !UUID.test(egressProxyId)) return invalidBody();
    return {
      provider,
      material: item.material as Readonly<Record<string, unknown>>,
      ...(displayName === undefined ? {} : { displayName }),
      ...(egressProxyId === undefined ? {} : { egressProxyId }),
    };
  });
  return { provider, items };
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
    if (matches > 1) return undefined;
    const encoded = part.slice(separator + 1).trim();
    if (encoded.length === 0) return undefined;
    try {
      found = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  return matches === 1 && found !== undefined && found.length > 0 ? found : undefined;
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

function requireWriteOrigin(req: IncomingMessage, policy: WriteOriginPolicy | undefined): void {
  if (!policy) unavailable();
  const origin = req.headers.origin;
  if (typeof origin !== 'string') throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  if (origin !== policy.origin) throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  const host = req.headers.host;
  if (typeof host !== 'string') throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  if (host !== policy.host) throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
}

async function requireWriteCsrf(
  req: IncomingMessage,
  security: PlatformAdminBulkImportHttpOptions['writeSecurity'],
): Promise<void> {
  if (!security) unavailable();
  const sessionToken = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrfCookie = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const csrfHeader = req.headers['x-csrf-token'];
  if (typeof csrfHeader !== 'string' || !sameSecret(csrfCookie, csrfHeader) || sessionToken === undefined) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
  let valid = false;
  try {
    valid = await security.authService.verifyCsrfToken(sessionToken, csrfCookie as string);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

function safeHeaderValue(value: string | string[] | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    [...normalized].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

function isAuthenticatedPlatformActor(actor: PlatformAdminActor | undefined): actor is PlatformAdminActor {
  return (
    actor !== undefined &&
    actor !== null &&
    typeof actor.userId === 'string' &&
    actor.userId.trim().length > 0 &&
    hasPlatformRole(actor, PLATFORM_ADMIN_ROLES)
  );
}

function safeJobDto(record: BulkImportJobRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    totalCount: record.totalCount,
    successCount: record.successCount,
    failureCount: record.failureCount,
    createdBy: record.createdBy,
    errorSummary: { ...record.errorSummary },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

function safeItemDto(record: BulkImportItemRecord): Record<string, unknown> {
  return {
    jobId: record.jobId,
    itemIndex: record.itemIndex,
    provider: record.provider,
    credentialFingerprint: record.credentialFingerprint,
    status: record.status,
    accountRef: record.accountRef,
    errorReason: record.errorReason,
    displayName: record.displayName,
    egressProxyId: record.egressProxyId,
    validationState: record.validationState,
    optionWarnings: [...record.optionWarnings],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

function itemListQuery(url: URL): { readonly limit: number; readonly afterItemIndex?: number } {
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if ((key !== 'limit' && key !== 'cursor') || values.has(key) || value.length === 0) invalidQuery();
    values.set(key, value);
  }
  let limit = DEFAULT_ITEM_PAGE_SIZE;
  const rawLimit = values.get('limit');
  if (rawLimit !== undefined) {
    if (!/^\d+$/u.test(rawLimit)) invalidQuery();
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEM_PAGE_SIZE) invalidQuery();
  }
  const cursor = values.get('cursor');
  if (cursor === undefined) return { limit };
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(cursor)) invalidQuery();
  const afterItemIndex = Number(cursor);
  if (!Number.isSafeInteger(afterItemIndex)) invalidQuery();
  return { limit, afterItemIndex };
}

export function createPlatformAdminBulkImportHttpHandler(
  options: PlatformAdminBulkImportHttpOptions,
): PlatformAdminBulkImportHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (options.service !== undefined && typeof options.service.importAccounts !== 'function') {
    throw new TypeError('bulk import service is invalid');
  }
  if (
    options.store !== undefined &&
    (typeof options.store.getJobStatus !== 'function' || typeof options.store.listItems !== 'function')
  ) {
    throw new TypeError('bulk import read store is invalid');
  }
  if (
    options.writeSecurity !== undefined &&
    (!options.writeSecurity.authService || typeof options.writeSecurity.authService.verifyCsrfToken !== 'function')
  ) {
    throw new TypeError('writeSecurity.authService.verifyCsrfToken is required');
  }
  const writeOriginPolicy =
    options.writeSecurity === undefined ? undefined : parseWriteOrigin(options.writeSecurity.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const url = requestUrl(req);
    if (url === undefined) return false;
    const requestId = `platform_admin_${(req.method ?? 'GET').toUpperCase() === 'GET' ? 'read' : 'write'}_${randomUUID()}`;
    let route: Route | undefined;
    try {
      route = routeForPath(url.pathname);
      if (route === undefined) return false;
      const method = (req.method ?? 'GET').toUpperCase();
      const allowed = route.kind === 'jobs' ? ['POST'] : ['GET'];
      if (!allowed.includes(method)) {
        drainRequest(req);
        sendError(
          res,
          requestId,
          new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'),
          allowed.join(', '),
        );
        return true;
      }
      const isWrite = method === 'POST';
      if (isWrite) requireWriteOrigin(req, writeOriginPolicy);
      const actor = await options.access.authenticate(req as PlatformAdminAccessRequest);
      if (!isAuthenticatedPlatformActor(actor)) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      }
      if (!hasPlatformRole(actor, ['operations'])) forbidden();
      if (isWrite) await requireWriteCsrf(req, options.writeSecurity);

      if (route.kind === 'jobs') {
        if (url.searchParams.size !== 0) invalidQuery();
        const service = options.service;
        if (!service) unavailable();
        const input = parseBody(await readJson(req));
        const remoteAddress = req.socket?.remoteAddress;
        const result = await service.importAccounts({
          items: input.items,
          audit: {
            actorUserId: actor.userId,
            sourceIp: typeof remoteAddress === 'string' && isIP(remoteAddress) !== 0 ? remoteAddress : null,
            userAgent: safeHeaderValue(req.headers['user-agent'], 512),
          },
        });
        sendJson(res, 201, requestId, { job: safeJobDto(result.job), items: result.items.map(safeItemDto) });
        return true;
      }

      const store = options.store;
      if (!store) unavailable();
      if (route.kind === 'job') {
        if (url.searchParams.size !== 0) invalidQuery();
        const snapshot = await store.getJobStatus(route.jobId);
        if (snapshot === null)
          throw new HttpError(404, 'BULK_IMPORT_JOB_NOT_FOUND', 'The bulk import job was not found');
        sendJson(res, 200, requestId, { job: safeJobDto(snapshot.job), counts: { ...snapshot.counts } });
        return true;
      }

      const snapshot = await store.getJobStatus(route.jobId);
      if (snapshot === null) throw new HttpError(404, 'BULK_IMPORT_JOB_NOT_FOUND', 'The bulk import job was not found');
      const query = itemListQuery(url);
      const rows = await store.listItems({
        jobId: route.jobId,
        ...(query.afterItemIndex === undefined ? {} : { afterItemIndex: query.afterItemIndex }),
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      sendJson(res, 200, requestId, {
        items: items.map(safeItemDto),
        hasMore: rows.length > query.limit,
        nextCursor: rows.length > query.limit ? String(items.at(-1)?.itemIndex ?? '') : null,
      });
      return true;
    } catch (error) {
      drainRequest(req);
      if (res.destroyed || res.writableEnded) return true;
      const mapped =
        error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
      sendError(res, requestId, mapped);
      return true;
    }
  };
}
