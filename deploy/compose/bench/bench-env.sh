#!/bin/sh
# bench-env.sh — R9 bench driver environment (gitignored; sources the proxy
# key from the seed output file at runtime, never stores it literally).
# Usage: . /Users/lex/play/model-router/deploy/compose/bench/bench-env.sh
COMPOSE_DIR="/Users/lex/play/model-router/deploy/compose"
export MOCK_CONTROL_URL="http://127.0.0.1:18080"
export MOCK_UPSTREAM_URL="https://127.0.0.1:18443"
export NODE_EXTRA_CA_CERTS="${COMPOSE_DIR}/bench/certs/mock-cert.pem"
export BENCH_PROXY_KEY="$(cat "${COMPOSE_DIR}/modules/bench-proxy-key")"
export BENCH_ACCOUNTS="bench-account-1,bench-account-2,bench-account-3,bench-account-4"
export BENCH_FAULT_ACCOUNTS="${BENCH_ACCOUNTS}"
# One gateway instance; the 3-instance run overrides GATEWAY_URLS inline.
export GATEWAY_URLS="http://127.0.0.1:15007"
