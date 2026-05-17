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
    applied = true;
  }

  return { applied, body: cloned };
}

function shouldRemoveTopLevelThinking(body: any): boolean {
  const thinkingType = body?.thinking?.type;
  if (thinkingType !== 'enabled') return false;

  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;

  // Find last assistant message
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

  // Only remove if there are tool_use blocks (the common failure case)
  const hasToolUse = content.some(
    (b: any) => b?.type === 'tool_use'
  );
  return hasToolUse;
}
