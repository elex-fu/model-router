#!/usr/bin/env bash
# Local (non-Docker) PostgreSQL E2E environment for the capability-parity
# worktree. Cluster: ~/.model-router-pg/pgdata-5434 (Homebrew postgresql@18,
# trust auth, 127.0.0.1:5434, data dir and log under ~/.model-router-pg).
# Database: model_router_test_parity_local (disposable; matches the local-mode
# gate contract: explicit non-default port + model_router_test_* name).
#
# Why a native cluster instead of a container: Docker Desktop keeps re-syncing
# the VM clock to ~100ms AHEAD of the macOS host, which breaks test fixtures
# that mix database-clock timestamps (evidence claim GREATEST(updated_at,
# clock_timestamp())) with process-clock timestamps (metering transitions) —
# migration 010's monotonic-timestamp trigger rejects them. A native cluster
# shares the host clock, so no skew.
#
# Bootstrap (already applied once):
#   psql -X -h 127.0.0.1 -p 5434 -U postgres -c "CREATE DATABASE model_router_test_parity_local;"
#   psql -X -h 127.0.0.1 -p 5434 -U postgres -d model_router_test_parity_local \
#     -v ON_ERROR_STOP=1 -f deploy/managed-saas-postgres-roles.sql
#   npx tsx -e 'import("./src/saas/db/index.js").then(...)'  # saas:migrate as migrator role
#   psql ... -f deploy/managed-saas-postgres-roles.sql   # second pass
#   psql ... -f deploy/managed-saas-validation-worker-role-grants.sql
#
# Start/stop the cluster:
#   /opt/homebrew/opt/postgresql@18/bin/pg_ctl -D ~/.model-router-pg/pgdata-5434 \
#     -o "-p 5434 -k /tmp" -l ~/.model-router-pg/pg-5434.log start|stop
#
# Usage: source scripts/pg-e2e-env-local.sh

export MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED=1
export MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL="postgresql://model_router_saas_migrator@127.0.0.1:5434/model_router_test_parity_local"
export MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL="postgresql://model_router_saas_control_plane@127.0.0.1:5434/model_router_test_parity_local"
export MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL="postgresql://model_router_saas_gateway@127.0.0.1:5434/model_router_test_parity_local"
export MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED=1
export MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL="postgresql://model_router_saas_migrator@127.0.0.1:5434/model_router_test_parity_local"
export MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL="postgresql://model_router_saas_validation_worker@127.0.0.1:5434/model_router_test_parity_local"
export MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL="postgresql://postgres@127.0.0.1:5434/model_router_test_parity_local"
