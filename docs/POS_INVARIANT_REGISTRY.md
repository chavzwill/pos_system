# POS Invariant Registry

Last updated: 2026-09-10

`UNVERIFIED` means enforcement has not yet been independently proven. It is not an assertion of safety.

| ID | Invariant | Authority / enforcement point | Failure consequence | Proof / state |
|---|---|---|---|---|
| I-IDENT-01 | An employee cannot alter another employee's credentials without explicit elevated authority. | Server: dedicated employee credential routes; `lib/sessionAuth.js`; `security_manage`; elevated reauthentication | Account takeover / privilege escalation | VERIFIED on merged integration SHA `43f9599` by post-merge Runtime Certification #77 |
| I-IDENT-02 | Revoked/suspended employees cannot continue privileged sessions. | `lib/sessionAuth.js`; employee session revocation on credential/security/active changes | Unauthorized continued access | Credential-change revocation VERIFIED; full suspension/permission-revocation matrix remains Gate 1/2 review |
| I-MONEY-01 | A sale cannot settle twice. | Checkout transaction boundary; inventory reservation exists but request-level settlement idempotency is still under audit | Duplicate revenue/payment | Gate 1 IN PROGRESS |
| I-MONEY-02 | A refund cannot exceed eligible settled value, including the amount originally tendered by each payment method. | `retail_refund_settlements`; `lib/retail-refund-invariants.js` database tender-ceiling trigger; refund API validation | Financial loss/corruption | VALIDATING with `tests/gate1-refund-tender-concurrency.spec.js` |
| I-MONEY-03 | A credit note cannot increase a receivable accidentally. | UNVERIFIED | Customer balance corruption | Gate 1 |
| I-MONEY-04 | Currency and rounding are deterministic. | UNVERIFIED | Reconciliation drift | Gate 1 |
| I-MONEY-05 | UOM price conversion preserves authoritative economics. | UOM/retail guards exist; full authority map pending | Under/overcharge | Gate 1 |
| I-STOCK-01 | Physical stock cannot be created or destroyed without an attributable movement. | Inventory movement/adjustment/writeoff guards exist; independent proof pending | Phantom/missing stock | Gate 1 |
| I-STOCK-02 | Reservation, on-hand, available and in-transit quantities cannot contradict one another. | Inventory reservation subsystem; broader cross-workflow authority still under audit | Oversell / bad availability | Gate 1 IN PROGRESS |
| I-STOCK-03 | UOM conversion preserves base quantity within configured precision. | Shared UOM engine/guards; release checks exist | Quantity drift | Gate 1 independent adversarial proof pending |
| I-STOCK-04 | An old event cannot overwrite newer authoritative quantity. | UNVERIFIED | Stale stock corruption | Gate 1/2 |
| I-PROC-01 | Receiving the same PO event twice cannot double inventory. | Purchase receiving controls exist; independent replay proof pending | Duplicate stock/cost | Gate 1 |
| I-PROC-02 | Supplier invoice/payment duplication cannot silently create duplicate liability. | Loss-prevention routes exist; independent proof pending | Duplicate payable/payment | Gate 1 |
| I-PROC-03 | Landed-cost allocation reconciles to authoritative cost. | Landed-cost module exists; independent proof pending | COGS/margin error | Gate 1 |
| I-RET-01 | The same sold item quantity cannot be returned twice, including two simultaneous requests. | `lib/retail-return-invariants.js` database trigger validates original-sale lineage and aggregate returned quantity at authoritative insert | Over-refund / stock duplication | VALIDATING with `tests/gate1-return-concurrency.spec.js` |
| I-RET-02 | Restocking and financial resolution remain consistent. | Return/refund/stock guards + authoritative return allocation | Stock-money divergence | Gate 1 IN PROGRESS |
| I-RENT-01 | One physical asset/unit cannot be simultaneously rented beyond availability. | Rental controls exist; authority proof pending | Double rental / custody loss | Gate 1 |
| I-RENT-02 | Deposit/settlement replay cannot duplicate money movement. | Rental settlement controls exist; replay proof pending | Duplicate money movement | Gate 1 |
| I-RENT-03 | Chain-of-custody transitions preserve identity and evidence. | Rental logistics/loss-prevention capabilities exist | Asset loss / disputed custody | Gate 1 |
| I-WO-01 | A work order cannot complete while required work/QA is incomplete. | Work-order completion hardening + service tests exist | Unsafe/incomplete repair | Gate 1 independent proof pending |
| I-WO-02 | Technician time cannot be attributed to conflicting active jobs. | Work-order time tracking server rule exists | Payroll/utilization corruption | Gate 1 independent proof pending |
| I-WO-03 | Parts consumption and purchasing remain traceable to the job. | Work-order parts/procurement flow exists | Cost/stock trace gap | Gate 1 |
| I-COMM-01 | Organization purchasing authority belongs to individual authenticated members, never shared credentials. | Commercial membership implementation requires authority review | Approval/audit impersonation | Gate 1/2 UNVERIFIED |
| I-COMM-02 | Approval limits and purchasing policy are server-authoritative. | Commercial controls require independent review | Spend-policy bypass | Gate 1/2 UNVERIFIED |
| I-AUDIT-01 | Sensitive financial, inventory, credential, approval and permission mutations leave immutable attributable evidence. | Security audit subsystem verified for credential lifecycle; other domains require audit sweep | No forensic accountability | IN PROGRESS |
| I-DOC-01 | Concurrent document-number allocation cannot issue the same identifier twice. | `lib/nextNumber.js` atomic sequence UPSERT | Collisions / failed or ambiguous documents | VERIFIED on merged integration SHA `43f9599` by Runtime Certification #77 |
| I-AUTH-03 | Authentication infrastructure failure must fail closed. | `lib/sessionAuth.js` | Auth bypass during database/auth faults | VERIFIED on merged integration SHA `43f9599` by Runtime Certification #77 |

Every Gate 1 workflow must add its adversarial-matrix evidence to this registry or a linked test/evidence record before being called VERIFIED.
