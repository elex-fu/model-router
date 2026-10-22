import { type NormalizedUsage, normalizeUsage } from '../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from './dispatch-usage-settlement.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from './prepared-evidence-dispatch-service.js';
import {
  anthropicUsageMetadataKeys,
  type ProviderUsageProfile,
  type ProviderUsageProfileEvidence,
  providerUsageProfile,
  validAnthropicUsageMetadata,
} from './provider-usage-profile.js';

export const PROVIDER_SSE_USAGE_MAX_EVENT_BYTES = 32 * 1024;

export type ProviderSseUsageUnknownReason =
  | 'unsupported_protocol_operation'
  | 'malformed_event'
  | 'invalid_usage'
  | 'conflicting_usage'
  | 'oversized_event'
  | 'truncated'
  | 'no_usage'
  | 'cancelled'
  | 'stream_error';

export type ProviderSseUsageObservation =
  | {
      readonly state: 'reported';
      readonly usage: NormalSuccessObservedUsage;
      /**
       * R3 §8.3: the served tier declared by the stream (OpenAI chunk-level
       * `service_tier`; Anthropic `usage.speed`). Merged by event semantics:
       * repeated declarations must agree.
       */
      readonly observedServiceTier: string | null;
      /** Multiple reports disagreed; the tier is never billed on (§8.3). */
      readonly observedServiceTierConflict: boolean;
    }
  | {
      readonly state: 'unknown';
      readonly usage: null;
      readonly reason: ProviderSseUsageUnknownReason;
      readonly observedServiceTier: string | null;
      readonly observedServiceTierConflict: boolean;
    };

export interface ProviderSseUsageEvidence extends ProviderUsageProfileEvidence {
  /**
   * §4.1 (roadmap batch 4) media observation seam. Media responses are JSON
   * documents, not SSE event streams, so the SSE observer itself never
   * extracts per-unit usage; this reserved hook lets a #16/#17 category
   * transport surface a usage observation it captured out-of-band (e.g. a
   * terminal JSON body recorded by the async-task path) through the same
   * settle channel instead of the stream parser. Null (the default) keeps
   * the pure parser behavior.
   */
  readonly mediaUsage?: NormalSuccessObservedUsage | null;
}

export interface ProviderSseObservedStream {
  readonly body: ReadableStream<Uint8Array>;
  /** Settles only when the body reaches EOF, errors, or is cancelled. */
  readonly observation: Promise<ProviderSseUsageObservation>;
  /** Synchronous state for callers that have already awaited body EOF. */
  getObservation(): ProviderSseUsageObservation | null;
}

type ParserKind = 'openai-chat-completions' | 'anthropic-messages';
type UsageParserFailure = Exclude<
  ProviderSseUsageUnknownReason,
  'unsupported_protocol_operation' | 'cancelled' | 'stream_error'
>;
type UsageRecord = Record<string, unknown>;

class UsageObservationError extends Error {
  constructor(readonly reason: UsageParserFailure) {
    super(reason);
  }
}

function rejectUsage(reason: UsageParserFailure): never {
  throw new UsageObservationError(reason);
}

function record(value: unknown): UsageRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UsageRecord) : null;
}

function assertAllowedKeys(value: UsageRecord, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) rejectUsage('invalid_usage');
}

function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requiredToken(value: UsageRecord, key: string): number {
  if (!Object.hasOwn(value, key) || !token(value[key])) rejectUsage('invalid_usage');
  return value[key] as number;
}

function optionalToken(value: UsageRecord, key: string): number | null {
  if (!Object.hasOwn(value, key)) return null;
  if (!token(value[key])) rejectUsage('invalid_usage');
  return value[key] as number;
}

function completeUsage(protocol: 'openai' | 'anthropic', raw: UsageRecord): NormalSuccessObservedUsage {
  const usage = normalizeUsage(protocol, raw);
  if (
    usage.status !== 'reported' ||
    usage.source !== 'upstream' ||
    usage.inputTotal === null ||
    usage.outputTotal === null
  ) {
    rejectUsage('invalid_usage');
  }
  return Object.freeze({ ...usage, source: 'upstream' });
}

function usageFieldsEqual(left: NormalizedUsage, right: NormalizedUsage): boolean {
  return (
    left.inputTotal === right.inputTotal &&
    left.inputUncached === right.inputUncached &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.cacheWrite5m === right.cacheWrite5m &&
    left.cacheWrite1h === right.cacheWrite1h &&
    left.outputTotal === right.outputTotal &&
    left.reasoningOutput === right.reasoningOutput &&
    left.status === right.status &&
    left.source === right.source &&
    left.semanticsVersion === right.semanticsVersion
  );
}

function parseOpenAiUsage(value: unknown): NormalSuccessObservedUsage {
  const usage = record(value);
  if (!usage) rejectUsage('invalid_usage');
  assertAllowedKeys(usage, [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
    'cached_tokens',
  ]);
  const inputTotal = requiredToken(usage, 'prompt_tokens');
  const outputTotal = requiredToken(usage, 'completion_tokens');
  const total = inputTotal + outputTotal;
  if (!Number.isSafeInteger(total)) rejectUsage('invalid_usage');
  const reportedTotal = optionalToken(usage, 'total_tokens');
  if (reportedTotal !== null && reportedTotal !== total) rejectUsage('invalid_usage');

  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  if (Object.hasOwn(usage, 'prompt_tokens_details') && !promptDetails) rejectUsage('invalid_usage');
  if (Object.hasOwn(usage, 'completion_tokens_details') && !completionDetails) rejectUsage('invalid_usage');
  if (promptDetails) assertAllowedKeys(promptDetails, ['cached_tokens']);
  if (completionDetails) assertAllowedKeys(completionDetails, ['reasoning_tokens']);

  const nestedCached = promptDetails ? optionalToken(promptDetails, 'cached_tokens') : null;
  const topLevelCached = optionalToken(usage, 'cached_tokens');
  if (nestedCached !== null && topLevelCached !== null && nestedCached !== topLevelCached) {
    rejectUsage('invalid_usage');
  }
  const cacheRead = nestedCached ?? topLevelCached;
  if (cacheRead !== null && cacheRead > inputTotal) rejectUsage('invalid_usage');
  const reasoningOutput = completionDetails ? optionalToken(completionDetails, 'reasoning_tokens') : null;
  if (reasoningOutput !== null && reasoningOutput > outputTotal) rejectUsage('invalid_usage');

  return completeUsage('openai', usage);
}

interface AnthropicInputUsage {
  readonly inputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite5m: number | null;
  readonly cacheWrite1h: number | null;
}

function parseAnthropicInputUsage(
  value: UsageRecord,
  requireInputFields: boolean,
  profile: ProviderUsageProfile,
  envelope: UsageRecord,
): Partial<AnthropicInputUsage> {
  assertAllowedKeys(value, [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cache_creation',
    // §8.3: the served-tier declaration rides inside usage as `speed`.
    'speed',
    ...anthropicUsageMetadataKeys(profile),
  ]);
  if (!validAnthropicUsageMetadata(profile, value, envelope)) rejectUsage('invalid_usage');
  // A declared `speed` must be a short string; anything else invalidates the
  // usage report (the tier value itself was already merged by the caller).
  if (Object.hasOwn(value, 'speed') && tierText(value.speed) === null) rejectUsage('invalid_usage');
  const inputTokens =
    requireInputFields || Object.hasOwn(value, 'input_tokens') ? requiredToken(value, 'input_tokens') : undefined;
  const cacheRead =
    requireInputFields || Object.hasOwn(value, 'cache_read_input_tokens')
      ? requiredToken(value, 'cache_read_input_tokens')
      : undefined;
  const cacheWrite =
    requireInputFields || Object.hasOwn(value, 'cache_creation_input_tokens')
      ? requiredToken(value, 'cache_creation_input_tokens')
      : undefined;
  if (Object.hasOwn(value, 'output_tokens')) requiredToken(value, 'output_tokens');

  let cacheWrite5m: number | null | undefined;
  let cacheWrite1h: number | null | undefined;
  if (Object.hasOwn(value, 'cache_creation')) {
    const details = record(value.cache_creation);
    if (!details) rejectUsage('invalid_usage');
    assertAllowedKeys(details, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
    cacheWrite5m = Object.hasOwn(details, 'ephemeral_5m_input_tokens')
      ? optionalToken(details, 'ephemeral_5m_input_tokens')
      : requireInputFields
        ? null
        : undefined;
    cacheWrite1h = Object.hasOwn(details, 'ephemeral_1h_input_tokens')
      ? optionalToken(details, 'ephemeral_1h_input_tokens')
      : requireInputFields
        ? null
        : undefined;
  } else if (requireInputFields) {
    cacheWrite5m = null;
    cacheWrite1h = null;
  }

  const detailSum = (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0);
  if (!Number.isSafeInteger(detailSum)) rejectUsage('invalid_usage');
  if (cacheWrite !== undefined) {
    if (detailSum > cacheWrite) rejectUsage('invalid_usage');
    if (cacheWrite5m !== null && cacheWrite5m !== undefined && cacheWrite1h !== null && cacheWrite1h !== undefined) {
      if (detailSum !== cacheWrite) rejectUsage('invalid_usage');
    }
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite5m === undefined ? {} : { cacheWrite5m }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
  };
}

function mergeAnthropicInputUsage(
  initial: AnthropicInputUsage,
  update: Partial<AnthropicInputUsage>,
): AnthropicInputUsage {
  const fields = ['inputTokens', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const;
  for (const field of fields) {
    const next = update[field];
    const previous = initial[field];
    if (next !== undefined && previous !== null && previous !== next) rejectUsage('conflicting_usage');
  }
  const merged = {
    inputTokens: update.inputTokens ?? initial.inputTokens,
    cacheRead: update.cacheRead ?? initial.cacheRead,
    cacheWrite: update.cacheWrite ?? initial.cacheWrite,
    cacheWrite5m: update.cacheWrite5m ?? initial.cacheWrite5m,
    cacheWrite1h: update.cacheWrite1h ?? initial.cacheWrite1h,
  };
  const detailSum = (merged.cacheWrite5m ?? 0) + (merged.cacheWrite1h ?? 0);
  if (!Number.isSafeInteger(detailSum) || detailSum > merged.cacheWrite) rejectUsage('invalid_usage');
  if (merged.cacheWrite5m !== null && merged.cacheWrite1h !== null && detailSum !== merged.cacheWrite) {
    rejectUsage('invalid_usage');
  }
  return merged;
}

function buildAnthropicUsage(input: AnthropicInputUsage, outputTokens: number): NormalSuccessObservedUsage {
  const totalInput = input.inputTokens + input.cacheRead + input.cacheWrite;
  if (!Number.isSafeInteger(totalInput)) rejectUsage('invalid_usage');
  return completeUsage('anthropic', {
    input_tokens: input.inputTokens,
    cache_read_input_tokens: input.cacheRead,
    cache_creation_input_tokens: input.cacheWrite,
    ...(input.cacheWrite5m === null && input.cacheWrite1h === null
      ? {}
      : {
          cache_creation: {
            ...(input.cacheWrite5m === null ? {} : { ephemeral_5m_input_tokens: input.cacheWrite5m }),
            ...(input.cacheWrite1h === null ? {} : { ephemeral_1h_input_tokens: input.cacheWrite1h }),
          },
        }),
    output_tokens: outputTokens,
  });
}

const MAX_TIER_TEXT_BYTES = 32;

/** §8.3: a short, trimmed, lowercased tier declaration; anything else is none. */
function tierText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || trimmed.length > MAX_TIER_TEXT_BYTES) return null;
  return trimmed;
}

function unknown(reason: ProviderSseUsageUnknownReason): ProviderSseUsageObservation {
  return { state: 'unknown', usage: null, reason, observedServiceTier: null, observedServiceTierConflict: false };
}

class ProviderSseUsageParser {
  private readonly kind: ParserKind | null;
  private readonly profile: ProviderUsageProfile;
  private readonly lineBuffer = new Uint8Array(PROVIDER_SSE_USAGE_MAX_EVENT_BYTES);
  private lineLength = 0;
  private eventBytes = 0;
  private eventType: string | undefined;
  private dataLines: string[] = [];
  private previousWasCarriageReturn = false;
  private firstLine = true;
  private failure: UsageParserFailure | undefined;
  private openAiUsage: NormalSuccessObservedUsage | undefined;
  private openAiDone = false;
  private anthropicStarted = false;
  private anthropicDelta: { readonly input: AnthropicInputUsage; readonly outputTokens: number } | undefined;
  private anthropicStopped = false;
  private anthropicUsage: NormalSuccessObservedUsage | undefined;
  /**
   * R3 §8.3 observed-tier state. undefined = not yet declared; null declared
   * absent. Disagreeing declarations set `tierConflict` without invalidating
   * the usage observation — the conflict is recorded and the tier is never
   * applied (never billed on, never double-accumulated).
   */
  private observedTier: string | null | undefined;
  private tierConflict = false;

  constructor(evidence: ProviderSseUsageEvidence) {
    this.profile = providerUsageProfile(evidence);
    this.kind =
      evidence.providerProtocol === 'openai' && evidence.providerOperation === 'chat.completions'
        ? 'openai-chat-completions'
        : evidence.providerProtocol === 'anthropic' && evidence.providerOperation === 'messages'
          ? 'anthropic-messages'
          : null;
  }

  /** Merges one tier declaration by event semantics (repeats must agree). */
  private observeTier(value: unknown, declared: boolean): void {
    const tier = tierText(value);
    if (!declared) return;
    if (this.tierConflict) return;
    if (this.observedTier === undefined) {
      this.observedTier = tier;
      return;
    }
    if (this.observedTier !== tier) this.tierConflict = true;
  }

  tierFields(): { readonly observedServiceTier: string | null; readonly observedServiceTierConflict: boolean } {
    return {
      observedServiceTier: this.tierConflict ? null : (this.observedTier ?? null),
      observedServiceTierConflict: this.tierConflict,
    };
  }

  feed(chunk: Uint8Array): void {
    if (this.failure || !this.kind) return;
    for (const byte of chunk) {
      if (byte === 13) {
        this.countEventByte();
        if (this.failure) return;
        this.processLine();
        this.previousWasCarriageReturn = true;
        continue;
      }
      if (byte === 10) {
        if (this.previousWasCarriageReturn) {
          this.previousWasCarriageReturn = false;
          continue;
        }
        this.countEventByte();
        if (this.failure) return;
        this.processLine();
        continue;
      }
      this.previousWasCarriageReturn = false;
      this.countEventByte();
      if (this.failure) return;
      if (this.lineLength >= this.lineBuffer.byteLength) {
        this.failure = 'oversized_event';
        return;
      }
      this.lineBuffer[this.lineLength] = byte;
      this.lineLength += 1;
    }
  }

  finish(): ProviderSseUsageObservation {
    if (!this.kind) return unknown('unsupported_protocol_operation');
    const tier = this.tierFields();
    if (this.failure) return { ...unknown(this.failure), ...tier };
    if (this.lineLength > 0 || this.eventType !== undefined || this.dataLines.length > 0) {
      return { ...unknown('truncated'), ...tier };
    }
    if (this.kind === 'openai-chat-completions') {
      if (!this.openAiDone) return { ...unknown('truncated'), ...tier };
      return this.openAiUsage
        ? { state: 'reported', usage: this.openAiUsage, ...tier }
        : { ...unknown('no_usage'), ...tier };
    }
    if (this.anthropicStarted && !this.anthropicStopped) return { ...unknown('truncated'), ...tier };
    return this.anthropicUsage
      ? { state: 'reported', usage: this.anthropicUsage, ...tier }
      : { ...unknown('no_usage'), ...tier };
  }

  fail(reason: 'cancelled' | 'stream_error'): ProviderSseUsageObservation {
    if (this.kind === null) return unknown('unsupported_protocol_operation');
    return { ...unknown(this.failure ?? reason), ...this.tierFields() };
  }

  private countEventByte(): void {
    this.eventBytes += 1;
    if (this.eventBytes > PROVIDER_SSE_USAGE_MAX_EVENT_BYTES) this.failure = 'oversized_event';
  }

  private processLine(): void {
    let line: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      line = decoder.decode(this.lineBuffer.subarray(0, this.lineLength));
      if (this.firstLine) {
        line = line.replace(/^\uFEFF/, '');
        this.firstLine = false;
      }
    } catch {
      this.failure = 'malformed_event';
      this.lineLength = 0;
      return;
    }
    this.lineLength = 0;
    if (line.includes('\u0000')) {
      this.failure = 'malformed_event';
      return;
    }
    if (line === '') {
      this.dispatchEvent();
      this.eventBytes = 0;
      return;
    }

    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
    } else if (field === 'event') {
      if (this.eventType !== undefined && this.eventType !== value) {
        this.failure = 'malformed_event';
        return;
      }
      this.eventType = value;
    }
  }

  private dispatchEvent(): void {
    const data = this.dataLines.join('\n');
    const eventType = this.eventType;
    const hasData = this.dataLines.length > 0;
    this.dataLines = [];
    this.eventType = undefined;
    if (!hasData || this.failure) return;
    try {
      this.acceptEvent(eventType, data);
    } catch (error) {
      this.failure = error instanceof UsageObservationError ? error.reason : 'malformed_event';
    }
  }

  private acceptEvent(eventType: string | undefined, data: string): void {
    if (this.kind === 'openai-chat-completions') {
      this.acceptOpenAiEvent(eventType, data);
      return;
    }
    this.acceptAnthropicEvent(eventType, data);
  }

  private acceptOpenAiEvent(eventType: string | undefined, data: string): void {
    if (eventType !== undefined) rejectUsage('malformed_event');
    if (data === '[DONE]') {
      if (this.openAiDone) rejectUsage('malformed_event');
      this.openAiDone = true;
      return;
    }
    if (this.openAiDone) rejectUsage('malformed_event');

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      rejectUsage('malformed_event');
    }
    const chunk = record(parsed);
    if (!chunk || !Array.isArray(chunk.choices)) rejectUsage('malformed_event');
    if (Object.hasOwn(chunk, 'object') && chunk.object !== 'chat.completion.chunk') rejectUsage('malformed_event');
    // §8.3: the chunk-level served-tier declaration (present on the final
    // usage chunk); repeats must agree or the conflict is recorded.
    this.observeTier(chunk.service_tier, Object.hasOwn(chunk, 'service_tier'));

    if (Object.hasOwn(chunk, 'usage') && chunk.usage !== null) {
      if (chunk.choices.length !== 0) rejectUsage('invalid_usage');
      const usage = parseOpenAiUsage(chunk.usage);
      if (this.openAiUsage && !usageFieldsEqual(this.openAiUsage, usage)) rejectUsage('conflicting_usage');
      this.openAiUsage = usage;
    }
  }

  private acceptAnthropicEvent(eventType: string | undefined, data: string): void {
    if (!eventType) rejectUsage('malformed_event');
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      rejectUsage('malformed_event');
    }
    const event = record(parsed);
    if (!event || event.type !== eventType) rejectUsage('malformed_event');
    if (this.anthropicStopped) rejectUsage('malformed_event');

    if (eventType === 'ping') return;
    if (eventType === 'error') rejectUsage('invalid_usage');
    if (eventType === 'message_start') {
      if (this.anthropicStarted) rejectUsage('conflicting_usage');
      const message = record(event.message);
      const usage = record(message?.usage);
      if (!message || !usage) rejectUsage('invalid_usage');
      // §8.3: Anthropic's served-tier declaration (`usage.speed`, with a
      // message-level `service_tier` accepted as the same fact).
      this.observeTier(usage.speed, Object.hasOwn(usage, 'speed'));
      if (this.profile !== null) this.observeTier(usage.service_tier, Object.hasOwn(usage, 'service_tier'));
      this.observeTier(message.service_tier, Object.hasOwn(message, 'service_tier'));
      const input = parseAnthropicInputUsage(usage, true, this.profile, message);
      if (input.inputTokens === undefined || input.cacheRead === undefined || input.cacheWrite === undefined) {
        rejectUsage('invalid_usage');
      }
      this.anthropicStarted = true;
      this.anthropicDelta = undefined;
      this.anthropicUsage = undefined;
      this.initialAnthropicInput = input as AnthropicInputUsage;
      return;
    }
    if (eventType === 'message_delta') {
      if (!this.anthropicStarted || !this.initialAnthropicInput) rejectUsage('malformed_event');
      const usage = record(event.usage);
      if (!usage) rejectUsage('invalid_usage');
      // §8.3: a delta-side tier declaration must agree with message_start.
      this.observeTier(usage.speed, Object.hasOwn(usage, 'speed'));
      if (this.profile !== null) {
        this.observeTier(usage.service_tier, Object.hasOwn(usage, 'service_tier'));
        this.observeTier(event.service_tier, Object.hasOwn(event, 'service_tier'));
      }
      const inputUpdate = parseAnthropicInputUsage(usage, false, this.profile, event);
      const mergedInput = mergeAnthropicInputUsage(this.initialAnthropicInput, inputUpdate);
      const outputTokens = requiredToken(usage, 'output_tokens');
      if (this.anthropicDelta) {
        if (
          !usageFieldsEqual(
            buildAnthropicUsage(this.anthropicDelta.input, this.anthropicDelta.outputTokens),
            buildAnthropicUsage(mergedInput, outputTokens),
          )
        ) {
          rejectUsage('conflicting_usage');
        }
      }
      this.anthropicDelta = { input: mergedInput, outputTokens };
      this.anthropicUsage = buildAnthropicUsage(mergedInput, outputTokens);
      return;
    }
    if (eventType === 'message_stop') {
      if (!this.anthropicStarted || !this.anthropicDelta) rejectUsage('malformed_event');
      this.anthropicStopped = true;
      return;
    }
    if (
      eventType === 'content_block_start' ||
      eventType === 'content_block_delta' ||
      eventType === 'content_block_stop'
    ) {
      if (!this.anthropicStarted) rejectUsage('malformed_event');
      return;
    }
    rejectUsage('malformed_event');
  }

  private initialAnthropicInput: AnthropicInputUsage | undefined;
}

function parserSelection(evidence: ProviderSseUsageEvidence): ParserKind | null {
  if (evidence.providerProtocol === 'openai' && evidence.providerOperation === 'chat.completions') {
    return 'openai-chat-completions';
  }
  if (evidence.providerProtocol === 'anthropic' && evidence.providerOperation === 'messages') {
    return 'anthropic-messages';
  }
  return null;
}

/**
 * Observes only the server-owned provider protocol/operation pair. The body is
 * a demand-driven pass-through; parsing failures only change the observation.
 */
export function observeProviderSseUsage(
  body: ReadableStream<Uint8Array>,
  evidence: ProviderSseUsageEvidence,
): ProviderSseObservedStream {
  const selectedKind = parserSelection(evidence);
  const parser = new ProviderSseUsageParser(selectedKind === null ? {} : evidence);
  const reader = body.getReader();
  let settled = false;
  let cancellationRequested = false;
  let finalObservation: ProviderSseUsageObservation | null = null;
  let resolveObservation!: (value: ProviderSseUsageObservation) => void;
  const observation = new Promise<ProviderSseUsageObservation>((resolve) => {
    resolveObservation = resolve;
  });
  const settle = (result: ProviderSseUsageObservation) => {
    if (settled) return;
    settled = true;
    finalObservation = result;
    resolveObservation(result);
  };
  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {
      // The reader may have been released while cancellation was in flight.
    }
  };
  /*
   * §4.1 seam: an out-of-band media observation (recorded by a #16/#17
   * category transport) settles immediately at EOF when the stream parser
   * found nothing — media bodies carry no SSE usage events.
   */
  const mediaUsage = evidence.mediaUsage ?? null;

  const observedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (cancellationRequested) {
            settle(parser.fail('cancelled'));
            releaseReader();
            return;
          }
          if (next.done) {
            controller.close();
            const parsed = parser.finish();
            if (parsed.state === 'unknown' && mediaUsage !== null) {
              // §4.1 seam: the out-of-band media observation carries no
              // stream tier declaration.
              settle({
                state: 'reported',
                usage: mediaUsage,
                observedServiceTier: null,
                observedServiceTierConflict: false,
              });
            } else {
              settle(parsed);
            }
            releaseReader();
            return;
          }
          if (!(next.value instanceof Uint8Array)) {
            settle(parser.fail('stream_error'));
            controller.enqueue(next.value as Uint8Array);
            return;
          }
          parser.feed(next.value);
          controller.enqueue(next.value);
        } catch (error) {
          settle(parser.fail('stream_error'));
          releaseReader();
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancellationRequested = true;
        try {
          await reader.cancel(reason);
        } finally {
          settle(parser.fail('cancelled'));
          releaseReader();
        }
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body: observedBody,
    observation,
    getObservation: () => finalObservation,
  };
}

export type ProviderSseObservedTransportResponse = PreparedEvidenceTransportResponse & {
  readonly usageObservation?: Promise<ProviderSseUsageObservation>;
};

/**
 * Decorates a transport without changing its response headers or body bytes.
 * The legacy providerUsage field becomes visible only after body EOF.
 */
export class ProviderSseUsageObservingTransport implements PreparedEvidenceTransport {
  constructor(private readonly inner: PreparedEvidenceTransport) {}

  async send(input: PreparedEvidenceTransportRequest): Promise<ProviderSseObservedTransportResponse> {
    const response = await this.inner.send(input);
    if (!response.body) return response;

    const observed = observeProviderSseUsage(response.body, {
      providerProtocol: input.evidence.providerProtocol,
      providerOperation: input.evidence.providerOperation,
    });
    return {
      ...response,
      body: observed.body,
      usageObservation: observed.observation,
      get providerUsage() {
        const result = observed.getObservation();
        return result?.state === 'reported' ? result.usage : null;
      },
      // R3 §8.2: preserve the inner transport's lazy tier evidence — reading
      // it through the original object keeps the post-EOF resolution the
      // spread above would otherwise evaluate eagerly.
      get serviceTier() {
        return response.serviceTier ?? null;
      },
    };
  }
}
