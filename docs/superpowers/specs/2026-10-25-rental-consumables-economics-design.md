# Rental consumables economics

Extend the existing fleet economics report under the user's instruction to proceed
with linking consumables and maintenance costs to each rental asset's earnings.
Use the existing Node/Express/libsql stack, existing fleet screen and JMD amounts;
add no dependency or paid service. Publish a verified draft PR before release.

## Approach

Add original asset-linked consumable issues less immutable unused returns to the
existing contribution calculation. Do not derive identities from free text or
use catalog prices. Track costs across branch transfers by immutable asset ID.
Keep historical unresolved product references separate and disclose missing sources.

A simple sum of maintenance plus consumables risks counting the same supplies twice.
Ignoring consumables hides operational cost. Instead use an explicit Finance review
of each maintenance bill or manual direct-cost event's non-consumable portion when the asset has issued supplies.
Preserve the original maintenance total and an immutable review history. Unknown
splits produce a review-required contribution, never a misleading zero or guessed
profit. This is the implementation choice; no change to stock, AP or GL.

## Records and behavior

- Consumables: gross issue cents, returned original-cost cents, net issue cents,
  separate quantities by consumable/UOM, original source IDs and branch evidence.
- Maintenance: original total, Finance-reviewed cost excluding consumables, source
  cost snapshot, reviewer/reason/evidence and prior review ID. Changed totals or
  concurrent reviews invalidate stale submissions; append corrections rather than edit.
- Economics: revenue and recoveries less acquisition, reviewed external maintenance,
  net consumables and other evidenced costs. Explain that this is recorded lifetime
  contribution, not cash profit or a complete overhead-inclusive profit statement.
- Branch-scoped staff reads; current asset branch authorizes a transferred asset.
  Finance alone reviews costs. Source authorization precedes actor-bound keyed replay.
- Keep existing maintenance/lifecycle behavior and original costs unchanged. Reads
  tolerate lazily absent consumables/review tables and disclose incomplete coverage.
- Extend the existing fleet facts and add a source-evidence/review panel. Stable
  retry identity and locked uncertain submission; prevent close/switch while posting.

## Verification

Isolated DB/API tests cover exact source cents, partial/full returns, legacy data,
branch transfers, missing schemas, overlap review and stale/replayed/concurrent
reviews. Browser tests cover actual visible totals, review controls, permissions,
unknown-response retries, escape/focus and phone/tablet/desktop layout. Run the
connected consumables certificate and existing purchasing regression tests. Review
before publishing. No production records or deployment during implementation.

Revenue scope: exclude pending/cancelled unissued agreements. Preserve the existing
core rental-line fee basis; do not infer separate refund or tax allocations.
