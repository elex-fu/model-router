import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';

// Test-only tools: no bootstrap, database creation, migrations, grants,
// business DML, signing, or financial outcome fabrication lives here.
const NONCE_PREFIX = 'financial-fault:';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_TIMEOUT_MS = 60_000;

export class FinancialFaultFixtureError extends Error {
  constructor(readonly code:
    | 'INVALID_CONFIGURATION'
    | 'DUPLICATE_NONCE'
    | 'FIXTURE_DISPOSED'
    | 'WAIT_ABORTED'
    | 'WAIT_TIMEOUT'
    | 'CLEANUP_TIMEOUT'
    | 'FAULT_NOT_INJECTED') {
    super(`Financial fault fixture: ${code}`);
    this.name = 'FinancialFaultFixtureError';
  }
}

export const INVALID_JSON_USAGE_VARIANTS = [
  'negative', 'fractional', 'unsafe_integer', 'inconsistent_total',
  'cache_overflow', 'reasoning_overflow', 'unknown_dimension', 'duplicate_usage',
] as const;
export type InvalidJsonUsageVariant = typeof INVALID_JSON_USAGE_VARIANTS[number];

export type FinancialNetworkScript =
  | { readonly kind: 'json_missing_usage' }
  | { readonly kind: 'json_invalid_usage'; readonly variant: InvalidJsonUsageVariant }
  | { readonly kind: 'sse_partial_cancel' }
  | { readonly kind: 'before_headers_cancel' };

export type FinancialNetworkEvent = 'receipt' | 'headers' | 'first_chunk' | 'eof' | 'close';

export interface FinancialNetworkSnapshot {
  readonly receipts: number;
  readonly headers: number;
  readonly firstChunks: number;
  /** ServerResponse.finish, NOT proof that a client observed EOF or financial completion. */
  readonly eofs: number;
  readonly closes: number;
  readonly peerCancellations: number;
  readonly requestAborts: number;
  readonly protocolMismatches: number;
  readonly watchdogCloses: number;
  readonly cleanupCloses: number;
  readonly writeErrors: number;
  readonly bytesWritten: number;
  readonly activeResponses: number;
  readonly pendingWaits: number;
  readonly disposed: boolean;
}

export interface FinancialNetworkWaitOptions {
  readonly count?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FinancialNetworkScenario {
  readonly nonce: string;
  /** Put this exact synthetic string in a user message; never an authority field. */
  readonly prompt: string;
  snapshot(): FinancialNetworkSnapshot;
  waitFor(event: FinancialNetworkEvent, options?: FinancialNetworkWaitOptions): Promise<void>;
  dispose(): Promise<void>;
}

export interface FinancialNetworkFixture {
  register(script: FinancialNetworkScript, nonce?: string): FinancialNetworkScenario;
  /**
   * Call inside the existing HTTPS fixture's request-end callback, AFTER its
   * method/path/auth/body validation. False leaves its original happy response
   * untouched. This never copies or records headers, credentials, or payloads.
   */
  handle(request: IncomingMessage, response: ServerResponse, parsedPayload: unknown): boolean;
  dispose(): Promise<void>;
}

function timeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_TIMEOUT_MS) {
    throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  return selected;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  return selected;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validateScript(script: FinancialNetworkScript): FinancialNetworkScript {
  if (!script || !['json_missing_usage', 'json_invalid_usage', 'sse_partial_cancel', 'before_headers_cancel'].includes(script.kind)) {
    throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  if (script.kind === 'json_invalid_usage' && !INVALID_JSON_USAGE_VARIANTS.includes(script.variant)) {
    throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  return Object.freeze({ ...script });
}

function jsonBody(nonce: string, model: string, script: FinancialNetworkScript): string {
  const envelope = {
    id: `chatcmpl-financial-fault-${nonce}`, object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'financial-fault-fixture' }, finish_reason: 'stop' }],
  };
  if (script.kind === 'json_missing_usage') return JSON.stringify(envelope);
  if (script.kind !== 'json_invalid_usage') throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  const valid = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  let usage: Record<string, unknown>;
  switch (script.variant) {
    case 'negative': usage = { ...valid, completion_tokens: -1 }; break;
    case 'fractional': usage = { ...valid, completion_tokens: 1.5 }; break;
    case 'unsafe_integer': usage = { ...valid, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }; break;
    case 'inconsistent_total': usage = { ...valid, total_tokens: 6 }; break;
    case 'cache_overflow': usage = { ...valid, prompt_tokens_details: { cached_tokens: 4 } }; break;
    case 'reasoning_overflow': usage = { ...valid, completion_tokens_details: { reasoning_tokens: 3 } }; break;
    case 'unknown_dimension': usage = { ...valid, audio_tokens: 1 }; break;
    case 'duplicate_usage':
      // Syntactically complete JSON; the production ambiguity checker must
      // reject duplicate names, rather than trust JSON.parse's last value.
      return `${JSON.stringify(envelope).slice(0, -1)},"usage":${JSON.stringify(valid)},"usage":${JSON.stringify(valid)}}`;
    default: throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  return JSON.stringify({ ...envelope, usage });
}

interface Waiter {
  readonly event: FinancialNetworkEvent;
  readonly count: number;
  resolve(): void;
  reject(error: FinancialFaultFixtureError): void;
}

interface ResponseBinding {
  readonly response: ServerResponse;
  readonly closed: Promise<void>;
  destroy(reason: 'watchdog' | 'cleanup' | 'write_error'): void;
}

class NetworkScenario implements FinancialNetworkScenario {
  readonly prompt: string;
  private readonly counts: Record<FinancialNetworkEvent, number> = {
    receipt: 0, headers: 0, first_chunk: 0, eof: 0, close: 0,
  };
  private readonly bindings = new Set<ResponseBinding>();
  private readonly waiters = new Set<Waiter>();
  private peerCancellations = 0;
  private requestAborts = 0;
  private protocolMismatches = 0;
  private watchdogCloses = 0;
  private cleanupCloses = 0;
  private writeErrors = 0;
  private bytesWritten = 0;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    readonly nonce: string,
    private readonly script: FinancialNetworkScript,
    private readonly responseTimeoutMs: number,
    private readonly waitTimeoutMs: number,
    private readonly unregister: () => void,
  ) {
    this.prompt = `${NONCE_PREFIX}${nonce}`;
  }

  snapshot(): FinancialNetworkSnapshot {
    return Object.freeze({
      receipts: this.counts.receipt, headers: this.counts.headers, firstChunks: this.counts.first_chunk,
      eofs: this.counts.eof, closes: this.counts.close, peerCancellations: this.peerCancellations,
      requestAborts: this.requestAborts, protocolMismatches: this.protocolMismatches,
      watchdogCloses: this.watchdogCloses, cleanupCloses: this.cleanupCloses, writeErrors: this.writeErrors,
      bytesWritten: this.bytesWritten, activeResponses: this.bindings.size,
      pendingWaits: this.waiters.size, disposed: this.disposed,
    });
  }

  waitFor(event: FinancialNetworkEvent, options: FinancialNetworkWaitOptions = {}): Promise<void> {
    if (!Object.hasOwn(this.counts, event)) throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
    const count = positiveInteger(options.count, 1);
    const timeoutMs = timeout(options.timeoutMs, this.waitTimeoutMs);
    if (options.signal?.aborted) return Promise.reject(new FinancialFaultFixtureError('WAIT_ABORTED'));
    if (this.counts[event] >= count) return Promise.resolve();
    if (this.disposed) return Promise.reject(new FinancialFaultFixtureError('FIXTURE_DISPOSED'));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(waiter);
      };
      const waiter: Waiter = {
        event, count,
        resolve: () => { cleanup(); resolve(); },
        reject: (error) => { cleanup(); reject(error); },
      };
      const onAbort = () => waiter.reject(new FinancialFaultFixtureError('WAIT_ABORTED'));
      const timer = setTimeout(() => waiter.reject(new FinancialFaultFixtureError('WAIT_TIMEOUT')), timeoutMs);
      this.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  private record(event: FinancialNetworkEvent): void {
    this.counts[event] += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.event === event && this.counts[event] >= waiter.count) waiter.resolve();
    }
  }

  respond(request: IncomingMessage, response: ServerResponse, payload: Record<string, unknown>): void {
    if (this.disposed) throw new FinancialFaultFixtureError('FIXTURE_DISPOSED');
    if (response.destroyed || response.headersSent || response.writableEnded) {
      throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
    }
    let destroyReason: 'watchdog' | 'cleanup' | 'write_error' | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const onRequestAbort = () => { this.requestAborts += 1; };
    const onFinish = () => { clearTimeout(watchdog); this.record('eof'); };
    const onError = () => { this.writeErrors += 1; binding.destroy('write_error'); };
    const onClose = () => {
      clearTimeout(watchdog);
      request.removeListener('aborted', onRequestAbort);
      response.removeListener('finish', onFinish);
      response.removeListener('error', onError);
      response.removeListener('close', onClose);
      this.bindings.delete(binding);
      if (!response.writableFinished && destroyReason === undefined) this.peerCancellations += 1;
      this.record('close');
      resolveClosed();
    };
    const binding: ResponseBinding = {
      response, closed,
      destroy: (reason) => {
        if (response.destroyed || destroyReason !== undefined) return;
        destroyReason = reason;
        if (reason === 'watchdog') this.watchdogCloses += 1;
        if (reason === 'cleanup') this.cleanupCloses += 1;
        response.destroy();
      },
    };
    const watchdog = setTimeout(() => binding.destroy('watchdog'), this.responseTimeoutMs);
    this.bindings.add(binding);
    request.once('aborted', onRequestAbort);
    response.once('finish', onFinish);
    response.once('close', onClose);
    response.on('error', onError);
    this.record('receipt');

    const write = (content: string, contentType: string, end: boolean, status = 200) => {
      try {
        response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-cache' });
        response.write(content);
        this.record('headers');
        this.bytesWritten += Buffer.byteLength(content);
        this.record('first_chunk');
        if (end) response.end();
      } catch {
        this.writeErrors += 1;
        binding.destroy('write_error');
      }
    };

    const streaming = payload.stream;
    if (typeof streaming !== 'boolean' ||
      (this.script.kind === 'sse_partial_cancel' && !streaming) ||
      (this.script.kind.startsWith('json_') && streaming)) {
      this.protocolMismatches += 1;
      write('{"error":"financial_fault_fixture_protocol_mismatch"}', 'application/json', true, 400);
    } else if (this.script.kind === 'before_headers_cancel') {
      // Intentionally no headers/body/EOF. Only peer cancellation or bounded
      // cleanup/watchdog ends this actual network response.
    } else if (this.script.kind === 'sse_partial_cancel') {
      const firstEvent = `data: ${JSON.stringify({
        id: `chatcmpl-financial-fault-${this.nonce}`, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'financial-fault-first-chunk' }, finish_reason: null }],
      })}\n\n`;
      write(firstEvent, 'text/event-stream; charset=utf-8', false);
    } else {
      write(jsonBody(this.nonce, typeof payload.model === 'string' ? payload.model : 'financial-fixture-model', this.script),
        'application/json; charset=utf-8', true);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.unregister();
    for (const waiter of [...this.waiters]) waiter.reject(new FinancialFaultFixtureError('FIXTURE_DISPOSED'));
    const active = [...this.bindings];
    // Each binding's close listener remains until the actual wire closes, so
    // cleanup is not falsely counted as peer cancellation or upstream EOF.
    this.disposal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new FinancialFaultFixtureError('CLEANUP_TIMEOUT')), this.waitTimeoutMs);
      Promise.all(active.map((binding) => binding.closed)).then(
        () => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); reject(new FinancialFaultFixtureError('CLEANUP_TIMEOUT')); },
      );
      for (const binding of active) binding.destroy('cleanup');
    });
    return this.disposal;
  }
}

export function createFinancialNetworkFaultFixture(options: {
  readonly responseTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
} = {}): FinancialNetworkFixture {
  const responseTimeoutMs = timeout(options.responseTimeoutMs, 5_000);
  const waitTimeoutMs = timeout(options.waitTimeoutMs, 2_000);
  const active = new Map<string, NetworkScenario>();
  const owned = new Set<NetworkScenario>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  return {
    register(script, nonce = randomUUID()) {
      if (disposed) throw new FinancialFaultFixtureError('FIXTURE_DISPOSED');
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
      if (active.has(nonce)) throw new FinancialFaultFixtureError('DUPLICATE_NONCE');
      const scenario = new NetworkScenario(nonce, validateScript(script), responseTimeoutMs, waitTimeoutMs, () => {
        active.delete(nonce);
      });
      active.set(nonce, scenario);
      owned.add(scenario);
      return scenario;
    },
    handle(request, response, parsedPayload) {
      if (disposed) throw new FinancialFaultFixtureError('FIXTURE_DISPOSED');
      const payload = object(parsedPayload);
      if (!payload || !Array.isArray(payload.messages)) return false;
      const matched = new Set<NetworkScenario>();
      for (const messageValue of payload.messages) {
        const message = object(messageValue);
        if (message?.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(NONCE_PREFIX)) continue;
        const scenario = active.get(message.content.slice(NONCE_PREFIX.length));
        if (scenario) matched.add(scenario);
      }
      if (matched.size === 0) return false;
      if (matched.size !== 1) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"financial_fault_fixture_ambiguous_nonce"}');
        return true;
      }
      matched.values().next().value!.respond(request, response, payload);
      return true;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.allSettled([...owned].map((scenario) => scenario.dispose())).then((results) => {
        if (results.some((result) => result.status === 'rejected')) throw new FinancialFaultFixtureError('CLEANUP_TIMEOUT');
      });
      return disposal;
    },
  };
}

export type DelegatedSqlFaultPoint = 'after_successful_write' | 'before_commit' | 'after_commit';

export interface DelegatedSqlFaultPlan {
  readonly point: DelegatedSqlFaultPoint;
  /** The exact caller sentinel is rethrown; no fabricated SQLSTATE/cause/result. */
  readonly sentinel: Error;
  /** Explicitly match the test-owned write AND its scope/identity. Never log values here. */
  readonly matchesWrite: (sql: string, values: readonly unknown[] | undefined) => boolean;
  readonly expectedRowCount: number;
  /** E.g. 2 matching ledger-entry INSERTs in the SAME transaction, each rowCount=1. */
  readonly successfulWritesRequired?: number;
}

export interface DelegatedSqlFaultSnapshot {
  readonly successfulMatchedWrites: number;
  readonly successfulMatchedCommits: number;
  readonly injections: number;
  readonly injectedAt: DelegatedSqlFaultPoint | null;
}

export interface DelegatedSqlFault {
  wrapExecutor(executor: SqlExecutor): SqlExecutor;
  /** Pool queries remain untouched; only connected transaction clients are wrapped. */
  wrapPool(pool: SaasDatabasePool): SaasDatabasePool;
  snapshot(): DelegatedSqlFaultSnapshot;
  assertInjected(): void;
}

/**
 * Observes native results from an existing restricted-role connection. It
 * sends no SQL of its own and never changes SQL, values, rows or rowCount.
 * before_commit intentionally prevents COMMIT; after_commit first awaits the
 * real successful COMMIT, then simulates loss of its acknowledgement.
 * COMMIT faults and multi-write thresholds require this wrapper to observe a
 * successful native BEGIN. An already-open executor supports a single-write
 * fault only; use wrapPool to observe the real database transaction boundary.
 * Sentinel injection is not a process crash or a financial/PG proof.
 */
export function createDelegatedSqlFault(plan: DelegatedSqlFaultPlan): DelegatedSqlFault {
  if (!plan || !['after_successful_write', 'before_commit', 'after_commit'].includes(plan.point) ||
    !(plan.sentinel instanceof Error) || typeof plan.matchesWrite !== 'function' ||
    typeof plan.expectedRowCount !== 'number') {
    throw new FinancialFaultFixtureError('INVALID_CONFIGURATION');
  }
  const expectedRowCount = positiveInteger(plan.expectedRowCount, 1);
  const required = positiveInteger(plan.successfulWritesRequired, 1);
  const point = plan.point;
  const sentinel = plan.sentinel;
  const matchesWrite = plan.matchesWrite;
  let successfulMatchedWrites = 0;
  let successfulMatchedCommits = 0;
  let injectedAt: DelegatedSqlFaultPoint | null = null;

  function wrap(executor: SqlExecutor): { readonly executor: SqlExecutor; discardOnRelease(): boolean } {
    let transactionWrites = 0;
    let transactionOpen = false;
    let discard = false;
    const inject = () => {
      injectedAt = point;
      if (point === 'after_commit') discard = true;
      throw sentinel;
    };
    return {
      discardOnRelease: () => discard,
      executor: {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          const commit = /^\s*COMMIT\s*;?\s*$/i.test(sql);
          const rollback = /^\s*ROLLBACK\s*;?\s*$/i.test(sql);
          const begin = /^\s*BEGIN\b/i.test(sql);
          if (begin) { transactionWrites = 0; transactionOpen = false; }
          const armed = transactionOpen && transactionWrites >= required;
          if (commit && armed && injectedAt === null && point === 'before_commit') inject();

          // Await the real executor before considering a successful effect.
          // SQL errors retain their original identity, including real SQLSTATE.
          let result: SqlResult<Row>;
          try {
            result = await executor.query<Row>(sql, values);
          } catch (error) {
            // A failed statement can abort the transaction. A later COMMIT
            // must not be mislabeled as a successful matched-write commit.
            transactionWrites = 0;
            transactionOpen = false;
            throw error;
          }
          if (begin) {
            transactionOpen = true;
          } else if (commit) {
            if (armed) successfulMatchedCommits += 1;
            transactionWrites = 0;
            transactionOpen = false;
            if (armed && injectedAt === null && point === 'after_commit') inject();
          } else if (rollback) {
            transactionWrites = 0;
            transactionOpen = false;
          } else if (/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql) &&
            matchesWrite(sql, values) && result.rowCount === expectedRowCount) {
            if (transactionOpen) transactionWrites += 1;
            successfulMatchedWrites += 1;
            if ((required === 1 || (transactionOpen && transactionWrites >= required)) &&
              injectedAt === null && point === 'after_successful_write') inject();
          }
          return result;
        },
      },
    };
  }

  return {
    wrapExecutor: (executor) => wrap(executor).executor,
    wrapPool: (pool) => ({
      query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
      async connect(): Promise<SaasDatabaseClient> {
        const client = await pool.connect();
        const wrapped = wrap(client);
        return {
          query: wrapped.executor.query,
          release: (error) => client.release(wrapped.discardOnRelease() ? error || true : error),
        };
      },
      end: () => pool.end(),
    }),
    snapshot: () => Object.freeze({
      successfulMatchedWrites, successfulMatchedCommits,
      injections: injectedAt === null ? 0 : 1, injectedAt,
    }),
    assertInjected: () => {
      if (injectedAt === null) throw new FinancialFaultFixtureError('FAULT_NOT_INJECTED');
    },
  };
}
