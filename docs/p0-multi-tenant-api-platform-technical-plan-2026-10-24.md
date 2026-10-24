# 可运营多租户模型 API 平台：P0 技术方案

> 日期：2026-10-24。状态：开发继续暂停；按用户后续指令，主任务`6cc79da`与CLI WIP `cf5008b`已整合到main，代码合并点`9f43335`，合并后尚未验证。最近已验证工程基线`ae911346280c3ea00e3b43c2a248cfe1026aefaa`已fresh build、C0定向21/21、CI #171全68/68通过；其OpenAI mock串行四腿各100的P99/TTFB额外开销722.38/481.10ms未达30/10ms原门槛。真实Kimi A0及PG原600秒恢复的通过证据仍绑定9d；CLI真实工具验收及M1/M2/M3均未关闭。
> 初始设计基线：model-router `44b0eb7`；Codex C1–C4 基础 checkpoint `f61afec`，后续改动按独立任务继续交付；只读对标基线：CLIProxyAPI `911f49c`、Sub2API `a3eb7ef`、New API `6549a17`。
> “拟新增”保留初始设计语境；当前实现与证据以各节明确状态及开发进度 §29 为准，源码交付不等同运营可用。
> 状态区分源码、定向检查、真实供给、本地受控故障和生产验收；9d完整验收见开发进度§29.53，C0门禁/实际失败、暂停交接及main整合见§29.54–58。历史失败与旧CI保留，不能替代当前revision。恢复开发前不执行下列剩余动作。

## 1. 目标、范围与交付边界

目标是让一个全新租户通过正式入口获得可授权、可计费、可撤销的模型供给，完成真实收款和退款，并在受控负载、故障和恢复后保持资金及请求证据一致。
以三个主线收口：A 标准供给与协议工作流；B 单 PSP 标准收款退款；C 托管性能、恢复和生产运维验收。
继续采用模块化单体，同一代码库按 control-plane、gateway、validation-worker 角色部署；支付与退款 worker 复用当前编排，不拆新微服务。
复用 tenant/project/Key、钱包、套餐、价格、供给池、商业策略、OAuth、账户刷新与已有恢复机制。
不扩展营销、插件市场、白标、多 PSP 路由、实时汇率、全新账户体系或无关多模态产品。

首发拟定 Alipay precreate + CNY，前提是获得实际商户配置和验收账户；当前没有商户证据不等于已经具备收款条件。
可先用经过证明的非 Codex text/function 供给进行选定范围演示与运营验收。
这不会移除完整 P0 中 Codex compact、WS、remote history 与可信计费上界的任务。

| 里程碑 | 可作出的声明 | 必须满足 | 当前状态 |
|---|---|---|---|
| M1 选定供给演示 | 新租户正式入口完成指定模型请求 | A 正式 provision、指定协议工作流、明示限制 | 关键代码与定向/PG18 验证已推进；正式指定供给全链待验收 |
| M2 可收费运营 GO | 经批准的供给、币种、商户范围可收费 | M1 + B + C 性能/恢复 + 生产 KMS/同步持久恢复 + 发布候选必需 CI + 运营签收 | 未关闭；工程候选87 CI通过，真实 PSP、R9、生产 KMS/恢复待证据 |
| M3 全 P0 完成 | 本方案关键能力全部收口 | M2 + 完整协议矩阵 + Codex 外部契约与真实工作流证据 | 专项回归、完整协议/真实工作流及外部证据待验，未关闭 |

M2 必须公示供给与工作流 allowlist，不能宣传已完整对齐 Codex compact/WS。
不能通过缩小全 P0 的定义，把 M1 或 M2 改称 M3。

## 2. 初始设计基线与六个真实缺口

以下保留初始设计基线的缺口与源锚点，不能作为本轮实施后的现状判断；当前进展见§4/§8及开发进度§29。锚点相对仓库根目录，行号对应设计时版本附近实现。
对标关注 CLIProxyAPI 的 provider/协议工作流、Sub2API 的运营供给闭环、New API 的通道/价格/支付运营闭环；不按页面或 provider 数量机械复制。

| 缺口 | 初始实现与源锚点 | P0 收口 |
|---|---|---|
| G1 新租户平台权益没有正式供给闭环 | `src/saas/identity/service.ts:1156` 仅创建 tenant/default project/owner；`src/saas/keys/service.ts:541` 无权益报 `KEY_NO_ENTITLEMENT` | 窄 provisioning service 与管理员操作入口 |
| G2 协议可达性与 CLI 工作流证据不完整 | `src/protocol/bridge.ts:317` 缺 Chat↔Gemini、Responses↔Gemini 四方向；`src/saas/runtime/builtin-gateway-runtime.ts:595` 默认拒绝单 native 供给跨协议，Kimi/OpenAI 为例外 | 按 operation/protocol pair/workflow profile 开放，直接桥与真实 CLI 证据 |
| G3 Codex 计费边界不能证明 | `src/saas/runtime/builtin-usage-bounds.ts:149`、`:174` 与 runtime `:713` 明确 unavailable | 可信上界契约及后端证据；缺证继续拒绝 |
| G4 PSP 代码存在但正式装配和收银台未闭合 | 四个 provider 已有；CLI `:407` 只处理环境，`src/server/managed-saas.ts:476`、`:2669`、`:2909` 需要 payments/refundAdapter 装配；`saas-wallet.tsx:691` 仍为文本 | 单 Alipay 配置装配、二维码、轮询、退款状态 |
| G5 商户版本与历史单生命周期未闭合 | orders/refunds 有 provider_key/merchant_id，当前 singleton 会按当前 merchant 拒绝历史单 | immutable binding、历史 verifier/adapter 与单队列分派 |
| G6 SaaS 性能与收费生产恢复未验收 | 已有 Redis 配额/异步日志；短诊断 overhead 797.59/207.23ms 仍超过 30/10ms；软件 KMS pilot-only | 保留原 R9、正式供给首请求、故障不变量、生产 KMS 与异地恢复回执 |

`src/saas/plans/service.ts:1784`、`:2047` 的 project entitlement INSERT 是 BYOK 路径。
平台供给示例来自 `verify-commercial-kimi.ts:793`、`:796` 的 seed，不是新租户正式开户验收。
平台 catalog 主要负责读取；`src/saas/supply/service.ts:2500` 已有 grant，要求 profile active。
`src/saas/gateway/route-config-service.ts:348`、`commercial-metering-policy-service.ts:833` 与价格/capacity service 都应复用。
不能把上述能力描述为现成的单一 CLI 自动开通流程，也不能全部重建。

### 关键能力对齐映射

下表引用上述固定 revision 的参考源码能力，不构成对方线上可用性或性能验收声明。

| 参考源码与能力 | 本项目任务 | 对齐出口与边界 |
|---|---|---|
| CLIProxyAPI [账号池调度](/Users/lex/play/CLIProxyAPI/sdk/cliproxy/service_config.go:65)、[生产自动刷新启动](/Users/lex/play/CLIProxyAPI/sdk/cliproxy/service_lifecycle.go:102) | P01/P03，复用既有 OAuth/sink/refresh | 首发 pool 正式开户与可用性；不承诺复制 RR/WRR/fill-first/session affinity 全部策略或所有 provider，不扩新策略工程 |
| CLIProxyAPI [CLI/Responses WS 路由](/Users/lex/play/CLIProxyAPI/internal/api/server_routes.go:72)、[Vertex compact 限制](/Users/lex/play/CLIProxyAPI/internal/runtime/executor/gemini_vertex_executor.go:269) | P04/P05 | route 存在不等于所有 provider 通用或可信计费；该 executor 明确不支持 compact，Codex 缺证继续拒绝 |
| Sub2API [支付路由](/Users/lex/play/sub2api/backend/internal/server/routes/payment.go:32)、[余额/套餐履约](/Users/lex/play/sub2api/backend/internal/service/payment_fulfillment.go:216) | P06–P08 | 对齐回调、余额或套餐履约和退款用户交互；限定单 Alipay/CNY 真实扫码、到账、退款，不以多 PSP 数量冒充闭环 |
| Sub2API [PG 备份实现](/Users/lex/play/sub2api/backend/internal/repository/backup_pg_dumper.go:35)、[备份操作界面](/Users/lex/play/sub2api/frontend/src/views/admin/BackupView.vue:860) | P10–P12 | 目标是实际恢复工作流；按钮或 pg_dump 成功不证明异地恢复、金融保证或 RPO |
| New API [多协议路由](/Users/lex/play/new-api/router/relay-router.go:78)、[统一预扣/结算/退款会话](/Users/lex/play/new-api/service/billing_session.go:47) | P04/P05/P07/P09/P10 | 对齐多协议、WS 逐事件准入与资金生命周期；复用现有财务，不重建，接口覆盖不代替真实 CLI 和计费上下界证据 |

不按 provider 或页面数量全量复制参考项目。

## 3. 架构与权威边界

```mermaid
flowchart LR
  Admin[管理员与租户控制台] --> CP[control-plane]
  PSP[Alipay] --> CP
  CP --> Provision[供给编排与 operation journal]
  CP --> Payment[支付 inbox 与现有 workers]
  Provision --> PG[(PostgreSQL 权威状态)]
  Payment --> PG
  Client[真实 CLI / API 客户端] --> GW[gateway]
  GW --> PG
  GW --> Redis[(Redis 软配额与缓存)]
  GW --> Upstream[已准入模型后端]
  VW[validation-worker] --> Upstream
  VW --> PG
  CP --> KMS[生产 KMS seal / 专用 PSP secret]
  GW --> GKMS[上游凭据 decrypt 权限]
  VW --> VKMS[验证凭据 decrypt 权限]
```

PG 保持账本、余额/hold、累计 Key/计费组预算、派发证据、支付事实与 operation 权威。
Redis 已承担共享 RPM/TPM/并发软配额；异步日志是独立写入机制，约 5 秒成功 auth cache 是进程内缓存。
三者均为已有机制，不列为待重建功能，也不把日志或 auth cache 归为 Redis 持久性保证。
非金融 Redis 计数存在已接受的短暂丢失窗口，不能宣传其 RPO=0，也不能把资金安全建立在异步 Redis 上。
control-plane 只读取 PSP 专用 secret，不新增上游凭据 decrypt 权限；gateway 不接收支付密钥。
validation-worker 保持当前账户验证职责，不能因支付接入扩大其权限。

## 4. A 轨：正式平台供给入口

### 4.1 窄服务与最小 API（本轮实现）

`PlatformInferenceAccessProvisioningService` 协调已有 pool、route、commercial policy 与 capacity services；不新增 offer/recipe 市场。实际 DTO 以 `src/saas/supply/platform-inference-access-provisioning.ts` 为准，版本字段全部为 decimal string：

```ts
type ProvisionPlatformInferenceAccessInput = {
  operationKey: string;
  tenantId: string;
  projectId: string;
  pool: { id: string; expectedAuthzVersion: string; evidenceReference: string; evidenceSha256: string; expiresAt?: string | Date };
  capacity: {
    tenantExpectedRevision: string;
    projectExpectedRevision: string;
    tenantLimits?: CapacityPolicyLimits;
    projectLimits: CapacityPolicyLimits;
  };
  routes: Array<{
    routeId: string;
    definition: RouteConfigDefinition;
    customerPolicy: { policyId: string; definition: CustomerMeteringPolicyDefinition };
    providerPolicy: { policyId: string; definition: ProviderMeteringPolicyDefinition };
    attestation: Omit<ContractTestAttestationInput, 'tenantId' | 'projectId' | 'audit'>;
  }>;
};
```

`projectExpectedRevision` 比较真实 `saas_projects.inference_policy_version`，不存在 `expectedProjectAuthzVersion` 字段。路由输入沿用 `RouteConfigDefinition`，新 profile 的 route version 由操作创建并记录。嵌套 DTO 严格解析，tenant/project/audit 只能由服务端身份注入。商业 attestation 的独立公钥与 suite test-vector digest 信任配置缺失时不能准入。

Codex 开户新增服务端 `admissionReadiness`：从已核验 route/provider policy 导出精确 HTTP/full scope，在创建前和最终激活前检查 reviewed profile；缺端口或空 registry 返回 `TRUSTED_USAGE_BOUNDS_UNAVAILABLE`，不激活权益。这只证明选定 scope 的静态财务条件，不代表任意 payload、WS/compact、动态健康或真实工作流可用。

现有管理员 router 前缀为 `/admin/api/v1`：`POST /supply/platform-access/operations` 创建或续做操作，`GET /supply/platform-access/operations/:id` 查询，`POST /supply/platform-access/disable` 携带 `operationId/expectedEntitlementVersion/reason`。使用已有管理员鉴权、CSRF 与审计链；不返回凭据。同 operationKey 同摘要返回原操作，不同摘要冲突。tenant/project 跨界、未发布价格、币种、能力及证据期限均须核验。

### 4.2 持久阶段与失败恢复（本轮实现，待验收）

operation journal 实际阶段为 `assembling/recheck/completed/failed/disabled`，与 entitlement `active/disabled` 独立。journal 保存 actor、摘要、资源 refs、阶段 receipts、runner 和错误码；既有子服务各自提交事务，整体不是单一原子事务。

1. 固定 G→tenant→project→actor 授权锁顺序，拒绝已有 active 平台权益的隐式替换。
2. 短事务先创建 operation 专属 active profile，再创建 disabled entitlement（带 disabled_at），同时写 journal/资源关联及 profile、entitlement 审计；满足 schema005 即时 FK。
3. 贯穿本次 run 的独立 operation advisory guard 防止在途执行与接管竞态；子服务独立事务，不跨子调用持有 authority/row 锁。control-plane pool 至少两个连接。runner_until 仅诊断，不作为自动接管依据。
4. 幂等执行 pool grant、route 和 customer/provider policy create1/publish2、signed v2 attestation、bind、capacity，逐步记录 receipts。失败保留 journal，不删其他操作资源。
5. 最终重新检查 route.resolve、commercial authority、价格/币种/有效期、每条 route 的 pool provider/product 与 capability/credential/rights、tenant/project capacity revisions。
6. 若 project inference policy 原为 suspended，追加 next active policy，复制原三项限额并 CAS 当前 `inference_policy_version`；与 entitlement active/authz+1、审计和 operation completed 在同事务提交。版本或授权变化不得完成。
7. cancel/disable 仅作用于该 operation 权益，不 suspend 共享 project、不影响既有 BYOK。warm cached-auth下tenant/Key/entitlement撤销的inference HTTP补证已完成：fresh PG18 commercial run03共30/30，三类撤销在两实例warm cache下全部返回typed403。源码无reload、无主动cache clear；真实prelock2/11表零变、resume B与版本审计均验证，依靠PG权威fail-closed，不声称其他实例的进程内Map cache被清除，亦未新增fence竞态。

不自动发 Key 或充值；余额与 Key 仍走已有明确入口。显式替换旧权益需独立展示影响并授权，初版可拒绝。以上是本轮代码合同，不表示 PG 并发、受限角色、真实供给或正式 provision 工作流已经验收。

### 4.3 协议准入与 CLI 工作流

provider adapter、OAuth、sink、refresh、WS、compact 已有接线，P0 补齐准入及证据，不另造 provider 框架。
复用 capability/readiness，索引维度必须是 operation + client protocol + upstream protocol + workflow profile。
先开放已有并通过证据的 pair，再实现四个直接桥；禁止随意串两段有损 SSE 转换充当直接支持。
遇到不支持的供应商特有字段，应返回明确错误及字段说明，不静默删除 thinking、tool 或 continuation 语义。

| 工作流 | P0 实现/证明内容 | 出口与状态 |
|---|---|---|
| Chat↔Gemini | 请求、工具、usage、流式增量、错误和取消的直接转换 | 已实现；计入全bridge56/56定向验证；真实CLI待验 |
| Responses↔Gemini | response/item/tool IDs、状态、usage 和流式事件直接映射 | 已实现；计入全bridge56/56定向验证；真实CLI待验 |
| 现有 Anthropic/OpenAI/Responses pairs | 旧Gemini↔Anth P1已修；审视capability与runtime默认拒绝 | 全bridge56/56、`9b14151`已推送；未因注册自动放开供给 |
| 真实 CLI 两轮工具调用 | 实际 CLI 版本、精确模型、两轮 tool result、thinking 保真/限制、取消、重连、usage | 待验收 |
| Codex compact/WS/remote history | endpoint/model/backend revision、完整 billable input 和 reasoning output 上界 | 代码/本地TLS/PG18分层验证；真实计量契约外部阻塞 |

每条矩阵记录 CLI 名称/版本、operation、pair、模型 revision、输入类别、流式/非流式、证据 ID 和限制。
“HTTP 200”不足以证明两轮工具或 compact 工作流成功；需保留脱敏事件序列和最终账务快照。
重连不能默认重放已派发请求；沿用现有幂等/unknown 语义，按操作契约处理。

### 4.4 Codex 托管工作流与可信计费上界

完整目标保留 native HTTP、WS、compact 和 remote history；不能用诊断就绪或单个 SSE 成功替代完整托管验收。
当前供给是 `codex-chatgpt` / `chatgpt.com/backend-api/codex`。它与官方 `api.openai.com/v1` SIWC 是不同契约；SIWC preview 对 `max_output_tokens`、HTTP `previous_response_id` 的限制不能外推为本后端支持或 enforcement 证据。

| 范围 | 当前实现事实 | 完成门槛 / 依赖 |
| --- | --- | --- |
| HTTP `/responses` 完整上下文 | 已有专用 OAuth HTTP transport 和 SSE usage observer；本轮修复终态完整性 | endpoint/model/backend revision 的完整输入、reasoning 和输出上界证据；真实 CLI 工作流 |
| 客户端 `/v1/responses` WS full | 逐轮 preparation/admission/dispatch/settlement；本轮新增 fixed-wss native adapter、opaque session 与专用 scope，raw JSON 转 SSE 复用原结算链 | native adapter 逻辑/装配与真实后端 workflow 分开；须受限角色、连接断开、两轮工具及精确端点/契约独立验收 |
| WS `previous_response_id` continuation | 持久部署在 preparation 前逐引用执行 durable resolve，绑定 tenant/project/key/conversation/provider/account/credential versions/public+resolved model；同代 native 引用仍独立校验 | 消费端24/24通过，含跨连接恢复/身份变化补偿/TTL删除；真实CLI/后端及标准部署全链待验 |
| `/responses/compact` | 已有独立 HTTP passthrough；整份 `output` 都属于后续上下文 | compact 真实 CLI 请求、加密项和普通输出完整回放、compact 单独 trusted profile |
| HTTP remote history / 重连 | HTTP实际消费端10/10、WS消费端24/24与服务端编译通过，统一identity/namespace；`72b7b97`已推送 | 真实后端、多实例/KMS及标准部署恢复验收 |

C1：execution status 与 usage completeness 独立。`response.completed/incomplete/failed` 的终态 usage 都保留；缺失 input/output 不补成零，显式零仍可报告。重复冲突终态、坏帧、截断及超限不得形成 complete evidence。usage 不完整保留 unknown/reconciliation 路径。客户端协议 bridge 的结束状态与用量映射也覆盖 incomplete/failed；待针对测试与真实失败流验收。

后续源码审计发现`ResponsesUsageWatcher.feed`只检查解析后的残余buffer，完整超大事件可在同一chunk内先被解析并清空，绕过1MiB上限。现每个完整事件在JSON解析前按UTF-8字节限长，残余片段使用相同字节上限；分隔符不计入正文，同chunk多个各自合法事件不按总量拒绝。超限保留sticky invalid，后续合法终态不能恢复complete usage。修复已随`7718c49`交付，Astra实际差分复核通过；历史#161及当前候选87的自动CI均68/68成功，仅只读收集结果，没有本地新验证或新增专项用例。新的逐事件字节边界规格专项回归与真实失败流验收仍开放，详见进度§29.43/§29.45。

C2：`previous_response_id` 不是普通可丢弃字段。WS 在编译、签名和预留前构造完整 canonical request，保存完整 `response.output`，包括 compact 普通输出与加密项；transform 对未解析 HTTP reference 显式拒绝。native WS 仅在服务端确认同一 socket generation 的已完成 ID 后签 remote-history 请求，并保留 canonical tools/instructions，仅发送本轮 input；否则使用已验证 canonical replay 或返回409。持久 namespace 只取显式 `conversation_id` header/body（均有时必须一致），不用 WS 随机 session ID；缺 namespace 可执行完整请求但不存，引用请求则409。配置 resolver 后每次引用均 durable lookup，不用本地明文 cache 绕过 TTL/删除；prepare 后完整 identity 不符先补偿再409。仅金融 `settlementOutcome==='settled'` 后保存；replayed 可能仍 reconciliation_pending，不作为保存凭据；写失败不撤销已发生计费。

持久 DTO 为 `responses-continuation-history.ts`：tenant/project/key/conversation/response scoped reference，provider/product/account/credential id+version+authz version/public+resolved model 完整绑定，canonical digest 和 expiry 纳入 AEAD associated data；PG 仅存 ciphertext envelope 与 key id，复合 tenant/project/key FK，禁止用户上下文明文进入数据库或日志。数据库时间 TTL、有界清理、tenant/key 回收和 immutable insert conflict 均是验收要求。迁移141、PG adapter、AEAD cipher、resolver 已实现，真实 PG18.6 受限 gateway history1/1通过；WS实际消费端24/24覆盖新连接恢复、scope隔离、身份补偿、pending/replayed拒存、写失败与长连接TTL/删除。HTTP实际消费端10/10包含按实际Content-Type捕获与finish/abort边界，服务端编译通过，消费端交付已随`72b7b97`推送。真实后端、多实例/KMS与标准部署恢复仍待验，不能由本地消费端结果外推生产全链。

C3：`max_output_tokens` 被保留不证明后端强制执行。新增代码审阅的 trusted-bound registry，默认空，无 operator JSON 注册信任入口。profile 精确绑定 endpoint、product、model、operation、实际上游 transport、continuation mode、backend revision、evidence version/reference、完整 billable bounds 与有效期。完整 profile canonical SHA-256 与 compiler version 生成47字符 `cb1:`内容寻址版本，复用现有 signed `payloadCompilerVersion` 和 request fingerprint version，避免越过 metering 64字符限制。每次实际 send（包括重试、HTTP/WS逐轮、compact）在 credential 使用前对 proof/evidence 与实际 scope 重验，过期/撤销/旧version均拒绝。当前没有任何已接纳的 ChatGPT 后端证据，保持 hard reject，代码实现不代表财务准入完成。

后续源码审计发现builtin准入以`builtin-gateway-payload/v1`生成cb1，而发送重验误用通用`provider-payload-compiler/v1`，合法profile也会出现版本不匹配；空registry使这条问题路径暂未运行。现以无依赖叶子`builtin-payload-compiler-version.ts`共享原builtin版本，准入与发送使用同一常量；通用compiler默认版本、cb1算法、proof/精确scope校验及空registry拒绝均不改。修复已随`92f477a`交付，Astra实际差分复核通过，当前候选87的自动CI已68/68成功；未添加专项用例，亦未进行本地新测试/构建。本地dist仍旧，合法真实reviewed profile的正向覆盖与实际后端验收没有新证据，详见进度§29.42/§29.45。

C4：readiness 分别记录 transport assembled、credential verified、financial admissible、workflow verified 四事实；HTTP full、WS full、WS continuation、compact 分行。HTTP mount 不能自动证明 WS mount，provider credential 验证不能自动证明 workflow live。native connector 使用 Undici 公共 WebSocket dispatcher 接现有 DNS pin/proxy/TLS 连接器；beta header `responses_websockets=2026-02-06` 来自 CLIProxyAPI 实现参考，不构成 ChatGPT 后端官方契约；应用层 frame/queue/timeout 有界，溢出关闭并保留 unknown，不宣称公共 API 支持 TCP read pause。workflow 只有独立 live evidence record 才为 true；空 trusted registry 财务项为 false。

C4精确覆盖已实现：不得用全局profile数量或固定unavailable占位推断四行财务就绪。候选范围取active catalog中精确`productId + resolved upstream model`，其中model来自`saas_public_model_versions.model`而非public alias；包括仍active的固定旧版本，不能只取最新public model版本。catalog `codex-responses`明确映射现有HTTP/WS物理端点；无法确定、空集或坏候选全部false，不从已有profile反推已部署模型。每行要求候选集合逐一全部覆盖：HTTP full、WS full分别匹配自身transport/mode；WS continuation同时要求canonical-replay与remote-history；compact单独匹配responses.compact/http/compact。同一次收集使用当前时间及现有resolver校验有效期/撤销，registry仍默认空。

此处仅表达明确catalog范围的静态财务覆盖，不证明任意composite route、tenant entitlement、价格或实际请求已准入。bundle整体按runtime原有声明的三项工作流及可选compact全部覆盖汇总，实际transport装配、credential verified和独立live workflow证据仍各自计算，不能互相抬升。真实send/provision继续精确scope检查，全局profile计数仅作展示。本轮已在四个runtime文件实现，Astra算法差分及独立schema/既有CP/GW列权限只读复核通过，无迁移/grant变更；仅同步既有collector fixture的第五次查询，未新增case、未进行本地运行。交付commit为`87cc8b4`，该确切工程候选的自动CI #162已68/68成功；这是只读收集既有自动CI，不是本地新验证。本地dist没有更新；新边界规格、合法profile对各workflow的正向覆盖、真实profile/多实例验收仍需额外专项回归和外部证据，详见进度§29.44–45。

C5：新开户只创建账户和明确 entitlement，不 seed 模型、余额、供给或可信 profile。演示与正式供给按单独 provision 合同执行，不能由 Codex 配置自证解锁。

当前证据：基础 Codex/continuation/profile 定向15/15、native及相关定向29/29和服务端编译通过；真实本地 TLS I/O 1/1验证固定 hostname/CA、两轮 socket 复用、SSE/terminal usage、写后断线不重发和连接清理。该本地测试用受控 connector DI，仅连接合成服务器，不代表生产 DNS/proxy 或真实 ChatGPT 后端。最终审查发现的 safe session error/public alias pin 两项P2已修，Luna 后续 helper/native TLS/transport/executor 定向25/25及服务端编译通过。

剩余顺序：①C1新字节边界规格及C3/C4合法profile正向覆盖的专项回归（需相应验证授权，不改空registry）；②标准部署、多实例/KMS与compact完整窗口验收；③真实后端native WS/逐轮恢复工作流；④供应商enforcement/完整计量合同；⑤精确endpoint/model/revision真实CLI验收并保存四事实证据。HTTP/WS消费入口工程已交付，最终native P2及WS TTL P2已有回归；registry仍空，外部计量契约缺失保持hard reject。部署集成验证与真实工作流各有独立出口，不能全部归为供应商阻塞。超过预留、revision变化或证据撤销时停止新admission，保留派发/结算证据进入人工对账。

## 5. B 轨：单 PSP 收款与退款

### 5.1 首发装配与配置（拟新增）

拟新增 `MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE`，仅 control-plane 读取。
配置 schema v1 的 provider 枚举只允许 Alipay；现有 Stripe/WxPay/EasyPay 代码继续保持明确未启用状态。
首发使用 Alipay precreate 返回的 QR 内容；当前联合类型适合该路径。
Stripe 当前把 client_secret 放入 qr，且没有 Stripe.js collector，因此不能作为首发默认方案。

配置包含 schemaVersion、bindingId、provider、merchant public identity、currency、状态和 secretRef。
状态为 `disabled/draining/enabled`：enabled 接新单；draining 拒绝新单但继续历史 callback/query/fulfill/refund。
disabled 不得无条件丢弃已存在支付事实；在历史义务未清理前应保持 draining，紧急停用需人工对账。
公有摘要和配置 hash 可以持久化；secret 只保存引用，不写配置导出、日志或 Git。
PSP 私钥/证书由 systemd credentials 或 compose 只读 secret mount 提供；失败启动应明确指出缺少引用，不打印秘密。
现有 CLI/environment 装配处必须把 provider 与 refundAdapter 实际注入 `managed-saas`。

### 5.2 商户 binding 与版本

拟新增 append-only merchant binding/version；同 provider 可有 active 新单 binding 和多个 draining 历史 binding。
merchant 身份包括 app/seller/merchant 标识及环境，创建后不可修改；切商户创建新 binding。
多 control-plane 副本的新单 active binding 由 PG 按 purpose/currency 作用域的 version/CAS 指针决定，复用已有 versioned platform setting/注册元数据。
JSON 中 activeMerchantVersion 只表达部署期望，不能由副本本地配置决定新单商户。
切换先确认相关副本都可解析新 binding 与历史 binding，再以 expectedVersion 执行带审计的 CAS 激活。
create-order 先复用 `findOrderByClientRequest` 按 tenant + 原业务幂等身份查既有订单及原 binding，再处理真正新单。
已有记录必须按原幂等指纹比较 payload，匹配则返回原单，不因商户切换重新计算指纹或找不到原单；不匹配返回冲突。
仅真正新单在同一事务读取并绑定 PG 权威 active generation；并发创建由既有唯一约束/幂等重读收口。
副本缺少该 version 时拒绝新单并报告 readiness，历史 callback/refund 继续。
订单、BYOK plan order、payment inbox、refund 持久化不可变 `binding_id`。
退款继承原单 binding，禁止使用新商户密钥退款旧商户订单。
私钥轮换独立建允许的 credential version 关系，保留凭据生效期、证书/公钥与审计，不等同于商户迁移。

callback path 仅定位候选 verifier，不构成身份事实。
通过验签后核对 app、seller、订单、金额、币种等真事实，再写入现有 inbox。
保持原去重身份，不因新 callback 入口或 binding 版本扩大可重放次数。
原单关联、provider 事件 ID/既有业务唯一约束继续防重复，验签成功也不能重复入账。
单队列 worker claim 后按原单 binding 选择 adapter，不为每个 merchant 启动一个抢全表的旧 worker。
query、fulfill、refund 与 reconciliation 同样按 immutable binding 查 adapter。
旧行只在唯一可证时回填；歧义进入明确 reconciliation 状态，禁止该商户启用新单直到解决。
不得凭“当前配置看起来一样”猜测历史 binding。

### 5.3 资金与币种不变量

钱包、套餐、PSP 与 customer price 必须同币种；CNY 收款不得默记 USD。
复用既有 append-only 发布 CNY 价格/计划，不引入实时 FX，不虚构一组新价格通过检查。
金额在服务内使用 BigInt，跨 JSON 边界用最小单位十进制字符串；禁止浮点乘除与前端换算权威金额。
BYOK customerPriceVersion 为 null，模型调用不扣平台 Token 钱包；BYOK 套餐支付仍遵守其订单币种。
浏览器成功页面不入账；以验签 PSP 事实及既有服务条件驱动账本变化。
支付重复、乱序、查询超时与提交 ACK 丢失只查原单，未知结果不能创建替代金融请求。
所有金融变化与审计在同 PG 事务提交；hold 和 unknown 保留到有证据或人工裁决。
退款上限、并发退款、重复 PSP 回执和到账后的套餐权益影响复用现有 refunds 机制。

### 5.4 收银台交付

钱包和套餐入口都需要本地 QR 渲染，不能继续只展示 textarea 或文本。
QR 内容必须来自服务端订单结果，浏览器不接触 PSP secret；二维码组件依赖在实现评审时选定。
页面显示币种、最小单位格式化金额、订单号、过期时间与明确状态。
复用已有客户订单查询接口轮询，包含退避、后台暂停、过期停止和恢复查询。
创建响应丢失且浏览器没有 orderId 时，不能调用只认 orderId 的现有 GET 猜测原单。
客户端使用原 POST + 原 idempotency-key + 原 payload 重入，服务端通过 `findOrderByClientRequest` 返回原单与原 binding，再按 orderId 查询。
明确关闭/过期后才允许用户显式创建新业务请求及新幂等键；不能因切商户或超时自动换键。
退款展示 submitted/processing/succeeded/failed/unknown 的现有语义映射及人工处理中提示。
只有服务端确认入账才刷新余额与权益；前端状态不得成为支付完成证据。

## 6. C 轨：性能、过载和故障恢复

### 6.1 先验证最小正式路径，再扩展压力

先用 A 正式 provision 的全新租户，通过非 seed 正式 admin/customer 入口及实际 builtin 完成首笔请求，禁止 direct SQL 代替开户。
canonical R9 使用标准 CLI 与 bench runtime/mock 固定夹具，功能及财务约束使用真 PG；它不是 builtin 真实 provider 验收。
标准开户/实际客户端工作流与 canonical R9 是两个独立 gate，分别保存证据。
旧短诊断797.59ms p99 overhead、207.23ms TTFB overhead保留。最新ae候选已执行OpenAI mock serial四腿各100：latency direct/gateway p99=8.96/731.34ms、overhead=722.38ms；TTFB direct/gateway p99=12.48/493.58ms、overhead=481.10ms、gatewayErrors=0，仍未满足30/10ms原门槛。400原始样本及关联齐全，资源记录仅有host聚合，不能据此归因外部竞争或生产容量。后续trace仅有未审草稿，暂停时未执行；cap A/B及完整R9亦未执行。
self-hosted 真实 Kimi 交替请求与直连接近，只说明该次路径；不能代替 SaaS 托管验收。
已实现的 Redis 共享配额、异步日志和 auth cache 作为基线，不重复立项。

1. 专用 runner 固定 hardware、依赖版本、payload、build、durability 配置与供给，记录持续 CPU/load/IO。
2. 原受控 serial 四腿各 100 样本对照先执行；保留原 p99 overhead ≤30ms、TTFB overhead ≤10ms，不更换 percentile 算法消除尾部。
3. 同 binary、同资源比较 cap 关闭与 cap=8 的 c=200、60 秒 A/B；关闭用环境变量 unset/empty，禁止设为字面量 off；8 仅候选，不能预设为最终容量。
4. 前项有有效结论后执行原完整 R9：SSE 10 分钟、零意外 5xx/transport、1→3 实例 ratio ≥2.7、账户精度。
5. 每个主要负载至少保留 100 个成功样本；不足记不充分，不能宣告通过。supervisor现已为完整R9的latency、TTFB、concurrency及scaling两腿补齐样本证据和失败判定，cap保留原100门槛；serial保留四腿exact100，短diagnostic保留10样本诊断语义。完整TTFB必须direct/gateway均等于配置样本数且不少于100，不接受被driver捕获后缺失的direct样本。样本充分性只是一项门禁，不能单独授予性能验收。

分开报告 HTTP 200 请求的 accepted latency、HTTP 200 successful rps 与 HTTP 429 数量/比例；这里的200是状态码，不是最低200rps吞吐门槛。保留失败原样本，R9 ratio>=2.7与c=200等既有门槛不变。
cap=8 不能仅通过拒绝大部分请求改善表面延迟；必须解释成功吞吐和拒绝率的业务容量影响。
禁止全 429 伪通过、扩大 pool/timeout 绕门槛、关闭 fsync/synchronous_commit 或删除失败样本。
单资源队列不并行 build 与 PG 压测；发现竞争、热降频或依赖异常则标记 invalid 并保留原因。
不能根据单个 Load 值直接归因；诊断结果与 acceptance 结论分别记录。

### 6.2 最小可解释 trace

同 request trace 至少记录 pool checkout wait、query/transaction、upstream send、首字节、EOF、settle。
pool checkout 必须由客户端 acquire/release 测量，PG wait event 不能冒充连接池等待。
阶段采用不重叠区间或明确 exclusive 计算，不能叠加 inclusive phase 制造总耗时。
流式 EOF 与金融 settle 分开；客户端已收到 EOF 不能证明结算完成。
仅补足定位首个真实瓶颈所需观测，优化按证据逐项实施，不先扩大架构。

### 6.3 恢复矩阵与最终不变量

| 故障注入设计 | 必须观测 | 最终不变量 |
|---|---|---|
| Redis 重启/旧 snapshot 恢复 | 准入、计数恢复窗口、重复 lease 处理 | PG 金融和累计预算不回退；软配额 RPO 单列 |
| PG 停止/commit ACK 丢失及主故障域丢失 | 原请求查询、unknown、同步副本 WAL 持久位置与恢复记录 | 按 §6.4 恢复最后已确认金融 commit；不重复扣款或派发，缺证禁止自动重开 |
| 支付/退款 worker 进程死亡 | claim/lease 超时、原单恢复 | 一个 PSP 事实最多一次账本效果 |
| PSP 重复/乱序/历史商户回调 | verifier、binding、inbox 去重、query | 原商户完成原单；退款累计不超过可退金额 |
| gateway cancel/SSE EOF 后故障 | 派发、usage、hold、settle | 不因断流重复派发；未知 hold 保留 |
| rolling drain | 新请求拒绝、在途流与结算退出 | 无意外截流；lease 和结算有可追踪归宿 |
| tenant/Key/entitlement 撤销 | 缓存失效、并发 admission、版本 | 新授权按撤销契约生效，无越权供给 |
| 长期 unknown 人工处理 | 操作权限、依据、双向审计 | 无自动释放/重派，人工结果可追溯 |

每个场景输出 before/after wallet、ledger、hold、lease 和 dispatch/inbox 快照及差异说明。
复用现有 recovery，不以“进程重新启动成功”代替资金与租约收敛证明。
人工处理必须明确操作者、证据与决议，秘密和完整用户 payload 不进入 Git。

本轮已捕获的故障/人工处置证据：

- 历史CI #149（`d4c1755`）68/68通过，其中refund worker真实SIGKILL/lease恢复和managed SSE真实SIGTERM各有PG15/18检查，共四项；不能据此宣布完整故障矩阵通过。SSE drain保证已接受HTTP流与原handler/结算收敛，WS仍采用现有主动关闭策略，不承诺继续输出到终帧。
- 最新本地fresh PG18.6 commercial/operator root完整27/27通过：正常创建、绑定非空daily billing group；保留原80 minor units（USD）hold和scanner原reconciliation reference；覆盖MFA/权限拒绝与resolve；人工决议同事务释放钱包、Key、group的80→0，留下不可变audit与observation/case双向关联；原idempotency replay不增加charge或dispatch。CP/GW billing group最小权限已修。该结果是本地真实PG/受限角色证据，不是实际上游故障或生产恢复证明。
- 另一producer的SQL `evidence_reference/outcome`列值错位已窄修，worker24/24、combined strict及上述PG27/27通过。producer窄修已独立推送`687a3c9`，operator fixture已独立推送`62b98a5`；后者#153已自然终态success，4 main+64 isolated共68/68通过，含四新增PG15/18 drill。
- Redis旧快照联合PG金融、累计预算与lease快照的profile已有静态/单元5/5及审查证据，并已完成一次真实本地执行（开发进度§29.35）：fresh build `62b98a50b95a3fa0080ddf8faac0b104bed8ddae`，Node24.18.0/PG18.6/Redis8.10.2；artifact `/private/tmp/model-router-p10-redis-recovery-20261024-run-01/redis-saas-recovery.json`为`ok=true, phase=complete`。SIGKILL Redis后恢复旧RDB，generation1→2，原三个CLI实例存活；U保留原unknown/hold/budget，S/C各12token+28charge只结算一次；U/S跨实例replay分别202/200、返回原canonicalId、无新dispatch且所有PG快照不变。`sourceChanged/distChanged/harnessChanged`均false，cleanup三项均true。`unflushedMutationLossTested=false`、`generalZeroLossClaim=false`，perf/builtin/prodKMS均false；不外推零丢失、性能、真实builtin供给或生产KMS。Redis四文件及进度§29.35已推送`f14b6f5a593a72e2309014202433ff3e1bf8842c`，其#154已68/68成功，实际执行范围仍按上述flags限定。
- PG immediate stop/start profile完整本地run06已过（进度§29.53）：确切9d候选fresh build，保持600000ms/5000ms，实际owned stop/start、三503/零新增mock、原PG身份及durability、恰1 operator_required通过。canonical202/原ID/完整JSON/全authority含11leases deep-equal，mock1→1；fresh C新增一次精确结算，原unknown hold与8192token/20480charge保留。607794ms、11 stage exit0、cleanup全true且source/dist/harness全未变。工件`/private/tmp/model-router-p10-postgres-recovery-20261024-run-06/`；早前run01探针/run02 pool crash/run03 EPERM/run04审批拒绝/run05租约断言失败仍保留，不能追溯补齐run05行来源。realProviderCalls=0，生产KMS/性能/独立同步金融恢复均不在此证据内。
- warm cached-auth撤销HTTP已完成fresh PG18 commercial run03共30/30：tenant/Key/entitlement三类、两实例warm cache全部typed403，真实prelock2/11表零变、resume B/version audit通过；无source reload、主动cache clear或新增fence竞态。保留`a246be9`此前30条旧503证据；typed403 exact21/21+strict及源码`7e4fd2852876671672688e7fcdf5a91704f8c640`已推。该revision fresh build通过，789项src/tree摘要（`d75e26…`）不变，3152项dist仅7个generated文件变化，新pool/ports已进入dist，13项harness不变；这不是跨实例Map cache已被清除的证明。
- wire COMMIT ACK窄drill已实现并验证：proxy5/5+strict、fresh PG18 settlement root2/2（保留原SIGKILL原断言，新增独立wire ACK场景）通过。真实native COMMIT连接报错，但独立PG查询证明已commit、钱包100→88、hold settled12；四个boolean证明完整frame被扣留且没有ACK透传，新direct连接按完全原input replay后快照不变。测试已推`7361160`，CI仅支持精确`postgres:5432/model_router_saas_ci`目标，runner/skip/角色护栏未放宽；该revision的#158已68/68成功，PG15/18 settlement日志各2/2、0skip，包含原SIGKILL与真wire ACK；工程checkpoint5448已纳入候选701，候选701另有完整68/68成功；后续Markdown子commit不另声称已有CI。

### 6.4 标准部署与收费前置

初始设计基线中的 Redis no AOF/cache-only 配置已修复：标准 Compose 已采用每秒 AOF、noeviction及持久卷，恢复与容量告警说明同步更新并通过配置解析。这仍不承诺软配额零丢失，不能替代下述金融持久保证。
金融 PG 保持 durability，生产 KMS、角色 IAM、凭据轮换和告警复用现有 runbook。
`deploy/README.md:299` 明确软件 KMS 为 pilot-only，不能用于收费 production。
收费生产选定策略：PG 的关键金融提交由独立故障域的同步持久副本确认，钱包/ledger、hold、dispatch/unknown 及其关联证据均须覆盖。
部署明确配置同步复制目标与提交等待语义，例如 `synchronous_standby_names` 配合 `synchronous_commit=on` 等待同步副本 WAL flush；不得静默降级为异步后继续确认金融提交。
同步副本不可用时金融提交等待或按明确超时进入 unknown，不自动改成 local/off；恢复仍查原请求。
收费 GO 必须有独立同步持久证据、提交确认边界和故障切换 fencing，并实际演练恢复包含最后已确认金融 commit 的 WAL。
没有这些证据时 C2 阻塞，不能以“PG durability 已开启”或原则性的零丢失声明替代机制与演练。
PSP 无法重建模型扣费、hold、dispatch 和 unknown；同 PG 内的账本也可能随故障一起丢失，不能仅靠 PSP 对账宣称恢复。
若同步证据丢失或无法证明恢复边界，禁止自动重开收费；保持未知状态，由人工依据独立持久证据裁决。
归档/PITR 与真实异地 backup 恢复另作灾难恢复层，不能替代同步金融提交保证。
RPO ≤15 分钟只作为非金融或非收费 pilot 的初始设计目标；RTO ≤60 分钟、保留 30 天亦待实际演练确认。
非金融 quota 的短暂计数丢失窗口独立记录，不冒充金融 RPO 或归档恢复保证。
收费 GO 还必须取得生产 KMS/IAM、异地 backup/PITR 回执、告警及运营签收。
发布候选绑定确切revision/build。[CI #169](https://github.com/elex-fu/model-router/actions/runs/40058135682)确切`9d1eb3c6350e0a97197160fdd0cb888690b02f71`，68/68 completed/success，实际A0/完整offline/PG run06见进度§29.53。后续C0门禁工程`ae911346280c3ea00e3b43c2a248cfe1026aefaa`另有fresh build及[CI #171](https://github.com/elex-fu/model-router/actions/runs/40061894166)全68/68通过，实际serial仍失败（§29.55）。文档子commit与独立CLI WIP不借用其它SHA的CI或live结论。

[历史#161](https://github.com/elex-fu/model-router/actions/runs/40041486469)、#162/87、#159/701和#158/736等确切SHA及失败见进度§29，保留历史不互借。最新9d本地PG与Kimi证据分别限定为受控恢复和正常新客闭环；不关闭真实Codex/PSP/KMS/PITR或R9门槛。

## 7. 数据迁移与回滚设计

所有 schema 变化只追加当前唯一 `SAAS_MIGRATIONS` 注册链的下一个未占编号；实施时读取 head，不能预占或修改旧迁移。
拟新增 platform access operation/journal，保存 ownership、幂等摘要、版本、阶段与审计关联。
拟新增 merchant binding/version、credential version 引用关系与不可变公有配置摘要。
拟向 orders、BYOK plan orders、inbox、refunds 增加 binding 引用；准确表名与约束以现有 schema 为准。
迁移先允许旧行空值，执行可审计的唯一性回填，隔离歧义；再按业务范围加约束和启用门槛。
不在迁移中补造金融交易、默认商户或价格，不以 direct SQL 代替正式业务操作。
operation 完成与 entitlement 激活约束必须防止 completed 但无有效权益的半状态。
预发布检查包含新版写入/旧版读兼容性、历史 callback 与并发 worker 的 binding 选择。

回滚以禁用新入口、新 merchant draining、供给 disable 与二进制兼容回退为主。
保留历史 binding、订单、账本、inbox 和 journal，不做删除金融历史的 down migration。
激活前失败的 operation 保留可查询状态；只清理由自身拥有且未被其他业务引用的资源。
一旦新订单写入 binding，新版历史处理能力必须保留，不能切回无法识别 binding 的旧 worker。

## 8. 文件级实施任务、依赖与责任

责任模型：Astra 负责设计审查与契约判断；Sol 实现；Luna 执行用户授权的验证并区分证据层级。下表记录本轮已捕获结果；未验证项不借历史绿色关闭。

| ID | 文件/模块责任 | 依赖 | 当前证据与剩余出口 | 状态 |
|---|---|---|---|---|
| P01 | 正式平台权益开通与服务端 admission readiness | P02a/已有商业服务 | 原P01开通/禁用及warm cached-auth PG30/30 typed403保留；9d正式Kimi新客A0 3/3，正常worker→verified→P01→显式Key→真实生成/usage/settlement各1、hold0，临时资源清理 | 正式新客闭环已验；真实CLI A1仍开放 |
| P02 | 单一 schema writer 的139–142迁移与精确角色授权 | P01/P06/P07/history 合同 | provider lease精确两列及CP/GW billing group最小权限已修；历史#141四目录失败保留；#149、#151各68/68成功；fresh PG18.6 commercial/operator27/27通过，fixture已推`62b98a5`；#153/`62b98a5`亦已68/68成功 | 已实现并分层验证；工程候选87完整CI通过 |
| P03 | 管理员 supply API/UI、操作与状态查询 | P01/P02a | 既有browser4/4及审计2/2保留；9d正常HTTP/MFA新客与真实Kimi供给链已过，不冒充新的真实浏览器或CLI验收 | 已实现；正式HTTP供给闭环已过，CLI待验 |
| P04 | Gemini直接桥、旧Gemini↔Anth P1修复及compiler/窄错误 | P01 契约 | 全bridge56/56通过，`9b14151`已推送；真实CLI/builtin两轮工具/thinking/取消待验，不凭pair数放开供给 | 已实现并定向验证；真实工作流待验 |
| P05 | Codex usage/continuation/history/native WS/profile/readiness | 精确后端计量/enforcement契约 | C1–C5工程及compiler/SSE/catalog修复已有分层证据，9d CI68/68通过；trusted registry仍空，Kimi A0不关闭Codex正向profile/真实后端/CLI及多实例KMS | 工程及CI已交付；可信合同/真实Codex验收开放 |
| P06 | payments parser/专用凭据/CLI/doctor/组合根 | P02b/P07合同 | 最终deployment/doctor/startup132/132；worker正式MAX_ATTEMPTS范围1..20、默认5，`a755301`已推送；真实支付凭据/merchant及运营验收待齐备 | 已实现并定向验证；真实PSP/生产证据开放 |
| P07 | binding resolver/CAS/http/workers/refunds/plans | P02b/P06 | 商户binding历史PG15/18均过，POST/promo重入7/7；producer列值窄修`687a3c9`已推，worker24/24+combined strict+最新PG27/27通过；#151/`69125a1`68/68成功，#153/`62b98a5`68/68成功；真实商户切换/回调/退款未验 | 已实现并定向/真PG验证；工程候选87 CI通过，真实PSP开放 |
| P08 | 本地 QR、钱包/套餐收银与原单恢复 | P06/P07 | web定向30/30、typecheck/build；新访问/收银browser4/4真实Chrome+local API及既有审计2/2通过；真实PSP待验 | 已实现；本地前端/浏览器通过；真实PSP开放 |
| P09 | 请求诊断、PG checkout/query/transaction、首字节/EOF/settled | P03/正式供给 | C0样本充分性工程ae已fresh build、21/21及CI171全68通过；实际serial四腿各100、完整400样本，但722.38/481.10ms开销超原门槛；trace草稿未审未执行，cap A/B和完整R9未执行（§29.55） | 门禁已交付；性能未达标，暂停定位 |
| P10 | 故障/恢复与金融hold/lease不变量 | P07/P09 | 既有refund SIGKILL/SSE SIGTERM、operator、Redis、暖cache typed403、wire ACK保留；9d完整PG run06自然600s/全canonical快照/零重放派发/新C精确结算通过，cleanup及hash稳定；历史run05失败保留 | 受控本地恢复已过；生产独立同步故障域/PITR及完整矩阵开放 |
| P11 | Redis/Compose/systemd/KMS/backup/正式CI | P06/P10 | ae另有fresh build及CI171全68通过；9d完整offline 7332pass/0fail/131skip、Kimi A0及PG run06各保留原范围；Redis generalZeroLossClaim=false、unflushedMutationLossTested=false保持 | 基础工程及本地受控恢复已验；生产外证开放，暂停 |
| P12 | 本方案与进度 §29 gate | P01–P11 | 暂停点、CLI独立WIP、实际性能失败和恢复顺序已记§29.55–57；M1/M2/M3不关闭 | 暂停交接已记录 |

可并行四 lane：A 供给 P01/P03；B 协议 P04/P05；C 支付 P06/P07/P08；D 性能/运维 P09/P10/P11。
迁移注册链、`managed-saas.ts`、CLI、runtime 主文件、共享 DTO 和进度文档必须单 writer。
P02 仍由同一 schema writer 管理唯一注册链，本轮已顺序追加139–142；后续 lane 不各自抢号。
P02a 依赖 P01 契约先行，P03 只等待开户批；P02b 在 P06/P07 接口契约冻结后后续追加，P07 实现再依赖 P02b/P06。
契约冻结可并行，不形成 P02 与 P07 实现的依赖循环，支付设计不阻塞最小新客路径。
跨 lane 只提交明确接口需求，修改共享文件由其 owner 执行；不回滚他人改动。
建议先交付 P01/P02a/P03 的最小路径，再解锁支付/性能集成，避免同时扩大待诊断面。

## 9. 验收 gate 与证据要求

| Gate | 验收范围 | 通过证据 | 阻塞时处理 |
|---|---|---|---|
| A0 | 新租户正式平台供给 | 9d正式Kimi新客3/3：正常operation/权益/显式Key/生成/usage/settlement与hold0；P01禁用/版本冲突沿各自受限PG证据，本次真实供应商仅正常首请求 | 正常真实供给闭环已过；不能替代A1真实CLI |
| A1 | 指定 CLI 协议工作流 | WIP cf5008b含A1a/A1o及27组测试源码，仅静态审阅；最后实际capture在HEAD /首错，修复后尚未再验；两轮工具、thinking、取消/重连与真实usage未关闭 | 暂停；独立WIP不作为真实工作流通过 |
| A2 | Codex 完整能力 | 后端 enforcement、opaque/remote input、reasoning 上界与真实 compact/WS | unavailable；M3 阻塞 |
| B0 | 单 Alipay/CNY | 实际 precreate、丢响应原 POST 重入、回调、到账、查询、全/部分退款及乱序 | M2 阻塞 |
| B1 | 商户/密钥历史 | 切 merchant/轮换、历史单回调退款、歧义回填隔离 | 保留 draining，禁止新启用 |
| C0 | SaaS 性能与过载 | ae实际serial四腿各100，722.38/481.10ms开销超30/10；有效cap A/B、完整R9及容量仍待验 | 暂停；恢复后先phase诊断，不改原门槛 |
| C1 | 故障恢复 | 每项故障最终金融/hold/lease 快照与人工 unknown 记录 | M2 阻塞 |
| C2 | 收费生产运维 | 生产 KMS/IAM、最后已确认金融 commit 的独立同步持久恢复演练、异地 backup/PITR、候选 commit 必需 CI、告警与运营签收 | 缺任一证据仅 pilot，丢金融证据禁止自动重开 |

证据区分源码/设计、确定性 fixture、mock 压测、真实 CLI、真实 PSP、真实生产恢复。
每份未来报告记录 git/build、dirty 状态、环境、参数、完整结果与失败；私有证据使用受控存储引用及 hash。
M1 至少 A0+A1 指定范围；M2 还需要 B0/B1/C0/C1/C2；M3 额外需要 A2 和完整 P0 协议矩阵。
旧报告只能作为历史基线，不能作为本轮实现通过证明。

## 10. 暂停点、工程余项与外部前置

用户于2026-10-24明确要求暂停开发、收敛在途并更新文档，所有owner已停止源码修改和验证。随后用户明确要求提交远程并合并main：主任务分支`codex/p0-managed-platform-2026-10-24`的`6cc79da`及CLI六文件WIP `cf5008bfc79aa344fca479b104dc973601fa0487`已整合，代码合并点为main `9f433356be0847a05f7a655a4b46dedd63309584`。独立远程分支`codex/p0-cli-workflow-2026-10-24`及工作树`/private/tmp/model-router-p0-cli-workflow-20261024`保留。当前整合版本仍待验证，不能借用ae/9d的CI与真实验收；合并未恢复trace/capture/build/load。

9d的正式Kimi A0、完整offline和PG600秒恢复证据继续有效于原范围；ae只新增C0样本门禁及其构建/CI和实际serial诊断。Redis旧RDB、operator、warm cached-auth typed403、wire ACK等保持各自证据边界。用户指定Kimi材料已有成功A0，不再作为待提供凭据项；文档不保存密钥。

恢复开发后按下表处理，当前均保持暂停：

| 优先级/任务 | 暂停状态 | 恢复后的处理方式与出口 |
|---|---|---|
| P0 / A1o真实CLI有限互通 | **已通过并完成候选绑定**：run08绑定干净候选`e988644`+fresh build，真实Claude Code 2.1.216经观察器→GW→真实Kimi完成两轮Read+三轮generation，3笔native usage逐笔结算（4573+4873+4996=14442）、wallet 985558、hold 0、ledger 4/8、4 leases释放；`f27f06c`与`e988644`（CI #40089334882）均68/68 success | thinkingModeProven/backendRevisionProven/providerHardLimitProven/productionGo保持false边界；A1o不关闭A1a、完整A1或M1 |
| P0 / C0首瓶颈定位 | **已完成**：trace诊断（200/200完整、query阶段独占~87%）+全路径静态枚举——pre-send≈150条语句+5次fsync，173ms p50≈1.15ms/条（prepared-off逐条parse/plan），~1/3为重复重验证读，p99尾部为O(增长)聚合扫描；窄修路线图已定（去重重验证~45-60ms为首选，冗余SET已移除） | 窄修①（去重重复重验证）→受控serial复测trace对照→cap A/B→完整R9；**核算提示：10ms TTFB与30ms门槛需架构级改造**（admission缓存/工作后移/流水线化），窄修不可及，需方案层预算决策；native prepared statements属部署配置（生产默认off），不用于改门槛语义 |
| P0 / C0性能与过载 | 30/10ms未过；cap A/B、完整R9尚未执行 | 按真实瓶颈窄修，受控serial有效后再cap关闭/8候选A/B、完整R9；保留c=200、60秒、SSE10分钟、ratio≥2.7、零意外错误及成功/429分列门槛 |
| P0 / A1完整指定范围 | **代码侧全部完成**：两轮工具✓（A1o）、thinking✓（enabled场景`580d408`）、取消✓（cancel场景`b1ae489` CI success：requests=1/attempts=1无重复派发、hold如实保留、取消的generation永不结算）、真实usage✓（三场景逐笔结算）、重连以取消后状态一致性+独立后续请求为可获得证据形态；backend revision保持unknown | **M1最终关闭仅剩A1a方案决策**：显式disabled为CLI结构不可满足负结论——gate修订为omitted/adaptive或接受unavailable，由方案层裁定后M1可收口 |
| P0 / B0、B1真实支付 | binding/退款/收银工程已有本地与PG证据，真实PSP未验 | 补真实Alipay主体、CNY钱包/计划、回调验签配置及受控退款额度；验证原POST重入、回调到账、全/部分退款、旧binding回调退款与歧义reconciliation |
| P0 / C2收费生产 | KMS/IAM、独立同步PG/WAL/fencing与异地backup/PITR证据未齐 | 演练最后已确认金融commit的独立持久恢复，再验异地恢复、告警和运营签收；软件KMS/异步归档及本地stop/start不替代这些证据 |
| P0 / A2 Codex完整托管 | 可信计量registry仍空，正向后端合同与真实compact/WS未验 | 获得精确endpoint/backend计量、输出enforcement、opaque/remote history合同后再登记可信profile；缺证保持unavailable，不能补造正向profile |
| 发布收口 | M1/M2/M3均未关闭；整合点`9f43335`/`89b31fd`均skip ci、无任何CI运行，ae/9d历史绿不外推 | 对最终确切候选收齐必需CI（整合后须有非skip ci的自动或已收齐运行）、相应真实工作流/支付/性能/恢复及签收；各gate分别记录结果 |

本机资源队列内，性能采样与CLI/check/build互斥；源码静态工作可按原ownership并行。恢复顺序不意味着现在已获执行GO：本次暂停期间只保存改动、收尾与文档交接。

2026-10-24同日追加一轮文档与代码核对确认（不改变暂停状态）：main HEAD为`89b31fd`（`9f43335`合并后仅一条skip ci文档提交，无任何源码变化），六个CLI文件在HEAD与WIP `cf5008b`逐文件字节一致；`observedSampleSufficiency` C0门禁、A1o/A1a两处live opt-in测试文件均在HEAD源码中；整合点`9f43335`及其后没有任何CI运行（最新仍为已取消的#172/`cf5008b`）。该确认轮实际执行：六文件scoped strict typecheck（tsc --noEmit --strict，五个TS文件exit0）、`run-commercial-postgres-gate.mjs`与trace wrapper草稿`node --check`（均语法通过）、以及27组纯测试（27/27 pass、0 fail/0 skip、约0.48s）。未运行capture/live、真实CLI/PG/负载、fresh build或任何CI；trace wrapper草稿内容审阅与执行状态不变（仍从未执行）。因此A1o恢复路径的首个动作由"静态检查+27组纯测试"推进为"仅capture"；整合候选的CI绑定仍缺失，属剩余任务。上述确认不构成A1o live、任何gate通过或M里程碑关闭。

2026-10-24晚些时候用户以明确指令恢复开发（聚焦核心能力、最大化并行）。恢复后首轮执行run04 capture：在整合main工作树以`RUN_PLATFORM_ACCESS_CLI_OBSERVATION_CAPTURE=1`运行A1o观察套件，真实Claude Code 2.1.216在HEAD `/`修复后首次推进到模型POST——capture安全投影为`messageObserved=true`、`upstreamContacted=false`、`maxTokens=512`、`thinking=omitted`、`stream=true`、`toolCount=1`，1/1 pass、0 fail/0 skip。A1o capture前置事实全部合格，进入绑定确切候选fresh build与CI、再live P01/probe/至多3次generation逐笔对账阶段；C0 trace wrapper审阅与独占诊断按互斥队列继续排队。

## 11. A1a / A1o：真实CLI工作流暂停交接

本机Claude Code实际version/help为2.1.216。三次capture均仅dummy key→自有loopback，未启动A0/probe/GW/PG或供应商。run01只有通用拒绝，run02为JSON_INVALID；补始终可用的固定transport元数据后，run03明确首请求是`HEAD /`，在读body前被METHOD_NOT_POST拒绝。因此尚无实际模型POST的max_tokens/thinking/tools事实，更无真实两轮工具或三笔账务结果；不能把候选环境变量当已观察请求。

### 11.1 已冻结的观察器与辅助请求合同

WIP仅给exact `HEAD /`新增独立预算：version/workflow每阶段最多1、总2，验证空body，返回observer自身root的404空响应，不转发GW/provider、不计入3次generation。其它未知端点仍失败关闭；不能把本地404称为已观察GW404，也不推断HEAD目的。capture在返回前刷新最终辅助计数。该修复及A1o新增尚未执行。

错误只投影固定stage/code、method/path类别、MIME/encoding类别、实读字节数桶及白名单shape；first-failure保留。无原body、prompt、未知header/URL、环境、思考文本、signature或CLI stdout/stderr。现仅分类encoding，未解压或试改compression参数。

### 11.2 两个场景保持独立

| 场景 | 入口与合同 | 暂停时证据 |
|---|---|---|
| A1a / `claude-two-read-thinking-disabled` | suite `platform-cli`；live必须capture真实thinking=disabled，omitted不放行 | 源码已实现；**2026-10-24负结论**：CLI 2.1.216无任何环境组合可产出显式disabled（unset→adaptive、MAX_THINKING_TOKENS=0→omitted，loopback探针实证），门槛在本CLI版本结构上不可满足——待方案层决策（gate修订为omitted/adaptive或接受unavailable），不以A1o/thinking场景替代 |
| A1o / `claude-two-read-thinking-omitted-observation` | suite `platform-cli-observation`；独立LIVE/CAPTURE opt-in，实际thinking omitted且max_tokens≤512、stream、唯一Read、公开model匹配后才P01/probe | **2026-10-24恢复后通过**（run07脏树/run08干净候选`e988644`）：capture+live全链路，3笔generation逐笔结算、hold 0、账务合同满足；GW x-api-key认证、Kimi thinking usage分解、CLI thinking省略回放三根因已修复（详见进度文档29.61） |
| A1t / `claude-two-read-thinking-enabled-observation` | suite `platform-cli-thinking`；独立LIVE/CAPTURE opt-in，thinking必须为实测adaptive形状（可选有界max_thinking_tokens≤1024）、max_tokens≤1536、stream、唯一Read、公开model匹配 | **2026-10-24通过**：run03（脏树）/run04（干净候选`580d408`+CI #40099149399 68/68）——真实Kimi三轮generation逐笔结算14551、wallet 2985449、hold 0、ledger 4/8；实测事实：CLI正预算即adaptive、thinking回放同样省略（与A1o一致）；thinkingModeProven=true其余边界false（详见进度文档29.66） |

官方[环境变量说明](https://code.claude.com/docs/en/env-vars)明确第三方provider下MAX_THINKING_TOKENS=0会省略thinking；省略不等于Kimi禁用。A1o只做有限互通观察，不声称enabled/disabled、供应商硬计费保证、backend revision或生产GO。正数thinking预算1024/output1536仅完成另一候选设计，未实施，不更改当前512上限。

### 11.3 工具、用量及失败状态

两个场景均复用正常MFA/注册/资金→真实worker probe→verified/P01→显式客户Key→GW，默认A0单fetch不变。driver上下文只有客户Key/origin/public model/生命周期，无SQL、完整fixture或上游Key。私有第一文件指向随机第二文件，第二文件保存opaque答案；两次真实Read/tool_result后第三个message返回答案，最多3次generation，失败尝试/重试同样计数，保持原body/headers/SSE字节。

仅A1o允许非opaque thinking/signature原样经过，在内存有界核对后续assistant历史的完整值与顺序；redacted/opaque、缺失/篡改/重排拒绝，不输出或持久化思考内容。四个native usage字段必须实际存在且合法；terminal output>512立即使观察失败并阻止后续message，但不能倒转已发生的结算。**2026-10-24实测修正**：Claude Code 2.1.216在MAX_THINKING_TOKENS=0下不回放provider thinking块（run04结构诊断实证）——thinking省略现为接受的实测CLI事实；一旦回放仍须与观察值逐字节一致且前缀有序；text/tool_use历史往返保持严格。GW侧配套事实：Claude Code原生`x-api-key`认证已被managed-saas GW接受（与Bearer同一密钥材料、同一authenticator）；Kimi含thinking响应的usage携带`output_tokens_details.thinking_tokens`（output_tokens的非加性子计数，2026-10-24直连探针+A1o实证），已建模为provider-bound验证性details，结算仍以output_tokens为权威。

成功仍严格核对三条request/attempt/usage/settlement、三账本事务/六entries、钱包总额及hold0。失败在cleanup前按fixture tenant/project/显式Key读取有限durable/资金快照，真实状态可能是settled、unknown或pending；不伪造unknown、不退款/释放/重派、不补0，诊断consumer异常也不得覆盖首错。请求上限与事后观察不包装为供应商事前硬保证。

### 11.4 保存位置与恢复验证边界

六文件WIP已独立提交推送`cf5008b`，并按后续用户授权整合至main `9f43335`，最终Astra静态审查通过。最后实际检查仍属于HEAD/A1o修复之前的run03：scoped strict/runner语法通过、三roots共23项（21pass/2skip），随后的capture在HEAD首错；这些结果不覆盖当前整合版本的27组测试源码。2026-10-24确认轮已在整合main `89b31fd`（六文件与`cf5008b`字节一致）实际重跑六文件scoped strict与27组纯测试并全部通过（27/27、0 fail/0 skip），构成当前整合版本的直接证据；capture/live与整合候选CI绑定仍需从当前确切源码执行，不重用旧绿色。成功A1o也不关闭A1a、完整A1或M1。
