import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import type {
  UnknownOutcomeOperatorCase,
  UnknownOutcomeOperatorCaseDetail,
  UnknownOutcomeOperatorResolutionResult,
} from './unknown-outcome-recovery-worker.js';

const UNKNOWN_OUTCOME_PREFIX = '/admin/api/v1/ops/unknown-outcomes';
const MAX_CASE_ID_LENGTH = 255;
const MAX_TENANT_ID_LENGTH = 255;
const MAX_SUPPORT_TICKET_REF_LENGTH = 255;
const MAX_REASON_LENGTH = 2000;
const MAX_ATTEMPT_ID_LENGTH = 255;
const MAX_EVIDENCE_REFERENCE_LENGTH = 512;
const MAX_COVERAGE_ITEMS = 100;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export const UNKNOWN_OUTCOME_PLATFORM_PATHS = Object.freeze({
  cases: UNKNOWN_OUTCOME_PREFIX,
  detail: `${UNKNOWN_OUTCOME_PREFIX}/:caseId`,
  resolve: `${UNKNOWN_OUTCOME_PREFIX}/:caseId/resolve-not-executed`,
} as const);

export interface UnknownOutcomePlatformCaseListQuery {
  readonly tenantId: string;
  readonly limit: number;
}

export interface UnknownOutcomePlatformCaseDetailQuery {
  readonly tenantId: string;
  readonly caseId: string;
}

export interface UnknownOutcomePlatformCoverage {
  readonly attemptId: string;
  readonly outcome: 'not_executed';
  readonly evidenceReference: string;
}

export interface UnknownOutcomePlatformResolutionInput {
  readonly tenantId: string;
  readonly caseId: string;
  /** Derived from the authenticated platform session; never accepted from JSON. */
  readonly actorUserId: string;
  /** Derived from the authenticated platform session; the adapter revalidates it as active in its transaction. */
  readonly actorSessionId: string;
  readonly idempotencyKey: string;
  /** A support-system locator only; it is not Provider evidence or a proof of non-execution. */
  readonly supportTicketRef: string;
  readonly reason: string;
  /** The operations port must enforce exact coverage of every possibly dispatched attempt. */
  readonly coverage: readonly UnknownOutcomePlatformCoverage[];
}

/**
 * The HTTP boundary owns this port instead of wiring the legacy worker/service
 * directly. Keeping supportTicketRef here preserves the full operator payload
 * without allowing a support ticket to masquerade as Provider evidence.
 */
export interface UnknownOutcomePlatformOperations {
  listCases(input: UnknownOutcomePlatformCaseListQuery): Promise<readonly UnknownOutcomeOperatorCase[]>;
  getCase(input: UnknownOutcomePlatformCaseDetailQuery): Promise<UnknownOutcomeOperatorCaseDetail | null>;
  resolveCase(input: UnknownOutcomePlatformResolutionInput): Promise<UnknownOutcomeOperatorResolutionResult>;
}

export type UnknownOutcomePlatformOperationsPort = UnknownOutcomePlatformOperations;

export interface UnknownOutcomePlatformHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly operations: UnknownOutcomePlatformOperations;
  readonly publicOrigin: string;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
}

export type UnknownOutcomePlatformHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type Route =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly caseId: string }
  | { readonly kind: 'resolve'; readonly caseId: string };

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'UnknownOutcomePlatformHttpError';
  }
}

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

function pathIdentifier(encoded: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The unknown-outcome case path is invalid');
  }
  if (
    decoded.length === 0 ||
    decoded.length > MAX_CASE_ID_LENGTH ||
    decoded.trim() !== decoded ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    hasControlCharacter(decoded)
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The unknown-outcome case path is invalid');
  }
  return decoded;
}

function routeFor(pathname: string): Route | undefined {
  if (pathname === UNKNOWN_OUTCOME_PREFIX) return { kind: 'list' };
  if (!pathname.startsWith(`${UNKNOWN_OUTCOME_PREFIX}/`)) return undefined;

  const segments = pathname.slice(`${UNKNOWN_OUTCOME_PREFIX}/`.length).split('/');
  if (segments.length === 1 && segments[0] !== '') {
    return { kind: 'detail', caseId: pathIdentifier(segments[0] as string) };
  }
  if (segments.length === 2 && segments[1] === 'resolve-not-executed' && segments[0] !== '') {
    return { kind: 'resolve', caseId: pathIdentifier(segments[0] as string) };
  }
  return undefined;
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

function tenantIdQuery(url: URL): string {
  const values = queryValues(url, ['tenantId']);
  const value = values.get('tenantId');
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_TENANT_ID_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return value;
}

function listQuery(url: URL): UnknownOutcomePlatformCaseListQuery {
  const values = queryValues(url, ['tenantId', 'limit']);
  const tenantId = values.get('tenantId');
  if (
    tenantId === undefined ||
    tenantId.length === 0 ||
    tenantId.length > MAX_TENANT_ID_LENGTH ||
    tenantId.trim() !== tenantId ||
    hasControlCharacter(tenantId)
  ) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }

  const rawLimit = values.get('limit');
  if (rawLimit === undefined) return { tenantId, limit: DEFAULT_LIST_LIMIT };
  if (!/^\d+$/u.test(rawLimit)) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
  }
  return { tenantId, limit };
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
    if (declaredLength > PLATFORM_ADMIN_MAX_BODY_BYTES) {
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
    if (size <= PLATFORM_ADMIN_MAX_BODY_BYTES) chunks.push(buffer);
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

function bodyText(object: JsonObject, key: string, maxLength: number): string {
  return boundedText(object[key], maxLength);
}

function parseCoverage(value: unknown): readonly UnknownOutcomePlatformCoverage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COVERAGE_ITEMS) {
    throw new HttpError(400, 'INVALID_COVERAGE', 'Coverage must contain one entry for each possible dispatch attempt');
  }

  const seen = new Set<string>();
  return value.map((entry) => {
    const item = strictObject(
      entry,
      ['attemptId', 'outcome', 'evidenceReference'],
      ['attemptId', 'outcome', 'evidenceReference'],
    );
    const attemptId = bodyText(item, 'attemptId', MAX_ATTEMPT_ID_LENGTH);
    if (seen.has(attemptId)) {
      throw new HttpError(400, 'INVALID_COVERAGE', 'Coverage must contain exactly one entry per attempt');
    }
    seen.add(attemptId);
    if (item.outcome !== 'not_executed') {
      throw new HttpError(400, 'INVALID_COVERAGE', 'Only not_executed coverage is accepted by this operation');
    }
    return {
      attemptId,
      outcome: 'not_executed',
      evidenceReference: bodyText(item, 'evidenceReference', MAX_EVIDENCE_REFERENCE_LENGTH),
    };
  });
}

function parseResolutionBody(
  value: unknown,
): Pick<UnknownOutcomePlatformResolutionInput, 'supportTicketRef' | 'reason' | 'coverage'> {
  const object = strictObject(
    value,
    ['supportTicketRef', 'reason', 'coverage'],
    ['supportTicketRef', 'reason', 'coverage'],
  );
  return {
    supportTicketRef: bodyText(object, 'supportTicketRef', MAX_SUPPORT_TICKET_REF_LENGTH),
    reason: bodyText(object, 'reason', MAX_REASON_LENGTH),
    coverage: parseCoverage(object.coverage),
  };
}

function idempotencyKey(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
  }
  return value;
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
    if (status === 403) return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    if (status === 404)
      return new HttpError(404, 'UNKNOWN_OUTCOME_CASE_NOT_FOUND', 'The unknown-outcome case was not found');
    if (status === 409)
      return new HttpError(409, 'RESOLUTION_CONFLICT', 'The resolution conflicts with the current case state');
  }
  return new HttpError(503, 'UNKNOWN_OUTCOME_UNAVAILABLE', 'Unknown-outcome reconciliation is not available');
}

function resolutionError(result: UnknownOutcomeOperatorResolutionResult): HttpError | undefined {
  switch (result.status) {
    case 'resolved':
    case 'replayed':
      return undefined;
    case 'unauthorized':
      return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    case 'case_not_found':
      return new HttpError(404, 'UNKNOWN_OUTCOME_CASE_NOT_FOUND', 'The unknown-outcome case was not found');
    case 'insufficient_evidence':
      return new HttpError(422, 'INSUFFICIENT_EVIDENCE', 'Coverage is incomplete for the possible dispatch attempts');
    case 'unexpected_attempt_coverage':
      return new HttpError(400, 'INVALID_COVERAGE', 'Coverage contains an unexpected or duplicate attempt');
    case 'contradictory_evidence':
      return new HttpError(409, 'CONTRADICTORY_EVIDENCE', 'The evidence does not support a not-executed resolution');
    case 'request_not_unknown':
      return new HttpError(409, 'REQUEST_NOT_UNKNOWN', 'The request is no longer awaiting reconciliation');
    case 'financial_state_conflict':
      return new HttpError(409, 'FINANCIAL_STATE_CONFLICT', 'The financial state does not permit this resolution');
    case 'resolution_conflict':
      return new HttpError(409, 'RESOLUTION_CONFLICT', 'The resolution conflicts with the current case state');
    default:
      return new HttpError(503, 'UNKNOWN_OUTCOME_UNAVAILABLE', 'Unknown-outcome reconciliation is not available');
  }
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

function validateOptions(options: UnknownOutcomePlatformHttpOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (!options.operations || typeof options.operations !== 'object') {
    throw new TypeError('operations are required');
  }
  if (
    typeof options.operations.listCases !== 'function' ||
    typeof options.operations.getCase !== 'function' ||
    typeof options.operations.resolveCase !== 'function'
  ) {
    throw new TypeError('unknown-outcome operations methods are required');
  }
  if (!options.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  parseOrigin(options.publicOrigin);
}

function assertListResult(
  value: readonly UnknownOutcomeOperatorCase[],
  tenantId: string,
): readonly UnknownOutcomeOperatorCase[] {
  if (!Array.isArray(value)) throw new Error('Invalid unknown-outcome list result');
  if (value.some((item) => item === null || item.tenantId !== tenantId)) {
    throw new Error('Unknown-outcome list result crossed the tenant boundary');
  }
  return value;
}

export function createUnknownOutcomePlatformHttpHandler(
  options: UnknownOutcomePlatformHttpOptions,
): UnknownOutcomePlatformHttpHandler {
  validateOptions(options);
  const originPolicy = parseOrigin(options.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const requestId = `unknown_outcome_${randomUUID()}`;
    const url = requestUrl(req, originPolicy.origin);
    const route = url === undefined ? undefined : routeFor(url.pathname);
    if (route === undefined || url === undefined) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const expectedMethod = route.kind === 'resolve' ? 'POST' : 'GET';
    if (method !== expectedMethod) {
      drainRequest(req);
      methodNotAllowed(res, requestId, expectedMethod);
      return true;
    }

    try {
      if (url.hash !== '') throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const actor = await options.access.authenticate(req);
      requireOperator(actor);

      if (route.kind === 'list') {
        const query = listQuery(url);
        const cases = await options.operations.listCases(query);
        sendJson(res, 200, requestId, { items: assertListResult(cases, query.tenantId) });
        return true;
      }

      const tenantId = tenantIdQuery(url);
      if (route.kind === 'detail') {
        const detail = await options.operations.getCase({ tenantId, caseId: route.caseId });
        if (detail === null) {
          throw new HttpError(404, 'UNKNOWN_OUTCOME_CASE_NOT_FOUND', 'The unknown-outcome case was not found');
        }
        if (detail.summary.tenantId !== tenantId || detail.summary.caseId !== route.caseId) {
          throw new Error('Unknown-outcome detail crossed the tenant boundary');
        }
        sendJson(res, 200, requestId, detail);
        return true;
      }

      requireOrigin(req, originPolicy);
      await requireCsrf(req, options.authService);
      const operationId = idempotencyKey(req);
      const body = parseResolutionBody(await readJson(req));
      const result = await options.operations.resolveCase({
        tenantId,
        caseId: route.caseId,
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        idempotencyKey: operationId,
        supportTicketRef: body.supportTicketRef,
        reason: body.reason,
        coverage: body.coverage,
      });
      const error = resolutionError(result);
      if (error) throw error;
      sendJson(res, 200, requestId, result);
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
