/**
 * Content moderation text extraction (reference: sub2api
 * content_moderation_input.go) for the three gateway protocols.
 *
 * Semantics: take the LAST user message from the client body —
 * - anthropic (/v1/messages): last `messages[]` entry whose role is `user`,
 *   skipping trailing `system` role entries (the reference keeps the latest
 *   user turn when a system reminder follows it);
 * - openai (/v1/chat/completions): last `messages[]` entry with role `user`;
 * - responses (/v1/responses): `input` as a string, or the last input item
 *   that represents user text (role `user` or role-less text items).
 *
 * Keyword checks see reminder blocks as ordinary user text
 * (`filterReminders: false`); semantic moderation drops
 * `<system-reminder>` content (`filterReminders: true`), matching the
 * reference split.
 */

import { createHash } from 'node:crypto';

export type ModerationProtocol = 'anthropic' | 'openai' | 'responses' | 'gemini';

/** Maximum runes of extracted text forwarded to the moderation API. */
export const MAX_MODERATION_INPUT_RUNES = 12000;

/** Maximum runes of the persisted input excerpt. */
export const MAX_MODERATION_EXCERPT_RUNES = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addText(parts: string[], text: unknown, filterReminders: boolean): void {
  if (typeof text !== 'string') return;
  const trimmed = text.trim();
  if (trimmed === '') return;
  if (filterReminders && trimmed.includes('<system-reminder>')) return;
  parts.push(trimmed);
}

function normalizeText(text: string): string {
  return text
    .trim()
    .split(/\s+/u)
    .filter((field) => field !== '')
    .join(' ');
}

export function trimRunes(text: string, max: number): string {
  if (max <= 0) return '';
  const runes = [...text];
  if (runes.length <= max) return text;
  return runes.slice(0, max).join('');
}

/**
 * Recursively collect text parts (and nested `content`) from an OpenAI-style
 * or Anthropic-style content value.
 */
function collectContentValue(value: unknown, parts: string[], filterReminders: boolean): void {
  if (typeof value === 'string') {
    addText(parts, value, filterReminders);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContentValue(item, parts, filterReminders);
    return;
  }
  if (!isRecord(value)) return;
  const type = typeof value.type === 'string' ? value.type.toLowerCase().trim() : '';
  switch (type) {
    case '':
    case 'text':
    case 'input_text':
    case 'message':
      if (typeof value.text === 'string') {
        addText(parts, value.text, filterReminders);
      }
      if (value.content !== undefined) collectContentValue(value.content, parts, filterReminders);
      break;
    default:
      break;
  }
}

function collectLastRoleMessage(
  messages: unknown,
  role: 'user',
  parts: string[],
  filterReminders: boolean,
  skipTrailingSystem: boolean,
): void {
  if (!Array.isArray(messages) || messages.length === 0) return;
  let last = messages.length - 1;
  if (skipTrailingSystem) {
    while (
      last >= 0 &&
      isRecord(messages[last]) &&
      typeof messages[last].role === 'string' &&
      messages[last].role.trim().toLowerCase() === 'system'
    ) {
      last--;
    }
  }
  const entry = messages[last];
  if (!isRecord(entry)) return;
  const entryRole = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
  if (entryRole !== role) return;
  const candidate: string[] = [];
  collectContentValue(entry.content, candidate, filterReminders);
  if (normalizeText(candidate.join('\n')) === '') return;
  parts.push(...candidate);
}

function responseItemHasText(item: Record<string, unknown>, filterReminders: boolean): boolean {
  const parts: string[] = [];
  collectContentValue(item.content, parts, filterReminders);
  if (item.type === 'input_text' || typeof item.text === 'string') {
    collectContentValue(item, parts, filterReminders);
  }
  return normalizeText(parts.join('\n')) !== '';
}

function isResponsesUserTextItem(item: unknown, filterReminders: boolean): boolean {
  if (!isRecord(item)) return false;
  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (role === 'user') return responseItemHasText(item, filterReminders);
  if (role !== '') return false;
  return responseItemHasText(item, filterReminders);
}

function collectLastResponsesInput(input: unknown, parts: string[], filterReminders: boolean): void {
  if (typeof input === 'string') {
    addText(parts, input, filterReminders);
    return;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) return;
    const last = input[input.length - 1];
    if (!isResponsesUserTextItem(last, filterReminders)) return;
    collectContentValue(isRecord(last) ? last.content : undefined, parts, filterReminders);
    if (isRecord(last) && (last.type === 'input_text' || typeof last.text === 'string')) {
      collectContentValue(last, parts, filterReminders);
    }
    return;
  }
  if (isRecord(input)) {
    if (!isResponsesUserTextItem(input, filterReminders)) return;
    collectContentValue(input.content, parts, filterReminders);
    if (input.type === 'input_text' || typeof input.text === 'string') {
      collectContentValue(input, parts, filterReminders);
    }
  }
}

/**
 * R2 §7.2 native Gemini inbound: take the LAST `contents[]` entry whose
 * role is `user` and collect its `parts[].text` values (the same
 * last-user-turn semantics as the other protocols; `model` turns and
 * function-call parts carry no moderation text).
 */
function collectLastGeminiContent(contents: unknown, parts: string[], filterReminders: boolean): void {
  if (!Array.isArray(contents) || contents.length === 0) return;
  let last: Record<string, unknown> | null = null;
  for (const entry of contents) {
    if (!isRecord(entry)) continue;
    const role = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
    if (role !== 'user') continue;
    last = entry;
  }
  if (last === null) return;
  const candidate: string[] = [];
  if (Array.isArray(last.parts)) {
    for (const part of last.parts) {
      if (isRecord(part) && typeof part.text === 'string') {
        addText(candidate, part.text, filterReminders);
      }
    }
  }
  if (normalizeText(candidate.join('\n')) === '') return;
  parts.push(...candidate);
}

/**
 * Extract the moderation text for a protocol from the already-parsed client
 * body. Returns the whitespace-normalized text (possibly empty).
 */
export function extractModerationText(
  protocol: ModerationProtocol,
  body: Record<string, unknown>,
  filterReminders: boolean,
): string {
  const parts: string[] = [];
  switch (protocol) {
    case 'anthropic':
      collectLastRoleMessage(body.messages, 'user', parts, filterReminders, true);
      break;
    case 'openai':
      collectLastRoleMessage(body.messages, 'user', parts, filterReminders, false);
      break;
    case 'responses':
      collectLastResponsesInput(body.input, parts, filterReminders);
      break;
    case 'gemini':
      collectLastGeminiContent(body.contents, parts, filterReminders);
      break;
  }
  return normalizeText(parts.join('\n'));
}

/** Stable input hash for the pre-hash blocklist (reference: `text:` prefix). */
export function moderationInputHash(text: string): string {
  const hash = createHash('sha256');
  hash.update('text:');
  hash.update(text);
  return hash.digest('hex');
}
