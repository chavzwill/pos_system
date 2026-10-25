# Durable purchasing drafts

Extend purchasing recovery to survive refresh, tab closure and later sign-in.
Use the existing Express/libSQL stack and session authentication. The user chose
server-saved drafts over browser storage; browser storage is device-bound and
unsuitable for shared terminals. Retaining memory alone cannot meet recovery.

Drafts belong to an employee and their assigned branch, with existing task
permissions rechecked on every request. API keys cannot access staff drafts.
Snapshots contain editable entries and original retry identities, not posted
business documents. No stock/AP changes occur when drafts are saved or deleted.
Keep at most 20 live drafts per employee/branch, each at most 256 KiB, expiring
seven days after its latest save. The app states the expiry and save outcome.
No browser storage, offline transaction queue, new dependency or paid service.

Use optimistic revisions and deletion tombstones so an older tab cannot silently
overwrite or resurrect another tab's draft. Conflicts require reopening the app
with current server state. Debounce ordinary edits; serialize saves per key and
skip identical snapshots. Load drafts before opening each supported task.

Before sending PO/PR creation, receipt, capture, allocation, posting or voiding,
store the pending snapshot and original operation details and await server
confirmation. If checkpointing fails, do not send the business mutation.
Restored pending submissions follow existing uncertainty locks/replay rules.
An interrupted PO/PR is never automatically resubmitted. Receipt, capture and
allocation retries preserve their original idempotency key and payload.
Confirmed results clear the draft through the same revision-controlled queue.
Signing out forgets local memory; account drafts remain private for later sign-in.

Show saving/saved/unsaved/conflict state. A refresh before a debounced save may
lose the final edits; do not claim unsaved keystrokes are durable. Native unload
warnings remain best-effort. Existing server transaction validation remains the
authority; no client-side permission snapshot grants business access.

Verification covers ownership and permissions, size/count limits, expiry,
revision races and stale resurrection; reload recovery, save outages, pending
checkpoints and preservation of original retry identities. Existing purchasing
and responsive browser checks must continue to pass. Publish a draft PR before
release; no deployment is part of this implementation stage.
