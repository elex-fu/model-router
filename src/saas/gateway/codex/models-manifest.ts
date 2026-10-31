/**
 * Codex models manifest (P1-4, docs/standalone-relay-capability-plan-2026-10-30.md
 * Codex parity follow-up). Pure data + projection over the upstream
 * `codex-rs/models-manager/models.json` release artifact — the same source
 * the Codex CLI itself consults. No network, no PG.
 *
 * GENERATED payload: the DEFAULT entries below were extracted from
 * openai/codex tag rust-v0.146.0 (Apache-2.0) by hand on 2026-10-31; refresh
 * them by re-fetching the artifact (see the instructions asset regenerator's
 * source workflow) and updating DEFAULT_CODEX_MODEL_MANIFEST together with
 * CODEX_MANIFEST_SOURCE_REF.
 */

export const CODEX_MANIFEST_SOURCE_REF = 'rust-v0.146.0';

/** The manifest subset the gateway advertises and meters against. */
export interface CodexModelManifestEntry {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly inputModalities: readonly string[];
  readonly defaultReasoningLevel: string | null;
  readonly supportedReasoningEfforts: readonly string[];
  readonly applyPatchToolType: string | null;
  readonly webSearchToolType: string | null;
  readonly toolMode: string | null;
  readonly useResponsesLite: boolean;
  readonly supportsParallelToolCalls: boolean;
  readonly preferWebsockets: boolean;
  readonly supportsImageDetailOriginal: boolean;
}

interface RawManifestEntry {
  readonly slug?: unknown;
  readonly display_name?: unknown;
  readonly description?: unknown;
  readonly context_window?: unknown;
  readonly input_modalities?: unknown;
  readonly default_reasoning_level?: unknown;
  readonly supported_reasoning_levels?: unknown;
  readonly apply_patch_tool_type?: unknown;
  readonly web_search_tool_type?: unknown;
  readonly tool_mode?: unknown;
  readonly use_responses_lite?: unknown;
  readonly supports_parallel_tool_calls?: unknown;
  readonly prefer_websockets?: unknown;
  readonly supports_image_detail_original?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

/**
 * Projects one raw models.json entry into the gateway manifest shape.
 * Returns null when the entry lacks a slug (malformed upstream rows are
 * skipped, never guessed).
 */
export function projectCodexManifestEntry(raw: unknown): CodexModelManifestEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as RawManifestEntry;
  const slug = text(record.slug);
  if (slug === null) return null;
  const efforts = Array.isArray(record.supported_reasoning_levels)
    ? record.supported_reasoning_levels
        .map((level) =>
          typeof level === 'object' && level !== null ? (level as { effort?: unknown }).effort : undefined,
        )
        .filter((effort): effort is string => typeof effort === 'string')
    : [];
  return {
    slug,
    displayName: text(record.display_name) ?? slug,
    description: text(record.description) ?? '',
    contextWindow: typeof record.context_window === 'number' ? record.context_window : 0,
    inputModalities: Array.isArray(record.input_modalities)
      ? record.input_modalities.filter((modality): modality is string => typeof modality === 'string')
      : [],
    defaultReasoningLevel: text(record.default_reasoning_level),
    supportedReasoningEfforts: efforts,
    applyPatchToolType: text(record.apply_patch_tool_type),
    webSearchToolType: text(record.web_search_tool_type),
    toolMode: text(record.tool_mode),
    useResponsesLite: booleanOrFalse(record.use_responses_lite),
    supportsParallelToolCalls: booleanOrFalse(record.supports_parallel_tool_calls),
    preferWebsockets: booleanOrFalse(record.prefer_websockets),
    supportsImageDetailOriginal: booleanOrFalse(record.supports_image_detail_original),
  };
}

/** Projects the whole models.json document; malformed rows are dropped. */
export function projectCodexManifest(document: unknown): readonly CodexModelManifestEntry[] {
  if (typeof document !== 'object' || document === null) return [];
  const models = (document as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const projected = models
    .map((entry) => projectCodexManifestEntry(entry))
    .filter((entry): entry is CodexModelManifestEntry => entry !== null);
  return projected;
}

const DEFAULT_MANIFEST_DOCUMENT: ReadonlyArray<RawManifestEntry> = [
  {
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'low',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.6-terra',
    display_name: 'GPT-5.6-Terra',
    description: 'Balanced frontier model for everyday coding.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.6-luna',
    display_name: 'GPT-5.6-Luna',
    description: 'Deliberate frontier model for deep problem solving.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.5',
    display_name: 'GPT-5.5',
    description: 'Latest general-purpose model with the full tool suite.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.4',
    display_name: 'GPT-5.4',
    description: 'Stable general-purpose coding model.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.4-mini',
    display_name: 'GPT-5.4-Mini',
    description: 'Fast, efficient coding model for routine tasks.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'gpt-5.2',
    display_name: 'GPT-5.2',
    description: 'Previous-generation coding model.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
  {
    slug: 'codex-auto-review',
    display_name: 'Codex Auto Review',
    description: 'Usage probe model for quota queries.',
    context_window: 272000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    prefer_websockets: true,
    supports_image_detail_original: true,
  },
];

/**
 * The checked-in default manifest (upstream 0.146 release). The catalog
 * placeholder set (`CODEX_PLACEHOLDER_MODELS`) can migrate onto this as the
 * richer source once the serving surface consumes the extra fields.
 */
export const DEFAULT_CODEX_MODEL_MANIFEST: readonly CodexModelManifestEntry[] = Object.freeze(
  DEFAULT_MANIFEST_DOCUMENT.map((entry) => projectCodexManifestEntry(entry)).filter(
    (entry): entry is CodexModelManifestEntry => entry !== null,
  ),
);
