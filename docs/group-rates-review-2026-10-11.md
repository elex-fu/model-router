# R9 分组费率：最小实现设计评审（登记稿）

日期：2026-10-11
状态：**评审登记**（方案 R9：`docs/remaining-capability-plan-2026-10-11.md`——本期仅登记槽位与原则，M4 后决定是否开建）
对标：`~/play/sub2api`（`group.go` / `admin_group.go` / `user_group_rate.go` / `group_model_allowlist.go` / `group_capacity_service.go`）

## 1. sub2api 的分组域语义（核实）

- **Group 实体**：独立分组表；用户/账号按组归属；组间配额隔离。
- **GroupModelAllowlist**：组级模型白名单（调度/授权过滤）。
- **UserGroupRateEntry**：组级**费率倍率**（rate multiplier）+ **RPM 覆盖**——计费时按用户所在组倍率计价，限流时按组覆盖 RPM。
- **GroupCapacityService**：组容量视图（组内账号健康/配额聚合）。
- 关键观察：sub2api 的分组穿透**定价**（倍率）、**限流**（RPM）、**授权**（模型白名单）、**容量视图**四个域，且账号与用户双侧都有归属。

## 2. 本仓现状对应物

| sub2api 概念 | 本仓对应 | 差距 |
|---|---|---|
| Group 归属 | **租户即天然分组边界**（钱包/定价/授权/预算全部租户维度） | 无跨租户分组，也无租户内子分组 |
| 费率倍率 | 定价快照 per plan_version（031）+ checkout 快照计算输入（G2 促销码接缝已证明"计算输入"模式） | 无租户级倍率 |
| RPM 覆盖 | R6 刚落地的**账号级** rpm_limit/tpm_limit（098）+ 租户级 RPM（001 saas_tenants.requests_per_minute） | 已有两级；无组级 |
| 模型白名单 | catalog 能力/权利矩阵（008/034）+ entitlement 供给模式 | 已有更严格的权利模型 |
| 组容量视图 | ops summary（E4，runtimeProbes 已接线） | 可按维度扩展 |

## 3. 评审结论（建议）

**不新建 group 实体。** 三条理由：

1. **权利模型已更严格**：sub2api 的组白名单解决"哪些用户能用哪些模型/账号"，本仓由 catalog 能力/权利 + entitlement + project policy 以更细粒度覆盖（且已过全部授权门禁）。引入组会造成第二套授权语义，直接冲突红线（授权域单一权威）。
2. **定价倍率可用"计算输入"模式以 1/10 成本覆盖**：G2 促销码已证明 checkout 定价快照接受外部输入且不回溯。租户级定价倍率只需：租户表加 `billing_rate_bp integer NULL`（NULL=10000=原价），checkout/结算快照计算时参与——**一次迁移 + 一个接缝**，无需 group 域。
3. **限流两级已足**：租户级（001 既有）+ 账号级（098 刚落地）覆盖 sub2api 组级 RPM 的实际运营场景；组级第三级只在"跨租户联盟定价"场景才有必要，而该场景同时需要倍率（由第 2 条覆盖）。

**若 M4 评审确认需要"运营套餐"概念**（同一商业条款作用于多租户），建议的最小形态：**租户标签（tag）+ 标签级定价倍率表**（tag→bp），授权/限流一律不穿透。严禁引入第二套授权语义。

## 4. 若开建的迁移预留

- 槽位：099+（按落地顺序即时分配，head 之下不留预留——2026-10-11 铁律）。
- 最小形态候选（仅登记，未冻结）：
  - `saas_tenants.billing_rate_bp integer NULL CHECK (billing_rate_bp IS NULL OR (billing_rate_bp > 0 AND billing_rate_bp <= 100000))`；
  - 结算/更正/预算协同审计（倍率参与的所有金额必须可溯源到快照，快照含倍率字段）；
  - 促销码/倍率叠加顺序冻结（先倍率后促销，文档化）。

## 5. 评审检查单（M4 用）

1. 是否存在"跨租户统一调价"的真实运营需求（而非 sub2api 对标惯性）？
2. 该需求能否被租户级倍率 + 现有权利模型完整覆盖？
3. 若必须组域：授权语义单一权威如何保持？（回答不了 = 不建）
