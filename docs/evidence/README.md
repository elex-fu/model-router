# docs/evidence — 发布门禁证据

本目录存放 REL 评审所需的**可重复门禁证据**。证据不是散文：每一条都必须能回溯到一个可执行的 CI 门禁（测试文件 + workflow 步骤），并携带原生计数（native counts）以便第三方复核"确实跑过、确实通过"。

## 约定

1. **证据单元 = 门禁（gate）**。一个 gate 对应一个可执行测试根（test root）与其在 `.github/workflows/ci.yml` 中的 required 步骤。
2. **每条证据记录必须包含**：
   - gate 标识与测试根路径；
   - commit SHA（`git rev-parse HEAD`）；
   - 运行环境：PG 大版本（15/18 双跑）、Node 版本、CI job 名或本地命令；
   - native counts：`node --test` 原生输出的 `tests / pass / fail / cancelled / skipped / duration_ms`；
   - 结论（GO / NO-GO）与评审人。
3. **捕获方式**：使用 `scripts/capture-gate-evidence.mjs`（见下文），禁止手填计数。
4. **失败证据同样保留**：NO-GO 记录标注失败签名（domain code / SQLSTATE），修复后在同一文件追加新一轮记录，不删除历史。
5. **密文红线**：证据中不得出现连接串、密钥、租户真实数据；脚本输出已做 URL/密钥脱敏，人工补充时同样适用。

## 捕获脚本

```bash
node scripts/capture-gate-evidence.mjs \
  --gate normal-success-terminal-replay \
  --test tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts
```

- 脚本以 `node --import tsx --test` 运行指定测试根，解析原生 reporter 计数；
- 环境变量（如 `MODEL_ROUTER_SAAS_GATEWAY_E2E_*`）由调用方提供，脚本不读取、不打印其值；
- 输出为一段可粘贴进证据模板的 markdown 记录（写入 stdout，`--out <file>` 可追加到文件）。

## 模板索引

| 模板 | 覆盖 | 状态 |
| --- | --- | --- |
| `gw-01-authorization-matrix.md` | GW-01 网关授权：双 PG 负向权限矩阵、same-scope/独占并发撤权 | A1 实装 |
| `fin-01-fault-matrix.md` | FIN-01 财务故障矩阵：取消补偿 / missing usage / 崩溃 / unknown / 并发 / 重复结算 | A3 实装 |
| `db-01-inventory.md` | DB-01 存量升级：逐环境台账/catalog 盘点证据、工具链试点记录 | H1 工具链实装，真实环境盘点待办 |
| `db-01-legacy-checksum-repair.md` | DB-01 022/023 历史 checksum 前滚修复设计（红线/前置/操作/验证/演练） | 设计待评审，未实装 |
| `ops-01-drills.md` | OPS-01 可靠性演练：双实例 SIGKILL 故障转移、备份恢复 fail-fast、RPO/RTO 记录位 | Track I（I1+I3）实装，scratch PG 记录；backup-restore CI 接入待办 |
