import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { SaasDatabase } from '../db/types.js';
import { SaasIdentityError } from '../identity/errors.js';
import type { SaasIdentityService } from '../identity/service.js';
import type { TenantContext } from '../identity/types.js';
import { parseCustomerWebhookDeliveryCursor, readCustomerWebhookDeliveryHistory } from './delivery-query.js';
import type {
  CreatedCustomerWebhookEndpoint,
  CustomerWebhookActorContext,
  CustomerWebhookEndpointMetadata,
  CustomerWebhookEndpointService,
  CustomerWebhookEndpointUpdate,
  CustomerWebhookSigningSecretMetadata,
} from './endpoint-service.js';
import { assertWebhookUuid, CUSTOMER_WEBHOOK_EVENT_TYPES, type CustomerWebhookEventType } from './events.js';

const API_PREFIX = '/console/api/v1';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const MAX_PATH_LENGTH = 4096;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const MAX_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

export type CustomerWebhookHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface CustomerWebhookHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'resolveTenantContext' | 'verifyCsrfToken'>;
  readonly database: Pick<SaasDatabase, 'query'>;
  readonly endpointService: Pick<
    CustomerWebhookEndpointService,
    | 'createEndpoint'
    | 'updateEndpoint'
    | 'setEndpointState'
    | 'rotateSigningSecret'
    | 'revokeSigningSecret'
    | 'readEndpoint'
    | 'listSigningSecretMetadata'
  >;
  readonly publicOrigin: string;
}

type Route =
  | { readonly operation: 'list' | 'create'; readonly tenantId: string }
  | { readonly operation: 'listDeliveries'; readonly tenantId: string; readonly endpointId: string }
  | {
      readonly operation: 'read' | 'update' | 'disable' | 'enable' | 'revoke' | 'rotate' | 'listSecrets';
      readonly tenantId: string;
      readonly endpointId: string;
    }
  | {
      readonly operation: 'revokeSecret';
      readonly tenantId: string;
      readonly endpointId: string;
      readonly version: number;
    };

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly allow?: string,
  ) {
    super(message);
    this.name = 'CustomerWebhookHttpError';
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

function sendError(res: ServerResponse, requestId: string, error: HttpError): void {
  const headers: OutgoingHttpHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(error.allow === undefined ? {} : { allow: error.allow }),
  };
  res.writeHead(error.status, headers);
  res.end(JSON.stringify({ error: { code: error.code, message: error.message, requestId } }));
}

function routePath(req: IncomingMessage, origin: string): string | undefined {
  try {
    const url = new URL(req.url ?? '/', origin);
    if (url.origin !== origin) return undefined;
    return url.pathname.length <= MAX_PATH_LENGTH ? url.pathname : undefined;
  } catch {
    return undefined;
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
    value.trim() === '' ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..' ||
    /%(?:00|2e|2f|5c)/i.test(value)
  ) {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  return value;
}

function findRoute(path: string, method: string): Route | undefined {
  const segments = path.split('/');
  if (
    segments.length < 7 ||
    segments[1] !== 'console' ||
    segments[2] !== 'api' ||
    segments[3] !== 'v1' ||
    segments[4] !== 'tenants' ||
    segments[6] !== 'webhooks'
  ) {
    return undefined;
  }

  const tenantId = pathIdentifier(segments[5] ?? '', 'tenant');
  const rest = segments.slice(7);
  if (rest.length === 0) return { operation: method === 'POST' ? 'create' : 'list', tenantId };
  if (rest.length === 1 && rest[0] !== '') {
    return {
      operation: method === 'PATCH' ? 'update' : 'read',
      tenantId,
      endpointId: pathIdentifier(rest[0] ?? '', 'endpoint'),
    };
  }
  if (rest.length === 2 && rest.every((part) => part !== '')) {
    const endpointId = pathIdentifier(rest[0] ?? '', 'endpoint');
    switch (rest[1]) {
      case 'deliveries':
        return { operation: 'listDeliveries', tenantId, endpointId };
      case 'rotate':
        return { operation: 'rotate', tenantId, endpointId };
      case 'disable':
        return { operation: 'disable', tenantId, endpointId };
      case 'enable':
        return { operation: 'enable', tenantId, endpointId };
      case 'revoke':
        return { operation: 'revoke', tenantId, endpointId };
      case 'secrets':
        return { operation: 'listSecrets', tenantId, endpointId };
      default:
        return undefined;
    }
  }
  if (rest.length === 4 && rest[1] === 'secrets' && rest[3] === 'revoke') {
    const endpointId = pathIdentifier(rest[0] ?? '', 'endpoint');
    const versionText = rest[2] ?? '';
    if (!/^\d{1,9}$/.test(versionText)) throw new HttpError(400, 'INVALID_PATH', 'The secret version is invalid');
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new HttpError(400, 'INVALID_PATH', 'The secret version is invalid');
    }
    return { operation: 'revokeSecret', tenantId, endpointId, version };
  }
  return undefined;
}

function sessionToken(req: IncomingMessage, cookieName: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) return undefined;
    if (part.slice(0, separator).trim() === cookieName) matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(matches[0] ?? '');
  } catch {
    return undefined;
  }
  if (value.length < 16 || value.length > 256 || value.trim() !== value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

function constantTimeMatches(leftText: string, rightText: string): boolean {
  const left = Buffer.from(leftText, 'utf8');
  const right = Buffer.from(rightText, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireExactOrigin(req: IncomingMessage, origin: string, host: string): void {
  const suppliedOrigin = req.headers.origin;
  if (typeof suppliedOrigin !== 'string') {
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }
  try {
    const parsed = new URL(suppliedOrigin);
    if (parsed.origin !== origin || suppliedOrigin !== parsed.origin) throw new Error('origin mismatch');
  } catch {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  if (req.headers.host !== host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

async function requireWriteBoundary(
  req: IncomingMessage,
  service: CustomerWebhookHttpOptions['service'],
  token: string,
  origin: string,
  host: string,
): Promise<void> {
  requireExactOrigin(req, origin, host);
  const csrfCookie = sessionToken(req, CSRF_COOKIE_NAME);
  const csrfHeader = req.headers['x-csrf-token'];
  if (
    !csrfCookie ||
    typeof csrfHeader !== 'string' ||
    !constantTimeMatches(csrfCookie, csrfHeader) ||
    !(await service.verifyCsrfToken(token, csrfCookie))
  ) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  }
  return value as JsonObject;
}

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
  const result = object(value);
  const allowedKeys = new Set(allowed);
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unsupported field');
  }
  if (required.some((key) => !Object.hasOwn(result, key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is missing a required field');
  }
  return result;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const rawLength = req.headers['content-length'];
  if (Array.isArray(rawLength) || (rawLength !== undefined && !/^\d+$/.test(rawLength))) {
    req.resume();
    throw new HttpError(400, 'INVALID_BODY', 'The request body is invalid');
  }
  if (typeof rawLength === 'string' && Number(rawLength) > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
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

async function readOptionalEmptyObject(req: IncomingMessage): Promise<void> {
  const contentLength = req.headers['content-length'];
  if (contentLength === '0' && req.headers['transfer-encoding'] === undefined) return;
  if (
    contentLength === undefined &&
    req.headers['transfer-encoding'] === undefined &&
    req.headers['content-type'] === undefined
  ) {
    return;
  }
  strictObject(await readJson(req), [], []);
}

function endpointInput(value: unknown): CustomerWebhookEndpointUpdate {
  const body = strictObject(value, ['targetUrl', 'eventTypes'], ['targetUrl', 'eventTypes']);
  if (typeof body.targetUrl !== 'string' || body.targetUrl.length > 2048) {
    throw new HttpError(400, 'INVALID_BODY', 'targetUrl is invalid');
  }
  if (
    !Array.isArray(body.eventTypes) ||
    body.eventTypes.length < 1 ||
    body.eventTypes.length > CUSTOMER_WEBHOOK_EVENT_TYPES.length ||
    body.eventTypes.some((value) => !CUSTOMER_WEBHOOK_EVENT_TYPES.includes(value as CustomerWebhookEventType)) ||
    new Set(body.eventTypes).size !== body.eventTypes.length
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'eventTypes contains unsupported or duplicate events');
  }
  return { targetUrl: body.targetUrl, eventTypes: body.eventTypes as CustomerWebhookEventType[] };
}

function rotationOverlap(value: unknown): number {
  const body = strictObject(value, ['overlapMs'], ['overlapMs']);
  const overlap = body.overlapMs;
  if (!Number.isSafeInteger(overlap) || (overlap as number) < 0 || (overlap as number) > MAX_ROTATION_OVERLAP_MS) {
    throw new HttpError(400, 'INVALID_BODY', 'overlapMs is invalid');
  }
  return overlap as number;
}

function queryOptions(url: URL): { readonly cursor?: string; readonly limit: number } {
  for (const name of new Set(url.searchParams.keys())) {
    if (name !== 'cursor' && name !== 'limit') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    if (url.searchParams.getAll(name).length > 1) {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined) {
    try {
      assertWebhookUuid(cursor, 'cursor');
    } catch {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIST_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  return { ...(cursor === undefined ? {} : { cursor }), limit };
}

function deliveryQueryOptions(url: URL): {
  readonly cursor?: ReturnType<typeof parseCustomerWebhookDeliveryCursor>;
  readonly limit: number;
} {
  for (const name of new Set(url.searchParams.keys())) {
    if (name !== 'cursor' && name !== 'limit') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    if (url.searchParams.getAll(name).length > 1) {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  const cursorText = url.searchParams.get('cursor') ?? undefined;
  let cursor: ReturnType<typeof parseCustomerWebhookDeliveryCursor> | undefined;
  if (cursorText !== undefined) {
    try {
      cursor = parseCustomerWebhookDeliveryCursor(cursorText);
    } catch {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIST_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
    }
  }
  return { ...(cursor === undefined ? {} : { cursor }), limit };
}

function requireManager(context: TenantContext): void {
  if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  }
}

function endpointDto(endpoint: CustomerWebhookEndpointMetadata): Record<string, unknown> {
  return {
    endpointId: endpoint.endpointId,
    currentVersion: endpoint.currentVersion,
    state: endpoint.state,
    targetUrl: endpoint.targetUrl,
    eventTypes: [...endpoint.eventTypes],
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

function signingSecretDto(secret: CustomerWebhookSigningSecretMetadata): Record<string, unknown> {
  return {
    version: secret.version,
    state: secret.state,
    overlapExpiresAt: secret.overlapExpiresAt,
    createdAt: secret.createdAt,
  };
}

function createdDto(result: CreatedCustomerWebhookEndpoint): Record<string, unknown> {
  return {
    endpoint: endpointDto(result.endpoint),
    signingSecret: result.signingSecret,
    signingSecretVersion: result.signingSecretVersion,
  };
}

function serviceError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof SaasIdentityError) {
    if (error.status === 401) return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    if (error.status === 403) return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    if (error.status === 404) return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
    return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
  const code = error instanceof Error ? error.message : '';
  if (code === 'WEBHOOK_FORBIDDEN') return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
  if (code === 'WEBHOOK_ENDPOINT_NOT_FOUND' || code === 'WEBHOOK_SECRET_NOT_FOUND') {
    return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return new HttpError(400, 'INVALID_BODY', 'The request contains invalid data');
  }
  if (
    code.startsWith('WEBHOOK_TENANT_POLICY_') ||
    code === 'WEBHOOK_ENDPOINT_QUOTA_EXCEEDED' ||
    code === 'WEBHOOK_ENDPOINT_CONFLICT' ||
    code === 'WEBHOOK_ENDPOINT_REVOKED' ||
    code === 'WEBHOOK_SECRET_UNAVAILABLE' ||
    code === 'WEBHOOK_SECRET_ROTATION_CONFLICT' ||
    code === 'WEBHOOK_SECRET_STATE_INVALID'
  ) {
    return new HttpError(409, 'WEBHOOK_STATE_CONFLICT', 'The webhook resource cannot be changed in its current state');
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

function methodAllowed(route: Route): string {
  switch (route.operation) {
    case 'list':
      return 'GET, POST';
    case 'create':
      return 'POST';
    case 'read':
    case 'listSecrets':
    case 'listDeliveries':
      return 'GET';
    case 'update':
      return 'PATCH';
    case 'revokeSecret':
    case 'disable':
    case 'enable':
    case 'revoke':
    case 'rotate':
      return 'POST';
  }
}

function isWrite(route: Route): boolean {
  return (
    route.operation !== 'list' &&
    route.operation !== 'read' &&
    route.operation !== 'listSecrets' &&
    route.operation !== 'listDeliveries'
  );
}

export function createCustomerWebhookHandler(options: CustomerWebhookHttpOptions): CustomerWebhookHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  if (
    publicUrl.origin === 'null' ||
    publicUrl.username !== '' ||
    publicUrl.password !== '' ||
    publicUrl.pathname !== '/' ||
    publicUrl.search !== '' ||
    publicUrl.hash !== ''
  ) {
    throw new TypeError('publicOrigin must be an origin');
  }
  const expectedOrigin = publicUrl.origin;
  const expectedHost = publicUrl.host;

  return async (req, res) => {
    const requestId = `customer_webhook_${randomUUID()}`;
    try {
      const path = routePath(req, expectedOrigin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      if (!path.startsWith(`${API_PREFIX}/`)) return false;
      const method = (req.method ?? 'GET').toUpperCase();
      const route = findRoute(path, method);
      if (!route) return false;

      const url = new URL(req.url ?? '/', expectedOrigin);
      const allowed = methodAllowed(route);
      if (!allowed.split(', ').includes(method)) {
        req.resume();
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint', allowed);
      }

      const token = sessionToken(req, SESSION_COOKIE_NAME);
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (typeof session?.userId !== 'string' || session.userId.trim() === '') {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      }
      if (isWrite(route)) {
        await requireWriteBoundary(req, options.service, token, expectedOrigin, expectedHost);
      }
      const context = await options.service.resolveTenantContext({ userId: session.userId, tenantId: route.tenantId });
      if (context.userId !== session.userId || context.tenantId !== route.tenantId) {
        throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
      }
      const actor: CustomerWebhookActorContext = {
        tenantId: context.tenantId,
        actorUserId: context.userId,
        requestId,
      };

      if (route.operation === 'list') {
        const { cursor, limit } = queryOptions(url);
        const selected = await options.database.query<{ readonly endpoint_id: unknown }>(
          `SELECT id::text AS endpoint_id
           FROM saas_customer_webhook_endpoints
           WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
           ORDER BY id ASC
           LIMIT $3`,
          [context.tenantId, cursor ?? null, limit + 1],
        );
        const hasMore = selected.rows.length > limit;
        const page = selected.rows.slice(0, limit);
        const endpointIds = page.map((row) => {
          if (typeof row.endpoint_id !== 'string') throw new Error('Stored webhook endpoint id is invalid');
          assertWebhookUuid(row.endpoint_id, 'stored endpoint id');
          return row.endpoint_id;
        });
        const endpoints = await Promise.all(
          endpointIds.map((endpointId) => options.endpointService.readEndpoint(actor, endpointId)),
        );
        sendJson(res, 200, requestId, {
          items: endpoints.map(endpointDto),
          nextCursor: hasMore ? (endpointIds.at(-1) ?? null) : null,
        });
        return true;
      }

      if (route.operation === 'create') {
        requireManager(context);
        const input = endpointInput(await readJson(req));
        const created = await options.endpointService.createEndpoint(actor, input);
        sendJson(res, 201, requestId, createdDto(created));
        return true;
      }

      if (route.operation === 'listDeliveries') {
        const { cursor, limit } = deliveryQueryOptions(url);
        // Reuse the endpoint service's active membership and tenant ownership check before reading history.
        await options.endpointService.readEndpoint(actor, route.endpointId);
        const history = await readCustomerWebhookDeliveryHistory(options.database, context.tenantId, route.endpointId, {
          ...(cursor === undefined ? {} : { cursor }),
          limit,
        });
        sendJson(res, 200, requestId, history);
        return true;
      }

      if (route.operation === 'read') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        const endpoint = await options.endpointService.readEndpoint(actor, route.endpointId);
        sendJson(res, 200, requestId, endpointDto(endpoint));
        return true;
      }

      if (route.operation === 'update') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        requireManager(context);
        const input = endpointInput(await readJson(req));
        const endpoint = await options.endpointService.updateEndpoint(actor, route.endpointId, input);
        sendJson(res, 200, requestId, endpointDto(endpoint));
        return true;
      }

      if (route.operation === 'rotate') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        requireManager(context);
        const overlapMs = rotationOverlap(await readJson(req));
        const result = await options.endpointService.rotateSigningSecret(actor, route.endpointId, overlapMs);
        sendJson(res, 200, requestId, {
          signingSecret: result.signingSecret,
          signingSecretVersion: result.signingSecretVersion,
        });
        return true;
      }

      if (route.operation === 'disable' || route.operation === 'enable' || route.operation === 'revoke') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        requireManager(context);
        await readOptionalEmptyObject(req);
        const state = route.operation === 'disable' ? 'suspended' : route.operation === 'enable' ? 'active' : 'revoked';
        const endpoint = await options.endpointService.setEndpointState(actor, route.endpointId, state);
        sendJson(res, 200, requestId, endpointDto(endpoint));
        return true;
      }

      if (route.operation === 'listSecrets') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        const secrets = await options.endpointService.listSigningSecretMetadata(actor, route.endpointId);
        sendJson(res, 200, requestId, { items: secrets.map(signingSecretDto) });
        return true;
      }

      if (route.operation === 'revokeSecret') {
        if (url.search !== '') throw new HttpError(400, 'INVALID_QUERY', 'The query is invalid');
        requireManager(context);
        await readOptionalEmptyObject(req);
        await options.endpointService.revokeSigningSecret(actor, route.endpointId, route.version);
        const metadata = await options.endpointService.listSigningSecretMetadata(actor, route.endpointId);
        const revoked = metadata.find((secret) => secret.version === route.version);
        if (!revoked) throw new Error('WEBHOOK_SECRET_NOT_FOUND');
        sendJson(res, 200, requestId, signingSecretDto(revoked));
        return true;
      }

      return false;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, serviceError(error));
      return true;
    }
  };
}
