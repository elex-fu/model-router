import { createHash, randomUUID } from 'node:crypto';

export interface RequestClassification {
  isWarmup: boolean;
  isCompact: boolean;
  isSubagent: boolean;
  isUserInitiated: boolean;
}

function sha256ToUuid(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  // Convert first 16 bytes to UUID v4 format
  const parts = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ];
  return parts.join('-');
}

export function classifyRequest(body: any): RequestClassification {
  const messages = body?.messages;
  if (!Array.isArray(messages)) {
    return { isWarmup: false, isCompact: false, isSubagent: false, isUserInitiated: true };
  }

  // Warmup: very short user message (single char or "warmup")
  const lastUser = messages.findLast((m: any) => m?.role === 'user');
  const lastUserContent = extractTextContent(lastUser);
  const isWarmup = lastUserContent.length <= 2 || /warmup/i.test(lastUserContent);

  // Compact: message count is high (compact operation sends many messages)
  const isCompact = messages.length > 20;

  // Subagent: system prompt mentions subagent or metadata indicates it
  const system = body?.system;
  const systemText =
    typeof system === 'string' ? system : Array.isArray(system) ? system.map((b: any) => b?.text ?? '').join('') : '';
  const isSubagent = /subagent|sub-agent/i.test(systemText);

  // User-initiated: last message is from user and is substantial
  const lastMsg = messages[messages.length - 1];
  const isUserInitiated = lastMsg?.role === 'user' && !isWarmup;

  return { isWarmup, isCompact, isSubagent, isUserInitiated };
}

function extractTextContent(msg: any): string {
  if (!msg) return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('');
  }
  return '';
}

/** Merge adjacent [tool_result, text] blocks into [tool_result(含text)] to reduce message count. */
export function mergeToolResults(body: any): void {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    const merged: any[] = [];
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block?.type === 'tool_result' && i + 1 < msg.content.length && msg.content[i + 1]?.type === 'text') {
        const textBlock = msg.content[i + 1];
        const originalContent = block.content;
        if (typeof originalContent === 'string') {
          block.content = originalContent + '\n' + textBlock.text;
        } else if (Array.isArray(originalContent)) {
          block.content = [...originalContent, { type: 'text', text: textBlock.text }];
        } else {
          block.content = textBlock.text;
        }
        merged.push(block);
        i++; // skip text block
      } else {
        merged.push(block);
      }
    }
    msg.content = merged;
  }
}

/** Strip thinking/redacted_thinking blocks from assistant messages (Copilot rejects them). */
export function stripThinkingBlocks(body: any): void {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((block: any) => {
      const bt = block?.type;
      return bt !== 'thinking' && bt !== 'redacted_thinking';
    });
  }
}

/** Downgrade model for warmup requests to reduce premium billing. */
export function downgradeWarmupModel(body: any, warmupModel: string = 'gpt-4o-mini'): void {
  if (body?._isWarmup) {
    body.model = warmupModel;
  }
}

/**
 * Inject deterministic request/interaction IDs for Copilot billing deduplication.
 * Uses SHA256(session_id + lastUserContent) -> UUID v4.
 */
export function injectDeterministicIds(body: any, headers: Headers): void {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;

  const sessionId =
    headers.get('x-claude-code-session-id') ??
    body?.metadata?.session_id ??
    body?.metadata?.user_id ??
    'default-session';

  const lastUser = messages.findLast((m: any) => m?.role === 'user');
  const lastUserContent = extractTextContent(lastUser);

  const requestId = sha256ToUuid(sessionId + lastUserContent);
  const interactionId = sha256ToUuid('interaction:' + sessionId);

  headers.set('x-request-id', requestId);
  headers.set('x-interaction-id', interactionId);
}

/** Body-only optimizations to run before bridge transform. */
export function optimizeCopilotBody(body: any): void {
  const classification = classifyRequest(body);
  if (classification.isWarmup) {
    body._isWarmup = true;
    downgradeWarmupModel(body);
  }
  stripThinkingBlocks(body);
  mergeToolResults(body);
}

/** Header-only optimizations to run after headers are built. */
export function optimizeCopilotHeaders(body: any, headers: Headers): void {
  injectDeterministicIds(body, headers);
}
