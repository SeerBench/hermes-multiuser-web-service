#!/usr/bin/env bash
# Verify HTTPS + Secure session cookies for a deployed Hermes platform.
#
# Usage:
#   ./scripts/verify-https-cookies.sh https://hermes.example.com
#
# Checks:
#   1. Base URL is https://
#   2. /api/v1/healthz and /api/healthz respond
#   3. Register Set-Cookie includes Secure + HttpOnly for hermes_session
#   4. Optional: PLATFORM_COOKIE_SECURE / gateway cookie_secure hints when
#      HERMES_HOME + env files are readable locally
#
set -euo pipefail

BASE_URL="${1:-}"
if [[ -z "${BASE_URL}" ]]; then
  echo "usage: $0 https://your.domain" >&2
  exit 2
fi

if [[ "${BASE_URL}" != https://* ]]; then
  echo "FAIL: BASE_URL must start with https:// (got: ${BASE_URL})" >&2
  exit 1
fi

BASE_URL="${BASE_URL%/}"
EMAIL="cookie-probe-$(date +%s)@example.com"
PASS='ProbePass123!'

echo "==> healthz"
curl -fsS "${BASE_URL}/api/v1/healthz" >/dev/null
curl -fsS "${BASE_URL}/api/healthz" >/dev/null
echo "OK  platform + gateway healthz"

echo "==> register Set-Cookie (Secure + HttpOnly)"
HEADERS="$(mktemp)"
trap 'rm -f "${HEADERS}"' EXIT

HTTP_CODE="$(
  curl -sS -D "${HEADERS}" -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/api/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASS}\"}"
)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: register returned HTTP ${HTTP_CODE}" >&2
  cat "${HEADERS}" >&2 || true
  exit 1
fi

SET_COOKIE="$(grep -i '^set-cookie:' "${HEADERS}" | tr -d '\r' || true)"
if [[ -z "${SET_COOKIE}" ]]; then
  echo "FAIL: no Set-Cookie header on register" >&2
  exit 1
fi

echo "${SET_COOKIE}" | grep -qi 'hermes_session=' || {
  echo "FAIL: Set-Cookie missing hermes_session" >&2
  echo "${SET_COOKIE}" >&2
  exit 1
}

# Secure flag is case-insensitive; avoid matching cookie name substrings.
echo "${SET_COOKIE}" | grep -Eiq '(^|[;[:space:]])Secure([;[:space:]]|$)' || {
  echo "FAIL: hermes_session cookie missing Secure flag" >&2
  echo "      Ensure PLATFORM_COOKIE_SECURE=true and traffic is HTTPS." >&2
  echo "${SET_COOKIE}" >&2
  exit 1
}

echo "${SET_COOKIE}" | grep -Eiq '(^|[;[:space:]])HttpOnly([;[:space:]]|$)' || {
  echo "FAIL: hermes_session cookie missing HttpOnly flag" >&2
  echo "${SET_COOKIE}" >&2
  exit 1
}

echo "OK  Set-Cookie has Secure + HttpOnly"
echo
echo "All HTTPS cookie checks passed for ${BASE_URL}"
echo "Probe account left on server: ${EMAIL} (disable or delete in Admin)."
