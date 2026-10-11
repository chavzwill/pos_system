# Authoritative UI final verification

Verified on 2026-09-25 against PR #92 head `6c2a4b51a11488ac2ba505d5e33d5f5db93a8608` plus the final verification fixes in this commit.

Integration target: `feature/unified-backoffice-ui-converged`. The target is an ancestor of the verified UI branch. No main-branch merge or production deployment is included.

## Changes found during verification

- Restored the People landing action so authorized staff can reach the existing staff-management workspace.
- Updated System Health to count the current primary and additional actions instead of obsolete shell cards.
- Removed conflicting identity decorations that overflowed the sidebar, corrected duplicated phone search text, and kept the mobile Guide control readable.
- Restored the rental warning that missing equipment must not be processed as a normal return.
- Updated quote/rental contracts and browser selectors for the current labels, disclosures, and responsive breakpoint while retaining the underlying behavior checks.
- Added permanent seven-width shell, keyboard-focus, and workspace-layout regression tests; updated Guide Me tests to exercise the active shell.

## Results

- `npm run check:syntax`: exit 0. Includes authoritative UI, client syntax, logistics, repair lifecycle, accounting integrity, RBAC/security, inventory, purchasing, rental, and server syntax contracts.
- Combined release-gate browser/runtime selection plus shell UI and Guide Me tests: **81 passed, 0 failed, 1 skipped**; runner exit 0 in approximately 2.5 minutes.
- Responsive widths: **1440, 1280, 1024, 768, 430, 390, 375**.
- At every width: shell overflow, Quick Command Tab/Shift+Tab containment and Escape/focus return, labelled shared input dialogs, cancel/submit behavior, viewport fit, and focus restoration passed.
- Ten workspace families opened without browser script errors or horizontal document overflow at every width: Sales, Inventory, Purchasing, Rentals, Quotes, Work Orders, Customers, Administration, Dispatch, and Accounting Ledger.
- Guide Me asset loading, natural-language task selection, Escape close, and opener-focus restoration passed.
- Runtime checks passed for sales/refunds/cash custody, purchasing/receiving, rental checkout/return, repair lifecycle/QC/release/accounting, dispatch custody/completion, authorization boundaries, reports, and intelligence services.
- Separate exploratory responsive run: **91 checks passed**. Desktop and phone screenshots were inspected; the shell branding/search defects found visually were corrected and retested.
- `git diff --check`: passed.

## Scope and reproducibility

Tests ran in a separate checkout using an isolated local SQLite database initialized with `node scripts/ci-runtime-bootstrap.js`, test-only credentials, installed Chromium, one Playwright worker, and `http://localhost:3001`. A Windows-local Playwright configuration replaced the repository's pre-existing Linux-specific browser launch settings. No production credentials or business database were used.

The combined run selected the spec files in `test:release-gate`, plus `tests/shell-ui-verification.spec.js` and `tests/guided-mode.spec.js`.

One existing repair-readiness test skipped because the fresh disposable dataset contained no work order awaiting QC. The independent end-to-end repair lifecycle certification passed. This record does not claim all repository tests, all role/data combinations, or production deployment certification.

An earlier concurrent-server run caused SQLite lock errors. Those results were discarded; the final passing run used one server and a freshly initialized disposable database. The fresh database also exposed a pre-existing repair-notification worker warning before that module initializes its table; notification delivery is outside this UI qualification.
