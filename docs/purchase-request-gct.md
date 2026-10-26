# Purchase request GCT selection

Both the legacy request dialog and modern composer expose an explicit Include GCT / No GCT choice. Costs are entered before tax; GCT is added once to the document subtotal. The modern form shows a live subtotal, GCT and estimated total. The legacy dialog no longer treats local currency alone as an instruction to add tax. Legacy draft edits retain the enabled choice and apply the current configured rate; modern copies carry the enabled choice while applying the current configured rate to the new document.

The authenticated request tax-options endpoint returns only the configured POS rate. No legal rate is hardcoded. If that rate cannot be loaded, an existing GCT-enabled draft cannot silently save as tax-free. A changed rate rejects a stale modern submission. New modern requests default to No GCT, preserving their prior zero-tax default; new legacy requests retain their existing tax-on default, with an explicit removal control.

The backend recomputes tax from rounded line totals instead of trusting a supplied amount. Explicit removal sets rate and amount to zero. Existing API clients without the new boolean retain their supplied/stored rate, subject to validation. Rates support four decimals, within 0–100; integer-cent tax arithmetic uses half-up rounding. Explicit zero unit costs remain zero.

Approval evidence includes the saved rate/amount. PR-to-PO conversion uses the approved PR rate and records base/supplier GCT amounts, totals and currency evidence without changing unit costs or creating a payable. FX and tax rounding are applied in each document currency; tax is separate from stock cost. Supplier invoices and AP posting remain Finance actions.

Validation covers tax rounding/removal/invalid inputs, PR form estimates and payloads, legacy calculator behavior, and isolated department-approved PR conversion. Production data is not used in testing.
