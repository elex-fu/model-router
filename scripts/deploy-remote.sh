#!/usr/bin/env bash
set +x
set -Eeuo pipefail

# Remote deploy for the current model-router checkout.
# Server credentials are read from an ignored local file and never printed.
REMOTE_HOST=""
REMOTE_USER=""
REMOTE_PASSWORD=""
export -n REMOTE_PASSWORD
REMOTE_KEY=""
REMOTE_PORT="22"
REMOTE_DIR="${MODEL_ROUTER_REMOTE_DIR:-/opt/model-router}"
DEPLOYMENT_KIND="${MODEL_ROUTER_DEPLOYMENT_KIND:-managed-saas}"
ACTION=""
ASSUME_YES=false

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PARAM_FILE=""

fail() {
  printf 'deploy-remote: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Usage: scripts/deploy-remote.sh [ACTION] [--config FILE] [--yes]
  --init     Create deploy/remote-server.local.env (never overwrite)
  --check    Check SSH login and deployment dependencies, without changes
  --login    Open an interactive SSH shell
  --upload   Upload tracked source only, for first-time server setup
  --deploy   Upload, build, start and verify (default)
  --verify   Check existing containers and HTTP readiness, without restarting
  --config   Select a local KEY=VALUE file; see deploy/remote-server.env.example
  --yes      Skip the upload/deployment confirmation
  --help     Show this help
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --init|--check|--login|--upload|--deploy|--verify|deploy)
      [[ -z "$ACTION" ]] || fail 'choose one action only'
      ACTION="${1#--}"
      ;;
    --config)
      [[ $# -ge 2 && -n "$2" ]] || fail '--config requires a file path'
      PARAM_FILE="$2"
      shift
      ;;
    --yes) ASSUME_YES=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument; use --help" ;;
  esac
  shift
done
ACTION="${ACTION:-deploy}"
if [[ -z "$PARAM_FILE" ]]; then
  PARAM_FILE="$PROJECT_ROOT/deploy/remote-server.local.env"
  if [[ "$ACTION" != init && ! -e "$PARAM_FILE" && -f "$PROJECT_ROOT/deploy/remote-server.env" ]]; then
    PARAM_FILE="$PROJECT_ROOT/deploy/remote-server.env"
  fi
fi

if [[ "$ACTION" == init ]]; then
  # noclobber also protects against a concurrent init or an existing symlink.
  (umask 077; set -o noclobber; cat "$PROJECT_ROOT/deploy/remote-server.env.example" > "$PARAM_FILE") ||
    fail 'configuration already exists or cannot be created; no existing file was overwritten'
  printf 'Created %s (mode 600). Fill in the server parameters before connecting.\n' "$PARAM_FILE"
  exit 0
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required local command not found: $1"
}

require_command ssh
if [[ "$ACTION" == deploy || "$ACTION" == upload ]]; then
  require_command git
  require_command rsync
fi

[[ -f "$PARAM_FILE" ]] || fail "missing $PARAM_FILE; run --init and fill in the local server parameters first"
PARAM_FILE="$(cd -- "$(dirname -- "$PARAM_FILE")" && pwd)/$(basename -- "$PARAM_FILE")"
# Refuse accidentally tracked credential files even when selected with --config.
if command -v git >/dev/null 2>&1 && git -C "$PROJECT_ROOT" ls-files --error-unmatch -- "$PARAM_FILE" >/dev/null 2>&1; then
  fail 'the selected configuration is tracked by Git; use an ignored local file'
fi
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
    SERVER_SSH_KEY) REMOTE_KEY="$value" ;;
    SERVER_DEPLOY_DIR) REMOTE_DIR="$value" ;;
    DEPLOYMENT_KIND) DEPLOYMENT_KIND="$value" ;;
    *) fail "unknown parameter in $PARAM_FILE; see deploy/remote-server.env.example" ;;
  esac
done < "$PARAM_FILE"

[[ "$REMOTE_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || fail 'SERVER_IP must be an SSH config alias, domain, or IP address (without brackets)'
[[ "$REMOTE_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || fail 'SSH username contains unsupported characters'
[[ "$REMOTE_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'SSH port must contain 1 to 5 digits'
REMOTE_PORT="$((10#$REMOTE_PORT))"
[[ "$REMOTE_PORT" -ge 1 && "$REMOTE_PORT" -le 65535 ]] || fail 'SSH port must be between 1 and 65535'
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail 'remote directory must be an absolute path using letters, numbers, dots, underscores, hyphens, and slashes'
[[ "$REMOTE_DIR" != / && "$REMOTE_DIR" != *//* ]] || fail 'remote directory must be a dedicated application directory'
case "/$REMOTE_DIR/" in
  */../*|*/./*) fail 'remote directory cannot contain . or .. path components' ;;
esac
[[ "$DEPLOYMENT_KIND" == 'managed-saas' || "$DEPLOYMENT_KIND" == 'self-hosted' ]] || \
  fail 'DEPLOYMENT_KIND must be managed-saas or self-hosted'

SSH_AUTH=()
AUTH_KIND='SSH agent/config'
if [[ -n "$REMOTE_KEY" ]]; then
  [[ "$REMOTE_KEY" != '~/'* ]] || REMOTE_KEY="$HOME/${REMOTE_KEY#\~/}"
  [[ "$REMOTE_KEY" == /* && -f "$REMOTE_KEY" && -r "$REMOTE_KEY" ]] || fail 'SERVER_SSH_KEY must name a readable local private key using an absolute path or ~/.ssh/...'
  REMOTE_KEY="$(cd -- "$(dirname -- "$REMOTE_KEY")" && pwd)/$(basename -- "$REMOTE_KEY")"
  SSH_AUTH=(-i "$REMOTE_KEY" -o IdentitiesOnly=yes)
  AUTH_KIND='private key'
elif [[ -n "$REMOTE_PASSWORD" ]]; then
  require_command sshpass
  SSH_AUTH=(-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no)
  AUTH_KIND='password file'
fi

TARGET="${REMOTE_USER}@${REMOTE_HOST}"
RSYNC_TARGET="$TARGET"
[[ "$REMOTE_HOST" != *:* ]] || RSYNC_TARGET="${REMOTE_USER}@[${REMOTE_HOST}]"
printf 'Configuration: %s\nTarget: %s (port %s)\nAction: %s; authentication: %s\n' "$PARAM_FILE" "$TARGET" "$REMOTE_PORT" "$ACTION" "$AUTH_KIND"
if [[ "$ACTION" == deploy || "$ACTION" == upload ]]; then
  git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || fail 'script must run from a Git checkout'
  COMMIT="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
  TRACKED_CHANGES="$(git -C "$PROJECT_ROOT" status --short --untracked-files=no)"

  printf 'Project: %s\nCommit:  %s\nTarget:  %s:%s (port %s)\nMode:    %s\n' \
    "$PROJECT_ROOT" "$COMMIT" "$TARGET" "$REMOTE_DIR" "$REMOTE_PORT" "$DEPLOYMENT_KIND"
  if [[ -n "$TRACKED_CHANGES" ]]; then
    printf '\nTracked local changes will be included:\n%s\n' "$TRACKED_CHANGES"
  fi
  printf '\nOnly Git-tracked files are uploaded. Untracked files, local environment files, secrets, and operator modules are excluded.\n'
  if [[ "$DEPLOYMENT_KIND" == managed-saas ]]; then
    printf 'Database migrations are not run by this script; the managed SaaS deployment requires explicit migrations.\n'
  fi
  if [[ "$ASSUME_YES" != true ]]; then
    IFS= read -r -p 'Continue with this action? [y/N] ' ANSWER </dev/tty || fail 'could not read confirmation; use --yes for an authorized unattended run'
    [[ "$ANSWER" == y || "$ANSWER" == Y ]] || { printf 'Cancelled.\n'; exit 0; }
  fi
fi

CONTROL_DIR="$(mktemp -d /tmp/mrssh.XXXXXX)"
CONTROL_SOCKET="$CONTROL_DIR/s"
FILES_LIST=''
if [[ "$ACTION" == deploy || "$ACTION" == upload ]]; then
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
if [[ "$ACTION" == deploy || "$ACTION" == upload ]]; then
  git -C "$PROJECT_ROOT" ls-files --cached -z |
    while IFS= read -r -d '' path; do
      case "$path" in
        .env|*/.env|.env.*|*/.env.*|*.env|*.env.*)
          [[ "$path" == *.example ]] || continue
          ;;
        .mcp.json|secrets.local.md|*/secrets.local.md|*.pem|*.key|*.p12|*.pfx|id_rsa|*/id_rsa|id_ed25519|*/id_ed25519|.claude/*|.codex/*|.cursor/*|deploy/compose/modules/*|deploy/compose/bench/certs/*)
          continue
          ;;
      esac
      [[ "$PROJECT_ROOT/$path" != "$PARAM_FILE" ]] || continue
      [[ "$PROJECT_ROOT/$path" != "$REMOTE_KEY" ]] || continue
      [[ -e "$PROJECT_ROOT/$path" || -L "$PROJECT_ROOT/$path" ]] || continue
      printf '%s\0' "$path"
    done >"$FILES_LIST"
fi

SSH_MASTER=(ssh -M -N -f -o "ControlPath=$CONTROL_SOCKET" -o ControlPersist=10m
  -o StrictHostKeyChecking=ask -o ConnectTimeout=15 -o ServerAliveInterval=30
  -o ServerAliveCountMax=3 -p "$REMOTE_PORT")
printf '\nConnecting over SSH...\n'
if [[ "$AUTH_KIND" == 'password file' ]]; then
  sshpass -d 3 3<<<"$REMOTE_PASSWORD" "${SSH_MASTER[@]}" "${SSH_AUTH[@]}" "$TARGET" ||
    fail 'SSH failed; check credentials and confirm the host fingerprint with an interactive ssh login first'
else
  # The ${array[@]+...} spelling also supports empty arrays on macOS Bash 3.2.
  "${SSH_MASTER[@]}" ${SSH_AUTH[@]+"${SSH_AUTH[@]}"} "$TARGET"
fi
unset REMOTE_PASSWORD value line
SSH=(ssh -S "$CONTROL_SOCKET" -p "$REMOTE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=yes)

if [[ "$ACTION" == login ]]; then
  "${SSH[@]}" -t "$TARGET"
  exit 0
fi

if [[ "$ACTION" == check ]]; then
  "${SSH[@]}" "$TARGET" 'bash -s' <<'REMOTE_CHECK'
set -Eeuo pipefail
printf 'SSH authentication: OK\nRemote account: '; id -un
printf 'System: '; uname -srm
uptime
for dependency in rsync docker; do
  command -v "$dependency" >/dev/null 2>&1 || { echo "Missing server dependency: $dependency" >&2; exit 1; }
done
docker --version
docker compose version
docker info --format '{{.ServerVersion}}' >/dev/null
printf 'Deployment dependencies and Docker daemon access: OK\n'
REMOTE_CHECK
  printf '\nSSH and deployment preflight completed.\n'
  exit 0
fi

if [[ "$ACTION" == deploy || "$ACTION" == upload ]]; then
  "${SSH[@]}" "$TARGET" \
    "mkdir -p -- '$REMOTE_DIR' && command -v rsync >/dev/null 2>&1"

  printf '\nUploading tracked project files...\n'
  rsync --archive --compress --from0 --files-from="$FILES_LIST" \
    -e "ssh -S $CONTROL_SOCKET -p $REMOTE_PORT -o BatchMode=yes -o StrictHostKeyChecking=yes" \
    "$PROJECT_ROOT/" "$RSYNC_TARGET:$REMOTE_DIR/"
  "${SSH[@]}" "$TARGET" \
    "cat > '$REMOTE_DIR/.model-router-deploy-files.next'" <"$FILES_LIST"
fi

printf '\nRunning server action: %s...\n' "$ACTION"
"${SSH[@]}" "$TARGET" \
  "bash -s -- '$REMOTE_DIR' '$DEPLOYMENT_KIND' '$ACTION'" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
app_dir="$1"
deployment_kind="$2"
action="$3"
manifest_path="$app_dir/.model-router-deploy-files"
next_manifest_path="$manifest_path.next"

if [[ "$action" != verify ]]; then
  command -v grep >/dev/null 2>&1 || { echo 'grep is required on the server to reconcile files from the previous deploy.' >&2; exit 1; }
  [[ -f "$next_manifest_path" ]] || { echo 'The uploaded deploy manifest is missing.' >&2; exit 1; }

  # Remove only previously deployed source; preserve local operator configuration.
  if [[ -f "$manifest_path" ]]; then
    while IFS= read -r -d '' old_path; do
      case "$old_path" in
        /*|../*|*/../*|*/..|./*|*/./*|*/.) echo 'Unsafe previous deploy manifest path.' >&2; exit 1 ;;
        .env|*/.env|.env.*|*/.env.*|*.env|*.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa|*/id_rsa|id_ed25519|*/id_ed25519|.mcp.json|secrets.local.md|*/secrets.local.md|.claude/*|.codex/*|.cursor/*|deploy/compose/modules/*|deploy/compose/bench/certs/*) continue ;;
      esac
      if ! grep -Fzxq -- "$old_path" "$next_manifest_path"; then
        if [[ -f "$app_dir/$old_path" || -L "$app_dir/$old_path" ]]; then
          rm -f -- "$app_dir/$old_path"
        fi
      fi
    done < "$manifest_path"
  fi
  mv -- "$next_manifest_path" "$manifest_path"
fi

if [[ "$action" == upload ]]; then
  printf 'Source upload completed. Configure the server using deploy/REMOTE.md before --deploy.\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on the server.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is not available on the server.' >&2; exit 1; }

case "$deployment_kind" in
  managed-saas)
    compose_dir="$app_dir/deploy/compose"
    [[ -f "$compose_dir/.env" ]] || { echo "Missing $compose_dir/.env; create it from .env.example and configure the server first." >&2; exit 1; }
    [[ -d "$compose_dir/modules" ]] || { echo "Missing $compose_dir/modules; install the trusted operator modules first." >&2; exit 1; }
    cd "$compose_dir"
    compose=(docker compose -f docker-compose.yml)
    services=(postgres redis control-plane gateway credential-validation-worker)
    ;;
  self-hosted)
    cd "$app_dir"
    compose=(docker compose -f deploy/docker/compose.yaml)
    services=(model-router)
    ;;
  *)
    echo "Unsupported deployment mode: $deployment_kind" >&2
    exit 1
    ;;
esac

"${compose[@]}" config -q
if [[ "$action" == deploy ]]; then
  "${compose[@]}" build
  "${compose[@]}" up -d --wait --wait-timeout 180
fi
"${compose[@]}" ps
for service in "${services[@]}"; do
  ids="$("${compose[@]}" ps --all --quiet "$service")"
  [[ -n "$ids" ]] || { echo "Missing service: $service" >&2; exit 1; }
  while IFS= read -r id; do
    state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")"
    printf '%s %s: %s\n' "$service" "$id" "$state"
    [[ "$state" == 'running healthy' ]] || { echo "Service is not healthy: $service" >&2; exit 1; }
    if [[ "$service" == gateway || "$service" == model-router ]]; then
      docker exec "$id" node -e '
        const managed = process.env.MODEL_ROUTER_DEPLOYMENT_MODE === "managed-saas";
        const path = managed ? "/readyz" : "/healthz";
        const port = managed ? (process.env.MODEL_ROUTER_SAAS_GATEWAY_PORT || "15007") : "15005";
        fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000), redirect: "error" })
          .then(async response => { console.log(`${path}: HTTP ${response.status}`); await response.body?.cancel(); process.exit(response.status === 200 ? 0 : 1); })
          .catch(() => { console.error(`${path}: readiness request failed`); process.exit(1); });'
    fi
  done <<< "$ids"
done
printf 'Container health and application HTTP readiness: PASS\n'
REMOTE_DEPLOY

printf '\nServer action completed: %s\n' "$ACTION"
