# POS Native Architecture

## Ownership boundary

The POS is a standalone product in `chavzwill/pos_system`.

It owns both sides of its runtime:

- **Frontend:** POS-owned browser application served from `public/`.
- **Server:** POS-owned Express application bootstrapped by `server.js`.
- **API:** same-origin `/api/*` routes mounted by the POS server.
- **Database:** POS-owned data layer initialized by `database.js` and the POS route/lib modules.

The POS must be able to boot, authenticate staff, sell, rent, purchase, dispatch, repair, account, report, and administer the business without SmartCommerce or any other commerce product being present.

## Integration rule

SmartCommerce, SellSync, WooCommerce, CRM systems, marketplaces, and other products are integrations only. They may exchange authoritative business data through explicit connector contracts, but none of them may become the POS frontend host, server runtime, navigation shell, authentication authority, or required boot dependency.

A connector failure must degrade the connector, not the POS itself.

## Frontend runtime contract

`public/pos-runtime.json` declares the browser runtime identity. `public/pos-native-runtime.js` verifies that the page is running as the native POS and that its API remains same-origin at `/api`.

The main shell is `public/app-shell.html`. Modernization work belongs in this POS frontend and should progressively replace legacy UI without moving execution into SmartCommerce.

## Server runtime contract

`server.js` is the native POS application server. It is responsible for:

- serving the POS frontend;
- authentication and authorization;
- multi-branch enforcement;
- POS domain APIs;
- transaction and inventory integrity;
- rentals and fleet lifecycle;
- purchasing and suppliers;
- repairs and technician operations;
- dispatch/logistics;
- accounting and settlement;
- reporting and operational intelligence;
- explicit external connectors.

Business-critical writes must remain authoritative on this server or a future POS-owned service extracted from it.

## Modernization direction

Modernization should happen natively inside this repository in controlled stages:

1. Keep the existing POS server authoritative while stabilizing module boundaries.
2. Replace legacy browser surfaces with POS-owned modern workspaces.
3. Preserve server-side permissions, accounting, inventory, and audit invariants during UI replacement.
4. Move large server domains into POS-owned service modules when useful; do not move them into another product repository.
5. Keep all external commerce systems behind adapters/connectors.
6. Require native-runtime, syntax, workflow, security, and end-to-end release gates before promotion.

## Non-negotiable invariant

**POS availability and correctness must never depend on SmartCommerce being deployed, reachable, or checked out.**
