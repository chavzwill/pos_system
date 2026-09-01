#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${POS_BASE_URL:-http://127.0.0.1:3001}"
USERNAME="${POS_SMOKE_USERNAME:-}"
PASSWORD="${POS_SMOKE_PASSWORD:-}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" /tmp/pos-smoke-* 2>/dev/null || true' EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

code="$(curl --silent --show-error --output /tmp/pos-smoke-root.html --write-out '%{http_code}' "$BASE_URL/")"
[[ "$code" == "200" ]] || fail "root shell returned HTTP $code"
grep -qi '<html' /tmp/pos-smoke-root.html || fail "root response does not look like HTML"
pass "public application shell responds"

# A protected API must remain protected before authentication.
code="$(curl --silent --show-error --output /tmp/pos-smoke-protected.json --write-out '%{http_code}' "$BASE_URL/api/products")"
case "$code" in
  401|403) pass "protected API rejects anonymous access" ;;
  *) fail "protected API unexpectedly returned HTTP $code before login" ;;
esac

if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
  echo "AUTH_SMOKE=skipped"
  echo "Set POS_SMOKE_USERNAME and POS_SMOKE_PASSWORD for authenticated cutover smoke checks."
  exit 0
fi

login_code="$(curl --silent --show-error \
  --cookie-jar "$COOKIE_JAR" \
  --cookie "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  --data "$(printf '{\"username\":\"%s\",\"password\":\"%s\"}' "$USERNAME" "$PASSWORD")" \
  --output /tmp/pos-smoke-login.json \
  --write-out '%{http_code}' \
  "$BASE_URL/api/employees/login")"
[[ "$login_code" == "200" ]] || { cat /tmp/pos-smoke-login.json >&2 || true; fail "smoke employee login returned HTTP $login_code"; }
pass "smoke employee authenticated successfully"

check_endpoint() {
  local name="$1" path="$2"
  local status
  status="$(curl --silent --show-error --cookie "$COOKIE_JAR" --output "/tmp/pos-smoke-${name}.json" --write-out '%{http_code}' "$BASE_URL$path")"
  case "$status" in
    200) pass "$name workspace/API read succeeded" ;;
    403) echo "SKIP: $name is not authorized for the designated smoke employee" ;;
    *) cat "/tmp/pos-smoke-${name}.json" >&2 || true; fail "$name returned unexpected HTTP $status" ;;
  esac
}

check_endpoint products /api/products
check_endpoint branches /api/branches
check_endpoint workspace /api/workspace-profile
check_endpoint operations /api/operational-reports
check_endpoint purchasing /api/purchase-orders
check_endpoint rentals /api/rentals
check_endpoint repairs /api/work-orders
check_endpoint dispatch /api/logistics-intelligence
check_endpoint accounting /api/accounting-intelligence

printf '\nSmoke checks complete. This script performs reads only and creates no financial transactions.\n'
