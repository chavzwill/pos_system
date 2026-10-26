# Company / branch rental fleet lifetime contribution

Status: review candidate; stacked on the rental asset pagination and settled-fee reconciliation changes. Read-only, never a replacement for posted GL or bank reconciliation.

## API and authority

`GET /api/inventory-traceability/rental-economics/fleet-profitability`

- Requires authenticated staff (`apiKey` is not accepted), `reports_financial`, and an assigned branch. Staff without explicit `branches` or `security_manage` permission see ONLY assets at their assigned branch. Financial staff with cross-branch authority default to all branches, can request `?branch_id=all`, or narrow to `?branch_id=<id>`.
- Uses current branch ownership for grouping. An asset transferred between branches carries all its historical revenue/cost evidence with it. This is **not** historical branch rental P&L.
- Full coverage or no report: if the matching fleet contains more than 1,500 registered physical assets, returns `413 REPORT_TOO_LARGE` rather than a capped, misleading company total. The interactive cap is a temporary scalability constraint: use branch-specific runs until server-side SQL aggregation and consistent as-of snapshots are implemented. Exception preview is limited to 60 with exact exception count and truncation flag.
- Normal company and branch figures always include *all* matching registered physical assets, independent of the fleet list's 100-asset pagination.

## Reporting contract

- Reuses per-asset acquisition evidence, returned and buyout fee reconciliation, original-cost consumables less unused returns, Finance-reviewed external maintenance, direct cost events and evidenced sale/disposal proceeds. No second pricing or purchasing ledger is invented.
- Both company and branch rollups carry `asset_count`, `certified_asset_count`, `assets_requiring_review`, `provisional_active_assets`, `revenue_review_assets`, `cost_review_assets`, and `missing_cost_source_assets`.
- `original_quoted_rental_fees` is historical quoted core fees on issued asset allocations. `reconciled_rental_revenue` is `null` when an asset has unassignable fees or adjustments **or provisional active fees**; `verified_revenue_subset` covers only final, individually reconcilable rental fees and excludes provisional active bookings. Deposits and tax never count as core revenue.
- `certified_lifetime_contribution` is `null` if ANY included asset has unapproved cost evidence, unassignable rental revenue, partial acquisition evidence, missing consumable evidence, or provisional active fee revenue. `certified_subset_contribution` includes strictly the certified assets and is always presented with the certified asset denominator. A profitable subset must **never** be labeled company profit.
- `registered_acquisition_cost` is an evidenced historical capital outlay (not depreciation expense); reported lifetime contribution is not an IFRS/GAAP P&L, fiscal-period profit, cash collection or rate of return on invested cash. Overhead, tax, financing, depreciation and unrecorded service cost remain excluded.
- Company/branch summation uses integer cents and safe-integer guards. The full report is a non-atomic live read; concurrent POS writes or transfers can change underlying sources, and this is disclosed. Final accounting reports need an immutable snapshot/batch reconciliation against journals, payments and credits.

## UX

Finance-authorized employees can select **Fleet profitability** in Fleet Management, see eight company tiles, a branch comparison table, and a readable reconciliation queue. The tables scroll horizontally on small devices while the overlay stays inside the device viewport. Review-required values render as text rather than `JMD 0.00`.

## Test/rollout gates

`node --test tests/rental-consumable-economics.test.cjs` validates local/global/foreign branch access, missing staff and API key rejection, all-asset coverage vs page size, cost/revenue reconciliation withholding, branch-safe certified subsets, restored contributions and no silently capped report at 1,501 assets. Browser regressions cover mobile and desktop layout and staff without Finance permission. No production deployment is authorized by this change.
