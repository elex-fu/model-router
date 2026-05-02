# model-router

轻量级 AI 模型代理服务，统一代理 Claude Code CLI 的模型请求，支持多 Key 路由、异步日志记录与统计查询。

## 特性

- **透明代理**：直接透传 Anthropic 协议请求到上游 Kimi Code API，无需协议转换
- **多 Key 路由**：按请求模型随机选择可用 upstream key
- **代理 Key 鉴权**：为不同使用方分配独立的代理 key
- **异步日志记录**：旁路记录请求来源、模型、token、耗时等信息到本地 SQLite
- **纯 CLI 管理**：通过命令行完成 key、upstream、日志、统计管理
- **轻量部署**：单进程 + SQLite，本地开发与服务端低资源运行

## 快速开始

### 安装

```bash
git clone <repo>
cd model-router
npm install
npm run build
npm link
```

### 创建代理 Key

```bash
model-router key:create my-device
```

输出示例：
```
Created proxy key: my-device
Key: mrk_xxxxxxxxxxxxxxxxxxxx
```

### 添加上游 Kimi API

```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-your-kimi-key --models kimi-k2-5
```

### 启动代理服务

```bash
model-router start --port 8080
```

### 配置 Claude Code CLI

设置环境变量后启动 `claude`：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_API_KEY="mrk_xxxxxxxxxxxxxxxxxxxx"
claude
```

> Claude Code CLI 会在 `ANTHROPIC_BASE_URL` 后自动拼接 `/v1/messages` 等路径。代理层会接管 `/v1/*` 请求并透传给上游。

## CLI 命令详解

### 服务启动

```bash
# 默认端口 8080，使用默认配置文件 ~/.model-router/config.json
model-router start

# 指定端口
model-router start --port 8080

# 指定自定义配置文件
model-router start --port 8080 --config /etc/model-router/config.json
```

启动后，代理将监听指定端口，每分钟执行一次 upstream 心跳检查，并在后台异步写入请求日志。

### Key 管理

代理 Key 是给**使用方**（如 Claude Code CLI）接入时使用的凭证，与上游 Kimi API Key 不同。

#### 创建 Key
```bash
model-router key:create my-device
```
输出示例：
```
Created proxy key: my-device
Key: mrk_xxxxxxxxxxxxxxxxxxxx
```

#### 列出所有 Key
```bash
model-router key:list
```
输出示例：
```
┌─────────┬──────────────────────────┬─────────┬──────────────────────────┐
│ (index) │ name                     │ key     │ enabled │ createdAt                │
├─────────┼──────────────────────────┼─────────┼──────────────────────────┤
│ 0       │ 'my-device'              │ 'mrk_xxxxxxxxxxxxxxxxxxxx' │ true    │ '2026-04-02T10:00:00Z' │
└─────────┴──────────────────────────┴─────────┴──────────────────────────┘
```

#### 删除 Key
```bash
model-router key:delete my-device
```

### 上游管理

上游（upstream）是实际的模型提供商 API。你可以为同一个模型添加多个 upstream，代理会自动按可用性随机选择并在失败时降级。

#### 添加单个 upstream
```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-your-kimi-key --models kimi-k2-5
```

#### 添加多个模型
```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-your-kimi-key --models kimi-k2-5,moonshot-v1-8k
```

#### 列出所有 upstream
```bash
model-router upstream:list
```
输出示例：
```
┌─────────┬──────┬───────────┬─────────────────────────┬─────────────────┬─────────┐
│ (index) │ name │ provider  │ protocol │ baseUrl                    │ models    │ enabled │
├─────────┼──────┼───────────┼─────────────────────────┼─────────────────┼─────────┤
│ 0       │ 'kimi-1' │ 'kimi'  │ 'anthropic' │ 'https://api.kimi.com/coding' │ 'kimi-k2-5' │ true    │
└─────────┴──────┴───────────┴─────────────────────────┴─────────────────┴─────────┘
```

#### 删除 upstream
```bash
model-router upstream:delete kimi-1
```

### 日志查询

所有经过代理的请求都会异步写入本地 SQLite（`~/.model-router/logs.sqlite`），可以通过 CLI 查询。

#### 查看最近日志
```bash
# 默认显示最近 20 条
model-router logs

# 指定条数
model-router logs --tail 50
```

#### 按 proxy key 过滤
```bash
model-router logs --tail 20 --key my-device
```

输出示例：
```
┌─────────┬────┬───────────┬─────────────┬──────────┬────────┬───────┬────────┬───────┬───────────────────────┐
│ (index) │ id │ key       │ model       │ upstream │ status │ input │ output │ ms    │ created               │
├─────────┼────┼───────────┼─────────────┼──────────┼────────┼───────┼────────┼───────┼───────────────────────┤
│ 0       │ 10 │ 'my-device' │ 'kimi-k2-5' │ 'kimi-1' │ 200    │ 12    │ 16     │ 13207 │ '2026-04-02 10:05:18' │
│ 1       │ 9  │ 'my-device' │ 'kimi-k2-5' │ 'kimi-2' │ 200    │ 16    │ 7      │ 7050  │ '2026-04-02 10:05:23' │
└─────────┴────┴───────────┴─────────────┴──────────┴────────┴───────┴────────┴───────┴───────────────────────┘
```

### 统计查询

#### 查看今日统计
```bash
model-router stats
```

#### 查看指定日期
```bash
model-router stats --date 2026-04-01
```

输出示例：
```
Statistics for 2026-04-02:
┌───────────────────┬────────┐
│ (index)           │ Values │
├───────────────────┼────────┤
│ totalRequests     │ 42     │
│ totalInputTokens  │ 512    │
│ totalOutputTokens │ 2048   │
│ avgLatencyMs      │ 8543   │
└───────────────────┴────────┘
```

### 完整使用示例

#### 场景：添加两个 Kimi key 并启动代理

```bash
# 1. 创建代理 key
model-router key:create my-macbook

# 2. 添加两个 Kimi upstream（自动负载均衡 + 故障降级）
model-router upstream:add kimi-primary kimi anthropic https://api.kimi.com/coding sk-kimi-key-1 --models kimi-k2-5
model-router upstream:add kimi-backup  kimi anthropic https://api.kimi.com/coding sk-kimi-key-2 --models kimi-k2-5

# 3. 启动代理
model-router start --port 8080

# 4. 配置 Claude Code CLI 环境变量
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_API_KEY="mrk_xxxxxxxxxxxxxxxxxxxx"

# 5. 启动 claude
claude
```

#### 场景：切换自定义配置文件路径

```bash
model-router start --port 8080 --config /Users/shared/.model-router/config.json
```

> 通过 `--config` 指定的配置文件中同样可以按需定义 `server` / `proxyKeys` / `upstreams` 字段。

## 配置文件

默认路径：`~/.model-router/config.json`

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
      "apiKey": "sk-your-kimi-key",
      "models": ["kimi-k2-5"],
      "enabled": true
    }
  ]
}
```

## 架构说明

```
Claude Code CLI
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
   │   Adapter   │  当前：AnthropicAdapter（透明转发）
   │   Layer     │  未来可扩展 OpenAIAdapter 等协议转换
   └──────┬──────┘
          ↓
        Upstream API
          ↑
   ┌─────────────┐
   │ Async Logger│  内存队列 → SQLite
   │  (旁路记录) │
   └─────────────┘
```

## 开发

```bash
# 开发模式直接运行
npm run dev -- start --port 8080

# 编译
npm run build

# 运行编译后版本
npm start
```

## 高级特性

### 失败自动降级

当某个 upstream 返回 `5xx` 或网络不可达时，代理会**自动按随机顺序尝试其他可用 upstream**，直到成功或全部耗尽。`4xx` 错误不重试（因为属于客户端参数问题）。每次尝试都会独立记录日志。

### 心跳健康检查

服务启动后，会每分钟检查一次每个 upstream 的可用性（发送极简请求）。

- **连续失败 3 次**：自动将该 upstream 在配置文件中标记为 `enabled: false`，不再参与路由
- **恢复成功 1 次**：自动将该 upstream 重新标记为 `enabled: true`

## upstream baseUrl 说明

`baseUrl` 支持带或不带尾部斜杠。例如以下两种写法等价：

```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-your-key --models kimi-k2-5
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding/ sk-your-key --models kimi-k2-5
```

代理在转发到 `/v1/messages` 等路径时会自动正确拼接，不会丢失 `/coding` 路径。

## 注意事项

- 当前仅支持 `anthropic` 协议 upstream（Kimi Code 已原生兼容）
- 日志存储在 `~/.model-router/logs.sqlite`
- 进程退出时会自动 flush 未写入的日志
- **API Key 安全**：妥善保管 upstream key，避免在公开场合泄露

## License

MIT
