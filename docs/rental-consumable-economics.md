# Rental asset cost evidence and contribution

Open Rentals → Fleet management. The asset detail shows the original acquisition
cost, core rental-line revenue, recorded maintenance bill total, reviewed external
maintenance, net consumables, other external costs and recorded lifetime contribution.
Amounts retain two JMD decimal places. Missing or unreviewed amounts are labelled;
they are not displayed as zero.

## Contribution calculation

Core rental revenue + explicit recoveries + actual sale/disposal value
− preserved acquisition cost − external maintenance − net consumables
− external direct costs/losses = recorded lifetime contribution.

Core revenue uses the authoritative rental-line fee, equally allocated per issued
unit for active or returned agreements. Pending, unissued and cancelled bookings do
not contribute revenue. This is not cash profit: separate rental credits/adjustments
are not inferred unless reflected in the line fee. Tax, financing, depreciation,
unrecorded costs and overhead remain outside this calculation.

Consumables use the immutable asset ID saved on each issue. Original issued cents
less unused returns at original cost give net consumption. Costs follow the asset
across branch transfers, regardless of the issue's original branch. Receipt costs
and catalog prices are not substituted, and free-text serial references are never
guessed into an asset identity. Quantities remain per consumable/UOM.

## Preventing maintenance overlap

A maintenance bill or manually recorded direct cost may already include issued
supplies. When an asset has consumable issues and positive manual costs, contribution
is withheld until Finance reviews the portion excluding separately issued supplies.
This also covers `other_direct_cost` and `unrecovered_damage_loss` events; recoveries
are kept separate.

Choose **Cost evidence**, then **Review maintenance cost** or **Review direct cost**.
Review the original source date, bill amount and reference. Enter the external
portion, a reason of at least ten characters and the supporting itemized reference.
For example, a JMD 500 bill containing JMD 200 of separately issued consumables has
JMD 300 external cost. The original bill remains JMD 500; contribution deducts the
JMD 300 external portion plus the authoritative net consumable cost.

Reviews append immutable rows, preserving the source total, prior review, reviewer,
reason and evidence. A changed source total makes a prior split stale. A competing
review also requires a source refresh. Finance can append a corrected review; no
original maintenance/event, inventory, payable or journal record is altered.

## Recovery and access

New reviews stay disabled until the signed-in employee's saved reviews have loaded.
A recovery failure offers a retry instead of replacing earlier work. Review drafts
are private to the employee and assigned branch, using the existing seven-day draft
service. A pending submission is checkpointed before posting. Unknown outcomes lock
the exact original body and operation key; **Retry same review** confirms that same
operation. Global navigation is blocked while a submission is in flight.

A known rejection keeps fields editable. **Refresh source** loads the current total
and prior-review snapshot before a corrected submission gets a new operation key.
An existing draft takes priority over starting a review of another source.

Staff with rental/report authority can inspect their current branch's assets and
source evidence; Finance authority is required to review cost splits. Missing branch
assignments fail closed unless staff have explicit cross-branch authority. API-key
sessions cannot use these staff report/review endpoints. Current source authorization
runs before operation replay, including after an asset transfers branch.

## Evidence coverage

The reader does not initialize consumables or cost-review schemas. Missing lazy
sources, unlinked historical issues and pending cost reviews are explicit. A missing
consumables or return source withholds contribution rather than assuming no cost.
The fleet list loads consumable/maintenance/direct-cost evidence in bulk for its
asset set. List results retain the existing 500-asset boundary.

Only actual asset-linked issues enter the calculation. Product-level historical
usage at the current branch remains unresolved and excluded; other unrecorded or
unlinked historical costs may also be missing. Evidence coverage is not a claim
that all economic costs have been recorded.

## Validation

`tests/rental-consumable-economics.test.cjs` verifies cent conservation, partial/full
returns, overlap reviews, immutable history, branch transfers, optional tables,
invalid costs, source mismatches, replay and concurrent/stale reviews, and exclusion
of pending/cancelled bookings. Browser tests use the real draft-protection module
for hydration-failure recovery and in-flight navigation guards.

`node scripts/certify-consumables.cjs` runs the connected isolated workflow with
local staff and records. It checks the exact asset's net issue cost and reviewed
maintenance contribution, source-authorized replay and unchanged stock, AP and
journal counts. It uses no production records or credentials.

## Fleet lists beyond one page

Fleet Management now requests 100 asset records per page, and offers **Load more assets** when older matching assets exist. The endpoint accepts `limit` (1–500), an opaque `cursor`, optional `branch_id`, `product_id`, `status`, and a case-insensitive, literal `search` across asset number, product, SKU and serial. Branch authorization applies on every page. Pagination walks `created_at DESC, id DESC`, so assets are never silently dropped at the previous 500-record limit. The screen sorts currently loaded assets by contribution; that is not a global profitability ranking until every page has been loaded. Search is performed on the server across the authorized fleet, not only visible cards. Refresh or filter changes start a new page sequence. The response reports `has_more` and `next_cursor` without inventing company-wide totals; searches do not mutate financial evidence.

The cursor is a position, not a time-frozen database snapshot. Assets edited or inserted during paging can change result membership; refresh for the current ledger. A separate audited aggregate/export remains necessary for company-wide profit reports. The API retains its existing incomplete-evidence and Finance review indicators for each asset.

## Rental revenue reconciliation (review candidate)

Asset core rental revenue now distinguishes original quoted rental fees from the final rental fee saved on a fully returned item. For `returned` agreements, the sum of final-versus-quoted line differences must match the agreement-level signed duration adjustment within one cent. This evidence condition also detects unsupported manual settlement overrides; when it fails, asset revenue and contribution are **withheld**, not replaced by zero or a guessed allocation. Partial returns on an otherwise active agreement likewise require reconciliation before contribution can be trusted. Active, not-yet-returned allocations retain their provisional original booked fees and explicitly state they are not received cash.

`buyout_closed` agreements now contribute the actual final rental fee recorded on their bought-out rental line. Sale/disposal proceeds remain separate, counted once through the existing asset disposition record; refundable deposits and tax adjustments are never treated as rental revenue. Missing final buyout evidence withholds contribution. Historic datasets without final-fee columns can display the original amount as legacy provisional evidence but are marked partial, not certified settled revenue. The calculation is read-only; it creates no refund, revenue journal, credit, stock movement, or payment. Existing line quantity allocation is retained. Where an override spans multiple asset lines without item-level evidence, Finance must reconcile the original settlement source rather than assigning it arbitrarily. An aggregate cash-profit report still requires posted payments, credits and overhead and is outside this change.
