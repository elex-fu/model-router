#!/usr/bin/env bash
set -Eeuo pipefail

# Remote deploy for the current model-router checkout.
# Server credentials are read from an ignored local file and never printed.
REMOTE_HOST=""
REMOTE_USER=""
REMOTE_PASSWORD=""
REMOTE_PORT="22"
REMOTE_DIR="${MODEL_ROUTER_REMOTE_DIR:-/opt/model-router}"
DEPLOYMENT_KIND="${MODEL_ROUTER_DEPLOYMENT_KIND:-managed-saas}"
ACTION="${1:-deploy}"

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PARAM_FILE="$PROJECT_ROOT/deploy/remote-server.env"

fail() {
  printf 'deploy-remote: %s\n' "$*" >&2
  exit 1
}

[[ $# -le 1 ]] || fail 'usage: scripts/deploy-remote.sh [--check]'
case "$ACTION" in
  deploy|--check) ;;
  *) fail 'usage: scripts/deploy-remote.sh [--check]' ;;
esac

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required local command not found: $1"
}

require_command ssh
require_command sshpass
if [[ "$ACTION" == 'deploy' ]]; then
  require_command git
  require_command rsync
fi

[[ -f "$PARAM_FILE" ]] || fail "missing $PARAM_FILE; fill in the local server parameters first"
chmod 600 "$PARAM_FILE" || fail 'could not restrict the server parameter file permissions'

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || fail "invalid line in $PARAM_FILE; expected KEY=VALUE"

  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    SERVER_IP) REMOTE_HOST="$value" ;;
    SERVER_PORT) REMOTE_PORT="$value" ;;
    SERVER_USERNAME) REMOTE_USER="$value" ;;
    SERVER_PASSWORD) REMOTE_PASSWORD="$value" ;;
    *) fail "unknown parameter '$key' in $PARAM_FILE" ;;
  esac
done < "$PARAM_FILE"

[[ "$REMOTE_HOST" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'SSH host must be an SSH config alias, domain, or IPv4 address'
[[ "$REMOTE_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || fail 'SSH username contains unsupported characters'
[[ -n "$REMOTE_PASSWORD" ]] || fail "SERVER_PASSWORD is empty in $PARAM_FILE"
[[ "$REMOTE_PORT" =~ ^[0-9]+$ ]] || fail 'SSH port must be numeric'
[[ "$REMOTE_PORT" -ge 1 && "$REMOTE_PORT" -le 65535 ]] || fail 'SSH port must be between 1 and 65535'
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail 'remote directory must be an absolute path using letters, numbers, dots, underscores, hyphens, and slashes'
case "/$REMOTE_DIR/" in
  */../*|*/./*) fail 'remote directory cannot contain . or .. path components' ;;
esac
[[ "$DEPLOYMENT_KIND" == 'managed-saas' || "$DEPLOYMENT_KIND" == 'self-hosted' ]] || \
  fail 'MODEL_ROUTER_DEPLOYMENT_KIND must be managed-saas or self-hosted'

TARGET="${REMOTE_USER}@${REMOTE_HOST}"
if [[ "$ACTION" == '--check' ]]; then
  printf 'SSH login check only. No files will be uploaded and no deployment commands will run.\n'
  printf 'Target: %s (port %s)\n' "$TARGET" "$REMOTE_PORT"
else
  git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || fail 'script must run from a Git checkout'
  COMMIT="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
  TRACKED_CHANGES="$(git -C "$PROJECT_ROOT" status --short --untracked-files=no)"

  printf 'Project: %s\nCommit:  %s\nTarget:  %s:%s (port %s)\nMode:    %s\n' \
    "$PROJECT_ROOT" "$COMMIT" "$TARGET" "$REMOTE_DIR" "$REMOTE_PORT" "$DEPLOYMENT_KIND"
  if [[ -n "$TRACKED_CHANGES" ]]; then
    printf '\nTracked local changes will be included:\n%s\n' "$TRACKED_CHANGES"
  fi
  printf '\nOnly Git-tracked files are uploaded. Untracked files, local environment files, secrets, and operator modules are excluded.\n'
  if [[ "$DEPLOYMENT_KIND" == 'managed-saas' ]]; then
    printf 'Database migrations are not run by this script; the managed SaaS deployment requires explicit migrations.\n'
  fi
  IFS= read -r -p 'Continue with deployment? [y/N] ' ANSWER </dev/tty || fail 'could not read confirmation'
  [[ "$ANSWER" == 'y' || "$ANSWER" == 'Y' ]] || { printf 'Cancelled.\n'; exit 0; }
fi

CONTROL_DIR="$(mktemp -d /tmp/mrssh.XXXXXX)"
CONTROL_SOCKET="$CONTROL_DIR/s"
FILES_LIST=''
if [[ "$ACTION" == 'deploy' ]]; then
  FILES_LIST="$(mktemp /tmp/mrfiles.XXXXXX)"
fi
cleanup() {
  ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" -O exit "$TARGET" >/dev/null 2>&1 || true
  [[ -z "$FILES_LIST" ]] || rm -f "$FILES_LIST"
  rmdir "$CONTROL_DIR" 2>/dev/null || true
}
trap cleanup EXIT
chmod 700 "$CONTROL_DIR"

# Include the current contents of tracked files, including unstaged edits.
# Exclude local-only credentials and deployment configuration even if tracked accidentally.
if [[ "$ACTION" == 'deploy' ]]; then
  git -C "$PROJECT_ROOT" ls-files --cached -z |
    while IFS= read -r -d '' path; do
      case "$path" in
        .env|*/.env|.env.*|*/.env.*)
          [[ "$path" == *.example ]] || continue
          ;;
        .mcp.json|secrets.local.md|*/secrets.local.md|*.pem|*.key|*.p12|*.pfx|.claude/*|.codex/*|.cursor/*|deploy/compose/modules/*|deploy/compose/bench/certs/*)
          continue
          ;;
      esac
      [[ -e "$PROJECT_ROOT/$path" || -L "$PROJECT_ROOT/$path" ]] || continue
      printf '%s\0' "$path"
    done >"$FILES_LIST"
fi

printf '\nConnecting over SSH using the password from the ignored parameter file.\n'
sshpass -d 3 3<<<"$REMOTE_PASSWORD" ssh -M -N -f \
  -o "ControlPath=$CONTROL_SOCKET" \
  -o ControlPersist=10m \
  -p "$REMOTE_PORT" \
  "$TARGET"
unset REMOTE_PASSWORD

if [[ "$ACTION" == '--check' ]]; then
  ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" "$TARGET" \
    'printf "SSH authentication: OK\\n"; printf "Remote account: "; id -un; printf "Host: "; hostname; printf "System: "; uname -srm; if command -v docker >/dev/null 2>&1; then docker --version; if docker compose version >/dev/null 2>&1; then docker compose version; else printf "Docker Compose: unavailable\\n"; fi; else printf "Docker: not installed\\n"; fi'
  printf '\nSSH login check completed. No source files or services were changed.\n'
  exit 0
fi

ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" "$TARGET" \
  "mkdir -p -- '$REMOTE_DIR' && command -v rsync >/dev/null 2>&1"

printf '\nUploading tracked project files...\n'
rsync --archive --compress --from0 --files-from="$FILES_LIST" \
  -e "ssh -S $CONTROL_SOCKET -p $REMOTE_PORT" \
  "$PROJECT_ROOT/" "$TARGET:$REMOTE_DIR/"
ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" "$TARGET" \
  "cat > '$REMOTE_DIR/.model-router-deploy-files.next'" <"$FILES_LIST"

printf '\nBuilding and starting the service on the server...\n'
ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" "$TARGET" \
  "bash -s -- '$REMOTE_DIR' '$DEPLOYMENT_KIND'" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
app_dir="$1"
deployment_kind="$2"
manifest_path="$app_dir/.model-router-deploy-files"
next_manifest_path="$manifest_path.next"

command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on the server.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is not available on the server.' >&2; exit 1; }
command -v grep >/dev/null 2>&1 || { echo 'grep is required on the server to reconcile files from the previous deploy.' >&2; exit 1; }
[[ -f "$next_manifest_path" ]] || { echo 'The uploaded deploy manifest is missing.' >&2; exit 1; }

# Remove files that this script deployed previously but that are no longer tracked locally.
# Local environment files and operator modules are never in the manifest, so they are preserved.
if [[ -f "$manifest_path" ]]; then
  while IFS= read -r -d '' old_path; do
    if ! grep -Fzxq -- "$old_path" "$next_manifest_path"; then
      if [[ -f "$app_dir/$old_path" || -L "$app_dir/$old_path" ]]; then
        rm -f -- "$app_dir/$old_path"
      fi
    fi
  done < "$manifest_path"
fi
mv -- "$next_manifest_path" "$manifest_path"

case "$deployment_kind" in
  managed-saas)
    compose_dir="$app_dir/deploy/compose"
    [[ -f "$compose_dir/.env" ]] || { echo "Missing $compose_dir/.env; create it from .env.example and configure the server first." >&2; exit 1; }
    [[ -d "$compose_dir/modules" ]] || { echo "Missing $compose_dir/modules; install the trusted operator modules first." >&2; exit 1; }
    cd "$compose_dir"
    docker compose -f docker-compose.yml config -q
    docker compose -f docker-compose.yml build
    docker compose -f docker-compose.yml up -d --wait
    docker compose -f docker-compose.yml ps
    ;;
  self-hosted)
    cd "$app_dir"
    docker compose -f deploy/docker/compose.yaml config -q
    docker compose -f deploy/docker/compose.yaml up -d --build --wait
    docker compose -f deploy/docker/compose.yaml ps
    ;;
  *)
    echo "Unsupported deployment mode: $deployment_kind" >&2
    exit 1
    ;;
esac
REMOTE_DEPLOY

printf '\nDeployment command completed. Review the Compose service status above.\n'
