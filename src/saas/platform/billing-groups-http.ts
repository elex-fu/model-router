import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { SaasBillingGroupsError } from '../billing/groups/errors.js';
import { parseModelPricingJson, serializeModelPricingJson } from '../billing/groups/override.js';
import type { SaasBillingGroupsService } from '../billing/groups/service.js';
import type {
  BillingGroupModelPricingEntry,
  BillingGroupRecord,
  BillingGroupUpsertInput,
  RationalMultiplier,
} from '../billing/groups/types.js';
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
 * R1 billing groups admin surface (task #38, F5): the operator endpoints
 * behind the platform console's billing-groups view.
 *
 * - POST /admin/api/v1/billing-groups/list — every group, summary shape.
 * - POST /admin/api/v1/billing-groups/get — one group plus its account pool.
 * - POST /admin/api/v1/billing-groups/create | /update — full group upsert
 *   (multipliers as exact {num, den} decimal-string rationals; model_pricing
 *   validated through the canonical override codec; never floats anywhere).
 * - POST /admin/api/v1/billing-groups/replace-account-pool — pool membership
 *   with per-account priorities; the response surfaces the authz_version
 *   fence bump (invalidatedKeys) the service performs.
 * - POST /admin/api/v1/billing-groups/set-key-group — key group assignment;
 *   the response carries the key's new authzVersion.
 *
 * The contract follows the codex-oauth http.ts shape exactly: same-origin
 * POST only, platform session authentication with the operations role, CSRF
 * token on every write, strict JSON with exact-key allowlists, and
 * `{ data, meta: { requestId } }` / `{ error: ... }` envelopes. No secret
 * material is involved; multiplier and limit math stays exact (bigint
 * rationals parsed from decimal strings, never parseFloat).
 */
const ROUTE_PREFIX = '/admin/api/v1/billing-groups/';
const ROUTES = new Set(['list', 'get', 'create', 'update', 'replace-account-pool', 'set-key-group']);

export interface BillingGroupsHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: Pick<
    SaasBillingGroupsService,
    | 'listBillingGroups'
    | 'getBillingGroup'
    | 'createBillingGroup'
    | 'updateBillingGroup'
    | 'listGroupAccountPool'
    | 'replaceGroupAccountPool'
    | 'setKeyBillingGroup'
  >;
  readonly audit?: BillingGroupsAuditWriter;
  readonly publicOrigin: string;
}

export type BillingGroupsHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type BillingGroupsAuditWriter = (input: {
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
    this.name = 'BillingGroupsHttpError';
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
    throw new HttpError(503, 'BILLING_GROUPS_UNAVAILABLE', 'Billing groups are not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: BillingGroupsHttpOptions['authService']): Promise<void> {
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
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid billing group input');
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

/** Exact decimal-string → bigint rational; floats never participate. */
function bodyRational(
  body: Record<string, unknown>,
  name: string,
  options: { readonly nonNegative: boolean },
): RationalMultiplier {
  const value = body[name];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid billing group input');
  }
  const candidate = value as { num?: unknown; den?: unknown };
  const numerator = decimalString(candidate.num);
  const denominator = decimalString(candidate.den);
  if (denominator <= 0n) throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid multiplier');
  if (options.nonNegative ? numerator < 0n : numerator <= 0n) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid multiplier');
  }
  return { numerator, denominator };
}

function decimalString(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid exact number');
  }
  return BigInt(value);
}

function optionalRational(
  body: Record<string, unknown>,
  name: string,
  options: { readonly nonNegative: boolean },
): RationalMultiplier | null {
  if (body[name] === undefined || body[name] === null) return null;
  return bodyRational(body, name, options);
}

/** "HH:MM:SS" UTC clock time (the migration-105 peak window shape). */
function bodyClockTime(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid peak window time');
  }
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if (hours > 24 || minutes > 59 || seconds > 59) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid peak window time');
  }
  return value;
}

function bodyModelPricing(body: Record<string, unknown>): Readonly<Record<string, BillingGroupModelPricingEntry>> {
  const value = body.modelPricing;
  if (value === undefined || value === null) return {};
  // Strict validation through the canonical override codec: num/den decimal
  // strings, known metrics only, eager rate-set normalization.
  let parsed: ReadonlyMap<string, BillingGroupModelPricingEntry>;
  try {
    parsed = parseModelPricingJson(value);
  } catch (error) {
    if (error instanceof SaasBillingGroupsError) {
      throw new HttpError(400, 'INVALID_MODEL_PRICING', 'The model pricing override is invalid');
    }
    throw error;
  }
  const record: Record<string, BillingGroupModelPricingEntry> = {};
  for (const [model, rates] of parsed) record[model] = rates;
  return record;
}

function bodyLimit(body: Record<string, unknown>, name: string): bigint | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid limit');
  }
  return BigInt(value);
}

function bodyBoolean(body: Record<string, unknown>, name: string): boolean {
  if (typeof body[name] !== 'boolean') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid billing group input');
  }
  return body[name] as boolean;
}

function bodyOptionalId(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  return bodyText(body, name, 128);
}

function bodyScopes(body: Record<string, unknown>): readonly string[] | null {
  const value = body.supportedModelScopes;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 256) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid model scopes');
  }
  const scopes: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > 128 ||
      entry.trim() !== entry ||
      [...entry].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
    ) {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid model scopes');
    }
    scopes.push(entry);
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid model scopes');
  }
  return scopes;
}

function bodyRpmLimit(body: Record<string, unknown>): number | null {
  const value = body.rpmLimit;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid limit');
  }
  return value;
}

function bodyGroupInput(body: Record<string, unknown>): BillingGroupUpsertInput {
  requireExactKeys(body, GROUP_BODY_KEYS);
  const peakEnabled = bodyBoolean(body, 'peakEnabled');
  const peakStart = bodyClockTime(body, 'peakStart');
  const peakEnd = bodyClockTime(body, 'peakEnd');
  if (peakEnabled && (peakStart === null || peakEnd === null)) {
    throw new HttpError(400, 'INVALID_BODY', 'An enabled peak window requires start and end times');
  }
  if (!peakEnabled && (peakStart !== null || peakEnd !== null)) {
    throw new HttpError(400, 'INVALID_BODY', 'Peak window times require peakEnabled');
  }
  const peakMultiplier = optionalRational(body, 'peakMultiplier', { nonNegative: false });
  if (peakEnabled && peakMultiplier === null) {
    throw new HttpError(400, 'INVALID_BODY', 'An enabled peak window requires a peak multiplier');
  }
  if (!peakEnabled && peakMultiplier !== null) {
    throw new HttpError(400, 'INVALID_BODY', 'A peak multiplier requires peakEnabled');
  }
  const profitMinMargin = optionalRational(body, 'profitMinMargin', { nonNegative: true });
  const profitSafetyBuffer = optionalRational(body, 'profitSafetyBuffer', { nonNegative: true });
  if ((profitMinMargin === null) !== (profitSafetyBuffer === null)) {
    throw new HttpError(400, 'INVALID_BODY', 'Profit margin and safety buffer must be set together');
  }
  const fallbackGroupId = bodyOptionalId(body, 'fallbackGroupId');
  const id = bodyText(body, 'id', 128);
  if (fallbackGroupId === id) {
    throw new HttpError(400, 'INVALID_BODY', 'A billing group cannot be its own fallback');
  }
  return {
    id,
    displayName: bodyText(body, 'displayName', 255),
    rateMultiplier: bodyRational(body, 'rateMultiplier', { nonNegative: false }),
    topupMultiplier: bodyRational(body, 'topupMultiplier', { nonNegative: false }),
    peakEnabled,
    peakStart,
    peakEnd,
    peakMultiplier,
    modelPricing: bodyModelPricing(body),
    rpmLimit: bodyRpmLimit(body),
    dailyLimitMinorUnits: bodyLimit(body, 'dailyLimitMinorUnits'),
    weeklyLimitMinorUnits: bodyLimit(body, 'weeklyLimitMinorUnits'),
    monthlyLimitMinorUnits: bodyLimit(body, 'monthlyLimitMinorUnits'),
    profitMinMargin,
    profitSafetyBuffer,
    claudeCodeOnly: bodyBoolean(body, 'claudeCodeOnly'),
    fallbackGroupId,
    supportedModelScopes: bodyScopes(body),
    composite: bodyBoolean(body, 'composite'),
    status: bodyStatus(body),
  };
}

const GROUP_BODY_KEYS = [
  'id',
  'displayName',
  'status',
  'rateMultiplier',
  'topupMultiplier',
  'peakEnabled',
  'peakStart',
  'peakEnd',
  'peakMultiplier',
  'modelPricing',
  'rpmLimit',
  'dailyLimitMinorUnits',
  'weeklyLimitMinorUnits',
  'monthlyLimitMinorUnits',
  'profitMinMargin',
  'profitSafetyBuffer',
  'claudeCodeOnly',
  'fallbackGroupId',
  'supportedModelScopes',
  'composite',
] as const;

function bodyStatus(body: Record<string, unknown>): string {
  const status = body.status;
  if (status !== 'active' && status !== 'disabled') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid billing group input');
  }
  return status;
}

function clockTimeFromSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function rationalDto(value: RationalMultiplier): { readonly num: string; readonly den: string } {
  return { num: value.numerator.toString(10), den: value.denominator.toString(10) };
}

function groupDto(record: BillingGroupRecord): Record<string, unknown> {
  return {
    id: record.id,
    displayName: record.displayName,
    status: record.status,
    rateMultiplier: rationalDto(record.rateMultiplier),
    topupMultiplier: rationalDto(record.topupMultiplier),
    peakEnabled: record.peakEnabled,
    peak:
      record.peak === null
        ? null
        : {
            start: clockTimeFromSeconds(record.peak.startSecondsUtc),
            end: clockTimeFromSeconds(record.peak.endSecondsUtc),
            multiplier: rationalDto(record.peak.multiplier),
          },
    // Canonical num/den JSON (the exact stored codec shape).
    modelPricing: JSON.parse(serializeModelPricingJson(Object.fromEntries(record.modelPricing))),
    rpmLimit: record.rpmLimit,
    dailyLimitMinorUnits: record.dailyLimitMinorUnits === null ? null : record.dailyLimitMinorUnits.toString(10),
    weeklyLimitMinorUnits: record.weeklyLimitMinorUnits === null ? null : record.weeklyLimitMinorUnits.toString(10),
    monthlyLimitMinorUnits: record.monthlyLimitMinorUnits === null ? null : record.monthlyLimitMinorUnits.toString(10),
    profitMinMargin: record.profitMinMargin === null ? null : rationalDto(record.profitMinMargin),
    profitSafetyBuffer: record.profitSafetyBuffer === null ? null : rationalDto(record.profitSafetyBuffer),
    claudeCodeOnly: record.claudeCodeOnly,
    fallbackGroupId: record.fallbackGroupId,
    supportedModelScopes: record.supportedModelScopes === null ? null : [...record.supportedModelScopes],
    composite: record.composite,
  };
}

function billingGroupsErrorStatus(error: SaasBillingGroupsError): { status: number; code: string } {
  switch (error.code) {
    case 'INVALID_INPUT':
    case 'INVALID_MULTIPLIER':
    case 'INVALID_OVERRIDE':
      return { status: 400, code: 'INVALID_BILLING_GROUP_INPUT' };
    case 'GROUP_NOT_FOUND':
    case 'TARGET_NOT_FOUND':
      return { status: 404, code: 'BILLING_GROUP_NOT_FOUND' };
    case 'GROUP_CONFLICT':
      return { status: 409, code: 'BILLING_GROUP_CONFLICT' };
    default:
      return { status: 503, code: 'BILLING_GROUPS_UNAVAILABLE' };
  }
}

/**
 * Best-effort audit writer on the control-plane role (the probe-monitors
 * precedent): failures are swallowed so an audit hiccup never fails the
 * operator mutation, which is already transactional in the service.
 */
export function createPostgresBillingGroupsAuditWriter(executor: SqlExecutor): BillingGroupsAuditWriter {
  if (!executor || typeof executor.query !== 'function') throw new TypeError('database executor is required');
  return async (input) => {
    await executor
      .query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
            source_ip, user_agent, entry_point)
         VALUES ($1, NULL, $2, $3, 'saas_billing_groups', $4, clock_timestamp(), $5::inet, $6, 'billing-groups-http')`,
        [randomUUID(), input.actorUserId, input.action, input.targetId, input.sourceIp, input.userAgent],
      )
      .catch(() => undefined);
  };
}

export function createBillingGroupsHttpHandler(options: BillingGroupsHttpOptions): BillingGroupsHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service || typeof options.service.listBillingGroups !== 'function') {
    throw new TypeError('billing groups service is required');
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
        requireExactKeys(body, []);
        const groups = await options.service.listBillingGroups();
        sendJson(res, 200, requestId, { groups: groups.map(groupDto) });
        return true;
      }

      if (action === 'get') {
        requireExactKeys(body, ['groupId']);
        const groupId = bodyText(body, 'groupId', 128);
        const group = await options.service.getBillingGroup(groupId);
        const accountPool = await options.service.listGroupAccountPool(groupId);
        sendJson(res, 200, requestId, {
          group: groupDto(group),
          accountPool: accountPool.map((entry) => ({ accountId: entry.accountId, priority: entry.priority })),
        });
        return true;
      }

      if (action === 'create' || action === 'update') {
        const input = bodyGroupInput(body);
        const group =
          action === 'create'
            ? await options.service.createBillingGroup(input)
            : await options.service.updateBillingGroup(input);
        if (audit) {
          await audit({
            action: `saas_billing_group.${action === 'create' ? 'created' : 'updated'}`,
            targetId: input.id,
            actorUserId: actor.userId,
            ...metadata,
          }).catch(() => undefined);
        }
        sendJson(res, 200, requestId, { group: groupDto(group) });
        return true;
      }

      if (action === 'replace-account-pool') {
        requireExactKeys(body, ['groupId', 'accounts']);
        const groupId = bodyText(body, 'groupId', 128);
        const accountsValue = body.accounts;
        if (!Array.isArray(accountsValue) || accountsValue.length > 10_000) {
          throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid account pool input');
        }
        const accounts = accountsValue.map((entry) => {
          if (
            entry === null ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            typeof (entry as { accountId?: unknown }).accountId !== 'string' ||
            typeof (entry as { priority?: unknown }).priority !== 'number' ||
            !Number.isSafeInteger((entry as { priority: number }).priority)
          ) {
            throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid account pool input');
          }
          return {
            accountId: (entry as { accountId: string }).accountId,
            priority: (entry as { priority: number }).priority,
          };
        });
        const outcome = await options.service.replaceGroupAccountPool(groupId, accounts);
        if (audit) {
          await audit({
            action: 'saas_billing_group.account_pool.replaced',
            targetId: groupId,
            actorUserId: actor.userId,
            ...metadata,
          }).catch(() => undefined);
        }
        sendJson(res, 200, requestId, {
          accounts: outcome.entries.map((entry) => ({ accountId: entry.accountId, priority: entry.priority })),
          // The scheduling fence bump: every key whose candidates changed had
          // authz_version incremented in the same transaction.
          invalidatedKeys: outcome.invalidatedKeys,
        });
        return true;
      }

      requireExactKeys(body, ['tenantId', 'projectId', 'keyId', 'billingGroupId']);
      const billingGroupId = bodyOptionalId(body, 'billingGroupId');
      const outcome = await options.service.setKeyBillingGroup({
        tenantId: bodyText(body, 'tenantId', 64),
        projectId: bodyText(body, 'projectId', 64),
        keyId: bodyText(body, 'keyId', 64),
        billingGroupId,
      });
      if (audit) {
        await audit({
          action: 'saas_billing_group.key_group.set',
          targetId: outcome.keyId,
          actorUserId: actor.userId,
          ...metadata,
        }).catch(() => undefined);
      }
      sendJson(res, 200, requestId, outcome);
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof SaasBillingGroupsError) {
        const mapped = billingGroupsErrorStatus(error);
        sendError(res, mapped.status, requestId, mapped.code, error.message);
        return true;
      }
      sendError(res, 503, requestId, 'BILLING_GROUPS_UNAVAILABLE', 'The billing group request could not be completed');
      return true;
    }
  };
}
