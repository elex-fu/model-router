/**
 * Batch-3 AWS Bedrock constants (port of sub2api's
 * backend/internal/service/bedrock_request.go constant tables). Everything
 * here is public client behavior — no secrets.
 */

/** Default region when the credential envelope carries no aws_region (sub2api defaultBedrockRegion). */
export const BEDROCK_DEFAULT_REGION = 'us-east-1';

/** `anthropic_version` value Bedrock InvokeModel requires in the request body. */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** The cross-region inference profile prefixes (sub2api bedrockCrossRegionPrefixes). */
export const BEDROCK_CROSS_REGION_PREFIXES: readonly string[] = Object.freeze([
  'us.',
  'eu.',
  'apac.',
  'jp.',
  'au.',
  'us-gov.',
  'global.',
]);

/** Special region value that forces the `global.` cross-region prefix. */
export const BEDROCK_GLOBAL_REGION = 'global';

/** Bedrock provider-id namespaces that mark a model id as Bedrock-native. */
export const BEDROCK_MODEL_ID_PREFIXES: readonly string[] = Object.freeze([
  'arn:',
  'anthropic.',
  'amazon.',
  'meta.',
  'mistral.',
  'cohere.',
  'ai21.',
  'deepseek.',
  'stability.',
  'writer.',
  'nova.',
]);

/** Claude version capture for model-gated request-body policies (sub2api claudeVersionRe). */
export const BEDROCK_CLAUDE_VERSION_PATTERN = /claude-(?:haiku|sonnet|opus|fable)-(\d+)(?:[-.](\d+))?/;

/** Bedrock-allowed tool_use id characters; everything else is replaced. */
export const BEDROCK_TOOL_USE_ID_INVALID_PATTERN = /[^a-zA-Z0-9_-]/g;

/** Replacement for invalid tool_use id characters. */
export const BEDROCK_TOOL_USE_ID_REPLACEMENT = '_';

/** Default thinking budget_tokens when `thinking.type: "enabled"` carries none (sub2api defaultThinkingBudgetTokens). */
export const BEDROCK_DEFAULT_THINKING_BUDGET_TOKENS = 10_000;

/** Default max_tokens injected for Claude Code bodies that omit it (sub2api defaultCCMaxTokens). */
export const BEDROCK_CC_DEFAULT_MAX_TOKENS = 81_920;

/**
 * The beta tokens Bedrock InvokeModel supports (sub2api
 * bedrockSupportedBetaTokens; AWS Bedrock docs + litellm
 * anthropic_beta_headers_config.json). Update policy: when AWS adds support,
 * extend this set (and the transforms below) in the same change.
 */
export const BEDROCK_SUPPORTED_BETA_TOKENS: ReadonlySet<string> = new Set([
  'computer-use-2025-01-24',
  'computer-use-2025-11-24',
  'context-1m-2025-08-07',
  'context-management-2025-06-27',
  'compact-2026-01-12',
  'fine-grained-tool-streaming-2025-05-14',
  'tool-search-tool-2025-10-19',
  'tool-examples-2025-10-29',
]);

/** The context-management beta token key (drives the context_management strip policy). */
export const BEDROCK_CONTEXT_MANAGEMENT_BETA_TOKEN = 'context-management-2025-06-27';

/**
 * Bedrock-specific beta token transforms: Anthropic-direct headers Bedrock
 * Invoke replaces with a Bedrock-specific token (sub2api
 * bedrockBetaTokenTransforms).
 */
export const BEDROCK_BETA_TOKEN_TRANSFORMS: Readonly<Record<string, string>> = Object.freeze({
  'advanced-tool-use-2025-11-20': 'tool-search-tool-2025-10-19',
});

/**
 * The tool-search tool types (sub2api isBedrockToolSearchType): their
 * presence in `tools` triggers the tool-search beta injection.
 */
export const BEDROCK_TOOL_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'tool_search_tool_regex_20251119',
  'tool_search_tool_bm25_20251119',
]);

/** The beta token auto-injected for computer-use tools. */
export const BEDROCK_COMPUTER_USE_BETA_TOKEN = 'computer-use-2025-11-24';

/** The Anthropic-direct advanced-tool-use token (transformed for Bedrock). */
export const BEDROCK_ADVANCED_TOOL_USE_BETA_TOKEN = 'advanced-tool-use-2025-11-20';

/** The Bedrock tool-search token (the advanced-tool-use replacement). */
export const BEDROCK_TOOL_SEARCH_BETA_TOKEN = 'tool-search-tool-2025-10-19';

/** Auto-linked with tool-search-tool (sub2api filterBedrockBetaTokens). */
export const BEDROCK_TOOL_EXAMPLES_BETA_TOKEN = 'tool-examples-2025-10-29';

/**
 * Default 429 cooldown when a Bedrock ThrottlingException carries no
 * retry-after signal (the gemini unknown-tier default precedent).
 */
export const BEDROCK_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** 429 retry deadlines further than this from now are rejected as implausible. */
export const BEDROCK_RATE_LIMIT_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** AWS EventStream frame prelude length: total(4) + headers(4) + prelude_crc(4). */
export const EVENTSTREAM_PRELUDE_BYTES = 12;

/** Minimum frame length: prelude + message_crc(4). */
export const EVENTSTREAM_MIN_FRAME_BYTES = 16;

/** Maximum accepted frame length (guards against a corrupt length prefix). */
export const EVENTSTREAM_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** EventStream header value types (the wire spec's enum). */
export const EVENTSTREAM_HEADER_VALUE_TYPE = {
  BOOL_TRUE: 0,
  BOOL_FALSE: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  BYTES: 6,
  STRING: 7,
  TIMESTAMP: 8,
  UUID: 9,
} as const;
