# Disposable POS Certification

The safest way to run mutation-heavy production certification is against a throwaway local database created specifically for that run.

## Command

```bash
node scripts/run-pos-disposable-certification.js
```

The runner refuses to use `POS_TEST_BASE_URL` and refuses a remote `libsql:` Turso URL. It creates a temporary local SQLite database under the operating-system temp directory, initializes the native POS schema/seed data, provisions a temporary administrator credential, runs the static production contracts, and then runs the high-value Playwright certification suites against that isolated database.

The database is removed automatically after the run. To retain it for failure investigation only:

```bash
POS_KEEP_DISPOSABLE_CERTIFICATION=YES node scripts/run-pos-disposable-certification.js
```

Optional local-only overrides:

```bash
POS_DISPOSABLE_PORT=3001 \
POS_DISPOSABLE_TEST_PASSWORD='LocalCertificationOnly-2026!' \
POS_DISPOSABLE_TEST_PIN='246810' \
node scripts/run-pos-disposable-certification.js
```

## Safety rules

This workflow must remain fail-closed:

- never point it at production or a shared database
- never set `POS_TEST_BASE_URL`
- never use a remote `libsql:` database
- never silently install dependencies or browser binaries
- never treat a retained throwaway database as production evidence
- never promote a release solely because disposable certification passed; release-adjacent backup rehearsal, read-only hosted checks, and manual acceptance still apply

## Why this exists

Several important certification suites intentionally create sales, returns, receiving events, rentals, repair/accounting evidence, lifecycle locks, and idempotency receipts. Running those tests directly against operational data would be unsafe. The disposable runner gives those tests a realistic native POS server and database while keeping production records outside the blast radius.

## Evidence

For each run, retain the exact Git SHA and terminal result. A passing disposable run demonstrates that the candidate can boot and execute its mutation-heavy integrity tests in isolation. It does not prove the production host, proxy, backup, or employee acceptance environment is healthy; those are separate release gates.
