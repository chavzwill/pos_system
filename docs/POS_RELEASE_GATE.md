# POS Release Gate

Last updated: 2026-09-10

## Release rule

A Vercel READY/build result, syntax pass, unit-test pass or manual spot check is not release certification.

Material application changes must pass the GitHub Actions workflow **Runtime Certification**, job **release-gate**, on the exact candidate head SHA before merge/release.

Until repository protection requires that status, merge enforcement is **BLOCKED / UNVERIFIED** even when the workflow itself is green.

## Mandatory candidate checks

1. `npm ci` on the candidate source.
2. Isolated runtime database bootstrap; never point certification at live customer/provider data.
3. `npm run test:release-gate -- --workers=1`.
4. Gate 0 credential/concurrency suite:
   - `tests/password-reset-security.spec.js`
   - `tests/forced-password-change.spec.js`
   - `tests/pin-security-runtime.spec.js`
   - `tests/pin-credential-boundary.spec.js`
   - `tests/document-number-concurrency.spec.js`
5. No unresolved P0/P1/core-P2 finding in the affected scope.
6. Exact-head deployment/build evidence where deployment is part of the release.
7. Migration/database target and rollback/recovery consequences explicitly known.

## Failure policy

A failed or cancelled candidate run blocks release. Fix the root cause on the same remediation lineage, run certification on the new exact head, and retain diagnostics. Never rerun repeatedly to obtain a lucky green without understanding a nondeterministic failure.

## Protected-merge target

The authoritative integration/release branch must require the check context produced by `Runtime Certification / release-gate`. Direct pushes and bypasses should be restricted to explicitly governed emergency recovery. The current integration branch was observed with protection disabled on 2026-09-10; therefore this enforcement requirement is not yet VERIFIED.

## Release-kill review

Before production-ready status, conduct a fresh adversarial pass that attempts duplicate money movement, duplicate/missing inventory, incorrect COGS, over-refund, credit corruption, unauthorized approval/credential change, branch bypass, stale overwrite, duplicate receiving/rental settlement/return, work-order completion bypass, UOM drift, misleading UI success, deployment inconsistency and unrecoverable partial state.