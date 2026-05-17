#!/usr/bin/env bash
set -euo pipefail

# Configurable paths
PREFIX="${PREFIX:-/usr/local}"
RUN_USER="${RUN_USER:-model-router}"
CONFIG_DIR="${CONFIG_DIR:-/etc/model-router}"
DATA_DIR="${DATA_DIR:-/var/lib/model-router}"
LOG_DIR="${LOG_DIR:-/var/log/model-router}"
INSTALL_SYSTEMD="${INSTALL_SYSTEMD:-yes}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Require root for system-wide install
if [[ $EUID -ne 0 ]]; then
  log_error "This installer must be run as root for system-wide installation."
  log_error "Try: sudo $0"
  exit 1
fi

# Detect project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# 1. Pre-flight dependency check
log_info "Checking dependencies..."

if ! command -v node &>/dev/null; then
  log_error "Node.js not found. Install Node.js >= 20 first."
  log_error "  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  log_error "  RHEL/CentOS:   dnf module install nodejs:22/common"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  log_error "Node.js $NODE_VERSION is too old. Requires >= 20."
  exit 1
fi
log_info "Node.js $NODE_VERSION OK"

if ! command -v npm &>/dev/null; then
  log_error "npm not found."
  exit 1
fi
log_info "npm $(npm -v) OK"

MISSING_BUILD_TOOLS=0
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  log_warn "Python not found. better-sqlite3 compilation may fail."
  MISSING_BUILD_TOOLS=1
fi
if ! command -v g++ &>/dev/null; then
  log_warn "g++ not found. better-sqlite3 compilation may fail."
  MISSING_BUILD_TOOLS=1
fi

if [[ "$MISSING_BUILD_TOOLS" -eq 1 ]]; then
  log_warn "Install build tools:"
  log_warn "  Debian/Ubuntu: apt-get install -y build-essential python3"
  log_warn "  RHEL/CentOS:   dnf groupinstall -y 'Development Tools' && dnf install -y python3"
  read -rp "Continue anyway? [y/N] " ans
  if [[ ! "$ans" =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# 2. Install dependencies and build
log_info "Installing npm dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

log_info "Building TypeScript..."
npm run build

# 3. Create system user
if ! id "$RUN_USER" &>/dev/null; then
  log_info "Creating system user: $RUN_USER"
  useradd --system \
    --no-create-home \
    --home-dir "$DATA_DIR" \
    --shell /usr/sbin/nologin \
    "$RUN_USER"
else
  log_info "User $RUN_USER already exists"
fi

# 4. Create directories
mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"

# 5. Install binary
BIN_TARGET="$PREFIX/bin/model-router"
log_info "Linking binary to $BIN_TARGET ..."
ln -sf "$PROJECT_ROOT/dist/cli/index.js" "$BIN_TARGET"
chmod +x "$BIN_TARGET"

# 6. Write default config if missing
if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  log_info "Creating default config at $CONFIG_DIR/config.json"
  node -e '
    const fs = require("fs");
    const cfg = {
      server: {
        port: 15005,
        bindAddress: "127.0.0.1",
        logRetentionDays: 30,
        logFlushIntervalMs: 5000,
        logBatchSize: 50
      },
      upstreams: [],
      proxyKeys: []
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));
  ' "$CONFIG_DIR/config.json"
  chmod 640 "$CONFIG_DIR/config.json"
  chown "root:$RUN_USER" "$CONFIG_DIR/config.json"
else
  log_info "Config already exists at $CONFIG_DIR/config.json"
fi

# 7. Fix data directory ownership
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chown -R "$RUN_USER:$RUN_USER" "$LOG_DIR"

# 8. Install systemd service
if [[ "$INSTALL_SYSTEMD" == "yes" ]] && command -v systemctl &>/dev/null; then
  log_info "Installing systemd service..."
  SERVICE_FILE="/etc/systemd/system/model-router.service"
  cp "$SCRIPT_DIR/model-router.service" "$SERVICE_FILE"

  # Replace template placeholders
  sed -i "s|__PREFIX__|$PREFIX|g" "$SERVICE_FILE"
  sed -i "s|__CONFIG_DIR__|$CONFIG_DIR|g" "$SERVICE_FILE"
  sed -i "s|__DATA_DIR__|$DATA_DIR|g" "$SERVICE_FILE"
  sed -i "s|__LOG_DIR__|$LOG_DIR|g" "$SERVICE_FILE"
  sed -i "s|__RUN_USER__|$RUN_USER|g" "$SERVICE_FILE"
  sed -i "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" "$SERVICE_FILE"

  systemctl daemon-reload
  log_info "Systemd service installed: $SERVICE_FILE"
  log_info "  Enable:  systemctl enable --now model-router"
  log_info "  Status:  systemctl status model-router"
  log_info "  Logs:    journalctl -u model-router -f"
else
  log_info "Skipping systemd installation (set INSTALL_SYSTEMD=yes to enable)"
fi

# 9. Optional logrotate config
if command -v logrotate &>/dev/null && [[ ! -f /etc/logrotate.d/model-router ]]; then
  log_info "Installing logrotate config..."
  cat > /etc/logrotate.d/model-router <<EOF
$LOG_DIR/*.log {
  daily
  rotate 14
  missingok
  notifempty
  copytruncate
  compress
  delaycompress
}
EOF
fi

# 10. Print summary
log_info "Installation complete!"
echo ""
echo "  Binary:     $BIN_TARGET"
echo "  Config:     $CONFIG_DIR/config.json"
echo "  Data/DB:    $DATA_DIR/.model-router/"
echo "  Logs:       $LOG_DIR/"
echo "  User:       $RUN_USER"
echo ""
echo "Next steps:"
echo "  1. Edit config:   nano $CONFIG_DIR/config.json"
echo "  2. Add upstream:  $BIN_TARGET upstream:add <name> <provider> <protocol> <url> <keys> --models ..."
echo "  3. Add proxy key: $BIN_TARGET key:create <name>"
echo "  4. Start service: systemctl enable --now model-router"
echo ""
echo "Health check: curl http://127.0.0.1:15005/healthz"
