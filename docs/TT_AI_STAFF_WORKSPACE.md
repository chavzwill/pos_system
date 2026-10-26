# Ask TT AI — current POS shell port (stacked PR)

## Scope

This branch ports only the existing **read-only Ask TT AI employee workspace** from the older conflicted draft PR #97. It is based on the newer, security-hardened POS gateway draft PR #111 and changes the modern fast shell only by adding its isolated CSS and JS references.

This is **not** a new product redesign, live deployment, data import or production enablement. The existing POS shells, procurement workflow, navigation, action routing and stock authority remain intact.

## Employee experience

Once released, an authenticated employee will see an **Ask TT AI** launcher in the POS top bar. The panel supports:

- questions about products and live branch stock;
- reviewed machine, part/OEM number and compatibility evidence;
- rental fleet assets and serial numbers;
- authorized purchasing history where the backend returns evidence;
- explicit evidence source and Verified / Unknown response states.

The browser calls only `GET /api/tt-ai/context` and `POST /api/tt-ai/query`. It has no direct operational database access, no write button, and never stores or handles POS signing credentials.

### Fail-closed behavior

The composer is **disabled unless** the trusted staff context reports `capabilities.query === true`. A failed or unavailable context check displays **Service not connected**, not **Company data ready**. Reopening the panel discards prior user messages, avoiding accidental display of a different employee's previous answers after session changes.

Example question suggestions are illustrative; they are **not** stock claims or imported manufacturer fitment.

The layout retains the existing POS design and receives a minimal readability and mobile touch-target pass; no expensive hosted design generator or preview deployment was used. Visual sign-off and device matrix QA are outstanding.

## Verification

From a complete POS checkout:

```bash
node scripts/check-tt-ai-workspace-contract.js
node --test tests/tt-ai-workspace-ui.spec.js
node --test tests/tt-ai-query-bridge.spec.js
node scripts/check-tt-ai-read-contract.js
node scripts/check-tt-ai-read-runtime.js
node scripts/check-tt-ai-assertion-contract.js
```

After the POS gateway is merged and privately configured, verify real branch-scoped products, rental assets, offline service states, signed query correlation, keyboard navigation, screen reader announcements, small devices, and 200% text scaling with real staff roles before enabling it in production.

## Rollout

Do **not** merge this stacked workspace PR ahead of the gateway PR #111. Do not turn on a live TT AI server or incur hosting cost without approval. The standalone TT AI code at `chavzwill/total-tools-ai` already has corresponding signed query endpoints, but a populated company runtime and reviewed source records must be installed and tested before calling this operational.
