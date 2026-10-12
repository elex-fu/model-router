# M0 契约冻结（Contract Freeze）

日期：2026-10-10
状态：**FROZEN** —— 冻结后修改本文件任何契约需走变更评审（修订本文件 + 计划文档 §3.2 同步 + 受影响 Track 会签）
上游文档：`docs/parallel-iteration-plan-2026-10-10.md` §3.2

本文件冻结跨 Track 接口。各 Track 开发只允许**实现**这些契约，不允许**修改**。

---

## C-1. Usage 更正端口（Track A / G 消费）

### C-1.1 更正事件（append-only）

- 更正是一类新的计量事件，**绝不修改原 usage event 或原 settlement**；原记录保持不可变。
- 表：`saas_usage_correction_events`（迁移 063），字段：
  - `id` uuid PK
  - `tenant_id` uuid 非空
  - `corrected_usage_event_id` uuid 非空，FK 到原 usage event
  - `corrected_settlement_id` uuid 可空（结算已存在时必填）
  - `reason_code` text，枚举：`provider_reported_correction` / `billing_dispute` / `metering_fault` / `operator_adjustment`
  - `correction_usage` jsonb：`NormalizedUsageExact` 全字段（更正后的精确用量，与 `canonicalUsage` 对齐的 13 字段）
  - `amount_delta_minor_units` numeric(20,0) 非空（定点整数，允许正负，禁止浮点）
  - `currency` char(3) 非空
  - `operator_identity` text 非空（平台操作员标识）
  - `evidence_ref` char(64) 可空（外部证据的 SHA-256 引用， opaque）
  - `correction_digest` char(64) 非空 UNIQUE
  - `created_at` timestamptz 非空 default now()
- 约束：仅 INSERT；DB 层 revoke UPDATE/DELETE（最小权限角色契约同步更新）。

### C-1.2 更正 digest（版本化，复用 `metering/digest.ts` 风格）

```
usageCorrectionDigest = sha256hex(JSON.stringify([
  'model-router.usage-correction.v1',
  tenantId, correctedUsageEventId, correctedSettlementId ?? null,
  reasonCode, canonicalUsage(correctionUsage),
  amountDeltaMinorUnits(string), currency, operatorIdentity, evidenceRef ?? null,
]))
```

- 前缀常量 `'model-router.usage-correction.v1'` 冻结；任何字段变更须升级版本串。
- digest 唯一约束提供天然幂等：同一更正内容重复提交 → 冲突返回已有记录（replay），不得产生第二条账本分录。

### C-1.3 账本冲正语义

- 更正生效 = 在钱包账本写**显式反向分录**（正 delta 记贷、负 delta 记借），复用 `PlatformWalletLedgerService` 的既有分录路径；**不新增**"直接改余额"通道（余额是账本投影，红线）。
- 冲正分录的 `idempotency_namespace = 'metering.usage-correction'`、`business_key = correction_digest`。
- `amount_delta_minor_units = 0` 合法且表示**仅事件更正**（usage 字段修正但金额不变）：platform 与 BYOK 均允许，此时不写账本分录；负 delta 导致余额为负时失败关闭（`INSUFFICIENT_FUNDS`，整体回滚，更正事件不落库）。
- BYOK 请求不碰平台钱包（红线）：BYOK usage 的更正只记录事件与审计，`amount_delta` 必须为 0（非 0 直接拒绝）。

### C-1.4 权限与审计

- 入口：`platform/` 运营 HTTP（复用 unknown-outcome 的 operator 授权模式：`postgres-unknown-outcome-operator-authorization.ts` 的 operations/superadmin 角色校验 + advisory shared fence）。
- 每次更正写平台审计事件（HMAC 游标审计流同款）：**仅在真实创建时**（非 replay）于同一事务内 `INSERT saas_audit_events`（`action='usage_correction_recorded'`、`target_type='saas_usage_correction_event'`、`entry_point='platform_metering'`）；因此 `operator_identity` 必须同时满足 `saas_audit_events.actor_user_id` 外键——即平台操作员的 user uuid，服务层拒绝非 uuid 形态。
- 更正与 unknown-outcome 恢复的交互：对 `reconciliation_state='pending'` 的请求禁止更正（先恢复后更正），由同一 advisory fence 保护。

---

## C-2. KMS 模块契约（Track B / F 消费）

### C-2.1 冻结的 loader 契约（不修改）

三个 loader 的工厂导出名与方法面冻结：

| Loader | 工厂导出 | 方法面 |
|---|---|---|
| `runtime/provider-credential-kms.ts` | `createProviderCredentialSealingKms({env})` | `generateDataKey(req)` / `checkReady()` / `close()` |
| `runtime/gateway-provider-credential-kms.ts` | `createProviderCredentialUnsealingKms({env})` | `decryptDataKey(req)` / `checkReady()` / `close()` |
| `runtime/provider-credential-rewrapping-kms.ts` | `createProviderCredentialRewrappingKms({env})` | `reencryptDataKey(req)` / `checkReady()` / `close()` |

请求/响应类型以 `credentials/provider-crypto.ts` 为准（`GenerateProviderCredentialDataKeyRequest` 等，`encryptionContext: Record<string,string>` 为 purpose/owner 绑定载体）。

### C-2.2 软件 KMS 模块规格（B1a，pilot-only）

- 模块名：`@model-router/kms-software`（仓内 `src/saas/runtime/kms-software/`），同一模块导出三个工厂（sealing/unsealing/rewrapping 共用实现）。
- 算法：master key（32 字节，env `MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY`，hex64）+ 随机 DEK；wrapped DEK = `AES-256-GCM(masterKey, nonce).encrypt(dek)`，AAD = canonical encryption context JSON（key 排序序列化）。
- wrapped blob 格式：`v1.<kid>.<nonce_b64>.<ct_b64>`，kid = 主密钥版本（如 `sw1`）；多版本并存：`MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY_PREVIOUS`（逗号分隔 `kid=hex`），decrypt 按 blob 内 kid 选钥，reencrypt = 模块内解密后以最新 kid 重包（明文不出模块进程）。
- `kmsKeyId` 入参校验：必须等于当前活动 kid，否则 fail-closed。
- **pilot-only 防护**：`checkReady()` 时若 `NODE_ENV=production` 且未显式设置 `MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT=true` → readiness 失败；每次 checkReady 输出一次告警日志。
- webhook signing-secret protector（F1）复用同一软件模块的 AES-GCM 原语，但 purpose/AAD 独立（`customer-webhook-signing-secret-v1`，见 `webhooks/signing-secret-protector.ts`），禁止与 provider-credential 共用上下文。

### C-2.3 云 KMS 升级路径（推迟至 M3 决策门）

- 首选候选 AWS KMS：`encryptionContext` → EncryptionContext，per-workload IAM（control-plane GenerateDataKey-only、gateway Decrypt-only）天然映射。
- 以独立包发布、env specifier 加载；主仓不引入云 SDK 依赖。

---

## C-3. EasyPay 适配器语义（Track C 消费）

实现 `payments/adapter.ts` 的 `PaymentProviderAdapter` + `PaymentProviderRefundAdapter`，providerKey = `'easypay'`。

| 契约点 | 冻结语义 |
|---|---|
| 支付模式 | **仅 mapi 直付**（服务端 POST `mapi.php` 建单取 payurl/qrcode）。配置 popup 模式 → 启动 fail-closed |
| 签名 | MD5（参数字典序拼接 + 商户密钥），创建请求 `sign_type=MD5` |
| `createOrder` | `idempotencyReference` → `out_trade_no`（DB 唯一约束分配）；acceptance 映射：HTTP 传输错误/响应不可解析/`QueryOrder` 查无此单 → `unknown`；仅当上游明确返回业务失败码且查单确认无单 → `rejected` |
| `verifyWebhook` | MD5 验签 + `trade_status == TRADE_SUCCESS` 解析。**验签通过不等于可履约** |
| 履约门槛（红线） | webhook 入账前必须主动 `QueryOrder` 复核：`out_trade_no` 匹配 + `TRADE_SUCCESS` + 金额/币种与订单一致。任一不满足 → 事件入 durable inbox 的 `reconciliation_pending`，不履约 |
| `recoverOrder` | `QueryOrder` 按 `out_trade_no` 恢复；查到成功单 → 返回原单结果；查无 → null（不新建） |
| `submitRefund` | 调 `api.php?act=refund`（先 out_trade_no，上游报无单回退 trade_no）；退款请求不签名、明文 pkey —— 出口白名单缓解，风险记入 COM-01 |
| `queryRefund` | **恒返回 unknown**（EasyPay 无退款查询接口）→ 退款走 reconciliation 队列转 operator 人工确认；不得伪造 `not_accepted` 释放冻结 |
| `refreshCheckout` | 对 PENDING 单重新调用 mapi 同单获取新 payurl；不得新建 charge |
| 金额 | 全程定点 minor units；EasyPay 元角分字符串 → 严格定点转换，拒绝浮点中间态 |
| 测试替身 | mock PSP HTTP server（挂 fake-sql 同款测试基建），覆盖乱序/迟到/重复回调、查单不一致、退款 unknown |

---

## C-4. Key 策略 DTO（Track A 消费，确认不再改）

- `keys/ip-policy-contract.ts`：`KeyIpPolicyValue` / `KeyIpPolicySnapshot` / `ReplaceKeyIpPolicyInput`（expectedVersion CAS）冻结。
- `keys/budget-policy-contract.ts`：`KeyBudgetCapsDto` / `KeyBudgetCounterSnapshot` / `KeyBudgetUtcDay` / `ReplaceKeyBudgetPolicyInput` 冻结；`KeyBudgetDecimal` 为定点十进制字符串，禁止 `Number` 转换进入运算路径。
- 纯函数 `isIpAllowed`（`ip-policy.ts`）、`evaluateProxyKeyBudgetAdmission`（`budget-policy.ts`）、`resolveClientAddress`（`gateway/client-address.ts`）语义冻结，接入时只接线不改逻辑。

---

## C-5. Webhook entitlement policy（Track F / G 消费）

- 接口冻结（`webhooks/postgres-store.ts:49`）：`CustomerWebhookEventEntitlementPolicy.assertEntitled({tx, tenantId, eventType, data})`，在 enqueue 事务内调用，拒绝即抛错回滚。
- 实现规格（F2）：按租户当前 plan entitlement 判定事件类型可订阅性；plan 不含 webhook 能力 → 全部拒绝；含则按事件类型白名单放行。7 种事件类型集合以 `webhooks/events.ts` 为准，冻结。
- 签名密钥 protector（F1）：`WebhookSigningSecretProtector` 接口冻结；软件实现复用 C-2.2 原语，purpose/AAD 独立。

---

## C-6. 营销域账本钩子（Track G 消费）

- 兑换码（余额型）入账：`PlatformWalletLedgerService.postVerifiedFunding` 同源路径，`idempotency_namespace = 'marketing.redeem'`，`business_key = redeem_code_id + ':' + tenant_id`（单次核销天然幂等）。
- 兑换码（订阅型）：走 plans 服务的发放路径，不碰钱包。
- 促销码：只作用于 checkout 时的定价快照计算输入，**不事后改价**、不改账本。
- 返利入账：同 postVerifiedFunding 路径，`idempotency_namespace = 'marketing.affiliate'`。
- 公告：独立表 + 已读追踪；发布时产出一类 webhook 事件（事件类型若超出现有 7 种，须在 C-5 变更评审中扩展）。

---

## C-7. 调度资格数据源扩展（Track D 消费）

- provider account 表新增列（迁移 082，原 064 槽位退役见仲裁表）：`priority integer NOT NULL DEFAULT 0`、`weight integer NOT NULL DEFAULT 1`。
- 不变量（DB CHECK）：`0 <= priority <= 1000`、`1 <= weight <= 10000`。
- `PostgresEligibilityAuthority` 读取 SQL 与行校验同步扩展；`chooseWeighted()` 算法不变（已支持 priority 降序 + 加权抽签），仅数据源从恒 0/1 变为持久化值。
- 向后兼容：存量行默认值即现状行为（priority 0 / weight 1）。

---

## 迁移编号登记（方案 §3.4 仲裁表）

| 号段 | Track | 用途 | 状态 |
|---|---|---|---|
| 061 | — | audited credential validation requeue（inactive，integration GO 前不注册） | 已存在，冻结 |
| 062 | A | FIN 请求执行 fence/恢复设计（reserved，已有设计占位） | 保留 |
| 063 | A | `saas_usage_correction_events`（C-1.1） | **已注册** |
| 064–079 | — | **退役，永不注册**：串行集成使 080/081 先于 D–G 落库；凡已应用 080/081 的库按 fail-closed 顺序规则永不能接受更小编号。原 D/E/F/G 分配整体顺延至 082+ | 退役 |
| 080 | A | KEY-IP 策略版本化 head 表（C-4，A4） | **已注册** |
| 081 | A | KEY-BUD 预算计数器（C-4，A5） | **已注册** |
| 082 | D | 调度 priority/weight 列（C-7，原 064 槽位） | **已注册** |
| 083 | D | 平台池凭证验证任务表（原 065 槽位） | **已注册** |
| 084 | D | 账号级周期复验列（D3；串行仲裁：D 继续消费下一稠密槽位，E/F/G 顺延一格） | **已注册** |
| 085–086 | E | 成员/Owner 转移/Passkey schema（如需，原 066–067） | 已分配 |
| 087–088 | F | webhook 补充列（如需，原 068–069） | 已分配 |
| 089–098 | G | 营销域（原 070–079） | 已分配 |
| 099+ | — | 预留 | — |

规则：单写者队列；合并后立即 `saas:migration-audit` 全量校验 + 空库 001→head 重放；禁止 renumber 已合并迁移；号段内空号在注册表跳过并注释；每个迁移同 PR 携带单测 + PG 集成测试 + 受限角色授权核对。
