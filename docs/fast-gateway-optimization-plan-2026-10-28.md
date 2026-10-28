# fast 通道加固与统一实施计划

日期：2026-10-28。状态：实施中（Phase 0 完成，Phase 0.5 未启动）。
依据文档：`docs/performance/local-ab-sub2api-20261028.md`（本地 A/B 实测、故障复盘、架构接入度与 sub2api 对照）。本文件把该报告的结论转化为可执行任务：每个任务给出问题证据、改动锚点、实现要点、验收标准、预估量级与依赖。

## 目标

1. fast 平面达到"可信赖生产平面"标准：重启无全量 503、配额风暴可恢复、表不无限增长。
2. 主力协议（anthropic `/v1/messages`）吃到 fast 的性能机制，对齐 sub2api 吞吐 ±10%。
3. OpenAI 协议 JSON 吞吐差距（当前 553 vs 729 RPS）收敛到 10% 以内。
4. 全程有基线、有验收、可回滚。

## 总原则

- 顺序不可颠倒：P0 修复 → 基线补测 → fast 提速/anthropic 统一并行 → 计费模型决策放最后。
- 不做：媒体/复杂计价/幂等重放接入 fast（strict 专职平面）、Classic 模式改动、语言/框架迁移。
- 已应用的迁移不改历史文件，一律新增后续迁移。

## 实施状态

- **T1 完成（2026-10-28）**：命名空间 journal replenish 冷启动目标按 `readGlobalCreditBudgetRemaining` 钳制（`src/saas/gateway/fast/bounded-deployment-budget.ts`），预算行缺失或读失败时退化为小步补齐；bounded 路径行为不变。
- **T2 完成（2026-10-28）**：迁移 148 `bounded_fast_gateway_budget_limit_search_path` 以 `CREATE OR REPLACE FUNCTION` + `SET search_path TO pg_catalog, model_router_saas, pg_temp` 修复延迟上限触发器；147 文件未动。
- **T3 完成（2026-10-28）**：说明——check-then-increment 计数顺序此前已存在，本次交付的是恢复面：(a) rpm/tpm 拒绝在 Lua 内打 1s 共享负缓存键（identity 含 tokenUnits），重复拒绝短路不走全键扫描；(b) concurrency 拒绝返回 soonest-expiry `retryAfterMs` 提示（不落缓存）；(c) denial 经 `FastGatewayExecutionError` 映射 429 + `Retry-After` 头（quarantine 503 的 readyAt 提示保留）。风暴恢复吞吐与 Redis QPS 验收需 T5/T7 基准工具就位后补实测数字。
- **T4 完成（2026-10-28）**：迁移 149 `fast_gateway_retention`（原 UPDATE OR DELETE 不可变触发器收窄为 BEFORE UPDATE + GUC 门控 DELETE 守卫 `model_router_saas.fast_retention`）+ `saas_fast_gateway_intents_tenant_time` / `_created_at` 索引；保留任务 `runFastJournalRetention`（仅终结已结算意图，批事务 + SKIP LOCKED，子表先于 intents 删除）；billing worker 新增 `--retention-days`（once 模式 drain 后执行；poll 模式 unref 定时 + 重入保护）。体积回收 ≥90% 与轮询 <10ms 验收需 193k 行种子库实测，随 T7 固化脚本补做。
- 健康检查：`npx tsc --noEmit` 干净；`npm run test:unit` 7643 通过 / 0 失败（含 T3/T4 新增 149 迁移测试、retention 单测、drain-worker retention 覆盖、Lua identity 重锚）。lint/deadcode 存量噪声与 HEAD 一致（本次未新增）；shellcheck 本机未安装跳过。

## Phase 0：P0 加固（立即）

### T1 journal 冷启动目标钳制

- **问题**：命名空间 owner（无 `boundedDeployment`）的 replenish 不做 `globalRemaining` 钳制，冷启动 `desired = max × concurrency × 2` 恰等于预算上限；叠加 retired epoch 残留 backing 即触发迁移 147 延迟约束 → 每请求 503（实测复现，报告故障复盘 2）。
- **锚点**：`src/saas/gateway/fast/journal.ts` replenish 路径（reserve 的冷启动目标计算处）。
- **实现要点**：无 `boundedDeployment` 时改为保守目标——冷启动 `desired` 钳制为 `cap - allocated`（读预算表一次，失败则退化为小步补齐，例如 `tranche ?? min(desired, 默认小步长)`）；保留 bounded 路径现行为。`allocationStripes` 已存在（`MODEL_ROUTER_FAST_CREDIT_STRIPES`），评估直接复用。
- **验收**：注入 retired epoch backing 残留 + 重启 journal 的集成测试，全量请求 200，预算 allocated 单调不超 cap。
- **量级**：0.5–1 天 + 测试。**依赖**：无。

### T2 迁移 147 触发器 search_path 修复

- **问题**：`saas_fast_global_budget_limit()` 未写 `SET search_path`（backing 触发器有，见 `src/saas/db/migrations/147_bounded_fast_gateway_budget.ts:97` vs `:117`），默认 search_path 会话下报 "relation does not exist"，掩盖真实超限错误（实测复现）。
- **锚点**：新增迁移（如 `148_...`），`CREATE OR REPLACE FUNCTION` 带与 147:97 相同的 `SET search_path TO pg_catalog, model_router_saas, pg_temp`；**不修改已应用的 147 文件**。
- **验收**：迁移测试在默认 search_path 会话注入超限 commit，错误信息为 "Global fast credit ceiling exceeded"（ERCODE 23514）而非 relation 缺失。
- **量级**：0.5 天。**依赖**：无。

### T3 admission 计数顺序与 429 负缓存

- **问题**：admission Lua 先计数后判失败，配额耗尽后客户端重试风暴持续放大 Redis/DB 路径，恢复期吞吐 7.38 RPS（实测，报告故障复盘 1）。sub2api 对照：RPM 检查放预检最后"避免为注定失败的请求增加计数"。
- **锚点**：`src/saas/gateway/fast/redis-admission.ts` Lua 脚本（限额检查段）。
- **实现要点**：(a) check-then-increment（已存在，保持不变）；(b) 429 响应带 `Retry-After`（concurrency 拒绝给 soonest-expiry 提示）；(c) admission 层加 1s 负缓存键（identity 含 tokenUnits），rpm/tpm 重复拒绝直接短路不再走完整 Lua 键扫描。
- **验收**：配额风暴注入测试（压满 tpm → 持续打请求 → 释放额度）：恢复期 60s 内吞吐恢复到正常窗口的 50% 以上；风暴期间 Redis QPS 不随重试速率线性放大。
- **量级**：1–2 天。**依赖**：无。

### T4 journal 保留策略与轮询索引

- **问题**：intents/receipts 无任何 DELETE/保留逻辑（`src/saas/gateway/fast/journal.ts` 全文无清理；实测 ~5 轮压测后 193,204 行/598MB）；worker 轮询（journal.ts 593/619/851/917/1011 的 intents LEFT JOIN receipts/jobs/resolutions）随表增长退化。
- **实现要点**：(a) 新增保留任务（复用 billing worker 进程或独立 CLI role）：按 `resolutions 完成时间 or created_at` TTL 批量 `DELETE ... WHERE id IN (SELECT ... LIMIT N)` 循环，避免长事务；(b) resolutions 幂等约束保证已结算意图可安全删除；(c) 轮询查询补状态过滤索引（intents 按 `tenant_id, created_at` 与未关联 receipt 的部分索引）；(d) 轮询 SQL 加 `WHERE` 限定活跃窗口。
- **验收**：193k 行种子库上保留任务跑完后表体积回收 ≥90%，worker 轮询单次耗时 < 10ms；对账查询（receipts+resolutions join）在保留后仍可重建任意 24h 内账目。
- **量级**：2–3 天。**依赖**：T2（触发器先修，避免清理路径撞 search_path 坑）。

## Phase 0.5：补测量基线（与 Phase 0 并行，半天–1 天）

### T5 strict 通道 /v1/messages 基线

- **问题**：主力协议从未被压测，统一收益无法度量。
- **实现要点**：gateway 以不设 `MODEL_ROUTER_FAST_GATEWAY` 的配置启动（strict 全量）；压 `/v1/messages`（anthropic 协议 mock 同源）；同窗口配对 s2a `/v1/messages`。结果追加进 `fixed-quota` 系 CSV 或新 CSV，入库 `docs/performance/`。
- **验收**：产出 c32/c64 JSON+SSE 四组 strict 基线数字。
- **T5 完成（2026-10-28）**：四组配对基线入库 `docs/performance/strict-messages-baseline-20261028.csv`（MR strict 与 s2a 同源 TLS mock `https://127.0.0.1:18453`，profile 间 purge+restart 保证容量清零）。MR strict c32：JSON 32.4 rps / p50 935ms / cpu 17.6ms/req，SSE 34.6 rps / p50 862ms / cpu 17.1ms/req；s2a c32：JSON 792.9 rps / p50 32ms / cpu 2.1ms/req，SSE 677.1 rps / p50 35ms / cpu 2.2ms/req。c64 MR 两组均为准入上限 64 槽打满（每组仅 64 成功、5936 个 429，p50 2.7–3.7s 为排干波延迟），s2a c64：JSON 670.4 rps、SSE 637.6 rps / p50 ~86ms。strict/s2a 吞吐差 ~22–24x，与既有 `/v1/chat/completions` 差距同量级；首跑 mr-c32-msg-json 因残余 unknown-outcome 容量出现 1152 个 429，purge 后重跑干净（3500/3500），原脏数据已剔除。

### T6 TLS 贡献隔离

- **实现要点**：MR fast 走 plain-HTTP mock（`/tmp/mr-bench-20261027/mock-plain-http` 同源代码）重跑 c32 JSON 一轮，与 TLS 轮差分。
- **验收**：TLS 成本贡献有了单独数字，JSON 差距归因表（报告第七节）更新。
- **T6 完成（2026-10-28）**：未走"MR plain-HTTP 重跑"原方案（strict 通道上游有 HTTPS-only 端点策略 `provider-http-transport.ts:753`，plain-HTTP 不合法），改用报告 item 8 的备选"同口径 TLS 对 s2a"——s2a 账号 base_url 切同源 TLS mock 后与 MR strict 完全同口径。量化结论：MR strict 每请求一次完整 TLS 握手（3500 请求 = 3500 full / 0 resumed），s2a 连接复用（c32 32 次 full 服务 3500 请求）；同证书完整握手实测 ≈1.26ms/次（loopback in-process），全算在 MR 头上也仅占 p50 935ms 的 0.13% / cpu 17.6ms 的 7%——**TLS 排除为 22x 差距的贡献项**。报告已更新：公平性偏差 #1 标注消除、P2-8 补齐测量数据、归因排序中"TLS 上游（未隔离）"改为已隔离排除。

### T7 基准工具固化

- **问题**：本轮基准脚本全在 `/tmp`（易失），无法回归。
- **实现要点**：把 seed-driver、run-profile、mock 上游（quota-mock/mock-plain）整理进 `scripts/performance/`（无密钥，凭据走环境注入）；CI 可选 nightly 跑 c8 快速档防回归。
- **T7 完成（2026-10-28）**：工具固化进 `scripts/performance/local-ab/`（client.go 加 `-proto anthropic` 响应校验；mock.go 单源双协议 `/v1/chat/completions`+`/v1/messages` JSON+SSE、可选 TLS、TLS 模式在 mock 端口 +1 暴露纯 HTTP metrics sidecar；seed-driver.cjs 参数化 run 目录/端口/`LOCAL_AB_FAST=off`（T5 strict）/`LOCAL_AB_ANTHROPIC=1`（多播 anthropic 路由，凭据仍全部运行时生成进 run 目录）；gen-certs.sh 本地 CA；run-profile.sh 输出含 mock TLS 握手计数差）。配套夹具改动：`NativeFastHttpRoute.protocol` 拓宽为 `'openai' | 'anthropic'`；`seedNativeFastHttpInventory` 新增可选第 4 参 `extraRoutes`（默认行为逐字节不变，fixed-cpu 家族不受影响）。全部冒烟通过（双协议 JSON+SSE 直连 mock、TLS+sidecar 指标）。

## Phase 1：fast 平面提速（Phase 0 验收后，1–2 周量级）

### T8 intent 组提交（最大单项）

- **问题**：每请求同步 intent INSERT + reserve 单事务是 JSON 差距主项（归因约一半）。
- **锚点**：`src/saas/gateway/fast/journal.ts` INSERT（:145 一带）与 reserve 入口。
- **实现要点**：微批队列（窗口 1–5ms 或凑 N=16/32）把多请求的 intent INSERT 聚合成一条多行 INSERT；reserve 的 allocation CAS 同批合并（同 wallet 同批一次 fence）；**单请求隔离**——批内一请求失败不连坐（错误按行拆分回传）；背压上限（队列深度超限退回单写路径）；低流量时零延迟直写。
- **验收**：c32 JSON ≥ 700 RPS（当前 553）；批内故障注入测试逐请求错误边界正确；p50 不劣化超过 5ms。
- **量级**：3–5 天。**依赖**：T1。

### T9 replenish 争用与 c64 延迟

- **问题**：c32→c64 p50 50→111ms（2.2× 膨胀陡于 s2a）。
- **实现要点**：fence advisory 锁按 (tenant, currency) 细粒度分片（`allocationStripes` 已有开关，压测验证分片数曲线）；replenish 目标带滞回（避免目标抖动引发高频补齐）。
- **验收**：c64 JSON p50 相对 c32 膨胀 ≤ 1.6×。
- **量级**：2–3 天。**依赖**：T1。

### T10 在途信号量可配置

- **实现要点**：`MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT` 支持按部署档位预设 + 文档化与容量的对应关系；可选：按上游健康度自适应（观察项，不承诺）。
- **验收**：c200 行为文档化（采纳 RPS、拒绝延迟近零）+ 配置生效测试。

## Phase 2：anthropic `/v1/messages` fast tier（核心战略，2–4 周）

前置：T1–T4 全部验收，T5 基线在案。

### T11 text-eligibility anthropic 语法表

- **锚点**：`src/saas/gateway/fast/text-eligibility.ts`（TEXT_KEYS 为 OpenAI 形状）。
- **要点**：新增 anthropic 语法（`max_tokens` 必填即天然输出上界，严于 openai 的 allowMissingOutputBound）；`fallbackReason`（`executor.ts:128`）放开 `/v1/messages` + anthropic 协议；未知字段照旧走 strict（"deliberately narrow"原则不破）。
- **验收**：灰度期间 anthropic 请求 fallback 率 < 5%（按 `x-model-router-fast-fallback` 头统计）。

### T12 cache token 计价扩展

- **锚点**：`src/saas/gateway/fast/executor.ts` `pricingSupported`。
- **要点**：`usageKeys` 已含 cacheRead/cacheWrite5m/cacheWrite1h（executor.ts:112），缺价格策略放行；首期带 cache 档价的模型继续走 strict 灰度，第二步扩价格版本结构。零价/平台价照旧 strict。

### T13 fast-native SSE 翻译

- **锚点**：`src/protocol/bridge.ts` 的 a→o 响应翻译（openai chunks → anthropic message_start/content_block_delta/message_delta）。
- **要点**：提炼为无 legacy store 依赖的纯函数模块供 fast 流式 tee 调用；事件序、usage 汇总、错误事件语义与 bridge 现行为对齐（用现有 bridge 测试矩阵做等价校验）。

### T14 admission 预扣语法 + 灰度开关

- **要点**：admission tokenUnits 从 anthropic body（system+messages+max_tokens）推导上界；灰度开关按路由/按模型，strict 兜底机制现成。
- **验收（Phase 2 总）**：以 T5 strict 基线为对照，anthropic fast 吞吐对齐 s2a ±10%、p50 不劣于 strict、0% 意外 fallback、重启/配额风暴测试通过。

## Phase 3：计费模型分级决策（产品拍板门，非工程任务）

### D1 后扣/预扣混合分级

- **背景**：s2a 后扣模型（热路径零 PG、按实际用量扣、超支被 in-flight 限界）证明可换 25%+ 吞吐；代价是无 DB 级资金不变量与缓存漂移对账（报告 sub2api 对照章）。
- **决策规则**：T8 组提交完成后复测——若 JSON 差距收敛到 ≤10%，本项降级为观察项不启动；若仍 >15%，立项评估"可信额度内客户后扣 + 超额/新客户预扣"（需对账/风控配套，季度级）。

## 里程碑与依赖

```
M0（地基）   T1 T2 T3 ──┬→ T4（journal 保留）
                        │
M0.5（基线） T5 T6 T7（并行）
                        ↓
M1（提速）   T8（依赖 T1） T9（依赖 T1） T10
                        ↓
M2（统一）   T11–T14（依赖 M0 全绿 + T5 基线）
                        ↓
M3（决策）   D1（依赖 T8 复测数据）
```

## 风险与回滚

- 所有任务在 fast 准入门内实现，灰度开关可整路由回退 strict（`x-model-router-fast-fallback` 逐请求可观测），无不可逆改动。
- T8 批内隔离是最大风险点：故障注入测试先行，批路径可一键退回单写。
- 迁移类改动（T2、T4 索引）走标准迁移评审 + `npm run` 全套健康检查（tsc/test/lint/deadcode）。
- 每个里程碑完成即更新 `docs/performance/` 实测文档，数字入库可追溯。
