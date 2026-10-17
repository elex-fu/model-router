import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PreparedEvidenceClientStream } from '../prepared-evidence-dispatch-service.js';

/**
 * Roadmap batch 4 §4.2 (task #16) non-streaming JSON keepalive — the
 * sub2api `StartOpenAIImagesJSONKeepalive` semantics
 * (backend/internal/service/openai_images_json_keepalive.go) ported to the
 * hosted gateway's client-stream contract.
 *
 * Image generation upstreams are slow (tens of seconds to minutes), and the
 * non-streaming JSON response carries nothing until the upstream answers.
 * While waiting, this stream writes a whitespace heartbeat (` \n`) every
 * `intervalMs`: leading whitespace keeps the eventual body valid JSON
 * (JSON.parse tolerates it), and intermediaries see a live connection.
 *
 * The committed-status tradeoff (sub2api verbatim): the first heartbeat
 * commits status 200 + `content-type: application/json`; the real upstream
 * status delivered later through `start()` is then ignored, and an upstream
 * error that arrives after the flush is passed through as an
 * OpenAI-compatible JSON error body appended to the stream. This
 * architecture has no post-response-start failover (dispatch is a single
 * attempt per prepared request — the unknown-outcome reconciliation owns
 * strays), so the sub2api "一旦写过字节就不能 failover" constraint is
 * structurally satisfied: bytes written here can never mask a retryable
 * attempt.
 *
 * Disabled by default (`intervalMs <= 0`); the default sync path stays
 * byte-identical with the pre-#16 handler.
 */

const KEEPALIVE_HEARTBEAT = ' \n';

/** Mirrors the boundary's response-header allowlist (kept module-local). */
const SAFE_RESPONSE_HEADERS = new Set([
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

function safeResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const reduced: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(normalized) || typeof value !== 'string') continue;
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

export class KeepaliveClientStreamError extends Error {
  constructor(readonly code: 'CLIENT_STREAM_ABORTED' | 'CLIENT_STREAM_FAILED') {
    super();
    this.name = 'KeepaliveClientStreamError';
  }
}

export interface JsonKeepaliveClientStreamOptions {
  /** Heartbeat cadence; <= 0 disables the stream (never construct). */
  readonly intervalMs: number;
}

function responseStatus(status: number | null): number {
  if (status === null) return 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
  }
  return status;
}

export class JsonKeepaliveClientStream implements PreparedEvidenceClientStream {
  private readonly controller = new AbortController();
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatsSent = false;
  private responseStarted = false;
  private disposed = false;
  private bodyBytesWritten = false;
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
    options: JsonKeepaliveClientStreamOptions,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1
    ) {
      throw new Error('the JSON keepalive stream requires a positive heartbeat interval');
    }
    this.intervalMs = options.intervalMs;
    this.request.once('aborted', this.onRequestAborted);
    this.request.once('close', this.onRequestClose);
    this.response.once('close', this.onResponseClose);
    this.response.once('error', this.onResponseError);
    if (
      this.request.aborted ||
      (!this.request.complete && this.request.destroyed) ||
      this.response.destroyed ||
      this.response.writableEnded
    ) {
      this.controller.abort();
    }
    if (!this.controller.signal.aborted) {
      this.timer = setInterval(() => this.beat(), this.intervalMs);
      // The heartbeat must never keep the process alive.
      this.timer.unref();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private beat(): void {
    if (this.signal.aborted || this.responseStarted) return;
    if (this.response.destroyed || this.response.writableEnded) {
      this.controller.abort();
      return;
    }
    try {
      if (!this.response.headersSent) {
        // First heartbeat commits 200 (the sub2api status tradeoff).
        this.response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          'x-request-id': this.requestId,
        });
      }
      this.response.write(KEEPALIVE_HEARTBEAT);
      this.heartbeatsSent = true;
    } catch {
      this.controller.abort();
    }
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    if (this.signal.aborted) throw new KeepaliveClientStreamError('CLIENT_STREAM_ABORTED');
    if (this.responseStarted || this.heartbeatsSent) {
      // The heartbeat already committed 200; the real upstream status is
      // deliberately not rewritten (the sub2api late-error tradeoff).
      this.responseStarted = true;
      this.stopTimer();
      return;
    }
    if (this.response.headersSent) throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
    this.response.writeHead(responseStatus(status), {
      ...safeResponseHeaders(headers),
      'x-request-id': this.requestId,
    });
    this.responseStarted = true;
    this.stopTimer();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.signal.aborted) throw new KeepaliveClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.writableEnded || this.response.destroyed) {
      throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (!(chunk instanceof Uint8Array)) throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
    this.bodyBytesWritten = true;
    let accepted: boolean;
    try {
      accepted = this.response.write(Buffer.from(chunk));
    } catch {
      throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
    }
    if (accepted) return;
    await this.waitForDrain();
  }

  end(): void {
    if (this.signal.aborted) throw new KeepaliveClientStreamError('CLIENT_STREAM_ABORTED');
    if (!this.responseStarted || this.response.destroyed) {
      throw new KeepaliveClientStreamError('CLIENT_STREAM_FAILED');
    }
    this.stopTimer();
    if (!this.response.writableEnded) this.response.end();
  }

  abort(error?: unknown): void {
    if (!this.signal.aborted) this.controller.abort();
    this.stopTimer();
    if (this.response.writableEnded || this.response.destroyed) return;
    if (this.heartbeatsSent && this.responseStarted && !this.bodyBytesWritten) {
      // Late upstream error after the flush, before any body bytes: pass the
      // failure through as an OpenAI-compatible JSON error body (the sub2api
      // tradeoff; the status stays the committed 200).
      void error;
      try {
        this.response.end(
          JSON.stringify({
            error: { code: 'UPSTREAM_ERROR', message: 'The upstream image request failed', requestId: this.requestId },
          }),
        );
      } catch {
        try {
          this.response.destroy();
        } catch {
          // The socket is already unusable.
        }
      }
      return;
    }
    if (this.response.headersSent) {
      try {
        this.response.end();
      } catch {
        try {
          this.response.destroy();
        } catch {
          // The socket is already unusable.
        }
      }
      return;
    }
    try {
      this.response.destroy();
    } catch {
      // The socket is already unusable; the abort signal is the durable fact.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    this.request.removeListener('aborted', this.onRequestAborted);
    this.request.removeListener('close', this.onRequestClose);
    this.response.removeListener('close', this.onResponseClose);
    this.response.removeListener('error', this.onResponseError);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
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
      const settle = (error?: KeepaliveClientStreamError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDrain = () => settle();
      const onClose = () => {
        this.controller.abort();
        settle(new KeepaliveClientStreamError('CLIENT_STREAM_ABORTED'));
      };
      const onError = () => settle(new KeepaliveClientStreamError('CLIENT_STREAM_FAILED'));
      const onAbort = () => settle(new KeepaliveClientStreamError('CLIENT_STREAM_ABORTED'));

      this.response.once('drain', onDrain);
      this.response.once('close', onClose);
      this.response.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted || this.response.destroyed) onAbort();
    });
  }
}
