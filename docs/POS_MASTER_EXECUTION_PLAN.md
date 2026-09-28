# POS Master Execution Plan

Last updated: 2026-09-10

## Authoritative program state

Repository: `chavzwill/pos_system`

Current consolidated base: `integration/pos-consolidated-2026-09-07`

Gate 0 remediation PR: #11, `gate0/security-release-certification` -> `integration/pos-consolidated-2026-09-07`

Do not treat the older `feature/total-tools-pos-upgrades` branch or merged PR #8 as the current integration authority. Re-verify branch, HEAD, PR, CI, deployment and database target at the start of each work session.

## North star

Transform the existing product into one coherent Commerce, Inventory, Procurement, Rental, Equipment Service, Commercial Account and Operations Intelligence operating system while preserving working capabilities and avoiding unnecessary architecture churn.

## Critical path

| Gate | Scope | State | Exit condition |
|---|---|---|---|
| 0 | Security and deployability | VALIDATING | Credential boundaries, PIN/auth, build, release certification, secrets/config and privileged audit have no P0/P1/core-P2 findings |
| 1 | Money and inventory proof | NOT STARTED | Money, stock, returns, purchasing, UOM, rental and repair financial invariants survive replay/concurrency/failure tests |
| 2 | Data authority and recovery | NOT STARTED | Authority map, migration state and recovery/reconciliation are verified for critical entities |
| 3 | UX/design reconstruction | NOT STARTED | Purpose-built role workspaces pass responsive, keyboard, touch and accessibility evaluation |
| 4 | Signature differentiators | DEFERRED | Machine Passport, Commercial Account OS, Inventory Intelligence and Operations Command Center are verified vertical slices |
| 5 | Offline/resilience | DEFERRED | Disconnect/reconnect journal and reconciliation tests pass; payment risk handled separately |
| 6 | Omnichannel | DEFERRED | Physical POS, web, portal and future conversational commerce share authoritative customer/order/inventory truth |
| 7 | Commercialization | DEFERRED | Stable product has validated packaging and tenant/isolation strategy where justified |

## Gate 0 current work

1. Administrative password reset: dedicated authority, actor password reauthentication, target session revocation, forced password change and immutable audit evidence.
2. Self password change: current-password proof, policy, target=self, session revocation and audit.
3. PIN credential mutation: old-PIN proof for self changes; `security_manage` + reason + actor password reauthentication for cross-user reset; target-session revocation and audit evidence.
4. Document numbering: replace read-then-increment allocation with an atomic sequence allocator used through the shared `nextNumber` helper.
5. Runtime certification: run the full `test:release-gate` and Gate 0 hostile credential/concurrency tests for material pull requests and pushes.
6. Protected merge enforcement: require the `Runtime Certification / release-gate` status on the authoritative release/integration branch. This remains UNVERIFIED until repository rules actually enforce it.
7. Secrets/config review and remaining privileged-mutation audit sweep.

## Non-goals until Gate 0 exits

Do not spend the critical path on dashboard redesign, new analytics, Machine Passport expansion, omnichannel expansion, SaaS conversion or broad architectural rewrites.

## Definition of done

A capability moves from IMPLEMENTED to VERIFIED only after end-to-end behavior, server authority, concurrency/retry behavior, relevant audit evidence, failure-state behavior and executable regression proof are demonstrated. `SURPASS VERIFIED` additionally requires a current benchmark and evidence of material superiority.