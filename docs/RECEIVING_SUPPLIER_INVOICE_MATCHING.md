# POS Receiving — Supplier Invoice to Goods-Receipt Reconciliation

**Status:** implementation candidate, GitHub branch `feature/supplier-invoice-receipt-linkage-20261023`; release only after exact-head full Runtime Certification.

## Business outcome

A Purchase Order is a commitment; a goods receipt records **physical items received**, while a supplier invoice is evidence of what the supplier **billed**. Those are not interchangeable. Suppliers may deliver one PO over several shipments and may bill with one invoice for multiple receipts or separate invoices per shipment.

The Total Tools POS has an existing Accounts Payable supplier ledger, with posted invoices already optionally referencing `purchase_order_id`. This implementation adds an explicit **goods receipt ↔ supplier invoice** reconciliation record without creating a second payable or restocking inventory.

### Operator workflow

From **Fast Receive** or **Receiving review**, choose **Supplier invoices**:

1. Select the PO and the specific goods receipt: `RCV-...`, timestamp, received amount and receiver.
2. Select an existing posted supplier invoice from that PO, or record the supplier invoice number and merchandise subtotal while it is still awaiting Finance.
3. Enter the amount of the invoice covering **this particular receipt**. If the same invoice covers a second delivery, add another link to that receipt without reposting the invoice.
4. Review the receipt's **difference** between its recorded value and invoice allocations, with overbilling and missing invoice evidence remaining visibly unresolved.
5. If Finance subsequently posts the previously recorded supplier invoice under the same supplier/PO/normalized invoice number, a purchasing approver or Finance employee can confirm the existing invoice on that receipt. No new supplier liability is created by confirmation.

No new selling prices, supplier payments or inventory movements are posted by invoice matching. The original PO, receipt and supplier invoice are immutable source records for comparison.

### Database

`purchase_receipt_invoice_evidence`: PO, receipt, supplier, invoice number and normalized identity, invoice date, merchandise subtotal in integer cents, amount allocated to this receipt in cents, optional posted AP invoice ID, notes, actor and confirmation evidence.

`purchase_receipt_invoice_events`: append-only created/pending/confirmed history with actor, invoice ID and reconciliation metadata. Supporting evidence records cannot be deleted. Changes to material invoice amount require a controlled, separately audited correction workflow rather than an in-place overwrite.

### Safety gates

- Only authenticated, permissioned staff can record evidence; branch isolation and supplier/PO/receipt identity are validated on both read and write.
- An invoice number reused on a different PO for the same supplier is rejected to match the existing POS one-PO-per-supplier-invoice AP model.
- A posted invoice can be linked only when it has the same supplier, PO, branch and normalized invoice identity.
- Repeated identical submissions return the original evidence; conflicting repeated submissions return HTTP 409.
- Invoice allocations across receipts cannot exceed the recorded invoice merchandise subtotal; a posted invoice's subtotal must also agree before linking.
- Different invoices applied to a single receipt may total more or less than the received merchandise value. The discrepancy is shown to staff; it is **not** automatically authorized, paid, written off or used to change inventory.
- Confirming an existing posted invoice does not issue `INSERT INTO supplier_invoices` or mutate `products`, `purchase_order_items`, `branch_inventory`, `stock_movements`, or `purchase_receipt_items`.
- Split delivery, duplicate, wrong invoice, overallocated, missing AP and idempotent confirmation checks are covered by synthetic CI.

### Endpoints

All under `/api/purchase-orders/receiving-controls/invoices`:

- `GET /orders/:id` — posted PO invoices, goods receipts, their invoice allocations, and outstanding matching status.
- `POST /receipts/:receiptId` — record immutable invoice evidence on a specific receipt (requires `purchasing_receive`).
- `POST /evidence/:id/confirm` — confirm that existing evidence corresponds to a posted supplier invoice (requires `purchasing_approve` or `reports_financial`).

### Remaining industrial-grade integration items

1. **Private invoice attachments:** This release links structured invoice records, **not uploaded PDF/photo bytes**. PO evidence upload routes still need an approved durable private storage provider with authorization-checked downloads and recovery; do not silently save sensitive invoices on Vercel ephemeral disk or expose bearer-public URLs.
2. **Accounting posting:** Finance continues to post AP via the existing governed supplier ledger. Link capture is not invoice posting; no duplicate payable is permitted. Ensure existing AP three-way match controls and payment holds still apply.
3. **Invoice variants:** Existing AP ledger assumes one PO per supplier invoice. Consolidated invoices spanning multiple POs require a future many-to-many AP matching extension before allowing them.
4. **Exceptions and corrections:** Credits, negative adjustments, supplier returns, invoice corrections and changed matching allocations need an explicit authorized reversal/dispute workflow; do not mutate past receiving evidence without an audit record.
5. **Consumables:** Consumables have a separate CPO/receipt ledger. This slice links **retail-stock PO receipts** only. CPO invoice matching must be integrated with its distinct receipt authority before enabling it.
6. **Cost/tax:** Merchandise subtotal excludes tax, freight, duty and other landed costs. These remain under the existing supplier ledger and landed-cost allocation controls. Never confuse an invoice total with the merchandise amount allocated to stock.
7. **Release:** The new screen must pass responsive Playwright tests and full CI; realistic supplier invoice/receiving reconciliation must be accepted by authorized Total Tools staff before marking production-ready.

**Verification:** `node scripts/check-receipt-invoice-contract.js` checks source invariants; `tests/purchase-receipt-invoices.spec.js` exercises synthetic split deliveries, pending AP, duplicate protection, Finance posting, existing-invoice reconciliation and inventory independence. No production data should ever be used to run this test.
