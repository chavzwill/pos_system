# TT AI — current POS read gateway integration

This limited port is based on the existing **draft** PR #97 but is rebased onto the current POS `master` history as a separate and conflict-free code slice. It deliberately does not merge the older PR's UI or unrelated shell changes.

## Employee-only read boundary

Routes mounted at `/api/tt-ai` after POS session, API key and same-origin middleware:
- `GET /context` — readiness, staff branch and capabilities
- `GET /products/search?q=...` — branch stock and staff-permitted price/cost
- `GET /rental-machines/search?q=...` — permissioned rental product read
- `GET /rental-assets/search?q=...` — physical assets when backed by actual tracking tables
- `GET /rental-assets/:identifier` — exact asset / serial and permitted maintenance history
- `POST /query` — signed, bounded server-to-server evidence request; no browser access to the Ed25519 assertion

Employees and branch authority are always derived from POS. API key identity is rejected; other-branch access requires existing `multi_branch_access`. Cost/maintenance financial fields require Purchasing or Financial Reporting access. No operational writes are exposed by this gateway.

## Configuration

POS backend:
- `TT_AI_SERVICE_URL` for an authorized TT AI endpoint. The TT AI service normally listens on local loopback; use an approved secure private transport for cross-host access.
- `TT_AI_SIGNING_PRIVATE_KEY` (Ed25519 PEM, server only; never commit).

TT AI standalone backend:
- `TT_AI_SIGNING_PUBLIC_KEY` matching the POS private key.
- `TT_AI_KNOWLEDGE_DB` and `TT_AI_RETAIL_PURCHASING_DB` pointing at **approved, populated** runtime databases.

No deployment, key configuration, or runtime database mutation was carried out by this repository patch.

## Qualification / outstanding steps

Run from a current POS checkout:
```bash
node --check routes/tt-ai-read.js
node --check lib/tt-ai-read-tools.js
node --check lib/tt-ai-assertion.js
node --check lib/tt-ai-client.js
node scripts/check-tt-ai-read-contract.js
node scripts/check-tt-ai-assertion-contract.js
```

Readiness and end-to-end live-stock tests still require a real session, authorized POS data, a running TT AI service and the signing key pair. The prior Ask TT AI interface and Knowledge Review workspace remain on draft PR #97 and must be adapted to the current shell separately; **this patch is a backend gateway, not a finished employee UI**.

## Branch-data correctness hardening

- Staff without a default branch cannot select an arbitrary branch just because the request named one. Only existing `multi_branch_access` permits selecting another branch.
- Product read results include **only the requested, permissioned branch's stock**. They never expose `products.stock_qty` company-wide totals.
- If a product has no row in `branch_inventory`, `stock_qty` remains `null` (unknown), not a fabricated zero.
- Run `node scripts/check-tt-ai-read-runtime.js` for mocked runtime permission, stock and cost assertions, in addition to the source contract and signature checks. These do not substitute for a real POS database integration test.
