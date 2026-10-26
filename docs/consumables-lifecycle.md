# Consumables purchasing and usage

Extend the existing separate consumables catalog, approved purchase orders,
receiving balances and usage movement ledger. Keep consumables quantities and
costs out of retail products and retail inventory. Original purchase instructions
and prices remain distinct from physical receipt, supplier invoice, payable and
supplier credit evidence.

Orders identify the receiving branch and intended branch, department or rental
equipment. Issues record the consumable, quantity, actual carrying cost, responsible
employee, usage purpose and department or rental product/unit reference. Reports
aggregate the full filtered history, rather than only the recent movement list;
quantities remain grouped by consumable and unit of measure.

Supplier returns require original receipt-movement evidence, independent approval
and explicit dispatch. Request/approval do not change stock or AP. Dispatch removes
only available consumables and their preserved moving-average carrying value.
Original receipt evidence and PO received quantities remain unchanged.

Finance links supplier invoice quantities to actual consumables receipts. A link
must reuse the posted supplier invoice, preserve supplier/branch provenance and
not create a second payable. Supplier credit capture changes neither stock nor AP;
reviewed Finance posting, applications and confirmed refunds are separate steps.
Shared payment limits must include posted consumable credit applications alongside
retail credit applications, with cash paid and credit applied kept separate.

Branch and permission checks precede operation replay. Missing assigned branches
fail closed unless staff have explicit cross-branch authority. Mutations use stable
operation keys and atomic immutable evidence. Unknown submission outcomes must
retain the original key and payload for confirmation/retry.

Verification uses isolated local databases and staff sessions, checks complete
receiving/issue/return/invoice/credit/refund accounting, and renders the existing
workspace at phone, tablet and desktop widths. Source and checks are published as
a draft pull request before a subsequent production release.

## Use and accounting

Open **Consumables** from Purchasing. Use Catalog to add consumable items, Orders
for approval and receipt, Stock for issues, Usage / cost reports for filtered
history, and Supplier corrections for receipt-linked returns and Finance actions.
At receiving, an optional actual unit cost replaces the approved cost only for
that delivery; a change reason is required and original PO prices are preserved.

Finance posts the original supplier invoice using the existing supplier ledger,
with its retail PO field unassigned. Supplier corrections links that existing
invoice to consumables receipt movements; it never creates another liability.
Exact receipt-cost matching is required. A cost variance must be reconciled before
it becomes payment eligible. Credit capture follows physical dispatch; posting,
application to an invoice and receipt of a supplier refund are explicit steps.

Accounting source sync posts each immutable source once: receipt Dr1280 Consumables
on hand / Cr1250 Receiving clearing; usage Dr5460 Consumables usage / Cr1280;
return dispatch Dr1270 Supplier return clearing / Cr1280. Credit posting reduces
AP2000 and reverses attributable return clearing and eligible tax, with explained
variance5280. A credit application has no second GL entry. A confirmed refund
records cash/bank received against AP. The certificate verifies balanced journals
and zero AP/receipt/return clearing at completed settlement.

Current quantities use whole consumable units and costs use JMD cents. Rental
new rental orders and issues require a registered active rental asset at the
selected branch for the selected product. The asset ID and displayed asset number
are preserved on the source; historical free-text rows remain explicitly unresolved.
Supplier tax reversal supports the original recoverable or expense classification;
landed-tax reversal is blocked. Separate approval and Finance authority remain
necessary even when all steps are opened from one workspace.


## Correction and recovery controls

Cancel an unfulfilled draft/submitted PO as its requester, or cancel an approved
unreceived PO as an independent approver. An independent approver can reject a
submitted PO. Any received quantity or receipt movement blocks closure. The
original order remains visible with its closure reason and decision evidence.

Supplier return requests can be cancelled by the requester before approval, or
cancelled after approval by an independent approver. An independent approver can
reject a requested return. Dispatched returns cannot be closed. Closures release
receipt quantity reservations without receiving stock or posting money.

Receiving staff or Finance can void an incorrect captured supplier credit before
Finance posting. The captured source, its lines and its void reason remain in the
audit trail. Voiding releases quantity, carrying value, merchandise, invoice total
and tax reservations so a replacement document can be captured. Posted credits
cannot be voided through this control. The supplier's original document number
remains unique even after voiding.

In Usage ledger, choose **Return unused supplies** against the original issue.
The remaining whole quantity is capped server-side across all prior returns.
Returned value uses cumulative proportional boundaries on the original issue's
integer cents; returning the full issue restores exactly its original cost.
The immutable issue is preserved, stock increases once, and accounting posts
Dr1280 / Cr5460. No PO receipt or payable is created. Stock can only return to the
original branch, under consumable stock adjustment authority.

Usage and Cost report show gross issues, unused returns and net consumption.
Date filters apply to the original issue date, including returns recorded later.
Registered asset groups use the asset ID even if its number changes. Reports
retain whole-unit quantities separately by consumable and UOM, and use JMD cents.

Purchasing control includes consumables approval, expected delivery, unbilled
receipt, supplier return and credit posting/available-credit actions. Its counts
cover the full filter; it reads original sources without schema initialization.
Closed documents are excluded and available posted credit is shown only to
Finance after applications and refunds. Missing evidence is reported as partial.
Actions open the specific source and preserve an active or uncertain draft.

Schema changes are additive: asset identity columns, immutable issue-return rows,
and immutable return/credit closure rows. Deployed return and credit CHECK states
are preserved; APIs expose both the original `source_status` and effective closed
status. All recovery mutations require actor-bound operation keys and enforce
current source branch, role and independence before replay.

Run `node scripts/certify-consumables.cjs` for the connected isolated certificate.
It creates temporary local staff, records and accounting evidence without inherited
production credentials, including void/replacement credit capture, unused returns,
closure reservation release, source-sync replay and unchanged retail inventory.
