import type { Protocol } from '../protocol/bridge.js';

/**
 * Pre-process a request body before protocol bridging and upstream forwarding.
 *
 * - Filters _-prefixed private parameters.
 * - Cleans orphan tool_result blocks.
 * - Injects cache_control and thinking for Anthropic upstreams.
 * - Strips thinking and cache_control for OpenAI upstreams.
 */
export function preprocessRequest(body: any, upstreamProtocol: Protocol, resolvedModel: string): any {
  if (!body || typeof body !== 'object') return body;
  const cloned = JSON.parse(JSON.stringify(body));

  filterPrivateParams(cloned);
  sanitizeOrphanToolResults(cloned);
  stripBillingHeaders(cloned);

  if (upstreamProtocol === 'anthropic') {
    injectCacheControl(cloned);
    injectThinking(cloned, resolvedModel);
  } else if (upstreamProtocol === 'openai') {
    stripThinkingAndCacheControl(cloned);
  }

  return cloned;
}

/** Recursively remove keys starting with '_' from objects. */
function filterPrivateParams(obj: any): void {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) filterPrivateParams(item);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) {
      delete obj[key];
      continue;
    }
    filterPrivateParams(obj[key]);
  }
}

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

/** Strip leading x-anthropic-billing-header line from system prompt text. */
function stripLeadingBillingHeader(text: string): string {
  if (!text.startsWith(BILLING_HEADER_PREFIX)) return text;
  const idx = text.search(/\r?\n|\r/);
  if (idx === -1) return '';
  let rest = text.slice(idx);
  if (rest.startsWith('\r\n')) {
    rest = rest.slice(2);
  } else {
    rest = rest.slice(1);
  }
  return rest;
}

/** Strip billing headers from system prompt to preserve prefix cache. */
function stripBillingHeaders(body: any): void {
  if (typeof body.system === 'string') {
    body.system = stripLeadingBillingHeader(body.system);
    return;
  }
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        block.text = stripLeadingBillingHeader(block.text);
      }
    }
  }
}

/**
 * Convert orphan tool_result blocks (without a matching preceding tool_use)
 * into plain text blocks to avoid upstream validation errors.
 */
function sanitizeOrphanToolResults(body: any): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  // Collect all tool_use IDs from assistant messages
  const knownToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id) {
        knownToolUseIds.add(String(block.id));
      }
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    let modified = false;
    const newContent = [];
    for (const block of content) {
      if (block?.type === 'tool_result') {
        const tid = block.tool_use_id !== undefined ? String(block.tool_use_id) : '';
        if (!tid || !knownToolUseIds.has(tid)) {
          modified = true;
          // Convert to a text block preserving original content
          newContent.push({
            type: 'text',
            text: `[orphan tool_result${tid ? ` id=${tid}` : ''}] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`,
          });
          continue;
        }
      }
      newContent.push(block);
    }
    if (modified) {
      msg.content = newContent;
    }
  }
}

/** Inject cache_control breakpoints into key locations (max 4 total). */
function injectCacheControl(body: any): void {
  const existing = countExistingCacheControl(body);
  if (existing >= 4) return;
  let budget = 4 - existing;

  // (a) tools last element
  if (budget > 0) {
    const tools = body.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      const last = tools[tools.length - 1];
      if (last && typeof last === 'object' && last.cache_control === undefined) {
        last.cache_control = { type: 'ephemeral' };
        budget--;
      }
    }
  }

  // (b) system last element
  if (budget > 0) {
    if (typeof body.system === 'string') {
      body.system = [{ type: 'text', text: body.system }];
    }
    const system = body.system;
    if (Array.isArray(system) && system.length > 0) {
      const last = system[system.length - 1];
      if (last && typeof last === 'object' && last.cache_control === undefined) {
        last.cache_control = { type: 'ephemeral' };
        budget--;
      }
    }
  }

  // (c) last assistant message's last non-thinking block
  if (budget > 0) {
    const messages = body.messages;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role !== 'assistant') continue;
        const content = msg.content;
        if (!Array.isArray(content)) break;
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j];
          const bt = block?.type;
          if (bt === 'thinking' || bt === 'redacted_thinking') continue;
          if (block && typeof block === 'object' && block.cache_control === undefined) {
            block.cache_control = { type: 'ephemeral' };
          }
          break;
        }
        break;
      }
    }
  }
}

function countExistingCacheControl(body: any): number {
  let count = 0;
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) if (t?.cache_control !== undefined) count++;
  }
  const system = body.system;
  if (Array.isArray(system)) {
    for (const s of system) if (s?.cache_control !== undefined) count++;
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.cache_control !== undefined) count++;
      }
    }
  }
  return count;
}

/**
 * Inject thinking configuration based on resolved model.
 * - haiku models: skip
 * - opus-4-7 / sonnet-4-6: adaptive + output_config.effort=max + beta flag
 * - others: enabled + budget_tokens
 */
function injectThinking(body: any, model: string): void {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return;

  const maxTokens =
    typeof body.max_tokens === 'number' ? body.max_tokens : 16384;

  if (m.includes('opus-4-7') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: 'max' };
    return;
  }

  // Legacy path
  const budgetTarget = Math.max(0, maxTokens - 1);
  const currentType = body.thinking?.type;

  if (currentType === 'enabled') {
    const currentBudget = typeof body.thinking?.budget_tokens === 'number' ? body.thinking.budget_tokens : 0;
    if (currentBudget < budgetTarget) {
      body.thinking.budget_tokens = budgetTarget;
    }
  } else if (currentType === 'adaptive') {
    // Keep adaptive as-is
  } else {
    body.thinking = { type: 'enabled', budget_tokens: budgetTarget };
  }
}

/** Strip thinking-related fields and cache_control for OpenAI upstreams. */
function stripThinkingAndCacheControl(body: any): void {
  delete body.thinking;
  delete body.output_config;
  delete body.anthropic_beta;

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg?.content;
      if (Array.isArray(content)) {
        msg.content = content.filter((block: any) => {
          const bt = block?.type;
          return bt !== 'thinking' && bt !== 'redacted_thinking';
        });
        for (const block of msg.content) {
          if (block && typeof block === 'object') {
            delete block.cache_control;
            delete block.signature;
          }
        }
      }
    }
  }

  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t === 'object') delete t.cache_control;
    }
  }

  const system = body.system;
  if (Array.isArray(system)) {
    for (const s of system) {
      if (s && typeof s === 'object') delete s.cache_control;
    }
  } else if (typeof system === 'string') {
    // no-op
  }
}
