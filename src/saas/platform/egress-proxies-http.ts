import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { ProviderCredentialSealingKms } from '../credentials/provider-crypto.js';
import type { SqlExecutor } from '../db/types.js';
import {
  type EgressProxyCredentials,
  EgressProxyRecordError,
  normalizeEgressProxyHost,
  normalizeEgressProxyPort,
  normalizeEgressProxyProtocol,
  parseEgressProxyCredentials,
} from '../supply/egress-proxy-record.js';
import { sealEgressProxyCredentials } from '../supply/egress-proxy-seal.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

/**
 * R3 egress proxies admin surface (task #38, F5): the operator CRUD endpoints
 * behind the platform console's supply/proxies view.
 *
 * - POST /admin/api/v1/egress-proxies/list — every proxy with probe quality.
 * - POST /admin/api/v1/egress-proxies/get — one proxy by id.
 * - POST /admin/api/v1/egress-proxies/create | /update — proxy upsert.
 *   Credentials are accepted once in the request ({username?, password?}),
 *   sealed server-side through sealEgressProxyCredentials into the
 *   migration-107 auth_sealed_envelope column, and NEVER echoed: responses
 *   carry only a hasCredentials flag and never the assembled URL.
 * - POST /admin/api/v1/egress-proxies/delete — removal; in-use proxies
 *   (ON DELETE RESTRICT from provider accounts) fail closed with 409.
 *
 * The contract follows the codex-oauth http.ts shape exactly: same-origin
 * POST only, platform session authentication with the operations role, CSRF
 * token on every write, strict JSON with exact-key allowlists, and
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes. Error
 * messages never contain the proxy URL or credential fragments.
 */
const ROUTE_PREFIX = '/admin/api/v1/egress-proxies/';
const ROUTES = new Set(['list', 'get', 'create', 'update', 'delete']);

/** Summary view of a proxy row; no URL, no credentials, no envelope bytes. */
export interface EgressProxyAdminRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  readonly hasCredentials: boolean;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly fallbackMode: string;
  readonly backupProxyId: string | null;
  readonly lastProbeAt: string | null;
  readonly lastProbeLatencyMs: number | null;
  readonly lastProbeIp: string | null;
  readonly lastProbeQuality: string | null;
}

export interface EgressProxyUpsertInput {
  readonly name: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  /** Absent on update = keep the stored envelope; null = clear it. */
  readonly credentials?: EgressProxyCredentials | null;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly fallbackMode: string;
  readonly backupProxyId: string | null;
}

export interface EgressProxyAdminStore {
  list(): Promise<readonly EgressProxyAdminRecord[]>;
  get(id: string): Promise<EgressProxyAdminRecord | null>;
  create(input: EgressProxyUpsertInput): Promise<EgressProxyAdminRecord>;
  update(id: string, input: EgressProxyUpsertInput): Promise<EgressProxyAdminRecord | null>;
  /** false when the row is absent; 'in_use' when accounts still reference it. */
  remove(id: string): Promise<boolean | 'in_use'>;
}

export interface EgressProxiesHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly store: EgressProxyAdminStore;
  readonly audit?: EgressProxyAuditWriter;
  readonly publicOrigin: string;
}

export type EgressProxiesHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type EgressProxyAuditWriter = (input: {
  readonly action: string;
  readonly targetId: string;
  readonly actorUserId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}) => Promise<void>;

export interface PostgresEgressProxyAdminStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly kms: ProviderCredentialSealingKms;
  readonly kmsKeyId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'EgressProxiesHttpError';
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
    throw new HttpError(503, 'EGRESS_PROXIES_UNAVAILABLE', 'Egress proxies are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: EgressProxiesHttpOptions['authService']): Promise<void> {
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
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy input');
  }
  return value;
}

function bodyOptionalId(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  return bodyText(body, name, 128);
}

function bodyIsoTimestamp(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid expiry timestamp');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid expiry timestamp');
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

/** Validates credentials from the request without echoing them in errors. */
function bodyCredentials(body: Record<string, unknown>): EgressProxyCredentials | null | undefined {
  const value = body.credentials;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy credentials');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length === 0 || !keys.every((key) => key === 'username' || key === 'password')) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy credentials');
  }
  try {
    // Strict record-layer validation (control characters, size, emptiness).
    return parseEgressProxyCredentials(candidate);
  } catch {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy credentials');
  }
}

function bodyUpsert(body: Record<string, unknown>, keys: readonly string[]): EgressProxyUpsertInput {
  requireExactKeys(body, keys);
  const fallbackMode = body.fallbackMode;
  if (fallbackMode !== 'none' && fallbackMode !== 'proxy' && fallbackMode !== 'direct') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy input');
  }
  const backupProxyId = bodyOptionalId(body, 'backupProxyId');
  if (fallbackMode === 'proxy' && backupProxyId === null) {
    throw new HttpError(400, 'INVALID_BODY', 'Proxy fallback requires a backup proxy');
  }
  if (fallbackMode !== 'proxy' && backupProxyId !== null) {
    throw new HttpError(400, 'INVALID_BODY', 'A backup proxy requires proxy fallback mode');
  }
  const status = body.status;
  if (status !== 'active' && status !== 'inactive') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid egress proxy input');
  }
  let protocol: string;
  let host: string;
  let port: number;
  try {
    // socks5 auto-upgrades to socks5h (remote DNS); unknown protocols fail.
    protocol = normalizeEgressProxyProtocol(body.protocol);
    host = normalizeEgressProxyHost(body.host);
    port = normalizeEgressProxyPort(body.port);
  } catch (error) {
    if (error instanceof EgressProxyRecordError) {
      throw new HttpError(400, 'EGRESS_PROXY_INVALID_INPUT', 'The egress proxy endpoint is invalid');
    }
    throw error;
  }
  return {
    name: bodyText(body, 'name', 128),
    protocol,
    host,
    port,
    credentials: bodyCredentials(body),
    status,
    expiresAt: bodyIsoTimestamp(body, 'expiresAt'),
    fallbackMode,
    backupProxyId,
  };
}

interface RawProxyRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly protocol: unknown;
  readonly host: unknown;
  readonly port: unknown;
  readonly auth_sealed_envelope: unknown;
  readonly status: unknown;
  readonly expires_at: unknown;
  readonly fallback_mode: unknown;
  readonly backup_proxy_id: unknown;
  readonly last_probe_at: unknown;
  readonly last_probe_latency_ms: unknown;
  readonly last_probe_ip: unknown;
  readonly last_probe_quality: unknown;
}

const PROXY_COLUMNS = `id, name, protocol, host, port, auth_sealed_envelope, status, expires_at,
       fallback_mode, backup_proxy_id, last_probe_at, last_probe_latency_ms, last_probe_ip, last_probe_quality`;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function mapProxyRow(row: RawProxyRow): EgressProxyAdminRecord | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.protocol !== 'string' ||
    typeof row.host !== 'string' ||
    typeof row.port !== 'number' ||
    typeof row.status !== 'string' ||
    typeof row.fallback_mode !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    hasCredentials: row.auth_sealed_envelope !== null && row.auth_sealed_envelope !== undefined,
    status: row.status,
    expiresAt: iso(row.expires_at),
    fallbackMode: row.fallback_mode,
    backupProxyId: textOrNull(row.backup_proxy_id),
    lastProbeAt: iso(row.last_probe_at),
    lastProbeLatencyMs: typeof row.last_probe_latency_ms === 'number' ? row.last_probe_latency_ms : null,
    lastProbeIp: textOrNull(row.last_probe_ip),
    lastProbeQuality: textOrNull(row.last_probe_quality),
  };
}

function pgErrorCode(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

async function writeProxyAudit(
  executor: SqlExecutor,
  input: {
    readonly action: string;
    readonly targetId: string;
    readonly actorUserId: string;
    readonly sourceIp: string | null;
    readonly userAgent: string | null;
  },
): Promise<void> {
  await executor
    .query(
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
          source_ip, user_agent, entry_point)
       VALUES ($1, NULL, $2, $3, 'saas_egress_proxies', $4, clock_timestamp(), $5::inet, $6, 'egress-proxies-http')`,
      [randomUUID(), input.actorUserId, input.action, input.targetId, input.sourceIp, input.userAgent],
    )
    .catch(() => undefined);
}

/** Best-effort audit writer (the probe-monitors precedent). */
export function createPostgresEgressProxyAuditWriter(executor: SqlExecutor): EgressProxyAuditWriter {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return (input) => writeProxyAudit(executor, input);
}

/**
 * The control-plane proxy registry store. Credentials are sealed through the
 * provider-credential KMS envelope (sealEgressProxyCredentials) inside the
 * store, owner-bound to the proxy row id — the same context the probe worker
 * and dispatch paths use to unseal. No method ever returns the envelope, the
 * assembled URL, or credential material.
 */
export function createPostgresEgressProxyAdminStore(
  executor: SqlExecutor,
  options: PostgresEgressProxyAdminStoreOptions,
): EgressProxyAdminStore {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  if (!options || typeof options !== 'object') throw new TypeError('store options are required');
  if (!options.kms || typeof options.kms.generateDataKey !== 'function') throw new TypeError('sealing KMS is required');
  if (typeof options.kmsKeyId !== 'string' || options.kmsKeyId === '') throw new TypeError('kmsKeyId is required');
  if (typeof options.deployment !== 'string' || options.deployment === '')
    throw new TypeError('deployment is required');
  if (typeof options.environment !== 'string' || options.environment === '')
    throw new TypeError('environment is required');

  async function sealFor(proxyId: string, credentials: EgressProxyCredentials): Promise<unknown> {
    const envelope = await sealEgressProxyCredentials(
      credentials,
      { proxyId, deployment: options.deployment, environment: options.environment },
      options.kms,
      options.kmsKeyId,
    );
    return envelope;
  }

  async function requireBackup(backupProxyId: string | null): Promise<void> {
    if (backupProxyId === null) return;
    const rows = await executor.query(`SELECT id FROM saas_egress_proxies WHERE id = $1 LIMIT 2`, [backupProxyId]);
    if (rows.rows.length !== 1) {
      throw new HttpError(404, 'BACKUP_PROXY_NOT_FOUND', 'The backup proxy was not found');
    }
  }

  return {
    async list() {
      const rows = await executor.query<RawProxyRow>(
        `SELECT ${PROXY_COLUMNS} FROM saas_egress_proxies ORDER BY name ASC LIMIT 1000`,
        [],
      );
      return rows.rows.map(mapProxyRow).filter((row): row is EgressProxyAdminRecord => row !== null);
    },

    async get(id) {
      const rows = await executor.query<RawProxyRow>(
        `SELECT ${PROXY_COLUMNS} FROM saas_egress_proxies WHERE id = $1 LIMIT 2`,
        [id],
      );
      const mapped = mapProxyRow(rows.rows[0] ?? ({} as RawProxyRow));
      return mapped;
    },

    async create(input) {
      await requireBackup(input.backupProxyId);
      const id = randomUUID();
      const envelope =
        input.credentials === undefined || input.credentials === null ? null : await sealFor(id, input.credentials);
      const rows = await executor
        .query<RawProxyRow>(
          `INSERT INTO saas_egress_proxies
           (id, name, protocol, host, port, auth_sealed_envelope, status, expires_at, fallback_mode, backup_proxy_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9, $10)
         RETURNING ${PROXY_COLUMNS}`,
          [
            id,
            input.name,
            input.protocol,
            input.host,
            input.port,
            envelope === null ? null : JSON.stringify(envelope),
            input.status,
            input.expiresAt,
            input.fallbackMode,
            input.backupProxyId,
          ],
        )
        .catch((error: unknown) => {
          const code = pgErrorCode(error);
          if (code === '23505')
            throw new HttpError(409, 'PROXY_NAME_CONFLICT', 'A proxy with that name already exists');
          if (code === '23514')
            throw new HttpError(400, 'EGRESS_PROXY_INVALID_INPUT', 'The egress proxy endpoint is invalid');
          throw error;
        });
      const mapped = mapProxyRow(rows.rows[0] ?? ({} as RawProxyRow));
      if (mapped === null) {
        throw new HttpError(503, 'EGRESS_PROXIES_UNAVAILABLE', 'The egress proxy could not be created');
      }
      return mapped;
    },

    async update(id, input) {
      await requireBackup(input.backupProxyId);
      // Credential rotation semantics: absent keeps the stored envelope,
      // null clears it, an object re-seals under the same owner context.
      let envelopeValue: string | null | undefined;
      if (input.credentials !== undefined) {
        envelopeValue = input.credentials === null ? null : JSON.stringify(await sealFor(id, input.credentials));
      }
      const rows = await executor
        .query<RawProxyRow>(
          `UPDATE saas_egress_proxies SET
            name = $2, protocol = $3, host = $4, port = $5,
            status = $7, expires_at = $8::timestamptz, fallback_mode = $9, backup_proxy_id = $10,
            updated_at = clock_timestamp()
            ${envelopeValue === undefined ? '' : ', auth_sealed_envelope = $6::jsonb'}
          WHERE id = $1
          RETURNING ${PROXY_COLUMNS}`,
          envelopeValue === undefined
            ? [
                id,
                input.name,
                input.protocol,
                input.host,
                input.port,
                input.status,
                input.expiresAt,
                input.fallbackMode,
                input.backupProxyId,
              ]
            : [
                id,
                input.name,
                input.protocol,
                input.host,
                input.port,
                envelopeValue,
                input.status,
                input.expiresAt,
                input.fallbackMode,
                input.backupProxyId,
              ],
        )
        .catch((error: unknown) => {
          const code = pgErrorCode(error);
          if (code === '23505')
            throw new HttpError(409, 'PROXY_NAME_CONFLICT', 'A proxy with that name already exists');
          if (code === '23514')
            throw new HttpError(400, 'EGRESS_PROXY_INVALID_INPUT', 'The egress proxy endpoint is invalid');
          throw error;
        });
      return mapProxyRow(rows.rows[0] ?? ({} as RawProxyRow));
    },

    async remove(id) {
      try {
        const rows = await executor.query(`DELETE FROM saas_egress_proxies WHERE id = $1`, [id]);
        return (rows.rowCount ?? 0) > 0;
      } catch (error) {
        if (pgErrorCode(error) === '23503') return 'in_use';
        throw error;
      }
    },
  };
}

export function createEgressProxiesHttpHandler(options: EgressProxiesHttpOptions): EgressProxiesHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.store || typeof options.store.list !== 'function')
    throw new TypeError('egress proxy store is required');

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
      const actorUserId = actor.userId;

      async function audited(action: string, targetId: string): Promise<void> {
        if (!audit) return;
        await audit({ action, targetId, actorUserId, ...metadata }).catch(() => undefined);
      }

      if (action === 'list') {
        requireExactKeys(body, []);
        const proxies = await options.store.list();
        sendJson(res, 200, requestId, { proxies });
        return true;
      }

      if (action === 'get') {
        requireExactKeys(body, ['proxyId']);
        const proxy = await options.store.get(bodyText(body, 'proxyId', 128));
        if (proxy === null) throw new HttpError(404, 'PROXY_NOT_FOUND', 'The egress proxy was not found');
        sendJson(res, 200, requestId, { proxy });
        return true;
      }

      if (action === 'create') {
        const input = bodyUpsert(body, [
          'name',
          'protocol',
          'host',
          'port',
          'credentials',
          'status',
          'expiresAt',
          'fallbackMode',
          'backupProxyId',
        ]);
        const proxy = await options.store.create(input);
        await audited('saas_egress_proxy.created', proxy.id);
        sendJson(res, 200, requestId, { proxy });
        return true;
      }

      if (action === 'update') {
        const proxyId = bodyText(body, 'proxyId', 128);
        const input = bodyUpsert(body, [
          'proxyId',
          'name',
          'protocol',
          'host',
          'port',
          'credentials',
          'status',
          'expiresAt',
          'fallbackMode',
          'backupProxyId',
        ]);
        const proxy = await options.store.update(proxyId, input);
        if (proxy === null) throw new HttpError(404, 'PROXY_NOT_FOUND', 'The egress proxy was not found');
        await audited('saas_egress_proxy.updated', proxyId);
        sendJson(res, 200, requestId, { proxy });
        return true;
      }

      requireExactKeys(body, ['proxyId']);
      const proxyId = bodyText(body, 'proxyId', 128);
      const outcome = await options.store.remove(proxyId);
      if (outcome === false) throw new HttpError(404, 'PROXY_NOT_FOUND', 'The egress proxy was not found');
      if (outcome === 'in_use') {
        throw new HttpError(409, 'PROXY_IN_USE', 'The egress proxy is still bound to provider accounts');
      }
      await audited('saas_egress_proxy.deleted', proxyId);
      sendJson(res, 200, requestId, { deleted: true });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      sendError(res, 503, requestId, 'EGRESS_PROXIES_UNAVAILABLE', 'The egress proxy request could not be completed');
      return true;
    }
  };
}
