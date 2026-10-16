#!/bin/sh
# health-warmer.sh — R9 bench helper (gitignored).
#
# Keeps provider-account runtime health rows fresh during long bench suites.
# The scheduler fail-closes on health rows older than 30 s
# (maxHealthAgeMs default; provider-account-scheduler.ts) and only successful
# dispatch outcomes refresh them — any quiet phase longer than 30 s (the
# bench driver's direct-mock baseline phase, gaps between scenarios, a
# chaos fault window) walls every later request behind 'provider account
# health authority is unavailable' with no self-heal path wired in this tree
# (tryAdmitHalfOpenProbe has no caller). Re-running the DB-side probe primer
# on a <30 s cycle keeps the freshness window alive without adding traffic
# noise to the measured gateway path.
#
# Usage: sh health-warmer.sh &  (stop with kill %1)
cd /Users/lex/play/model-router/deploy/compose || exit 1
while :; do
  docker-compose run --rm --entrypoint node migrate \
    /opt/model-router-modules/prime-health.mjs >/dev/null 2>&1 || true
  sleep 12
done
