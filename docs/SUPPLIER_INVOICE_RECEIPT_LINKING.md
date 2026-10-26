# Supplier invoices linked to POs and actual delivery receipts

**Status:** 2026-10-23 candidate implementation on `feature/supplier-invoice-receipt-matching-20261023`. This extends the existing POS supplier AP ledger; it does **not** create duplicate invoice liabilities.

## Receiving workflow

1. Staff create a purchase order and obtain approval through established purchase approval rules.
2. The receiving team logs what physically arrived in **Fast Receive**. Each separate partial receipt generates its own `purchase_receipts` and `purchase_receipt_items` evidence.
3. Accounting posts the **real supplier invoice** through **Supplier Bills & Payments** using the correct supplier, invoice number, tax, merchandise subtotal and, if known, purchase order ID. The existing normalized invoice identity and supplier match controls remain authoritative. This does not automatically mean merchandise was physically received.
4. From **Purchasing → Receiving exceptions & pricing → Link supplier invoice**, staff choose a posted supplier invoice that belongs to the PO/supplier (or is not yet assigned to a PO), then enter the received item quantities and invoice unit costs billed on that invoice.
5. A single supplier invoice may span multiple deliveries and receipt lines. Multiple supplier invoices may bill distinct portions of a single receipt line, but **their cumulative billed quantity cannot exceed actually received quantity**. Every linked line records original receipt item ID, invoice unit price and quantity, staff actor and timestamp.
6. The link ledger reconciles the invoice's merchandise subtotal to the sum of its receipt-linked line values and compares invoice unit costs against the receipt valuation. Exact matches remain `matched`; missing/unbalanced amounts remain `receipt_amount_variance`; unit-cost differences remain `receipt_unit_cost_variance`. These unmatched statuses are excluded from existing automatic supplier-payment matching and must be resolved by authorized AP review.
7. Linking invoice evidence does **not** receive goods, change stock, change retail prices, alter AP amount, or create a second payable. It is an audit-quality three-way invoice-to-PO-to-receipt reference.

## Strict controls

- **Staff identity and branch authorization:** read by purchasing/receiving/finance staff, write by receiving/finance permission holders. API keys are not allowed for invoice matching.
- **Supplier and branch authority:** invoices from other suppliers or branches or assigned to another PO cannot link to the selected PO.
- **No duplicate liabilities:** the invoice source of truth remains `supplier_invoices`; the new records are only matching evidence. Normalized duplicate-invoice protection continues through `supplier-invoice-loss-prevention`.
- **Quantity control:** allocations are inside a single write transaction; the sum billed across invoices can never exceed the accepted receipt line quantity. Duplicate `invoice × receipt item` entries are blocked.
- **Deterministic retries:** each write needs `Idempotency-Key`; replay of an identical operation returns its original result, while different content with the same key is rejected. Partial errors roll back the entire update.
- **Immutability:** invoice receipt allocations are append-only. The existing supplier match event log records changes; invoice numbering and metadata are not silently rewritten.
- **Payments already made:** existing paid invoices cannot accept new receipt allocations. Corrections require controlled credit/void/reversal procedures, not editing the historic evidence.

## Endpoints

`GET /api/purchase-orders/receiving-controls/invoice-receipts/orders/:poId` provides eligible existing AP invoice references, individual received line balances, and linked evidence.

`POST /api/purchase-orders/receiving-controls/invoice-receipts/orders/:poId/invoices/:invoiceId/allocate` submits an array of `{receipt_item_id,quantity_invoiced,invoice_unit_cost}` with `Idempotency-Key`. It returns the reconciliation status, matched merchandise, billed subtotal and variance in cents.

A posted invoice with no PO link may be assigned to the selected purchase order **only after** validating supplier, branch and receipt authority.

## Remaining commercial/industrial gates

- Real scanned invoice PDFs, packing slips, delivery notes, customs documents and photos require a **private durable attachment authority with access control, malware validation, retention and offsite recovery**. No public link, local ephemeral upload or imaginary attachment claim is implemented here.
- Supplier invoice posting remains in AP with its existing independent controls; reconciling mismatched quantities and prices requires authorized human review. Do not automatically pay a flagged invoice.
- Unit-price mismatches may reflect genuine landed-cost adjustments, supplier credits, discounted pricing or invoicing errors. Approved variance-resolution actions must be governed by finance policy and reflected in inventory cost accounting separately; this integration does **not** silently rewrite costs.
- The existing supplier invoice exception-review mechanism permits authorized approval of exceptions; this remains a consequential finance control requiring independent audit review.
- VAT/GCT, freight, duties, exchange rates, supplier credits and landed-cost allocations remain distinct from the **merchandise subtotal** reconciled here. This is not a complete landed-cost allocation engine.
- Follow-on acceptance: multi-invoice/partial-receipt scenarios, supplier and cross-branch denials, document security, AP payment holds, inspector/receiver UX, SmartCommerce sync and isolated backup/restore drills.

**No production invoices, receipts, payments or inventory were mutated in automated CI tests.** Tests use synthetic isolated data and existing GitHub certification.
