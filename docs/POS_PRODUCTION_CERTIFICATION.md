# POS Production Certification

This document defines what **production-ready** means for the native Total Tools POS. A module is not complete merely because code exists or its UI renders.

## Release rule

The POS may only be promoted after all required gates are green on the exact release candidate commit.

### Gate 1 — Native runtime ownership

- Frontend is served by the POS repository.
- Native server is the POS Express application.
- Browser API calls use the same-origin `/api` boundary.
- SmartCommerce, SellSync, or another commerce runtime must not be required for POS boot or correctness.
- `node scripts/check-native-pos-runtime.js` passes.

### Gate 2 — Operational shell and responsive runtime

- Operations shell renders without console/page/request failures.
- Role-aware navigation is correct.
- Sales, Repairs, Rentals, Dispatch, Inventory, Purchasing, Finance, CRM, and Administration load through the hardened workspace loader.
- Desktop and mobile breakpoints are manually smoke-tested.

### Gate 3 — Multi-branch and authorization

- Cross-branch sales are rejected for branch-scoped employees.
- `branch_id` is an authorization boundary, not just a frontend filter. A branch-scoped employee cannot alter `?branch_id=` to inspect another branch's stock, repair queue, rentals, purchase orders, or purchase requests.
- Numeric detail IDs for transactions, work orders, rentals, purchase orders, purchase requests, and inventory writeoffs are checked against the authoritative record branch before the record is returned.
- Branch-scoped stock, purchasing, repairs, rentals, dispatch, drawers, and finance are verified.
- Cross-branch visibility is reserved for explicitly authorized branch/security administrators.
- Dispatch view/plan/execute/admin permissions remain independent.
- Security-group assignment cannot escalate privileges beyond the actor's authority envelope.
- Anonymous access is rejected before business logic executes.

### Gate 4 — Retail / checkout

- Cash sale reduces branch inventory exactly once.
- Returns restore eligible inventory exactly once.
- Refund settlement matches the original/refund tender evidence.
- Drawer net movement, close, and reconciliation remain coherent.
- Split tender, held sales, promotions, UOM, margin protections, and duplicate/retry controls pass their existing suites.

### Gate 5 — Purchasing and supplier logistics

- PR -> approval -> PO -> receiving remains authoritative.
- Supplier pickup can be forwarded to unified Dispatch only from eligible PO states.
- Supplier identity, address, contacts, items, receiving branch, and immutable commercial snapshot are preserved in the dispatch handoff.
- Purchasing financial runtime certification reconciles operational evidence to accounting.

### Gate 6 — Rentals

- Reservation/issue/active/return/settlement lifecycle passes.
- Serialized/asset-tracked rental units cannot be double-issued.
- Missing/lost assets are not silently treated as normal returns.
- Delivery and return pickup handoffs are represented in unified Dispatch.
- Deposit, fee, damage/loss, refund, and accounting evidence reconcile.

### Gate 7 — Repairs

- Intake -> diagnosis -> estimate/authorization -> technician execution -> QC -> payment -> pickup/delivery passes.
- Technician attribution and QC evidence are authoritative.
- Comeback/rework evidence is preserved.
- Parts consumption and service financial evidence reconcile to accounting.

### Gate 8 — Dispatch & logistics

Unified Dispatch must cover:

- customer sales delivery
- supplier PO pickup
- rental delivery
- rental return pickup
- repair pickup
- repair return
- branch transfer

Dispatch permissions must remain separated from purchasing approval, refunds, finance, and other source-module authority.

### Gate 9 — Accounting

- Retail, purchasing, rentals, repairs, returns/refunds, settlements, and supplier payments produce traceable financial evidence.
- Automatic source journals are atomic: the posted journal header, every journal line, and the posting event succeed together or roll back together.
- Replaying an already-posted source verifies that the existing journal still matches authoritative source evidence rather than silently duplicating it.
- Trial balance includes **posted, in-period** journal evidence only. Draft journals and future-dated posted journals must not leak into current balances.
- Posted journals are immutable and corrected through reversal rather than silent editing.
- Accounting posting authority is separate from ordinary reporting authority.
- Trial balance remains balanced globally and by branch where applicable.
- Reconciliation exceptions fail visibly rather than inventing missing evidence.
- `tests/accounting-ledger-integrity.spec.js` proves draft exclusion, period cutoff, posting effect, balanced totals, and reversal restoration.

### Gate 10 — Failure, retry, duplicate-submission, and concurrency safety

- Mutating native POS requests carry an `Idempotency-Key`.
- Native sale creation and rental-agreement creation require request identity; they fail closed if the key is missing.
- The server binds that key to the authenticated actor, HTTP method, route, query, and request body fingerprint.
- Repeating the same committed request with the same key replays the stored result and does not execute the business mutation again.
- Reusing a key with a different payload fails closed with `409`.
- A second request using the same key while the first is unresolved is blocked as `operation_idempotency_in_progress`.
- Distinct idempotency keys do **not** bypass lifecycle safety. Resource-level leases serialize conflicting mutations against the same authoritative PO, rental agreement, work order, sales return, branch transfer, or Dispatch source.
- PO receiving, rental checkout/issue/return/settlement, repair financial completion, transaction returns, transfer receiving, and commercial Dispatch handoffs use durable resource keys.
- Lifecycle locks are database-backed, unique per resource, and expire automatically after a short lease so a crashed process cannot leave a permanent deadlock.
- Concurrent ownership failure returns a visible `lifecycle_concurrency` conflict with `Retry-After`; callers must refresh authoritative state before retrying.
- If the connection drops after the server commits but before the browser receives the response, the native frontend retries transport once with the **same** idempotency key.
- The global native runtime protects older workspaces that still call `window.fetch` directly; POS_API callers use the same contract.
- An idempotency receipt that cannot be persisted is treated as an ambiguous outcome. Operators must verify the business record before attempting a new key.
- `tests/operation-idempotency.spec.js` proves stored response replay and request-fingerprint mismatch rejection.
- `tests/lifecycle-concurrency.spec.js` proves only one concurrent owner can hold a protected business lifecycle resource and that release permits the next owner.

This gate applies to checkout, returns/refunds, PO receiving, rental checkout/return, repair completion/payment, inventory-linked transfers, and Dispatch handoffs.

### Gate 11 — Recovery and production operations

The production state is the database **and** uploaded operational evidence. Recovery must keep those together.

- `scripts/production-backup.sh` refuses to back up while the application container is still accepting writes.
- Backup archives contain `data/` and `uploads/` together, exclude source/secrets, carry the release commit SHA in the manifest, and are SHA-256 verified after creation.
- `scripts/production-restore.sh` requires an explicit destructive-restore acknowledgement, validates the archive checksum and contents, makes a pre-restore safety copy, and automatically puts that original state back if extraction/validation fails.
- `scripts/production-recovery-rehearsal.sh` restores only into a temporary directory. It never replaces live state. It performs SQLite `quick_check`, full `integrity_check`, critical-table verification, and read-only database access checks.
- `scripts/production-smoke.sh` is read-only and verifies the application shell, anonymous API protection, employee authentication when smoke credentials are supplied, and representative Inventory, Purchasing, Rentals, Repairs, Dispatch and Accounting reads.
- `node scripts/check-production-recovery-contract.js` must pass on the exact release candidate.
- A real backup must complete the non-destructive recovery rehearsal before launch. Static existence of recovery scripts is not proof of recoverability.
- Migration/schema initialization must be exercised against a restored production-like copy before production is upgraded.
- Rollback requires both the previous application release and the verified pre-change state backup; neither code rollback nor data rollback alone is sufficient after an incompatible migration.
- Operational logs must preserve request IDs and expose startup/database initialization failures instead of serving a partially initialized POS.

For a verified backup archive, rehearse recovery without touching live data:

```bash
scripts/production-recovery-rehearsal.sh /absolute/path/to/pos-state-....tar.gz
```

Or bind it into the full certification runner:

```bash
POS_RECOVERY_REHEARSAL_ARCHIVE=/absolute/path/to/pos-state-....tar.gz \
  node scripts/run-pos-production-certification.js
```

The rehearsal requires existing `tar`, `sha256sum`, and `sqlite3` tools and will not install them automatically.

## Required automated evidence

The certification bundle includes at minimum:

- `scripts/check-native-pos-runtime.js`
- `scripts/check-pos-production-certification.js`
- `scripts/check-production-recovery-contract.js`
- `scripts/run-pos-production-certification.js`
- `scripts/production-backup.sh`
- `scripts/production-restore.sh`
- `scripts/production-recovery-rehearsal.sh`
- `scripts/production-smoke.sh`
- `tests/native-pos-certification.spec.js`
- `tests/operations-acceptance.spec.js`
- `tests/business-integrity.spec.js`
- `tests/security-boundaries.spec.js`
- `tests/multi-branch-read-integrity.spec.js`
- `tests/operation-idempotency.spec.js`
- `tests/lifecycle-concurrency.spec.js`
- `tests/pos-financial-runtime.js`
- `tests/accounting-ledger-integrity.spec.js`
- `tests/accounting-source-sync-rbac.spec.js`
- `tests/logistics-intelligence.spec.js`
- `tests/rentals-integrity.spec.js`
- `tests/repair-quality-integrity.spec.js`

The static certification contract confirms the required production evidence exists. Runtime suites and a real recovery rehearsal still have to be executed against the release candidate; static presence is not a substitute for runtime proof.

For a local checkout with the repository-approved dependencies already installed, run:

```bash
node scripts/run-pos-production-certification.js
```

The runner deliberately does **not** install packages, download dependencies, deploy, or invoke paid services. If Playwright is not already installed in the checkout it stops and reports the prerequisite instead of silently using `npx` to fetch anything.

The multi-branch runtime test is intentionally environment-bound. Set `POS_BRANCH_TEST_USER`, `POS_BRANCH_TEST_PASSWORD`, `POS_BRANCH_TEST_OWN_BRANCH`, and `POS_BRANCH_TEST_OTHER_BRANCH` to a branch-scoped test identity and two distinct active branch IDs. If those values are absent, that runtime test skips rather than pretending cross-branch certification occurred.

## Completion definition

A roadmap item can move to **Completed** only after:

Implementation -> Integration -> Permission boundary -> Multi-branch behavior -> Financial impact -> Failure/retry behavior -> Concurrency behavior -> Automated runtime test -> Responsive QA -> Backup/recovery rehearsal -> Production certification.
