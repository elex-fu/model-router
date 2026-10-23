import { createHash, timingSafeEqual } from 'node:crypto';
import type { PreparedEvidenceTransport, PreparedEvidenceTransportRequest, PreparedEvidenceTransportResponse } from '../prepared-evidence-dispatch-service.js';
import { createUsageEvidence, CODEX_RESPONSES_WATCHER_VERSION, type UsageEvidenceCompleteness } from '../usage-evidence.js';
import { ResponsesUsageWatcher, codexUsageToObservedUsage } from './transport.js';
import { codexNativeWsSession, type CodexNativeWsIdentity, type CodexNativeWsSessionHandle } from './native-ws-session.js';
import { CODEX_NATIVE_WS_ENDPOINT, type PreparedCodexNativeWsConnector } from './native-ws-connector.js';
export interface CodexNativeWsTransportRequest extends PreparedEvidenceTransportRequest { readonly codexNativeWsSession?: CodexNativeWsSessionHandle }
export interface CodexNativeWsAuthorizedContext {
  readonly identity: CodexNativeWsIdentity;
  readonly connector: PreparedCodexNativeWsConnector;
  readonly headers: Readonly<Record<string, string>>;
}
export interface CodexNativeWsTransportOptions {
  /** Must verify fresh claimed proof/profile/lease and use the credential only inside this callback. */
  readonly withAuthorizedContext: <T>(input: PreparedEvidenceTransportRequest, use: (context: CodexNativeWsAuthorizedContext) => Promise<T>) => Promise<T>;
  readonly maxFrameBytes: number;
  readonly maxQueueBytes: number;
  readonly timeoutMs: number;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Native WS frames become SSE bytes for the existing dispatch, usage and durable settlement path. */
export class CodexNativeWsPreparedEvidenceTransport implements PreparedEvidenceTransport {
  private readonly handles = new Map<CodexNativeWsSessionHandle, () => void>();
  async close(): Promise<void> { const handles = [...this.handles.keys()]; for (const handle of handles) await codexNativeWsSession(handle).close(); this.handles.clear(); }
  constructor(private readonly options: CodexNativeWsTransportOptions) {
    if (![options.maxFrameBytes, options.maxQueueBytes, options.timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0) || options.maxFrameBytes > options.maxQueueBytes) throw new Error('Invalid native response stream limits');
  }
  async send(input: CodexNativeWsTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    if (!input.codexNativeWsSession || input.signal.aborted || input.evidence.claimedAttemptId !== input.attemptId || input.evidence.status !== 'claimed' || input.evidence.providerOperation === 'responses.compact') throw new Error('Native response dispatch context unavailable');
    const expected = Buffer.from(input.evidence.payloadSha256, 'hex');
    const actual = createHash('sha256').update(input.payloadBytes).digest();
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) throw new Error('Native response payload binding mismatch');
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(input.payloadBytes)); } catch { throw new Error('Invalid native response payload'); }
    if (!record(body) || typeof body.model !== 'string' || Object.hasOwn(body, 'type')) throw new Error('Invalid native response payload');
    const requestBody = body;
    const handle = input.codexNativeWsSession;
    const session = codexNativeWsSession(handle);
    if (!this.handles.has(handle)) { let alreadyClosed = false; const detach = session.onClosed(() => { alreadyClosed = true; this.handles.delete(handle); }); if (!alreadyClosed) this.handles.set(handle, detach); }
    return this.options.withAuthorizedContext(input, async (context) => {
      const identity = context.identity;
      if (identity.tenantId !== input.tenantId || identity.projectId !== input.projectId ||
          identity.providerId !== 'openai-codex' || identity.providerId !== input.evidence.providerId ||
          identity.productId !== 'codex-chatgpt' || identity.productId !== input.evidence.productId ||
          identity.accountId !== input.evidence.accountId || identity.credentialId !== input.evidence.credentialId ||
          identity.credentialVersion !== input.evidence.credentialVersion || identity.model !== input.evidence.resolvedModel ||
          identity.publicModel !== input.evidence.publicModel || requestBody.model !== identity.model || identity.endpoint !== CODEX_NATIVE_WS_ENDPOINT ||
          identity.egressIdentity !== context.connector.egressIdentity) throw new Error('Native response authority binding mismatch');
      const previousId = typeof requestBody.previous_response_id === 'string' ? requestBody.previous_response_id : null;
      if (requestBody.previous_response_id !== undefined && previousId === null) throw new Error('Invalid native response reference');
      const socket = await session.begin(context.identity, previousId, () => context.connector.open(context.headers, input.signal));
      const watcher = new ResponsesUsageWatcher();
      const encoder = new TextEncoder();
      const queue: Uint8Array[] = [];
      let queuedBytes = 0;
      let terminal = false;
      let responseId: string | null = null;
      let failed: Error | null = null;
      let failureCompleteness: UsageEvidenceCompleteness | null = null;
      let wake: (() => void) | null = null;
      let written = false;
      let disposed = false;
      let removeMessage = () => {};
      let removeClose = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notify = () => { const listener = wake; wake = null; listener?.(); };
      const dispose = () => { if (disposed) return; disposed = true; clearTimeout(timer); removeMessage(); removeClose(); input.signal.removeEventListener('abort', abort); };
      const fail = (message: string, completeness: UsageEvidenceCompleteness = 'incomplete-truncated') => {
        if (terminal || failed) return;
        failed = new Error(message);
        failureCompleteness = completeness;
        dispose();
        void session.close();
        notify();
      };
      const abort = () => {
        // Only the already-observed response on THIS generation may be interrupted.
        if (written && responseId !== null && !terminal) { try { socket.send(JSON.stringify({ type: 'response.cancel', response_id: responseId })); } catch {} }
        fail('Native response outcome unknown after cancellation', 'incomplete-client-disconnect');
      };
      removeClose = socket.onClose(() => fail('Native response connection ended before terminal usage'));
      removeMessage = socket.onMessage((data) => {
        if (terminal || failed) return;
        const bytes = encoder.encode(data);
        if (bytes.byteLength > this.options.maxFrameBytes) { fail('Native response frame limit exceeded', 'incomplete-oversized'); return; }
        let event: unknown;
        try { event = JSON.parse(data); } catch { fail('Native response frame malformed', 'incomplete-malformed'); return; }
        if (!record(event) || typeof event.type !== 'string' || event.type === 'error') { fail('Native response upstream error'); return; }
        const response = record(event.response) ? event.response : null;
        if (response && typeof response.id === 'string') {
          if (session.hasCompleted(response.id) || (responseId !== null && responseId !== response.id)) { fail('Native response identity changed within a round'); return; }
          if (event.type === 'response.created') responseId = response.id;
        }
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type) && (responseId === null || response?.id !== responseId)) { fail('Native response terminal identity unavailable'); return; }
        const chunk = encoder.encode(`data: ${data}\n\n`);
        if (queuedBytes + chunk.byteLength > this.options.maxQueueBytes) { fail('Native response queue limit exceeded', 'incomplete-oversized'); return; }
        watcher.feed(chunk);
        queue.push(chunk); queuedBytes += chunk.byteLength;
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
          terminal = true;
          dispose();
          session.finish(event.type === 'response.failed' ? null : responseId);
        }
        notify();
      });
      timer = setTimeout(() => fail('Native response terminal timeout; outcome unknown'), this.options.timeoutMs);
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      try {
        if (failed) throw failed;
        const frame = JSON.stringify({ type: 'response.create', ...requestBody });
        const frameBytes = encoder.encode(frame).byteLength;
        if (frameBytes > this.options.maxFrameBytes || socket.bufferedAmount + frameBytes > this.options.maxQueueBytes) throw new Error('Native response outbound limit exceeded');
        // The dispatch service has already crossed its write fence. Never replay this frame on failure.
        written = true;
        socket.send(frame);
      } catch (error) { dispose(); void session.close(); throw error; }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (true) {
            if (queue.length > 0) { const chunk = queue.shift()!; queuedBytes -= chunk.byteLength; controller.enqueue(chunk); return; }
            if (failed) { controller.error(failed); return; }
            if (terminal) { controller.close(); return; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
        cancel() { abort(); },
      }, { highWaterMark: 0 });
      return {
        responseStarted: true, resultHttpStatus: 200, headers: { 'content-type': 'text/event-stream' }, body: stream,
        get providerUsage() { return watcher.observed === null ? null : codexUsageToObservedUsage(watcher.observed); },
        get usageEvidence() { return createUsageEvidence({ meteringSource: 'codex-responses-watcher', observerVersion: `${CODEX_RESPONSES_WATCHER_VERSION}/native-ws`, model: input.evidence.resolvedModel, operation: input.evidence.providerOperation, completeness: failureCompleteness ?? watcher.completeness, adapterVersion: input.evidence.payloadCompilerVersion }); },
      };
    });
  }
}
