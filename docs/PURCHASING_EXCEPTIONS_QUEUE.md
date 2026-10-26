# Purchasing exceptions queue

Open **Purchasing exceptions** from the Purchasing toolbar. The queue is read-only
and groups work by purchase order in the employee's assigned branch. Search by
PO number or supplier; select a category and use Load more for subsequent pages.
Orders appear oldest first. Refresh is explicit; there is no background polling.

The filter counts are affected **orders**, not summed quantities or liabilities.
One PO may appear in several categories. Rows show the number of affected receipt
lines, delivery lines or invoices without adding incompatible units of measure
or currencies together.

| Category | Source rule | Next action |
| --- | --- | --- |
| Overdue deliveries | Approved, sent or partial PO lines with outstanding quantity, less recorded closed shortages, past the latest supplier ETA or original expected date | Review delivery |
| Unbilled receipts | Receipt lines with quantity not reserved by posted allocations or active captured-invoice allocations | Match invoices |
| Unmatched invoices | Active PO-linked invoices with merchandise value not yet covered by receipt allocations | Match invoices |
| Invoice differences | Captured allocation cost/amount differences, or posted differences not cleared by the existing matched/approved_exception control | Match invoices |

A delivery cost adjustment with a recorded reason is historical evidence and is
not automatically treated as an unresolved price discrepancy. Posted captures
are excluded from capture reservations so their copied posted allocations are
not counted twice. Voided captures release their reservations. Posted void
invoice reservations follow the existing immutable receipt-allocation authority;
this queue does not change that correction workflow.

Review delivery and Match invoices open the existing source screens. There is no
bulk posting, payment, stock adjustment, price change or automatic resolution in
the queue. In-progress source navigation cannot close a subsequently reopened
queue or move keyboard focus behind its destination dialog.

## API and permissions

`GET /api/purchasing-exceptions` accepts:

- `category`: all, overdue, unbilled, unmatched or variance.
- `q`: literal PO/supplier search, up to 100 characters; wildcard characters are escaped.
- `after`: ascending PO ID cursor, default 0.
- `limit`: integer 1–50, default 25.
- `branch_id`: defaults to the assigned branch; another branch requires branches
  or security_manage permission.

A current employee session is required; API keys are rejected. Purchasing or
receiving/Finance access is checked server-side. Invoice filters and counts
require purchasing_receive or reports_financial. Source-action permissions come
from the response and remain enforced by their destination APIs. Responses are
private/no-store.

The query aggregates evidence sources separately and narrows receipts/invoices
to the selected branch's orders. It does not create tables or write business
records. As-of dates use the Jamaica business day. Counts span the current search
rather than only the page; category counts can overlap. Page results are a live
view, not a fixed transaction snapshot across subsequent page requests.

Optional evidence tables may not exist before first use. The response reports
coverage, and the UI displays a partial-coverage notice instead of claiming a
fully initialized ledger. Failures show a retry state, never a cleared queue.
Unassigned invoices without a PO and missing/invalid delivery dates cannot be
classified as PO-specific overdue work; existing supplier-ledger review remains
necessary for those records.

## Verification

`tests/purchasing-exceptions.test.cjs` covers source aggregation, reservations,
void captures, latest ETA/closed shortages, invoice review, staff/branch/permission
boundaries, search, cursor bounds and optional evidence coverage.
`tests/purchasing-exceptions-ui.spec.js` covers layouts at 390/768/1440px, filters,
read-only requests, errors, permissions, pagination and source-action focus/races.

The isolated lifecycle certificate checks that receipts first enter the queue
and that the fully reconciled PO leaves it. See
[evidence/purchasing-acceptance-2026-10-24.json](evidence/purchasing-acceptance-2026-10-24.json).
No production transactions or financial reconciliation jobs were run.
