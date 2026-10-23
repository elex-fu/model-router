# 服务器自托管部署与真实 Kimi 性能记录

2026-10-23 完成当前代码上传、原生 systemd 部署和公网 **IP** 调用验证。
本次按用户确认升级现有自托管服务，沿用服务器上的 Kimi Code 上游及客户端代理密钥。
这不是 managed-saas 三角色部署，也不关闭 R4/R5/R6、云恢复或 Codex 可售门禁。

## 部署与资源

- 候选：`ab293e01ddc56d6eb5caf6c0130f925a04bd18c0` 加本地部署工具修改；本次重新执行完整 `npm run build`。
- 本机构建后上传源码、`dist`、`web/dist`；服务器核对 **4,969 个文件**的 SHA-256。
  归档 SHA-256：`3975fee2b79ef4785aee4dc08ab2e1a1d2b3ad44584607da1f736077fb6fd8d6`。
- 服务器：1 CPU、1817 MiB 内存、Node 22.22.0；生产依赖按锁文件安装，Linux SQLite 原生模块实际加载成功。
- 应用：`/opt/model-router`；新配置及运行数据：`/var/lib/model-router/current`。
  旧 V1 配置预览通过后在新目录迁移为 V2；原配置、旧数据库与操作备份保留。
- `model-router.service`、`nginx.service` 均 `active/running/enabled`，截至最终快照重启次数为 0。
  API 与管理端分别仅监听回环 `15005`、`15006`，Nginx 提供 IP HTTPS 入口。
  本轮未创建管理员账号，管理端初始化仍通过本机/SSH 隧道执行。
- 按确认停止旧应用并保留数据；清理约 3.0 GiB 无进程使用的 pip 缓存及 3.7 GiB 超过 14 天的归档 journal。
  根盘 `df -h` 可用量从 `4.6G` 增至 `12G`；最终精确快照可用约 11.30 GiB、可用内存 1311 MiB。
  Nginx 随新 API 部署恢复，SSH 始终保持。

详见 [部署快照](deployment.json)。原始配置、数据库、备份包、服务器 IP 和账号密钥不进入证据目录。

## IP 直连验证

外部客户端通过配置中的 IP 访问 HTTPS，使用经已验证 SSH 通道取得的原有自签名证书作为信任源。
证书 IP SAN 匹配且在有效期内；没有关闭 TLS 验证，没有跟随重定向。

| 检查 | 结果 |
| --- | --- |
| `GET /healthz` | 200 |
| 无密钥 `GET /v1/models` | 401 |
| 有密钥 `GET /v1/models` | 200，发布 `kimi-k2.5`、`kimi-k2.6` |
| OpenAI `POST /v1/chat/completions` | 200，真实文本输出，约 1409 ms |
| Anthropic `POST /v1/messages` | 200，真实文本输出，约 1357 ms |
| Anthropic SSE | 200，首文本约 1331 ms，总耗时约 1347 ms，收到终止事件 |

实际生成验证使用 `kimi-k2.6`、短固定提示、`max_tokens=32`、关闭 thinking。
模型列表中的 `kimi-k2.5` 本轮没有单独生成测试。
详见 [公网 IP 结果](public-ip-smoke.json) 与 [服务器本地最小请求](real-smoke.json)。

后续按用户要求停止域名排查，本报告的入口验收只针对 IP。

## 性能采样

北京时间 **12:08:24—12:08:57**，同一服务器发起请求，对真实 Kimi SSE 进行 2 次预热和
40 次正式采样。模型、提示、输出上限一致；按直连、路由并发 1、2、5 的顺序执行。
正式样本 **40/40 成功**，预热也全部成功，没有流错误。

| 路径 | 并发 | 样本 | 首字节 p50 / p95 | 完成 p50 / p95 | 请求/秒 | 路由进程 CPU | 最大 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 直连上游 | 1 | 10 | 618 / 803 ms | 642 / 819 ms | 1.50 | — | — |
| 路由 | 1 | 10 | 1354 / 1375 ms | 1376 / 1397 ms | 0.73 | 0.73% | 134 MiB |
| 路由 | 2 | 10 | 1353 / 1437 ms | 1374 / 1478 ms | 1.47 | 1.03% | 136 MiB |
| 路由 | 5 | 10 | 1350 / 1524 ms | 1372 / 1544 ms | 3.50 | 2.10% | 137 MiB |

CPU 是每批请求期间路由主进程的 CPU 时间占墙钟比例；客户端与路由共享一台机器。
测试开始/结束的 1 分钟负载为 0.45/0.27，构建进程已结束。
样本为短输出、低并发基线；每组仅 10 次，p95 接近该组最大值，不能据此声明持续容量上限或生产 SLO。
直连和路由按顺序采样，受真实供应商与网络波动影响，延迟差不能全部直接视为纯路由 CPU 开销。

完整样本与分组统计见 [real-performance.json](real-performance.json)。

## 已定位的延迟来源

串行路由的完成 p50 比直连高约 **734 ms**，CPU 占用很低。代码中请求进入、准入完成、
尝试开始三个阶段分别 `await` 遥测写入；`TelemetryWriteClient` 不满 100 条时等待固定 250 ms
才发送批次，调用方在提交确认后继续。

使用服务器同一构建的日志组件和独立临时 SQLite 文件复现三个等待写入：
**253.10 + 251.55 + 251.44 = 756.35 ms**。三个批次的排队分别约 250 ms，worker 提交确认约 1 ms。
正式数据库的 37 个完成请求，从请求开始到记录尝试开始平均约 478 ms，与前两个等待阶段一致；
尝试记录后还会等待第三次写入，然后才调用上游。

因此固定批次等待是本次自托管路径的明确优化点。本轮只做部署、测量与定位，没有更改日志持久化或故障拒绝语义。
证据见 [隔离日志组件测量](telemetry-latency-probe.json) 与 [该次 stderr 批次事件](telemetry-write-events.jsonl)；来源为
`src/storage/telemetry-write-client.ts` 的 `write()`、`src/server/proxy.ts` 的三个派发前写入点。

截至遥测快照，**37 个生成请求全部 completed/200、37 次尝试全部 completed/200、37 个预留全部 settled**；
另有一次预期的无密钥 401。直连上游的请求不进入路由数据库。见 [遥测汇总](telemetry-summary.json)。

## 本地复验入口

以下文件仅在本机保存、权限 `600`，已被 Git、npm 包和源码上传排除：

- `deploy/remote-server.local.env`：SSH 连接信息，已选择 self-hosted。
- `deploy/remote-client.local.env`：IP API 地址、原有客户端代理密钥、证书路径。
- `deploy/remote-server-ip-ca.local.pem`：公开 IP 证书。上游 Kimi 密钥未导出。

```sh
node scripts/verify-remote-ip.mjs
node scripts/verify-remote-ip.mjs --smoke
```

第一条只检查健康与鉴权；第二条增加一次短输出真实 Kimi 调用。只输出状态和耗时。
本次原生实例的运维方式与通用 Compose 脚本不同，见 [远程操作说明](../../../../deploy/REMOTE.md)。
