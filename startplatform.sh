#!/usr/bin/env bash
#
# startplatform.sh — launcher for the Hermes Platform SaaS stack (dev / private test).
#
# Starts the Sidecar pair from the AI SaaS Platform plan:
#   • platform-api  (:8700) — register/login, RAG, Memory/Skill, Admin
#   • web_chat      (:8643) — Agent Gateway SSE + sessions (foreground)
#
# What this does (in order):
#   1. Activates .venv (or runs setup-hermes.sh if missing).
#   2. Ensures [web-chat,platform] extras are installed.
#   3. Loads ~/.hermes/.env exports for child processes.
#   4. Resolves PLATFORM_DATABASE_URL (SQLite default, or --postgres for Docker PG).
#   5. Builds the React SPA if its bundle is missing.
#   6. Patches ~/.hermes/config.yaml for web_chat (same as startweb.sh).
#   7. Starts hermes-platform-api in the background; gateway in the foreground.
#   8. On Ctrl+C, stops the platform-api child.
#
# For Legacy key-only chat (no platform-api), use ./startweb.sh instead.
#
# Usage:
#   ./startplatform.sh                     # SQLite control plane + gateway
#   ./startplatform.sh --postgres          # docker compose postgres first
#   ./startplatform.sh --host 127.0.0.1    # localhost-only gateway bind
#   ./startplatform.sh --no-rebuild        # skip SPA build check
#   ./startplatform.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

DEFAULT_GATEWAY_PORT=8643
DEFAULT_PLATFORM_PORT=8700
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CONFIG_YAML="$HERMES_HOME/config.yaml"
ENV_FILE="$HERMES_HOME/.env"
SPA_DIR="$SCRIPT_DIR/web-chat"
SPA_BUNDLE="$SCRIPT_DIR/gateway/web/_static/index.html"
COMPOSE_FILE="$SCRIPT_DIR/deploy/docker-compose.yml"
PLATFORM_LOG="${PLATFORM_API_LOG:-$HERMES_HOME/logs/platform-api.log}"
GATEWAY_LOG="${WEB_GATEWAY_LOG:-$HERMES_HOME/web-gateway.log}"

if [[ -t 1 ]]; then
    C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
    C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi

log()  { printf '%s[startplatform]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[startplatform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s[startplatform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s[startplatform]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; }

HOST_OVERRIDE=""
PORT_OVERRIDE=""
PLATFORM_PORT_OVERRIDE=""
SKIP_BUILD=0
USE_POSTGRES=0
PLATFORM_PID=""

cleanup() {
    if [[ -n "$PLATFORM_PID" ]] && kill -0 "$PLATFORM_PID" 2>/dev/null; then
        log "stopping platform-api (pid $PLATFORM_PID)"
        kill -TERM "$PLATFORM_PID" 2>/dev/null || true
        wait "$PLATFORM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            HOST_OVERRIDE="$2"; shift 2 ;;
        --port)
            PORT_OVERRIDE="$2"; shift 2 ;;
        --platform-port)
            PLATFORM_PORT_OVERRIDE="$2"; shift 2 ;;
        --postgres)
            USE_POSTGRES=1; shift ;;
        --no-rebuild)
            SKIP_BUILD=1; shift ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            err "unknown argument: $1 (try --help)"
            exit 2 ;;
    esac
done

PLATFORM_PORT="${PLATFORM_PORT_OVERRIDE:-$DEFAULT_PLATFORM_PORT}"

find_venv() {
    for candidate in "$SCRIPT_DIR/.venv" "$SCRIPT_DIR/venv" "$HOME/.hermes/hermes-agent/venv"; do
        if [[ -f "$candidate/bin/activate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

VENV_PATH="$(find_venv || true)"
if [[ -z "$VENV_PATH" ]]; then
    warn "no venv found — running setup-hermes.sh first"
    [[ -x "$SCRIPT_DIR/setup-hermes.sh" ]] || { err "setup-hermes.sh missing"; exit 1; }
    "$SCRIPT_DIR/setup-hermes.sh"
    VENV_PATH="$(find_venv || true)"
    [[ -n "$VENV_PATH" ]] || { err "venv still missing after setup"; exit 1; }
fi

# shellcheck disable=SC1091
source "$VENV_PATH/bin/activate"
ok "venv active: $(python -V 2>&1)  ($(basename "$VENV_PATH")/)"

need_extras=0
python -c "import argon2" 2>/dev/null || need_extras=1
python -c "import fastapi" 2>/dev/null || need_extras=1
if [[ $need_extras -eq 1 ]]; then
    log "installing [web-chat,platform] extras"
    if command -v uv >/dev/null 2>&1; then
        uv pip install -e ".[web-chat,platform]"
    else
        pip install -e ".[web-chat,platform]"
    fi
fi
ok "[web-chat,platform] extras present"

# Export simple KEY=VALUE lines from ~/.hermes/.env for platform-api (gateway loads its own).
export_env_file() {
    [[ -f "$ENV_FILE" ]] || return 0
    local line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            val="${val%\"}"; val="${val#\"}"
            val="${val%\'}"; val="${val#\'}"
            export "$key=$val"
        fi
    done < "$ENV_FILE"
}
export_env_file

mkdir -p "$HERMES_HOME" "$(dirname "$PLATFORM_LOG")"

if [[ $USE_POSTGRES -eq 1 ]]; then
    if ! command -v docker >/dev/null 2>&1; then
        err "docker not found — install Docker or omit --postgres (SQLite default)"
        exit 1
    fi
    log "starting PostgreSQL via deploy/docker-compose.yml"
    docker compose -f "$COMPOSE_FILE" up -d postgres
    for _ in $(seq 1 40); do
        if docker compose -f "$COMPOSE_FILE" exec -T postgres \
            pg_isready -U hermes -d hermes_platform >/dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done
    export PLATFORM_DATABASE_URL="${PLATFORM_DATABASE_URL:-postgresql+psycopg://hermes:hermes@127.0.0.1:5432/hermes_platform}"
    ok "PostgreSQL ready — $PLATFORM_DATABASE_URL"
else
    export PLATFORM_DATABASE_URL="${PLATFORM_DATABASE_URL:-sqlite:///$HERMES_HOME/platform.db}"
    ok "control plane DB — $PLATFORM_DATABASE_URL"
fi

export UPSTREAM_PROVISIONER="${UPSTREAM_PROVISIONER:-manual}"
export PLATFORM_API_PORT="$PLATFORM_PORT"

if [[ -z "${NEW_API_BASE_URL:-}" ]]; then
    warn "NEW_API_BASE_URL not set — gateway may refuse to start"
    warn "  add to $ENV_FILE: NEW_API_BASE_URL=https://your-new-api.example.com"
fi

if [[ $SKIP_BUILD -eq 0 && ! -f "$SPA_BUNDLE" ]]; then
    log "SPA bundle missing — building web-chat"
    command -v npm >/dev/null 2>&1 || { err "npm not found"; exit 1; }
    pushd "$SPA_DIR" >/dev/null
    [[ -d node_modules ]] || npm install --silent
    npm run build --silent
    popd >/dev/null
fi
if [[ -f "$SPA_BUNDLE" ]]; then
    ok "SPA bundle ready"
else
    warn "SPA bundle absent — UI falls back to placeholder HTML"
fi

detect_tailscale_ip() {
    if command -v tailscale >/dev/null 2>&1; then
        local ts_ip
        ts_ip="$(tailscale ip --4 2>/dev/null | head -n1 | tr -d '[:space:]')"
        if [[ -n "$ts_ip" && "$ts_ip" =~ ^100\. ]]; then
            echo "$ts_ip"
            return
        fi
    fi
    if command -v ip >/dev/null 2>&1; then
        local iface_ip
        iface_ip="$(ip -4 -o addr show tailscale0 2>/dev/null \
                    | awk '{print $4}' | cut -d/ -f1 | head -n1)"
        if [[ -n "$iface_ip" && "$iface_ip" =~ ^100\. ]]; then
            echo "$iface_ip"
            return
        fi
    fi
    echo ""
}

if [[ -n "$HOST_OVERRIDE" ]]; then
    HOST="$HOST_OVERRIDE"
else
    TS_IP="$(detect_tailscale_ip)"
    if [[ -n "$TS_IP" ]]; then
        HOST="$TS_IP"
        ok "Tailscale detected — gateway bind $HOST"
    else
        HOST="127.0.0.1"
        warn "binding gateway to 127.0.0.1 (pass --host 0.0.0.0 for LAN)"
    fi
fi
PORT="${PORT_OVERRIDE:-$DEFAULT_GATEWAY_PORT}"
HEALTH_HOST="$HOST"
[[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]] && HEALTH_HOST="127.0.0.1"

CONFIG_STATUS="$(python - "$CONFIG_YAML" "$HOST" "$PORT" <<'PYEOF'
import io, sys
from pathlib import Path

config_path = Path(sys.argv[1])
host = sys.argv[2]
port = int(sys.argv[3])

try:
    from ruamel.yaml import YAML
    yaml = YAML()
    yaml.preserve_quotes = True
except ImportError:
    import yaml as _yaml
    class YAML:
        def load(self, s): return _yaml.safe_load(s) or {}
        def dump(self, data, stream): _yaml.safe_dump(data, stream, sort_keys=False)
    yaml = YAML()

existing_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
data = yaml.load(existing_text) if existing_text else {}
data = data or {}

platforms = data.setdefault("platforms", {})
web_chat = platforms.setdefault("web_chat", {})
web_chat["enabled"] = True
extra = web_chat.setdefault("extra", {})
extra["host"] = host
extra["port"] = port
extra["max_concurrent_agents"] = extra.get("max_concurrent_agents", 12)
extra["cookie_secure"] = False
extra["cookie_ttl_seconds"] = extra.get("cookie_ttl_seconds", 604800)
extra["allow_insecure_bind"] = True

buf = io.StringIO()
yaml.dump(data, buf)
new_text = buf.getvalue()

if new_text == existing_text:
    print("unchanged")
else:
    tmp = config_path.with_suffix(".yaml.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    tmp.replace(config_path)
    print("written")
PYEOF
)"
[[ "$CONFIG_STATUS" == "unchanged" ]] \
    && ok "config.yaml unchanged (web_chat host=$HOST port=$PORT)" \
    || ok "config.yaml updated for web_chat"

listeners_on_port() {
    local port="$1" pids=""
    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    elif command -v ss >/dev/null 2>&1; then
        pids="$(ss -ltnpH "sport = :$port" 2>/dev/null \
                | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
    fi
    printf '%s' "$pids" | tr '\n' ' '
}

stop_listeners() {
    local port="$1" label="$2"
    local pids
    pids="$(listeners_on_port "$port")"
    [[ -z "${pids// }" ]] && return 0
    warn "$label already on :$port (pid: $pids) — stopping"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 1
}

wait_health() {
    local url="$1" label="$2"
    command -v curl >/dev/null 2>&1 || { warn "curl missing — skip $label health check"; return 0; }
    for _ in $(seq 1 40); do
        if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
            ok "$label health OK — $url"
            return 0
        fi
        sleep 0.5
    done
    err "$label did not respond at $url within ~20s"
    return 1
}

stop_listeners "$PLATFORM_PORT" "platform-api"
stop_listeners "$PORT" "gateway"

if ! command -v hermes-platform-api >/dev/null 2>&1; then
    err "hermes-platform-api not on PATH — reinstall .[platform]"
    exit 1
fi

log "starting platform-api on :$PLATFORM_PORT (logs → $PLATFORM_LOG)"
nohup hermes-platform-api >>"$PLATFORM_LOG" 2>&1 &
PLATFORM_PID=$!
disown "$PLATFORM_PID" 2>/dev/null || true

wait_health "http://127.0.0.1:${PLATFORM_PORT}/api/v1/healthz" "platform-api" || {
    err "platform-api failed — tail -f $PLATFORM_LOG"
    exit 1
}

if [[ -f "$ENV_FILE" ]] && ! grep -qE '^(OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NOUS_API_KEY|GROQ_API_KEY|XAI_API_KEY)=.+' "$ENV_FILE"; then
    warn "no global LLM key in $ENV_FILE — users must bind-key before chat"
fi

warn "first-time admin: python scripts/create_admin.py --email admin@example.com --password 'changeme123'"
warn "frontend hot reload: cd web-chat && npm run dev  →  http://127.0.0.1:5173"

GATEWAY_URL="http://${HEALTH_HOST}:${PORT}/"
PLATFORM_URL="http://127.0.0.1:${PLATFORM_PORT}/"
printf '\n%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"
printf '%s%sHermes Platform SaaS%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '%s  SPA / Gateway:%s  %s\n' "$C_DIM" "$C_RESET" "$GATEWAY_URL"
printf '%s  Platform API:%s   %s (api/v1)\n' "$C_DIM" "$C_RESET" "$PLATFORM_URL"
printf '%s  platform log:%s   tail -f %s\n' "$C_DIM" "$C_RESET" "$PLATFORM_LOG"
printf '%sCtrl+C stops gateway + platform-api.%s\n\n' "$C_DIM" "$C_RESET"
printf '%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"

if ! command -v hermes >/dev/null 2>&1; then
    err "hermes not on PATH"
    exit 1
fi

# Foreground gateway — cleanup trap stops platform-api on exit.
exec hermes gateway run --replace
