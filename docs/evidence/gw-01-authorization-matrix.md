# GW-01 网关授权 — 证据矩阵（模板）

> 用法：每次发布评审前，对每个 gate 在 PG15 与 PG18 上各跑一轮 `scripts/capture-gate-evidence.mjs`，把输出粘贴到「运行记录」表。矩阵单元格的"门禁"列是固定映射，变更映射本身需要 Track A 评审。

## 1. 负向权限矩阵（受限角色 × 禁止动作）

| # | 矩阵单元（角色 × 动作） | 门禁（CI required） | 期望拒绝签名 |
| --- | --- | --- | --- |
| P1 | gateway 角色直写触发器守护字段（attempt 状态机） | `tests/saas/db/migrations/054_trigger_only_trusted_execution.postgres.integration.test.ts` | SQLSTATE `55000` / `42501` |
| P2 | 受限角色篡改 prepared evidence 可选有效期标量 | `tests/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.postgres.integration.test.ts` | SQLSTATE `55000` / `42501` / `23514` |
| P3 | 受限 CHECK 直改 + 平台授权域越权执行 | `tests/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.postgres.integration.test.ts` | SQLSTATE `55000` / `42501` |
| P4 | 运行时角色清单漂移（control_plane / gateway 全量核对） | `tests/saas/db/runtime-privileges.integration.test.ts`（provisioning 步骤内） | 断言失败即红 |
| P5 | 迁移注册表/校验和篡改（checksum、顺序、缺失） | `tests/saas/db/migrations/migration-registry.test.ts`（npm test） + `saas:migration-audit` | fail-closed 抛错 |

## 2. 并发撤权矩阵（same-scope / 独占窗口）

| # | 矩阵单元 | 门禁（CI required） | 关键断言 |
| --- | --- | --- | --- |
| C1 | admission prelock 与并发撤权竞争（same-scope） | `tests/saas/gateway/authorization-prelock-postgres.integration.test.ts` | 撤权生效后同 scope 新准入被拒绝 |
| C2 | admission prelock 独占窗口（排他锁序） | 同上 | 锁序确定，无死锁/越权准入 |
| C3 | prepared evidence 并发 claim 双连接竞争 | `tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts` | 恰好一个 claim 成功 |
| C4 | 凭证失效触发器执行（035/058 守护） | `tests/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.postgres.integration.test.ts` | 失效传播，无残留可用凭证 |

## 3. 运行记录（native counts，脚本捕获）

| 日期 | commit | gate | PG | tests/pass/fail/skip | duration_ms | 结论 | 评审 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _待捕获_ | | | 15 | | | | |
| _待捕获_ | | | 18 | | | | |

## 4. REL 评审 checklist

- [ ] §1–§2 每个矩阵单元在 PG15 与 PG18 均有一条 GO 记录；
- [ ] 每条记录的 native counts `fail = 0` 且 `pass ≥ 1`（skip 仅允许 env 未配置时的本地运行，CI 记录不得含 skip）；
- [ ] 矩阵单元 → 门禁映射与 `.github/workflows/ci.yml` 当前 required 步骤一致（由 `tests/ci/managed-saas-required-gates.test.ts` 固定）；
- [ ] 所有记录 commit 与候选发布 commit 一致或为其祖先。
