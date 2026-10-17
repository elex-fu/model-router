/**
 * Batch-5 §5.1 plugin admin surface (the billing-groups admin contract):
 * same-origin POST only, platform session authentication with the operator
 * role, CSRF on every write, strict JSON with exact-key allowlists.
 *
 * - POST /admin/api/v1/plugins/list — every installation, summary shape.
 * - POST /admin/api/v1/plugins/get — one installation + its bindings.
 * - POST /admin/api/v1/plugins/install — the `.mrplugin` upload. This one
 *   action takes a RAW `application/zip` body (the signed package bytes are
 *   hashed and stored verbatim; a JSON/base64 hop would only blur the
 *   trust chain) with the plugin-package upload limit, not the generic
 *   admin JSON cap.
 * - POST /admin/api/v1/plugins/enable — {pluginKey, rolloutPercent}.
 * - POST /admin/api/v1/plugins/disable — {pluginKey}.
 * - POST /admin/api/v1/plugins/update-config — {pluginKey, config|null};
 *   refused while enabled/starting (the offline-config rule in
 *   admin-service.ts).
 * - POST /admin/api/v1/plugins/delete — {pluginKey}; refused while enabled.
 *
 * The control plane never spawns a plugin (types.ts decision #1); state
 * transitions here are pure DB writes that the plugin-host reconcile loop
 * converges to.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PluginAdminError, type PluginAdminService } from '../plugins/admin-service.js';
import type { PluginInstallationRecord, PluginStore } from '../plugins/types.js';
import { hasPlatformRole } from './access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';

const ROUTE_PREFIX = '/admin/api/v1/plugins/';
const ROUTES = new Set(['list', 'get', 'install', 'enable', 'disable', 'update-config', 'delete']);
/** The plugin package upload cap (sub2api max_upload_bytes default). */
export const PLUGIN_PACKAGE_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export interface PluginsHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: Pick<
    PluginAdminService,
    'install' | 'list' | 'get' | 'enable' | 'disable' | 'updateConfig' | 'delete'
  >;
  readonly store: Pick<PluginStore, 'listBindings'>;
  readonly publicOrigin: string;
}

export type PluginsHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'HttpError';
  }
}

export function createPluginsHttpHandler(options: PluginsHttpOptions): PluginsHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access is required');
  }
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service || typeof options.service.install !== 'function') {
    throw new TypeError('plugin admin service is required');
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

      if (action === 'install') {
        // Raw signed-package bytes: hash-verified and persisted verbatim.
        const contentType = req.headers['content-type'];
        if (typeof contentType !== 'string' || contentType !== 'application/zip') {
          throw new HttpError(400, 'INVALID_CONTENT_TYPE', 'Plugin install requires application/zip');
        }
        const packageBytes = await readRawBody(req, PLUGIN_PACKAGE_MAX_UPLOAD_BYTES);
        if (packageBytes === null) throw new HttpError(413, 'BODY_TOO_LARGE', 'The plugin package exceeds the limit');
        const record = await options.service.install(packageBytes, actor.userId);
        sendJson(res, 200, requestId, { plugin: pluginDto(record) });
        return true;
      }

      const body = await readJson(req);
      if (action === 'list') {
        requireExactKeys(body, []);
        const plugins = await options.service.list();
        sendJson(res, 200, requestId, { plugins: plugins.map(pluginDto) });
        return true;
      }
      if (action === 'get') {
        requireExactKeys(body, ['pluginKey']);
        const pluginKey = bodyText(body, 'pluginKey', 160);
        const record = await options.service.get(pluginKey);
        const bindings = (await options.store.listBindings()).filter((binding) => binding.installationId === record.id);
        sendJson(res, 200, requestId, {
          plugin: pluginDto(record),
          bindings: bindings.map((binding) => ({
            capability: binding.capability,
            platform: binding.platform,
            accountType: binding.accountType,
            enabled: binding.enabled,
            rolloutPercent: binding.rolloutPercent,
          })),
        });
        return true;
      }
      if (action === 'enable') {
        requireExactKeys(body, ['pluginKey', 'rolloutPercent']);
        const pluginKey = bodyText(body, 'pluginKey', 160);
        const rolloutPercent = requireInteger(body, 'rolloutPercent', 1, 100);
        const record = await options.service.enable(pluginKey, rolloutPercent);
        sendJson(res, 200, requestId, { plugin: pluginDto(record) });
        return true;
      }
      if (action === 'disable') {
        requireExactKeys(body, ['pluginKey']);
        const pluginKey = bodyText(body, 'pluginKey', 160);
        const record = await options.service.disable(pluginKey);
        sendJson(res, 200, requestId, { plugin: pluginDto(record) });
        return true;
      }
      if (action === 'update-config') {
        requireExactKeys(body, ['pluginKey', 'config']);
        const pluginKey = bodyText(body, 'pluginKey', 160);
        const configValue = body.config;
        if (configValue !== null && (typeof configValue !== 'object' || Array.isArray(configValue))) {
          throw new HttpError(400, 'INVALID_BODY', 'Plugin config must be a JSON object or null');
        }
        const record = await options.service.updateConfig(pluginKey, configValue as Record<string, unknown> | null);
        sendJson(res, 200, requestId, { plugin: pluginDto(record) });
        return true;
      }
      // delete
      requireExactKeys(body, ['pluginKey']);
      const pluginKey = bodyText(body, 'pluginKey', 160);
      await options.service.delete(pluginKey);
      sendJson(res, 200, requestId, { deleted: true });
      return true;
    } catch (error) {
      if (error instanceof PluginAdminError) {
        const status =
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'INVALID_STATE' || error.code === 'REPLACE_FORBIDDEN' || error.code === 'DELETE_FORBIDDEN'
              ? 409
              : 400;
        sendJsonError(res, status, error.code, error.message, requestId, error.detail ?? null);
        return true;
      }
      if (error instanceof HttpError) {
        sendJsonError(res, error.status, error.code, error.safeMessage, requestId, null);
        return true;
      }
      sendJsonError(res, 500, 'INTERNAL_ERROR', 'The plugin admin request failed', requestId, null);
      return true;
    }
  };
}

function pluginDto(record: PluginInstallationRecord) {
  return {
    pluginKey: record.pluginKey,
    name: record.name,
    version: record.version,
    description: record.description,
    author: record.author,
    state: record.state,
    signatureStatus: record.signatureStatus,
    binarySha256: record.binarySha256,
    lastError: record.lastError,
    hasConfig: record.configJson !== null,
    capabilities: record.manifest.capabilities.map((capability) => capability.id),
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    enabledAt: record.enabledAt,
  };
}

function route(pathname: string): string | null {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const action = pathname.slice(ROUTE_PREFIX.length);
  return ROUTES.has(action) ? action : null;
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
    throw new HttpError(503, 'PLUGINS_UNAVAILABLE', 'Plugin administration is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

async function requireCsrf(req: IncomingMessage, authService: PluginsHttpOptions['authService']): Promise<void> {
  const session = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrf = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !session || !equalSecret(csrf, header)) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
  let valid = false;
  try {
    if (session !== null && csrf !== null) valid = await authService.verifyCsrfToken(session, csrf);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

function equalSecret(a: string | null, b: string): boolean {
  if (typeof a !== 'string' || a.length === 0 || b.length === 0) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
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
    throw new HttpError(400, 'INVALID_BODY', 'The request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requireExactKeys(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'The request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new HttpError(400, 'INVALID_BODY', 'The request body fields are invalid');
  }
  return record;
}

function bodyText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, 'INVALID_BODY', `The ${field} field is invalid`);
  }
  return value;
}

function requireInteger(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'INVALID_BODY', `The ${field} field is invalid`);
  }
  return value;
}

function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, requestId: string, data: unknown): void {
  const body = JSON.stringify({ data, meta: { requestId } });
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  detail: string | null,
): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message, ...(detail === null ? {} : { detail }), requestId } }));
}
