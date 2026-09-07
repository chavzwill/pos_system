#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail(){ echo "NO-GO: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }
run(){ local label="$1"; shift; echo; echo "=== $label ==="; "$@" || fail "$label failed"; }

[[ "${CUTOVER_CONFIRM:-}" == "VERIFY_ONLY" ]] || fail "set CUTOVER_CONFIRM=VERIFY_ONLY. This script verifies readiness only; it does not deploy or mutate production data."

# Final cutover verification fails closed. These values are evidence, not
# optional conveniences: without them we cannot prove which release is being
# approved, that its state is recoverable, or that a known-good code rollback
# actually exists.
[[ -n "${POS_EXPECTED_RELEASE_SHA:-}" ]] || fail "POS_EXPECTED_RELEASE_SHA is required for final cutover verification"
[[ -n "${POS_CUTOVER_BACKUP_ARCHIVE:-}" ]] || fail "POS_CUTOVER_BACKUP_ARCHIVE is required for final cutover verification"
[[ -n "${POS_ROLLBACK_REF:-}" ]] || fail "POS_ROLLBACK_REF is required and must identify the last known-good commit/tag"
[[ -n "${POS_SMOKE_USERNAME:-}" ]] || fail "POS_SMOKE_USERNAME is required so authenticated employee smoke cannot be skipped"
[[ -n "${POS_SMOKE_PASSWORD:-}" ]] || fail "POS_SMOKE_PASSWORD is required so authenticated employee smoke cannot be skipped"

[[ -f "$POS_CUTOVER_BACKUP_ARCHIVE" ]] || fail "cutover backup archive not found: $POS_CUTOVER_BACKUP_ARCHIVE"
[[ -f "$POS_CUTOVER_BACKUP_ARCHIVE.sha256" ]] || fail "cutover backup checksum not found: $POS_CUTOVER_BACKUP_ARCHIVE.sha256"

git rev-parse --verify "${POS_ROLLBACK_REF}^{commit}" >/dev/null 2>&1 || fail "POS_ROLLBACK_REF does not resolve to a commit: $POS_ROLLBACK_REF"
rollback_sha="$(git rev-parse "${POS_ROLLBACK_REF}^{commit}")"
actual_sha="$(git rev-parse HEAD)"
[[ "$actual_sha" == "$POS_EXPECTED_RELEASE_SHA" ]] || fail "release SHA mismatch: expected $POS_EXPECTED_RELEASE_SHA, found $actual_sha"
[[ "$rollback_sha" != "$actual_sha" ]] || fail "rollback ref resolves to the same commit as the release candidate; provide a distinct last known-good release"
pass "release candidate SHA matches $actual_sha"
pass "rollback ref $POS_ROLLBACK_REF resolves to $rollback_sha"

run "Production preflight" bash scripts/production-preflight.sh
run "Native production certification contract" node scripts/check-pos-production-certification.js
run "Native runtime ownership contract" node scripts/check-native-pos-runtime.js
run "Recovery contract" node scripts/check-production-recovery-contract.js
run "Observability/cutover contract" node scripts/check-production-observability-contract.js
run "Production host verification" bash scripts/production-host-verify.sh
run "Authenticated read-only production smoke" bash scripts/production-smoke.sh
run "Backup restore rehearsal" bash scripts/production-recovery-rehearsal.sh "$POS_CUTOVER_BACKUP_ARCHIVE"

backup_checksum="$(awk '{print $1}' "$POS_CUTOVER_BACKUP_ARCHIVE.sha256" | head -n1)"
[[ -n "$backup_checksum" ]] || fail "unable to read backup checksum evidence"

cat <<EOF

GO/NO-GO RESULT: TECHNICAL VERIFICATION PASSED

Release candidate: $actual_sha
Rollback commit:   $rollback_sha
Backup archive:    $POS_CUTOVER_BACKUP_ARCHIVE
Backup checksum:   $backup_checksum

This script does not deploy the POS. Final operational GO still requires:
- maintenance/change window approval
- designated rollback owner present
- employee acceptance tester available during promotion
- no unresolved severity-1 or severity-2 production blocker
- release-specific data rollback instructions when schema compatibility changes

No deployment, package installation, production business mutation, or paid service was triggered by this gate.
EOF
