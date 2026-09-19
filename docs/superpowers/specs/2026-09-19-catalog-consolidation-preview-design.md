# Catalog Duplicate Consolidation Preview — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ e0328c94bf56d33badaf5127cbece648ff46b3f9

## Goal
Before any duplicate product can ever be consolidated, give staff a read-only impact review that shows what each record owns, where stock exists, which business history depends on it, and what conflicts must be resolved.

## Eligibility
Only an exact duplicate candidate currently reviewed as **Confirm same item** may open consolidation review. If membership changes or the review is no longer confirmed, the preview fails closed.

## Preview
For each candidate product show:
- product identity: name, SKU, barcode, lifecycle, active/retired state
- price, cost, unit, category, brand and supplier identity
- global and branch stock
- configured base UOM when explicitly present
- linked-record counts summarized into human business areas (Sales & returns, Purchasing, Inventory & transfers, Quotes, Service & repairs, Rentals, Website/integrations, Other history)

## Blockers / warnings
The preview surfaces rather than resolves:
- physical stock present on any candidate
- different non-empty barcodes
- conflicting explicit base units
- different selling prices or costs
- active vs retired record differences
- history spread across more than one candidate

## Invariants
1. Preview is read-only. It must never relink, delete, retire, merge, transfer, adjust or rewrite anything.
2. Raw database table names are not returned to staff.
3. Unknown dependency tables are counted under Other history rather than silently ignored.
4. Historical references remain attributable to their current product until a later, separately governed consolidation workflow exists.
5. No canonical/surviving product is selected automatically.
6. Exact confirmed candidate fingerprint is revalidated on every preview.
