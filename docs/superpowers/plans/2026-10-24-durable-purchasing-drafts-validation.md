# Durable purchasing draft implementation record

Base: master 90331a95fd4b5c7ac30105409c2c16533e50f46d.

Task 1: server route and isolated database tests implemented. First missing-route
run failed; subsequent CRUD/CAS tests exposed an INSERT SELECT condition that
prevented updates. Corrected with atomic existence/revision/count checks.

Task 2: persistence queue and submission integrations implemented. Browser tests
first failed because the durable helper API was absent. Reload, checkpoints,
conflicts, save failures and existing purchasing fixtures now run together.

Ruling: PR-to-PO conversion is outside composer-draft scope; it retains its
existing explicit server transaction workflow. Documented to avoid promising
unimplemented conversion recovery. Draft TTL is seven days and ordinary edits
are debounced by 1.5 seconds; unsaved final edits remain vulnerable to closure.

A fresh reviewer inspected the whole branch and reproduced allocation replay and
false-pending PO bugs. Review fixes have focused tests:

- Bind each request to the expected employee/default branch. A stale-cookie
  request reproduced a 200 where 409 was required; backend scope tests now reject it.
- Freeze invoice allocation endpoint/body/kind/key. Fully consumed lines originally
  removed the replay control; replay now remains available with the complete body.
- Route order-detail receiving through Fast Receive, eliminating its parallel
  sessionStorage posting path.
- Checkpoint PO/PR only after local validation and restore non-pending state on
  known no-send outcomes; reload no longer locks an unsent invalid composer.
- Preserve editable receiving state after known server rejection, and retain
  price edits after quantity changes. Focused cases failed before corrections.

No production transactions are used for verification. Publish as a draft PR;
merge/deployment require the later release step.

Final validation: npm run vercel-build passed; 35 browser fixture tests passed;
15 Node database/runtime tests passed. Inspected the saved-state notice in the
390px PO editor. The UI contract now checks delegation to checkpointed Fast
Receive instead of the removed parallel receive dialog. No deployment created.
