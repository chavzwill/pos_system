# Atomic Inventory Write-Off Approval Design

## Status
Approved architecture, pending implementation-plan gate.

## Baseline
- Repository: `chavzwill/pos_system`
- Canonical branch: `integration/pos-consolidated-2026-09-07`
- Certified baseline: `32aa3b10801544ee9fb504b5656601a383a32cd1`
- Certification run: `34880192892`

## Problem
High-value inventory write-off approval currently spans multiple commits.
The core approval route commits stock reduction, valuation, accounting, and `status='approved'` first.
Independent financial-approval evidence is then inserted by middleware after the successful response path.
Serial/lot identity finalization also happens after the core approval commit.

This allows a destructive write-off to be approved while required control evidence or identity state remains incomplete if a later step fails.
The affected middleware also returns raw exception messages in some failure paths, which violates staff-safe error handling.

## Safety Invariant
A write-off approval is one indivisible business transaction.
Either every authoritative effect commits, or none of them does.

A successful approval must atomically include, when applicable:
- permission and separation-of-duty validation;
- live stock and branch/bin/status revalidation;
- serial/lot identity finalization;
- aggregate inventory reduction;
- stock movement evidence;
- inventory valuation evidence;
- accounting journal posting;
- high-value financial authorization evidence;
- write-off state transition;
- immutable operational/audit events.

## Non-Goals
- No redesign of the staff write-off screens.
- No new approval subsystem.
- No change to supplier, purchasing, customer-credit, or rental approval semantics.
- No weakening of current inventory traceability, valuation, or accounting controls.
- No automatic compensation workflow for failed destructive commits; failures must roll back instead.

## Architecture
The existing write-off route remains the sole authoritative mutation boundary.
The two pre-existing guards become preparation/validation layers only.
They may authenticate and normalize evidence, but they may not persist terminal approval state after the core route commits.

The approval request carries prepared control context into the authoritative route:
- `req.writeoffFinancialAuthorization` for validated second-authorizer evidence;
- `req.writeoffIdentityApproval` for validated serial/lot allocation context.

The authoritative route opens one write transaction and revalidates all mutable state inside it before applying effects.
Prepared request context is treated as input evidence, never as proof that live database state is still valid.

## Financial Authorization Boundary
For high-value or high-risk write-offs, the financial guard must:
- determine whether independent financial authorization is required;
- validate the PIN against active employees with `reports_financial` or `security_manage` authority;
- enforce that the financial authorizer is neither the approving employee nor the write-off creator;
- validate approval reason and evidence-reference requirements;
- remove PIN/secrets from `req.body` before downstream handling;
- attach only normalized non-secret authorization context to the request.

It must not insert `inventory_writeoff_financial_approvals` after the core route succeeds.
That insert must occur inside the authoritative transaction.

## Identity Boundary
The traceability guard must stop using response interception as the finalization mechanism.
It may validate that the submitted serial/lot allocation is structurally complete and attach normalized allocation context to the request.

Inside the authoritative transaction, the route must re-read the tracking profile and exact identities.
For serial-controlled stock it must require every selected serial to still belong to the product/branch and remain in the expected approvable state.
For lot-controlled stock it must require every selected lot to still belong to the product/branch and retain sufficient quantity.
The total identity allocation must exactly equal the write-off quantity.

Identity changes and aggregate stock changes must commit together.
No serial may return to `available` after aggregate stock was already written off.
No lot may retain quantity after aggregate stock was already reduced.

## Authoritative Transaction Order
Within one write transaction:
1. Load the write-off and require `pending_approval`.
2. Recheck write-off approval permission and self-approval rules.
3. Recheck branch, status, bin, and physical quantity.
4. Recheck serial/lot tracking mode and prepared allocations when required.
5. Recheck prepared financial authorization when the current value/reason requires it.
6. Apply identity-level write-off changes.
7. Apply status/bin/branch/global stock reductions.
8. Insert the stock movement and valuation evidence.
9. Post the accounting journal using the same transaction executor.
10. Insert required financial authorization evidence.
11. Compare-and-swap the write-off from `pending_approval` to `approved`.
12. Insert inventory status and write-off audit events.
13. Commit.

If any step fails, roll back the entire transaction and leave the write-off pending with no partial destructive effect.

## Concurrency Semantics
The final write-off state transition must use a compare-and-swap condition on `id` and `status='pending_approval'`.
Exactly one concurrent approver may win.
A losing transaction must roll back every mutation it attempted, including stock, identity, valuation, journal, and financial evidence.

Unique constraints remain a secondary defense, not the primary concurrency mechanism.
`inventory_writeoff_financial_approvals.writeoff_id` remains unique.
Identity allocation uniqueness remains enforced for serial and lot selections.

## Failure Semantics
Known business conflicts return stable staff-facing messages and appropriate 4xx status codes.
Unexpected storage, valuation, accounting, or integrity failures return a generic safe 500 response.
Raw SQL, provider, stack, or exception messages must never be returned to staff.

Internal logs must retain enough context for diagnosis:
- operation name;
- write-off id;
- employee id;
- branch id when known;
- stable error code;
- internal error text only in server logs.

Rollback failures must be logged separately and must not replace the original safe response.

## Error Codes
The implementation should centralize touched-path errors behind stable codes, including at minimum:
- `WRITEOFF_NOT_FOUND`;
- `WRITEOFF_NOT_PENDING`;
- `WRITEOFF_SELF_APPROVAL_FORBIDDEN`;
- `WRITEOFF_STOCK_CHANGED`;
- `WRITEOFF_IDENTITY_CHANGED`;
- `WRITEOFF_FINANCIAL_AUTH_REQUIRED`;
- `WRITEOFF_FINANCIAL_AUTH_FORBIDDEN`;
- `WRITEOFF_CONCURRENT_DECISION`;
- `WRITEOFF_INTERNAL_ERROR`.

## TDD and Runtime Certification
Implementation begins with permanent failing tests against the certified baseline.
The RED suite must prove the existing partial-commit defects before production logic changes.

Required adversarial cases:
- force financial-evidence insertion failure and prove stock/status/accounting remain unchanged;
- force serial finalization failure and prove aggregate stock/status/accounting remain unchanged;
- force lot finalization failure and prove aggregate stock/status/accounting remain unchanged;
- force valuation failure and prove no stock or identity mutation survives;
- force accounting journal failure and prove no stock, identity, or write-off mutation survives;
- run two concurrent approvals and prove exactly one commits;
- mutate serial/lot identity between preparation and authoritative transaction and prove fail-closed rollback;
- mutate branch/bin/status stock between preparation and approval and prove fail-closed rollback;
- verify financial-authorizer separation of duties;
- verify high-risk reason still requires authorization even below value threshold;
- verify low-risk below-threshold write-offs do not require financial authorization;
- verify raw internal error text is absent from all touched HTTP responses.

Each destructive-failure test must assert database invariants, not only HTTP status.
Tests must verify write-off status, branch/global stock, bin/status balances, identity state, movement rows, valuation rows, journal rows, financial-approval rows, and audit events as applicable.

## Compatibility
Existing route paths and staff-facing approval actions remain unchanged.
Existing permission names remain authoritative.
Existing write-off records and financial-approval rows remain valid; no destructive migration is permitted.
Existing non-tracked products continue through the same business workflow without synthetic identity records.
Existing tracked write-offs already awaiting approval must remain approvable after deployment if their identity evidence is valid.

The implementation must not silently reinterpret already-approved historical records.
Historical reconciliation signals remain reporting evidence, not mutation instructions.

## Expected Implementation Surface
Primary files expected to change:
- `routes/inventory-writeoff-financial-guard.js`
- `routes/inventory-writeoff-traceability-guard.js`
- `routes/inventory-writeoffs.js`
- focused write-off runtime/contract tests
- centralized write-off error helper if no suitable existing helper exists

Schema changes should be avoided unless tests prove an existing constraint cannot express the invariant.
If a schema change becomes necessary, this design must be revisited before implementation continues.

## Observability
Successful approval should produce one coherent evidence chain linking:
write-off -> stock movement -> valuation -> journal (when monetary value exists) -> financial authorization (when required) -> identity events (when tracked).

Failure logs must identify the failed stage without exposing internals to the caller.
The runtime test suite must retain deterministic fault-injection points so post-commit regressions cannot return unnoticed.

## Acceptance Criteria
The slice is complete only when all of the following are true:
1. No high-value financial authorization is persisted after the destructive commit; it is part of that commit.
2. No serial/lot write-off identity is finalized after aggregate inventory has committed; it is part of that commit.
3. Any failure before commit leaves the write-off pending and leaves all authoritative inventory/accounting/control evidence unchanged.
4. Concurrent approvals cannot double-remove stock or split evidence.
5. All touched staff responses use safe, understandable errors with no raw exception details.
6. Existing staff route/UI behavior remains compatible.
7. Permanent adversarial tests prove the former failure modes and the new atomic guarantees.
8. Full repository release certification passes on the exact feature head.
9. PR-head certification passes on the exact merge candidate.
10. Post-merge certification passes on the exact integration SHA before that SHA is called canonical.

## Release Discipline
Implementation must begin from the certified baseline above in an isolated worktree.
No force push, destructive history rewrite, unrelated refactor, or live-data mutation is permitted.
Merge must use expected-head protection.
Completion claims require exact-SHA evidence from the Runtime Certification workflow.
