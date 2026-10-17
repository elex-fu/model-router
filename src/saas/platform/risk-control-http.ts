import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  maskSecretTail,
  type RiskControlConfig,
  RiskControlConfigError,
  serializeRiskControlConfig,
} from '../risk/moderation.js';
import type { ContentModerationLogPage, PostgresRiskControlAdminStore } from '../risk/postgres-store.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

/**
 * Roadmap batch 5 §5.4 (task #19) — the risk-control operator surface behind
 * the platform console (the composite-routes-http contract shape; sub2api
 * /api/v1/admin/risk-control).
 *
 * - POST /admin/api/v1/risk-control/get-config — the effective config with
 *   masked audit API keys (never full keys).
 * - POST /admin/api/v1/risk-control/update-config — strict validation, the
 *   persisted JSON the gateway reads through its 1s TTL snapshot.
 * - POST /admin/api/v1/risk-control/logs — paginated decision log with the
 *   filter dimensions (action / tenant / model / flagged / time / search).
 * - POST /admin/api/v1/risk-control/unban — clears saas_users.disabled_at
 *   for risk-control bans (refuses platform-role accounts).
 * - POST /admin/api/v1/risk-control/delete-hash | /clear-hashes — pre-hash
 *   blocklist lifecycle.
 * - POST /admin/api/v1/risk-control/run-cleanup — manual retention sweep
 *   (hit/non-hit windows ride the config's retention days).
 *
 * Same-origin POST only, platform session authentication with the operations
 * role, CSRF token on every call, strict JSON with exact-key allowlists,
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes.
 */
const ROUTE_PREFIX = '/admin/api/v1/risk-control/';
const ROUTES = new Set(['get-config', 'update-config', 'logs', 'unban', 'delete-hash', 'clear-hashes', 'run-cleanup']);

export interface RiskControlHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly store: Pick<
    PostgresRiskControlAdminStore,
    | 'loadConfig'
    | 'saveConfig'
    | 'listLogs'
    | 'countFlaggedHashes'
    | 'deleteFlaggedHash'
    | 'clearFlaggedHashes'
    | 'cleanupExpired'
    | 'enableUser'
    | 'userHoldsPlatformRole'
  >;
  readonly audit?: RiskControlAuditWriter;
  readonly publicOrigin: string;
}

export type RiskControlHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type RiskControlAuditWriter = (input: {
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
    this.name = 'RiskControlHttpError';
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
    throw new HttpError(503, 'RISK_CONTROL_UNAVAILABLE', 'Risk control is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: RiskControlHttpOptions['authService']): Promise<void> {
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

function bodyIdentifier(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid identifier');
  }
  return value;
}

function bodyOptionalIdentifier(body: Record<string, unknown>, name: string, max: number): string | undefined {
  if (body[name] === undefined || body[name] === null || body[name] === '') return undefined;
  return bodyIdentifier(body, name, max);
}

function bodyBoolean(body: Record<string, unknown>, name: string): boolean {
  if (typeof body[name] !== 'boolean') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid flag');
  }
  return body[name] as boolean;
}

function bodyPageNumber(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (value === undefined) return name === 'limit' ? 20 : 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid page parameter');
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

/** Config view with masked audit keys — full keys never leave the store. */
function configView(config: RiskControlConfig, exists: boolean): Record<string, unknown> {
  const view = JSON.parse(serializeRiskControlConfig(config)) as Record<string, unknown>;
  view.api_keys = config.apiKeys.map((key) => maskSecretTail(key));
  view.api_key_count = config.apiKeys.length;
  view.config_exists = exists;
  return view;
}

function logView(page: ContentModerationLogPage): Record<string, unknown> {
  return {
    items: page.items,
    total: page.total,
  };
}

export function createRiskControlHttpHandler(options: RiskControlHttpOptions): RiskControlHttpHandler {
  if (!options.access || !options.authService || !options.store) {
    throw new Error('risk-control http handler requires access, authService and store');
  }
  return async (req, res) => {
    const requestId = randomUUID();
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://risk-control.invalid').pathname;
    } catch {
      return false;
    }
    const action = route(pathname);
    if (action === undefined) return false;
    if (req.url?.includes('?') || req.url?.includes('#')) {
      sendError(res, 400, requestId, 'INVALID_PATH', 'Query strings are not supported');
      return true;
    }
    if ((req.method ?? '').toUpperCase() !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only', requestId } }));
      return true;
    }

    try {
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      await requireCsrf(req, options.authService);
      const metadata = requestMetadata(req);
      const writeAudit = (auditAction: string, targetId: string): void => {
        if (!options.audit) return;
        void options
          .audit({
            action: auditAction,
            targetId,
            actorUserId: actor.userId,
            sourceIp: metadata.sourceIp,
            userAgent: metadata.userAgent,
          })
          .catch(() => undefined);
      };

      switch (action) {
        case 'get-config': {
          await readJson(req);
          const { config, exists } = await options.store.loadConfig();
          sendJson(res, 200, requestId, { config: configView(config, exists) });
          return true;
        }
        case 'update-config': {
          const body = await readJson(req);
          if (
            !('config' in body) ||
            body.config === null ||
            typeof body.config !== 'object' ||
            Array.isArray(body.config)
          ) {
            throw new HttpError(400, 'INVALID_BODY', 'A config object is required');
          }
          requireExactKeys(body, ['config']);
          const config = await options.store.saveConfig(body.config);
          writeAudit('risk_control.config.updated', 'config');
          sendJson(res, 200, requestId, { config: configView(config, true) });
          return true;
        }
        case 'logs': {
          const body = await readJson(req);
          requireExactKeys(body, [
            'action',
            'tenantId',
            'model',
            'flaggedOnly',
            'from',
            'to',
            'search',
            'limit',
            'offset',
          ]);
          const page = await options.store.listLogs({
            action: bodyOptionalIdentifier(body, 'action', 64),
            tenantId: bodyOptionalIdentifier(body, 'tenantId', 128),
            model: bodyOptionalIdentifier(body, 'model', 512),
            flaggedOnly: body.flaggedOnly === undefined ? undefined : bodyBoolean(body, 'flaggedOnly'),
            fromIso: bodyOptionalIdentifier(body, 'from', 64),
            toIso: bodyOptionalIdentifier(body, 'to', 64),
            search: bodyOptionalIdentifier(body, 'search', 256),
            limit: bodyPageNumber(body, 'limit'),
            offset: bodyPageNumber(body, 'offset'),
          });
          sendJson(res, 200, requestId, logView(page));
          return true;
        }
        case 'unban': {
          const body = await readJson(req);
          requireExactKeys(body, ['userId']);
          const userId = bodyIdentifier(body, 'userId', 128);
          if (await options.store.userHoldsPlatformRole(userId)) {
            throw new HttpError(
              409,
              'PLATFORM_ACCOUNT',
              'Platform-role accounts are managed by the governance surface',
            );
          }
          const enabled = await options.store.enableUser(userId);
          writeAudit('risk_control.user.unbanned', userId);
          sendJson(res, 200, requestId, { userId, status: enabled ? 'enabled' : 'already_active' });
          return true;
        }
        case 'delete-hash': {
          const body = await readJson(req);
          requireExactKeys(body, ['inputHash']);
          const inputHash = bodyIdentifier(body, 'inputHash', 64);
          if (!/^[0-9a-f]{64}$/.test(inputHash)) {
            throw new HttpError(400, 'INVALID_BODY', 'inputHash must be a sha256 hex digest');
          }
          const deleted = await options.store.deleteFlaggedHash(inputHash);
          writeAudit('risk_control.hash.deleted', inputHash);
          sendJson(res, 200, requestId, { inputHash, deleted });
          return true;
        }
        case 'clear-hashes': {
          await readJson(req);
          const deleted = await options.store.clearFlaggedHashes();
          writeAudit('risk_control.hash.cleared', 'flagged_hashes');
          sendJson(res, 200, requestId, { deleted });
          return true;
        }
        case 'run-cleanup': {
          await readJson(req);
          const { config } = await options.store.loadConfig();
          const now = Date.now();
          const hitBefore = new Date(now - config.hitRetentionDays * 86_400_000).toISOString();
          const nonHitBefore = new Date(now - config.nonHitRetentionDays * 86_400_000).toISOString();
          const result = await options.store.cleanupExpired(hitBefore, nonHitBefore);
          writeAudit('risk_control.retention.cleanup', 'content_moderation_logs');
          sendJson(res, 200, requestId, {
            ...result,
            flaggedHashCount: await options.store.countFlaggedHashes(),
          });
          return true;
        }
        default:
          sendError(res, 404, requestId, 'NOT_FOUND', 'Unknown risk-control action');
          return true;
      }
    } catch (error) {
      try {
        req.resume();
      } catch {
        // The error response below is stable even when draining fails.
      }
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof RiskControlConfigError) {
        sendError(res, 400, requestId, error.code, error.message);
        return true;
      }
      sendError(res, 503, requestId, 'RISK_CONTROL_UNAVAILABLE', 'Risk control is not available');
      return true;
    }
  };
}

/** Best-effort audit writer into saas_audit_events (failures are swallowed). */
export function createPostgresRiskControlAuditWriter(executor: {
  query(sql: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}): RiskControlAuditWriter {
  return async (input) => {
    await executor.query(
      `INSERT INTO saas_audit_events (id, tenant_id, actor_user_id, action, target_type, target_id,
                                      occurred_at, entry_point, source_ip, user_agent)
       VALUES ($1, NULL, $2, $3, 'risk_control', $4, clock_timestamp(), 'platform-risk-control', $5, $6)`,
      [randomUUID(), input.actorUserId, `saas.${input.action}`, input.targetId, input.sourceIp, input.userAgent],
    );
  };
}
