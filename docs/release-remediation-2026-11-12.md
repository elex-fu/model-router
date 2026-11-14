# 发布阻断修复与证据账本（2026-11-12）

代码基点：`92eebc4321520e9323395301931e4d199cda976c`。本轮修改尚在工作区，含进入任务前已有的四份 auto-ban 权限补丁；本地通过代表该源码快照的开发验证，不能写成该基点 SHA 已通过发布验收。各 runner 同时记录基点、源码哈希、开始/结束候选身份和清理结果；`ok` 与 `promotable` 分开。

## 当前裁定

| 优先级 / 项 | 本轮交付与现状 | 发布条件 |
| --- | --- | --- |
| P0 内容审核 auto-ban | 补齐 gateway 对 key 的 `status/revoked_at/revoked_by_user_id/authz_version` 四列 UPDATE；保留其他身份、scope、配额写入禁令。真实 PG15/18 验证停用、吊销、授权版本、审计幂等、旧数据收敛、管理员保护和事务回滚。加入双版本 required matrix。 | 新部署重新应用角色模板；旧权限部署会在 privilege readiness 阶段拒绝启动。最终干净候选重采证据。 |
| P0 PSP B0/B1 | 代码装配与合成故障测试不等同 PSP 验收；本轮没有可用 sandbox 商户/真实支付凭据。新增发布检查强制 live PSP、乱序回调、重入、全/部分退款、unknown 及恢复证据。 | 指定真实商户与 sandbox/小额生产环境，归档原始交易/回调/退款及最终账本证据。M2 继续阻断。 |
| P0 C0 | 产品/能力/权益三次查询合为一次锁后快照；每次 catalog eligibility 从四条语句减至两条（含独立产品锁）。不缓存 guard，不合并锁等待和数据快照，不更改金融写入/持久性。修复 13 阶段 trace 的导出兼容性及失败门禁。 | 原 strict 串行四腿门槛仍为 30/10ms。当前未通过；后续架构工作见下文。 |
| P0 生产 C2 | 发布检查要求生产 KMS、IAM、异地 PITR、HA、告警真实送达、值班确认和运营签收。 | 本地软件 KMS / standby 演练不能替代上述生产证据。 |
| P0 Codex A2 | reviewed registry 及实际六轴外部证据缺口没有被合成测试补写；候选明确 `codex=false`，不可售卖。 | 精确 endpoint/productId/model/operation/transport/continuationMode、可信后端 revision、计量边界和真实工作流均须有证据。 |
| P1 A0/A1 | 当前环境没有 Kimi 供给引用的有效环境变量；未调用真实上游。历史通过只属于历史 SHA。 | 冻结源码并提供临时供给后重跑 `kimi` / `platform-access` 及相应 CLI live suites。 |
| P1 fast | 默认关闭。T11–T14、Anthropic native、稳定验收及零拒绝均作为启用时的额外门槛。 | 未满足前不能以旧吞吐数字开放售卖。 |
| P1 G-B5 | Realtime WS 和音频计量评审仍未交付，候选明确 `realtime=false`。 | 音频计量评审、实现、取消/unknown/计费闭环后单独验收。 |
| P1 集成测试 | 新增逐根新数据库模式，显式补建 055/056/059、取消补偿、并发 claim、dispatch-capacity 的 HTTP 依赖。全套管理 PG 测试禁止继续复用调用方的共享 E2E URL。 | 双版本 required roots 和全量集成结果以本文件验证记录为准，不能把未配置而跳过算通过。 |
| P1 122 | 修复 PG18 将 NOT NULL 列入 `pg_constraint` 后把它误计为业务 CHECK 的测试：显式限定 `contype='c'`。加入双版本 required matrix。历史迁移 SQL 不变。 | 全新 PG15/18 独立执行。 |
| P1 代码债务 | 本轮只做直接相关的 catalog 模块与测试修复，没有批量删除 knip 候选或改写全部 warning。两个大型 composition 文件的拆分仍待专门实施。 | 每个模块独立拆分并回归 lifecycle/授权/关闭行为，不能通过关闭 lint/knip 消除债务。 |

## 已修复的证据缺陷

1. `capture-gate-evidence.mjs` 显式使用 spec reporter，只接受唯一原生计数、正测试数、全部通过、零 skip/cancel/todo。全跳过不能再生成 GO。
2. 记录完整 40 位 SHA；采集前后检查干净状态与源码内容指纹。已经脏的文件在运行中再次变化也能识别。`--out` 应写到仓库外的 CI artifact 目录，避免写证据本身污染下一次源码采集。
3. commercial PG runner 和 R9 runner 都记录开始/结束的候选身份。本地 `ok=true` 的脏工作区结果仍为 `promotable=false`。
4. 新增 `release:check`：M1 强制 A0/A1/auto-ban；M2 额外强制 B0/B1/C0/C1/C2；M3 额外强制 A2/完整协议矩阵。启用 fast/Codex/Realtime 会增加对应证据要求。基础门从被哈希的 runner artifact 读取原生计数，验证同一干净 SHA；auto-ban 必须同时具备 PG15/18。
5. 发布 manifest 的声明只用于审核门槛，不能自行证明支付或基础设施真的发生过。外部 artifact 的真实性、商户授权及签收仍需负责人员审核。当前示例 manifest 故意为空，执行结果必须是 NO-GO。

```sh
rtk npm run release:check -- docs/evidence/release-candidate-2026-11-12.json
```

本检查是显式发布审核入口，未声称已经配置远端 branch protection 或接管现有部署系统。双 PG 的 auto-ban / 122 / catalog / Passkey 回归已接入 `.github/workflows/ci.yml` 的无条件 required matrix。

仓库内 JSON 是固定的 NO-GO 模板。真正采集时，先冻结干净代码提交，再把 manifest 复制到仓库外的 CI artifact 目录，填入该提交的完整 SHA 和 artifact 的绝对路径/摘要，在保持工作区干净的情况下执行 `release:check /path/to/release-manifest.json`。不要尝试把一个提交的自身 SHA 写进同一提交内的 manifest，也不要把证据文件追加到被检查的工作区里。

全量隔离执行还修复了 Passkey readiness 对合法计量 validator EXECUTE 的误拒绝、G5 读取测试过时的 DTO 白名单，以及其他历史权限断言。Passkey 仅允许既有精确签名、migrator owner、immutable/invoker/boolean 的计量函数；没有新增函数 EXECUTE 授权。原生 runner 按测试根提供自有 Redis、升级测试的临时管理员 URL 及随机软件 KMS 测试密钥；所有测试库统一 UTC 和 durable writes，避免依赖本机时区或开发者常驻服务。

## C0 新证据与后续架构边界

改造前本轮新构建、PG18、三网关、原持久性、prepared statements=off、strict 串行四腿各 100：P99 额外开销 **647.73ms**，TTFB **109.79ms**，流式错误 0，仍未过 30/10ms。路径：`/tmp/model-router-c0-current-20261112/`。这不是隔离主机上的跨版本性能提升证明。

插桩轮 `/tmp/model-router-c0-trace-20261112/` 只用于定位，不能替代无插桩验收。原始导出因阶段列表滞后失败，修复后离线重处理为 `serial-profile-request-traces-reprocessed.json`：200/200 关联、零 missing/duplicate/incomplete/malformed；111 条未入测量窗的记录单列为 unrelated。中位数：客户端 query 132 次/请求，发送前 97 次；query exclusive 约 43ms，完整请求约 52–54ms；观察到 7 次 transaction span，**不能据此推断 7 次 fsync**。`pg_stat_statements` 的 377.5 calls/上游 attempt 包含触发器、内部语句及装配工作，与客户端 query 数不是同一口径。

本轮 catalog 改造保持产品锁为独立语句，取得锁后再用一个 READ COMMITTED 快照读取产品、最新能力、权益历史；版本 JSON 使用十进制字符串，排序使用底层数值列。专门的真实 PG 测试覆盖版本 10/2 数值排序，以及读者实际等待未提交撤权后看到 revoked。

改造后新构建的无插桩串行四腿结果为 **94.47ms P99 / 281.71ms TTFB** 额外开销；四腿各 100、流式错误 0、durability 保持 on、prepared statements=off，源码/dist/harness 均无运行中变化，资源清理完成。证据：`/tmp/model-router-c0-after-batch-20261112/`。本机 10 核，轮前/后 load1 为 28.57/23.08；没有并行运行本轮测试，但背景负载较高，**不作改造前后 A/B 收益结论，也不宣告 C0 通过**。两个原门槛仍失败。

数量级改造仍需继续，不以本轮两条 round-trip 的局部优化宣称完成 C0：

1. 用现有 preparation transaction facts 将 admission、签名 evidence 注册和 dispatch intent 组合为一个有界事务。所有授权 fence 后必须独立 fresh read；pre-hold、配额、key budget、不可逆派发 intent 必须在出站前提交。
2. 将正常完成的 usage、精确结算、容量/lease 释放和持久 outbox 放在同一最终事务中。可延后的是通知、遥测和派生统计；账本、hold、unknown 状态不得异步丢失。数据库 FK/guard 不移除。
3. 每一步保留丢 COMMIT 响应、发送后断线、重复回调、取消和 SIGKILL 的 durable 回读；unknown 不能解释为未发送，重启不能重复派发或自动释放未知 hold。
4. 完成后冻结新的精确 SHA，重新执行无插桩 strict 四腿、超载/容量和金融故障回归。若仍需调整门槛，必须单独形成正式决定；本轮没有降低 30/10ms。

## 复现命令与验证记录

```sh
# 逐根新库；每个历史根的 HTTP 依赖在它自己的库里创建。
rtk proxy env MODEL_ROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@18/bin \
  MODEL_ROUTER_TEST_CONCURRENCY=4 npm run test:integration

# 单独重跑 059：不再要求操作者手工记住上一个测试。
rtk proxy node scripts/run-commercial-postgres-gate.mjs \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --test-file tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts

# 多根顺序执行，但每个根仍创建不同的新数据库。
rtk proxy node scripts/run-commercial-postgres-gate.mjs \
  --pg-bin /opt/homebrew/opt/postgresql@15/bin \
  --test-files tests/saas/risk/content-moderation.postgres.integration.test.ts,tests/saas/db/migrations/122_multimodal_billing_dimensions.postgres.integration.test.ts
```

| 最终验证 | 原生结果与边界 |
| --- | --- |
| 单元套件 | 8,234 tests：8,209 pass、0 fail、25 skipped。跳过不充当外部门证据。 |
| 普通集成部分 | 385 tests：335 pass、0 fail、50 个未配置环境的可选检查 skipped。 |
| 完整管理 PG18 集成 | **87 个独立数据库根、586/586 pass、0 fail/skip/cancel/todo**；另有 210 项必需 HTTP 前置夹具检查通过；全程源码变化 0，PG/Redis 全部停止并清理。完整 `test:integration` 命令 exit 0。 |
| PG15 关键回归 | auto-ban、catalog、122、Passkey、054/055、授权 prelock、059 均通过；060 修复后独立 **7/7** 通过。之前批次的 060 失败记录保留。 |
| 崩溃回归修复 | SIGKILL 测试在子进程死亡后等待实际 PG backend 退出，避免恢复 worker 合法 SKIP LOCKED 时过早断言失败；真实 journal **71/71** 通过，完整集成也复验通过。没有放松扣款、余额、幂等或 unknown 断言。 |
| 构建与门禁 | server build、CI 的完整 isolated roots 严格编译、G5/060/journal 额外严格编译、required wiring 与权限镜像再生成检查均通过。远端 CI 未据此冒称运行。 |
| lint / knip | lint 无错误，仍有 **1,635 warnings / 170 infos**；knip 仍为 **7 files / 167 exports / 117 types**，其非零退出仍是未处理债务。 |
| 反向证据门 | 未配置 Kimi 的 live suite 原生 exit 0/fail 0/skipped 1，capture 明确返回 **NO-GO / exit 1**；空发布 manifest 同样拒绝。 |
| C0 | 改造后仍为 **94.47/281.71ms > 30/10ms**，保持阻断。 |

原始计数、完整基点 SHA、源码快照摘要、raw artifact SHA-256 与清理结果见 [开发验证摘录](validation/release-remediation-2026-11-12/development-verification.json)。所有本轮工作区结果都标记 `developmentOnly=true / releaseGo=false`，不替代干净候选重采。

已有失败原件保留：122 PG18 NOT NULL 误计、旧权限断言、G5 DTO 与 060 清单/RETURNING 漂移、trace 阶段不兼容和 SIGKILL 后端回滚时序均有原始记录；修复不删除失败历史，不修改已应用迁移，不为业务角色添加 fixture 特权。测试管理员只用于自有 scratch 升级库，软件 KMS 测试密钥只作用于指定的合成测试。
