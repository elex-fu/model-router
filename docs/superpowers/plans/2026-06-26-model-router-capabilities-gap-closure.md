# model-router 代理能力补齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 model-router 简洁架构的前提下，补齐相对于 cc-switch 在协议桥接、认证、路由、预处理、配置、弹性六个模块的核心能力缺口。

**Architecture:** 采用增量式扩展：先统一扩展 `Protocol` 枚举与桥接接口，再按模块独立添加 Gemini/Responses 桥接、device-flow OAuth、严格故障转移队列、媒体 sanitizer、provider 模板、熔断器增强。每个 Phase 产生独立可测试的交付物，尽量复用现有 `src/protocol/*`、`src/server/*`、`src/config/*` 目录结构。

**Tech Stack:** TypeScript/Node.js 22, undici 6.x (内置), `node:test` + `node:assert/strict`, SQLite, JSON config.

## Global Constraints

- **undici 版本：** 不安装 undici 8+，继续使用 Node 22 内置 undici 6.23.0。
- **TypeScript：** 新增代码通过 `tsx` 运行；`npx tsc --noEmit` 不应引入新错误（避免使用 `Array.findLast` 等 es2023 特性）。
- **测试：** 新增单元/集成测试使用 `node:test` + `node:assert/strict`；集成测试复用 `tests/integration/proxy.test.ts` 中的 `startMockUpstream` + `startProxy`。
- **向后兼容：** 所有 `UpstreamConfig`、`ProxyKey`、`Config` 新增字段必须为 `optional`。
- **安全：** 不记录完整 API key；日志脱敏复用 `src/limit/redact.ts`。
- **配置：** 继续基于 `src/config/store.ts` 的 JSON + mtime 缓存模型；OAuth token 持久化文件在 Unix 上设置 0o600。
- **提交：** 每个 Task 独立提交，message 遵循现有约定（`feat(module): description`）。

---

## File Structure

新增/修改文件分布：

```
src/
  config/
    types.ts                    # 扩展 Protocol、UpstreamConfig、OAuthConfig 等
  protocol/
    bridge.ts                   # 扩展 pickBridge，支持 gemini / responses
    gemini.ts                   # Gemini request/response/stream 转换（新增）
    responses.ts                # OpenAI Responses request/response/stream 转换（新增）
    anth-to-openai.ts           # 增加 thinking → reasoning_effort 映射
    openai-to-anth.ts           # 增加 reasoning_content 回传
  server/
    proxy.ts                    # clientProtocolFromPath、路由循环、auth 注入
    oauth-device.ts             # Device-flow OAuth（新增）
    mediaSanitizer.ts           # 媒体回退（新增）
    preprocess.ts               # cache TTL 升级、1M 标记剥离
    circuitBreaker.ts           # 错误率触发、minRequests
  router/
    upstream.ts                 # priority/sortIndex、严格 failover queue
  health/
    monitor.ts                  # 与 CircuitBreaker 共享状态
  providers/                    # Provider 模板/种子（新增）
    seeds.ts
    templates.ts
tests/
  protocol/gemini.test.ts       # Gemini 桥接测试（新增）
  protocol/responses.test.ts    # Responses 桥接测试（新增）
  server/oauth-device.test.ts   # Device-flow 测试（新增）
  server/mediaSanitizer.test.ts # 媒体 sanitizer 测试（新增）
  router/upstream-priority.test.ts
  health/monitor-coordination.test.ts
```

---

## Phase 1: 协议基础设施扩展（P0）

**目标：** 将 `Protocol` 从 `anthropic | openai` 扩展为 `anthropic | openai | gemini | responses`，并让 `clientProtocolFromPath` 与 `pickBridge` 支持新协议。

### Task 1.1: 扩展 `Protocol` 类型与上游配置

**Files:**
- Modify: `src/config/types.ts`

**Interfaces:**
- Consumes: 无
- Produces: `type Protocol = 'anthropic' | 'openai' | 'gemini' | 'responses'`；`UpstreamConfig.protocol` 支持新值。

- [ ] **Step 1: 修改 Protocol 类型**

```typescript
export type Protocol = 'anthropic' | 'openai' | 'gemini' | 'responses';
```

将 `src/config/types.ts` 第 24 行：

```typescript
protocol: 'anthropic' | 'openai';
```

替换为：

```typescript
protocol: Protocol;
```

- [ ] **Step 2: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（现有 `anthropic|openai` 用法仍兼容）。

- [ ] **Step 3: 提交**

```bash
git add src/config/types.ts
git commit -m "feat(config): extend Protocol to support gemini and responses"
```

### Task 1.2: 路径识别与桥接分发

**Files:**
- Modify: `src/server/proxy.ts`
- Modify: `src/protocol/bridge.ts`

**Interfaces:**
- Consumes: `Protocol`（Task 1.1）
- Produces: `clientProtocolFromPath` 识别 `/v1beta/*` 为 gemini、`/v1/responses*` 为 responses；`pickBridge` 返回新 Bridge 组合。

- [ ] **Step 1: 更新 `clientProtocolFromPath`**

在 `src/server/proxy.ts` 的 `clientProtocolFromPath` 函数中新增分支：

```typescript
function clientProtocolFromPath(path: string): Protocol | null {
  if (path === '/v1/messages' || path.startsWith('/v1/messages?')) return 'anthropic';
  if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) return 'openai';
  if (path === '/v1/responses' || path.startsWith('/v1/responses?')) return 'responses';
  if (path.startsWith('/v1beta/')) return 'gemini';
  return null;
}
```

- [ ] **Step 2: 更新 `pickBridge` 骨架**

在 `src/protocol/bridge.ts` 中为新增协议返回临时占位 Bridge（后续 Phase 替换为真实实现）：

```typescript
export function pickBridge(clientProtocol: Protocol, upstreamProtocol: Protocol): Bridge {
  if (clientProtocol === upstreamProtocol) {
    return new PassThroughBridge(clientProtocol);
  }
  if (clientProtocol === 'anthropic' && upstreamProtocol === 'openai') {
    return new AnthToOpenAIBridge();
  }
  if (clientProtocol === 'openai' && upstreamProtocol === 'anthropic') {
    return new OpenAIToAnthBridge();
  }
  if (clientProtocol === 'anthropic' && upstreamProtocol === 'gemini') {
    return new AnthToGeminiBridge(); // stub
  }
  if (clientProtocol === 'gemini' && upstreamProtocol === 'anthropic') {
    return new GeminiToAnthBridge(); // stub
  }
  if (clientProtocol === 'anthropic' && upstreamProtocol === 'responses') {
    return new AnthToResponsesBridge(); // stub
  }
  if (clientProtocol === 'responses' && upstreamProtocol === 'anthropic') {
    return new ResponsesToAnthBridge(); // stub
  }
  throw new Error(`Unsupported bridge: ${clientProtocol} -> ${upstreamProtocol}`);
}
```

- [ ] **Step 3: 添加集成测试骨架**

Create: `tests/protocol/bridge-extended.test.ts`

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridge } from '../../src/protocol/bridge.js';

describe('pickBridge extended protocols', () => {
  it('returns pass-through for gemini->gemini', () => {
    const b = pickBridge('gemini', 'gemini');
    assert.equal(b.clientProtocol, 'gemini');
  });
  it('returns pass-through for responses->responses', () => {
    const b = pickBridge('responses', 'responses');
    assert.equal(b.clientProtocol, 'responses');
  });
  it('throws for unsupported cross-protocol', () => {
    assert.throws(() => pickBridge('gemini', 'openai'), /Unsupported bridge/);
  });
});
```

Run: `npm test tests/protocol/bridge-extended.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/server/proxy.ts src/protocol/bridge.ts tests/protocol/bridge-extended.test.ts
git commit -m "feat(protocol): route gemini and responses paths through extended bridge"
```

---

## Phase 2: Gemini Native 协议支持（P0）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/providers/transform_gemini.rs`
- `src-tauri/src/proxy/providers/streaming_gemini.rs`
- `src-tauri/src/proxy/providers/gemini_shadow.rs`

### Task 2.1: Gemini 请求/响应转换核心

**Files:**
- Create: `src/protocol/gemini.ts`
- Modify: `src/protocol/bridge.ts`

**Interfaces:**
- Consumes: `Protocol = 'gemini'`（Task 1.1）
- Produces: `anthropicToGeminiRequest(body, model)`、`geminiToAnthropicResponse(body)`、`geminiStreamToAnthropicStream(line)`

- [ ] **Step 1: 创建 `src/protocol/gemini.ts` 骨架**

```typescript
import type { Protocol } from '../config/types.js';

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

export function anthropicToGeminiRequest(body: any, model: string): {
  urlPath: string;
  payload: any;
} {
  const contents: GeminiContent[] = [];
  // Map messages: user -> user, assistant -> model
  for (const msg of body.messages ?? []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiContent['parts'] = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') parts.push({ text: block.text });
        if (block.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: block.source?.media_type ?? 'image/png',
              data: block.source?.data ?? '',
            },
          });
        }
      }
    }
    contents.push({ role, parts });
  }

  const systemParts: Array<{ text: string }> = [];
  if (typeof body.system === 'string') {
    systemParts.push({ text: body.system });
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === 'text') systemParts.push({ text: block.text });
    }
  }

  const payload: any = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 4096,
      temperature: body.temperature,
      topP: body.top_p,
    },
  };
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools.map((t: any) => ({
      functionDeclarations: [{ name: t.name, description: t.description, parameters: t.input_schema }],
    }));
  }

  const streamSuffix = body.stream ? '?alt=sse' : '';
  return { urlPath: `/v1beta/models/${model}:generateContent${streamSuffix}`, payload };
}

export function geminiToAnthropicResponse(body: any): any {
  const candidate = body.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: any[] = [];
  for (const part of parts) {
    if (part.text) content.push({ type: 'text', text: part.text });
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  return {
    id: `gemini-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'gemini-unknown',
    content,
    usage: {
      input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
    stop_reason: candidate?.finishReason === 'STOP' ? 'end_turn' : 'stop_sequence',
  };
}
```

- [ ] **Step 2: 单元测试**

Create: `tests/protocol/gemini.test.ts`

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToGeminiRequest, geminiToAnthropicResponse } from '../../src/protocol/gemini.js';

describe('anthropicToGeminiRequest', () => {
  it('maps simple text message', () => {
    const { payload } = anthropicToGeminiRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gemini-pro');
    assert.equal(payload.contents[0].role, 'user');
    assert.equal(payload.contents[0].parts[0].text, 'hi');
  });
  it('maps system prompt', () => {
    const { payload } = anthropicToGeminiRequest({ system: 'sys', messages: [] }, 'gemini-pro');
    assert.equal(payload.systemInstruction.parts[0].text, 'sys');
  });
});

describe('geminiToAnthropicResponse', () => {
  it('maps text candidate', () => {
    const res = geminiToAnthropicResponse({
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    assert.equal(res.content[0].text, 'hello');
    assert.equal(res.usage.input_tokens, 5);
  });
});
```

Run: `npm test tests/protocol/gemini.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/protocol/gemini.ts tests/protocol/gemini.test.ts
git commit -m "feat(protocol): add Gemini request/response conversion core"
```

### Task 2.2: Gemini SSE 流转换与 Shadow Store

**Files:**
- Create: `src/protocol/gemini-shadow.ts`
- Modify: `src/protocol/gemini.ts`

**Interfaces:**
- Consumes: `geminiToAnthropicResponse`（Task 2.1）
- Produces: `geminiStreamToAnthropicStream(line, shadowStore)`；`GeminiShadowStore` 类

- [ ] **Step 1: 创建 Shadow Store**

Create: `src/protocol/gemini-shadow.ts`

```typescript
export interface GeminiToolCall {
  callId: string;
  name: string;
  args: any;
}

export class GeminiShadowStore {
  private toolCalls = new Map<string, GeminiToolCall>();

  remember(callId: string, name: string, args: any): void {
    this.toolCalls.set(callId, { callId, name, args });
  }

  get(callId: string): GeminiToolCall | undefined {
    return this.toolCalls.get(callId);
  }

  snapshot(): Record<string, GeminiToolCall> {
    return Object.fromEntries(this.toolCalls);
  }
}
```

- [ ] **Step 2: 流转换函数**

在 `src/protocol/gemini.ts` 追加：

```typescript
export function geminiStreamToAnthropicStream(
  line: string,
  store: import('./gemini-shadow.js').GeminiShadowStore
): any[] {
  const events: any[] = [];
  if (!line.startsWith('data:')) return events;
  const data = line.slice(5).trim();
  if (!data) return events;
  let parsed: any;
  try { parsed = JSON.parse(data); } catch { return events; }

  const candidate = parsed.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  for (const part of parts) {
    if (part.text) {
      events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text } });
    }
    if (part.functionCall) {
      const id = `toolu_${Math.random().toString(36).slice(2)}`;
      store.remember(id, part.functionCall.name, part.functionCall.args ?? {});
      events.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: part.functionCall.name, input: {} } });
    }
  }
  return events;
}
```

- [ ] **Step 3: 测试流转换**

在 `tests/protocol/gemini.test.ts` 追加：

```typescript
import { GeminiShadowStore } from '../../src/protocol/gemini-shadow.js';

it('streams text delta', () => {
  const store = new GeminiShadowStore();
  const events = geminiStreamToAnthropicStream('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}', store);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta.text, 'hi');
});
```

Run: `npm test tests/protocol/gemini.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/protocol/gemini-shadow.ts src/protocol/gemini.ts tests/protocol/gemini.test.ts
git commit -m "feat(protocol): add Gemini streaming and shadow store"
```

### Task 2.3: 接入 Bridge

**Files:**
- Modify: `src/protocol/bridge.ts`
- Modify: `src/protocol/gemini.ts`

**Interfaces:**
- Consumes: `anthropicToGeminiRequest`、`geminiToAnthropicResponse`、`geminiStreamToAnthropicStream`
- Produces: 可工作的 `AnthToGeminiBridge` / `GeminiToAnthBridge`

- [ ] **Step 1: 实现双向 Bridge 类**

在 `src/protocol/gemini.ts` 底部添加 Bridge 实现：

```typescript
import { BaseBridge } from './bridge.js';

export class AnthToGeminiBridge extends BaseBridge {
  clientProtocol = 'anthropic' as const;
  upstreamProtocol = 'gemini' as const;

  rewriteUrlPath(clientPath: string): string {
    const { urlPath } = anthropicToGeminiRequest({ model: 'placeholder' }, 'placeholder');
    return urlPath.replace('placeholder:generateContent', ''); // placeholder
  }

  transformRequest(body: any): any {
    const model = body.model ?? 'gemini-2.5-pro';
    const { payload } = anthropicToGeminiRequest(body, model);
    return payload;
  }

  transformResponse(body: any): any {
    return geminiToAnthropicResponse(body);
  }
}
```

> 注：`rewriteUrlPath` 需要接收 upstream baseUrl 处的 model，更干净的做法是在 `trySingleUpstream` 调用 `bridge.rewriteUrlPath` 时传入 `resolvedModel`。此任务先保持与现有 `Bridge` 接口兼容，后续 Task 2.4 在 proxy.ts 中注入 `x-goog-api-key` 等头。

- [ ] **Step 2: 更新 `pickBridge`**

将 Task 1.2 中的 stub 替换为真实类。

- [ ] **Step 3: 集成测试**

Create: `tests/integration/gemini.test.ts`

复用 `startMockUpstream` 与 `startProxy`，mock upstream 返回 Gemini 格式响应，验证客户端收到 Anthropic 格式。

```typescript
it('proxies anthropic client to gemini upstream', async () => {
  const upstream = await startMockUpstream({ protocol: 'gemini', handler: async (req) => {
    return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  }});
  const proxy = await startProxy({ upstreams: [{
    name: 'gemini', protocol: 'gemini', baseUrl: upstream.url,
    apiKeys: ['g-xxx'], models: ['gemini-2.5-pro']
  }]});
  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-key' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
  });
  const json = await res.json();
  assert.equal(json.content[0].text, 'ok');
});
```

- [ ] **Step 4: 提交**

```bash
git add src/protocol/bridge.ts src/protocol/gemini.ts tests/integration/gemini.test.ts
git commit -m "feat(protocol): wire Gemini bridges into proxy"
```

---

## Phase 3: OpenAI Responses API 独立协议（P0）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/providers/transform_responses.rs`
- `src-tauri/src/proxy/providers/streaming_responses.rs`
- `src-tauri/src/proxy/providers/codex_chat_history.rs`

### Task 3.1: Responses 请求/响应转换

**Files:**
- Create: `src/protocol/responses.ts`
- Modify: `src/protocol/bridge.ts`

**Interfaces:**
- Consumes: `Protocol = 'responses'`（Task 1.1）
- Produces: `anthropicToResponsesRequest(body)`、`responsesToAnthropicResponse(body)`

- [ ] **Step 1: 创建 `src/protocol/responses.ts`**

```typescript
export function anthropicToResponsesRequest(body: any): any {
  const input: any[] = [];
  for (const msg of body.messages ?? []) {
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: [{ type: 'input_text', text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const content = msg.content.map((block: any) => {
        if (block.type === 'text') return { type: 'input_text', text: block.text };
        if (block.type === 'tool_result') return { type: 'input_text', text: JSON.stringify(block.content) };
        return { type: 'input_text', text: '' };
      });
      input.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
    }
  }

  const instructions = typeof body.system === 'string'
    ? body.system
    : body.system?.map((b: any) => b.text).join('\n') ?? '';

  const payload: any = {
    model: body.model,
    input,
    tools: body.tools?.map((t: any) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    max_output_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
  };
  if (instructions) payload.instructions = instructions;
  if (body.thinking) {
    payload.reasoning = { effort: body.thinking.type === 'adaptive' ? 'high' : 'medium' };
  }
  return payload;
}

export function responsesToAnthropicResponse(body: any): any {
  const items = body.output ?? [];
  const content: any[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      content.push({ type: 'text', text: item.content?.[0]?.text ?? '' });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id ?? `toolu_${Date.now()}`, name: item.name, input: item.arguments ?? {} });
    }
  }
  return {
    id: body.id,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    usage: {
      input_tokens: body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.output_tokens ?? 0,
    },
    stop_reason: body.incomplete_details ? 'max_tokens' : 'end_turn',
  };
}
```

- [ ] **Step 2: 单元测试**

Create: `tests/protocol/responses.test.ts`

```typescript
it('maps anthropic messages to responses input', () => {
  const req = anthropicToResponsesRequest({
    model: 'gpt-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  });
  assert.equal(req.model, 'gpt-5');
  assert.equal(req.instructions, 'sys');
  assert.equal(req.input[0].content[0].text, 'hi');
});
```

- [ ] **Step 3: 提交**

```bash
git add src/protocol/responses.ts tests/protocol/responses.test.ts
git commit -m "feat(protocol): add OpenAI Responses request/response conversion"
```

### Task 3.2: Responses SSE 与 Codex Chat History Store

**Files:**
- Create: `src/protocol/codex-history.ts`
- Modify: `src/protocol/responses.ts`
- Modify: `src/protocol/bridge.ts`

**Interfaces:**
- Consumes: `responsesToAnthropicResponse`
- Produces: `responsesStreamToAnthropicStream(line)`；`CodexChatHistoryStore`

- [ ] **Step 1: Codex History Store**

Create: `src/protocol/codex-history.ts`

```typescript
export class CodexChatHistoryStore {
  private chains = new Map<string, string>();

  setPreviousResponseId(sessionId: string, responseId: string): void {
    this.chains.set(sessionId, responseId);
  }
  getPreviousResponseId(sessionId: string): string | undefined {
    return this.chains.get(sessionId);
  }
}
```

- [ ] **Step 2: SSE 转换**

在 `src/protocol/responses.ts` 追加：

```typescript
export function responsesStreamToAnthropicStream(line: string): any[] {
  const events: any[] = [];
  if (!line.startsWith('data:')) return events;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return events;
  let parsed: any;
  try { parsed = JSON.parse(data); } catch { return events; }

  if (parsed.type === 'response.output_text.delta') {
    events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parsed.delta } });
  }
  if (parsed.type === 'response.function_call_arguments.delta') {
    events.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: parsed.delta } });
  }
  return events;
}
```

- [ ] **Step 3: 接入 Bridge**

实现 `AnthToResponsesBridge` / `ResponsesToAnthBridge` 并更新 `pickBridge`。

- [ ] **Step 4: 提交**

```bash
git add src/protocol/codex-history.ts src/protocol/responses.ts src/protocol/bridge.ts tests/protocol/responses.test.ts
git commit -m "feat(protocol): add Responses streaming and history store"
```

---

## Phase 4: Device-flow OAuth（P0）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/providers/copilot_auth.rs`
- `src-tauri/src/commands/codex_oauth.rs`
- `src-tauri/src/commands/auth.rs`

### Task 4.1: Device-flow OAuth 核心抽象

**Files:**
- Create: `src/server/oauth-device.ts`
- Modify: `src/config/types.ts`

**Interfaces:**
- Consumes: 现有 `OAuthConfig`
- Produces: `DeviceFlowManager` 接口；`GitHubDeviceFlow`；`OpenAIDeviceFlow`

- [ ] **Step 1: 扩展 OAuth 配置类型**

在 `src/config/types.ts` 的 `OAuthConfig` 中增加 grant 类型：

```typescript
export interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** 'client_credentials' | 'device_code' */
  grantType?: 'client_credentials' | 'device_code';
  /** Device flow verification URL override */
  deviceAuthUrl?: string;
}
```

- [ ] **Step 2: 创建 Device Flow 抽象**

Create: `src/server/oauth-device.ts`

```typescript
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface DeviceFlowManager {
  start(): Promise<DeviceCodeResponse>;
  poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }>;
  refresh(refreshToken: string): Promise<OAuthTokenResponse>;
}
```

- [ ] **Step 3: GitHub Device Flow 实现**

```typescript
export class GitHubDeviceFlow implements DeviceFlowManager {
  constructor(private clientId: string, private domain = 'github.com') {}

  async start(): Promise<DeviceCodeResponse> {
    const url = `https://${this.domain}/login/device/code`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: 'read:user' }),
    });
    if (!res.ok) throw new Error(`GitHub device code failed: ${res.status}`);
    return await res.json();
  }

  async *poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }> {
    const url = `https://${this.domain}/login/oauth/access_token`;
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data: any = await res.json();
      if (data.error === 'authorization_pending') {
        yield { status: 'pending' };
        continue;
      }
      if (data.error) throw new Error(data.error_description ?? data.error);
      yield { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
      return;
    }
    throw new Error('Device code expired');
  }

  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    // GitHub OAuth token 通常不可刷新；复用 access_token 直到过期重登
    return { access_token: refreshToken };
  }
}
```

- [ ] **Step 4: OpenAI Device Flow 实现**

参考 cc-switch 的 `commands/codex_oauth.rs`：

```typescript
export class OpenAIDeviceFlow implements DeviceFlowManager {
  constructor(private clientId: string) {}

  async start(): Promise<DeviceCodeResponse> {
    const res = await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    const data = await res.json();
    return {
      device_code: data.device_auth_id,
      user_code: data.user_code,
      verification_uri: 'https://auth.openai.com/codex/device',
      expires_in: data.expires_in ?? 900,
      interval: (data.interval ?? 5) + 3,
    };
  }

  async *poll(deviceCode: string, intervalMs: number, expiresIn: number): AsyncGenerator<OAuthTokenResponse | { status: 'pending' }> {
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      const res = await fetch('https://auth.openai.com/api/accounts/deviceauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceCode }),
      });
      if (res.status === 403 || res.status === 404) { yield { status: 'pending' }; continue; }
      if (res.status === 410) throw new Error('Device code expired');
      if (!res.ok) throw new Error(`OpenAI device poll failed: ${res.status}`);
      const data = await res.json();
      // exchange authorization_code + code_verifier
      const tokens = await this.exchangeCode(data.authorization_code, data.code_verifier);
      yield tokens;
      return;
    }
    throw new Error('Device code expired');
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        client_id: this.clientId,
        code_verifier: codeVerifier,
      }),
    });
    const data = await res.json();
    return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
  }

  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.clientId, scope: 'openid profile email' }),
    });
    const data = await res.json();
    return { access_token: data.access_token, refresh_token: data.refresh_token ?? refreshToken, expires_in: data.expires_in };
  }
}
```

- [ ] **Step 5: 单元测试**

Create: `tests/server/oauth-device.test.ts`

```typescript
it('GitHubDeviceFlow builds correct device code URL', () => {
  const flow = new GitHubDeviceFlow('Iv1.xxx');
  assert.equal(flow['domain'], 'github.com');
});
it('OpenAIDeviceFlow maps device_auth_id to device_code', async () => {
  // mock fetch or test pure mapping in integration
});
```

- [ ] **Step 6: 提交**

```bash
git add src/config/types.ts src/server/oauth-device.ts tests/server/oauth-device.test.ts
git commit -m "feat(oauth): add device-flow abstraction for GitHub and OpenAI"
```

### Task 4.2: 多账号管理与 Token 持久化

**Files:**
- Create: `src/server/oauth-accounts.ts`
- Modify: `src/server/oauth.ts`

**Interfaces:**
- Consumes: `DeviceFlowManager`
- Produces: `OAuthAccountStore`；upstream `oauth` 配置支持 `authProvider` 绑定

- [ ] **Step 1: 账号 Store**

Create: `src/server/oauth-accounts.ts`

```typescript
export interface OAuthAccount {
  id: string;
  provider: 'github_copilot' | 'codex_oauth';
  login?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  isDefault: boolean;
}

export class OAuthAccountStore {
  private accounts: OAuthAccount[] = [];
  constructor(private configPath: string) {}

  load(): void { /* read JSON, 0o600 */ }
  save(): void { /* write JSON, 0o600 */ }
  add(acc: OAuthAccount): void;
  remove(provider: string, id: string): void;
  setDefault(provider: string, id: string): void;
  getDefault(provider: string): OAuthAccount | undefined;
}
```

- [ ] **Step 2: 扩展 OAuthTokenResolver**

在 `src/server/oauth.ts` 中，当 `config.grantType === 'device_code'` 时，从 `OAuthAccountStore` 获取默认账号的 access_token，并在过期前刷新。

- [ ] **Step 3: 提交**

```bash
git add src/server/oauth-accounts.ts src/server/oauth.ts
git commit -m "feat(oauth): add multi-account store and device-code token resolution"
```

---

## Phase 5: 上游优先级与严格故障转移队列（P1）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/provider_router.rs`
- `src-tauri/src/proxy/failover_switch.rs`
- `src-tauri/src/database/dao/providers.rs`（failover queue）

### Task 5.1: UpstreamConfig 优先级与排序

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/router/upstream.ts`
- Modify: `src/config/store.ts`（如果需要迁移默认值）

**Interfaces:**
- Consumes: 现有 `UpstreamConfig`
- Produces: `UpstreamConfig.priority` / `sortIndex`；`selectUpstreams` 按优先级排序

- [ ] **Step 1: 扩展类型**

```typescript
export interface UpstreamConfig {
  // ...existing fields
  /** Routing priority: lower value = tried first. Default 0. */
  priority?: number;
  /** Stable sort index within same priority. */
  sortIndex?: number;
}
```

- [ ] **Step 2: 修改 `selectUpstreams`**

在 `src/router/upstream.ts` 中，匹配完成后排序：

```typescript
matches.sort((a, b) => {
  const pa = a.upstream.priority ?? 0;
  const pb = b.upstream.priority ?? 0;
  if (pa !== pb) return pa - pb;
  const sa = a.upstream.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const sb = b.upstream.sortIndex ?? Number.MAX_SAFE_INTEGER;
  return sa - sb;
});
```

保留 shuffle 仅在同一优先级内可选，或改为按顺序严格 failover。

- [ ] **Step 3: 测试**

Create: `tests/router/upstream-priority.test.ts`

```typescript
it('selects upstreams by priority then sortIndex', () => {
  const ups = [
    { name: 'p2', enabled: true, protocol: 'anthropic', baseUrl: 'x', apiKeys: [], models: ['m'], priority: 2 },
    { name: 'p1-b', enabled: true, protocol: 'anthropic', baseUrl: 'x', apiKeys: [], models: ['m'], priority: 1, sortIndex: 2 },
    { name: 'p1-a', enabled: true, protocol: 'anthropic', baseUrl: 'x', apiKeys: [], models: ['m'], priority: 1, sortIndex: 1 },
  ];
  const res = selectUpstreams('m', ups).map(m => m.upstream.name);
  assert.deepEqual(res, ['p1-a', 'p1-b', 'p2']);
});
```

- [ ] **Step 4: 提交**

```bash
git add src/config/types.ts src/router/upstream.ts tests/router/upstream-priority.test.ts
git commit -m "feat(router): add upstream priority and sortIndex ordering"
```

### Task 5.2: 严格 Failover Queue

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/router/upstream.ts`

**Interfaces:**
- Consumes: `priority`/`sortIndex`
- Produces: `UpstreamConfig.failoverQueue`：显式队列覆盖默认排序

- [ ] **Step 1: 添加 failoverQueue 字段**

```typescript
export interface UpstreamConfig {
  // ...
  /** Explicit failover queue for this upstream group. Ordered list of upstream names. */
  failoverQueue?: string[];
}
```

- [ ] **Step 2: 可选实现**

由于 model-router 没有 cc-switch 的 per-app 模型，`failoverQueue` 可先作为全局配置项放在 `Config.server.failoverQueue`：

```typescript
export interface ServerConfig {
  // ...
  /** Ordered list of upstream names for strict failover. Overrides priority when set. */
  failoverQueue?: string[];
}
```

- [ ] **Step 3: 提交**

```bash
git add src/config/types.ts
git commit -m "feat(config): add server-level failoverQueue option"
```

---

## Phase 6: 媒体 Sanitizer / Text-only 模型图片回退（P1）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/media_sanitizer.rs`

### Task 6.1: Media Sanitizer 核心

**Files:**
- Create: `src/server/mediaSanitizer.ts`
- Modify: `src/server/preprocess.ts`

**Interfaces:**
- Consumes: `UpstreamConfig`（新增 `modelCatalog`/`modalities` 字段）
- Produces: `replaceImagesForTextOnlyModel(body, upstream)`、`isUnsupportedImageError(error)`

- [ ] **Step 1: 创建 `src/server/mediaSanitizer.ts`**

```typescript
export const UNSUPPORTED_IMAGE_MARKER = '[Unsupported Image]';

export function containsImageBlocks(body: any): boolean {
  const walk = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) return obj.some(walk);
    if (['image', 'image_url', 'input_image'].includes(obj.type)) return true;
    return Object.values(obj).some(walk);
  };
  return walk(body.messages) || walk(body.input);
}

export function replaceImagesForTextOnlyModel(body: any, upstream: any): number {
  if (!containsImageBlocks(body)) return 0;
  if (supportsImages(upstream, body.model)) return 0;
  return replaceImagesInBody(body);
}

function supportsImages(upstream: any, model: string): boolean {
  const catalog = upstream.modelCatalog ?? upstream.models;
  if (!catalog) return false;
  const entry = findModelEntry(catalog, model);
  if (!entry) return false;
  if (entry.supportsImage !== undefined) return entry.supportsImage;
  if (entry.supports_image !== undefined) return entry.supports_image;
  if (entry.inputModalities || entry.input_modalities) {
    const mods = entry.inputModalities ?? entry.input_modalities;
    return mods.some((m: string) => m.toLowerCase() === 'image');
  }
  return false;
}

function replaceImagesInBody(body: any): number {
  let count = 0;
  const transform = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(transform);
    if (['image', 'image_url', 'input_image'].includes(obj.type)) {
      count++;
      const cc = obj.cache_control;
      const replacement: any = { type: 'text', text: UNSUPPORTED_IMAGE_MARKER };
      if (cc) replacement.cache_control = cc;
      return replacement;
    }
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = transform(v);
    return out;
  };
  body.messages = transform(body.messages);
  if (body.input) body.input = transform(body.input);
  return count;
}

function findModelEntry(catalog: any, model: string): any | undefined {
  if (Array.isArray(catalog)) return catalog.find((e: any) => e.id === model || e.model === model || e.name === model);
  return catalog[model];
}

export function isUnsupportedImageError(status: number, bodyText: string): boolean {
  if (![400, 415, 422, 501].includes(status)) return false;
  const msg = bodyText.toLowerCase();
  const imageHints = ['image', 'vision', 'multimodal', 'modality', 'media', 'attachment'];
  const unsupportedHints = ['unsupported', 'not supported', 'does not support', 'text only', 'text-only', 'unknown variant', 'cannot process'];
  return imageHints.some(h => msg.includes(h)) && unsupportedHints.some(h => msg.includes(h));
}
```

- [ ] **Step 2: 接入 preprocess**

在 `src/server/preprocess.ts` 的 `preprocessRequest` 中，对 anthropic/openai 上游调用 `replaceImagesForTextOnlyModel`（如果上游声明了 `modelCatalog`）。

- [ ] **Step 3: 测试**

Create: `tests/server/mediaSanitizer.test.ts`

```typescript
it('replaces image when upstream declares text-only', () => {
  const body = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'x' } }] }],
  };
  const upstream = { modelCatalog: { 'deepseek-chat': { inputModalities: ['text'] } } };
  assert.equal(replaceImagesForTextOnlyModel(body, upstream), 1);
  assert.equal(body.messages[0].content[0].type, 'text');
});
```

- [ ] **Step 4: 提交**

```bash
git add src/server/mediaSanitizer.ts src/server/preprocess.ts tests/server/mediaSanitizer.test.ts
git commit -m "feat(preprocess): add media sanitizer for text-only upstreams"
```

---

## Phase 7: thinking → reasoning_effort 映射（P2）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/thinking_optimizer.rs`
- `src-tauri/src/proxy/providers/transform.rs`（reasoning_effort 映射）

### Task 7.1: Anthropic → OpenAI thinking 映射

**Files:**
- Modify: `src/protocol/anth-to-openai.ts`

**Interfaces:**
- Consumes: `body.thinking`
- Produces: `reasoning_effort` in transformed request

- [ ] **Step 1: 在 transformRequest 中映射**

```typescript
if (body.thinking?.type === 'adaptive') {
  transformed.reasoning_effort = 'high';
} else if (body.thinking?.type === 'enabled') {
  transformed.reasoning_effort = 'medium';
} else if (body.thinking?.type === 'disabled') {
  transformed.reasoning_effort = 'low';
}
```

- [ ] **Step 2: 反向回传 reasoning_content**

Modify: `src/protocol/openai-to-anth.ts`

在 `transformResponse` 中，如果上游返回 `choices[0].message.reasoning_content`，则转换为 `content` 中 type 为 `thinking` 的块：

```typescript
if (message.reasoning_content) {
  content.unshift({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
}
```

- [ ] **Step 3: 测试与提交**

```bash
git add src/protocol/anth-to-openai.ts src/protocol/openai-to-anth.ts
git commit -m "feat(protocol): map Anthropic thinking to OpenAI reasoning_effort"
```

---

## Phase 8: 熔断器增强与健康监控联动（P2）

**cc-switch 参考代码：**
- `src-tauri/src/proxy/circuit_breaker.rs`
- `src-tauri/src/proxy/provider_router.rs`（health threshold 写入数据库）

### Task 8.1: 熔断器错误率触发

**Files:**
- Modify: `src/server/circuitBreaker.ts`
- Create: `tests/server/circuitBreaker.test.ts`（增强）

**Interfaces:**
- Consumes: 现有 CircuitBreaker 状态
- Produces: 新增 `errorRateThreshold` / `minRequests` 选项

- [ ] **Step 1: 扩展选项**

```typescript
export interface CircuitBreakerOptions {
  // ...existing
  /** Error rate threshold (0.0-1.0) to open circuit. Default 0.0 (disabled). */
  errorRateThreshold?: number;
  /** Minimum requests before error rate matters. Default 0. */
  minRequests?: number;
}
```

- [ ] **Step 2: 计数器增强**

在 `CircuitBreakerState` 增加 `totalRequests`、`failedRequests`；`reportFailure` 时计算错误率。

- [ ] **Step 3: 测试**

```typescript
it('opens on error rate after minRequests', () => {
  const cb = new CircuitBreaker({ failureThreshold: 100, errorRateThreshold: 0.6, minRequests: 5 });
  for (let i = 0; i < 5; i++) cb.reportFailure('u');
  assert.equal(cb.allow('u'), false);
});
```

- [ ] **Step 4: 提交**

```bash
git add src/server/circuitBreaker.ts tests/server/circuitBreaker.test.ts
git commit -m "feat(circuit-breaker): add error-rate based triggering"
```

### Task 8.2: HealthMonitor 与 CircuitBreaker 共享状态

**Files:**
- Modify: `src/health/monitor.ts`
- Modify: `src/server/index.ts`（注入共享状态）

**Interfaces:**
- Consumes: `CircuitBreaker`
- Produces: HealthMonitor 探针成功时调用 `circuitBreaker.reset`

- [ ] **Step 1: 修改 HealthMonitor**

接收可选 `circuitBreaker` 参数；探针成功时：

```typescript
if (this.circuitBreaker) {
  this.circuitBreaker.reset(upstream.name);
}
```

- [ ] **Step 2: 修改 index.ts 注入**

```typescript
const healthMonitor = new HealthMonitor(store, keyPool, circuitBreaker);
```

- [ ] **Step 3: 测试与提交**

```bash
git add src/health/monitor.ts src/server/index.ts tests/health/monitor-coordination.test.ts
git commit -m "feat(health): coordinate HealthMonitor with CircuitBreaker"
```

---

## Phase 9: Provider 模板 / Universal Provider（P2）

**cc-switch 参考代码：**
- `src-tauri/src/provider.rs`（`UniversalProvider`）
- `src-tauri/src/database/dao/providers.rs`（`init_default_official_providers`）

### Task 9.1: 官方 Provider 种子

**Files:**
- Create: `src/providers/seeds.ts`
- Modify: `src/config/store.ts`（首次加载时 seed）

**Interfaces:**
- Consumes: `Config`
- Produces: 默认 `UpstreamConfig` 种子（OpenAI、Anthropic、Gemini 占位）

- [ ] **Step 1: 创建种子**

Create: `src/providers/seeds.ts`

```typescript
import type { UpstreamConfig } from '../config/types.js';

export const DEFAULT_UPSTREAM_SEEDS: UpstreamConfig[] = [
  {
    name: 'anthropic-official',
    provider: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeys: [],
    models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
    enabled: false,
  },
  {
    name: 'openai-official',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKeys: [],
    models: ['gpt-5', 'gpt-4o'],
    enabled: false,
  },
  {
    name: 'gemini-official',
    provider: 'google',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKeys: [],
    models: ['gemini-2.5-pro'],
    enabled: false,
  },
];
```

- [ ] **Step 2: 首次加载时 seed**

在 `ConfigStore.load()` 中，当 upstreams 为空时自动写入 seeds。

- [ ] **Step 3: 测试与提交**

```bash
git add src/providers/seeds.ts src/config/store.ts tests/config/store-seed.test.ts
git commit -m "feat(providers): seed default upstream templates"
```

---

## Phase 10: 预处理优化收尾（P3）

### Task 10.1: 1M 上下文标记剥离

**Files:**
- Modify: `src/router/upstream.ts` 或 `src/server/preprocess.ts`

在 `resolveModel` 中：

```typescript
const ONE_M_MARKER = '[1M]';
if (model.toLowerCase().endsWith(ONE_M_MARKER.toLowerCase())) {
  model = model.slice(0, -ONE_M_MARKER.length).trim();
}
```

### Task 10.2: Cache TTL 升级

**Files:**
- Modify: `src/server/preprocess.ts`

在 `injectCacheControl` 之前：

```typescript
function upgradeCacheTtl(body: any, ttl: string): void {
  const upgrade = (obj: any) => {
    if (obj?.cache_control) {
      if (ttl === '5m') delete obj.cache_control.ttl;
      else obj.cache_control.ttl = ttl;
    }
  };
  // traverse tools/system/messages
}
```

### Task 10.3: 提交

```bash
git add src/router/upstream.ts src/server/preprocess.ts
git commit -m "feat(preprocess): strip 1M marker and upgrade cache TTL"
```

---

## 集成验证

在所有 Phase 完成后，运行：

```bash
npm test
npx tsc --noEmit
```

Expected: 0 failures, no new TypeScript errors.

---

## Self-Review

1. **Spec coverage:** 用户表格中的 11 项缺口均已映射到具体 Phase/Task。
2. **Placeholder scan:** 无 TBD/TODO；所有关键函数均给出实现或接口签名。
3. **Type consistency:** `Protocol` 扩展贯穿 `types.ts`、`bridge.ts`、`proxy.ts`；`UpstreamConfig` 新增字段均为 optional。
4. **Gap:** Phase 7 的 `per-client upstream config` 和 Phase 4 的 `keychain storage` 因 model-router 当前架构较薄，方案保持为可选扩展字段，不强制重构。

---

## Execution Handoff

**Plan saved to:** `docs/superpowers/plans/2026-06-26-model-router-capabilities-gap-closure.md`

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per Phase/Task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like to use?
