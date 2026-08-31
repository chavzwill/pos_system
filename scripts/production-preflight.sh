#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "ERROR: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
warn() { echo "WARN: $*" >&2; }

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is not available"
command -v tar >/dev/null 2>&1 || fail "tar is not installed"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
pass "required host commands are available"

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable"
pass "Docker daemon is reachable"

[[ -f docker-compose.yml ]] || fail "docker-compose.yml is missing"
[[ -f Dockerfile ]] || fail "Dockerfile is missing"
[[ -f docker-entrypoint.sh ]] || fail "docker-entrypoint.sh is missing"
pass "production container files are present"

mkdir -p data uploads
[[ -w data ]] || fail "data/ is not writable by the deployment operator"
[[ -w uploads ]] || fail "uploads/ is not writable by the deployment operator"
pass "persistent host directories exist and are writable"

if [[ -f .env ]]; then
  mode="$(stat -c '%a' .env 2>/dev/null || true)"
  [[ -n "$mode" ]] && pass ".env exists with mode $mode"
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    fail ".env is tracked by Git; remove secrets from version control before deployment"
  fi
else
  warn ".env is absent; this is valid for local SQLite if no other production secrets/settings are required"
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  sha="$(git rev-parse HEAD)"
  echo "CODE_SHA=$sha"
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    fail "tracked working tree changes exist; deploy an exact clean commit"
  fi
  pass "Git working tree is clean at $sha"
else
  warn "deployment directory is not a Git worktree; record the image/source SHA manually"
fi

free_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] || fail "unable to determine free disk space"
if (( free_kb < 1048576 )); then
  fail "less than 1 GiB free on deployment filesystem"
fi
pass "deployment filesystem has at least 1 GiB free"

if [[ -s data/pos.db ]]; then
  db_size="$(du -h data/pos.db | awk '{print $1}')"
  pass "existing SQLite database found ($db_size)"
else
  warn "data/pos.db does not yet exist; expected only for a first deployment"
fi

container_id="$(docker compose ps -q app 2>/dev/null || true)"
if [[ -n "$container_id" ]]; then
  state="$(docker inspect -f '{{.State.Status}}' "$container_id")"
  echo "APP_CONTAINER_STATE=$state"
  if [[ "$state" == "running" ]]; then
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    echo "APP_CONTAINER_HEALTH=$health"
  fi
else
  echo "APP_CONTAINER_STATE=not-created"
fi

printf '\nPreflight complete. No application or persisted data was modified.\n'
