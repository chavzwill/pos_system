# Total Tools frontend replacement audit — 2026-10-17

Status: replacement frontend implemented in draft PR #104; final visual alignment and exact-head release certification are in progress. No deployment has been performed.

## Source of truth and served entry points

Repository baseline: `51b3b0b1d26fd174e18acbe1070682a0403be672` on `master`.

- `server.js:127` serves `public/app-shell.html` at `/`.
- `server.js:128` serves the enhanced legacy index at `/legacy`.
- `server.js:126` extracts the legacy App script from the 1.1 MB index into `/legacy-pos-app.js`.
- `server.js:271` sends other frontend paths to the fast shell, except legacy-prefixed paths.
- `vercel.json` rewrites requests to the server and disables automatic Git deployment.
- Production metadata confirms the Total Tools page and brand green theme color. Captured assets and seven screenshots are retained in the baseline Actions artifact; authenticated module coverage is not inferred from the public page.

## Confirmed presentation ownership conflicts

1. `public/app-shell.html` loads app-shell, identity, multiple Guide Me styles, component styles and the final unified stylesheet.
2. `app-shell.js:99` inserts workspace CSS before `#tt-authoritative-ui`.
3. `workspace-loader-hardening.js` instead appends workspace CSS to the end of the head. The capture-phase handler in that file owns ordinary shell workspace buttons, so this ordering difference affects the normal opening path.
4. `unified-ui-system.css` is approximately 54 KB of broad normalization, sector-root lists and important overrides over independently styled workspaces.
5. `meeting-demo-shell.js` injects another search control and registers another command-K listener, in addition to app-shell's command palette.
6. `total-tools-identity.js` injects navigation Guide Me and topbar Guide controls, changes brand text, and refreshes metrics independently from app-shell.
7. `workspace-quality-pass.js` adds dialog roles and Escape behavior dynamically, on top of module-specific behavior.

Presence in the repository does not establish that a retired CSS file is actively served. The server already strips several historical theme links from its enhanced legacy output.

## Product findings

The observed Sales landing page is a task directory followed by empty "Needs attention" and "Today at a glance" panels. It gives several Guide Me entry points and emphasizes generic dashboard scaffolding over the active operation.

Most primary workspaces mount independent body-level overlays with their own panel/header/table/form styles. Replacement must cover those actual workspace roots, nested composer states and Guide Me, not just the shell behind them.

## Replacement brief

- Keep established green `#0B7A3E` and yellow `#F2D11F`; use them deliberately against restrained neutral surfaces.
- One neutral navigation shell, one task search/command owner, one Guide Me access pattern, one documented token set.
- Replace shared shell geometry and presentation; retire obsolete theme/demo layers from active loaders.
- Consolidate module presentation around deliberate primitives for headers, tables, filters, forms, status labels, cards and dialogs. Preserve business APIs, permission filtering, totals, tender handling, inventory authority and concurrency safeguards.
- Avoid empty summary scaffolding and implementation terminology in operational flows.
- Use consistent vector iconography, visible high-contrast focus, labelled controls, keyboard containment/return for modal interactions, reduced motion and accessible mobile navigation.
- Verify 375, 390, 430, 768, 1024, 1280 and 1440 pixels with actual populated module states, nested dialogs and Guide Me.

## Baseline evidence

[Frontend Redesign Evidence run 39038888351](https://github.com/chavzwill/pos_system/actions/runs/39038888351):
- production screenshots and loaded-asset manifests captured at all seven widths;
- existing shell and major-workspace tests: **14 passed**;
- design CLI installation succeeded; visual generation did **not** occur because hosted 12ui authentication was required.

[Runtime Certification run 39039518403](https://github.com/chavzwill/pos_system/actions/runs/39039518403): passed on the initial tooling-only PR head `b8c4d2092b98c009b4d1087f5af8f40aece010cb`. This is baseline evidence, not certification of a redesigned frontend.

The existing layout suite primarily establishes document overflow, dialog focus and successful module opening. It does not establish visual quality, inner-panel overflow, meaningful data hierarchy or complete operator journeys. Keep its checks and add focused coverage for the replacement.

No backend or business logic changes. No Vercel build, preview or production deployment requested or performed.
