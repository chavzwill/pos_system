#!/usr/bin/env bash
set -euo pipefail

failures=0
warnings=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
  warnings=$((warnings + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

require_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "command available: $command_name"
  else
    fail "required command missing: $command_name"
  fi
}

if [ "$(uname -s)" = "Linux" ]; then
  pass "Linux host detected"
else
  fail "production host must be Linux"
fi

require_command docker
require_command curl
require_command awk
require_command df

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "Docker daemon reachable"
  else
    fail "Docker is installed but the daemon is not reachable by the current operator"
  fi

  if docker compose version >/dev/null 2>&1; then
    pass "Docker Compose plugin available"
  else
    fail "Docker Compose plugin is unavailable"
  fi
fi

mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
if [ -n "$mem_kb" ]; then
  mem_mb=$((mem_kb / 1024))
  if [ "$mem_mb" -ge 3500 ]; then
    pass "memory capacity is at least approximately 4 GB (${mem_mb} MB detected)"
  else
    warn "less than approximately 4 GB RAM detected (${mem_mb} MB); certified host profile recommends 4 GB or more"
  fi
fi

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')"
if [ "$cpu_count" -ge 2 ] 2>/dev/null; then
  pass "at least 2 logical CPUs available ($cpu_count detected)"
else
  warn "fewer than 2 logical CPUs detected; certified host profile recommends at least 2 vCPU"
fi

available_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
if [ -n "$available_kb" ]; then
  available_gb=$((available_kb / 1024 / 1024))
  if [ "$available_gb" -ge 20 ]; then
    pass "working filesystem has at least 20 GB free (${available_gb} GB detected)"
  else
    fail "working filesystem has less than 20 GB free (${available_gb} GB detected)"
  fi
fi

for directory in data uploads; do
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then
    fail "$directory exists but is not a directory"
    continue
  fi
  if [ ! -d "$directory" ]; then
    mkdir -p "$directory"
  fi
  if [ -w "$directory" ]; then
    pass "$directory is writable"
  else
    fail "$directory is not writable"
  fi
done

if [ ! -f .env ]; then
  fail ".env is missing; copy .env.production.example to .env and set production values"
else
  pass ".env exists"
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a

  if [ -z "${POS_DOMAIN:-}" ]; then
    fail "POS_DOMAIN is missing from .env"
  elif [[ "$POS_DOMAIN" == http://localhost* ]] || [[ "$POS_DOMAIN" == https://localhost* ]]; then
    fail "POS_DOMAIN still points at localhost; a real production hostname is required"
  elif [[ "$POS_DOMAIN" != https://* ]] && [[ "$POS_DOMAIN" != http://* ]]; then
    fail "POS_DOMAIN must include an http:// or https:// scheme for the certified Caddy profile"
  else
    pass "POS_DOMAIN is configured"
  fi

  if [ -n "${TURSO_DATABASE_URL:-}" ] && [[ "$TURSO_DATABASE_URL" != file:* ]]; then
    warn "remote TURSO_DATABASE_URL detected; RC6 was certified for the local SQLite host profile"
  fi
fi

if [ -d .git ]; then
  current_sha="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "${EXPECTED_RELEASE_SHA:-}" ]; then
    if [ "$current_sha" = "$EXPECTED_RELEASE_SHA" ]; then
      pass "checkout matches EXPECTED_RELEASE_SHA"
    else
      fail "checkout SHA $current_sha does not match EXPECTED_RELEASE_SHA $EXPECTED_RELEASE_SHA"
    fi
  else
    warn "EXPECTED_RELEASE_SHA is not set; exact release-SHA verification was skipped"
  fi
fi

if [ -f docker-compose.yml ] && [ -f docker-compose.host.yml ]; then
  if [ -n "${POS_DOMAIN:-}" ] && docker compose -f docker-compose.yml -f docker-compose.host.yml config >/dev/null 2>&1; then
    pass "combined production Compose configuration validates"
  else
    fail "combined production Compose configuration did not validate"
  fi
else
  fail "docker-compose.yml and docker-compose.host.yml must both be present"
fi

printf '\nHost readiness summary: %d failure(s), %d warning(s).\n' "$failures" "$warnings"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
