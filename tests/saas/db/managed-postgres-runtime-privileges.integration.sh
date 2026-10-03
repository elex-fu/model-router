#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

# Fixed service-DNS endpoint: this script cannot fall back to a developer's local database.
readonly postgres_host='postgres'
readonly postgres_port='5432'
readonly postgres_admin='postgres'
readonly database_name='model_router_saas_ci'
readonly migrator_url="postgresql://model_router_saas_migrator@${postgres_host}:${postgres_port}/${database_name}"
readonly runtime_url="postgresql://model_router_saas_control_plane@${postgres_host}:${postgres_port}/${database_name}"

echo 'Applying managed SaaS PostgreSQL role template as the temporary service administrator.'
psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --host="$postgres_host" \
  --port="$postgres_port" \
  --username="$postgres_admin" \
  --dbname="$database_name" \
  --file=deploy/managed-saas-postgres-roles.sql

echo 'Applying the complete registered SaaS migration sequence as the migrator role.'
# Keep the entire registered sequence enabled; any migration failure must keep this gate red.
# Do not skip or rewrite migrations here to hide schema defects.
MODEL_ROUTER_SAAS_DATABASE_URL="$migrator_url" \
  node --import tsx src/cli/index.ts saas:migrate

echo 'Reapplying the managed SaaS PostgreSQL role template after migrations.'
psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --host="$postgres_host" \
  --port="$postgres_port" \
  --username="$postgres_admin" \
  --dbname="$database_name" \
  --file=deploy/managed-saas-postgres-roles.sql

echo 'Applying the dedicated validation-worker manifest as the temporary service administrator.'
# Reconcile the fourth workload only after the complete current registry and
# ordinary application-role reconciliation. Never grant worker ledger access.
psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --host="$postgres_host" \
  --port="$postgres_port" \
  --username="$postgres_admin" \
  --dbname="$database_name" \
  --file=deploy/managed-saas-validation-worker-role-grants.sql

echo 'Running the production runtime privilege probe as the control-plane role.'
MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL="$runtime_url" \
  node --import tsx --test tests/saas/db/runtime-privileges.integration.test.ts
