# Catalog Quality & Lifecycle — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ 5c1fce25f2f3449331a5ad14ec51ce7dc1c911c2

## Goal
Help staff keep the product catalog trustworthy by exposing missing master data, stale activity, and explicit lifecycle classification without silently changing stock, purchasing, sales, or website availability.

## Lifecycle meanings
- active: normal catalog item.
- discontinued: do not treat as a normal replenishment candidate; existing stock may still be sold or transferred.
- obsolete: item needs controlled review for retirement, write-off, transfer, or other disposition.
- retiring a product remains a separate governed action that sets products.active=0.

## Invariants
1. Lifecycle classification never changes physical stock.
2. Lifecycle classification never silently retires, disables online sale, or mutates purchasing records.
3. Every lifecycle change requires a meaningful reason and authenticated employee evidence.
4. Concurrent lifecycle changes fail closed with stale-state protection.
5. Catalog Health identifies blank SKU, missing UOM, missing barcode, stale activity, discontinued zero-stock records, and obsolete stock.
6. Stale activity is advisory and transaction-backed; it never auto-labels a product obsolete.
7. Existing historical references remain intact.
