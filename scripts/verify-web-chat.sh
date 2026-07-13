#!/usr/bin/env bash
# CI-parity verifier for the web-chat SPA (typecheck → vitest → vite build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}/web-chat"

if [[ ! -d node_modules ]]; then
  npm ci
fi

npm run verify
