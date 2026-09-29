import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ConfigV2, UpstreamDefinition } from '../config/v2-schema.js';
import type { ConfigDiff } from '../control/service.js';
import { ConfigConflictError, ConfigValidationError, ControlError, ControlService } from '../control/service.js';
import { ControlStore } from '../control/store.js';
import type { SQLiteQuotaLedger } from '../quota/ledger.js';
import type { QuotaTimezoneVersions } from '../quota/timezone-versions.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import type { TelemetryWriterStatus } from '../storage/telemetry-write-client.js';
import { connectTemplate } from './connect.js';
import { AdminExports } from './exports.js';
import { AdminJobs } from './jobs.js';
import { AdminMaintenance } from './maintenance.js';
import { adminOpenApiDocument, parseAdminRequest } from './openapi.js';
import { type PlaygroundExecutor, PlaygroundRuns } from './playground.js';
import { validatePricing } from './pricing.js';
import { AdminRuntime, type AdminRuntimeBridge } from './runtime.js';
import { telemetryAdapters } from './telemetry.js';
import { UpstreamActions } from './upstream-actions.js';

type Json = Record<string, unknown>;
type Handler = (input: Json) => Promise<unknown>;
export type AdminMountedRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function redactInlineValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInlineValues);
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (item.type === 'inline' && typeof item.value === 'string') return { ...item, value: '' };
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redactInlineValues(child)]));
}

function databaseDiagnostics(controlStore: ControlStore, telemetryStore: SQLiteTelemetryStore | undefined): Json {
  const inspect = (db: import('better-sqlite3').Database | undefined) => {
    const unavailableCapacity = {
      pageCount: null,
      pageSizeBytes: null,
      freePages: null,
      allocatedBytes: null,
      freeBytes: null,
      reason: 'connection_unavailable',
    };
    if (!db)
      return {
        health: { status: 'unavailable', scope: 'connection', reason: 'database_not_configured' },
        capacity: { ...unavailableCapacity, reason: 'database_not_configured' },
      };
    if (!db.open)
      return {
        health: { status: 'unavailable', scope: 'connection', reason: 'connection_closed' },
        capacity: unavailableCapacity,
      };
    try {
      const ping = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      if (ping?.ok !== 1)
        return {
          health: { status: 'unavailable', scope: 'connection', reason: 'ping_failed' },
          capacity: { ...unavailableCapacity, reason: 'ping_failed' },
        };
      let pageCount: number;
      let pageSizeBytes: number;
      let freePages: number;
      try {
        pageCount = Number((db.pragma('page_count') as Array<{ page_count: number }>)[0]?.page_count);
        pageSizeBytes = Number((db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size);
        freePages = Number((db.pragma('freelist_count') as Array<{ freelist_count: number }>)[0]?.freelist_count);
        if (![pageCount, pageSizeBytes, freePages].every(Number.isSafeInteger))
          throw new Error('invalid_sqlite_metrics');
      } catch {
        return {
          health: { status: 'available', scope: 'connection', reason: null },
          capacity: { ...unavailableCapacity, reason: 'sqlite_metrics_unavailable' },
        };
      }
      return {
        health: { status: 'available', scope: 'connection', reason: null },
        capacity: {
          pageCount,
          pageSizeBytes,
          freePages,
          allocatedBytes: pageCount * pageSizeBytes,
          freeBytes: freePages * pageSizeBytes,
          reason: null,
        },
      };
    } catch {
      return {
        health: { status: 'unavailable', scope: 'connection', reason: 'ping_failed' },
        capacity: { ...unavailableCapacity, reason: 'ping_failed' },
      };
    }
  };
  return { control: inspect(controlStore.db), telemetry: inspect(telemetryStore?.connection) };
}
export interface AdminAdapters {
  system?: Handler;
  overview?: Handler;
  upstreamRuntime?: Handler;
  healthEvents?: Handler;
  discoverModels?: Handler;
  testUpstream?: Handler;
  resetCircuit?: Handler;
  keyQuota?: Handler;
  quotaAdjustment?: Handler;
  usageSummary?: Handler;
  usageTimeseries?: Handler;
  usageBreakdown?: Handler;
  requests?: Handler;
  requestDetail?: Handler;
  requestAttempts?: Handler;
  exportCreate?: Handler;
  exportDownload?: Handler;
  playgroundRun?: Handler;
  playgroundCancel?: Handler;
  accounts?: Handler;
  accountClientCredentials?: Handler;
  deviceFlowCreate?: Handler;
  deviceFlowDetail?: Handler;
  deviceFlowCancel?: Handler;
  accountPatch?: Handler;
  accountDelete?: Handler;
  accountRefresh?: Handler;
  balances?: Handler;
  balancesRefresh?: Handler;
  maintenanceJob?: Handler;
  jobDetail?: Handler;
}

export interface AdminServerOptions {
  configPath: string;
  controlStore?: ControlStore;
  controlService?: ControlService;
  applyConfig?: (next: ConfigV2, changes: ConfigDiff[]) => Promise<number>;
  telemetryStore?: SQLiteTelemetryStore;
  recorderStatus?: () => TelemetryWriterStatus;
  quotaLedger?: SQLiteQuotaLedger;
  quotaTimezoneVersions?: QuotaTimezoneVersions;
  webDistPath?: string;
  /** Live health/circuit objects owned by the proxy process. */
  runtime?: AdminRuntimeBridge;
  /** Optional core executor for cross-protocol playground routes and runtime quota semantics. */
  playgroundExecutor?: PlaygroundExecutor;
  /** One-use, short-lived token generated locally by the process owner. */
  bootstrapToken?: string;
  bootstrapExpiresAt?: number;
  /** Public browser origin, for deployments where the listener is behind a reverse proxy. */
  publicOrigin?: string | (() => string);
  /** Read-only process-owned listener diagnostics used by GET /system. */
  listenerStatus?: () => unknown;
  /** Optional customer-facing SaaS handler mounted under /console/api/v1. */
  saasIdentityHandler?: AdminMountedRequestHandler;
  adapters?: AdminAdapters;
}

export interface AdminServer {
  server: Server;
  control: ControlService;
  store: ControlStore;
  close(): Promise<void>;
}

const PREFIX = '/admin/api/v1';
/** Dispatch patterns implemented below. Kept beside the dispatcher so OpenAPI parity tests catch route drift. */
export const adminDispatchOperations = [
  'GET /openapi.json','GET /bootstrap','POST /bootstrap','POST /session','GET /session','DELETE /session',
  'GET /config','PUT /config','GET /config/export','POST /config/validate','POST /config/import-preview','POST /config/import','GET /config/history','POST /config/rollback',
  'GET /provider-presets','GET /capabilities','GET /system','GET /overview',
  'GET /upstreams','GET /upstreams/{id}','POST /upstreams','PATCH /upstreams/{id}','DELETE /upstreams/{id}',
  'POST /upstreams/{id}/credentials','PATCH /upstreams/{id}/credentials/{credentialId}','DELETE /upstreams/{id}/credentials/{credentialId}',
  'POST /upstreams/{id}/discover-models','POST /upstreams/{id}/test','POST /upstreams/{id}/test-jobs/{jobId}/cancel','GET /upstreams/{id}/runtime','GET /upstreams/{id}/health-events','POST /upstreams/{id}/circuit-reset',
  'GET /routes','GET /routes/{id}','POST /routes','PATCH /routes/{id}','DELETE /routes/{id}','PUT /routes/order','POST /routes/preview','GET /models',
  'GET /keys','GET /keys/{id}','POST /keys','PATCH /keys/{id}','DELETE /keys/{id}','POST /keys/{id}/rotate','GET /keys/{id}/quota','POST /keys/{id}/quota-adjustments',
  'GET /usage/summary','GET /usage/timeseries','GET /usage/breakdown','GET /requests','GET /requests/{id}','GET /requests/{id}/attempts',
  'POST /exports','GET /exports/{id}/download','POST /playground/runs','GET /playground/runs/{id}','GET /playground/status','POST /playground/runs/{id}/cancel',
  'GET /connect/templates','GET /pricing','POST /pricing','PATCH /pricing/{id}','GET /accounts','POST /accounts/client-credentials','POST /accounts/device-flows',
  'GET /accounts/device-flows/{id}','DELETE /accounts/device-flows/{id}','PATCH /accounts/{id}','DELETE /accounts/{id}','POST /accounts/{id}/refresh',
  'GET /balances','POST /balances/refresh','GET /audit-events','POST /maintenance/jobs','GET /jobs/{id}','GET /events',
] as const;
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ADMIN_RATE_LIMIT = 120;
const ADMIN_RATE_WINDOW_MS = 60_000;
const ADMIN_RATE_CLIENT_CAPACITY = 10_000;
export class AdminRequestRateLimiter {
  private readonly clients = new Map<string, { count: number; until: number }>();
  private lastCleanupAt = 0;

  take(client: string, now: number): number | undefined {
    if (now - this.lastCleanupAt >= ADMIN_RATE_WINDOW_MS) {
      for (const [key, entry] of this.clients) {
        if (entry.until <= now) this.clients.delete(key);
      }
      this.lastCleanupAt = now;
    }
    let entry = this.clients.get(client);
    if (!entry || entry.until <= now) {
      if (this.clients.size >= ADMIN_RATE_CLIENT_CAPACITY) {
        for (const [key, candidate] of this.clients) {
          if (candidate.until <= now) this.clients.delete(key);
        }
        if (this.clients.size >= ADMIN_RATE_CLIENT_CAPACITY) {
          const oldest = this.clients.keys().next().value as string | undefined;
          if (oldest !== undefined) this.clients.delete(oldest);
        }
      }
      entry = { count: 0, until: now + ADMIN_RATE_WINDOW_MS };
      this.clients.set(client, entry);
    }
    if (entry.count >= ADMIN_RATE_LIMIT) return Math.max(1, Math.ceil((entry.until - now) / 1000));
    entry.count++;
    return undefined;
  }
}
const presets = [
  {
    id: 'kimi-platform',
    provider: 'kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    generate: 'chat/completions',
    auth: 'bearer',
  },
  {
    id: 'kimi-platform-global',
    provider: 'kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    generate: 'chat/completions',
    auth: 'bearer',
  },
  {
    id: 'kimi-code',
    provider: 'kimi',
    protocol: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/v1',
    generate: 'messages',
    auth: 'x-api-key',
  },
  {
    id: 'kimi-code-global',
    provider: 'kimi',
    protocol: 'anthropic',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    generate: 'messages',
    auth: 'x-api-key',
  },
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    generate: 'chat/completions',
    auth: 'bearer',
  },
  {
    id: 'deepseek-anthropic',
    provider: 'deepseek',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic/v1',
    generate: 'messages',
    auth: 'x-api-key',
  },
  { id: 'custom-openai', provider: 'custom', protocol: 'openai', generate: 'chat/completions', auth: 'bearer' },
  { id: 'custom-anthropic', provider: 'custom', protocol: 'anthropic', generate: 'messages', auth: 'x-api-key' },
  { id: 'custom-responses', provider: 'custom', protocol: 'responses', generate: 'responses', auth: 'bearer' },
].map(({ generate, auth, ...preset }) => ({
  ...preset,
  name: preset.id.replaceAll('-', ' '),
  baseUrl: preset.baseUrl ?? '',
  endpoints: { generate, ...(preset.protocol === 'openai' ? { models: 'models' } : {}) },
  auth: { mode: auth },
}));

function send(res: ServerResponse, status: number, requestId: string, data: unknown, extra?: Json): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify({ data, meta: { requestId, observedAt: new Date().toISOString(), ...extra } }));
}
function fail(
  res: ServerResponse,
  status: number,
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }), requestId } }));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new ControlError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ControlError(400, 'INVALID_JSON', 'Invalid JSON body');
  }
}
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const requiredString = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new ControlError(400, 'INVALID_BODY', `${name} is required`);
  return value;
};
function expectedRevision(req: IncomingMessage): number {
  const match = /^"cfg-(\d+)"$/.exec(String(req.headers['if-match'] ?? ''));
  if (!match) throw new ControlError(428, 'IF_MATCH_REQUIRED', 'Use If-Match: "cfg-N"');
  return Number(match[1]);
}
function pathParts(path: string): string[] {
  return path.slice(PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent);
}
function tokenCookie(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)mr_admin_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

function serveMountedStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  mountPath: '/admin' | '/console',
  distPath?: string,
): void {
  if (!distPath || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (path === mountPath) {
    res.writeHead(308, { location: `${mountPath}/` });
    res.end();
    return;
  }
  if (
    !path.startsWith(`${mountPath}/`) ||
    (mountPath === '/admin' && (path === '/admin/api' || path.startsWith('/admin/api/'))) ||
    (mountPath === '/console' && (path === '/console/api' || path.startsWith('/console/api/')))
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  let file = path.slice(`${mountPath}/`.length);
  try {
    file = decodeURIComponent(file);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    file
      .split('/')
      .some(
        (part) =>
          part === '..' || part.startsWith('.') || ['admin-exports', 'admin-backups', 'data', 'secrets'].includes(part),
      ) ||
    file.startsWith('/')
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (basename(file) === 'config.json' || (extname(file) && !mime[extname(file)])) {
    res.writeHead(404);
    res.end();
    return;
  }
  const root = resolve(distPath);
  if (!existsSync(root)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const safe = (target: string) => {
    const rel = relative(realpathSync(root), realpathSync(target));
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  let target = resolve(root, file || 'index.html');
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (file && (extname(file) || !String(req.headers.accept ?? '').includes('text/html'))) {
      res.writeHead(404);
      res.end();
      return;
    }
    target = resolve(root, 'index.html');
  }
  if (!existsSync(target) || !statSync(target).isFile() || !safe(target)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': mime[extname(target)] ?? 'application/octet-stream',
    'content-length': statSync(target).size,
    'cache-control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, distPath?: string): void {
  serveMountedStatic(req, res, path, '/admin', distPath);
}

function rewriteSaasCookie(value: string): string {
  if (!value.startsWith('mr_saas_csrf=')) return value;
  const withMountPath = value.replace(/;\s*Path=\/console\/api\/v1(?=;|$)/i, '; Path=/console');
  const withPath = /;\s*Path=/i.test(withMountPath) ? withMountPath : `${withMountPath}; Path=/console`;
  return withPath.replace(/;\s*HttpOnly(?=;|$)/gi, '');
}

function rewriteSaasHeaders(
  headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
): OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined {
  if (!headers) return headers;
  if (Array.isArray(headers)) return headers;
  const rewritten: OutgoingHttpHeaders = { ...headers };
  for (const [name, value] of Object.entries(rewritten)) {
    if (name.toLowerCase() !== 'set-cookie' || value === undefined) continue;
    if (typeof value === 'string') rewritten[name] = rewriteSaasCookie(value);
    else if (Array.isArray(value)) rewritten[name] = value.map((cookie) => rewriteSaasCookie(String(cookie)));
  }
  return rewritten;
}

async function handleSaasIdentity(
  handler: AdminMountedRequestHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // The identity package owns the response body and currently writes cookies
  // through writeHead. Adapt only the CSRF cookie at this listener mount so
  // the SPA can read it from /console while the session cookie stays scoped
  // to /console/api/v1 and HttpOnly.
  const originalSetHeader = res.setHeader;
  const originalWriteHead = res.writeHead;
  const callSetHeader = originalSetHeader.bind(res);
  const callWriteHead = originalWriteHead.bind(res);
  res.setHeader = ((name, value) => {
    if (name.toLowerCase() === 'set-cookie') {
      if (typeof value === 'string') value = rewriteSaasCookie(value);
      else if (Array.isArray(value)) value = value.map((cookie) => rewriteSaasCookie(String(cookie)));
    }
    return callSetHeader(name, value);
  }) as typeof res.setHeader;
  res.writeHead = ((statusCode, statusMessageOrHeaders, headers) => {
    if (typeof statusMessageOrHeaders === 'string') {
      return callWriteHead(statusCode, statusMessageOrHeaders, rewriteSaasHeaders(headers));
    }
    return callWriteHead(statusCode, rewriteSaasHeaders(statusMessageOrHeaders));
  }) as typeof res.writeHead;
  try {
    return await handler(req, res);
  } finally {
    res.setHeader = originalSetHeader;
    res.writeHead = originalWriteHead;
  }
}

function isConsolePath(path: string): boolean {
  return path === '/console' || path.startsWith('/console/');
}

function isConsoleApiPath(path: string): boolean {
  return path === '/console/api' || path.startsWith('/console/api/');
}

/** Creates the isolated management listener. Caller chooses bind address and port via server.listen(). */
export function createAdminServer(options: AdminServerOptions): AdminServer {
  const ownedStore = !options.controlStore && !options.controlService;
  const store = options.controlStore ?? options.controlService?.store ?? new ControlStore(dirname(options.configPath));
  const control =
    options.controlService ?? new ControlService(options.configPath, store, undefined, options.applyConfig);
  const jobs = new AdminJobs(store, (data) => control.publishEvent('job.progress', data));
  const upstreamActions = new UpstreamActions(control);
  const playground = new PlaygroundRuns(
    control,
    store,
    upstreamActions,
    options.telemetryStore,
    options.quotaLedger,
    options.playgroundExecutor,
  );
  const exports = options.telemetryStore
    ? new AdminExports(store, options.telemetryStore, jobs, store.dataDir)
    : undefined;
  const maintenance = new AdminMaintenance(control, store, options.telemetryStore);
  const runtime = new AdminRuntime(control, options.telemetryStore, options.runtime);
  const builtIn: AdminAdapters = {
    upstreamRuntime: async (input) => runtime.snapshot(String(input.upstreamId)),
    healthEvents: async (input) =>
      runtime.events(String(input.upstreamId), input.limit === undefined ? 50 : Number(input.limit)),
    resetCircuit: async (input) => runtime.reset(String(input.upstreamId)),
    discoverModels: async (input) => upstreamActions.discoverModels(String(input.upstreamId)),
    testUpstream: async (input) =>
      jobs.start('upstream-test', 'admin', (signal) =>
        upstreamActions.test(
          String(input.upstreamId),
          typeof input.model === 'string' ? input.model : undefined,
          signal,
        ),
        String(input.upstreamId),
      ),
    jobDetail: async (input) => jobs.get(String(input.jobId)),
    exportCreate: async (input) => {
      if (!exports) throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Telemetry store is required');
      return exports.create(input, String(input.actor));
    },
    maintenanceJob: async (input) => {
      const type = input.type;
      if (type === 'integrity-check')
        return jobs.start(type, String(input.actor), async () => {
          const rows = store.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
          return {
            ok: rows.every((row) => row.integrity_check === 'ok'),
            checks: rows.map((row) => row.integrity_check),
          };
        });
      if (type === 'vacuum-control')
        return jobs.start(type, String(input.actor), async () => {
          store.db.exec('VACUUM');
          return { ok: true };
        });
      if (type === 'backup') return jobs.start(type, String(input.actor), (signal) => maintenance.backup(signal));
      if (type === 'restore')
        return jobs.start(type, String(input.actor), (signal) =>
          maintenance.restore(input.backupId, input.expectedRevision, String(input.actor), signal),
        );
      if (type === 'purge' || type === 'purge-logs')
        return jobs.start('purge-logs', String(input.actor), async () => {
          const config = await control.raw();
          return maintenance.purge(String(input.actor), config.storage.requestRetentionDays);
        });
      if (type === 'aggregate')
        return jobs.start('aggregate', String(input.actor), async (signal) =>
          maintenance.aggregate(String(input.actor), signal),
        );
      throw new ControlError(
        422,
        'UNKNOWN_JOB_TYPE',
        'Supported jobs: integrity-check, vacuum-control, backup, restore, purge, aggregate',
      );
    },
  };
  const adapters = {
    ...builtIn,
    ...(options.telemetryStore
      ? telemetryAdapters(
          options.telemetryStore,
          control,
          options.quotaLedger,
          options.runtime,
          options.quotaTimezoneVersions,
        )
      : {}),
    ...options.adapters,
  };
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const adminRequestLimiter = new AdminRequestRateLimiter();
  const eventClients = new Set<ServerResponse>();
  const upstreamView = (item: UpstreamDefinition) => ({
    ...item,
    credentials: item.credentials.map((credential) => {
      const status = store.secrets.status(credential.secret);
      return {
        ...credential,
        secret: credential.secret.type === 'inline' ? { type: 'inline' as const, value: '' } : credential.secret,
        status: status.configured ? 'configured' : 'missing',
        secretStatus: status,
        maskedValue: status.configured ? '••••••••' : null,
      };
    }),
  });
  let bootstrapToken = options.bootstrapToken;
  const invoke = async (handler: Handler | undefined, input: Json) => {
    if (!handler) throw new ControlError(503, 'FEATURE_UNAVAILABLE', 'This service is not connected');
    return handler(input);
  };
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const activeRequests = new Set<Promise<void>>();
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = `admin_${randomUUID()}`;
    try {
      const url = new URL(req.url ?? '/', 'http://admin.local');
      if (options.saasIdentityHandler && isConsoleApiPath(url.pathname)) {
        const handled = await handleSaasIdentity(options.saasIdentityHandler, req, res);
        if (!handled && !res.headersSent)
          fail(res, 404, requestId, 'NOT_FOUND', 'Not found');
        return;
      }
      if (options.saasIdentityHandler && isConsolePath(url.pathname))
        return serveMountedStatic(req, res, url.pathname, '/console', options.webDistPath);
      if (
        url.pathname === '/admin' ||
        (url.pathname.startsWith('/admin/') && url.pathname !== '/admin/api' && !url.pathname.startsWith('/admin/api/'))
      )
        return serveStatic(req, res, url.pathname, options.webDistPath);
      if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX)
        return fail(res, 404, requestId, 'NOT_FOUND', 'Not found');
      const retryAfter = adminRequestLimiter.take(req.socket.remoteAddress ?? 'unknown', Date.now());
      if (retryAfter !== undefined) {
        res.setHeader('retry-after', String(retryAfter));
        return fail(res, 429, requestId, 'ADMIN_RATE_LIMITED', 'Too many management API requests');
      }
      const parts = pathParts(url.pathname);
      const method = req.method ?? 'GET';
      const contractPath = url.pathname.slice(PREFIX.length);
      if (url.pathname === `${PREFIX}/openapi.json` && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'application/vnd.oai.openapi+json;version=3.1',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(JSON.stringify(adminOpenApiDocument));
        return;
      }
      const config = await control.raw();
      const publicOrigin = new URL(
        typeof options.publicOrigin === 'function'
          ? options.publicOrigin()
          : (options.publicOrigin ?? config.admin.publicAdminBaseUrl),
      ).origin;
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin) throw new ControlError(403, 'ORIGIN_REJECTED', 'Origin is not allowed');
      const rawInput = writeMethods.has(method) ? record(await body(req)) : {};
      let input = record(parseAdminRequest(method, contractPath, rawInput));
      const query = Object.fromEntries(url.searchParams.entries());
      const call = (handler: Handler | undefined, extra: Json = {}) =>
        invoke(handler, { ...query, ...input, ...extra });
      const result = (value: unknown, status = 200, extra?: Json) =>
        send(res, status, requestId, redactInlineValues(value), extra);

      if (parts[0] === 'bootstrap' && parts.length === 1) {
        if (method === 'GET') return result({ initialized: store.hasAdmin(), bootstrapRequired: !store.hasAdmin() });
        if (method === 'POST') {
          if (store.hasAdmin()) throw new ControlError(409, 'ALREADY_INITIALIZED', 'Administrator already exists');
          const remote = req.socket.remoteAddress;
          if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? ''))
            throw new ControlError(403, 'LOCAL_ONLY', 'Bootstrap is local only');
          const supplied = requiredString(input.token, 'token');
          if (
            !bootstrapToken ||
            Date.now() > (options.bootstrapExpiresAt ?? 0) ||
            supplied.length !== bootstrapToken.length ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(bootstrapToken))
          )
            throw new ControlError(403, 'INVALID_BOOTSTRAP_TOKEN', 'Invalid bootstrap token');
          store.createAdmin(requiredString(input.name, 'name'), requiredString(input.password, 'password'));
          bootstrapToken = undefined;
          store.audit('admin', 'admin.bootstrap', {});
          return result({ initialized: true }, 201);
        }
      }
      if (parts[0] === 'session' && parts.length === 1 && method === 'POST') {
        const client = req.socket.remoteAddress ?? 'unknown';
        const attempt = loginAttempts.get(client);
        if (attempt && attempt.until > Date.now() && attempt.count >= 10)
          throw new ControlError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts');
        const login = store.login(
          requiredString(input.name, 'name'),
          requiredString(input.password, 'password'),
          config.admin.sessionTtlSeconds,
        );
        if (!login) {
          const now = Date.now();
          if (loginAttempts.size >= ADMIN_RATE_CLIENT_CAPACITY) {
            for (const [key, candidate] of loginAttempts) {
              if (candidate.until <= now) loginAttempts.delete(key);
            }
            if (loginAttempts.size >= ADMIN_RATE_CLIENT_CAPACITY) {
              const oldest = loginAttempts.keys().next().value as string | undefined;
              if (oldest !== undefined) loginAttempts.delete(oldest);
            }
          }
          loginAttempts.set(client, {
            count: attempt && attempt.until > now ? attempt.count + 1 : 1,
            until: now + 60_000,
          });
          throw new ControlError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
        }
        loginAttempts.delete(client);
        const secure = publicOrigin.startsWith('https:') ? '; Secure' : '';
        res.setHeader(
          'set-cookie',
          `mr_admin_session=${login.token}; HttpOnly; SameSite=Strict; Path=/admin/api/v1; Max-Age=${config.admin.sessionTtlSeconds}${secure}`,
        );
        return result({
          userId: login.session.userId,
          role: login.session.role,
          csrfToken: login.csrf,
          expiresAt: login.session.expiresAt,
        });
      }

      const cookie = tokenCookie(req);
      const session = cookie ? store.session(cookie) : undefined;
      if (!session) throw new ControlError(401, 'UNAUTHENTICATED', 'Login required');
      if (writeMethods.has(method)) {
        if (!origin || origin !== publicOrigin)
          throw new ControlError(403, 'ORIGIN_REQUIRED', 'A matching Origin is required');
        if (!store.checkCsrf(session, String(req.headers['x-csrf-token'] ?? '')))
          throw new ControlError(403, 'CSRF_REJECTED', 'Invalid CSRF token');
      }
      input = record(parseAdminRequest(method, contractPath, rawInput));
      const actor = session.userId;
      const is = (...path: string[]) =>
        parts.length === path.length && parts.every((part, i) => path[i] === '*' || path[i] === part);
      if (is('session')) {
        if (method === 'GET')
          return result({
            userId: actor,
            role: session.role,
            expiresAt: session.expiresAt,
            csrfToken: store.refreshCsrf(cookie ?? ''),
          });
        if (method === 'DELETE') {
          store.logout(cookie ?? '');
          res.setHeader('set-cookie', 'mr_admin_session=; HttpOnly; SameSite=Strict; Path=/admin/api/v1; Max-Age=0');
          return result({ loggedOut: true });
        }
      }
      if (session.role !== 'admin') throw new ControlError(403, 'FORBIDDEN', 'Administrator role required');
      if (method === 'GET' && is('config')) {
        res.setHeader('etag', `"cfg-${config.revision}"`);
        return result(await control.raw());
      }
      if (method === 'POST' && is('config', 'validate')) return result(await control.validate(input.config ?? input));
      if (method === 'PUT' && is('config')) {
        const change = await control.commit(input.config ?? input, expectedRevision(req), actor);
        return result(change, 200, { restartRequiredFields: change.restartRequiredFields });
      }
      if (method === 'GET' && is('config', 'export'))
        return result({
          config: await control.raw(),
          requiredSecrets: config.upstreams.flatMap((item) => [
            ...item.credentials.filter((c) => c.secret.type === 'secret').map((c) => c.secret),
            ...(item.auth.clientSecret?.type === 'secret' ? [item.auth.clientSecret] : []),
          ]),
        });
      if (method === 'POST' && is('config', 'import-preview'))
        return result(await control.previewImport(input.config, input.mode));
      if (method === 'POST' && is('config', 'import'))
        return result(await control.importConfig(input.config, input.mode, expectedRevision(req), actor));
      if (method === 'GET' && is('config', 'history'))
        return result(
          store.db
            .prepare(
              'SELECT revision,actor_id AS actorId,created_at AS createdAt FROM config_history ORDER BY revision DESC LIMIT 100',
            )
            .all(),
        );
      if (method === 'POST' && is('config', 'rollback'))
        return result(await control.rollback(Number(input.revision), expectedRevision(req), actor));
      if (method === 'GET' && is('provider-presets')) return result(presets);
      if (method === 'GET' && is('capabilities'))
        return result({
          protocols: ['openai', 'anthropic', 'responses'],
          deviceFlowProviders: [],
          clientCredentialsProviders: [],
          oauth: { enabled: false, reason: 'No provider flow has been verified against official endpoints' },
          maintenanceJobs: [
            'integrity-check',
            'vacuum-control',
            'backup',
            'restore',
            'purge',
            ...(options.telemetryStore ? ['aggregate'] : []),
          ],
          nativeResponses: true,
          experimental: ['gemini', 'responses-bridge'],
        });
      if (method === 'GET' && is('system'))
        return result({
          ...(adapters.system ? record(await call(adapters.system)) : {}),
          instanceId: config.instanceId,
          status: control.applyError() ? 'degraded' : 'running',
          telemetryRecorder: options.recorderStatus?.() ?? null,
          persistedRevision: config.revision,
          effectiveRevision: control.effectiveRevision(config.revision),
          restartRequiredFields: control.restartRequiredFields(),
          applyError: control.applyError() ?? null,
          publicProxyBaseUrl: config.server.publicProxyBaseUrl,
          publicAdminBaseUrl: config.admin.publicAdminBaseUrl,
          listeners: options.listenerStatus?.() ?? null,
          databases: databaseDiagnostics(store, options.telemetryStore),
          timezone: config.quota.timezone,
        });
      if (method === 'GET' && is('overview')) {
        const value = await call(adapters.overview);
        const usage = record(record(value).usage);
        return result(value, 200, {
          dataThrough: typeof usage.dataThrough === 'number' ? new Date(usage.dataThrough).toISOString() : undefined,
          partial: usage.partial,
          coverage: usage.coverage,
          legacyLogRows: usage.legacyLogRows,
        });
      }
      const map = { upstreams: 'upstreams', routes: 'routes', keys: 'proxyKeys' } as const;
      if (parts.length <= 2 && parts[0] in map) {
        const kind = map[parts[0] as keyof typeof map];
        if (parts.length === 1 && method === 'GET')
          return result(
            kind === 'upstreams'
              ? config.upstreams.map(upstreamView)
              : kind === 'proxyKeys'
                ? config.proxyKeys.map(({ keyHash: _hash, ...key }) => key)
                : config[kind],
          );
        if (parts.length === 2 && method === 'GET') {
          const found = config[kind].find((item) => item.id === parts[1]);
          if (!found) throw new ControlError(404, 'NOT_FOUND', 'Item not found');
          if (kind === 'upstreams') return result(upstreamView(found as UpstreamDefinition));
          if (kind === 'proxyKeys') {
            const { keyHash: _hash, ...key } = found as ConfigV2['proxyKeys'][number];
            return result(key);
          }
          return result(found);
        }
        if (parts.length === 1 && method === 'POST') {
          const expected = expectedRevision(req);
          return result(
            kind === 'proxyKeys'
              ? await control.createKey(input, expected, actor)
              : await control.entity(kind, 'create', undefined, input, expected, actor),
            201,
          );
        }
        if (parts.length === 2 && (method === 'PATCH' || method === 'DELETE'))
          return result(
            await control.entity(
              kind,
              method === 'PATCH' ? 'update' : 'delete',
              parts[1],
              input,
              expectedRevision(req),
              actor,
            ),
          );
      }
      if (is('upstreams', '*', 'credentials') && method === 'POST')
        return result(
          await control.credential(parts[1], 'create', undefined, input, expectedRevision(req), actor),
          201,
        );
      if (is('upstreams', '*', 'credentials', '*') && ['PATCH', 'DELETE'].includes(method))
        return result(
          await control.credential(
            parts[1],
            method === 'PATCH' ? 'replace' : 'delete',
            parts[3],
            input,
            expectedRevision(req),
            actor,
          ),
        );
      if (is('upstreams', '*', 'discover-models') && method === 'POST') {
        if (!config.upstreams.some((item) => item.id === parts[1]))
          throw new ControlError(404, 'NOT_FOUND', 'Upstream not found');
        const discovered = await invoke(adapters.discoverModels, { upstreamId: parts[1] });
        const value = record(discovered);
        return result(
          Array.isArray(value.models) ? value.models : discovered,
          200,
          typeof value.status === 'number' ? { upstreamStatus: value.status } : undefined,
        );
      }
      if (is('upstreams', '*', 'test') && method === 'POST') {
        const upstream = config.upstreams.find((item) => item.id === parts[1]);
        if (!upstream) throw new ControlError(404, 'NOT_FOUND', 'Upstream not found');
        const model = input.model;
        if (model !== undefined && (typeof model !== 'string' || !upstream.models.some((item) => item.id === model)))
          throw new ControlError(422, 'UNKNOWN_MODEL', 'Test model must belong to this upstream');
        return result(await invoke(adapters.testUpstream, { upstreamId: parts[1], model }), 202);
      }
      if (is('upstreams', '*', 'test-jobs', '*', 'cancel') && method === 'POST')
        return result(jobs.cancel(parts[3], actor, 'upstream-test', parts[1]));
      if (is('upstreams', '*', 'runtime') && method === 'GET')
        return result(await call(adapters.upstreamRuntime, { upstreamId: parts[1] }));
      if (is('upstreams', '*', 'health-events') && method === 'GET')
        return result(await call(adapters.healthEvents, { upstreamId: parts[1] }));
      if (is('upstreams', '*', 'circuit-reset') && method === 'POST') {
        const value = await call(adapters.resetCircuit, { upstreamId: parts[1] });
        store.audit(actor, 'circuit.reset', { upstreamId: parts[1] });
        return result(value);
      }
      if (is('routes', 'order') && method === 'PUT')
        return result(await control.orderRoutes(input.ids as string[], expectedRevision(req), actor));
      if (is('routes', 'preview') && method === 'POST')
        return result(
          await runtime.previewRoute(
            requiredString(input.model, 'model'),
            requiredString(input.protocol, 'protocol'),
            typeof input.proxyKeyId === 'string' && input.proxyKeyId ? input.proxyKeyId : undefined,
          ),
        );
      if (is('models') && method === 'GET')
        return result(
          config.upstreams.flatMap((upstream) =>
            upstream.models.map((model) => ({ ...model, upstreamId: upstream.id, protocol: upstream.protocol })),
          ),
        );
      if (is('keys', '*', 'rotate') && method === 'POST')
        return result(await control.rotateKey(parts[1], expectedRevision(req), actor));
      if (is('keys', '*', 'quota') && method === 'GET')
        return result(await call(adapters.keyQuota, { keyId: parts[1] }));
      if (is('keys', '*', 'quota-adjustments') && method === 'POST')
        return result(
          await call(adapters.quotaAdjustment, {
            keyId: parts[1],
            actor,
            idempotencyKey: req.headers['idempotency-key'] ?? input.idempotencyKey,
          }),
          201,
        );
      if (is('usage', 'summary') && method === 'GET') {
        const value = await call(adapters.usageSummary);
        const summary = record(value);
        return result(value, 200, {
          dataThrough:
            typeof summary.dataThrough === 'number' ? new Date(summary.dataThrough).toISOString() : undefined,
          partial: summary.partial,
          grain: summary.grain,
          coverage: summary.coverage,
        });
      }
      if (is('usage', 'timeseries') && method === 'GET') {
        const value = await call(adapters.usageTimeseries);
        const series = record(value);
        return Array.isArray(series.items)
          ? result(series.items, 200, {
              grain: series.grain,
              coverage: series.coverage,
              from: series.from,
              to: series.to,
            })
          : result(value);
      }
      if (is('usage', 'breakdown') && method === 'GET') return result(await call(adapters.usageBreakdown));
      if (is('requests') && method === 'GET') {
        const value = await call(adapters.requests);
        const page = record(value);
        return Array.isArray(page.items) ? result(page.items, 200, { nextCursor: page.nextCursor }) : result(value);
      }
      if (is('requests', '*') && method === 'GET')
        return result(await call(adapters.requestDetail, { requestId: parts[1] }));
      if (is('requests', '*', 'attempts') && method === 'GET')
        return result(await call(adapters.requestAttempts, { requestId: parts[1] }));
      if (is('exports') && method === 'POST') return result(await call(adapters.exportCreate, { actor }), 202);
      if (is('exports', '*', 'download') && method === 'GET') {
        if (options.adapters?.exportDownload)
          return result(await call(adapters.exportDownload, { exportId: parts[1] }));
        if (!exports) throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Telemetry store is required');
        return exports.download(parts[1], actor, res);
      }
      if (is('playground', 'runs') && method === 'POST') {
        if (options.adapters?.playgroundRun) return result(await call(adapters.playgroundRun, { actor }), 202);
        const wantsStream = input.stream === true && String(req.headers.accept ?? '').includes('text/event-stream');
        let runId = '';
        let disconnected = false;
        const onClose = () => {
          disconnected = true;
          if (runId) playground.cancel(runId, actor);
        };
        try {
          const value = await playground.run(input, actor, (id) => {
            runId = id;
            if (wantsStream) {
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                'x-run-id': id,
                'x-content-type-options': 'nosniff',
              });
              res.write(`event: started\ndata: ${JSON.stringify({ runId: id })}\n\n`);
            } else res.setHeader('x-run-id', id);
            res.once('close', onClose);
          });
          res.off('close', onClose);
          if (wantsStream) {
            if (!disconnected) {
              res.write(`event: delta\ndata: ${JSON.stringify({ delta: value.output })}\n\n`);
              res.write(`event: summary\ndata: ${JSON.stringify({ summary: value.summary })}\n\n`);
              res.end('data: [DONE]\n\n');
            }
            return;
          }
          return result(value);
        } catch (error) {
          res.off('close', onClose);
          if (res.headersSent) {
            if (!disconnected)
              res.end(
                `event: error\ndata: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Run failed' } })}\n\n`,
              );
            return;
          }
          throw error;
        }
      }
      if (is('playground', 'runs', '*') && method === 'GET') return result(playground.get(parts[2]));
      if (is('playground', 'status') && method === 'GET') return result(playground.completionStatus());
      if (is('playground', 'runs', '*', 'cancel') && method === 'POST')
        return result(
          options.adapters?.playgroundCancel
            ? await call(adapters.playgroundCancel, { runId: parts[2], actor })
            : playground.cancel(parts[2], actor),
        );
      if (is('connect', 'templates') && method === 'GET')
        return result(connectTemplate(config, query.model, query.protocol));
      if (is('pricing') && method === 'GET')
        return result(
          store.db
            .prepare(`SELECT v.version_id,v.profile_id,v.body,s.sequence FROM pricing_versions v
              JOIN pricing_version_sequence s USING(version_id) ORDER BY v.effective_from DESC,s.sequence DESC`)
            .all()
            .map((row) => {
              const item = row as { version_id: string; profile_id: string; body: string; sequence: number };
              return { ...JSON.parse(item.body), id: item.profile_id, versionId: item.version_id, versionSequence: item.sequence };
            }),
        );
      if ((is('pricing') && method === 'POST') || (is('pricing', '*') && method === 'PATCH')) {
        const id = parts[1] ?? requiredString(input.id, 'id');
        const prior = parts[1]
          ? (store.db.prepare('SELECT body FROM pricing WHERE id=?').get(id) as { body: string } | undefined)
          : undefined;
        if (parts[1] && !prior) throw new ControlError(404, 'NOT_FOUND', 'Pricing profile not found');
        const submitted = { ...input };
        delete submitted.versionId;
        const effectiveFrom = submitted.effectiveFrom ?? new Date().toISOString();
        const priorProfile = prior ? { ...(JSON.parse(prior.body) as Json) } : {};
        delete priorProfile.versionId;
        const profile = validatePricing({ ...priorProfile, ...submitted, id, effectiveFrom });
        const versionId = `pv_${randomUUID()}`;
        const version = { ...profile, versionId };
        const createdAt = new Date().toISOString();
        const save = store.db.transaction(() => {
          store.db
            .prepare('INSERT INTO pricing_versions (version_id,profile_id,body,effective_from,created_at) VALUES(?,?,?,?,?)')
            .run(versionId, id, JSON.stringify(version), effectiveFrom, createdAt);
          store.db.prepare('INSERT INTO pricing_version_sequence (version_id) VALUES(?)').run(versionId);
          store.db
            .prepare('INSERT INTO pricing (id,body,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at')
            .run(id, JSON.stringify(version), createdAt);
        });
        save();
        store.audit(actor, 'pricing.update', { id, versionId, effectiveFrom });
        const sequence = store.db.prepare('SELECT sequence FROM pricing_version_sequence WHERE version_id=?').get(versionId) as { sequence: number };
        return result({ id, versionId, versionSequence: sequence.sequence, effectiveFrom }, method === 'POST' ? 201 : 200);
      }
      if (is('accounts') && method === 'GET') return result(await call(adapters.accounts));
      if (is('accounts', 'client-credentials') && method === 'POST')
        return result(
          await invoke(adapters.accountClientCredentials, {
            ...Object.fromEntries(
              ['provider', 'name', 'clientId', 'clientSecret', 'tokenUrl', 'scopes'].flatMap((key) =>
                input[key] === undefined ? [] : [[key, input[key]]],
              ),
            ),
            actor,
          }),
          201,
        );
      if (is('accounts', 'device-flows') && method === 'POST')
        return result(
          await invoke(adapters.deviceFlowCreate, {
            ...Object.fromEntries(
              ['provider', 'clientId', 'scopes'].flatMap((key) =>
                input[key] === undefined ? [] : [[key, input[key]]],
              ),
            ),
            actor,
          }),
          202,
        );
      if (is('accounts', 'device-flows', '*') && method === 'GET')
        return result(await call(adapters.deviceFlowDetail, { flowId: parts[2] }));
      if (is('accounts', 'device-flows', '*') && method === 'DELETE')
        return result(await call(adapters.deviceFlowCancel, { flowId: parts[2], actor }));
      if (is('accounts', '*') && method === 'PATCH')
        return result(await invoke(adapters.accountPatch, { ...input, accountId: parts[1], actor }));
      if (is('accounts', '*') && method === 'DELETE')
        return result(await call(adapters.accountDelete, { accountId: parts[1], actor }));
      if (is('accounts', '*', 'refresh') && method === 'POST')
        return result(await call(adapters.accountRefresh, { accountId: parts[1], actor }));
      if (is('balances') && method === 'GET') return result(await call(adapters.balances));
      if (is('balances', 'refresh') && method === 'POST')
        return result(await call(adapters.balancesRefresh, { actor }), 202);
      if (is('audit-events') && method === 'GET')
        return result(
          store.db
            .prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200')
            .all()
            .map((row) => ({ ...(row as Json), detail: JSON.parse((row as { detail: string }).detail) })),
        );
      if (is('maintenance', 'jobs') && method === 'POST')
        return result(await call(adapters.maintenanceJob, { actor }), 202);
      if (is('jobs', '*') && method === 'GET') return result(await call(adapters.jobDetail, { jobId: parts[1] }));
      if (is('events') && method === 'GET') {
        // A request admitted before shutdown may reach this branch after an await.
        if (closing) return res.end();
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        });
        eventClients.add(res);
        // Event history is process local; clients always fetch a fresh snapshot on connection.
        res.write('event: resync\ndata: {}\n\n');
        const unsubscribe = control.subscribe((event) => {
          if (!res.destroyed)
            res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        });
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': heartbeat\n\n');
        }, 20_000);
        req.once('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
          eventClients.delete(res);
        });
        return;
      }
      throw new ControlError(404, 'NOT_FOUND', 'Not found');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ControlError)
        return fail(res, error.status, requestId, error.code, error.message, error.details);
      if (error instanceof ConfigConflictError)
        return fail(res, 412, requestId, 'CONFIG_REVISION_CONFLICT', 'Configuration revision conflict', {
          expected: error.expectedRevision,
          actual: error.actualRevision,
        });
      if (error instanceof ConfigValidationError)
        return fail(res, 422, requestId, 'CONFIG_VALIDATION_FAILED', 'Configuration validation failed', error.issues);
      return fail(res, 503, requestId, 'ADMIN_DEPENDENCY_ERROR', 'Management dependency unavailable');
    }
  };
  const server = createServer((req, res) => {
    if (closing)
      return fail(res, 503, `admin_${randomUUID()}`, 'ADMIN_CLOSING', 'Management service is shutting down');
    // Socket closure does not settle an async handler. In particular, telemetry
    // handlers await read-worker exit and then still access the shared stores.
    const request = handleRequest(req, res).then(() => {});
    activeRequests.add(request);
    void request.then(
      () => activeRequests.delete(request),
      () => activeRequests.delete(request),
    );
  });
  return {
    server,
    control,
    store,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        playground.close();
        jobs.close();
        for (const client of eventClients) client.end();
        const listenerClosed = new Promise<Error | undefined>((resolve) => {
          server.close((error) => resolve(error));
        });
        await Promise.allSettled([...activeRequests]);
        const error = await listenerClosed;
        if (ownedStore) store.close();
        if (error) throw error;
      })();
      return closePromise;
    },
  };
}
