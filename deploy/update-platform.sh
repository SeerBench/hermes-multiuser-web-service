#!/usr/bin/env bash
# update-platform.sh — pull + rebuild SPA + reinstall platform extras + restart
# both platform-api (:8700) and web_chat gateway (:8643).
#
# Prefer this over update-web.sh on Platform SaaS boxes. For legacy key-only
# (gateway alone), keep using ./update-web.sh.
#
# Usage:
#   ./update-platform.sh
#   ./update-platform.sh --systemd hermes-platform-api,hermes-gateway
#   ./update-platform.sh --no-pull --no-restart
#   ./update-platform.sh --test
#   ./update-platform.sh --help
#
# Env:
#   PLATFORM_HEALTH_URL  default http://127.0.0.1:8700/api/v1/healthz
#   GATEWAY_HEALTH_URL   default http://127.0.0.1:8643/api/healthz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO_ROOT"

if [[ -t 1 ]]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
log()  { printf '%s[update-platform]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[update-platform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s[update-platform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s[update-platform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; }

DO_PULL=1
DO_BUILD=1
DO_INSTALL=1
RUN_TESTS=0
RESTART_MODE="systemd"   # systemd | none | cmd
SYSTEMD_UNITS="hermes-platform-api,hermes-gateway"
RESTART_CMD=""
REMOTE=""
BRANCH="main"
PLATFORM_HEALTH_URL="${PLATFORM_HEALTH_URL:-http://127.0.0.1:8700/api/v1/healthz}"
GATEWAY_HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:8643/api/healthz}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)      DO_PULL=0; shift ;;
    --no-build)     DO_BUILD=0; shift ;;
    --no-install)   DO_INSTALL=0; shift ;;
    --test)         RUN_TESTS=1; shift ;;
    --no-restart)   RESTART_MODE="none"; shift ;;
    --systemd)      RESTART_MODE="systemd"; SYSTEMD_UNITS="$2"; shift 2 ;;
    --restart-cmd)  RESTART_MODE="cmd"; RESTART_CMD="$2"; shift 2 ;;
    --remote)       REMOTE="$2"; shift 2 ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    --help|-h)
      cat <<'EOF'
update-platform.sh — pull + rebuild SPA + install [web-chat,platform] + restart
both platform-api and gateway.

Usage:
  ./deploy/update-platform.sh
  ./deploy/update-platform.sh --systemd hermes-platform-api,hermes-gateway
  ./deploy/update-platform.sh --no-pull --no-restart
  ./deploy/update-platform.sh --test
  ./deploy/update-platform.sh --restart-cmd 'sudo systemctl restart …'

Env:
  PLATFORM_HEALTH_URL  default http://127.0.0.1:8700/api/v1/healthz
  GATEWAY_HEALTH_URL   default http://127.0.0.1:8643/api/healthz
EOF
      exit 0 ;;
    *)
      err "unknown argument: $1 (try --help)"
      exit 2 ;;
  esac
done

# ── venv ───────────────────────────────────────────────────────────────────
if [[ -f .venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
elif [[ -f venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source venv/bin/activate
else
  err "no .venv — run ./setup-hermes.sh first"
  exit 1
fi

# ── git pull ───────────────────────────────────────────────────────────────
if [[ "$DO_PULL" == "1" ]]; then
  if [[ -z "$REMOTE" ]]; then
    REMOTE="$(git remote | head -1)"
  fi
  log "git pull --ff-only $REMOTE $BRANCH"
  git fetch "$REMOTE" "$BRANCH"
  git pull --ff-only "$REMOTE" "$BRANCH"
  ok "at $(git rev-parse --short HEAD)"
fi

# ── Python extras ──────────────────────────────────────────────────────────
if [[ "$DO_INSTALL" == "1" ]]; then
  log "uv pip install -e .[web-chat,platform]"
  if command -v uv >/dev/null 2>&1; then
    uv pip install -e ".[web-chat,platform]"
  else
    pip install -e ".[web-chat,platform]"
  fi
  ok "Python extras installed"
fi

# ── SPA build ──────────────────────────────────────────────────────────────
if [[ "$DO_BUILD" == "1" ]]; then
  log "rebuilding web-chat SPA"
  (
    cd web-chat
    if [[ -f package-lock.json ]]; then
      npm ci --prefer-offline 2>/dev/null || npm install
    else
      npm install
    fi
    npm run build
  )
  ok "SPA → gateway/web/_static/"
fi

# ── optional tests ─────────────────────────────────────────────────────────
if [[ "$RUN_TESTS" == "1" ]]; then
  log "running platform + gateway smoke tests"
  scripts/run_tests.sh tests/platform/ tests/gateway/test_web_*.py
fi

# ── restart ────────────────────────────────────────────────────────────────
case "$RESTART_MODE" in
  systemd)
    IFS=',' read -r -a UNITS <<< "$SYSTEMD_UNITS"
    for u in "${UNITS[@]}"; do
      u="$(echo "$u" | xargs)"
      [[ -z "$u" ]] && continue
      log "systemctl restart $u"
      if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl restart "$u"
      else
        warn "systemctl not available — skip restart of $u"
      fi
    done
    ;;
  cmd)
    log "custom restart: $RESTART_CMD"
    bash -lc "$RESTART_CMD"
    ;;
  none)
    warn "skipping restart (--no-restart)"
    ;;
esac

# ── health ─────────────────────────────────────────────────────────────────
sleep 1
fail=0
for url in "$PLATFORM_HEALTH_URL" "$GATEWAY_HEALTH_URL"; do
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    ok "health $url"
  else
    err "health FAILED $url"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
ok "update-platform complete"
