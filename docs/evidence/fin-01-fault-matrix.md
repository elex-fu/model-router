# FIN-01 财务故障矩阵 — 证据模板（A3）

> 目标：对六种故障模式 × 双 PG（15/18）证明财务语义成立——不重复扣款、不丢失结算、余额=台账投影、append-only 事实不被重写。每个单元格映射到一个可执行门禁；「运行记录」用 `scripts/capture-gate-evidence.mjs` 捕获。

## 1. 故障矩阵

| # | 故障模式 | 门禁（CI required） | 财务断言 |
| --- | --- | --- | --- |
| F1 | 取消补偿（pre-dispatch 取消/重派） | `tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts`（gate `cancellation-059`）+ `tests/saas/gateway/pre-dispatch-compensation-postgres.integration.test.ts`（gate `pre-dispatch-compensation`） | 取消是终态；补偿释放恰好一次；直写复活被触发器拒绝 |
| F2 | missing usage（上游未回报用量） | `tests/saas/metering/unknown-outcome-reconciliation-service.test.ts` + `tests/saas/metering/unknown-outcome-recovery-worker.test.ts`（npm test） | 缺口显式入对账队列，不隐式按 0 或估计值结算 |
| F3 | 崩溃（真实 SIGKILL 子进程） | `tests/drills/settlement-sigkill-crash.postgres.integration.test.ts`（gate `settlement-sigkill-063` 族） | 崩溃窗口内事务整体回滚；重启重放恰好一次生效；台账平衡 |
| F4 | unknown 结果（发送后状态不明） | `tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts`（gate `normal-success-terminal-replay`）+ 051 支持工单迁移门禁 | unknown 必须进入 `reconciliation_state='pending'`；恢复前禁止更正（063 fence） |
| F5 | 并发（双连接竞争同一请求/同一证据） | `tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts`（gate `concurrent-claim`）+ `tests/saas/metering/usage-correction.postgres.integration.test.ts`（gate `usage-correction-063`，双连接更正竞争） | advisory fence 串行化；恰好一个写入者生效 |
| F6 | 重复结算（重放/重复提交） | `tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts` + `tests/saas/billing/managed-postgres-financial-invariants.integration.test.ts` + `usage-correction.postgres.integration.test.ts`（digest 重放） | 重放零副作用；钱包投影恒等台账；不出现第二条分录 |

## 2. 跨矩阵不变量（每轮必查）

- 钱包投影 = 台账净额（`balance = walletLedger`，门禁内断言）；
- 每笔台账事务恰好一对平衡分录（`unbalanced = 0`）；
- `saas_usage_events` / `saas_usage_settlements` / `saas_requests` 事实 md5 在重放/冲突前后不变；
- 受限角色对 append-only 表无 UPDATE/DELETE（`42501` 探针）。

## 3. 运行记录（native counts，脚本捕获）

| 日期 | commit | 故障模式 | gate | PG | tests/pass/fail/skip | duration_ms | 结论 | 评审 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _待捕获_ | | | | 15 | | | | |
| _待捕获_ | | | | 18 | | | | |

## 4. REL 评审 checklist

- [ ] F1–F6 每个模式在 PG15 与 PG18 均有一条 GO 记录；
- [ ] F3 崩溃演练记录包含：SIGKILL 时已提交完成数 k、恢复后补齐数、ledger 恰好一次断言；
- [ ] CI 记录不含 skip（skip 只出现在未配置 E2E env 的本地运行）；
- [ ] 矩阵单元 → 门禁映射由 `tests/ci/managed-saas-required-gates.test.ts` 固定，未被弱化。
