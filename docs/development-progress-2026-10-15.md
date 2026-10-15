# 开发进度登记 — 2026-10-15(token 外销方案 R 系列)

对应方案:`docs/token-resale-implementation-plan-2026-10-15.md`(R0–R9)。本文件按任务落库登记证据;测试用例矩阵见 `docs/test-cases-sub2api-parity-2026-10-15.md`。

## R0-1 validation-worker-lifecycle 门禁存量缺陷修复(任务 #19,已完成,49880b2)

**定性修正**:此前疑为"worker 在 ACCESS EXCLUSIVE 锁等待期间连接保活/重连",深挖后确认为 **D4 quota-sync 共租竞态**,非重连:
- e98ef9b 将 quota-sync 循环落进 credential-validation-worker 同一 workload(`startQuotaWorker(database, …)` 与 validation worker 共享同一 pg 池,池默认 max 10、pg-pool 空闲取用为 LIFO);
- 两个循环轮询间隔同为 1000ms(`CREDENTIAL_VALIDATION_POLL_INTERVAL_MS`/`QUOTA_SYNC_POLL_INTERVAL_MS`),相位对齐 → 每轮两个 `pool.connect()` 竞争 LIFO 栈顶,claim 事务在轮询周期间合法地交替使用不同池连接(backend PID 翻转);
- 测试断言"第二次 claim 必须同一 backend PID"把**连接复用**误当**进程身份**——单 spawn + 预检 `workerSessionCount === 1` + 角色隔离已保证唯一 CLI 进程,PID 等值从不是产品不变量。

**修复**(测试侧,产品零改动):`blockActualClaim` 的 `expectedPid` 等值校验替换为 `allowedPids` 集合成员校验——首次 claim COMMIT 后快照子进程全部池连接(`cliSessionPids`),第二次 barrier 的阻塞 claim 必须复用快照内 backend(重启的 CLI 只会呈现全新 PID);差异周期证明(POST-COMMIT 再阻塞)与全部生命周期断言不变。

**验证**:本地一次性 PG 18.6 集群(角色 SQL → 迁移 001–103 → 角色重放 → validation-worker 授权),门禁连续 4/4 全绿(3 tests × 4 runs);tests/cli 全目录逐文件绿;`npx tsc --noEmit` 0 错。CI PG15 矩阵由推送后运行确认。

## R0-2 saas-workspace 浏览器 E2E 台账漂移(任务 #20,进行中)

根因已确证(e98ef9b 加 announcements 拉取,spec 9f5c1c6 台账未同步);修复进行中,完成后登记。

## R1 分组倍率 / R5b OpenCode Go 订阅池(并行开发中)

R1(#27)与 R5b-1(#21)并行开发进行中,完成后按提交登记。
