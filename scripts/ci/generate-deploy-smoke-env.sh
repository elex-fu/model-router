#!/usr/bin/env bash
# scripts/ci/generate-deploy-smoke-env.sh — runtime-only CI environment file for
# the deploy-smoke gate (docs/deployment-ops-efficiency-plan-2026-10-17.md §6).
#
# Generates the saas:deploy/saas:doctor environment against a disposable
# PostgreSQL instance. Every credential (the four per-role login passwords and
# the pilot software-KMS master key) is generated at runtime with node:crypto
# and written only to the output file — never to stdout, never committed
# (repo secret rule: no key material as source literals anywhere).
#
# The trusted-module declarations follow src/saas/deployment.ts (the
# authoritative env contract). saas:deploy checks the readiness declarations
# are present but does not load them; saas:doctor really loads the seal /
# rewrap / gateway-decrypt / worker-decrypt KMS modules, so those four point
# at the in-repo pilot software KMS sources (the same specifiers the runtime
# tests use; the CLI runs under tsx, so .ts specifiers resolve).
#
# usage: generate-deploy-smoke-env.sh <output-file> <pg-host> <pg-port> <pg-database> <redis-url>
# example: generate-deploy-smoke-env.sh "$RUNNER_TEMP/deploy-smoke.env" postgres 5432 model_router_saas_ci redis://redis:6379
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <output-file> <pg-host> <pg-port> <pg-database> <redis-url>" >&2
  exit 2
fi

output_file=$1
pg_host=$2
pg_port=$3
pg_database=$4
redis_url=$5

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to generate random credentials" >&2
  exit 1
fi
if [ -e "$output_file" ]; then
  echo "error: refusing to overwrite existing file: $output_file" >&2
  exit 1
fi

# URL-safe random secrets: 32 hex chars per login password, 64 hex chars
# (32 bytes, AES-256) for the software-KMS master key.
random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes($1).toString('hex'))"
}
migrator_password=$(random_hex 32)
control_plane_password=$(random_hex 32)
gateway_password=$(random_hex 32)
validation_worker_password=$(random_hex 32)
kms_master_key=$(random_hex 32)

# The CI PostgreSQL service (trust auth, disposable) is an explicit-plaintext
# endpoint: sslmode=disable requires saas:deploy --allow-local-plaintext and a
# loopback host or the designated postgres:5432 CI service (same rule as the
# drill/track-F gates in src/cli/saas-deploy.ts).
pg_url() {
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=disable' "$1" "$2" "$pg_host" "$pg_port" "$pg_database"
}

# umask so the generated file is only readable by the invoking user.
( umask 077
  cat >"$output_file" <<EOF
# Generated at runtime by scripts/ci/generate-deploy-smoke-env.sh — never commit.
# saas:deploy contract (src/cli/saas-deploy.ts): administrator URL (must not be
# a SaaS application login) + migrator URL + the three per-role runtime URLs.
MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=$(pg_url postgres '')
MODEL_ROUTER_SAAS_DATABASE_URL=$(pg_url model_router_saas_migrator "$migrator_password")
MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=$(pg_url model_router_saas_control_plane "$control_plane_password")
MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=$(pg_url model_router_saas_gateway "$gateway_password")
MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=$(pg_url model_router_saas_validation_worker "$validation_worker_password")

# Redis (control-plane cache/coordination; nothing authoritative). The
# disposable CI redis answers PING for the doctor's RESP contract probe.
MODEL_ROUTER_SAAS_REDIS_URL=$redis_url
MODEL_ROUTER_SAAS_REDIS_PROVIDER=./src/saas/runtime/redis-rate-limit-provider.ts

# saas:deploy readiness declarations for trusted modules it never loads
# (module identity only; operator-supplied modules live outside this repo —
# see deploy/compose/.env.example). Placeholder identity paths keep the
# declaration gate honest without inventing an in-repo TOTP/gateway runtime.
MODEL_ROUTER_SAAS_KMS_PROVIDER=/opt/model-router-modules/platform-totp-provider.mjs
MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE=/opt/model-router-modules/gateway-runtime.mjs

# Pilot software KMS wiring. saas:doctor loads these modules for real
# (checkReady), so they point at the in-repo sources; the rewrap entry must
# stay the dedicated ReEncrypt-only .mjs (distinct from the seal/decrypt
# specifiers). The master key above is runtime-generated and disposable.
SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE=./src/saas/runtime/software-provider-credential-kms.ts
SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE=./src/saas/runtime/software-provider-credential-rewrapping-kms.mjs
SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE=./src/saas/runtime/software-provider-credential-kms.ts
SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE=./src/saas/runtime/software-provider-credential-kms.ts
MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY=$kms_master_key
MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID=ci-deploy-smoke
# The rewrap loader fail-closes without an explicit destination key id, and it
# must equal the software KMS key id while the pilot module is in use
# (deploy/compose/.env.example keeps the same pairing).
MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID=ci-deploy-smoke
# Contract C-2.2: the pilot-only software KMS refuses production readiness
# without the explicit operator acceptance of the downgrade.
MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT=true

# Production posture for the smoke (saas:doctor/saas:deploy are agnostic; the
# software KMS checkReady pilot gate keys off NODE_ENV=production).
NODE_ENV=production
EOF
)

# Only the path and the variable names are reported — never any value.
echo "generated $output_file"
echo "variables: MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL MODEL_ROUTER_SAAS_DATABASE_URL MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL MODEL_ROUTER_SAAS_REDIS_URL MODEL_ROUTER_SAAS_REDIS_PROVIDER MODEL_ROUTER_SAAS_KMS_PROVIDER MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT NODE_ENV"
