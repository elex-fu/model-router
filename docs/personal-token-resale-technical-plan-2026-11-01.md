# 个人订阅账号 Token 售卖中转站技术方案（B2C 余额计量模式）

日期：2026-11-01。状态：设计稿（未开工）。
依据：2026-11-01 需求对话 + 本仓库代码事实核查（注册、支付、定价、供给、调度各模块逐一核对）。

## 0. 已拍板的产品决策（本方案的固定前提）

以下决策来自需求方，方案不再讨论备选路径：

1. **不做合规闸门**。不限制账号供给方式：订阅 OAuth 账号（Codex/Claude/Gemini/Grok）、auth.json / PAT 等导入的鉴权信息均可作为平台供给。`provider_rights` 不作为供给池启用的前置阻断条件。经营风险由运营方自担，本方案只处理技术问题。
2. **计费从简**：充值到余额 → 每个模型有自己的价格规则 → 按定价消耗余额。不做套餐、周期额度、兑换码、自动续费、推广返佣。
3. **面向个人**：开放注册、自助充值、自助创建 Key、自助消费。企业组织语义对用户隐藏。
4. **风控保留**：保护账号资产 + 控制滥用。
5. **不变量不拆**：双分录账本、BYOK/平台供给隔离语义、逐请求可解释性、prepared-evidence 派发、备份恢复演练全部保留。

## 1. 产品形态与范围

### 1.1 目标产品

个人用户注册账号 → 充值余额 → 创建 API Key → 用 Claude Code / Codex CLI / OpenAI SDK / Gemini SDK 等客户端直接消费 → 按模型定价从余额扣费。供给来自运营方维护的账号池（订阅 OAuth 账号 + API 型上游，方式不限）。

用户动线（目标态）：

```
注册(邮箱+验证码/Turnstile) → 登录 → 充值(扫码/跳转支付) → 创建 Key(一次性展示)
→ 复制客户端配置 → 调用 /v1/* → 按模型价格扣余额 → 查看用量/订单/余额
```

### 1.2 明确不做

- 套餐/周期额度/订阅制、兑换码、自动续费、返佣、推广系统
- 多租户组织/项目/成员管理的前台暴露（底层保留，见 §6.1）
- BYOK 对个人用户开放（保留代码路径，默认关闭入口；防止个人用户面出现两套供给语义）
- 多币种、多 PSP 并行收款（单 PSP 先行，四家适配器任选其一）
- 多模态异步任务、插件市场、Realtime 语音（按后续产品决策）

### 1.3 与现有 SaaS 设计的关系

本方案是 `sub2api-commercialization-integration-plan.md` 目标系统的**一个供给与商品形态变体**：复用其全部控制面与数据面，仅替换三处——权利闸门的启用条件（§4.3）、商品形态（§5，恰好是现有计量钱包，无需替换只需暴露）、用户面语义（§6）。不新建独立服务，保持模块化单体。

## 2. 现状盘点（2026-11-01 代码核查）

### 2.1 已有能力（直接复用，不重写）

| 领域 | 现状 | 锚点 |
|---|---|---|
| 开放注册 | `RegistrationMode = 'open'/'invite'/'closed'`，env/settings 双通道，Turnstile 防机器人、邮箱验证齐备 | `src/saas/identity/registration-settings.ts`、`register-service.ts`、`turnstile-service.ts`、`email-verification-service.ts` |
| 充值 | `wallet_topup` 订单全链路：checkout（redirect/qr）、支付事件、掉单处理、退款 worker | `src/saas/payments/`（service/checkout/worker/refund-worker） |
| PSP | alipay / easypay / stripe / wxpay 四家适配器 + 商户绑定 + descriptor 化部署合同 | `src/saas/payments/providers/`、`docs/payments-deployment-2026-10-24.md` |
| 定价 | 版本化价格/成本快照、计算器、倍率、OpenRouter 价格同步 worker | `src/saas/pricing/`、`src/saas/supply/openrouter-model-pricing-sync-worker.ts` |
| 扣费 | 预留→结算、双分录不可变账本、事务平衡断言、未知用量策略 | `src/saas/billing/`、`src/saas/metering/` |
| 订阅账号栈 | 四家 OAuth：PKCE 绑定、auth.json 导入、id_token 解析、定时刷新（1724 行 worker）、每账号出口代理、六位探针自动验证 | `src/saas/platform/{codex,claude,gemini,grok}-oauth/`、`src/saas/supply/oauth-token-refresh-worker.ts`、`account-probe-service.ts` |
| Codex 防腐 | 版本自动同步、真实 instructions lockstep、wham 主动配额 + auto reset、manifest、别名表、PAT 凭证类型 | `src/saas/supply/codex-version-sync.ts`、`codex-wham-usage-worker.ts`、`src/saas/platform/codex-pat/` |
| 身份保真 | canonical 身份头、会话命名空间隔离（session_id 跨账号不泄漏） | `src/saas/gateway/oauth-subscription/` |
| 调度 | PG 权威账号调度：容量预留、租约、健康、affinity、SKIP LOCKED | `src/saas/gateway/postgres-provider-account-scheduler.ts` |
| 配额快照 | 被动配额头解析 + 主动 wham/usage worker（codex/gemini/opencode-go/cn-providers） | `src/saas/supply/quota-sync-worker.ts`、`provider-account-quota-snapshot-store-postgres.ts` |
| 风控件 | 关键词匹配、Key IP 策略、认证防爆破、登录限速 | `src/saas/risk/`、`src/server/key-ip-policy.ts` |
| 审计/恢复 | 审计日志、备份恢复、prepared-evidence 派发 | `src/saas/backup/`、`src/saas/gateway/postgres-request-preparation-authority-adapter.ts` |

### 2.2 差距清单（本方案要建的）

| # | 差距 | 归属章节 |
|---|---|---|
| G1 | `provider_rights` 证据闸门阻断订阅账号供给池启用 | §4.3 |
| G2 | 账号只能单个绑定，无批量导入/批量探针流水线 | §4.2 |
| G3 | 健康分类无"封禁"终态，无自动下架/补号告警 | §4.4 |
| G4 | 配额快照是被动观测，未成为调度主信号（无 least-utilized） | §4.5 |
| G5 | 无账号成本台账（月费/存活/产出/COGS） | §4.6 |
| G6 | 门户是组织/项目企业语义，无个人动线 | §6 |
| G7 | 无用户级滥用控制（并发/日限额/异常检测/封禁流程） | §7.2 |
| G8 | 无客户端一键配置/教程页 | §6.4 |
| G9 | R8 Codex 可售验收、R7 云恢复、四家真实 OAuth smoke 欠账 | §10.1 |

## 3. 总体架构

```
个人用户                    运营方
   │                          │
   ▼                          ▼
┌─────────────────────────────────────────────────┐
│ B2C 门户（瘦身的现有 console）                      │
│  注册/登录 · 充值/订单 · Keys · 模型价格 · 用量     │
├─────────────────────────────────────────────────┤
│ 控制面（PG 权威，全部现有）                          │
│  identity(open注册) payments(wallet_topup) pricing  │
│  billing(双分录) catalog keys audit risk           │
├─────────────────────────────────────────────────┤
│ 账号资产运营层（本方案主要新增）                      │
│  批量导入 · 健康/封禁处置 · 配额窗调度 · 成本台账     │
├─────────────────────────────────────────────────┤
│ 数据面 gateway（现有，不动语义）                     │
│  prepared evidence → entitlement → route → 账号租约 │
│  → OAuth transport(身份保真/会话隔离) → 上游         │
│  → 计量预留/结算 → 余额扣减                          │
└─────────────────────────────────────────────────┘
```

部署形态不变：单地区、单基础币种、单 PSP、PG 权威 + Redis 派生缓存（登录限速/可重建缓存，非 gateway 前置依赖）。

## 4. 供给面：账号资产运营

### 4.1 账号统一模型

复用 `saas_tenant_provider_accounts` 平台账号体系（supply_mode='platform'），不新建账号表。扩展两个维度：

- **状态机扩展**：现有 active/paused 之外增加运营终态 `banned`（封禁，不可逆）与 `depleted`（配额窗耗尽，由 reset 时刻自动回归 active）。状态迁移全部走现有审计路径。
- **凭证类型自由扩展**：沿用 codex-pat 先例——`credential_type` 自由文本零迁移，新供给形式（auth.json 导入、refresh_token 直导、PAT）以新权利三元组登记，不动 schema。

### 4.2 批量导入流水线（G2）

新建运营侧批量导入能力（管理 API + 运营 UI）：

- **输入形式**：① auth.json 文件批量（Codex）；② 结构化清单（每行 = 凭证材料 + 可选 egress_proxy_id + 可选显示名）；③ 单个 OAuth 交互式绑定（现有，保留）。
- **流水线**：`bulk_import_job`（新表，见 §9）→ 逐账号落库（复用各 supply-sink 的 `createPlatformProviderAccount` + `createPlatformProviderCredential` 审计路径）→ 自动入验证队列（现有 credential-validation worker + 六位探针）→ 验证通过即 active 可调度；失败进重试/人工处理队列。
- **出口代理绑定**：导入时逐账号指定或按规则分配 egress proxy（现有 `egress-proxies-http.ts`、`account-outbound.ts`），代理与账号同寿命；探针与刷新流量全部走账号绑定代理，fail-closed 不回落直连。
- **幂等**：同一凭证材料指纹（不存明文，存 HMAC）重复导入返回既有 accountRef，不产生重复账号。
- **验收**：100 账号批量导入（含 10% 坏材料）→ 好账号全部 active+verified，坏账号全部隔离且原因可查，零明文落日志。

### 4.3 权利闸门解绑（G1，对应决策 0）

现状：供给池/目录/派发检查 `provider_rights` 有效记录（含审批证据）。调整原则——**保留四层判定结构，只改变权利记录的来源与证据语义**，不做"绕过检查"的硬编码分支：

- 新增权利证据类型 `operator_assertion`：运营方显式声明即构成有效权利登记（登记人、时间、范围、说明留痕，可撤销、有版本，全部沿用现有 rights 生命周期）。
- 平台供给池的 rights 登记在批量导入时由运营动作自动附带生成（Provider × 产品 × 凭证类型 × 地区 × 用途 × 模型/端点范围），无需逐账号手工登记。
- 协议能力验证（`provider_capabilities` 的 verified）**不放松**：探针验证通过才可调度，这是技术可用性而非合规问题。
- 客户 entitlement、route selection 两层不变。

效果：任何供给方式（OAuth 导入/PAT/auth.json）都可启用，同时保留"哪个运营员在什么时间放行了什么供给"的完整审计链。

### 4.4 封禁与降载处置（G3）

- **健康分类扩展**（`health-classifier.ts`）：在现有 terminal/retryable 之外识别封禁特征——持续性 403（非配额）、验证墙响应、额度异常归零、whoami/探针连续失败超过阈值。命中 → 账号置 `banned`、立即从调度池摘除、在途请求按现有 failover 转移。
- **降载识别**：上游流内降载信号（如 `server_is_overloaded`）、异常 429 频率 → 降权而非下架，恢复后自动回升。
- **补号告警**：池可用容量（活跃账号数 × 各账号剩余配额窗估算）低于运营阈值 → 告警（现有告警通道），附"需要补充 N 个账号"估算。
- **封禁台账**：每账号记录封禁时间、封禁前最后错误、存活天数、累计产出——喂给 §4.6 成本台账与账号来源质量分析。

### 4.5 配额窗调度（G4）

把配额快照从被动观测提升为调度主信号：

- **统一配额模型**：归一化各厂商配额窗（Codex primary/secondary、Claude 5h/周、Gemini 日配额）为 `{window_remaining_ratio, reset_at, stale_at}`，复用 `classifyQuotaPause` 规则（100% 暂停、reset 解禁、陈旧停止门控）。
- **选择策略**：在现有健康/affinity 过滤之后、租约获取之前，按 **window_remaining_ratio 降序 + 粘性优先** 选择账号（least-utilized）；同账号会话保持 affinity 不变。策略做成可配置：`quota_aware`（默认）/ `round_robin`（现状回退）。
- **耗尽即隔离**：remaining=0 → `depleted`，reset_at 到达自动回归；wham auto reset（Codex credits）保持默认关，运营可显式开启。
- **验收**：构造两账号（一耗尽一充裕）→ 请求全部落充裕账号；reset 到达后恢复双账号分流；粘性会话不跨账号漂移。

### 4.6 账号成本台账（G5）

订阅账号是月费固定成本，与 API 计价的上游成本模型不同，新建轻量台账：

- **账号成本字段**（新表 `provider_account_cost`，见 §9）：买入价（基础币种 minor units）、计费周期（月/季/年）、生效起止、来源备注。
- **产出归集**：复用现有 usage/attempt 持久化，按账号聚合累计 token/请求数/结算金额。
- **COGS 报表**（运营页）：每账号 = 摊销成本 / 累计产出 token → 每百万 token 实际成本；每池汇总；账号存活天数与沉没成本（banned 未摊完部分）。
- 该台账只服务运营定价决策，**不进客户计费链路**——客户扣费永远按 §5 的发布价格版本，与实际成本解耦。

## 5. 商品与计费：余额制（基本无新开发）

### 5.1 充值

- 复用 `wallet_topup`：客户选择金额 → checkout（qr/redirect）→ PSP 回调入账 → 余额可查。部署期按 `payments-deployment-2026-10-24.md` 选定一家 PSP（个人场景建议 alipay 或 wxpay 当面付，easypay 备选）。
- 运营配置：最低/最高单笔充值额、每日充值次数上限（现有 admission limits 通道）。
- 掉单补单、退款审核走现有 worker/运营页，不新建。

### 5.2 定价

- 每模型价格 = 已发布价格版本（输入/输出/缓存各档，minor units per token），支持 OpenRouter 同步 + 运营手工覆盖；价格变更只产生新版本，历史请求按当时版本结算（现有语义）。
- **个人展示简化**：模型价格页直接列"每 1M token 输入价 / 输出价（人民币）"+ 各模型可用状态；不展示成本、倍率、价格版本号等运营概念。
- 按次计费端点（如 alpha_search）沿用"成功才计费"先例。

### 5.3 扣费与余额边界

- 请求准入时按估计用量做资金预留，响应后按实际用量结算（现有 metering 路径）；余额不足 → 预留失败，稳定拒绝（HTTP 402 语义按现有错误包络），**不允许负余额、不欠费**。
- 无可靠用量时执行版本化 unknown/estimated 策略，不默认为零（现有不变量）。
- 流式中断/取消按现有部分用量结算规则。
- 预留/结算/幂等/冲正全部复用双分录不变量，**禁止为个人模式另写简化扣费路径**。

## 6. 用户面：B2C 自助

### 6.1 企业语义收纳（不删底层）

- 注册时自动创建：单成员 tenant + 默认 project + 默认平台供给 entitlement（绑定默认 supply profile）。个人用户不感知组织/项目/成员概念。
- entitlement 由服务端解析绑定（现有契约）：客户端不能选择 supply profile/entitlement ID。
- 门户导航只保留：**总览（余额/今日用量）、模型价格、API Keys、充值与订单、用量、设置（密码/MFA/会话）**。组织、BYOK、服务计划、退款企业流程等入口按部署开关隐藏（新增 console feature flag，不删页面代码）。

### 6.2 注册与登录

- 部署配置 `MODEL_ROUTER_SAAS_REGISTRATION_MODE=open` + Turnstile + 邮箱验证（全部现有）。
- 登录限速、MFA、passkey 保持现状；会话管理页保留。

### 6.3 Key 自助

- 创建/轮换/吊销、一次性展示、hash+prefix 存储全部现有；创建时只选模型组（可选），不暴露供给概念。
- 每个 Key 默认带用户级限额（§7.2），用户可在限额内自调 RPM。

### 6.4 客户端接入体验（G8）

- **一键配置**：门户提供各客户端复制即用的配置块——Claude Code（`ANTHROPIC_BASE_URL` + key）、Codex CLI（base_url + key）、OpenAI SDK、Gemini SDK；附 base_url 与模型名自动填入。
- 教程页：每客户端一页图文（安装 → 配置 → 验证一条请求）；模型列表页与 `/v1/models` 实际可用集合一致。
- 验收：全新用户按教程 5 分钟内完成 Claude Code 首次真实调用（作为 E2E 场景进验收矩阵）。

## 7. 风控

### 7.1 账号资产保护

- 请求指纹一致性：canonical 身份头、instructions lockstep、版本同步全部保持开启；禁止用户自定义会改变上游指纹的字段。
- 用户→账号粘性：同一 Key 的连续会话优先同账号（现有 affinity），降低关联与 cache 浪费。
- 每账号出口代理强制绑定（§4.2），运营动作（刷新/探针/wham）同样走代理。
- 上游异常行为监测：单账号单位时间请求突增、非常规模型/端点调用占比异常 → 自动降权并告警。

### 7.2 用户滥用控制（G7）

- **限额三层**：平台默认（全局）→ 用户级（运营可单独调整）→ Key 级（用户自调，不超过用户级上限）。维度：并发、RPM、日 token 上限、日消费金额上限。复用现有 limiter/quota 通道，新增"用户级"配置层与默认值设置。
- **异常检测**：单 Key 多地 IP 短时切换、调用模式突变（QPS/模型分布）、注册批量特征 → 风险标记 + 阶梯处置（限速 → 暂停 Key → 暂停账号），全部留审计。
- **封禁流程**：运营封禁用户 → 其所有 Key 即时失效 + 在途请求按现有取消语义处理 + 余额按退款流程处理；封禁可撤销，撤销不自动恢复 Key。
- **内容风控**：关键词匹配接入平台供给请求路径（审计模式先行，拦截模式运营可配）。

### 7.3 支付风控

- 充值回调验签/重放防护（现有）；异常高频小额充值、支付后立刻大额消耗模式进风险标记。
- 退款一律人工审核（现有运营退款页），封禁账号余额退款单独排队。

## 8. 保留的不变量（验收红线）

1. 双分录账本与事务平衡断言：任何新路径（批量导入、封禁退款、异常处置）不得产生未入账资金变动。
2. BYOK / 平台供给隔离：个人模式虽不开放 BYOK，隔离语义与表结构不动。
3. 逐请求可解释性：谁发起、授权依据、命中账号、尝试次数、实际用量、结算状态——新增账号状态迁移也要可解释。
4. prepared-evidence 派发与审计链不变。
5. 备份恢复演练：账号池 + 钱包数据必须可恢复，恢复后账务一致。

## 9. 数据模型与迁移清单

原则：零新迁移优先；确需新增的走前滚迁移 + 注册表 + 双 PG 版本验收（现有纪律）。

| 项 | 方式 | 说明 |
|---|---|---|
| `bulk_import_job` + `bulk_import_item` | 新表（1 迁移） | 批量导入任务/逐项状态/错误原因/凭证指纹 HMAC |
| `provider_account_cost` | 新表（同上迁移或独立） | 账号成本台账：价格、周期、起止、来源 |
| 账号状态 `banned`/`depleted` | 优先复用现有 status 文本域 + 元数据字段；若现有 CHECK 受限则 1 迁移放宽 | 参考迁移 134 provenance CHECK 放宽先例 |
| 权利证据 `operator_assertion` | 复用 rights 表现有证据字段（自由文本/JSON），登记新 evidence kind 常量 | 目标零迁移 |
| 用户级限额配置 | settings/租户配置现有通道 | 目标零迁移 |
| console feature flag | settings 现有通道 | 目标零迁移 |
| 滥用风险标记 | 复用 risk 现有表/事件通道，不足再评估 | 目标零迁移 |

## 10. 实施分期与验收

### 10.1 前置欠账（开工前或并行清偿）

- **R8 Codex 可售**：可信全 I/O 计费边界 + cap 强制证明——收费的必要条件，阻塞 M1 验收。
- **R7 云恢复**：钱包与账号池数据的生产级恢复，阻塞灰度（M3）。
- **四家真实 OAuth smoke**（导入→自动验证→调度可用）：M0 验收的真实凭证部分。

### 10.2 分期

| 期 | 内容 | 出口验收 |
|---|---|---|
| **M0 供给打通** | §4.2 批量导入 + §4.3 权利解绑 + 开放注册部署配置 | 批量导入 100 账号验收（§4.2）；四家真实 OAuth smoke；注册 open 模式 E2E |
| **M1 收费闭环** | §5 充值/定价展示 + §6 个人门户动线 + R8 计费边界证明 | 新用户注册→充值→建 Key→真实调用→余额正确扣减→订单/用量/账本三处一致；余额不足稳定拒绝；R8 验收通过 |
| **M2 账号运营** | §4.4 封禁处置 + §4.5 配额窗调度 + §4.6 成本台账 | 耗尽隔离/reset 回归/粘性验收（§4.5）；封禁自动下架+补号告警演练；COGS 报表数字与账本可核对 |
| **M3 风控与灰度** | §7 全部 + §6.4 客户端体验 + R7 恢复演练 | 滥用处置矩阵（限速/暂停/封禁/撤销）全通过；教程 5 分钟首调 E2E；恢复演练账务一致；小流量真实付费灰度 |

M0/M1 必须串行；M2 的 §4.5 与 §4.6 可并行子任务；M3 的客户端体验可提前与 M1 并行。

### 10.3 测试策略

- 每模块 node:test 单测 + PG15/18 双版本迁移/权限验收（现有 CI 矩阵纪律）。
- 关键链路 E2E：注册-充值-消费-对账全链（fake PSP + mock 上游先行，真实 PSP/真实账号灰度前必做）。
- 账务不变量测试：任何新路径（封禁退款、批量导入失败回滚）的资金平衡断言。
- 性能：M1 后补一轮安静窗口基线（现有 R4 门禁纪律），账号运营层不得向热路径引入超过现有 30/10ms 门槛的同步开销（成本台账/封禁检测一律异步）。

## 11. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 批量导入引入坏账号池 | 探针验证通过才 active；坏账号自动隔离 | 按导入任务批量下架（job 维度反向操作） |
| 配额窗调度误判导致集中烧号 | 策略可配置回退 round_robin；快照陈旧即停止门控 | settings 切回，无需发版 |
| 个人门户收纳破坏企业功能 | feature flag 只藏不删；企业语义全保留 | 关 flag 即恢复 |
| 滥用处置误伤正常用户 | 阶梯处置 + 全审计 + 可撤销 | 撤销即恢复（Key 除外，需用户重建） |
| 账务回归 | 不变量测试进 CI 必需门禁 | 阻断发布，不带病上线 |

## 12. 边界声明

- 本文是设计稿：除 §2.1 所列已核实现状外，其余均为待实现内容，不代表任何能力已交付。
- 现有 R4/R5/R6 性能门禁、R7 云恢复、R8 Codex 可售的开放状态不因本方案改变。
- 账号供给方式放开是需求方明确的经营决策；本方案仅提供技术手段与审计留痕，不构成对上游条款风险的评估。
