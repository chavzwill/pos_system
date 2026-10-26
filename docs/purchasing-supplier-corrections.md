# Supplier returns and credits

Open **Receiving review → Returns & credits** for the original purchase order.
Finance can reopen a credit from **Supplier Bills & Payments → Credits and refunds**.

1. Receiving requests a return against one original receipt, with base quantity,
   reason, source stock status, bin and any original serial or lot identities.
2. A different employee with purchasing approval permission approves or rejects it.
   Requesting and approving do not change stock or accounts payable.
3. Receiving confirms physical dispatch with a reference. This removes stock once
   at its evidenced moving-average carrying value and records a return-clearing journal.
4. Receiving or Finance captures the supplier's credit document against the original
   posted invoice and its receipt allocation. Capture reserves settlement quantities
   but does not change stock or AP. An erroneous unposted capture can be voided.
5. Finance reviews and posts the credit after dispatch. It reduces AP, reverses
   attributable return clearing and eligible tax, and requires a reason for a
   merchandise versus carrying-value difference. It applies to the original invoice
   up to that invoice's remaining balance. Excess stays available for another
   same-supplier, same-branch invoice or a confirmed supplier refund.

Cash paid and credit applied remain separate fields. Net AP includes all posted
credits and cash payments, including unapplied cash. A negative net AP is retained.
For branch reports, allocated cash follows the invoice branch; unapplied cash
follows its recorded payment branch. Legacy unapplied cash without a branch is
included in the overall total rather than attributed to a guessed branch.

## Replacement deliveries

Receive replacement goods normally against a separate approved PO. Finance then
links the actual replacement receipt in the return review. Linking reconciles
clearing and any explained cost difference; it does not receive goods again or
create a payable. Credit captures and replacement links share the returned quantity
ceiling. Replacement-covered receipt quantities are excluded from ordinary invoice
matching and the unbilled-receipts queue.

## Accounting sources

| Action | Debit | Credit |
| --- | --- | --- |
| Dispatch return | 1270 Supplier Return Clearing | 1200 Inventory |
| Post supplier credit | 2000 Accounts Payable | 1270 clearing; eligible 1400 tax or 5450 tax expense |
| Merchandise/carrying difference | 5280 Supplier Return Variance as needed | 5280 as needed |
| Refund received | 1000 Cash or 1010 Bank | 2000 Accounts Payable |
| Reconcile replacement receipt | 1250 Purchasing & Receiving Clearing; variance as needed | 1270 return clearing; variance as needed |

Applying an already-posted credit to another invoice has no second GL entry.
Source sync replays the same journals and exposes unsettled return-clearing amounts.
Immutable original receipts, PO received quantities and supplier invoice amounts
are preserved. Operation keys protect all correction writes and authorization is
checked before returning a prior result. Interrupted actions retain their exact
payload and key in the employee's saved draft until confirmation is reloaded.

## Supported scope

Returns require original-branch retail stock with full valuation evidence and
quantities supported to four decimal base units. Services, rental/fleet stock,
variants, legacy/unvalued quantities and changed historical base units are blocked.
Available serials/lots must belong to the original receipt and exact location.
Restricted tracked identities are blocked; untracked inspection returns consume
immutable original hold evidence, and hold release moves only its remainder.

Credit reversals of freight, duty, other landed costs or landed tax are not supported.
Recoverable or expense tax requires the original classification and component cap.
Late landed-cost allocation is blocked if an adjustment or transfer has affected
that product/branch pool: the existing historical replay cannot account for those
movements safely. The allocation transaction rolls back, including layer evidence.

## Verification

Run `node scripts/certify-supplier-returns.cjs` for the isolated real-server
receipt/return/credit/payment/refund/replacement certificate. It creates its own
database and staff sessions and uses no production credentials or records.
The existing purchasing lifecycle certificate, isolated Node regression suites,
responsive browser tests and `npm run vercel-build` also pass.
