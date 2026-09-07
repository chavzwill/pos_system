#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail(){ echo "NO-GO: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }
run(){ local label="$1"; shift; echo; echo "=== $label ==="; "$@" || fail "$label failed"; }

[[ "${CUTOVER_CONFIRM:-}" == "VERIFY_ONLY" ]] || fail "set CUTOVER_CONFIRM=VERIFY_ONLY. This script verifies readiness only; it does not deploy or mutate production data."

run "Production preflight" bash scripts/production-preflight.sh
run "Native production certification contract" node scripts/check-pos-production-certification.js
run "Native runtime ownership contract" node scripts/check-native-pos-runtime.js
run "Recovery contract" node scripts/check-production-recovery-contract.js
run "Observability/cutover contract" node scripts/check-production-observability-contract.js
run "Production host verification" bash scripts/production-host-verify.sh
run "Read-only production smoke" bash scripts/production-smoke.sh

if [[ -n "${POS_CUTOVER_BACKUP_ARCHIVE:-}" ]]; then
  run "Backup restore rehearsal" bash scripts/production-recovery-rehearsal.sh "$POS_CUTOVER_BACKUP_ARCHIVE"
else
  echo "WARN: POS_CUTOVER_BACKUP_ARCHIVE is not set; backup restore rehearsal was not executed in this invocation."
  echo "      Final production approval must not be granted until a release-adjacent backup has passed rehearsal."
fi

if [[ -n "${POS_EXPECTED_RELEASE_SHA:-}" ]]; then
  actual_sha="$(git rev-parse HEAD)"
  [[ "$actual_sha" == "$POS_EXPECTED_RELEASE_SHA" ]] || fail "release SHA mismatch: expected $POS_EXPECTED_RELEASE_SHA, found $actual_sha"
  pass "release candidate SHA matches $actual_sha"
else
  echo "WARN: POS_EXPECTED_RELEASE_SHA is not set; exact release-candidate pinning was not verified."
fi

cat <<'EOF'

GO/NO-GO RESULT: TECHNICAL VERIFICATION PASSED

This script does not approve deployment by itself. Final GO still requires:
- exact release candidate SHA recorded
- release-adjacent backup and isolated restore rehearsal passed
- rollback owner and rollback command/path identified
- maintenance/change window approved
- designated employee acceptance tester available
- no unresolved severity-1 or severity-2 production blocker

No deployment, package installation, database mutation, or paid service was triggered by this gate.
EOF
