# Total Tools POS — verified libSQL database export and recovery controls

**Implementation:** 2026-10-22; validation branch `hardening/verified-turso-backup-20261022`.

## Scope and non-negotiable limitations

The POS currently serves from Vercel and uses a remote libSQL/Turso database. This repository supports **manual, operator-authorized, read-only database exports** with a snapshot-consistent source transaction. The output is local SQLite with a SHA-256 manifest, per-table row counts, `integrity_check` and `foreign_key_check`.

**This is deliberately NOT called a complete production backup.** Uploaded product media, scanned customer IDs, signatures, purchasing attachments and other supporting files must be independently captured and verified for the same recovery period. Records may reference media outside the database (including provider-managed storage). This tool does not export, purge, mutate, or upload those objects.

**The script has not been run against the live Turso instance.** GitHub certification uses isolated synthetic local SQLite fixtures only. A green test is not evidence that production exports, full backup retention or disaster recovery are configured.

## Verified safety properties

- The source is accessed with a libSQL `transaction('read')`, so table metadata and rows are read from one consistent transaction; no source mutation is permitted.
- Rows are paginated; tables, records, non-generated fields, indexes, triggers, views, and AUTOINCREMENT sequence high-water marks are preserved. Unexpected or unsupported virtual tables fail closed rather than being skipped.
- The destination is a separate local 0600-permission temporary SQLite file. It is only published at the chosen output path after the transaction completes and integrity/FK/row counts pass.
- Export fails if output or manifest already exists. An interrupted export or invalid source cannot publish a successful backup; partial artifacts are cleaned up.
- A separate `--verify` operation recomputes the checksum and validates data integrity, foreign keys and table counts.
- Export fails on GitHub Actions, requires a remote `libsql://` URL and a token, and requires explicit operator acknowledgement of sensitive unencrypted data.
- Secrets, remote URLs, customer records, snapshots, and credentials must **never** be committed to the public repository or uploaded as CI artifacts.

## Prerequisites for an authorized operator only

1. Obtain explicit internal authorization and access to an isolated, encrypted, capacity-appropriate backup destination. Arrange offline/offsite protection and an independent media archive.
2. Use a controlled execution host, **not** GitHub Actions or a public shared runner; Node 22+ and the repository's locked dependencies must be available.
3. Securely provide `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` through environment configuration. The script does not echo them.
4. Set `POS_BACKUP_ACKNOWLEDGE=SENSITIVE_DATA` to confirm that the resulting SQLite file contains private operational data and **is not encrypted by this tool**.
5. Target a **new, nonexistent** `.db` filename in protected storage; never point it at `pos.db` or an active database.

## Export and verify — manual only

```bash
# No live credentials or customer data should appear in shell history or source control.
# Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN securely before running.
export POS_BACKUP_ACKNOWLEDGE=SENSITIVE_DATA
node scripts/pull-turso-snapshot.js /secure/backups/ttpos-2026-10-22.db

# This rechecks digest + actual SQLite integrity and foreign-key consistency.
node scripts/pull-turso-snapshot.js --verify /secure/backups/ttpos-2026-10-22.db
```

Expect the SQLite file and `ttpos-2026-10-22.db.manifest.json`. Store them **together**, encrypt both using the business's approved protection, and keep an offsite/off-provider protected copy. Do not assume Vercel's transient filesystem persists backup files.

The export will stop with an error rather than silently creating a partial recovery point on unsupported schema or integrity violations. Keep operational logs free from database URLs and tokens.

## Isolated restoration acceptance test

**Never restore over the live Turso database, and never use this export to silently change production.**

1. Copy the encrypted backup to a separate, access-controlled, non-production environment. Verify the SHA-256 manifest before using it.
2. Run `--verify` against the restored local SQLite file.
3. Inspect schema, row counts, critical invoices, outstanding POs, customer balances, stock levels and movement records. Reconcile against a known source-of-truth report.
4. Restore **media and attachments** to their planned recovery location; verify sample cross-links from DB records to the corresponding objects and permission-gated downloads.
5. Use isolated test accounts and a nonproduction app pointed to the restored SQLite clone. Prove sale/hold/receipt lookup, PO detail, partial receipt, rental, repair, finance and role boundaries with **read-only** checks. Perform any write-test only on a separately discarded clone.
6. Record operator, timestamp, source revision/commit, count and digest evidence, outcome, media archive identity and recovery timing. Only after acceptance should a separate production cutover decision be made.

**Required company decisions before industrial-grade recovery certification:** recovery-point objective (RPO), recovery-time objective (RTO), offsite storage/retention, encryption-key custody, upload/provider coverage, protected restore operator, scheduled export cadence, incident procedure. Do not advertise full DR readiness before an actual independently witnessed restore drill passes.

## Synthetic automation / CI

```bash
npm ci
node scripts/certify-libsql-snapshot.js
```

The certification builds a disposable local SQLite source, exports it, restores/validates it, checks indexes/views/triggers/BLOBs/sequence/foreign keys, and tests tampering, mid-export failure and overwrite refusal. It does **not** need customer credentials or cloud storage and does not run a live database export.

See also `docs/COMMERCIAL_GRADE_AUDIT_2026-10-22.md`, `docs/POS_RELEASE_GATE.md` and `docs/PRODUCTION_CUTOVER_RUNBOOK.md`. The Docker runbook is separate from this Vercel/Turso design.
