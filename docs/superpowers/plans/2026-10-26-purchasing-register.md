# Purchasing Register Implementation Plan

**Goal:** Find and follow existing requests, orders, receipts, captured and posted invoices, credits, returns and payments in Purchasing Operations.
**Architecture:** Read-only projections of authoritative tables; a lazy-loaded register uses existing Total Tools typography and green operational controls. No new transaction or schema writes. Captured invoices remain distinct from AP.
**Tech stack:** Existing Express, libSQL, vanilla JavaScript and CSS; no new dependencies or paid design services.
**Scope:** User approved the register outline and instructed implementation. Preserve the merged branchless draft fix for the combined release.

- [x] Add runtime regression tests for search, pagination, invoice authority, permissions, branches and linked record navigation.
- [x] Implement `/api/purchasing-register` list and `/:type/:id` detail, with bounded filters and parameterized values.
- [x] Add document register launcher to Purchasing Operations; search, filter, inspect lines and follow authorized records.
- [x] Verify mobile, tablet and desktop interactions; build checks and receiving regression tests.
- [ ] Publish a reviewable PR and release only with production authorization.

Review focus: document IDs overlap across types; invoice capture is not a second payable; links must not leak another branch; unassigned staff see only their own requests unless they have branch authority; missing optional modules must be stated rather than silently presented as empty history.

Verification: 26 Node runtime checks pass, 17 browser checks pass (register and existing purchasing editor), and npm run vercel-build passes. Mobile, tablet and desktop screenshots inspected. No live documents were created.
