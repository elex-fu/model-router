# DB-01：022/023 历史 checksum 前滚修复设计

> 状态：**设计（未实装）**。本设计经评审批准前，任何环境不得执行 §4 的修复操作。
> 依据：`docs/sub2api-commercialization-integration-plan.md` §11 DB-01（"完成环境清单、022/023 历史盘点、批准基线及必要的前滚修复/升级演练，保持历史账本不变"）。

## 1. 背景

迁移校验是 fail-closed 的：`verifySaasMigrations` 要求台账中每条已应用迁移的 `checksum` 与当前代码逐字节一致（`sha256(name + '\0' + sql)`），不匹配即抛错，服务拒绝启动、`saas:migrate` 拒绝前滚。

022（route config authority）与 023（commercial metering policy authority）在发行史上存在**内容重盖章**：早期已应用它们的库存量库记录的是旧 checksum，与当前代码不一致。这类库因此既无法启动也无法前滚——尽管其 schema 语义与当前发行等价。

审计命令对此已有感知：022/023 的 checksum 漂移发出专属 `CHECKSUM_MISMATCH_022_023`；若漂移值命中经批准的历史映射（`--legacy-checksum`，携带 evidenceId），附加 `KNOWN_LEGACY_CHECKSUM` 标注。两者都**不**授予兼容性——标注只回答"这段历史是否已登记"，放行与否永远属于本修复流程。

## 2. 红线

1. **禁止改写业务/财务账本**：修复只触碰迁移台账 `saas_schema_migrations` 的 checksum 列；任何业务表、台账表（`saas_ledger_*`）、审计事件一律不动。
2. **前滚单向**：只许把旧 checksum 更新为当前发行值；禁止反向、禁止改名/改版本号、禁止增删行。
3. **逐环境、显式、可审计**：每次修复针对单一环境、由变更单批准；修复动作的完整输入输出作为证据归档。
4. **禁止自动基线**：catalog 基线只能来自评审（§601）；修复流程不生成、不提升、不自批基线。
5. **未登记历史不放行**：漂移值不在已批准映射内 → NO-GO 调查，禁止现场编造映射。

## 3. 修复前置条件（全部必须同时成立）

1. 盘点审计报告（含已批准 `--legacy-checksum` 映射）满足：
   - 022/23 之外零漂移：其余迁移全部 `state=match`；
   - 022/023 的漂移全部命中已批准映射（`KNOWN_LEGACY_CHECKSUM` 与 `CHECKSUM_MISMATCH_022_023` 一一对应，evidenceId 可追溯至历史发行评审记录）；
   - catalog 与**评审基线**一致（`catalog.actualChecksum === catalog.expectedChecksum`，即除台账两行外 schema 语义等价已被证实）；
   - 无 `MIGRATION_UNKNOWN` / `MIGRATION_OUT_OF_ORDER` / `CATALOG_*` / `LEDGER_*` 等其他 issue。
2. 该环境的升级变更单已批准，载明 evidenceId、目标 releaseId、执行人与复核人。
3. 修复前有可用备份（恢复演练覆盖，fail-fast 红线）。

## 4. 修复操作（设计）

由具备迁移能力的角色（`model_router_saas_migrator`，非运行角色）在**单事务**内执行，逐版本参数化：

```sql
BEGIN;
-- 对每个已批准映射 (version, legacy_checksum, current_checksum) 执行：
UPDATE model_router_saas.saas_schema_migrations
   SET checksum = :current_checksum
 WHERE version = :version AND checksum = :legacy_checksum;
-- 必须恰好 rowCount = 1；否则 ROLLBACK，环境原样保留。
COMMIT;
```

- 谓词同时钉住 `version` 与旧 `checksum`：任何并发/重复执行要么 no-op（0 行，判为已被修复→复核），要么失败回滚；绝不盲写。
- 两行（22、23）在同一事务内完成，避免半修复状态。
- 执行工具输出结构化 JSON 记录：环境标签、每行 (version, old→new checksum)、rowCount、执行人、变更单号——原样归档为该环境的修复证据。

### 是否实装为 CLI 命令

预留 `saas:migration-ledger-reconcile` 命令位（本设计批准后另行实现与评审）：输入 = 环境标签 + 已批准映射文件 + 当前发行 checksum 来源（代码注册表，禁止手填）；行为 = 上述单事务 + 证据输出。在设计获批前，只能按 §4 手工执行并留证。

## 5. 修复后验证（全部通过才算完成）

1. **复审计**：不带任何 `--legacy-checksum` 重跑 `saas:migration-audit` → 必须 `status=matched`（exit 0）、零 issue；legacy 映射从清单中移除（历史已前滚，不再是"存量旧值"）。
2. **启动门禁**：`verifySaasMigrations` 通过（服务可启动），`saas:migrate` 空跑确认无待应用迁移。
3. 修复证据 + 复审计报告 + 启动门禁结果合并归档进 `db-01-inventory.md` 的该环境小节，结论转 GO 待评审。

## 6. 禁止情形（任一命中即 NO-GO）

- 漂移涉及 022/023 以外的任何版本；
- 漂移值不在已批准历史映射内，或映射缺 evidenceId；
- catalog 与评审基线不一致（说明语义不等价，checksum 重盖章不成立，必须走完整迁移调查）；
- 台账存在未知版本、乱序、重名；
- 无变更单、无备份、无复核人。

## 7. 演练

修复实装/手工执行前，必须在一次性副本库（`CREATE DATABASE ... TEMPLATE`）上按 §3–§5 全流程演练一遍并归档证据；演练副本用后销毁。工具链试点（`db-01-inventory.md` §试点记录）已覆盖检测与标注环节；修复与复审计环节待首次真实需要时演练。
