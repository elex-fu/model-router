import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import type {
  RecordUsageCorrectionInput,
  UsageCorrectionReasonCode,
  UsageCorrectionRecord,
  UsageCorrectionResult,
} from './usage-correction.js';

/**
 * Platform-operator HTTP entry for append-only usage corrections (contract
 * C-1.4). Corrections are content-addressed: the digest covers every field, so
 * retries of the same correction replay the original record without an
 * Idempotency-Key header. The operator identity is derived from the
 * authenticated platform session, never from the JSON body.
 */
const USAGE_CORRECTION_PREFIX = '/admin/api/v1/ops/usage-corrections';
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_REASON_LENGTH = 64;
const MAX_EVIDENCE_REFERENCE_LENGTH = 64;
const MAX_CURRENCY_LENGTH = 3;
const MAX_AMOUNT_LENGTH = 20;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export const USAGE_CORRECTION_PLATFORM_PATHS = Object.freeze({
  corrections: USAGE_CORRECTION_PREFIX,
} as const);

export interface UsageCorrectionPlatformListQuery {
  readonly tenantId: string;
  readonly usageEventId?: string;
  readonly limit: number;
}

export interface UsageCorrectionPlatformRecordInput extends Omit<RecordUsageCorrectionInput, 'operatorIdentity'> {
  /** Derived from the authenticated platform session; never accepted from JSON. */
  readonly actorUserId: string;
}

export interface UsageCorrectionPlatformOperations {
  listCorrections(input: UsageCorrectionPlatformListQuery): Promise<readonly UsageCorrectionRecord[]>;
  recordCorrection(input: UsageCorrectionPlatformRecordInput): Promise<UsageCorrectionResult>;
}

export interface UsageCorrectionPlatformHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly operations: UsageCorrectionPlatformOperations;
  readonly publicOrigin: string;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
}

export type UsageCorrectionPlatformHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'UsageCorrectionPlatformHttpError';
  }
}

const REASON_CODES: readonly UsageCorrectionReasonCode[] = [
  'provider_reported_correction',
  'billing_dispute',
  'metering_fault',
  'operator_adjustment',
];

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return normalized;
}

function requestUrl(req: IncomingMessage, publicOrigin: string): URL | undefined {
  try {
    return new URL(req.url ?? '/', publicOrigin);
  } catch {
    return undefined;
  }
}

function queryValues(url: URL, allowedKeys: readonly string[]): Map<string, string> {
  const allowed = new Set(allowedKeys);
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || values.has(key)) {
      throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
    }
    values.set(key, value);
  }
  return values;
}

function listQuery(url: URL): UsageCorrectionPlatformListQuery {
  const values = queryValues(url, ['tenantId', 'usageEventId', 'limit']);
  const tenantId = values.get('tenantId');
  if (
    tenantId === undefined ||
    tenantId.length === 0 ||
    tenantId.length > MAX_IDENTIFIER_LENGTH ||
    tenantId.trim() !== tenantId ||
    hasControlCharacter(tenantId)
  ) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  const usageEventId = values.get('usageEventId');
  if (
    usageEventId !== undefined &&
    (usageEventId.length === 0 ||
      usageEventId.length > MAX_IDENTIFIER_LENGTH ||
      usageEventId.trim() !== usageEventId ||
      hasControlCharacter(usageEventId))
  ) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }

  const rawLimit = values.get('limit');
  if (rawLimit === undefined) {
    return usageEventId === undefined
      ? { tenantId, limit: DEFAULT_LIST_LIMIT }
      : { tenantId, usageEventId, limit: DEFAULT_LIST_LIMIT };
  }
  if (!/^\d+$/u.test(rawLimit)) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return usageEventId === undefined ? { tenantId, limit } : { tenantId, usageEventId, limit };
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;

  let matches = 0;
  let value: string | undefined;
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    matches += 1;
    if (matches > 1) return undefined;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return matches === 1 && value !== undefined && value.length > 0 ? value : undefined;
}

function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function parseOrigin(publicOrigin: string): { readonly origin: string; readonly host: string } {
  if (typeof publicOrigin !== 'string' || publicOrigin.length === 0) {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('publicOrigin must be an HTTP(S) origin');
  }
  return { origin: parsed.origin, host: parsed.host };
}

function requireOrigin(req: IncomingMessage, originPolicy: { readonly origin: string; readonly host: string }): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }
  if (origin !== originPolicy.origin) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (host !== originPolicy.host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>,
): Promise<void> {
  const sessionToken = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrfCookie = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const csrfHeader = req.headers['x-csrf-token'];
  if (
    sessionToken === undefined ||
    csrfCookie === undefined ||
    typeof csrfHeader !== 'string' ||
    !sameSecret(csrfCookie, csrfHeader)
  ) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }

  let valid = false;
  try {
    valid = await authService.verifyCsrfToken(sessionToken, csrfCookie);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function contentTypeIsJson(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!contentTypeIsJson(req.headers['content-type'])) {
    drainRequest(req);
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    if (!/^\d+$/u.test(rawLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid');
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid');
    }
    if (declaredLength > MAX_BODY_BYTES) {
      drainRequest(req);
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  } else if (Array.isArray(rawLength)) {
    drainRequest(req);
    throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid');
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

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
  const object = asObject(value);
  if (!object) throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  const allowedKeys = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unsupported field');
  }
  if (required.some((key) => !Object.hasOwn(object, key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is missing a required field');
  }
  return object;
}

function usageTokenValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,19}$/u.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return BigInt(value).toString(10);
}

function parseCorrectionUsage(value: unknown): RecordUsageCorrectionInput['correctionUsage'] {
  const object = strictObject(
    value,
    [
      'inputTotal',
      'inputUncached',
      'cacheRead',
      'cacheWrite',
      'cacheWrite5m',
      'cacheWrite1h',
      'outputTotal',
      'reasoningOutput',
      'status',
      'source',
      'semanticsVersion',
      'measurementKind',
      'billableBasis',
    ],
    ['status', 'source', 'semanticsVersion', 'measurementKind', 'billableBasis'],
  );
  return {
    inputTotal: usageTokenValue(object.inputTotal ?? null),
    inputUncached: usageTokenValue(object.inputUncached ?? null),
    cacheRead: usageTokenValue(object.cacheRead ?? null),
    cacheWrite: usageTokenValue(object.cacheWrite ?? null),
    cacheWrite5m: usageTokenValue(object.cacheWrite5m ?? null),
    cacheWrite1h: usageTokenValue(object.cacheWrite1h ?? null),
    outputTotal: usageTokenValue(object.outputTotal ?? null),
    reasoningOutput: usageTokenValue(object.reasoningOutput ?? null),
    status: boundedText(object.status, 32) as RecordUsageCorrectionInput['correctionUsage']['status'],
    source: boundedText(object.source, 32) as RecordUsageCorrectionInput['correctionUsage']['source'],
    semanticsVersion: boundedText(object.semanticsVersion, 64),
    measurementKind: boundedText(
      object.measurementKind,
      32,
    ) as RecordUsageCorrectionInput['correctionUsage']['measurementKind'],
    billableBasis: boundedText(
      object.billableBasis,
      32,
    ) as RecordUsageCorrectionInput['correctionUsage']['billableBasis'],
  };
}

function parseRecordBody(value: unknown): Omit<UsageCorrectionPlatformRecordInput, 'actorUserId'> {
  const object = strictObject(
    value,
    [
      'tenantId',
      'usageEventId',
      'settlementId',
      'reasonCode',
      'correctionUsage',
      'amountDeltaMinorUnits',
      'currency',
      'evidenceRef',
    ],
    ['tenantId', 'usageEventId', 'reasonCode', 'correctionUsage', 'amountDeltaMinorUnits', 'currency'],
  );
  const reasonCode = boundedText(object.reasonCode, MAX_REASON_LENGTH);
  if (!(REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  const amountDeltaMinorUnits = boundedText(object.amountDeltaMinorUnits, MAX_AMOUNT_LENGTH);
  if (!/^-?\d+$/u.test(amountDeltaMinorUnits)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  const settlementId =
    object.settlementId === undefined || object.settlementId === null
      ? null
      : boundedText(object.settlementId, MAX_IDENTIFIER_LENGTH);
  const evidenceRef =
    object.evidenceRef === undefined || object.evidenceRef === null
      ? null
      : boundedText(object.evidenceRef, MAX_EVIDENCE_REFERENCE_LENGTH);
  return {
    tenantId: boundedText(object.tenantId, MAX_IDENTIFIER_LENGTH),
    usageEventId: boundedText(object.usageEventId, MAX_IDENTIFIER_LENGTH),
    settlementId,
    reasonCode: reasonCode as UsageCorrectionReasonCode,
    correctionUsage: parseCorrectionUsage(object.correctionUsage),
    amountDeltaMinorUnits,
    currency: boundedText(object.currency, MAX_CURRENCY_LENGTH),
    evidenceRef,
  };
}

function requireOperator(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (
    actor === undefined ||
    typeof actor.userId !== 'string' ||
    actor.userId.trim() === '' ||
    typeof actor.sessionId !== 'string' ||
    actor.sessionId.trim() === ''
  ) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  if (!hasPlatformRole(actor, ['operations'])) {
    throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
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

function operationError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error !== null && typeof error === 'object') {
    const status = (error as { readonly status?: unknown }).status;
    const code = (error as { readonly code?: unknown }).code;
    if (status === 400) return new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
    if (status === 404) {
      return new HttpError(404, typeof code === 'string' ? code : 'NOT_FOUND', 'The referenced record was not found');
    }
    if (status === 409) {
      return new HttpError(
        409,
        typeof code === 'string' ? code : 'CONFLICT',
        'The correction conflicts with the current request state',
      );
    }
  }
  return new HttpError(503, 'USAGE_CORRECTION_UNAVAILABLE', 'Usage correction is not available');
}

function methodNotAllowed(res: ServerResponse, requestId: string, allow: string): void {
  res.writeHead(405, {
    allow,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }));
}

function validateOptions(options: UsageCorrectionPlatformHttpOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (
    !options.operations ||
    typeof options.operations.listCorrections !== 'function' ||
    typeof options.operations.recordCorrection !== 'function'
  ) {
    throw new TypeError('usage-correction operations methods are required');
  }
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  parseOrigin(options.publicOrigin);
}

function assertListResult(value: readonly UsageCorrectionRecord[], tenantId: string): readonly UsageCorrectionRecord[] {
  if (!Array.isArray(value)) throw new Error('Invalid usage-correction list result');
  if (value.some((item) => item === null || item.tenantId !== tenantId)) {
    throw new Error('Usage-correction list result crossed the tenant boundary');
  }
  return value;
}

export function createUsageCorrectionPlatformHttpHandler(
  options: UsageCorrectionPlatformHttpOptions,
): UsageCorrectionPlatformHttpHandler {
  validateOptions(options);
  const originPolicy = parseOrigin(options.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const requestId = `usage_correction_${randomUUID()}`;
    const url = requestUrl(req, originPolicy.origin);
    if (url === undefined || url.pathname !== USAGE_CORRECTION_PREFIX) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      drainRequest(req);
      methodNotAllowed(res, requestId, 'GET, POST');
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);

      if (method === 'GET') {
        const query = listQuery(url);
        const corrections = await options.operations.listCorrections(query);
        sendJson(res, 200, requestId, { items: assertListResult(corrections, query.tenantId) });
        return true;
      }

      requireOrigin(req, originPolicy);
      await requireCsrf(req, options.authService);
      const body = parseRecordBody(await readJson(req));
      const result = await options.operations.recordCorrection({
        ...body,
        actorUserId: actor.userId,
      });
      sendJson(res, result.replayed ? 200 : 201, requestId, result);
      return true;
    } catch (error) {
      drainRequest(req);
      if (res.destroyed || res.writableEnded) return true;
      const safeError = error instanceof HttpError ? error : operationError(error);
      sendError(res, safeError.status, requestId, safeError.code, safeError.safeMessage);
      return true;
    }
  };
}
