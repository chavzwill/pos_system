# Receiving price adjustments

Goal: Enter actual delivery unit cost and proposed retail price during Fast Receive.

Use the current receiving transaction. Keep ordered PO costs immutable; actual delivery cost flows into receipt lines, cost layers, catalog cost and receipt accounting. Cost overrides require inventory-edit permission and a reason. Retail changes create receipt-linked proposals in the existing separate-approver process and remain pending until approved. Invoice capture and AP posting remain separate.

- [x] Add failing runtime/browser tests for actual receipt valuation, unchanged PO/AP, retail approval linkage, replay, stale price/pending review rollback, permissions and mobile controls.
- [x] Implement shared pricing validation and immutable receipt cost audit. Save pricing evidence and retail proposals in the same receipt transaction.
- [x] Extend Fast Receive with cost/retail controls per received line and a clear reason. Show actual receipt costs in receiving review.
- [x] Run focused regressions, full syntax/contracts, and inspect desktop/mobile results. Save the tested change to the approved GitHub branch without deploying.

Validation: eight isolated invoice-capture runtime tests passed, all thirteen receiving/invoice/price browser and API regressions passed, full `npm run check:syntax` passed, and pricing controls were visually inspected at desktop and phone widths (1280/390/320px). Automatic Vercel deployments remain disabled.
