# 开发进度登记 — 2026-10-15(token 外销方案 R 系列)

对应方案:`docs/token-resale-implementation-plan-2026-10-15.md`(R0–R9)。本文件按任务落库登记证据;测试用例矩阵见 `docs/test-cases-sub2api-parity-2026-10-15.md`。

## R0-1 validation-worker-lifecycle 门禁存量缺陷修复(任务 #19,已完成,49880b2)

**定性修正**:此前疑为"worker 在 ACCESS EXCLUSIVE 锁等待期间连接保活/重连",深挖后确认为 **D4 quota-sync 共租竞态**,非重连:
- e98ef9b 将 quota-sync 循环落进 credential-validation-worker 同一 workload(`startQuotaWorker(database, …)` 与 validation worker 共享同一 pg 池,池默认 max 10、pg-pool 空闲取用为 LIFO);
- 两个循环轮询间隔同为 1000ms(`CREDENTIAL_VALIDATION_POLL_INTERVAL_MS`/`QUOTA_SYNC_POLL_INTERVAL_MS`),相位对齐 → 每轮两个 `pool.connect()` 竞争 LIFO 栈顶,claim 事务在轮询周期间合法地交替使用不同池连接(backend PID 翻转);
- 测试断言"第二次 claim 必须同一 backend PID"把**连接复用**误当**进程身份**——单 spawn + 预检 `workerSessionCount === 1` + 角色隔离已保证唯一 CLI 进程,PID 等值从不是产品不变量。

**修复**(测试侧,产品零改动):`blockActualClaim` 的 `expectedPid` 等值校验替换为 `allowedPids` 集合成员校验——首次 claim COMMIT 后快照子进程全部池连接(`cliSessionPids`),第二次 barrier 的阻塞 claim 必须复用快照内 backend(重启的 CLI 只会呈现全新 PID);差异周期证明(POST-COMMIT 再阻塞)与全部生命周期断言不变。

**验证**:本地一次性 PG 18.6 集群(角色 SQL → 迁移 001–103 → 角色重放 → validation-worker 授权),门禁连续 4/4 全绿(3 tests × 4 runs);tests/cli 全目录逐文件绿;`npx tsc --noEmit` 0 错。CI PG15 矩阵由推送后运行确认。

## R0-2 saas-workspace 浏览器 E2E 台账漂移(任务 #20,已完成,d1fee4e)

**根因维持原判**(e98ef9b 加 announcements 拉取,spec 9f5c1c6 台账未同步):拉取来自 `ConsoleHeader`(`web/src/features/saas-console.tsx`)的通知徽标 `useQuery`——每个已认证 console 视图(含三个失败测试所测的 workspace 首页)都会发 `getTenantAnnouncements(tenants[0].id, { limit: 100 })`;登录前不触发(accept/login 页用 `AuthFrame` 无 header)。产品行为合法,按方案默认修测试侧。

**修复**(spec +10 行):per-tenant announcements 处理器,与 members 条目同款严格风格(`limit=100`、query 仅 limit/cursor、空有效分页使徽标渲染 0 且无新 DOM);route handler 头部补台账维护责任注释防再漂移。台账审计:受测视图可达的 console 拉取(session/tenants×2/projects/members/announcements)全部有账,无遗漏。

**验证**:spec 全量 5/5 本地通过(Playwright);`npx tsc --noEmit` 0 错;仅 spec 一个文件变更。前瞻注记:若未来 spec 测 `/console/notifications` 页,该页 announcements 拉取用 `limit=25`,需另立台账条目。

**R0 整体**:两项存量 CI 缺陷修复完毕(#19/#20),CI 绿色基线恢复条件就绪(以推送后 CI 运行为准)。R1 及以后阶段的回归信号有效。

## R1 分组倍率(任务 #27,已完成,4e9d27e)

迁移 **105**(104 被并行 R2 embeddings 占用,串行 fail-closed 排序,093/095 仲裁先例;方案预留的 105 出口代理由 R3 落地时再仲裁)。要点:
- `saas_billing_groups`(有理数倍率 CHECK>0、高峰窗、model_pricing JSONB、profit margin+buffer、claude_code_only、fallback 禁自引用)+ 组账号池(platform 账号 text PK)+ keys/tenants 组列 + 快照 **6+1 列**——比方案多一列 `model_pricing_override jsonb`:digest 无法在结算时重建被覆盖费率,不存费率就得重查可变组表,违反冻结红线;结算侧对存储费率重验 digest,不匹配 fail-closed 进对账。
- 结算改为经新端口方法 `getCustomerPriceSnapshot` 取不可变快照行,应用冻结倍率+冻结覆盖费率;**组表在结算路径永不查询**。快照 digest 纳入组材料:组编辑后重放在途请求 fail-closed(SNAPSHOT_CONFLICT)而非静默改价。
- profit_control 修正方案笔误:拒绝条件是 `customerCharge ≤ supplierCost × (1−margin−buffer)`(任务文本写反会拒绝有利定价);在 admission 对保守 witness 金额评估。
- 充值:`PaymentTopupCreditPort`,credit = paid × topup 倍率 × 档位折扣(向下取整永不超发);档位折扣 settings 键已实现但平台 settings store 尚不存在,当前为注入式选项(缺口已记录)。
- 授权镜像同提交(roles.sql + runtime-privileges,mirror 测试列数 30→36)。
- 已存未执法(后续):rpm/daily/weekly/monthly 限额、claude_code_only、fallback_group、model scopes——与 claude_code_validator 及调度器消费组池的后续任务配对;结算侧 profit control 待 supplier usage 事实进结算快照。

**验证**:全量单测 4145 通过 0 失败(18 PG 门禁跳过);groups 17/17;mirror 108/108;tsc 0 错。

## R2 embeddings(任务 #28,已完成,804d2ef)

迁移 **104**(与 R1 并行落地的编号错位,树内注释已记录)。关键设计决议:embeddings 是 openai 协议族的 **operation**(server-owned、path-derived `clientOperation`),非新协议——方案接线点描述的是 operation,且 DB 在 ~8 张表 CHECK 钉死 protocol 枚举,新协议值需全部拓宽,operation 模型只需放宽 029 的一处 provenance CHECK。全链:ROUTES+clientOperation → preparation 校验(operationAllowedForProtocol 仅 (openai, embeddings))→ payload 编译器能力门(非 openai provider → 404 CAPABILITY_UNSUPPORTED;catalog rights 不兼容 → 404)→ embeddings 估计器(chars/4 上界、output 0、仅 input 桶)→ JSON usage observer(prompt_tokens ?? total_tokens、严格 list 信封)→ 结算。旧 BYOK 面 clientProtocolFromPath 分支 + 非 openai 上游 422(镜像 /v1/responses/compact 门)。未触碰 admission/hold/settlement 文件(估计器经 runtime module 依赖注入)。**验证**:全量 4390 测试 0 失败;新 embeddings 7/7(含全链 e2e 与 404 负向);12 个冻结注册表测试文件更新至 104/105。

## R5b OpenCode Go 订阅池(任务 #21/#22/#23 已完成)

- **R5b-1**(fe10456):catalog 注册(credential api-key、平台池、endpoint scope `opencode-go-zen`、钉 `https://opencode.ai/zen/go`)+ 29 模型 fallback 目录(grok/glm/kimi/longcat/deepseek/mimo/minimax/muse-spark/qwen/hy/omen,sub2api 逐项对拍)+ `normalizeOpenCodeGoModelId`(trim→lowercase→按序剥一次三种前缀,重复前缀不二剥)。19/19 测试。仓库无注册表索引——注册模块为独立库模块,消费方直接 import 身份常量(与 codex 同构),本层无需 DB 迁移。
- **R5b-2**(d03c4ae):`protocol_rules` 多协议自适应路由。纯路由模块(Go 默认表+Zen 变体数据化、归一化后精确/后缀 glob/裸 * 匹配、first-match、chat-completions 兜底、严格校验 ≤64);authority 装饰器在 modelMap 后、签名前重写 `providerProtocol/providerOperation`,编译层同源推导为一致性层(两者不可能不一致);`createEndpointRoutingTransport` 泛化为路由表,codex 语义逐字节不变;dispatch-profile 输入携带签名协议供 per-protocol provider-target 绑定。**已识别后续缺口**(列入 R5b-4):capability protocol 拼写 'openai-compatible' 需与 GatewayProtocol 对齐否则候选过不了 authority 校验;anthropic 路由需 anthropic-version 头(挂点已留);Responses 桥为透传桩需 transform 或限制。27/27 新测试+触面 306/306 回归。
- **R5b-3**(40f057b):配额快照 usage worker(percent-only API、15min/5min 下限/debounce 1min/≤20 账号/并发 4/singleflight、FOR UPDATE SKIP LOCKED 逐账号 claim 即租约(仓库先例,无 Redis)、用尽窗口→最晚未来 reset 冷却、429→Retry-After 否则仅失败退避、指数退避±10% 抖动)。store 接口隔离 worker 与迁移 108;PG store+启动注册归 #25。29/29 测试。

- **R5b-5**(c6c0d87):迁移 108(双账号表 usage 快照列 + `opencode_go_protocol_rules` jsonb,≤64 数组形状 CHECK,due 部分索引;099 scheduling-signal 风格)+ PG store(SKIP LOCKED 逐账号 claim 即租约、quota-sync 同款 KMS 解封、快照/失败/冷却写、protocol_rules 047/082 CAS 管理面)+ 启动注册(credential-validation-worker workload,quota worker 同款)。授权镜像同提交:control-plane 独占 protocol_rules;worker 有 due 三列 SELECT + 10 列 UPDATE、被拒 protocol_rules 读(真库实证)。**含并行 R4 的 106 迁移文件与 001 注册项**以保持提交态注册表一致(…104,105,106,108),R4 其余产出单独提交。**验证**:丢弃式 PG 18.6 真库全链(001→108 迁移、角色对账、控制面/worker 活探针、store 全操作、CAS 1→2、陈旧 CAS 落空);离线 15/15 新测试、tsc 0 错。

## R4 注册准入(任务 #30,已完成,1773d98)

迁移 106 表结构已随 c6c0d87 入库;本提交为服务/HTTP/UI 层。要点:
- 验证码服务:6 位 crypto 码、TTL 15/30min、60s 冷却、≤5 次、常量时间比较、一次性核销、PG 为准。**自测抓出真缺陷**:尝试计数器自增原在事务内抛错回滚(等于无限试码)——改为先提交自增再抛拒绝。
- Turnstile:siteverify POST + CaptchaProof 归一抽象(腾讯预留、构造即 fail-closed);开关关闭=放行。
- SMTP:**零新依赖**——最小 net/tls 客户端(EHLO/机会 STARTTLS 带证书校验/AUTH PLAIN/LOGIN/dot-stuffing);EmailSender seam 可后换动态 provider。
- Settings:仓库无平台 settings store(billing-groups 同判例)——保留键登记 + 严格解析器,受管模式经 `MODEL_ROUTER_SAAS_REGISTRATION_*` env;秘密 env-only。默认全部 fail-closed(mode=closed、必须验证、turnstile off、奖励全 0)。
- 注册顺序:mode→邀请码→域名名单→Turnstile→验证码→原子创建;邮箱存在性探针在 captcha/验证码**之前**(常见失败不烧码);2/30s per-IP 发送窗口。密码重置:核销即证明,单 fenced 事务改哈希+吊销全部会话;未知邮箱静默 no-op(无账户预言机)。
- 注册后置 best-effort 个人租户(affiliate/钱包租户域);三段奖励经 postVerifiedFunding 独立命名空间,幂等键锚定不可变 user id。
- UI 在 saas-console.tsx(auth.tsx 是 admin 门户,未触碰):RegisterPage/ForgotPasswordPage/登录链接。
- 授权镜像同提交:control-plane S/I/U+DELETE,gateway 零授权;mirror 测试更新。

**验证**:全量单测 4227/4209 通过 0 失败(18 opt-in 跳过);新增 57 例(lifecycle 12/顺序矩阵 17/settings 5/HTTP 边界 11/turnstile 6/rewards 6);tsc server+web 干净;web 构建通过。

## R5 Claude 订阅池(任务 #31,已完成,5279e42)

四步全落地:
- **共享层提取** `src/saas/gateway/oauth-subscription/`(identity-namespace/health-classifier/quota-pause/transport-skeleton/pkce)——codex 五文件变为纯 import 改写/委托 shim,**110 codex 测试零修改通过**(回归 78/78 复核)。
- **品类包**:gateway/claude(10 文件,含 billing 指纹逐字节移植、system 三块重写+迁移前消毒[比 sub2api 更严]、cache_control≤4 剥离顺序、unified 429 分类、双向下行桥)+ platform/claude-oauth(PKCE 绑号/credentials.json 导入/管理 HTTP/审计 sink)。80/80 新测试。
- **迁移 100**(099 预留槽):claude 4 窗 utilization/reset + 会话窗 + cli_version_override,099 scheduling-signal 风格;刷新 worker per-adapter passthrough(codex 轮换字节不变)。
- **claude-code-validator** 纯模块(9/9),组执法留给 R1 后续。
- Beta 集以方案黑盒集为准(当前 sub2api 源已漂移),常量 env 可覆盖。

## R3 出口代理(任务 #29,已完成,658c84d + a05698c)

迁移 107(编号仲裁:105/106 被 R1/R4 占)。要点:
- **SOCKS 原生实现零新依赖**(socks-proxy-agent 是 http.Agent 生态无法作 undici Dispatcher):buildConnector 连接器,RFC 1928/1929,CONNECT 用 ATYP 0x03 DOMAINNAME(socks5h 远端 DNS 由构造保证),TLS-over-tunnel,错误零凭据;mock SOCKS5 服务实证域名(非解析 IP)到达代理。
- **undici 6.28.1 接线修正**(方案笔误):ProxyAgent 隧道覆盖内层 connect,钉扎经 `proxyTls.lookup`(源码验证)。
- **三路同出口**:转发(resolver→dispatch profile→transport SSRF 同白名单钉扎,EGRESS_PROXY_INVALID fail-closed)、OAuth refresh(claim 事务内解析,坏代理 egress_proxy_unavailable 退避**绝不直连**)、探测(同工厂)。
- 密封信封 CHECK 拒绝 username/password 明文键;`ON DELETE RESTRICT` 防删在用代理静默换出口 IP;redact.ts 代理 URL 全量脱敏。
- 探测+清扫 worker:SKIP LOCKED 逐代理 claim-probe-write;经代理打双探针;过期按 fallback_mode 迁移(none=告警/proxy=环安全备份链/direct=解绑),来源溯源+审计;dead 降权至 1(资格信号非剔除)。
- 顺带修复 3 个存量 undici 类型漂移 tsc 错误(upstream-actions asyncIterator、proxy.ts dispatcher×2)——全树 tsc 归零。
- **验证**:丢弃式 PG 18 真库(001→108 迁移+角色对账+探针;CHECK 拒 socks4/明文凭据/自备份);全量 4368 单测+246 集成 0 失败;30 新测试。

## 进行中

R6(#32 测活+Redis 热状态,迁移 109)与 R7(#33 调度策略)并行——R6 禁改调度器、R7 独占调度器,文件域隔离。R5b-6(#26 测试收尾)待两者落地后执行(跨 R5b 全链 + PG 门禁复跑)。
