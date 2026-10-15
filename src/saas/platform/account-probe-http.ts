import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { SqlExecutor } from '../db/types.js';
import { type AccountProbeCategory, accountProbeCategoryForProvider } from '../supply/account-probe-service.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

/**
 * R6a active probing admin surface (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6a, task #32; migration 109): the operator endpoints behind the
 * platform console's supply/accounts view.
 *
 * - POST /admin/api/v1/probe-monitors/trigger: create-or-queue a monitor for
 *   one account. The probe itself executes asynchronously in the probe
 *   monitor worker (the credential-validation-worker workload — the only
 *   non-gateway runtime with a credential decrypt KMS), so the endpoint
 *   marks the monitor due (next_due_at + probe_requested_at = now) and
 *   returns the queued state; the worker records the run with
 *   triggered_by = 'manual'.
 * - POST /admin/api/v1/probe-monitors/list: bounded monitor listing with the
 *   last probe summary.
 *
 * The contract follows the codex-oauth http.ts shape exactly: same-origin
 * POST only, platform session authentication with the operations role, CSRF
 * token on every write, strict JSON with exact-key allowlists, and
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes. No secrets
 * ever appear in requests or responses.
 *
 * The console UI button is out of scope for R6a (noted in the plan); this
 * surface is the API it will call.
 */

const ROUTE_PREFIX = '/admin/api/v1/probe-monitors/';
const ROUTES = new Set(['trigger', 'list']);
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

export interface ProbeMonitorSummary {
  readonly id: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  readonly category: AccountProbeCategory;
  readonly probeIntervalSeconds: number;
  readonly failureThreshold: number;
  readonly consecutiveFailures: number;
  readonly lastResult: string | null;
  readonly lastRunAt: string | null;
  readonly nextDueAt: string | null;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface ProbeMonitorTriggerResult {
  readonly monitor: ProbeMonitorSummary;
  /** Always true: the probe executes in the worker, not in this handler. */
  readonly queued: true;
}

export interface ProbeMonitorAdminStore {
  triggerMonitor(input: {
    readonly ownerKind: 'tenant' | 'platform';
    readonly tenantId: string | null;
    readonly accountId: string;
    readonly actorUserId: string;
    readonly sourceIp: string | null;
    readonly userAgent: string | null;
  }): Promise<ProbeMonitorTriggerResult>;
  listMonitors(input: {
    readonly ownerKind?: 'tenant' | 'platform';
    readonly tenantId?: string;
    readonly accountId?: string;
    readonly limit: number;
  }): Promise<readonly ProbeMonitorSummary[]>;
}

export interface AccountProbeHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly store: ProbeMonitorAdminStore;
  readonly publicOrigin: string;
}

export type AccountProbeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'AccountProbeHttpError';
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
    throw new HttpError(503, 'ACCOUNT_PROBE_UNAVAILABLE', 'Account probing is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: AccountProbeHttpOptions['authService']): Promise<void> {
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
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
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

/**
 * The default arithmetic few-shot challenge (sub2api semantics): a random
 * small addition whose response must be digits only, exactly compared.
 */
export function generateArithmeticChallenge(): {
  readonly prompt: string;
  readonly answer: string;
} {
  const left = 2 + randomInt(48);
  const right = 2 + randomInt(48);
  return {
    prompt: `What is ${left} + ${right}? Reply with only the number.`,
    answer: String(left + right),
  };
}

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

interface MonitorSummaryRow {
  readonly id: unknown;
  readonly owner_kind: unknown;
  readonly owner_tenant_id: unknown;
  readonly account_id: unknown;
  readonly provider_category: unknown;
  readonly probe_interval_seconds: unknown;
  readonly failure_threshold: unknown;
  readonly consecutive_failures: unknown;
  readonly last_result: unknown;
  readonly last_run_at: unknown;
  readonly next_due_at: unknown;
  readonly enabled: unknown;
  readonly updated_at: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

function mapSummaryRow(row: MonitorSummaryRow): ProbeMonitorSummary | null {
  const id = text(row.id);
  const accountId = text(row.account_id);
  const category = text(row.provider_category);
  const interval = typeof row.probe_interval_seconds === 'number' ? row.probe_interval_seconds : null;
  const threshold = typeof row.failure_threshold === 'number' ? row.failure_threshold : null;
  const failures = typeof row.consecutive_failures === 'number' ? row.consecutive_failures : null;
  const updatedAt = iso(row.updated_at);
  if (
    id === null ||
    accountId === null ||
    interval === null ||
    threshold === null ||
    failures === null ||
    updatedAt === null ||
    typeof row.enabled !== 'boolean' ||
    (category !== 'claude' && category !== 'codex' && category !== 'opencode-go' && category !== 'api-key')
  ) {
    return null;
  }
  if (row.owner_kind === 'tenant') {
    const tenantId = text(row.owner_tenant_id);
    if (tenantId === null) return null;
    return {
      id,
      ownerKind: 'tenant',
      ownerTenantId: tenantId,
      accountId,
      category,
      probeIntervalSeconds: interval,
      failureThreshold: threshold,
      consecutiveFailures: failures,
      lastResult: text(row.last_result),
      lastRunAt: iso(row.last_run_at),
      nextDueAt: iso(row.next_due_at),
      enabled: row.enabled,
      updatedAt,
    };
  }
  if (row.owner_kind !== 'platform') return null;
  return {
    id,
    ownerKind: 'platform',
    ownerTenantId: null,
    accountId,
    category,
    probeIntervalSeconds: interval,
    failureThreshold: threshold,
    consecutiveFailures: failures,
    lastResult: text(row.last_result),
    lastRunAt: iso(row.last_run_at),
    nextDueAt: iso(row.next_due_at),
    enabled: row.enabled,
    updatedAt,
  };
}

const MONITOR_SUMMARY_COLUMNS = `id, owner_kind, owner_tenant_id, account_id, provider_category,
       probe_interval_seconds, failure_threshold, consecutive_failures, last_result,
       last_run_at, next_due_at, enabled, updated_at`;

/**
 * The control-plane monitor registry store. All writes stay on the
 * control-plane role's manifest (roles.sql); the probe itself executes in the
 * validation-worker runtime.
 */
export function createPostgresProbeMonitorAdminStore(executor: SqlExecutor): ProbeMonitorAdminStore {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return {
    async triggerMonitor(input) {
      if (
        (input.ownerKind !== 'tenant' && input.ownerKind !== 'platform') ||
        (input.ownerKind === 'tenant' && typeof input.tenantId !== 'string') ||
        typeof input.accountId !== 'string' ||
        input.accountId === ''
      ) {
        throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
      }
      const accounts = ACCOUNT_TABLES[input.ownerKind];
      const accountRows = await executor.query<{ readonly provider_id: unknown }>(
        input.ownerKind === 'tenant'
          ? `SELECT provider_id FROM ${accounts} WHERE tenant_id = $1 AND id = $2 LIMIT 1`
          : `SELECT provider_id FROM ${accounts} WHERE id = $1 LIMIT 1`,
        input.ownerKind === 'tenant' ? [input.tenantId, input.accountId] : [input.accountId],
      );
      const account = accountRows.rows[0];
      const providerId = text(account?.provider_id);
      if (providerId === null) {
        throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'The provider account was not found');
      }
      const category = accountProbeCategoryForProvider(providerId);
      if (category === null) {
        throw new HttpError(422, 'PROBE_CATEGORY_UNSUPPORTED', 'The provider account has no probe category');
      }
      const challenge = generateArithmeticChallenge();
      const ownerScopeKey = input.ownerKind === 'tenant' ? (input.tenantId as string) : 'platform';
      const inserted = await executor.query<MonitorSummaryRow>(
        `INSERT INTO saas_probe_monitors
           (id, owner_scope_key, owner_kind, owner_tenant_id, account_id, provider_category,
            probe_interval_seconds, challenge_prompt, challenge_answer, failure_threshold,
            next_due_at, probe_requested_at, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, 300, $7, $8, 3, clock_timestamp(), clock_timestamp(), true)
         ON CONFLICT (owner_scope_key, account_id) DO UPDATE
           SET next_due_at = clock_timestamp(),
               probe_requested_at = clock_timestamp(),
               enabled = true,
               updated_at = clock_timestamp()
         RETURNING ${MONITOR_SUMMARY_COLUMNS}`,
        [
          randomUUID(),
          ownerScopeKey,
          input.ownerKind,
          input.ownerKind === 'tenant' ? (input.tenantId as string) : null,
          input.accountId,
          category,
          challenge.prompt,
          challenge.answer,
        ],
      );
      const summary = mapSummaryRow(inserted.rows[0] ?? ({} as MonitorSummaryRow));
      if (summary === null) {
        throw new HttpError(503, 'ACCOUNT_PROBE_UNAVAILABLE', 'The probe monitor could not be queued');
      }
      await executor
        .query(
          `INSERT INTO saas_audit_events
             (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
              source_ip, user_agent, entry_point)
           VALUES ($1, $2, $3, 'saas_probe_monitor.manual_trigger', 'saas_probe_monitors', $4,
                   clock_timestamp(), $5::inet, $6, 'account-probe-http')`,
          [
            randomUUID(),
            input.ownerKind === 'tenant' ? input.tenantId : null,
            input.actorUserId,
            summary.id,
            input.sourceIp,
            input.userAgent,
          ],
        )
        .catch(() => undefined);
      return { monitor: summary, queued: true };
    },

    async listMonitors(input) {
      const limit =
        typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit >= 1
          ? Math.min(input.limit, MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT;
      const filters: string[] = [];
      const values: unknown[] = [];
      if (input.ownerKind === 'tenant' || input.ownerKind === 'platform') {
        values.push(input.ownerKind);
        filters.push(`owner_kind = $${values.length}`);
        if (input.ownerKind === 'tenant') {
          if (typeof input.tenantId !== 'string') {
            throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
          }
          values.push(input.tenantId);
          filters.push(`owner_tenant_id = $${values.length}`);
        }
      }
      if (typeof input.accountId === 'string' && input.accountId !== '') {
        values.push(input.accountId);
        filters.push(`account_id = $${values.length}`);
      }
      values.push(limit);
      const rows = await executor.query<MonitorSummaryRow>(
        `SELECT ${MONITOR_SUMMARY_COLUMNS}
           FROM saas_probe_monitors
          ${filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`}
          ORDER BY updated_at DESC
          LIMIT $${values.length}`,
        values,
      );
      return rows.rows.map(mapSummaryRow).filter((row): row is ProbeMonitorSummary => row !== null);
    },
  };
}

export function createAccountProbeHttpHandler(options: AccountProbeHttpOptions): AccountProbeHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (
    !options?.store ||
    typeof options.store.triggerMonitor !== 'function' ||
    typeof options.store.listMonitors !== 'function'
  ) {
    throw new TypeError('probe monitor store is required');
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

      if (action === 'trigger') {
        requireExactKeys(body, ['ownerKind', 'tenantId', 'accountId']);
        const ownerKind = body.ownerKind;
        if (ownerKind !== 'tenant' && ownerKind !== 'platform') {
          throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
        }
        const tenantId =
          ownerKind === 'tenant'
            ? bodyText(body, 'tenantId', 64)
            : body.tenantId === undefined || body.tenantId === null
              ? null
              : invalidTenantId();
        const result = await options.store.triggerMonitor({
          ownerKind,
          tenantId,
          accountId: bodyText(body, 'accountId', 256),
          actorUserId: actor.userId,
          ...metadata,
        });
        sendJson(res, 200, requestId, {
          monitorId: result.monitor.id,
          accountId: result.monitor.accountId,
          ownerKind: result.monitor.ownerKind,
          category: result.monitor.category,
          queued: result.queued,
          lastResult: result.monitor.lastResult,
          lastRunAt: result.monitor.lastRunAt,
          consecutiveFailures: result.monitor.consecutiveFailures,
        });
        return true;
      }

      requireExactKeys(body, ['ownerKind', 'tenantId', 'accountId', 'limit']);
      const ownerKind =
        body.ownerKind === undefined || body.ownerKind === null
          ? undefined
          : body.ownerKind === 'tenant' || body.ownerKind === 'platform'
            ? body.ownerKind
            : invalidOwnerKind();
      const tenantId =
        body.tenantId === undefined || body.tenantId === null ? undefined : bodyText(body, 'tenantId', 64);
      const accountId =
        body.accountId === undefined || body.accountId === null ? undefined : bodyText(body, 'accountId', 256);
      const limit =
        body.limit === undefined || body.limit === null
          ? DEFAULT_LIST_LIMIT
          : typeof body.limit === 'number' && Number.isSafeInteger(body.limit) && body.limit >= 1
            ? body.limit
            : invalidLimit();
      const monitors = await options.store.listMonitors({
        ...(ownerKind === undefined ? {} : { ownerKind }),
        ...(ownerKind === 'tenant' && tenantId !== undefined ? { tenantId } : {}),
        ...(accountId === undefined ? {} : { accountId }),
        limit,
      });
      sendJson(res, 200, requestId, {
        monitors: monitors.map((monitor) => ({
          monitorId: monitor.id,
          ownerKind: monitor.ownerKind,
          ownerTenantId: monitor.ownerTenantId,
          accountId: monitor.accountId,
          category: monitor.category,
          probeIntervalSeconds: monitor.probeIntervalSeconds,
          failureThreshold: monitor.failureThreshold,
          consecutiveFailures: monitor.consecutiveFailures,
          lastResult: monitor.lastResult,
          lastRunAt: monitor.lastRunAt,
          nextDueAt: monitor.nextDueAt,
          enabled: monitor.enabled,
          updatedAt: monitor.updatedAt,
        })),
      });
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      sendError(res, 503, requestId, 'ACCOUNT_PROBE_UNAVAILABLE', 'The account probe request could not be completed');
      return true;
    }
  };
}

function invalidTenantId(): never {
  throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
}

function invalidOwnerKind(): never {
  throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
}

function invalidLimit(): never {
  throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid probe input');
}
