# model-router

轻量级 AI 模型代理服务，统一接入 Claude Code、OpenAI SDK 等客户端，支持 Anthropic ↔ OpenAI 双向协议桥接、多 Key 路由、modelMap 模型重写、异步日志记录与统计查询。

## 特性

- **双向协议桥接**：客户端可走 Anthropic（`/v1/messages`）或 OpenAI（`/v1/chat/completions`）协议，上游可选 Anthropic 或 OpenAI；4 种 client/upstream 组合（`a→a` `o→o` `a→o` `o→a`）全部可用
- **modelMap 模型重写**：在 upstream 上配置 `pattern → realModel` 映射，支持精确匹配 + glob 通配（`*`、`?`），可让客户端用任意名字调用上游
- **多 Key 路由 + 故障降级**：同一 model 可挂多个 upstream，失败自动随机降级
- **代理 Key 鉴权**：为不同使用方分配独立的代理 key，认证错误按客户端协议返回
- **流式 + 非流式全程支持**：SSE 状态机在桥接两端正确还原 `tool_use`、`tool_calls`、`finish_reason`、usage 计数
- **异步日志记录**：每条请求记录 `client_protocol` / `upstream_protocol` / 模型 / token / 耗时,本地 SQLite
- **健康检查端点**：`GET /healthz` 返回 200 + `{status:"ok",db:"ok"}`，反代 / 监控可直接探活；DB 不可达时返回 503
- **认证防爆破**：同一 IP 在 5 分钟内连续 10 次认证失败后，后续请求直接 429，成功一次自动清零
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

#### 带 modelMap：让客户端用 Claude 名字调用 OpenAI 上游

```bash
model-router upstream:add ds-bridge deepseek openai https://api.deepseek.com sk-your-ds-key \
  --map "claude-sonnet-4-5=deepseek-chat,claude-haiku*=deepseek-chat"
```

之后 Claude Code 发出 `claude-sonnet-4-5` 请求会被代理改写为 `deepseek-chat` 转发给 DeepSeek，响应再被改写回 Anthropic 格式返回。

### 启动代理

```bash
# 默认端口 15005
model-router start

# 指定端口
model-router start --port 15005
```

### 客户端配置

#### Claude Code CLI(Anthropic 协议)
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:15005"
export ANTHROPIC_API_KEY="mrk_xxxxxxxxxxxxxxxxxxxx"
claude
```

#### OpenAI SDK(OpenAI 协议)
```python
from openai import OpenAI
client = OpenAI(
    base_url="http://127.0.0.1:15005/v1",
    api_key="mrk_xxxxxxxxxxxxxxxxxxxx",
)
```

代理按请求 path 自动决定 clientProto：`/v1/messages` → Anthropic，`/v1/chat/completions` → OpenAI；其它 path 返回 404。代理鉴权同时接受 `x-api-key: <key>` 与 `Authorization: Bearer <key>`。

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
# 添加(协议必须为 anthropic 或 openai)
model-router upstream:add <name> <provider> <protocol> <baseUrl> <apiKey> \
  --models m1,m2 \
  --map "pattern1=target1,pattern2=target2"

# 列出
model-router upstream:list

# 删除
model-router upstream:delete <name>
```

`upstream:list` 输出包含 `modelMap` 列(条目数)。

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
    "logFlushIntervalMs": 5000,
    "logBatchSize": 100
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
      "apiKey": "sk-kimi-key",
      "models": ["kimi-k2-5"],
      "enabled": true
    },
    {
      "name": "ds-bridge",
      "provider": "deepseek",
      "protocol": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-ds-key",
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
Client (Anthropic /v1/messages | OpenAI /v1/chat/completions)
        ↓
┌─────────────────────┐
│  Path → clientProto │  /v1/messages → anthropic
│                     │  /v1/chat/completions → openai
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│       Auth          │  代理 key 校验,错误按 clientProto 包装
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│  Router (modelMap)  │  匹配候选 upstream,resolvedModel
└──────────┬──────────┘
           ↓
┌─────────────────────┐
│   pickBridge(       │  4 种组合:
│    clientProto,     │   • PassthroughAnthropicBridge (a→a)
│    upstreamProto)   │   • PassthroughOpenAiBridge    (o→o)
│                     │   • AnthToOpenAIBridge         (a→o)
│                     │   • OpenAIToAnthBridge         (o→a)
│  rewriteUrlPath     │
│  transformRequest   │
│  transformResponse  │
│  transformStream    │
│  wrapError          │
└──────────┬──────────┘
           ↓
       Upstream API
           ↑
┌─────────────────────┐
│   Async Logger      │  内存队列 → SQLite
│   (cp / up / ...)   │
└─────────────────────┘
```

## 高级特性

### 失败自动降级

当 upstream 返回 `5xx` 或网络不可达时,代理会按随机顺序尝试其他可用 upstream,直到成功或全部耗尽。`4xx` 错误不重试。每次尝试都按 client 协议包装错误,并独立记录日志。

### 心跳健康检查

启动后立即跑一轮、之后每分钟检查一次每个 upstream 的可用性。连续失败 3 次会自动 `enabled=false` 摘流量,恢复成功 1 次自动重新启用。

> 探测使用 `models[0]` 拼一条 `max_tokens=5` 的 anthropic 风格请求 (5 秒超时),所以仅对 `models[]` 至少有一项的上游生效;纯 `modelMap` 上游可改用 `model-router test <name>` 手动探活。

### modelMap glob 匹配

```
"claude-sonnet-*"   → "deepseek-chat"   # 匹配 claude-sonnet-4-5、claude-sonnet-3
"claude-?-haiku"    → "deepseek-chat"   # 匹配 claude-3-haiku、claude-4-haiku
"gpt-*"             → "deepseek-chat"   # 匹配所有 gpt-* 请求
```

精确匹配优先于 glob;多个 glob 都命中时按 `Object.entries` 顺序(插入顺序)取第一个。

## upstream baseUrl 说明

`baseUrl` 支持带或不带尾部斜杠,代理在拼接 `/v1/messages` / `/v1/chat/completions` 时会处理一致:

```bash
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding sk-key --models kimi-k2-5
model-router upstream:add kimi-1 kimi anthropic https://api.kimi.com/coding/ sk-key --models kimi-k2-5
```

## 开发

```bash
# 开发模式直接运行
npm run dev -- start --port 15005

# 编译
npm run build

# 运行编译后版本
npm start

# 测试 (94 个用例:配置/路由/4 种桥接/SSE 状态机/集成端到端)
npm test
```

测试覆盖:

| 模块                          | 用例数 | 说明                                                        |
|-------------------------------|--------|-------------------------------------------------------------|
| `tests/config/`               | 14     | ConfigStore CRUD + modelMap 字段                             |
| `tests/router/select.test.ts` | 8      | 精确/glob/`models[]` 透传/enabled 过滤/multi-upstream 选择    |
| `tests/protocol/glob.test.ts` | 10     | glob 通配符 (`*` `?`) 边界                                   |
| `tests/protocol/bridge.test.ts` | 4    | `pickBridge` 矩阵 4 种组合                                   |
| `tests/protocol/passthrough-*.test.ts` | 10 | a→a / o→o 透传 + SSE tee                              |
| `tests/protocol/anth-to-openai.test.ts` | 16 | Anthropic↔OpenAI 单向(请求/响应/流式)                      |
| `tests/protocol/openai-to-anth.test.ts` | 16 | OpenAI↔Anthropic 反向(请求/响应/流式)                      |
| `tests/protocol/sse.test.ts`  | 6      | SSE 解析/写入/CRLF/multi-line                                |
| `tests/integration/proxy.test.ts` | 10  | 端到端 4 种 client/upstream 组合 + 鉴权 + failover + 4xx 不重试 |

## 注意事项

- 默认端口 `15005`,如有冲突可用 `--port` 覆盖
- 默认绑定 `127.0.0.1`,需要对外暴露请显式 `--bind 0.0.0.0`(推荐放反代后)
- 日志存储在 `~/.model-router/logs.sqlite`,进程退出会自动 flush 未写入日志
- **API Key 安全**:妥善保管 upstream key 与代理 key;`key:list` / `upstream:list` 默认 mask,加 `--show-secrets` 才显示完整值
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

```bash
# 清理 90 天前的请求日志
model-router maintenance:purge --older-than 90d

# 回收 SQLite 空间
model-router maintenance:vacuum
```

## 对外部署

### 推荐姿势:反代 + daemon

1. `--bind 127.0.0.1`(默认)只允许本机访问
2. Caddy / nginx 在前,负责 TLS、限速、访问日志
3. `--daemon` 让服务后台运行;`--pid-file` / `--log-file` 控制 PID 与日志路径

启动:

```bash
model-router start \
  --bind 127.0.0.1 \
  --port 15005 \
  --max-body-size 4mb \
  --daemon \
  --log-file /var/log/model-router.log \
  --pid-file /var/run/model-router.pid
```

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

收到 `SIGTERM` / `SIGINT` 后,代理执行: 停止健康监控 → 排空日志队列 → 关闭 SQLite → 清理 PID 文件 → `server.close()`。`server.close()` 会等待所有进行中的请求处理完成。如果上游响应卡住,关闭可能会被拖延;launchctl/systemd 默认会在 30 秒后强制 SIGKILL,这是可以接受的兜底。

> **不要直接 `--bind 0.0.0.0`** 暴露未加 TLS 的代理:任何嗅探到端口的人都能消耗你的上游配额。

## License

MIT
