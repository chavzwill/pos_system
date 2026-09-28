# POS Portal Contracts & Department Approval Routing Design

## Scope

This design changes only `chavzwill/pos_system`. SmartCommerce remains untouched.
The POS remains authoritative for repair state, commercial-account status, credit terms, purchase-request approval, inventory, money, and internal employee decisions.
SmartCommerce may later consume the POS APIs defined here, but no SmartCommerce code is part of this program.

## Goals

1. Expose a stable POS-side customer repair contract so SmartCommerce can read customer-visible repair status/timeline and submit customer actions safely.
2. Allow commercial-account and credit applications to originate externally and enter a controlled POS review workflow.
3. Route internal requests to the relevant department's authorized managers without hardcoding a single manager.
4. Reuse one approval envelope and audit model while preserving each module's existing business authority.
5. Surface pending approvals in manager dashboards, My Day, and the existing Approvals employee tool using plain language.

## Non-goals

- Do not implement or modify SmartCommerce.
- Do not let external callers approve internal business decisions.
- Do not replace Purchasing, Accounts, Repair, Inventory, Dispatch, or existing financial/security authority with a generic workflow engine.
- Do not infer department managers from job titles or free-text names.
- Do not weaken independent-approval rules already required for high-risk finance/security actions.
## Core architecture

### 1. Shared approval envelope

Create a durable `approval_requests` record for coordination and a separate append-only `approval_events` history.
Each approval request records: request type, source system, external request id where applicable, owning module, owning record id, department, branch, requester identity, customer/organization/member identity where applicable, requested action, status, priority, assigned approval role, submitted/decided timestamps, and version.

The shared layer coordinates who must review and what is waiting. It does not perform the final business mutation itself.
Owning modules expose authoritative decision handlers. The approval layer calls or records the result of those handlers inside one transaction boundary where feasible.

Default status lifecycle:
`draft -> submitted -> in_review -> approved | rejected | changes_requested | cancelled`.
Only submitted/in_review requests appear in manager approval queues.

### 2. Department and manager authority

Introduce normalized POS departments and employee-department membership rather than relying on free-text request departments.
A department may have multiple authorized managers. Any one active authorized manager may normally decide a request for that department.
Manager authority requires both department-manager membership and the workflow-specific POS permission.
This prevents a department label alone from granting authority.

High-risk workflows may declare an additional independent approval policy. Existing financial/security segregation rules always override the ordinary one-manager rule.
## Repair portal contract

The existing `customer-repair-portal` route remains the customer-facing boundary.
POS work orders remain the only repair record authority.
Customer-visible timeline events and repair communications are the source of truth for what SmartCommerce may display.

POS portal APIs must support:
- read current customer-visible repair summary/status;
- read customer-visible timeline and communications;
- submit idempotent estimate approval/rejection using `external_action_id`;
- submit idempotent customer messages;
- return stable external-facing status labels and `updated_at`/version evidence.

Internal notes, technician-only diagnostics, internal costs, security data, and non-customer-visible events must never leak through portal endpoints.
External callers may express customer intent only; they cannot set internal repair status directly.

## Commercial-account and credit application contract

Create a durable `commercial_account_applications` aggregate with immutable external request identity and append-only application events.
Portal-originated applications use `source_system='smartcommerce'` and require a unique `external_request_id` for replay safety.

An application captures organization/customer identity, applicant/member identity, requested credit limit, requested terms, company/contact evidence, supporting notes/doc references, application status, and timestamps.
The POS assigns submitted applications to the Accounts/Finance department approval queue.

The FC/authorized Accounts manager may approve, reject, request more information, or approve with modified limit/terms.
Approval is the only path that may enable commercial credit or change `customers.credit_enabled`, `credit_limit`, and `credit_terms_days` from this workflow.
Decision evidence records requested versus approved terms and the authenticated employee who decided.
## Purchase-request departmental routing

Existing purchase requests remain authoritative purchasing records.
Their free-text `department` value is migrated toward a normalized department reference while preserving legacy display compatibility.
Submitting a purchase request creates or refreshes one linked approval envelope for the same PR and routes it to Purchasing Managers/authorized approvers for the relevant department policy.

The current generic `PATCH /purchase-requests/:id/status` path must be hardened so approval identity comes from the authenticated employee, not client-supplied `approved_by`.
Only authorized managers with purchasing approval authority may approve/reject submitted requests.
Conversion to a purchase order remains blocked until the authoritative PR state is approved.

The shared Approvals UI opens the exact purchase request; it must not become an alternate PO-creation path.

## Manager dashboard behavior

Managers receive a `My Department Approvals` queue filtered by their active manager memberships, branch authority, and workflow permission.
Each row shows plain-language request type, requester, department, branch, age, value/terms where relevant, priority, and next action.

Any one authorized manager may normally claim/decide a request. Decisions are optimistic/concurrency guarded so two managers cannot both win the same pending decision.
Managers may leave review notes or request more information without losing the audit trail.

My Day and the existing Approvals employee tool consume the shared envelope rather than re-querying each business table independently once a workflow is migrated.
## Security and external API boundaries

Portal endpoints remain API-key scoped and must fail closed outside explicitly mapped portal capabilities.
External request IDs are immutable and unique per source system/request type.
Replay of the same external request returns the existing POS result rather than duplicating records.

Portal clients may read only customer-owned/customer-visible records.
Internal employee approval endpoints require authenticated employee sessions, department-manager membership, branch authority, and workflow-specific permission.
No API key may call internal manager decision routes.

All decision writes use compare-and-swap style status/version predicates or equivalent transactional guards.
Approval events are append-only and preserve before/after status, actor, reason/comment, and authoritative result linkage.

## Human language

Customer-visible statuses must be stable and understandable, for example `Waiting for approval`, `In repair`, `Ready for pickup`, and `More information needed`.
Manager-facing states use `Waiting for Purchasing Manager`, `Waiting for Finance Review`, `Changes requested`, `Approved`, or `Rejected` rather than generic workflow jargon.
Technical source-system or database labels remain internal.

## Failure handling

If the owning module mutation fails, the approval envelope must not claim success.
If approval evidence commits but downstream projection fails, the request becomes reconciliation-required/fail-visible and is not silently retried as a new decision.
External duplicate submissions are idempotent; conflicting payload reuse of the same external request id fails closed.
## Testing and certification

Permanent contracts and runtime tests must cover:
- department-manager authorization and branch isolation;
- any-one-authorized-manager decision semantics;
- duplicate/concurrent decision races;
- external request replay and conflicting replay rejection;
- portal privacy/customer ownership;
- approval identity derived from authenticated employee;
- authoritative module mutation and envelope status staying atomic/truthful;
- commercial credit terms changing only after approved decision;
- purchase requests remaining unconvertible before approval;
- repair portal exposing only customer-visible events;
- existing Gate 0, Gate 1 money/inventory, supplier integrity, and privileged-security suites remaining green.

Every implementation slice follows TDD, exact-head Runtime Certification, expected-head protected merge, and post-merge certification.

## Delivery slices

1. **Approval-routing foundation:** departments, employee manager memberships, approval envelope/events, manager queue API, concurrency/idempotency guards, and dashboard/employee-assist integration.
2. **Commercial account & credit:** portal application intake/read APIs, Accounts/FC review UI, authoritative customer credit activation/term update, and external status contract.
3. **Purchasing manager routing:** migrate submitted purchase requests to shared envelopes, harden approval identity/authority, and preserve PO conversion rules.
4. **Repair portal synchronization hardening:** stabilize customer-facing repair summary/timeline/status contract, external versioning, privacy tests, and portal-action replay guarantees.

Each slice must be independently useful and releasable. No slice depends on SmartCommerce code changes.

## Success criteria

A customer-originated request can enter the POS once, reach the correct authorized managers, receive an attributable decision, and expose a truthful status back through the POS portal contract without duplicate records or authority bypass.
A department manager can find and act on requests from their dashboard without hunting through unrelated modules.
The POS remains the sole authority for internal status, credit, purchasing, repair, money, and inventory mutations.
