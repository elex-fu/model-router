/**
 * Gap-remediation plan G-B4 (§12.1): the Responses WebSocket session core —
 * the protocol engine independent of the HTTP upgrade (the connection layer
 * binds it to a ws socket; tests bind it to a fake).
 *
 * Reference fusion (plan §5.1 table):
 *   - new-api: every `response.create` enters the FULL preparation/
 *     admission/settlement chain (connection-level auth is NOT request auth)
 *   - new-api: one active request per connection; a concurrent create
 *     answers 409-in-band
 *   - new-api: the first create pins (tenant, key, provider, account,
 *     upstreamModel, upstreamSession); later rounds re-verify the pin — a
 *     route/key change requires reconnect; the same pin reuses the upstream
 *     connection facts
 *   - CLIProxyAPI: a single bounded reader queue (16) — a client that
 *     overruns it is TCP-backpressured, `response.interrupt` bypasses
 *   - both: cancellation NEVER refunds — the terminal event settles on the
 *     accumulated usage; the failed path alone refunds
 *   - CLIProxyAPI: close codes classified — credential/quota errors close
 *     SILENTLY (an implicit reconnect instruction; the client replays the
 *     full context), request-shape errors notify, 413 → 1009
 *
 * The engine is transport-free: `send`/`close` callbacks carry the frames;
 * the ws connection layer (the next slice) wires them.
 */

export type ResponsesWsEventType =
  | 'response.created'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.completed'
  | 'response.failed'
  | 'response.incomplete'
  | 'response.cancelled'
  | 'error';

export interface ResponsesWsEvent {
  readonly type: ResponsesWsEventType | (string & {});
  readonly event_id?: string;
  readonly response_id?: string;
  readonly delta?: string;
  readonly usage?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly [extra: string]: unknown;
}

/** The per-round execution contract the connection layer must satisfy. */
export interface ResponsesWsRoundExecutor {
  /**
   * Executes ONE response.create round through the FULL gateway chain
   * (preparation → admission → dispatch → settlement). The engine passes
   * the pinned identity from round 1; the executor treats the round
   * exactly like an HTTP request (the new-api per-event middleware
   * posture). Resolves with the terminal event (completed/failed/
   * incomplete/cancelled) — usage settlement happens INSIDE; the engine
   * never double-settles.
   */
  executeRound(input: {
    readonly requestId: string;
    readonly body: Record<string, unknown>;
    readonly pinned: ResponsesWsPinnedIdentity | null;
    readonly cancelSignal: AbortSignal;
    /** Nonterminal provider events; awaiting this sink backpressures dispatch. */
    readonly emit?: (event: ResponsesWsEvent) => Promise<void>;
  }): Promise<{ readonly terminal: ResponsesWsEvent; readonly pinned: ResponsesWsPinnedIdentity }>;
}

/** The pinned identity from the first successful round (new-api lock shape). */
export interface ResponsesWsPinnedIdentity {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly proxyKeyId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly upstreamModel: string;
  readonly credentialId?: string;
  readonly credentialVersion?: string;
  readonly credentialAuthzVersion?: string;
  readonly publicModel?: string;
  /** The opaque upstream session/response id chain, when the upstream has one. */
  readonly upstreamSessionId: string | null;
}

export interface ResponsesWsEngineOptions {
  readonly executor: ResponsesWsRoundExecutor;
  /** Outbound frame sink (the ws send). */
  readonly send: (event: ResponsesWsEvent) => void | Promise<void>;
  /** Connection close (code + short UTF-8-safe reason). */
  readonly close: (code: number, reason: string) => void;
  /** The round budget: how long one round may run before the engine cancels. */
  readonly roundTimeoutMs?: number;
  /** Bounded reader queue: events beyond this many queued creates are refused. */
  readonly maxQueuedCreates?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

/** Close-code semantics (CLIProxyAPI's classification). */
export const RESPONSES_WS_CLOSE_POLICY_VIOLATION = 4403 as const;
export const RESPONSES_WS_CLOSE_MESSAGE_TOO_BIG = 1009 as const;
export const RESPONSES_WS_CLOSE_SERVICE_RESTART = 1013 as const;
export const RESPONSES_WS_CLOSE_NORMAL = 1000 as const;

const DEFAULT_ROUND_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_QUEUED_CREATES = 16;
const CLOSE_REASON_MAX_BYTES = 123;

export class ResponsesWsRoundError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ResponsesWsRoundError';
  }
}

function truncateCloseReason(reason: string): string {
  const encoded = Buffer.from(reason, 'utf8');
  if (encoded.length <= CLOSE_REASON_MAX_BYTES) return reason;
  return Buffer.from(encoded.subarray(0, CLOSE_REASON_MAX_BYTES)).toString('utf8').trimEnd();
}

export interface ResponsesWsInboundEvent {
  readonly type: string;
  readonly event_id?: string;
  readonly [extra: string]: unknown;
}

/**
 * The session engine. Construct per connection; feed inbound events via
 * `handle()`; the executor + send/close callbacks surface the outbound side.
 */
export class ResponsesWsEngine {
  private readonly executor: ResponsesWsRoundExecutor;
  private readonly baseSend: (event: ResponsesWsEvent) => void | Promise<void>;
  private readonly baseClose: (code: number, reason: string) => void;
  private readonly roundTimeoutMs: number;
  private readonly maxQueuedCreates: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  /** G-B4 connection binding: the connection layer swaps the frame sink in after the socket attaches. */
  private sendDelegate: ((event: ResponsesWsEvent) => void | Promise<void>) | null = null;
  private closeDelegate: ((code: number, reason: string) => void) | null = null;
  private pinned: ResponsesWsPinnedIdentity | null = null;
  private activeRound: {
    readonly requestId: string;
    readonly eventId: string | null;
    readonly abort: AbortController;
    readonly startedAt: number;
  } | null = null;
  /** event_id → fingerprint of the ALREADY-EXECUTED logical request. */
  private readonly executedEventIds = new Map<string, string>();
  private closed = false;
  private activeWork: Promise<void> | null = null;

  constructor(options: ResponsesWsEngineOptions) {
    if (!options?.executor) throw new Error('the responses WS engine requires a round executor');
    if (typeof options.send !== 'function' || typeof options.close !== 'function') {
      throw new Error('the responses WS engine requires send and close callbacks');
    }
    this.executor = options.executor;
    this.baseSend = options.send;
    this.baseClose = options.close;
    this.roundTimeoutMs = options.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS;
    this.maxQueuedCreates = options.maxQueuedCreates ?? DEFAULT_MAX_QUEUED_CREATES;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `ev_${Math.random().toString(36).slice(2, 12)}`);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private get send(): (event: ResponsesWsEvent) => void | Promise<void> {
    return (event) => (this.sendDelegate ?? this.baseSend)(event);
  }

  private get close(): (code: number, reason: string) => void {
    return (code, reason) => (this.closeDelegate ?? this.baseClose)(code, reason);
  }

  get pinnedIdentity(): ResponsesWsPinnedIdentity | null {
    return this.pinned;
  }

  /** Handles ONE decoded inbound frame. Never throws — errors close. */
  async handle(event: ResponsesWsInboundEvent | null | undefined): Promise<void> {
    if (this.closed || event === null || typeof event !== 'object') return;
    const type = event.type;
    if (type === 'response.create') {
      const wasIdle = this.activeRound === null;
      const work = this.handleCreate(event);
      if (wasIdle) this.activeWork = work;
      try {
        await work;
      } finally {
        if (this.activeWork === work) this.activeWork = null;
      }
      return;
    }
    if (type === 'response.interrupt') {
      // Bypasses every queue (CLIProxyAPI): cancels the active round now.
      this.activeRound?.abort.abort(new Error('client_interrupt'));
      return;
    }
    if (type === 'response.cancel') {
      // The OpenAI-style cancel: same semantics — cancel, never refund.
      this.activeRound?.abort.abort(new Error('client_cancel'));
      return;
    }
    // Unknown control events are ignored (forward compatibility), except a
    // malformed shape closes as a policy violation.
    if (typeof type !== 'string' || type === '') {
      this.closeConnection(RESPONSES_WS_CLOSE_POLICY_VIOLATION, 'malformed event');
    }
  }

  private async handleCreate(event: ResponsesWsInboundEvent): Promise<void> {
    // Responses WS uses top-level create fields. Retain the nested shape
    // accepted by earlier deployments while rejecting scalar envelopes.
    const { type: _type, event_id: _eventId, ...topLevel } = event;
    const candidate = Object.hasOwn(event, 'response') ? event.response : topLevel;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      await this.send({
        type: 'error',
        error: { code: 'INVALID_BODY', message: 'response.create must contain an object' },
      });
      return;
    }
    const body = candidate as Record<string, unknown>;
    const eventId = typeof event.event_id === 'string' && event.event_id !== '' ? event.event_id : null;

    // One active round per connection — a concurrent create answers in-band.
    if (this.activeRound !== null) {
      await this.send({
        type: 'error',
        error: {
          code: 'response_create_conflict',
          message: 'a response.create is already in flight on this connection',
        },
      });
      return;
    }

    // Event-id idempotency: the same event_id + the same fingerprint replays
    // the recorded terminal; the same id with a DIFFERENT body is refused.
    const fingerprint = Buffer.from(JSON.stringify(body)).toString('base64url');
    if (eventId !== null && this.executedEventIds.has(eventId)) {
      const recorded = this.executedEventIds.get(eventId);
      if (recorded === fingerprint) {
        await this.send({
          type: 'error',
          error: {
            code: 'response_already_completed',
            message: 'this event_id already completed on this connection',
          },
        });
        return;
      }
      this.closeConnection(RESPONSES_WS_CLOSE_POLICY_VIOLATION, 'event_id reused with a different body');
      return;
    }
    if (this.executedEventIds.size >= this.maxQueuedCreates) {
      // The bounded event-id memory: refuse the new create in-band.
      await this.send({
        type: 'error',
        error: { code: 'too_many_events', message: 'the connection event budget is exhausted — reconnect' },
      });
      return;
    }

    const abort = new AbortController();
    const requestId = this.idFactory();
    this.activeRound = { requestId, eventId, abort, startedAt: this.now() };

    // The round timer: cancels the round (never a refund) on expiry.
    const timer = setTimeout(() => {
      abort.abort(new Error('round_timeout'));
    }, this.roundTimeoutMs);
    timer.unref?.();

    try {
      const { terminal, pinned } = await this.executor.executeRound({
        requestId,
        body,
        pinned: this.pinned,
        cancelSignal: abort.signal,
        emit: async (outbound) => {
          if (!this.closed) await this.send(outbound);
        },
      });
      this.pinned = pinned;
      if (eventId !== null) this.executedEventIds.set(eventId, fingerprint);
      // The terminal event reaches the client; settlement already happened
      // inside the executor (cancellation included — the terminal carries
      // the accumulated usage).
      if (!this.closed) await this.send(terminal);
    } catch (error) {
      // The executor durably classified the failed or uncertain round;
      // the engine surfaces the failed terminal and closes ONLY on
      // credential/quota/transport classes (CLIProxyAPI silent-close rule).
      const message = error instanceof Error ? error.message : String(error);
      const credentialClass =
        error instanceof ResponsesWsRoundError
          ? [401, 402, 403, 429].includes(error.status) || error.code === 'SESSION_BINDING_CHANGED'
          : /credential|unauthorized|quota/i.test(message);
      if (!this.closed)
        await this.send({
          type: 'response.failed',
          error: {
            code: error instanceof ResponsesWsRoundError ? error.code : 'round_failed',
            message: error instanceof ResponsesWsRoundError ? error.message : 'the response round failed',
          },
        });
      if (error instanceof ResponsesWsRoundError && error.status === 413) {
        this.closeConnection(RESPONSES_WS_CLOSE_MESSAGE_TOO_BIG, 'request too large');
        return;
      }
      if (credentialClass) {
        this.closeConnection(RESPONSES_WS_CLOSE_POLICY_VIOLATION, '');
        return;
      }
    } finally {
      clearTimeout(timer);
      this.activeRound = null;
    }
  }

  /**
   * The connection layer binds the real frame sink AFTER the socket
   * attaches (the engine is constructed before the ws object exists).
   */
  bindTransport(
    send: (event: ResponsesWsEvent) => void | Promise<void>,
    close: (code: number, reason: string) => void,
  ): void {
    this.sendDelegate = send;
    this.closeDelegate = close;
  }

  /** Client-side close: the active round is cancelled and settles inside. */
  clientDisconnected(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeRound?.abort.abort(new Error('client_disconnected'));
  }

  /** Shutdown waits for the cancelled round's durable classification. */
  whenIdle(): Promise<void> {
    return this.activeWork?.catch(() => undefined) ?? Promise.resolve();
  }

  private closeConnection(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.activeRound?.abort.abort(new Error('connection_closed'));
    this.close(code, truncateCloseReason(reason));
  }
}
