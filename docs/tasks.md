# model-router 开发任务拆分

## 任务概览

| 任务 ID | 任务名称 | 说明 | 依赖 |
|---------|----------|------|------|
| T1 | 项目初始化 | 初始化 package.json、tsconfig.json、目录结构 | - |
| T2 | 配置管理模块 | 实现 config.json 读写、CLI key/upstream 管理命令 | T1 |
| T3 | HTTP 代理核心 | 鉴权中间件、随机路由、透明转发（含流式） | T2 |
| T4 | 流式日志提取 | Tee Stream + SSE 旁路解析 usage | T3 |
| T5 | 异步日志系统 | SQLite 初始化、批量写入、队列 flush | T3 |
| T6 | 统计查询 CLI | `logs` 和 `stats` 查询命令 | T5 |
| T7 | 集成测试与文档 | 接入验证、README、整体联调 | T4, T6 |

---

## T1: 项目初始化

- 创建 `package.json`
- 创建 `tsconfig.json`
- 创建 `src/` 目录骨架
- 安装基础依赖：`commander`, `better-sqlite3`
- 安装 dev 依赖：`typescript`, `@types/node`, `tsx`

## T2: 配置管理模块

- 定义 `Config` 类型（`server`, `proxyKeys`, `upstreams`）
- 实现 `ConfigStore`：加载、保存、校验 `~/.model-router/config.json`
- CLI 命令实现：
  - `key create <name>`
  - `key list`
  - `key delete <name>`
  - `upstream add <name> <provider> <protocol> <baseUrl> <apiKey> [--models m1,m2]`
  - `upstream list`
  - `upstream delete <name>`
- `utils/generate-key.ts`：生成 `mrk_${random}`

## T3: HTTP 代理核心

- `server/index.ts`：基于 `node:http` 启动服务，路由分发 `/v1/*`
- `server/auth.ts`：提取 `x-api-key`，校验 proxyKey
- `router/upstream.ts`：按 `model` 匹配并随机选择 upstream
- `server/proxy.ts`：主代理 handler
  - 接收请求
  - 替换 headers（替换 `authorization` 为 upstream apiKey，更新 `host`）
  - `fetch()` 透传 body 到上游
  - 非流式：记录 status + body usage
  - 流式：使用 `ReadableStream.tee()` 旁路解析 usage
- `protocol/adapter.ts`：定义 `ProtocolAdapter` 接口
- `protocol/anthropic.ts`：实现 `AnthropicAdapter`

## T4: 流式日志提取

- 实现 SSE 解析器，按 `\n\n` 拆分 event
- 识别 `event: message_start` → 提取 `usage.input_tokens`
- 识别 `event: message_delta` → 提取 `usage.output_tokens`
- 将提取结果与请求元数据组装为 `LogEntry`，推入异步队列
- 保证客户端响应延迟不受解析影响

## T5: 异步日志系统

- `logger/store.ts`：
  - `init()` 创建 SQLite 文件与表结构
  - `insertBatch()` 用 `better-sqlite3` 事务批量写入
  - 实现 `queryLogs()` 和 `stats()` 查询
- `logger/queue.ts`：
  - 内存 `pendingLogs` 数组
  - `setInterval` 定时 `flush()`
  - 进程退出信号最终 `flush()`
- 服务端启动时自动 `init()`

## T6: 统计查询 CLI

- `model-router logs [--tail 20] [--key <name>]`
  - 查询 `request_logs` 表
  - 表格化输出
- `model-router stats [--date YYYY-MM-DD]`
  - 按日聚合：`total_requests`, `total_input_tokens`, `total_output_tokens`, `avg_latency_ms`
  - 默认查询今天

## T7: 集成测试与文档

- 本地启动代理服务
- 配置 `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` 和 proxy key
- 使用 `curl` 模拟 Claude Code CLI 的发流式/非流式对话请求
- 验证：
  - 鉴权失败 / 成功
  - 流式响应正常
  - token 和 耗时正确记录到 SQLite
  - `logs` / `stats` CLI 输出正常
- 完善 `README.md`（安装、配置、接入说明）

---

更新日期：2026-04-02
