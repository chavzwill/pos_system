# Total Tools AI POS integration

The standalone TT AI platform now lives in the private `chavzwill/total-tools-ai` repository.

This POS repository owns only the authoritative employee/branch/RBAC integration boundary.

## Current route

`/api/tt-ai` is a read-only employee-session gateway.

It:
- rejects machine API-key identity;
- requires an authenticated POS staff session;
- derives employee permissions from the POS;
- defaults reads to the employee's branch;
- requires `multi_branch_access` for another branch;
- hides product cost unless Purchasing or Financial Reporting authority exists;
- exposes no TT AI write action.

## Current read families

- `GET /api/tt-ai/context`
- `GET /api/tt-ai/products/search?q=...`
- `GET /api/tt-ai/rental-machines/search?q=...`
- `GET /api/tt-ai/rental-assets/search?q=...` — exact physical fleet assets with POS asset number and inventory serial
- `GET /api/tt-ai/rental-assets/:identifier` — exact asset identity plus allocation and maintenance history

Rental asset cost/acquisition evidence is returned only when the employee has Purchasing or Financial Reporting authority.

## Standalone service connection

Do not forward the POS session cookie to TT AI and do not use a generic POS API key as employee identity.

The next integration step is a short-lived, audience-bound server assertion created by the POS backend after staff authentication. The standalone TT AI service validates the assertion and applies its own read-tool policy.

## Authority

The POS remains authoritative for:
- staff identity and RBAC;
- branch access;
- products/SKUs and live stock;
- purchasing;
- rentals and repairs;
- operational approvals.

TT AI remains an intelligence/retrieval layer and must not write directly to POS tables.
