# model-router 对标 sub2api:Codex 订阅账号转售 + 平台能力全面升级技术方案

> 状态:已评审待实施 | 日期:2026-10-15 | 依据:sub2api 代码深挖(Codex 转售实现 + 平台设施)+ model-router saas 层现状勘察

## Context

目标:追齐 sub2api 主能力——订阅账号转售(Codex 起步)、完整多用户+RBAC+2FA+OAuth、实时 QPS/通道状态页/告警/审计的可观测性、多实例能力,性能可靠性全面对标。

**已确认的决策**:① Codex 凭证形态 = OAuth 账号池(对标 sub2api,含指纹伪装);② 可观测性 = 内置为主 + Prometheus 导出;③ 多实例 = Docker Compose + PG + Redis。

**核心架构判断**(基于勘察):
- model-router 的 SaaS 层(`src/saas/`)已有:platform 账号池(`ProviderSupplyOwnerKind='platform'`)、密封凭证信封(KMS+版本化+审计轮换)、账号调度器(priority/weight,`postgres-provider-account-scheduler.ts`)、租约(025)、亲和(041,即粘性会话基础)、运行时健康存储(040)、配额快照 worker(093)、**OAuth 刷新 worker(094,R4 已生产装配)**、钱包+预留+结算、计费策略、Redis 限流、workload 角色拓扑(control-plane/gateway/validation-worker)+最小权限 PG 角色。**Codex 转售是 provider 扩展,不是新基础设施**。
- sub2api 值得移植的资产是**协议细节层**(全部黑盒实证过的常量与规则):Codex OAuth client_id/PKCE 参数、伪装三件套规则、请求变换规则、`x-codex-*` 配额头解析、5h/7d 窗口语义、健康分类矩阵、审计/告警/QPS 的数据结构。
- **明确差异**:sub2api OAuth token 明文存 PG;model-router 已有密封信封,保持优势。sub2api 调度用 Redis ZSET 并发槽;model-router 用 PG 租约+SKIP LOCKED,保持现有模型,仅把热路径并发计数加 Redis。
- 风险承认:订阅账号转售违反 OpenAI ToS(sub2api 自己 README 首屏警告)。本方案按用户明确要求实施,但在文档与运营面上明确风险声明。

---

## Phase 1:Codex 订阅账号转售 MVP(核心,先行)

**落点:SaaS gateway 数据面**(`src/saas/gateway/`),不动 proxy.ts 本地模式。

### 1.1 Provider 目录与凭证模型(迁移 099-100)

- `src/saas/catalog/`:注册 `openai-codex` provider(复用 008 catalog+rights),upstream endpoint 钉死 `https://chatgpt.com/backend-api/codex/responses`。
- 凭证信封扩展(密封 JSON 内,不进明文列):`access_token, refresh_token, id_token, expires_at, client_id, email, chatgpt_account_id, chatgpt_user_id, plan_type, subscription_expires_at`。复用 `credentials/provider-crypto.ts`。
- 迁移 099:provider_account 增加 codex 调度列(`codex_5h_used_percent, codex_5h_reset_at, codex_7d_*, codex_usage_updated_at, auto_pause_5h_threshold, auto_pause_7d_threshold, codex_fingerprint_mode, codex_fingerprint_seed`)——遵循 093/094 既有列风格("scheduling signal only"语义)。

### 1.2 OAuth 绑号(平台管理员操作面)

新模块 `src/saas/platform/codex-oauth/`:

- **PKCE 流程**:照抄 sub2api 实证常量——client_id `app_EMoamEEZ73f0CkXaXp7hrann`、authorize `https://auth.openai.com/oauth/authorize`、token `https://auth.openai.com/oauth/token`、redirect `http://localhost:1455/auth/callback`(loopback,管理员本机跑浏览器)、scopes `openid profile email offline_access`(refresh 时去掉 offline_access)、`codex_cli_simplified_flow=true`、PKCE verifier=64 随机字节 hex。流程:平台控制台生成授权 URL → 管理员浏览器完成 → 粘贴 code → 服务端换 token → 解析 `id_token` JWT payload(不验签,只查 exp±120s;claims 在 `https://api.openai.com/auth` 键下)提取 chatgpt_account_id/plan_type。
- **绑号后处理**:best-effort 调 `chatgpt.com/backend-api` `accounts/check`(取 plan/到期时间)+ `settings/account_user_setting?feature=training_allowed&value=false` PATCH(关闭训练数据共享)。
- **批量导入**:粘贴 Codex CLI `auth.json` 内容导入(管理员侧),token 走密封信封。
- 产出即 `platform` ownerKind 账号,进平台池。

### 1.3 Token 刷新(R4 worker 扩展)

`src/saas/supply/oauth-token-refresh-worker.ts`(094)已具备:SKIP LOCKED 租约、过期 stale-refreshing 回收(15min)、只刷钉死的 (provider,product,credential-type) 绑定、审计轮换路径 `replaceProviderCredentialSecretWithAudit`。扩展:

- 注册 `openai-codex` 刷新绑定:token endpoint `auth.openai.com/oauth/token`,refresh 只在响应真正返回新 refresh_token 时覆写(OpenAI 轮换语义)。
- **轮换竞态恢复**:刷新持锁期间从 PG 重读账号(照抄 sub2api `tryRecoverFromRefreshRace`:`invalid_grant` 且并发 worker 已消费旧 RT 时,重读并验证新 RT)。
- 网关在路径上的 401 → `oauth_force_refresh_requested` 信号 + 账号临时不可调度 10min(保持 active 让后台刷新器接手)——R4 已定此分工,只补 codex 分类。

### 1.4 Codex 伪装与变换层(新 `src/saas/gateway/codex/`,纯函数模块,单测重点)

**`identity.ts`** —— 出站身份三件套:

- UA 形状 `{originator}/{version} ({OS} {osver}; {arch}) {terminal}`,默认 `codex_cli_rs`,version 最低 **0.144.0**(低于此上游 404),基准 `0.146.0`,需跟踪 CLI release(做 `codex-version-sync`:从 `chatgpt.com/backend-api/codex/models` manifest 或 npm registry 拉最新版本号,控制台可覆盖+告警过期)。
- 每次出站强制重写 UA/originator/version 为规范值;`OpenAI-Beta: responses=experimental`。
- **每账号身份命名空间**(必做,非可选):`session_id/conversation_id = sha256("u{keyId}:a{chatgpt:{accountId}:user:{userId}}:{raw}")[:8]`——保证 failover 换账号后同一客户端会话不出现在两个上游凭证下。
- **指纹收敛**(账号级 opt-in,默认 off——sub2api v0.1.175 配额缩水事故教训):mode `off|device|session|full`;种子 UUIDv4 系统生成、更新时原子保留;派生 ID `deriveStableUUIDv4(sha256(namespace+seed))`;头(`x-codex-installation-id/-window-id/-client-request-id/session-id/thread-id`)与 `x-codex-turn-metadata` JSON、body `client_metadata.*`、`prompt_cache_key`(仅当等于原 session_id 时)同源重写;`turn_id` 每 attempt 随机 UUIDv7。
- **turn-state 溯源守卫**:上游响应头 `x-codex-turn-state` 记录铸造账号(内存 map,TTL=粘性 TTL);客户端回显他账铸造的 blob 时剥离。

**`transform.ts`** —— 请求变换为 ChatGPT-codex 合法体:

- 强制 `store:false, stream:true`;剥不支持字段;`reasoning` 存在时保证 `include:["reasoning.encrypted_content"]`;legacy `functions/function_call`→`tools/tool_choice`;**system 角色消息提升为 `instructions`**;`input` string→数组;调用 ID 规范(`fc_` 前缀,≤64 字符);模型名规范化表(`gpt-5.1-codex-max`→`gpt-5.3-codex`,剥 reasoning 后缀)。
- **保留工具名别名**:工具名 `python` 上行改 `python__mr`,响应/SSE 每帧反向还原。
- **instructions 注入**:ChatGPT codex 端点要求 instructions 非空;按模型家族嵌内置 Codex CLI 基础提示词(资产文件 `src/saas/gateway/codex/instructions/`,来源 openai/codex models-manager,版本化)。
- `x-codex-beta-features: remote_compaction_v2` 默认注入(客户端未声明时)。

**`quota-headers.ts`** —— 响应头解析:

- 解析 `x-codex-primary/secondary-used-percent/-reset-after-seconds/-window-minutes`,按 `window_minutes ≤360 = 5h 窗`归一化,写迁移 099 的快照列(≥30s 节流,异步);429 响应头同样解析——取 **用尽窗口(used%≥100)** 的 reset 时间设账号 `rate_limited_until`。
- **调度门**:快照 used% ≥ 阈值 → 跳过该账号;**陈旧守卫**(reset_at 已过 → 忽略快照;快照 >2h 未更新 → 允许一次探测自愈)。

**`health.ts`** —— 错误分类矩阵(写入 040 runtime-health-store):

| 信号 | 动作 |
|---|---|
| 401 `token_invalidated/revoked` | 永久 error |
| 401 其他(有 RT) | 刷 token + 临时不可调度 10min |
| 403 | 递增 strike 计数(Redis,窗口化),N 次→永久 error,不足→临时冷却;HTML 页/CF 1010 豁免 |
| 429 | 用尽窗口 reset 时间精确冷却 |
| 529/流内 `server_is_overloaded` | failover 信号 + overload_until |
| 400 org disabled / identity verification | 永久 error |
| 成功 | 清 403 计数 |

### 1.5 传输与协议转换

- `provider-http-transport.ts` 扩展 codex transport:URL+Host `chatgpt.com`、`chatgpt-account-id` 头、白名单头透传(`session_id, conversation_id, originator, x-codex-*`)、SSE 流中继(客户端断开后继续抽干上游收集 usage——sub2api 同款,usage 在 `response.completed` 尾包)。
- **下行三形态**:`/v1/responses` 原生透传(已有);`/v1/chat/completions` → Responses 转换(系统消息→instructions、SSE chunk 还原——`src/protocol/` 已有 o↔a 桥可复用 Responses 信封知识);`/v1/messages` → Responses(a→o 桥 `anth-to-openai.ts` 扩展 Responses 形态,Anthropic cache token 映射 cache_read/creation 桶)。
- 模型目录:`/v1/models` 从 `chatgpt.com/backend-api/codex/models` 拉取(1min TTL/5min stale/ETag),内置 fallback 目录。

### 1.6 计费

- `src/saas/pricing/` 注册 codex 模型价格版本(input/output/cache_read/cache_write 按 metric,已有结构);订阅上游无上游价格,自定价格表×倍率;`commercial-metering-policy-service` 已支持版本化策略,绑定 codex provider。
- usage 解析复用/扩展 `provider-sse-usage-observer.ts`(Responses usage 对象:input/output/cached_tokens 分桶,`actualInput = input − cached_read − cache_creation` 防双计)。
- 钱包扣减/预留/结算链路零改动(hold-calculator + dispatch-usage-settlement 现成)。

### 1.7 Phase 1 测试

- 单测:transform(全规则矩阵)、identity(命名空间/指纹派生确定性)、quota-headers(窗口归一化/429 分类)、health 分类。
- 集成:mock `chatgpt.com`(本地 HTTP mock,SSE 回放真实 Codex 响应样本)——绑号/刷新/请求/流/usage/配额头/failover 全链;走 PG 门禁(项目既有 isolated-PG CI 模式)。
- live 冒烟:`tests/integration/codex-live.test.ts`(用户提供测试账号,gated by env,不计 CI 必跑)。

---

## Phase 2:多用户/RBAC/2FA/OAuth 登录补齐(小量)

勘察结论:identity/ 已有 tenant/project RBAC(owner/admin/developer/billing/viewer 五角色)、TOTP(客户+平台)、passkey、密钥变更会话、邀请/转让。**缺口只有社交 OAuth 登录**(COM-01 搁置项)。

- 新 `src/saas/identity/oauth-login/`:通用 **OIDC** provider + **微信** provider(标准 OAuth2 code 流,流程形状照抄 sub2api:state cookie → 回调换 token → 身份解析 → `auth_identities` 等价表(迁移 101:tenant 登录身份表 unique(provider_type,provider_subject)) → 命中即登录/邮箱冲突走 adoption 决策/无匹配进 pending session 完成注册)。
- 复用现有 pending-session 骨架(identity/ 已有 session token + CSRF 模式)。
- 注册侧接 marketing/(兑换码/邀请码已有,OAuth 注册赠送计划接 plans/)。
- RBAC/2FA 仅补验证用例矩阵(已有代码不重写)。

---

## Phase 3:可观测性(内置为主 + Prometheus)

新 `src/saas/observability/` + console 扩展:

1. **/metrics Prometheus**(gateway 与 control-plane 各暴露):QPS/状态码分布、延迟直方图(p50/p90/p99,按 route)、in-flight/并发水位、账号池状态(可用/冷却/quota 暂停计数,按 provider)、熔断/健康分、wallet hold 水位、Redis/PG 连接池。用 `prom-client`。
2. **实时 QPS**(console):WS 推送,5s 窗口聚合(从 telemetry minute 表 + 内存环形 buffer;单 leader 聚合、广播快照——sub2api 同款"一份快照推所有连接")。数据源复用 `telemetry-read-worker.ts` 读路径。
3. **通道/账号状态页**:被动聚合式(对标 sub2api V2,不做主动探测):每分钟从 requests/attempts 聚合 1m 事实表(迁移 102:`obs_channel_metrics_1m/rollup` + 错误分类列),错误 taxonomy 固定版本号(16 类有序级联:content_policy/authentication/quota_or_capacity/timeout/…);watermark 增量回填,单 leader(SKIP LOCKED 既有模式)。
4. **告警**:规则表(迁移 103:`obs_alert_rules/events`,字段 metric/operator/threshold/window/sustained/cooldown/notify);evaluator worker(leader 锁,连续违例 sustained 才触发,静默窗口);通知走 email(SMTP,队列 worker)+ **webhook**(补 sub2api 没有的);余额阈值告警接 webhooks/ 事件目录(wallet low balance 事件已有)。
5. **审计增强**:`platform/audit/` 已有;补 settings-change diff 审计(before/after 键级 diff 字符串,sub2api 600 行 diff 的精简版——只覆盖我们的 settings 面)与 OAuth 绑号/导入全事件。

---

## Phase 4:多实例部署(Compose + PG + Redis)

deployment.ts 的角色拓扑(control-plane/gateway/validation-worker + per-role DB URL/KMS)已为此设计,补部署资产与跨实例热状态:

1. `deploy/compose/docker-compose.yml`:gateway×N(可 scale)、control-plane×1(+leader 角色内含)、validation-worker×1、postgres:16、redis:7;`.env.example` 全量(KMS 模块、per-role DB URL、origins);healthcheck + depends_on;前端静态产物由 control-plane 服务。
2. **Redis 热状态**(红线:PG 是权威,Redis 只是缓存/协调):
   - 限流已有 `redis-rate-limit-provider.ts`;补 **账号并发槽**(ZSET 成员=requestId score=Redis TIME,替代/旁路 PG 租约做快速准入,PG 租约仍是审计权威);
   - **粘性会话绑定**:`sticky:{poolId}:{sessionHash}→accountId`,TTL 1h(sessionHash 来源优先级照抄:session-id 头→conversation_id→prompt_cache_key→内容哈希兜底;接入既有 041 affinity);
   - token 解密缓存(短 TTL)、leader 锁(既有 SKIP LOCKED 保留,Redis 锁为快速路径);
   - 跨实例失效:复用 outbox 模式(authz_version 失效族已有)。
3. **遥测读侧**:admin telemetry 读 worker 已分离;确保 gateway 实例无单点写(各自写 telemetry,读侧聚合)。
4. 运维文档:`deploy/compose/README.md`(扩缩容、备份、轮换 KMS 的 rewrap 流程接 `credential-rewrap-operations.ts`)。

---

## Phase 5:性能/可靠性对标验证(压测与混沌)

对照 sub2api 与本仓库既有 bench 方法论(`scripts/ops/bench-ollama.mjs` 扩展):

1. **性能基准**(Compose 3×gateway vs mock 上游):
   - 非流式 p99 代理开销 < 30ms(mock 上游 0 延迟基线);
   - 流式 TTFB 透传开销 < 10ms;SSE 事件零损坏(桥接三形态各 10min 压测);
   - 并发 200 in-flight(跨 3 实例)、429 精确性(超发 0);
   - 多实例线性扩展(1→3 实例吞吐 ≥2.7×)。
2. **可靠性混沌**:
   - 账号 401/429/403 中流注入(mock 上游可编程故障)→ failover 无感、健康分类正确、无泄漏连接;
   - token 过期恰逢请求 → 刷新竞态无 invalid_grant 风暴;
   - kill 一个 gateway 实例 → 进行中流断(记录)但新请求 0 失败;kill PG 30s → fail-closed 行为验证;
   - 24h soak(compose 内)→ RSS/WAL/句柄趋势(soak-monitor.mjs 方法论平移到 compose 容器)。
3. **多用户能力对标清单**:RBAC 矩阵用例(5 角色越权全负向)、2FA 登录/恢复、OAuth 登录双 provider、per-key 预算/IP 策略/并发——以测试矩阵形式输出对标表。

---

## 风险与红线

1. **ToS/法律**(用户已知悉):订阅转售违反 OpenAI ToS;文档与控制台明示风险;不做对外公开运营的姿态设计。
2. **伪装军备竞赛维护成本**:CLI version 同步、instructions 资产更新需持续跟进——version-sync 服务 + 过期告警缓解;指纹收敛默认 off。
3. **红线继承**:PG 权威/Redis 缓存;密封凭证不降级为明文;密钥不落代码(CLAUDE.md 安全约束);fail-closed 语义不破。
4. **不做**:反封禁住宅代理池(Phase 1 范围外,若需要单列后续)、内容审核、利润控制否决(既有红线)。

## 实施顺序与里程碑

| 阶段 | 内容 | 关键交付 |
|---|---|---|
| P1a | codex/ 纯函数层 + 单测 | identity/transform/quota-headers/health + mock 上游集成 |
| P1b | OAuth 绑号 + R4 刷新扩展 + 调度/计费接线 | 迁移 099-100,平台池跑通真实账号 |
| P1c | 下行三协议 + live 冒烟 | /v1/responses、chat/completions、messages 全通 |
| P2 | OAuth 登录(迁移 101) | OIDC + 微信 |
| P3 | 可观测性(迁移 102-103) | /metrics、QPS WS、状态页、告警 |
| P4 | Compose + Redis 热状态 | 多实例部署资产 |
| P5 | 对标验证 | 性能/混沌/多用户矩阵报告 |

每阶段完成后按惯例登记 `docs/development-progress-*.md` 证据。

## 涉及文件(新建为主)

| 文件/目录 | 动作 |
|---|---|
| `src/saas/gateway/codex/`(identity/transform/quota-headers/health/instructions/) | 新建 |
| `src/saas/platform/codex-oauth/` | 新建(PKCE/导入/privacy) |
| `src/saas/identity/oauth-login/` | 新建 |
| `src/saas/observability/` | 新建 |
| `src/saas/db/migrations/099-103` | 新建 |
| `src/saas/supply/oauth-token-refresh-worker.ts`、`src/saas/gateway/provider-http-transport.ts`、`provider-sse-usage-observer.ts`、`provider-account-scheduler.ts`、`src/saas/catalog/`、`src/saas/pricing/` | 扩展(接口化,不改既有语义) |
| `deploy/compose/` | 新建 |
| `src/protocol/anth-to-openai.ts` | 扩展 Responses 形态 |
| `tests/saas/gateway/codex/`、`tests/integration/codex-live.test.ts` | 新建 |
| `docs/` 风险声明 + progress 登记 | 追加 |

## 验证总清单

1. 真实 Codex 账号经 /v1/responses、/v1/chat/completions、/v1/messages 三形态全通(流式+非流式),usage/计费落库正确。
2. 双账号池:配额自动暂停(5h 用尽账号被跳过)、429 精确冷却、401 刷新竞态、failover 换账号会话隔离(命名空间验证)。
3. /metrics 抓取 + Grafana 面板渲染;QPS WS 实时;状态页 7 天可用率;告警规则触发→email+webhook。
4. Compose `docker compose up --scale gateway=3` 后:P5 基准全绿;kill 实例演练;24h soak 无泄漏。
5. `npx tsc --noEmit` + `npm test` 全绿;PG 门禁(既有 CI 模式)通过;安全扫描无密钥字面量。

---

## 附录:sub2api 可移植资产索引(勘察证据)

| 资产 | sub2api 源位置 | 移植去向 |
|---|---|---|
| Codex OAuth 常量(client_id/PKCE/scopes/simplified_flow) | `backend/internal/pkg/openai/oauth.go` | `saas/platform/codex-oauth/` |
| 伪装三件套(UA/originator/version ≥0.144 + 版本同步) | `openai_codex_identity.go`、`openai_codex_version_sync_service.go` | `saas/gateway/codex/identity.ts` |
| 指纹收敛(off/device/session/full + seed 派生) | `openai_codex_fingerprint.go` | 同上(默认 off) |
| 每账号身份命名空间 | `openai_codex_account_identity.go` | 同上(必做) |
| turn-state 溯源守卫 | `openai_codex_turn_state.go` | 同上 |
| Codex 请求变换(store/stream/system→instructions/python 别名等) | `openai_codex_transform.go` | `saas/gateway/codex/transform.ts` |
| 内置 Codex 基础提示词(按模型家族) | `internal/pkg/openai/instructions*.txt`(go:embed) | `saas/gateway/codex/instructions/` |
| 配额头解析+5h/7d 归一化 | `openai_gateway_usage.go: ParseCodexRateLimitHeaders` | `saas/gateway/codex/quota-headers.ts` |
| 健康分类矩阵(401/403 strike/429/529) | `ratelimit_service.go`、`openai_gateway_upstream_errors.go` | `saas/gateway/codex/health.ts` |
| 刷新竞态恢复 | `oauth_refresh_api.go: tryRecoverFromRefreshRace` | R4 worker 扩展 |
| SSE 断连后抽干收 usage | `openai_gateway_response_handling.go` | codex transport |
| QPS WS(单快照广播+5s 窗口) | `admin/ops_ws_handler.go` | observability |
| 通道监控 V2 被动聚合+错误 taxonomy | `channel_monitor_v2_*` | observability(状态页) |
| 告警规则/静默/leader 评估器 | `ops_alert_evaluator_service.go` | observability |
| 审计中间件+settings diff | `middleware/audit_log.go`、`setting_handler_audit.go` | platform/audit 增强 |
| 粘性会话(sessionHash 优先级链) | `openai_gateway_scheduling.go: GenerateSessionHash` | Redis 热状态 |
| API key 5h/1d/7d 滚动窗口(Redis hash+Lua+date_trunc 锚定) | `billing_cache.go`、`api_key_repo.go` | keys/ 预算扩展参考 |
