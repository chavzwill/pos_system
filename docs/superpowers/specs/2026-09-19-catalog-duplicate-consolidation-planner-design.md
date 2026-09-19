# Catalog Duplicate Consolidation Planner — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ e0328c94bf56d33badaf5127cbece648ff46b3f9

## Goal
Help staff safely prepare a confirmed duplicate group for consolidation without changing any product, stock, pricing, history, website, purchasing, or transaction data.

## Experience
- A Plan consolidation action appears only after staff have confirmed the duplicate candidate.
- The planner compares each exact product record side by side.
- It shows stock by branch, historical reference counts, important master-data values, and differences that must be decided before any future merge.
- It identifies the most established record as a suggested primary using transparent evidence: historical references first, then master-data completeness, then lowest product id.
- It states clearly that the suggestion is not an automatic merge decision.
- It exposes blockers such as stock on more than one duplicate record, conflicting SKU/barcode/UOM/category/brand/supplier, or mixed lifecycle state.

## Invariants
1. Planner is read-only.
2. Planner only accepts a live candidate currently reviewed as confirmed_duplicate.
3. Candidate membership must still match the exact fingerprint.
4. Internal table names never appear in staff-facing output.
5. Historical references are counted, not rewritten.
6. Stock is never combined, moved, adjusted, or retired.
7. Suggested primary is deterministic and transparent, but staff retain the decision.
8. No consolidation endpoint is introduced in this slice.
