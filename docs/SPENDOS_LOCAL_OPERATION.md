# Local POS → SpendOS operation

This integration branch combines the current POS modernization line with the certified SpendOS connector and local-operation tooling. It was built in a separate worktree so the active POS checkout and its uncommitted work were not switched or reset.

Docker is not required for local POS-to-SpendOS operation. There are two supported local paths:
- for an isolated disposable validation database, use the SpendOS repository's `npm run start:linked-pos -- --pos-dir "C:\path\to\pos_system"` launcher;
- for supervised local operation against explicitly selected existing POS and SpendOS SQLite databases, use the runner below after taking its backup.

This is local operation, not a production deployment.

## Configuration and startup

Copy `local-spendos.config.example.json` to `local-spendos.config.json` and set
absolute paths to the existing POS database, existing SpendOS database and SpendOS
source checkout. The local configuration contains no credentials and is ignored by Git.
The SpendOS checkout must include GET `/v1/savings/leakage/cases?tenantId=...`.

Run `node scripts/prepare-spendos-local.js` to take a consistent SQLite backup,
then `node scripts/run-spendos-local.js`. Stop the foreground supervisor with Ctrl+C.
The supervisor owns POS, SpendOS, and a serial five-second delivery worker.
POS completes schema initialization before the worker starts.

- POS: http://127.0.0.1:4191
- SpendOS: http://127.0.0.1:4192
- Status: `node scripts/check-spendos-local-status.js`
- Worker heartbeat: `local-spendos-runtime/worker-status.json`
- Backup and process inventory: `local-spendos-runtime/`

Both HTTP listeners bind only to loopback. This development-only launcher explicitly
uses no SpendOS bearer or management secret; the POS retains normal session/RBAC
checks. It is unsuitable for LAN or production exposure. It does not load remote
Turso credentials. Unrelated POS background jobs are disabled in this embedded mode.
It does not register a Windows startup service; restart it after reboot.

`POS_SKIP_DEMO_SEED=1` prevents demo branches, suppliers, products, customers,
employees, sales, commissions and CRM records from being inserted at initialization.
It does not delete existing records or provision employee credentials. Normal schema
migrations and permission-group setup still run. Existing operators log in normally.

## Evidence and read behavior

No backfill is applied automatically. Only actual future POS purchasing, receipts,
consumption and commitment workflows enqueue operational evidence. A zero-event
SpendOS database remains in `waiting_for_evidence`; an idle healthy worker does not
mean purchasing evidence has been received.

Opening the savings view reads opportunities and leakage cases without running the
savings engine or refreshing cases. Finance-authorized staff can explicitly run a
scan; the POS rejects the scan when there are no SpendOS events. Refresh is read-only.
SpendOS remains advisory and cannot directly change POS inventory or finances.

## Certification

Run the seven gates in `SPENDOS_POS_INTEGRATION_GUIDE.md`, plus:

```powershell
node --test tests/spendos-management-read.test.js tests/spendos-no-demo-seed.test.js
$env:SPENDOS_SOURCE_DIR = 'C:\path\to\spend-os'
node scripts/check-spendos-local-interoperability.js
node scripts/check-spendos-local-status.js
```

The interoperability suite uses unique temporary databases and a real SpendOS
HTTP receiver. It checks rollback, committed events, claim leases, replay, receipt
and consumption projections, backoff, dead-letter exclusion, finance-only requeue,
and no-write management reads. Its employee context is test-only middleware; it
does not claim to verify an operator's real login. The local status check confirms
the actual POS rejects unauthenticated management requests.

Production TLS, production credentials, a durable host scheduler, authenticated
operator acceptance, and genuine business-event acceptance remain separate gates.
No synthetic certification records may be submitted to the operational databases.
