# 开发进度报告 — 2026-10-18（T05 + 真实模型验证）

> **最新更新：2026-10-24。** Redis 与自托管实现边界见 **§28**；旧章节计数仅代表当时截点。可运营多租户模型 API 平台的最新实施见 **§29.48**：A0 的 P01 DTO 修复已推送，runner 非测试子进程凭据隔离已获源码审查；真实 A0 尚未执行。用户授权的一次自有 PG 恢复 run05 到达原 600 秒 scanner，随后 canonical replay 全租约快照比较失败；失败证据捕获修复已独立推送 `4858757`，没有重跑。生产准备链的无副作用重放及授权修复另行收敛；`87cc8b4` 的历史 CI 不覆盖新补丁。M1/M2/M3 与运营发布 GO 均未关闭。

> 基线：`93e7ffa`（core-capability-alignment-technical-plan 文档合并后）。本轮实施技术方案
> `docs/core-capability-alignment-technical-plan-2026-10-18.md` 中 **T05（9.1 前半 + Grok 门禁接线）**，
> 并按方案 14.3/G3 精神完成了可执行范围内的真实模型验证。

## 1. 配置检查结论（真实执行可用性）

### 可用（已验证）

| 项 | 状态 |
|---|---|
| PostgreSQL 真库 | 本地集群 `127.0.0.1:5434` + `model_router_test_parity_local`，角色与 `scripts/pg-e2e-env-local.sh` 就绪 |
| Ollama 真实上游 | `127.0.0.1:11434`，`qwen2.5-coder:7b`（`qwen2.5:7b` 曾拉取用于工具桥验证，验证后已删除释放磁盘） |
| LongCat 真实上游 | inline key 在 `~/.model-router/config.json`（local-only），直连 200（bearer，Anthropic 协议） |
| `npx tsc --noEmit` | 通过 |

### 缺失 / 阻断

| 项 | 结论 |
|---|---|
| Kimi 真实 key | **【2026-10-18 晚间勘误：key 有效，此前判“失效”是误判】** key 是 Kimi for Coding 产品线密钥（`sk-kimi-` 前缀、72 字符），正确端点是 `https://api.kimi.com/coding/v1`（anthropic 协议 + `x-api-key`）；此前 401 是打到了 moonshot 开放平台（Bearer）的**错误端点**。直连验证已通过：`GET /models` 200（模型 `kimi-for-coding`，K2.8 Preview，1M context）、`POST /messages` 200。`~/.model-router/config.json` 的 kimi-code upstream 定义与之完全一致（该文件结构正确；`kimi-validation.config.json` 才是把 key 误放进 `secret.name` 且端点配错的那份）。待办：把 key 放进代理进程 env `KIMI_CODE_API_KEY`（launchctl 或 shell），不落仓库 |
| 经代理链的 Kimi 真实验证 | **已完成（本轮补测）**：临时 live 测试（真实 V2 proxy → kimi-code upstream）两用例均 200——① anthropic 同协议（end_turn、text 块首块为 thinking、usage 正常，1.45s）② openai 跨协议 `chat/completions`（chat.completion 形状 + usage，1.63s）。key 仅存在于进程 env，临时测试已删除 |
| `KIMI_LIVE_API_KEY`/`DEEPSEEK_LIVE_*` env | 未设置，对应 live 测试 skip |
| Docker daemon | 未运行；只影响容器化发布验收，本地原生 PG 集群可替代，不阻断 G1 |

## 2. T05 实施（方案 9.1 / B06）

### 2.1 模型级冷却：写入与消费打通（原缺口：只有写入）

- `ProviderAccountModelRateLimit` 以前只在 dispatch 侧 `recordModelRateLimit`（`prepared-evidence-dispatch-service.ts`），`isModelExcluded` 零调用。
- 现在同**一个实例**同时交给 dispatch（写入）与 scheduler（读取）：
  - `src/server/managed-saas-gateway.ts`：`modelRateLimitRegistry = new ProviderAccountModelRateLimit()` → `dispatch.modelRateLimit` + `scheduler.modelCooldown`。
  - `src/saas/gateway/provider-account-scheduler.ts`：新增 `ProviderAccountSchedulerModelCooldownPort`（`isModelExcluded({candidate, model, now})`，model 取 `candidate.resolvedModel`）；冷却对在 eligibility 往返之前跳过该 (account, model) 候选。
  - P17 fail-open 语义与 H5c 一致：冷却 rule 只在 viable 集非空时生效；两者联合清空时对**并集**重跑（`ignoreFailureFeedback + ignoreModelCooldown`）；durable 全拒仍走 K2 `capability_unavailable` 503。

### 2.2 Grok 门禁写入状态消费（原缺口：写入后无生产消费）

- **429 冷却**：migration 119 的 `grok_rate_limited_until` 现在在 eligibility 重验证里消费——未来有效即 deny（"persisted grok 429 cooldown is still active"）；缺失/过期/畸形 fail-open。durable 语义对齐 109/115 先例。
- **free-tier 软门**：`free-tier-gate.ts` 保留原纯函数（500k/95%），另新增快照适配 `evaluateGrokFreeTierGateSnapshot`——迁移 119 持久化的是上游观测的 `grok_5h_used_percent`（无本地 rolling-24h 绝对 token 聚合），适配器把同一 `GROK_FREE_SOFT_GATE_FRACTION`（95%）作用于观测窗口百分比；tier 仅信任 `grok_subscription_tier`；快照陈旧（>2h）/缺失/畸形全部 admit（fail-open，绝不因缺数据减容量）。
- **阈值族**：5h token 窗口加入 R-dormant 阈值机制（`SchedulingThresholdPlatform` 增加 `'grok'`，`grok_5h_*` 进候选 SQL/行解析）——仅在账号配置了 `auto_pause_5h_threshold` 时产生候选，默认休眠路径不变（golden-fixture 红线保持）。
- 两个 eligibility SQL（BYOK/平台）均投影 migration 119 列；只读，不进入计费（093 先例）。

### 2.3 附带

- `biome.json`：排除 `.claude/**`（内含 worktree 拷贝导致 nested-root 配置错误）与 `kimi-validation.config.json`（本地运行时配置）。

## 3. 测试证据（G0）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 退出码 0 |
| 单元 | `node scripts/run-tests.mjs unit` | 5935 tests：5912 pass / 0 fail / 23 skip（含 9.2 新增 6） |
| 集成 | `node scripts/run-tests.mjs integration` | 302 tests：234 pass / **1 fail（pre-existing）** / 67 skip（本轮拦截器改动后数字与此一致） |
| Lint | `npx biome check .` | 0 errors（1,100+ warnings 为存量） |
| 调度器专项 | `tsx --test tests/saas/gateway/provider-account-scheduler.test.ts` | 21/21（新增 5） |
| PG 调度器专项 | `tsx --test tests/saas/gateway/postgres-provider-account-scheduler.test.ts` | 118/118（新增 grok 列 + 门禁 7 子用例） |
| 阈值专项 | `tsx --test tests/saas/gateway/provider-account-scheduling-threshold.test.ts` | 8/8（新增 grok 2） |
| HTTP 边界专项 | `tsx --test tests/saas/gateway/http-handler.test.ts` | 34/34（新增 9.2 Retry-After 透传 1） |
| Grok 门专项 | `tsx --test tests/saas/gateway/grok/free-tier-gate.test.ts` | 4/4（新增快照适配 2） |

集成失败项 `123 the in-memory store enforces the same contract for unit wiring` 在未含本轮改动的 clean main 上复现，与本轮无关（记录在案，另任务处理）。

新增测试聚焦方案 14.3 的"业务不变量"组织：模型冷却只跳过被冷却的 (account, model)、eligibility 零往返、P17 并集 fail-open、durable 全拒 block、Grok 429/软门/阈值三路消费、fixture 缺列零漂移。

## 4. 真实模型验证（G3 精神，不经 mock）

通过真实代理链（V2 runtime + `proxyHandler`，本地配置凭据，无密钥打印）：

| # | 链路 | 结果 |
|---|---|---|
| 1 | Anthropic 客户端 → LongCat（同协议透传，含 thinking 块原样返回） | PASS（text="OK"，usage 真实 11/30） |
| 2 | 同上，SSE 流式（event/delta 完整） | PASS（2.4KB 事件流） |
| 3 | OpenAI 客户端 → LongCat（o→a 跨协议），OpenAI usage 形状回传 | PASS（prompt/completion/total tokens） |
| 4 | Anthropic 客户端 → Ollama qwen2.5-coder:7b（a→o 桥） | PASS（stop=end_turn） |
| 5 | 同上 **真实工具转换**：`get_weather` 工具经 a→o 桥与 `qwen2.5:7b`（原生 tool 模板） | PASS（`stop_reason=tool_use`，`get_weather {"city":"Beijing"}`） |
| 6 | 独立用例：直连 moonshot `/v1/models` | **401——系端点误配，非 key 失效（见勘误）**：该 key 属 Kimi for Coding 线，对应 `api.kimi.com/coding/v1`；改打正确端点后 `GET /models` 与 `POST /messages` 均 **200** |

附：qwen2.5-coder:7b 不在消息级发 tool_calls（模型模板不支持工具）——结论为模型行为而非代理缺陷，故拉取 tool-capable qwen2.5:7b 完成验证后删除（磁盘 100% 告警，见 §6）。

## 5. 剩余工作（9.2 尾段）

- **窗口三态预留带**（9.2 前半）：`limit <= usage < limit+reserve` → 仅接纳已有粘性会话、`usage >= limit+reserve` → 暂停调度。阈值/预留带来自"冻结策略"，需要每账号窗口费用上限的 schema + 冻结表 + 授权读者，遵循方案 14.1 数据纪律，独立任务开工。5h 窗口费用**聚合管线**（任务 #6 的 `getAccountWindowStatsBatch` / `groupAccountIdsByWindowStart`）已经存在，可直接复用。
- **模型冷却多实例持久化**（9.1）：原为进程-local（`ProviderAccountModelRateLimit` Map，多实例互不可见）；现已落地 PG 权威记录（迁移 133 + `PostgresProviderAccountModelCooldownRegistry`，L1 本地 Map + `cooled_until > now()` 失效界 + GREATEST 合并 upsert），见 §8。
- `RUN_KIMI_SMOKE`（moonshot 平台线）如需可另行配置平台线 key；DEEPSEEK key 仍缺。
- 集成套件存在计时型 flake（`4.2 the JSON keepalive stream writes whitespace heartbeats` 在全量单测高负载下偶现，单独跑 3/3 通过），与本轮无关，可另开小任务。

## 6. 环境备注

- 磁盘曾在会话中达 100%（435MB 余量）：主因 `/tmp/claw-compaction-reliability-target-20261017`（57GB，非本项目数据，经用户确认未处理）+ 双次 ollama pull 中断。已释放 cache 与已验证模型；当前 ~67GB 可用。

## 7. 方案 9.2 后半完成：粘性目标有界等待（bounded sticky wait）

**语义**（`ProviderAccountSchedulerStickyWaitConfig`：`maxWaitMs` / `maxQueueLength` / `tickMs`，默认 OFF，不在配置里就不改路径）：

1. 首趟检查链产出 `busySkipped`（eligibility+health 均通过但并发额度满的候选）；
2. 开启等待时，affinity 解析域从 `eligible` 扩展为 `eligible ∪ busy`——繁忙但可调度的粘性目标**不再被 stale 失效**（这是 keystone：否则 binding 会在等待前就被清掉）；
3. 命中繁忙目标 → 进程内有界重试循环：每 `tickMs` 重跑一遍完整检查链直至目标释放租约位或 `maxWaitMs` 到期；**等待期间不持 DB 事务/推理租约/资金 hold**（各端口自行开事务，sleep 间无外部状态）；
4. 目标释放 → 直接选定（trace reasons `['affinity','sticky-wait']`）；到期 → `rate_limited` reject（HTTP 映射 429 + `Retry-After`，时长 `ceil(maxWaitMs/1000)` 初始值）且 binding 保留给下一个请求；等待者队列满（per (supplyMode, account) 进程内计数）→ 降级排名链；目标既不 eligible 也不 busy（真死）→ 维持原防御 block。

**接线**：核心 scheduler options（postgres wrapper 原样透传）→ `ManagedSaasGatewayOptions.schedulerStickyWait`（默认不设 = OFF）；`RequestPreparationRejected.retryAfterSeconds` → `decisionFailure` 透传 → `GatewayHttpError` → `writeJsonError` 输出 `retry-after` 头（0–86400 校验）。

**测试**（+6）：繁忙目标释放后选定（域扩展断言 `['account-b','account-a']`）、预算耗尽 429 + Retry-After、队列满并发降级（第二 waiter 不入队，顺利完成 account-b）、真死目标维持 block、配置非法 TypeError、HTTP 边界有/无 hint 的 429 头形。等待 OFF 路径由存量 golden 断言保护（`resolve` 收到的域不变）。

## 8. 方案 9.1 完成：模型级冷却的 PG 持久化（多实例）

**背景**（§5 尾项）：dispatch 侧把 `model-unavailable`（404 / plan-gated 400）记为 (account, model) 30 分钟冷却，但注册表是进程内 Map——多实例下 A 实例记录的冷却对 B 不可见（方案 9.1 要求"PG 权威记录或有界共享缓存和明确的失效上界"）。

**实现**：

1. **迁移 133**（`133_provider_account_model_cooldowns.ts`）：`saas_provider_account_model_cooldowns(owner_scope_key, account_id, model, cooled_until timestamptz, updated_at timestamptz)`，主键为三元组，`cooled_until` 建索引；行键与进程内 Map 完全一致（平台账号 → `'platform'`，租户账号 → tenantId；模型取 trim 后值）。过期行惰性失效且表按"账号×模型"有界（非事件增长），运行角色不取 DELETE 权限。权限走 manifest：read-table SELECT + 五列 INSERT + 两列（`cooled_until`/`updated_at`）UPDATE，镜像由 `scripts/generate-privileges.ts` 再生成（TS/SQL 双视图一致，fence 测试通过）。
2. **`PostgresProviderAccountModelCooldownRegistry`**（`postgres-provider-account-model-cooldowns.ts`）：写路径 = 本地 L1 立即生效 + best-effort durable upsert（`ON CONFLICT ... DO UPDATE SET cooled_until = GREATEST(...)`，短冷却永不缩短长冷却；写失败仅诊断回调，不影响 dispatch 失败路径）；读路径 = L1 优先 + 单行点查 `cooled_until > now`（比较即失效界，无缓存 TTL），读失败 fail-open（不排除）——沿用调度器 P17 姿态。
3. **端口加宽**：`ProviderAccountSchedulerModelCooldownPort.isModelExcluded` 允许返回 `boolean | Promise<boolean>`（候选循环 `await`，同步实现/测试不受影响）；dispatch 侧 `recordModelRateLimit` 允许 `void | Promise<void>` 并 `await`（响应返回前记录已是权威事实）。缺省不接线时选路逐字节不变。
4. **接线**：`managed-saas-gateway.ts` 组合根创建共享注册表（`local: modelRateLimitRegistry`），同时供 scheduler 读与 dispatch 写。

**验证**：

- 单测 +9（注册表：L1/upsert 形状/GREATEST/Q-失败 fail-open/坏输入）+ 2（scheduler 异步读、dispatch 等待记录）；迁移注册表/尾部断言同步到 head 133。
- 全量单测：6109 tests，6086 pass / 0 fail / 23 skip，EXIT=0。
- 真实 PG（新建 disposable 库 `model_router_test_mc_local`，迁移到 head 133 + 角色授权重放）：跨实例记录/读取、owner-scope 隔离、GREATEST 合并、`cooled_until` 过期后恢复调度、gateway 角色 DELETE 得 42501（无删除权限）全部通过。

## 9. 方案 6.1 第一部分完成：v2 runtime module 合同与 loader（T01）

**背景**（B01）：`gateway-runtime-module.ts` 的 v1 合同对依赖键做精确匹配，新增 transport、媒体和 TLS 参数没有合法入口；自定义可信 module 仍是唯一装配方式，标准部署无法只选择内置 bundle。

**实现**（`src/saas/runtime/gateway-runtime-module.ts`）：

1. **v1 语义不变**：`{dependencies, checkReady, close}` 三键精确匹配保持原样；loader 返回值对 v1 不携带 `extensions` 键（`Object.hasOwn` 为 false），既有模块与既有测试逐字节不受影响。
2. **v2 外层版本先识别**：v2 handle 固定五键 `{apiVersion: 2, dependencies, extensions, checkReady, close}`；`apiVersion` 不是数字 2（含 `'2'`、1、3、null）即拒绝；仅加 `apiVersion` 而无 `extensions` 的"半升级"同样拒绝；多键/少键一律 `MODULE_CONTRACT_INVALID`。依赖集合仍与 v1 完全相同（v2 不扩依赖键）。
3. **extensions 固定 schema、未知字段拒绝**：
   - `providerBundles`（必填，≤64 项，bundle id 唯一）：`{bundle, enabled, parameters?, secretReferences?}`，`bundle` 匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，`enabled` 必须显式布尔；
   - `media`: `{storage, parameters?, secretReferences?}`；`tlsFingerprint`: `{profile, parameters?, secretReferences?}`；两节只允许各自精确键（例如 media 带 `enabled` 即拒绝）；
   - `parameters` ≤32 项，键 `^[a-zA-Z][a-zA-Z0-9._-]{0,63}$`，值只允许布尔、有限数（拒绝 NaN/Infinity/超安全整数）与 ≤4KiB 字符串；`secretReferences` 值为非空、可打印、≤1KiB 的引用名（如 `env://…`/`kms://…`），不收原始凭据。
4. **所有权与冻结**：loader 对每一层（extensions/数组/条目/参数/引用）生成冻结副本，调用方之后修改源对象不影响已加载配置；扩展只携带声明式参数与 secret reference，认证、钱包、prepare/admission、证据验证与 listener 仍归 core。

**验证**：

- 新增 `tests/saas/runtime/gateway-runtime-module-v2-contract.test.ts`：15 用例（v2 接受/深冻结/脱离源对象、v1 无 extensions、版本标记 4 种非法值与半升级、handle 多键、extensions 三节精确性、bundle 字段/数量/重复 id、参数与 secret 边界）。
- 回归：v1 合同 11 + affinity keyring 16 + v2 15 = 42 pass；`tests/server/saas-startup.test.ts` 58 pass；`tsc --noEmit` 与 `biome check` 干净。
- 备注：该工作树此前的依赖安装误用 pnpm，导致 `saas-startup` 的 1 个用例因传递依赖版本差异失败；按仓库实际工具链 `npm ci` 重装后 58/58 通过（与代码无关）。

**下一步（T01 余项）**：内置 bundle 装配入口（把 extensions 交给 core-owned entitlement/catalog/route/credential 服务解析，产出 dependencies）与 capability readiness（enabled/assembled/ready/verification level + 脱敏原因；显式启用但缺装配在启动阶段报错）。`src/server/managed-saas.ts` 的接线待并行会话的在途改动落地后进行，避免覆盖。

## 10. 方案 6.2/6.3 第一部分完成：内置 provider bundle 注册表与 capability readiness（T01-b）

**背景**：v2 loader 已能接受 `extensions.providerBundles`，但 core 尚无 bundle 清单与就绪投影——bundle id 拼写错误、启用后缺少专用 transport、媒体/TLS 配置指向不可用存储时，都只能在真实请求或人工巡检时暴露。方案 §6.2/§6.3、G-C1 §8.2 要求：bundle 单一事实源、四态投影（enabled/assembled/verified/operational）、显式启用但缺装配在启动阶段失败、就绪缺口按能力返回 503。

**实现**：

1. **`src/saas/runtime/provider-bundles.ts`（内置 bundle 注册表）**：
   - 登记 10 个已实现类别：`anthropic-claude`、`openai-codex`、`google-gemini`、`xai-grok`、`zhipu`、`minimax`、`opencode-go`、`openrouter`、`aws-bedrock`、`google-vertex`；bundle id 与 provider id 一致，避免第二套命名。
   - 每个 manifest 的 provider/product/credential/protocol/endpoint 全部从对应 `catalog-identity.ts` 导入（与 catalog 注册、凭据 sink、探针、派发 split 同源），不复制字面量；`zhipu` 保留 payg/Coding 两个 product 与两个 endpoint scope，`grok` 保留 OAuth + API-key 两种凭据，`opencode-go` 标明三协议按模型规则派生，Bedrock 的 `api-key` 凭据因尚无 catalog rights 注册而不在可选清单中广播。
   - `dispatch` 明确 transport 面：`generic`（共享 HTTP transport 足够）与 `codex/claude/gemini/grok/cn-providers/opencode-go/bedrock/vertex`（每个 endpoint scope 必须有专用 prepared-evidence transport，禁止静默回退 generic）。
2. **`src/saas/runtime/gateway-capability-readiness.ts`（四态投影 + 启动门禁）**：
   - `enabled` = 配置显式启用；`assembled` = 对应 transport/存储/侧车面已挂载；`verified` = 存在 live 验证记录（mock/标准装配记录只展示、不进入可售）；`operational` = catalog 注册、supplier price、凭据均就绪；`isGatewayCapabilitySellable` = enabled ∩ assembled ∩ verified ∩ operational。
   - 配置级致命码（启动失败）：`PROVIDER_BUNDLE_UNKNOWN`（未知 id，含 disabled，拼写错误不放行）、`PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE`（缺少专用 transport，并列出 `unavailableEndpointScopes`）、`MEDIA_STORAGE_UNAVAILABLE`、`TLS_PROFILE_UNAVAILABLE`；就绪级原因码（不拖垮进程）：`CATALOG_PROVIDER_MISSING`、`CATALOG_ENDPOINT_MISSING`、`SUPPLIER_PRICE_MISSING`、`CREDENTIALS_NOT_PROVISIONED`、`VERIFICATION_NOT_RECORDED`。
   - `assertGatewayCapabilityAssembly` 抛出 `GatewayCapabilityAssemblyError`，失败项只含 capability id、kind 与致命原因码；投影永不回显 `parameters` / `secretReferences`，输出逐层冻结，顺序与配置一致。
   - 媒体/TLS：extension 出现即视为启用；storage/profile 未在事实集内则启动失败；已挂载则进入 assembled/operational，验证等级同样按 live 判定。

**验证**：

- 新增 `tests/saas/runtime/provider-bundle-readiness.test.ts`：17 用例（10 类清单/唯一性与同源断言、空选择与 v1 无 extensions、disabled 不评估、全绿 bundle 四态、缺专用 transport、generic 缺省 fail-closed、CN 双 scope、未知 id 含 disabled、catalog/价格/凭据缺口、mock 不可售与 malformed 记录 fail-closed、媒体/TLS 致命与挂载、assert 失败脱敏、冻结与顺序）。
- `tsc --noEmit` 干净；`biome check` 干净；定向测试 17/17。

**下一步**：

- `src/server/managed-saas.ts` 在并行会话在途改动落地后接线：v2 `extensions` → `assertGatewayCapabilityAssembly`（启动门禁）+ 从 PG/组合根采集 catalog/price/credential/dispatch 事实（doctor/管理 API 投影）。
- 内置装配入口的依赖产出（entitlement/catalog/route/credential 解析）与各 bundle transport 构造，按 T02 逐供应商接入并做标准部署 smoke。

## 11. 真实上游验证：kimi-for-coding 的 tools/thinking 能力声明（2026-10-20）

**背景**：本地 `~/.model-router/config.json`（rev 16）只给 `kimi-for-coding` 声明了 `text: supported`，而 `capabilitiesSource` 标为 `preset`。运行时并不解析 preset（该字段仅作界面展示），`tools`/`thinking` 缺失按 fail-closed 处理，Claude Code 的工具请求会得到 422 `capability_unverified`。此前把该缺口登记为“待确认修复路径”。

**真实上游证据**（直接调用 `https://api.kimi.com/coding/v1/messages`，凭据取自本地运行进程环境，未打印密钥）：

1. `tools` + `tool_choice:{type:'any'}`：HTTP 200，`stop_reason:"tool_use"`，内容块 `thinking, tool_use`；证明端点接受工具声明并返回工具调用。
2. `thinking:{type:'enabled', budget_tokens:512}`：HTTP 200，内容块 `thinking, text`；usage 含 `output_tokens_details.thinking_tokens`。
3. 结论：缺口在声明层，不在上游能力。

**配置修复**：`~/.model-router/config.json` 升级到 rev 17（同目录保留 0600 备份），仅修改该模型：

- `capabilities`: `text/tools/thinking = supported`（其余保持未知，继续 fail-closed）；
- `capabilitiesSource: "verified"`，`verifiedAt` 写入本次验证时间；
- `configV2Schema.safeParse` 通过；
- 未改动任何凭据、路由、其他 upstream/模型或密钥。

**经代理冒烟**（隔离实例：更新后的配置副本、临时端口/临时代理 Key、真实 KIMI 凭据）：

- `POST /v1/messages`（`tools` + `tool_choice:any`）→ 200，`stop_reason:"tool_use"`，`content: thinking,text,tool_use`；
- `POST /v1/messages`（`thinking.enabled`）→ 200，`content: thinking,text`；
- 未出现 422 `capability_unverified`；临时实例与临时配置已清理。

**运行态**：按新配置重启本地 daemon（pid 99641，`/healthz` 200，pid 文件正常），新进程保留原 `KIMI_CODE_API_KEY` 环境引用。Claude Code 的后续工具请求走同一配置。

**遗留**：`capabilitiesSource=preset` 仍无运行时解析；本次以 `verified` 手工声明落地。是否补仓库级 preset 解析另行决定。

## 12. T02 首个供应商生命周期补齐：OpenRouter 验证与探活（2026-10-20）

**背景**：`openrouter` 已有 catalog 注册、`openai` 协议派发、F6 定价同步和平台 API-key 导入路径，但 `FIXED_ADAPTERS` 与账号探针注册表都没有 OpenRouter：平台凭据创建后自动入队的验证任务会以 `adapter_unsupported` 终止，账号无法进入 verified；手工探活同样返回 `probe_endpoint_unsupported`。这是 T02 “各供应商供给/验证/刷新/探活接线”中的一个真实断点。

**上游事实**：OpenRouter 官方 OpenAPI 定义 `GET https://openrouter.ai/api/v1/key`（operationId `getCurrentKey`，Bearer 认证）返回当前 Key 的 `{data:{label, usage, limit, ...}}`；`/models` 是公开目录，不能证明凭据存活。因此验证与探活都固定到 `/key`，不使用 `/models`。

**实现**：

1. **`src/saas/gateway/openrouter/catalog-identity.ts`**：新增 `OPENROUTER_KEY_PATH` / `OPENROUTER_KEY_URL`，从既有 `OPENROUTER_BASE_URL` 派生，保持单一 origin 事实源；注释记录官方 `getCurrentKey` 语义与“公开 `/models` 不等于凭据验证”的原因。
2. **`src/saas/supply/credential-validation-adapters.ts`**：
   - 新增固定适配器 `openrouter-api-key-v1`：provider/product/credential/endpoint/protocol 全部引用 `catalog-identity.ts` 常量（`openai` 协议与 catalog capability 行一致），URL 固定为 `/key`，`probe: 'key'`。
   - 新增 `key` 探针种类：bodyless `GET`、Bearer auth、无 `content-type`；成功只要求完整读取 ≤4KiB 的 2xx 响应，不把 Key 元数据当作模型或消息响应解析。
   - 模型标识校验允许厂商 slug（`openai/gpt-4o`），同时继续拒绝 `://`、`//`、空白/控制字符、问号和超长 id；模型只进入 JSON body，不进入固定 URL，因此不构成路径注入面。
3. **`src/saas/supply/account-probe-service.ts`**：
   - provider 映射显式登记 `openrouter → api-key`（语义仍是通用 API-key 类别）。
   - api-key 探针在固定端点返回 `probe: 'key'` 时使用新的 `buildKeyProbe`，固定请求 `/key`，不发送挑战问题/模型；响应必须是 `{data:{label:string,...}}`，否则 `response_invalid_shape`，避免把 2xx 错误页或无关 JSON 当作健康。
   - `/key` 顶层的数值 `usage`（美元）不会被误读为 token usage；探针结果的 usage 保持 null。

**验证**：

- `tests/saas/supply/credential-validation-adapters.test.ts` 新增 2 用例：固定 URL/GET/Bearer/无 body/无凭据回显，以及 401 分类为不可重试的 `credential_rejected`。
- `tests/saas/supply/account-probe-service.test.ts` 新增 1 用例：`/key` 探针成功、请求无挑战内容、非法 `data` 形状失败；类别映射断言补 `openrouter`。
- 定向回归：`credential-validation-adapters` + `account-probe-service` 41/41；supply/catalog/openrouter/runtime readiness 追加 140/140；`tsc --noEmit` 无错误。
- **限制**：本机没有 OpenRouter API Key，未做真实上游 smoke；本次只固定官方端点、方法与响应形状，真实 Key 的端到端验证留待有凭据时执行。`biome check` 仅有 2 个既有的 `useOptionalChain` 告警，均位于本次未改动的消息/聊天响应解析代码。

**下一步**：有 OpenRouter Key 时跑一次真实导入→自动验证→探活→最小请求；随后继续 T02 其余 bundle 的生命周期面（导入端点、验证、刷新、quota）与 readiness 投影接线。

## 13. T01-b 续：按 provider 的就绪事实与 PG 采集器（2026-10-20）

**背景**：§10 的 readiness 投影已能判断 bundle 四态，但事实模型把 catalog endpoint 与 supplier price 建成全局列表：A 供应商注册/定价了 `claude-messages`，B 供应商即使没有该 scope 也会被判为已就绪。这会让 doctor/管理面给出错误的 `operational`。同时，事实采集仍停留在测试夹具，标准部署没有从 PG 生成事实的入口。

**实现**：

1. **`gateway-capability-readiness.ts` 事实模型改为按 provider**：
   - `catalogEndpointScopesByProvider: ReadonlyMap<string, readonly string[]>`；
   - `pricedEndpointScopesByProvider: ReadonlyMap<string, readonly string[]>`；
   - 投影按 `manifest.providerId` 取对应 scope 列表，缺失即 `CATALOG_ENDPOINT_MISSING` / `SUPPLIER_PRICE_MISSING`，不再跨供应商借用。
   - `catalogProviderIds` 与 `credentialProviderIds` 仍是 provider 级集合；四态与致命/就绪原因码语义不变。
2. **新增 `src/saas/runtime/provider-bundle-readiness-facts.ts`**：
   - `collectProviderBundleReadinessFacts(database)` 并行执行四条只读查询：
     - active catalog products → provider 集合；
     - active 产品的最新 capability 版本（`DISTINCT ON (provider, product, model, endpoint) ... version DESC`）中 `supported + verified` 的 endpoint scope；
     - active 产品、active 公共模型/版本下，当前生效且未过期的 supplier cost endpoint scope；
     - 平台账号与当前凭据都 `active + verified`、凭据有 `current_version` 且未过期的 provider。
   - 行级 id/scope 做有界可打印字符校验，空值/非字符串直接跳过（fail-closed）；输出去重排序并冻结，重复行不会污染事实。
   - `collectGatewayCapabilityFacts(database, deployment)` 把 PG 事实与组合根的 `dispatch`、媒体存储、TLS profile、live verification 记录合并；部署事实复制后冻结，调用方后续修改源数组不会改变已断言的装配结果。
   - 只输出 provider/endpoint/capability id，不读取或回显凭据材料、账号名或上游响应。
3. **测试**：新增 6 用例覆盖去重/分组、SQL 策略（最新版本、当前价格、账号+凭据双 verified）、部署事实复制冻结、跨 provider 隔离（Claude 就绪不使 OpenRouter 就绪）、空库存投影与非法入参；原 17 个 readiness 用例改为 per-provider 事实后全部保持通过。

**验证**：

- `tests/saas/runtime/provider-bundle-readiness.test.ts` + `provider-bundle-readiness-facts.test.ts`：23/23 pass。
- `tsc --noEmit` 无错误；`biome check` 对 4 个改动文件干净。
- **限制**：采集器目前只用 fake SQL executor 做单元验证，未连真实 PG；SQL 的 `DISTINCT ON`/时间窗语义与现有 catalog/pricing/凭据 SQL 一致，但真库 smoke 仍待接线时执行。`managed-saas.ts` 的在途改动尚未落地，本次未改组合根。

**下一步**：在 `managed-saas.ts` 解冻后把 `collectGatewayCapabilityFacts` 的结果接入 `assertGatewayCapabilityAssembly`，并将报告投影到 doctor/管理 API；随后继续 T02 各 bundle 的生命周期面。

## 14. T02 续：Codex/Grok OAuth onboarding 探针（2026-10-20）

**背景**：Codex/Grok 的平台 OAuth 导入路径会创建 `pending/unverified` 账号，并在创建凭据时自动排入平台验证任务。但 `FIXED_ADAPTERS` 中没有 OAuth 类别，验证 worker 以 `adapter_unsupported` 终止；账号探针又只选择已 `verified` 的账号，形成“先验证才能探活、先探活才能验证”的死锁。此前只能依赖人工/外部路径，标准部署无法完成 OAuth onboarding。

**决策**：不把“OAuth 授权交换成功”直接等同于可用性。新增一次真实上游 onboarding 探针：验证任务用固化 CLI 请求访问上游模型端点，模型必须回答一次性六位数字挑战，成功后才由既有 worker 完成路径把账号/凭据置为 `active + verified`。失败则保持 `pending`，不进入调度。

**实现**：

1. **新增 `src/saas/supply/oauth-probe-builders.ts`**：
   - 抽出 Codex/Grok 共用的固定请求构造与 Responses 文本提取/挑战匹配；
   - Codex 复用 gateway 的 canonical identity、fallback instructions 和固定 `/responses` 端点；
   - Grok 复用固定 CLI proxy origin 与 pinned CLI identity headers；
   - `account-probe-service.ts` 改为调用同一构造器，行为保持逐字节一致（既有 41 个探针/适配器用例全部通过）。
2. **`credential-validation-adapters.ts`**：
   - 新增 `oauth-responses` 探针种类，以及两个固定适配器：
     - `openai-codex` / `codex-chatgpt` / `oauth` / `codex-responses` → `openai-codex-oauth-probe-v1`；
     - `xai-grok` / `grok-subscription` / `oauth` / `grok-responses` → `xai-grok-oauth-probe-v1`。
   - OAuth 探针在 worker 内生成一次性六位数字挑战，要求响应 `output_text` 严格为同一数字；错误数字、非数字、空答案都映射为不可重试的 `provider_response_invalid`。
   - OAuth 探针使用独立边界：20s 超时（低于 worker 30s 默认 lease TTL，保证完成写回不会因租约过期被抢）、64KiB 响应上限；API-key 探针仍保持 5s / 4KiB，不因 OAuth 放宽而扩大原有攻击面。
   - OAuth 密封材料按 JSON 解析并做有界可打印字符校验；缺少 `access_token`、非法 JSON、非法 `chatgpt_account_id` 等在传输前返回 `credential_format_invalid`，不会发出请求。
   - `resolveFixedCredentialProbeEndpoint` 明确排除 OAuth 适配器，保证 API-key 探针路径永远不会把 OAuth 端点当作通用 bearer 端点使用。
3. **worker 完成路径无需改动**：既有 `updateHealthState` 在验证成功后同时激活账号与当前凭据；新增用例证明 OAuth 平台任务经真实密封 envelope、KMS 解密、固定请求和挑战校验后，账号/凭据都变为 `active + verified`，且写入顺序仍为 credential → account。

**验证**：

- `credential-validation-adapters` + `account-probe-service`：48/48 pass，覆盖 Codex/Grok 固定 URL、CLI headers、挑战成功/错误/缺失、密封材料失败关闭、401 分类、4KiB 以上至 64KiB 响应接受、超 64KiB 拒绝。
- 追加 `credential-validation-worker`、jobs/targets/http-transport、Codex/Grok supply-sink 与 HTTP：合计 141/141 pass。
- `tsc --noEmit` 干净；`biome check` 仅保留既有 `useOptionalChain` 告警（未改动的消息/聊天响应解析）。
- **限制**：本机没有 Codex/Grok OAuth 凭据，未做真实上游 smoke；本次以密封 envelope + 固定请求构造 + 响应边界用例证明链路。OAuth onboarding 探针与既有 API-key 固定适配器一样走 worker 的固定 fetch，不使用账号级 egress proxy；强制代理部署需在 worker 传输层另行接线。Claude/Gemini OAuth sink 尚未挂载到标准部署，也不在本轮覆盖范围；它们接入前必须在同一构造器中补齐请求/响应面，不能复用本次的 Codex/Grok 适配器冒充覆盖。

**下一步**：有真实 Codex/Grok OAuth 凭据时跑一次“导入 → 自动验证 → 调度可用” smoke；随后继续 T02 其余生命周期面（Claude/Gemini OAuth 在 sink 挂载时补齐、quota/刷新接线）与 T01-b readiness 投影接线。

## 15. 商业服务对标 Sub2API：源码复核与真实验证（2026-10-21）

**本轮性质**：分析、测试与文档记录，未修改实现。model-router 基线为 `bb9756c7b73a7f1a793aee761bb71f8ffb31956e`；工作树已有未提交的调度健康、媒体运营与客户端拆分改动。Sub2API 使用本地干净副本 `a3eb7ef302961cba716dc78b39b93b60c467db0e`，不将该副本称为上游最新版本。

**判断**：商业服务的主要剩余工作集中在有效凭据接入、协议语义、标准部署装配、当前发布门禁和运行证据。多租户、钱包账本、支付/退款、订阅、计费组、粘性调度、窗口门、媒体恢复、告警报表等已有实现，不能继续按旧清单重复建设。Sub2API 的参考价值主要在内置装配、账户生命周期、缓存快照与运营工作流；本轮未做两个网关的对称实机吞吐测试，不据源码判断性能倍数。

### 15.1 新发现一：有效 Kimi Code 凭据被验证适配器误拒绝

- 调用生产函数 `validateProviderCredential`，目标为已有固定适配器 `kimi / kimi-code / api-key / messages`，使用现有配置对应的真实凭据。
- 两次均收到上游 HTTP 200，适配器却返回 `failed / provider_response_too_large / retryable=false`。
- 第二次在同一次真实请求旁路观察响应结构：请求 `max_tokens=8, stream=false`；解压后的 JSON 为 **13,385 字节**，其中 thinking 签名长度为 **12,946 字符**，实际 `output_tokens=8`，`stop_reason=max_tokens`。未保存 thinking 内容或签名，仅记录类型、长度和用量。
- 源因：`src/saas/supply/credential-validation-adapters.ts:45,714` 对 API-key 探针统一使用 4,096 字节上限；OAuth 探针另有 65,536 字节边界。限制输出 token 数不能限制附带签名的大小。
- 业务后果由 worker 源码确认：非重试失败进入终态失败；账号保持 `pending`，不能因这次验证进入 `active + verified`（`credential-validation-worker.ts:1188,1218,1306`）。本轮没有向真实商业库导入凭据，持久状态后果属于代码路径核验。
- **建议 P0**：按探针类别/供应商选择有界响应上限与超时，允许合法的消息签名；保留 EOF、形状校验、密钥脱敏和总字节上限。修复后通过既有审计重排机制重新验证受影响凭据，验收“导入 → 自动验证 → 可调度”。

### 15.2 新发现二：OpenAI → Anthropic 的指定工具与 thinking 控制不闭合

- 当前 TypeScript V2 代理、真实 Kimi：Anthropic 原生两轮工具调用通过，工具名和参数为 `add({a:2,b:3})`，工具结果回传后输出答案，结束原因 `end_turn`。
- 同一上游的 OpenAI `chat/completions` 指定 function 请求返回 **400**：`tool_choice 'specified' is incompatible with thinking enabled`。请求已显式携带 `thinking.type=disabled`。
- 使用独立本地回显上游捕获代理实际发出的请求：无论输入 `thinking.type=disabled` 还是 `reasoning_effort=none`，发往 `/v1/messages` 的 body 均保留 `{type:tool,name:add}`，丢失两种思考控制字段。该回显是转换诊断，不是真实上游成功证据。
- 源码对应 `src/protocol/openai-to-anth.ts:25,139`；SaaS 的 `provider-payload-compiler.ts:2` 也复用 `pickBridge`，因此需要在商业链补同类验收。本轮真实 400 来自本地 V2 路径，不记作一次真实收费 SaaS 请求失败。
- G-B6 的 structured thinking 处理位于 `src/server/preprocess.ts`，依赖上游 opt-in；它不能证明桥接前已丢失的客户端控制字段能够恢复。
- **建议 P0（若销售 Kimi 的 OpenAI 工具接口）**：形成按供应商/模型声明的 thinking 与 tool_choice 兼容策略，贯通请求控制、响应 reasoning、工具结果和思考历史回传；同时验证自动工具和指定工具的完整多轮过程。不能用一次普通问答或一次工具响应宣称整条链路已验证。

### 15.3 标准部署装配仍是商业服务的主要缺口

| 能力 | 当前源码事实 | 商业服务需要的交付 |
|---|---|---|
| Provider bundle | v2 能解析 `extensions.providerBundles/media/tlsFingerprint`，但 `managed-saas.ts` 仅使用 module 的 `dependencies`；未找到消费扩展并构造对应 transport 的生产调用 | 提供内置生产 factory，由配置选择已知 bundle，覆盖注册、凭据、transport、探针、quota、定价与关闭回收 |
| 新 transport / WS | `gateway-runtime-module.ts:192` 的精确 dependency 白名单不含专用 transport 和 `responsesWsRoundExecutor`；v2 继续复用同一白名单 | 在明确的版本合同与内置装配中暴露必要能力；用标准 CLI/发布包启动，不依靠 programmatic 注入或 bench module 证明可用 |
| 就绪事实 | `collectGatewayCapabilityFacts` / `assertGatewayCapabilityAssembly` 尚无生产调用方；现有 `/readyz` 只检查数据库、KMS 与少量媒体挂载标志 | 将 per-provider 事实接入启动、doctor、管理面和可售能力投影；明确“启用、装配、验证、运营就绪”各状态 |
| Codex compact | SaaS `/v1/responses/compact` 未声明能力时 404；声明能力后仍无实际执行分支，固定返回 501 `COMPACT_TRANSPORT_UNAVAILABLE` | 补原生 compact 派发及其权限、费用/配额、超时与错误处理；验收真实长会话压缩，明确供应商支持范围 |
| Responses WS | engine/connection 及挂载缝已实现，仍依赖外部 executor | 将逐轮准入、取消、背压、原账号绑定和结算接入标准运行时，再以真实连接验收 |

源码锚点：`src/server/managed-saas.ts:1992,2025`、`src/server/managed-saas-gateway.ts:315,716,2258`、`src/saas/gateway/http-handler.ts:1773,1856`。

本轮已补一个原记录缺少的真库 smoke：在新建 PG18 空库存数据库、正式 control-plane 和 gateway 角色下执行 readiness 四条采集查询，两者均成功。该结果只证明当前 schema/授权下空库存查询可执行；非空事实正确性、标准组合根接线和生产可售状态仍未因此通过。

### 15.4 已补齐的账务能力与仍需完成的发布验证

- **Composite 实际供给成本归属已通过真实 PG18 测试**：`tests/saas/gateway/composite-resolved-supply-billing.postgres.integration.test.ts` 原文件执行，1 test / 1 pass / 0 fail / 0 skipped。当前会冻结解析后的实际供给身份，客户身份仍绑定名义路由。旧方案 B04 不应继续登记为未实现。
- `service-tier-trust` 的定向测试通过，覆盖已验证公共 API 的降档计费、不可信观察值不抬高账单、OAuth 的非权威观察和冲突处理。它属于本轮 55 个定向测试的一部分，不等于所有真实供应商的 tier 计费已经验收。
- 新 PG18 的迁移与迁移后授权重放通过；正式角色检查通过，control-plane 和 gateway 均能启动。
- **原始商业网关 E2E 当前仍失败**：`managed-postgres-commercial-gateway.integration.test.ts:278` 的夹具只解一层 authority decorator；生产组合在 `managed-saas-gateway.ts:1858` 已有 OpenCode Go 和 CN 两层。失败在第一笔商业推理 HTTP 验证之前，不能据此称网关业务请求失败，也不能称门禁通过。
- 仅在临时测试副本中按源码解两层继续诊断，随后又停在旧 `nativeHealth instanceof PostgresProviderAccountRuntimeHealthStore` 断言。该临时诊断没有修改仓库测试，也没有产生商业全链路通过结论。
- **建议 P0**：将门禁的装配观察合同更新到当前实现，保留真实角色、权限、撤权、资金围栏和故障断言，再重跑当前发布包的完整商业链。避免删除断言或增加超时来制造全绿。

### 15.5 从 Sub2API 借鉴的优化顺序

| 优先级 | 工作 | 对标依据及本项目落点 |
|---|---|---|
| P0 | 修复 Kimi 有效凭据误拒绝与核心工具语义 | 上述真实失败；先让现有可用上游完成商业入口和多轮调用 |
| P0 | 完成内置运行时、native compact 与按能力就绪接线 | Sub2API `backend/cmd/server/wire_gen.go` 内置构造 provider/token/quota/gateway；本项目 v2 当前主要停留在合同与元数据 |
| P0 | 修复并重跑商业发布门禁，重建当前产物后测性能 | 本轮当前门禁被过期夹具阻断；最近 R9 仍为旧镜像/旧基线的 FAIL，不将其数字当作当前源码实测 |
| P0/P1 | 缩短 preparation/admission SQL 热路径 | 参考 Sub2API 的 scheduler snapshot + outbox、billing cache + 有界工作池。当前 `postgres-request-admission-guard.ts:753` 起仍有大量串行查询；先做阶段计时、批量查询和按不可变版本缓存，再评估锁与派生计数器。钱包、撤权、额度、最终租约与派发围栏继续由 PG 约束 |
| P1 | 补 Kimi Coding quota 与统一账户出站路径 | Sub2API `cn_provider_quota_service.go:132,326,364` 已有 `/usages`、5h/周窗口及账号代理。真实 Kimi `/coding/v1/usages` 本轮 200，返回 rolling 与 weekly 数据；本项目 quota-sync 的固定适配器仅 DeepSeek，CN worker 为 Zhipu/MiniMax，缺 Kimi Coding 对应链路 |
| P1 | 将现有调度/媒体/账务故障数据接成运营闭环 | 复用已有 metrics、alerts、reports、unknown-outcome 和任务恢复；完成在途调度健康/媒体页面并验收异常定位、重试/重排、审计、数据新鲜度。Sub2API 的 Ops dashboard 组合系统池上限、job 心跳、错误与延迟分布可作参考 |
| P1 | SaaS 备份与恢复的运营交付 | Sub2API 有定时 S3 备份/恢复管理；本项目 `saas:upgrade` 仅在配置 PG 备份机制时实际备份，未配置可记录 anchor 后继续，`backup:create` 仅覆盖本地 V2。生产流程需接入明确的 PG 备份/PITR、异地保留、KMS 恢复材料与恢复演练回执 |
| 后续 | 更多 provider、图片/视频/语音与生态界面 | 在首条可售链和发布门禁通过后按客户需求扩展；rerank 保留入口或 Realtime 边界不计作本次对标 Sub2API 的首批商业阻断 |

Sub2API 热路径参考：`backend/internal/service/scheduler_snapshot_service.go:210,374`、`billing_cache_service.go:62`、`backend/internal/repository/usage_billing_repo.go:24`。其缓存/后计费设计与本项目派发前资金预留、证据和权限围栏的合同不同，采用快照与失效机制时需要保留本项目既有正确性约束；本轮没有数据证明直接替换能获得某个吞吐倍数。

### 15.6 本轮验证清单与后续可验收里程碑

| 验证 | 本轮结果 | 范围 |
|---|---|---|
| `tsc --noEmit` | exit 0 | 当前工作树 |
| runtime v2/readiness/facts、R2 HTTP entries、service-tier trust | 55 tests / 55 pass / 0 fail / 0 skipped | 定向单测与隔离 HTTP 夹具 |
| 当前源码 Kimi live smoke | 2 tests / 2 pass / 0 fail / 0 skipped | 原生非流式/SSE、OpenAI 普通桥接 |
| Kimi 原生两轮工具 | 通过 | 真实模型、`thinking=disabled`、工具结果回传 |
| Kimi OpenAI 指定工具 | HTTP 400 | 参数丢失由本地回显确认；尚无整条收费 SaaS 请求通过结论 |
| SaaS Kimi 固定凭据验证适配器 | 两次均误拒绝有效 200 响应 | `provider_response_too_large`；第二次记录签名/响应长度 |
| PG18 readiness facts | 两个正式角色均可执行空库存查询 | SQL/授权 smoke，未接标准运行时 |
| PG18 Composite 实际成本归属 | 1 test / 1 pass / 0 fail / 0 skipped | 原测试、隔离真库 |
| PG18 商业网关 E2E | 1 test / 0 pass / 1 fail | 旧装配 introspection 断言；未到首笔业务验证 |
| Sub2API Kimi quota/阈值子集 | 4 个命名测试均 PASS | Go 1.27.1，必须带 `-tags=unit`；未做 Sub2API 真实网关吞吐对照 |

定向 Node 测试根为 `gateway-runtime-module-v2-contract`、`provider-bundle-readiness`、`provider-bundle-readiness-facts`、`http-r2-saas-entries-e2e`、`service-tier-trust`。Kimi live 根为 `tests/integration/kimi-code-live.test.ts`。Sub2API 命令为：`go test -tags=unit ./internal/service -run '^(TestParseKimiUsageTiers|TestParseKimiUsageTiers_LimitZero|TestKimiQuotaURL|TestEvaluateAccountSchedulingThreshold_KimiCodingPlan)$' -count=1 -v`。

建议依次验收：① Kimi 自动接入与一个真实收费 SaaS 非流式请求；② 同一标准部署下的 SSE、多轮工具、账单、取消/重复结算和故障恢复；③ 当前构建产物的 R9、稳定运行、升级/备份恢复与运营页面；④ 再扩大 provider 和客户范围。

本机现有 Kimi 配置的两个 credential 条目引用同一个 `KIMI_CODE_API_KEY`，本轮用一个条目验证协议。这不能证明两个独立账户的容量或真实故障切换。所有本轮自建 PG 集群均已停止并删除 pgdata，临时代理已关闭；既有主服务与 Compose 栈未改动。

脱敏观测、原始测试输出节选与源码摘要见 [本轮验证目录](validation/commercial-sub2api-2026-10-21/manifest.json)。该目录是本地分析快照，不冒充 `docs/evidence` 约定的 required CI 发布门禁证据。

## 16. 商业服务对标修复与验收（2026-10-21—23，开发已落地、发布验收未完成）

本轮按 §15 实施。标准 CLI/builtin 的 Kimi 自动接入、JSON/SSE、自动与强制工具的完整两轮收费请求、取消及重复提交已多次通过。二次绑定争用与满载分类修复后，定向 c200 验证零 403/5xx/传输错误、关闭后零 pending/open holds；原失败记录保留。后续完成 dispatch reader 有序锁批量、钱包聚合合并、commercial reader 围栏批量及八条固定查询的可选 native 计划复用。八查询构建曾通过完整离线回归、PG15/18 功能门禁和真实 Kimi 主链，但其完整 R9 的性能与零 5xx 门槛失败。之后的池权限复用、纯读调度事务精简和入口背压已落地并通过各自定向检查；最新整套回归在 unit 阶段仍有 1 项失败，未重建或重跑真实 Kimi、同构建性能对照。按 2026-10-23 本次指令停止后续测试与验证，转为整理任务文档并分任务提交。最新状态以 §16.4 为准，历史记录按各自源码与测量范围保留，发布结论仍为 **NO-GO**。

### 16.1 已落地的实现

| 工作 | 实现与边界 |
|---|---|
| Kimi 凭据接入 | 固定供应商按探针类别使用有界超时和响应上限；Kimi 允许合法签名大小。修复固定适配器原生/旧协议别名在 worker 完成围栏中的不一致；自定义目标仍精确匹配。新增 137 平台凭据审计重排入口。 |
| thinking 与工具 | 保留 OpenAI 请求的 thinking/reasoning 控制、响应 reasoning 与签名历史。Kimi 原生指定工具名实际可能被忽略，已用 `any` 加仅包含被指定工具的集合表达强制语义；上游返回错误工具时拒绝错误结果，保留已发生的供应商用量和结算证据。 |
| 原生用量证据 | 修复 Kimi Coding 返回的 `service_tier=standard`、`inference_geo=not_available` 被严格解析器拒绝；兼容规则绑定已验证 provider/product/native operation/固定目标，四个原生计数及未知字段检查继续保留。桥接给 OpenAI 的总输入包含新输入、缓存读取和缓存创建，TTL 明细不重复相加。 |
| 标准运行时 | 发布包提供 `builtin` factory，按配置装配已知 bundle、专用 transport、凭据证明、S3/TLS 扩展和关闭生命周期。启动、`/readyz`、doctor、管理面消费能力事实。详见 [内置运行时](managed-saas-builtin-gateway-runtime.md)。 |
| 可售投影 | `/v1/models`、`/v1beta/models` 和模型广场按精确 provider/product/endpoint 消费新鲜就绪报告；复合路由的解析价格身份也经过过滤。缺少回调、错误或无效报告返回 503。经过认证的直接验证与 count_tokens 保留既有授权流程。 |
| compact / Responses WS | 新增 native compact 派发与 134 操作迁移；WS 默认 executor 接入逐轮准入、取消、背压、原账号绑定与结算。取消关联供应商 response ID，创建响应前不泄漏网关内部 UUID。Codex 的完整输入/输出计费上限尚无可信证明，内置运行时保持不可售；不记作真实长会话验收通过。 |
| quota 与出站 | 新增 135 Kimi Coding 五小时/周窗口快照、阈值和新鲜度链路；验证、探针、刷新与派发复用账号绑定出站路径。补齐 Claude/Gemini 既有窗口读取的受限角色授权与真库回归。 |
| 桥接调度 | 修复调度器用客户端 OpenAI 协议匹配 Anthropic 原生 capability 的误拒绝；复用已有服务端 `route.providerProtocol`，客户端路由、rights、价格与 epoch 校验仍使用各自的既有身份。新增原生能力限定的 BYOK/平台池真库回归及 required CI selector。 |
| 协议与计价身份 | HTTP 响应桥接使用已持久化、签名的规范客户端 `protocol`，不依赖缺省的冗余别名；异步网络操作前固定转换器。准备快照分别保存客户计价协议和原生上游协议，客户价格核验使用前者；旧快照仅在新字段确实缺失时回退，非法值、继承值和错误身份继续拒绝。 |
| 运营闭环 | 完成调度健康、媒体故障、诊断、新鲜度展示及授权审计重排/恢复动作；136 保存媒体重排请求。实际浏览器验收另修复 SPA 挂载返回空页面、运营摘要聚合查询的 `42803` 错误；界面消费实际服务及权限合同。 |
| SaaS 备份恢复 | 新增 PG dump/PITR 策略、异地保留、KMS 恢复要求、定时任务、恢复回执及管理面；升级要求有效备份策略。原生 PG dump/restore 演练已通过，S3/KMS 使用协议替身的部分仍单独标记。详见 [备份运行手册](../deploy/managed-saas-backup-runbook.md)。 |
| 商业门禁与时钟 | 更新装配观察合同，保留权限、资金、撤权、故障断言。attempt 状态时间、池成员/授权生效时间使用数据库时钟；准备 authority SQL 返回其实际采样时刻，JS 授权窗口使用同一时刻并拒绝非法时钟。另修复只读池/档案误用行锁、账号 capability INSERT 显式写入未授权默认时间列的问题。 |
| 钱包补偿锁序 | 首次 c200 真实负载发现补偿的 wallet 行锁→wallet advisory 与结算的 advisory→ledger FK/余额行锁反序。现 `assertHold` 先取得既有 canonical wallet fence，再执行原 wallet/reservation `FOR UPDATE`；金额、身份、replay、审计及失败回滚保持。11/11 定向单测、类型检查、独立只读审查和重建完成；PG15/18 HTTP 与补偿根各 41/41，含真实并发正金额结算、补偿等待、重放、回滚与两个显式测试变体的死锁反例。新 c200 未复现死锁，其他 5xx 仍在定位。 |
| 健康读写时钟 | 健康读取在 store、HalfOpen、core 各自 await 完成后用同一可注入主机 clock 复核，严格缺省才兼容旧 Date，250ms、maxAge 和 cooldown 不变。probe 成功及释放 lease 后仅一次真实重读；健康写入的冲突更新改用锁后单次 DB 采时，两列共享原冷却曲线，token/revision/EMA、040 与失败 latch 保留。 |
| 最终派发容量 | 仅已知 PG dispatch adapter 将严格 null 分类为独立容量错误；原 PG API、health probe 及自定义 null 合同不变。HTTP 只有在响应未开始、请求未取消、同 request/attempt 的 quota/rate/hold 全部确认释放且无人工对账时返回 429；补偿不确定、存储或坏租约仍按原失败路径处理，不猜测 Retry-After，不增加租约重试。 |
| 并发绑定竞争 | PG 标准路径组合选择与绑定，最终结果后才保留/释放 Redis slot。落败 bind 只在有效 active references 指向单一账号时返回类型化 winner，写入前返回且不刷新胜者；组合操作检查原候选集、scope、attempted 和新鲜 eligibility/health/capacity/window，最多对该 winner 再做一次原 fenced bind。二次严格 typed hint 若指向原域内唯一、同 scope、未 attempted 的另一账号则准入前 429，不再复查或绑定；坏 hint、不同 references、存储/CAS 错误仍 block。合法容量 deny/严格数值满载返回 429；畸形数值先 block，健康拒绝保持 503 优先。Redis release 保留 advisory best-effort/TTL，显式抛错仍覆盖待返回结果。 |
| HTTP 关闭等待 | composition 跟踪并原样返回 HTTP promise，保留 AsyncLocalStorage 和非 async handler。关闭按 WS → 等待返回的 HTTP 工作（含结算与 lease finally）→ lifecycle 顺序执行；不改定时、取消、资金或 HTTP 状态。脱离该 promise 的视频后台登记不在这项证明内。 |
| SQL 热路径 | 合并准入读取；价格读取改用共享 lineage fence，写入继续独占；首次商用身份查找改用不可变提示，最终完整围栏视图保留。preflight/claim 在同一组有序围栏后批量读取固定 authority 列，保留独立事务、行锁、数据库时钟、签名、CAS 与审计。新增有界 preparation/dispatch 阶段计时及准备失败计数。固定 SQL wire 计划复用由三条扩展到八条，默认 `off`、显式 `native`；SQL、参数与每次真实数据库读取保持，关闭时隐藏能力，错误不重放，不缓存授权数据。日志与指标不记录密钥、请求正文或错误原文。 |
| 调度读取与池权限 | 同一 RR 解析只复用成功且精确匹配 ID/version 的池权限行，不缓存拒绝或跨请求数据。scheduler 的无锁 READ COMMITTED 纯 SELECT 去除事务外壳，SQL、顺序、候选路由重读和时钟检查保持；每条剩余 SELECT 各取连接，池等待取舍尚待实测。 |
| HTTP 入口背压 | 核心监听器增加可选 `maxHttpInFlight` 与环境转发，默认关闭。独立计数只覆盖 HTTP 推理 handler；满载在认证/数据库工作前返回固定容量 429，原 Promise 完成后释放名额，关闭等待顺序不变。非法环境值仍先拒绝启动；typed 配置仅覆盖有效 env。异步图片 202 后后台派发与 WS 不计入该 HTTP 名额。 |
| 发布包边界 | 新增 `deploy/.npmignore` 排除本机操作环境、恢复密钥及本地凭据注册文件；真实 `npm pack --dry-run --ignore-scripts` 文件清单确认排除本机 `remote-server.env`，保留部署与备份示例。没有生成或发布 npm 包。 |

内置用量边界还会在准备前拒绝服务端工具、未知工具类型和根层 MCP 服务配置；本地函数的 schema、参数与结果数据不按远程工具声明处理。该检查没有改变已签名的 token 上限和价格。

### 16.2 分次执行证据与历史阻断

- 真实 Kimi V2 工具矩阵：5 tests / 5 pass / 0 fail / 0 skipped，覆盖 JSON/SSE 各自的自动与强制两轮工具，共 8 次推理调用；使用只有工具结果才能给出答案的 opaque lookup，未保存思考正文或签名。
- 标准发布包 `dist/cli/index.js`、`builtin`、独立受限 PG18 角色：真实 CP 导入后，凭据 worker 一次探针达到账号/凭据 `active/verified`；首笔真实非流式请求、重复提交与内容冲突最小验收 3 tests / 3 pass / 0 skipped。请求达到 `succeeded/settled`，原始新输入 0、缓存读取 25、缓存创建 0、输出 11，持久总输入 25，扣款及平衡账本均为夹具价格的 83 个最小货币单位；租约为零，重复提交及 409 内容冲突均无新增资金或派发效果。
- 此前 HTTP 200 后 `unknown / usage_missing` 的实际原因是额外的两个基线元数据字段触发了拒绝，四个原生计数并未缺失。直接原生对照确认相同字段和值，未保存正文或思考签名；限定兼容规则的定向合同验证 316 tests / 315 pass / 0 fail / 1 既有可选 PG skip。隔离 PG18 缓存用量证明另为 9/9；真实收费请求现已完成上行用量、账单、钱包与账本闭环。
- 计划复用前的完整真实 Kimi 商业矩阵 **7 tests / 7 pass / 0 fail / 0 skipped**：一次探针完成自动验证，原生 JSON/SSE、OpenAI 自动/强制各两轮共 6 笔完成请求均达到 `succeeded/settled`，用量、价格版本、钱包扣款及平衡账本逐笔一致，合计为夹具价格的 2772 个最小货币单位。取消发生在收到实际 SSE 帧之后，结果为 `unknown/reconciliation_pending`、零用量/结算事件、保留原始 hold；重复请求返回 202 且无新增派发或资金效果。共预期 8 次供应商调用（探针 1、完成业务 6、中断业务 1）；707 个作用域文件零漂移，全部自建 CLI/PG 进程已清理。见 [脱敏真实验收记录](validation/implementation-2026-10-22/kimi-commercial-full.json)。
- 上述计划复用前的重跑为 `j1v42R`。此前一次观察停在已结算但 finally 尚未释放租约的合法间隙；已修正验收观察器：先逐项校验身份、用量、账务和账本，只有合法正整数 held lease 在原有期限内等待，最终必须为零。unknown、账务错误和非法计数仍立即失败。7/7 观察器回归通过，未修改生产释放顺序、超时或供应商重试。
- 三条固定计划接入后的标准 CLI/builtin 真实 Kimi 重跑 `AT7u1L` 显式使用 `native`：**7/7、零跳过**，自动接入及上述 JSON/SSE、自动/强制两轮工具、取消/重复提交矩阵再次通过。6 笔完成请求合计 2772 个夹具最小货币单位，最终租约为零；中断请求保留 263680 的 hold、用量及结算事件为零，重放仍为 202。708 个作用域文件及独立校验的全部 2992 个 dist 文件在运行前后与记录创建时一致；自建 CLI/PG 全部停止并清理。仍只有一个真实凭据、局部签署 rights、夹具价格及 pilot 软件 KMS。见 [native 真实收费链记录](validation/implementation-2026-10-22/kimi-commercial-native-prepared.json)。
- 围栏批量化与七处 transport 测点进入当前构建后，真实 Kimi `saqACI / native` 再次 **7/7、零跳过**：自动接入、JSON/SSE、自动/强制工具两轮及取消/重复提交全部通过，6 笔完成请求仍合计 2772 个夹具最小货币单位、最终租约零；中断请求的 263680 hold、零用量/结算事件和 202 重放保持。708 个运行作用域文件与全部 2992 个 dist 文件前后及记录创建时一致；前一轮 R9 的 749 个完整生产源码摘要也独立匹配。全部自建 CLI/PG 已清理。这是钱包锁序修复前该构建的真实业务验收，不代替 R9；一个凭据、夹具价格、局部 rights 和 pilot 软件 KMS 的限制继续保留。见 [当前真实商业链](validation/implementation-2026-10-22/kimi-commercial-current.json)。
- 钱包锁序修复并重建后的标准 CLI/builtin 真实 Kimi `EsQe2K / native` **7/7、零跳过**：自动接入、JSON/SSE、自动及强制工具完整两轮、取消与重复提交再次通过。6 笔完成请求合计 2772 个夹具最小货币单位、最终租约零；中断请求保持 unknown、263680 hold、零用量/结算事件及 202 重放。此轮独立捕获全部 **749 个 src 与 2992 个 dist**，前后及记录创建时均无漂移，另有 708 文件导入作用域捕获；自建 CLI/PG 全部清理。一个真实凭据、局部 rights、夹具价格及 pilot 软件 KMS 的限制保留，不替代压力或生产验收。见 [钱包修复后的真实收费链](validation/implementation-2026-10-22/kimi-commercial-wallet-order.json)。
- 健康时钟与最终容量分类进入重建产物后，标准 CLI/builtin 真实 Kimi `hr5WLq / native` **7/7、零跳过**：自动接入、JSON/SSE、自动及强制工具两轮、取消与重放再次通过。6 笔完成请求按实际 receipt 求和为 **2772** 个夹具最小货币单位，六笔 terminal receipt 的 lease 均为零；中断保留 **263680** hold、零用量/结算事件及 202 重放，其中 abort lease 归零来自通过的现场断言，不伪造独立 terminal receipt。完整 **src 749 / dist 2992** 及导入闭包前后和记录创建时一致，全部自建资源已清理；仍是单一真实凭据、局部 rights、夹具价格与 pilot 软件 KMS，不代表全供应商、R9 或正式 CI。见 [健康与容量修复后的真实收费链](validation/implementation-2026-10-22/kimi-commercial-health-capacity.json)。
- 真实 Kimi quota worker：标准构建 CLI 从持久化加密凭据自动验证，随后真实 GET `/coding/v1/usages`，初始空快照变为有效五小时 9%、周 71% 窗口；受限控制面读取验证 failure/rate-limit 均为零，首次成功后关闭自有 worker。**1/1、零跳过、685 个作用域文件零漂移**。该 custom runner 未捕获全部 dist 文件哈希，记录明确保留此限制。见 [quota worker 记录](validation/implementation-2026-10-22/kimi-quota-worker.json)。
- OpenAI 工具商业链先后暴露并修复三个真实问题：原生 capability 被当作客户端协议匹配、HTTP bridge 依赖未持久化别名、客户价格协议被拿去与原生协议比较。调度修复通过 193/193 定向检查及受限 PG18 3/3；计价修复通过 37/37 定向检查及新增 PG18 11/11。后一真库证明经过实际 HTTP transport 的原生观察器，输入缓存 186、输出 62 结算 558；显式错误客户协议在写账前拒绝，完整资金快照不变。真实工具矩阵现已在修复后的标准 CLI 上通过。
- 原准备失败由内部计数定位为 `admission / storage_failure`，隔离 PG18 已证明是独立缓存上限被误作实际分配相加。现已显式区分证据类型，并修正容量层的同类 TTL 校验，保留全部上限和旧分配校验。实际 PG18 9 tests / 9 pass / 0 skipped：预留 262240、模拟上游用量 5/1 结算 13、重复结算无额外效果，以及 7 个非法边界的完整回滚。该证明没有真实供应商调用，不能替代前述真实 Kimi 的结算验收。
- 可售投影、模型列表/广场、count_tokens 与相关运行时定向验证：114 tests / 114 pass / 0 fail / 0 skipped。
- 价格共享围栏、不可变提示、dispatch 及组合根：75 个定向测试和 17 个 PG18 检查通过。计划复用前的 PG15.19/PG18.6 本地矩阵 **104/104、零跳过**，各版本 52：commercial 27、composite 1、Kimi 诊断 11、原生调度 6、attempt clock 3、CP clock 4。10 份摘要均零源码漂移，配对源摘要一致，自有数据库/容器清理完成。CI wiring 11/11 及两条 workflow 原样 strict TSC 命令在本地通过；不作为 GitHub required CI capture。见 [双版本矩阵](validation/implementation-2026-10-22/postgres-matrix.json)。
- 钱包锁序修复前的 production 与测试闭包执行 PG18.6 → PG15.19 的八根顺序矩阵：各版本 **76/76**、总计 **152/152**，零失败、零跳过、零取消；在原 52 项之外加入 prepared 10 项及 fence root 的 14 项原生 TAP 计数（1 个纯 TTL、12 个 PG 子项及父项）。每根均清理后才启动下一根；8 个自建 PG 集群与 8 个独占容器及其目录/精确 ID 已确认不存在。3762 个去重文件的 before/after/current 摘要相同，包含 src 749、dist 2992 与 697 个 literal closure 文件；dist 在此仅作摘要审计，测试运行源码，不称 built CLI 验收。runner 清理环境并默认 off；prepared 根内部的 native-auto 与测试专用事务局部 forced-generic 另列，三个 SQL 名称、实际 Bind/Execute、新鲜时钟、撤权/窗口/策略拒绝与资金不变均通过。后来仅改的三个样本 harness/test 路径不在该 PG 导入闭包。旧 104 项记录保留，本轮仍为本地门禁，不冒充正式 CI 或全仓冻结。见 [当前双版本矩阵](validation/implementation-2026-10-22/postgres-current-matrix.json)。
- 钱包锁序修复后的 PG18.6 → PG15.19 真库验证，各版本 HTTP 商业根 **27/27**、补偿根 **14/14**，总计 **82/82、零跳过**；691 文件的导入闭包 before/after/current 与双版本摘要一致，自建集群、pgdata 和精确容器 ID 均已清理。真实 A 结算 12（钱包 100→88、两条 ledger、一次 usage/settlement），B 的新补偿事务被第三连接证实等待 canonical wallet fence，随后双方完成且重放无额外效果；两个仅测试的 missing-first-fence + FU/NOKU 变体分别触发实际 40P01，不能称旧整份生产源码重跑。真实第一笔 ledger INSERT 后注入故障，完整资金/状态回滚及 55000/42501 禁写断言通过。新增夹具的 UUID/text、中性 media 签名及公开 CAS/账务错误 matcher 首红均保留，精确修正未修改生产授权、超时、拒绝或回滚条件。此为源码根功能验证，沿用原 functional gate 的 fsync/synchronous_commit off，不作性能或崩溃持久性证明。见 [钱包锁序真库证明](validation/implementation-2026-10-22/wallet-compensation-lock-order-postgres.json)。
- 三条固定 SQL 的独立 PG18.6/PG15.19 检查各 **10/10、零跳过**：默认关闭无 prepared 能力，native-auto 真实 wire Bind/Execute 与匿名结果一致、数据库时钟新鲜；单独的事务局部 forced-generic 检查证明暖计划后的撤权、epoch、授权窗口与策略写入围栏仍拒绝失效身份，资金摘要不变，始终只有三个固定名称。首次失败来自新夹具误用 control-plane 写商业 policy 的 42501，仅将两条测试 writer 恢复既有 migrator/service 方式，未修改生产权限或拒绝断言。新增 root 已接入 PG15/18 required selector/matrix 与 strict roots，离线 wiring **12/12**、两条 workflow strict 命令通过；尚无正式 CI 执行。两次真库运行的 686 文件前后摘要一致，后续 transport 计时改动另行记录，不称当前全闭包未变。见 [prepared 真库记录](validation/implementation-2026-10-22/prepared-statements-postgres.json)。
- 运营真实浏览器：标准控制面 CLI、当前 web-dist、真实密码/TOTP 登录、headless Chrome 执行 React，**1/1、零跳过、686 个作用域文件零漂移**。summary/diagnostics/backups 实际 200；媒体重排有 PG 审计与 epoch 回执，陈旧 epoch 409，只读用户 403，attempted-only 保持 stale、成功观测显示 fresh，凭据重新验证真实排队。此次止于排队，backup 显示未配置，无实际备份或供应商调用。见 [浏览器记录](validation/implementation-2026-10-22/operations-browser.json)。
- 原生 PG18 备份/恢复 **1/1**、相关定向 **49/49**；118 个迁移、147 张表，实际 dump/restore、指纹相等、损坏拒绝与清理均通过。12 个备份相关源码/dist 关键模块在保存记录时与该运行一致；1596 文件的零漂移只属于原运行作用域。S3/KMS 为协议替身，生产云 PITR/异地/密钥恢复未验收。见 [备份恢复记录](validation/implementation-2026-10-22/backup-restore.json)。
- 样本/scaling harness 与钱包锁序增量之前，固定计划、transport 测点与围栏批量化后的完整单元回归：**6600 tests / 6577 pass / 0 fail / 23 skipped**；完整集成回归：**340 tests / 255 pass / 0 fail / 85 skipped**。1643 个声明范围的源码/测试/配置文件在运行前后及记录创建时一致。源码 TSC、231 文件作用域 Biome（零错误、147 warnings、27 infos）、四份生成权限镜像和 diff 检查通过；既有生成文件格式差异单列排除，未计作全仓 lint 通过。实际 `npm pack --dry-run --ignore-scripts --json` 的 3163 个文件确认排除 `deploy/ops/remote-server.env` 及规则列出的部署环境/密钥文件，部署示例与 Compose 保留，未生成或发布包。未配置独立数据库或真实服务的可选项保留 skip，另行执行的正式角色真库门禁与真实 Kimi 不计作这些 skip 的通过。见 [回归记录](validation/implementation-2026-10-22/regression.json)。
- 样本/scaling harness 与钱包锁序修复后的完整回归：单元 **6631 tests / 6608 pass / 0 fail / 23 skipped**，集成 **341 tests / 255 pass / 0 fail / 86 skipped**；1646 个声明范围文件前后及记录创建时零漂移。源码 TSC、238 文件作用域 Biome（零错误、165 warnings、27 infos）、四份权限镜像与 diff 检查通过；同一既有生成格式差异单列排除，不称全仓 lint。实际 pack dry-run 为 3168 文件，部署环境/密钥模式及已知本地 remote env 均排除，未生成或发布包。可选原生服务跳过保持；另行完成的真库与真实 Kimi 不加进聚合总数，旧 6600/340 记录保留。见 [钱包修复后完整回归](validation/implementation-2026-10-22/regression-wallet-order.json)。
- 健康时钟与最终容量分类修复后的完整回归：单元 **6707 tests / 6684 pass / 0 fail / 23 skipped**，集成 **343 tests / 255 pass / 0 fail / 88 skipped**；1649 个声明范围文件前后及记录创建时一致。源码 TSC、四份权限镜像、diff 检查与 244 文件作用域 Biome（257 selected、零错误、165 warnings、27 infos）通过；唯一既有生成格式差异仍单列排除，不称全仓 lint。实际 pack dry-run 为 **3174** 文件，规则列出的本地环境/密钥材料与已知 remote env 均排除、示例及 Compose 保留；比前次多出的六项均为脱敏 validation JSON。该数字只属于本次清单捕获，后续记录新增不视作未来包冻结；未生成或发布包。旧聚合、定向、真库与真实模型计数继续分开。见 [健康与容量修复后完整回归](validation/implementation-2026-10-22/regression-health-capacity.json)。
- 固定 authority 批量读取的独立 PG18 验证 7/7，覆盖两个撤权围栏方向、已提交撤权拒绝、CAS 审计一次及资金/容量不变。60 组交错样本中，平台 preflight SQL 37→19、claim 40→22，中位数分别 4.94→3.68 ms、6.25→5.01 ms；claim p99 有噪声，不据此宣称 R9 尾延迟通过。
- 后续只合并 shared advisory fence 往返、保留原层序/层内排序及跨层重复：当前 PG18 `R9tLIc` **14/14、零跳过**，preflight **19→8**、claim **22→11** 条 SQL，与上一轮 authority 合并的 37/40 基线分开。真库确认中间锁阻塞时只取得前缀、取消后回滚且不读 authority、签名 deadline 在等锁期间到期后被真实 DB 时钟拒绝，以及双向撤权、一次 claim/audit 与资金/容量不变；1358 个范围文件前后一致，停止确认后删除自建 pgdata。首轮 5 pass / 9 fail 的红例来自夹具捕获了 seed 的三个事务及目标注册，已按实际 INSERT 返回的 evidence ID 精确关联目标事务，仍要求恰好一批锁，未修改生产、权限或拒绝条件。此记录不声明延迟收益。见 [有序围栏真库记录](validation/implementation-2026-10-22/evidence-fence-batch-postgres.json)。
- 包含批量读取与授权时钟修复的当前构建 R9 短诊断 `pyXyYD`：并发 4、125 个 HTTP 200、零错误、24.41 rps；p99 网关开销 124.92 ms、TTFB 开销 166.96 ms，**FAIL**。latency/TTFB 各 10 个完整样本，不据小样本前后差值宣称优化幅度。见 [短诊断](validation/implementation-2026-10-22/r9-postbatch-short.json)。
- 为拆分热点，新增显式 `--diagnostic --serial-profile`，保留完整 R9 默认行为和 30/10 ms 门槛。计划复用前的 `fuRdFJ` 使用三份标准 CLI、各 100 个 latency/TTFB 完整样本、预热并发 1、无并发场景；普通响应 direct/gateway p99 8.15/201.26 ms，开销 **193.11 ms**；TTFB direct/gateway p99 16.15/150.11 ms，开销 **133.96 ms**，零错误，仍为 **FAIL**。748 个 src、2988 个 dist 和 5 个 harness 文件均无漂移，三份 metrics 为 200，自建资源已清理。此次只有计时改动，不将它与此前 `RB46dx` 的 201.39/202.20 ms 差值称为性能改进。客户端串行不保证响应后的结算绝不与下次请求重叠。见 [串行诊断](validation/implementation-2026-10-22/r9-current-serial-profile.json)。
- 新增 `scheduler-select`、`affinity-bind`、`evidence-register`、`preparation-total` 四个固定标签测点；定向 60/60、源码与四测试 strict TSC、8 文件 Biome 通过。该轮累计 242 次观测（含预热和 smoke）中完整 preparation 均值 **101.22 ms**，scheduler-select **52.26 ms**，evidence-register **6.33 ms**，affinity-bind **1.99 ms**；原 authority/admission/capacity 子段分别 17.65/16.28/2.08 ms，dispatch **42.61 ms**。total 已包含各子段，不能再次相加，也不能用阶段均值减请求 p99 来归因。scheduler 每次 OpenAI 请求检查 4 个候选，实际逐查询耗时仍待拆分。
- 先前两类 authority SQL 的命名计划微实验中位数仅约 1.24→0.42 ms，claim 某组 p99 反而变慢。最终 dispatchable 视图另做 60 组交错实际 SELECT：原 SQL/四参数/每次返回行摘要完全一致，unnamed 均值 **8.202 ms**，named **0.290 ms**；服务器 wire prepared statement 的 generic plan 计数增加 60、custom 增加 0，未设置 planner 参数或缓存业务行。该微实验先于三条固定 SQL 实现，不作为完整 R9 通过。见 [wire 计划实验](validation/implementation-2026-10-22/dispatchable-wire-plans.json)。
- 最终视图的独立真 PG18 EXPLAIN 已完成：同一受限 gateway session、原共享围栏、RR READ ONLY，8 次预热后 30 次原 SELECT，wall 均值 **8.613 ms**，其中 planning **7.635 ms**、execution **0.083 ms**；其余 0.895 ms 未归因。该 fixture 下规划占主导，仍不能直接外推到全量目录或完整 R9。原 SQL、参数身份、schema/GUC 与 748 个源码摘要均已保存，前后无漂移，最终 ROLLBACK，自建 PG 已删除。见 [规划与执行诊断](validation/implementation-2026-10-22/dispatchable-explain.json)。
- 调度器原查询的独立真 PG18 诊断进一步定位到平台 eligibility：经实际公开 `select` 捕获 14,331 字节 SQL 与 22 个绑定值，30 次 EXPLAIN 均值 wall **11.738 ms**、planning **9.336 ms**、execution **0.280 ms**；60 组交错实际 SELECT 中 unnamed/named 均值 **10.762/0.514 ms**，两种模式的 non-clock 事实逐次一致，真实 `authority_now` 原样交回服务并通过同 session DB-clock 前后界检查。4 表 route 查询仅 **0.520/0.187 ms**。两个 wire 名称各增加 60 次 generic、0 次 custom；879 个 READ COMMITTED READ ONLY 事务全部 ROLLBACK，零 advisory 语句，源码前后无漂移，自建 PG 已删除。见 [调度 SQL 诊断](validation/implementation-2026-10-22/scheduler-query-planning.json)。据此实施默认关闭、显式 native 开启的三个固定 SQL 计划复用；尚未记作端到端性能通过。
- 三条固定 SQL 的同构建串行对照：`off / 1u9Cfz` 与 `native / 5bjmUe` 各完成 100 个 latency、100 个 TTFB 样本、零错误，749 个 src、2992 个 dist、5 个 harness 的前后摘要和两组之间摘要均一致，metrics 均为 200，清理完成。观测到 preparation 均值 **110.43→51.08 ms**、scheduler **53.66→11.34 ms**、authority **18.46→10.16 ms**；阶段均值包含不同数量的预热与 smoke，不能用来扣减请求 p99。延迟开销 **264.34→129.83 ms**，TTFB 开销 **197.51→114.06 ms**，两组均未通过原 30/10 ms 门槛。其余 native preparation 热点为 admission 15.16 ms、evidence-register 6.17 ms；transport-send 为 10.12 ms。该对照尚不覆盖 c200、扩容或十分钟 SSE，也不代表默认关闭模式已有改善。见 [off 记录](validation/implementation-2026-10-22/r9-prepared-off-serial.json)、[native 记录](validation/implementation-2026-10-22/r9-prepared-native-serial.json)。
- 重建围栏批量化与七处 transport 测点后的 `qZYFoG / native` 仍为 **FAIL**：100 个 latency 与 100 个 TTFB 完整样本、零错误；延迟 direct/gateway p99 **7.05/128.44 ms**、开销 **121.39 ms**，TTFB **7.89/267.99 ms**、开销 **260.10 ms**。749 个 src、2992 个 dist、5 个 harness 前后无漂移，metrics 均 200，清理完成。253 次观测（含 warmup/smoke）中，preparation 55.14 ms、evidence-register 5.29 ms，preflight/claim 3.78/5.63 ms；这些均值不能归因客户端尾部变化。transport-send 10.88 ms，其中凭据准备 **6.29 ms**、fetch 到响应头 **3.67 ms**、profile **0.41 ms**、connector **0.03 ms**、固定 headers **0.01 ms**，未细分部分 **0.48 ms**。条件分支未发生不发零样本，所有子段按同一 send count 归一且不重复加进 dispatch；fetch 包含连接、发送和等待上游响应头，不能称作 TLS 耗时。该记录使用通用 mock runtime，不能外推到 Kimi 专用 transport。见 [分段诊断](validation/implementation-2026-10-22/r9-fence-batch-transport-serial.json)。
- 新增默认关闭的 `--request-samples`，仅允许原 `--diagnostic --serial-profile` 的 100/100、预热并发 1、三份 CLI 和原阈值配置，参数在创建资源前校验。13/13 不连数据库的定向测试、严格 TSC、Biome 与两份脚本语法检查通过，独立只读审查修复了前后 UUID predicate 不一致。完整 6600/340 回归发生于此纯 harness 增量之前，新增 13 项不加进旧聚合总数。实际 `dMPmPT / native` 采集四腿各 100、共 400 条 measured 样本，网关 200 个唯一有效 UUID 精确对应 200 行状态，零缺失/非法/重复/截断/待完成或多 attempt/evidence；全部达到 `succeeded/settled`。样本只含脱敏白名单、非法 header 不落盘；数据库读取在所有计时及 metrics 结束后执行固定参数化只读查询，201 sentinel 明示上限，新文件 wx/0600。延迟 direct/gateway p99 **6.00/118.58 ms**、开销 **112.58 ms**，TTFB **6.26/90.16 ms**、开销 **83.90 ms**，零错误，原 **30/10 ms** 门槛仍 **FAIL**；n=100 的既有 floor(n×p) 算法令 p99 等于最大样本，direct/gateway 是独立样本集合。749 个 src、2992 个 dist、5 个 harness 前后无漂移，三份 metrics 200、自建资源全部清理；本次启用观测有开销，不能将与旧轮次的差值称为优化收益。268 次累计观测（含预热/smoke）中 preparation 48.53 ms、scheduler 11.14 ms、authority 9.85 ms、admission 14.77 ms（包含 guard 7.85 ms），dispatch 38.94 ms；仍不能把这些均值归因到单一慢请求。
- 关联核查同时确认现有七个状态时间不是阶段 trace：`evidence_created_at=DEFAULT now()` 是共享准备事务的开始时间，显式应用 Date 写入的 request/attempt created 可更晚；`evidence_claimed_at` 是 claim UPDATE 的 PG 钟采样且尚未 audit/COMMIT；正常 `response_started_at` 在完整 delivery 后才写入并受旧值 clamp，**不是 first byte/TTFB**；request updated 又是最后覆盖的应用钟。记录保留选中的 p50/p90/p99 请求与上述来源，未把混合钟负差值、client 与 DB 残差当成 CPU、网络、DB 等独立阶段。未捕获创建前区段或 COMMIT，累计 metrics 也不能关联单请求尾部；下一步继续定位串行 SQL，保持当前阈值、资金和撤权围栏。见 [请求样本与状态关联](validation/implementation-2026-10-22/r9-request-samples-serial.json)。
- 首次完整工作负载尝试 `J7tbUH / native` 在第一份单 CLI、c200、120 秒扩容基线即出现实际失败：121.6 秒收到 899 次 200、5200 次 429、365 次 502、4600 次 503，成功吞吐 **7.39 rps**；仅成功响应的 p99 为 13842.88 ms，不能拿它代表全部请求。该轮 PG 日志共 **104 次 deadlock detected**，首环明确 wallet `FOR UPDATE`→wallet advisory 与持 advisory 的 ledger INSERT/FK→wallet 行锁反序；这些日志与 HTTP 计数没有逐请求对应关系，清理前未采集失败请求的资金状态，连 HTTP 200 也不能替代持久结算证明。确认自有 supervisor PID/命令/cwd 后主动停止后续负载，src 749、dist 2992、harness 5 前后零漂移，自建 CLI/PG/runtime 均已清理；该次为**中止的完整工作负载尝试**，不称完整 R9、扩容或十分钟 SSE 通过。见 [c200 首个失败](validation/implementation-2026-10-22/r9-c200-first-failure.json)。
- 首红还暴露 scaling 门禁漏报：基线有 4965 次 5xx，旧 driver 仍是 exit 0 / 零 violations，supervisor 仅见正成功流量便接受。现 scaling 复用既有 concurrency 的 transport/5xx 预算（默认均零），保留 429/其他 4xx 计数及原策略，不另造失败率阈值；双方 scaling 证据失败或畸形时 ratio 为 null、带固定原因与违例，原 **2.7×**、30/10 ms、百分位算法与计时不变。supervisor 另行复核计数，失败 baseline 不启动后续 all，失败 all 不启动下一协议，但继续收集 stats/metrics 并清理。**27/27** 不连数据库的定向测试（14 个新增门禁、原 13 个样本）、严格 TSC、Biome、语法和 diff 检查通过；修复后的真实 c200 重跑已被正确判为失败并停止后续负载，见下一条记录。

- 钱包锁序修复后的完整工作负载尝试 `ybVPfY / native` 在首个单 CLI、c200 扩容基线被新门禁正确拒绝：**124.3 秒、2437 次 200、2167 次 502、4417 次 503，19.60 rps**；成功响应的 p99 为 **5730.84 ms**。此轮 PG **零 deadlock**，仅 3 条 runtime-health stale 更新错误，不能将它们直接解释为全部 6584 次 5xx。累计 preparation error 4417（scheduler-select 4266、affinity-bind 151）；preflight/lease-acquire 各 4606、claim 2439，阶段差额尚不是逐请求原因证明。driver exit 1，supervisor 独立计数校验失败后未启动三 CLI/其他协议/十分钟 SSE，仍收集三份 200 metrics 并清理全部资源；src 749、dist 2992、harness 5 前后及记录创建时无漂移。未采失败请求最终资金行，HTTP 200 也不等于已持久结算；此轮不作完整 R9、有效扩容或性能收益声明。见 [钱包修复后 c200 首阻断](validation/implementation-2026-10-22/r9-wallet-order-c200-failure.json)。
- 同一旧构建的私有 c200 原因诊断仅执行第一协议的 30 秒单 CLI 基线：实际 **32.6 秒、641 次 200、505 次 502、948 次 503，19.65 rps**，门禁仍失败。闭集观测将 505 个 502 对应到最终派发租约的严格 null；948 个 503 分为 852 次 health malformed 的 select block 和 96 次原因尚未细分的 affinity bind block。852 次均读取唯一健康行且日期有效，`observed_at` 超过旧 selection 起点 250ms，却不超过查询返回后的主机时钟 250ms，确认请求起点参与了错误的新鲜度判断。runtime 在 flush 时仍有 12 个活动调用，因此该部分是明确的部分计数，**全局 observationOk=false**，不能把 631 次 sent 当作最终总数。停止 CLI 后独立只读资金快照则完整确认 505 笔 failed/released/not_sent、643 笔 succeeded/settled（含两笔 smoke），钱包/账本及夹具注资一致、hold 和 pending 均为零。完整 src/dist、canonical harness 与十个私有文件前后无漂移，自建资源已清理；观测有开销，此轮不是 R9 或性能收益证明。见 [原因诊断](validation/implementation-2026-10-22/r9-c200-cause-diagnostic.json)。
- 新的健康写入锁序回归先对旧实现执行 PG18：**7 tests / 4 pass / 3 fail / 0 skipped**（两条正例及父项失败）。第三连接均确认较高 token 的 writer 正在等待健康行锁；较低 token 的 writer 写入并提交后，等待者实际返回 `STORAGE_ERROR / 55000`，而正例要求 `applied`。四条未来持久时间、时间倒退、旧 token 和 revision 负例通过。随后仅将冲突更新的 observed/cooldown 两列改为相关 SET 子查询、共享一次锁后 DB 采时，保留 INSERT、原冷却曲线、token/revision/EMA、040 和失败 latch。冻结的同组测试在 **PG18.6 与 PG15.19 各 7/7，总计 14/14、零跳过**；两条正例恢复 applied，四条负例继续拒绝。两个测试文件及 040 逐字节未变；757 个声明输入（完整 src 749 加 8 个显式文件）和各 683 文件的导入闭包前后及记录创建时一致，全部自建集群、pgdata 与精确容器 ID 均已清理。原始首红保留，不称全仓单变量 A/B 或 built/R9 证明。另有 health callback 的独立 **312/312** 单测：store、HalfOpen、core 在各自异步健康读取后重新取同一主机时钟，严格缺省才兼容旧 Date，保留 250ms、maxAge、cooldown；probe applied 并释放 lease 后真实重读一次，不合成 healthy。两条 workflow strict 的检查时点与后续测试观察器变动分开记录。见 [健康时钟真库与定向证明](validation/implementation-2026-10-22/runtime-health-clock-postgres.json)。
- 最终容量分类在 PG18.6 与 PG15.19 均通过同库完整 HTTP bootstrap **27/27** 后，再通过新增 capacity **3/3**（BYOK、平台两个子项及父项），总计 **60/60、零跳过**，其中新增容量项为 6、前置 socket HTTP 为 54。新容量项使用真实受限 PG 和生产 handler，请求/响应为 Readable/CapacityResponse doubles，不称新增 socket 429 验收。真实 A 占满 max1 后，B 恰好 preflight/acquire 各一次、claim/send 为零、补偿一次并返回 429；B 的 quota/rate/hold、wallet/ledger、幂等重放及迟到 claim/CAS 拒绝通过，A 的既有 lease/token 不变直至 finally 释放，不声称补偿了 A 的原预留。首次 bootstrap 首红是旧 raw-service introspection 合同；改为精确 adapter 形状、真实 raw PG 类和单次委托 input/lease/error 同一性断言后恢复。第二次首红是新夹具误将 lease 的 text attempt ID 绑定为 uuid，仅改一个参数 cast，反向替换可逐字节恢复旧 root SHA，资金/拒绝断言未变。689 文件的闭包 before/after/current 及双版本摘要一致，自建数据库、目录与精确容器 ID 均已清理；功能门禁使用原 fsync/synchronous_commit off，不作性能或崩溃持久性证明。见 [容量分类与补偿真库证明](validation/implementation-2026-10-22/dispatch-capacity-postgres.json)。


- 健康与容量修复后的当前构建完整工作负载尝试 `W3cVkr / native` 已执行第一协议 OpenAI 的全部场景。单 CLI c200 扩容基线 **121.6 秒、1664 次 200、3536 次 429、零 5xx/transport error，13.69 rps**，门禁通过。三 CLI 的 latency 各 300、TTFB 各 100 个样本齐全，开销仍为 **160.71/229.72 ms**，超过原 30/10 ms 门槛。十分钟 SSE 以并发 20 重复完成 **13260 条短流、848640 个数据块，损坏均为零**；这不等于单个连接持续十分钟。随后 c200 普通并发出现 **783 次 200、659 次 429、14 次 503**，精度场景 **720/805/9**，未发现账号超发；扩容场景实际 **127 秒、1608/1019/77、12.66 rps**。三场景共 100 个 503、未出现 502；扩容报告按错误预算返回 `ratio=null / current_report_failed`，不能用成功吞吐相除声称扩容达标。全部五条 violation 保留，supervisor 未继续第二协议的完整负载，该协议仅 smoke 通过。PG 日志中 ERROR 与 deadlock 均为零，不排除等锁或客户端存储失败。749 个 src、2992 个 dist、5 个 harness 前后无漂移，三份 metrics 均 200，自建进程、PG 和 runtime 已清理。本轮没有负载请求的最终资金/状态快照，HTTP 200 不能替代结算证明；这是本地 mock 组合的失败尝试，不是真实供应商或完整 R9 通过。见 [健康与容量修复后的完整负载尝试](validation/implementation-2026-10-22/r9-health-capacity-full-attempt.json)。

- 当前 commercial observer 与 capacity 夹具修正后，重新执行两条 workflow 中原样 strict TSC 命令，均 exit 0；同一 CI wiring 根实际 **14/14、零失败/跳过/取消**。55 个声明 workflow、测试和配置输入前后摘要一致。此次没有数据库、构建、供应商或性能负载；不冒充 GitHub required CI 或全仓冻结。见 [当前 CI 接线与 strict 记录](validation/implementation-2026-10-22/ci-wiring-health-capacity.json)。

三份 metrics 的 `affinity-bind/error` 与 `preparation-total/error` 累计均为 101，负载报告的 503 则为 100；两者没有逐请求关联，保留群体差异，不将累计计数相等或相近当成单次失败原因。只读输入追踪另确认：标准装配启用 sticky scheduling，固定 key、客户端 IP/UA、模型及首条用户内容会导出同一 fallback reference，驱动未显式提供独立会话；这构成并发 resolve→bind 竞争机会，尚不是本轮失败的原因证明。

- 后续独立 PG18 准入查询观测 **1/1、零跳过**：沿用实际公共 guard、受限 gateway 角色、原 READ COMMITTED 读写事务及围栏，在新 request/attempt 插入后捕获原 **10570 字节、59 个绑定、25 个 stage** 的 authority SQL。两次原 SELECT 预热、一次 EXPLAIN、最后一次原 SELECT 的完整事实摘要一致，最后一份结果交回 guard，完整 admission 创建后用 sentinel 回滚；15 张相关表的 20 条记录总摘要前后相同。单次 planning/execution 为 **1.063/0.475 ms**，最后一次原查询 wall **2.816 ms**；EXPLAIN 不传输 SELECT 结果行，不能据此解释 R9 p99 或新增第四个计划复用描述符。1384 个声明输入（完整 src 749、tests/saas 617、私有输入 8 及显式配置）前后及记录创建时一致，自建 PG 已删除。两次测试前的依赖解析/ESM loader 首红单独保留，只修私有工具装载；没有修改生产 SQL、断言、权限或超时。此功能夹具沿用 fsync/synchronous_commit off，不作持久性或端到端性能证明。见 [准入 SQL 规划与执行观测](validation/implementation-2026-10-22/admission-authority-query-plan.json)。
- 同一修复前构建的三 CLI、c200、30 秒私有 affinity 诊断实际 **38.5 秒、289 次 200、304 次 429、15 次 503、零 transport error**，原零 5xx 门禁继续失败。三个实际 affinity port 均精确匹配 Redis decorator，原 PG 事务的固定 SQL 合同确认 15 次 bind 拒绝均为 **active_other_account**：每次候选对象都与较早的一次 PG resolve 精确关联，该 resolve 返回 null 且未清除 stale，bind 则在原锁下读到另一个有效账号，尚未执行 bind-update。另有 3 次成功 stale invalidation，不能将它们逐次归因到这些 bind。三进程 wrapped 调用在 close/flush 时均为零，观测完整；完整 src/dist、canonical 5、private 13 和两份依赖文件前后及记录创建时一致，资源全部清理。HTTP 与 runtime 仍是独立群体，没有请求级关联。停止 CLI 后的完整只读资金聚合确认钱包与账本、夹具注资相符，但保留 **7 笔 pending、7 笔 reserved hold，合计 143360** 个夹具最小货币单位；不称全部已结算或已补偿。此轮有观测开销，不作 R9 或吞吐收益证明。见 [绑定竞争原因观测](validation/implementation-2026-10-22/affinity-bind-cause.json)。

- 绑定竞争修复的 12 个离线根 **436/436、零跳过**；两个真实 PG 竞态在 PG18.6、PG15.19 **各 2/2**，分别强制两个已提交 null resolve 后竞争，以及真实容量占满导致 stale 清除后再竞争。实际受限 gateway 完成原查询与围栏，落败写入的完整 timestamps/TTL/revision/fence 不变，唯一 winner 经过新鲜 eligibility/health/concurrency 后重绑一次；原 request/funds 聚合不变。Redis slot 仅为记账 double，不称真实 Redis、HTTP、admission 或供应商验收。首次 PG18 两项均因夹具使用 gateway 观察未授权的 created_at/updated_at 而返回 42501；只将完整观察快照改为现有 migrator，生产仍走两个独立受限 gateway 池，全部断言与原首红保留。新根已注册 PG15/18 隔离 CI 和 strict 目标；本地接线不冒充远端 CI。组合路径的 scheduler-select 包含绑定耗时，不能拿旧 affinity-bind 阶段缺席证明零错误。见 [绑定修复与双版本真库验证](validation/implementation-2026-10-22/affinity-binding-repair.json)。
- HTTP 关闭的独立离线真实 preparation/dispatch 红例确认：response.end 后 sent CAS 已完成，normal settlement 被 deferred 时，旧 close 已 fulfilled 并关闭 lifecycle，而 handler、结算和 lease release 仍 pending。新增仓库用例在旧源码为 **2 pass / 3 fail**；修复后新增 5 项及两项既有链合计 **7/7**，覆盖双并发、原 promise/error identity、false 返回及 close 错误缓存。仅两个文件变动，原首红与夹具装载首红保留；不据此逐条归因此前的 7 个 pending，也不声称 socket 或真库资金闭环已通过。见 [HTTP 关闭等待证明](validation/implementation-2026-10-22/http-shutdown-drain.json)。
- 两项修复合并后的完整离线回归：unit **6756 / 6733 pass / 23 skip**，integration **345 / 255 pass / 90 skip**，均零失败/取消；两个新增 PG 用例在此显式跳过，其实际双版本结果单列。源码 TSC、两条原 workflow strict 命令、CI wiring **14/14**、四份权限镜像、scoped Biome（249 文件，165 warnings / 27 infos / 0 errors）及 diff 检查通过。仅为一个既有 DOM 全局类型补上 Node stream/web 的 type-only import，保留 ES2023 strict 配置；随后 `build:server` 成功，真实供应商和负载结果另记。此次 source/config 声明输入前后及记录创建时一致，不将 docs/dist/忽略环境或未来改动纳入冻结。见 [合并后完整回归](validation/implementation-2026-10-22/regression-affinity-shutdown.json)。

- 当前组合绑定及 HTTP 关闭修复后的源码商业 HTTP 根在 PG18.6/PG15.19 **各 27/27、零跳过**，原根、资金/撤权断言、权限清单与超时均未修改。两份声明导入闭包前后及记录创建时相符，自建资源全部清理；功能夹具使用原 fsync/synchronous_commit off，与 native CLI、性能和供应商结果单列。见 [修复后双版本商业 HTTP 根](validation/implementation-2026-10-22/commercial-postgres-affinity-shutdown.json)。
- 相同修复进入重建产物后，标准 CLI/builtin 真实 Kimi `OSS208 / native` **7/7、零跳过**。六笔新 terminal receipt 的实际金额为 **83/83/558/709/630/709**，合计 **2772** 个夹具最小货币单位，12 笔 ledger entries 的 credit/debit 各 2772；六笔都观察到中间 lease=1、终态=0。完成重放 200、冲突 409、中断 unknown/零用量/零结算/263680 hold/202 重放保持；abort lease=0 仍来自现场通过的断言，没有独立 abort terminal receipt。完整 src 749、dist 2992、closure 708 在运行前后、投影创建区间及主代理复核时匹配，全部自建资源清理。一个实际凭据、局部 rights、夹具价格与 pilot 软件 KMS 的边界保留，没有独立 provider HTTP 总计数、audit-event 行或 tariff 行，不冒充正式 CI、性能或 GO。见 [修复后当前真实收费链](validation/implementation-2026-10-22/kimi-commercial-affinity-shutdown.json)。

- 当前重建产物的三 CLI OpenAI、c200、30 秒私有观测按原零 5xx/transport 预算通过：实际 33.5 秒，HTTP **200=686 / 429=794**，无 403、5xx 或传输错误。1481 个完整组合调用中 1457 个正常绑定一次，**24 个 typed contention 都只对原域内唯一 winner 新鲜复核并重绑一次**；最终返回账号等于最后成功绑定账号，flush 时 active=0、own-core wrapper 已恢复。独立关闭后资金快照为 **687 settled（含 smoke）/794 failed-released/0 pending/0 open holds**；settled、wallet debit、ledger 均 **76944** 个夹具最小货币单位，与原资金和余额相符。749 src、2992 dist、5 canonical、32 private 及 2 dependency 输入在本次前后相符，自建资源全部清理。运行时调用序列没有逐请求关联 HTTP，authority 子调用也没有分别 trace；有观测开销，不把旧新轮次差值称为吞吐或延迟收益，不称完整 R9 已通过。见 [修复后竞争与关闭资金验收](validation/implementation-2026-10-22/affinity-shutdown-c200-acceptance.json)。

- 修复后原规范完整 R9 在 2026-10-22T06:20:57Z 至 06:37:59Z 完成并清理，native、PG18 fsync/synchronous_commit on，749 src/2992 dist/5 harness 在运行前后及记录创建时匹配。单 CLI c200/120 秒基线 **200=2048 / 429=4352，零 5xx/传输错误，16.52 rps**；三 CLI 首个协议全部场景已执行。延迟/TTFB 开销 **102.16/87.52 ms**，超原 **30/10 ms**；十分钟重复短流 **17440 streams /1116160 chunks，零损坏**。并发、精度、扩容分别 **200=804/957/2099，429=1024/756/1025，503=1/1/10**，共 **12 个 503、零 502**；精度场景的一个 503 虽不在原 driver 的 precision violation 检查内，仍完整报告。扩容 ratio 保持 null/current_report_failed，不计算吞吐商来替代；Anthropic 只完成原 settled smoke，未运行第二个协议完整场景。三份 metrics 均 200，独立累计 authority/capability_unavailable 为 12，未与每个 HTTP 503 关联；PG ERROR/deadlock 均 0。完整负载没有最终资金快照，不将 200 当成结算证据；短负载的独立资金闭环另列。见 [修复后完整 R9 尝试](validation/implementation-2026-10-22/r9-affinity-shutdown-full-attempt.json)。
- readDispatchProof 的独立 PG18 public-method 单次观测 **1/1、零跳过**。原 identity、11 个实际有序 shared fences、join pin、core、reset、authority 共 16 个调用保持；只在 core 内做两次原 SELECT、一次 EXPLAIN、最后一次原 SELECT，并原样返回最后结果。三个 94 字段的完整 typed 摘要一致，单次 planning **1.663 ms**、execution **0.177 ms**、最后原查询 wall **2.800 ms**；19 个 plan 节点、根 shared hit 18/read 0。17 表/33 行读前后摘要一致，同一真实 lease 在两侧有效且 finally 按原 token 释放。1385 输入前后及记录时一致，自建 PG 清理；准备阶段 hold 留至自有库删除，不称回滚或全结算。完整 public wall 18.162 ms 包含额外 warmup/EXPLAIN/摘要，不能当未插桩耗时；此单样本没有证明它是 R9 尾部原因或需要新增 prepared descriptor。见 [派发凭证核心查询计划](validation/implementation-2026-10-22/dispatch-proof-core-query-plan.json)。

- 同一当前构建的原规范 serial profile（native、warmup inflight=1、每腿 100 样本）再次测得延迟开销 **105.23 ms**、TTFB 开销 **65.74 ms**，两项仍超原门槛，流错误为 0，自建资源全部清理。原累计 metrics 含 smoke/预热在内共 278 个 preparation/dispatch；均值分别为 preparation-total **42.260 ms**、authority resolve **9.095 ms**、combined scheduler-select **11.044 ms**、metering-guard-wallet **12.664 ms**（包含 guard **6.686 ms**）、capacity **1.697 ms**、evidence-register **4.114 ms**；transport-credential-prepare **5.182 ms** 属于 transport-send **8.761 ms**。保留 operation 标签和嵌套关系，不将这些均值相加后分配给某个尾请求；attempt-read/transition 各 556 次反映原链每次两调。749 src/2992 dist/5 harness 前后及记录创建时相符。原 floor(n×p) 算法在 n=100 时 p99 等于最大值，direct/gateway 样本独立；此轮不是完整 R9，也不证明某次优化收益。见 [当前原规范串行阶段观测](validation/implementation-2026-10-22/r9-affinity-shutdown-serial.json)。

- 原 c200/60 秒的当前构建定向观测实际 63.2 秒，**200=974 /403=2 /429=878 /503=1**，传输错误为 0，原零 5xx 门槛失败；三份 runtime observationOk 均真，active=0、方法描述符恢复、自建资源清理。1856 个 preparation（含 smoke）中，唯一 authority/capability_unavailable 的同进程调用已定位为 **scheduler 的 provider account affinity binding conflict**；initial authority allow、最后 collect collected、同操作未见 health deny、最后 core/store 健康和原时钟事实有效。它尚不能区分首次 bind 无有效 hint、第二次 bind 冲突或 PG 内部五类冲突，也不能追溯归因此前完整 R9 的 12 个 503。同轮还记录两次 account_denied 和两个 eligible=0/busy=1 collect，尚未逐操作连接这两组事实。独立关闭后快照为 **975 settled（含 smoke）/878 released/0 pending/0 open holds**，settlement、wallet debit、ledger 均 **109200** 个夹具最小货币单位。749 src/2992 dist/5 canonical/110 private/2 dependency 在前后及记录时匹配。首次私有执行因 copied driver 仍限定 30 秒而在负载前 exit 2，仅完成已结算 smoke；原 53 输入/旧 freeze 完整保留，实际修正仅私有 guard 和固定文案 30→60，再执行本轮。两条另外的离线最小红例确认：合法容量满的初选和 typed winner 新鲜复查当前都返回 account_denied，预期应为 rate_limited；生产未修改，不将这两个组件红例称为上述两次 HTTP 403 的逐项原因。见 [剩余绑定冲突与容量拒绝观测](validation/implementation-2026-10-22/affinity-residual-cause.json)。

- 进一步的同操作绑定观测按原 c200/60 秒执行，实际 65.1 秒，**200=1016 /429=1210 /503=5**，传输错误为 0；三份 observationOk 均真、原描述符恢复、资源清理。2232 个初选（含 smoke）中，2199 个一次绑定成功；33 个首次 typed active_binding 都重验了唯一 winner，28 个最终绑定成功，**5 个在第二次真实 PG bind 又遇 active_binding winner 变化**。五个 hint 都在原 input.candidates 内且未 attempted，均不同于第一次 winner；其中 1 个回到初选账号，4 个指向第三个原候选。原 callback 的六类 AffinityConflict 异常和 SQL/storage throw 均为 0，实际七条 SQL 全部原样委派，五个操作的健康/原时钟检查均有效。这只证明本次 5 个具体分支，不追溯旧完整 R9 的 12 个 503；本轮未再出现 account_denied，旧两次 403 仍不能逐项归因。独立资金快照 **1017 settled（含 smoke）/1210 released/0 pending/0 open holds**，wallet debit、settlement、ledger 均 **113904**。749 src/2992 dist/5 canonical/132 private/2 dependency 在运行前后和投影创建时一致。Redis release 仍是原 advisory best-effort/TTL 合同，这些观测没有证明每次释放获得网络 ACK；资金闭环与自有 Redis 停止分别记录。见 [剩余二次绑定竞争实证](validation/implementation-2026-10-22/affinity-residual-bind-proof.json)。

- 严格二次 typed 争用与满载分类已修复。先在未修改生产代码时固定首红 **292 tests /276 pass /16 fail**，最终两单元根 **295/295、零跳过**；字符串、零/负/小数/NaN/无限/不安全整数或空容量快照继续 block。健康拒绝保持优先，权限/window 排空不因限流而重新放行；任一显式 release 异常覆盖待返回的 429，且继续尝试其余 slot。新增三条真实 PG 容量/第三 actor 竞争用例，原两例与全部断言逐字节保留；PG18.6/15.19 **各 5/5**，686 项声明闭包前后及投影创建时匹配。全部生产容量来自实际 PG leases；Redis 为 bookkeeping double，migrator 仅 seed/完整状态观察；九表的准入前请求/资金断言保持。见 [分类修复与双版本竞争验收](validation/implementation-2026-10-22/contention-backpressure-repair.json)。
- 同一修复全量离线回归：unit **6780 /6757 pass /23 skip**，integration **348 /255 pass /93 skip**，零失败/取消；源码、两条原 ES2023 workflow strict、CI wiring **14/14**、权限镜像、scoped Biome 与 diff 检查通过。新增五项 PG 在 aggregate 显式跳过，真库结果单列；独立记录的 `build:server` exit 0，完整 src/config 构建前后未变。随后原商业 HTTP 根 PG18/15 **各 27/27、零跳过**，原角色/权限/资金/撤权断言和超时未改，资源全部清理。见 [完整回归与构建](validation/implementation-2026-10-22/regression-contention-backpressure.json)、[双版本商业 HTTP 根](validation/implementation-2026-10-22/commercial-postgres-contention-backpressure.json)。
- 修复进入当前产物后，标准 CLI/builtin 真实 Kimi `PBCBOU / native` **7/7、零跳过**。六份本轮 receipt 重新核算为 **83/83/558/709/630/709**，合计 **2772**，input/output **1134/168**；12 笔 ledger 的借贷各 2772，六笔 lease 均观察中间 1→终态 0。完成重放 200/冲突 409、中断 unknown/hold 263680/零用量和结算/202 重放保持；abort lease=0 仍只由现场断言证明。完整 src749/dist2992/closure708 在运行前后、投影区间及主代理复核时一致，资源清理；一个凭据、局部 rights、夹具价格、pilot 软件 KMS 边界不变。见 [当前真实收费链](validation/implementation-2026-10-22/kimi-commercial-contention-backpressure.json)。
- 最新三 CLI OpenAI c200/原 60 秒诊断实际 **64 秒**，HTTP **200=1225 /429=990**，零 403/5xx/传输错误，原零错误预算通过。2216 次初选中 2165 次一次绑定成功；51 次首次 typed hint 后，40 次最终成功，**9 次 winner 满载、2 次第二 typed winner 再变**均在同操作 scheduler/prepare 返回 429，无第三 bind。两次新 hint 均为原域第三账号，未 attempted；本次 initial all-busy 分支未发生，已由真库组件覆盖。三份观察完整、active=0、原描述符恢复、callback/SQL throw=0；存在其他候选的健康拒绝，不称全链所有健康均 allow。独立关闭后 **1226 settled（含 smoke）/979 released/0 pending/open holds**，settlement、wallet debit、ledger 均 **137312**，余额 **99999862688**。完整 src749/dist2992/canonical5/private29/deps2 前后及记录时一致，自建资源全部清理；无逐 HTTP join，不声称 Redis 网络 ACK、性能收益或追溯旧 12 个 503/两次 403。见 [当前争用与关闭资金验收](validation/implementation-2026-10-22/affinity-contention-backpressure-c200-acceptance.json)。
- 同一重建版本的原 serial profile 加有界 request sampling，四腿各 100 样本完整，延迟/TTFB 开销 **164.76/148.32 ms** 仍超原 **30/10 ms**，零流错误。400 个样本中 200 个 gateway request ID 与独立只读 PG 状态逐项连接，全部 succeeded/settled，无缺失、重复、多 attempt/evidence 或 pending；未取钱包总账聚合。最大样本的 `evidence.created_at → claimed_at` 数据库差分是 preparation 事务起点至 claim 写入的区间：`created_at=DEFAULT now()`，不是 INSERT 实际采时，不能称某方法的耗时或归因。现已复核 dispatch reader 的 11 个有序 shared fence 可批量为一次查询、完整方法 16→6 次往返；候选尚未在该捕获版本实施，同请求此读取位于 claim 之后，不能称解决上述区间。见 [最新原规范串行失败记录](validation/implementation-2026-10-22/r9-contention-backpressure-serial.json)。


- dispatch proof reader 已只在 `readDispatchProof` 将原 11 个 shared advisory lock 调用批量到一次有序 `unnest` 查询；层序、层内排序去重和跨层重复保持，完整方法 **16→6 次 SQL 往返**，五个其他 SQL、writer/helper、事务和时钟不变。受限 PG18/PG15 新根各 **9/9、零跳过**：完整 typed proof 与原逐条锁基线一致，覆盖首/中/末锁的前缀阻塞、取消回滚、正常控制面账号/凭据撤权及 reader 先占锁后 writer 等待。17 表摘要不变、原 lease token finally 释放；准备 hold 保留到自有库删除，不称全结算或回滚。功能 runner 的 durability off 保持，不作为性能结果。新根已加入双版本隔离 CI 与 strict 目标，未运行远端 required CI。见 [reader 有序锁批量真库记录](validation/implementation-2026-10-22/dispatch-proof-fence-batch.json)。
- 该变动后的完整离线回归：unit **6784 / 6761 pass / 23 skip**，integration **349 / 255 pass / 94 skip**，均零失败/取消；source TSC、两条原 workflow strict、CI wiring **14/14**、权限镜像、scoped Biome 与 diff 检查通过。声明源码/配置在前后及投影创建时相符；服务器重新构建成功。新的 PG 根在聚合中显式 skip，上述真库结果单列。见 [当前完整回归](validation/implementation-2026-10-22/regression-dispatch-fence-batch.json)。
- 同一重建产物的标准 CLI/builtin 真实 Kimi `IuxVRo / native` 再次 **7/7、零跳过**。独立重算六张新 terminal receipt：输入 **1134**、输出 **168** tokens，金额 **83/83/558/709/630/709**、合计 **2772** 个夹具最小单位，12 笔 ledger 借贷各 2772，六笔 lease 从 1 到终态 0。中断保留 unknown、263680 hold、零用量/结算及 202 重放，abort 租约归零仍仅来自通过的现场断言。完整 src749/dist2992/closure708 前后及投影时匹配，自有资源清理；一个凭据、局部 rights、夹具价格和 pilot 软件 KMS 的边界保持，不作为性能、全供应商或 GO。见 [当前真实 Kimi 收费链](validation/implementation-2026-10-22/kimi-commercial-dispatch-fence-batch.json)。
- 此构建的原 serial profile/native 四腿各 **100** 样本、warmup1，延迟开销 **106.36 ms**、TTFB 开销 **103.58 ms**，仍失败于原 **30/10 ms**，流错误为零。400 客户端样本中 200 gateway UUID 与只读 PG 终态逐项相连，全部 succeeded/settled，无缺失/重复/多 attempt/evidence/pending；没有钱包总账聚合。749src/2992dist/5harness 前后及记录时相符，自有资源清理。不同轮次差值不能隔离该 batch 的收益；当前继续通过有界逐请求阶段关联定位实际尾部。见 [reader batch 后原规范串行诊断](validation/implementation-2026-10-22/r9-dispatch-fence-batch-serial.json)。


### 16.3 钱包、围栏与八条固定查询的历史构建检查点（2026-10-22）

| 变动或验收 | 结果与范围 |
|---|---|
| 钱包摘要 | hold 与 refund freeze 的两个独立聚合合为一个 SELECT，单次摘要 2→1、全新 reserve 4→2；保留前后两次观察、原围栏和 BigInt 计算。PG15/18 财务根各 6/6、商业根各 27/27。见 [钱包聚合](validation/implementation-2026-10-22/wallet-summary-batch.json)。 |
| Commercial reader | 保留五个原 shared lock 调用和两个观察边界，SQL 8→5；PG15/18 各 13/13。初始供给的两条 SQL 字节、绑定和事务设置保持。见 [围栏和初始供给查询](validation/implementation-2026-10-22/commercial-reader-initial-authority-native.json)。 |
| 八条固定 native 查询 | 默认关闭；在此前 commercial 与 scheduler 三条基础上加入 initial supply 两条、dispatch proof 三条，不缓存业务行或在 native 错误后重放。PG15/18 dispatch proof 各 10/10；现场断言同一后端存在三个真实 wire prepared statements，重复执行后撤权仍拒绝。商业 HTTP 原根各 27/27。见 [当前双版本与回归记录](validation/implementation-2026-10-22/fixed-read-plans.json)。 |
| 该构建完整离线回归 | unit **6814 / 6791 pass / 23 skip**，integration **349 / 255 pass / 94 skip**，零失败/取消；source TSC、两条原 workflow strict、CI wiring 14/14、权限镜像、Biome 和 diff 检查通过。保留旧 sticky 用例的真实定时竞态首红及旧 CI 夹具形式首红；仅测试同步和夹具检查更新，未放宽业务预算。 |
| 该构建真实 Kimi | 重建的标准 CLI/builtin、native **7/7、零跳过**。六笔本轮 receipt 重新核算 input/output **1134/168**、金额 **2772** 个夹具最小单位，ledger 借贷匹配，六终态 lease 为零；单凭据、夹具价格及 pilot 软件 KMS 的边界保持。见 [本轮真实收费链](validation/implementation-2026-10-22/kimi-commercial-fixed-read-plans.json)。 |
| 原规范串行采样 | 四腿各 100、warmup1，延迟/TTFB 开销 **550.21/266.98 ms**，零流错误，仍 **FAIL**。完整 src749/dist2992/harness5 前后匹配，400 客户端样本中的 200 gateway UUID 均有成功终态观察；非钱包总账聚合。见 [当前串行记录](validation/implementation-2026-10-22/r9-fixed-read-plans-serial.json)。 |
| 有界逐请求阶段观测 | 200 个 measured gateway request 完整关联，三进程关闭后 active=0、描述符恢复、失败计数全零。原性能预算仍失败；同请求耗时分散于准备、调度、准入及派发。采样期间观察到其他编译负载，不能证明某请求的延迟原因。嵌套计时不相加，EOF 后 settlement 不归入 TTFB。见 [逐请求阶段](validation/implementation-2026-10-22/r9-request-stages-fixed-read-plans.json)。 |

以上是各次捕获的局部验证，不是全局源码冻结、远端 required CI 或发布 GO。该构建原完整 R9 已结束并清理：单 CLI 基线 1668 次 200、3529 次 429、零 5xx；三 CLI 延迟/TTFB 开销 **551.21/401.23 ms**，十分钟重复短流 **8400 条 / 537600 块、零损坏**。并发、精度、扩容三场景分别 **60/29/40 个 5xx**，共 **129 个（502=30、503=99）**；扩容保持 `ratio=null/current_report_failed`，未运行第二协议完整负载，也没有全负载最终资金快照。见 [完整失败记录](validation/implementation-2026-10-22/r9-fixed-read-plans-full-attempt.json)。

后续改动已由 Astra 设计、6.1 Sol 修改、Luna 执行验证：同一 RR 解析内的成功池权限行复用已通过 **60/60**；调度器纯 SELECT 去除事务外壳已通过 **205/205**。两者源码与严格类型检查通过，PG15.19、PG18.6 的 supplier native-protocol、prepared-statements、commercial 原根分别各 **6/6、10/10、27/27**，均无跳过，自建数据库已清理；真实 wire prepared 断言与 supplier protocol 测试分别记录。见 [调度读取与池权限记录](validation/implementation-2026-10-22/scheduler-reads-pool-rights.json)。

入口 HTTP 背压保持默认关闭，仅显式配置正整数时启用；组合、启动、runtime v1/v2 四个测试根已分别 **23/23、60/60、11/11、16/16**，部署配置转发已 **10/10**，池默认仍为 16/5000 ms。permit 在原 handler Promise 完成后释放；异步图片 202 后的后台派发与 WS 有各自边界。额外严格类型检查与八文件作用域 Biome 已通过；最新整套回归停在 unit 的 1 项失败，见 §16.4。私有诊断与同构建对照尚未执行。新增启动测试最初缺 JSON 请求头而先返回 415，修正后才覆盖有效 env、typed 优先和禁用分支，不能把该条夹具失败当作 env 接线缺陷证据。这些后续改动没有继承上表旧构建的完整回归或真实 Kimi 结论。

初始权限事务的 SQL 设置为 `REPEATABLE READ`，没有额外设置 `READ ONLY`；池权限行仅在本次无 rights 写入的循环内复用，下一请求重新读取。Scheduler 去除的事务原为 READ COMMITTED、无锁纯读取；保留各候选路由重新读取与 SQL/时钟顺序，连接获取次数增加的取舍待实测。

生产云 KMS、真实异地存储、Codex 完整计费边界与真实 compact/WS 的验证状态继续单独列出。Codex generation 当前保留输出 cap 字段，但尚无实际 backend 对该 cap 的强制语义及完整续接输入硬上限证明；字段保留本身不使它可售。见 [验收记录总览](validation/implementation-2026-10-22/manifest.json)；该目录保存本地验收记录，不冒充 required CI 发布证据。

### 16.4 最新任务状态与处理顺序（2026-10-23）

**本次收尾范围**：更新技术文档，将已有实现按任务分别提交并推送远程。依本次指令，不再启动测试、类型检查、格式检查、构建、真实供应商调用或性能验证。以下计数只引用此前已经结束的执行；“实现完成”和“发布验收通过”分别记录。

| 任务 | 最新状态 | 已完成与剩余边界 |
|---|---|---|
| Kimi 自动接入、工具及原生用量 | 实现完成，历史真实主链通过 | 标准 CLI/builtin 的 7/7、资金和重放证据保留。最新调度/背压改动后尚未重新构建或重跑，不将旧产物结果平移到新源码。 |
| 内置 runtime、就绪投影、compact/WS | 实现完成，Codex 真实验收开放 | 标准装配与 Kimi 主链已有实际运行记录；Codex 的完整输入/输出计费边界、实际 compact 和 WS 尚未验收，保持不可售。 |
| Kimi quota 与统一账号出站 | 实现完成，局部真实验证通过 | 真实 quota worker 1/1；单凭据与局部供应商覆盖限制保留。 |
| 运营、媒体及凭据审计重排 | 实现完成，历史浏览器通过 | 实际 React/控制面/PG 记录保留；备份界面显示未配置不能当作云备份成功。 |
| SaaS 备份、恢复与升级约束 | 本地交付完成，云验收开放 | 原生 PG dump/restore 已通过；生产 KMS、真实异地存储、PITR 与恢复材料演练尚未完成。 |
| 钱包锁序、健康时钟、绑定竞争及 HTTP drain | 已修复，历史定向验收通过 | 旧故障、修复后 c200 与关闭后资金记录分开；Redis release 仍是原 best-effort/TTL 合同，不声明逐次网络 ACK。 |
| SQL 批量读取与八条 native 计划 | 实现完成，旧构建功能通过、性能失败 | 保留原 SQL、权限围栏和每次执行的新鲜事实；默认 off。历史全 R9 有 129 个 5xx，30/10 ms 门槛未达到。 |
| 本次池权限复用与 scheduler 纯读去事务 | 实现及定向/双版本功能完成 | 单测 60/60、205/205；PG15/18 三根各 6/10/27。不是跨请求缓存，也没有证明吞吐或尾延迟收益。 |
| HTTP 背压与部署接线 | 实现及定向检查完成，同构建负载待处理 | 四根 23/60/11/16、部署 10/10、额外 strict 与八文件 Biome 已通过。默认关闭；8 只是未证实的对照值，池默认 16/5000 ms。 |
| 最新完整离线回归 | **未通过：unit 1 项失败** | 6847 项、6823 pass、1 fail、23 skip；失败后未进入 integration 和后续完整检查。新构建及真实 Kimi、serial/c200 对照均未执行。 |
| 正式 required CI 与发布 | **NO-GO** | 本地记录不等于远端 required CI；性能、云恢复和 Codex 边界仍开放。本次提交推送不代表部署或发布完成。 |

最新回归在北京时间 **2026-10-23 01:08:26—01:11:03** 已结束：source typecheck、两条原 workflow strict、CI wiring **14/14** 和 initial-authority strict 均通过，1701 个声明输入前后相同。unit 唯一失败为 `tests/server/timeout-budgets.test.ts:191` 的 `5xx failover attempts share one total deadline and backoff stays bounded`：HTTP 504 与总耗时断言先通过，随后 `secondSeen` 为 false，预期为 true。**根因未定位，不能宣称是环境抖动，也不能据此认定重试实现已正确。** 原 summary 保留 `countsValid:false`；这里照录原 native-spec 计数，不把失败汇总改成通过。已有记录见 [最新开发状态](validation/implementation-2026-10-22/latest-development-status-2026-10-23.json)。

#### 16.4.1 过程中发现的问题及解决方式

| 问题 | 处理方式与当前结论 |
|---|---|
| Kimi 合法 200 响应含大签名，被统一 4096 字节限制误拒绝 | 按固定供应商/探针类别使用有界响应上限和超时，保留 EOF、结构校验与脱敏；自动接入的历史真实收费链已通过。 |
| thinking 控制丢失、指定工具与上游实际语义不一致 | 桥接保留控制和历史；用限定工具集合加 `any` 实现强制语义，错误工具拒绝但保留真实用量。真实自动/强制两轮工具已分别留证。 |
| 上游协议、客户端计价协议与冗余别名混用 | 固定规范客户端协议和原生上游协议，各自用于桥接、capability 和计价，旧字段仅在确实缺失时回退；非法身份仍拒绝。 |
| 钱包补偿与结算锁序反转产生真实死锁 | 补偿先取既有 canonical wallet fence，再取原行锁；保留金额、重放、回滚与权限断言。PG15/18 并发与故障回滚记录已保存。 |
| 等待后使用陈旧主机时钟、容量满与内部错误混为一类 | 各 await 后重新采时，健康写入锁后使用单次 DB 采时；仅严格已知容量拒绝、且补偿确认完成时返回 429，畸形值与存储错误继续 block。 |
| affinity 第二次 winner 又变化导致内部拒绝 | 只复核原候选域中的唯一合法 winner；严格第二次竞争在准入前 429，不增加第三次 bind。旧 HTTP 错误不作逐项追溯归因。 |
| 满载时多处错误接近 5 秒，与池获取超时相符 | 保存阶段耗时与错误群体，增加默认关闭的 HTTP 入口背压。尚无应用池逐请求关联，不能把所有 502/503 都归因为连接池；不提高超时掩盖问题。 |
| 同一解析重复池权限读取、无锁纯读 scheduler 多余事务往返 | 本地成功行复用和纯读去事务分别实现；保留新鲜读取边界与双版本撤权/时钟测试。连接获取次数增多的取舍留待同构建测量。 |
| scheduler 去事务后 HTTP fake 仍期待两次查询 | 更新夹具为 billing group → candidates → route 的真实三次顺序，校验 route 绑定且无 eligibility 查询；原状态码、禁止 dispatch/事务断言保留，整个 HTTP 根 5/5。 |
| 新增启动夹具漏 JSON header，先触发 415 | 仅补正确请求头再覆盖 env/typed/禁用路径；这条首红只登记为夹具问题，不当作生产 env 接线失败证据。 |
| 额外 strict 暴露旧 OAuth fixture 多余元数据字段，新增代码格式不符 | 删除 rotator 当前不接收的 fixture 字段，保留全部断言；只修新增 import/换行，strict 与作用域 Biome 后续通过。 |
| 最新整套 unit 的总 deadline 用例未到第二上游 | **尚未解决**。保留原 130 ms 总预算、80 ms backoff、700 ms 耗时断言和第二上游断言；后续需区分真实 deadline/重试缺陷与测试同步问题，本次不修改或重跑。 |

#### 16.4.2 后续任务及处理方式

本表记录后续恢复开发时的顺序，本次不执行其中的验证步骤。复杂定位/方案由 Astra 负责，代码调整由 6.1 Sol 负责，测试执行由 Luna 负责；共享工作树按文件归属处理，性能测量期间不并行构建或运行其他自建负载。

| 顺序 | 待处理任务 | 处理方式与完成条件 |
|---|---|---|
| R1 | 定位最新 deadline unit 失败 | 先读既有失败和重试时序，确认首个真实问题；窄修实现或夹具同步，保留原预算与全部业务断言。恢复验证后先跑该最小用例，再决定整套回归。 |
| R2 | 新源码完整回归与构建 | R1 处理后补完整 unit/integration、原 workflow strict 和既有检查，再重建标准 CLI；保存实际 src/dist/config 关联。当前 dist 属于旧八查询构建，不能作新源码构建证明。 |
| R3 | 新构建真实 Kimi 主链 | 用标准 CLI/builtin 重跑原七项；逐笔对账 usage、receipt、wallet、ledger 与终态 lease，保留取消 unknown/hold/202 重放语义及单凭据限制。 |
| R4 | 新构建串行性能与 HTTP 背压对照 | 先 cap off 的原 100 样本串行测量，再同一二进制仅切换 off/8 做三 CLI c200/60s。保留 30/10 ms、零意外 5xx/transport、持久化设置及原负载；8 不升为默认值。 |
| R5 | 剩余 5xx 与尾延迟归因 | 固定错误码与真实 UUID 能关联时查请求终态；PG wait 只作总体佐证，不能推断应用池等待。对同请求拆分无重叠阶段，残差不直接叫 COMMIT/WAL，EOF 后结算不算 TTFB。 |
| R6 | 完整 R9 与扩容 | 在最小路径处理后执行原完整场景；保留全部协议、十分钟 SSE、零意外错误与 scaling ≥2.7。失败时 ratio 保持 null，不用吞吐商替换正式结果。 |
| R7 | 正式 CI 与云恢复交付 | 获取实际 required CI；使用生产 KMS、异地存储、PITR 和恢复材料演练。协议替身或本地 dump/restore 不能关闭云任务。 |
| R8 | Codex 可售能力 | 取得精确 backend/model/operation 的可信完整计费边界和 cap 强制语义，再做实际 compact/WS；此前保持不可售，不能只凭字段存在或 transport 装配关闭任务。 |

当前不再扩展未经证据支持的优化：snapshot 的 SELECT/INSERT 不是重复读取；affinity.resolve 会加锁并可能 CAS；preflight/价格解析持有授权或价格围栏，不能照搬 scheduler 去事务。连接器池和新增 native 描述符也没有本轮足量证据支持。先处理首个明确失败，再按 R1—R8 收敛。

## 17. R1 完成：deadline 单测失败的定位与窄修（2026-10-23）

**定位过程与证据**：

1. 单文件复现：`tests/server/timeout-budgets.test.ts` 的「5xx failover attempts share one total deadline」用例在独立运行中 4 次出现 1 次失败（耗时 249.9 ms、`secondSeen=false`），随后 20+ 次连续通过；带 CPU 燃烧负载 12/12 通过。完整 unit 套件（6847 tests / 6824 pass / 0 fail / 23 skipped）在本次修复前的同一源码上通过——失败是间歇性、非确定性的。
2. 时序拆解（进程内插桩复现）：warm 状态 attempt-1 到达第一上游 ~+3 ms、处理 ~+7 ms；固定 80 ms backoff 后第二上游命中 ~+86 ms，deadline 130 ms——非 backoff 余量仅 ~43 ms（冷启动首轮 ~4 ms）。失败时 249 ms ≈ 130 ms deadline + ~115 ms 停顿，与一次 major GC/调度停顿跨越 backoff 边界一致：deadline 在 backoff 期间到期 → `waitForRetry` 返回 false → 循环 break，第二上游从未被派发。
3. **结论**：共享 deadline 语义（backoff 计入总预算、到期即中止重试链、504）是设计行为且实现正确；失败根因是该用例的时序前提（attempt-1 开销 < 50 ms）在进程停顿下不成立，属夹具时序边界问题，不是重试实现缺陷。原始预算（130/80/700 ms）与全部断言保持不变。
4. 定位中发现一个**真实遥测缺口**：deadline 在 backoff 期间到期时，最后一条 attempt 记录的 `retryReason` 停留在 `retryable_upstream_error`，与客户端实际收到的 504 timeout 不一致；attempt 链路没有记录终态原因（对照：deadline 削减在途 attempt 时该字段已如实写为 `total_request_timeout`）。

**窄修**（`src/server/proxy.ts` + `tests/server/timeout-budgets.test.ts`）：

1. **实现**：追踪最后一条 attempt 记录；在共享 deadline 终止请求（abort reason 为 `total_request_timeout`）且最后一条失败记录尚未标记该原因时，改写其 `retryReason` 并重新 upsert。attempt 自身状态（如 503）保留在同一记录上；仅当未被 deadline 削减时才改写，已在途被削减的记录不受影响。
2. **夹具同步**：504 返回后对 `secondSeen` 增加有界等待（15×10 ms），消除第二上游 request handler 晚于客户端 504 处理的观测竞态；从未发生的派发仍会失败断言。
3. **新增用例**：`total deadline expiring during backoff records the terminal timeout cause on the attempt trail`——requestTimeoutMs=60、backoff=80，断言 504 且最后 attempt 的 `retryReason` 为 `total_request_timeout`，直接证明遥测改写在两种终止路径（在途削减/期间到期）下均成立。

**验证**：单文件 10/10 通过；修复后连续 20 次运行 0 失败；`tsc --noEmit` 干净；两文件 Biome 零错误（23 个既有警告与基线一致）。**残余风险（如实记录）**：≥43 ms 的进程停顿若发生在 attempt-1 与 deadline 之间，第二次派发仍会合法地不发生、`secondSeen` 断言仍可能失败——在保留原预算与断言的前提下该风险不可归零，仅能通过串行/低干扰执行降低概率；本轮未改 runner 并发策略。完整 unit 套件在修复前源码上已通过（见上），修复后按 R2 重跑。

**R1→R2**：修复已按任务独立提交；R2 在此基础上补完整 unit/integration、两条 workflow strict 与重建标准 CLI。

## 18. R2 完成：完整回归、并发 flake 窄修与重建（2026-10-23）

**首轮完整回归暴露 5 个并发 flake**（unit 6848/6820 pass/5 fail；同一批文件隔离运行全部通过）。逐个定位后的窄修：

1. **`refuseRunning` 探测 fail-open（真实安全语义修正，src/cli/v2-management.ts）**：离线写保护用 400 ms 探测配置端口，超时被当作"无服务器响应"放行写。端口有监听但响应慢（并行套件下常见）时误放行。改为 TimeoutError 同样拒绝（fail-closed）；仅明确连接拒绝才放行。新增用例：慢 800 ms 的 /healthz 仍拒绝离线写。
2. **CLI spawn 启动超时（tests/cli/managed-saas-start.test.ts）**：`runCli` 10 s 超时在并行套件下被 tsx 启动整个 CLI 耗尽 → 空输出断言失败。该界是启动界不是行为界，放宽到 30 s；gate 顺序断言全部保留。
3. **keyword matcher build 预算**：2000 ms 预算在 CPU 争用下实测 4183 ms（隔离 ~1 s）。放宽到 8000 ms（4× 余量）；真实算法回归会是数量级超标而非争用级退化，per-call 5 ms 预算保持不变。
4. **cancellation 测试观测窗口（tests/server/timeout-budgets.test.ts）**：upstream socket close 晚于客户端 abort 解析的观测竞态，改为有界轮询（同 R1 secondSeen 模式）。

**R2 门禁结果（修复后）**：unit **6849 / 6826 pass / 0 fail / 23 skipped（exit 0）**；integration **349 / 255 pass / 0 fail / 94 skipped（exit 0，与既往基线一致）**；`tsc --noEmit` 干净；两条 workflow strict 命令（056 组与 059 组原样命令）均通过；改动文件 Biome 零错误；`build:server` exit 0，`dist/cli/index.js` 为新构建产物。首轮回归中 tests/admin/phase2.test.ts 的一次 waitJob 失败未在重跑复现，按 flake 记录观察，不作为已修复声明。

**限制**：并发 flake 的根因是套件满并行下的 CPU/子进程启动争用，本轮只窄修已观测的 5 处；未改 runner 并发策略。真实 Kimi 主链（R3）与性能对照（R4）基于本构建产物执行。

## 19. R3 完成：新构建真实 Kimi 主链 7/7（2026-10-23）

**构建与执行**：基于 R2 重建的标准 CLI（commit `c8667195`，`dist/cli/index.js` 新产物），`run-commercial-postgres-gate.mjs --suite kimi`，一次性 initdb PG 18.6（Homebrew）、`postgresPreparedStatements=off`（复现原口径）、pilot 软件 KMS、runtime `current-dist-cli-builtin`、真实 Kimi 凭据（来自运行中部署的环境注入，未写入任何文件或仓库）。

**结果：7/7、零跳过、ok=true、sourceChanges=0**（[runner summary](validation/implementation-2026-10-23/kimi-commercial-r3.json)、[收费链证据](validation/implementation-2026-10-23/kimi-commercial-r3-evidence.json)）：

- **onboarding**：pending/unverified → leased（1 attempt、lease generation 1）→ **active + verified**（generation 2），worker/网关两个 CLI 子进程 exit 0、零 messages/codes/exceptions。
- **六笔 settled**（金额与既往基线一致）：native 83/83、自动工具两轮 558/709、强制工具两轮 630/709，合计 **2772** 夹具最小货币单位；每笔 reserved+lease=1 → settled+lease=0，ledger 两条 credit/debit 各等于金额，`ledger_source=billing_settlement`；usage 捕获点按场景分别为 native-provider-passthrough（含 service_tier/inference_geo 兼容）与 client-after-protocol-bridge。
- **幂等**：完成重放 200、冲突 409，资金快照不变。
- **abort**：state=unknown、零 usage/结算事件、重放 202、保留 hold **263680**。
- `providerInferenceCallsExpected=8` 满足；httpFailures 为空；自建集群已停止清理。

**边界**：单真实凭据、夹具价格（客户 2/3、供应商 1/1）、pilot 软件 KMS、PG fsync/synchronous_commit off——不替代生产 KMS、压力或全供应商验收。R1 的 retryReason 遥测改写与 R2 的 refuseRunning fail-closed 均包含在本构建内,其行为随主链一并验证。

**R3→R4**：同一构建产物执行串行性能与 HTTP 背压 off/8 对照（harness 透传已就位）。

## 20. R7 第一批：远端 required CI 四类失败的本地复现与修复（2026-10-23）

推送 c866719 触发的 CI 与此前 ef9e3c9/bb9756c 一样失败。用本地一次性 PG18 集群（initdb + 角色 SQL + 迁移 + worker grants,复刻 `managed-postgres-runtime-privileges.integration.sh` 的 CI 步骤）逐类复现并修复：

1. **worker CLI stdout 非空(真实生产缺陷)**：`managed-saas.ts` 的 egress allowlist 无条件 `console.log`,违反 workload 静默启动契约。改为仅在配置了 allowlist 时输出——严格默认(未配置)恢复字节级静默,操作员放宽配置时仍能看到生效 CIDR。
2. **`verifyRestorableColumnGrant` 旧基线**：生产已合法授予 worker 对 `saas_provider_capabilities.evidence_sha256` 的 SELECT+INSERT 两条 owner 签发、不可转授的列授权(验证证据写入需要),断言仍要求恰好一条 SELECT。同步为精确两条 {SELECT, INSERT},保留无表级 SELECT 与 grantor/grantee/非转授校验。
3. **credential-validation 门禁的负向用例失效**:G2(F6 mount)已把该表全部 13 列 SELECT 授予 worker(RETURNING 投影需要),`evidence_ref` 负向不再有判别力。换成持久负向:worker 对迁移账本 `saas_schema_migrations` 的访问必须 42501(与另一根的 ledgerDenied 同款守卫)。
4. **browser E2E 两个用例 503/403**:managed-saas-gateway 夹具的 fake SQL executor 未同步三处新查询/数据——(a) `composite-route-store:billing-group`(注意其含 `FROM saas_api_keys`,分支必须置于 api-key 查找之前,否则返回空行使 commercial authority 抛错);(b) `saas_route_config_commercial_authorities` hint(返回与 dispatchable 行一致的 policy 身份);(c) account-capability 行缺 `account_id`,native-protocol 调度按账号匹配导致 `fail('account')` → `account_denied`。三处补齐后两个用例 200。
5. **deploy smoke 作业**：两个步骤写 `set -euo pipefail`(dash 不支持)且用 `$SECONDS`,补 `shell: bash`。

**验证**:worker lifecycle 门禁 3/3、credential-validation 门禁 8/8(新库、CI 顺序执行);E2E gateway spec 2/2(其余 spec 本地因 Playwright 浏览器版本不匹配无法运行,非代码问题,由远端 CI 验证);saas-startup 60/60;unit **6849/6826/0/23(exit 0)**;tsc 干净;改动文件 Biome 零错误。**边界**:隔离门禁矩阵(`Managed SaaS isolated required gate`)此前被跳过,需等推送后远端执行;browser E2E 与 PG15 双版本仍由远端验证,本地仅 PG18。

## 21. R7 里程碑:远端 required CI 全绿（2026-10-23）

推送 `7e862b3` 后远端 CI **conclusion: success**：build-and-test（含 browser E2E）、Managed SaaS PostgreSQL integration PG15/18、deploy smoke（PG16）与全部 **29 gate × 2 版本 = 58 个 isolated required gate** 首次全部通过——此前自 2026-10-20 起所有推送（354f214、bb9756c×2、ef9e3c9、c866719）均失败。§20 的五类修复在远端得到验证。

**R7 剩余边界**：云恢复交付（生产 KMS、真实异地存储、PITR 与恢复材料演练）仍开放,属外部资源任务;CI 全绿不等于发布 GO（R4/R6 性能门槛与 R8 Codex 边界仍开放）。

## 22. R4 现状:串行腿已执行但被机器负载污染,性能腿暂停（2026-10-23）

**已执行**:cap off 的原规范串行测量(`run-current-r9.mjs --diagnostic --serial-profile --request-samples --no-build`,native,新构建)完整跑完四腿各 100 样本、零流错误,但结果**记录为环境无效**:测试期间机器负载 17-25(10 核),存在 xdown Java 构建、Chrome、WindowServer 等无关进程。观测:latency p99 开销 1251.95 ms、TTFB 700.95 ms;direct 腿 p99 仅 13.5 ms(mock 正常),gateway 各阶段均匀膨胀 3-5×(preparation-total 均值 201.6 ms vs 既往安静机 ~42 ms;scheduler 49.5 vs 11;authority 30.9 vs ~9)——均匀膨胀与 CPU 争用一致,不构成网关回归或优化结论。证据保留于 /tmp/r4-serial-cap-off(未归档入库)。

**暂停原因**:R4 的 off/8 c200 对照与后续 R6 完整 R9 需要安静机器;本轮 40+ 分钟监控内负载持续 9-22,来源为用户活跃桌面进程,非短暂构建。按"性能测量期间不并行负载"的纪律,不在超订机器上执行。

**已完成并可用**:HTTP 背压 cap 的 harness 透传(§18 前 commit 483b3f9,27/27 ops 测试)——负载窗口出现后可直接执行 `MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT=off/n` 的完整对照。

**恢复条件**:机器 1 分钟负载 < ~8(核数一半)时,重跑串行腿(替换本轮无效记录)再执行 off/8 对照;8 仍不升为默认值,30/10 ms 门槛不变。

## 23. T02b 核销：OAuth 探针的 egress proxy 接线已完成（2026-10-23 复核）

§14 记录的限制"OAuth onboarding 探针与既有 API-key 固定适配器一样走 worker 的固定 fetch,不使用账号级 egress proxy"**已过时**:`2dd157f`(§16"quota 与出站"行,2026-10-22)把 worker 的全部探针派发包进 `withAccountOutbound`——固定适配器探针(含 OAuth onboarding)经 `outbound.fetch` 使用账号绑定 egress proxy(代理存在时建立 SOCKS5h 连接,失败拒绝直连回退),custom target 另经 `transport.prepare(..., outbound.proxy)`。测试覆盖:`credential-validation-worker.test.ts` 的"fixed Kimi validation uses its account proxy and refuses a direct fallback when the proxy fails",以及 `account-outbound.test.ts` 的真实 CONNECT 代理遍历/失败不回退/dispatcher 生命周期三用例。无需新代码。

## 24. T02a 完成：Claude/Gemini OAuth onboarding 探针请求/响应面（2026-10-23）

按 §14 "下一步" 与共用构造器文件头的明确要求补齐(Codex/Grok 模式的同款扩展,sink 挂载仍是 onboarding 前置,但探针面已就绪):

1. **`oauth-probe-builders.ts`**:新增 `buildClaudeOAuthProbeRequest`(逐字节保持既有 `buildClaudeProbe` 行为:OAuth transform、metadata user_id、`?beta=true`、pinned CLI 身份头,`PROBE_PROXY_KEY_ID` 移入)与 `buildGeminiOAuthProbeRequest`(Code Assist transform、v1internal 端点、CLI UA);`firstAnthropicText`/`firstGeminiText` 移入共享。`account-probe-service` 改为复用(−95/+13),17 个既有探针用例原样通过。
2. **`credential-validation-adapters.ts`**:`OAuthValidationProvider` 扩为四家;新增 `'oauth-anthropic'`/`'oauth-gemini'` 探针 kind 与两个冻结适配器(`anthropic-claude-oauth-probe-v1`、`google-gemini-oauth-probe-v1`,catalog 常量自各自 catalog-identity 导入);claude 材料 access_token 必需 + account_uuid 可选(存在即须可打印),gemini 材料 access_token + project_id 均必需;builder 调用包 try/catch(transform 对非法 model/project 抛出统一失败关闭为 `credential_format_invalid`);`validOAuthAnthropic/GeminiResponse` 挑战校验(六位数字严格匹配);三种 OAuth kind 统一 20s/64KiB 边界与 randomInt 挑战;API-key resolver 排除面扩至全部 OAuth kind。
3. **两处必要偏离**(已复核):`canonicalAdapterUrl` 增加 `allowFixedQuery` 选项——Claude 固定端点的 `?beta=true` 是冻结协议常量非调用方输入,仅 OAuth kind 放开;既有用例"unmounted Claude/Gemini categories remain fail-closed"与本任务直接矛盾,以等价守卫用例(API-key resolver 排除面)替换。
4. **测试**:+332 行,7 个新用例覆盖固定 URL/headers(含 claude metadata 派生与 gemini wrap)、挑战成功/错误/非数字/缺失、密封材料失败关闭(0 次请求)、401 分类、4KiB~64KiB 接受与超限拒绝、20s deadline、OAuth 适配器排除。

**验证**:adapters 55/55、probe-service 17/17、worker 73/73、tsc 干净、四文件 Biome 零错误(2 个既有 useOptionalChain 告警保留)、deadcode 与基线一致。**边界**:无真实 Claude/Gemini OAuth 凭据,未做上游 smoke(与 §14 Codex/Grok 同款限制);sink 未挂载,标准部署尚不会产生这两个类别的验证任务;egress proxy 已随 worker 的 withAccountOutbound 生效(§23)。

## 25. T02c 完成：Claude/Gemini OAuth sink 挂载到标准部署（2026-10-23）

§14/§24 之后的最后一块：claude-oauth/gemini-oauth 模块此前完整存在但组合根零导入("sink 未挂载")。本轮按 codex/grok 的既有模式完成挂载,"OAuth 导入 → pending 账号 → 自动验证(§24 适配器)→ 调度可用"全链路对 Claude/Gemini 就绪:

1. **组合根(managed-saas.ts,+69 纯加法)**:导入两套三件套(binding service + InMemory session store、HTTP handler、supply sink + catalog binding resolver);`createPlatformHandler` 增加 `claudeOauthHandler`/`geminiOauthHandler` 可选参数与分派(排在 grok 之后);按 `providerSupplyService ? ... : undefined` 条件装配,五件套(access/authService/binding/sink/publicOrigin)与 grok 逐项对齐;claude 注释如实记录 catalog 绑定自 control-plane 库解析、未注册时失败关闭。
2. **新建 catalog/claude-registration.ts**(gemini/grok 模板):provider/capability/platform-rights/占位供应商成本四组输入 + `registerClaudeProviderCatalog` 一键 applier;claude 为单 OAuth 产品,输入列表各恰一项(注释说明与 grok 双产品/gemini tier 的差异)。配套 9 个用例。
3. **类型对齐**:两个新 sink 的本地 executor `rowCount` 原声明 `number`(codex/grok 已是 `number | null`),直接传真实 SaasDatabase 会 TS2345——已把两处声明对齐为 `number | null`(子代理的临时适配器随之删除,组合根保持直传 database);`rowCount !== 1` 校验在 null 时仍失败关闭。
4. **启动测试(+92)**:① 四个 OAuth 面板(codex/grok/claude/gemini)`/admin/api/v1/<cat>/start` GET → 405,证明路由真实分派且在 auth/DB 之前;② sealing KMS 未配置(supply service 未装配)→ 404,证明条件装配失败关闭。

**验证**:tsc 干净;startup 62/62、composition 23/23、claude-registration 9/9、claude/gemini-oauth 全部 10 个模块测试文件 55/55;改动文件 Biome 零诊断;deadcode 严格改善(unused files 858→850——两套模块因挂载转为已使用,零新增)。完整 unit 6870/6845/2 fail:两处失败(backup-restore、http-images keepalive)与本次改动无关,隔离与重跑均通过,属高负载(1 分钟负载 ~20)时序 flake,如实记录不作为通过声明。

**边界**:与 §24 相同——无真实 Claude/Gemini OAuth 凭据,未做真实上游 smoke;provider catalog 注册(claude-registration 的 applier)需操作员/部署流程调用后才解除 sink 失败关闭;真实"导入→验证→调度"smoke 待有凭据时执行。

## 26. 本地复验：当前构建回归通过，R4 串行诊断仍未通过性能门槛（2026-10-23）

在 `a1441872e718f17badf2a7947bb210fa44de4439` 上重新执行 `build:server`，随后串行安排本地验证，不与本轮自建构建/测试并行压测。source、dist、tests、scripts 及选定构建输入前后散列一致。完整证据见 [本地验证记录](validation/implementation-2026-10-23/local-validation-0937/README.md) 与 [机器可读汇总](validation/implementation-2026-10-23/local-validation-0937/summary.json)。

- 最小四文件：**41/41**，含 §25 的 backup-restore、http-images keepalive 与 R9 harness。
- 完整 unit（文件并发 2）：**6870 / 6847 pass / 0 fail / 23 skipped**，约 139 秒；这是本次低并发回归通过，不将 §25 的历史失败改写为通过。
- integration（文件并发 2、精简环境）：**349 / 255 pass / 0 fail / 94 skipped**，约 56 秒；显式依赖环境的跳过项不计通过。
- 一次性 PG18.6 原生备份恢复：**1/1**，覆盖 **118 条迁移、147 张表**，指纹一致、损坏归档拒绝、自有恢复目标清理。首次 PG 启动因 locale 缺失失败，设置 `LC_ALL=C LANG=C` 后通过；两次日志均保留。S3/KMS 为协议替身，不关闭生产云恢复。
- 当前 dist 的三 CLI mock 装配：OpenAI/Anthropic 两条 smoke 均 **200 + settled**；PG fsync/synchronous_commit 开启，prepared statements 为 native，HTTP cap 关闭。

**R4 串行诊断（北京时间 09:48:37—09:49:19）**：四腿各 100 样本，**400 个 HTTP 200、流错误 0、请求 ID 关联完整**；p99 latency 开销 **424.55 ms > 30 ms**，TTFB 开销 **267.15 ms > 10 ms**，原报告仍为 **exit 1 / 两项 violation**。测试前一分钟观察负载 **8.30–11.85**，本轮之外的 Rust 编译仍在；harness 期间采样负载 **7.77–9.23**。未形成受控窗口，不能据此关闭性能门禁、认定回归/优化收益或将全部耗时归因于 CPU。

**后续边界**：本次未执行 off/8 c200/60s 对照、R5 受控归因或完整 R6 R9；这三项仍开放。未调用真实供应商进行 OAuth 或 Codex 可售验收。R4 自建进程、PG 与运行时目录均已清理。下一次先取得安静窗口，再对同一候选构建执行有效串行测量和 off/8 对照。

## 27. 服务器自托管升级与 IP 真实调用通过；发现固定遥测批次等待（2026-10-23）

按用户确认升级服务器现有的自托管真实 Kimi 服务，采用 systemd + Node，沿用已有上游及客户端密钥。
本轮重新构建并上传 `ab293e01` 加本地部署工具修改，4,969 个文件哈希匹配；生产依赖及 Linux SQLite 原生模块验证通过。
旧配置预览通过后在新目录迁移为 V2，原配置、旧数据与备份保留。两项服务 `model-router`/`nginx` 均运行且启用开机启动。
清理约 6.7 GiB 可再生成缓存/过期归档日志，根盘可用量从 `4.6G` 增至 `12G`。

按最新要求使用公网 IP 验证：HTTPS 证书信任与 IP SAN 校验通过；健康、认证模型列表、OpenAI/Anthropic 真实生成与 SSE 均 200，未认证请求 401。
真实生成使用 `kimi-k2.6`，没有验证模型列表中其他模型。账号、IP、客户端密钥及证书保存在被忽略的本地文件，未提交到 Git。

**低并发基线**：2 次预热加 40 次正式真实上游采样，全部成功。路由并发 1/2/5 的完成 p50 为 **1376/1374/1372 ms**，
并发 5 观测吞吐 **3.50 req/s**、主进程 CPU **2.10%**、RSS 峰值 **137 MiB**；直连上游完成 p50 **642 ms**。
隔离复现当前日志组件的三个派发前等待写入合计 **756.35 ms**，其中每个批次固定排队约 250 ms，确认这是自托管路径的延迟优化点。
正式遥测快照的 37 个生成请求与 37 个配额预留全部完成/结算，没有修改日志持久化语义。

**边界**：这是 1 CPU/1817 MiB 服务器上的短输出自托管基线，不是 managed-saas R4/R5/R6 或持续容量验收；这些门禁继续开放。
详细部署、样本、IP 验证与延迟证据见 [服务器报告](validation/implementation-2026-10-23/server-self-hosted/README.md)。

## 28. Redis 共享额度与异步日志已实现，服务器重测完成（2026-10-24）

按本轮要求将额度改为共享 Redis 原子读写、缓存缺失回源和数据库异步写回；多实例使用同一 PostgreSQL 持久化存储，
鉴权使用 5 秒有界进程缓存。普通日志脱离请求等待链，业务额度与 usage journal 独立存储。
加入数据库故障/积压拒绝新准入、幂等写回、generation 防旧写、Redis 旧快照重启恢复和事务提交后释放容量。
迁移 138 与运行角色授权已更新；金额账本、累计预算、金融结算和派发凭证仍保留 PostgreSQL 事务。

完整 unit **6,857 pass / 0 fail / 23 skip**，integration **255 pass / 0 fail / 101 skip**；
最后的恢复修复另通过 **76/76** 针对性回归、**8/8** 真实 Redis 场景及 `build:server`。
最终三 CLI + PG/Redis 的两协议 smoke 均 200 + settled，短并发诊断 **65/65 HTTP 200**。
但该诊断 latency/TTFB p99 额外耗时 **797.59/207.23 ms**，仍高于 **30/10 ms** 门槛；R4/R5/R6 保持开放。

现有自托管服务器已升级，4,945 个发布文件散列匹配。真实 Kimi 的 2 次预热与 40 次正式请求全部成功：
串行网关完成 p50 **1376.17 → 580.38 ms（下降 57.83%）**；并发 2/5 为 **607.52/633.56 ms**，
并发 5 观测吞吐 **3.50 → 7.06 req/s**。本轮直连 p50 **575.96 ms**；这仍是短样本、不同时间的顺序比较。
公网 IP 的 OpenAI、Anthropic 与 SSE 均通过。最终 71 个预留全部 settled，Redis 积压 0、额度与数据库一致。

首次发布缺件导致启动失败已自动回滚并修复；最终实例健康，旧程序和数据快照保留。
完整实现边界、失败记录和证据见 [Redis 优化与重测报告](validation/implementation-2026-10-24/redis-quota/README.md)。

## 29. P0 技术方案：可运营的多租户模型 API 平台（2026-10-24，实施中）

目标已明确为可运营的多租户模型 API 平台。对照本地 CLIProxyAPI `911f49c`、Sub2API `a3eb7ef`、New API `6549a17`，以 model-router `44b0eb7` 为设计基线，新增 [P0 技术方案](p0-multi-tenant-api-platform-technical-plan-2026-10-24.md)。初版完成时仅有设计；最新指令已启动实施，当前开发与验证状态见 §29.1，未据历史结果宣称新版本通过。

P0 聚焦三个主线：

1. **标准新客与模型供给闭环**：补齐平台供给的正式 profile/entitlement 开通入口，复用已有 catalog、pool grant、route、价格及容量服务；按实际客户端工作流开放已验证协议组合，补齐必要转换。OAuth、transport、WS/compact 已有实现，按实际装配和可用性收口。
2. **单支付通道收款与退款闭环**：拟以支付宝 precreate/CNY 为首条链，补标准启动配置、PSP 专用凭据、二维码及订单状态交互、历史商户版本绑定和原队列内的正确分发，复用原财务事务及履约/退款状态机。
3. **托管性能与可恢复运营**：保留已有 Redis 额度和异步日志优化，完善同请求诊断、过载与资金终态检查，按原 R9 门槛逐级验收；将生产 KMS、异地备份/恢复及常驻 worker 的部署证据纳入收费运营出口。

初始设计盘点确认的断点包括：`createTenant` 只创建身份和默认项目，平台权益演示依赖验收 seed；标准 CLI 尚未组装支付选项，支付页只显示二维码内容文本，历史订单还缺独立商户版本分派。对应工程实现已在 §29.2–22 分批交付；正式新客真实请求、PSP 与生产恢复仍按独立 gate 验收。

Codex 的可信完整计费用量上界仍为明确阻塞。不得用 `max_output_tokens` 字段存在、操作员配置或一次成功请求替代 backend 强制语义与 opaque/compact 输入范围证据；可先交付选定供给的运营闭环，不能据此宣称 Codex/compact/WS 对齐或全部 P0 完成。

初始方案评审补充的问题和处理设计（最新实施结果见后续各节）：

- **开户写入顺序**：现有外键要求先有 profile。开通操作在短事务内先创建独占 profile，再创建 disabled entitlement 和审计；各服务分阶段装配后，最后事务才激活权益。
- **支付创建响应丢失**：现有查询入口依赖 orderId。客户端以原 POST、原幂等键和原 payload 重入取得原单；服务先解析既有幂等记录及原商户 binding，再为真正新单选择 active generation，避免切商户后重复创建。
- **灾备与金融保证冲突**：15 分钟 RPO 只可用于非金融数据或非收费 pilot。收费出口要求独立故障域的同步持久证据及恢复至最后已确认金融提交的演练；PSP 对账无法重建模型扣费、hold、派发和 unknown，缺证时继续阻塞收费 GO。

### 29.1 P0 实施启动与并行责任（2026-10-24）

按最新目标开始实施，优先收敛 Codex 托管边界。Astra 完成复杂问题定位与合同设计，6.1 Sol 分工修改，Luna 负责针对性编译和测试；任务完成后分别提交远程，源码完成与生产运营通过分别记录。

| 主任务 | 当前执行范围 | 状态 |
|---|---|---|
| P01/P02a/P03 | 正式平台权益开通、独占资源 journal、最终激活事务、管理员接口与受限权限 | 开户工程实现、受限 PG18 和管理页本地浏览器通过；标准新客 builtin 全链待验 |
| P04 | Chat↔Gemini、Responses↔Gemini、既有 Gemini↔Anthropic 的直接转换与准入 | 新四桥与旧两桥修复均定向通过；真实 CLI/builtin 工作流待验 |
| P05 | Codex 终态用量、原生 WS、HTTP/WS 持久上下文、精确可信上界门禁 | 工程实现及定向验证完成；真实 backend/KMS/计量契约与部署全链待验 |
| P06 | 支付配置/专用凭据 loader、标准 CLI/组合根与 doctor | 标准装配、精确角色隔离和 doctor 实现通过本地检查；实际商户/生产 KMS 待验 |
| P02b/P07 | 商户 binding/CAS、原单幂等恢复、历史商户回调及退款 | 真实 PG18 5/5 及远程独立 PG15/18 门禁通过；真实 PSP 交易待验 |
| P08 | 本地 QR、订单查询与超时恢复、钱包/套餐收银交互 | 前端实现及定向验证完成，真实 PSP 闭环待验 |
| P09 | 同请求连接池等待、SQL/事务、首字节/EOF/结算观测，serial/cap 诊断入口 | 工程实现及定向通过；实际性能诊断与原 R9 验收待执行 |
| P10/P11/P12 | 故障不变量、标准 Redis 持久配置、同步金融恢复与分级验收记录 | P11 配置、远程 shared PG15/18、PG16 与 build/browser 通过；目录 ACL 修后候选 CI 待验；P10 两项本地恢复证据继续开发，生产恢复待外证 |

本轮定位补充：Codex 缺失 input/output 用量不能补零作为完整证据，incomplete/failed 终态用量需保留；WS 的 previous_response_id 不能只影响调度后被 HTTP payload 静默丢弃。新项目默认 inference policy 为 suspended，正式开户最终事务还必须原子激活项目策略并保留已配置容量，不能仅激活 entitlement。以上已进入实现范围，当前尚未据此声称测试或真实调用通过。

### 29.2 P08 收银台前端交付与验证

钱包与套餐购买页已改为本地 SVG 二维码（`qrcode.react@4.2.0`），显示服务端订单金额、币种、订单及到期信息；补齐订单轮询退避、后台暂停和恢复。创建响应丢失时保留原 POST 的幂等键和 payload，找回原单后查询服务端最新状态；不得因超时或商户切换自动换键。退款 unknown 明确为人工核对中。

Luna 已执行 workspace 依赖安装及 lock 同步（`--ignore-scripts`），web 定向用例、`npm run typecheck -w web`、`npm run build -w web` 通过。本结论仅覆盖前端实现与本地构建；支付宝实际扫码、回调到账和退款仍在 B0/B1 gate，未执行真实 PSP 交易。P0 设计与实施分工基线已推送 `139c45a`，本节随 P08 任务独立提交。

### 29.3 P04 四个 Gemini 直接桥交付

新增 Chat↔Gemini、Responses↔Gemini 直接请求、响应与 SSE 转换，统一注册四个 pair；工具调用 ID 稳定，支持明确 ID 的同名并行工具结果关联，保留缺失用量为未知，处理 UTF-8 分块、终态和取消。修复 Gemini `usageMetadata` 被 `body.usage` 前置检查阻断的问题。对尚未保真的媒体、原生搜索、opaque reasoning/continuation、多 candidate 等语义返回明确安全错误，不静默删除字段。

Luna 协议定向批次 **40/40** 通过；首次失败是旧测试仍期待新 pair 不支持，已改为四方向注册断言，并保留非法协议和不支持字段的拒绝测试。当前合并工作树 `build:server` 已通过。编译器支持 pair 和结构化错误接线由 Codex/runtime 同一 writer 完成，随其后续任务提交。

这只关闭直接桥代码及本地定向验证；现有 Gemini↔Anthropic 桥的历史保真不足未因此自动修复，标准 builtin 仍按实际 provider/product/model/operation/workflow 证据准入，未凭注册数放开全部供给，也未执行真实 CLI 或模型调用。P08 已推送 `2ad45cf`。

### 29.4 P11 标准 Redis 与生产恢复部署配置

Compose Redis 已改为 AOF everysec、noeviction、持久卷和可调容量，修正 cache-only/fail-open 的旧说明；仍明确允许非金融软计数的短暂丢失窗口。新增收费 PostgreSQL 同步持久配置示例、只读 preflight 和 fencing/最后已确认 commit 恢复步骤，复用原异地 backup/PITR 与 KMS runbook。CP 专用 PSP 配置及凭据挂载与 gateway 权限分离。

Luna 使用独立 `docker-compose ... config --quiet` 解析通过；本地单 PG Compose 仅是 pilot，未当作收费高可用部署。本任务未连接生产云 KMS、未执行实际故障切换或异地恢复，C2 仍需外部证据。正式 PG15/18 CI 的新增 P0 业务门禁另行接线验证，未借配置解析关闭业务验收。P04 已推送 `09b875f`。

### 29.5 Codex C1–C4 基础实现与尚未放行的边界

Codex transport 已将 completed/incomplete/failed 的执行终态与用量完整性分开，缺失 input/output/cache 计数不再伪装零值；新增 WS canonical replay、连接/项目/凭据绑定和未知引用 409，transform 不再静默丢弃未解析 previous_response_id。新增密文持久 history 的 DTO、PG adapter、AEAD cipher 和 resolver，数据库时间控制 TTL，完整 compact 返回窗口保留；标准 loader/HTTP/WS 持久接线作为后续独立任务继续实现。

可信上界采用精确 endpoint/product/model/operation/transport/continuation scope，内容寻址摘要以 47 字符 cb1 版本进入既有 prepared 签名链，实际 send 前重验 proof、scope、有效期与撤销；受信 registry 默认空，普通部署 JSON 不能自证。能力报告区分 transport assembled、credential verified、financial admissible、workflow verified。编译器同步四个 Gemini pair 和安全不支持字段错误映射。

Luna 最近 Codex executor/continuation/持久 history/profile 定向批次 **15/15** 通过，当前服务端编译通过；这不是所有 Codex 任务验收。原生上游 WS transport、标准持久 history/KMS 全链接线和真实 backend 计量/工作流证据继续推进，Codex 收费 admission 仍保持拒绝。方案 §4.1/4.2/4.4 已同步实际开户与 Codex 工程合同。P11 已推送 `7280e97`。

完整离线 unit 首轮为 **6,953 条 / 6,904 pass / 26 fail / 23 skip**；已按真实失败分派修复，尚未宣告全绿。部分为新增检查/迁移的旧预期，部分为实际实现错误，均须分别重跑；新增真实 PG、CI 和后续源码不能借上述历史定向通过数作为完成证明。

### 29.6 P02 数据迁移与最小角色授权

唯一注册链追加迁移 **139–142**，当前共 **123 条、head 142**：开户 operation journal、支付商户 binding 与 PG 控制版本、密文 Responses history、原支付创建请求指纹。旧迁移 SQL 与 checksum 保持原值。history 使用 tenant/project/key 复合约束、密文不可变记录、数据库时间 TTL 和有界删除；支付指纹不可变，不把历史空值猜作新请求。

真实 PG18.6 受限角色验证中发现并修复三类装配问题：CP 缺少正式商业 policy/head/attestation/route 的精确列授权；授权生成器跳过了 dispatchable view；输入维度校验需要执行一个纯函数。现按 manifest 授权列与只读 view，仅允许精确签名的 immutable、非 security-definer、boolean 校验函数，其他函数/default grants 的拒绝继续保留。角色脚本可先于迁移执行，迁移后启动探针再要求该函数存在且可执行。

Luna 已用全链迁移后的临时 PG18.6 跑通开户 **1/1**、商户绑定 **5/5**、密文 history **1/1**；临时库已清理。开户新增静态财务就绪检查亦已通过 unit **3/3**，最后一次新 PG **1/1** 包含实际 CP 启动权限探针。这些结果不包含 PG15、真实 PSP 或 Codex backend。完整规范 unit 为 **6,989 条 / 6,963 pass / 3 fail / 23 skip**，剩余 CI 离线跳过守卫、权限脚本测试正则和 metadata proxy 错误类型已分别定位修复，相关定向批次 **184/184**、服务端编译通过，完整回归待重跑。Codex 基础实现已推送 `f61afec`。

### 29.7 P07 商户绑定、原单恢复与支付控制

商户描述不可变，PG singleton 保存唯一 mode、active binding 和 CAS revision；钱包与套餐在各自原事务内锁定控制记录再接新单。先查原幂等请求再读取当前商户，切换或排空后仍返回原单、原商户；现有 inbox/refund 队列 claim 后按记录的 binding 分发，历史回调、查询、履约和退款保持归属。管理员控制接口复用当前 MFA 会话、数据库角色复核、Origin/CSRF 与事务审计。

定位中补齐两个实际正确性缺口：支付宝回调仅在耐久收件成功后返回原生 `text/plain success`；原支付创建指纹纳入规范化 promo，省略或更换 promo 返回 409，等价大小写/空白仍找回原单。正式 resolver 遇到缺少原指纹或商户归属的历史记录时拒绝推测，需要人工明确归属。

Luna 商户控制真实 PG18.6 **5/5** 验证了接单锁/CAS、双 CP 同版本竞争、切换重放、draining 下历史回调与退款只入账一次、排队变更时角色撤销；适配器为本地替身。promo 最新单文件 **7/7**，支付 HTTP 与管理员 handler 定向检查通过，完整 unit 中本模块无剩余失败。真实 precreate、扫码、回调域名和全/部分退款仍属 B0/B1，尚未执行。P02 迁移与权限已推送 `a1c71e2`。

### 29.8 P01 正式平台权益开通与恢复

新增窄开通服务与管理员 POST/GET/disable 接口，严格限制嵌套 DTO，由服务端确定 tenant/project/actor。独占 profile、disabled entitlement 与 operation 先持久化，再复用现有价格、policy、签名 attestation、route、pool grant 和容量服务；阶段成功但 journal 写入失败可按既有资源继续。最终短事务复核版本、当前权限、账号产品与权利范围、精确静态财务准入，原子激活项目策略和 entitlement 并写审计。项目策略从 suspended 激活时保留已设置容量；不自动发 Key 或加余额。

定位并修复：嵌套对象覆盖服务端 scope 的风险；runner lease 过期后旧执行者继续写的问题（operation guard 与同一 disable guard）；pool ID 与调度 upstream ID 不一致；新 capacity version 的 RETURNING 子查询看不到本语句插入行。CP pool 至少两个连接，启动与 doctor 按解析后的有效值检查，避免 `01` 或空白形式绕过。Codex 开通在创建前及最终激活前检查 reviewed profile 的精确 scope，缺少端口或可信上界时明确拒绝，不能先发可用权益再等待请求失败。

Luna 新就绪检查 unit **3/3**、服务端编译通过；最新真实 PG18.6 **1/1** 包含受限 CP 启动探针、阶段写入故障续做、最终审计失败回滚、容量及策略 v1→v2→v3、原操作幂等/冲突/停用/会话撤销，以及最终 readiness 失效后保持 disabled。尚未据此关闭 A0/M1：从标准新客 HTTP、正式管理员开通、手工发 Key 到当前 dist builtin 真实供给请求，仍需独立端到端证据。P07 已推送 `05fc4bd`。

### 29.9 C2 持久 history 的标准 loader 与独立 KMS

实现 history 专用运行时 loader、production KMS port 和内置 AWS SigV4 adapter：固定 region/HTTPS endpoint、每记录新 DEK、完整身份与过期信息 AEAD 绑定、短期凭据文件轮换、旧 key ARN 白名单、敏感错误脱敏与 close 清理；pilot 文件 keyring 始终单列为 pilot。标准诊断明确 `external_evidence_required`，本地测试不替代真实 IAM/KMS 或恢复验收。部署合同见 [history 配置](responses-continuation-history-deployment-2026-10-24.md)。

loader/KMS 定向测试与当前服务端构建通过，真实受限 PG18 history **1/1** 证明密文存储、不可变约束和数据库时间过期。尚无实际 AWS 调用。源码检查同时发现组合根只传入 resolver，HTTP/WS 消费端尚未执行持久 resolve/remember；已继续分派实际链路接线及测试，不能把 loader 或 connection map 当作跨请求/跨实例续接完成。P01 已推送 `4a236f4`。

### 29.10 P09 同请求诊断基础

新增有界 ALS trace，记录真实 pool acquire/release、SQL、事务、上游 send/首字节/正常 EOF 的时间；按 span 区间并集计算 exclusive 时间，避免嵌套累计。未采样请求保持原 pool.query 路径，采样请求显式 acquire，并保留连接错误监听和 release 语义。取消或错误不标正常 EOF，结算 marker 仅在已确认 settled/replayed 时记录。

trace、数据库包装、provider HTTP 和标准部署诊断定向测试已通过，服务端编译通过。标准组合根与 dispatch marker 接线随其依赖任务提交。诊断队列有界、采样默认关闭、固定数值投影不含 payload，不增加持久写等待；未执行新性能测量，原 30/10 ms、HTTP 200 成功吞吐及 1→3 实例比 ≥2.7 等门槛保持开放，未新增最低 200 rps 的门槛。进一步源码审阅发现 `replayed` 也可能仍待金融对账，后续 marker 和 history 准入改为只接受明确 `settled`，不能从 `sent` 或 `replayed` 推断。history loader 已推送 `39a0c9d`。

### 29.11 P06 标准支付与开户运行时装配

标准启动加载 CP 专用支付配置、受控 basename 凭据引用和固定 Alipay 端点，注册并核对不可变商户 binding，装配同一队列服务、退款与管理员控制入口；配置文件不携带 mode/active authority。gateway/worker 不加载 CP 的支付 secret。正式开户只在 CP 供给服务、商业 attestation 信任文件和足够连接池均满足时挂载；信任文件只含受控 Ed25519 公钥与 suite 摘要，不能解锁 Codex 可信上界。

history loader 的启动检查、TTL 维护及关闭已接入标准 gateway/combined，HTTP/WS 消费接线仍按 §29.9 独立推进。诊断配置默认关闭，启用后固定投影与队列异步输出。doctor 分别报告 schema/grants、配置/凭据、history KMS canary 和外部证据边界，不把文件存在当作真实支付或收费 GO。

本轮发现环境对象全量枚举会触发无关 metadata Proxy 错误，改为固定 history 键读取；doctor 假 SQL 匹配过宽会吞掉角色探针，已精确修正。Luna doctor/部署/就绪/角色联合批次 **184/184**、服务端编译通过；新的 CI 两组严格测试源码编译亦通过。真实商户与生产 KMS 尚未配置验收。P09 诊断基础已推送 `37cdc64`。

### 29.12 Codex 原生上游 WS 与结算事实

实现原生上游 WS 的 session/connector/transport：服务端 opaque handle 绑定 tenant/project/key、供应商产品、账号/凭据版本、公开及实际模型、端点、出站配置和 generation；每轮仍重新准备、预留、claim 和 lease。空闲连接不持有执行 lease，连接内只允许已观察到的完成引用；写出后断线/取消保持 unknown，不自动重发或改走 HTTP。Undici 公共 dispatcher 复用 DNS pin/proxy/TLS，应用层消息与队列有界，不宣称重组前的底层内存硬上限。

Astra 审阅发现并修复两项恢复缺口：secret 包装器吞掉安全的 session 类型错误，造成 full-context 指引丢失；连接 pin 漏比公开模型别名。补安全错误透传、秘密异常脱敏/字节清零、别名变化与失效连接回归。另发现结算 `replayed` 可能仍为 reconciliation_pending：dispatch 现显式返回服务端 settlementOutcome，history 准入和诊断 settled marker 只接受明确 `settled`，不据 `sent/replayed` 推断财务终态。

Luna 原生批次 **29/29**、修后精确批次 **25/25**、结算三状态批次 **55/55** 通过。真实本地 TLS/WS **1/1** 使用合成 CA、严格证书/SAN、固定 host/path/headers，证明两轮 socket 复用、terminal usage 和第三轮断线不重发；它不证明实际 Codex backend、生产 DNS/proxy 或计量契约。HTTP/WS 持久消费端接线继续进行，期间的缺 helper 编译错误按共享依赖修复，不回写为本次原生测试失败。trusted-bound registry 仍为空，Codex 收费 admission 拒绝，M1/M2/M3 未关闭。P06 已推送 `9e4ed14`。

### 29.13 P03/P07 管理页面与浏览器流程

平台管理新增正式供给开通与支付控制页。开通页导入已审核 artifact，展示价格及 tenant/project 选择，原 operationKey/payload 创建、恢复查询、显式停用；不自动发 Key 或加余额。支付页只提交 mode/binding/revision 的封闭 CAS，409 后刷新快照；敏感配置与 secret 不进入页面。按现有 operations/superadmin 权限显示入口，受限角色直达路由亦不能变更。

Luna 前端定向 **30/30**、web typecheck/build 通过；系统 Chrome 本地 API 替身下新增浏览器流程 **4/4**，既有审计流程 **2/2**。首轮三个超时来自包装 label 包含 option 文本导致 exact selector 失配，改为 combobox 名称前缀后完整重跑通过，未改变产品行为。覆盖创建原意图、故障恢复/重试、显式停用、支付 CAS/冲突刷新和角色拦截；不冒充真实后端全链、PSP 或模型工作流。Codex 原生 WS checkpoint 已推送 `55415d5`。

### 29.14 P04 既有 Gemini↔Anthropic 桥的实际缺口修复

Astra 源码对照发现旧 Gemini→Anthropic 仍 passthrough，反方向会丢工具历史、按 chunk 拆 SSE 导致碎片丢失、逐事件随机工具 ID、缺消息生命周期和错误结束原因。这些会影响常用两轮工具工作流，不能凭已注册 pair 宣称可运营。

现改为双向直接转换普通文本、JSON function 声明/调用/结果、稳定调用 ID 与并行关联；流式用完整 parser、单 reader、完整 message/block 事件、明确 terminal、usage 和取消传播。opaque thinking/signature、无法保真媒体及 cache-write 映射仍明确拒绝，不复制竞品 dummy signature 或静默清除字段。编译器增加 reverse pair 只代表转换代码存在，标准 builtin 仍按已证明的 provider/product/model/workflow 准入。

Luna 包括六组 Gemini/共享桥的定向批次 **56/56**，不包含真实 CLI/provider。规范离线 unit 最近 **7,014 条 / 6,991 pass / 0 fail / 23 skip**；integration 最近 **360 条 / 255 pass / 0 fail / 105 skip**，所需外部配置跳过项不计通过，后续 C2 与 A0 新修改继续单独验证。管理页面已推送 `df86876`。

### 29.15 P12 必需 PG 门禁与历史迁移回归

PG15/18 CI 增加 P01、密文 history、商户绑定三个 required root 及严格测试源码编译；按原空队列 worker→既有财务→P01→history→merchant 顺序执行，历史迁移另由显式 test admin 创建随机测试库，受限 migrator 执行完整迁移。正式 migrator 不获得 CREATEDB。缺少 required/部分角色配置必须失败，仅未要求且完全未配置 PG 的离线 history 才可跳过。

历史 fixture 的随机 schema 与既有 canonical schema 迁移冲突，改为隔离随机数据库；老 Key 数据补齐既有 principal/creator/authz snapshot 条件。018 用例按其原目的先验历史 017–022，再完整升级到142并比较身份、派发及成本快照，禁止为历史记录回填 commercial/prepared authority，未派发历史 attempt 继续被拒。最后发现新 fixture 只 hash SQL，实际规范为 `SHA256(name + NUL + 原始 SQL)`，已修独立期望，旧 SQL/checksum 未变。

Luna 最新真实 PG18 历史 suite **31/31**、CI wiring **19/19**、两组严格测试源码编译通过；018 单独亦 **1/1**，临时库与集群清理完毕。完整离线回归结果见 §29.14，后续新改动继续复验。远程当前候选 PG15/18 与全部 CI 状态仍待取得，未沿用历史 green 关闭本轮门禁。Gemini 桥修复已推送 `9b14151`。

### 29.16 C2 HTTP/WS 持久续接实际消费完成

HTTP 和 WS 已实际调用 persistent resolver，而非只注入 port。显式 `conversation_id` 与认证 tenant/project/key 形成引用 namespace；prepare 前保留 canonical 原对象，prepare 后核对完整 provider/account/credential/models 身份，不符时先补偿未派发资源再返回 full-context 409。普通响应保存完整 output，compact 保存完整替换窗口；只有明确 `settlementOutcome=settled` 才新增历史，存储失败不重发、不退款、不承诺可续接。

HTTP 对实际上游 Content-Type 选择 SSE/JSON parser，先结算和尝试保存，再发布终态/JSON；非终态继续发送，超限仅停历史记录，不中止原推理。延迟发布错误会 abort 释放下游。WS 配置持久 resolver 后每次引用都查持久权威，不让连接内缓存绕过 TTL 或删除；失败写入不保留可续接的内存副本。原生上游引用仍只用于当前 session 已确认的 ID，跨连接使用完整 canonical replay。

Astra 指出的实际 Codex 强制 SSE、连接缓存绕过过期、延迟发布失败释放问题均已修复。Luna 最新 HTTP **10/10**、WS/helper **24/24** 和服务端编译通过；测试包含实际 resolver/cipher 调用、跨连接、scope 隔离、身份补偿、终态发布顺序和失败路径。它们结合既有真实 PG18 密文 **1/1** 分别证明工程环节，尚不代表真实 backend、生产 KMS 或部署多实例全链。Codex 可信计量 registry 仍为空，财务准入和 M3 继续阻塞。CI 任务已推送 `c025d74`，远程 PG15/18 新发现的 058 权限测试例外正在修复。

### 29.17 标准验证 worker 的重试上限

A0 脚本审阅发现仅观察 `attempt_count<=1` 不能限制发送次数，worker 默认可重试五次。新增正式 `MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS`：仅 credential-validation-worker 角色接受，整数 1–20，配置后真实传入 worker，未配置保持原默认 5；doctor 显示每 job 上限，不称作全局流量上限。A0 将其设为 1，业务首请求仍只发一次。

Luna 部署单文件 **31/31**、服务端编译通过，此前同批 doctor/startup 均通过；新增测试的安全错误文案预期已修。未改变核心重试算法、未知派发处理或资金规则，也未执行实际 Kimi 调用。HTTP/WS 持久消费已推送 `72b7b97`。

### 29.18 A0/M1 正式新客首请求验收脚本

新增 `scripts/ops/verify-platform-access-first-request.ts`、独立 live test 与 disposable PG runner 的 `platform-access` suite。平台 catalog/价格/加密供给可预配置；待验客户必须通过正式注册、赠金码兑换、管理员 P01 HTTP、客户明确创建 Key，再由 current dist 标准 CLI builtin 完成短 Kimi 请求。未用 SQL seed 客户权益、路由、grant、余额或登录 session。MFA 使用真实 enrollment/login；资金门禁核原生 usage、精确价格/成本版本、账本平衡、余额扣减、hold/lease 释放。赠金不代表 PSP 支付验收。

Astra 审阅后修复新 suite 名含连字符导致非法库名、观察尝试次数不能限制发送、强制中断可能遗留进程与临时签名材料三项问题。新 suite 使用独立 owned process group、幂等信号清理和 runner 兜底删除专用 runtime 目录；验证 worker 每 job 最多一次尝试，业务请求不自动重发。PG durability 开启，source/dist 前后 provenance 保留。

Luna 严格 helper/test 编译、runner 语法检查通过，无 live 授权拒绝和真实本地子进程/材料清理测试 **2/2**；另用实际 detached node test group 验证 SIGTERM 到达 worker。尚未执行真实请求：当前进程缺少 Kimi Code 凭据，本地配置的环境引用亦未加载，已请求现有环境文件路径/部署引用。所需 secret 只在进程环境注入，不进 argv、日志或 Git，A0/M1 保持待验。worker 上限已推送 `a755301`；最终 P06 联合批次 **132/132** 与 server build 通过。

### 29.19 P09 R9 诊断与 cap 对照入口

Astra 发现标准 CLI 虽已有 trace sink，R9 子进程白名单却丢弃采样配置；原 request-samples 只有客户端 UUID 和结束后 PG 查询，不能当作分阶段证据。现显式校验/透传诊断采样，只在 diagnostic serial/request-samples 模式启用；结束后读取已关闭的 gateway 日志，按原 200 个 gateway measured UUID 与实例关联。缺失、重复、pending、span 丢弃和坏记录均保留，sink 未提供的丢弃计数标 unknown，不拿预热补数。

另补 `--diagnostic --cap-profile --no-build`，固定 c=200/60 秒，cap unset/empty 和 8 分别独立运行；输出 HTTP 200 完成延迟/成功吞吐、429 比例、错误、至少 100 成功样本的充分性及有界 host 资源采样。两臂仍须核相同 source/dist/harness 与资源，未自动选择容量；未观测的进程 CPU/IO 明示缺失。原四腿 30/10ms、完整 R9 的扩展比与 SSE 等门槛保持不变，诊断不冒充完整 acceptance。

Luna R9 定向 **32/32**、两个 runner 语法检查通过，未执行真实负载。实际诊断按方案等待 A0 首请求及候选冻结后进行，性能 gate 仍开放；没有据入口完成宣布优化收益。A0 验收脚本已推送 `7b978f6`。

### 29.20 远程权限门禁修复与冻结回归

远程 PG15/18 在 `c025d74` 复现 058 的 schema 函数执行总数旧预期：CP 现仅合法执行一个纯维度校验函数，测试仍要求总数零。相关六个正式测试现严格核总数 CP=1、GW=0，并要求唯一可执行函数的确签 OID、owner、immutable、非 security-definer 和 boolean 返回；原 helper、job 和授权写入拒绝全部保留，未扩大生产 grant。

另一个账户 lease 测试误以为 GW 对账号无任何 UPDATE；设计基线 `44b0eb7` 已允许调度器更新两列 threshold pause。现枚举全部实际可写列并核恰好两列，拒绝表级 UPDATE/INSERT/DELETE，敏感身份/供给/权利/授权列仍实测 42501。PostgreSQL 因列 UPDATE 允许空结果行锁，不能继续把 FOR UPDATE 当作权限拒绝证据。

Luna 真实 PG18 058 **11/11**、054 **4/4**、FIN057 **5/5**；按原 CI 同库前置顺序 authorization **13/13**、商业网关 HTTP **27/27**、055 **12/12**、056 **8/8**；lease 最新 **10/10**，对应严格编译与服务端构建通过。最初 055/056 省略 HTTP fixture 的运行记录为无效前置观察，未当作回归。冻结生产源码 `e87c7fa` 的规范 unit **7,027 条 / 7,004 pass / 0 fail / 23 skip**；最终 integration、两组 CI strict 和最新远程候选继续复核。

过程中还发现独立的 061 requeue 候选 gate 先要求当前 registry、再要求账本恰好 through061；061 明确未注册，且该候选不在当前 required CI 集合。未通过注册旧候选、删除检查或宽松计数使其假通过；撤回本轮对该候选的修改，记录为另行集成待办，不声称其业务验收成功。R9 诊断入口已推送 `e87c7fa`。

### 29.21 最终离线 integration 的 Gemini fixture 修正

完整 integration 暴露旧测试把 SSE 的 `event: message_start` 也当成 JSON data；新桥按 Anthropic 规范发完整事件后触发解析失败。fixture 改为按 SSE frame.data 读取并核 event 与 payload.type 一致，保留正文断言并补全生命周期和 usage；mock 终帧也改为 Gemini 原生 finishReason STOP，不能用 OpenAI `[DONE]` 冒充 Gemini 成功终态。未修改生产桥行为。

Luna 单文件 **5/5**，完整 integration 修后 **360 条 / 255 pass / 0 fail / 105 skip**；未配置的 PG/外部门禁跳过项不计通过。两组 CI strict 再次通过；unit 与 server 结果见 §29.20。权限修复已推送 `f9a91fd`。该远程候选 PG15/18 后续发现商户 gate 与既有 legacy 测试订单共享数据库的冲突，正调整测试隔离，生产无归属历史单的启用拒绝保持不变。

### 29.22 P07 商户 required gate 的独立数据库

Astra 确认共享 CI 财务 fixture 创建了无 binding 的历史支付/退款记录，商户 gate 的首次 enable 因全库 legacy 检查而正确拒绝；换 tenant 无法隔离全局 control。现将 merchant 执行移入既有 isolated required 矩阵，每个 PG15/18 job 使用独立 service/数据库，`httpFixture:false`；保留 shared 与 isolated 两组 strict、REQUIRED=1、三角色 URL、正常迁移及权限探针。未清理或猜测旧金融事实，未放松生产启用门槛。

Luna CI wiring **19/19**、两组严格编译通过，按相同正常 provision 顺序的 fresh PG18 商户 **5/5**、CP runtime probe **1/1** 通过。固定 isolated runner 明确只允许真实 GitHub 环境与其 service DNS，本地未伪造 CI 标志绕过；因此这仍需新候选的远程 PG15/18 实际确认。完整离线回归与代码构建见 §29.20–21。Gemini fixture 已推送 `7acecc2`。

### 29.23 目录与控制台精确 ACL，以及候选 CI 结果

商户隔离已推送 `8da5687`。[该候选 CI #141](https://github.com/elex-fu/model-router/actions/runs/40021778110) 的 shared PG15/18、PG16 deploy smoke、离线构建与浏览器 E2E 均通过；60 个独立门禁中 56 通过，4 个失败均为两个版本的 member-directory / member-directory-http 旧 EXECUTE 总数断言。独立商户门禁在 PG15/18 均实际通过。该 run 总结论仍为 failure，不能记录成完整候选通过。

两个目录 root 现要求 CP 总 EXECUTE=1，且唯一可执行函数必须是确切签名、migrator owner、immutable、非 security-definer、boolean 返回的纯维度 validator；保留最小 SELECT、禁止 schema CREATE 和前后 ACL 一致。Luna fresh PG18 HTTP 目录 **8/8**、非 HTTP 目录 **7/7** 通过。

同类盘点发现 console reconciliation 的旧测试误要求 CP 仅 SELECT 11 列且无任何 UPDATE。Astra 对照初始 `44b0eb7` 和当前角色模板确认：既有 worker/invoker 依赖的授权一直是精确 SELECT 14 列、UPDATE 5 列。测试现枚举完整列集合，仍拒绝表级 SELECT/UPDATE、任何列 INSERT、DELETE 与 schema CREATE；不修改生产 grant。`supply_profile_id` 在数据库层合法可读，不能再断言其 42501；公开 DTO 仍严格禁止该字段，未获准的内部列、whole-row、星号读取及 helper EXECUTE 继续要求 42501。

Luna 在同一 fresh PG18 数据库先跑真实本地 commercial HTTPS 前置 **27/27**，再跑 console root **6/6** 和 scoped strict，均通过；只读事务、金融/请求前后快照和跨 tenant/project 隔离断言保留，临时库与集群已清理。本次修正候选仍需完整远程 PG15/18 复验，不沿用 #141 的部分绿色代替。

P10 审计还确认两项可本地继续推进的证据缺口：真实 payment/refund worker SIGKILL 后原退款恢复，以及旧 Redis snapshot 恢复与真实 SaaS PG 金融/累计预算/hold/lease 联验。已由 Astra 细化设计、Sol 分别实现；不将它们全部归为外部阻塞。独立故障域 PG 同步恢复、真实 PSP、生产 KMS 和 Codex 计量契约仍另行待验，M1/M2/M3 均未关闭。

### 29.24 P10 原退款的真实进程崩溃恢复

新增独立 PG18 drill 和专用 child helper，使用真实受限 CP 服务/worker、正常完整迁移与 loopback synthetic PSP。首次提交属于正式 `requestPlatformWalletTopUpRefund` 服务调用，退款 worker 只负责查询恢复：PSP 将原退款受理事实 append 并 fsync 后挂起 ACK，先 SIGKILL 提交服务子进程；submit lease 自然到期后真实 worker 查询原退款，查询 ACK 再挂起并 SIGKILL 该 worker；第二次自然到期后新 worker 查询原 ID 完成。未重写金融事实、回拨 lease 时间或重新提交退款。

Luna scoped strict 与 fresh PG18 **1/1** 通过。充值与退款均为 **125 个最小货币单位（CNY 1.25）**；两次崩溃期间余额与退款冻结保留，最终余额 0、冻结和 lease 清空。PSP submit=1、query=2、持久受理事实=1；funding/refund 各一条账本交易，分录平衡，inbox 不变；原退款键重放与再跑 worker 均不新增金融效果。无模型 hold/dispatch 的场景显式断言为零，不能据此宣称模型推理故障矩阵通过。

Astra 在运行前发现 journal 的字面量换行错误并修正，查询现从 fsync 文件重读原受理事实，避免只写磁盘、实际仍靠内存 Map 恢复。演练使用真实 SIGKILL、自然 TTL、进程组和临时材料清理；runner 确认 sourceChanges=0、临时集群已停止并删除。证据为真实 PG 与持久 synthetic PSP，未调用真实支付宝或验收其商户契约。

目录/console 修正已推送 `0d3b286`。其候选 #142 已确认两个 PG 版本的非 HTTP 目录通过，后续发现结算 SIGKILL root 错把提交后的文本 marker 当成金融提交权威，正在修正并复验；该候选完整 CI 尚未通过。另已确认标准 runtime 关闭 listener 时过早 `closeAllConnections()` 可能截断在途 SSE，修复与真实 SIGTERM 演练由独立任务继续进行。

### 29.25 P10 已接受 SSE 的真实 SIGTERM drain

修复标准 managed runtime 在 shutdown 开始时强关所有 HTTP 连接的问题：同步进入 draining 并停止 listener 接受新连接，拒绝后续 HTTP/upgrade；等待已接受 gateway 原始 handler、listener 与 worker，保留 DB/KMS/Redis 直至金融处理和 capacity cleanup 完成。默认 30 秒期限后才强关自有 socket，再给 5 秒清理；仍未完成则 close 拒绝，信号退出码为 1，不能报告正常 drain 或擅自释放 unknown hold。

新增 shutdown helper 与 **5/5** 定向单元测试，Luna `build:server`、scoped strict 通过；fresh PG18.6 完整迁移、正常受限角色及 loopback HTTPS 的真实 managed 子进程 SIGTERM drill **1/1** 通过。父进程观察平台 SSE 首帧后发 SIGTERM，客户端仍收到完整终帧，随后核一次 attempt/usage/settlement、钱包最小单位 **1000→988**、账本平衡、hold settled 和无 held provider lease，最后正常退出。runner sourceChanges=[]，临时集群停止并删除；未执行实际 provider 或性能请求。

本次只证明已接受 HTTP/SSE 的 drain。Astra 第二眼发现另有 pending WS upgrade 鉴权未纳入关闭等待、CP/customer 原始异步 handler 未跟踪、最终资源关闭错误被吞及无界等待，已分配后续最小修复；WS 当前沿用立即 abort 语义，不能声称其有 30 秒续流保证。退款演练已推送 `d8f1472`；#142 最终为 shared 四项全过、isolated **59/60**，仅 PG18 结算 SIGKILL marker 断言失败，四个目录及两个商户门禁均已通过。

### 29.26 结算 COMMIT 后 marker 丢失的确定性恢复证明

`#142` 的 SIGKILL 首错来自观测竞态：child 先等待真实结算 COMMIT，再 append `settled` marker；两者之间被杀时，首次无 marker、恢复正确 `replayed`，旧测试却按文本要求恰一次 `settled`。现先执行全部真实 PG usage/settlement/账本/余额与平衡分录的精确一次检查，再严格验证原请求集合、run ID、sequence、首次合法 prefix 与恢复完整终态；不将日志缺失当作未提交，也不放宽数据库资金合同。

新增仅用于 drill child 的 IPC barrier，在第 2 项真实 `complete()` 返回、写 marker 前通知父进程并保活，由父明确 SIGKILL；恢复 run 不启用 barrier。测试必须观察恰好一个提交后 marker 丢失窗口，第二项恢复必须 `replayed`，后续未执行项才可 `settled`。没有添加任意 sleep、伪造 marker 或修改生产结算。

Luna 最新 scoped strict 与 fresh PG18.6 **1/1** 通过，实际输出 `1 committed before marker`，PG 精确一次与 replay 断言全部执行通过；runner sourceChanges=[]，临时集群停止并删除。此前随机窗口版本的 `0 committed before marker` 已由本次确定性结果取代。此证据限定为真实 PG 提交后应用确认丢失模拟，不冒充 PG 停机、网络 COMMIT ACK 丢失或独立故障域 WAL 恢复。SSE shutdown 修复已推送 `37b23f4`；完整新候选 CI 继续复验。

### 29.27 WS 升级鉴权的原始 promise 关闭边界

修复 WS upgrade 鉴权仍在使用数据库、连接已关闭而 gateway 提前宣告 close 完成的竞态。完整鉴权操作在调用前纳入原始 promise 集合，涵盖拒绝处理与 finally；close 同步停止新鉴权，并保留已连接 WS 的既有立即 abort 语义。鉴权返回后重验 stopped/socket.destroyed，禁止创建新 session；共享 close promise 等待原鉴权、真实 WS server close 与 engine cleanup 后才完成，不以连接计数或 socket 关闭代替。

Astra 源码审查无阻断，Luna 定向真实 socket 测试 **9/9**、scoped strict 通过，覆盖 deferred 鉴权、允许/拒绝/抛错、关闭后不再创建 engine、cleanup 等待和重复 close。未执行 server build、PG 或真实 Codex；不能将其记为 WS 续流或完整托管验收。CP/customer 原 handler 与最终资源关闭的后续修复仍在独立任务中。

结算确定性 barrier 已推送 `cf45917`。历史 [CI #143](https://github.com/elex-fu/model-router/actions/runs/40026002763) 与 `d8f1472` 精确绑定且 completed/success，包括全部 60 个独立门禁；它不包含之后的 SSE、barrier 或本次 WS 改动，不能外推为最新 head 完整通过。最新 `cf45917` 的正式 CI 结果仍待收齐。

### 29.28 控制台原 handler 与有界资源关闭

CP、customer 和 gateway wrapper 现返回真实异步 promise，由 listener 唯一入口跟踪到 settle。客户端 EOF、abort 或强关 socket 后仍等待原 handler 清理，不把 HTTP 连接结束当作业务完成。所有原业务、gateway 与 worker drain 完成后才进入最终资源关闭，保持依赖顺序；该阶段共享 5 秒预算，已结束但失败的 cleanup 最终返回脱敏拒绝，悬挂超时不再启动其后的 DB 关闭。重复 close 返回同一个缓存 promise。

Astra 独立源码复核通过；Luna shutdown helper **11/11**、实际 runtime 新增定向子集 **6/6** 通过。strict 首轮发现 provider close 允许同步 void、helper 却只接受 Promise，已仅修 callback 类型为 `void | PromiseLike<void>`，运行时仍统一 Promise 归一；scoped strict 重验通过。当前批次的新 server build、实际 Redis profile 与后续候选完整 CI 尚待执行，不能沿用 §29.25 旧版本的 PG SIGTERM 结果作为本批全链证明。

WS 鉴权关闭修复已推送 `64ac766`。此前 [CI #145](https://github.com/elex-fu/model-router/actions/runs/40026833443) 对 `cf45917` **64/64 jobs 全过**：四个 shared（含 offline/build/browser、PG15/18、PG16）与 60 个 isolated，确定性结算及目录/商户在两个版本均通过。它仍早于 WS 和本节资源关闭修复，最新 head 按各自 revision 复验。

人工 unknown 处理的真实 HTTP/PG 子场景已接入现商业 root，等待首次实际运行：使用正常 MFA、scanner、原受控上游证据、case/observation 与不可变 audit 双向引用，不造 session、case lease 或金融事实。源码审阅发现 HTTP 和 scanner 可能使用不同 reconciliation reference，保留严格 billing 比较并准备窄修设计，须先取得正常 PG 失败证据；未将该闭环标为通过。

### 29.29 修复正常 scanner 的原 hold 引用冲突

首次真实 PG18 人工处理运行确认：case 连续扫描 5 次仍 open，`lastErrorCode=IDEMPOTENCY_CONFLICT`。HTTP 已使用 `normal-success-unknown:…` 将 hold 标为 reconciliation_pending，scanner 又传 `unknown-outcome-case:…`，因此正确触发 billing 的严格引用比较。

现仅在 worker 的 platform capture 分支精确读取原 admission reservation，不提前加行锁：已 pending 必须有合法原持久引用并原样传入现 billing；reserved/null 保留原 case 引用路径。仍执行 billing 的钱包 fence、reservation 重读和状态检查，随后再次核对完整身份、币种、BigInt 金额、价格、状态及引用。没有跳过 billing、放宽其幂等比较或修改金融事实。异常事务回滚，不升级 case。

Astra 实际源码审查通过；Luna worker **24/24**、combined strict 通过。正常 PG18 复测已通过 scanner/operator_required、原 hold 身份/金额/价格/引用不变、真实 MFA、权限拒绝及 list/detail；完整 root **25/27**，仍在人工 resolve POST 返回 503。脱敏服务端日志明确首拒绝关系为 `saas_billing_group_spend_reservations`、SQLSTATE 42501，发现 CP 的既有 group-spend release 权限缺口，作为下一独立任务处理；未将本次部分通过记作完整人工闭环。

上述运行均保持正常迁移/受限角色、sourceChanges=[] 并清理临时集群。父计数放在 operator helper 后导致次生 3/4 的测试可观测性问题已分开修正，保留原四场景全部金融断言及 helper 原异常。资源关闭修复已推送 `c8e36d3`，其 [CI #147](https://github.com/elex-fu/model-router/actions/runs/40028090019) 已 **64/64 全过**；本节 worker 修复与后续人工处理、扩展故障 CI 仍按各自新候选验证。

### 29.30 两项进程故障演练接入 PG15/18 必需 CI

复用现有 isolated required matrix 新增 `payment-worker-sigkill`、`managed-saas-sigterm` 两个 selector，均 `httpFixture:false`。退款 drill 自建独立身份与商户 control，SSE parent 自行 fork 既有商业 child fixture，不重复预置 HTTP；保持净化环境、三受限角色、current/session principal、safe-role、全注册迁移、runtime privilege probe 与 virgin 数据库检查。

strict 清单显式加入两个 root 和退款 child；validator 为两 root 增加精确 prerequisite 与缺项负向检查，未放宽其他 root 的 `seedX` 规则。退款 test 原硬性 PG18 限制改为允许现正式矩阵的 PG15/18，标题和证据记录实际 server major；仅改变允许执行的版本范围，未改退款业务或 child。

Astra 四文件审查无阻断；Luna wiring **20/20**、isolated runner strict、两 drill/退款 child/merchant root strict 均通过。新增四个矩阵任务仍需本次新候选在远程实际执行成功，尚不能称 PG15 退款或 SSE 演练通过。原 PG18 本地证据见 §29.24–25。scanner 原引用修复已推送 `ab9fd83`；人工 resolve 的 billing-group 最小权限及非空 group release 证据在独立任务中继续推进，完整闭环仍未关闭。

### 29.31 CP billing-group release 的最小权限

人工 resolve 通过正常 workflow 调用 group-spend release，即使原请求无 group reservation，查询也必须具备权限。根据服务端 42501 关系标识及实际 release SQL，唯一 manifest 源新增 reservations/counters 的四组 **17 项列权限**，正式生成器同步 runtime 与部署角色 SQL。仅覆盖精确 SELECT 和 release UPDATE，不增加表级、INSERT、DELETE、EXECUTE 或 counter `charge_settled` 写权限；不删除 group release 来绕过失败。

Astra 五文件审查无阻断；Luna privilege unit **110/110**、exact strict 通过，正常 PG18 迁移、角色及启动阶段亦通过。为验证实际非空扣减，目标独立 key 在首 HTTP 前通过正常服务创建和绑定 daily group，未 SQL 插入 financial counter/reservation；该新增路径在抵达上游前失败，原 hold release 与 replay 尚未完成，不能据声明/probe 宣称整个闭环通过。

留存日志显示另一 `42501 / saas_billing_group_spend_counters`，未带请求子阶段。Astra 静态核对确认 GW 的真实 reserve upsert 还缺 `charge_currency/updated_at` UPDATE，reservation 还缺 `updated_at`，这是独立的精确权限缺口，下一任务修复；未将 WAIT_TIMEOUT 猜作配置错误或撤销非空验证。

新增进程故障 CI 已推送 `d4c1755`，[#149](https://github.com/elex-fu/model-router/actions/runs/40030304456) 的 refund SIGKILL、managed SIGTERM 在 **PG15/18 四项均实际通过**，全部 68 jobs 的终态仍待收齐。最新权限与 operator 流程继续按新候选验收。

### 29.32 GW 非空 group 准入的写列权限

根据真实 reserve upsert 及 release/settle SQL，GW manifest 精确增加 counters 的 `charge_currency/updated_at` UPDATE，以及 reservations 的 `updated_at` UPDATE，共三项。正式生成器同步两个输出；CP 的 17 项权限保持不变，不新增表级、INSERT、DELETE 或 EXECUTE。保留新 group 与真实准入，不用删除配置绕过这条此前未完成的非空路径。

Astra 五文件差分审查通过；Luna privilege unit **112/112**、combined strict 通过。非空 PG18 复测已抵达真实上游、正常 admission/scanner 与人工 resolve，未再次出现旧权限拒绝；完整 root **25/27**。首个事务错误转为观察记录的 `23514 / saas_unknown_outcome_observations_kind_shape`，Astra 已确认 operator observation INSERT 将 evidence reference 与 literal outcome 的位置写反，下一任务只修 producer，不改旧约束或迁移。

该 resolve 的钱包、group、request/attempt、audit 都属于同一事务；观察记录约束失败使整笔事务回滚，不能把其中临时释放当成已提交的 80→0，也未宣称 replay 通过。CP 权限修复已推送 `ddba2c4`。此前 `d4c1755` 的 [CI #149](https://github.com/elex-fu/model-router/actions/runs/40030304456) 最终 **68/68 全过**（4 main、64 isolated），仍不替代后续权限与 operator 新候选结果。

### 29.33 operator observation 的列值顺序修复

真实 PG 的 `23514` 来自 producer：INSERT 声明的 `evidence_reference, operator_outcome` 对应值写成 `'not_executed', $18`，将证据引用与 outcome 互换。现仅交换两值的位置，保留参数数组、同一事务内的写入顺序、历史迁移及原 shape 约束；不以放宽数据库约束接受错误记录。

回归测试解析实际 INSERT 的列与 VALUES token 并检查末尾九列的真实绑定，同时要求 audit 先于 observation、case 更新后于 observation；旧 SQL 必然失败，不能仅检查正确但未正确绑定的参数数组。Astra 实际差分审查通过，Luna worker **24/24**、worker/commercial/helper combined strict 通过。

随后 fresh PG18.6 正常迁移与受限角色下的非空 group commercial/operator root **27/27、零失败、零跳过**，完成真实 resolve 提交及重放；没有临时 grant、SQL seed 或 sourceChanges，集群已停止并删除。完整 HTTP/资金证据随下一独立 fixture 任务记录。GW 三项精确权限已推送 `69125a1`；其远程 CI #151 尚在执行，不将这次本地结果外推为新候选远程全过。

### 29.34 人工 unknown 的真实 HTTP、非空 group 与审计闭环

在既有商业 HTTP root 的受控 `platform / before_headers_cancel` 场景加入真实 operator 子流程。独立 key 在首次鉴权前通过正常服务创建并绑定 daily billing group；真实准入生成 **80 个最小货币单位（USD 0.80）** 的 group reservation，不 SQL seed 金融记录。原受控上游在收到请求后按约定等待取消且未执行；receipt/网络 abort 本身不作为真实 Provider 未执行证明，人工 evidence reference 只绑定这次 test-only 分支和原 attempt。

正常 scanner 必须先把原 unknown 收敛到 operator_required，并保持原 hold 的身份、金额、币种、价格和 reconciliation reference，以及原 group window/outstanding。管理员通过真实 bootstrap、MFA enrollment 和下一自然 TOTP step 登录，使用实际 HTTP list/detail/resolve；无 session、Origin/CSRF 缺失、跨 tenant、空或重复 coverage 均拒绝，且每次前后 financial/recovery snapshot 不变。

实际 resolve 提交后原 request/attempt failed、case resolved、钱包 hold released，group outstanding **80→0**、reservation released/settled_amount=0，`charge_settled` 保持 0。case 与 observation 指向同一不可变 `saas_audit_events`，actor、tenant、request、reason、ticket 和 evidence digest 一致；没有另造镜像审计表。相同请求重放返回 replayed 且全部快照不变，冲突内容返回 409，不新增 usage、settlement、账本扣费或上游 dispatch。

Luna latest fresh PG18.6 完整 root **27/27**、scoped strict 通过，原四种 HTTP fault 的金融断言全部保留。过程中的父计数次生失败和提前 HTTP 响应诊断已修，诊断仅输出允许的状态/code/SQLSTATE/关系或约束标识，不输出 SQL、原错误 message、凭据或请求体。runner init、完整迁移、正常角色、测试和 stop 均 exit 0，sourceChanges=[]，集群停止并删除。此处证明本地真实 PG、受限 CP/GW 与受控 loopback 上游闭环，不代表真实 Provider 人工证据契约或生产故障域恢复。producer 修复已独立推送 `687a3c9`。

此前 `69125a15b83e60c2d5ba2ef08aee9ed7e5efa993` 的 [CI #151](https://github.com/elex-fu/model-router/actions/runs/40032356820) 已终态 **68/68 success**（4 main、64 isolated），含 shared PG15/18、build/offline/browser、PG16 smoke 和新增四项进程故障门禁；早一候选 `ddba2c4` 的 #150 亦已成功。两者均早于本节及 producer 修复，最新候选仍按新 revision 收齐远程结果。

### 29.35 Redis 旧快照恢复与真实 SaaS PG 权威联验

新增互斥的 `--diagnostic --recovery-profile --no-build`，复用自有 PG、Redis、三个标准 dist CLI gateway 和 loopback HTTPS 上游，不运行 benchmark。真实 U 断流后保留 unknown/financial reconciliation_pending、原 hold 与累计预算；S 在 dispatching/持有 lease 时将容量写回 PG 并保存旧 RDB，随后正常结算。仅 SIGKILL 自有 Redis，再在同目录同端口恢复旧 RDB，原三个 CLI 持续存活。恢复后新 C 请求触发真实 PG hydration，并在其他实例重放 U/S。

Astra 实际差分审查通过；Luna 语法检查与纯单元 **5/5** 通过，随后在 `62b98a50b95a3fa0080ddf8faac0b104bed8ddae` 新构建 `build:server`，执行一次真实 profile。Node24.18.0、PG18.6、Redis8.10.2；artifact `ok=true / phase=complete`。旧 snapshot generation=1、pendingPersistence=0，实际 SIGKILL 后 Redis run ID 改变、共享 PG generation=2；source/dist/harness 前后 hash 全部一致，三项 changed 均 false。

U 保持一个原 unknown attempt、无 usage/settlement，provider lease released，capacity 保留8192 token，budget outstanding8192 token/20480 charge，原 hold reconciliation_pending20480。S/C 各一个成功 attempt、8 input+4 output，daily/lifetime settled delta 各 **+12 token/+28 charge**、钱包各扣28，结算账本分录平衡。最终累计行包括正常 smoke 基线，不能只按 S/C 两项之和解释。恢复前后 PG 金融快照相等；跨实例 U/S 重放分别202 unknown/200 completed，canonical ID 不变、不重复派发，重放前后全部请求、预算、hold、lease、usage、settlement 和账本快照相等；最终仅 U active。

原秒级软配额 bucket 已写回部分保持 `(1 request,8192 token)` 与 `(3 requests,24576 token)`，C 正常新增 bucket。此场景没有注入未刷写 mutation 丢失，`unflushedMutationLossTested=false / generalZeroLossClaim=false`；不能据此宣称普遍零 RPO、生产 HA、真实 Provider、KMS 或完整 R9 通过。cap unset、诊断采样关闭，performance/builtin/production-KMS acceptance 均 false。

脱敏证据：`/private/tmp/model-router-p10-redis-recovery-20261024-run-01/redis-saas-recovery.json` 与 `summary.json`。cleanup 确认所有自有进程停止、PG 停止、私有 runtime 删除。人工 HTTP 闭环已推送 `62b98a5`；真实 PG immediate stop/start 是下一独立工程/演练任务，仍须自然等待生产 stale recovery 时间，不把本节 Redis 恢复替代 PG 故障证据。

### 29.36 两实例暖缓存下的授权撤销闭环

在既有 required commercial root 加入一个正常 P01 provision 的独立 platform scope、两把 Key、两个正常 managed gateway 和三个串行场景。保留默认 5 秒正向缓存，透明统计真实 `KeyService.authenticate` 调用并观察原 prelock 拒绝，不注入缓存、不改 TTL。此处证明旧缓存仍命中时由 PG 权威拒绝新准入，不证明主动清除缓存或新增 tenant/entitlement fence 竞态；已有 prelock 竞态门禁仍独立保留。

首次 strict 发现 attestation 版本类型不符，按原 canonical 合同将其规范为字符串。首次真实 PG 在 P01 setup 返回 INVALID_INPUT：原 provider 定义展开 customer 定义夹带 `customerPriceVersion`，同时 P01 的 decimal 版本字段要求字符串。新 helper 改为显式合法 provider DTO，并将 route/customer/provider 版本规范为字符串，保留原商业 fixture 与生产 exact/decimal 校验。没有以放宽生产校验、手工 entitlement 或假 operation 绕过。

Astra 实际差分复核通过。Luna exact scoped strict 通过，随后 fresh PG18.6 完整 commercial root **30/30、零失败/跳过**，正常完整迁移与三受限角色。三个场景结果：

- Tenant suspend 后两个暖 gateway 均503 `REQUEST_BLOCKED / admission / storage_failure`，实际 prelock `SaasAdmissionAuthorizationError` 恰好两次；source authenticate 不增加。正常 resume 后两个实例重新成功结算。
- Key A revoke 后状态 revoked、authz version 精确+1；两个暖实例同样在真实 prelock 拒绝，Key B 在两实例继续成功。
- 原 P01 operation 正常 disable 后 phase=disabled、entitlement disabled/version精确+1，project policy仍 active；两个暖实例均403 `REQUEST_REJECTED / entitlement / entitlement_denied`，source authenticate不增加。

每次拒绝的11张 tenant-scoped request/attempt/reservation/usage/settlement/ledger/wallet/lease/capacity/idempotency 全行快照与上游 dispatch 计数均不变；各正常 mutation 的不可变审计分别+1，P01 action 精确为 `platform_inference_access.disabled.risk_control`。503 为当前授权错误映射的实际观察，必须结合真实 prelock 拒绝原因，不能把任意503当作撤销通过。原 FIN、operator 与 SIGTERM early return 保留，子场景失败会原样抛首错并还原 observer，避免共享 tenant 级联失败。

本轮证据目录 `/private/tmp/model-router-commercial-postgres-authrev-20261024-run-02`；runner 所有阶段 exit0、sourceChanges=[]，集群停止并删除。Redis 候选 `f14b6f5a593a72e2309014202433ff3e1bf8842c` 的 [CI #154](https://github.com/elex-fu/model-router/actions/runs/40034010137) 已 **68/68 success**，含64 isolated、shared PG15/18、四项进程故障和 browser E2E；该远程候选早于本节测试及后续连接池修复，最新 revision 继续单独验收。

### 29.37 PG 断连时原生 Pool 与 checked-out client 的错误边界

PG recovery run-02 真实执行自有 `pg_ctl -m immediate stop` 成功，随后 gateway-1 exit1：pg8.23.0 / pg-pool3.14.0 的 idleListener 在剔除坏连接后发出 Pool `error`，数据库封装未监听，EventEmitter 将 `Connection terminated unexpectedly` 变成进程级未处理错误。该轮未完成三路 fail-closed、scanner 或恢复，不能记录为 PG 恢复通过；artifact `/private/tmp/model-router-p10-postgres-recovery-20261024-run-02`，cleanup全true、source/dist/harnessChanged全false。

生产修复仅在原 database wrapper 中覆盖同一连接生命周期：原生 Pool 构造后立即消费 idle error 通知，不抛出、不记录原 error/client/DSN；checked-out client 从取得到 release 由 owner listener 保留首连接错误，后续普通/预编译 query 直接以同一原错误拒绝，不再发送。原 active query/COMMIT 的 driver promise 拒绝保持，rollback 错误不覆盖原 COMMIT 错误；坏 client 强制 discard，交回 driver listener 后移除 owner，避免监听空窗。没有新增重试、Promise.race、process级吞错、应用重启或金融成功推断。

Astra 对生产文件与新 native-pool test 实际差分复核通过。Luna 新原生 wrapper 测试7项加既有 database15项，共 **22/22**，exact scoped strict通过，owned两文件前后hash一致。测试使用真实wrapper构造与替换native IO，覆盖 idle、checked-out active/gap、prepared、COMMIT/ROLLBACK、无重复发送和 listener handoff；不是实际 PG 恢复证据。新 server build 与完整原 PG profile run-03 仍待执行，600秒 stale recovery、资金及租约断言保持不变。暖缓存撤销证据已独立推送 `a246be9`。

### 29.38 确定撤销的 typed 403 映射

§29.36 真实场景暴露确定授权撤销被报告为503。Astra核对现有契约：prelock已经区分 `authorization_denied` 与 `storage_failure`，ports catch遗漏前者，最终落入通用blocked；HTTP本来就将reject映403、block映503。修复只在该catch精确匹配 `instanceof SaasAdmissionAuthorizationError && code==='authorization_denied'`，返回现 `caller_denied` 和固定通用文案，不披露 tenant/Key 状态或原 error/cause。

typed storage failure、unsupported policy、伪造同名普通对象、SQLSTATE42501和08006继续原blocked路径；不修改HTTP handler、权限锁、缓存、重试或授权策略。暖缓存helper仅把tenant/Key的HTTP期望更新为403 `REQUEST_REJECTED / admission / caller_denied`，保留实际prelock拒绝次数、source无reload、全部金融/派发零变化、正常resume/KeyB与版本/审计断言。entitlement已有403不变。

Astra三文件实际复核通过；Luna ports定向 **21/21**、覆盖ports/unit/commercial与两个helper的exact strict通过，三owned文件前后hash不变。新增六类错误对照在事务中先创建HMAC claim再以原sentinel回滚，并要求meter、billing、capacity及guard均未调用。§29.36 的30/30仍是旧503映射证据，新403的真实PG商业root与新serverbuild在下一冻结批次验证，不互借结果。连接池修复已独立推送 `3a46a53`。

后续冻结 `7e4fd2852876671672688e7fcdf5a91704f8c640` 新 `build:server` 已通过：789个src文件前后无变化，仅7个生成输出变化，新pool与ports实现确已进入dist，13项harness hash保持一致。Luna随后fresh PG18.6完整commercial **30/30**：三个撤销场景两实例均403，tenant/Key为admission/caller_denied、entitlement仍entitlement/entitlement_denied；所有原prelock次数、暖cache/source不重验、11表零变化、resume/B与版本审计断言通过。sourceChanges=[]、集群停止删除。证据 `/private/tmp/model-router-commercial-postgres-authrev-20261024-run-03`，构建完整清单 `/private/tmp/model-router-build-provenance-20261024-{before,after,comparison}.json`。这份新映射证据取代旧503预期的当前结论，历史运行保留。

### 29.39 真实 PostgreSQL wire COMMIT ACK 丢失与原输入重放

Astra审计确认原 `cf45917` 是客户端已收到COMMIT成功、应用marker随后丢失，现有after_commit fake fault也先await真实query成功，均不能证明网络层COMMIT回包丢失。新增独立tenant的top-level settlement drill，保留原SIGKILL/REQUESTS/child/barrier/marker与金融强断言。唯一目标gateway连接经过自有单连接PG协议代理；原样转发COMMIT，只有观察到完整backend `CommandComplete(COMMIT)` 后才扣留该frame及同包后续ReadyForQuery并断开socket，观察与重放始终独立直连。

实现处理分帧/合帧与长度边界，不记录SQL、参数或凭据。沿用原三role URL同endpoint/database校验；proxy仅监听127.0.0.1，upstream仅允许原本地测试目标或精确CI tuple `postgres:5432/model_router_saas_ci`，不伪造CI标记、不加skip、不放宽required runner。初审发现的loopback-only会使正式PG15/18用例必失败的问题在实际运行前修正，并增加允许/拒绝目标的负向测试。

Astra实际差分复核通过；Luna proxy纯unit **5/5**、三roots exact strict通过。随后fresh PG18.6完整settlement root **2/2**通过，正常全迁移/角色、无临时grant。原SIGKILL仍观察`1/4 committed`且`1 committed before marker`；新ACK场景原生COMMIT确以socket连接错误拒绝，同时四证据严格为forwarded=true、serverCommitObserved=true、backendCommitForwarded=false、connectionCut=true。

独立只读PG确认原request succeeded/settled、原attempt/reservation ID不变、hold settled12、钱包最小单位 **100→88**、唯一结算/关联账本及平衡分录。新直连用完全相同原输入返回replayed/同attempt ID，selected request/attempt/hold/usage/settlement/ledger/wallet/evidence/lease/capacity/idempotency快照完全相等，不新增金融效果。这里没有真实上游、PSP或占用中provider lease，不将其外推为该类故障证明。

证据 `/private/tmp/model-router-settlement-ack-postgres-20261024-run-01`，所有runner阶段exit0、sourceChanges=[]，集群停止删除。日志保留一条非fatal的pg未来版本并发query弃用提示，实际断言全部通过。此项补足本地真实wire ACK窗口，不代表独立故障域/WAL/PITR恢复；PG immediate stop/start的完整scanner/600秒自然恢复仍由下一独立profile验收。

随后 `73611600cdced47a2baae9dfe37cc3b0281233c4` 的正式 [CI #158](https://github.com/elex-fu/model-router/actions/runs/40038151848) 中，PG15/18两个settlement job均实际执行原SIGKILL和新wireACK，逐日志核各 **2/2、0 fail、0 skip**。原marker窗口及nativeCommitRejected=true、backendCommitForwarded=false、connectionCut=true、snapshotUnchanged=true均通过。该run随后终态 **68/68 success**（4 main、64 isolated），零失败/取消/跳过；后续profile与最终文档候选仍按各自revision收齐CI，不借用736的绿色。

### 29.40 自有 PG immediate-stop profile 的工程交付与待授权验证

新增互斥 `--diagnostic --postgres-recovery-profile --no-build`，复用自有R9的PG、Redis、三标准gateway和loopback上游，额外启动标准control-plane原恢复扫描器。保持原600000ms stale horizon、5秒cadence及15分钟观察期限：首帧后核原dispatching/hold/live lease，仅停自有PG，待上游自然归零，三实例新请求fail closed且不增派发；同目录同端口restart后核DB身份/重启时间/fsync/synchronous_commit和原资金快照；正常scanner/operator_required、原unknown/hold/预算精确保留、过期held lease的liveHeld=0、跨实例202原canonical重放、新C精确一次结算均须实际通过。只读观察、有界超时、信号中断和自有进程清理保留，不改生产TTL、时间或金融SQL；不运行benchmark。

Astra实际差分复核通过；Luna三syntax、PG6+原Redis5共 **11/11**，source/dist/harness冻结，新7e serverbuild已具备。最小复用仅为Redis helper导出readonly authority别名，原Redis断言和原serial/cap/full性能门槛未改。工程实现与方案已可审阅；完整实际PG恢复门禁尚未通过。

真实尝试及处理方式：

- run-01误用CP platform `/readyz`导致就绪超时，尚未stop；对照正式Compose改为双owned TCP+child存活，后续scanner证明仍强制。
- run-02真实immediate stop后gateway因idle pool未处理error退出；§29.37已修Pool/checked-out生命周期并完成22项检查，新build已包含。该轮没有完成恢复断言。
- run-03默认sandbox在loopback监听处EPERM，未到PGsetup。`summary.json`记录source/dist/harnessChanged=false，cleanup三项true，不能计作应用或恢复通过。
- run-04的require_escalated启动被自动审批拒绝，理由是早先“不要测试验证了”仍被视为有效，缺直接用户对PG急停恢复的授权。服务未启动、目录和工件未创建。已向用户请求一次仅自有临时环境的直接授权；答复前不重试、不通过其他工具或CI绕过。继续整理文档与已有交付。

run-01/02/03证据目录均为 `/private/tmp/model-router-p10-postgres-recovery-20261024-run-XX`。当前完整PG恢复是明确的本地待授权项，不能全部归为生产外部资源阻塞；实际Provider/PSP、生产KMS/独立同步故障域/PITR、Codex契约和R9性能仍各自开放，M1/M2/M3均未关闭。

本节工程checkpoint为 `5448f32`，与方案状态同步分开提交，并已纳入工程候选 `701761eb1ea6adf318ada6665e8569d3c1f07d18`。该确切候选的 [CI #159](https://github.com/elex-fu/model-router/actions/runs/40039329176) 已完整 **68/68 success**；这不代表本节完整实际PG恢复已通过。后续仅Markdown状态收口，runtime/source/harness保持该工程候选，不把其绿色转记为文档子commit已有CI。

### 29.41 工程候选冻结与最终文档交付边界

当前工程候选为 `701761eb1ea6adf318ada6665e8569d3c1f07d18`，包含 `5448f32` PG恢复profile及此前独立任务。只读收集 [CI #159](https://github.com/elex-fu/model-router/actions/runs/40039329176) 终态：API total_count=68、returned=68，**4 main + 64 isolated全部completed/success**，含PG15/18 settlement任务。此前§29.39中736候选的wire ACK逐日志证据保留，不互换revision。

本次后续收口只修改本进度与P0技术方案两个Markdown文件，工程源码和恢复脚本保持701，server源码保持7e同src。文档单独提交、推送到当前任务分支，不宣称其子commit已有CI，也不为持续改写文档触发新的本地验证。

已完成工程与已有分层证据见§29.34–40：人工unknown/非空group释放、Redis旧快照恢复、两实例暖缓存撤销typed403、PG连接池错误生命周期、真实wire COMMIT ACK丢失重放，以及PG急停恢复profile。profile的完整自然600秒恢复仍未通过；run-01/02真实失败、run-03 sandbox EPERM和run-04自动审批拒绝均保留。因早先“不要测试验证了”的限制，已请求直接用户授权，答复前不再本地测试、构建或通过其他执行入口绕过。

M1/M2/M3继续开放。下一处理顺序为：取得本地PG急停恢复的直接授权后执行原profile；取得有效供给引用完成A0真实首请求与指定CLI流程；补齐真实PSP、生产KMS/IAM、独立同步故障域/PITR、Codex可信计量/后端契约及受控R9窗口。候选CI通过与本地受控证据不构成运营发布验收。

### 29.42 Codex 准入与发送重验的 compiler version 一致性

续轮以`3f9e1c789a97ed16c04a2caaeae5bf32e947e28c`为当前源码进行只读审计，发现一项不依赖真实后端合同的确定接线错误：builtin runtime准入使用`builtin-gateway-payload/v1`，但实际transport在凭据使用前重验cb1时传入通用`provider-payload-compiler/v1`。两者进入同一内容寻址版本公式，因版本不同，未来同一reviewed profile也无法通过；当前空registry掩盖这条运行路径，不能据此认为未来接纳profile即可自动工作。

Astra给出最小设计、Sol仅改三个生产文件：新增无imports叶子`src/saas/runtime/builtin-payload-compiler-version.ts`，导出原有builtin版本；runtime编译参数与transport发送重验统一引用该常量。没有反向依赖runtime，不引入循环。通用compiler默认版本、cb1摘要算法、claimed DB/proof比较、profile精确scope/过期/撤销检查和空registry硬拒绝保持。

Astra对实际三文件差分源码复核通过；未添加或运行测试、构建、类型检查、语法检查或服务，不借用701的旧CI作为新代码验证。此项按独立任务提交远程，后续代码需要新的验证证据；真实Codex计量/enforcement合同、HTTP/WS/compact/remote-history工作流与多实例KMS验收继续开放。此前PG演练的直接授权请求未获答复，仍不重试或绕过。

### 29.43 Codex SSE 完整事件的 UTF-8 字节上限

Astra从`CodexHttpTransport.send`的真实draining relay追到`ResponsesUsageWatcher`及prepared adapter的usage evidence消费，确认旧`feed`先消费并解析完整事件，再检查剩余buffer长度。单chunk内超过1MiB的完整terminal可使buffer清空，既绕过上限又形成complete evidence；JS string.length对多字节正文也不能表达字节上限。这是生产用量证据缺口，不依赖真实后端合同即可修复。

Sol仅改`src/saas/gateway/codex/transport.ts`中的该class：每个完整block在`acceptBlock`/JSON解析前以`Buffer.byteLength(block,'utf8')`检查原1_048_576上限，超限置现有sticky invalid并跳过；未完整残余buffer也按UTF-8字节限长。分隔符不计正文、每事件恰好上限仍允许，同chunk多个合法小事件不因总量而拒绝。超限前后再出现合法terminal也不能恢复observed或complete，仍走既有incomplete-malformed证据。decoder、边界查找、终态重复规则、relay和native WS frame fence均未改。

Astra只读实际差分复核通过；按用户既有要求未添加或运行测试、构建、类型检查、语法检查或服务。源码回归规格留待获准后执行：完整/跨chunk超大事件、多字节超限、合法终态前后sticky invalid、多小帧总量超限但各自合法，以及精确上限边界。本任务与§29.42编译器版本修复分commit交付；这些源码修复没有新运行证据，不能继承701/旧消费端测试绿色，M1/M2/M3仍开放。

### 29.44 Codex 按精确 catalog scope 计算逐工作流财务就绪

继§29.42的版本接线修复后，Astra进一步确认C4仍有可在真实合同前完成的代码：builtin固定将Codex标记为usage unavailable，使未来合法profile也不能反映就绪；projection又以全局profile count判断四行，若只移除固定项就会误将HTTP覆盖抬升为WS/compact可用。因此同时修正事实来源与逐行投影，不能只删除保守拒绝。

Sol实现四个runtime文件：新增`codex-workflow-financial-readiness.ts`；collector在原provider聚合之外保留eligible Codex catalog精确tuple；runtime基于当前tuple计算financial map；projection逐行只读取自身显式true。模型取`saas_public_model_versions.model`而非public alias，保留所有active版本以覆盖旧route pin；active product/public model/version、endpoint_scope及最新capability共同限定候选。capability先按原四元组取最新version，再判supported/verified/responses，不能回退到旧的成功版本。坏观测保留null，空集、未知或坏tuple均全部false，不静默过滤后证明剩余子集。

同一次收集以同一now调用现production trusted-profile resolver：HTTP full、WS full、compact分别精确endpoint/operation/transport/mode；WS continuation同时要求canonical-replay与remote-history。每行要求非空候选集合全部覆盖，bundle按runtime原声明的三项及可选compact全部覆盖汇总，不能用some或全局count提升整体。financial map复制并freeze；transport装配、credential verified与独立live workflow证据互不抬升。实际send/provision/计量compiler/registry/proof不改，registry仍空，默认四行false。这只是已知catalog范围的静态覆盖，不证明tenant entitlement/价格/任意composite route已准入。

Astra实际四文件差分复核通过；另一Astra独立核对008 schema、正式角色模板与runtime privilege manifest，确认新SQL字段/关系存在、CP/GW既有SELECT足够，无迁移、manifest或grant变更。既有collector fixture仅新增对该SQL的精确分发（旧fixture返回空候选），严格查询次数4→5；原四路分发和其他断言保留，不新增用例。未运行测试、构建、类型检查、语法检查、DB或服务；源码复核不能替代运行验收。

此前两个独立修复已推送`92f477a`（§29.42）和`7718c49`（§29.43）；本项另独立提交。PG急停恢复授权、真实Codex计量合同/工作流、多实例KMS及M1/M2/M3全部继续开放。后续如读取自动push CI，只按确切SHA记录，不以旧基线绿色替代新源码证据，也不主动dispatch或重跑验证。

### 29.45 Codex 三项交付的确切候选 CI 与剩余门禁

§29.42–44三项分别已提交并推送当前任务分支：`92f477a`统一builtin准入/发送的compiler version，`7718c49`修复SSE完整事件的UTF-8字节上限，`87cc8b4`实现精确catalog scope的逐工作流财务就绪。源码设计与修改分别由Astra/Sol完成，Astra实际差分及schema/既有权限复核均通过。

Luna只读跟踪自动push产生的 [CI #161](https://github.com/elex-fu/model-router/actions/runs/40041486469)，确切SHA `7718c49aa3d61be003dc75dfba2928b044f96f84` 最终 **68/68 success**，覆盖前两项。随后同样只读跟踪 [CI #162](https://github.com/elex-fu/model-router/actions/runs/40042216960)，确切工程候选 `87cc8b4154e8b0edacf35b605ae38d9e434cc5ee` 最终 **68/68 completed/success**：API per_page=100、total_count=68、returned=68，4 main+64 isolated全部通过，无失败、跳过或取消，PG15/18 settlement SIGKILL均success。没有dispatch、rerun、cancel或本地验证，不把早期4项主job快照当成完整矩阵。

这份新候选CI取代§29.42–44交付时“只有源码复核、尚无新CI”的当前状态，原时间点记录保留。它证明现有必需CI在该revision通过；本轮未新增§29.43所列专项用例，也未取得这些规格逐项通过的独立记录，没有接纳任何真实Codex正向profile，不能据此宣称真实ChatGPT计量/enforcement、HTTP/WS/compact/remote-history工作流或多实例KMS已验收。registry仍为空、财务缺证继续拒绝。

本次后续状态收口仅修改P0技术方案与本进度两个Markdown，runtime/source/harness冻结在87候选；文档单独提交推送，不将87的CI转记为文档子commit已有CI，不为持续记录文档本身制造验证循环。本地dist没有在本轮重新构建，不能当作87的运行产物。

剩余处理保持原范围：本地PG immediate-stop/start的自然600秒恢复及新的专项验证须先获直接用户授权；A0仍须有效供给引用及真实正式首请求；真实Alipay交易/回调/退款、生产KMS/IAM、独立同步PG故障域及PITR、Codex精确后端合同/真实CLI和受控R9窗口尚缺证据。自动审批此前因“不要测试验证了”拒绝PG演练的边界仍有效，授权问题尚未获答；不重试、不改用其它入口绕过。M1/M2/M3和可收费运营GO均未关闭，完整P0不能标记完成。

### 29.46 A0 正式 Kimi 首请求脚本的 P01 DTO 窄修

用户提供现有凭据配置引用`/Users/lex/.model-router/config.json`后，先只读核对正常loader与A0入口，发现可在任何真实模型调用前修复的确定障碍：`scripts/ops/verify-platform-access-first-request.ts`的customer/provider/route publicModelVersion使用数字，而P01要求十进制字符串；provider policy又展开customer policy，夹带exact DTO不允许的customerPriceVersion。原流程在P01之前先运行真实credential onboarding probe，直接执行会先产生一次真实探针再遭本地INVALID_INPUT。

Astra核对现P01及已修暖缓存fixture后设计，Sol仅改原A0脚本：三处模型版本使用`'1'`，provider policy显式投影12个公共policy字段及4个provider字段。pricing服务允许的数字版本、attestation原字符串版本与签名输入、pool/capacity revision、worker→verified→pool member→P01→显式创建Key→真实请求的正常链路保持。没有放宽生产exact/decimal校验、seed entitlement、另建preflight框架或重排需要已验证账户的流程。

Astra实际源码差分复核通过；本项未新增或运行测试、构建、类型检查、服务、探针或真实生成，仅修复已证本地DTO障碍，不能记作A0通过。正式入口仍是`run-commercial-postgres-gate.mjs --suite platform-access`，需隔离PG及当前server dist；预期一次max_tokens=8 onboarding probe和一次max_tokens=32短生成，真实执行尚未发生。

配置脱敏核对确认schemaVersion=2、两个enabled Kimi credential均为`{type:'env',name:'KIMI_CODE_API_KEY'}`，JSON保存引用而非inline材料。本轮当前进程及launchd均未加载该变量；没有读取其它secret、构造会写库的ControlStore、猜credential ID或打印凭据。已向用户询问该变量的实际环境文件/服务引用；继续处理独立源码任务，真实A0门禁仍开放。用户另明确授权的一次PG故障验证及结果单独记录，不外推为其它本地测试或生产动作授权。

后续用户直接回复“`KIMI_CODE_API_KEY` 已填写”，再次脱敏读取所指配置发现材料已填入 `secret.name`，该字段原合同表示环境变量名。当前判断更新为材料已提供、尚未验证有效性；不再以初次引用未加载的快照作为当前阻塞。既有配置不改写，后续仅从指定文件读取并临时注入有界 A0 runner/测试父进程，不输出或保存明文、不放入命令参数；迁移及其它非测试子进程的环境隔离单独修复并审阅。真实探针、短生成及 A0 正常运营链仍须实际执行，不能把提供材料视为验收通过。

### 29.47 获直接授权的 PG run05：自然恢复已达 scanner，重放租约断言失败

用户直接答复“明确允许这次本地故障验证”，解除此前针对该动作的审批阻塞。本次仅启动自有临时PG/Redis/网关/标准CP及loopback受控上游，不接触生产或真实供应商。Luna先执行一次必要的fresh server build，HEAD为`ed886a3c4c369d125b59e26722012fdd344a87e2`、server源码与工程87相同；src 791文件、dist 3160文件及13项harness的前后精确hash均稳定。构建记录为`/private/tmp/model-router-p10-postgres-recovery-20261024-run-05-build-provenance.json`，不能用后续源码修复继承这份构建结果。

唯一run05的原session为47884，实际完成自有PG immediate stop及同目录/同端口restart；原请求自然断流，未由client deadline中断。停机期三实例新请求均503、mock新增请求0且in-flight=0；PG数据库/地址/端口/18.6版本、fsync=on和synchronous_commit=on保持，postmaster start time改变。自然等待原600000ms及扫描cadence后，正常scanner生成恰好一个operator_required case、lastError=null。没有缩短生产TTL或改金融SQL。

约603秒后在canonical-replay阶段退出1：原canonical202/header/body的前置断言已过，随后全authority严格快照比较失败。diff显示原lease（fence19）由stored held变为expired，并新增四条released lease（fence35/37/39/41）；新增attempt ID不在已记录的业务attempt集合中。工件只有lease id/fence/status/attemptId，缺owner/account及health fencing关联，不能把这四行直接认定为probe。旧代码在比较之后才赋afterReplay/mock计数证据，因此完整afterReplay未落盘、mock零新增比较尚未执行；fresh C也未执行。此轮不能记为完整重放、完整金融恢复或PG门禁通过。

Astra源码定位发现prepare先scheduler.select/selectAndBind、后admission幂等claim；stale调度探针会生成独立UUID、获取/释放租约并记录probe_success，不调用provider transport、也不创建业务attempt。这能解释一类差异，但不能补齐run05具体行的缺失来源证据。另发现旧late-existing分支早于authorization prelock及IP检查返回，作为共享准备链的真实代码问题继续处理。当前通用修复设计是在scheduler前经同事务prelock、新鲜entitlement/IP及HMAC只读lookup，以当前已授权候选真实重编译并核验完整指纹后返回canonical；晚期claim竞争也须复用同一授权合同。实现、源码审阅及后续验证另记，不能以同构候选shortcut或放宽租约断言替代。

先独立修复失败可观测性：PG profile在任何replay比较前记录安全canonical固定字段、actual afterReplay authority及同一次mock totals，finally保留首错事实。Astra实际单文件差分复核通过；202/原ID/完整JSON/全authority含lease深比较及mock新增0的原断言均保留，无classifier、租约过滤、过期例外、新SQL或权限变更。此补丁不能追补run05丢失的事实，修改后尚未重跑。没有执行第二次PG故障周期或其它本地测试。

run05的summary/recovery/progress位于`/private/tmp/model-router-p10-postgres-recovery-20261024-run-05/`。cleanup三项均true：所有自有进程停止、PG停止、私有runtime删除；source/dist/harnessChanged全部false，最终精确manifest与fresh build一致。P10完整恢复仍失败，M1/M2/M3及生产故障域/PITR等验收继续开放。后续先完成保持原严格门槛的生产源码修复，再明确后续回归和新增故障周期的授权范围。

### 29.48 A0 runner 的临时凭据作用域与有界调用路径

用户已提供指定配置材料，A0 DTO 修复 `e1adeb6` 已推送。Luna仅只读核对正式 `--suite platform-access` 入口及真实调用路径，发现runner原将整个环境传给迁移CLI，默认PG工具与两处版本查询也会继承临时 `KIMI_CODE_API_KEY`，这些进程均不需要供应商凭据。

Sol仅改 `scripts/run-commercial-postgres-gate.mjs`：从原环境复制非suite子进程环境并仅移除该变量，作为 `run` 默认值及两个 `spawnSync` 的显式环境；迁移仍复制suite环境并显式移除变量。suite测试父进程继续保留临时变量，正常fixture封装数据库凭据及built CLI白名单环境路径不改。Astra全文件核对一个 `spawn`、两个 `spawnSync` 及所有显式环境调用，未遗漏runner直接启动的非suite子进程；没有新增明文参数、文件或日志。此结论限于已审源码，不能泛称任意测试下游进程均自动安全。

调用预算由源码路径推导：单新账户、validation worker `MAX_ATTEMPTS=1`、验证job要求attempt_count恰1，探针只调用一次fetch且max_tokens=8；生成只有一次post，capacity retryBudget=0/remainingAttempts=1、transport无内置重发，max_tokens=32。名义上最多两次模型HTTP调用，输出上限合计40 tokens，不包含输入或供应商实际费用；`providerInferenceCallsExpected=2`只是诊断字段，并非实际网络计数器。任何失败都不得自动重新执行已消耗的探针或生成。

本项只做源码修改与只读审阅，未新增或运行测试、构建、服务或供应商调用。A0须待当前生产源码冻结并审查完成后，按用户提供材料对应的一次探针和一次短生成范围推进；必要当前构建与真实结果另记，不扩大成其它回归、PG故障周期或生产操作。PG诊断修复 `4858757` 已独立推送，严格恢复门槛及M1/M2/M3状态不变。
