# Invoice capture before AP implementation plan

Goal: Receive supplier invoice details and match accepted delivery lines before Finance posts a payable.

Architecture: Keep captured invoices and their receipt evidence outside supplier_invoices, which remains the authoritative AP ledger. Post through the existing guarded supplier-ledger endpoint; atomically transfer receipt evidence and record the captured-to-posted invoice identity. No stock writes, accounting duplication, paid services or deployments.

- [x] Add failing runtime API tests using an isolated SQLite fixture: capture changes neither stock nor AP; multiple deliveries/invoices; duplicate identity/retry; over-allocation; posting once; Finance/branch boundaries; cost/quantity mismatch payment holds; rollback and void reservation release.
- [x] Add capture schema/service and staff routes. Validate money, dates, supplier/PO/branch, idempotency and immutable evidence. Pending receipt allocations reserve accepted units across both record types.
- [x] Integrate existing posting guards and ledger transaction. Reject direct posting of a pending captured identity; load stored amounts; Finance-only posting; preserve normalized duplicate checks; atomically finalize identity, match controls, evidence and source link.
- [x] Extend the existing matching panel with invoice capture, captured/posted labels, receipt matching and explicit Finance posting. Preserve the current UI system and mobile layout.
- [x] Run isolated runtime tests, existing invoice contract checks, syntax checks and relevant receipt/ledger regression tests. Inspect desktop and mobile UI. Commit and publish a reviewable branch without triggering a Vercel deployment.

Review focus: simultaneous attempts cannot produce two AP entries; captured records never enter accounting sync/payment queries; reservations cannot bill the same received units twice; all mutations and retries enforce branch/staff boundaries; discrepancies stay payment-blocked and posting failures leave capture retryable.

Validation: `npm run check:syntax` passed; eight isolated runtime tests passed; seven Playwright invoice/receiving regression tests passed, including the actual capture/match/post UI at 1280/768/390/320px. Desktop and phone screenshots were inspected. Browser validation used a temporary local Chromium executable because the standard browser archive download was truncated; no browser dependency was added to the project. Vercel automatic Git deployments remain disabled.
