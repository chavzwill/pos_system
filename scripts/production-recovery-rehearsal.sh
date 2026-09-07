#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || { echo "Usage: scripts/production-recovery-rehearsal.sh /absolute/path/to/pos-state-....tar.gz" >&2; exit 2; }
[[ "$ARCHIVE" = /* ]] || ARCHIVE="$ROOT_DIR/$ARCHIVE"
CHECKSUM="$ARCHIVE.sha256"

fail(){ echo "ERROR: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

[[ -f "$ARCHIVE" ]] || fail "backup archive not found: $ARCHIVE"
[[ -f "$CHECKSUM" ]] || fail "checksum file not found: $CHECKSUM"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required for recovery rehearsal; this script will not install it"

(
  cd "$(dirname "$ARCHIVE")"
  sha256sum -c "$(basename "$CHECKSUM")"
) >/dev/null
pass "backup checksum verified"

contents="$(tar -tzf "$ARCHIVE")"
if echo "$contents" | grep -Eq '(^|/)\.env$|(^|/)\.git(/|$)|(^|/)node_modules(/|$)'; then
  fail "archive contains forbidden source/secrets content"
fi
for required in '^data/$' '^data/pos.db$' '^uploads/$'; do
  echo "$contents" | grep -q "$required" || fail "archive missing required persisted state matching $required"
done

rehearsal_dir="$(mktemp -d "${TMPDIR:-/tmp}/pos-recovery-rehearsal.XXXXXX")"
trap 'rm -rf "$rehearsal_dir"' EXIT

tar -xzf "$ARCHIVE" -C "$rehearsal_dir"
DB="$rehearsal_dir/data/pos.db"
[[ -s "$DB" ]] || fail "restored rehearsal database is missing or empty"
[[ -d "$rehearsal_dir/uploads" ]] || fail "restored rehearsal uploads directory is missing"

quick="$(sqlite3 "$DB" 'PRAGMA quick_check;' 2>&1)"
[[ "$quick" == "ok" ]] || fail "SQLite quick_check failed: $quick"
pass "SQLite quick_check passed"

integrity="$(sqlite3 "$DB" 'PRAGMA integrity_check;' 2>&1)"
[[ "$integrity" == "ok" ]] || fail "SQLite integrity_check failed: $integrity"
pass "SQLite integrity_check passed"

critical_tables=(branches employees products transactions purchase_orders rental_agreements work_orders settings)
for table in "${critical_tables[@]}"; do
  exists="$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table';")"
  [[ "$exists" == "1" ]] || fail "critical table missing after restore rehearsal: $table"
done
pass "critical POS schema is present in restored copy"

# Validate that the restored database is actually readable without mutating it.
sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM branches; SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM transactions;" >/dev/null
pass "restored POS database is readable in read-only mode"

printf '\nRECOVERY_REHEARSAL=passed\nREHEARSAL_SOURCE=%s\n' "$ARCHIVE"
printf 'The rehearsal extracted and validated a temporary copy only; live data was not modified.\n'
