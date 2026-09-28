# Universal Predictive Lookup Implementation Plan

## Objective
Implement one governed predictive lookup capability that progressively enhances search and lookup fields across the POS. The first production slice establishes the shared engine, product/supplier/customer adapters, browser controller, permanent contracts, and migrations for the highest-frequency purchasing/catalog/customer fields.

## Baseline and branch
- Certified integration baseline: 569bbc200b8c4144c04828654a880adc6fe3ff5c
- Working branch: feature/universal-predictive-lookup
- Design spec: docs/superpowers/specs/2026-09-17-universal-predictive-lookup-design.md
- Preserve all existing workflows and endpoints until their consumers are proven migrated.

## Invariants
- Search is read-only and never mutates business state.
- Selection returns canonical entity identity, never arbitrary display text.
- Server derives authorization from authenticated identity.
- Client filters may narrow authority but never widen it.
- Exact identifiers outrank aliases, names, and fuzzy matches.
- Ambiguous exact identifiers are surfaced, never guessed.
- Raw SQL/stack/internal errors never reach staff.
- Branch-sensitive metadata is returned only where authorized.
- Result limits and fuzzy candidate sets are bounded.
- Existing owning modules remain responsible for actions.
## Phase 1 — Core engine and contract
1. Add a permanent predictive-lookup contract script and wire it into npm check:syntax.
2. Prove RED against the current codebase.
3. Add lib/predictive-lookup.js with normalization, ranking, safe result shaping, permission/domain policy, and bounded matching helpers.
4. Add routes/predictive-lookup.js exposing GET /api/predictive-lookup.
5. Register the route in server.js and syntax wall.
6. Add safe structured error handling with request correlation support.

### Initial domains
- product
- supplier
- customer

### Product evidence
Match SKU, barcode, model number, product name, description tokens, supplier-linked identity where safely available, and reviewed aliases. Exact SKU/barcode/model matches must sort first.

### Supplier evidence
Match supplier number, supplier name, contact name, phone/email where permitted, and reviewed aliases.

### Customer evidence
Match customer number, full name, phone/email where permitted. Do not expose notes, balances, credit details, or sensitive fields through search results.
## Phase 2 — Alias evidence
7. Add a governed lookup_aliases table with entity type/id, normalized alias, status, evidence source, creator, timestamps, and uniqueness protection.
8. Search consumes only reviewed/approved aliases.
9. Add optional lookup-selection evidence for future Inventory Cleanup review without logging protected raw queries.
10. No repeated search or selection may silently approve an alias.

## Phase 3 — Shared browser controller
11. Add public/predictive-lookup.js implementing:
   - debounce and AbortController cancellation
   - accessible combobox/listbox behavior
   - keyboard arrows, Enter, Escape
   - pointer/touch selection
   - loading, empty, and safe failure states
   - stale-response suppression
   - exact scanner-style resolution
12. Add public/predictive-lookup.css and load both in the main shell.
13. Use declarative data attributes/config so fields opt into domains rather than reimplementing search.

## Phase 4 — First migrations
14. Migrate the shared catalog picker from its private search mechanics to the shared predictive engine.
15. Migrate quote/customer lookup in catalog-workflow-enhancer.js.
16. Migrate sales-workspace customer lookup.
17. Add predictive supplier selection and product lookup to purchasing high-frequency entry points without changing purchase authority.
18. Preserve current endpoints as compatibility fallbacks until tests prove parity.
## Phase 5 — Verification
19. Add deterministic ranking tests: exact ID, prefix, alias, exact normalized name, token prefix, bounded typo tolerance.
20. Add permission and branch-isolation tests.
21. Add malformed domain, wildcard-like input, long input, duplicate alias, ambiguous exact identifier, inactive record, and stale request tests.
22. Add browser contract checks for ARIA combobox/listbox semantics and no raw caught error rendering.
23. Run focused predictive lookup contracts.
24. Run client syntax and server syntax checks.
25. Run the complete npm run check:syntax wall.
26. Run relevant Playwright runtime suites for purchasing, sales/customer, security boundaries, and business integrity.
27. Commit coherent GREEN checkpoints.
28. Open a PR only from a clean exact head.
29. Require exact-head Runtime Certification before merge.
30. Merge with expected-head protection.
31. Require exact post-merge Runtime Certification before establishing a new certified baseline.

## Deferred follow-on domains
POs, invoices/transactions, serial/lot identities, repairs, rentals/assets, branches/locations, employees, dispatch records, and optional global command search all consume the same engine after the first slice is certified.

## Definition of done for first slice
The shared engine is authoritative for migrated product/supplier/customer predictive fields; exact identifiers are fastest and highest ranked; canonical identity is returned; permissions are preserved; errors are safe; search is non-mutating; the browser controller is accessible and cancellation-safe; compatibility remains intact; and exact feature-head plus post-merge certification both pass.
