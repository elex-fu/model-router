# 迭代进度快照：2026-10-09（M0 / Track A 启动）

> 基准方案：`docs/parallel-iteration-plan-2026-10-10.md`（串行执行模式）；冻结契约：`docs/contracts-m0-freeze.md`。
> 本文只记录本轮会话实际完成与验证结果；每项附验证方式。全量基线：`npm test` = 3057 单测（3039 pass / 0 fail，其余为未配置 E2E env 的本地 skip）+ 224 集成（195 pass / 0 fail）；`npx tsc --noEmit` 干净。
> 2026-10-10 更新（A4 完成后）：全量 `npm test` = 3074 单测（3056 pass / 0 fail）+ 225 集成（195 pass / 0 fail）；`npx tsc --noEmit` 干净；本地 PG18 scratch 集群首次真实执行 FIN057/FIN063/060/SIGKILL/KEY080 门禁全绿（见 A4 节）。

## 已完成

### M0：契约冻结（任务 #2）
- `docs/contracts-m0-freeze.md`：C-1 usage 更正、C-2 KMS loader、C-3 EasyPay、C-4 key 策略 DTO、C-5 webhook entitlement、C-6 营销台账钩子、C-7 调度 priority/weight，迁移编号段登记（061 inactive / 062 reserved / 063 已分配 / 064-065 D / 066-067 E / 068-069 F / 070-079 G）。
- 决策记录：PSP = 易支付（mapi 直付，MD5 签名弱点以强制主动 QueryOrder 对冲；无退款查询 → 永久 unknown 进人工对账）；KMS = 软件模块先行（pilot-only），云 KMS 为 M3 决策门。

### A2：FIN-01 usage 更正入口（任务 #3，新代码）
- 迁移 063 `saas_usage_correction_events`（append-only，digest UNIQUE）；`saas_ledger_transactions.source_type` 增加 `usage_correction` 分支（CHECK 重挂）。
- `src/saas/metering/usage-correction.ts`：digest 寻址幂等（`ON CONFLICT (correction_digest) DO NOTHING` → replay），advisory xact fence 串行化（control-plane 无 `saas_requests` UPDATE 权限，不用 FOR UPDATE），platform 非零 delta 同事务走 `PlatformWalletLedgerService.postUsageCorrection`（`metering.usage-correction` namespace，business_key=digest），负余额 fail-closed，BYOK 仅事件（delta 必须为 0），reconciliation pending 拒绝更正。
- 审计（C-1.4）：创建时同事务写 `saas_audit_events`（`usage_correction_recorded` / `platform_metering`）；operator_identity 必须满足 actor FK（uuid 形态校验）。
- 平台 HTTP 入口 `/admin/api/v1/ops/usage-corrections`（operations 角色 + origin/CSRF + 会话身份），装配进 `src/server/managed-saas.ts`。
- 授权镜像：`runtime-privileges.ts` + `deploy/managed-saas-postgres-roles.sql` 同步（control-plane：settlements 三列 SELECT、corrections SELECT+INSERT）。
- 验证：26 个新单测全过；PG 集成测试 `tests/saas/metering/usage-correction.postgres.integration.test.ts`（重放/双连接并发/对账 fence/ACL 负向）接入 CI isolated 门禁 `usage-correction-063`（PG15+18 双跑，本地 skip 已验证）。
- 迁移注册表改为"001–060 冻结连续 + 061/062 文档化跳空"语义，10 余个 checkpoint 测试同步更新。

### A1：GW-01 证据闭环（任务 #4 上半，无新生产代码）
- `docs/evidence/` 建立：`README.md`（证据约定）+ `gw-01-authorization-matrix.md`（负向权限矩阵 P1–P5、并发撤权矩阵 C1–C4 → 既有 CI required 门禁的固定映射 + REL checklist）。
- `scripts/capture-gate-evidence.mjs`：native counts 捕获（`node --test` ℹ 计数解析、commit/日期戳、GO/NO-GO 判定、输出脱敏），已自测（正向捕获 + 非 tests/ 路径拒绝）。

### A3：FIN-01 故障矩阵（任务 #4 下半）
- `docs/evidence/fin-01-fault-matrix.md`：F1 取消补偿 / F2 missing usage / F3 崩溃 / F4 unknown / F5 并发 / F6 重复结算 × 双 PG 的门禁映射与跨矩阵不变量。
- F3 崩溃单元（真实 SIGKILL 演练，与 Track I 共建的基础脚本）：
  - `scripts/drills/settlement-crash-child.mjs`：子进程经真实 `DurableNormalSuccessSettlementPort` 逐条结算，同步 JSONL marker；
  - `tests/drills/settlement-sigkill-crash.postgres.integration.test.ts`：4 个 platform fixture，run-1 至少一笔提交后 SIGKILL（断言死于信号），run-2 全量重放，断言每请求恰好一次 settled、钱包投影=台账、分录平衡；
  - 接入 CI isolated 门禁 `settlement-sigkill-crash`；`tests/ci/managed-saas-required-gates.test.ts` 固定同步（isolated 矩阵 6→8）。
  - `scripts/drills/README.md`：演练契约与 Track I 扩展方向。

## 过程中的固定测试维护（记录备查）

- `060_prepared_evidence_claim_normal_registered.test.ts`：fixture 源文件 sha256 固定值更新两次（HMAC 常量导出 + fixture 测试自身正则放宽），语义未变。
- `normal-success-postgres-fixture.test.ts`：`routes.publish` 源码正则放宽为允许 biome 换行（`\s*`），语义固定不变。
- `normal-success-postgres-fixture.ts`：导出 `FIN057_FIXTURE_HMAC_HEX`（合成 fixture 字节，供崩溃演练子进程重建同一 metering service）；文件同时被 biome 规范化（此前属 lint 漂移文件）。
- 全仓 lint 残留报错均在非本轮改动文件（`src/admin/*`、`src/cli/*`、`tests/web/*`、`tests/ci/*` 既有漂移），本轮改动文件全部 `biome check` 干净。

## 下一任务

#6 A5 KEY-BUD 日/累计预算全链路（前置 A4 已交付）：迁移 081 预算计数器 + admit()/billing.reserve 协同 + 经 A2 端口的更正联动 + 注入式日窗口时钟。

## 2026-10-10 追加：A4 KEY-IP 策略全链路（任务 #5，已完成）

### 生产代码
- 迁移 080 `saas_api_key_ip_policies`：每 key 单行版本化 head（version bigint ≥1、mode disabled/allowlist/denyall、rules jsonb ≤256 条），组合 FK 依赖新增的 `saas_api_keys(tenant_id, project_id, id)` 唯一约束，CHECK 保证 disabled/denyall 必须空 rules、allowlist 至少一条；存量 key 回填 disabled v1 head。注册进 001 注册表（062 保留位之后），10 余个 checkpoint 测试同步到 `[…63, 80]`。
- 授权镜像：`runtime-privileges.ts` + `deploy/managed-saas-postgres-roles.sql` 同步（control-plane 列级 SELECT 全列 / INSERT 全列 / UPDATE 仅 version/mode/rules/updated_at；gateway 只读表清单加入本表）。
- `KeyService`：create 种子 disabled v1 head；rotate 让替换 key 以继承策略开新 v1 head（被撤销 key 保留自身 head）；`getKeyIpPolicy`（缺 head = pre-080 漂移 → 防御性 disabled v1 读出）；`replaceKeyIpPolicy`/`replaceKeyIpPolicyAuthenticated` 走完整 fence 链（tenant/project exclusive → key hint → user+key advisory → member 校验 → key FOR UPDATE → head FOR UPDATE），CAS `UPDATE … WHERE version = expectedVersion`，同事务 `saas_api_keys.authz_version` 原子递增使在途授权失效，审计 `api_key.ip_policy_replaced`；新错误码 `KEY_IP_POLICY_VERSION_CONFLICT`（409）。
- HTTP：`GET/PUT …/keys/:id/ip-policy`（写边界 + 严格 DTO 双必填），快照序列化不含秘密。
- 网关准入：`resolveClientAddress`（`trustedProxyCidrs` 选项经 `managed-saas-gateway` 装配透传，默认空 = 仅 socket peer）→ `RequestPreparationInput.clientAddress` → 准入命令 → guard `revalidate` 在 key 锁后、request 锁前校验持久化 head；非 disabled 且地址缺失/unresolved/不在策略内 → `CALLER_DENIED` → preparation reject `caller_denied` → HTTP 403；冻结 C-4 模块零改动（纯接线）。

### KEY080 PG 门禁
- `tests/saas/keys/ip-policy.postgres.integration.test.ts`：control-plane 角色 CAS 全链（get → advance → 过期 409 零副作用 → 双连接并发单赢家）；gateway 角色 guard 矩阵（disabled 免证据放行、allowlist IPv4/IPv6/CIDR 命中放行/未命中拒绝、denyall 全拒、unresolved/null/undefined 全部 fail-closed、过期 authzVersion 在 IP 单元之前先报 AUTHORITY_MISMATCH 的时序单元）；ACL 探针沿用 has_column_privilege 模式。已接入 CI isolated 门禁 `key-ip-policy-080`（ci.yml 矩阵 + isolated runner + pin 测试三处固定，strict-tsc root 同步）。

### 首次真实 PG 执行暴露并修复的存量潜伏问题（FIN057/FIN063 从未在 CI 绿过）
- `has_table_privilege` 永不计入列级授权（PG 语义实证）：063 ACL 探针 SELECT/INSERT 断言改 `has_column_privilege`；KEY080 gateway SELECT 探针同。
- FIN057 fixture 从未播种 `saas_gateway_capacity_reservations`：迁移 038 触发器要求 attempt 离开 not_sent 前必须存在 active 容量预留，fixture 增补 `capacity_reserve` 阶段按生产列清单播种。
- 063 透支拒绝实际抛 `SaasBillingError`（非 `SaasMeteringError`）：`matchesDomainError` 对 INSUFFICIENT_FUNDS 分支修正。
- FIN057 terminal-replay 快照：容量预留行按设计作为 no-delete 幂等证据保留（settle 后 capacity/activeCapacity 均为 1），断言修正并补 before 断言。
- `060_..._normal_registered.test.ts` fixture 源 sha256 固定值随上述修复更新。

### 验证
- 本地 scratch PG18 集群（initdb + 角色模板 + `saas:migrate` 全链 001→080）：FIN057/FIN063/060/SIGKILL/KEY080 首次真实执行全绿（25/25 + KEY080 3/3）。
- `npm test` 3074 单测（3056 pass / 0 fail）+ 225 集成（195 pass / 0 fail）；`npx tsc --noEmit` 干净；全部 isolated root 过 CI 同款 strict-tsc；CI 接线 pin 测试 11/11。
- `npm run lint`/`npm run deadcode` 对本轮全部改动文件无新增 finding；仓级残留（`src/admin/*` 3 文件 lint、~35 项 knip）均为 HEAD 既有，归 Track H 盘点。

## 2026-10-10 追加：A5 KEY-BUD 日/累计预算全链路（任务 #6，已完成）

### 生产代码
- 迁移 081 `saas_api_key_budget_*` 三表：策略 head（PK tenant/project/key、lineage_id、version；可空上限 NULL=无限 / '0'=有限零；含 supply_mode 的组合 FK）；计数器（PK tenant/lineage/window_kind/day，window_kind 避开保留字 'window'，lifetime 哨兵日 '0001-01-01'）；预留（PK tenant/request，request_fk → saas_requests(id)，守卫触发器：事实列不可变 55000、状态单向 outstanding→settled/released、禁删除）。注册进 001 注册表并回填存量 key 的无限 v1 head；`runtime-privileges.ts` + 角色 SQL 镜像（control-plane 策略列级读写/计数器 settled 更正 UPDATE；gateway 策略只读、计数器/预留列级 INSERT+受限 UPDATE）。
- `src/saas/keys/budget-store.ts`：定点金额解析（MAX_MINOR_UNITS）、注入式 UTC 日窗口、token-units-v1 语义（admission=input+output 上界、settlement=实际值）、head/计数器读取、`reserveKeyBudgetCounters`（双 upsert + 预留插入 + 币种冲突拒绝）、settle/release/更正（原始日、恰好一次、重放/缺失→false）。**生产 bug 修复**：node-pg 把 DATE 列解析为本地午夜 Date（UTC+8 主机上 '2026-10-10' → ISO 前一日），SELECT 改 `day::text AS day` 消除时区漂移——任何非 UTC 生产主机都会踩中。
- `KeyService`：create 种子无限自 lineage v1 head；rotate 继承前代 lineage_id + 上限开 v1 head；`getKeyBudgetPolicy`/`replaceKeyBudgetPolicy(Authenticated)` 完整 fence 链 + CAS（409 `KEY_BUDGET_POLICY_VERSION_CONFLICT`）+ 同事务 authz_version 递增 + 审计 `api_key.budget_policy_replaced`；快照币种解析：计数器戳 → 租户唯一钱包 → 500 fail-closed（绝不编造）。计数器读取去重为 `selectKeyBudgetCounters`（顺带消除 knip 未用导出）。
- HTTP：`GET/PUT …/keys/:id/budget-policy`（严格 DTO 三必填 expectedVersion/tokenCaps/customerChargeCaps）。
- 网关准入：`postgres-preparation-budget.ts` 先写后查计数器纪律——同一外层事务内在 billing hold 之后原子 upsert outstanding（INSERT…ON CONFLICT…RETURNING）再按冻结评估器判定，拒绝即抛错回滚，同 lineage 并发准入永不超收；仅 `kind === 'created'` 时预留（幂等重放不重复预留）；平台计费上限要求可解析币种否则 fail-closed；拒绝映射 preparation `budget_exceeded`。
- 结算/补偿/更正挂钩（后台 agent 完成，全部可选协作者模式，缺席=字节级行为不变）：条件结算端口 settle 钩子、pre-dispatch 补偿全释放路径 release 钩子、unknown-outcome 恢复 resolveNonExecution release、usage 更正（双 delta ≥0 且其一 >0 时 correct）。

### KEY081 PG 门禁
- `tests/saas/keys/budget-policy.postgres.integration.test.ts`：复用 FIN057 seedFixture（每 fixture 独立 lineage，三个 counter-flow 场景各占一个）；control-plane CAS 全链（get → advance v2 → 过期 409 零副作用 → 双连接并发单赢家 v3 → 平台 USD 快照）；gateway 计数器流（reserve 15/10 → settle 12 恰好一次+重放 no-op → 更正 +5 → 17；release → 清零+released；前一日预留结算进原始日窗口，当日计数器零吸收）；守卫证据（migrator 角色下 55000 immutable/retained——运行角色 42501 先于触发器，ACL 矩阵已覆盖该层）；ACL 探针 has_column_privilege 模式。接入 CI isolated 门禁 `key-budget-policy-081`（ci.yml 矩阵 + isolated runner + pin 测试 nine→ten + strict-tsc root）。

### 首次真实 PG 执行暴露并修复的问题
- node-pg DATE 时区漂移（见上，生产级 bug，fail-closed 表象为 settle STORAGE_ERROR）。
- 并发 race 败者断言对齐 KEY080 已验证模式（filter + instanceof 直断，不经 assert.rejects 重抛）。
- Phase 联合类型补 'terminal_transition'（fixture 扩展）；060 fixture sha256 固定值两次顺延更新。

### Agent 报告挂账项（Track H/后续评审）
- normal-success 超结算（billingState 'reconciliation_pending'）仍按实际用量 settle 预算预留：用量确已发生，跳过将永久悬挂 outstanding——倾向保留现状，待评审。
- `DurableConditionalSettlementPort` 仅有 option 就绪、无生产装配点。
- 负 delta usage 更正需计数器递减路径：`TODO(KEY-BUD)` 文档化缺口，correct 错误 fail-closed 传播。
- postgres-preparation-ports.ts 内部补偿点（do-not-modify 区）无法接收 keyBudget，改为 managed-saas.ts 直接装配带 keyBudget 的 PostgresPreDispatchCompensation 绕过。

### 验证
- KEY081 门禁 3/3 绿（scratch PG18）；`npm test` 3100 单测（3082 pass / 0 fail）+ 226 集成（195 pass / 0 fail）；`npx tsc --noEmit` 干净；isolated root 过 CI 同款 strict-tsc；CI 接线 pin 测试 11/11。
- 本轮改动文件 `biome check` 全部干净（含 service.ts 计数器去重重构后）；仓级 lint/knip 残留归 Track H。

## 下一任务

#7 B1a 软件 KMS 模块（pilot-only，按 C-2.2；前期必要性低，范围限于接口+软件实现 pilot）。

## 2026-10-10 追加：B1a 软件 KMS 模块（任务 #7，已完成，pilot-only）

### 交付
- `src/saas/runtime/software-provider-credential-kms.ts`：仓内 `software` KMS 模块本体——AES-256-GCM 信封包裹，静态主密钥来自 env，一份模块同时满足四个 loader 工厂契约（seal `createProviderCredentialSealingKms` / gateway decrypt `createGatewayProviderCredentialUnsealingKms` / validation-worker decrypt `createCredentialValidationWorkerUnsealingKms` / rewrap `createProviderCredentialRewrappingKms`）。
- 包裹 blob 自描述（`MRSKMS1` magic + 版本 + keyId + IV + GCM tag）；blob keyId 与请求 encryptionContext 作为 AAD 认证——上下文错、keyId 错、未知 keyId、blob 篡改全部 fail-closed；面向 loader 的错误不含密钥材料与请求细节。
- 主密钥版本前缀支持手动轮换：`MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY`（64 hex 当前钥）+ `_KEY_ID`（默认 software-local，须与部署 `MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID` 一致）+ `_PREVIOUS_MASTER_KEYS`（≤16 条 keyId=hex 旧钥）；reencrypt 明文不出模块边界（中间缓冲即擦）；`close()` 清零钥匙环且幂等；`checkReady()` 做 wrap/unwrap 自探。
- pilot-only 启动告警：每个进程首个工厂调用 `process.emitWarning`（code `MODEL_ROUTER_SOFTWARE_KMS_PILOT_ONLY`，恰好一次），明示不得用于收费生产（M3 决策门 / REL-01 核对）。
- `src/saas/runtime/software-provider-credential-rewrapping-kms.mjs`：独立 rewrap 入口。**关键发现**：rewrap loader 要求与 seal/decrypt 不同的 specifier 且模块恰好一个导出，而本仓 tsx/CJS 转译会给模块命名空间加 `default`/`module.exports` interop 键，任何 TS 入口都无法通过 `dedicatedModuleFactory`——纯 ESM `.mjs` 入口经 loader 真实动态导入（无 importer 注入）验证可载。
- `deploy/README.md` 追加 pilot 接线/轮换/限制章节。

### 验证
- `tests/saas/runtime/software-provider-credential-kms.test.ts` 12/12：真实 loader 全链 seal→gateway/worker decrypt 往返、上下文/keyId/篡改 fail-closed 且错误无泄漏、异钥环拒绝、keySpec/keyId 校验、rewrap 轮换（v1→v2 真实动态导入 .mjs、新上下文绑定、源上下文不匹配拒绝、destination 非当前钥拒绝）、旧钥环解密兼容、缺失/非法主密钥与非法 previous 配置 factory 失败、close 清零幂等、pilot 告警恰好一次。
- `npx tsc --noEmit` 干净；改动文件 biome 干净；knip 新增仅落入既有 "Unused files" 结构桶（仓级 Track H）。

## 2026-10-10 追加：C2 EasyPay PSP 适配器（任务 #8，已完成）

### 交付
- `src/saas/payments/providers/easypay/`（protocol.ts / provider.ts / index.ts）：实现 `PaymentProviderAdapter` + `PaymentProviderRefundAdapter`，providerKey `'easypay'`，按 C-3 契约对 sub2api 语义三处红线化：
  1. **仅 mapi 直付**——`paymentMode: 'popup'` 配置层 fail-closed（无 TradeNo 则 recoverOrder 不成立）；apiBase 非 loopback 强制 https，端点后缀归一。
  2. **履约前强制主动 QueryOrder 复核（红线）**——MD5 验签只放行事件入 durable inbox；新增可选适配器接缝 `confirmEvent`（adapter.ts/types.ts 增补，service.ts 在 wallet `fulfillFromEvent` 与 service-plan 履约两处 succeeded 门前调用）：复核 out_trade_no 匹配 + TRADE_SUCCESS + 金额/币种一致 + trade_no 一致，任一不满足 → `reconciliation_pending`（细分 outcome_code：EASYPAY_ORDER_NOT_FOUND / TRADE_NOT_SUCCESS / AMOUNT_MISMATCH / TRADE_NO_MISMATCH / CURRENCY_MISMATCH），复核传输失败 → 抛错走 claim 重试退避（永不直接对账）。
  3. **退款显式人工对账**——submitRefund 调 `api.php?act=refund`（out_trade_no 优先、无单回退 trade_no，不签名明文 pkey：出口白名单缓解 + COM-01 记录），接受即 `pending`（provisional）；业务明确拒绝/双键皆无单 → `not_accepted`，传输/不可解析 → `unknown`；**queryRefund 恒 unknown 零 HTTP**（绝不伪造 not_accepted 释放冻结）。
- acceptance 三态全程：create 传输错/不可解析/无 TradeNo/业务失败但查单有单 → `unknown`；仅业务失败码 + 查单确认无单 → `rejected`。金额严格定点（分↔元字符串双向 BigInt，拒绝浮点/指数/超精度）。租户范围经 epay `param` 透传字段回环，缺失 → `unresolved-tenant` 哨兵入对账（不崩溃）。错误摘要对 pkey 强制脱敏。recoverOrder 查单恢复（查无 → null，不新建）；refreshCheckout 同 out_trade_no 重调 mapi 取新 payurl（不新建 charge）。
- service.ts 变更纯增量（可选接缝，缺席 = 行为字节不变）；fake-sql.ts FakePaymentProvider 增加 confirmEvent 可编程支持（默认缺席保持存量行为）。

### 验证
- `tests/saas/payments/easypay-provider.test.ts` 16/16（可编程 mock PSP HTTP server）：配置 fail-closed、MD5 拼接定点、定点金额、create 签名与 param 透传与 checkout 归一（相对路径绝对化）、acceptance 全矩阵、webhook 验签/商户校验/篡改拒绝、normalizeEvent 稳定事件身份、confirmEvent 红线全分支、recover/refresh 不新建、退款回退与三态、queryRefund 恒 unknown、pkey 脱敏、**端到端**（service + easypay 适配器 + mock PSP：复核确认才入账恰好一次；PSP 不确认的签名成功事件 → 对账零入账）。
- `tests/saas/payments/payments.test.ts` 新增 2 接缝回归：confirmEvent 拒绝 → 对账零入账（outcome_code 持久化）；confirmEvent 抛错 → claim 重试、退避后确认 → 恰好一次入账。payments 全队列 96/96；`npx tsc --noEmit` 干净；改动文件 biome 干净；knip 仅落既有 Unused files 结构桶（Track H）。

## 2026-10-10 追加：D1 priority/weight 落库（任务 #15，已完成）

### 交付
- **迁移 082（含编号仲裁）**：`src/saas/db/migrations/082_provider_account_scheduling.ts` 按 C-7 冻结契约给 `saas_tenant_provider_accounts` / `saas_platform_provider_accounts` 双表加 `priority integer NOT NULL DEFAULT 0` + `weight integer NOT NULL DEFAULT 1` 及 `_priority_range`(0..1000)/`_weight_range`(1..10000) CHECK。原计划槽位 064 因串行集成让 080/081 先落地、fail-closed 顺序规则（"SaaS migration history is out of order"）使 064-079 永远无法被已应用 080/081 的库接受 → 仲裁：064-079 槽位永久退役，Track D 消费 082+（D2=083、E=084-085、F=086-087、G=088-097），台账见 `docs/contracts-m0-freeze.md`。
- **调度读取（C-7）**：`postgres-provider-account-scheduler.ts` BYOK/平台双资格 SQL 读持久化 priority/weight；`schedulingPriority/Weight` 严格校验（整数或纯数字文本，越界/小数/非数字/null → fail-closed `block`，reason 明确，绝不猜测推断）；选择算法不变（priority 降序 + sha256 种子确定性加权抽签）。
- **写路径全链**：repository `updateAccountScheduling`（advisory lock + FOR UPDATE + authz_version CAS，谓词起点 $5）；persistence-service `updateProviderAccountScheduling`（缺失值经 `?? NaN` fail INVALID_INPUT，越界 INVALID_INPUT，陈旧版本 ACCOUNT_STATE_CONFLICT，撤销账户 ACCOUNT_REVOKED）；supply service `updatePlatformProviderAccountScheduling`（事务 + 审计 `provider_supply.account.scheduling_updated`）；平台管理 HTTP `POST /admin/api/v1/supply/accounts/:id/scheduling`（strict body：priority/weight/expectedAuthzVersion 全必填，operations 角色，DTO 回显新标量）；create 路径双模式可选 priority/weight 透传落库。
- **ACL 同步**：runtime-privileges 注册表双表 SELECT/INSERT/UPDATE 精确列授权 += priority/weight；`deploy/managed-saas-postgres-roles.sql` 六条三元组行同步（部署注意：082 后须重跑角色模板，gateway 动态读授权才覆盖新列）。

### 验证
- 迁移注册全量钉板更新：版本列表 `[...1-60, 63, 80, 81, 82]`、长度 64、082 位于 [63]；082 专属测试 3/3（注册/间隙、双表列+约束、无触发器/ACL/epoch/DROP）。
- 调度器 53/53：持久化标量优先于中性值（与候选顺序无关）、加权跨确定性抽签分布、畸形标量全 fail-closed（1001/-1/0.5/0/10001/'heavy'/null）、文本形式界内值接受。
- supply 全队列 261/261（默认 0/1 + 显式持久化、越界/非整数 INVALID_INPUT、CAS 成功/陈旧冲突）；平台 HTTP 7/7（路由 CAS + 审计 + 七种 400 严格体）。
- 真实 PG18 scratch（127.0.0.1:55433）：082 经 saas:migrate 应用、角色模板重跑、运行时权限探针绿；**商业 gateway E2E 门禁 27/27**（BYOK 主账户显式 priority 5/weight 7 证明新列真实往返）；060 fixture 回归 7/7（fixture 补 priority/weight 中性值，sha256 钉同步重盖章）。
- 全套件 exit 0（unit 绿；integration 226 中 195 通过 0 失败）；`npx tsc --noEmit` 干净；D1 触及文件 biome 零诊断（仓级 lint 红为既有基线 341，Track H 所有）；knip 无新增 unused exports（082 测试落既有 Unused files 结构桶）。

## 2026-10-10 追加：D2 平台池自动验证（任务 #16，已完成）

### 交付
- **迁移 083（D2-a）**：`src/saas/db/migrations/083_platform_credential_validation_jobs.ts`——035 的平台镜像（退役台账 Track D 槽位）：`saas_platform_provider_credential_validation_jobs`（无 tenant 维度；同形 CHECK 族/models/endpoint/idempotency/lease/error/completion、3 FK→平台 accounts/credentials/versions、unique (credential_id,credential_version) + unique(idempotency_key)、claim 部分索引）；identity-immutable 触发器函数（13 字段无 tenant）；两个失效包装触发器按 058 模式先生成 invoker 再 `ALTER ... SECURITY DEFINER` + `SET search_path TO pg_catalog, model_router_saas, pg_temp`（控制面 UPDATE 无 jobs 表权限亦可触发）；no-delete 复用共享拒绝函数。约束/触发器名确定性截断至 PG 63 字节。
- **worker store owner 维度抽象（D2-b）**：`credential-validation-worker.ts` 引入 `CredentialValidationOwnerScope`（ownerKind/supplyMode/六张表族/jobColumns）+ `TENANT/PLATFORM_OWNER_SCOPE`；store `claimNext()` 按 `owners` 选项（默认 `['tenant','platform']`，tenant 先轮询）逐 scope 声明——**tenant SQL 保持字节一致**（FakeValidationDatabase 前缀匹配不受影响），platform 变体去 tenant 谓词并重排占位符（capability $3..$9、lease 复核 $1..$13、health UPDATE 双分支）；咨询锁层 platform 以 platformProviderAccount/Credential 起层；KMS 上下文 platform 完全省略 tenantId（绝不哨兵），tenant 行缺 tenant_id → STORE_UNAVAILABLE fail-closed。`prepareCredentialValidationRequeue` 对 platform job / 无 tenant 身份的 tenant job fail-closed（061 通道 SQL 按 tenant 绑定，快照 sha 维持 v1 与 061 DB 端重算字节兼容；platform 恢复 = 平台队列自身幂等新 enqueue）。
- **平台池 enqueue 适配器（D2-c）**：repository `enqueueProviderCredentialValidationJob` 双 owner 写入（对称形状守卫 CREDENTIAL_VALIDATION_JOB_WRITE_FAILED，平台 `ON CONFLICT (credential_id, credential_version)`，ownerKind 纳入幂等快照比对）；persistence-service 平台 `createProviderCredentialInternal` 与轮换统一分支自动 enqueue（idempotency `['provider-credential-validation-v1','platform',accountId,credentialId,version,providerId,productId]` sha256，allowedModels 取唯一 capability）——新建/轮换平台凭证即排队自证，worker 终态失败把账号+凭证停于 pending/非 verified，正好落在既有调度资格 SQL 排除之下（失败自动下线零额外联动）。
- **schema readiness + 权限探针**：CONTRACT 扩至 15 关系（9 tenant + 6 platform）、5 个 definer 包装函数；`verifyCredentialValidationWorkerSchemaReadiness(executor, targetSchema, owner)` owner 维度端点 CHECK 跟随；worker `expected_column_privileges` 增补平台六表精确列清单（jobs SELECT 21/UPDATE 8、accounts SELECT 11/UPDATE 6、credentials SELECT 10/UPDATE 6、versions 15、wrappings 6、bindings 6）；runtime-privileges 注册表控制面对平台 jobs SELECT 21/INSERT 11；`deploy/managed-saas-postgres-roles.sql` 与 `deploy/managed-saas-validation-worker-role-grants.sql` 同步镜像（**部署注意：083 后两份模板均须重跑**）。

### 验证
- 迁移钉板：083 专属测试 4/4（注册/间隙、035 形状镜像、触发器契约、不触 tenant 队列/ACL/DROP）；注册表全量钉（版本 `[...1-60, 63, 80-83]`、长度 65、083 位于 [64]）同步更新 ~11 文件；真实 PG18 scratch 应用 083，live catalog 核对 definer/搜索路径/截断名/约束全中。
- worker 测试 33/33（新增 3 平台路径：tenant 先轮询空队列后 platform claim→KMS→真实 HTTPS 探测→双行 verified 健康且 readiness owner=platform/占位符重排/4 次 schema+identity 核查；401 终态失败 → job failed + 账号/凭证 pending/failed；rights/capability 撤销在 KMS 与网络前 fail-closed）；targets 14/14（新增 platform job 061 通道 fail-closed + tenant 缺身份 fail-closed）；jobs 9/9（新增平台创建/轮换自动 enqueue 幂等键公式、owner 形状守卫、owner 分区幂等）。
- supply 全队列 275/275（0 失败）；requeue 单元 28/28；**真实 PG18 scratch 四角色 E2E**：tenant worker 门禁 7/7（readiness 15 关系 + 平台授权探针全绿）、**新增平台门禁 3/3**（受限 worker 角色真实 claim 平台 job → 解密 → 探测 → verified 健康双行；401 终态 → pending/failed 落调度排除位；两种 owner readiness + 权限探针）、四角色 CP 失效栅栏 12/12（重跑角色模板后）。
- 061 standalone requeue 门禁为 staged candidate 专用（要求独立 through-061 专用库，docs/contracts-m0-freeze.md:149 注明 inactive），本环境无此库故不运行——非本次回归；其通道的 tenant-only 绑定由新 fail-closed 守卫单元测试覆盖。
- 全套件 exit 0（3164 unit 中 3146 通过 0 失败；integration 227 中 195 通过 0 失败）；`npx tsc --noEmit` 干净；D2 触及文件 biome 零错误（新集成测试 1 条 noNonNullAssertion 警告与姊妹 tenant 集成文件同款既有模式）；knip 无新增 unused exports（新测试文件落既有 Unused files 结构桶，Track H 所有）。

## 2026-10-10 追加：D3 周期复验（任务 #17，已完成）

### 交付
- **迁移 084（D3-a，含编号仲裁）**：`src/saas/db/migrations/084_provider_account_revalidation.ts`——`saas_tenant_provider_accounts` / `saas_platform_provider_accounts` 双表加 `revalidation_interval_seconds integer`（NULL = 禁用 = 存量行字节级 pre-D3 行为）+ `_revalidation_interval_range` CHECK（NULL 或 900..604800，即 15 分钟..7 天）。D 继续消费下一稠密槽位，E→085-086、F→087-088、G→089-098 顺延一格，台账见 `docs/contracts-m0-freeze.md`。无触发器/ACL/epoch/DROP。
- **复验周期写路径（D3-b）**：repository `updateAccountRevalidation`（advisory lock + SELECT FOR UPDATE + authz_version CAS + RETURNING）；persistence-service（undefined→null、非安全整数/越界 INVALID_INPUT、陈旧 ACCOUNT_STATE_CONFLICT、撤销 ACCOUNT_REVOKED）；supply service `updatePlatformProviderAccountRevalidation`（事务 + 审计 `provider_supply.account.revalidation_updated`）；平台管理 HTTP `POST /admin/api/v1/supply/accounts/:id/revalidation`（strict body：revalidationIntervalSeconds/expectedAuthzVersion 双必填，null = 禁用）；create 路径可选透传落库。ACL 同步：runtime-privileges 双表 SELECT/INSERT/UPDATE 列清单、`deploy/managed-saas-postgres-roles.sql` 六条三元组行、worker grants 双表 SELECT 清单均 += 新列（**部署注意：084 后两份角色模板均须重跑**）。
- **worker 周期复验扫描（D3-c）**：`PostgresCredentialValidationWorkerStore.requeueDueRevalidations(batchSize)` 按 scope 顺序（tenant 先）执行**幂等 requeue-transition**——设计仲裁：jobs 表 `UNIQUE (credential_id, credential_version)` 使同版本终态 job 永远无法重新 INSERT，故周期复验只能把既有终态行 UPDATE 回 `queued`（attempt_count=0、available_at=clock_timestamp()、lease_until/last_error_code/completed_at 全 NULL——035 completion_shape CHECK 强制、lease_generation+1 使残留旧租约过不了复核栅栏），原始权威快照原样保留。到期判定基于 job 自身 `completed_at + make_interval(secs => interval) <= clock_timestamp()`（worker 角色对 account last_validated_at/created_at 无授权，且 failed 验证也被统一覆盖）；谓词同时要求 account/credential `status='active'`、`credential_version = current_version`（旧版本终态行永不复活）；**`cancelled` 明确不重排**（取消记录权威变更，claim 时栅栏会再评，重排只会空转）。子查询 `FOR UPDATE OF due SKIP LOCKED` + `LIMIT $1` 有界批量；全部 8 个 SET 列恰为 worker 既有 UPDATE 授权列，**零授权变更**。tenant scope join 带 tenant 谓词，platform 去 tenant 维度（与 claim 时权威 join 镜像）。`CredentialValidationWorker` 新增选项门 `revalidationSweep {intervalMs, batchSize}`（1s..1h / 1..1000，越界 fail-closed STORE_UNAVAILABLE）：每个 runOnce 周期在 claim 前机会性执行，interval 门戳先于 store 调用（扫描失败不会热旋），缺席 = pre-D3 行为；managed-saas 运行时经 `credentialValidationWorkerOptions` 透传，部署方可接线。

### 验证
- 迁移钉板：084 专属测试 3/3（注册/061-062 与退役 064-079 间隙、双表列+CHECK 且断言无 NOT NULL、无触发器/ACL/epoch/DROP）；注册表全量钉（版本 `[...1-60, 63, 80-84]`、长度 66、084 位于 [65]）同步更新 ~12 文件；060 fixture 补中性值 sha256 重盖章；真实 PG18 scratch 应用 084（max version 84、列可空核对）、两份角色模板重跑。
- 写路径：supply 全队列 283/283（默认 null + 显式 3600 持久化 + null 禁用、899/604801/0/3600.5/NaN/undefined 全 INVALID_INPUT、CAS 86400→null→陈旧冲突）；平台 HTTP 8/8（路由 CAS + 审计 + 七种严格体 400）；persistence 12/12；account-transaction SQL 钉同步。
- worker 扫描：worker 测试 37/37（新增 4：到期终态 job 同周期 requeue→claim→verified（attempt 3→重置→1、lease 代数 +3、双 scope 扫描序）、未到期/未配置选项零动作、interval 门限双周期只扫一次、platform scope 直 store 重排 + batch 越界 fail-closed；FakeValidationDatabase 新增终态 candidate 守卫——真实 candidate SQL 的 status='queued' 过滤从此被夹具如实建模）。
- **真实 PG18 scratch E2E（双 owner）**：tenant 门禁 8/8、platform 门禁 4/4（新增 D3 sweep 子测试：interval=900 账号首轮 verified → 新鲜完成不到期 sweep 保持终态 idle → migrator 回填 completed_at 16 分钟 → **受限 worker 角色**同周期 requeue（仅触 8 个授权租约列）→claim→探测→verified，attempt_count 归 1 证明同行 requeue-transition 而非新行）。scratch 上 26 条 cvi-* 失效套件遗留 queued fixture（no-delete 触发器挡 DELETE）经 superuser 置 cancelled 清理，队列门禁恢复。
- 全套件 exit 0（0 ✖）；`npx tsc --noEmit` 干净；D3 触及文件 biome 零诊断（仓级 lint 红为既有基线，Track H 所有）；knip 无新增 unused exports（新测试落既有 Unused files 结构桶）。

## 2026-10-10 追加：E1 成员移除 + 角色变更 + Owner 转移（任务 #26，已完成）

### 交付
- **零 schema 变更**：001 迁移的 saas_memberships（role/status/revoked_at）与 saas_project_memberships 列已完整支撑，台账不变（085 后由 E2 消费，E4 确认零迁移）。
- **service 三方法（identity/service.ts）**：`updateTenantMemberRole` / `removeTenantMember` / `transferTenantOwnership`；共享私有件 `validateDirectoryId`（DIRECTORY_UUID_PATTERN，非 UUID → 400 INVALID_INPUT，同时杜绝 PG invalid_text_representation 500）、`appendTenantMembershipAudit`（saas_audit_events，entry_point `customer_identity_members`，target_type `saas_membership`）、`actorTenantRole`（与 createInvitation 同款新鲜读，非活跃成员/租户 → 404 TENANT_ACCESS_DENIED）、`lockTenantMembership`（FOR UPDATE OF m；无行 → 404 MEMBER_NOT_FOUND，畸形行 → 500，status≠active → 404）、`activeOwnerCount`（count(*)::text）。
- **权限带（band policy）**：owner 可变任何人角色/移除任何人；admin 仅限非特权带（developer/billing/viewer 目标、同范围可授予角色；触及 owner/admin → 403 INSUFFICIENT_TENANT_ROLE）；developer/billing/viewer 无管理权；**自我移除对所有角色开放**（豁免带策略）；同角色静默 no-op（不写库不审计）。**策略先于不变量判定**（admin 移除唯一 owner → INSUFFICIENT_TENANT_ROLE 而非 LAST_OWNER_REQUIRED）。
- **至少一 Owner 不变量**：`fenceTenantAuthorization` 咨询锁 + 事务内 active owner 计数 → 409 LAST_OWNER_REQUIRED（owner 降权/移除/自我移除均过闸）；**所有权转移**目标→owner + actor→admin 同事务原子交换（不变量由构造保证），自我转移 400 INVALID_INPUT；errors.ts 新增 MEMBER_NOT_FOUND + LAST_OWNER_REQUIRED 码。
- **移除级联**：saas_memberships 置 `status='revoked', revoked_at`（no-delete 表保留行）+ saas_project_memberships 同事务级联撤销（status<>'revoked' 谓词）；审计动作 `tenant_member.role_updated` / `tenant_member.removed` / `tenant_ownership.transferred`。
- **HTTP 三路由（identity/http.ts）**：`POST /v1/identity/tenants/:t/members/:u/role`（strict body role ∈ 5 角色枚举）、`POST .../members/:u/remove`（readEmptyJsonObject）、`POST .../ownership-transfer`（strict {userId}）；均 getSession + requireCsrf + tenantMembers 速率档；提取 fail-closed 序列化器 `publicMember`（UUID 模式、displayName ≤120、role/status 枚举）供响应与 publicMemberPage 复用；safeServiceError 折叠为通用状态桶（CONFLICT/NOT_FOUND/FORBIDDEN），具体码不外泄。
- **ACL 同步**：runtime-privileges 注册表 += saas_memberships UPDATE(role,status,revoked_at,updated_at) + saas_project_memberships UPDATE(status,revoked_at,updated_at)；`deploy/managed-saas-postgres-roles.sql` 两条三元组行同步，已以 postgres 超级用户在 scratch 重跑（**部署注意：E1 授权变更后角色模板须重跑**）。
- **控制台客户端（web/src/api/saas-client.ts）**：提取 `tenantMemberFromResponse`（fail-closed DTO 校验）+ `tenantMemberMutationFromResponse`（解包 {member}），tenantMemberPageFromResponse 复用；新增 `updateTenantMemberRole` / `removeTenantMember`（body {}）/ `transferTenantOwnership` 三方法供 E3 消费。

### 验证
- 单元 `tests/saas/identity/tenant-member-management.test.ts` 11/11：owner 角色变更+审计+同角色 no-op、升 owner 扩带、admin 带限、唯一 owner 降权/移除闸、移除级联（tenant+project revoked_at=NOW）、revoked/不存在 → MEMBER_NOT_FOUND、自我移除+唯一 owner 阻断、admin 移除带、转移交换+新 owner 连续转移、自我转移/非成员/非 UUID/'root' 角色拒绝、fence 失败回滚、suspended actor 拒绝；fake-database 新增 FOR UPDATE 锁读/count/update/级联/审计分支。
- HTTP `http-handler.test.ts` 16/16：三路由精确 service 调用元组；PUT/GET 405、origin/host/CSRF 403、未知会话 401、七种严格体 400（serviceCalls 恒 0）；错误映射断言通用码且 `JSON.stringify(error)` 不含具体码。
- **真实 PG18 scratch 门禁（tenant-member-management.postgres.integration.test.ts）4/4**（GATEWAY_E2E_REQUIRED 三角色门 + 同一 URL 契约）：受限 control-plane 角色执行角色变更+审计+admin 带拒绝、移除级联+MEMBER_NOT_FOUND+唯一 owner 三闸（自我降权 LAST_OWNER_REQUIRED、admin 触及 owner 带 INSUFFICIENT_TENANT_ROLE、自我移除 LAST_OWNER_REQUIRED）、转移交换+创始 owner 失权+自我转移 400+连续转移；目录套件回归 7/7。CP UPDATE 授权经 `verifySaasRuntimeDatabasePrivileges(control, 'control_plane')` 探针实测。
- identity 队列 113 测试 / 110 通过 / 0 失败 / 3 跳过；web 队列 200/200（新增成员变更客户端测试：三路由 URL/方法/CSRF/请求体钉板 + 四种畸形 envelope INVALID_RESPONSE）；全套件 exit 0（0 ✖）；`npx tsc --noEmit` 干净；E1 触及文件 biome 零新增错误（saas-console-workspace.test.ts:193 两条 useTemplate 为 HEAD 既有基线，Track H 所有）；knip 无新增 unused exports（新测试落既有 Unused files 结构桶 402）。

## 2026-10-10 追加：E2 Passkey（注册/断言/防重放 ceremony，任务 #27，已完成）

### 交付
- **迁移 085（E2-a，编号仲裁 E→085-086 首槽）**：`src/saas/db/migrations/085_customer_passkey_ceremonies.ts`——`saas_mfa_credentials` 加 `sign_count bigint` + `_sign_count_nonnegative` / `_sign_count_passkey_only` 双 CHECK（kind='passkey' 或 NULL）；新表 `saas_customer_passkey_ceremonies`（user/session FK ON DELETE RESTRICT、ceremony 枚举、challenge_hash 64-hex UNIQUE、credential_id 16..1364、password_digest 64-hex、attempt_count 0..5、expires_at 窗口 ≤5min、consumed→closed 不变量）+ 部分唯一索引 `saas_customer_passkey_one_open_ceremony`（每用户每类仪式至多一开）+ 三触发器族（guard/writer/user_fence，migrator-owned invoker `SET search_path TO pg_catalog, model_router_saas, pg_temp`，writer 咨询锁类 85 与 TOTP 46 区分；tgtype 31/30/29）：DELETE→55000；UPDATE 仅 credential_id/attempt_count/consumed_at/closed_at、closed 不可回退、attempt 仅 +1、credential_id 仅 registration 消费时可置；INSERT 必须 pending、registration 不得预绑 credential、assertion 必须绑定 active verified passkey、platform 角色与死 session/用户拒绝。注册进 001 台账 [66]，**064-079 退役不变**。
- **WebAuthn 验证核心（E2-b，`customer-passkey-webauthn.ts`）**：全收窄 fail-closed——仅 fmt 'none'（attStmt 必须空）、仅 ES256(-7)/RS256(-257)、拒绝 extensions/tokenBinding/crossOrigin、定长 CBOR（深 ≤8、仅 major 0-5、拒绝重复键与不定长）、authenticatorData 逐字段钉（rpIdHash、UP 必需、UV 按策略、拒绝 ED、AT 按仪式匹配、attestation 解析 aaguid+credId 12..1023+COSE 且无尾随）、签名验证 `authData ‖ sha256(clientDataJSON)` 经 JWK crypto.verify；计数器防克隆规则（首用任意、零/零对合法、其余严格递增）。10 种 PasskeyVerificationError reason 永不跨 HTTP。
- **service（E2-c，`customer-passkey-service.ts` ~640 行）**：与 TOTP 同款栅栏（READ COMMITTED → lock_timeout 2s/statement_timeout 10s → 平台写者栅栏 → token_hash hint → 用户咨询锁 → 新鲜重读）；preflight/material/finish 三段保持 scrypt 与 KMS 在 PG 锁外（10s 竞速，超时阻断最终写）；material 失败提交有界 denial 审计；challenge 32B b64url 单次消费（库内仅存 hash）；userHandle=base64url(user uuid utf8)；因子增删撤销**全部**会话（响应带 3 枚过期 cookie）；断言保会话；TOTP 交叉闸门（registration start/finish 与 remove 在 TOTP active 时需 currentTotpCode，step CAS 防重放；断言不交叉）；错误码 INVALID_INPUT/UNAUTHENTICATED/PASSKEY_NOT_FOUND/REAUTH_REQUIRED/PASSKEY_REJECTED/RATE_LIMITED/UNAVAILABLE/MFA_STATE_CONFLICT/CEREMONY_INVALID/AUTHORITY_CHANGED。audit entry_point `customer_passkey`，动作 `customer_passkey.{op}.{started|completed|denied}`。
- **HTTP（E2-d，`customer-passkey-http.ts`）**：`/console/api/v1/auth/passkey` 五路由（GET list、POST registration/start|finish、assertion/start|finish、remove）；cookie 会话证明 + timingSafeEqual CSRF + origin/host 检查 + 速率档 `customer-passkey:source:v1` + 严格体白名单（嵌套 credential 校验）+ 16KiB 体上限；deployment 缺席 → 503 `deployment-unavailable-v1` 且绝不合成 list；接入 `identity/http.ts` 调度（customerMfa 之后）与 `identity/index.ts` 导出。
- **schema readiness（`customer-passkey-schema-readiness.ts`）**：形状查询（12 ceremony 列 + sign_count、CP 角色/所有权/特权、部分唯一索引、无未验证约束、CP 无 EXECUTE）+ 3 例程体 sha256 比对 + 3 触发器绑定钉。
- **ACL（E2-e）**：runtime-privileges 注册表 saas_mfa_credentials SELECT/INSERT += credential_id/public_key/sign_count、UPDATE += sign_count；saas_customer_passkey_ceremonies 全新 SELECT 12 列/INSERT 9 列/UPDATE 4 列；`deploy/managed-saas-postgres-roles.sql` 六条三元组行同步镜像，已以 postgres 超级用户在 scratch 重跑（**部署注意：085 授权变更后角色模板须重跑**）。
- **capability 接线（E2-e）**：`src/saas/runtime/customer-passkey-capability.ts`（镜像 customer-mfa-capability：目的 `customer-passkey-deployment-v1`、描述符键 purpose/deploymentId/environmentId/rpId/rpName/origins/requireUserVerification/credentialKeyProvider、provenance WeakMap、三重篡改复核、仅核心 service+readiness 无注入缝）；deployment.ts 新增 `MODEL_ROUTER_SAAS_CUSTOMER_PASSKEY_CAPABILITY_MODULE`（own-data-setting 解析、control-plane-only、requires explicit context）；managed-saas.ts 启动断言 + `createCustomerPasskeyForDeployment` 先于 listener 绑定 + 注入 `customerPasskey` 进 identity handler 选项（importer 测试缝 `customerPasskeyCapabilityModuleImporter`）。
- **lint 顺手修**：本未提交栈内 `\x00-\x1f\x7f` 正则控制字符写法统一改为仓级通行 `[...v].some((ch) => ch.charCodeAt(0) < 0x20 || === 0x7f)` 习语（deployment.ts/customer-mfa-capability.ts/customer-passkey-capability.ts/customer-passkey-service.ts，biome noControlCharactersInRegex 归零；HEAD 既有基线文件不动，Track H 所有）。

### 验证
- 迁移钉板：085 专属 5/5（注册/间隙/[66] 槽位、sign_count CHECK、ledger 形状、guard 族钉、无 ACL/epoch/DROP/GRANT）；注册表全量钉（版本 `[...1-60, 63, 80-85]`、长度 67）同步 11+ 文件（061 测试 length 66→67、at(-6)→at(-7) 漏钉本次补齐）；真实 PG18 scratch 应用 085（max version 85）。
- WebAuthn 单元 7/7（测试侧 CBOR 编码器 + EC/RSA 模拟器：注册 happy、UV 策略双向、~20 例篡改矩阵、双算法断言、计数器规则、编码上界）；service 单元 12/12（注册+审计+list、challenge 单次+二次 start 拒绝、5 次错密锁定、篡改矩阵、TOTP 交叉闸+时间窗重放、断言计数推进+克隆拒绝+challenge 重放、remove 级联、platform/disabled 拒绝、AUTHORITY_CHANGED 中途撤销、输入校验、UNAVAILABLE 不泄漏）；readiness 4/4；HTTP 4/4（线上注册+断言全仪式、method/origin/host(raw socket)/CSRF/session/体形/限速负向、错误码映射+composed handler、deployment 缺席标记）；capability 9/9（缺席零副作用、解析器拒绝矩阵、描述符绑定+冻结、15 例维度/RP 字段/getter 失败闭、模块失败不可静默禁用、readiness 失败、组合源码钉、中途篡改、KMS 失败不泄漏）。
- **真实 PG18 scratch 门禁（customer-passkey.postgres.integration.test.ts）4/4**（GATEWAY_E2E_REQUIRED 三角色门 + 同一 URL 契约）：受限 control-plane 角色跑通注册→断言（计数 0→7 持久化）→克隆计数拒绝→移除，challenge 单次消费跨会话拒绝，审计四动作落库；085 guard 族实测（CP DELETE → 42501 ACL 先行、migrator DELETE → 55000、非授权列 UPDATE → 42501、migrator 改 challenge_hash → 23514、closed 回退/registration 预绑/过期 INSERT/totp sign_count/负计数全 23514）；platform 账号持活会话仍 MFA_STATE_CONFLICT 且零 ceremony。CP 授权经 `verifySaasRuntimeDatabasePrivileges(control, 'control_plane')` 探针实测；角色模板重跑后 catalog 核对 INSERT/SELECT/UPDATE 三档列清单全中。
- 全套件 exit 0（unit 3231 中 3213 通过 0 失败；integration 229 中 195 通过 0 失败）；`npx tsc --noEmit` 干净；E2 触及文件 biome 零错误；knip 无新增 unused exports（新测试落既有 Unused files 结构桶 411，Track H 所有）。

## 2026-10-10 追加：E3 控制台补齐——账单页（充值订单历史，任务 #28，已完成；通知中心显式延期）

### 交付
- **范围冻结（E3-a，#35）**：盘点确认钱包页、退款记录页、服务计划订单列表、用量控制台均已存在；唯一缺口 = 客户侧钱包充值 payment order **列表**（此前仅有单订单 readOrder）。**通知中心显式延期**：其消费 Track F 事件，串行顺序下 F（#11）尚未交付，决定记入 #35 描述与本节，F 落地后解除。
- **查询 service（E3-b，`src/saas/payments/customer-order-query.ts`）**：镜像既审 customer-refund-query——角色带 owner/admin/billing；REPEATABLE READ READ ONLY 事务 + tx 内 `verifyCurrentBillingContext` 重读成员/角色；scope-hash 游标（sha256 `['customer-payment-orders', userId, tenantId]`、v1、前缀 `p1.`、base64url 往返校验）；keyset `(created_at, id) < ($2,$3)` + `ORDER BY created_at DESC, id DESC` + `LIMIT n+1`；fail-closed 行校验（任意畸形值 → STORAGE_ERROR 500）；客户安全投影仅 9 字段（id/orderType/amountMinorUnits/currency/status/createdAt/updatedAt/paidAt/fulfilledAt），排除 provider_key/merchant_id/client_request_id/local_order_ref/funding_reference/provider_order_id/provider_attempts/provider_failure_code/funding_transaction_id/checkout_*/provider_submission*；错误码三族 _INVALID_INPUT(400)/_ACCESS_DENIED(403)/_STORAGE_ERROR(500)。
- **HTTP（E3-c，`src/saas/payments/http.ts` + `managed-saas.ts` 组合）**：`GET /console/api/v1/tenants/:tenantId/payment-orders`——GET-only、BODY_NOT_ALLOWED、cookie 会话、复用退款同款 `resolveCustomerRefundTenantContext`（结构相同零重复）、严格 query 白名单（limit 1-100 单现、cursor 单现、URL ≤8192）、服务缺席 → 503 `PAYMENT_ORDER_HISTORY_UNAVAILABLE`、`cache-control: no-store`、锁定信封 `{data, meta:{requestId}}`；组合在 refundHistoryHandler 之后调度。
- **控制台（E3-d，`web/src/api/saas-client.ts` + `saas-console.tsx`）**：类型 + fail-closed 校验器（orderType 仅 wallet_topup、amountMinorUnits 十进制串、currency `[A-Z]{3}`、8 态枚举、nextCursor ≤256）+ `getCustomerPaymentOrders`（redactErrors）；新页 `/console/billing`（`CustomerPaymentOrdersPage`）——8 态呈现映射（非终态带"请勿重复支付"提示与"尚未最终确认"标注）、错误文案五族（401→返回登录/403→无权/CSRF·ORIGIN→刷新/网络/默认）、租户选择器 role-band 过滤、游标栈分页、精确金额（最小货币单位千分位）；导航"账单"链接置于"退款记录"之前，同 showRefunds 闸（owner/admin/billing 可见）。
- **零 schema/ACL 变更**：CP 角色对 `saas_payment_orders` 已有全列 SELECT，安全投影为其子集；**064-079 退役与 001 台账（长度 67、max 版本 85）不变；角色模板无需重跑**。

### 验证
- 查询 service 单元 5/5（租户隔离 + 微秒稳定排序 + 精确 DTO 键清单 + 投影无 PSP 内部列、角色带 403 且未授权不发起查询、tx 内成员重读双拒绝、limit/游标/跨租户游标 400、损坏 state → STORAGE_ERROR）；HTTP 15/15（锁定信封 + 安全 DTO + 查询元组 + 零 payment/PSP 调用、401/403 角色闸、错租户 403、query 校验 400×5 + body 400 + POST 405 + 服务缺席 503）；web 客户端/页面 5/5（路由/GET/same-origin/signal、毒化字段全剥离、畸形生命周期 → INVALID_RESPONSE + 服务端错误脱敏、导航三角色可见两角色隐藏、精确金额 + 非终态提示 + aria 标签 + 无变更按钮 + 密钥不渲染、加载/空/安全错误/过期会话四态）。
- **真实 PG 门禁决策**：E3 无迁移、无授权变更，且与既审 customer-refund-query 同型（该孪生特性亦仅以单测 + HTTP 证据交付、无专属 real-PG 套件）；据此以 unit + HTTP + web 证据为准，不新增 real-PG 门禁。
- 全套件 exit 0（unit 3245 中 3227 通过 / 0 失败 / 18 本地 skip；integration 229 中 195 通过 / 0 失败）；根 `npx tsc --noEmit` 与 `web` tsc 均干净；E3 触及文件 biome 零错误；knip 无新增 unused exports（413 unused files 结构桶不变，Track H 所有）。

## 2026-10-10 追加：E4 运营后台补齐（用户管理/租户生命周期/操作员管理 + runtimeProbes，任务 #29，已完成）

### 交付
- **范围冻结（E4-a，#40）**：盘点确认全部原语已存在——saas_users.disabled_at、password_hash NULL fail-closed、saas_tenants.status 三态、saas_memberships、saas_platform_role_assignments、saas_mfa_credentials.revoked_at、双会话表吊销、007 MFA enrollment token（trusted_operator_cli 审计）。**零迁移**（086 槽位保留未用）；密码重置 = 操作员设定（全仓无邮件流）；操作员创建不经 HTTP 暴露 enrollment token 发放（007 审计标签为 trusted_operator_cli，superadmin HTTP 复用会误标审计）——MFA 注册走既有 CLI 流程。
- **治理服务（E4-b/c/d，`src/saas/platform/governance/`）**：共享件——`errors.ts`（五码 PlatformGovernanceError：400/403/404/409/500，安全文案固定不外传）；`actor.ts` `verifyGovernanceActor`（咨询锁 + 平台会话 totp 联合复核 + 角色新鲜重读，声称角色必须与当前分配**精确相等**，再 hasPlatformRole 闸，镜像 capacity-policy-service 460-523）；`cursor.ts` HMAC 签名游标（pu1./pt1. 前缀、filterHash、timingSafeEqual）。三服务：**PlatformUserGovernanceService**——listUsers（REPEATABLE READ RO、emailContains ILIKE `\` 转义 + active/disabled 过滤、keyset、9 字段安全投影永不选 password_hash）+ setUserDisabled（自我禁用 409 / 持平台角色目标 409 / 同态 409 / 吊销双会话表 + 审计）+ resetUserPassword（scrypt 在锁外）+ resetUserMfa（吊销全部未撤销 mfa 凭据 + 会话）；**PlatformTenantLifecycleService**——listTenants + setTenantStatus（active→suspended→active / close 终态，乐观 `WHERE status=$4` 守卫，非法迁移 409）+ takeoverTenant（superadmin、自我目标 409、closed 409、目标须活跃成员 404、先提升目标为 owner 再降其余 owner 为 admin——零 owner 窗口永不出现）；**PlatformOperatorManagementService**——listOperators + grantOperatorRole（ON CONFLICT 幂等冲突 409）+ revokeOperatorRole（自我撤销 409、**最后 superadmin 不变量**（咨询锁 + 排除目标计数）409、失最后角色吊销平台会话）+ createOperator（严格键白名单、hashPassword 锁外、email_canonical 冲突 409、响应不回显密码）。审计 entry_point `platform_governance`，仅稳定 ID + 动作（绝不含密码/token/邮箱）。
- **runtimeProbes 接线（E4-e）**：summary-service 新增 `PlatformRuntimeProbeStatus = ok|degraded|unavailable|not_configured` + 可选 probes 注入（缺席 → not_configured、抛错或越约返回 → unavailable、探针永不拖垮摘要）；providers.ts 新增 `redisReady`/`credentialKeyReady`；managed-saas 组合四探针（postgresql SELECT 1、redis、kms、worker 心跳 = 双队列表 10 分钟内有无验证 job 写入，空闲队列如实报 degraded 而非 unavailable）；web 端四态呈现映射。
- **HTTP + ACL + 组合（E4-f）**：12 条 `/admin/api/v1/governance/*` 路由并入既有 87.5K 调度器——users 列表 + disable/enable/password-reset/mfa-reset、tenants 列表 + suspend/resume/close/takeover、operators 列表/创建 + roles 授予/撤销（DELETE 三段路径）；治理路由**绕过** operations 一揽子写闸（`!isGovernanceRoute`）改按路由角色带：读 = superadmin/security/operations/support-readonly、用户写 = superadmin/security、租户 suspend/resume/close = superadmin/operations、takeover 与操作员管理 = superadmin 独享；严格体白名单（password-reset 仅 {password}、takeover 仅 {targetUserId}、create 仅 email/displayName/password/role）；错误经 `governanceError` 从稳定码**重建**（包装 service 永不能经此边界回显定制消息）；服务缺席 → 503 GOVERNANCE_UNAVAILABLE。ACL：runtime-privileges += saas_users UPDATE(password_hash,disabled_at,updated_at)、saas_tenants UPDATE += status（列首）、saas_platform_role_assignments DELETE；`deploy/managed-saas-postgres-roles.sql` 镜像三元组行同步（**部署注意：E4 授权变更后两份角色模板均须重跑**）。managed-saas 组合接线三服务（const 捕获保窄化）。
- **运营后台页面（E4-g）**：客户端 += 治理类型族 + fail-closed 校验器（UUID/时间戳/角色枚举/游标 ≤512、**响应含 passwordHash/totpSecret 等禁字段即 INVALID_RESPONSE 失败闭**、操作员角色数组去重）+ 12 方法（URL/方法/体钉板，DELETE 无体，禁 GET 带 CSRF）；三个新页 `/platform/governance/{users,tenants,operators}`——共享 useGovernanceList 分页 hook + GovernanceConfirmButton 两段确认（可测，不用 window.confirm）；用户页（邮箱/状态过滤、禁用/启用、密码重置内联表单、MFA 重置）、租户页（slug/状态过滤、暂停/恢复/关闭、superadmin 所有权转移内联表单）、操作员页（superadmin 独享、角色撤销逐项确认、授予/创建表单、MFA 走 CLI 提示）；导航按角色带显隐（读带见用户/租户、仅 superadmin 见操作员），路由注册进 platformRoutes 安全返回集。

### 验证
- 服务单元 13/13（fake-sql 夹具：SELECT 分支以 `sql.startsWith('SELECT')` 守卫避免吞 DELETE；角色切换经 `roleAssignments.splice` 使声称=当前精确匹配）；summary 探针 7/7（注入探针四态 + 越约 → unavailable）。
- HTTP 治理套件 `tests/saas/platform/http/governance.test.ts` 4/4：读带四角色通过 + finance 403 + 未认证 401 + status 白名单 400 + 服务缺席 503；写带（operations 拒用户写、CSRF 失败先于 service 调用、严格体 400、405）；域错误映射安全（GOVERNANCE_NOT_FOUND → 404 且响应不含邮箱/密码材料）；takeover superadmin 独享；操作员管理全路由 superadmin 独享 + grant/revoke/create 调度元组钉板。
- runtime-privileges 钉板 99/99（TABLE_GRANTS deepEqual、DELETE 负向前瞻、requiredColumns 双行）。
- web 治理套件 `tests/web/saas-platform-governance.test.ts` 5/5：客户端 12 调用 URL/方法/CSRF/体钉板 + 毒化字段剥离 + 精确键清单；失败闭（password_hash → INVALID_RESPONSE、畸形 status/重复角色 → INVALID_RESPONSE、短密码/坏 UUID/非法角色/坏邮箱 → 同步 INVALID_INPUT 且零 fetch）；三页角色带渲染闸。
- **真实 PG18 scratch 门禁**：以 postgres 超级用户重跑两份角色模板（roles + validation-worker grants），`MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL` 指向受限 control-plane 角色跑 `runtime-privileges.integration.test.ts` 1/1——live 探针逐列实测新授权（saas_users UPDATE 三列、saas_tenants UPDATE status 列首、saas_platform_role_assignments DELETE）全中，且 unsafe search_path 顺序照例拒绝。
- 全套件 exit 0（unit 3269 中 3251 通过 / 0 失败 / 18 本地 skip；integration 229 中 195 通过 / 0 失败 / 34 门控 skip）；根 `npx tsc --noEmit` 与 `web` tsc 均干净；E4 触及 39 文件 biome 零错误（压缩前写入的治理文件本轮补齐格式化 + 组织导入；60 警告 5 infos 为既有/可接受档）；knip 无新增 unused exports（删除未用 PLATFORM_GOVERNANCE_ERROR_CODES 冻结列表；新测试落既有 Unused files 结构桶，Track H 所有）。

## 2026-10-11 追加：H1 DB-01 存量盘点工具链 + 022/023 修复设计（任务 #31，工具链已完成；真实环境盘点待环境清单）

### 交付
- **CLI 贯通（H1-a）**：`saas:migration-audit` 新增可重复 `--legacy-checksum <22|23>=<sha256>:<evidenceId>`——审计模块内部的 `legacyChecksums` 契约此前无任何 CLI 入口（全仓 grep 仅 migration-audit.ts 一处）。命令层严格解析（版本/64hex/LABEL evidenceId、≤8 条、去重，畸形在任何基线读取与连接池创建前 INVALID_OPTIONS），标注语义不变：命中已登记历史仅附加 `KNOWN_LEGACY_CHECKSUM`，兼容性仍 `mismatch`，**永不授予放行**。
- **盘点运行器（H1-b，`scripts/db-01-inventory.mjs`）**：评审清单（`db-01-inventory-manifest-v1`，零秘密、DSN 仅经命名环境变量引用）逐库驱动只读审计；归档 `<env>.report.json` + `db-01-inventory-summary.md`（date/commit/环境标签/PG 大版本/台账 match 比/catalog sha/issue 码/GO 判定）；归档前扫描子进程输出，含连接串即拒存；永不生成或自批基线（§601）；exit 2 工具错误 / 1 任一 blocked / 0 全 matched。
- **证据模板（H1-c，`docs/evidence/db-01-inventory.md`）**：三问题框架（台账逐条一致？catalog 匹配评审基线？022/023 漂移是否已登记？）+ 逐环境记录模板 + 试点记录；README 模板索引同步。
- **022/023 前滚修复设计（H1-d，`docs/evidence/db-01-legacy-checksum-repair.md`，未实装）**：红线（禁改业务/财务账本、前滚单向、逐环境变更单、禁自动基线、未登记历史不放行）、前置条件（其余迁移全 match + 漂移全命中已批准映射 + catalog 匹配评审基线 + 无其他 issue + 备份就绪）、单事务双行参数化 UPDATE（谓词钉 version+旧 checksum、rowCount=1 否则回滚）、修复后三无映射复审计 matched + 启动门禁 + 证据归档、禁止情形清单、副本库演练要求；预留 `saas:migration-ledger-reconcile` 命令位待设计批准后实装。

### 试点暴露并修复的工具链缺陷
- commander 将 `--legacy-checksum` 映射为**单数**属性 `legacyChecksum`，命令层读复数 `legacyChecksums`——标注静默丢失（单元测试直调命令层所以全绿）。真实 CLI 试点（scratch PG18 + 人为改写 022 checksum 的一次性副本库）暴露后修复（action 层显式转发），并以真实 CLI 回归测试固定（畸形映射经完整 CLI 链路必须 INVALID_OPTIONS 而非 AUDIT_FAILED，证明映射到达命令层）。副本库演练后销毁。

### 验证
- `tests/cli/saas-migration-audit.test.ts` 57/57（+13：双版本标注/错版本与未登记值不标注/12 组畸形映射零 I/O 拒绝/真实 CLI 转发回归/--help 文档钉）。
- 真实 PG18 scratch 试点（两环境清单）：`model_router_saas_ci` 台账 69/69 全 match、仅 BASELINE_MISSING（无评审基线的预期安全拒绝）；legacy 副本 68/69 + CHECKSUM_MISMATCH_022_023 + KNOWN_LEGACY_CHECKSUM 正确同时发出。
- `npx tsc --noEmit` 干净；两 TS 文件 biome 规范化后零诊断（cli/index.ts 的 3 处 noExplicitAny 为 HEAD 既有漂移，Track H 所有）；`scripts/*.mjs` 属 biome 忽略清单（与 capture-gate-evidence.mjs 同款）。
- 挂账：真实待升级环境清单与评审基线不存在于仓内，逐环境盘点记录待环境可用时按模板补采；修复命令实装待设计评审。

## 下一任务

#32 B2 role supervisor 部署清单（deploy/ 角色化 systemd/compose 清单 + fail-closed 探针接线，Track I 前置）。

## 2026-10-11 追加：B2 role supervisor + B3 IAM/网络策略（任务 #32/#33，已完成）

### 交付
- **B2 supervisor 清单（`deploy/systemd/managed-saas/`）**：三角色 unit（control-plane / gateway / credential-validation-worker）+ 分组 target + 四份 env 示例（common 非秘密元数据 0440、角色秘密 0400）+ README。fail-closed 语义钉板：启动本身即探针（ping → schema 校验 → readiness → production-only ACL 逐列核验 → webhook schema → KMS readiness，已对 `managed-saas.ts` 实际序列核对）；`Restart=on-failure` 禁止放宽、禁止 wrapper 吞退出码、禁止 ExecStartPre 自动迁移、`NODE_ENV=production` 不得移除（ACL 核验仅 production 执行）；角色模板重跑→重启纪律；多实例网关按节点 enable；一次性管理命令（migrate/bootstrap/audit/mfa-enroll）明确不入 supervisor。
- **B3 IAM/网络策略（`deploy/managed-saas-iam.md`）**：四 PG 角色权限轮廓与禁止项、KMS 姿态矩阵（CP seal+rewrap / gateway、worker decrypt-only）、Redis 边界（永不权威）、监听器暴露矩阵（platform 不得公网）、egress 白名单模板（PSP 域名白名单为 EasyPay 退款明文 pkey 红线的缓解层；webhook 走 SSRF 钉板出口）+ nftables/k8s 骨架。
- **可执行核对（`scripts/check-managed-saas-deployment.mjs`）**：unit 强化指令/角色/Restart/内联秘密、env 文件权限（秘密文件 owner-only）、必备键、跨角色 DSN 隔离、common.env 零秘密值、已安装 unit 与仓内评审副本零漂移；只报告键名与权限位，绝不打印秘密值。

### 验证
- 夹具自检：正向 48 PASS / exit 0；负向注入四类缺陷（内联秘密、Restart=always、秘密文件 644、跨角色 DSN）全部 FAIL + exit 1。自检暴露并修复一个脚本缺陷：`Restart=always` 正则误命中 unit 注释（改按指令行解析，注释行豁免）。
- 部署声明与代码核对：workload role 集合、角色 DSN env 名、监听器归属、KMS 模块 env 名全部对照 `deployment.ts`/`managed-saas.ts` 实值；软件 KMS pilot-only 告警码引用准确。

## 下一任务

#34 C4 EasyPay mock PSP 对账/回调乱序演练（PAY-01 关闭前置）。

## 2026-10-11 追加：C4 EasyPay mock PSP 对账/回调乱序演练（任务 #34，已完成）

### 交付
- **共享 mock PSP（`tests/saas/payments/mock-psp.ts`）**：`startMockPsp` 从 easypay-provider.test.ts 抽为共享模块（mapi/query/refund 三端点可编程 handler + 原始表单参数记录），provider 测试改为导入（16/16 不变）。
- **回调乱序演练（`tests/saas/payments/easypay-drills.test.ts`，真实适配器 + 履约服务 + mock PSP）**：
  1. **重复回调**：字节级相同通知三次投递——第二次起 durable inbox 重放（replayed=true、同 inboxId、零新行），处理后重放仍不再入队，钱包恰好入账一次，履约前 QueryOrder 复核恰好一次；
  2. **签名冲突回放**：同事件身份（trade_no+status）不同金额——MD5 有效不等于一致，`PAYMENT_EVENT_CONFLICT` 拒绝，零重复入账、订单态不变；
  3. **乱序早到**：回调先于本地 provider-order 持久化到达——inbox 收存不丢弃（orderId null）、首轮处理转重试，链接落地后同字节重试经复核履约入账。
- **退款 unknown 对账演练（refunds.test.ts 内，真实 easypay refundAdapter + 共享退款夹具）**：PSP 接受即 provisional pending（冻结保留、台账零过账、余额不动）；三轮 worker 对账周期 queryRefund 恒本地 unknown（**零 HTTP**），永不重放提交（PSP refund 调用恒 1）、永不终态、冻结恒存——显式 `unknown` 状态转人工；同时钉板退款请求明文 pkey 上行（出口白名单红线的实证点）与 out_trade_no 优先语义。
- **夹具参数化（零行为变化）**：`FakeRefundDatabase` 构造接受 provider 身份覆盖（默认 fake-psp 原值，walletTopUp/servicePlanOrder 构造体内构建保引用稳定）；`createService` 适配器类型放宽为 `PaymentProviderRefundAdapter`（冻结对象安全）+ 身份覆盖参数。

### 演练暴露并修正的两个测试侧缺陷（生产代码零改动）
- 通知缺 `notify_time` 时 occurredAt 回退本地时钟——时钟前进后字节级重放被误判 PAYMENT_EVENT_CONFLICT；真实 epay 通知恒带 notify_time，演练通知补齐后语义正确（适配器行为不变）。
- 乱序演练复用陈旧行引用——fake DB 事务失败回滚以克隆替换 state（与 payments.test.ts:305 同款已验证模式），改为批后重新取行。

### 验证
- easypay-drills 3/3、easypay-provider 16/16、refunds 27/27、payments 18/18；payments 全目录 113 通过 / 0 失败 / 1 门控 skip（PG 集成）。
- `npx tsc --noEmit` 干净；C4 触及文件 biome 零诊断（两文件补齐格式化/组织导入后）。

## 下一任务

#36 G0 营销域设计冻结（兑换码/促销码/邀请返利/公告；账本钩子走 postVerifiedFunding 同源路径；迁移编号 089 起）。

## 2026-10-11 追加：G0 营销域设计冻结稿（任务 #36，已完成，待评审）

- `docs/marketing-domain-design-2026-10-11.md`：四子域（G1 兑换码/G2 促销码/G3 邀请返利/G4 公告）数据模型、状态机、幂等键、权限带、ACL 镜像、HTTP 路由、测试门禁规格与显式不做清单。对齐 C-6：余额型兑换与返利均走 `postVerifiedFunding` 同源路径（namespace `marketing.redeem`/`marketing.affiliate`）；订阅型走 plans 发放路径；促销码仅作 checkout 定价快照计算输入不事后改价；公告事件复用 `platform.maintenance` 不扩 C-5。迁移编号 089–092 分配 + 093–098 预留（Track H 仲裁表）；交付顺序 G1→G4→G2→G3，M3 出口 G1+G4。
- 关键设计决策：兑换码不可逆存储（sha256+展示前缀，明文"显示即焚"）；促销码面向公开传播明文存储（非凭证，不适用摘要红线）；返利以平台钱包余额发放、不做现金提现通道（提现审核记录为后续候选，防膨胀）；公告已读按 (announcement,user) append-only。

## 下一任务

#37 G1 兑换码域实现（迁移 089 + 核销全链 + 运营生成/禁用 + ACL 镜像 + PG 门禁）。

## 2026-10-11 追加：G1 兑换码域核心（任务 #37，核心完成；HTTP 层与 CI 门禁接线为后续任务）

### 交付
- **迁移 089（唯一迁移写者，注册表 [70]）**：`saas_marketing_redeem_codes`（不可逆存储 code_hash 64-hex UNIQUE + 展示前缀 `[A-Z2-9]{4,8}`、kind balance/subscription 互斥 CHECK、定点金额文本、状态机 active→redeemed/disabled 单向 + 终态事实形状 CHECK、FK→plan_versions/tenants/users）+ `saas_marketing_redeem_redemptions`（append-only、UNIQUE(code_id) 单次核销 DB 兜底、ledger_transaction_id FK）。守卫族：身份不可变/状态机单向/终态事实不可变/active 不得携终态事实（55006）+ 双表 no-delete，全部 invoker + pinned search_path。注册表与 ~12 钉板文件同步（版本 `[...1-60, 63, 80-85, 87, 88, 89]`、长度 70）。
- **服务（`src/saas/marketing/redeem-codes.ts`）**：余额型全链——运营生成（base32 无歧义字母表 20 位≈99bit、批量 ≤100、明文仅响应一次性返回、hash 冲突有界重试、同事务审计）；禁用（active-only CAS + 审计 + 已禁用幂等读出 + 已核销 409）；列表（keyset 分页 + hash 永不出库）；客户核销（FOR UPDATE + `WHERE status='active'` CAS + `postVerifiedFunding` C-6 钩子 namespace `marketing.redeem` business_key `<codeId>:<tenantId>` + redemption 同事务 + 审计；同租户重放=幂等读出、异租户/未知/禁用=统一 REDEEM_CODE_INVALID 不泄露存在性）。订阅型 schema 已就位但生成/核销均 fail-closed REDEEM_KIND_UNSUPPORTED（plans 零价发放链 G1.5 接线）。
- **ACL 镜像**：runtime-privileges 注册表 += codes SELECT16/INSERT11/UPDATE6 + redemptions SELECT6/INSERT6；roles SQL 五三元组行同步；gateway 零授权；钉板 99/99。
- **测试**：迁移钉板 5/5；服务单测 11/11（生成/校验/冲突重试/禁用/核销 C-6 元组/重放/存在性隐藏/订阅型拒绝/CAS 败者回滚/列表分页）；**真实 PG18 门禁 3/3**（`model_router_test_089`，三受限角色：生成→核销→钱包 2500→重放零重复→异租户 INVALID→并发同租户 redeemed+replayed 钱包恰好 5000 两笔→禁用路径；gateway 42501 双负向 + runtime 探针）。

### 首次真实 PG 暴露并修复的问题（假 DB 无法发现类，与 A5 DATE 同款）
- node-pg 把 timestamptz 解析为 Date 对象，mapCodeRow 的字符串校验 fail-closed STORAGE_ERROR——新增 timestampText 归一化；单元假 DB 全字符串所以从未命中。
- 码字母表 31 字符但生成用 `& 31` 掩码——index 31 产出 undefined 拼进明文（'J9Bu-ndef-ined...'），单测格式断言捕获；改 `% length`。随后发现 CHECK `[A-Z2-7]` 与字母表含 8/9 不一致，迁移（未发布）放宽为 `[A-Z2-9]` 并同步钉板。
- scratch `model_router_saas_ci` 检出 050 门禁漂移（044 outbox 函数体被早前集成测试改动）——G1 验证改用新建 `model_router_test_089` 全链 001→089（migrator 角色 + roles 模板前置，search_path 依赖角色模板），该漂移库留 Track H 处置。
- 易付 fixture 的 roleUrls 拒绝连接参数与未授权库名——`model_router_test_*` 命名 + 无查询参数 URL。

### 验证
- 全套件 exit 0；`npx tsc --noEmit` 干净；G1 触及文件 biome 零诊断。

## 下一任务（第二波并行已启动）
- G1 HTTP 层（客户核销 + 运营路由 + managed-saas 组合，子 agent A）；G4 公告域全链 092（子 agent B，唯一迁移写者）；Track I 演练（子 agent C）。G1.5 订阅型发放、D4 配额同步、E3 通知中心（依赖 G4）列后续。

## 2026-10-11 追加：G1 HTTP 层 + Track I 演练（并行子 agent 交付，已验收）

### G1 HTTP 层（子 agent A，验收通过）
- `src/saas/marketing/http.ts`：客户核销路由 `POST /console/api/v1/tenants/:t/redeem`（cookie 会话 + same-origin + 双提交 CSRF + 全租户角色活跃成员 + 严格体 ≤1KiB + 双维固定窗口限速 user 10/min·IP 30/min 429+retry-after + 统一"兑换码无效"不泄露存在性 + service 缺席 503）；运营三路由 `/admin/api/v1/marketing/redeem-codes`（POST 生成 201 一次性明文码 / GET 列表 / POST :id/disable；平台会话 + CSRF + operations/finance 角色带 + actor 仅会话推导 + 错误重建不泄露）。
- `managed-saas.ts` 纯组合（customer 链 paymentOrderHistory 之后、platform 链 usageCorrection 之后；单一 MarketingRedeemCodeService 装配 + 无状态 PlatformWalletLedgerService 实例）。
- `tests/saas/marketing/http.test.ts` 23/23；payments 113/113 零回归；tsc/biome 干净。
- agent 报告的本体测试 flake（codePrefix 断言 `[A-Z2-7]` 未随字母表放宽到 `[A-Z2-9]`）已由主线修复，5 连跑验证。

### Track I 演练（子 agent C，验收通过；OPS-01 主体关闭，尾项见遗留）
- I1：`scripts/drills/instance-child.mjs`（启动门禁链探针子进程，--mode hold 持租约供 SIGKILL / --mode once 门禁复探）+ `backup-restore.mjs`（pg_dump→校验→drop→重建→restore→指纹比对（台账 sha256+逐表行数）→verifySaasMigrations→只读审计，全程 fail-fast）。
- I3：`dual-instance-failover`（双 gateway 实例 → fencing 阻挡 2.5s 无越权 → SIGKILL 死于信号 → 幸存者 fencing 三次独立运行严格递增（1→2/4→5/7→8）→ 重启重过门禁 → 优雅交还，恰好 3 次获取）；`backup-restore`（restored 106 tables/71 ledger rows、台账 hash 逐字节一致；损坏 dump 在 drop 源库前拒绝、异源 dump 拒绝且目标库被 drop 无半恢复态）。
- 证据 `docs/evidence/ops-01-drills.md` + drills README 扩展 + CI isolated 门禁接入（钉板 11/11）；保留库 `model_router_test_drill_failover`/`_backup`。
- 验收：CI 钉板 11/11、tsc 干净、skip 语义 3/3、主线独立复跑 backup-restore 绿（5.7s）。
- 遗留（OPS-01 完全关闭还需）：backup-restore CI 接入（管理员 URL 超出 isolated runner env 契约，设计已备）、完整 supervisor 装配与 worker 角色 SIGKILL、I3 尾项 OS cleanup、REL-01 受审 baseline 复审计。

## 下一任务
G4 公告域（子 agent B 进行中）；完成后第二波：D4 配额同步、E3 通知中心（依赖 G4 API）、G1.5 订阅型发放。

## 2026-10-11 追加：G4 公告域全链（子 agent B + 主线组合，已验收）

### 交付
- **迁移 092（注册表 [71]，唯一迁移写者）**：`saas_marketing_announcements`（kind maintenance/info/billing、severity 三级、title≤200/body≤8000、publish_at/unpublish_at、状态机 draft→published→withdrawn 单向、version CAS、守卫族：身份不可变 + 状态机单向 + **任何 UPDATE 必须 version+1**（首轮探针发现"不改 version 的 UPDATE"被放行后收紧，全链复验）+ reads append-only + 双表 no-delete，3 函数 pinned search_path）+ `saas_marketing_announcement_reads`（(announcement,user) 组合 PK 幂等已读）。090/091 保留 G2/G3，093-098 预留（093 后经仲裁让位 D4）。
- **服务**：createDraft/publish/withdraw（CAS+锁+同事务审计）+ listPublished（窗口过滤、severity 优先、(rank,publish_at,id) keyset）+ markRead（ON CONFLICT DO NOTHING 幂等）；`MarketingAnnouncementEventPort` 接缝（publish CAS 赢家同事务恰好一次；fan-out worker 归 G4.5）。
- **ACL**：control-plane SELECT/INSERT/UPDATE 仅 status/unpublish_at/version/updated_at；gateway 零授权；roles SQL 五三元组行；钉板 99/99。
- **HTTP**：ops 四路由（create/publish/withdraw/list，operations 角色带）+ customer 两路由（list/read，全活跃成员）；主线完成 managed-saas 组合（customer 链 redeem 之后、platform 链 ops redeem 之后；事件端口显式不接线并注释 G4.5）。
- **测试**：迁移钉板 + 服务单测 + HTTP 单测 54 测 0 败；真实 PG18 门禁 3/3（`model_router_test_092`：draft→publish→可见→已读幂等→CAS 冲突→withdraw→不可见；审计三行有序；gateway 42501；runtime 探针）；手动探针 8 负向全 55006 + 3 正向；启动组合套件 49/49；主线独立复跑门禁绿。

### 评审记录（Track H 关注）
- **060 钉板机制变更**：agent 格式化 060 PG 源文件（既有格式债）致精确源码钉失效，钉板改为空白容忍的 token 序列匹配（collapse 归一化，标记原文/顺序语义不变，同时把版本清单钉更新到 `..., 89, 92]`）。机制强度略降（不再字节精确）但可维护性消除反复重盖章——留 Track H 评审是否推广到其他源码钉。
- 061 测试的 G1 浪次遗留过期钉（69→71、at(-9)→at(-11)）由 agent 顺带修复。

## 下一任务（第二波并行已启动）
D4 配额同步（迁移 093 仲裁让位营销预留段）、E3 通知中心（消费 G4 API）、G1.5 订阅型发放（零迁移）。

## 2026-10-11 追加：E3 通知中心 + G4 客户投影泄漏修复（并行 agent E 交付 + 主线加固，已验收）

### E3 通知中心（子 agent E，验收通过）
- 客户端（saas-client.ts）：公告类型族 + fail-closed 校验器（枚举/UUID/时间戳/游标 ≤512/毒化字段剥离）+ getTenantAnnouncements/markTenantAnnouncementRead（CSRF 双提交、redactErrors 脱敏）。
- 页面 `/console/notifications`：severity 徽标、kind 标签、未读视觉态（琥珀边条+徽章）、乐观已读生命周期（失败回滚可重试、双击/重复双闸）、游标栈分页、四态、导航注册（全租户角色可见）+ 默认租户未读计数徽章（invalidate 联动）。
- 测试 9 新增 + tests/web 219/219 零回归；根/web 双 tsc 干净；biome 零新增。
- 设计取舍记录：徽章按默认租户 limit=100 首页计数（多租户聚合需后端 unread-count 端点，列后续候选）；既有 clearLocalSession 未清 customerPaymentOrderRootKey 缓存（建议顺手补）。

### G4 客户投影泄漏修复（agent E 观察项，主线处置）
- `PublishedAnnouncementView` 原继承运营全字段视图，客户列表响应携带 `createdByUserId`（运营身份）及 status/version/内部时间戳——收窄为独立八字段客户安全投影（id/kind/severity/title/body/publishAt/unpublishAt/readAt），服务与 HTTP 双层钉板（Object.keys 精确清单 + 序列化禁词扫描）；PG 门禁 lifecycle 子测试复跑绿。
- 注意：092 库 runtime 探针子测试在 D4 落地前处于预期红（D4 在途的 quota 列注册表使探针要求新授权）——D4 完成后对 092 库应用 093 + 重跑角色模板并复跑该门禁。

## 下一任务
D4（agent D）与 G1.5（agent F）进行中；完成后复跑受影响门禁 + 全套件 + 第二波收尾。

## 2026-10-11 追加：G1.5 订阅型兑换发放链（子 agent F + 主线 HTTP DTO 放开，已验收）

### 路径决策（评审记录）
- **A（复用 fulfillVerified）排除**：`verified_amount_shape`/`verified_fields_shape` CHECK 强制非零金额 + 完整 PSP 证据链，"零价已验证履约"在 schema 下不可表达；伪造证据会污染 verified_settlement_unique、退款流（可"退"未收款项）与财务口径。
- **B 精化落地**：snapshots/subscriptions.order_id 均 NOT NULL FK + entitlement source_shape_check 要求挂 snapshot——发放必须建订单壳，唯一合法形态 = **cancelled 终态壳**（guard 禁止 cancelled→paid/fulfilled 不可支付、CHECK 允许 verified_* 全 NULL 零证据伪造、审计不记"支付"）。幂等键 `client_request_id='marketing-redeem:<code id>'`（DB UNIQUE 兜底）。

### 交付
- plans：`grantMarketingSubscription`（participant 式入口，与 applyApprovedRefundEntitlementEffect 同模式）——重放纯读、默认项目解析、published 复核、active 订阅冲突拒绝（**不隐式 supersede 付费订阅**，码保持 active 可期满后再核销）、profile scope 交集、cancelled 壳+快照+entitlement（authz_version=1）+订阅+回链+审计 `service_plan.marketing_grant`；`assertMarketingGrantPlanVersion`（生成期 published 校验）。
- 兑换服务：`MarketingSubscriptionGrantPort` 端口（构造必选）+ generateSubscriptionCodes（事务内 published 校验）+ redeem 订阅分支（CAS 后同事务发放，redemption.ledger_transaction_id=NULL）+ RedeemResult 改 kind 判别联合 + mapPlansGrantError（ACTIVE_SUBSCRIPTION_EXISTS→409）。REDEEM_KIND_UNSUPPORTED 保留为未知 kind 防御。
- **主线补完**：ops 生成路由 kind 判别 DTO（`{kind:'subscription', count, servicePlanVersionId, batchRef?}`；balance 无 kind 向后兼容；互携字段/错 kind/缺字段全 400 且零 service 调用）+ 客户核销响应 kind 分支；managed-saas 接线 `subscriptionGrants: customerPlanService`。
- 测试：plans +7、redeem +6、http +3（订阅响应形状/判别分发/严格体矩阵）单测 60/60、25/25；**真实 PG 门禁 4/4 ×3 连跑稳定**（089 库按主线重建到工作树 schema 后：cancelled 壳 verified 全 NULL、30 天窗口 interval 精确、钱包台账零行、审计双动作、重放零重复、第二码冲突回滚、探针过）。

### 环境腐化处置（agent F 上报，主线已修）
- 089 scratch 库 prefix CHECK 停留在初稿 `[A-Z2-7]`（主线放宽字母表后未重建）+ runtime 钉板领先该库 schema（092 表缺失）→ 随机撞约束与探针红；**已 drop 重建该库到工作树全链 001→093 + 角色模板二次对账**，门禁 3 连跑确定全绿。

## 下一任务
D4（agent D）收尾验收；092 库待 D4 落地后应用 093 + 角色模板复验探针；全套件健康栈终审。

## 2026-10-11 追加：D4 配额同步（子 agent D，已验收）+ 第二波收尾

### 设计决策
- **快照列（非独立表）**：配额与账号 1:1 无独立身份/历史（信号原地覆盖，红线要求不进计费无账本语义）；资格查询零额外 JOIN；沿用 082 调度信号落账号表先例；NULL=未知=现状行为零回填。
- **迁移 093 仲裁**：090/091 保留 G2/G3，093 由营销预留段重新分配给 D4（001 注释如实记录，营销演进顺延 094-098）。形状 CHECK：state⟺checked_at、remaining⟺currency、unknown/未检查⟺无金额（DB 兜底"绝不猜测"，PG 实证 23514 拒绝 unknown+金额组合）。
- **worker**：单事务 claim→probe→写（FOR UPDATE SKIP LOCKED 行锁即租约，崩溃回滚=自然 requeue）；失败也打 checked_at（防毒丸热循环）；SQL 层按编译期固定适配器三元组过滤（无适配器 fail-closed skip）；通用 OpenAI 风格 billing 实现（deepseek 两绑定，low watermark 500）；定点解析拒科学计数法/负数/浮点；多币种拒绝；凭据信封实时解封+清零。
- **调度消费（资格链非计费链）**：exhausted 候选级摘除、low 降权至 1、unknown/ok/NULL 原样、畸形值 block 全选（D1 模式）；**红线：配额仅调度信号，不进计费、不做利润否决 failover**。
- **ACL**：worker 复用 validation_worker 角色（探针+grants 增配额列 SELECT/UPDATE）；control-plane SELECT/UPDATE（无 INSERT，快照 worker 拥有）；gateway 动态读授权（只读）；093 后双角色模板须重跑（注释已写入）。

### 验证（agent 报告 + 主线独立复核）
- worker 单测 41 + scheduler 62 + ACL 钉板 112/112 + 迁移钉板；主线复跑 145+504 全绿。
- **真实 PG 门禁 6/6 主线独立复跑绿**（`model_router_test_093`：三角色探针、双 owner 真实解封同步、失败 unknown 无金额、SKIP LOCKED 并发 idle、gateway 42501 只读、worker/control-plane 各守其道）。
- 092 库按承诺应用 093 + 双角色模板重跑，**G4 门禁 3/3 恢复**（D4 在途期间的探针预期红解除）。
- 真实 PG 暴露并修复：形状 CHECK 实证有效（重置改全 NULL 基线）；可重复性 drain 辅助（账号不可删致重跑遗留 due 被全局扫描先 claim）。

## 第二波收尾状态
D4/E3/G1.5 全部交付并独立验收。剩余：全套件终审（后台运行中）→ 进度记录完成 → 后续候选（G2 促销码、G3 返利、C5 Stripe、H3 CI 聚合、D5/D6、E4 配额列运营面、多租户未读计数端点、备份恢复 CI 接入）。

## 2026-10-11 追加：R 系列方案 + Wave3-M 迁移与接缝（主线，已完成）

### 方案
- `docs/remaining-capability-plan-2026-10-11.md`：R1–R10 全覆盖（促销/返利/Stripe/OAuth 刷新/quarantine/D5/D6/fan-out/分组费率登记/A 级尾项清单），三波并行设计，统一验收模板。
- **编号铁律补记（064-079 教训）**：head 之下不得为未落地迁移预留编号——原预留序（095 quarantine…098 fan-out）会使低位 stranded，再仲裁为按落地顺序取号（fan-out=095，R5/R9/R6 取 096+）。

### Wave3-M（唯一迁移写者，注册表 [76]，head 095）
- **090 促销码**：双表（公开传播明文码 `[A-Z0-9-]{4,32}` + kind 互斥 CHECK + max_uses/窗口 + active→disabled 单向）+ usages append-only（order UNIQUE + per_tenant_once 冷冻副本部分唯一索引——PG 禁子查询索引谓词，改为反规范化）+ `saas_payment_orders.original_amount_minor_units`（回放按 original 比较保幂等语义）+ insert-only 守卫。
- **091 邀请返利**：attributions（终身不变 + no_self CHECK）+ policies（**单例 id='platform'** + version+1 精确守卫）+ rewards（append-only + source_funding_ref UNIQUE + bp 快照防回溯）。
- **094 OAuth 刷新**：双凭证表 5 列（state/next/last/force/error + 形状 CHECK，NULL=非 OAuth=现状）。
- **095 fan-out 游标**：announcements.fanout_completed_at + due 部分索引 + draft 形状 CHECK（withdrawn 保留历史戳——初版 CHECK 误拒 withdrawn 已修正）。
- **payments 接缝预埋（缺席=字节级行为不变，113/113 零回归）**：`WalletTopUpPromoEvaluator`（订单事务内定价，缺席+promoCode → PROMO_UNAVAILABLE 503 fail-closed；PROMO_CODE_INVALID 400 新码）+ `WalletFundingHook.afterVerifiedFunding`（funding 过账后 fulfilled 前同事务调用，抛错 → FULFILLMENT_RETRYABLE 计提 fail-closed）+ original 列全链（ORDER_COLUMNS/entity/mapper/replay 比较）。
- **ACL 四面镜像**：CP（promo 3+usages 2+affiliate 7+orders original SELECT/INSERT+announcements fanout+credentials oauth SELECT）；worker（oauth 五列 SELECT+UPDATE，探针清单+grants SQL）；gateway 零凭证写面保持；roles SQL + worker grants SQL 同步并已在模板库对账。
- **钉板治理**：runtime-privileges 钉板捕获 R4 初版设计冲突（gateway 写凭证违反"永不写凭证关系"不变量）→ 再仲裁为验证 worker 置 force 位（gateway 零写面保持），迁移/注册表/方案三处注释同步。
- 真实 PG18：fresh `model_router_test_095` 全链 001→095（76 行）+ 守卫探针 9 项全中（promo 身份/单向、orders insert-only、attribution 终身、policy +1、fanout draft CHECK）+ 角色模板对账后钉板 103/103。

### 并行启动（Wave 3 五路，组合归主线）
G 促销码（090）、H Stripe 零 SDK（无 DB）、I 邀请返利（091）、J OAuth 刷新（094，worker 角色 vw 密码已设）、K fan-out（095b）。

## 下一任务
五路验收 → 主线统一组合（managed-saas：promoEvaluator/fundingHook/双 worker 启动 + 路由）→ 全套件终审。

## 2026-10-11 追加：R3 Stripe 适配器 + R2 邀请返利（子 agent H/I，已验收）

### R3/C5 Stripe（agent H，验收通过）
- `payments/providers/stripe/`（protocol 217 + provider 633 + index）：零 SDK 直连 v1——PaymentIntents create（Idempotency-Key=localOrderId、metadata out_trade_no/tenant）/retrieve 复核、webhook v1 HMAC-SHA256 验签（t.v1 常量时间比较 ±300s、多 v1 不一致拒）、acceptance 三态（card_error 需 Search API 查无才 rejected，查询失败 fail-closed 回 unknown）、confirmEvent 六步复核链（NOT_FOUND→ORDER_REF→NOT_SUCCEEDED→AMOUNT×2→CURRENCY→INTENT_MISMATCH）、recoverOrder 仅 id 直查不新建、**退款 queryRefund 真实 retrieve 三态（C5 核心价值：证明三态抽象对全能力 PSP 不坍缩，与 easypay 恒 unknown 对照）**、merchantId=publishableKey、currency 小写 wire/大写域、client_secret 走 qr 载体、密钥 replaceAll 脱敏。
- 测试：provider 14 + drills 4（验签+retrieve 复核才入账恰好一次/不确认→对账零入账/重放/冲突/退款 pending→succeeded 落台账释冻结 + failed 释冻结不记账）；payments 134→142 零回归；tsc/biome 干净。遗留：装配参数与 Stripe.js publishableKey 下发归主线；Search API 索引延迟语义列 COM-01 沙箱复核。

### R2/G3 邀请返利（agent I 停顿后恢复完成，验收通过）
- `marketing/affiliate.ts`：邀请码 16 字符 = 8 派生防伪段（sha256 域分离+部署 salt）+ 8 租户定位段（uuid 末 5 字节 base32，候选反查+全码 timingSafeEqual 核验，transplant 拒绝）；bindInviter（域级 advisory 锁 + ≤32 层上溯防环 fail-closed AFFILIATE_CYCLE + 幂等重放）；政策单行 CAS（缺行 disabled v0 防御读出）；**WalletFundingHook 端口**（无归因/disabled/bp=0/floor=0 四零副作用、政策行 FOR UPDATE 快照、floor BigInt、C-6 namespace marketing.affiliate、ON CONFLICT 吸收重放、异常→FULFILLMENT_RETRYABLE）。
- `marketing/affiliate-http.ts`：客户两路由（getMyAffiliate/bind，双维限速）+ ops 三路由（policy GET/PUT CAS + rewards 列表，operations/finance 带）。
- 测试：服务 14 + HTTP 10 + 接缝 3（hook 失败 → retrying+全回滚零残留、backoff 后精确计提一次、终态重放不重跑）+ **PG 门禁 4/4 主线独立复跑绿**（绑定→CAS→履约计提→inviter 250+bp 快照+台账元组→重放零重复→改 bp 新计提 1000 旧行不变→gateway 42501+探针）。
- 钉板顺修（Wave3-M 遗漏）：092/093/061 三个文件的过期 gap/位置断言（090/091 已落账、长度 76、at(-16)）——db 套件 423/0 败。

## 下一任务
G（促销）/J（OAuth 刷新）/K（fan-out）三路收尾验收 → 主线统一组合（promoEvaluator/walletFundingHook/双 worker + 路由）→ 全套件终审。

## 2026-10-11 追加：Wave 3 五路交付与主线组合（R1/R2/R3/R4/R8 全部验收，迁移 head 096）

### R1/G2 促销码（agent G 停顿后恢复完成，验收通过）
- `marketing/promo-codes.ts`（ops 三方法 + WalletTopUpPromoEvaluator 端口实现：码行 FOR UPDATE + 窗口/status/per-tenant 锁下重查 + 计数不超卖 + percent floor/amount_off clamp 定点 + 零价统一 PROMO_CODE_INVALID 拒绝（对 plan 文本 clamp 的偏离已论证：030 CHECK>0 禁改）+ usage 同事务 + 审计 actor_user_id=NULL checkout 无身份）+ `promo-http.ts` ops 三路由 + payments/http createOrder promoCode DTO（仅该路径）。
- 测试：服务 16 + HTTP 11 + 接缝 7 + **PG 门禁 6/6 主线独立复跑绿**（折后冻结/original insert-only/双连接并发 maxUses=1 恰好一胜一拒/gateway 42501/探针）。
- **真实 PG 首次执行 createWalletTopUp 暴露并修复两处存量生产 bug（fake DB 永不可达类）**：insertOrder 同参数跨 uuid/text 列 42P08（$1::uuid 修复）；markOrderPending 赘余参数跳号 42P18（删赘重编 $6-$10→$5-$9）。**建议 Track H 排查其他未上真 PG 的支付写路径同类问题**。

### R8/G4.5 公告 fan-out（agent K 完成，验收通过）
- `webhooks/announcement-fanout-worker.ts`（claim 短事务 SKIP LOCKED → 逐租户独立短事务入队 → 全量后完成 CAS（version+1 满足 092 守卫）；幂等键 `announcement:<id>:<tenant>`、occurred_at=publish_at 重放字节一致；C-5 四 drop 码吞没；body 超 8KB 预算确定性码点截断；claim 后 withdraw 拒绝完成）+ producers `platformMaintenanceAnnouncement` + announcements 三接缝方法 + no-op 事件端口（冻结决策 b：publish O(1)）。
- **迁移 096（主线，R8 硬阻断修复）**：043 载荷契约把 platform.maintenance 钉死为占位形状 {starts_at,ends_at,impact}（从无生产者）——088 模式守卫置换为公告七键形状；语义扩展型（非等价），**存量 platform.maintenance 事件行存在即 fail-closed 转人工**（占位形状从无生产者故恒零行）；catalog 快照/ACCESS EXCLUSIVE/pg_catalog-only 后条件/零 ACL 变更全套守卫。
- **教训（已入钉板测试）**：TS 模板串内正则 `\d`/`\.` 被吃成字面 `d`/`.`——首个 fan-out 门禁全灭定位到 deparsed 约束 `^d{4}-d{2}...`，修复为 `\\d`/`\\.`（043 源约定），096 钉板测试直接断言运行时串形态。
- **环境教训**：debug 脚本以 postgres URL 误跑迁移致 public schema 污染 120 函数（001-049 重放）→ out_of_schema_function_privilege 探针红——模板库 drop 重建（迁移只经 migrator URL）。095b 同步重建。095c（agent 证据库）保留。
- 门禁 5/5 绿（publish 不内联扇出/单 sweep 恰好一租户事件+delivery+完成 version 2→3/重扫零新增/撤回不扇出/gateway 42501+探针）。

### R4/G2 OAuth token 刷新（agent J 完成，验收通过）
- `supply/oauth-token-refresh-worker.ts`（两阶段租约：worker 角色行锁 claim+解封+有界端点调用 → 提交 refreshing 标记 → 特权 rotator 接缝跑既有轮换路径 `replaceProviderCredentialSecretWithAudit`（v+1/旧版本 retired/authz+1/058 失效族/D3 复验/审计）→ finalize 守卫 state='refreshing'；stale-refreshing 回收 15min 兜底崩溃窗口；确定性 ±10% 抖动；失败指数退避 ≤6h；force 位成功失败均消费防热循环；新材料 Buffer fill(0)）+ 验证 worker 401 类终态置 force 位（`credential_rejected` 条件写）。
- 适配器注册表两条真实绑定（anthropic/claude-code/oauth、openai/codex-cli/oauth，公开 clientId，固定 https 端点）；无绑定三元组扫描 SQL 即排除。
- 测试：worker 53 + 验证 worker 38 + **PG 门禁 8/8 ×2 + D4 同库回归 6/6**（真实软件 KMS 解封→新版本链+复验 job+审计；42501 负向矩阵（worker 写 current_version/versions/jobs/accounts.priority 拒、写授权 oauth 列过））；主线独立复跑 8/8 绿。
- 遗留（J 记录）：OAuth 凭证入驻路径尚未初始化 oauth_refresh_state（NULL=非 OAuth 语义保持，创建 OAuth 凭证时置 idle+next 才接管——属供给域后续）；模板曾残留再仲裁前 gateway force 授权（已在重建模板消除）。

### 主线统一组合（managed-saas.ts，全部接入口径化）
- 支付：`walletTopUpPromo: marketingPromoCodeService` + `walletFundingHook: marketingAffiliateService`（PaymentFulfillmentService 选项）。
- 路由：customer 链 += affiliate（redeem→announcements→affiliate）；platform 链 += promo/affiliate ops（redeem→announcements→promo→affiliate）。
- workers：`announcementFanoutWorker`（webhooks.enabled 块内，announcementFanout 选项门 {intervalMs,batchSize}，closeAllResources 第 14 参纳入关停链）+ `oauthTokenRefreshWorker`（validation-worker 运行时，**仅当部署显式提供 `oauthTokenRefreshRotator` 特权接缝时启动**——受限 worker 角色写不了版本链，跨角色 CP 装配属部署评审，缺席=pre-R4 行为+选项文档）。
- 事件端口：`createAnnouncementFanoutEventPort()` 接入 announcements service（替换 G4 的未接线注释）。
- ManagedSaasRuntime += 两 handle 字段；inviteCodeSalt 派生自 deploymentId。
- 验收：startup 49/49；marketing+payments+webhooks 349 测 342 过 0 败；tsc/biome 干净。

## 下一任务
全套件终审 → R 系列准出汇总 → Wave 4 候选（R5 quarantine、R6 D5 计数器、R7 D6 健康、R9 分组评审、alipay/wxpay）。

## 2026-10-11 追加：Wave 3 准出终审（全绿）

- 钉板收尾：095/061 位置与长度断言随 096 落账同步（095 at(-1)=96、061 length 77/at(-17)/消息串）；096 专属钉板 5/5（析取支替换/转义形态/守卫序列/零越权变更）。
- **最终认证**：全套件 exit 0、全输出零 ✖——integration 239 测 195 过 0 失败 44 门控 skip；tsc 干净；biome 触及文件零诊断；knip 无新增（stripe 未装配属预期、测试文件落既有结构桶）。
- R 系列准出证据索引：R1 `promo-codes.postgres.integration.test.ts` 6/6（090 库）；R2 `affiliate.postgres.integration.test.ts` 4/4（091 库）；R3 `stripe-provider/drills` 18/18（mock stripe）；R4 `oauth-token-refresh.postgres.integration.test.ts` 8/8×2（094 库）；R8 `announcement-fanout.postgres.integration.test.ts` 5/5（095 库@096）；迁移 090-096 钉板 21/21 + 注册表/ACL 钉板全绿。

## 2026-10-11 追加：Wave4-M 迁移 097/098 + R9 评审登记（主线，已完成）

### Wave4-M（唯一迁移写者，注册表 [79]，head 098）
- **097 quarantine**：双账号表 validation_state 增 'quarantined' + quarantine_entered_at/reason_code + 守卫触发器双族（进入仅自 failed、退出仅向 verified、隔离期事实不可变、离开必须清事实列——**真实 PG 实测全矩阵**：verified→quarantined 55006、failed→quarantined 正向（同语句清 error_code 迁移到 reason_code，validation_error_shape 兼容）、事实篡改 2×55006、退出向非 verified 55006、退出不清事实 55006、清事实退出正向）。063 模式事务内 DROP+ADD（存量行天然满足超集 CHECK）。
- **098 D5+R7**：`saas_provider_account_rate_counters`（PK(scope,account,window_start)+窗口索引，upsert 实测 1/100）+ 双账号表 rpm_limit/tpm_limit（NULL=不限）+ health 表 health_score numeric(4,3)/half_open_probe_at（NULL=二元现状）。
- **ACL 四面**：CP（quarantine/rpm/tpm SELECT + rpm/tpm INSERT/UPDATE）+ gateway（health score/probe SELECT/INSERT/UPDATE + 计数器 SELECT/INSERT/UPDATE——R7 健康 pin 同步扩列）+ worker（quarantine SELECT+UPDATE，探针清单+grants SQL）；钉板 99/99+4/4、模板对账后 live 探针 OK。
- 钉板插曲：批量替换双重命中致 `97, 98` 重复（已修并全绿）。
- **R9 评审登记**：`docs/group-rates-review-2026-10-11.md`——结论**不新建 group 实体**（权利模型已更严格；租户级定价倍率用 G2 已验证的"计算输入"模式以 1/10 成本覆盖；限流租户+账号两级已足），若 M4 确认套餐需求仅允许"租户标签+倍率表"最小形态，严禁第二套授权语义；M4 检查单落档。

### 并行启动（Wave 4 六路，组合归主线）
L quarantine 语义（097）、M D5 限流调度（098，独占 scheduler）、N D6 连续健康（098b，纯函数+写入侧，scheduler 归 M）、O1 alipay、O2 wxpay、P OAuth 入驻初始化（#18a）。

## 下一任务
六路验收 → 主线统一组合（R5 选项/R6 消费点/R7 接缝/worker 接线）→ 全套件终审 → 方案 R 系列收官评估。

## 2026-10-11 追加：R3b alipay + R3c wxpay 适配器（子 agent O1/O2，已验收）

### R3b alipay（agent O1，验收通过）
- `payments/providers/alipay/`（protocol 399 + provider 610 + index）：仅 `alipay.trade.precreate` 直连模式（popup/pagepay/wappay 配置层显式拒绝，对齐 mapi-only 红线；**身份决策**：precreate 无 trade_no → 订单锚定 out_trade_no，recover 绝不返回 trade_no 防 webhook 匹配断裂）；RSA2(SHA256withRSA) 请求签名/通知验签双规则钉板（KAV 已知答案向量 + mock 复演网关侧验签）；acceptance 三态（业务失败+查单查无才 rejected）；confirmEvent 五细分 outcome_code；退款 out_request_no 天然幂等 + fastpay.refund.query 真实三态（REFUND_SUCCESS/失败集/pending/not_found，无伪造裁决）；extend_params 透传偏差以 passback_params 回显补救（记录在案）；分↔元两位小数定点。
- 测试 19+4 全绿；payments 191/190 零回归；tsc/biome 干净。

### R3c wxpay（agent O2，验收通过）
- `payments/providers/wxpay/`（protocol + provider + index）：仅 native 下单（jsapi/app 留扩展位显式拒绝——checkout 无法纯服务端完成，半成品削弱 fail-closed）；WECHATPAY2-SHA256-RSA2048 请求签名（openssl 独立 KAT 双向量）；通知平台证书验签（/v3/certificates 获取+apiV3Key GCM 解密+有效期钉板+serial 驱动轮换+未知 serial 单次刷新并发去重；bootstrap 循环信任锚已文档化）+ AES-256-GCM 资源体解密 ±300s；confirmEvent 八细分 outcome_code；**退款先查单取原始订单 total 再提交（不信用调用方金额）**+ 查询真实三态；out_trade_no 32 字符限制确定性映射（`h+sha256[0:31]`）；金额裸 JSON 整数 token 插值 + 响应 Number.isSafeInteger 守卫（杜绝浮点舍入冒充）。
- 测试 21+4 全绿；payments 191/190 零回归；tsc/biome 干净。

**PSP 渠道宽度进展**：easypay → +stripe → +alipay → +wxpay（sub2api 五家已覆盖四家，余 airwallex 一家；抽象经四个异构 PSP 验证不坍缩——MD5 弱签/easypay 恒 unknown、HMAC/stripe 全量、RSA2/alipay、RSA+GCM/wxpay 四族签名与查询形态全部映射到同一三态契约）。

## 下一任务
L（quarantine）/M（D5）/N（D6）/P（OAuth 入驻）四路收尾验收 → 主线统一组合 → 全套件终审 → R 系列收官。

## 2026-10-11 追加：R5 quarantine 语义（子 agent L，已验收）

- `credential-validation-worker.ts`：终态失败按账号**进程内连续失败计数 ≥3** 进入 quarantine（单语句清 error_code→reason_code、WHERE `validation_state='failed'` 原子再门控 + 097 守卫二次强制——计数只是加速器，分裂/陈旧计数绝不可能强制 DB 拒绝的转换；重启/多实例仅延迟进入=安全方向）；`enterQuarantine` 审计恰好一次（重进入零行零审计）；成功路径同语句回 verified 清两列+计数清零；失败路径 CASE 保持 quarantined 仅 last_validated_at 前进。
- **计数来源决策（评审记录）**：迁移冻结无计数列、job 行跨周期历史在 DB 不存在（同版本 requeue-transition 循环复用）、受限角色无可读历史表——故进程内 Map（上限=失败账号数×几十字节），DB 侧双门控兜底。
- **周期分离**：quarantined 仅按独立 `quarantineRevalidationSeconds`（默认 6h，900..604800 与 084 同域）到期重排（**不再要求账号自身 interval**——否则无 interval 隔离账号永远无法探活）；verified/failed 原谓词逐位不变；集成实测 quarantined(interval NULL) 900s 到期重排、控制账号按自身 900s interval 不受影响。
- 读取侧：types/repository/service/customer-http 解析器接受 'quarantined'（控制台 publicAccount 投影区分呈现）；写入侧 assertValidationState 保持严格（进入仅 worker 可写）。
- 测试：worker 45/45（新 7）、supply 402/393 零回归、gateway 578 零回归（agent 自证）、**PG 门禁 11/11 主线独立复跑绿**（进入→资格排除核对→周期分离→探活回 verified→计数重启→双 owner 守卫 4×55006→三角色探针）。
- 遗留：quarantineRevalidationSeconds/onAccountQuarantined 透传归主线组合（审计持久化走观察者钩子——worker 角色对 saas_audit_events 无 INSERT 钉板不变）；quarantine 列控制台投影扩展（CP 授权已备，repository ACCOUNT_COLUMNS 未扩，记后续）。
- 挂账（在途自解）：060 fixture sha 钉因 M/N 在途编辑 fixture 暂红，M/N 收尾后主线重盖章；095/096 forward 断言已随 098 同步修复。

## 下一任务
M（D5）/N（D6）/P（OAuth 入驻）三路收尾验收 → 主线统一组合 → 全套件终审。

## 2026-10-11 追加：R7 D6 连续健康 + #18a OAuth 入驻（子 agent N/P，已验收）

### R7 D6（agent N，验收通过）
- `gateway/health-score.ts` 纯函数：`recordOutcomeEma`（α=0.2、**乐观种子** seed=1.0——与二元语义一致：首败 0.800 仅 1s 冷却，直接 seed 则首败即 5% 保底严重失衡；30/32 步不动点钉板 0.002/0.998，PG numeric 与 JS 网格零分歧）+ `effectiveWeight`（NULL 原样/×max(score,0.05) 下界 1/畸形 throw）+ half-open 判定/退避双门。
- 写入侧（`postgres-provider-account-runtime-health-store.ts`）：WRITE_HEALTH_SQL 加 EMA 列（**二元 state/failure_count/cooldown 表达式逐字节未动**）；`getSchedulingView`（畸形 score fail-closed block）；`tryAdmitHalfOpenProbe` 单赢家 CAS——**fencing token 现场取号（关键设计：消耗探测租约令牌会把同租约 outcome 写挡成 stale，真实 PG 实测复现）**；`half_open_probe_at > observed_at` ⇔ 探测在飞（cooldown_shape CHECK 所迫的副产品，30s 崩溃恢复租约）。
- 与 M 的协作协议冻结：getSchedulingView 读数 → effectiveWeight → tryAdmitHalfOpenProbe → **再**取探测派发租约（令牌必然更新）→ 派发 → recordRuntimeOutcome(source='probe')。
- 测试 15+15 全绿；gateway 578/568 零回归；全量 0 失败；**PG 门禁 2/2 主线独立复跑绿**（EMA 0.800→0.640→0.712、单发探测 CAS 字节级不动二元列、42501/23514 双负向、双角色探针）。
- 挂账：商业 gateway E2E 在全新重放库红于并行会话在改的 persistence-service（创建凭证 SUPPLY_STORAGE_ERROR）——与本交付零交集，该轨完成后复跑 27/27。

### #18a OAuth 入驻初始化（agent P，验收通过）
- `supply/oauth-refresh-onboarding.ts` 纯助手（绑定判定/expires_in 提取校验/首次调度计算）；repository 条件化写入（**非 OAuth 创建/轮换 SQL 与前字节一致**——CP 对 oauth_* 仅 SELECT 的冻结边界下命名列即需权限，故全条件化）；persistence 三写路径接线（双 owner 创建/BYOK 原子路径/轮换继承）。
- **判定键复用 R4 worker 的 `resolveOauthTokenAdapter` 完整三元组注册表**（入驻 ⟺ worker 可刷新——裸类型常量会给 worker 永远无法刷新的行初始化调度）；延迟语义复用 worker 的 `oauthRefreshSuccessDelayMs`（首次与后续重排同一语义）；expires_in 畸形 → 默认 1h 兜底从不阻塞创建。
- 轮换继承矩阵：idle/failed → 重排+清 force/error+保 last；**refreshing → 不传 schedule**（worker 拥有该行，SQL 字节一致=CP 上 R4 缝合零权限变化，CASE 守护兜底竞态）；遗留 NULL → NULL 语义字节一致保留（回填不在本期）。
- **060 钉板事件（过程记录）**：P 初期给共享 fixture 加显式字段致 060 sha 钉红，发现后全部回退精确复原（钉板转绿）——并行期共享 fixture 编辑纪律的实证案例。
- 测试 13/13；supply 393 零回归；**PG 门禁 10/10 主线独立复跑绿**（双 owner 创建 idle+next、畸形/微小 expires_in 区分、非 OAuth NULL、轮换重排清 force/error 保 last、refreshing 全列保留、遗留 NULL 保持、CP 42501 钉板、形状 CHECK 双向 23514）；R4 门禁 8/8 零回归、quota 6/6。
- 遗留：生产装配（oauth_* 写需带授权连接的跨角色路由）与遗留 NULL 回填均列部署评审。

## 下一任务
M（D5 限流调度）收尾验收 → 主线统一组合（R5 选项/R7 乘子消费已在 M 内/R4 刷新链复核）→ 全套件终审 → R 系列收官。

## 2026-10-11 追加：R6 D5 限流调度 + 跨会话生产 bug 修复（agent M + 主线，已验收）

### R6（agent M，验收通过）
- **写点**：`SaasRequestAdmissionService.admit` work() 事务内（guard 复核+platform hold 后、outbox 前）——与 request/attempt 同事务（回滚零残留、replay/tombstone 天然不重复计数）；token 上界取 holdEvidence（KEY-BUD 同款保守口径，**BYOK 无 hold → 仅 requests 维**，tpm_limit 对 BYOK 不生效已文档化）；window_start=秒级截断注入时钟。
- **消费**：双资格 SQL 增读 rpm_limit/tpm_limit + LEFT JOIN health_score（PK 防扇出、`$1::text` 修复 uuid/text 操作符缺失）；limits 全 NULL 时**完全跳过窗口查询**（热路径零新增开销）；超限候选级 deny（兄弟候选不受影响）、畸形 limit/score 在窗口查询前 fail-closed block；R7 乘子经 N 的 effectiveWeight/parseHealthScoreColumn 正式对接（临时默认实现已撤）。
- 测试：admission +5、scheduler +522 行单测族（101 全绿）、gateway 578/568 零回归；**PG 门禁 4/4 主线独立复跑绿**（byok/platform rpm=2 三次准入后第三次摘除+窗口滚动恢复+replay 不重计+计数器授权探针+42501）。
- 挂账（M 建议，列后续）：计数器旧行 retention 清理 worker（10min 滑窗外 DELETE，需专用角色授权）；BYOK TPM 需上游 token 估计接缝。

### 跨会话生产 bug（M/N 独立命中，主线修复——真实 PG 重放库的拦截链）
1. **D2 引入的 latent bug**：平台凭证创建把能力目录的 URL 路径 endpoint（'/v1/chat/completions'）原样写入验证 job target_endpoint，083/035 CHECK 要求分类 token（'chat-completions'）——D2 自身 fixture 全用自定义 token 故从未暴露，商业 gateway E2E 用规范路径，全新重放库上 23514 必炸（该 E2E 自 D2 落地后未在全新库复跑过）。
2. **主线首修 normalization 后二次暴露**：插入归一化但幂等回放比较仍用原始输入 → 每次 enqueue 自冲突 VALIDATION_JOB_IDEMPOTENCY_CONFLICT（Proxy 逐方法追踪定位，pg 零错误干扰排除法）。
3. **终修**：归一化统一作用于插入与快照比较（normalizedInput 单点），`/v1/chat/completions→chat-completions`、`/v1/messages→messages`、其余剥前导斜杠；`normalizeValidationJobEndpoint` 导出 + 回归钉板（映射表 + replay 不自冲突）。
4. **商业 gateway E2E 27/27 全绿**（全新库单次跑通：bootstrap→双模式凭证→派发→FIN-01 全矩阵 real HTTP/SSE/取消/负向用量）——E2E 另需每次全新库（bootstrap 一次性标记，首跑残留会致 ALREADY_COMPLETED 假象，已实证）。
- supply 402/393 零回归；tsc 干净。

## 下一任务
全套件终审 → R 系列方案收官评估（R1-R10 全状态）→ 剩余挂账汇总（#18 生产 rotator 装配、计数器 retention、BYOK TPM、CI 登记）。

## 2026-10-11 追加：CI 登记 wave 3/4 全部 PG 门禁（Track H，已完成）

- **矩阵 11→22**：ci.yml isolated 矩阵 += marketing-redeem-codes-089 / promo-codes-090 / affiliate-091 / announcements-092 / quota-sync-093 / oauth-token-refresh-094 / announcement-fanout-095 / account-quarantine-097 / rate-limit-scheduling-098 / health-score-098 / oauth-refresh-onboarding（×PG15/18 双跑）；strict-tsc roots 同步 11 文件。
- **runner 扩展**：`managed-saas-isolated-required-gates.ts` gate 表同步；childEnv += `VALIDATION_WORKER_URL`（CI 服务字面值，D4/R4/R5 三门禁需要）+ `CI_SOFTWARE_KMS_MASTER_KEY`（**CI 专用合成信封测试密钥**，与 FIN057_FIXTURE_HMAC_HEX 同类 fixture 字节、非部署值、仅作用于一次性 CI 库）+ KEY_ID=software-local。
- **钉板治理（3 处有意更新，均记录）**：childEnv 精确形状钉（允许 runner 自有字面量增加、消息同步）；种子约定钉放宽为 `seed[A-Z]*(`（各域种子函数命名异构，不变量=自行播种+禁共享 HTTP 引导）；pre-dispatch fixture 禁令收窄到 `await cancellationFixture(` + bootstrap token 调用（M 的 rate-limit 门禁合法复用其连接助手与 admission 类型）。
- **strict-tsc 修复（tsx 宽松模式掩盖的两个真实类型缺陷）**：health-score 门禁 `getSchedulingView` 候选类型收窄为最小结构 `ProviderAccountHealthSchedulingCandidate`（accountScope 实证只读 5 标量；M 的调度器经自有 SQL+纯函数消费不受签名影响）；rate-limit 门禁 4 处 `string|null` 非空守卫（providerId/productId/endpoint/resolvedModel/accountId 提取+assert）。
- 验证：pin 11/11；strict-tsc 11 roots 干净；rate-limit 4/4 与 health-score 2/2 复跑绿；gateway 目录 578/568/0 败（早前 15 失败系本人 env 泄漏激活门控套件对不兼容库，复跑归零）。

## 下一任务
#18 R4 生产装配评审（跨角色 rotator 决策 + 组合接线）。

## 2026-10-12 追加：#18 R4 生产装配落地（决策 A，已完成）

- **评估**：Track H CI 登记（`886a8e5`）已完成；R4 装配工作树在途 ~70%，四个缺口：rotator 忽略 ownerKind（tenant BYOK 刷新必 CREDENTIAL_NOT_FOUND→永久 rotation_failed）、CP INSERT 缺 oauth 两列（onboarding 42501）、worker 角色未收窄到纯信号位、两个 PG 门禁与决策 A 冲突 + 接线零测试。
- **rotator 分派修复**：`ProviderSupplyService.replaceTenantProviderCredentialSecretForOperator`（运营者语义：完整三元组凭证引用、无 TenantContext、内部同 `replaceProviderCredentialSecretWithAudit`——状态检查/CAS/#18a 调度继承/信封 seal/D3 复验重排/审计与 platform 路径逐字节同构，仅跳过租户成员鉴权与 BYOK entitlement 再授权，后者归 D3 复验 job）；managed-saas rotator 按 ownerKind 分派（`createManagedOauthTokenRefreshRotator` 导出工厂供测试注入）；operatorUserId fail-closed 启动校验（未禁用 saas_users 身份）。测试 +10（service 4 + startup 接线 6：互斥/缺席/缺 KMS/坏 operator/启动停止/分派逐字段）。
- **授权收口（§3.5 附录已记入决策文档）**：CP INSERT += `oauth_refresh_state, oauth_next_refresh_at`（#18a 入驻的必要推论）；worker UPDATE 五列→仅 `oauth_force_refresh_requested`（SELECT 不变）；roles.sql / worker-role-grants.sql / runtime-privileges.ts / credential-validation-worker-privileges.ts 四处同步，钉板自动通过（worker-privileges 注释须 SQL `--` 语法——42601 教训）。
- **门禁对齐**：094 门禁整链（claim→解封→mock token→rotator→finalize/force/退避/SKIP LOCKED）切 CP 连接，worker 角色断言收窄为 force 信号写入 + 四列 42501 负向 + 版本链负向保留；#18a 门禁 CP oauth 写入负向翻正（onboarding INSERT 初始化 idle+首调度含 delay band、idle reschedule 成功），refreshing 行保留语义不变。
- **真实 PG18 门禁**（127.0.0.1:55433，每次全新库 001→098 + 双模板 + migrator 迁移 + 重跑模板）：094 **8/8**、onboarding **10/10**、quota-sync **6/6**、quarantine **11/11**；一次性库 `model_router_test_r4asm*` 6 个（含 1 尝试库）留 DROP。
- **组合终审**：`npx tsc --noEmit` 零错；全套件 unit 3841/3823 pass/0 fail + integration 244/195/0 fail；改动文件 biome 干净（agent 间一处在途格式归一：runtime-privileges.ts:2201 announcements 单行 grant 被 biome 拆多行）；knip 退出码 1 为既有基线（486 Unused files 结构桶），无新增 unused exports。
- **评审决策（主线仲裁）**：① operator 路径跳过 BYOK entitlement 再授权——维持（运营者语义，D3 复验兜底，与 platform 对称）；② 094 门禁保留仍成立的版本链负向矩阵（继续钉"worker 碰不到版本链"红线）；③ 决策文档 §3.4 已补装配修正、§3.5 授权附录、检查单代码侧三项勾选；deploy/README 已补刷新链部署说明。
- **遗留**：部署动作未做（目标库角色模板重跑 + ACL 探针）；`oauthTokenRefresh.unsealingKms/operatorUserId` 部署配置待部署方提供；遗留 NULL 回填与 M3 云 KMS 决策门不变。

## 下一任务
全套件终审后的 R 系列收官评估剩余挂账（计数器 retention、BYOK TPM token 估计接缝、遗留 NULL 回填运营评审）。
