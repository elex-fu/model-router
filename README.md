# model-router

轻量级 AI 模型代理服务，统一接入 Claude Code、OpenAI SDK 等客户端，支持 Anthropic ↔ OpenAI 双向协议桥接、多 Key 路由、模型重写、用量统计与本地 Web 控制台。支持 Kimi、DeepSeek，以及自定义 OpenAI Chat、Anthropic Messages 和原生 Responses 上游。

实现边界与配置字段见 [完整技术方案](docs/model-router-console-technical-design.md)及 [V2 配置示例](docs/examples/model-router-console-v2.example.json)。供应商账号必须由你自行提供；没有官方凭证也可以使用本地 Ollama 验证代理链路。

生产部署和容器、systemd、launchd 样例见 [部署指南](deploy/README.md)。

## Web 控制台与 V2 配置

构建要求 Node.js 20.19+ 或 22.12+。

运行 `npm install && npm run build` 后执行 `model-router start`。V2 默认将代理绑定到 `127.0.0.1:15005`，管理端绑定到 `127.0.0.1:15006`；浏览器打开 [http://127.0.0.1:15006/admin/](http://127.0.0.1:15006/admin/)。首次启动会在本机终端输出限时 bootstrap token，用它创建管理员账号。管理端默认只监听回环地址；如要经反向代理公开访问，应先设置固定的 `publicAdminBaseUrl`、TLS 和可信代理网段。

已有 V1 配置会在首次 V2 启动时迁移；迁移前旧配置会加密备份。UI 管理的上游凭证加密保存在本地数据库，UI 与配置导出不会回传凭证值；新增代理 Key 仅创建或轮换时显示一次。运行中的 V2 服务请通过管理端修改配置，离线 CLI 写入会拒绝，避免覆盖在线状态。

如需直接在本机配置文件中填写上游 Key，使用 `secret: { "type": "inline", "value": "你的供应商 Key" }`。`value` 只校验非空，不限制不同供应商的 Key 格式；配置文件应设为仅当前用户可读（0600），并避免提交到版本库。`type: "env"` 则表示 `name` 是环境变量名，不是 Key 本身；管理界面、API、脱敏导出不会返回 inline 明文，历史快照会加密保存。

离线维护可使用 `model-router config:validate --config <path>`、`config:migrate --dry-run`、`config:apply <source> --config <target> --expected-revision <n>` 和 `backup:create --config <path>`。备份包含配置、加密主密钥及 SQLite 一致性快照。**在线** `POST /admin/api/v1/maintenance/jobs` 的 `restore` 任务仍只对配置做 CAS 恢复并补齐缺失的 secret，不替换控制库或历史用量库；不要把它当作全量恢复，也不要在浏览器里触发数据库替换。

完整恢复必须先停止代理及管理服务，并确保恢复期间不会被进程管理器自动重启，再在服务器本机执行：

```sh
model-router backup:restore <backupId> --config <配置文件绝对路径> --expected-revision <当前配置版本号>
```

`backupId` 来自已完成的备份任务结果；`--expected-revision` 是**当前**持久化配置版本，不是备份版本。离线命令校验备份与停机状态，恢复配置、`master.key`、`control.sqlite`，并把备份中的 `telemetry.sqlite` 恢复为运行时 `logs.sqlite`。执行前会保留可恢复的 `restore-safety-*` 当前状态快照；请确认恢复结果及重启后的数据无误后再由运维人员决定如何保留或清理它，不要提前删除。若命令报告中断回滚或拒绝执行，保持服务停止、检查报错及快照，再重试；不要通过浏览器或手工复制单个 SQLite 文件绕过校验。

本地验证可在“上游”页面选择 “Ollama 本地验证”，地址 `http://127.0.0.1:11434/v1`、模型 `qwen2.5-coder:7b`、认证方式 `none`。随后创建路由、代理访问 Key，在“测试台”或客户端通过 `http://127.0.0.1:15005/v1/chat/completions` 发起请求。Ollama 只用于本地功能验证，不能代表 Kimi、DeepSeek 等云端模型的协议细节或价格。用量页将缺失 usage 的尝试标为未知；费用仅在你配置相应模型价格后估算，不能当作账单。

本机提供的 Ollama 版本为 `0.34.3`，该模型声明上下文为 32768 tokens；控制台不会把“模型已安装”自动升级为工具、图片或推理能力已验证。

运行 `npm run test:live:ollama` 可执行本地 Ollama 代理冒烟；普通 `npm test` 只运行离线单元与集成测试，不会自动调用模型或产生云端费用。浏览器 E2E 单独运行 `npm run test:e2e`，可使用 Playwright 默认的 Chromium（需先安装：`npx playwright install chromium`）；如果环境已安装 Google Chrome，也可运行 `E2E_USE_SYSTEM_CHROME=1 npm run test:e2e` 使用系统 Chrome。Kimi/DeepSeek 的专用凭证冒烟分别由 `test:live:kimi` 和 `test:live:deepseek` 显式触发，仍需设置对应的 `*_LIVE_API_KEY` 与 `*_LIVE_MODEL` 环境变量；它们不是完整协议能力矩阵验收。

账号授权页仅对已验证的 OAuth 能力开放操作；未验证的设备流或客户端凭证流程不会伪装成可用。原生 Responses 只转发到声明支持它的上游，Chat/Anthropic 桥接不会冒充完整 Responses 能力。

下文的 `upstream:add`、`key:create` 等命令示例主要为旧版 CLI 兼容说明。V2 配置在服务停止时可使用 CLI 修改；服务运行时请使用 Web 控制台或管理 API。新增上游后还需发布路由，客户端才能调用对应模型。

验证边界：自动化测试覆盖供应商 URL、认证、协议转换、SSE、权限与配额；本地 Ollama 已验证非流式、流式和管理端测试台。Kimi/DeepSeek 的真实账号、模型能力与费用仍需使用专用凭证逐项确认。旧版日志迁移后以 `legacyLogRows` 单列，不会假装能从旧行恢复重试链；超出明细保留期的统计仅支持已归档的完整 UTC 日及已保存维度。

## 特性

- **双向协议桥接**：客户端可走 Anthropic（`/v1/messages`）或 OpenAI（`/v1/chat/completions`）协议，上游可选 Anthropic 或 OpenAI；4 种 client/upstream 组合（`a→a` `o→o` `a→o` `o→a`）全部可用
- **OpenAI Responses API**：支持 `/v1/responses` 与 `/v1/responses/compact`，兼容 Codex CLI
- **modelMap 模型重写**：在 upstream 上配置 `pattern → realModel` 映射，支持精确匹配 + glob 通配（`*`、`?`），可让客户端用任意名字调用上游
- **同 upstream 多 Key 自动调度**：每个 upstream 支持配置多个 API Key，请求时轮询调度；某个 Key 连续失败 3 次后自动冷却 5 分钟，同 upstream 内兜底切换到其它 Key
- **多 upstream 故障降级 + 熔断器**：同一 model 可挂多个 upstream，失败自动降级到其它 upstream；每个 upstream 独立 Circuit Breaker（Closed/Open/HalfOpen），防止故障扩散
- **代理 Key 鉴权**：为不同使用方分配独立的代理 key，认证错误按客户端协议返回
- **上游认证策略区分**：支持 `Authorization: Bearer`、`x-api-key`、经过校验的自定义 Header，以及 OAuth 动态令牌解析与受限透传
- **Copilot 请求优化**：上游启用 `copilotOptimized` 后，自动执行请求分类、thinking 块剥离、tool_result 合并、warmup 模型降级、确定性 ID 注入
- **System Prompt 计费头清洗**：自动剥离 Claude Code CLI 注入的 `x-anthropic-billing-header` 前缀，避免 upstream 400
- **流式 + 非流式全程支持**：SSE 状态机在桥接两端正确还原 `tool_use`、`tool_calls`、`finish_reason`、usage 计数
- **异步日志记录**：每条请求记录 `client_protocol` / `upstream_protocol` / 模型 / token / 耗时,本地 SQLite
- **健康检查端点**：`GET /healthz` 返回 200 + `{status:"ok",db:"ok"}`，反代 / 监控可直接探活；DB 不可达时返回 503
- **认证防爆破**：同一 IP 在 5 分钟内连续 10 次认证失败后，后续请求直接 429，成功一次自动清零
- **X-Forwarded-For 信任配置**：V2 仅信任 `server.trustedProxyCidrs` 指定的反代地址；单独使用旧版 `--trust-proxy` 不会放宽信任范围
- **连接防泄漏**：客户端断开时自动中止上游 fetch；SSE 流 60s 无数据自动关闭，防止僵尸连接堆积
- **SQLite WAL**：`PRAGMA journal_mode=WAL` 提升并发写入吞吐量，读写互不阻塞
- **自动日志清理**：按 `server.logRetentionDays`（默认 30 天）自动清理旧日志，启动即执行并每 24h 轮询
- **纯 CLI 管理**:命令行管理 key、upstream、modelMap、日志、统计，并附带 upstream 探活命令

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

输出：
```
Created proxy key: my-device
Key: mrk_xxxxxxxxxxxxxxxxxxxx
```

### 添加上游

#### Anthropic 协议上游(Kimi 等)

```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-your-kimi-key \
  --models kimi-k2-5
```

#### OpenAI 协议上游

```bash
model-router upstream:add deepseek-1 deepseek openai https://api.deepseek.com sk-your-ds-key \
  --models deepseek-chat
```

#### 同 upstream 配置多 Key（逗号分隔）

```bash
model-router upstream:add kimi-code kimi anthropic https://api.kimi.com/coding sk-a,sk-b,sk-c \
  --models kimi-k2-5
```

请求时会轮询从 `sk-a`、`sk-b`、`sk-c` 中选一个；某个 Key 连续失败 3 次后冷却 5 分钟，自动切换到同 upstream 的其它 Key。

#### 带 modelMap：让客户端用 Claude 名字调用 OpenAI 上游

```bash
model-router upstream:add ds-bridge deepseek openai https://api.deepseek.com sk-your-ds-key \
  --map "claude-sonnet-4-5=deepseek-chat,claude-haiku*=deepseek-chat"
```

之后 Claude Code 发出 `claude-sonnet-4-5` 请求会被代理改写为 `deepseek-chat` 转发给 DeepSeek，响应再被改写回 Anthropic 格式返回。

#### 上游认证策略区分

默认使用 `Authorization: Bearer <apiKey>` 访问上游。部分第三方服务使用 `x-api-key`：

```bash
model-router upstream:add kimi-2 kimi anthropic https://api.kimi.com/coding sk-key \
  --models kimi-k2-5 --auth-mode x-api-key
```

#### Codex CLI OAuth 透传

若 upstream 是 OpenAI 官方（Codex CLI 需要 OAuth token 直达上游），配置 `passThroughAuth`：

```bash
model-router upstream:add openai-official openai openai https://api.openai.com "" \
  --models gpt-5.4 --pass-through-auth
```

此时模型路由不再使用配置的 `apiKeys`，而是把客户端发来的 `Authorization` 头原样转发给 OpenAI。

#### 动态 OAuth 令牌解析

第三方上游若采用 OAuth client_credentials 签发临时 token，可配置动态解析：

```json
{
  "name": "azure-codex",
  "provider": "azure",
  "protocol": "openai",
  "baseUrl": "https://my-resource.openai.azure.com/openai",
  "apiKeys": [],
  "models": ["gpt-5.4"],
  "enabled": true,
  "authMode": "bearer",
  "oauth": {
    "tokenUrl": "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
    "clientId": "my-client-id",
    "clientSecret": "my-client-secret",
    "scope": "https://cognitiveservices.azure.com/.default"
  }
}
```

代理会在 token 过期前自动刷新，并按 `authMode` 注入到上游请求头。

#### Copilot 请求优化

若上游用于 GitHub Copilot 场景，启用 `copilotOptimized` 以自动执行以下优化：

- **请求分类**：识别 warmup、compact、subagent、user-initiated 请求
- **thinking 块剥离**：从 assistant messages 中移除 `thinking` / `redacted_thinking`，避免 Copilot 400
- **tool_result 合并**：将相邻的 `[tool_result, text]` 合并为单个 tool_result，减少消息数
- **warmup 模型降级**：warmup 请求自动降级到 `gpt-4o-mini`，降低计费
- **确定性 ID 注入**：基于 session_id + 最后用户内容生成确定性 `x-request-id` / `x-interaction-id`，用于 Copilot 计费去重

```bash
model-router upstream:add copilot-1 copilot openai https://api.githubcopilot.com sk-key \
  --models gpt-4o --copilot-optimized
```

### 启动代理

```bash
# 默认端口 15005
model-router start

# 指定端口
model-router start --port 15005

# 在 V2 配置的 server.trustedProxyCidrs 中指定可信反代地址后启动
model-router start --config /path/to/config.json

# daemon 后台运行
model-router start --daemon --log-file /var/log/model-router.log
```

### 客户端配置

#### Claude Code CLI(Anthropic 协议)
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:15005"
export ANTHROPIC_API_KEY="mrk_xxxxxxxxxxxxxxxxxxxx"
claude
```

#### Codex CLI(OpenAI Responses API)
```bash
export OPENAI_BASE_URL="http://127.0.0.1:15005"
# 将 Codex CLI 的 OAuth token 注册为 model-router 代理 key
codex
```

Codex CLI 使用 `/v1/responses` 端点。如需将 OAuth token 透传给 OpenAI 官方 upstream，在 upstream 配置中启用 `passThroughAuth: true`，此时客户端的 `Authorization` 头会直接转发到上游。

#### OpenAI SDK(OpenAI 协议)
```python
from openai import OpenAI
client = OpenAI(
    base_url="http://127.0.0.1:15005/v1",
    api_key="mrk_xxxxxxxxxxxxxxxxxxxx",
)
```

代理按请求 path 自动决定 clientProto：`/v1/messages` → Anthropic，`/v1/chat/completions` / `/v1/responses*` → OpenAI；其它 path 返回 404。代理鉴权同时接受 `x-api-key: <key>` 与 `Authorization: Bearer <key>`。

#### 流式响应

两种协议均支持 `stream: true`，SSE 事件链在桥接两端按目标协议正确还原。

```bash
curl -N -X POST http://127.0.0.1:15005/v1/messages \
  -H "x-api-key: mrk_xxxxxxxxxxxxxxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

收到的事件序列示例(Anthropic 格式)：
```
event:message_start    →  message 元数据 + input_tokens
event:content_block_start
event:content_block_delta  ×N
event:content_block_stop
event:message_delta    →  stop_reason + 完整 usage
event:message_stop
```

## CLI 命令详解

### 服务启动

```bash
# 默认端口 15005,默认配置 ~/.model-router/config.json
model-router start

# 指定端口
model-router start --port 18080

# 指定自定义配置文件
model-router start --port 15005 --config /etc/model-router/config.json

# 限制最大请求体 (默认 4MB)
model-router start --max-body-size 8mb

# V2 请在配置文件中设置 server.trustedProxyCidrs；单独的旧 flag 不启用信任
model-router start --config /etc/model-router/config.json

# 后台运行并指定日志/PID 文件
model-router start --daemon --log-file /var/log/model-router.log --pid-file /var/run/model-router.pid
```

### Key 管理

```bash
# 创建
model-router key:create my-device

# 列出
model-router key:list

# 删除
model-router key:delete my-device
```

### 上游管理

```bash
# 添加(协议必须为 anthropic 或 openai, apiKeys 支持逗号分隔多 Key)
model-router upstream:add <name> <provider> <protocol> <baseUrl> <apiKeys> \
  --models m1,m2 \
  --map "pattern1=target1,pattern2=target2"

# 列出
model-router upstream:list

# 删除
model-router upstream:delete <name>
```

`upstream:list` 输出包含 `keys` 列(Key 数量，默认 mask) 与 `modelMap` 列(条目数)。

### modelMap 管理

modelMap 用于把客户端请求的 model 重写为 upstream 真正的 model 名;条目为 `pattern → target`,匹配优先级：

1. **精确匹配** — `modelMap` 中存在完全相等的 key
2. **Glob 匹配** — 按 `Object.entries` 顺序找到第一个匹配 (`*` 任意字符串、`?` 单字符)
3. **`models[]` 透传** — 如果都不命中而 `models[]` 包含该 model,直接透传

```bash
# 添加/更新条目
model-router upstream:map:set ds-bridge "claude-sonnet-4-5" "deepseek-chat"
model-router upstream:map:set ds-bridge "claude-haiku*"     "deepseek-chat"

# 删除条目
model-router upstream:map:delete ds-bridge "claude-haiku*"

# 列出条目
model-router upstream:map:list ds-bridge
```

### 探活测试

向 upstream 发送一个最小化 `max_tokens=1` 的探活请求,验证 baseUrl + apiKey + 选定 model 是否可用。

```bash
# 自动从 models[] 或 modelMap 中挑一个 model
model-router test ds-bridge

# 显式指定 model
model-router test ds-bridge --model deepseek-chat
```

### 日志查询

每条请求都会异步写入 `~/.model-router/logs.sqlite`,包含 client/upstream 协议、模型、token、耗时。

```bash
# 最近 20 条
model-router logs

# 最近 50 条
model-router logs --tail 50

# 按 proxy key 过滤
model-router logs --key my-device

# 按协议过滤(client_protocol 或 upstream_protocol 任一命中)
model-router logs --protocol anthropic
model-router logs --protocol openai
```

输出列说明:
- `cp` — clientProtocol (`anthropic` / `openai` / `-`)
- `up` — upstreamProtocol (`anthropic` / `openai` / `-`)
- `model` — 客户端请求的 model (即 `request_model`)
- `upstream` — 实际命中的 upstream 名字
- `status` — HTTP 状态码
- `input` / `output` — 输入/输出 tokens

> SQLite 表 `request_logs` 还存有 `actual_model`(modelMap 重写后实际发给 upstream 的 model)、`is_streaming`、`error_message` 等列,可用 `sqlite3 ~/.model-router/logs.sqlite` 直接查询审计。

### 统计查询

```bash
# 今日
model-router stats

# 指定日期
model-router stats --date 2026-05-02
```

## 配置文件

默认路径:`~/.model-router/config.json`

```json
{
  "server": {
    "port": 15005,
    "bindAddress": "127.0.0.1",
    "logFlushIntervalMs": 5000,
    "logBatchSize": 100,
    "logRetentionDays": 30
  },
  "proxyKeys": [
    {
      "name": "my-device",
      "key": "mrk_xxxxxxxxxxxxxxxxxxxx",
      "enabled": true,
      "createdAt": "2026-05-02T10:00:00Z"
    }
  ],
  "upstreams": [
    {
      "name": "kimi-1",
      "provider": "kimi",
      "protocol": "anthropic",
      "baseUrl": "https://api.kimi.com/coding",
      "apiKeys": ["sk-kimi-key"],
      "models": ["kimi-k2-5"],
      "enabled": true
    },
    {
      "name": "ds-bridge",
      "provider": "deepseek",
      "protocol": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKeys": ["sk-ds-key"],
      "models": [],
      "modelMap": {
        "claude-sonnet-4-5": "deepseek-chat",
        "claude-haiku*": "deepseek-chat"
      },
      "enabled": true
    }
  ]
}
```

## 架构

```
Client (Anthropic /v1/messages | OpenAI /v1/chat/completions | Codex /v1/responses)
        ↓
┌─────────────────────────────────────────────────────────────┐
│  HTTP Server (bindAddress:port)                             │
│  • maxBodyBytes 拦截超大请求体 → 413                        │
│  • GET /healthz → 200/503 (无鉴权)                          │
│  • ConfigStore 内存缓存 (mtime 校验，避免每请求读盘)        │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  Path → clientProto                                         │
│  /v1/messages → anthropic                                   │
│  /v1/chat/completions → openai                              │
│  /v1/responses* → openai                                    │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  getClientIp(req, trustProxy)                               │
│  trustProxy=false → socket.remoteAddress                    │
│  trustProxy=true  → X-Forwarded-For 第一跳                  │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  IpAuthBlocker                                              │
│  同一 IP 5min/10 次认证失败 → 429 (预鉴权门)                │
│  成功一次自动清零                                           │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  Auth (代理 Key 校验)                                       │
│  支持 Authorization: Bearer <key> 或 x-api-key: <key>       │
│  错误按 clientProto 包装 (anthropic/openai 格式)            │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  KeyLimiter (RPM + 日 Token 配额)                           │
│  超限直接 429，不命中上游                                   │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  Router (modelMap + upstream 选择)                          │
│  精确匹配 → glob 匹配 → models[] 透传                       │
│  同一 model 多 upstream 候选，随机排序                      │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  CircuitBreaker (per-upstream)                              │
│  • Closed → Open: 连续失败达阈值                            │
│  • Open → HalfOpen: 恢复超时后允许单次探测                  │
│  • HalfOpen → Closed: 探测成功达阈值                        │
│  • 4xx 错误 neutralRelease，不计入熔断                      │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│   pickBridge(clientProto, upstreamProto)                    │
│   • PassthroughAnthropicBridge (a→a)                        │
│   • PassthroughOpenAiBridge    (o→o)                        │
│   • AnthToOpenAIBridge         (a→o)                        │
│   • OpenAIToAnthBridge         (o→a)                        │
│   rewriteUrlPath / transformRequest / transformResponse     │
│   transformStream (SSE 协议转换 + usage 提取)                │
│   • preprocess: cache_control 注入 / thinking 注入          │
│   • rectifier: thinking 签名修复 / budget 修复              │
│   • copilotOptimizer: thinking 剥离 / tool 合并 / warmup降级 │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  KeyPool (同 upstream 多 Key 调度)                          │
│  • 轮询选择可用 Key (round-robin)                           │
│  • Key 连续 3 次失败 → 冷却 5 分钟                          │
│  • 同 upstream 内兜底切换其它 Key                           │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  Upstream fetch (undici Agent + keep-alive)                 │
│  • 连接池复用，减少 TCP 握手延迟                            │
│  • 客户端断开 → 自动取消上游请求                            │
│  • SSE 流 60s idle → 自动关闭连接                           │
│  • 5xx / 网络错误 → key 级重试 → upstream 级 failover       │
│  • authMode: bearer / x-api-key / oauth / passThrough       │
└────────────────────────┬────────────────────────────────────┘
                         ↓
       Upstream API
                         ↑
┌─────────────────────────────────────────────────────────────┐
│  Async Logger                                               │
│  内存队列 → SQLite (WAL 模式)                               │
│  字段: client/upstream 协议、模型、token、耗时、状态码      │
│  自动按 logRetentionDays 清理旧日志                         │
└─────────────────────────────────────────────────────────────┘
```

## 高级特性

### 同 upstream 多 Key 调度

每个 upstream 的 `apiKeys` 支持配置多个 Key。代理在每次请求时：

1. **轮询调度** — 从该 upstream 的可用 Key 中按 round-robin 顺序挑选，保证负载均衡
2. **Key 级失败兜底** — 若某个 Key 返回 `5xx` 或网络错误，立即在同 upstream 内尝试下一个可用 Key；`4xx` 错误不重试（视为配置/权限问题）
3. **冷却避障** — 某个 Key 连续失败 3 次后，自动进入 5 分钟冷却期，期间不再被选中；成功后立即解除冷却
4. **Upstream 级 failover** — 若同 upstream 的所有 Key 都失败，再降级到下一个 upstream 候选

多 Key 调度让同一 upstream 的配额可以充分利用，同时单 Key 异常不会影响整体可用性。

### 失败自动降级与熔断器

当 upstream 返回 `5xx` 或网络不可达时，代理会按随机顺序尝试其他可用 upstream，直到成功或全部耗尽。`4xx` 错误不重试。每次尝试都按 client 协议包装错误，并独立记录日志。

每个 upstream 拥有独立的 **Circuit Breaker**，状态机如下：

- **Closed**（正常）：请求正常通过；连续失败达 `failureThreshold`（默认 5 次）后转入 Open
- **Open**（熔断）：所有请求直接跳过该 upstream；经过 `recoveryTimeoutMs`（默认 30s）后转入 HalfOpen
- **HalfOpen**（探测）：允许一次试探请求；成功达 `successThreshold`（默认 2 次）后关闭，失败则重新 Open

客户端侧错误（4xx）通过 `neutralRelease` 处理，不计入熔断失败计数，避免正常请求触发误熔断。

### 连接生命周期与防泄漏

每个请求分配独立的 `AbortController`：
- **客户端断开** (`req/res` 的 `close` 事件) → 立即取消上游 `fetch`，避免上游继续消耗 token
- **SSE idle timeout** → 流式响应若 60s 无数据块到达，自动关闭连接并结束响应，防止僵尸 SSE 挂死
- **非流式 body 读取** → `fetch` signal 同样覆盖响应 body 消费阶段，客户端中途断连即停

> 上游侧的 TCP 关闭由 `fetch` 的 `AbortSignal` 驱动；对于使用 `tee()` 做 SSE 解析的 bridge，客户端取消会级联终止消费端 reader，不会阻塞在 stalled stream 上。

### SQLite WAL 模式

日志库默认启用 `PRAGMA journal_mode = WAL; synchronous = NORMAL`：
- 写入不阻塞读取，高并发场景下查询日志/统计不会卡死请求写入
- 崩溃恢复更快，性能显著优于默认 `DELETE` journal

### 自动日志清理

启动时立即执行一次，随后每 24 小时轮询：
- 按 `config.server.logRetentionDays` 删除过期 `request_logs`（默认 30 天）
- 可通过 `server.logRetentionDays = 0` 关闭自动清理，改用 `model-router maintenance:purge --older-than Nd` 手动运维
- shutdown 时自动清除定时器

### 心跳健康检查

启动后立即跑一轮、之后每分钟检查一次每个 upstream 的可用性。健康检查会遍历 upstream 的所有 Key 逐一探活：

- 任意 Key 成功 → upstream 保持/恢复启用，并对该 Key 调用 `markSuccess` 清零失败计数
- **所有 Key 都失败** → 记为一次"全部失败"轮次；连续 3 轮全部失败才会自动 `enabled=false` 摘流量

> 健康检查**不**调用 `markFailure`，避免探活误杀正常 Key。探测使用 `models[0]` 拼一条 `max_tokens=5` 的请求 (5 秒超时)，所以仅对 `models[]` 至少有一项的上游生效；纯 `modelMap` 上游可改用 `model-router test <name>` 手动探活。

### modelMap glob 匹配

```
"claude-sonnet-*"   → "deepseek-chat"   # 匹配 claude-sonnet-4-5、claude-sonnet-3
"claude-?-haiku"    → "deepseek-chat"   # 匹配 claude-3-haiku、claude-4-haiku
"gpt-*"             → "deepseek-chat"   # 匹配所有 gpt-* 请求
```

精确匹配优先于 glob;多个 glob 都命中时按 `Object.entries` 顺序(插入顺序)取第一个。

### Copilot 请求优化

在 upstream 上启用 `copilotOptimized: true` 后，代理会在请求转发前自动执行以下优化（全部面向 Copilot 场景设计）：

| 优化项 | 说明 |
|--------|------|
| **请求分类** | 识别 warmup（极短用户消息）、compact（消息数>20）、subagent（system 含 subagent 关键字）、user-initiated |
| **thinking 块剥离** | 从 assistant messages 中移除 `thinking` / `redacted_thinking` 块；Copilot  upstream 会拒绝这些块 |
| **tool_result 合并** | 将相邻的 `[tool_result, text]` 合并为单个 tool_result（内容拼接），减少消息数 |
| **warmup 模型降级** | 识别为 warmup 的请求自动将模型降级为 `gpt-4o-mini`（可配置），降低计费 |
| **确定性 ID 注入** | 基于 `x-claude-code-session-id` + 最后用户内容生成确定性 UUID，注入 `x-request-id` 与 `x-interaction-id`，用于 Copilot 计费去重 |

### 上游认证策略

代理支持四种上游认证模式，通过 `authMode` / `passThroughAuth` / `oauth` 配置：

1. **`authMode: 'bearer'`（默认）** — 使用 `Authorization: Bearer <apiKey>` 访问上游
2. **`authMode: 'x-api-key'`** — 使用 `x-api-key: <apiKey>` 访问上游
3. **`passThroughAuth: true`** — 将客户端的原始 `Authorization` 头直接转发给上游；适用于 Codex CLI OAuth token 直达 OpenAI 官方的场景
4. **`oauth: { tokenUrl, clientId, clientSecret, scope? }`** — 代理自动通过 client_credentials 流程获取 access_token，缓存并按 `authMode` 注入；token 过期前自动刷新

### Anthropic 协议增强

面向 Anthropic upstream 时，代理自动注入以下协议头：

- **`anthropic-version: 2023-06-01`**（若客户端未指定）
- **`anthropic-beta`** — 包含 `claude-code-20250219`，并根据模型追加 `interleaved-thinking-2025-05-14` 或 `context-1m-2025-08-07`

同时在请求体预处理阶段：
- 为长对话自动注入 `cache_control` breakpoints（最多 4 个）
- 为支持 thinking 的模型自动注入 `thinking` 块（enabled 或 adaptive 模式）
- **Thinking Budget Rectifier** — 若 upstream 返回 thinking 签名错误或 budget 错误，代理会自动修正请求并重试一次，无需客户端介入

### System Prompt 计费头清洗

Claude Code CLI 会在 system prompt 开头注入 `x-anthropic-billing-header: cc_version=...; cch=<rotating>`，部分第三方 upstream 会将这行文本当作有效 prompt 内容处理，导致异常计费或 400 错误。

代理在预处理阶段自动检测并剥离该前缀：
- 支持字符串 system prompt 与 TextBlock 数组
- 仅剥离开头的计费头行，保留后续内容
- 若 system prompt 仅有计费头，结果为空字符串

### 性能优化

代理在以下环节做了针对性性能优化：

- **undici Agent 连接池** — 上游 fetch 复用 TCP 连接，`keepAliveTimeout: 30s`，减少重复握手延迟
- **ConfigStore 内存缓存** — 配置文件按 `mtime + size` 缓存，避免每个请求都同步读盘
- **round-robin Key 调度** — 替代每请求的 Fisher-Yates 洗牌，降低 CPU 开销
- **Body 预分配** — 有 `Content-Length` 时直接 `Buffer.allocUnsafe` 预分配，避免 `Buffer.concat` 的 O(n²) 累积
- **同协议透传短路** — `a→a` / `o→o` 时跳过无意义的 JSON parse/stringify，直接透传 Buffer

## upstream baseUrl 说明

`baseUrl` 支持带或不带尾部斜杠,代理在拼接 `/v1/messages` / `/v1/chat/completions` 时会处理一致:

```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-key --models kimi-k2-5
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding/ sk-key --models kimi-k2-5
# 多 Key
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-a,sk-b --models kimi-k2-5
```

## 开发

```bash
# 开发模式直接运行
npm run dev -- start --port 15005

# 编译
npm run build

# 运行编译后版本
npm start

# 测试 (352 个用例:配置/路由/KeyPool/桥接/SSE/集成/断开/防爆破/WAL/健康检查/熔断器/OAuth/Copilot)
npm test
```

测试覆盖（共 352 个用例）：

| 模块                          | 用例数 | 说明                                                        |
|-------------------------------|--------|-------------------------------------------------------------|
| `tests/config/`               | 15     | ConfigStore CRUD + modelMap 字段 + 默认配置                  |
| `tests/router/select.test.ts` | 8      | 精确/glob/`models[]` 透传/enabled 过滤/multi-upstream 选择    |
| `tests/protocol/glob.test.ts` | 10     | glob 通配符 (`*` `?`) 边界                                   |
| `tests/protocol/bridge.test.ts` | 4    | `pickBridge` 矩阵 4 种组合                                   |
| `tests/protocol/passthrough-*.test.ts` | 10 | a→a / o→o 透传 + SSE tee                              |
| `tests/protocol/anth-to-openai.test.ts` | 16 | Anthropic↔OpenAI 单向(请求/响应/流式)                      |
| `tests/protocol/openai-to-anth.test.ts` | 16 | OpenAI↔Anthropic 反向(请求/响应/流式)                      |
| `tests/protocol/sse.test.ts`  | 6      | SSE 解析/写入/CRLF/multi-line                                |
| `tests/integration/proxy.test.ts` | 35  | 端到端 4 种桥接 + 鉴权 + authMode + passThroughAuth + OAuth + failover + 多 Key 调度 + Responses API |
| `tests/server/abort.integration.test.ts` | 2 | 客户端断开传播 + SSE idle timeout                          |
| `tests/server/healthz.test.ts` | 6      | /healthz 状态码/方法/DB 探活                                 |
| `tests/server/clientIp.test.ts` | 8     | XFF 信任开关 8 种场景                                        |
| `tests/server/ipBlocker.integration.test.ts` | 4 | IP 防爆破 4 种场景                                    |
| `tests/server/keyPool.test.ts` | 11     | Key 轮询/失败计数/冷却/恢复/getAvailableKeys                 |
| `tests/server/circuitBreaker.test.ts` | 8 | Closed/Open/HalfOpen 状态转换 + neutralRelease + 隔离性     |
| `tests/server/copilotOptimizer.test.ts` | 12 | 请求分类 / thinking 剥离 / tool 合并 / warmup 降级 / 确定性 ID |
| `tests/server/oauth.test.ts`  | 7      | OAuth client_credentials / 缓存 / 刷新 / 错误处理              |
| `tests/server/preprocess.test.ts` | 20 | cache_control 注入 / thinking 注入 / billing header 清洗      |
| `tests/server/rectifier.test.ts` | 25 | thinking 签名检测与修复 / budget 错误检测与修复              |
| `tests/server/proxy-usage.test.ts` | 5  | extractNonStreamUsage / injectAnthropicHeaders / stripThinkingBetas |
| `tests/health/monitor.test.ts` | 6      | 健康检查: 单 Key/多 Key/全部失败禁用/恢复/无 keyPool 兼容     |
| `tests/limit/limiter.test.ts` | 8      | RPM / 日 token 配额 / UTC 午夜重置                           |
| `tests/logger/store.test.ts`  | 10     | SQLite CRUD + 统计查询 + WAL 模式验证                        |

## 注意事项

- 默认端口 `15005`,如有冲突可用 `--port` 覆盖
- 默认绑定 `127.0.0.1`,需要对外暴露请显式 `--bind 0.0.0.0`(推荐放反代后)
- **XFF 安全**: V2 仅在 `server.trustedProxyCidrs` 指定实际反代网段；直接暴露公网时留空，否则客户端可伪造 `X-Forwarded-For`
- 日志存储在 `~/.model-router/logs.sqlite`(WAL 模式),进程退出会自动 flush 未写入日志；默认保留 30 天，可在配置中调整 `logRetentionDays`
- **API Key 安全**:妥善保管上游凭证与代理 Key；V2 代理 Key 只存摘要，无法通过 `--show-secrets` 恢复，遗失时需轮换
- 协议字段必须为 `anthropic` 或 `openai`,否则 `upstream:add` 会拒绝

## 多用户与运营

### 配额与限流

每个代理 key 可独立设置请求频率与每日 token 配额:

```bash
# 创建 key 时配置
model-router key:create alice \
  --rpm 30 \
  --daily-tokens 2000000 \
  --upstreams kimi-code,ds-bridge \
  --models 'claude-sonnet-*'

# 后续调整
model-router key:update alice --rpm 60
model-router key:update alice --daily-tokens 5000000
```

超出 RPM 或日 token 时,代理直接返回 `429`(按客户端协议包装为 `rate_limit_error` / `rate_limit_exceeded`),不命中任何上游。

### 用量统计

```bash
# 单个 key 7 天用量
model-router stats:key alice --since 7d

# 全部 key 排行
model-router stats:keys --since 7d

# 列出所有 key,带 used_today / last_used 列(secret 默认 mask)
model-router key:list
```

### 维护

自动清理已按 `server.logRetentionDays` 每日运行，以下命令用于手动运维或临时调整：

```bash
# 手动清理指定天数前的请求日志
model-router maintenance:purge --older-than 90d

# 回收 SQLite 空间（清理后执行可缩小文件体积）
model-router maintenance:vacuum
```

> `maintenance:purge` 与自动清理共用同一 `purgeOlderThan` 实现，可放心在运行中的服务上手动执行（WAL 模式下读写互不阻塞）。

## 对外部署

### 推荐姿势:反代 + daemon

1. `--bind 127.0.0.1`(默认)只允许本机访问
2. Caddy / nginx 在前,负责 TLS、限速、访问日志
3. 在 V2 配置的 `server.trustedProxyCidrs` 中指定反代地址，使代理仅采信该来源的 `X-Forwarded-For`
4. `--daemon` 让服务后台运行;`--pid-file` / `--log-file` 控制 PID 与日志路径

启动:

```bash
model-router start \
  --bind 127.0.0.1 \
  --port 15005 \
  --max-body-size 4mb \
  --config /etc/model-router/config.json \
  --daemon \
  --log-file /var/log/model-router.log \
  --pid-file /var/run/model-router.pid
```

> `--daemon` 会将 CLI 参数传给子进程；V2 的可信代理范围始终以配置文件为准。

管理:

```bash
model-router status --pid-file /var/run/model-router.pid
model-router stop   --pid-file /var/run/model-router.pid
```

### Caddy 反代示例

```caddyfile
api.example.com {
  reverse_proxy 127.0.0.1:15005
}
```

### nginx 反代示例

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  ssl_certificate     /etc/ssl/certs/api.crt;
  ssl_certificate_key /etc/ssl/private/api.key;

  client_max_body_size 8m;

  location / {
    proxy_pass http://127.0.0.1:15005;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # 流式响应必须关
    proxy_read_timeout 600s;
  }
}
```

### systemd unit 示例(用户态)

`~/.config/systemd/user/model-router.service`:

```ini
[Unit]
Description=model-router proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/model-router start --bind 127.0.0.1 --port 15005
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启用:

```bash
systemctl --user daemon-reload
systemctl --user enable --now model-router
journalctl --user -u model-router -f
```

### macOS launchd plist 示例(用户态)

`~/Library/LaunchAgents/com.modelrouter.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.modelrouter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/model-router</string>
    <string>start</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>15005</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/usr/local/var/log/model-router.log</string>
  <key>StandardErrorPath</key>
  <string>/usr/local/var/log/model-router.err</string>
</dict>
</plist>
```

启用:

```bash
launchctl load ~/Library/LaunchAgents/com.modelrouter.plist
launchctl list | grep modelrouter
# 停服:
launchctl unload ~/Library/LaunchAgents/com.modelrouter.plist
```

### 健康检查与反代探活

代理暴露 `GET /healthz`(无鉴权,不计入日志),返回 `{"status":"ok","db":"ok"}` 表示进程正常且 SQLite 可读。Caddy / nginx / 上层 LB 均可直接拿来做 health check。SQLite 损坏或 fd 耗尽时会变成 503。

### 日志轮转

`--log-file` 指定的文件会持续追加,生产环境建议接管轮转:

```
# /etc/logrotate.d/model-router
/var/log/model-router.log {
  daily
  rotate 7
  missingok
  notifempty
  copytruncate     # 用 copytruncate 才不会让 daemon 写到已删除的 fd
  compress
}
```

> 不建议用 `move + create`(daemon 仍写老 fd);如果一定要切割,需配合 `model-router stop && start` 重启。

### 优雅关闭与超时

收到 `SIGTERM` / `SIGINT` 后,代理执行: 清除日志清理定时器 → 停止健康监控 → 排空日志队列 → 关闭 SQLite → 清理 PID 文件 → `server.close()`。`server.close()` 会等待所有进行中的请求处理完成。SSE idle timeout（60s）和客户端断开传播机制确保 stalled stream 不会无限阻塞关闭流程。

> **不要直接 `--bind 0.0.0.0`** 暴露未加 TLS 的代理:任何嗅探到端口的人都能消耗你的上游配额。

## License

MIT
