# DB-01 存量升级兼容盘点

> 任务定义：`docs/sub2api-commercialization-integration-plan.md` §11 DB-01；并行方案：`docs/parallel-iteration-plan-2026-10-10.md` Track H1。
> 门禁性质：**只读**。审计命令自身开 `REPEATABLE READ READ ONLY` 快照；本流程不新增任何写路径。

## 目的

对每个待升级环境回答三个问题，并留下可第三方复核的证据：

1. 该库的迁移台账（`saas_schema_migrations`）与当前发行是否逐条一致（版本/名称/checksum）？
2. 该库的 catalog 是否匹配**经评审的基线**（baseline 只能来自评审，禁止由工具生成或自我批准，§601）？
3. 若存在 022/023 历史 checksum 漂移，它是否对应**已批准的历史映射**（evidenceId 可追溯）？

任何环境问题下都不能放行升级：`unverified` 与 `mismatch` 同为 NO-GO，只是后续动作不同（补基线/调查 vs 走 022/023 修复设计）。

## 工具

| 件 | 位置 | 说明 |
| --- | --- | --- |
| 只读审计命令 | `model-router saas:migration-audit` | 单库审计，输出一行安全 JSON；`--legacy-checksum <22\|23>=<sha256>:<evidenceId>` 可重复，仅做已知历史标注（`KNOWN_LEGACY_CHECKSUM`），**永不授予兼容性** |
| 盘点运行器 | `scripts/db-01-inventory.mjs` | 按评审过的清单逐库执行审计，归档 `<env>.report.json` + `db-01-inventory-summary.md`；DSN 只经命名环境变量传入，归档前扫描脱敏；永不生成基线 |
| 修复设计 | `docs/evidence/db-01-legacy-checksum-repair.md` | 022/023 前滚修复路径（设计，未实装） |

清单格式见脚本头注释（`db-01-inventory-manifest-v1`）。清单本身**不含秘密**，`auditUrlEnv` 是环境变量名而非连接串。

## 逐环境证据记录

每个待升级环境一节。GO 的唯一条件：审计 `status=matched`（exit 0）且人工复核 report JSON 与基线 evidenceId 一致。

### 模板（复制后填写）

```
### <environmentId>（<deploymentId>）

- 日期 / commit / releaseId：
- PG 大版本 / 数据库名（脱敏标签）：
- 基线：evidenceId / 批准记录链接（无基线 = unverified，NO-GO）
- 台账：match <n>/<total>；漂移版本清单（若有）
- catalog：actual sha / 与基线比对结果
- 022/023：无漂移 / KNOWN_LEGACY_CHECKSUM（evidenceId）/ 未登记漂移（→ 修复设计 §3 禁止情形）
- 结论：GO / NO-GO；评审人：
```

### 试点记录：local-scratch（工具链自证，2026-10-10）

本记录证明工具链端到端可运行，**不构成任何环境的升级批准**（无评审基线，全部 NO-GO 为预期安全拒绝）。

| date | commit | deployment | environment | pg | ledger match | catalog sha | status | issues | GO |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-10 | 54142d5f8eb3 | local-scratch | scratch-pg18-ci | pg18 | 69/69 | 0d4ff51d7008 | blocked | BASELINE_MISSING | NO-GO |
| 2026-10-10 | 54142d5f8eb3 | local-scratch | legacy-022-demo | pg18 | 68/69 | 0d4ff51d7008 | blocked | BASELINE_MISSING, CHECKSUM_MISMATCH_022_023, KNOWN_LEGACY_CHECKSUM | NO-GO |

- `scratch-pg18-ci`：001→088 全链 scratch 库，台账 69/69 全 match——证明审计对当前发行的正向路径。
- `legacy-022-demo`：上述库的一次性副本，version 22 checksum 被人为改写为"历史值"，清单中以 `--legacy-checksum 22=<sha>:pilot-legacy-022-demo` 登记——审计正确同时发出 `CHECKSUM_MISMATCH_022_023`（阻断）与 `KNOWN_LEGACY_CHECKSUM`（标注），证明已知历史映射只标注、不放行（兼容性仍 `mismatch`）。副本已在演练后销毁。
- 试点同时暴露并修复了一个工具链缺陷：commander 将 `--legacy-checksum` 映射为单数属性，命令层读取复数字段导致标注静默丢失；已修复并以真实 CLI 回归测试固定（`tests/cli/saas-migration-audit.test.ts` 57/57）。

## 待办（真实环境盘点时）

1. 为每个待升级环境评审并批准 catalog 基线（禁止从空库自动生成自批，§601）。
2. 逐环境执行盘点运行器，将 report JSON 与本文件记录一并归档。
3. 命中 022/023 漂移时，按 `db-01-legacy-checksum-repair.md` 的前滚设计处理；未登记的历史值一律 NO-GO 调查。
4. 全部环境 GO 后，DB-01 才具备提交 REL-01 聚合的条件。
