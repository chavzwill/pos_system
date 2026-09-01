#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CODE_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
ARCHIVE_NAME="pos-state-${TIMESTAMP}-${CODE_SHA:0:12}.tar.gz"
ARCHIVE_PATH="$BACKUP_ROOT/$ARCHIVE_NAME"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"
MANIFEST_PATH="$BACKUP_ROOT/${ARCHIVE_NAME%.tar.gz}.manifest.txt"

fail() { echo "ERROR: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

container_id="$(docker compose ps -q app 2>/dev/null || true)"
if [[ -n "$container_id" ]]; then
  running="$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null || echo false)"
  [[ "$running" != "true" ]] || fail "application container is still running; stop employee writes and run 'docker compose stop app' before backup"
fi

[[ -d data ]] || fail "data/ directory is missing"
[[ -d uploads ]] || fail "uploads/ directory is missing"
[[ -s data/pos.db ]] || fail "data/pos.db is missing or empty; refusing to create an incomplete release backup"

mkdir -p "$BACKUP_ROOT"

cat > "$MANIFEST_PATH" <<EOF
backup_timestamp_utc=$TIMESTAMP
code_sha=$CODE_SHA
source_root=$ROOT_DIR
includes=data uploads
secrets_included=no
EOF

# .env and source code are deliberately excluded. Persisted operational state is
# archived together so database records and uploaded evidence cannot drift apart.
tar -czf "$ARCHIVE_PATH" data uploads
sha256sum "$ARCHIVE_PATH" > "$CHECKSUM_PATH"
sha256sum -c "$CHECKSUM_PATH" >/dev/null

pass "backup archive created: $ARCHIVE_PATH"
pass "checksum verified: $CHECKSUM_PATH"
pass "manifest created: $MANIFEST_PATH"
printf '\nBACKUP_ARCHIVE=%s\nBACKUP_CHECKSUM=%s\nBACKUP_MANIFEST=%s\n' "$ARCHIVE_PATH" "$CHECKSUM_PATH" "$MANIFEST_PATH"
