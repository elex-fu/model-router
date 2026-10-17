import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  COMPOSITE_ROUTE_TARGET_PLATFORMS,
  compositeModelRoutesErrorStatus,
  SaasCompositeModelRoutesError,
  type SaasCompositeModelRoutesService,
} from '../billing/composite-routes/service.js';
import type { SqlExecutor } from '../db/types.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

/**
 * Batch 4 §4.4 composite model routing — the operator endpoints behind the
 * platform console's composite-group routes view (the billing-groups-http
 * contract shape; sub2api /api/v1/admin/groups/:id/composite-routes).
 *
 * - POST /admin/api/v1/composite-routes/list — one group's registry rows
 *   (enabled only by default; includeDisabled surfaces the full registry).
 * - POST /admin/api/v1/composite-routes/create | /update | /delete —
 *   registry CRUD. Writes are plain rows (runtime resolution reads the
 *   registry live per preparation transaction — no authz fence applies).
 * - POST /admin/api/v1/composite-routes/preview — the dry run: how the
 *   gateway's three-level resolver would route one model/endpoint pair for
 *   one composite group, returning the decision and its matched level.
 *
 * Same-origin POST only, platform session authentication with the operations
 * role, CSRF token on every write, strict JSON with exact-key allowlists,
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes.
 */
const ROUTE_PREFIX = '/admin/api/v1/composite-routes/';
const ROUTES = new Set(['list', 'create', 'update', 'delete', 'preview']);

export interface CompositeModelRoutesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: Pick<
    SaasCompositeModelRoutesService,
    'listRoutes' | 'createRoute' | 'updateRoute' | 'deleteRoute' | 'previewRoute'
  >;
  readonly audit?: CompositeModelRoutesAuditWriter;
  readonly publicOrigin: string;
}

export type CompositeModelRoutesHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type CompositeModelRoutesAuditWriter = (input: {
  readonly action: string;
  readonly targetId: string;
  readonly actorUserId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}) => Promise<void>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'CompositeModelRoutesHttpError';
  }
}

function route(pathname: string): string | undefined {
  if (!pathname.startsWith(ROUTE_PREFIX)) return undefined;
  const action = pathname.slice(ROUTE_PREFIX.length);
  return ROUTES.has(action) ? action : undefined;
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
    throw new HttpError(503, 'COMPOSITE_ROUTES_UNAVAILABLE', 'Composite routes are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: CompositeModelRoutesHttpOptions['authService'],
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

function bodyText(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  return value;
}

function bodyBoolean(body: Record<string, unknown>, name: string): boolean {
  if (typeof body[name] !== 'boolean') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  return body[name] as boolean;
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

const ROUTE_BODY_KEYS = [
  'groupId',
  'publicModel',
  'matchType',
  'targetPlatform',
  'upstreamModel',
  'endpoint',
  'priority',
  'enabled',
  'notes',
] as const;

const MATCH_TYPES = new Set(['exact', 'prefix']);
const ENDPOINTS = new Set(['any', 'messages', 'responses', 'chat_completions', 'gemini']);

function bodyRouteInput(
  body: Record<string, unknown>,
  options: { readonly allowRouteId?: boolean } = {},
): {
  readonly groupId: string;
  readonly publicModel: string;
  readonly matchType: 'exact' | 'prefix';
  readonly targetPlatform: string;
  readonly upstreamModel: string;
  readonly endpoint: 'any' | 'messages' | 'responses' | 'chat_completions' | 'gemini';
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string;
} {
  requireExactKeys(body, options.allowRouteId === true ? [...ROUTE_BODY_KEYS, 'routeId'] : ROUTE_BODY_KEYS);
  const upstreamModel = body.upstreamModel;
  if (typeof upstreamModel !== 'string' || upstreamModel.length > 200 || upstreamModel.trim() !== upstreamModel) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  const matchType = body.matchType;
  if (typeof matchType !== 'string' || !MATCH_TYPES.has(matchType)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || !ENDPOINTS.has(endpoint)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  const targetPlatform = body.targetPlatform;
  if (typeof targetPlatform !== 'string' || !COMPOSITE_ROUTE_TARGET_PLATFORMS.includes(targetPlatform)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unknown target platform');
  }
  const priority = body.priority;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0 || priority > 100_000) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  const notes = body.notes;
  if (typeof notes !== 'string' || notes.length > 2000) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid composite route input');
  }
  return {
    groupId: bodyText(body, 'groupId', 128),
    publicModel: bodyText(body, 'publicModel', 200),
    matchType: matchType as 'exact' | 'prefix',
    targetPlatform,
    upstreamModel,
    endpoint: endpoint as 'any' | 'messages' | 'responses' | 'chat_completions' | 'gemini',
    priority,
    enabled: bodyBoolean(body, 'enabled'),
    notes,
  };
}

function routeDto(route: {
  readonly id: string;
  readonly groupId: string;
  readonly publicModel: string;
  readonly matchType: string;
  readonly targetPlatform: string;
  readonly upstreamModel: string;
  readonly endpoint: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string;
}): Record<string, unknown> {
  return { ...route };
}

/**
 * Best-effort audit writer on the control-plane role (the billing-groups
 * precedent): failures are swallowed so an audit hiccup never fails the
 * operator mutation, which is already transactional in the service.
 */
export function createPostgresCompositeModelRoutesAuditWriter(executor: SqlExecutor): CompositeModelRoutesAuditWriter {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return async (input) => {
    await executor
      .query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
            source_ip, user_agent, entry_point)
         VALUES ($1, NULL, $2, $3, 'saas_composite_model_routes', $4, clock_timestamp(), $5::inet, $6, 'composite-routes-http')`,
        [randomUUID(), input.actorUserId, input.action, input.targetId, input.sourceIp, input.userAgent],
      )
      .catch(() => undefined);
  };
}

export function createCompositeModelRoutesHttpHandler(
  options: CompositeModelRoutesHttpOptions,
): CompositeModelRoutesHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service || typeof options.service.listRoutes !== 'function') {
    throw new TypeError('composite model routes service is required');
  }

  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      const action = route(url.pathname);
      if (!action) return false;
      if (url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        req.resume();
        res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }),
        );
        return true;
      }
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      const metadata = requestMetadata(req);
      const audit = options.audit;

      if (action === 'list') {
        requireExactKeys(body, ['groupId', 'includeDisabled']);
        const groupId = bodyText(body, 'groupId', 128);
        const includeDisabled = body.includeDisabled === undefined ? false : bodyBoolean(body, 'includeDisabled');
        const routes = await options.service.listRoutes(groupId, { includeDisabled });
        sendJson(res, 200, requestId, { routes: routes.map(routeDto) });
        return true;
      }

      if (action === 'create' || action === 'update') {
        const input = bodyRouteInput(body, { allowRouteId: action === 'update' });
        const routeRow =
          action === 'create'
            ? await options.service.createRoute(input)
            : await options.service.updateRoute(bodyText(body, 'routeId', 32), input);
        if (audit) {
          await audit({
            action: `saas_composite_model_route.${action === 'create' ? 'created' : 'updated'}`,
            targetId: routeRow.id,
            actorUserId: actor.userId,
            ...metadata,
          }).catch(() => undefined);
        }
        sendJson(res, 200, requestId, { route: routeDto(routeRow) });
        return true;
      }

      if (action === 'delete') {
        requireExactKeys(body, ['groupId', 'routeId']);
        const routeId = bodyText(body, 'routeId', 32);
        await options.service.deleteRoute(routeId);
        if (audit) {
          await audit({
            action: 'saas_composite_model_route.deleted',
            targetId: routeId,
            actorUserId: actor.userId,
            ...metadata,
          }).catch(() => undefined);
        }
        sendJson(res, 200, requestId, { deleted: routeId });
        return true;
      }

      // preview: the dry run over the exact runtime resolution.
      requireExactKeys(body, ['groupId', 'model', 'endpoint']);
      const preview = await options.service.previewRoute({
        groupId: bodyText(body, 'groupId', 128),
        model: bodyText(body, 'model', 200),
        endpoint: bodyText(body, 'endpoint', 32),
      });
      sendJson(res, 200, requestId, {
        decision: {
          matched: preview.decision.matched,
          source: preview.decision.source,
          groupId: preview.decision.groupId,
          publicModel: preview.decision.publicModel,
          targetPlatform: preview.decision.targetPlatform,
          upstreamModel: preview.decision.upstreamModel,
          endpoint: preview.decision.endpoint,
          routeId: preview.decision.routeId,
          reason: preview.decision.reason,
        },
        routeCount: preview.routeCount,
      });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof SaasCompositeModelRoutesError) {
        const mapped = compositeModelRoutesErrorStatus(error);
        sendError(res, mapped.status, requestId, mapped.code, error.message);
        return true;
      }
      sendError(
        res,
        503,
        requestId,
        'COMPOSITE_ROUTES_UNAVAILABLE',
        'The composite route request could not be completed',
      );
      return true;
    }
  };
}
