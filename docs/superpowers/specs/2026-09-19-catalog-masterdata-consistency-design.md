# Catalog Master-Data Consistency — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ 0b80207d83b95ff74c9bfe75f1b9afb475e950e0

## Goal
Extend Catalog Health beyond missing fields so staff can find internally inconsistent product records before they cause selling, purchasing, reporting, scanning, or website problems.

## Checks
- Product names with leading/trailing or repeated whitespace.
- SKU values with leading/trailing whitespace.
- Product base unit that disagrees with an explicitly configured UOM profile.
- Active physical stock with no valid positive selling price.
- Products that already have completed sales but still have broken critical master data (missing SKU, category, or unit).

## Invariants
1. These checks are diagnostics only; they never rewrite names, SKUs, units, prices, stock or history.
2. UOM inconsistency is reported only when an explicit product UOM profile exists.
3. Historical transaction evidence raises urgency but is never rewritten.
4. Stock with no valid selling price is surfaced as a high-priority operational exception.
5. Staff-facing messages explain the problem and next safe action without schema/table jargon.
6. Existing Catalog Health grouping/filtering automatically incorporates these issue types.
