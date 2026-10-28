#!/bin/bash
# T5 strict /v1/messages baseline: paired MR-strict vs s2a profiles.
#
# Topology (all loopback):
#   PG 5434 model_router_bench, Redis 16399, TLS mock 18453 (+ plain sidecar 18454),
#   MR strict gateway 18088 (no MODEL_ROUTER_FAST_GATEWAY), s2a 28080.
# Prerequisites:
#   - seed: LOCAL_AB_FAST=off LOCAL_AB_ANTHROPIC=1 node scripts/performance/local-ab/seed-driver.cjs
#   - s2a anthropic account base_url=https://127.0.0.1:18453 (same-source TLS, report P2-8)
#   - s2a channel model_mapping anthropic native-fast-ci-model-anthropic -> r9-provider-model-anthropic
# Strict capacity note: the gateway workload role never reconciles unknown outcomes, so
# every profile is preceded by a purge (DELETE saas_redis_quota_state + Redis mr:quota*
# flush + gateway restart). Skipping the purge poisons the next run with retained capacity.
set -u
RUN="${LOCAL_AB_RUN_DIR:-/tmp/model-router-local-ab}"
cd "$(dirname "$0")/../../.."   # repo root

gw_start() {
  set -a; . "$RUN/app.env"; set +a
  nohup node dist/cli/index.js start --role gateway >> "$RUN/gateway.log" 2>&1 &
  echo $! > "$RUN/gateway.pid"
  for _ in $(seq 1 90); do
    curl -sf http://127.0.0.1:18088/readyz >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "gateway failed to become ready" >&2
  return 1
}

purge() {
  local oldpid
  oldpid=$(cat "$RUN/gateway.pid")
  kill "$oldpid" 2>/dev/null
  for _ in $(seq 1 30); do
    kill -0 "$oldpid" 2>/dev/null || break
    sleep 1
  done
  psql -h 127.0.0.1 -p 5434 -U postgres -d model_router_bench -qc \
    "DELETE FROM model_router_saas.saas_redis_quota_state;"
  redis-cli -p 16399 --scan --pattern 'mr:quota*' | xargs -r redis-cli -p 16399 del >/dev/null
  gw_start
}

S2APID=$(cat /tmp/s2a-bench/server.pid)
OUT="$RUN/results/t5-strict-baseline.jsonl"
: > "$OUT"

run_pair() {
  local name=$1; shift
  purge || exit 1
  LOCAL_AB_MOCK_METRICS_PORT=18454 bash scripts/performance/local-ab/run-profile.sh "mr-$name" \
    http://127.0.0.1:18088/v1/messages "$RUN/api-key" \
    native-fast-ci-model-anthropic "$(cat "$RUN/gateway.pid")" "$RUN/bench-mr.log" \
    -proto anthropic "$@" | tee -a "$OUT"
  LOCAL_AB_MOCK_METRICS_PORT=18454 bash scripts/performance/local-ab/run-profile.sh "s2a-$name" \
    http://127.0.0.1:28080/v1/messages /tmp/s2a-bench/s2a-key.txt \
    native-fast-ci-model-anthropic "$S2APID" /tmp/s2a-bench/bench-s2a.log \
    -proto anthropic "$@" | tee -a "$OUT"
}

run_pair c32-msg-json -n 3500 -c 32
run_pair c32-msg-sse  -n 3500 -c 32 -stream
run_pair c64-msg-json -n 6000 -c 64
run_pair c64-msg-sse  -n 6000 -c 64 -stream
echo "T5 PAIRED RUNS COMPLETE"
