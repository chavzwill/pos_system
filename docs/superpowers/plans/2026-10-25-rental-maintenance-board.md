# Rental Maintenance Board Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, then one final code review.

**Goal:** Schedule, start and complete exact-asset maintenance with visible due work and source-safe costing.
**Architecture:** Separate plans plus immutable events/operations; reuse canonical rental_asset_maintenance for actual work and costing. New shell workspace with durable drafts.
**Tech Stack:** Existing Express/libsql/plain JavaScript/Node tests/Playwright; no new dependencies.
**Spec:** docs/superpowers/specs/2026-10-25-rental-maintenance-board-design.md

## Constraints and review focus

No stock/AP/GL writes. Current branch and staff authority before replay. Jamaica due
dates. No automatic recurring service assumptions. An active rental, concurrent
start, competing completion, transferred asset, legacy completion path, source cost
change, missing draft recovery or lost response must not bypass these controls.

### Task 1: Controlled actual work and planning sources

- [x] Write failing API tests for scheduling without taking assets offline, due
  counts, independent branches, start conflicts, exact source reuse, completion
  cost-once races/replays, stale snapshots, legacy episodes and closed lifecycle.
- [x] Add lib/rental-maintenance-board.js and routes/rental-maintenance-board.js.
  Plan version, linked maintenance ID, immutable operation/events; bounded queue.
- [x] Integrate route and reuse atomic completion in legacy endpoint; harden legacy
  direct starts so source changes cannot revive terminal assets or overlap open work.
- [x] Verify invalid/missing source/permission/branch/date/cents and cross-branch replay.

### Task 2: Operational board and protected controls

- [x] Add failing browser tests for source cards, filters, role controls, schedule,
  start/complete/cancel request evidence, actual JSON header and cost cents.
- [x] Add public/rental-maintenance-board.js, existing style extension and loader/
  fleet entry points. Four lanes and named assets, empty/error/partial states.
- [x] Add Finance-independent rental-management draft key to existing durable service.
- [x] Prove real draft hydration failure, uncertain exact retry, in-flight navigation
  guard, stale source refresh, keyboard and 390/768/1440 layout behavior.

### Task 3: Verification and handoff

- [x] Extend isolated certificate with plan/start/complete, original maintenance
  cost linkage and unchanged inventory/AP/GL sources.
- [x] Run Node/browser regressions, source contracts and vercel-build, inspect screenshots.
- [ ] Independent review remains pending: the requested review attempt was unavailable
  due to a usage limit. Do not treat this as independent approval.
- [x] Prepare the tested tree, operating notes and connected evidence for a draft PR.
  No deployment this phase.
