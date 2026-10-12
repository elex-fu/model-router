# Managed SaaS role supervisor（B2 / RUN-01）

三个角色化 systemd unit + 一个分组 target，对应 `src/saas/deployment.ts` 的
workload role 契约（`combined` 仅开发用，生产禁止——部署解析器对此 fail-closed）：

| unit | workload role | 监听器 | 数据库角色 env |
| --- | --- | --- | --- |
| `model-router-saas-control-plane.service` | `control-plane` | customer `/console` + platform `/admin` | `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL` |
| `model-router-saas-gateway.service` | `gateway` | gateway `/v1` | `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL` |
| `model-router-saas-credential-validation-worker.service` | `credential-validation-worker` | 无 | `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL` |
| `model-router-saas.target` | （分组，非独立工作负载） | — | — |

## fail-closed 语义（不要在 supervisor 层破坏）

**启动本身就是探针**。每个角色在绑定任何监听器 / 发起首次 claim 之前，按序执行：
PostgreSQL ping → schema 校验（`verifySaasMigrations`，fail-closed）→ schema readiness
（control-plane 049/050/051 unknown-outcome；worker 双 owner 15 关系）→ 运行时最小权限
ACL 核验（`verifySaasRuntimeDatabasePrivileges`）→ webhook schema 校验 → KMS readiness
自探。任一失败进程非零退出。

因此 supervisor 约定：

- `Restart=on-failure`：**禁止**改为 `always`——门禁失败必须保持失败态等待人工处理，
  而不是无限热旋掩盖配置/授权漂移。
- 禁止 wrapper 脚本吞掉非零退出码；禁止 `ExecStartPre` 自动跑迁移
  （迁移只能经 `saas:migrate` 显式执行，服务启动永不迁移）。
- `Environment=NODE_ENV=production` 不得移除：运行时最小权限 ACL 核验
  （`verifySaasRuntimeDatabasePrivileges`）仅在 production 下执行，去掉它等于静默降级门禁。
- 迁移或角色模板（`deploy/managed-saas-postgres-roles.sql`、
  `managed-saas-validation-worker-role-grants.sql`）变更后：先重跑角色模板，
  再 `systemctl restart` 对应角色——启动 ACL 核验会拒绝特权未对齐的库。

## 安装

```bash
install -d -m 0750 -o root -g model-router /etc/model-router-saas
install -m 0644 deploy/systemd/managed-saas/*.service deploy/systemd/managed-saas/*.target \
  /etc/systemd/system/
# 参照 *.env.example 生成实际 env 文件；角色秘密文件 0400 root:model-router
install -m 0440 -o root -g model-router common.env            /etc/model-router-saas/
install -m 0400 -o root -g model-router control-plane.env     /etc/model-router-saas/
install -m 0400 -o root -g model-router gateway.env           /etc/model-router-saas/
install -m 0400 -o root -g model-router credential-validation-worker.env /etc/model-router-saas/
systemctl daemon-reload
systemctl enable --now model-router-saas-control-plane.service \
  model-router-saas-gateway.service model-router-saas-credential-validation-worker.service
```

- env 分层：`common.env` 只放评审过的非秘密元数据（部署/环境 ID、模块 specifier、
  监听器绑定）；秘密（角色 DSN、软件 KMS 主密钥）只放角色文件。
- 秘密绝不写入 unit 文件、命令行或 `systemctl show` 可见的 `Environment=` 行
  （本组 unit 中的 `Environment=` 仅含非秘密模式选择）。
- 多实例网关：在每节点单独 enable `model-router-saas-gateway.service`，
  不使用 target 分组；PG 仍是容量/租约/健康/affinity 的唯一权威。
- `Type=simple`：服务无 sd_notify；就绪判据 = 监听器已绑定（启动门禁先行通过），
  由外部 LB/监控按端口探测，supervisor 不伪造就绪信号。

## 配套

- IAM 与网络策略落地模板：`deploy/managed-saas-iam.md`（身份域、监听器暴露矩阵、
  egress 白名单模板、核对覆盖边界）。
- 可执行核对：`node scripts/check-managed-saas-deployment.mjs`——部署/变更后运行，
  覆盖 unit 强化指令、env 文件权限、跨角色 DSN 隔离与已安装 unit 漂移。

## 一次性管理命令（不属于本 supervisor 组）

`saas:migrate` / `saas:bootstrap-admin` / `saas:migration-audit` /
`saas:platform-mfa-enroll` 以 `MODEL_ROUTER_SAAS_DATABASE_URL`（迁移/管理连接）
手工显式执行，绝不配置为开机自启服务。
