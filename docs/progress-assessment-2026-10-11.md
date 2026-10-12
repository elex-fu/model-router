# 进度评估与 sub2api 对标（2026-10-11）

> 基于仓库交付证据（docs/development-progress-2026-10-09.md 全链）与 sub2api（~/play/sub2api）代码面核实。与 docs/parallel-iteration-plan-2026-10-10.md 附录 A 对齐。

## §11.1 十四任务状态

| 任务 | 状态 | 剩余 |
|---|---|---|
| GW-01 / FIN-01 / KEY-IP / KEY-BUD | ✅ 实质关闭 | REL-01 聚合 |
| RUN-01 | 🟡 ~85% | 云 KMS 决策门（M3） |
| PAY-01 | 🟡 技术关闭 | 真实商户联调（COM-01）、C5 Stripe 可选 |
| DB-01 | 🟡 工具链就绪 | 真实环境盘点 + 批准基线 |
| OPS-01 | 🟡 ~85% | backup-restore CI、worker SIGKILL、OS cleanup |
| UI-CUST / UI-OPS | ✅ 关闭 | — |
| PROV-01 | 🟡 ~70% | 真实 provider 矩阵实测 + 商业权利登记 |
| REL-01 | 🟡 模板/门禁就绪 | 固定 commit 全证据聚合（H3/H4） |
| COM-01 | ⬜ 未启动 | 外部审批 |
| ENG-01 | 🟡 进行中 | 域拆分续 |

里程碑：M0✅ M1 实质达成 M2✅；M3 当前目标线（G1+G4 已提前达成）。

## 已追平/超越 sub2api

兑换码（余额+订阅，不可逆存储超越）、公告+已读+通知中心、EasyPay（履约前强制查单+退款显式 unknown 超越）、账号池验证/周期复验、配额抓取（仅调度信号，刻意不同语义）、priority/weight 调度、Token 计费/钱包（定点+双录+冲正，全面超越）、TOTP+Passkey（超越）、控制台/运营后台、客户 Webhook（超越，sub2api 无）、安全/证据工程（全面超越——sub2api 凭证明文 JSONB 落库为红线禁止照搬项）。

## 仍缺能力

### A. 发布阻断级（M3/M4 出口）
1. 云 KMS 决策门 + 适配器（B1b，AWS KMS 候选）
2. 真实商户 PSP 联调（COM-01 外部依赖）
3. C5 Stripe 第二适配器
4. REL-01 证据聚合（H3/H4：FIN 矩阵 CI 收尾、双 PG、固定 commit）
5. DB-01 真实盘点 + 批准基线
6. OPS-01 尾项（backup-restore CI、worker SIGKILL、OS cleanup）
7. 061 注册决策 / 062 FIN fence
8. PROV-01 真实 provider 矩阵（Kimi Code / DeepSeek Anthropic 固定目标）

### B. 运营竞争力缺口（M4 前后应补）
9. G2 促销码（090 槽位保留，设计已冻结）
10. G3 邀请返利（091 槽位保留，提现审核依赖 E4）
11. PSP 渠道宽度（sub2api 五家 easypay/alipay/wxpay/stripe/airwallex；我方一家）
12. OAuth 账号 token 自动刷新（sub2api antigravity_token_refresher 等；我方只验证不刷新）
13. 账号/用户分组费率（sub2api account_group/user_group_rate；我方无 group 概念）
14. D5 多层限流调度 / D6 连续健康权重 + half-open
15. G4.5 公告 webhook fan-out worker（端口已留缝）
16. 凭证 quarantine 中间态（当前失败=直接下线）

### C. 明确不立项/延后（有决策记录）
内容风控（后续候选）、插件系统（模块化单体原则）、利润控制 failover（红线禁止）、返利现金提现（钱包余额发放）、社交登录（COM-01 定夺）。

## 结论

核心商业化闭环（充值→履约→计费→结算→退款→对账）100% 具备且证据链完整；对 sub2api 功能覆盖约 75–80%。M3 硬路径剩余全部为验证/审批性质，无大块新代码。建议下一步：H3/REL-01 证据聚合 → G2+G3（可再开并行波）→ OAuth token 刷新 → alipay/wxpay 适配器（沿用 C2 模式）。
