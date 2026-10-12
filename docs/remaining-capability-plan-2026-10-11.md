# 剩余能力建设技术方案（R 系列）

日期：2026-10-11
状态：草案（待评审冻结）
前置：`docs/progress-assessment-2026-10-11.md`（缺口清单）、`docs/parallel-iteration-plan-2026-10-10.md`（红线与工程纪律）、`docs/marketing-domain-design-2026-10-11.md`（G2/G3 已冻结部分）、`docs/contracts-m0-freeze.md`（C-6）
对标来源：`~/play/sub2api`（**仅设计语义借鉴，禁止复制 Go 源码、禁止纳入运行拓扑**）

---

## 1. 范围与红线

覆盖进度评估 B 级缺口（R1–R9）与 A 级发布阻断尾项（R10）。未覆盖项沿用既有决策：内容风控（后续候选）、插件系统（不立项）、利润控制 failover（红线禁止）、返利现金提现（钱包余额发放）、社交登录（COM-01 定夺）。

红线全集（任一 R 不得退化）：
1. 定点金额（minor units 文本/BigInt，禁止浮点与科学计数法）。
2. 凭证/码体不可逆存储（sha256/信封加密），明文不出模块边界。
3. fail-closed：未知=不影响调度/不放行/不猜测；适配器失败=显式 unknown。
4. 账务只走同源钩子（postVerifiedFunding / plans grant），同事务、幂等命名空间。
5. PG 为唯一权威（租约/容量/健康/计数器），Redis 仅派生缓存。
6. 受限角色列级最小授权 + 角色模板镜像 + 部署注意注释。
7. 迁移 fail-closed 校验：checksum、顺序、注册表钉板三处一致。
8. 证据先行：每域真实 PG 受限角色门禁 + native counts。

## 2. 迁移编号仲裁（Track H 登记，当前 head 095）

| 槽位 | 域 | 说明 |
|---|---|---|
| 090 | R1 G2 促销码 | 已落账（2026-10-11） |
| 091 | R2 G3 邀请返利 | 已落账（2026-10-11） |
| 094 | R4 OAuth token 刷新 | 已落账（2026-10-11） |
| 095 | R8 G4.5 公告 fan-out 游标 | 已落账（2026-10-11）——**再仲裁**：原预留序（095 quarantine/096 group/097 counters/098 fan-out）会使低位号 stranded 于 head 之后（064-079 退役同款陷阱），故 fan-out 取 095 |
| 096 | R5 quarantine 中间态 | 按落地顺序取号（096+） |
| 097 | R6 D5 滑窗计数器 | 按落地顺序取号 |
| 098+ | R9 分组费率 / 预留 | **R9 仅登记，M4 后独立设计评审** |

铁律（064-079 教训）：**head 之下不得为未落地迁移预留编号**——任何已注册 head 之后的低位号永远无法应用。编号按落地顺序即时分配。

单写者队列不变：任何时刻只有一个 R 的迁移处于待合并状态；合并即跑 `saas:migration-audit` 全量校验 + 空库 001→head 重放。

## 3. 并行开发波次（所有权边界防冲突）

```
Wave 3（设计冻结后即可并行）           独占面
├─ R1 G2 促销码（090）                marketing/promo* + payments checkout 接缝
├─ R3 C5 Stripe 适配器                payments/providers/stripe/（C 域）
├─ R4 OAuth token 刷新（094）         supply/token-refresh* + 迁移单写者
└─ R8 G4.5 公告 fan-out（098）        webhooks/ + marketing/announcements 接缝

Wave 4（依赖 Wave 3 部分产物）
├─ R2 G3 邀请返利（091）              marketing/affiliate*（依赖 R1 评审节奏共用注册表）
├─ R5 quarantine（095）               supply/validation-state（依赖 R4 刷新联动）
└─ R7 D6 连续健康+half-open           gateway/health（与 R6 同域，先行）

Wave 5
├─ R6 D5 滑窗计数器调度（097）        gateway/scheduler 系列（Track D 所有权）
└─ R9 分组费率（096，M4 后评审）
```

迁移写者串行：R1→R4→R8→R2→R5→R6（按上序申请注册表）。

---

## R1. G2 促销码（090）

### 对标语义与决策

sub2api `promo_code.go`：充值赠送固定金额（BonusAmount、MaxUses、ExpiresAt、按用户 usage 记录）——语义等同"多人次兑换码"。本仓 G0 已冻结**更强语义**：折扣作用于 checkout 定价快照、不事后改价。**维持冻结决策**，sub2api 赠送型语义已被 G1 兑换码覆盖（多码批量生成即多人次），不重复建设。

### Schema（090，两表）

`saas_marketing_promo_codes`：
- `id uuid PK`；`code text NOT NULL UNIQUE`（促销码面向公开传播、非凭证，明文规范化 `[A-Z0-9-]{4,32}` CHECK——与 G1 兑换码的不可逆存储红线刻意不同，设计评审记录）。
- `kind text CHECK (kind IN ('percent_off','amount_off'))`；`percent_bp integer CHECK (0<percent_bp<10000)` 或 `amount_minor_units text`+`currency char(3)`（互斥 CHECK，同 089 kind_shape 模式）。
- `scope text NOT NULL DEFAULT 'wallet_topup' CHECK (scope IN ('wallet_topup'))`（plan scope 留扩展位）。
- `starts_at`/`ends_at timestamptz`；`max_uses integer NULL CHECK (max_uses > 0)`；`per_tenant_once boolean NOT NULL DEFAULT true`。
- `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))`，active→disabled 单向守卫；`created_by_user_id` FK；`updated_at`；no-delete。

`saas_marketing_promo_usages`（append-only）：
- `id uuid PK`；`code_id FK RESTRICT`；`tenant_id`/`order_id uuid NOT NULL UNIQUE`（一订单至多一次促销）；`discount_minor_units text NOT NULL CHECK ~ '^[0-9]{1,20}$'`；`created_at`。
- 部分唯一索引 `(code_id, tenant_id) WHERE per_tenant_once`；no-update/no-delete 守卫族。

### 语义（冻结）

- **唯一作用点**：`PaymentFulfillmentService.createWalletTopUp` 的定价快照计算输入。请求体增可选 `promoCode`；命中则折后金额写入不可变快照（`verified_amount_minor_units` = 折后，`discount_minor_units` 入 usages 行），履约入账按快照。
- 校验同事务：码行 `SELECT ... FOR UPDATE` → 存在/窗口/status/per-tenant 重查 → usages 计数 < max_uses → 写 usage。**不超卖由行锁+计数判定保证**。
- 折后价 clamp ≥ 0（percent 下取整 floor，amount_off 超额按全额折让并记录实际折让额）；折扣计算全程 BigInt。
- 码在快照后禁用/过期**不回溯**；失败 checkout（未支付终态）usage 行保留为事实（不退还次数——防刷决策，sub2api 同款）。
- HTTP：ops CRUD（`/admin/api/v1/marketing/promo-codes`，operations/finance 带）；checkout DTO 增 `promoCode`（严格体）。

### 测试规格

单测（折让定点矩阵/clamp/窗口/次数/租户一次/超卖并发）+ HTTP 套件 + 真实 PG 门禁（受限角色下并发双 checkout 不超卖、usage UNIQUE 兜底、gateway 42501）。

---

## R2. G3 邀请返利（091）

### 对标语义

sub2api `affiliate_service.go`：`BindInviterByCode`（邀请码绑定，格式白名单校验）、`AccrueInviteRebate`（按被邀充值额比例计提返利）、rebate/transfer/withdraw 记录族、admin 审核列表。

### Schema（091，三表，G0 已冻结形状）

`saas_marketing_affiliate_attributions`：`invitee_tenant_id uuid PK`；`inviter_tenant_id uuid NOT NULL`；`invite_code text NOT NULL`；`created_at`。**归因终身不变**（no-update 触发器）；服务层不变量：不自邀、不成环（A→B 后 B→A 拒绝，事务内沿 inviter 链上溯 ≤32 层 fail-closed）。

`saas_marketing_affiliate_policies`（087 式版本化 head 单行）：`reward_bp integer NOT NULL CHECK (0<=reward_bp<=5000)`、`enabled boolean`、`version bigint CAS`、审计。

`saas_marketing_affiliate_rewards`（append-only）：`id`；`inviter_tenant_id`/`invitee_tenant_id`；`source_funding_ref text NOT NULL UNIQUE`（幂等天然键）；`source_amount_minor_units`/`reward_amount_minor_units`/`currency`；`reward_bp_snapshot integer`（计提时点比例快照防政策回溯）；`ledger_transaction_id uuid FK`；`created_at`。

### 入账与触发（C-6 对齐）

- 触发点：钱包充值**履约终态**（`fulfillFromEvent` 成功分支）同事务钩子（Track F 生产者模式）：查归因 → 无归因/政策 disabled/bp=0 → 零副作用；否则 `postVerifiedFunding`（namespace `marketing.affiliate`，business_key `<source_funding_ref>:<inviter_tenant_id>`）+ reward 行 + 审计。
- 邀请码：每租户一枚公开邀请码（`sha256(tenant_id || deployment salt)[0:12]` base32，**派生可验证、无需存储**——避免 G1 式码表；盐为部署级非秘密常量，碰撞由 attributions FK 唯一性兜底）。
- HTTP：客户 `GET /console/api/v1/tenants/:t/affiliate`（我的邀请码+归因数+返利列表 keyset）；ops `GET/PUT /admin/api/v1/marketing/affiliate-policy`（CAS）+ `GET .../affiliate-rewards`。
- 提现：返利以平台钱包余额发放（冻结决策，无现金通道；withdrawal review 记录为后续候选）。

### 测试规格

归因不变量（自邀/环/二次绑定改绑拒绝）、计提定点矩阵、政策回溯防护（改 bp 后存量 reward 不变）、同事务原子性（入账失败整体回滚充值履约不受影响？——**评审点**：返利失败不得阻断充值履约，设计为同事务内 best-effort 捕获转审计异常？**冻结决策：返利计算失败必须 fail-closed 阻断履约**——宁可人工介入不错账）、并发双履约单 winner、真实 PG 门禁。

---

## R3. PSP 渠道扩展（C5 Stripe 首家验证 + alipay/wxpay 方法论）

### C5 Stripe（`payments/providers/stripe/`，中）

sub2api `stripe.go`：官方 SDK、PaymentIntent、幂等键、webhook RSA 验签、PublishableKey 前端收集。我方映射：

- 依赖纪律：**不引官方 SDK**（主仓零云 SDK 原则同 KMS），直连 `api.stripe.com` v1 form 编码端点（PaymentIntents create/retrieve、Refunds create/retrieve），undici fetch + 出口白名单。
- acceptance 三态沿用；`confirmEvent` 语义保留红线：webhook `stripe-signature`（v1 HMAC-SHA256 + timestamp 容差 300s）验签通过后**仍主动 retrieve PaymentIntent** 复核（status=succeeded + amount/currency/metadata 一致）——与 EasyPay 双条件履约同构，区别仅是验签强度。
- 幂等：`Idempotency-Key: <localOrderId>`（create 幂等重放安全）；`recoverOrder` = retrieve by metadata.out_trade_no（list+metadata filter 或 id 直查，设计评审定）；webhook 事件身份 = `event.id` + PaymentIntent id 双锚。
- 退款：Stripe 有 Refunds retrieve——**queryRefund 不再恒 unknown**，按 retrieve 状态映射（succeeded/failed/pending/canceled），验证退款端口抽象充分性（这正是 C5 的核心价值：证明 adapter 三态对全能力 PSP 不坍缩）。
- checkout：PaymentIntent `client_secret` 归一为 constrained checkout action（前端 Stripe.js 收集，publishable key 经部署配置；redirect policy 白名单）。

### alipay/wxpay（后续批次，沿用 C2 模式）

sub2api 实证：alipay 有 `QueryOrder`（同 EasyPay 主动查单红线可映射）、wxpay 为 wechatpay-apiv3 RSA notify 验签。两者均有官方查单/退款查询 API → 适配器形态同 Stripe 而非 EasyPay（验签强、可查证）。每新增一家 PSP 必须过**适配器评审清单**：acceptance 三态映射表、confirmEvent 复核条件、幂等键、退款三态、定点金额、签名/验签算法与密钥保管、SSRF/出口白名单、mock PSP 演练（乱序/迟到/重复/退款 unknown 四件套）。

---

## R4. OAuth 账号 token 自动刷新（094）

### 对标语义

sub2api：per-provider refresher（`CanRefresh/NeedsRefresh/Refresh`），401 时 force-refresh 标记位，刷新后更新凭证材料；refresh_token 存账号 credentials。

### 现状差距

我方凭证版本链（`credential_versions` + 轮换路径）与验证 worker（D2/D3）已就位，但**只验证不刷新**——OAuth 型平台账号（refresh_token 型凭证）过期后需人工换绑。

### Schema（094，双账号表加列）

`saas_platform_provider_credentials` / `saas_tenant_provider_credentials` 增：
- `oauth_refresh_state text NULL CHECK IN ('idle','refreshing','failed')`；
- `oauth_next_refresh_at timestamptz NULL`；`oauth_last_refresh_at timestamptz NULL`；
- `oauth_force_refresh_requested boolean NOT NULL DEFAULT false`（**验证 worker** 在 401 类 auth 失败时置位——gateway 对凭证关系零写入的钉板不变量不破；刷新 worker 消费后清除）；
- `oauth_refresh_error_code text NULL`（≤128，稳定枚举）。
NULL=非 OAuth 凭证=现状行为零变化。

### 刷新 worker（`supply/oauth-token-refresh-worker.ts`）

- 扫描：due（next_refresh_at ≤ now 或 force）+ `status='active'` + `FOR UPDATE SKIP LOCKED` 有界批量（D4 同款行锁即租约）。
- 执行：信封实时解封取 refresh_token（明文凭据不出回调）→ provider OAuth token 端点（**固定适配器路径**：编译期绑定白名单 token endpoint、https、redirect manual、有界响应、AbortSignal、SSRF 钉板）→ 成功则**经既有轮换路径写新版本**（current_version+1、旧版本留痕、触发 058 失效族与 D3 复验重排）→ 清 force 位、排下次刷新（expires_in × 0.8 抖动 ±10%）；失败 → `failed` + 稳定错误码 + 退避（指数至 6h 上界），**连续失败不落调度**（验证 worker 的既有资格排除语义兜底，不新增下线逻辑）。
- 红线：refresh_token 写入信封前不出模块；token 端点响应只提取 access/refresh/expiry，余字段丢弃；**gateway 对凭证关系零写入（runtime-privileges 钉板不变量，2026-10-11 再仲裁：原"gateway 置 force 位"设计被钉板拒绝）**——force 信号由**凭证验证 worker**（D2 已区分 401 类 auth 失败）在 auth 类验证失败时置位，刷新 worker 消费并清除。

### 测试规格

单测（due 扫描/成功轮换链/失败退避/force 置位消费/凭证目的不匹配拒绝）+ 真实 PG 门禁（受限 worker 角色真实解封→mock token 端点→新版本链+复验重排；gateway 角色只能写 force 列 42501 矩阵）。

---

## R5. 凭证 quarantine 中间态（095）

### 语义

现状二元：验证失败=pending/failed→调度排除（永久直至人工）。quarantine = **隔离观察态**：失败达阈值进入，调度排除但保留周期探活；连续 N 次成功回 active。

### Schema（095，CHECK 变更 + 列）

双账号表 `validation_state`（或等价状态列）CHECK 增 `'quarantined'`；增 `quarantine_entered_at timestamptz NULL` + `quarantine_reason_code text NULL`；状态机守卫：failed→quarantined→(active|failed)，禁止 active→quarantined 直达（必须经失败事件）。

### 语义

- 验证 worker 终态失败计数 ≥3（连续）→ quarantined（审计 `provider_credential.quarantined`）；D3 周期复验对 quarantined 以**独立更长周期**（如 6h）探活；单次探活成功即回 active（计数清零）。
- 调度资格 SQL：quarantined 与 failed 同排除（资格链零感知变更，只认状态值）。
- 评审点：quarantine 是否对租户可见（控制台"隔离中"提示）——**冻结：可见**（与 failed 区分展示，避免用户误以为已恢复）。

---

## R6. D5 多层限流参与调度（097）

### 对标语义

sub2api：账号级 RPM 窗口、`LoadFactor`（并发×负载因子）、`EvaluateAccountSchedulingThreshold`（平台阈值+账号覆盖+候选评估）。

### 红线约束

权威计数 **PG 为准**（Redis 仅派生缓存）；资格查询毫秒级（不得引入重聚合）。

### Schema（097，计数器表）

`saas_provider_account_rate_counters`：`(account_scope text CHECK IN ('tenant','platform'), account_id uuid, window_start timestamptz, requests integer, tokens bigint)`，PK 四元组；`window_start` 秒级截断；admission 链（已有预留/结算写点）原子 `INSERT ... ON CONFLICT DO UPDATE SET requests = ex.requests + 1, tokens = ex.tokens + $n`；TTL 由周期清理（保留 10 分钟滑窗）。

### 调度消费

资格链读近 60s 窗口和：`requests >= account.rpm_limit`（097 同批加 `rpm_limit integer NULL` 列，NULL=不限=现状）→ 候选级摘除（同 D4 exhausted 语义）；TPM 同理。负载因子：**本期不做**（weight 已覆盖静态权重，动态负载调制并入 R7 连续权重评审）。

---

## R7. D6 连续健康权重 + half-open（无迁移）

- 健康从 healthy/degraded 二元 → **EMA 连续乘子**：`health_score = EMA(success, α=0.2)` ∈ [0,1]，chooseWeighted 的有效 weight = `weight × max(score, 0.05)`（5% 保底防全死）；分数持久化沿用既有 health 行加两列？——**并入 097 同批**（`health_score numeric(4,3)`、`half_open_probe_at timestamptz NULL`）。
- half-open：冷却期到不直接全量恢复，先放行单发探测请求（lease 语义复用），成功→恢复，失败→重进冷却（退避加倍，上界 15min）。

---

## R8. G4.5 公告 webhook fan-out（098）

### 现状

`MarketingAnnouncementEventPort` 接缝已留（publish CAS 赢家同事务恰好一次调用）；客户 webhook 管道（签名/投递/死信/防 SSRF/entitlement 白名单含 platform.maintenance）全部就绪；缺 per-tenant 扇出。

### Schema（098）

公告表加 `fanout_completed_at timestamptz NULL`（NULL=未扇出）；无需 outbox 表——公告行即游标。

### fan-out worker（`webhooks/announcement-fanout-worker.ts`）

- 扫描 `status='published' AND fanout_completed_at IS NULL` 有界批量；逐租户（entitlement 白名单含 platform.maintenance 且有 active endpoint）经 producers 原子入队（幂等键 `announcement:<id>:<tenant>`，bucket 天然幂等）→ 全部租户处理完 → 置 fanout_completed_at。
- entitlement 拒绝=丢弃不持久化（C-5 既定语义）；零订阅租户=正常跳过。
- 崩溃安全：幂等键保证重扫不重复入队；fanout_completed_at 只在全量确认后写。

---

## R9. 分组费率（096，M4 后独立设计评审）

sub2api：`Group` + `GroupModelAllowlist` + `UserGroupRateEntry`（费率倍率+RPM 覆盖）+ `GroupCapacityService`（组容量视图）。该域穿透**定价/授权/调度**三域，最小实现候选："租户标签 + 定价快照倍率列"（倍率入 checkout 定价快照计算输入，与 G2 促销同接缝）。**本期仅登记槽位与原则：不新建 group 实体，优先评估租户级定价倍率是否足够；完整 group 域需独立设计评审（M4 后）。**

---

## R10. A 级发布阻断尾项（引用既有设计，仅排期与清单）

| 项 | 既有设计位置 | 出口 |
|---|---|---|
| 云 KMS 决策门 | parallel-iteration-plan B1b + contracts-m0-freeze C-2 | M3 评审：决策检查单（pilot 范围、商业开放面、运维成本）；升级则 AWS KMS 独立可信包（loader 契约 GenerateDataKey/Decrypt/ReEncrypt 形状、EncryptionContext 绑 purpose/owner、主仓零 SDK 依赖、env specifier 加载） |
| REL-01 证据聚合 | docs/evidence/ + H3/H4 | 固定 commit 跑全门禁；native counts 入模板；FIN 矩阵 CI 化收尾（已大部在 isolated 门禁）；remote 固定 commit 证据 |
| DB-01 真实盘点 | docs/evidence/db-01-* | 逐环境清单 + 批准基线 + 盘点记录归档 |
| OPS-01 尾项 | docs/evidence/ops-01-drills.md 遗留节 | backup-restore CI 接入、worker 角色 SIGKILL、OS cleanup 清场审计 |
| 061/062 联合评审 | contracts-m0-freeze 仲裁表 | 061 integration GO 决策；062 FIN fence 设计落地 |
| PROV-01 实测矩阵 | sub2api-commercialization-integration-plan §11 | Kimi Code / DeepSeek Anthropic 固定目标实测 + 自定义 OpenAI/Anthropic 适配证据 + 商业权利登记 |

---

## 统一验收模板（每个 R 强制）

1. 迁移：钉板（注册/间隙/形状/守卫/无越权变更）+ 空库 001→head 重放 + 真实 PG catalog 核对。
2. 服务：单测（状态机/幂等/定点/并发单赢家/回滚）+ HTTP 套件（严格体/角色带/CSRF/错误重建）。
3. 真实 PG 门禁：受限角色全链 + gateway 42501 负向 + `verifySaasRuntimeDatabasePrivileges` 探针 + 双 PG（15/18 至少 PG15）入 CI isolated 门禁（ci.yml 矩阵 + runner + pin 测试三处同步）。
4. 授权镜像：runtime-privileges + roles SQL（+ worker grants 如适用）+ 部署注意注释。
5. 进度文档：交付清单 + 真实 PG 暴露并修复的问题 + native counts。

## 风险与对策

| 风险 | 对策 |
|---|---|
| R6/R7 触碰 scheduler 热路径引入回归 | 文件级所有权（Track D 系列）；资格链改动必须带既有 62 个 scheduler 单测零回归 + 商业 gateway E2E 27/27 |
| Stripe 无 SDK 直连的协议漂移 | 端点/参数钉板测试 + mock PSP 四件套演练；真实沙箱联调列 COM-01 |
| OAuth 刷新写坏凭证版本链 | 只走既有轮换路径写入；058 失效族与 D3 复验联动实测；禁止原地改密文 |
| 分组费率范围膨胀 | 仅登记槽位，M4 后独立评审；本期禁止开建 |
| 返利/促销被刷 | per-tenant-once、窗口、计数行锁、fail-closed 阻断而非事后对账 |
