# Catalog Duplicate Consolidation Preview — Plan
1. Add RED contract for confirmed-candidate eligibility, read-only impact analysis, human dependency domains and UI.
2. Add catalog authority to revalidate the exact candidate and build per-product stock/master-data/reference evidence.
3. Classify internal reference tables into staff-facing business domains without exposing schema names.
4. Add blockers/warnings for stock, barcode, UOM, price/cost, active-state and distributed-history conflicts.
5. Add inventory-authorized GET endpoint.
6. Add “Review consolidation” action only for confirmed duplicates and a read-only impact modal.
7. Add runtime certification proving eligibility, reference aggregation, blocker detection and non-mutation.
8. Run full catalog contracts, syntax wall, audit and diff checks; commit, PR and exact-head CI before merge.
