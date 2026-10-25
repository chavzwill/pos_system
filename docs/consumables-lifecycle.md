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
usage records a rental product and equipment/unit reference; it does not alter
retail stock or automatically reconstruct an asset identity from free text.
Supplier tax reversal supports the original recoverable or expense classification;
landed-tax reversal is blocked. Separate approval and Finance authority remain
necessary even when all steps are opened from one workspace.
