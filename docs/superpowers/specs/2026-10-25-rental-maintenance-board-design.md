# Rental maintenance planning board

Continue the approved next step: a maintenance board for exact fleet assets, due
and overdue planned service, work in progress, downtime and actual cost history,
with easy scheduling/start/completion controls. Build on the existing fleet and
maintenance records without dependencies, paid services or automatic deployment.

Planned service is a separate document. Scheduling and cancelling a plan do not
change asset availability. Starting service creates one canonical maintenance row
and changes the exact asset from active to maintenance, only when there is no open
rental allocation, branch transfer or maintenance episode. Completion updates that
same row atomically and adds the explicitly entered additional cost once. Only a
maintenance asset with no other open work returns to active; terminal lifecycle
states must never be resurrected. Return-inspection and older unplanned maintenance
remain visible and can be completed through the same controlled path.

Use immutable event and operation evidence, source/branch/permission checks before
actor-bound operation replay, and optimistic source/version snapshots. Legacy
completion must use the same atomic completion function so it cannot double-add
cost after board completion. Harden legacy starts against duplicate open work and
terminal status revival. Preserve original source costs and Finance review behavior.

Use Jamaica calendar dates for due/overdue and server UTC instants for elapsed
work. Due dates are entered explicitly; no guessed machine-hour or recurring
service intervals. Four lanes: due/overdue, planned, in service, recent history.
Named asset selection, search/filter, full-filter counts and bounded keyset pages.
Current asset branch owns access across transfers; staff reads, rental management
writes, API keys denied. Closed history and costs show original source evidence.

Use the existing shell/workspace loader and design language. Account-backed private
maintenance draft recovery must finish before actions are enabled; checkpoint the
pending exact body/key before posting, lock unknown outcomes, block navigation
while posting and preserve existing work before opening another job. Source reads
or errors never pretend an unavailable queue is clear.

Whole-unit stock, AP, journals, supplier invoices and payment posting are outside
this workflow. Actual direct maintenance costs are evidence for existing asset
contribution and may require the existing Finance overlap review. Publish a verified
draft PR; release remains a subsequent user-authorized step.
