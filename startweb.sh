#!/usr/bin/env bash
#
# startweb.sh — fast launcher for the Hermes Multi-User Web Service.
#
# What this does (in order):
#   1. Activates .venv (or runs setup-hermes.sh if missing).
#   2. Ensures argon2-cffi is installed (the [web-chat] extra).
#   3. Builds the React SPA if its bundle is missing.
#   4. Detects a usable bind address — prefers the Tailscale IPv4
#      address if Tailscale is up, falls back to 127.0.0.1 otherwise.
#   5. Patches ~/.hermes/config.yaml to enable the web_chat platform
#      with allow_insecure_bind:true (Tailscale already encrypts).
#   6. Warns if no upstream LLM key is configured in ~/.hermes/.env.
#   7. Starts ``hermes gateway run`` in the foreground.
#
# Intended for development / private testing on a Tailscale network.
# Not for production — for that, see docs/user-guide/web-chat.md
# (TLS proxy, cookie_secure:true, real CIDR allowlists, etc).
#
# Usage:
#   ./startweb.sh                    # auto-detect Tailscale, foreground
#   ./startweb.sh --host 0.0.0.0     # explicit bind override
#   ./startweb.sh --host 127.0.0.1   # localhost-only
#   ./startweb.sh --port 9000        # non-default port
#   ./startweb.sh --no-rebuild       # skip the SPA build check
#   ./startweb.sh --help

set -euo pipefail

# ── Repo root ───────────────────────────────────────────────────────────────
# ``pwd -P`` resolves symlinks so we always anchor at the real on-disk path.
# Matters when the repo is reached via a symlinked working tree (e.g. a
# Conductor / WSL alias path) — otherwise ``.venv`` lookups land in the
# alias namespace and miss the actual venv built under the canonical path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

# ── Constants ───────────────────────────────────────────────────────────────
DEFAULT_PORT=8643
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CONFIG_YAML="$HERMES_HOME/config.yaml"
ENV_FILE="$HERMES_HOME/.env"
SPA_DIR="$SCRIPT_DIR/web-chat"
SPA_BUNDLE="$SCRIPT_DIR/gateway/web/_static/index.html"

# ── Colours (only if stdout is a TTY) ───────────────────────────────────────
if [[ -t 1 ]]; then
    C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
    C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi

log()  { printf '%s[startweb]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[startweb]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s[startweb]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s[startweb]%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; }

# ── Argument parsing ────────────────────────────────────────────────────────
HOST_OVERRIDE=""
PORT_OVERRIDE=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            HOST_OVERRIDE="$2"; shift 2 ;;
        --port)
            PORT_OVERRIDE="$2"; shift 2 ;;
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

PORT="${PORT_OVERRIDE:-$DEFAULT_PORT}"

# ── 1. Venv ─────────────────────────────────────────────────────────────────
# Probe ``.venv``, then ``venv``, then the shared system venv — matches the
# fallback chain in ``scripts/run_tests.sh``.  ``setup-hermes.sh`` currently
# creates ``venv/`` (no leading dot); other tooling sometimes finds
# ``.venv/``.  Either layout works as long as ``bin/activate`` is present.
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
    warn "no venv found at .venv/ or venv/ — running setup-hermes.sh first"
    if [[ ! -x "$SCRIPT_DIR/setup-hermes.sh" ]]; then
        err "setup-hermes.sh missing or not executable"
        exit 1
    fi
    "$SCRIPT_DIR/setup-hermes.sh"

    # Verify setup actually created a venv — setup-hermes.sh can be
    # interrupted (e.g. the user answering 'n' to the wizard prompt is
    # fine and shouldn't fail the script).  Re-probe both names.
    VENV_PATH="$(find_venv || true)"
    if [[ -z "$VENV_PATH" ]]; then
        err "setup-hermes.sh ran but no venv/bin/activate exists under $SCRIPT_DIR"
        err "  expected one of:"
        err "    $SCRIPT_DIR/.venv/bin/activate"
        err "    $SCRIPT_DIR/venv/bin/activate"
        err "  inspect setup-hermes.sh output above, or create the venv manually:"
        err "    uv venv .venv --python 3.11"
        err "    source .venv/bin/activate"
        err "    uv pip install -e \".[all,dev,web-chat]\""
        exit 1
    fi
fi

# shellcheck disable=SC1091
source "$VENV_PATH/bin/activate"
ok "venv active: $(python -V 2>&1)  ($(basename "$VENV_PATH")/)"

# ── 2. [web-chat] extra ─────────────────────────────────────────────────────
if ! python -c "import argon2" 2>/dev/null; then
    log "argon2-cffi not installed — installing [web-chat] extra"
    if command -v uv >/dev/null 2>&1; then
        uv pip install -e ".[web-chat]"
    else
        pip install -e ".[web-chat]"
    fi
fi
ok "[web-chat] extra present"

# ── 3. SPA bundle ───────────────────────────────────────────────────────────
if [[ $SKIP_BUILD -eq 0 && ! -f "$SPA_BUNDLE" ]]; then
    log "SPA bundle missing at gateway/web/_static/ — building"
    if ! command -v npm >/dev/null 2>&1; then
        err "npm not found — install Node.js 20+ (or pass --no-rebuild to skip)"
        exit 1
    fi
    pushd "$SPA_DIR" >/dev/null
    if [[ ! -d node_modules ]]; then
        log "  npm install ..."
        npm install --silent
    fi
    log "  npm run build ..."
    npm run build --silent
    popd >/dev/null
fi
if [[ -f "$SPA_BUNDLE" ]]; then
    ok "SPA bundle ready"
else
    warn "SPA bundle absent — UI will fall back to placeholder HTML"
fi

# ── 4. Bind address detection ───────────────────────────────────────────────
detect_tailscale_ip() {
    # Try `tailscale ip --4` first (works if tailscale CLI is in PATH).
    if command -v tailscale >/dev/null 2>&1; then
        local ts_ip
        ts_ip="$(tailscale ip --4 2>/dev/null | head -n1 | tr -d '[:space:]')"
        if [[ -n "$ts_ip" && "$ts_ip" =~ ^100\..*\..*\..* ]]; then
            echo "$ts_ip"
            return
        fi
    fi
    # Fallback: parse `ip addr show tailscale0` if the interface exists.
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
    log "bind address: $HOST (from --host flag)"
else
    TS_IP="$(detect_tailscale_ip)"
    if [[ -n "$TS_IP" ]]; then
        HOST="$TS_IP"
        ok "Tailscale detected — binding $HOST (reachable from your tailnet)"
    else
        HOST="127.0.0.1"
        warn "Tailscale not detected — binding 127.0.0.1 (localhost only)"
        warn "  (pass --host 0.0.0.0 to expose to LAN — not recommended)"
    fi
fi

# ── 5. config.yaml patching ─────────────────────────────────────────────────
mkdir -p "$HERMES_HOME"

# Python writes the YAML to avoid shell-quoting and YAML-edge-case bugs.
# Idempotent: the script reads the existing config, computes the would-be-new
# content in memory, and only touches the file when something actually
# changes — repeated runs print "unchanged" with no disk write.
# ruamel.yaml round-trips comments + key order; PyYAML fallback is a minimal
# shim for the unusual case where ruamel isn't installed.
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
extra["cookie_secure"] = False           # plain HTTP under Tailscale / loopback
extra["cookie_ttl_seconds"] = extra.get("cookie_ttl_seconds", 604800)
extra["allow_insecure_bind"] = True      # opt-out of "non-loopback + !cookie_secure → refuse"

buf = io.StringIO()
yaml.dump(data, buf)
new_text = buf.getvalue()

if new_text == existing_text:
    print("unchanged")
else:
    # Atomic write so a Ctrl-C mid-write can't truncate config.yaml.
    tmp = config_path.with_suffix(".yaml.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    tmp.replace(config_path)
    print("written")
PYEOF
)"

if [[ "$CONFIG_STATUS" == "unchanged" ]]; then
    ok "config.yaml already configured for host=$HOST port=$PORT — unchanged"
else
    ok "config.yaml written → platforms.web_chat.enabled=true, host=$HOST, port=$PORT"
fi

# ── 6. LLM key sanity check ─────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]] && grep -qE '^(OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NOUS_API_KEY|GROQ_API_KEY|XAI_API_KEY)=.+' "$ENV_FILE"; then
    ok "upstream LLM key found in $ENV_FILE"
else
    warn "no upstream LLM key found in $ENV_FILE"
    warn "  (chat requests will fail when the agent tries to reach a provider)"
    warn "  add one, e.g.: echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> $ENV_FILE"
fi

# ── 7. Launch ───────────────────────────────────────────────────────────────
URL="http://$HOST:$PORT/"
printf '\n%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"
printf '%s%sHermes Multi-User Web Chat → %s%s\n' "$C_BOLD" "$C_GREEN" "$URL" "$C_RESET"
printf '%s%s%s\n' "$C_BOLD" "════════════════════════════════════════════════════════════════" "$C_RESET"
printf '%sCtrl+C to stop.  Logs follow.%s\n\n' "$C_DIM" "$C_RESET"

exec hermes gateway run
