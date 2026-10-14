#!/bin/sh
# Applies role passwords from container environment variables during the
# postgres image's first-boot initdb phase (runs after 00-init.sql, which
# creates the roles themselves). Mirrors the repo convention that SQL
# templates never embed credentials: deploy/managed-saas-postgres-roles.sql
# leaves passwords to "the deployment secret manager", which for the compose
# stack is the .env file consumed by docker compose.
set -eu

require_password() {
  # shellcheck disable=SC2016  # eval intentionally reads the named variable
  eval "value=\${$1-}"
  if [ -z "$value" ]; then
    echo "10-role-passwords.sh: $1 must be set (see deploy/compose/.env.example)" >&2
    exit 1
  fi
}

require_password POSTGRES_MIGRATOR_PASSWORD
require_password POSTGRES_CONTROL_PLANE_PASSWORD
require_password POSTGRES_GATEWAY_PASSWORD
require_password POSTGRES_VALIDATION_WORKER_PASSWORD

# psql -v defines client-side variables; :'var' quotes them safely as SQL
# literals, so password bytes can never break out of the statement.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$POSTGRES_MIGRATOR_PASSWORD" \
  -v control_plane_password="$POSTGRES_CONTROL_PLANE_PASSWORD" \
  -v gateway_password="$POSTGRES_GATEWAY_PASSWORD" \
  -v validation_worker_password="$POSTGRES_VALIDATION_WORKER_PASSWORD" <<'EOSQL'
ALTER ROLE model_router_saas_migrator PASSWORD :'migrator_password';
ALTER ROLE model_router_saas_control_plane PASSWORD :'control_plane_password';
ALTER ROLE model_router_saas_gateway PASSWORD :'gateway_password';
ALTER ROLE model_router_saas_validation_worker PASSWORD :'validation_worker_password';
EOSQL

echo '10-role-passwords.sh: role passwords applied.'
