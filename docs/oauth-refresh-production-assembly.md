# R4 OAuth 刷新链生产装配决策（#18）

日期：2026-10-11
状态：**决策（pilot 生效，M3 云 KMS 决策门复审）**
依据：`docs/remaining-capability-plan-2026-10-11.md` R4；J 的 R4 交付（`oauth-token-refresh-worker.ts` 两阶段设计）与 #18a 入驻初始化。

## 1. 问题

R4 刷新 worker 按两阶段设计运行：
- **阶段 A/C（受限角色）**：claim（FOR UPDATE SKIP LOCKED）→ 信封解封 → 有界 token 端点调用 → 写 `refreshing`/`idle`/`failed` 调度状态（oauth_* 五列）；
- **阶段 B（特权）**：经**已审计的供给轮换路径**（`replaceProviderCredentialSecretWithAudit`）写新版本链（versions INSERT、credentials.current_version CAS、authz_version+1、058 失效族、D3 复验、审计）——受限 `model_router_saas_validation_worker` 角色**刻意不持有**这些写权限（正是两阶段存在的原因）。

分裂部署下，装配问题 = **阶段 B 在哪个 workload 以哪个角色执行**。

## 2. 候选拓扑

| 方案 | 形态 | 评审 |
|---|---|---|
| **A（采纳）** | **整条刷新链收编进 control-plane workload**：store + rotator 同以 control-plane 角色运行（轮换权威本就属于 CP 的已审计路径）；授权扩展仅一项：CP 对 oauth_* 五列 UPDATE。验证 worker 角色只保留 401 force 信号置位 | 最小授权增量、零新拓扑、权威归属最干净 |
| B | worker runtime 内开第二条 CP 连接跑 rotator | 违反"单 workload 单角色"最小权限装配原则（worker env 刻意不含 CP URL）；拒绝 |
| C | 新建专用角色（worker claim 权 + 版本写权） | 新角色模板/探针/演练全链成本，M4 后再评；本期过度 |

## 3. 决策（方案 A）

1. **权威归属**：轮换权威从未属于 worker 角色（已审计路径自始是 CP 能力）；把调度态写（oauth_*）也归到 CP 后，**凭证生命周期权威在角色层面完全单点（CP）**——worker 角色退回纯信号位（401 force 置位，其既有 UPDATE 仅限该一列的既有授权不变）。
2. **授权扩展（唯一）**：control-plane 对双凭证表 `oauth_refresh_state / oauth_next_refresh_at / oauth_last_refresh_at / oauth_force_refresh_requested / oauth_refresh_error_code` 增 UPDATE（SELECT 已在 wave 3 授予）。runtime-privileges 注册表 + `deploy/managed-saas-postgres-roles.sql` 镜像 + 钉板同步；**部署注意：097/098 后角色模板须重跑**。
3. **KMS**：CP runtime 的 seal/rewrap KMS 模块（B1a 软件模块 pilot）同时实现 decrypt 契约，组合侧经显式 `oauthTokenRefresh.unsealingKms` 接缝注入——managed-saas 不替部署方做 loader 选择；pilot 期调用方以软件模块工厂实例注入，云 KMS 升级走 M3 决策门时替换注入点即可。
4. **rotator**：`ProviderSupplyService.replacePlatformProviderCredentialSecret`（公开已审计路径，CAS expectedVersion）包装为 `OauthCredentialRotator`；审计 `actorUserId` 来自部署显式提供的 `oauthTokenRefresh.operatorUserId`（必须为 saas_users 既有身份——bootstrap admin 或专用运营账号，entryPoint `oauth-token-refresh-worker`）。**装配修正（2026-10-12）**：worker 扫描 tenant+platform 双 scope，rotator 必须按 `ownerKind` 分派——platform 走上述方法；tenant（BYOK）走对称的运营者语义路径 `replaceTenantProviderCredentialSecretForOperator`（完整三元组凭证引用、无 TenantContext、同一 `replaceProviderCredentialSecretWithAudit` 内部：状态检查/CAS/#18a 调度继承/信封 seal/D3 复验重排/审计全同构，仅跳过租户成员鉴权与 BYOK entitlement 再授权——后者是 D3 复验 job 的职责，与 platform 路径逐字节对称）。接线同时 fail-closed 校验 operatorUserId 为未禁用的 saas_users 身份。
5. **不启用默认**：`oauthTokenRefresh` 选项缺席 = worker 不启动（pre-R4 行为），与 R4 worker 的 NULL=非 OAuth 语义一致。
6. **worker runtime 内的 `oauthTokenRefreshRotator` 接缝保留**：供经评审的自定义拓扑使用；与方案 A 组合互斥（两处同时提供 = 配置错误 fail-closed）。

## 3.5 授权附录（2026-10-12 装配落地补充）

原决策第 2 点只列 UPDATE 扩展；实际装配需要**第三处授权**：

- **CP INSERT += `oauth_refresh_state, oauth_next_refresh_at` 两列**（双凭证表）：#18a 入驻要求客户经控制台（CP workload）创建 OAuth 凭证时初始化调度（repository 条件 INSERT 命名这两列）。凭证生命周期权威归 CP 后，创建路径的 oauth 列初始化与 UPDATE 同属 CP 语义，此为决策 A 第 1 点的直接推论，非新授权面（CP 对这两列本就有 UPDATE）。
- **worker 角色收窄**：双凭证表 UPDATE 从五列 oauth_* 收窄为仅 `oauth_force_refresh_requested`（决策第 1 点的落实——worker 退回纯信号位）；SELECT 列表不变。

## 4. 与两阶段设计的关系

J 的两阶段（worker 写 `refreshing` → 特权 rotator → worker finalize）在方案 A 下同角色执行，**语义不变**：`refreshing` 标记与 stale 回收（15min）仍覆盖 rotator 崩溃窗口；行锁即租约、SKIP LOCKED 并发、退避/抖动、force 消费清理由 worker 逻辑原样承担。变化仅是执行角色从"worker+特权对"变为"CP 单角色"——少一次跨角色信任跳转，崩溃一致性反而更强（无角色边界两侧的部分提交）。

## 5. 投产检查单

- [x] 角色模板授权变更落地（CP INSERT += `oauth_refresh_state, oauth_next_refresh_at`、CP UPDATE += 五列、worker UPDATE 收窄为 force 位一列；SQL 模板 + TS registry 镜像 + 钉板同步）。**部署动作（未完成）**：097/098 后角色模板须在目标库重跑，启动 ACL 探针通过。
- [x] 接线落地：`oauthTokenRefresh` 选项（unsealingKms + operatorUserId）启动 CP 内刷新 worker；operatorUserId fail-closed 校验为未禁用 saas_users 身份；与 `oauthTokenRefreshRotator` 互斥 fail-closed；tenant/platform rotator 分派（§3.4 修正）。
- [x] 门禁对齐：094 门禁整链切 CP 连接（worker 角色收窄为 force 信号 + 四列 42501 负向 + 版本链负向）；#18a 门禁 CP oauth 写入翻正。真实 PG18 复跑：094 8/8、onboarding 10/10、quota-sync 6/6、quarantine 11/11（一次性库 model_router_test_r4asm*）。
- [ ] 部署配置提供 `oauthTokenRefresh.unsealingKms`（pilot：软件模块实例）与 `operatorUserId`（saas_users 既有身份）。
- [ ] M3 决策门：云 KMS 升级时仅替换 unsealingKms 注入实例（组合面不变）；rotator/审计语义不变。
- [ ] 遗留回填（#18a 已记录）：#18a 前创建的 OAuth 凭证（oauth_* 全 NULL）如需纳入刷新，走运营评审的显式回填（不自动采纳）。
