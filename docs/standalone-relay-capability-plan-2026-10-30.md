# 独立中转站能力补齐实施计划（classic 模式卖相与运营面）

日期：2026-10-30。状态：设计稿（未开工）。
依据：与 sub2api（`~/play/sub2api`）、new-api（`~/play/new-api`）的能力对比结论（对话记录 2026-10-30）+ 本仓库代码事实核查。本文件把对比得出的 P0/P1/P2 缺口转化为可执行任务：每个任务给出问题证据、改动锚点、实现要点、验收标准、预估量级与依赖。

## 事实基线（2026-10-30 代码核查，纠正对比分析中的三处低估）

对比分析曾把以下三项判为缺口，实际 classic 已具备，任务列表中**不再重复建设**，只补文档与验收：

1. **Gemini native 客户端协议已接线**：`clientProtocolFromPath`（`src/server/proxy.ts:224`）已路由 `/v1beta/*` → gemini 协议；桥接矩阵齐备——`src/protocol/gemini.ts`（a↔g）、`openai-gemini.ts`（o↔g）、`responses-gemini.ts`（responses↔g）、`bridge.ts:77`（g↔g passthrough）；上游鉴权支持 `authMode: 'google'`（proxy.ts:2088）。缺的是 README 特性清单未收录、无集成测试验收矩阵（见 C0）。
2. **key 级模型/上游白名单已实现**：`ProxyKey.allowedModels`（glob 匹配，`src/router/upstream.ts:70-72`）+ `allowedUpstreams`/`allowedUpstreamIds`（proxy.ts:411-413）已生效。P1-6 收窄为"key 级 IP 限制"单项（见 O3）。
3. **调度已有 priority/sortIndex/failoverQueue**（`src/config/types.ts:69-84`），价格 schema 已含 cache 5m/1h 档价字段（`src/admin/pricing.ts:18-21`）。P1-5 收窄为"同优先级权重 + 自动禁用 + 会话粘性"三项（见 O2）；P1-4 收窄为"远程价格导入"单项（见 O1）。

classic 当前实际客户端面：`/v1/messages`、`/v1/chat/completions`、`/v1/responses(+/compact)`、`/v1/embeddings`、`/v1/models`、`/v1beta/*`、`/healthz`。真实缺口：`/v1/audio/*`、`/v1/images/*`、`/v1/rerank`、`/v1/completions`、`/v1/messages/count_tokens`、厂商适配（Bedrock/Vertex）、运营面四项。

## 目标

1. classic 模式（零外部依赖形态）的客户端协议面与端点广度达到竞品对等：audio、images、rerank、completions、count_tokens 全部可用。
2. 上游侧覆盖 5–8 个主流厂商适配（Bedrock SigV4、Vertex SA、OpenRouter/Groq/硅基流动预设），不再只有"裸 base_url + key"。
3. 运营面补齐：价格远程导入、调度深化（权重/自动禁用/粘性）、key 级 IP 限制、Prometheus `/metrics`——最后一项做成竞品没有做好的差异化。
4. 全程有基线、有验收、可回滚；不动 SaaS 双平面既有路线（fast-gateway-optimization-plan 的 T9/T10/Phase 2 照旧并行）。

## 总原则

- **提炼而非复制**：SaaS strict 已实现的 audio/images/bedrock/vertex 一律提炼为无 PG/Redis 依赖的模块（同 T13 对 bridge 的处理思路），classic 与 SaaS 共用同一份实现，SaaS 侧后续迁移到提炼版。
- **下沉优先级排序**：同步端点（rerank/completions/count_tokens/audio speech+transcriptions/images 同步生成）先行，异步任务（images async/batches）二期——异步任务需要 classic 侧任务存储，引入 SQLite 新表属于结构改动。
- classic 保持零外部依赖（SQLite + JSON config）；不引入 PG/Redis 依赖项。
- 新增 `UpstreamConfig`/`ProxyKey`/`ServerConfig` 字段一律 optional + 向后兼容，走既有 V2 配置迁移机制。
- 不做：SaaS 模式改动、Classic 计费/用户体系（classic 定位不变，商业化走 SaaS 平面）、语言/框架迁移、new-api 式 64 渠道铺量。

## 实施状态

- **C0 完成（2026-10-30）**：Gemini 验收矩阵 `tests/integration/gemini-bridge.test.ts` 17/17（四向桥接 JSON+SSE、google 鉴权、错误包络、鉴权拒绝、未知模型 404）；README 特性清单补 Gemini native、key 白名单、priority/failoverQueue。过程中发现并修复 5 个 classic 入站接线缺陷（此前"已接线"仅对把 model/stream 写进 body 的非标准客户端成立）：(1) model 从未从 `/v1beta` URL 提取——标准 Gemini SDK/CLI 直接 404；(2) 流式意图从未从 `:streamGenerateContent` URL 识别；(3) gemini 上游 URL 永远走 `chat/completions` 预设路径（`rewriteUrlPath` 是死代码），真实 Google 端点必 404——现按 resolvedModel 构造 `v1beta/models/{model}:{action}`；(4) gemini 入口桥的内部状态（目标 model/stream）依赖 `rewriteUrlPath` 初始化，classic 从不调用——现统一初始化；(5) `UnsupportedBridgeFeatureError` 逃逸为 503 而非 422。附带：g→responses 桥（`GeminiToResponsesBridge`）此前被候选过滤死代码化，现已放行并测试覆盖。
- **C1 完成（2026-10-30）**：轻端点四件套——`/v1/rerank`、`/v1/completions`、`/v1/messages/count_tokens`（anthropic 上游透传）、`/v1/audio/speech|transcriptions|translations`（speech 二进制逐字节回传；transcriptions/translations multipart 不透明转发 + 路由用 multipart model 字段扫描 `src/server/multipart.ts`）。同族 fail-closed 422 语义与 embeddings 一致。集成测试 11/11 + multipart 单测 6/6。
- **C2 同步完成（2026-10-30）**：`/v1/images/generations` JSON 透传 + 同族门（测试在 media-endpoints 套件内）。C2b 异步任务（SQLite 任务表）未实施，按计划独立排期。图片按张计价暂不入账（classic 价格 schema 为 token 口径）。
- **C3 模块完成 + 预设族接线（2026-10-30）**：`src/server/providers/` 交付 Vertex SA token（JWT 签发 + 单飞缓存）、Bedrock SigV4 + eventstream 解码（分帧边界、CRC 校验）、OpenRouter/Groq/硅基流动预设，单测 48/48 含 AWS 官方向量已知答案测试。接线完成度：预设族已进 `PROVIDER_PROFILES` + `upstream:add` baseUrl 省略回退（`-` → 规范地址，CLI 测试覆盖）；**Vertex/Bedrock 的 classic dispatch 接线为后续任务**（需要 config schema 增加 SA/AWS 凭证字段 + 异步鉴权钩子 + eventstream 响应解码接线，模块已就绪）。
- **O1 完成（2026-10-30）**：`src/admin/pricing-import.ts`（models.dev 形状 + 本地 schema 形状，逐行校验/失败行报告/dry-run，存储复用 admin 控制台同一路径）+ `model-router pricing:import <file|url>`（https-only、10MB 上限、离线写锁与在线拒绝语义与其它 V2 CLI 一致）。测试 15/15。
- **O2 完成（2026-10-30）**：`weight`（同 priority 加权随机，全默认 1 时确定性 sortIndex 序不变；failoverQueue 时禁用）+ 会话粘性 `SessionAffinityStore`（key+model 粒度，LRU 4096 + TTL 10min 默认，失败漂移即清映射，进程内重启即清）+ `server.sessionAffinity` 配置。自动禁用的可观测部分由 O4 `upstream_circuit_state` 覆盖；admin 上游页"持续开路"显著标注留后续（需控制面改动）。单测 5/5 + 粘性集成 3/3（含漂移与控制组）。
- **O3 完成（2026-10-30）**：`ProxyKey.ipAllowlist/ipDenylist`（CIDR v4/v6，deny 优先，非法条目忽略不锁死，BlockList WeakMap 缓存）+ 鉴权后 403 执行（`src/server/key-ip-policy.ts`）。单测 7/7 + 集成 6/6（含 X-Forwarded-For 伪造不绕过、401 优先于 403）。
- **O4 完成（2026-10-30）**：`src/server/metrics.ts`（计数器/直方图/仪表，标签消毒 + 基数上限折叠，Prometheus 0.0.4 文本渲染，零依赖）+ `/metrics` 端点（默认 404，`server.metricsEnabled` 开启，可选 bearer token）+ 埋点（请求/时延/token 挂在既有完成路径与日志管道，熔断状态 scrape 时采样自 breaker snapshot）。模块单测 12/12 + 端点集成 3/3（含 in-flight 归零回归——首版 admission 点放错导致早拒绝路径 -1，已修）。
- 健康检查（2026-10-30）：`npx tsc --noEmit` 干净；新增测试合计 **11+6+17+15+48+8+13+12+3+3+6 = 142 项**（agents + 主线）；全量套件结果见提交说明。lint：改动文件 biome 干净（存量噪声与 HEAD 一致）。

## Phase 0：卖相修正与验收基线（半天）

### C0 文档对齐 + Gemini 验收矩阵

- **问题**：Gemini native 已在代码中但 README 特性清单（`README.md:43-61`）未收录、无 `/v1beta` 集成测试，"有但没人知道 + 没人保证不退化"。对比分析本人也被 README 误导判为缺口。
- **锚点**：`tests/integration/proxy.test.ts`（新增 gemini 用例组）；`README.md` 特性段。
- **实现要点**：(a) 集成测试补四向桥接（g 入口 × anthropic/openai/gemini 上游，JSON+SSE）；(b) README 特性清单补 Gemini native 与既有 key 白名单/priority 能力；(c) `/v1/models` 在 gemini key 场景的返回形状对齐 Gemini CLI 期望。
- **验收**：gemini 桥接集成测试进 `npm test`；README 与代码能力一致。
- **量级**：0.5 天。**依赖**：无。

## Phase 1：P0 端点广度与厂商适配（1.5–2.5 周）

### C1 轻端点四件套（rerank / completions / count_tokens / audio）

- **问题**：四个端点 classic 全缺。竞品均有。前三个是纯透传/转发形状，audio 需 multipart。
- **锚点**：`clientProtocolFromPath`（proxy.ts:216）、`trySingleUpstream` 端点推断（proxy.ts:1965 一带 `profile.endpoint`）、`src/server/index.ts` 路由注册。
- **实现要点**：
  - `/v1/rerank`：对齐 embeddings 模式——openai 协议族上游透传（R2 注释先例，proxy.ts:222-223）；非 openai 上游 422 `unsupported_capability`。SaaS 侧 rerank 当前也只是 registered-not-assembled（endpoint-registry.ts:123-128），classic 先行透传不欠账。
  - `/v1/completions`：openai 上游透传，`endpoint: 'completions'`。
  - `/v1/messages/count_tokens`：anthropic 上游透传；跨协议（anthropic 入口 + openai 上游）复用 SaaS `src/saas/gateway/count-tokens.ts` 的估算逻辑提炼版，首期可只做同协议透传 + 跨协议返回估算值。
  - `/v1/audio/speech|transcriptions|translations`：speech 为 JSON→二进制响应转发；transcriptions/translations 为 multipart 上传——multipart 解析参照 SaaS `http-handler.ts:116`（`MULTIPART_NORMALIZING_ENDPOINT_PATHS`）的做法提炼，注意 `max-body-size` 对 multipart 的口径。
- **验收**：`tests/integration/proxy.test.ts` 每端点至少：同协议透传 200、跨协议 422/桥接、SSE（不适用者除外）、`/v1/models` 不受影响；真实 mock 上游覆盖（startMockUpstream 扩展 multipart 支持）。
- **量级**：2–4 天。**依赖**：C0。

### C2 images 端点（同步先行，异步二期）

- **问题**：`/v1/images/generations`（同步）classic 缺；`edits`/`batches`/async 任务体系 SaaS 有（`src/saas/gateway/images/` 全套）但依赖 PG task store。
- **锚点**：提炼 `src/saas/gateway/images/image-bytes.ts`、`media-usage-plan.ts`（用量计价口径）；classic 侧新增 `src/protocol/images.ts`。
- **实现要点**：(a) 首期只做 `POST /v1/images/generations` 同步 JSON 请求 → openai 上游透传 + 响应 base64/url 透传，usage 按张计价走既有 pricing；(b) `edits`（multipart）随 C1 的 multipart 基建顺带；(c) async/batches 留 C2b：classic 用 SQLite 新表 `image_tasks` + 既有 24h 轮询任务模式（日志清理先例）驱动，**单独排期**，不阻塞 C2 验收。
- **验收**：同步 generations 同协议 200 + 计费入账（logs.sqlite 记录张数）；`/v1/models` 不误报图片能力（模型能力声明不冒充，README 既有边界原则）。
- **量级**：C2 同步 2 天；C2b 异步 3–5 天（独立排期）。**依赖**：C1（multipart 基建）。

### C3 厂商适配层（Bedrock / Vertex / 预设族）

- **问题**：classic 只有裸 base_url + key（bearer/x-api-key/custom-header/google）。Bedrock 需 SigV4 签名 + eventstream 响应解码；Vertex 需 service account OAuth；OpenRouter/Groq/硅基流动只需请求头/路径/计价口径预设。
- **锚点**：SaaS 已有完整实现可提炼——`src/saas/gateway/bedrock/{sigv4.ts,eventstream.ts,transport.ts,response-bridge.ts,transform.ts}`、`src/saas/platform/vertex-sa/{token-service.ts,service-account.ts}`。
- **实现要点**：
  - 新增 `src/server/providers/` 目录：每厂商一个 transport profile（URL/路径预设、鉴权签名、响应解码、必要时的协议变换）；classic `UpstreamConfig.provider` 取预设名即激活（provider 字段已存在，types.ts:36）。
  - **Bedrock**：提炼 sigv4 + eventstream 解码为无 PG 依赖模块；anthropic 上游走 bedrock invoke 桥（SaaS response-bridge.ts 为蓝本）。eventstream 解码是最大单项。
  - **Vertex**：SA JSON → OAuth token（token-service 提炼）+ gemini 上游 `:generateContent` 路径预设；token 缓存复用既有 oauth.ts 模式。
  - **OpenRouter/Groq/硅基流动/DeepSeek 官方**：纯预设（路径、默认鉴权头、`provider` 兜底模型列表），各 ≤0.5 天。
- **验收**：每适配器一套集成测试（mock 上游带签名校验/流式帧解码）；Bedrock eventstream 帧序列（data frames、usage 事件）解码单测对齐 SaaS 现有测试矩阵；真实凭证冒烟沿用 `test:live:*` 模式（显式触发，不进 `npm test`）。
- **量级**：Bedrock 3–4 天、Vertex 2 天、预设族 2 天。**依赖**：C0；与 C1/C2 并行。

## Phase 2：P1 运营面（1–1.5 周，可与 Phase 1 后半并行）

### O1 模型价格表远程导入

- **问题**：价格逐模型手配（admin pricing schema 已含 cache 档字段，`src/admin/pricing.ts`），运维成本高；new-api 支持从 models.dev 等远程同步。
- **锚点**：`src/admin/pricing.ts`（schema 复用，不新增字段）、admin 维护任务体系（`src/admin/maintenance.ts`）。
- **实现要点**：(a) 导入源三选：URL（models.dev `api.json` 形状）、本地 JSON 文件、粘贴 JSON；(b) 映射层：上游源价格 → 本地 pricing schema（input/output/cache 档、currency 换算固定汇率配置或按 currency 原样入）；(c) 导入为 pricing profile 批量 upsert，逐条校验、失败行报告、不整批回滚；(d) CLI `model-router pricing:import <file|url>` + admin UI "导入"入口；(e) 不做自动定时同步（观察项：维护任务体系可后续挂定时）。
- **验收**：导入 100+ 模型价格后 cost estimate 立即生效；导入报告（成功/失败/跳过计数）入库；secret 扫描流程不受影响。
- **量级**：2–3 天。**依赖**：无。

### O2 调度深化（权重 / 自动禁用 / 会话粘性）

- **问题**：同 priority 内只有 sortIndex 稳定序，无权重；渠道持续失败只熔断不复盘（熔断 HalfOpen 会自动回探，但管理员无感知）；长对话跨 upstream 漂移破坏上游缓存命中（Claude Code 体验敏感）。
- **锚点**：`src/config/types.ts:69-84`（priority/sortIndex/failoverQueue）、`src/router/upstream.ts`（选择逻辑）、`src/server/circuitBreaker.ts`。
- **实现要点**：
  - `weight?: number`（默认 1）：同 priority 内加权随机，sortIndex 退化为 tie-break；failoverQueue 与 weight 互斥沿用现有优先级语义。
  - **自动禁用 + 通知**：circuit breaker Open 持续超过阈值（如 3 次熔断/10 分钟）→ upstream 标记 `autoDisabledAt`，admin console 上游页显著标注 + 写入请求日志旁的 ops 事件表（SQLite）；HalfOpen 探活成功自动解除。不做邮件/webhook（classic 无通知基建，观察项）。
  - **会话粘性**：可选 `sessionAffinity?: { enabled: boolean; ttlMinutes: number }`（upstream 或 server 级）；粘性键 = proxy key + 模型（无会话 ID 可用时），命中且目标健康 → 直选；失败降级正常调度并失效映射；内存 LRU + TTL，重启即清（语义：尽力粘性，非保证）。
- **验收**：加权分布单测（±5% 统计偏差）；自动禁用注入测试（连续失败 → 禁用 → 探活恢复）；粘性集成测试（同 key 连续请求命中同 upstream、故障后漂移）；p50 回归（粘性哈希查询在热路径开销 < 0.1ms）。
- **量级**：3–4 天。**依赖**：无。

### O3 key 级 IP 限制

- **问题**：ProxyKey 已有模型/上游白名单与限流，缺 IP 段控制（new-api/s2a 的 token 级均有）。
- **锚点**：`src/config/types.ts` ProxyKey（新增 `ipAllowlist?: string[]`、`ipDenylist?: string[]`，CIDR）、`src/server/proxy.ts` 鉴权段（IP blocker 之后、proxy key 认证处）。
- **实现要点**：CIDR 匹配复用 trustedProxyCidrs 的解析工具；deny 优先于 allow；命中拒绝按客户端协议返回 403；`--trust-proxy`/trustedProxyCidrs 语义下取真实 IP（复用 getClientIp）。
- **验收**：allow/deny/默认放行三态集成测试 + 代理头伪造场景（不受信任代理时用 socket 地址）。
- **量级**：0.5–1 天。**依赖**：无。

### O4 Prometheus `/metrics` 导出（差异化项）

- **问题**：两家竞品都没做好（new-api 有内部 perf metrics 无标准暴露；s2a 无）——反超点：标准 Prometheus 文本协议，Grafana/反代监控零成本接入。
- **锚点**：`src/server/proxy.ts` 热路径计数（现有 logger 异步管道旁路，参照 ipBlocker 的进程内聚合模式）；`clientProtocolFromPath` 旁新增 `/metrics` 早返回（`/healthz` 先例，proxy.ts:505 之前）。
- **实现要点**：
  - 指标集（首期）：`model_router_requests_total{proto,upstream,status}`、`model_router_request_duration_ms`（histogram，bucket 适配 10ms–10s）、`model_router_tokens_total{direction,upstream}`、`model_router_upstream_circuit_state{upstream}`（0/1/2）、`model_router_in_flight`（gauge）、进程 RSS。
  - 实现：进程内聚合器 + 定时快照到文本格式（热路径只做原子累加，无锁设计）；`server.metricsEnabled`（默认 false）+ 可选 `metricsAuthToken`（无 token 时仅回环绑定可访问）。
  - 与 V2 在线配置联动：metricsEnabled 热更新（restartRequiredFields 语义评估）。
- **验收**：Prometheus 文本格式 lint 通过（`promtool check metrics`）；压测下热路径开销 < 1% CPU（对照无 metrics 基线）；e2e 抓取一次全指标非空。
- **量级**：2–3 天。**依赖**：无。

## Phase 3：P2 决策门（不排期，先立判据）

### D1 订阅账号池化（s2a 立身之本）

- **判据**：产品方向若确立"订阅转配额"市场（Claude Pro/Max、Codex、Gemini 订阅池化）才立项。工程构成：上游 OAuth token 刷新子系统（SaaS 已有 codex OAuth 与账号授权页部分基建可评估）、订阅窗口配额（5h/周/月）、账号粘性（与 O2 粘性同机制扩展）、每账号 TLS 指纹（重投入项）。量级：季度级。
- **不做判据**：若定位保持"API key 聚合 + 协议桥接"，本项永久搁置——s2a 在此赛道有先发纵深，正面复刻 ROI 为负。

### D2 多实例水平扩展

- **判据**：单实例吞吐（当前 fast 平面 ~700–900 RPS / classic 未压测）触及自托管规模上限才立项。方向：状态外移（config 已有 CAS 语义、日志已有 SQLite）最小可行 = 只读副本 + 共享配置存储；完整多节点对齐 new-api 的 Redis 共享模式。
- **前置**：classic 模式性能基线补测（当前只有 SaaS fast/strict 数字，classic 从未单独压测——这本身是个欠账，建议随 C0 一起补 c32 快速档）。

### D3 N×N 桥接收尾

- **现状**：gemini 四向已齐（g↔a/o/responses/g），实际缺的是 new-api RelayKit 式的**转换损耗分级**（safe/strict/allow 策略 + 每路径质量标注），而非桥接本身。
- **判据**：Phase 2（fast-gateway-optimization T11–T14）落地后评估——T13（fast-native SSE 翻译）产出的纯函数翻译层正好是损耗分级的载体，届时叠加策略标注即可，量级 1 周。**提前做会与 T13 重复劳动。**

## 里程碑与依赖

```
M0（卖相修正）  C0 ──┬→ C1 轻端点四件套 ──→ C2 images（C2b 异步独立排期）
                      └→ C3 厂商适配（并行）
M1（运营面）    O1 O3（随时可插） O2 O4（与 Phase 1 后半并行）
M2（决策门）    D1 D2 D3 —— 依产品方向与 Phase 2 落地情况触发，不预先排期
```

与 fast-gateway-optimization-plan-2026-10-28 的关系：正交并行。本计划只动 classic 数据面与 admin 运营面；SaaS fast/strict 的 T9/T10/T11–T14 不受影响。唯一交点：C1/C2 的端点提炼模块将来可被 SaaS strict 复用（提炼方向是 SaaS → classic，回流是收益不是依赖）。

## 风险与回滚

- 所有端点新增走"协议族门 + `unsupported_capability` 422"既有语义，未知上游协议绝不冒充（README 验证边界原则不变）。
- multipart 引入注意内存安全：`max-body-size` 对 multipart 的整体限额必须显式（含文件部分），拒绝未声明大 body——这是新增攻击面，安全测试先行。
- Bedrock eventstream 解码复杂度高：若 C3-bedrock 超期，先交付 Vertex + 预设族，Bedrock 单独跟进不阻塞 Phase 1 验收。
- 调度深化（O2）改变选路行为：默认值保持现行为（weight=1 退化为现有稳定序、粘性默认关、自动禁用阈值保守），全部 opt-in。
- 每任务完成后照例全套健康检查（tsc / npm test / lint / deadcode），文档随代码更新（本计划吸取 C0 的教训：能力进了代码不进文档等于不存在）。
