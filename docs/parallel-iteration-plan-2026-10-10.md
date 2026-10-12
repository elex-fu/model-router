# model-router 后续迭代并行开发技术方案

日期：2026-10-10
状态：草案（待评审）；Track F 已于 2026-10-10 全部交付并通过真实 PG 验收（见 Track F 章节"落地实况"）
前置文档：`docs/sub2api-commercialization-integration-plan.md`（§3 原则、§11.1 十四任务）、`docs/development-progress-2026-09-29.md`

---

## 1. 背景与目标

本方案基于对仓库代码的逐域核实（2026-10-10）与对 sub2api（`~/play/sub2api`）的能力对标，回答两个问题：

1. **差距再确认**：§11.1 十四项任务全部 OPEN，但代码核实显示若干任务的"缺口性质"与直觉不同——部分缺口是**证据矩阵**而非代码缺失，部分则是**整域空白**。混淆这两类缺口会导致迭代计划错配人力。
2. **并行开发设计**：14 项任务 + sub2api 对标新增能力，若串行执行周期不可接受。本方案将工作划分为 9 条可并行工作流（Track A–I），明确每条的阻塞关系、代码所有权边界、迁移并发控制规则与验收门禁。

红线沿用 §3.2：定点金额、不可逆 Key 摘要、fail-closed 硬限额、跨实例 PG 权威租约 + fencing、显式 unknown 状态与对账队列、平台角色独立授权域、备份 fail-fast。**任何 Track 不得以进度为由退化这些约束。**

---

## 2. 差距再确认（代码核实结论）

### 2.1 缺口性质分类

| 域 | 任务 | 核实结论 | 缺口性质 | 真实剩余工作量 |
|---|---|---|---|---|
| 网关授权 | GW-01 | `authorization-prelock.ts`（461 行）+ 受限角色并发撤权 PG 集成测试均已存在；幂等/容量/租约/证据签名齐备 | **证据**：双 PG（15/18）负向权限矩阵、same-scope/独占窗口、native counts 未跑齐 | 中偏小 |
| 账务闭环 | FIN-01 | 取消补偿（`pre-dispatch-compensation-service.ts` + 迁移 059）、崩溃恢复（`unknown-outcome-recovery-worker.ts` 59K）**已实装**；唯一代码空白是 **usage 更正入口**（全仓 grep 零命中） | 代码（usage 更正）+ 证据（故障矩阵） | 大 |
| PSP | PAY-01 | `adapter.ts` 为 71 行纯接口（acceptance 三态设计完整）；仓内零 PSP 实现，checkout 未配置时显式 503 unavailable | **整域新写** | 大 |
| 运行时 | RUN-01 | KMS 三件套全部是"外部模块 loader + 契约校验"，**无内置/云 KMS 实现可载**；无 supervisor、无 IAM | **整域新写**（loader 已就位） | 大 |
| Key IP 策略 | KEY-IP | `isIpAllowed`/`resolveClientAddress` 纯函数已就绪但 `resolveClientAddress` 在 src 零调用方；DB schema、HTTP API、gateway 钩子全缺 | 代码（schema+API+链路接入），纯逻辑可复用 | 中+中 |
| Key 预算 | KEY-BUD | 求值器纯函数在；schema/API/账本协同全缺 | 代码（新域+账本协同） | 大 |
| 账号调度 | （对标新增） | 加权调度算法（`chooseWeighted`）与 session 亲和（HMAC 版本化、TTL、CAS）**已存在**；但 priority/weight 无持久化数据源（恒为 0/1）、无 RPM/TPM 参与调度、健康二元分级、无租户级粘性 | 增强（非重建） | 中×3 + 大×1 |
| 凭证池 | （对标新增） | BYOK 验证闭环已通（worker + 资格门禁联动）；**平台池零自动验证**（worker 写死 `ownerKind='tenant'`）、无周期复验、无配额抓取、无 quarantine 中间态 | 代码（平台池验证为新写） | 大+中+大+中 |
| 身份/控制台 | UI-CUST | 成员移除、Owner 转移、Passkey **全部未实现**（Passkey 仅 001 迁移 schema 预留）；控制台仅 4 个只读 GET + 175K SPA | 代码（补流程） | 中/中/大 |
| 运营后台 | UI-OPS | 供应/审计/定价/容量为强项；缺平台用户管理、租户生命周期、管理员账号管理、公告；ops summary 的 runtimeProbes 为占位 | 代码（补流程） | 中~大 |
| Webhook | （对标新增） | ~~管道完成度很高（签名/投递/死信/防 SSRF）；**全仓零事件生产者**，protector 仅接口，entitlement policy 仅接口~~ **Track F 已交付（2026-10-10）**：F1 软件 KMS protector、F2 entitlement 实装、F3 七类事件生产者全接入、F4 小件齐备，真实 PG 受限角色证据通过 | ~~接入（生产者）+ 小件~~ 已关闭 | ~~大+中+小~~ 0 |
| 营销工具 | （对标新增） | 兑换码/促销码/邀请返利/公告 **整域不存在**（grep 零命中） | **整域新写** | 各大 |
| 存量升级 | DB-01 | 审计 CLI + fail-closed 校验已就位；022/023 checksum 历史未逐库盘点 | **流程/证据**：只读盘点 + 兼容修复路径设计 | 中~大 |
| 可靠性 | OPS-01 | 双实例演练、真实 SIGKILL/ACK 恢复：AUTHORED NOTRUN；062 迁移 reserved（FIN fence） | 演练 + 新迁移 | 大 |
| CI/发布 | REL-01 | 3 job + 多 required 门禁已在 CI；缺 FIN 故障矩阵、055/056 完整负向、双实例、remote 固定 commit 证据 | 证据聚合 | 中 |

### 2.2 对迭代计划的两个推论

1. **GW-01 与 FIN-01 的绝大部分剩余工作是"跑矩阵取证"而非"写代码"**——应以门禁脚本化 + CI 化方式推进，占用的是评审/验证带宽而非开发带宽，因此**主链不应阻塞其他 Track 的开发并行**。
2. **真正的大块新代码**集中在：usage 更正（FIN）、PSP 适配器（PAY）、生产 KMS/supervisor（RUN）、平台池自动验证与配额同步（supply）、营销域（全新）、Passkey（identity）。这些是并行开发的主要受益者。

---

## 3. 并行开发总体设计

### 3.1 工作流划分与依赖图

```
                ┌─────────────────────────────────────────────┐
                │  Track H：迁移仲裁 + DB-01 盘点 + CI/证据门禁 │
                │  （贯穿全程，不直接产出业务代码）              │
                └──────────────┬──────────────────────────────┘
                               │ 迁移编号仲裁 / 门禁脚本
   ┌───────────────────────────┼───────────────────────────────┐
   │                           │                               │
   ▼                           ▼                               ▼
Track A（主链·发布阻断）     Track B（运行时生产化）          Track C（支付）
GW 矩阵 → usage 更正 →       生产 KMS 模块 / supervisor /    PSP 选型 → 适配器 →
FIN 故障矩阵 → KEY-IP →      IAM / MFA 交接                  沙箱对账 → 退款实装
KEY-BUD                        │                               │
   │                           │                               │ 依赖 A 的 FIN 账本契约
   ▼                           ▼                               ▼
Track D（供给与调度增强）    Track E（身份/控制台/运营）      Track F（Webhook 生产者）
平台池自动验证 / 周期复验 /  成员移除 / Owner 转移 /          7 类事件生产者 /
配额同步 / priority 落库     Passkey / 控制台页面 /           protector 实装 /
                             运营工作流                       entitlement policy
   │                           │                               │
   ▼                           ▼                               ▼
Track G（营销域·全新）       Track I（可靠性演练 OPS-01）
兑换码 / 促销码 / 返利 /     依赖 B 的装配完成后启动：
公告（设计先行，账本钩子     双实例 / SIGKILL / restore 演练
冻结后实现）
```

**关键依赖规则**：
- Track A 是唯一发布阻断链（GW→FIN→KEY-IP→KEY-BUD 顺序不可颠倒，§11.1 约束）。
- B、C、D、E、F 在**契约冻结后**（见 3.2）即可与 A 完全并行；它们的验收可以晚于 A，但不阻塞 A。
- Track G 的账本钩子依赖 FIN 账本接口冻结（不等 FIN 验收完成，只等接口冻结）。
- Track I 依赖 B 的装配产物（KMS/supervisor 就位后演练才有意义）。

### 3.2 第 0 阶段：契约冻结（1 周内，全员参与评审后并行启动）

并行开发的前提是先冻结跨 Track 接口。以下契约在第 0 阶段冻结，冻结后改动需变更评审：

| 契约 | 位置 | 消费者 |
|---|---|---|
| usage 更正端口（更正事件 schema、账本冲正语义、权限模型） | `src/saas/metering/`（新增）+ `billing/service.ts` | A、G |
| PSP 适配器：**已定 EasyPay 首家**（mapi 直付模式；回调入账前强制主动 QueryOrder 复核；queryRefund 恒 unknown 转人工对账），acceptance 三态沿用 | `payments/adapter.ts` + 新增 `payments/providers/easypay/` | C |
| KMS 模块工厂契约（现有 loader 已校验）；**B1 降档为软件 KMS 模块**（AES-256-GCM 信封 + env 静态主密钥，pilot-only），生产云 KMS 推迟为 M3 前决策门 | `runtime/provider-credential-kms.ts` 等三件套 | B、I |
| Key 策略 DTO（已有 `ip-policy-contract.ts`/`budget-policy-contract.ts`，确认不再改） | `keys/` | A（KEY-IP/BUD） |
| Webhook entitlement policy 接口 | `webhooks/` | F、G（公告事件） |
| 营销域账本钩子（兑换码入账走 `postVerifiedFunding` 同源路径） | `billing/service.ts` | G |
| 调度资格数据源扩展（priority/weight 列 + 读取 SQL 契约） | `gateway/postgres-provider-account-scheduler.ts` | D |

### 3.3 代码所有权边界（避免并行冲突）

| Track | 独占目录/文件 | 共享区（需走迁移队列/评审） |
|---|---|---|
| A | `src/saas/gateway/`、`metering/`、`billing/`、`keys/` | `db/migrations/`、`deployment.ts` |
| B | `src/saas/runtime/`、`deploy/`（新增 supervisor/清单） | `managed-saas.ts`（装配口，改动需小步评审） |
| C | `src/saas/payments/`（新增 `providers/` 子目录） | `managed-saas.ts`（adapter 注入点） |
| D | `src/saas/supply/`、`gateway/postgres-provider-account-*`（调度器系列） | 与 A 共写 `gateway/`——按文件级划分：A 动 admission/prelock/compensation，D 动 scheduler/lease/affinity/eligibility |
| E | `src/saas/identity/`、`console/`、`platform/`、`web/` | 无 |
| F | `src/saas/webhooks/` + 各域事件钩子注入点（每个注入点单独小 PR） | `billing/`、`metering/` 的钩子调用行（一行级改动，Track A 评审） |
| G | 新增 `src/saas/marketing/`（redeem/promo/affiliate/announcement） | `db/migrations/` |
| H | `src/saas/db/`、`src/cli/`、`.github/workflows/`、证据模板 `docs/evidence/` | 迁移编号仲裁 |
| I | `scripts/drills/`（新增）、`tests/drills/`（新增） | 无 |

### 3.4 数据库迁移并发控制（并行开发的最大冲突点）

现状约束：`verifySaasMigrations` fail-closed——checksum（`sha256(name+'\0'+sql)`）、顺序、缺失均直接抛错；001–060 冻结、061 inactive（integration GO 前不注册）、062 reserved（FIN fence）。

并行规则：

1. **编号段预分配**（Track H 仲裁，写入本节末尾登记表）：
   - 062–063：Track A（062 FIN fence 已有设计占位；063 usage 更正——已落库）
   - 082–083：Track D（priority/weight 落库、平台池验证任务表；原 064–065 槽位因 080/081 先落库退役，见 contracts-m0-freeze 仲裁表）；084（周期复验列）已落库
   - 066–067：Track E（成员/Owner/Passkey 若需 schema 变更）——实际消费 085（passkey ceremony）；066–067 退役未用
   - 068–069：Track F（webhook 若需补充列）——实际消费 087（租户策略列）与 088（event-types CHECK pg_catalog 化）；068–069 退役未用
   - 070–079：Track G（营销域）——064–079 整段因 080/081 先落库退役，G 实际从 089 起分配
   - 080+：预留——已消费 080/081（KEY-IP/KEY-BUD）、082–085、087–088；086 保留未用；下一个可用号 089
2. **单写者队列**：任何时刻只有一个 Track 的迁移可处于"待合并"状态；合并后立即跑 `saas:migration-audit` 全量校验 + 空库 001→head 重放测试。
3. **禁止 renumber 已合并迁移**；编号段内未用完的号段作废留空（verify 按注册表连续性校验，空号需在注册表跳过并注释）。
4. **061 的注册决策**（integration GO）与 062 设计落地属 Track A/H 联合评审项，不随并行节奏提前。
5. 每个迁移必须同 PR 携带：单测 + PG 集成测试（双 PG 至少 PG15）+ 受限角色授权核对（对照 `deploy/managed-saas-postgres-roles.sql`）。

---

## 4. 各 Track 详细方案

### Track A：主链（发布阻断，最高优先级评审带宽）

**A1. GW-01 证据闭环（中偏小）**
- 将双 PG（15/18）负向权限矩阵（054/055/056 负向、prelock 并发撤权 same-scope/独占）脚本化为可重复门禁，纳入 `.github/workflows/ci.yml` required。
- 补 native counts 捕获到证据模板（`docs/evidence/`）。
- 产出：§11.3.1 GW 门禁全部通过证据 → 提交 REL 评审。

**A2. FIN-01 usage 更正入口（唯一新代码，大）**
- 新增 `metering/usage-correction.ts`：append-only 更正事件（不得修改原 usage event）、更正 digest（复用 `digest.ts` canonical 规则）、账本冲正走 `billing/service.ts` 显式反向分录。
- 权限：operator/superadmin 角色 + 审计事件，复用 `postgres-unknown-outcome-operator-authorization.ts` 的 advisory fence 模式。
- 迁移 063（更正事件表）。
- 测试：单测 + PG 集成（更正重放、并发更正、与 unknown-outcome 恢复的交互）。

**A3. FIN-01 故障矩阵验收（大，证据为主）**
- 完整矩阵脚本化：取消补偿 / missing usage / 崩溃 / unknown / 并发 / 重复结算 × 双 PG。
- 真实 SIGKILL 子进程演练（与 Track I 共建基础脚本，Track I 扩展为完整演练）。

**A4. KEY-IP（中+中）**——前置：A1、A3 通过
- 迁移（IP 策略表 + 版本化 head）；`keys/service.ts` 策略读写（CAS expectedVersion）；`keys/http.ts` 增路由。
- gateway 接入：`http-handler.ts` 接 `resolveClientAddress` → preparation 灌入 `SaasRequestAdmissionCommand` → `postgres-request-admission-guard.ts` 的 key 锁之后调 `isIpAllowed`，走现有 `deny(...)` 通道。
- 完整 IP 授权矩阵（IPv4/IPv6/CIDR × 撤权/轮换 × 双 PG）。

**A5. KEY-BUD（大）**——前置：A4
- 预算计数器 schema（settled/outstandingReserved、日窗口、轮换 lineage 继承）；`admit()` 内与 `billing.reserve` 协同的保守预留；结算/更正联动（依赖 A2 的更正端口）。
- 日窗口时钟注入（禁止隐式 `Date.now` 语义歧义）；故障矩阵同 A3 规格。

### Track B：运行时生产化（RUN-01，与 A 完全并行）

- **B1a. 软件 KMS 模块（小，pilot 必备）**：仓内实现 `software` KMS 模块——AES-256-GCM 信封加密，静态主密钥来自 env（`SAAS_KMS_MASTER_KEY`），满足三件套 loader 工厂契约（`generateDataKey`/`decryptDataKey`/`reencryptDataKey`/`checkReady`/`close`），rewrap 用主密钥版本前缀支持手动轮换。标记 pilot-only：启动日志显式告警，生产决策门前不得用于收费环境。**背景**：sub2api 上游凭证是明文 JSONB 落库（红线禁止照搬）；model-router 信封加密已实装，缺的是 loader 可加载的模块本体，软件模块以最小代价补上。
- **B1b. 生产云 KMS（推迟，M3 前决策门）**：AWS KMS 为首选候选（loader 契约即 GenerateDataKey/Decrypt/ReEncrypt 形状，EncryptionContext 承载 purpose/owner 绑定），以独立可信模块包发布、env specifier 加载，主仓零云 SDK 依赖。是否升级由 M3 评审结合 COM-01 商业开放范围决定；不自建 Vault（运维成本高）。
- **B2. role supervisor**（中）：`deploy/` 新增 workload supervisor 清单（systemd unit 组或 compose profile），启动 fail-closed 探针复用现有 ACL 校验。
- **B3. IAM / 网络策略模板**（中）：workload 级最小权限落地文档 + 可执行核对脚本。
- **B4. MFA enrollment 交接/恢复**（中）：`customer-mfa-capability.ts` 从 unavailable 声明到实装。
- 验收：gateway 角色以 decrypt-only KMS 完成端到端派发（B1a 软件模块即可达成装配验收）；装配清单经 Track I 演练消费。

### Track C：支付（PAY-01，契约冻结后并行）

- **C1. PSP 决策（已定）：EasyPay 首家**——对齐 sub2api 的运营选型（个人/小团队商户可开通，国内中转站事实标准）。sub2api 实证要点（`backend/internal/payment/provider/easypay.go`）：双模式（popup 跳转 / mapi 直付）、MD5 签名、有 `QueryOrder` 主动查单、有退款 API 但无退款查询、退款请求不签名明文传 pkey。
- **C2. EasyPay 适配器**（大）：`payments/providers/easypay/` 实现 `PaymentProviderAdapter` + `PaymentProviderRefundAdapter`，对 sub2api 裁剪语义做三处红线化改造：
  1. **仅支持 mapi 直付模式**（服务端建单拿 TradeNo）——popup 模式无 TradeNo，`recoverOrder` 幂等恢复无法成立，配置层直接拒绝；
  2. **回调入账前强制主动 `QueryOrder` 复核**——MD5 签名防不住伪造，验签通过+查单确认 `TRADE_SUCCESS` 双条件才履约，缺一转入对账队列（fail-closed，sub2api 只在取消前查单，我们前置到履约前）；
  3. **退款降级为显式人工对账**——`submitRefund` 调退款 API；`queryRefund` 恒返回 unknown，退款挂 reconciliation 队列转 operator 确认（复用现有 refund-worker 的 provisional effect + 过期 claim 对账机制）。退款明文传 pkey 的风险：网络出口白名单缓解 + COM-01 档案记录。
- **C3. 幂等与履约恢复**（中）：商户单号 DB 唯一约束分配（对标 sub2api `allocateOutTradeNo` 查重模式）；`recoverOrder` 用 `QueryOrder` 按 out_trade_no 实现；重复回调靠条件 UPDATE 状态机 + durable inbox 去重（现有 `payments/service.ts` 已具备）。
- **C4. 沙箱/演练**（中）：EasyPay 无官方沙箱，用 mock PSP server（复用 `tests/saas/payments/fake-sql.ts` 替身模式起 HTTP 层 mock）跑乱序/迟到/重复回调、退款 unknown 对账演练；真实商户联调列入 COM-01。
- **C5. 第二适配器（Stripe）**（中，可选）：EasyPay 落地后用 Stripe 全量能力（QueryRefund、幂等键、强验签）验证接口抽象充分性，同时打通国际收款。不阻塞 PAY-01 关闭。
- 红线：金额定点、退款显式 unknown、不得引入 fail-open 路径；MD5 弱签名必须靠主动查单兜底。

### Track D：供给与调度增强（对标 sub2api 账号池，并行）

- **D1. priority/weight 落库**（中）：迁移 082（provider account 表加列 + 行校验）；改造 `PostgresEligibilityAuthority`（当前注释自承无持久化数据源，L903-905 恒 0/1）与 `select()` 读取 SQL。
- **D2. 平台池自动验证**（大）：破除 worker 的 `ownerKind='tenant'` 假设——新任务表（迁移 083）+ store 抽象 owner 维度 + 平台池适配器；失败自动下线复用现有资格门禁联动。
- **D3. 周期复验**（中）：定时扫描复用 `enqueueProviderCredentialValidationJob`；周期为账号级可配。
- **D4. 配额同步**（大）：新 worker + provider 配额适配器（对标 sub2api `upstream_billing_probe`）；配额低时调度摘除（消费点接入 `chooseWeighted` 资格门禁）。红线：配额数据只作调度信号，不进计费路径。
- **D5. 多层限流参与调度**（大，可拆）：RPM/TPM 维度接入 `select()` 过滤链；Redis 仅作派生缓存，权威计数以 PG 为准（fail-closed 红线）。
- **D6. 连续健康权重 + half-open 探测**（中）：healthy/degraded 二元 → 错误率/延迟连续加权；冷却恢复加半开探测而非纯 TTL。

### Track E：身份/控制台/运营（UI-CUST/UI-OPS，并行）

- **E1. 成员移除 + 角色变更 + Owner 转移**（中）：成员目录基础设施已在；Owner 转移需保证至少一个 Owner 不变量（DB CHECK 或事务内断言）。
- **E2. Passkey**（大）：001 迁移已预留 `kind IN ('totp','passkey')`；新 ceremony（注册/断言/防重放）；与 TOTP 并列为 MFA 因子。
- **E3. 控制台补齐**（小~中）：账单/发票页、通知中心（消费 Track F 的事件）。
- **E4. 运营后台补齐**（中~大）：平台用户管理（禁用/重置/强制 MFA）、租户生命周期（暂停/删除/接管）、管理员账号/角色管理端点、ops summary 的 runtimeProbes 接线。
- 依赖说明：E 仅消费稳定领域 API，不等 A/C 验收；收费相关页面在 FIN/PAY 验收前以只读/隐藏模式上线。

### Track F：Webhook 生产者接入（并行）—— ✅ 已交付（2026-10-10）

- **F1. protector 实装**（中）：✅ 软件 KMS envelope protector（`software-provider-credential-kms.ts` 的 `createWebhookSigningSecretProtector` + `webhookSigningSecretAad` 绑定 tenant/endpoint/version）；pilot-only，云 KMS 升级门留 M3。
- **F2. entitlement policy 实装**（小）：✅ Postgres entitlement 权威（迁移 087 的 `allowed_event_types` 白名单 + `enabled`），拒绝即丢弃不持久化，`onEventDropped` 只收稳定错误码。
- **F3. 七类事件生产者**（大）：✅ payments/plans 状态机钩子、metering 结算终态钩子、低余额/密钥到期扫描 worker（`notification-scanner.ts`，bucket 幂等键：`<tenant>:<currency>:<day>:band-<n>` 与 `<key id>:expires-<epoch ms>`）。维护公告入口待 Track G 公告域落地后接线（G4）。
- **F4. 小件**（小）：✅ 平台租户策略 PUT 路由（首次写入走迁移 087 DB 默认值种子：白名单七类全开、低余额阈值 NULL）；`pruneTerminalHistory` 定时调度（`retentionPrune` 选项，7–365 天）；`replayDeadLetter` 端点（POST `.../deliveries/:deliveryId/replay`，配额预占 + 审计）。

**落地实况（F-i 真实 PG 受限角色验收，2026-10-10）**

证据：`tests/saas/webhooks/track-f.postgres.integration.test.ts` 7 子测试全绿（configure 种子语义 / protector 往返 + AAD 错绑拒绝 / entitlement 拒绝矩阵 / 生产者原子入队 + 幂等重放 / 扫描器发射 + 同 band 余额漂移冲突转 skip / 死信重放配额记账 / 保留期裁剪不动事件事实），可重复运行（租户级断言，不受存量 fixture 干扰）；`runtime-privileges.integration.test.ts` 在线探针同步绿。

真实 PG 暴露并修复了三个单测盲区缺陷（全部属"假 DB 无法发现"类）：

1. **审计 INSERT 参数类型冲突（42P08）**：`tenant-policy-service.ts` 把同一 `$2` 同时绑定 `tenant_id`(uuid) 与 `target_id`(text)；改为独立参数（与 endpoint-service/postgres-store 同法）。
2. **CHECK 约束调用 schema 函数被拒（42501）**：角色模板刻意 REVOKE 全部 schema 函数的 EXECUTE，触发器豁免但 CHECK 表达式按写者权限求值——043/087 的 `saas_customer_webhook_text_array_is_unique` 因此阻塞受限角色写入。沿用迁移 056 的既定修复模式：CHECK 重写为等价的 pg_catalog-only 逐值出现次数上限（白名单已限定枚举值域，"无重复" ⟺ "每个允许值至多一次"）。087（未发布）直接改写；已发布的 043 约束由新迁移 **088** 做带漂移护栏的原子置换（ACCESS EXCLUSIVE 锁 + 存量行双约束等价验证 + 前后目录快照比对 + 零运行时 EXECUTE 不变量）。
3. **ON CONFLICT DO UPDATE 的隐性 SELECT 需求**：PG 对 EXCLUDED 伪表列读与 RETURNING 列读均按 SELECT 权限计价——`saas_customer_webhook_tenant_policies` 的 SELECT 授权补 `updated_by_user_id`/`audit_event_id`/`updated_at`（三源同步：runtime-privileges 清单 + roles SQL + pin 测试）。

迁移登记：087、088 已消费并注册（注册表 `[1-60, 63, 80-85, 87, 88]`，max 88）；086 保留未用。全量门禁：tsc ✅、npm test 3345+230 全绿 ✅、ACL pin 108/108 ✅。

### Track G：营销域（全新，设计先行）

- **G0. 设计冻结**（第 0 阶段后 2 周）：兑换码（余额型/订阅型，对标 sub2api `RedeemTypeBalance/RedeemTypeSubscription`）、促销码（充值折扣）、邀请返利（返利记录/提现）、公告（已读追踪，复用 F 的 webhook 事件）。
- **G1. 兑换码**（大）：迁移 070+；码生成（不可逆存储、单次核销、幂等）；余额型入账走 `postVerifiedFunding` 同源路径（定点金额红线）。
- **G2. 促销码**（中）：作用于 checkout 定价快照，不得事后改价。
- **G3. 邀请返利**（大）：归因记录、返利入账、提现审核（运营后台 E4 消费）。
- **G4. 公告**（中）：发布/已读追踪/控制台展示 + webhook 事件。
- 优先级说明：G 不阻塞发布（§11.1 无对应任务），但属 sub2api 对标的核心运营能力，建议 M3 里程碑交付 G1+G4。

### Track H：迁移仲裁 + DB-01 + CI/证据门禁（贯穿）

- **H1. DB-01 存量盘点**（中~大）：对每个待升级环境跑 `saas:migration-audit`（只读、fail-closed）；输出逐库 checksum/catalog 证据；发现 022/023 旧 checksum 存量库时，设计可前滚、可审计的兼容修复路径（禁止改写账本）。
- **H2. 迁移队列仲裁**：维护 3.4 编号登记表；每合并一个迁移跑全量校验。
- **H3. CI 门禁扩展**：FIN 故障矩阵（A3）、055/056 完整负向、双 PG 矩阵全部纳入 required；native counts 捕获标准化。
- **H4. REL-01 证据模板**：`docs/evidence/` 统一模板；每个 Track 的验收证据按模板落盘，REL-01 只做聚合不做补采。

### Track I：可靠性演练（OPS-01，B 交付后启动）

- **I1. 演练基础设施**（中）：`scripts/drills/` 双实例编排、隔离子进程 SIGKILL 注入、restore 工具校验。
- **I2. FIN 恢复演练**（大，与 A3 共建）：actual COMMIT/ACK + SIGKILL × 取消/unknown/重复结算矩阵。
- **I3. 全链路演练**（大）：双实例故障转移、备份恢复（fail-fast 红线）、OS cleanup；按已确定 RPO/RTO 验收。

---

## 5. 里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| **M0：契约冻结** | §3.2 全部契约冻结；迁移编号段登记（PSP/KMS 选型已定：EasyPay 首家 + 软件 KMS pilot、云 KMS 推迟至 M3 决策门） | 评审通过 + 契约文件落盘 |
| **M1：主链证据闭环** | GW-01 关闭；FIN-01（含 usage 更正）关闭；DB-01 盘点完成 | §11.3.1 + FIN 矩阵双 PG 通过；逐库盘点证据 |
| **M2：Key 策略上线** | KEY-IP、KEY-BUD 关闭 | 完整 IP/预算事务与故障矩阵通过 |
| **M3：生产装配与支付** | RUN-01、PAY-01、OPS-01 关闭；D1–D3、~~F 全部~~（F 已于 2026-10-10 提前交付）、G1+G4 交付 | KMS 端到端（软件模块）+ 云 KMS 升级决策门评审；EasyPay mock 对账演练通过；演练按 RPO/RTO 通过 |
| **M4：发布验收** | COM-01 批准齐备；REL-01 固定 commit 全门禁通过 | 可开放托管 `/v1` 收费 |

M1 之前 B–H 全部并行推进；M1 之后 A 链进入 KEY-IP/BUD 时，D/E/F/G 的验收与 A 互不阻塞。

---

## 6. 工程纪律（并行开发的约束）

1. **分支策略**：每 Track 一条长期分支（`track/a-main` 等），日级 rebase main；跨 Track 共享文件（`managed-saas.ts`、`deployment.ts`、注册表）只允许小步独立 PR，Track H 评审。
2. **健康栈**：`npx tsc --noEmit && npm test && npm run lint && npm run deadcode` 为每个 PR 前置；PG 集成测试按 CI required 门禁执行。
3. **证据先行**：凡是"代码已存在、缺口是矩阵"的任务（GW、FIN 大部分），先写门禁脚本再补证据，禁止以"本地跑过一次"作为验收依据。
4. **红线检查单**：每个 Track 的 PR 模板附带 §3.2 红线核对项（定点金额/不可逆摘要/fail-closed/租约 fencing/unknown 对账/最小权限/备份 fail-fast）。
5. **sub2api 代码隔离**：对标仅限设计借鉴；不复制 Go/Vue 源码，不把 sub2api 纳入运行拓扑（§3.1 原则）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 迁移编号冲突/顺序破坏 | verify fail-closed 阻断启动 | 3.4 编号段 + 单写者队列 + H 仲裁 |
| A 链评审带宽不足拖累全局 | 发布阻断链延误 | GW/FIN 证据类工作脚本化，评审只看门禁输出；代码类（usage 更正）优先排期 |
| EasyPay MD5 弱签名被伪造回调 | 未付款订单被履约 | C2 强制主动 QueryOrder 双条件履约；对账队列兜底 |
| EasyPay 无退款查询/退款明文传 pkey | 退款结果不可证、商户密钥暴露面 | queryRefund 恒 unknown 转人工；出口白名单 + COM-01 风险记录 |
| 软件 KMS 被误用于收费生产 | 凭证保护降级到 sub2api 同级以下 | B1a 启动告警 + M3 决策门硬检查 + REL-01 门禁核对 |
| Track D 与 A 共写 gateway/ 冲突 | 合并冲突 | 文件级所有权划分（3.3），调度器系列归 D、admission 系列归 A |
| 营销域（G）膨胀挤占主链人力 | M1/M2 延误 | G 明确不阻塞发布；人力紧张时 G2/G3 可顺延至 M4 后 |
| 存量库发现 022/023 旧 checksum | DB-01 升级为 blocker | H1 尽早盘点（M0 即启动），预留兼容修复设计缓冲 |

---

## 附录 A：sub2api 对标能力 → Track 映射速查

| sub2api 能力 | model-router 承接 | Track |
|---|---|---|
| 粘性会话调度 | 已有（session 亲和），增强 priority/weight + 多层限流 | D1/D5 |
| OAuth 账号池自动刷新/健康下线 | 验证 worker 扩展平台池 + 周期复验 + quarantine | D2/D3 |
| 配额抓取/利润控制 | 配额同步 worker（仅调度信号，不做利润否决 failover） | D4 |
| 五家 PSP 收款 | EasyPay 首家（mapi 直付 + 主动查单 + 退款人工对账），Stripe 第二适配器验证抽象 | C |
| 兑换码/促销码/返利 | 全新营销域 | G |
| Token 级计费/钱包 | 已有账本；补 usage 更正 | A2 |
| 内容风控/公告 | 公告（G4）；内容风控本期不立项（记录为后续候选） | G4 |
| ops 实时监控大盘 | ops summary runtimeProbes 接线 + 审计 | E4 |
| 插件系统 | 不立项（模块化单体原则，§3.1） | — |
