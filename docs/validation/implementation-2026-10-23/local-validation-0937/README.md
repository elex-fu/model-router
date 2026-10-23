# 本地验证记录 — 2026-10-23

执行对象为 `a1441872e718f17badf2a7947bb210fa44de4439`。本轮重新构建标准 CLI，并完成本地回归、一次性 PostgreSQL 18 备份恢复及标准 CLI 的 mock 串行诊断。功能检查通过；性能门槛未通过，且机器未形成受控测量窗口。此记录不构成发布验收。

| 检查 | 本次结果 | 证据 |
|---|---|---|
| 备份恢复、图片 keepalive、R9 harness 最小验证 | 41 通过，0 失败 | [日志](focused-local-network.log) |
| 当前源码 server 构建 | `tsc` exit 0 | [日志](build-server.log) |
| 完整 unit，文件并发 2 | 6870 项：6847 通过、23 跳过、0 失败；138.69 秒 | [日志](unit-concurrency-2.log) |
| integration，文件并发 2，精简环境 | 349 项：255 通过、94 跳过、0 失败；56.49 秒 | [日志](integration-concurrency-2.log) |
| 一次性 PostgreSQL 18.6 真实备份恢复 | 1/1；118 条迁移、147 张表；恢复指纹一致；损坏归档拒绝；自有目标清理 | [日志](postgres18-backup-restore-locale-c.log)、[范围](backup-evidence/scope.json) |
| 当前 dist 三个 CLI，OpenAI / Anthropic 原生 mock smoke | 两条均 HTTP 200、succeeded / settled | [原始 manifest](r4-serial-cap-off/summary.json) |
| R4 cap off 串行诊断 | latency direct/gateway、TTFB direct/gateway 各 100 样本；400 个 HTTP 200；流错误 0；请求 ID 关联完整 | [样本](r4-serial-cap-off/serial-profile-request-samples.json)、[状态](r4-serial-cap-off/serial-profile-request-states.json) |

串行诊断执行于北京时间 **09:48:37—09:49:19**。使用同一新构建、native prepared statements、PG fsync / synchronous_commit 开启、HTTP 入口 cap 关闭。仅执行 latency 和 TTFB；报告中其他场景的默认配置值不表示执行过 c200、SSE 或 scaling。

| 性能指标 | 实测开销 | 原门槛 | 判定 |
|---|---:|---:|---|
| latency p99 | 424.55 ms | 30 ms | 未通过 |
| TTFB p99 | 267.15 ms | 10 ms | 未通过 |

[性能原始报告](r4-serial-cap-off/serial-profile-current-3cli.json) 保留两项 violation 和退出码 1。观察窗口内机器 1 分钟负载为 8.30–11.85，仍有本轮之外的 Rust 编译；整个 R4 harness 期间采样负载为 7.77–9.23，平均 CPU busy 约 83.54%。这是带外部干扰的诊断数据，不能用于关闭性能门禁，也不能据此认定优化收益、代码回归或把全部耗时归因于 CPU。[主机采样](host-observations.jsonl)、[性能前置进程快照](processes-before-performance.txt) 已保留。

两次环境失败均保留原始记录：

- 首次最小测试被沙箱禁止监听回环地址（`listen EPERM`）；在允许本地监听的执行环境重跑后 41/41 通过。[首轮日志](focused.log)
- 首次备份恢复在 PostgreSQL 启动阶段报 `postmaster became multithreaded during startup`，日志要求设置有效 locale；补上 `LC_ALL=C LANG=C` 后，同一用例通过。没有更改数据库恢复实现或测试断言。[首轮日志](postgres18-backup-restore.log)

source / dist / tests / scripts 及选定构建输入前后内容散列一致；R4 自身也确认 source / dist / harness 未变化。自建 R4 子进程、PostgreSQL 和运行时目录均已清理；主机观察进程已停止。没有修改业务源码。

后续仍需在安静窗口完成 R4 有效测量和 off/8 c200/60s 对照，再做 R5 归因与 R6 完整 R9。本轮 PostgreSQL 恢复中的 S3/KMS 使用协议替身，不关闭生产云 KMS、异地存储或 PITR 验收；真实供应商 OAuth smoke 与 Codex 可售边界未执行。

完整计数、内容散列、执行范围和待办见 [summary.json](summary.json)。原始日志与 JSON 保留执行时路径，不改写历史记录。
