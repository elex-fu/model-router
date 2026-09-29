import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { AuthenticatedApiKey } from '../keys/types.js';
import type {
  PreparedEvidenceClientStream,
  PreparedEvidenceDispatchInput,
  PreparedEvidenceDispatchResult,
} from './prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceAudit } from './prepared-request-evidence-service.js';
import type {
  CanonicalRequestStatusReference,
  RequestPreparationFailureResult,
  RequestPreparationInput,
  RequestPreparationPreparedResult,
  RequestPreparationResult,
} from './request-preparation-service.js';

const GATEWAY_PREFIX = '/v1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODEL_LENGTH = 512;
const MAX_AUTHORIZATION_LENGTH = 4096;
const MAX_AUDIT_VALUE_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;
const ENTRY_POINT = 'hosted-gateway-http';

const ROUTES = new Map<string, 'openai' | 'responses' | 'anthropic'>([
  ['/v1/chat/completions', 'openai'],
  ['/v1/responses', 'responses'],
  ['/v1/messages', 'anthropic'],
]);

/** The only authentication capability accepted by the hosted HTTP boundary. */
export interface ProxyKeyAuthenticator {
  authenticate(rawKey: string): Promise<AuthenticatedApiKey | null>;
}

export interface RequestPreparationPort {
  prepare(input: RequestPreparationInput): Promise<RequestPreparationResult>;
}

export interface PreparedEvidenceDispatchPort {
  dispatch(input: PreparedEvidenceDispatchInput): Promise<PreparedEvidenceDispatchResult>;
}

/** Resolves model IDs through the same key, entitlement, and route authority as request preparation. */
export interface ModelDiscoveryPort {
  list(authenticatedCaller: AuthenticatedApiKey): Promise<readonly string[]>;
}

/**
 * The aliases keep this adapter usable by composition code while it is still
 * being wired. A missing capability is handled as a closed 503 at request
 * time; this adapter never creates a local fallback authenticator or service.
 */
export interface SaasGatewayHttpOptions {
  readonly authenticator?: ProxyKeyAuthenticator;
  readonly proxyKeyAuthenticator?: ProxyKeyAuthenticator;
  readonly preparation?: RequestPreparationPort;
  readonly preparationService?: RequestPreparationPort;
  readonly dispatch?: PreparedEvidenceDispatchPort;
  readonly dispatchService?: PreparedEvidenceDispatchPort;
  readonly modelDiscovery?: ModelDiscoveryPort;
  readonly maxBodyBytes?: number;
  readonly entryPoint?: string;
}

/** Server-created request identity passed by a trusted composition boundary. */
export interface SaasGatewayHttpRequestContext {
  readonly requestId: string;
}

export type SaasGatewayHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context?: SaasGatewayHttpRequestContext,
) => Promise<boolean>;

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super();
    this.name = 'GatewayHttpError';
  }
}

class ClientStreamError extends Error {
  constructor(readonly code: 'CLIENT_STREAM_ABORTED' | 'CLIENT_STREAM_FAILED') {
    super();
    this.name = 'ClientStreamError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function drainRequest(req: IncomingMessage): void {
  try {
    req.resume();
  } catch {
    // The response remains a stable error even when a test or transport shim
    // does not expose a fully functional IncomingMessage.
  }
}

function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const rawValues: string[] = [];
  const rawHeaders = req.rawHeaders ?? [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'idempotency-key') rawValues.push(rawHeaders[index + 1] ?? '');
  }
  if (rawValues.length > 1) throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  const raw = rawValues[0] ?? req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255 || raw.trim() !== raw) {
    throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  }
  if (
    [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    throw new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  }
  return raw;
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    const pathname = new URL(req.url ?? '/', 'http://saas-gateway.invalid').pathname;
    return pathname.length <= MAX_PATH_LENGTH ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonError(res: ServerResponse, status: number, code: string, requestId: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    });
    res.end(JSON.stringify({ error: { code, message: 'The request could not be completed', requestId } }));
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function sendHttpError(res: ServerResponse, error: GatewayHttpError, requestId: string): void {
  writeJsonError(res, error.status, error.code, requestId);
}

function sendCanonicalRequestStatus(
  res: ServerResponse,
  requestId: string,
  canonicalRequest: CanonicalRequestStatusReference,
): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    const statusCode = canonicalRequest.status === 'completed' ? 200 : 202;
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
      'x-canonical-request-id': canonicalRequest.requestId,
    });
    res.end(
      JSON.stringify({
        object: 'request_status',
        id: canonicalRequest.requestId,
        status: canonicalRequest.status,
        response_replayed: false,
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function supportedContentType(req: IncomingMessage): boolean {
  const value = oneHeader(req, 'content-type');
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function declaredBodyLength(req: IncomingMessage, maxBodyBytes: number): 'valid' | 'too_large' | 'invalid' {
  const raw = req.headers['content-length'];
  if (raw === undefined) return 'valid';
  if (Array.isArray(raw) || typeof raw !== 'string') return 'invalid';
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return 'invalid';
  try {
    return BigInt(value) > BigInt(maxBodyBytes) ? 'too_large' : 'valid';
  } catch {
    return 'invalid';
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        throw new GatewayHttpError(400, 'INVALID_BODY');
      }
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBodyBytes) {
        drainRequest(req);
        throw new GatewayHttpError(413, 'BODY_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    drainRequest(req);
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }

  if (size === 0) throw new GatewayHttpError(400, 'INVALID_BODY');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }
  if (!isRecord(parsed)) throw new GatewayHttpError(400, 'INVALID_BODY');
  return parsed;
}

function clientAuthorityField(body: Record<string, unknown>): boolean {
  const forbidden = new Set(['endpoint', 'account', 'accountId', 'credential', 'credentialId', 'credentials']);
  return Object.keys(body).some((key) => forbidden.has(key));
}

function publicModel(body: Record<string, unknown>): string {
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model || model.length > MAX_MODEL_LENGTH) {
    throw new GatewayHttpError(400, 'INVALID_BODY');
  }
  return model;
}

function bearerKey(req: IncomingMessage): string | undefined {
  const header = oneHeader(req, 'authorization');
  if (header === undefined) return undefined;
  const value = header.trim();
  const match = /^Bearer[ \t]+([^ \t\r\n]+)$/i.exec(value);
  if (!match || match[1].length === 0 || match[1].length > MAX_AUTHORIZATION_LENGTH) return undefined;
  return match[1];
}

async function authenticateCaller(
  req: IncomingMessage,
  authenticator: ProxyKeyAuthenticator,
): Promise<AuthenticatedApiKey> {
  const key = bearerKey(req);
  if (key === undefined) throw new GatewayHttpError(401, 'UNAUTHENTICATED');

  try {
    const authenticatedCaller = await authenticator.authenticate(key);
    if (!authenticatedCaller) throw new GatewayHttpError(401, 'UNAUTHENTICATED');
    return authenticatedCaller;
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    throw new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE');
  }
}

function authenticatedModelScopes(authenticatedCaller: AuthenticatedApiKey): readonly string[] | null {
  const authorizationScopes = authenticatedCaller?.authorization?.modelScopes;
  const metadataScopes = authenticatedCaller?.metadata?.modelScopes;
  if (
    authenticatedCaller?.metadata?.status !== 'active' ||
    !Array.isArray(authorizationScopes) ||
    !Array.isArray(metadataScopes) ||
    authorizationScopes.length === 0 ||
    authorizationScopes.length !== metadataScopes.length ||
    new Set(authorizationScopes).size !== authorizationScopes.length ||
    authorizationScopes.some(
      (scope, index) =>
        typeof scope !== 'string' ||
        scope.length === 0 ||
        scope.length > MAX_MODEL_LENGTH ||
        scope.trim() !== scope ||
        scope !== metadataScopes[index],
    )
  ) {
    return null;
  }
  return authorizationScopes;
}

function validatedDiscoveredModels(
  authenticatedCaller: AuthenticatedApiKey,
  models: unknown,
): readonly string[] | null {
  const scopes = authenticatedModelScopes(authenticatedCaller);
  if (!scopes || !Array.isArray(models)) return null;
  const scopeSet = new Set(scopes);
  const seen = new Set<string>();
  for (const model of models) {
    if (
      typeof model !== 'string' ||
      model.length === 0 ||
      model.length > MAX_MODEL_LENGTH ||
      model.trim() !== model ||
      !scopeSet.has(model) ||
      seen.has(model)
    ) {
      return null;
    }
    seen.add(model);
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function sendModelList(res: ServerResponse, requestId: string, models: readonly string[]): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  try {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    });
    res.end(
      JSON.stringify({
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'managed-saas' })),
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing else is safe to send after the response write failed.
    }
  }
}

function safeAuditValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AUDIT_VALUE_LENGTH) return null;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    return null;
  }
  return value;
}

function requestAudit(req: IncomingMessage, entryPoint: string): Omit<PreparedRequestEvidenceAudit, 'actorUserId'> {
  return {
    entryPoint,
    sourceIp: safeAuditValue(req.socket?.remoteAddress) ?? null,
    userAgent: safeAuditValue(oneHeader(req, 'user-agent')),
  };
}

function preparationError(result: RequestPreparationResult): GatewayHttpError {
  if (result.outcome !== 'prepared' && result.code === 'idempotency_conflict') {
    return new GatewayHttpError(409, 'IDEMPOTENCY_CONFLICT');
  }
  if (result.outcome !== 'prepared' && result.code === 'idempotency_replay') {
    return new GatewayHttpError(409, 'IDEMPOTENCY_REPLAY_UNAVAILABLE');
  }
  if (result.outcome === 'rejected') return new GatewayHttpError(403, 'REQUEST_REJECTED');
  return new GatewayHttpError(503, 'REQUEST_BLOCKED');
}

function isPreparedResult(value: RequestPreparationResult): value is RequestPreparationPreparedResult {
  return (
    isRecord(value) &&
    value.outcome === 'prepared' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    isRecord(value.evidence) &&
    typeof value.evidence.evidenceId === 'string' &&
    value.evidence.evidenceId.length > 0 &&
    value.payloadBytes instanceof Uint8Array
  );
}

function safeResponseHeaders(headers: Readonly<Record<string, string>>): OutgoingHttpHeaders {
  const allowlist = new Set([
    'cache-control',
    'content-encoding',
    'content-language',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'retry-after',
    'vary',
  ]);
  const reduced: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!allowlist.has(normalized) || typeof value !== 'string') continue;
    if (
      [...normalized, ...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      continue;
    }
    reduced[normalized] = value;
  }
  return reduced;
}

function responseStatus(status: number | null): number {
  if (status === null) return 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new ClientStreamError('CLIENT_STREAM_FAILED');
  }
  return status;
}

/**
 * Adapts the dispatch service's cancellation-aware sink to Node's response.
 * It deliberately does not expose arbitrary provider headers to the client.
 */
export class NodePreparedEvidenceClientStream implements PreparedEvidenceClientStream {
  private readonly controller = new AbortController();
  private responseStarted = false;
  private disposed = false;
  private readonly onRequestAborted = () => this.controller.abort();
  private readonly onRequestClose = () => {
    if (!this.request.complete) this.controller.abort();
  };
  private readonly onResponseClose = () => {
    if (!this.response.writableEnded) this.controller.abort();
  };
  private readonly onResponseError = () => this.controller.abort();

  constructor(
    private readonly request: IncomingMessage,
    private readonly response: ServerResponse,
    private readonly requestId: string,
  ) {
    this.request.once('aborted', this.onRequestAborted);
    this.request.once('close', this.onRequestClose);
    this.response.once('close', this.onResponseClose);
    this.response.once('error', this.onResponseError);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (this.responseStarted || this.response.headersSent) throw new ClientStreamError('CLIENT_STREAM_FAILED');
    this.response.writeHead(responseStatus(status), {
      ...safeResponseHeaders(headers),
      'x-request-id': this.requestId,
    });
    this.responseStarted = true;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.writableEnded || this.response.destroyed) {
      throw new ClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (!(chunk instanceof Uint8Array)) throw new ClientStreamError('CLIENT_STREAM_FAILED');

    let accepted: boolean;
    try {
      accepted = this.response.write(Buffer.from(chunk));
    } catch {
      throw new ClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (accepted) return;
    await this.waitForDrain();
  }

  end(): void {
    if (this.signal.aborted) throw new ClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.destroyed) throw new ClientStreamError('CLIENT_STREAM_FAILED');
    if (!this.response.writableEnded) this.response.end();
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort();
    if (this.response.headersSent && !this.response.writableEnded && !this.response.destroyed) {
      try {
        this.response.destroy();
      } catch {
        // The socket is already unusable; the abort signal is the durable fact.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request.removeListener('aborted', this.onRequestAborted);
    this.request.removeListener('close', this.onRequestClose);
    this.response.removeListener('close', this.onResponseClose);
    this.response.removeListener('error', this.onResponseError);
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.response.removeListener('drain', onDrain);
        this.response.removeListener('close', onClose);
        this.response.removeListener('error', onError);
        this.signal.removeEventListener('abort', onAbort);
      };
      const settle = (error?: ClientStreamError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDrain = () => settle();
      const onClose = () => {
        this.controller.abort();
        settle(new ClientStreamError('CLIENT_STREAM_ABORTED'));
      };
      const onError = () => settle(new ClientStreamError('CLIENT_STREAM_FAILED'));
      const onAbort = () => settle(new ClientStreamError('CLIENT_STREAM_ABORTED'));

      this.response.once('drain', onDrain);
      this.response.once('close', onClose);
      this.response.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted || this.response.destroyed) onAbort();
    });
  }
}

function validMaxBodyBytes(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_MAX_BODY_BYTES;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validEntryPoint(value: string | undefined): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    return value;
  }
  return ENTRY_POINT;
}

function trustedRequestId(context: SaasGatewayHttpRequestContext | undefined): string | undefined {
  const requestId = context?.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256) return undefined;
  if (
    [...requestId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    return undefined;
  }
  return requestId;
}

export function createSaasGatewayHandler(options: SaasGatewayHttpOptions): SaasGatewayHttpHandler {
  const authenticator = options.authenticator ?? options.proxyKeyAuthenticator;
  const preparation = options.preparation ?? options.preparationService;
  const dispatch = options.dispatch ?? options.dispatchService;
  const modelDiscovery = options.modelDiscovery;
  const maxBodyBytes = validMaxBodyBytes(options.maxBodyBytes);
  const entryPoint = validEntryPoint(options.entryPoint);

  return async (req, res, context) => {
    const requestId = trustedRequestId(context) ?? `gateway_${randomUUID()}`;
    const path = requestPath(req);
    if (path === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(400, 'INVALID_PATH'), requestId);
      return true;
    }
    if (!path.startsWith(`${GATEWAY_PREFIX}/`) && path !== GATEWAY_PREFIX) return false;

    res.setHeader('x-request-id', requestId);

    if (maxBodyBytes === null || !authenticator) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
      return true;
    }

    if (path === '/v1/models') {
      drainRequest(req);
      if ((req.method ?? '').toUpperCase() !== 'GET') {
        sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
        return true;
      }
      if (!modelDiscovery) {
        sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
        return true;
      }

      let authenticatedCaller: AuthenticatedApiKey;
      try {
        authenticatedCaller = await authenticateCaller(req, authenticator);
      } catch (error) {
        sendHttpError(
          res,
          error instanceof GatewayHttpError ? error : new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE'),
          requestId,
        );
        return true;
      }

      let models: readonly string[] | null;
      try {
        models = validatedDiscoveredModels(authenticatedCaller, await modelDiscovery.list(authenticatedCaller));
      } catch {
        models = null;
      }
      if (!models) {
        sendHttpError(res, new GatewayHttpError(503, 'MODEL_DISCOVERY_UNAVAILABLE'), requestId);
        return true;
      }
      sendModelList(res, requestId, models);
      return true;
    }

    if (!preparation || !dispatch) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(503, 'GATEWAY_UNAVAILABLE'), requestId);
      return true;
    }

    const protocol = ROUTES.get(path);
    if (protocol === undefined) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(404, 'NOT_FOUND'), requestId);
      return true;
    }

    if ((req.method ?? '').toUpperCase() !== 'POST') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(405, 'METHOD_NOT_ALLOWED'), requestId);
      return true;
    }

    if (!supportedContentType(req)) {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(415, 'UNSUPPORTED_MEDIA_TYPE'), requestId);
      return true;
    }

    const length = declaredBodyLength(req, maxBodyBytes);
    if (length === 'too_large') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(413, 'BODY_TOO_LARGE'), requestId);
      return true;
    }
    if (length === 'invalid') {
      drainRequest(req);
      sendHttpError(res, new GatewayHttpError(400, 'INVALID_BODY'), requestId);
      return true;
    }

    let authenticatedCaller: AuthenticatedApiKey | null;
    try {
      authenticatedCaller = await authenticateCaller(req, authenticator);
    } catch (error) {
      drainRequest(req);
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(503, 'AUTHENTICATION_UNAVAILABLE'),
        requestId,
      );
      return true;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, maxBodyBytes);
      if (clientAuthorityField(body)) throw new GatewayHttpError(400, 'INVALID_BODY');
    } catch (error) {
      const httpError = error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY');
      sendHttpError(res, httpError, requestId);
      return true;
    }

    let model: string;
    try {
      model = publicModel(body);
    } catch (error) {
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_BODY'),
        requestId,
      );
      return true;
    }

    const auditContext = requestAudit(req, entryPoint);
    let requestIdempotencyKey: string | undefined;
    try {
      requestIdempotencyKey = idempotencyKey(req);
    } catch (error) {
      sendHttpError(
        res,
        error instanceof GatewayHttpError ? error : new GatewayHttpError(400, 'INVALID_IDEMPOTENCY_KEY'),
        requestId,
      );
      return true;
    }
    let prepared: RequestPreparationResult;
    try {
      prepared = await preparation.prepare({
        authenticatedCaller,
        publicModel: model,
        protocol,
        clientRequest: body,
        idempotencyKey: requestIdempotencyKey,
        audit: auditContext,
      });
    } catch {
      sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      return true;
    }

    if (!isPreparedResult(prepared)) {
      if (isRecord(prepared) && (prepared.outcome === 'rejected' || prepared.outcome === 'blocked')) {
        const rejected = prepared as RequestPreparationFailureResult;
        if (rejected.code === 'idempotency_replay' && rejected.canonicalRequest) {
          sendCanonicalRequestStatus(res, requestId, rejected.canonicalRequest);
          return true;
        }
        sendHttpError(res, preparationError(prepared as RequestPreparationResult), requestId);
      } else {
        sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      }
      return true;
    }
    if (prepared.requestId !== requestId) {
      sendHttpError(res, new GatewayHttpError(503, 'PREPARATION_UNAVAILABLE'), requestId);
      return true;
    }

    const client = new NodePreparedEvidenceClientStream(req, res, requestId);
    const dispatchAudit: PreparedRequestEvidenceAudit = {
      ...auditContext,
      actorUserId: authenticatedCaller.authorization.principalId,
      requestId,
    };
    let dispatched: PreparedEvidenceDispatchResult;
    try {
      dispatched = await dispatch.dispatch({
        evidenceId: prepared.evidence.evidenceId,
        payloadBytes: prepared.payloadBytes,
        normalSuccessSnapshot: prepared.normalSuccessSnapshot,
        audit: dispatchAudit,
        client,
      });
    } catch {
      client.abort();
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_FAILED'), requestId);
      client.dispose();
      return true;
    }
    client.dispose();

    if (!isRecord(dispatched) || (dispatched.kind !== 'sent' && dispatched.kind !== 'unknown')) {
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_FAILED'), requestId);
      return true;
    }
    if (dispatched.kind === 'unknown' && !res.headersSent && !res.destroyed) {
      sendHttpError(res, new GatewayHttpError(502, 'DISPATCH_OUTCOME_UNKNOWN'), requestId);
    }
    return true;
  };
}

export { createSaasGatewayHandler as createSaasHostedGatewayHandler };
