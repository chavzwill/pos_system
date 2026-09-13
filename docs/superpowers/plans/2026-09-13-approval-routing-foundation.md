# Approval Routing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the POS-side department/manager and shared approval-envelope foundation used by later commercial-account, purchasing, and repair-portal slices.

**Architecture:** Add normalized departments and employee manager memberships plus a shared approval envelope/event ledger. A focused approval-routing library owns schema, manager eligibility, idempotent envelope creation, and optimistic decision primitives; routes expose administration and manager queues. No business module is allowed to mutate through this foundation until it registers an authoritative adapter in a later slice.

**Tech Stack:** Node.js 22, Express, LibSQL/Turso-compatible SQL, existing employee session/RBAC middleware, vanilla browser JS, Playwright/runtime certification.

**Spec:** `docs/superpowers/specs/2026-09-13-portal-approval-routing-design.md`

## Global Constraints

- Modify only `chavzwill/pos_system`; do not touch SmartCommerce.
- POS remains authoritative for repair, credit, purchasing, money, inventory, and internal approval decisions.
- Default departmental rule: any one active authorized manager may decide an ordinary request.
- Existing independent financial/security approval requirements override the one-manager default.
- Department labels alone never grant authority; manager membership plus workflow permission is required.
- API keys cannot call internal manager decision routes.
- Approval events are append-only and all decision identity comes from the authenticated employee.
- Every production change is TDD-first and must pass exact-head Runtime Certification before protected merge.

---
## File structure

- Create `lib/approval-routing.js` — schema bootstrap, department membership checks, envelope creation, queue queries, optimistic decision primitives.
- Create `routes/department-approval-admin.js` — security-admin APIs for departments and manager memberships.
- Create `routes/approval-routing.js` — authenticated manager queue/detail and lifecycle endpoints; no external/API-key access.
- Create `public/department-approvals-ui.js` — manager-facing `My Department Approvals` workspace.
- Modify `routes/employee-end-shift-assistant.js` — mount approval-routing subrouter under `/api/employee-assist`.
- Modify `server.js` — mount department administration API before generic employee/admin routes.
- Modify `public/shell-deferred.js` — deferred-load manager approval UI.
- Modify `public/employee-assist-ui.js` — replace/extend legacy purchase-only Approvals tool with shared manager queue.
- Create `scripts/check-approval-routing-foundation-contract.js` — static authority and UI regression contract.
- Create `tests/approval-routing-foundation.spec.js` — runtime branch/manager/concurrency/idempotency proof.
- Modify `scripts/check-client-syntax.js` and release test registration so the contract/runtime test cannot be skipped.

### Task 1: Define the failing foundation contract

**Files:**
- Create: `scripts/check-approval-routing-foundation-contract.js`
- Modify: `scripts/check-client-syntax.js`

**Interfaces:**
- Produces a release-gated contract that expects `ensureApprovalRoutingSchema`, `createApprovalRequest`, manager membership checks, read-only queue UI, and no API-key decision authority.

- [ ] **Step 1: Write the failing static contract**

```js
const lib = fs.existsSync(libPath) ? fs.readFileSync(libPath, 'utf8') : '';
checks.push(['normalized departments exist', lib.includes('CREATE TABLE IF NOT EXISTS departments')]);
checks.push(['manager membership is explicit', lib.includes('employee_department_memberships') && lib.includes('is_manager')]);
checks.push(['events are append only', lib.includes('approval_events') && !lib.includes('UPDATE approval_events')]);
checks.push(['decision actor comes from session', route.includes('req.employee.id') && !route.includes('approved_by = req.body')]);
checks.push(['API keys cannot decide', route.includes('API keys cannot operate internal approval workflows')]);
```

- [ ] **Step 2: Register the contract in `scripts/check-client-syntax.js` and run it**

Run: `node scripts/check-approval-routing-foundation-contract.js`
Expected: FAIL because the routing foundation files do not exist yet.
### Task 2: Build the approval-routing schema and service library

**Files:**
- Create: `lib/approval-routing.js`
- Test: `tests/approval-routing-foundation.spec.js`

**Interfaces:**
- Produces `ensureApprovalRoutingSchema()`, `createApprovalRequest(input)`, `listManagerApprovals(employee)`, `getApprovalForManager(id, employee)`, `recordApprovalDecision(input)`, and `isAuthorizedDepartmentManager(employeeId, departmentId, branchId)`.
- `createApprovalRequest` accepts `{ requestType, sourceSystem, externalRequestId, owningModule, owningRecordId, departmentId, branchId, requesterEmployeeId, customerId, organizationRef, memberRef, requestedAction, priority, requiredPermission, payloadHash }`.

- [ ] **Step 1: Add runtime tests for schema and uniqueness**

```js
test('external request replay is unique per source and request type', async ({ request }) => {
  const a = await createEnvelope(fixture);
  const b = await createEnvelope(fixture);
  expect(b.id).toBe(a.id);
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "external request replay"`
Expected: FAIL because the library/schema does not exist.

- [ ] **Step 3: Implement schema bootstrap**

Create tables `departments`, `employee_department_memberships`, `approval_requests`, and `approval_events`; add unique indexes for department code, active employee/department membership, source/external request identity, and one active envelope per owning module/record/request type.
Use CHECK constraints for lifecycle states and manager boolean fields where supported by the existing database conventions.

- [ ] **Step 4: Implement idempotent envelope creation and event append**

Hash the canonical payload supplied by the caller. Exact replay returns the existing request; reuse of the same external identity with a different hash throws a conflict.
Insert a `submitted` event when a new submitted envelope is created.

- [ ] **Step 5: Run targeted tests**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "external request|schema|event"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/approval-routing.js tests/approval-routing-foundation.spec.js
git commit -m "feat: add approval routing data authority"
```
### Task 3: Add department and manager administration

**Files:**
- Create: `routes/department-approval-admin.js`
- Modify: `server.js`
- Test: `tests/approval-routing-foundation.spec.js`

**Interfaces:**
- `GET /api/department-approvals/departments`
- `POST /api/department-approvals/departments`
- `POST /api/department-approvals/departments/:id/members`
- `PATCH /api/department-approvals/departments/:id/members/:employeeId`
- Administration requires `security_assign`; ordinary managers cannot grant themselves manager authority.

- [ ] **Step 1: Write failing authorization tests**

```js
test('ordinary manager cannot grant manager membership', async ({ request }) => {
  const r = await asOrdinaryManager(request).post('/api/department-approvals/departments/1/members', { data:{ employee_id:2, is_manager:true } });
  expect(r.status()).toBe(403);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "grant manager membership"`
Expected: FAIL because the administration route is not mounted.

- [ ] **Step 3: Implement security-admin routes**

Derive actor identity from `req.employee.id`; validate employee is active; validate department exists; persist membership branch scope explicitly (`branch_id NULL` means all authorized branches, otherwise exact branch).
Membership updates append an approval-governance event or dedicated audit event; never silently replace manager authority.

- [ ] **Step 4: Mount before generic employee/admin mutation routes**

Use `app.use('/api/department-approvals', require('./routes/department-approval-admin'));` after session authentication is available and before less-specific routes.

- [ ] **Step 5: Run targeted tests**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "department|membership|manager"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/department-approval-admin.js server.js tests/approval-routing-foundation.spec.js
git commit -m "feat: add department manager administration"
```
### Task 4: Add manager queue and guarded decision primitives

**Files:**
- Create: `routes/approval-routing.js`
- Modify: `routes/employee-end-shift-assistant.js`
- Test: `tests/approval-routing-foundation.spec.js`

**Interfaces:**
- `GET /api/employee-assist/department-approvals`
- `GET /api/employee-assist/department-approvals/:id`
- `POST /api/employee-assist/department-approvals/:id/claim`
- `POST /api/employee-assist/department-approvals/:id/request-changes`
- Decision execution uses `recordApprovalDecision({ approvalId, employeeId, expectedVersion, decision, notes, authoritativeResult })` and requires an adapter registered for that request type in later slices.

- [ ] **Step 1: Write failing branch/permission/concurrency tests**

```js
test('two managers cannot both win the same decision version', async ({ request }) => {
  const [a,b] = await Promise.all([decideAs(managerA, 1), decideAs(managerB, 1)]);
  expect([a.status(), b.status()].sort()).toEqual([200,409]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "two managers|branch scope|API key"`
Expected: FAIL because queue/decision routes do not exist.

- [ ] **Step 3: Implement queue filtering**

Filter by active manager membership, membership branch scope, employee branch authority, request lifecycle, and `required_permission` checked with existing `can()` logic.
Return human labels, age, branch, requester, request type, priority, and owning record context; never expose private payload fields by default.

- [ ] **Step 4: Implement guarded lifecycle primitives**

Reject API-key callers with `403`. Use authenticated employee id only. Use `WHERE id=? AND version=? AND status IN ('submitted','in_review')` compare-and-swap updates, increment version atomically, and append an event in the same transaction.
`request-changes` is allowed in the foundation; `approved/rejected` must fail closed with `501/409` until an authoritative module adapter is registered.

- [ ] **Step 5: Run targeted runtime tests**

Run: `npx playwright test tests/approval-routing-foundation.spec.js -g "queue|branch|permission|concurrent|API key"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/approval-routing.js routes/employee-end-shift-assistant.js tests/approval-routing-foundation.spec.js
git commit -m "feat: add guarded department approval queue"
```
### Task 5: Add the manager-facing approval workspace

**Files:**
- Create: `public/department-approvals-ui.js`
- Modify: `public/shell-deferred.js`
- Modify: `public/employee-assist-ui.js`
- Test: `scripts/check-approval-routing-foundation-contract.js`

**Interfaces:**
- UI calls `GET /api/employee-assist/department-approvals` and `GET /api/employee-assist/department-approvals/:id`.
- It may claim or request changes in this slice; approve/reject buttons render only when the server later advertises `can_decide=true` from a registered module adapter.

- [ ] **Step 1: Add failing UI contract assertions**

```js
checks.push(['manager queue uses human language', ui.includes('My Department Approvals') && ui.includes('Waiting for')]);
checks.push(['UI does not invent approval mutation', !ui.includes("status:'approved'") && !ui.includes("status:'rejected'" )]);
checks.push(['shell deferred-loads approval UI', deferred.includes("'/department-approvals-ui.js'" )]);
```

- [ ] **Step 2: Run contract and verify RED**

Run: `node scripts/check-approval-routing-foundation-contract.js`
Expected: FAIL on missing UI/deferred loader.

- [ ] **Step 3: Implement the workspace**

Render department, requester, branch, age, priority, required approval role, status, and plain-language next step. Preserve owning module/record context for future deep-links. Show empty state `No department approvals need your attention` rather than technical queue language.

- [ ] **Step 4: Replace the purchase-only Approvals button behavior**

Keep the existing employee tool entry point but route it to the shared manager queue. Do not delete legacy purchase-request data access until Slice 3 migrates purchasing producers.

- [ ] **Step 5: Run contract and browser syntax**

Run: `node scripts/check-approval-routing-foundation-contract.js && node scripts/check-client-syntax.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/department-approvals-ui.js public/shell-deferred.js public/employee-assist-ui.js scripts/check-approval-routing-foundation-contract.js scripts/check-client-syntax.js
git commit -m "feat: add department approvals workspace"
```
### Task 6: Integrate the release gates and certify the slice

**Files:**
- Modify: `package.json` only if a dedicated npm script is needed by the existing release-gate pattern.
- Modify: `.github/workflows/runtime-certification.yml` only if `tests/approval-routing-foundation.spec.js` is not already reached through the current business-integrity suite.
- Test: `scripts/check-approval-routing-foundation-contract.js`
- Test: `tests/approval-routing-foundation.spec.js`

**Interfaces:**
- The permanent static contract must execute inside `npm run check:syntax`.
- The runtime spec must execute in Runtime Certification on both PR head and post-merge integration SHA.

- [ ] **Step 1: Run the complete local static/release contract wall**

Run: `npm run check:syntax`
Expected: PASS with `Approval routing foundation contract OK` visible and all pre-existing contracts green.

- [ ] **Step 2: Run the targeted runtime suite**

Run: `npx playwright test tests/approval-routing-foundation.spec.js`
Expected: PASS for schema, manager membership, branch scope, permission filtering, API-key rejection, idempotent envelope creation, and decision concurrency.

- [ ] **Step 3: Run diff and authority review**

Run: `git diff --check && git status --short && git diff --stat origin/integration/pos-consolidated-2026-09-07...HEAD`
Expected: no whitespace errors, no SmartCommerce files, no unrelated business-module mutations, and only foundation/admin/UI/test/docs changes.

- [ ] **Step 4: Commit release-gate wiring**

```bash
git add package.json .github/workflows/runtime-certification.yml scripts tests public routes lib
git commit -m "test: certify approval routing foundation"
```

- [ ] **Step 5: Push and open PR**

Push the exact branch head, open a PR to `integration/pos-consolidated-2026-09-07`, and freeze the head while Runtime Certification executes.

- [ ] **Step 6: Require exact-head Runtime Certification**

Required stages: full application release gate, Gate 0 credential/concurrency, Gate 1 money/inventory, supplier quote→PO integrity, and privileged security/secret governance.
If any stage fails, fix the failing invariant on a new exact head and re-certify; do not weaken or bypass the gate.

- [ ] **Step 7: Protected merge and post-merge certification**

Merge with expected-head protection only after the exact PR head is fully green. Then require the same Runtime Certification stages to pass on the resulting integration SHA before marking Slice 1 complete.

## Slice 1 completion criteria

- Departments and manager memberships are normalized and security-admin controlled.
- Any one authorized manager can see ordinary requests for their department/branch, subject to workflow permission.
- Two managers cannot both win the same request version.
- API keys cannot operate internal manager workflows.
- Approval envelopes/events are durable, idempotent, attributable, and fail closed when no authoritative business adapter exists.
- The manager dashboard is human-readable and integrated with Employee Assist.
- Existing certified POS workflows remain green.
