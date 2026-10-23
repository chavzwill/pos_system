# Total Tools POS — Receiving reconciliation, supplier backorders and retail price review

**Implementation:** `feature/receiving-discrepancies-backorders-price-review-20261023`  
**Scope:** retail-stock Purchase Orders (not consumables CPOs). Candidate until full Runtime Certification and staff acceptance succeed.

## Operator journey

1. **Fast Receive:** Scan the approved PO, count what physically arrived, record lots/serials, and mark damaged deliveries for inspection. Existing over-receipt and close-short safeguards still apply.
2. **Receiving review:** Open **Purchasing → Receiving exceptions & pricing**, or use **Review issues & pricing** inside Fast Receive. Select the PO. The summary shows each ordered/received/outstanding quantity, previously approved closed shortages, supplier follow-ups, and exception records.
3. **Backorders:** A short delivery remains **open** automatically. Record supplier ETA, supplier acknowledgement number, and what the supplier promised. That follow-up is append-only metadata; it does **not** manufacture stock or close the order. The displayed backorder quantity is ordered minus received minus explicitly closed shortages from the existing approved shortage-exception ledger. Later receipts reduce the balance. The historical supplier updates remain visible through the latest note/reference.
4. **Discrepancies:** Existing receiving controls are authoritative for overages, approved short closures, and inspection/quarantine holds. The review shows their immutable evidence; it does not skip authorization or replace quality-release decisions. A supplier promise is not itself a receipt or a credit note.
5. **Retail prices:** After a linked item has actually been received, enter a suggested new **base/list selling price** and an explanation. The price remains unchanged until a **different staff member** with both `purchasing_approve` and `inventory_edit` confirms the proposal. Approval uses a price-compare-and-swap, so another catalog edit makes the old proposal stale rather than silently overwriting a newer price. Rejection leaves the retail price unchanged. A unique pending proposal per product prevents contradictory approvals.
6. **Accounting:** Supplier invoice, freight, duty, tax, credits and landed-cost allocation remain in their existing finance controls. A suggested retail price is not proof of final landed cost, and no profit margin is invented.

## New read/write API

All endpoints are beneath `/api/purchase-orders/receiving-controls/review`. Staff sessions only; branch authority checked against the PO:

- `GET /orders/:id` — authoritative remaining quantities; short-closed values; supplier history; discrepancy events; price proposal queue.
- `POST /orders/:id/backorders/:lineId` — supplier ETA/reference/follow-up note on an open, approved PO with remaining quantity (requires `purchasing_receive`).
- `POST /orders/:id/price-proposals` — proposes a changed retail price for a received catalog-linked PO line (requires `purchasing_receive`). **Does not** change `products.price`.
- `POST /price-proposals/:id/decision` — approve/reject with reason; both `purchasing_approve` and `inventory_edit`; a separate employee required. Only an approval performs a conditional price update.

All mutation inputs use bounded text, positive record IDs and cents-precision monetary validation. The supplier backorder history is append-only and is **not** a financial ledger. Price proposals preserve origin, target, old retail price, PO cost, requester, independent decision, and decision reason. Proposal records cannot be deleted.

## Integration boundaries / industrial-grade follow-up

- A shortage **backorder is a supplier obligation, not a physical stock movement**. A shortage closed by purchasing approval no longer counts as an outstanding backorder. Actual supplier returns and invoice credits need their existing evidence workflows.
- The retail change updates the **base `products.price`** field. Effective branch/tier prices, promotions, tax, website sync and outstanding quotes require downstream safety policy and propagation testing; never assume every channel has instantly repriced. No automatic store-wide promotions or fee changes are made.
- Pricing below recorded cost is not silently blocked or invented as a final margin policy; reviewers must enforce company mark-up/tax rules. A future configured minimum-margin rule and specialist approval for loss-leading prices is recommended.
- Further production gates: a full inventory-price audit/version history across non-PO manual changes, adjustment provenance, provider invoice variance/credit reconciliation, explicit backorder cancellation/acknowledgement lifecycle, real printer/scanner testing, all-role usability and end-to-end SmartCommerce price synchronization.
- Existing `purchase_receipt_exceptions` and `purchase_receipt_quality_holds` remain authoritative. No receipt posting, UOM, serial-lot, cost-layer, or stock movement path was replaced by this feature.

**Release rule:** Isolated source-contract and Playwright tests run against a synthetic CI database; production data is never used in tests. Do not deploy an unverified branch or create unnecessary Vercel previews.
