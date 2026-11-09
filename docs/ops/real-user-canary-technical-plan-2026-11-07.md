# 真实用户 Canary 技术方案（2026-11-07）

## 1. 目标与边界

目标是在不放宽 Codex trusted-bound、财务和部署安全约束的前提下，将当前实现推进到可限量开放真实用户的状态。

本方案只定义代码修复、验证证据和灰度步骤，不代表已经取得真实 Codex、真实支付或生产部署验收。真实上游调用、真实支付和生产变更必须分别获得授权。

发布顺序：

```text
P0 修复 → 冻结候选 SHA → G1 required CI → G2 真实 PostgreSQL 闭环
→ G3 真实 Codex 证据 → G4 生产运行验收 → G5 限量 canary
```

任一代码或 migration 改动都产生新候选 SHA，并重跑受影响的门禁。测试中的 fake、mock、真实 PostgreSQL、真实上游、真实 PSP 和生产演练证据不得互相替代。

## 2. P0：只修复当前明确问题

### 2.1 Profile 审批语义

提取一个共享、无副作用的 usage-envelope 校验器，供管理端 submit/approve、payload compiler、request preparation、DB resolver 和 financial readiness 使用。各调用方保留现有错误码，不新建平行规则。

统一检查：

- 八个 usage 上界均为规范非负整数十进制字符串。
- input/cache 各分项不大于 `inputTotalUpperBound`。
- `reasoningOutputUpperBound <= outputTotalUpperBound`。
- `feasibleInputBuckets` 非空、无重复且属于支持的 registry。
- per-unit bound 与 `sizeTier` 组合合法，tier 属于 registry。
- scope 的 endpoint、operation、transport、continuationMode 组合受支持。
- backend revision、evidence reference/version 合法。
- 有效期顺序正确，审批时剩余时间大于请求超时 margin，且不超过运营策略上限。

submit 时拒绝非法输入；approve 时在事务内重新校验，避免历史 pending 或策略变化绕过。resolver/readiness 不得把语义非法的 approved 行视为可售卖。历史非法行通过 audited retire 处理，不直接改 ledger，也不回写 migration 155；如需数据库约束则新增 migration。

验收：合法 profile 从审批到编译保持一致；非法 profile 不能出现“审批成功、readiness 变绿，但请求必然失败”。

### 2.2 Fast strict TypeScript

修复 `tests/saas/gateway/fast/journal.postgres.integration.test.ts` 对 readonly `allocationTargetConcurrency` 的赋值。通过 fixture 的 typed override 或创建新对象传入该值，不修改生产 journal 行为。

验收：普通 `npx tsc --noEmit` 和 fast workflow 中完整 strict-roots 命令均通过，原 cold-refill/cap/retry 测试保持通过。

### 2.3 Bounded 诊断

先修复编译产物与 `bounded-business-capacity-pins.json` 的 source-pin 漂移，再判断 worker startup/drain 是否仍有独立问题。

- 从干净环境重新构建并审核 transform anchors。
- 通过显式、可审核的 pin 更新步骤记录新 SHA；测试运行时不得自动信任任意当前 hash。
- 不删除 source pin，不用增加 timeout 掩盖失败。
- pin 修复后若仍有失败，保留子进程日志、生命周期状态和清理证据再定位。

验收：两个 Node bounded 诊断文件共 26/26，通过 Python bounded contracts，且无残留进程。该结果只证明正确性，不证明生产性能。

### 2.4 E2E

- 将 `tests/e2e/saas-workspace.spec.ts` 的旧 `/admin/console` 和旧标题预期更新到当前 `/console`、`/console/workspace` 结构，同时保留角色隔离、邀请失败、安全 draft 和 401 行为断言。
- 不为多用户归集用例单纯增加 timeout。先记录四次请求、mock upstream 次数、request/reservation/usage/settlement 状态，定位是在请求、stream、异步结算还是页面断言。
- 修复后在 PG15/PG18 验证两个 Key 各两次请求、四个 usage events、一个租户钱包、余额 2352 和结算总额 48。
- 同时处理项目健康栈中的 Biome 和 knip 红色结果，不通过大面积禁用规则制造绿色。

## 3. G1：精确候选 SHA 的 Required CI

候选提交必须工作区干净。证据记录 commit SHA、Node/npm、PG/Redis 版本、CI run/job、测试 pass/fail/skip 数、migration head、角色模板和 bounded pin。

在现有 workflow 上扩展，不另建平行 CI：

1. `ci.yml` 增加真实 PostgreSQL Codex trusted-bound 闭环 gate，以及 PG15/PG18 客户 PostgreSQL E2E。
2. 将 migration 155 行为测试和新增测试加入 strict roots/isolated gates。
3. 保留 deploy smoke、runtime privilege probes、历史 migration chains 和 fast PG15/PG18 × native scenarios × Redis 门禁。
4. 更新 `tests/ci/*required-gates*`，禁止 required step 使用 `if`、`continue-on-error`、`|| true` 或缺服务 skip。
5. 将完整矩阵或依赖所有矩阵的 release summary 设为分支保护 required check；`failure/cancelled/skipped` 均不放行。

普通浏览器 E2E 与需要 PostgreSQL 的客户 E2E 分成独立 CI job，避免后者在普通运行中被跳过。

## 4. G2：真实 PostgreSQL 管理、准入与结算闭环

使用真实 migration、HTTP server、管理员 session/CSRF/RBAC 和受限数据库角色，不以 fake service 或直接 SQL 代替管理操作。

正向链路：

```text
管理员登录 → submit → pending/list → approve → 同事务 audit
→ gateway resolver 刷新 → 精确 scope hold → 本地确定性上游
→ terminal usage → settlement → wallet/ledger/usage/request 对账
```

断言 hold 等于 reviewed bounds、实际 usage 精确结算、剩余 hold 释放、幂等 replay 不重复扣费，以及失败/取消/stream 中断不泄漏 reservation。此处的确定性上游只用于隔离验证应用闭环，不能标为真实 Codex 验收。

负向覆盖：无 session/CSRF、错误 Origin、无权限角色、gateway 写 ledger、非 approved/expired scope、六轴不匹配、digest/compiler 漂移、DB 故障和 stale snapshot。没有 RLS 时不宣称非 approved 行不可见，重点验证 resolver 只选择 approved 且 gateway 角色不能改状态。

生命周期覆盖：TTL 刷新、successor 先批准再退休、retire 后新请求拒绝、临近 expiry 拒绝，以及在途请求继续按冻结 preparation snapshot 结算。不要为了验证而强行改变现有 settlement 路径。

## 5. G3：真实 Codex 六轴证据

首轮只声明一个 product、一个精确 model、HTTP `responses`、`full` continuation。bounded gateway 不支持 WebSocket upgrade，因此 WS 和 compact 不进入首轮 declared launch set。保留 all-or-nothing readiness，通过缩小声明范围灰度。

每个准备开放的 `(endpoint, productId, model, operation, transport, continuationMode)` 必须具有：

- 真实 request/response ID、backend revision、采集时间和脱敏证据引用。
- 代表性流量及 terminal usage 全维度观测。
- 逐维度 headroom 的计算依据和合法 feasible buckets。
- 受支持的 evidence version 和短有效期。
- 经真实管理 API 完成的 submit/approve/audit。

真实验收必须证明成功请求、usage/settlement 一致、错误 scope 拒绝，以及 successor 轮换、retire、expiry 和 resolver refresh。HTTP/full 证据不能批准 WS、compact 或其他 model/product。凭证只来自 secret manager，不进入仓库、日志或普通 CI artifact。

## 6. G4：生产运行验收

- **真实 PSP**：sandbox 后再经授权做小额生产充值/退款；验证签名、金额、币种、商户/租户绑定、重复/乱序 webhook、unknown outcome、退款、worker 恢复和对账。
- **KMS/IAM**：生产 envelope encryption、最小权限、轮换、解封审计和权限撤销后的 fail closed。
- **PostgreSQL HA/恢复**：同步复制、writer loss、fencing、旧主隔离、异地备份、PITR 和独立恢复演练；达到文档 RTO/RPO，最后已确认财务提交不丢失、不重复。
- **Redis**：重启、网络故障和恢复不产生重复 hold，fast admission 按设计 fail closed。
- **告警**：profile 到期、resolver stale、未结算 aging、钱包差异、PSP 滞后、KMS 失败和复制延迟均有告警及处置人。
- **性能**：精确候选构建在目标环境实测 JSON/SSE 吞吐、p95/p99、CPU/内存、排队和恢复；bounded 正确性结果不能替代性能证据。

重复扣费、无法解释的财务差异或 unknown outcome 是硬阻断。

## 7. G5：限量 Canary 与回滚

只有 G1–G4 全部绑定同一候选 SHA 并通过后才启动：

- 明确 tenant/user allowlist。
- 单 product、单 model、HTTP/full 单 scope。
- 每用户速率、每日 token/费用上限，以及单笔、累计充值和平台总敞口上限。
- 禁止自动充值，WS/compact 保持关闭。
- 实时对账、告警和值班人员到位。

持续监控 admission、拒绝原因、hold/settlement、resolver freshness、profile 到期、未结算 aging、wallet/ledger drift、上游错误、PSP unknown outcome 和基础设施健康。重复扣费及未解释财务差异阈值必须为零。

回滚顺序：停止新充值和新用户 → 关闭 supply/allowlist，必要时 audited retire profile → 停止新 admission，允许在途请求按冻结快照结算 → 保留全部财务与审计数据，完成对账 → 再决定修复前进或执行已验证兼容的二进制回滚。不得通过删除 ledger 或破坏性数据库回滚“恢复”。

## 8. 发布证据清单

```text
[ ] 精确候选 SHA、干净 tree、构建及全部 required CI 绿色
[ ] PG15/PG18、Redis、migration 155、受限角色无违规 skip
[ ] 真实管理员 CSRF/RBAC → approve/audit → resolver → hold → settlement 证据
[ ] 每个开放六轴 scope 的真实 Codex 证据和批准 digest
[ ] expiry/retire/rotation/refresh 实测
[ ] 真实 PSP、生产 KMS/IAM、恢复、告警、对账和性能报告
[ ] canary allowlist、限额、监控、值班和回滚配置
[ ] 工程、运维、安全、财务及发布负责人批准
```
