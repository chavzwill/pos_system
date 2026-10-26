# Total Tools POS — Consumables purchasing and usage ledger

**Implementation slice:** `feature/consumables-separate-purchasing-usage-20261023`  
**Release status:** Candidate only; automated tests and staff acceptance required.

## Why this is a separate ledger

Retail stock is held in `products`, `branch_inventory` and `stock_movements`. Buying workshop gloves, lubricants, welding consumables, chemicals or service materials for internal use must **not** increase quantities available for customer sales, the website or SmartCommerce pricing.

Consumables therefore have their own **catalog, purchase orders, approval trail, branch balances, receipt movements and usage movements**. Consumable SKU namespaces and business identity are separate from retail catalog IDs. The system never posts a `consumable` receipt into the retail inventory tables.

This is the initial operational control module, **not a fully implemented accounting/AP, SpendOS or rental-asset registry integration**. Consumed-value allocations are captured in integer currency cents and can be reconciled later by an approved, idempotent GL/SpendOS posting design. Do not post the same costs twice.

## Staff experience

Go to **Purchasing → Consumables · Purchasing & Usage** from the fast POS shell.

1. Register a consumable with a unique internal code, name and unit of measure. Existing retail catalog products do not need to be prelinked.
2. Create a dedicated **CPO** order, with a selected supplier and receiving branch, approval justification (**reason**, **requested for**) and optional default cost allocation to a branch, department, or rental equipment item plus **unit/serial reference**.
3. Submit the draft; a different employee with `purchasing_approve` must approve it. Orders cannot be received while draft/submitted.
4. Receive all or part of the CPO using `purchasing_receive`. An over-receipt or replayed receipt cannot inflate stock; receive changes only the independent consumable balance and records an immutable receive movement.
5. **Record usage / issue**, with `inventory_adjust`, specifying the source branch, item, positive quantity, allocation to department/branch/rental equipment and a required business reason. For rental allocations, record a unit or serial reference; a rental product model ID alone is not enough to identify a specific physical asset.
6. Review balances and permanent consumption history by branch, department and rental unit.

A **Copy to new PO** control pre-populates editable consumables from an existing CPO, but never copies its approval, receipt or stock movement evidence.

## Data and access contract

- `consumable_catalog` — distinct consumables identity and UOM.
- `consumable_purchase_orders` + `consumable_po_lines` — supplier, branch, purpose, beneficiary, allocation, ordered/received quantities and integer-cents cost. Separate `CPO-000001` number sequence.
- `consumable_order_events` — append-only created/submitted/approved/received decisions with employee IDs.
- `consumable_balances` — per-branch on-hand and cost value, never negative.
- `consumable_movements` — append-only receipt/usage, with actor, branch, department, rental product and serial/unit reference.
- `consumable_operations` — stable idempotency-key fingerprints and replay evidence.

Business mutation endpoints require a `12–160` character `Idempotency-Key`. Retried identical operations return the original result and are not executed twice. Reuse of a key with changed content is rejected with 409. Creation, approval, receiving, and usage updates run inside one write transaction. Conditional quantity updates prevent over-receipt and negative stock.

Staff sessions only; no API-key writer path. Permissions reuse existing POS rights: `purchasing_create` for item and PO creation and submission, `purchasing_approve` for approval, `purchasing_receive` for receipts, `inventory_adjust` for usage issues, and `purchasing` for views. Branch restrictions follow the assigned employee branch unless explicitly permitted to work cross-branch.

## Outstanding industrial-grade gates

- **Full cost accounting and SpendOS reconciliation:** reconcile the consumables ledger against supplier invoices, tax, returns, credits and GL posting. Do not count catalog receipt values as realized consumption expenses.
- **Returns/transfer/write-off controls:** a reversible process with dual authorization and durable compensation movements is required for mistakenly issued items, branch transfers and vendor returns. Historical movements must not be edited in place.
- **UOM and physical inventory:** this initial slice counts whole units per consumable. Fractional items, packs, liters, decimal quantities, batch/lot, hazardous materials and controlled items need a separate quantity/UOM governance extension before approval for those SKUs.
- **Machine/asset-level association:** allocation stores the authoritative rental `products.is_rental` equipment model **and a required unit reference**. The POS does not yet have an authoritative individual rental machine registry. Match this unit reference to an approved serial-tag/equipment record before relying on per-asset profitability.
- **Approval routing:** the dedicated status approvals require independent approvers, but cross-department threshold policies and company-wide approval routing remain a future integration.
- **Offline/recovery and device acceptance:** the new tables are included by the full database backup utility automatically, but the business recovery drill and field user acceptance remain outstanding.
- **Accurate source report:** this feature is not proof of current positive company budgets or active expenses. No imported purchasing or spending figures are fabricated.

## Certification

The source contract checks no retail stock or branch-inventory writes, required role gates, cent precision, idempotency, over-receipt protection, cost allocation and UI routing. Playwright exercises a fully isolated CI database, creates two staff accounts, rejects self-approval, receives twice with the same idempotency key, tests over-receipt and insufficient balance, and verifies a retail product's stock quantity does not change. It also checks the mobile workspace on 390px and 320px widths.

**Never run synthetic CI tests against production data or grant synthetic users real branch access.** Production deployment is gated on the exact-head Runtime Certification and real operational acceptance.
