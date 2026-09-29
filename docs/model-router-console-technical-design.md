# model-router 多供应商接入与管理控制台技术方案

日期：2026-09-23

状态：V2 实施基线与验收目标。已实现功能及运行方式以 [README](../README.md) 和实际管理端 `/capabilities` 为准；本文包含后续扩展目标，不代表每项可选供应商能力均已验证。

代码基线：main / 29912d8。适用范围：单机部署、单管理员、多访问 Key；保留现有 CLI 使用方式。

## 1. 目标与交付范围

建设一个能够接入 Kimi、DeepSeek、自定义 OpenAI 兼容和自定义 Anthropic 兼容服务的模型网关，并提供完整的查看、配置、用量分析和运维控制台。

供应商表示产品来源，协议表示请求/响应格式，两者独立。一个供应商可以提供多种协议端点；“OpenAI 兼容”也不代表提供 OpenAI 全部 API。

本次完整交付包含：

1. Kimi 开放平台、Kimi Code、DeepSeek Chat Completions、DeepSeek Anthropic，以及两类自定义上游预设。
2. Chat Completions 与 Messages 双向基础桥接；原生 Responses 的明确能力声明与管理。
3. 总览、上游、模型路由、访问 Key、用量、请求日志、测试台、接入指南、系统设置、账号授权，以及登录/首次引导。
4. 管理 API、配置校验和热更新、凭证管理、请求链追踪、统一 token/费用口径、历史汇总、配置审计和备份恢复。
5. 旧配置/历史日志迁移、CLI 兼容、打包部署、自动化验收及真实上游冒烟测试规范。

首版不承诺通用的文件、Embeddings、音视频、图像生成、实时 WebSocket、多机共享配额或 SaaS 多租户。已有 Gemini 和未完成的跨 Responses 桥接保持实验性状态，迁移时保留配置，不在界面标为已验证。

## 2. 当前基础与必须修复的问题

当前项目采用 TypeScript、原生 Node HTTP、Undici、Commander 和 better-sqlite3。主要逻辑集中在 [proxy.ts](../src/server/proxy.ts)，CLI 在 [cli/index.ts](../src/cli/index.ts)，JSON 配置在 [config/store.ts](../src/config/store.ts)，日志查询在 [logger/store.ts](../src/logger/store.ts)。

前一轮分析在不修改业务源码和锁文件的条件下完成 TypeScript 检查和 264 个相关测试；这些结果不等于真实供应商兼容性认证。

| 缺口 | 根因/证据 | 本方案处理 |
|---|---|---|
| 保存配置与运行行为不一致 | mergeDefaults 未保留 maxRetries、requestTimeoutMs、failoverQueue | V2 Schema 完整校验、迁移、不可变配置快照 |
| 上游新增/换 Key 不可靠生效 | KeyPool 只在启动时注册 | 基于稳定 credentialId 的增量 reconcile |
| 手动停用可能被重新启用 | HealthMonitor 修改配置 enabled | 配置启用、健康、熔断、凭证状态分离 |
| 统一预处理破坏供应商语义 | 对 openai 协议统一删除 thinking；对 anthropic 统一注入 thinking/beta | 预处理按 provider + protocol + model capability 选择 |
| 重试与请求计数混合 | 每次失败尝试和最终成功都写 request_logs | requests 与 attempts 分表 |
| 用量漏记或误解 | 非流式只区分 Anthropic 与 Chat；缓存字段口径不同 | Provider UsageNormalizer 与 usageStatus |
| 延迟与断流状态不准确 | first_token_ms 从响应后开始计时；流错误可能仍记成功 | 统一生命周期、单调时钟、明确完成状态 |
| 大查询影响代理 | better-sqlite3 同步运行在主线程 | 数据库写入/统计工作线程，查询超时与并发限制 |
| 历史数据可能直接消失 | purge 未串联可靠汇总 | 幂等聚合、覆盖检查、分层保留 |
| 可重复安装失败 | package.json 与 lock 不同步 | 实施第一阶段修复锁文件并固定 CI 运行时 |

还需修复流处理中的定时器清理、背压、未捕获异步异常及关闭顺序；这是添加实时状态和准确用量的前提。

## 3. 供应商与协议接入设计

### 3.1 内置预设

V2 将 baseUrl 定义为“API 前缀”，端点路径为相对此前缀的路径。模型名来自实时模型列表或用户填写，不将某个“最新模型”写死为长期默认值。

| presetId | 供应商/产品 | protocol | 默认 baseUrl | 请求相对路径 | 默认认证 |
|---|---|---|---|---|---|
| kimi-platform | Kimi 开放平台（国内） | openai | https://api.moonshot.cn/v1 | chat/completions | Bearer |
| kimi-platform-global | Kimi 开放平台（海外） | openai | https://api.moonshot.ai/v1 | chat/completions | Bearer |
| kimi-code | Kimi Code（国内） | anthropic | https://api.kimi.com/coding/v1 | messages | x-api-key |
| kimi-code-global | Kimi Code（海外） | anthropic | https://api.kimi.ai/coding/v1 | messages | x-api-key |
| deepseek-chat | DeepSeek Chat Completions | openai | https://api.deepseek.com | chat/completions | Bearer |
| deepseek-anthropic | DeepSeek Messages | anthropic | https://api.deepseek.com/anthropic/v1 | messages | x-api-key |
| custom-openai | 自定义 OpenAI 兼容 | openai 或 responses | 用户填写 API 前缀 | chat/completions 或 responses | 可配置 |
| custom-anthropic | 自定义 Anthropic 兼容 | anthropic | 用户填写 API 前缀 | messages | x-api-key，可配置 |

Kimi 开放平台与 Kimi Code 的地址、凭证来源和计费产品不同，向导必须分别展示，不能混用 Key。[Kimi 官方说明](https://www.kimi.com/code/docs/en/kimi-code/faq.html)、[Kimi Chat 接口](https://platform.kimi.com/docs/api/chat)。

DeepSeek 官方目前同时提供 OpenAI 和 Anthropic 兼容入口。因此给 Messages 客户端提供 DeepSeek Anthropic 预设，减少不必要的跨协议转换。[DeepSeek 接入说明](https://api-docs.deepseek.com/)、[Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

表中的 Kimi Code / DeepSeek Anthropic 前缀含 /v1，是本项目“前缀 + 相对路径”的规范化结果；官方 SDK 配置通常填写不含 /v1 的根前缀。UI 同时展示输入地址和最终请求 URL，消除歧义。

### 3.2 自定义地址与认证

- 接受自定义域名、端口、路径前缀和可选固定 query 参数；保留 /gateway/team-a 等部署前缀。
- URLBuilder 做显式目录拼接，不使用会丢失前缀的 new URL('/v1/messages', baseUrl)。
- 端点路径不允许 scheme、host、路径穿越；请求 URL 不接受客户端覆盖目标 host。
- 默认允许 HTTPS；本机/内网服务可显式配置 HTTP。探测、模型发现和真实调用复用同一出站策略。
- 不自动跟随携带认证头的跨主机重定向。Host、Content-Length、Connection、Cookie、代理密钥等不属于自由转发头。
- 支持 bearer、x-api-key、custom-header、oauth-client-credentials、受约束的 pass-through；无需鉴权的本机服务必须显式选择 none。
- 自定义 header 值可以引用 secret；认证 header 只能由认证配置生成，不能由普通 header 编辑器覆盖。
- Anthropic 版本头可以配置；未知兼容服务不自动注入 Claude 专有 beta、thinking、cache_control。

URL 测试向量至少覆盖根地址、/v1、/coding/v1、自定义多层前缀、末尾斜杠、固定 query 和旧配置迁移。不得用字符串替换全局删除 /v1。

### 3.3 对外接口与兼容矩阵

| 客户端接口 | 相同协议上游 | 不同协议上游 |
|---|---|---|
| POST /v1/chat/completions | openai 原生转发 | anthropic：基础双向桥接 |
| POST /v1/messages | anthropic 原生转发 | openai：基础双向桥接 |
| POST /v1/responses | responses 原生转发 | 既有转换暂列实验，不自动启用 |
| POST /v1/responses/compact | 仅显式声明支持的原生 responses 上游 | 不模拟压缩，不转换成普通聊天 |
| GET /v1/models | 按访问 Key 权限返回已发布的具体模型/别名 | 不实时请求全部供应商 |
| GET/HEAD /healthz | 存活/就绪检查 | 不把所有上游不可用等同进程死亡 |

其他方法/路径明确返回 404/405；未实现的协议能力返回结构化 unsupported_capability，避免落入占位桥接后产生错误调用。Responses 的查询、删除、后台任务和 WebSocket 不包含在上述接口承诺中。

基础桥接保证文本、system、常规图片、function tools、tool_result、tool_choice、结束原因、流式/非流式转换。结构化输出、思考块、签名、供应商服务端工具、音视频必须分别声明能力；不能通过丢弃字段假装兼容。

响应状态连续性需要绑定：原生 Responses 的 response_id 记录所属 proxyKeyId、upstreamId、credential/account 和 TTL。使用 previous_response_id 时路由回所属上游，禁止带着供应商状态 ID 跨上游降级；查无归属则要求完整输入或返回明确错误。该映射不保存对话正文。

### 3.4 ProviderAdapter 和 ProtocolAdapter

~~~typescript
type StableProtocol = 'openai' | 'anthropic' | 'responses';
type Support = 'supported' | 'unsupported' | 'unknown';

interface ModelCapabilities {
  text: Support;
  imageInput: Support;
  tools: Support;
  parallelTools: Support;
  structuredOutput: Support;
  thinking: Support;
  streamUsage: Support;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

interface ProviderAdapter {
  id: string;
  validateModelRequest(input: ValidationInput): ValidationResult;
  prepareUpstreamRequest(input: PreparationInput): PreparedRequest;
  normalizeUsage(input: UsageInput): NormalizedUsage;
  classifyError(input: UpstreamError): RetryDecision;
  discoverModels?: ModelDiscovery;
  fetchBalance?: BalanceReader;
}

interface ProtocolAdapter {
  protocol: StableProtocol;
  parseRequest(input: IncomingRequest): ParsedRequest;
  buildRequest(input: ParsedRequest, target: Target): PreparedRequest;
  parseStream(input: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent>;
  encodeEvent(event: StreamEvent): Uint8Array[];
}
~~~

接口为设计契约，相关输入输出类型在实施时由共享 Schema 定义。保留已有经过验证的 A↔O Bridge，通过注册表逐步迁移；不在一次改造中重写所有转换器。相同协议优先保留原始供应商字段，只改必要的 model、认证和显式策略。

预处理顺序固定为：解析客户端语义 → 校验路由能力 → 跨协议转换（如需）→ 供应商参数处理 → 设置最终模型 → 认证/出站请求。控制台可查看处理摘要，不展示密钥或完整正文。

### 3.5 Kimi 与 DeepSeek 的特殊处理

Kimi 开放平台按模型能力保留 thinking 和 reasoning_content；工具调用的历史参数、call ID 和结果需完整往返。模型发现失败可手工录入，发现到模型不等于已验证图片/工具等全部能力。[Kimi Chat 参数与流式说明](https://platform.kimi.com/docs/api/chat)。

DeepSeek Chat 的推理工具调用需要按官方要求回传 reasoning_content，不能使用当前全局“openai 就删除 thinking”的分支。参数支持与 thinking 模式绑定，由模型能力配置约束。[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

跨协议推理工具历史不做虚构或补空：优先使用供应商同协议端点；对不能保持历史语义的组合，能力检查返回错误并建议同协议路由。以后可增加专门的无损映射，但不把通用会话缓存列为首版隐式依赖。

Kimi Code 的上游权利取决于实际账号；平台额度与 Code 订阅额度分别展示。模型测试返回供应商真实错误，不通过伪装客户端身份改变服务端访问判断。

## 4. 总体架构与进程模型

~~~mermaid
flowchart TB
  SDK[模型客户端] --> Proxy[代理监听 15005]
  Browser[管理浏览器] --> Admin[管理监听 15006]
  Admin --> Static[React 静态页面]
  Admin --> AdminAPI[管理 API / 会话]
  CLI[CLI] --> Control[ControlService]
  AdminAPI --> Control
  Control --> Config[ConfigService / Revision]
  Config --> Runtime[不可变 RuntimeSnapshot]
  Proxy --> Pipeline[认证 / 配额 / 路由 / 重试 / 协议]
  Runtime --> Pipeline
  Pipeline --> Provider[ProviderAdapter / 出站请求]
  Provider --> Upstreams[Kimi / DeepSeek / 自定义]
  Pipeline --> Events[请求生命周期事件]
  Events --> DBWorker[写入工作线程]
  DBWorker --> UsageDB[(logs.sqlite)]
  AdminAPI --> QueryWorker[统计查询工作线程]
  QueryWorker --> UsageDB
  Control --> ControlDB[(control.sqlite)]
  Config --> JSON[(config.json)]
~~~

一个 Node 服务进程，共享运行时状态，两个 HTTP listener。生产代理端口默认 15005；管理 UI/API 默认 127.0.0.1:15006，可独立关闭或置于 HTTPS 反向代理后。管理 Cookie 不作为模型调用凭证。

数据库 I/O 工作线程分别承担持久化与统计；控制数据库小事务由专门持久化接口串行处理。每个数据库单写者，跨库不声称具有数据库事务原子性。

RuntimeContext 提供 ConfigService、SecretService、Router、KeyPool、Limiter、CircuitBreaker、HealthService、ProviderRegistry、RequestRecorder、JobService 和 EventBus。管理员接口调用业务服务，不通过 shell 执行 CLI，也不直接修改内存 Map。

服务生命周期：创建目录和锁 → 校验迁移 → 打开数据库 → 恢复配额/运行记录 → 构建快照 → 监听端口 → 启动后台任务。关闭时停止接入新请求，等待在途请求的有界 drain，取消超时请求，完成结算和日志 flush，最后关闭 worker/数据库。

## 5. 配置模型、密钥与配置生效

### 5.1 存储职责

| 文件/组件 | 职责 |
|---|---|
| config.json | V2 业务配置、环境变量/secret 引用、可选的文件内联凭证、访问 Key 校验摘要；唯一配置源 |
| control.sqlite | 管理员、会话、加密 secret 与加密后的内联凭证历史快照、OAuth 账号、配置提交日志、脱敏审计、任务 |
| logs.sqlite | requests、attempts、usage、配额账本、汇总、健康事件、供应商余额快照 |
| runtime snapshot | 从指定配置 revision 解析出的不可变、只读运行快照 |
| backups/ | 具备版本/校验信息的配置和数据库一致性备份 |

新实例所有路径由 dataDir 派生；自定义 configPath 默认使用其所在目录为 dataDir，可显式覆盖。旧默认目录保持兼容；多个实例必须有不同 dataDir 和 instanceId。修复当前“自定义配置仍共享默认日志库”的问题。

### 5.2 V2 顶层结构

~~~typescript
interface ConfigV2 {
  schemaVersion: 2;
  revision: number;
  instanceId: string;
  server: ServerSettings;
  admin: AdminSettings;
  storage: StorageSettings;
  quota: QuotaSettings;
  upstreams: UpstreamDefinition[];
  routes: RouteDefinition[];
  proxyKeys: ProxyKeyDefinition[];
}

interface UpstreamDefinition {
  id: string;
  name: string;
  provider: 'kimi' | 'deepseek' | 'custom';
  presetId?: string;
  protocol: 'openai' | 'anthropic' | 'responses' | 'gemini';
  enabled: boolean;
  baseUrl: string;
  endpoints: { generate: string; models?: string; compact?: string };
  auth: AuthDefinition;
  credentials: CredentialReference[];
  accountGroupId?: string;
  models: ModelDefinition[];
  priority: number;
  sortIndex: number;
  policy: UpstreamPolicy;
}

type SecretSource =
  | { type: 'env'; name: string }
  | { type: 'inline'; value: string }
  | { type: 'secret'; id: string };

interface CredentialReference {
  id: string;
  label: string;
  enabled: boolean;
  secret: SecretSource;
}

interface ModelDefinition {
  id: string;
  enabled: boolean;
  capabilities: Partial<ModelCapabilities>;
  capabilitiesSource: 'preset' | 'manual' | 'verified';
  verifiedAt?: string;
}

interface RouteDefinition {
  id: string;
  name: string;
  enabled: boolean;
  clientProtocols: StableProtocol[];
  match: { kind: 'exact' | 'glob'; value: string };
  order: number;
  publishedModels: string[];
  targets: Array<{ upstreamId: string; model: string }>;
}
~~~

示例见 [V2 配置示例](examples/model-router-console-v2.example.json)。该文件用于说明设计，不能直接交给当前 0.1.0 版本。

示例模型名仅代表文档核对时的示例，不保证账号有权限；先发现/测试再启用。示例中的 capabilities 只声明文本，省略的能力默认为 unknown，工具/图片/推理特性需补充声明或验证。原生基础字段可保留转发；请求主动依赖未知高级能力时采用严格校验，返回 capability_unverified，管理员可通过显式模型配置更新能力。

同供应商多个协议通常使用不同 upstreamId，可通过 accountGroupId 关联相同账号，供额度/认证错误去重和余额展示使用。credentials[].id 稳定，轮换只更新引用，不靠明文 Key 或数组序号关联历史。

ProxyKeyDefinition 包含 id、name、description、enabled、createdAt、expiresAt、keyHash、keyPrefix、allowedUpstreamIds、allowedModels、rpm、dailyTokens、maxConcurrentRequests。鉴权依赖摘要，轮换后 id 不变、历史仍能查询；禁用/删除不删除历史账本。

### 5.3 凭证处理

- 代理访问 Key 使用高熵随机值，数据库/配置保存 SHA-256 摘要及展示前缀，只在创建/轮换响应中返回明文一次。
- 上游 Key/OAuth token 必须可还原，使用 AES-GCM 加密持久化；主密钥由环境变量或本机受权限保护的独立密钥文件提供，不能进入配置导出和 Web 响应。
- `env` 来源的 `name` 是环境变量名，需符合变量名语法；它不是 API Key。`inline` 来源的 `value` 是直接写入 `config.json` 的上游凭证，只校验非空、不约束厂商格式。配置文件应仅当前用户可读（0600）；管理 API、UI 和脱敏导出不回传其值，配置历史副本在 `control.sqlite` 中加密。优先使用 env 或加密 Secret，内联方式仅用于明确接受本地明文文件风险的场景。
- 环境变量引用保持为引用，运行快照解析不修改原始配置。UI 展示来源及配置状态，不回传凭证值。
- 密码采用带盐的密码 KDF；不把密码、随机 API token 与上游可解密凭证混用同一种存储形式。
- 所有凭证写入为单独操作：keep / replace / remove，不允许把界面的星号掩码当新值保存。
- 脱敏导出保留引用和 requiredSecrets 清单；内联凭证值以空值遮盖，同一实例可按稳定 ID 从当前配置恢复，导入到其他实例时必须重新提供该值。

### 5.4 配置提交协议

所有写操作带 If-Match: "cfg-N"。后端取得进程内写锁，依次：

1. 校验 schema、唯一 ID/名称、URL、目标引用、模型能力与 secret 可解析性；启用上游缺失必需 secret 时拒绝，停用上游允许保留缺失引用并显示 warning。
2. 生成脱敏 diff、影响说明和下一份 runtime snapshot；不在保存期间发起模型推理。
3. 对新增 secret 先持久化，记录 prepared 提交日志；尚未引用的 secret 可在恢复时回收。
4. 将完整 raw config 写入同目录临时文件，设置权限、flush、rename，并同步目录。
5. 在同步临界区切换 effective snapshot，按稳定 ID 增量更新 KeyPool/限流/任务；在途请求保留进入时的 snapshot。
6. 标记提交日志 committed，返回 persistedRevision、effectiveRevision、restartRequiredFields。

`control.sqlite` 的 `config_journal` 以 `prepared / committed / aborted / degraded` 状态记录 base/candidate revision、规范化 JSON SHA-256、actor 与 diff paths；不保存配置正文、凭证或 secret。`config_history` 保存可回滚快照，但内联值会先加密到 secret store，再以加密引用形式保存。提交在 config.json 临时文件写入前先将 prepared 记录提交到 SQLite。之后才执行文件 fsync、rename 和目录 fsync，再构建/切换运行快照。成功应用后，单个 SQLite 事务写入 `config_history`、幂等 `config.commit` 审计事件并将 journal 标为 committed。运行时应用失败则持久化 degraded 状态及 `config.apply_failed`，保留旧 effective snapshot，不能报告成功。

启动时必须先解析并校验磁盘配置、成功构建 runtime snapshot，再于开始监听前检查 active prepared/degraded 记录。若磁盘 revision/checksum 匹配 candidate，则幂等修复 history 与 `config.commit` audit 并 finalized（degraded 表示之前运行时 apply 失败，成功启动构建候选快照后可恢复）；prepared 若匹配 base，则标记 aborted。degraded 若已被后续 committed journal 取代，只在 base revision/checksum 到当前磁盘 revision/checksum 存在逐 revision、逐 checksum 唯一链时，写入 history、`config.commit` 和 `config.superseded` 审计并标为已 superseded；缺边、多条边、历史 checksum 不一致或其他组合均拒绝启动且不覆盖配置。审计或 journal 写入失败必须在健康状态/启动错误中可见，不得静默声称回滚成功。离线 CLI 在新提交前也先构建当前 runtime snapshot 并执行同一恢复检查。

effectiveRevision 表示已应用的热配置版本；涉及监听等重启字段时仍返回 restartRequiredFields 及实际 listener 值，不能只凭两个 revision 相等显示“全部已生效”。切换前需预构建所有可能失败的运行资源，交换快照本身不执行 I/O。

热更新仅保留没有变化的 credential 冷却/故障状态；变更凭证重置其旧认证错误，不能清空所有配额。手工编辑文件由 watcher 在观察到变更后验证并构建快照，先以一个 SQLite 事务写入 base/candidate history 与 `actor=external` 的 prepared journal，再原子写入 audit 并 finalized，最后交换非失败的运行快照；若 SQLite prepare/finalize 失败，不交换快照。若 finalized 后进程崩溃、尚未交换快照，重启仍从磁盘候选配置构建。含重启字段的外部编辑也先写 prepared，再 finalize 为 `runtimeState=restart_required`，保留旧 effective snapshot 并显示 restart-required。外部变更必须恰好递增一个 revision，且不能复用同一 revision 存放不同内容；revision 跳跃或 checksum/历史冲突均拒绝热应用。由于文件已被外部进程写入后 watcher 才能观察，外部编辑不能声称满足“rename 前 prepared”；崩溃前未记录的外部写入由下次启动从磁盘配置加载，checksum 冲突时仍拒绝任何 journal 恢复。

CLI 运行时通过本机 control socket 调用同一 ControlService，文件/socket 权限仅当前用户可用；服务停止时 CLI 获取跨进程配置锁后离线写入。禁止 Web 与 CLI 两个独立 read-modify-write 覆盖彼此。

| 字段类别 | 生效规则 |
|---|---|
| 路由、权限、启停、新上游、凭证、超时/重试 | 新请求立即生效；正在处理的请求维持原快照 |
| 配额上限 | 下一次 admission 生效，不重置已用量 |
| 保留期、探测间隔、价格 | 后续任务/新请求生效，历史不自动重计价 |
| 端口、监听地址、dataDir、数据库路径 | 持久化但需重启；UI 显示 desired/effective 差异 |
| 日配额时区 | 新版本从下一个完整结算周期生效，保留历史周期标识 |

## 6. 路由、故障切换与运行状态

### 6.1 路由算法

1. 校验模型与访问 Key 权限。allowedModels 匹配客户端请求名，allowedUpstreamIds 限定每个候选上游。
2. 找到 exact 规则；否则按 order 找到首个匹配 glob；没有匹配返回 model_not_found。检查规则的 clientProtocols，不允许的协议返回 unsupported_client_protocol，不偷偷退回更宽泛规则。
3. 按规则中的 targets 顺序处理候选，应用配置启用、能力、健康、熔断、可用凭证过滤。
4. 选择可用 credential；执行后根据错误分类切换 Key/上游。

V2 routes 是映射与顺序的唯一来源。旧 modelMap/models/priority/failoverQueue 在迁移时编译成规则，不保留两套可独立编辑的路由真相。相同优先级保留旧插入顺序；相同 pattern 的候选合并；跨上游重叠 glob 的旧行为通过 legacy-compiled 模式保留并显示预览，用户显式转换后才采用 V2 首匹配语义。

“原生优先”由向导给出的候选排序和协议提示实现；运行时尊重用户保存的 targets 顺序，不再隐式重排。停用规则完全不参与匹配；命中但所有目标不可用时返回可解释错误，不绕过更具体规则的约束。

publishedModels 提供可列举的别名，glob 不自动展开成无限列表。GET /v1/models 根据权限返回具体 publishedModels，隐藏内部 URL/凭证；临时熔断不让模型列表反复消失。

路由预览返回候选顺序、实际模型、协议、匹配规则、桥接方式和排除原因。预览不调用 CircuitBreaker.allow()、不消耗 half-open permit、不轮转 Key、不计配额。

### 6.2 错误与重试

maxAttempts 表示包含首个请求的总尝试数；rectifier 重发也计一次 attempt，解决旧 maxRetries 命名与含义不一致。每次请求保留已尝试 credential 集合，避免轮询重复消耗同一 Key。

| 情况 | 默认策略 |
|---|---|
| 输入格式错误、能力不支持、无模型权限 | 不请求上游；返回 400/403/404 与稳定错误码 |
| 上游 401/403 | 按 provider 分类为 credential/account 错误；隔离错误凭证，允许其他独立凭证；不计供应商 5xx 熔断 |
| 上游 429 | 优先解析 Retry-After；按 key/account/upstream 作用域冷却；总预算允许才换独立候选 |
| 明确余额不足 | 标记账号不可用；不盲目换同一账号的多个 Key |
| 网络错误、408、5xx、发送前超时 | 未向客户端提交响应时，在预算内重试；仍可能产生上游重复计费，记录 outcomeUnknown |
| 一般 400/422 | 不全局重试；特定、经过测试的 rectifier 可重发一次并记录修改类型 |
| 客户端取消 | 中止上游、释放预留，不再重试 |
| 已发出响应头/流事件后失败 | 不切换上游拼接回答；记录 upstream_error/client_cancelled/truncated |

建议默认 maxAttempts=3、connectTimeoutMs=10000、firstByteTimeoutMs=60000、streamIdleTimeoutMs=60000、totalRequestTimeoutMs=300000；长推理模型可配置更长预算。所有等待共享剩余总预算，采用有上限的抖动退避。旧配置迁移保留原有效超时，不默默改成新默认。

### 6.3 健康与熔断

UpstreamRuntime 分别暴露 configEnabled、healthStatus、circuitState、availableCredentials、inFlight、lastSuccessAt、lastError、nextProbeAt。探活永不改写 configEnabled。

默认以真实流量被动健康观测为主；主动生成探测需在 UI 显式启用并设频率、测试模型和 token 上限，所有探测记 source=health。模型列表读取只证明认证/目录可用，不能证明推理或工具调用可用。

手动停用后不再主动探测；运维点击“测试停用上游”是一次独立动作，不恢复启用。恢复仅改变健康状态。半开探测通过租约管理并保证成功、失败、取消均释放 permit。

## 7. 请求生命周期与流式处理

每个入站请求创建 requestId；每次出站创建 attemptId，并在响应 header 返回 x-request-id。请求路径、模型、source、代理 Key ID 和 configRevision 在开始时固定。

状态机：received → rejected 或 admitted → routing → connecting → streaming/nonstream → completed/failed/cancelled/interrupted。HTTP 200 不能单独作为流成功标志。

- 使用单调时钟计算总时长、上游首字节、首事件、首文本；墙钟只用于 UTC 时间戳和查询。
- firstByteMs 是上游响应首字节；firstEventMs 是首个有效协议事件；firstTextMs 是首个文本 delta。工具-only 请求 firstTextMs=null，不用零表示。
- SSE 解析需要支持 UTF-8 分片、跨 chunk 行、CRLF、多行 data、心跳、tool arguments 增量、终止事件和流内 error。
- 优先单次增量解析并顺序写出，避免无限 tee 缓冲；res.write=false 时等待 drain，设置有界缓冲。
- 一个可刷新 idle timer，结束后清理全部 timer/监听器；断连取消 reader 和 fetch。
- 所有控制路径最终调用一次 finalize；usage 解析失败也必须留下请求记录。
- usage 的累计事件取最新累计值，不逐帧相加；协议终止与最终 usage 缺失分开记录。
- 代理不默认保存 prompt、completion、thinking 原文。测试台响应只保留在当前浏览器内存，刷新后清除。

## 8. 用量、配额与费用

### 8.1 统一用量模型

~~~typescript
interface NormalizedUsage {
  inputTotal: number | null;
  inputUncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  outputTotal: number | null;
  reasoningOutput: number | null;
  status: 'reported' | 'partial' | 'missing' | 'estimated';
  source: 'upstream' | 'local-estimate' | 'legacy';
  semanticsVersion: string;
}
~~~

字段均非负。缺失不填零；reported 表示核心输入/输出有可信报告，不表示每个细分字段都存在。reasoningOutput 属于 outputTotal 的分项，不能再次相加。

| 上游口径 | 归一化规则 |
|---|---|
| OpenAI Chat 兼容标准 | inputTotal=prompt_tokens；cacheRead=prompt_tokens_details.cached_tokens；outputTotal=completion_tokens |
| Kimi 开放平台 | 优先用 prompt_tokens_details 缓存字段；兼容顶层 cached_tokens，字段同时存在只取一个来源 |
| DeepSeek Chat | inputTotal=prompt_tokens；cacheRead=prompt_cache_hit_tokens；inputUncached=prompt_cache_miss_tokens；与总量交叉检查 |
| Anthropic 官方语义 | inputTotal=input_tokens + cache_read_input_tokens + cache_creation_input_tokens；保留缓存写入 TTL 分项 |
| 自定义 Anthropic 服务 | 默认采用声明的 Anthropic 语义，可明确设置 inputIncludesCache；探测不能仅凭字段名自动猜测 |
| Responses | inputTotal=usage.input_tokens；outputTotal=usage.output_tokens；缓存字段按原生 usage details 解析 |

OpenAI 流式 usage 通过上游支持的 include_usage 获取；流中断可能没有最终用量，因此必须显示 partial/missing。[OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

Anthropic 缓存输入与普通 input_tokens 是独立组成部分；按旧的 input+output 直接相加会漏掉缓存输入。[Anthropic 缓存计数](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。DeepSeek 缓存命中与未命中字段按其官方定义解析。[DeepSeek 缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)。

### 8.2 统计与配额口径

区分 logicalRequests、upstreamAttempts、providerUsage、quotaUsage 四类量：

- 一个客户端请求只计一次 logicalRequests；多个尝试分别计 upstreamAttempts。
- providerUsage 累加各次有报告的上游消耗，包括失败但有消耗的尝试；不把未报告的失败当零费用。
- 默认 quotaUsage 采用所有尝试可确认的 inputTotal+outputTotal；迁移实例保留 legacy_v1 口径至下一周期，由 UI 明示切换。
- RPM 按通过鉴权并进入 admission 的请求计数，重试不重复计；被 RPM 拒绝的调用进入 rejected 统计，不再增加 admitted RPM。
- 总览成功率默认 completed / 已结束且已 admission 的 production 请求；取消、失败分别列出。认证失败和配额拒绝单独展示，不混进上游可靠性指标。
- source=production、playground、health 分开；默认总览仅 production，费用页可查看所有来源。
- 请求数按 startedAt 归属；供应商用量/费用按 attemptStartedAt 归属；日配额按 admission 时固定的 quotaPeriod 归属。跨天完成不会转移旧请求的配额扣减。

配额实现采用预留—结算：

1. admission 原子检查 RPM、并发数、已用+预留，持久化 quota reservation 后才向上游发送。
2. 根据可用 tokenizer/估算器、输出上限和尝试预算预留；每次重试前补足下一次预留。
3. 结束时以报告量结算并释放剩余预留；缺失 usage 采用显式配置的估算策略或保留待核对额度，不自动释放为零。
4. 数据库不可用且请求配置了持久配额时返回可重试 503；不默默绕过限额。
5. 重启恢复未结算 reservation，标记 interrupted；默认将已发送尝试的预留转为 estimatedUsed，未发送预留释放，UI 显示未确认消耗；若策略选择 retain-reservation，最长保留至该配额周期结束再转 estimatedUsed，不能永久占用并发槽位。

管理员可提交带 reason 和幂等 ID 的 quota adjustment 修正账本，保留原始报告/估算值和审计，不直接改写供应商用量。调整只影响对应账期，不自动重置当前 Key 的全部用量。

这是预算控制而非供应商账单的严格硬上限。未知 tokenizer、缺失 usage 和已发生的上游计费可能造成差异；UI 显示 reported/estimated/unknown 和最大并发，不能承诺分毫不差的账单额度。

默认 quotaTimezone=UTC，与旧行为一致；页面显示本地时间及明确的下一次重置时刻。更改时区新建周期版本，下一完整周期起生效，不立即清零。

### 8.3 费用与余额

价格配置按 provider/product + model + effectiveFrom + currency + pricingVersion 保存，不抓取网页价格后静默覆盖。实际用于请求的价格版本固定在 attempt。

费用以十进制定点值/整数微币存储，不用浮点累加。按互斥 token 类别计算：

~~~text
估算费用 =
  未缓存输入 × 普通输入单价
  + 缓存读取 × 读取单价
  + 缓存写入（按 TTL 分类）× 写入单价
  + 输出总量 × 输出单价
~~~

价格表明确缓存写入是否已包含在普通输入价格中，缺少价格或 token 分类时返回 partial/unknown，不当零元。需要上下文阶梯或服务层级定价的服务，通过有版本的 pricing profile 处理。不同币种分别汇总，未配置汇率不直接合计。

Kimi Code 订阅用量不换算成平台 API 账单；可显示用户提供的参考估算但必须单独标记。上游余额是独立、带 fetchedAt/status 的账号快照，不能由本地 token 反推。

BalanceReader 按供应商官方可用接口实现并独立验收；暂未验证的接口显示 unsupported/unavailable，不影响代理或本地用量页。本次资料核对中 DeepSeek 余额文档未成功读取，具体字段/刷新策略列入接入验收，不能以推测的响应结构实现。

## 9. 数据库与历史统计

### 9.1 表与关键字段

| 表 | 主键/关键字段 | 用途 |
|---|---|---|
| requests | id、proxy_key_id、source、client_protocol、request_model、route_id、config_revision、state、final_http_status、started_at_ms、ended_at_ms、duration_ms、first_*_ms、attempt_count、final_upstream_id | 一次请求最终事实 |
| attempts | id、request_id、ordinal、upstream_id、credential_id、resolved_model、reported_model、protocol、outcome、status、retry_reason、started_at_ms、ended_at_ms、usage_status、usage_version、token 分项、pricing_version、cost/currency | 每次上游尝试及用量 |
| quota_reservations | request_id、proxy_key_id、period_id、reserved_tokens、settled_tokens、state | 并发配额和异常恢复 |
| quota_periods | proxy_key_id、period_id、start/end、timezone/version、reported_used、estimated_used、reserved | 持久配额账本 |
| quota_admissions | request_id、proxy_key_id、admitted_at_ms | RPM 重启恢复，短期保留 |
| request_aggregates | bucket、timezone_version、key/model/protocol/source/final_upstream、最终状态计数、时长 sum/count、延迟直方图 | 逻辑请求统计 |
| attempt_aggregates | bucket、upstream/credential/model/protocol/source/currency/pricing_version、usage completeness、token/cost、错误计数 | 供应商消耗统计 |
| health_events | id、upstream_id、credential_id、from/to、reason、created_at | 健康与熔断历史 |
| response_bindings | response_id、proxy_key_id、upstream_id、credential_id、expires_at | 原生 Responses 连续性 |
| balance_snapshots | account_group_id、currency、available、status、fetched_at | 可选供应商余额 |
| users / sessions | user ID、密码摘要；session token hash、过期时间 | 管理员认证 |
| secrets / oauth_accounts | secret ID、密文/key version；provider、授权状态、refresh 时间 | 上游凭证与账号 |
| config_commits / audit_events / jobs | revision/checksum/state；actor/action/diff；type/status/progress | 配置恢复、审计、后台任务 |

代理请求和尝试不能使用一张宽表的 COUNT(*) 同时代表请求数和尝试数。按上游过滤时，请求榜默认按 final_upstream_id；“参与过该上游”是另一个显式过滤语义，不能与前者混用。

索引至少包括 requests(started_at_ms,id)、requests(proxy_key_id,started_at_ms,id)、requests(state,started_at_ms,id)、attempts(request_id,ordinal UNIQUE)、attempts(upstream_id,started_at_ms,id)、attempts(resolved_model,started_at_ms,id)。所有 ID/名称使用绑定参数，分组/排序列走白名单。

列表使用 (started_at_ms,id) 游标，默认 50、最多 200；统计限制时间范围、维度基数和并发；CSV 异步导出有行数/文件大小上限。

### 9.2 持久化可靠性与汇总

创建 admission/reservation 在后台 worker 确认后才出站；完成事件按 requestId/attemptId 幂等 upsert。正常目标为 250ms 或 100 条完成事件落盘。写入失败保留有界队列并退避；超限标记 recorderDegraded，需可靠配额的请求拒绝 admission。进程崩溃可能丢失未落盘的最后用量，因此保留初始记录、reservation 和 completeness 标识，不声称零损失。

默认原始请求/尝试 30 天、分钟统计 7 天、小时统计 90 天、完整日统计 400 天，均可配置。桶只在出现数据时生成；先通过真实流量规模评估磁盘，再确定生产保留量。

聚合由持久化事件序号驱动。每次消费在同一事务中更新请求/尝试聚合与 watermark，重复消费不增加计数；迟到的完成事件可补旧桶。重建聚合按指定桶在事务中替换，不能在删除原始数据后再次用残缺明细覆盖完整汇总。

清理任务仅删除已完成、已覆盖汇总、无未结算引用的数据。历史 percentile 使用可合并直方图，返回 approximate=true；不对每日 P95 再求平均。

查询优先使用完整覆盖的一种粒度；拼接明细与聚合时采用不重叠半开时间区间。超过明细保留期只支持对应归档粒度/已有维度；任意分钟范围或不同日切时区不能精确回答时，返回 coverage/granularity 限制，不能输出伪精确数字。

所有 API 返回 observedAt、dataThrough、partial、missingUsageRequests、grain、coverage；无数据与查询失败分别表示。

## 10. 管理 API 契约

统一前缀 /admin/api/v1，使用管理员会话。JSON Schema 为前后端类型、运行时校验和 OpenAPI 文档的共同来源；采用 Zod 实现，避免维护三套字段定义。

~~~json
{
  "data": { "persistedRevision": 18, "effectiveRevision": 18 },
  "meta": {
    "requestId": "admin_req_example",
    "observedAt": "2026-09-23T04:00:00Z",
    "restartRequiredFields": []
  }
}
~~~

~~~json
{
  "error": {
    "code": "CONFIG_REVISION_CONFLICT",
    "message": "配置已被其他操作更新，请合并后保存。",
    "details": { "expected": 17, "actual": 18 },
    "requestId": "admin_req_example"
  }
}
~~~

HTTP 语义：400 格式错误、401 未登录、403 无权限、404 不存在、409 业务引用冲突、412 If-Match 过期、422 语义校验、428 缺少写版本、429 管理 API 限流、503 管理依赖不可用。代理协议错误封装与管理 API 分离。

| 方法与路径（相对于前缀） | 功能 |
|---|---|
| GET /bootstrap；POST /bootstrap | 初始化状态；带本机一次性 bootstrap token 创建管理员 |
| POST /session；GET /session；DELETE /session | 登录、当前会话、退出 |
| GET /system；GET /overview | 服务状态、desired/effective config、概览。`/system.listeners` 分别报告 proxy/admin 的 configured 与实际 socket bind address/port；未启用或尚不可读时 `actual` 为 null。`/system.databases.control` 和 `/system.databases.telemetry` 使用 `health.scope=connection` 表示 `db.open` 与 `SELECT 1` 的连接可用性，并提供 SQLite `page_count`、`page_size`、`freelist_count` 容量估算；指标不可用时以 null 和原因码表示，不包含文件路径。周期轮询不执行 quick/integrity scan；完整性检查仅由显式 maintenance job 执行。 |
| GET /provider-presets；GET /capabilities | 接入预设、功能矩阵与实验能力 |
| GET/POST /upstreams；GET/PATCH/DELETE /upstreams/:id | 上游列表与详情、创建更新删除 |
| POST/PATCH/DELETE /upstreams/:id/credentials[/:credentialId] | 凭证新增、替换、禁用、删除 |
| POST /upstreams/:id/discover-models | 返回发现结果，不自动发布模型或覆盖手动配置 |
| POST /upstreams/:id/test | 创建一次受限测试任务，返回 202 + jobId |
| GET /upstreams/:id/runtime；GET /upstreams/:id/health-events | 健康、熔断、Key 冷却及历史 |
| POST /upstreams/:id/circuit-reset | 管理员明确重置熔断，审计记录 |
| GET/POST /routes；PATCH/DELETE /routes/:id；PUT /routes/order | 路由 CRUD、整体排序（CAS） |
| POST /routes/preview；GET /models | 无副作用预览、管理模型目录 |
| GET/POST /keys；GET/PATCH/DELETE /keys/:id；POST /keys/:id/rotate | 代理 Key 管理，创建/轮换一次性返回 secret |
| GET /keys/:id/quota | 当前周期用量、预留、RPM、并发与重置时刻 |
| POST /keys/:id/quota-adjustments | 指定账期、原因与幂等 ID 的配额修正，保留审计 |
| GET /usage/summary；GET /usage/timeseries；GET /usage/breakdown | 汇总、趋势和分组 |
| GET /requests；GET /requests/:id；GET /requests/:id/attempts | 请求列表、详情和尝试链 |
| POST /exports；GET /exports/:id/download | 有范围和大小限制的 CSV 异步导出 |
| POST /playground/runs；POST /playground/runs/:id/cancel | 管理员测试运行与停止，响应为流 |
| GET /connect/templates | 按选择的客户端、模型、公开地址生成占位凭证模板 |
| GET /config；POST /config/validate；PUT /config | 脱敏原始配置、diff 校验、CAS 提交 |
| POST /config/import-preview；POST /config/import；GET /config/export | 导入预览、原子替换/显式合并、脱敏导出 |
| GET /config/history；POST /config/rollback | 版本、差异与生成新 revision 的回退 |
| GET/POST /pricing；PATCH /pricing/:id | 模型价格和生效时间 |
| GET /accounts；POST /accounts/client-credentials | 账号列表、OAuth 客户端凭证配置 |
| POST /accounts/device-flows；GET/DELETE /accounts/device-flows/:id | 设备授权启动、状态、取消 |
| PATCH/DELETE /accounts/:id；POST /accounts/:id/refresh | 绑定/默认账号、移除、刷新 |
| GET /balances；POST /balances/refresh | 可选余额快照及限频刷新 |
| GET /audit-events；POST /maintenance/jobs；GET /jobs/:id | 审计、汇总/清理/备份/维护进度 |
| GET /events | 状态失效通知 SSE；支持 Last-Event-ID 或通知客户端重新拉取 |

所有写接口标注是否需要 If-Match/Idempotency-Key。创建 Key/轮换只在本次成功响应给出明文；网络丢失后查询只返回创建结果和掩码，需要再次轮换获取新值，不能自动重试生成多个 secret。

usage 查询参数：from/to 为带 offset 的 ISO8601，采用 [from,to)；keyId、upstreamId、model、protocol、source、currency、grain、groupBy 为有限集合。日期选择器负责转换明确的统计时区边界。

## 11. 页面与交互设计

### 11.1 全局结构

桌面左侧导航 224px，顶部服务状态/实例名/时区/时间范围/刷新，主体最大宽度随视口伸展。详情使用可深链的页面或右侧抽屉；窄屏收起导航、表格横向滚动，关键操作保持可达。

风格使用中性底色、清晰分隔、等宽数字和模型 ID。状态用文字+图标+颜色，不能只靠红绿。优先实现中文、键盘导航、可见焦点、表单错误定位和浅/深主题。

~~~text
┌────────────────────────────────────────────────────────────────────┐
│ model-router / 实例     运行中  配置 v18     UTC ▾  最近24h ▾  刷新 │
├───────────────┬────────────────────────────────────────────────────┤
│ 总览          │ 请求数 | 成功率 | 输入/输出 token | 首文本 P95       │
│ 上游          │                                                    │
│ 模型与路由    │ 请求与错误趋势                 用量趋势             │
│ 访问 Key      │                                                    │
│ 用量分析      │ 上游健康列表                   用量 Top Key         │
│ 请求日志      │                                                    │
│ 测试台        │ 最近异常 / 待处理配置 / 未知用量                    │
│ 接入指南      │                                                    │
│ 账号授权      │                                                    │
│ 系统设置      │ 数据截至时间；测试流量默认排除                      │
└───────────────┴────────────────────────────────────────────────────┘
~~~

### 11.2 页面规格

| 页面 | 主要展示 | 操作与细节 | 验收重点 |
|---|---|---|---|
| 登录 /login | 实例、登录表单、服务可达状态 | 登录/退出；初始化仅持有本机 token 可完成 | 代理 Key 无法登录；会话过期保留非敏感草稿 |
| 初始引导 /setup | 供应商→认证→模型→路由→访问 Key→验证 | Kimi Platform/Code 分开；支持跳过付费测试 | 从空实例生成可用配置，刷新可恢复步骤 |
| 总览 /overview | logicalRequests、成功/失败/取消、token、TTFB/首文本 P95、健康、异常 | 全局筛选联动；指标跳转日志/用量；显示缓存与数据新鲜度 | 不重复计重试；无数据不伪造曲线 |
| 上游 /upstreams | 供应商、协议、地址、配置启停、健康、可用 Key、24h用量 | 新建/克隆/编辑/停用；详情分基础、凭证、模型、策略、健康、用量 | 保存后显示生效 revision；停用不被探活复活 |
| 模型与路由 /routes | 具体别名、glob、候选顺序、真实模型、能力 | 拖动排序、冲突提示、预览、发布模型；显示原生/桥接/实验标签 | 同一预览与实际选择一致；预览零调用 |
| 访问 Key /keys | 名称、备注、权限、配额条、过期、最近使用、状态 | 创建/轮换/禁用/删除、复制一次性 Key、用量详情 | 不限额、0、已用、预留明确区分 |
| 用量分析 /usage | 请求与尝试、token分项、缓存命中、趋势/排行、估算费用/余额 | 按 Key/上游/模型/协议/source 筛选，价格版本，导出 | missing 显示未知；混合币种不直接合计 |
| 请求日志 /requests | 时间、requestId、访问Key、请求/实际模型、最终上游、状态、耗时、token | 游标分页、筛选、详情尝试时间线、复制脱敏错误 | 断流不显示完成；刷新期间不跳乱分页 |
| 测试台 /playground | 协议、模型、访问身份、流式开关、生成参数、响应 | 能力感知表单、发送/停止、路由摘要；工具测试使用固定 fixture | 不把管理员会话当上游 Key；测试流量单独统计 |
| 接入指南 /connect | 当前公开 Base URL、模型、协议、配置片段 | SDK/curl/客户端模板、复制、连通性指引 | 无明文上游凭证；公开地址不从不可信 Host 推断 |
| 账号授权 /accounts | client-credentials/设备账号、供应商、有效期、绑定、刷新状态 | 新增、授权、取消、设默认、刷新、解绑 | 刷新失败可见；未实现 provider 禁止启动设备流 |
| 系统设置 /settings | 监听/超时/日志/时区、运行状态、数据库、配置版本 | 校验、diff、导入导出、回退、价格、审计、备份恢复、维护任务 | 重启字段显示待生效；后台任务显示进度与失败原因 |

### 11.3 新增上游向导

1. 选择 Kimi 开放平台、Kimi Code、DeepSeek、自定义 OpenAI、自定义 Anthropic。
2. DeepSeek 可选择 Chat 或 Messages；自定义 OpenAI 再选择 Chat Completions 或原生 Responses。
3. 输入名称、Base URL、认证方式、一个或多个凭证，实时展示最终 URL 和 secret 来源。
4. 发现或手填模型；能力标为文档声明/用户声明/已测试，不能将“列出成功”标为全功能可用。
5. 配置客户端别名、允许协议、候选顺序、thinking/缓存策略和测试模型。
6. 查看差异；选择只保存或保存并执行一次受限测试。

### 11.4 状态与交互约束

- 列表 loading 使用骨架；empty 显示对应的创建入口；error 保留旧数据并标记过期；offline 停止轮询并提示重连。
- 编辑表单保留未保存状态，离开时提醒；保存失败不清空字段。仅显式 allowlist 的非敏感字段可在当前标签页 sessionStorage 中保留 30 分钟；秘密输入不写入 URL、任何存储或草稿，会话过期时随表单卸载清除。
- 配置冲突展示“你的修改/最新配置”，允许重新应用；不自动全量覆盖。
- 删除被路由引用的上游返回引用列表；可先停用。删除 Key/账号保留历史快照，并提示正在使用的绑定。
- 轮换访问 Key 明确旧值立即失效；已 admission 的请求继续，后续新请求拒绝旧值。
- 测试台选择访问 Key ID 后在服务端构造受限测试身份，复用权限和配额；不要求还原已哈希的 Key。
- 聊天测试不执行用户任意 shell/tool；工具兼容性测试用服务端固定的纯函数 fixture。
- 列表筛选同步到 URL；全局时间范围不覆盖用户已固定的日志游标；当前页隐藏时暂停常规轮询。

## 12. 账号授权与管理访问

管理员与上游账号分开。首版一个管理员账号，数据模型保留 actorId；多管理员角色和外部 SSO 不作为当前验收条件。

初始化 token 由本机 CLI 生成、短时有效、一次使用，不开放匿名远程注册。会话使用 HttpOnly、SameSite Cookie，HTTPS 使用 Secure；写操作校验 Origin/CSRF，关闭通配 CORS。开发时由 Vite 同源代理管理 API。

API Key 和 client-credentials 认证是稳定接入路径。设备授权完整设计包含 adapter.start/poll/refresh/revoke、授权任务超时/取消、slow_down 处理、single-flight 刷新、refresh token 轮换、失效状态和账号绑定。OAuthAccountStore 注入 resolver，provider/accountId 从上游配置显式传递。

账号页通过 /capabilities 展示可用授权方式；GitHub/Codex 等设备流只有完成各自官方接口验证和真实授权测试后开放。Kimi/DeepSeek 本次核心预设默认使用 API Key，不推断它们支持任意 OAuth 设备流。

普通代理 Key不能修改配置、查看其他 Key、读取上游 secret。浏览器不直连供应商，不保存供应商 token；所有导出、测试、维护和凭证变更记录审计。

## 13. 前端与代码组织

前端选 React + TypeScript + Vite，TanStack Query 管理查询/缓存/轮询，React Router 管理页面和 URL 筛选，统一组件层承载表格/表单/抽屉/图表。图表库在实施时按包体和许可选择一种，业务统计留在后端。

概览与运行状态初期 5 秒轮询；重查询 30 秒或手动刷新，配置写入按实体精准失效。SSE 仅推送 request.completed、upstream.changed、config.applied、job.progress 等轻量事件，不推送完整 prompt 或批量统计数据。[Vite 后端集成](https://vite.dev/guide/backend-integration)、[TanStack Query 轮询](https://tanstack.com/query/latest/docs/framework/react/guides/polling)。

~~~text
src/
  contracts/           配置/管理 DTO、校验、错误码、能力声明
  config/              V1→V2 迁移、raw/resolved 快照、提交与锁
  control/             ControlService、本机 socket、审计
  providers/           kimi-platform、kimi-code、deepseek、custom
  protocol/            已有桥接器、协议注册表、SSE 状态机
  runtime/             context、reconcile、生命周期
  router/              路由编译/预览/选择
  server/              proxy 入口、出站请求、认证、重试
  admin/               HTTP 管理 API、session、静态页面
  secrets/             secret 引用、加密存储
  telemetry/           request/attempt、usage normalizer、事件
  storage/             migrations、writer/query workers、repositories
  quota/               reservation/settlement、RPM、并发控制
  jobs/                汇总、清理、导出、备份、探测、授权
  cli/                 原有命令 + 管理服务调用
web/
  src/app/             路由、布局、查询客户端
  src/features/        overview/upstreams/routes/keys/usage/requests/...
  src/components/      共用 UI、能力标签、错误状态
  src/api/             由共享契约生成/约束的客户端
docs/
  model-router-console-technical-design.md
  examples/model-router-console-v2.example.json
tests/
  contracts/ providers/ config/ storage/ integration/ e2e/
~~~

共享契约编译到可被前端读取的独立入口，不让浏览器 bundle 引入 node:fs、better-sqlite3 或运行时 secret 代码。web 使用独立 tsconfig；服务端保持 NodeNext。

## 14. CLI、部署与运维

保留 key:create/update/rotate、upstream:add/list/delete、modelMap 管理、chat、logs、stats、usage 的入口；实现改为调用服务层。原 --show-secrets 对哈希化代理 Key 返回“不支持恢复，请轮换”；不能为兼容该选项保留明文 Key。

以下离线 V2 管理命令已在 CLI 中提供；具体选项及限制以 `model-router <command> --help` 和 README 为准。配置迁移/校验/应用、上游更新/探测、首次管理员 bootstrap、备份创建/恢复及 live telemetry 重建均有对应子命令：

~~~text
model-router admin:bootstrap
model-router config:validate --config <path>
model-router config:migrate --dry-run
model-router config:apply <path> --config <target> --expected-revision <n>
model-router upstream:update <name>
model-router upstream:test <name>
model-router backup:create --config <path>
model-router backup:restore <backupId> --config <path> --expected-revision <n>
model-router telemetry:rebuild-live --config <path> --expected-revision <n>
~~~

构建脚本已拆分为 `build:server`、`build:web` 和聚合入口 `build`，包产物声明包含 server `dist` 与 web 静态 `web/dist`；生产不运行 Vite dev server。测试脚本包含 `test:unit`、`test:integration`、`test:e2e`、`test:live` 及 Kimi、DeepSeek、Ollama 专用 live smoke。CI workflow 固定 Node 22.16.0 并使用 lockfile。Docker、systemd、launchd 部署样例见 [deploy/README.md](../deploy/README.md)。这些产物和脚本的存在不代表真实 Kimi/DeepSeek 账号能力矩阵已经验收；云端 live 验证仍需相应凭证并显式执行。

静态资源使用内容 hash 长缓存，index.html 不长缓存；SPA fallback 仅用于管理页面，不能吞掉 /admin/api 或代理路径。设置 publicProxyBaseUrl/publicAdminBaseUrl 供接入指南生成链接。

systemd、launchd 与 Docker Compose 部署样例及 dataDir 持久卷配置已提供，具体安装步骤见 [部署指南](../deploy/README.md)。容器监听是否开放由部署配置决定；管理入口单独映射。反代 SSE 禁止缓冲，显式配置可信代理来源而非信任任意 X-Forwarded-For。

备份通过数据库 backup API 或协调的 checkpoint/快照完成，不只复制 WAL 模式下的主数据库文件。备份清单包含 schema、配置 revision、校验、secret 引用和所需密钥说明。恢复采用维护模式：停止 admission、备份当前状态、校验目标、恢复并重建 runtime。没有进程管理器时 UI 不承诺自动重启。

维护 job 排队、可观测；VACUUM 是阻塞维护任务，需要明确维护窗口或使用经验证的增量回收，不能由每次查询触发。

## 15. 迁移与兼容

1. migration dry-run 输出配置、凭证、路由、日志变化和阻断项；创建带版本的备份。
2. 为原上游、代理 Key、凭证分配稳定 ID。旧 API Key 按来源迁移为 secret/env 引用，代理 Key 转为摘要；保留原 Key 字符串仍可鉴权。
3. 旧 baseUrl 按原拼接规则计算最终地址，再拆成 V2 prefix/path；不根据“通常应该是 /v1”改变现有自定义路径。
4. 模型路由先使用 legacy-compiled 兼容规则；界面可预览转换成 V2 first-match 后的差异。
5. 旧 enabled=false 无法可靠区分手动关闭还是健康检查自动关闭，统一保留为关闭，管理员自行恢复。
6. 旧 quotaTimezone 保持 UTC；旧 token 配额语义记录 legacy_v1，下一周期才切换；变更前显示预计口径差异。
7. 旧 request_logs 没有 requestId，无法可靠把重试归组。导入 legacy_request_logs 或兼容视图，标记 measurement=legacy_log_rows，不伪造去重后的请求成功率。
8. 旧缓存数据按已知 provider 归一化，信息不足保留 unknown；旧日志没有模型价格版本，不追溯伪造实际费用。
9. 迁移工具幂等并有 schema_migrations。V2 服务拒绝加载高于自身支持版本的配置；回退旧程序需恢复对应备份，不能把 V2 文件直接交给旧版本。

历史技术文档保留为历史资料。README 链接本设计、V2 配置示例和部署指南，并说明当前功能边界、运行方式及尚未验证的供应商能力；随实现和验证状态更新相应说明，避免将未验收能力表述为已交付。

## 16. 验收与测试矩阵

### 16.1 接入验证

| 场景 | 非流式 | SSE | 工具往返 | 缓存/usage | 原生/桥接 |
|---|---|---|---|---|---|
| Kimi Platform → Chat 客户端 | 必须 | 必须 | 必须 | 必须 | 原生 |
| Kimi Platform → Messages 客户端 | 必须 | 必须 | 基础非推理必须；推理组合能力门控 | 必须 | A→O |
| Kimi Code → Messages 客户端 | 必须 | 必须 | 必须 | 报告或明确缺失 | 原生 |
| DeepSeek Chat → Chat 客户端 | 必须 | 必须 | 含 reasoning_content 连续轮次 | 命中/未命中必须 | 原生 |
| DeepSeek Messages → Messages 客户端 | 必须 | 必须 | 必须 | 验证该端点实际口径 | 原生 |
| 自定义 OpenAI → Chat/Messages 客户端 | 必须 | 必须 | 声明范围必须 | reported/partial/missing | 原生与桥接 |
| 自定义 Anthropic → Messages/Chat 客户端 | 必须 | 必须 | 声明范围必须 | 三类输入 token | 原生与桥接 |
| 自定义 Responses → Responses 客户端 | 必须 | 必须 | 声明范围必须 | 原生 usage | 原生，compact 单独验收 |

供应商 mock 要严格验证 URL、认证、请求字段、工具 ID 和 SSE 生命周期，不能返回任意 200 就认为通过。真实测试使用专用凭证、明确模型和消耗上限，由 test:live 单独运行；普通测试不自动读取生产配置或消耗真实额度。

### 16.2 必须通过的回归

- V2 schema 往返不丢字段；无效配置、并发修改、崩溃恢复、env 引用不落明文。
- 新增/轮换上游 Key 后新请求使用新配置；旧在途请求不受影响；配额不被重置。
- 手动停用不被恢复；半开租约不泄漏；预览不改变任何运行状态。
- 401、403、429、5xx、断连、超时、rectifier、全候选失败都留下恰好一个请求最终状态。
- UTF-8 跨 chunk、tool-only、usage-only 末尾帧、背压、客户端取消、上游半截 JSON/SSE。
- 同一请求三次尝试：总览请求数=1、尝试数=3；每次报告的消耗只计一次。
- 用量样例：OpenAI input=100/cache=60/output=20 → 总120；Anthropic input=40/read=60/write=10/output=20 → 总130；DeepSeek input=100/hit=60/miss=40/output=20 → 总120。
- 总 token 不重复加 reasoning；缺失 usage 不算零；失败但报告消耗仍可计价。
- 跨天长请求、DST 时区、重启、并发预留、已用量大于新上限、轮换/删除 Key 后历史可追踪。
- 汇总重复执行/迟到事件/明细删除/多粒度拼接不丢失或重复；P95 返回是否近似。
- 配置导出、日志、页面 HTML、错误、CSV、审计都不泄露 secret；CSV 防公式注入。
- 管理 API 与模型 API 的身份互不通用；查询/探测无法通过 URL/header 绕到任意未配置目的地。
- E2E 覆盖首次引导、增删改、轮换、配置冲突、筛选深链、断网、会话过期、停止测试、导入回退和维护失败。

### 16.3 性能和交付门槛

以下是待验证目标，不是当前性能承诺：在固定 4 核/8GB、模拟上游、100 并发 SSE 和 100 万条历史数据基准上，开启控制台后的代理额外 P95 延迟增量不超过 10ms，常规分页查询 P95 小于 300ms，预聚合总览小于 500ms，正常用量可见延迟小于 5s。

记录 CPU、事件循环延迟、worker 队列长度、RSS、数据库大小和断流率。慢查询有超时/并发上限；导出/聚合不拖慢代理。最终以同机同负载的改造前后对比决定是否满足门槛。

交付必须满足：干净 checkout 可以 npm ci、build、类型检查、单元/集成/E2E；mock 无真实网络；真实 Kimi/DeepSeek 冒烟有独立结果与能力清单；数据库迁移/恢复演练成功。

## 17. 实施顺序与工作量

| 阶段 | 交付 | 前置条件 | 估算 |
|---|---|---|---|
| P0 基线与配置 | 锁文件、运行时版本、Schema V2、迁移、配置 CAS、secret、runtime reconcile | 本设计 | 4–6 人日 |
| P1 接入内核 | ProviderAdapter、URLBuilder、Kimi/DeepSeek 双入口、自定义协议、生命周期/重试/SSE | P0 | 5–8 人日 |
| P2 数据与控制面 | 请求/尝试、usage、配额、聚合、管理员会话、管理 API | P0；usage 依赖 P1 | 6–9 人日 |
| P3 全部页面 | 页面壳、10 个业务页面、引导、表单、图表、日志详情、状态反馈 | API 契约稳定；可与 P1/P2 并行开发 mock | 7–10 人日 |
| P4 运维与联调 | CLI、授权/维护任务、导入导出、备份恢复、构建部署、E2E/真实冒烟 | P1–P3 | 5–7 人日 |
| 合计 | 本文稳定能力范围内的完整控制台 | 1 名熟悉项目的全栈开发者 | 27–40 人日 |

两名前后端并行开发预计约 4–6 周，具体取决于实际客户端/供应商兼容问题和真实账号测试条件。新增设备 OAuth provider、完整 Gemini、跨 Responses 转换、多管理员 RBAC、供应商账单对账分别估算，不隐藏在页面开发量里。

每个阶段产物必须可运行和可验收：先建立数据/配置真实性，再接查询页面和写操作，最后进行跨页面联调。即使 UI 先完成，也不能在数据与协议尚未通过时标为完整交付。

## 18. 已确定决策与待接入时核验项

已确定：单进程双监听、JSON 配置权威源、SQLite 本地持久化、稳定 ID、管理员身份独立、Kimi 产品拆分、DeepSeek 双协议、模型目录可更新、原生优先、usage 统一、请求/尝试分离、配额预留结算、全部管理页面、兼容迁移。

接入时核验：账号实际可用模型、每个模型的工具/图片/推理支持、Kimi Code 具体 usage 字段、DeepSeek Anthropic 用量语义、可用余额接口、设备 OAuth provider 的授权契约。这些通过能力状态和测试报告表达，不以猜测填充 UI。

本文对供应商行为的描述基于 2026-09-23 核对的官方资料；模型、价格和账号权限以实际接口为准。OpenAI Docs 核对影响了本设计的独立 Responses 能力声明、流式 usage 缺失处理和原生优先策略。
