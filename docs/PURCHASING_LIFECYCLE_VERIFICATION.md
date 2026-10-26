# Purchasing lifecycle verification — 24 October 2026

Target: production source at `336a42ceaf3cf3b04bc1c51465eba3a8055f8c73`.
The verification adds tests and a runner, and fixes a journal-number collision
found during the payment reconciliation step.

## Defect found and fixed

Automatic journal numbers truncated the source type to eight characters.
`supplier_invoice` and `supplier_payment` both became `SUPPLIER`, so invoice 1
and payment 1 competed for `AUTO-SUPPLIER-1`. The payment reduced the supplier
balance, but accounting sync could not create its general-ledger journal.

New automatic journal numbers retain the full source type. Existing journals
are still looked up by source type and source ID first, verified and reused;
their numbers are preserved. The connected regression failed on the missing
payment journal before this fix. It verifies the separate invoice/payment
journals and repeat-sync behavior after the fix. Deploying the fix does not
itself backfill journals: existing failed sources need the normal accounting
sync and reconciliation process after release. No production sync was run.

Run `npm run test:purchasing-lifecycle` to create a fresh temporary SQLite
database, bootstrap synthetic staff, start the actual Express app on a random
loopback port, and run the connected API journey. The runner passes an explicit
environment without inherited database or integration credentials. Server
background jobs are disabled. The database and server log remain in the printed
temporary evidence directory. Tests authenticate through normal staff sessions.
No production database or production financial records are used.

## Connected journey

| Check | Expected evidence |
| --- | --- |
| Approval boundary | Receiver cannot approve; draft PO cannot receive stock |
| Partial deliveries | Two receipts of 2 and 3 units complete a 5-unit PO |
| Receipt replay | Reusing each receipt operation returns the same receipt |
| Cost adjustment | Actual cost 12; original PO cost 10; retail remains 30 |
| Invoice separation | Two captures remain outside AP until Finance posts |
| Many-to-many matching | Each invoice covers portions of both deliveries |
| Posting authority | Receiver denied AP posting; Finance posts once |
| PO value variance | Higher cumulative invoice value requires a Finance reason |
| Stock reconciliation | Exactly 5 units after receipts, matching, AP and payment |
| Supplier balances | Two invoices total 60; payment reduces both balances to zero |
| Payment authority/replay | Receiver denied; retry returns the same payment |
| Receipt journals | Inventory debit 60; receiving clearing credit 60 |
| Invoice journals | Receiving clearing debit 60; AP credit 60 |
| Payment journal | AP debit 60; bank credit 60; net AP zero |
| Accounting sync replay | Two sync runs produce one journal per source; every tested journal balances |

## Additional checks executed

- Eight isolated invoice-capture runtime cases: capture/allocation/AP separation,
  validation, branch and role restrictions, over-allocation rejection, variance
  controls, posting rollback and concurrency, and changed supplier protection.
- Three existing API integration cases on a separate isolated full database:
  actual receipt costs plus independent retail approval; invoice allocation to
  two partial deliveries with replay/over-allocation checks; backorder follow-up
  plus denial of self-approval and approval by a second staff member.

## Limits

This verifies one connected API journey and focused adjacent cases against local
SQLite. It does not certify every tax, freight, foreign-currency, serial/lot,
inspection, consumables, cancellation, refund, branch combination or failure
interleaving. It does not simulate production Turso latency or transactions.
Browser navigation recovery, physical-device installation, scanners and receipt
printers remain separate checks. No new deployment is needed for these tests.

## Acceptance extension: durable recovery and exceptions queue

Reverified from master `fe0740e78bbbe952b1b09b7a06a7dc71d6311bf6` with the
acceptance/queue changes in this branch. The normal staff draft API now stores
six pending operations (two receipts, two captures and two allocations). The
certificate reloads each stored original key/body, replays its business request,
and verifies the same result without an extra stock receipt or payable.

The queue is queried through the actual Express app: both deliveries appear as
unbilled receipt evidence before matching, and the completed PO has no remaining
exceptions after matching/posting. Final evidence: stock 5, inventory value 60,
receiving clearing net 0, invoice AP credit 60, payment AP debit 60, net AP 0;
retail remains 30 while receipt unit cost is 12 and original PO unit cost is 10.
Every tested journal balances. All draft payloads are cleared after confirmation.

The runner writes `purchasing-acceptance.json` into its printed temporary evidence
directory. The retained result is
[evidence/purchasing-acceptance-2026-10-24.json](evidence/purchasing-acceptance-2026-10-24.json).
API replay is connected to an actual isolated database; browser recovery/failure
interleavings remain separately covered by browser fixtures. This does not
simulate a real production network failure or certify production Turso latency.
