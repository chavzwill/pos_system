# Website Promotion Sync & Consolidation Continuity — Design
Date: 2026-09-20
Base: integration/pos-consolidated-2026-09-07 @ 0184c1de00a4e6be4de78b0b665b5cb29f16d282

## Goal
Let Marketing manage promotions once in the POS and publish a safe, deterministic projection to the website without breaking a campaign when duplicate products are consolidated.

## Invariants
1. POS promotion definitions remain authoritative.
2. Product-scoped promotions follow the canonical survivor when duplicate products are consolidated.
3. Consolidation migrates current promotion scope only; it does not rewrite historical transactions.
4. Promotion scope migration is idempotent when survivor and duplicate were both already assigned.
5. Website export never exposes promotion usage counts, internal review evidence, employee identities, or raw database errors.
6. Website export includes enough information for display and scheduling, but final checkout validation remains authoritative.
7. Active campaigns may be live, scheduled, or ended; the website receives the explicit derived status.
8. Inactive campaigns are excluded by default and included only when explicitly requested for sync/reconciliation.
9. Product scope exports stable canonical product IDs and SKUs; category scope exports category IDs and names.
10. Contract version changes when the commerce payload changes.

## Website projection
GET /api/commerce-sync/promotions returns:
- contract_version / generated_at / checkout_authoritative=true
- promotions[]
- safe campaign fields: id, name, description, type, value, min_purchase, applies_to, start_date, end_date, active, status
- scopes[] with product/category identity
- codes[] containing only code and active state

No times_used or usage_limit leaves the internal POS projection in this slice.
