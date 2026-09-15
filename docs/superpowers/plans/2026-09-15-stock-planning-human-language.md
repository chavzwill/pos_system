# Stock Planning & Replenishment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vague staff-facing inventory terminology with a coherent Stock Planning & Replenishment workflow and make existing supplier/stock evidence understandable, explainable, safe and regression-protected.

**Architecture:** Preserve `/api/inventory-intelligence`, `TotalToolsInventoryIntelligence`, permissions, database identifiers and authoritative stock/purchasing workflows. Change only staff-facing task/copy/navigation contracts plus the reporting presentation/evidence contract; recommendations remain read-only and hand off to governed transfer or purchasing workflows.

**Tech Stack:** Node.js, Express, SQLite/libSQL, browser JavaScript/CSS, Playwright, repository static contract scripts.

**Spec:** `docs/superpowers/specs/2026-09-15-stock-planning-human-language-design.md`

## Global Constraints

- Canonical implementation base is certified SHA `495190140f30350fa13a1ab59bcb0db6513f7317`.
- Staff-facing canonical name is **Stock Planning & Replenishment**.
- Existing backend API routes, permission identifiers, database names and stable technical identifiers remain compatible.
- Recommendations never silently mutate stock or bypass transfers, purchase requests or approvals.
- Cost/profit evidence remains permission-controlled by existing server authority.
- Changed staff-facing errors must never expose raw SQL, stack, provider or exception details.
- Feature/PR head and post-merge integration SHA both require complete Runtime Certification.

---
### Task 1: Lock the human-language contract with TDD

**Files:**
- Create: `scripts/check-stock-planning-language-contract.js`
- Modify: `scripts/check-human-language-contract.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: rendered production files in `public/` and existing static contract conventions.
- Produces: `npm run check:stock-planning-language`, a permanent release-gate assertion for canonical wording and legacy-name exclusion on staff surfaces.

- [ ] **Step 1: Write the failing contract**

Create a script that reads the staff-rendered inventory workspace, Guide Me files, Operations Attention Center, purchasing workspace and operational reports UI. Assert `Stock Planning & Replenishment` is present in the canonical launch/workspace/task paths and fail if staff-rendered copy contains `Inventory Intelligence`.

```js
check('canonical staff name is rendered',inventory.includes('Stock Planning & Replenishment'));
for(const [name,text] of staffFiles) check(`${name} hides legacy term`,!/Inventory Intelligence/i.test(text));
check('internal API remains compatible',inventory.includes("'/api/inventory-intelligence'"));
check('internal global remains compatible',inventory.includes('TotalToolsInventoryIntelligence'));
```

- [ ] **Step 2: Run RED**

Run: `node scripts/check-stock-planning-language-contract.js`
Expected: FAIL because the current staff launch/Guide Me paths still contain the legacy term and the canonical name is not yet wired everywhere.

- [ ] **Step 3: Register the contract without changing production behavior**

Add `check:stock-planning-language` to `package.json` and chain it into `check:syntax`. Extend `check-human-language-contract.js` only to delegate/cover staff-rendered scope; do not ban technical route/file names.

- [ ] **Step 4: Re-run RED and commit test-only state**

Run the new contract and `git diff --check`; verify failure is semantic, then commit `test: lock stock planning language contract`.
### Task 2: Migrate the complete Guide Me and launcher workflow

**Files:**
- Modify: `public/guided-mode-orchestrator.js`
- Modify: `public/guided-mode-exact-fallback.js`
- Modify: `public/guided-mode-completion.js`
- Modify: `public/guided-mode-role-context.js`
- Modify: `public/operations-attention-center.js`
- Modify: `public/purchasing-workspace.js`
- Modify: `scripts/check-guided-mode-contract.js`

**Interfaces:**
- Consumes: canonical task string `Stock Planning & Replenishment`; existing selector `#tt-inventory-intelligence` and global `TotalToolsInventoryIntelligence` remain stable.
- Produces: consistent staff navigation and Guide Me routing without changing authorization.

- [ ] **Step 1: Add failing Guide Me assertions**

Update `check-guided-mode-contract.js` to require the canonical task in role context, orchestrator, fallback and completion mappings, and to reject the legacy task string in those rendered task maps.

- [ ] **Step 2: Run RED**

Run: `npm run check:guided-mode`
Expected: FAIL on canonical task coverage.

- [ ] **Step 3: Implement the minimal coordinated migration**

Replace the staff task key everywhere as one atomic change. Keep feature id `inventory-intelligence`, selector `#tt-inventory-intelligence`, and global API unchanged. Use fallback phrases such as `stock planning`, `low stock`, `reordering`, `move stock`, and `what to order`; do not add generic “intelligence” synonyms.

- [ ] **Step 4: Verify GREEN**

Run: `npm run check:guided-mode && node scripts/check-stock-planning-language-contract.js`
Expected: Guide Me passes; any remaining language-contract failures are confined to later workspace/report tasks.

- [ ] **Step 5: Commit**

Commit `feat: humanize stock planning navigation`.
### Task 3: Reframe the stock workspace around staff decisions

**Files:**
- Modify: `public/inventory-intelligence.js`
- Modify: `public/inventory-intelligence.css` only where semantic section/action styling requires it
- Test: `tests/inventory-intelligence.spec.js`
- Test: new browser/static assertions in `scripts/check-stock-planning-language-contract.js`

**Interfaces:**
- Consumes: existing `/api/inventory-intelligence/overview` response (`summary`, `recommendations`, `branch_imbalances`, `exceptions`, `evidence_policy`).
- Produces: plain-language Stock Planning & Replenishment presentation; no new stock mutation API.

- [ ] **Step 1: Write failing presentation assertions**

Require the workspace to render `Stock Planning & Replenishment`, `Needs attention`, `Low stock`, `Excess & slow-moving stock`, `Move between branches`, `What to order`, `Supplier choice`, and `Stock value at risk`, plus the explicit statement that suggestions do not change stock automatically.

- [ ] **Step 2: Run RED**

Run the stock-planning contract and relevant inventory browser test. Expected: FAIL on missing decision-oriented sections.

- [ ] **Step 3: Implement minimal decision-oriented rendering**

Derive sections only from existing overview evidence. Preserve raw recommendation evidence text, translate machine recommendation types to explicit staff labels, and show `Evidence unavailable` when a recommendation lacks support instead of inventing a reason. Keep refresh/branch filtering and existing API/global identifiers.

- [ ] **Step 4: Make errors safe and actionable**

Change the browser API wrapper to throw a fixed staff message such as `We could not load current stock planning records. Refresh and try again.` while logging no server internals into rendered HTML. Do not render `d.error` or exception text returned by the server.

- [ ] **Step 5: Verify GREEN and commit**

Run `node scripts/check-stock-planning-language-contract.js`, `node --check public/inventory-intelligence.js`, and the inventory runtime test available in Linux CI. Commit `feat: make stock planning staff focused`.
### Task 4: Make supplier reports explainable and authority-safe

**Files:**
- Modify: `routes/operational-reports.js`
- Modify: `public/operational-reports.js`
- Modify: `tests/operational-reports.spec.js`
- Create: `lib/operational-report-errors.js` if no reusable safe report-error helper exists after inspection

**Interfaces:**
- Consumes: existing supplier-performance and supplier-items queries, supplier scorecard evidence, `reports` permission and current branch/date filters.
- Produces: report payload/UI that states attribution, evidence window, score components and missing-evidence semantics.

- [ ] **Step 1: Write failing runtime tests**

Extend `tests/operational-reports.spec.js` so supplier performance requires `on_time_rate`, `fill_rate`, `quality_acceptance_rate`, `customer_return_rate`, `effective_fulfillment`, `overall_rating_score`, `supplier_rating`, and explicit `rating_method`/`evidence_window`. Require supplier items to state the product-to-supplier attribution rule and profitability limitation.

- [ ] **Step 2: Add an adversarial missing-evidence case**

Seed an active supplier with no completed PO/receipt evidence and assert it is reported as `Not enough data` (or equivalent), never as a zero-derived `Poor` rating and never as perfect performance.

- [ ] **Step 3: Run RED**

Run: `npx playwright test tests/operational-reports.spec.js`
Expected: supplier evidence assertions fail on current payload semantics. If Windows Playwright cannot execute due the known GNU `as` bootstrap issue, record that environment failure and use Linux Runtime Certification as runtime authority; do not alter product code to mask it.

- [ ] **Step 4: Implement explainable rating semantics**

Keep the existing weighted rating only when sufficient component evidence exists. Return a structured `rating_method` describing weights (on-time 30%, fill 30%, received-goods quality 25%, customer-return component 15%), `evidence_window:{start,end}`, and `evidence_status`. Suppliers without sufficient observations get a null score and plain `Not enough data` rating.
- [ ] **Step 5: Preserve attribution truth**

For supplier-item sales/profit, keep attribution based on the product’s recorded supplier relationship and return metadata such as `attribution_rule:'Current product supplier assignment'`. Keep the existing warning that estimated gross profit uses POS product cost and is not audited landed-cost profitability.

- [ ] **Step 6: Centralize safe report errors**

Inspect for an existing report-safe helper first. If none exists, create `lib/operational-report-errors.js` exposing `sendOperationalReportError(res,error,context)` that logs internal detail server-side and returns only `{error:'REPORT_UNAVAILABLE',message:'We could not load this report. Check the filters and try again.'}`. Replace raw `e.message` responses in changed supplier endpoints; do not broaden unrelated endpoint remediation in this slice.

- [ ] **Step 7: Render evidence in staff language**

Update `public/operational-reports.js` so the supplier report explains the date window, rating components, `Not enough data`, attribution rule and profitability limitation without exposing technical field names.

- [ ] **Step 8: Verify GREEN and commit**

Run supplier runtime tests, `node --check routes/operational-reports.js`, `node --check public/operational-reports.js`, language contract and `git diff --check`. Commit `feat: explain supplier performance reports`.

### Task 5: Verify non-mutation, permissions and regression wall

**Files:**
- Modify: `scripts/check-stock-planning-language-contract.js`
- Modify: `tests/inventory-intelligence.spec.js` only for behavior coverage required by this spec
- Modify: `tests/operational-reports.spec.js` only for behavior coverage required by this spec

**Interfaces:**
- Consumes: final implementation from Tasks 1–4.
- Produces: adversarial evidence that wording changes did not weaken authority or create hidden mutations.

- [ ] **Step 1: Add non-mutation contract checks**

Assert the stock-planning client only calls the overview GET endpoint and contains no POST/PUT/PATCH/DELETE stock mutation path. Assert action copy describes governed handoffs rather than direct stock changes.

- [ ] **Step 2: Add permission regression checks**

Keep `/api/operational-reports` behind `requirePermission('reports')`; verify unauthenticated/unauthorized report access remains rejected and inventory overview authentication tests remain green.
- [ ] **Step 3: Run focused static wall**

Run:
```powershell
npm run check:stock-planning-language
npm run check:guided-mode
node scripts/check-human-language-contract.js
node scripts/check-procurement-market-intelligence-contract.js
node --check public/inventory-intelligence.js
node --check public/operational-reports.js
node --check routes/operational-reports.js
git diff --check
```
Expected: all pass.

- [ ] **Step 4: Run repository syntax wall**

Run: `npm run check:syntax`
Expected: exit 0 with all existing contracts green.

- [ ] **Step 5: Run focused runtime wall**

Run on a supported Linux runtime:
```bash
npx playwright test tests/inventory-intelligence.spec.js tests/operational-reports.spec.js
```
Expected: all pass, including missing-evidence and auth cases.

- [ ] **Step 6: Commit verification hardening**

Commit `test: certify stock planning experience`.

### Task 6: Exact-SHA qualification and integration

**Files:** no product changes unless certification exposes a genuine defect.

- [ ] **Step 1: Self-review the full diff**

Compare against the approved spec. Confirm no unrelated inventory architecture changes, no API identifier rename, no raw error leakage, no authority weakening and no legacy staff wording in rendered scope.

- [ ] **Step 2: Push feature branch and open/update PR**

Record exact feature HEAD SHA. Push only this isolated branch and create the PR against `integration/pos-consolidated-2026-09-07`.

- [ ] **Step 3: Require exact-head Runtime Certification**

The successful workflow run must report the exact PR-head SHA. A cancelled, superseded or different-SHA run is not certification.

- [ ] **Step 4: Merge with expected-head protection**

Merge only the certified PR head without force-push/history rewriting. Record resulting integration merge SHA.

- [ ] **Step 5: Require post-merge Runtime Certification**

The canonical integration branch is certified only when the full Runtime Certification succeeds on that exact merge SHA. If it fails, create a new isolated fix branch from current integration and debug root-cause-first; never rewrite integration history.