# 开发进度报告 — 2026-10-18（T05 + 真实模型验证）

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
