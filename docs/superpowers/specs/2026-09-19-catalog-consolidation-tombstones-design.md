# Catalog Consolidation Tombstones — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ a368ab4ceddfc1bbcb7c30f65aecedb2019a5b2c

## Goal
Make canonical duplicate consolidation durable after the merge. A retired duplicate must never quietly become an active or stock-bearing product again through product editing, bulk import, branch stock adjustment, variation editing, or a stale direct product ID.

## Tombstone model
A row in catalog_product_consolidations means duplicate_product_id is a permanent catalog tombstone that resolves to survivor_product_id.

## Invariants
1. Consolidated duplicate products cannot be reactivated.
2. Consolidated duplicate products cannot receive global stock, branch stock, or variation stock.
3. Consolidated duplicate product variations cannot be created, edited, activated, or stock-adjusted.
4. Consolidated duplicate master data is preserved as historical evidence; normal product editing is blocked.
5. Product APIs return a staff-safe CATALOG_PRODUCT_CONSOLIDATED error with survivor identity when a forbidden mutation targets a tombstone.
6. Database triggers independently prevent stock/reactivation even if a future route forgets the application guard.
7. Consolidation itself fails if a retiring duplicate has non-zero variation stock.
8. A canonical resolution helper returns the survivor for old direct product IDs without changing history.
9. Catalog Management shows the survivor and removes edit/reactivate/retire controls from consolidated tombstones.
10. Predictive lookup continues to find the active survivor through approved aliases rather than returning the retired duplicate.
