# Model-router 开发进展、能力建设与后续任务

盘点日期：2026-09-29  
工作目录：`/Users/lex/play/model-router`  
关联方案：[Sub2API 商业平台能力融入方案](./sub2api-commercialization-integration-plan.md)

## 结论摘要

项目已从本地多协议模型代理扩展为包含 SaaS 身份、供应、托管网关、计量、账务和管理控制台的商业平台核心实现。代码覆盖面较广，部分迁移、权限和 UI 测试已有通过证据；但“代码已实现”不等于端到端、生产或商业准入已验收。当前最重要的技术闭环——BYOK 与平台供给的 PostgreSQL 商业网关 E2E——仍未通过；按 Key 的 IP 限制与预算限制也只有纯逻辑模块，尚未接入完整请求链路。因此当前版本**不可视为商业就绪，不应开放托管 `/v1` 对外收费服务**。

本文区分“代码存在”“自动化测试通过”“生产/商业准入通过”三种状态，不以模块数量估算完成百分比。

## 已建设能力

| 能力域 | 当前建设内容 | 当前判断 |
|---|---|---|
| 本地代理与管理 | TypeScript/Node 代理、React/Vite 管理控制台、V2 配置与管理服务、路由/模型/上游管理、请求与用量视图、CLI 管理入口 | 本地和单机模式的基础能力已覆盖；功能回归及发布验收仍需持续维护 |
| 协议与上游 | OpenAI/Anthropic 适配与桥接、多 Provider 接入基础、Kimi/DeepSeek/Ollama 测试入口、模型能力与路由配置 | 有协议与上游测试基础；每个 Provider 产品、凭证类型、模型及 endpoint 仍须分别验证，不可由“兼容协议”推断商业授权 |
| 代理可靠性 | Key/账号池、OAuth 多账号、熔断和健康状态、客户端 IP 处理、流式/取消/超时/背压等处理及对应测试 | 本地链路具备较多稳定性措施；跨实例调度、故障恢复和生产压测尚未完成统一验收 |
| 本地用量与配额 | 用量归一化、Telemetry 持久化/写入队列/聚合、定价数据、额度预留与结算基础 | 可支持本地管理与分析；本地额度账本不是 SaaS 客户资金钱包 |
| SaaS 身份与租户 | PostgreSQL SaaS schema/migrations、身份、租户/项目、成员与角色、平台管理员认证、访问授权及审计基础 | 核心领域代码已存在；双租户隔离、并发撤权、会话恢复及所有边界场景尚未统一验收 |
| Provider 供应与 Secret | Provider catalog/rights、BYOK 与平台供应账户、凭证版本、加密与 KMS 接口、受限验证 worker、供应池和路由关系 | 控制面与运行时边界已搭建；生产 KMS workload 身份/权限、授权证据及实际商业供给池均待准入 |
| 商业网关 | Proxy Key 与项目权益绑定、鉴权、请求准入和容量、幂等、账号调度/租约、prepared evidence、派发授权栅栏、请求/attempt/usage 记录、unknown outcome 对账 | 有较完整的安全状态链和恢复模块；BYOK/platform PostgreSQL 真实事务闭环仍是当前验收阻断项 |
| 计价、账务与支付 | 版本化价格/成本快照、平台供给钱包与账本、预留/结算、BYOK 服务计划、支付事件 inbox/outbox、退款及 worker/对账代码 | 领域模块与单测覆盖较多；生产 PSP 配置、并发/故障/迟到事件等生产级验证未完成 |
| 客户与平台 UI | 客户工作区、模型目录、Key、BYOK 凭证、用量/请求、钱包/服务计划/退款等 React 页面及对应 API 客户端；有平台管理、运营和审计基础 | 初始生命周期和多个功能页已形成；商业运营所需的角色/租户矩阵、端到端工作流、服务状态与支持流程尚未全部验收 |
| 部署、备份和测试设施 | Docker/Compose、systemd/launchd 示例、PG 角色模板、CI 配置、Playwright E2E、性能脚本、备份/恢复和迁移 CLI 基础 | 工具和部署骨架已加入；托管生产环境、CI、版本兼容和恢复演练证据不完整 |

数据库迁移当前注册至 **052**。迁移覆盖身份、供应、权益、账务、支付、请求幂等、容量、授权栅栏及未知结果恢复等领域；迁移注册并不单独证明所有存量数据库都能安全升级。

## Sub2API 能力对照

本项目采用的是“参考产品能力与运维模式、在现有技术栈中实现”，不是把 Sub2API 的 Go/Vue 代码直接移植，也不把两套系统长期串联。

- **账号与供应调度：** 已建设数据库化 Provider 账户、租约、健康和 affinity 等基础，方向上承接多账号池与调度需求；双实例竞争、Redis 故障和恢复屏障仍需验证。
- **用户与 API Key：** 已建设 SaaS tenant/project Key 的创建、展示一次、轮换和吊销等基础生命周期；最明显缺口是 Key 级 IP allowlist 与日/累计预算尚未端到端接入。
- **模型目录与供给权益：** 已有 catalog、supply profile、entitlement、Key 绑定与路由授权基础；protocol capability、Provider 商业 rights、客户可见性和单次派发仍必须按方案逐层验收。
- **用量、收费与支付：** 已有计量、平台钱包、BYOK 服务计划、支付/退款领域实现；真实 PostgreSQL 网关闭环与 PSP 生产对账未验收。
- **安全与运营：** 已有 MFA/TOTP、审计、健康/容量运营基础；完整商业管理页、告警升级、支持/退款 runbook、加密备份与恢复演练仍未完成。
- **非核心范围：** 兑换码、返佣、插件市场及多模态异步任务不属于当前核心交付；Sub2API 的许可与上游授权问题也未因参考其功能而自动解决。

所以目前可以说“商业平台核心领域已经成形”，不能说“已达到 Sub2API 功能/运营成熟度”或“已完成商业化”。

## 验证证据与当前阻塞

### 已有测试证据

- 全量 offline unit 基线：**1,915 passed / 18 skipped / 0 failed**（共 1,933）。
- 集成测试基线：**182 passed / 6 skipped / 0 failed**（共 188）；专用数据库 URL 未配置时，部分 PostgreSQL 用例会跳过。
- Playwright 浏览器 E2E：使用系统 Chrome 后 **22/22 通过**。
- `npm run build` 以及 server TypeScript、web `tsc --noEmit` 和 Vite build 通过。Vite 有 bundle advisory：740.11 kB（gzip 210.96 kB），高于 500 kB 提示阈值。
- 三个纯逻辑模块的 focused tests：CIDR policy、Key budget evaluator、client-address resolver 各 **10/10**，合计 **30/30**。resolver 与 policy 尚未完成 SaaS gateway 集成。
- Disposable PostgreSQL 18.6 的 migrations 001–052 与角色模板曾通过；静态/权限测试曾 **84/84** 通过。最终 052 修改后，迁移 050、051 的独立测试分别 **8/8**、**6/6** 通过。

上述全量测试数字是既有验证基线；最新代码状态仍应在变更稳定后重新跑完整矩阵。没有 PostgreSQL 15 或远程 CI 的验证证据。

### 最近 PostgreSQL 商业网关 E2E

最近一次 BYOK 请求仍以 HTTP **503 `REQUEST_BLOCKED`** 失败，测试在 platform-supply 和钱包隔离断言前退出。当前已确认的根因是 gateway 数据库角色执行 `SELECT ... FROM saas_api_keys ... FOR SHARE` 时缺少该表的读取权限；测试中的容量策略数据有效且可读，尚未进入容量预留写入。更早的 403 曾定位为 authz-version 类型不匹配；修复后先暴露 fixture 限额问题，补限额后仍被上述角色权限挡住。当前诊断尚未完成，也没有为该权限问题实施修复。

用户要求停止后，正在进行的 E2E/诊断任务已中断，不会继续修权限或重跑。只读核验显示临时 PostgreSQL 端口 **57734 已无监听进程**，当时记录的 PID **52651 已不存在**；没有操作 PostgreSQL 5432，也没有删除数据库数据目录。platform-supply 钱包/结算断言因此仍未验证。

## 后续任务与优先级

### P0：恢复并完成 PostgreSQL 商业网关验收

1. 先补齐 gateway runtime role 对 `saas_api_keys` 所需的最小读取权限；不得通过扩大到不必要的表权限解决，也不要回写已发布迁移历史。按需要使用新的前向迁移及对应 role template，并测试最小权限。
2. 在干净 disposable PG 上重跑 001–052 与角色模板，再跑完整 commercial gateway E2E。
3. 证明 BYOK 请求只计量、不创建/预留/扣减平台钱包；证明 platform 请求按价格快照 hold/settle，unknown outcome 不提前释放、不重复记账。
4. E2E 必须同时覆盖两种 supply mode；不得把 BYOK 通过当作整条商业网关验收通过。

### P1：把 Key IP policy 从纯逻辑接入产品

新增前向 schema/历史与审计、旧 Key 安全回填、控制台 API/UI、可信代理配置、client IP 持久化，以及鉴权后和实际 dispatch 前的双重策略校验。应覆盖 `/v1/models` 和推理请求早期拒绝、idempotency replay、并发更新/吊销、轮换继承、运行时角色权限、拒绝后不调用上游和清理 admission/hold 等场景。

### P1：把 Key budgets 从纯逻辑接入产品

建设版本化预算策略与计数/预留表、Key lineage、API/UI、并发事务 reserve/settle、幂等修正和 unknown outcome 语义。按 BYOK 与 platform 区分 token cap 与平台客户收费 cap，覆盖 daily/lifetime、轮换、并发超限、证据修正及失败释放规则。

### P1：完成统一系统验收

- 最新工作树上的 unit、integration、E2E、build 和 runtime-privilege 测试全量重跑。
- 增加 PostgreSQL 15 与远程 CI 验证，覆盖 migration/role templates、tenant isolation、支付/退款、并发与故障恢复。
- 完成 Provider × 产品 × 凭证 × supply mode × region × model × endpoint 的协议证据与商业 rights 清单；未验证/未获授权的产品保持 disabled。
- 补齐客户与平台 UI 的完整角色/权限矩阵、账务/退款、风险/运营、状态与支持流程；测试状态不允许冒充商业可售状态。
- 完成 KMS workload、Redis/PostgreSQL 故障、加密备份/WAL、恢复后撤权、防止 Secret 泄漏、SLO/告警和 RPO/RTO 演练。

### P0 商业开放前置条件

技术测试不能替代授权审查。正式对外开放前还需明确运营主体、地区/币种、目标市场合规、每项 Provider 产品和凭证的商业中转/转售权、PSP 商户与退款规则、隐私/留存/AUP、客服与 on-call 责任。Sub2API 的许可证、商业许可声明和上游条款需独立审查；当前方案未复制其代码，也不构成授权证明。

### 数据库升级风险

迁移 **022/023** 曾为修复空库 DDL 而改变 SQL/checksum。没有足够证据证明所有持久化环境登记的 checksum 与 catalog 状态一致。发布升级前必须逐库盘点可信 checksum 和实际 schema；无法证明状态时不得升级。不得改写 migration ledger 或绕过 checksum fail-closed 检查；如存在旧版本已应用数据库，先设计可审计、可前滚的兼容修复。

## 工作树与交付状态

- 分支为 `main`，盘点时 HEAD 与 `origin/main` 一致；改动很多且尚未提交。此前统计的 29 个已跟踪文件有 7,234 行新增、950 行删除，尚未计入大量未跟踪的 SaaS、web、tests、deploy 与 docs 文件，因此不能代表全量改动量。
- 本文是进展快照，不替代商业化整合方案；本次请求没有提交或推送代码，也没有清理或重置工作树。
- Kimi 验证 Secret 不应进入仓库。根目录 `/kimi-validation.config.json` 已有 ignore 规则；`docs/examples/kimi-validation.config.json` 当前不存在，也没有 Git 历史记录。现有 `docs/examples` 中的 V2 示例是另一份模板文件。

## 下一步顺序建议

先由用户明确恢复开发后，处理最小 gateway role grant 并通过 BYOK + platform PG E2E；随后依次完成 IP policy、Key budgets 的端到端切片，再跑完整 CI/PG15 和恢复/权限矩阵；同时推进法务、Provider rights、PSP 和生产运营准入。所有商业 endpoint 在相应技术与商业验收通过前维持关闭或安全拒绝。
