#!/usr/bin/env bash
# Reset and re-bootstrap the LOCAL native PG E2E database (see
# scripts/pg-e2e-env-local.sh for the environment this belongs to).
# Drops and recreates model_router_test_parity_local, applies the managed
# roles, runs the full saas migration chain as the migrator role, then the
# second roles pass and the validation-worker grants.
set -euo pipefail
PSQL=(psql -X -h 127.0.0.1 -p 5434 -U postgres)
DB=model_router_test_parity_local
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);"
"${PSQL[@]}" -c "CREATE DATABASE ${DB};"
"${PSQL[@]}" -d "${DB}" -v ON_ERROR_STOP=1 -f "${ROOT}/deploy/managed-saas-postgres-roles.sql" >/dev/null
cd "${ROOT}"
MODEL_ROUTER_SAAS_DB_URL="postgresql://model_router_saas_migrator@127.0.0.1:5434/${DB}" \
  npx tsx scripts/pg-e2e-local-migrate.ts
"${PSQL[@]}" -d "${DB}" -v ON_ERROR_STOP=1 -f "${ROOT}/deploy/managed-saas-postgres-roles.sql" >/dev/null
"${PSQL[@]}" -d "${DB}" -v ON_ERROR_STOP=1 -f "${ROOT}/deploy/managed-saas-validation-worker-role-grants.sql" >/dev/null
echo "local E2E database reset complete"
