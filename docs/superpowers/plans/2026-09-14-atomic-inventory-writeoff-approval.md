# Atomic Inventory Write-Off Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inventory write-off approval a single atomic business transaction so stock, identity, valuation, accounting, financial authorization evidence, approval state, and audit evidence either all commit or all roll back.

**Architecture:** Keep `routes/inventory-writeoffs.js` as the sole authoritative mutation boundary. Convert the financial and traceability guards into preparation-only layers that attach normalized, non-secret context to the request; the core approval transaction revalidates live state and persists every terminal effect in one write transaction.

**Tech Stack:** Node.js 22, Express, SQLite/libSQL transaction executor, Playwright runtime tests, existing permission/PIN helpers, existing valuation and accounting posting helpers.

**Spec:** `docs/superpowers/specs/2026-09-14-atomic-inventory-writeoff-approval-design.md`

## Global Constraints

- Certified starting baseline is `32aa3b10801544ee9fb504b5656601a383a32cd1`.
- Existing route paths and staff-facing approval actions remain unchanged.
- Existing permission names remain authoritative.
- No destructive migration or historical reinterpretation.
- No raw SQL/provider/stack/exception text in staff responses.
- No force push, destructive history rewrite, unrelated refactor, or live-data mutation.
- Merge only after exact-head Runtime Certification, with expected-head protection, followed by exact integration-SHA certification.

---

## File Map

- `lib/inventory-writeoff-errors.js` — centralized stable write-off error codes, safe response mapping, internal logging.
- `routes/inventory-writeoff-financial-guard.js` — validate threshold/PIN/separation/evidence; attach `req.writeoffFinancialAuthorization`; never persist terminal evidence.
- `routes/inventory-writeoff-traceability-guard.js` — validate captured allocation shape; attach `req.writeoffIdentityApproval`; never finalize identity after response.
- `routes/inventory-writeoffs.js` — one authoritative approval transaction with live revalidation, identity finalization, stock mutation, valuation, journal, financial evidence, CAS approval, events, commit/rollback.
- `tests/inventory-writeoff-atomic-approval.spec.js` — adversarial RED/GREEN runtime proof of atomicity and concurrency.
- `scripts/check-inventory-writeoff-atomic-contract.js` — static contract that prevents reintroduction of post-response persistence/finalization and raw error leakage.
- Existing write-off-related contract scripts — update only where old assertions encode the superseded post-response mechanism.
### Task 1: Prove the Existing Partial-Commit Defects

**Files:**
- Create: `tests/inventory-writeoff-atomic-approval.spec.js`

**Interfaces:**
- Consumes: existing `/api/inventory-writeoffs/:id/approve` route, current financial/traceability middleware, test DB reset/bootstrap helpers already used by Playwright specs.
- Produces: permanent RED tests and deterministic fixture helpers used by later tasks.

- [ ] **Step 1: Add fixture helpers that create a branch, product, stock, employee/approver, pending write-off, optional serial/lot allocation, and high-value financial threshold without touching production data.**

```js
async function snapshotWriteoffState(db,{writeoffId,productId,branchId}) {
  return {
    writeoff:(await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[writeoffId]})).rows[0],
    branch:(await db.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]})).rows[0],
    movements:(await db.execute({sql:"SELECT * FROM stock_movements WHERE type='writeoff' AND reference=(SELECT writeoff_number FROM inventory_writeoffs WHERE id=?)",args:[writeoffId]})).rows,
    financial:(await db.execute({sql:'SELECT * FROM inventory_writeoff_financial_approvals WHERE writeoff_id=?',args:[writeoffId]})).rows,
  };
}
```

- [ ] **Step 2: Add a RED test that forces the financial-evidence insert to fail after the current core route commits and asserts the write-off/stock/movement/journal state changed despite HTTP 500.**

```js
test('financial evidence failure cannot leave an approved destructive write-off', async ({request}) => {
  const f=await seedHighValueWriteoff();
  await installFault('writeoff_financial_insert');
  const response=await approve(request,f);
  expect(response.status()).toBe(500);
  const after=await snapshotAll(f);
  expect(after).toEqual(f.before); // RED on current implementation
});
```

- [ ] **Step 3: Add RED serial and lot finalization-failure tests that assert aggregate stock, write-off status, valuation, journal, identity, movement, and events remain unchanged.**
- [ ] **Step 4: Run only the new spec and capture the expected failures as defect evidence.**

Run: `npx playwright test tests/inventory-writeoff-atomic-approval.spec.js --workers=1`
Expected: FAIL in the forced post-commit financial and identity cases while untouched business-rule controls continue to pass.

- [ ] **Step 5: Commit RED evidence only.**

```bash
git add tests/inventory-writeoff-atomic-approval.spec.js
git commit -m "test: expose writeoff approval partial commits"
```

---
### Task 2: Centralize Safe Write-Off Errors

**Files:**
- Create: `lib/inventory-writeoff-errors.js`
- Modify: `routes/inventory-writeoff-financial-guard.js`
- Modify: `routes/inventory-writeoff-traceability-guard.js`
- Modify: `routes/inventory-writeoffs.js`
- Test: `tests/inventory-writeoff-atomic-approval.spec.js`

**Interfaces:**
- Produces: `writeoffError(code, details?)`, `sendWriteoffError(res,error,context)`, `rollbackWriteoffQuietly(tx,context,error)`.
- Error codes: `WRITEOFF_NOT_FOUND`, `WRITEOFF_NOT_PENDING`, `WRITEOFF_SELF_APPROVAL_FORBIDDEN`, `WRITEOFF_STOCK_CHANGED`, `WRITEOFF_IDENTITY_CHANGED`, `WRITEOFF_FINANCIAL_AUTH_REQUIRED`, `WRITEOFF_FINANCIAL_AUTH_FORBIDDEN`, `WRITEOFF_CONCURRENT_DECISION`, `WRITEOFF_INTERNAL_ERROR`.

- [ ] **Step 1: Extend the runtime spec with safe-error assertions for forced storage/identity/accounting errors and confirm current raw `detail`/`e.message` behavior fails.**

```js
expect(JSON.stringify(await response.json())).not.toContain('SQLITE_');
expect(JSON.stringify(await response.json())).not.toContain('forced-internal-failure');
```

- [ ] **Step 2: Implement the centralized helper with staff-safe mappings and internal-only diagnostic logging.**

```js
function writeoffError(code,details={}) {
  const def=ERRORS[code]||ERRORS.WRITEOFF_INTERNAL_ERROR;
  return Object.assign(new Error(def.message),{code,status:def.status,...details});
}
function sendWriteoffError(res,error,context={}) {
  const def=ERRORS[error?.code]||ERRORS.WRITEOFF_INTERNAL_ERROR;
  console.error('[inventory-writeoff]',{...context,code:def.code,internal_error:String(error?.message||error)});
  return res.status(def.status).json({error:def.message,code:def.code});
}
```

- [ ] **Step 3: Replace touched-path raw exception responses with `sendWriteoffError`; preserve known business 4xx semantics through stable codes.**
- [ ] **Step 4: Run safe-error tests and syntax checks.**

Run: `node --check lib/inventory-writeoff-errors.js && node --check routes/inventory-writeoff-financial-guard.js && node --check routes/inventory-writeoff-traceability-guard.js && node --check routes/inventory-writeoffs.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add lib/inventory-writeoff-errors.js routes/inventory-writeoff-financial-guard.js routes/inventory-writeoff-traceability-guard.js routes/inventory-writeoffs.js tests/inventory-writeoff-atomic-approval.spec.js
git commit -m "refactor: centralize safe writeoff errors"
```

---

### Task 3: Make Financial and Identity Guards Preparation-Only

**Files:**
- Modify: `routes/inventory-writeoff-financial-guard.js`
- Modify: `routes/inventory-writeoff-traceability-guard.js`
- Test: `tests/inventory-writeoff-atomic-approval.spec.js`

**Interfaces:**
- Produces: `req.writeoffFinancialAuthorization = {required,authorizerEmployeeId,reason,evidenceReference,thresholdValue,evidenceThreshold,estimatedValue,valuationBasis}` with no PIN.
- Produces: `req.writeoffIdentityApproval = {trackingMode,allocations:[{serialId?,lotId?,quantity}]}` from durable captured allocation rows; it is advisory input only and must be revalidated transactionally.

- [ ] **Step 1: Add tests asserting guards attach normalized context, remove PIN/reason/evidence secrets from `req.body`, and do not insert financial evidence or mutate serial/lot state before the core transaction.**
- [ ] **Step 2: Remove financial guard `res.json` interception and the post-response `INSERT INTO inventory_writeoff_financial_approvals`.**
- [ ] **Step 3: Keep threshold/high-risk/PIN/separation/evidence validation but attach normalized context and call `next()`.**
- [ ] **Step 4: Remove traceability approval reservation/finalization response interception; load and normalize existing allocation evidence without changing serial/lot state.**
- [ ] **Step 5: Run focused tests proving guard execution alone has zero terminal database side effects.**
- [ ] **Step 6: Commit.**

```bash
git add routes/inventory-writeoff-financial-guard.js routes/inventory-writeoff-traceability-guard.js tests/inventory-writeoff-atomic-approval.spec.js
git commit -m "refactor: prepare writeoff approval evidence before commit"
```

---
### Task 4: Move Every Terminal Effect Into One Authoritative Transaction

**Files:**
- Modify: `routes/inventory-writeoffs.js`
- Test: `tests/inventory-writeoff-atomic-approval.spec.js`

**Interfaces:**
- Consumes: `req.writeoffFinancialAuthorization` and `req.writeoffIdentityApproval` as prepared evidence only.
- Produces: one committed approval result only after every physical, identity, financial, accounting, and audit mutation succeeds.

- [ ] **Step 1: Add/finish RED tests for valuation failure, accounting failure, stale stock, stale serial, stale lot, and concurrent double approval.**

```js
const [a,b]=await Promise.all([
  approve(request,fixture),
  approve(request,fixture),
]);
expect([a.status(),b.status()].sort()).toEqual([200,409]);
expect(await countWriteoffMovements(fixture.writeoffId)).toBe(1);
```

- [ ] **Step 2: At the start of the existing write transaction, load the write-off and recheck `pending_approval`, operational approval permission, creator/approver separation, branch stock, source-status balance, and bin quantity. Convert each conflict to a stable write-off error.**
- [ ] **Step 3: Re-read tracking profile and durable allocation rows inside the same transaction. For serial mode, require exact allocation count and each serial to match product/branch and remain `available`; update each serial to `written_off` in the transaction. For lot mode, require exact total allocation and decrement each lot with `WHERE available_quantity>=?`.**
- [ ] **Step 4: Re-evaluate whether financial authorization is currently required from the write-off reason and current estimated value. If required, require prepared context, re-read the authorizer as active, recheck authority/separation, and insert `inventory_writeoff_financial_approvals` through the same transaction executor.**
- [ ] **Step 5: Apply status/bin/branch/global stock reductions, insert the write-off stock movement, invoke `valueStockAdjustment(tx,...)`, and call `postSourceJournal(...,executor:tx)` exactly once.**
- [ ] **Step 6: Replace the unconditional final update with compare-and-swap and fail if it affects anything other than one row.**

```js
const approved=await tx.execute({sql:`UPDATE inventory_writeoffs SET status='approved',approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP,stock_movement_id=?,tracked_quantity=?,tracked_value=?,legacy_quantity=?,untracked_quantity=?,valuation_status=?,journal_entry_id=? WHERE id=? AND status='pending_approval' RETURNING *`,args:[actor(req),movementId,trackedQty,trackedValue,legacyQty,untrackedQty,valuationStatus,journal?.id||null,w.id]});
if(Number(approved.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_CONCURRENT_DECISION');
```

- [ ] **Step 7: Insert identity events, inventory-status event, and write-off approved event before commit. Only after `tx.commit()` may the route serialize the successful response.**
- [ ] **Step 8: On any thrown error, call the centralized rollback helper and then `sendWriteoffError`; never emit a response from inside the transaction before rollback/commit is resolved.**
- [ ] **Step 9: Run the entire focused runtime spec; every former partial-commit RED case must now be GREEN and assert database equality on failure paths.**
- [ ] **Step 10: Commit.**

```bash
git add routes/inventory-writeoffs.js tests/inventory-writeoff-atomic-approval.spec.js
git commit -m "fix: make writeoff approval atomic"
```

---
### Task 5: Lock the Architecture With Static Contracts

**Files:**
- Create: `scripts/check-inventory-writeoff-atomic-contract.js`
- Modify: `scripts/check-return-writeoff-traceability-contract.js`
- Modify: `scripts/check-loss-control-writeoff-contract.js`
- Modify: `scripts/check-accounting-financial-integrity-certification.js`
- Modify: package/release-gate wiring only if the new checker is not already picked up by the repository's aggregate syntax/contract command.

**Interfaces:**
- Produces: a deterministic static certification that fails if post-response finalization/persistence or raw touched-path error leakage returns.

- [ ] **Step 1: Add contract checks for the required request-context names, transaction-local financial insert, transaction-local identity mutation, CAS approval, and centralized safe-error helper.**
- [ ] **Step 2: Add negative assertions that the financial and traceability guards no longer override `res.json` for approval success and do not persist terminal approval evidence after `next()`.**

```js
['financial evidence is committed by the authoritative transaction',core.includes('inventory_writeoff_financial_approvals')],
['financial guard has no response-success persistence',!financial.includes('res.json=function')],
['traceability guard has no approval response finalizer',!traceability.includes('finalizeApproval(req.params.id)')],
['approval uses compare-and-swap',core.includes("WHERE id=? AND status='pending_approval' RETURNING *")],
```

- [ ] **Step 3: Replace existing static assertions that specifically require the old `writeoff_pending` reservation/post-response finalization mechanism with assertions for live transactional revalidation and exact identity finalization.**
- [ ] **Step 4: Run all affected static contracts plus `npm run check:syntax`.**
- [ ] **Step 5: Commit.**

```bash
git add scripts/check-inventory-writeoff-atomic-contract.js scripts/check-return-writeoff-traceability-contract.js scripts/check-loss-control-writeoff-contract.js scripts/check-accounting-financial-integrity-certification.js package.json
git commit -m "test: certify atomic writeoff approval contract"
```

---

### Task 6: Full Qualification and Release Candidate

**Files:**
- No new production scope unless qualification exposes a defect in this slice.
- Update tests/contracts only to correct genuine coverage gaps; never weaken assertions for green CI.

**Interfaces:**
- Consumes: completed feature tree.
- Produces: exact-SHA release evidence suitable for PR merge.

- [ ] **Step 1: Run focused local static qualification.**

```bash
node scripts/check-inventory-writeoff-atomic-contract.js
node scripts/check-inventory-writeoff-contract.js
node scripts/check-return-writeoff-traceability-contract.js
node scripts/check-loss-control-writeoff-contract.js
node scripts/check-accounting-financial-integrity-certification.js
npm run check:syntax
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Run the focused Playwright suite on a supported Linux runtime. If the Windows checkout still cannot execute Playwright because `ensureLinuxLibAsoundStub()` invokes GNU `as`, do not alter product logic to accommodate that local tooling mismatch; use GitHub Runtime Certification as runtime authority.**
- [ ] **Step 3: Push the exact feature head and require Runtime Certification success on that exact SHA. Inspect any failure with systematic debugging before changing code.**
- [ ] **Step 4: Create/update the PR against `integration/pos-consolidated-2026-09-07`; verify the base has not moved incompatibly. If it has moved, reconcile safely and recertify the new exact head.**
- [ ] **Step 5: Require PR-head Runtime Certification success on the exact merge candidate.**
- [ ] **Step 6: Merge using expected-head protection only.**
- [ ] **Step 7: Require post-merge Runtime Certification success on the exact resulting integration SHA before calling it the new canonical certified baseline.**

---

## Completion Evidence

The implementation is complete only when the runtime tests prove that forced financial, identity, valuation, accounting, stale-state, and concurrent-decision failures leave **no partial authoritative mutation**, all touched HTTP errors are staff-safe, every affected static contract passes, the full repository release wall passes on the exact feature head, PR head, and post-merge integration SHA, and the final integration SHA is recorded as canonical.
