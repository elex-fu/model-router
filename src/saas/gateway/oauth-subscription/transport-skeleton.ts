/// <reference lib="dom" />

/**
 * Shared OAuth-subscription transport skeleton (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Extracted from
 * the codex transport: the machinery every pinned-host OAuth subscription
 * transport needs regardless of provider headers — bounded error-body reads,
 * response flattening, header-value guards, per-account throttled
 * best-effort quota-snapshot writes and the SSE relay with
 * client-disconnect drain (the pump keeps consuming the upstream after the
 * client cancels so the usage in the terminal stream event is still
 * collected; sub2api parity). The codex transport re-imports these; the
 * Claude transport composes the same skeleton with Anthropic headers.
 */

export const MAX_HEADER_VALUE_BYTES = 4_096;

/** Whether a header value carries control characters (rejected by transports). */
export function headerValueHasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Flattens a fetch Response's headers into a lowercase plain map. */
export function flattenHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

/** Bounded read of a non-2xx response body for classification input. */
export async function boundedErrorBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) break;
      if (value.byteLength > buffer.byteLength - bytesRead) {
        try {
          await reader.cancel();
        } catch {
          // The truncated text is still the classification input.
        }
        break;
      }
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    if (signal.aborted) return null;
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytesRead));
}

/** Discards a response body without observing it. */
export function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to observe on a rejected body.
  }
}

/**
 * Incremental SSE watcher contract: the transport feeds every relayed chunk
 * and the skeleton reads `observed` once the terminal usage event arrived.
 */
export interface SseUsageWatcher<T> {
  feed(chunk: Uint8Array): void;
  readonly observed: T | null;
}

/**
 * SSE relay with client-disconnect drain: chunks flow to the client while it
 * reads; after the client cancels, the pump keeps consuming the upstream so
 * the terminal usage is still collected (bounded by `maxDrainBufferBytes` of
 * discarded buffering).
 */
export function createDrainingRelay<T>(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  watcher: SseUsageWatcher<T>,
  options: {
    readonly maxDrainBufferBytes: number;
    readonly errorMessage: string;
  },
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly usage: Promise<T | null>;
} {
  const reader = upstream.getReader();
  let resolveUsage!: (usage: T | null) => void;
  const usage = new Promise<T | null>((resolve) => {
    resolveUsage = resolve;
  });
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let pumpDone = false;
  let pumpError: unknown = null;
  let waiters: Array<() => void> = [];
  let clientCancelled = false;
  let upstreamCancelled = false;

  const notify = (): void => {
    const current = waiters;
    waiters = [];
    for (const waiter of current) waiter();
  };

  const cancelUpstream = (reason: unknown): void => {
    if (upstreamCancelled) return;
    upstreamCancelled = true;
    void reader.cancel(reason).catch(() => undefined);
  };

  const pump = (async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;
        watcher.feed(value);
        if (watcher.observed !== null && clientCancelled) {
          // Usage collected and the client is gone: stop draining early.
          cancelUpstream(undefined);
          break;
        }
        if (clientCancelled) {
          queuedBytes += value.byteLength;
          if (queuedBytes > options.maxDrainBufferBytes) {
            cancelUpstream(new Error(options.errorMessage));
            break;
          }
          continue;
        }
        queue.push(value);
        notify();
      }
    } catch (error) {
      pumpError = error;
    } finally {
      pumpDone = true;
      notify();
      resolveUsage(watcher.observed);
    }
  })();

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift();
            if (chunk !== undefined) {
              controller.enqueue(chunk);
              return;
            }
          }
          if (pumpDone) {
            if (pumpError !== null && !signal.aborted) {
              controller.error(pumpError instanceof Error ? pumpError : new Error(options.errorMessage));
              return;
            }
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      },
      async cancel(reason) {
        clientCancelled = true;
        queue.length = 0;
        // Deliberately NOT cancelling the upstream here: the pump keeps
        // draining until usage arrives or the bounded buffer trips.
        void pump;
        void reason;
      },
    },
    { highWaterMark: 0 },
  );

  return { stream, usage };
}

/**
 * Per-account throttled, best-effort quota snapshot write gate. The first
 * observation always writes; later ones only after the minimum interval.
 */
export class QuotaSnapshotWriteThrottle {
  private readonly lastWriteMs = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Records the attempt and reports whether the sink should be invoked. */
  shouldWrite(accountId: string): boolean {
    const nowMs = this.nowMs();
    const last = this.lastWriteMs.get(accountId);
    if (last !== undefined && nowMs - last < this.minIntervalMs) return false;
    this.lastWriteMs.set(accountId, nowMs);
    return true;
  }
}
