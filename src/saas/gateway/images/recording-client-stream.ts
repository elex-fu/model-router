import type { PreparedEvidenceClientStream } from '../prepared-evidence-dispatch-service.js';

/**
 * Roadmap batch 4 §4.2 (task #16) async image tasks: the in-memory
 * `PreparedEvidenceClientStream` implementation the async dispatch path
 * delivers the upstream response into (the roadmap's RecordingClientStream —
 * dispatch depends only on the stream interface, so no monkey-patching of
 * the transport is needed).
 *
 * Contract: `start` captures the committed status/headers, `write` appends
 * chunks up to the explicit `maxRecordedBytes` ceiling, `end` finalizes, and
 * `abort` / `signal` implement the cancellation contract the dispatch
 * service requires. The buffer ceiling is the explicit memory bound for the
 * async task: an upstream response that exceeds it is aborted and the task
 * fails — the recording never grows past the configured family ceiling.
 *
 * Unlike the HTTP client stream, the recording's signal is owned locally:
 * the client has already received its 202, so a client disconnect can never
 * cancel background execution; only the execution timeout or a buffer
 * overflow aborts the stream.
 */

export class RecordingClientStreamError extends Error {
  constructor(
    readonly code: 'CLIENT_STREAM_ABORTED' | 'CLIENT_STREAM_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'RecordingClientStreamError';
  }
}

export interface RecordingClientStreamOptions {
  /** Explicit byte ceiling for the recorded body. */
  readonly maxRecordedBytes: number;
}

function fail(code: RecordingClientStreamError['code'], message: string): never {
  throw new RecordingClientStreamError(code, message);
}

function responseStatus(status: number | null): number {
  if (status === null) return 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    fail('CLIENT_STREAM_FAILED', 'the recorded response status is invalid');
  }
  return status;
}

export class RecordingClientStream implements PreparedEvidenceClientStream {
  private readonly controller = new AbortController();
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private started = false;
  private ended = false;
  private committedStatus: number | null = null;
  private committedHeaders: Readonly<Record<string, string>> = {};

  constructor(options: RecordingClientStreamOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !Number.isSafeInteger(options.maxRecordedBytes) ||
      options.maxRecordedBytes < 1
    ) {
      throw new Error('the recording client stream requires an explicit byte ceiling');
    }
    this.maxRecordedBytes = options.maxRecordedBytes;
  }

  private readonly maxRecordedBytes: number;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    if (this.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'the recorded response stream was cancelled');
    if (this.started || this.ended) fail('CLIENT_STREAM_FAILED', 'the recorded response stream already started');
    this.committedStatus = responseStatus(status);
    this.committedHeaders = headers ?? {};
    this.started = true;
  }

  write(chunk: Uint8Array): void {
    if (this.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'the recorded response stream was cancelled');
    if (!this.started || this.ended) fail('CLIENT_STREAM_FAILED', 'the recorded response stream is not started');
    if (!(chunk instanceof Uint8Array)) fail('CLIENT_STREAM_FAILED', 'the recorded response chunk is invalid');
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength > this.maxRecordedBytes - this.totalBytes) {
      // The explicit ceiling is a hard bound: abort first so the dispatch
      // loop's next iteration observes the aborted signal, then fail.
      this.controller.abort();
      fail('CLIENT_STREAM_FAILED', `the recorded response exceeds the ${this.maxRecordedBytes}-byte buffer ceiling`);
    }
    this.chunks.push(new Uint8Array(chunk));
    this.totalBytes += chunk.byteLength;
  }

  end(): void {
    if (this.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'the recorded response stream was cancelled');
    if (!this.started || this.ended) fail('CLIENT_STREAM_FAILED', 'the recorded response stream is not started');
    this.ended = true;
  }

  abort(_error?: unknown): void {
    if (!this.signal.aborted) this.controller.abort();
  }

  /** True once end() ran with the full body recorded under the ceiling. */
  get isComplete(): boolean {
    return this.started && this.ended && !this.signal.aborted;
  }

  get recordedStatus(): number | null {
    return this.started ? this.committedStatus : null;
  }

  get recordedHeaders(): Readonly<Record<string, string>> {
    return this.started ? this.committedHeaders : {};
  }

  get recordedByteLength(): number {
    return this.totalBytes;
  }

  /** The complete recorded body; invalid to call before end(). */
  recordedBody(): Uint8Array {
    if (!this.isComplete) fail('CLIENT_STREAM_FAILED', 'the recorded response body is not complete');
    if (this.totalBytes === 0) return new Uint8Array(0);
    const sole = this.chunks[0];
    if (this.chunks.length === 1 && sole !== undefined) return new Uint8Array(sole);
    const combined = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }
}
