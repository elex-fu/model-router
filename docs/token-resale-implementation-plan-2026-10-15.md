# token 外销(订阅转售 + token 分销)实施技术方案 — 2026-10-15

## Context

目标:对标 **sub2api**(订阅账号转售)与 **new-api**(token 分销)做 token 外销,两种能力都要。前序评估(`sub2api-parity-upgrade-plan-2026-10-15.md` 收尾后的差距分析)已确认:model-router 的工程基座(事务/幂等/审计/密封凭证/最小权限角色/钱包账本/四支付渠道)已超过两个参照系,差距集中在 **供给品类、商业模型、抗封生存线** 三块。

本文档依据三路代码级勘察撰写:
- **sub2api**(`~/play/sub2api`,Go):出口代理、分组模型、Claude 转售黑盒常量、并发槽、调度四级过滤、测活
- **new-api**(QuantumNous/new-api@main,Go):分组倍率计费公式(代码级精确)、渠道 abilities/AutoBan、注册准入、预扣-结算-退款三段式、充值分组倍率
- **model-router 现状接线点**:计费/传输/调度/控制台的最小侵入位置(全部带文件:行号,见各阶段)

**实施顺序**(用户拍板,双路线并集;R5b 于 2026-10-15 由 R8a 提升为正式阶段,R0 为开工前置):

```
R0 存量 CI 缺陷修复(前置)     — lifecycle 门禁 + saas-workspace 浏览器 E2E,回归信号保真
R1 分组倍率(商业骨架)        — new-api 计费内核 + sub2api 三层分组
R2 embeddings 端点           — 全品类的第一步,桥接工作量最小
R3 出口代理(生存线)          — per-account egress proxy + 探测 + 过期迁移
R4 注册准入(开卖前提)        — 公开注册 + 邮箱验证码 + Turnstile + 注册开关
R5 Claude 订阅池(核心品类)   — oauth-subscription 共享层提取 + Claude 品类包
R5b OpenCode Go 订阅池        — API key 品类 + 多协议自适应路由(复用 R5 共享层)
R6 主动测活 + Redis 热状态   — 手动/定时探测 + 并发槽 ZSET + 粘性快路径
R7 调度策略丰富化            — 成本/soonest-reset/LRU 维度
R8 OpenRouter 兜底 + Gemini  — 按量 overflow 渠道 + 同模板第三品类(后续)
R9 P5 性能/混沌基准          — 需 Docker 环境
```

**红线继承**:PG 权威/Redis 缓存协调;密封凭证不降级为明文(代理口令同样密封);密钥不落代码(CLAUDE.md 安全约束);fail-closed 语义不破;倍率/计费全部走有理数,禁止 float;消费日志必须携带计费时刻的倍率快照(new-api 对账教训)。

---

## R0 — 存量 CI 缺陷修复(开工前置)

**为什么必须先修**:R1–R7 全部以 CI 回归信号为准绳;两项存量缺陷使仓库自 09-29 起无绿色基线(CI 运行 38675903183 证实),不修则后续每个阶段的"全绿"结论都无法成立。两项均已在 P5 e2e 中定性为存量(与 P 系列提交无关),溯源链完整,见 `docs/test-cases-sub2api-parity-2026-10-15.md` 遗留问题 1/2。

### R0-1 validation-worker-lifecycle 门禁(任务 #19)

**症状**:"the second claim must belong to the same real CLI worker backend" —— 第二次阻塞 claim 来自不同 backend PID,即 worker 在等待 `ACCESS EXCLUSIVE` 锁期间连接断开并重连。CI PG15+PG18 双矩阵相同断言失败,与本机 PG18.6 逐字一致;测试文件自 0068796 未改动。

**排查方向**:worker 连接保活/重连逻辑——锁等待超过某阈值后 socket 被对端或中间层回收,客户端库自动重连产生新 backend PID;测试断言"同一会话内两次 claim 属于同一 backend"因此失败。修法二选一(以排查结论为准):① worker 侧修保活(keepalive/锁等待期间禁止重连);② 若重连是设计内行为,则修测试断言为逻辑等价表述(claim 的业务身份而非 backend PID)。

**验收**:该门在 PG15+PG18 本地复刻电池与 CI 双绿。

### R0-2 saas-workspace 浏览器 E2E 台账(任务 #20)

**症状**:`tests/e2e/saas-workspace.spec.ts:122/172/198` 严格请求台账断言意外出现 `GET /console/api/v1/tenants/…/announcements`。

**根因**(已确证):announcements 拉取由 e98ef9b(2026-10-12)加入 `web/src/features/saas-console.tsx`,而 spec(9f5c1c6,2026-10-04)台账期望从未同步——spec 全文无一处 `announcements`。确定性失败,与环境无关。

**修法**:更新 spec 台账期望纳入 announcements 拉取(按现行 console 行为);若评审认为 announcements 不应在登录首屏急切拉取,则改为惰性加载并同步台账——以 console 功能意图为准,默认前者(对齐实现与测试)。

**验收**:CI build-and-test 浏览器 E2E 全绿;台账与实现再次漂移的防护(在 spec 头注释标注台账维护责任)。

---

## R1 — 分组倍率(商业骨架)

### 勘察结论

**new-api 计费内核**(代码级精确):
- 三级倍率:`GroupRatio[usingGroup]`,若 `GroupGroupRatio[userGroup][usingGroup]` 命中则取而代之;模型倍率 `modelRatio`(ratio 1 = $0.002/1K tokens)、补全倍率 `completionRatio`、缓存倍率(cache hit 0.1/0.25/0.5,cache write 1.25/5m/1h 分档)。
- 预扣:`preConsumed = (promptTokens + maxTokens) × preConsumeMultiplier × modelRatio × groupRatio`;按次制:`modelPrice × QuotaPerUnit × groupRatio × otherRatios`。
- 结算(十进制):`quota = (baseTokens + cachedTokens×cacheRatio + cacheWrite×createRatio + completion×completionRatio) × (modelRatio × groupRatio)`;ratio≠0 且 quota==0 时保底 1。
- 三段式:BillingSession `preConsume → settle(delta 补扣/退回) → refund(失败全退,幂等)`;信任额度(used < $10 免预扣,订阅永不信任)。
- **第二杠杆**:充值分组倍率 `topupGroupRatio`(与计费倍率独立),"用得贵 × 充得便宜"组合出毛利;`payMoney = amountUSD × Price × TopupGroupRatio[group] × AmountDiscount[amount]`。
- **对账底线**:消费日志冗余保存计费时刻的 group_ratio/model_ratio/completion_ratio 快照,事后改倍率不回溯历史。

**sub2api 三层分组**:
- `groups` 表:rate_multiplier、高峰加价(peak 时段+倍率)、daily/weekly/monthly limit、`model_pricing` JSONB(组级按模型定价,优先级最高)、rpm_limit、profit_control(min margin + safety buffer,用户价 ≤ 成本×(1−margin−buffer) 时拒绝)、接入控制(claude_code_only/fallback_group/model_routing/supported_model_scopes)。
- `account_groups` M2M:`(account_id, group_id, priority)`——同一账号在不同用户组里以不同优先级参与调度(高价买稳池的实现基础)。
- `api_keys.group_id`:key 挂组;定价解析优先级:组级 model_pricing > 渠道价 > 内建价。
- 计费公式:`max(0, baseCost × group.rate_multiplier × 高峰倍率 × 渠道分时 × effort倍率)`。

**model-router 现状**(勘察事实):
- 价格身份 `PricingIdentity = {publicModelId, version, providerId, productId, protocol, endpoint, currency}`(`src/saas/pricing/service.ts:355`),**无租户/分组维度**;费率按 6 metric 有理数存储。
- hold:`hold-calculator.ts:136 calculateConservativePriceHold`(纯函数,全 input 上界分配到最贵桶);结算:`dispatch-usage-settlement.ts:172 calculatePriceVersion` + `assertPriceIdentity`(128)逐字段比对。
- 快照:`createCustomerPriceSnapshot`(service.ts:1311)把价格行的 policy/calculator/rounding 版本与 hold 逐项复制进快照行——**天然是倍率快照的挂载点**。
- key 五维策略已有(modelScopes/IP/预算/过期/状态),无分组字段;租户侧只有 plans 订阅。

### 设计

**数据模型(迁移 104 `104_billing_groups.ts`)**:

```
saas_billing_groups(
  id text PK,                              -- 'default'/'vip'/'svip'/自定义
  display_name text NOT NULL,
  rate_multiplier_num/den bigint NOT NULL DEFAULT 1/1,     -- 计费倍率(有理数)
  topup_multiplier_num/den bigint NOT NULL DEFAULT 1/1,    -- 充值倍率(第二杠杆)
  peak_enabled boolean, peak_start/peak_end time,          -- 高峰加价(sub2api)
  peak_multiplier_num/den bigint,
  model_pricing jsonb,                     -- 组级按模型定价覆盖,优先级最高
  rpm_limit int, daily/weekly/monthly_limit_minor_units bigint,
  profit_min_margin_num/den bigint, profit_safety_buffer_num/den bigint,
  claude_code_only boolean NOT NULL DEFAULT false,
  fallback_group_id text REFERENCES saas_billing_groups,
  supported_model_scopes text[],
  status text NOT NULL DEFAULT 'active',
  created_at/updated_at timestamptz
)

saas_billing_group_account_pools(          -- sub2api account_groups M2M
  group_id text REFERENCES saas_billing_groups,
  account_id uuid REFERENCES saas_provider_accounts,
  priority int NOT NULL DEFAULT 50,        -- per-group 优先级,小=高
  PRIMARY KEY (group_id, account_id)
)

ALTER TABLE saas_keys ADD billing_group_id text REFERENCES saas_billing_groups DEFAULT 'default';
ALTER TABLE saas_tenants ADD default_billing_group_id text REFERENCES saas_billing_groups DEFAULT 'default';
```

- 不改 `PricingIdentity`(避免动价格血缘锁与既有 UNIQUE 索引);倍率作为**价格行之外的外层乘数**挂在快照上:`saas_request_customer_price_snapshots` 加 `billing_group_id / rate_multiplier_num/den / peak_applied / model_pricing_override_digest` 列——消费时刻倍率快照,对账可回溯(new-api 教训)。
- 授权语义:billing_group 影响调度候选(account pool 绑定)→ 变更必须 bump key 的 `authzVersion`(沿用 047/082 失效模式)。

**计费插入点**(最小侵入,勘察已定位):

1. `postgres-request-admission-guard.ts:1452` 在 `resolveCustomerPriceVersion` 后:按 `key.billing_group_id`(缺失回落 tenant 默认组)解析组 → 组级 `model_pricing` 覆盖命中则替换价格行(仍走 `createCustomerPriceSnapshot`,快照记录覆盖 digest)→ 把 `groupMultiplier` 传给 hold 计算。
2. `hold-calculator.ts:136`:`calculateConservativePriceHold` 出参前乘 `groupMultiplier`(有理数乘,纯函数外层包,不改内部逻辑);高峰时段判定在 admission 做(请求时刻),结果 `peak_applied` 写入快照。
3. `dispatch-usage-settlement.ts:172`:`calculatePriceVersion` 结果乘同一快照倍率(从快照读,不重查组表——**结算必须用 admission 时刻的倍率**,改组不回溯);`assertPriceIdentity` 扩展比对快照倍率字段。
4. profit_control:结算前校验 `customerCharge ≤ supplierCost × (1 − margin − buffer)` 时拒绝并告警(sub2api 规则);供应商成本已从 `saas_supplier_cost_versions` 在链路里(candidate 带 supplierCostVersion)。
5. 充值侧:`payments/checkout.ts` 实付金额换算钱包额度时乘 `topup_multiplier` + 档位折扣表(新 settings 键);钱包 `postVerifiedFunding` 钩子记录倍率。

**控制台**:
- 平台侧:`saas-platform.tsx` 加 `/platform/billing/groups` 页(复用 pricing 页的 CatalogPage 模式):组 CRUD、倍率编辑、账号池绑定(per-group priority)、组级 model_pricing JSON 编辑器。
- 客户侧:keys 创建表单(`keys.tsx`)加组选择(限 tenant 可用组);钱包页显示所在组与充值倍率。

**测试**:
- 单测:倍率合成(组×高峰×模型覆盖优先级)、profit_control 边界、快照倍率冻结(改组后旧快照结算不变)。
- PG 门禁:迁移 104 + 授权镜像 + hold/结算倍率一致性(admission 快照 vs 结算读取)。

---

## R2 — embeddings 端点

### 勘察结论

- new-api:`Path2RelayMode` 由 URL 推导计费/适配模式;embeddings/rerank/transcription 走与 chat 同一套 `calculateTextQuotaSummary`(token 制,必须有 ModelRatio)——**永远不要在端点 handler 里各写一套 quota 数学**。
- sub2api:`/v1/embeddings` 仅 OpenAI 平台,其他平台 404(平台能力矩阵门控);计费模型 ≠ 请求模型,先经账号映射解析再查价;usage 取 `usage.prompt_tokens/total_tokens`。
- model-router 接线点(勘察已定位,5 处):`http-handler.ts:33 ROUTES`、json-usage-observer 分派表、`ProviderUsageUpperBoundEstimator` 变体(output=0)、价格表复用 input 费率、`contracts.ts GatewayProtocol` union。

### 设计

1. **路由**:`http-handler.ts:33` 加 `['/v1/embeddings', 'openai']`;上游仅对 openai 协议族 provider 开放,其他 provider 请求 embeddings → 404 `CAPABILITY_UNSUPPORTED`(能力矩阵挂在 catalog rights 上)。
2. **usage**:`provider-json-usage-observer.ts:64` 分派表加 `(openai, embeddings)` → `NormalizedUsage{input: usage.prompt_tokens ?? total_tokens, output: 0}`;非流式 JSON,无 SSE 改动。
3. **hold**:注入 embeddings 变体估计器 `{inputUpperBound: 文本 token 估算(字符数/4 上界), outputUpperBound: 0, feasibleInputBuckets: ['input']}`;价格行 output 费率填 0(不扩 PRICE_METRICS,避免迁移价格表)。
4. **桥接**:a→o 桥无需改动(客户端 OpenAI 协议入站);Anthropic 客户端不支持 embeddings(协议无此概念),不桥。
5. **proxy.ts(旧 BYOK 面)**:`clientProtocolFromPath:212` 加分支 + 上游路径映射——仅当 upstream 声明支持时 passthrough。
6. **计费模型解析**:经 modelMap 解析后再查价(sub2api 规则),快照记录 requested vs resolved。

**测试**:usage 解析单测、hold 上界单测、集成(mock 上游 embeddings 全链:admission→hold→forward→usage→结算)、能力矩阵 404 负向。

---

## R3 — 出口代理(生存线)

### 勘察结论

**sub2api 完整模型**:
- `proxies` 独立表(name/protocol/host/port/username/password/status/expires_at/`fallback_mode(none|proxy|direct)`/backup_proxy_id/expiry_warn_days),账号 `proxy_id` 外键 + `proxy_fallback_origin_id`(过期迁移后人工回退)。
- 协议白名单 `{http, https, socks5, socks5h}`;socks5 自动升级 socks5h(远端 DNS 防污染);空=直连;非法=报错不降级;错误信息绝不回显代理凭据。
- **三路共用同代理**:转发、OAuth 刷新(req.C().ImpersonateChrome + SetProxyURL)、手动测活。client 按 `accountID+proxyURL` 缓存(LRU 5000,900s 空闲 TTL)。
- 探测:probe service 经代理本身请求 `ip-api.com/json` + `api64.ipify.org`(10s/1MB 上限),产出 `{success, latency_ms, ip, country, quality_score/grade}`;Redis `proxy:latency:{id}` 缓存。
- 过期清扫:ticker `SweepExpiredProxies` 按 fallback_mode 把账号迁离过期代理。

**model-router 接线点**(勘察已定位):
- `provider-http-address.ts:281 createPinnedProviderHttpConnector` 现构造 pinned `new Agent({connect:{lookup}, connections:1, maxRedirections:0})`——改为按 `proxy?` 入参构造 `new ProxyAgent({uri, connect:{lookup: pinned}})`(undici ProxyAgent 支持 connect 覆盖,保持"每请求短生命周期 dispatcher"语义);SSRF 白名单 `isGlobalProviderAddress` 对代理主机同样生效。
- `ProviderHttpConnectorInput`(address.ts:26)加可选 `proxy?: {url}`;账号→代理映射经 `resolveDispatchProfile`(transport.ts:61,已是 per-account 解析点)注入。
- codex/transport.ts 的 fetch 签名(260)无 dispatcher,需对齐到 `ProviderHttpFetch` 形状。
- OAuth 刷新 worker(`oauth-token-refresh-worker.ts`)的 fetch 同样需 per-account 代理——绑号/刷新/请求三路同出口(否则 IP 不一致触发风控,sub2api 核心教训)。

### 设计

**数据模型(迁移 105 `105_egress_proxies.ts`)**:

```
saas_egress_proxies(
  id uuid PK, name text UNIQUE,
  protocol text CHECK (protocol IN ('http','https','socks5','socks5h')),
  host text, port int,
  auth_sealed_envelope jsonb,        -- 口令走既有 KMS 密封(红线:不明文)
  status text DEFAULT 'active',
  expires_at timestamptz,
  fallback_mode text CHECK (fallback_mode IN ('none','proxy','direct')) DEFAULT 'none',
  backup_proxy_id uuid REFERENCES saas_egress_proxies,
  last_probe_at timestamptz, last_probe_latency_ms int, last_probe_ip inet,
  last_probe_quality text,           -- ok/degraded/dead
  created_at/updated_at
)
ALTER TABLE saas_provider_accounts
  ADD egress_proxy_id uuid REFERENCES saas_egress_proxies,
  ADD proxy_fallback_origin_id uuid REFERENCES saas_egress_proxies;
```

**实现**:
1. **代理 URL 装配**:代理记录 → `protocol://[user:pass@]host:port`(口令从密封信封运行时解封,解封走 credential KMS 的同一审计路径);socks5 → socks5h 升级;URL 永不进日志(redactSecrets 扩展代理模式)。
2. **dispatcher 工厂**:`createPinnedProviderHttpConnector` 加 proxy 分支(ProxyAgent + pinned lookup + connections:1);socks5 用 undici 不原生支持 → 引入 `undici` 的 socks 连接器或 `socks-proxy-agent` 等价物(评估依赖:socks5h 远端 DNS 语义必须保证,否则退 http 代理建议)。
3. **三路接线**:① 转发:`resolveDispatchProfile` 返回体加 `egressProxy`,transport/codex-transport 传入工厂;② OAuth 刷新:R4 worker 的绑定刷新 fetch 走同一工厂(账号级);③ 测活(R6)同工厂。
4. **探测 worker**:`src/saas/supply/egress-proxy-probe-worker.ts`(leader 锁,SKIP LOCKED 既有模式):经代理请求双探针 URL(可配),写 `last_probe_*` + Redis 缓存;质量 dead 的代理账号在调度中降权(eligibility 信号,不硬剔除——避免代理抖动引发大迁移)。
5. **过期清扫**:同 worker 内 sweep:代理 expires_at 过 → 按 fallback_mode 迁移账号(none=报错告警/proxy=迁 backup/direct=直连),记录 `proxy_fallback_origin_id`,审计事件。

**测试**:协议白名单/凭据脱敏单测;ProxyAgent 注入单测(mock 代理断言请求经隧道);三路一致性集成(转发/刷新/测活取同一代理记录);过期迁移门禁。

---

## R4 — 注册准入(开卖前提)

### 勘察结论

**sub2api 规则**:6 位数字码/crypto-rand/TTL 15min/冷却 60s/最多 5 次尝试/常量时间比较/`verify_code:{lowercase email}`(Redis);校验顺序:注册开关 → 邀请码(若开启)→ Turnstile → 邮箱验证码 → 原子创建+核销;`registration_enabled` 总开关;CaptchaProof 抽象(Turnstile/腾讯双后端,secret 存 settings)。

**new-api 规则**:验证码 TTL 10min、purpose 前缀隔离、验证后立即失效;发送限流按 IP 2 次/30s(Redis 固定窗口,内存兜底);Turnstile `challenges.cloudflare.com/turnstile/v0/siteverify`(secret/response/remoteip);邀请奖励三段(注册即送/填码者/码主),aff 额度转余额设最小阈值防刷。

**model-router 现状**(勘察事实):
- **无公开注册入口**——密码注册不存在,只有 bootstrap/邀请接受/OAuth 三条路径;`saas_users.email_verified_at` 字段已存在但三处 INSERT 全写 NULL,**纯增量可回填**。
- SMTP 缺失:只有 `AlertEmailSender` 接口(alerts.ts:416,默认 console 实现);无 nodemailer 依赖。
- affiliate 绑定发生在登录后控制台(affiliate-http.ts:49),不在注册路径。
- rate limit 有 `enforceRateLimit` Redis 固定窗口模式(oauth-login-http.ts:228)可复用。

### 设计

**迁移 106 `106_registration_admission.ts`**:
```
saas_email_verification_codes(
  id uuid PK, email_canonical text NOT NULL,
  purpose text CHECK (purpose IN ('register','password_reset')),
  code_hash text NOT NULL,               -- sha256,不存明文
  attempts int DEFAULT 0, expires_at timestamptz, consumed_at timestamptz,
  created_ip inet, created_at
)
-- settings 键(走既有 settings 服务,不进迁移):registration_mode(open|invite|closed)、
--   email_verification_required、turnstile_enabled/site_key/secret(密封)、
--   smtp_host/port/username/password(密封)/from、email_domain_allowlist/denylist
```

**实现**:
1. **SMTP provider**:`src/saas/identity/email-sender.ts` 实现 `AlertEmailSender` 同形接口(nodemailer 或裸 net/tls SMTP 客户端——评估依赖体积);配置走 `runtime/providers.ts` 动态加载模式(参照 RedisProvider 环境变量);口令密封。
2. **验证码服务**:`email-verification-service.ts`:6 位数字(sub2api)/TTL 15min/冷却 60s(发送键 `verify_sent:{email}`)/attempts ≤5/常量时间比较 hash;发送限流按 IP 2 次/30s(`enforceRateLimit` 复用);**PG 表为准**(多实例安全),Redis 只做冷却/限流快路径。
3. **公开注册路由**:`POST /console/api/v1/auth/register`(仿 oauth-login-http.ts 分发):校验顺序 注册开关 → 域名黑白名单 → Turnstile → 邮箱验证码 → 创建用户(email_verified_at 回填)+ 原子核销邀请码;注册 body 携带 `inviteCode` → 同步完成 affiliate 绑定(迁移注册后绑定到注册路径,三段奖励:注册即送/填码者/码主,走钱包 postVerifiedFunding,最小转换阈值防刷)。
4. **Turnstile**:`turnstile-service.ts`:`VerifyToken(token, remoteIP)` → siteverify POST;`CaptchaProof` 归一抽象(预留腾讯验证码);开关关闭时直接放行(sub2api 语义);挂在 register/login/password-reset 三处。
5. **密码重置**:同验证码服务 purpose='password_reset',TTL 30min 令牌。
6. **控制台 UI**:`auth.tsx` 加 `Register` 组件(挂 saas-console.tsx 未认证分支)+ Turnstile widget + 邀请码输入;登录页加"忘记密码"。

**测试**:验证码全生命周期单测(TTL/attempts/常量时间/一次性);注册顺序矩阵单测(开关×域名×turnstile×码);PG 门禁(并发注册同邮箱唯一性);affiliate 注册路径绑定集成。

---

## R5 — Claude 订阅池(核心品类)

### 勘察结论(sub2api 黑盒实证,全部可移植)

**OAuth 常量**:client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`;authorize `https://claude.com/cai/oauth/authorize`;token `https://platform.claude.com/v1/oauth/token`;redirect `https://platform.claude.com/oauth/code/callback`;scope 三档(含 `user:inference`);PKCE S256;TokenResponse 带 `organization.uuid` + `account{uuid,email}`。

**伪装(mimicry)——缺任何"官方 CLI 才带"的 beta 会被降级第三方额度**:
- Beta 头完整有序集合:`oauth-2025-04-20, claude-code-20250219, interleaved-thinking-2025-05-14, fine-grained-tool-streaming-2025-05-14, token-counting-2024-11-01, context-1m-2025-08-07, prompt-caching-scope-2026-01-05, effort-2025-11-24, context-management-2025-06-27, extended-cache-ttl-2025-04-11`(`server-side-fallback-*` 永不自动加);分场景变体(Default/APIKey/Haiku/Message/CountTokens)。
- UA `claude-cli/{version}`(version 可 env 覆盖,跟踪 CLI release);x-stainless 头族(lang js / package-version 0.94.0 / os linux / arch arm64 / runtime node / runtime-version / retry-count 0 / timeout 600)、x-app: cli、anthropic-dangerous-direct-browser-access: true。
- **billing 指纹块**:`fp = hex(SHA256("59cf53e54c78" + firstUserText[4,7,20](补'0') + cliVersion))[:3]`;system 首块 `x-anthropic-billing-header: cc_version={ver}.{fp}; cc_entrypoint=cli;`——与真实 CLI 逐字节一致。
- **system 三块重写**:[billing 块, "You are Claude Code…" 身份块, expansion 块(cache_control ephemeral/5m)];客户端原 system 降级为 messages 里的 user `[System Instructions]\n…` + assistant ack;第三方身份文案(OpenCode 等)消毒为 Claude Code banner;Fable 模型只 2 块。
- 请求体:temperature 默认 1、max_tokens 默认 128000、metadata.user_id 注入、thinking 开启时默认 `context_management={"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`、无 tools 丢弃 tool_choice、**cache_control ≤4 块**(超限剥离顺序 tools→messages→system,thinking 块上必删)、模型 ID 日期化覆盖(sonnet-4-5→…20250929 等映射表)。

**配额窗口**:`GET https://api.anthropic.com/api/oauth/usage`(Bearer + `anthropic-beta: oauth-2025-04-20`,UA `claude-code/x.y`)→ `{five_hour{utilization,resets_at}, seven_day{...}, seven_day_sonnet{...}, seven_day_overage_included}`;429 分类:`anthropic-ratelimit-unified-{5h,7d,7d_oi}-{status,reset,utilization}` + 聚合 reset → 找触发窗口写 `rate_limit_reset_at` + 会话窗口 [reset−5h, reset];无 reset 走可配短冷却。

**刷新**:exp−3min 触发;分布式锁 `oauth:refresh_lock:{account}` 30s;失败缓存 1min 防雪崩;UA `axios/1.13.6`;ImpersonateChrome TLS 指纹;走账号代理(R3)。

**model-router 复用度**(勘察结论):codex 层的 `health.ts`(错误分类法品类无关)、quota-pause 决策(参数化窗口/阈值)、transport 骨架(钉 host/凭证注入/SSE drain)、PKCE+id_token 工具、binding-service/supply-sink 框架可直接提取;品类特有的只有 catalog-identity、常量、transform/payload/response-bridge、import 解析。

### 设计

**第一步:提取共享层 `src/saas/gateway/oauth-subscription/`**(不改 codex 行为,纯重构):
```
identity-namespace.ts    -- isolateSessionId/deriveStableUUIDv4 参数化命名空间前缀
health-classifier.ts     -- classifyUpstreamError/shouldFailover(直接搬 codex/health.ts)
quota-pause.ts           -- QuotaPauseDecision 参数化(窗口/阈值/陈旧守卫)
transport-skeleton.ts    -- 钉 host + 凭证回调 + SSE drain + quota 快照节流写
pkce.ts                  -- createPkcePair/buildAuthorizeUrl/id_token claims 解析(不验签,exp±120s)
```
codex 包改为从此层导入(回归测试:现有 47+59 例 codex 测试零改动通过)。

**第二步:Claude 品类包**:
```
src/saas/gateway/claude/
  catalog-identity.ts    -- provider/product/credentialType/endpoint(api.anthropic.com/v1/messages)
  constants.ts           -- 上述 beta 集合/UA/stainless 头/模型 ID 映射/fingerprintSalt
  identity.ts            -- CLI version 解析(env 覆盖)+ 指纹派生(共享层)
  transform.ts           -- system 三块重写/消毒/温度与 max_tokens 默认/cache_control≤4/metadata 注入
  billing-fingerprint.ts -- cc_version/cc_entrypoint 指纹块(SHA256 算法)
  quota-usage.ts         -- /api/oauth/usage 拉取 + 5h/7d/7d_sonnet/7d_oi 快照
  quota-headers.ts       -- anthropic-ratelimit-unified-* 429 分类 → rate_limit_reset_at
  response-bridge.ts     -- Messages↔chat.completions/Responses SSE 桥(复用 src/protocol 既有 a↔o 知识)
  transport.ts           -- 共享骨架 + Bearer/x-api-key 双凭证形态 + anthropic-version/beta 头
src/saas/platform/claude-oauth/
  oauth.ts               -- 常量/PKCE/组织解析(/api/organizations)
  binding-service.ts     -- 绑号会话(30min TTL,state 一次性)
  import.ts              -- ~/.claude/.credentials.json 解析导入
  http.ts / supply-sink.ts(共享层)
```

**第三步:刷新与调度接线**:
- R4 worker 注册 claude 刷新绑定(token endpoint/UA/代理出口);invalid_grant 竞态恢复沿用既有 `replaceProviderCredentialSecretWithAudit` 路径。
- **迁移 100**(099 头注释明示为本族预留):账号表加 claude 调度列——`claude_5h_utilization/reset_at, claude_7d_utilization/reset_at, claude_7d_sonnet_*, claude_7d_oi_*, claude_usage_updated_at, claude_session_window_start/end, claude_cli_version_override`(scheduling-signal-only 语义,沿用 093/099 先例)。
- 调度信号:utilization ≥ auto_pause 阈值 → 跳过;429 快照 → rate_limited_until;沿用 099 列风格。

**第四步:客户端真伪校验(可选,转售风控)**:
- `claude_code_validator.ts` 等价物:UA 正则 `^claude-cli/\d+\.\d+\.\d+`、system prompt 相似度(≥0.5)、billing 头识别;与 R1 的 `claude_code_only` 组联动——非 Claude Code 流量路由到 fallback_group(分销面),真 Claude Code 流量才进订阅池(防第三方客户端特征烧号)。

**测试**:
- 单测:transform 全规则矩阵(三块重写/消毒/cache_control 剥离顺序)、指纹块确定性(与 sub2api 算法对拍)、429 窗口分类、usage 解析。
- 集成:mock api.anthropic.com(SSE 回放真实样本):绑号/刷新/请求/流/usage/配额头/failover 全链,PG 门禁。
- live 冒烟:`tests/integration/claude-live.test.ts`(env 门禁,需测试账号)。

---

## R5b — OpenCode Go 订阅池(API key 品类 + 多协议自适应路由)

> 2026-10-15 由 R8a 提升为正式阶段。定位:接入成本全品类最低的订阅转售品类,且是平台"同一账号按模型分协议"能力的载体。排在 R5 之后(复用其共享层与品类包模板),R6 之前(探针框架为其注册品类)。

### 勘察结论(sub2api `opencode_go` 平台,代码级)

OpenCode Go 是 OpenCode Zen 的订阅网关转售——**纯 API key 供给**(`AccountTypeAPIKey`,账号 credentials 存官方订阅 key,无 OAuth/伪装),同一 key 按模型分流 Responses / Chat Completions / Anthropic Messages 三种原生端点;配额窗口 rolling 5h / weekly / monthly,经 `GET https://opencode.ai/zen/go/v1/usage`(Bearer key)拉取;leader-locked usage worker(默认 15min 间隔、5min 硬下限、debounce 1min、singleflight、每轮 ≤20 账号、并发 4、leader lock TTL 2min);协议路由表 `protocol_rules`(pattern→protocol,精确 ID 或后缀 glob,first-match-wins,≤64 条,内建 `grok-*`→Responses 等默认表);模型 ID 规范化剥 `opencode-go/`、`opencode_go/`、`opencode/` 前缀;fallback 模型目录 ~30 个(GLM/Kimi/DeepSeek/Qwen/LongCat/MiniMax/MiMo/Grok);默认测活模型 `glm-5.3`(Chat Completions 目录 ID);平台枚举在 group_handler 注册(`anthropic openai gemini antigravity grok kimi zhipu deepseek minimax opencode_go composite`)。

### 任务拆解(全部复用既有框架,零新基础设施)

| 任务 | 内容 | 依赖 |
|---|---|---|
| **R5b-1** catalog 注册 + 模型目录(#21) | `opencode-go` provider 注册(同 `codex-registration.ts` 模式):endpoint 钉 `https://opencode.ai/zen/go`;凭证形态 = 平台池 API key(既有密封信封,无 OAuth 扩展);fallback 模型目录内置;模型 ID 前缀规范化 | —(R0 完成后开工) |
| **R5b-2** protocol_rules 多协议路由(#22) | provider 配置 `protocol_rules`(pattern→protocol,精确 ID 或后缀 glob,first-match-wins,≤64 条,内建默认表,管理面可编辑);dispatch 按解析后模型名 first-match 选 signed endpoint → 既有 per-endpoint payload 编译接管(三协议下行 P1c 已通);规则表变更 bump authzVersion(047/082 模式) | R5b-1 |
| **R5b-3** 配额快照 worker(#23) | `src/saas/supply/opencode-go-usage-worker.ts`:leader 锁 SKIP LOCKED;15min/5min 下限/debounce/singleflight/每轮 ≤20/并发 4/lock TTL 2min;拉 `/usage` 写账号快照列(rolling_5h/weekly/monthly used+reset,scheduling-signal-only);429/窗口用尽 → `rate_limited_until` 精确冷却 | R5b-1 |
| **R5b-4** 目录同步 + 测活注册(#24) | `/v1/models` 上游同步(1min TTL/5min stale,同 codex 目录机制),fallback 兜底;规范化进 modelMap;R6 探针框架注册 opencode-go 品类(默认 glm-5.3,Chat Completions 端点;R6 未动工前先在注册表占位) | R5b-1, R5b-2 |
| **R5b-5** 迁移 108 + 授权镜像(#25) | `108_provider_account_opencode_go_scheduling.ts`:账号表配额快照列 + provider `protocol_rules` 列;同步 `deploy/managed-saas-postgres-roles.sql` + `runtime-privileges.ts` + 镜像测试(P3 教训:授权与迁移同提交) | R5b-2, R5b-3 |
| **R5b-6** 测试 + 证据(#26) | 单测(规则匹配/glob/上限/默认表、ID 规范化、usage 解析、窗口→冷却映射);PG 门禁(迁移 108 + 授权 + 快照写入);集成(mock `opencode.ai/zen/go` 三端点:key→协议分流→转发→usage→配额暂停全链);progress 登记 + 测试用例文档 | R5b-2~5 |

### 设计要点

1. **与 R5 的关系**:R5b 不需要 oauth-subscription 共享层的 OAuth/PKCE 部分,但复用其 `health-classifier`/`quota-pause`/transport 骨架(钉 host + 凭证注入 + SSE drain + 快照节流写)——若 R5 尚未动工,R5b 可按 codex 包同构方式先落地,待 R5 提取共享层时一并归并(不阻塞)。
2. **protocol_rules 是唯一新机制**:规则表挂 provider 配置(JSONB),不进 PricingIdentity;解析发生在 modelMap 之后、endpoint 签名之前;规则变更 = 调度输入变更 → bump authzVersion。
3. **配额窗口三维**:rolling_5h/weekly/monthly 各自 used+reset,调度信号语义与 099/100 列完全一致;窗口用尽写 `rate_limited_until`(reset 时刻精确冷却),不写死 error。
4. **计费**:上游订阅成本≈0,R7 成本优先调度自然让 opencode-go 池优先于按量 key;usage 解析走既有 per-endpoint json/sse observer(三协议均已通)。

### 价值定位

接入成本全品类最低(粘贴 key),商业差异化最大——一个订阅 key = 国产模型全家桶(GLM/Kimi/DeepSeek/Qwen),正是中文分销客户的核心购买动机;多协议路由机制同时让平台第一次具备"同一账号按模型分协议"的能力,为后续任何聚合型供给铺路。

---

## R6 — 主动测活 + Redis 热状态

### 6a 主动测活

**勘察结论**:sub2api 手动测试(钉死小请求:"hi" + 完整 mimicry 头 + 账号代理 + TLS 指纹,Claude 探针 `/v1/messages?beta=true`,结果 SSE 推管理端;403→SetError 封号分类,429→SetRateLimited+会话窗口)+ 定时 channel monitor(per-monitor 调度器,in-flight 去重,算术 few-shot 挑战题,gjson 提取比对,历史+日聚合)。new-api:测活记一条 type=Consume 的 "Model test" 日志并测响应时间;AutoBan 状态机(1启用/2手动禁/3自动禁,自动恢复只从 3→1,渠道级 auto_ban 可关)。

**设计**:
1. **手动测活**:`src/saas/supply/account-probe-service.ts`:按 provider 品类构造探针(claude=完整 mimicry 小请求;codex=responses 小请求;openai-key=chat.completions 算术题),走 R3 同代理出口;结果映射 `{ok, rate_limited(resetAt), auth_revoked, banned}` 写 runtime-health-store(040);平台控制台 `supply/accounts` 行加"测试"按钮(saas-platform.tsx:2589),结果 SSE 推送(复用 P3 SSE 通道)。
2. **定时监控(迁移 107 `107_probe_monitors.ts`)**:`saas_probe_monitors(account_id/interval/challenge/last_result/last_run_at)` + `saas_probe_runs`(历史,保留 30d,日聚合进 102 的 hourly 表);leader worker(SKIP LOCKED),in-flight 去重;挑战题 = 算术 few-shot(响应只许数字,精确比对)。
3. **计费隔离**:探针用量打 `probe` 内部计量 namespace,不进用户账本、不计入通道成功率分母(sub2api/new-api 同规);成本归平台运营账户。
4. **自动禁用联动**:连续 N 次探针失败 → `temp_unschedulable_until` + 告警事件(103);恢复只从探针成功触发(不自动从用户请求成功恢复,避免烧用户请求做探针)。

### 6b Redis 热状态

**勘察结论**:sub2api 并发槽 = ZSET(requestID 为 member、redis TIME 为 score)+ `ZREMRANGEBYSCORE` 惰性清理 + 已存在则刷新 score(幂等重试)+ ZCARD < max 才放行 + key 级 EXPIRE 双保险;多维(account/user/api_key)各一把;粘性 `sticky_session:{groupID}:{sessionHash}→accountID`(删除即失粘);缓存失效 PubSub 广播。model-router:PG 租约(fenced)是最终权威(provider-account-lease-service.ts),RedisRespClient 可直接跑 Lua,RedisProvider 接口需扩。

**设计**:
1. **并发槽(快速预检)**:`src/saas/runtime/redis-concurrency-slots.ts`:Lua acquire/release 与 sub2api 同构;键 `mr:slot:acct:{accountId}`;**仅作调度预检/整形,PG 租约仍是 dispatch 前最终准入**(红线);Redis 不可用时 fail-open 到纯 PG 路径(现有行为),不 fail-closed(可用性优先,租约兜底)。
2. **粘性会话快路径**:`mr:sticky:{poolId}:{sessionHash}→accountId` TTL 1h;调度 AffinityPort 先查 Redis(命中且账号合格直接返回),miss/不合格回源 PG 亲和表(041)并回填;绑定变更 PubSub 失效。
3. **token 解密缓存**:密封信封解封结果短 TTL(60s)缓存,键含信封 digest,轮换即失效。
4. **接口扩展**:`runtime/providers.ts RedisProvider` 加 `createSlotClient()/createCacheClient()`(复用同一连接管理,参照 redis-rate-limit-provider 的 key 摘要与协议校验风格)。

**测试**:Lua 幂等/过期/并发竞争单测(fake Redis RESP server);Redis 断连 fail-open 集成;粘性一致性问题(Redis 与 PG 亲和漂移)门禁。

---

## R7 — 调度策略丰富化

**勘察结论**:sub2api 四级过滤——minPriority → minLoadRate(负载率最低)→ **soonestReset**(use-it-or-lose-it:先用即将重置会话窗口的账号,可开关)→ LRU(LastUsedAt 空最小,OAuth 优先 tie-break),同组内洗牌防惊群;failover = per-request excludedIDs(全局熔断由 SetRateLimited/SetError 承担)。new-api:priority 降序分档 + 档内 `weight+10` 加权随机,重试第 N 次用第 N 档。model-router 插入点:`EligibleCandidate`(provider-account-scheduler.ts:268)+ `compareLoad`(578)+ Postgres eligibility(1001-1068)供给;candidate 已带 supplierCostVersion,成本维度可交叉乘积比较有理数费率。

**设计**(全为可开关策略,默认行为不变):
1. **soonest-reset 策略**:候选过滤后,若账号有配额窗口快照(R5/099 列)且窗口将重置 < 30min,优先提拔(用掉否则浪费);开关挂 provider 配置。
2. **成本优先**:同优先级桶内按 `saas_supplier_cost_versions` 费率升序(订阅池成本≈0 自然优先于按量 key,与商业模型自洽)。
3. **LRU tie-break + 组内洗牌**:替代纯确定性抽签的尾部分支(保留 deterministicDraw 用于可复现,洗牌种子仍由 requestId 派生)。
4. **延迟感知**:健康分已有时延信号,加权进 effectiveWeight(权重系数可配,默认 0 即不变)。
5. 每策略单测 + 调度决策可观测(选择理由写 attempt 审计:命中的策略维度)。

---

## R8 — OpenRouter 兜底供给 + Gemini 订阅池(后续)

### 8a OpenRouter 兜底供给渠道(小工作量,建议并入 R2 或 R7)

**定性**:OpenRouter 是按量付费聚合 API,**不是订阅品类**(无配额窗口可转售;sub2api 全库无实现,仅测试里出现 `openrouter/gpt-5` 公开模型命名)。引入形态 = 兜底供给渠道。

**设计**:
1. catalog 注册 `openrouter` provider:`https://openrouter.ai/api/v1`,OpenAI 协议零桥接,BYOK/平台池均可,供应商特性头(`HTTP-Referer`/`X-Title`)进 provider 配置。
2. **模型目录与成本价自动同步**(真实价值点):`/api/v1/models` 返回 200+ 模型官方 per-token 美元价 → worker 定期灌进 `saas_supplier_cost_versions`(版本化,沿用 pricing 服务入口)——R7 成本优先调度立即获得全量数据,且 failover 链末端有按量 overflow 兜底(订阅池≈0 成本先用,OpenRouter 殿后)。
3. usage 字段差异( OpenRouter 归一化 usage 对象)进 json-usage-observer 的 per-provider 分派。
4. 公开模型命名 `openrouter/<model>` 经 modelMap 既有能力映射。

### 8b Gemini 订阅池(原占位,优先级最后)

同 R5 模板第三品类:Gemini CLI OAuth(code_assist endpoint,loadCodeAssist/onboardUser 流程)、AI Studio key 池、Gemini 协议(`/v1beta/*`,proxy.ts 已有路径雏形)、usage 配额(项目级每日)。在 R5 共享层稳定后启动,方案单列。

---

## R9 — P5 性能/混沌基准(需 Docker 环境)

沿用 parity 方案 P5 清单:3×gateway compose、非流式 p99 < 30ms、SSE 零损坏、200 并发、429 精确、1→3 线性 ≥2.7×、kill 实例/PG 混沌、24h soak。**R6b 并发槽落地后重跑**——纯 PG 租约在 200 并发下预计是热点,这是 Redis 槽的量化证据来源。

---

## 迁移编号总表

| 编号 | 内容 | 阶段 |
|---|---|---|
| 100 | 账号表 claude 调度列(099 头注释预留槽) | R5 |
| 104 | saas_billing_groups + 组账号池绑定 + keys/tenants 组列 + 快照倍率列 | R1 |
| 105 | saas_egress_proxies + 账号代理列 | R3 |
| 106 | saas_email_verification_codes | R4 |
| 107 | saas_probe_monitors + saas_probe_runs | R6a |
| 108 | 账号表 opencode_go 配额快照列 + provider protocol_rules 列 | R5b |

每个迁移同步:`deploy/managed-saas-postgres-roles.sql` 最小权限授权 + `runtime-privileges.ts` 清单 + 镜像测试(e2e 抓过的 P3 教训,授权必须与迁移同提交)。

## 涉及文件(新建为主)

| 文件/目录 | 动作 | 阶段 |
|---|---|---|
| `src/saas/billing/groups/`(服务/快照倍率合成) | 新建 | R1 |
| `src/saas/pricing/service.ts`、`hold-calculator.ts`、`dispatch-usage-settlement.ts`、`admission-guard` | 扩展(倍率外层乘,不改内部) | R1 |
| `src/saas/gateway/http-handler.ts`、json-usage-observer、payload-compiler 估计器 | 扩展 | R2 |
| `src/saas/supply/egress-proxy-*.ts`、`provider-http-address.ts`、codex/transport fetch 对齐 | 新建+扩展 | R3 |
| `src/saas/identity/{email-sender,email-verification-service,turnstile-service,register-http}.ts` | 新建 | R4 |
| `src/saas/gateway/oauth-subscription/`(共享层) | 提取重构(codex 行为不变) | R5 |
| `src/saas/gateway/claude/`、`src/saas/platform/claude-oauth/` | 新建 | R5 |
| `src/saas/catalog/opencode-go-registration.ts`、`src/saas/gateway/opencode-go/`(协议规则/目录) | 新建 | R5b |
| `src/saas/supply/opencode-go-usage-worker.ts` | 新建 | R5b |
| `src/saas/supply/account-probe-service.ts`、probe worker | 新建 | R6a |
| `src/saas/runtime/redis-concurrency-slots.ts`、sticky 快路径 | 新建+扩展 | R6b |
| `provider-account-scheduler.ts` 策略维度 | 扩展(默认行为不变) | R7 |
| `web/src/features/{saas-platform,saas-console,auth,keys}.tsx` | 扩展(组管理/测活按钮/注册页) | R1/R4/R6 |
| `src/cli/` worker 保活/重连(R0-1 排查后定)、`tests/e2e/saas-workspace.spec.ts` 台账 | 修复 | R0 |
| `tests/saas/{billing/groups,gateway/claude,gateway/opencode-go,identity/registration,supply/egress-proxy,runtime/redis-slots}` | 新建 | 全 |

## 风险与红线

1. **计费正确性**:倍率全部有理数;结算只用 admission 时刻快照倍率(改组不回溯);profit_control 是保险丝不是定价手段;消费日志/快照必须含倍率快照(new-api 对账教训)。
2. **抗封军备竞赛**:Claude mimicry 常量(beta 集合/CLI version/指纹 salt/usage 端点)需持续跟踪 sub2api 上游与官方 CLI release——做 settings 可覆盖 + 过期告警(与 codex-version-sync 同机制);指纹收敛默认 off 立场不变。
3. **出口代理安全**:口令密封;URL 永不进日志;socks5h 远端 DNS 语义必须验证(否则降级建议 http 代理);代理本身也是 SSRF 面,白名单校验不豁免。
4. **注册准入防刷**:验证码/邀请码/Turnstile 三层都可选,但开公网前至少开邮箱验证 + IP 限流;affiliate 奖励设最小转换阈值。
5. **ToS/法律**:订阅转售违反 Anthropic/OpenAI ToS,文档与控制台明示,立场同 parity 方案。
6. **CI 存量缺陷**(lifecycle 门禁、saas-workspace 浏览器 E2E)已立项为 R0 前置修复(任务 #19/#20)——修复完成前 R1 不动工,否则后续阶段的回归信号全部失真。

## 验证总清单

0. R0:lifecycle 门禁 PG15+PG18 双绿(本地复刻电池 + CI);saas-workspace 浏览器 E2E 全绿;CI 恢复绿色基线。
1. 分组:三组建组 + 池绑定,同模型同 key 不同组价格正确分层;高峰时段倍率;profit_control 触发拒绝;改组后旧请求结算按原倍率。
2. embeddings:三协议客户 OpenAI 入站全链(usage/计费/hold),非 OpenAI provider 404。
3. 代理:三协议(http/socks5h/https)账号出口 IP 正确(经探针回显);转发/刷新/测活三路同出口;过期迁移 + 凭据零泄露(grep 日志)。
4. 注册:开放/邀请/关闭三模式;验证码 TTL/冷却/尝试上限;Turnstile 开关;域名名单;affiliate 注册路径绑定与奖励入账。
5. Claude 池:真实账号绑号 → 三协议下行(流式+非流式)→ usage/计费落库;429 窗口精确冷却;刷新竞态无 invalid_grant 风暴;指纹块与 sub2api 对拍逐字节一致。
5b. OpenCode Go 池:平台池 key → 按 protocol_rules 三协议分流(grok→Responses 等)→ usage/计费落库;rolling 5h/weekly/monthly 快照写入与窗口用尽精确冷却;模型目录同步与 fallback;规则表变更 authzVersion 失效。
6. 测活:手动按钮全品类(含 opencode-go);定时监控自动禁用/恢复;探针费用不进用户账本。
7. Redis:并发槽竞争正确性;Redis 宕机 fail-open;粘性跨实例一致。
8. `npx tsc --noEmit` + `npm test` 全绿;PG 门禁全绿;安全扫描无密钥字面量(含代理口令)。

每阶段完成后登记 `docs/development-progress-*.md` 证据,并补测试用例文档(沿用 `test-cases-sub2api-parity-2026-10-15.md` 格式)。
