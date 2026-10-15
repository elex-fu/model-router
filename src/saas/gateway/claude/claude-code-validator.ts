/**
 * R5 step 4 — Claude Code client authenticity validator (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5 第四步; port of
 * sub2api's claude_code_validator.go, the claude-relay-service strategy).
 * PURE module: no wiring to group enforcement yet — the R1 follow-up pairs
 * this with the `claude_code_only` group flag so genuine Claude Code traffic
 * enters the subscription pool and third-party-client traffic routes to the
 * fallback group (third-party fingerprints burn subscription accounts).
 *
 * Strategy (all steps must pass for /v1/messages traffic):
 * 1. User-Agent `^claude-cli/\\d+\\.\\d+\\.\\d+` (case-insensitive) — required;
 * 2. non-messages paths and count_tokens pass on UA alone;
 * 3. max_tokens=1 connectivity probes pass on UA alone;
 * 4. messages traffic: system-prompt similarity ≥ 0.5 (Dice coefficient
 *    against the official templates) OR a billing attribution block
 *    (x-anthropic-billing-header + cc_entrypoint), plus the x-app /
 *    anthropic-beta / anthropic-version headers and a well-formed
 *    metadata.user_id.
 */

/** UA pattern: official CLI only, case-insensitive. */
export const CLAUDE_CODE_UA_PATTERN = /^claude-cli\/\d+\.\d+\.\d+/i;

/** System prompt similarity threshold (claude-relay-service default). */
export const CLAUDE_CODE_SYSTEM_PROMPT_THRESHOLD = 0.5;

/** The official Claude Code system prompt templates (best-match wins). */
export const CLAUDE_CODE_SYSTEM_PROMPTS: readonly string[] = Object.freeze([
  // Primary
  "You are Claude Code, Anthropic's official CLI for Claude.",
  // Agent SDK
  'You are a Claude agent, built on Anthropic’s Claude Agent SDK.',
  // Compact Agent SDK
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  // Explore agent
  "You are a file search specialist for Claude Code, Anthropic's official CLI for Claude.",
  // Compact (conversation summarization)
  'You are a helpful AI assistant tasked with summarizing conversations.',
  // Secondary (key part of the long prompt)
  'You are an interactive CLI tool that helps users',
]);

/** Billing attribution block identification markers. */
export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header';
export const CLAUDE_CODE_ENTRYPOINT_MARKER = 'cc_entrypoint=';

/** The input the validator needs: headers plus the parsed messages body. */
export interface ClaudeCodeValidationInput {
  readonly userAgent: string | null;
  readonly path: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ClaudeCodeValidationResult {
  readonly valid: boolean;
  /** Which step failed (diagnostics only; never surfaced to clients). */
  readonly reason:
    | 'ua-mismatch'
    | 'system-prompt-mismatch'
    | 'missing-x-app'
    | 'missing-anthropic-beta'
    | 'missing-anthropic-version'
    | 'missing-metadata-user-id'
    | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  const direct = headers?.[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

/** Normalizes prompt text: all whitespace runs collapse to single spaces. */
export function normalizePromptText(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Sørensen–Dice coefficient over character bigrams — the string-similarity
 * library's algorithm: 2·|A∩B| / (|A| + |B|) with multiset intersection and
 * total (duplicate-inclusive) bigram counts, lowercased first (the reference
 * lowercases inside its bigram extraction).
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;
  const bigramsA = new Map<string, number>();
  const lowerA = a.toLowerCase();
  for (let index = 0; index < lowerA.length - 1; index += 1) {
    const bigram = lowerA.slice(index, index + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) ?? 0) + 1);
  }
  const bigramsB = new Map<string, number>();
  const lowerB = b.toLowerCase();
  for (let index = 0; index < lowerB.length - 1; index += 1) {
    const bigram = lowerB.slice(index, index + 2);
    bigramsB.set(bigram, (bigramsB.get(bigram) ?? 0) + 1);
  }
  let intersection = 0;
  for (const [bigram, countA] of bigramsA) {
    const countB = bigramsB.get(bigram);
    if (countB !== undefined) intersection += Math.min(countA, countB);
  }
  let totalA = 0;
  for (const count of bigramsA.values()) totalA += count;
  let totalB = 0;
  for (const count of bigramsB.values()) totalB += count;
  return (2 * intersection) / (totalA + totalB);
}

/** Best similarity score across the official templates (pre-normalized). */
export function bestClaudeCodeSimilarityScore(text: string): number {
  const normalized = normalizePromptText(text);
  let best = 0;
  for (const template of CLAUDE_CODE_SYSTEM_PROMPTS) {
    const score = diceCoefficient(normalized, normalizePromptText(template));
    if (score > best) best = score;
  }
  return best;
}

function isMessagesCountTokensPath(path: string): boolean {
  return path.endsWith('/messages/count_tokens');
}

function isMaxTokensOneBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return body.max_tokens === 1;
}

/**
 * Whether one system block identifies Claude Code: the billing attribution
 * block (case-sensitive prefix — the block is canonically lowercase) or a
 * template similarity at or above the threshold.
 */
function systemBlockIdentifiesClaudeCode(text: string): boolean {
  if (text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX) && text.includes(CLAUDE_CODE_ENTRYPOINT_MARKER)) {
    return true;
  }
  return bestClaudeCodeSimilarityScore(text) >= CLAUDE_CODE_SYSTEM_PROMPT_THRESHOLD;
}

/** Whether the body carries a Claude Code system prompt (any block matches). */
export function hasClaudeCodeSystemPrompt(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (typeof body.model !== 'string') return false;
  if (!Array.isArray(body.system)) return false;
  for (const entry of body.system) {
    if (!isRecord(entry)) continue;
    const text = entry.text;
    if (typeof text !== 'string' || text.length === 0) continue;
    if (systemBlockIdentifiesClaudeCode(text)) return true;
  }
  return false;
}

/** metadata.user_id shape: non-empty (the account/session-stable id). */
function hasValidMetadataUserId(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const metadata = body.metadata;
  if (!isRecord(metadata)) return false;
  const userId = metadata.user_id;
  return typeof userId === 'string' && userId.length > 0;
}

/**
 * Validates one inbound request's Claude Code authenticity. Pure: same
 * input always yields the same verdict; no IO, no clock, no logging.
 */
export function validateClaudeCodeClient(input: ClaudeCodeValidationInput): ClaudeCodeValidationResult {
  const userAgent = input.userAgent ?? '';
  if (!CLAUDE_CODE_UA_PATTERN.test(userAgent)) {
    return { valid: false, reason: 'ua-mismatch' };
  }
  const path = input.path ?? '';
  // Non-messages paths and count_tokens are official auxiliary surfaces:
  // the UA alone already identifies the CLI.
  if (!path.includes('messages') || isMessagesCountTokensPath(path)) {
    return { valid: true, reason: null };
  }
  // max_tokens=1 connectivity/model-switch probes carry no system prompt.
  if (isMaxTokensOneBody(input.body)) {
    return { valid: true, reason: null };
  }
  if (!hasClaudeCodeSystemPrompt(input.body)) {
    return { valid: false, reason: 'system-prompt-mismatch' };
  }
  if ((headerValue(input.headers, 'x-app') ?? '').length === 0) {
    return { valid: false, reason: 'missing-x-app' };
  }
  if ((headerValue(input.headers, 'anthropic-beta') ?? '').length === 0) {
    return { valid: false, reason: 'missing-anthropic-beta' };
  }
  if ((headerValue(input.headers, 'anthropic-version') ?? '').length === 0) {
    return { valid: false, reason: 'missing-anthropic-version' };
  }
  if (!hasValidMetadataUserId(input.body)) {
    return { valid: false, reason: 'missing-metadata-user-id' };
  }
  return { valid: true, reason: null };
}
