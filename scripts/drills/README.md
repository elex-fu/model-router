# scripts/drills — 可靠性演练（Track I 目录，A3 共建基础脚本）

## 现有演练

| 脚本 | 用途 | 驱动者 |
| --- | --- | --- |
| `settlement-crash-child.mjs` | FIN-01 F3 崩溃单元：子进程经 `DurableNormalSuccessSettlementPort` 逐条完成结算，每条提交后同步追加 JSONL marker；被 SIGKILL 后由下一轮进程重放全部输入，证明恰好一次 | `tests/drills/settlement-sigkill-crash.postgres.integration.test.ts`（CI gate `settlement-sigkill-crash`） |
| `instance-child.mjs` | OPS-01 I1 实例探针：以 managed-saas 角色装配**启动门禁链**（ping→schema→control-plane unknown-outcome→运行时 ACL→软件 KMS readiness 自探针，顺序同 B2 fail-closed 装配），每过一门追加 JSONL marker；`--mode hold` 时持有真实 PG provider 账号租约（fencing token + DB 时钟 TTL）供 SIGKILL 故障转移演练；`--mode once` 跑完门禁即退出（幸存实例门禁复探） | `tests/drills/dual-instance-failover.postgres.integration.test.ts`（CI gate `dual-instance-failover`） |
| `backup-restore.mjs` | OPS-01 I1 备份恢复工具：pg_dump→archive 校验→drop→重建→pg_restore→指纹比对（迁移台账 sha256 + 逐表行数）→`verifySaasMigrations`→可选只读迁移审计；fail-fast：损坏 dump 在 drop 源库前拒绝，异源 dump 恢复后指纹不匹配即拒绝并 drop 目标库，任何一步失败非零退出、不留半恢复库 | `tests/drills/backup-restore.postgres.integration.test.ts`（本地/scratch 门禁，CI 接法见 `docs/evidence/ops-01-drills.md`） |

## 契约（新增演练必须遵守）

1. 子进程**永不打印**连接串、密钥或租户数据；父测试只观察数据库事实与 marker 文件。
2. 受限角色 URL 只经固定 env（`MODEL_ROUTER_SAAS_DRILL_*`）传入，不走 argv。
3. marker 用同步追加（`appendFileSync`）——SIGKILL 后已提交 marker 不得丢失。
4. 断言必须是终态事实（台账平衡、恰好一次、投影恒等、fencing 严格递增、无半恢复库），禁止用"进程输出看起来正常"充数。
5. 每个新演练 = 一个 `tests/drills/` PG 集成测试 + CI isolated 门禁矩阵条目（`tests/ci/managed-saas-required-gates.test.ts` 固定）。若演练需要 isolated runner 固定 env 之外的凭证（如集群管理员），允许暂缓接入并在 `docs/evidence/` 记录原因与接法设计。
6. 演练脚本绝不吞子进程非零退出；优雅停机（SIGTERM）必须释放租约并以 0 退出，被 kill（SIGKILL）必须死于信号。

## 演练子进程 env 一览

| env | 消费者 | 语义 |
| --- | --- | --- |
| `MODEL_ROUTER_SAAS_DRILL_GATEWAY_URL` | `settlement-crash-child.mjs` | gateway 受限角色 URL |
| `MODEL_ROUTER_SAAS_DRILL_INSTANCE_URL` | `instance-child.mjs` | 当前实例的角色 URL（gateway 或 control_plane） |
| `MODEL_ROUTER_SAAS_DRILL_ADMIN_URL` | `backup-restore.mjs`、备份测试 | 演练专用集群管理员 URL（仅 CI 服务或显式非默认端口 loopback；数据库名限定 `model_router_test_drill*`） |
| `MODEL_ROUTER_SAAS_DRILL_MIGRATOR_URL` | 备份测试（装配用） | migrator 角色 URL，用于 `saas:migrate` 显式迁移 |

## 运行方式

双实例故障转移（复用 gateway E2E 四元组，库须按下方装配流程预置）：

```bash
MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED=1 \
MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL=postgresql://model_router_saas_migrator:<pwd>@127.0.0.1:55433/model_router_test_drill_failover \
MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL=postgresql://model_router_saas_control_plane:<pwd>@127.0.0.1:55433/model_router_test_drill_failover \
MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL=postgresql://model_router_saas_gateway:<pwd>@127.0.0.1:55433/model_router_test_drill_failover \
node --import tsx --test tests/drills/dual-instance-failover.postgres.integration.test.ts
```

备份恢复（自建 `model_router_test_drill*` 库，工具自行 drop/重建目标库）：

```bash
MODEL_ROUTER_SAAS_DRILL_BACKUP_REQUIRED=1 \
MODEL_ROUTER_SAAS_DRILL_ADMIN_URL=postgresql://postgres@127.0.0.1:55433/postgres \
MODEL_ROUTER_SAAS_DRILL_MIGRATOR_URL=postgresql://model_router_saas_migrator:<pwd>@127.0.0.1:55433/model_router_test_drill_backup \
node --import tsx --test tests/drills/backup-restore.postgres.integration.test.ts
```

装配新演练库（与 CI 装配契约一致；角色为集群级、密码外部管理）：

```bash
createdb <db>                      # 或 psql -c 'CREATE DATABASE <db>'
psql -X -v ON_ERROR_STOP=1 --dbname=<db> --file=deploy/managed-saas-postgres-roles.sql
MODEL_ROUTER_SAAS_DATABASE_URL=<migrator-url> node --import tsx src/cli/index.ts saas:migrate
psql -X -v ON_ERROR_STOP=1 --dbname=<db> --file=deploy/managed-saas-postgres-roles.sql
psql -X -v ON_ERROR_STOP=1 --dbname=<db> --file=deploy/managed-saas-validation-worker-role-grants.sql  # 需要 worker 探针时
```

无 PG env 时三个演练测试全部正确 skip。

## 取舍记录（I1）

- `instance-child.mjs` 装配的是**启动门禁链**而非完整 supervisor 单元：listener 绑定、web 静态资源、payments/webhooks 装配依赖 `src/server/managed-saas.ts` 的完整部署配置（`MODEL_ROUTER_DEPLOYMENT_MODE`、模块 specifier、端口），在隔离子进程单测环境复现成本高且与"启动即探针"的演练目标不成比例。门禁链顺序、fail-closed 语义、生产 ACL 核验（`verifySaasRuntimeDatabasePrivileges`）与 KMS readiness 自探针（`checkReady`，含 NODE_ENV=production 下的 pilot 门禁）与 B2 装配完全一致；KMS 主密钥由子进程内临时生成，不污染演练环境。listener 级 readiness 由 systemd 单元外部探针承担（B2 README）。
- 备份恢复工具恢复出的库对象属主保持 dump 原样（migrator），未重放角色模板——演练聚焦数据/台账完整性与 fail-fast 红线；角色模板幂等，需要时按上方装配流程重放。

## RPO/RTO 验收记录位

记录在 `docs/evidence/ops-01-drills.md` 的 "RPO/RTO 验收记录位" 表：每轮演练后刷新实测列（故障转移耗时、fencing 序列、恢复行数/台账 hash、拒绝路径结果），M3 按生产租约 TTL 与备份间隔定值复核。

## Track I 扩展方向

- 崩溃窗口参数化（--kill-after 由父进程按 marker 数触发，覆盖 0/k/末位三种窗口）；
- worker 类演练（credential validation / unknown-outcome recovery 的 SIGKILL 恢复；`instance-child.mjs` 的门禁链模式可直接扩展 worker 角色探针）；
- OS cleanup 演练（残留进程/文件/库的清场审计）；
- `backup-restore` 接入 CI（独立 job 或 runner env 扩展，设计见 `docs/evidence/ops-01-drills.md`）。
