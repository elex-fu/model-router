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
import type { AnnouncementView, PublishedAnnouncementView } from './announcements.js';
import { MarketingAnnouncementError } from './announcements.js';

/**
 * Track G4 announcement HTTP entries (design:
 * docs/marketing-domain-design-2026-10-11.md §8). The operator surface lives
 * under the platform-admin origin with the `operations` role band, same-origin
 * and CSRF enforcement on every mutation, and a strict JSON body. The
 * customer surface lives under the console origin: any active tenant member
 * may list visible announcements and post read receipts (CSRF-protected).
 * Handlers are standalone and composable; managed-saas.ts wiring is a
 * separate integration step.
 */

const OPS_PREFIX = '/admin/api/v1/marketing/announcements';
const CONSOLE_PREFIX = '/console/api/v1/tenants';
const CUSTOMER_SESSION_COOKIE = 'mr_saas_session';
const CUSTOMER_CSRF_COOKIE = 'mr_saas_csrf';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 8000;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MARKETING_ANNOUNCEMENT_PATHS = Object.freeze({
  opsAnnouncements: OPS_PREFIX,
  customerAnnouncements: (tenantId: string) => `${CONSOLE_PREFIX}/${tenantId}/announcements`,
} as const);

type JsonObject = Record<string, unknown>;

export type MarketingAnnouncementHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface MarketingAnnouncementOpsOperations {
  createDraft(
    actor: { userId: string },
    input: {
      kind: unknown;
      severity: unknown;
      title: unknown;
      body: unknown;
      publishAt: unknown;
      unpublishAt?: unknown;
    },
  ): Promise<AnnouncementView>;
  publish(actor: { userId: string }, announcementId: string, expectedVersion: number): Promise<AnnouncementView>;
  withdraw(actor: { userId: string }, announcementId: string, expectedVersion: number): Promise<AnnouncementView>;
  list(
    actor: { userId: string },
    input: { status?: unknown; kind?: unknown; limit?: unknown; cursor?: unknown },
  ): Promise<{ announcements: AnnouncementView[]; nextCursor: string | null }>;
}

export interface MarketingAnnouncementCustomerOperations {
  listPublished(
    context: { tenantId: string; userId: string },
    input: { limit?: unknown; cursor?: unknown },
  ): Promise<{ announcements: PublishedAnnouncementView[]; nextCursor: string | null }>;
  markRead(
    context: { tenantId: string; userId: string },
    announcementId: string,
  ): Promise<{ outcome: 'marked' | 'already_read'; announcementId: string; readAt: string }>;
}

export interface MarketingAnnouncementPlatformHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly operations: MarketingAnnouncementOpsOperations;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly publicOrigin: string;
}

export interface MarketingAnnouncementCustomerHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'verifyCsrfToken' | 'resolveTenantContext'>;
  readonly operations: MarketingAnnouncementCustomerOperations;
  readonly publicOrigin: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'MarketingAnnouncementHttpError';
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

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return normalized;
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

function pathIdentifier(encoded: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The path identifier is invalid');
  }
  if (
    value.trim() === '' ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..' ||
    hasControlCharacter(value)
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The path identifier is invalid');
  }
  return value;
}

function uuidIdentifier(encoded: string): string {
  const value = pathIdentifier(encoded);
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

function expectedVersionBody(value: unknown): number {
  const object = strictObject(value, ['expectedVersion'], ['expectedVersion']);
  const version = object.expectedVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return version;
}

function createDraftBody(value: unknown): {
  kind: string;
  severity: string;
  title: string;
  body: string;
  publishAt: string;
  unpublishAt?: string | null;
} {
  const object = strictObject(
    value,
    ['kind', 'severity', 'title', 'body', 'publishAt', 'unpublishAt'],
    ['kind', 'severity', 'title', 'body', 'publishAt'],
  );
  const publishAt = boundedText(object.publishAt, 64);
  if (Number.isNaN(Date.parse(publishAt))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  const unpublishAt = object.unpublishAt;
  const base = {
    kind: boundedText(object.kind, 32),
    severity: boundedText(object.severity, 32),
    title: boundedText(object.title, MAX_TITLE_LENGTH),
    body: boundedText(object.body, MAX_BODY_LENGTH),
    publishAt,
  };
  if (unpublishAt === undefined) return base;
  if (unpublishAt === null) return { ...base, unpublishAt: null };
  const parsed = boundedText(unpublishAt, 64);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return { ...base, unpublishAt: parsed };
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
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

function serviceError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof MarketingAnnouncementError) {
    switch (error.code) {
      case 'ANNOUNCEMENT_INVALID_INPUT':
        return new HttpError(400, error.code, 'The announcement input is invalid');
      case 'ANNOUNCEMENT_NOT_FOUND':
        return new HttpError(404, error.code, 'The announcement was not found');
      case 'ANNOUNCEMENT_STATE_CONFLICT':
      case 'ANNOUNCEMENT_VERSION_CONFLICT':
        return new HttpError(409, error.code, 'The announcement conflicts with the current state');
      case 'ANNOUNCEMENT_FORBIDDEN':
        return new HttpError(403, error.code, 'The operation is not permitted');
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
  return new HttpError(503, 'ANNOUNCEMENT_UNAVAILABLE', 'Marketing announcements are not available');
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
  if (!hasPlatformRole(actor, ['operations'])) {
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

function validateOpsOptions(options: MarketingAnnouncementPlatformHttpOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (
    !options.operations ||
    typeof options.operations.createDraft !== 'function' ||
    typeof options.operations.publish !== 'function' ||
    typeof options.operations.withdraw !== 'function' ||
    typeof options.operations.list !== 'function'
  ) {
    throw new TypeError('announcement operations methods are required');
  }
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  parseOrigin(options.publicOrigin);
}

type OpsRoute =
  | { readonly route: 'collection' }
  | { readonly route: 'publish' | 'withdraw'; readonly announcementId: string };

function matchOpsRoute(pathname: string): OpsRoute | undefined {
  if (pathname === OPS_PREFIX) return { route: 'collection' };
  if (!pathname.startsWith(`${OPS_PREFIX}/`)) return undefined;
  const segments = pathname.slice(OPS_PREFIX.length + 1).split('/');
  if (segments.length !== 2) return undefined;
  const action = segments[1];
  if (action !== 'publish' && action !== 'withdraw') return undefined;
  return { route: action, announcementId: uuidIdentifier(segments[0] as string) };
}

/** Operations surface: draft creation, publish/withdraw transitions, listing. */
export function createMarketingAnnouncementPlatformHttpHandler(
  options: MarketingAnnouncementPlatformHttpOptions,
): MarketingAnnouncementHttpHandler {
  validateOpsOptions(options);
  const originPolicy = parseOrigin(options.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const requestId = `marketing_announcement_${randomUUID()}`;
    const url = requestUrl(req, originPolicy.origin);
    if (url === undefined) return false;
    let match: OpsRoute | undefined;
    try {
      match = matchOpsRoute(url.pathname);
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
    if (match === undefined) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const allowed = match.route === 'collection' ? ['GET', 'POST'] : ['POST'];
    if (!allowed.includes(method)) {
      drainRequest(req);
      methodNotAllowed(res, requestId, allowed.join(', '));
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);

      if (match.route === 'collection' && method === 'GET') {
        const values = queryValues(url, ['status', 'kind', 'limit', 'cursor']);
        const result = await options.operations.list(actor, {
          status: optionalQueryText(values, 'status'),
          kind: optionalQueryText(values, 'kind'),
          limit: optionalQueryLimit(values),
          cursor: optionalQueryText(values, 'cursor'),
        });
        sendJson(res, 200, requestId, result);
        return true;
      }

      requireOrigin(req, originPolicy);
      await requirePlatformCsrf(req, options.authService);

      if (match.route === 'collection') {
        const announcement = await options.operations.createDraft(actor, createDraftBody(await readJson(req)));
        sendJson(res, 201, requestId, { announcement });
        return true;
      }

      const expectedVersion = expectedVersionBody(await readJson(req));
      const announcement =
        match.route === 'publish'
          ? await options.operations.publish(actor, match.announcementId, expectedVersion)
          : await options.operations.withdraw(actor, match.announcementId, expectedVersion);
      sendJson(res, 200, requestId, { announcement });
      return true;
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
  };
}

type CustomerRoute =
  | { readonly route: 'list'; readonly tenantId: string }
  | { readonly route: 'read'; readonly tenantId: string; readonly announcementId: string };

function matchCustomerRoute(pathname: string): CustomerRoute | undefined {
  if (!pathname.startsWith(`${CONSOLE_PREFIX}/`)) return undefined;
  const segments = pathname.slice(CONSOLE_PREFIX.length + 1).split('/');
  if (segments.length === 2 && segments[1] === 'announcements') {
    return { route: 'list', tenantId: uuidIdentifier(segments[0] as string) };
  }
  if (segments.length === 4 && segments[1] === 'announcements' && segments[3] === 'read') {
    return {
      route: 'read',
      tenantId: uuidIdentifier(segments[0] as string),
      announcementId: uuidIdentifier(segments[2] as string),
    };
  }
  return undefined;
}

function validateCustomerOptions(options: MarketingAnnouncementCustomerHttpOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (
    !options.service ||
    typeof options.service.getSession !== 'function' ||
    typeof options.service.verifyCsrfToken !== 'function' ||
    typeof options.service.resolveTenantContext !== 'function'
  ) {
    throw new TypeError('identity service methods are required');
  }
  if (
    !options.operations ||
    typeof options.operations.listPublished !== 'function' ||
    typeof options.operations.markRead !== 'function'
  ) {
    throw new TypeError('announcement operations methods are required');
  }
  parseOrigin(options.publicOrigin);
}

/** Customer surface: visible announcements plus idempotent read receipts. */
export function createMarketingAnnouncementCustomerHttpHandler(
  options: MarketingAnnouncementCustomerHttpOptions,
): MarketingAnnouncementHttpHandler {
  validateCustomerOptions(options);
  const originPolicy = parseOrigin(options.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const requestId = `marketing_announcement_${randomUUID()}`;
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
    const allowed = match.route === 'list' ? ['GET'] : ['POST'];
    if (!allowed.includes(method)) {
      drainRequest(req);
      methodNotAllowed(res, requestId, allowed.join(', '));
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const token = cookieValue(req, CUSTOMER_SESSION_COOKIE);
      if (token === undefined) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (session === undefined || typeof session.userId !== 'string' || session.userId.trim() === '') {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      }
      const context = await options.service.resolveTenantContext({ userId: session.userId, tenantId: match.tenantId });
      if (context.userId !== session.userId || context.tenantId !== match.tenantId) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }
      const customer = { tenantId: context.tenantId, userId: context.userId };

      if (match.route === 'list') {
        const values = queryValues(url, ['limit', 'cursor']);
        const result = await options.operations.listPublished(customer, {
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
      strictObject(await readJson(req), [], []);
      const result = await options.operations.markRead(customer, match.announcementId);
      sendJson(res, 200, requestId, result);
      return true;
    } catch (error) {
      respondError(req, res, requestId, error);
      return true;
    }
  };
}
