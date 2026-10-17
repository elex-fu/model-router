# 部署运维效率提升技术方案（DOps-2026-10-17）

> 状态：已评审待实施 | 基线 commit `6c71ef2` | 前置分析：与 sub2api 的部署/运维/开发成本对比（2026-10-17 会话）
> 对标差距：冷启动部署 1–2 小时 vs sub2api 十分钟级；授权变更三处手工同步；升级走 297 行 runbook 人工序列；排障需通读探针日志与 fail-closed 语义。

## 0. 问题陈述与目标

### 0.1 差距的定量画像

| 维度 | 现状 | 目标 |
|---|---|---|
| 冷启动部署 | 1–2 小时（人工按 `deploy/README.md` 顺序执行：建角色 → 迁移 → 模板重放 → 逐 workload 配置启动） | **≤ 10 分钟单命令** |
| 授权变更 | 改 worker 写路径需同步 3 处授权镜像（`deploy/managed-saas-postgres-roles.sql` 1,623 行 / `src/saas/db/runtime-privileges.ts` 4,859 行 / `credential-validation-worker-privileges.ts` 901 行）+ 5–8 个 registry-tail 断言文件；本会话 P15/P15b/G2 三次事故全部源于此 | **单一清单，生成器产出全部镜像** |
| 升级 | `saas:migrate` + 人工模板重放 + 人工滚动重启 | **`saas:upgrade` 单命令**（备份点 → 迁移 → 重放 → 滚动 → 自检） |
| 排障 | 读探针日志、记 fail-closed 语义、跨 5 个 README 章节定位 | **`saas:doctor` 分级诊断单命令** |
| 部署回归拦截 | 无（P15b 类授权缺口只能上真部署才发现） | **CI deploy-smoke 门禁** |

### 0.2 红线（不可妥协的既有纪律）

1. **fail-closed**：一切编排步骤失败即停，绝不静默降级；预检不过不碰数据库。
2. **PG 权威 / 最小权限角色**：不新增超级用户路径；编排命令以 migrator 角色执行 DDL、以各 runtime 角色执行探针（探针失败 = 部署失败）。
3. **不自动迁移**：产品进程永不迁移 schema（现有纪律），编排命令是显式的运维入口。
4. **秘密零落盘**：命令输出永不打印任何凭证/密钥值（沿用 `check-managed-saas-deployment.mjs` 的只报键名纪律）。
5. **现有资产零重写**：probe SQL、迁移 runner、backup 命令、healthcheck 全部复用，本方案只加编排层。

## 1. 现有积木盘点（全部已验证存在）

| 积木 | 位置 | 状态 |
|---|---|---|
| 迁移 runner（含咨询锁/事务/漂移校验） | `src/saas/db/migrate.ts` `runSaasMigrations` / `verifySaasMigrations` | ✅ |
| 迁移审计 | `src/cli/saas-migration-audit.ts`（`saas:migration-audit` 命令） | ✅ |
| 角色模板（幂等重放） | `deploy/managed-saas-postgres-roles.sql`（模板自带 ownership/membership guard，重放安全） | ✅ |
| 三角色运行时探针 | `verifySaasRuntimeDatabasePrivileges(role)`（gateway/control-plane）+ `verifyCredentialValidationWorkerRuntimePrivileges`（worker） | ✅ |
| KMS readiness 契约 | `ProviderCredentialSealingKms/UnsealingKms/RewrappingKms`（含 `checkReady`） | ✅ |
| 备份命令 | `backup:create` / `backup:restore`（V2 离线备份链） | ✅ |
| 部署姿态检查（systemd 侧） | `scripts/check-managed-saas-deployment.mjs` | ✅ |
| 灾备演练 | `scripts/drills/`（backup-restore / instance-child / settlement-crash-child） | ✅ |
| compose 栈 + healthcheck | `deploy/compose/docker-compose.yml`（6 个 healthcheck） | ✅ |

**结论：没有任何一块需要从零写。** 四个方案全部是编排、生成与聚合。

## 2. 方案一：`saas:deploy` 一键部署编排（P0，2–3 人日）

### 2.1 命令契约

```
model-router saas:deploy [--env-file <path>] [--skip-migrate] [--dry-run] [--role <role>]
```

- `--env-file`：复用现有 deployment 配置解析（`src/config/deployment.ts` 的 per-role DB URL + KMS 模块声明），不发明新配置面。
- `--role`：默认全角色（migrate + 三 runtime 探针）；单角色模式供 compose 分容器调用（每容器只验证自己的角色）。
- `--dry-run`：只执行预检 + 打印将执行的步骤序列与目标，不碰数据库。

### 2.2 步骤序列（幂等，可重跑）

```
[1] 预检 preflight
    ├─ PG 连通 + server_version ≥ 15（模板同款 guard）
    ├─ 目标库存在；连接角色具备 CREATEROLE 或角色已存在（首次部署分支）
    ├─ schema 归属：model_router_saas 归 model_router_saas_migrator（模板 guard 的预检版）
    └─ KMS 模块声明完备（按 deployment 配置逐角色校验，不触碰密钥值）
[2] 迁移 migrate（显式调用 runSaasMigrations；--skip-migrate 跳过——供 CI 缓存场景）
[3] 角色模板重放 roles（psql 执行模板 SQL；模板幂等性由其自身 guard 保证）
[4] 探针 verify（三角色各建连接跑 verifySaasRuntimeDatabasePrivileges / worker 版；
    任何一列缺失 → 打印缺失清单并退出非零——这正是 P15b 类缺口的自动拦截点）
[5] workload 就绪等待（若同机 compose：轮询 healthcheck 端口；跨机：提示各角色启动命令并等待探针可跑通）
[6] 报告（每步 wall-clock + 探针结果 + 后续提示）
```

### 2.3 实现落点

| 文件 | 动作 |
|---|---|
| `src/cli/saas-deploy.ts` | **新建**：步骤编排、`--dry-run`、报告输出 |
| `src/cli/index.ts` | 注册命令 |
| `tests/cli/saas-deploy.test.ts` | **新建**：fake DB/KMS 下每步的成功/失败/幂等重跑矩阵 |
| `tests/cli/saas-deploy.integration.test.ts` | **新建**（PG-gated）：一次性 PG 上全序列 + 故障注入（角色缺列 → 第 4 步退出非零） |

### 2.4 验收

- 一次性 PG 18.6 上从空库到三角色探针全绿 ≤ 10 分钟（含容器启动计时另算）。
- 人为删一列授权 → 第 4 步精确点名（表/列/权限）并退出非零（P15b 回归测试的自动化版）。
- 幂等：连续跑两次第二次全步骤 no-op 通过。

## 3. 方案三：`saas:doctor` 诊断命令（P0，2 人日）

> 实施序位先于方案二：doctor 是 deploy 的第 6 步超集，共用诊断原语。

### 3.1 命令契约

```
model-router saas:doctor [--role <role>] [--json]
```

输出分级：`✓ pass / ⚠ warn / ✗ fail`，退出码 0/0/1。`--json` 供监控拉取。

### 3.2 检查项清单（全部映射到现成探针/查询）

| 检查 | 数据源 | 级别 |
|---|---|---|
| PG 连通/版本/迁移数 = registry 数 | `verifySaasMigrations` + registry 常量 | fail |
| 三角色列级授权 | 现有 verify 函数（缺列点名） | fail |
| KMS readiness（分角色：seal/unseal/rewrap） | `checkReady()` | fail |
| Redis（gateway 契约：RESP 白名单帧限） | 现有 redis 客户端配置探针 | fail(gateway) |
| 卡死执行行（600s 视界外 pending/unknown 计数） | H2 视界同款 SQL 的只读版 | warn（>0 提示 sweep 状态） |
| 恢复 sweep 健康度 | unknown-outcome 队列深度 + I1 warn 计数落表 | warn |
| 健康预热自愈（H5a/P18 后应零告警） | 040 表 stale 行计数 | warn |
| spending freeze 存在 | freeze 表非空计数（P12 类冻结即提示） | warn |
| systemd 姿态（如适用） | 复用 `check-managed-saas-deployment.mjs` 逻辑内联 | warn |

### 3.3 实现落点

`src/cli/saas-doctor.ts`（新建）+ 注册 + 单测（fake 数据源的分级矩阵）。**注意**：第 6/7 项的只读 SQL 需要为 control-plane 角色补少量 SELECT 授权（走方案二的清单流程，避免再次手工三处同步）。

### 3.4 验收

- P15b 复现场景（删授权列）→ doctor 一条命令点名列缺失。
- 全绿部署 → doctor 0 warn 0 fail。
- `--json` schema 稳定（供后续 Prometheus/告警接驳）。

## 4. 方案二：授权镜像代码生成（P1，3–4 人日）

### 4.1 现状问题（结构性的）

三个手工维护的授权面表达同一事实：

```
runtime-privileges.ts (TS 常量) ⇔ managed-saas-postgres-roles.sql (模板) ⇔ credential-validation-worker-privileges.ts (TS 常量)
```

一致性靠 mirror 测试事后断言——**能发现不同步，不能防止不同步**。本会话三次授权事故（P15/P15b/G2 的 EXECUTE 例外）均为"改了消费者忘了改镜像"。

### 4.2 目标结构

```
src/saas/db/privileges-manifest.ts        ← 唯一事实源（新）
  按角色 × 表 × 权限 × 列 的声明式清单，含每个授权的"需求方"注释
  （哪个触发器/worker 语句要求此列——I1 的审计格式直接搬进来）

scripts/generate-privileges.ts            ← 生成器（新）
  manifest → 生成 runtime-privileges.ts（TS 常量段）
           → 生成 roles.sql 的 grant manifest VALUES 段
           → 生成 worker-privileges.ts（TS 常量段）

mirror 测试升级：
  旧：断言三个文件互相一致（保留，作为生成物不被手改的防线）
  新：断言三个文件 == 从 manifest 重新生成的输出（byte-identical）
      → 手改生成物 = CI 失败，强制走 manifest
```

### 4.3 渐进迁移策略（不重写 7,900 行）

1. 生成器先做**反向工程**：从现有三个文件**提取**出 manifest（一次性，人工复核 diff 为零）。
2. 此后所有授权变更只改 manifest + 重跑生成器。
3. 手写区保留：roles.sql 的 guard/循环骨架不生成（生成器只替换 VALUES 段，用锚点注释圈定）。
4. registry-tail 断言文件不在生成范围（它们断言迁移历史，语义不同）。

### 4.4 验收

- 反向提取后 `git diff` 为零（生成物与现状 byte-identical）。
- 演练一次真实变更：加一列授权只动 manifest 一个文件，生成器产出三处。
- mirror 测试双重防线（互相一致 + 可再生）全绿。

## 5. 方案四：`saas:upgrade` 原地升级命令（P1，3–4 人日）

### 5.1 形态裁决：短停机滚动，不做在线热升级

- 不做 Go 式双缓冲/socket 继承热升级——与 fail-closed 纪律冲突面大，且 R9 kill-instance 实测（12/200 失败、幸存者接管）证明**滚动重启的代价已可接受**。
- 单命令覆盖 runbook，停机窗口目标 ≤ 2 分钟（迁移事务 + 模板重放 + 逐实例重启）。

### 5.2 步骤序列

```
[1] 前置：saas:migration-audit（已有）确认无漂移 + doctor 全绿（依赖方案三）
[2] 备份点：backup:create（已有）+ 记录迁移前 registry 版本（回滚锚点）
[3] 迁移：runSaasMigrations（事务内，失败即停——runner 已保证）
[4] 模板重放（新列授权）
[5] 探针复验（三角色）
[6] 滚动重启：compose 逐实例 `docker-compose up -d --no-deps gateway`；
    跨机部署输出 systemd unit 重启序列；每实例等 healthcheck 再下一个
[7] post-check：doctor 子集（PG/探针/迁移数）+ 单发冒烟请求（可配置 --smoke-url）
[8] 报告：升级前后版本、停机窗口、每步耗时
```

### 5.3 回滚策略（显式，不自动）

- 迁移失败：事务自动回滚（已有），无需操作。
- 迁移成功但运行时失败：`saas:upgrade --rollback-to <registry 版本>`——仅支持**备份恢复路径**（restore + 旧镜像重启），不做 down-migration（迁移不可逆是既有纪律：版本化/append-only 表设计）。
- 文档明示：down-migration 不存在，回滚 = 恢复备份点。

### 5.4 验收

- 一次性 PG 上演练：111→112 迁移的完整升级 + 探针 + 滚动 + 冒烟 ≤ 2 分钟窗口。
- 故障注入：模板重放失败 → 停在第 4 步，数据库停在已迁移状态但探针点名缺失（可安全重跑）。
- 演练脚本进 `scripts/drills/`（与现有三个 drill 同库）。

## 6. 方案五：CI deploy-smoke 门禁（P1，1–2 人日）

```yaml
# .github/workflows 现有 PG 门禁旁新增 job
deploy-smoke:
  services: postgres:16
  steps:
    - build
    - model-router saas:deploy --env-file ci.env --dry-run   # 步骤序列断言
    - model-router saas:deploy --env-file ci.env             # 全序列实跑
    - model-router saas:doctor --json | 断言全绿
    - 超时断言：全流程 < 15 分钟
```

**价值**：P15b 类授权缺口从"上真部署才发现"变为"PR 上 CI 爆红"——授权变更（走方案二后是 manifest 变更）若漏生成，deploy-smoke 的探针步骤直接失败。

## 7. 实施顺序与依赖

```
周1:  [方案一 saas:deploy] ──→ [方案三 saas:doctor]      （doctor 复用 deploy 的诊断原语）
周2:  [方案二 授权生成器]（反向提取 + 双防线）→ 演练一次真实授权变更
周2-3:[方案五 CI 门禁]（依赖一+三就位）
周3:  [方案四 saas:upgrade]（依赖 doctor + backup）
```

| 方案 | 人日 | 依赖 | 交付物 |
|---|---|---|---|
| 一 deploy | 2–3 | 无 | `saas:deploy` + 集成测试 |
| 三 doctor | 2 | 无（与一并行） | `saas:doctor` + 少量只读授权 |
| 二 生成器 | 3–4 | 无 | manifest + 生成器 + 双防线测试 |
| 五 CI | 1–2 | 一+三 | deploy-smoke job |
| 四 upgrade | 3–4 | 三 + backup | `saas:upgrade` + drill |

**合计 11–15 人日**；关键路径（一→三→四）约 1.5 周单人。

## 8. 与既有工作的协调

- **capability-parity worktree**（另一会话）：其迁移 115/116 若新增列授权，合并时**必须走新 manifest 流程**——生成器落地时间点若早于合并，worktree 的授权改动需要重做进 manifest（一次性成本，换来永久单一源）。
- **路线图占用**：本方案即路线图 §5.3 在线升级的具体化 + 部署效率条的落地；不与批次一~五的功能工作争夺文件域（CLI/生成器/drills 全是新文件或低冲突文件）。
- **K2 白名单 / K1 健康修复**：doctor 的检查项直接消费这两个修复引入的状态（sweep 计数、健康自愈告警），是其运维闭环。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 编排命令掩盖部署心智模型（新人不知底层发生了什么） | 每步打印等价的手工命令（可 `--verbose` 展开）；runbook 保留为原理文档 |
| 生成器反向提取出错（manifest 与现状有隐藏差异） | 提取后 byte-identical 断言强制为零 diff；任何非零 diff 逐条人工裁决 |
| doctor 的只读查询本身需要授权（鸡生蛋） | doctor 授权走 manifest 流程首次落地；探针连接用 migrator 角色（只读系统目录部分）+ runtime 角色各验各自 |
| 升级窗口内客户端请求失败 | 滚动重启 + 客户端重试（503 可重试语义 K1 已保证）；文档明示 SLA |
| CI deploy-smoke 时长挤占 CI 预算 | 一次性 PG 容器 + --skip-migrate 缓存迁移层；目标 < 15 分钟 |

## 10. 验收总清单

1. 冷启动：空 PG → `saas:deploy` 单命令 → 三角色探针全绿 + doctor 全绿，**≤ 10 分钟**。
2. 授权变更：加一列只改 manifest，生成器产出三镜像，CI deploy-smoke 绿。
3. 升级：`saas:upgrade` 全序列 ≤ 2 分钟窗口，含备份点与显式回滚路径。
4. 排障：P15b 复现场景下 `saas:doctor` 一条命令点名列缺失。
5. 演练：`scripts/drills/` 新增 upgrade drill，与现有 backup-restore/instance/settlement 同库同风格。
6. 红线复验：全流程无秘密值输出；探针失败即部署失败；产品进程仍不自动迁移。

---

## 附：实施后差距收敛预估

| 维度 | 现状 | 落地后 | sub2api |
|---|---|---|---|
| 冷启动 | 1–2h 人工 | ~10min 单命令 | ~10min |
| 授权变更 | 3 处 + 5–8 文件 | 1 处 manifest | 无此概念 |
| 升级 | runbook 人工 | 单命令 + 备份点 + 回滚路径 | 单命令 |
| 排障 | 读日志记语义 | doctor 分级单命令 | 内置面板 |
| 剩余差距 | — | 三角色拓扑 + KMS 配置（架构必然，安全下限的合理代价） | — |
