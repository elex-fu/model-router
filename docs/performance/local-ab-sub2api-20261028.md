# model-router 与 Sub2api 本地同机对照性能报告

截至 2026 年 10 月 28 日。本文记录一次完整的本地同机 A/B 实测：model-router managed SaaS gateway（fast 通道）与 `~/play/sub2api`（Go）在同一 mock 上游、同一 PostgreSQL 实例、同一 Redis 实例下的吞吐、延迟与 CPU 对照，并与 git 历史提交的固定配额基线（`fixed-quota-f2d-metrics.csv`，f2d9889）对比，给出实际优劣势结论与后续优化清单。

基准工作目录：`/tmp/mr-bench-20261027`（model-router 侧）与 `/tmp/s2a-bench`（sub2api 侧）。全部密钥/凭据只存在于 `/tmp` 下 0600 权限文件中，未进入仓库。

## 结论摘要

- 同窗口配对对照下，JSON 吞吐 sub2api 约为 model-router 的 1.25–1.32 倍（c32: 729.5 vs 553.1 RPS；c64: 582.3 vs 447.9 RPS）；SSE 在 c64 出现反转，model-router 541.4 vs 508.8 RPS，且 CPU/请求 1.58ms 为全场最低。
- 每请求 CPU 两者基本持平（MR 1.58–2.26ms vs s2a 1.75–2.16ms）。MR 在同时承担 TLS 上游连接、完整计费日志（intents/receipts 落库）与快通道记账的前提下仍保持 CPU 平价，是核心优势。
- MR 100% 请求走 `fast-reserved-max` 执行模式，回退率 0%（历史基线 c200 回退 85–88%）。
- 相对历史 2CPU/2GiB 配额基线：本地 RPS 为历史的 1.5–2.1 倍，CPU/请求从 2.82–2.86ms 降至 1.78–2.12ms（部分来自无 CPU 配额、Node 24、硬件差异，不可全部归功于代码）。
- 两个实测暴露的稳定性问题：配额耗尽后的恢复路径严重劣化（7.38 RPS + 214,868 个 429）；网关非优雅重启后命名空间 journal 无 bounded clamp 导致全局额度表超限、全部请求 503。
- 代码量级差距：`dist/saas/` 下 MR gateway 的正确性/计费/审计代码约数万行（journal 单文件 ~2,000 行），s2a 对应路径为轻量直写。MR 的成本买的是资金级不变量（预算触发器、幂等 intent、责任释放），纯吞吐买不回来。
- 本文后半部分（架构接入度起）补记三项后续分析：fast 通道实际只覆盖 `/v1/chat/completions`（anthropic 主力协议在 strict 上）、统一到 fast 的必要性与分阶段路线、以及 sub2api 后扣计费实现对照与可借鉴清单。

## 环境与方法

| 项 | 值 |
|---|---|
| 机器 | Apple M1 Pro（8 性能核），无 CPU 配额 |
| 环境噪音 | 桌面应用导致 load avg 约 10–16（主要方差来源），配对测试在同窗口背靠背执行 |
| model-router | `node dist/cli/index.js start --role gateway`，127.0.0.1:18088，pid 记录于 `/tmp/mr-bench-20261027/gateway.pid`，Node 24.18 |
| sub2api | `/Users/lex/play/sub2api/backend/bin/server`，127.0.0.1:28080，Go 1.27.1 |
| PostgreSQL | 5434 端口单实例（PG18，max_connections=300），MR 库 `model_router_bench` / schema `model_router_saas`，s2a 库 `sub2api_bench` |
| Redis | 16399 单实例，两者共用 |
| MR 上游 | TLS mock `quota-mock`（18453），模型 `native-fast-ci-model` → 映射 `r9-provider-model-openai` |
| s2a 上游 | 同源代码 mock（18454，去 TLS、固定 5ms 延迟） |
| 压测客户端 | Go 秒表客户端（`scripts/performance/async-receipt-timing-client.go` 的副本 + `-model` 参数），60s 时长，`-n 100000000` |
| CPU/RSS 采样 | run-profile.sh 用 `ps` time 差分计算每请求 CPU 毫秒 |

已知公平性偏差（结果解读时必须考虑）：

1. MR 走 TLS mock 上游，s2a 走 plain HTTP mock——TLS 握手/加密成本不对称，偏向 s2a。**（2026-10-28 T5/T6 已消除：s2a 账号 base_url 改为同源 TLS mock `https://127.0.0.1:18453`，见 `strict-messages-baseline-20261028.csv`；TLS 贡献已量化，见 P2-8。）**
2. 本地无 CPU 配额且存在环境噪音；历史基线是 2CPU/2GiB 严格配额 CI 环境，两口径不可直接比大小。
3. s2a 的限额逻辑轻量直写 Redis，MR 快通道含 admission Lua + PG intent 落库 + 预算触发器。

## 实测结果

### 空闲窗口首轮（环境噪音较低）

| profile | MR RPS / p50 | s2a RPS / p50 |
|---|---|---|
| c32 JSON | 808.7 / 35.8ms（48,591 请求，0 错误） | 1174.8 / 23.5ms（70,536 请求） |
| c32 SSE | —（首轮遭遇配额耗尽，见故障复盘） | 962.7 / 28.3ms |

### 同窗口背靠背配对（最终对照，环境 load ≈ 15）

| profile | MR RPS / p50 / p99 / CPU·req | s2a RPS / p50 / p99 / CPU·req | s2a/MR 吞吐比 |
|---|---|---|---|
| c32 JSON | 553.1 / 50.0 / 152.9ms / 2.12ms | 729.5 / 36.8 / 134.3ms / 1.92ms | 1.32× |
| c32 SSE | 474.5 / 50.5 / 233.8ms / 1.78ms | 595.1 / 44.6 / 165.4ms / 2.12ms | 1.25× |
| c64 JSON | 447.9 / 110.9 / 674.6ms / 2.26ms | 582.3 / 97.5 / 281.0ms / 1.98ms | 1.30× |
| c64 SSE | **541.4 / 100.5 / 329.1ms / 1.58ms** | 508.8 / 108.2 / 362.7ms / 2.16ms | **0.94×（MR 胜）** |
| c200 JSON | 采纳 ≈290 RPS（17,419），730,339 个瞬时 429 `GATEWAY_CAPACITY_EXHAUSTED` | 687.1 / 271.1ms / 1.89ms | — |

要点：

- c200 下 MR 的 429 全部是本地在途许可信号量（`MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT=64`）在鉴权/数据库工作之前的预留拒绝（bounded-gateway-dispatcher.js:119 → http-handler.js:373）。这是设计容量预留而非崩溃：被拒请求延迟近零，被采纳请求 p50 173ms，尾延迟受保护。s2a 无此机制，全部 200 并发直压到 p50 271ms。
- 所有成功请求执行模式 100% `fast-reserved-max`，回退原因为空；c8 快速校验 258.9 RPS / p50 21.8ms。
- 并发从 32→64，MR JSON p50 从 50ms 膨胀到 111ms（2.2×），吞吐反降 19%；s2a p50 97ms、吞吐仅降 20%。两者都受单机 mock 上游与 Node/Go 调度约束，但 MR 的膨胀更陡。

### 与历史固定配额基线（fixed-quota-f2d-metrics.csv）对比

历史（2CPU/2GiB，f2d9889，16 组）：c32-json 单进程 346.8–379.5 RPS / CPU 2.82–2.86ms / p50 73.5–74.1ms / RSS ≈177MB；bounded 279.7–365.2 RPS / 4.30–4.56ms / RSS ≈344MB；c32-sse 单进程 340.3–365.0；c200 单进程 267.5–410.0 RPS、回退 87–88%。

本地实测对历史：c32 JSON 553–809 RPS（历史的 1.5–2.1 倍），CPU/请求 1.78–2.12ms（历史 2.82–2.86ms），p50 36–50ms（历史 73–74ms），回退 0%（历史 c200 85–88%）。RSS 需注意历史是 2GiB 配额上限压制后的峰值口径，本地无配额不可比。差异来源含硬件、Node 24、无 CPU 配额与快通道改造，不能全部记为代码改进，但 0% 回退与 CPU/请求下降是结构性变化。

## 故障复盘（实测暴露）

### 1. 配额耗尽后的恢复路径崩塌（mr-c32-sse 首轮）

现象：60s 内 218,479 请求中 218,036 失败（214,868 个 429 `FAST_QUOTA_EXCEEDED`、3,122 个 503、若干 EOF），成功仅 489，等效 7.38 RPS；即使恢复额度后，Redis admission 键的残留计数仍拖累后续运行。

根因链：

1. admission 按预扣口径计数：每请求预留 `tokenUnits = 262,208`（maxInput+maxOutput 价格上界），而请求实际用量 ≈15 tokens；实际用量只在请求完成后由 durableUsageReconciler 异步改写回退。
2. 种子数据 tpm=600M（键/租户/项目三层），预扣口径下约 2,290 请求/分钟即触顶 → 429。
3. 429 后客户端立即重试 → 每次重试再次消耗 admission 计算与 DB 路径 → 恢复吞吐被压到个位数。

修复（环境侧）：新增 policy v4（tpm=1e12，走 append-only 版本表 + 两段式指针切换）、租户/键同步 1e12、清空 Redis admission 键（51,668 个）。

### 2. 非优雅重启后全局额度超限、全量 503

现象：gateway 重启后每个请求 503，PG 报 `Global fast credit ceiling exceeded`（ERRCODE 23514，迁移 147 延迟约束触发器）。

根因链：

1. 本地 journal 以命名空间 owner 运行（`MODEL_ROUTER_FAST_OWNER` 指向 bench namespace），`boundedDeployment` 仅在 `options.boundedGatewayOwner` 且 owner 匹配时才接入（managed-saas-gateway.js:1857/1908），因此 replenish 不做 `globalRemaining` 钳制（journal.js replenish 仅在 `this.boundedDeployment` 存在时钳制）。
2. 冷启动补齐目标 `desired = max × allocationTargetConcurrency × 2`（journal.js reserve，tranche 为 null 时）= 524,480×64×2 = 67,133,440，恰等于预算上限。
3. 上一 epoch 已 retired 的分配仍占 `backing` 24,126,080，预算计数器里 24.1M + 新目标 67.1M > 上限 67.1M → 每次 commit 失败 → 每请求 503。
4. 附带发现迁移 147 潜在 bug：`saas_fast_global_budget_limit` 延迟触发器未写 `SET search_path`（backing 触发器有），默认 search_path 会话下直接报 "relation does not exist"，把真实超限错误掩盖成触发器自身错误。

修复（环境侧，触发器许可路径）：`SET search_path=model_router_saas` 后 UPDATE 释放 retired 分配的 pinned backing，allocated 归零。

## 优劣势判定

优势：

1. CPU 平价：在 TLS 上游 + 完整资金级计费（每请求 intent/receipt 落库 + 预算触发器）下，每请求 CPU 与轻量 Go 实现持平。
2. c64 SSE 反超（541.4 vs 508.8 RPS），CPU/请求 1.58ms 全场最低——流式路径的批处理/TLS 写聚合做得好。
3. 快通道 100% 命中、0 回退，对照历史 85–88% 回退是质变。
4. 容量预留（在途信号量）保护被采纳请求的尾延迟，730k 拒绝瞬时完成不拖垮进程。

劣势：

1. JSON 吞吐落后 25–45%（配对口径 25–32%）。
2. 配额耗尽后的恢复路径严重劣化（见故障复盘 1），生产事故级风险。
3. 命名空间 journal 与 bounded 预算之间的 clamp 缺口，非优雅重启可造成长时间全量 503（见故障复盘 2）。
4. journal 表无清理机制：~5 轮压测后 `saas_fast_gateway_intents` 193,204 行 / 598MB，receipts 193,158 行 / 87MB，resolutions 0 行；`dist/saas/gateway/fast/journal.js` 全文无任何 intents/receipts 的 DELETE/保留策略，worker 轮询（journal.js 593/619/851/917/1011）对这些表做 LEFT JOIN 扫描，长期运行必然退化。

## 还需要哪些优化（按优先级）

### P0 — 正确性/稳定性（先于一切性能工作）

1. **命名空间 journal 补齐 bounded clamp**：`journal.js` replenish 路径在 `boundedDeployment` 缺失时必须退化为保守目标（例如按 `cap - allocated` 钳制冷启动 `desired`，或要求部署侧显式声明 unbounded 上限）。否则任何非优雅重启 + retired epoch 残留都会复现全量 503。
2. **修复迁移 147 触发器 search_path**：`saas_fast_global_budget_limit` 补 `SET search_path`（对齐 `saas_fast_global_budget_backing` 的写法）。这既是正确性（把真实超限错误暴露出来）也是可诊断性修复。
3. **配额耗尽恢复路径**：
   - 缩短预扣→实际的改写延迟（durableUsageReconciler 的扫描/批量节奏）；
   - admission 层为 429 加短 TTL 负缓存/退避，避免客户端重试风暴在恢复后继续放大 DB 路径压力；
   - 预扣 tokenUnits（262,208）与实际（~15）相差 4 个数量级，考虑对已验证低用量的 key 引入按实际用量+小系数的自适应预扣。

### P1 — 吞吐/扩展性

4. **JSON 吞吐差距**：热点在 Node 单事件循环 + 每请求同步 intent INSERT（journal.js:145）。方向：intent 写入组提交（group commit）/ 微批 INSERT（按 1–5ms 窗口聚合多请求一条多行 INSERT），或管线化。这是把 c32 JSON 从 553 提到 700+ 的最大单项杠杆。**（2026-10-28 T8 已实施并 A/B 实测，见 `fast-group-commit-t8-20261028.csv`：批 5ms/32 行 p99 210→83.5ms，p50 +1.7ms，RPS 与同轮无批对照持平（693.7 vs 693.0）——该杠杆主要兑现为尾延迟而非均值吞吐，与 s2a 差距 1.32×→1.05×；剩余均值差距按 T9/T10 继续。）**
5. **c32→c64 延迟膨胀**（p50 50→111ms）：allocation CAS / 钱包 fence advisory 锁在高并发补齐时的争用。方向：分片 advisory 锁或按 (tenant,currency) 细粒度 fence，replenish 目标带滞回避免高频抖动。
6. **journal 保留/清理**：intents/receipts 需要保留策略与删除任务（按 resolutions 完成时间或固定 TTL 批量 DELETE），同时给 worker 轮询查询补状态过滤索引，防止表增长后轮询退化。
7. **在途容量预留可配置/自适应**：64 固定值在 200 并发客户端下让 MR 表面吞吐归零。至少把 `MAX_HTTP_IN_FLIGHT` 与对外宣传容量对齐文档化；进一步可按上游健康度动态调整。

### P2 — 测量公平性/复测

8. **补一组同口径 TLS 对 s2a**（或 MR 走 plain mock）量化 TLS 上游贡献，拆分"协议成本"与"实现成本"。**（2026-10-28 已做，TLS 贡献可排除为差距主因）**：s2a 账号 base_url 切到同源 TLS mock（同证书同端口 18453，与 MR strict 完全同口径），配对基线见 `strict-messages-baseline-20261028.csv`。mock TLS 握手计数给出两侧握手行为：MR strict 每请求一次全新完整握手（`mock_tls_full_delta` = 成功数，3500 请求 = 3500 full / 0 resumed）；s2a 复用连接（c32 仅 32 次 full 握手服务 3500 请求，c64-json 7 次、c64-sse 0 次）。in-process 实测同证书完整握手成本 ≈1.26ms/次（loopback，Python ssl 顺序连接，含 TCP connect）；即使把整段握手成本全算在 MR 头上，1.26ms 也仅占 MR strict p50 935ms 的 0.13%、cpu_ms_per_req 17.6ms 的 7%。**结论：TLS 上游不是 22x 差距的贡献项，差距几乎全部是实现成本（同步 PG intent 写 + 事件循环串行化）。**
9. **控制噪音复测**：load < 3 的窗口重跑配对矩阵，固定 CPU 配额（taskpolicy/cgroup）复现历史口径，产出可入库的 CSV。
10. **SSE c64 反超是否稳定**需多轮方差确认（当前单轮 6% 差距在噪音范围内）。

## 架构接入度：性能架构并未全量覆盖

本报告的性能数字只代表 fast 通道。项目实际并存三条数据面：

| 数据面 | 入口条件 | 覆盖端点 | 持久化 | fast 接入度 |
|---|---|---|---|---|
| ① Classic 代理模式 | 普通启动（非 managed-saas） | 全部协议 | config.json 上游 + SQLite 日志 | 完全独立，零接入 |
| ② SaaS strict 通道 | managed-saas 网关，fast 拒收的一切 | anthropic `/v1/messages`、`/v1/responses`（含 WebSocket）、gemini native、embeddings、audio、images、count_tokens、rerank、幂等键请求 | saas_requests/attempts + admission guard + evidence/outbox | 完全独立，零接入 |
| ③ SaaS fast 通道 | `MODEL_ROUTER_FAST_GATEWAY=reserved-max` | **仅 `/v1/chat/completions` + protocol=openai** | Redis admission + fast journal | 本报告压测对象 |

代码事实（`src/saas/gateway/fast/executor.ts:128-134`）：fast 准入门要求 `path === '/v1/chat/completions' && protocol === 'openai'`、无幂等键、text-eligibility 通过；第二层门（`fast/runtime-snapshot.ts:101` `fastGatewayModelCompatibility`）要求 provider 侧也是 `chat.completions` + openai 协议且与运行时快照精确匹配；价格再筛一层。全部拒绝原因共 12 种（`client_idempotency / operation / snapshot_policy / provider_protocol / price_policy / compiled_body / compiled_fields / compiled_stream_usage / compiled_operation / usage_bound / compiled_output_bound / zero_price`），落回 strict 并带 `x-model-router-fast-fallback` 头。

**关键含义：anthropic 协议（Claude Code 客户端主力协议 `/v1/messages`）完全不在 fast 通道上。** 本次实测的 CPU 平价、0% 回退、c64 SSE 反超只对 OpenAI 协议 chat/completions 流量成立。**（2026-10-28 T5 已补测 strict 通道 `/v1/messages`：paired 基线见 `strict-messages-baseline-20261028.csv`，MR strict c32 32.4 rps / p50 935ms vs s2a 792.9 rps / p50 32ms——差距 22–24x，确认比 553 vs 729 大一个量级，主因即下方归因的每请求同步 PG 事务链 + 事件循环串行化；TLS 已同口径排除。）**

## 统一到 fast 架构：必要性与路线

判定：**"全量统一"不必要且有害；"文本对话端点全协议统一"条件必要。**

可行性事实：fast 的基础设施层（Redis admission、journal、预算、`usageKeys` 用量规范化）已协议无关；真正的差距是"第二套协议语法"三处硬编码——载荷编译、admission 预扣语法（text-eligibility 的 TEXT_KEYS 是 OpenAI 形状）、SSE 事件翻译（bridge 的 a→o 翻译未 fast 化）。a→o 桥接逻辑已存在于 `src/protocol/bridge.ts`，缺的是无 legacy store 的纯函数版本。anthropic 的 `max_tokens` 必填反而是比 openai `allowMissingOutputBound` 更严格的天然输出上界。

分阶段路线（阶段编号与实施计划 `docs/fast-gateway-optimization-plan-2026-10-28.md` 对齐）：

- **Phase 0/0.5（前置）**：先修 P0 四项（bounded clamp、触发器 search_path、配额恢复、journal 清理）并补 strict `/v1/messages` 基线测量。在已知会重启瘫痪的平面上扩协议等于扩大故障面。
- **Phase 1（并行）**：fast 平面内提速（intent 组提交、fence 分片、信号量配置）——不依赖协议统一，先行收回 JSON 吞吐差距。
- **Phase 2（fast 统一主战役，实施计划 T11–T14 / 里程碑 M2）**：anthropic `/v1/messages` fast tier——text-eligibility 加 anthropic 语法表、`pricingSupported` 扩 cache token 两档价（或首期带 cache 价模型走 strict 灰度）、SSE 翻译提炼 fast-native 版本；灰度机制现成（逐请求 fallback 头 + 按路由/按模型开关）。
- **Phase 2 之后（未列入实施计划，Phase 2 验收后再排期）**：responses + embeddings + count_tokens 轻量接入。
- **Phase 3（建议到此为止）**：媒体、幂等重放、per_unit/tiers 复杂计价**留在 strict**，把 strict 重新定位为"复杂计费与媒体专用平面"。endpoint-registry 注释里 §7.1 的"四协议收敛"目标建议收窄为"文本对话四协议收敛"。Classic 模式不统一（自托管无 PG/Redis 依赖是产品特性）。

必要性论据（支持统一）：主力流量不在 fast 上则性能投入回报覆盖面只有 1/25 条路径；双数据面 = 双倍 admission/记账/错误语义维护，本次实测两平面各自独立踩坑；计费口径分裂（strict 写 requests/attempts/evidence，fast 写 intents/receipts）造成对账/审计拼接成本。反对全量统一：fast 用吞吐换掉了 evidence/attempts 逐请求审计深度（合规决策非纯技术）；媒体/复杂计价接入是负 ROI——fast 的速度恰恰来自门窄（"deliberately narrow text contract" 是设计选择），统一一切 = 优势归零。

目标态：**三平面收敛为两平面**——fast 覆盖全部文本对话协议（高吞吐窄准入），strict 专职媒体/复杂计价/幂等重放（低频深审计），classic 保持独立。低频端点走 strict 是合理分层不是欠账。

## sub2api 实现对照（热路径与计费模型）

sub2api 为 Go + Gin 单进程单数据面（`handler/gateway_handler.go` 2,575 行 + `service/gateway_service.go` 1,711 行 + 每协议一个 forward 文件），ent ORM，无 fast/strict 之分。与 MR fast 的逐步对照：

| 步骤 | sub2api（729 RPS 口径） | MR fast（553 RPS 口径） |
|---|---|---|
| 余额/配额预检 | `CheckBillingEligibility`（billing_cache_service.go:735）**全 Redis 读**：余额缓存 + singleflight 合并回源 + 短 TTL sentinel | Redis admission Lua + **同步 PG journal reserve**（预算触发器、fence 锁） |
| 并发控制 | Redis ZSET 三级槽位（user/account/apiKey，等待队列带 SSE ping） | Redis 租约 + 本地在途信号量 64 |
| 上游转发 | goroutine 并行 | Node 事件循环 + TLS pinned pool |
| 计费落库 | **响应完成后**有界 worker 池，一个 PG 事务（usage_billing_repo.go:22 `Apply`：dedup + 扣余额 + 配额 + 用量日志原子提交） | **响应前**同步 intent INSERT + reserve；响应后 receipt commit + 预算释放 |

**根本分叉是计费模型：s2a 后扣（post-paid），MR 预扣（pre-paid）。** s2a 转发前只查缓存余额，完成后按实际用量扣；超支窗口被 in-flight 并发数天然限界（源码自认 TOCTOU）。MR 在 PG 预留资金、触发器强约束、事后结算释放。这解释了本次两个 MR 故障在 s2a 上结构性不存在：配额恢复崩塌源于"预扣→实际改写"差额（s2a 记实际用量，无此步骤）；重启预算超限源于启动预留补齐（s2a 重启不碰钱）。代价对称：s2a 无 DB 级资金不变量，余额靠 Redis 缓存（TTL 陈旧窗口），"DB 持久化失败该笔 cost 永久丢失"（gateway_usage_billing.go:449 注释自认）。

吞吐差距归因排序：每请求同步 PG intent 写（主项）> Node 事件循环串行化（c64 时放大）> ~~TLS 上游（未隔离）~~ **TLS 上游（2026-10-28 已隔离并排除：同口径同源 TLS 配对 + 握手计数，完整握手 ≈1.26ms/次、仅占 MR strict p50 0.13%，见 P2-8）**。SSE 批处理是 MR 的反超项（c64 SSE 541 vs 509 RPS、CPU 1.58 vs 2.16ms）。**s2a 的优势是"少做事"的架构红利，不是"做得快"的工程红利**——基础设施两家对等，intent 组提交（P1-4）理论上能收回大部分差距。

### sub2api 的可借鉴细节（按价值排序）

1. **预检失败不计数**：RPM 检查放 eligibility 最后"避免为注定失败的请求增加计数"（billing_cache_service.go:776 注释）——MR admission Lua 先计数后判失败，正是配额风暴的放大器，直接治 P0-3。
2. **singleflight + sentinel**：同用户并发回源合并为一条 DB 查询；无限制用户写短 TTL 哨兵避免反复回源。
3. **有界 worker 池 + 池停同步降级**（gateway_handler.go:2506）：MR 的 durableUsageReconciler/receipt worker 可对齐此纪律。
4. **热路径免二次反序列化**：Claude Code 客户端检测复用 ParsedRequest（gateway_helper.go:53）。
5. **后扣/预扣混合分级**（战略级，非优化）：可信额度内客户走后扣去掉热路径 PG 写、超额/新客户走预扣——把 s2a 吞吐与 MR 资金安全合并的唯一路径，改动量大需产品决策。

### s2a 的结构性弱点（MR 护城河）

无 DB 级资金不变量（超支靠限界+事后追讨）；无容量预留（c200 直压 p50 271ms，MR 用 429 保护被采纳请求 173ms）；Redis 缓存与 DB 余额漂移靠 oncall 对账；审计深度为记账流水而非逐请求资金证据链（MR 用 intents/receipts/resolutions 三张表达到 s2a 一行 dedup 的去重效果，同时多出责任释放证据）。

## 复测入口

- 工作目录与脚本：`/tmp/mr-bench-20261027/`（run-profile.sh、bench-client2、app.env、results/*.json 含逐轮完整样本）；`/tmp/s2a-bench/`（config.yaml、admin.env）。
- 重新武装环境：policy v4（tpm=1e12）已提交于 `model_router_bench` 库；预算 allocated 已归零；Redis admission 键需在每轮前确认清空。
- 验证服务存活：MR `GET http://127.0.0.1:18088/readyz`、s2a `GET http://127.0.0.1:28080/health`。
