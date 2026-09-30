# TT AI

TT AI is the internal intelligence layer for Total Tools. It is intentionally separate from authoritative POS, SpendOS and SmartCommerce state.

## v0.1 boundary

This first slice is **read-only**.

TT AI may:
- answer from cited product, machine, part, manual and operational evidence;
- query approved read tools;
- compare products and compatible parts;
- explain where a fact came from;
- return "unknown" when evidence is missing.

TT AI may not:
- adjust stock;
- create or approve payments;
- mutate AP/accounting;
- approve purchasing, repairs, rentals or commercial decisions;
- bypass POS employee permissions;
- invent product specifications, compatibility or company data.

All future write actions must re-enter the owning Total Tools system through its normal authenticated, permissioned, idempotent workflow and approval rules.

## Source authorities

- POS: staff identity/RBAC, products/SKUs, branches, stock, purchasing, rentals, repairs and operational approvals.
- SpendOS: analytical spend/cost/savings intelligence only.
- SmartCommerce: customer-facing commerce state and its canonical integration contracts.
- Manufacturer evidence: technical specifications, manuals, parts books, exploded diagrams, SDS and warranty evidence.
- TT AI knowledge layer: normalized relationships and retrieval metadata, never a replacement ledger.

## Product/equipment model

The foundation models:
- product -> brand/model/category/specification/application;
- product -> accessories/substitutes;
- machine model -> compatible parts/consumables/service requirements;
- asset instance -> model/serial/branch/service/repair references;
- part -> manufacturer number/alternate number/compatible models;
- evidence -> source, authority, timestamp and confidence.

## Run checks

```bash
cd tt-ai
npm test
npm run check
```

No paid service is required for this foundation. Model providers and production infrastructure are deliberately not configured yet.
