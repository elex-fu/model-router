# Managed SaaS  workload 级 IAM 与网络策略（B3 / RUN-01）

> 配套：`deploy/systemd/managed-saas/`（supervisor 清单）、
> `scripts/check-managed-saas-deployment.mjs`（可执行核对）。
> 本文是落地模板：列出每个 workload 的身份边界、最小权限依据与网络策略；
> 可执行部分由核对脚本兜底，文档不外泄任何秘密值。

## 1. 身份域模型

### 1.1 PostgreSQL 角色（权威：`deploy/managed-saas-postgres-roles.sql` + `managed-saas-validation-worker-role-grants.sql`）

| 角色 | 持有者 workload | 权限轮廓 | 禁止 |
| --- | --- | --- | --- |
| `model_router_saas_migrator` | 一次性 `saas:migrate` / 管理命令 | DDL + 台账写入 | 不得作为任何常驻服务的 DSN |
| `model_router_saas_control_plane` | control-plane | 列级精确授权（见 `src/saas/db/runtime-privileges.ts` 注册表），无 gateway 热表写 | 不得持有迁移能力、不得持 gateway 角色表 |
| `model_router_saas_gateway` | gateway | 准入/租约/容量/健康/亲和所需的列级最小集 | 不得读控制面身份/财务表 |
| `model_router_saas_validation_worker` | credential-validation-worker | 双 owner 队列表 claim/更新 + 凭证解密所需列 | 不得写账务、不得持控制面会话表 |

约束：启动时 `verifySaasRuntimeDatabasePrivileges` 逐列实测（仅 `NODE_ENV=production`），
特权未对齐 = 启动失败。迁移后必须重跑角色模板再重启服务。

### 1.2 KMS 姿态

| workload | 能力 | 模块 env |
| --- | --- | --- |
| control-plane | seal（写凭证）+ rewrap（一次性轮换） | `SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE` / `SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE` |
| gateway | **decrypt-only** | `SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE` |
| credential-validation-worker | **decrypt-only** | `MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE` |

- 软件 KMS 模块为 pilot-only（启动告警 `MODEL_ROUTER_SOFTWARE_KMS_PILOT_ONLY`）；
  主密钥只出现在对应角色 env 文件（0400），云 KMS 升级走 M3 决策门。
- rewrap 模块 specifier 必须与 seal/decrypt 不同，且仅 control-plane 可装载。

### 1.3 Redis 边界

Redis 仅承载控制面认证限速与派生缓存；**永不**作为账务台账、gateway 租约/容量/健康/亲和的权威。
任何把 Redis 提升为权威存储的部署变更都是红线违规。

## 2. 监听器暴露矩阵

| 监听器 | 路由前缀 | 暴露面 | 策略 |
| --- | --- | --- | --- |
| customer | `/console` | 终端用户 | 仅经 TLS 终结的反向代理；origin 精确匹配 |
| platform | `/admin` | 运营/安全角色 | **不得公网**；仅运营网段/VPN + TLS 反向代理 |
| gateway | `/v1` | 付费调用方 | 经 LB/WAF；origin 与限流按部署评审 |
| credential-validation-worker | 无监听器 | — | 任何入站连接都属异常 |

## 3. 出站（egress）策略模板

最小允许集（其余默认拒绝）：

| 源 workload | 目的 | 说明 |
| --- | --- | --- |
| 全部 | PostgreSQL / Redis | 仅配置地址与端口 |
| control-plane | PSP API（EasyPay 端点，https） | 回调履约前主动查单；退款明文 pkey 风险要求**出口白名单到 PSP 域名**（`docs/parallel-iteration-plan-2026-10-10.md` Track C 红线） |
| control-plane | 客户 webhook 端点 | 仅经投递管道的 SSRF 钉板出口（私网/环回拒绝在管道内强制执行） |
| gateway | 上游 provider API | 已批准 provider 产品端点清单 |
| credential-validation-worker | 上游 provider API | 同上（验证探测） |

nftables 骨架（按部署实际地址替换占位）：

```
table inet modelrouter {
  set pg_endpoints { type ipv4_addr . inet_service; flags interval; elements = { 10.0.0.10 . 5432 } }
  set redis_endpoints { type ipv4_addr . inet_service; flags interval; elements = { 10.0.0.11 . 6379 } }
  set psp_endpoints { type ipv4_addr . inet_service; flags interval; elements = { 203.0.113.20 . 443 } }
  chain egress_control_plane {
    ip daddr . tcp dport @pg_endpoints accept
    ip daddr . tcp dport @redis_endpoints accept
    ip daddr . tcp dport @psp_endpoints accept
    # webhook 投递走独立钉板出口节点时，此处不放行任意 443
    counter drop
  }
}
```

k8s 部署等价物：每 workload 一个 NetworkPolicy（podSelector 按角色标签），
egress 仅 toSelector/toCIDR 上述集合；platform 监听器入站仅运营命名空间。

## 4. 可执行核对

部署/变更后运行（不打印任何秘密值，只报告键名、文件权限与指令存在性）：

```bash
node scripts/check-managed-saas-deployment.mjs            # 生产默认路径
node scripts/check-managed-saas-deployment.mjs --units <dir> --env <dir>   # 预演/CI 夹具
```

覆盖：unit 强化指令齐备 + 角色正确 + `Restart≠always` + 无内联秘密；env 文件权限
（秘密文件 owner-only、common 无 other 可读）、必备键、跨角色 DSN 隔离
（gateway.env 不得持控制面 URL 等）、common.env 零秘密值、已安装 unit 与仓内评审副本零漂移。

未覆盖（需人工/其他门禁）：PG 角色实际授权（由启动 ACL 核验与
`runtime-privileges.integration.test.ts` 覆盖）、云 IAM 主体映射（M3 云 KMS 决策门）、
PSP 白名单与商户配置的审批记录（COM-01）。
