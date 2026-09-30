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
- `GET /api/tt-ai/rental-assets/search?q=...`
- `GET /api/tt-ai/rental-assets/:identifier`

The physical-asset reads use the existing POS `rental_assets` registry and `inventory_serials`. If the registry is not initialized, TT AI reports tracking unavailable instead of fabricating asset identities.

Asset detail may include existing allocation and maintenance history when those tables exist. Financial cost fields remain hidden unless the employee already has Purchasing or Financial Reporting authority.
- `GET /api/tt-ai/rental-assets/search?q=...` — exact physical fleet assets with POS asset number and inventory serial
- `GET /api/tt-ai/rental-assets/:identifier` — exact asset identity plus allocation and maintenance history

Rental asset cost/acquisition evidence is returned only when the employee has Purchasing or Financial Reporting authority.

## Standalone service connection

Do not forward the POS session cookie to TT AI and do not use a generic POS API key as employee identity.

The POS includes `lib/tt-ai-assertion.js`, which creates a short-lived, audience-bound Ed25519 v2 staff assertion after POS authentication. The matching TT AI verifier is implemented in the standalone repository.

The POS holds `TT_AI_SIGNING_PRIVATE_KEY`; the standalone TT AI service receives only `TT_AI_SIGNING_PUBLIC_KEY`. This prevents TT AI from minting arbitrary employee assertions. No signing key is committed to either repository.

The POS -> TT AI server proxy is now implemented through `POST /api/tt-ai/query`. The browser sends only the question to the POS. POS signs the authenticated employee context, TT AI returns a bounded evidence plan, POS executes only allowlisted read tools, and TT AI synthesizes the evidence-only response. The signed assertion is never exposed to browser JavaScript. Legacy v1 HMAC assertions are not part of the production contract.

## Authority

The POS remains authoritative for:
- staff identity and RBAC;
- branch access;
- products/SKUs and live stock;
- purchasing;
- rentals and repairs;
- operational approvals.

TT AI remains an intelligence/retrieval layer and must not write directly to POS tables.

## Qualification

Run:

```bash
node scripts/check-tt-ai-read-contract.js
node --check routes/tt-ai-read.js
node --check server.js
```

The contract check fails if TT AI gains mutation routes, stops rejecting machine-key identity, loses branch scoping, exposes unrestricted costs, or loses exact serial/asset lookup.


## Environment

POS server:
- `TT_AI_SERVICE_URL` — standalone TT AI server URL.
- `TT_AI_SIGNING_PRIVATE_KEY` — Ed25519 private key used only to sign short-lived staff assertions.

Standalone TT AI server:
- `TT_AI_SIGNING_PUBLIC_KEY` — matching Ed25519 public key used only to verify assertions.

No model-provider credential is required for the current evidence-only query service.
