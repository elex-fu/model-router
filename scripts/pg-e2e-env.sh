#!/usr/bin/env bash
# Disposable PostgreSQL E2E environment for the capability-parity worktree.
# Container: mr-parity-pg (postgres:16-alpine, trust auth, 127.0.0.1:5433)
# Database: model_router_test_parity (disposable; matches the local-mode
# gate contract: explicit non-default port + model_router_test_* name).
#
# Bootstrap already applied: managed-saas-postgres-roles.sql (twice, around
# the full saas:migrate sequence) + managed-saas-validation-worker-role-grants.sql.
#
# Re-bootstrap after schema changes:
#   docker exec -i mr-parity-pg psql -U postgres -d model_router_test_parity \
#     --set=ON_ERROR_STOP=1 < deploy/managed-saas-postgres-roles.sql
#   docker restart mr-parity-pg && sleep 5   # or: docker exec ... dropdb/createdb for a clean slate
#
# Usage: source scripts/pg-e2e-env.sh

export MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED=1
export MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL="postgresql://model_router_saas_migrator@127.0.0.1:5433/model_router_test_parity"
export MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL="postgresql://model_router_saas_control_plane@127.0.0.1:5433/model_router_test_parity"
export MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL="postgresql://model_router_saas_gateway@127.0.0.1:5433/model_router_test_parity"
export MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED=1
export MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL="postgresql://model_router_saas_migrator@127.0.0.1:5433/model_router_test_parity"
export MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL="postgresql://model_router_saas_validation_worker@127.0.0.1:5433/model_router_test_parity"
export MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL="postgresql://postgres@127.0.0.1:5433/model_router_test_parity"
