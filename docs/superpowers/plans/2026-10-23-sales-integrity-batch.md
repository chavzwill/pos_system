# Sales integrity and counter workflow

Authorised scope: first recommended implementation batch from the repository comparison: discount-safe Hold/Recall; independent return authorisation; typed delivery/comment lines through quote, hold, recall, checkout and documents. Retain original tax policy, stock/serial/lot controls, credit limits, settlement and idempotency. No donor source transplant or paid services/deployments.

Architecture decision: early typed-line normalisation extracts non-stock lines into server-built ticket metadata while existing product validation/reservation remains authoritative. Persist extras and immutable per-line discount allocations in the same transaction as the sale/hold. Percentage/amount discount intent is separate from computed header amounts; replay hashes include non-stock content. Return authorisation is an independent staff-bound approval with reason, hashed credentials and evidence persisted in the return transaction.

- [x] Authoritative integer-cent allocation and discount intent preservation; 100-line rounding regression and exact return allocation.
- [x] Typed non-stock lines, trusted delivery tax and atomic persistence; no inventory/cost/purchasing effects; preserve quote lifecycle and legacy custom purchasing lines.
- [x] Independent return authorisation, standalone permission, branch and reason boundaries, no plaintext credential persistence or replay grants.
- [x] POS, held sale, quote, receipt and cashier-control UI integration; keyboard/mobile checks.
- [x] Runtime integration/regression tests, source checks, independent review, source publication as a reviewable change. Retain PR #126 and avoid deployment.

Ruling: preserve existing discount tax treatment; changes to taxation are outside this batch. New line-level discount allocations improve traceability without rewriting old transaction amounts.


Implementation evidence (2026-10-23)

- The donor’s 100-line negative-remainder case is covered by a bounded integer-cent allocator. Saved amount/percentage intent, line percentages and verified manual/card/promotion source survive holds; manual authority and aggregate discount cap are enforced on the server. Scoped promotions allocate only to eligible goods. Variation economics normalize before pricing and margin checks.
- Stock lines remain the only lines entering stock, serial, lot, reservation and cost pipelines. Delivery and comment rows commit with the ticket; delivery tax comes from settings, comments have zero value, and original line order survives documents. Quote delivery/comments never become purchasing requests. Delivery refunds require a Finance adjustment rather than an inventory return.
- Recall completion, source link and hold closure now share the sale transaction. Only the original operation identity can replay a completed recall. Discount evidence is immutable; cumulative partial refunds consume the exact saved per-line discount, including the final penny. Historical records keep their prior allocation path and tax policy.
- Every standard retail return/replacement needs a meaningful reason and a different active employee with explicit returns_authorize. Branch boundaries and bcrypt credentials are checked again inside the return transaction. Immutable evidence commits with the return; secrets are scrubbed before downstream handlers and permission-denial auditing. Only failed credential attempts consume the attempt budget. Administrator/Manager migration preserves explicit denials.
- Both checkout interfaces, held sales and quote editing have controls for the new fields. Plain-text descriptions are escaped in receipts and email documents. Desktop (1280px) and phone (390px) counter interactions are exercised, including decimal delivery amounts, literal markup, recalculating percentages and keyboard-accessible entry dialogs. New source files use no external paid dependencies.

Validation: 13 isolated node tests (invoice capture and ticket money rules), the disposable-database return-authorization runtime suite, and 17 distinct real-server/browser scenarios across sales-integrity-batch, gate1-return-concurrency, purchase-receipt-invoice-link, gate1-supplier-invoice-concurrency and gate1-purchase-receive-idempotency. Full npm run check:syntax and git diff --check pass. A separate reviewer identified and verified fixes for variation pricing, legacy badge variable scope, response line order and first-use held-sale schema initialization. Required Chromium was supplied locally without modifying package dependencies.

Publication: separate draft branch feature/sales-integrity-controls, stacked on feature/invoice-capture-before-ap (PR #126). Local validation is authoritative for this draft; commit carries [skip ci] to avoid unnecessary GitHub Actions usage. No merge, production migration, Vercel deployment or paid service is performed.
