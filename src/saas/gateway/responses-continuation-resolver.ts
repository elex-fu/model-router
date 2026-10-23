import { createHash } from 'node:crypto';
import { markCodexCanonicalReplay } from './codex/continuation-metadata.js';
import type { ResponsesContinuationHistoryPort, ResponsesHistoryCipherPort, ResponsesHistoryIdentity, ResponsesHistoryRecord, ResponsesHistoryReference } from './responses-continuation-history.js';
import { ResponsesWsRoundError } from './responses-ws-engine.js';
function required(): never { throw new ResponsesWsRoundError('full_context_required', 'the response context is unavailable; resend full context', 409); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { const serialized = JSON.stringify(value); if (serialized === undefined) return required(); return serialized; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function items(value: unknown): unknown[] | null { return Array.isArray(value) ? value : typeof value === 'string' ? [{ role: 'user', content: value }] : null; }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function aad(saved: Omit<ResponsesHistoryRecord, 'encryptionKeyId' | 'encryptedContext'>): Uint8Array {
  return new TextEncoder().encode(canonical({ purpose: 'responses-canonical-history/v1', identity: saved.identity, tenantId: saved.tenantId, projectId: saved.projectId, proxyKeyId: saved.proxyKeyId, conversationId: saved.conversationId, responseId: saved.responseId, digest: saved.canonicalContextDigest, createdAtMs: saved.createdAtMs, expiresAtMs: saved.expiresAtMs }));
}
export interface ResolvedResponsesHistory {
  readonly body: Record<string, unknown>;
  readonly identity: ResponsesHistoryIdentity;
  readonly reference: ResponsesHistoryReference;
}
/** Pre-admission decrypt/replay, followed by mandatory post-preparation identity validation. */
export class PersistentResponsesContinuationResolver {
  constructor(private readonly options: { readonly history: ResponsesContinuationHistoryPort; readonly cipher: ResponsesHistoryCipherPort; readonly maxBytes: number; readonly ttlMs: number; readonly nowMs?: () => number }) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 16 * 1024 * 1024 || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 24 * 60 * 60 * 1000) throw new Error('Invalid history limits');
  }
  async resolve(reference: ResponsesHistoryReference, delta: Record<string, unknown>): Promise<ResolvedResponsesHistory> {
    const now = (this.options.nowMs ?? Date.now)();
    const saved = await this.options.history.find(reference, now).catch(() => null);
    if (!saved || saved.expiresAtMs <= now || saved.createdAtMs > now || (['tenantId', 'projectId', 'proxyKeyId', 'conversationId', 'responseId'] as const).some((key) => saved[key] !== reference[key])) return required();
    let plaintext: Uint8Array;
    try { plaintext = await this.options.cipher.open(saved, aad(saved)); } catch { return required(); }
    try {
      if (plaintext.byteLength > this.options.maxBytes || digest(plaintext) !== saved.canonicalContextDigest) return required();
      const body: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext));
      if (!record(body) || !items(body.input) || !items(delta.input) || (delta.model !== undefined && delta.model !== saved.identity.publicModel)) return required();
      const resolved: Record<string, unknown> = { ...body, ...delta, model: saved.identity.publicModel, input: [...items(body.input)!, ...items(delta.input)!] };
      delete resolved.previous_response_id;
      if (Buffer.byteLength(canonical(resolved)) > this.options.maxBytes) return required();
      return { body: markCodexCanonicalReplay(resolved), identity: saved.identity, reference };
    } catch { return required(); } finally { plaintext.fill(0); }
  }
  /** Call after prepare and compensate the prepared hold before surfacing a mismatch. */
  assertPreparedIdentity(resolved: ResolvedResponsesHistory, prepared: ResponsesHistoryIdentity): void {
    if (Object.entries(resolved.identity).some(([key, value]) => prepared[key as keyof ResponsesHistoryIdentity] !== value)) required();
  }
  /** Must run only after durable dispatch/settlement; a storage failure never refunds inference. */
  async remember(input: { readonly identity: ResponsesHistoryIdentity; readonly responseId: string; readonly request: Record<string, unknown>; readonly output: readonly unknown[]; readonly operation: 'responses' | 'responses.compact' }): Promise<boolean> {
    const now = (this.options.nowMs ?? Date.now)();
    const original = items(input.request.input);
    if (!original || !input.responseId) return false;
    // Compaction replaces the long history with the ENTIRE returned output.
    const body: Record<string, unknown> = { ...input.request, input: input.operation === 'responses.compact' ? [...input.output] : [...original, ...input.output] };
    delete body.previous_response_id;
    let plaintext: Uint8Array;
    try { plaintext = new TextEncoder().encode(canonical(body)); } catch { return false; }
    if (plaintext.byteLength > this.options.maxBytes) { plaintext.fill(0); return false; }
    try {
      const metadata = { tenantId: input.identity.tenantId, projectId: input.identity.projectId, proxyKeyId: input.identity.proxyKeyId, conversationId: input.identity.conversationId, responseId: input.responseId, identity: input.identity, canonicalContextDigest: digest(plaintext), createdAtMs: now, expiresAtMs: now + this.options.ttlMs };
      const sealed = await this.options.cipher.seal(plaintext, aad(metadata));
      return await this.options.history.insert({ ...metadata, ...sealed }) !== 'conflict';
    } catch { return false; } finally { plaintext.fill(0); }
  }
}
