# Purchasing work recovery

The purchasing workspace can keep unfinished purchase orders, purchase requests,
receiving entries, and supplier invoice/matching entries while moving between
supported tasks in the same app tab.

## Draft lifetime

Drafts live only in JavaScript memory, scoped to the loaded employee and default
branch. They are not written to browser storage or the server. Refreshing or
closing the tab loses them. Signing out in this tab explicitly clears them.
Changing the loaded employee/branch clears old drafts. This does not broadcast
logout to other tabs.

There is one composer draft per PO/PR type, plus drafts keyed by PO for receiving
and invoice work. A maximum of 20 entries is kept; each snapshot expires after
30 minutes. Continuing to edit refreshes the snapshot lifetime. Opening another
copy does not overwrite an existing PO/PR draft without resuming it first.

Normal close, workspace navigation and relevant keyboard controls ask whether to
keep unfinished entries. An active submission blocks these controls until its
result arrives. Browser unload uses the native unsaved-work warning where
supported; it cannot preserve drafts across refresh or reliably warn on all mobile
browser exits. Programmatic module calls outside these controls are not a general
transaction guard.

## Submission behavior

- An uncertain PO/PR creation is locked against another submission. Users must
  review the document list before discarding that draft and starting again;
  these creation endpoints do not offer a reliable replay identity.
- Receiving retries reuse the original idempotency key and payload. Uncertain
  entries are frozen, including receipt cost adjustments, serials and quantities.
  The server remains responsible for permissions, validation and replay handling.
- Invoice capture and receipt allocation retain their original retry identities
  across reopening. Frozen capture payloads preserve disabled select values.
  Allocation replay is allowed even when refreshed remaining quantities have
  changed, so the server can recognize an already recorded operation.
- A confirmed mutation followed by a failed refresh is described as confirmed,
  rather than as a failed save. Users should inspect recorded evidence before
  starting another operation.
- Discard/clear controls remove only unsaved tab entries. They do not delete,
  reverse or void recorded business documents.

This adds no offline queue or automatic network retries. Receipt recording,
invoice capture, receipt allocation and Finance posting remain separate server
operations. Capturing an invoice still changes neither inventory nor Accounts
Payable. No server/schema changes or new dependencies are required.

## Verification

Run `npm run vercel-build` and the Playwright specs:

- `tests/work-protection.spec.js`
- `tests/purchasing-order-editor.spec.js`
- `tests/receiving-match-ui.spec.js`

These browser fixtures exercise draft scope/expiry, leave guards, pending-submit
protection, uncertain outcomes, identical retry bodies/keys, confirmed saves with
failed refreshes, history replay and PO layouts at 390, 768 and 1440 pixels. They
use mocked API responses, not production transactions, and do not certify native
mobile unload behavior or server inventory/accounting effects.
