# Rental Consumables Economics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Show evidenced rental asset contribution including net consumables without double-counted maintenance.
**Architecture:** Optional-source cost reader plus immutable maintenance cost reviews, integrated into the existing fleet economics API and screen.
**Tech Stack:** Existing Express, libsql, plain browser JavaScript, Node tests and Playwright.
**Spec:** docs/superpowers/specs/2026-10-25-rental-consumables-economics-design.md

## Global Constraints

No new dependencies or services. JMD cents. Immutable cost sources. Current asset
branch scoping. No stock/AP/GL mutation. Draft PR only during implementation.

## Review Focus

- Legacy text must never be attributed to a guessed asset.
- A transferred asset retains original-branch costs without exposing other assets.
- A changed maintenance total or concurrent review must not accept a stale split.
- Missing lazy sources and unresolved overlaps must not appear as complete zero costs.
- Lost responses must retry the same payload/key without overwriting active work.

### Task 1: Asset cost evidence and Finance review

Files: new lib/rental-consumable-economics.js and routes/rental-consumable-economics.js;
modify routes/rental-asset-lifetime-economics.js, routes/inventory-traceability.js and
routes/rental-asset-economics-bootstrap.js; test tests/rental-consumable-economics.test.cjs.

- [x] Write API tests: gross101 - returns34 = net67; review a150-cent maintenance
  bill as100 cents external; contribution1000 - acquisition200 - external100 - net67 =633.
- [x] Confirm failing feature assertions before implementation.
- [x] Implement readAssetCosts(ex,assetId), review schema and scoped keyed review route.
  Use source IDs, BigInt/safe integer cent sums and optional table/column detection.
- [x] Integrate net cost into existing economics; null contribution pending overlap
  review; expose cost coverage and evidence. Finance-only review; immutable append
  with expected source cents/prior review ID; authorize before replay.
- [x] Test missing schemas, transferred assets, partial/full returns, unsafe or excess
  return values, legacy references, deny foreign/unassigned/API-key roles, stale
  cost and competing review submissions. Original source totals remain unchanged.

### Task 2: Fleet source evidence and review controls

Files: public/rental-fleet-management.js and scoped CSS in public/ui-workspaces.css;
test tests/rental-consumable-economics-ui.spec.js.

- [x] Add failing browser checks for exact cents and review-required contribution.
- [x] Add gross/returned/net facts, explicit scope/limitations and named source panel.
- [x] Add Finance-only review with optimistic snapshots, reason/reference and stable
  operation identity; lock unknown payload, retry same operation, guard in-flight close.
- [x] Verify source loading failures, role controls, stale/unknown outcomes and keyboard
  use at390/768/1440 widths. Visually inspect saved screenshots.

### Task 3: Connected verification and publication

- [x] Extend isolated consumables certificate to read asset costs and source replay.
- [x] Run relevant Node suites, fleet/purchasing browser regressions and vercel-build.
- [x] Update source contracts, cache version and operating notes as required.
- [x] Get code review, fix blocking findings and rerun affected checks.
- [ ] Publish exact tested tree as draft PR; no merge or deployment in this phase.


## Execution record

Implementation uses the existing fleet surface without paid design generation or
new dependencies. The review model covers both maintenance and manual direct-cost
sources because either could include the same stock supplies. Bulk source reads
preserve full-history sums and current-asset branch scope.

Review found three UI blockers: request headers overwrote JSON Content-Type; the
work-protection registration used `busy` instead of `saving`; and new reviews could
be created before saved-draft hydration succeeded. Each was reproduced in a failing
browser test, fixed, and tested with the real work-protection module. No additional
blocking backend finding was reported. Source mutation, funds and production data
remain outside this reporting/review change.
