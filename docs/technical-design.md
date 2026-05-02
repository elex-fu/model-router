# model-router 技术方案设计文档

## 1. 项目定位

`model-router` 是一个轻量级的多模型代理服务，核心目标为：

- 统一代理 Claude Code CLI 发出的 Anthropic 协议请求
- 向上游随机路由到多个 Kimi Code API Key
- 旁路异步记录请求日志（来源 key、IP、模型、token、耗时等）
- 通过 CLI 管理 proxy key、upstream、日志统计

## 2. 核心架构

```
Client (Claude Code CLI)
        ↓ Anthropic Protocol
   ┌─────────────┐
   │  Proxy Auth │  校验 proxyKey
   └──────┬──────┘
          ↓
   ┌─────────────┐
   │   Router    │  按 model 匹配 + 随机选 upstream
   └──────┬──────┘
          ↓
   ┌─────────────┐
   │   Adapter   │  AnthropicAdapter（当前透明转发）
   │   Layer     │  OpenAIAdapter（预留扩展接口）
   └──────┬──────┘
          ↓
        Upstream API
          ↑
   ┌─────────────┐
   │ Async Logger│  内存队列 → SQLite
   │  (旁路记录) │
   └─────────────┘
```

### 2.1 代理流程

1. **Auth Middleware**：提取 header `x-api-key`，校验是否存在于 `config.json` 的 `proxyKeys` 中且 `enabled=true`
2. **Model Router**：解析请求 body 中的 `model` 字段，匹配 `upstreams` 中支持该 model 且 `enabled=true` 的 upstream，随机选择
3. **Adapter Layer**：根据 upstream 的 `protocol` 字段选择对应 Adapter。
   - `anthropic`：透明转发，仅旁路提取 usage 信息
   - `openai`：未来实现完整协议转换
4. **Response Proxy**：原样返回响应给客户端；流式响应通过 Tee Stream 异步解析 usage
5. **Async Logger**：请求结束后将元数据推入内存队列，后台批量写入 SQLite

## 3. 配置文件设计

单文件配置：`~/.model-router/config.json`

```json
{
  "server": {
    "port": 8080,
    "logFlushIntervalMs": 5000,
    "logBatchSize": 100
  },
  "proxyKeys": [
    {
      "name": "my-device",
      "key": "mrk_xxxxxxxxxxxxxxxxxxxx",
      "enabled": true,
      "createdAt": "2026-04-02T10:00:00Z"
    }
  ],
  "upstreams": [
    {
      "name": "kimi-1",
      "provider": "kimi",
      "protocol": "anthropic",
      "baseUrl": "https://api.kimi.com/coding",
      "apiKey": "sk-xxxxx",
      "models": ["kimi-k2-5"],
      "enabled": true
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `server.port` | 代理服务监听端口 |
| `server.logFlushIntervalMs` | 日志批量落盘间隔 |
| `server.logBatchSize` | 单次最大批量插入数 |
| `proxyKeys` | 客户端使用的代理 key 列表 |
| `upstreams` | 上游 model provider 列表 |
| `upstreams[].protocol` | 上游协议类型，`anthropic` 或 `openai` |

## 4. 核心模块设计

### 4.1 Protocol Adapter 抽象

```typescript
interface ProtocolAdapter {
  needsTransform(): boolean;

  transformRequest(req: RequestInit): RequestInit;
  transformResponse(res: Response): Promise<Response>;

  extractModel(body: any): string | undefined;
  extractUsage(body: any): { inputTokens?: number; outputTokens?: number };
  extractStreamUsage(events: AnthropicSseEvent[]): { inputTokens?: number; outputTokens?: number };
}
```

**AnthropicAdapter**：
- `needsTransform() => false`
- `transformRequest` / `transformResponse` 原样返回
- `extractUsage` 读取 `usage.input_tokens` / `usage.output_tokens`
- `extractStreamUsage` 解析 SSE `message_start` 和 `message_delta` 事件

**OpenAIAdapter**：预留接口，未来实现完整 Anthropic ↔ OpenAI 转换。

### 4.2 透明转发逻辑

#### 非流式请求

```typescript
const upstreamReq = new Request(upstreamUrl, {
  method: 'POST',
  headers: upstreamHeaders,
  body: rawBody,
});
const upstreamRes = await fetch(upstreamReq);
const cloned = upstreamRes.clone();
const body = await cloned.json();
// 提取 usage 入内存队列
return upstreamRes;
```

#### 流式请求（SSE）

使用 `ReadableStream.tee()` 将上游返回的流一分为二：

- **Branch A**：直接 pipe 给客户端，保证低延迟
- **Branch B**：用 `TextDecoderStream` + `
\n` 拆分器逐步解析 SSE event，遇到 `message_start` / `message_delta` 提取 usage，最终触发日志写入

> `tee()` 在浏览器/Node 环境中是同步、无损的，不会阻塞主请求。

#### 路由规则

```typescript
function selectUpstream(model: string, upstreams: UpstreamConfig[]): UpstreamConfig | null {
  const candidates = upstreams.filter(u => u.enabled && u.models.includes(model));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
```

### 4.3 错误处理

- **Auth 失败**：返回 HTTP 401，body 为 Anthropic error 格式
  ```json
  {"type":"error","error":{"type":"authentication_error","message":"Invalid proxy key"}}
  ```
- **无可用 upstream**：返回 HTTP 404，body 同上
- **上游返回 error**：代理**原样透传** HTTP status 和 body，不二次包装（因为 Kimi 已返回 Anthropic 格式 error）

## 5. 异步日志系统设计

### 5.1 SQLite Schema

数据库文件：`~/.model-router/logs.sqlite`

```sql
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_key_name TEXT NOT NULL,
    client_ip TEXT,
    request_model TEXT,
    actual_model TEXT,
    upstream_name TEXT,
    status_code INTEGER,
    error_message TEXT,
    request_tokens INTEGER,
    response_tokens INTEGER,
    total_tokens INTEGER,
    duration_ms INTEGER,
    is_streaming BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(proxy_key_name);
CREATE INDEX IF NOT EXISTS idx_logs_time ON request_logs(created_at);
```

### 5.2 存储接口

```typescript
interface LogStore {
  init(): Promise<void>;
  insertBatch(entries: LogEntry[]): Promise<void>;
  queryLogs(limit: number, keyName?: string): Promise<LogEntry[]>;
  stats(date?: string): Promise<StatsResult>;
}
```

### 5.3 异步队列实现

- 内存维护 `pendingLogs: LogEntry[]`
- `setInterval` 按 `logFlushIntervalMs` 触发 `flush()`
- `flush()` 时：
  1. swap `pendingLogs` 到本地变量
  2. 用 better-sqlite3 事务 `INSERT` 批量写入
  3. 失败则重试或打印 stderr（不影响主请求）
- 进程退出信号（`SIGINT`、`SIGTERM`、`beforeExit`）触发最终 `flush()`

## 6. CLI 命令设计

```
model-router start [--port 8080] [--config ~/.model-router/config.json]

model-router key create <name>
model-router key list
model-router key delete <name>

model-router upstream add <name> <provider> <protocol> <baseUrl> <apiKey> [--models m1,m2]
model-router upstream list
model-router upstream delete <name>

model-router logs [--tail 20] [--key <name>]
model-router stats [--date 2026-04-02]
```

### 命令说明

| 命令 | 说明 |
|------|------|
| `start` | 启动代理服务器 |
| `key create` | 生成随机 `mrk_xxx` 并写入 config |
| `key list` | 列出所有 proxy key |
| `key delete` | 删除指定 proxy key |
| `upstream add` | 新增上游，默认 models 为空数组 |
| `upstream list` | 列出所有 upstream |
| `upstream delete` | 删除指定 upstream |
| `logs` | 查询请求日志 |
| `stats` | 按日统计请求量、token 数、平均耗时 |

## 7. Claude Code CLI 接入方式

用户设置环境变量：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_API_KEY="mrk_xxxxxxxxxxxxxxxxxxxx"
```

> 注意：`ANTHROPIC_BASE_URL` 不带 `/v1`，因为 Claude Code CLI 默认会在后面拼接 `/v1/messages`。
> 代理层需要同时支持 `/v1/*` 和裸路径的路由。

## 8. 部署方式

### macOS 开发启动

```bash
npm install -g .
model-router start --port 8080
```

### 生产/服务端部署

```bash
npm install -g .
model-router start --port 8080 --config /etc/model-router/config.json
```

未来可补充 `launchd` / `systemd` 配置文件。

## 9. 目录结构

```
model-router/
├── docs/
│   └── technical-design.md      # 本文档
├── src/
│   ├── cli/
│   │   └── index.ts             # Commander CLI 入口
│   ├── server/
│   │   ├── index.ts             # HTTP server + 路由注册
│   │   ├── auth.ts              # Proxy key 鉴权中间件
│   │   └── proxy.ts             # 主代理 handler
│   ├── protocol/
│   │   ├── adapter.ts           # ProtocolAdapter interface
│   │   └── anthropic.ts         # AnthropicAdapter 实现
│   ├── router/
│   │   └── upstream.ts          # 随机路由逻辑
│   ├── config/
│   │   ├── store.ts             # config.json 读写
│   │   └── types.ts             # 配置类型定义
│   ├── logger/
│   │   ├── store.ts             # LogStore interface + SQLite 实现
│   │   ├── queue.ts             # 异步队列 + worker
│   │   └── types.ts             # LogEntry / StatsResult 类型
│   └── utils/
│       ├── generate-key.ts      # 生成随机 mrk_xxx
│       └── paths.ts             # ~/.model-router 路径工具
├── package.json
├── tsconfig.json
└── README.md
```

## 10. 技术选型总结

| 层级 | 技术 | 理由 |
|------|------|------|
| 语言 | TypeScript + Node.js 20+ | 与 Claude Code CLI 同生态，JSON 处理高效，开发速度快 |
| CLI 框架 | commander | 行业标准，生态成熟 |
| HTTP 服务 | 原生 `node:http` | 轻量，无需 express，减少依赖 |
| 数据库 | better-sqlite3 | 同步高性能，适合单节点本地日志 |
| 运行时 | tsx (dev) / node (prod) | 开发时直接运行 TS，生产编译为 JS |

---

文档版本：v1.0  
更新日期：2026-04-02
