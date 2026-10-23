import { ResponsesContinuationStore } from './responses-continuation.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolveClientAddress } from './client-address.js';
import type {
  ContentModerationPort,
  PreparedEvidenceDispatchPort,
  ProxyKeyAuthenticator,
  RequestPreparationPort,
} from './http-handler.js';
import type { GatewayPreDispatchCompensationPort } from './pre-dispatch-compensation-service.js';
import type { PreparedEvidenceClientStream } from './prepared-evidence-dispatch-service.js';
import type {
  RequestPreparationFailureResult,
  RequestPreparationPreparedResult,
} from './request-preparation-service.js';
import {
  type ResponsesWsEvent,
  type ResponsesWsPinnedIdentity,
  ResponsesWsRoundError,
  type ResponsesWsRoundExecutor,
} from './responses-ws-engine.js';

interface ResponsesWsExecutorOptions {
  readonly request: IncomingMessage;
  readonly authenticator: ProxyKeyAuthenticator;
  readonly preparation: RequestPreparationPort;
  readonly dispatch: PreparedEvidenceDispatchPort;
  readonly compensation: GatewayPreDispatchCompensationPort;
  readonly entryPoint: string;
  readonly maxBodyBytes: number;
  readonly trustedProxyCidrs?: readonly string[];
  readonly contentModeration?: ContentModerationPort;
  readonly runWithRequestId: <T>(requestId: string, work: () => Promise<T>) => Promise<T>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeHeader(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024) return null;
  return [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    ? null
    : value;
}

/** A connection only retains the presented proxy key; its authority is refreshed every round. */
export function responsesWsProxyKey(req: IncomingMessage): string | null {
  const authorization = safeHeader(req.headers.authorization);
  const apiKey = safeHeader(req.headers['x-api-key']);
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    return match?.[1] ?? null;
  }
  return apiKey !== null && apiKey.trim() === apiKey && apiKey !== '' ? apiKey : null;
}

function preparationFailure(result: RequestPreparationFailureResult): ResponsesWsRoundError {
  if (result.code === 'rate_limited' || result.code === 'quota_exceeded') {
    return new ResponsesWsRoundError('RATE_LIMITED', 'the request quota is exhausted', 429);
  }
  if (result.code === 'budget_exceeded' || result.code === 'hold_denied') {
    return new ResponsesWsRoundError('PAYMENT_REQUIRED', 'the request funds are unavailable', 402);
  }
  if (result.code === 'capability_unsupported') {
    return new ResponsesWsRoundError('CAPABILITY_UNSUPPORTED', 'this supply cannot serve the requested operation', 404);
  }
  return new ResponsesWsRoundError(
    result.outcome === 'rejected' ? 'REQUEST_REJECTED' : 'REQUEST_BLOCKED',
    'the request was not admitted',
    result.outcome === 'rejected' ? 403 : 503,
  );
}

const TERMINAL_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled']);

/**
 * Bounded SSE-to-WS sink. Nonterminal frames await the actual socket send;
 * the terminal is withheld until prepared dispatch has durably settled.
 */
class ResponsesWsClientStream implements PreparedEvidenceClientStream {
  private readonly abortController = new AbortController();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private json = '';
  private sse = false;
  private started = false;
  private ended = false;
  status = 200;
  terminal: ResponsesWsEvent | null = null;
  upstreamResponseId: string | null = null;

  constructor(
    private readonly emit: (event: ResponsesWsEvent) => Promise<void>,
    private readonly maxBytes: number,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    if (this.started || this.signal.aborted) throw new Error('response stream unavailable');
    this.started = true;
    this.status = status ?? 200;
    this.sse = /^text\/event-stream(?:;|$)/i.test(headers['content-type'] ?? '');
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.started || this.ended || this.signal.aborted) throw new Error('response stream unavailable');
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (Buffer.byteLength(this.json) + chunk.byteLength > this.maxBytes) throw new Error('response frame too large');
      this.json += text;
      return;
    }
    this.pending += text;
    // A single event is bounded even when the provider never terminates it.
    if (Buffer.byteLength(this.pending) > this.maxBytes) throw new Error('response frame too large');
    await this.flushEvents(false);
  }

  private async flushEvents(final: boolean): Promise<void> {
    this.pending = this.pending.replace(/\r\n/g, '\n');
    while (true) {
      const boundary = this.pending.indexOf('\n\n');
      if (boundary < 0 && !final) return;
      if (boundary < 0 && this.pending === '') return;
      const block = boundary < 0 ? this.pending : this.pending.slice(0, boundary);
      this.pending = boundary < 0 ? '' : this.pending.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data === '' || data === '[DONE]') continue;
      const parsed: unknown = JSON.parse(data);
      if (!record(parsed) || typeof parsed.type !== 'string') throw new Error('invalid Responses event');
      const event = parsed as ResponsesWsEvent;
      this.observeResponseId(event);
      if (TERMINAL_TYPES.has(event.type)) this.terminal = event;
      else await this.emit(event);
    }
  }

  async end(): Promise<void> {
    if (this.signal.aborted) throw new Error('response stream cancelled');
    this.ended = true;
    const tail = this.decoder.decode();
    if (this.sse) {
      this.pending += tail;
      await this.flushEvents(true);
      return;
    }
    this.json += tail;
    if (this.json === '') return;
    const response: unknown = JSON.parse(this.json);
    if (!record(response)) throw new Error('invalid Responses response');
    if (this.status >= 200 && this.status < 300 && response.object === 'response') {
      const status = response.status;
      this.terminal = {
        type:
          status === 'incomplete'
            ? 'response.incomplete'
            : status === 'failed'
              ? 'response.failed'
              : 'response.completed',
        response,
      };
      this.observeResponseId(this.terminal);
    }
  }

  private observeResponseId(event: ResponsesWsEvent): void {
    const response = record(event.response) ? event.response : null;
    const id = typeof response?.id === 'string' ? response.id : event.response_id;
    if (typeof id === 'string' && id !== '') this.upstreamResponseId = id;
  }

  abort(): void {
    if (!this.signal.aborted) this.abortController.abort();
  }
}

function pinFromPrepared(prepared: RequestPreparationPreparedResult, model: string): ResponsesWsPinnedIdentity {
  const evidence = prepared.evidenceInput;
  return {
    tenantId: evidence.tenantId,
    projectId: evidence.projectId,
    proxyKeyId: evidence.proxyKeyId,
    providerId: evidence.providerId,
    accountId: evidence.accountId,
    upstreamModel: evidence.resolvedModel ?? '',
    publicModel: model,
    credentialId: evidence.credentialId,
    credentialVersion: String(evidence.credentialVersion),
    credentialAuthzVersion: String(evidence.credentialAuthzVersion),
    upstreamSessionId: null,
  };
}

function samePin(left: ResponsesWsPinnedIdentity, right: ResponsesWsPinnedIdentity): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.proxyKeyId === right.proxyKeyId &&
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.upstreamModel === right.upstreamModel &&
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.credentialAuthzVersion === right.credentialAuthzVersion
  );
}

export function createResponsesWsRoundExecutor(options: ResponsesWsExecutorOptions): ResponsesWsRoundExecutor {
  const rawKey = responsesWsProxyKey(options.request);
  const continuations = new ResponsesContinuationStore(options.maxBodyBytes);
  const sessionId = `responses-ws:${randomUUID()}`;
  const audit = {
    entryPoint: options.entryPoint,
    sourceIp: safeHeader(options.request.socket.remoteAddress),
    userAgent: safeHeader(options.request.headers['user-agent']),
  };
  const clientAddress = resolveClientAddress(
    options.request.socket.remoteAddress ?? '',
    options.request.headers['x-forwarded-for'],
    options.trustedProxyCidrs ?? [],
  );
  return {
    executeRound(input) {
      return options.runWithRequestId(input.requestId, async () => {
        if (input.cancelSignal.aborted)
          throw new ResponsesWsRoundError('REQUEST_CANCELLED', 'the request was cancelled', 400);
        const caller = rawKey === null ? null : await options.authenticator.authenticate(rawKey).catch(() => null);
        if (!caller) throw new ResponsesWsRoundError('UNAUTHENTICATED', 'the proxy credential is unavailable', 401);
        const body: Record<string, unknown> = continuations.resolve({
          ...input.body,
          model: input.body.model ?? input.pinned?.publicModel,
          stream: true,
        }, { tenantId: caller.metadata.tenantId, projectId: caller.metadata.projectId, proxyKeyId: caller.metadata.id, pinned: input.pinned });
        const model = body.model;
        if (typeof model !== 'string' || model.trim() === '' || model.trim() !== model || model.length > 512) {
          throw new ResponsesWsRoundError('INVALID_BODY', 'a model is required', 400);
        }
        if (Buffer.byteLength(JSON.stringify(body)) > options.maxBodyBytes)
          throw new ResponsesWsRoundError('BODY_TOO_LARGE', 'the response request is too large', 413);
        if (options.contentModeration) {
          const result = await options.contentModeration
            .check({
              requestId: input.requestId,
              tenantId: caller.metadata.tenantId,
              userId: caller.metadata.principalUserId,
              apiKeyId: caller.metadata.id,
              apiKeyName: caller.metadata.name,
              protocol: 'responses',
              model,
              body,
            })
            .catch(() => ({ allowed: true, statusCode: 0, message: '' }));
          if (!result.allowed)
            throw new ResponsesWsRoundError(
              'CONTENT_POLICY_VIOLATION',
              result.message || 'the request was blocked by content policy',
              403,
            );
        }
        const prepared = await options.preparation.prepare({
          authenticatedCaller: caller,
          publicModel: model,
          protocol: 'responses',
          clientRequest: body,
          audit,
          clientAddress,
          scheduling: {
            sessionId,
            ...(typeof input.body.previous_response_id === 'string' ? { previousResponseId: input.body.previous_response_id } : {}),
          },
        });
        if (prepared.outcome !== 'prepared') throw preparationFailure(prepared);
        const compensate = async (cause: 'client_cancelled' | 'dispatch_failed') => {
          await options.compensation
            .compensate({ prepared, cause, responseMayHaveStarted: false })
            .catch(() => undefined);
        };
        const pinned = {
          ...pinFromPrepared(prepared, model),
          upstreamSessionId: input.pinned?.upstreamSessionId ?? null,
        };
        if (
          prepared.requestId !== input.requestId ||
          !pinned.upstreamModel ||
          (input.pinned && !samePin(input.pinned, pinned))
        ) {
          await compensate('dispatch_failed');
          throw new ResponsesWsRoundError(
            'SESSION_BINDING_CHANGED',
            'the original response account is unavailable; reconnect with full context',
            409,
          );
        }
        if (input.cancelSignal.aborted) {
          await compensate('client_cancelled');
          return { pinned, terminal: { type: 'response.cancelled' } };
        }
        const sink = new ResponsesWsClientStream(async (event) => {
          await input.emit?.(event);
        }, options.maxBodyBytes);
        const cancelled = () => ({
          pinned: { ...pinned, upstreamSessionId: sink.upstreamResponseId ?? pinned.upstreamSessionId },
          terminal: {
            type: 'response.cancelled',
            ...(sink.upstreamResponseId ? { response_id: sink.upstreamResponseId } : {}),
          },
        });
        const onAbort = () => sink.abort();
        input.cancelSignal.addEventListener('abort', onAbort, { once: true });
        try {
          const dispatched = await options.dispatch.dispatch({
            evidenceId: prepared.evidence.evidenceId,
            payloadBytes: prepared.payloadBytes,
            normalSuccessSnapshot: prepared.normalSuccessSnapshot,
            audit: { ...audit, actorUserId: caller.authorization.principalId, requestId: input.requestId },
            client: sink,
          });
          if (input.cancelSignal.aborted) return cancelled();
          if (dispatched.kind !== 'sent')
            throw new ResponsesWsRoundError('DISPATCH_OUTCOME_UNKNOWN', 'the response outcome is unknown', 502);
          const status = dispatched.transport.resultHttpStatus ?? sink.status;
          if (status < 200 || status >= 300)
            throw new ResponsesWsRoundError('UPSTREAM_REJECTED', 'the upstream response request was rejected', status);
          if (!sink.terminal)
            throw new ResponsesWsRoundError(
              'INVALID_UPSTREAM_RESPONSE',
              'the upstream did not complete a response',
              502,
            );
          continuations.remember(body, sink.terminal, pinned);
          return {
            pinned: { ...pinned, upstreamSessionId: sink.upstreamResponseId ?? pinned.upstreamSessionId },
            terminal: sink.terminal,
          };
        } catch (error) {
          if (input.cancelSignal.aborted) return cancelled();
          // Compensation only releases a still-prepared attempt. A dispatch
          // that crossed the send fence remains under durable recovery.
          await compensate('dispatch_failed');
          throw error;
        } finally {
          input.cancelSignal.removeEventListener('abort', onAbort);
        }
      });
    },
  };
}
