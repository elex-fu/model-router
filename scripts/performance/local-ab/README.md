# local-ab — 本地 A/B 基准工具（model-router fast/strict vs sub2api）

`docs/performance/local-ab-sub2api-20261028.md` 的基准工具固化。无密钥入库：
KMS master key、ed25519 签名对、TLS 材料全部在运行时生成进 run 目录
（默认 `/tmp/model-router-local-ab`，0700/0600 权限），`api-key`/`app.env`
等凭据文件永远不进仓库。

## 组成

| 文件 | 作用 |
|------|------|
| `client.go` | 压测客户端（JSON+SSE，`-proto openai\|anthropic` 响应校验） |
| `mock.go` | 同源双协议 mock：`/v1/chat/completions` + `/v1/messages`（JSON+SSE），固定 5ms 延迟，仅回环；`-cert/-key` 可选 TLS（TLS 计数器常开）。TLS 模式下 **mock 端口 +1** 额外暴露纯 HTTP `/metrics`+`/healthz` sidecar（推理端点仍仅 TLS），压测脚本用 `LOCAL_AB_MOCK_METRICS_PORT` 抓取计数差 |
| `seed-driver.cjs` | 种子驱动：disposable tenant/key/pool + bounded deployment 注册；写 `app.env`/`api-key`/`runtime.json` 到 run 目录 |
| `gen-certs.sh` | 一次性本地 CA + 127.0.0.1 服务证书（TLS 轮使用） |
| `run-profile.sh` | 单轮压测：server CPU（ps）前后差 + mock `/metrics` 差 + 延迟分布，输出一行 JSON |

## 前置

1. `npm run build`（gateway 跑 `dist/`）。
2. 编译测试夹具：`node scripts/performance/fixed-cpu/compile-fixtures.cjs`（生成 gitignored 的 `seed.cjs`/`runtime.cjs`）。
3. 本地 PG（默认端口 5434，库 `model_router_bench`）与 Redis（默认 16399）已启动。
4. Go 工具链（构建 client/mock）、openssl（TLS 轮）、python3（run-profile 汇总）。

## 典型流程（fast 轮）

```bash
RUN=/tmp/model-router-local-ab
node scripts/performance/local-ab/seed-driver.cjs          # 写 app.env / api-key / runtime.json
go build -o $RUN/bench-client scripts/performance/local-ab/client.go
go build -o $RUN/local-ab-mock scripts/performance/local-ab/mock.go

# TLS mock（fast 上游必须 https，见 provider-http-transport 端点策略）
bash scripts/performance/local-ab/gen-certs.sh
$RUN/local-ab-mock -addr 127.0.0.1:18453 -cert $RUN/tls-cert.pem -key $RUN/tls-key.pem >$RUN/mock.log 2>&1 &

set -a; . $RUN/app.env; set +a
node dist/server/managed-saas-gateway.js >$RUN/gateway.log 2>&1 &   # 实际启动命令以 app.env 为准
GW_PID=$!

# 预热 + 压测（TLS mock 模式下 metrics 在 mock 端口 +1 的 sidecar）
curl -s http://127.0.0.1:18088/readyz
LOCAL_AB_MOCK_METRICS_PORT=18454 bash scripts/performance/local-ab/run-profile.sh c32-json \
  http://127.0.0.1:18088/v1/chat/completions $RUN/api-key \
  native-fast-ci-model $GW_PID $RUN/bench-mr.log -n 20000 -c 32
```

结果 JSON 行（rps/cpu_ms_per_req/latency/ttfb/status_counts/execution_modes/
fallback_reasons/mock_*_delta）追加进 `docs/performance/` 下对应 CSV/报告。

## strict /v1/messages 基线（T5）

```bash
LOCAL_AB_FAST=off LOCAL_AB_ANTHROPIC=1 node scripts/performance/local-ab/seed-driver.cjs
# 重启 gateway（不带 MODEL_ROUTER_FAST_GATEWAY），mock 同上（anthropic 路由已由种子写入 runtime.json）
bash scripts/performance/local-ab/run-profile.sh c32-msg-json \
  http://127.0.0.1:18088/v1/messages $RUN/api-key \
  native-fast-ci-model-anthropic $GW_PID $RUN/bench-mr.log \
  -proto anthropic -n 20000 -c 32
```

## TLS 归因（T6，2026-10-28 已完成）

MR fast/strict 上游强制 HTTPS（`provider-http-transport.ts:753` 端点策略），plain-HTTP 变体不可行；
按报告 P2-8 备选方案做**同口径 TLS 对 s2a**：s2a anthropic 账号 `base_url=https://127.0.0.1:18453`
（与 MR strict 同源同证书），配对基线见 `docs/performance/strict-messages-baseline-20261028.csv`。
TLS 贡献用 `mock_tls_full_delta`/`mock_tls_resumed_delta` 量化：MR strict 每请求一次完整握手
（full delta == 成功数、0 resumed），s2a 连接复用（c32 仅 32 次 full 服务 3500 请求）；
同证书完整握手实测 ≈1.26ms/次（loopback in-process），占 MR strict p50 935ms 的 0.13%——
TLS 排除为吞吐差距贡献项。详见报告 P2-8 与归因排序。

## CI（可选 nightly 快速档）

c8 快速档：`-n 2000 -c 8`，跑通即可防回归；全量 c32/c64 保留本地执行。
