# Native POS Production Cutover Runbook

This runbook defines the final go/no-go sequence for the native Total Tools POS. It is intentionally verification-first: none of the commands below deploy code, install packages, or create financial transactions.

## Release identity

Record before cutover:

- repository: `chavzwill/pos_system`
- release branch/tag
- exact Git commit SHA
- operator
- change window start/end
- rollback owner
- last known-good release SHA
- backup archive path and checksum

The release candidate used for certification must be the same SHA promoted to production.

## 1. Quiesce and back up

Stop employee writes before taking the release-adjacent backup. The backup process must include both `data/` and `uploads/` so database state and uploaded operational evidence stay aligned.

```bash
bash scripts/production-backup.sh
```

Record the produced archive, checksum, manifest, and code SHA.

## 2. Rehearse recovery away from production

Never use the destructive production restore command merely to prove a backup is valid. Use the isolated rehearsal:

```bash
bash scripts/production-recovery-rehearsal.sh /absolute/path/to/pos-state-....tar.gz
```

The rehearsal must pass checksum validation, SQLite `quick_check`, full `integrity_check`, critical-table verification, and read-only database opening.

## 3. Verify exact release candidate

Set the expected SHA and run the non-deploying technical cutover gate:

```bash
export CUTOVER_CONFIRM=VERIFY_ONLY
export POS_EXPECTED_RELEASE_SHA=<exact-release-sha>
export POS_CUTOVER_BACKUP_ARCHIVE=/absolute/path/to/pos-state-....tar.gz
bash scripts/production-cutover-gate.sh
```

The gate runs production preflight, native runtime ownership checks, recovery contract checks, startup/health checks, host verification, read-only smoke tests, and the isolated backup rehearsal.

## 4. Container and proxy readiness

The app container is healthy only after a protected native POS API request reaches the database initialization boundary and returns an expected `200`, `401`, or `403`. The reverse proxy waits for `service_healthy` before depending on the app.

Host verification must prove:

- app container is running and healthy
- Caddy is running
- POS port `3001` is not host-published
- ports `80` and `443` are exposed only by Caddy
- public shell is reachable
- protected API reaches native POS + database and is stopped by authentication
- HTTPS responds
- persisted SQLite database exists
- uploads path is writable by the application identity

## 5. Read-only employee smoke

Provide a designated smoke employee where possible:

```bash
export POS_SMOKE_USERNAME=<smoke-user>
export POS_SMOKE_PASSWORD=<smoke-password>
bash scripts/production-smoke.sh
```

The smoke test performs reads only. It verifies authentication and representative Inventory, Branches, Workspace, Operations, Purchasing, Rentals, Repairs, Dispatch, and Accounting endpoints according to the employee's permissions.

## 6. Final GO conditions

Production promotion is **GO** only when all of these are true:

- exact release SHA is pinned
- production certification is green on that SHA
- release-adjacent backup exists and checksum passes
- isolated restore rehearsal passed
- last known-good release SHA is recorded
- data rollback implications are documented for schema-changing releases
- rollback owner is present
- smoke employee is available
- no unresolved severity-1 or severity-2 blocker remains
- application health is green behind the production proxy

Any failed item is **NO-GO**.

## 7. Rollback trigger

Rollback immediately if production shows any of the following after promotion:

- database initialization or integrity failure
- repeated container health failure
- branch authorization bypass
- duplicate financial/inventory lifecycle mutation
- unbalanced accounting evidence
- checkout, rentals, repairs, purchasing, or Dispatch unavailable for normal authorized staff
- widespread 5xx responses
- uploaded evidence inaccessible or unwritable

Code rollback alone is insufficient if a release introduced incompatible data changes. Use the release-specific data recovery plan and retain the restore safety copy until employee acceptance is complete.

## 8. Evidence retention

Retain with the release record:

- exact SHA
- certification output
- backup manifest/checksum
- recovery rehearsal output
- host verification output
- production smoke output
- cutover timestamp
- rollback decision if one occurred

Do not delete the pre-restore safety copy or release-adjacent backup until the release has passed the agreed observation window.
