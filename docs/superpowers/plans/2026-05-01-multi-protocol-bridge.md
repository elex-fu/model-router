# Multi-Protocol Bridge Implementation Plan

> **For agentic workers:** Phase-level outline. Each phase follows TDD: 写测试 → 验证失败 → 实现 → 验证通过 → commit。每个 phase 以"绿色测试 + commit 干净"为完成标志。Phase 间依赖见各 phase 头部。

**Goal:** 让 model-router 同时处理 Anthropic 与 OpenAI 协议的客户端，桥接到任意 Anthropic / OpenAI 上游，附带模型别名映射、CLI 管理、SSE 流式协议转换。

**Architecture:** Bridge 矩阵 + UpstreamConfig.modelMap + 单端口路径分发。详见 `docs/superpowers/specs/2026-05-01-multi-protocol-bridge-design.md`。

**Tech Stack:** TypeScript, node:http, node:test (内置), tsx, better-sqlite3, commander。新增 0 个 runtime 依赖。

**Default port:** `15005`

---

## Phase 1: Foundation — 测试基建 + modelMap 数据模型 + glob 匹配

**依赖:** 无。
**可并行:** 否（其他 phase 都依赖此 phase 完成）。

**做什么:**
1. 加 npm script `test`：`node --test --import tsx --test-reporter=spec tests/**/*.test.ts`，确保 `node --test` 跑得起来。
2. 新建 `tests/` 顶层目录与 `tests/fixtures/` 占位。
3. 在 `src/config/types.ts` 给 `UpstreamConfig` 增加 `modelMap?: Record<string, string>`；`ServerConfig.port` 默认改为 `15005`（同步 `DEFAULT_CONFIG`）。
4. 在 `src/config/store.ts` 增加方法：`updateUpstream(name, patch)`、`setModelMapEntry(upstreamName, pattern, target)`、`deleteModelMapEntry(upstreamName, pattern)`、`getUpstream(name)`。`mergeDefaults` 已经正确处理缺失字段；只需保证 modelMap undefined 时不抛错。
5. 新建 `src/protocol/glob.ts`：导出 `matchGlob(pattern: string, input: string): boolean`，仅支持 `*`（任意字符串）、`?`（单字符），其他字符 regex-escape。

**改/建文件:**
- 改：`package.json`（test script、scripts.dev 不动）、`src/config/types.ts`、`src/config/store.ts`
- 建：`src/protocol/glob.ts`、`tests/protocol/glob.test.ts`、`tests/config/store.test.ts`

**验证:** `npm test` 全绿；新测试覆盖：glob `claude-sonnet-4*` 命中、`gpt-?o` 字符类、转义 `.` 不触发；ConfigStore 旧 config 文件（无 modelMap 字段）能读出 modelMap=undefined；setModelMapEntry 持久化往复。

**Commit:** `feat: add modelMap config + glob matcher + test infra`

---

## Phase 2: Router 升级 — resolveModel + 新返回结构

**依赖:** Phase 1（types.modelMap、glob.ts）。
**可并行:** 与 Phase 3 可并行。

**做什么:** 把 `selectUpstreams(model, upstreams): UpstreamConfig[]` 改为 `selectUpstreams(model, upstreams): {upstream: UpstreamConfig, resolvedModel: string}[]`。匹配优先级：`modelMap` 精确 > `modelMap` glob > `models[]` 包含。`enabled=false` 排除。结果 shuffle。`selectUpstream`（单数）保留并基于新版返回 `[0]`。

**改/建文件:**
- 改：`src/router/upstream.ts`
- 建：`tests/router/select.test.ts`

**验证:** 测试覆盖：精确 vs glob 优先级（精确赢）、glob 匹配多个 upstream 全返回、`models[]` 透传命中、`enabled=false` 排除、空候选返回 `[]`、resolvedModel 等于上游真实模型名而非客户端模型名。

**Commit:** `feat(router): support modelMap with glob matching`

---

## Phase 3: Bridge 框架 + Passthrough 实现 + SSE 工具

**依赖:** Phase 1。
**可并行:** 与 Phase 2 可并行。

**做什么:**
1. 新建 `src/protocol/bridge.ts`：定义 `Bridge` 接口（`clientProto/upstreamProto/transformRequest/transformResponse/transformStream/rewriteUrlPath/wrapError`）；导出 `pickBridge(clientProto, upstreamProto): Bridge`。
2. 新建 `src/protocol/sse.ts`：导出 `parseSseStream(stream): AsyncIterable<{event?, data}>`、`writeSseEvent(event, data): string`、`finalizeStream(events[]): Uint8Array`（用于测试合成完整流）。
3. 新建 `src/protocol/passthrough-anthropic.ts`：从现有 `protocol/anthropic.ts` 迁移逻辑（usage 抽取规则等），实现 `Bridge`，stream 内部 `tee` + 抽 usage。
4. 新建 `src/protocol/passthrough-openai.ts`：透传 + 头部规范化；usage 从 `usage.prompt_tokens / completion_tokens` 或最后含 usage 的 chunk。
5. 老的 `src/protocol/adapter.ts` 与 `src/protocol/anthropic.ts` 暂留（不导入）；Phase 6 删。

**改/建文件:**
- 建：`src/protocol/bridge.ts`、`src/protocol/sse.ts`、`src/protocol/passthrough-anthropic.ts`、`src/protocol/passthrough-openai.ts`
- 建：`tests/protocol/sse.test.ts`、`tests/protocol/passthrough-anthropic.test.ts`、`tests/protocol/passthrough-openai.test.ts`

**验证:** SSE 工具能 round-trip（serialize → parse 等价）；passthrough-anthropic stream 抽出 input_tokens + output_tokens；passthrough-openai stream usage 抽取（含上游不返回 usage 时为 undefined）；wrapError 输出正确协议格式。

**Commit:** `feat(protocol): add Bridge interface + passthrough impls + SSE utils`

---

## Phase 4: AnthToOpenAI Bridge（a→o）

**依赖:** Phase 3。
**可并行:** 与 Phase 5 可并行。

**做什么:** 实现 `src/protocol/anth-to-openai.ts`，覆盖 spec §5.3：
- `transformRequest`：messages content blocks → string/tool_calls/tool messages、system 提到顶部、tools 结构改写、tool_choice 三态、image base64 → image_url、stop_sequences→stop、metadata.user_id→user。
- `transformResponse`（非流）：choices[0].message → content blocks + stop_reason 映射 + usage 字段名转换。
- `transformStream`：状态机把 OpenAI chunks → Anthropic SSE event 序列（`message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`），同时累计 input/output tokens。tool_calls 跨多 chunk 时累积 arguments JSON。
- `rewriteUrlPath`: `/v1/messages` → `/v1/chat/completions`。

**改/建文件:**
- 建：`src/protocol/anth-to-openai.ts`
- 建：`tests/protocol/anth-to-openai.test.ts`、`tests/fixtures/anth-to-openai/*.json`（fixture 抓取或手写）

**验证:** 单测分三组：request 转换（含 tool_use、image base64、system 文本/数组）、response 非流式（含 tool_calls、length finish_reason）、stream（纯文本流、含 tool_calls 流、被 length 中断的流）。每组至少 3 case。

**Commit:** `feat(protocol): add Anthropic-to-OpenAI bridge`

---

## Phase 5: OpenAIToAnth Bridge（o→a）

**依赖:** Phase 3。
**可并行:** 与 Phase 4 可并行。

**做什么:** 实现 `src/protocol/openai-to-anth.ts`，覆盖 spec §5.4，是 Phase 4 的反向：
- `transformRequest`：抽 system 消息出来、tool_calls → tool_use blocks、role:tool 消息 → tool_result blocks、tools[].function 结构展平、stop→stop_sequences、tool_choice 反向。
- `transformResponse`（非流）：Anthropic content blocks → OpenAI message + tool_calls + finish_reason 反映射 + usage 字段名转换。
- `transformStream`：状态机把 Anthropic events → OpenAI chunks。`content_block_delta.text_delta` → `chunk.choices[0].delta.content`；`tool_use` blocks 累积成 `tool_calls` deltas；`message_stop` 后 emit `data: [DONE]`。
- `rewriteUrlPath`: `/v1/chat/completions` → `/v1/messages`。

**改/建文件:**
- 建：`src/protocol/openai-to-anth.ts`
- 建：`tests/protocol/openai-to-anth.test.ts`、`tests/fixtures/openai-to-anth/*.json`

**验证:** 同 Phase 4 三组，各 3 case 起。

**Commit:** `feat(protocol): add OpenAI-to-Anthropic bridge`

---

## Phase 6: Server / Logger 集成

**依赖:** Phase 4 + Phase 5 完成。
**可并行:** 与 Phase 7 可并行（不同文件）。

**做什么:**
1. 改 `src/server/index.ts`：默认端口 15005（已在 Phase 1 改 DEFAULT_CONFIG，这里确认无硬编码 8080）。
2. 改 `src/server/proxy.ts`：
   - 入口按 path 决定 `clientProto`（`/v1/messages` → anthropic，`/v1/chat/completions` → openai；其他 404 错误协议匹配 client 推断）。
   - `selectUpstreams` 新返回结构：`{upstream, resolvedModel}`。
   - 替换 `pickAdapter` 为 `pickBridge(clientProto, upstream.protocol)`。
   - 转发前用 `bridge.rewriteUrlPath` + `bridge.transformRequest`，写 body 时用 resolvedModel 重写 `body.model`。
   - 流式：`bridge.transformStream(upstreamRes.body)` 返回 `{clientStream, usage}`，pipe `clientStream` 到 client，`usage` Promise 入异步日志。
   - 错误响应用 `bridge.wrapError`。
3. 改 `src/logger/types.ts`：`LogEntry` 加 `client_protocol`、`upstream_protocol`。
4. 改 `src/logger/store.ts`：schema 加两列；`init()` 启动时 `ALTER TABLE` 容错（IF NOT EXISTS 等价）；`insertBatch` / `queryLogs` 处理新字段。
5. 删 `src/protocol/adapter.ts` 与 `src/protocol/anthropic.ts`（已被 passthrough-anthropic 取代）。
6. 改 `src/cli/index.ts` 的 `logs` 命令：加 `--protocol anthropic|openai` 过滤，输出列加 `cp/up`（client/upstream protocol 简写）。

**改/建文件:**
- 改：`src/server/index.ts`、`src/server/proxy.ts`、`src/logger/types.ts`、`src/logger/store.ts`、`src/cli/index.ts`
- 删：`src/protocol/adapter.ts`、`src/protocol/anthropic.ts`
- 建：`tests/integration/proxy.test.ts`（mock upstream + fetch 测 a↔a + a→o + o→a + o→o 四条链路通畅 + auth + failover）

**验证:** 集成测试全绿；现有 `npm run build` (tsc) 编译干净；启动后 `curl /healthz` 返回 200。

**Commit:** `feat(server): integrate bridges + path dispatch + log protocol fields`

---

## Phase 7: CLI 增强

**依赖:** Phase 1（ConfigStore 已扩展）。代码上可与 Phase 6 并行；建议放后面更稳。
**可并行:** 与 Phase 6 可并行。

**做什么:**
1. 改 `src/cli/index.ts`：
   - `upstream:add` 加 `--map "src=dst"` 多次累加，转入 modelMap。
   - 新建 `upstream:map:set <name> <pattern> <target>`、`upstream:map:delete <name> <pattern>`、`upstream:map:list <name>`。
   - 新建 `test --client anthropic|openai --model <m> --key <k> [--port <p>]`：构造一条最小请求（prompt 固定 "Reply with: ok"，max_tokens=8），打印 selected upstream、resolved model、status、tokens、latency；失败显示 error。

**改/建文件:**
- 改：`src/cli/index.ts`
- 建：`tests/cli/upstream-add.test.ts`、`tests/cli/upstream-map.test.ts`、`tests/cli/test-cmd.test.ts`（用 child_process 跑 CLI 子进程；test 命令测对 mock upstream）

**验证:** CLI 子进程跑命令读 config 文件，断言 modelMap 持久化；test 命令对 mock upstream 打印关键字段。

**Commit:** `feat(cli): add --map flag + upstream:map subcommands + test command`

---

## Phase 8: 文档 + 手动验证

**依赖:** 所有前面 phase 完成。

**做什么:**
1. 改 `README.md`：
   - 顶部说明现已支持 Anthropic ↔ OpenAI 双向桥接。
   - 新增 "modelMap 模型别名" 章节，含 deepseek/openai upstream 的完整配置示例。
   - 新增 "Codex/通用 OpenAI 客户端接入" 章节，给出 `OPENAI_BASE_URL=http://127.0.0.1:15005/v1` 配置。
   - CLI 命令章节补 `upstream:map:*`、`test`、`--map` 用法。
2. 跑一遍 spec §8.4 的手动验证清单（人工 + 截图/输出贴在 verification log）。
3. 如有遗漏，回填补丁。

**改/建文件:**
- 改：`README.md`
- 建：`docs/superpowers/specs/2026-05-01-multi-protocol-bridge-verification.md`（手动测试结果与 known issues）

**验证:** README 中所有命令样例可粘贴执行；手动清单 6 项全过；`npm run build` 干净；`npm test` 全绿。

**Commit:** `docs: README + verification log for multi-protocol bridge`

---

## 执行策略

```
依赖图:
  Phase 1 ─┬─ Phase 2 ─┐
           ├─ Phase 3 ─┼─ Phase 4 ─┐
           │           └─ Phase 5 ─┴─ Phase 6 ─┐
                                   └─ Phase 7 ─┴─ Phase 8

并行批次:
  R1: Phase 1                     (sequential)
  R2: Phase 2 + Phase 3           (parallel)
  R3: Phase 4 + Phase 5           (parallel)
  R4: Phase 6                     (sequential)
  R5: Phase 7 + Phase 8 part 1    (parallel)
  R6: Phase 8 part 2              (sequential, 手动验证 + 截图)
```

每个 phase 完成由独立 subagent 处理，遵循 TDD 五步骨架；commit 结束即 phase done。
