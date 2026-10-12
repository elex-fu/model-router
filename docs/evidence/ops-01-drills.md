# OPS-01 可靠性演练证据（Track I：I1 基础设施 + I3 双实例故障转移 / 备份恢复）

证据约定见 `docs/evidence/README.md`。本文件记录 Track I 交付的两条新演练门禁与其实跑记录；FIN-01 F3 崩溃单元（`settlement-sigkill-crash`，A3 共建）仍由 `fin-01-fault-matrix.md` 承载。

## 演练矩阵

| 演练 | 脚本 | 测试根（gate root） | CI 门禁 | 覆盖 |
| --- | --- | --- | --- | --- |
| 双实例 SIGKILL 故障转移 | `scripts/drills/instance-child.mjs` | `tests/drills/dual-instance-failover.postgres.integration.test.ts` | `dual-instance-failover`（`managed-saas-isolated-required-gates` 矩阵，PG 15/18） | 启动门禁链（ping→schema→unknown-outcome→ACL→KMS readiness）× 两角色；真实 SIGKILL；PG 租约 fencing 故障转移；幸存者门禁复探；被 kill 实例重启重过门禁 |
| 备份恢复 fail-fast | `scripts/drills/backup-restore.mjs` | `tests/drills/backup-restore.postgres.integration.test.ts` | 未接入 CI（见下文"CI 映射"） | pg_dump→校验→drop→重建→pg_restore→指纹比对→`verifySaasMigrations`→只读迁移审计；损坏 dump 拒绝（源库不动）；异源 dump 拒绝（不留半恢复库） |

### 演练流程断言摘要（双实例）

1. 实例 A（gateway 角色子进程）过全部启动门禁 → 获取 `saas_provider_account_leases` 租约（maxConcurrency=1，fencing token 来自 PG 序列）。
2. 实例 B 过同样门禁 → 被 fencing 阻挡（`lease-pending`），持续 2.5s（>1×TTL）无 `lease-acquired`，DB 侧恰好一个 live holder = A。
3. **SIGKILL A**（断言死于信号而非优雅退出）→ B 在 PG 租约时钟到期后获取租约，fencing token 严格递增；A 的租约行被 PG 权威标记 `expired`（死者不可能自己 release）。
4. 幸存者持续 renew（≥3 次 marker）；gateway 与 control-plane 两个角色的"启动门禁链 once 探针"在 kill 后均退出码 0 —— 门禁仍绿。
5. 重启 A（新 attempt）→ 重过门禁 → 仍被 fencing 阻挡 → SIGTERM B 优雅释放 → A 获取第三个 fencing token。
6. 终态：恰好三次获取、fencing 严格递增、状态分别为 expired/released/released、无 live holder。

### 演练流程断言摘要（备份恢复）

1. 装配：createdb → 角色模板 → `saas:migrate`（migrator 角色）→ 重跑角色模板（与 CI 装配契约一致），植入 3 行租户数据。
2. 工具正向循环后：迁移台账 71 行 sha256 与恢复前逐字节一致；106 张表逐表行数一致；抽样租户行 deep-equal；`verifySaasMigrations` 通过；只读 `saas:migration-audit` 台账逐条 `match`（演练不提供受审 catalog baseline，compatibility 显式 `unverified`——fail-closed 语义保留，见工具内注释）。
3. 负向 A（损坏 dump）：在 archive 校验步拒绝，**源库未被 drop**（数据原样）。
4. 负向 B（异源 dump 指向合法迁移过的另一库）：恢复后指纹不匹配 → 拒绝 → **目标库被 drop，不留半恢复库**（`pg_database` 断言不存在）。

## 实跑记录（native counts，`scripts/capture-gate-evidence.mjs` 捕获）

运行环境：scratch PG 18（`127.0.0.1:55433`，独立集群），Node v24.18.0（本地），工作树含未提交修改（commit 列为基线 SHA）。CI 环境（node:22.16.0-bookworm，PG 15/18 双跑）以合并后 CI 记录为准。

| date | commit | gate | pg | tests/pass/fail/skipped | duration_ms | conclusion | reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-10 | 54142d5f8eb3 | dual-instance-failover | 18 | 1/1/0/0 | 8403 | GO |  |
| 2026-10-10 | 54142d5f8eb3 | backup-restore | 18 | 1/1/0/0 | 5937 | GO |  |

补充实测细节：

- 双实例 fencing 序列实测 `1 (killed) -> 2 (survivor)` 与 `4 -> 5`（两次独立运行），重启实例获取第三个 token；kill 窗口下幸存者 renew 无中断。
- 备份恢复正向循环实测 `restored 106 tables / 71 ledger rows`；台账 hash 恢复前后一致；审计报告 `migrations[].state` 全部 `match`，唯一 issue `BASELINE_MISSING`（演练口径，预期）。
- 无 PG env 时 `node --import tsx --test tests/drills/`：3 个测试全部正确 skip（tests 3 / skipped 3 / fail 0）。
- 演练产生的数据库（按约定保留）：`model_router_test_drill_failover`、`model_router_test_drill_backup`。`model_router_test_drill_backup_mismatch` 被负向演练按 fail-fast 设计 drop（即"不留半恢复库"的直接证据）。

## CI 映射

- `dual-instance-failover` **已接入** `.github/workflows/ci.yml` 的 `managed-saas-isolated-required-gates` 矩阵（PG 15/18 双跑），同步修改了 `tests/ci/managed-saas-isolated-required-gates.ts`（gate 表）与 `tests/ci/managed-saas-required-gates.test.ts`（钉板 `isolatedGates`）；钉板 11/11 通过。该测试符合 isolated runner 固定 env 契约（仅四元角色 URL；KMS pilot 密钥由子进程内部临时生成，不入环境）。
- `backup-restore` **未接入 CI**，原因：isolated runner 的 `childEnv` 被钉板精确固定为 PATH + 四个受限角色 URL，不包含集群管理员 URL；该演练按设计需要超级用户执行 drop/create/terminate-backends。接入需要 (a) 扩展 runner env（钉板联动，共享面大）或 (b) 新建独立 workflow job（管理员 URL 在 CI trust 服务下无密码，无新增机密）。建议 M3 前以独立 job 接入并把本文件证据行刷新为 CI 记录；在此之前以本文件的 scratch PG 记录 + REQUIRED env 语义为准。
- **共享面标注**：本次修改了 `.github/workflows/ci.yml`、`tests/ci/managed-saas-isolated-required-gates.ts`、`tests/ci/managed-saas-required-gates.test.ts` 三个与其他 Track 共享的文件（均为追加式改动：矩阵/表/钉板各加一行）。

## RPO/RTO 验收记录位

| 指标 | 演练实测 | 验收口径（建议） | 状态 |
| --- | --- | --- | --- |
| RTO（实例故障转移） | SIGKILL → 幸存者获取租约 ≤ 1×leaseTTL + 获取重试间隔（演练配置 2000ms + 100ms；实测单次运行 <3s） | 生产口径 = 配置的租约 TTL 上界；故障转移不需人工干预 | 待 M3 按生产 TTL 值复核 |
| RTO（实例重启恢复） | 被 kill 实例重启后完整门禁链通过（实测含 ACL 全量核验 <10s/角色） | 重启自动重过门禁，无人工修复步骤 | GO（演练口径） |
| RPO（备份恢复） | pg_dump 时点一致性：恢复后台账/行级数据与 dump 时点逐字节一致 | RPO = 备份间隔（运营策略）；工具保证恢复点 = 最近成功 dump | 工具语义 GO；备份间隔策略待 OPS 定值 |
| 备份 fail-fast 红线 | 损坏 dump 不动源库；异源 dump 不留半恢复库 | 任何失败路径要么原样、要么无目标库 | GO |

## 已知边界与遗留（OPS-01 关闭前）

1. 完整 supervisor 装配（listener 绑定、web 资源、credential-validation-worker 角色）未在演练子进程内复现——取舍记录见 `scripts/drills/README.md`；worker 角色的 SIGKILL 演练仍是 Track I 扩展方向。
2. OS cleanup（I3 尾项：演练残留进程/文件/库的清场审计）未覆盖；当前靠 `t.after` SIGKILL 兜底 + 库名白名单约束。
3. `backup-restore` 的 CI 接入（见上节）。
4. catalog baseline 受审产物缺位时审计只能给出 ledger-matched；REL-01 聚合时需以受审 baseline 重跑一次 `--audit`。
