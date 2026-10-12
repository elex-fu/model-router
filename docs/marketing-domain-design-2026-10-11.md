# 营销域设计冻结稿（G0）

日期：2026-10-11
状态：**待评审冻结**（冻结后改动需变更评审；G1/G4 目标 M3，G2/G3 可顺延 M4 后）
依据：`docs/parallel-iteration-plan-2026-10-10.md` Track G；`docs/contracts-m0-freeze.md` C-6（账本钩子）、§3.4 迁移编号仲裁（G 段 089–098）

---

## 1. 范围与红线

四个子域：兑换码（G1）、促销码（G2）、邀请返利（G3）、公告（G4）。全部为新域 `src/saas/marketing/`，对标 sub2api 仅设计借鉴，不复制源码。

红线（继承 §3.2，任何子域不得退化）：

1. **定点金额**：一切金额 minor units 文本/BigInt，禁止浮点。
2. **不可逆存储**：兑换码本体只存 sha256 摘要 + 展示前缀；平台永不持明文码。
3. **fail-closed**：码校验、额度计算、状态迁移任一异常即拒绝，不猜测不放行。
4. **账本同源**：一切钱包入账只走 `PlatformWalletLedgerService.postVerifiedFunding`（幂等命名空间见 §3），禁止旁路 SQL 改钱包。
5. **审计**：每一次码生成/核销/禁用、促销使用、返利入账、公告发布/撤回同事务落 `saas_audit_events`。
6. **最小权限**：gateway 角色对营销域零授权；control-plane 列级精确授权，角色模板同步镜像。

## 2. 迁移编号规划（Track H 仲裁）

| 迁移 | 子域 | 内容 |
| --- | --- | --- |
| 089 | G1 兑换码 | `saas_marketing_redeem_codes` + `saas_marketing_redeem_redemptions` |
| 090 | G2 促销码 | `saas_marketing_promo_codes` + `saas_marketing_promo_usages` |
| 091 | G3 邀请返利 | `saas_marketing_affiliate_attributions` + `saas_marketing_affiliate_rewards` + `saas_marketing_affiliate_policies` |
| 092 | G4 公告 | `saas_marketing_announcements` + `saas_marketing_announcement_reads` |
| 093–098 | 预留 | 子域演进；未用号段作废留空 |

每个迁移同 PR 携带：单测 + PG 集成（双 PG 至少 PG15）+ 受限角色授权核对（对照 `deploy/managed-saas-postgres-roles.sql`）+ 注册表/checkpoint 钉板更新。沿用既定模式：no-delete 触发器、身份列不可变守卫、definer 包装函数 `SET search_path TO pg_catalog, model_router_saas, pg_temp`。

## 3. 账本与事件钩子（C-6 对齐）

| 动作 | 路径 | idempotency_namespace | business_key |
| --- | --- | --- | --- |
| 兑换码（余额型）入账 | `postVerifiedFunding` | `marketing.redeem` | `<redeem_code_id>:<tenant_id>`（单次核销天然幂等） |
| 返利入账 | `postVerifiedFunding` | `marketing.affiliate` | `<source_funding_ref>:<inviter_tenant_id>` |

- 兑换码（订阅型）：走 plans 服务既有发放路径，**不碰钱包**。
- 促销码：只作为 checkout 定价快照的**计算输入**，不事后改价、不改账本（无独立命名空间）。
- 公告事件：发布时产出 `platform.maintenance` webhook 事件（F3 预留入口），**不扩展 C-5 事件类型**。

## 4. G1 兑换码

### 4.1 数据模型（089）

`saas_marketing_redeem_codes`：
- `id uuid PK`；`code_hash text NOT NULL UNIQUE`（sha256 of 规范化码，64-hex CHECK）；`code_prefix text NOT NULL`（≤8，展示用，非秘密）。
- `kind text NOT NULL CHECK (kind IN ('balance','subscription'))`。
- 余额型：`amount_minor_units text` + `currency char(3)`；订阅型：`service_plan_snapshot_id uuid`（引用定价快照）。
- CHECK 互斥：balance 必须有金额+币种且 snapshot 为 NULL；subscription 反之。
- `status text NOT NULL CHECK (status IN ('active','redeemed','disabled'))`；`batch_ref text NOT NULL`（生成批次，审计关联）。
- `redeemed_by_tenant_id uuid` / `redeemed_at timestamptz` / `disabled_at timestamptz`；状态单向守卫触发器（active→redeemed/disabled，不可逆，禁 DELETE）。
- `created_by_user_id uuid` / `created_at timestamptz`。

`saas_marketing_redeem_redemptions`（append-only 核销事实）：
- `id uuid PK`；`code_id uuid NOT NULL UNIQUE REFERENCES`（单码单核销的 DB 级兜底）；`(tenant_id, user_id)`；`ledger_transaction_id uuid`（余额型入账引用，订阅型 NULL）；`created_at`；禁 UPDATE/DELETE 触发器。

### 4.2 码生成（运营侧）

- crypto 随机 ≥128 bit，base32 无歧义字母表分组展示（如 `XXXX-XXXX-XXXX-XXXX`）；规范化 = 去分隔符大写。
- 落库仅 `sha256(normalized)` 与 `prefix = normalized[0:4]`；批量生成同事务审计（数量、kind、面额，**永不记录明文**）；明文仅在生成响应中一次性返回（"显示即焚"，不落日志）。
- 权限：平台 `operations`/`finance` 角色带；禁用（disable）同带 + 审计。

### 4.3 核销（客户侧）

单事务：`code_hash` 命中 → `SELECT ... FOR UPDATE` → `status='active'` 校验 → CAS 置 `redeemed`（谓词 `WHERE id AND status='active'`，rowCount=1 否则并发冲突拒绝）→ 插 redemption → 余额型同事务 `postVerifiedFunding`（§3）/ 订阅型调 plans 发放 → 审计 `marketing.redeem.completed`。

- 幂等：重放同一请求（同 code 同 tenant）= 已核销结果读出（redemption + 钱包摘要），不重复入账（DB UNIQUE + 账本幂等双兜底）。
- 防爆破：客户会话 + CSRF + 速率档 `marketing-redeem:source:v1`（每用户与每源双维）；码不存在/已用/禁用统一 `REDEEM_CODE_INVALID`（不泄露存在性）；码空间 ≥2^96 使在线穷举不可行。
- 负余额不可能（入账纯 credit）；币种必须匹配租户钱包或开新钱包（postVerifiedFunding 既有语义）。

## 5. G2 促销码

### 5.1 数据模型（090）

`saas_marketing_promo_codes`：促销码**面向公开传播，非凭证**（不适用不可逆摘要红线）——`code text NOT NULL UNIQUE`（规范化 `[A-Z0-9-]{4,32}` CHECK）。
- `kind text CHECK (kind IN ('percent_off','amount_off'))`；`percent_bp integer CHECK (0 < percent_bp < 10000)` 或 `amount_minor_units text` + `currency char(3)`（互斥 CHECK 同 G1 模式）。
- `scope text CHECK (scope IN ('wallet_topup'))`（首期仅充值；plan  scope 留扩展位）。
- `starts_at`/`ends_at`；`max_uses integer NULL`；`per_tenant_once boolean NOT NULL DEFAULT true`；`status ('active','disabled')` 单向守卫。

`saas_marketing_promo_usages`：`id`；`code_id REFERENCES`；`tenant_id`；`order_id uuid NOT NULL UNIQUE`（一个订单至多一次促销）；`discount_minor_units text NOT NULL`（折让额，快照组成部分）；`(code_id, tenant_id) UNIQUE WHERE per_tenant_once` 部分唯一索引；append-only。

### 5.2 语义（冻结）

- 唯一作用点：checkout 创建时的**定价快照计算输入**。客户传码 → 校验（存在/窗口/次数/租户维度）→ 折后金额写入**不可变快照**；履约入账按快照金额；快照之后码被禁用/过期**不回溯**。
- 禁止：事后改价、对已履约订单补折、折后价为负（clamp 到 0 且记录折让额）。
- max_uses 计数 = usages 行数（事务内 `SELECT ... FOR UPDATE` 码行 + 计数判定，不超卖）。

## 6. G3 邀请返利

### 6.1 数据模型（091）

`saas_marketing_affiliate_attributions`（归因，一被邀租户至多一个邀请人）：
- `invitee_tenant_id uuid PK`；`inviter_tenant_id uuid NOT NULL`；`invite_code text NOT NULL`（邀请人公开码，非秘密）；`created_at`。
- 服务层不变量：不得自邀（inviter≠invitee）；不得成环（A→B 后 B→A 拒绝）；归因**终身不变**（no-update 触发器）。

`saas_marketing_affiliate_policies`（平台级单行配置，087 式版本化 head）：
- `reward_bp integer NOT NULL CHECK (0 <= reward_bp <= 5000)`（返利基点，≤50%）；`enabled boolean`；`version bigint` CAS；审计。

`saas_marketing_affiliate_rewards`（返利记录，append-only）：
- `id`；`inviter_tenant_id`；`invitee_tenant_id`；`source_funding_ref text NOT NULL UNIQUE`（被邀人充值履约引用，幂等天然键）；`source_amount_minor_units` / `reward_amount_minor_units` / `currency`；`reward_bp_snapshot integer`（归因时点比例快照，防政策回溯）；`ledger_transaction_id uuid`；`created_at`。

### 6.2 入账与提现（冻结）

- 触发：被邀租户钱包充值**履约终态**钩子（同事务，复用 Track F 生产者模式）：按归因 + 当前政策快照计算返利 → `postVerifiedFunding`（§3 命名空间）→ reward 行 + 审计。
- 无归因/政策关闭/比例为 0 → 零副作用（不产生空行）。
- **提现**：返利以平台钱包余额发放，**不可提现现金**（model-router 无现金通道）。sub2api 式提现审核（withdrawal request + E4 审批）记录为后续候选，本期不建表——若未来开放，提现=钱包余额的冻结+运营审批流，复用退款冻结模式。

## 7. G4 公告

### 7.1 数据模型（092）

`saas_marketing_announcements`：
- `id`；`kind text CHECK (kind IN ('maintenance','info','billing'))`；`severity text CHECK (severity IN ('info','warning','critical'))`。
- `title text CHECK (length <= 200)`；`body text CHECK (length <= 8000)`。
- `publish_at` / `unpublish_at NULL`；`status ('draft','published','withdrawn')` 状态机守卫（draft→published→withdrawn，published 不得回 draft）。
- `version bigint`（CAS）；`created_by_user_id` / 审计。

`saas_marketing_announcement_reads`：`(announcement_id, user_id)` 组合 PK + `tenant_id` + `read_at`；append-only（重复已读 = INSERT ON CONFLICT DO NOTHING）。

### 7.2 展示与事件

- 控制台：通知中心（E3 延期项，本域落地后解除阻塞）+ banner（published 且窗口内、按 severity 排序）。
- webhook：发布（draft→published）同事务产出 `platform.maintenance` 事件（Track F 生产者入口接线）；撤回/修改标题正文不重复发事件（仅发布转移一次）。
- 运营侧：发布/撤回走 `operations` 角色带 + 审计；客户侧只读 + 已读上报。

## 8. HTTP 与权限带（汇总）

| 路由 | 侧 | 角色带 |
| --- | --- | --- |
| `POST /console/api/v1/tenants/:t/redeem` | 客户 | 活跃成员 + CSRF + 双维限速 |
| `GET /console/api/v1/tenants/:t/announcements` / `POST .../:id/read` | 客户 | 活跃成员 |
| `POST /admin/api/v1/marketing/redeem-codes`（生成/禁用/列表） | 运营 | operations/finance |
| `POST /admin/api/v1/marketing/promo-codes`（同上） | 运营 | operations/finance |
| `GET/PUT /admin/api/v1/marketing/affiliate-policy`；`GET .../rewards` | 运营 | operations/finance（写 CAS） |
| `POST /admin/api/v1/marketing/announcements`（发布/撤回/列表） | 运营 | operations |

checkout 促销输入：钱包充值 checkout 创建路由增加可选 `promoCode` 字段（严格 DTO）。

## 9. ACL 与授权镜像

- gateway 角色：四域全部零授权（只读表清单不加）。
- control-plane：`runtime-privileges.ts` 注册表逐表列级 SELECT/INSERT/UPDATE（状态机列）精确授权 + `deploy/managed-saas-postgres-roles.sql` 三元组行镜像；每期部署注意"迁移后重跑角色模板"。

## 10. 测试与门禁规格

每子域：单测（状态机/幂等/定点金额/防爆破/防环）+ HTTP 套件（严格体/角色带/CSRF）+ 真实 PG 受限角色集成（核销全链、并发核销单赢家、促销商用不超卖、返利同事务入账、公告事件恰好一次）接入 CI isolated 门禁（ci.yml 矩阵 + runner + pin 测试三处同步，沿用 080–085 模式）。

## 11. 显式不做（防膨胀）

- 不做内容风控（§附录 A：本期不立项）；不做多级分销；不做提现现金通道（§6.2）；
- 不做促销码事后改价/返现型促销；不做公告的租户级定向（首期全员广播）。

## 12. 交付顺序

G1（089 + 核销全链）→ G4（092 + 通知中心接线解除 E3 阻塞）→ G2（090）→ G3（091）。M3 出口：G1+G4 交付；G2/G3 可顺延 M4 后（风险表既定）。
