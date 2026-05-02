# model-router 多协议桥接设计

**Date**: 2026-05-01
**Status**: Draft → 待用户确认 → 进入实现规划

## 1. 背景与现状

`model-router` 是本地运行的轻量 AI 模型代理，定位是给 Claude Code 等 CLI agent 提供统一的多模型接入与多 key 路由。

当前已经实现的（约 1100 行 TS）：

- 单端口 HTTP 代理（`node:http`），路径 `/v1/*` 路由
- ProxyKey 鉴权（`x-api-key` 头）
- 按 `model` 字段选 upstream，候选随机洗牌 + 5xx/网络错误自动 failover
- 1 分钟心跳健康检查（连 3 次失败 disable，恢复 1 次重新 enable）
- SQLite 异步日志（内存队列 + 批量 flush + 进程退出 final flush）
- Anthropic 协议透明代理（含 SSE 流 `tee()` 旁路抽 usage）
- CLI 管理：key/upstream/logs/stats

**现状限制**：

- 仅支持 `protocol: "anthropic"` 的 upstream，无法接 OpenAI/DeepSeek 等
- 客户端只能用 Anthropic 格式（即只能给 Claude Code 用）
- 无模型别名映射，客户端发什么模型名上游就要支持什么模型名
- `protocol: "openai"` 字段已在类型里预留但未实现

## 2. 目标 / 非目标

### 2.1 目标

- 支持 4 种 client/upstream 协议组合：`anthropic↔anthropic`、`openai↔openai`、`anthropic→openai`、`openai→anthropic`
- 让任何客户端 agent（Claude Code、Codex 风格 OpenAI CLI、自制脚本）都能通过 model-router 接入任意上游协议
- 提供模型别名映射（modelMap），客户端模型名透明重写为上游真实模型名
- 保持现有"轻量、单进程、纯 CLI 管理"的定位
- 现有 a↔a 链路零改动、零回归

### 2.2 非目标（v1 不做）

- OpenAI Responses API（Codex 专属协议）
- 多模态（除 base64 图片外的 URL 图片、视频、音频）
- 嵌入模型 / files 接口
- Anthropic 特有特性的完整保留（thinking blocks、citations、cache_control 等在跨协议时被丢弃 + warn 日志）
- 配置热重载、GUI 管理、远程同步

## 3. 关键决策（来自 brainstorming）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 核心价值 | 协议双向桥接 | 让任意 agent 用任意上游 |
| 协议矩阵 | Anthropic ↔ OpenAI 双向（含 OpenAI 透传），跳过 Codex Responses API | 覆盖 90% 实际场景，保持轻量 |
| 模型映射 | 上游级 modelMap | 与"按模型选 upstream"路由模型自然契合 |
| 入口分发 | 单端口 + 路径识别（`/v1/messages` → anthropic, `/v1/chat/completions` → openai） | 部署最简，client 只配 BASE_URL |
| 实现路径 | Bridge 矩阵（4 个组合显式实现），非 IR pipeline、非外部库 | N=2 时 2×N=4 个 bridge 可控，避免过度抽象 |
| 默认端口 | 15005 | 用户选定 |

## 4. 架构

```
                 单端口 :15005
                       │
        ┌──────────────┴──────────────┐
        │   Path Dispatch              │
        │   POST /v1/messages         → clientProto = anthropic
        │   POST /v1/chat/completions → clientProto = openai
        │   GET  /healthz             → 200 OK
        └──────────────┬──────────────┘
                       ↓
        ┌──────────────────────────────┐
        │  Auth Middleware              │
        │   anthropic: x-api-key 头     │
        │   openai:    Authorization Bearer 头 (兼容 x-api-key)
        └──────────────┬───────────────┘
                       ↓
        ┌──────────────────────────────┐
        │  Router                       │
        │  selectUpstreams(clientModel, upstreams)
        │   → [{upstream, resolvedModel}, ...]  (洗牌后)
        │  匹配优先级:
        │   1. modelMap 精确命中
        │   2. modelMap glob 命中
        │   3. models[] 包含 (透传)
        └──────────────┬───────────────┘
                       ↓
        ┌──────────────────────────────┐
        │  Bridge.pick(clientProto, upstreamProto) │
        │   a↔a: PassthroughAnthropic  │
        │   o↔o: PassthroughOpenAI     │
        │   a→o: AnthToOpenAIBridge    │
        │   o→a: OpenAIToAnthBridge    │
        │  + body.model = resolvedModel │
        └──────────────┬───────────────┘
                       ↓
        ┌──────────────────────────────┐
        │  Forward                      │
        │   bridge.rewriteUrlPath(req.url)
        │   fetch(upstream)             │
        │  失败重试：5xx/网络错误 → 下一个候选
        └──────────────┬───────────────┘
                       ↓
        ┌──────────────────────────────┐
        │  Response                     │
        │  非流式：bridge.transformResponse(body)
        │  流式：bridge.transformStream(upstream)
        │           → { clientStream, usage Promise }
        │         clientStream pipe → client
        │         usage Promise → 异步入 logger
        └──────────────┬───────────────┘
                       ↓
              Async Logger → SQLite
```

主流程仍然在 `server/proxy.ts` 内，**不重构**；改动只在三处：

- 入口：解析 path 决定 `clientProto`
- 选择 bridge：替换原 `pickAdapter`
- 流式：`bridge.transformStream` 替换原 `parseStreamForUsage` 的 tee 处理

**不变的子系统**：心跳健康检查（`health/monitor.ts`）、SQLite 异步日志队列（`logger/queue.ts`）、ConfigStore 文件读写、ProxyKey 鉴权基础逻辑。

## 5. 协议桥接转换规则

### 5.1 a↔a（已有）

透明转发；usage 从 `message_start.usage.input_tokens` + `message_delta.usage.output_tokens` 抽。

### 5.2 o↔o（透传 + 头部规范）

请求体不动；规范化 `Authorization: Bearer {upstream.apiKey}` 与 `Content-Type`。
非流式 usage：`usage.prompt_tokens` / `usage.completion_tokens`。
流式 usage：最后一个含 `usage` 的 chunk（OpenAI 在 `stream_options.include_usage=true` 时返回；若上游不返回 usage，记 null）。

### 5.3 a→o（Anthropic-in → OpenAI-out）

**URL 路径重写**：`/v1/messages` → `/v1/chat/completions`。

**请求转换**：

| Anthropic 入参 | OpenAI 出参 |
|---|---|
| `messages[].role` (`"user"`/`"assistant"`) | 同名 |
| `messages[].content: string` | 同名（字符串保留） |
| `messages[].content: ContentBlock[]` 中 `text` blocks | 拼接成 `string`（多个 text 块用 `\n\n` 连接） |
| `tool_use` block | `messages[].tool_calls[]` (id/name/input → arguments JSON) |
| `tool_result` block | 单独的 `role: "tool"` 消息（tool_call_id + content） |
| `image` block (base64) | `content: [{type:"image_url", image_url:{url:"data:image/...;base64,..."}}]` |
| `system: string` | 顶部 `messages[0]: {role:"system", content}` |
| `system: TextBlock[]` | 同上，拼接 |
| `max_tokens` | `max_tokens`（暂不切 `max_completion_tokens`） |
| `stop_sequences` | `stop` |
| `temperature` / `top_p` | 同名 |
| `tools[]` | `tools[]`：`{type:"function", function:{name, description, parameters: input_schema}}` |
| `tool_choice: {type:"auto"}` | `"auto"` |
| `tool_choice: {type:"any"}` | `"required"` |
| `tool_choice: {type:"tool", name}` | `{type:"function", function:{name}}` |
| `stream` | 同名 |
| `model` | resolvedModel（外部已重写） |
| `metadata.user_id` | `user`（如有） |

**响应转换（非流式）**：

| OpenAI 输出 | Anthropic 输出 |
|---|---|
| `choices[0].message.content` (string) | `content: [{type:"text", text}]` |
| `choices[0].message.tool_calls[]` | `content: [{type:"tool_use", id, name, input}]` (input 解析 JSON) |
| `choices[0].finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `choices[0].finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `choices[0].finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |
| `id`, `model` | 同结构 + `type:"message"`, `role:"assistant"` |

**响应转换（流式 SSE）**：

OpenAI chunk 序列 → Anthropic event 序列。状态机维护：

```
state = {
  messageStarted: bool,
  currentBlockType: 'text' | 'tool_use' | null,
  currentBlockIndex: number,
  toolCallBuffer: { id, name, argsAccum }  // tool_calls 累积
}
```

事件转换：

```
首个有 role 的 chunk:
  → emit "event: message_start" with usage:{input_tokens:0}
  → 不开 block，等到 delta.content 或 delta.tool_calls

chunk.delta.content (text):
  if !state.currentBlockType:
    emit content_block_start (index, type:"text", text:"")
  emit content_block_delta (index, type:"text_delta", text=chunk.delta.content)

chunk.delta.tool_calls[0]:
  if state.currentBlockType == 'text':
    emit content_block_stop
  emit content_block_start (index+1, type:"tool_use", id, name, input:{})
  arguments delta → input_json_delta

chunk.finish_reason 非 null:
  emit content_block_stop
  emit message_delta { delta:{stop_reason}, usage:{output_tokens} }
  emit message_stop
```

### 5.4 o→a（OpenAI-in → Anthropic-out）

**URL 路径重写**：`/v1/chat/completions` → `/v1/messages`。

请求转换是 5.3 反向：

- `messages[]` 中 `role:"system"` 抽出来 → 顶层 `system`
- `tool_calls` → `tool_use` blocks
- `role:"tool"` 消息 → `tool_result` blocks
- `tools[].function` → `tools[]` 直接结构（name/description/input_schema:parameters）
- `max_tokens` 保留；`stop` → `stop_sequences`
- `tool_choice` 反向

响应非流式同样反向。

流式 SSE：

```
Anthropic message_start → 缓存（OpenAI 没有这一帧；用首条 chunk 替代，含 role:"assistant"）
Anthropic content_block_delta.text_delta → OpenAI chunk.choices[0].delta.content=text
Anthropic content_block_start(tool_use) → 开 tool_calls 累积
Anthropic input_json_delta → tool_calls 的 arguments delta
Anthropic message_delta → finish_reason 映射
Anthropic message_stop → emit "data: [DONE]"
```

### 5.5 错误响应转换

上游 4xx/5xx 返回 error envelope，bridge 包装为客户端协议：

- 客户端 anthropic：`{"type":"error", "error":{"type":"api_error", "message":"..."}}`
- 客户端 openai：`{"error":{"message":"...", "type":"api_error", "code":"..."}}`

源 `error.message` 尽量保留，type 统一为 `api_error`（除非明显是 auth_error / invalid_request_error）。

### 5.6 边界 / 丢弃项

跨协议时丢弃 + WARN log（不致命）：

- Anthropic → OpenAI 时丢弃：`thinking` blocks、`cache_control`、`citations`、`server_tool_use`
- OpenAI → Anthropic 时丢弃：`logprobs`、`response_format: json_schema`（v1 不实现 JSON schema 转 tool）

### 5.7 Bridge 接口

```ts
interface Bridge {
  clientProto: 'anthropic' | 'openai';
  upstreamProto: 'anthropic' | 'openai';

  // 入站请求体改写（含 model 重写已外部完成）
  transformRequest(body: any): any;

  // 上游非流式响应改写
  transformResponse(upstreamBody: any): any;

  // 上游流式 SSE 转客户端协议 SSE
  transformStream(upstream: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    usage: Promise<{ inputTokens?: number; outputTokens?: number }>;
  };

  // 路径重写
  rewriteUrlPath(originalPath: string): string;

  // 错误响应包装
  wrapError(statusCode: number, upstreamErrorBody?: any): { body: any; contentType: string };
}
```

四个具体实现：`PassthroughAnthropic`、`PassthroughOpenAI`、`AnthToOpenAIBridge`、`OpenAIToAnthBridge`。

每条请求 new 一个 bridge（无状态共享，便于并发/测试）。

## 6. 数据模型变更

### 6.1 UpstreamConfig

```ts
interface UpstreamConfig {
  name: string;
  provider: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  models: string[];                    // 透传命中：client 模型名 == 上游模型名
  modelMap?: Record<string, string>;   // 新增：别名 → 上游真实模型名（支持 glob）
  enabled: boolean;
}
```

### 6.2 路由匹配

```ts
function resolveModel(clientModel: string, u: UpstreamConfig): string | null {
  if (!u.enabled) return null;
  if (u.modelMap?.[clientModel]) return u.modelMap[clientModel];        // 精确
  for (const [pattern, target] of Object.entries(u.modelMap ?? {})) {
    if (matchGlob(pattern, clientModel)) return target;                 // glob
  }
  if (u.models.includes(clientModel)) return clientModel;               // 透传
  return null;
}
```

`matchGlob` 用最简实现（`*` → `.*`，`?` → `.`，其他字符转义）。

### 6.3 ServerConfig

`port` 默认值改为 `15005`（其他不变）。

### 6.4 LogEntry

新增：

- `client_protocol: 'anthropic' | 'openai'`
- `upstream_protocol: 'anthropic' | 'openai'`

`actual_model` 语义改为 modelMap 重写后的上游模型名（之前是 body.model 回读，效果一致但语义更清楚）。

SQLite 用 `ALTER TABLE` 加列，老库 NULL 兼容。

### 6.5 ProxyKey

不变。

## 7. CLI 变更

### 7.1 既有命令保留 + 微调

```
model-router start [--port 15005] [--config <path>]
model-router key:create <name>
model-router key:list
model-router key:delete <name>
model-router upstream:list
model-router upstream:delete <name>
model-router logs [--tail 20] [--key <name>] [--protocol anthropic|openai]
model-router stats [--date YYYY-MM-DD]
```

### 7.2 `upstream:add` 增强

```bash
model-router upstream:add <name> <provider> <protocol> <baseUrl> <apiKey> \
  [--models m1,m2,...] \
  [--map "src=dst"] [--map "src=dst"]...
```

`--map` 可重复，CLI 收到后构造 `modelMap`。`src` 支持 glob。

### 7.3 新增 modelMap 子命令

```
model-router upstream:map:set <name> <pattern> <target>
model-router upstream:map:delete <name> <pattern>
model-router upstream:map:list <name>
```

### 7.4 新增 `test` 命令

```bash
model-router test --client anthropic --model claude-sonnet-4-20250514 --key mrk_xxx
model-router test --client openai    --model gpt-4o --key mrk_xxx
```

输出格式：

```
✓ Selected upstream: deepseek-1 (openai protocol)
✓ Bridge: AnthToOpenAIBridge
✓ Resolved model: deepseek-chat
✓ Upstream status: 200
✓ Tokens: input=12 output=23
✓ Latency: 1247ms
```

发送的 prompt 固定为 `"Reply with: ok"`，max_tokens=8。

### 7.5 风格

继续 `console.table` + 原生 `console.log`，不引入装饰库。

## 8. 测试策略

### 8.1 单测

测试运行：`node --test tests/**/*.test.ts`（用 tsx loader）。不引入 vitest/jest。

| 文件 | 重点 |
|---|---|
| `tests/bridge/anth-to-openai.test.ts` | 请求/响应/流式三向转换；含 tool_use、system、stop_reason、image base64 |
| `tests/bridge/openai-to-anth.test.ts` | 反向同上 |
| `tests/bridge/passthrough.test.ts` | 头部规范、url 路径不变、body bytes 透传 |
| `tests/router/select.test.ts` | modelMap 精确/glob、`models[]` 透传、enabled 过滤、洗牌 |
| `tests/config/store.test.ts` | modelMap 增删改、向后兼容（缺 modelMap 字段不报错） |
| `tests/cli/upstream-add.test.ts` | `--map` 多个累加、glob 字符不被 shell 转义后能进 config |

### 8.2 流式状态机重点测试

- 输入：录制好的 OpenAI / Anthropic SSE chunk 数组（fixture 文件）
- 输出：调 bridge.transformStream，收集所有事件，断言序列与字段
- 覆盖 case：纯文本、含 tool_use、被打断（finish_reason=length）、tool_calls 跨多个 chunk

### 8.3 集成测试（可选，第二轮）

`tests/integration/proxy.test.ts`：

- 起 mock upstream（`http.createServer`，按 fixture 返回响应）
- 起 model-router 进程指向 mock
- `fetch()` 模拟 client 发请求
- 校验：auth、modelMap 重写、a→o 完整链路、failover

### 8.4 手动验证清单

```
1. 配置 deepseek (openai) + kimi (anthropic) 两个 upstream，给 claude-sonnet-4 都做映射
2. Claude Code CLI: ANTHROPIC_BASE_URL=http://127.0.0.1:15005 → 聊天通畅 (a→o & a→a)
3. curl 模拟 OpenAI client：POST /v1/chat/completions → o→a (kimi) 与 o→o (deepseek)
4. logs / stats 字段完整、含 client_protocol / upstream_protocol
5. 干掉一个 upstream，看 failover
6. SSE 流式响应在两个客户端都正常显示，且 usage 落库
```

## 9. 目录结构（变更点）

```
src/
├── protocol/
│   ├── adapter.ts              # (旧 ProtocolAdapter 接口，删除或保留为内部辅助)
│   ├── bridge.ts               # 新：Bridge 接口 + pick(clientProto, upProto)
│   ├── passthrough-anthropic.ts # 新：a↔a (大部分逻辑从原 anthropic.ts 迁过来)
│   ├── passthrough-openai.ts   # 新：o↔o
│   ├── anth-to-openai.ts       # 新：a→o
│   ├── openai-to-anth.ts       # 新：o→a
│   ├── sse.ts                  # 新：SSE 序列化/反序列化工具（被多个 bridge 复用）
│   └── glob.ts                 # 新：modelMap glob 匹配
├── router/
│   └── upstream.ts             # 修改：返回 {upstream, resolvedModel}[]
├── config/
│   ├── types.ts                # 修改：UpstreamConfig 加 modelMap; LogEntry 加 protocol
│   └── store.ts                # 修改：增删 modelMap、向后兼容
├── server/
│   ├── index.ts                # 修改：路径分发 / 默认端口 15005
│   ├── auth.ts                 # 修改：openai 路径同时认 Authorization Bearer
│   └── proxy.ts                # 修改：bridge 替换 adapter；流式走 bridge.transformStream
├── cli/
│   └── index.ts                # 修改：upstream:add --map; upstream:map:* 子命令; test 命令
├── logger/
│   └── store.ts                # 修改：schema 加列；ALTER 兼容老库
└── tests/                      # 新建（项目目前无 tests/ 目录）
```

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SSE 状态机 bug 难复现 | fixture 录制真实流数据；状态机单测覆盖各种异常序列 |
| OpenAI 不同上游 SSE 行为不一（usage 是否返回） | usage 取不到时记 null；不阻塞主流程 |
| tool_use input 累积过程中 JSON parse 失败 | 完整累完再 parse；失败 fallback 用空 object |
| 老 config 文件缺 modelMap 字段 | TypeScript optional + load 时归一化；写测试用例 |
| Anthropic 特性丢弃后用户感知差 | 启动时打印一次 "Note: cross-protocol drops X/Y/Z fields"；logs 表加 dropped_fields 列（可选） |
| 多模态 URL 形式图片需求 | v1 明确不做；遇到时用 422 + 清晰错误消息 |

## 11. 不做的（YAGNI）

- OpenAI Responses API
- 嵌入 / files / images endpoint
- thinking blocks 跨协议保留
- 配置热重载
- 多租户 quota / 速率限制
- 远程部署 / 配置同步

## 12. Open Questions

- `--map "src=dst"` 用 `=` 是否会与某些 shell 解析冲突？（暂保留，遇到再调）
- `test` 命令默认 prompt 是否需要可配置？（v1 固定 `"Reply with: ok"`）
- modelMap glob 是否需要支持后向引用 / 复杂正则？（v1 只 `* ?`）

---

## 实现拆任务（占位，下一步用 writing-plans）

后续由 writing-plans skill 把上面 §5、§6、§7、§8 拆成可独立完成的实现任务。
