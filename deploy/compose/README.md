# Managed SaaS multi-instance deployment (Docker Compose, Phase 4)

单机多实例部署资产,对应 `docs/sub2api-parity-upgrade-plan-2026-10-15.md` Phase 4 与
`src/saas/deployment.ts` 的 workload 角色拓扑:

| 服务 | workload role | 监听器 | 数据库登录 |
| --- | --- | --- | --- |
| `control-plane`(×1) | `control-plane` | customer `/console` + platform `/admin` | `model_router_saas_control_plane` |
| `gateway`(×N,可 scale) | `gateway` | gateway `/v1` | `model_router_saas_gateway` |
| `credential-validation-worker`(×1) | `credential-validation-worker` | 无 | `model_router_saas_validation_worker` |
| `migrate`(profile `ops`,一次性) | —(显式 `saas:migrate`) | — | `model_router_saas_migrator` |
| `postgres:16-alpine` / `redis:7-alpine` | — | — | — |

与 systemd 部署(`deploy/systemd/managed-saas/`)的关键差异见文末。

## 红线(与 systemd 部署完全一致)

1. **PostgreSQL 是唯一权威**:容量、租约、健康、affinity、计费全部以 PG 为准;
   Redis 只做 control-plane 认证限流/缓存 + gateway 粘性会话快路径
   (专属 `MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL`,滑动 1h TTL,PG affinity 仍权威,
   任何 Redis 故障 fail-open;`appendonly no`,丢数据无害)。
2. **启动即探针,fail-closed**:每个角色绑定监听器/首次 claim 前依次通过
   PG ping → schema 校验 → 角色最小权限 ACL 核验(仅 `NODE_ENV=production`)
   → KMS readiness;任一失败进程非零退出。`restart: on-failure` 故意不用
   `always`——门禁失败必须保持失败态等待人工处理。
3. **服务启动永不迁移**;迁移只经 `docker compose run --rm migrate`(即
   `saas:migrate`)显式执行。
4. **密封凭证不降级**:软件 KMS 模块是 **pilot-only**(`deploy/README.md` B1a),
   `MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT=true` 是对该降级的显式接受;
   收费生产环境必须切云 KMS。
5. **密钥不落仓库**:`.env`、`./modules/` 下的可信模块永不提交
   (`.dockerignore` 已排除;`git status` 前自查)。

## 快速启动

前置:可用的 docker 与 docker compose v2;两个**operator 侧可信模块**
(见 `.env.example` 模块一节,契约见 `deploy/README.md`):

- `MODEL_ROUTER_SAAS_KMS_PROVIDER` — 导出 `createCredentialKeyProvider`(platform TOTP);
- `MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE` — 导出 `createManagedSaasGatewayRuntime`。

```bash
cd deploy/compose
mkdir -p modules          # 放入 platform-totp-provider.mjs / gateway-runtime.mjs
cp .env.example .env      # 逐项替换 <set-me> 占位符(密码、KMS 主密钥、origins)

# 1) 基础设施(pg 首次启动会执行 00-init.sql + 10-role-passwords.sh 建角色)
docker compose up -d --wait postgres redis

# 2) 应用主角色模板(迁移前的 ACL 基线;幂等)。注意:worker 授权模板
#    引用迁移 058 创建的表,只能迁移后应用,此时先跳过。
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres \
  -d model_router_saas -f /opt/templates/managed-saas-postgres-roles.sql

# 3) 显式迁移(migrator 登录;服务启动永不迁移)
docker compose run --rm migrate

# 4) 迁移后重放两条模板,安装运行期最小权限 GRANT(新表列级清单)
#    (每次迁移后都要重放)
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres \
  -d model_router_saas -f /opt/templates/managed-saas-postgres-roles.sql
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres \
  -d model_router_saas -f /opt/templates/managed-saas-validation-worker-role-grants.sql

# 5) 全角色上线
docker compose up -d
docker compose ps        # 期望全部 healthy
```

## 健康验证

**managed SaaS 模式没有 `/healthz` 路由**——`/healthz` 只存在于本地代理模式
(`src/server/proxy.ts`),`src/server/managed-saas.ts` 的三个角色都不暴露它。
因此 compose 层的健康探测是:

- `postgres`:`pg_isready`(镜像原生);
- `redis`:`redis-cli ping`(镜像原生);
- `control-plane` / `gateway`:容器内 `node` TCP 探测已绑定端口
  (control-plane 探 customer+platform 两个端口,gateway 探 `/v1` 端口);
- `credential-validation-worker`:无监听器,就绪由启动门禁保证,
  healthcheck 仅探主进程存活(容器存活与工作负载进程绑定)。

```bash
./verify.sh                       # 静态 config 校验 + 最小栈(pg+redis+单 gateway)运行探测
KEEP=1 ./verify.sh                # 同上但保留运行中的最小栈
docker compose ps                 # 各服务 healthcheck 状态
docker compose logs control-plane # 启动门禁输出(每角色应有各 listener 的 listening 日志)
```

一键脚本 `verify.sh` 会先做 `docker compose config -q`;在有 `.env` 且 docker
daemon 可用时进一步起最小栈并等待 compose healthcheck。网关未配置可信模块或
未迁移时非零退出,这是预期 fail-closed,脚本会原样打印日志、不掩盖状态。

## 迁移执行方式

迁移**只**通过一次性服务显式执行(等价 systemd 文档中的手工 `saas:migrate`):

```bash
docker compose run --rm migrate          # node dist/cli/index.js saas:migrate(migrator DSN)
```

`MODEL_ROUTER_SAAS_DATABASE_URL` 由 compose 用 `model_router_saas_migrator` 登录
拼装——迁移对象所有权归 migrator,运行角色永远拿不到 DDL 权限。每次迁移后
**必须重放两条角色模板**(见上第 4 步),否则新表缺运行期 GRANT,角色启动
ACL 核验会 fail-closed。平台管理员引导:

```bash
docker compose run --rm --entrypoint node migrate dist/cli/index.js saas:bootstrap-admin
```

## 扩缩容(gateway)

```bash
docker compose up -d --scale gateway=3
docker compose up -d --scale gateway=1
```

副本数受宿主端口范围约束:`GATEWAY_HOST_PORT_START`–`GATEWAY_HOST_PORT_END`
(默认 15007–15009,即最多 3 副本;更多副本请扩大范围或改用 LB/反向代理)。
`deploy.replicas` 也可经 `.env` 的 `GATEWAY_REPLICAS` 固定。多实例下 PG 仍是
容量/租约/affinity 的唯一权威;Redis 仅承担 control-plane 认证限流 + gateway
粘性快路径(经 `MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL`,默认指向栈内 redis;
注释掉 compose 中该行即回到纯 PG 路径)。

## 备份

```bash
docker compose exec -T postgres pg_dump -U postgres -Fc model_router_saas \
  > backup-$(date -u +%Y%m%dT%H%M%SZ).dump

# 恢复(到空库;恢复后按需重放角色模板)
docker compose exec -T postgres pg_restore -U postgres --clean --if-exists \
  -d model_router_saas < backup-XXXXXXXXTXXXXXXZ.dump
```

密封凭证信封由 `MODEL_ROUTER_SAAS_DEPLOYMENT_ID` / `_ENVIRONMENT_ID` 作为 AAD
绑定:跨部署/环境恢复 dump 需保持这两个 ID 一致,否则信封解密 fail-closed。

## KMS 轮换(rewrap)指引

入口:control-plane 的 platform `/admin` 路由
(`src/saas/platform/credential-rewrap-http.ts`,
`/admin/api/v1/supply/accounts/<accountId>/credentials/<credentialId>/rewrap`),
操作实现于 `src/saas/platform/credential-rewrap-operations.ts`;
`SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE`(专用 ReEncrypt-only 模块)已按
默认接好。轮换流程(pilot 软件 KMS,详见 `deploy/README.md` B1a):

1. 铸造新的 32 字节密钥(64 hex);
2. `.env` 中:`MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY` 换新值,
   `MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID` 与
   `MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID` 换新 key id;
3. 旧 `keyId=hex` 对写入 `MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS`
   (旧信封在 rewrap 完成前保持可解密/可重密封);
4. `docker compose up -d control-plane gateway credential-validation-worker`
   (滚动重启加载新 keyring);
5. 通过 platform `/admin` API 对存量信封逐个触发 rewrap,直至
   `PREVIOUS_MASTER_KEYS` 不再被引用后移除。

## 与 systemd 部署(deploy/systemd/managed-saas/)的差异

| 维度 | systemd | compose |
| --- | --- | --- |
| 进程监督 | 每 unit `Restart=on-failure` + systemd 加固指令(NoNewPrivileges 等) | `restart: on-failure` + 镜像内非 root `node` 用户;无 systemd 加固面 |
| env 隔离 | `/etc/model-router-saas/{common,per-role}.env`(root 属主 0400) | compose `environment:` 按角色白名单注入(部署解析器 fail-closed 兜底);`.env` 是宿主文件,权限由运维保证 |
| 监听器暴露 | 监听 127.0.0.1,由宿主反代终止 TLS | 容器绑 `0.0.0.0` 仅在 compose 网络内;宿主端口仍应置于 TLS 反代之后(Origins 必须 https) |
| 多实例网关 | 每节点单独 enable gateway unit | 单机 `--scale gateway=N` + 宿主端口段 |
| 迁移/管理命令 | 宿主直跑 `node dist/cli/index.js saas:migrate` | `docker compose run --rm migrate`(同一命令,容器内执行) |
| 软件模块 specifier | `./src/saas/runtime/...`(源码运行) | `./dist/saas/runtime/...`(镜像产物;rewrap `.mjs` 由 Dockerfile 单独装入 dist) |
| 部署核查 | `scripts/check-managed-saas-deployment.mjs` | `./verify.sh`(compose config + 最小栈探测);systemd 核查脚本不适用于容器 |

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 服务拓扑、按角色 env 白名单、healthcheck、端口发布 |
| `init.sql` | pg 首次启动建 4 个最小权限登录角色 + schema/ACL/search_path 基线 |
| `role-passwords.sh` | 首次启动从容器 env 安全注入角色密码(psql `:'var'` 引用) |
| `Dockerfile` | 多阶段构建(builder 全量依赖;runtime 仅生产依赖+dist+web 产物,非 root) |
| `Dockerfile.dockerignore` | 该 Dockerfile 专属的构建上下文裁剪 |
| `.env.example` | 全量变量与占位符(以 `src/saas/deployment.ts` 为权威契约) |
| `verify.sh` | `docker compose config` 校验 + 最小栈健康探测 |
| `modules/`(运行时创建) | operator 侧可信模块挂载点(`.gitignore` 范围外,勿提交) |
