# POS Local Certification

This guide defines the no-spend path for proving the native Total Tools POS locally or against a hosted candidate without accidentally mutating production data.

## 1. Static certification only

This performs repository checks and does not start Playwright, install packages, deploy anything, or touch business data.

```bash
npm run check:production-certification
```

It verifies native POS ownership, recovery controls, startup/readiness expectations, cutover requirements, accounting evidence requirements, idempotency, lifecycle serialization, and multi-branch safeguards.

## 2. Full local/disposable certification

Use this only against the local POS database or a disposable staging database where test mutations are permitted.

```bash
npm run test:production-certification
```

The runner starts the native POS server through Playwright when needed and executes the production certification suites. Some suites create test records, receive/return test resources, exercise financial posting, or otherwise mutate the disposable test database.

When `POS_TEST_BASE_URL` points away from localhost, the runner fails closed unless the operator explicitly sets:

```bash
POS_TEST_ALLOW_MUTATIONS=YES
```

Never set that flag against real production data.

## 3. Read-only hosted candidate certification

For a deployed/staged candidate where business data must not be changed:

```bash
POS_TEST_BASE_URL=https://your-pos-host.example \
  npm run test:production-readonly
```

This runs only browser/runtime observations and does not execute the business mutation suites.

Authenticated read-only API smoke remains available separately through `scripts/production-smoke.sh` using a designated smoke employee.

## 4. No automatic spend

The certification commands intentionally do not:

- run `npm install`
- download browsers automatically
- invoke `npx` for missing packages
- trigger GitHub Actions
- deploy to a hosting platform
- provision infrastructure
- call paid AI or external testing services

If a required local dependency is missing, certification stops and reports the prerequisite.

## 5. Evidence to retain

For each release candidate record:

- exact Git SHA
- static certification output
- runtime certification output
- responsive/browser output
- manual acceptance result
- release-adjacent backup checksum
- recovery rehearsal result
- final cutover verification result

A release is not production-certified merely because these scripts exist. The relevant checks must actually pass on the exact candidate SHA.
