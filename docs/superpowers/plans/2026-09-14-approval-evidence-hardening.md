# Approval Evidence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce immutable, non-erasable approval evidence at the database boundary without changing staff approval workflows.

**Architecture:** Harden `ensureApprovalRoutingSchema()` so fresh databases no longer declare cascading approval-event deletion and all databases install protective triggers that reject event mutation/deletion and parent approval deletion when evidence exists. Prove the behavior with a dedicated runtime test and a static schema contract, then run the existing full release certification wall.

**Tech Stack:** Node.js 22, JavaScript, libSQL/SQLite-compatible SQL, Playwright runtime tests, GitHub Actions Runtime Certification.

**Spec:** `docs/superpowers/specs/2026-09-14-approval-evidence-hardening-design.md`

## Global Constraints

- Preserve all existing staff approval workflows and Guide Me behavior.
- Do not expose raw SQL/database errors to staff-facing APIs.
- Existing databases must gain protection without destructive table rebuilds.
- Fresh databases must not declare approval-event `ON DELETE CASCADE`.
- SmartCommerce must remain untouched.
- Full release, Gate 0, Gate 1, supplier-integrity, and privileged-security walls must remain green.

---

### Task 1: Lock durability invariants in RED tests

**Files:**
- Create: `tests/approval-evidence-hardening.spec.js`
- Create: `scripts/check-approval-evidence-hardening-contract.js`
- Modify: `package.json`
- Modify: `.github/workflows/runtime-certification.yml`

**Interfaces:**
- Consumes: `ensureApprovalRoutingSchema()` and existing public approval/Purchasing workflow.
- Produces: `npm run check:approval-evidence-hardening` and a dedicated runtime certification step.

- [ ] **Step 1: Write the runtime test**

Create a real Department + manager membership + Purchase Request, submit it so an approval/event exists, then directly attempt:

```js
await expect(db.execute({sql:'UPDATE approval_events SET notes=? WHERE id=?',args:['tampered',event.id]})).rejects.toBeTruthy();
await expect(db.execute({sql:'DELETE FROM approval_events WHERE id=?',args:[event.id]})).rejects.toBeTruthy();
await expect(db.execute({sql:'DELETE FROM approval_requests WHERE id=?',args:[approval.id]})).rejects.toBeTruthy();
```

Finally re-read both rows and assert the original event and parent still exist and the event notes were not changed.

- [ ] **Step 2: Write the static contract**

Require `lib/approval-routing.js` to contain three protective trigger names and reject `ON DELETE CASCADE` from the `approval_events` table declaration.

- [ ] **Step 3: Wire the contract and runtime test into certification**

Add `check:approval-evidence-hardening` to `package.json` and run it from syntax/release certification. Add the dedicated Playwright test before the full application release gate in `.github/workflows/runtime-certification.yml`.

- [ ] **Step 4: Run exact-head certification and verify RED**

Expected failure: destructive SQL succeeds because database protection is not yet installed. The failure must be in the new evidence-hardening test/contract, not test setup.

- [ ] **Step 5: Commit**

Commit only tests/contracts/CI wiring with message `test: require immutable approval evidence`.

### Task 2: Enforce immutable approval evidence

**Files:**
- Modify: `lib/approval-routing.js`

**Interfaces:**
- Consumes: existing schema bootstrap batch.
- Produces: database-enforced immutable events and parent deletion protection.

- [ ] **Step 1: Change fresh-table foreign-key behavior**

Replace the `approval_events` foreign key declaration so it no longer uses `ON DELETE CASCADE`.

- [ ] **Step 2: Add three idempotent triggers**

Add these statements to schema bootstrap:

```sql
CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_update
BEFORE UPDATE ON approval_events
BEGIN
  SELECT RAISE(ABORT, 'approval evidence is immutable');
END
```

```sql
CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_delete
BEFORE DELETE ON approval_events
BEGIN
  SELECT RAISE(ABORT, 'approval evidence is immutable');
END
```

```sql
CREATE TRIGGER IF NOT EXISTS trg_approval_requests_no_evidence_delete
BEFORE DELETE ON approval_requests
WHEN EXISTS (SELECT 1 FROM approval_events WHERE approval_request_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'approval request has immutable evidence');
END
```

- [ ] **Step 3: Run targeted certification**

Expected: static contract and `tests/approval-evidence-hardening.spec.js` pass while existing approval/Purchasing tests remain green.

- [ ] **Step 4: Commit**

Commit with message `fix: enforce immutable approval evidence`.

### Task 3: Release certification and protected merge

**Files:**
- No product changes unless a genuine regression is found.

**Interfaces:**
- Consumes: exact feature head from Tasks 1–2.
- Produces: certified integration merge SHA.

- [ ] **Step 1: Run complete Runtime Certification**

Require success for dependency audit, syntax/contracts, Guide Me terminology, credential recovery, secret encryption, approval evidence hardening, Purchasing approval adapter, full release gate, Gate 0, Gate 1, supplier integrity, and privileged security.

- [ ] **Step 2: Verify release lineage**

Compare `feature/approval-evidence-hardening` to `integration/pos-consolidated-2026-09-07`; require 0 behind and confirm only POS approval/CI/test/docs files changed.

- [ ] **Step 3: Open PR and require PR-head certification**

Open against `integration/pos-consolidated-2026-09-07`, wait for the PR-triggered exact-head Runtime Certification, and require complete success.

- [ ] **Step 4: Merge with expected-head protection**

Merge only with the exact certified feature SHA supplied as `expected_head_sha`.

- [ ] **Step 5: Require post-merge certification**

Require Runtime Certification success on the exact resulting integration merge SHA before claiming completion.
