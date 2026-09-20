# Catalog Canonical Consolidation — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ 578135dae2efa1b3dd8487845c2f0bb2471a17be

## Goal
Finish the duplicate cleanup workflow with a controlled canonical consolidation that preserves history instead of rewriting it.

## Model
Staff explicitly choose one confirmed duplicate as the surviving catalog record. Every other member becomes a retired duplicate that points to the survivor through immutable consolidation evidence. Historical sales, purchases, repairs, rentals and other records keep their original product IDs. Old product identifiers become approved lookup aliases on the survivor so staff can still find the item.

## Invariants
1. Candidate must still be a live exact fingerprint and reviewed confirmed_duplicate.
2. Survivor must be an exact member of that candidate.
3. Every non-survivor must have zero global and branch stock before consolidation.
4. No product_id history is rewritten.
5. Survivor stock is never modified.
6. Non-survivors are retired atomically and cannot be reused as survivors elsewhere.
7. Consolidation mapping is immutable and append-only.
8. Old SKU/barcode/model/name evidence becomes approved aliases on the survivor without overwriting survivor master data.
9. Request requires explicit confirmation, meaningful reason, expected review version and authenticated actor.
10. Retry of the exact completed consolidation is idempotent.
11. Concurrent/stale attempts fail closed.
12. Security audit evidence is written in the same transaction.
