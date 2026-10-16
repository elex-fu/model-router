import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { SqlExecutor } from '../db/types.js';
import { type OpenCodeGoProtocolRule, validateOpenCodeGoProtocolRules } from '../gateway/opencode-go/protocol-rules.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

/**
 * R5b opencode-go admin surface (task #38, F5): the adaptive-routing rule
 * table editor endpoints behind the platform console's opencode-go view.
 *
 * - POST /admin/api/v1/opencode-go-rules/read — one account's rule table and
 *   the authorization fence version the CAS mutation must echo.
 * - POST /admin/api/v1/opencode-go-rules/update — CAS mutation
 *   (expectedAuthzVersion → 409 on conflict) with strict
 *   validateOpenCodeGoProtocolRules validation; null clears the override and
 *   restores the default table.
 * - POST /admin/api/v1/opencode-go-models/list — read-only model catalog
 *   view: the merged catalog (upstream ∪ built-in fallback) served by the
 *   injected seam; no mutation surface.
 *
 * The contract follows the codex-oauth http.ts shape exactly: same-origin
 * POST only, platform session authentication with the operations role, CSRF
 * token on every write, strict JSON with exact-key allowlists, and
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes.
 */
const RULES_ROUTE_PREFIX = '/admin/api/v1/opencode-go-rules/';
const RULES_ROUTES = new Set(['read', 'update']);
const MODELS_PATH = '/admin/api/v1/opencode-go-models/list';

export interface OpencodeGoRulesStore {
  read(input: {
    readonly ownerKind: 'tenant' | 'platform';
    readonly tenantId: string | null;
    readonly accountId: string;
  }): Promise<{ readonly authzVersion: number; readonly rules: unknown } | null>;
  update(input: {
    readonly ownerKind: 'tenant' | 'platform';
    readonly tenantId: string | null;
    readonly accountId: string;
    readonly rulesJson: string | null;
    readonly expectedAuthzVersion: number;
  }): Promise<{ readonly authzVersion: number; readonly rules: unknown } | null>;
}

export interface OpencodeGoRulesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly store: OpencodeGoRulesStore;
  readonly audit?: OpencodeGoRulesAuditWriter;
  readonly publicOrigin: string;
}

export type OpencodeGoRulesAuditWriter = (input: {
  readonly action: string;
  readonly targetId: string;
  readonly tenantId: string | null;
  readonly actorUserId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}) => Promise<void>;

export type OpencodeGoRulesHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface OpencodeGoModelCatalogHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  /** Serves the merged model catalog (upstream ∪ built-in fallback). */
  readonly resolveModels: () => Promise<readonly string[]> | readonly string[];
  readonly publicOrigin: string;
}

export type OpencodeGoModelCatalogHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'OpencodeGoRulesHttpError';
  }
}

function rulesRoute(pathname: string): string | undefined {
  if (!pathname.startsWith(RULES_ROUTE_PREFIX)) return undefined;
  const action = pathname.slice(RULES_ROUTE_PREFIX.length);
  return RULES_ROUTES.has(action) ? action : undefined;
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

function requireOrigin(req: IncomingMessage, publicOrigin: string, unavailableCode: string): void {
  let expected: URL;
  try {
    expected = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, unavailableCode, 'The opencode-go admin surface is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>,
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
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid opencode-go input');
  }
  return value;
}

/** The shared owner-kind + tenant scoping of both rule endpoints. */
function bodyAccountScope(body: Record<string, unknown>): {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
} {
  const ownerKind = body.ownerKind;
  if (ownerKind !== 'tenant' && ownerKind !== 'platform') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid opencode-go input');
  }
  const accountId = bodyText(body, 'accountId', 128);
  if (ownerKind === 'tenant') {
    return { ownerKind, tenantId: bodyText(body, 'tenantId', 64), accountId };
  }
  if (body.tenantId !== undefined && body.tenantId !== null) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid opencode-go input');
  }
  return { ownerKind, tenantId: null, accountId };
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

/** Strict parse of a stored or submitted rule table; invalid input is a 400. */
function parseRules(value: unknown, code: string): readonly OpenCodeGoProtocolRule[] | null {
  if (value === null || value === undefined) return null;
  const validation = validateOpenCodeGoProtocolRules(value);
  if (!validation.valid) throw new HttpError(400, code, validation.reason);
  return validation.rules;
}

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

interface RulesRow {
  readonly authz_version: unknown;
  readonly opencode_go_protocol_rules: unknown;
}

function nonNegativeInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new HttpError(503, 'OPENCODE_GO_RULES_UNAVAILABLE', 'The rule table could not be read');
  }
  return result;
}

/**
 * The control-plane rule-table store (the migration-108 SQL surface the
 * usage-store documents for this endpoint): read returns the raw jsonb plus
 * the authz_version fence; update is the 047/082 CAS shape. No credentials
 * are involved on this path.
 */
export function createPostgresOpencodeGoRulesStore(executor: SqlExecutor): OpencodeGoRulesStore {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');

  function predicate(
    input: { readonly ownerKind: 'tenant' | 'platform'; readonly tenantId: string | null; readonly accountId: string },
    next: number,
  ): { sql: string; values: unknown[] } {
    if (input.ownerKind === 'tenant') {
      if (typeof input.tenantId !== 'string') {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid opencode-go input');
      }
      return { sql: `tenant_id = $${next} AND id = $${next + 1}`, values: [input.tenantId, input.accountId] };
    }
    return { sql: `id = $${next}`, values: [input.accountId] };
  }

  return {
    async read(input) {
      const table = ACCOUNT_TABLES[input.ownerKind];
      const where = predicate(input, 1);
      const rows = await executor.query<RulesRow>(
        `SELECT authz_version, opencode_go_protocol_rules
           FROM ${table}
          WHERE ${where.sql}
          LIMIT 1`,
        where.values,
      );
      const row = rows.rows[0];
      if (!row) return null;
      return { authzVersion: nonNegativeInteger(row.authz_version), rules: row.opencode_go_protocol_rules };
    },

    async update(input) {
      const table = ACCOUNT_TABLES[input.ownerKind];
      const where = predicate(input, 1);
      const rows = await executor.query<RulesRow>(
        `UPDATE ${table}
            SET opencode_go_protocol_rules = $${where.values.length + 1}::jsonb,
                authz_version = authz_version + 1,
                updated_at = clock_timestamp()
          WHERE ${where.sql}
            AND authz_version = $${where.values.length + 2}
          RETURNING authz_version, opencode_go_protocol_rules`,
        [...where.values, input.rulesJson, input.expectedAuthzVersion],
      );
      const row = rows.rows[0];
      if (!row) return null;
      return { authzVersion: nonNegativeInteger(row.authz_version), rules: row.opencode_go_protocol_rules };
    },
  };
}

/** Best-effort audit writer (the probe-monitors precedent). */
export function createPostgresOpencodeGoRulesAuditWriter(executor: SqlExecutor): OpencodeGoRulesAuditWriter {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return async (input) => {
    await executor
      .query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
            source_ip, user_agent, entry_point)
         VALUES ($1, $2, $3, $4, 'saas_provider_accounts', $5, clock_timestamp(), $6::inet, $7, 'opencode-go-rules-http')`,
        [
          randomUUID(),
          input.tenantId,
          input.actorUserId,
          input.action,
          input.targetId,
          input.sourceIp,
          input.userAgent,
        ],
      )
      .catch(() => undefined);
  };
}

export function createOpencodeGoRulesHttpHandler(options: OpencodeGoRulesHttpOptions): OpencodeGoRulesHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.store || typeof options.store.read !== 'function' || typeof options.store.update !== 'function') {
    throw new TypeError('opencode-go rules store is required');
  }

  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      const action = rulesRoute(url.pathname);
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
      requireOrigin(req, options.publicOrigin, 'OPENCODE_GO_RULES_UNAVAILABLE');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      const metadata = requestMetadata(req);

      if (action === 'read') {
        requireExactKeys(body, ['ownerKind', 'tenantId', 'accountId']);
        const scope = bodyAccountScope(body);
        const state = await options.store.read(scope);
        if (state === null) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'The provider account was not found');
        // A stored rule table must be valid; a corrupt column is a storage
        // integrity failure, surfaced as a generic 503.
        const rules = parseRules(state.rules, 'OPENCODE_GO_RULES_UNAVAILABLE');
        sendJson(res, 200, requestId, { authzVersion: state.authzVersion, rules });
        return true;
      }

      requireExactKeys(body, ['ownerKind', 'tenantId', 'accountId', 'expectedAuthzVersion', 'rules']);
      const scope = bodyAccountScope(body);
      const expected = body.expectedAuthzVersion;
      if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid expected version');
      }
      const rules = parseRules(body.rules, 'INVALID_OPENCODE_GO_RULES');
      const existing = await options.store.read(scope);
      if (existing === null) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'The provider account was not found');
      const updated = await options.store.update({
        ...scope,
        rulesJson: rules === null ? null : JSON.stringify(rules),
        expectedAuthzVersion: expected,
      });
      if (updated === null) {
        throw new HttpError(409, 'VERSION_CONFLICT', 'The rule table was modified concurrently; reload and retry');
      }
      const storedRules = parseRules(updated.rules, 'OPENCODE_GO_RULES_UNAVAILABLE');
      if (options.audit) {
        await options
          .audit({
            action: 'saas_provider_account.opencode_go_protocol_rules.updated',
            targetId: scope.accountId,
            tenantId: scope.tenantId,
            actorUserId: actor.userId,
            sourceIp: metadata.sourceIp,
            userAgent: metadata.userAgent,
          })
          .catch(() => undefined);
      }
      sendJson(res, 200, requestId, { authzVersion: updated.authzVersion, rules: storedRules });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      sendError(res, 503, requestId, 'OPENCODE_GO_RULES_UNAVAILABLE', 'The rule table request could not be completed');
      return true;
    }
  };
}

export function createOpencodeGoModelCatalogHttpHandler(
  options: OpencodeGoModelCatalogHttpOptions,
): OpencodeGoModelCatalogHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (typeof options?.resolveModels !== 'function') throw new TypeError('resolveModels is required');

  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      if (url.pathname !== MODELS_PATH) return false;
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
      requireOrigin(req, options.publicOrigin, 'OPENCODE_GO_MODELS_UNAVAILABLE');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      requireExactKeys(body, []);
      const models = await options.resolveModels();
      if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
        throw new HttpError(503, 'OPENCODE_GO_MODELS_UNAVAILABLE', 'The model catalog could not be read');
      }
      sendJson(res, 200, requestId, { models });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      sendError(res, 503, requestId, 'OPENCODE_GO_MODELS_UNAVAILABLE', 'The model catalog could not be read');
      return true;
    }
  };
}
