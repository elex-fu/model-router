import { normalizeUsage } from '../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from './dispatch-usage-settlement.js';

export const PROVIDER_JSON_USAGE_MAX_BODY_BYTES = 1024 * 1024;

export type ProviderJsonUsageUnknownReason =
  | 'unsupported_protocol_operation'
  | 'malformed_body'
  | 'invalid_usage'
  | 'no_usage'
  | 'oversized_body'
  | 'cancelled'
  | 'stream_error';

export type ProviderJsonUsageObservation =
  | { readonly state: 'reported'; readonly usage: NormalSuccessObservedUsage }
  | { readonly state: 'unknown'; readonly usage: null; readonly reason: ProviderJsonUsageUnknownReason };

export interface ProviderJsonUsageEvidence {
  readonly providerProtocol?: string;
  readonly providerOperation?: string;
}

export interface ProviderJsonObservedStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly observation: Promise<ProviderJsonUsageObservation>;
  getObservation(): ProviderJsonUsageObservation | null;
}

type JsonProtocol = 'openai' | 'anthropic' | 'responses';
type Fields = Record<string, unknown>;

// Counter names and required fields follow the existing SSE observer's strict
// OpenAI/Anthropic contract; all normalized cache and input semantics still
// come from telemetry/usage. Responses uses the compiler's canonical operation.
// Additional dimensions (e.g. audio/prediction counters, server tool usage or
// vendor extensions) deliberately remain unknown until explicitly supported.
const counterShapes = {
  openai: {
    required: ['prompt_tokens', 'completion_tokens'], optional: ['total_tokens', 'cached_tokens'],
    details: { prompt_tokens_details: ['cached_tokens'], completion_tokens_details: ['reasoning_tokens'] },
  },
  anthropic: {
    required: ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'], optional: [],
    details: { cache_creation: ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] },
  },
  responses: {
    required: ['input_tokens', 'output_tokens'], optional: ['total_tokens', 'cached_tokens'],
    details: { input_tokens_details: ['cached_tokens'], output_tokens_details: ['reasoning_tokens'] },
  },
} satisfies Record<JsonProtocol, {
  required: readonly string[]; optional: readonly string[]; details: Record<string, readonly string[]>;
}>;

function record(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
}

function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function selectedProtocol(evidence: ProviderJsonUsageEvidence): JsonProtocol | null {
  if (evidence.providerProtocol === 'openai' && evidence.providerOperation === 'chat.completions') return 'openai';
  if (evidence.providerProtocol === 'anthropic' && evidence.providerOperation === 'messages') return 'anthropic';
  if (evidence.providerProtocol === 'responses' && evidence.providerOperation === 'responses') return 'responses';
  return null;
}

function unknown(reason: ProviderJsonUsageUnknownReason): ProviderJsonUsageObservation {
  return { state: 'unknown', usage: null, reason };
}

// JSON.parse accepts duplicate names silently. Reject ambiguous usage/envelope
// names (including escaped aliases) and bound nesting before parsing. This is
// a lexical ambiguity check; JSON.parse remains the JSON syntax validator.
function unambiguousJson(text: string): boolean {
  const objects: Set<string>[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{' || character === '[') {
      depth += 1;
      if (depth > 64) return false;
      if (character === '{') objects.push(new Set());
    } else if (character === '}' || character === ']') {
      depth -= 1;
      if (character === '}') objects.pop();
    } else if (character === '"') {
      const start = index;
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '\\') index += 1;
        else if (text[index] === '"') { closed = true; break; }
      }
      if (!closed) return false;
      let next = index + 1;
      while (next < text.length && /[\t\n\r ]/.test(text[next]!)) next += 1;
      if (text[next] === ':') {
        const names = objects.at(-1);
        const name: unknown = JSON.parse(text.slice(start, index + 1));
        if (!names || typeof name !== 'string' || names.has(name)) return false;
        names.add(name);
      }
    }
  }
  return depth === 0;
}

function validEnvelope(protocol: JsonProtocol, body: Fields): boolean {
  if (body.error !== undefined && body.error !== null) return false;
  if (protocol === 'openai') {
    return body.object === 'chat.completion' && Array.isArray(body.choices) && body.choices.length > 0 &&
      body.choices.every((choice: unknown) => {
        const value = record(choice);
        return value !== null && typeof value.finish_reason === 'string' && value.finish_reason.length > 0 &&
          record(value.message)?.role === 'assistant';
      });
  }
  if (protocol === 'anthropic') {
    return body.type === 'message' && body.role === 'assistant' && Array.isArray(body.content) &&
      typeof body.stop_reason === 'string' && body.stop_reason.length > 0;
  }
  return body.object === 'response' && body.status === 'completed' && Array.isArray(body.output) &&
    (body.incomplete_details === undefined || body.incomplete_details === null);
}

function trustedUsage(protocol: JsonProtocol, value: unknown): NormalSuccessObservedUsage | null {
  const raw = record(value);
  if (!raw) return null;
  const shape: { required: readonly string[]; optional: readonly string[]; details: Record<string, readonly string[]> } =
    counterShapes[protocol];
  const scalarNames = [...shape.required, ...shape.optional];
  if (shape.required.some((name) => !Object.hasOwn(raw, name) || !token(raw[name]))) return null;
  for (const [name, counter] of Object.entries(raw)) {
    if (scalarNames.includes(name)) {
      if (!token(counter)) return null;
    } else {
      const allowed = Object.hasOwn(shape.details, name) ? shape.details[name] : undefined;
      const details = record(counter);
      if (!allowed || !details || Object.entries(details).some(([key, count]) => !allowed.includes(key) || !token(count))) {
        return null;
      }
    }
  }
  const usage = normalizeUsage(protocol, raw);
  if (usage.status !== 'reported' || usage.inputTotal === null || usage.outputTotal === null) return null;
  for (const name of ['inputTotal', 'inputUncached', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'outputTotal', 'reasoningOutput'] as const) {
    if (usage[name] !== null && !token(usage[name])) return null;
  }
  const total = usage.inputTotal + usage.outputTotal;
  if (!Number.isSafeInteger(total) || (Object.hasOwn(raw, 'total_tokens') && raw.total_tokens !== total)) return null;
  if ((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.inputTotal) return null;
  if ((usage.reasoningOutput ?? 0) > usage.outputTotal) return null;
  const detailTotal = (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0);
  if (!Number.isSafeInteger(detailTotal) || detailTotal > (usage.cacheWrite ?? 0)) return null;
  if (usage.cacheWrite5m !== null && usage.cacheWrite1h !== null && detailTotal !== usage.cacheWrite) return null;
  const inputDetails = record(raw[protocol === 'responses' ? 'input_tokens_details' : 'prompt_tokens_details']);
  if (inputDetails && Object.hasOwn(inputDetails, 'cached_tokens') && Object.hasOwn(raw, 'cached_tokens') &&
    inputDetails.cached_tokens !== raw.cached_tokens) return null;
  return Object.freeze({ ...usage, source: 'upstream' });
}

function parseBody(bytes: Uint8Array, protocol: JsonProtocol): ProviderJsonUsageObservation {
  let body: Fields | null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!unambiguousJson(text)) return unknown('malformed_body');
    body = record(JSON.parse(text));
  } catch {
    return unknown('malformed_body');
  }
  if (!body || !validEnvelope(protocol, body)) return unknown('malformed_body');
  if (!Object.hasOwn(body, 'usage') || body.usage === null) return unknown('no_usage');
  try {
    const usage = trustedUsage(protocol, body.usage);
    return usage ? { state: 'reported', usage } : unknown('invalid_usage');
  } catch {
    return unknown('invalid_usage');
  }
}

/** Demand-driven, byte-transparent observation. No body or parser error is logged. */
export function observeProviderJsonUsage(
  body: ReadableStream<Uint8Array>, evidence: ProviderJsonUsageEvidence,
): ProviderJsonObservedStream {
  const protocol = selectedProtocol(evidence);
  const reader = body.getReader();
  let buffer: Uint8Array | undefined;
  let length = 0;
  let oversized = false;
  let cancelled = false;
  let finalObservation: ProviderJsonUsageObservation | null = null;
  let resolveObservation!: (value: ProviderJsonUsageObservation) => void;
  const observation = new Promise<ProviderJsonUsageObservation>((resolve) => { resolveObservation = resolve; });
  const settle = (value: ProviderJsonUsageObservation) => {
    if (finalObservation) return;
    buffer = undefined;
    finalObservation = value;
    resolveObservation(value);
  };
  const release = () => {
    try { reader.releaseLock(); } catch { /* A cancellation may have released the reader already. */ }
  };
  const observedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (cancelled) { release(); return; }
        if (next.done) {
          settle(protocol === null ? unknown('unsupported_protocol_operation') : oversized ? unknown('oversized_body') :
            parseBody(buffer?.subarray(0, length) ?? new Uint8Array(), protocol));
          release();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw new TypeError('invalid provider response chunk');
        if (protocol !== null && !oversized) {
          if (next.value.byteLength > PROVIDER_JSON_USAGE_MAX_BODY_BYTES - length) {
            oversized = true;
            buffer = undefined;
          } else {
            buffer ??= new Uint8Array(PROVIDER_JSON_USAGE_MAX_BODY_BYTES);
            buffer.set(next.value, length);
            length += next.value.byteLength;
          }
        }
        controller.enqueue(next.value);
      } catch (error) {
        settle(unknown(cancelled ? 'cancelled' : 'stream_error'));
        try { await reader.cancel(error); } catch { /* Preserve the original stream error. */ }
        release();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      settle(unknown('cancelled'));
      try { await reader.cancel(reason); } finally { release(); }
    },
  }, { highWaterMark: 0 });
  return { body: observedBody, observation, getObservation: () => finalObservation };
}
