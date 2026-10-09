# POS Release Finalization — 2026-10-05

## Release status

**Candidate:** `release/pos-finalization-2026-10-05`

**Baseline master:** `8082680d5efddd006df68d2453a9fd3d115c6ff5`

**Authoritative UI merge:** `27942d331cad52b35dda87d547c6cee23811534f`

This branch is the single POS finalization lineage. It intentionally does **not** deploy to Vercel and does **not** move `master` until the final runtime certification can be executed without violating the project's cost controls.

TT AI remains a separate draft extension in PR #97 and is not a prerequisite for core POS release.

## Integrated and reconciled

### Authoritative UI, responsiveness and Guide Me

The converged UI lineage from PR #91 / PR #92 was history-preservingly merged onto the current POS master lineage while retaining newer master changes.

Recorded source qualification in `docs/UI-FINAL-VERIFICATION-2026-09-25.md`:

- `npm run check:syntax`: exit 0.
- Combined release-gate/browser/runtime selection plus shell UI and Guide Me: **81 passed, 0 failed, 1 skipped**.
- Responsive verification at **1440, 1280, 1024, 768, 430, 390 and 375 px**.
- Sales, Inventory, Purchasing, Rentals, Quotes, Work Orders, Customers, Administration, Dispatch and Accounting Ledger opened without browser-script errors or horizontal document overflow at every tested width.
- Guide Me loading, task selection, Escape close and focus restoration passed.
- Separate exploratory responsive run: **91 checks passed**.
- `git diff --check`: passed.

### Retail sale completion

The validated immediate-sale handoff is present in the release lineage:

- payment-recorded / sale-complete confirmation;
- transaction and change-due evidence;
- `Next Sale` action;
- product-search focus restoration;
- rental-linked and historical receipts remain receipt-only;
- responsive completion styling;
- protected by the existing workflow contract.

The old PR #84 was therefore closed as superseded rather than merged from its stale lineage.

### Inventory authority

I-STOCK-01 evidence is already present in the current invariant registry and evidence ledger. The recorded certification covers controlled stock movements and closes catalog, variation, import and rental-relocation bypasses. Old PR #31 was closed as superseded.

### SmartCommerce

The release lineage retains the durable POS-to-SmartCommerce outbox and adds final order-ingress hardening.

Current controls include:

- API-key authentication with `orders:read` / `orders:write` scopes;
- unique external order identity;
- deterministic canonical payload hashing;
- changed-data replay rejected with HTTP 409;
- legacy replay explicitly reports whether hash evidence existed;
- duplicate product lines rejected;
- maximum 200 order lines;
- transactional branch-stock decrement;
- transaction-item and payment evidence;
- attributable `stock_movements` evidence for SmartCommerce paid orders;
- durable outbox event publishing;
- HMAC signing with `SMARTCOMMERCE_POS_SYNC_SECRET`;
- retry/backoff and `needs_review` handling;
- event families for catalog/category/product/price/media/variation/availability/customer/promotion/rental/repair lifecycle.

The release adds `scripts/check-smartcommerce-order-contract.js` and wires it into `npm run check:syntax`.

### Gate 0 security and concurrency

A final review found that privileged cross-user password and PIN reset endpoints had retained permission checks but lost elevated actor-password reauthentication. The release branch restores the control.

Current controls include:

- `security_manage` authorization for privileged resets;
- login-rate limiting on privileged reset endpoints;
- administrator password reauthentication before cross-user password or PIN reset;
- explicit `REAUTHENTICATION_REQUIRED` response on missing/failed reauthentication;
- target-session revocation;
- forced password change after administrative password reset;
- credential lifecycle audit evidence including elevated reauthentication;
- self-service PIN change remains target-bound and requires the current PIN;
- atomic sequence-backed document numbering and concurrency regression coverage;
- password reset, PIN reset and document-number tests included in Gate 0 runtime certification.

The release adds `scripts/check-gate0-credential-contract.js` and wires it into `npm run check:syntax`.

Source-level finalization check: **20/20 Gate 0 contract conditions passed**. Changed runtime and contract JavaScript files parsed successfully through the connected GitHub source.

### Private files and API fallback

A final upstream/security review found that the generic `/uploads` static mount could bypass otherwise-authorized attachment routes. The release branch closes that boundary:

- direct static access to purchase-order and rental-PO attachments returns 404;
- customer identity scans and rental signatures require an authenticated employee session;
- new customer identity scans are stored outside the public upload tree;
- purchase-order attachment downloads inherit `purchasing` permission;
- rental PO attachment downloads require `rentals_checkout` or `pos` authority;
- product/branding assets remain available through the controlled public upload mount;
- unmatched `/api/*` requests return JSON 404 instead of falling through to the SPA.

The existing `scripts/check-upload-security-contract.js` is wired into `npm run check:syntax`. Source-level finalization confirmed all **9/9 upload/API boundary conditions** plus the release-script binding, and the changed server/rental/upload-security files parse successfully.

## Historical PR cleanup

The following stale/superseded PRs were closed with traceability comments:

- #1 — original SmartCommerce-safe POS write contract
- #10 — older Gate 0 branch
- #31 — stock certification evidence already integrated
- #84 — sale-completion handoff already integrated
- #88 — older UI convergence
- #91 — UI convergence superseded by release integration PR #98
- #94 — older SmartCommerce integration branch

PR #98 is the completed UI release-integration merge.

PR #97 remains draft/unmerged for TT AI.

## Final certification boundary

No production deployment is claimed by this document.

The finalization environment could read and modify the authoritative GitHub repository but could not establish a fresh external Git clone for executable end-to-end testing. GitHub Actions minutes are intentionally not consumed and no Vercel preview/production deployment is triggered because of the POS cost constraint.

Before promoting this branch to `master`, execute the existing repository release wall from a clean checkout with disposable data:

```bash
npm run check:syntax
npm run test:release-gate -- --workers=1
npx playwright test tests/password-reset-security.spec.js tests/pin-reset-security.spec.js tests/document-number-concurrency.spec.js --workers=1
```

A passing run is the remaining boundary between **release candidate** and **production-certified complete**.

The security hardening above is included in that pending clean-checkout runtime pass; no claim is made that the post-hardening branch has completed fresh end-to-end execution in this finalization environment.
