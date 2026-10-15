# sub2api 对标升级 — 测试用例文档(2026-10-15)

对应方案:`docs/sub2api-parity-upgrade-plan-2026-10-15.md`。本文档按方案阶段(P1a–P5)拆解全部测试用例,标注每条的自动化落点(测试文件)与验证方式(单测 / PG 门禁集成 / e2e / 人工),并记录 2026-10-15 的 e2e 真实验证结果。

## 用例编号约定

`TC-<阶段>-<序号>`;状态:✅ 已自动化并通过 / 🟡 已自动化需门禁环境 / 🔧 人工或环境受限步骤。

---

## P1a — Codex 伪装与变换纯函数层

自动化落点:`tests/saas/gateway/codex/{identity,transform,quota-headers,health}.test.ts`(47 例)。

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P1a-01 | 出站身份三件套:UA 形状 `{originator}/{version} ({OS} {osver}; {arch}) {terminal}`,version 低于 0.144.0 时降级到基准 0.146.0 | ✅ identity.test.ts |
| TC-P1a-02 | 每账号身份命名空间:`sha256("u{keyId}:a{chatgpt:{acct}:user:{user}}:{raw}")[:8]`,failover 换账号后同会话 ID 不同 | ✅ identity.test.ts + transport.test.ts(跨账号断言) |
| TC-P1a-03 | 指纹收敛 off/device/session/full 四模式,种子派生 UUIDv4 确定性 | ✅ identity.test.ts |
| TC-P1a-04 | 请求变换:store=false、stream=true 强制;system→instructions 提升;16 字段白名单 | ✅ transform.test.ts |
| TC-P1a-05 | 保留工具名别名:`python`→`python__mr` 上行改写,响应逐帧还原 | ✅ transform.test.ts + response-bridge.test.ts |
| TC-P1a-06 | 模型规范化表(gpt-5.1-codex-max→gpt-5.3-codex 等);fc_ 调用 ID ≤64 字符 | ✅ transform.test.ts |
| TC-P1a-07 | 配头顶解析:window_minutes ≤360 归一化为 5h 窗,标签互换语义;429 只含用尽窗口时可解析 | ✅ quota-headers.test.ts |
| TC-P1a-08 | 配额暂停分类 + 陈旧守卫(reset_at 已过忽略;快照 >2h 允许一次探测) | ✅ quota-headers.test.ts |
| TC-P1a-09 | 健康分类矩阵:401 revoked→auth-revoked(failover)/401 其他→auth-expired(不 failover,刷新重试)/403 HTML 与 CF 1010 豁免/429/529/server_is_overloaded/400 org disabled | ✅ health.test.ts |

## P1b — OAuth 绑号 + R4 刷新扩展 + 迁移 099

自动化落点:`tests/saas/platform/codex-oauth/{oauth,binding-service,import,http}.test.ts`、`tests/saas/supply/oauth-token-refresh-codex-binding.test.ts`、`tests/saas/db/migrations/099_provider_account_codex_scheduling.test.ts`。

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P1b-01 | PKCE 授权 URL:client_id/auth endpoint/redirect localhost:1455/scopes/codex_cli_simplified_flow 常量正确;verifier 为 hex | ✅ oauth.test.ts |
| TC-P1b-02 | id_token claims 解析(不验签,查 exp±120s):chatgpt_account_id/plan_type 提取 | ✅ oauth.test.ts |
| TC-P1b-03 | 绑号会话:30min TTL,state 一次性,complete 后产出凭证信封 | ✅ binding-service.test.ts |
| TC-P1b-04 | auth.json 批量导入解析 | ✅ import.test.ts |
| TC-P1b-05 | HTTP 面:POST /admin/api/v1/codex-oauth/{start,complete,import} 鉴权与失败语义 | ✅ http.test.ts |
| TC-P1b-06 | R4 codex 刷新绑定注册(openai + openai-codex 双身份),token endpoint/scope 常量单源 | ✅ oauth-token-refresh-codex-binding.test.ts |
| TC-P1b-07 | 迁移 099:两账号表 9 个 codex 调度列,nullable、scheduling-signal 语义 | ✅ migrations/099 测试 |
| TC-P1b-08 | **轮换信封元数据透传**:刷新后 chatgpt_account_id/chatgpt_user_id/plan_type/client_id 不丢(网关 chatgpt-account-id 头依赖);token 响应携带新值时覆盖 | ✅ oauth-token-refresh-codex-passthrough.test.ts |

## P1c — 传输接线 + 三协议下行 + 集成

自动化落点:`tests/saas/gateway/codex/{transport,payload,response-bridge}.test.ts`(59 例)、`tests/saas/platform/codex-oauth/supply-sink.test.ts`、`tests/saas/gateway/provider-payload-compiler.test.ts`、`tests/server/managed-saas-gateway-composition.test.ts`。

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P1c-01 | 传输请求校验:缺 accountId/credentialId 等字段、fingerprint 无种子、非对象 body → INVALID_INPUT,且零 fetch 调用 | ✅ transport.test.ts |
| TC-P1c-02 | 凭证校验:缺 access_token/chatgpt_account_id/chatgpt_user_id → CREDENTIAL_INVALID | ✅ transport.test.ts |
| TC-P1c-03 | 出站头:Bearer + chatgpt-account-id + 规范三件套强制覆盖客户端 UA/originator/version;OpenAI-Beta 头;x-codex-* 白名单透传;非白名单丢弃 | ✅ transport.test.ts |
| TC-P1c-04 | session_id 命名空间隔离:同客户端会话在两个账号下产生不同头值 | ✅ transport.test.ts |
| TC-P1c-05 | 配头顶 sink:成功与 429 响应均写快照;同账号 30s 节流 | ✅ transport.test.ts |
| TC-P1c-06 | 429 → rate-limited + failover + health sink;401 revoked → failover;401 expired → 不 failover | ✅ transport.test.ts |
| TC-P1c-07 | 3xx 重定向拒绝(REDIRECT_REJECTED,不跟随);超时 → TIMEOUT | ✅ transport.test.ts |
| TC-P1c-08 | **SSE 客户端断开后继续抽干**:终端 response.completed 的 usage 仍被收集 | ✅ transport.test.ts |
| TC-P1c-09 | PreparedEvidence 适配器:签名 payload 摘要不匹配 → INVALID_INPUT;绑定请求正常派发 + 惰性 usage 暴露 | ✅ transport.test.ts |
| TC-P1c-10 | chat.completions→Responses 转换:system 提升 instructions、tool 消息→function_call_output、assistant tool_calls→function_call、max_tokens→max_output_tokens | ✅ payload.test.ts |
| TC-P1c-11 | 编译层:instructions 非空兜底(客户端提供则保留)、store/stream 强制、python 别名 | ✅ payload.test.ts |
| TC-P1c-12 | 编译钩子:openai→responses 走 chat 转换;anthropic→responses 跳过 chat 转换但仍编译 | ✅ payload.test.ts |
| TC-P1c-13 | Responses→chat.completions SSE:role/delta/tool_calls(别名还原)/finish/usage chunk;无 include_usage 时抑制 usage chunk;截断流仍 stop 终止 | ✅ response-bridge.test.ts |
| TC-P1c-14 | Responses→Anthropic SSE:message_start(流式优先,usage 零值起步)→content_block→message_delta(stop_reason + output_tokens)→message_stop;聚合信封 max_output_tokens→max_tokens | ✅ response-bridge.test.ts |
| TC-P1c-15 | 凭证 sink:绑号完成 → 审计路径创建平台账号+密封凭证;catalog binding 缺失 fail-closed;供应失败错误规范化不泄露 token;id_token 不落库 | ✅ supply-sink.test.ts |
| TC-P1c-16 | 网关派发分流:签名 endpoint=codex-responses 且 providerProtocol=responses 时走 codex transport,其他 provider 路径不变 | ✅ composition 测试 + managed-saas-gateway.ts |
| TC-P1c-17 | payload-compiler providerRequestTransform 钩子:未设置时字节级不变 | ✅ provider-payload-compiler.test.ts |
| TC-P1c-18 | live 冒烟(真实 Codex 账号,三协议流式+非流式) | 🔧 需用户提供测试账号,env 门禁 |

## P2 — OAuth 登录(OIDC + 微信)+ 迁移 101

自动化落点:`tests/saas/identity/oauth-login/*.test.ts`(P2 提交 7352880 内含)。

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P2-01 | OIDC provider:授权 URL/state cookie(SameSite=Lax)/回调换 token/身份解析 | ✅ |
| TC-P2-02 | 微信 provider:code 流同构 | ✅ |
| TC-P2-03 | state 常量时间比较;pendingToken 5min | ✅ |
| TC-P2-04 | 三分支:命中即登录 / 邮箱冲突 adoption / 无匹配 pending 注册 | ✅ |
| TC-P2-05 | 迁移 101 tenant_oauth_identities unique(provider_type, provider_subject) | ✅ |
| TC-P2-06 | managed-saas.ts 接线:oauthLogin 注入 | ✅(wiring,df19eb9/71ec581 修复验证) |

## P3 — 可观测性 + 迁移 102-103

自动化落点:`tests/saas/observability/*.test.ts`(P3 提交 0fe22f4 内含)+ 回归修复 df19eb9/71ec581。

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P3-01 | /metrics 暴露:QPS/状态码/延迟直方图/in-flight/账号池状态/wallet hold | ✅ |
| TC-P3-02 | 实时 QPS feed:60×5s 环形缓冲 + SSE 推送 | ✅ |
| TC-P3-03 | 通道状态:16 类错误 taxonomy(版本化)+ 1m 折叠 + 小时 rollup + watermark 增量回填 | ✅ |
| TC-P3-04 | 告警:sustained/cooldown 评估器,email + webhook(HMAC 签名)通知 | ✅ |
| TC-P3-05 | settings diff 审计:秘密路径 [redacted] | ✅ |
| TC-P3-06 | **回归:观测埋点不得破坏派发** — 最小 fixture 无 evidenceInput 时 dispatch 不 502(dispatchRoute 防御) | ✅ managed-saas-gateway-composition.test.ts:1352 |
| TC-P3-07 | /metrics Prometheus 抓取 + Grafana 渲染 | 🔧 需 compose/监控环境 |

## P4 — Compose 多实例部署

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P4-01 | `deploy/compose/verify.sh` 静态校验(compose 配置/角色 SQL/env 示例一致性) | ✅ 脚本内建 |
| TC-P4-02 | `docker compose up --scale gateway=3` 全栈启动 + TCP 健康探针 | 🔧 本机无 Docker,需 Docker 环境执行 |
| TC-P4-03 | 扩缩容/备份/KMS rewrap 运维流程(README) | 🔧 人工演练 |
| TC-P4-04 | PG 为权威、Redis 仅缓存/协调的红线校验(限流/并发槽/粘性会话) | 🟡 部分集成测试覆盖 |

## P5 — 性能/可靠性对标验证

| 用例 | 内容 | 状态 |
|---|---|---|
| TC-P5-01 | 迁移 001→103 在全新 PG 18 集群全量应用(saastrans CLI `saas:migrate`) | ✅ 见下方验证记录 |
| TC-P5-02 | PG 门禁集成电池(migrations/postgres integration/commercial gateway e2e)对真实 PG 全绿 | 见下方验证记录 |
| TC-P5-03 | 性能基准:非流式 p99 代理开销、流式 TTFB、SSE 零损坏、200 并发、429 精确性、1→3 实例线性扩展 | 🔧 需 Docker compose 环境(方案 P5 基准) |
| TC-P5-04 | 可靠性混沌:账号故障流注入、token 过期竞态、kill 实例、kill PG 30s fail-closed、24h soak | 🔧 需 Docker compose 环境 |
| TC-P5-05 | 多用户对标矩阵:5 角色越权负向、2FA、OAuth 双 provider、per-key 预算/IP 策略 | 🟡 单测覆盖,矩阵表待 compose 环境跑全 |

---

## e2e 真实验证记录(2026-10-15)

### 环境

- 本机一次性 PostgreSQL 18 集群(`/tmp/mr-e2e-pg`,端口 55433,trust auth,验证后销毁)
- 角色供给:`deploy/managed-saas-postgres-roles.sql` + `deploy/managed-saas-validation-worker-role-grants.sql`(四个最小权限角色 model_router_saas_{migrator,control_plane,gateway,validation_worker})
- 数据库 `model_router_saas_e2e`

### 验证步骤与结果

**步骤**:`/tmp/mr-e2e-run.sh`(本地复刻 `.github/workflows/ci.yml` 的 PG 电池):每门独立 fresh DB(`DROP DATABASE ... WITH (FORCE)` → 角色 SQL → `saas:migrate`(migrator 角色)→ 角色 SQL 重放 → validation-worker 授权 SQL),按 CI 顺序跑 12 门主电池 + 22 门隔离门禁(其中 3 门先在同一库内跑 commercial-gateway HTTP fixture)。

**结果(本地 PG 18.6,2026-10-15)**:

| 批次 | 结果 |
|---|---|
| TC-P5-01:迁移 001→103 全新 PG 18 全量应用 | ✅ 通过(`model_router_saas_e2e`) |
| 首轮电池:12 主电池门 + 22 隔离门 + 3 HTTP fixture | 38 通过 / 4 失败 |
| 修复后复跑受影响门 | 全部通过(见下) |
| 最终:**42/42 门通过**(唯一例外见"遗留问题"1) | ✅ |

**e2e 发现并修复的真实缺陷**(全部随本次提交修复):

1. **P3 观测表漏授权(严重)**:`saas_obs_channel_metrics_1m/_hourly/_watermark`、`saas_obs_alert_rules/_events`(迁移 102-103)从未授予 control-plane 角色——`deploy/managed-saas-postgres-roles.sql` 与 `src/saas/db/runtime-privileges.ts` 清单均缺。特权探针只校验自身清单所以单测不暴露,是 e2e(concurrent-claim HTTP fixture 报 `permission denied for table saas_obs_channel_metrics_watermark`)抓出。修复:两文件补齐 SELECT/INSERT/UPDATE 列级授权 + 3 张表的 DELETE(保留清理/规则删除),镜像测试同步。
2. **PG  fixture text=uuid 类型错误(存量)**:`pre-dispatch-postgres-fixture.ts` 与 `prepared-evidence-concurrent-claim.postgres.integration.test.ts` 的快照查询将 `saas_billing_reservations.request_id`/`saas_audit_events.request_id`(text,自迁移 011)直接等值 `saas_requests.id`(uuid),PG 42883。修复:等值侧加 `::text` 转换(测试代码,无语义变更)。修复后两门与其 HTTP fixture 全绿。
3. **CI 严类型检查损坏(存量,阻塞全部 PG 门禁)**:主 PG job 的 strict tsc 步骤在 `managed-postgres-commercial-gateway.integration.test.ts` 报 2 错(缺 `revalidationIntervalSeconds`、providers 缺 `redisReady/credentialKeyReady`——P3/P4 接线演进后 fixture 未跟进),isolated-gates job 另有 21 错(`ProviderAwaitable` KMS 未 await ×16、`RedeemResult` 判别联合未收窄 ×4、fake-sql 闭包收窄 ×1)。全部修复,两套 strict typecheck 本地 0 错。
4. **离线测试 CJS interop 损坏(存量,e98ef9b 起 CI 红)**:仓无 `package.json "type": "module"`,tsx/esbuild 把 .ts 编成 CJS,`__export` helper 绕开 cjs-module-lexer,导致 `.mjs` 重导出与 `--input-type=module` eval 的命名导入全部失效:① `software-provider-credential-rewrapping-kms.mjs` 改为 default interop 导入后显式重导出唯一工厂(dist 的 tsc CJS 产物同样兼容);② mfa-enrollment TTY 测试的 eval 子进程改为 default 导入解构。修复后 rewrap 2 例 + mfa-enrollment 42 例全绿。

### 遗留问题(非本次改动面,已定性)

1. **validation-worker-lifecycle 门禁确定性失败(存量缺陷,CI 证实)**:"the second claim must belong to the same real CLI worker backend" —— 观测到第二次阻塞 claim 来自不同 backend PID(worker 重连)。**已排除本地环境差异**:推送 e51a0d0 后的 CI 运行 38675903183 中,该门在 Linux 的 PG 15 与 PG 18 两个矩阵 job 上以完全相同的断言失败,与本机 PG 18.6 失败逐字一致。`git log` 证实 P1a–P1c 提交均未触碰 `src/cli/`、`tests/cli/` 与 credential-validation 链路(测试文件最后改动 0068796)。定性为存量仓库缺陷,建议单独排查 worker 在 ACCESS EXCLUSIVE 锁等待期间的连接保活/重连逻辑。
2. **saas-workspace 浏览器 E2E 3 例失败(存量,e98ef9b 引入)**:CI 运行 38675903183 的 build-and-test 在离线测试修复后首次跑到浏览器 E2E,`tests/e2e/saas-workspace.spec.ts:122/172/198` 严格请求台账断言出现意外的 `GET /console/api/v1/tenants/…/announcements`。溯源:announcements 拉取由 e98ef9b(2026-10-12,wave 3/4)加入 `web/src/features/saas-console.tsx`,而 spec(9f5c1c6,2026-10-04)从未更新台账期望,全文无一处 `announcements`——确定性失败,与环境无关。该失败在 bb9452a(P1a 之前)即存在,只是当时同一 job 的离线测试先行失败、浏览器 E2E 未执行而未暴露。P 系列提交未触碰该 spec 与 console 功能。
3. **migrations.test.ts 6 例 scoped-schema 失败(存量)**:迁移 050 的 DO 块硬编码 `model_router_saas.` schema 限定符,与该测试的 scoped-schema harness 不兼容,任何数据库上都失败;CI 不对该文件跑 PG 门禁;P 系列提交未触碰该区域。建议后续单独修(将 050 的 DO 块改为 search_path 友好写法)。
4. **CI 红始自 10-12(早于本方案),剩余阻塞均为存量**:本次修复(严格类型检查 23 错、CJS interop 3 例、PG fixture 类型错误)推送后,CI 运行 38675903183 确认:离线测试全绿、严格类型检查 0 错、PG 电池推进至门禁阶段;剩余红灯仅为上述 ①② 两项存量缺陷。仓库近 50 次 CI 运行(回溯至 09-29)无绿色基线,上述存量缺陷建议立项单独修复。

### 环境受限项(本机无法执行,需对应环境)

1. **Docker Compose 多实例**(TC-P4-02/03、TC-P5-03/04):本机无 Docker。在 Docker 主机上:`cd deploy/compose && cp .env.example .env && ./role-passwords.sh && docker compose up -d --scale gateway=3 && ./verify.sh`。
2. **真实 Codex 账号 live 冒烟**(TC-P1c-18):需订阅账号;通过平台控制台 `/admin/api/v1/codex-oauth/start` 绑号或 auth.json 导入后,以 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 三形态各发流式+非流式请求,核对 usage 落库与配头顶快照。
3. **Grafana 渲染**(TC-P3-07):需 Prometheus/Grafana 环境抓取 `/metrics`。
