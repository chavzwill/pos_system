# Disposable POS Certification

The safest way to run mutation-heavy production certification is against a throwaway local database created specifically for that run.

## Commands

For the focused production certification bundle:

```bash
node scripts/run-pos-disposable-certification.js
```

For the comprehensive release-candidate gate, use:

```bash
node scripts/run-pos-disposable-release-certification.js
```

The comprehensive release runner is the preferred pre-release command. It first runs the repository syntax/workflow contracts, then creates a temporary local SQLite database, initializes the native POS, provisions isolated administrator and branch-scoped identities, resolves two real disposable branches, runs the production architecture/recovery/observability contracts, and executes both the newer production suites and the established release-gate suites.

That broader runtime coverage includes native shell/responsive behavior, operations acceptance, RBAC/security boundaries, cross-branch read isolation, idempotency, lifecycle concurrency, POS financial integrity, accounting, purchase-order hardening, procurement governance, loss control, technician compensation, ERP/inventory/logistics intelligence, operational reporting, rentals, repairs, and service completion.

Both runners refuse an inherited `POS_TEST_BASE_URL`. The comprehensive release runner also rejects any inherited non-`file:` database URL, so a remote Turso/libSQL target cannot accidentally become the mutation-test database.

## Dynamic local server ownership

Disposable certification no longer depends on port `3001`. Before creating fixtures, the runner selects a free loopback port, verifies that it can bind that port, and then injects the exact same target into:

- `PORT` for the native POS server
- `POS_TEST_BASE_URL` for Playwright and direct runtime clients
- the shared `tests/test-base-url.js` helper used by active certification suites

Playwright is configured not to reuse an existing server during disposable certification. A mutation-heavy release suite therefore owns both its temporary database and its local HTTP server even when another developer POS is already running on port `3001`.

An optional explicit local port can be requested when needed:

```bash
POS_DISPOSABLE_PORT=34127 node scripts/run-pos-disposable-release-certification.js
```

The override must be a valid non-privileged local port and must be free. If it is occupied, certification stops before test fixtures are created.

The static target contracts also walk the active certification import graph and fail if a reachable suite reintroduces a fixed `localhost:3001` or `127.0.0.1:3001` target outside the single shared fallback helper.

The temporary database is removed automatically after the run. To retain it for failure investigation only:

```bash
POS_KEEP_DISPOSABLE_CERTIFICATION=YES node scripts/run-pos-disposable-release-certification.js
```

Optional local-only credential overrides:

```bash
POS_DISPOSABLE_TEST_PASSWORD='LocalCertificationOnly-2026!' \
POS_DISPOSABLE_TEST_PIN='246810' \
node scripts/run-pos-disposable-release-certification.js
```

## Safety rules

This workflow must remain fail-closed:

- never point it at production or a shared database
- never pass an inherited external `POS_TEST_BASE_URL`
- never use a remote/non-local database
- never reuse a pre-existing server for disposable certification
- require the selected loopback port to be bindable before fixture creation
- require active mutation-capable suites to use the shared target and mutation guard
- never silently install dependencies or browser binaries
- never treat a retained throwaway database as production evidence
- never promote a release solely because disposable certification passed; release-adjacent backup rehearsal, read-only hosted checks, and manual acceptance still apply

The static `scripts/check-disposable-release-certification-contract.js`, `scripts/check-shared-test-target-contract.js`, and `scripts/check-active-certification-targets.js` guards exist so future edits cannot quietly remove isolated database/server ownership, dynamic target consistency, branch-isolation coverage, legacy release suites, financial/accounting suites, mutation safety, or cleanup requirements.

## Why this exists

Several important certification suites intentionally create sales, returns, receiving events, rentals, repair/accounting evidence, lifecycle locks, procurement decisions, loss-control exceptions, and idempotency receipts. Running those tests directly against operational data would be unsafe. The disposable runners give those tests a realistic native POS server and database while keeping production records outside the blast radius.

## Evidence

For each run, retain the exact Git SHA and terminal result. A passing comprehensive disposable run demonstrates that the candidate can boot and execute the full mutation-heavy release suite in isolation. It does not prove the production host, proxy, backup, or employee acceptance environment is healthy; those remain separate release gates.
