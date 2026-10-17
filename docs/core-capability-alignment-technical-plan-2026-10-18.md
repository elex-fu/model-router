# model-router 核心能力对齐与生产化优化技术方案

> 日期：2026-10-18（Asia/Shanghai）
>
> 状态：设计方案，待实施；本文不表示相关改造已经完成。
>
> 本项目基线：`main@1235b98f4f9c3a3910213583733828b8021799d6`。
>
> 目标：对齐 CLIProxyAPI、Sub2API、New API 的核心使用能力，完成标准部署、计费、可靠性和运营闭环。
>
> 与旧方案关系：承接 `capability-parity-roadmap-2026-10-16.md` 的现有成果；以下按合并后代码重新划定剩余工作，不重复建设已经存在的模块。

## 1. 设计依据与边界

### 1.1 源码基线

| 项目 | 本地目录 | 本次阅读的提交 | 提交时间 |
|---|---|---|---|
| model-router | `/Users/lex/play/model-router` | `1235b98f4f9c3a3910213583733828b8021799d6` | 2026-10-18 01:21:20 +08:00 |
| CLIProxyAPI | `/Users/lex/play/CLIProxyAPI` | `911f49cbd49f4fe2516979754a7488a3fd14fe64` | 2026-10-17 02:56:09 +08:00 |
| Sub2API | `/Users/lex/play/sub2api` | `a3eb7ef302961cba716dc78b39b93b60c467db0e` | 2026-09-23 09:18:46 UTC |
| New API | `/Users/lex/play/new-api` | `6549a17eda83eaa270fd8cbb0c03623836b351d6` | 2026-10-15 18:00:20 +08:00 |

以上是确定的源码快照，不将本地副本称为各项目的最新发布版。CLIProxyAPI 为本次下载；其余复用现有源码目录。参考实现索引见第 16 节。

当前 main 与补齐分支 `4ad5032` 的文件树一致，原合并冲突已经清除。2026-10-18 本轮重新运行 `rtk proxy ./node_modules/.bin/tsc --noEmit`，退出码为 0。

此前相同文件树的单测运行记录为 5885 通过、4 失败、23 跳过；CLI 启动检查单独复测仍失败，关键词性能项单独复测通过。该记录是先前观测，不等同本轮 main 的全量测试结果。本轮没有调用真实上游、执行生产数据库迁移或重跑 R9。

### 1.2 核心对齐的定义

能力按客户能完成的操作验收，不以函数数量、路由数量或迁移数量统计完成率。

每项能力分别登记四个状态：

1. **实现**：代码与边界合同存在。
2. **装配**：标准发布包、标准 CLI 和拆分部署能够启用。
3. **验证**：真实 PostgreSQL 角色、协议合同及明确标识的真实上游样本通过。
4. **运营**：控制台可配置、故障可诊断、升级与恢复有可执行流程。

用量、账务和权限继续以 PostgreSQL 为权威；Redis 用于缓存、候选预检和协调。转换器、插件、WebSocket 和媒体任务都必须进入现有的授权、资金预留、证据、派发与结算链。

### 1.3 保留与新增范围

直接复用现有多租户、项目权限、API Key、钱包账本、支付退款、订阅、营销、Webhook、OAuth 刷新、账号探活、出口代理、授权生成器、deploy/doctor/upgrade。新增工作围绕接线、缺失协议和生产验证展开。

首批账号范围为 Codex、Claude、Gemini、Grok、OpenCode Go、OpenRouter，以及现有 API Key、Bedrock、Vertex、智谱、MiniMax 适配。Antigravity、Muse、Devin 等其他 CLI 账号进入独立供应商扩展清单；在对应适配与实测完成前，产品中明确标为未支持，不宣称供应商覆盖与 CLIProxyAPI 全量相同。

本方案核心范围包含 Responses WebSocket、Realtime WebSocket、图片/视频、HTTP 音频、Embeddings、Rerank。WebRTC、SIP、移动端客户端、完整插件市场、任意管理脚本执行、多数据库兼容不在本轮范围内。

## 2. 合并后的关键问题

下表均按当前 main 源码判断；“尚未验证”与“没有实现”分开记录。

| 编号 | 当前证据 | 需要解决的问题 |
|---|---|---|
| B01 | `gateway-runtime-module.ts:134,261` 对依赖键做精确匹配；新增 transport、媒体和 TLS 参数未进入该合同 | 新能力不能只停留在 programmatic composition 参数 |
| B02 | 新迁移 112 为计费组快照，旧 main 的故障分类 112 被移到 129 | 旧 main 数据库不能直接通过当前普通升级的历史前缀检查 |
| B03 | `provider-payload-compiler.ts:321` 只开放部分协议组合；`http-handler.ts:189` 没有原生 Gemini、count_tokens、compact 入口 | SaaS 与本地代理的兼容范围不同，四协议矩阵未闭合 |
| B04 | `postgres-request-admission-guard.ts:1068` 明确保留 Composite 名义供给计费 | 实际平台与供应商成本、利润保护之间仍有偏差 |
| B05 | `provider-http-transport.ts:1214` 通过媒体计划传 tier；图片 observed tier 固定为 null | 常规文本、SSE、专用 transport 的 tier 证据还需贯通 |
| B06 | `isModelExcluded` 和 `evaluateGrokFreeTierGate` 在源码中只有定义，无生产调用；sticky 预留带与等待状态明确未实现 | 账号状态存在写入后未消费的情况 |
| B07 | 视频结算由 `videos-query-port.ts:126` 的查询触发；异步图片由 HTTP handler 启动后台 promise | 无客户轮询、进程退出和接收结果后落库失败，需要独立恢复路径 |
| B08 | 最新完整 R9 报告仍对应 `8b4661f`，结论 FAIL；当前租户和钱包围栏仍串行 | SQL 减少和锁类型调整不能代替扩展性验收 |
| B09 | 媒体上传和 WebSocket 被明确拒绝；新管理能力主要已有后端 | 标准接口、上传资源控制、长连接计费和运营界面还需完成 |
| B10 | `managed-saas.ts:2144` 中模型广场在独立 gateway 角色下退化为 env-only / anonymous | 公共设置投影和登录态访问需要遵守现有角色边界 |
| B11 | Grok catalog 对媒体能力仍声明批次外边界 | HTTP 端点、catalog capability、rights、price 和 transport 必须一起装配 |

参考主文件均位于 `src/saas/` 或 `src/server/`；具体任务落点见后续章节。

## 3. 核心能力对齐矩阵

| ID | 客户可观察的能力 | 主要参考 | 本轮交付范围 | 发布里程碑 |
|---|---|---|---|---|
| C01 | 一套 Key 调用 Chat、Responses、Messages、Gemini | 三项目 | 四协议入口、请求/非流式/SSE 转换矩阵，明确功能损失 | M1 |
| C02 | Claude Code、Codex、Gemini CLI 完成多轮工具任务 | CLIProxyAPI、Sub2API | count_tokens、compact、思考参数、工具事件、会话归属 | M1 |
| C03 | 多账号 OAuth/API Key 接入与生命周期管理 | CLIProxyAPI、Sub2API | 既有品类标准装配、刷新、撤销、批量导入及探活 | M1 |
| C04 | 故障切换、加权路由、粘性、额度阈值与并发控制 | 三项目 | 账号/模型两级排除、三态窗口、有限等待、PG 最终准入 | M1 |
| C05 | 用户/分组/Key 配额和准确账单 | Sub2API、New API | Composite 成本归属、tier/长上下文/缓存/按量计价闭环 | M1 |
| C06 | 图片生成/编辑、视频创建/查询/下载 | Sub2API、New API、CLIProxyAPI | JSON + multipart、持久任务、原账号回查、后台结算 | M2 |
| C07 | 标准音频、向量和重排接口 | New API | speech、transcriptions、translations、embeddings、rerank | M2 |
| C08 | 多轮 Responses WebSocket | CLIProxyAPI、New API、Sub2API | 每轮独立准入/结算、连接固定账号、取消与背压 | M3 |
| C09 | Realtime WebSocket 音频会话 | CLIProxyAPI、New API | 音频计量维度、增量资金围栏、会话恢复边界 | M3 |
| C10 | 控制台完成开户、供给、定价和故障处置 | Sub2API、New API | 复用已有页面补齐新能力入口与闭环任务台 | M1–M3 |
| C11 | 稳定部署、升级、诊断、监控和恢复 | 三项目 | 标准运行时、真实健康检查、旧库升级和发布包验收 | M0–M3 |
| C12 | 插件可安装、调用、停用和回退 | Sub2API、New API | 收口现有隔离插件宿主与 typed capability 合同 | M3 |

四协议互转只保证已声明的公共语义。原生托管工具、签名 thinking、文件状态、供应商会话 ID 等特有能力逐项声明支持范围；不把“HTTP 200”当作无损转换。

New API 本地快照的 `/messages/count_tokens` 路由实际被注释停用。本项目该项主要参考 CLIProxyAPI/Sub2API，不能依据 README 推断三个项目均已开放。

## 4. 目标架构与设计决策

~~~mermaid
flowchart TD
    A["HTTP / SSE / Multipart / WebSocket"] --> B["统一入口合同与资源边界"]
    B --> C["现有身份、权限、路由与账号选择"]
    C --> F["Provider Bundle + 最终业务 Payload 编译"]
    F --> D["冻结实际目标、价格、配额、用量政策"]
    D --> E["现有 Preparation / Admission / Evidence"]
    E --> G["现有受限出口 / 代理 / 专用 Transport"]
    G --> H["原始用量与执行结果证据"]
    H --> I["现有结算 / Unknown Outcome / Compensation"]
    J["任务恢复循环"] --> E
    J --> I
    K["控制面设置与 Catalog"] --> C
    K --> L["只读公共投影与能力状态"]
~~~

两个轻量注册表各有职责：

- **Endpoint/Bridge Registry**：声明方法、路径、操作、输入形态、转换版本和支持特性；复用现有 bridge 实现。
- **Provider Bundle Registry**：装配已有 transport、credential resolver、probe、refresh、quota observer 和 catalog 注册能力。

它们不保存钱包余额、用户授权或可变价格。现有 catalog、policy 和 price version 仍是相应数据的权威。

最终业务 payload 编译属于 preparation 内部阶段，发生在计费输入冻结和派发证据签署之前。Bedrock/Vertex 等 transport 中现有的业务变换应抽成可在编译阶段复用的纯函数；发送阶段只进行凭据解析、请求签名和传输封装，避免证据签署后再次改变模型、tier 或计费数量。

| 决策 | 方案 |
|---|---|
| 主技术栈 | 保持 TypeScript/Node + PostgreSQL；沿用已存在的 Go TLS sidecar |
| 协议实现 | 逐项收敛现有转换器，共享语义与 usage 解析；不整体重写为新的大 IR 引擎 |
| 授权 | 继续由 core 构造认证、准入、证据、账务与 listener，模块不能替换这些边界 |
| 价格 | 复用有理数金额与不可变版本；常用条件定价采用结构化规则，暂不引入任意表达式求值 |
| 运行时模块 | 保留 v1 精确合同，增加显式 v2 扩展合同及内置默认装配 |
| 上传/WS 依赖 | 建议为 `busboy` 与 `ws` 作两项明确例外，实施时锁定精确版本 |
| 任务 | 复用图片/视频表与结算机器，补租约、恢复和持久输入引用 |
| 性能 | 先测量并压缩事务，再决定是否增加派生计数器；钱包 CAS 不是默认前置 |
| 权限变更 | 统一从 `privileges-manifest.ts` 生成，迁移、角色模板和负向探针一起交付 |

旧路线图“运行时依赖固定六个”的约束，在本方案中建议仅为上传和 WS 放宽：分别使用 [busboy 的流式解析](https://github.com/mscdex/busboy) 与 [ws 的客户端/服务端实现](https://github.com/websockets/ws)。不自行实现 multipart 边界解析或 WebSocket 帧协议，不引入额外框架或可选原生加速插件；WS 初期关闭压缩。该调整目前只是设计决策，未修改依赖。

## 5. R0：发布基线与迁移兼容（P0）

### 5.1 冻结当前主线，识别真实部署历史

以当前 129 迁移链为目标，后续普通新迁移从 130 起集中分配。本轮不再随意重编号已经合入的 112–129。

先用现有 migration audit 导出每个部署的历史和 schema 指纹，区分：

| 数据库历史 | 处理 |
|---|---|
| 与目标相同的 ≤111 前缀 | 普通迁移到目标 |
| 当前 112–129 前缀或完整链 | 普通迁移 / 幂等校验 |
| 旧 main ≤111 + 原故障分类 112 | 仅允许专用兼容计划 |
| 其他版本、名称、校验和或 catalog 漂移 | 写入前拒绝；先定位漂移 |

`migration-audit.ts` 继续只读。兼容执行逻辑放入独立、显式调用的升级计划，不让诊断命令自行修复历史。

### 5.2 旧 main 112 的受控兼容计划

本轮源码比较确认：旧 main `6ffa107` 的故障分类 112，与当前 129 的名称及 SQL 完全相同；按现有 `SHA256(name + NUL + sql)` 规则，二者校验和同为：

~~~text
3a74754faaf5011fb0ae07970cf1a00a9957622db4d81895abff2f281d88320f
~~~

建议新增显式兼容计划 `legacy-main-112-to-129`，在普通升级的严格前缀检查之前单独选择：

1. dry-run 检查完整源历史、旧 112 精确身份、目标 manifest、PostgreSQL major 与已评审 catalog 基线；不能仅凭 head=112 匹配。
2. 停止写入及相关后台任务，取得可恢复的 PostgreSQL 备份；保留凭据密钥与发布包版本。
3. 获取与普通 migrator 相同的 advisory lock，在事务内重新验证源指纹和实际 schema。
4. 保存兼容审计回执，将已执行的原 112 登记移到目标 129；执行尚未发生的目标 112–128，并登记其原始名称/校验和。
5. 在同一事务内验证完整目标历史、关键 catalog 约束、账本余额/预留汇总及关键记录数量，再提交。
6. 重放授权模板、按真实角色执行探针、启动目标包，再执行 smoke。
7. 失败时事务回滚；重跑只能匹配“完整源状态”或“完整目标状态”。

这是对已知历史分叉的一次显式归一化，不允许手改任意 checksum，也不削弱普通 migrator 的历史顺序和身份校验。建议新增的兼容回执仅作审计，不作为第二套迁移权威。

当前新增迁移未发现 `CREATE INDEX CONCURRENTLY` 等明显禁止事务执行的语句；实施时仍必须在真库证明整个计划可原子执行。源库 catalog 还需特别检查旧故障分类迁移与新表/触发器的组合。未知中间态不能自动推断。

**验收**：从旧 main 真库、≤111 真库和当前 129 真库分别升级；故障注入回滚；重跑两次幂等；普通未知历史仍被拒绝；旧数据、价格快照、钱包、密封凭据和角色隔离不漂移。

R0 还应统一支持的 PostgreSQL major：至少验证 compose 默认的 PG16 和实际生产 major，并清理现有夹具中 PG15/16/18 门禁口径不一致的问题。本文没有据本机某个版本通过，推断所有版本均兼容。

### 5.3 发布包验收

修复 CLI 启动检查时，分别验证源代码行为与实际 `dist/cli/index.js` 发布包。避免每个 CLI 用例都冷启动整套 TS 转译图；重复子进程超时要定位导入和初始化成本，不统一放宽 10 秒时限。

`--help`、离线配置检查和参数错误应在加载数据库、插件、Web UI、供应商模块前完成。已有 deploy/doctor/upgrade 继续复用；不能将局部数据库编排耗时当作完整生产部署耗时。

## 6. R1：标准运行时与供应商装配（P0）

### 6.1 v1 保持兼容，v2 有界扩展

现有 v1 精确白名单维持原语义。v2 在最外层先识别版本，再按固定 schema 校验依赖和扩展；未知字段仍拒绝。示意合同如下，名称为拟新增设计：

~~~typescript
interface GatewayRuntimeModuleV2 {
  apiVersion: 2;
  dependencies: RequiredGatewayDependencies;
  extensions: {
    providerBundles: readonly ProviderBundleConfiguration[];
    media?: MediaStorageConfiguration;
    tlsFingerprint?: TlsSidecarConfiguration;
  };
  checkReady(): Promise<void>;
  close(): Promise<void>;
}
~~~

`RequiredGatewayDependencies` 仍不允许模块接管认证、钱包、prepare/admission、证据验证或 listener。扩展配置携带受限参数和 secret reference，不从管理数据库加载任意 JavaScript。

新增内置运行时装配入口：正常部署选择内置 provider bundle 即可，已有可信自定义 module 继续支持。默认装配复用现有 entitlement、catalog、route、目标 URL、签名密钥和凭据服务；不会以默认值绕过缺失权限或缺失价格。

### 6.2 一次注册，贯穿所有路径

每个 bundle 明确提供下列内容，已有实现只补装配：

| 注册面 | 要求 |
|---|---|
| 供给接入 | catalog/product/capability、credential shape、导入/绑定端点、模型清单 |
| 请求派发 | 适用 endpoint scope、operation、专用 EvidenceTransport、协议转换器 |
| 账号生命周期 | probe、验证、刷新、quota observer、健康分类；统一 host/header builder |
| 商业链 | supplier price identity、usage metric、可售模型和 rights |
| 运维链 | readiness、doctor、受限出口、代理、TLS profile、关闭/回收 |
| 版本链 | adapter、converter、能力描述版本，与已签署 evidence 的兼容范围 |

Bedrock 必须进入签名/EventStream transport；Vertex 必须进入 SA token/目标模型路径；Grok 和国产供应商不得因缺少专用装配而静默走错误的 generic fallback。成功路径 quota 写入也要验证调用方存在。

Grok 图片、视频、音频应补完整 catalog/rights/operation 注册；仅注册 HTTP 路由不算能力启用。TLS profile 必须同时覆盖派发、验证、刷新和探针，否则禁止展示为统一启用。

### 6.3 运行状态可见

复用 doctor 和管理 API，展示每个能力的 enabled、assembled、ready、verification level 和脱敏原因。显式启用但缺装配在启动阶段报配置错误；账号暂时不可用按该能力返回 503，不把所有供应商一并判死。

`/v1/models` 只返回当前 Key 权限与已装配能力交集。能力说明与实际 registry 同源，避免页面标可用、派发时才发现缺端口。

**验收**：通过标准 CLI + 发布包 + 拆分角色部署，调用每类真实 HTTP mock；不得在测试中直接替换最终 handler，也不得依赖临时 bench module 才能打开新能力。

## 7. R2：文本协议与 CLI 兼容（P1）

### 7.1 统一四协议矩阵

以现有 `src/protocol/`、`responses-bridge/` 和 SaaS 专用品类 transform 为基础，将支持声明收敛到 Endpoint/Bridge Registry。compiler、pickBridge、测试矩阵和能力展示读取同一声明。

完成 Chat、Responses、Messages、Gemini 的 4×4 请求、非流式与 SSE 矩阵。优先补 Responses→Messages、OpenAI/Responses↔Gemini，以及 SaaS 尚未开放的 Gemini→Messages。已经存在的转换方向保留回归，清除可被选中却只透传的占位实现。

参考 New API 的 converter quality、独立流状态和 finalize 模型，按每对协议声明：同协议透传、转换兼容、有限支持或不支持。不强制将所有路径经第三协议中转，避免工具/思考信息多次转换丢失。

每个方向必须覆盖：

- system/developer、工具定义/选择/调用/结果、结构化输出、图片输入、reasoning/thinking。
- 缺失与显式 `0` / `false` 的差异；原生可透传扩展字段不能在 DTO 重建中无声丢失。
- SSE 多 data 行、拆包、交错 tool delta、稳定 item/tool ID、终止原因、usage、取消和背压。
- 响应模型仍为公共别名，派发/成本使用实际模型；原始用量在客户端格式转换前提取。
- 原生签名、托管工具等无法保真的特性，按该功能返回明确错误或经过配置的降级；不伪造支持。

思考参数借鉴 CLIProxyAPI 的规范化顺序：提取客户端意图 → 目标模型校验 → 供应商参数转换。管理员允许的 payload 规则在最终业务 payload 上应用一次；随后只允许 framing、序列化、签名和只读验证，冻结的计费输入必须与最终 payload 一致。

### 7.2 补齐 SaaS 入口

| 接口 | 实现要求 |
|---|---|
| `POST /v1/messages/count_tokens` | 原生上游计数优先；估算须显式标识策略，权限与模型范围完整校验 |
| `POST /v1/responses/compact` | 只走明确声明原生 compact 的供给；opaque compact item 不经 Chat 桥伪造 |
| `POST /v1beta/models/{model}:generateContent` | 从路径解析公共模型，进入现有准备与计费链 |
| `POST /v1beta/models/{model}:streamGenerateContent` | 原生 Gemini SSE 封装与错误语义，支持约定的流参数 |
| `GET /v1beta/models` | 返回当前调用方可用模型，不能直接暴露整个供应商清单 |

count_tokens 属于有资源成本的辅助操作，配置独立限流和明确计价政策；不自动占用生成请求的输出预算。所有新 operation 需同步进入 catalog、signed evidence、payload bounds、错误映射和权限测试。

### 7.3 三类客户端验收

固定 Claude Code、Codex、Gemini CLI 版本和配置，分别运行：多轮问答、并行工具、工具错误回传、思考参数、长上下文/压缩、取消及限流恢复。记录真实执行路径、本地/原生上游、转换方向和产物；仅检查 UI 或返回 200 不算完成。


## 8. R3：商业计费与用量证据闭环（P1）

### 8.1 公共销售身份与实际供给身份分开冻结

客户售价继续依据公共模型、分组、套餐和冻结的客户条款。供应商成本必须依据本次实际选中的 provider/product/model/operation 和对应成本版本。

Composite 决策产生后，先解析真实供给的商业链接，再进入 admission。每个 attempt 固定实际成本身份；重试或跨平台 fallback 重新生成该 attempt 的供应商快照。公共别名、客户价格和请求幂等身份不随内部切换漂移。

建议扩展现有 evidence/snapshot，完整携带：

~~~typescript
interface ResolvedSupplyBillingIdentity {
  providerId: string;
  productId: string;
  upstreamModel: string;
  providerOperation: string;
  supplierCostVersion: string;
  meteringPolicyVersion: string;
}
~~~

该身份由服务端解析并进入 digest，不能来自客户端。预检、claim 和 settlement 都验证同一身份。利润保护的保守成本计算和结算成本解析复用它，不再退回路由的名义 provider。

### 8.2 用量在原始上游响应处归一化

沿用现有 usage observer，补统一的有界证据对象：原始计量来源、最终 outbound tier、observed tier、账号类别、单位、模型、operation、完整性、观察时间和 adapter 版本。证据可脱敏归档，不能保存凭据或默认保存完整用户文本。

请求转换、模型重写、管理员 payload 规则结束后，冻结真正发出的 tier 和计量输入。JSON、SSE、专用 transport、WS 与插件返回同样的计量合同；SSE 完成和客户端断开分别记录，不能把“不完整”写成零。

各适配器声明计量政策：

- 上游报告 token / duration / image count：按已验证字段和单位解析。
- 请求字符计价：在最终发出文本上计数，并将该政策冻结。
- 估算计价：仅用于明确允许此政策的产品，展示为估算，不冒充上游报告。
- 缺失、非法或相互矛盾的 usage：保留 unknown/reconciliation，不能自动免费、重复扣费或释放全部 hold。

图片数量要依据实际图像负载和上游可信 usage 计数，覆盖 object/array、url 与 b64 拆分、空 payload、部分结果和客户端中断；不能简单使用数组长度。参考 New API 的图像计量边界和输入数量校验。

### 8.3 service tier 的信任规则按品类声明

Sub2API 的 `service_tier_billing.go` 除“可信响应只降低账单”外，还有 Codex OAuth 特例：其响应 default 未必代表实际降档。必须一起参考，不能只移植通用纯函数。

| 场景 | 推荐处理 |
|---|---|
| 已验证的公开 API：outbound priority、observed default | 按可信较低档计价 |
| Codex OAuth：outbound priority、observed default，适配器认定非权威 | 保留 outbound 档，记录 observed 与信任原因 |
| observed 更贵、未知或缺失 | 不由其单独提高账单；使用冻结规则 |
| Anthropic fast / usage.speed | 使用该品类单独验证的字段映射 |
| SSE/WS 中多次报告 | 按事件语义合并累计值，冲突进入异常处理，不重复累加 |

所有降档、保留和冲突均能在用量详情中解释。规则随 adapter/price policy 版本冻结，不按结算时的最新配置重解释历史。

### 8.4 定价能力分层交付

复用现有有理数、缓存、长上下文、峰谷、per_unit 和尺寸 tier。用结构化条件规则覆盖常见动态定价，不在本轮实现 New API 表达式语法的逐字符兼容。

HTTP 音频首批可按已声明的 token、字符或秒计价，每种产品固定单位。Realtime 需要分别计量音频输入与输出等真实收费维度时，扩展现有 PriceMetric/UsageValues、价格表、快照、observer、digest 和授权镜像；禁止映射成普通文本 token 或把不同单位塞入同一个 per_unit 数字。

新增 calculator/evidence 版本保持旧快照解释不变；可选空字段的 digest 策略必须有老版本重注册与重放测试。图片/视频结果超出预留上界，走现有补充资金围栏或 unknown 流程，不能产生负费用或忽略超额。

**验收**：公共别名跨两平台切换、不同 supplier cost、客户价格不漂移；公开 API 与 Codex tier 特例；缓存重复/包含关系；长上下文阈值；图像分裂 payload；重试、取消、重复回调和后台恢复只结算一次。

## 9. R4：账号池、粘性与额度运营（P1）

### 9.1 先补状态消费和传播

将同一个模型冷却实例同时交给 dispatch 反馈和 scheduler 读取；增加模型维度的排除判断。Grok free-tier 软门接入相应候选过滤。多实例下影响真实可用性的状态应有 PG 权威记录或有界共享缓存和明确的失效上界，不能只靠单进程 Map。

复用现有健康分类与故障撤离；错误区分请求错误、模型错误、账号权限、凭据过期、额度、暂时故障和流中断。模型错误不扩大为整个账号不可用，用户请求错误不惩罚账号。

Quota snapshot 携带账号/凭据版本和观察时间；旧凭据回包、过期窗口、单位不明和时钟偏移不能解除新状态。Gemini 的日配额与订阅 5h/7d 窗口分别建模，不给所有平台套同一个阈值算法。

### 9.2 补窗口三态与有限等待

参考 Sub2API 的窗口状态：

~~~text
usage < limit                 -> 接纳新会话与已有会话
limit <= usage < limit+reserve -> 仅接纳已有粘性会话
usage >= limit+reserve        -> 暂停该窗口下的调度
~~~

费用采用精确金额单位，阈值及预留带由冻结策略给出。额度只影响相应平台/模型/窗口，不覆盖 durable revoked 或权限判断。

粘性目标暂时繁忙时，返回有界 wait plan，再次尝试获取既有 PG 账号租约；等待期间不持数据库事务，不提前占用推理租约和资金 hold。建议初始默认关闭等待，启用后每请求最多 2 秒、队列长度可配、超时返回 429 + Retry-After；这些数值是初始配置建议，需压测后冻结。

session hash、previous_response_id 和会话树不互相替代。会话/响应归属至少绑定 tenant、Key 授权范围、供应商和账号；带有 opaque 上游状态的请求不能任意换号。Redis 滑动 TTL 继续保留，缓存命中后仍校验候选资格；Redis 故障回退 PG。

### 9.3 OAuth 和运营流程

复用 OAuth refresh worker 的 PG claim、凭据版本 CAS 和密封轮换。401 最多触发一次有界刷新流程；刷新期间的并发请求不能各自轮换同一 refresh token。失败要区分可重试、撤销和需重新授权，避免过期凭据反复冲击上游。

标准装配应挂载已存在的导入/绑定服务，补齐当前缺失的 Bedrock、Vertex、国产供应商等管理入口。批量导入先验证形状与归属，再密封入库；错误报告只包含可定位的条目编号和脱敏原因。

**验收**：同会话命中率目标 >95%；黄色窗口不接新会话；重置恢复；模型级限流不误伤其他模型；三实例不超发账号租约；并发刷新只有一个赢家；撤销后各实例在声明的传播上界内停止调度。

### 9.4 路由策略与模型清单

在既有策略链上明确提供优先级/权重、轮询、填满优先，以及已有成本、负载和延迟策略。权重只在通过资格、权限、窗口和租约检查的候选内生效；默认策略及 golden 保持不变，新策略按显式配置启用。

模型发现复用现有 OpenRouter/OpenCode Go 同步设施，为已装配品类补适配。区分运营者配置、上游发现和真实验证的模型；价格同步只追加新版本，不改历史快照。发现失败保留最近有效清单，不推断工具、图片或压缩能力已经可用。

配置发布采用验证/CAS/原子 generation 切换，新请求读取新版本。已准备请求继续按已有证据版本规则执行，权限撤销仍走原有授权围栏；坏配置不能替换最后有效版本。

## 10. R5：准入与多实例性能优化（P0/P1）

### 10.1 先建立新 main 的有效基线

沿用 R9 mock、流完整性 oracle 和故障注入。新增多租户种子，分别测试单租户/多 Key/同钱包、单租户多项目、至少三个独立租户。前两类不能冒充租户并行扩展。

固定发布包 digest、Node/PG 版本、CPU/内存、池大小、连接预算、上游延迟、协议、warmup 和限额。分别记录 cold start 和 warm 状态，保证测试间 outstanding 请求已经恢复或明确记录。

观测 preparation、catalog/价格解析、wallet fence wait、tenant fence wait、SQL 执行、pool wait、dispatch、TTFB 和 settlement。不能把上游等待时间算成代理 CPU 成本，也不能用降低负载、放松限额或排除失败请求制造达标。

### 10.2 两级优化，按实测选用

**第一级为默认实施**：

- 批量读取不可变价格/版本和 guard 数据，合并独立 SQL 往返；缓存只依据已验证版本，授权变化仍经过围栏。
- 在正确锁序内缩短钱包及租户互斥区，禁止持事务做网络、解密远端 KMS、对象存储或排队等待。
- 检查容量 CTE 与 reservation 查询计划/索引，保持已有 join planning 修复和授权 fencing。
- 统一连接预算和后台恢复批量大小，避免增加 gateway 就耗尽 PG pool。
- 保持现有语句预算测试，但吞吐、延迟和正确性是最终门槛。

**第二级仅当第一级不达标时实施**：

扩展已有 capacity/budget 机制，增加可对账的活动计数投影，替代每次扫描历史。reserve、release、settle、unknown、compensation、超时恢复必须在原事务中维护投影；每个请求有唯一 reservation，重复写幂等。先实现重建与差异检测，再切换读路径。

钱包余额仍来自现有账本和预留。如果确需 on-hold CAS，必须单独证明 freeze、充值、退款、correction、unknown 转移与锁序全部闭合。不得先删除钱包/租户围栏，再靠压测“没有遇到双花”判断正确。

### 10.3 硬验收

沿用既定 R9 门槛：非流式代理 p99 overhead <30ms、流式 TTFB overhead <10ms；三实例多租户吞吐 ≥单实例 2.7×；既定 c=200 场景无连接泄漏、无超发和非预期 5xx/transport timeout。

单租户单独公布容量曲线和围栏等待，至少不因增加实例而明显退化；目标销售峰值与资源配置在新基线阶段冻结，不用多租户成绩替代单租户承诺。容量拒绝、故障期 fail-closed 和真正的非预期错误分别统计。

数据库中断应在既定 5 秒边界内停止新派发并表现为协议内错误，恢复后无需人工清库或重启。故障账号撤离继续使用原故障窗 ≤5 次派发指标，并验证所有账号都故障时的行为。

## 11. R6：标准媒体接口、上传与持久任务（P1）

### 11.1 补齐标准端点

保留当前扩展接口，增加标准兼容面：

| 接口 | 处理 |
|---|---|
| `/v1/images/generations` | 同步/现有异步扩展，按供给声明支持的 response_format |
| `/v1/images/edits` | JSON 或 multipart；文件、mask、数量与尺寸都参与验证 |
| `/v1/audio/speech` | 标准 TTS；已有 `/v1/tts` 保留为显式兼容别名 |
| `/v1/audio/transcriptions`、`translations` | 有界 multipart 和实际音频计量 |
| `/v1/embeddings`、`/v1/rerank` | 支持对应 JSON 形状、模型权限与专门 usage extractor |
| `/v1/videos` 及查询/content | 固定创建时账号与商业快照；标准封装与现有扩展共用任务 |

别名必须指向同一个 operation、请求幂等域和计价政策，不能因为路径不同产生第二次扣费。新 API 不应仅登记到 routes，而遗漏 catalog、rights、价格或 providerOperation。

### 11.2 上传从“全部 JSON”扩为受控 body envelope

新增的输入形态只放在 HTTP 边界和 transport，不把文件缓冲塞进业务 JSON：

~~~typescript
type GatewayBodyEnvelope =
  | { kind: 'json'; value: unknown }
  | {
      kind: 'multipart';
      fields: readonly FormField[];
      files: readonly RequestFileReference[];
      manifestDigest: string;
    };
~~~

使用流式 parser 增量计算文件 SHA-256，落私有临时目录或受控存储。对单文件、文件数、字段数、总字节、并发上传、临时磁盘、读入时长和在途内存分别设界限。文件名不参与路径拼接；MIME/header 与媒体时长均不能直接信任。

鉴权与轻量上传资源门应在读大 body 前执行。当前资金/容量准入在 body 解析之后，不能用它声称已经限制了解析前的内存暴露。

指纹由规范化字段、重复字段顺序、文件摘要/大小和操作组成。已有 JSON 指纹版本保持兼容；multipart 使用新版本。manifest 和 opaque file ref 进入受签名的派发证据，绑定请求和所有者；临时路径不交给插件或客户端。异步接受前将必要文件转换为持久引用，清理不早于任务和资金生命周期结束。

### 11.3 扩展现有任务机器，补主动恢复

保留现有图片/视频表、原账号查询和视频 reconciliation settlement。新增字段按需要扩展：gateway request/attempt、输入 artifact、prepared evidence、provider operation ID、执行阶段、租约 owner/epoch/until、next_poll_at、结果摘要和恢复时间。

任务执行阶段与客户可见状态分开：

~~~text
admitted -> dispatch_claimed -> provider_accepted -> provider_terminal
         -> result_persisted -> settlement_terminal -> retention_expired
~~~

“发送结果未知”“结算待重试”“生成成功但交付失败”保留各自事实，不能都归为可重新生成的 failed。

在现有 gateway 工作负载中增加受 PG 租约保护的任务恢复循环，使用短事务 claim/SKIP LOCKED，提交后再做网络。复用同一账号 credential resolver、受限出口和既有 state machine；不要给 control-plane 扩大解密权限来绕过部署边界。

- 客户不再查询时，后台仍应观察视频终态并推进结算。
- 已被上游接受的任务，只回查，不重新 POST。
- 进程死亡后，只有证据证明未发送或上游提供稳定幂等保证时才允许重新提交。
- 无法查询的同步生成若在死亡时处于 sent/unknown，进入现有 unknown-outcome 流程，不承诺自动恢复内容。
- 图片对象存储失败只重试已取得结果的持久化；不重新生成。交付补偿依据冻结商业政策，经已有退款/修正账本记录。
- 客户 GET 与后台观察竞争时使用同一 CAS 与结算幂等键。
- 保留现有 `video:<taskID>` 操作证据及创建请求的 reconciliation 身份；不另开一笔视频钱包扣款。
- 未结算/unknown 任务不因内容 TTL 到期删除必要快照。内容保留期与财务证据保留期分开。

**验收**：提交后不轮询仍结算；杀死执行实例后另一实例接管；kill 在发送前、发送后、上游成功后、落盘后、结算后分别注入；无重复生成/重复扣费；不能恢复的未知结果可诊断且保留资金证据。

## 12. R7：Responses 与 Realtime WebSocket（P1/P2）

### 12.1 Responses WS 复用每轮请求生命周期

参考 New API 的串行 request worker、CLIProxyAPI 的会话/执行器分层。HTTP upgrade 只建立鉴权和有界连接资源，不以一次握手替代全部后续授权。

1. 初始按现有 Key 鉴权，校验配置的 Origin、消息上限、连接数和协议。
2. 每个 `response.create` 进入现有 prepare/admission/attempt/settlement；每轮重新检查 Key、权限、价格、配额和模型资格。
3. 连接首轮固定账号、模型与上游会话。后续轮次携带同一上游状态；改变锁定身份要求重连。
4. 同连接内已提供的 event_id + 相同指纹映射同一逻辑请求；同 ID 不同内容拒绝。无稳定 ID 的新帧作为新请求，不能宣称跨重连自动去重。
5. socket reader、取消事件和 timer 只向执行 worker 发信号，不能独立退款或释放已消费预算。
6. 调用中的账号租约与空闲 socket 限额分开，避免空闲连接长期占满推理并发。
7. before-send 的安全失败可按规则重选；已发送或已输出时不自动换号重放。
8. 断线后的 opaque response 归属继续校验。只有上游明确支持、合同实测通过时才声明续传能力。

沿用同一个原始 usage/tier observer，增加 WS event adapter。实现 ping/pong、心跳、读写队列上限、背压、取消和关闭码；慢消费者达到上限时停止上游，不无限缓存。持续消费期间不持 PG 事务。

### 12.2 Realtime WS 是独立能力门

Realtime 复用同一账本，新增明确的音频计量维度及增量资金围栏：

- 会话建立后，每次 billable turn 或受控时间片先取得本会话的额度预算。
- usage checkpoint 使用单调序号和累计高水位，重发 checkpoint 不重复累加；供应商明确的增量事件单独处理。
- 增量 reserve/reconcile 使用已有计量服务扩展，绑定同一会话和唯一操作键，不维护另一份“实时余额”。
- 预算不足时停止继续产生可计费用量；把已在途的输出和延迟 usage 包含在保守预留内。
- 若无法界定在途费用，或音频输入/输出维度尚未完整实现，该品类不开放 Realtime。
- 断线后等待终态/补充 usage；仍不完整则进入 unknown/reconciliation。
- Key 撤销、账号禁用和超时连接通过租约/配置版本检查关闭，传播上界可观测。

先完成 Responses WS，再开放 Realtime WS。WebRTC、SIP、设备凭证和全部 Live 路由保持非目标；不能因为存在 `/realtime` 路由就宣传完整 Live 兼容。

**验收**：连接中多轮独立扣费、重复帧、并发取消、慢客户端、切模型、过期 Key、账号撤销、余额耗尽、进程死亡和缺失 terminal usage；账本只出现合法的一次 reserve/settle 或待对账状态。


## 13. R8：运营界面、可观测性与插件收口（P1/P2）

### 13.1 让既有后端能力成为可完成的操作流程

复用现有客户和管理员工作区、权限判断与组件。按以下流程补页面及 API client：

| 流程 | 用户可完成的动作 |
|---|---|
| 供给接入 | 选品类 → OAuth/密钥/SA 导入 → 验证 → 模型发现 → 绑定组池 → 最小真实请求 |
| 销售配置 | 公共别名 → 实际供给 → 客户价/成本预览 → 分组配额 → 发布 → Key 调用 |
| 故障处置 | 账号/模型/窗口状态 → 最近失败原因 → 刷新/探活 → 恢复 → 查看调度去向 |
| 任务运营 | 已接受/发送未知/生成中/交付失败/待结算 → 自动恢复记录 → 合法人工处置 |
| 账务核对 | 请求/attempt/任务 → 冻结价格与供给 → 原始用量来源 → 实际费用/补偿 |
| 品牌与内容 | 公共品牌快照、custom pages、模型广场、公告、风控开关 |
| 告警与升级 | 静默与自动恢复、报表计划、发布包/迁移状态、备份和恢复点 |

模型广场公共设置通过控制面物化的只读投影提供，复用已有 brand projection 的模式。控制台 session 仍在 control-plane 校验；gateway 使用 Key 或匿名的受限公开视图。不得给独立 gateway 增加读取整个 session/private settings 的权限，只为让一个页面工作。

新增页面按功能拆分，避免继续扩展巨大的 `saas-platform.tsx`。展示价格与执行价格使用同一版本解析结果；“已实现但未装配/未实测”在管理员视图中可见，在客户可售列表中不能默认视为可用。

### 13.2 健康、观测与发布运维

新增进程存活与核心就绪端点，分别表达进程、数据库/迁移、必要依赖和 capability readiness；替换当前仅 TCP 存活的部署探针。可选上游单账号故障不使整个 gateway 不就绪；响应中不暴露密钥、内部地址或原始 SQL。

补指标：准入各阶段耗时、pool/fence 等待、账号排除原因、sticky 命中/重绑、refresh 成败、quota 新鲜度、task age、reconcile age、WS 帧/缓冲/连接数、unknown 与 grant failure。高基数字段留在受控查询与 trace，避免 tenant/request ID 直接成为 Prometheus 标签。

已有 alert、silence、report worker 继续复用。新增任务心跳与积压告警；doctor 显示“哪些能力没有装配”及最小修复指引。

沿用升级 CLI 与在线更新后端，统一目标包、校验和、兼容范围和备份策略。发布失败回滚使用 PostgreSQL 备份 + 旧包；当前 SQLite backup 不算 SaaS 数据库恢复点。涉及不可逆业务写入的升级，不承诺任意时刻无损回退。

### 13.3 插件保持宿主边界

复用现有独立 plugin-host。参考 New API 的 host-owned protocol 与 plugin-owned route 分离，补如下合同：

- 插件 manifest 声明 protocol/operation、body kind、usage schema、资源上限、允许目标和最小宿主版本。
- 启用前验证 decoder、stream/final renderer、usage extractor 与所声明能力一致。
- 插件返回数量和证据，不返回最终金额、用户身份、余额或“已经结算”的权威断言。
- host 管理鉴权、路由 pin、文件引用、task ownership、资金预留、幂等和结算。
- 凭据通过现有受限 KMS/broker 设计交接，绑定 provider/account/request；不能因为插件启用而把 gateway 全部明文凭据开放。
- 路由 generation 原子发布；in-flight 任务固定插件版本。停用后阻止新请求，旧任务保留可查询/恢复的版本。
- fallback 只在明确未派发的安全阶段发生。插件崩溃后不能把可能已经计费的请求再交给原生上游重发。

插件市场、任意 hook 脚本和批量安装生态不阻塞本轮核心发布；现有插件在标准部署下至少完成安装、启用、调用、限额、停止和回退验证。

## 14. 数据变更、上线与验收门禁

### 14.1 数据与授权变更纪律

在当前 129 之后按合流顺序分配迁移，不在本文预占多个并行编号。预计变更面如下：

| 变更组 | 主要内容 | 强制同步面 |
|---|---|---|
| 兼容回执 | 已知源/目标历史、计划 ID、执行者、备份/审计摘要 | 专用 migrator 权限；runtime 无写权限 |
| 计费身份/证据 | 实际供给身份、tier 信任政策、音频维度、计量版本 | price/snapshot/evidence/digest/observer/授权生成器 |
| 模型级状态 | 持久模型冷却或有界共享状态、窗口证据 | scheduler、dispatch、恢复、三角色负向探针 |
| 任务恢复 | request/evidence/artifact 关联、lease、next_poll_at、恢复阶段 | 图片/视频 store、后台循环、索引、内容清理 |
| 性能投影（条件项） | 活动容量计数和重建信息 | 全部 reserve/release/settle/unknown/freeze 路径 |
| 公开设置投影 | 能力说明与模型广场可公开字段 | 控制面物化、gateway 只读、缓存版本 |

新字段默认保持旧请求语义，采用显式 evidence/calculator 版本。字段默认值、未知字段、null 与零的处理都纳入兼容测试。业务数据和授权 manifest 统一评审，禁止只补 SQL 后临时把角色扩大成 owner。

### 14.2 渐进启用

遵循“扩展 schema/读兼容 → 新代码暗装配 → 单独能力开关 → 小流量 → 验收后开放”的顺序。真实部署需要的 module、sidecar、对象存储和角色契约同时进入 compose、systemd、launchd、容器包与 runbook。

不假设所有旧 gateway 都能与新 schema/证据混跑。每次发布声明可读写版本范围和最小 app 版本；不兼容时执行已有短停机升级流程。在线更新不绕过这项检查。

### 14.3 分层证据，独立标识执行路径

| 门禁 | 需要证明什么 | 不可替代项 |
|---|---|---|
| G0 静态/单元 | 类型、纯转换、金额边界、明确错误语义 | 不作为真实账号可用证明 |
| G1 真库/真角色 | 新库、旧库升级、授权、并发、冻结、补偿与幂等 | mock SQL 不能替代 |
| G2 标准装配 | 实际发布包 + 标准 CLI + 拆分部署 + 可编程上游 mock | 直接注入最终 handler 不能替代 |
| G3 真实客户端/上游 | 固定版本 CLI/SDK 与指定真实账号，协议、工具、quota/refresh | 浏览器 UI 或仅 200 不能替代 |
| G4 负载/故障/长期 | 最新镜像 R9、至少 1h soak、token 到期/刷新、kill/恢复 | 旧提交成绩和未执行脚本不能替代 |
| G5 运营与恢复 | 浏览器工作流、全流程配置、备份恢复、告警诊断 | 后端 CRUD 存在不能替代 |

G3 使用显式启用、限额的测试账号；记录凭据引用和账号类别，报告不包含密钥。凭据未提供的品类标记未验证，不以 mock 结果补齐。

关键验收案例至少包括：

1. 旧 main 112 到当前链升级、当前链重跑、未知历史拒绝、备份恢复和中断回滚。
2. 所有新 bundle 经标准入口调用；缺 transport、缺 catalog rights、缺价、缺 KMS 时产生准确错误。
3. 四协议矩阵的请求/非流式/SSE 与工具 golden；显式 0/false、usage 包含关系、取消和错误封装。
4. Composite 真实目标、重试成本、tier 信任差异、长上下文/缓存/图片数量、负数/溢出拒绝。
5. 并发刷新、revoked、过期 snapshot、模型级限流、窗口重置、粘性预留带和排队超时。
6. 任务无人轮询、进程死亡、S3 失败、重复 GET/回调、过期内容但未结算；无重发与双扣。
7. WS 同连接多轮、取消竞争、重复帧、慢读、换模型、预算耗尽和缺失 terminal usage。
8. 单租户与多租户负载、账号全故障、杀进程、PG 中断与自行恢复；所有已接受流完整性。
9. 客户与管理员完成供给接入、发布定价、Key 调用、故障恢复和账单核对，且无越权读取。

测试以业务不变量和可观察合同组织，集中扩展现有 fixture/golden，不为每个文件新增一套重复测试。发布报告逐项填写构建 SHA/digest、环境、命令、结果、跳过原因和剩余问题；不能再只用“单测 N 个通过”登记全部能力完成。

## 15. 实施顺序、任务归属与工作量

### 15.1 四个发布里程碑

~~~mermaid
flowchart LR
    M0["M0 可升级的统一发布基线"] --> M1["M1 标准文本与商业账号池"]
    M1 --> M2["M2 标准媒体与任务恢复"]
    M1 --> W["Responses WS + 音频计量"]
    M2 --> M3["M3 长连接与运营完整"]
    W --> M3
~~~

| 里程碑 | 主要工作 | 退出标准 | 预算估计 |
|---|---|---|---|
| M0 | R0、能力清单与新 R9 基线 | 迁移分叉有真库升级/回滚证据；发布包/CLI 可复现；新基线冻结 | 3–5 人日 |
| M1 | R1、R2、R3、R4、R5 第一级及核心运营入口 | 标准装配下四协议/三类 CLI、账号池与准确账务闭环；核心压力门禁通过 | 18–28 人日 |
| M2 | R6、媒体 bundle/catalog、任务台与恢复 | 标准 HTTP 媒体可用；无人轮询、重启和异常结算可恢复；真实样本通过 | 20–30 人日 |
| M3 | R7、R8 收尾、完整 G3–G5 | Responses/Realtime WS、插件和运营流程完成；长期运行与升级恢复通过 | 20–32 人日 |

合计约 **61–95 人日**，是基于当前已有代码的工程估计，不是交付承诺。若 R5 需要计数投影或钱包模型重构，另留 5–10 人日并单独评审。真实账号能力变化、迁移分叉现场状态和媒体异常恢复是主要不确定性。

### 15.2 任务拆分与依赖

| 任务 | 负责范围 | 依赖 | 必交产物 |
|---|---|---|---|
| T00 | migration/upgrade/CLI | 无 | 历史清单、兼容计划、真库升级/中断/恢复报告 |
| T01 | runtime 模块与 provider bundle | T00 固定合同 | v1/v2 loader、内置装配、capability readiness |
| T02 | 各供应商供给/验证/刷新/探活接线 | T01 | bundle 清单、导入端点、标准部署 smoke |
| T03 | protocol/registry/CLI 辅助入口 | T01 | 四协议矩阵、count_tokens/compact/Gemini、客户端 golden |
| T04 | 商业身份与 usage/tier 证据 | T01，与 T03 共定版本 | 实际供给快照、信任政策、计价/幂等回归 |
| T05 | scheduler/health/quota/sticky | T02、T04 的计量合同 | 状态消费、模型排除、有限等待、窗口恢复 |
| T06 | admission/PG 性能 | 新基线；与 T04/T05 锁序对齐 | 查询与锁分析、最新 R9，必要时投影设计 |
| T07 | multipart/媒体 HTTP 边界 | T01、T04 | body envelope、资源上限、标准端点 |
| T08 | 图片/视频持久任务 | T04、T07 | 同状态机恢复循环、故障注入、无客户轮询结算 |
| T09 | Responses/Realtime WS | T03、T04；音频计量先于 Realtime | connection/turn 合同、资源与资金围栏、真实 WS 验收 |
| T10 | web/control-plane/observability/plugins | 后端合同稳定后逐项接入 | 配置与任务台、公共投影、诊断/告警、插件闭环 |
| T11 | 发布、真上游、长期与恢复验收 | 按里程碑持续执行 | G0–G5 清单和每项证据链接 |

允许按模块分工，但数据库编号、evidence/calculator 版本、endpoint/provider contract、锁序和权限 manifest 设单一协调责任。`managed-saas.ts`、`managed-saas-gateway.ts`、`http-handler.ts` 的共享改动先冻结接口后分批合入；不再在长期大分支内累积数十项后统一宣布完成。

### 15.3 首批可直接开工的事项

1. T00：构造旧 main 112 与当前 129 两套真库 fixture，实现已知历史的兼容升级计划。
2. T01：定义 v2 runtime 扩展合同，先让一个专用 provider 和一个媒体能力经标准部署跑通。
3. T04：打通 Composite 实际成本身份与完整 tier 证据，固定新增 snapshot/evidence 版本。
4. T05：接通模型级冷却和 Grok 软门，再补窗口预留带。
5. T06：在最新 main 运行单租户/多租户基线，确认是否需要第二级数据库优化。
6. T03：以缺失入口和协议对为单元交付，持续运行真实 CLI 多轮工具案例。

### 15.4 收敛范围

本轮不增加第二套账本、第二套 OAuth 刷新器、通用工作流引擎、通用 DI 容器或自研 JS sandbox；不把全部业务搬到 Go sidecar；不为了“对齐 New API”增加 MySQL/SQLite SaaS 后端。

已有功能以复用、修复和装配为主。新增供应商数量、任意表达式语法、插件市场、Antigravity 等长尾账号、WebRTC/SIP 不进入核心发布的完成率分母；如商业需求将其列为承诺，应另立明确的能力项和验收门。

## 16. 参考源码索引与本轮核查记录

### 16.1 CLIProxyAPI：客户端、协议与账号执行

以下链接均固定在 `911f49cbd49f4fe2516979754a7488a3fd14fe64`：

| 参考源码 | 借鉴内容 | 本项目落点 |
|---|---|---|
| [server_routes.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/internal/api/server_routes.go) | count_tokens、compact、Gemini、音频、WS 等实际入口 | R2/R6/R7 的端点合同 |
| [translator/registry.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/sdk/translator/registry.go) | 请求/响应转换注册与最终规范化 | R2 Registry；缺失转换保持本项目 fail-closed |
| [thinking/apply.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/internal/thinking/apply.go) | 统一思考意图后按模型应用 | R2 参数转换顺序 |
| [auth/selector.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/sdk/cliproxy/auth/selector.go) | round-robin、weighted、fill-first、模型状态、session affinity | R4 路由策略与账号排除 |
| [auth/auto_refresh_loop.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/sdk/cliproxy/auth/auto_refresh_loop.go) | 到期任务调度与刷新并发收敛 | 扩展现有 PG refresh worker |
| [openai_responses_websocket.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/sdk/api/handlers/openai/openai_responses_websocket.go) | WS 入口与会话执行分层 | R7；账务仍使用本项目已有机器 |
| [registry/model_updater.go](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/internal/registry/model_updater.go) | 模型清单刷新与通知 | R1/R8 模型发现与原子配置发布 |

### 16.2 Sub2API：商业账号池与供给归属

以下链接均固定在 `a3eb7ef302961cba716dc78b39b93b60c467db0e`：

| 参考源码 | 借鉴内容 | 本项目落点 |
|---|---|---|
| [gateway_scheduling.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/gateway_scheduling.go) | 分组/模型候选、sticky、wait plan 与窗口费用 | R4 调度闭环 |
| [account.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/account.go) | CheckWindowCostSchedulability 的正常/粘性专用/停调三态 | R4 预留带；本项目继续用精确金额 |
| [account_scheduling_threshold_eval.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/account_scheduling_threshold_eval.go) | 按平台、窗口和账号覆盖评估阈值 | R4；不复制不适用于某平台的窗口假设 |
| [service_tier_billing.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/service_tier_billing.go) | 响应 tier 降价规则及 Codex OAuth 非权威 default 特例 | R3 的信任政策 |
| [composite_route_resolver.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/composite_route_resolver.go) | 显式路由→账号模型归属→内置识别 | 复用当前 Composite，补商业归属 |
| [openai_account_scheduler.go](https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_account_scheduler.go) | 账号能力、会话状态、负载和 quota 信号 | R4/R7 的选号资格与资源策略 |

### 16.3 New API：转换质量、媒体与统一结算

以下链接均固定在 `6549a17eda83eaa270fd8cbb0c03623836b351d6`：

| 参考源码 | 借鉴内容 | 本项目落点 |
|---|---|---|
| [relay-router.go](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/router/relay-router.go) | 原生 Gemini、compact、音频、rerank、WS 入口；count_tokens 目前注释停用 | R2/R6 的真实对标边界 |
| [text_converter_registry.go](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/relaykit/relayconvert/text_converter_registry.go) | 转换质量、request/response/stream state/finalize 合同 | R2 四协议矩阵 |
| [billing_session.go](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/service/billing_session.go) | 预留、增额、结算、退款生命周期统一 | R3/R7；沿用本项目账本和冻结纪律 |
| [task_polling.go](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/service/task_polling.go) | 不依赖客户轮询的任务推进、CAS 与失败分类 | R6 后台观察与恢复 |
| [responses_websocket.go](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/relay/responses_websocket.go) | 串行 request worker、固定 channel/model、取消不独立退款 | R7 每轮已有准入/结算 |
| [Task Plugin API v1](https://github.com/QuantumNous/new-api/blob/6549a17eda83eaa270fd8cbb0c03623836b351d6/docs/plugin-api/v1.md) | 宿主协议/插件路由分开、文件引用、用量 schema、任务版本和 SSE 边界 | R6/R8 插件收口 |

参考时优先对齐协议行为、边界案例和测试合同。若后续直接复用第三方源码，应单独登记来源、许可及修改范围，不能把参考阅读等同可以无归属地整段移植。

### 16.4 本轮新增核查结果

- main 已完成合并，文件树等于此前 `4ad5032`；本轮 tsc 通过。
- 确认 runtime v1 精确键校验与新增 composition 参数之间的装配缺口仍存在。
- 确认旧 112 与当前 129 的迁移名称、SQL 和现有身份 checksum 完全相同，为专用兼容计划提供了确定前提。
- 确认模型冷却/Grok 软门的消费缺口、Composite 名义供给成本、tier 证据缺口仍存在。
- 确认视频状态查询触发结算与图片后台 promise 的现有路径，未发现已装配的独立媒体任务恢复循环。
- 真实部署所用的迁移历史、真实账号长期状态和最新 R9 成绩仍需在实施阶段采集，本文没有将它们写成已经通过。
