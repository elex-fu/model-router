/**
 * Thinking signature rectifier.
 *
 * When an Anthropic upstream returns a thinking signature error, automatically
 * strip thinking/redacted_thinking blocks and signatures, then retry once.
 */

export interface RectifyResult {
  applied: boolean;
  body: any;
}

/** Detect whether an upstream error message is a thinking signature error. */
export function isThinkingSignatureError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes('invalid') &&
      lower.includes('signature') &&
      lower.includes('thinking') &&
      lower.includes('block')) ||
    (lower.includes('thought signature') &&
      (lower.includes('not valid') || lower.includes('invalid'))) ||
    lower.includes('must start with a thinking block') ||
    (lower.includes('expected') &&
      (lower.includes('thinking') || lower.includes('redacted_thinking')) &&
      lower.includes('found') &&
      lower.includes('tool_use')) ||
    (lower.includes('signature') && lower.includes('field required')) ||
    (lower.includes('signature') &&
      lower.includes('extra inputs are not permitted')) ||
    ((lower.includes('thinking') || lower.includes('redacted_thinking')) &&
      lower.includes('cannot be modified')) ||
    lower.includes('非法请求') ||
    lower.includes('illegal request') ||
    lower.includes('invalid request')
  );
}

/** Detect whether an upstream error is a thinking budget constraint error. */
export function isThinkingBudgetError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('budget_tokens') &&
    lower.includes('thinking') &&
    lower.includes('1024')
  );
}

/**
 * Fix thinking budget constraints by raising budget_tokens to at least 32000
 * and ensuring max_tokens is large enough.
 */
export function rectifyThinkingBudget(body: any): RectifyResult {
  const cloned = structuredClone(body);
  const THINKING_BUDGET = 32000;
  const MAX_TOKENS_FLOOR = 32001;

  if (!cloned.thinking || typeof cloned.thinking !== 'object') {
    cloned.thinking = { type: 'enabled' };
  } else {
    cloned.thinking = { ...cloned.thinking, type: 'enabled' };
  }
  cloned.thinking.budget_tokens = THINKING_BUDGET;

  if (typeof cloned.max_tokens === 'number' && cloned.max_tokens < MAX_TOKENS_FLOOR) {
    cloned.max_tokens = 64000;
  }

  return { applied: true, body: cloned };
}

/**
 * Remove thinking/redacted_thinking blocks and stray signature fields from
 * an Anthropic-format request body.
 */
export function rectifyAnthropicRequest(body: any): RectifyResult {
  const cloned = structuredClone(body);
  let applied = false;

  const messages = cloned.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg?.content;
      if (!Array.isArray(content)) continue;

      const newContent: any[] = [];
      for (const block of content) {
        const bt = block?.type;
        if (bt === 'thinking' || bt === 'redacted_thinking') {
          applied = true;
          continue;
        }
        if (block && typeof block === 'object' && 'signature' in block) {
          delete block.signature;
          applied = true;
        }
        newContent.push(block);
      }
      if (newContent.length !== content.length) {
        msg.content = newContent;
      }
    }
  }

  if (shouldRemoveTopLevelThinking(cloned)) {
    delete cloned.thinking;
    delete cloned.output_config;
    applied = true;
  }

  return { applied, body: cloned };
}

function shouldRemoveTopLevelThinking(body: any): boolean {
  const thinkingType = body?.thinking?.type;
  if (thinkingType !== 'enabled' && thinkingType !== 'adaptive') return false;

  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;

  // Check if any assistant message contains thinking/redacted_thinking blocks.
  // If the conversation already has thinking blocks, keep top-level thinking
  // and let block-level cleanup handle the issue.
  const hasThinkingBlocks = messages.some((msg: any) => {
    if (msg?.role !== 'assistant') return false;
    const content = msg.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (b: any) => b?.type === 'thinking' || b?.type === 'redacted_thinking'
    );
  });
  if (hasThinkingBlocks) {
    // If there are thinking blocks but the last assistant doesn't start with one,
    // or there's a tool_use mismatch, we still need to remove top-level thinking.
    return shouldRemoveTopLevelThinkingLegacy(body, messages);
  }

  // No thinking blocks in conversation → upstream likely rejects the thinking
  // parameter outright (e.g. Kimi). Only strip 'enabled' thinking here;
  // 'adaptive' is softer and upstreams may still accept it.
  return thinkingType === 'enabled';
}

/** Original cc-switch-aligned logic for tool_use + missing thinking prefix. */
function shouldRemoveTopLevelThinkingLegacy(body: any, messages: any[]): boolean {
  const thinkingType = body?.thinking?.type;
  if (thinkingType !== 'enabled') return false;

  let lastAssistant: any = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = messages[i];
      break;
    }
  }
  if (!lastAssistant) return false;

  const content = lastAssistant.content;
  if (!Array.isArray(content) || content.length === 0) return false;

  const firstBlockType = content[0]?.type;
  const hasThinkingPrefix =
    firstBlockType === 'thinking' || firstBlockType === 'redacted_thinking';
  if (hasThinkingPrefix) return false;

  const hasToolUse = content.some((b: any) => b?.type === 'tool_use');
  return hasToolUse;
}
