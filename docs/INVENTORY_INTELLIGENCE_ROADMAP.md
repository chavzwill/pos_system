# Total Tools Inventory Intelligence Roadmap

## Purpose

Inventory Intelligence is a first-class capability of the Total Tools Retail + Repair Operations OS. It must go beyond showing stock on hand. The system should continuously explain what inventory exists, where it is, why it is there, what is moving, what is not moving, what is at risk, what should be replenished, transferred, discounted, returned, reserved, substituted, or investigated, and what financial and operational impact those decisions have.

Inventory intelligence must remain deterministic and auditable. Recommendations may assist staff, but controlled inventory actions must still pass through the normal transfer, purchasing, repair, adjustment, approval, and audit workflows.

## Core inventory truth

The intelligence layer depends on a trustworthy inventory model containing, where applicable:

- SKU / product / variant identity
- barcode and alternate identifiers
- brand, category and supplier
- branch and physical location/bin
- on-hand quantity
- available quantity
- reserved quantity
- committed quantity
- in-transfer quantity
- on-purchase-order quantity
- backordered quantity
- damaged/quarantine quantity
- repair-reserved quantity
- rental-reserved quantity
- reorder point / safety stock
- lead time
- unit cost, landed cost and valuation method
- selling price and margin
- last purchase, sale, transfer, count and adjustment timestamps
- source transaction for every movement

The system must clearly distinguish physical stock from available-to-promise stock.

## Inventory health intelligence

Provide continuously calculated inventory health signals including:

- stockout risk
- low-stock risk
- overstock
- dead stock
- slow-moving stock
- fast-moving stock
- excess branch stock
- branch imbalance
- negative stock anomalies
- stale inventory
- unusual adjustment frequency
- shrinkage indicators
- high-value inventory exposure
- stock accuracy confidence
- items with repeated count variance
- items with demand but no replenishment path
- inventory stranded against discontinued or obsolete products

Every flag should explain the evidence used to generate it.

## Demand intelligence

Demand should be evaluated using verified activity such as:

- historical sales
- repair parts consumption
- rental maintenance consumption
- quotations where appropriate
- approved customer orders
- seasonality
- branch-specific demand
- recurring commercial/account-customer demand
- promotions and known events where explicitly configured
- current repair backlog
- open reservations

The system should distinguish observed demand from forecast demand.

## Replenishment intelligence

Recommend replenishment using:

- current available stock
- safety stock
- demand velocity
- lead time
- supplier reliability
- open purchase orders
- incoming transfers
- branch demand
- repair demand
- minimum order quantities
- case-pack constraints
- purchase cost
- carrying cost
- service-level target

Recommendations should provide suggested quantities, rationale, confidence/evidence, and the controlled action that can be taken: create purchase request, review PO, transfer stock, or take no action.

## Smart branch rebalancing

Expand the existing smart transfer recommendations into a complete branch-balancing capability:

- identify surplus and shortage pairs
- respect source-branch reserve requirements
- consider demand velocity at both branches
- account for open transfers
- account for repair reservations
- avoid draining a source branch to solve a destination shortage
- rank recommendations by urgency and financial/operational impact
- estimate days of cover before and after transfer
- surface transport/transfer cost where available
- allow staff to open the normal controlled transfer workflow from a recommendation

No recommendation should directly mutate inventory.

## Repair-parts intelligence

Inventory Intelligence must be tightly integrated with the repair operating system:

- show parts availability during diagnosis/estimate creation
- reserve approved repair parts
- show substitutes and compatible alternatives where explicitly defined
- identify another branch with required stock
- recommend transfer versus purchase based on urgency and availability
- surface supplier lead time
- flag repair jobs blocked by parts
- estimate parts-ready dates
- track parts issued, consumed, returned, damaged, or unused
- detect inventory leakage between reserved, issued and consumed quantities
- prioritize critical parts for promised repair dates

## Purchasing intelligence

Purchasing decisions should include:

- purchase-price variance
- landed-cost trend
- supplier lead-time performance
- fill rate
- partial-delivery frequency
- cancellation rate
- quality/return issues where tracked
- minimum order constraints
- supplier concentration risk
- alternative suppliers
- stockout cost versus carrying cost
- demand coverage created by the proposed order
- duplicate/open-PO detection

The intelligence layer should help buyers understand not only what to order, but why, when, from whom, and at what risk.

## Inventory profitability intelligence

Connect inventory activity to Accounting Intelligence:

- gross margin by SKU/category/brand/branch
- inventory turns
- days inventory outstanding
- carrying cost
- aging inventory value
- dead-stock value
- markdown exposure
- write-off impact
- shrinkage impact
- purchase-price variance
- landed-cost variance
- margin erosion from discounts
- margin recovered through rebalancing
- working capital tied up in inventory
- stockout-driven lost-sales indicators where evidence exists

All financial values must trace back to verified inventory and accounting records.

## Inventory integrity and anomaly detection

Detect and surface conditions requiring investigation:

- negative inventory
- sale/consumption without sufficient source stock
- duplicate SKUs or duplicated product records
- repeated manual adjustments
- unusual write-offs
- unexpected stock movements
- transfer dispatch/receipt mismatches
- purchase receiving mismatches
- repair parts issued but never consumed/returned
- large count variances
- valuation inconsistencies
- stale reservations
- orphaned stock records
- branch/location mismatches
- products with impossible availability states

Anomalies should create reviewable exceptions rather than silently changing data.

## Inventory cleanup and master-data intelligence

Support the inventory cleanup requirement with tools for:

- duplicate product detection
- probable duplicate SKU detection
- obsolete/discontinued item identification
- stale catalog records
- inconsistent naming
- missing barcodes/SKUs/categories/brands
- unit-of-measure inconsistencies
- missing supplier relationships
- products with stock but no valid selling record
- products with transactions but broken master data
- merge/relink workflows with audit history

The system should propose cleanup actions but require controlled confirmation for destructive merges or archival actions.

## Cycle counts and stock accuracy intelligence

Improve physical inventory control with:

- risk-based cycle-count recommendations
- ABC / value / velocity count policies
- count scheduling by branch/location
- blind counts where appropriate
- recount thresholds
- variance reason capture
- approval thresholds for large variances
- recurring-variance detection
- stock-accuracy score by branch/category/location
- root-cause views linking variance to transfers, receiving, repairs, sales or adjustments

## Reservation intelligence

Provide one coherent reservation model across:

- customer orders
- quotations where reservation is explicitly allowed
- repairs
- rentals
- transfers
- purchasing commitments

Expose reservation age, source, priority, expiration and conflicts. Prevent double allocation of the same available stock.

## Availability and fulfillment intelligence

For each item, staff should be able to answer immediately:

- Do we have it?
- Where is it?
- Is it actually available or already committed?
- Which branch can fulfill it fastest?
- Is a transfer already coming?
- Is a PO already coming?
- When is it expected?
- Is there a substitute?
- What is the safest fulfillment option for the customer or repair?

## Inventory command center

Build an Inventory Intelligence workspace within the native Inventory domain, not as a detached "upgrade" page. It should surface:

- inventory health summary
- stockout risks
- overstock/dead stock
- branch imbalance
- blocked repairs due to parts
- replenishment recommendations
- transfer recommendations
- purchasing exceptions
- receiving exceptions
- cycle-count priorities
- integrity anomalies
- inventory value and working-capital exposure
- quick drill-down to the exact SKU, branch, movement, repair, PO, transfer or audit event

Role-aware views should tailor the same intelligence for inventory staff, buyers, branch managers, service managers and executives.

## Explainability and traceability

Every recommendation or warning should expose its source evidence such as:

- stock quantities
- reservations
- sales/usage history
- repair demand
- lead time
- open purchase orders
- transfer state
- supplier performance
- costs
- configured thresholds

Users must be able to drill from an intelligence card to the underlying source records.

## Permissions

Granular permissions should cover at least:

- view inventory intelligence
- view cost/margin intelligence
- create replenishment action
- create/approve transfer
- create/approve purchase request
- adjust stock
- write off stock
- merge/archive products
- override reservations
- approve large count variances
- view inventory valuation

Permissions must be enforced server-side as well as in the interface.

## Auditability

Important inventory actions and intelligence-driven decisions must record:

- actor
- branch
- timestamp
- entity/SKU
- previous state
- new state
- reason
- source recommendation where applicable
- linked transaction/repair/PO/transfer/count
- device/session where available

## Multi-branch requirements

Inventory Intelligence must be branch-aware by default and support:

- branch-specific demand
- branch-specific reorder rules
- branch capacity
- branch reservations
- inter-branch transfers
- branch stock accuracy
- branch inventory valuation
- branch profitability impact
- network-wide stock optimization

## Testing requirements

Add dedicated tests for:

- available-to-promise calculations
- reservation conflicts
- repair-parts reservation and release
- transfer recommendation safety
- replenishment recommendation calculations
- open-PO/incoming-stock handling
- duplicate-product detection
- cycle-count variance workflows
- negative-stock prevention
- receiving integrity
- transfer dispatch/receipt integrity
- inventory valuation source trace
- multi-branch stock correctness
- permissions
- anomaly generation without silent mutation

## AI-assisted inventory intelligence

After deterministic inventory workflows are reliable, AI may assist with:

- explaining stock anomalies in plain language
- summarizing why an item is overstocked or at risk of stockout
- identifying likely duplicate catalog items
- suggesting likely substitutes from verified compatibility data
- summarizing supplier/inventory trends
- forecasting demand with explicit confidence and assumptions
- answering natural-language inventory questions using verified system data

AI must never invent stock, cost, demand, compatibility or supplier facts, and must never silently create stock movements, purchase orders, transfers, write-offs or adjustments.

## Definition of complete

Inventory Intelligence is complete only when the system can reliably answer what inventory exists, where it is, what is actually available, what is committed, what is moving, what is at risk, what action is recommended, why that action is recommended, what financial impact it has, and exactly which source records support the conclusion.