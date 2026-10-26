# Supplier returns and credits

User-approved goal: receipt-linked partial returns with reasons and separate
approval; supplier credits linked to original invoices; physical stock and AP
changes remain distinct and exactly once, with audit history for refunds and
replacement deliveries. Use existing Express/libSQL, session permissions and UI.
No production records, deployment, external dependencies or new paid services.

## Physical return contract

Base route /api/supplier-returns. Staff session and source-branch checks precede
replay. purchasing_receive requests/dispatches; purchasing_approve decides;
requester cannot approve their own request. Original receipts/POs/cost layers
remain immutable. Pending and approved requests move neither stock nor AP.

Tables owned by physical module:
- supplier_returns: id,return_number,po_id,receipt_id,supplier_id,branch_id,
  reason_code,reason_detail,resolution (credit/replacement),status
  (pending_approval/approved/rejected/dispatched),requested_by_employee_id,
  approved_by_employee_id,created_at,approved_at,dispatched_at,dispatch_reference.
- supplier_return_items: id,return_id,receipt_item_id,product_id,quantity (base),
  source_status,bin_id,identity_json,stock_movement_id UNIQUE,tracked_quantity,
  tracked_value,legacy_quantity,untracked_quantity.
- append-only events and operation-key/fingerprint/results.

GET /orders/:poId -> {po,receipt_items,returns,permissions}; items include receipt
number/id,product/name/SKU,received/returned/returnable base quantity, base_uom,
tracking_mode, identities, eligibility/reason. GET /:id -> document+items+events.
POST / {receipt_id,reason_code,reason_detail,resolution,lines:[{receipt_item_id,
quantity,source_status,bin_id,serial_ids,lot_allocations}]} with Idempotency-Key.
POST /:id/decision {decision:approve/reject,reason} with key.
POST /:id/dispatch {dispatch_reference,reason} with key.

Dispatch rechecks receipt ceiling, source stock/reservations/status, exact bins
and identity provenance in one write transaction. One negative movement per line;
use existing weighted-average valuation, never original receipt cost as a proxy.
Dr supplier-return clearing 1270 / Cr inventory1200 using evidenced carrying value.
Do not invent legacy/untracked costs: reject dispatch if full quantity lacks
valuation. Support original-branch ordinary retail stock. Serial/lot available
identities must belong to the original receipt; restricted tracked identities
are rejected until aggregate/identity disposition is consistent. Require base
precision supported by valuation (at most four decimals). Reject unsupported
services, rentals/fleet, noninventory and variants before creating movements.
Untracked inspection returns require exact immutable hold-consumption evidence
and releasing only the remaining hold quantity. Never rewrite held original qty.

Late landed costs after outbound adjustments are an existing replay limitation.
Until a supported replay exists, explicitly reject affected late allocations
instead of silently capitalizing their full amount into the remaining stock.
This launch restriction must be visible in errors/docs and covered by rollback.

## Credit/AP contract

Base /api/supplier-ledger/credit-notes. Separate captured/posted/void documents,
positive component cents and immutable lines/events/operation evidence. Never
create a negative supplier invoice/payment or mutate original invoice amounts.
Capture requires receiving/Finance permission; posting/applications/refunds require
reports_financial. Capture has no AP/stock effect. Post requires dispatched return,
original nonvoid posted invoice, same supplier/branch and evidenced receipt links.

POST / {return_id,supplier_invoice_id,credit_number,credit_date,reason,
lines:[{return_item_id,quantity,unit_credit}],tax_amount,tax_treatment,total};
GET /?po_id=... -> {credit_notes}; GET /:id -> doc+items+events;
POST /:id/post {variance_reason}; POST /:id/allocate {invoice_id,amount};
POST /:id/refunds {amount,refund_date,payment_method,reference,reason}.
All writes use stable Idempotency-Key and atomic authorization/replay/source/GL.
Capture reserves credit quantities; nonvoid total quantities cannot exceed
returned quantity or original invoice receipt allocation, including other notes.
Merchandise price cannot exceed invoiced unit price. Recoverable/expense tax
reversals require original tax treatment and original component ceilings.
Freight/duty/landed-tax credits remain explicitly blocked until evidenced landed
cost reversal exists; do not invent an inventory reversal for them.

Posting journals Dr AP2000, Cr clearing1270 for attributable dispatched carrying
value, Cr1400 recoverable tax or Cr5450 expense tax. Difference between merchandise
credit and carrying value goes to explicit supplier return variance5280 only with
Finance variance reason. Apply credit to the original invoice up to its unpaid
balance as part of the reviewed Finance posting; retain excess as available
supplier credit. Later applications are subledger-only, not another GL debit.
Refund received: Dr cash1000/bank1010, CrAP2000 once, consumes available credit.

Central outstanding formula = total - cash payment allocations - posted credit
applications. Enforce it inside payment/application transactions and on all AP
lists, aging and summaries; preserve actual paid_amount separately. Available
credit = posted total - applications - refunds. Existing unallocated payments
matter to supplier net AP; do not silently clamp supplier credit balances away.

## Replacement and audit boundaries

Record actual replacement receipt evidence from a separate approved replacement
PO; normal receiving is the only action that adds stock. Linking replacement
records never receives goods again. Returned quantities cannot be settled twice
through replacement links and credit items. Replacement financial reconciliation
must explicitly identify any carrying-value difference; no fabricated new payable.

Use current purchasing review and Finance UI patterns. Every irreversible action
is explicit; unavailable modes show why before submission. Test branches, roles,
self-approval, source changes, quantities/bins/identities, paid invoices, competing
payment/credit/refund writes, mismatched replay payloads, journals and sync replay.
Publish verified source as a draft PR; release is a subsequent step.
