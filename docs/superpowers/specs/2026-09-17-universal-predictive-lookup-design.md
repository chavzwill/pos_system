# Universal Predictive Lookup Design

## Purpose

Make every meaningful search and lookup field across the Total Tools POS predictive, fast, context-aware, permission-aware, and consistent. This is primarily a distributed field capability, not one giant global search bar. An optional global command search may consume the same engine later.

## Product principles

- Staff type where they already work; useful suggestions appear without opening another workspace.
- A field declares what it is looking for: product, supplier, customer, PO, invoice, serial, repair, rental, location, employee, or another governed entity.
- Exact canonical identifiers win. Ranking then considers prefix, alias, strong token/name matches, and typo-tolerant matches.
- Scanner input uses the same identity engine and resolves an unambiguous exact barcode/SKU/serial immediately.
- Suggestions show enough context to distinguish records without exposing unauthorized data.
- Selecting a suggestion returns a canonical entity identity; it never turns arbitrary display text into transactional truth.
- Search never mutates stock, prices, customers, suppliers, purchasing, accounting, or other authoritative records.
- Existing owning workflows remain responsible for actions such as Add to Sale, Add to PO, Transfer, Open Repair, or Open Rental.

## Scope

First-class lookup domains are products/variations, suppliers, customers, purchase orders, sales invoices/transactions, serial/lot identities, repairs/service records, rentals/assets, branches/locations, and authorized employees. Existing contextual searches are migrated incrementally onto the shared engine rather than rewritten all at once.
## Architecture

Introduce a shared server-side Predictive Lookup Engine with domain adapters. The engine accepts `domain`, `query`, optional `branch_id`, `limit`, and contextual filters; resolves the authenticated employee and permissions server-side; invokes only allowed adapters; normalizes candidates into one result contract; ranks deterministically; and returns safe human-readable metadata.

A shared browser controller progressively enhances existing inputs. Fields opt in with declarative lookup metadata rather than each screen implementing fetch, debounce, keyboard navigation, ranking, empty states, and error handling independently. Existing workflows may keep their layout and selection callbacks while replacing their search mechanics.

The normalized result contract contains canonical `entity_type`, `entity_id`, `primary_label`, `secondary_label`, `match_kind`, `matched_value`, optional `availability`, and an allowlisted `context` object. Raw database rows, internal notes, margins, credentials, and unauthorized identifiers are never returned merely because they match text.

## Ranking and identity

Within a domain, ranking order is: exact canonical identifier; exact barcode/part/serial/PO/reference identifier; canonical identifier prefix; reviewed alias; exact normalized name/model; token-prefix/name match; typo-tolerant match. Ties use deterministic domain-specific signals, never opaque AI scoring.

Aliases are evidence, not authority. Search may consume reviewed aliases and may record anonymized/attributable lookup-selection evidence for later Inventory Cleanup review, but repeated searches never silently rename, merge, or rewrite catalog identities.

## Product lookup

Product suggestions may match SKU, part number, barcode, variation identifier, product name, brand, model, description tokens, supplier part number, and reviewed aliases. Results should show staff-friendly identity plus branch stock/availability where the caller has inventory visibility. Purchasing contexts may additionally show governed supplier purchasing context already available to that employee.

## Supplier and customer lookup

Supplier lookup supports canonical supplier ID, name, permitted contact identifiers, and reviewed aliases. Customer lookup supports customer/account identifiers, name, and permitted contact identifiers. Sensitive commercial/account fields remain governed by existing permissions; lookup is not a permission bypass.
## Transaction and operational lookup

PO, invoice/transaction, repair, rental, asset, serial/lot, branch, and employee adapters search only identifiers and metadata appropriate to the caller and current workflow. List-page search and entry-field prediction use the same adapters but different presentation modes: a list search filters/navigates records, while an entry field selects a canonical record into the current transaction.

## Browser interaction

Predictive fields support debounce, request cancellation, keyboard arrows, Enter selection, Escape dismissal, pointer/touch selection, loading state, no-results state, safe failure state, and accessible combobox/listbox semantics. The UI must work in light/dark themes and remain usable on counter desktops, tablets, and narrow screens.

Exact scanner-style identifiers bypass fuzzy ranking when one authorized canonical result exists. Ambiguous exact values display choices instead of guessing.

## Permissions and tenant/branch safety

Every adapter derives authorization from the authenticated server-side identity. Client-supplied domain or branch values can narrow authorized scope but cannot widen it. Branch-scoped stock, customer/commercial data, employee data, supplier commercial data, and operational records follow their existing authority models.

API keys and non-interactive callers receive only explicitly supported lookup access; privileged staff search cannot be obtained by presenting an arbitrary domain. Cross-tenant, cross-business, and unauthorized branch leakage fail closed.

## Failure behavior and performance

Search failures return stable safe codes/messages; raw SQL, provider, stack, and internal exception text never reaches staff. One domain failing does not corrupt another domain. Stale responses are ignored client-side.

The engine enforces minimum useful query lengths by domain, strict result limits, bounded fuzzy candidate sets, indexed exact/prefix paths, and cancellation/debounce. Exact SKU/barcode/serial paths must remain fast enough for scanner/counter use without requiring fuzzy scans over entire tables.

## Actions

Results may advertise contextual actions only when the owning module already exposes an authorized workflow. Search itself performs no destructive or financial action. Examples include Open Product, Add to Sale, Check Stock, Add to Purchase Request, Open PO, Open Repair, and Open Rental.
## Migration strategy

Phase 1 establishes the engine, product/supplier/customer adapters, shared browser controller, contracts, and the highest-frequency purchasing/catalog fields. Phase 2 migrates Sales, Inventory, Customers, Repairs, Rentals, Dispatch, and operational list searches. Phase 3 adds remaining governed domains and the optional global command search as another client of the engine.

Migration is compatibility-first: existing endpoints/workflows remain until their consumers are proven migrated. No mass replacement is allowed without contract coverage for the affected workflow.

## Observability

Record domain, latency, result count, match kind, selected/not-selected outcome, and safe correlation identifiers. Do not log raw sensitive query values when they may contain customer contact data or protected operational information. Metrics should identify slow domains, zero-result searches, and alias/cleanup opportunities without creating a shadow customer-data store.

## Testing invariants

Permanent contracts must prove deterministic ranking, exact-ID priority, typo tolerance boundaries, permission/branch isolation, safe errors, bounded results, scanner exact resolution, ambiguous exact handling, canonical selection identity, no mutation from search, stale-response suppression, keyboard/accessibility behavior, and compatibility of migrated workflows.

Adversarial tests must cover malformed domains, SQL/wildcard-like input, very long input, duplicate aliases, duplicate barcodes/identifiers, inactive records, stale client requests, cross-branch access attempts, unauthorized entity domains, and concurrency while records change.

## Definition of done

Every migrated search surface predicts useful authorized results as staff type; exact identifiers are fastest and highest priority; ambiguous identities are never guessed; selection returns canonical identity; field and list search share one engine; errors are safe; permissions remain authoritative; no search path mutates business state; scanner input works through the same identity rules; and permanent regression contracts are in the full release wall.

The first production slice is not complete until exact feature-head CI and exact post-merge integration Runtime Certification both pass.