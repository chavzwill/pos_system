# Rental maintenance planning

Open **Maintenance planning** from Rentals or **Maintenance board** from a fleet asset. The board combines explicit service plans and existing actual maintenance records for each physical asset. Four lanes show due work, future plans, work in progress and completed/cancelled history. Counts cover the branch and search filter; status filters select the cards. Load more retrieves subsequent pages. History currently uses stable source order, not most-recent completion order.

## Operational rules

- Schedule a named asset with a service description, due date, priority and reason. Scheduling leaves availability unchanged. Dates use the Jamaica calendar; actual work timestamps use UTC. This release does not infer recurring or meter-based service.
- Start the original plan to create one canonical maintenance episode and take the asset out of rental service. Active rentals, open work and terminal asset states block starting.
- Complete the original episode with safety/work notes and only the **additional** maintenance cost in JMD. Positive additions require an invoice/service reference. Existing cost and references are preserved. Other open work keeps the asset in maintenance. Sold/retired/disposed assets cannot be reactivated by completion.
- Cancel only an unstarted plan. The cancellation reason is retained in the immutable audit event; the card displays the original planning reason.

Plans, goods receipts, supplier invoices, posted payables and actual maintenance are distinct records. Board operations do not receive stock, post a payable, create a journal or mark a supplier paid. Finance reviews maintenance cost overlap through the existing asset cost-evidence workflow so consumable issues are not counted twice.

## Authority and recovery

Writes require staff rental management authority (`rentals_manage_items`, through the existing `rentals_manage` alias). Rental/reporting staff may read. Current asset branch authority is checked before writes and operation replays, including after transfers. API keys are rejected. Branch/security administrators retain existing cross-branch authority.

The account-backed `rental-maintenance` draft is separate from purchasing/Finance drafts. Recovery must finish before actions are enabled. A submission is checkpointed before POST. Unknown outcomes freeze the exact body and operation key; retry confirms that operation rather than creating another one. A known source conflict allows refreshing the original source before a new submission. Navigation is blocked during posting. Discarding an uncertain task removes its recovery key and requires checking the original record first.

## API and verification

Base: `/api/inventory-traceability/rental-economics/maintenance-board`.
GET supports branch, asset, search, status and bounded keyset pages (default 40, maximum 100). The asset selector is capped at 1,000 scoped assets. Writes use `/plans`, `/plans/:id/start`, `/plans/:id/cancel`, `/maintenance/:id/complete`, with a stable `Idempotency-Key`. Plan actions check the expected version; completion checks integer cents against the original source snapshot. Audit events and successful operation records reject update/delete.

The older fleet completion endpoint shares the atomic completion controls. Legacy direct creation rejects terminal assets, duplicate open episodes and invalid/future actual times. A historical closed record does not alter present availability.

Local checks include runtime branch/permission, rental/lifecycle, stale source, concurrent start/completion, replay, actual draft protection, recovery failures and responsive layouts. The isolated connected certificate exercises purchasing, receiving, consumable issues, invoice/AP settlement, maintenance planning and Finance overlap review; no production data is used. Independent review remains pending because the review attempt was unavailable due to a usage limit. This change has no deployment.

## Verification record (2026-10-26)

- 87 relevant Node runtime tests passed after rebasing onto master `7563411`.
- 12 standalone maintenance UI tests and 2 actual shell mounting/scroll tests passed. Desktop, tablet and phone screenshots were inspected. Shell-mounted completion dialogs stay fixed in the viewport while the board scrolls.
- The broader 131-case browser regression run passed 129 initially. One existing fleet fixture released an unstarted mocked request; an explicit request-start wait fixed it, and its targeted rerun passed. A separate fleet recovery scenario exceeded 30 seconds under the parallel load; its unchanged targeted rerun passed in 3.6 seconds. These are targeted rechecks, not a clean single-run 131/131 claim.
- `npm run vercel-build`, responsive layout contracts and `git diff --check` passed. The isolated connected certificate passed on the updated base; its sanitized record is `docs/evidence/rental-maintenance-connected-2026-10-26.json`.
- Independent review remains pending. No preview or production deployment was created.
