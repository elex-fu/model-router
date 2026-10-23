# 服务器登录、部署与验证

本机填写 `deploy/remote-server.local.env`，模板是
[`remote-server.env.example`](remote-server.env.example)。本地文件权限为 `600`，
Git、npm 打包和源码上传均排除该文件。脚本不执行配置中的 shell 表达式。

| 字段 | 填写内容 |
| --- | --- |
| `SERVER_IP` | IP、域名或 SSH config 别名 |
| `SERVER_PORT` | SSH 端口，默认 `22` |
| `SERVER_USERNAME` | SSH 用户名 |
| `SERVER_SSH_KEY` | 本机私钥绝对路径或 `~/.ssh/...`；使用密码时留空 |
| `SERVER_PASSWORD` | 密码；使用私钥或 SSH agent 时留空 |
| `SERVER_DEPLOY_DIR` | 服务器代码目录，默认 `/opt/model-router` |
| `DEPLOYMENT_KIND` | `managed-saas`（默认）或 `self-hosted` |

值按字面量读取：不要加引号、`export` 或行尾注释。私钥只填路径，推荐保存在
仓库外。若两种认证字段均为空，使用 SSH agent / `~/.ssh/config`；私钥优先于密码。
已有 `deploy/remote-server.env` 会保留；默认优先读取新的 `.local.env`，不存在时
才读取旧文件，也可用 `--config <path>` 明确指定。

## 使用

从仓库根目录执行（新 checkout 先执行 `--init`，不会覆盖已有文件）：

```sh
./scripts/deploy-remote.sh --init
./scripts/deploy-remote.sh --check       # 登录、系统负载、Docker/Compose/rsync 检查
./scripts/deploy-remote.sh --login       # 交互式 SSH shell
./scripts/deploy-remote.sh --upload      # 仅上传源码，首次 SaaS 配置时使用
./scripts/deploy-remote.sh --deploy      # 上传、构建、启动、健康与 HTTP 就绪验证
./scripts/deploy-remote.sh --verify      # 单独验证现有部署，不上传或重启
```

`--upload` / `--deploy` 显示目标并要求终端确认；自动化可显式加 `--yes`。
支持 `--config deploy/remote-server.staging.env`，同命名的 `.env` 文件也被 Git 忽略。
无参数沿用原脚本的部署行为。

本机需要 Bash、OpenSSH；上传还需 Git、rsync；**仅密码认证需要 sshpass**。
服务器需 Bash、rsync、Docker、Docker Compose v2（支持 `up --wait`），登录账号
能访问 Docker daemon 并写入部署目录。脚本不自动安装系统依赖或执行 sudo。

SSH 保持主机指纹核验。首次连接先通过 `--login`（密钥/agent）或手工
`ssh -p <端口> <用户名>@<地址>` 核对服务器控制台提供的指纹。密码文件模式下，
sshpass 不自动接受新指纹；未确认时会停止并提示。带口令私钥可先 `ssh-add`。

上传使用 Git 已跟踪文件的当前内容，包含未提交修改；新源码须先 `git add`。
忽略文件、环境配置、密钥和 operator 模块不会随源码上传。脚本仅清理上次由它
部署且本次移除的源码，不使用 `rsync --delete` 删除服务器本地配置或数据卷。

## 首次部署

- **self-hosted**：填好 SSH 配置并通过 `--check` 后直接 `--deploy`。
  管理员初始化与访问方式见 [Docker Compose 说明](README.md#docker-compose)。
- **managed-saas**：先 `--upload`，再 `--login`，进入服务器
  `/opt/model-router/deploy/compose`（随 `SERVER_DEPLOY_DIR` 调整）。按
  [SaaS 快速启动](compose/README.md#快速启动) 配置服务器端 `.env` 和 `modules/`，
  构建镜像，启动 PG/Redis、应用角色模板、显式迁移并重新应用授权模板；
  随后从本机执行 `--deploy`。SSH 配置不代替数据库密码、KMS 和上游凭据配置。

托管模式的迁移、角色授权和管理员初始化由上述操作步骤显式执行，脚本不会代办。
这允许首次部署前先检查环境，也避免普通更新自动更改数据库 schema。

## 验证范围

`--check` 是连接与依赖预检，不上传源码、不启动服务；缺少部署依赖会非零退出。
`--verify` 和部署后的自动验证要求必要服务的所有现有容器均为 `running/healthy`，
并在每个应用容器内检查 HTTP：self-hosted 为 `/healthz`，SaaS gateway 为 `/readyz`。
不健康、服务缺失、HTTP 非 200 或连接超时都非零退出；输出仅状态，不打印响应正文。

这些检查证明容器与应用就绪接口可用；公网域名/TLS、真实供应商请求、计费、R4/R9
性能验收仍需分别执行。`--verify` 不使用会创建/移除测试栈的 Compose `verify.sh`。

## 本次服务器的原生部署与 IP 验证

2026-10-23 按确认选择升级了服务器现有的自托管实例，使用 systemd + Node，
源码目录 `/opt/model-router`，新运行配置 `/var/lib/model-router/current/config.json`。
`model-router.service` 与 `nginx.service` 已启用；旧配置和数据库保留。
上述 `deploy-remote.sh --deploy/--verify` 是 **Compose** 操作，不适用于这个原生实例。
原生实例通过 SSH 使用 `systemctl status model-router nginx` 查看状态，
公网 IP 则使用下面的专用验证入口。

本次生成的 `deploy/remote-client.local.env` 保存 IP API 地址、原有客户端代理密钥、
证书路径；`deploy/remote-server-ip-ca.local.pem` 是从已验证 SSH 通道取得的公开 IP
证书。两者权限均为 `600`，均被 Git 和 npm 包排除。上游 Kimi 密钥没有导出到本机。

```sh
node scripts/verify-remote-ip.mjs          # 健康检查、无密钥 401、有密钥模型列表 200
node scripts/verify-remote-ip.mjs --smoke  # 再执行一个真实 Kimi 请求，最多输出 32 token
```

验证脚本只接受 HTTPS IP 地址，使用文件中的证书作为信任源，仍检查证书有效期与
IP SAN，不关闭 TLS 验证，不跟随重定向，不输出密钥或模型正文。
此次 IP 入口的两种协议和流式验证、性能样本见
[服务器部署与性能报告](../docs/validation/implementation-2026-10-23/server-self-hosted/README.md)。

## Redis 额度与异步日志

多实例 SaaS 使用 `MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL`，统一连接同一个 Redis 和 PostgreSQL。
升级前须停止所有网关，应用迁移 138 与更新后的角色授权，再统一启用 Redis；不能混用两种额度后端。
完整要求见 [部署说明](README.md#managed-saas-startup-contract)。

现有自托管入口也复用同一 Redis 状态组件：设置 `MODEL_ROUTER_QUOTA_REDIS_URL`，以及可选的
`MODEL_ROUTER_QUOTA_NAMESPACE`（默认 `model-router`）。该入口的 SQLite 写回适配器用于现有部署兼容，
独立服务器各自持有 SQLite 时不能共用一个额度 namespace；数据库身份不一致会拒绝启动。
真正多服务器部署采用上面的 SaaS PostgreSQL 适配器。

自托管首次启动会把旧 `logs.sqlite` 中的额度、已确认 usage、时区和 response ownership
迁移到 `control.sqlite`，事务标记完成后不再从日志恢复额度。升级前应停服并备份整个数据目录。
普通请求日志使用有界异步 worker，故障仅影响观测完整性；额度及资金状态不依赖这些日志。
Redis 使用独立数据目录、AOF 与 `noeviction`；故障或持久化队列积压时拒绝新准入，
不要在 Redis 不可用时把服务临时切回数据库额度后端。
