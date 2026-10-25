# Durable Purchasing Drafts Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Recover purchasing entries after app closure without duplicating business submissions.
**Architecture:** Session-owned revision-controlled libSQL snapshots, loaded into the existing in-memory helper. Debounced saves and awaited submission checkpoints share a serialized queue.
**Tech Stack:** Existing Express, libSQL, browser JavaScript, Node tests and Playwright.
**Spec:** docs/superpowers/specs/2026-10-24-durable-purchasing-drafts-design.md

## Global Constraints

- No browser storage, offline transaction queue, new dependency or paid service.
- 20 live drafts per employee/branch; 256 KiB per draft; seven-day expiry.
- Draft writes never change stock, invoices, payable records or permissions.

## Review Focus

- A stale tab must not overwrite or resurrect another tab's cleared draft.
- Account/branch switches and permission removal must not reveal another scope.
- Draft-save failure must stop a business submission before it is sent.
- Pending identities must survive refresh and retain exact retry contents.
- Last unsaved edits must be described honestly during server outages.

### Task 1: Authenticated draft repository

Files: create routes/purchasing-drafts.js and tests/purchasing-drafts.test.cjs; register in server.js.
Interface: GET /api/purchasing-drafts -> {drafts:[{key,value,revision,expires_at}]};
PUT /:key {value,revision} -> {revision,expires_at}; DELETE /:key {revision} -> {revision}.
- [x] Add failing Node tests for CRUD, staff scope, permissions, expiry, bounds and stale revisions.
- [x] Run node --test tests/purchasing-drafts.test.cjs; verify missing implementation fails.
- [x] Implement lazy schema, transactional CAS and deletion tombstones.
- [x] Run the same tests; require all pass.

### Task 2: Durable client and submission checkpoints

Files: modify public/work-protection.js and the three purchasing modules; test tests/durable-work-protection.spec.js.
Interface: helper.ready() hydrates current scope; helper.put/clear enqueue snapshots;
helper.checkpoint(key) flushes that key or rejects; helper.status(key) exposes save state.
- [x] Add failing browser cases for reload, conflicts and checkpoint outage.
- [x] Implement coalesced serialized saves, owner generations, save-state events and clear queue.
- [x] Await hydration in purchasing opens and checkpoint before every supported business write.
- [x] Ensure capture/select values and receiving prices remain frozen on replay.
- [x] Run durable and existing work-protection/PO/matching browser tests.

### Task 3: Release readiness

Files: update recovery documentation and asset versions/contracts.
- [x] Document lifetime, sign-out behavior and unsaved-change limits; inspect rendered phone layout.
- [x] Run npm run vercel-build, Node draft tests, relevant browser specs and git diff --check.
- [x] Publish the exact verified tree as a draft PR with validation and limitations.
