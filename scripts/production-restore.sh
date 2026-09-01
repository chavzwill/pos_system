#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || { echo "Usage: RESTORE_CONFIRM=RESTORE <script> /absolute/path/to/pos-state-....tar.gz" >&2; exit 2; }
[[ "$ARCHIVE" = /* ]] || ARCHIVE="$ROOT_DIR/$ARCHIVE"
CHECKSUM="$ARCHIVE.sha256"

fail() { echo "ERROR: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[[ "${RESTORE_CONFIRM:-}" == "RESTORE" ]] || fail "set RESTORE_CONFIRM=RESTORE to acknowledge destructive restore"
[[ -f "$ARCHIVE" ]] || fail "backup archive not found: $ARCHIVE"
[[ -f "$CHECKSUM" ]] || fail "checksum file not found: $CHECKSUM"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

container_id="$(docker compose ps -q app 2>/dev/null || true)"
if [[ -n "$container_id" ]]; then
  running="$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null || echo false)"
  [[ "$running" != "true" ]] || fail "application container is running; stop it before restore"
fi

(
  cd "$(dirname "$ARCHIVE")"
  sha256sum -c "$(basename "$CHECKSUM")"
) >/dev/null
pass "backup checksum verified"

contents="$(tar -tzf "$ARCHIVE")"
if echo "$contents" | grep -Eq '(^|/)\.env$|(^|/)\.git(/|$)|(^|/)node_modules(/|$)'; then
  fail "archive contains forbidden source/secrets content"
fi
if ! echo "$contents" | grep -q '^data/'; then fail "archive does not contain data/"; fi
if ! echo "$contents" | grep -q '^uploads/'; then fail "archive does not contain uploads/"; fi
if ! echo "$contents" | grep -q '^data/pos.db$'; then fail "archive does not contain data/pos.db"; fi

safety_dir="$ROOT_DIR/.restore-safety-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$safety_dir"
[[ ! -e data ]] || mv data "$safety_dir/data"
[[ ! -e uploads ]] || mv uploads "$safety_dir/uploads"

restore_failed=0
if ! tar -xzf "$ARCHIVE" -C "$ROOT_DIR"; then
  restore_failed=1
fi

if (( restore_failed != 0 )) || [[ ! -s data/pos.db ]] || [[ ! -d uploads ]]; then
  rm -rf data uploads
  [[ ! -e "$safety_dir/data" ]] || mv "$safety_dir/data" data
  [[ ! -e "$safety_dir/uploads" ]] || mv "$safety_dir/uploads" uploads
  fail "restore failed validation; original pre-restore state was put back"
fi

pass "persisted state restored from $ARCHIVE"
echo "SAFETY_COPY=$safety_dir"
echo "Do not delete the safety copy until the restored release has passed health and employee acceptance checks."
