#!/bin/bash
# Run one bench profile and emit a JSON line with CPU/latency/mock deltas.
# usage: run-profile.sh <name> <url> <keyfile> <model> <server-pid> <logfile> [extra bench flags...]
#
# Environment overrides:
#   LOCAL_AB_RUN_DIR   run directory holding built binaries + results (default /tmp/model-router-local-ab)
#   LOCAL_AB_MOCK_PORT        mock /metrics port, plain mode (default 18453)
#   LOCAL_AB_MOCK_METRICS_PORT  metrics port in TLS mode (mock serves plain
#                             /metrics+healthz on mock port + 1; default = LOCAL_AB_MOCK_PORT)
set -u
NAME=$1; URL=$2; KEYFILE=$3; MODEL=$4; SRVPID=$5; LOG=$6; shift 6

RUN_DIR="${LOCAL_AB_RUN_DIR:-/tmp/model-router-local-ab}"
MOCK_PORT="${LOCAL_AB_MOCK_METRICS_PORT:-${LOCAL_AB_MOCK_PORT:-18453}}"
CLIENT_BIN="$RUN_DIR/bench-client"
[ -x "$CLIENT_BIN" ] || CLIENT_BIN="$(dirname "$0")/bench-client"
OUT="$RUN_DIR/results"
mkdir -p "$OUT"

read_cpu() { ps -p "$SRVPID" -o time=,rss= 2>/dev/null | awk '{print $1, $2}'; }

T0=$(read_cpu); T0RSS=$(echo $T0 | awk '{print $2}'); T0CPU=$(echo $T0 | awk '{print $1}')
MOCK0=$(curl -s "http://127.0.0.1:${MOCK_PORT}/metrics" 2>/dev/null || echo '{}')
"$CLIENT_BIN" -url "$URL" -key-file "$KEYFILE" -model "$MODEL" "$@" -out "$OUT/$NAME.json" >> "$LOG" 2>"$OUT/$NAME.time"
T1=$(read_cpu); T1CPU=$(echo $T1 | awk '{print $1}'); T1RSS=$(echo $T1 | awk '{print $2}')
MOCK1=$(curl -s "http://127.0.0.1:${MOCK_PORT}/metrics" 2>/dev/null || echo '{}')
python3 - "$OUT/$NAME.json" "$SRVPID" "$T0CPU" "$T1CPU" "$T0RSS" "$T1RSS" "$NAME" "$MOCK0" "$MOCK1" <<'PY'
import json, sys
res_path, pid, t0, t1, rss0, rss1, name, m0, m1 = sys.argv[1:10]
r = json.load(open(res_path))
def cpu_ms(t):
    parts = [float(p) for p in t.split(':')]
    sec = 0
    for p in parts: sec = sec*60 + p
    return sec*1000
c0, c1 = cpu_ms(t0), cpu_ms(t1)
cpu_delta = c1 - c0
n = r.get('success', 0)
rps = r.get('throughput_success_rps', 0)
ms_per_req = (cpu_delta / n) if n else 0
out = {
  'name': name, 'rps': rps, 'success': n, 'failure': r.get('failure', 0),
  'cpu_delta_ms': cpu_delta, 'cpu_ms_per_req': round(ms_per_req, 3),
  'rss_start_mb': round(int(rss0)/1024, 1), 'rss_end_mb': round(int(rss1)/1024, 1),
}
out['latency'] = {k: round(v,2) for k,v in r.get('latency_ms', {}).items()}
out['ttfb'] = {k: round(v,2) for k,v in r.get('body_ttfb_ms', {}).items()}
out['duration_s'] = round(r.get('duration_s', 0), 2)
out['status_counts'] = r.get('status_counts', {})
out['execution_modes'] = r.get('execution_modes', {})
out['fallback_reasons'] = r.get('fallback_reasons', {})
# mock deltas
try:
    a = json.loads(m0); b = json.loads(m1)
    out['mock_received_delta'] = b.get('received',0) - a.get('received',0)
    out['mock_completed_delta'] = b.get('completed',0) - a.get('completed',0)
    out['mock_tls_full_delta'] = b.get('inference_tls_full',0) - a.get('inference_tls_full',0)
    out['mock_tls_resumed_delta'] = b.get('inference_tls_resumed',0) - a.get('inference_tls_resumed',0)
except Exception: pass
print(json.dumps(out))
PY
