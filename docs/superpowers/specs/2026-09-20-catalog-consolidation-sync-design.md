# Catalog Consolidation Website Sync — Design
Date: 2026-09-20
Base: integration/pos-consolidated-2026-09-07 @ 7a11602d0e917dc9c06ef1d33c770f36fedafa8f

## Goal
Keep the website and other commerce consumers aligned when duplicate POS products are consolidated into one canonical survivor.

## Invariants
1. The POS remains authoritative for canonical product identity.
2. Website catalog export includes explicit duplicate → survivor mappings.
3. Consolidated duplicate products are never exported as sellable/active products.
4. Inactive catalog export can show tombstone identity, but stock on a tombstone remains zero.
5. Availability lookup for an old consolidated SKU resolves read-only to the active survivor and explicitly tells the caller canonicalization occurred.
6. Canonicalization never rewrites historical POS transactions or silently changes a write request.
7. Consolidation sync never leaks internal review reasons or employee identities to the storefront contract.
8. Commerce-sync failures return stable safe codes rather than raw database errors.
9. The contract version changes when the payload shape changes.

## Payload
/catalog returns product_consolidations with duplicate_product_id, duplicate_sku, survivor_product_id, survivor_sku, and consolidated_at.

When include_inactive=1, retired duplicate product rows expose consolidated_into_product_id and consolidated_into_sku.

GET /availability/:sku resolves an old duplicate SKU to the active survivor and returns requested_sku plus canonicalized=true. Normal survivor lookups return canonicalized=false.
