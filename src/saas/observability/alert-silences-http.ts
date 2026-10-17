import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { SqlExecutor } from '../db/types.js';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import {
  type AlertSilenceInput,
  type AlertSilenceRecord,
  ObservabilitySilenceValidationError,
} from './alert-silences.js';

/**
 * Batch 5 §5.6 (task #23): the operator endpoints behind the ops console's
 * alert silences view — the composite-routes-http contract shape (POST-only
 * actions, platform session authentication with the operations role, CSRF on
 * every write, strict JSON with exact-key allowlists, `{ data, meta:
 * { requestId } }` / `{ error }` envelopes).
 *
 * - POST /admin/api/v1/ops/alert-silences/list — active silences
 *   (includeExpired surfaces expired rows too).
 * - POST /admin/api/v1/ops/alert-silences/create — a silence needs at least
 *   one scope (ruleId / platform / groupId / region), a future until and the
 *   acting operator as created_by.
 * - POST /admin/api/v1/ops/alert-silences/delete — silence lifecycle.
 */
const ROUTE_PREFIX = '/admin/api/v1/ops/alert-silences/';
const ROUTES = new Set(['list', 'create', 'delete']);

export interface AlertSilencesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: {
    listSilences(options?: { includeExpired?: boolean }): Promise<AlertSilenceRecord[]>;
    createSilence(input: AlertSilenceInput): Promise<AlertSilenceRecord>;
    deleteSilence(id: string): Promise<boolean>;
  };
  readonly audit?: AlertSilencesAuditWriter;
  readonly publicOrigin: string;
}

export type AlertSilencesHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type AlertSilencesAuditWriter = (input: {
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
    this.name = 'AlertSilencesHttpError';
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
    throw new HttpError(503, 'ALERT_SILENCES_UNAVAILABLE', 'Alert silences are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: AlertSilencesHttpOptions['authService']): Promise<void> {
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

function optionalText(body: Record<string, unknown>, name: string, max: number): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_BODY', `Request body contains an invalid ${name}`);
  }
  return value;
}

function bodyText(body: Record<string, unknown>, name: string, max: number): string {
  const value = optionalText(body, name, max);
  if (value === null) throw new HttpError(400, 'INVALID_BODY', `Request body contains an invalid ${name}`);
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

const SILENCE_HTTP_STATUS: Readonly<Record<string, number>> = Object.freeze({
  SILENCE_EMPTY_SCOPE: 400,
  SILENCE_INVALID_RULE: 400,
  SILENCE_INVALID_PLATFORM: 400,
  SILENCE_INVALID_GROUP: 400,
  SILENCE_INVALID_REGION: 400,
  SILENCE_INVALID_UNTIL: 400,
  SILENCE_UNTIL_IN_PAST: 400,
  SILENCE_INVALID_REASON: 400,
  SILENCE_INVALID_CREATED_BY: 400,
});

/**
 * Best-effort audit writer on the control-plane role (the composite-routes
 * precedent): failures are swallowed so an audit hiccup never fails the
 * operator mutation, which is already durable in the service.
 */
export function createPostgresAlertSilencesAuditWriter(executor: SqlExecutor): AlertSilencesAuditWriter {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return async (input) => {
    await executor
      .query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
            source_ip, user_agent, entry_point)
         VALUES ($1, NULL, $2, $3, 'saas_obs_alert_silences', $4, clock_timestamp(), $5::inet, $6, 'alert-silences-http')`,
        [randomUUID(), input.actorUserId, input.action, input.targetId, input.sourceIp, input.userAgent],
      )
      .catch(() => undefined);
  };
}

export function createAlertSilencesHttpHandler(options: AlertSilencesHttpOptions): AlertSilencesHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service || typeof options.service.listSilences !== 'function') {
    throw new TypeError('alert silence service is required');
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
        requireExactKeys(body, ['includeExpired']);
        const includeExpired = body.includeExpired === undefined ? false : body.includeExpired === true;
        if (body.includeExpired !== undefined && typeof body.includeExpired !== 'boolean') {
          throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid includeExpired');
        }
        const silences = await options.service.listSilences({ includeExpired });
        sendJson(res, 200, requestId, { silences });
        return true;
      }

      if (action === 'create') {
        requireExactKeys(body, ['ruleId', 'platform', 'groupId', 'region', 'until', 'reason']);
        const input: AlertSilenceInput = {
          ruleId: optionalText(body, 'ruleId', 64),
          platform: optionalText(body, 'platform', 100),
          groupId: optionalText(body, 'groupId', 100),
          region: optionalText(body, 'region', 100),
          until: bodyText(body, 'until', 64),
          reason: optionalText(body, 'reason', 1000),
          createdBy: actor.userId,
        };
        let silence: AlertSilenceRecord;
        try {
          silence = await options.service.createSilence(input);
        } catch (error) {
          if (error instanceof ObservabilitySilenceValidationError) {
            throw new HttpError(SILENCE_HTTP_STATUS[error.code] ?? 400, error.code, error.message);
          }
          throw error;
        }
        if (audit) {
          await audit({
            action: 'saas_obs_alert_silence.created',
            targetId: silence.id,
            actorUserId: actor.userId,
            ...metadata,
          }).catch(() => undefined);
        }
        sendJson(res, 201, requestId, { silence });
        return true;
      }

      // delete
      requireExactKeys(body, ['silenceId']);
      const silenceId = bodyText(body, 'silenceId', 64);
      const deleted = await options.service.deleteSilence(silenceId);
      if (!deleted) throw new HttpError(404, 'SILENCE_NOT_FOUND', 'The alert silence does not exist');
      if (audit) {
        await audit({
          action: 'saas_obs_alert_silence.deleted',
          targetId: silenceId,
          actorUserId: actor.userId,
          ...metadata,
        }).catch(() => undefined);
      }
      sendJson(res, 200, requestId, { deleted: silenceId });
      return true;
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      sendError(res, 500, requestId, 'INTERNAL_ERROR', 'The alert silences request could not be handled');
      return true;
    }
  };
}
