# model-router 全能力补全路线图（对标 sub2api）

> 状态：已评审并经 4 路代码核验修订（v2）| 日期：2026-10-16 | 前置：`sub2api-parity-upgrade-plan-2026-10-15.md`（Codex 转售专项，其 1.1–1.4 已落地为 `src/saas/platform/{claude,codex,gemini}-oauth/` + 迁移 099/100/108/111）
>
> 依据：sub2api 五路代码深挖 + model-router 内伤勘察（bench R9/RERUN，P1–P18，R1 遗留）+ **2026-10-16 四路交叉核验**（批次一/二三/四五落点核验 + sub2api 索引逐项对账，基线 commit `cd29865`/`8b4661f`）

## 已确认的架构决策

| 决策项 | 结论 |
|---|---|
| TLS 指纹 | **Go sidecar**（独立进程持 utls 做 TLS 拨号，本地 IPC） |
| 多模态计费 | **完整新维度**（新迁移加列 + 新 PriceMetric，不用合成 token 桶） |
| OpenAI Live（WebRTC + DeviceCheck） | **砍掉** |
| 依赖纪律（核验新增） | **运行时依赖保持 6 个不动**：xxhash 用 `node:crypto` 或手写纯函数、SigV4 手写（+1–2 天）、S3 转存用 undici+手写 SigV4 presign 或 provider module 模式，**不引** xxhash-wasm / @smithy/signature-v4 / aws-sdk |
| 迁移编号（核验新增） | 111 已被 gemini scheduling 占用，**全部新迁移从 112 起编**（串行编号纪律） |

## 核验发现的两个批次前置决策项（先拍板再开工批次二）

1. **Redis 进 gateway 的部署契约**：compose 里 gateway 服务无 REDIS_URL（只有 control-plane 有）；RESP 客户端刻意无 PubSub、白名单仅 PING/AUTH/SELECT/EVAL、单帧 ≤16KB / bulk ≤8KB。粘性滑动续期（新 EVAL 脚本，半天）、5h 窗口缓存、TLS 档案缓存全部隐含此依赖。选项：a) 改部署契约（compose/systemd/launchd/docker 四套资产 + 角色模板 + bench 拓扑，1–2 天）；b) 粘性 PG-only（041 表有索引但每请求一次 PG 查询，与 p99<30ms 目标打架）。**建议 a，作为批次二第一个任务。**
2. **dormant 列裁决**：099 的 `auto_pause_5h/7d_threshold`（无消费方）与 2.2 的阈值停调**合并复用而非再造新列**；099 的 `codex_fingerprint_mode/seed`（无消费方）与 TLS `profile_id` 绑定的关系（合并还是并存）**开工 2.4 前裁决**，否则造两套平行机制。

## 横向移植律（全程遵守，核验后修订）

1. **纯函数先行**：协议转换、SigV4、EventStream 解码、Aho-Corasick 都是可直译的纯算法——注意 apicompat 并非字面零依赖：4/16 文件引用 `internal/pkg/{claude,openai}` 模型谓词（~440 行需连带移植）。
2. **同一条解析链**：展示价、风控、插件转发复用计费解析链。
3. **fail-closed 计费 / fail-open 风控**。
4. **幂等三层**：dedup claim + payload 指纹 + 稳定请求 ID 前缀。
5. **DB 为权威 + reconcile 循环**（Redis 不可靠/不可用时一律退回此律）。
6. **授权镜像纪律**：任何被触发器读取/新角色需要的新列，`runtime-privileges.ts` + `managed-saas-postgres-roles.sql` + `credential-validation-worker-privileges.ts`（涉账号列时**三处**）+ mirror 测试必须同步——批次二/三的每个迁移都要点名执行，不是可选项。
7. **R1 快照红线**：组限额执法走冻结快照——**注意现有 customer price snapshot 不携带组限额字段，需先扩展快照列族 + digest 材料（见 1.3）**。
8. **不造平行权威**（核验新增）：凡现有机制已覆盖的（health-classifier 错误矩阵、H5c 进程内快路径、代理回退、粘性 Redis 快路径），一律**扩展现有实现**，禁止新造平行层。

---

## 批次一：修内伤（4 线并行；其中两项已完成）

### 1.1 P15 —— ✅ 已完成（commit `cd29865`，2026-10-16）

镜像补列 + mirror 测试 + PG 18.6 全迁移链真库验证均已随提交完成（`runtime-privileges.test.ts:912-931` 有新列断言）。**剩余验收仅一项**：真部署上以 control-plane 角色跑通 sweep、清掉 bench 遗留的 62 条 `not_sent/pending` attempt。`SECURITY DEFINER` helper 保留为触发器演化时的备选策略。

### 1.2 P4/P16 准入去串行化（关键路径；核验后方案重排）

根因确认：per-wallet `saas_wallets` 行锁（`billing/service.ts:987-1005` lockWallet，整个 work 事务持锁到 COMMIT，且在容量围栏**之前**获取——`postgres-preparation-ports.ts:855` 注释）+ 多进程锁护送 → 495 次池获取超时 → 503。

**Step 1 —— ✅ 已完成**（commit `8b4661f`，单把 tenant 级 late-acquired advisory lock，`postgres-preparation-capacity.ts:234`）。

**⚠️ 原方案「钱包乐观 CAS（UPDATE ... WHERE available >= $2）按字面不可实现**——`saas_wallets` 只有 `posted_balance_minor_units`，无 `available`/`frozen_balance` 列；可用额是派生值 = posted − SUM(reservations ∈ reserved/reconciliation_pending) − SUM(refund freezes)（`walletSummary` service.ts:1017-1039）；hold→settle 靠 reservations 状态机，reserve 不写 wallet 行。**修订后的 Step 2/3：**

| Step | 内容（修订版） | 风险与前置 |
|---|---|---|
| 2（先做，零语义风险） | **准入语句数削减**：prelock 快照重读与守卫重验合并为一条 CTE。注：`/v1/models` 本就绕过 preparation（http-handler.ts:738 直接 authenticate+discovery），57ms 是该旁路实测值，无需再做「轻量旁路」 | 纯只读优化 |
| 3（替代 CAS 的中间档） | **钱包 XACT advisory lock 替代行锁**（按 wallet hash 分片键的 `pg_advisory_xact_lock`）：仍串行但无行锁跨 fence 等待、不动账本模型、不破坏 spending-freeze 冻结门（freeze 写入仍被钱包 fence 串行化——`service.ts:347-352` 注释明言 wallet 行是每个 freeze writer 的 transaction fence） | 需评估与容量 fence 的锁序 |
| 4（最后手段，仅当 3 不达标） | **反规范化 CAS**：wallet 行新增 `on_hold_minor_units` 计数列（新迁移 + 授权镜像！），CAS 语句 `SET on_hold = on_hold + $2 WHERE posted - on_hold >= $2`；该计数必须被 settle/release/reconciliation 转移/充值/退款/correction **全部写路径**精确维护 | 破坏 H4 锁序不变式（`admission.ts:764-771`）需重证 `takeScopeLock` 死锁安全性（capacity 文件 222-232 注释）；冻结门需改为 XACT lock 或 freeze 行 FOR SHARE 串行化；**列为本方案最大技术风险** |

- **验收**：bench 3 实例 ≥2.7×、admission p99 <30ms、0 次池超时、灾备三演练全绿。
- **合流点**：与 1.3 重叠于 `postgres-preparation-capacity.ts`；**必须先合 1.3 再做本项 Step 3/4**——1.3 的组 RPM 判定落在 tenant fence 内会加宽互斥窗口，只有后置的 1.2 才能重新压回并复测。

### 1.3 R1 分组限额执法（✅ 先例属实；核验补一块横切）

| 项 | 先例（核验确认） | 落点 |
|---|---|---|
| 组 RPM | 迁移 098 + `admission.ts:815` recordAccountRateConsumption（admission commit 事务内原子 upsert） | 新迁移（112+）建 `saas_billing_group_rate_counters`；capacity adapter `reserve()` 处判定。⚠️ capacity adapter 现有纪律是 "never touches wallet tables"（:289 注释），挂组表需在注释/设计上显式破例 |
| daily/weekly/monthly | 迁移 081 KEY-BUD reserve-first-then-check（`postgres-preparation-budget.ts:17` 注释）+ `keyBudget.reserve` 同事务（ports.ts:816） | 挂 `billing.reserve` 之后同事务；结算 outstanding→settled |
| **API key 5h/7d USD 消费窗口**（核验新增，sub2api `api_key.go` RateLimitWindow5h/7d） | 同 KEY-BUD 计数器模式 | 面向客户的配额语义，与 KEY-BUD 储备制天然契合 |
| `supported_model_scopes` | scheduler `profile.model_scopes @>`（392/577）+ `http-handler.ts:348` authenticatedModelScopes | preparation 路由层 + scheduler 资格 SQL |
| `fallback_group_id` 多跳 | F2 一跳（`resolveBillingGroupForSelection` 1902–1953） | 扩为带环检测链 |
| **快照横切（核验新增，原方案遗漏）** | — | 现有 customer price snapshot（017/`snapshot.ts`）**不携带组限额字段**；满足 R1 红线需扩展快照列族 + digest 材料 + hold evidence + 授权镜像。这是 1.3 里最大的一块隐形工作量，必须列入 |
| 结算侧 profit control | — | 后置：等 supplier usage 事实进快照 |

- **验收**：组/key 限额超限 429/402 码位正确；执法走冻结快照（digest 校验）；多跳环检测；金样调度回归不漂移。

### 1.4 apicompat 移植（核验后重划范围）

- **Phase A（照原计划）**：`responses→openai` 真转换。移植源（修正归属）：请求向 `chatcompletions_responses_bridge.go`（2280 行）；事件向双映射——`ChatCompletionsChunkToResponsesEvents` 在 **`chatcompletions_responses_bridge.go:1687`**、`ResponsesEventToChatChunks` 在 **`responses_to_chatcompletions.go:146`**（原文档归错文件）。连带移植 `internal/pkg/{claude,openai}` 模型谓词（~440 行）。
- **改动面（核验修正）**：不止 `SUPPORTED_BRIDGE_PAIRS`（两处校验 517/974）——**必须重写 `src/protocol/bridge.ts` 的 `ResponsesToOpenAIBridge`**（148 行 passthrough stub，transformRequest/Response 恒等）；顺带 `gemini→anthropic`、`responses→anthropic` 的 stub pair 同样未注册/是 passthrough，若目标是 apicompat 对齐应把 4×4 矩阵完成度列全。
- **Phase B（从「顺带」升格为独立任务，工作量核验重估）**：`openai→gemini`、`responses→gemini` 等 gemini 跨协议对——**全仓零实现**（F4 transform 只有 anthropic→gemini 请求向且仅探活使用；gemini 响应向只有 gemini→anthropic）。每个方向需请求体+非流式信封+SSE 流式+usage/finish_reason/tool_calls delta+wrapError 全套，参照 codex response-bridge（771 行）量级——**这是 2 个完整 bridge，约 4–6 人日**。前置裁决：现有 `src/protocol/gemini.ts` 简化版 bridge 与 F4 生产 transform 并存，新增 pair 前先收敛到 F4 质量层，否则复制简化版。

---

## 批次二：账号池运营核心（核验后重排：25–30 人日）

### 2.0 前置：Redis 进 gateway 部署契约（1–2 天，见前置决策 1）

### 2.1 粘性会话调度（核验修正：现状比原方案认知更完整；6–9 人日）

- **现状**：迁移 041 PG 权威表（TTL ≤24h、fencing、不可变触发器）+ **R6b Redis 快路径已落地**（`redis-sticky-provider-account-affinity.ts`，`mr:sticky:v1:{digest}` 固定 1h TTL、fail-open）；调度器里 affinity 解析已发生在比较链之前、命中即选 preferred——「模型路由>粘性>负载均衡」结构上已成立。
- **真实增量**：① 滑动续期（RESP 白名单加一条 GET+PEXPIRE EVAL 脚本，半天）；② **sessionHash 口径对齐**——已落地的 `computeStickySessionHash` 四级优先级（session-id→conversation_id→prompt_cache_key→content-hash，`redis-concurrency-slots.ts:176`）与 sub2api 三级来源不是同一套，需合并设计并可能扩 041 的 `reference_kind` 枚举；③ **传递链接通**——`input.scheduling` 目前无生产填充方（redis-sticky 注释原话），要加 http-handler 字段→preparation 穿透→scheduler input；body 解析点可复用 `readJsonBody` + `claudeCodeClient.body`（G1 先例）；④ 三态门 + 预留带（封在「仅当 affinity ref 存在」分支内，默认路径不动以保 golden fixture）。
- **修正**：hash 用 `node:crypto` SHA-256 或手写 xxhash64（零依赖纪律），不引 xxhash-wasm。
- **验收**：同会话命中率 >95%；TTL 过期漂移；预留带测试；golden 回归 byte-identical。

### 2.2 5h 窗口 + 阈值停调（5–8 人日；核验修正：列已就绪但写入管线未接通）

- **已完成**：claude `quota-headers.ts` 已实现毫秒误传检测（>1e11 ÷1000）、5h/7d 范围校验、session window `[reset−5h, reset]` 推导。
- **缺口（按序）**：① **写入管线接通**——codex/claude 的 `codex_5h_used_percent`/`claude_5h_utilization` 等列 dormant（无写入方无消费方；现有 `maybeWriteRateLimit` 仅 429 触发，需放开成功路径 + 生产 PG writer 从 runtime module 挪进 repo）；② 窗口费用聚合 + 按窗口起点分组批量 SQL + 缓存（注意 RESP 16KB 帧限）；③ 阈值停调惰性评估——**复用 dormant 的 `auto_pause_*_threshold` 列**（前置决策 2），写 `temp_unschedulable_{until,reason}`（参照迁移 109 `probe_temp_unschedulable_until` 先例 + 三处授权镜像）。
- **验收**：窗口重置自动恢复；幂等（reason 比对）；金样回归。

### 2.3 账号状态机（3–5 人日；核验修正：大半已实现，扩矩阵勿造层）

- **已实现**（勿重做）：`oauth-subscription/health-classifier.ts` 共享矩阵已含 401 双分支（auth-revoked/auth-expired）、403 HTML/CF→transient、529、400 org-disabled；040 durable runtime health store；H5c 进程内快路径（401/403/429 指数退避）——「双写快路径」已存在。
- **真实增量**（扩展 classifyUpstreamError 矩阵 + 040 kind→冷却映射，**不新建 failure-feedback 层**）：402 CN 可恢复停调、403 再分类（Kimi 并发/配额窗口耗尽）、模型 404/plan-gated 30min 模型级限流、流超时阈值计数、OAuth 401 二次升级永久、429 全解析失败的秒级 fallback 冷却（clamp）、Grok 配额头歧义消解。
- **注意**：矩阵被 codex/claude/gemini 三品类共享，改动是跨品类回归面，表驱动测试三份。

### 2.4 TLS 指纹 Go sidecar（9–13 人日；核验修正落点与成本）

- **❌ 落点修正**：连接器插入点是 **`provider-http-address.ts` 的 `createPinnedProviderHttpConnector` connector 工厂**（~581–584，socks5h 分支旁），**不是** transport-skeleton（后者不碰 socket）。
- **档案缓存方案修正**：RESP 无 PubSub（设计上刻意不做）+ 16KB 帧限 → **放弃 Redis pub/sub 失效方案**，改为 PG 权威 + 进程内短 TTL + 接受短暂陈旧（移植律 #5）。
- **部署成本（原方案零字，必须列入）**：四套资产（compose/systemd/launchd/docker 镜像）+ bench 拓扑（BENCH.md + override yml）+ sidecar 健康检查进现有 healthcheck，3–5 天。
- **前置**：与 dormant `codex_fingerprint_mode/seed` 裁决关系（前置决策 2）。
- **近期零成本件**：dateline 文本指纹移植（0.5 天）不变。
- 其余（utls 三 dialer、档案表、内置 Node 24.x 默认指纹）照原方案。

### 2.5 代理回退 —— ✅ 已完成（核验发现原方案过时）

迁移 107 + `egress-proxy-probe-worker.ts`（环安全链解析、过期驱动 sweep、`FOR UPDATE SKIP LOCKED` + 重验 expires_at 的乐观锁）+ admin CRUD + 测试全部在库。**剩余仅 revert 便捷操作/管理端展示，≈0–0.5 人日，无新迁移。**

---

## 批次三：上游平台扩展（seam 前置 → 四平台并行；核验后结构修正）

### 前置：dispatch seam（1–2 天 ✅ 维持）

`endpointRoutingRoutes`（managed-saas-gateway.ts:1338–1350）加 `*EvidenceTransport` 选项 + route 注册。核验补充：**每平台还需参照 codex 写 ~100 行 `XxxPreparedEvidenceTransport` 适配器 + endpoint scope 进 catalog/signed evidence 链（2–4 天/平台）**，"一行注册"只指 seam 本身。runtime-module 机制向后兼容（纯增量选项）。

### 平台清单（每平台工时里**显式包含**：凭据管线全套——envelope 明文 shape（KMS 密封）+ supply-sink（credential_type 三处绑定）+ validation worker 适配 + probe category + 三处授权镜像；这些是隐形大头）

| 平台 | 核验修正要点 | 工时 |
|---|---|---|
| **Bedrock** | ❌ SigV4 **过不了**静态认证头 resolver（`ProviderSupplyHttpAuthenticationHeaderResolver` 只做静态头）——必须是自带签名 + EventStream 解码 + 请求体变换全在 transport 内的完整 EvidenceTransport。**手写 SigV4 纯函数**（零依赖纪律，可独立单测）；`@smithy/signature-v4` 不引。aws keys 进 sealed envelope 无障碍（credential_type 自由文本） | 8–10 |
| **Vertex SA** | JWT RS256 用 node:crypto 原生；**分布式锁复用 094 oauth-refresh-worker 的 PG SKIP LOCKED 模式**（勿发明 Redis 锁——gateway 无 Redis） | 6–8 |
| **Grok** | CLI 身份头伪装 + token 刷新复用 oauth-token-refresh-worker（compile-time 绑定模式，机械扩展）成立 | 6–8 |
| **智谱/MiniMax** | ⚠️ **非复用 legacy preset**——kimi/deepseek 只在 BYOK `src/providers/profiles.ts`；SaaS 里是**全新品类**（catalog+credential+probe+transport+调度迁移全套，先例是 opencode-go 的 protocol_rules） | 6–8 |
| **Gemini 原生 /v1beta** | 照原方案（delta 差量、哑值注入、SSE 注释行兼容、PST 午夜） | 4–6 |
| **模型发现** | ⚠️ 「header 覆写」机制现状是 probe 侧**复制常量**自建头——需先抽品类 transport 与 probe 共享同一个 header builder（防漂移，+0.5–1 天/品类） | 2–3 |

批次三合计 ~32–43 人日（原估 30 结构不对：seam+适配器+凭据管线显式化）。

---

## 批次四：多模态 + Composite — ⚠️ 核验发现 2 个致命前置，4.1 前必须解决

### 4.0 致命前置（原方案完全遗漏，不解决图片/音频端点跑不起来）

| 冲突 | 现状 | 对策 |
|---|---|---|
| **1MiB body 上限** | `http-handler.ts:27` DEFAULT_MAX_BODY_BYTES=1MiB（content-length 预检 + 流式累计双执行）；BYOK 侧默认 4MiB 同样不够音频（OpenAI STT 上限 25MiB） | 按端点族放宽（图片 ~10MiB、音频 ~26MiB），评估 admission fingerprint/内存占用 |
| **JSON-only Content-Type** | `supportedContentType()` 只放行 application/json（否则 415），全仓无 multipart 解析；preparation 全链假设 JSON body | **建议首期只做 JSON 的 generations + b64_json 模式**，明确砍掉 edits/文件上传并写明理由；multipart 是新传输面（新 body 通道 + fingerprint 策略），工作量与「加路由」不同量级，列为独立后置任务 |
| **GET 405** | ROUTES 命中后非 POST 一律 405 | 异步任务/视频查询的 GET 端点族需要方法分发扩展，与 4.2 同步排期 |
| **WS 零基础设施** | 无 upgrade 处理；admission/evidence/lease 模型是请求作用域 HTTP | Realtime WS 独立排期（见 4.3），需平行的准入/计费路径 |
| **PriceMetric digest 漂移** | `rateDigest()` 逐 metric 展开（含 null）；加 `per_unit` 会让老价格版本幂等重注册触发 IDEMPOTENCY_CONFLICT，golden/迁移 fixture 全漂移 | 明确策略：per_unit 为 null 不进 digest 材料，或 bump calculatorVersion 接受不可重注册 + 迁移测试钉死 |

### 4.1 计费维度扩展（核验补全改动面）

原 6 处横切全部属实，**另补**：
- **017 家族三张表**（原方案遗漏）：`saas_customer_price_versions`（每 metric 两列 + pair CHECK）、`saas_request_customer_price_snapshots`（8 个 hold_* 见证列 + hold_amount>0 CHECK）、`saas_attempt_supplier_cost_snapshots` 同构——新增 per_unit 计量三张全要动；
- **tier 维度**（原低估）：RateSet 无 tier 维度、price version 行无 tier 列——分层价（1K/2K/4K、480p/720p/1080p）要么 017 表加 tier 维度要么每 tier 一条版本行，需先做 schema 决策；
- **hold-calculator 形状**：`BillableUsageEnvelope` 是 token 形状，「图片按请求×单价上界」需新 envelope 分支而非扩展；
- **service_tier 计费规则**（核验新增，sub2api `service_tier_billing.go` 纯函数「observed tier 只许降价计费」）与**长上下文计费倍率**（sub2api LongContextInputThreshold/Inclusive/多pliers，Claude/xAI 真实计费差异）——不实现则按 token 转售会系统性算错价，挂进本项；
- S3 转存不引 aws-sdk（见决策表）。
- **验收补充**：老价格版本幂等重注册行为有迁移测试钉死；token 路径零变化回归。

### 4.2 图片（核验修正实现方式）

- **异步任务**：「拦截 res.write」改写为**新增 `RecordingClientStream`（`PreparedEvidenceClientStream` 内存实现）**——核验确认 dispatch 只依赖该接口（`prepared-evidence-dispatch-service.ts:454-563`），比 monkey-patch 干净；注意 a) http-handler 需改控制流（后台 promise 拒绝由 unknown-outcome-recovery-worker 兜底）；b) 录制缓冲内存上界必须显式；c) `202+Location` 需「替换响应」模式。
- 同步路径、S3 转存（失败即 failed）、尺寸归一化、keepalive（写过字节禁 failover）照原方案。

### 4.3 视频 / 音频 / 搜索

- 视频（异步计费状态机、create 快照、绑定账号回查、`video:<taskID>`）照原方案；
- 音频 HTTP（TTS/STT）照原方案；**Realtime WS 升格为独立子任务**——零基础设施，需 WS upgrade 处理 + 连接级准入/计费平行路径（`realtime:<uuid>` 不走 prepared-evidence 生命周期），估 4–6 人日；
- 搜索：依赖 1.4 apicompat；引擎参考修正为 `internal/pkg/websearch/` + `gateway_websearch_emulation.go`（原索引 `service/gateway_web_search.go` 是 handler，位置错）。

### 4.4 Composite（核验确认 + 修正）

- 落点属实（payload-compiler:869 已有 model 改写点 + provenance 强制；eligibility seam 同构）。修正：三级解析中**后两级（账号模型归属、前缀探测）完全不存在**——当前未知模型就是 fail-closed 拒绝，这是全新解析层；新表迁移从 112 起。

---

## 批次五：生态能力（6 线并行；核验修正）

### 5.1 插件系统

- **部署形态决策（核验新增）**：credential-validation-worker 是同代码库独立 workload（非 child_process 先例）。选项：gateway 进程内 spawn（全新能力）vs 独立 plugin-host workload（与现有部署形态一致、更安全）。**建议后者。**
- **KMS 边界（核验新增）**：本地对应物是 `gateway-provider-credential-unsealer.ts`（60s 解密缓存 + Buffer 用后 zeroize 纪律）。明文 token 经 stdio 交插件 = zeroize 纪律失效——需新设计（per-plugin 短时令牌 / envelope 下发 + 受限 KMS grant 让插件自解封），这是原方案没映射的安全设计任务。
- 其余四核心设计（DB 权威 reconcile、哈希对账握手、能力授权表、request_sent 不可重放）照原方案；「复用现有链」落点 = `PreparedEvidenceTransport` 接口。

### 5.2 OEM 白标（核验修正三处）

- 注入点属实（admin `serveStatic`、managed-saas.ts:684-725 serve index.html）；
- **settings KV 不能直接复用迁移 110**：key 正则强制 `saas.` 前缀；110 设计立场写死 gateway/validation-worker 无 grant——注入 `__APP_CONFIG__` 的正是 gateway，需**新增 public 只读面**（control-plane 物化公共快照 + `GET /settings/public` 新端点）；
- **CSP 冲突**：`managed-saas.ts:713-714` 的 `default-src 'self'; frame-ancestors 'none'` 会挡掉 iframe 自定义页与外链 logo——白标项需同步放宽 CSP（frame-src/img-src 按配置白名单）。

### 5.3 在线升级（照原方案，无核验修正）

### 5.4 内容风控

- 挂载点属实（authenticate→readBody→prepare 之间，body 在手，新 seam）；
- ⚠️ 现状修正：迁移 103 告警引擎的 **sustained（逐分钟连续违背+中断清零）+ cooldown + 单领导者已实现**，5.6 真缺口仅：自动 resolved、静默表、定时报表。风控本项照原方案（Aho-Corasick 实际 222 行、判定链、fail-open、副作用全套）。

### 5.5 模型广场（核验修正）

查询接口属实（SaasPricingService.listPlatformPricingTargets 等 + groups/snapshot）。⚠️ **OptionalJWT/匿名访问不存在**——网关只认 proxy key，`/v1/models` 是 auth-only；「匿名仅非专属分组」需要新认证模式，列入工时。

### 5.6 告警报表（缺口收窄为三项）

自动 resolved、静默表（DB+运行时两套）、定时邮件报表四类（cron+last_run 续算+领导者锁+min_count 门槛+先写 last_run 再生成）。sustained/cooldown/webhook 已实现勿重做。零依赖 SMTP（`identity/email-sender.ts`）复用确认。

---

## 核验后新增的补入项与明确不做

### 补入（sub2api 有、原路线图漏、双形态定位需要）

| 能力 | sub2api 参考 | 排期建议 |
|---|---|---|
| API key 5h/7d USD 消费窗口 | `ent/schema/api_key.go` | 并入 1.3（KEY-BUD 同构） |
| service_tier 计费（只许降价） | `service_tier_billing.go`（纯函数） | 并入 4.1 |
| 长上下文计费倍率 | billing_service.go LongContext* | 并入 4.1 |
| 峰谷/分时费率 | Group.Peak* + deepseekPeakMultiplierAt | 并入 4.1（分组定价可选维度） |
| 渠道监控/主动探活 v2 | `channel_monitor_*.go` | 批次二配套（账号池可观测性），可后置 |
| 审计日志中间件 | `audit_log*.go` + securityaudit | SaaS 形态合规件，批次五 |
| Claude Code/Codex 客户端版本同步 | `claude_code_version_sync_service.go` 等 | 既有品类维护项，低成本早排 |
| 公告系统 + 首启向导 | `announcement*.go`、SetupWizardView | 批次五，BYOK 可不做 |

### 明确不做（写入非目标，防止范围蔓延）

支付/订阅/返利（SaaS 已有 wallet+KEY-BUD，重复建设）；阿里云验证码；simple mode；手机端专项；内嵌 S3 备份系统（运维职责）；Antigravity 全家桶；Kimi K3/opencode zen 价目（是数据不是能力，走 models.dev 机制加条目）；~~OpenAI Live~~（已砍）。

---

## 并行编排与里程碑（核验后修订）

```
        周1-2      周3-5        周6-9         周10-14      周15+
─────────────────────────────────────────────────────────────
WS-A 内伤    [P15✅] → 1.3限额+快照横切 → 1.2语句削减→advisory锁→(CAS最后)
WS-C 桥接    apicompat PhaseA(responses→openai+protocol/bridge重写) → PhaseB(gemini对,收敛双实现后)
WS-D 调度    2.0 Redis部署契约 → 粘性(口径对齐+传递链) ‖ 5h窗口+状态机(扩矩阵) → TLS sidecar
WS-E 平台    [seam] → Bedrock(自带签名transport) / Vertex / Grok / 智谱MiniMax 四线
WS-F 多模态  4.0致命前置(body上限/JSON-only/GET/405/digest) → 4.1计费横切(含017三表+tier+service_tier+长上下文) → 图片→视频/音频→WS→search → batches
WS-G 生态    插件(host形态+KMS边界决策)/白标(CSP+public面)/升级/风控/广场(匿名认证)/报表
─────────────────────────────────────────────────────────────
M1=内伤清零+bench达标 → M2=账号运营同级 → M3=平台广度+多模态上线 → M4=生态完整
```

**依赖规则（修订）**：
1. 1.3 先合、1.2 后合（fence 加宽→再压缩的因果，见 1.2）；1.4 PhaseA 立即开工；
2. WS-D 以 2.0 部署契约开头；2.2 复用 dormant auto_pause 列；2.3 扩矩阵勿造层；
3. WS-E 每平台含 transport 适配器 + 凭据管线 + 三处授权镜像；Bedrock 走自带签名 transport + 手写 SigV4；
4. WS-F 以 4.0 为硬前置；4.1 含 017 三表 + tier schema 决策 + digest 策略；Realtime WS 独立子任务；
5. WS-G 风控等 1.2 落地后再挂 handler（避免合并冲突）；
6. 每批次收尾：bench + 灾备三演练 + 全量测试 + 新列的三处授权镜像 mirror 测试。

**规模重估（核验后）**：批次一 ~12（P15 完成、2.5 归零抵消 CAS 重构上浮）；批次二 **25–30**（原 20）；批次三 **32–43**（原 30，凭据管线+适配器显式化）；批次四 **40–48**（原 35，+4.0 前置 + 017 三表 + WS 独立）；批次五 ~32。**合计 ~140–165 人日**（原 130）；4–5 人并行关键路径（WS-A→4.0/4.1→媒体端点）约 12–14 周到 M3。

## sub2api 参考实现索引（核验修订版）

| 能力 | sub2api 位置（backend/ 除注明外） |
|---|---|
| 粘性/调度 | `internal/service/gateway_scheduling.go`、`gateway_service.go`（GenerateSessionHash L890）、`openai_account_scheduler.go` |
| 5h 窗口/阈值 | `internal/service/ratelimit_service.go`、`account_scheduling_threshold_eval.go`、`account.go`（CheckWindowCostSchedulability L3173） |
| 状态机 | `internal/service/ratelimit_service.go`（HandleUpstreamError L332） |
| TLS 指纹 | `internal/pkg/tlsfingerprint/dialer.go`（默认 JA3 `44f88fca...` = Node.js 24.x 实测）、`anthropicfp/dateline.go`（288 行） |
| 代理回退 | 链解析 `internal/service/proxy_fallback.go`（48 行纯函数）+ **sweep/乐观锁 `internal/repository/proxy_repo.go`**（SweepExpiredProxies）——两半都要看 |
| Bedrock | `internal/service/bedrock_signer.go`、`bedrock_request.go`、`bedrock_stream.go` |
| Vertex SA | `internal/service/vertex_service_account.go`（token_uri SSRF 防护 L131）、`gemini_quota.go` |
| Grok | `internal/pkg/xai/`（17 文件：oauth/cli_identity/billing/quota）、`internal/service/grok_*.go` |
| 国产供应商 | `internal/service/ratelimit_cn_providers.go`、`cn_provider_quota_service.go`、`cn_provider_balance_service.go` |
| Gemini 原生 | `internal/service/gemini_messages_compat_service.go`（3847 行） |
| 协议桥 | `internal/pkg/apicompat/`（16 非测试文件 + 35 测试 + testdata；连带 `internal/pkg/{claude,openai}` 谓词 ~440 行）；请求向 `chatcompletions_responses_bridge.go`、事件向 `chatcompletions_responses_bridge.go:1687` + `responses_to_chatcompletions.go:146` |
| 图片/批量 | `internal/handler/openai_images.go`、`internal/service/image_task.go`、`batch_image_*.go`（20+ 文件） |
| 视频/音频/搜索 | `internal/service/grok_media.go`、`grok_audio.go`；搜索 handler 在 **`internal/handler/gateway_web_search.go`**，引擎在 **`internal/pkg/websearch/`** + `internal/service/gateway_websearch_emulation.go`；alpha search `internal/service/openai_alpha_search.go` |
| 计费引擎 | `internal/service/billing_service.go`（CalculateCostUnified L1450；默认价 $0.134/图、$0.01/alpha search、$5/1k web search 均核实）、`model_pricing_resolver.go`、`service_tier_billing.go`、LongContext* 同文件；幂等 `internal/repository/usage_billing_repo.go` |
| Composite | `internal/service/composite_route_resolver.go`、**`docs/COMPOSITE_GROUPS.md`（仓库根 docs/）** |
| 插件 | `internal/service/plugin_*.go`、`pkg/pluginapi/v1/plugin.proto` |
| 白标 | `internal/service/setting_public.go`、`internal/handler/page_handler.go` |
| 升级 | `internal/service/update_service.go` |
| 风控 | `internal/service/content_moderation*.go`（Aho-Corasick 在 `content_moderation_keyword_matcher.go`，222 行） |
| 模型广场 | `internal/service/model_plaza_service.go` |
| 告警/报表 | `internal/service/ops_alert_evaluator_service.go`、`ops_scheduled_report_service.go` |
| 模型发现 | `internal/service/upstream_models.go` |
| API key 5h/7d 窗口 | `ent/schema/api_key.go`（RateLimitWindow5h/7d） |
| CC/Codex 版本同步 | `internal/service/claude_code_version_sync_service.go`、`openai_codex_version_sync_service.go` |

---

## 修订记录

- **v1（2026-10-16 上午）**：初版，五路调研整合。
- **v2（2026-10-16，四路核验后）**：① P15 与 P4-Step1 标记已完成（cd29865/8b4661f）；② CAS 方案按字面不可实现（无 available 列），重排为语句削减→advisory lock→反规范化 CAS 最后手段，补冻结门/锁序风险；③ 1.3 补快照横切与 API key 5h/7d 窗口；④ gemini 跨协议对从「顺带」升格（4 方向零实现，2 个完整 bridge）；⑤ 2.1 改为升级现有 Redis 快路径 + sessionHash 口径对齐 + 部署契约前置；⑥ 2.3 改为扩展现有矩阵；⑦ 2.5 标记已完成；⑧ 2.4 落点改 provider-http-address + 缓存方案重设计 + 四套部署成本；⑨ 批次三凭据管线/transport 适配器显式化，Bedrock 改自带签名 transport + 手写 SigV4，智谱/MiniMax 改全新品类；⑩ 批次四新增 4.0 五项致命前置（1MiB/JSON-only/GET 405/WS 零设施/digest 漂移）+ 017 三表 + tier 决策 + service_tier/长上下文补入；⑪ 异步任务改 RecordingClientStream；⑫ 插件补部署形态与 KMS 边界决策；⑬ 白标补 CSP 与 public 只读面；⑭ 告警 sustained/cooldown 已实现收窄缺口；⑮ 广场补匿名认证缺失；⑯ 零依赖纪律与迁移 112 起编入决策表；⑰ 补入 8 项遗漏能力 + 8 项明确不做；⑱ 索引表修正（websearch 包归属、代理回退双文件、函数归属）；⑲ 工时重估 130→140–165 人日。
- **v3（2026-10-17，merge origin/main 冲突解决）**：合入 main 侧 K1/K2（durable fail-away + egress allowlist 四传输接线）与 L1-L5（saas deploy/doctor/upgrade CLI、特权镜像 codegen、CI deploy-smoke）。关键裁决：① main 的迁移 `112_provider_account_durable_fault_classification` 与本分支 112-128 撞号，重编号为 **129**（001 注册表尾部追加，迁移内 version 同步改 129）；② 特权四镜像（runtime-privileges.ts / roles.sql / worker 两份）改用 main 的 **privileges-manifest 单一来源 + generate-privileges codegen 架构**，本分支 112-128 的全部授权事实经 `--extract` 反向录入 manifest，`--check` 字节一致通过；③ runtime-health store 语义并集——K2 的 durable 词汇（account_access/rate_limited/stream_abort + 短冷却曲线）与本分支 batch-2.3 的模型级注册表/401 升级/402/403/流超时共存，feedback outcome 词表取七值并集；④ 顺手修复本分支 roles.sql 三处潜在缺陷（VALUES 缺逗号、守卫排除表缺 video_tasks、128 注释截断残留）。

## 实施进度（worktree-capability-parity 分支）

**Wave 1（批次一）— 全部完成（2026-10-17）**

| 任务 | Commit | 摘要 |
|---|---|---|
| 环境 | e0a2770/bc70d84 | allowScripts + 一次性 PG E2E（mr-parity-pg@5433，058 门禁 11/11） |
| lint 基线收敛 | 674ff63/f1fc1fd | 41+50 处修复（noNonNullAssertion/noExplicitAny/控制字符正则/unsafe-finally 豁免）；13 个冻结字节契约文件的 format 差异记录为主仓 biome 2.5.14 升级欠账 |
| #8 dispatch seam | 953d5b6 | Claude/GeminiPreparedEvidenceTransport 适配器 + endpointRoutingRoutes 注册，18 测试 |
| #9 Redis 契约 | 305c6d8/723a01c | 滑动 TTL EVAL（sticky 语义「空闲 1h」）+ MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL fail-close 矩阵 + compose/systemd 同步 |
| #3 apicompat PhaseA | 236bae2 | responses↔CC 双向真转换（reverse-request/response/chat 三模块 2979 行）+ bridge stub 重写 + pair 注册，77 测试 |
| #2 R1 限额执法 | aa0ffc4→d0921f0 | 四 Phase：快照横切（迁移 112）→ 组 RPM fence（113）→ d/w/m 储备制 + key 5h/7d 真滚动窗口（114）→ scopes + fallback 环检测；20 个 PG 门禁 + 金样零漂移 |

**Wave 2（批次二）— 全部完成（2026-10-17）**

| 任务 | 状态 | 摘要 |
|---|---|---|
| #7 dateline | ✅ b077b5b | system prompt 日期句规范化（反文本指纹） |
| #5 粘性调度 | ✅ f9f5c16 | sessionHash 协议感知四级合并 + stickyScheduling 显式能力（默认关零变化）+ 三态门（新增 stale 降级语义）+ golden byte-identical |
| #4 P4/P16 | ✅ 601cfd1+f5c9b3d | Step2 语句削减 93→73（预算门钉死）；Step3 钱包 XACT advisory fence（freeze 审计通过、互斥域闭合、跨 fence 元组锁消除）；Step4 跳过（Step3 已消除根因） |
| #6 5h 窗口/状态机 | ✅ 91a62c8+dae3d5b | 三品类观测管线（claude 成功路径头解析/codex 首写入方/gemini attempt 聚合 worker）+ 阈值停调（复用 dormant auto_pause 列、选号惰性评估、迁移 115）+ 矩阵扩展（402 CN/403 再分类/模型级限流/401 升级/429 fallback，三层保留） |
| #7 TLS sidecar | ✅ c2325e2 | Go sidecar（utls 三 dialer + IPC 隧道 + JA3 抓包自测）+ 迁移 116 档案表 + TS connector 全链 + PG 权威 30s TTL 缓存 fail-open + compose 服务；fingerprint_mode 裁决=与 profile_id 正交并存 |
| payments 修复 | ✅ 035b504 | drill fakes 适配钱包 advisory fence |

Wave 2 终检：5051/5051 测试全绿、tsc 零错、golden 全部 byte-identical。遗留项见各任务报告（bench 复测待合流后统一、FIN057×PG18 环境问题、模型级停调调度侧消费、#5 预留带判定、探针路径档案接入）。

**Wave 3（批次三，进行中）**

| 任务 | 状态 | 摘要 |
|---|---|---|
| #12 Grok | ✅ | platform/grok-oauth（PKCE S256 base64url-32B verifier + plan=generic、loopback 粘贴 code 绑定、JWT email/sub/team_id、tier 只信 access_token）+ R4 刷新 worker `xai-grok-oauth-v1` 绑定（passthrough 保 tier/user_id/team_id；6h TTL/5min lead 钉死）+ gateway/grok 品类（CLI 身份四头仅对 cli-chat-proxy 注入、api.x.ai 不打；OAuth SSRF 硬门官方主机白名单、api-key 走运营方 host allowlist；x-ratelimit 双拼写 + reset ms/s/相对三档歧义消解；/billing?format=credits + /billing 月度 $150/$1500 探测；free 档本地 24h 95% 软门 fail-open；x-grok-conv-id 粘性头）+ 迁移 119（grok 列族 + billing jsonb + probe category 'grok'，与 117/118 累积 CHECK 协调）+ validation worker `xai-grok-api-models-v1`（api-key models 探针）+ catalog grok-registration（双产品 grok-subscription/grok-api，媒体能力边界注明批次四）+ quota-snapshot store grok 写入方/汇 + 授权镜像（validation-worker privileges + grants SQL + mirror 测试）；63 项新测试（PKCE/CLI 头矩阵/reset 表驱动/软门/SSRF 负例/绑定管线/catalog） |
| #10 Bedrock | ✅（并行） | 迁移 117 + bedrock 品类（自带签名 transport） |
| #11 Vertex | ✅（并行） | 迁移 118 + vertex-sa 品类 |
| #13 智谱/MiniMax | 进行中（并行） | 迁移 120 + cn-providers 品类 |

**待办**：批次三收尾（#13 完成后统一终检）、批次四（4.0 前置 + 计费横切 + 多模态——Grok 媒体/音频端点届时接入）、批次五（生态六线）。

**批次三终检（2026-10-17）— 全部通过**：tsc 零错误、5339/5339 测试全绿（基线 5051 → 净增 288）、PG 链 117-120 真库落库 + 角色三面探针验证、工作区干净。#13 智谱/MiniMax 最终态见 febdf17（~90 测试：adaptive 分流矩阵、quota unit 分类/百分比换算、thinking 回传表驱动、分类装饰器余额文案→20min 可恢复停调、三份镜像测试）。提交归属说明：Bedrock 文件被并行 Vertex 提交先行扫入共享 index（内容零丢失），343716b 为标记提交。遗留登记：生产装配/导入端点挂载/free 软门调度侧消费/智谱团队版 org 存储/逐账号协议读取——后续小项。

**批次四任务面板**：#14 4.0 致命前置（唯一串行）→ #15 4.1 计费横切 → #16 图片 / #17 视频音频搜索（并行）；#18 Composite ✅。

**#18 Composite 组合路由（2026-10-17）**：迁移 121（`saas_composite_model_routes` 路由注册表 + `saas_billing_groups.composite` 标记 + `saas_prepared_request_evidence.composite_route` 持久决策列，五覆盖索引 + 形状唯一约束，授权镜像三处）；纯函数三级解析器 `composite-route-resolver.ts`（Level 1 显式路由五级排序：exact>prefix、端点精确>any、更长前缀、更小 priority、更小 id；Level 2 组内账号模型归属目录，多平台歧义 fail-closed、目录不可用但可探测则降级；Level 3 前缀探测器照搬 sub2api DetectModelPlatform，目标平台对齐本仓 providerId 词汇）+ 未知模型 fail-closed；决策对象贯穿 preparation（adapter 交换 provider/product/model/endpoint 供给解析 → 调度 revalidation 复合分支（平台列匹配走既有 $5/$6 参数）→ 准入 guard 复合分支（customer/provider policy 端点与 provider 归属）→ evidence 复合列（preflight/claim 重校验）→ body.model 改写带 alias provenance（复用 payload-compiler :173 强制））；结算/用量平台归因自动跟随 candidate.providerId（normalSuccessSnapshot 既有字段，零额外改动）；管理面 CRUD + 三级 preview（`/admin/api/v1/composite-routes/*`，billing-groups-http 契约）；调度 golden 全部 byte-identical。遗留：composite 组合的供应商侧计费（provider metering policy/supplier cost 仍绑定路由的名义 provider，待商业链接入按目标平台解析）、composite fallback 链与调度侧组解析的一致性（违反组走 fail-closed）、mr-parity-pg 为 PG16（scheduling-threshold PG 门禁的 fixture 要求 15/18，环境遗留）。

**#20 OEM 白标（2026-10-17，批次五 5.2）**：迁移 126 `saas_public_brand_settings`（单行快照表 + 空快照种子行，pg_column_size ≤1MiB 界）；数据面 `src/saas/platform/brand/`——snapshot.ts 纯语法层（`saas.brand.*` 十键严格解析器：site_name/subtitle/logo/api_base_url/contact_url/doc_url/custom_menu_items≤20/custom_endpoints≤20/custom_pages≤20/frame_ancestors≤8；sanitizeBrandUrl 白名单=相对路径+http(s)+mailto(仅 contact)+data:image/*;base64(仅 image)，javascript:/vbscript:/file:/协议相对/内嵌空白全拒）、store.ts（control-plane 物化器=读 settings → 严格重组 → 版本递增 upsert；周期 worker 首周期延迟到 interval 保 startup 只读；gateway 侧 TTL 读缓存 fail-open）、http.ts（`GET /settings/public` + `/settings/public/pages/:slug` markdown 正文，免认证 /metrics 先例，405/404 语义自持）、local.ts（BYOK brand.json 同语法、坏文件 fail-closed 空快照）。SSR 注入双点：managed-saas serveMountedStatic（/console、/admin 双挂载）与 admin/server.ts serveStatic 均在 HTML 响应注入 `window.__APP_CONFIG__`（nonce script、`<`/`>`/`&`/U+2028/U+2029 全 `\u` 转义防 `</script>` 逃逸）；CSP 按快照动态派生（基线 byte-identical 兜底；logo origin→img-src、iframe 页 origin→frame-src、frame_ancestors 可配默认 'none'、注入时 script-src 'self' 'nonce-…'），web/index.html 静态 hook（nonce 占位符逐响应改写）设 title/favicon，无品牌时 CSP 拦截为 no-op。管理面复用 platform-settings 通用端点（注册即得），`saas.brand.*` 写后 afterWrite 钩子即时再物化+缓存失效。授权镜像三处（runtime-privileges + roles.sql + 126 静态测试断言）：control-plane SELECT/INSERT/UPDATE 无 DELETE、gateway 动态只读表、validation-worker 无授权；顺带修复 123 遗留 bug（roles 模板给 gateway 授 saas_image_tasks DELETE 但校验排除表未同步——模板自绊）。PG 门禁：迁移 126 落 mr-parity-pg@5433 + 角色模板重放 + 双角色探针 + 物化/读回/坏行 fail-closed 全过。测试 31 项新增（sanitize 白名单负例矩阵、XSS 转义负例、CSP 矩阵、注入字节等价、物化周期/版本递增/坏行保持、端点 404/405、hook、双注入点真 HTTP、镜像断言）+ 全量枚举注册表测试尾巴对齐。遗留：前端 CustomPageView 页面（本任务只交 API+数据面，__APP_CONFIG__/pages 端点已可用）、iframe 页 user_id/theme/lang 参数的前端拼接协议、managed 部署的品牌管理 UI（现在走 platform-settings 通用 PUT）、brand.json 的文档化。
