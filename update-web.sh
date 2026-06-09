#!/usr/bin/env bash
# update-web.sh — pull + rebuild + restart the Hermes Multi-User Web Service.
#
# A one-command deploy for the native (venv) test/staging box.  Designed to
# be run ON THE SERVER, inside the repo checkout, after changes have been
# pushed to the SeerBench fork.  It is idempotent and handles the four
# gotchas that bite manual updates:
#
#   1. gateway/web/_static/ is .gitignore'd — a plain ``git pull`` never
#      updates the SPA bundle, so the script ALWAYS rebuilds it (the #1
#      "backend updated but UI looks unchanged" trap).
#   2. ``npm install`` re-adds @askjo/camofox-browser to the repo-root
#      package.json (a postinstall side effect) — the script restores it so
#      the working tree stays clean and the next ``git pull`` isn't blocked.
#   3. The gateway may already hold the port — the script stops the old
#      process before relaunching, and detects supervisor respawns so it
#      never double-launches.
#   4. npm deps only get reinstalled when web-chat/package*.json actually
#      changed in the pull (this release: no dep changes, so build-only).
#
# What it does, in order:
#   1. Activate the venv.
#   2. git pull --ff-only from the SeerBench fork remote (auto-detected).
#   3. Rebuild the React SPA (npm ci only if deps changed, then npm run build).
#   4. (optional) run the fork's web test suite.
#   5. Restart the gateway (relaunch / systemd / custom command).
#   6. Health-check /api/healthz and print a summary.
#
# Usage:
#   ./update-web.sh                         # pull, rebuild, relaunch, verify
#   ./update-web.sh --systemd hermes-web    # restart via systemctl instead
#   ./update-web.sh --restart-cmd 'tmux send-keys -t hermes C-c "startweb" Enter'
#   ./update-web.sh --no-restart            # pull + build only, restart yourself
#   ./update-web.sh --no-pull               # rebuild + restart current checkout
#   ./update-web.sh --test                  # run web tests before restarting
#   ./update-web.sh --remote seerbench --branch main
#   ./update-web.sh --stash                 # auto-stash local changes for the pull
#   ./update-web.sh --help

set -euo pipefail

# ── Repo root (resolve symlinks so .venv / node_modules lookups are stable) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

# ── Colours (only when stdout is a TTY) ─────────────────────────────────────
if [[ -t 1 ]]; then
    C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
    C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi
log()  { printf '%s[update-web]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[update-web]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s[update-web]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s[update-web]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; }

# ── Defaults / config ───────────────────────────────────────────────────────
REMOTE=""                       # auto-detected if empty
BRANCH="main"
DO_PULL=1
DO_BUILD=1
DO_STASH=0
RUN_TESTS=0
RESTART_MODE="relaunch"         # relaunch | systemd | cmd | none
SYSTEMD_UNIT=""
RESTART_CMD=""
HOST_OVERRIDE=""
PORT_OVERRIDE=""

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CONFIG_YAML="$HERMES_HOME/config.yaml"
LOGFILE="${WEB_GATEWAY_LOG:-$HERMES_HOME/web-gateway.log}"
SPA_DIR="$SCRIPT_DIR/web-chat"
SPA_BUNDLE="$SCRIPT_DIR/gateway/web/_static/index.html"

PRE_COMMIT=""                   # set after we know HEAD; used for rollback hint
STASHED=0

# ── Argument parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote)       REMOTE="$2"; shift 2 ;;
        --branch)       BRANCH="$2"; shift 2 ;;
        --no-pull)      DO_PULL=0; shift ;;
        --no-build)     DO_BUILD=0; shift ;;
        --stash)        DO_STASH=1; shift ;;
        --test)         RUN_TESTS=1; shift ;;
        --systemd)      RESTART_MODE="systemd"; SYSTEMD_UNIT="$2"; shift 2 ;;
        --restart-cmd)  RESTART_MODE="cmd"; RESTART_CMD="$2"; shift 2 ;;
        --no-restart)   RESTART_MODE="none"; shift ;;
        --host)         HOST_OVERRIDE="$2"; shift 2 ;;
        --port)         PORT_OVERRIDE="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            err "unknown argument: $1 (try --help)"
            exit 2 ;;
    esac
done

# ── Failure trap: always print a rollback recipe ────────────────────────────
on_err() {
    local line="$1"
    err "update FAILED (line $line)."
    if [[ $STASHED -eq 1 ]]; then
        err "  your local changes are stashed — recover with: git stash pop"
    fi
    if [[ -n "$PRE_COMMIT" ]]; then
        err "  rollback code:  git reset --hard $PRE_COMMIT"
        err "  then rebuild:   (cd web-chat && npm run build)  and restart the gateway"
    fi
}
trap 'on_err $LINENO' ERR

# ── 1. Venv ─────────────────────────────────────────────────────────────────
find_venv() {
    for candidate in "$SCRIPT_DIR/.venv" "$SCRIPT_DIR/venv" "$HOME/.hermes/hermes-agent/venv"; do
        if [[ -f "$candidate/bin/activate" ]]; then
            printf '%s' "$candidate"; return 0
        fi
    done
    return 1
}
VENV_PATH="$(find_venv || true)"
if [[ -z "$VENV_PATH" ]]; then
    err "no venv found at .venv/ or venv/ — run ./setup-hermes.sh first"
    exit 1
fi
# shellcheck disable=SC1091
source "$VENV_PATH/bin/activate"
ok "venv active: $(python -V 2>&1)  ($(basename "$VENV_PATH")/)"

# ── 2. git pull ─────────────────────────────────────────────────────────────
PRE_COMMIT="$(git rev-parse HEAD)"

detect_remote() {
    local r
    r="$(git remote -v 2>/dev/null \
         | awk '/SeerBench\/hermes-multiuser-web-service/ {print $1; exit}')"
    if [[ -n "$r" ]]; then printf '%s' "$r"; else printf 'origin'; fi
}

if [[ $DO_PULL -eq 1 ]]; then
    [[ -z "$REMOTE" ]] && REMOTE="$(detect_remote)"
    log "pulling ${REMOTE}/${BRANCH} (current HEAD ${PRE_COMMIT:0:9})"

    # A dirty tree (often the camofox-polluted root package.json from a prior
    # npm install) blocks a ff-only pull.  Auto-stash on request; otherwise
    # try to restore a lone package.json, then fail loudly if still dirty.
    if ! git diff --quiet || ! git diff --cached --quiet; then
        if [[ $DO_STASH -eq 1 ]]; then
            git stash push -u -m "update-web.sh autostash $(date -u +%FT%TZ)"
            STASHED=1
            ok "stashed local changes"
        elif [[ -z "$(git status --porcelain | grep -v '^.. package.json$' || true)" ]]; then
            warn "root package.json is dirty (camofox postinstall artifact) — restoring it"
            git checkout -- package.json
        else
            err "working tree has local changes — commit/stash them, or pass --stash"
            git status --short
            exit 1
        fi
    fi

    git fetch "$REMOTE" "$BRANCH"
    git pull --ff-only "$REMOTE" "$BRANCH"

    if [[ $STASHED -eq 1 ]]; then
        if git stash pop; then
            STASHED=0
        else
            warn "git stash pop hit a conflict — resolve it manually (changes are in the stash)"
        fi
    fi
else
    REMOTE="${REMOTE:-$(detect_remote)}"
    warn "--no-pull: skipping git pull (building current checkout)"
fi

NEW_COMMIT="$(git rev-parse HEAD)"
if [[ "$PRE_COMMIT" == "$NEW_COMMIT" ]]; then
    log "code already at ${NEW_COMMIT:0:9} (no new commits)"
else
    ok "code updated ${PRE_COMMIT:0:9} → ${NEW_COMMIT:0:9}"
fi

# Surface Python dependency changes (we don't auto-install — the server's
# extra set is unknown — but the operator must know to reinstall).
if [[ "$PRE_COMMIT" != "$NEW_COMMIT" ]] \
   && git diff --name-only "$PRE_COMMIT" "$NEW_COMMIT" -- pyproject.toml uv.lock | grep -q .; then
    warn "pyproject.toml / uv.lock changed — Python deps may need reinstalling:"
    warn "    uv pip install -e \".[web-chat]\"   (add your other extras as needed)"
fi

# ── 3. Rebuild SPA ──────────────────────────────────────────────────────────
if [[ $DO_BUILD -eq 1 ]]; then
    if ! command -v npm >/dev/null 2>&1; then
        err "npm not found — install Node.js 20+ (or pass --no-build and build elsewhere)"
        exit 1
    fi

    # Reinstall node deps only when the manifests changed (or node_modules is
    # absent).  This release changes no deps, so the steady-state path is a
    # plain build that never touches package.json.
    DEPS_CHANGED=0
    if [[ ! -d "$SPA_DIR/node_modules" ]]; then
        DEPS_CHANGED=1
    elif [[ "$PRE_COMMIT" != "$NEW_COMMIT" ]] \
         && git diff --name-only "$PRE_COMMIT" "$NEW_COMMIT" \
              -- web-chat/package.json web-chat/package-lock.json | grep -q .; then
        DEPS_CHANGED=1
    fi

    pushd "$SPA_DIR" >/dev/null
    if [[ $DEPS_CHANGED -eq 1 ]]; then
        log "installing SPA deps (npm ci)…"
        npm ci
    else
        log "SPA deps unchanged — skipping npm install"
    fi
    log "building SPA (npm run build)…"
    npm run build
    popd >/dev/null

    # npm's postinstall can re-add @askjo/camofox-browser to the repo-root
    # package.json.  We never intend to change it here, so restore it to keep
    # the tree clean and unblock the next pull.
    if ! git diff --quiet -- package.json; then
        warn "root package.json was modified by npm — restoring (camofox artifact)"
        git checkout -- package.json
    fi

    if [[ -f "$SPA_BUNDLE" ]]; then
        ok "SPA bundle rebuilt → gateway/web/_static/"
    else
        err "SPA build finished but $SPA_BUNDLE is missing — aborting before restart"
        exit 1
    fi
else
    warn "--no-build: SPA NOT rebuilt — the UI will keep serving the old bundle"
fi

# ── 4. Optional tests ───────────────────────────────────────────────────────
if [[ $RUN_TESTS -eq 1 ]]; then
    if [[ -x "$SCRIPT_DIR/scripts/run_tests.sh" ]]; then
        log "running fork web test suite…"
        "$SCRIPT_DIR/scripts/run_tests.sh" \
            tests/gateway/test_web_*.py \
            tests/hermes_state/test_user_id_filtering.py
        ok "tests passed"
    else
        warn "scripts/run_tests.sh not found — skipping --test"
    fi
fi

# ── Resolve bind host/port (for the health check + summary) ──────────────────
read_cfg_host_port() {
    python - "$CONFIG_YAML" <<'PY' 2>/dev/null || printf '127.0.0.1\n8643\n'
import sys
from pathlib import Path
host, port = "127.0.0.1", "8643"
p = Path(sys.argv[1])
if p.exists():
    try:
        import yaml
        d = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        extra = (((d.get("platforms") or {}).get("web_chat") or {}).get("extra") or {})
        host = str(extra.get("host", host) or host)
        port = str(extra.get("port", port) or port)
    except Exception:
        pass
print(host)
print(port)
PY
}
mapfile -t _CFG < <(read_cfg_host_port)
HOST="${HOST_OVERRIDE:-${_CFG[0]:-127.0.0.1}}"
PORT="${PORT_OVERRIDE:-${_CFG[1]:-8643}}"
# Health-check a wildcard bind via loopback.
HEALTH_HOST="$HOST"
[[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]] && HEALTH_HOST="127.0.0.1"

# ── 5. Restart ──────────────────────────────────────────────────────────────
listeners_on_port() {
    local port="$1" pids=""
    if command -v ss >/dev/null 2>&1; then
        pids="$(ss -ltnpH "sport = :$port" 2>/dev/null \
                | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
    fi
    if [[ -z "$pids" ]] && command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    fi
    if [[ -z "$pids" ]] && command -v fuser >/dev/null 2>&1; then
        pids="$(fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
    fi
    printf '%s' "$pids" | tr '\n' ' '
}

stop_gateway() {
    local port="$1" pids
    pids="$(listeners_on_port "$port")"
    if [[ -z "${pids// }" ]]; then
        log "nothing listening on :$port"
        return 0
    fi
    log "stopping gateway on :$port (pid: ${pids})"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    for _ in $(seq 1 16); do
        sleep 0.5
        pids="$(listeners_on_port "$port")"
        [[ -z "${pids// }" ]] && { ok "old gateway stopped"; return 0; }
    done
    warn "still up after SIGTERM — sending SIGKILL"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 0.5
}

verify_health() {
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl not found — skipping health check"
        return 0
    fi
    local url="http://${HEALTH_HOST}:${PORT}/api/healthz"
    for _ in $(seq 1 40); do
        if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
            ok "health check OK — $url"
            return 0
        fi
        sleep 0.5
    done
    warn "no healthz response at $url within ~20s — inspect logs ($LOGFILE)"
    return 1
}

HEALTH_OK=0
case "$RESTART_MODE" in
    none)
        warn "--no-restart: code + bundle are updated; restart the gateway yourself."
        ;;
    systemd)
        log "restarting via systemd: $SYSTEMD_UNIT"
        if command -v sudo >/dev/null 2>&1; then
            sudo systemctl restart "$SYSTEMD_UNIT"
        else
            systemctl restart "$SYSTEMD_UNIT"
        fi
        ok "systemctl restart issued"
        verify_health && HEALTH_OK=1 || true
        ;;
    cmd)
        log "restarting via custom command: $RESTART_CMD"
        bash -c "$RESTART_CMD"
        ok "restart command finished"
        verify_health && HEALTH_OK=1 || true
        ;;
    relaunch)
        if ! command -v hermes >/dev/null 2>&1; then
            err "hermes not on PATH after venv activation — cannot relaunch"
            err "  restart manually, or use --systemd / --restart-cmd"
            exit 1
        fi
        stop_gateway "$PORT"
        # If a supervisor (systemd, etc.) brings the gateway back on its own,
        # it's already running the freshly-built code — don't start a second.
        sleep 1
        if [[ -n "$(listeners_on_port "$PORT" | tr -d ' ')" ]]; then
            ok "a supervisor restarted the gateway — not launching a duplicate"
        else
            mkdir -p "$(dirname "$LOGFILE")"
            log "launching: hermes gateway run  (background, logs → $LOGFILE)"
            nohup hermes gateway run >>"$LOGFILE" 2>&1 &
            disown || true
        fi
        verify_health && HEALTH_OK=1 || true
        ;;
esac

# ── 6. Summary ──────────────────────────────────────────────────────────────
URL="http://${HEALTH_HOST}:${PORT}/"
printf '\n%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"
ok "update complete — now at ${NEW_COMMIT:0:9}"
printf '%s  URL:%s     %s\n' "$C_DIM" "$C_RESET" "$URL"
printf '%s  bundle:%s  %s\n' "$C_DIM" "$C_RESET" "gateway/web/_static/ (rebuilt: $([[ $DO_BUILD -eq 1 ]] && echo yes || echo NO))"
if [[ "$RESTART_MODE" == "relaunch" || "$RESTART_MODE" == "systemd" || "$RESTART_MODE" == "cmd" ]]; then
    printf '%s  health:%s  %s\n' "$C_DIM" "$C_RESET" "$([[ $HEALTH_OK -eq 1 ]] && echo OK || echo 'check logs')"
    printf '%s  logs:%s    tail -f %s\n' "$C_DIM" "$C_RESET" "$LOGFILE"
fi
printf '%sTip:%s tell testers to hard-refresh (Ctrl-Shift-R) to drop the cached old SPA.\n' "$C_DIM" "$C_RESET"
printf '%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"

trap - ERR
