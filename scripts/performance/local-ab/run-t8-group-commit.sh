#!/bin/bash
# T8 group-commit acceptance: fast-channel c32 JSON, batch ON vs OFF, same window.
#
# Topology (all loopback):
#   PG 5434 model_router_bench, Redis 16399, TLS mock 18453 (+ plain sidecar 18454),
#   MR fast gateway 18088 (MODEL_ROUTER_FAST_GATEWAY=reserved-max).
# Prerequisites:
#   - npm run build
#   - seed: node scripts/performance/local-ab/seed-driver.cjs   (fast tier, default)
#   - TLS mock + sidecar already listening (see README.md)
#   - no other gateway on 18088
# Purge between profiles (quota state + redis + restart), same as T5 protocol.
#
# Acceptance (docs/performance/local-ab-sub2api-20261028.md T8):
#   c32 JSON batch-ON RPS >= 700 (fast-channel baseline 553.1), p50 not worse
#   than baseline 50.0ms + 5ms.
set -u
RUN="${LOCAL_AB_RUN_DIR:-/tmp/model-router-local-ab}"
cd "$(dirname "$0")/../../.."   # repo root

# Batch-ON env overlay (window 5ms, up to 32 rows/statement).
BATCH_ENV="$RUN/app.env.t8-batch"
cp "$RUN/app.env" "$BATCH_ENV"
cat >> "$BATCH_ENV" <<'EOF'
MODEL_ROUTER_FAST_RESERVE_BATCH_WINDOW_MS=5
MODEL_ROUTER_FAST_RESERVE_BATCH_MAX_ROWS=32
EOF

gw_start() {
  local env_file=$1
  set -a; . "$env_file"; set +a
  nohup node dist/cli/index.js start --role gateway >> "$RUN/gateway.log" 2>&1 &
  echo $! > "$RUN/gateway.pid"
  for _ in $(seq 1 240); do
    curl -sf http://127.0.0.1:18088/readyz >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "gateway failed to become ready" >&2
  return 1
}

purge() {
  local env_file=$1
  local oldpid
  oldpid=$(cat "$RUN/gateway.pid" 2>/dev/null || echo "")
  if [ -n "$oldpid" ]; then
    kill "$oldpid" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$oldpid" 2>/dev/null || break
      sleep 1
    done
  fi
  psql -h 127.0.0.1 -p 5434 -U postgres -d model_router_bench -qc \
    "DELETE FROM model_router_saas.saas_redis_quota_state;"
  redis-cli -p 16399 --scan --pattern 'mr:quota*' | xargs -r redis-cli -p 16399 del >/dev/null
  redis-cli -p 16399 --scan --pattern 'mr:fast:*' | xargs -r redis-cli -p 16399 del >/dev/null
  gw_start "$env_file"
}

mkdir -p "$RUN/results"
OUT="$RUN/results/t8-group-commit.jsonl"
: > "$OUT"

run_profile() {
  local name=$1
  LOCAL_AB_MOCK_METRICS_PORT=18454 bash scripts/performance/local-ab/run-profile.sh "$name" \
    http://127.0.0.1:18088/v1/chat/completions "$RUN/api-key" \
    native-fast-ci-model "$(cat "$RUN/gateway.pid")" "$RUN/bench-mr.log" \
    -proto openai -n 3500 -c 32 | tee -a "$OUT"
}

purge "$RUN/app.env" || exit 1
run_profile mr-t8-nobatch-c32-json
purge "$BATCH_ENV" || exit 1
run_profile mr-t8-batch-c32-json
echo "T8 GROUP-COMMIT RUNS COMPLETE"
