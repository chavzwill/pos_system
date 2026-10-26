# Purchase-order receiving approval gate

Purchase orders can receive goods only while approved or partially received. Partial receiving continues an approved order. Draft, sent, submitted, rejected, cancelled and fully received orders cannot create a new receipt.

The receiving operation guard rejects new unapproved attempts before operation reservation. Completed operation retries still return the original result without receiving again. The canonical receipt handler and both older handlers also check the current PO status inside the receipt write transaction, preventing a cancellation between validation and transaction creation from being overwritten by a receipt.

The modern workspace and legacy list/detail views offer receiving only for approved/partial orders. The legacy modal also checks current server state before opening. The fast receiving assistant already applies the same status restriction. Consumable PO receiving already enforces approval inside its own write transaction.

No new approval authority is granted. This change creates no inventory, invoice, payable or financial posting by itself. Existing purchase approval permissions continue to apply.

## Verification (26 October 2026)

- 32 focused Node runtime tests passed, including 10 route approval tests against isolated SQLite. Cases cover six blocked statuses across all four entry points, unchanged stock/movement/receipt evidence, approved and partial receiving across three handlers, and cancellation before each receipt write transaction.
- 12 purchasing editor browser checks passed, including the receiving action status matrix and existing currency, GCT, draft and responsive checks.
- Isolated purchasing lifecycle certificate passed, including approval authority, partial deliveries, replay, receipt-linked invoices, AP and payment reconciliation.
- Full `npm run vercel-build` checks passed.
- Independent review found no blocking issues.

The initial lifecycle run caught a 400/409 response compatibility difference. The operation guard now retains the established 400 response for an unapproved PO; the rerun passed.

Production verification is limited to source/version and anonymous access checks. No live purchasing or financial documents are created for testing.
