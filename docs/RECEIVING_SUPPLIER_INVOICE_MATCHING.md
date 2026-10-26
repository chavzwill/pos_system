# Supplier invoice and goods-receipt reconciliation

PR #125 is reconciled with master 7563411. Use the existing line-level invoice capture and receipt-matching workflow; the older parallel receipt-value evidence ledger is removed from this candidate.

## Staff workflow

1. Open Supplier invoices from receiving review or Fast Receive.
2. Capture the supplier invoice against its PO before Finance posting. The captured document is not an AP liability and does not move stock.
3. Link the invoice to accepted receipt lines, including lines from multiple deliveries. Pending evidence reserves receipt quantities in the same calculation used by posted allocations.
4. Finance posts the captured document once. Posting transfers the receipt evidence atomically into the posted allocation ledger. Repeated posting returns the same invoice.
5. Review subtotal and unit-cost differences. Existing match controls and payment holds remain authoritative; invoice capture does not clear them.

Use /api/supplier-ledger/captured-invoices for pending documents and /api/purchase-orders/receiving-controls/invoice-receipts for reconciliation. The former /invoices evidence router and purchase_receipt_invoice_evidence table are not part of this candidate.

## Branch and permission boundary

Capture, listing, allocation, voiding and Finance posting require a staff session and their existing role permission. Each invoice/PO branch must be a valid positive ID. Staff must have that branch assigned or explicit cross-branch authority. A missing or invalid default branch does not grant access to every branch. multi_branch_access must be boolean true; existing branches/security administrator inheritance is preserved.

Authorization applies before idempotent replay and to both captured and posted evidence. Finance-only staff can read reconciliation through the current reports_financial permission. API keys cannot operate these workflows.

## Validation

The Node runtime suite uses a fresh synthetic database and real Express routes. It covers split deliveries, pending/posted quantity sharing, duplicate invoice identity, atomic rollback, posting replay, unchanged stock, payment holds, unassigned staff, malformed branch assignments, explicit multi-branch access, Finance-only access and posted-allocation replay denial.

Run:
- node --test tests/invoice-capture-runtime.test.cjs
- node scripts/check-invoice-receipt-contract.js
- npm run check:syntax
- Playwright tests/purchase-receipt-invoice-link.spec.js against an isolated synthetic database.

No new schema migration is required for the branch fix. Private invoice file storage remains a separate approved integration. The abandoned PR ledger was not deployed by this work; installations that independently created it require an explicit migration plan rather than silently copying historical evidence.
