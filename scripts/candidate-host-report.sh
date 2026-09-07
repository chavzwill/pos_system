#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSESS_SCRIPT="$ROOT_DIR/scripts/candidate-host-assessment.sh"
REPORT_PATH="${1:-$ROOT_DIR/candidate-host-assessment-report.txt}"

if [ ! -x "$ASSESS_SCRIPT" ]; then
  echo "FAIL: $ASSESS_SCRIPT is missing or not executable" >&2
  exit 1
fi

{
  echo "Total Tools POS — Candidate Host Assessment Report"
  echo "Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo "Hostname: $(hostname 2>/dev/null || echo unknown)"
  echo "Kernel: $(uname -srmo 2>/dev/null || uname -a)"
  echo ""
  echo "--- Assessment ---"
  set +e
  "$ASSESS_SCRIPT"
  assessment_status=$?
  set -e
  echo ""
  echo "Assessment exit code: $assessment_status"
} | tee "$REPORT_PATH"

printf '\nReport written to: %s\n' "$REPORT_PATH"

exit "$assessment_status"
