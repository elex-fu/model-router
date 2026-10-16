/**
 * Client dateline fingerprint normalization (port of sub2api's
 * backend/internal/pkg/anthropicfp/dateline.go, gateway-forward placement).
 *
 * Some Anthropic clients, when they detect a non-official base URL, watermark
 * the "Today's date is YYYY-MM-DD." sentence they inject into the request.
 * Two steganographic signals are known in the wild:
 *
 * - the apostrophe in `Today's` is rotated through four code points
 *   (U+0027, U+2019, U+02BC, U+02B9), encoding 2 bits;
 * - the date separator is either `-` or `/`, encoding 1 more bit.
 *
 * `normalizeClaudeDatelineBody` rewrites every such sentence back to the
 * canonical ASCII form (ASCII apostrophe + hyphen separator) before the body
 * is forwarded to api.anthropic.com, erasing the watermark. Pure functions,
 * zero dependencies, copy-on-write: an unchanged body is returned by
 * reference and no input value is ever mutated.
 *
 * Scope (mirroring where genuine clients place the sentence — sub2api
 * semantics, sub2api default enabled):
 * - `system` string, or the `.text` of each text-typed block in `system` —
 *   full text scan;
 * - `messages[i].content` string or text-typed blocks — but ONLY the
 *   substrings inside `<system-reminder>...</system-reminder>` tags (past
 *   the first turn the dateline lives in the cached system-reminder block).
 *   Free user prose, tool_use.input, tool_result.content, code blocks and
 *   shell commands that merely mention a date are never touched.
 */

export type ClaudeDatelineApostropheVariant = 'ascii' | 'u2019' | 'u02bc' | 'u02b9';

export type ClaudeDatelineSeparator = '-' | '/';

/** What a single rewrite normalized, for observability/tests. */
export interface ClaudeDatelineHit {
  readonly apostropheVariant: ClaudeDatelineApostropheVariant;
  readonly dateSeparator: ClaudeDatelineSeparator;
}

/**
 * One backreference keeps the two date separators in agreement, so a mixed
 * string like `2026-07/01` never matches — this is what filters out
 * user-authored prose from the genuine fingerprinted sentence.
 */
const DATELINE_PATTERN = /Today(['’ʼʹ])s date is (\d{4})([-/])(\d{2})\3(\d{2})\./g;

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const APOSTROPHE_VARIANTS: Readonly<Record<string, ClaudeDatelineApostropheVariant>> = Object.freeze({
  "'": 'ascii',
  '’': 'u2019',
  ʼ: 'u02bc',
  ʹ: 'u02b9',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apostropheVariant(apostrophe: string): ClaudeDatelineApostropheVariant {
  return APOSTROPHE_VARIANTS[apostrophe] ?? 'ascii';
}

export interface ClaudeDatelineTextResult {
  /** The possibly-rewritten text; the original reference when unchanged. */
  readonly text: string;
  readonly hits: readonly ClaudeDatelineHit[];
}

/**
 * Replaces every fingerprinted dateline sentence in `text` with its canonical
 * ASCII form. Canonical input is returned by reference with zero hits.
 */
export function normalizeDatelineText(text: string): ClaudeDatelineTextResult {
  if (typeof text !== 'string' || !text.includes('date is ')) return { text, hits: [] };
  DATELINE_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(DATELINE_PATTERN)];
  if (matches.length === 0) return { text, hits: [] };

  const hits: ClaudeDatelineHit[] = [];
  let out = '';
  let prev = 0;
  let changed = false;
  for (const match of matches) {
    const canonical = `Today's date is ${match[2]}-${match[4]}-${match[5]}.`;
    if (canonical === match[0]) continue; // Already canonical: no rewrite, no hit.
    const start = match.index ?? 0;
    out += text.slice(prev, start) + canonical;
    prev = start + match[0].length;
    changed = true;
    hits.push({
      apostropheVariant: apostropheVariant(match[1] ?? "'"),
      dateSeparator: match[3] === '/' ? '/' : '-',
    });
  }
  if (!changed) return { text, hits: [] };
  return { text: out + text.slice(prev), hits };
}

/**
 * Scans only the `<system-reminder>` blocks inside `text`; everything outside
 * them is preserved verbatim so user prose is never rewritten.
 */
function normalizeSystemReminderScopedText(text: string): ClaudeDatelineTextResult {
  if (typeof text !== 'string' || !text.includes('<system-reminder>')) return { text, hits: [] };
  SYSTEM_REMINDER_PATTERN.lastIndex = 0;
  const blocks = [...text.matchAll(SYSTEM_REMINDER_PATTERN)];
  if (blocks.length === 0) return { text, hits: [] };

  const hits: ClaudeDatelineHit[] = [];
  let out = '';
  let prev = 0;
  let changed = false;
  for (const block of blocks) {
    const start = block.index ?? 0;
    const raw = block[0];
    out += text.slice(prev, start);
    const normalized = normalizeDatelineText(raw);
    out += normalized.text;
    hits.push(...normalized.hits);
    prev = start + raw.length;
    if (normalized.text !== raw) changed = true;
  }
  if (!changed) return { text, hits: [] };
  return { text: out + text.slice(prev), hits };
}

/**
 * Rewrites every fingerprinted dateline sentence in an Anthropic
 * `/v1/messages` request body back to the canonical ASCII form. Copy-on-write
 *: the input is never mutated and an unchanged body is returned by
 * reference.
 */
export function normalizeClaudeDatelineBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(body)) return body;
  let next: Record<string, unknown> | undefined;
  let changed = false;

  const system = body.system;
  if (typeof system === 'string') {
    const normalized = normalizeDatelineText(system);
    if (normalized.text !== system) {
      next ??= { ...body };
      next.system = normalized.text;
      changed = true;
    }
  } else if (Array.isArray(system)) {
    let blockChanged = false;
    const mappedSystem = system.map((item) => {
      if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return item;
      const normalized = normalizeDatelineText(item.text);
      if (normalized.text === item.text) return item;
      blockChanged = true;
      return { ...item, text: normalized.text };
    });
    if (blockChanged) {
      next ??= { ...body };
      next.system = mappedSystem;
      changed = true;
    }
  }

  if (Array.isArray(body.messages)) {
    let messageChanged = false;
    const mappedMessages = body.messages.map((message) => {
      if (!isRecord(message)) return message;
      const content = message.content;
      if (typeof content === 'string') {
        const normalized = normalizeSystemReminderScopedText(content);
        if (normalized.text === content) return message;
        messageChanged = true;
        return { ...message, content: normalized.text };
      }
      if (!Array.isArray(content)) return message;
      let blockChanged = false;
      const mappedContent = content.map((block) => {
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
        const normalized = normalizeSystemReminderScopedText(block.text);
        if (normalized.text === block.text) return block;
        blockChanged = true;
        return { ...block, text: normalized.text };
      });
      if (!blockChanged) return message;
      messageChanged = true;
      return { ...message, content: mappedContent };
    });
    if (messageChanged) {
      next ??= next === undefined ? { ...body } : next;
      next.messages = mappedMessages;
      changed = true;
    }
  }

  return changed && next !== undefined ? next : body;
}
