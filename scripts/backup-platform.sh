#!/usr/bin/env bash
# backup-platform.sh — backup platform DB + Hermes home artifacts.
#
# Aligns with docs/user-guide/DEPLOY.md §12. Safe defaults; override via env.
#
# Usage:
#   ./scripts/backup-platform.sh
#   BACKUP_ROOT=/var/backups/hermes HERMES_HOME=/home/hermes/.hermes \
#     COMPOSE_DIR=/opt/hermes/infra ./scripts/backup-platform.sh
#
# Env:
#   BACKUP_ROOT     Destination parent (default: ./backups)
#   HERMES_HOME     Hermes profile home (default: $HOME/.hermes)
#   COMPOSE_DIR     Directory with docker-compose.yml for postgres (optional)
#   COMPOSE_FILE    Compose file name (default: docker-compose.yml)
#   PG_SERVICE      Compose service name (default: postgres)
#   PG_USER / PG_DB PostgreSQL user/db (default: hermes / hermes_platform)
#   SKIP_PG=1       Skip pg_dump (workspace + key only)
#   SKIP_TAR=1      Skip hermes-home tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
COMPOSE_DIR="${COMPOSE_DIR:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-hermes}"
PG_DB="${PG_DB:-hermes_platform}"
SKIP_PG="${SKIP_PG:-0}"
SKIP_TAR="${SKIP_TAR:-0}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"
chmod 700 "$DEST" 2>/dev/null || true

log() { printf '[backup-platform] %s\n' "$*"; }
ok()  { printf '[backup-platform] OK %s\n' "$*"; }
warn(){ printf '[backup-platform] WARN %s\n' "$*" >&2; }
die() { printf '[backup-platform] ERROR %s\n' "$*" >&2; exit 1; }

# ── PostgreSQL ─────────────────────────────────────────────────────────────
if [[ "$SKIP_PG" != "1" ]]; then
  if [[ -n "$COMPOSE_DIR" && -f "$COMPOSE_DIR/$COMPOSE_FILE" ]]; then
    log "pg_dump via docker compose ($COMPOSE_DIR, service=$PG_SERVICE)"
    (
      cd "$COMPOSE_DIR"
      docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
        pg_dump -U "$PG_USER" -d "$PG_DB" -Fc
    ) > "$DEST/platform.dump" \
      || die "pg_dump failed — set COMPOSE_DIR or SKIP_PG=1"
    ok "platform.dump ($(wc -c < "$DEST/platform.dump") bytes)"
  elif command -v pg_dump >/dev/null 2>&1 && [[ -n "${PLATFORM_DATABASE_URL:-}" ]]; then
    log "pg_dump via PLATFORM_DATABASE_URL"
    # Only support postgresql:// URLs here; SQLite users should skip PG.
    if [[ "$PLATFORM_DATABASE_URL" == postgresql* ]] || [[ "$PLATFORM_DATABASE_URL" == postgres* ]]; then
      pg_dump "$PLATFORM_DATABASE_URL" -Fc -f "$DEST/platform.dump" \
        || die "pg_dump failed"
      ok "platform.dump"
    else
      warn "PLATFORM_DATABASE_URL is not PostgreSQL; skipping DB dump"
    fi
  else
    warn "No COMPOSE_DIR / pg_dump — skipping database (set COMPOSE_DIR or SKIP_PG=1)"
  fi
fi

# ── Hermes home artifacts ──────────────────────────────────────────────────
if [[ "$SKIP_TAR" != "1" ]]; then
  if [[ ! -d "$HERMES_HOME" ]]; then
    die "HERMES_HOME not found: $HERMES_HOME"
  fi
  log "archiving $HERMES_HOME essentials → hermes-home.tar.gz"
  # Paths relative to parent of HERMES_HOME so restore is predictable.
  PARENT="$(dirname "$HERMES_HOME")"
  BASE="$(basename "$HERMES_HOME")"
  INCLUDE=()
  for rel in \
      "$BASE/.env" \
      "$BASE/config.yaml" \
      "$BASE/web_users_master.key" \
      "$BASE/web_workspaces" \
      "$BASE/state.db" \
      "$BASE/web_users.db"; do
    if [[ -e "$PARENT/$rel" ]]; then
      INCLUDE+=("$rel")
    fi
  done
  if [[ ${#INCLUDE[@]} -eq 0 ]]; then
    die "nothing to archive under $HERMES_HOME"
  fi
  tar -C "$PARENT" -czf "$DEST/hermes-home.tar.gz" "${INCLUDE[@]}"
  ok "hermes-home.tar.gz (${#INCLUDE[@]} paths)"
fi

# ── Integrity ──────────────────────────────────────────────────────────────
(
  cd "$DEST"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./* > SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 ./* > SHA256SUMS
  else
    warn "no sha256 tool; skipping SHA256SUMS"
  fi
)

log "backup complete: $DEST"
ls -la "$DEST"
printf '%s\n' "$DEST"
