# Native POS Manual Acceptance Checklist

Use this checklist on the exact release-candidate SHA after automated production certification passes. This is a manual acceptance gate; it does not replace runtime tests.

## Test devices / viewports

Verify at minimum:

- desktop 1440x900 or larger
- compact desktop 1024x768
- tablet portrait around 768x1024
- phone around 390x844

No workspace may require horizontal page scrolling for its primary task flow.

## Native shell

- Total Tools POS branding is visible and correct.
- Login, logout, refresh, navigation and command palette work.
- Guided Mode opens from the native shell.
- Role-specific navigation does not expose unauthorized destinations.
- Browser back/forward navigation does not leave the shell in an unusable state.
- No persistent loading overlay, detached popover or floating control obscures workspaces.

## Sales / checkout

- Search by product name, SKU and barcode.
- Add, change quantity and remove cart lines.
- Select customer and verify customer context.
- Validate stock visibility for the signed-in branch.
- Hold and recall a sale.
- Complete each authorized tender type.
- Verify split tender where enabled.
- Open transaction history and receipt evidence.
- Exercise return/refund flow with an authorized test transaction.
- Keyboard shortcuts do not conflict with browser/input behavior.

## Repairs

- Search and open a work order.
- Verify intake, diagnosis, technician, parts, QC and customer-facing evidence.
- Confirm prohibited status transitions remain unavailable.
- Confirm QC/signoff state is obvious.
- Verify repair pickup/delivery handoff into Dispatch where applicable.

## Rentals

- Search and open a rental agreement.
- Verify serialized asset assignment and status.
- Confirm issue/active/return lifecycle controls are understandable.
- Confirm overdue and missing/lost asset states are visually distinct.
- Verify deposit/balance evidence and rental Dispatch handoffs.

## Dispatch & logistics

Verify filters and records for:

- sales delivery
- supplier pickup
- rental delivery
- rental return pickup
- repair pickup
- repair return
- branch transfer

Confirm assignment, scheduling, route state, in-transit state and completion evidence remain usable on desktop and mobile.

## Inventory & warehouse

- Search item and view branch stock.
- Open movement / traceability evidence.
- Verify low-stock presentation.
- Verify authorized stock adjustment and warehouse controls.
- Confirm another branch cannot be selected by a branch-scoped employee unless explicitly authorized.

## Purchasing

- Create/open purchase request.
- Approve according to role authority.
- Convert/create purchase order.
- Verify supplier identity, address and lines.
- Receive eligible quantities.
- Verify supplier pickup can be handed to Dispatch.
- Confirm duplicate receiving controls are understandable after refresh/retry conflicts.

## Finance & accounting

- Open Accounting Intelligence.
- Open Ledger / Trial Balance.
- Verify posted and draft states are visually distinguishable.
- Verify supplier payables and settlement reconciliation workspaces load.
- Confirm ordinary reporting users cannot perform posting/reversal actions without permission.

## CRM / customers

- Search and open customer.
- Verify balances, limits, transaction history and CRM activity.
- Verify pipeline/opportunity views where authorized.
- Confirm blocked-account state is visible before transactional action.

## Administration

- Employees workspace loads for authorized administrator.
- Branches workspace loads and preserves branch identity.
- Security groups display permissions and members correctly.
- Non-admin test user cannot reach restricted administration actions by navigation or direct URL.

## Accessibility / interaction quality

- Visible keyboard focus is present on interactive controls.
- Tab order follows the visible task order.
- Buttons and form controls remain comfortably tappable on phone/tablet.
- Important state is not represented by color alone.
- Text remains legible at browser zoom 125% and 150% on desktop.
- Dialogs can be dismissed without a mouse when appropriate.

## Failure-state acceptance

Manually observe at least one controlled failure for each class:

- unauthorized action -> clear 403/permission message
- branch mismatch -> clear denial, no leaked record
- duplicate/idempotent retry -> no duplicate business event
- lifecycle concurrency conflict -> clear refresh/retry instruction
- unavailable external notification/integration -> core POS remains usable
- temporary network interruption -> no unexplained duplicate transaction

## Final acceptance record

Record:

- exact commit SHA
- tester name
- date/time
- device/browser
- branch/role tested
- failed checklist items
- screenshots or issue references for failures
- final result: PASS / NO-GO

Any severity-1 or severity-2 defect in checkout, branch isolation, permissions, inventory, rentals, repairs, purchasing, Dispatch, accounting or recovery is a production NO-GO.
