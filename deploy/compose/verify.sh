#!/bin/sh
# deploy/compose/verify.sh — validation for the Phase 4 compose stack.
#
# 1. Static: docker compose config -q against docker-compose.yml, using .env
#    when present and a scratch copy of .env.example otherwise (this also
#    proves .env.example defines every required variable).
# 2. Runtime (only when the docker daemon is reachable): bring up the minimal
#    stack (postgres + redis + a single gateway replica), wait for compose
#    healthchecks, and report. Managed SaaS roles expose no /healthz route
#    (only the local-mode proxy has one), so "healthz probing" here means the
#    compose TCP healthchecks plus the postgres/redis native probes.
#
# A gateway that exits non-zero during this check is the intended fail-closed
# behavior when trusted operator modules or migrations are absent; the script
# surfaces its logs and exits 2 so the state is never masked.
#
# Exit codes: 0 = all requested checks passed (or were skipped with a notice),
#             1 = static validation failed, 2 = runtime check failed.
set -eu

cd "$(dirname "$0")"

scratch_env=""

cleanup() {
  if [ -n "$scratch_env" ] && [ -f "$scratch_env" ]; then
    rm -f "$scratch_env"
  fi
}
trap cleanup EXIT INT TERM

compose() {
  if [ -n "$scratch_env" ]; then
    docker compose --env-file "$scratch_env" "$@"
  else
    docker compose "$@"
  fi
}

echo '== deploy/compose verify: static config validation =='

if ! command -v docker >/dev/null 2>&1; then
  echo 'SKIP: docker CLI not found on this host; run this script on a machine with docker.'
  exit 0
fi

if [ -f .env ]; then
  echo 'Using existing .env for interpolation.'
else
  echo 'No .env found; validating against a scratch copy of .env.example.'
  scratch_env=".verify.env.$$"
  cp .env.example "$scratch_env"
fi

if ! compose -f docker-compose.yml config -q; then
  echo 'FAIL: docker compose config reported errors.' >&2
  exit 1
fi
echo 'PASS: docker compose config -q is clean.'

echo
echo '== deploy/compose verify: runtime (minimal stack) =='

if ! docker info >/dev/null 2>&1; then
  echo 'SKIP: docker daemon unreachable; static validation above remains authoritative.'
  exit 0
fi

if [ -n "$scratch_env" ]; then
  echo 'SKIP: runtime check requires a real deploy/compose/.env (trusted modules, KMS key material).'
  echo '      Static validation passed; see README.md for the full bring-up sequence.'
  exit 0
fi

set +e
compose -f docker-compose.yml up -d --wait postgres redis
pg_redis_status=$?
if [ "$pg_redis_status" -ne 0 ]; then
  echo 'FAIL: postgres/redis did not reach healthy state.' >&2
  compose -f docker-compose.yml logs --tail 40 postgres redis
  exit 2
fi
echo 'PASS: postgres (pg_isready) and redis (PING) healthy.'

compose -f docker-compose.yml up -d --wait --scale gateway=1 gateway
gateway_status=$?
if [ "$gateway_status" -ne 0 ]; then
  echo 'FAIL (or expected fail-closed): the single gateway replica did not become healthy.' >&2
  echo 'If trusted operator modules, saas:migrate and the grant templates are not in place,'
  echo 'a non-zero exit here is the documented fail-closed startup contract.' >&2
  compose -f docker-compose.yml logs --tail 60 gateway
  if [ "${KEEP:-0}" != "1" ]; then
    compose -f docker-compose.yml down
  fi
  exit 2
fi
echo 'PASS: single gateway replica healthy (TCP healthcheck on the /v1 listener).'

if [ "${KEEP:-0}" != "1" ]; then
  compose -f docker-compose.yml down
  echo 'Minimal stack torn down (KEEP=1 to leave it running).'
else
  echo 'Minimal stack left running (KEEP=1).'
fi
exit 0
