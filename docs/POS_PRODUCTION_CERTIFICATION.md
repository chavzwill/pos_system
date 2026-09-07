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
- Branch-scoped stock, purchasing, repairs, rentals, dispatch, drawers, and finance are verified.
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
- Posted journals are immutable and corrected through reversal rather than silent editing.
- Accounting posting authority is separate from ordinary reporting authority.
- Trial balance remains balanced.
- Reconciliation exceptions fail visibly rather than inventing missing evidence.

### Gate 10 — Recovery and production operations

Before launch:

- backup is created and restored successfully in a rehearsal
- migrations are rehearsed against a production-like copy
- rollback path is documented and exercised
- error/queue/job observability is available
- production smoke test passes after deployment

## Required automated evidence

The certification bundle includes at minimum:

- `scripts/check-native-pos-runtime.js`
- `scripts/check-pos-production-certification.js`
- `tests/native-pos-certification.spec.js`
- `tests/operations-acceptance.spec.js`
- `tests/business-integrity.spec.js`
- `tests/security-boundaries.spec.js`
- `tests/pos-financial-runtime.js`
- `tests/accounting-source-sync-rbac.spec.js`
- `tests/logistics-intelligence.spec.js`
- `tests/rentals-integrity.spec.js`
- `tests/repair-quality-integrity.spec.js`

The static certification contract confirms the required production evidence exists. Runtime suites still have to be executed against the release candidate; static presence is not a substitute for runtime proof.

## Completion definition

A roadmap item can move to **Completed** only after:

Implementation -> Integration -> Permission boundary -> Multi-branch behavior -> Financial impact -> Failure/retry behavior -> Automated runtime test -> Responsive QA -> Production certification.
