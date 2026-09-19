# Catalog Duplicate Review Governance — Plan
1. Add RED contract for durable review state, append-only events, authority, concurrency and UI.
2. Add central schema for duplicate review current state and immutable events.
3. Add candidate fingerprint helper and review-aware duplicate diagnostics.
4. Add inventory-authorized review endpoint with reason validation and optimistic versioning.
5. Add staff controls on duplicate work-queue cards for Not a duplicate, Confirm same item, and Needs more info.
6. Add runtime certification for suppression, escalation, changed membership invalidation, stale version rejection and no product mutation.
7. Run focused tests, full syntax wall, audit and diff checks.
8. Commit, push, exact-head Runtime Certification and merge.
