# model-router 多用户代理设计

**Date**: 2026-05-03
**Status**: Draft → 待用户确认 → 进入实现规划

## 1. 背景与现状

经过多协议桥接（2026-05-01 spec）落地后，model-router 已能让任意 agent 调用任意上游协议。但当前 ProxyKey 模型只够"自己一个人本机用"，要在多人/多设备/对外网部署仍有明显缺口：

| 维度 | 当前 | 缺口 |
|---|---|---|
| Key schema | `{name, key, enabled, createdAt}` | 无作用域、无配额、无过期 |
| 路由 | `selectUpstreams(model, upstreams)` 不接 key | 任何 key 都能调用任何 upstream/model |
| 限速 | 无 | 单 key 可瞬间打死上游配额 |
| 统计 | 全局每日总和 | 看不出每个 key 用了多少 |
| 监听 | `server.listen(port)` 隐式全接口 + 启动消息谎报 127.0.0.1 | 装机即对公网可见 |
| 部署 | 仅前台 | 无 daemon、无 logfile/pid 重定向 |
| 防御 | 无 body 大小限制、`error_message` 直存上游 raw | 大请求 OOM、上游 key 片段可能落库 |

## 2. 目标 / 非目标

### 2.1 目标

- 支持给多个用户分发独立的 key，每个 key 有自己的 upstream/model 白名单 + RPM + 每日 token 配额
- 提供按 key 维度的统计 CLI，一眼看出每个用户活跃度与用量
- 启动参数完整化（绑定 host、body 上限、daemon），README 给出 Caddy 反代示例对外暴露
- 现有单用户、单机使用方式零回归（所有新字段全可选，缺省即不限）

### 2.2 非目标（v1 不做）

- USD 价格表 / cost 字段（仅 token 配额）
- 按 key 加权的上游配额（多 key 全局共享 upstream 余额，先到先得）
- HTTP 管理 API / Web 控制台（仅 CLI）
- 配置存 SQLite（继续用 JSON）
- 进程内 TLS（依赖 Caddy/nginx 反代）
- SSO / OIDC（mrk_ 即是 service-to-service 凭证）
- 审计日志表 audit_logs
- 自动 logrotate / SQLite vacuum（手动 CLI 命令即可）
- Redis / 跨进程协调（限速纯进程内）

## 3. 关键决策（来自对话定型）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 配额单位 | 仅 tokens | 简化 v1，避免维护价格表 |
| Upstream 余额 | 全局共享 | 先到先得，不在代理侧加权分配 |
| 管理面 | CLI only | YAGNI，不做 Web/API |
| 配置 | JSON | 沿用，迁移成本为零 |
| TLS | 外部反代 | Caddy 自动 ACME 续期，进程零侵入 |
| 身份验证 | mrk_ 仅做 service-to-service，不接 SSO | 用户/团队映射靠 `description` + `tags` 字段 |
| 限速实现 | 进程内 ring buffer | 不引入 Redis；单进程足够 |

## 4. 数据模型变更

### 4.1 ProxyKey schema (src/config/types.ts)

```ts
interface ProxyKey {
  // 不变字段
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;

  // 新增字段(全部可选,缺省=不限)
  description?: string;          // 备注 / 邮箱 / 用途
  expiresAt?: string;            // ISO 时间;到期后视为 disabled
  allowedUpstreams?: string[];   // 上游名白名单(空数组 OR undefined = 全部)
  allowedModels?: string[];      // 模型白名单,支持 glob (空 OR undefined = 全部)
  rpm?: number;                  // 每分钟请求数上限
  dailyTokens?: number;          // 每天 input + output token 总量上限(本地时区 0:00 重置)
}
```

**字段语义细则**：
- 白名单字段空数组 与 undefined 等价 = "全部允许"。CLI 显式 `--upstreams ""` 或 `--models ""` 表示"清空回退到全部"。
- `expiresAt` 过期后路由层视同 `enabled=false`，但 key 不会被自动删除（便于 stats 历史回溯）。
- `allowedModels` 中的每一项与 modelMap 的 pattern 同样支持 `*` 和 `?` 通配。
- `rpm` 与 `dailyTokens` 缺省时表示"不限"。零值 `0` 表示"完全禁用"（直接 429）。

### 4.2 配置文件向后兼容

`ConfigStore.load()` 读取旧 schema 时，新字段缺失视为 undefined（即"不限"），无需迁移。无新增 SQLite 字段。

### 4.3 不新增表

按 key 维度的统计完全靠现有 `request_logs.proxy_key_name` 字段 GROUP BY 出来。`error_message` redact 为列内更新逻辑，不动表结构。

## 5. 路由层变更

### 5.1 selectUpstreams 签名

```ts
// src/router/upstream.ts
function selectUpstreams(
  model: string,
  upstreams: UpstreamConfig[],
  key?: ProxyKey,           // 可选；不传时只按 enabled + 模型解析过滤
): UpstreamMatch[]
```

内部过滤顺序（任一不通过则该 upstream 不入候选）：

1. `upstream.enabled === true`
2. `key` 存在时：`key.allowedUpstreams` 缺省/空 或 包含 `upstream.name`
3. `key` 存在时：`key.allowedModels` 缺省/空 或 某条 pattern glob 命中 `model`
4. `resolveModel(model, upstream)` 非 null（已有逻辑：modelMap 精确 → glob → models[] 透传）

候选集 shuffle 并返回（沿用现有 failover 行为）。

### 5.2 expiresAt 检查

`authenticateProxyKey` 同时检查：
- `key.enabled === true`
- `key.expiresAt` 不存在 或 `Date.now() < Date.parse(key.expiresAt)`

任一不通过返回 `{ ok: false }`，handler 输出 401。

### 5.3 无候选时的错误码

- `selectUpstreams` 返回空数组 → 404 `not_found_error`，message：
  - 若 model 完全不被任何 upstream 支持："No available upstream for the requested model"
  - 若 model 被某 upstream 支持但被该 key 的白名单挡住："Model not allowed for this proxy key"

handler 区分这两种情况（实现：先 `selectUpstreams(model, all_upstreams)` 不传 key 看 model 本身是否可用，再 `selectUpstreams(model, all_upstreams, key)` 用真实 key 过滤）。

## 6. 限速 / 配额

### 6.1 KeyLimiter 模块（新增 src/limit/limiter.ts）

```ts
interface UsageState {
  rpmWindow: number[];         // ring buffer of timestamps within last 60s
  dailyTokensUsed: number;     // 累加自本地时区 0:00
  dailyResetAt: number;        // 下次 0:00 epoch ms
}

class KeyLimiter {
  // 检查 RPM:命中则返回 retryAfterMs
  reserveRequest(keyName, key): { allowed: boolean; retryAfterMs?: number; reason?: string }

  // 请求结束后累加实际 token
  recordUsage(keyName, inputTokens, outputTokens)

  // 启动时回填今日已用 tokens(避免重启后配额清零)
  hydrate(logStore)
}
```

### 6.2 RPM 实现

- ring buffer 储存最近 60 秒内每次 reserve 的时间戳
- reserve 时:先剔除 60s 之前的过期项,若剩余条数 ≥ rpm 则拒绝,否则推入当前时间戳
- 内存量级：每 key 最多 rpm 个 number（即使 rpm=600 也只有 600×8=4.8KB/key），单进程数百 key 完全可控

### 6.3 dailyTokens 实现

- 每个 key 维护 `dailyTokensUsed` 与 `dailyResetAt`
- 每次进入 `reserveRequest` 先比 `Date.now() >= dailyResetAt`，过则归零并把 `dailyResetAt` 推到次日 0:00
- 拒绝条件：`dailyTokensUsed >= dailyTokens` 时直接 429（不能预知请求消耗多少 token，所以是事后扣费式：当日已经超额就拒绝下一条；最后一条可能小幅超出 dailyTokens 上限。可接受。）
- 记录：流式与非流式都在 handler 拿到最终 usage 后调用 `recordUsage`，与现有 logger.enqueue 同时点

### 6.4 启动回填

`startServer` 启动时调用 `keyLimiter.hydrate(logStore)`：
```sql
SELECT proxy_key_name,
       SUM(COALESCE(request_tokens,0) + COALESCE(response_tokens,0)) AS used
FROM request_logs
WHERE DATE(created_at) = DATE('now', 'localtime')
GROUP BY proxy_key_name;
```
回填到内存。RPM 不回填（重启后空窗 60 秒重新计数，可接受）。

### 6.5 命中限制时

- HTTP 状态 429
- 协议正确的错误体（Anthropic: `{type:"error",error:{type:"rate_limit_error",message:"..."}}`；OpenAI: `{error:{type:"rate_limit_exceeded",message:"...",code:null}}`）
- 响应头 `Retry-After: <seconds>`
- 仍写一条日志，`status_code=429` `error_message=rpm_exceeded` 或 `daily_tokens_exceeded`，便于 stats:keys 看到"被拒次数"

## 7. CLI surface

### 7.1 key 管理增强（在已有命令上加参数）

```bash
# 创建带权限的 key
model-router key:create alice \
  --description "alice@team.com" \
  --upstreams kimi-code,ds-bridge \
  --models "claude-sonnet-*,claude-haiku-*" \
  --rpm 30 \
  --daily-tokens 2000000 \
  --expires 2026-12-31T23:59:59Z

# 修改单字段(每次只改一项也支持)
model-router key:update alice --rpm 60
model-router key:update alice --daily-tokens 5000000
model-router key:update alice --add-upstream kimi-code-2     # 增量
model-router key:update alice --remove-upstream ds-bridge    # 增量
model-router key:update alice --description "alice@team.com (PM)"
model-router key:update alice --expires never                # 字面 'never' 清空过期

# 启停
model-router key:disable alice
model-router key:enable alice

# rotate 生成新密文,保留所有元数据/统计
model-router key:rotate alice
# 输出: New key: mrk_xxxx (旧 key 立即失效)

# 列表增强
model-router key:list
# 列: name, key(masked), enabled, expires, allowed_upstreams, allowed_models,
#     rpm, daily_tokens, used_today, last_used
```

### 7.2 stats by key

```bash
# 单 key 详情
model-router stats:key alice
model-router stats:key alice --since 7d
model-router stats:key alice --since 2026-04-01

# 输出:
# Key: alice (alice@team.com)
# Period: 2026-04-26 ~ 2026-05-03 (7d)
# Requests: 1234 (12 errors, 3 rate-limited)
# Tokens: 1.2M in / 280K out / 1.5M total
# Avg latency: 820ms / p95: 2100ms
# Top models: claude-sonnet-4-5 (820), claude-haiku-3 (414)
# Top upstreams: kimi-code (1234)
# Last seen: 2026-05-03 00:42

# 所有 key 排名
model-router stats:keys
model-router stats:keys --date 2026-05-02
model-router stats:keys --since 7d
# 表: name, requests, in_tokens, out_tokens, total, errors, rate_limited, last_seen
# 默认按 total tokens 倒序
```

### 7.3 部署相关命令

```bash
# 现有 start 增加参数
model-router start \
  --bind 127.0.0.1 \              # 默认值;显式 0.0.0.0 才对外
  --port 15005 \
  --max-body-size 4mb \
  --daemon \                      # fork 后台,需配合 --log-file / --pid-file
  --log-file /var/log/model-router.log \
  --pid-file /var/run/model-router.pid

# 后台进程管理
model-router stop --pid-file /var/run/model-router.pid     # 读 pid 发 SIGTERM
model-router status --pid-file /var/run/model-router.pid   # 查进程是否在跑

# 维护
model-router maintenance:purge --older-than 90d    # 清理 90 天前的 logs
model-router maintenance:vacuum                     # SQLite VACUUM
```

### 7.4 安全相关

```bash
# 默认 mask:mrk_xxxx…abcd / sk-xxxx…wxyz
model-router key:list
model-router upstream:list

# 显式开 --show-secrets 才打印完整 key
model-router key:list --show-secrets
model-router upstream:list --show-secrets
```

## 8. 部署

### 8.1 启动行为

- `--bind` 默认 `127.0.0.1`（**变更现状**：当前隐式绑定全接口）
- `--max-body-size` 默认 `4mb`，请求 body 超出立即返回 413（按协议包装）
- 启动 console 消息打印实际 host：`model-router proxy listening on http://<bind>:<port>`

### 8.2 daemon 模式

简化实现（不依赖 launchd/systemd）：
1. fork 子进程（Node 用 `child_process.spawn` + `detached: true` + `stdio: ['ignore', logFd, logFd]`）
2. 父进程写 `--pid-file`（子 PID）后退出 0
3. 子进程接管，stdout/stderr 重定向到 `--log-file`
4. `model-router stop` 读 pid 文件，向 PID 发 SIGTERM；现有 graceful shutdown 路径不变

### 8.3 README 增加 "对外部署" 章节

- Caddy 反代一行配置示例
- nginx 反代示例
- 提示：`--bind 127.0.0.1`（不变）+ Caddy 在前；不要 `--bind 0.0.0.0` 直接暴露
- systemd unit 示例片段（用户 mode）：
  ```
  [Service]
  ExecStart=/usr/local/bin/model-router start --bind 127.0.0.1 --port 15005
  Restart=on-failure
  ```

## 9. 安全最低线

| 项 | 实现位置 |
|---|---|
| `error_message` 入库前 redact 上游 key | src/server/proxy.ts，在 `enqueue` 之前对 message 做 `replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')` |
| `key:list` / `upstream:list` 默认 mask | src/cli/index.ts，CLI 层格式化时 mask |
| 配置文件首次创建 0600 | src/config/store.ts，`save()` 后 `fs.chmodSync(path, 0o600)` |
| body 大小上限 | src/server/proxy.ts `collectBody`，累加超 max 时 abort 并返回 413 |
| key revoke 立即生效 | 现有 `enabled=false` 已支持；`key:rotate` 是替换 key 字符串 |

不做：upstream key 加密/keychain 集成、proxy key 哈希存储（这些都属于配置管理层面，超出 v1 简化范围）。

## 10. 不变的子系统

为限定改造边界，下列模块**完全不动**：

- 协议桥接（`src/protocol/`）— 4 个 bridge、SSE 状态机、glob matcher 全部保留
- 路由 failover 行为（5xx 重试、4xx 不重试、shuffle）保留，仅在 `selectUpstreams` 入口加 key 过滤
- 日志异步队列（`src/logger/queue.ts`）行为不变
- HealthMonitor 不变
- 现有所有 94 个测试不应有任何回归

## 11. 测试策略

### 11.1 新增单元测试覆盖

| 文件 | 用例数预估 |
|---|---|
| `tests/config/key.test.ts` | 8 — schema 默认值、白名单 add/remove、过期判定 |
| `tests/router/key-filter.test.ts` | 10 — allowedUpstreams / allowedModels glob / 过期 / disabled |
| `tests/limit/limiter.test.ts` | 12 — RPM 滑窗、dailyTokens、跨 0 点重置、hydrate 回填、零值（0=禁用） |
| `tests/limit/redact.test.ts` | 5 — error_message redact upstream key |
| `tests/cli/key-update.test.ts` | 6 — add/remove upstream、rotate、expires never |

### 11.2 集成测试（扩展现有 proxy.test.ts）

新增 6 个端到端场景：
- key allowedModels 命中 → 200
- key allowedModels 不命中 → 404 with "Model not allowed"
- key 过期 → 401
- RPM 超限 → 429 + Retry-After header
- dailyTokens 超限 → 429
- body 超 max-body-size → 413

### 11.3 测试基线

新增预计 ~47 用例，加上现有 94，目标 **141 个用例全绿**。

## 12. 实施切片顺序（4 个独立可上线 slice）

Slice 之间严格 DAG，每个完成即可单独 commit + push。

### Slice 1: ProxyKey schema + 路由 key 过滤 + key:create/update CLI

**改造文件**：
- `src/config/types.ts`（schema 扩展）
- `src/config/store.ts`（addProxyKey/updateProxyKey 透传新字段）
- `src/router/upstream.ts`（selectUpstreams 加 key 参数）
- `src/server/auth.ts`（expiresAt 检查）
- `src/server/proxy.ts`（route 调用处传 key、区分 not-found 错误）
- `src/cli/index.ts`（key:create / key:update / key:rotate / key:enable / key:disable）

**完成标志**：能给单个 key 限定 upstream 与 model，路由按白名单过滤；key:list 显示新字段（mask 还没做）。

### Slice 2: KeyLimiter + 429 + body size

**改造文件**：
- `src/limit/limiter.ts`（新文件）
- `src/server/proxy.ts`（reserveRequest / recordUsage 接入；body size 守卫；error_message redact）
- `src/server/index.ts`（启动时 hydrate）
- `src/protocol/passthrough-anthropic.ts` 与 `openai`（wrapError 已经支持，可能扩展 rate_limit_error type）
- `src/cli/index.ts`（rpm / daily-tokens 参数）

**完成标志**：超过 RPM 或 daily-tokens 即 429，body 过大即 413，重启后今日 token 累计正确回填。

### Slice 3: stats:key / stats:keys + key:list 增强 + maintenance

**改造文件**：
- `src/logger/store.ts`（新增 statsByKey / statsAllKeys / purgeOlderThan / vacuum）
- `src/cli/index.ts`（stats:key、stats:keys、key:list 增强、maintenance:purge / vacuum、--show-secrets / mask）

**完成标志**：能看到每个 key 的 7 天用量、错误数、被拒次数；key:list 显示 used_today / last_used / mask。

### Slice 4: --bind / --daemon / 部署文档

**改造文件**：
- `src/server/index.ts`（接 bind 参数、修正启动消息）
- `src/cli/index.ts`（start 增 --bind / --max-body-size / --daemon / --log-file / --pid-file，新增 stop / status 命令）
- `README.md`（"对外部署" 章节 + Caddy/systemd/launchd 示例）

**完成标志**：默认绑 127.0.0.1；`start --daemon` 后台跑；`stop` 干掉子进程；README 给出 Caddy 一段配置即可对外。

每个 slice 完成后跑全套 `npm test`，绿灯才进入下一个。

## 13. Open questions

无 — 所有关键决策已在 §3 表中定型，可直接进入 plan 编写。
