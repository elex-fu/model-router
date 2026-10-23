import { markCodexCanonicalReplay } from './codex/continuation-metadata.js';
import { ResponsesWsRoundError, type ResponsesWsEvent, type ResponsesWsPinnedIdentity } from './responses-ws-engine.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function items(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : typeof value === 'string' ? [{ role: 'user', content: value }] : null;
}
function required(): never {
  throw new ResponsesWsRoundError('full_context_required', 'the response context is unavailable; resend full context', 409);
}
interface SavedContext {
  readonly body: Record<string, unknown>;
  readonly pin: ResponsesWsPinnedIdentity;
}
/** Connection-local, bounded canonical history; references never cross a connection or identity. */
export class ResponsesContinuationStore {
  private readonly contexts = new Map<string, SavedContext>();
  constructor(private readonly maxBytes: number) {}

  resolve(body: Record<string, unknown>, identity: {
    readonly tenantId: string;
    readonly projectId?: string;
    readonly proxyKeyId: string;
    readonly pinned: ResponsesWsPinnedIdentity | null;
  }): Record<string, unknown> {
    if (body.previous_response_id === undefined || body.previous_response_id === null) return body;
    const saved = typeof body.previous_response_id === 'string' ? this.contexts.get(body.previous_response_id) : undefined;
    const pin = identity.pinned;
    if (!saved || !pin || saved.pin.tenantId !== identity.tenantId || saved.pin.projectId !== identity.projectId || saved.pin.proxyKeyId !== identity.proxyKeyId) required();
    for (const field of ['providerId', 'accountId', 'upstreamModel', 'credentialId', 'credentialVersion', 'credentialAuthzVersion'] as const) {
      if (saved.pin[field] !== pin[field]) required();
    }
    if (body.model !== saved.pin.publicModel || !saved.pin.credentialId) required();
    const delta = items(body.input);
    const history = items(saved.body.input);
    if (!delta || !history) required();
    const resolved: Record<string, unknown> = { ...saved.body, ...body, input: [...history, ...delta] };
    delete resolved.previous_response_id;
    if (Buffer.byteLength(JSON.stringify(resolved)) > this.maxBytes) required();
    return markCodexCanonicalReplay(resolved);
  }

  remember(body: Record<string, unknown>, terminal: ResponsesWsEvent, pin: ResponsesWsPinnedIdentity): void {
    // Only a complete terminal output array proves what the next request must replay.
    const response = record(terminal.response) ? terminal.response : null;
    if (!response || typeof response.id !== 'string' || !Array.isArray(response.output)) return;
    if (!['response.completed', 'response.incomplete'].includes(terminal.type)) return;
    const input = items(body.input);
    if (!input || !pin.credentialId) return;
    // Preserve every output item, including complete compaction output, reasoning and tool calls.
    const canonical = { ...body, input: [...input, ...response.output] };
    const bytes = Buffer.byteLength(JSON.stringify(canonical));
    if (bytes > this.maxBytes) return;
    this.contexts.clear();
    this.contexts.set(response.id, { body: structuredClone(canonical), pin: { ...pin } });
  }
}
