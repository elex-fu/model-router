import type { PreparedEvidenceClientStream } from '../prepared-evidence-dispatch-service.js';

/**
 * Roadmap batch 4 §4.3 (task #17): a `PreparedEvidenceClientStream` that
 * forwards the upstream response to the real client unchanged while
 * recording the bytes under an explicit ceiling — the #16
 * RecordingClientStream contract, teed onto the synchronous client stream
 * so the video create can extract the upstream `request_id` from the body
 * it already delivered.
 *
 * The recording ceiling is the videos family body limit: an upstream
 * create response larger than the family ceiling is pathological and
 * aborts the stream (the already-delivered prefix stays delivered; the
 * task simply never registers and later polls fail closed).
 */
export class TeeRecordingClientStream implements PreparedEvidenceClientStream {
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private started = false;
  private ended = false;

  constructor(
    private readonly inner: PreparedEvidenceClientStream & { readonly dispose?: () => void },
    options: { readonly maxRecordedBytes: number },
  ) {
    if (!inner || typeof inner !== 'object')
      throw new Error('the tee recording stream requires an inner client stream');
    if (
      !options ||
      typeof options !== 'object' ||
      !Number.isSafeInteger(options.maxRecordedBytes) ||
      options.maxRecordedBytes < 1
    ) {
      throw new Error('the tee recording stream requires an explicit byte ceiling');
    }
    this.maxRecordedBytes = options.maxRecordedBytes;
  }

  private readonly maxRecordedBytes: number;

  get signal(): AbortSignal {
    return this.inner.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    this.inner.start(status, headers);
    this.started = true;
  }

  write(chunk: Uint8Array): void {
    this.inner.write(chunk);
    if (this.ended || !(chunk instanceof Uint8Array) || chunk.byteLength === 0) return;
    if (chunk.byteLength > this.maxRecordedBytes - this.totalBytes) {
      // The explicit ceiling is a hard bound on the recording buffer.
      this.inner.abort();
      throw new Error(`the recorded create response exceeds the ${this.maxRecordedBytes}-byte buffer ceiling`);
    }
    this.chunks.push(new Uint8Array(chunk));
    this.totalBytes += chunk.byteLength;
  }

  end(): void {
    this.inner.end();
    this.ended = true;
  }

  abort(error?: unknown): void {
    this.inner.abort(error);
  }

  dispose(): void {
    this.inner.dispose?.();
  }

  /** True once end() ran with the full body recorded under the ceiling. */
  get isComplete(): boolean {
    return this.started && this.ended && !this.signal.aborted;
  }

  /** The complete recorded body; invalid to call before end(). */
  recordedBody(): Uint8Array {
    if (!this.isComplete) throw new Error('the recorded create response body is not complete');
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
