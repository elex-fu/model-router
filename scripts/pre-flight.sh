#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-15005}"
BIND="${BIND:-127.0.0.1}"
RUN_USER="${RUN_USER:-${USER:-$(whoami)}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }

EXIT_CODE=0

echo "=== model-router Pre-flight Check ==="

# 1. Node.js
echo "[1/8] Node.js version"
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    ok "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION (requires >= 20)"
    EXIT_CODE=1
  fi
else
  fail "Node.js not found"
  EXIT_CODE=1
fi

# 2. npm
echo "[2/8] npm"
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm not found"
  EXIT_CODE=1
fi

# 3. Build tools for better-sqlite3
echo "[3/8] Native build tools (for better-sqlite3)"
if command -v python3 &>/dev/null || command -v python &>/dev/null; then
  ok "Python available"
else
  warn "Python not found — better-sqlite3 build may fail"
  EXIT_CODE=1
fi

if command -v g++ &>/dev/null; then
  ok "g++ available"
else
  warn "g++ not found — better-sqlite3 build may fail"
  EXIT_CODE=1
fi

# 4. Port availability
echo "[4/8] Port $PORT availability"
if command -v ss &>/dev/null; then
  if ss -tln | awk '{print $4}' | grep -qE ":${PORT}$"; then
    fail "Port $PORT is already in use"
    EXIT_CODE=1
  else
    ok "Port $PORT is free"
  fi
elif command -v netstat &>/dev/null; then
  if netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${PORT}$"; then
    fail "Port $PORT is already in use"
    EXIT_CODE=1
  else
    ok "Port $PORT is free"
  fi
else
  warn "Neither ss nor netstat available — skipping port check"
fi

# 5. Disk space
echo "[5/8] Disk space"
AVAIL=$(df -BM . 2>/dev/null | awk 'NR==2 {gsub(/M/,"",$4); print $4}')
if [[ -n "${AVAIL:-}" ]] && [[ "$AVAIL" -gt 500 ]]; then
  ok "${AVAIL}MB available"
else
  warn "Low disk space: ${AVAIL:-unknown}MB (recommend > 500MB)"
fi

# 6. Directory permissions
echo "[6/8] Data directory permissions"
if [[ "$EUID" -eq 0 ]]; then
  warn "Running as root — recommend a dedicated user (e.g., model-router)"
fi

HOME_DIR=$(eval echo "~$RUN_USER" 2>/dev/null || echo "$HOME")
DATA_DIR="$HOME_DIR/.model-router"

if [[ -d "$DATA_DIR" ]]; then
  if sudo -u "$RUN_USER" test -w "$DATA_DIR" 2>/dev/null; then
    ok "$DATA_DIR is writable by $RUN_USER"
  else
    warn "$DATA_DIR exists but may not be writable by $RUN_USER"
  fi
else
  ok "$DATA_DIR will be created on first run"
fi

# 7. SELinux
echo "[7/8] SELinux"
if command -v getenforce &>/dev/null; then
  SELINUX=$(getenforce)
  if [[ "$SELINUX" == "Enforcing" ]]; then
    warn "SELinux is Enforcing — you may need a custom policy for Node.js"
  else
    ok "SELinux: $SELINUX"
  fi
else
  ok "SELinux not detected"
fi

# 8. Firewall
echo "[8/8] Firewall"
if command -v ufw &>/dev/null; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    warn "UFW is active — ensure port $PORT is allowed if binding to 0.0.0.0"
  else
    ok "UFW: inactive"
  fi
elif command -v firewall-cmd &>/dev/null; then
  if firewall-cmd --state 2>/dev/null | grep -q "running"; then
    warn "firewalld is running — ensure port $PORT is allowed if binding to 0.0.0.0"
  else
    ok "firewalld: not running"
  fi
else
  ok "No recognized firewall detected"
fi

# Summary
echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}All critical checks passed. Ready to install.${NC}"
else
  echo -e "${YELLOW}Some checks failed or raised warnings. Review above before proceeding.${NC}"
fi
exit $EXIT_CODE
