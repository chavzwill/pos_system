# Purchasing work recovery

The app shell saves unfinished PO/PR composers, Fast Receive entries, and supplier
invoice/matching entries in the existing database. Reopen the same task after a
refresh, browser restart or later sign-in to resume saved entries.

## Ownership and lifetime

Drafts are private to the signed-in employee and their assigned default branch.
Every draft request carries the employee/branch expected by the screen; the
server rejects a stale tab when the shared login cookie or branch assignment has
changed. Staff sessions and current task permissions are required; API keys
cannot access staff drafts. Signing out forgets local memory while preserving
private account drafts for later sign-in. No browser storage is used.

One composer draft is retained per PO/PR type, and receiving/invoice drafts are
keyed by PO. Each employee/branch can hold 20 live drafts, up to 256 KiB each.
Snapshots expire seven days after the latest save. Expired payloads are hidden
and removed when that account next loads drafts; small revision tombstones remain
to prevent stale tabs resurrecting discarded drafts.

Ordinary edits save after a 1.5-second pause. Identical snapshots are skipped;
writes for a draft are serialized. Saving, saved and failure messages distinguish
confirmed recovery from unsaved edits. Wait for **Draft saved** before closing the
app. Refreshing during autosave or a network outage can lose the final unsaved
edits. Native unload warnings are best-effort, especially on mobile browsers.

Two tabs cannot silently overwrite each other: a revision conflict blocks the
stale tab's submission and asks the user to reopen the app with current state.

## Submission safeguards

Before sending a supported creation, receipt or invoice action, the app saves a
pending snapshot and awaits confirmation. If recovery cannot be saved, that
business request is not sent. Loading drafts must succeed before these tasks
open, so an existing pending operation cannot be hidden by a storage outage.

- An uncertain PO/PR composer submission is locked against resubmission. Check
  the document list before discarding its draft and starting again. Local
  validation failures do not become uncertain submissions.
- Fast Receive retries preserve the original key and payload, including receipt
  cost changes, retail proposals, quantities and tracking details. The PO detail
  Receive action opens this same screen instead of using a second posting path.
- Invoice capture preserves its frozen body and key. Allocation preserves the
  complete original endpoint, kind, serialized body and key, even if refreshed
  receipt quantities have been fully consumed. Another invoice action cannot
  clear that unresolved operation.
- Confirmed results and subsequent evidence-refresh failures remain distinct.
  Discard/clear controls remove drafts only, never posted business records.

Server transaction validation, permissions and idempotency remain authoritative.
Drafts are never automatically submitted, stock is never received by draft saves,
and invoice capture still creates neither stock nor Accounts Payable.

This scope does not add offline transactions, attachment uploads, arbitrary
programmatic navigation guards, PR conversion drafts, or recovery for legacy
screens outside the app shell. Explicit PR conversion retains its existing
server workflow. Seven-day expiry is not indefinite transaction archival.

## Verification

Run `npm run vercel-build`, Node tests `tests/purchasing-drafts.test.cjs` and
`tests/invoice-capture-runtime.test.cjs`, and Playwright specs
`durable-work-protection`, `work-protection`, `purchasing-order-editor` and
`receiving-match-ui`.

Tests use isolated local databases and mocked browser API responses. They cover
account and branch isolation, stale sessions, permissions, size/count limits,
expiry, revision races, reload recovery, checkpoint outages, frozen original
requests, known rejections, and layouts at 390/768/1440 pixels. They do not certify
production database latency or native mobile browser termination behavior.
