# Purchasing acceptance and exceptions queue

Extend the existing isolated lifecycle certificate to persist pending receipt,
invoice capture and allocation identities through the actual staff draft API.
Discard their first business response locally, reload the saved operation, retry
it, and verify unchanged stock and AP totals. Retain a machine-readable evidence
report. Use no production transactions or inherited integration credentials.

Add a read-only, employee/branch-scoped queue in the existing purchasing visual
system. Four filters count affected orders: overdue deliveries (outstanding
quantities less recorded closed shortages, using latest supplier ETA), receipts
not fully linked to invoices, invoices not fully matched to receipts, and invoice
price/amount differences still requiring review. Captured invoices reserve receipt
quantities; posting must not count those reservations twice. Exclude void invoices
and draft/cancelled orders from overdue work. Historical accepted cost adjustments
are evidence, not automatically unresolved exceptions.

Use existing receiving and invoice-review screens for action. No posting,
payments, pricing decisions, stock adjustments or automatic resolution from the
queue. Enforce staff permissions and assigned branch server-side; no API-key
access. Return bounded keyset pages and whole-filter counts, with explicit source
coverage and errors. Add no dependencies, periodic polling or paid services.

Implementation:
1. Extend and run the isolated certificate, recording final stock/AP/journals and
   draft replay evidence.
2. Implement GET /api/purchasing-exceptions with source-based aggregation and
   tests for overlaps, captured/posted/void states, ETA/closed shortages,
   permission boundaries, paging, search and no business writes.
3. Extend the existing receiving-review surface with an accessible queue launcher,
   responsive filters and rows, loading/error/empty states, source deep links and
   phone/desktop visual checks. Keep existing app styling and controls.
4. Run syntax/build, backend and browser checks, review the final diff, then publish
   a draft PR. No release deployment in this stage.

## Completed verification and review

- Connected certificate passed against a fresh isolated Express/libSQL database,
  including all six recovered operations and a cleared final queue.
- 22 Node tests passed (queue, saved drafts and invoice-capture runtime).
- 43 browser tests passed (queue plus existing purchasing recovery/editor/matching).
- npm run vercel-build and git diff --check passed.
- Rendered and inspected phone, tablet and desktop; both row actions remain in
  the initial 390px viewport for the tested record.
- Independent review found a stale source-action continuation could close a
  reopened queue. The origin-root guard fixes completion and error handling;
  the failing close-race test now passes. Keyboard focus stays in the opened
  source dialog. No production financial records were modified.
- Ruling: posted void invoice reservation behavior follows the existing immutable
  allocation authority. This queue documents that source limitation rather than
  independently releasing receiving capacity.
