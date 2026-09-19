# Catalog Remediation Queue — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ a511debe387bc7c9ac23bd997320fbde9e954b2a

## Goal
Turn Catalog Health from a long diagnostic list into a staff-friendly work queue without inventing fixes or performing hidden mutations.

## Experience
- Group multiple issues for the same product/category into one work item.
- Show Critical/High/Medium/Low priority counts in human language.
- Sort highest-risk items first with deterministic ordering.
- Filter by priority and issue type, and search by product/SKU/category.
- “Work next” opens the highest-priority record.
- Each work item shows what is wrong, why it matters, and the next safe action.
- Refresh re-evaluates live evidence; fixed items disappear naturally.

## Invariants
1. The remediation queue is read-only coordination over authoritative Catalog Health evidence.
2. It never changes product, stock, lifecycle, category, brand, supplier, or website data automatically.
3. Multiple issues for one record are grouped without losing individual issue evidence.
4. Priority derives only from issue severity; no fabricated risk score.
5. Exact product/category identity is preserved for navigation.
6. Duplicate-product groups stay explicit and are never auto-merged.
7. Queue output contains no internal dependency table names.
