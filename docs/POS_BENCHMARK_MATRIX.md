# POS Benchmark Matrix

Last updated: 2026-09-10

This is the operational benchmark framework, not a claim that Total Tools currently exceeds these products. Current official-source capability research is required at the relevant product gate before any `SURPASS VERIFIED` result.

| Area | Relevant benchmark set | Total Tools target | Current state |
|---|---|---|---|
| Register speed / retail checkout | Shopify POS, Square for Retail, Lightspeed Retail | Faster purpose-built cashier flow with server-authoritative money/stock and practical touch/keyboard operation | NOT STARTED independent benchmark |
| Inventory / multi-location | Shopify, Square, Lightspeed, strong WMS patterns | Exact UOM/base quantity, reservations, movements, transfers, counts, cost and explained rebalancing | Gate 1/3 pending |
| Procurement | Lightspeed + lightweight ERP/procurement conventions | Demand -> RFQ/offers -> approval -> PO -> pickup/receiving -> supplier liability with replay-safe traceability | Gate 1/3 pending |
| Equipment repair | RepairDesk + service-management conventions | Machine identity, diagnostics, tasks, technician time, parts, QA, approval, billing and lifetime service record | Gate 1/3/4 pending |
| Rental | Rental/service-management conventions | Physical-unit availability, custody, deposits, settlement, missing-asset recovery and profitability | Gate 1/4 pending |
| Commercial accounts | B2B commerce + lightweight ERP controls | Individual organization identities, limits, approvals, PO refs, budgets/projects, negotiated price, credit and immutable history | Gate 1/4 pending |
| Operations intelligence | Retail/WMS/service exception management | Actionable exceptions with evidence and direct resolution, not passive chart walls | Gate 3/4 pending |
| Security / credential lifecycle | Modern workforce/admin security practice | Separate self/admin credential flows, elevated reauth, session revocation, least privilege and attributable audit | Gate 0 VALIDATING |
| Reliability | Mature transactional retail/ERP practice | Idempotent/replay-safe mutations, stale-write protection, recoverable partial failure, explicit authority | Gate 1/2 pending |
| Release safety | Mature SaaS/enterprise engineering practice | Exact-head automated runtime certification required before protected merge/release | Workflow IMPLEMENTED; repository enforcement BLOCKED |
| Offline | Modern POS offline patterns | Immutable local operation journal + reconciliation + conflict UI; payment offline risk treated separately | DEFERRED Gate 5 |
| Omnichannel | Shopify/Square/Lightspeed ecosystem expectations | One customer/order/inventory authority across POS, web, portal and future SellSync/WhatsApp | DEFERRED Gate 6 |

## Benchmark method

At each gate:

1. Use current official vendor/product documentation first.
2. Record the user job and measurable convention, not marketing adjectives.
3. Identify useful convention, observed friction/legacy baggage and Total Tools opportunity.
4. Compare rendered/runtime behavior, not source-code descriptions.
5. Require measured or directly observable evidence before `SURPASS VERIFIED`.

Broad competitor research is deliberately deferred until it can change a concrete Gate 1/3/4 decision; Gate 0 security and release blockers remain the current critical path.